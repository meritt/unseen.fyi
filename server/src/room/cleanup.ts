import {
  GRACE_PERIOD_MS,
  INITIATOR_WAIT_TIMEOUT_MS,
  SWEEP_INTERVAL_MS,
} from '@unseen/shared/limits.ts';
import { encodePeerLeft } from '@unseen/shared/wire/codec.ts';

import type { Room, RoomRegistry } from './registry.ts';
import { safeSend } from './send.ts';

const WS_CLOSE_NORMAL = 1000;

export type SweepOutcome = {
  readonly waitingExpired: number;
  readonly graceExpired: number;
};

export const sweepRooms = (
  registry: RoomRegistry,
  now: number = performance.now(),
  gracePeriodMs: number = GRACE_PERIOD_MS,
): SweepOutcome => {
  let waitingExpired = 0;
  let graceExpired = 0;
  const rooms: Room[] = [...registry.list()];
  for (const room of rooms) {
    if (room.state === 'WAITING' && now - room.createdAtMs > INITIATOR_WAIT_TIMEOUT_MS) {
      room.initiator?.close(WS_CLOSE_NORMAL, 'timeout');
      registry.delete(room.roomId);
      waitingExpired += 1;
      continue;
    }
    if (room.state === 'HALF_OPEN' && now - room.lastActivityAtMs >= gracePeriodMs) {
      const remaining = room.initiator ?? room.joiner;
      if (remaining !== undefined) {
        safeSend(remaining, encodePeerLeft());
        remaining.close(WS_CLOSE_NORMAL, 'grace_expired');
      }
      registry.delete(room.roomId);
      graceExpired += 1;
    }
  }
  return { waitingExpired, graceExpired };
};

type IdleBucketCollector = {
  readonly gc: (now?: number) => void;
};

export const startCleanupSweeper = (
  registry: RoomRegistry,
  gracePeriodMs: number = GRACE_PERIOD_MS,
  sweepIntervalMs: number = SWEEP_INTERVAL_MS,
  ipLimiter?: IdleBucketCollector,
): { stop: () => void } => {
  const timer = setInterval(() => {
    const now = performance.now();
    sweepRooms(registry, now, gracePeriodMs);
    ipLimiter?.gc(now);
  }, sweepIntervalMs);
  return {
    stop: (): void => {
      clearInterval(timer);
    },
  };
};
