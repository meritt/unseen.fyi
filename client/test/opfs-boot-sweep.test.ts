import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { bootSweepOpfs, OPFS_LOCK_NAME } from '../src/storage/opfs-transfers.ts';

type FakeDir = {
  readonly kind: 'directory';
  readonly name: string;
};

type LockRequest = { readonly name: string; readonly mode: unknown };

type StubState = {
  entries: FakeDir[];
  readonly removed: string[];
  readonly created: string[];
  readonly lockRequests: LockRequest[];
  rejectRemoveFor: Set<string>;
};

type ShimNavigator = {
  readonly storage: {
    readonly getDirectory: () => Promise<unknown>;
  };
  readonly locks: {
    readonly request: (
      name: string,
      opts: { readonly mode?: unknown },
      cb: (lock: unknown) => Promise<unknown>,
    ) => Promise<unknown>;
    readonly query: () => Promise<unknown>;
  };
};

const installShim = (
  initial: string[],
  overrides: {
    storageThrows?: boolean;
    locksThrows?: boolean;
    rejectRemoveFor?: string[];
    heldLockNames?: string[];
    pendingLockNames?: string[];
  } = {},
): StubState => {
  const state: StubState = {
    entries: initial.map((name) => ({ kind: 'directory', name })),
    removed: [],
    created: [],
    lockRequests: [],
    rejectRemoveFor: new Set(overrides.rejectRemoveFor ?? []),
  };
  const root = {
    async *values(): AsyncGenerator<FakeDir> {
      const snapshot = [...state.entries];
      for (const entry of snapshot) {
        yield entry;
      }
    },
    removeEntry: async (name: string): Promise<void> => {
      if (state.rejectRemoveFor.has(name)) {
        throw new Error(`stub: refusing to remove ${name}`);
      }
      state.removed.push(name);
      state.entries = state.entries.filter((entry) => entry.name !== name);
    },
    getDirectoryHandle: async (name: string): Promise<FakeDir> => {
      state.created.push(name);
      if (!state.entries.some((entry) => entry.name === name)) {
        state.entries.push({ kind: 'directory', name });
      }
      return { kind: 'directory', name };
    },
  };
  const navigatorShim: ShimNavigator = {
    storage: {
      getDirectory: async (): Promise<unknown> => {
        if (overrides.storageThrows === true) {
          throw new Error('stub: getDirectory rejected');
        }
        return root;
      },
    },
    locks: {
      request: async (name, opts, cb): Promise<unknown> => {
        if (overrides.locksThrows === true) {
          throw new Error('stub: locks rejected');
        }
        state.lockRequests.push({ name, mode: opts.mode });
        return await cb(null);
      },
      query: async (): Promise<unknown> => ({
        held: (overrides.heldLockNames ?? []).map((name) => ({ name })),
        pending: (overrides.pendingLockNames ?? []).map((name) => ({ name })),
      }),
    },
  };
  (globalThis as { navigator?: unknown }).navigator = navigatorShim;
  return state;
};

const originalNavigator = (globalThis as { navigator?: unknown }).navigator;

beforeEach(() => {});

afterEach(() => {
  (globalThis as { navigator?: unknown }).navigator = originalNavigator;
});

describe('bootSweepOpfs', () => {
  test('removes other opaque-named dirs and preserves currentOpaqueDir', async () => {
    const state = installShim(['currentOpaq1', 'other-aaaab', 'OtherBBB12-', 'randomFooBar']);

    const result = await bootSweepOpfs('currentOpaq1');

    expect(result.enabled).toBe(true);
    expect(state.removed).toContain('other-aaaab');
    expect(state.removed).toContain('OtherBBB12-');
    expect(state.removed).not.toContain('currentOpaq1');
    expect(state.removed).not.toContain('randomFooBar');
  });

  test('creates currentOpaqueDir if it is missing from the root', async () => {
    const state = installShim([]);

    const result = await bootSweepOpfs('newOpaque1Z');

    expect(result.enabled).toBe(true);
    expect(state.created).toContain('newOpaque1Z');
  });

  test('still calls getDirectoryHandle to ensure current dir exists when it is already present', async () => {
    const state = installShim(['alreadyHere']);

    const result = await bootSweepOpfs('alreadyHere');

    expect(result.enabled).toBe(true);
    expect(state.created).toContain('alreadyHere');
    expect(state.removed).not.toContain('alreadyHere');
  });

  test('returns enabled=false when navigator.storage.getDirectory rejects', async () => {
    installShim(['currentOpaq1'], { storageThrows: true });

    const result = await bootSweepOpfs('currentOpaq1');

    expect(result.enabled).toBe(false);
  });

  test('returns enabled=false when navigator.locks.request rejects', async () => {
    installShim(['currentOpaq1'], { locksThrows: true });

    const result = await bootSweepOpfs('currentOpaq1');

    expect(result.enabled).toBe(false);
  });

  test('continues sweep when an individual removeEntry rejects', async () => {
    const state = installShim(['corrupt-aaa', 'healthy-bbb', 'healthy-ccc', 'currentOpaq1'], {
      rejectRemoveFor: ['corrupt-aaa'],
    });

    const result = await bootSweepOpfs('currentOpaq1');

    expect(result.enabled).toBe(true);
    expect(state.removed).toContain('healthy-bbb');
    expect(state.removed).toContain('healthy-ccc');
    expect(state.removed).not.toContain('corrupt-aaa');
    expect(state.removed).not.toContain('currentOpaq1');
  });

  test('acquires a shared liveness lock named after the session dir before the sweep lock', async () => {
    const state = installShim([]);

    const result = await bootSweepOpfs('freshDirAa1');

    expect(result.enabled).toBe(true);
    expect(state.lockRequests).toEqual([
      { name: 'freshDirAa1', mode: 'shared' },
      { name: OPFS_LOCK_NAME, mode: 'exclusive' },
    ]);
    expect(state.created).toContain('freshDirAa1');
  });

  test('spares dirs whose liveness lock is held or pending, removes unheld orphans', async () => {
    const state = installShim(['currentAa11', 'liveDirBbb2', 'pendingDd44', 'orphanCcc33'], {
      heldLockNames: ['liveDirBbb2'],
      pendingLockNames: ['pendingDd44'],
    });

    const result = await bootSweepOpfs('currentAa11');

    expect(result.enabled).toBe(true);
    expect(state.removed).toEqual(['orphanCcc33']);
    expect(state.entries.some((entry) => entry.name === 'liveDirBbb2')).toBe(true);
    expect(state.entries.some((entry) => entry.name === 'pendingDd44')).toBe(true);
  });

  test('opaque-dir regex is strict — only 11-char base64url names match', async () => {
    const state = installShim([
      'too-short',
      'too-long-by-2chars',
      'invalid char',
      'AAAaaaBBBcc',
      'current1234',
    ]);

    const result = await bootSweepOpfs('current1234');

    expect(result.enabled).toBe(true);
    expect(state.removed).toEqual(['AAAaaaBBBcc']);
    expect(state.entries.some((e) => e.name === 'too-short')).toBe(true);
    expect(state.entries.some((e) => e.name === 'too-long-by-2chars')).toBe(true);
    expect(state.entries.some((e) => e.name === 'invalid char')).toBe(true);
  });
});
