import { expect, test } from '@playwright/test';
import { openApp, waitForEngine } from './helpers';

test('the query log records the count and re-runs an entry', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);

  await page.locator('.console__input').fill('likes(ada, X).');
  await page.locator('.console__input').press('Enter');
  await expect(page.locator('.results tbody tr')).toHaveCount(1);

  // The entry appears with a count, not just "ran": the log is a record of what
  // happened, not a list of goals that were typed.
  await page.locator('.log__summary').click();
  const entry = page.locator('.log__item').first();
  await expect(entry).toContainText('likes(ada, X).');
  await expect(entry).toContainText('1 solution');

  // Next solution raises the count, because the count is written as answers arrive.
  await page.locator('button', { hasText: 'Next solution' }).click();
  await expect(page.locator('.results tbody tr')).toHaveCount(2);
  await expect(entry).toContainText('2 solutions');

  // Clicking an entry runs it again — the point of a shared log.
  await entry.locator('.log__goal').click();
  await expect(page.locator('.results tbody tr')).toHaveCount(1);
});
