import { expect, test } from '@playwright/test';

import { useProdDist } from './fixtures/prod-dist.ts';

const prodDist = useProdDist('lazy-chunk failure runs once on Chromium');

test('a chat view chunk that fails to load leaves a failure state, not a connecting shell', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'lazy-chunk failure runs once on Chromium');
  await page.route(/\/assets\/chat-view-[\w-]+\.js$/u, async (route) => {
    await route.abort();
  });
  await page.goto(prodDist().baseUrl);
  await page.locator('.landing__create').click();
  await page.waitForURL(/\/r402#[\w-]{43}$/u);

  const shell = page.locator('main.chat');
  await expect(shell).toHaveAttribute('data-state', 'LOAD_FAILED');
  await expect(shell.locator('.chat__placeholder')).toHaveText(
    "Couldn't load the chat. Reload the page to try again.",
  );
  await expect(shell.locator('.sr-only[data-state]')).toHaveText('LOAD_FAILED');
});
