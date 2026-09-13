import { expect, test } from '@playwright/test';

import { useProdDist } from './fixtures/prod-dist.ts';

test.describe.configure({ mode: 'serial' });

const prodDist = useProdDist('CSP spec runs once on Chromium');

test('CSP locks worker-src to self with no blob: / data: / wildcard escapes', async ({
  browserName,
  request,
}) => {
  test.skip(browserName !== 'chromium', 'CSP spec runs once on Chromium');
  const response = await request.get(`${prodDist().baseUrl}/`);
  expect(response.status()).toBe(200);
  const csp = response.headers()['content-security-policy'];
  expect(csp).toBeDefined();
  if (csp === undefined) {
    throw new Error('CSP header missing');
  }

  expect(csp).toContain("worker-src 'self'");
  expect(csp).not.toMatch(/worker-src[^;]*blob:/u);
  expect(csp).not.toMatch(/worker-src[^;]*data:/u);
  expect(csp).not.toMatch(/worker-src[^;]*\*/u);

  expect(csp).toContain("require-trusted-types-for 'script'");
  expect(csp).toContain('trusted-types lit-html unseen-worker-url');
});
