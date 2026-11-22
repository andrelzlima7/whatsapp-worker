import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { test, type TestContext } from 'node:test'
import { promisify } from 'node:util'
import { DisconnectReason } from '@whiskeysockets/baileys'
import { buildApp } from '../src/app.js'
import { BaileysAdapter } from '../src/baileys.js'
import { Connection, type WhatsAppAdapter, type WhatsAppSocket } from '../src/connection.js'
import { Dispatch, FileExecutionStore, type ExecutionStore } from '../src/dispatch.js'

const headers = { authorization: 'Bearer test-token' }
const deadline = Date.parse('2026-11-25T23:00:00Z')
const body = {
  executionId: randomUUID(), groupId: '123@g.us', text: '  Aviso.  ', sendBefore: '2026-11-25T23:00:00Z',
}

function fake() {
  let emit: Parameters<WhatsAppAdapter['connect']>[0]
  const calls: string[][] = []
  let clears = 0
  const socket: WhatsAppSocket = {
    groups: async () => [{ id: body.groupId, name: 'Avisos' }],
    permission: async () => 'allowed',
    async send(group, text) {
      calls.push([group, text])
      return 'message-1'
    },
    close() {},
  }
  const adapter: WhatsAppAdapter = {
    async connect(notify) { emit = notify; return socket },
    async clearSession() { clears++ },
    async flush() {},
  }
  return { adapter, calls, socket, clears: () => clears, emit: (event: Parameters<typeof emit>[0]) => emit(event) }
}

async function directory(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'scheduler-executions-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function setup(t: TestContext, store: ExecutionStore) {
  const wa = fake()
  const connection = new Connection(wa.adapter)
  await connection.start()
  wa.emit({ type: 'open' })
  let now = deadline - 100
  const app = buildApp('test-token', connection, new Dispatch(store, connection, () => now))
  t.after(() => app.close())
  t.after(() => connection.close())
  return {
    ...wa, app, time: (value: number) => { now = value },
    send: (payload = body) => app.inject({ method: 'POST', url: '/messages', headers, payload }),
  }
}

test('autenticação, QR inicial, reconexão progressiva, novo pareamento e bloqueio', async t => {
  const wa = fake()
  const retries: { callback: () => void; delay: number }[] = []
  const connection = new Connection(wa.adapter, undefined, (callback, delay) => {
    retries.push({ callback, delay })
    return () => {}
  })
  const app = buildApp('test-token', connection, new Dispatch(
    new FileExecutionStore(await directory(t)), connection, () => deadline - 1,
  ))
  t.after(() => app.close())
  t.after(() => connection.close())
  const get = (url: string) => app.inject({ url, headers })
  const pair = () => app.inject({ method: 'POST', url: '/connection/pairing', headers })
  assert.equal((await app.inject('/health')).statusCode, 401)
  assert.equal((await get('/health')).headers['cache-control'], 'no-store')
  await connection.start()
  assert.equal((await pair()).json().code, 'PAIRING_NOT_ALLOWED')
  wa.emit({ type: 'qr', value: 'qr-de-teste' })
  assert.match((await get('/connection/qr')).json().qrImage, /^data:image\/png;base64,/)
  wa.emit({ type: 'open' })
  const first = (await get('/connection')).json().connectionId
  assert.match(first, /^[a-f0-9-]{36}$/)
  assert.equal((await get('/connection')).json().connectionId, first)
  assert.equal((await get('/connection/qr')).json().code, 'QR_UNAVAILABLE')
  wa.emit({ type: 'disconnected' })
  assert.equal((await get('/groups')).json().code, 'NOT_CONNECTED')
  assert.equal(retries[0].delay, 1000)
  retries[0].callback()
  await setImmediate()
  wa.emit({ type: 'disconnected' })
  assert.equal(retries[1].delay, 2000)
  retries[1].callback()
  await setImmediate()
  wa.emit({ type: 'open' })
  assert.notEqual((await get('/connection')).json().connectionId, first)
  wa.emit({ type: 'loggedOut' })
  assert.equal((await get('/connection')).json().status, 'LOGGED_OUT')
  assert.equal(retries.length, 2)
  assert.equal((await pair()).statusCode, 202)
  assert.equal((await pair()).statusCode, 202)
  assert.equal(wa.clears(), 1)
  wa.emit({ type: 'blocked' })
  assert.deepEqual((await get('/connection')).json(), { status: 'BLOCKED', connectionId: null })
  const response = await app.inject({ method: 'POST', url: '/messages', headers, payload: body })
  assert.equal(response.json().code, 'SESSION_BLOCKED')
  assert.equal((await get('/groups')).json().code, 'SESSION_BLOCKED')
  assert.equal(wa.calls.length, 0)
})

test('grupos são consultados novamente e a falha não vira lista vazia', async t => {
  const worker = await setup(t, new FileExecutionStore(await directory(t)))
  const get = () => worker.app.inject({ url: '/groups', headers })
  assert.equal((await get()).json().groups.length, 1)
  worker.socket.groups = async () => [{ id: '456@g.us', name: 'Outro' }]
  assert.equal((await get()).json().groups[0].id, '456@g.us')
  worker.socket.groups = async () => { throw new Error('timeout') }
  assert.equal((await get()).json().code, 'GROUPS_UNAVAILABLE')
  worker.socket.groups = async () => []
  assert.deepEqual((await get()).json(), { groups: [] })
})

test('adaptador restaura credenciais e aguarda novo pareamento após loggedOut', async t => {
  const dir = await directory(t)
  type Factory = NonNullable<ConstructorParameters<typeof BaileysAdapter>[1]>
  let auth!: Parameters<Factory>[0]['auth']
  const listeners = new Map<string, (update: unknown) => void>()
  let sockets = 0
  const factory: Factory = config => {
    sockets++
    auth = config.auth
    return {
      ev: { on: (name: string, callback: (update: unknown) => void) => listeners.set(name, callback) },
      end: async () => {},
    } as unknown as ReturnType<Factory>
  }
  const emit = (name: string, update: unknown) => listeners.get(name)!(update)
  const first = new Connection(new BaileysAdapter(dir, factory))
  await first.start()
  emit('connection.update', { qr: 'qr-de-teste' })
  assert.equal(first.snapshot().status, 'AWAITING_QR')
  emit('creds.update', { registered: true, me: { id: '987@s.whatsapp.net' } })
  await auth.keys.set({ 'lid-mapping': { '987': '654' } })
  emit('connection.update', { connection: 'open' })
  const id = first.snapshot().connectionId
  await first.close()

  const resumed = new Connection(new BaileysAdapter(dir, factory), undefined, () => {
    assert.fail('loggedOut não deve agendar reconexão')
  })
  await resumed.start()
  assert.equal(auth.creds.registered, true)
  assert.equal(auth.creds.me?.id, '987@s.whatsapp.net')
  assert.equal((await auth.keys.get('lid-mapping', ['987']))['987'], '654')
  emit('connection.update', { connection: 'open' })
  assert.equal(resumed.snapshot().status, 'CONNECTED')
  assert.notEqual(resumed.snapshot().connectionId, id)
  emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } },
  })
  assert.equal(resumed.snapshot().status, 'LOGGED_OUT')
  await resumed.close()

  const loggedOut = new Connection(new BaileysAdapter(dir, factory))
  await loggedOut.start()
  assert.equal(loggedOut.snapshot().status, 'LOGGED_OUT')
  assert.equal(sockets, 2)
  loggedOut.pair()
  await loggedOut.close()
  const pairing = new Connection(new BaileysAdapter(dir, factory))
  await pairing.start()
  assert.equal(auth.creds.registered, false)
  emit('connection.update', { qr: 'novo-qr-de-teste' })
  assert.equal(pairing.snapshot().status, 'AWAITING_QR')
  await pairing.close()
})

test('adaptador reconecta com espera progressiva no pareamento e bloqueia sessão substituída', async t => {
  const dir = await directory(t)
  type Factory = NonNullable<ConstructorParameters<typeof BaileysAdapter>[1]>
  const retries: { callback: () => void; delay: number }[] = []
  let socketReady: () => void = () => {}
  let onConnectionUpdate!: (update: unknown) => void
  let onCredentialsUpdate!: (update: unknown) => void
  let auth!: Parameters<Factory>[0]['auth']
  let sockets = 0
  const factory: Factory = config => {
    sockets++
    auth = config.auth
    return {
      ev: {
        on(name: string, callback: (update: unknown) => void) {
          if (name === 'connection.update') {
            onConnectionUpdate = callback
            socketReady()
          }
          if (name === 'creds.update') onCredentialsUpdate = callback
        },
      },
      end: async () => {},
    } as unknown as ReturnType<Factory>
  }
  const connection = new Connection(new BaileysAdapter(dir, factory), undefined, (callback, delay) => {
    retries.push({ callback, delay })
    return () => {}
  })
  t.after(() => connection.close())
  const disconnect = (statusCode: DisconnectReason) => onConnectionUpdate({
    connection: 'close', lastDisconnect: { error: { output: { statusCode } } },
  })
  const reconnect = async (index: number, delay: number) => {
    assert.equal(retries.length, index + 1)
    assert.equal(retries[index].delay, delay)
    const ready = new Promise<void>(resolve => { socketReady = resolve })
    retries[index].callback()
    await ready
    await setImmediate()
    assert.equal(auth.creds.registered, true)
  }

  await connection.start()
  onConnectionUpdate({ qr: 'qr-de-teste' })
  assert.equal(connection.snapshot().status, 'AWAITING_QR')
  onCredentialsUpdate({ registered: true })
  disconnect(DisconnectReason.restartRequired)
  assert.equal(connection.snapshot().status, 'DISCONNECTED')
  assert.throws(() => connection.qrCode(), { code: 'QR_UNAVAILABLE' })
  await reconnect(0, 1000)
  disconnect(DisconnectReason.connectionLost)
  assert.equal(connection.snapshot().status, 'DISCONNECTED')
  await reconnect(1, 2000)
  onConnectionUpdate({ connection: 'open' })
  assert.equal(connection.snapshot().status, 'CONNECTED')
  disconnect(DisconnectReason.connectionReplaced)
  assert.deepEqual(connection.snapshot(), { status: 'BLOCKED', connectionId: null })
  assert.throws(() => connection.currentSocket(), { code: 'SESSION_BLOCKED' })
  assert.throws(() => connection.pair(), { code: 'PAIRING_NOT_ALLOWED' })
  assert.equal(retries.length, 2)
  assert.equal(sockets, 3)
})

test('reproduz confirmação após reinício e vencimento, inclusive com fuso equivalente', async t => {
  const dir = await directory(t)
  const initial = await setup(t, new FileExecutionStore(dir))
  assert.deepEqual((await initial.send()).json(), {
    executionId: body.executionId, status: 'sent', messageId: 'message-1', replayed: false,
  })
  assert.deepEqual(initial.calls, [[body.groupId, body.text]])
  await initial.app.close()
  const resumed = await setup(t, new FileExecutionStore(dir))
  resumed.time(deadline + 1)
  assert.equal((await resumed.send({ ...body, sendBefore: '2026-11-25T20:00:00.000-03:00' })).json().replayed, true)
  for (const changed of [{ text: 'Aviso.' }, { groupId: '456@g.us' }, { sendBefore: '2026-11-25T23:00:00.0001Z' }]) {
    assert.equal((await resumed.send({ ...body, ...changed })).json().code, 'EXECUTION_CONFLICT')
  }
  assert.equal(resumed.calls.length, 0)
  assert.doesNotMatch(await readFile(join(dir, body.executionId + '.json'), 'utf8'), /Aviso|123@g/)
})

test('reinício após queda abrupta com intenção gravada não dispara outro envio', async t => {
  const dir = await directory(t)
  const cwd = new URL('../', import.meta.url)
  const child = `
    import { Dispatch, FileExecutionStore } from './src/dispatch.ts'
    import { normalizeRequest } from './src/request.ts'
    const [dir, payload] = process.argv.slice(1)
    const request = normalizeRequest(JSON.parse(payload))
    const socket = { permission: async () => 'allowed', send: () => process.kill(process.pid, 'SIGKILL') }
    await new Dispatch(new FileExecutionStore(dir), { currentSocket: () => socket }, () => 0).send(request)
  `
  await assert.rejects(promisify(execFile)(process.execPath, [
    '--import', 'tsx', '--input-type=module', '-e', child, dir, JSON.stringify(body),
  ], { cwd }), { signal: 'SIGKILL' })
  const worker = await setup(t, new FileExecutionStore(dir))
  worker.time(deadline + 1)
  assert.equal((await worker.send()).json().code, 'SEND_UNCERTAIN')
  assert.equal(worker.calls.length, 0)
})

test('falhas ao gravar intenção e confirmação preservam a fronteira de envio', async t => {
  const disk = new FileExecutionStore(await directory(t))
  let failingState = 'uncertain'
  const failing: ExecutionStore = {
    read: id => disk.read(id),
    async write(id, execution) {
      if (execution.state === failingState) throw new Error('filesystem unavailable')
      await disk.write(id, execution)
    },
  }
  const worker = await setup(t, failing)
  assert.equal((await worker.send()).json().code, 'INTERNAL_ERROR')
  assert.equal(worker.calls.length, 0)
  failingState = 'sent'
  assert.equal((await worker.send()).json().code, 'SEND_UNCERTAIN')
  assert.equal(worker.calls.length, 1)
  const restarted = await setup(t, disk)
  assert.equal((await restarted.send()).json().code, 'SEND_UNCERTAIN')
  assert.equal(restarted.calls.length, 0)
})

test('falha de transporte após entrar no adaptador gera incerteza persistida', async t => {
  const disk = new FileExecutionStore(await directory(t))
  const worker = await setup(t, disk)
  let calls = 0
  worker.socket.send = async () => {
    calls++
    throw new Error('transport failed')
  }
  assert.equal((await worker.send()).json().code, 'SEND_UNCERTAIN')
  assert.equal((await worker.send()).json().code, 'SEND_UNCERTAIN')
  assert.equal(calls, 1)
  const restarted = await setup(t, disk)
  assert.equal((await restarted.send()).json().code, 'SEND_UNCERTAIN')
  assert.equal(restarted.calls.length, 0)
})

test('prazo é revalidado depois da consulta e depois de gravar a intenção', async t => {
  const disk = new FileExecutionStore(await directory(t))
  const first = await setup(t, disk)
  first.socket.permission = async () => { first.time(deadline); return 'allowed' }
  assert.equal((await first.send()).json().code, 'SEND_EXPIRED')
  assert.equal(first.calls.length, 0)
  const second = await setup(t, {
    read: id => disk.read(id),
    async write(id, execution) {
      await disk.write(id, execution)
      if (execution.state === 'uncertain') second.time(deadline)
    },
  })
  const next = { ...body, executionId: randomUUID() }
  assert.equal((await second.send(next)).json().code, 'SEND_EXPIRED')
  assert.equal(second.calls.length, 0)
})

test('BUSY, falha temporária e permissão são independentes por execução', async t => {
  const worker = await setup(t, new FileExecutionStore(await directory(t)))
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const paused = new Promise<void>(resolve => { release = resolve })
  worker.socket.permission = async group => {
    if (group === '123@g.us') { enter(); await paused; return 'allowed' }
    if (group === '456@g.us') return 'restricted'
    throw new Error('timeout')
  }
  const second = { ...body, groupId: '456@g.us', executionId: randomUUID() }
  const third = { ...body, groupId: '789@g.us', executionId: randomUUID() }
  const inFlight = worker.send()
  await entered
  try {
    assert.equal((await worker.send(second)).json().code, 'BUSY')
  } finally {
    release()
  }
  assert.equal((await inFlight).statusCode, 200)
  assert.equal((await worker.send(second)).json().code, 'GROUP_RESTRICTED')
  assert.equal((await worker.send(third)).json().code, 'GROUP_UNAVAILABLE')
  assert.equal((await worker.send({ ...third, text: 'Alterado' })).json().code, 'EXECUTION_CONFLICT')
  worker.socket.permission = async () => 'allowed'
  assert.equal((await worker.send(third)).statusCode, 200)
  assert.equal(worker.calls.length, 2)
})

test('validação rejeita coerção, data inválida e registro ilegível bloqueia a execução', async t => {
  const dir = await directory(t)
  const worker = await setup(t, new FileExecutionStore(dir))
  for (const changed of [
    { sendBefore: '2026-02-30T23:00:00Z' }, { sendBefore: '2026-11-25T23:00:00' }, { text: '   ' },
    { groupId: '123@s.whatsapp.net' }, { text: 42 }, { executionId: '../../file' },
  ]) {
    assert.equal((await worker.send({ ...body, ...changed } as typeof body)).json().code, 'INVALID_REQUEST')
  }
  await writeFile(join(dir, body.executionId + '.json'), '{')
  assert.equal((await worker.send()).json().code, 'INTERNAL_ERROR')
  assert.equal(worker.calls.length, 0)
})
