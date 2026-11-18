import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AntigravityAcpClient, antigravitySpawnEnv } from '../src/acp/adapters/antigravity-process.js'
import { parseAgyModels } from '../src/acp/adapters/antigravity/models.js'

let directory: string
let client: AntigravityAcpClient | undefined
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'agy-detox-')) })
afterEach(async () => {
  await client?.close()
  client = undefined
  vi.useRealTimers()
  await rm(directory, { recursive: true, force: true })
})

it('selects SSH token storage for Linux headless launches and existing file tokens', async () => {
  const desktop = { HOME: directory, WAYLAND_DISPLAY: 'wayland-0' }
  expect(antigravitySpawnEnv(desktop)).toBe(desktop)
  const headless = { HOME: directory }
  if (process.platform === 'linux') expect(antigravitySpawnEnv(headless).SSH_CONNECTION).toBe('127.0.0.1 0 127.0.0.1 22')
  else expect(antigravitySpawnEnv(headless)).toBe(headless)
  const tokenDir = join(directory, '.gemini/antigravity-cli')
  await mkdir(tokenDir, { recursive: true })
  await writeFile(join(tokenDir, 'antigravity-oauth-token'), '')
  for (const env of [desktop, { HOME: directory }]) {
    if (process.platform === 'linux') {
      expect(antigravitySpawnEnv(env)).toEqual({ ...env, SSH_CONNECTION: '127.0.0.1 0 127.0.0.1 22' })
    } else expect(antigravitySpawnEnv(env)).toBe(env)
  }
  for (const key of ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY']) {
    const ssh = { HOME: directory, [key]: 'existing' }
    expect(antigravitySpawnEnv(ssh)).toBe(ssh)
  }
})

function fixture() {
  const workers: { args: string[]; cwd?: string; stdin: PassThrough; stdout: PassThrough; kill: ReturnType<typeof vi.fn> }[] = []
  client = new AntigravityAcpClient('agy', undefined, (_binary, args, cwd) => {
    const events = new EventEmitter()
    const stdin = new PassThrough(), stdout = new PassThrough()
    const kill = vi.fn(() => { events.emit('exit', 0); return true })
    workers.push({ args, cwd, stdin, stdout, kill })
    const conversation = args.indexOf('--conversation')
    const id = conversation < 0 ? 'fresh-' + workers.length : args[conversation + 1]
    queueMicrotask(() => stdout.write(JSON.stringify({ event: 'init', conversation_id: id }) + '\n'))
    return Object.assign(events, { stdin, stdout, stderr: new PassThrough(), exitCode: null, kill }) as unknown as ChildProcessWithoutNullStreams
  }, { brainDir: directory, idleTimeoutMs: 1000, readModels: async () => parseAgyModels('model-high\tModel (High)') })
  return { host: client, resumed: () => workers.filter(w => w.args.includes('saved')) }
}

it('recycles a stale conversation with its model and keeps the new result baseline', async () => {
  const logs = join(directory, 'saved/.system_generated/logs')
  const transcript = join(logs, 'transcript.jsonl')
  await mkdir(logs, { recursive: true })
  await writeFile(transcript, '')
  await utimes(transcript, 100, 100)
  const { host, resumed } = fixture()
  const params = { sessionId: 'saved', prompt: [{ type: 'text', text: 'hello' }] }
  await host.call('dsh/selectModel', { ...params, model: 'model', reasoningEffort: 'high', cwd: directory })
  await utimes(transcript, 101, 101)
  const first = host.call('session/prompt', params)
  await vi.waitFor(() => expect(resumed()[1]?.stdin.readableLength).toBeGreaterThan(0))
  expect(resumed()[0]!.kill).toHaveBeenCalledOnce()
  expect(resumed()[1]!.args).toContain('model-high')
  expect(resumed()[1]!.cwd).toBe(directory)
  await utimes(transcript, 102, 102)
  const result = '{"event":"result","result":{"status":"SUCCESS"}}\n'
  resumed()[1]!.stdout.write(result)
  await first
  resumed()[1]!.stdin.read()
  const second = host.call('session/prompt', params)
  await vi.waitFor(() => expect(resumed()[1]?.stdin.readableLength).toBeGreaterThan(0))
  resumed()[1]!.stdout.write(result)
  await second
  expect(resumed()).toHaveLength(2)
})

it('evicts idle workers after load and result, and protects in-flight prompts', async () => {
  vi.useFakeTimers()
  const { host, resumed } = fixture()
  const params = { sessionId: 'saved', cwd: directory }
  await host.call('session/load', params)
  await vi.advanceTimersByTimeAsync(1000)
  expect(resumed()[0]!.kill).toHaveBeenCalledOnce()
  const turn = host.call('session/prompt', { sessionId: 'saved', prompt: [] })
  await vi.waitFor(() => expect(resumed()[1]?.stdin.readableLength).toBeGreaterThan(0))
  await vi.advanceTimersByTimeAsync(2000)
  expect(resumed()[1]!.kill).not.toHaveBeenCalled()
  expect(resumed()[1]!.cwd).toBe(directory)
  resumed()[1]!.stdout.write('{"event":"result","result":{}}\n')
  await turn
  await vi.advanceTimersByTimeAsync(1000)
  expect(resumed()[1]!.kill).toHaveBeenCalledOnce()
})
