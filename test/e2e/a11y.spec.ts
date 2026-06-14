import { type BrowserContext, expect, type Page, test } from '@playwright/test';

import { scan } from './_a11y-scan.ts';

const closeAll = async (...contexts: readonly BrowserContext[]): Promise<void> => {
  await Promise.all(contexts.map(async (ctx) => await ctx.close()));
};

const waitForActive = async (page: Page): Promise<void> => {
  await expect(page.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE', {
    timeout: 10_000,
  });
};

test('a11y: landing scene has no axe-core violations', async ({ page }) => {
  await page.goto('/');
  await scan(page);
});

test('a11y: invalid link silently redirects to landing (no separate scene)', async ({ page }) => {
  await page.goto('/r402#deadbeef');
  await page.waitForURL('/', { timeout: 5000 });
  await expect(page.locator('landing-view')).toBeVisible({ timeout: 5000 });
});

test('a11y: chat-view in ACTIVE has no axe-core violations', async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  try {
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    await alice.goto('/');
    await alice.getByTestId('create-room').click();
    await alice.waitForURL(/\/r402#[\w-]{43}$/u);
    await bob.goto(alice.url());
    await waitForActive(alice);
    await waitForActive(bob);
    await scan(alice);
    await scan(bob);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('a11y: terminated overlay has no axe-core violations', async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  try {
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    await alice.goto('/');
    await alice.getByTestId('create-room').click();
    await alice.waitForURL(/\/r402#[\w-]{43}$/u);
    await bob.goto(alice.url());
    await waitForActive(alice);
    await waitForActive(bob);
    await alice.getByTestId('burn-button').click();
    await alice.getByTestId('burn-button').click();
    await expect(bob.getByTestId('system-session_ended')).toBeVisible({ timeout: 10_000 });
    await scan(bob);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});
