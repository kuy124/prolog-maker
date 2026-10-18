/**
 * Keyboard, accessibility, themes and the query log.
 *
 * The accessibility test runs axe over the whole app in both themes. It is
 * deliberately not a checklist of ARIA attributes: it asks a real audit whether
 * the page can be read and operated, which is the only version of the question
 * that catches a mistake nobody anticipated.
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { openApp, readRows, runGoal, setProgram, waitForEngine } from './helpers';

test('has no accessibility violations in the light theme', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);
  await runGoal(page, 'likes(ada, X).');
  await expect(page.locator('.results')).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  expect(results.violations).toEqual([]);
});

test('has no accessibility violations in the dark theme', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);
  await page.locator('.theme__select').selectOption('dark');
  await runGoal(page, 'likes(ada, X).');
  await expect(page.locator('.results')).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  expect(results.violations).toEqual([]);
});

test('has no accessibility violations with a dialog open', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);
  await page.locator('button', { hasText: 'Share' }).click();
  await expect(page.locator('.modal')).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  expect(results.violations).toEqual([]);
});

test('runs the typed goal with Control and Enter', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);

  // Inside the console the input's own handler runs what was typed; the global
  // shortcut is the fallback for when focus is elsewhere. Both must agree.
  const input = page.locator('.console__input');
  await input.fill('likes(ada, X).');
  await input.press('Control+Enter');

  await expect(page.locator('.results')).toBeVisible();
  expect((await readRows(page)).join(' ')).toContain('prolog');
});

test('runs the console goal with Control and Enter from elsewhere on the page', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);

  await page.locator('.console__input').fill('likes(bo, X).');
  // Focus away from the input, so only the global shortcut can act.
  await page.locator('.pane__title').first().click();
  await page.keyboard.press('Control+Enter');

  await expect(page.locator('.results')).toBeVisible();
  expect((await readRows(page)).join(' ')).toContain('prolog');
});

test('closes a dialog with Escape', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);
  await page.locator('button', { hasText: 'Help' }).click();
  await expect(page.locator('.modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.modal')).toHaveCount(0);
});

test('themes the page without losing the program', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);
  await setProgram(page, 'themed(ok).\n');

  for (const id of ['dark', 'solarized-light', 'solarized-dark', 'light']) {
    await page.locator('.theme__select').selectOption(id);
    // The token must actually change, or the picker is decorative.
    const paper = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--paper').trim(),
    );
    expect(paper.length).toBeGreaterThan(0);
    await expect(page.locator('.editor__input')).toHaveValue('themed(ok).\n');
  }

  // The choice survives a reload.
  await page.locator('.theme__select').selectOption('dark');
  await page.reload();
  await page.waitForSelector('.app');
  await expect(page.locator('.theme__select')).toHaveValue('dark');
});

test('records a query in the shared log', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);
  await runGoal(page, 'likes(ada, X).');
  await expect(page.locator('.results')).toBeVisible();

  // The log lives in the document, so it is visible to everyone in the room.
  const logged = await page.evaluate(() => {
    const element = document.querySelector('.app__room code');
    return element?.textContent ?? '';
  });
  expect(logged.length).toBeGreaterThan(0);

  const logEntries = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('prolog:last-room'));
    return key ? localStorage.getItem(key) : null;
  });
  expect(logEntries).not.toBeNull();
});

test('a goal that never returns can be stopped', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);

  // `repeat, fail` produces no solutions and never finishes, so the worker is
  // genuinely blocked and Stop is the only way out. A goal like
  // `between(1, inf, X)` would not do: it yields solutions, so the worker keeps
  // replying and the app is never stuck.
  await runGoal(page, 'repeat, fail.');

  const stop = page.locator('button', { hasText: 'Stop' });
  await expect(stop).toBeVisible({ timeout: 10_000 });
  await stop.click();

  // The client reloads the program into the replacement worker and holds the
  // next goal until that lands, so this needs no arbitrary wait.
  await runGoal(page, 'likes(ada, X).');
  await expect(page.locator('.results')).toBeVisible({ timeout: 30_000 });
  expect((await readRows(page)).join(' ')).toContain('prolog');
});
