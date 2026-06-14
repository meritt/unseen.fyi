import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { PlaintextEnvelope } from '@unseen/shared/wire/envelope.ts';

import {
  createFileSender,
  type FileEnvelopeFromReceiver,
  type FileSenderDeps,
} from '../src/domain/file-send.ts';
import {
  incomingActive,
  resetFileStateOnTerminate,
  transferActive,
} from '../src/domain/file-state.ts';
import { clearMessages, type SystemEventKind } from '../src/state/message-log.ts';

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

const stubWs = (readyState: number = WebSocket.OPEN, bufferedAmount = 0): WebSocket =>
  ({
    readyState,
    bufferedAmount,
  }) as unknown as WebSocket;

const makeFile = (size: number, name = 'sample.bin'): File => {
  const bytes = new Uint8Array(size);
  return new File([bytes], name, { type: 'application/octet-stream' });
};

const makeDeps = (
  sendOk = true,
): {
  deps: FileSenderDeps;
  envelopes: PlaintextEnvelope[];
  events: SystemEventKind[];
  frames: ArrayBuffer[];
  setWs: (next: WebSocket | undefined) => void;
} => {
  const envelopes: PlaintextEnvelope[] = [];
  const events: SystemEventKind[] = [];
  const frames: ArrayBuffer[] = [];
  let ws: WebSocket | undefined = stubWs();
  const deps: FileSenderDeps = {
    sendEnvelope: async (envelope) => {
      envelopes.push(envelope);
      return await Promise.resolve(sendOk);
    },
    getWs: () => ws,
    sendChunk: async (plaintext): Promise<boolean> => {
      const copy = new Uint8Array(plaintext.byteLength);
      copy.set(plaintext);
      frames.push(copy.buffer);
      return await Promise.resolve(true);
    },
    appendSystemEvent: (event): void => {
      events.push(event);
    },
  };
  return { deps, envelopes, events, frames, setWs: (next) => (ws = next) };
};

beforeEach(() => {
  resetFileStateOnTerminate();
  clearMessages();
});

afterEach(() => {
  resetFileStateOnTerminate();
  clearMessages();
});

describe('startTransfer — preconditions', () => {
  test('no-op when transferActive already set (single-global)', async () => {
    const { deps, envelopes } = makeDeps();
    const sender = createFileSender(deps, () => asWorker(new MockWorker()));
    transferActive.value = {
      tid: '1111111111111111',
      phase: 'offered',
      name: 'busy.bin',
      size: 10,
      file: makeFile(10, 'busy.bin'),
      abort: AbortSignal.timeout(60_000),
    };
    await sender.startTransfer(makeFile(100, 'second.bin'));
    expect(envelopes).toEqual([]);
  });

  test('no-op when incomingActive already set', async () => {
    const { deps, envelopes } = makeDeps();
    const sender = createFileSender(deps, () => asWorker(new MockWorker()));
    incomingActive.value = {
      tid: '2222222222222222',
      phase: 'offer-pending',
      name: 'incoming.bin',
      size: 200,
    };
    await sender.startTransfer(makeFile(100, 'second.bin'));
    expect(envelopes).toEqual([]);
  });

  test('zero-size file → file_transfer_failed event, no offer', async () => {
    const { deps, envelopes, events } = makeDeps();
    const sender = createFileSender(deps, () => asWorker(new MockWorker()));
    await sender.startTransfer(makeFile(0));
    expect(envelopes).toEqual([]);
    expect(events).toEqual(['file_transfer_failed']);
    expect(transferActive.value).toBeNull();
  });

  test('over-MAX_FILE_SIZE_BYTES → file_transfer_failed', async () => {
    const { deps, envelopes, events } = makeDeps();
    const sender = createFileSender(deps, () => asWorker(new MockWorker()));
    const tooBig = makeFile(1, 'big.bin');
    Object.defineProperty(tooBig, 'size', { value: 200 * 1024 * 1024 });
    await sender.startTransfer(tooBig);
    expect(envelopes).toEqual([]);
    expect(events).toEqual(['file_transfer_failed']);
  });

  test('rejected filename (".") → file_transfer_failed', async () => {
    const { deps, envelopes, events } = makeDeps();
    const sender = createFileSender(deps, () => asWorker(new MockWorker()));
    const file = new File([new Uint8Array(10)], '.', { type: 'application/octet-stream' });
    await sender.startTransfer(file);
    expect(envelopes).toEqual([]);
    expect(events).toEqual(['file_transfer_failed']);
  });
});

describe('startTransfer — happy path', () => {
  test('transitions to offered, fires file_offer envelope with sanitised name', async () => {
    const { deps, envelopes } = makeDeps();
    const sender = createFileSender(deps, () => asWorker(new MockWorker()));
    await sender.startTransfer(makeFile(100, 'docs/foo bar.bin'));
    expect(transferActive.value?.phase).toBe('offered');
    expect(envelopes.length).toBe(1);
    const [first] = envelopes;
    expect(first?.kind).toBe('file_offer');
    if (first?.kind === 'file_offer') {
      expect(first.name).toBe('docs_foo bar.bin');
      expect(first.size).toBe(100);
      expect(first.tid).toMatch(/^[0-9a-f]{16}$/u);
    }
  });

  test('sendEnvelope=false during offer rolls back transferActive', async () => {
    const { deps, envelopes } = makeDeps(false);
    const sender = createFileSender(deps, () => asWorker(new MockWorker()));
    await sender.startTransfer(makeFile(50, 'rollback.bin'));
    expect(envelopes.length).toBe(1);
    expect(transferActive.value).toBeNull();
  });
});

describe('dispatchFromReceiver — file_accept', () => {
  test('wrong tid → silent drop', () => {
    const { deps } = makeDeps();
    const mock = new MockWorker();
    const sender = createFileSender(deps, () => asWorker(mock));
    transferActive.value = {
      tid: 'aaaaaaaaaaaaaaaa',
      phase: 'offered',
      name: 'x.bin',
      size: 10,
      file: makeFile(10, 'x.bin'),
      abort: AbortSignal.timeout(60_000),
    };
    sender.dispatchFromReceiver({
      kind: 'file_accept',
      tid: 'bbbbbbbbbbbbbbbb',
    } satisfies FileEnvelopeFromReceiver);
    expect(mock.terminated).toBe(false);
    expect(transferActive.value).toMatchObject({ phase: 'offered' });
  });

  test('matching tid → worker spawned, waiting for ready', async () => {
    const { deps } = makeDeps();
    let spawned: MockWorker | undefined;
    const sender = createFileSender(deps, () => {
      spawned = new MockWorker();
      return asWorker(spawned);
    });
    await sender.startTransfer(makeFile(100, 'a.bin'));
    const state = transferActive.value;
    expect(state).not.toBeNull();
    if (state === null) {
      return;
    }
    const { tid } = state;
    sender.dispatchFromReceiver({ kind: 'file_accept', tid } satisfies FileEnvelopeFromReceiver);
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 10);
    });
    expect(spawned).toBeDefined();
    expect(spawned?.outbox[0]?.kind).toBe('init');
  });
});

describe('dispatchFromReceiver — file_decline', () => {
  test('triggers file_transfer_cancelled regardless of reason', () => {
    const { deps, events } = makeDeps();
    const sender = createFileSender(deps, () => asWorker(new MockWorker()));
    transferActive.value = {
      tid: 'cccccccccccccccc',
      phase: 'offered',
      name: 'x.bin',
      size: 10,
      file: makeFile(10, 'x.bin'),
      abort: AbortSignal.timeout(60_000),
    };
    sender.dispatchFromReceiver({
      kind: 'file_decline',
      tid: 'cccccccccccccccc',
      reason: 'too_large',
    });
    expect(events).toContain('file_transfer_cancelled');
    expect(transferActive.value).toBeNull();
  });
});

describe('dispatchFromReceiver — file_cancel from receiver', () => {
  test('user_aborted → file_transfer_cancelled', () => {
    const { deps, events } = makeDeps();
    const sender = createFileSender(deps, () => asWorker(new MockWorker()));
    transferActive.value = {
      tid: 'dddddddddddddddd',
      phase: 'offered',
      name: 'x.bin',
      size: 10,
      file: makeFile(10, 'x.bin'),
      abort: AbortSignal.timeout(60_000),
    };
    sender.dispatchFromReceiver({
      kind: 'file_cancel',
      tid: 'dddddddddddddddd',
      side: 'receiver',
      reason: 'user_aborted',
    });
    expect(events).toContain('file_transfer_cancelled');
    expect(transferActive.value).toBeNull();
  });

  test('integrity_failure → file_transfer_failed', () => {
    const { deps, events } = makeDeps();
    const sender = createFileSender(deps, () => asWorker(new MockWorker()));
    transferActive.value = {
      tid: 'eeeeeeeeeeeeeeee',
      phase: 'sending',
      name: 'x.bin',
      size: 10,
      sentBytes: 0,
      worker: asWorker(new MockWorker()),
      abort: AbortSignal.timeout(60_000),
    };
    sender.dispatchFromReceiver({
      kind: 'file_cancel',
      tid: 'eeeeeeeeeeeeeeee',
      side: 'receiver',
      reason: 'integrity_failure',
    });
    expect(events).toContain('file_transfer_failed');
    expect(transferActive.value).toBeNull();
  });

  test('sender-side cancel echoed back is dropped defensively', () => {
    const { deps, events } = makeDeps();
    const sender = createFileSender(deps, () => asWorker(new MockWorker()));
    transferActive.value = {
      tid: 'ffffffffffffffff',
      phase: 'offered',
      name: 'x.bin',
      size: 10,
      file: makeFile(10, 'x.bin'),
      abort: AbortSignal.timeout(60_000),
    };
    sender.dispatchFromReceiver({
      kind: 'file_cancel',
      tid: 'ffffffffffffffff',
      side: 'sender',
      reason: 'user_aborted',
    });
    expect(events).toEqual([]);
    expect(transferActive.value).not.toBeNull();
  });
});

describe('dispatchFromReceiver — file_progress', () => {
  const tid = '1234567890abcdef';

  const makeSendingState = (size: number): void => {
    transferActive.value = {
      tid,
      phase: 'sending',
      name: 'x.bin',
      size,
      sentBytes: 0,
      worker: asWorker(new MockWorker()),
      abort: AbortSignal.timeout(60_000),
    };
  };

  test('monotonic increase accepted', () => {
    const { deps } = makeDeps();
    const sender = createFileSender(deps, () => asWorker(new MockWorker()));
    makeSendingState(1000);
    sender.dispatchFromReceiver({ kind: 'file_progress', tid, received_bytes: 100 });
    sender.dispatchFromReceiver({ kind: 'file_progress', tid, received_bytes: 500 });
    expect(transferActive.value?.phase).toBe('sending');
  });

  test('stale-lower value silently dropped', () => {
    const { deps, events } = makeDeps();
    const sender = createFileSender(deps, () => asWorker(new MockWorker()));
    makeSendingState(1000);
    sender.dispatchFromReceiver({ kind: 'file_progress', tid, received_bytes: 500 });
    sender.dispatchFromReceiver({ kind: 'file_progress', tid, received_bytes: 100 });
    expect(events).toEqual([]);
    expect(transferActive.value?.phase).toBe('sending');
  });

  test('out-of-bounds > size silently dropped', () => {
    const { deps, events } = makeDeps();
    const sender = createFileSender(deps, () => asWorker(new MockWorker()));
    makeSendingState(1000);
    sender.dispatchFromReceiver({ kind: 'file_progress', tid, received_bytes: 9999 });
    expect(events).toEqual([]);
    expect(transferActive.value?.phase).toBe('sending');
  });
});

describe('cancelActive (user)', () => {
  test('fires file_cancel and clears state', () => {
    const { deps, envelopes, events } = makeDeps();
    const sender = createFileSender(deps, () => asWorker(new MockWorker()));
    transferActive.value = {
      tid: '9999999999999999',
      phase: 'offered',
      name: 'x.bin',
      size: 10,
      file: makeFile(10, 'x.bin'),
      abort: AbortSignal.timeout(60_000),
    };
    sender.cancelActive();
    expect(envelopes.length).toBe(1);
    const [first] = envelopes;
    expect(first?.kind).toBe('file_cancel');
    expect(events).toContain('file_transfer_cancelled');
    expect(transferActive.value).toBeNull();
  });
});

describe('shutdown', () => {
  test('clears state and terminates the worker', () => {
    const { deps } = makeDeps();
    const mock = new MockWorker();
    const sender = createFileSender(deps, () => asWorker(mock));
    transferActive.value = {
      tid: '7777777777777777',
      phase: 'sending',
      name: 'x.bin',
      size: 10,
      sentBytes: 0,
      worker: asWorker(mock),
      abort: AbortSignal.timeout(60_000),
    };
    sender.shutdown();
    expect(transferActive.value).toBeNull();
  });
});

describe('isActive', () => {
  test('reflects transferActive state', () => {
    const { deps } = makeDeps();
    const sender = createFileSender(deps, () => asWorker(new MockWorker()));
    expect(sender.isActive()).toBe(false);
    transferActive.value = {
      tid: '8888888888888888',
      phase: 'offered',
      name: 'x.bin',
      size: 10,
      file: makeFile(10, 'x.bin'),
      abort: AbortSignal.timeout(60_000),
    };
    expect(sender.isActive()).toBe(true);
  });
});
