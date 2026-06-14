import { expect, test } from '@playwright/test';

test('cookie writes during unload are observable after reload (Chromium only)', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Firefox drops document.cookie writes during unload');

  await page.addInitScript(`
    globalThis.addEventListener('beforeunload', () => {
      document.cookie = '__unloadProbe=fired; path=/';
    });
  `);
  await page.goto('/');
  await page.evaluate(() => {
    document.cookie = '__unloadProbe=; max-age=0; path=/';
  });
  await page.reload();
  const cookies = await page.evaluate(() => document.cookie);
  expect(cookies).toContain('__unloadProbe=fired');
});
