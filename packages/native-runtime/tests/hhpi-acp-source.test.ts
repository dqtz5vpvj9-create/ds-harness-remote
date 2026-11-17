import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { DirectAcpAdapter, type AcpSourcePort, type AcpSourceSnapshot } from '../src/remote/acp-adapter.ts';
import { sourceSessionId } from '../src/remote/protocol.ts';
import { parseSources, parseSourceWorkspaces } from '../src/remote/config.ts';

test('ACP source preserves history, source identity and write receipts across restart', async () => {
    const directory = await mkdtemp('/mnt/cache/data-cache/hhpi-acp-contract-');
    const config = { id: 'agy', machineId: 'windows', engine: 'antigravity' as const };
    const sessionId = sourceSessionId({ machineId: 'windows', sourceId: 'agy', engine: 'antigravity', nativeId: 'session' });
    let dispatches = 0, unavailable = false;
    const snapshot: AcpSourceSnapshot = { nativeId: 'session', cwd: directory, title: 'Native', running: false, updatedAt: 1,
        entries: [{ type: 'event', event: { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } } as never] };
    const port: AcpSourcePort = { list: async () => [snapshot], read: async () => {
        if (unavailable) throw new Error('HISTORY_UNAVAILABLE'); return structuredClone(snapshot);
    }, create: async () => snapshot, call: async () => { dispatches++; return { accepted: true }; }, close: async () => {} };
    let adapter = new DirectAcpAdapter(config, directory, () => port, true);
    try {
        assert.deepEqual(parseSources([config]), [config]);
        assert.equal(parseSourceWorkspaces([{ sourceId: 'agy', provider: 'local-system' }], [config]).length, 1);
        const page = await adapter.read({ sessionId });
        assert.equal(page.entries.length, 1);
        const operation = { sessionId, operationId: 'send-one', kind: 'send' as const, text: 'hello' };
        assert.equal((await adapter.operate(operation)).status, 'accepted');
        assert.equal((await adapter.operate(operation)).status, 'accepted');
        assert.equal(dispatches, 1);
        await assert.rejects(adapter.operate({ ...operation, text: 'different' }), /reused/);
        await adapter.dispose();
        adapter = new DirectAcpAdapter(config, directory, () => port, true);
        assert.equal((await adapter.receipt(operation))?.status, 'accepted');
        assert.equal((await adapter.operate(operation)).status, 'accepted');
        assert.equal(dispatches, 1);
        unavailable = true;
        await assert.rejects(adapter.read({ sessionId }), /HISTORY_UNAVAILABLE/);
        unavailable = false;
        assert.deepEqual((await adapter.read({ sessionId })).entries, page.entries);
        await assert.rejects(adapter.resolve(sessionId.replace(':windows:', ':other:')), /another native source/);
        await assert.rejects(adapter.nativeAccess.call({ sourceId: 'agy', method: 'turn/start', params: {} }), /not supported/);
    } finally { await adapter.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('a native source plugin can discover an optional Remote sibling service', async () => {
    const { Context } = await import('@deepseek-ai/cordis');
    const { default: TypertRegistry } = await import('@deepseek-ai/dsh-typert-registry');
    const { default: RemoteAccessService } = await import('@deepseek-ai/dsh-api-remote-access');
    const { installSources } = await import('../src/remote/service.ts');
    const ctx = new Context();
    const directory = await mkdtemp('/mnt/cache/data-cache/hhpi-acp-cordis-');
    let reads = 0;
    try {
        await ctx.plugin(TypertRegistry); new RemoteAccessService(ctx);
        await ctx.plugin({ name: 'remote-fixture', apply(scope: InstanceType<typeof Context>) {
            scope.provide('dshRemote', { createAcpSourcePort() { return {
                list: async () => { reads++; return [{ nativeId: 'native', cwd: directory, title: 'Native', updatedAt: 1, running: false }]; },
                close: async () => {},
            }; } });
        } });
        let source: ReturnType<typeof installSources> | undefined;
        await ctx.plugin({ name: 'native-fixture', inject: ['typert', 'remoteAccess'], apply(scope: InstanceType<typeof Context>) {
            source = installSources(scope, [{ id: 'agy', machineId: 'machine', engine: 'antigravity' }], directory);
        } });
        assert.ok(source);
        const catalog = await source.catalog(() => true);
        assert.equal(catalog.sources[0]?.online, true);
        assert.equal(catalog.sessions[0]?.nativeId, 'native');
        assert.equal(reads, 1);
    } finally { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); }
});
