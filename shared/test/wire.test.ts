import { describe, expect, test } from 'bun:test';

import type { Bytes } from '../src/crypto/encoding.ts';
import {
  AAD_HANDSHAKE,
  HKDF_INFO_HANDSHAKE,
  HKDF_INFO_LOCK,
  HKDF_INFO_PRF_SALT,
  HKDF_INFO_ROOM_ID,
  HKDF_INFO_SAS,
  HKDF_INFO_SAS_ANCHOR,
  HKDF_INFO_SESSION_KEY_PREFIX,
  HKDF_INFO_STORAGE,
  HKDF_INFO_WRAP_PREFIX,
} from '../src/hkdf-infos.ts';
import { PROTOCOL_VERSION } from '../src/protocol-version.ts';
import { byteToErrorCode, type ErrorCode, errorCodeToByte } from '../src/wire/error-codes.ts';
import { byteToIntent, type HelloIntent, intentToByte } from '../src/wire/intent.ts';
import type { SessionMode } from '../src/wire/mode.ts';
import {
  MSG_ACK,
  MSG_ERROR,
  MSG_HANDSHAKE,
  MSG_HELLO,
  MSG_PEER_DISCONNECTED,
  MSG_PEER_JOINED,
  MSG_PEER_LEFT,
  MSG_RELAY,
} from '../src/wire/msg-types.ts';
import { byteToRole, type Role, roleToByte } from '../src/wire/role.ts';

const utf8 = (literal: string): Bytes => new TextEncoder().encode(literal);

describe('protocol version', () => {
  test('is 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

describe('msg types', () => {
  test('are dense [0x01, 0x08] without gaps', () => {
    const codes = [
      MSG_HELLO,
      MSG_ACK,
      MSG_PEER_JOINED,
      MSG_HANDSHAKE,
      MSG_RELAY,
      MSG_PEER_DISCONNECTED,
      MSG_PEER_LEFT,
      MSG_ERROR,
    ];
    expect(codes).toEqual([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
  });
});

describe('hello intent', () => {
  const all: readonly HelloIntent[] = ['create', 'join', 'resume'];

  test('round-trip for every variant', () => {
    for (const intent of all) {
      expect(byteToIntent(intentToByte(intent))).toBe(intent);
    }
  });

  test('unknown byte returns undefined', () => {
    expect(byteToIntent(0x00)).toBeUndefined();
    expect(byteToIntent(0x04)).toBeUndefined();
    expect(byteToIntent(0xff)).toBeUndefined();
  });

  test('byte values are 1..3', () => {
    expect(intentToByte('create')).toBe(0x01);
    expect(intentToByte('join')).toBe(0x02);
    expect(intentToByte('resume')).toBe(0x03);
  });
});

describe('session mode (client-side enum only, no wire byte)', () => {
  test('SessionMode union covers PRF and RAM', () => {
    const all: readonly SessionMode[] = ['PRF', 'RAM'];
    expect(all).toHaveLength(2);
  });
});

describe('role', () => {
  const all: readonly Role[] = ['initiator', 'joiner'];

  test('round-trip for every variant', () => {
    for (const role of all) {
      expect(byteToRole(roleToByte(role))).toBe(role);
    }
  });

  test('unknown byte returns undefined', () => {
    expect(byteToRole(0x00)).toBeUndefined();
    expect(byteToRole(0x03)).toBeUndefined();
  });
});

describe('error codes', () => {
  const all: readonly ErrorCode[] = [
    'INVALID_HELLO',
    'UNSUPPORTED_VERSION',
    'ROOM_FULL',
    'ROOM_NOT_FOUND',
    'ROOM_ALREADY_EXISTS',
    'OVER_CAPACITY',
    'RATE_LIMITED',
    'MESSAGE_TOO_LARGE',
    'INVALID_PAYLOAD',
    'BAD_STATE',
    'HELLO_TIMEOUT',
    'MODE_MISMATCH',
    'INTERNAL',
  ];

  test('round-trip for every variant', () => {
    for (const code of all) {
      expect(byteToErrorCode(errorCodeToByte(code))).toBe(code);
    }
  });

  test('byte mapping is unique', () => {
    const bytes = new Set(all.map((code) => errorCodeToByte(code)));
    expect(bytes.size).toBe(all.length);
  });

  test('INTERNAL is reserved at 0xff', () => {
    expect(errorCodeToByte('INTERNAL')).toBe(0xff);
  });

  test('unknown bytes return undefined', () => {
    expect(byteToErrorCode(0x00)).toBeUndefined();
    expect(byteToErrorCode(0x0d)).toBeUndefined();
    expect(byteToErrorCode(0xfe)).toBeUndefined();
  });
});

describe('hkdf info strings', () => {
  test('all carry the v1 prefix and exact UTF-8 bytes', () => {
    expect(HKDF_INFO_ROOM_ID).toEqual(utf8('unseen:v1:roomId'));
    expect(HKDF_INFO_HANDSHAKE).toEqual(utf8('unseen:v1:handshake'));
    expect(HKDF_INFO_SAS_ANCHOR).toEqual(utf8('unseen:v1:sas-anchor'));
    expect(HKDF_INFO_STORAGE).toEqual(utf8('unseen:v1:storage'));
    expect(HKDF_INFO_LOCK).toEqual(utf8('unseen:v1:lock'));
    expect(HKDF_INFO_PRF_SALT).toEqual(utf8('unseen:v1:prf-salt'));
    expect(HKDF_INFO_WRAP_PREFIX).toEqual(utf8('unseen:v1:wrap'));
    expect(HKDF_INFO_SESSION_KEY_PREFIX).toEqual(utf8('unseen:v1:session-key'));
    expect(HKDF_INFO_SAS).toEqual(utf8('unseen:v1:sas'));
  });

  test('AEAD additionalData markers are UTF-8 bytes', () => {
    expect(AAD_HANDSHAKE).toEqual(utf8('unseen:v1:handshake'));
  });

  test('wrap prefix is 14 bytes (the count the protocol relies on)', () => {
    expect(HKDF_INFO_WRAP_PREFIX.byteLength).toBe(14);
  });

  test('session-key prefix is 21 bytes (precedes 64-byte transcript)', () => {
    expect(HKDF_INFO_SESSION_KEY_PREFIX.byteLength).toBe(21);
  });
});
