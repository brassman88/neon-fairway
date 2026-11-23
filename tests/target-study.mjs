// Neon Fairway: target.html study-mode tests (prompt 5, Target Practice v38; v39: VERSION, t5 Download data).
//   node tests/target-study.mjs [--browser chromium,firefox,webkit] [--only t1,t2,…] [--out results.json] [--shots folder]
// Needs Playwright and its engines: npm i -D playwright; npx playwright install chromium firefox webkit
// An engine that can't be launched is reported as NOT RUN (exit code 2 if nothing else failed).
//
// t1  Shot math and seeded streams: drawShot() gives exactly NF.rangeLateralDeg + NF.rangeDistance
//     (9 clubs × 21 powers × 40 draws); the same rng gives the same club letters, another rng can differ.
// t2  Determinism: two local tp-all runs with the same rng and the same scripted input (20 practice shots,
//     a 20-shot instant batch, the bag, 5 rounds, round pick) give identical letters, practice shots,
//     round shots and summary; a third run with another rng differs. No Math.random during play;
//     every shot carries zLat / zDist. Local tp-all keeps the round pick, reflection, bag reveal, Play Again.
// t3  0 vs 40 practice shots: round 1 is identical (same rng, same bag, same scripted round), and the same
//     as round 1 of a tp-rounds page given that bag. The 0-shot run is study-mode tp-all: it ends on
//     "All rounds complete" (no pick) and sends both segments' fields after CONTINUE.
// t4  Handoff through test/mock-qualtrics.html at 1100×620 (cross-origin, slow data endpoint):
//     tp-practice → Clubs chosen; Qualtrics moves on only after CONTINUE ("Saving…" meanwhile);
//     tp-rounds shows the same club labels; All rounds complete → CONTINUE → the 7 round fields.
// t5  Lockdown: with a pid, no tester switch, researcher panel or its openers unless debug=1; no
//     NFBag / timing data in localStorage in study mode.
// t6  Errors: missing / invalid bag on tp-rounds, missing / unknown segment → error card + nf-error.
// t7  Iframe fit at 1100×620, 1280×720, 1440×800 in the mock: no scrolling inside the game on any card or
//     course, cards' buttons in view; Space / arrows / PageUp / PageDown / Home / End never scroll the
//     survey page; one click on the map gives the game the keyboard.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO, serve, routes, sleep, firstDiff } from './lib.mjs';
import * as H from './target-helpers.mjs';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch (e) { pw = await import('playwright'); }

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const ENGINES = (opt('--browser') || 'chromium').split(',').map((s) => s.trim()).filter(Boolean);
const ONLY = opt('--only') ? new Set(opt('--only').split(',')) : null;
const OUT = opt('--out');
const SHOTS = opt('--shots');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const run = (t) => !ONLY || ONLY.has(t);
const VERSION = 'v41';
const SAVE_DELAY_MS = 1500;
const PRACTICE_FIELDS = ['tp_bag', 'tp_letters', 'tp_practice_shots', 'tp_est_d', 'tp_est_h', 'tp_est_w'];
const ROUND_FIELDS = ['tp_r1', 'tp_r2', 'tp_r3', 'tp_r4', 'tp_r5', 'tp_total', 'tp_best_aims'];

const { server, base } = await serve({ '/': REPO });
const port = new URL(base).port;
const MOCK = `http://127.0.0.1:${port}/test/mock-qualtrics.html`;   // the game loads from localhost: cross-origin
const ENDPOINT = `http://127.0.0.1:${port}/__save`;

const results = { started: new Date().toISOString(), version: VERSION, engines: {}, tests: [], runs: {} };
let failed = 0, notRun = 0;
function report(engine, name, ok, detail) {
  results.tests.push({ engine, name, ok, detail });
  if (!ok) failed++;
  const d = detail == null ? '' : '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail));
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${engine}] ${name}${d.length > 600 ? d.slice(0, 600) + '…' : d}`);
}

for (const engine of ENGINES) {
  let browser;
  try {
    browser = await pw[engine].launch(engine === 'chromium' ? { args: ['--host-resolver-rules=MAP localhost 127.0.0.1'] } : {});
  } catch (e) {
    notRun++;
    results.engines[engine] = { run: false, reason: String(e.message || e).split('\n')[0] };
    console.log(`NOT RUN  [${engine}] can't launch: ${results.engines[engine].reason}`);
    continue;
  }
  results.engines[engine] = { run: true, version: browser.version() };
  console.log(`\n=== ${engine} ${browser.version()} ===`);
  const R = (name, ok, detail) => report(engine, name, ok, detail);
  const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${engine}-${name}.png`) }); };

  async function newPage(viewport = { width: 1280, height: 900 }, { endpoint = false, countRandom = false } = {}) {
    const context = await browser.newContext({ viewport });
    await routes(context);
    const posts = [];
    if (endpoint) {
      await context.route(/\/__save$/, async (route) => {
        posts.push({ at: Date.now(), body: route.request().postData() });
        await sleep(SAVE_DELAY_MS);
        await route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'Access-Control-Allow-Origin': '*' }, body: 'ok' });
      });
      await context.addInitScript((ep) => { window.NF_BRIDGE_CONFIG = { DATA_ENDPOINT: ep }; }, ENDPOINT);
    }
    if (countRandom) {
      await context.addInitScript(() => {
        const orig = Math.random; window.__mathRandomCalls = 0;
        Math.random = function () { window.__mathRandomCalls++; return orig(); };
      });
    }
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    return { context, page, errors, posts };
  }
  const noErrors = (label, errors) => { if (errors.length) R(`${label}: console errors`, false, errors.slice(0, 4)); };
  const open = async (page, query) => {
    await page.goto(base + '/target.html' + query);
    await page.waitForFunction(() => window.TargetPractice && window.NFBridge, null, { timeout: 15000 });
    return page.mainFrame();
  };

  // ======================================================================================
  // t1. Shot math and seeded streams
  // ======================================================================================
  if (run('t1')) {
    const { context, page, errors } = await newPage();
    const f = await open(page, '?pid=R_unit&segment=tp-practice&rng=99');
    const math = await f.evaluate(() => {
      let n = 0, bad = null, zMax = 0;
      CLUB_TYPES.forEach((t) => SPREAD_VARIETIES.forEach((v) => {
        const stats = buildClubStats(t, v);
        for (let p = 1; p <= 100; p += (p === 1 ? 4 : 5)) {
          const a = NF.rng(1000 + p), b = NF.rng(1000 + p);
          for (let i = 0; i < 40; i++) {
            const d = drawShot(stats, p, a);
            const lat = getLateralOffsetDeg(stats, p, b), dist = getDistance(stats, p, b);
            n++; zMax = Math.max(zMax, Math.abs(d.zLat), Math.abs(d.zDist));
            if (!bad && (!Object.is(d.offsetDeg, lat) || !Object.is(d.distance, dist))) bad = { club: t.key + '-' + v.key, p, i, d, lat, dist };
          }
        }
      }));
      return { n, bad, zMax };
    });
    R('t1 drawShot() = NF.rangeLateralDeg + NF.rangeDistance exactly (same stream), zLat/zDist within ±3', !math.bad && math.n === 9 * 21 * 40 && math.zMax <= 3, math);
    const lettersOf = (f) => f.evaluate(() => TargetPractice.state.practiceClubs.map((c) => c.label + '=' + c.variety.key).join(' '));
    const l1 = await lettersOf(f);
    await open(page, '?pid=R_unit&segment=tp-practice&rng=99');
    const l2 = await lettersOf(page.mainFrame());
    const others = [];
    for (const r of [100, 101, 102, 103]) { await open(page, `?pid=R_unit&segment=tp-practice&rng=${r}`); others.push(await lettersOf(page.mainFrame())); }
    R('t1 same rng → same club letters on a fresh load; other rngs give other letter orders', l1 === l2 && others.some((o) => o !== l1), { rng99: l1, differentFor: others.filter((o) => o !== l1).length + '/4' });
    noErrors('t1', errors);
    await context.close();
  }

  // ======================================================================================
  // t2. Determinism: same rng + same input = same game
  // ======================================================================================
  const BAG_LABELS = ['Driver B', 'Hybrid A', 'Wedge C'];
  async function fullLocalRun(rng, { rounds = 5 } = {}) {
    const { context, page, errors } = await newPage({ width: 1280, height: 900 }, { countRandom: true });
    const f = await open(page, `?rng=${rng}`);
    await f.click('#tp-startPracticeBtn');
    await f.evaluate(() => { window.__mathRandomCalls = 0; });
    await H.practiceScript(f, { n: 20, batchShots: 20 });
    const letters = await f.evaluate(() => TargetPractice.state.practiceClubs.map((c) => c.label + '=' + c.variety.key));
    const practice = await H.allShots(f);
    await H.chooseClubs(f, BAG_LABELS);
    const roundShots = await H.playRounds(f, rounds);
    const out = { letters, practice, roundShots, mathRandom: await f.evaluate(() => window.__mathRandomCalls), errors };
    if (rounds === 5) {
      out.after = await H.visibleOverlays(f);
      await f.click('#tp-roundCards .round-card[data-round="2"]');
      await f.fill('#tp-reflectText', 'Round two felt like my usual game.');
      await f.click('#tp-confirmRoundBtn');
      await f.waitForFunction(() => window.NF_LAST_SUMMARY, null, { timeout: 15000 });
      out.done = await f.evaluate(() => ({ donePane: !document.getElementById('tp-donePane').hidden, reveal: document.getElementById('tp-bagReveal').textContent.includes('REVEALED'),
        playAgain: !document.getElementById('tp-playAgainBtn').hidden, summary: window.NF_LAST_SUMMARY.summary, sent: NFBridge.sent().map((s) => s.msg.type),
        bagStored: !!localStorage.getItem('neonFairway.bag.v2'), rounds: TargetPractice.state.rounds.map((r) => r.score) }));
    }
    await context.close();
    return out;
  }
  if (run('t2')) {
    const A = await fullLocalRun(4242), B = await fullLocalRun(4242), C = await fullLocalRun(4243, { rounds: 1 });
    results.runs.t2 = { A: { letters: A.letters, practice: A.practice.length, rounds: A.roundShots.map((r) => r.length), summary: A.done && A.done.summary } };
    R('t2 same rng: identical club letters', !firstDiff(A.letters, B.letters), A.letters.join(' '));
    R('t2 same rng + input: identical practice shots (20 single + 20 batch)', A.practice.length === 40 && !firstDiff(A.practice, B.practice), firstDiff(A.practice, B.practice) || `${A.practice.length} shots`);
    R('t2 same rng + input: identical shots in all 5 rounds (60 balls)', A.roundShots.flat().length === 60 && !firstDiff(A.roundShots, B.roundShots), firstDiff(A.roundShots, B.roundShots) || 'scores ' + A.done.rounds.join(', '));
    R('t2 same rng + input: identical summary', !firstDiff(A.done.summary, B.done.summary), A.done.summary);
    R('t2 another rng: different letters or practice shots, and different round-1 shots', (firstDiff(A.letters, C.letters) || firstDiff(A.practice, C.practice)) && !!firstDiff(A.roundShots[0], C.roundShots[0]), { rng4243: C.letters.join(' ') });
    const allZ = [...A.practice, ...A.roundShots.flat()].every((s) => Number.isFinite(s.zLat) && Number.isFinite(s.zDist) && Math.abs(s.zLat) <= 3 && Math.abs(s.zDist) <= 3);
    R('t2 every shot (practice, batch, round) carries zLat / zDist; no Math.random during play', allZ && A.mathRandom === 0 && B.mathRandom === 0, { mathRandomCalls: [A.mathRandom, B.mathRandom] });
    const keys = Object.keys(A.done.summary).sort();
    R('t2 local tp-all: round pick + reflection → Session Complete with bag reveal and Play Again; nf-done with all 13 fields; bag kept in localStorage as before',
      A.after.join() === 'tp-finalOverlay' && A.done.donePane && A.done.reveal && A.done.playAgain && A.done.sent.includes('nf-done') && A.done.bagStored &&
      keys.join() === [...PRACTICE_FIELDS, ...ROUND_FIELDS].sort().join() && A.done.summary.tp_total === A.done.rounds.reduce((a, b) => a + b, 0) && A.done.summary.tp_letters === 'B,A,C',
      { after: A.after, summary: A.done.summary });
    noErrors('t2', [...A.errors, ...B.errors, ...C.errors]);
  }

  // ======================================================================================
  // t3. 0 vs 40 practice shots don't change round 1; tp-rounds plays the same round 1
  // ======================================================================================
  if (run('t3')) {
    const RNG = 777;
    // X: study-mode tp-all, 0 practice shots, all 5 rounds, ends on "All rounds complete".
    const X = await newPage({ width: 1280, height: 900 }, { endpoint: true });   // slow endpoint: "Saving…" can be seen
    let f = await open(X.page, `?pid=R_zero&segment=tp-all&rng=${RNG}`);
    await f.click('#tp-startPracticeBtn');
    await H.chooseClubs(f, BAG_LABELS);
    const xInfo = await f.evaluate(() => ({ practice: TargetPractice.state.practice.shots, seed: TargetPractice.state.seed, letters: TargetPractice.state.bag.map((c) => c.letter).join(','),
      buttons: [...document.querySelectorAll('#tp-clubButtons button')].map((b) => b.textContent) }));
    const xRounds = await H.playRounds(f, 5);
    const xEnd = await H.visibleOverlays(f);
    const endText = await f.evaluate(() => ({ title: document.getElementById('tp-endTitle').textContent, cards: document.querySelectorAll('#tp-endCards .round-card').length,
      pick: !document.getElementById('tp-finalOverlay').hidden, sentBefore: NFBridge.sent().map((s) => s.msg.type) }));
    await f.click('#tp-endContinueBtn');
    const saving = await f.evaluate(() => ({ text: document.getElementById('tp-endContinueBtn').textContent, disabled: document.getElementById('tp-endContinueBtn').disabled }));
    await f.waitForFunction(() => window.NF_LAST_SUMMARY, null, { timeout: 15000 });
    const xDone = await f.evaluate(() => ({ summary: NF_LAST_SUMMARY.summary, ls: Object.keys(localStorage).filter((k) => k.startsWith('neonFairway')), btn: document.getElementById('tp-endContinueBtn').textContent }));
    R('t3 study tp-all (pid, 0 practice shots): ends on "All rounds complete" (no round pick); nothing sent until CONTINUE; then nf-done with both segments\' 13 fields',
      xInfo.practice === 0 && xEnd.join() === 'tp-endOverlay' && !endText.pick && endText.cards === 5 && !endText.sentBefore.includes('nf-done') && saving.text === 'Saving…' && saving.disabled &&
      Object.keys(xDone.summary).sort().join() === [...PRACTICE_FIELDS, ...ROUND_FIELDS].sort().join() && xDone.summary.tp_practice_shots === 0 && xDone.ls.length === 0,
      { end: endText.title, overlays: xEnd, pick: endText.pick, cards: endText.cards, sentBefore: endText.sentBefore, button: saving, summary: xDone.summary, localStorage: xDone.ls });
    noErrors('t3 X', X.errors);
    await X.context.close();

    // Y: local tp-all, 40 practice shots (20 single + 20 batch), same bag, round 1.
    const Y = await newPage();
    f = await open(Y.page, `?rng=${RNG}`);
    await f.click('#tp-startPracticeBtn');
    await H.practiceScript(f, { n: 20, batchShots: 20 });
    const yPractice = await f.evaluate(() => TargetPractice.state.practice.shots);
    await H.chooseClubs(f, BAG_LABELS);
    const ySeed = await f.evaluate(() => TargetPractice.state.seed);
    const yRound1 = await H.playRound(f);
    noErrors('t3 Y', Y.errors);
    await Y.context.close();
    R('t3 0 vs 40 practice shots (same rng, same bag, same scripted round): round 1 shots identical',
      yPractice === 40 && ySeed === xInfo.seed && !firstDiff(xRounds[0], yRound1), firstDiff(xRounds[0], yRound1) || { practiceShots: [0, yPractice], bag: ySeed, round1: yRound1.map((s) => s.result + ' ' + s.points).join(', ') });

    // Z: tp-rounds page with that bag and letters.
    const Z = await newPage();
    f = await open(Z.page, `?pid=R_z&segment=tp-rounds&rng=${RNG}&bag=${xInfo.seed}&letters=${xInfo.letters}`);
    const zIntro = await f.evaluate(() => ({ title: document.getElementById('tp-introTitle').textContent, text: document.getElementById('tp-introSteps').textContent,
      buttons: [...document.querySelectorAll('#tp-clubButtons button')].map((b) => b.textContent), match: TargetPractice.lettersMatch() }));
    await f.click('#tp-startPracticeBtn');
    const zRound1 = await H.playRound(f);
    noErrors('t3 Z', Z.errors);
    await Z.context.close();
    R('t3 tp-rounds with that bag: same labels ("Driver B" …), letters match the rng, intro card lists them, round 1 identical to tp-all\'s',
      !firstDiff(zIntro.buttons, xInfo.buttons) && zIntro.match === true && zIntro.title === 'Scored Rounds' && BAG_LABELS.every((l) => zIntro.text.includes(l)) && !firstDiff(xRounds[0], zRound1),
      firstDiff(xRounds[0], zRound1) || { buttons: zIntro.buttons, lettersMatch: zIntro.match });
  }

  // ======================================================================================
  // Layout check used by t4 and t7 (inside the game frame)
  // ======================================================================================
  const layout = (f) => f.evaluate(() => {
    const de = document.documentElement;
    const inView = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.top >= -0.5 && r.left >= -0.5 && r.bottom <= innerHeight + 0.5 && r.right <= innerWidth + 0.5; };
    const overlays = [...document.querySelectorAll('.overlay')].filter((o) => !o.hidden);
    const cardsOk = overlays.every((o) => { const m = o.querySelector('.modal'); return inView(m) && m.scrollHeight <= m.clientHeight + 1 && [...m.querySelectorAll('button')].filter((b) => b.offsetParent).every(inView); });
    const ids = ['tp-birdCanvas', 'tp-takeShotBtn', 'tp-resultPanel', 'tp-logTitle', 'tp-powerSlider', 'tp-aimStraight'];
    const offscreen = ids.filter((id) => { const e = document.getElementById(id); return e && e.offsetParent && !inView(e); });
    ['tp-endPracticeBtn', 'tp-batchAllBtn', 'tp-editEstimateBtn'].forEach((id) => { const e = document.getElementById(id); if (e && e.offsetParent && !inView(e)) offscreen.push(id); });
    const vals = document.querySelector('.values-view').getBoundingClientRect(), list = document.getElementById('tp-targetCards').getBoundingClientRect();
    return { frame: [innerWidth, innerHeight], docScrolls: de.scrollHeight > de.clientHeight + 1 || de.scrollWidth > de.clientWidth + 1,
      overlays: overlays.map((o) => o.id), cardsOk, offscreen, valuesClipped: list.bottom > vals.bottom + 0.5,
      map: (() => { const r = document.getElementById('tp-birdCanvas').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })() };
  });
  const layoutOk = (L) => !L.docScrolls && L.cardsOk && !L.offscreen.length && !L.valuesClipped;

  // ======================================================================================
  // t4. tp-practice → tp-rounds through the mock Qualtrics page
  // ======================================================================================
  if (run('t4')) {
    const { context, page, errors, posts } = await newPage({ width: 1100, height: 620 }, { endpoint: true });
    const layouts = [];
    const check = async (f, label) => { const L = await layout(f); layouts.push({ label, ...L }); return L; };
    let f = await H.openMockTarget(page, MOCK, { pid: 'R_hand_' + engine, rng: 5150, seg: 'tp-practice' });
    await H.waitMockLog(page, /received nf-ready/);
    const src1 = new URL(await page.evaluate(() => MOCKQ.iframeSrc));
    await check(f, 'practice intro');
    await f.click('#tp-startPracticeBtn');
    await H.practiceScript(f, { n: 12 });
    await check(f, 'practice');
    const LABELS = ['Driver C', 'Hybrid B', 'Wedge A'];
    await H.chooseClubs(f, LABELS);
    await H.waitPhase(f, ['chosen']);
    const chosen = await f.evaluate(() => ({ overlays: [...document.querySelectorAll('.overlay')].filter((o) => !o.hidden).map((o) => o.id), list: document.getElementById('tp-chosenList').textContent,
      seed: TargetPractice.state.seed, est: TargetPractice.state.bag.map((c) => c.estimate), shots: TargetPractice.state.practice.shots, ls: Object.keys(localStorage).filter((k) => k.startsWith('neonFairway')) }));
    await check(f, 'clubs chosen');
    await shot(page, 't4-clubs-chosen');
    await sleep(2500);
    const before = await H.mockState(page);
    await f.click('#tp-chosenContinueBtn');
    const saving = await f.evaluate(() => { const b = document.getElementById('tp-chosenContinueBtn'); return { text: b.textContent, disabled: b.disabled }; });
    await shot(page, 't4-saving');
    await H.waitMockLog(page, /Would click Next/, 20000);
    const after = await H.mockState(page);
    const done1 = after.received.find((m) => m.data.type === 'nf-done');
    R('t4 tp-practice: "Clubs chosen" lists the 3 clubs; Qualtrics doesn\'t move on before CONTINUE; then "Saving…" (disabled) until the save answers',
      chosen.overlays.join() === 'tp-chosenOverlay' && LABELS.every((l) => chosen.list.includes(l)) && before.nextClicks === 0 && !before.received.some((m) => m.data.type === 'nf-done') &&
      saving.text === 'Saving…' && saving.disabled && after.nextClicks === 1 && posts.length >= 1,
      { waitedMs: 2500, nextClicksBefore: before.nextClicks, button: saving, saves: posts.length });
    const ed1 = after.ed;
    R('t4 tp-practice: nf-done carries exactly tp_bag, tp_letters, tp_practice_shots, tp_est_d/h/w, and Qualtrics saved them (saved=1, attempt=1)',
      done1 && Object.keys(done1.data.summary).sort().join() === [...PRACTICE_FIELDS].sort().join() && ed1.tp_bag === chosen.seed && ed1.tp_letters === 'C,B,A' &&
      ed1.tp_practice_shots === '12' && [ed1.tp_est_d, ed1.tp_est_h, ed1.tp_est_w].join() === chosen.est.join() && ed1.tp_practice_saved === '1' && ed1.tp_practice_attempt === '1' && ed1.tp_practice_failed === '0' &&
      src1.searchParams.get('segment') === 'tp-practice' && chosen.ls.length === 0,
      { summary: done1 && done1.data.summary, saved: [ed1.tp_practice_saved, ed1.tp_practice_attempt, ed1.tp_practice_failed], localStorage: chosen.ls });

    // Next page: tp-rounds, with tp_bag / tp_letters from the embedded data.
    f = await H.openMockTarget(page, MOCK, { seg: 'tp-rounds', fresh: false });
    await H.waitMockLog(page, /received nf-ready/);
    const src2 = new URL(await page.evaluate(() => MOCKQ.iframeSrc));
    const r0 = await f.evaluate(() => ({ buttons: [...document.querySelectorAll('#tp-clubButtons button')].map((b) => b.textContent), intro: document.getElementById('tp-introSteps').textContent,
      match: TargetPractice.lettersMatch(), header: NFBridge.header('x', 'y') }));
    await check(f, 'rounds intro');
    await shot(page, 't4-rounds-intro');
    R('t4 tp-rounds: bag and letters arrive in the URL; club buttons and the intro card use the chosen labels; letters match; records carry bag_seed',
      src2.searchParams.get('bag') === ed1.tp_bag && src2.searchParams.get('letters') === 'C,B,A' && !firstDiff(r0.buttons, LABELS) && LABELS.every((l) => r0.intro.includes(l)) &&
      r0.match === true && r0.header.bag_seed === ed1.tp_bag && r0.header.game_version === VERSION && r0.header.segment === 'tp-rounds',
      { url: { bag: src2.searchParams.get('bag'), letters: src2.searchParams.get('letters') }, buttons: r0.buttons, lettersMatch: r0.match });
    await f.click('#tp-startPracticeBtn');
    await H.waitPhase(f, ['predict']);
    await check(f, 'round 1 prediction');   // v40
    await H.startRoundPlay(f);
    await check(f, 'round 1');
    const rounds = [];
    for (let r = 0; r < 5; r++) {
      rounds.push(await H.playRound(f));
      const next = await H.waitAfterRound(f);
      await check(f, next === 'tp-roundOverlay' ? `after round ${r + 1}` : 'all rounds complete');
      if (next === 'tp-roundOverlay') await f.click('#tp-nextRoundBtn');
    }
    await shot(page, 't4-all-rounds-complete');
    const end = await f.evaluate(() => ({ overlays: [...document.querySelectorAll('.overlay')].filter((o) => !o.hidden).map((o) => o.id), scores: TargetPractice.state.rounds.map((r) => r.score),
      best: TargetPractice.state.rounds.reduce((a, r) => a + r.bestShots, 0) }));
    await sleep(2500);
    const before2 = await H.mockState(page);
    await f.click('#tp-endContinueBtn');
    const saving2 = await f.evaluate(() => { const b = document.getElementById('tp-endContinueBtn'); return { text: b.textContent, disabled: b.disabled }; });
    await page.waitForFunction(() => MOCKQ.nextClicks === 1, null, { timeout: 20000 });
    const after2 = await H.mockState(page);
    const done2 = after2.received.find((m) => m.data.type === 'nf-done');
    const ed2 = after2.ed;
    R('t4 tp-rounds: "All rounds complete" after round 5; Qualtrics moves on only after CONTINUE ("Saving…" meanwhile)',
      end.overlays.join() === 'tp-endOverlay' && before2.nextClicks === 0 && !before2.received.some((m) => m.data.type === 'nf-done') && saving2.text === 'Saving…' && saving2.disabled && after2.nextClicks === 1,
      { button: saving2 });
    R('t4 tp-rounds: nf-done carries exactly tp_r1..tp_r5, tp_total, tp_best_aims; total = sum; earlier tp_ fields kept',
      done2 && Object.keys(done2.data.summary).sort().join() === [...ROUND_FIELDS].sort().join() && end.scores.every((s, i) => ed2['tp_r' + (i + 1)] === String(s)) &&
      +ed2.tp_total === end.scores.reduce((a, b) => a + b, 0) && +ed2.tp_best_aims === end.best && ed2.tp_bag === ed1.tp_bag && ed2.tp_letters === 'C,B,A' && ed2.tp_rounds_saved === '1' && ed2.tp_rounds_attempt === '1',
      { scores: end.scores, tp_total: ed2.tp_total, tp_best_aims: ed2.tp_best_aims });
    results.runs.t4 = { layouts };
    const badL = layouts.filter((L) => !layoutOk(L));
    R('t4 at 1100×620: no scrolling inside the game on any screen; cards, map and controls fully visible', !badL.length, badL.length ? badL : layouts.map((L) => L.label + ' ' + L.frame.join('×') + ' map ' + L.map.join('×')).join(' · '));
    noErrors('t4', errors);
    await context.close();
  }

  // ======================================================================================
  // t5. Lockdown
  // ======================================================================================
  if (run('t5')) {
    const cases = [
      { q: '?pid=R_l1&segment=tp-practice', tools: false, tester: false },
      { q: '?pid=R_l2&segment=tp-rounds&bag=DCHPWV&letters=A,B,C', tools: false, tester: false },
      { q: '?pid=R_l3&segment=tp-all', tools: false, tester: false },
      { q: '?pid=R_l4&segment=tp-all&debug=1', tools: true, tester: true },
      { q: '?pid=R_l5&segment=tp-practice&debug=1', tools: true, tester: false },
      { q: '', tools: true, tester: true }
    ];
    for (const c of cases) {
      const { context, page, errors } = await newPage();
      const f = await open(page, c.q);
      // v39: the bar above the game also holds "Download data" (debug only), so it shows whenever debug is on.
      const st = await f.evaluate(() => ({ tester: !document.getElementById('testerSwitchBtn').hidden, nav: !document.querySelector('.mode-tabs').hidden,
        download: !document.getElementById('dlDataBtn').hidden,
        panelInDom: !!document.getElementById('researchPanel'), timing: typeof window.NF_TIMING !== 'undefined', playAgain: !document.getElementById('tp-playAgainBtn').hidden }));
      await page.keyboard.press('Alt+Shift+KeyT');
      await sleep(100);
      const altOpen = await f.evaluate(() => { const p = document.getElementById('researchPanel'); return !!(p && !p.hidden); });
      if (altOpen) { await page.keyboard.press('Alt+Shift+KeyT'); await sleep(100); }
      await f.evaluate(() => { const t = document.querySelector('.brand-neon'); for (let i = 0; i < 5; i++) t.click(); });
      await sleep(100);
      const clickOpen = await f.evaluate(() => { const p = document.getElementById('researchPanel'); return !!(p && !p.hidden); });
      const study = c.q.includes('pid=');
      const ok = st.tester === c.tester && st.nav === c.tools && st.download === c.tools && st.panelInDom === c.tools && st.timing === c.tools && altOpen === c.tools && clickOpen === c.tools && st.playAgain === !study;
      R(`t5 ${c.q || '(no pid)'}: tester switch ${c.tester ? 'shown' : 'hidden'}, researcher panel + openers + Download data ${c.tools ? 'available' : 'gone'}, Play Again ${study ? 'hidden' : 'kept'}`, ok, { ...st, altOpen, clickOpen });
      noErrors('t5 ' + c.q, errors);
      await context.close();
    }
    // Storage: study mode never writes the bag, sessions or timing; local testing still does.
    for (const q of ['?pid=R_ls&segment=tp-practice', '?pid=R_ls2&segment=tp-all', '?segment=tp-practice']) {
      const { context, page, errors } = await newPage();
      const f = await open(page, q + '&rng=3');
      await f.click('#tp-startPracticeBtn');
      await H.shoot(f, { club: 0, power: 80, aim: 0 });
      await sleep(1200);   // let the timer tick (it saves every few seconds when it runs)
      await H.chooseClubs(f, ['Driver A', 'Hybrid A', 'Wedge A']);
      await sleep(5500);
      const keys = await f.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('neonFairway')));
      const study = q.includes('pid=');
      R(`t5 ${q}: localStorage ${study ? 'has no neonFairway.* keys (NFBag, timing)' : 'still keeps the bag and timing (local testing)'}`,
        study ? keys.length === 0 : keys.includes('neonFairway.bag.v2') && keys.includes('neonFairway.timing.v1'), { keys });
      noErrors('t5 storage ' + q, errors);
      await context.close();
    }
  }

  // ======================================================================================
  // t6. Errors
  // ======================================================================================
  if (run('t6')) {
    for (const c of [{ bag: null, label: 'missing bag' }, { bag: 'DCHPWX', label: 'invalid bag' }]) {
      const { context, page, errors } = await newPage();
      const f = await H.openMockTarget(page, MOCK, { pid: 'R_err_' + c.label.replace(' ', '_'), rng: 1, seg: 'tp-rounds', bag: c.bag, letters: 'A,B,C' });
      await H.waitMockLog(page, /received nf-error/);
      const g = await f.evaluate(() => ({ overlays: [...document.querySelectorAll('.overlay')].filter((o) => !o.hidden).map((o) => o.id), code: document.getElementById('tp-errCode').textContent, sent: NFBridge.sent().map((s) => s.msg.type) }));
      const m = await H.mockState(page);
      const problem = await page.evaluate(() => getComputedStyle(document.getElementById('nf-problem')).display !== 'none');
      await shot(page, `t6-${c.label.replace(' ', '-')}`);
      R(`t6 tp-rounds, ${c.label}: error card (BAG), nf-error BAG reaches the survey page, which offers a way on; no nf-ready`,
        g.overlays.join() === 'tp-errorOverlay' && g.code === 'BAG' && m.received.some((x) => x.data.type === 'nf-error' && x.data.code === 'BAG') && problem && !g.sent.includes('nf-ready'), { ...g, problem });
      noErrors('t6 ' + c.label, errors);
      await context.close();
    }
    for (const c of [{ q: '?pid=R_e1', code: 'SEGMENT', label: 'pid without segment' }, { q: '?pid=R_e2&segment=tp-bogus', code: 'SEGMENT', label: 'unknown segment' },
      { q: '?segment=tp-rounds', code: 'BAG', label: 'local tp-rounds without bag' }]) {
      const { context, page } = await newPage();
      const f = await open(page, c.q);
      const g = await f.evaluate(() => ({ overlays: [...document.querySelectorAll('.overlay')].filter((o) => !o.hidden).map((o) => o.id), code: document.getElementById('tp-errCode').textContent,
        sent: NFBridge.sent().map((s) => s.msg.type + (s.msg.code ? ':' + s.msg.code : '')), help: document.getElementById('tp-errHelp').textContent }));
      R(`t6 ${c.label}: error card + nf-error ${c.code}`, g.overlays.join() === 'tp-errorOverlay' && g.code === c.code && g.sent.join() === 'nf-error:' + c.code, g);
      await context.close();
    }
  }

  // ======================================================================================
  // t7. Iframe fit, keys and focus at three window sizes
  // ======================================================================================
  if (run('t7')) {
    for (const vp of [{ width: 1100, height: 620 }, { width: 1280, height: 720 }, { width: 1440, height: 800 }]) {
      const tag = `${vp.width}x${vp.height}`;
      const { context, page, errors } = await newPage(vp);
      const layouts = [];
      const check = async (f, label) => { const L = await layout(f); layouts.push({ label, ...L }); if (SHOTS && /intro|Laser|bag|estimate|prediction/.test(label)) await shot(page, `t7-${tag}-${label.replace(/\W+/g, '-')}`); return L; };
      let f = await H.openMockTarget(page, MOCK, { pid: 'R_fit' + vp.width, rng: 21, seg: 'tp-practice' });
      await H.waitMockLog(page, /received nf-ready/);
      await sleep(200);
      const box = await (await f.frameElement()).boundingBox();
      await page.evaluate((y) => window.scrollTo(0, Math.max(0, window.scrollY + y)), Math.round(box.y - 4));   // box.y is window-relative (prompt 9: the page may already be scrolled)
      await sleep(150);
      const y0 = await page.evaluate(() => window.scrollY);
      const pageScrollable = await page.evaluate(() => document.documentElement.scrollHeight > innerHeight + 50);
      await check(f, 'practice intro');
      // Keys on the intro card (the survey page focused the iframe on nf-ready; click the card's backdrop first).
      const off0 = await H.frameOffset(page, f);
      await page.mouse.click(off0.x + 6, off0.y + box.height - 6);
      for (const k of ['Space', 'ArrowDown', 'PageDown', 'End', 'ArrowUp', 'ArrowRight', 'Space']) { await page.keyboard.press(k); await sleep(40); }
      const yCard = await page.evaluate(() => window.scrollY);
      const stillIntro = await f.evaluate(() => !document.getElementById('tp-introOverlay').hidden);
      await f.click('#tp-startPracticeBtn');
      for (const c of ['sunset', 'pines', 'comet', 'laser', 'nova']) {
        await f.click(`#tp-courseButtons button[data-course="${c}"]`);
        await check(f, 'practice ' + c);
      }
      // Focus: click the survey page, then one click on the map; the keys must reach the game.
      await page.mouse.click(6, Math.max(6, Math.round(box.y - y0) - 12));
      const outFocus = await f.evaluate(() => document.hasFocus());
      const cv = await (await f.$('#tp-birdCanvas')).boundingBox();
      const offA = await H.frameOffset(page, f);
      await page.mouse.click(cv.x + cv.width * 0.55, cv.y + cv.height * 0.35);
      const a0 = await f.evaluate(() => ({ aim: TargetPractice.state.aimAngle, power: TargetPractice.state.power, focus: document.hasFocus() }));
      for (const k of ['ArrowLeft', 'ArrowLeft', 'ArrowDown', 'PageDown', 'End', 'Home', 'PageUp']) { await page.keyboard.press(k); await sleep(40); }
      const a1 = await f.evaluate(() => ({ aim: TargetPractice.state.aimAngle, power: TargetPractice.state.power }));
      const yAim = await page.evaluate(() => window.scrollY);
      await page.keyboard.press('Space');
      await f.waitForFunction(() => TargetPractice.state.practice.shots === 1 && TargetPractice.state.phase !== 'animating', null, { timeout: 10000 });
      const ySwing = await page.evaluate(() => window.scrollY);
      // A slider keeps its arrow keys and doesn't scroll the page at its limit.
      await f.focus('#tp-powerSlider');
      for (let i = 0; i < 4; i++) { await page.keyboard.press('ArrowRight'); await sleep(30); }
      const ySlider = await page.evaluate(() => window.scrollY);
      R(`t7 ${tag}: Space / arrows / PageUp / PageDown / Home / End never scroll the survey page (card, aiming, shot, slider)`,
        pageScrollable && yCard === y0 && yAim === y0 && ySwing === y0 && ySlider === y0 && stillIntro, { pageScrollable, y0, yCard, yAim, ySwing, ySlider });
      R(`t7 ${tag}: after focus leaves the game, one click on the map gives it the keyboard (←← aim −2°, ↓ power −5, Space shoots)`,
        !outFocus && a0.focus && Math.abs(a1.aim - (a0.aim - 2)) < 1e-9 && a1.power === a0.power - 5, { outFocus, a0, a1 });
      // Five shots with one club → the estimate card; a batch with another → its estimate card.
      for (let i = 0; i < 4; i++) await f.click('#tp-takeShotBtn').then(() => f.waitForFunction(() => TargetPractice.state.phase !== 'animating', null, { timeout: 10000 }));
      await H.waitPhase(f, ['estimate']);
      await check(f, 'estimate (auto)');
      await H.answerEstimate(f, 120);
      await f.click('#tp-clubButtons button[data-club="4"]');
      await f.click('#tp-batchAllBtn');
      await H.waitPhase(f, ['estimate']);
      await check(f, 'estimate after batch');
      await H.answerEstimate(f, 130);
      await check(f, 'practice after batch');
      await f.click('#tp-endPracticeBtn');
      await check(f, 'nudge');
      await f.click('#tp-chooseAnywayBtn');
      await check(f, 'estimate (final)');
      while (await f.isVisible('#tp-estimateOverlay')) await H.answerEstimate(f, 100);
      await check(f, 'bag chooser');
      for (const l of ['Driver A', 'Hybrid B', 'Wedge C']) await f.click(`#tp-bagSections .bag-card[data-label="${l}"]`);
      await check(f, 'bag chooser picked');
      await f.click('#tp-confirmBagBtn');
      await check(f, 'clubs chosen');
      await f.click('#tp-chosenContinueBtn');
      await page.waitForFunction(() => MOCKQ.nextClicks === 1, null, { timeout: 20000 });

      f = await H.openMockTarget(page, MOCK, { seg: 'tp-rounds', fresh: false });
      await H.waitMockLog(page, /received nf-ready/);
      await check(f, 'rounds intro');
      await f.click('#tp-startPracticeBtn');
      await H.waitPhase(f, ['predict']);
      await check(f, 'prediction round 1');   // v40
      await H.startRoundPlay(f);
      await check(f, 'round 1 (' + await f.evaluate(() => TargetPractice.state.layout.name) + ')');
      await H.playRound(f);
      await H.waitAfterRound(f);
      await check(f, 'round 1 complete');
      await f.click('#tp-nextRoundBtn');
      await H.startRoundPlay(f);
      await check(f, 'round 2 (' + await f.evaluate(() => TargetPractice.state.layout.name) + ')');
      results.runs['t7-' + tag] = { box, layouts };
      const bad = layouts.filter((L) => !layoutOk(L));
      R(`t7 ${tag}: no scrolling inside the game on any screen (intro, 5 practice courses, estimates, nudge, bag chooser, clubs chosen, rounds intro, rounds, round complete); cards, map and controls fully visible`,
        !bad.length, bad.length ? bad : `iframe ${Math.round(box.width)}×${Math.round(box.height)} · map ${layouts[1].map.join('×')} · ${layouts.length} screens`);
      noErrors('t7 ' + tag, errors);
      await context.close();
    }
  }
  await browser.close();
}

results.finished = new Date().toISOString();
results.failed = failed;
results.notRun = notRun;
if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(failed ? `\n${failed} FAILED` : (notRun ? `\nALL RUN TESTS PASSED · ${notRun} engine(s) NOT RUN` : '\nALL PASSED'));
server.close();
process.exit(failed ? 1 : (notRun ? 2 : 0));
