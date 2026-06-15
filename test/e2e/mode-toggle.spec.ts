import { type BrowserContext, expect, type Page, test } from '@playwright/test';

import { enableVirtualAuthenticator } from './fixtures/webauthn';

const closeAll = async (...contexts: readonly BrowserContext[]): Promise<void> => {
  await Promise.all(contexts.map(async (ctx) => await ctx.close()));
};

const waitForActive = async (page: Page): Promise<void> => {
  await expect(page.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE', {
    timeout: 10_000,
  });
};

test('happy path — both peers upgrade, rekey commits, sessionStorage written on both', async ({
  browser,
}) => {
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

    expect(await alice.evaluate(() => globalThis.sessionStorage.length)).toBe(0);
    expect(await bob.evaluate(() => globalThis.sessionStorage.length)).toBe(0);

    await alice.getByTestId('upgrade-button').click();
    await expect(alice.getByTestId('system-mode_upgraded_locally')).toBeVisible({ timeout: 5000 });

    await expect
      .poll(async () => await alice.evaluate(() => globalThis.sessionStorage.length))
      .toBe(1);

    await expect(bob.getByTestId('system-mode_upgrade_invited')).toBeVisible({ timeout: 5000 });

    await bob.getByTestId('upgrade-button').click();
    await expect(bob.getByTestId('system-mode_upgraded_locally')).toBeVisible({ timeout: 5000 });

    await expect(alice.getByTestId('system-session_hardened')).toBeVisible({ timeout: 10_000 });
    await expect(bob.getByTestId('system-session_hardened')).toBeVisible({ timeout: 10_000 });

    expect(await alice.evaluate(() => globalThis.sessionStorage.length)).toBe(1);
    expect(await bob.evaluate(() => globalThis.sessionStorage.length)).toBe(1);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('upgrade button hidden for non-capable peer (no virtualAuthenticator)', async ({
  browser,
}) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  try {
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    await enableVirtualAuthenticator(alice);

    await alice.goto('/');
    await alice.getByTestId('create-room').click();
    await alice.waitForURL(/\/r402#[\w-]{43}$/u);
    const sharedUrl = alice.url();
    await bob.goto(sharedUrl);

    await waitForActive(alice);
    await waitForActive(bob);

    await expect(alice.getByTestId('upgrade-button')).toBeVisible();
    await expect(bob.getByTestId('upgrade-button')).toHaveCount(0);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});
