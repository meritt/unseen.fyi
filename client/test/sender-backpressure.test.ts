import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createFileSender, type FileSenderDeps } from '../src/domain/file-send.ts';
import { resetFileStateOnTerminate, transferActive } from '../src/domain/file-state.ts';
import type { SystemEventKind } from '../src/state/message-log.ts';

class MockWorker extends EventTarget {
  public terminated = false;
  public readonly outbox: Array<{ readonly kind: string }> = [];
  postMessage(message: unknown): void {
    this.outbox.push(message as { kind: string });
  }
  terminate(): void {
    this.terminated = true;
  }
  simulateMessage(payload: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: payload }));
  }
}

const asWorker = (mock: MockWorker): Worker => mock as unknown as Worker;

const sleep = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
};

type Harness = {
  readonly deps: FileSenderDeps;
  readonly frames: ArrayBuffer[];
  readonly events: SystemEventKind[];
  setWs: (ws: WebSocket | undefined) => void;
  setBuffered: (n: number) => void;
  setReadyState: (s: number) => void;
};

const makeHarness = (sendThrows = false): Harness => {
  const frames: ArrayBuffer[] = [];
  const events: SystemEventKind[] = [];
  let readyState: number = WebSocket.OPEN;
  let bufferedAmount = 0;
  let ws: WebSocket | undefined = {
    get readyState() {
      return readyState;
    },
    get bufferedAmount() {
      return bufferedAmount;
    },
  } as unknown as WebSocket;

  const deps: FileSenderDeps = {
    sendEnvelope: async () => await Promise.resolve(true),
    getWs: () => ws,
    sendChunk: async (plaintext): Promise<boolean> => {
      if (sendThrows) {
        return await Promise.resolve(false);
      }
      const copy = new Uint8Array(plaintext.byteLength);
      copy.set(plaintext);
      frames.push(copy.buffer);
      return await Promise.resolve(true);
    },
    appendSystemEvent: (event): void => {
      events.push(event);
    },
  };

  return {
    deps,
    frames,
    events,
    setWs: (next) => (ws = next),
    setBuffered: (n) => {
      bufferedAmount = n;
    },
    setReadyState: (s) => {
      readyState = s;
    },
  };
};

const driveToSending = async (
  deps: FileSenderDeps,
): Promise<{ worker: MockWorker; tid: string }> => {
  const mock = new MockWorker();
  const sender = createFileSender(deps, () => asWorker(mock));
  const file = new File([new Uint8Array(10_000)], 'driver.bin', {
    type: 'application/octet-stream',
  });
  await sender.startTransfer(file);
  const tid = transferActive.value?.tid;
  if (tid === undefined) {
    throw new Error('startTransfer did not set transferActive');
  }
  sender.dispatchFromReceiver({ kind: 'file_accept', tid });
  await sleep(5);
  mock.simulateMessage({ kind: 'ready' });
  await sleep(5);
  return { worker: mock, tid };
};

beforeEach(() => {
  resetFileStateOnTerminate();
});

afterEach(() => {
  resetFileStateOnTerminate();
});

describe('runSendLoop backpressure', () => {
  test('ws.readyState !== OPEN → fatal (worker terminate + system event)', async () => {
    const h = makeHarness();
    const { worker } = await driveToSending(h.deps);
    h.setReadyState(WebSocket.CLOSED);
    const data = new ArrayBuffer(8 + 4 + 100);
    worker.simulateMessage({ kind: 'plaintext_chunk', seq: 0, data });
    await sleep(80);
    expect(h.events).toContain('file_transfer_failed');
    expect(transferActive.value).toBeNull();
  });

  test('ws missing → fatal', async () => {
    const h = makeHarness();
    const { worker } = await driveToSending(h.deps);
    h.setWs(undefined);
    worker.simulateMessage({
      kind: 'plaintext_chunk',
      seq: 0,
      data: new ArrayBuffer(8 + 4 + 100),
    });
    await sleep(80);
    expect(h.events).toContain('file_transfer_failed');
    expect(transferActive.value).toBeNull();
  });

  test('ws.send throws → fatal', async () => {
    const h = makeHarness(true);
    const { worker } = await driveToSending(h.deps);
    worker.simulateMessage({
      kind: 'plaintext_chunk',
      seq: 0,
      data: new ArrayBuffer(8 + 4 + 100),
    });
    await sleep(80);
    expect(h.events).toContain('file_transfer_failed');
    expect(transferActive.value).toBeNull();
  });

  test('high bufferedAmount waits without sending', async () => {
    const h = makeHarness();
    const { worker } = await driveToSending(h.deps);
    h.setBuffered(500 * 1024);
    worker.simulateMessage({
      kind: 'plaintext_chunk',
      seq: 0,
      data: new ArrayBuffer(8 + 4 + 100),
    });
    await sleep(80);
    expect(h.frames.length).toBe(0);
    expect(transferActive.value?.phase).toBe('sending');
  });
});
