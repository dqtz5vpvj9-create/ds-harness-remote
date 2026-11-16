import { generateKeyPair, NoiseIkSession, createNoisePrologue, fromBase64Url, toBase64Url } from '@dsh-remote/crypto'
import { createControlFrame, createRpcResponse, decodeMessage, encodeMessage, SecureMessageCodec } from '@dsh-remote/protocol'
import { expect, it, vi } from 'vitest'
import { ClientModeRuntime } from '../src/client-runtime.js'
import { resolveConfig } from '../src/config.js'
import type { IdentityStore } from '../src/identity-store.js'
import type { ClientServerApi } from '../src/server-api.js'
import type { SafeLogger } from '../src/logging.js'
import { ClientHosts } from '../src/client-hosts.js'
import type { ConnectedRemote } from '../src/client-runtime-contract.js'

it('deduplicates pending Host establishment and fences late completion after releasing that Host', async () => {
  const releases = new Map<string, (remote: ConnectedRemote) => void>()
  const connect = vi.fn((host: string) => new Promise<ConnectedRemote>(resolve => releases.set(host, resolve)))
  const owner = new ClientHosts(connect, { enabled: false, initialDelayMs: 100, maxDelayMs: 1000, jitter: 0 })
  const makeRemote = (host: string) => ({ target: { deviceId: host }, client: {
    close: vi.fn(async () => {}), onClose: vi.fn(),
  } }) as unknown as ConnectedRemote
  const cancelled = new AbortController()
  const first = owner.get('a', cancelled.signal)
  const rejected = expect(first).rejects.toThrow('cancelled read')
  const second = owner.get('a'), independent = owner.get('b')
  cancelled.abort(new Error('cancelled read'))
  await rejected
  expect(connect).toHaveBeenCalledTimes(2)
  const a = makeRemote('a'), b = makeRemote('b')
  releases.get('b')!(b)
  expect(await independent).toBe(b)
  const stale = expect(second).rejects.toMatchObject({ code: 'CANCELLED' })
  const closing = owner.release('a')
  releases.get('a')!(a)
  await closing; await stale
  expect(a.client.close).toHaveBeenCalledOnce()
  expect(b.client.close).not.toHaveBeenCalled()
  expect(await owner.get('b')).toBe(b)
  await owner.close()
  expect(b.client.close).toHaveBeenCalledOnce()
})

// Real runtime, connection owner, account control, RPC and Noise. The socket
// boundary below represents two independently keyed Hosts and the relay.
it('keeps host-bound source operations isolated through selection, lost receipts and reconnect', async () => {
  const clientKeys = generateKeyPair(new Uint8Array(32).fill(41))
  const keys = new Map(['a', 'b'].map((id, i) => [id, generateKeyPair(new Uint8Array(32).fill(i + 42))]))
  const identity = { schemaVersion: 1 as const, deviceId: 'client', name: 'Client', fingerprint: 'CLIENT', ...clientKeys }
  const hosts = [...keys].map(([deviceId, key]) => ({ deviceId, name: deviceId, role: 'host', platform: 'linux', membershipId: 'member', identityKey: key.publicKey }))
  type Link = { host: string; noise?: NoiseIkSession; incoming: SecureMessageCodec; outgoing: SecureMessageCodec; counter: number }
  const links = new Map<string, Link>()
  const calls: Array<{ host: string; endpoint: string; operationId?: string }> = []
  const receipts = new Map<string, unknown>()
  const sockets: Socket[] = []
  let nextLink = 0
  class Socket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
    readyState = 0; bufferedAmount = 0; binaryType = ''
    onopen?: () => void
    onmessage?: (event: { data: string }) => void
    onclose?: (event: { code: number; reason: string }) => void
    constructor() { sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.onopen?.() }) }
    receive(type: Parameters<typeof createControlFrame>[0], payload: unknown) {
      queueMicrotask(() => { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(createControlFrame(type, payload)) }) })
    }
    send(raw: string) {
      const frame = JSON.parse(raw), p = frame.payload
      if (frame.type === 'hello') {
        expect(p.capabilities).toContain('remote.multi-host.v1')
        this.receive('hello.ack', { protocol: 1, serverVersion: 'test', connectionSessionId: 'account', heartbeatIntervalMs: 25000,
          maxControlFrameBytes: 65536, maxRelayFrameBytes: 1048576, capabilities: ['transport.relay', 'remote.multi-host.v1'] })
      }
      if (frame.type === 'connect.request') {
        const id = `link-${++nextLink}`
        links.set(id, { host: p.hostDeviceId, incoming: new SecureMessageCodec(), outgoing: new SecureMessageCodec(), counter: 0 })
        this.receive('connect.accepted', { connectionId: id, requestId: p.requestId })
      }
      if (frame.type === 'connection.lease.close') { links.get(p.connectionId)?.noise?.destroy(); links.delete(p.connectionId); return }
      if (frame.type === 'secure.handshake') {
        const link = links.get(p.connectionId)!, key = keys.get(link.host)!
        link.noise = new NoiseIkSession({ role: 'responder', localPrivateKey: key.privateKey, localPublicKey: key.publicKey,
          remotePublicKey: clientKeys.publicKey, prologue: createNoisePrologue(p.connectionId, link.host, 'client') })
        link.noise.readHandshake(fromBase64Url(p.data))
        this.receive('secure.handshake', { connectionId: p.connectionId, targetDeviceId: 'client', step: 2, data: toBase64Url(link.noise.writeHandshake()) })
      }
      if (frame.type !== 'relay') return
      const link = links.get(p.connectionId)!
      const bytes = link.incoming.decode(link.noise!.decrypt(fromBase64Url(p.ciphertext)))
      if (!bytes) return
      const request = decodeMessage(bytes), payload = request.payload as { method: string; params: { endpoint: string; payload: { args: { request: { operationId?: string } } } } }
      let result: unknown = { capabilities: ['harness.remote.v1'] }
      if (payload.method === 'harness.remote.call') {
        const endpoint = payload.params.endpoint, operationId = payload.params.payload.args.request?.operationId
        calls.push({ host: link.host, endpoint, operationId })
        result = { ok: true, value: { host: link.host } }
        if (endpoint === 'hhpi/operate') {
          receipts.set(`${link.host}:${operationId}`, { status: 'accepted' })
          // Source commits; only its response channel fails. B remains live.
          this.receive('error', { code: 'TRANSPORT_CLOSED', message: 'Link lost', retryable: true, connectionId: p.connectionId })
          return
        }
        if (endpoint === 'hhpi/receipt') result = { ok: true, value: receipts.get(`${link.host}:${operationId}`) }
      }
      for (const part of link.outgoing.encode(encodeMessage(createRpcResponse(request.id, result)))) {
        this.receive('relay', { connectionId: p.connectionId, targetDeviceId: 'client', counter: link.counter++, ciphertext: toBase64Url(link.noise!.encrypt(part)) })
      }
    }
    close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: '' }) }
  }
  vi.stubGlobal('WebSocket', Socket)
  const server = { baseUrl: 'https://relay.test', bindIdentity() {},
    listDevices: vi.fn(async () => hosts), deviceFor: async (id: string) => hosts.find(host => host.deviceId === id),
    presenceFor: async () => ({ online: true }), authenticate: async () => ({ accessToken: 'account-token' }),
  }
  const identities = { loadOrCreate: async () => identity, trustedPeer: (id: string) => ({ deviceId: id, name: id,
    platform: 'linux', membershipId: 'member', publicKey: keys.get(id)!.publicKey }) } as unknown as IdentityStore
  const localInvoke = vi.fn()
  const gateway = { invoke: localInvoke, dispatchRpc: async () => ({ ok: true }), wireStream: {
    open: async () => (async function* () {})(), failure: () => ({ code: 'internal', message: '', details: {} }),
  } }
  const runtime = new ClientModeRuntime(resolveConfig({ multiHost: true, forceRelay: true,
    reconnect: { initialDelayMs: 100, maxDelayMs: 1000 } }), identities, server as unknown as ClientServerApi, gateway,
    { info() {}, warn() {}, debug() {}, error() {} } as unknown as SafeLogger)
  try {
    await runtime.start()
    const a = runtime.gatewayForHost('a'), b = runtime.gatewayForHost('b')
    const read = { namespace: 'hhpi', method: 'read', args: { request: { sessionId: 'same-native-id' } } }
    expect(await Promise.all([a.invoke(read), b.invoke(read)])).toEqual([{ host: 'a' }, { host: 'b' }])
    expect(sockets).toHaveLength(1)
    expect(links.size).toBe(2)
    await runtime.setMode('remote', 'b')
    expect(await a.invoke(read)).toEqual({ host: 'a' })
    await expect(a.invoke({ namespace: 'hhpi', method: 'operate', args: { request: { operationId: 'stable-id' } } })).rejects.toThrow()
    expect(await b.invoke(read)).toEqual({ host: 'b' })
    await vi.waitFor(async () => expect(await a.invoke(read)).toEqual({ host: 'a' }), { timeout: 2500 })
    expect(await a.invoke({ namespace: 'hhpi', method: 'receipt', args: { request: { operationId: 'stable-id' } } })).toEqual({ status: 'accepted' })
    expect(calls.filter(call => call.endpoint === 'hhpi/operate')).toEqual([{ host: 'a', endpoint: 'hhpi/operate', operationId: 'stable-id' }])
    expect(sockets).toHaveLength(1)
    expect(runtime.status()).toMatchObject({ connectedTargetDeviceId: 'b', connected: true })
    await runtime.setMode('local')
    expect(await a.invoke(read)).toEqual({ host: 'a' })
    expect(await b.invoke(read)).toEqual({ host: 'b' })
    expect(sockets).toHaveLength(1)
    expect(links.size).toBe(2)
    await runtime.disconnectHost('a')
    expect(links.size).toBe(1)
    expect(await b.invoke(read)).toEqual({ host: 'b' })
    expect(localInvoke).not.toHaveBeenCalled()
  } finally {
    await runtime.close()
    for (const link of links.values()) link.noise?.destroy()
    vi.unstubAllGlobals()
  }
  expect(links.size).toBe(0)
  expect(sockets[0]!.readyState).toBe(3)
}, 10000)
