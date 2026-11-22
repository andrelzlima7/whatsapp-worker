import { randomUUID } from 'node:crypto'
import { WorkerError } from './errors.js'

export type Group = { id: string; name: string }
export type Permission = 'allowed' | 'absent' | 'restricted'
export interface WhatsAppSocket {
  groups(): Promise<Group[]>
  permission(groupId: string): Promise<Permission>
  send(groupId: string, text: string): Promise<string>
  close(): void | Promise<void>
}

type Event =
  | { type: 'open' | 'disconnected' | 'loggedOut' | 'blocked' }
  | { type: 'qr'; value: string }

export interface WhatsAppAdapter {
  connect(notify: (event: Event) => void): Promise<WhatsAppSocket>
  clearSession(): Promise<void>
  flush(): Promise<void>
}

type Status = 'DISCONNECTED' | 'CONNECTING' | 'AWAITING_QR' | 'CONNECTED' | 'LOGGED_OUT' | 'BLOCKED'
type Schedule = (callback: () => void, delay: number) => () => void

export class Connection {
  private status: Status = 'DISCONNECTED'
  private connectionId: string | null = null
  private qr: string | undefined
  private socket: WhatsAppSocket | undefined
  private generation = 0
  private attempts = 0
  private pairing = false
  private stopping = false
  private cancelRetry?: () => void
  private opening?: Promise<void>
  private closing = Promise.resolve()

  constructor(
    private readonly adapter: WhatsAppAdapter,
    private readonly onState: (status: Status) => void = () => {},
    private readonly schedule: Schedule = (callback, delay) => {
      const timer = setTimeout(callback, delay)
      return () => clearTimeout(timer)
    },
  ) {}

  snapshot() {
    return { status: this.status, connectionId: this.connectionId }
  }

  private transition(status: Status) {
    this.status = status
    if (status !== 'CONNECTED') this.connectionId = null
    if (status !== 'AWAITING_QR') this.qr = undefined
    this.onState(status)
  }

  start() {
    this.opening = this.open(false)
    return this.opening
  }

  pair() {
    if (this.pairing) return
    if (this.status !== 'LOGGED_OUT') throw new WorkerError('PAIRING_NOT_ALLOWED')
    this.pairing = true
    this.attempts = 0
    this.opening = this.open(true)
  }

  qrCode() {
    if (!this.qr) throw new WorkerError('QR_UNAVAILABLE')
    return this.qr
  }

  currentSocket() {
    if (this.status === 'BLOCKED') throw new WorkerError('SESSION_BLOCKED')
    if (this.status !== 'CONNECTED' || !this.socket) throw new WorkerError('NOT_CONNECTED')
    return this.socket
  }

  private async open(reset: boolean) {
    const generation = ++this.generation
    this.transition('CONNECTING')
    try {
      await this.closing
      if (reset) await this.adapter.clearSession()
      if (this.stopping) return
      const socket = await this.adapter.connect(event => this.handle(generation, event))
      if (generation === this.generation && !this.stopping) this.socket = socket
      else await socket.close()
    } catch {
      this.handle(generation, { type: 'blocked' })
    }
  }

  private handle(generation: number, event: Event) {
    if (this.stopping) return
    // A queued credential write can fail after the socket reports disconnection.
    const lateWriteFailure = event.type === 'blocked' && generation + 1 === this.generation &&
      (this.status === 'DISCONNECTED' || this.status === 'LOGGED_OUT')
    if (generation !== this.generation && !lateWriteFailure) return
    if (event.type === 'qr') {
      this.qr = event.value
      this.transition('AWAITING_QR')
      return
    }
    if (event.type === 'open') {
      if (this.status === 'CONNECTED') return
      this.attempts = 0
      this.pairing = false
      this.connectionId = randomUUID()
      this.transition('CONNECTED')
      return
    }

    ++this.generation
    const socket = this.socket
    if (socket) this.closing = Promise.resolve().then(() => socket.close()).catch(() => {})
    this.socket = undefined
    if (event.type === 'blocked' || event.type === 'loggedOut') {
      this.cancelRetry?.()
      this.pairing = false
      this.transition(event.type === 'blocked' ? 'BLOCKED' : 'LOGGED_OUT')
      return
    }
    this.transition('DISCONNECTED')
    const delay = Math.min(30_000, 1000 * 2 ** this.attempts++)
    this.cancelRetry = this.schedule(() => {
      this.opening = this.open(false)
    }, delay)
  }

  async close() {
    this.stopping = true
    this.cancelRetry?.()
    await this.opening
    await this.closing
    await this.socket?.close()
    await this.adapter.flush()
  }
}
