import { expect, it, vi } from 'vitest'
import type { AcpSessionModels } from '@dsh-remote/protocol'
import { AcpVirtualHarness } from '../src/acp/virtual-harness.js'

function fixture(models: AcpSessionModels) {
  const sessionModels = vi.fn(async () => models)
  const selectModel = vi.fn(async (_id: string, _backend: string, selection: AcpSessionModels['current']) => selection)
  const loadSessionHistory = vi.fn(async () => { throw new Error('Model reads must not hydrate history') })
  const facade = new AcpVirtualHarness({
    sessionModels, selectModel, loadSessionHistory,
    createSession: async (cwd: string) => ({ sessionId: 'new', cwd }),
    listWorkspaces: async () => [{ path: '/repo' }],
    listSessions: async () => [{ conversationId: 'original', title: 'Original', createdAt: 1, updatedAt: 2 }],
    prompt: async () => ({}), cancel: async () => ({}), respond: async () => ({}),
    listDirectory: async () => ({}), openStream: async () => ({ close: async () => undefined }),
  }, { deviceId: 'host', name: 'Host' }, 'antigravity')
  return { facade, sessionModels, selectModel, loadSessionHistory }
}

const catalog = (): AcpSessionModels => ({
  current: { provider: 'antigravity', model: 'host-settings' }, routable: true, failures: [],
  groups: [
    { id: 'other', name: 'Other', models: [{ id: 'unrelated', name: 'Unrelated' }] },
    { id: 'antigravity', name: 'Antigravity', models: [
      { id: 'flash', name: 'Flash', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } },
      { id: 'pro', name: 'Pro' },
    ] },
  ],
})

it('surfaces provider defaults while preserving unknown Host selection and read-only discovery', async () => {
  const models = catalog()
  const f = fixture(models)
  try {
    const result = await f.facade.sourceCall('original', 'session/models', {}, new AbortController().signal)
    expect(result).toMatchObject({ current: { provider: 'antigravity', model: 'host-settings' }, defaultModel: 'flash', defaultEffort: 'low' })
    expect((await f.facade.sourceCatalog())[0]).toMatchObject({ defaultModel: 'flash', defaultEffort: 'low' })
    expect((await f.facade.sourceCatalog())[0]?.selection).toBeUndefined()
    expect(models.current.model).toBe('host-settings')
    expect(models).not.toHaveProperty('defaultModel')
    expect(f.selectModel).not.toHaveBeenCalled()
    expect(f.loadSessionHistory).not.toHaveBeenCalled()
  } finally { await f.facade.close() }
})

it('retains a Host-confirmed effort when the model follows Host settings', async () => {
  const models = catalog()
  models.current.reasoningEffort = 'high'
  const f = fixture(models)
  try {
    expect(await f.facade.sourceCall('original', 'session/models', {}, new AbortController().signal))
      .toMatchObject({ current: { model: 'host-settings', reasoningEffort: 'high' }, defaultModel: 'flash', defaultEffort: 'high' })
  } finally { await f.facade.close() }
})

it('does not infer a default from another provider or an empty provider catalog', async () => {
  for (const groups of [catalog().groups.slice(0, 1), [{ id: 'antigravity', name: 'Antigravity', models: [] }]]) {
    const f = fixture({ ...catalog(), groups })
    try {
      const result = await f.facade.sourceCall('original', 'session/models', {}, new AbortController().signal)
      expect(result).not.toHaveProperty('defaultModel')
      expect(result).not.toHaveProperty('defaultEffort')
      expect((await f.facade.sourceCatalog())[0]?.selection).toBeUndefined()
    } finally { await f.facade.close() }
  }
})

it('clears cached defaults on catalog changes and confirmed model selection', async () => {
  const f = fixture(catalog())
  const signal = new AbortController().signal
  try {
    await f.facade.sourceCall('original', 'session/models', {}, signal)
    f.sessionModels.mockResolvedValueOnce({ ...catalog(), groups: [] })
    await f.facade.sourceCall('original', 'session/models', {}, signal)
    expect((await f.facade.sourceCatalog())[0]).not.toHaveProperty('defaultModel')
    await f.facade.sourceCall('original', 'session/models', {}, signal)
    await f.facade.sourceCall('original', 'session/selectModel', { provider: 'antigravity', model: 'pro' }, signal)
    const [metadata] = await f.facade.sourceCatalog()
    expect(metadata?.selection).toEqual({ provider: 'antigravity', model: 'pro' })
    expect(metadata).not.toHaveProperty('defaultModel')
    expect(metadata).not.toHaveProperty('defaultEffort')
    expect(f.selectModel).toHaveBeenCalledTimes(1)
    expect(f.selectModel).toHaveBeenCalledWith('original', 'antigravity', { provider: 'antigravity', model: 'pro' })
    expect(f.loadSessionHistory).not.toHaveBeenCalled()
  } finally { await f.facade.close() }
})

it('keeps explicitly reported model selection unchanged', async () => {
  const models = catalog()
  models.current = { provider: 'antigravity', model: 'pro', reasoningEffort: 'high' }
  const f = fixture(models)
  try {
    const result = await f.facade.sourceCall('original', 'session/models', {}, new AbortController().signal)
    expect(result).toEqual(models)
    expect((await f.facade.sourceCatalog())[0]?.selection).toEqual(models.current)
  } finally { await f.facade.close() }
})
