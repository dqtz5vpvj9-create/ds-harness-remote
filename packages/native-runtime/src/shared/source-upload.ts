/** Owner-authenticated Fetch and bounded sourceWorkspace/appendUpload RPC share
 * the same durable source upload owner. Neither retries unconfirmed writes. */
export const SOURCE_UPLOAD_CHUNK_PATH = '/api/hhpi/workspace/uploadChunk';
export const SOURCE_UPLOAD_CHUNK_BYTES = 256 * 1024;
