import { expect, test } from '@playwright/test';

const COMMIT_HREF_RE = /^https:\/\/github\.com\/meritt\/unseen\.fyi\/commit\/[0-9a-f]{7,40}$/u;

test('landing footer shows a hash link to the release commit', async ({ page }) => {
  await page.goto('/');

  const link = page.locator('.landing__footer-note a.version-stamp__sha');
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noreferrer/u);

  const href = await link.getAttribute('href');
  expect(href).toMatch(COMMIT_HREF_RE);

  const labelText = await link.textContent();
  const label = (labelText ?? '').trim();
  expect(label).toMatch(/^git@[0-9a-f]{7}$/u);

  const shortSha = label.slice('git@'.length);
  const fullSha = href?.split('/').pop() ?? '';
  expect(fullSha.startsWith(shortSha)).toBe(true);
});
