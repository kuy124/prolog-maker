/**
 * Renders the favicon.
 *
 * The mark is the Prolog prompt, `?-`, on a filled `--signal` tile with
 * `--on-signal` ink — the same pairing the app's own brand tile uses and the same
 * one `tests/unit/theme.test.ts` holds to 4.5:1, so the icon cannot drift away
 * from the palette or become unreadable.
 *
 * It is drawn as geometry rather than set in the monospace font on purpose. A tab
 * icon is rasterised at 16px, where the font would have to be hinted by whichever
 * machine rendered it; two stroked paths and a dot render identically everywhere.
 *
 * Usage: node scripts/make-icon.mjs
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'public');

/**
 * Light palette `--signal` and `--on-signal`, from `src/ui/theme.ts`.
 *
 * Hard-coded because an icon is a raster: it cannot read a CSS variable. The
 * theme test is what keeps these two in step with the palette.
 */
const SIGNAL = '#0f7b8a';
const ON_SIGNAL = '#fbfcfb';

/**
 * The mark, in a 64-unit box.
 *
 * Sized for 16px first: the dash and the question mark are separated by a gap
 * wide enough to survive a 1-in-4 downscale, and the hook is open enough that it
 * does not fill in. Anything finer reads as a smudge at tab size, which is the
 * only size that matters.
 */
const mark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Prolog Room">
  <rect width="64" height="64" rx="14" fill="${SIGNAL}"/>
  <g fill="none" stroke="${ON_SIGNAL}" stroke-width="9" stroke-linecap="round">
    <path d="M14 32h9"/>
    <path d="M30 23a9 9 0 0 1 18 0c0 6.5-9 7.5-9 13"/>
  </g>
  <circle cx="39" cy="45" r="4.8" fill="${ON_SIGNAL}"/>
</svg>
`;

const browser = await chromium.launch();
const page = await browser.newPage();

/** Rasterises the mark at a square size, with a transparent surround. */
async function render(size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}
     svg{display:block;width:${size}px;height:${size}px}</style>${mark}`,
  );
  return page.screenshot({ omitBackground: true, type: 'png' });
}

await mkdir(outDir, { recursive: true });

// The vector is the source of truth: a browser that prefers it gets a crisp icon
// at any density, including the 32px a bookmark bar or a pinned tab asks for.
await writeFile(join(outDir, 'icon.svg'), mark);

for (const size of [16, 32, 180, 192, 512]) {
  const png = await render(size);
  const name = size === 180 ? 'apple-touch-icon.png' : `icon-${size}.png`;
  await writeFile(join(outDir, name), png);
  console.log(`${name}  ${size}x${size}  ${png.length} bytes`);
}

await browser.close();
