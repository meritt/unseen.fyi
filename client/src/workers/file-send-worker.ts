import { createSha256Stream } from '@unseen/shared/crypto/file-sha256.ts';
import { CHUNK_DATA_MAX_BYTES } from '@unseen/shared/limits.ts';
import { CHUNK_HEADER_BYTES, TID_BYTES } from '@unseen/shared/wire/file-frame.ts';

type InitMessage = {
  readonly kind: 'init';
  readonly stream: ReadableStream<Uint8Array>;
  readonly tid: Uint8Array;
  readonly initialCredit: number;
};

type PullMessage = { readonly kind: 'pull' };
type AbortMessage = { readonly kind: 'abort' };
type WorkerIn = InitMessage | PullMessage | AbortMessage;

type ReadyOut = { readonly kind: 'ready' };
type ChunkOut = {
  readonly kind: 'plaintext_chunk';
  readonly seq: number;
  readonly data: ArrayBuffer;
};
type FinalOut = { readonly kind: 'final'; readonly sha256_hex: string };
type FatalOut = { readonly kind: 'fatal'; readonly err: string };
type ClosedOut = { readonly kind: 'closed' };
export type WorkerOut = ReadyOut | ChunkOut | FinalOut | FatalOut | ClosedOut;

const postPlain = (msg: ReadyOut | FinalOut | FatalOut | ClosedOut): void => {
  self.postMessage(msg);
};

const postChunk = (msg: ChunkOut): void => {
  self.postMessage(msg, [msg.data]);
};

const nonEmpty = (value: string, fallback: string): string => (value === '' ? fallback : value);

let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
let hasher: ReturnType<typeof createSha256Stream> | undefined;
let credit = 0;
let pull: (() => void) | undefined;
let abortedFlag = false;
const isAborted = (): boolean => abortedFlag;
const setAborted = (): void => {
  abortedFlag = true;
};
let initialised = false;
let seq = 0;
let tidBytes: Uint8Array | undefined;

const buildChunkPlaintext = (
  tid: Uint8Array,
  currentSeq: number,
  data: Uint8Array,
): ArrayBuffer => {
  const out = new Uint8Array(CHUNK_HEADER_BYTES + data.byteLength);
  out.set(tid, 0);
  const view = new DataView(out.buffer, out.byteOffset);
  view.setUint32(TID_BYTES, currentSeq, true);
  out.set(data, CHUNK_HEADER_BYTES);
  return out.buffer;
};

const waitForCredit = async (): Promise<void> => {
  if (credit > 0 || isAborted()) {
    return;
  }
  const { promise, resolve } = Promise.withResolvers<undefined>();
  pull = resolve.bind(null, undefined);
  await promise;
  pull = undefined;
};

let pendingTail: Uint8Array = new Uint8Array(0);

const consumeIntoChunks = (input: Uint8Array, isEof: boolean): Uint8Array[] => {
  const combined = new Uint8Array(pendingTail.byteLength + input.byteLength);
  combined.set(pendingTail, 0);
  combined.set(input, pendingTail.byteLength);

  const pieces: Uint8Array[] = [];
  let offset = 0;
  while (offset + CHUNK_DATA_MAX_BYTES <= combined.byteLength) {
    pieces.push(combined.subarray(offset, offset + CHUNK_DATA_MAX_BYTES));
    offset += CHUNK_DATA_MAX_BYTES;
  }

  if (isEof) {
    if (offset < combined.byteLength) {
      pieces.push(combined.subarray(offset));
    }
    pendingTail = new Uint8Array(0);
  } else {
    pendingTail = combined.subarray(offset);
  }
  return pieces;
};

const runPipeline = async (init: InitMessage): Promise<void> => {
  tidBytes = init.tid;
  reader = init.stream.getReader();
  hasher = createSha256Stream();
  credit = init.initialCredit;
  seq = 0;

  postPlain({ kind: 'ready' });

  const emitPiece = async (piece: Uint8Array): Promise<void> => {
    await waitForCredit();
    if (isAborted()) {
      return;
    }
    const narrow = new Uint8Array(piece);
    if (hasher === undefined || tidBytes === undefined) {
      throw new Error('pipeline_state_missing');
    }
    hasher.update(narrow);
    const plaintext = buildChunkPlaintext(tidBytes, seq, narrow);
    postChunk({ kind: 'plaintext_chunk', seq, data: plaintext });
    credit -= 1;
    seq += 1;
  };

  while (!isAborted()) {
    const result = await reader.read();
    if (isAborted()) {
      return;
    }
    if (result.done) {
      for (const piece of consumeIntoChunks(new Uint8Array(0), true)) {
        if (isAborted()) {
          return;
        }
        await emitPiece(piece);
      }
      postPlain({ kind: 'final', sha256_hex: hasher.digest() });
      return;
    }
    for (const piece of consumeIntoChunks(result.value, false)) {
      if (isAborted()) {
        return;
      }
      await emitPiece(piece);
    }
  }
};

const shutdown = async (): Promise<void> => {
  setAborted();
  pull?.();
  if (reader !== undefined) {
    try {
      await reader.cancel();
    } catch {
      /* already cancelled */
    }
    try {
      reader.releaseLock();
    } catch {
      /* unreleasable */
    }
    reader = undefined;
  }
};

const runInit = async (init: InitMessage): Promise<void> => {
  try {
    await runPipeline(init);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    postPlain({ kind: 'fatal', err: nonEmpty(reason, 'unknown') });
  }
  await shutdown();
  postPlain({ kind: 'closed' });
};

self.addEventListener('message', (event: MessageEvent<WorkerIn>) => {
  const msg = event.data;
  if (msg.kind === 'init') {
    if (initialised) {
      return;
    }
    initialised = true;
    void runInit(msg);
    return;
  }
  if (msg.kind === 'pull') {
    credit += 1;
    pull?.();
    return;
  }
  msg.kind satisfies 'abort';
  void shutdown();
});

self.addEventListener('error', (event: ErrorEvent) => {
  postPlain({ kind: 'fatal', err: nonEmpty(event.message, 'unknown') });
});

self.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  postPlain({ kind: 'fatal', err: nonEmpty(String(event.reason), 'unhandled rejection') });
});
