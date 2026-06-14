import { expect, type Page, test } from '@playwright/test';

const STAMP_KEY = 'storage-survives-f5-marker';
const STAMP_VALUE = 'tombstone-token';

const bootChatView = async (page: Page): Promise<void> => {
  await page.goto('/');
  await page.getByTestId('create-room').click();
  await page.waitForURL(/\/r402#[\w-]{43}$/u);
  await page.waitForSelector('chat-view');
};

test('sessionStorage survives F5 on /r402 (chat-view does not wipe storage on unload)', async ({
  page,
}) => {
  await bootChatView(page);

  await page.evaluate(
    ([k, v]) => {
      globalThis.sessionStorage.setItem(k ?? '', v ?? '');
    },
    [STAMP_KEY, STAMP_VALUE],
  );

  const before = await page.evaluate((k) => globalThis.sessionStorage.getItem(k), STAMP_KEY);
  expect(before).toBe(STAMP_VALUE);

  await page.reload();
  await page.waitForSelector('chat-view');

  const after = await page.evaluate((k) => globalThis.sessionStorage.getItem(k), STAMP_KEY);
  expect(after).toBe(STAMP_VALUE);
});

test('browser-level baseline: sessionStorage survives F5 on a plain page', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    globalThis.sessionStorage.setItem('baseline-marker', 'baseline-value');
  });
  await page.reload();
  const survived = await page.evaluate(() => globalThis.sessionStorage.getItem('baseline-marker'));
  expect(survived).toBe('baseline-value');
});
