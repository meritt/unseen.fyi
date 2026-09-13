import { describe, expect, jest, test } from 'bun:test';

import { RELIEF_MIN_INTERVAL_MS, startMemoryPressureRelief } from '../src/memory-pressure.ts';
import { emitMemoryPressure } from './_helpers/harness.ts';

describe('memory pressure relief', () => {
  test('relieves on the first event', () => {
    let calls = 0;
    const relief = startMemoryPressureRelief(() => {
      calls += 1;
    });
    try {
      emitMemoryPressure('warning');
    } finally {
      relief.stop();
    }
    expect(calls).toBe(1);
  });

  test('throttles a burst to a single relief', () => {
    let calls = 0;
    const relief = startMemoryPressureRelief(() => {
      calls += 1;
    });
    try {
      for (let i = 0; i < 10; i += 1) {
        emitMemoryPressure('critical');
      }
    } finally {
      relief.stop();
    }
    expect(calls).toBe(1);
  });

  test('relieves again once the interval has passed', () => {
    jest.useFakeTimers();
    let calls = 0;
    const relief = startMemoryPressureRelief(() => {
      calls += 1;
    });
    try {
      emitMemoryPressure('critical');
      jest.advanceTimersByTime(RELIEF_MIN_INTERVAL_MS);
      emitMemoryPressure('critical');
    } finally {
      relief.stop();
      jest.useRealTimers();
    }
    expect(calls).toBe(2);
  });

  test('a throwing relief neither escapes nor blocks the next one', () => {
    jest.useFakeTimers();
    let calls = 0;
    const relief = startMemoryPressureRelief(() => {
      calls += 1;
      throw new Error('relief failed');
    });
    try {
      expect(() => {
        emitMemoryPressure('critical');
      }).not.toThrow();
      jest.advanceTimersByTime(RELIEF_MIN_INTERVAL_MS);
      emitMemoryPressure('critical');
    } finally {
      relief.stop();
      jest.useRealTimers();
    }
    expect(calls).toBe(2);
  });

  test('stop() detaches the process listener', () => {
    let calls = 0;
    const relief = startMemoryPressureRelief(() => {
      calls += 1;
    });
    emitMemoryPressure('critical');
    relief.stop();
    emitMemoryPressure('critical');
    expect(calls).toBe(1);
  });

  test('repeated start/stop leaves no listener behind', () => {
    const before = process.listenerCount('memoryPressure' as never);
    for (let i = 0; i < 5; i += 1) {
      startMemoryPressureRelief(() => {}).stop();
    }
    expect(process.listenerCount('memoryPressure' as never)).toBe(before);
  });
});
