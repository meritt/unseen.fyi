import { describe, expect, test } from 'bun:test';

import { type Bytes, hexEncode } from '../src/crypto/encoding.ts';
import { GRACE_PERIOD_MS, MAX_WIRE_BYTES } from '../src/limits.ts';
import { PROTOCOL_VERSION } from '../src/protocol-version.ts';
import {
  decodeClientFrame,
  decodeServerFrame,
  encodeAck,
  encodeError,
  encodeHandshake,
  encodeHello,
  encodePeerDisconnected,
  encodePeerJoined,
  encodePeerLeft,
  encodeRelay,
} from '../src/wire/codec.ts';
import { RELAY_KIND_MSG } from '../src/wire/file-frame.ts';

const makeRoomId = (): Bytes => {
  const id = new Uint8Array(16);
  for (let i = 0; i < id.length; i++) {
    id[i] = i + 1;
  }
  return id;
};

const makeNonce = (): Bytes => {
  const n = new Uint8Array(12);
  for (let i = 0; i < n.length; i++) {
    n[i] = i * 3 + 1;
  }
  return n;
};

describe('client frame encode/decode', () => {
  test('HELLO round-trip preserves roomId, intent, and version', () => {
    const roomId = makeRoomId();
    const buf = encodeHello({ roomId, intent: 'create' });
    expect(buf.byteLength).toBe(19);
    const decoded = decodeClientFrame(buf);
    expect(decoded?.type).toBe('HELLO');
    if (decoded?.type === 'HELLO') {
      expect(hexEncode(decoded.roomId)).toBe(hexEncode(roomId));
      expect(decoded.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(decoded.intent).toBe('create');
    }
  });

  test('HANDSHAKE round-trip preserves nonce and 48-byte ciphertext', () => {
    const nonce = makeNonce();
    const ciphertext = new Uint8Array(48);
    crypto.getRandomValues(ciphertext);
    const buf = encodeHandshake(nonce, ciphertext);
    expect(buf.byteLength).toBe(61);
    const decoded = decodeClientFrame(buf);
    expect(decoded?.type).toBe('HANDSHAKE');
    if (decoded?.type === 'HANDSHAKE') {
      expect(decoded.nonce).toEqual(nonce);
      expect(decoded.ciphertext).toEqual(ciphertext);
    }
  });

  test('RELAY round-trip preserves kind, nonce, and variable-length ciphertext', () => {
    const nonce = makeNonce();
    const ciphertext = new Uint8Array(123);
    crypto.getRandomValues(ciphertext);
    const buf = encodeRelay({ kind: RELAY_KIND_MSG, nonce, ciphertext });
    expect(buf.byteLength).toBe(16 + ciphertext.length);
    const decoded = decodeClientFrame(buf);
    expect(decoded?.type).toBe('RELAY');
    if (decoded?.type === 'RELAY') {
      expect(decoded.kind).toBe(RELAY_KIND_MSG);
      expect(decoded.nonce).toEqual(nonce);
      expect(decoded.ciphertext).toEqual(ciphertext);
    }
  });

  test('RELAY refuses ciphertext that would exceed MAX_WIRE_BYTES', () => {
    const oversize = new Uint8Array(MAX_WIRE_BYTES);
    expect(() =>
      encodeRelay({ kind: RELAY_KIND_MSG, nonce: makeNonce(), ciphertext: oversize }),
    ).toThrow();
  });

  test('decoder returns undefined on truncated input', () => {
    expect(decodeClientFrame(new ArrayBuffer(0))).toBeUndefined();
    expect(decodeClientFrame(new Uint8Array([0x01]).buffer)).toBeUndefined();
    const handshakeShort = new Uint8Array(60);
    handshakeShort[0] = 0x04;
    expect(decodeClientFrame(handshakeShort.buffer)).toBeUndefined();
  });

  test('decoder returns undefined for unknown intent byte', () => {
    const buf = new Uint8Array(19);
    buf[0] = 0x01;
    buf[17] = PROTOCOL_VERSION;
    buf[18] = 0x00;
    expect(decodeClientFrame(buf.buffer)).toBeUndefined();
  });

  test('decoder accepts RELAY kind bytes 0x10..0x13 (mode upgrade + rekey)', () => {
    const kinds = [0x10, 0x11, 0x12, 0x13] as const;
    for (const kind of kinds) {
      const nonce = makeNonce();
      const ciphertext = new Uint8Array(48);
      crypto.getRandomValues(ciphertext);
      const buf = encodeRelay({ kind, nonce, ciphertext });
      const decoded = decodeClientFrame(buf);
      expect(decoded?.type).toBe('RELAY');
      if (decoded?.type === 'RELAY') {
        expect(decoded.kind).toBe(kind);
      }
    }
  });
});

describe('server frame encode/decode', () => {
  test('ACK preserves role', () => {
    for (const role of ['initiator', 'joiner'] as const) {
      const buf = encodeAck(role);
      expect(buf.byteLength).toBe(2);
      const decoded = decodeServerFrame(buf);
      expect(decoded).toEqual({ type: 'ACK', role });
    }
  });

  test('PEER_JOINED and PEER_LEFT are single-byte frames', () => {
    expect(encodePeerJoined().byteLength).toBe(1);
    expect(encodePeerLeft().byteLength).toBe(1);
    expect(decodeServerFrame(encodePeerJoined())).toEqual({ type: 'PEER_JOINED' });
    expect(decodeServerFrame(encodePeerLeft())).toEqual({ type: 'PEER_LEFT' });
  });

  test('PEER_DISCONNECTED carries graceMs as u32 LE', () => {
    const buf = encodePeerDisconnected(GRACE_PERIOD_MS);
    expect(buf.byteLength).toBe(5);
    const decoded = decodeServerFrame(buf);
    expect(decoded).toEqual({ type: 'PEER_DISCONNECTED', graceMs: GRACE_PERIOD_MS });
  });

  test('ERROR round-trip preserves the enum variant', () => {
    const buf = encodeError('MODE_MISMATCH');
    expect(buf.byteLength).toBe(2);
    expect(decodeServerFrame(buf)).toEqual({ type: 'ERROR', code: 'MODE_MISMATCH' });
  });

  test('decoder rejects unknown error code byte', () => {
    const buf = new Uint8Array([0x08, 0x0d]).buffer;
    expect(decodeServerFrame(buf)).toBeUndefined();
  });
});
