import { once } from 'node:events'
import { createServer } from 'node:net'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { createRemoteServer } from '../apps/server/src/server.js'
import { OperationLedger } from '../packages/native-runtime/src/remote/operation-ledger.js'
import { sourceSessionId, type SourceOperation } from '../packages/native-runtime/src/remote/protocol.js'
import { HostPluginRuntime } from '../packages/plugin/src/service.js'
import { ClientModeRuntime } from '../packages/plugin/src/client-runtime.js'
import { IdentityStore } from '../packages/plugin/src/identity-store.js'
import { ClientServerApi } from '../packages/plugin/src/server-api.js'
import { ServerCredentialStore } from '../packages/plugin/src/server-credentials.js'
import { resolveConfig } from '../packages/plugin/src/config.js'
import { SafeLogger } from '../packages/plugin/src/logging.js'
import type { LocalTypertGateway } from '../packages/plugin/src/typert-gateway-contract.js'

// Real self-hosted Server, WebSockets, Noise, Host/Client runtimes and durable
// source receipts. Only the native executor and its Typert entry are fixtures.
// No provider request, production credentials, data or device is used.
it('keeps B live while A loses an accepted write receipt, then recovers the same durable receipt without replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'remote-native-network-'))
  const probe = createServer().listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = (probe.address() as { port: number }).port
  await new Promise<void>(resolve => probe.close(() => resolve()))
  const base = `http://127.0.0.1:${port}`
  const account = 'synthetic@localhost', password = randomUUID()
  const server = createRemoteServer({ account, password, publicUrl: base, dataFile: join(directory, 'server.json'), logLevel: 'error' })
  const logger = new SafeLogger({ debug() {}, info() {}, warn() {}, error() {} })
  const config = resolveConfig({ serverUrl: base, forceRelay: true, multiHost: true,
    codex: { enabled: false }, acp: { enabled: false }, hostControl: { enabled: true },
    reconnect: { initialDelayMs: 100, maxDelayMs: 1000, jitter: 0 } })
  const hosts: HostPluginRuntime[] = []
  let client: ClientModeRuntime | undefined
  let stage = 'start'
  let executions = 0
  const firstWrite = Promise.withResolvers<void>()
  const releaseWrite = Promise.withResolvers<void>()
  const operation: SourceOperation = {
    sessionId: sourceSessionId({ machineId: 'machine-a', sourceId: 'native', engine: 'codex', nativeId: 'same-thread' }),
    operationId: 'stable-message-operation', kind: 'send', text: 'synthetic input',
  }
  try {
    server.server.listen(port, '127.0.0.1')
    await once(server.server, 'listening')
    for (const name of ['a', 'b']) {
      const ledgerDirectory = join(directory, `receipts-${name}`)
      await mkdir(ledgerDirectory)
      let ledger = new OperationLedger(ledgerDirectory)
      const gateway: LocalTypertGateway = {
        supportsCarrier: true,
        invoke: async () => undefined,
        open: async () => (async function* () {})(),
        failure: () => ({ code: 'fixture/error', message: 'Synthetic source error', details: {} }),
        dispatch: async (endpoint, payload) => {
          if (endpoint === 'session/list') return { ok: false, error: { code: 'gateway/arguments-invalid', message: 'Probe only', details: {} } }
          const request = (payload as { args: { request: SourceOperation } }).args.request
          const ownSession = sourceSessionId({ machineId: `machine-${name}`, sourceId: 'native', engine: 'codex', nativeId: 'same-thread' })
          if (request.sessionId !== ownSession) return { ok: false, error: { code: 'remote-access/denied', message: 'Wrong source', details: {} } }
          if (endpoint === 'hhpi/read') return { ok: true, value: { machine: name, content: '完整正文'.repeat(50000) } }
          if (endpoint === 'hhpi/operate') {
            const value = await ledger.run(request, async () => {
              executions++
              return { sessionId: request.sessionId, operationId: request.operationId, status: 'accepted', message: 'Native accepted' }
            })
            // Receipt was durably saved before its channel is broken by the test.
            firstWrite.resolve()
            await releaseWrite.promise
            return { ok: true, value }
          }
          if (endpoint === 'hhpi/receipt') {
            // Reopen storage to verify recovery does not depend on live memory.
            ledger = new OperationLedger(ledgerDirectory)
            return { ok: true, value: await ledger.lookup(request) }
          }
          return { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Synthetic boundary', details: {} } }
        },
      }
      const host = new HostPluginRuntime({ ...config, deviceName: `Synthetic ${name}` }, new IdentityStore({ directory: join(directory, name) }), logger, gateway)
      hosts.push(host)
      await host.start()
      await host.authorizeHostWithAccount(account, password)
    }
    const identity = new IdentityStore({ directory: join(directory, 'client') })
    const api = new ClientServerApi(base, new ServerCredentialStore(identity.directory))
    const noLocalExecution = async (): Promise<never> => { throw new Error('Must not fall back to local execution') }
    const localClientGateway = {
      invoke: noLocalExecution, dispatchRpc: noLocalExecution,
      wireStream: { open: noLocalExecution, failure: () => ({ code: 'fixture/local', message: '', details: {} }) },
    }
    client = new ClientModeRuntime(config, identity, api, localClientGateway, logger, undefined, async () => undefined)
    await client.start()
    await client.authorizeClientWithAccount(account, password)
    const [a, b] = hosts.map(host => client!.gatewayForHost(host.currentIdentity().deviceId))
    const read = { namespace: 'hhpi', method: 'read', args: { request: { sessionId: operation.sessionId } } }
    const readB = { ...read, args: { request: { sessionId: sourceSessionId({ machineId: 'machine-b', sourceId: 'native', engine: 'codex', nativeId: 'same-thread' }) } } }
    const [firstA, firstB] = await Promise.all([a!.invoke(read), b!.invoke(readB)])
    expect(firstA).toEqual({ machine: 'a', content: '完整正文'.repeat(50000) })
    expect(firstB).toEqual({ machine: 'b', content: '完整正文'.repeat(50000) })
    await expect(b!.invoke(read)).rejects.toMatchObject({ code: 'remote-access/denied' })
    stage = 'select B'
    await client.setMode('remote', hosts[1]!.currentIdentity().deviceId)
    stage = 'accept A write'
    const write = a!.invoke({ namespace: 'hhpi', method: 'operate', args: { request: operation }, signal: AbortSignal.timeout(4000) })
    const lost = expect(write).rejects.toBeDefined()
    await Promise.race([firstWrite.promise, write.then(() => { throw new Error('Receipt arrived before network loss') })])
    stage = 'disconnect A'
    await hosts[0]!.connections.close()
    releaseWrite.resolve()
    stage = 'observe lost receipt'
    await lost
    stage = 'read B'
    expect(await b!.invoke(readB)).toEqual(firstB)
    stage = 'recover A receipt'
    await vi.waitFor(() => expect(hosts[0]!.hostStatus().connectedClients).toHaveLength(1), { timeout: 5000 })
    expect(await a!.invoke({ namespace: 'hhpi', method: 'receipt', args: { request: operation }, signal: AbortSignal.timeout(4000) })).toMatchObject({ status: 'accepted', operationId: operation.operationId })
    expect(executions).toBe(1)
    expect(await a!.invoke(read)).toEqual(firstA)
    await client.disconnectHost(hosts[0]!.currentIdentity().deviceId)
    expect(await b!.invoke(readB)).toEqual(firstB)
    expect(executions).toBe(1)
  } catch (cause) {
    throw new Error(`Multi-host network scenario failed at ${stage}`, { cause })
  } finally {
    releaseWrite.resolve()
    await client?.close()
    await Promise.all(hosts.map(host => host.close()))
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 20000)
