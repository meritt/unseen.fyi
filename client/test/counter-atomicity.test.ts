import { describe, expect, test } from 'bun:test';

import { RELAY_KIND_CHUNK } from '@unseen/shared/wire/file-frame.ts';

import { allocateCounter, type SendState } from '../src/domain/send.ts';

describe('persist-AHEAD atomicity', () => {
  test('persist throw on fresh extend → both counters unchanged', () => {
    const state: SendState = {
      counterCommitted: 5n,
      counterReserved: 5n,
      role: 'initiator',
      sessionKey: {} as CryptoKey,
      persistCounterReserved: (): void => {
        throw new Error('storage full');
      },
    };
    expect((): void => {
      allocateCounter(state, RELAY_KIND_CHUNK);
    }).toThrow('storage full');
    expect(state.counterCommitted).toBe(5n);
    expect(state.counterReserved).toBe(5n);
  });

  test('persist throw at block boundary leaves counters at the last successful state', () => {
    const calls: bigint[] = [];
    let throwOnNext = false;
    const state: SendState = {
      counterCommitted: 0n,
      counterReserved: 0n,
      role: 'initiator',
      sessionKey: {} as CryptoKey,
      persistCounterReserved: (c): void => {
        if (throwOnNext) {
          throw new Error('storage full');
        }
        calls.push(c);
      },
    };

    allocateCounter(state, RELAY_KIND_CHUNK);
    expect(state.counterCommitted).toBe(1n);
    expect(state.counterReserved).toBe(64n);

    for (let i = 0n; i < 63n; i++) {
      allocateCounter(state, RELAY_KIND_CHUNK);
    }
    expect(state.counterCommitted).toBe(64n);
    expect(state.counterReserved).toBe(64n);

    throwOnNext = true;
    expect((): void => {
      allocateCounter(state, RELAY_KIND_CHUNK);
    }).toThrow('storage full');
    expect(state.counterCommitted).toBe(64n);
    expect(state.counterReserved).toBe(64n);
  });
});
