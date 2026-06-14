import type { RoomRegistry } from './registry.ts';

export const pingAll = (registry: RoomRegistry): number => {
  let pinged = 0;
  for (const room of registry.list()) {
    for (const ws of [room.initiator, room.joiner]) {
      if (ws === undefined) {
        continue;
      }
      try {
        ws.ping();
        pinged += 1;
      } catch {
        /* socket closing/closed */
      }
    }
  }
  return pinged;
};

export const startKeepalive = (
  registry: RoomRegistry,
  intervalMs: number,
): { stop: () => void } => {
  const timer = setInterval(() => {
    pingAll(registry);
  }, intervalMs);
  return {
    stop: (): void => {
      clearInterval(timer);
    },
  };
};
