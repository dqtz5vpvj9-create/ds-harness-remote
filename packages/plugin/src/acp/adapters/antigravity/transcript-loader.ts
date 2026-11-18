import { AGY_IMAGE_ROOT, stripAgyImageReferences, agyImageReferences, readAgyImage } from './image-store.js'
import { promises as fs } from 'node:fs'
import { MAX_AGENT_ACP_TRANSFER_BYTES } from '@dsh-remote/protocol'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import type { StepLogRecord } from './types.js'
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

export async function loadTranscriptEvents(
  conversationId: string,
  sessionId: string,
  baseDir: string = join(homedir(), '.gemini/antigravity-cli/brain'),
): Promise<HydratedSessionEvent[]> {
  const records = parseTranscript(await readTranscript(baseDir, conversationId, 'transcript.jsonl'))
  // AGY writes a compact transcript and an authoritative full companion.
  // Restore by native record identity, never by line position: either file can
  // be ahead while the CLI is appending. Missing full records remain an error.
  if (records.some(record => record.truncated_fields?.length)) {
    const full = parseTranscript(await readTranscript(baseDir, conversationId, 'transcript_full.jsonl').catch(error => {
      if (error instanceof RpcError && error.code === 'HISTORY_UNAVAILABLE') {
        throw new RpcError('HISTORY_INCOMPLETE', 'The full native transcript is unavailable.')
      }
      throw error
    }))
    const identity = (record: StepLogRecord) => JSON.stringify([record.step_index, record.type, record.created_at])
    const complete = new Map(full.map(record => [identity(record), record]))
    for (let index = 0; index < records.length; ++index) {
      const record = records[index]!
      if (!record.truncated_fields?.length) continue
      const restored = complete.get(identity(record))
      if (!restored && index === records.length - 1 && records.length > 1 && complete.size > 0) {
        // Live append race: compact transcript flushed its newest tail step just before transcript_full.jsonl.
        continue
      }
      if (!restored || restored.truncated_fields?.length
        || record.truncated_fields.some(field => !(field in restored))) {
        throw new RpcError('HISTORY_INCOMPLETE', 'The full native transcript has not completed this record.')
      }
      records[index] = restored
    }
  }
  const events: HydratedSessionEvent[] = []
  let currentSeq = 0
  let currentTurn = 0
  let turnOpen = false
  let currentStep = 1
  let plannerSeen = false

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

  for (const [recordIndex, record] of records.entries()) {
    const time = record.created_at ? new Date(record.created_at).getTime() : Date.now()

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

  return events
}

async function readTranscript(baseDir: string, conversationId: string, name: 'transcript.jsonl' | 'transcript_full.jsonl'): Promise<string> {
  try {
    const filePath = await transcriptPath(baseDir, conversationId, name)
    if (filePath === undefined) throw new RpcError('HISTORY_UNAVAILABLE', 'The native transcript is unavailable.')
    if ((await fs.stat(filePath)).size > MAX_AGENT_ACP_TRANSFER_BYTES) {
      throw new RpcError('HISTORY_TOO_LARGE', 'The native transcript exceeds the history transfer limit.')
    }
    const handle = await fs.open(filePath, 'r')
    try {
      const parts: Buffer[] = []
      let size = 0
      while (true) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_AGENT_ACP_TRANSFER_BYTES + 1 - size))
        const { bytesRead } = await handle.read(chunk)
        if (!bytesRead) break
        size += bytesRead
        if (size > MAX_AGENT_ACP_TRANSFER_BYTES) throw new RpcError('HISTORY_TOO_LARGE', 'The native transcript exceeds the history transfer limit.')
        parts.push(chunk.subarray(0, bytesRead))
      }
      return Buffer.concat(parts).toString('utf8')
    } finally { await handle.close() }
  } catch (error) {
    if (error instanceof RpcError) throw error
    throw new RpcError('HISTORY_UNAVAILABLE', 'The native transcript could not be read.')
  }
}

function parseTranscript(content: string): StepLogRecord[] {
  return content.split('\n').filter(line => line.trim()).map(line => {
    let record: StepLogRecord
    try { record = JSON.parse(line) as StepLogRecord }
    catch { throw new RpcError('HISTORY_INCOMPLETE', 'The native transcript contains an incomplete or invalid record.') }
    if (!record || typeof record !== 'object' || typeof record.type !== 'string') {
      throw new RpcError('HISTORY_INCOMPLETE', 'The native transcript contains an invalid record.')
    }
    return record
  })
}

export interface DiscoveredSession {
  conversationId: string
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
    return { conversationId, title, createdAt: record.created_at ? new Date(record.created_at).getTime() : stat.mtimeMs, updatedAt: stat.mtimeMs }
  } catch (error) {
    if (error instanceof RpcError) throw error
    throw new RpcError('HISTORY_UNAVAILABLE', 'The native transcript summary could not be read.')
  }
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
    const summaries: DiscoveredSession[] = []
    for (const row of rows) {
      if (requestedWorkspace !== undefined && !workspaceMatches(row.workspace_uris, requestedWorkspace)) continue
      const transcript = row.title?.trim() ? undefined : await readTranscriptSummary(baseDir, row.conversation_id)
      if (!row.step_count && !row.title?.trim()) {
        if (transcript !== undefined) summaries.push(transcript)
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
    await Promise.all(selected.slice(0, 32).map(async item => {
      try {
        const path = await transcriptPath(baseDir, item.conversationId)
        if (path) {
          const stat = await fs.stat(path)
          if (stat.mtimeMs > item.updatedAt) item.updatedAt = stat.mtimeMs
        }
      } catch {
        // ignore transient stat failure
      }
    }))
    return selected.sort((a, b) => b.updatedAt - a.updatedAt)
  } catch (error) {
    // Only an absent database permits an unscoped filesystem fallback. A
    // failed query cannot replace an established catalog with an empty list.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (requestedWorkspace !== undefined) throw new RpcError('HISTORY_UNAVAILABLE', 'The native workspace history index is unavailable.')
  }
  // A transcript alone does not establish which project it belongs to.
  if (requestedWorkspace !== undefined) throw new RpcError('HISTORY_UNAVAILABLE', 'The native workspace history index is unavailable.')

  // 2. Fallback to filesystem scanning
  let dirEntries: string[]
  try {
    dirEntries = await fs.readdir(baseDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new RpcError('HISTORY_UNAVAILABLE', 'The native history directory could not be read.')
  }

  const results: DiscoveredSession[] = []
  for (const entry of dirEntries) {
    if (entry === 'tempmediaStorage' || !entry.includes('-')) continue
    const summary = await readTranscriptSummary(baseDir, entry)
    if (summary !== undefined) results.push(summary)
  }

  results.sort((a, b) => b.updatedAt - a.updatedAt)
  return results.slice(0, limit)
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
