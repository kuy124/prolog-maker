/**
 * Smoke: the app loads, the engine boots, and a goal returns a solution.
 *
 * This is the test that would have caught every integration mistake made while
 * building this: a worker that cannot load the engine, a `locateFile` that
 * resolves the wrong directory, a term decoder that produces `[object Object]`.
 */

import { expect, test } from '@playwright/test';
import { openApp, pageErrors, readOutput, readRows, runGoal, waitForEngine } from './helpers';

test('boots the engine and answers a goal', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);

  await runGoal(page, 'both(ada, Who).');
  await expect(page.locator('.results')).toBeVisible();

  const rows = await readRows(page);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.join('\n')).toContain('bo');
  expect(pageErrors(page)).toEqual([]);
});

test('shows the SWI-Prolog version it is running', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);
  // The status line carries the version, so a wrong or missing engine is visible.
  const status = await page.locator('.pane--editor .status').innerText();
  expect(status).toMatch(/SWI-Prolog \d+\.\d+\.\d+/);
});

test('enumerates solutions one step at a time', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);

  await runGoal(page, 'likes(ada, X).');
  await expect(page.locator('.results tbody tr')).toHaveCount(1);

  await page.locator('button', { hasText: 'Next solution' }).click();
  await expect(page.locator('.results tbody tr')).toHaveCount(2);

  // The goal is exhausted, so Next is gone and the count says so.
  await expect(page.locator('button', { hasText: 'Next solution' })).toHaveCount(0);
  await expect(page.locator('.console__count')).toContainText('2 solutions');
});

test('reports no solutions for a goal that fails', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);

  await runGoal(page, 'likes(zed, X).');
  await expect(page.locator('.note', { hasText: 'No solutions' })).toBeVisible();
});

test('shows the output of write/1', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);

  await runGoal(page, 'write(hello), nl.');
  await expect(page.locator('.terminal__text')).toContainText('hello');
  expect(await readOutput(page)).toContain('hello');
});

test('reports an unknown procedure as an error, not as no solutions', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);

  await runGoal(page, 'nope(1).');
  await expect(page.locator('.note--error')).toBeVisible();
  await expect(page.locator('.note--error')).toContainText('Unknown procedure');
});

test('reports a syntax error with its line and keeps the old program', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);

  // Break the program.
  const editor = page.locator('.editor__input');
  await editor.fill('good(1).\nbroken(.\n');
  await page.waitForTimeout(800);

  await expect(page.locator('.pane--editor .status--error')).toContainText('Line 2');

  // The previous program is still loaded and still answers.
  await runGoal(page, 'both(ada, Who).');
  await expect(page.locator('.results tbody tr')).not.toHaveCount(0);
});
