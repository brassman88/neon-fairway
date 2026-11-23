// Neon Fairway: Qualtrics connection tests (prompt 2).
//   node tests/qualtrics.mjs [--guide path/to/qualtrics-setup-guide.md] [--out results.json] [--shots dir]
// Runs test/mock-qualtrics.html (which runs the guide's page script word for word)
// against stub.html for all five segments, plus origin/prefix checks, reloads,
// nf-error, a game that never loads, real-looking https origins, and bridge unit checks.
// Needs Playwright (npm i -D playwright; npx playwright install chromium), or set CHROME_PATH.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO, serve, routes, sleep } from './lib.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = await import('playwright')); }

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const GUIDE = opt('--guide');
const OUT = opt('--out');
const SHOTS = opt('--shots');      // optional folder for screenshots

// Field reference (claude/implementation-prompts.md, end).
const FIELDS = {
  'tp-practice': ['tp_bag', 'tp_letters', 'tp_practice_shots', 'tp_est_d', 'tp_est_h', 'tp_est_w'],
  'tp-rounds': ['tp_r1', 'tp_r2', 'tp_r3', 'tp_r4', 'tp_r5', 'tp_total', 'tp_best_aims'],
  'course-s1': ['h1', 'h2', 'h3', 'total', 'par', 'ob', 'pen', 'shortcut', 'pickups'].map((f) => 'crs_s1_' + f),
  'course-s2': ['h4', 'h5', 'h6', 'total', 'par', 'ob', 'pen', 'shortcut', 'pickups'].map((f) => 'crs_s2_' + f),
  'course-s3': ['h7', 'h8', 'h9', 'total', 'par', 'ob', 'pen', 'shortcut', 'pickups'].map((f) => 'crs_s3_' + f)
};
const SEGS = Object.keys(FIELDS);
const STEM = (seg) => seg.startsWith('tp-') ? 'tp_' + seg.slice(3) + '_' : 'crs_s' + seg.slice(-1) + '_';

const { server, base } = await serve({ '/': REPO });
const port = new URL(base).port;
const MOCK = `http://127.0.0.1:${port}/test/mock-qualtrics.html`;
const GAME_BASE = `http://localhost:${port}/`;            // the mock's default: the other host name
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ['--host-resolver-rules=MAP localhost 127.0.0.1']
});

const results = { started: new Date().toISOString(), tests: [], saved: {} };
let failed = 0;
function report(name, ok, detail) {
  results.tests.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
}
async function newContext(extraRoutes) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await routes(context);
  if (extraRoutes) await extraRoutes(context);
  return context;
}
function watch(page) {
  const out = { errors: [], console: [] };
  page.on('console', (m) => { out.console.push({ type: m.type(), text: m.text(), url: (m.location() || {}).url || '' }); if (m.type() === 'error') out.errors.push(m.text()); });
  page.on('pageerror', (e) => out.errors.push(String(e && e.stack || e)));
  return out;
}
const mockUrl = (q) => MOCK + '?' + new URLSearchParams(q).toString();
const M = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.MOCKQ)));
const gameFrame = (page) => page.frames().find((f) => f.parentFrame() === page.mainFrame() && /stub\.html|missing\.html/.test(f.url()) && f.name() !== 'other');
async function waitLog(page, re, timeout = 15000) {
  await page.waitForFunction((src) => window.MOCKQ && window.MOCKQ.log.some((l) => new RegExp(src).test(l.text)), re.source, { timeout, polling: 25 });
}
async function waitNext(page, timeout = 15000) {
  await page.waitForFunction(() => window.MOCKQ && window.MOCKQ.nextClicks > 0, null, { timeout, polling: 25 });
}
const savedOnPage = (m) => Object.fromEntries(m.calls.map((c) => [c.key, c.value]));

// Open a mock page and wait for the stub's nf-ready.
async function openSegment(page, q) {
  await page.goto(mockUrl(q));
  await waitLog(page, /received nf-ready/);
  const frame = gameFrame(page);
  await frame.waitForFunction(() => window.NF_STUB);
  return frame;
}

try {
  // ---------------------------------------------------------------------------------------
  // 0) The mock runs the guide's page script and HTML word for word.
  // ---------------------------------------------------------------------------------------
  if (GUIDE) {
    const md = fs.readFileSync(GUIDE, 'utf8');
    const sec4 = md.slice(md.indexOf('## 4.'), md.indexOf('## 5.'));
    const html = (sec4.match(/```html\n([\s\S]*?)```/) || [])[1];
    const js = (sec4.match(/```js\n([\s\S]*?)```/) || [])[1];
    const mock = fs.readFileSync(path.join(REPO, 'test/mock-qualtrics.html'), 'utf8');
    const block = (id) => (mock.match(new RegExp(`<script type="text/plain" id="${id}">\\n([\\s\\S]*?)</script>`)) || [])[1];
    report('Guide sync: mock page HTML = guide 4a', !!html && block('qualtrics-page-html').trim() === html.trim());
    report('Guide sync: mock page script = guide 4b', !!js && block('qualtrics-page-script').trim() === js.trim());
  } else {
    console.log('SKIP  Guide sync (pass --guide path/to/qualtrics-setup-guide.md)');
  }

  // ---------------------------------------------------------------------------------------
  // 1) All five segments in order, one response (fb-hidden, rng 12345, pos 2).
  // ---------------------------------------------------------------------------------------
  {
    const context = await newContext();
    const page = await context.newPage();
    const w = watch(page);
    const pid = 'R_mockA';
    let ed;
    for (const seg of SEGS) {
      const frame = await openSegment(page, seg === 'tp-practice'
        ? { page: seg, pid, cond: 'fb-hidden', rng: '12345', pos: '2', file: 'stub' }
        : { page: seg, file: 'stub' });                       // later pages: same response, as "Next page" does
      const before = await M(page);
      if (SHOTS && seg === 'tp-rounds') await page.screenshot({ path: path.join(SHOTS, 'mock-with-stub-tp-rounds.png') });
      const stub = await frame.evaluate(() => ({ settings: NFBridge.publicSettings(), summary: NF_STUB.summary,
        header: NFBridge.header('segment', 'segment'), url: location.href }));
      await frame.click('#finish');
      await waitNext(page);
      const m = await M(page);
      ed = m.ed;
      const saved = savedOnPage(m);
      const done = m.log.find((l) => /received nf-done/.test(l.text));
      const sentDone = { msg: m.received.find((r) => r.origin === new URL(GAME_BASE).origin && r.data.type === 'nf-done').data };
      results.saved[seg] = saved;
      console.log(`\n  ${seg}: iframe ${stub.url.replace(GAME_BASE, '')}`);
      console.table(Object.entries(saved).map(([field, value]) => ({ field, value })));

      const stem = STEM(seg);
      const want = [...FIELDS[seg], stem + 'saved', stem + 'attempt', stem + 'failed', stem + 'error'].sort();
      report(`${seg}: saves exactly the field-reference fields + saved/attempt/failed/error`,
        JSON.stringify(Object.keys(saved).sort()) === JSON.stringify(want), Object.keys(saved).join(','));
      report(`${seg}: summary values arrive unchanged`, FIELDS[seg].every((k) => saved[k] === String(stub.summary[k])));
      report(`${seg}: attempt saved = attempt in nf-done (${sentDone.msg.attempt}); saved 0 (no endpoint); failed 0; error empty`,
        saved[stem + 'attempt'] === String(sentDone.msg.attempt) && sentDone.msg.attempt === stub.settings.attempt &&
        saved[stem + 'saved'] === '0' && saved[stem + 'failed'] === '0' && saved[stem + 'error'] === '', done && done.text);
      report(`${seg}: stub got pid, segment, cond, rng, pos from the page`,
        stub.settings.pid === pid && stub.settings.segment === seg && stub.settings.cond === 'fb-hidden' &&
        stub.settings.rng === 12345 && stub.settings.pos === 2 && stub.settings.test === false && stub.settings.debug === false,
        JSON.stringify({ pid: stub.settings.pid, segment: stub.settings.segment, cond: stub.settings.cond, rng: stub.settings.rng, pos: stub.settings.pos }));
      if (seg !== 'tp-practice') {
        report(`${seg}: bag and letters handed on from tp-practice (${before.ed.tp_bag}, ${before.ed.tp_letters})`,
          stub.settings.bag === before.ed.tp_bag && stub.settings.letters === before.ed.tp_letters && !!before.ed.tp_bag);
      }
      report(`${seg}: header has load_id (8 chars) and game`, /^[a-z0-9]{8}$/.test(stub.header.load_id) && stub.header.game === 'stub',
        `load_id ${stub.header.load_id}, game ${stub.header.game}`);
      if (seg === 'tp-rounds') {
        const sum = [1, 2, 3, 4, 5].reduce((a, r) => a + +saved['tp_r' + r], 0);
        report('tp-rounds: tp_total = r1+…+r5', +saved.tp_total === sum);
      }
      if (seg.startsWith('course')) {
        const holes = FIELDS[seg].slice(0, 3);
        const par = { 'course-s1': 12, 'course-s2': 14, 'course-s3': 15 }[seg];
        report(`${seg}: total = sum of holes, par = ${par}`, +saved[stem + 'total'] === holes.reduce((a, k) => a + +saved[k], 0) && +saved[stem + 'par'] === par);
      }
    }
    report('Run: no console errors on the mock or stub pages', w.errors.length === 0, w.errors.slice(0, 3));
    results.finalEmbeddedData = ed;
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'mock-after-course-s3.png') });
    await context.close();
  }

  // ---------------------------------------------------------------------------------------
  // 2) Ignored: wrong origin, wrong source, wrong segment; then a wrong-prefix field.
  // ---------------------------------------------------------------------------------------
  {
    const context = await newContext((ctx) => ctx.route('https://evil.example/**', (r) => r.fulfill({ status: 200, contentType: 'text/html',
      body: `<script>parent.postMessage({ type: 'nf-done', segment: 'course-s1', attempt: 9, saved: true,
               summary: { crs_s1_total: 'EVIL', crs_s1_h1: 'EVIL' } }, '*');</script>` })));
    const page = await context.newPage();
    const frame = await openSegment(page, { page: 'course-s1', pid: 'R_mockB', cond: 'fb-visible', rng: '777', file: 'stub' });
    const fake = { type: 'nf-done', segment: 'course-s1', attempt: 9, saved: true, summary: { crs_s1_total: 'FAKE', crs_s1_h1: 'FAKE' } };
    // a) from the Qualtrics page itself (origin http://127.0.0.1:…, not the game's http://localhost:…)
    await page.evaluate((msg) => window.postMessage(msg, '*'), fake);
    // b) from a third-party iframe on another origin
    await page.evaluate(() => { const f = document.createElement('iframe'); f.name = 'other'; f.src = 'https://evil.example/x.html'; document.body.appendChild(f); });
    // c) from a second iframe on the game's own origin (right origin, wrong window)
    await page.evaluate((u) => { const f = document.createElement('iframe'); f.name = 'other'; f.src = u; document.body.appendChild(f); },
      GAME_BASE + 'stub.html?pid=R_mockB&segment=course-s1');
    await waitLog(page, /IGNORED nf-ready \[course-s1\]: not from the game iframe/);
    const twin = page.frames().find((f) => f.name() === 'other' && /stub\.html/.test(f.url()));
    await twin.evaluate(() => NFBridge.finish(() => ({ crs_s1_total: 'TWIN' })));
    // d) from the game iframe but for another segment
    await frame.evaluate((msg) => parent.postMessage(Object.assign({}, msg, { segment: 'course-s2' }), '*'), fake);
    await sleep(500);
    let m = await M(page);
    const ignored = m.log.filter((l) => /^IGNORED/.test(l.text)).map((l) => l.text);
    ignored.forEach((t) => console.log('    ' + t));
    report('Wrong origin (Qualtrics page itself): ignored, nothing saved', ignored.some((t) => /wrong origin http:\/\/127\.0\.0\.1/.test(t)));
    report('Wrong origin (https://evil.example iframe): ignored', ignored.some((t) => /wrong origin https:\/\/evil\.example/.test(t)));
    report('Right origin, wrong window (second game iframe): ignored', ignored.some((t) => /IGNORED nf-done \[course-s1\]: not from the game iframe/.test(t)));
    report('Wrong segment from the game iframe: ignored', ignored.some((t) => /segment "course-s2" is not course-s1/.test(t)));
    report('After all four: no embedded data written, Next not clicked', m.calls.length === 0 && m.nextClicks === 0);

    // e) the real game frame finishes with extra fields that don't start with crs_s1_
    await frame.evaluate(() => NFBridge.finish(() => Object.assign({}, NF_STUB.summary, { crs_s2_total: 99, tp_r1: 500, pid: 'x', crs_s1x: 1 })));
    await waitNext(page);
    m = await M(page);
    const saved = savedOnPage(m);
    const want = [...FIELDS['course-s1'], 'crs_s1_saved', 'crs_s1_attempt', 'crs_s1_failed', 'crs_s1_error'].sort();
    console.log('    ' + m.log.find((l) => /received nf-done/.test(l.text)).text);
    report('Wrong-prefix fields (crs_s2_total, tp_r1, pid, crs_s1x) ignored; the page\'s own fields saved',
      JSON.stringify(Object.keys(saved).sort()) === JSON.stringify(want) && !('crs_s2_total' in m.ed) && !('tp_r1' in m.ed) && !('pid' in m.ed),
      Object.keys(saved).join(','));
    report('fb-visible passed through', (await M(page)).iframeSrc.includes('cond=fb-visible'));
    await context.close();
  }

  // ---------------------------------------------------------------------------------------
  // 3) Reloads: Qualtrics page reload, then the survey reopened in a new tab.
  // ---------------------------------------------------------------------------------------
  {
    const context = await newContext();
    const page = await context.newPage();
    const w = watch(page);
    await openSegment(page, { page: 'course-s2', pid: 'R_mockC', rng: '42', file: 'stub' });
    await page.reload();
    await waitLog(page, /received nf-ready/);
    let frame = gameFrame(page);
    await frame.waitForFunction(() => window.NF_STUB);
    const s = await frame.evaluate(() => NFBridge.publicSettings());
    await frame.click('#finish');
    await waitNext(page);
    let m = await M(page);
    const reloaded = w.console.some((c) => /R_mockC_course-s2_a1_reloaded\.json/.test(c.text));
    report('Page reload: URL attempt 2, game attempt 2, saved crs_s2_attempt 2', s.attempt_from_url === 2 && s.attempt === 2 && m.ed.crs_s2_attempt === '2',
      `url ${s.attempt_from_url}, game ${s.attempt}, saved ${m.ed.crs_s2_attempt}`);
    report('Page reload: attempt 1 re-sent as "reloaded" (R_mockC_course-s2_a1_reloaded.json queued)', reloaded);

    // New tab: the page's sessionStorage counter starts again at 1, the game still knows attempt 2.
    const page2 = await context.newPage();
    await page2.goto(mockUrl({ page: 'course-s2', pid: 'R_mockC', rng: '42', file: 'stub' }));
    await waitLog(page2, /received nf-ready/);
    frame = gameFrame(page2);
    await frame.waitForFunction(() => window.NF_STUB);
    const s2 = await frame.evaluate(() => NFBridge.publicSettings());
    await frame.click('#finish');
    await waitNext(page2);
    m = await M(page2);
    report('New tab: page counter 1 in the URL, game attempt 3, saved crs_s2_attempt 3 (from nf-done, not the page counter)',
      s2.attempt_from_url === 1 && s2.attempt === 3 && m.ed.crs_s2_attempt === '3',
      `url ${s2.attempt_from_url}, game ${s2.attempt}, saved ${m.ed.crs_s2_attempt}`);
    await context.close();
  }

  // ---------------------------------------------------------------------------------------
  // 4) nf-error, and a game that never loads.
  // ---------------------------------------------------------------------------------------
  {
    const context = await newContext();
    const page = await context.newPage();
    const frame = await openSegment(page, { page: 'tp-practice', pid: 'R_mockD', file: 'stub' });
    await frame.click('#err');
    await page.waitForSelector('#nf-problem', { state: 'visible' });
    await page.click('#nf-skip2');
    await waitNext(page);
    const m = await M(page);
    const saved = savedOnPage(m);
    report('nf-error: problem message shown; continue saves failed 1, error STUB_TEST, attempt empty, saved 0, no summary fields',
      JSON.stringify(saved) === JSON.stringify({ tp_practice_saved: '0', tp_practice_attempt: '', tp_practice_failed: '1', tp_practice_error: 'STUB_TEST' }),
      JSON.stringify(saved));
    await context.close();
  }
  {
    const context = await newContext();
    const page = await context.newPage();
    await page.clock.install();
    await page.goto(mockUrl({ page: 'course-s3', pid: 'R_mockE', file: 'missing.html' }));
    await page.waitForFunction(() => window.MOCKQ && window.MOCKQ.iframeSrc);
    await sleep(500);
    const early = await page.isVisible('#nf-trouble');
    await page.clock.fastForward(20500);
    await page.waitForSelector('#nf-trouble', { state: 'visible' });
    await page.click('#nf-skip');
    await waitNext(page);
    const saved = savedOnPage(await M(page));
    report('Game never loads: "didn\'t load" shown after 20 s (not before); continue saves failed 1, attempt empty',
      !early && JSON.stringify(saved) === JSON.stringify({ crs_s3_saved: '0', crs_s3_attempt: '', crs_s3_failed: '1', crs_s3_error: '' }),
      JSON.stringify(saved));
    await context.close();
  }

  // ---------------------------------------------------------------------------------------
  // 5) Real-looking origins: survey on https://….qualtrics.com, game on https://….github.io.
  // ---------------------------------------------------------------------------------------
  {
    const QHOST = 'https://survey-test.qualtrics.com', GHOST = 'https://nf-tester.github.io/neon-fairway/';
    const fileFor = (u, prefix) => path.join(REPO, decodeURIComponent(new URL(u).pathname).slice(prefix.length));
    const types = { '.html': 'text/html', '.js': 'text/javascript' };
    const context = await newContext(async (ctx) => {
      await ctx.route(QHOST + '/**', (r) => r.fulfill({ path: fileFor(r.request().url(), '/'), contentType: types[path.extname(new URL(r.request().url()).pathname)] }));
      await ctx.route(GHOST + '**', (r) => { const f = fileFor(r.request().url(), '/neon-fairway/'); return fs.existsSync(f) ? r.fulfill({ path: f, contentType: types[path.extname(f)] }) : r.fulfill({ status: 404, body: 'nf' }); });
    });
    const page = await context.newPage();
    const w = watch(page);
    await page.goto(`${QHOST}/test/mock-qualtrics.html?` + new URLSearchParams({ page: 'course-s1', pid: 'R_mockF', file: 'stub', nf_url: GHOST }));
    await waitLog(page, /received nf-ready/);
    const frame = page.frames().find((f) => f.url().startsWith(GHOST + 'stub.html'));
    await frame.waitForFunction(() => window.NF_STUB);
    const s = await frame.evaluate(() => NFBridge.publicSettings());
    report('https: bridge posts to the qorigin it was given (https://survey-test.qualtrics.com)',
      s.qorigin === QHOST && s.post_origin === QHOST && s.post_origin_from === 'qorigin', `${s.post_origin} (from ${s.post_origin_from})`);
    await frame.evaluate(() => parent.postMessage({ type: 'nf-done', segment: 'course-s1', attempt: 1, saved: true, summary: { crs_s1_total: 'X' } }, 'https://other.qualtrics.com'));
    await sleep(300);
    report('https: a message addressed to another Qualtrics origin is never delivered', !(await M(page)).log.some((l) => /nf-done/.test(l.text)));
    const total = await frame.evaluate(() => NF_STUB.summary.crs_s1_total);
    await frame.click('#finish');
    await waitNext(page);
    const saved = savedOnPage(await M(page));
    report('https: segment finishes and saves its fields', saved.crs_s1_attempt === '1' && saved.crs_s1_total === String(total), JSON.stringify(saved));
    report('https: no "messages go to any parent" warning', !w.console.some((c) => /any parent/.test(c.text)));
    await context.close();
  }

  // ---------------------------------------------------------------------------------------
  // 6) Bridge unit checks (stub.html opened directly).
  // ---------------------------------------------------------------------------------------
  {
    const context = await newContext();
    const page = await context.newPage();
    const settingsFor = async (q, cfg) => {
      if (cfg) await page.addInitScript((c) => { window.NF_BRIDGE_CONFIG = c; }, cfg);
      const w = watch(page);
      await page.goto(`${base}/stub.html?` + new URLSearchParams(q));
      await page.waitForFunction(() => window.NF_STUB);
      return { s: await page.evaluate(() => NFBridge.publicSettings()), w };
    };
    const cases = [
      ['https://abc.qualtrics.com', 'https://abc.qualtrics.com'],
      ['https://uni.az1.qualtrics.com', 'https://uni.az1.qualtrics.com'],
      ['http://abc.qualtrics.com', '*'],
      ['https://abc.qualtrics.com.evil.com', '*'],
      ['https://evilqualtrics.com', '*'],
      ['https://abc.qualtrics.com/', '*'],
      ['https://abc.qualtrics.com:8443', '*'],
      ['javascript:alert(1)', '*'],
      ['', '*']
    ];
    const got = [], wrong = [];
    for (const [qo, want] of cases) {
      const { s } = await settingsFor({ pid: 'R_unit', segment: 'course-s1', qorigin: qo });
      got.push(`${qo || '(none)'} → ${s.post_origin}`);
      if (s.post_origin !== want) wrong.push(qo);
    }
    report('qorigin used only if it is https://[a-z0-9.-]+.qualtrics.com, else "*"', wrong.length === 0, got.join(' | '));
    let r = await settingsFor({ pid: 'R_unit', segment: 'course-s1', qorigin: 'https://evil.example' }, { QUALTRICS_ORIGIN: 'https://uni.qualtrics.com' });
    report('Invalid qorigin + QUALTRICS_ORIGIN set → the constant (with an "ignored" warning)',
      r.s.post_origin === 'https://uni.qualtrics.com' && r.s.post_origin_from === 'constant' && r.w.console.some((c) => /qorigin "https:\/\/evil\.example".*ignored/.test(c.text)));
    r = await settingsFor({ pid: 'R_unit', segment: 'course-s1', qorigin: 'https://abc.qualtrics.com' });
    report('Valid qorigin wins over QUALTRICS_ORIGIN', r.s.post_origin === 'https://abc.qualtrics.com');
    await context.close();

    const c2 = await newContext();
    const p2 = await c2.newPage();
    await p2.goto(`${base}/stub.html?` + new URLSearchParams({ pid: 'R_unit2', segment: 'tp-rounds', bag: 'dchpwv', letters: ' b, a ,c', pos: '2' }));
    await p2.waitForFunction(() => window.NF_STUB);
    const a = await p2.evaluate(() => ({ s: NFBridge.publicSettings(), h: NFBridge.header('shot', 's1'), seg: NFBridge.segmentInfo() }));
    report('letters normalised ("b, a ,c" → "B,A,C"); pos "2" → 2; both in segmentInfo()',
      a.s.letters === 'B,A,C' && a.s.pos === 2 && a.seg.letters === 'B,A,C' && a.seg.pos === 2);
    report('Header field order: record_type, record_id, pid, segment, attempt, load_id, game, …',
      Object.keys(a.h).join(',') === 'record_type,record_id,pid,segment,attempt,load_id,game,game_version,cond,bag_seed,rng_seed,test,client_time', Object.keys(a.h).join(','));
    const id1 = a.s.load_id;
    await p2.reload(); await p2.waitForFunction(() => window.NF_STUB);
    const id2 = await p2.evaluate(() => NFBridge.loadId);
    await p2.goto(`${base}/stub.html?pid=R_unit3&segment=course-s1&pos=AB`); await p2.waitForFunction(() => window.NF_STUB);
    const p3 = await p2.evaluate(() => NFBridge.settings.pos);
    report('load_id: 8 characters [a-z0-9], new on every page load', /^[a-z0-9]{8}$/.test(id1) && /^[a-z0-9]{8}$/.test(id2) && id1 !== id2, `${id1}, ${id2}`);
    report('pos that isn\'t a whole number stays text ("AB")', p3 === 'AB');
    const fin = await p2.evaluate(async () => {
      const a = NFBridge.finish(() => ({ crs_s1_total: 1 })), b = NFBridge.finish(() => ({ crs_s1_total: 2 }));
      const [ra, rb] = await Promise.all([a, b]);
      return { same: a === b, ra, sent: NFBridge.sent().filter((m) => m.msg.type === 'nf-done').map((m) => m.msg) };
    });
    report('finish() twice → one nf-done, same attempt, first summary', fin.same && fin.sent.length === 1 && fin.sent[0].attempt === fin.ra.attempt && fin.sent[0].summary.crs_s1_total === 1);
    const e = await p2.evaluate(() => { NFBridge.error('BAG', 'Bag "XX" is not valid.'); return NFBridge.sent().slice(-1)[0].msg; });
    report('error(code, text) → { type:"nf-error", segment, code, text }', JSON.stringify(e) === JSON.stringify({ type: 'nf-error', segment: 'course-s1', code: 'BAG', text: 'Bag "XX" is not valid.' }));
    await p2.goto(`${base}/stub.html`); await p2.waitForFunction(() => window.NF_STUB);
    const loc = await p2.evaluate(() => NFBridge.publicSettings());
    report('No pid → local testing: pid local-test, debug on, test true', loc.pid === 'local-test' && loc.debug && loc.test && loc.local_test);
    await c2.close();
  }

  // ---------------------------------------------------------------------------------------
  // 7) The games still load cleanly (they don't use the bridge yet).
  // ---------------------------------------------------------------------------------------
  for (const g of ['target.html', 'course.html', 'index.html']) {
    const context = await newContext();
    const page = await context.newPage();
    const w = watch(page);
    await page.goto(`${base}/${g}`);
    await sleep(1500);
    report(`${g} loads with no console errors`, w.errors.length === 0, w.errors.slice(0, 2));
    await context.close();
  }
} catch (e) {
  report('Test run crashed', false, String(e && e.stack || e));
} finally {
  await browser.close();
  server.close();
  results.finished = new Date().toISOString();
  results.failed = failed;
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(`\n${results.tests.length - failed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
