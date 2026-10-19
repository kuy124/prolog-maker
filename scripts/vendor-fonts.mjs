/**
 * Copies the two IBM Plex faces the app uses into `public/fonts/`.
 *
 * The stylesheet names IBM Plex Sans and IBM Plex Mono, and until now nothing ever
 * loaded them: there was no `@font-face`, so every browser silently rendered a
 * fallback. That is invisible on a machine that happens to have Plex installed and
 * everywhere else it is a different design — and, because the editor draws remote
 * carets from a hard-coded character width, a fallback also put every caret in the
 * wrong column.
 *
 * The files are copied out of `@fontsource` rather than fetched from a font CDN.
 * The app is a static site that promises to work offline and to make no
 * third-party request, and a blocked CDN would otherwise take the type with it.
 * Only the latin subsets are taken: the app is English, and shipping Cyrillic and
 * Greek would multiply the download for glyphs nothing renders.
 *
 * Usage: node scripts/vendor-fonts.mjs
 */
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'public', 'fonts');

/** The faces the stylesheet actually asks for. Anything else is not shipped. */
const WANTED = [
  ['ibm-plex-sans', 'ibm-plex-sans-latin-400-normal.woff2'],
  ['ibm-plex-sans', 'ibm-plex-sans-latin-600-normal.woff2'],
  ['ibm-plex-mono', 'ibm-plex-mono-latin-400-normal.woff2'],
  ['ibm-plex-mono', 'ibm-plex-mono-latin-600-normal.woff2'],
  // The editor sets comments in italic, so this one is load-bearing rather than
  // decorative: without it the browser synthesises an oblique from the upright.
  ['ibm-plex-mono', 'ibm-plex-mono-latin-400-italic.woff2'],
];

await mkdir(outDir, { recursive: true });

for (const [pkg, file] of WANTED) {
  const from = join(root, 'node_modules', '@fontsource', pkg, 'files', file);
  const to = join(outDir, file);
  await copyFile(from, to);
  const { size } = await stat(to);
  console.log(`${file}  ${(size / 1024).toFixed(1)} KB`);
}

const total = (await readdir(outDir)).length;
console.log(`\n${total} faces in public/fonts`);
