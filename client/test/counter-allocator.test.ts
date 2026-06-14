import { describe, expect, test } from 'bun:test';

import { RELAY_KIND_CHUNK, RELAY_KIND_MSG } from '@unseen/shared/wire/file-frame.ts';

import { allocateCounter, type SendState } from '../src/domain/send.ts';

const makeState = (persist?: (counter: bigint) => void): SendState => ({
  counterCommitted: 0n,
  counterReserved: 0n,
  role: 'initiator',
  sessionKey: {} as CryptoKey,
  ...(persist === undefined ? {} : { persistCounterReserved: persist }),
});

describe('persist-AHEAD counter allocator', () => {
  test('text-path: one persist per frame (block=1)', () => {
    const persisted: bigint[] = [];
    const state = makeState((c): void => {
      persisted.push(c);
    });
    for (let i = 1n; i <= 10n; i++) {
      const c = allocateCounter(state, RELAY_KIND_MSG);
      expect(c).toBe(i);
    }
    expect(persisted).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n]);
    expect(state.counterCommitted).toBe(10n);
    expect(state.counterReserved).toBe(10n);
  });

  test('chunk-path: amortised persist (block=64)', () => {
    const persisted: bigint[] = [];
    const state = makeState((c): void => {
      persisted.push(c);
    });
    for (let i = 1n; i <= 100n; i++) {
      allocateCounter(state, RELAY_KIND_CHUNK);
    }
    expect(persisted).toEqual([64n, 128n]);
    expect(state.counterCommitted).toBe(100n);
    expect(state.counterReserved).toBe(128n);
  });

  test('1000-chunk burst: ceil(1000/64) = 16 persists', () => {
    const persisted: bigint[] = [];
    const state = makeState((c): void => {
      persisted.push(c);
    });
    for (let i = 1n; i <= 1000n; i++) {
      allocateCounter(state, RELAY_KIND_CHUNK);
    }
    expect(persisted.length).toBe(16);
    expect(state.counterReserved).toBe(64n * 16n);
    expect(state.counterCommitted).toBe(1000n);
  });

  test('100 MiB file (12 064 chunks): ceil(12064/64) = 189 persists', () => {
    const persisted: bigint[] = [];
    const state = makeState((c): void => {
      persisted.push(c);
    });
    for (let i = 1n; i <= 12_064n; i++) {
      allocateCounter(state, RELAY_KIND_CHUNK);
    }
    expect(persisted.length).toBe(189);
  });

  test('mixed text + chunk: text frame inside an active chunk reservation does NOT persist', () => {
    const persisted: bigint[] = [];
    const state = makeState((c): void => {
      persisted.push(c);
    });
    allocateCounter(state, RELAY_KIND_CHUNK);
    expect(persisted).toEqual([64n]);
    for (let i = 0n; i < 5n; i++) {
      allocateCounter(state, RELAY_KIND_MSG);
    }
    expect(persisted).toEqual([64n]);
    expect(state.counterCommitted).toBe(6n);
    expect(state.counterReserved).toBe(64n);
  });

  test('RAM-mode (no persist callback): both counters advance, no error', () => {
    const state = makeState(undefined);
    for (let i = 1n; i <= 10n; i++) {
      allocateCounter(state, RELAY_KIND_MSG);
    }
    expect(state.counterCommitted).toBe(10n);
    expect(state.counterReserved).toBe(10n);
  });

  test('invariant: counterCommitted ≤ counterReserved at every step', () => {
    const state = makeState();
    for (let i = 1n; i <= 200n; i++) {
      allocateCounter(state, i % 2n === 0n ? RELAY_KIND_CHUNK : RELAY_KIND_MSG);
      expect(state.counterCommitted <= state.counterReserved).toBe(true);
    }
  });
});
