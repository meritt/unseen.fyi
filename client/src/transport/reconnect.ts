export const BACKOFF_SCHEDULE_MS = [1000, 2000, 4000, 8000, 16_000, 30_000, 60_000] as const;
export const RECONNECT_CUMULATIVE_CAP_MS = 5 * 60 * 1000;

export const nextReconnectDelayMs = (attempt: number, elapsedMs: number): number | null => {
  if (attempt < 0 || !Number.isFinite(attempt)) {
    throw new RangeError('attempt must be a non-negative finite number');
  }
  if (elapsedMs >= RECONNECT_CUMULATIVE_CAP_MS) {
    return null;
  }
  const index = Math.min(attempt, BACKOFF_SCHEDULE_MS.length - 1);
  const candidate = BACKOFF_SCHEDULE_MS[index];
  if (candidate === undefined) {
    return null;
  }
  const remaining = RECONNECT_CUMULATIVE_CAP_MS - elapsedMs;
  return Math.min(candidate, remaining);
};
