import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';

import type { PlaintextEnvelope } from '@unseen/shared/wire/envelope.ts';

import { createFileReceiver, type FileReceiverDeps } from '../src/domain/file-receive.ts';
import {
  attachmentMap,
  fileTransferReady,
  fileTransferSupported,
  incomingActive,
  type IncomingState,
  resetFileStateOnTerminate,
  sessionReceivedBytes,
  transferActive,
} from '../src/domain/file-state.ts';
import type { ReceiveState } from '../src/domain/receive.ts';
import { clearMessages, type SystemEventKind } from '../src/state/message-log.ts';
import { currentOpaqueDir } from '../src/storage/opfs-transfers.ts';

class MockWorker extends EventTarget {
  public readonly outbox: Array<{ readonly kind: string; readonly data?: unknown }> = [];
  public terminated = false;

  postMessage(message: unknown): void {
    const msg = message as { kind: string };
    this.outbox.push({ kind: msg.kind, data: message });
  }

  terminate(): void {
    this.terminated = true;
  }

  simulateMessage(payload: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: payload }));
  }
}

const asWorker = (mock: MockWorker): Worker => mock as unknown as Worker;

const makeOffer = (
  overrides: Partial<Extract<PlaintextEnvelope, { kind: 'file_offer' }>> = {},
): Extract<PlaintextEnvelope, { kind: 'file_offer' }> => ({
  kind: 'file_offer',
  tid: overrides.tid ?? '1234567890abcdef',
  name: overrides.name ?? 'sample.bin',
  size: overrides.size ?? 1024,
});

const makeDeps = (
  sendOk = true,
): {
  deps: FileReceiverDeps;
  envelopes: PlaintextEnvelope[];
  events: SystemEventKind[];
} => {
  const envelopes: PlaintextEnvelope[] = [];
  const events: SystemEventKind[] = [];
  const deps: FileReceiverDeps = {
    sendEnvelope: async (envelope) => {
      envelopes.push(envelope);
      return await Promise.resolve(sendOk);
    },
    getReceiveState: (): ReceiveState => ({
      counterRecv: 0n,
      role: 'joiner',
      sessionKey: {} as CryptoKey,
    }),
    syncReceiveState: (): void => {},
    appendSystemEvent: (event): void => {
      events.push(event);
    },
  };
  return { deps, envelopes, events };
};

beforeEach(() => {
  resetFileStateOnTerminate();
  clearMessages();
  fileTransferSupported.value = true;
  fileTransferReady.value = true;
  currentOpaqueDir.value = 'AbCdEfGhIjK';
});

afterEach(() => {
  resetFileStateOnTerminate();
  clearMessages();
  fileTransferSupported.value = true;
  fileTransferReady.value = false;
  currentOpaqueDir.value = undefined;
});

describe('dispatchOffer — pre-accept gate', () => {
  test('size > MAX → file_decline { too_large }', () => {
    const { deps, envelopes } = makeDeps();
    const receiver = createFileReceiver(deps, () => asWorker(new MockWorker()));
    receiver.dispatchOffer(makeOffer({ size: 200 * 1024 * 1024 }));
    expect(envelopes).toEqual([
      { kind: 'file_decline', tid: '1234567890abcdef', reason: 'too_large' },
    ]);
    expect(incomingActive.value).toBeNull();
  });

  test('size = 0 → file_decline { unsupported }', () => {
    const { deps, envelopes } = makeDeps();
    const receiver = createFileReceiver(deps, () => asWorker(new MockWorker()));
    receiver.dispatchOffer(makeOffer({ size: 0 }));
    expect(envelopes[0]).toEqual({
      kind: 'file_decline',
      tid: '1234567890abcdef',
      reason: 'unsupported',
    });
  });

  test('empty name → file_decline { unsupported }', () => {
    const { deps, envelopes } = makeDeps();
    const receiver = createFileReceiver(deps, () => asWorker(new MockWorker()));
    receiver.dispatchOffer(makeOffer({ name: '' }));
    expect(envelopes[0]).toEqual({
      kind: 'file_decline',
      tid: '1234567890abcdef',
      reason: 'unsupported',
    });
  });

  test('transferActive non-null → file_decline { unsupported }', () => {
    const { deps, envelopes } = makeDeps();
    const receiver = createFileReceiver(deps, () => asWorker(new MockWorker()));
    transferActive.value = {
      tid: 'aaaaaaaaaaaaaaaa',
      phase: 'offered',
      name: 'out.bin',
      size: 10,
      file: new File([new Uint8Array(10)], 'out.bin'),
      abort: AbortSignal.timeout(60_000),
    };
    receiver.dispatchOffer(makeOffer());
    expect(envelopes[0]).toMatchObject({ kind: 'file_decline', reason: 'unsupported' });
  });

  test('incomingActive non-null → file_decline { unsupported }', () => {
    const { deps, envelopes } = makeDeps();
    const receiver = createFileReceiver(deps, () => asWorker(new MockWorker()));
    incomingActive.value = {
      tid: 'bbbbbbbbbbbbbbbb',
      phase: 'offer-pending',
      name: 'in.bin',
      size: 10,
    };
    receiver.dispatchOffer(makeOffer({ tid: 'cccccccccccccccc' }));
    expect(envelopes[0]).toMatchObject({ kind: 'file_decline', reason: 'unsupported' });
  });

  test('duplicate tid already in attachmentMap → file_decline { unsupported }', () => {
    const { deps, envelopes } = makeDeps();
    const receiver = createFileReceiver(deps, () => asWorker(new MockWorker()));
    attachmentMap.set('1234567890abcdef', {
      source: 'opfs',
      handle: {} as unknown as FileSystemFileHandle,
      name: 'old.bin',
      size: 100,
    });
    receiver.dispatchOffer(makeOffer());
    expect(envelopes[0]).toMatchObject({ kind: 'file_decline', reason: 'unsupported' });
  });

  test('sessionReceivedBytes + size > cap → file_decline + system event once', () => {
    const { deps, envelopes, events } = makeDeps();
    const receiver = createFileReceiver(deps, () => asWorker(new MockWorker()));
    sessionReceivedBytes.value = 500 * 1024 * 1024 - 100;
    receiver.dispatchOffer(makeOffer({ size: 1024 }));
    expect(envelopes[0]).toMatchObject({ kind: 'file_decline', reason: 'unsupported' });
    expect(events).toContain('file_session_cap_reached');
    receiver.dispatchOffer(makeOffer({ tid: '2222222222222222', size: 1024 }));
    const capEvents = events.filter((e) => e === 'file_session_cap_reached');
    expect(capEvents.length).toBe(1);
  });

  test('fileTransferSupported=false → file_decline { unsupported }', () => {
    const { deps, envelopes } = makeDeps();
    const receiver = createFileReceiver(deps, () => asWorker(new MockWorker()));
    fileTransferSupported.value = false;
    receiver.dispatchOffer(makeOffer());
    expect(envelopes[0]).toMatchObject({ kind: 'file_decline', reason: 'unsupported' });
  });

  test('fileTransferReady=false → file_decline { unsupported }', () => {
    const { deps, envelopes } = makeDeps();
    const receiver = createFileReceiver(deps, () => asWorker(new MockWorker()));
    fileTransferReady.value = false;
    receiver.dispatchOffer(makeOffer());
    expect(envelopes[0]).toMatchObject({ kind: 'file_decline', reason: 'unsupported' });
  });

  test('happy pre-accept → offer-pending state, no envelope', () => {
    const { deps, envelopes } = makeDeps();
    const receiver = createFileReceiver(deps, () => asWorker(new MockWorker()));
    receiver.dispatchOffer(makeOffer({ name: 'photo.png', size: 4096 }));
    expect(envelopes).toEqual([]);
    expect(incomingActive.value).toMatchObject({
      phase: 'offer-pending',
      name: 'photo.png',
      size: 4096,
    });
  });
});

describe('acceptOffer / declineOffer / cancel', () => {
  const tid = '1234567890abcdef';

  const setupOfferPending = (
    deps: FileReceiverDeps,
    worker: MockWorker,
  ): ReturnType<typeof createFileReceiver> => {
    const receiver = createFileReceiver(deps, () => asWorker(worker));
    receiver.dispatchOffer(makeOffer({ tid, name: 'file.bin', size: 1024 }));
    return receiver;
  };

  test('user Accept → file_accept envelope, worker spawned, → receiving', async () => {
    const { deps, envelopes } = makeDeps();
    const worker = new MockWorker();
    const receiver = setupOfferPending(deps, worker);
    const acceptPromise = receiver.acceptOffer();
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });
    worker.simulateMessage({ kind: 'ready' });
    await acceptPromise;
    expect(worker.outbox[0]?.kind).toBe('init');
    expect(envelopes).toEqual([{ kind: 'file_accept', tid }]);
    expect(incomingActive.value?.phase).toBe('receiving');
  });

  test('double Accept in the spawn window spawns only one worker', async () => {
    const { deps, envelopes } = makeDeps();
    const workers: MockWorker[] = [];
    const receiver = createFileReceiver(deps, () => {
      const worker = new MockWorker();
      workers.push(worker);
      return asWorker(worker);
    });
    receiver.dispatchOffer(makeOffer({ tid, name: 'file.bin', size: 1024 }));

    const first = receiver.acceptOffer();
    const second = receiver.acceptOffer();
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });
    expect(workers.length).toBe(1);
    workers[0]?.simulateMessage({ kind: 'ready' });
    await Promise.all([first, second]);

    expect(workers.length).toBe(1);
    expect(envelopes).toEqual([{ kind: 'file_accept', tid }]);
    expect(incomingActive.value?.phase).toBe('receiving');
  });

  test('user Decline → file_decline { user_rejected }, → null', () => {
    const { deps, envelopes } = makeDeps();
    const receiver = setupOfferPending(deps, new MockWorker());
    receiver.declineOffer();
    expect(envelopes).toEqual([{ kind: 'file_decline', tid, reason: 'user_rejected' }]);
    expect(incomingActive.value).toBeNull();
  });

  test('file_cancel{sender} mid-offer-pending → file_transfer_cancelled', () => {
    const { deps, events } = makeDeps();
    const receiver = setupOfferPending(deps, new MockWorker());
    receiver.dispatchCancel({
      kind: 'file_cancel',
      tid,
      side: 'sender',
      reason: 'user_aborted',
    });
    expect(events).toContain('file_transfer_cancelled');
    expect(incomingActive.value).toBeNull();
  });

  test('file_cancel{sender, integrity_failure} → file_transfer_failed', () => {
    const { deps, events } = makeDeps();
    const receiver = setupOfferPending(deps, new MockWorker());
    receiver.dispatchCancel({
      kind: 'file_cancel',
      tid,
      side: 'sender',
      reason: 'integrity_failure',
    });
    expect(events).toContain('file_transfer_failed');
  });

  test('file_cancel{receiver, ...} echoed back → silent drop', () => {
    const { deps, events } = makeDeps();
    const receiver = setupOfferPending(deps, new MockWorker());
    receiver.dispatchCancel({
      kind: 'file_cancel',
      tid,
      side: 'receiver',
      reason: 'user_aborted',
    });
    expect(events).toEqual([]);
    expect(incomingActive.value?.phase).toBe('offer-pending');
  });

  test('cancelActive in offer-pending → behaves like Decline', () => {
    const { deps, envelopes } = makeDeps();
    const receiver = setupOfferPending(deps, new MockWorker());
    receiver.cancelActive();
    expect(envelopes).toEqual([{ kind: 'file_decline', tid, reason: 'user_rejected' }]);
    expect(incomingActive.value).toBeNull();
  });

  test('file_accept send fails (blip) → offer stays pending and re-arms the 60s timeout', async () => {
    jest.useFakeTimers();
    try {
      const { deps, envelopes, events } = makeDeps(false);
      const worker = new MockWorker();
      const receiver = setupOfferPending(deps, worker);

      const accept = receiver.acceptOffer();
      await Promise.resolve();
      worker.simulateMessage({ kind: 'ready' });
      await accept;

      expect(envelopes).toContainEqual({ kind: 'file_accept', tid });
      expect(worker.terminated).toBe(true);
      expect(incomingActive.value?.phase).toBe('offer-pending');

      jest.advanceTimersByTime(60_000);
      expect(incomingActive.value).toBeNull();
      expect(events).toContain('file_transfer_cancelled');
    } finally {
      jest.useRealTimers();
    }
  });

  test('acceptOffer with currentOpaqueDir=undefined → file_decline { unsupported }', async () => {
    const { deps, envelopes } = makeDeps();
    const receiver = setupOfferPending(deps, new MockWorker());
    currentOpaqueDir.value = undefined;
    await receiver.acceptOffer();
    expect(envelopes).toEqual([{ kind: 'file_decline', tid, reason: 'unsupported' }]);
    expect(incomingActive.value).toBeNull();
  });
});

describe('acceptOffer — worker init failure', () => {
  const tid = '1234567890abcdef';

  test('worker never posts ready → timeout declines offer, terminates worker, next accept works', async () => {
    const { deps, envelopes } = makeDeps();
    const workers: MockWorker[] = [];
    const receiver = createFileReceiver(deps, () => {
      const worker = new MockWorker();
      workers.push(worker);
      return asWorker(worker);
    });
    receiver.dispatchOffer(makeOffer({ tid, name: 'file.bin', size: 1024 }));

    await receiver.acceptOffer();

    expect(workers.length).toBe(1);
    expect(workers[0]?.terminated).toBe(true);
    expect(envelopes).toEqual([{ kind: 'file_decline', tid, reason: 'unsupported' }]);
    expect(incomingActive.value).toBeNull();

    const tid2 = '2222222222222222';
    receiver.dispatchOffer(makeOffer({ tid: tid2, name: 'file.bin', size: 1024 }));
    const secondAccept = receiver.acceptOffer();
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });
    expect(workers.length).toBe(2);
    workers[1]?.simulateMessage({ kind: 'ready' });
    await secondAccept;
    expect(envelopes).toContainEqual({ kind: 'file_accept', tid: tid2 });
    expect(incomingActive.value?.phase).toBe('receiving');
  }, 15_000);

  test('fatal posted before ready → offer declined, worker terminated, state reset', async () => {
    const { deps, envelopes } = makeDeps();
    const worker = new MockWorker();
    const receiver = createFileReceiver(deps, () => asWorker(worker));
    receiver.dispatchOffer(makeOffer({ tid, name: 'file.bin', size: 1024 }));
    const acceptPromise = receiver.acceptOffer();
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });
    worker.simulateMessage({ kind: 'fatal', err: 'lock_or_opfs_failed' });
    await acceptPromise;
    expect(worker.terminated).toBe(true);
    expect(envelopes).toEqual([{ kind: 'file_decline', tid, reason: 'unsupported' }]);
    expect(incomingActive.value).toBeNull();
  });

  test('worker error event before ready → offer declined, worker terminated', async () => {
    const { deps, envelopes } = makeDeps();
    const worker = new MockWorker();
    const receiver = createFileReceiver(deps, () => asWorker(worker));
    receiver.dispatchOffer(makeOffer({ tid, name: 'file.bin', size: 1024 }));
    const acceptPromise = receiver.acceptOffer();
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });
    worker.dispatchEvent(new Event('error'));
    await acceptPromise;
    expect(worker.terminated).toBe(true);
    expect(envelopes).toEqual([{ kind: 'file_decline', tid, reason: 'unsupported' }]);
    expect(incomingActive.value).toBeNull();
  });
});

describe('chunk path — bounds, queue cap, cancel', () => {
  const tid = '1234567890abcdef';

  const installReceivingState = (size: number, worker: MockWorker): void => {
    incomingActive.value = {
      tid,
      phase: 'receiving',
      name: 'file.bin',
      size,
      expectedSize: size,
      nextExpectedSeq: 0,
      networkReceivedBytes: 0,
      bytesWritten: 0,
      receiveCredit: 4,
      pendingChunkQueue: [],
      worker: asWorker(worker),
      abort: AbortSignal.timeout(60_000),
    };
  };

  test('user cancelActive in receiving → file_cancel envelope + file_transfer_cancelled', () => {
    const { deps, envelopes, events } = makeDeps();
    const worker = new MockWorker();
    const receiver = createFileReceiver(deps, () => asWorker(worker));
    installReceivingState(8692, worker);
    receiver.cancelActive();
    expect(envelopes[0]).toEqual({
      kind: 'file_cancel',
      tid,
      side: 'receiver',
      reason: 'user_aborted',
    });
    expect(events).toContain('file_transfer_cancelled');
    expect(incomingActive.value).toBeNull();
  });

  test('dispatchCancel{sender} mid-receiving → worker abort + file_transfer_cancelled', () => {
    const { deps, events } = makeDeps();
    const worker = new MockWorker();
    const receiver = createFileReceiver(deps, () => asWorker(worker));
    installReceivingState(8692, worker);
    receiver.dispatchCancel({
      kind: 'file_cancel',
      tid,
      side: 'sender',
      reason: 'user_aborted',
    });
    expect(worker.outbox.some((m) => m.kind === 'abort')).toBe(true);
    expect(events).toContain('file_transfer_cancelled');
    expect(incomingActive.value).toBeNull();
  });
});

describe('dispatchComplete — early file_complete', () => {
  const tid = '1234567890abcdef';

  test('received_bytes < expected → integrity_failure + file_transfer_failed', () => {
    const { deps, envelopes, events } = makeDeps();
    const worker = new MockWorker();
    const receiver = createFileReceiver(deps, () => asWorker(worker));
    incomingActive.value = {
      tid,
      phase: 'receiving',
      name: 'file.bin',
      size: 8692 * 2,
      expectedSize: 8692 * 2,
      nextExpectedSeq: 1,
      networkReceivedBytes: 8692,
      bytesWritten: 8692,
      receiveCredit: 4,
      pendingChunkQueue: [],
      worker: asWorker(worker),
      abort: AbortSignal.timeout(60_000),
    };
    receiver.dispatchComplete({
      kind: 'file_complete',
      tid,
      sender_sha256: 'a'.repeat(64),
    });
    expect(envelopes[0]).toMatchObject({
      kind: 'file_cancel',
      side: 'receiver',
      reason: 'integrity_failure',
    });
    expect(events).toContain('file_transfer_failed');
    expect(incomingActive.value).toBeNull();
  });

  test('received_bytes >= expected → finalize sent to worker, senderSha256 stored', () => {
    const { deps } = makeDeps();
    const worker = new MockWorker();
    const receiver = createFileReceiver(deps, () => asWorker(worker));
    incomingActive.value = {
      tid,
      phase: 'receiving',
      name: 'file.bin',
      size: 8692,
      expectedSize: 8692,
      nextExpectedSeq: 1,
      networkReceivedBytes: 8692,
      bytesWritten: 8692,
      receiveCredit: 4,
      pendingChunkQueue: [],
      worker: asWorker(worker),
      abort: AbortSignal.timeout(60_000),
    };
    receiver.dispatchComplete({
      kind: 'file_complete',
      tid,
      sender_sha256: 'b'.repeat(64),
    });
    expect(worker.outbox.some((m) => m.kind === 'finalize')).toBe(true);
    const live = (incomingActive as unknown as { value: IncomingState | null }).value;
    if (live?.phase !== 'receiving') {
      throw new Error('expected receiving state');
    }
    expect(live.senderSha256).toBe('b'.repeat(64));
  });

  test('all chunks received but some still queued for write → finalize deferred, sha stored', () => {
    const { deps, envelopes, events } = makeDeps();
    const worker = new MockWorker();
    const receiver = createFileReceiver(deps, () => asWorker(worker));
    incomingActive.value = {
      tid,
      phase: 'receiving',
      name: 'file.bin',
      size: 8692 * 3,
      expectedSize: 8692 * 3,
      nextExpectedSeq: 3,
      networkReceivedBytes: 8692 * 3,
      bytesWritten: 8692 * 2,
      receiveCredit: 0,
      pendingChunkQueue: [{ seq: 2, data: new ArrayBuffer(8692) }],
      worker: asWorker(worker),
      abort: AbortSignal.timeout(60_000),
    };
    receiver.dispatchComplete({
      kind: 'file_complete',
      tid,
      sender_sha256: 'd'.repeat(64),
    });
    expect(worker.outbox.some((m) => m.kind === 'finalize')).toBe(false);
    expect(envelopes).toEqual([]);
    expect(events).toEqual([]);
    const live = (incomingActive as unknown as { value: IncomingState | null }).value;
    if (live?.phase !== 'receiving') {
      throw new Error('expected receiving state');
    }
    expect(live.senderSha256).toBe('d'.repeat(64));
    expect(live.finalizeRequested).not.toBe(true);
  });

  test('unknown tid → silent drop', () => {
    const { deps, envelopes, events } = makeDeps();
    const worker = new MockWorker();
    const receiver = createFileReceiver(deps, () => asWorker(worker));
    incomingActive.value = {
      tid,
      phase: 'receiving',
      name: 'file.bin',
      size: 100,
      expectedSize: 100,
      nextExpectedSeq: 0,
      networkReceivedBytes: 0,
      bytesWritten: 0,
      receiveCredit: 4,
      pendingChunkQueue: [],
      worker: asWorker(worker),
      abort: AbortSignal.timeout(60_000),
    };
    receiver.dispatchComplete({
      kind: 'file_complete',
      tid: 'fedcba9876543210',
      sender_sha256: 'c'.repeat(64),
    });
    expect(envelopes).toEqual([]);
    expect(events).toEqual([]);
    const live = (incomingActive as unknown as { value: IncomingState | null }).value;
    expect(live?.tid).toBe(tid);
  });
});

describe('shutdown', () => {
  test('terminates worker and clears incomingActive', () => {
    const { deps } = makeDeps();
    const worker = new MockWorker();
    const receiver = createFileReceiver(deps, () => asWorker(worker));
    incomingActive.value = {
      tid: '7777777777777777',
      phase: 'receiving',
      name: 'a.bin',
      size: 10,
      expectedSize: 10,
      nextExpectedSeq: 0,
      networkReceivedBytes: 0,
      bytesWritten: 0,
      receiveCredit: 4,
      pendingChunkQueue: [],
      worker: asWorker(worker),
      abort: AbortSignal.timeout(60_000),
    };
    receiver.shutdown();
    expect(worker.terminated).toBe(true);
    expect(incomingActive.value).toBeNull();
  });
});
