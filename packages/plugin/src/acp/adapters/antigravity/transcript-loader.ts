import { AGY_IMAGE_ROOT, stripAgyImageReferences, agyImageReferences, readAgyImage } from './image-store.js'
import { promises as fs, constants, closeSync, openSync, readSync, realpathSync, statSync, type Stats } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { MAX_AGENT_ACP_TRANSFER_BYTES } from '@dsh-remote/protocol'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import type { StepLogRecord, SubagentLink } from './types.js'
import { RpcError } from '../../../safe-error.js'

// Load prefix-only Node builtins natively, including under older Vite runners.
const nodeRequire = createRequire(import.meta.url)

export interface HydratedSessionEvent {
  type: 'event'
  event: {
    type: string
    seq: number
    time: number
    data: unknown
    surfaceOp?: 'append'
  }
}

export function cleanUserPrompt(raw?: string): string {
  if (!raw) return ''
  raw = stripAgyImageReferences(raw)
  const match = raw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/)
  if (match && match[1]) {
    return match[1].trim()
  }
  return raw.trim()
}

const MAX_CACHED_TRANSCRIPTS = 96

interface FileCursor {
  ino: number
  size: number
  mtimeMs: number
  byteOffset: number
  needsNewline: boolean
}

interface Checkpoint {
  recordIndex: number
  seq: number
  turn: number
  step: number
  turnOpen: boolean
  plannerSeen: boolean
}

interface HydratedTranscript {
  sessionId: string
  trailingUnflushedTruncated: boolean
  records: StepLogRecord[]
  events: HydratedSessionEvent[]
  checkpoint: Checkpoint
}

interface TranscriptEntry {
  compact?: FileCursor
  rawRecords: StepLogRecord[]
  truncatedIndices: number[]
  full?: FileCursor
  fullByIdentity: Map<string, StepLogRecord>
  hydrated?: HydratedTranscript
  dirty: boolean
}

const transcripts = new Map<string, TranscriptEntry>()
const pendingReads = new Map<string, Promise<HydratedSessionEvent[]>>()
const recordTimes = new WeakMap<StepLogRecord, number>()

export function clearTranscriptLoaderCache(): void {
  transcripts.clear()
  lineageIndexes.clear()
}

function sameFile(cursor: FileCursor | undefined, stat: Stats): boolean {
  return cursor?.ino === stat.ino && cursor.byteOffset === stat.size && cursor.size === stat.size && cursor.mtimeMs === stat.mtimeMs
}

function checkSize(size: number): void {
  if (size > MAX_AGENT_ACP_TRANSFER_BYTES) {
    throw new RpcError('HISTORY_TOO_LARGE', 'The native transcript exceeds the history transfer limit.')
  }
}

function identity(record: StepLogRecord): string {
  return JSON.stringify([record.step_index, record.type, record.created_at])
}

async function readRange(path: string, stat: Stats, start: number): Promise<Buffer> {
  const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    checkSize(opened.size)
    if (!opened.isFile()) throw new RpcError('HISTORY_UNAVAILABLE', 'The native transcript is unavailable.')
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size < stat.size) {
      throw new RpcError('HISTORY_INCOMPLETE', 'The native transcript changed during the read.')
    }
    const bytes = Buffer.allocUnsafe(stat.size - start)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, start + offset)
      if (!bytesRead) throw new RpcError('HISTORY_INCOMPLETE', 'The native transcript changed during the read.')
      offset += bytesRead
    }
    return bytes
  } finally { await handle.close() }
}

async function readDelta(path: string, stat: Stats, previous?: FileCursor) {
  const append = previous !== undefined && previous.ino === stat.ino && stat.size > previous.byteOffset
    && (stat.size > previous.size || (stat.size === previous.size && stat.mtimeMs === previous.mtimeMs))
  const start = append ? previous.byteOffset : 0
  const bytes = await readRange(path, stat, start)
  const records: StepLogRecord[] = []
  let needsNewline = append && previous.needsNewline
  let consumed = 0
  while (consumed < bytes.length) {
    const newline = bytes.indexOf(10, consumed)
    const end = newline < 0 ? bytes.length : newline
    const line = bytes.toString('utf8', consumed, end)
    // A complete final value needs no newline until another value arrives.
    if (needsNewline && /[^ \t\r]/.test(line)) break
    if (line.trim()) {
      let record: StepLogRecord
      try { record = JSON.parse(line) } catch { break }
      if (!record || typeof record.type !== 'string') break
      records.push(record)
      needsNewline = true
    }
    if (newline >= 0) needsNewline = false
    consumed = newline < 0 ? end : newline + 1
  }
  const cursor: FileCursor = { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, byteOffset: start + consumed, needsNewline }
  return { records, cursor, append }
}

export async function loadTranscriptEvents(
  conversationId: string,
  sessionId: string,
  baseDir: string = join(homedir(), '.gemini/antigravity-cli/brain'),
): Promise<HydratedSessionEvent[]> {
  const path = await transcriptPath(baseDir, conversationId)
  if (!path) throw new RpcError('HISTORY_UNAVAILABLE', 'The native transcript is unavailable.')
  // Readers with different projected session IDs share the two file cursors.
  const previous = pendingReads.get(path)
  const read = () => loadCachedTranscript(path, baseDir, conversationId, sessionId)
  const pending = previous ? previous.then(read, read) : read()
  pendingReads.set(path, pending)
  try { return await pending }
  catch (error) {
    if (error instanceof RpcError) throw error
    if ((error as NodeJS.ErrnoException).code) throw new RpcError('HISTORY_UNAVAILABLE', 'The native transcript could not be read.')
    throw error
  } finally { if (pendingReads.get(path) === pending) pendingReads.delete(path) }
}

async function loadCachedTranscript(path: string, baseDir: string, conversationId: string, sessionId: string) {
  const stat = await fs.stat(path)
  checkSize(stat.size)
  let entry = transcripts.get(path)
  if (!entry || !entry.compact || entry.compact.ino !== stat.ino || stat.size < entry.compact.byteOffset) {
    entry = { rawRecords: [], truncatedIndices: [], fullByIdentity: new Map(), dirty: true }
  }
  transcripts.delete(path)
  transcripts.set(path, entry)
  if (transcripts.size > MAX_CACHED_TRANSCRIPTS) transcripts.delete(transcripts.keys().next().value!)

  if (!sameFile(entry.compact, stat)) {
    const delta = await readDelta(path, stat, entry.compact)
    if (!delta.append) {
      entry.rawRecords = []
      entry.truncatedIndices = []
    }
    for (const record of delta.records) {
      if (record.truncated_fields?.length) entry.truncatedIndices.push(entry.rawRecords.length)
      entry.rawRecords.push(record)
    }
    entry.compact = delta.cursor
    entry.dirty = true
    requireComplete(delta.cursor)
  }
  if (entry.truncatedIndices.length) {
    try {
      const fullPath = await transcriptPath(baseDir, conversationId, 'transcript_full.jsonl')
      if (!fullPath) throw new RpcError('HISTORY_INCOMPLETE', 'The full native transcript is unavailable.')
      const fullStat = await fs.stat(fullPath)
      checkSize(fullStat.size)
      if (!sameFile(entry.full, fullStat)) {
        const delta = await readDelta(fullPath, fullStat, entry.full)
        if (!delta.append) entry.fullByIdentity.clear()
        for (const record of delta.records) entry.fullByIdentity.set(identity(record), record)
        entry.full = delta.cursor
        entry.dirty = true
        requireComplete(delta.cursor)
      }
    } catch (error) {
      if (error instanceof RpcError && error.code !== 'HISTORY_UNAVAILABLE') throw error
      throw new RpcError('HISTORY_INCOMPLETE', 'The full native transcript is unavailable.')
    }
  }
  const previous = entry.hydrated
  if (!entry.dirty && previous?.sessionId === sessionId && !previous.trailingUnflushedTruncated) {
    return previous.events.map(e => ({ ...e }))
  }
  const records = entry.truncatedIndices.length ? entry.rawRecords.slice() : entry.rawRecords
  let trailingUnflushedTruncated = false
  for (const index of entry.truncatedIndices) {
    const record = records[index]!
    const restored = entry.fullByIdentity.get(identity(record))
    if (!restored && index === records.length - 1 && index > 0 && entry.fullByIdentity.size > 0) {
      trailingUnflushedTruncated = true
      continue
    }
    if (!restored || restored.truncated_fields?.length || record.truncated_fields!.some(field => !(field in restored))) {
      throw new RpcError('HISTORY_INCOMPLETE', 'The full native transcript has not completed this record.')
    }
    records[index] = restored
  }
  entry.hydrated = await hydrateRecords(conversationId, sessionId, records, trailingUnflushedTruncated,
    previous?.sessionId === sessionId ? previous : undefined)
  entry.dirty = false
  return entry.hydrated.events.map(e => ({ ...e }))
}

// Loader events cross the local source port by reference. Freeze the entire
// JSON payload once so consumers cannot mutate a previously accepted history.
function freezeEvent(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return
  for (const child of Object.values(value)) freezeEvent(child)
  Object.freeze(value)
}

async function hydrateRecords(conversationId: string, sessionId: string, records: StepLogRecord[],
  trailingUnflushedTruncated: boolean, previous?: HydratedTranscript): Promise<HydratedTranscript> {
  // GENERIC returns and the following planner can revise the last tool batch.
  // Everything before its checkpoint is settled unless a full record changed.
  let checkpoint: Checkpoint = { recordIndex: 0, seq: 0, turn: 0, step: 1, turnOpen: false, plannerSeen: false }
  if (previous && previous.checkpoint.recordIndex < records.length) {
    const end = previous.checkpoint.recordIndex
    let i = 0
    while (i < end && previous.records[i] === records[i]) i++
    if (i === end) checkpoint = previous.checkpoint
  }
  const events = previous?.events.slice(0, checkpoint.seq) ?? []
  let currentSeq = checkpoint.seq
  let currentTurn = checkpoint.turn
  let currentStep = checkpoint.step
  let { turnOpen, plannerSeen } = checkpoint
  const replayStart = currentSeq

  const push = (type: string, data: unknown, time: number, surface = false) => {
    events.push({
      type: 'event',
      event: {
        type,
        seq: currentSeq++,
        time,
        data,
        ...(surface ? { surfaceOp: 'append' } : {}),
      },
    })
  }

  for (let recordIndex = checkpoint.recordIndex; recordIndex < records.length; recordIndex++) {
    const record = records[recordIndex]!
    if (record.type === 'PLANNER_RESPONSE' || record.type === 'USER_INPUT') {
      checkpoint = { recordIndex, seq: currentSeq, turn: currentTurn, step: currentStep, turnOpen, plannerSeen }
    }
    const time = record.created_at ? new Date(record.created_at).getTime() : recordTimes.get(record) ?? Date.now()
    if (!record.created_at) recordTimes.set(record, time)

    if (record.type === 'USER_INPUT') {
      if (turnOpen) {
        push('step/end', { turn: currentTurn, step: currentStep }, time)
        push('turn/end', { turn: currentTurn, reason: { kind: 'completed' } }, time)
        turnOpen = false
      }
      currentTurn += 1
      currentStep = 1
      plannerSeen = false
      turnOpen = true
      push('turn/start', { turn: currentTurn }, time)
      push('step/start', { turn: currentTurn, step: currentStep }, time)

      const text = cleanUserPrompt(record.content)
      const images = await Promise.all(agyImageReferences(record.content ?? '').map(path => readAgyImage(conversationId, path)))
      if (images.some(image => image === undefined)) throw new RpcError('HISTORY_INCOMPLETE', 'A native transcript image is unavailable.')
      push('user/message', {
        id: `user:${record.step_index}`,
        role: 'user',
        content: [...(text ? [{ type: 'text', text }] : []), ...images],
        source: { kind: 'user' },
      }, time, true)
    } else if (record.type === 'PLANNER_RESPONSE') {
      if (!turnOpen) {
        currentTurn += 1
        turnOpen = true
        push('turn/start', { turn: currentTurn }, time)
        push('step/start', { turn: currentTurn, step: currentStep }, time)
      }

      // A planner record is a distinct native step, not a revision of the
      // previous assistant message. DSH keys its assistant nodes by turn/step.
      if (plannerSeen) {
        push('step/end', { turn: currentTurn, step: currentStep }, time)
        currentStep += 1
        push('step/start', { turn: currentTurn, step: currentStep }, time)
      }
      plannerSeen = true

      if (record.content?.trim() || record.thinking?.trim() || record.tool_calls?.length) {
        const contentBlocks: Array<Record<string, unknown>> = []
        if (record.thinking && record.thinking.trim() !== '') {
          contentBlocks.push({ type: 'reasoning', text: record.thinking.trim() })
        }
        if (record.content?.trim()) contentBlocks.push({ type: 'text', text: record.content })
        const names = new Map<string, number>()
        for (const call of record.tool_calls ?? []) {
          const name = typeof call.name === 'string' && call.name.length > 0 ? call.name : 'tool'
          const index = names.get(name) ?? 0
          names.set(name, index + 1)
          contentBlocks.push({ type: 'tool-call', id: `${record.step_index}:${name}${index ? `:${index}` : ''}`,
            name, arguments: typeof call.args === 'object' && call.args !== null ? JSON.stringify(call.args) : '{}' })
        }


        push('assistant/message', {
          turn: currentTurn,
          step: currentStep,
          message: {
            id: `${sessionId}:${record.step_index}`,
            role: 'assistant',
            content: contentBlocks,
            source: { kind: 'model', provider: 'antigravity', model: typeof record.model === 'string' ? record.model : '' },
          },
          // The official reader requires both the model route and an iterable
          // stream even when restoring history without token usage samples.
          stream: [],
        }, time, true)
      }

      if (Array.isArray(record.tool_calls)) {
        // Native AGY appends GENERIC tool returns sequentially as each parallel
        // tool call finishes, and an interrupted batch may settle with fewer returns.
        const returns: StepLogRecord[] = []
        let settledBatch = false
        for (let index = recordIndex + 1; index < records.length; index++) {
          const next = records[index]!
          if (next.type === 'PLANNER_RESPONSE' || next.type === 'USER_INPUT') {
            settledBatch = true
            break
          }
          if (next.type === 'GENERIC') returns.push(next)
        }
        let toolIndex = 0
        const names = new Map<string, number>()
        for (const call of record.tool_calls) {
          const nativeReturn = toolIndex < returns.length ? returns[toolIndex] : undefined
          toolIndex += 1
          const missingSettledReturn = settledBatch && returns.length > 0 && nativeReturn === undefined && call.result === undefined
          const pendingLiveReturn = !settledBatch && returns.length > 0 && nativeReturn === undefined && call.result === undefined
          const output = call.result ?? nativeReturn?.content ?? (missingSettledReturn ? 'Tool execution was interrupted before returning output.' : undefined)
          const header = typeof output === 'string' ? output.replace(/^(?:(?:Created|Completed) At: [^\n]*\n)+/, '') : ''
          const exitCode = /^Command exited with code (-?\d+)\./.exec(header)?.[1]
          const failed = missingSettledReturn || call.status === 'ERROR' || nativeReturn?.status === 'ERROR' || (exitCode !== undefined && Number(exitCode) !== 0)
          const toolName = (typeof call.name === 'string' && call.name.length > 0) ? call.name : 'tool'
          const index = names.get(toolName) ?? 0
          names.set(toolName, index + 1)
          const callId = `${record.step_index}:${toolName}${index ? `:${index}` : ''}`
          push('tool/call', {
            turn: currentTurn,
            step: currentStep,
            callId,
            name: toolName,
            arguments: typeof call.args === 'object' && call.args !== null ? JSON.stringify(call.args) : '{}',
            toolCallId: callId,
            toolName,
            status: failed ? 'failed' : (pendingLiveReturn || call.status === 'CALLING' || call.status === 'EXECUTING') ? 'pending' : 'finished',
          }, time, false)
          if (output !== undefined) push('tool/result', {
            turn: currentTurn, step: currentStep, message: {
              id: `${callId}:result`, role: 'user', content: [{
                type: 'tool-result', toolCallId: callId,
                content: [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output) }],
                ...(failed ? { isError: true } : {}),
              }], source: { kind: 'tool', callId },
            },
          }, nativeReturn?.created_at ? new Date(nativeReturn.created_at).getTime() : time, true)
        }
      }


    }
  }

  if (turnOpen) {
    // Hydration must not extend a settled turn until the time of the read.
    const settledAt = events.at(-1)?.event.time ?? Date.now()
    push('step/end', { turn: currentTurn, step: currentStep }, settledAt)
    push('turn/end', { turn: currentTurn, reason: { kind: 'completed' } }, settledAt)
  }

  let i = replayStart
  while (previous && i < events.length && i < previous.events.length && isDeepStrictEqual(previous.events[i]!.event, events[i]!.event)) {
    events[i] = previous.events[i]!
    i++
  }
  for (; i < events.length; i++) freezeEvent(events[i]!.event)
  return { sessionId, trailingUnflushedTruncated, records, events, checkpoint }
}

function requireComplete(cursor: FileCursor): void {
  if (cursor.byteOffset < cursor.size) {
    throw new RpcError('HISTORY_INCOMPLETE', 'The native transcript contains an incomplete or invalid record.')
  }
}

export interface DiscoveredSession {
  conversationId: string
  parentNativeId?: string
  agentRole?: string
  title: string
  createdAt: number
  updatedAt: number
}

async function querySqliteJson<T = unknown>(dbPath: string, sql: string, params: Array<string | number> = []): Promise<T[]> {
  try {
    const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite')
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const stmt = db.prepare(sql)
      const rows = stmt.all(...params)
      return rows as T[]
    } finally {
      db.close()
    }
  } catch {
    // fallback to sqlite3 CLI
  }

  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)
    let formattedSql = sql
    for (const p of params) {
      const val = typeof p === 'number' ? String(p) : `'${String(p).replace(/'/g, "''")}'`
      formattedSql = formattedSql.replace('?', val)
    }
    const { stdout } = await execFileAsync('sqlite3', [dbPath, '-json', formattedSql])
    return JSON.parse(stdout || '[]') as T[]
  } catch {
    throw new RpcError('HISTORY_UNAVAILABLE', 'The native conversation database could not be read.')
  }
}

export async function discoverAntigravityWorkspaces(
  dbPath: string = join(homedir(), '.gemini/antigravity-cli/conversation_summaries.db'),
  baseDir: string = join(homedir(), '.gemini/antigravity-cli/brain'),
): Promise<string[]> {
  try {
    await fs.stat(dbPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new RpcError('HISTORY_UNAVAILABLE', 'The native workspace index could not be read.')
  }

  const sql = "SELECT conversation_id, workspace_uris, step_count, title FROM conversation_summaries ORDER BY step_count DESC;"
  const rows = await querySqliteJson<{ conversation_id: string; workspace_uris?: string; step_count?: number; title?: string }>(dbPath, sql)
  const paths = new Set<string>()

  for (const row of rows) {
    if (!row?.workspace_uris) continue
    if (!(row.step_count && row.step_count > 0) && !row.title?.trim() && !await readTranscriptSummary(baseDir, row.conversation_id)) continue
    try {
      const uris = JSON.parse(row.workspace_uris)
      if (Array.isArray(uris)) {
        for (const u of uris) {
          if (typeof u === 'string' && u.startsWith('file://')) {
            try {
              const p = fileURLToPath(u)
              const imageRelative = relative(AGY_IMAGE_ROOT, p)
              const imageCache = imageRelative === '' || (!isAbsolute(imageRelative)
                && imageRelative !== '..' && !imageRelative.startsWith(`..${sep}`))
              if (!imageCache) paths.add(p)
            } catch {
              // ignore
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  const verified: string[] = []
  for (const p of paths) {
    try {
      const s = await fs.stat(p)
      if (s.isDirectory()) verified.push(p)
    } catch {
      // ignore
    }
  }
  return verified
}

async function readTranscriptSummary(baseDir: string, conversationId: string): Promise<DiscoveredSession | undefined> {
  const path = await transcriptPath(baseDir, conversationId)
  if (path === undefined) return undefined
  try {
    const stat = await fs.stat(path)
    const handle = await fs.open(path, 'r')
    let firstLine: string
    try {
      const parts: Buffer[] = []
      let size = 0
      while (true) {
        const buffer = Buffer.alloc(Math.min(4096, MAX_AGENT_ACP_TRANSFER_BYTES + 1 - size))
        const { bytesRead } = await handle.read(buffer)
        if (!bytesRead) break
        const newline = buffer.subarray(0, bytesRead).indexOf(10)
        const part = buffer.subarray(0, newline < 0 ? bytesRead : newline)
        size += part.length
        if (size > MAX_AGENT_ACP_TRANSFER_BYTES) throw new RpcError('HISTORY_TOO_LARGE', 'The native transcript summary exceeds the history limit.')
        parts.push(part)
        if (newline >= 0) break
      }
      firstLine = Buffer.concat(parts).toString('utf8')
    } finally { await handle.close() }
    return parseSummary(firstLine, conversationId, stat.mtimeMs)
  } catch (error) {
    if (error instanceof RpcError) throw error
    throw new RpcError('HISTORY_UNAVAILABLE', 'The native transcript summary could not be read.')
  }
}

function parseSummary(firstLine: string, conversationId: string, mtimeMs: number): DiscoveredSession | undefined {
  if (!firstLine.trim()) return undefined
  let record: StepLogRecord
  try { record = JSON.parse(firstLine) as StepLogRecord }
  catch { throw new RpcError('HISTORY_INCOMPLETE', 'The native transcript summary contains an invalid record.') }
  if (!record || typeof record.type !== 'string' || (record.content !== undefined && typeof record.content !== 'string')) {
    throw new RpcError('HISTORY_INCOMPLETE', 'The native transcript summary contains an invalid record.')
  }
  // A leading system record still establishes a durable conversation.
  const title = record.type === 'USER_INPUT'
    ? cleanUserPrompt(record.content).split('\n')[0]?.trim().slice(0, 40) || (agyImageReferences(record.content ?? '').length > 0 ? 'Image' : 'Untitled Session')
    : 'Untitled Session'
  return { conversationId, title, createdAt: record.created_at ? new Date(record.created_at).getTime() : mtimeMs, updatedAt: mtimeMs }
}

interface LineageFile {
  ino: number
  size: number
  mtimeMs: number
  links: SubagentLink[]
  summary?: DiscoveredSession | null
}

const lineageIndexes = new Map<string, Map<string, LineageFile>>()

function subagentLinks(bytes: Buffer): SubagentLink[] {
  if (!bytes.includes('invoke_subagent')) return []
  const links: SubagentLink[] = []
  let calls: StepLogRecord['tool_calls']
  let index = 0
  for (const line of bytes.toString('utf8').split('\n')) {
    if (!line.trim()) continue
    let record: StepLogRecord
    try { record = JSON.parse(line) } catch { break } // An in-flight tail will be retried after the next append.
    if (record?.type === 'PLANNER_RESPONSE') {
      calls = Array.isArray(record.tool_calls) ? record.tool_calls : undefined
      index = 0
    } else if (record?.type === 'USER_INPUT') {
      calls = undefined
    } else if (record?.type === 'GENERIC' && calls) {
      const call = calls[index++]
      if (call?.name !== 'invoke_subagent' || typeof record.content !== 'string') continue
      const childId = /"conversationId"\s*:\s*"([a-zA-Z0-9_-]{1,256})"/.exec(record.content)?.[1]
      if (!childId) continue
      const role = typeof call.args?.Role === 'string' ? call.args.Role.trim() : ''
      const typeName = typeof call.args?.TypeName === 'string' ? call.args.TypeName.trim() : ''
      links.push({ childId, ...(role && { role }), ...(typeName && { typeName }) })
    }
  }
  return links
}

function readSmallTranscript(path: string, size: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const bytes = Buffer.allocUnsafe(size)
    if (readSync(fd, bytes, 0, size, 0) !== size) {
      throw new RpcError('HISTORY_INCOMPLETE', 'The native transcript changed during the read.')
    }
    return bytes
  } finally { closeSync(fd) }
}

async function scanLineage(baseDir: string, needsSummary: (id: string) => boolean) {
  const files = new Map<string, LineageFile>()
  const children = new Map<string, { parentNativeId: string; role?: string }>()
  let root: string
  let ids: string[]
  try {
    root = await fs.realpath(baseDir)
    ids = await fs.readdir(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { files, children }
    throw new RpcError('HISTORY_UNAVAILABLE', 'The native history directory could not be read.')
  }
  const previous = lineageIndexes.get(root)
  for (const id of ids) {
    if (id === 'tempmediaStorage' || !/^[a-zA-Z0-9_-]{1,256}$/.test(id)) continue
    const path = join(root, id, '.system_generated', 'logs', 'transcript.jsonl')
    let file: LineageFile | undefined
    try {
      if (realpathSync.native(path) !== path) continue
      const stat = statSync(path)
      if (!stat.isFile()) continue
      file = previous?.get(id)
      if (!file || file.ino !== stat.ino || file.size !== stat.size || file.mtimeMs !== stat.mtimeMs) {
        file = { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, links: [] }
        if (stat.size <= MAX_AGENT_ACP_TRANSFER_BYTES) {
          const bytes = stat.size <= 4096 ? readSmallTranscript(path, stat.size) : await readRange(path, stat, 0)
          file.links = subagentLinks(bytes)
          if (needsSummary(id)) {
            const end = bytes.indexOf(10)
            file.summary = parseSummary(bytes.toString('utf8', 0, end < 0 ? bytes.length : end), id, stat.mtimeMs) ?? null
          }
        }
      }
      if (needsSummary(id) && file.summary === undefined) file.summary = await readTranscriptSummary(baseDir, id) ?? null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') continue
      if (!needsSummary(id)) continue // Optional lineage must not hide a catalog row with a durable title.
      if (error instanceof RpcError) throw error
      throw new RpcError('HISTORY_UNAVAILABLE', 'The native transcript summary could not be read.')
    }
    files.set(id, file)
    for (const link of file.links) children.set(link.childId, { parentNativeId: id, role: link.role })
  }
  lineageIndexes.delete(root)
  lineageIndexes.set(root, files)
  if (lineageIndexes.size > MAX_CACHED_TRANSCRIPTS) lineageIndexes.delete(lineageIndexes.keys().next().value!)
  return { files, children }
}

function applyLineage(sessions: DiscoveredSession[], children: Map<string, { parentNativeId: string; role?: string }>) {
  return sessions.map(session => {
    const child = children.get(session.conversationId)
    if (!child) return session
    const defaultTitle = !session.title || session.title === 'Antigravity' || session.title === 'Untitled Session'
    return { ...session, parentNativeId: child.parentNativeId, ...(child.role && { agentRole: child.role }),
      title: defaultTitle && child.role ? child.role : session.title }
  })
}

export async function discoverAntigravitySessions(
  workspacePath: string,
  limit: number = 30,
  baseDir: string = join(homedir(), '.gemini/antigravity-cli/brain'),
  dbPath: string = join(homedir(), '.gemini/antigravity-cli/conversation_summaries.db'),
): Promise<DiscoveredSession[]> {
  const requestedWorkspace = workspacePath.trim() === '' ? undefined : resolve(workspacePath)
  // Database URIs provide workspace authority. Decode them before comparing so
  // percent-encoded names, path separators, and similarly named projects stay distinct.
  try {
    await fs.stat(dbPath)
    interface DbSessionRow {
      conversation_id: string
      title?: string
      workspace_uris?: string
      step_count?: number
      last_modified_time?: string
    }
    const rows = await querySqliteJson<DbSessionRow>(dbPath,
      'SELECT conversation_id, title, workspace_uris, step_count, last_modified_time FROM conversation_summaries ORDER BY last_modified_time DESC;')
    const scoped = requestedWorkspace === undefined ? rows : rows.filter(row => workspaceMatches(row.workspace_uris, requestedWorkspace))
    if (!scoped.length) return []
    const untitled = new Set(scoped.filter(row => !row.title?.trim()).map(row => row.conversation_id))
    const { files, children } = await scanLineage(baseDir, id => untitled.has(id))
    const summaries: DiscoveredSession[] = []
    for (const row of scoped) {
      const transcript = files.get(row.conversation_id)?.summary ?? undefined
      if (!row.step_count && !row.title?.trim()) {
        if (transcript !== undefined) summaries.push({ ...transcript })
        continue
      }
      const time = row.last_modified_time ? new Date(row.last_modified_time).getTime() : Date.now()
      summaries.push({
        conversationId: row.conversation_id,
        title: row.title?.trim() || transcript?.title || 'Untitled Session',
        createdAt: time,
        updatedAt: time,
      })
    }
    const selected = summaries.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
    for (const item of selected.slice(0, 32)) {
      const file = files.get(item.conversationId)
      if (file && file.mtimeMs > item.updatedAt) item.updatedAt = file.mtimeMs
    }
    return applyLineage(selected.sort((a, b) => b.updatedAt - a.updatedAt), children)
  } catch (error) {
    // Only an absent database permits an unscoped filesystem fallback. A
    // failed query cannot replace an established catalog with an empty list.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (requestedWorkspace !== undefined) throw new RpcError('HISTORY_UNAVAILABLE', 'The native workspace history index is unavailable.')
  }
  // A transcript alone does not establish which project it belongs to.
  if (requestedWorkspace !== undefined) throw new RpcError('HISTORY_UNAVAILABLE', 'The native workspace history index is unavailable.')

  const { files, children } = await scanLineage(baseDir, id => id.includes('-'))
  const results: DiscoveredSession[] = []
  for (const [id, file] of files) {
    if (id.includes('-') && file.summary) results.push({ ...file.summary })
  }
  results.sort((a, b) => b.updatedAt - a.updatedAt)
  return applyLineage(results.slice(0, limit), children)
}

function workspaceMatches(rawUris: string | undefined, requestedWorkspace: string): boolean {
  if (rawUris === undefined) return false
  try {
    const uris: unknown = JSON.parse(rawUris)
    return Array.isArray(uris) && uris.some(uri => {
      if (typeof uri !== 'string') return false
      try { return resolve(fileURLToPath(uri)) === requestedWorkspace } catch { return false }
    })
  } catch { return false }
}

/** Remote conversation ids can select only a real transcript inside the AGY brain. */
async function transcriptPath(baseDir: string, conversationId: string, name: 'transcript.jsonl' | 'transcript_full.jsonl' = 'transcript.jsonl'): Promise<string | undefined> {
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(conversationId)) return undefined
  try {
    const root = await fs.realpath(baseDir)
    const expected = join(root, conversationId, '.system_generated', 'logs', name)
    return await fs.realpath(expected) === expected ? expected : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new RpcError('HISTORY_UNAVAILABLE', 'The native transcript path could not be read.')
  }
}

/** True only when a valid non-symlink conversation directory has not written transcript.jsonl yet. */
export async function isUninitializedAntigravityTranscript(
  conversationId: string,
  baseDir: string = join(homedir(), '.gemini/antigravity-cli/brain'),
): Promise<boolean> {
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(conversationId)) return false
  try {
    const root = await fs.realpath(baseDir).catch(err => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return resolve(baseDir)
      throw err
    })
    const convDir = join(root, conversationId)
    const convStat = await fs.lstat(convDir).catch(err => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    })
    if (convStat !== null) {
      if (convStat.isSymbolicLink() || !convStat.isDirectory()) return false
      if (await fs.realpath(convDir) !== convDir) return false
    }
    const logPath = join(convDir, '.system_generated', 'logs', 'transcript.jsonl')
    const logStat = await fs.lstat(logPath).catch(err => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    })
    return logStat === null
  } catch {
    return false
  }
}
