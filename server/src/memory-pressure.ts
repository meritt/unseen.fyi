import { logger } from './log/log.ts';

export const RELIEF_MIN_INTERVAL_MS = 1000;

export const startMemoryPressureRelief = (relieve: () => void): { stop: () => void } => {
  let lastReliefAt = Number.NEGATIVE_INFINITY;
  const handler = (level: 'warning' | 'critical'): void => {
    const now = performance.now();
    if (now - lastReliefAt < RELIEF_MIN_INTERVAL_MS) {
      return;
    }
    lastReliefAt = now;
    try {
      relieve();
    } catch {
      logger.error('memory_pressure_relief_failed');
      return;
    }
    logger.warn(`memory_pressure_${level}`);
  };
  process.on('memoryPressure', handler);
  return {
    stop: (): void => {
      process.off('memoryPressure', handler);
    },
  };
};
