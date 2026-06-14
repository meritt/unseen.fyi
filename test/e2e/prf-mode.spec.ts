import { type BrowserContext, expect, type Page, test } from '@playwright/test';

type AuthenticatorOptions = {
  readonly hasUserVerification?: boolean;
  readonly isUserVerified?: boolean;
};

const enableVirtualAuthenticator = async (
  page: Page,
  options: AuthenticatorOptions = {},
): Promise<void> => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: options.hasUserVerification ?? true,
      isUserVerified: options.isUserVerified ?? true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  });
};

const closeAll = async (...contexts: readonly BrowserContext[]): Promise<void> => {
  await Promise.all(contexts.map(async (ctx) => await ctx.close()));
};

const waitForActive = async (page: Page): Promise<void> => {
  await expect(page.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE', {
    timeout: 10_000,
  });
};

test('boot always starts RAM (no passkey dialog on first link load); upgrade button appears for capable peer', async ({
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

    const aliceStorage = await alice.evaluate(() => globalThis.sessionStorage.length);
    const bobStorage = await bob.evaluate(() => globalThis.sessionStorage.length);
    expect(aliceStorage).toBe(0);
    expect(bobStorage).toBe(0);

    await expect(alice.getByTestId('upgrade-button')).toBeVisible();
    await expect(bob.getByTestId('upgrade-button')).toBeVisible();

    const aliceLocal = await alice.evaluate(() =>
      Object.keys(globalThis.localStorage).filter((k) => k !== 'c7XmK9-bN4q'),
    );
    expect(aliceLocal).toEqual([]);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('mixed PRF/RAM pair handshakes successfully (server is mode-agnostic)', async ({
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

    await expect(alice.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE', {
      timeout: 10_000,
    });
    await expect(bob.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE', {
      timeout: 10_000,
    });
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});
