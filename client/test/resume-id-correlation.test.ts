import { describe, expect, test } from 'bun:test';

import { generateResumeId } from '../src/domain/session.ts';

const ID_RE = /^[0-9a-f]{16}$/u;

describe('generateResumeId', () => {
  test('produces a 16-character lowercase hex string', () => {
    const id = generateResumeId();
    expect(id).toHaveLength(16);
    expect(ID_RE.test(id)).toBe(true);
  });

  test('matches the envelope schema id regex', () => {
    for (let i = 0; i < 32; i++) {
      expect(ID_RE.test(generateResumeId())).toBe(true);
    }
  });

  test('produces distinct values across 100 calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      seen.add(generateResumeId());
    }
    expect(seen.size).toBe(100);
  });

  test('output is lowercase only', () => {
    const id = generateResumeId();
    expect(id).toBe(id.toLowerCase());
  });
});
