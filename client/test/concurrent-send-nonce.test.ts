import { describe, expect, test } from 'bun:test';

import { importAesGcmKey } from '@unseen/shared/crypto/aesgcm.ts';
import type { Bytes } from '@unseen/shared/crypto/encoding.ts';
import {
  RELAY_KIND_CHUNK,
  RELAY_KIND_MSG,
  type RelayKind,
} from '@unseen/shared/wire/file-frame.ts';

import { parseNonce } from '../src/domain/nonce.ts';
import {
  allocateCounter,
  createSendSerializer,
  encryptRelayFrame,
  type SendState,
} from '../src/domain/send.ts';

const RELAY_NONCE_OFFSET = 2;
const NONCE_LENGTH = 12;

const nonceOf = (frame: ArrayBuffer): Bytes =>
  new Uint8Array(frame).slice(RELAY_NONCE_OFFSET, RELAY_NONCE_OFFSET + NONCE_LENGTH);

const oneByte = (value: number): Bytes => {
  const bytes = new Uint8Array(1);
  bytes[0] = value & 0xff;
  return bytes;
};

const compareBigint = (a: bigint, b: bigint): number => {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
};

const sendOnSharedState = async (
  state: SendState,
  kind: RelayKind,
  plaintext: Bytes,
): Promise<ArrayBuffer> => {
  const counter = allocateCounter(state, kind);
  return await encryptRelayFrame(state, kind, counter, plaintext);
};

describe('concurrent sends on a shared SendState', () => {
  test('overlapping chunk/text/mode sends produce strictly unique nonces', async () => {
    const sessionKey = await importAesGcmKey(new Uint8Array(32).fill(7), 'non-extractable');
    const state: SendState = {
      counterCommitted: 0n,
      counterReserved: 0n,
      role: 'initiator',
      sessionKey,
    };

    const kinds: RelayKind[] = Array.from({ length: 200 }, (_, i) =>
      i % 2 === 0 ? RELAY_KIND_CHUNK : RELAY_KIND_MSG,
    );

    const frames = await Promise.all(
      kinds.map((kind, i) => sendOnSharedState(state, kind, oneByte(i))),
    );

    const counters = frames.map((frame) => parseNonce(nonceOf(frame)).counter);
    expect(new Set(counters.map(String)).size).toBe(frames.length);

    const nonces = frames.map((frame) => nonceOf(frame).join(','));
    expect(new Set(nonces).size).toBe(frames.length);

    const sorted = counters.toSorted(compareBigint);
    expect(sorted[0]).toBe(1n);
    expect(sorted.at(-1)).toBe(BigInt(frames.length));
  });
});

describe('outbound serialization preserves wire order', () => {
  const N = 64;
  const invertedDelayMs = (index: number): number => (N - index) % 7;

  const emitInOrder = async (
    state: SendState,
    run: (task: () => Promise<bigint>) => Promise<bigint>,
  ): Promise<bigint[]> => {
    const emitted: bigint[] = [];
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        run(async () => {
          const counter = allocateCounter(state, RELAY_KIND_MSG);
          await new Promise<void>((resolve) => {
            globalThis.setTimeout(resolve, invertedDelayMs(i));
          });
          const frame = await encryptRelayFrame(state, RELAY_KIND_MSG, counter, oneByte(i));
          emitted.push(parseNonce(nonceOf(frame)).counter);
          return counter;
        }),
      ),
    );
    return emitted;
  };

  const freshState = async (): Promise<SendState> => ({
    counterCommitted: 0n,
    counterReserved: 0n,
    role: 'initiator',
    sessionKey: await importAesGcmKey(new Uint8Array(32).fill(9), 'non-extractable'),
  });

  const ascending = Array.from({ length: N }, (_, i) => BigInt(i + 1));

  test('serializer emits frames in strict counter order despite inverted encrypt latency', async () => {
    const state = await freshState();
    const enqueue = createSendSerializer();
    const emitted = await emitInOrder(state, (task) => enqueue(task));
    expect(emitted).toEqual(ascending);
  });

  test('without the serializer, inverted latency reorders the wire (the H-A bug class)', async () => {
    const state = await freshState();
    const emitted = await emitInOrder(state, (task) => task());
    expect(emitted).not.toEqual(ascending);
  });
});
