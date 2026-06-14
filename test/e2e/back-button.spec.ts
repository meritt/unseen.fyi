import { expect, test } from '@playwright/test';

test('browser back from an active session returns to the landing page', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('create-room').click();
  await page.waitForURL(/\/r402#[\w-]{43}$/u);
  await expect(page.getByTestId('system-waiting_for_peer')).toBeVisible({ timeout: 5000 });

  await page.goBack();

  await expect(page.getByTestId('create-room')).toBeVisible();
  expect(page.url()).not.toContain('/r402');
});
