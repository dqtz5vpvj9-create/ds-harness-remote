// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { MAX_FRAME_BYTES, parseFrame, type DataLane, type FederationFrame } from './protocol.ts';
import type { WebTransport } from './source.ts';

/** Fragment the opaque Web frames below the encrypted Remote message limit.
 * Sequence numbers belong to this connection only. No input is replayed. */
export interface WebPacket { sequence: number; data: string; final: boolean }
export const WEB_PACKET_BYTES = 128 * 1024;
export class WebPeer implements WebTransport {
    private closed = false;
    private output: Buffer[] = [];
    private outputBytes = 0;
    private offset = 0;
    private outgoing = 0;
    private incoming = 0;
    private input: Buffer[] = [];
    private inputBytes = 0;
    private reader?: { resolve(value: WebPacket): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
    private pending = new Map<string, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
    constructor(private readonly receive: (frame: FederationFrame) => Promise<void> | void, private readonly ended: () => void) {}
    get isOpen(): boolean { return !this.closed; }

    async send(frame: FederationFrame): Promise<void> {
        if (this.closed) throw new Error('Web connection closed');
        const bytes = Buffer.from(JSON.stringify(frame));
        if (bytes.length > MAX_FRAME_BYTES || this.outputBytes + bytes.length > MAX_FRAME_BYTES) {
            this.close(); throw new Error('Web transport buffer limit exceeded');
        }
        this.output.push(bytes); this.outputBytes += bytes.length;
        if (this.reader) {
            const reader = this.reader; delete this.reader; clearTimeout(reader.timer);
            reader.resolve(this.take()!);
        }
    }

    async sendData(id: string, lane: DataLane, data: Buffer, binary?: boolean): Promise<void> {
        const ticket = randomUUID();
        let resolve!: () => void, reject!: (error: Error) => void;
        const acknowledged = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
        const timer = setTimeout(() => { this.pending.delete(ticket); reject(new Error('Web chunk acknowledgement timed out')); }, 60_000);
        timer.unref();
        this.pending.set(ticket, { resolve, reject, timer });
        try {
            await Promise.all([acknowledged, this.send({ type: 'data', id, lane, data: data.toString('base64'), ticket,
                ...(binary === undefined ? {} : { binary }) })]);
        } finally { clearTimeout(timer); this.pending.delete(ticket); }
    }

    /** At most one long poll; a heartbeat is an empty, final packet. */
    async read(): Promise<WebPacket> {
        if (this.closed) throw new Error('Web connection closed');
        if (this.reader) throw new Error('Web connection already has a reader');
        const packet = this.take();
        if (packet) return packet;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                delete this.reader;
                resolve({ sequence: ++this.outgoing, data: '', final: true });
            }, 15_000);
            timer.unref();
            this.reader = { resolve, reject, timer };
        });
    }

    private take(): WebPacket | undefined {
        const bytes = this.output[0];
        if (!bytes) return undefined;
        const end = Math.min(bytes.length, this.offset + WEB_PACKET_BYTES);
        const chunk = bytes.subarray(this.offset, end);
        this.offset = end;
        const final = end === bytes.length;
        if (final) { this.output.shift(); this.offset = 0; this.outputBytes -= bytes.length; }
        return { sequence: ++this.outgoing, data: chunk.toString('base64'), final };
    }

    async write(value: unknown): Promise<void> {
        if (this.closed) throw new Error('Web connection closed');
        const packet = value as Partial<WebPacket> | null;
        if (!packet || packet.sequence !== this.incoming + 1 || typeof packet.final !== 'boolean'
            || typeof packet.data !== 'string' || packet.data.length > Math.ceil(WEB_PACKET_BYTES / 3) * 4
            || packet.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(packet.data)) {
            this.close(); throw new Error('Invalid Web packet');
        }
        this.incoming++;
        const bytes = Buffer.from(packet.data, 'base64');
        this.inputBytes += bytes.length;
        if (this.inputBytes > MAX_FRAME_BYTES) { this.close(); throw new Error('Web frame exceeds its limit'); }
        if (bytes.length) this.input.push(bytes);
        if (!packet.final) return;
        const text = Buffer.concat(this.input).toString('utf8');
        this.input = []; this.inputBytes = 0;
        if (!text) return;
        let frame: FederationFrame;
        try { frame = parseFrame(text); } catch (error) { this.close(); throw error; }
        if (frame.type === 'ack') {
            const pending = this.pending.get(frame.ticket);
            if (pending) { clearTimeout(pending.timer); this.pending.delete(frame.ticket); pending.resolve(); }
            return;
        }
        // The carrier acknowledges delivery before awaiting the handler, which
        // may itself wait for a data acknowledgement from the opposite lane.
        void Promise.resolve().then(() => this.receive(frame)).then(async () => {
            if (frame.type === 'data') await this.send({ type: 'ack', ticket: frame.ticket });
        }).catch(() => this.close());
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        const error = new Error('Web connection closed; operation delivery is not retried');
        if (this.reader) { clearTimeout(this.reader.timer); this.reader.reject(error); delete this.reader; }
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
        this.pending.clear(); this.output = []; this.input = []; this.outputBytes = 0; this.inputBytes = 0;
        this.ended();
    }
}
