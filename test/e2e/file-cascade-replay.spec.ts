import { expect, type Page, test } from '@playwright/test';

import { waitForActive, waitForFileTransferReady } from './fixtures/file-helpers.ts';
import { buildPaddedPng } from './fixtures/png.ts';

const SPY_INIT_SCRIPT = `
  (() => {
    if (globalThis.__wsFramesInstalled) return;
    globalThis.__wsFramesInstalled = true;
    globalThis.__wsFrames = [];
    const origSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      let type = -1;
      let size = 0;
      if (data instanceof ArrayBuffer) {
        size = data.byteLength;
        if (size > 0) {
          type = new Uint8Array(data, 0, 1)[0];
        }
      } else if (ArrayBuffer.isView(data)) {
        size = data.byteLength;
        if (size > 0) {
          type = new Uint8Array(data.buffer, data.byteOffset, 1)[0];
        }
      }
      globalThis.__wsFrames.push({ t: performance.now(), type: type, size: size });
      return origSend.call(this, data);
    };
  })();
`;

const IDLE_WINDOW_MS = 90_000;
const VERIFYING_CLEAR_MAX_MS = 45_000;

type WireFrame = { readonly t: number; readonly type: number; readonly size: number };

const getFrames = async (page: Readonly<Page>): Promise<readonly WireFrame[]> => {
  return await page.evaluate(
    () =>
      (globalThis as unknown as { __wsFrames?: readonly WireFrame[] }).__wsFrames ??
      ([] as readonly WireFrame[]),
  );
};

test.setTimeout(180_000);

test('no cascade replay during 90s idle window after file transfer completes', async ({
  browser,
}) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  await aliceContext.addInitScript({ content: SPY_INIT_SCRIPT });
  await bobContext.addInitScript({ content: SPY_INIT_SCRIPT });
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  try {
    await alice.goto('/');
    await alice.getByTestId('create-room').click();
    await alice.waitForURL(/\/r402#[\w-]{43}$/u);
    await bob.goto(alice.url());
    await waitForActive(alice);
    await waitForActive(bob);
    await waitForFileTransferReady(alice);
    await waitForFileTransferReady(bob);

    const file = buildPaddedPng(10 * 1024);
    await alice.locator('[data-testid="file-input"]').setInputFiles({
      name: 'cascade-probe.png',
      mimeType: 'image/png',
      buffer: file,
    });
    await alice.getByTestId('send').click();

    await expect(bob.getByTestId('file-bubble-offer')).toBeVisible({ timeout: 10_000 });
    await bob.getByTestId('file-accept').click();
    await expect(bob.getByTestId('file-bubble-attachment').first()).toBeVisible({
      timeout: 15_000,
    });

    await alice.waitForFunction(
      () => {
        const hook = (
          globalThis as unknown as {
            __unseenTest?: { fileState?: { transferActive?: { value: unknown } } };
          }
        ).__unseenTest;
        return hook?.fileState?.transferActive?.value === null;
      },
      { timeout: VERIFYING_CLEAR_MAX_MS },
    );

    const aliceFramesBefore = await getFrames(alice);
    const bobFramesBefore = await getFrames(bob);
    const aliceCountBefore = aliceFramesBefore.length;
    const bobCountBefore = bobFramesBefore.length;

    await alice.waitForTimeout(IDLE_WINDOW_MS);

    const aliceFramesAfter = await getFrames(alice);
    const bobFramesAfter = await getFrames(bob);

    const aliceDelta = aliceFramesAfter.slice(aliceCountBefore);
    const bobDelta = bobFramesAfter.slice(bobCountBefore);

    expect(aliceDelta, `Alice sent ${aliceDelta.length} frames during idle window`).toEqual([]);
    expect(bobDelta, `Bob sent ${bobDelta.length} frames during idle window`).toEqual([]);

    await expect(bob.getByTestId('file-bubble-attachment')).toHaveCount(1);
    await expect(alice.getByTestId('file-message')).toHaveCount(1);
    await expect(bob.getByTestId('file-message')).toHaveCount(1);

    await expect(alice.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE');
    await expect(bob.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE');
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});
