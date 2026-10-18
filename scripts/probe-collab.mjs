/**
 * Collaboration connectivity probe.
 *
 * Checks, against real infrastructure, that two isolated browser contexts can
 * find each other through a signalling server and converge on one document. This
 * is the only check that distinguishes a y-webrtc *signalling* server from a
 * y-websocket one, which is the mistake that fails silently: the socket opens,
 * peers are never introduced, and the app looks like it is working.
 *
 * The probe has to run in a browser. Node has no `RTCPeerConnection`, so a
 * Node-side version of this test would report every server as broken — which is
 * exactly what it did before this was rewritten.
 *
 * Usage: node scripts/probe-collab.mjs
 */

import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);

const CANDIDATES = [
  'wss://signaling.fly.dev',
  'wss://signaling.yjs.dev',
  'wss://demos.yjs.dev/ws',
  'wss://y-webrtc-eu.fly.dev',
];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.json': 'application/json',
};

/** A minimal static server for the built app, so the probe uses the real bundle. */
function serve() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = join(root, 'dist', decodeURIComponent(path));
    try {
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function probe(browser, baseUrl, signaling) {
  const room = `probe-${randomUUID().slice(0, 8)}`;
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = [];
  const result = { signaling, connected: false, synced: false, detail: '' };

  try {
    for (const context of contexts) {
      await context.addInitScript((url) => {
        window.__PROLOG_SIGNALING__ = [url];
      }, signaling);
      const page = await context.newPage();
      pages.push(page);
      await page.goto(`${baseUrl}/#room=${room}`);
      await page.waitForSelector('.app');
    }

    const [a, b] = pages;

    // Wait for the two to see each other, which only happens over WebRTC.
    await a.waitForFunction(() => document.querySelectorAll('.presence__peer').length > 0, null, {
      timeout: 25_000,
    });
    result.connected = true;

    // Type in one, and require the text to arrive in the other.
    await b.locator('.editor__input').fill('probe_from_b.\n');
    await a.waitForFunction(
      () => document.querySelector('.editor__input')?.value === 'probe_from_b.\n',
      null,
      { timeout: 20_000 },
    );
    result.synced = true;
    result.detail = 'two isolated browsers converged on one document';
  } catch (error) {
    result.detail = result.connected
      ? 'peers connected but the document did not arrive'
      : String(error.message).split('\n')[0].slice(0, 90);
  } finally {
    await Promise.all(contexts.map((context) => context.close().catch(() => {})));
  }
  return result;
}

const { server, port } = await serve();
const baseUrl = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();

console.log('Collaboration probe — two isolated browsers, real signalling\n');
const working = [];
for (const signaling of CANDIDATES) {
  const result = await probe(browser, baseUrl, signaling);
  const verdict = result.synced ? 'WORKS  ' : result.connected ? 'PARTIAL' : 'FAIL   ';
  console.log(`${verdict} ${signaling}\n         ${result.detail}`);
  if (result.synced) working.push(signaling);
}

await browser.close();
server.close();

console.log('\nWORKS   = two browsers exchanged an edit through this server.');
console.log('PARTIAL = peers connected but the edit did not arrive.');
if (working.length > 0) {
  console.log('\nUsable servers:');
  for (const url of working) console.log(`  '${url}',`);
} else {
  console.log('\nNo usable server. Tabs in one browser still sync over BroadcastChannel.');
}
process.exit(working.length > 0 ? 0 : 1);
