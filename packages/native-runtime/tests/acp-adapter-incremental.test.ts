import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { AcpSourceSnapshot } from '../src/remote/acp-adapter.ts';
import { sourceSessionId } from '../src/remote/protocol.ts';
let DirectAcpAdapter: typeof import('../src/remote/acp-adapter.ts').DirectAcpAdapter;
before(async () => {
    // Native strip-only TS cannot load the runtime's parameter properties.
    const { tsImport } = await import('tsx/esm/api');
    ({ DirectAcpAdapter } = await tsImport('../src/remote/acp-adapter.ts', import.meta.url));
});

function entry(seq: number, turn = seq + 1) {
    return { type: 'event', event: Object.freeze({ type: 'turn/start' as const, seq, time: 1, data: Object.freeze({ turn }) }) } as const;
}

async function fixture(t: TestContext, nativeId: string) {
    const directory = await mkdtemp(join(tmpdir(), 'acp-incremental-'));
    const config = { id: 'agy', machineId: 'test', engine: 'antigravity' as const };
    const sessionId = sourceSessionId({ machineId: config.machineId, sourceId: config.id, engine: config.engine, nativeId });
    const value: AcpSourceSnapshot = { nativeId, cwd: directory, updatedAt: 1, title: 'Child', running: false, entries: [entry(0)] };
    let reads = 0;
    const adapter = new DirectAcpAdapter(config, directory, () => ({
        list: async () => [value], read: async () => { reads++; return value; },
        call: async () => undefined, close: async () => {}, create: async () => value,
    }), true);
    t.after(async () => { await adapter.dispose(); await rm(directory, { recursive: true, force: true }); });
    return { adapter, value, directory, sessionId, reads: () => reads };
}

test('retains lineage with and without a model selection and detects an interior rewrite', async t => {
    const { adapter, value, sessionId } = await fixture(t, 'child');
    value.entries = Array.from({ length: 3000 }, (_, i) => entry(i));
    value.parentNativeId = 'parent';
    value.agentRole = 'UX auditor';
    const lineage = { parentNativeId: 'parent', agentRole: 'UX auditor' };
    assert.deepEqual((await adapter.list())[0]!.agent, { provider: 'antigravity', model: '', ...lineage });
    value.selection = { provider: 'antigravity', model: 'selected', reasoningEffort: 'high' };
    const before = await adapter.read({ sessionId, limit: 1 });
    assert.deepEqual(before.session.agent, { ...value.selection, ...lineage });

    // The discriminator is read once per row in the real prefix comparison.
    // Time its first through last row separately from the database page read.
    let started = 0;
    const comparisons: number[] = [];
    Object.defineProperty(value.entries[0]!, 'type', { enumerable: true, get() { started = performance.now(); return 'event'; } });
    Object.defineProperty(value.entries.at(-1)!, 'type', { enumerable: true, get() { comparisons.push(performance.now() - started); return 'event'; } });
    for (let i = 0; i < 25; ++i) await adapter.resolve(sessionId);
    const warmSamples = comparisons.slice(-15).sort((a, b) => a - b);
    t.diagnostic(`3,000-event warm prefix comparison median ${warmSamples[7]!.toFixed(3)} ms`);

    const stringify = t.mock.method(JSON, 'stringify');
    const warm = await adapter.read({ sessionId, limit: 1 });
    assert.equal(warm.version, before.version);
    assert.equal(stringify.mock.calls.filter(c => c.arguments[0]?.type === 'turn/start').length, 0);
    // An equivalent new object receives a fingerprint once. A fresh rewrite at
    // the same interior index must invalidate the reader despite identical ends.
    value.entries[1499] = entry(1499);
    assert.equal((await adapter.read({ sessionId, limit: 1 })).version, before.version);
    stringify.mock.resetCalls();
    assert.equal((await adapter.read({ sessionId, limit: 1 })).version, before.version);
    assert.equal(stringify.mock.calls.filter(c => c.arguments[0]?.type === 'turn/start').length, 0);
    stringify.mock.restore();
    value.entries[1499] = entry(1499, 9001);
    const changed = await adapter.read({ sessionId, around: 1500, limit: 3 });
    assert.ok(changed.version > before.version);
    assert.ok(changed.entries.some(row => row.event.type === 'turn/start' && row.event.data.turn === 9001));
    const mutable = { turn: 42 };
    value.entries[1499] = { type: 'event', event: Object.freeze({ ...entry(1499).event, data: mutable }) };
    await adapter.resolve(sessionId);
    mutable.turn = 9002;
    const mutated = await adapter.read({ sessionId, around: 1500, limit: 3 });
    assert.ok(mutated.entries.some(row => row.event.type === 'turn/start' && row.event.data.turn === 9002));
});

for (const local of ['watched', 'missing', 'symlink'] as const) {
    test(`changes receives appends with ${local} logs and stops on abort`, { timeout: 5000 }, async t => {
        const { adapter, value, directory, sessionId, reads } = await fixture(t, 'child');
        const original = process.env.HOME, originalWindows = process.env.USERPROFILE;
        process.env.HOME = process.env.USERPROFILE = directory;
        t.after(() => {
            if (original === undefined) delete process.env.HOME; else process.env.HOME = original;
            if (originalWindows === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalWindows;
        });
        const parent = join(directory, '.gemini/antigravity-cli/brain/child/.system_generated');
        const logs = join(parent, 'logs');
        await mkdir(parent, { recursive: true });
        if (local === 'watched') await mkdir(logs);
        if (local === 'symlink') await symlink(directory, logs, process.platform === 'win32' ? 'junction' : 'dir');
        const baseline = await adapter.read({ sessionId });
        const abort = new AbortController();
        const stream = adapter.changes({ sessionId, epoch: baseline.epoch, version: baseline.version }, abort.signal);
        const next = stream.next();
        try {
            while (reads() < 2) await delay(2);
            await delay(10);
            value.entries!.push(entry(1));
            const start = performance.now();
            if (local !== 'missing') {
                for (let i = 0; i < 3; ++i) await appendFile(join(logs, 'transcript.jsonl'), '\n');
            }
            const frame = await next;
            const elapsed = performance.now() - start;
            assert.equal(frame.value?.upserts.length, 1);
            if (local === 'watched') {
                assert.ok(elapsed < 600, `expected an fs.watch refresh before the fallback timer, got ${elapsed} ms`);
                t.diagnostic(`watch to change frame ${elapsed.toFixed(1)} ms`);
            } else assert.ok(elapsed >= 600);
            assert.equal(reads(), 3);
        } finally {
            abort.abort();
            await stream.return(undefined);
        }
        const final = reads();
        if (local === 'watched') await appendFile(join(logs, 'transcript_full.jsonl'), '\n');
        await delay(100);
        assert.equal(reads(), final);
    });
}

test('resume context identifies the native Antigravity conversation and its host directory', async t => {
    const { adapter, sessionId, directory } = await fixture(t, 'resume-child');
    const { sourceResumeContext } = await import('../src/workspace/source-navigation-api.ts');
    const context = await adapter.resumeContext(sessionId, new AbortController().signal);
    assert.deepEqual(sourceResumeContext.parse(context), {
        sessionId, machineId: 'test', sourceId: 'agy', engine: 'antigravity', nativeId: 'resume-child',
        cwd: directory, platformOs: process.platform === 'win32' ? 'windows'
            : process.platform === 'darwin' ? 'macos' : process.platform,
        platformFamily: process.platform === 'win32' ? 'windows' : 'unix',
    });
});
