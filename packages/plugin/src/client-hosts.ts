import { canReconnect, ClientReconnect } from './client-reconnect.js'
import { ClientModeError, type ConnectedRemote } from './client-runtime-contract.js'
import type { ResolvedConfig } from './config.js'

interface HostLink {
  lifetime: AbortController
  reconnect: ClientReconnect
  pending?: Promise<ConnectedRemote>
  remote?: ConnectedRemote
  error?: unknown
}

/** Host ownership is independent of the currently displayed workspace. This
 * owner retries connection establishment only; callers dispatch an RPC once. */
export class ClientHosts {
  private readonly hosts = new Map<string, HostLink>()

  constructor(
    private readonly establish: (hostId: string, signal: AbortSignal) => Promise<ConnectedRemote>,
    private readonly config: ResolvedConfig['reconnect'],
    private readonly restored: (remote: ConnectedRemote) => void = () => {},
  ) {}

  async get(hostId: string, signal?: AbortSignal): Promise<ConnectedRemote> {
    signal?.throwIfAborted()
    let link = this.hosts.get(hostId)
    if (!link) {
      link = { lifetime: new AbortController(), reconnect: new ClientReconnect(this.config) }
      this.hosts.set(hostId, link)
      this.connect(hostId, link)
    }
    const work = link.remote ? Promise.resolve(link.remote) : link.pending
    if (!work) throw link.error ?? new ClientModeError('REMOTE_NOT_CONNECTED', 'This Host is reconnecting.', true)
    if (!signal) return work
    // A cancelled Pane/read does not close a link shared by other Panes.
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }

  private connect(hostId: string, link: HostLink, retry = false): Promise<ConnectedRemote> {
    const work = this.establish(hostId, link.lifetime.signal).then(async remote => {
      if (link.lifetime.signal.aborted || this.hosts.get(hostId) !== link) {
        await remote.client.close()
        throw new ClientModeError('CANCELLED', 'This Host connection was released.')
      }
      link.remote = remote
      link.error = undefined
      remote.client.onClose(error => {
        if (link.remote !== remote || link.lifetime.signal.aborted) return
        link.remote = undefined
        link.error = error
        if (!canReconnect(error)) {
          this.hosts.delete(hostId)
          link.lifetime.abort(error)
          return
        }
        link.reconnect.start(async () => { await this.connect(hostId, link, true) }, error)
      })
      if (retry) this.restored(remote)
      return remote
    })
    link.pending = work
    void work.then(() => {
      if (link.pending === work) link.pending = undefined
    }, error => {
      if (link.pending === work) link.pending = undefined
      link.error = error
      // Initial failures may be explicitly retried after network/authorization
      // recovery. Do not permanently cache a rejected connection Promise.
      if ((!retry || !canReconnect(error)) && this.hosts.get(hostId) === link) {
        this.hosts.delete(hostId)
        link.lifetime.abort(error)
      }
    })
    return work
  }

  async release(hostId: string): Promise<void> {
    const link = this.hosts.get(hostId)
    if (!link) return
    this.hosts.delete(hostId)
    link.reconnect.cancel()
    link.lifetime.abort(new ClientModeError('CANCELLED', 'This Host connection was released.'))
    await link.remote?.client.close()
    await link.pending?.catch(() => undefined)
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled([...this.hosts.keys()].map(id => this.release(id)))
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
}
