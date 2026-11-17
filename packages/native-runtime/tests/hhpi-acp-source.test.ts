import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { DirectAcpAdapter, type AcpSourcePort, type AcpSourceSnapshot } from '../src/remote/acp-adapter.ts';
import { sourceSessionId } from '../src/remote/protocol.ts';
import { parseSources, parseSourceWorkspaces } from '../src/remote/config.ts';
import { SourceEventIndex } from '../src/remote/event-index.ts';
import { CodexHistory } from '../src/remote/codex-history.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

test('ACP polling skips unchanged writes, appends only the suffix and retains tool context', async () => {
    const directory = await mkdtemp('/mnt/cache/data-cache/hhpi-acp-poll-');
    const config = { id: 'agy', machineId: 'machine', engine: 'antigravity' as const };
    const sessionId = sourceSessionId({ machineId: 'machine', sourceId: 'agy', engine: 'antigravity', nativeId: 'session' });
    const session = { ...config, nativeId: 'session', id: sessionId, cwd: directory, title: 'Native', updatedAt: 1,
        status: 'idle' as const, activeTurnId: null, capabilities: { send: true, steer: false, cancel: true, approve: false, files: true, images: true }, pendingRequests: [] };
    const fixture = new SourceEventIndex(':memory:', session), history = new CodexHistory(fixture);
    history.beginTurn(session, { id: 'turn', status: 'inProgress' });
    history.acceptItem(session, 'turn', { id: 'tool', type: 'commandExecution', command: 'echo test', cwd: directory, aggregatedOutput: 'test', status: 'completed' }, true);
    const events = fixture.read({ sessionId }).entries as AcpSourceSnapshot['entries'];
    fixture.dispose();
    assert.ok(events && events.length >= 5);
    const snapshot: AcpSourceSnapshot = { nativeId: 'session', cwd: directory, title: 'Native', running: false, updatedAt: 1, entries: events.slice(0, 3) };
    let reads = 0;
    const port: AcpSourcePort = { list: async () => [snapshot], read: async () => { reads++; return structuredClone(snapshot); },
        create: async () => snapshot, call: async () => ({}), close: async () => {} };
    let adapter = new DirectAcpAdapter(config, directory, () => port, true);
    const edit = mock.method(SourceEventIndex.prototype, 'edit');
    const put = mock.method(SourceEventIndex.prototype, 'put');
    const abort = new AbortController();
    try {
        const page = await adapter.read({ sessionId });
        edit.mock.resetCalls(); put.mock.resetCalls();
        const iterator = adapter.changes({ sessionId, epoch: page.epoch, version: page.version }, abort.signal)[Symbol.asyncIterator]();
        const next = iterator.next();
        while (reads < 3) await delay(50);
        assert.equal(edit.mock.callCount(), 0);
        assert.equal(put.mock.callCount(), 0);
        snapshot.entries = events;
        const frame = await next;
        assert.equal(frame.value!.upserts.length, events.length - 3);
        assert.equal(put.mock.callCount(), events.length - 3);
        const resultSequence = events.findIndex(entry => entry.event.type === 'tool/result') + 1;
        const last = await adapter.read({ sessionId, around: resultSequence, limit: 1 });
        assert.deepEqual(last.entries.map(entry => entry.event.type), ['turn/start', 'step/start', 'assistant/message', 'tool/call', 'tool/result']);
        assert.equal(last.context.length, 4);
        abort.abort(); await iterator.return?.().catch(() => undefined);
        const prior = await adapter.read({ sessionId });
        snapshot.entries = structuredClone(events);
        snapshot.entries[2]!.event.time += 1;
        const revised = await adapter.read({ sessionId });
        assert.notEqual(revised.epoch, prior.epoch);
        assert.equal(revised.entries[2]!.event.time, snapshot.entries[2]!.event.time);
        snapshot.title = 'Renamed';
        assert.equal((await adapter.resolve(sessionId)).title, 'Renamed');
        const beforeModels = reads;
        await adapter.nativeAccess.call({ sourceId: 'agy', method: 'session/models', params: { sessionId: 'session' } });
        assert.equal(reads, beforeModels);
        await adapter.dispose();
        const db = new DatabaseSync(join(directory, 'history', `${createHash('sha256').update('session').digest('hex')}.sqlite`));
        try { db.exec("DELETE FROM native_cache WHERE key='acp/dependency-version'; UPDATE events SET dependencies='[]'"); }
        finally { db.close(); }
        adapter = new DirectAcpAdapter(config, directory, () => port, true);
        const migrated = await adapter.read({ sessionId, around: resultSequence, limit: 1 });
        assert.equal(migrated.context.length, 4, 'legacy indexes regain tool dependencies on first refresh');
    } finally { abort.abort(); edit.mock.restore(); put.mock.restore(); await adapter.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('ACP upload forwards supported images with the detected MIME type', async () => {
    const directory = await mkdtemp('/mnt/cache/data-cache/hhpi-acp-upload-');
    const config = { id: 'agy', machineId: 'machine', engine: 'antigravity' as const };
    const sessionId = sourceSessionId({ machineId: 'machine', sourceId: 'agy', engine: 'antigravity', nativeId: 'session' });
    const snapshot: AcpSourceSnapshot = { nativeId: 'session', cwd: directory, title: 'Native', running: false, updatedAt: 1, entries: [] };
    const calls: Array<{ endpoint: string; args: Record<string, unknown> }> = [];
    const port: AcpSourcePort = { list: async () => [snapshot], read: async () => structuredClone(snapshot), create: async () => snapshot,
        call: async (_id, endpoint, args) => { calls.push({ endpoint, args }); return {}; }, close: async () => {} };
    const adapter = new DirectAcpAdapter(config, directory, () => port, true);
    try {
        const cases = [
            { name: 'image.bin', bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2]), mime: 'image/png' },
            { name: 'image.png', bytes: Buffer.from([0xff, 0xd8, 0xff, 1]), mime: 'image/jpeg' },
            { name: 'image.bin', bytes: Buffer.from('GIF89a'), mime: 'image/gif' },
            { name: 'image.bin', bytes: Buffer.from('RIFF0000WEBP'), mime: 'image/webp' },
            { name: 'image.JPEG', bytes: Buffer.from('extension fallback'), mime: 'image/jpeg' },
        ];
        for (const [i, item] of cases.entries()) {
            const data = item.bytes.toString('base64');
            const receipt = await adapter.upload({ sessionId, operationId: `00000000-0000-4000-8000-00000000000${i + 1}`, name: item.name, data });
            await adapter.operate({ sessionId, operationId: `send-image-${i}`, kind: 'send', files: [receipt.receiptId] });
            assert.deepEqual(calls.at(-1)?.args.content, [{ type: 'image', mediaType: item.mime, data }]);
        }
    } finally { await adapter.dispose(); await rm(directory, { recursive: true, force: true }); }
});

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
