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
