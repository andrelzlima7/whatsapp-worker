import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Connection } from './connection.js'
import { WorkerError } from './errors.js'
import type { SendRequest } from './request.js'
import { readOptional, replaceFile } from './storage.js'

type TerminalCode = 'SEND_EXPIRED' | 'NOT_GROUP_MEMBER' | 'GROUP_RESTRICTED'
type Outcome =
  | { state: 'ready' | 'uncertain' }
  | { state: 'sent'; messageId: string }
  | { state: 'rejected'; code: TerminalCode }
type Execution = { fingerprint: string } & Outcome

export interface ExecutionStore {
  read(id: string): Promise<Execution | undefined>
  write(id: string, execution: Execution): Promise<void>
}

export class FileExecutionStore implements ExecutionStore {
  constructor(private readonly directory: string) {}

  async read(id: string): Promise<Execution | undefined> {
    const json = await readOptional(join(this.directory, id + '.json'))
    if (json === undefined) return
    const record = JSON.parse(json)
    if (typeof record?.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(record.fingerprint) ||
        !(
          record.state === 'ready' || record.state === 'uncertain' ||
          (record.state === 'sent' && typeof record.messageId === 'string' && record.messageId.trim()) ||
          (record.state === 'rejected' && ['SEND_EXPIRED', 'NOT_GROUP_MEMBER', 'GROUP_RESTRICTED'].includes(record.code))
        )) {
      throw new WorkerError('INTERNAL_ERROR')
    }
    return record
  }

  write(id: string, execution: Execution) {
    return replaceFile(join(this.directory, id + '.json'), JSON.stringify(execution))
  }
}

export class Dispatch {
  private busy = false
  private readonly unconfirmed = new Set<string>()

  constructor(
    private readonly store: ExecutionStore,
    private readonly connection: Pick<Connection, 'currentSocket'>,
    private readonly now = Date.now,
  ) {}

  async send({ executionId, groupId, text, instant, deadlineMs }: SendRequest) {
    if (this.busy) throw new WorkerError('BUSY')
    this.busy = true
    const fingerprint = createHash('sha256').update(JSON.stringify([groupId, text, instant])).digest('hex')
    const write = (outcome: Outcome) => this.store.write(executionId, { fingerprint, ...outcome })
    const reject = async (code: TerminalCode): Promise<never> => {
      await write({ state: 'rejected', code })
      throw new WorkerError(code)
    }
    try {
      const previous = await this.store.read(executionId)
      const result = (messageId: string, replayed: boolean) => ({
        executionId, status: 'sent' as const, messageId, replayed,
      })
      if (previous && previous.fingerprint !== fingerprint) throw new WorkerError('EXECUTION_CONFLICT')
      if (this.unconfirmed.has(executionId) || previous?.state === 'uncertain') {
        throw new WorkerError('SEND_UNCERTAIN')
      }
      if (previous?.state === 'sent') return result(previous.messageId, true)
      if (previous?.state === 'rejected') throw new WorkerError(previous.code)
      if (this.now() >= deadlineMs) return await reject('SEND_EXPIRED')
      if (!previous) await write({ state: 'ready' })
      const socket = this.connection.currentSocket()
      let permission
      try {
        permission = await socket.permission(groupId)
      } catch (error) {
        if (error instanceof WorkerError) throw error
        throw new WorkerError('GROUP_UNAVAILABLE')
      }
      if (this.now() >= deadlineMs) return await reject('SEND_EXPIRED')
      if (this.connection.currentSocket() !== socket) throw new WorkerError('NOT_CONNECTED')
      if (permission === 'absent') return await reject('NOT_GROUP_MEMBER')
      if (permission === 'restricted') return await reject('GROUP_RESTRICTED')

      await write({ state: 'uncertain' })
      try {
        if (this.connection.currentSocket() !== socket) throw new WorkerError('NOT_CONNECTED')
      } catch (error) {
        await write({ state: 'ready' })
        throw error
      }
      if (this.now() >= deadlineMs) return await reject('SEND_EXPIRED')

      let messageId: string
      try {
        messageId = await socket.send(groupId, text)
        if (!messageId?.trim()) throw new Error()
      } catch {
        throw new WorkerError('SEND_UNCERTAIN')
      }
      try {
        await write({ state: 'sent', messageId })
      } catch {
        // A rename may have succeeded before the directory sync failed.
        this.unconfirmed.add(executionId)
        await write({ state: 'uncertain' }).catch(() => {})
        throw new WorkerError('SEND_UNCERTAIN')
      }
      return result(messageId, false)
    } finally {
      this.busy = false
    }
  }
}
