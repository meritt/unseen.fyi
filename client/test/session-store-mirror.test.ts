import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  mirrorStoredSession,
  readStoredSession,
  type StoredSession,
  writeStoredSession,
} from '../src/storage/session-store.ts';
import { installSessionStorage } from './_helpers/session-storage.ts';

const KEY = 'unseen-test-mirror';

let restore: () => void;

beforeEach(() => {
  restore = installSessionStorage();
});

afterEach(() => {
  restore();
});

const RECORD: StoredSession = { r: 'i', k: 'wrapped-key', cid: 'cred-id', s: '3', n: '4' };

const mirror = (): ReturnType<typeof mirrorStoredSession> => {
  writeStoredSession(KEY, RECORD);
  return mirrorStoredSession(RECORD, (next) => {
    writeStoredSession(KEY, next);
  });
};

describe('mirrorStoredSession', () => {
  test('a counter write after the rekey marker keeps the marker', () => {
    const state = mirror();
    state.setRekeyInProgress();
    state.setCounterSend(9n);
    const stored = readStoredSession(KEY);
    expect(stored?.rekey_in_progress).toBe(true);
    expect(stored?.s).toBe('9');
  });

  test('the rekey marker keeps the counters already persisted', () => {
    const state = mirror();
    state.setCounterSend(11n);
    state.setCounterRecv(12n);
    state.setRekeyInProgress();
    const stored = readStoredSession(KEY);
    expect(stored?.s).toBe('11');
    expect(stored?.n).toBe('12');
    expect(stored?.rekey_in_progress).toBe(true);
  });
});
