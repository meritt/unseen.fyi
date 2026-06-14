import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { runStateTransition } from '../src/lifecycle/view-transitions.ts';
import { sessionState } from '../src/state/session-state.ts';

const originalDoc = (globalThis as { document?: unknown }).document;

let calls: number;
let transitionFactory: () => { ready: Promise<void>; finished: Promise<void> };

beforeEach(() => {
  calls = 0;
  transitionFactory = () => ({ ready: Promise.resolve(), finished: Promise.resolve() });
  Object.defineProperty(globalThis, 'document', {
    value: {
      startViewTransition: (cb: () => void): unknown => {
        calls += 1;
        cb();
        return transitionFactory();
      },
    },
    configurable: true,
  });
  sessionState.value = 'IDLE';
});

afterEach(() => {
  Object.defineProperty(globalThis, 'document', { value: originalDoc, configurable: true });
  sessionState.value = 'IDLE';
});

describe('runStateTransition', () => {
  test('wraps the callback in startViewTransition when state is non-terminal', () => {
    sessionState.value = 'ACTIVE';
    let ran = 0;
    runStateTransition(() => {
      ran += 1;
    });
    expect(calls).toBe(1);
    expect(ran).toBe(1);
  });

  test('skips startViewTransition in FATAL_ENDING', () => {
    sessionState.value = 'FATAL_ENDING';
    let ran = 0;
    runStateTransition(() => {
      ran += 1;
    });
    expect(calls).toBe(0);
    expect(ran).toBe(1);
  });

  test('skips startViewTransition in TERMINATED', () => {
    sessionState.value = 'TERMINATED';
    let ran = 0;
    runStateTransition(() => {
      ran += 1;
    });
    expect(calls).toBe(0);
    expect(ran).toBe(1);
  });

  test('swallows skipped/aborted transition rejections without leaking unhandled rejections', async () => {
    sessionState.value = 'ACTIVE';
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      transitionFactory = () => ({
        ready: Promise.reject(new Error('Transition was skipped')),
        finished: Promise.reject(new Error('Transition was aborted because of invalid state')),
      });
      let ran = 0;
      expect(() => {
        runStateTransition(() => {
          ran += 1;
        });
      }).not.toThrow();
      expect(ran).toBe(1);
      await Bun.sleep(10);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
