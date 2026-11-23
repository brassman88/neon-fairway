// Neon Fairway: end-to-end study test (prompt 9).
//   node tests/e2e-study.mjs [--browser chromium,firefox,webkit] [--out results.json] [--records folder] [--shots folder]
//                            [--only visible,hidden,down]
// Needs Playwright and its engines: npm i -D playwright; npx playwright install chromium firefox webkit
//
// Runs the whole study path as Qualtrics will: test/mock-qualtrics.html (the guide's page script word for
// word) with the real games, cross-origin (survey on 127.0.0.1, games on localhost), one response per run.
//
// Run "visible" (cond fb-visible, window 1100×600: the smallest the device check allows, overlay scrollbars)
// and run "hidden" (cond fb-hidden, 1083×600: the same 1100-px window with a 17-px classic Windows scrollbar):
//   tp-practice → tp-rounds → course-s1 → course-s2 → course-s3, one pid and rng, tp_bag / tp_letters handed on
//   by the mock's embedded data. A fake data store records every POST. One reload mid-segment per game:
//   visible reloads tp-rounds (after round 1) and course-s2 (after hole 4); hidden reloads tp-practice
//   (after 22 shots) and course-s3 (after hole 7).
//   Checks: bag and club labels across segments; nf-done summaries and the embedded data = the field
//   reference exactly; every record's shared header, segment, attempt and load_id; the segment record's
//   feedback = cond; reloads → attempt 2 + a 'reloaded' record; keys after one click, no parent scrolling;
//   no scrolling inside the iframe on any screen; Qualtrics values = the data store's values.
// Run "down" (fb-visible, 1280×720): the data endpoint refuses connections. tp-practice and course-s1 must
//   still end (saved = 0) and keep their data queued (the bridge's backup holds the final save).
//
// Exit code: 0 all passed; 1 a check failed; 2 only "DECIDE" findings (need a researcher decision) or an
// engine could not be launched.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { REPO, serve, routes, sleep } from './lib.mjs';
import * as T from './target-helpers.mjs';
import * as C from './course-helpers.mjs';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch (e) { pw = await import('playwright'); }

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const ENGINES = (opt('--browser') || 'chromium,firefox,webkit').split(',').map((s) => s.trim()).filter(Boolean);
const ONLY = (opt('--only') || 'visible,hidden,down').split(',');
const OUT = opt('--out');
const RECORDS = opt('--records');
const SHOTS = opt('--shots');
for (const d of [RECORDS, SHOTS]) if (d) fs.mkdirSync(d, { recursive: true });

const VERSIONS = { target: 'v41', course: 'V23' };
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
const STATUS = (seg) => ['saved', 'attempt', 'failed', 'error'].map((f) => STEM(seg) + f);
const HEADER = ['record_type', 'record_id', 'pid', 'segment', 'attempt', 'load_id', 'game', 'game_version', 'cond', 'bag_seed', 'rng_seed', 'test', 'client_time'];
const GAME_OF = (seg) => seg.startsWith('tp-') ? 'target' : 'course';
const LABELS = ['Driver B', 'Hybrid A', 'Wedge C'];          // the clubs the script chooses → letters B,A,C

const { server, base } = await serve({ '/': REPO });
const port = new URL(base).port;
const MOCK = `http://127.0.0.1:${port}/test/mock-qualtrics.html`;
const GAME_ORIGIN = `http://localhost:${port}`;
const ENDPOINT = `http://127.0.0.1:${port}/__save`;
const deadPort = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const DEAD_ENDPOINT = `http://127.0.0.1:${deadPort}/__save`;      // nothing listens here: connection refused

const results = { started: new Date().toISOString(), engines: {}, tests: [], findings: [] };
let failed = 0, decide = 0;
function report(engine, run, name, ok, detail, kind) {
  const status = ok ? 'PASS' : kind === 'decide' ? 'DECIDE' : 'FAIL';
  results.tests.push({ engine, run, name, status, detail });
  if (status === 'FAIL') failed++;
  if (status === 'DECIDE') decide++;
  console.log(`${status.padEnd(6)} [${engine}/${run}] ${name}${detail !== undefined && (!ok || process.env.VERBOSE) ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
}

// ---------------------------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------------------------
async function newRun(browser, viewport, endpoint) {
  const context = await browser.newContext({ viewport });
  await routes(context);
  const posts = [];
  const beacons = [];
  // The fake data store answers only the live endpoint; the "down" run's endpoint is a closed port.
  if (endpoint === ENDPOINT) await context.route(ENDPOINT, async (route) => {
    let body = null; try { body = JSON.parse(route.request().postData()); } catch (e) { /* not JSON */ }
    posts.push({ at: Date.now(), body });
    await route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'Access-Control-Allow-Origin': '*' }, body: 'ok' });
  });
  await context.addInitScript((ep) => { window.NF_BRIDGE_CONFIG = { DATA_ENDPOINT: ep }; }, endpoint);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // Expected in the endpoint-down run: the browser's own "connection refused" lines.
    if (endpoint === DEAD_ENDPOINT && /ERR_CONNECTION_REFUSED|Failed to load resource|NetworkError|Could not connect|Load failed|Fetch API cannot load/i.test(t)) return;
    errors.push(t);
  });
  page.on('requestfailed', (r) => { if (/__save$/.test(r.url())) beacons.push({ at: Date.now(), type: r.resourceType(), err: (r.failure() || {}).errorText }); });
  return { context, page, posts, errors, beacons };
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };

async function findFrame(page, re) {
  await page.waitForFunction(() => window.MOCKQ && window.MOCKQ.iframeSrc, null, { timeout: 15000 });
  for (let i = 0; i < 600; i++) {
    const f = page.frames().find((x) => x.parentFrame() === page.mainFrame() && re.test(x.url()));
    if (f) return f;
    await sleep(25);
  }
  throw new Error('game iframe not found');
}
async function targetFrame(page) {
  const f = await findFrame(page, /target\.html/);
  await f.waitForFunction(() => window.TargetPractice && window.NFBridge, null, { timeout: 30000 });
  return f;
}
async function courseFrame(page) {
  const f = await findFrame(page, /course\.html/);
  await f.waitForFunction(() => window.NeonFairway && window.NFBridge, null, { timeout: 30000 });
  return f;
}
// Go to a mock page the way the survey does ("Next page" button), or start the response.
async function openPage(page, seg, first) {
  if (first) await page.goto(MOCK + '?' + new URLSearchParams({ page: seg, file: 'game', ...first }).toString());
  else {
    await page.waitForFunction((s) => document.getElementById('b-next').textContent.includes(s), seg, { timeout: 10000 });
    await page.click('#b-next');
    await page.waitForURL((u) => u.searchParams.get('page') === seg, { timeout: 15000 });
  }
  await T.waitMockLog(page, /received nf-ready/);
}
const loadInfo = (f) => f.evaluate(() => ({ attempt: NFBridge.settings.attempt, load_id: NFBridge.loadId, url: location.href,
  urlAttempt: NFBridge.settings.attemptFromUrl, letters: NFBridge.settings.letters, bag: NFBridge.settings.bag, cond: NFBridge.settings.cond,
  debug: NFBridge.settings.debug, test: NFBridge.settings.test, post_origin: NFBridge.targetOrigin }));

// Layout inside the iframe: no document scrolling, every open card and its buttons in view, no card that
// scrolls inside, and the main controls in view.
async function layout(f, game, label) {
  const L = await f.evaluate((game) => {
    const de = document.documentElement;
    const inView = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.top >= -0.5 && r.left >= -0.5 && r.bottom <= innerHeight + 0.5 && r.right <= innerWidth + 0.5; };
    const shown = (el) => !!el && !!(el.offsetParent || el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';
    const overlays = [...document.querySelectorAll('.overlay')].filter((o) => !o.hidden);
    const cardSel = game === 'target' ? '.modal' : '.cardx';
    const badCards = [];
    overlays.forEach((o) => {
      const m = o.querySelector(cardSel);
      if (!m) return;
      const btns = [...m.querySelectorAll('button')].filter(shown);
      if (!inView(m)) badCards.push(o.id + ': card not fully in view');
      if (m.scrollHeight > m.clientHeight + 1) badCards.push(o.id + ': card scrolls inside (' + m.scrollHeight + ' > ' + m.clientHeight + ')');
      btns.filter((b) => !inView(b)).forEach((b) => badCards.push(o.id + ': button "' + b.textContent.trim() + '" out of view'));
    });
    const ids = game === 'target' ? ['tp-birdCanvas', 'tp-takeShotBtn', 'tp-powerSlider', 'tp-aimStraight', 'tp-endPracticeBtn'] : ['game', 'swing', 'powerSlider', 'clubs'];
    const offscreen = overlays.length ? [] : ids.filter((id) => { const e = document.getElementById(id); return shown(e) && !inView(e); });
    return { frame: [innerWidth, innerHeight], docScrolls: de.scrollHeight > de.clientHeight + 1 || de.scrollWidth > de.clientWidth + 1,
      doc: [de.scrollWidth, de.scrollHeight], overlays: overlays.map((o) => o.id), badCards, offscreen };
  }, game);
  L.label = label;
  L.ok = !L.docScrolls && !L.badCards.length && !L.offscreen.length;
  return L;
}

// Where the iframe sits in the survey window: how much of it can be seen at once.
// Measured right after nf-ready, before anyone scrolls: the part of the game below (or above) the window.
// The best possible is max(0, iframe height − window height).
async function iframeFit(page) {
  return page.evaluate(() => {
    const fr = document.querySelector('#nf-box iframe'), r = fr.getBoundingClientRect();
    const below = Math.max(0, Math.round(r.bottom - innerHeight)), above = Math.max(0, Math.round(-r.top));
    const best = Math.max(0, Math.round(r.height - innerHeight));
    return { window: [innerWidth, innerHeight], iframe: [Math.round(r.width), Math.round(r.height)], scrollY: Math.round(scrollY),
      top: Math.round(r.top), hiddenBelow: below, hiddenAbove: above, best, ok: below + above <= best };
  });
}

// Keyboard: focus on the survey page first, then one click on the game, then keys. The survey page must
// never scroll. press(k) presses a key at the page level (goes to whatever has focus).
async function scrollPrep(page, f) {
  const box = await (await f.frameElement()).boundingBox();
  await page.evaluate((y) => window.scrollTo(0, Math.max(0, window.scrollY + y)), Math.round(box.y - 4));   // box.y is window-relative (prompt 9: the page may already be scrolled)
  await sleep(150);
  return page.evaluate(() => ({ y: scrollY, max: document.documentElement.scrollHeight - innerHeight }));
}
async function clickSurveyPage(page, f) {
  // A click on the survey page itself, just left of the game (the question box's padding): no scrolling needed.
  const b = await (await f.frameElement()).boundingBox();
  await page.mouse.click(Math.max(2, b.x - 8), b.y + 100);
  await sleep(120);
}

async function keysTarget(page, f, { inRound }) {
  const y0info = await scrollPrep(page, f);
  await clickSurveyPage(page, f);
  const yA = await scrollPrep(page, f);   // back to the game (scroll programmatically, like a mouse wheel would)
  const focusBefore = await f.evaluate(() => document.hasFocus());
  const box = await f.evaluate(() => { const r = document.getElementById('tp-birdCanvas').getBoundingClientRect(); return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.35 }; });
  const off = await T.frameOffset(page, f);
  await page.mouse.click(off.x + box.x, off.y + box.y);            // the one click on the game (aims there)
  await sleep(120);
  const s0 = await f.evaluate(() => ({ aim: TargetPractice.state.aimAngle, power: TargetPractice.state.power, club: TargetPractice.state.clubIndex,
    shots: TargetPractice.state.shotHistory.length, focus: document.hasFocus() }));
  const log = [];
  const read = () => f.evaluate(() => ({ aim: TargetPractice.state.aimAngle, power: TargetPractice.state.power, club: TargetPractice.state.clubIndex }));
  for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'ArrowDown', '2', '1']) { await page.keyboard.press(k); await sleep(60); log.push([k, await read()]); }
  const yKeys = await page.evaluate(() => scrollY);
  await page.keyboard.press('Space');
  await f.waitForFunction((n) => TargetPractice.state.shotHistory.length > n, s0.shots, { timeout: 8000 }).catch(() => {});
  await f.waitForFunction(() => TargetPractice.state.phase !== 'animating', null, { timeout: 15000 });
  const s1 = await f.evaluate(() => TargetPractice.state.shotHistory.length);
  const yShot = await page.evaluate(() => scrollY);
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  const ok = !focusBefore && s0.focus &&
    near(log[0][1].aim, s0.aim - 1) && near(log[2][1].aim, s0.aim + 1) &&
    log[3][1].power === Math.max(1, s0.power - 5) && log[5][1].power === Math.max(1, s0.power - 5) &&
    log[6][1].club === 1 && log[7][1].club === 0 && s1 === s0.shots + 1;
  return { ok, noScroll: yA.max > 20 && yKeys === yA.y && yShot === yA.y, detail: { focusBefore, focusAfterClick: s0.focus, start: s0, keys: log.map(([k, v]) => k + '→' + JSON.stringify(v)), shotTaken: s1 === s0.shots + 1, scroll: { y: yA.y, max: yA.max, afterKeys: yKeys, afterShot: yShot }, inRound } };
}
async function keysCourse(page, f) {
  const yA0 = await scrollPrep(page, f);
  await clickSurveyPage(page, f);
  const yA = await scrollPrep(page, f);
  const focusBefore = await f.evaluate(() => document.hasFocus());
  const p = await C.planSwing(f);
  const off = await C.frameOffset(page, f);
  await page.mouse.click(off.x + p.px, off.y + p.py);
  await sleep(120);
  const s0 = await f.evaluate(() => ({ tx: NeonFairway.S.target.x, power: NeonFairway.S.power, club: NeonFairway.S.club, bag: NeonFairway.S.bag.map((c) => c.id), focus: document.hasFocus(), swings: NeonFairway.S.shots.length }));
  const log = [];
  const read = () => f.evaluate(() => ({ tx: NeonFairway.S.target.x, power: NeonFairway.S.power, club: NeonFairway.S.club }));
  // Power first down, so ↑ can be seen even from 100 %.
  for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'ArrowDown', '2', '1']) { await page.keyboard.press(k); await sleep(60); log.push([k, await read()]); }
  // Put the planned club and power back so the scripted swing still makes sense.
  await f.click(`#clubs button[data-club="${p.club}"]`);
  await f.evaluate((v) => { const sl = document.getElementById('powerSlider'); sl.value = v; sl.dispatchEvent(new Event('input', { bubbles: true })); }, p.power);
  await page.mouse.click(off.x + p.px, off.y + p.py);
  await sleep(60);
  const yKeys = await page.evaluate(() => scrollY);
  await page.keyboard.press('Space');
  await f.waitForFunction((n) => NeonFairway.S.shots.length > n || NeonFairway.S.phase === 'fly', s0.swings, { timeout: 8000 }).catch(() => {});
  await C.waitPhase(f, ['aim', 'done']);
  const s1 = await f.evaluate(() => NeonFairway.S.shots.length);
  const yShot = await page.evaluate(() => scrollY);
  const ok = !focusBefore && s0.focus && log[0][1].tx !== s0.tx && log[2][1].tx !== log[0][1].tx &&
    log[3][1].power === s0.power - 5 && log[4][1].power === s0.power && log[5][1].power === s0.power - 5 &&
    log[6][1].club === s0.bag[1] && log[7][1].club === s0.bag[0] && s1 === s0.swings + 1;
  return { ok, noScroll: yA.max > 20 && yKeys === yA.y && yShot === yA.y, detail: { focusBefore, focusAfterClick: s0.focus, keys: log.map(([k, v]) => k + '→' + JSON.stringify(v)), swung: s1 === s0.swings + 1, scroll: { y: yA.y, max: yA.max, afterKeys: yKeys, afterShot: yShot } } };
}

// Wait for the page to move on after CONTINUE; returns the mock state.
async function continueAndWait(page, f, btn, timeout = 30000) {
  const t0 = Date.now();
  await f.click(btn);
  await page.waitForFunction(() => window.MOCKQ.nextClicks > 0, null, { timeout });
  return { ms: Date.now() - t0, M: await T.mockState(page) };
}

// ---------------------------------------------------------------------------------------------
// Segment drivers
// ---------------------------------------------------------------------------------------------
async function chooseClubsWithLayout(f, labels, layouts) {
  await f.click('#tp-endPracticeBtn');
  if (await f.isVisible('#tp-nudgeOverlay')) { layouts.push(await layout(f, 'target', 'practice: fewer-than-5 reminder')); await f.click('#tp-chooseAnywayBtn'); }
  let first = true;
  for (let i = 0; i < 12 && await f.isVisible('#tp-estimateOverlay'); i++) {
    if (first) { layouts.push(await layout(f, 'target', 'practice: estimate card (final)')); first = false; }
    const idx = await T.estimateClubIdx(f);
    await T.answerEstimate(f, T.scriptEstimate(idx), T.scriptHits(idx));
  }
  await f.waitForSelector('#tp-bagOverlay:not([hidden])');
  layouts.push(await layout(f, 'target', 'practice: choose your clubs'));
  for (const l of labels) await f.click(`#tp-bagSections .bag-card[data-label="${l}"]`);
  await f.click('#tp-confirmBagBtn');
  await T.waitPhase(f, ['chosen']);
  layouts.push(await layout(f, 'target', 'practice: clubs chosen'));
}

async function runTpPractice(ctx, run, seg, plan) {
  const { page } = ctx;
  let f = await targetFrame(page);
  const info = { loads: [await loadInfo(f)], layouts: [], keys: null };
  info.layouts.push(await layout(f, 'target', 'practice: intro'));
  await shot(page, `${run.tag}-tp-practice-intro`);
  if (plan.reload) {
    await f.click('#tp-startPracticeBtn');
    await T.waitPhase(f, ['shooting']);
    await T.practiceScript(f, { n: 22 });
    info.reloadAt = await f.evaluate(() => ({ shots: TargetPractice.state.practice.shots }));
    await page.reload();
    await T.waitMockLog(page, /received nf-ready/);
    f = await targetFrame(page);
    info.loads.push(await loadInfo(f));
  }
  await f.click('#tp-startPracticeBtn');
  await T.waitPhase(f, ['shooting']);
  info.layouts.push(await layout(f, 'target', 'practice: shooting'));
  info.keys = await keysTarget(page, f, { inRound: false });
  await T.practiceScript(f, { n: 12 });
  await chooseClubsWithLayout(f, LABELS, info.layouts);
  info.chosen = await f.evaluate(() => ({ seed: TargetPractice.state.seed, labels: TargetPractice.state.bag.map((c) => c.label || c.clubLabel || c.name),
    varieties: TargetPractice.state.bag.map((c) => (c.variety && c.variety.key) || c.variety), list: document.getElementById('tp-chosenList').textContent,
    shots: TargetPractice.state.practice.shots, est: TargetPractice.state.bag.map((c) => c.estimate) }));
  await shot(page, `${run.tag}-tp-practice-chosen`);
  const { ms, M } = await continueAndWait(page, f, '#tp-chosenContinueBtn');
  info.continueMs = ms;
  info.M = M;
  return info;
}

async function playRoundRest(f, done) {
  for (let b = done; b < 12; b++) {
    if (await T.rawPhase(f) !== 'shooting') break;
    await T.shoot(f, T.ROUND_SCRIPT[b]);
  }
}
async function runTpRounds(ctx, run, seg, plan) {
  const { page } = ctx;
  let f = await targetFrame(page);
  const info = { loads: [await loadInfo(f)], layouts: [], keys: null };
  const readLabels = () => f.evaluate(() => ({ buttons: [...document.querySelectorAll('#tp-clubButtons button')].map((b) => b.textContent.trim()),
    intro: document.getElementById('tp-introSteps').textContent, varieties: TargetPractice.state.clubs.map((c) => (c.variety && c.variety.key) || c.variety),
    match: TargetPractice.lettersMatch() }));
  info.labels = await readLabels();
  info.layouts.push(await layout(f, 'target', 'rounds: intro'));
  await shot(page, `${run.tag}-tp-rounds-intro`);
  if (plan.reload) {
    await f.click('#tp-startPracticeBtn');
    await T.playRound(f);
    await T.waitAfterRound(f);
    info.reloadAt = 'round 1 complete';
    await page.reload();
    await T.waitMockLog(page, /received nf-ready/);
    f = await targetFrame(page);
    info.loads.push(await loadInfo(f));
    info.labelsAfterReload = await readLabels();
  }
  await f.click('#tp-startPracticeBtn');
  await T.waitPhase(f, ['predict']);
  info.layouts.push(await layout(f, 'target', 'rounds: prediction card'));
  await T.startRoundPlay(f);
  info.layouts.push(await layout(f, 'target', 'rounds: shooting'));
  info.keys = await keysTarget(page, f, { inRound: true });      // ball 1 by keyboard (Space)
  await playRoundRest(f, 1);
  for (let r = 1; r <= 5; r++) {
    const next = await T.waitAfterRound(f);
    if (r === 1) info.layouts.push(await layout(f, 'target', 'rounds: round complete card'));
    if (next !== 'tp-roundOverlay') break;
    await f.click('#tp-nextRoundBtn');
    await T.playRound(f);
  }
  await f.waitForSelector('#tp-endOverlay:not([hidden])');
  info.layouts.push(await layout(f, 'target', 'rounds: all rounds complete'));
  info.endText = await f.evaluate(() => document.querySelector('#tp-endOverlay .modal').innerText);
  info.scores = await f.evaluate(() => TargetPractice.state.rounds.map((r) => r.score));
  await shot(page, `${run.tag}-tp-rounds-end`);
  const { ms, M } = await continueAndWait(page, f, '#tp-endContinueBtn');
  info.continueMs = ms; info.M = M;
  return info;
}

async function runCourse(ctx, run, seg, plan) {
  const { page } = ctx;
  let f = await courseFrame(page);
  const info = { loads: [await loadInfo(f)], layouts: [], keys: null };
  const readClubs = () => f.evaluate(() => ({ bag: NeonFairway.S.bag.map((c) => c.id), buttons: [...document.querySelectorAll('#clubs button')].map((b) => b.innerText.replace(/\s+/g, ' ').trim()),
    names: NeonFairway.S.bag.map((c) => `${c.name} (${c.varietyName})`), how: (document.querySelector('#howCard') || {}).innerText || '' }));
  info.clubs = await readClubs();
  const card = async (label) => info.layouts.push(await layout(f, 'course', label));
  if (plan.reload) {
    const stop = new Error('STOP');
    try { await C.playSegment(page, f, { continueAtEnd: false, onHoleDone: async () => { throw stop; } }); } catch (e) { if (e !== stop) throw e; }
    info.reloadAt = await f.evaluate(() => 'hole ' + (NeonFairway.S.holeIdx + 1) + ' complete');
    await page.reload();
    await T.waitMockLog(page, /received nf-ready/);
    f = await courseFrame(page);
    info.loads.push(await loadInfo(f));
  }
  await card(seg === 'course-s1' ? 'course: how to play' : 'course: same controls reminder');
  await shot(page, `${run.tag}-${seg}-first-card`);
  await f.click('#howBtn');
  await card('course: section briefing');
  await f.click('#secBtn');
  await card('course: hole card with prediction');
  await C.teeOff(f);
  await C.waitPhase(f, ['aim']);
  await card('course: aiming');
  info.keys = await keysCourse(page, f);
  let firstDone = true;
  const holes = await C.playSegment(page, f, { continueAtEnd: false, onHoleDone: async () => { if (firstDone) { firstDone = false; await card('course: hole complete card'); } } });
  info.holes = holes.map((h) => ({ hole: h.hole_no, strokes: h.strokes }));
  await card('course: section complete');
  info.endText = await f.evaluate(() => document.querySelector('#sectionDone .cardx').innerText);
  await shot(page, `${run.tag}-${seg}-section-complete`);
  const { ms, M } = await continueAndWait(page, f, '#sdContinue');
  info.continueMs = ms; info.M = M;
  return info;
}

// ---------------------------------------------------------------------------------------------
// Checks on what reached Qualtrics and the data store
// ---------------------------------------------------------------------------------------------
function storeRecords(posts) {
  const byId = new Map(), files = [];
  for (const p of posts) {
    const b = p.body; if (!b) continue;
    files.push(b.file);
    const recs = [];
    if (b.segment_record) recs.push(b.segment_record);
    for (const [k, v] of Object.entries(b)) if (Array.isArray(v)) recs.push(...v);
    for (const r of recs) byId.set(r.record_id, { r, file: b.file });     // keep the last one per record_id
  }
  return { records: [...byId.values()], files };
}

function checkRun(engine, run, seg, info, store, ed, ctxInfo) {
  const R = (name, ok, detail, kind) => report(engine, run.name, `${seg}: ${name}`, ok, detail, kind);
  const M = info.M;
  // ---- nf-done and the embedded data ----
  const done = M.received.filter((x) => x.origin === GAME_ORIGIN && x.data && x.data.type === 'nf-done');
  const sum = done.length ? done[done.length - 1].data.summary : {};
  const setHere = Object.fromEntries(M.calls.map((c) => [c.key, c.value]));
  const last = info.loads[info.loads.length - 1];
  R('nf-done summary = the field reference exactly', done.length === 1 && JSON.stringify(Object.keys(sum).sort()) === JSON.stringify([...FIELDS[seg]].sort()),
    { keys: Object.keys(sum), nfDone: done.length });
  R('page saved the summary fields + saved/attempt/failed/error, nothing else; values unchanged',
    JSON.stringify(Object.keys(setHere).sort()) === JSON.stringify([...FIELDS[seg], ...STATUS(seg)].sort()) && FIELDS[seg].every((k) => setHere[k] === String(sum[k])),
    setHere);
  const st = STEM(seg);
  const wantSaved = run.endpoint === DEAD_ENDPOINT ? '0' : '1';
  R(`status fields: saved ${wantSaved}, attempt ${last.attempt} (= the game's), failed 0, error empty`,
    setHere[st + 'saved'] === wantSaved && setHere[st + 'attempt'] === String(last.attempt) && setHere[st + 'failed'] === '0' && setHere[st + 'error'] === '' &&
    done.length === 1 && done[0].data.attempt === last.attempt,
    { saved: setHere[st + 'saved'], attempt: setHere[st + 'attempt'], game: last.attempt, failed: setHere[st + 'failed'], error: setHere[st + 'error'] });
  R('study mode in the game: debug off, test false, cond as given', info.loads.every((l) => !l.debug && !l.test && l.cond === run.cond), info.loads.map((l) => ({ debug: l.debug, test: l.test, cond: l.cond })));

  if (run.endpoint === DEAD_ENDPOINT) return;

  // ---- Data store ----
  const recs = store.records.map((x) => x.r).filter((r) => r.segment === seg);
  const stray = store.records.filter((x) => x.r.segment !== seg && x.file.includes('_' + seg + '_'));
  const missingHeader = [], wrong = [];
  for (const r of recs) {
    for (const h of HEADER) if (!Object.prototype.hasOwnProperty.call(r, h)) missingHeader.push(r.record_id + '.' + h);
    const L = info.loads.find((l) => l.attempt === r.attempt);
    const why = [];
    if (r.pid !== run.pid) why.push('pid');
    if (!L) why.push('attempt ' + r.attempt + ' not seen');
    else if (r.load_id !== L.load_id) why.push('load_id ' + r.load_id + ' ≠ ' + L.load_id);
    if (!r.record_id.startsWith(`${run.pid}-${seg}-a${r.attempt}-`)) why.push('record_id');
    if (r.game !== GAME_OF(seg) || r.game_version !== VERSIONS[GAME_OF(seg)]) why.push('game ' + r.game + ' ' + r.game_version);
    if (r.cond !== run.cond || r.rng_seed !== run.rng || r.test !== false) why.push('cond/rng/test');
    if (seg !== 'tp-practice' && r.bag_seed !== ed.tp_bag) why.push('bag_seed ' + r.bag_seed);
    if (seg === 'tp-practice' && r.bag_seed !== null && r.bag_seed !== ed.tp_bag) why.push('bag_seed ' + r.bag_seed);
    if (why.length) wrong.push(r.record_id + ': ' + why.join(', '));
  }
  const types = {}; recs.forEach((r) => { types[r.record_type] = (types[r.record_type] || 0) + 1; });
  R(`every record has the shared header (${recs.length} records: ${Object.entries(types).map(([t, n]) => n + ' ' + t).join(', ')})`, recs.length > 0 && !missingHeader.length, missingHeader.slice(0, 8));
  R('every record: right pid, segment, attempt, load_id of its page load, game + version, cond, rng, test false, bag_seed', !wrong.length && !stray.length,
    { wrong: wrong.slice(0, 8), stray: stray.slice(0, 3).map((x) => x.r.record_id) });
  R(`one load_id per page load (${info.loads.map((l) => 'a' + l.attempt + '=' + l.load_id).join(', ')}), different on reload`,
    new Set(info.loads.map((l) => l.load_id)).size === info.loads.length && info.loads.every((l) => /^[a-z0-9]{8}$/.test(l.load_id)));
  const segRec = recs.find((r) => r.record_type === 'segment' && r.attempt === last.attempt);
  const wantFb = run.cond === 'fb-hidden' ? 'hidden' : 'visible';
  R(`segment record: status complete, feedback "${wantFb}" = cond ${run.cond}`, !!segRec && segRec.status === 'complete' && segRec.feedback === wantFb,
    segRec && { status: segRec.status, feedback: segRec.feedback, has_feedback: 'feedback' in segRec });
  if (seg !== 'tp-practice') R('segment record letters = tp_letters', !!segRec && segRec.letters === ed.tp_letters, segRec && segRec.letters);

  // ---- Reload ----
  if (info.loads.length > 1) {
    const a1 = recs.find((r) => r.record_type === 'segment' && r.attempt === 1);
    const a1files = store.files.filter((x) => x && x.includes(`_${seg}_a1_`));
    R(`reload (${info.reloadAt}): game attempt ${info.loads[1].attempt} (URL attempt ${info.loads[1].urlAttempt}); Qualtrics saved attempt 2; attempt 1 arrives as a "reloaded" segment record with load 1's load_id`,
      info.loads[1].attempt === 2 && info.loads[1].urlAttempt === 2 && setHere[st + 'attempt'] === '2' && !!a1 && a1.status === 'reloaded' && a1.load_id === info.loads[0].load_id &&
      store.files.includes(`${run.pid}_${seg}_a1_reloaded.json`),
      { a1: a1 && { status: a1.status, load_id: a1.load_id }, a1files });
    R('reload: attempt 1 and attempt 2 records never share an id or load_id',
      recs.filter((r) => r.attempt === 1).every((r) => r.load_id === info.loads[0].load_id) && recs.filter((r) => r.attempt === 2).every((r) => r.load_id === info.loads[1].load_id));
  }

  // ---- Qualtrics values = data store values ----
  const fin = recs.filter((r) => r.attempt === last.attempt);
  const of = (t) => fin.filter((r) => r.record_type === t);
  let agree = null, detail = null;
  if (seg === 'tp-practice') {
    const bc = of('bag_choice')[0] || {};
    detail = { tp_bag: [ed.tp_bag, segRec && segRec.bag_seed], tp_letters: [ed.tp_letters, bc.letters_chosen], shots: [ed.tp_practice_shots, segRec && segRec.practice_shots],
      est: [[ed.tp_est_d, ed.tp_est_h, ed.tp_est_w].join(), [bc.driver_est_distance, bc.hybrid_est_distance, bc.wedge_est_distance].join()] };
    agree = Object.values(detail).every(([a, b]) => String(a) === String(b));
  } else if (seg === 'tp-rounds') {
    const rounds = of('round').sort((a, b) => a.round - b.round);
    detail = { scores: [[1, 2, 3, 4, 5].map((k) => ed['tp_r' + k]).join(), rounds.map((r) => r.score).join()], total: [ed.tp_total, rounds.reduce((a, r) => a + r.score, 0)],
      best: [ed.tp_best_aims, rounds.reduce((a, r) => a + r.best_shots, 0)], segTotal: [ed.tp_total, segRec && segRec.total_score] };
    agree = rounds.length === 5 && Object.values(detail).every(([a, b]) => String(a) === String(b));
  } else {
    const p = STEM(seg), holes = of('hole').sort((a, b) => a.hole_no - b.hole_no);
    detail = { holes: [FIELDS[seg].slice(0, 3).map((k) => ed[k]).join(), holes.map((h) => h.strokes).join()], total: [ed[p + 'total'], segRec && segRec.total_strokes],
      par: [ed[p + 'par'], segRec && segRec.total_par], ob: [ed[p + 'ob'], segRec && segRec.ob_count], pen: [ed[p + 'pen'], segRec && segRec.penalty_strokes],
      pickups: [ed[p + 'pickups'], holes.filter((h) => h.picked_up).length], shortcut: [ed[p + 'shortcut'], holes.filter((h) => h.route_first_shot === 'shortcut').length] };
    agree = holes.length === 3 && Object.values(detail).every(([a, b]) => String(a) === String(b));
  }
  R('Qualtrics values = the data store\'s records (what the pilot export check compares)', agree, detail);
}

// ---------------------------------------------------------------------------------------------
// One full response
// ---------------------------------------------------------------------------------------------
async function fullRun(browser, engine, run) {
  const ctx = await newRun(browser, run.viewport, run.endpoint);
  const out = { segs: {}, fit: {} };
  const R = (name, ok, detail, kind) => report(engine, run.name, name, ok, detail, kind);
  let ed = null;
  try {
    for (const seg of SEGS) {
      await openPage(ctx.page, seg, seg === 'tp-practice' ? { pid: run.pid, cond: run.cond, rng: String(run.rng), pos: run.pos } : null);
      out.fit[seg] = await iframeFit(ctx.page);
      const plan = { reload: run.reload.includes(seg) };
      const info = seg === 'tp-practice' ? await runTpPractice(ctx, run, seg, plan) : seg === 'tp-rounds' ? await runTpRounds(ctx, run, seg, plan) : await runCourse(ctx, run, seg, plan);
      out.segs[seg] = info;
      ed = info.M.ed;
      await sleep(300);
      const store = storeRecords(ctx.posts);
      checkRun(engine, run, seg, info, store, ed, out);
      report(engine, run.name, `${seg}: one click on the game gives it the keyboard (←/→ aim, ↓/↑ power, 1/2 club, Space ${seg.startsWith('tp') ? 'shoots' : 'swings'})`, info.keys.ok, info.keys.detail);
      report(engine, run.name, `${seg}: Space and arrow keys never scroll the survey page`, info.keys.noScroll, info.keys.detail.scroll);
      const bad = info.layouts.filter((L) => !L.ok);
      report(engine, run.name, `${seg}: at ${run.viewport.width}×${run.viewport.height} (iframe ${info.layouts[0].frame.join('×')}) no screen scrolls inside the iframe; cards, buttons and controls in view (${info.layouts.length} screens)`,
        !bad.length, bad.length ? bad : info.layouts.map((L) => L.label));
    }

    // ---- Across segments: bag and club labels ----
    const P = out.segs['tp-practice'], Rd = out.segs['tp-rounds'];
    const varieties = P.chosen.varieties;
    R(`tp-practice chose ${LABELS.join(', ')} → tp_bag ${ed.tp_bag}, tp_letters ${ed.tp_letters}`, ed.tp_letters === 'B,A,C' && ed.tp_bag === P.chosen.seed && LABELS.every((l) => P.chosen.list.includes(l)),
      { tp_bag: ed.tp_bag, tp_letters: ed.tp_letters, chosen: P.chosen });
    const rlabels = [Rd.labels, Rd.labelsAfterReload].filter(Boolean);
    R('tp-rounds: club buttons and intro card use the same labels as practice; same varieties; letters match the rng',
      rlabels.every((L) => JSON.stringify(L.buttons) === JSON.stringify(LABELS) && LABELS.every((l) => L.intro.includes(l)) && JSON.stringify(L.varieties) === JSON.stringify(varieties) && L.match === true),
      rlabels.map((L) => ({ buttons: L.buttons, varieties: L.varieties, match: L.match })));
    const crs = ['course-s1', 'course-s2', 'course-s3'].map((s) => out.segs[s].clubs);
    const wantIds = ['driver', 'hybrid', 'wedge'].map((t, i) => t + '-' + varieties[i]);
    R('course: the bag built from tp_bag is the same three clubs (type + variety) in every section; letters reach every page',
      crs.every((c) => JSON.stringify(c.bag) === JSON.stringify(wantIds)) && SEGS.slice(1).every((s) => out.segs[s].loads.every((l) => l.letters === ed.tp_letters && l.bag === ed.tp_bag)),
      { want: wantIds, got: crs.map((c) => c.bag) });
    const crsLabelsMatch = crs.every((c) => LABELS.every((l, i) => c.buttons[i].includes(l)));
    const crsSame = crs.every((c) => JSON.stringify(c.buttons) === JSON.stringify(crs[0].buttons));
    R('course: club labels the same in all three sections', crsSame, crs.map((c) => c.buttons));
    R(`course: club buttons use the Target Practice labels (${LABELS.join(', ')})`, crsLabelsMatch,
      { course: crs[0].buttons, howToPlay: (crs[0].how.match(/You play with[^\n]*/) || [''])[0], targetPractice: LABELS,
        note: 'The course names clubs by variety ("Driver (Control)") and does not use letters; Target Practice never shows varieties. Needs a decision (see report).' }, 'decide');

    // ---- Embedded data after the whole path ----
    const want = SEGS.flatMap((s) => [...FIELDS[s], ...STATUS(s)]).sort();
    const got = Object.keys(ed).filter((k) => /^(tp_|crs_)/.test(k)).sort();
    const empty = got.filter((k) => ed[k] === '' && !/_error$/.test(k));
    R(`whole path: embedded data holds exactly the ${want.length} game fields of the guide (+ ResponseID, nf_url, rng_seed, cond, pos, screen_ok); none empty except …_error`,
      JSON.stringify(got) === JSON.stringify(want) && !empty.length && Object.keys(ed).filter((k) => !/^(tp_|crs_)/.test(k)).sort().join() === ['ResponseID', 'cond', 'nf_url', 'pos', 'rng_seed', 'screen_ok'].sort().join(),
      { missing: want.filter((k) => !got.includes(k)), extra: got.filter((k) => !want.includes(k)), empty, other: Object.keys(ed).filter((k) => !/^(tp_|crs_)/.test(k)) });
    out.embeddedData = ed;

    // ---- fb-hidden: the end cards show no totals ----
    if (run.cond === 'fb-hidden') {
      const tpEnd = Rd.endText, sc = Rd.scores;
      const crsEnd = ['course-s1', 'course-s2', 'course-s3'].map((s) => out.segs[s].endText);
      R('fb-hidden: "All rounds complete" shows no round score; Section complete cards show no strokes or par',
        !sc.some((s) => s > 0 && new RegExp('\\b' + s + '\\b').test(tpEnd)) && !/pts|points/i.test(tpEnd) && crsEnd.every((t) => !/STROKES|PAR\s*\d/i.test(t)),
        { tpEnd, crsEnd });
    }
    // ---- Where the iframe sits in the window ----
    out.fitSummary = Object.fromEntries(Object.entries(out.fit).map(([s, v]) => [s, v]));
    report(engine, run.name, `survey window ${run.viewport.width}×${run.viewport.height}: right after each game loads, as much of it is in the window as fits (hidden: ${Object.values(out.fit).map((v) => v.hiddenBelow + v.hiddenAbove).join(', ')} px; best possible ${Object.values(out.fit)[0].best} px)`,
      Object.values(out.fit).every((v) => v.ok), out.fit);
    R('no page errors or console errors', ctx.errors.length === 0, ctx.errors.slice(0, 5));
    if (RECORDS) fs.writeFileSync(path.join(RECORDS, `${engine}-${run.name}-saves.json`), JSON.stringify({ embeddedData: ed, posts: ctx.posts.map((p) => p.body) }, null, 2));
  } catch (e) {
    R('run stopped', false, String(e && e.stack || e).split('\n').slice(0, 4).join(' | '));
    await shot(ctx.page, `${engine}-${run.name}-stopped`).catch(() => {});
  }
  await ctx.context.close();
  // Keep results small: drop mock states.
  for (const s of Object.values(out.segs)) delete s.M;
  return out;
}

// Endpoint unreachable: tp-practice and course-s1 still end (saved 0) and the data stays queued.
async function downRun(browser, engine) {
  const run = { name: 'down', tag: engine + '-down', pid: 'R_e2e_down_' + engine, cond: 'fb-visible', rng: 7331, pos: '1', viewport: { width: 1280, height: 720 }, endpoint: DEAD_ENDPOINT, reload: [] };
  const ctx = await newRun(browser, run.viewport, DEAD_ENDPOINT);
  const out = {};
  const R = (name, ok, detail) => report(engine, run.name, name, ok, detail);
  try {
    for (const seg of ['tp-practice', 'course-s1']) {
      if (seg === 'tp-practice') await openPage(ctx.page, seg, { pid: run.pid, cond: run.cond, rng: String(run.rng), pos: run.pos });
      else {
        // Straight to course-s1 (same response; tp-rounds is not needed for this check).
        await ctx.page.goto(MOCK + '?' + new URLSearchParams({ page: seg, file: 'game' }).toString());
        await T.waitMockLog(ctx.page, /received nf-ready/);
      }
      const info = seg === 'tp-practice' ? await runTpPractice(ctx, run, seg, {}) : await runCourse(ctx, run, seg, {});
      checkRun(engine, run, seg, info, { records: [], files: [] }, info.M.ed, {});
      const st = STEM(seg);
      // The iframe is gone (Qualtrics moved on). Read the bridge's backup through a frame on the game's origin
      // inside the same survey page (the browser keys iframe storage by the survey's site).
      await ctx.page.evaluate((u) => { const fr = document.createElement('iframe'); fr.name = 'peek'; fr.src = u; document.body.appendChild(fr); }, GAME_ORIGIN + '/README.md');
      let peek = null;
      for (let i = 0; i < 200 && !peek; i++) { peek = ctx.page.frames().find((x) => x.name() === 'peek' && x.url().startsWith(GAME_ORIGIN)); if (!peek) await sleep(25); }
      await peek.waitForLoadState('domcontentloaded');
      const backup = await peek.evaluate((k) => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return { error: String(e) }; } }, `nf-backup:${run.pid}:${seg}`);
      const files = backup && backup.queue ? backup.queue.map((q) => q.file) : [];
      const finalQ = backup && backup.queue ? backup.queue.find((q) => /_final\.json$/.test(q.file)) : null;
      const nRecs = finalQ ? Object.values(finalQ.body).filter(Array.isArray).reduce((a, v) => a + v.length, 0) : 0;
      out[seg] = { continueMs: info.continueMs, saved: info.M.ed[st + 'saved'], queue: files, finalRecords: nRecs, beacons: ctx.beacons.length };
      R(`${seg}: endpoint unreachable → the page still moves on ${(info.continueMs / 1000).toFixed(1)} s after CONTINUE, with ${st}saved = 0`,
        info.M.nextClicks === 1 && info.M.ed[st + 'saved'] === '0' && info.continueMs <= 12000, out[seg]);
      R(`${seg}: the data stays queued — the bridge's backup keeps ${files.length} unsent save(s), including the final save with ${nRecs} records + the segment record (status ${finalQ && finalQ.body.segment_record && finalQ.body.segment_record.status})`,
        !!finalQ && nRecs > 0 && finalQ.body.segment_record && finalQ.body.segment_record.status === 'complete' && backup.finished === true, { queue: files });
      await ctx.page.evaluate(() => document.querySelectorAll('iframe[name=peek]').forEach((x) => x.remove()));
    }
    R('the bridge tried to send the queue again when the game page closed (sendBeacon / keepalive fetch, refused)', ctx.beacons.length > 0, { failedSaveRequests: ctx.beacons.length });
    R('no page errors (connection-refused messages excluded)', ctx.errors.length === 0, ctx.errors.slice(0, 5));
  } catch (e) {
    R('run stopped', false, String(e && e.stack || e).split('\n').slice(0, 4).join(' | '));
  }
  await ctx.context.close();
  return out;
}

// ---------------------------------------------------------------------------------------------
for (const engine of ENGINES) {
  const type = pw[engine];
  let browser;
  try {
    browser = await type.launch(engine === 'chromium' ? { args: ['--host-resolver-rules=MAP localhost 127.0.0.1'], ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) } : {});
  } catch (e) {
    results.engines[engine] = { notRun: String(e.message || e).split('\n')[0] };
    console.log(`NOT RUN [${engine}] could not launch: ${String(e.message || e).split('\n')[0]}`);
    continue;
  }
  const E = results.engines[engine] = { version: browser.version(), runs: {} };
  const runs = [
    { name: 'visible', pid: 'R_e2e_vis_' + engine, cond: 'fb-visible', rng: 424242, pos: '1', viewport: { width: 1100, height: 600 }, endpoint: ENDPOINT, reload: ['tp-rounds', 'course-s2'] },
    { name: 'hidden', pid: 'R_e2e_hid_' + engine, cond: 'fb-hidden', rng: 424242, pos: '2', viewport: { width: 1083, height: 600 }, endpoint: ENDPOINT, reload: ['tp-practice', 'course-s3'] }
  ].filter((r) => ONLY.includes(r.name));
  for (const run of runs) { run.tag = `${engine}-${run.name}`; console.log(`\n=== ${engine} · ${run.name} (${run.cond}, ${run.viewport.width}×${run.viewport.height}) ===`); E.runs[run.name] = await fullRun(browser, engine, run); }
  if (ONLY.includes('down')) { console.log(`\n=== ${engine} · data endpoint unreachable ===`); E.runs.down = await downRun(browser, engine); }
  await browser.close();
}

results.finished = new Date().toISOString();
results.failed = failed; results.decide = decide;
const notRun = Object.entries(results.engines).filter(([, v]) => v.notRun).map(([k]) => k);
results.notRun = notRun;
if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
const passed = results.tests.filter((t) => t.status === 'PASS').length;
console.log(`\n${passed} passed, ${failed} failed, ${decide} need a decision` + (notRun.length ? `; not run: ${notRun.join(', ')}` : ''));
server.close();
process.exit(failed ? 1 : (decide || notRun.length) ? 2 : 0);
