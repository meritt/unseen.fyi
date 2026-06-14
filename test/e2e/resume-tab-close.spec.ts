import { type BrowserContext, expect, type Page, test } from '@playwright/test';

test.skip(
  ({ browserName }) => browserName !== 'chromium',
  'virtualAuthenticator (PRF) is Chromium-only',
);

const enableVirtualAuthenticator = async (page: Page): Promise<void> => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  });
};

const waitForActive = async (page: Page): Promise<void> => {
  await expect(page.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE', {
    timeout: 15_000,
  });
};

const closeAll = async (...contexts: readonly BrowserContext[]): Promise<void> => {
  await Promise.all(contexts.map(async (ctx) => await ctx.close()));
};

test('resume-tab-close: peer that closes its tab triggers grace expiry → other peer TERMINATED', async ({
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

    await alice.close();
    await expect(bob.locator('[data-testid="status"]')).toHaveAttribute(
      'data-state',
      'PEER_RECONNECTING',
      { timeout: 5000 },
    );

    await bob.waitForTimeout(7000);
    await expect(bob.locator('[data-testid="status"]')).toHaveAttribute(
      'data-state',
      'TERMINATED',
      { timeout: 10_000 },
    );
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});
