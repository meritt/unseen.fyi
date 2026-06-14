import { type BrowserContext, expect, test } from '@playwright/test';

test.skip(
  ({ browserName }) => browserName !== 'chromium',
  'OPFS + WebAuthn semantics are Chromium-specific',
);

const closeAll = async (...contexts: readonly BrowserContext[]): Promise<void> => {
  await Promise.all(contexts.map(async (ctx) => await ctx.close()));
};

test('burn navigates within 1500ms even when OPFS removeEntry hangs', async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  try {
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();

    await alice.addInitScript(() => {
      const proto = (
        globalThis as unknown as { FileSystemDirectoryHandle?: { prototype: unknown } }
      ).FileSystemDirectoryHandle?.prototype as { removeEntry?: unknown } | undefined;
      if (proto === undefined || typeof proto.removeEntry !== 'function') {
        return;
      }
      const original = proto.removeEntry as (
        this: unknown,
        name: string,
        options?: unknown,
      ) => Promise<void>;
      Object.defineProperty(proto, 'removeEntry', {
        configurable: true,
        writable: true,
        value: async function removeEntryPatched(
          this: unknown,
          name: string,
          options?: unknown,
        ): Promise<void> {
          await new Promise((resolve) => {
            setTimeout(resolve, 5000);
          });
          return await original.call(this, name, options);
        },
      });
    });

    await alice.goto('/');
    await alice.getByTestId('create-room').click();
    await alice.waitForURL(/\/r402#[\w-]{43}$/u);
    await bob.goto(alice.url());
    await expect(alice.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE', {
      timeout: 10_000,
    });
    await expect(bob.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE', {
      timeout: 10_000,
    });

    await alice.getByTestId('burn-button').click();
    const burnStart = Date.now();
    await alice.getByTestId('burn-button').click();
    await alice.waitForURL((url) => url.pathname === '/', { timeout: 3000 });
    const burnEnd = Date.now();
    const elapsed = burnEnd - burnStart;

    // 500ms purge wait plus click/navigation headroom, far below a hang
    expect(elapsed).toBeLessThan(1500);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});
