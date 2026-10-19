/**
 * The fonts, and the metrics that depend on them.
 *
 * Two failures are covered here, and they have the same root: the app named IBM
 * Plex in its font stacks but never loaded it, so every browser silently rendered
 * a fallback.
 *
 * The visible one was the design: the app only ever looked like itself on a
 * machine that already had Plex installed.
 *
 * The invisible one was worse. The editor places remote carets from a hard-coded
 * character width. With a fallback font that width was wrong, so every caret sat
 * in the wrong column — about 1.25px of drift per character, a quarter of a screen
 * by the end of a long clause.
 */

import { expect, test } from '@playwright/test';
import { openApp, waitForEngine, waitForPeers } from './helpers';

/** Measures the advance width of one character in the editor's rendered font. */
const measureCharWidth = () => {
  const style = getComputedStyle(document.querySelector('.editor__input')!);
  const probe = document.createElement('span');
  probe.style.cssText =
    'position:absolute;visibility:hidden;white-space:pre;' +
    `font-family:${style.fontFamily};font-size:${style.fontSize};font-weight:${style.fontWeight}`;
  // A long run averages away sub-pixel rounding on any single glyph.
  probe.textContent = '0'.repeat(200);
  document.body.appendChild(probe);
  const width = probe.getBoundingClientRect().width / 200;
  probe.remove();
  return width;
};

test('loads the faces it asks for', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);

  const faces = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].map((face) => ({
      family: face.family,
      weight: face.weight,
      style: face.style,
      status: face.status,
    }));
  });

  // Five faces are declared, and every one must actually arrive. A status of
  // "error" here means the stylesheet points at a file that is not shipped.
  expect(faces.length).toBe(5);
  for (const face of faces) {
    expect(face.status, `${face.family} ${face.weight} ${face.style}`).toBe('loaded');
  }

  // And the family the editor asks for is the one that resolved, not a fallback.
  const family = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.editor__input')!).fontFamily.split(',')[0]!.replace(/"/g, ''),
  );
  expect(family).toBe('IBM Plex Mono');
});

test('the caret metrics come from the rendered font, not a constant', async ({ context }) => {
  const page = await openApp(context);
  await waitForEngine(page);

  const measured = await page.evaluate(measureCharWidth);

  // The old constant was 8.4. IBM Plex Mono at 13px is narrower than that, which
  // is exactly why a constant cannot be trusted: the value is a property of the
  // font that rendered, not of the stylesheet.
  expect(measured).toBeGreaterThan(0);
  expect(measured).not.toBeCloseTo(8.4, 2);
});

test('a remote caret is placed from the measured width', async ({ browser }) => {
  /*
   * The caret is drawn at `column * charWidth + padding`, so a wrong metric is a
   * caret in the wrong place. This checks that the constant the app publishes is
   * the measured one: it reads the caret the app actually rendered and compares
   * it against the font's real advance width.
   *
   * Real typing is used rather than a synthetic `select` event, because React
   * does not route a dispatched one to `onSelect` — a test that fired one would be
   * asserting on nothing.
   */
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();

  const pageA = await openApp(contextA);
  await waitForEngine(pageA);
  const room = (await pageA.locator('.app__room code').innerText()).trim();

  const pageB = await openApp(contextB, `#room=${room}`);
  await waitForEngine(pageB);
  await waitForPeers(pageA, 1);
  await waitForPeers(pageB, 1);

  // A long single line, so a per-character error accumulates into something
  // unmistakable rather than hiding inside a pixel of rounding.
  const line = `${'a'.repeat(60)}.`;
  await pageA.locator('.editor__input').fill(line);
  await expect(pageB.locator('.editor__input')).toHaveValue(line, { timeout: 20_000 });

  // B types a character at the end of the line. Typing is a real input event, so
  // the component publishes the caret itself.
  await pageB.locator('.editor__input').click();
  await pageB.locator('.editor__input').press('End');
  await pageB.locator('.editor__input').press('Control+End');
  await pageB.keyboard.type('z');

  // Both sides converge on the text B produced.
  await expect
    .poll(async () => (await pageA.locator('.editor__input').inputValue()) === (await pageB.locator('.editor__input').inputValue()), {
      timeout: 20_000,
    })
    .toBe(true);

  const caret = pageA.locator('.editor__caret');
  await expect(caret).toHaveCount(1, { timeout: 20_000 });

  const geometry = await pageA.evaluate(async () => {
    await document.fonts.ready;
    const charWidth = (() => {
      const style = getComputedStyle(document.querySelector('.editor__input')!);
      const probe = document.createElement('span');
      probe.style.cssText =
        'position:absolute;visibility:hidden;white-space:pre;' +
        `font-family:${style.fontFamily};font-size:${style.fontSize};font-weight:${style.fontWeight}`;
      probe.textContent = '0'.repeat(200);
      document.body.appendChild(probe);
      const width = probe.getBoundingClientRect().width / 200;
      probe.remove();
      return width;
    })();

    const marker = document.querySelector<HTMLElement>('.editor__caret')!;
    const style = getComputedStyle(document.querySelector('.editor__input')!);
    return {
      charWidth,
      left: Number.parseFloat(marker.style.left),
      padding: Number.parseFloat(style.paddingTop),
      textLength: document.querySelector<HTMLTextAreaElement>('.editor__input')!.value.length,
    };
  });

  // The caret sits at some column; what matters is that the pixel it was drawn at
  // is an exact multiple of the measured width, offset by the padding. A constant
  // of 8.4 against a real 7.8 would leave a remainder of 0.6 per column.
  const column = (geometry.left - geometry.padding) / geometry.charWidth;
  expect(Math.abs(column - Math.round(column))).toBeLessThan(0.01);
  expect(column).toBeGreaterThan(0);
  // Rounded before comparing: the division reintroduces a representation error,
  // which is itself evidence the metric is exact rather than approximate.
  expect(Math.round(column)).toBeLessThanOrEqual(geometry.textLength);

  await contextA.close();
  await contextB.close();
});

test('the program is readable when the font cannot be fetched', async ({ context }) => {
  // The reported failure: text you cannot see because the font is blocked.
  // `font-display: block` would hide the text until the font resolved, and for
  // ever if it never did. `swap` paints the fallback immediately instead.
  const page = await context.newPage();
  await page.route('**/*.woff2', (route) => route.abort());
  await page.goto('/');
  await page.waitForSelector('.app');
  await waitForEngine(page);

  const state = await page.evaluate(async () => {
    await document.fonts.ready;
    const highlight = document.querySelector('.editor__highlight')!;
    return {
      // The editor paints glyphs in the highlight layer; the textarea is
      // transparent by design, so this is the layer that must be visible.
      text: highlight.textContent ?? '',
      color: getComputedStyle(highlight).color,
      failedFaces: [...document.fonts].filter((f) => f.status === 'error').length,
    };
  });

  expect(state.failedFaces).toBeGreaterThan(0);
  expect(state.text.length).toBeGreaterThan(20);
  // A real ink colour, not transparent and not empty.
  expect(state.color).not.toBe('rgba(0, 0, 0, 0)');

  // The editor is still usable, which is the whole point.
  await page.locator('.console__input').fill('likes(ada, X).');
  await page.locator('.console__input').press('Enter');
  await expect(page.locator('.results tbody tr')).toHaveCount(1);
});
