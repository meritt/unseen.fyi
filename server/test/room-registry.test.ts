import { describe, expect, test } from 'bun:test';

import type { ServerWebSocket } from 'bun';

import { addPeer, createRoomRegistry, getPeer, hasFreeSlot } from '../src/room/registry.ts';
import type { ConnectionData } from '../src/types.ts';

const stubWs = (): ServerWebSocket<ConnectionData> =>
  ({
    data: {
      state: 'PENDING_HELLO',
      roomId: undefined,
      role: undefined,
      mode: undefined,
      ip: '127.0.0.1',
      helloTimer: undefined,
      relayBucket: { tokens: 60, lastRefillMs: 0 },
    },
  }) as unknown as ServerWebSocket<ConnectionData>;

describe('room registry', () => {
  test('create marks initiator and WAITING state', () => {
    const registry = createRoomRegistry();
    const initiator = stubWs();
    const room = registry.create('abc', initiator);
    expect(room.initiator).toBe(initiator);
    expect(room.joiner).toBeUndefined();
    expect(room.state).toBe('WAITING');
    expect(registry.size()).toBe(1);
  });

  test('addPeer promotes the room to PAIRED and assigns joiner', () => {
    const registry = createRoomRegistry();
    const initiator = stubWs();
    const joiner = stubWs();
    const room = registry.create('abc', initiator);
    expect(addPeer(room, joiner)).toBe('joiner');
    expect(room.state).toBe('PAIRED');
    expect(room.joiner).toBe(joiner);
  });

  test('addPeer reports full when both slots are occupied', () => {
    const registry = createRoomRegistry();
    const room = registry.create('abc', stubWs());
    addPeer(room, stubWs());
    expect(addPeer(room, stubWs())).toBe('full');
  });

  test('hasFreeSlot reflects occupancy', () => {
    const registry = createRoomRegistry();
    const room = registry.create('abc', stubWs());
    expect(hasFreeSlot(room)).toBe(true);
    addPeer(room, stubWs());
    expect(hasFreeSlot(room)).toBe(false);
  });

  test('remove returns half_open while a peer remains', () => {
    const registry = createRoomRegistry();
    const a = stubWs();
    const b = stubWs();
    const room = registry.create('abc', a);
    addPeer(room, b);
    expect(registry.remove(room, a)).toBe('half_open');
    expect(room.state).toBe('HALF_OPEN');
    expect(room.initiator).toBeUndefined();
    expect(room.joiner).toBe(b);
  });

  test('remove deletes the room when the last peer leaves (Variant A)', () => {
    const registry = createRoomRegistry();
    const a = stubWs();
    const room = registry.create('abc', a);
    expect(registry.remove(room, a)).toBe('closed');
    expect(registry.get('abc')).toBeUndefined();
    expect(registry.size()).toBe(0);
  });

  test('getPeer returns the other side', () => {
    const registry = createRoomRegistry();
    const a = stubWs();
    const b = stubWs();
    const room = registry.create('abc', a);
    addPeer(room, b);
    expect(getPeer(room, a)).toBe(b);
    expect(getPeer(room, b)).toBe(a);
    expect(getPeer(room, stubWs())).toBeUndefined();
  });
});
