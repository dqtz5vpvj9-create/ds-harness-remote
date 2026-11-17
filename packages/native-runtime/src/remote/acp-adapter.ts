/** Durable source contract around Remote's existing ACP execution and DSH projection. */
import { createHash } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
import { realpath, stat, readFile, mkdir } from 'node:fs/promises';
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import type { FileUploadValue } from '@deepseek-ai/dsh-client-file-upload/types';
import { storedCodexUpload, registerStoredCodexUpload } from './codex-uploads.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { SourceEventIndex, type EventInput } from './event-index.ts';
import { OperationLedger, CreationLedger, ReceiptLedger } from './operation-ledger.ts';
import { SourceError, waitFor } from './errors.ts';
import { parseSourceSessionId, sourceSessionId, type DirectAcpConfig, type SourceAdapter, type SourceSession,
    type SourceOperation, type SourceReceipt, type SourceCreateRequest, type SourceReadRequest, type SourceChangesRequest,
    type SourceUploadRequest, type SourceResourceRequest, type SourceResource } from './protocol.ts';
import type { CodexCall, CodexCallResult } from './codex-access.ts';

export interface AcpSourceSnapshot {
    nativeId: string; cwd: string; title: string; updatedAt: number; running: boolean;
    selection?: { provider: string; model: string; reasoningEffort?: string } | undefined;
    entries?: Array<{ type: 'event'; event: EventInput & { seq: number } }>;
}
export interface AcpSourcePort {
    list(): Promise<AcpSourceSnapshot[]>;
    read(nativeId: string): Promise<AcpSourceSnapshot>;
    create(cwd: string, signal: AbortSignal): Promise<AcpSourceSnapshot>;
    call(nativeId: string, endpoint: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
    close(): Promise<void>;
}
const validOutcome = (value: unknown): value is CodexCallResult => !!value && typeof value === 'object'
    && 'status' in value && ['accepted', 'rejected', 'indeterminate'].includes(String(value.status))
    && 'message' in value && typeof value.message === 'string';

export class DirectAcpAdapter implements SourceAdapter {
    readonly id: string;
    readonly machineId: string;
    readonly engine = 'antigravity';
    readonly nativeAccess: NonNullable<SourceAdapter['nativeAccess']>;
    private readonly indexes = new Map<string, SourceEventIndex>();
    private readonly reads = new Map<string, Promise<SourceEventIndex>>();
    private readonly lifetime = new AbortController();
    private readonly operations: OperationLedger;
    private readonly creations: CreationLedger;
    private readonly controls: ReceiptLedger<CodexCallResult>;
    private portValue: AcpSourcePort | undefined;

    constructor(private readonly config: DirectAcpConfig, private readonly directory: string,
        private readonly connect: () => AcpSourcePort, private readonly files: boolean) {
        this.id = config.id; this.machineId = config.machineId;
        this.operations = new OperationLedger(join(directory, 'operations'));
        this.creations = new CreationLedger(join(directory, 'creations'), JSON.stringify([this.machineId, this.id, this.engine]));
        this.controls = new ReceiptLedger(join(directory, 'controls'));
        this.nativeAccess = {
            capabilities: async () => ({ protocolVersion: 'remote-acp-v1', runtime: 'Antigravity',
                methods: { 'session/models': 'read', 'session/selectModel': 'write' }, unavailable: {} }),
            call: (request, lookup, signal) => this.control(request, lookup ?? false, signal),
            reply: async () => { throw new SourceError('UNSUPPORTED', 'This backend does not expose approval replies.'); },
            readEvents: () => { throw new SourceError('UNSUPPORTED', 'Use the source history subscription for this backend.'); },
        };
    }
    private port(): AcpSourcePort { this.lifetime.signal.throwIfAborted(); return this.portValue ??= this.connect(); }
    private identity(sessionId: string): string {
        const identity = parseSourceSessionId(sessionId);
        if (identity.machineId !== this.machineId || identity.sourceId !== this.id || identity.engine !== this.engine)
            throw new SourceError('INVALID_REQUEST', 'This operation belongs to another native source.');
        return identity.nativeId;
    }
    private metadata(value: AcpSourceSnapshot): SourceSession {
        if (!value.nativeId || !isAbsolute(value.cwd) || !Number.isFinite(value.updatedAt))
            throw new SourceError('HISTORY_UNAVAILABLE', 'The backend returned an invalid source identity.');
        const identity = { machineId: this.machineId, sourceId: this.id, engine: this.engine, nativeId: value.nativeId };
        return { ...identity, id: sourceSessionId(identity), cwd: value.cwd, title: value.title, updatedAt: value.updatedAt,
            status: value.running ? 'running' : 'idle', activeTurnId: value.running ? value.nativeId : null,
            capabilities: { send: true, steer: false, cancel: true, approve: false, files: this.files, images: true },
            pendingRequests: [], agent: value.selection };
    }
    async list(signal?: AbortSignal): Promise<SourceSession[]> {
        return (await waitFor(this.port().list(), signal)).map(value => this.metadata(value));
    }
    async resolve(sessionId: string, signal?: AbortSignal): Promise<SourceSession> { return (await this.refresh(sessionId, signal)).session; }
    private async refresh(sessionId: string, signal?: AbortSignal): Promise<SourceEventIndex> {
        const nativeId = this.identity(sessionId);
        let work = this.reads.get(nativeId);
        if (!work) {
            work = this.refreshOnce(nativeId);
            this.reads.set(nativeId, work);
            void work.finally(() => { if (this.reads.get(nativeId) === work) this.reads.delete(nativeId); }).catch(() => undefined);
        }
        return waitFor(work, signal);
    }
    private async refreshOnce(nativeId: string): Promise<SourceEventIndex> {
        const snapshot = await this.port().read(nativeId);
        this.lifetime.signal.throwIfAborted();
        if (snapshot.nativeId !== nativeId || !Array.isArray(snapshot.entries))
            throw new SourceError('HISTORY_UNAVAILABLE', 'The backend did not return the requested complete history.');
        const session = this.metadata(snapshot);
        // Attachment bytes remain in the source attachment reader, never in a
        // history row whose page budget could otherwise hide the whole turn.
        snapshot.entries = snapshot.entries.map(entry => {
            const event = structuredClone(entry.event), data = event.data as Record<string, unknown>;
            const body = event.type === 'assistant/message' ? data.message as Record<string, unknown> : data;
            if (Array.isArray(body?.content)) body.content = body.content.map(part => {
                if (!part || typeof part !== 'object' || part.type !== 'image' || !part.attachment) return part;
                const { data: _bytes, ...reference } = part; return reference;
            });
            return { type: 'event', event };
        });
        let index = this.indexes.get(nativeId);
        if (!index) {
            index = new SourceEventIndex(join(this.directory, 'history', `${createHash('sha256').update(nativeId).digest('hex')}.sqlite`), session);
            this.indexes.set(nativeId, index);
        }
        const store = index;
        // The existing projection owns DSH event conversion. Persist its accepted
        // snapshot atomically, and explicitly reset cursors on a native rewrite.
        store.edit(session, () => {
            const old = store.cached<Array<{ type: 'event'; event: EventInput & { seq: number } }>>('acp/snapshot') ?? [];
            const entries = snapshot.entries!;
            let resetAt = Math.min(old.length, entries.length);
            for (let i = 0; i < Math.min(old.length, entries.length); i++) {
                if (old[i]!.event.type !== entries[i]!.event.type || old[i]!.event.seq !== entries[i]!.event.seq) { resetAt = i; break; }
            }
            if (resetAt < old.length) store.removeFrom(resetAt + 1);
            const calls = new Map<string, string>();
            let turnStart: string | undefined, stepStart: string | undefined;
            entries.forEach((entry, offset) => {
                if (entry.type !== 'event' || !Number.isSafeInteger(entry.event.seq)) throw new SourceError('HISTORY_UNAVAILABLE', 'Invalid native history entry.');
                const key = `acp:${offset}`, { seq: _seq, ...event } = entry.event;
                const data = event.data as Record<string, unknown>;
                if (event.type === 'turn/start') { turnStart = undefined; stepStart = undefined; }
                if (event.type === 'step/start') stepStart = undefined;
                const deps: string[] = [];
                if (turnStart) deps.push(turnStart);
                if (stepStart) deps.push(stepStart);
                const source = (data.message as Record<string, unknown> | undefined)?.source as Record<string, unknown> | undefined;
                const callId = typeof data.callId === 'string' ? data.callId : typeof source?.callId === 'string' ? source.callId : undefined;
                if (callId && calls.has(callId)) deps.push(calls.get(callId)!);
                store.put(key, event, deps, offset + 1);
                if (event.type === 'turn/start') turnStart = key;
                if (event.type === 'step/start') stepStart = key;
                if (event.type === 'tool/call' && callId) calls.set(callId, key);
            });
            store.cache('acp/snapshot', entries);
        });
        return store;
    }
    async read(request: SourceReadRequest, signal?: AbortSignal) { return (await this.refresh(request.sessionId, signal)).read(request); }
    async *changes(request: SourceChangesRequest, signal?: AbortSignal) {
        const lifetime = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
        const index = await this.refresh(request.sessionId, lifetime);
        const polling = new AbortController();
        const combined = AbortSignal.any([lifetime, polling.signal]);
        let failure: unknown;
        const work = (async () => {
            try { while (!combined.aborted) { await delay(750, undefined, { signal: combined }); await this.refresh(request.sessionId, combined); } }
            catch (error) { if (!combined.aborted) { failure = error; polling.abort(error); } }
        })();
        try { yield* index.changes(request, combined); }
        catch (error) { throw failure ?? error; }
        finally { polling.abort(); await work; }
    }
    async operate(request: SourceOperation): Promise<SourceReceipt> {
        const nativeId = this.identity(request.sessionId);
        if (!['send', 'cancel'].includes(request.kind))
            throw new SourceError('UNSUPPORTED', 'This backend does not support the requested operation.');
        await this.refresh(request.sessionId);
        const content: Record<string, unknown>[] = [...(request.text ? [{ type: 'text', text: request.text }] : []),
            ...(request.images ?? []).map(image => ({ type: 'image', mediaType: image.mediaType, data: image.data }))];
        for (const receipt of request.files ?? []) {
            const stored = await storedCodexUpload(join(this.directory, 'uploads'), request.sessionId, receipt);
            if (!stored) throw new SourceError('INVALID_REQUEST', 'This attachment receipt is unavailable on the selected source.');
            if (stored.image && stored.mimeType) {
                const bytes = await readFile(stored.path);
                if (bytes.length !== stored.bytes || bytes.length > 8 * 1024 * 1024) throw new SourceError('INVALID_REQUEST', 'The source attachment has changed or exceeds its limit.');
                content.push({ type: 'image', mediaType: stored.mimeType, data: bytes.toString('base64') });
            } else content.push({ type: 'text', text: `Attached file ${JSON.stringify(stored.name)}: ${JSON.stringify(stored.path)}` });
        }
        return this.operations.run(request, async () => {
            await this.port().call(nativeId, request.kind === 'send' ? 'session/prompt' : 'session/cancel',
                request.kind === 'send' ? { requestId: request.operationId, content } : {}, this.lifetime.signal);
            // Accepted means source admission, not turn completion. A failed
            // refresh cannot turn the confirmed send into a rejected draft.
            void this.refresh(request.sessionId).catch(() => undefined);
            return { operationId: request.operationId, sessionId: request.sessionId, status: 'accepted', message: 'The native source accepted this operation.' };
        });
    }
    receipt(request: SourceOperation) { this.identity(request.sessionId); return this.operations.stored(request); }
    async upload(request: SourceUploadRequest, signal?: AbortSignal): Promise<FileUploadValue> {
        await this.resolve(request.sessionId, signal);
        if (!/^[0-9a-f-]{36}$/i.test(request.operationId) || Buffer.from(request.data, 'base64').toString('base64') !== request.data || request.data.length > 8 * 1024 * 1024)
            throw new SourceError('INVALID_REQUEST', 'Invalid attachment identity or bytes.');
        const bytes = Buffer.from(request.data, 'base64'), directory = join(this.directory, 'uploads');
        const path = join(directory, createHash('sha256').update(bytes).digest('hex'));
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFileAtomic(path, bytes, { mode: 0o600 });
        const value: FileUploadValue = { receiptId: request.operationId as FileUploadValue['receiptId'],
            file: { attachmentId: request.operationId as FileUploadValue['file']['attachmentId'], name: request.name, bytes: bytes.length } };
        await registerStoredCodexUpload(directory, request.operationId, { sessionId: request.sessionId, path,
            name: request.name, bytes: bytes.length, image: false, value }, signal);
        return value;
    }
    async readResource(request: SourceResourceRequest, signal?: AbortSignal): Promise<SourceResource> {
        const nativeId = this.identity(request.sessionId);
        if (!request.path.startsWith('attachment:')) throw new SourceError('INVALID_REQUEST', 'The requested native resource is not an attachment.');
        signal?.throwIfAborted();
        const value = await this.port().call(nativeId, 'session/attachment', { attachmentId: request.path.slice(11) }, this.lifetime.signal) as {
            data?: string; attachment?: SourceResource['attachment'] };
        if (typeof value.data !== 'string' || !value.attachment) throw new SourceError('HISTORY_UNAVAILABLE', 'The source image is unavailable.');
        return { encoding: 'base64', content: value.data, mimeType: value.attachment.mediaType, attachment: value.attachment };
    }
    async create(request: SourceCreateRequest) {
        if (request.sourceId !== this.id) throw new SourceError('INVALID_REQUEST', 'This creation belongs to another source.');
        const cwd = request.cwd ?? this.config.cwd;
        if (!cwd || !isAbsolute(cwd)) throw new SourceError('INVALID_REQUEST', 'Select an existing source directory.');
        const path = await realpath(cwd);
        if (!(await stat(path)).isDirectory()) throw new SourceError('INVALID_REQUEST', 'The source directory is unavailable.');
        const result = await this.creations.run(request, async () => ({ sourceId: this.id, operationId: request.operationId,
            status: 'accepted', message: 'The native source created the session.', session: this.metadata(await this.port().create(path, this.lifetime.signal)) }));
        return result.session ? { ...result, session: await this.resolve(result.session.id) } : result;
    }
    private async control(request: CodexCall, lookup: boolean, signal?: AbortSignal): Promise<CodexCallResult> {
        if (request.sourceId !== this.id) throw new SourceError('INVALID_REQUEST', 'The control belongs to another source.');
        if (!['session/models', 'session/selectModel'].includes(request.method)) throw new SourceError('UNSUPPORTED', 'This native method is not supported by the selected backend.');
        const params = request.params ?? {}, nativeId = params.sessionId;
        if (typeof nativeId !== 'string') throw new SourceError('INVALID_REQUEST', 'An explicit native session identity is required.');
        const id = sourceSessionId({ machineId: this.machineId, sourceId: this.id, engine: this.engine, nativeId });
        await this.refresh(id, signal);
        const execute = async (): Promise<CodexCallResult> => ({ status: 'accepted', message: 'The native source confirmed this operation.',
            result: await this.port().call(nativeId, request.method, params, this.lifetime.signal) });
        if (request.method === 'session/models') return execute();
        if (!request.operationId) throw new SourceError('INVALID_REQUEST', 'Model selection requires a stable operation identity.');
        const identity = [this.id, request.operationId], payload = [request.method, params];
        if (lookup) return await this.controls.stored(identity, payload, validOutcome) ?? { status: 'rejected', message: 'This operation has not been dispatched.' };
        return this.controls.run(identity, payload, { status: 'indeterminate', message: 'Model selection may have been dispatched. Read the current source model before trying again.' }, validOutcome, execute);
    }
    async dispose() { this.lifetime.abort(); await this.portValue?.close(); for (const index of this.indexes.values()) index.dispose(); }
}
