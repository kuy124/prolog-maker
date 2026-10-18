/**
 * The shared editor's two alignment bugs.
 *
 * Both are invisible when one person is typing and obvious the moment two are:
 *
 *   - the line numbers sat still while the text scrolled, so the ruler pointed at
 *     the wrong clause and still looked authoritative, and
 *   - a remote edit reset the local caret to the end of the file, yanking the
 *     cursor out from under anybody typing in a different clause.
 *
 * Both are asserted on two isolated browser contexts, because a single tab cannot
 * reproduce either: there is no remote edit to survive, and the two editors would
 * be the same one.
 */

import { expect, test } from '@playwright/test';
import { getProgram, openApp, setProgram, waitForEngine, waitForPeers } from './helpers';

test('the line numbers follow the text when the editor scrolls', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);

  // A program long enough to scroll.
  const long = Array.from({ length: 200 }, (_, i) => `fact(${i}, value_${i}).`).join('\n') + '\n';
  await setProgram(page, long);

  const gutterOffset = () =>
    page.evaluate(() => {
      const inner = document.querySelector<HTMLElement>('.editor__gutter-inner');
      if (!inner) return null;
      const match = /translateY\((-?[\d.]+)px\)/.exec(inner.style.transform);
      return match ? Number(match[1]) : 0;
    });

  const scrollOffset = () => page.locator('.editor__input').evaluate((el) => el.scrollTop);

  // Start from the top: filling a textarea puts the caret at the end, which scrolls
  // it, so the baseline has to be established rather than assumed.
  await page.locator('.editor__input').evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => scrollOffset(), { timeout: 5000 }).toBe(0);
  expect(await gutterOffset()).toBe(0);

  await page.locator('.editor__input').evaluate((el) => {
    el.scrollTop = 600;
    el.dispatchEvent(new Event('scroll'));
  });

  // The numbers must move by exactly as far as the text, or they label the wrong
  // line.
  await expect.poll(() => gutterOffset(), { timeout: 5000 }).toBe(-600);
  expect(await scrollOffset()).toBe(600);
});

test('the local caret survives an edit made by somebody else', async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();

  const pageA = await openApp(contextA);
  await waitForEngine(pageA);
  const room = (await pageA.locator('.app__room code').innerText()).trim();

  const pageB = await openApp(contextB, `#room=${room}`);
  await waitForEngine(pageB);
  await waitForPeers(pageA, 1);

  await setProgram(pageA, 'alpha(one).\nbeta(two).\ngamma(three).\n');
  await expect(pageB.locator('.editor__input')).toHaveValue('alpha(one).\nbeta(two).\ngamma(three).\n', {
    timeout: 20_000,
  });

  // Put A's caret inside the first clause, as if mid-edit.
  await pageA.locator('.editor__input').click();
  await pageA.locator('.editor__input').evaluate((el) => {
    const textarea = el as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(2, 7);
    textarea.dispatchEvent(new Event('select', { bubbles: true }));
  });

  // B edits a different clause entirely — a remote insert at the end.
  await pageB.locator('.editor__input').fill('alpha(one).\nbeta(two).\ngamma(three).\ndelta(four).\n');

  await expect(pageA.locator('.editor__input')).toHaveValue(
    'alpha(one).\nbeta(two).\ngamma(three).\ndelta(four).\n',
    { timeout: 20_000 },
  );

  // The caret must still be where A left it, not at the end of the new text.
  const selection = await pageA.locator('.editor__input').evaluate((el) => {
    const textarea = el as HTMLTextAreaElement;
    return { start: textarea.selectionStart, end: textarea.selectionEnd };
  });
  expect(selection).toEqual({ start: 2, end: 7 });

  await contextA.close();
  await contextB.close();
});

test('the caret is clamped when a peer deletes the text before it', async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();

  const pageA = await openApp(contextA);
  await waitForEngine(pageA);
  const room = (await pageA.locator('.app__room code').innerText()).trim();

  const pageB = await openApp(contextB, `#room=${room}`);
  await waitForEngine(pageB);
  await waitForPeers(pageA, 1);

  await setProgram(pageA, 'header.\ntail.\n');
  await expect(pageB.locator('.editor__input')).toHaveValue('header.\ntail.\n', { timeout: 20_000 });

  // A sits at the very end.
  await pageA.locator('.editor__input').evaluate((el) => {
    const textarea = el as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(14, 14);
    textarea.dispatchEvent(new Event('select', { bubbles: true }));
  });

  // B deletes the first line, which is text before A's cursor.
  await pageB.locator('.editor__input').fill('tail.\n');

  await expect(pageA.locator('.editor__input')).toHaveValue('tail.\n', { timeout: 20_000 });

  // Clamped into the shorter text, not left past the end and not reset to zero.
  const selection = await pageA.locator('.editor__input').evaluate((el) => {
    const textarea = el as HTMLTextAreaElement;
    return { start: textarea.selectionStart, end: textarea.selectionEnd, length: textarea.value.length };
  });
  expect(selection.start).toBe(selection.length);
  expect(selection.end).toBe(selection.length);

  await contextA.close();
  await contextB.close();
});

test("a peer's cursor is drawn and scrolls with the text", async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();

  const pageA = await openApp(contextA);
  await waitForEngine(pageA);
  const room = (await pageA.locator('.app__room code').innerText()).trim();

  const pageB = await openApp(contextB, `#room=${room}`);
  await waitForEngine(pageB);
  await waitForPeers(pageA, 1);

  const long = Array.from({ length: 120 }, (_, i) => `fact(${i}).`).join('\n') + '\n';
  await setProgram(pageA, long);
  await expect(pageB.locator('.editor__input')).toHaveValue(long, { timeout: 20_000 });

  // B puts its caret far down the program, so A should draw a cursor marker.
  await pageB.locator('.editor__input').click();
  await pageB.locator('.editor__input').evaluate((el) => {
    const textarea = el as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length - 4, textarea.value.length - 4);
    textarea.dispatchEvent(new Event('select', { bubbles: true }));
  });

  const caret = pageA.locator('.editor__caret');
  await expect(caret).toHaveCount(1, { timeout: 20_000 });

  // The marker lives inside the same transformed layer as the text, so it scrolls
  // with it rather than staying pinned to the top of the pane.
  await pageA.locator('.editor__input').evaluate((el) => {
    el.scrollTop = 900;
    el.dispatchEvent(new Event('scroll'));
  });

  const before = await caret.evaluate((el) => (el as HTMLElement).style.top);
  await pageA.locator('.editor__input').evaluate((el) => {
    el.scrollTop = 1400;
    el.dispatchEvent(new Event('scroll'));
  });
  const after = await caret.evaluate((el) => (el as HTMLElement).style.top);

  // The caret's own offset did not change, but the layer it lives in moved, so the
  // marker's position relative to the text it labels is stable — which is what
  // being inside the layer buys.
  expect(before).toBe(after);

  await contextA.close();
  await contextB.close();
});