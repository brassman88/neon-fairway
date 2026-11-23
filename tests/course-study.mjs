// Neon Fairway: course.html study-mode tests (prompt 3, course V19; updated for V20's How-to-play card and CONTINUE).
//   node tests/course-study.mjs [--out results.json] [--shots folder]
// Needs Playwright (npm i -D playwright; npx playwright install chromium), or set CHROME_PATH.
//
// 1. Determinism: the same pid, rng and scripted swings give identical shots on two runs
//    (each in a fresh browser), played through test/mock-qualtrics.html; a third run with
//    another rng must differ.
// 2. course-s2 plays exactly holes 4-6 and sends crs_s2_h4..h6, crs_s2_total, crs_s2_par
//    (V21: and crs_s2_ob, crs_s2_pen, crs_s2_shortcut, crs_s2_pickups; checked in tests/course-logging.mjs).
// 3. A bad bag (missing, invalid) or segment shows the error card and sends nf-error.
// 4. No researcher tools / seed card with a pid unless debug=1; no seed in localStorage.
// 5. Iframe fit at 1000×620, 1280×720, 1440×800 in the mock: nothing clipped, keys don't
//    scroll the survey page, a click on the map focuses the game.
// The swings are real UI input: club button, power slider, a mouse click on the map to aim, SWING.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO, serve, routes, sleep } from './lib.mjs';
import * as H from './course-helpers.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = await import('playwright')); }

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const OUT = opt('--out');
const SHOTS = opt('--shots');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const { server, base } = await serve({ '/': REPO });
const port = new URL(base).port;
const MOCK = `http://127.0.0.1:${port}/test/mock-qualtrics.html`;   // game runs on localhost: cross-origin
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ['--host-resolver-rules=MAP localhost 127.0.0.1']
});

const results = { started: new Date().toISOString(), tests: [], runs: {} };
let failed = 0;
function report(name, ok, detail) {
  results.tests.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
}
async function newContext(viewport = { width: 1400, height: 1000 }) {
  const context = await browser.newContext({ viewport });
  await routes(context);
  return context;
}
function watch(page) {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e && e.stack || e)));
  return errors;
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };

// ---- Helpers (tests/course-helpers.mjs) -----------------------------------------------------
const openMockCourse = (page, opts) => H.openMockCourse(page, MOCK, opts);
const { mockState, waitMockLog, phase, waitPhase, planSwing, frameOffset } = H;
// Play to the Section complete card, screenshot it, then CONTINUE (V20: nothing is sent before that).
async function playSegment(page, frame, { label } = {}) {
  const holes = await H.playSegment(page, frame, { continueAtEnd: false,
    onHoleDone: async (hs) => { if (label && SHOTS && hs.length === 1) await shot(page, `${label}-hole-done`); } });
  if (label) await shot(page, `${label}-section-complete`);
  await frame.click('#sdContinue');
  return holes;
}

// =========================================================================================
// 1 + 2. Determinism and course-s2, through the mock Qualtrics page
// =========================================================================================
async function mockRun(label, { pid, rng, seg = 'course-s2', bag = 'DCHPWV' }) {
  const ctx = await newContext();
  const page = await ctx.newPage();
  const errors = watch(page);
  const frame = await openMockCourse(page, { pid, rng, seg, bag });
  await waitMockLog(page, /received nf-ready/);
  await shot(page, `${label}-start`);
  const how = await frame.evaluate(() => ({ visible: !document.getElementById('howCard').hidden, title: document.getElementById('howTitle').textContent }));
  await frame.click('#howBtn');
  const first = await frame.evaluate(() => ({ hole: NeonFairway.S.holeIdx + 1, secVisible: !document.getElementById('sectionCard').hidden,
    secNum: document.getElementById('secNum').textContent, secMeta: document.getElementById('secMeta').textContent,
    cardNum: document.getElementById('cardNum').textContent, hud: document.getElementById('hudHole').textContent }));
  const holes = await playSegment(page, frame, { label });
  await page.waitForFunction(() => window.MOCKQ && window.MOCKQ.nextClicks > 0, null, { timeout: 20000 });
  const M = await mockState(page);
  const done = M.received.filter((r) => r.data && r.data.type === 'nf-done');
  const set = Object.fromEntries(M.calls.map((c) => [c.key, c.value]));
  await shot(page, `${label}-after-next`);
  await ctx.close();
  return { how, first, holes, done, set, errors, log: M.log.map((l) => l.text) };
}

{
  const A = await mockRun('s2-run1', { pid: 'R_det01', rng: 4242 });
  const B = await mockRun('s2-run2', { pid: 'R_det01', rng: 4242 });
  const C = await mockRun('s2-run3-other-rng', { pid: 'R_det01', rng: 9001 });
  results.runs = { A, B, C: { holes: C.holes } };
  const strip = (r) => JSON.stringify(r.holes);
  const nShots = A.holes.reduce((a, h) => a + h.shots.length, 0);
  report('Determinism: same pid, rng and scripted swings → identical shots (2 fresh runs)', strip(A) === strip(B),
    `${nShots} swings over holes ${A.holes.map((h) => h.hole_no).join(',')}; strokes ${A.holes.map((h) => h.strokes).join('/')} vs ${B.holes.map((h) => h.strokes).join('/')}`);
  report('Determinism: another rng gives different shots', strip(A) !== strip(C), `rng 9001 strokes ${C.holes.map((h) => h.strokes).join('/')}`);
  const zOk = A.holes.every((h) => h.shots.every((s) => typeof s.zLat === 'number' && typeof s.zDist === 'number' && Math.abs(s.zLat) <= 3 && Math.abs(s.zDist) <= 3));
  report('Every swing keeps its two random draws (zLat, zDist within ±3)', zOk);

  report('course-s2 starts at hole 4: short How-to-play card, then the section 2 briefing',
    A.how.visible && A.how.title === 'SAME CONTROLS AS BEFORE' && A.first.hole === 4 && A.first.secVisible && /SECTION 2 OF 3/.test(A.first.secNum) && A.first.secMeta === 'HOLES 4–6' && /^HOLE 4 OF 9/.test(A.first.cardNum) && /^HOLE 4 OF 9/.test(A.first.hud),
    { how: A.how, first: A.first });
  report('course-s2 plays exactly holes 4–6', JSON.stringify(A.holes.map((h) => h.hole_no)) === '[4,5,6]', A.holes.map((h) => h.hole_no));
  const want = ['crs_s2_h4', 'crs_s2_h5', 'crs_s2_h6', 'crs_s2_total', 'crs_s2_par', 'crs_s2_ob', 'crs_s2_pen', 'crs_s2_shortcut', 'crs_s2_pickups'];
  const sum = A.done.length === 1 ? A.done[0].data.summary : null;
  const keysOk = !!sum && JSON.stringify(Object.keys(sum).sort()) === JSON.stringify(want.slice().sort());
  const valsOk = !!sum && sum.crs_s2_h4 === A.holes[0].strokes && sum.crs_s2_h5 === A.holes[1].strokes && sum.crs_s2_h6 === A.holes[2].strokes &&
    sum.crs_s2_total === A.holes.reduce((a, h) => a + h.strokes, 0) && sum.crs_s2_par === 4 + 5 + 5;
  report('nf-done (one) carries exactly crs_s2_h4..h6, _total, _par, _ob, _pen, _shortcut, _pickups with the played strokes', keysOk && valsOk, sum);
  const edOk = want.every((k) => A.set[k] === String(sum && sum[k])) && A.set.crs_s2_attempt === '1' && A.set.crs_s2_failed === '0' && A.set.crs_s2_saved === '0';
  report('Mock Qualtrics saved them as embedded data, attempt 1, then clicked Next', edOk, A.set);
  report('No console errors in the three runs', !A.errors.length && !B.errors.length && !C.errors.length, [...A.errors, ...B.errors, ...C.errors].slice(0, 5));
}

// =========================================================================================
// 3. Errors: bad bag, missing bag, bad segment
// =========================================================================================
{
  // a) invalid bag through the mock page (the page script's own nf-error handling)
  for (const [label, bag] of [['bad-bag', 'XXQQZZ'], ['missing-bag', null]]) {
    const ctx = await newContext({ width: 1280, height: 900 });
    const page = await ctx.newPage();
    const errors = watch(page);
    const frame = await openMockCourse(page, { pid: 'R_err_' + label, rng: 7, seg: 'course-s1', bag });
    await waitMockLog(page, /received nf-error/);
    const st = await frame.evaluate(() => ({ card: !document.getElementById('errorCard').hidden, code: document.getElementById('errCode').textContent,
      seed: !document.getElementById('startCard').hidden, sent: NFBridge.sent().map((m) => m.msg) }));
    const problemShown = await page.evaluate(() => getComputedStyle(document.getElementById('nf-problem')).display !== 'none');
    await shot(page, `error-${label}`);
    // the participant's way out on the survey page
    await page.click('#nf-skip2');
    await page.waitForFunction(() => window.MOCKQ.nextClicks > 0);
    const M = await mockState(page);
    const set = Object.fromEntries(M.calls.map((c) => [c.key, c.value]));
    report(`${label}: error card shown (no seed card), nf-error BAG sent, survey page offers a way out`,
      st.card && st.code === 'BAG' && !st.seed && st.sent.some((m) => m.type === 'nf-error' && m.code === 'BAG' && m.segment === 'course-s1') &&
      !st.sent.some((m) => m.type === 'nf-ready') && problemShown && set.crs_s1_error === 'BAG' && set.crs_s1_failed === '1',
      { sent: st.sent, set: { error: set.crs_s1_error, failed: set.crs_s1_failed } });
    if (errors.length) report(`${label}: console errors`, false, errors.slice(0, 3));
    await ctx.close();
  }
  // b) bad segment and other cases, framed in a plain parent page that records every message
  const cases = [
    ['bad segment (study)', 'pid=R_e1&segment=course-s4&bag=DCHPWV', 'SEGMENT'],
    ['missing segment (study)', 'pid=R_e2&bag=DCHPWV', 'SEGMENT'],
    ['tp segment given to the course', 'pid=R_e3&segment=tp-rounds&bag=DCHPWV', 'SEGMENT'],
    ['invalid bag (local testing)', 'segment=course-s3&bag=DCDPWV', 'BAG']
  ];
  for (const [label, q, code] of cases) {
    const ctx = await newContext({ width: 1280, height: 800 });
    const page = await ctx.newPage();
    const errors = watch(page);
    await page.goto(base + '/index.html');
    await page.evaluate((src) => {
      window.__msgs = [];
      window.addEventListener('message', (ev) => window.__msgs.push(ev.data));
      document.body.innerHTML = '';
      const f = document.createElement('iframe'); f.src = src; f.style.cssText = 'width:1200px;height:700px;border:0'; document.body.appendChild(f);
    }, base + '/course.html?' + q);
    await page.waitForFunction(() => window.__msgs.length > 0, null, { timeout: 15000 });
    await sleep(300);
    const msgs = await page.evaluate(() => window.__msgs);
    const frame = page.frames().find((f) => /course\.html/.test(f.url()));
    const st = await frame.evaluate(() => ({ card: !document.getElementById('errorCard').hidden, code: document.getElementById('errCode').textContent, text: document.getElementById('errText').textContent }));
    report(`${label}: error card + nf-error ${code}`, st.card && st.code === code && msgs.length === 1 && msgs[0].type === 'nf-error' && msgs[0].code === code, { msgs, text: st.text });
    if (label.startsWith('bad segment')) await shot(page, 'error-bad-segment');
    if (errors.length) report(`${label}: console errors`, false, errors.slice(0, 3));
    await ctx.close();
  }
}

// =========================================================================================
// 4. Lockdown
// =========================================================================================
{
  const cases = [
    ['pid, no debug', 'pid=R_l1&segment=course-s1&bag=DCHPWV', false],
    ['pid, debug=0', 'pid=R_l2&segment=course-s1&bag=DCHPWV&debug=0', false],
    ['pid, debug=1', 'pid=R_l3&segment=course-s1&bag=DCHPWV&debug=1', true],
    ['no pid (local testing)', 'segment=course-s1&bag=DCHPWV', true]
  ];
  for (const [label, q, tools] of cases) {
    const ctx = await newContext({ width: 1280, height: 800 });
    // A seed left in localStorage by an earlier local test must not be read in study mode.
    await ctx.addInitScript(() => { try { if (!sessionStorage.getItem('__seeded')) { localStorage.setItem('neonFairway.course.seed', 'DPHCWC'); sessionStorage.setItem('__seeded', '1'); } } catch (e) {} });
    const page = await ctx.newPage();
    const errors = watch(page);
    await page.goto(base + '/course.html?' + q);
    await page.waitForFunction(() => window.NeonFairway && NeonFairway.S.phase === 'card');
    const st = await page.evaluate(() => {
      const vis = (id) => { const el = document.getElementById(id); return !!el && el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden'; };
      return {
        research: vis('research'), spreadToggle: vis('spreadToggle'), routesToggle: vis('routesToggle'), clubTable: vis('clubTable'), reachTable: vis('reachTable'),
        holeJumps: [...document.querySelectorAll('#holeJump button')].map((b) => b.textContent).filter((t, i, a) => a.indexOf(t) === i),
        holeJumpVisible: vis('holeJump'), seedCard: vis('startCard'), seedInput: vis('seedInput'), bagPreview: vis('bagPreview'),
        againBtn: !document.getElementById('againBtn').hidden, sdAgain: !document.getElementById('sdAgain').hidden,
        seedStored: localStorage.getItem('neonFairway.course.seed'), bag: NeonFairway.seed, showSpread: NeonFairway.S.showSpread, showRoutes: NeonFairway.S.showRoutes
      };
    });
    const study = q.startsWith('pid');
    const anyTool = st.research || st.spreadToggle || st.routesToggle || st.clubTable || st.reachTable || st.holeJumpVisible;
    let ok = tools ? (st.research && st.holeJumps.join('|') === 'Play hole 1|Play hole 2|Play hole 3') : (!anyTool && !st.showSpread && !st.showRoutes);
    if (study) ok = ok && !st.seedCard && !st.seedInput && !st.bagPreview && !st.againBtn && st.seedStored === 'DPHCWC' && st.bag === 'DCHPWV';
    else ok = ok && st.seedStored === 'DCHPWV';    // local testing still remembers the seed
    report(`Lockdown, ${label}: researcher tools ${tools ? 'shown' : 'hidden'}${study ? ', no seed card, seed not stored' : ''}`, ok, st);
    if (label === 'pid, no debug') await shot(page, 'lockdown-pid-no-debug');
    if (label === 'pid, debug=1') await shot(page, 'lockdown-pid-debug');
    if (errors.length) report(`${label}: console errors`, false, errors.slice(0, 3));
    await ctx.close();
  }
  // Study mode with no bag never falls back to the stored seed or the seed card.
  const ctx = await newContext({ width: 1280, height: 800 });
  await ctx.addInitScript(() => { try { localStorage.setItem('neonFairway.course.seed', 'DCHPWV'); } catch (e) {} });
  const page = await ctx.newPage();
  await page.goto(base + '/course.html?pid=R_l5&segment=course-s2&debug=1');
  await page.waitForFunction(() => window.NeonFairway && NeonFairway.S.phase === 'error');
  const st = await page.evaluate(() => ({ seedCard: !document.getElementById('startCard').hidden, err: !document.getElementById('errorCard').hidden, bag: NeonFairway.seed }));
  report('Study mode, no bag, debug=1, a seed in localStorage: still the error card, no seed card', st.err && !st.seedCard && !st.bag, st);
  await ctx.close();
}

// =========================================================================================
// 5. Iframe fit in the mock page at three sizes, keys and focus
// =========================================================================================
for (const vp of [{ width: 1000, height: 620 }, { width: 1280, height: 720 }, { width: 1440, height: 800 }]) {
  const tag = `${vp.width}x${vp.height}`;
  const ctx = await newContext(vp);
  const page = await ctx.newPage();
  const errors = watch(page);
  const frame = await openMockCourse(page, { pid: 'R_fit' + vp.width, rng: 5, seg: 'course-s2', bag: 'DCHPWV' });
  await waitMockLog(page, /received nf-ready/);
  await sleep(300);
  const el = await frame.frameElement();
  const box = await el.boundingBox();
  // Bring the whole game into view, as a participant would, and note the survey page's scroll.
  await page.evaluate((y) => window.scrollTo(0, Math.max(0, window.scrollY + y)), Math.round(box.y - 4));   // box.y is window-relative (prompt 9: the page may already be scrolled)
  await sleep(150);
  const y0 = await page.evaluate(() => window.scrollY);
  const pageScrollable = await page.evaluate(() => document.documentElement.scrollHeight > innerHeight + 50);
  const layout = async () => frame.evaluate(() => {
    const de = document.documentElement, inView = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 0.5 && r.right <= innerWidth + 0.5; };
    const cards = [...document.querySelectorAll('.overlay')].filter((o) => !o.hidden);
    const cardOk = cards.every((o) => [...o.querySelectorAll('button')].filter((b) => !b.hidden).every(inView) && inView(o.querySelector('.cardx')));
    const hud = document.querySelector('.hud').getBoundingClientRect(), leg = document.getElementById('legend').getBoundingClientRect();
    const MX = NeonFairway.MX, game = document.getElementById('game').getBoundingClientRect();
    return { frame: [innerWidth, innerHeight], docScrolls: de.scrollHeight > de.clientHeight + 1 || de.scrollWidth > de.clientWidth + 1,
      cards: cards.map((o) => o.id), cardOk, swingInView: inView(document.getElementById('swing')), hudLegendOverlap: !(hud.bottom <= leg.top || leg.bottom <= hud.top),
      map: [Math.round(game.width), Math.round(game.height)], course: MX && [Math.round(MX.s * (MX.b.maxX - MX.b.minX)), Math.round(MX.s * (MX.b.maxY - MX.b.minY))] };
  });
  const L1 = await layout();
  await shot(page, `fit-${tag}-how-card`);
  // Keys on a card, focus inside the game (the page script focused the iframe on nf-ready).
  const keysOnCard = ['Space', 'ArrowDown', 'PageDown', 'End', 'ArrowUp', 'ArrowRight'];
  for (const k of keysOnCard) { await page.keyboard.press(k); await sleep(40); }
  const yCard = await page.evaluate(() => window.scrollY);
  const stillCard = await frame.evaluate(() => !document.getElementById('howCard').hidden);
  await frame.click('#howBtn');
  const L1b = await layout();
  await shot(page, `fit-${tag}-section-card`);
  await frame.click('#secBtn');
  const L2 = await layout();
  await shot(page, `fit-${tag}-hole-card`);
  await H.teeOff(frame);   // V22: prediction first
  await waitPhase(frame, ['aim']);
  const L3 = await layout();
  // Move focus out to the survey page, then click the map: the game must get the keys again.
  await page.mouse.click(5, Math.max(5, Math.round(box.y - y0) - 15));
  const offAfterOut = await frame.evaluate(() => document.hasFocus());
  const p = await planSwing(frame);
  const off = await frameOffset(page, frame);
  await page.mouse.click(off.x + p.px, off.y + p.py);
  const focusAfterClick = await frame.evaluate(() => ({ hasFocus: document.hasFocus(), active: document.activeElement && document.activeElement.id }));
  const aim0 = await frame.evaluate(() => ({ ...NeonFairway.S.target }));
  const power0 = await frame.evaluate(() => NeonFairway.S.power);
  for (const k of ['ArrowLeft', 'ArrowLeft', 'ArrowDown', 'PageDown', 'End', 'Home', 'PageUp']) { await page.keyboard.press(k); await sleep(40); }
  const aim1 = await frame.evaluate(() => ({ ...NeonFairway.S.target }));
  const power1 = await frame.evaluate(() => NeonFairway.S.power);
  const yAim = await page.evaluate(() => window.scrollY);
  await shot(page, `fit-${tag}-aim`);
  await page.keyboard.press('Space');                                // swings
  await frame.waitForFunction(() => NeonFairway.S.phase === 'fly' || NeonFairway.S.shots.length > 0, null, { timeout: 5000 });
  await waitPhase(frame, ['aim', 'done']);
  const ySwing = await page.evaluate(() => window.scrollY);
  const swung = await frame.evaluate(() => NeonFairway.S.shots.length);
  // The power slider keeps its own arrow keys and doesn't scroll the page at its limit.
  await frame.focus('#powerSlider');
  for (let i = 0; i < 3; i++) { await page.keyboard.press('ArrowRight'); await sleep(30); }
  const ySlider = await page.evaluate(() => window.scrollY);
  await shot(page, `fit-${tag}-after-swing`);

  results.runs['fit-' + tag] = { box, L1, L1b, L2, L3 };
  const layoutOk = [L1, L1b, L2, L3].every((L) => !L.docScrolls && L.cardOk && L.swingInView && !L.hudLegendOverlap);
  report(`Iframe ${tag}: no inner scrolling, cards and SWING fully visible, HUD and map key apart`, layoutOk,
    { iframe: `${Math.round(box.width)}×${Math.round(box.height)}`, map: L3.map, course: L3.course, cards: [L1.cards, L1b.cards, L2.cards] });
  report(`Iframe ${tag}: Space/arrows/PageUp/PageDown/Home/End never scroll the survey page`,
    pageScrollable && yCard === y0 && yAim === y0 && ySwing === y0 && ySlider === y0 && stillCard,
    { pageScrollable, y0, yCard, yAim, ySwing, ySlider });
  report(`Iframe ${tag}: a click on the map focuses the game and the keys reach it`,
    !offAfterOut && focusAfterClick.hasFocus && focusAfterClick.active === 'game' && (aim0.x !== aim1.x || aim0.y !== aim1.y) && power1 === power0 - 5 && swung === 1,
    { offAfterOut, focusAfterClick, aimMoved: aim0.x !== aim1.x, power: [power0, power1], swung });
  if (errors.length) report(`${tag}: console errors`, false, errors.slice(0, 3));
  await ctx.close();
}

// =========================================================================================
// 6. Local testing still works: course-all with the seed card, s1 replay as a new attempt
// =========================================================================================
{
  const ctx = await newContext({ width: 1280, height: 800 });
  const page = await ctx.newPage();
  const errors = watch(page);
  await page.goto(base + '/course.html');
  await page.waitForFunction(() => window.NeonFairway && NeonFairway.S.phase === 'start');
  await page.fill('#seedInput', 'dchpwv');
  await page.click('#startBtn');
  await page.waitForFunction(() => NeonFairway.S.phase === 'card');
  const how = await page.evaluate(() => !document.getElementById('howCard').hidden && document.getElementById('howTitle').textContent === 'HOW TO PLAY');
  await page.click('#howBtn');
  const st = await page.evaluate(() => ({ seg: NFBridge.settings.segment, hole: NeonFairway.S.holeIdx + 1, sec: !document.getElementById('sectionCard').hidden,
    jumps: document.querySelectorAll('#holeJump button').length, header: NFBridge.header('x', 'y') }));
  report('Local testing (no pid): course-all, seed card → How to play → hole 1 with its briefing, 9 hole jumps, records test:true',
    how && st.seg === 'course-all' && st.hole === 1 && st.sec && st.jumps === 9 && st.header.test === true && st.header.game_version === 'V23' && st.header.bag_seed === 'DCHPWV', st);
  if (errors.length) report('local testing: console errors', false, errors.slice(0, 3));
  await ctx.close();
}

results.finished = new Date().toISOString();
results.failed = failed;
if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
