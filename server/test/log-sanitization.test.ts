import { describe, expect, test } from 'bun:test';

import { sanitizeLine } from '../src/log/log.ts';

describe('logger sanitization', () => {
  test('drops keys outside the allowlist', () => {
    const line = sanitizeLine('info', 'startup', { port: 3001, ip: '1.2.3.4', roomId: 'abc' });
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed['port']).toBe(3001);
    expect(parsed['ip']).toBeUndefined();
    expect(parsed['roomId']).toBeUndefined();
  });

  test('rejects free-form values for enum-typed keys', () => {
    const ok = sanitizeLine('error', 'fail', { errorClass: 'INTERNAL_ERROR' });
    const tampered = sanitizeLine('error', 'fail', { errorClass: 'oops\n{"injected":true}' });
    expect(JSON.parse(ok)['errorClass']).toBe('INTERNAL_ERROR');
    expect(JSON.parse(tampered)['errorClass']).toBeUndefined();
  });

  test('msg falling outside the regex is replaced by a static marker', () => {
    const line = sanitizeLine('info', 'message with newline\n{"leak":true}', {});
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed['msg']).toBe('log_msg_rejected');
  });

  test('user-controlled payload-shaped values never leak', () => {
    const probe = {
      payload: 'ciphertext-blob-AAAA',
      headers: { authorization: 'Basic AAAA' },
      url: '/r402#secret',
    };
    const line = sanitizeLine('info', 'request', probe);
    expect(line).not.toContain('ciphertext-blob');
    expect(line).not.toContain('Basic AAAA');
    expect(line).not.toContain('r402');
  });

  test('aggregate metrics keys pass through as numbers', () => {
    const line = sanitizeLine('info', 'aggregate_metrics', {
      activeRooms: 3,
      waitingRooms: 1,
      totalConnections: 42,
    });
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed['activeRooms']).toBe(3);
    expect(parsed['waitingRooms']).toBe(1);
    expect(parsed['totalConnections']).toBe(42);
  });
});
