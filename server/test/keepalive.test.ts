import { describe, expect, test } from 'bun:test';

import type { ServerWebSocket } from 'bun';

import { loadConfig } from '../src/config.ts';
import { pingAll, startKeepalive } from '../src/room/keepalive.ts';
import { createRoomRegistry } from '../src/room/registry.ts';
import type { ConnectionData } from '../src/types.ts';

type PingingWs = ServerWebSocket<ConnectionData> & { pings: number };

const stubWs = (opts: { readonly throws?: boolean } = {}): PingingWs => {
  const ws = {
    pings: 0,
    send: (): number => 1,
    close: (): void => {},
    getBufferedAmount: (): number => 0,
    ping: (): number => {
      if (opts.throws === true) {
        throw new Error('socket closing');
      }
      ws.pings += 1;
      return 1;
    },
  } as unknown as PingingWs;
  return ws;
};

const withKeepaliveEnv = (value: string | undefined, run: () => void): void => {
  const original = Bun.env.UNSEEN_WS_KEEPALIVE_MS;
  if (value === undefined) {
    delete Bun.env.UNSEEN_WS_KEEPALIVE_MS;
  } else {
    Bun.env.UNSEEN_WS_KEEPALIVE_MS = value;
  }
  try {
    run();
  } finally {
    if (original === undefined) {
      delete Bun.env.UNSEEN_WS_KEEPALIVE_MS;
    } else {
      Bun.env.UNSEEN_WS_KEEPALIVE_MS = original;
    }
  }
};

describe('keepalive pingAll', () => {
  test('pings both peers of every room, including a lone WAITING initiator', () => {
    const registry = createRoomRegistry();
    const initiator = stubWs();
    const joiner = stubWs();
    const paired = registry.create('a'.repeat(32), initiator);
    paired.joiner = joiner;
    paired.state = 'PAIRED';
    const lone = stubWs();
    registry.create('b'.repeat(32), lone);

    const pinged = pingAll(registry);

    expect(pinged).toBe(3);
    expect(initiator.pings).toBe(1);
    expect(joiner.pings).toBe(1);
    expect(lone.pings).toBe(1);
  });

  test('skips empty slots and swallows a ping that throws on a closing socket', () => {
    const registry = createRoomRegistry();
    const closing = stubWs({ throws: true });
    const healthy = stubWs();
    const room = registry.create('c'.repeat(32), closing);
    room.joiner = healthy;
    room.state = 'PAIRED';

    const pinged = pingAll(registry);

    expect(pinged).toBe(1);
    expect(healthy.pings).toBe(1);
  });
});

describe('startKeepalive', () => {
  test('pings every open socket on each tick and stops cleanly', async () => {
    const registry = createRoomRegistry();
    const ws = stubWs();
    registry.create('d'.repeat(32), ws);

    const keepalive = startKeepalive(registry, 5);
    try {
      await Bun.sleep(30);
    } finally {
      keepalive.stop();
    }
    const afterStop = ws.pings;
    expect(afterStop).toBeGreaterThan(0);

    await Bun.sleep(20);
    expect(ws.pings).toBe(afterStop);
  });
});

describe('keepalive configuration', () => {
  test('loadConfig defaults UNSEEN_WS_KEEPALIVE_MS to 20000', () => {
    withKeepaliveEnv(undefined, () => {
      expect(loadConfig().keepaliveIntervalMs).toBe(20_000);
    });
  });

  test('loadConfig honours a UNSEEN_WS_KEEPALIVE_MS override', () => {
    withKeepaliveEnv('15000', () => {
      expect(loadConfig().keepaliveIntervalMs).toBe(15_000);
    });
  });

  test('loadConfig rejects a non-positive UNSEEN_WS_KEEPALIVE_MS', () => {
    withKeepaliveEnv('0', () => {
      expect(() => loadConfig()).toThrow(/UNSEEN_WS_KEEPALIVE_MS/u);
    });
  });
});
