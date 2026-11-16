import { afterEach, describe, expect, it, vi } from 'vitest'
import { createControlFrame, decodeControlFrame } from '@dsh-remote/protocol'
import { RelayTransport } from '../src/index.js'
import { SharedControlConnection, type ControlSocket } from '../src/shared-control.js'

class Socket {
  static OPEN = 1; static CONNECTING = 0; static CLOSED = 3
  readyState = 0
  bufferedAmount = 0
  binaryType = 'arraybuffer'
  onopen?: () => void
  onmessage?: (event: { data: string }) => void
  onclose?: (event: { code: number; reason: string }) => void
  sent: ReturnType<typeof decodeControlFrame>[] = []
  send(raw: string) { this.sent.push(decodeControlFrame(raw)) }
  open() { this.readyState = 1; this.onopen?.() }
  receive(type: Parameters<typeof createControlFrame>[0], payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(createControlFrame(type, payload)) })
  }
  close(code = 1000, reason = '') { this.readyState = 3; this.onclose?.({ code, reason }) }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('shared account control with independent host transports', () => {
  function fixture() {
    vi.stubGlobal('WebSocket', Socket)
    const sockets: Socket[] = []
    const pool = new SharedControlConnection('wss://example.test/control', () => {
      const socket = new Socket(); sockets.push(socket); return socket as unknown as ControlSocket
    })
    const host = (targetDeviceId: string) => new RelayTransport('wss://example.test/control', {
      role: 'client', deviceId: 'client', accessToken: 'synthetic-token', targetDeviceId,
      controlSocketFactory: pool.createHostSocket,
    })
    const ready = () => {
      sockets[0]!.open()
      sockets[0]!.receive('hello.ack', {
        protocol: 1, serverVersion: 'test', connectionSessionId: 'control', heartbeatIntervalMs: 10000, maxControlFrameBytes: 65536, maxRelayFrameBytes: 1048576,
        capabilities: ['transport.relay', 'remote.multi-host.v1'],
      })
    }
    const request = (id: string) => sockets[0]!.sent.find(frame =>
      frame.type === 'connect.request' && (frame.payload as any).hostDeviceId === id)!.payload as { requestId: string }
    return { sockets, pool, host, ready, request }
  }

  it('correlates out-of-order acceptance, routes frames, and closes A without interrupting B', async () => {
    const f = fixture(), a = f.host('host-a'), b = f.host('host-b')
    try {
      const pa = a.connect(), pb = b.connect()
      expect(f.sockets).toHaveLength(1)
      f.ready()
      const control = f.sockets[0]!
      expect(control.sent.filter(frame => frame.type === 'hello')).toHaveLength(1)
      control.receive('connect.accepted', { connectionId: 'b', requestId: f.request('host-b').requestId })
      control.receive('connect.accepted', { connectionId: 'a', requestId: f.request('host-a').requestId })
      await Promise.all([pa, pb])
      expect(a.connectionInfo().connectionId).toBe('a')
      expect(b.connectionInfo().connectionId).toBe('b')
      const seenA: number[] = [], seenB: number[] = []
      a.onMessage(data => seenA.push(data[0]!)); b.onMessage(data => seenB.push(data[0]!))
      control.receive('relay', { connectionId: 'b', targetDeviceId: 'client', counter: 0, ciphertext: 'Ag' })
      expect(seenA).toEqual([]); expect(seenB).toEqual([2])
      await a.close()
      expect(control.readyState).toBe(Socket.OPEN)
      expect(control.sent.at(-1)?.type).toBe('connection.lease.close')
      await b.send(new Uint8Array([3]))
      expect(control.sent.at(-1)?.payload).toMatchObject({ connectionId: 'b', targetDeviceId: 'host-b', counter: 0 })
      const replacement = f.host('host-a'), connecting = replacement.connect()
      await Promise.resolve(); await Promise.resolve()
      const requests = control.sent.filter(frame => frame.type === 'connect.request')
      control.receive('connect.accepted', { connectionId: 'a2', requestId: (requests.at(-1)!.payload as any).requestId })
      await connecting
      expect(replacement.connectionInfo().connectionId).toBe('a2')
      expect(b.getStats().connected).toBe(true)
      await replacement.close()
    } finally { await a.close(); await b.close(); f.pool.close() }
  })

  it('isolates a failed host and closes a cancelled late acceptance without rebinding it', async () => {
    const f = fixture(), a = f.host('host-a'), b = f.host('host-b')
    try {
      const pa = a.connect(), pb = b.connect()
      const rejected = expect(pa).rejects.toThrow('offline')
      f.ready()
      const control = f.sockets[0]!
      control.receive('error', { code: 'HOST_OFFLINE', message: 'offline', requestId: f.request('host-a').requestId })
      await rejected
      control.receive('connect.accepted', { connectionId: 'b', requestId: f.request('host-b').requestId })
      await pb
      const c = f.pool.createHostSocket('wss://example.test/control')
      await Promise.resolve()
      c.send(JSON.stringify(createControlFrame('hello', { role: 'client', deviceId: 'client', accessToken: 'synthetic-token', protocols: [1], capabilities: ['transport.relay', 'transport.relay.attach'] })))
      await Promise.resolve()
      c.send(JSON.stringify(createControlFrame('connect.request', { hostDeviceId: 'host-c', preferredTransports: ['relay'] })))
      const requestId = f.request('host-c').requestId
      c.close()
      control.receive('connect.accepted', { connectionId: 'late-c', requestId })
      expect(control.sent.at(-1)).toMatchObject({ type: 'connection.lease.close', payload: { connectionId: 'late-c' } })
      expect(b.getStats().connected).toBe(true)
      control.receive('ping', { nonce: 'heartbeat' })
      expect(control.sent.at(-1)).toMatchObject({ type: 'pong', payload: { nonce: 'heartbeat' } })
    } finally { await a.close(); await b.close(); f.pool.close() }
  })

  it('rejects a server without multi-host negotiation before requesting any host', async () => {
    const f = fixture(), a = f.host('host-a')
    try {
      const connecting = a.connect(), rejected = expect(connecting).rejects.toThrow()
      f.sockets[0]!.open()
      f.sockets[0]!.receive('hello.ack', { protocol: 1, serverVersion: 'test', connectionSessionId: 'control', heartbeatIntervalMs: 10000, maxControlFrameBytes: 65536, maxRelayFrameBytes: 1048576, capabilities: ['transport.relay'] })
      await rejected
      expect(f.sockets[0]!.sent.filter(frame => frame.type === 'connect.request')).toHaveLength(0)
    } finally { await a.close(); f.pool.close() }
  })

  it('delivers account heartbeats to each host and preserves a detached authorization lease', async () => {
    const f = fixture(), a = f.host('host-a')
    const hello = (token: string) => JSON.stringify(createControlFrame('hello', {
      role: 'client', deviceId: 'client', accessToken: token, protocols: [1],
      capabilities: ['transport.relay', 'transport.relay.attach'],
    }))
    try {
      const connecting = a.connect(); f.ready()
      const control = f.sockets[0]!
      control.receive('connect.accepted', { connectionId: 'a', requestId: f.request('host-a').requestId })
      await connecting
      f.pool.refreshAccessToken('client', 'synthetic-token', 'renewed-token')
      const b = f.pool.createHostSocket('wss://example.test/control')
      await Promise.resolve()
      const frames: string[] = []
      b.onmessage = event => frames.push(decodeControlFrame(event.data).type)
      b.send(hello('renewed-token')); await Promise.resolve()
      b.send(JSON.stringify(createControlFrame('connection.lease.request', {
        connectionId: 'existing-b', requestId: 'lease-1', ticket: 'synthetic-ticket',
      })))
      control.receive('ping', { nonce: 'idle-heartbeat' })
      expect(frames).toContain('ping')
      expect(control.sent.filter(frame => frame.type === 'pong')).toHaveLength(1)
      b.detach!()
      expect(control.sent.some(frame => frame.type === 'connection.lease.close' &&
        (frame.payload as any).connectionId === 'existing-b')).toBe(false)
      expect(a.getStats().connected).toBe(true)
      const recovered = f.pool.createHostSocket('wss://example.test/control')
      await Promise.resolve(); recovered.send(hello('renewed-token')); await Promise.resolve()
      recovered.send(JSON.stringify(createControlFrame('connection.lease.request', {
        connectionId: 'existing-b', requestId: 'lease-2', ticket: 'synthetic-ticket',
      })))
      const received: string[] = []
      recovered.onmessage = event => received.push(decodeControlFrame(event.data).type)
      control.receive('connection.lease.ack', { connectionId: 'existing-b', requestId: 'lease-2', ticket: 'renewed-ticket', leaseMs: 300000 })
      expect(received).toEqual(['connection.lease.ack'])
      recovered.close()
      expect(control.sent.at(-1)).toMatchObject({ type: 'connection.lease.close', payload: { connectionId: 'existing-b' } })
    } finally { await a.close(); f.pool.close() }
  })
})
