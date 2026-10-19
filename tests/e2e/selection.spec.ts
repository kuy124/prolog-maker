/**
 * Selecting code must leave it readable.
 *
 * The editor is a `<textarea>` layered over a syntax-highlighted `<pre>`. The
 * textarea holds the text and all the native behaviour; the `<pre>` behind it is
 * what actually draws the glyphs, so the textarea's own text is transparent.
 *
 * That arrangement has one failure mode, and it was live: the textarea's
 * selection background is painted *above* the `<pre>`, so an opaque tint there
 * does not tint the code — it hides it. Selecting a block turned it into a solid
 * bar of `--signal-soft` with nothing legible in it, which is precisely the
 * moment somebody is most likely to be copying code.
 *
 * The fix draws the selected run from the textarea itself, in `--ink`, on the
 * tint. These tests hold that: the colour must be real ink rather than
 * transparent, and it must clear 4.5:1 against the tint in every theme.
 */

import { expect, test } from '@playwright/test';
import { openApp, waitForEngine } from './helpers';

test('selected code is drawn in ink, not left transparent', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);

  const selection = await page.evaluate(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>('.editor__input')!;
    textarea.focus();
    textarea.setSelectionRange(0, 120);
    const style = getComputedStyle(textarea, '::selection');
    return { color: style.color, background: style.backgroundColor };
  });

  // `color: transparent` was the bug: the textarea paints the selection rectangle
  // over the highlight layer, so a transparent glyph leaves only the rectangle.
  expect(selection.color).not.toBe('rgba(0, 0, 0, 0)');
  expect(selection.color).not.toBe('transparent');
  expect(selection.background).not.toBe('rgba(0, 0, 0, 0)');
});

test('selected code clears 4.5:1 in every theme', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);

  const results = await page.evaluate(async () => {
    const luminance = (hex: string) => {
      const clean = hex.replace('#', '');
      const channels = [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16) / 255);
      const linear = channels.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
    };
    const contrast = (a: string, b: string) => {
      const la = luminance(a);
      const lb = luminance(b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };

    // Read the selection colours as the browser resolved them, so this tests what
    // is painted rather than what the stylesheet was expected to say.
    const textarea = document.querySelector<HTMLTextAreaElement>('.editor__input')!;
    textarea.focus();
    textarea.setSelectionRange(0, 120);
    const selection = getComputedStyle(textarea, '::selection');

    const rgbToHex = (rgb: string) => {
      const parts = rgb.match(/\d+/g) ?? [];
      return `#${parts
        .slice(0, 3)
        .map((n) => Number(n).toString(16).padStart(2, '0'))
        .join('')}`;
    };

    const ink = rgbToHex(selection.color);
    const tint = rgbToHex(selection.backgroundColor);

    const out: { theme: string; ratio: number }[] = [];
    const select = document.querySelector<HTMLSelectElement>('.theme__select')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    for (const id of ['light', 'dark', 'solarized-light', 'solarized-dark']) {
      setter.call(select, id);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const style = getComputedStyle(textarea, '::selection');
      out.push({
        theme: id,
        ratio: contrast(rgbToHex(style.color), rgbToHex(style.backgroundColor)),
      });
    }

    return { out, ink, tint };
  });

  // The tokens themselves resolved to real colours, not an inherited transparent.
  expect(results.ink).toMatch(/^#[0-9a-f]{6}$/);
  expect(results.tint).toMatch(/^#[0-9a-f]{6}$/);

  for (const { theme, ratio } of results.out) {
    expect(ratio, `${theme} selected code`).toBeGreaterThanOrEqual(4.5);
  }
});
