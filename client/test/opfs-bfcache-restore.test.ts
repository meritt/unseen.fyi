import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { installBFCacheGuard } from '../src/lifecycle/bfcache.ts';
import { sessionState } from '../src/state/session-state.ts';

installBFCacheGuard();

type FakeDir = {
  readonly kind: 'directory';
  readonly name: string;
};

type StubState = {
  entries: FakeDir[];
  readonly removed: string[];
};

const installShim = (initial: string[], liveLockNames: string[] = []): StubState => {
  const state: StubState = {
    entries: initial.map((name) => ({ kind: 'directory', name })),
    removed: [],
  };
  const root = {
    async *values(): AsyncGenerator<FakeDir> {
      const snapshot = [...state.entries];
      for (const entry of snapshot) {
        yield entry;
      }
    },
    removeEntry: (name: string): Promise<void> => {
      state.removed.push(name);
      state.entries = state.entries.filter((entry) => entry.name !== name);
      return Promise.resolve();
    },
  };
  (globalThis as { navigator?: unknown }).navigator = {
    storage: {
      getDirectory: (): Promise<unknown> => Promise.resolve(root),
    },
    locks: {
      request: (
        _name: string,
        _opts: unknown,
        cb: (lock: unknown) => Promise<unknown>,
      ): Promise<unknown> => cb(null),
      query: (): Promise<unknown> =>
        Promise.resolve({ held: liveLockNames.map((name) => ({ name })), pending: [] }),
    },
  };
  return state;
};

const originalNavigator = (globalThis as { navigator?: unknown }).navigator;

const dispatchPageshow = (persisted: boolean): void => {
  const event = new Event('pageshow') as Event & { persisted?: boolean };
  Object.defineProperty(event, 'persisted', { value: persisted, configurable: true });
  globalThis.dispatchEvent(event);
};

const drainMicrotasks = async (): Promise<void> => {
  for (let index = 0; index < 32; index += 1) {
    await Promise.resolve();
  }
};

beforeEach(() => {
  sessionState.value = 'ACTIVE';
});

afterEach(() => {
  (globalThis as { navigator?: unknown }).navigator = originalNavigator;
  sessionState.value = 'IDLE';
});

describe('bfcache guard fires opfs sweep on persisted pageshow', () => {
  test('sweeps opaque 11-char dirs and forces session into TERMINATED', async () => {
    const state = installShim(['aaaaaaaaaaa', 'bbbbbbbbbbb', 'short', 'too-long-by-2chars']);

    dispatchPageshow(true);

    expect(sessionState.value).toBe('TERMINATED');

    await drainMicrotasks();

    expect(state.removed).toContain('aaaaaaaaaaa');
    expect(state.removed).toContain('bbbbbbbbbbb');
    expect(state.removed).not.toContain('short');
    expect(state.removed).not.toContain('too-long-by-2chars');
  });

  test('spares dirs whose liveness lock is held, removes the rest', async () => {
    const state = installShim(['aaaaaaaaaaa', 'bbbbbbbbbbb'], ['aaaaaaaaaaa']);

    dispatchPageshow(true);
    await drainMicrotasks();

    expect(state.removed).toEqual(['bbbbbbbbbbb']);
    expect(state.entries.some((entry) => entry.name === 'aaaaaaaaaaa')).toBe(true);
  });

  test('pageshow with persisted=false does not sweep or change state', async () => {
    const state = installShim(['aaaaaaaaaaa']);

    dispatchPageshow(false);
    await drainMicrotasks();

    expect(state.removed).toEqual([]);
    expect(sessionState.value).toBe('ACTIVE');
  });

  test('persisted=true is a no-op when session is already TERMINATED', async () => {
    const state = installShim(['aaaaaaaaaaa']);
    sessionState.value = 'TERMINATED';

    dispatchPageshow(true);
    await drainMicrotasks();

    expect(state.removed).toEqual([]);
  });
});
