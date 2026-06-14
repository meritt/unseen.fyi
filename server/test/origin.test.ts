import { describe, expect, test } from 'bun:test';

import { isAllowedOrigin } from '../src/wire/origin.ts';

const make = (
  origin: string | null,
  url = 'https://unseen.fyi/ws',
): {
  request: Request;
  url: URL;
} => {
  const headers = new Headers();
  if (origin !== null) {
    headers.set('origin', origin);
  }
  return { request: new Request(url, { headers }), url: new URL(url) };
};

describe('origin allow-list', () => {
  test('rejects missing Origin header', () => {
    const { request, url } = make(null);
    expect(isAllowedOrigin({ request, url, allowedOrigins: undefined })).toBe(false);
  });

  test('default same-origin allows matching Origin', () => {
    const { request, url } = make('https://unseen.fyi');
    expect(isAllowedOrigin({ request, url, allowedOrigins: undefined })).toBe(true);
  });

  test('default same-origin rejects foreign Origin', () => {
    const { request, url } = make('https://attacker.example');
    expect(isAllowedOrigin({ request, url, allowedOrigins: undefined })).toBe(false);
  });

  test('explicit allow-list permits listed origins only', () => {
    const allowed = ['https://unseen.fyi', 'https://staging.unseen.fyi'];
    const { request, url } = make('https://staging.unseen.fyi');
    expect(isAllowedOrigin({ request, url, allowedOrigins: allowed })).toBe(true);

    const intruder = make('https://attacker.example');
    expect(
      isAllowedOrigin({ request: intruder.request, url: intruder.url, allowedOrigins: allowed }),
    ).toBe(false);
  });
});
