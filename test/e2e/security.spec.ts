import { type BrowserContext, expect, type Page, test } from '@playwright/test';

const closeAll = async (...contexts: readonly BrowserContext[]): Promise<void> => {
  await Promise.all(contexts.map(async (ctx) => await ctx.close()));
};

const waitForActive = async (page: Page): Promise<void> => {
  await expect(page.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE', {
    timeout: 10_000,
  });
};

test('csp-no-violations: no `securitypolicyviolation` events on the landing scene', async ({
  page,
}) => {
  const violations: string[] = [];
  await page.exposeFunction('__reportCspViolation', (msg: string) => {
    violations.push(msg);
  });
  await page.addInitScript(`
    document.addEventListener('securitypolicyviolation', (event) => {
      const w = globalThis;
      if (typeof w.__reportCspViolation === 'function') {
        w.__reportCspViolation(event.violatedDirective + ' ' + event.blockedURI);
      }
    });
  `);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  expect(violations).toEqual([]);
});

test('csp-no-violations: chat-view and terminated overlay stay clean', async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  try {
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    const aliceViolations: string[] = [];
    const bobViolations: string[] = [];
    await alice.exposeFunction('__reportCsp', (msg: string) => aliceViolations.push(msg));
    await bob.exposeFunction('__reportCsp', (msg: string) => bobViolations.push(msg));
    const initScript = `
      document.addEventListener('securitypolicyviolation', (event) => {
        const w = globalThis;
        if (typeof w.__reportCsp === 'function') {
          w.__reportCsp(event.violatedDirective + ' ' + event.blockedURI);
        }
      });
    `;
    await alice.addInitScript(initScript);
    await bob.addInitScript(initScript);

    await alice.goto('/');
    await alice.getByTestId('create-room').click();
    await alice.waitForURL(/\/r402#[\w-]{43}$/u);
    await bob.goto(alice.url());
    await waitForActive(alice);
    await waitForActive(bob);

    await alice.getByTestId('composer').fill('hello **world**');
    await alice.getByTestId('send').click();
    await expect(bob.getByTestId('messages').locator('.chat__msg')).toContainText('hello');

    await alice.getByTestId('burn-button').click();
    await alice.getByTestId('burn-button').click();
    await expect(bob.getByTestId('system-session_ended')).toBeVisible({ timeout: 10_000 });

    expect(aliceViolations).toEqual([]);
    expect(bobViolations).toEqual([]);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('trusted-types: unsanctioned DOM sinks and rogue policies are blocked', async ({ page }) => {
  await page.goto('/');
  const probe = await page.evaluate(() => {
    const result = { sinkBlocked: false, roguePolicyBlocked: false };
    try {
      document.createElement('div').innerHTML = '<b>x</b>';
    } catch {
      result.sinkBlocked = true;
    }
    const { trustedTypes } = globalThis as unknown as {
      readonly trustedTypes: {
        readonly createPolicy: (name: string, rules: Record<string, unknown>) => unknown;
      };
    };
    try {
      trustedTypes.createPolicy('rogue', {});
    } catch {
      result.roguePolicyBlocked = true;
    }
    return result;
  });
  expect(probe).toEqual({ sinkBlocked: true, roguePolicyBlocked: true });
});

test('no-network-fetch: only the `/ws` socket is opened, no HTTP requests to third parties', async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    const requests: string[] = [];
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
        return;
      }
      requests.push(req.url());
    });
    await page.goto('/');
    await page.getByTestId('create-room').click();
    await page.waitForURL(/\/r402#[\w-]{43}$/u);
    await page.waitForTimeout(500);
    expect(requests).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('opaque-storage-keys: sessionStorage keys contain no app-identifying substrings', async ({
  browser,
}) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  try {
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    await alice.goto('/');
    await alice.getByTestId('create-room').click();
    await alice.waitForURL(/\/r402#[\w-]{43}$/u);
    const sharedUrl = alice.url();
    await bob.goto(sharedUrl);
    await waitForActive(alice);
    await waitForActive(bob);

    const inspection = await alice.evaluate(() => ({
      keys: Object.keys(globalThis.sessionStorage),
      localKeys: Object.keys(globalThis.localStorage),
    }));
    expect(inspection.localKeys.filter((k) => k !== 'c7XmK9-bN4q')).toEqual([]);
    for (const key of inspection.keys) {
      expect(key.toLowerCase()).not.toContain('unseen');
      expect(key.toLowerCase()).not.toContain('session');
      expect(key.toLowerCase()).not.toContain('room');
      expect(key.toLowerCase()).not.toContain('key');
      expect(key).toMatch(/^[A-Za-z0-9_-]+$/u);
    }
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('no-plaintext-in-storage: sessionStorage values never carry message text', async ({
  browser,
}) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  try {
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    await alice.goto('/');
    await alice.getByTestId('create-room').click();
    await alice.waitForURL(/\/r402#[\w-]{43}$/u);
    const sharedUrl = alice.url();
    await bob.goto(sharedUrl);
    await waitForActive(alice);
    await waitForActive(bob);

    const PROBE = 'this-exact-phrase-must-never-land-in-storage';
    await alice.getByTestId('composer').fill(PROBE);
    await alice.getByTestId('send').click();
    await expect(bob.getByTestId('messages').locator('.chat__msg')).toContainText(PROBE);

    const aliceStorage = await alice.evaluate(() => JSON.stringify(globalThis.sessionStorage));
    const bobStorage = await bob.evaluate(() => JSON.stringify(globalThis.sessionStorage));
    expect(aliceStorage).not.toContain(PROBE);
    expect(bobStorage).not.toContain(PROBE);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('invalid-link: hash that does not decode to 32 bytes is silently redirected to /', async ({
  page,
}) => {
  await page.goto('/r402#deadbeef');
  await page.waitForURL('/', { timeout: 5000 });
  await expect(page.locator('landing-view')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('chat-view')).toHaveCount(0);
});
