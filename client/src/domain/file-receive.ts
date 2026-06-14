import { type Bytes, hexEncode } from '@unseen/shared/crypto/encoding.ts';
import {
  CHUNK_DATA_MAX_BYTES,
  MAX_FILE_SIZE_BYTES,
  SESSION_RECEIVE_CAP_BYTES,
} from '@unseen/shared/limits.ts';
import type { PlaintextEnvelope } from '@unseen/shared/wire/envelope.ts';
import { CHUNK_HEADER_BYTES, TID_BYTES } from '@unseen/shared/wire/file-frame.ts';

import { onPageHide } from '../lifecycle/page-hide.ts';
import { appendFileMessage, type SystemEventKind } from '../state/message-log.ts';
import { OPFS_LOCK_NAME, currentOpaqueDir } from '../storage/opfs-transfers.ts';
import { createWorker } from '../workers/create-worker.ts';
import { browserClock } from './clock.ts';
import {
  attachmentMap,
  fileTransferReady,
  fileTransferSupported,
  incomingActive,
  notifyAttachmentChanged,
  sessionReceivedBytes,
  transferActive,
  type IncomingState,
} from './file-state.ts';
import { type CounterMode, decryptChunkFrame, type ReceiveState } from './receive.ts';
import { sanitizeFilename } from './unicode-sanitize.ts';

const RECV_INITIAL_CREDIT = 4;
const RECV_PENDING_HARD_CAP_CHUNKS = 32;
const OFFER_PENDING_TIMEOUT_MS = 60_000;
const RECV_STALL_TIMEOUT_MS = 30_000;
const PROGRESS_MIN_INTERVAL_MS = 1000;
const PROGRESS_MIN_BYTES = 1_048_576;
const WORKER_CLOSED_TIMEOUT_MS = 500;
const WORKER_READY_TIMEOUT_MS = 5000;

export type FileEnvelopeToReceiver = Extract<
  PlaintextEnvelope,
  { kind: 'file_offer' | 'file_complete' | 'file_cancel' }
>;

export type FileReceiverDeps = {
  readonly sendEnvelope: (envelope: PlaintextEnvelope) => Promise<boolean>;
  readonly getReceiveState: () => ReceiveState;
  readonly syncReceiveState: (state: ReceiveState) => void;
  readonly appendSystemEvent: (event: SystemEventKind) => void;
};

export type FileReceiver = {
  readonly dispatchOffer: (envelope: Extract<PlaintextEnvelope, { kind: 'file_offer' }>) => void;
  readonly dispatchComplete: (
    envelope: Extract<PlaintextEnvelope, { kind: 'file_complete' }>,
  ) => void;
  readonly dispatchCancel: (envelope: Extract<PlaintextEnvelope, { kind: 'file_cancel' }>) => void;
  readonly dispatchChunkFrame: (
    nonce: Bytes,
    ciphertext: Bytes,
    mode: CounterMode,
  ) => Promise<void>;
  readonly acceptOffer: () => Promise<void>;
  readonly declineOffer: () => void;
  readonly cancelActive: (reason?: 'user_aborted' | 'session_rekey') => void;
  readonly onWsClose: () => void;
  readonly shutdown: () => void;
};

type WorkerInInit = {
  readonly kind: 'init';
  readonly tidHex: string;
  readonly expectedSize: number;
  readonly opaqueDir: string;
  readonly lockName: string;
};
type WorkerInChunk = { readonly kind: 'chunk'; readonly seq: number; readonly data: ArrayBuffer };
type WorkerInFinalize = { readonly kind: 'finalize' };
type WorkerInAbort = { readonly kind: 'abort' };
type WorkerInMessage = WorkerInInit | WorkerInChunk | WorkerInFinalize | WorkerInAbort;

type WorkerOutReady = { readonly kind: 'ready' };
type WorkerOutWritten = {
  readonly kind: 'written';
  readonly seq: number;
  readonly bytes: number;
};
type WorkerOutShortWrite = {
  readonly kind: 'short_write';
  readonly written: number;
  readonly expected: number;
};
type WorkerOutDone = {
  readonly kind: 'done';
  readonly sha256_hex: string;
  readonly bytes_written: number;
  readonly fileSize: number;
  readonly handle: FileSystemFileHandle;
};
type WorkerOutFatal = { readonly kind: 'fatal'; readonly err: string };
type WorkerOutClosed = { readonly kind: 'closed' };
type WorkerOutMessage =
  | WorkerOutReady
  | WorkerOutWritten
  | WorkerOutShortWrite
  | WorkerOutDone
  | WorkerOutFatal
  | WorkerOutClosed;

export type WorkerFactory = () => Worker;

const defaultWorkerFactory: WorkerFactory = () =>
  createWorker(new URL('../workers/file-receive-worker.js', import.meta.url), { type: 'module' });

const parseChunkPlaintext = (
  plaintext: Bytes,
): { readonly tidHex: string; readonly seq: number; readonly data: Uint8Array } | null => {
  if (plaintext.byteLength < CHUNK_HEADER_BYTES) {
    return null;
  }
  const view = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
  const tidBytes = plaintext.subarray(0, TID_BYTES);
  const tidHex = hexEncode(tidBytes);
  const seq = view.getUint32(TID_BYTES, true);
  const data = plaintext.subarray(CHUNK_HEADER_BYTES);
  return { tidHex, seq, data };
};

const computeTotalChunks = (expectedSize: number): number =>
  Math.ceil(expectedSize / CHUNK_DATA_MAX_BYTES);

const expectedChunkLen = (expectedSize: number, seq: number, totalChunks: number): number =>
  seq + 1 < totalChunks
    ? CHUNK_DATA_MAX_BYTES
    : expectedSize - CHUNK_DATA_MAX_BYTES * (totalChunks - 1);

const withTimeout = async <T>(promise: Promise<T>, ms: number, err: string): Promise<T> => {
  const { promise: timeoutPromise, reject } = Promise.withResolvers<never>();
  AbortSignal.timeout(ms).addEventListener('abort', () => reject(new Error(err)), { once: true });
  return await Promise.race([promise, timeoutPromise]);
};

export const createFileReceiver = (
  deps: FileReceiverDeps,
  factory?: WorkerFactory,
): FileReceiver => {
  const spawnWorker = factory ?? defaultWorkerFactory;

  let sessionCapEventFired = false;
  let lastProgressAt = 0;
  let lastProgressBytes = 0;
  let acceptInFlight = false;
  let lastReceiveNotifyPercent = -1;
  let offerPendingTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let receiveStallTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

  const clearOfferTimer = (): void => {
    if (offerPendingTimer !== undefined) {
      globalThis.clearTimeout(offerPendingTimer);
      offerPendingTimer = undefined;
    }
  };

  const clearStallTimer = (): void => {
    if (receiveStallTimer !== undefined) {
      globalThis.clearTimeout(receiveStallTimer);
      receiveStallTimer = undefined;
    }
  };

  const resetTransferLocals = (): void => {
    lastProgressAt = 0;
    lastProgressBytes = 0;
    lastReceiveNotifyPercent = -1;
    clearOfferTimer();
    clearStallTimer();
  };

  const notifyReceiveProgress = (state: Extract<IncomingState, { phase: 'receiving' }>): void => {
    const percent =
      state.expectedSize === 0 ? 100 : Math.floor((state.bytesWritten / state.expectedSize) * 100);
    if (percent === lastReceiveNotifyPercent) {
      return;
    }
    lastReceiveNotifyPercent = percent;
    incomingActive.value = { ...state };
  };

  const getReceivingState = (): Extract<IncomingState, { phase: 'receiving' }> | null => {
    const state = incomingActive.value;
    if (state?.phase !== 'receiving') {
      return null;
    }
    return state;
  };

  const finishTransfer = (event: SystemEventKind): void => {
    incomingActive.value = null;
    resetTransferLocals();
    deps.appendSystemEvent(event);
  };

  const requestWorkerShutdown = (worker: Worker, kind: 'finalize' | 'abort'): void => {
    try {
      const msg: WorkerInMessage = kind === 'finalize' ? { kind: 'finalize' } : { kind: 'abort' };
      worker.postMessage(msg);
    } catch {
      /* already terminated */
    }
    globalThis.setTimeout(() => {
      try {
        worker.terminate();
      } catch {
        /* already terminated */
      }
    }, WORKER_CLOSED_TIMEOUT_MS);
  };

  const cleanupOpfs = async (tidHex: string): Promise<void> => {
    const dir = currentOpaqueDir.value;
    if (dir === undefined) {
      return;
    }
    try {
      const root = await navigator.storage.getDirectory();
      const roomDir = await root.getDirectoryHandle(dir, { create: false });
      await roomDir.removeEntry(`${tidHex}.bin`);
    } catch {
      /* best-effort */
    }
  };

  const integrityFailureAbort = (state: Extract<IncomingState, { phase: 'receiving' }>): void => {
    const { tid } = state;
    void deps.sendEnvelope({
      kind: 'file_cancel',
      tid,
      side: 'receiver',
      reason: 'integrity_failure',
    });
    requestWorkerShutdown(state.worker, 'abort');
    void cleanupOpfs(tid);
    finishTransfer('file_transfer_failed');
  };

  const sendDecline = (
    tid: string,
    reason: 'too_large' | 'user_rejected' | 'unsupported',
  ): void => {
    void deps.sendEnvelope({ kind: 'file_decline', tid, reason });
  };

  const declineAndReset = (tid: string, worker?: Worker): void => {
    if (worker !== undefined) {
      try {
        worker.terminate();
      } catch {
        /* already terminated */
      }
    }
    sendDecline(tid, 'unsupported');
    incomingActive.value = null;
    resetTransferLocals();
  };

  const evaluatePreAccept = (
    offer: Extract<PlaintextEnvelope, { kind: 'file_offer' }>,
  ):
    | { readonly decline: 'too_large' | 'user_rejected' | 'unsupported' }
    | { readonly accept: true; readonly sanitisedName: string } => {
    if (offer.size > MAX_FILE_SIZE_BYTES) {
      return { decline: 'too_large' };
    }
    if (offer.size <= 0) {
      return { decline: 'unsupported' };
    }
    const sanitisedName = sanitizeFilename(offer.name);
    if (sanitisedName === null) {
      return { decline: 'unsupported' };
    }
    if (transferActive.value !== null || incomingActive.value !== null) {
      return { decline: 'unsupported' };
    }
    if (attachmentMap.has(offer.tid)) {
      return { decline: 'unsupported' };
    }
    if (sessionReceivedBytes.value + offer.size > SESSION_RECEIVE_CAP_BYTES) {
      if (!sessionCapEventFired) {
        sessionCapEventFired = true;
        deps.appendSystemEvent('file_session_cap_reached');
      }
      return { decline: 'unsupported' };
    }
    if (!fileTransferSupported.value) {
      return { decline: 'unsupported' };
    }
    if (!fileTransferReady.value) {
      return { decline: 'unsupported' };
    }
    return { accept: true, sanitisedName };
  };

  const installOfferTimeout = (tid: string): void => {
    clearOfferTimer();
    offerPendingTimer = globalThis.setTimeout(() => {
      offerPendingTimer = undefined;
      const current = incomingActive.value;
      if (current?.tid === tid && current.phase === 'offer-pending') {
        incomingActive.value = null;
        resetTransferLocals();
        deps.appendSystemEvent('file_transfer_cancelled');
      }
    }, OFFER_PENDING_TIMEOUT_MS);
  };

  const dispatchOffer = (envelope: Extract<PlaintextEnvelope, { kind: 'file_offer' }>): void => {
    const verdict = evaluatePreAccept(envelope);
    if ('decline' in verdict) {
      sendDecline(envelope.tid, verdict.decline);
      return;
    }
    incomingActive.value = {
      tid: envelope.tid,
      phase: 'offer-pending',
      name: verdict.sanitisedName,
      size: envelope.size,
    };
    appendFileMessage(envelope.tid, 'in', browserClock.nowIso());
    installOfferTimeout(envelope.tid);
  };

  const maybeFinalize = (state: Extract<IncomingState, { phase: 'receiving' }>): void => {
    if (
      state.finalizeRequested === true ||
      state.senderSha256 === undefined ||
      state.pendingChunkQueue.length > 0 ||
      state.bytesWritten < state.expectedSize
    ) {
      return;
    }
    state.finalizeRequested = true;
    requestWorkerShutdown(state.worker, 'finalize');
  };

  const handleWorkerWritten = (
    state: Extract<IncomingState, { phase: 'receiving' }>,
    msg: WorkerOutWritten,
  ): void => {
    state.bytesWritten += msg.bytes;
    state.receiveCredit += 1;
    const next = state.pendingChunkQueue.shift();
    if (next !== undefined) {
      postChunkToWorker(state, next.seq, next.data);
    }
    maybeSendProgress(state);
    maybeFinalize(state);
    notifyReceiveProgress(state);
  };

  const handleWorkerDone = async (
    state: Extract<IncomingState, { phase: 'receiving' }>,
    msg: WorkerOutDone,
  ): Promise<void> => {
    const senderHash = state.senderSha256;
    const expected = state.expectedSize;
    if (
      senderHash === undefined ||
      msg.sha256_hex !== senderHash ||
      msg.bytes_written !== expected ||
      msg.fileSize !== expected
    ) {
      const { tid } = state;
      void deps.sendEnvelope({
        kind: 'file_cancel',
        tid,
        side: 'receiver',
        reason: 'integrity_failure',
      });
      await cleanupOpfs(tid);
      finishTransfer('file_transfer_failed');
      return;
    }
    attachmentMap.set(state.tid, {
      source: 'opfs',
      handle: msg.handle,
      name: state.name,
      size: expected,
    });
    notifyAttachmentChanged();
    sessionReceivedBytes.value += expected;
    incomingActive.value = null;
    resetTransferLocals();
    void deps.sendEnvelope({ kind: 'file_complete_ack', tid: state.tid });
  };

  const handleWorkerMessage = async (
    msg: WorkerOutMessage,
    worker: Worker,
    readyDeferred: PromiseWithResolvers<unknown>,
  ): Promise<void> => {
    const state = getReceivingState();
    if (msg.kind === 'ready') {
      readyDeferred.resolve(true);
      return;
    }
    if (msg.kind === 'closed') {
      return;
    }
    if (state === null || state.worker !== worker) {
      if (msg.kind === 'fatal') {
        readyDeferred.reject(new Error(msg.err));
      }
      return;
    }
    if (msg.kind === 'written') {
      handleWorkerWritten(state, msg);
      return;
    }
    if (msg.kind === 'done') {
      await handleWorkerDone(state, msg);
      return;
    }
    if (msg.kind === 'short_write') {
      integrityFailureAbort(state);
      return;
    }
    msg.kind satisfies 'fatal';
    integrityFailureAbort(state);
  };

  const runAcceptOffer = async (
    state: Extract<IncomingState, { phase: 'offer-pending' }>,
  ): Promise<void> => {
    const opaqueDir = currentOpaqueDir.value;
    if (opaqueDir === undefined) {
      declineAndReset(state.tid);
      return;
    }
    let worker: Worker;
    try {
      worker = spawnWorker();
    } catch {
      declineAndReset(state.tid);
      return;
    }
    const readyDeferred = Promise.withResolvers<unknown>();
    worker.addEventListener('message', (event: MessageEvent<WorkerOutMessage>) => {
      void handleWorkerMessage(event.data, worker, readyDeferred);
    });
    worker.addEventListener('error', () => {
      readyDeferred.reject(new Error('worker_error'));
      const current = getReceivingState();
      if (current?.worker === worker) {
        integrityFailureAbort(current);
      }
    });
    try {
      const init: WorkerInInit = {
        kind: 'init',
        tidHex: state.tid,
        expectedSize: state.size,
        opaqueDir,
        lockName: OPFS_LOCK_NAME,
      };
      worker.postMessage(init);
    } catch {
      declineAndReset(state.tid, worker);
      return;
    }
    try {
      await withTimeout(readyDeferred.promise, WORKER_READY_TIMEOUT_MS, 'worker_ready_timeout');
    } catch {
      declineAndReset(state.tid, worker);
      return;
    }
    clearOfferTimer();
    const sent = await deps.sendEnvelope({ kind: 'file_accept', tid: state.tid });
    if (!sent) {
      try {
        worker.terminate();
      } catch {
        /* already terminated */
      }
      installOfferTimeout(state.tid);
      return;
    }
    incomingActive.value = {
      tid: state.tid,
      phase: 'receiving',
      name: state.name,
      size: state.size,
      expectedSize: state.size,
      nextExpectedSeq: 0,
      networkReceivedBytes: 0,
      bytesWritten: 0,
      receiveCredit: RECV_INITIAL_CREDIT,
      pendingChunkQueue: [],
      worker,
      abort: AbortSignal.timeout(24 * 60 * 60 * 1000),
    };
    receiveStallTimer = globalThis.setTimeout(() => {
      receiveStallTimer = undefined;
      const current = getReceivingState();
      if (current === null || current.tid !== state.tid || current.nextExpectedSeq !== 0) {
        return;
      }
      integrityFailureAbort(current);
    }, RECV_STALL_TIMEOUT_MS);
  };

  const acceptOffer = async (): Promise<void> => {
    const state = incomingActive.value;
    if (state?.phase !== 'offer-pending' || acceptInFlight) {
      return;
    }
    acceptInFlight = true;
    try {
      await runAcceptOffer(state);
    } finally {
      acceptInFlight = false;
    }
  };

  const declineOffer = (): void => {
    const state = incomingActive.value;
    if (state?.phase !== 'offer-pending') {
      return;
    }
    sendDecline(state.tid, 'user_rejected');
    finishTransfer('file_transfer_cancelled');
  };

  const cancelActive = (reason: 'user_aborted' | 'session_rekey' = 'user_aborted'): void => {
    const state = incomingActive.value;
    if (state === null) {
      return;
    }
    if (state.phase === 'offer-pending') {
      declineOffer();
      return;
    }
    void deps.sendEnvelope({
      kind: 'file_cancel',
      tid: state.tid,
      side: 'receiver',
      reason,
    });
    requestWorkerShutdown(state.worker, 'abort');
    void cleanupOpfs(state.tid);
    finishTransfer('file_transfer_cancelled');
  };

  function postChunkToWorker(
    state: Extract<IncomingState, { phase: 'receiving' }>,
    seq: number,
    data: ArrayBuffer,
  ): void {
    try {
      const msg: WorkerInMessage = { kind: 'chunk', seq, data };
      state.worker.postMessage(msg, [data]);
      state.receiveCredit -= 1;
    } catch {
      integrityFailureAbort(state);
    }
  }

  function maybeSendProgress(state: Extract<IncomingState, { phase: 'receiving' }>): void {
    const now = performance.now();
    if (now - lastProgressAt < PROGRESS_MIN_INTERVAL_MS) {
      return;
    }
    if (state.bytesWritten - lastProgressBytes < PROGRESS_MIN_BYTES) {
      return;
    }
    lastProgressAt = now;
    lastProgressBytes = state.bytesWritten;
    void deps.sendEnvelope({
      kind: 'file_progress',
      tid: state.tid,
      received_bytes: state.bytesWritten,
    });
  }

  const dispatchChunkFrame = async (
    nonce: Bytes,
    ciphertext: Bytes,
    mode: CounterMode,
  ): Promise<void> => {
    const state = deps.getReceiveState();
    const result = await decryptChunkFrame(state, nonce, ciphertext, mode);
    if (result.status !== 'ok') {
      throw new Error(`relay_${result.status}`);
    }
    deps.syncReceiveState(state);

    const parsed = parseChunkPlaintext(result.plaintext);
    if (parsed === null) {
      throw new Error('relay_malformed_chunk');
    }

    const active = getReceivingState();
    if (active === null || parsed.tidHex !== active.tid) {
      return;
    }

    const totalChunks = computeTotalChunks(active.expectedSize);
    const expectedLen = expectedChunkLen(active.expectedSize, parsed.seq, totalChunks);
    if (
      parsed.seq !== active.nextExpectedSeq ||
      parsed.seq >= totalChunks ||
      parsed.data.byteLength !== expectedLen
    ) {
      integrityFailureAbort(active);
      return;
    }

    if (active.pendingChunkQueue.length >= RECV_PENDING_HARD_CAP_CHUNKS) {
      integrityFailureAbort(active);
      return;
    }

    if (parsed.seq === 0) {
      clearStallTimer();
    }

    const detached = new Uint8Array(parsed.data).buffer;
    active.nextExpectedSeq += 1;
    active.networkReceivedBytes += parsed.data.byteLength;

    if (active.receiveCredit > 0) {
      postChunkToWorker(active, parsed.seq, detached);
    } else {
      active.pendingChunkQueue.push({ seq: parsed.seq, data: detached });
    }
  };

  const dispatchComplete = (
    envelope: Extract<PlaintextEnvelope, { kind: 'file_complete' }>,
  ): void => {
    const state = getReceivingState();
    if (state?.tid !== envelope.tid) {
      return;
    }
    if (state.networkReceivedBytes < state.expectedSize) {
      integrityFailureAbort(state);
      return;
    }
    state.senderSha256 = envelope.sender_sha256;
    maybeFinalize(state);
  };

  const dispatchCancel = (envelope: Extract<PlaintextEnvelope, { kind: 'file_cancel' }>): void => {
    if (envelope.side !== 'sender') {
      return;
    }
    const state = incomingActive.value;
    if (state?.tid !== envelope.tid) {
      return;
    }
    const event: SystemEventKind =
      envelope.reason === 'integrity_failure' ? 'file_transfer_failed' : 'file_transfer_cancelled';
    if (state.phase === 'receiving') {
      requestWorkerShutdown(state.worker, 'abort');
      void cleanupOpfs(state.tid);
    }
    finishTransfer(event);
  };

  const unsubscribePageHide = onPageHide(() => {
    const state = incomingActive.value;
    if (state === null) {
      return;
    }
    if (state.phase === 'receiving') {
      try {
        void deps.sendEnvelope({
          kind: 'file_cancel',
          tid: state.tid,
          side: 'receiver',
          reason: 'user_aborted',
        });
      } catch {
        /* mid-teardown */
      }
      try {
        state.worker.terminate();
      } catch {
        /* already terminated */
      }
    }
    incomingActive.value = null;
    resetTransferLocals();
  });

  const onWsClose = (): void => {
    const state = incomingActive.value;
    if (state === null) {
      return;
    }
    if (state.phase !== 'receiving') {
      return;
    }
    try {
      state.worker.terminate();
    } catch {
      /* already terminated */
    }
    incomingActive.value = null;
    resetTransferLocals();
    deps.appendSystemEvent('file_transfer_failed');
  };

  const shutdown = (): void => {
    unsubscribePageHide();
    const state = incomingActive.value;
    if (state?.phase === 'receiving') {
      try {
        state.worker.terminate();
      } catch {
        /* already terminated */
      }
    }
    incomingActive.value = null;
    resetTransferLocals();
  };

  return {
    dispatchOffer,
    dispatchComplete,
    dispatchCancel,
    dispatchChunkFrame,
    acceptOffer,
    declineOffer,
    cancelActive,
    onWsClose,
    shutdown,
  };
};
