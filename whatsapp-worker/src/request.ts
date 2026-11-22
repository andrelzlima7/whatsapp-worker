import { WorkerError } from './errors.js'

export type SendBody = { executionId: string; groupId: string; text: string; sendBefore: string }
export type SendRequest = Omit<SendBody, 'sendBefore'> & { instant: string; deadlineMs: number }

export const sendSchema = {
  type: 'object',
  required: ['executionId', 'groupId', 'text', 'sendBefore'],
  additionalProperties: false,
  properties: {
    executionId: { type: 'string', pattern: '^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' },
    groupId: { type: 'string', pattern: '^[0-9]+(?:-[0-9]+)?@g\\.us$' },
    text: { type: 'string', pattern: '\\S' },
    sendBefore: { type: 'string' },
  },
}

export function normalizeRequest(body: SendBody): SendRequest {
  const match = /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}:\d{2}:\d{2})(?:\.(\d+))?([Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(body.sendBefore)
  if (!match) throw new WorkerError('INVALID_REQUEST')
  const [, date, time, digits = '', offset] = match
  const local = Date.parse(`${date}T${time}Z`)
  const secondsMs = Date.parse(`${date}T${time}${offset.toUpperCase()}`)
  if (!Number.isFinite(secondsMs) || !Number.isFinite(local) ||
      new Date(local).toISOString().slice(0, 19) !== `${date}T${time}`) {
    throw new WorkerError('INVALID_REQUEST')
  }
  const fraction = digits.replace(/0+$/, '')
  const wholeMs = Number(fraction.slice(0, 3).padEnd(3, '0'))
  const deadlineMs = secondsMs + wholeMs + Number(fraction.length > 3)
  return {
    executionId: body.executionId.toLowerCase(),
    groupId: body.groupId,
    text: body.text,
    instant: `${secondsMs}:${fraction}`,
    deadlineMs,
  }
}
