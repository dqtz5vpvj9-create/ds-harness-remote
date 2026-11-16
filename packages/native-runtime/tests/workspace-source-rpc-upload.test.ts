import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceWorkspaceFixture } from './fixtures/source-workspace.ts';
import { SOURCE_UPLOAD_CHUNK_BYTES } from '../src/shared/source-upload.ts';

test('encrypted-carrier upload entry preserves source ownership, bounds, exact offsets and owner admission', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remote-upload-rpc-'));
    const source = await sourceWorkspaceFixture(directory);
    try {
        const target = { hostId: 'local', sessionId: source.sessionId };
        const transfer = await source.invoke('beginUpload', { target, operationId: 'upload-one', bytes: 6,
            destination: { kind: 'file', path: 'binary.dat', baseline: { kind: 'absent' } }, mimeType: 'application/octet-stream' }) as { uploadId: string };
        const request = { target, uploadId: transfer.uploadId }, chunk = { ...request, offset: 0, data: Buffer.from([0, 128, 255]).toString('base64') };
        await assert.rejects(source.invoke('appendUpload', chunk, undefined, true), 'a method grant must not bypass owner-only uploads');
        await assert.rejects(source.invoke('appendUpload', { ...chunk, target: { ...target, hostId: 'other' } }));
        await assert.rejects(source.invoke('appendUpload', { ...chunk, target: { ...target, sessionId: 'hhpi:other:native:codex:same-thread' } }));
        for (const data of ['AB==', '!!!!', '', Buffer.alloc(SOURCE_UPLOAD_CHUNK_BYTES + 1).toString('base64')]) {
            await assert.rejects(source.invoke('appendUpload', { ...chunk, data }));
        }
        assert.deepEqual(await source.invoke('appendUpload', chunk), { receivedBytes: 3 });
        await assert.rejects(source.invoke('appendUpload', chunk), 'lost responses never authorize replaying a previous offset');
        const status = await source.invoke('uploadStatus', request) as { transfer: { receivedBytes: number } };
        assert.equal(status.transfer.receivedBytes, 3);
        assert.deepEqual(await source.invoke('appendUpload', { ...chunk, offset: 3 }), { receivedBytes: 6 });
    } finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
});
