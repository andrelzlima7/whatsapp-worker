import { relative, resolve, sep } from 'node:path'
import pino from 'pino'
import { buildApp } from './app.js'
import { BaileysAdapter } from './baileys.js'
import { Connection } from './connection.js'
import { Dispatch, FileExecutionStore } from './dispatch.js'
import { prepareDirectory } from './storage.js'

const log = pino()

function inside(parent: string, child: string) {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith('..' + sep))
}

async function main() {
  const token = process.env.WORKER_TOKEN
  const port = Number(process.env.WORKER_PORT ?? '3000')
  const host = process.env.WORKER_HOST ?? '127.0.0.1'
  const sessionDir = resolve(process.env.WORKER_SESSION_DIR ?? 'data/session')
  const executionsDir = resolve(process.env.WORKER_EXECUTIONS_DIR ?? 'data/executions')
  if (!token || /\s/.test(token) || !Number.isInteger(port) || port < 1 || port > 65535 ||
      inside(sessionDir, executionsDir) || inside(executionsDir, sessionDir)) {
    throw new Error('Invalid worker configuration')
  }
  await prepareDirectory(executionsDir)
  const adapter = new BaileysAdapter(sessionDir)
  const connection = new Connection(adapter, status => log.info({ status }, 'WhatsApp connection'))
  const app = buildApp(token, connection, new Dispatch(new FileExecutionStore(executionsDir), connection), true)
  app.addHook('onClose', () => connection.close())
  const shutdown = () => {
    void app.close().catch(() => {
      log.error({ code: 'INTERNAL_ERROR' }, 'Worker shutdown failed')
      process.exitCode = 1
    })
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  void connection.start()
  try {
    await app.listen({ port, host })
  } catch (error) {
    await app.close()
    throw error
  }
}

void main().catch(() => {
  log.error({ code: 'INTERNAL_ERROR' }, 'Worker startup failed')
  process.exitCode = 1
})
