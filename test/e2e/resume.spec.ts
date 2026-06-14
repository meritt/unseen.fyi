import { type BrowserContext, expect, type Page, test } from '@playwright/test';

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

const closeAll = async (...contexts: readonly BrowserContext[]): Promise<void> => {
  await Promise.all(contexts.map(async (ctx) => await ctx.close()));
};

const waitForState = async (page: Page, state: string): Promise<void> => {
  await expect(page.locator('[data-testid="status"]')).toHaveAttribute('data-state', state, {
    timeout: 10_000,
  });
};

const sendMessage = async (page: Page, body: string): Promise<void> => {
  await page.getByTestId('composer').fill(body);
  await page.getByTestId('send').click();
};

test('PRF resume after F5: alice reloads, both sides return to ACTIVE and counters survive', async ({
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

    await waitForState(alice, 'ACTIVE');
    await waitForState(bob, 'ACTIVE');

    await alice.getByTestId('upgrade-button').click();
    await expect(alice.getByTestId('system-mode_upgraded_locally')).toBeVisible({ timeout: 5000 });

    await sendMessage(alice, 'hello-before-reload');
    await expect(bob.getByTestId('messages').locator('.chat__msg')).toContainText(
      'hello-before-reload',
    );

    await alice.reload();
    await waitForState(alice, 'ACTIVE');
    await waitForState(bob, 'ACTIVE');

    await expect(bob.getByTestId('system-peer_disconnected')).toBeVisible();
    await expect(bob.getByTestId('system-peer_reconnected')).toBeVisible();

    await sendMessage(bob, 'after-resume-from-bob');
    await expect(alice.getByTestId('messages').locator('.chat__msg')).toContainText(
      'after-resume-from-bob',
    );
    await sendMessage(alice, 'after-resume-from-alice');
    await expect(bob.getByTestId('messages').locator('.chat__msg').last()).toContainText(
      'after-resume-from-alice',
    );
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});
