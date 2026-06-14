import { describe, expect, test } from 'bun:test';

import { base64urlEncode } from '@unseen/shared/crypto/encoding.ts';

import { parseLocation } from '../src/routing/router.ts';

const fakeLocation = (pathname: string, hash = ''): Location =>
  ({ pathname, hash }) as unknown as Location;

describe('parseLocation', () => {
  test('landing when pathname is root', () => {
    expect(parseLocation(fakeLocation('/'))).toEqual({ kind: 'landing' });
  });

  test('chat with secret when /r402 and hash is a 43-char base64url', () => {
    const secret = new Uint8Array(32);
    crypto.getRandomValues(secret);
    const url = fakeLocation('/r402', `#${base64urlEncode(secret)}`);
    const route = parseLocation(url);
    if (route.kind !== 'chat') {
      throw new Error(`expected chat, got ${route.kind}`);
    }
    expect(route.secret).toEqual(secret);
  });

  test('invalid for any other pathname', () => {
    expect(parseLocation(fakeLocation('/foo'))).toEqual({ kind: 'invalid' });
    expect(parseLocation(fakeLocation('/r402/x'))).toEqual({ kind: 'invalid' });
  });

  test('invalid when hash length is wrong', () => {
    expect(parseLocation(fakeLocation('/r402'))).toEqual({ kind: 'invalid' });
    expect(parseLocation(fakeLocation('/r402', '#short'))).toEqual({ kind: 'invalid' });
  });

  test('invalid when base64url is malformed', () => {
    expect(parseLocation(fakeLocation('/r402', `#${'!'.repeat(43)}`))).toEqual({ kind: 'invalid' });
  });
});
