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
    expect(loadSessionHistory).not.toHaveBeenCalled()
    expect((await facade.sourceCreate('/empty', new AbortController().signal)).nativeId).toBe('new-session')
    expect(createSession).toHaveBeenCalledTimes(1)
    await expect(facade.sourceSnapshot('not-owned')).rejects.toThrow('not found')
  } finally { await facade.close() }
  loadSessionHistory.mockRejectedValue(new Error('HISTORY_UNAVAILABLE'))
  const failed = new AcpVirtualHarness(client, { deviceId: 'host', name: 'Host' }, 'antigravity')
  try { await expect(failed.sourceSnapshot('original')).rejects.toThrow('HISTORY_UNAVAILABLE') }
  finally { await failed.close() }
})

it('model calls do not hydrate history or expose an unknown host selection', async () => {
  const loadSessionHistory = vi.fn(async () => { throw new Error('history should not be loaded') })
  const sessionModels = vi.fn(async () => ({ current: { provider: 'antigravity', model: 'host-settings' }, routable: true,
    groups: [{ id: 'antigravity', name: 'Antigravity', models: [{ id: 'flash', name: 'Flash' }] }], failures: [] }))
  const selectModel = vi.fn(async (_id: string, _backend: string, selection: { provider: string; model: string }) => selection)
  const facade = new AcpVirtualHarness({ loadSessionHistory, sessionModels, selectModel, createSession: async (cwd: string) => ({ sessionId: 'new', cwd }),
    listWorkspaces: async () => [{ path: '/repo' }],
    listSessions: async () => [{ conversationId: 'original', title: 'Original', createdAt: 1, updatedAt: 2 }],
    prompt: async () => ({}), cancel: async () => ({}), respond: async () => ({}),
    listDirectory: async () => ({}), openStream: async () => ({ close: async () => undefined }),
  }, { deviceId: 'host', name: 'Host' }, 'antigravity')
  const clone = vi.spyOn(globalThis, 'structuredClone')
  try {
    await facade.sourceCall('original', 'session/models', {}, new AbortController().signal)
    expect(loadSessionHistory).not.toHaveBeenCalled()
    expect(clone).not.toHaveBeenCalled()
    expect((await facade.sourceCatalog())[0]?.selection).toBeUndefined()
    await facade.sourceCall('original', 'session/selectModel', { provider: 'antigravity', model: 'flash' }, new AbortController().signal)
    expect(loadSessionHistory).not.toHaveBeenCalled()
    expect((await facade.sourceCatalog())[0]?.selection).toMatchObject({ model: 'flash' })
    await expect(facade.sourceCall('missing', 'session/models', {}, new AbortController().signal)).rejects.toThrow('not found')
  } finally { clone.mockRestore(); await facade.close() }
})

it('caps large catalogs and discovers workspaces with bounded concurrency', async () => {
  let active = 0, maximum = 0
  const facade = new AcpVirtualHarness({
    createSession: async (cwd: string) => ({ sessionId: 'new', cwd }),
    listWorkspaces: async () => Array.from({ length: 6 }, (_, i) => ({ path: `/repo${i}` })),
    listSessions: async (cwd: string) => {
      active++; maximum = Math.max(maximum, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active--
      return cwd === '/repo0' ? Array.from({ length: 10001 }, (_, i) => ({ conversationId: `id${i}`, title: `Session ${i}`, createdAt: i, updatedAt: i })) : []
    },
    prompt: async () => ({}), cancel: async () => ({}), respond: async () => ({}),
    listDirectory: async () => ({}), openStream: async () => ({ close: async () => undefined }),
  }, { deviceId: 'host', name: 'Host' }, 'antigravity')
  try {
    const sessions = await facade.sourceCatalog()
    expect(sessions).toHaveLength(10000)
    expect(maximum).toBe(4)
  } finally { await facade.close() }
}, 30000)
