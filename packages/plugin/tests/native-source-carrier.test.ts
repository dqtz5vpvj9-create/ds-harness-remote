import { describe, expect, it, vi } from 'vitest'
import { HarnessRemoteBridge } from '../src/harness-remote-bridge.js'
import type { LocalTypertGateway } from '../src/typert-gateway-contract.js'
import { RemoteTypertGateway, type RemoteClientCore } from '@dsh-remote/client-core'
import { RemoteTypertGateway as PluginGateway } from '../src/remote-typert-gateway.js'

const local = (overrides: Partial<LocalTypertGateway>): LocalTypertGateway => ({
  supportsCarrier: true, invoke: async () => undefined, dispatch: async () => ({ ok: true }),
  open: async () => (async function* () {})(), failure: error => ({ code: 'native/error', message: String(error), details: {} }),
  ...overrides,
})

describe('source-owned native API over the existing Remote carrier', () => {
  it('keeps source identities, operation receipts and native refusal details intact', async () => {
    const input = { sourceId: 'machine-B/codex', operationId: 'op-1', method: 'thread/settings/update', params: { serviceTier: 'fast' } }
    const result = { ok: true as const, value: { status: 'indeterminate', message: 'Reply lost', resultUnavailable: true } }
    const denied = { ok: false as const, error: { code: 'remote-access/denied', message: 'No source grant', details: { sourceId: input.sourceId } } }
    const dispatch = vi.fn(async (endpoint: string) => endpoint === 'hhpi/nativeReply' ? denied : result)
    const bridge = new HarnessRemoteBridge(local({ dispatch }), vi.fn())
    await expect(bridge.call({ endpoint: 'hhpi/nativeCall', payload: { args: { request: input } } })).resolves.toEqual(result)
    expect(dispatch).toHaveBeenCalledWith('hhpi/nativeCall', { args: { request: input } }, expect.any(AbortSignal))
    await expect(bridge.call({ endpoint: 'hhpi/nativeReply', payload: { args: { request: { ...input, requestId: 'generation-4:request-7' } } } })).resolves.toEqual(denied)
    await expect(bridge.call({ endpoint: 'hhpi/deleteEverything', payload: {} })).rejects.toMatchObject({ code: 'METHOD_NOT_ALLOWED' })
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('transmits the full source history frame without legacy compaction and closes only the read stream', async () => {
    const frame = { epoch: 'source-epoch', base: 3, version: 4, reset: false, removed: [], upserts: [{ seq: 4, data: '完整正文'.repeat(50000) }] }
    let stopped = false
    const open = vi.fn(async (_endpoint: string, _payload: unknown, signal: AbortSignal) => (async function* () {
      try { yield frame; await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }); if (signal.aborted) resolve() }) }
      finally { stopped = true }
    })())
    const publish = vi.fn(async () => undefined)
    const bridge = new HarnessRemoteBridge(local({ open }), publish)
    bridge.compactHistoryEnabled = true
    await bridge.openStream({ endpoint: 'hhpi/changes', streamId: 'source-read', payload: { args: { request: { sessionId: 'machine-B/native', epoch: 'source-epoch', version: 3 } } } })
    await vi.waitFor(() => expect(publish).toHaveBeenCalledWith('harness.remote.frame', { streamId: 'source-read', hasValue: true, value: frame }))
    bridge.closeStream({ streamId: 'source-read' })
    await vi.waitFor(() => expect(stopped).toBe(true))
    await expect(bridge.openStream({ endpoint: 'hhpi/operate', streamId: 'bad', payload: {} })).rejects.toMatchObject({ code: 'METHOD_NOT_ALLOWED' })
    await expect(bridge.call({ endpoint: 'hhpi/changes', payload: {} })).rejects.toMatchObject({ code: 'METHOD_NOT_ALLOWED' })
    expect(open).toHaveBeenCalledOnce()
  })

  it.each(['core', 'plugin'])('%s preserves source file bytes across JSON framing and never replays an executed native mutation', async implementation => {
    let executions = 0
    const bytes = Uint8Array.from([0, 255, 16, 10])
    const dispatch = vi.fn(async (endpoint: string) => {
      if (endpoint === 'sourceWorkspace/readBytes') return { ok: true as const, value: { data: null, size: 4 }, attachments: [{ path: ['data'], bytes }] }
      if (endpoint === 'hhpi/nativeCall') { executions++; return { ok: true as const, value: { status: 'accepted' } } }
      return { ok: true as const, value: { status: 'accepted' } }
    })
    const bridge = new HarnessRemoteBridge(local({ dispatch }), vi.fn())
    const rpc = vi.fn(async (_method: string, request: { endpoint: string; payload: unknown }) => {
      const result = await bridge.call(request)
      if (request.endpoint === 'hhpi/nativeCall') throw Object.assign(new Error('Response too large after execution'), { code: 'RESPONSE_TOO_LARGE' })
      return JSON.parse(JSON.stringify(result))
    })
    const core = { rpc } as unknown as RemoteClientCore
    const gateway = new PluginGateway(core)
    const client = implementation === 'core' ? new RemoteTypertGateway(core) : {
      async call(endpoint: string, payload: unknown) {
        const result = await gateway.dispatch(endpoint, payload, new AbortController().signal)
        if (!result.ok) throw result.error
        return result.value
      },
    }
    await expect(client.call('sourceWorkspace/readBytes', { args: { sessionId: 'native-B', path: 'file' } })).resolves.toEqual({ data: bytes, size: 4 })
    const request = { args: { request: { sourceId: 'native-B', operationId: 'stable-operation', method: 'turn/start', params: {} } } }
    await expect(client.call('hhpi/nativeCall', request)).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' })
    expect(executions).toBe(1)
    expect(rpc.mock.calls.every(([method]) => method === 'harness.remote.call')).toBe(true)
    await expect(client.call('hhpi/nativeReceipt', request)).resolves.toEqual({ status: 'accepted' })
    expect(executions).toBe(1)
  })
})
