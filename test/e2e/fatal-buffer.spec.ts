import { type BrowserContext, expect, type Page, test } from '@playwright/test';

const waitForActive = async (page: Page): Promise<void> => {
  await expect(page.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE', {
    timeout: 10_000,
  });
};

const closeAll = async (...contexts: readonly BrowserContext[]): Promise<void> => {
  await Promise.all(contexts.map(async (ctx) => await ctx.close()));
};

test('fatal-flow-3s-buffer: peer departure surfaces FATAL_ENDING overlay before TERMINATED', async ({
  browser,
}) => {
  test.setTimeout(20_000);
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

    await alice.close();

    await expect(bob.locator('[data-testid="status"]')).toHaveAttribute(
      'data-state',
      'FATAL_ENDING',
      { timeout: 5000 },
    );
    const ending = (await bob.getByTestId('chat-placeholder').textContent({ timeout: 5000 })) ?? '';
    expect(ending.toLowerCase()).not.toContain('error');
    expect(ending.toLowerCase()).not.toContain('peer_gone');
    expect(ending).not.toMatch(/\d/);

    await expect(bob.locator('[data-testid="status"]')).toHaveAttribute(
      'data-state',
      'TERMINATED',
      { timeout: 6000 },
    );
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('panic-wipe-immediate: burn-button confirms terminate without the fatal buffer', async ({
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

    const burn = alice.getByTestId('burn-button');
    await burn.click();
    await burn.click();

    await alice.waitForURL((url) => url.pathname === '/', { timeout: 2000 });
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});
