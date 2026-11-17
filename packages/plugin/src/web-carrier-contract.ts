/** Local owner injection. The factory receives no token or unauthenticated traffic. */
export interface RemoteWebSource {
  call(input: unknown): Promise<unknown>
  close(): void
}
export interface RemoteWebLink {
  call(input: unknown, signal?: AbortSignal): Promise<unknown>
  onClose(listener: () => void): () => void
}
