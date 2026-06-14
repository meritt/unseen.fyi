import { describe, expect, test } from 'bun:test';

import { GRACE_PERIOD_MS } from '@unseen/shared/limits.ts';
import type { ServerWebSocket } from 'bun';

import { loadConfig } from '../src/config.ts';
import { startCleanupSweeper, sweepRooms } from '../src/room/cleanup.ts';
import { createRoomRegistry } from '../src/room/registry.ts';
import type { ConnectionData } from '../src/types.ts';

const stubWs = (): ServerWebSocket<ConnectionData> =>
  ({
    send: () => 1,
    close: () => {},
    getBufferedAmount: () => 0,
  }) as unknown as ServerWebSocket<ConnectionData>;

describe('cleanup grace configuration', () => {
  test('loadConfig defaults to spec GRACE_PERIOD_MS when UNSEEN_GRACE_MS is unset', () => {
    const original = Bun.env.UNSEEN_GRACE_MS;
    delete Bun.env.UNSEEN_GRACE_MS;
    try {
      const config = loadConfig();
      expect(config.gracePeriodMs).toBe(GRACE_PERIOD_MS);
    } finally {
      if (original !== undefined) {
        Bun.env.UNSEEN_GRACE_MS = original;
      }
    }
  });

  test('loadConfig honours UNSEEN_GRACE_MS env override', () => {
    const original = Bun.env.UNSEEN_GRACE_MS;
    Bun.env.UNSEEN_GRACE_MS = '5000';
    try {
      const config = loadConfig();
      expect(config.gracePeriodMs).toBe(5000);
    } finally {
      if (original === undefined) {
        delete Bun.env.UNSEEN_GRACE_MS;
      } else {
        Bun.env.UNSEEN_GRACE_MS = original;
      }
    }
  });

  test('loadConfig rejects negative or non-finite UNSEEN_GRACE_MS', () => {
    const original = Bun.env.UNSEEN_GRACE_MS;
    Bun.env.UNSEEN_GRACE_MS = '-1';
    try {
      expect(() => loadConfig()).toThrow(/UNSEEN_GRACE_MS/);
    } finally {
      if (original === undefined) {
        delete Bun.env.UNSEEN_GRACE_MS;
      } else {
        Bun.env.UNSEEN_GRACE_MS = original;
      }
    }
  });

  test('sweepRooms with custom grace removes HALF_OPEN rooms past the shorter window', () => {
    const registry = createRoomRegistry();
    const roomId = 'a'.repeat(32);
    const room = registry.create(roomId, stubWs());
    room.state = 'HALF_OPEN';
    room.lastActivityAtMs = 0;

    const outcome = sweepRooms(registry, 6000, 5000);
    expect(outcome.graceExpired).toBe(1);
    expect(registry.get(roomId)).toBeUndefined();
  });

  test('sweepRooms respects spec default grace when none is passed', () => {
    const registry = createRoomRegistry();
    const roomId = 'b'.repeat(32);
    const room = registry.create(roomId, stubWs());
    room.state = 'HALF_OPEN';
    room.lastActivityAtMs = 0;

    const outcome = sweepRooms(registry, 10_000);
    expect(outcome.graceExpired).toBe(0);
    expect(registry.get(roomId)).toBeDefined();
  });

  test('startCleanupSweeper collects idle IP buckets on every tick', async () => {
    const registry = createRoomRegistry();
    let gcCalls = 0;
    const sweeper = startCleanupSweeper(registry, GRACE_PERIOD_MS, 5, {
      gc: (): void => {
        gcCalls += 1;
      },
    });
    try {
      await Bun.sleep(30);
    } finally {
      sweeper.stop();
    }
    expect(gcCalls).toBeGreaterThan(0);
  });
});
