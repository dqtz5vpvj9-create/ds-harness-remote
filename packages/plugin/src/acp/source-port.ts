import { AgentAcpClient } from '@dsh-remote/client-core'
import type { RemoteClientCore } from '@dsh-remote/client-core'
import type { EventPayload } from '@dsh-remote/protocol'
import type { AcpPeerBridge, PublishAcpFrame } from './peer-bridge.js'
import { AcpVirtualHarness } from './virtual-harness.js'

/** An independent local owner peer; no global active-host or publisher slot. */
export function createAcpSourcePort(createPeer: (publish: PublishAcpFrame) => AcpPeerBridge,
  host: { deviceId: string; name: string }, backend: 'antigravity') {
  const listeners = new Set<(event: EventPayload) => void>()
  const peer = createPeer(async (event, data) => {
    for (const listener of listeners) listener({ event, data } as EventPayload)
  })
  const core: Pick<RemoteClientCore, 'rpc' | 'onEvent'> = {
    onEvent(handler) { listeners.add(handler); return () => { listeners.delete(handler) } },
    async rpc<T>(method: string, input: unknown, signal?: AbortSignal): Promise<T> {
      signal?.throwIfAborted()
      let result: unknown
      switch (method) {
        case 'agent.acp.call': result = await peer.call(input); break
        case 'agent.acp.respond': result = await peer.respond(input); break
        case 'agent.acp.stream.open': result = await peer.openStream(input); break
        case 'agent.acp.stream.close': result = await peer.closeStream(input); break
        case 'agent.acp.transfer.open': result = peer.openTransfer(input); break
        case 'agent.acp.transfer.chunk': result = peer.appendTransfer(input); break
        case 'agent.acp.transfer.commit': result = await peer.commitTransfer(input); break
        case 'agent.acp.transfer.read': result = peer.readTransfer(input); break
        case 'agent.acp.transfer.close': result = peer.closeTransfer(input); break
        default: throw new Error('Unsupported local ACP transport method.')
      }
      // Cancellation after a write is not evidence that the native write failed.
      return result as T
    },
  }
  const facade = new AcpVirtualHarness(new AgentAcpClient(core, ['agent.acp.antigravity.model-load.v1']), host, backend)
  return {
    list: () => facade.sourceCatalog(),
    read: (nativeId: string) => facade.sourceSnapshot(nativeId),
    create: (cwd: string, signal: AbortSignal) => facade.sourceCreate(cwd, signal),
    call: (nativeId: string, endpoint: string, args: Record<string, unknown>, signal: AbortSignal) => facade.sourceCall(nativeId, endpoint, args, signal),
    async close() { await facade.close(); await peer.closeAll(); listeners.clear() },
  }
}
