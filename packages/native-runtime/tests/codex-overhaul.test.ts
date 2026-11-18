import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectCodexAdapter } from '../src/remote/codex-adapter.ts';
import type { CodexRpc, NativeNotification } from '../src/remote/codex-rpc.ts';
import type { NativeThread } from '../src/remote/codex-native.ts';
import { sourceSessionId, type DirectCodexConfig } from '../src/remote/protocol.ts';

async function fixture(t: TestContext, config: Partial<DirectCodexConfig> = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'codex-overhaul-'));
    let clock = 1_800_000_000_000;
    const threads = new Map<string, NativeThread>([
        ['recent', { id: 'recent', cwd: '/repo', name: 'Recent', createdAt: 1, updatedAt: 2000, status: { type: 'idle' } }],
        ['older', { id: 'older', cwd: '/repo', name: 'Older', createdAt: 1, updatedAt: 1000, status: { type: 'idle' } }],
        ['oldest', { id: 'oldest', cwd: '/repo', name: 'Oldest', createdAt: 1, updatedAt: 500, status: { type: 'idle' } }],
    ]);
    const loaded = new Set<string>(), archived = new Set<string>();
    const calls: Array<{ method: string; params: Record<string, unknown>; write: boolean }> = [];
    const notifications = new Set<(frame: NativeNotification) => void>(), disconnects = new Set<() => void>();
    const rpc = {
        online: true, currentGeneration: 1,
        connect: async () => ({ codexHome: directory, userAgent: 'fixture', platformFamily: 'unix', platformOs: 'linux' }),
        onNotification(listener: (frame: NativeNotification) => void) { notifications.add(listener); return () => { notifications.delete(listener); }; },
        onDisconnect(listener: () => void) { disconnects.add(listener); return () => { disconnects.delete(listener); }; },
        onRequest: () => () => {}, dispose: async () => {},
        async request(method: string, params: Record<string, unknown>, options?: { write?: boolean }) {
            calls.push({ method, params: structuredClone(params), write: options?.write === true });
            if (method === 'thread/loaded/list') return { data: [...loaded], nextCursor: null };
            if (method === 'thread/list') {
                const ids = params.archived ? [...archived] : params.cursor ? ['oldest'] : ['recent', 'older'];
                return { data: ids.filter(id => params.archived || !archived.has(id)).map(id => threads.get(id)!),
                    nextCursor: params.archived || params.cursor ? null : 'tail' };
            }
            if (method === 'thread/read') return { thread: threads.get(String(params.threadId))! };
            if (method === 'thread/resume') { loaded.add(String(params.threadId)); return { thread: threads.get(String(params.threadId))! }; }
            if (method === 'thread/archive') { archived.add(String(params.threadId)); return {}; }
            if (method === 'thread/unarchive') { archived.delete(String(params.threadId)); return {}; }
            if (method === 'thread/settings/update' || method === 'turn/start' || method === 'review/start' || method === 'thread/compact/start'
                || method === 'turn/steer' || method === 'turn/interrupt') return {};
            throw new Error(`Unexpected native method ${method}`);
        },
    };
    const adapter = new DirectCodexAdapter({ id: 'source', machineId: 'machine', engine: 'codex', ...config }, join(directory, 'adapter'), {
        rpc: rpc as unknown as CodexRpc, now: () => clock, pollMs: 60_000,
        readMetadata: async () => { throw new Error('These controls must not hydrate history.'); },
    });
    t.after(async () => { await adapter.dispose(); await rm(directory, { recursive: true, force: true }); });
    let operation = 0;
    return { adapter, rpc, threads, loaded, archived, calls,
        advance(ms: number) { clock += ms; },
        notify(method: string, params: Record<string, unknown>) { for (const listener of notifications) listener({ method, params }); },
        disconnect() { rpc.currentGeneration++; for (const listener of disconnects) listener(); },
        write(method: string, threadId = 'recent') { return adapter.nativeAccess.call({ sourceId: 'source', method,
            operationId: `operation-${++operation}`, params: { threadId, effort: 'high' } }); },
        writes() { return calls.filter(call => call.write); },
    };
}

test('cold settings acquire the original exclusive or native-locked owner exactly once', async t => {
    for (const config of [{ ownership: 'exclusive' }, { ownership: 'shared', writerLock: 'native' }] as const) {
        const f = await fixture(t, config);
        assert.equal((await f.write('thread/settings/update')).status, 'accepted');
        assert.deepEqual(f.writes().map(call => [call.method, call.params]), [
            ['thread/resume', { threadId: 'recent', excludeTurns: true }],
            ['thread/settings/update', { threadId: 'recent', effort: 'high' }],
        ]);
        assert.equal((await f.write('thread/settings/update')).status, 'accepted');
        assert.equal(f.calls.filter(call => call.method === 'thread/resume').length, 1);
        assert.equal(f.calls.filter(call => call.method === 'thread/loaded/list').length, 1);
    }
});

test('shared cold settings without native writer locking reject before resume or update', async t => {
    const f = await fixture(t, { ownership: 'shared' });
    assert.equal((await f.write('thread/settings/update')).status, 'rejected');
    assert.deepEqual(f.writes(), []);
});

test('explicit turn, review and compaction can resume; idle steer and interrupt cannot', async t => {
    for (const method of ['turn/start', 'review/start', 'thread/compact/start', 'turn/steer', 'turn/interrupt']) {
        const f = await fixture(t, { ownership: 'exclusive' });
        const continuation = !['turn/steer', 'turn/interrupt'].includes(method);
        assert.equal((await f.write(method)).status, continuation ? 'accepted' : 'rejected', method);
        assert.deepEqual(f.writes().map(call => call.method), continuation ? ['thread/resume', method] : [], method);
    }
});

test('loaded checks expire after ten seconds and close/disconnect invalidate cached execution', async t => {
    const f = await fixture(t, { ownership: 'exclusive' });
    await f.write('thread/settings/update');
    f.advance(10_000);
    await f.write('thread/settings/update');
    assert.equal(f.calls.filter(call => call.method === 'thread/loaded/list').length, 2);
    f.loaded.clear();
    f.notify('thread/closed', { threadId: 'recent' });
    assert.equal((await f.write('turn/interrupt')).status, 'rejected');
    assert.equal(f.calls.filter(call => call.method === 'thread/resume').length, 1);
    f.notify('thread/started', { thread: f.threads.get('recent')! });
    f.loaded.add('recent');
    assert.equal((await f.write('turn/interrupt')).status, 'accepted');
    f.disconnect();
    assert.equal((await f.write('thread/settings/update')).status, 'accepted');
    assert.equal(f.calls.filter(call => call.method === 'thread/resume').length, 2, 'new generations must join again');
});

test('incremental catalog stops at the first old page and preserves untouched older sessions', async t => {
    const f = await fixture(t);
    assert.equal((await f.adapter.list()).length, 3);
    const before = f.calls.length;
    f.advance(20_000);
    f.threads.get('recent')!.updatedAt = 2020;
    const rows = await f.adapter.list();
    assert.deepEqual(rows.map(row => row.nativeId).sort(), ['older', 'oldest', 'recent']);
    assert.equal(rows.find(row => row.nativeId === 'oldest')!.connection!.state, 'online');
    assert.deepEqual(f.calls.slice(before).map(call => call.method), ['thread/loaded/list', 'thread/list']);
    assert.equal(rows.find(row => row.nativeId === 'recent')!.updatedAt, 2_020_000);
    f.advance(300_000);
    const fullAt = f.calls.length;
    await f.adapter.list();
    assert.equal(f.calls.slice(fullAt).filter(call => call.method === 'thread/list').length, 2);
});

test('incremental cutoff uses the previous watermark and its full sixty-second margin', async t => {
    const f = await fixture(t);
    f.threads.get('older')!.updatedAt = 1970;
    await f.adapter.list();
    f.advance(20_000);
    f.threads.get('recent')!.updatedAt = 2100;
    const before = f.calls.length;
    await f.adapter.list();
    assert.equal(f.calls.slice(before).filter(call => call.method === 'thread/list').length, 2);
});

test('incremental loaded discovery reads unknown IDs and never publishes ephemeral sessions', async t => {
    const f = await fixture(t);
    await f.adapter.list();
    for (const [id, ephemeral] of [['loaded-only', false], ['ephemeral', true]] as const) {
        f.threads.set(id, { ...f.threads.get('recent')!, id, ephemeral }); f.loaded.add(id);
    }
    f.advance(20_000);
    const before = f.calls.length;
    const rows = await f.adapter.list();
    assert.ok(rows.some(row => row.nativeId === 'loaded-only'));
    assert.ok(!rows.some(row => row.nativeId === 'ephemeral'));
    assert.deepEqual(f.calls.slice(before).filter(call => call.method === 'thread/read').map(call => call.params.threadId), ['loaded-only', 'ephemeral']);
});

test('incremental omissions check disappeared loaded threads without probing retained cold rows', async t => {
    const f = await fixture(t);
    f.loaded.add('oldest');
    await f.adapter.list();
    f.loaded.clear(); f.archived.add('oldest');
    f.advance(20_000);
    const before = f.calls.length;
    assert.deepEqual((await f.adapter.list()).map(row => row.nativeId).sort(), ['older', 'recent']);
    assert.deepEqual(f.calls.slice(before).filter(call => call.params.archived).map(call => call.method), ['thread/list']);
    assert.equal(f.calls.slice(before).filter(call => call.method === 'thread/read').length, 0);
});

test('archive/unarchive calls and notifications force full scans; disconnect resets the watermark', async t => {
    const f = await fixture(t);
    await f.adapter.list();
    for (const action of [
        () => f.write('thread/archive', 'oldest'),
        () => f.write('thread/unarchive', 'oldest'),
        () => f.notify('thread/archived', { threadId: 'oldest' }),
        () => f.notify('thread/unarchived', { threadId: 'oldest' }),
        () => f.disconnect(),
    ]) {
        await action(); f.advance(20_000);
        const before = f.calls.length;
        await f.adapter.list();
        assert.equal(f.calls.slice(before).filter(call => call.method === 'thread/list' && !call.params.archived).length, 2);
    }
    const id = sourceSessionId({ machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId: 'oldest' });
    assert.equal((await f.adapter.resolve(id)).nativeId, 'oldest');
});
