import { describe, expect, test } from 'bun:test';

import { importAesGcmKey } from '@unseen/shared/crypto/aesgcm.ts';
import { BUFFER_THRESHOLD_BYTES } from '@unseen/shared/limits.ts';
import { RELAY_KIND_MSG } from '@unseen/shared/wire/file-frame.ts';

import {
  allocateCounter,
  type RelaySendConnection,
  type RelaySendTask,
  runRelaySendTask,
  type SendState,
} from '../src/domain/send.ts';

const setupKey = async (): Promise<CryptoKey> =>
  await importAesGcmKey(new Uint8Array(32).fill(3), 'non-extractable');

const fakeSocket = (readyState: number, bufferedAmount = 0): WebSocket =>
  ({ readyState, bufferedAmount }) as unknown as WebSocket;

type Harness = {
  readonly state: SendState;
  readonly reasons: string[];
  readonly sent: ArrayBuffer[];
  readonly persisted: bigint[];
  readonly task: RelaySendTask;
};

const makeHarness = (
  sessionKey: CryptoKey,
  overrides: Partial<Pick<RelaySendTask, 'isTerminated' | 'getConnection'>> & {
    sendImpl?: (frame: ArrayBuffer) => void;
  } = {},
): Harness => {
  const reasons: string[] = [];
  const sent: ArrayBuffer[] = [];
  const persisted: bigint[] = [];
  const state: SendState = {
    counterCommitted: 0n,
    counterReserved: 0n,
    role: 'initiator',
    sessionKey,
    persistCounterReserved: (counter): void => {
      persisted.push(counter);
    },
  };
  const connection: RelaySendConnection = {
    socket: fakeSocket(WebSocket.OPEN),
    send:
      overrides.sendImpl ??
      ((frame): void => {
        sent.push(frame);
      }),
  };
  const task: RelaySendTask = {
    isTerminated: overrides.isTerminated ?? ((): boolean => false),
    getConnection: overrides.getConnection ?? ((): RelaySendConnection => connection),
    terminate: (reason): void => {
      reasons.push(reason);
    },
    allocate: (kind) => allocateCounter(state, kind),
    keys: state,
    kind: RELAY_KIND_MSG,
    plaintext: new Uint8Array([1, 2, 3]),
    encryptFailReason: 'encrypt_failed',
  };
  return { state, reasons, sent, persisted, task };
};

describe('post-allocation failure: terminate, counter never rolls back', () => {
  test('connection.send throw after allocate+encrypt → terminate, counter stays bumped', async () => {
    const h = makeHarness(await setupKey(), {
      sendImpl: (): void => {
        throw new Error('ws send failed');
      },
    });
    const ok = await runRelaySendTask(h.task);
    expect(ok).toBe(false);
    expect(h.reasons).toEqual(['send_failed']);
    expect(h.state.counterCommitted).toBe(1n);
    expect(h.state.counterReserved).toBe(1n);
    expect(h.persisted).toEqual([1n]);
  });

  test('encrypt throw after allocate → terminate with the encrypt reason, counter stays bumped', async () => {
    const h = makeHarness({} as CryptoKey);
    const ok = await runRelaySendTask(h.task);
    expect(ok).toBe(false);
    expect(h.reasons).toEqual(['encrypt_failed']);
    expect(h.sent.length).toBe(0);
    expect(h.state.counterCommitted).toBe(1n);
    expect(h.persisted).toEqual([1n]);
  });
});

describe('pre-allocation preflight failure: no counter burned, no terminate', () => {
  test('socket not OPEN → false, session lives, counter untouched', async () => {
    const key = await setupKey();
    const h = makeHarness(key, {
      getConnection: (): RelaySendConnection => ({
        socket: fakeSocket(WebSocket.CLOSING),
        send: (): void => {
          throw new Error('must not be called');
        },
      }),
    });
    const ok = await runRelaySendTask(h.task);
    expect(ok).toBe(false);
    expect(h.reasons).toEqual([]);
    expect(h.state.counterCommitted).toBe(0n);
    expect(h.persisted).toEqual([]);
  });

  test('backpressure above threshold → false, session lives, counter untouched', async () => {
    const key = await setupKey();
    const h = makeHarness(key, {
      getConnection: (): RelaySendConnection => ({
        socket: fakeSocket(WebSocket.OPEN, BUFFER_THRESHOLD_BYTES + 1),
        send: (): void => {
          throw new Error('must not be called');
        },
      }),
    });
    const ok = await runRelaySendTask(h.task);
    expect(ok).toBe(false);
    expect(h.reasons).toEqual([]);
    expect(h.state.counterCommitted).toBe(0n);
  });

  test('no connection → false, session lives, counter untouched', async () => {
    const h = makeHarness(await setupKey(), {
      getConnection: (): RelaySendConnection | undefined => undefined,
    });
    const ok = await runRelaySendTask(h.task);
    expect(ok).toBe(false);
    expect(h.reasons).toEqual([]);
    expect(h.state.counterCommitted).toBe(0n);
  });

  test('already terminated → false without a second terminate', async () => {
    const h = makeHarness(await setupKey(), { isTerminated: (): boolean => true });
    const ok = await runRelaySendTask(h.task);
    expect(ok).toBe(false);
    expect(h.reasons).toEqual([]);
    expect(h.state.counterCommitted).toBe(0n);
  });
});

describe('success path', () => {
  test('open socket → frame sent, counter bumped exactly once', async () => {
    const h = makeHarness(await setupKey());
    const ok = await runRelaySendTask(h.task);
    expect(ok).toBe(true);
    expect(h.sent.length).toBe(1);
    expect(h.reasons).toEqual([]);
    expect(h.state.counterCommitted).toBe(1n);
    expect(h.persisted).toEqual([1n]);
  });
});
