import { runScenarios } from '../../../scripts/test-scenarios.mjs'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { appendFile, rename, mkdtemp, mkdir, writeFile, rm, utimes, symlink, truncate } from 'node:fs/promises'
import { MAX_AGENT_ACP_TRANSFER_BYTES } from '@dsh-remote/protocol'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import {
  clearTranscriptLoaderCache,
  discoverAntigravitySessions,
  discoverAntigravityWorkspaces,
  loadTranscriptEvents,
} from '../src/acp/adapters/antigravity/transcript-loader.js'

let base: string

const prepareContract1 = async () => {
  base = await mkdtemp(join(tmpdir(), 'agy-transcript-test-'))
}
beforeEach(prepareContract1)

const cleanupContract2 = async () => {
  vi.restoreAllMocks()
  clearTranscriptLoaderCache()
  await rm(base, { recursive: true, force: true })
}
afterEach(cleanupContract2)

async function writeTranscript(conversationId: string, records: unknown[]): Promise<string> {
  const logs = join(base, conversationId, '.system_generated', 'logs')
  await mkdir(logs, { recursive: true })
  const path = join(logs, 'transcript.jsonl')
  await writeFile(path, records.map(record => JSON.stringify(record)).join('\n') + '\n')
  return path
}

function createDatabase() {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
  const dbPath = join(base, 'summaries.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT, title TEXT, workspace_uris TEXT, step_count INTEGER, last_modified_time TEXT)')
  return { db, dbPath }
}

const createdAt = '2026-10-07T00:00:00Z'

describe('TranscriptLoader', () => {
  it('hydrates durable timestamps, messages and tool identities', async () => {
    await runScenarios(
      [
        {
          name: 'restores the durable turn end timestamp instead of the history read time',
          run: async () => {
            await writeTranscript('conversation', [
              { type: 'USER_INPUT', step_index: 1, created_at: '2026-09-29T09:10:00Z', content: 'ping' },
              { type: 'PLANNER_RESPONSE', step_index: 2, created_at: '2026-09-29T09:10:04Z', content: 'pong' },
            ])
            const events = await loadTranscriptEvents('conversation', 'acp:conversation', base)
            expect(events.at(-1)?.event).toMatchObject({
              type: 'turn/end',
              time: Date.parse('2026-09-29T09:10:04Z'),
            })
            expect(await loadTranscriptEvents('conversation', 'acp:conversation', base)).toEqual(events)
          },
        },
        {
          name: 'hydrates user and assistant messages from an isolated transcript',
          run: async () => {
            await writeTranscript('fixture-conversation', [
              {
                type: 'USER_INPUT',
                step_index: 1,
                created_at: createdAt,
                content: '<USER_REQUEST>\n这个主机咋样\n</USER_REQUEST>',
              },
              { type: 'PLANNER_RESPONSE', step_index: 2, created_at: createdAt, content: '主机状态正常。' },
            ])
            const events = await loadTranscriptEvents(
              'fixture-conversation',
              'antigravity:fixture-conversation',
              base,
            )
            expect(events.find((e) => e.event.type === 'user/message')?.event.data).toMatchObject({
              content: [{ type: 'text', text: '这个主机咋样' }],
            })
            expect(events.find((e) => e.event.type === 'assistant/message')?.event.data).toMatchObject({
              message: {
                content: [{ type: 'text', text: '主机状态正常。' }],
                source: { kind: 'model', provider: 'antigravity', model: '' },
              },
              stream: [],
            })
          },
        },
        {
          name: 'hydrates tool calls with a valid name and callId, including unnamed tools',
          run: async () => {
            await writeTranscript('tool-conversation', [
              { type: 'USER_INPUT', step_index: 1, created_at: createdAt, content: 'Run the tool' },
              {
                type: 'PLANNER_RESPONSE',
                step_index: 2,
                created_at: createdAt,
                tool_calls: [{ name: 'view_file', args: { path: 'fixture.txt' } }, { args: {} }],
              },
            ])
            const events = await loadTranscriptEvents(
              'tool-conversation',
              'antigravity:tool-conversation',
              base,
            )
            const toolCalls = events.filter((e) => e.event.type === 'tool/call')
            expect(toolCalls.map((e) => e.event.data)).toMatchObject([
              { name: 'view_file', callId: '2:view_file' },
              { name: 'tool', callId: '2:tool' },
            ])
          },
        },
      ],
      async () => {
        await cleanupContract2()
        await prepareContract1()
      },
    )
  }, 15000)

  it('preserves every native planner response instead of overwriting one reader step', async () => {
    await writeTranscript('many-steps', [
      { type: 'USER_INPUT', step_index: 1, created_at: createdAt, content: 'Inspect then explain' },
      { type: 'PLANNER_RESPONSE', step_index: 2, created_at: createdAt, content: 'First finding' },
      { type: 'PLANNER_RESPONSE', step_index: 3, created_at: createdAt,
        tool_calls: [{ name: 'view_file', args: { path: 'fixture.txt' }, result: 'File contents' }] },
      { type: 'PLANNER_RESPONSE', step_index: 4, created_at: createdAt, content: 'Second finding' },
      { type: 'USER_INPUT', step_index: 5, created_at: createdAt, content: 'Continue' },
      { type: 'PLANNER_RESPONSE', step_index: 6, created_at: createdAt, content: 'Final finding' },
    ])
    const events = await loadTranscriptEvents('many-steps', 'acp:many-steps', base)
    const messages = events.filter(e => e.event.type === 'assistant/message').map(e => e.event.data as any)
    expect(messages.filter(m => m.message.content[0].type === 'text').map(m => [m.turn, m.step, m.message.content[0].text])).toEqual([
      [1, 1, 'First finding'], [1, 3, 'Second finding'], [2, 1, 'Final finding'],
    ])
    const tool = events.find(e => e.event.type === 'tool/call')!.event.data as any
    const result = events.find(e => e.event.type === 'tool/result')!.event.data as any
    expect([tool.turn, tool.step, result.turn, result.step]).toEqual([1, 2, 1, 2])
    expect(messages.find(m => m.step === 2)?.message.content).toEqual([{ type: 'tool-call', id: tool.callId, name: tool.name, arguments: tool.arguments }])
    expect(events.filter(e => e.event.type === 'step/start').map(e => e.event.data)).toEqual(
      events.filter(e => e.event.type === 'step/end').map(e => e.event.data),
    )
  })

  it('binds native GENERIC results to the exact planner batch and preserves failures', async () => {
    const planner = { type: 'PLANNER_RESPONSE', step_index: 1, created_at: createdAt,
      tool_calls: [{ name: 'shell', args: {} }, { name: 'view_file', args: {} }] }
    const failed = { type: 'GENERIC', step_index: 2, created_at: createdAt, status: 'DONE',
      content: 'Created At: example\nCompleted At: example\nCommand exited with code -1.\n\nfailure output' }
    const success = { type: 'GENERIC', step_index: 3, created_at: createdAt, status: 'DONE', content: 'complete file contents' }
    await writeTranscript('native-results', [planner, failed, success])
    const events = await loadTranscriptEvents('native-results', 'acp:native-results', base)
    expect(events.filter(e => e.event.type === 'tool/result').map(e => e.event.data)).toMatchObject([
      { message: { content: [{ toolCallId: '1:shell', isError: true, content: [{ text: failed.content }] }] } },
      { message: { content: [{ toolCallId: '1:view_file', content: [{ text: success.content }] }] } },
    ])
    await writeTranscript('native-results', [planner, failed])
    const partialLive = await loadTranscriptEvents('native-results', 'acp:native-results', base)
    expect(partialLive.filter(e => e.event.type === 'tool/call').map(e => e.event.data)).toMatchObject([
      { callId: '1:shell', status: 'failed' },
      { callId: '1:view_file', status: 'pending' },
    ])
    expect(partialLive.filter(e => e.event.type === 'tool/result')).toHaveLength(1)

    await writeTranscript('native-results', [planner, failed, { type: 'USER_INPUT', step_index: 4, created_at: createdAt, content: 'continue' }])
    const interrupted = await loadTranscriptEvents('native-results', 'acp:native-results', base)
    expect(interrupted.filter(e => e.event.type === 'tool/call').map(e => e.event.data)).toMatchObject([
      { callId: '1:shell', status: 'failed' },
      { callId: '1:view_file', status: 'failed' },
    ])
    expect(interrupted.filter(e => e.event.type === 'tool/result')).toHaveLength(2)
  })

  it('discovers workspace-scoped sessions from isolated durable sources', async () => {
    await runScenarios(
      [
        {
          name: 'recovers workspace-scoped durable conversations with empty AGY summaries',
          run: async () => {
            const workspace = join(base, 'project')
            const other = join(base, 'other')
            const empty = join(base, 'empty')
            for (const path of [workspace, other, empty]) await mkdir(path)
            const { db, dbPath } = createDatabase()
            try {
              const insert = db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)')
              for (const [id, path] of [
                ['stale-session', workspace],
                ['other-session', other],
                ['idle-session', empty],
                ['active-untitled', workspace],
              ]) {
                insert.run(id, '', JSON.stringify([pathToFileURL(path).href]), 0, createdAt)
              }
              db.prepare('UPDATE conversation_summaries SET step_count = 2 WHERE conversation_id = ?').run(
                'active-untitled',
              )
              insert.run(
                'normal-session',
                'Normal',
                JSON.stringify([pathToFileURL(workspace).href]),
                2,
                createdAt,
              )
            } finally {
              db.close()
            }
            for (const id of ['stale-session', 'other-session', 'active-untitled']) {
              await writeTranscript(id, [
                { type: 'USER_INPUT', step_index: 1, created_at: createdAt, content: 'Durable message' },
              ])
            }
            const sessions = await discoverAntigravitySessions(workspace, 30, base, dbPath)
            expect(sessions.map((session) => session.conversationId).sort()).toEqual([
              'active-untitled',
              'normal-session',
              'stale-session',
            ])
            expect(sessions.find((session) => session.conversationId === 'stale-session')?.title).toBe(
              'Durable message',
            )
            expect(sessions.find((session) => session.conversationId === 'active-untitled')?.title).toBe(
              'Durable message',
            )
            expect((await discoverAntigravityWorkspaces(dbPath, base)).sort()).toEqual(
              [workspace, other].sort(),
            )
          },
        },
        {
          name: 'discovers sessions from an isolated brain directory when the database is missing',
          run: async () => {
            for (const [id, title, time] of [
              ['older-session', 'Older conversation', 1_000],
              ['newer-session', 'Newer conversation', 2_000],
            ] as const) {
              const path = await writeTranscript(id, [
                { type: 'USER_INPUT', step_index: 1, created_at: createdAt, content: title },
              ])
              await utimes(path, time, time)
            }
            const dbPath = join(base, 'missing.db')
            const sessions = await discoverAntigravitySessions('', 10, base, dbPath)
            expect(sessions).toMatchObject([
              { conversationId: 'newer-session', title: 'Newer conversation', updatedAt: 2_000_000 },
              { conversationId: 'older-session', title: 'Older conversation', updatedAt: 1_000_000 },
            ])
            expect(await discoverAntigravitySessions('', 1, base, dbPath)).toEqual(sessions.slice(0, 1))
          },
        },
        {
          name: 'discovers only existing project directories from an isolated database',
          run: async () => {
            const project = join(base, 'project with spaces')
            const file = join(base, 'not-a-directory')
            await mkdir(project)
            await writeFile(file, 'fixture')
            const { db, dbPath } = createDatabase()
            try {
              const insert = db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)')
              insert.run(
                'project-session',
                'Project',
                JSON.stringify([
                  pathToFileURL(project).href,
                  pathToFileURL(project).href,
                  pathToFileURL(file).href,
                  pathToFileURL(join(base, 'missing-project')).href,
                  'https://example.invalid/project',
                ]),
                2,
                createdAt,
              )
              insert.run('malformed-session', 'Malformed', 'not-json', 2, createdAt)
            } finally {
              db.close()
            }
            expect(await discoverAntigravityWorkspaces(dbPath, base)).toEqual([project])
          },
        },
        {
          name: 'matches decoded workspace URIs exactly and applies the limit after scoping',
          run: async () => {
            const project = join(base, '项目 with spaces')
            const other = `${project}-other`
            const { db, dbPath } = createDatabase()
            try {
              const insert = db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)')
              insert.run(
                'foreign-session',
                'Foreign',
                JSON.stringify([pathToFileURL(other).href]),
                2,
                '2026-10-07T00:01:00Z',
              )
              insert.run('local-session', 'Local', JSON.stringify([pathToFileURL(project).href]), 2, createdAt)
              insert.run('malformed-session', 'Malformed', 'not-json', 2, createdAt)
            } finally {
              db.close()
            }
            expect(await discoverAntigravitySessions(project, 1, base, dbPath)).toMatchObject([
              { conversationId: 'local-session', title: 'Local' },
            ])
            expect(await discoverAntigravitySessions(join(base, 'unrelated'), 10, base, dbPath)).toEqual([])
          },
        },
        {
          name: 'does not infer a workspace from unrelated transcripts when the database is missing',
          run: async () => {
            await writeTranscript('foreign-session', [
              { type: 'USER_INPUT', step_index: 1, created_at: createdAt, content: 'Foreign' },
            ])
            await expect(
              discoverAntigravitySessions(join(base, 'project'), 10, base, join(base, 'missing.db')),
            ).rejects.toMatchObject({ code: 'HISTORY_UNAVAILABLE' })
          },
        },
      ],
      async () => {
        await cleanupContract2()
        await prepareContract1()
      },
    )
  }, 25000)

  it('rejects traversal and symlinked transcripts outside the AGY brain', async () => {
    await writeTranscript('outside-session', [{ type: 'USER_INPUT', step_index: 1, created_at: createdAt, content: 'Outside' }])
    const brain = join(base, 'brain')
    await mkdir(brain)
    await symlink(join(base, 'outside-session'), join(brain, 'linked-session'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(loadTranscriptEvents('../outside-session', 'remote', brain)).rejects.toMatchObject({ code: 'HISTORY_UNAVAILABLE' })
    await expect(loadTranscriptEvents('..\\outside-session', 'remote', brain)).rejects.toMatchObject({ code: 'HISTORY_UNAVAILABLE' })
    await expect(loadTranscriptEvents('linked-session', 'remote', brain)).rejects.toMatchObject({ code: 'HISTORY_UNAVAILABLE' })
    expect(await discoverAntigravitySessions('', 10, brain, join(base, 'missing.db'))).toEqual([])
  })

  it('distinguishes empty history from missing, corrupt, incomplete and oversized history', async () => {
    const path = await writeTranscript('conversation', [])
    expect(await loadTranscriptEvents('conversation', 'remote', base)).toEqual([])
    await expect(loadTranscriptEvents('missing', 'remote', base)).rejects.toMatchObject({ code: 'HISTORY_UNAVAILABLE' })
    for (const broken of ['{"type":"USER_INPUT"}\n{', '{invalid}\n', 'null\n']) {
      await writeFile(path, broken)
      await expect(loadTranscriptEvents('conversation', 'remote', base)).rejects.toMatchObject({ code: 'HISTORY_INCOMPLETE' })
    }
    await truncate(path, MAX_AGENT_ACP_TRANSFER_BYTES + 1)
    await expect(loadTranscriptEvents('conversation', 'remote', base)).rejects.toMatchObject({ code: 'HISTORY_TOO_LARGE' })
  })

  it('preserves tool output and reasoning without text, and distinguishes duplicate tool calls', async () => {
    await writeTranscript('conversation', [{ type: 'PLANNER_RESPONSE', step_index: 2, created_at: createdAt,
      thinking: 'The only recorded content', tool_calls: [
        { name: 'shell', args: { command: 'first' }, result: 'first\noutput', status: 'SUCCESS' },
        { name: 'shell', args: { command: 'second' }, result: { exitCode: 2 }, status: 'ERROR' },
      ],
    }])
    const events = await loadTranscriptEvents('conversation', 'remote', base)
    expect(events.filter(row => row.event.type === 'tool/call').map(row => row.event.data)).toMatchObject([
      { callId: '2:shell' }, { callId: '2:shell:1' },
    ])
    expect(events.filter(row => row.event.type === 'tool/result').map(row => row.event.data)).toMatchObject([
      { message: { content: [{ toolCallId: '2:shell', content: [{ text: 'first\noutput' }] }] } },
      { message: { content: [{ toolCallId: '2:shell:1', isError: true, content: [{ text: '{"exitCode":2}' }] }] } },
    ])
    expect(events.find(row => row.event.type === 'assistant/message')?.event.data).toMatchObject({
      message: { content: [{ type: 'reasoning', text: 'The only recorded content' },
        { type: 'tool-call', id: '2:shell', name: 'shell', arguments: '{"command":"first"}' },
        { type: 'tool-call', id: '2:shell:1', name: 'shell', arguments: '{"command":"second"}' }] },
    })
  })

  it('reports damaged databases and truncated records without erasing existing history', async () => {
    const dbPath = join(base, 'broken.db')
    await writeFile(dbPath, 'not a database')
    await expect(discoverAntigravitySessions('', 30, base, dbPath)).rejects.toMatchObject({ code: 'HISTORY_UNAVAILABLE' })
    await writeTranscript('conversation', [{ type: 'PLANNER_RESPONSE', step_index: 1,
      created_at: createdAt, content: 'partial', truncated_fields: ['content'],
    }])
    await expect(loadTranscriptEvents('conversation', 'remote', base)).rejects.toMatchObject({ code: 'HISTORY_INCOMPLETE' })
  })

  it('keeps long first prompts in the catalog and surfaces corrupt summaries', async () => {
    const title = 'A very long real first prompt '
    const path = await writeTranscript('long-conversation', [{ type: 'USER_INPUT', step_index: 1,
      created_at: createdAt, content: title + 'x'.repeat(12000),
    }])
    const dbPath = join(base, 'missing.db')
    expect(await discoverAntigravitySessions('', 30, base, dbPath)).toMatchObject([
      { conversationId: 'long-conversation', title: (title + 'x'.repeat(40)).slice(0, 40) },
    ])
    await writeFile(path, '{broken')
    await expect(discoverAntigravitySessions('', 30, base, dbPath)).rejects.toMatchObject({ code: 'HISTORY_INCOMPLETE' })
  })

})

it('restores truncated native records from the full companion without losing later messages', async () => {
  const full = { type: 'PLANNER_RESPONSE', step_index: 2, created_at: createdAt,
    content: 'Complete answer '.repeat(1000), thinking: 'Complete reasoning',
    tool_calls: [{ name: 'shell', args: { command: 'printf complete' }, result: 'complete output', status: 'SUCCESS' }] }
  await writeTranscript('conversation', [
    { type: 'USER_INPUT', step_index: 1, created_at: createdAt, content: 'Read history' },
    { ...full, content: 'Complete…', tool_calls: [], truncated_fields: ['content', 'tool_calls'] },
    { type: 'PLANNER_RESPONSE', step_index: 3, created_at: createdAt, content: 'Newer than full companion' },
  ])
  const path = join(base, 'conversation', '.system_generated', 'logs', 'transcript_full.jsonl')
  await writeFile(path, JSON.stringify(full) + '\n')
  const events = await loadTranscriptEvents('conversation', 'remote', base)
  const messages = events.filter(row => row.event.type === 'assistant/message').map(row => row.event.data)
  expect(messages).toMatchObject([
    { message: { content: [{ type: 'reasoning', text: full.thinking }, { type: 'text', text: full.content },
      { type: 'tool-call', id: '2:shell', name: 'shell', arguments: '{"command":"printf complete"}' }] } },
    { message: { content: [{ type: 'text', text: 'Newer than full companion' }] } },
  ])
  expect(events.find(row => row.event.type === 'tool/result')?.event.data).toMatchObject({
    message: { content: [{ content: [{ text: 'complete output' }] }] },
  })
  for (const wrong of [{ ...full, step_index: 7 }, { ...full, type: 'USER_INPUT' },
    { ...full, created_at: '2026-10-08T00:00:00Z' }, { ...full, truncated_fields: ['content'] },
    { ...full, content: undefined }]) {
    await writeFile(path, JSON.stringify(wrong) + '\n')
    await expect(loadTranscriptEvents('conversation', 'remote', base)).rejects.toMatchObject({ code: 'HISTORY_INCOMPLETE' })
  }
  await writeFile(path, JSON.stringify(full) + '\n{unfinished')
  await expect(loadTranscriptEvents('conversation', 'remote', base)).rejects.toMatchObject({ code: 'HISTORY_INCOMPLETE' })
  await truncate(path, MAX_AGENT_ACP_TRANSFER_BYTES + 1)
  await expect(loadTranscriptEvents('conversation', 'remote', base)).rejects.toMatchObject({ code: 'HISTORY_TOO_LARGE' })
})

it('does not follow a full transcript symlink outside the native conversation', async () => {
  await writeTranscript('conversation', [{ type: 'PLANNER_RESPONSE', step_index: 1, created_at: createdAt,
    content: 'partial', truncated_fields: ['content'] }])
  const outside = join(base, 'outside.jsonl')
  await writeFile(outside, JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 1, created_at: createdAt, content: 'outside' }))
  await symlink(outside, join(base, 'conversation', '.system_generated', 'logs', 'transcript_full.jsonl'))
  await expect(loadTranscriptEvents('conversation', 'remote', base)).rejects.toMatchObject({ code: 'HISTORY_INCOMPLETE' })
})

function traceFileReads() {
  const reads: Array<{ path: string; start: number; length: number }> = []
  const open = fs.open.bind(fs)
  const opens = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const path = String(args[0])
    const handle = await open(...args)
    const read = handle.read.bind(handle)
    vi.spyOn(handle, 'read').mockImplementation(async (...args: Parameters<typeof read>) => {
      const [, , length, position] = args as unknown as [Buffer, number, number, number]
      reads.push({ path, start: position, length })
      return read(...args)
    })
    return handle
  })
  return { reads, opens }
}

it('reuses event identities and reads only validated byte ranges in both JSONL files', async () => {
  const user = { type: 'USER_INPUT', step_index: 0, created_at: createdAt, content: '开始' }
  const planner = { type: 'PLANNER_RESPONSE', step_index: 1, created_at: createdAt, content: '完整' }
  const path = await writeTranscript('incremental', [user, { ...planner, truncated_fields: ['content'] }])
  const fullPath = join(path, '..', 'transcript_full.jsonl')
  await writeFile(fullPath, JSON.stringify(planner) + '\n')
  const { reads, opens } = traceFileReads()
  const load = () => loadTranscriptEvents('incremental', 'session', base)
  const first = await load()
  const initialSizes = new Map(reads.map(read => [read.path, read.length]))
  reads.length = 0
  opens.mockClear()
  const warm = await load()
  expect(opens).not.toHaveBeenCalled()
  expect(warm[0]).not.toBe(first[0])
  expect(warm.every((row, i) => row.event === first[i]!.event)).toBe(true)

  const second = { ...planner, step_index: 2, content: 'later Ω' }
  const compactLine = JSON.stringify({ ...second, content: '…', truncated_fields: ['content'] }) + '\n'
  await appendFile(path, compactLine)
  const partial = await load()
  expect(reads.splice(0)).toEqual([{ path, start: initialSizes.get(path), length: Buffer.byteLength(compactLine) }])
  expect(partial.find(row => row.event.type === 'assistant/message')!.event)
    .toBe(first.find(row => row.event.type === 'assistant/message')!.event)
  expect(JSON.stringify(partial)).toContain('…')

  const fullLine = JSON.stringify(second) + '\n'
  await appendFile(fullPath, fullLine.slice(0, -4))
  await expect(load()).rejects.toMatchObject({ code: 'HISTORY_INCOMPLETE' })
  await appendFile(fullPath, fullLine.slice(-4))
  const complete = await load()
  expect(reads.map(read => [read.path, read.start])).toEqual(Array(2).fill([fullPath, initialSizes.get(fullPath)]))
  expect(JSON.stringify(complete)).toContain('later Ω')
  expect(JSON.stringify(complete)).not.toContain('…')
  expect(complete.slice(0, 5).every((row, i) => row.event === first[i]!.event)).toBe(true)
  const other = await loadTranscriptEvents('incremental', 'other', base)
  expect(JSON.stringify(other)).toContain('other:1')
})

it('recovers partial UTF-8 appends, no-newline records, rotation, truncation and same-size rewrites', async () => {
  const user = (content: string) => ({ type: 'USER_INPUT', step_index: 1, created_at: createdAt, content })
  const path = await writeTranscript('changes', [])
  await writeFile(path, JSON.stringify(user('one')))
  const load = () => loadTranscriptEvents('changes', 's', base)
  await load()
  const { reads } = traceFileReads()
  const start = (await fs.stat(path)).size
  const line = Buffer.from('\n' + JSON.stringify(user('第二')) + '\n')
  const cut = line.indexOf(Buffer.from('二')) + 1
  await appendFile(path, line.subarray(0, cut))
  await expect(load()).rejects.toMatchObject({ code: 'HISTORY_INCOMPLETE' })
  await appendFile(path, line.subarray(cut))
  expect(JSON.stringify(await load())).toContain('第二')
  expect(reads.map(read => read.start)).toEqual([start, start + 1])

  await writeFile(path, JSON.stringify(user('two')))
  expect(JSON.stringify(await load())).toContain('two')
  await writeFile(path, JSON.stringify(user('six')))
  await utimes(path, 1000, 1000)
  expect(JSON.stringify(await load())).toContain('six')
  await appendFile(path, JSON.stringify(user('bad')))
  await expect(load()).rejects.toMatchObject({ code: 'HISTORY_INCOMPLETE' })
  await rename(path, path + '.old')
  await writeFile(path, JSON.stringify(user('replacement')))
  expect(JSON.stringify(await load())).toContain('replacement')
  expect(reads.at(-1)?.start).toBe(0)
})

it('evicts the least recently loaded conversation after 96 entries', async () => {
  const load = (id: string) => loadTranscriptEvents(id, 's', base)
  for (let i = 0; i < 96; i++) {
    await writeTranscript('chat-' + i, [])
    await load('chat-' + i)
  }
  await load('chat-0')
  await writeTranscript('chat-96', [])
  await load('chat-96')
  const open = vi.spyOn(fs, 'open')
  await load('chat-0')
  expect(open).not.toHaveBeenCalled()
  await load('chat-1')
  expect(open).toHaveBeenCalledTimes(1)
})

it('discovers child roles from ordered tool returns, including parents outside the page', async () => {
  const role = 'Frontend & UX Auditor'
  const spawn = (Role: string) => ({ name: 'invoke_subagent', args: { Prompt: 'audit', Role, TypeName: 'reviewer' } })
  const created = (id: string) => ({ type: 'GENERIC', content: 'Created the following subagent:\n{ "conversationId":  "' + id + '" }' })
  const path = await writeTranscript('parent-chat', [
    { type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'other' }, spawn(role), spawn('Named child')] },
    created('unrelated-chat'), { type: 'CHECKPOINT' }, created('child-chat'), created('named-chat'),
    { type: 'PLANNER_RESPONSE', tool_calls: [spawn('Interrupted')] }, { type: 'USER_INPUT' }, created('unrelated-chat'),
  ])
  const { db, dbPath } = createDatabase()
  try {
    const row = db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, 1, ?)')
    for (const [id, title] of [['child-chat', 'Antigravity'], ['named-chat', 'Keep me'], ['unrelated-chat', 'Untitled Session']]) {
      row.run(id!, title!, JSON.stringify([pathToFileURL(base).href]), createdAt)
    }
  } finally { db.close() }
  const discover = () => discoverAntigravitySessions(base, 3, base, dbPath)
  const sessions = await discover()
  expect(sessions.find(s => s.conversationId === 'child-chat')).toMatchObject({ parentNativeId: 'parent-chat', agentRole: role, title: role })
  expect(sessions.find(s => s.conversationId === 'named-chat')).toMatchObject({ parentNativeId: 'parent-chat', agentRole: 'Named child', title: 'Keep me' })
  expect(sessions.find(s => s.conversationId === 'unrelated-chat')).not.toHaveProperty('parentNativeId')
  expect(await discover()).toEqual(sessions)
  await writeFile(path, JSON.stringify({ type: 'SYSTEM' }) + '\n')
  expect((await discover()).every(s => !s.parentNativeId && !s.agentRole)).toBe(true)
})

it('passes stable local history and discovered lineage through the virtual Harness', async () => {
  const { AgentAcpClient } = await import('@dsh-remote/client-core')
  const { AcpVirtualHarness } = await import('../src/acp/virtual-harness.js')
  const path = await writeTranscript('child', [{ type: 'USER_INPUT', step_index: 1, created_at: createdAt, content: 'hello' }])
  let role = 'Frontend & UX Auditor'
  const client = new AgentAcpClient({
    onEvent: () => () => {},
    async rpc<T>(_name: string, input: unknown): Promise<T> {
      const { method } = input as { method: string }
      if (method === 'dsh/workspaceList') return [{ path: base }] as T
      if (method === 'dsh/sessionList') return { items: [
        { conversationId: 'child', title: 'Antigravity', parentNativeId: 'parent', agentRole: role, createdAt: 1, updatedAt: 1 },
      ] } as T
      if (method === 'dsh/sessionHistory') return { events: await loadTranscriptEvents('child', 'acp:child', base) } as T
      throw new Error('Unexpected source method')
    },
  })
  const facade = new AcpVirtualHarness(client, { deviceId: 'host', name: 'Host' }, 'antigravity')
  try {
    expect(await facade.sourceCatalog()).toMatchObject([{ title: role, parentNativeId: 'parent', agentRole: role }])
    const first = await facade.sourceSnapshot('child')
    role = 'Second role'
    expect(await facade.sourceCatalog()).toMatchObject([{ title: role, agentRole: role }])
    const warm = await facade.sourceSnapshot('child')
    expect(warm.entries.every((e, i) => e.event === first.entries[i]!.event)).toBe(true)
    await appendFile(path, JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 2, created_at: createdAt, thinking: 'thinking' }) + '\n')
    const live = await facade.sourceSnapshot('child')
    expect(live.entries[2]!.event).toBe(first.entries[2]!.event)
    expect(JSON.stringify(live.entries)).toContain('thinking')
  } finally { await facade.close() }
})

it('keeps unchanged large transcripts and a 160-session lineage index warm', async () => {
  const planner = { type: 'PLANNER_RESPONSE', created_at: createdAt, content: 'x'.repeat(4096) }
  await writeTranscript('big', Array.from({ length: 1000 }, (_, step_index) => ({ ...planner, step_index })))
  const original = await loadTranscriptEvents('big', 's', base)
  expect(original.length).toBeGreaterThanOrEqual(3000)
  const timings: number[] = []
  for (let i = 0; i < 9; ++i) {
    const start = performance.now()
    const warm = await loadTranscriptEvents('big', 's', base)
    timings.push(performance.now() - start)
    expect(warm[2000]!.event).toBe(original[2000]!.event)
  }
  const brain = join(base, 'catalog')
  for (let i = 0; i < 160; ++i) {
    const dir = join(brain, 'session-' + i, '.system_generated/logs')
    await mkdir(dir, { recursive: true })
    const spawn = [{ type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'invoke_subagent', args: { Role: 'Reviewer' } }] },
      { type: 'GENERIC', content: 'Created the following subagent:\n{"conversationId":"session-1"}' }]
    const content = i === 0 ? spawn.map(row => JSON.stringify(row)).join('\n') : '{"type":"SYSTEM"}'
    await writeFile(join(dir, 'transcript.jsonl'), content + '\n')
  }
  const discover = () => discoverAntigravitySessions('', 160, brain, join(base, 'missing.db'))
  const start = performance.now()
  const cold = await discover()
  const coldMs = performance.now() - start
  expect(cold).toHaveLength(160)
  expect(cold.find(s => s.conversationId === 'session-1')).toMatchObject({ parentNativeId: 'session-0', title: 'Reviewer' })
  const warmTimings: number[] = []
  for (let i = 0; i < 9; ++i) {
    const now = performance.now()
    const warm = await discover()
    warmTimings.push(performance.now() - now)
    expect(warm).toEqual(cold)
  }
  const median = (samples: number[]) => samples.sort((a, b) => a - b)[4]!.toFixed(2)
  console.info(`Transcript warm median ${median(timings)} ms, 160-session discovery cold ${coldMs.toFixed(2)} ms / warm median ${median(warmTimings)} ms`)
})

it('replays a live planner batch when returns settle and an older full record is corrected', async () => {
  const planner = { type: 'PLANNER_RESPONSE', step_index: 1, created_at: createdAt,
    tool_calls: [{ name: 'first', args: {} }, { name: 'second', args: {} }] }
  const returned = { type: 'GENERIC', step_index: 2, created_at: createdAt, content: 'old result' }
  const path = await writeTranscript('batch', [planner])
  const full = join(path, '..', 'transcript_full.jsonl')
  const load = () => loadTranscriptEvents('batch', 's', base)
  const first = await load()
  await writeFile(full, JSON.stringify(returned) + '\n')
  await appendFile(path, JSON.stringify({ ...returned, content: 'old…', truncated_fields: ['content'] }) + '\n')
  const live = await load()
  expect(live.find(e => e.event.type === 'assistant/message')!.event).toBe(first.find(e => e.event.type === 'assistant/message')!.event)
  expect(live.filter(e => e.event.type === 'tool/call').map(e => e.event.data)).toMatchObject([{ status: 'finished' }, { status: 'pending' }])
  await appendFile(path, JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 4, created_at: createdAt, content: 'next step' }) + '\n')
  const settled = await load()
  expect(settled.filter(e => e.event.type === 'tool/call').map(e => e.event.data)).toMatchObject([{ status: 'finished' }, { status: 'failed' }])
  await appendFile(full, JSON.stringify({ ...returned, content: 'corrected result' }) + '\n')
  const revised = await load()
  expect(revised[0]!.event).toBe(first[0]!.event)
  expect(JSON.stringify(revised)).toContain('corrected result')
  expect(JSON.stringify(revised)).not.toContain('old result')
})
