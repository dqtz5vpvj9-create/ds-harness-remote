import type { Context, Volatile } from '@deepseek-ai/cordis'

export interface Config {
  enabled?: boolean
  role?: 'host' | 'client' | 'both'
  serverUrl?: string
  deviceName?: string
  terminal?: { enabled?: boolean }
  loopback?: { ports?: number[] }
  forceRelay?: boolean
  /** Requires a server supporting remote.multi-host.v1. Default: false. */
  multiHost?: boolean
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
  reconnect?: boolean | {
    initialDelayMs?: number
    maxDelayMs?: number
    jitter?: number
  }
  codex?: {
    enabled?: boolean
    binary?: string
  }
}

/** A retained gateway is permanently addressed to one Host. UI selection
 * never retargets it; reconnect does not replay requests. */
export interface RemoteHostGateway {
  invoke(request: { namespace: string; method: string; args: Readonly<Record<string, unknown>>; signal?: AbortSignal }): Promise<unknown>
  dispatch(endpoint: string, payload: unknown, signal: AbortSignal): Promise<
    { ok: true; value?: unknown; attachments?: readonly { path: readonly (string | number)[]; bytes: Uint8Array }[] }
    | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }
  >
  open(endpoint: string, payload: unknown, signal: AbortSignal, uplink?: AsyncIterable<unknown>): Promise<AsyncIterable<unknown>>
}
export interface RemoteHostClient {
  authorizeThroughHost(): Promise<void>
  gatewayForHost(hostId: string, identityKey?: string): RemoteHostGateway
  disconnectHost(hostId: string): Promise<void>
  webForHost(hostId: string, identityKey: string, signal?: AbortSignal): Promise<{
    call(input: unknown, signal?: AbortSignal): Promise<unknown>
    onClose(listener: () => void): () => void
  }>
}
declare module '@deepseek-ai/cordis' {
  interface Context { dshRemoteClient: RemoteHostClient }
}

export declare const name: 'ds-harness-remote'
export declare const Config: unknown
export declare function apply(ctx: Context, config?: Config | Volatile<Config>): void
export declare function runCli(args?: readonly string[]): Promise<number>
