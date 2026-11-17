import { expect, it, vi } from 'vitest'
import { AcpVirtualHarness } from '../src/acp/virtual-harness.js'

it('source discovery is read-only, source controls retain identity, and history errors remain errors', async () => {
  const createSession = vi.fn(async (cwd: string) => ({ sessionId: 'new-session', cwd }))
  const loadSessionHistory = vi.fn(async () => [{ type: 'event', event: { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } }])
  const sessionModels = vi.fn(async () => ({ current: { provider: 'antigravity', model: 'flash' }, routable: true,
    groups: [{ id: 'antigravity', name: 'Antigravity', models: [{ id: 'flash', name: 'Flash' }] }], failures: [] }))
  const client = { createSession, loadSessionHistory, sessionModels,
    listWorkspaces: async () => [{ path: '/repo' }, { path: '/empty' }],
    listSessions: async (cwd: string) => cwd === '/repo' ? [{ conversationId: 'original', title: 'Original', createdAt: 1, updatedAt: 2 }] : [],
    prompt: async () => ({ accepted: true }), cancel: async () => ({}), respond: async () => ({}),
    listDirectory: async () => ({}), openStream: async () => ({ close: async () => undefined }),
  }
  const facade = new AcpVirtualHarness(client, { deviceId: 'host', name: 'Host' }, 'antigravity')
  try {
    expect(await facade.sourceCatalog()).toMatchObject([{ nativeId: 'original', cwd: '/repo' }])
    expect(createSession).not.toHaveBeenCalled()
    expect(await facade.sourceCall('original', 'session/models', {}, new AbortController().signal)).toMatchObject({ current: { model: 'flash' } })
    expect(sessionModels).toHaveBeenCalledWith('original', 'antigravity')
    expect((await facade.sourceCreate('/empty', new AbortController().signal)).nativeId).toBe('new-session')
    expect(createSession).toHaveBeenCalledTimes(1)
    await expect(facade.sourceSnapshot('not-owned')).rejects.toThrow('not found')
  } finally { await facade.close() }
  loadSessionHistory.mockRejectedValue(new Error('HISTORY_UNAVAILABLE'))
  const failed = new AcpVirtualHarness(client, { deviceId: 'host', name: 'Host' }, 'antigravity')
  try { await expect(failed.sourceSnapshot('original')).rejects.toThrow('HISTORY_UNAVAILABLE') }
  finally { await failed.close() }
})
