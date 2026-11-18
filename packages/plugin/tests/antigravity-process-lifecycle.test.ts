import { EventEmitter, once } from 'node:events'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it } from 'vitest'
import { AntigravityAcpClient, antigravitySpawnEnv } from '../src/acp/adapters/antigravity-process.js'
import { parseAgyModels } from '../src/acp/adapters/antigravity/models.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
})

async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'agy-lifecycle-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

it('selects SSH file storage on Linux only for a headless environment or an existing token', async () => {
  const home = await directory()
  const desktop = { HOME: home, DISPLAY: ':0' }
  const ssh = '127.0.0.1 0 127.0.0.1 22'
  expect(antigravitySpawnEnv(desktop)).toBe(desktop)
  expect(antigravitySpawnEnv({}, home).SSH_CONNECTION).toBe(process.platform === 'linux' ? ssh : undefined)
  const cli = join(home, '.gemini/antigravity-cli')
  await mkdir(cli, { recursive: true })
  await writeFile(join(cli, 'antigravity-oauth-token'), '')
  expect(antigravitySpawnEnv(desktop).SSH_CONNECTION).toBe(process.platform === 'linux' ? ssh : undefined)
  for (const key of ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY']) {
    const env = { ...desktop, [key]: 'existing' }
    expect(antigravitySpawnEnv(env)).toBe(env)
  }
})

function fakeChild(id: string, args: string[], cwd?: string) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    id, args, cwd, killed: false, exitCode: null,
    kill() { this.killed = true; this.emit('exit', null, 'SIGTERM'); return true },
  })
  queueMicrotask(() => child.stdout.write(JSON.stringify({ event: 'init', conversation_id: id }) + '\n'))
  return child
}

async function fixture(idleTimeoutMs?: number) {
  const brainDir = await directory()
  const children: ReturnType<typeof fakeChild>[] = []
  const client = new AntigravityAcpClient('agy', undefined, (_bin, args, cwd) => {
    const index = args.indexOf('--conversation')
    const id = index < 0 ? 'new-' + children.length : args[index + 1]!
    const child = fakeChild(id, args, cwd)
    children.push(child)
    return child as unknown as ChildProcessWithoutNullStreams
  }, { brainDir, conversationId: 'initial', idleTimeoutMs,
    readModels: async () => parseAgyModels('model-high\tModel (High)') })
  cleanup.push(() => client.close())
  return { brainDir, client, latest: (id: string) => children.filter(child => child.id === id).at(-1)! }
}

it.each(['initial', 'loaded'])('reloads %s after an external transcript update', async sessionId => {
  const { brainDir, client, latest } = await fixture()
  const logs = join(brainDir, sessionId, '.system_generated/logs')
  await mkdir(logs, { recursive: true })
  const path = join(logs, 'transcript.jsonl')
  await writeFile(path, '')
  await utimes(path, 100, 100)
  await client.call('session/load', { sessionId })
  if (sessionId === 'loaded') await client.call('dsh/selectModel', { sessionId, model: 'model' })
  const original = latest(sessionId)
  const prompt = () => client.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'continue' }] })
  const finish = (child: typeof original) => child.stdout.write('{"event":"result","result":{"status":"SUCCESS"}}\n')
  const sent = once(original.stdin, 'data')
  const first = prompt()
  await sent
  await utimes(path, 101, 101)
  finish(original)
  await first
  const sentAgain = once(original.stdin, 'data')
  const second = prompt()
  await sentAgain
  finish(original)
  await second
  await utimes(path, 102, 102)
  const next = prompt()
  await expect.poll(() => latest(sessionId) !== original && latest(sessionId).stdin.readableLength > 0).toBe(true)
  expect(original.killed).toBe(true)
  if (sessionId === 'loaded') expect(latest(sessionId).args).toContain('model-high')
  finish(latest(sessionId))
  await next
})

it('evicts idle workers, keeps a pending turn alive, and resumes in the original directory', async () => {
  const { client, brainDir, latest } = await fixture(80)
  const sessionId = 'loaded'
  await client.call('session/load', { sessionId, cwd: brainDir })
  const child = latest(sessionId)
  const sent = once(child.stdin, 'data')
  const prompt = client.call('session/prompt', { sessionId, prompt: [] })
  await sent
  await delay(120)
  expect(child.killed).toBe(false)
  child.stdout.write('{"event":"result","result":{"status":"SUCCESS"}}\n')
  await prompt
  await expect.poll(() => child.killed).toBe(true)
  await client.call('session/load', { sessionId })
  expect(latest(sessionId)).not.toBe(child)
  expect(latest(sessionId).cwd).toBe(brainDir)
})
