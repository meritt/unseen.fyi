import { type BrowserContext, expect, type Page, test } from '@playwright/test';

import { enableVirtualAuthenticator } from './fixtures/webauthn';

test.skip(({ browserName }) => browserName !== 'chromium', 'PRF + CDP Network are Chromium-only');

const waitForActive = async (page: Page): Promise<void> => {
  await expect(page.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE', {
    timeout: 15_000,
  });
};

const closeAll = async (...contexts: readonly BrowserContext[]): Promise<void> => {
  await Promise.all(contexts.map(async (ctx) => await ctx.close()));
};

test('resume-network-blip: WS dies mid-session and the backoff engine reconnects via resume', async ({
  browser,
}) => {
  test.setTimeout(40_000);
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  try {
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    await enableVirtualAuthenticator(alice);
    await enableVirtualAuthenticator(bob);

    await alice.goto('/');
    await alice.getByTestId('create-room').click();
    await alice.waitForURL(/\/r402#[\w-]{43}$/u);
    const sharedUrl = alice.url();
    await bob.goto(sharedUrl);

    await waitForActive(alice);
    await waitForActive(bob);

    await alice.getByTestId('upgrade-button').click();
    await expect(alice.getByTestId('system-mode_upgraded_locally')).toBeVisible({ timeout: 5000 });
    await expect(bob.getByTestId('system-mode_upgrade_invited')).toBeVisible({ timeout: 5000 });

    await alice.evaluate(() => {
      (
        globalThis as { __unseenTest?: { forceCloseWs?: () => void } }
      ).__unseenTest?.forceCloseWs?.();
    });
    await expect(alice.locator('[data-testid="status"]')).toHaveAttribute(
      'data-state',
      'RECONNECTING',
      { timeout: 5000 },
    );

    await waitForActive(alice);
    await expect(bob.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE', {
      timeout: 15_000,
    });
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});
