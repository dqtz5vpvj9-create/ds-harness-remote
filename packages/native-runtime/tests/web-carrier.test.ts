import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { WebSourceCarrier } from '../src/web/carrier.ts';
import { connectWeb } from '../src/web/client.ts';
import { CHUNK_BYTES, type FederationFrame } from '../src/web/protocol.ts';
import { WebPeer } from '../src/web/peer.ts';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
test('full Web carrier preserves large uploads, streaming bytes and binary WebSockets over bounded Remote packets', async () => {
    let writes = 0, accepted = 0;
    const server = createServer(async (req, res) => {
        if (req.url === '/login') { res.writeHead(303, { 'set-cookie': 'dsh-auth-test=owner; HttpOnly', location: '/' }); res.end(); return; }
        if (req.headers.cookie !== 'dsh-auth-test=owner') { res.writeHead(401); res.end(); return; }
        if (req.url !== '/api/upload') { res.writeHead(404); res.end(); return; }
        accepted++;
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        for await (const bytes of req) { writes++; res.write(bytes); }
        res.end();
    });
    const ws = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
        if (req.headers.cookie !== 'dsh-auth-test=owner') { socket.destroy(); return; }
        ws.handleUpgrade(req, socket, head, client => client.on('message', (bytes, binary) => client.send(bytes, { binary })));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const source = new WebSourceCarrier({ origin, authenticatedUrl: () => `${origin}/login` }, { version: 'pinned' });
    const lifetime = new AbortController();
    const received: FederationFrame[] = [];
    let complete!: () => void, socketReady!: () => void, socketEcho!: () => void;
    const finished = new Promise<void>(resolve => { complete = resolve; });
    const ready = new Promise<void>(resolve => { socketReady = resolve; });
    const echo = new Promise<void>(resolve => { socketEcho = resolve; });
    let maxPacket = 0;
    const peer = await connectWeb({
        async call(input) {
            const packet = (input as { packet?: { data: string } }).packet;
            if (packet) maxPacket = Math.max(maxPacket, packet.data.length);
            return source.call(input);
        }, onClose: () => () => {},
    }, { signal: lifetime.signal, validateIdentity: value => JSON.stringify(value) === '{"version":"pinned"}',
        receive(frame) {
            received.push(frame);
            if (frame.type === 'http-end') complete();
            if (frame.type === 'ws-ready') socketReady();
            if (frame.type === 'data' && frame.lane === 'socket') socketEcho();
        }, ended() {} });
    try {
        const body = Buffer.alloc(3 * 1024 * 1024 + 17, 123);
        await peer.send({ type: 'http-open', id: 'upload', method: 'POST', path: '/api/upload', headers: [['content-length', String(body.length)]] });
        for (let at = 0; at < body.length; at += CHUNK_BYTES) await peer.sendData('upload', 'request', body.subarray(at, at + CHUNK_BYTES));
        await peer.send({ type: 'http-end', id: 'upload', lane: 'request' });
        await finished;
        const result = Buffer.concat(received.filter(f => f.type === 'data' && f.lane === 'response').map(f => Buffer.from((f as Extract<FederationFrame, { type: 'data' }>).data, 'base64')));
        assert.equal(hash(result), hash(body)); assert.equal(accepted, 1); assert.ok(writes > 1);
        await peer.send({ type: 'ws-open', id: 'socket', path: '/api/remote.mux', protocols: [] });
        await ready;
        const binary = Buffer.alloc(5 * 1024 * 1024 + 1, 73);
        await peer.sendData('socket', 'socket', binary, true); await echo;
        const returned = received.find(f => f.type === 'data' && f.lane === 'socket') as Extract<FederationFrame, { type: 'data' }>;
        assert.equal(returned.binary, true); assert.equal(hash(Buffer.from(returned.data, 'base64')), hash(binary));
        assert.ok(maxPacket <= Math.ceil(CHUNK_BYTES / 3) * 4);
        lifetime.abort();
        assert.equal(peer.isOpen, false);
        await assert.rejects(peer.send({ type: 'http-end', id: 'upload', lane: 'request' }));
        assert.equal(accepted, 1);
    } finally {
        lifetime.abort(); source.close(); for (const client of ws.clients) client.terminate(); ws.close();
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
});

test('out-of-order packets fail closed and are never delivered', async () => {
    let received = 0, ended = 0;
    const peer = new WebPeer(() => { received++; }, () => { ended++; });
    await assert.rejects(peer.write({ sequence: 2, data: '', final: true }), /Invalid Web packet/);
    assert.equal(received, 0); assert.equal(ended, 1); assert.equal(peer.isOpen, false);
});
