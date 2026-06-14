import { mkdtempSync, openSync, closeSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { closeAll, openActiveRoom } from './fixtures/file-helpers.ts';

test('local pick larger than MAX_FILE_SIZE_BYTES: no chip, no offer sent, system event emitted', async ({
  browser,
}) => {
  const { aliceContext, bobContext, alice, bob } = await openActiveRoom(browser);
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'unseen-too-large-'));
  const tmpFile = path.join(tmpDir, 'too-large.bin');
  const fd = openSync(tmpFile, 'w');
  closeSync(fd);
  truncateSync(tmpFile, 101 * 1024 * 1024);
  try {
    await alice.locator('[data-testid="file-input"]').setInputFiles(tmpFile);

    await expect(alice.getByTestId('system-file_transfer_failed')).toBeVisible({ timeout: 5000 });
    await expect(alice.getByTestId('attached-chip')).toHaveCount(0);

    await alice.waitForTimeout(1000);
    await expect(bob.getByTestId('file-bubble-offer')).toHaveCount(0);

    await expect(alice.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE');
    await expect(bob.locator('[data-testid="status"]')).toHaveAttribute('data-state', 'ACTIVE');
  } finally {
    await closeAll(aliceContext, bobContext);
  }
});
