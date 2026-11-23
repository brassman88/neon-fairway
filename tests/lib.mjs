// Shared helpers for the Neon Fairway refactor tests (Node 18+, Playwright).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.css': 'text/css' };

// A tiny static server (like python3 -m http.server). `mounts` maps a URL
// prefix to a directory or a single file, e.g. { '/': REPO, '/__orig/target.html': '/x/v36.html' }.
export function serve(mounts, port = 0) {
  const entries = Object.entries(mounts).sort((a, b) => b[0].length - a[0].length);
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    for (const [prefix, target] of entries) {
      if (!url.startsWith(prefix)) continue;
      let file = fs.statSync(target).isFile() ? target : path.join(target, url.slice(prefix.length));
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!fs.existsSync(file)) break;
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

// Math.random → mulberry32(1), installed before any page script runs.
// Also counts calls so runs can be compared.
export const SEEDED_RANDOM = `(() => {
  let a = 1 >>> 0;
  window.__rngCalls = 0;
  Math.random = function () {
    window.__rngCalls++;
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();`;

// Route rules shared by every page:
//  - Google Fonts: answered with empty CSS (it's blocked in the test sandbox; the
//    games fall back to system fonts either way). Off with stubFonts:false.
//  - The original course file loads Phaser from cdnjs: served from vendor/.
export async function routes(context, { stubFonts = true } = {}) {
  if (stubFonts) {
    await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  }
  await context.route(/cdnjs\.cloudflare\.com\/ajax\/libs\/phaser\/3\.80\.1\/phaser\.min\.js/, (r) =>
    r.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(path.join(REPO, 'vendor/phaser.min.js')) }));
}

// Collect console errors, page errors and failed requests for a page.
export function watchErrors(page) {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push({ kind: 'console', text: m.text(), url: (m.location() || {}).url || '' }); });
  page.on('pageerror', (e) => errors.push({ kind: 'pageerror', text: String(e && e.stack || e) }));
  page.on('requestfailed', (r) => errors.push({ kind: 'requestfailed', text: `${r.failure() && r.failure().errorText} ${r.url()}` }));
  return errors;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function waitFor(page, fn, arg, timeout = 30000) {
  await page.waitForFunction(fn, arg, { timeout, polling: 25 });
}

// Deep equality on JSON (full float precision). Returns the first differing path or null.
export function firstDiff(a, b, p = '$') {
  if (typeof a !== typeof b) return `${p}: type ${typeof a} vs ${typeof b}`;
  if (a === null || b === null || typeof a !== 'object') {
    if (Object.is(a, b)) return null;
    return `${p}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${p}: array vs object`;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (!(k in a)) return `${p}.${k}: missing in first`;
    if (!(k in b)) return `${p}.${k}: missing in second`;
    const d = firstDiff(a[k], b[k], `${p}.${k}`);
    if (d) return d;
  }
  return null;
}
