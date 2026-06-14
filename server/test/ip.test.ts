import { describe, expect, test } from 'bun:test';

import { extractIp } from '../src/wire/ip.ts';

const provider = (address: string | null): { requestIP: () => { address: string } | null } => ({
  requestIP: () => (address === null ? null : { address }),
});

describe('extractIp', () => {
  test('uses the last token of the trusted proxy header when it is a valid IP', () => {
    const req = new Request('http://x/ws', {
      headers: { 'x-forwarded-for': '9.9.9.9, 1.2.3.4' },
    });
    expect(extractIp(req, provider('10.0.0.1'), 'x-forwarded-for')).toBe('1.2.3.4');
  });

  test('normalizes an IPv4-mapped IPv6 token from the header', () => {
    const req = new Request('http://x/ws', {
      headers: { 'x-forwarded-for': '::ffff:1.2.3.4' },
    });
    expect(extractIp(req, provider('10.0.0.1'), 'x-forwarded-for')).toBe('1.2.3.4');
  });

  test('ignores a malformed proxy token and falls back to the socket peer', () => {
    const req = new Request('http://x/ws', {
      headers: { 'x-forwarded-for': '<script>' },
    });
    expect(extractIp(req, provider('10.0.0.1'), 'x-forwarded-for')).toBe('10.0.0.1');
  });

  test('falls back to the socket peer when no proxy header is configured', () => {
    const req = new Request('http://x/ws');
    expect(extractIp(req, provider('10.0.0.1'), undefined)).toBe('10.0.0.1');
  });

  test('a malformed header with an unavailable peer collapses to "unknown"', () => {
    const req = new Request('http://x/ws', {
      headers: { 'x-forwarded-for': 'garbage' },
    });
    expect(extractIp(req, provider(null), 'x-forwarded-for')).toBe('unknown');
  });
});
