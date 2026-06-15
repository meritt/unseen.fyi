import { expect, test } from '@playwright/test';

import { closeAll, waitForActive, waitForFileTransferReady } from './fixtures/file-helpers.ts';
import { buildPaddedPng } from './fixtures/png.ts';

test('receiver cancels mid-receive: both sides see cancelled bubble; session stays ACTIVE', async ({
  browser,
}) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  try {
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();

    let holdBobInbound = false;
    await bob.routeWebSocket(/\/ws$/u, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((message) => server.send(message));
      server.onMessage((message) => {
        if (!holdBobInbound) {
          ws.send(message);
        }
      });
    });

    await alice.goto('/');
    await alice.getByTestId('create-room').click();
    await alice.waitForURL(/\/r402#[\w-]{43}$/u);
    await bob.goto(alice.url());
    await waitForActive(alice);
    await waitForActive(bob);
    await waitForFileTransferReady(alice);
    await waitForFileTransferReady(bob);

    const bytes = buildPaddedPng(64 * 1024);
    await alice.locator('[data-testid="file-input"]').setInputFiles({
      name: 'cancel-me.png',
      mimeType: 'image/png',
      buffer: bytes,
    });
    await alice.getByTestId('send').click();
    await expect(bob.getByTestId('file-bubble-offer')).toBeVisible({
      timeout: 10_000,
    });

    holdBobInbound = true;

    await bob.getByTestId('file-accept').click();
    await expect(bob.getByTestId('file-bubble-inflight')).toBeVisible({
      timeout: 10_000,
    });

    await bob.getByTestId('file-cancel').click();

    await expect(alice.getByTestId('system-file_transfer_cancelled')).toBeVisible({
      timeout: 10_000,
    });
    await expect(bob.getByTestId('system-file_transfer_cancelled')).toBeVisible({
      timeout: 10_000,
    });

    await expect(alice.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE');
    await expect(bob.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE');
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});
