import { type Bytes, hexDecode } from '@unseen/shared/crypto/encoding.ts';
import { MAX_FILE_SIZE_BYTES } from '@unseen/shared/limits.ts';
import type { PlaintextEnvelope } from '@unseen/shared/wire/envelope.ts';
import { CHUNK_HEADER_BYTES, TID_BYTES } from '@unseen/shared/wire/file-frame.ts';

import { onPageHide } from '../lifecycle/page-hide.ts';
import { appendFileMessage, type SystemEventKind } from '../state/message-log.ts';
import { createWorker } from '../workers/create-worker.ts';
import { browserClock } from './clock.ts';
import {
  attachmentMap,
  incomingActive,
  notifyAttachmentChanged,
  transferActive,
} from './file-state.ts';
import { sanitizeFilename } from './unicode-sanitize.ts';

const OFFERED_TIMEOUT_MS = 60_000;
const VERIFYING_TIMEOUT_MS = 30_000;
const OUTGOING_BUFFER_SOFT_CAP = 192 * 1024;
const BACKPRESSURE_POLL_MS = 50;
const INITIAL_CREDIT = 4;
const WORKER_CLOSED_TIMEOUT_MS = 500;
const WORKER_READY_TIMEOUT_MS = 5000;
const VERIFYING_LIFETIME_MS = 24 * 60 * 60 * 1000;

export type FileEnvelopeFromReceiver = Extract<
  PlaintextEnvelope,
  { kind: 'file_accept' | 'file_decline' | 'file_progress' | 'file_cancel' | 'file_complete_ack' }
>;

export type FileSenderDeps = {
  readonly sendEnvelope: (envelope: PlaintextEnvelope) => Promise<boolean>;
  readonly getWs: () => WebSocket | undefined;
  readonly sendChunk: (plaintext: Bytes) => Promise<boolean>;
  readonly appendSystemEvent: (event: SystemEventKind) => void;
};

export type FileSender = {
  readonly startTransfer: (file: File) => Promise<void>;
  readonly dispatchFromReceiver: (envelope: FileEnvelopeFromReceiver) => void;
  readonly cancelActive: (reason?: 'user_aborted' | 'session_rekey') => void;
  readonly isActive: () => boolean;
  readonly onWsClose: () => void;
  readonly shutdown: () => void;
};

type WorkerOutChunk = {
  readonly kind: 'plaintext_chunk';
  readonly seq: number;
  readonly data: ArrayBuffer;
};
type WorkerOutFinal = { readonly kind: 'final'; readonly sha256_hex: string };
type WorkerOutReady = { readonly kind: 'ready' };
type WorkerOutFatal = { readonly kind: 'fatal'; readonly err: string };
type WorkerOutClosed = { readonly kind: 'closed' };
type WorkerOutMessage =
  | WorkerOutChunk
  | WorkerOutFinal
  | WorkerOutReady
  | WorkerOutFatal
  | WorkerOutClosed;

type PendingChunk = { readonly seq: number; readonly data: ArrayBuffer };

export type WorkerFactory = () => Worker;

const defaultWorkerFactory: WorkerFactory = () =>
  createWorker(new URL('../workers/file-send-worker.js', import.meta.url), { type: 'module' });

const generateTidHex = (): string => {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const bytes = new Uint8Array(TID_BYTES);
    crypto.getRandomValues(bytes);
    if (bytes.some((b) => b !== 0)) {
      return bytes.toHex();
    }
  }
  throw new Error('tid generation exhausted');
};

const sleep = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
};

const withTimeout = async <T>(promise: Promise<T>, ms: number, err: string): Promise<T> => {
  const { promise: timeoutPromise, reject } = Promise.withResolvers<never>();
  AbortSignal.timeout(ms).addEventListener('abort', () => reject(new Error(err)), { once: true });
  return await Promise.race([promise, timeoutPromise]);
};

export const createFileSender = (deps: FileSenderDeps, factory?: WorkerFactory): FileSender => {
  const spawnWorker = factory ?? defaultWorkerFactory;

  let pendingSendQueue: PendingChunk[] = [];
  let activeWorker: Worker | undefined;
  let sendLoopRunning = false;
  let workerFinalReceived = false;
  let pendingSha256Hex: string | undefined;
  let senderFileRef: File | undefined;
  let lastSendNotifyPercent = -1;

  const resetLocal = (): void => {
    pendingSendQueue = [];
    activeWorker = undefined;
    sendLoopRunning = false;
    workerFinalReceived = false;
    pendingSha256Hex = undefined;
    senderFileRef = undefined;
    lastSendNotifyPercent = -1;
  };

  const currentActiveTid = (): string | undefined => transferActive.value?.tid;

  const requestWorkerShutdown = (worker: Worker): void => {
    try {
      worker.postMessage({ kind: 'abort' });
    } catch {
      /* already terminated */
    }
    globalThis.setTimeout(() => {
      worker.terminate();
    }, WORKER_CLOSED_TIMEOUT_MS);
  };

  const finishWithEvent = (event: SystemEventKind, worker?: Worker): void => {
    const target = worker ?? activeWorker;
    if (target !== undefined) {
      requestWorkerShutdown(target);
    }
    transferActive.value = null;
    resetLocal();
    deps.appendSystemEvent(event);
  };

  const sendCancel = (
    tid: string,
    reason: 'user_aborted' | 'session_rekey' = 'user_aborted',
  ): void => {
    void deps.sendEnvelope({
      kind: 'file_cancel',
      tid,
      side: 'sender',
      reason,
    });
  };

  const handleWorkerFatal = (worker: Worker): void => {
    const current = transferActive.value;
    if (current === null) {
      return;
    }
    sendCancel(current.tid);
    finishWithEvent('file_transfer_failed', worker);
  };

  const pullNextChunk = (worker: Worker, tid: string): boolean => {
    try {
      worker.postMessage({ kind: 'pull' });
      return true;
    } catch {
      sendCancel(tid);
      finishWithEvent('file_transfer_failed', worker);
      return false;
    }
  };

  const isStillSendingFor = (tid: string): boolean => {
    const current = transferActive.value;
    return current?.tid === tid && current.phase === 'sending';
  };

  const advanceSentBytes = (tid: string, dataLen: number): void => {
    const current = transferActive.value;
    if (current?.tid !== tid || current.phase !== 'sending') {
      return;
    }
    current.sentBytes += dataLen;
    const percent = current.size === 0 ? 100 : Math.floor((current.sentBytes / current.size) * 100);
    if (percent !== lastSendNotifyPercent) {
      lastSendNotifyPercent = percent;
      transferActive.value = { ...current };
    }
  };

  const encryptAndSendChunk = async (
    worker: Worker,
    tid: string,
    chunk: PendingChunk,
  ): Promise<boolean> => {
    const plaintext: Bytes = new Uint8Array(chunk.data);
    const sent = await deps.sendChunk(plaintext);
    if (!sent) {
      finishWithEvent('file_transfer_failed', worker);
      return false;
    }
    return true;
  };

  const finalizeVerifyingAsSuccess = (tid: string, name: string, size: number): void => {
    const now = transferActive.value;
    if (now?.tid !== tid || now.phase !== 'verifying') {
      return;
    }
    const senderFile = senderFileRef;
    transferActive.value = null;
    resetLocal();
    if (senderFile !== undefined) {
      attachmentMap.set(tid, {
        source: 'sender',
        senderFile,
        name,
        size,
      });
      notifyAttachmentChanged();
    }
  };

  const beginVerifyingPhase = (tid: string, name: string, size: number): void => {
    const timeout = AbortSignal.timeout(VERIFYING_TIMEOUT_MS);
    timeout.addEventListener(
      'abort',
      () => {
        finalizeVerifyingAsSuccess(tid, name, size);
      },
      { once: true },
    );
    transferActive.value = {
      tid,
      phase: 'verifying',
      name,
      size,
      abort: timeout,
    };
  };

  const finalizeSendAfterDrain = (worker: Worker, tid: string, sha256Hex: string): void => {
    const current = transferActive.value;
    if (current?.tid !== tid || current.phase !== 'sending') {
      return;
    }
    const { name, size } = current;
    void deps.sendEnvelope({ kind: 'file_complete', tid, sender_sha256: sha256Hex });
    requestWorkerShutdown(worker);
    activeWorker = undefined;
    workerFinalReceived = false;
    pendingSha256Hex = undefined;
    beginVerifyingPhase(tid, name, size);
  };

  const runSendLoop = async (worker: Worker, tid: string): Promise<void> => {
    sendLoopRunning = true;
    try {
      while (isStillSendingFor(tid)) {
        const ws = deps.getWs();
        if (ws === undefined || ws.readyState !== WebSocket.OPEN) {
          sendCancel(tid);
          finishWithEvent('file_transfer_failed', worker);
          return;
        }
        if (ws.bufferedAmount > OUTGOING_BUFFER_SOFT_CAP) {
          await sleep(BACKPRESSURE_POLL_MS);
          continue;
        }
        const next = pendingSendQueue.shift();
        if (next === undefined) {
          if (workerFinalReceived && pendingSha256Hex !== undefined) {
            finalizeSendAfterDrain(worker, tid, pendingSha256Hex);
            return;
          }
          await sleep(BACKPRESSURE_POLL_MS);
          continue;
        }
        const sent = await encryptAndSendChunk(worker, tid, next);
        if (!sent) {
          return;
        }
        if (!workerFinalReceived && !pullNextChunk(worker, tid)) {
          return;
        }
        advanceSentBytes(tid, next.data.byteLength - CHUNK_HEADER_BYTES);
      }
    } finally {
      sendLoopRunning = false;
    }
  };

  const onWorkerFinal = (sha256Hex: string, worker: Worker): void => {
    const current = transferActive.value;
    if (current?.phase !== 'sending' || activeWorker !== worker) {
      return;
    }
    workerFinalReceived = true;
    pendingSha256Hex = sha256Hex;
  };

  const handleWorkerMessage = (
    msg: WorkerOutMessage,
    worker: Worker,
    readyDeferred: PromiseWithResolvers<unknown>,
  ): void => {
    if (msg.kind === 'ready') {
      readyDeferred.resolve(true);
      return;
    }
    if (msg.kind === 'plaintext_chunk') {
      pendingSendQueue.push({ seq: msg.seq, data: msg.data });
      return;
    }
    if (msg.kind === 'final') {
      onWorkerFinal(msg.sha256_hex, worker);
      return;
    }
    if (msg.kind === 'fatal') {
      handleWorkerFatal(worker);
      return;
    }
    msg.kind satisfies 'closed';
  };

  const initialiseWorker = async (
    tid: string,
    file: File,
  ): Promise<{ worker: Worker } | undefined> => {
    let worker: Worker;
    try {
      worker = spawnWorker();
    } catch {
      finishWithEvent('file_transfer_failed');
      return undefined;
    }
    const readyDeferred = Promise.withResolvers<unknown>();
    worker.addEventListener('message', (event: MessageEvent<WorkerOutMessage>) => {
      handleWorkerMessage(event.data, worker, readyDeferred);
    });
    worker.addEventListener('error', () => {
      handleWorkerFatal(worker);
    });
    activeWorker = worker;

    let stream: ReadableStream<Uint8Array>;
    try {
      stream = file.stream();
    } catch {
      finishWithEvent('file_transfer_failed', worker);
      return undefined;
    }
    try {
      worker.postMessage(
        { kind: 'init', stream, tid: hexDecode(tid), initialCredit: INITIAL_CREDIT },
        [stream as Transferable],
      );
    } catch {
      finishWithEvent('file_transfer_failed', worker);
      return undefined;
    }
    try {
      await withTimeout(readyDeferred.promise, WORKER_READY_TIMEOUT_MS, 'worker_ready_timeout');
    } catch {
      sendCancel(tid);
      finishWithEvent('file_transfer_failed', worker);
      return undefined;
    }
    return { worker };
  };

  const onFileAcceptReceived = async (tid: string): Promise<void> => {
    const current = transferActive.value;
    if (current?.tid !== tid || current.phase !== 'offered') {
      return;
    }
    const { name, size, file } = current;
    const result = await initialiseWorker(tid, file);
    if (result === undefined) {
      return;
    }
    const { worker } = result;
    const afterInit = transferActive.value;
    if (afterInit?.tid !== tid || afterInit.phase !== 'offered') {
      requestWorkerShutdown(worker);
      return;
    }
    transferActive.value = {
      tid,
      phase: 'sending',
      name,
      size,
      sentBytes: 0,
      worker,
      abort: AbortSignal.timeout(VERIFYING_LIFETIME_MS),
    };
    if (!sendLoopRunning) {
      void runSendLoop(worker, tid);
    }
  };

  const dispatchFromReceiver = (envelope: FileEnvelopeFromReceiver): void => {
    const current = transferActive.value;
    if (current === null || envelope.tid !== current.tid) {
      return;
    }
    if (envelope.kind === 'file_accept') {
      void onFileAcceptReceived(envelope.tid);
      return;
    }
    if (envelope.kind === 'file_decline') {
      finishWithEvent(
        envelope.reason === 'unsupported' ? 'file_peer_unavailable' : 'file_transfer_cancelled',
      );
      return;
    }
    if (envelope.kind === 'file_progress') {
      return;
    }
    if (envelope.kind === 'file_complete_ack') {
      if (current.phase === 'verifying') {
        finalizeVerifyingAsSuccess(current.tid, current.name, current.size);
      }
      return;
    }
    if (envelope.side !== 'receiver') {
      return;
    }
    const event: SystemEventKind =
      envelope.reason === 'integrity_failure' ? 'file_transfer_failed' : 'file_transfer_cancelled';
    finishWithEvent(event);
  };

  const cancelActive = (reason: 'user_aborted' | 'session_rekey' = 'user_aborted'): void => {
    const current = transferActive.value;
    if (current === null) {
      return;
    }
    sendCancel(current.tid, reason);
    finishWithEvent('file_transfer_cancelled');
  };

  const installOfferedTimeout = (tid: string, abort: AbortSignal): void => {
    abort.addEventListener(
      'abort',
      () => {
        const now = transferActive.value;
        if (now?.tid === tid && now.phase === 'offered') {
          sendCancel(tid);
          transferActive.value = null;
          resetLocal();
          deps.appendSystemEvent('file_transfer_cancelled');
        }
      },
      { once: true },
    );
  };

  const startTransfer = async (file: File): Promise<void> => {
    if (transferActive.value !== null || incomingActive.value !== null) {
      return;
    }
    if (file.size <= 0 || file.size > MAX_FILE_SIZE_BYTES) {
      deps.appendSystemEvent('file_transfer_failed');
      return;
    }
    const sanitised = sanitizeFilename(file.name);
    if (sanitised === null) {
      deps.appendSystemEvent('file_transfer_failed');
      return;
    }
    const tid = generateTidHex();
    const abort = AbortSignal.timeout(OFFERED_TIMEOUT_MS);
    installOfferedTimeout(tid, abort);
    transferActive.value = {
      tid,
      phase: 'offered',
      name: sanitised,
      size: file.size,
      file,
      abort,
    };
    senderFileRef = file;
    appendFileMessage(tid, 'out', browserClock.nowIso());
    const sent = await deps.sendEnvelope({
      kind: 'file_offer',
      tid,
      name: sanitised,
      size: file.size,
    });
    if (!sent && currentActiveTid() === tid) {
      transferActive.value = null;
      resetLocal();
    }
  };

  const isActive = (): boolean => transferActive.value !== null;

  const unsubscribePageHide = onPageHide(() => {
    const current = transferActive.value;
    if (current === null) {
      return;
    }
    const ws = deps.getWs();
    if (ws !== undefined && ws.readyState === WebSocket.OPEN) {
      try {
        sendCancel(current.tid);
      } catch {
        /* mid-teardown */
      }
    }
    if (activeWorker !== undefined) {
      activeWorker.terminate();
    }
    transferActive.value = null;
    resetLocal();
  });

  const onWsClose = (): void => {
    const current = transferActive.value;
    if (current === null) {
      return;
    }
    if (current.phase !== 'sending' && current.phase !== 'verifying') {
      return;
    }
    if (activeWorker !== undefined) {
      try {
        activeWorker.terminate();
      } catch {
        /* already terminated */
      }
    }
    transferActive.value = null;
    resetLocal();
    deps.appendSystemEvent('file_transfer_failed');
  };

  const shutdown = (): void => {
    unsubscribePageHide();
    if (activeWorker !== undefined) {
      activeWorker.terminate();
    }
    transferActive.value = null;
    resetLocal();
  };

  return {
    startTransfer,
    dispatchFromReceiver,
    cancelActive,
    isActive,
    onWsClose,
    shutdown,
  };
};
