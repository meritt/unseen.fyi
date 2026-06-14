import { describe, expect, test } from 'bun:test';

import { Signal } from '../src/state/signal.ts';

describe('Signal', () => {
  test('notifies subscribers on value change', () => {
    const signal = new Signal(0);
    const seen: number[] = [];
    const unsubscribe = signal.subscribe(() => seen.push(signal.value));
    signal.value = 1;
    signal.value = 2;
    unsubscribe();
    signal.value = 3;
    expect(seen).toEqual([1, 2]);
  });

  test('suppresses notifications when the value is Object.is-equal', () => {
    const signal = new Signal({ a: 1 });
    const seen: number[] = [];
    signal.subscribe(() => seen.push(1));
    signal.value = signal.value;
    expect(seen).toEqual([]);
  });

  test('stops notifying after the AbortSignal aborts', () => {
    const signal = new Signal(0);
    const controller = new AbortController();
    const seen: number[] = [];
    signal.subscribe(() => seen.push(signal.value), { signal: controller.signal });
    signal.value = 1;
    controller.abort();
    signal.value = 2;
    expect(seen).toEqual([1]);
  });
});
