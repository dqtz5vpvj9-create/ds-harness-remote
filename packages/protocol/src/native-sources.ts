/** Existing source-owned Typert API, carried unchanged over Harness Remote.
 * This is a routing contract, not a declaration that a Host has each service. */
export const NATIVE_SOURCE_CALLS = [
  'hhpi/catalog', 'hhpi/resolve', 'hhpi/read', 'hhpi/operate', 'hhpi/receipt',
  'hhpi/create', 'hhpi/resource', 'hhpi/upload', 'hhpi/nativeCapabilities',
  'hhpi/nativeCall', 'hhpi/nativeReceipt', 'hhpi/nativeReply', 'hhpi/nativeEvents',
  'sourceWorkspace/directories', 'sourceWorkspace/resolve', 'sourceWorkspace/read',
  'sourceWorkspace/readBytes', 'sourceWorkspace/stat', 'sourceWorkspace/list',
  'sourceWorkspace/openDocument', 'sourceWorkspace/readDocumentBytes',
  'sourceWorkspace/inspect', 'sourceWorkspace/search', 'sourceWorkspace/git',
  'sourceWorkspace/uploadInputs', 'sourceWorkspace/beginUpload', 'sourceWorkspace/uploadStatus',
  'sourceWorkspace/finishUpload', 'sourceWorkspace/cancelUpload', 'sourceWorkspace/save',
  'sourceWorkspace/manage', 'sourceWorkspace/receipt',
  'sourceTerminal/environment', 'sourceTerminal/shells', 'sourceTerminal/list',
  'sourceTerminal/create', 'sourceTerminal/rename', 'sourceTerminal/close',
  'sourceTerminal/write', 'sourceTerminal/resize',
  'sourceNavigation/locatePosition', 'sourceNavigation/resumeContext',
] as const

export const NATIVE_SOURCE_STREAMS = [
  'hhpi/changes', 'sourceWorkspace/changes', 'sourceTerminal/follow', 'sourceTerminal/retain',
] as const

export const NATIVE_SOURCE_BINARY_RESULTS = ['sourceWorkspace/readBytes', 'sourceWorkspace/readDocumentBytes'] as const

/** A response-size error happens AFTER dispatch. Only these read operations
 * may be repeated with a chunked response; unknown/new endpoints fail closed.
 * nativeCall may mutate even when its outer method name looks read-like. */
const responseRetryReads = new Set<string>([
  'session/list', 'session/page', 'session/events', 'session/attachment', 'session/projections',
  'session/search', 'session/modelCatalog', 'workspaceFiles/list', 'workspaceFiles/stat',
  'workspaceFiles/read', 'workspaceFiles/readBytes', 'workspaceFiles/readAll', 'workspaceFiles/readRelated',
  'officeToPdf/render', 'officeToPdf/generation',
  'hhpi/catalog', 'hhpi/resolve', 'hhpi/read', 'hhpi/receipt', 'hhpi/resource',
  'hhpi/nativeCapabilities', 'hhpi/nativeReceipt', 'hhpi/nativeEvents',
  'sourceWorkspace/directories', 'sourceWorkspace/resolve', 'sourceWorkspace/read',
  'sourceWorkspace/readBytes', 'sourceWorkspace/stat', 'sourceWorkspace/list',
  'sourceWorkspace/openDocument', 'sourceWorkspace/readDocumentBytes',
  'sourceWorkspace/inspect', 'sourceWorkspace/search', 'sourceWorkspace/git',
  'sourceWorkspace/uploadInputs', 'sourceWorkspace/uploadStatus', 'sourceWorkspace/receipt',
])
export function canRepeatAfterOversizedResponse(endpoint: string): boolean {
  return responseRetryReads.has(endpoint)
}
