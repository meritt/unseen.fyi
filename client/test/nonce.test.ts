import { describe, expect, test } from 'bun:test';

import { hexEncode } from '@unseen/shared/crypto/encoding.ts';

import {
  directionForRole,
  expectedPeerDirection,
  makeNonce,
  parseNonce,
} from '../src/domain/nonce.ts';

describe('nonce layout', () => {
  test('direction byte is role-dependent', () => {
    expect(directionForRole('initiator')).toBe(0x01);
    expect(directionForRole('joiner')).toBe(0x02);
    expect(expectedPeerDirection('initiator')).toBe(0x02);
    expect(expectedPeerDirection('joiner')).toBe(0x01);
  });

  test('makeNonce builds [direction][LE64 counter][000] byte layout', () => {
    const nonce = makeNonce(0x01, 1n);
    expect(hexEncode(nonce)).toBe('010100000000000000000000');
  });

  test('parseNonce round-trips counter and direction', () => {
    const nonce = makeNonce(0x02, 42n);
    const fields = parseNonce(nonce);
    expect(fields.direction).toBe(0x02);
    expect(fields.counter).toBe(42n);
    expect(fields.reservedAllZero).toBe(true);
  });

  test('parseNonce detects non-zero reserved bytes', () => {
    const nonce = makeNonce(0x01, 1n);
    nonce[11] = 0xff;
    expect(parseNonce(nonce).reservedAllZero).toBe(false);
  });

  test('makeNonce refuses counter 0 or above 2^64-1', () => {
    expect(() => makeNonce(0x01, 0n)).toThrow();
    expect(() => makeNonce(0x01, 2n ** 64n)).toThrow();
  });
});
