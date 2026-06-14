import { type BrowserContext, expect, type Page, test } from '@playwright/test';

const waitForActive = async (page: Page): Promise<void> => {
  await expect(page.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE', {
    timeout: 10_000,
  });
};

const waitForTerminated = async (page: Page): Promise<void> => {
  await expect(page.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'TERMINATED', {
    timeout: 10_000,
  });
};

const closeAll = async (...contexts: readonly BrowserContext[]): Promise<void> => {
  await Promise.all(contexts.map(async (ctx) => await ctx.close()));
};

test('duplicate-tab: opening the same URL in a second tab of the same context terminates the second tab', async ({
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

    const bobDuplicate = await bobContext.newPage();
    await bobDuplicate.goto(sharedUrl);

    await waitForTerminated(bobDuplicate);
    await expect(bobDuplicate.getByTestId('system-duplicate_tab_blocked')).toBeVisible({
      timeout: 5000,
    });
    const blockedText =
      (await bobDuplicate.getByTestId('system-duplicate_tab_blocked').textContent()) ?? '';
    expect(blockedText.toLowerCase()).not.toContain('error');
    expect(blockedText.toLowerCase()).not.toContain('lock');

    await expect(alice.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE');
    await expect(bob.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE');
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});

test('opaque-lock-name: navigator.locks.request is invoked with a name that does not leak room metadata', async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const alice = await context.newPage();
    await alice.addInitScript(() => {
      const w = globalThis as unknown as { __lockNames__: string[] };
      w.__lockNames__ = [];
      const proto = Object.getPrototypeOf(navigator.locks) as LockManager;
      const original = proto.request;
      const patched = {
        request(this: LockManager, name: string, ...rest: readonly unknown[]): unknown {
          w.__lockNames__.push(name);
          return Reflect.apply(original, this, [name, ...rest]);
        },
      };
      Object.defineProperty(proto, 'request', {
        value: patched.request,
        writable: true,
        configurable: true,
      });
    });

    await alice.goto('/');
    await alice.getByTestId('create-room').click();
    await alice.waitForURL(/\/r402#[\w-]{43}$/u);
    await expect(alice.locator('[data-testid="status"]')).toHaveAttribute(
      'data-state',
      'WAITING_FOR_PEER',
      { timeout: 10_000 },
    );

    const captured = await alice.evaluate(
      () => (globalThis as unknown as { __lockNames__: string[] }).__lockNames__,
    );
    expect(captured.length).toBeGreaterThanOrEqual(1);
    for (const name of captured) {
      expect(name).toMatch(/^[\w-]{11}$/);
      expect(name.toLowerCase()).not.toContain('unseen');
      expect(name.toLowerCase()).not.toContain('session');
      expect(name.toLowerCase()).not.toContain('room');
    }
  } finally {
    await context.close();
  }
});

test('lock-released-on-close: closing the holding tab frees the room lock for a fresh tab', async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const first = await context.newPage();
    await first.goto('/');
    await first.getByTestId('create-room').click();
    await first.waitForURL(/\/r402#[\w-]{43}$/u);
    const sharedUrl = first.url();

    const dup = await context.newPage();
    await dup.goto(sharedUrl);
    await waitForTerminated(dup);
    await dup.close();

    await first.close();

    const reopen = await context.newPage();
    await reopen.goto(sharedUrl);
    await expect(reopen.locator('[data-testid="status"]')).not.toHaveAttribute(
      'data-state',
      'TERMINATED',
      { timeout: 10_000 },
    );
  } finally {
    await context.close();
  }
});
