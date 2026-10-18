/**
 * Copies the SWI-Prolog WebAssembly build into `public/engine/`.
 *
 * The engine is vendored rather than loaded from a CDN for three reasons:
 *
 *   1. GitHub Pages serves the files from the same origin, so there is no
 *      third-party request on startup and no CORS configuration to get wrong.
 *   2. The bytes are pinned by `package-lock.json`. A CDN can serve a different
 *      build tomorrow; `npm ci` cannot.
 *   3. `swipl-web.wasm` must be served as `application/wasm` for streaming
 *      instantiation. Pages does that for the correct extension; a CDN
 *      redirect might not.
 *
 * The three-file build (`.js`, `.wasm`, `.data`) is copied instead of the
 * single-file `swipl-bundle.js` (6.3 MB) because the bundle gives up streaming
 * compilation and cannot be cached per-file.
 *
 * Run automatically by `prebuild`, and by `npm run vendor` when developing.
 */

import { copyFile, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'public', 'engine');

const FILES = ['swipl-web.js', 'swipl-web.wasm', 'swipl-web.data'];

/** Resolves the installed `swipl-wasm` package directory. */
function packageDir() {
  const entry = require.resolve('swipl-wasm/package.json');
  return dirname(entry);
}

async function main() {
  const pkg = packageDir();
  const source = join(pkg, 'dist', 'swipl');
  await mkdir(outDir, { recursive: true });

  const copied = [];
  for (const name of FILES) {
    const from = join(source, name);
    const to = join(outDir, name);
    await copyFile(from, to);
    const { size } = await stat(to);
    copied.push({ name, size });
  }

  // A version stamp makes it obvious in the browser which build is deployed,
  // and lets the app show it in Help without shipping a second copy of the
  // version number.
  const { version } = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
  await writeFile(
    join(outDir, 'version.json'),
    JSON.stringify({ package: 'swipl-wasm', version }, null, 2) + '\n',
    'utf8',
  );

  const total = copied.reduce((sum, file) => sum + file.size, 0);
  console.log(`engine: swipl-wasm@${version} -> public/engine (${(total / 1e6).toFixed(1)} MB)`);
  for (const file of copied) {
    console.log(`  ${file.name.padEnd(16)} ${(file.size / 1e6).toFixed(2)} MB`);
  }
}

await main();
