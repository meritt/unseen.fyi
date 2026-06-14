import type { ServerWebSocket } from 'bun';

import type { ConnectionData } from '../types.ts';

export type RoomState = 'WAITING' | 'PAIRED' | 'HALF_OPEN';

export type Room = {
  readonly roomId: string;
  initiator: ServerWebSocket<ConnectionData> | undefined;
  joiner: ServerWebSocket<ConnectionData> | undefined;
  state: RoomState;
  readonly createdAtMs: number;
  lastActivityAtMs: number;
};

export type AddPeerResult = 'initiator' | 'joiner' | 'full';
export type RemoveResult = 'half_open' | 'closed';

export const hasFreeSlot = (room: Room): boolean =>
  room.initiator === undefined || room.joiner === undefined;

export const addPeer = (room: Room, ws: ServerWebSocket<ConnectionData>): AddPeerResult => {
  if (room.initiator === undefined) {
    room.initiator = ws;
    room.state = room.joiner === undefined ? 'WAITING' : 'PAIRED';
    room.lastActivityAtMs = performance.now();
    return 'initiator';
  }
  if (room.joiner === undefined) {
    room.joiner = ws;
    room.state = 'PAIRED';
    room.lastActivityAtMs = performance.now();
    return 'joiner';
  }
  return 'full';
};

export const getPeer = (
  room: Room,
  ws: ServerWebSocket<ConnectionData>,
): ServerWebSocket<ConnectionData> | undefined => {
  if (room.initiator === ws) {
    return room.joiner;
  }
  if (room.joiner === ws) {
    return room.initiator;
  }
  return undefined;
};

export type RoomCounts = {
  readonly waiting: number;
  readonly active: number;
  readonly halfOpen: number;
};

export type RoomRegistry = {
  get: (roomId: string) => Room | undefined;
  create: (roomId: string, initiator: ServerWebSocket<ConnectionData>) => Room;
  remove: (room: Room, ws: ServerWebSocket<ConnectionData>) => RemoveResult;
  delete: (roomId: string) => void;
  list: () => IterableIterator<Room>;
  size: () => number;
  counts: () => RoomCounts;
};

export const createRoomRegistry = (): RoomRegistry => {
  const rooms = new Map<string, Room>();

  const create = (roomId: string, initiator: ServerWebSocket<ConnectionData>): Room => {
    const now = performance.now();
    const room: Room = {
      roomId,
      initiator,
      joiner: undefined,
      state: 'WAITING',
      createdAtMs: now,
      lastActivityAtMs: now,
    };
    rooms.set(roomId, room);
    return room;
  };

  const remove = (room: Room, ws: ServerWebSocket<ConnectionData>): RemoveResult => {
    if (room.initiator === ws) {
      room.initiator = undefined;
    }
    if (room.joiner === ws) {
      room.joiner = undefined;
    }
    if (room.initiator === undefined && room.joiner === undefined) {
      rooms.delete(room.roomId);
      return 'closed';
    }
    room.state = 'HALF_OPEN';
    room.lastActivityAtMs = performance.now();
    return 'half_open';
  };

  return {
    get: (roomId): Room | undefined => rooms.get(roomId),
    create,
    remove,
    delete: (roomId): void => {
      rooms.delete(roomId);
    },
    list: (): IterableIterator<Room> => rooms.values(),
    size: (): number => rooms.size,
    counts: (): RoomCounts => {
      let waiting = 0;
      let active = 0;
      let halfOpen = 0;
      for (const room of rooms.values()) {
        if (room.state === 'WAITING') {
          waiting += 1;
        } else if (room.state === 'PAIRED') {
          active += 1;
        } else {
          halfOpen += 1;
        }
      }
      return { waiting, active, halfOpen };
    },
  };
};
