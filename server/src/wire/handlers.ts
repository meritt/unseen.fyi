import { hexEncode } from '@unseen/shared/crypto/encoding.ts';
import { HELLO_DEADLINE_MS, MAX_WIRE_BYTES, PEER_BUFFER_CAP_BYTES } from '@unseen/shared/limits.ts';
import { PROTOCOL_VERSION } from '@unseen/shared/protocol-version.ts';
import {
  type ClientFrame,
  decodeClientFrame,
  encodeAck,
  encodePeerDisconnected,
  encodePeerJoined,
  HANDSHAKE_FRAME_LENGTH,
} from '@unseen/shared/wire/codec.ts';
import { MSG_HANDSHAKE, MSG_HELLO, MSG_RELAY } from '@unseen/shared/wire/msg-types.ts';
import type { ServerWebSocket } from 'bun';

import type { Config } from '../config.ts';
import type { MetricsCounters } from '../metrics/counters.ts';
import type { IpLimiter } from '../ratelimit/ip-limiter.ts';
import { consumeRelayToken, createRelayBucket } from '../ratelimit/relay-bucket.ts';
import { addPeer, getPeer, hasFreeSlot, type RoomRegistry } from '../room/registry.ts';
import { safeSend, sendErrorAndClose } from '../room/send.ts';
import type { ConnectionData } from '../types.ts';

const GRACE_MS_HINT = 5 * 60 * 1000;

const MAX_HANDSHAKE_FORWARDS = 1;

export type HandlerDeps = {
  readonly registry: RoomRegistry;
  readonly ipLimiter: IpLimiter;
  readonly config: Config;
  readonly counters: MetricsCounters;
};

export type Handlers = {
  open: (ws: ServerWebSocket<ConnectionData>) => void;
  message: (ws: ServerWebSocket<ConnectionData>, data: string | Buffer | Uint8Array) => void;
  close: (ws: ServerWebSocket<ConnectionData>) => void;
};

export const createInitialConnectionData = (ip: string, config: Config): ConnectionData => ({
  state: 'PENDING_HELLO',
  roomId: undefined,
  role: undefined,
  ip,
  helloTimer: undefined,
  relayBucket: createRelayBucket(config.relayBucket),
  handshakeForwards: 0,
});

const clearHelloTimer = (ws: ServerWebSocket<ConnectionData>): void => {
  if (ws.data.helloTimer !== undefined) {
    clearTimeout(ws.data.helloTimer);
    ws.data.helloTimer = undefined;
  }
};

const cloneToArrayBuffer = (
  source: ArrayBufferLike,
  offset: number,
  length: number,
): ArrayBuffer => {
  const fresh = new ArrayBuffer(length);
  new Uint8Array(fresh).set(new Uint8Array(source, offset, length));
  return fresh;
};

const toArrayBuffer = (data: string | Buffer | Uint8Array): ArrayBuffer | undefined => {
  if (typeof data === 'string') {
    return undefined;
  }
  if (data instanceof ArrayBuffer) {
    return data;
  }
  return cloneToArrayBuffer(data.buffer, data.byteOffset, data.byteLength);
};

const handleCreate = (
  ws: ServerWebSocket<ConnectionData>,
  frame: Extract<ClientFrame, { type: 'HELLO' }>,
  roomIdHex: string,
  deps: HandlerDeps,
): void => {
  if (!deps.ipLimiter.check(ws.data.ip, 'newRoom')) {
    deps.counters.incRateLimitReject('newRoom');
    sendErrorAndClose(ws, 'RATE_LIMITED');
    return;
  }
  if (deps.registry.get(roomIdHex) !== undefined) {
    sendErrorAndClose(ws, 'ROOM_ALREADY_EXISTS');
    return;
  }
  const room = deps.registry.create(roomIdHex, ws);
  ws.data.roomId = roomIdHex;
  ws.data.state = 'WAITING_FOR_PEER';
  ws.data.role = 'initiator';
  if (safeSend(ws, encodeAck('initiator')) === 'dropped') {
    deps.registry.delete(room.roomId);
  }
};

const handleJoinOrResume = (
  ws: ServerWebSocket<ConnectionData>,
  frame: Extract<ClientFrame, { type: 'HELLO' }>,
  roomIdHex: string,
  deps: HandlerDeps,
): void => {
  if (!deps.ipLimiter.check(ws.data.ip, 'joinRoom')) {
    deps.counters.incRateLimitReject('joinRoom');
    sendErrorAndClose(ws, 'RATE_LIMITED');
    return;
  }
  const existing = deps.registry.get(roomIdHex);
  if (existing === undefined) {
    sendErrorAndClose(ws, 'ROOM_NOT_FOUND');
    return;
  }
  if (existing.state === 'HALF_OPEN' && frame.intent !== 'resume') {
    sendErrorAndClose(ws, 'ROOM_FULL');
    return;
  }
  if (!hasFreeSlot(existing)) {
    sendErrorAndClose(ws, 'ROOM_FULL');
    return;
  }
  const remaining = existing.initiator ?? existing.joiner;
  const slot = addPeer(existing, ws);
  if (slot === 'full') {
    sendErrorAndClose(ws, 'ROOM_FULL');
    return;
  }
  ws.data.roomId = roomIdHex;
  ws.data.state = 'PAIRED';
  ws.data.role = slot;
  if (remaining !== undefined) {
    remaining.data.state = 'PAIRED';
  }
  if (safeSend(ws, encodeAck(slot)) === 'dropped') {
    deps.registry.remove(existing, ws);
    if (remaining !== undefined && remaining !== ws) {
      ws.close(1011, 'ack_dropped');
      remaining.close(1011, 'ack_dropped');
    }
    deps.registry.delete(existing.roomId);
    return;
  }
  if (
    remaining !== undefined &&
    remaining !== ws &&
    safeSend(remaining, encodePeerJoined()) === 'dropped'
  ) {
    ws.close(1011, 'peer_joined_dropped');
    remaining.close(1011, 'peer_joined_dropped');
    deps.registry.delete(existing.roomId);
  }
};

const handleHello = (
  ws: ServerWebSocket<ConnectionData>,
  frame: Extract<ClientFrame, { type: 'HELLO' }>,
  deps: HandlerDeps,
): void => {
  clearHelloTimer(ws);
  if (ws.data.state !== 'PENDING_HELLO') {
    sendErrorAndClose(ws, 'BAD_STATE');
    return;
  }
  if (frame.protocolVersion !== PROTOCOL_VERSION) {
    sendErrorAndClose(ws, 'UNSUPPORTED_VERSION');
    return;
  }
  const roomIdHex = hexEncode(frame.roomId);
  if (frame.intent === 'create') {
    handleCreate(ws, frame, roomIdHex, deps);
    return;
  }
  handleJoinOrResume(ws, frame, roomIdHex, deps);
};

const handleForward = (
  ws: ServerWebSocket<ConnectionData>,
  buf: ArrayBuffer,
  type: number,
  deps: HandlerDeps,
): void => {
  if (ws.data.state !== 'PAIRED') {
    sendErrorAndClose(ws, 'BAD_STATE');
    return;
  }
  if (buf.byteLength > MAX_WIRE_BYTES) {
    sendErrorAndClose(ws, 'MESSAGE_TOO_LARGE');
    return;
  }
  if (type === MSG_HANDSHAKE && buf.byteLength !== HANDSHAKE_FRAME_LENGTH) {
    sendErrorAndClose(ws, 'INVALID_PAYLOAD');
    return;
  }
  if (type === MSG_RELAY && !consumeRelayToken(ws.data.relayBucket, deps.config.relayBucket)) {
    sendErrorAndClose(ws, 'RATE_LIMITED');
    return;
  }
  const { roomId } = ws.data;
  const room = roomId === undefined ? undefined : deps.registry.get(roomId);
  if (room === undefined) {
    sendErrorAndClose(ws, 'ROOM_NOT_FOUND');
    return;
  }
  const peer = getPeer(room, ws);
  if (peer === undefined) {
    if (room.state === 'HALF_OPEN') {
      if (
        type === MSG_HANDSHAKE &&
        !consumeRelayToken(ws.data.relayBucket, deps.config.relayBucket)
      ) {
        sendErrorAndClose(ws, 'RATE_LIMITED');
      }
      return;
    }
    sendErrorAndClose(ws, 'INTERNAL');
    return;
  }
  if (type === MSG_HANDSHAKE) {
    if (ws.data.handshakeForwards >= MAX_HANDSHAKE_FORWARDS) {
      sendErrorAndClose(ws, 'BAD_STATE');
      return;
    }
    ws.data.handshakeForwards += 1;
  }
  if (peer.getBufferedAmount() > PEER_BUFFER_CAP_BYTES) {
    ws.close(1011, 'peer_buffer_overflow');
    peer.close(1011, 'peer_buffer_overflow');
    deps.registry.delete(room.roomId);
    return;
  }
  if (safeSend(peer, buf) === 'dropped') {
    sendErrorAndClose(ws, 'INTERNAL');
    sendErrorAndClose(peer, 'INTERNAL');
    deps.registry.delete(room.roomId);
    return;
  }
  if (type === MSG_RELAY) {
    deps.counters.incRelay();
  }
};

const handleMessage = (
  ws: ServerWebSocket<ConnectionData>,
  data: string | Buffer | Uint8Array,
  deps: HandlerDeps,
): void => {
  const buf = toArrayBuffer(data);
  if (buf === undefined || buf.byteLength < 1) {
    sendErrorAndClose(ws, 'INVALID_PAYLOAD');
    return;
  }
  const typeByte = new DataView(buf).getUint8(0);
  if (typeByte === MSG_HELLO) {
    const frame = decodeClientFrame(buf);
    if (frame?.type !== 'HELLO') {
      sendErrorAndClose(ws, 'INVALID_HELLO');
      return;
    }
    handleHello(ws, frame, deps);
    return;
  }
  if (typeByte === MSG_HANDSHAKE || typeByte === MSG_RELAY) {
    handleForward(ws, buf, typeByte, deps);
    return;
  }
  sendErrorAndClose(ws, 'INVALID_PAYLOAD');
};

const handleClose = (ws: ServerWebSocket<ConnectionData>, deps: HandlerDeps): void => {
  clearHelloTimer(ws);
  const { roomId } = ws.data;
  if (roomId === undefined) {
    return;
  }
  const room = deps.registry.get(roomId);
  if (room === undefined) {
    return;
  }
  const result = deps.registry.remove(room, ws);
  if (result === 'closed') {
    return;
  }
  const remaining = room.initiator ?? room.joiner;
  if (remaining !== undefined && remaining !== ws) {
    safeSend(remaining, encodePeerDisconnected(GRACE_MS_HINT));
  }
};

const startHelloTimer = (ws: ServerWebSocket<ConnectionData>): void => {
  ws.data.helloTimer = setTimeout(() => {
    if (ws.data.state === 'PENDING_HELLO') {
      sendErrorAndClose(ws, 'HELLO_TIMEOUT');
    }
  }, HELLO_DEADLINE_MS);
};

export const createHandlers = (deps: HandlerDeps): Handlers => ({
  open: (ws): void => {
    if (!deps.ipLimiter.check(ws.data.ip, 'connect')) {
      deps.counters.incRateLimitReject('connect');
      sendErrorAndClose(ws, 'RATE_LIMITED');
      return;
    }
    startHelloTimer(ws);
  },
  message: (ws, data): void => handleMessage(ws, data, deps),
  close: (ws): void => handleClose(ws, deps),
});
