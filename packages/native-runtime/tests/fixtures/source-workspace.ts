/** Actual Typert policy, source filesystem, durable uploads and attachment store.
 * Only native session discovery is synthetic; no Agent/provider is started. */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Registry from '@deepseek-ai/dsh-typert-registry';
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access';
import Gateway from '@deepseek-ai/dsh-api-gateway';
import { RemoteError, type PeerId, type PeerScope, type Principal } from '@deepseek-ai/dsh-typert-protocol';
import { SessionId } from '@deepseek-ai/dsh-session';
import { SourceGateway } from '../../src/remote/gateway.ts';
import { sourceSessionId, type SourceAdapter, type SourceSession } from '../../src/remote/protocol.ts';
import { SourceWorkspaceService, registerSourceContract } from '../../src/remote/service.ts';
import { installLocalSourceWorkspaces } from '../../src/workspace/local-source.ts';

declare module '@deepseek-ai/dsh-typert-protocol' { interface PrincipalMap { 'upload-reader': { kind: 'upload-reader' } } }
export interface SourceWorkspaceFixture {
    sessionId: string;
    root: string;
    receipts: string;
    invoke(method: string, request: unknown, signal?: AbortSignal, reader?: boolean): Promise<unknown>;
    dispatch(endpoint: string, payload: unknown, signal: AbortSignal): Promise<
        { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }>;
    close(): Promise<void>;
}
export async function sourceWorkspaceFixture(directory: string, machineId = 'machine-a'): Promise<SourceWorkspaceFixture> {
    const root = join(directory, 'workspace'), receipts = join(directory, 'receipts');
    await mkdir(root, { recursive: true });
    const config = { id: 'native', machineId, engine: 'codex' as const };
    const identity = { sourceId: config.id, machineId, engine: config.engine, nativeId: 'same-thread' };
    const session: SourceSession = { ...identity, id: sourceSessionId(identity), title: 'Synthetic', cwd: root,
        updatedAt: 1, status: 'idle', activeTurnId: null, pendingRequests: [],
        capabilities: { send: false, steer: false, cancel: false, approve: false, files: true } };
    const adapter: SourceAdapter = { id: config.id, machineId, engine: config.engine,
        async list() { return [session]; }, async resolve(id) { if (id !== session.id) throw new Error('Wrong source'); return session; },
        async read() { throw new Error('No native history required'); }, async *changes() {},
        async operate() { throw new Error('No native execution allowed'); }, dispose() {} };
    const ctx = new Context(), sources = new SourceGateway([adapter]), lifetime = new AbortController();
    try {
        await ctx.plugin(Registry);
        const access = new RemoteAccess(ctx); registerSourceContract(ctx);
        access.registerPolicy('upload-reader', { bindings: () => [{ resource: { kind: 'session', id: SessionId(session.id) },
            role: { name: 'Explicit upload test grant', resource: 'session', actions: ['sourceWorkspace/appendUpload'] } }] });
        new SourceWorkspaceService(ctx, sources, { localHostId: 'local', scopeId: directory });
        const gateway = new Gateway(ctx, Gateway.Config({}));
        installLocalSourceWorkspaces(ctx, sources, [config], [{ sourceId: config.id, provider: 'local-system' }], directory, new Map([[config.id, receipts]]));
        const peer = (reader = false): PeerScope => ({ id: 'upload-fixture' as PeerId, ctx,
            principal: (reader ? { kind: 'upload-reader' } : { kind: 'owner' }) as Principal,
            interactions: 'answer', signal: lifetime.signal, async dispose() {} });
        const invoke = (method: string, request: unknown, signal?: AbortSignal, reader = false) =>
            gateway.invoke({ peer: peer(reader), namespace: 'sourceWorkspace', method, args: { request }, ...(signal ? { signal } : {}) });
        return { sessionId: session.id, root, receipts, invoke,
            async dispatch(endpoint, payload, signal) {
                try {
                    const [namespace, method] = endpoint.split('/');
                    const value = await gateway.invoke({ namespace: namespace!, method: method!,
                        args: (payload as { args: Record<string, unknown> }).args, peer: peer(), signal });
                    return { ok: true, value };
                } catch (error) {
                    if (!(error instanceof RemoteError)) throw error;
                    return { ok: false, error: { code: error.code, message: error.message, details: error.details as Record<string, unknown> } };
                }
            },
            async close() { lifetime.abort(); await sources.dispose(); await ctx.fiber.dispose(); },
        };
    } catch (error) { lifetime.abort(); await sources.dispose(); await ctx.fiber.dispose(); throw error; }
}
