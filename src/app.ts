import { createHash, timingSafeEqual } from 'node:crypto'
import Fastify, { LogController } from 'fastify'
import QRCode from 'qrcode'
import type { Connection } from './connection.js'
import type { Dispatch } from './dispatch.js'
import { WorkerError, errors } from './errors.js'
import { normalizeRequest, sendSchema, type SendBody } from './request.js'

const digest = (value: string) => createHash('sha256').update(value).digest()

export function buildApp(token: string, connection: Connection, dispatch: Dispatch, logger = false) {
  const app = Fastify({
    logger,
    logController: new LogController({ disableRequestLogging: true }),
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  })
  const authorization = digest(`Bearer ${token}`)
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    if (!timingSafeEqual(authorization, digest(request.headers.authorization ?? ''))) {
      throw new WorkerError('UNAUTHORIZED')
    }
  })
  app.setErrorHandler((error, request, reply) => {
    const statusCode = (error as { statusCode?: number } | null)?.statusCode
    const code = error instanceof WorkerError ? error.code :
      (statusCode && statusCode < 500 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR')
    const [status, message] = errors[code]
    request.log.warn({ code }, 'Worker request failed')
    return reply.code(status).send({ code, message })
  })
  app.setNotFoundHandler((_request, reply) => {
    return reply.code(404).send({ code: 'INVALID_REQUEST', message: errors.INVALID_REQUEST[1] })
  })
  app.get('/health', async () => ({ status: 'ok' }))
  app.get('/connection', async () => connection.snapshot())
  app.get('/connection/qr', async () => {
    const qr = connection.qrCode()
    const qrImage = await QRCode.toDataURL(qr)
    if (connection.qrCode() !== qr) throw new WorkerError('QR_UNAVAILABLE')
    return { qrImage }
  })
  app.post('/connection/pairing', async (_request, reply) => {
    connection.pair()
    return reply.code(202).send()
  })
  app.get('/groups', async () => {
    const socket = connection.currentSocket()
    let groups
    try {
      groups = await socket.groups()
    } catch {
      throw new WorkerError('GROUPS_UNAVAILABLE')
    }
    if (connection.currentSocket() !== socket) throw new WorkerError('GROUPS_UNAVAILABLE')
    return { groups }
  })
  app.post<{ Body: SendBody }>('/messages', { schema: { body: sendSchema } }, async request => {
    const data = normalizeRequest(request.body)
    request.log = request.log.child({ executionId: data.executionId })
    const result = await dispatch.send(data)
    request.log.info({ replayed: result.replayed }, 'Execution confirmed')
    return result
  })
  return app
}
