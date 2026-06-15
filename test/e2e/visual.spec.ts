import { type BrowserContext, expect, type Page, test } from '@playwright/test';

const closeAll = async (...contexts: readonly BrowserContext[]): Promise<void> => {
  await Promise.all(contexts.map(async (ctx) => await ctx.close()));
};

const waitForActive = async (page: Page): Promise<void> => {
  await expect(page.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE', {
    timeout: 10_000,
  });
};

test.describe('visual baselines', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'visual baselines are Chromium-only');
  test.skip(
    () => Boolean(process.env.CI),
    'visual baselines run locally; no OS-specific snapshots for CI',
  );

  test('landing', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[data-testid="create-room"]')).toBeVisible();
    await expect(page).toHaveScreenshot('landing.png', {
      animations: 'disabled',
      caret: 'hide',
      fullPage: true,
      mask: [page.locator('.version-stamp__sha')],
    });
  });

  test('chat waiting_for_peer (initiator alone)', async ({ browser }) => {
    const ctx = await browser.newContext();
    try {
      const alice = await ctx.newPage();
      await alice.goto('/');
      await alice.getByTestId('create-room').click();
      await alice.waitForURL(/\/r402#[\w-]{43}$/u);
      await expect(alice.getByTestId('system-waiting_for_peer')).toBeVisible({ timeout: 5000 });
      await expect(alice).toHaveScreenshot('chat-waiting.png', {
        animations: 'disabled',
        caret: 'hide',
        fullPage: true,
        mask: [alice.locator('.version-stamp__sha')],
      });
    } finally {
      await ctx.close();
    }
  });

  test('chat active (both peers, SAS visible)', async ({ browser }) => {
    const aliceCtx = await browser.newContext();
    const bobCtx = await browser.newContext();
    try {
      const alice = await aliceCtx.newPage();
      const bob = await bobCtx.newPage();
      await alice.goto('/');
      await alice.getByTestId('create-room').click();
      await alice.waitForURL(/\/r402#[\w-]{43}$/u);
      await bob.goto(alice.url());
      await Promise.all([waitForActive(alice), waitForActive(bob)]);
      await alice.waitForTimeout(200);
      await expect(alice).toHaveScreenshot('chat-active.png', {
        animations: 'disabled',
        caret: 'hide',
        fullPage: true,
        mask: [alice.locator('.chat__card-top'), alice.locator('.version-stamp__sha')],
      });
    } finally {
      await closeAll(aliceCtx, bobCtx);
    }
  });
});
