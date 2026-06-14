import { type BrowserContext, expect, type Page, test } from '@playwright/test';

const closeAll = async (...contexts: readonly BrowserContext[]): Promise<void> => {
  await Promise.all(contexts.map(async (ctx) => await ctx.close()));
};

const waitForActive = async (page: Page): Promise<void> => {
  await expect(page.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE', {
    timeout: 10_000,
  });
};

test('disconnect-permanent (RAM): when alice closes her tab bob lands in TERMINATED', async ({
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
    await bob.goto(alice.url());
    await waitForActive(alice);
    await waitForActive(bob);

    await alice.close();

    await expect(bob.locator('[data-testid="status"]')).toHaveAttribute(
      'data-state',
      'TERMINATED',
      { timeout: 15_000 },
    );
    await expect(bob.getByTestId('system-session_ended')).toBeVisible();
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('both-disconnect (RAM): when both peers close, /healthz still serves and a fresh room can be created', async ({
  browser,
  request,
}) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const witnessContext = await browser.newContext();
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

    await Promise.all([alice.close(), bob.close()]);

    const healthz = await request.get('http://localhost:3001/healthz');
    expect(healthz.status()).toBe(200);
    expect(await healthz.text()).toBe('ok');

    const witness = await witnessContext.newPage();
    await witness.goto('/');
    await witness.getByTestId('create-room').click();
    await witness.waitForURL(/\/r402#[\w-]{43}$/u);
    expect(witness.url()).not.toBe(sharedUrl);
  } finally {
    await closeAll(witnessContext);
  }
});
