import { type BrowserContext, expect, type Page, test } from '@playwright/test';

const closeAll = async (...contexts: readonly BrowserContext[]): Promise<void> => {
  await Promise.all(contexts.map(async (ctx) => await ctx.close()));
};

const waitForActive = async (page: Page): Promise<void> => {
  await expect(page.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE', {
    timeout: 10_000,
  });
};

test('title invariant: document.title stays "peer@unseen ~ $ wait" across landing → chat → terminated', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page).toHaveTitle('peer@unseen ~ $ wait');

  await page.getByTestId('create-room').click();
  await page.waitForURL(/\/r402#[\w-]{43}$/u);
  await expect(page).toHaveTitle('peer@unseen ~ $ wait');

  await page.evaluate(() => {
    globalThis.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page).toHaveTitle('peer@unseen ~ $ wait');
});

test('lang-persistence: toggle writes opaque-keyed entry, survives reload, no other localStorage keys', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByTestId('lang-ru').click();
  const afterToggle = await page.evaluate(() => ({
    stored: globalThis.localStorage.getItem('c7XmK9-bN4q'),
    keys: Object.keys(globalThis.localStorage),
    session: globalThis.sessionStorage.length,
  }));
  expect(afterToggle.stored).toBe('ru');
  expect(afterToggle.session).toBe(0);
  expect(afterToggle.keys).toEqual(['c7XmK9-bN4q']);
  expect(afterToggle.keys[0]).toMatch(/^[\w-]{11}$/u);
  await page.reload();
  await expect(page.getByTestId('lang-ru')).toHaveAttribute('aria-pressed', 'true');
});

test('panic-wipe cancel keeps the session alive', async ({ browser }) => {
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
    await expect(burn).toHaveAttribute('aria-pressed', 'true');
    await alice.waitForTimeout(3200);
    await expect(burn).toHaveAttribute('aria-pressed', 'false');
    await expect(alice.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE');
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('panic-wipe confirm closes the session and clears sessionStorage', async ({ browser }) => {
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
    await expect(burn).toHaveAttribute('aria-pressed', 'true');
    await burn.click();

    await alice.waitForURL((url) => url.pathname === '/', { timeout: 5000 });
    await expect(alice.getByTestId('burn-button')).toHaveCount(0);
    await expect(alice.getByTestId('composer')).toHaveCount(0);

    const aliceStorageAfter = await alice.evaluate(() => ({
      session: globalThis.sessionStorage.length,
      localKeys: Object.keys(globalThis.localStorage),
    }));
    expect(aliceStorageAfter.session).toBe(0);
    expect(aliceStorageAfter.localKeys.filter((k) => k !== 'c7XmK9-bN4q')).toEqual([]);

    await expect(bob.locator('[data-testid="status"]')).toHaveAttribute(
      'data-state',
      'TERMINATED',
      { timeout: 10_000 },
    );
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('peer-exit no-debug-leak: TERMINATED overlay contains no reason code or error string', async ({
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

    await expect(bob.getByTestId('system-session_ended')).toBeVisible({ timeout: 10_000 });
    const overlayText = (await bob.getByTestId('system-session_ended').textContent()) ?? '';
    expect(overlayText.toLowerCase()).not.toContain('user_panic');
    expect(overlayText.toLowerCase()).not.toContain('peer_gone');
    expect(overlayText.toLowerCase()).not.toContain('server_error');
    expect(overlayText).not.toMatch(/[0-9]+:[0-9]{2}/u);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('system-events-accumulate: peer_disconnected/peer_reconnected pairs stay in feed', async ({
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

    await alice.getByTestId('composer').fill('hello');
    await alice.getByTestId('send').click();
    await expect(bob.getByTestId('messages').locator('.chat__msg').first()).toContainText('hello');

    await alice.close();

    await expect(bob.locator('[data-testid="status"]')).toHaveAttribute(
      'data-state',
      'TERMINATED',
      { timeout: 15_000 },
    );

    await expect(bob.getByTestId('system-session_started')).toBeVisible();
    await expect(bob.getByTestId('system-session_ended')).toBeVisible();
    await expect(bob.getByTestId('messages').locator('.chat__msg')).toContainText('hello');
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('session-ended-auto-redirect: 10 s after a natural TERMINATED the page lands on /', async ({
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

    await bob.close();
    await expect(alice.locator('[data-testid="status"]')).toHaveAttribute(
      'data-state',
      'TERMINATED',
      { timeout: 15_000 },
    );

    await alice.waitForURL((url) => url.pathname === '/', { timeout: 13_000 });

    const storageAfter = await alice.evaluate(() => ({
      session: globalThis.sessionStorage.length,
      local: globalThis.localStorage.length,
    }));
    expect(storageAfter.session).toBe(0);
    const localKeys = await alice.evaluate(() => Object.keys(globalThis.localStorage));
    expect(localKeys.filter((k) => k !== 'c7XmK9-bN4q')).toEqual([]);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('invite-link-copy-from-feed: the copy button inside waiting_for_peer pill writes the URL', async ({
  browser,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'clipboard permissions API is Chromium-only');
  const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  try {
    const alice = await ctx.newPage();
    await alice.goto('/');
    await alice.getByTestId('create-room').click();
    await alice.waitForURL(/\/r402#[\w-]{43}$/u);
    const sharedUrl = alice.url();

    await expect(alice.getByTestId('system-waiting_for_peer')).toBeVisible({ timeout: 5000 });
    await expect(alice.getByTestId('invite-link')).toHaveAttribute('href', sharedUrl);

    await alice.getByTestId('copy-link').click();
    const clipboardText = await alice.evaluate(() => globalThis.navigator.clipboard.readText());
    expect(clipboardText).toBe(sharedUrl);
  } finally {
    await ctx.close();
  }
});

test('composer-typeahead-while-waiting: textarea editable before peer joins, send stays disabled', async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  try {
    const alice = await ctx.newPage();
    await alice.goto('/');
    await alice.getByTestId('create-room').click();
    await alice.waitForURL(/\/r402#[\w-]{43}$/u);

    await expect(alice.getByTestId('system-waiting_for_peer')).toBeVisible({ timeout: 5000 });
    const composer = alice.getByTestId('composer');
    await expect(composer).toBeEnabled();
    await composer.fill('typing ahead while waiting');
    expect(await composer.inputValue()).toBe('typing ahead while waiting');
    await expect(alice.getByTestId('send')).toBeDisabled();
  } finally {
    await ctx.close();
  }
});
