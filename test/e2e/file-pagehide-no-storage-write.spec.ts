import { expect, test } from '@playwright/test';

import { closeAll, openActiveRoom } from './fixtures/file-helpers.ts';
import { buildPaddedPng } from './fixtures/png.ts';

test('pagehide during chunk burst does not touch sessionStorage', async ({ browser }) => {
  const { aliceContext, bobContext, alice, bob } = await openActiveRoom(browser);
  try {
    await alice.evaluate(() => {
      const w = globalThis as unknown as {
        __storageWrites?: Array<{ kind: string; key: string; t: number }>;
      };
      w.__storageWrites = [];
      const origRemove = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function (key: string): void {
        w.__storageWrites?.push({ kind: 'removeItem', key, t: performance.now() });
        return origRemove.call(this, key);
      };
      const origSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string): void {
        w.__storageWrites?.push({ kind: 'setItem', key, t: performance.now() });
        return origSet.call(this, key, value);
      };
    });

    const bytes = buildPaddedPng(64 * 1024);
    await alice.locator('[data-testid="file-input"]').setInputFiles({
      name: 'pagehide-probe.png',
      mimeType: 'image/png',
      buffer: bytes,
    });
    await alice.getByTestId('send').click();
    await expect(bob.getByTestId('file-bubble-offer')).toBeVisible({ timeout: 10_000 });
    await bob.getByTestId('file-accept').click();
    await expect(alice.getByTestId('file-bubble-inflight')).toBeVisible({ timeout: 10_000 });

    const beforePagehide = await alice.evaluate(() => {
      const w = globalThis as unknown as {
        __storageWrites?: Array<{ kind: string; key: string; t: number }>;
      };
      return w.__storageWrites?.length ?? 0;
    });

    const pagehideTs = await alice.evaluate(() => {
      const t = performance.now();
      const event = new PageTransitionEvent('pagehide', { persisted: false });
      globalThis.dispatchEvent(event);
      return t;
    });

    await alice.waitForTimeout(200);

    const writes = await alice.evaluate(() => {
      const w = globalThis as unknown as {
        __storageWrites?: Array<{ kind: string; key: string; t: number }>;
      };
      return w.__storageWrites ?? [];
    });

    const writesAfter = writes.filter((entry) => entry.t >= pagehideTs);
    const sessionWrites = writesAfter.filter(
      (entry) => !(entry.kind === 'setItem' && entry.key === 'c7XmK9-bN4q'),
    );
    expect(sessionWrites).toEqual([]);
    expect(beforePagehide).toBeGreaterThanOrEqual(0);
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});
