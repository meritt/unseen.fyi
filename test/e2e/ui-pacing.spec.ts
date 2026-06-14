import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';

const closeAll = async (...contexts: readonly BrowserContext[]): Promise<void> => {
  await Promise.all(contexts.map(async (ctx) => await ctx.close()));
};

const waitForActive = async (page: Page): Promise<void> => {
  await expect(page.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE', {
    timeout: 10_000,
  });
};

const goActive = async (browser: Browser) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  await alice.goto('/');
  await alice.getByTestId('create-room').click();
  await alice.waitForURL(/\/r402#[\w-]{43}$/u);
  await bob.goto(alice.url());
  await waitForActive(alice);
  await waitForActive(bob);
  return { aliceContext, bobContext, alice, bob };
};

test('render-pacing-burst: 60 synthetic peer messages coalesce into a small number of renders', async ({
  browser,
}) => {
  const { aliceContext, bobContext, bob } = await goActive(browser);
  try {
    const result = await bob.evaluate(async () => {
      const hook = (
        globalThis as unknown as { __unseenTest?: { appendMessage: (m: unknown) => void } }
      ).__unseenTest;
      if (hook === undefined) {
        throw new Error('test hook missing');
      }
      const start = performance.now();
      for (let i = 0; i < 60; i += 1) {
        hook.appendMessage({
          id: `synthetic-${String(i)}`,
          kind: 'chat',
          direction: 'in',
          body: `burst ${String(i)}`,
          receivedAtIso: '2026-05-14T00:00:00.000Z',
        });
      }
      const enqueueElapsed = performance.now() - start;
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
      const drainElapsed = performance.now() - start;
      return { enqueueElapsed, drainElapsed };
    });
    expect(result.enqueueElapsed).toBeLessThan(50);
    expect(result.drainElapsed).toBeLessThan(150);
    await expect(bob.getByTestId('messages').locator('.chat__msg').last()).toContainText(
      'burst 59',
    );
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('dom-cap-prune: 600 synthetic peer messages prune to 500 with the "earlier removed" indicator', async ({
  browser,
}) => {
  const { aliceContext, bobContext, bob } = await goActive(browser);
  try {
    await bob.evaluate(async () => {
      const hook = (
        globalThis as unknown as { __unseenTest?: { appendMessage: (m: unknown) => void } }
      ).__unseenTest;
      if (hook === undefined) {
        throw new Error('test hook missing');
      }
      for (let i = 0; i < 600; i += 1) {
        hook.appendMessage({
          id: `m-${String(i)}`,
          kind: 'chat',
          direction: 'in',
          body: `text ${String(i)}`,
          receivedAtIso: '2026-05-14T00:00:00.000Z',
        });
      }
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });

    const messageCount = await bob.getByTestId('messages').locator('.chat__msg').count();
    expect(messageCount).toBe(500);
    await expect(bob.getByTestId('earlier-removed')).toBeVisible();
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('auto-scroll-detach: scrolling up while messages flow shows the "new messages" badge', async ({
  browser,
}) => {
  const { aliceContext, bobContext, bob } = await goActive(browser);
  try {
    await bob.evaluate(async () => {
      const hook = (
        globalThis as unknown as { __unseenTest?: { appendMessage: (m: unknown) => void } }
      ).__unseenTest;
      if (hook === undefined) {
        throw new Error('test hook missing');
      }
      for (let i = 0; i < 100; i += 1) {
        hook.appendMessage({
          id: `seed-${String(i)}`,
          kind: 'chat',
          direction: 'in',
          body: `seed ${String(i)}`,
          receivedAtIso: '2026-05-14T00:00:00.000Z',
        });
      }
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });

    await bob.evaluate(() => {
      const feed = document.querySelector('[data-testid="messages"]');
      if (feed instanceof HTMLElement) {
        feed.scrollTop = 0;
        feed.dispatchEvent(new Event('scroll'));
      }
    });
    await bob.waitForTimeout(150);

    await bob.evaluate(async () => {
      const hook = (
        globalThis as unknown as { __unseenTest?: { appendMessage: (m: unknown) => void } }
      ).__unseenTest;
      if (hook === undefined) {
        throw new Error('test hook missing');
      }
      for (let i = 0; i < 3; i += 1) {
        hook.appendMessage({
          id: `tail-${String(i)}`,
          kind: 'chat',
          direction: 'in',
          body: `tail ${String(i)}`,
          receivedAtIso: '2026-05-14T00:00:00.000Z',
        });
      }
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });

    await expect(bob.getByTestId('auto-scroll-badge')).toBeVisible({ timeout: 2000 });
    await expect(bob.getByTestId('auto-scroll-badge')).toContainText('3');

    await bob.getByTestId('auto-scroll-badge').click();
    await expect(bob.getByTestId('auto-scroll-badge')).toHaveCount(0);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});
