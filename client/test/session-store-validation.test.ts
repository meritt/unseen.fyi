import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { readStoredSession } from '../src/storage/session-store.ts';

const KEY = 'unseen-test-session';

class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) ?? null) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

let original: unknown;

beforeEach(() => {
  original = (globalThis as { sessionStorage?: unknown }).sessionStorage;
  (globalThis as { sessionStorage?: unknown }).sessionStorage = new MemoryStorage();
});

afterEach(() => {
  (globalThis as { sessionStorage?: unknown }).sessionStorage = original;
});

const put = (record: Record<string, unknown>): void => {
  globalThis.sessionStorage.setItem(KEY, JSON.stringify(record));
};

const base = { r: 'i', k: 'wrapped-key', cid: 'cred-id' };

describe('readStoredSession — counter validation', () => {
  test('rejects a non-numeric send counter (NaN)', () => {
    put({ ...base, s: 'NaN', n: '0' });
    expect(readStoredSession(KEY)).toBeUndefined();
  });

  test('rejects a non-integer recv counter (1e10)', () => {
    put({ ...base, s: '0', n: '1e10' });
    expect(readStoredSession(KEY)).toBeUndefined();
  });

  test('rejects an empty counter string', () => {
    put({ ...base, s: '', n: '0' });
    expect(readStoredSession(KEY)).toBeUndefined();
  });

  test('rejects a signed counter (-1)', () => {
    put({ ...base, s: '0', n: '-1' });
    expect(readStoredSession(KEY)).toBeUndefined();
  });

  test('accepts well-formed numeric counters', () => {
    put({ ...base, s: '5', n: '9' });
    const record = readStoredSession(KEY);
    expect(record).toBeDefined();
    expect(record?.s).toBe('5');
    expect(record?.n).toBe('9');
  });
});
