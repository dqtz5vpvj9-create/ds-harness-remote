// SPDX-License-Identifier: AGPL-3.0-only
// Extracted from HHPI runner/client.ts. Remote owns transport; DSH owns execution.
import { request as httpRequest, type ClientRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import WebSocket, { type RawData } from 'ws';
import { CHUNK_BYTES, MAX_CHANNELS, MAX_SOCKET_BYTES, filterHeaders, safeSocketClose, validateUpstreamPath, type FederationFrame, type WireHeaders, type DataLane } from './protocol.ts';
export interface WebTransport {
    readonly isOpen: boolean;
    send(frame: FederationFrame): Promise<void>;
    sendData(id: string, lane: DataLane, data: Buffer, binary?: boolean): Promise<void>;
    close(code?: number): void;
}
function bytes(data: RawData): Buffer {
    return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
}
interface HttpRequestState { opening: Promise<ClientRequest>; abort: AbortController; done: boolean }
interface SocketState { socket?: WebSocket; cancelled: boolean; queue: Promise<void> }
export interface WebSourceOptions {
    origin: string;
    authenticatedUrl(origin: string): string;
}
export class WebSource {
    private readonly lifetime = new AbortController();
    private readonly requests = new Map<string, HttpRequestState>();
    private readonly sockets = new Map<string, SocketState>();
    private cookie?: { value: string; expiresAt: number };
    private cookieRequest?: Promise<string>;
    constructor(private readonly options: WebSourceOptions) {
        const origin = new URL(options.origin);
        if (origin.hostname !== '127.0.0.1' || !['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' || origin.username || origin.password) {
            throw new Error('Web transport requires the official loopback DSH origin');
        }
    }
    private async credential(): Promise<string> {
        if (this.cookie && this.cookie.expiresAt > Date.now() + 60_000) return this.cookie.value;
        if (this.cookieRequest) return this.cookieRequest;
        this.cookieRequest = (async () => {
            const response = await fetch(this.options.authenticatedUrl(this.options.origin), { redirect: 'manual', signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(10_000)]) });
            await response.body?.cancel();
            const cookies = response.headers.getSetCookie();
            const value = cookies.filter((cookie) => cookie.startsWith('dsh-auth-')).map((cookie) => cookie.split(';')[0]).join('; ');
            if (response.status !== 303 || !value) throw new Error('Official DSH browser credential exchange failed');
            // Refresh daily, earlier than the official default absolute lifetime; no failed mutation is replayed.
            this.cookie = { value, expiresAt: Date.now() + 24 * 60 * 60 * 1000 };
            return value;
        })();
        try { return await this.cookieRequest; }
        finally { delete this.cookieRequest; }
    }

    async receive(tunnel: WebTransport, frame: FederationFrame): Promise<void> {
        if (!('id' in frame)) { tunnel.close(1002); return; }
        if (frame.type === 'http-open') {
            if (this.requests.has(frame.id) || this.sockets.has(frame.id)) { tunnel.close(1002); return; }
            if (this.requests.size + this.sockets.size >= MAX_CHANNELS) {
                await tunnel.send({ type: 'http-error', id: frame.id, code: 'limit-exceeded' }); return;
            }
            this.openHttp(tunnel, frame);
        } else if (frame.type === 'data' && frame.lane === 'request') {
            const state = this.requests.get(frame.id);
            if (!state || state.abort.signal.aborted) return;
            try {
                const request = await state.opening;
                if (!state.abort.signal.aborted) await new Promise<void>((resolve, reject) => request.write(Buffer.from(frame.data, 'base64'), (error) => error ? reject(error) : resolve()));
            } catch { /* The opener owns the HTTP failure frame; late request bytes are discarded. */ }
        } else if (frame.type === 'http-end' && frame.lane === 'request') {
            const state = this.requests.get(frame.id);
            if (state && !state.abort.signal.aborted) {
                try { (await state.opening).end(); } catch { /* The opener already reported failure. */ }
            }
        } else if (frame.type === 'http-cancel') {
            const state = this.requests.get(frame.id);
            this.requests.delete(frame.id);
            state?.abort.abort();
        } else if (frame.type === 'ws-open') {
            if (this.requests.has(frame.id) || this.sockets.has(frame.id)) { tunnel.close(1002); return; }
            if (this.requests.size + this.sockets.size >= MAX_CHANNELS) {
                await tunnel.send({ type: 'ws-close', id: frame.id, code: 1013, reason: 'Runner channel limit reached' }); return;
            }
            const state: SocketState = { cancelled: false, queue: Promise.resolve() };
            this.sockets.set(frame.id, state);
            void this.openSocket(tunnel, frame, state).catch(() => {
                this.sockets.delete(frame.id);
                void tunnel.send({ type: 'ws-close', id: frame.id, code: 1011, reason: 'DSH socket unavailable' }).catch(() => {});
            });
        } else if (frame.type === 'data' && frame.lane === 'socket') {
            const socket = this.sockets.get(frame.id)?.socket;
            if (socket?.readyState === WebSocket.OPEN) await new Promise<void>((resolve, reject) => socket.send(Buffer.from(frame.data, 'base64'), { binary: frame.binary === true }, (error) => error ? reject(error) : resolve()));
        } else if (frame.type === 'ws-close') {
            const state = this.sockets.get(frame.id);
            this.sockets.delete(frame.id);
            if (state) { state.cancelled = true; state.socket?.close(safeSocketClose(frame.code), frame.reason); }
        }
    }

    private openHttp(tunnel: WebTransport, frame: Extract<FederationFrame, { type: 'http-open' }>): void {
        const abort = new AbortController();
        const state: HttpRequestState = { abort, done: false, opening: Promise.resolve(undefined as unknown as ClientRequest) };
        this.requests.set(frame.id, state);
        const fail = (): void => {
            if (state.done || abort.signal.aborted) return;
            state.done = true;
            this.requests.delete(frame.id);
            abort.abort();
            void tunnel.send({ type: 'http-error', id: frame.id, code: 'upstream-unavailable' }).catch(() => {});
        };
        state.opening = (async () => {
            const cookie = await this.credential();
            abort.signal.throwIfAborted();
            const url = new URL(validateUpstreamPath(frame.path), this.options.origin);
            const headers = Object.fromEntries(filterHeaders(frame.headers, 'request'));
            headers.cookie = cookie;
            headers.origin = this.options.origin;
            const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: frame.method, headers, signal: abort.signal });
            request.on('error', fail);
            request.once('response', (response) => {
                void (async () => {
                    const responseHeaders: WireHeaders = [];
                    for (let at = 0; at < response.rawHeaders.length; at += 2) responseHeaders.push([response.rawHeaders[at]!, response.rawHeaders[at + 1]!]);
                    await tunnel.send({ type: 'http-head', id: frame.id, status: response.statusCode ?? 502, headers: filterHeaders(responseHeaders, 'response') });
                    for await (const raw of response) {
                        const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
                        for (let at = 0; at < data.byteLength; at += CHUNK_BYTES) await tunnel.sendData(frame.id, 'response', data.subarray(at, at + CHUNK_BYTES));
                    }
                    state.done = true;
                    this.requests.delete(frame.id);
                    await tunnel.send({ type: 'http-end', id: frame.id, lane: 'response' });
                })().catch(fail);
            });
            return request;
        })();
        void state.opening.catch(fail);
    }

    private async openSocket(tunnel: WebTransport, frame: Extract<FederationFrame, { type: 'ws-open' }>, state: SocketState): Promise<void> {
        const cookie = await this.credential();
        if (state.cancelled || !tunnel.isOpen) return;
        const url = new URL(validateUpstreamPath(frame.path), this.options.origin);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(url, frame.protocols, { headers: { cookie, origin: this.options.origin }, maxPayload: MAX_SOCKET_BYTES,
            perMessageDeflate: false, handshakeTimeout: 15_000, followRedirects: false });
        state.socket = socket;
        socket.on('error', () => {});
        socket.once('open', () => {
            void tunnel.send({ type: 'ws-ready', id: frame.id, protocol: socket.protocol }).catch(() => socket.close(1011));
        });
        socket.on('message', (data, binary) => {
            socket.pause();
            state.queue = state.queue.then(() => tunnel.sendData(frame.id, 'socket', bytes(data), binary)).then(() => {
                if (socket.readyState === WebSocket.OPEN) socket.resume();
            }).catch(() => socket.close(1011));
        });
        socket.once('close', (code, reason) => {
            this.sockets.delete(frame.id);
            void tunnel.send({ type: 'ws-close', id: frame.id, code: safeSocketClose(code), reason: reason.toString('utf8') }).catch(() => {});
        });
    }

    private cancelChannels(): void {
        for (const state of this.requests.values()) state.abort.abort();
        this.requests.clear();
        for (const state of this.sockets.values()) { state.cancelled = true; state.socket?.terminate(); }
        this.sockets.clear();
    }

    close(): void {
        this.lifetime.abort();
        this.cancelChannels();
        delete this.cookie;
    }
}
