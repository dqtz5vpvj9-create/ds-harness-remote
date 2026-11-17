// SPDX-License-Identifier: AGPL-3.0-only
import { WebPeer } from './peer.ts';
import { WebSource, type WebSourceOptions } from './source.ts';

/** One registry per authenticated Noise peer, disposed with that connection. */
export class WebSourceCarrier {
    private channels = new Map<string, WebPeer>();
    private closed = false;
    constructor(private readonly options: WebSourceOptions, private readonly identity: unknown) {}
    async call(input: unknown): Promise<unknown> {
        if (this.closed) throw new Error('Web carrier closed');
        const value = input as { op?: unknown; id?: unknown; packet?: unknown } | null;
        if (!value || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.id)) throw new Error('Invalid Web channel');
        const id = value.id;
        if (value.op === 'open') {
            if (this.channels.has(id)) throw new Error('Web channel already exists');
            if (this.channels.size >= 8) throw new Error('Web channel limit reached');
            const source = new WebSource(this.options);
            const peer: WebPeer = new WebPeer(frame => source.receive(peer, frame), () => {
                source.close(); this.channels.delete(id);
            });
            this.channels.set(id, peer);
            return { identity: this.identity };
        }
        const peer = this.channels.get(id);
        if (!peer) throw new Error('Web channel unavailable');
        if (value.op === 'read') return peer.read();
        if (value.op === 'write') { await peer.write(value.packet); return {}; }
        if (value.op === 'close') { peer.close(); return {}; }
        throw new Error('Invalid Web carrier operation');
    }
    close(): void {
        this.closed = true;
        for (const peer of this.channels.values()) peer.close();
        this.channels.clear();
    }
}
