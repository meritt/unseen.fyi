import { describe, expect, test } from 'bun:test';

import { releaseStamp } from '../src/version.ts';

describe('releaseStamp — present release', () => {
  test('40-hex SHA yields 7-char short and full commit URL', () => {
    const sha = '033406ec0ffee1234567890abcdef0123456789a';
    expect(releaseStamp(sha)).toEqual({
      shortSha: '033406e',
      commitUrl: `https://github.com/meritt/unseen.fyi/commit/${sha}`,
    });
  });

  test('already-short 7-hex SHA is accepted verbatim', () => {
    expect(releaseStamp('033406e')).toEqual({
      shortSha: '033406e',
      commitUrl: 'https://github.com/meritt/unseen.fyi/commit/033406e',
    });
  });
});

describe('releaseStamp — absent or malformed', () => {
  test('empty string renders nothing', () => {
    expect(releaseStamp('')).toBeNull();
  });

  test('uppercase hex is rejected', () => {
    expect(releaseStamp('ABCDEF0')).toBeNull();
  });

  test('non-hex characters are rejected', () => {
    expect(releaseStamp('local-dev')).toBeNull();
  });

  test('shorter than 7 chars is rejected', () => {
    expect(releaseStamp('033406')).toBeNull();
  });

  test('longer than 40 chars is rejected', () => {
    expect(releaseStamp('0'.repeat(41))).toBeNull();
  });
});
