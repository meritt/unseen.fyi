import { describe, expect, test } from 'bun:test';

import { GRACE_PERIOD_MS } from '@unseen/shared/limits.ts';

import { loadConfig } from '../src/config.ts';
import { startCleanupSweeper, sweepRooms } from '../src/room/cleanup.ts';
import { createRoomRegistry } from '../src/room/registry.ts';
import { stubWs, withEnv } from './_helpers/harness.ts';

describe('cleanup grace configuration', () => {
  test('loadConfig defaults to spec GRACE_PERIOD_MS when UNSEEN_GRACE_MS is unset', async () => {
    await withEnv({ UNSEEN_GRACE_MS: undefined }, () => {
      expect(loadConfig().gracePeriodMs).toBe(GRACE_PERIOD_MS);
    });
  });

  test('loadConfig honours UNSEEN_GRACE_MS env override', async () => {
    await withEnv({ UNSEEN_GRACE_MS: '5000' }, () => {
      expect(loadConfig().gracePeriodMs).toBe(5000);
    });
  });

  test('loadConfig rejects negative or non-finite UNSEEN_GRACE_MS', async () => {
    await withEnv({ UNSEEN_GRACE_MS: '-1' }, () => {
      expect(() => loadConfig()).toThrow(/UNSEEN_GRACE_MS/);
    });
  });

  test('sweepRooms with custom grace removes HALF_OPEN rooms past the shorter window', () => {
    const registry = createRoomRegistry();
    const roomId = 'a'.repeat(32);
    const room = registry.create(roomId, stubWs().ws);
    room.state = 'HALF_OPEN';
    room.lastActivityAtMs = 0;

    const outcome = sweepRooms(registry, 6000, 5000);
    expect(outcome.graceExpired).toBe(1);
    expect(registry.get(roomId)).toBeUndefined();
  });

  test('sweepRooms respects spec default grace when none is passed', () => {
    const registry = createRoomRegistry();
    const roomId = 'b'.repeat(32);
    const room = registry.create(roomId, stubWs().ws);
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
