import { describe, expect, test } from 'bun:test';

import {
  BACKOFF_SCHEDULE_MS,
  nextReconnectDelayMs,
  RECONNECT_CUMULATIVE_CAP_MS,
} from '../src/transport/reconnect.ts';

describe('nextReconnectDelayMs', () => {
  test('first six attempts follow the schedule exactly when no time has elapsed', () => {
    for (let i = 0; i < BACKOFF_SCHEDULE_MS.length; i += 1) {
      expect(nextReconnectDelayMs(i, 0)).toBe(BACKOFF_SCHEDULE_MS[i] ?? -1);
    }
  });

  test('attempts beyond the schedule clamp to the final delay until the cap', () => {
    const last = BACKOFF_SCHEDULE_MS.at(-1) ?? 0;
    expect(nextReconnectDelayMs(BACKOFF_SCHEDULE_MS.length, 0)).toBe(last);
    expect(nextReconnectDelayMs(BACKOFF_SCHEDULE_MS.length + 5, 0)).toBe(last);
  });

  test('returns null once cumulative elapsed reaches the 5-minute cap', () => {
    expect(nextReconnectDelayMs(3, RECONNECT_CUMULATIVE_CAP_MS)).toBeNull();
    expect(nextReconnectDelayMs(3, RECONNECT_CUMULATIVE_CAP_MS + 1)).toBeNull();
  });

  test('shortens the final delay to fit the remaining budget when close to the cap', () => {
    const elapsed = RECONNECT_CUMULATIVE_CAP_MS - 500;
    const delay = nextReconnectDelayMs(0, elapsed);
    expect(delay).toBe(500);
  });

  test('rejects negative or non-finite attempt counts', () => {
    expect(() => nextReconnectDelayMs(-1, 0)).toThrow(RangeError);
    expect(() => nextReconnectDelayMs(Number.NaN, 0)).toThrow(RangeError);
    expect(() => nextReconnectDelayMs(Number.POSITIVE_INFINITY, 0)).toThrow(RangeError);
  });
});
