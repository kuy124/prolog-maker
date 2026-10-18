/**
 * Collaboration: two browsers, one room.
 *
 * These are the tests that prove the peer-to-peer path actually works, rather
 * than that the wiring looks plausible. Each uses two browser *contexts*, which
 * are fully isolated — separate IndexedDB, separate storage, separate
 * BroadcastChannel — so the only way the two can see each other is WebRTC through
 * the local signalling server.
 *
 * That isolation is the whole point. Two tabs in one context would sync over
 * BroadcastChannel and pass even if WebRTC were broken entirely.
 */

import { expect, test } from '@playwright/test';
import { getProgram, openApp, pageErrors, readRows, runGoal, setProgram, waitForEngine, waitForPeers } from './helpers';

/** Joins an existing room by its hash, in a second isolated context. */
async function joinRoom(context: Parameters<typeof openApp>[0], room: string) {
  return openApp(context, `#room=${room}`);
}

/** Reads the room code the app generated for itself. */
async function roomCode(page: import('@playwright/test').Page): Promise<string> {
  const text = await page.locator('.app__room code').innerText();
  return text.trim();
}

test('two browsers connect and see each other', async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();

  const pageA = await openApp(contextA);
  await waitForEngine(pageA);
  const room = await roomCode(pageA);

  const pageB = await joinRoom(contextB, room);
  await waitForEngine(pageB);

  // Presence proves the WebRTC connection, not just that both pages loaded.
  await waitForPeers(pageA, 1);
  await waitForPeers(pageB, 1);

  expect(pageErrors(pageA)).toEqual([]);
  expect(pageErrors(pageB)).toEqual([]);

  await contextA.close();
  await contextB.close();
});

test('an edit in one browser appears in the other', async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();

  const pageA = await openApp(contextA);
  await waitForEngine(pageA);
  const room = await roomCode(pageA);

  const pageB = await joinRoom(contextB, room);
  await waitForEngine(pageB);
  await waitForPeers(pageA, 1);

  const edit = 'from_the_other_browser(ok).\n';
  await setProgram(pageB, edit);

  // The receiving side must show it, and must be able to run it.
  await expect(pageA.locator('.editor__input')).toHaveValue(edit, { timeout: 20_000 });
  await runGoal(pageA, 'from_the_other_browser(X).');
  await expect(pageA.locator('.results')).toBeVisible();
  expect((await readRows(pageA)).join(' ')).toContain('ok');

  await contextA.close();
  await contextB.close();
});

test('concurrent typing in different places merges without losing either edit', async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();

  const pageA = await openApp(contextA);
  await waitForEngine(pageA);
  const room = await roomCode(pageA);

  const pageB = await joinRoom(contextB, room);
  await waitForEngine(pageB);
  await waitForPeers(pageA, 1);

  await setProgram(pageA, 'base.\n');
  await expect(pageB.locator('.editor__input')).toHaveValue('base.\n', { timeout: 20_000 });

  // Both append at the end, at the same time. Yjs must keep both.
  await Promise.all([
    pageA.locator('.editor__input').press('End'),
    pageB.locator('.editor__input').press('End'),
  ]);
  await pageA.locator('.editor__input').press('Control+End');
  await pageB.locator('.editor__input').press('Control+End');
  await pageA.locator('.editor__input').type('from_a.\n');
  await pageB.locator('.editor__input').type('from_b.\n');

  await expect
    .poll(async () => (await getProgram(pageA)) === (await getProgram(pageB)), { timeout: 20_000 })
    .toBe(true);

  const merged = await getProgram(pageA);
  expect(merged).toContain('from_a');
  expect(merged).toContain('from_b');
  expect(merged).toContain('base');

  await contextA.close();
  await contextB.close();
});

test('a fact added in one browser is usable in the other', async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();

  const pageA = await openApp(contextA);
  await waitForEngine(pageA);
  const room = await roomCode(pageA);

  const pageB = await joinRoom(contextB, room);
  await waitForEngine(pageB);
  await waitForPeers(pageA, 1);

  await setProgram(pageA, 'greets(X) :- person(X), friendly(X).\n');
  await expect(pageB.locator('.editor__input')).toContainText('greets', { timeout: 20_000 });

  // Add both facts on B; A must receive them and be able to use them.
  await pageB.locator('.facts__input').fill('person(ada)');
  await pageB.locator('button', { hasText: 'Add fact' }).click();
  await pageB.locator('.facts__input').fill('friendly(ada)');
  await pageB.locator('button', { hasText: 'Add fact' }).click();

  await expect(pageA.locator('.facts__list')).toContainText('person(ada)', { timeout: 20_000 });
  await expect(pageA.locator('.facts__list')).toContainText('friendly(ada)');

  // The receiving peer must assert them into its own engine.
  await pageA.waitForTimeout(1200);
  await runGoal(pageA, 'greets(X).');
  await expect(pageA.locator('.results')).toBeVisible();
  expect((await readRows(pageA)).join(' ')).toContain('ada');

  await contextA.close();
  await contextB.close();
});

test('a shared snapshot link opens the program with nobody online', async ({ browser }) => {
  const contextA = await browser.newContext();
  const pageA = await openApp(contextA);
  await waitForEngine(pageA);

  await setProgram(pageA, 'offline_copy(here).\n');
  await pageA.locator('button', { hasText: 'Share' }).click();
  await pageA.locator('.field--check input').check();

  const link = await pageA.locator('.field__input').nth(1).inputValue();
  expect(link).toContain('#room=');
  expect(link).toContain('&d=');

  // A fresh context with no other peer anywhere.
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  await pageB.goto(link);
  await pageB.waitForSelector('.app');
  await waitForEngine(pageB);

  await expect(pageB.locator('.editor__input')).toHaveValue('offline_copy(here).\n', { timeout: 20_000 });
  await runGoal(pageB, 'offline_copy(X).');
  await expect(pageB.locator('.results')).toBeVisible();
  expect((await readRows(pageB)).join(' ')).toContain('here');

  await contextA.close();
  await contextB.close();
});

test('a reload keeps the program without any peer', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await openApp(context);
  await waitForEngine(page);

  await setProgram(page, 'persisted(ok).\n');
  await page.waitForTimeout(600);

  await page.reload();
  await page.waitForSelector('.app');
  await waitForEngine(page);

  // IndexedDB, not the network: nobody else is online.
  await expect(page.locator('.editor__input')).toHaveValue('persisted(ok).\n', { timeout: 20_000 });

  await context.close();
});
