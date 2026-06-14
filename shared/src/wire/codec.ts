import type { Bytes } from '../crypto/encoding.ts';
import { MAX_WIRE_BYTES } from '../limits.ts';
import { PROTOCOL_VERSION } from '../protocol-version.ts';
import { byteToErrorCode, type ErrorCode, errorCodeToByte } from './error-codes.ts';
import { isRelayKind, type RelayKind } from './file-frame.ts';
import { byteToIntent, type HelloIntent, intentToByte } from './intent.ts';
import {
  MSG_ACK,
  MSG_ERROR,
  MSG_HANDSHAKE,
  MSG_HELLO,
  MSG_PEER_DISCONNECTED,
  MSG_PEER_JOINED,
  MSG_PEER_LEFT,
  MSG_RELAY,
} from './msg-types.ts';
import { byteToRole, type Role, roleToByte } from './role.ts';

const ROOM_ID_LENGTH = 16;
const NONCE_LENGTH = 12;
const HELLO_FRAME_LENGTH = 1 + ROOM_ID_LENGTH + 1 + 1;
const HANDSHAKE_PUBKEY_LENGTH = 32;
const HANDSHAKE_TAG_LENGTH = 16;
const HANDSHAKE_CIPHERTEXT_LENGTH = HANDSHAKE_PUBKEY_LENGTH + HANDSHAKE_TAG_LENGTH;
export const HANDSHAKE_FRAME_LENGTH = 1 + NONCE_LENGTH + HANDSHAKE_CIPHERTEXT_LENGTH;
const RELAY_KIND_OFFSET = 1;
const RELAY_NONCE_OFFSET = 2;
const RELAY_CT_LEN_OFFSET = RELAY_NONCE_OFFSET + NONCE_LENGTH;
const RELAY_HEADER_LENGTH = 1 + 1 + NONCE_LENGTH + 2;
const ACK_FRAME_LENGTH = 2;
const ERROR_FRAME_LENGTH = 2;
const PEER_DISCONNECTED_FRAME_LENGTH = 5;
const SINGLE_BYTE_FRAME_LENGTH = 1;
const UINT16_MAX = 0xff_ff;
const UINT32_MAX = 0xff_ff_ff_ff;

export type HandshakeFrame = {
  readonly type: 'HANDSHAKE';
  readonly nonce: Bytes;
  readonly ciphertext: Bytes;
};

export type RelayFrame = {
  readonly type: 'RELAY';
  readonly kind: RelayKind;
  readonly nonce: Bytes;
  readonly ciphertext: Bytes;
};

export type ClientFrame =
  | {
      readonly type: 'HELLO';
      readonly roomId: Bytes;
      readonly protocolVersion: number;
      readonly intent: HelloIntent;
    }
  | HandshakeFrame
  | RelayFrame;

export type ServerFrame =
  | { readonly type: 'ACK'; readonly role: Role }
  | { readonly type: 'PEER_JOINED' }
  | HandshakeFrame
  | RelayFrame
  | { readonly type: 'PEER_DISCONNECTED'; readonly graceMs: number }
  | { readonly type: 'PEER_LEFT' }
  | { readonly type: 'ERROR'; readonly code: ErrorCode };

const asBytes = (buffer: ArrayBuffer): Bytes => new Uint8Array(buffer);

export const encodeHello = ({
  roomId,
  intent,
}: {
  readonly roomId: Bytes;
  readonly intent: HelloIntent;
}): ArrayBuffer => {
  if (roomId.length !== ROOM_ID_LENGTH) {
    throw new Error('roomId must be 16 bytes');
  }
  const buf = new ArrayBuffer(HELLO_FRAME_LENGTH);
  const view = new DataView(buf);
  const bytes = asBytes(buf);
  view.setUint8(0, MSG_HELLO);
  bytes.set(roomId, 1);
  view.setUint8(1 + ROOM_ID_LENGTH, PROTOCOL_VERSION);
  view.setUint8(1 + ROOM_ID_LENGTH + 1, intentToByte(intent));
  return buf;
};

export const encodeHandshake = (nonce: Bytes, ciphertext: Bytes): ArrayBuffer => {
  if (nonce.length !== NONCE_LENGTH) {
    throw new Error('handshake nonce must be 12 bytes');
  }
  if (ciphertext.length !== HANDSHAKE_CIPHERTEXT_LENGTH) {
    throw new Error('handshake ciphertext must be 48 bytes (32 + 16 tag)');
  }
  const buf = new ArrayBuffer(HANDSHAKE_FRAME_LENGTH);
  const bytes = asBytes(buf);
  bytes[0] = MSG_HANDSHAKE;
  bytes.set(nonce, 1);
  bytes.set(ciphertext, 1 + NONCE_LENGTH);
  return buf;
};

export const encodeRelay = ({
  kind,
  nonce,
  ciphertext,
}: {
  readonly kind: RelayKind;
  readonly nonce: Bytes;
  readonly ciphertext: Bytes;
}): ArrayBuffer => {
  if (nonce.length !== NONCE_LENGTH) {
    throw new Error('relay nonce must be 12 bytes');
  }
  if (ciphertext.length > UINT16_MAX) {
    throw new Error('ciphertext length exceeds uint16 range');
  }
  const length = RELAY_HEADER_LENGTH + ciphertext.length;
  if (length > MAX_WIRE_BYTES) {
    throw new Error('relay frame exceeds maximum wire size');
  }
  const buf = new ArrayBuffer(length);
  const view = new DataView(buf);
  const bytes = asBytes(buf);
  view.setUint8(0, MSG_RELAY);
  view.setUint8(RELAY_KIND_OFFSET, kind);
  bytes.set(nonce, RELAY_NONCE_OFFSET);
  view.setUint16(RELAY_CT_LEN_OFFSET, ciphertext.length, true);
  bytes.set(ciphertext, RELAY_HEADER_LENGTH);
  return buf;
};

export const encodeAck = (role: Role): ArrayBuffer => {
  const buf = new ArrayBuffer(ACK_FRAME_LENGTH);
  const view = new DataView(buf);
  view.setUint8(0, MSG_ACK);
  view.setUint8(1, roleToByte(role));
  return buf;
};

const encodeSingleByteFrame = (type: number): ArrayBuffer => {
  const buf = new ArrayBuffer(SINGLE_BYTE_FRAME_LENGTH);
  new DataView(buf).setUint8(0, type);
  return buf;
};

export const encodePeerJoined = (): ArrayBuffer => encodeSingleByteFrame(MSG_PEER_JOINED);
export const encodePeerLeft = (): ArrayBuffer => encodeSingleByteFrame(MSG_PEER_LEFT);

export const encodePeerDisconnected = (graceMs: number): ArrayBuffer => {
  if (!Number.isInteger(graceMs) || graceMs < 0 || graceMs > UINT32_MAX) {
    throw new Error('graceMs must be a uint32');
  }
  const buf = new ArrayBuffer(PEER_DISCONNECTED_FRAME_LENGTH);
  const view = new DataView(buf);
  view.setUint8(0, MSG_PEER_DISCONNECTED);
  view.setUint32(1, graceMs, true);
  return buf;
};

export const encodeError = (code: ErrorCode): ArrayBuffer => {
  const buf = new ArrayBuffer(ERROR_FRAME_LENGTH);
  const view = new DataView(buf);
  view.setUint8(0, MSG_ERROR);
  view.setUint8(1, errorCodeToByte(code));
  return buf;
};

const decodeHello = (buf: ArrayBuffer): Extract<ClientFrame, { type: 'HELLO' }> | undefined => {
  if (buf.byteLength !== HELLO_FRAME_LENGTH) {
    return undefined;
  }
  const view = new DataView(buf);
  const bytes = asBytes(buf);
  const intent = byteToIntent(view.getUint8(1 + ROOM_ID_LENGTH + 1));
  if (intent === undefined) {
    return undefined;
  }
  return {
    type: 'HELLO',
    roomId: bytes.slice(1, 1 + ROOM_ID_LENGTH),
    protocolVersion: view.getUint8(1 + ROOM_ID_LENGTH),
    intent,
  };
};

const decodeHandshake = (buf: ArrayBuffer): HandshakeFrame | undefined => {
  if (buf.byteLength !== HANDSHAKE_FRAME_LENGTH) {
    return undefined;
  }
  const bytes = asBytes(buf);
  return {
    type: 'HANDSHAKE',
    nonce: bytes.slice(1, 1 + NONCE_LENGTH),
    ciphertext: bytes.slice(1 + NONCE_LENGTH, HANDSHAKE_FRAME_LENGTH),
  };
};

const decodeRelay = (buf: ArrayBuffer): RelayFrame | undefined => {
  if (buf.byteLength < RELAY_HEADER_LENGTH) {
    return undefined;
  }
  const view = new DataView(buf);
  const kindByte = view.getUint8(RELAY_KIND_OFFSET);
  if (!isRelayKind(kindByte)) {
    return undefined;
  }
  const kind: RelayKind = kindByte;
  const ciphertextLen = view.getUint16(RELAY_CT_LEN_OFFSET, true);
  if (buf.byteLength !== RELAY_HEADER_LENGTH + ciphertextLen) {
    return undefined;
  }
  const bytes = asBytes(buf);
  return {
    type: 'RELAY',
    kind,
    nonce: bytes.slice(RELAY_NONCE_OFFSET, RELAY_NONCE_OFFSET + NONCE_LENGTH),
    ciphertext: bytes.slice(RELAY_HEADER_LENGTH, RELAY_HEADER_LENGTH + ciphertextLen),
  };
};

const decodeAck = (buf: ArrayBuffer): Extract<ServerFrame, { type: 'ACK' }> | undefined => {
  if (buf.byteLength !== ACK_FRAME_LENGTH) {
    return undefined;
  }
  const role = byteToRole(new DataView(buf).getUint8(1));
  return role === undefined ? undefined : { type: 'ACK', role };
};

const decodePeerDisconnected = (
  buf: ArrayBuffer,
): Extract<ServerFrame, { type: 'PEER_DISCONNECTED' }> | undefined => {
  if (buf.byteLength !== PEER_DISCONNECTED_FRAME_LENGTH) {
    return undefined;
  }
  return { type: 'PEER_DISCONNECTED', graceMs: new DataView(buf).getUint32(1, true) };
};

const decodeError = (buf: ArrayBuffer): Extract<ServerFrame, { type: 'ERROR' }> | undefined => {
  if (buf.byteLength !== ERROR_FRAME_LENGTH) {
    return undefined;
  }
  const code = byteToErrorCode(new DataView(buf).getUint8(1));
  return code === undefined ? undefined : { type: 'ERROR', code };
};

const readType = (buf: ArrayBuffer): number | undefined =>
  buf.byteLength < 1 ? undefined : new DataView(buf).getUint8(0);

export const decodeClientFrame = (buf: ArrayBuffer): ClientFrame | undefined => {
  const type = readType(buf);
  if (type === MSG_HELLO) {
    return decodeHello(buf);
  }
  if (type === MSG_HANDSHAKE) {
    return decodeHandshake(buf);
  }
  if (type === MSG_RELAY) {
    return decodeRelay(buf);
  }
  return undefined;
};

export const decodeServerFrame = (buf: ArrayBuffer): ServerFrame | undefined => {
  const type = readType(buf);
  if (type === MSG_ACK) {
    return decodeAck(buf);
  }
  if (type === MSG_PEER_JOINED) {
    return buf.byteLength === SINGLE_BYTE_FRAME_LENGTH ? { type: 'PEER_JOINED' } : undefined;
  }
  if (type === MSG_PEER_LEFT) {
    return buf.byteLength === SINGLE_BYTE_FRAME_LENGTH ? { type: 'PEER_LEFT' } : undefined;
  }
  if (type === MSG_PEER_DISCONNECTED) {
    return decodePeerDisconnected(buf);
  }
  if (type === MSG_ERROR) {
    return decodeError(buf);
  }
  if (type === MSG_HANDSHAKE) {
    return decodeHandshake(buf);
  }
  if (type === MSG_RELAY) {
    return decodeRelay(buf);
  }
  return undefined;
};
