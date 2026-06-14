import { describe, expect, test } from 'bun:test';

import type { Bytes } from '../src/crypto/encoding.ts';
import { aadFor, RELAY_KIND_CHUNK, RELAY_KIND_MSG } from '../src/wire/file-frame.ts';

const utf8 = (literal: string): Bytes => new TextEncoder().encode(literal);
const PREFIX = utf8('unseen:v1:');

describe('aadFor', () => {
  test('msg kind produces 11 bytes with utf8("unseen:v1:") prefix and 0x00 trailer', () => {
    const aad = aadFor(RELAY_KIND_MSG);
    expect(aad.byteLength).toBe(11);
    expect(aad.subarray(0, 10)).toEqual(PREFIX);
    expect(aad[10]).toBe(0x00);
  });

  test('chunk kind produces 11 bytes with utf8("unseen:v1:") prefix and 0x01 trailer', () => {
    const aad = aadFor(RELAY_KIND_CHUNK);
    expect(aad.byteLength).toBe(11);
    expect(aad.subarray(0, 10)).toEqual(PREFIX);
    expect(aad[10]).toBe(0x01);
  });

  test('msg and chunk AADs are byte-distinct', () => {
    expect(aadFor(RELAY_KIND_MSG)).not.toEqual(aadFor(RELAY_KIND_CHUNK));
  });

  test('consecutive calls return fresh allocations isolated from each other', () => {
    const first = aadFor(RELAY_KIND_MSG);
    const second = aadFor(RELAY_KIND_MSG);
    expect(first.buffer).not.toBe(second.buffer);
    first[0] = 0xff;
    expect(second[0]).toBe(0x75);
  });

  test('returned view spans its buffer exactly (byteOffset 0, byteLength 11)', () => {
    const aad = aadFor(RELAY_KIND_MSG);
    expect(aad.byteOffset).toBe(0);
    expect(aad.byteLength).toBe(11);
  });
});
