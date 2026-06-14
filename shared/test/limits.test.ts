import { describe, expect, test } from 'bun:test';

import {
  BUFFER_THRESHOLD_BYTES,
  GRACE_PERIOD_MS,
  HELLO_DEADLINE_MS,
  INITIATOR_WAIT_TIMEOUT_MS,
  MAX_BODY_BYTES,
  MAX_PLAINTEXT_BYTES,
  MAX_WIRE_BYTES,
  PEER_BUFFER_CAP_BYTES,
  SWEEP_INTERVAL_MS,
  WAIT_FOR_RESUME_PROBE_MS,
} from '../src/limits.ts';

describe('protocol limits', () => {
  test('wire size accounts for type byte, nonce, ct_len, plaintext, and AEAD tag', () => {
    const TYPE_BYTE = 1;
    const NONCE = 12;
    const CT_LEN_FIELD = 2;
    const AEAD_TAG = 16;
    const SAFETY_MARGIN = 1;
    expect(MAX_WIRE_BYTES).toBe(
      TYPE_BYTE + NONCE + CT_LEN_FIELD + MAX_PLAINTEXT_BYTES + AEAD_TAG + SAFETY_MARGIN,
    );
  });

  test('plaintext budget is at least double the advisory body limit', () => {
    expect(MAX_PLAINTEXT_BYTES).toBeGreaterThanOrEqual(MAX_BODY_BYTES * 2);
  });

  test('grace and initiator-wait windows are 5 minutes', () => {
    expect(GRACE_PERIOD_MS).toBe(5 * 60 * 1000);
    expect(INITIATOR_WAIT_TIMEOUT_MS).toBe(5 * 60 * 1000);
  });

  test('resume probe deadline is shorter than the grace window', () => {
    expect(WAIT_FOR_RESUME_PROBE_MS).toBeLessThan(GRACE_PERIOD_MS);
  });

  test('cleanup sweep, hello deadline, and probe deadline are sub-minute', () => {
    const ONE_MINUTE_MS = 60_000;
    expect(SWEEP_INTERVAL_MS).toBeLessThan(ONE_MINUTE_MS);
    expect(HELLO_DEADLINE_MS).toBeLessThan(ONE_MINUTE_MS);
    expect(WAIT_FOR_RESUME_PROBE_MS).toBeLessThan(ONE_MINUTE_MS);
  });

  test('server peer-buffer cap is strictly above the client threshold', () => {
    expect(PEER_BUFFER_CAP_BYTES).toBeGreaterThan(BUFFER_THRESHOLD_BYTES);
  });
});
