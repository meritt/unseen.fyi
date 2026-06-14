import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { claimRoom } from '../src/domain/duplicate-tab.ts';

const makeLockManager = (): LockManager => {
  const held = new Set<string>();

  const request: LockManager['request'] = ((
    name: string,
    options: LockOptions,
    callback: (lock: Lock | null) => Promise<unknown>,
  ) => {
    if (options.ifAvailable === true && held.has(name)) {
      return Promise.resolve(callback(null));
    }
    const lock: Lock = { name, mode: options.mode ?? 'exclusive' };
    held.add(name);
    return Promise.resolve(callback(lock)).finally(() => {
      held.delete(name);
    });
  }) as unknown as LockManager['request'];

  return {
    request,
    query: () => Promise.resolve({ held: [], pending: [] }),
  } as LockManager;
};

const originalLocks = globalThis.navigator.locks;

beforeEach(() => {
  Object.defineProperty(globalThis.navigator, 'locks', {
    value: makeLockManager(),
    configurable: true,
  });
});

afterEach(() => {
  Object.defineProperty(globalThis.navigator, 'locks', {
    value: originalLocks,
    configurable: true,
  });
});

describe('claimRoom', () => {
  test('first call resolves to a release handle', async () => {
    const claim = await claimRoom('abc123');
    expect(claim).not.toBeNull();
    expect(typeof claim?.release).toBe('function');
  });

  test('second call returns null while first lock is held', async () => {
    const first = await claimRoom('shared-name');
    expect(first).not.toBeNull();
    const second = await claimRoom('shared-name');
    expect(second).toBeNull();
    first?.release();
  });

  test('release frees the lock so a subsequent claim succeeds', async () => {
    const first = await claimRoom('reusable');
    expect(first).not.toBeNull();
    first?.release();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const second = await claimRoom('reusable');
    expect(second).not.toBeNull();
    second?.release();
  });

  test('parallel claims on different lock names both succeed', async () => {
    const [a, b] = await Promise.all([claimRoom('lock-a'), claimRoom('lock-b')]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    a?.release();
    b?.release();
  });
});
