/**
 * The blocked-font check.
 *
 * The reported failure was text you cannot read when the font is blocked. Two
 * things could cause it and this distinguishes them:
 *
 *   1. `font-display: block` — the browser hides text until the font resolves, and
 *      forever if it never does. This is the real "can't see anything".
 *   2. A font that silently falls back — text is readable, but the design is not
 *      what was intended, and (before this was fixed) remote carets were placed
 *      from metrics that assumed the missing font.
 *
 * Usage: node scripts/check-blocked-font.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname === '/' ? '/index.html' : url.pathname;
  try {
    const body = await readFile(join(root, 'dist', decodeURIComponent(path)));
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const results = [];

for (const block of [false, true]) {
  const context = await browser.newContext();
  const page = await context.newPage();

  let blocked = 0;
  if (block) {
    // Abort every font request, which is what a blocked CDN or an offline cache
    // miss looks like to the page.
    await page.route('**/*.woff2', (route) => {
      blocked += 1;
      route.abort();
    });
  }

  await page.goto(base);
  await page.waitForSelector('.app');
  await page.waitForTimeout(1500);

  const report = await page.evaluate(async () => {
    await document.fonts.ready;
    const editor = document.querySelector('.editor__input');
    const style = getComputedStyle(editor);

    // Is the text actually painted? Measure the rendered line box rather than
    // trusting that a value exists.
    const rect = editor.getBoundingClientRect();
    const lineHeight = Number.parseFloat(style.lineHeight);

    const probe = document.createElement('span');
    probe.style.cssText =
      'position:absolute;visibility:hidden;white-space:pre;' +
      `font-family:${style.fontFamily};font-size:${style.fontSize}`;
    probe.textContent = '0'.repeat(200);
    document.body.appendChild(probe);
    const charWidth = probe.getBoundingClientRect().width / 200;
    probe.remove();

    return {
      // `color: transparent` is deliberate in this editor — the highlight layer
      // paints the glyphs. So readability is checked on that layer.
      highlightVisible: !!document.querySelector('.editor__highlight')?.textContent?.trim(),
      highlightColor: getComputedStyle(document.querySelector('.editor__highlight')).color,
      editorHeight: Math.round(rect.height),
      lineHeight,
      charWidth: Math.round(charWidth * 1000) / 1000,
      fontStatus: [...document.fonts].map((f) => f.status),
      resolvedFamily: style.fontFamily.split(',')[0].replace(/"/g, ''),
    };
  });

  await page.screenshot({ path: `blocked-font-${block ? 'blocked' : 'normal'}.png` });
  results.push({ block, blockedRequests: blocked, ...report });
  await context.close();
}

await browser.close();
server.close();

console.log(JSON.stringify(results, null, 2));
