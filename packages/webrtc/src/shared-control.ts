import {
  createControlFrame, decodeControlFrame, encodeControlFrame,
  type ControlFrame, type HelloPayload,
} from '@dsh-remote/protocol'

export const MULTI_HOST_CAPABILITY = 'remote.multi-host.v1'

/** Only the WebSocket surface needed by the control transports. Data sockets
 * remain private to each transport and never pass through this multiplexer. */
export type ControlSocket = Pick<WebSocket,
  'readyState' | 'bufferedAmount' | 'binaryType' | 'send' | 'close' |
  'onopen' | 'onmessage' | 'onerror' | 'onclose'> & { detach?: () => void }
export type ControlSocketFactory = (url: string) => ControlSocket

/** One instance per authenticated account/device. A host link owns its own
 * Noise state, counters and RPC client; this class only routes control frames. */
export class SharedControlConnection {
  private socket?: ControlSocket
  private hello?: HelloPayload
  private ack?: string
  private readonly links = new Set<HostControlSocket>()
  private readonly requests = new Map<string, HostControlSocket>()
  private readonly connections = new Map<string, HostControlSocket>()
  // Keep closed pending requests until their acceptance/rejection arrives.
  // A late acceptance is closed, never assigned to another host.
  private readonly cancelled = new Set<string>()
  private disposed = false

  constructor(private readonly url: string, private readonly createSocket: ControlSocketFactory = url => new WebSocket(url)) {}

  readonly createHostSocket: ControlSocketFactory = url => {
    if (this.disposed) throw new Error('Shared control connection is closed')
    if (url !== this.url) throw new Error('Host control URL does not match the account')
    if (this.links.size + this.cancelled.size >= 256) throw new Error('Shared control capacity exceeded')
    const link = new HostControlSocket(this)
    this.links.add(link)
    if (!this.socket) this.connect()
    if (this.socket?.readyState === WebSocket.OPEN) queueMicrotask(() => link.opened())
    return link
  }

  get bufferedAmount(): number { return this.socket?.bufferedAmount ?? 0 }

  /** Called by the account owner only after refreshing its own credentials.
   * Existing authorized links keep their control connection and Noise state. */
  refreshAccessToken(deviceId: string, previous: string, next: string): void {
    if (!this.hello) return
    if (this.hello.deviceId !== deviceId || this.hello.accessToken !== previous || !next) {
      throw new Error('Credential refresh does not belong to the shared account')
    }
    this.hello = { ...this.hello, accessToken: next }
  }

  private connect(): void {
    const socket = this.createSocket(this.url)
    this.socket = socket
    socket.onopen = () => { for (const link of this.links) link.opened() }
    socket.onmessage = event => {
      if (this.socket !== socket) return
      try {
        if (typeof event.data !== 'string') throw new Error('Control frames must be JSON text')
        this.receive(decodeControlFrame(event.data), event.data)
      } catch { this.fail('Invalid shared control frame') }
    }
    socket.onerror = event => {
      if (this.socket === socket) for (const link of this.links) link.onerror?.call(link as unknown as WebSocket, event)
    }
    socket.onclose = event => {
      if (this.socket !== socket) return
      this.reset(event.code, event.reason)
    }
  }

  send(link: HostControlSocket, data: Parameters<WebSocket['send']>[0]): void {
    if (!this.links.has(link) || this.socket?.readyState !== WebSocket.OPEN) throw new Error('Host control socket is not open')
    if (typeof data !== 'string') throw new Error('Control frames must be JSON text')
    const frame = decodeControlFrame(data)
    const payload = frame.payload as Record<string, unknown>
    if (frame.type === 'hello') {
      const hello = frame.payload as HelloPayload
      if (hello.role !== 'client') throw new Error('Only clients share an account control connection')
      // All host links share exactly one authentication context and capability
      // negotiation. A mismatched link must not replace the healthy account.
      if (this.hello && (hello.deviceId !== this.hello.deviceId || hello.accessToken !== this.hello.accessToken ||
          JSON.stringify(hello.protocols) !== JSON.stringify(this.hello.protocols) ||
          JSON.stringify(hello.capabilities) !== JSON.stringify(this.hello.capabilities))) {
        throw new Error('Host link authentication differs from the shared account')
      }
      link.helloSent = true
      if (!this.hello) {
        this.hello = hello
        this.socket.send(encodeControlFrame(createControlFrame('hello', {
          ...hello, capabilities: [...new Set([...hello.capabilities, MULTI_HOST_CAPABILITY])],
        })))
      }
      if (this.ack) queueMicrotask(() => link.deliver(this.ack!))
      return
    }
    if (!link.helloSent || !this.ack) throw new Error('Shared control has not negotiated multi-host support')
    if (frame.type === 'connect.request') {
      if (link.requestId || link.connectionId) throw new Error('Host link has already requested a connection')
      link.requestId = crypto.randomUUID()
      link.targetDeviceId = payload.hostDeviceId as string
      this.requests.set(link.requestId, link)
      this.socket.send(encodeControlFrame({ ...frame, payload: { ...payload, requestId: link.requestId } }))
      return
    }
    if (frame.type === 'pong' || frame.type === 'ping') return // Account heartbeat has a single owner.
    // A resumed control socket starts with an existing, ticket-authorized
    // lease. The server validates the ticket; never steal another live route.
    if (frame.type === 'connection.lease.request' && !link.connectionId && !link.requestId &&
        typeof payload.connectionId === 'string' && !this.connections.has(payload.connectionId)) {
      link.connectionId = payload.connectionId
      this.connections.set(payload.connectionId, link)
    }
    if (typeof payload.connectionId !== 'string' || payload.connectionId !== link.connectionId ||
        ('targetDeviceId' in payload && link.targetDeviceId !== undefined && payload.targetDeviceId !== link.targetDeviceId)) {
      throw new Error('Control frame does not belong to this host link')
    }
    this.socket.send(data)
  }

  private receive(frame: ControlFrame, raw: string): void {
    const payload = frame.payload as Record<string, unknown>
    if (frame.type === 'hello.ack') {
      if (!this.hello || this.ack || !Array.isArray(payload.capabilities) || !payload.capabilities.includes(MULTI_HOST_CAPABILITY)) {
        throw new Error('Server did not negotiate multi-host control')
      }
      // The link transport validates the remaining capabilities it offered.
      this.ack = encodeControlFrame({ ...frame, payload: {
        ...payload, capabilities: payload.capabilities.filter(value => value !== MULTI_HOST_CAPABILITY),
      } })
      for (const link of this.links) if (link.helloSent) link.deliver(this.ack)
      return
    }
    if (frame.type === 'ping') {
      this.socket?.send(encodeControlFrame(createControlFrame('pong', payload)))
      // Host transports also observe liveness (including their lease timers),
      // while their pong replies are suppressed above.
      for (const link of this.links) if (link.helloSent) link.deliver(raw)
      return
    }
    if (frame.type === 'pong') return
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : undefined
    const connectionId = typeof payload.connectionId === 'string' ? payload.connectionId : undefined
    if (requestId && this.cancelled.has(requestId)) {
      if (frame.type === 'connect.accepted' && connectionId) this.closeConnection(connectionId)
      this.cancelled.delete(requestId)
      return
    }
    const byRequest = requestId ? this.requests.get(requestId) : undefined
    const byConnection = connectionId ? this.connections.get(connectionId) : undefined
    if (byRequest && byConnection && byRequest !== byConnection) throw new Error('Conflicting control correlation')
    const link = byRequest ?? byConnection
    if (frame.type === 'connect.accepted' || frame.type === 'connect.rejected') {
      if (!link || !requestId || !connectionId || link.requestId !== requestId) throw new Error('Uncorrelated host acceptance')
      this.requests.delete(requestId)
      if (frame.type === 'connect.accepted') {
        link.connectionId = connectionId
        this.connections.set(connectionId, link)
      }
    }
    if (frame.type === 'error' && requestId && byRequest) this.requests.delete(requestId)
    if (link) { link.deliver(raw); return }
    if (connectionId || requestId) return // Late frame from a released link.
    if (frame.type === 'error') {
      // An unscoped error is account-wide (e.g. credentials revoked).
      for (const current of [...this.links]) current.deliver(raw)
      this.fail('Shared account control failed')
      return
    }
    throw new Error('Unscoped shared control frame')
  }

  release(link: HostControlSocket, closeConnection = true): void {
    this.links.delete(link)
    if (link.requestId && this.requests.delete(link.requestId)) this.cancelled.add(link.requestId)
    if (link.connectionId) {
      this.connections.delete(link.connectionId)
      if (closeConnection) this.closeConnection(link.connectionId)
    }
    if (this.links.size === 0) {
      const socket = this.socket
      this.reset(1000, '')
      socket?.close()
    }
  }

  private closeConnection(connectionId: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(encodeControlFrame(createControlFrame('connection.lease.close', { connectionId })))
    }
  }

  private reset(code: number, reason: string): void {
    const links = [...this.links]
    this.socket = undefined; this.hello = undefined; this.ack = undefined
    this.links.clear(); this.requests.clear(); this.connections.clear(); this.cancelled.clear()
    for (const link of links) link.closed(code, reason)
  }

  private fail(reason: string): void {
    const socket = this.socket
    this.reset(4001, reason)
    socket?.close(4001, reason)
  }

  close(): void { this.disposed = true; this.fail('Account control closed') }
}

class HostControlSocket implements ControlSocket {
  readyState: number = WebSocket.CONNECTING
  binaryType: BinaryType = 'arraybuffer'
  onopen: WebSocket['onopen'] = null
  onmessage: WebSocket['onmessage'] = null
  onerror: WebSocket['onerror'] = null
  onclose: WebSocket['onclose'] = null
  helloSent = false
  requestId?: string
  connectionId?: string
  targetDeviceId?: string
  constructor(private readonly owner: SharedControlConnection) {}
  get bufferedAmount(): number { return this.owner.bufferedAmount }
  opened(): void {
    if (this.readyState !== WebSocket.CONNECTING) return
    this.readyState = WebSocket.OPEN
    this.onopen?.call(this as unknown as WebSocket, new Event('open'))
  }
  deliver(data: string): void {
    if (this.readyState === WebSocket.OPEN) this.onmessage?.call(this as unknown as WebSocket, new MessageEvent('message', { data }))
  }
  closed(code: number, reason: string): void {
    if (this.readyState === WebSocket.CLOSED) return
    this.readyState = WebSocket.CLOSED
    // Node's browser-compatible WebSocket does not expose CloseEvent globally.
    this.onclose?.call(this as unknown as WebSocket, { code, reason, wasClean: code === 1000 } as CloseEvent)
  }
  send(data: Parameters<WebSocket['send']>[0]): void { this.owner.send(this, data) }
  detach(): void {
    this.owner.release(this, false)
    this.closed(1000, '')
  }
  close(code = 1000, reason = ''): void {
    this.owner.release(this)
    this.closed(code, reason)
  }
}
