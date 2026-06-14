import { type BrowserContext, expect, type Page, test } from '@playwright/test';

const closeAll = async (...contexts: readonly BrowserContext[]): Promise<void> => {
  await Promise.all(contexts.map(async (ctx) => await ctx.close()));
};

const waitForActive = async (page: Page): Promise<void> => {
  await expect(page.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE', {
    timeout: 10_000,
  });
};

const sendMessage = async (page: Page, body: string): Promise<void> => {
  const composer = page.getByTestId('composer');
  await composer.fill(body);
  await page.getByTestId('send').click();
};

const messageTexts = (page: Page): Promise<string[]> =>
  page.getByTestId('messages').locator('.chat__msg').allInnerTexts();

test('two browsers exchange messages over the RAM-mode happy path', async ({ browser }) => {
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

    const aliceSas = await alice.getByTestId('sas-badge').getAttribute('data-testid-sas');
    const bobSas = await bob.getByTestId('sas-badge').getAttribute('data-testid-sas');
    expect(aliceSas).toHaveLength(10);
    expect(aliceSas).toBe(bobSas);

    await sendMessage(alice, 'hello');
    await expect(bob.getByTestId('messages').locator('.chat__msg')).toContainText('hello');

    await sendMessage(bob, 'world');
    await expect(alice.getByTestId('messages').locator('.chat__msg').nth(1)).toContainText('world');

    const aliceTexts = await messageTexts(alice);
    const bobTexts = await messageTexts(bob);
    expect(aliceTexts).toEqual(['hello', 'world']);
    expect(bobTexts).toEqual(['hello', 'world']);

    const aliceStorage = await alice.evaluate(() => ({
      session: globalThis.sessionStorage.length,
      localKeys: Object.keys(globalThis.localStorage),
    }));
    const bobStorage = await bob.evaluate(() => ({
      session: globalThis.sessionStorage.length,
      localKeys: Object.keys(globalThis.localStorage),
    }));
    expect(aliceStorage.session).toBe(0);
    expect(bobStorage.session).toBe(0);
    expect(aliceStorage.localKeys.filter((k) => k !== 'c7XmK9-bN4q')).toEqual([]);
    expect(bobStorage.localKeys.filter((k) => k !== 'c7XmK9-bN4q')).toEqual([]);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('third browser opening the same link sees the room is full', async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const charlieContext = await browser.newContext();

  try {
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    const charlie = await charlieContext.newPage();

    await alice.goto('/');
    await alice.getByTestId('create-room').click();
    await alice.waitForURL(/\/r402#[\w-]{43}$/u);
    const sharedUrl = alice.url();

    await bob.goto(sharedUrl);
    await waitForActive(alice);
    await waitForActive(bob);

    await charlie.goto(sharedUrl);

    await expect(charlie.locator('[data-testid="status"]')).toHaveAttribute(
      'data-state',
      'TERMINATED',
      { timeout: 5000 },
    );
    await expect(charlie.getByTestId('system-session_ended')).toBeVisible();
  } finally {
    await closeAll(aliceContext, bobContext, charlieContext);
  }
});
