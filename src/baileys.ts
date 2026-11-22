import makeWASocket, {
  BufferJSON, DisconnectReason, initAuthCreds, jidNormalizedUser, proto,
  type AuthenticationCreds, type SignalDataSet, type SignalDataTypeMap, type SignalKeyStore,
} from '@whiskeysockets/baileys'
import { join } from 'node:path'
import pino from 'pino'
import type { WhatsAppAdapter } from './connection.js'
import { WorkerError } from './errors.js'
import { prepareDirectory, readOptional, replaceFile } from './storage.js'

type Session = {
  loggedOut?: boolean
  creds: AuthenticationCreds
  keys: SignalDataSet
}

function freshSession(): Session {
  return { creds: initAuthCreds(), keys: {} }
}

export class BaileysAdapter implements WhatsAppAdapter {
  private writes = Promise.resolve()
  private failed = false

  constructor(
    private readonly directory: string,
    private readonly makeSocket = makeWASocket,
  ) {}

  private get path() {
    return join(this.directory, 'auth.json')
  }

  private save(session: Session, onFailure: () => void) {
    const contents = JSON.stringify(session, BufferJSON.replacer)
    const write = this.writes.then(async () => {
      if (this.failed) throw new Error('Session storage blocked')
      await replaceFile(this.path, contents)
    })
    this.writes = write.catch(() => {
      this.failed = true
      onFailure()
    })
    return write
  }

  async flush() {
    await this.writes
  }

  async clearSession() {
    await this.flush()
    await this.save(freshSession(), () => {})
  }

  async connect(notify: Parameters<WhatsAppAdapter['connect']>[0]) {
    await this.flush()
    if (this.failed) throw new Error('Session storage blocked')
    await prepareDirectory(this.directory)
    const json = await readOptional(this.path)
    const session: Session = json === undefined ? freshSession() : JSON.parse(json, BufferJSON.reviver)
    if (!session?.creds?.noiseKey || !session.keys) throw new Error('Invalid session')
    if (session.loggedOut) {
      notify({ type: 'loggedOut' })
      return { groups: unavailable, permission: unavailable, send: unavailable, close() {} }
    }
    // Verify session storage before exposing a socket, even with existing credentials.
    const persist = () => this.save(session, () => notify({ type: 'blocked' }))
    await persist()
    let closing: Promise<void> | undefined
    const keys: SignalKeyStore = {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const data: Record<string, SignalDataTypeMap[T]> = Object.create(null)
        for (const id of ids) {
          const values = session.keys[type]
          const value = values && Object.hasOwn(values, id) ? values[id] : undefined
          if (value != null) {
            if (type === 'app-state-sync-key') {
              // TypeScript cannot narrow the indexed generic when checking its key.
              const key = proto.Message.AppStateSyncKeyData.fromObject(value as proto.Message.IAppStateSyncKeyData)
              data[id] = key as unknown as SignalDataTypeMap[T]
            } else {
              data[id] = value
            }
          }
        }
        return data
      },
      set: async updates => {
        if (closing) throw new Error('Socket closed')
        for (const type of Object.keys(updates) as (keyof SignalDataSet)[]) {
          const values = session.keys[type] ??= Object.create(null)
          for (const [id, value] of Object.entries(updates[type] ?? {})) {
            if (value == null) delete values[id]
            else Object.defineProperty(values, id, {
              value, enumerable: true, configurable: true, writable: true,
            })
          }
        }
        await persist()
      },
    }
    const socket = this.makeSocket({
      auth: { creds: session.creds, keys },
      logger: pino({ level: 'silent' }),
      connectTimeoutMs: 20_000,
      defaultQueryTimeoutMs: 15_000,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      getMessage: async () => undefined,
    })
    const close = () => closing ??= socket.end(undefined)
    socket.ev.on('creds.update', update => {
      if (closing) return
      Object.assign(session.creds, update)
      void persist().catch(() => {})
    })
    socket.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
      if (closing) return
      if (qr) notify({ type: 'qr', value: qr })
      if (connection === 'open') notify({ type: 'open' })
      if (connection === 'close') {
        const status = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode
        if (status === DisconnectReason.loggedOut) {
          session.loggedOut = true
          void persist().catch(() => {})
          notify({ type: 'loggedOut' })
        } else if (status === DisconnectReason.connectionReplaced) {
          notify({ type: 'blocked' })
        } else {
          // restartRequired also uses the retry path to reopen with the saved pairing credentials.
          notify({ type: 'disconnected' })
        }
      }
    })
    return {
      async groups() {
        const groups = await socket.groupFetchAllParticipating()
        return Object.values(groups).map(group => ({ id: group.id, name: group.subject }))
      },
      async permission(groupId: string) {
        let group
        try {
          group = await socket.groupMetadata(groupId)
        } catch (error) {
          const status = (error as { output?: { statusCode?: number } } | null)?.output?.statusCode
          if (status === 403 || status === 404) return 'absent' as const
          throw error
        }
        const account = new Set([socket.user?.id, socket.user?.lid, socket.user?.phoneNumber]
          .filter((id): id is string => Boolean(id))
          .map(jidNormalizedUser))
        const participant = group.participants.find(member => [member.id, member.lid, member.phoneNumber]
          .some(id => id && account.has(jidNormalizedUser(id))))
        if (!participant) return 'absent' as const
        const admin = participant.admin === 'admin' || participant.admin === 'superadmin' ||
          participant.isAdmin || participant.isSuperAdmin
        return group.announce && !admin ? 'restricted' as const : 'allowed' as const
      },
      async send(groupId: string, text: string) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const message = await Promise.race([
            socket.sendMessage(groupId, { text }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                notify({ type: 'disconnected' })
                void close().catch(() => {})
                reject(new Error('Send timeout'))
              }, 30_000)
            }),
          ])
          return message?.key.id ?? ''
        } finally {
          clearTimeout(timer)
        }
      },
      close,
    }
  }
}

async function unavailable(): Promise<never> {
  throw new WorkerError('NOT_CONNECTED')
}
