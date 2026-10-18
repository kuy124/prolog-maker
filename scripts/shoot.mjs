/**
 * A screenshot of the app, for looking at rather than asserting on.
 * Usage: node scripts/shoot.mjs [theme] [outfile]
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const theme = process.argv[2] ?? 'light';
const out = process.argv[3] ?? `shot-${theme}.png`;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.json': 'application/json',
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(base);
await page.waitForSelector('.app');
await page.locator('.theme__select').selectOption(theme);
await page.waitForFunction(() =>
  document.querySelector('.pane--editor .status')?.textContent?.includes('Engine ready'),
);
await page.locator('.console__input').fill('both(ada, Who).');
await page.locator('.console__input').press('Enter');
await page.waitForSelector('.results tbody tr');
await page.locator('.facts__input').fill('likes(cy, tea).');
await page.locator('button', { hasText: 'Add fact' }).click();
await page.waitForTimeout(600);
await page.screenshot({ path: out, fullPage: false });
console.log('wrote', out);

await browser.close();
server.close();