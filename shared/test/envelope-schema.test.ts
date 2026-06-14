import { describe, expect, test } from 'bun:test';

import { type Bytes, hexEncode } from '../src/crypto/encoding.ts';
import { V5_AES_GCM } from '../src/protocol/test-vectors.ts';
import { decodeEnvelope, encodeEnvelope, type PlaintextEnvelope } from '../src/wire/envelope.ts';

const utf8 = (s: string): Bytes => new TextEncoder().encode(s);
const jsonBytes = (value: unknown): Bytes => utf8(JSON.stringify(value));

const TID = 'abcdef0123456789';
const TID_ZERO = '0000000000000000';
const ID = '0123456789abcdef';
const SHA256 = 'a'.repeat(64);

const validByKind: Record<PlaintextEnvelope['kind'], PlaintextEnvelope> = {
  msg: { kind: 'msg', body: 'hello', t: '2026-05-15T00:00:00.000Z' },
  resume: { kind: 'resume', _id: ID },
  resume_ack: { kind: 'resume_ack', _id: ID },
  file_offer: { kind: 'file_offer', tid: TID, name: 'doc.pdf', size: 1024 },
  file_accept: { kind: 'file_accept', tid: TID },
  file_decline: { kind: 'file_decline', tid: TID, reason: 'too_large' },
  file_progress: { kind: 'file_progress', tid: TID, received_bytes: 0 },
  file_complete: { kind: 'file_complete', tid: TID, sender_sha256: SHA256 },
  file_complete_ack: { kind: 'file_complete_ack', tid: TID },
  file_cancel: { kind: 'file_cancel', tid: TID, side: 'sender', reason: 'user_aborted' },
};

const expectInvalid = (bytes: Bytes): void => {
  expect(() => decodeEnvelope(bytes)).toThrow();
};

const expectInvalidJson = (value: unknown): void => expectInvalid(jsonBytes(value));

describe('PlaintextEnvelope — round-trip per kind', () => {
  for (const [kind, envelope] of Object.entries(validByKind)) {
    test(`round-trips ${kind}`, () => {
      const encoded = encodeEnvelope(envelope);
      expect(decodeEnvelope(encoded)).toEqual(envelope);
    });
  }
});

describe('PlaintextEnvelope — canonical serialization pinned to V5', () => {
  test('encodeEnvelope produces the frozen v5 plaintext bytes (kind,body,t order)', () => {
    const envelope: PlaintextEnvelope = { kind: 'msg', body: 'hi', t: '2026-05-12T00:00:00.000Z' };
    expect(hexEncode(encodeEnvelope(envelope))).toBe(V5_AES_GCM.plaintextHex);
    expect(new TextDecoder().decode(encodeEnvelope(envelope))).toBe(V5_AES_GCM.plaintextUtf8);
  });
});

describe('PlaintextEnvelope — missing required field', () => {
  test('msg without body', () => {
    expectInvalidJson({ kind: 'msg', t: '2026-05-15T00:00:00.000Z' });
  });
  test('resume without _id', () => {
    expectInvalidJson({ kind: 'resume' });
  });
  test('file_offer without size', () => {
    expectInvalidJson({ kind: 'file_offer', tid: TID, name: 'doc.pdf' });
  });
  test('file_progress without received_bytes', () => {
    expectInvalidJson({ kind: 'file_progress', tid: TID });
  });
  test('file_cancel without side', () => {
    expectInvalidJson({ kind: 'file_cancel', tid: TID, reason: 'user_aborted' });
  });
});

describe('PlaintextEnvelope — extra field', () => {
  for (const [kind, envelope] of Object.entries(validByKind)) {
    test(`${kind} rejects unknown extra field`, () => {
      const tainted = { ...(envelope as Record<string, unknown>), extra: 'x' };
      expectInvalidJson(tainted);
    });
  }
});

describe('PlaintextEnvelope — kind validation', () => {
  test('unknown kind string rejected', () => {
    expectInvalidJson({ kind: 'bogus' });
  });
  test('missing kind rejected', () => {
    expectInvalidJson({ body: 'hi', t: '2026-05-15T00:00:00.000Z' });
  });
  test('non-string kind rejected', () => {
    expectInvalidJson({ kind: 42, body: 'hi', t: '2026-05-15T00:00:00.000Z' });
  });
});

describe('PlaintextEnvelope — non-object payloads', () => {
  test('number rejected', () => {
    expectInvalidJson(42);
  });
  test('null rejected', () => {
    expectInvalidJson(null);
  });
  test('array rejected', () => {
    expectInvalidJson([]);
  });
  test('string rejected', () => {
    expectInvalidJson('hello');
  });
  test('boolean rejected', () => {
    expectInvalidJson(true);
  });
});

describe('PlaintextEnvelope — invalid JSON / UTF-8', () => {
  test('non-JSON bytes throw', () => {
    expectInvalid(utf8('not valid json {'));
  });
  test('invalid UTF-8 throws', () => {
    const bad = new Uint8Array([0x80, 0x80, 0x80]);
    expectInvalid(bad);
  });
});

describe('PlaintextEnvelope — tid regex', () => {
  test('valid 16 lowercase hex accepted', () => {
    const encoded = encodeEnvelope({ kind: 'file_accept', tid: TID });
    expect(decodeEnvelope(encoded).kind).toBe('file_accept');
  });
  test('16 uppercase hex rejected', () => {
    expectInvalidJson({ kind: 'file_accept', tid: TID.toUpperCase() });
  });
  test('15 chars rejected', () => {
    expectInvalidJson({ kind: 'file_accept', tid: TID.slice(0, 15) });
  });
  test('17 chars rejected', () => {
    expectInvalidJson({ kind: 'file_accept', tid: `${TID}0` });
  });
  test('all-zero tid rejected', () => {
    expectInvalidJson({ kind: 'file_accept', tid: TID_ZERO });
  });
});

describe('PlaintextEnvelope — _id regex', () => {
  test('valid 16 lowercase hex accepted', () => {
    const encoded = encodeEnvelope({ kind: 'resume', _id: ID });
    expect(decodeEnvelope(encoded)).toEqual({ kind: 'resume', _id: ID });
  });
  test('all-zero _id is allowed (only tid excludes all-zero)', () => {
    const encoded = encodeEnvelope({ kind: 'resume', _id: TID_ZERO });
    expect(decodeEnvelope(encoded)).toEqual({ kind: 'resume', _id: TID_ZERO });
  });
  test('uppercase _id rejected', () => {
    expectInvalidJson({ kind: 'resume', _id: ID.toUpperCase() });
  });
  test('short _id rejected', () => {
    expectInvalidJson({ kind: 'resume', _id: '0123' });
  });
});

describe('PlaintextEnvelope — sender_sha256', () => {
  test('64 lowercase hex accepted', () => {
    const encoded = encodeEnvelope({ kind: 'file_complete', tid: TID, sender_sha256: SHA256 });
    expect(decodeEnvelope(encoded)).toEqual({
      kind: 'file_complete',
      tid: TID,
      sender_sha256: SHA256,
    });
  });
  test('uppercase rejected', () => {
    expectInvalidJson({ kind: 'file_complete', tid: TID, sender_sha256: SHA256.toUpperCase() });
  });
  test('length 63 rejected', () => {
    expectInvalidJson({ kind: 'file_complete', tid: TID, sender_sha256: 'a'.repeat(63) });
  });
  test('length 65 rejected', () => {
    expectInvalidJson({ kind: 'file_complete', tid: TID, sender_sha256: 'a'.repeat(65) });
  });
});

describe('PlaintextEnvelope — size bounds', () => {
  const offer = (size: unknown): unknown => ({ kind: 'file_offer', tid: TID, name: 'f', size });

  test('1 accepted', () => {
    expect(decodeEnvelope(jsonBytes(offer(1)))).toEqual({
      kind: 'file_offer',
      tid: TID,
      name: 'f',
      size: 1,
    });
  });
  test('0 rejected', () => {
    expectInvalidJson(offer(0));
  });
  test('-1 rejected', () => {
    expectInvalidJson(offer(-1));
  });
  test('MAX_SAFE_INTEGER accepted', () => {
    expect(decodeEnvelope(jsonBytes(offer(Number.MAX_SAFE_INTEGER)))).toEqual({
      kind: 'file_offer',
      tid: TID,
      name: 'f',
      size: Number.MAX_SAFE_INTEGER,
    });
  });
  test('MAX_SAFE_INTEGER + 1 rejected', () => {
    expectInvalidJson(offer(Number.MAX_SAFE_INTEGER + 1));
  });
  test('1.5 rejected', () => {
    expectInvalidJson(offer(1.5));
  });
  test('Infinity rejected (JSON encodes Infinity as null)', () => {
    expectInvalidJson(offer(Number.POSITIVE_INFINITY));
  });
  test('-Infinity rejected', () => {
    expectInvalidJson(offer(Number.NEGATIVE_INFINITY));
  });
  test('NaN rejected', () => {
    expectInvalidJson(offer(Number.NaN));
  });
});

describe('PlaintextEnvelope — received_bytes', () => {
  const progress = (received: unknown): unknown => ({
    kind: 'file_progress',
    tid: TID,
    received_bytes: received,
  });

  test('0 accepted', () => {
    expect(decodeEnvelope(jsonBytes(progress(0)))).toEqual({
      kind: 'file_progress',
      tid: TID,
      received_bytes: 0,
    });
  });
  test('-1 rejected', () => {
    expectInvalidJson(progress(-1));
  });
  test('1.5 rejected', () => {
    expectInvalidJson(progress(1.5));
  });
});

describe('PlaintextEnvelope — body byte cap', () => {
  test('4096 ASCII accepted', () => {
    const body = 'a'.repeat(4096);
    const encoded = encodeEnvelope({ kind: 'msg', body, t: 'now' });
    expect(decodeEnvelope(encoded).kind).toBe('msg');
  });
  test('4097 ASCII rejected', () => {
    expectInvalidJson({ kind: 'msg', body: 'a'.repeat(4097), t: 'now' });
  });
  test('empty body accepted', () => {
    const encoded = encodeEnvelope({ kind: 'msg', body: '', t: 'now' });
    expect(decodeEnvelope(encoded)).toEqual({ kind: 'msg', body: '', t: 'now' });
  });
  test('encodeEnvelope rejects 4097-byte body locally', () => {
    expect(() => encodeEnvelope({ kind: 'msg', body: 'a'.repeat(4097), t: 'now' })).toThrow(
      'body exceeds MAX_BODY_BYTES',
    );
  });
  test('encodeEnvelope rejects multi-byte body crossing the byte cap', () => {
    // 1025 four-byte emoji = 4100 UTF-8 bytes from only 2050 UTF-16 code units
    const body = '\u{1F600}'.repeat(1025);
    expect(() => encodeEnvelope({ kind: 'msg', body, t: 'now' })).toThrow(
      'body exceeds MAX_BODY_BYTES',
    );
  });
});

describe('PlaintextEnvelope — name byte cap', () => {
  test('1024 ASCII accepted', () => {
    const name = 'a'.repeat(1024);
    const encoded = encodeEnvelope({ kind: 'file_offer', tid: TID, name, size: 1 });
    expect(decodeEnvelope(encoded).kind).toBe('file_offer');
  });
  test('1025 ASCII rejected', () => {
    expectInvalidJson({ kind: 'file_offer', tid: TID, name: 'a'.repeat(1025), size: 1 });
  });
  test('UTF-8 emoji crossing byte cap is rejected', () => {
    const name = '\u{1F600}'.repeat(257);
    expectInvalidJson({ kind: 'file_offer', tid: TID, name, size: 1 });
  });
});

describe('encodeEnvelope — plaintext overflow', () => {
  test('msg whose encoded length exceeds MAX_PLAINTEXT_BYTES throws', () => {
    const t = 'x'.repeat(9000);
    expect(() => encodeEnvelope({ kind: 'msg', body: 'a', t })).toThrow(
      'plaintext exceeds MAX_PLAINTEXT_BYTES',
    );
  });

  test('decodeEnvelope rejects payload > MAX_PLAINTEXT_BYTES outright', () => {
    const oversize = new Uint8Array(9000);
    oversize.fill(0x20);
    expect(() => decodeEnvelope(oversize)).toThrow();
  });
});

describe('PlaintextEnvelope — enum-strict reason / side', () => {
  test('file_decline accepts each valid reason', () => {
    for (const reason of ['too_large', 'user_rejected', 'unsupported'] as const) {
      const encoded = encodeEnvelope({ kind: 'file_decline', tid: TID, reason });
      expect(decodeEnvelope(encoded)).toEqual({ kind: 'file_decline', tid: TID, reason });
    }
  });
  test('file_decline rejects unknown reason', () => {
    expectInvalidJson({ kind: 'file_decline', tid: TID, reason: 'bogus' });
  });
  test('file_cancel accepts each valid reason', () => {
    for (const reason of ['user_aborted', 'integrity_failure'] as const) {
      const encoded = encodeEnvelope({
        kind: 'file_cancel',
        tid: TID,
        side: 'sender',
        reason,
      });
      expect(decodeEnvelope(encoded)).toEqual({
        kind: 'file_cancel',
        tid: TID,
        side: 'sender',
        reason,
      });
    }
  });
  test('file_cancel rejects unknown reason', () => {
    expectInvalidJson({ kind: 'file_cancel', tid: TID, side: 'sender', reason: 'bogus' });
  });
  test('file_cancel accepts each valid side', () => {
    for (const side of ['sender', 'receiver'] as const) {
      const encoded = encodeEnvelope({
        kind: 'file_cancel',
        tid: TID,
        side,
        reason: 'user_aborted',
      });
      expect(decodeEnvelope(encoded)).toEqual({
        kind: 'file_cancel',
        tid: TID,
        side,
        reason: 'user_aborted',
      });
    }
  });
  test('file_cancel rejects unknown side', () => {
    expectInvalidJson({
      kind: 'file_cancel',
      tid: TID,
      side: 'bogus',
      reason: 'user_aborted',
    });
  });
});
