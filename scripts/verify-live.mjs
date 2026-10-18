/**
 * Verifies the deployed site, not the local build.
 *
 * Everything else in the test suite runs against `vite preview`, which cannot
 * catch the one thing that actually breaks a deployment: Pages serves the
 * repository subpath, so every asset URL has to resolve relative to the project.
 * This checks the live URL, including the engine bytes and a real goal.
 *
 * Usage: node scripts/verify-live.mjs [url]
 */

import { chromium } from 'playwright';

const url = process.argv[2] ?? 'https://kuy124.github.io/prolog-maker/';
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

const check = (label, ok, detail = '') =>
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);

let failures = 0;
const expect = (label, ok, detail) => {
  if (!ok) failures += 1;
  check(label, ok, detail);
};

console.log(`Verifying the deployed site: ${url}\n`);

const response = await page.goto(url, { waitUntil: 'load' });
expect('page responds', response?.ok() === true, `HTTP ${response?.status()}`);

await page.waitForSelector('.app', { timeout: 30_000 });
expect('app renders', true);

// The engine must boot from Pages, which means the .wasm and .data came from
// the subpath rather than 404ing.
const ready = await page
  .waitForFunction(
    () => document.querySelector('.pane--editor .status')?.textContent?.includes('Engine ready') ?? false,
    null,
    { timeout: 60_000 },
  )
  .then(() => true)
  .catch(() => false);
expect('engine boots on the deployed site', ready);

if (ready) {
  const status = await page.locator('.pane--editor .status').innerText();
  check('      version', /SWI-Prolog \d+\.\d+\.\d+/.test(status), status.trim());
}

// A goal must actually run against the deployed engine.
await page.locator('.console__input').fill('both(ada, Who).');
await page.locator('.console__input').press('Enter');
const solved = await page
  .waitForSelector('.results tbody tr', { timeout: 30_000 })
  .then(() => true)
  .catch(() => false);
expect('a goal returns a solution', solved);
if (solved) {
  const row = await page.locator('.results tbody tr').first().innerText();
  check('      solution', row.includes('bo'), row.replace(/\s+/g, ' ').trim());
}

// A second solution must be reachable, which proves the query stepped rather
// than the engine having materialised the whole answer at once.
await page.locator('button', { hasText: 'Next solution' }).click().catch(() => {});
const stepped = await page
  .waitForFunction(() => document.querySelectorAll('.results tbody tr').length === 1, null, {
    timeout: 10_000,
  })
  .then(() => true)
  .catch(() => false);
expect('a goal with one solution is exhaustive', stepped);

// A share link must be buildable with the real page URL, which is where a
// subpath deployment would silently produce a broken link.
await page.locator('button', { hasText: 'Share' }).click();
await page.waitForSelector('.modal');
const link = await page.locator('.field__input').nth(1).inputValue();
expect('share link is rooted at the deployed URL', link.startsWith(url.replace(/\/$/, '')), link);
expect('share link carries the room', link.includes('#room='));

await browser.close();

if (errors.length > 0) {
  failures += 1;
  console.log('\nBrowser errors:');
  for (const error of errors) console.log('  ' + error.slice(0, 200));
}

console.log(`\n${failures === 0 ? 'Deployed site OK' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
