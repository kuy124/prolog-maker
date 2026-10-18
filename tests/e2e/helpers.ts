/**
 * Shared helpers for the browser tests.
 *
 * The app talks to a local signalling server, so a test that involves two peers
 * must point both at it before the page runs. `__PROLOG_SIGNALING__` is read at
 * room-creation time, which is why it is installed as an init script rather than
 * after navigation.
 */

import type { BrowserContext, Page } from '@playwright/test';

export const SIGNALING = 'ws://127.0.0.1:4444';

/** Opens the app in a fresh context, wired to the local signalling server. */
export async function openApp(
  context: BrowserContext,
  hash = '',
): Promise<Page> {
  await context.addInitScript((signaling) => {
    (window as unknown as { __PROLOG_SIGNALING__: string[] }).__PROLOG_SIGNALING__ = [signaling];
  }, SIGNALING);

  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  (page as unknown as { __errors: string[] }).__errors = errors;

  await page.goto(hash ? `/${hash}` : '/');
  await page.waitForSelector('.app');
  return page;
}

/** Waits until the engine has booted and reports ready. */
export async function waitForEngine(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const status = document.querySelector('.pane--editor .status');
    return status?.textContent?.includes('Engine ready') ?? false;
  });
}

/** Types a goal into the console and runs it. */
export async function runGoal(page: Page, goal: string): Promise<void> {
  const input = page.locator('.console__input');
  await input.fill(goal);
  await input.press('Enter');
}

/** Reads the solution rows as text, one string per row. */
export async function readRows(page: Page): Promise<string[]> {
  const rows = page.locator('.results tbody tr');
  const count = await rows.count();
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push((await rows.nth(i).innerText()).replace(/\s+/g, ' ').trim());
  }
  return out;
}

/** The engine's own output pane, which is where `write/1` lands. */
export async function readOutput(page: Page): Promise<string> {
  const output = page.locator('.terminal__text');
  if ((await output.count()) === 0) return '';
  return (await output.innerText()).trim();
}

/** Replaces the whole program through the editor. */
export async function setProgram(page: Page, source: string): Promise<void> {
  const editor = page.locator('.editor__input');
  await editor.fill(source);
  // The editor debounces its consult; give it room to settle.
  await page.waitForTimeout(700);
}

export async function getProgram(page: Page): Promise<string> {
  return page.locator('.editor__input').inputValue();
}

/** Waits for the presence bar to report a given number of people. */
export async function waitForPeers(page: Page, count: number): Promise<void> {
  await page.waitForFunction(
    (expected) => {
      const avatars = document.querySelectorAll('.presence__peer');
      return avatars.length >= expected;
    },
    count,
  );
}

/** The page errors collected for a page, for asserting a clean run. */
export function pageErrors(page: Page): string[] {
  return (page as unknown as { __errors: string[] }).__errors ?? [];
}
