// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { WebPeer } from './peer.ts';
import type { FederationFrame } from './protocol.ts';

export interface WebLink {
    call(input: unknown, signal?: AbortSignal): Promise<unknown>;
    onClose(listener: () => void): () => void;
}

/** One channel over one pinned Noise connection. The caller owns reconnect;
 * reconnect opens a new channel and never resumes an uncertain write. */
export async function connectWeb(link: WebLink, options: {
    signal: AbortSignal;
    validateIdentity(identity: unknown): boolean;
    receive(frame: FederationFrame): Promise<void> | void;
    ended(): void;
}): Promise<WebPeer> {
    const id = randomUUID();
    const lifetime = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, options.signal]);
    let unsubscribe: (() => void) | undefined;
    const peer = new WebPeer(options.receive, () => {
        lifetime.abort(); unsubscribe?.();
        void link.call({ op: 'close', id }).catch(() => {});
        options.ended();
    });
    const close = () => peer.close();
    signal.addEventListener('abort', close, { once: true });
    unsubscribe = link.onClose(close);
    try {
        signal.throwIfAborted();
        const opened = await link.call({ op: 'open', id }, signal) as { identity?: unknown };
        signal.throwIfAborted();
        if (!options.validateIdentity(opened?.identity)) throw new Error('Remote Web runtime identity does not match this distribution');
        // Each direction has a single serial writer and bounded packet queue.
        void (async () => {
            try {
                while (!signal.aborted) await peer.write(await link.call({ op: 'read', id }, signal));
            } catch { peer.close(); }
        })();
        void (async () => {
            try {
                while (!signal.aborted) await link.call({ op: 'write', id, packet: await peer.read() }, signal);
            } catch { peer.close(); }
        })();
        return peer;
    } catch (error) { peer.close(); throw error; }
}
