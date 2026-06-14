import { type BrowserContext, expect, type Page, test } from '@playwright/test';

test.skip(
  ({ browserName }) => browserName !== 'chromium',
  'OPFS + Web Locks semantics are Chromium-specific',
);

const closeAll = async (...contexts: readonly BrowserContext[]): Promise<void> => {
  await Promise.all(contexts.map(async (ctx) => await ctx.close()));
};

const waitForActive = async (page: Page): Promise<void> => {
  await expect(page.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE', {
    timeout: 10_000,
  });
};

const waitForFileReady = async (page: Page): Promise<void> => {
  await page.waitForFunction(
    () => {
      const hook = (
        globalThis as unknown as {
          __unseenTest?: { fileState?: { fileTransferReady?: { value: boolean } } };
        }
      ).__unseenTest;
      return hook?.fileState?.fileTransferReady?.value === true;
    },
    { timeout: 10_000 },
  );
};

test('BFCache restore triggers OPFS sweep and forces TERMINATED', async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  try {
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();

    await alice.addInitScript(() => {
      const w = globalThis as unknown as { __lockNames?: string[] };
      w.__lockNames = [];
      const proto = Object.getPrototypeOf(navigator.locks) as {
        request: (name: string, ...args: unknown[]) => unknown;
      };
      const orig = proto.request;
      proto.request = function (name: string, ...args: unknown[]) {
        w.__lockNames?.push(name);
        return orig.call(this, name, ...args);
      };
    });

    await alice.goto('/');
    await alice.getByTestId('create-room').click();
    await alice.waitForURL(/\/r402#[\w-]{43}$/u);
    await bob.goto(alice.url());
    await waitForActive(alice);
    await waitForActive(bob);
    await waitForFileReady(alice);

    const opfsLockName = await alice.evaluate(() => {
      const hook = (
        globalThis as unknown as {
          __unseenTest?: { fileState?: { OPFS_LOCK_NAME?: string } };
        }
      ).__unseenTest;
      return hook?.fileState?.OPFS_LOCK_NAME ?? null;
    });
    expect(opfsLockName).toBeTruthy();

    const beforeBfcacheCount = await alice.evaluate(() => {
      const w = globalThis as unknown as { __lockNames?: string[] };
      return w.__lockNames?.length ?? 0;
    });

    await alice.evaluate(() => {
      const event = new PageTransitionEvent('pageshow', { persisted: true });
      globalThis.dispatchEvent(event);
    });

    await expect(alice.locator('[data-testid="status"]')).toHaveAttribute(
      'data-state',
      'TERMINATED',
      { timeout: 5000 },
    );

    const lockName = opfsLockName!;
    await alice.waitForFunction(
      (args: { before: number; lockName: string }) => {
        const w = globalThis as unknown as { __lockNames?: string[] };
        const names = w.__lockNames ?? [];
        return names.slice(args.before).includes(args.lockName);
      },
      { before: beforeBfcacheCount, lockName },
      { timeout: 5000 },
    );
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});
