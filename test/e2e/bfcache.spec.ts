import { type BrowserContext, expect, type Page, test } from '@playwright/test';

const closeAll = async (...contexts: readonly BrowserContext[]): Promise<void> => {
  await Promise.all(contexts.map(async (ctx) => await ctx.close()));
};

const waitForActive = async (page: Page): Promise<void> => {
  await expect(page.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE', {
    timeout: 10_000,
  });
};

test('bfcache-restore-terminates: synthetic pageshow.persisted=true forces TERMINATED + cleared history', async ({
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

    await alice.getByTestId('composer').fill('pre-bfcache-message');
    await alice.getByTestId('send').click();
    await expect(bob.getByTestId('messages').locator('.chat__msg').first()).toContainText(
      'pre-bfcache-message',
    );

    await bob.evaluate(() => {
      const event = new PageTransitionEvent('pageshow', { persisted: true });
      globalThis.dispatchEvent(event);
    });

    await expect(bob.locator('[data-testid="status"]')).toHaveAttribute(
      'data-state',
      'TERMINATED',
      { timeout: 5000 },
    );
    const messageCount = await bob.getByTestId('messages').locator('.chat__msg').count();
    expect(messageCount).toBe(0);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('pagehide-clean-ws-close: peer sees the disconnect promptly when one peer fires pagehide', async ({
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

    await alice.evaluate(() => {
      const event = new PageTransitionEvent('pagehide', { persisted: false });
      globalThis.dispatchEvent(event);
    });

    await expect(bob.locator('[data-testid="status"]')).toHaveAttribute(
      'data-state',
      'TERMINATED',
      { timeout: 15_000 },
    );
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('visibility-ws-dead-recovery: a dead WS detected on visibility wake forces TERMINATED', async ({
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

    await bob.evaluate(() => {
      const closeEvent = new PageTransitionEvent('pagehide', { persisted: false });
      globalThis.dispatchEvent(closeEvent);
    });

    await bob.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await expect(bob.locator('[data-testid="status"]')).toHaveAttribute(
      'data-state',
      'TERMINATED',
      { timeout: 10_000 },
    );
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});
