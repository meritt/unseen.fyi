import { type BrowserContext, expect, type Page, test } from '@playwright/test';

import { enableVirtualAuthenticator } from './fixtures/webauthn';

const INSTRUMENT_SCRIPT = `
  (() => {
    const stamp = () => {
      const m = document.cookie.match(/(?:^|; )__removeItemCount=(\\d+)/);
      const next = (m === null ? 0 : Number(m[1])) + 1;
      document.cookie = '__removeItemCount=' + next + '; path=/';
    };
    const orig = globalThis.sessionStorage.removeItem.bind(globalThis.sessionStorage);
    globalThis.sessionStorage.removeItem = (key) => {
      stamp();
      orig(key);
    };
  })();
`;

const closeAll = async (...contexts: readonly BrowserContext[]): Promise<void> => {
  await Promise.all(contexts.map(async (ctx) => await ctx.close()));
};

const waitForState = async (page: Page, state: string): Promise<void> => {
  await expect(page.locator('[data-testid="status"]')).toHaveAttribute('data-state', state, {
    timeout: 10_000,
  });
};

const readRemoveCount = async (page: Page): Promise<number> =>
  await page.evaluate(() => {
    const m = document.cookie.match(/(?:^|; )__removeItemCount=(?<count>\d+)/u);
    return m === null ? -1 : Number(m[1]);
  });

test.describe.configure({ mode: 'serial' });

test('chat-view + WS-close do not wipe sessionStorage during F5 unload (PRF, ACTIVE)', async ({
  browser,
}) => {
  test.skip(browser.browserType().name() !== 'chromium', 'Requires Chromium virtualAuthenticator');

  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  try {
    const alice = await aliceCtx.newPage();
    const bob = await bobCtx.newPage();
    await alice.addInitScript(INSTRUMENT_SCRIPT);
    await enableVirtualAuthenticator(alice);
    await enableVirtualAuthenticator(bob);

    await alice.goto('/');
    await alice.evaluate(() => {
      document.cookie = '__removeItemCount=0; path=/';
    });

    await alice.getByTestId('create-room').click();
    await alice.waitForURL(/\/r402#[\w-]{43}$/u);
    const sharedUrl = alice.url();
    await bob.goto(sharedUrl);

    await waitForState(alice, 'ACTIVE');
    await waitForState(bob, 'ACTIVE');

    await alice.getByTestId('upgrade-button').click();
    await expect(alice.getByTestId('system-mode_upgraded_locally')).toBeVisible({ timeout: 5000 });

    const beforeCount = await alice.evaluate(() => globalThis.sessionStorage.length);
    expect(beforeCount).toBe(1);

    await alice.evaluate(() => {
      document.cookie = '__removeItemCount=0; path=/';
    });

    await alice.reload();
    await alice.waitForSelector('chat-view');

    const removeCount = await readRemoveCount(alice);
    expect(removeCount).toBe(0);

    const afterCount = await alice.evaluate(() => globalThis.sessionStorage.length);
    expect(afterCount).toBe(1);
  } finally {
    await closeAll(aliceCtx, bobCtx);
  }
});
