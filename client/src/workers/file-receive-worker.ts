import { createSha256Stream } from '@unseen/shared/crypto/file-sha256.ts';
import { CHUNK_DATA_MAX_BYTES } from '@unseen/shared/limits.ts';

type InitMessage = {
  readonly kind: 'init';
  readonly tidHex: string;
  readonly expectedSize: number;
  readonly opaqueDir: string;
  readonly lockName: string;
};
type ChunkMessage = {
  readonly kind: 'chunk';
  readonly seq: number;
  readonly data: ArrayBuffer;
};
type FinalizeMessage = { readonly kind: 'finalize' };
type AbortMessage = { readonly kind: 'abort' };
type WorkerIn = InitMessage | ChunkMessage | FinalizeMessage | AbortMessage;

type ReadyOut = { readonly kind: 'ready' };
type WrittenOut = { readonly kind: 'written'; readonly seq: number; readonly bytes: number };
type ShortWriteOut = {
  readonly kind: 'short_write';
  readonly written: number;
  readonly expected: number;
};
type DoneOut = {
  readonly kind: 'done';
  readonly sha256_hex: string;
  readonly bytes_written: number;
  readonly fileSize: number;
  readonly handle: FileSystemFileHandle;
};
type FatalOut = { readonly kind: 'fatal'; readonly err: string };
type ClosedOut = { readonly kind: 'closed' };
export type WorkerOut = ReadyOut | WrittenOut | ShortWriteOut | DoneOut | FatalOut | ClosedOut;

const postPlain = (msg: ReadyOut | WrittenOut | ShortWriteOut | FatalOut | ClosedOut): void => {
  self.postMessage(msg);
};

const postDone = (msg: DoneOut): void => {
  self.postMessage(msg);
};

const nonEmpty = (value: string, fallback: string): string => (value === '' ? fallback : value);

const initDeferred = Promise.withResolvers<InitMessage>();
const closedDeferred = Promise.withResolvers<'finalize' | 'abort'>();
let initialised = false;
let bytesWritten = 0;
let sah: FileSystemSyncAccessHandle | undefined;
let hasher: ReturnType<typeof createSha256Stream> | undefined;
let fileHandle: FileSystemFileHandle | undefined;

const handleChunk = (msg: ChunkMessage): void => {
  if (sah === undefined || hasher === undefined) {
    return;
  }
  const expected = msg.data.byteLength;
  const data = new Uint8Array(msg.data);
  let written: number;
  try {
    written = sah.write(data, { at: msg.seq * CHUNK_DATA_MAX_BYTES });
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    postPlain({ kind: 'fatal', err: nonEmpty(reason, 'sah_write_threw') });
    closedDeferred.resolve('abort');
    return;
  }
  if (written !== expected) {
    postPlain({ kind: 'short_write', written, expected });
    closedDeferred.resolve('abort');
    return;
  }
  hasher.update(data);
  bytesWritten += written;
  postPlain({ kind: 'written', seq: msg.seq, bytes: written });
};

const handleFinalize = (): void => {
  if (sah === undefined || hasher === undefined || fileHandle === undefined) {
    closedDeferred.resolve('abort');
    return;
  }
  let fileSize: number;
  try {
    fileSize = sah.getSize();
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    postPlain({ kind: 'fatal', err: nonEmpty(reason, 'sah_getSize_threw') });
    closedDeferred.resolve('abort');
    return;
  }
  let sha256Hex: string;
  try {
    sha256Hex = hasher.digest();
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    postPlain({ kind: 'fatal', err: nonEmpty(reason, 'sha256_digest_threw') });
    closedDeferred.resolve('abort');
    return;
  }
  postDone({
    kind: 'done',
    sha256_hex: sha256Hex,
    bytes_written: bytesWritten,
    fileSize,
    handle: fileHandle,
  });
  closedDeferred.resolve('finalize');
};

const runLockCallback = async (init: InitMessage): Promise<void> => {
  const root = await navigator.storage.getDirectory();
  const roomDir = await root.getDirectoryHandle(init.opaqueDir, { create: true });
  const handle = await roomDir.getFileHandle(`${init.tidHex}.bin`, { create: true });
  fileHandle = handle;
  const accessHandle = await handle.createSyncAccessHandle();
  sah = accessHandle;
  try {
    accessHandle.truncate(0);
    hasher = createSha256Stream();
    postPlain({ kind: 'ready' });
    await closedDeferred.promise;
  } finally {
    try {
      accessHandle.close();
    } catch {
      /* already closed */
    }
    sah = undefined;
  }
};

const runPipeline = async (): Promise<void> => {
  const init = await initDeferred.promise;
  try {
    await navigator.locks.request(init.lockName, { mode: 'exclusive' }, async (): Promise<void> => {
      await runLockCallback(init);
    });
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    postPlain({ kind: 'fatal', err: nonEmpty(reason, 'lock_or_opfs_failed') });
  }
  postPlain({ kind: 'closed' });
  self.close();
};

self.addEventListener('message', (event: MessageEvent<WorkerIn>) => {
  const msg = event.data;
  if (msg.kind === 'init') {
    if (initialised) {
      return;
    }
    initialised = true;
    initDeferred.resolve(msg);
    return;
  }
  if (msg.kind === 'chunk') {
    handleChunk(msg);
    return;
  }
  if (msg.kind === 'finalize') {
    handleFinalize();
    return;
  }
  msg.kind satisfies 'abort';
  closedDeferred.resolve('abort');
});

self.addEventListener('error', (event: ErrorEvent) => {
  postPlain({ kind: 'fatal', err: nonEmpty(event.message, 'unknown') });
  closedDeferred.resolve('abort');
});

self.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  postPlain({ kind: 'fatal', err: nonEmpty(String(event.reason), 'unhandled rejection') });
  closedDeferred.resolve('abort');
});

await runPipeline();
