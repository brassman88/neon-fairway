// Neon Fairway: course.html prompt 8 tests (course V22): hole predictions, the fb-hidden condition,
// hidden-tab time and replay tries.
//   node tests/course-predict.mjs [--browser chromium,firefox,webkit] [--out results.json] [--shots folder]
// Needs Playwright and its engines (npm i -D playwright; npx playwright install chromium firefox webkit).
// An engine that can't be launched is reported as NOT RUN (exit code 2), not as passed.
//
// Per engine:
//  P. Prediction card (course-s1 in test/mock-qualtrics.html, study mode, fb-visible):
//     boxes start empty and TEE OFF is disabled; every invalid input keeps it disabled (one box, 0, 13,
//     4.5, low > prediction, prediction > high); equal values and 1…12 are allowed; Enter on an invalid
//     card does nothing; digit keys and Space typed in the boxes don't change the club or swing.
//     Hole 1: 1 s on the section briefing, then the prediction; pred_ms counts from START SECTION.
//     Mid-hole the tab is hidden for 3 s (visibilitychange): hole hidden_ms ≈ 3 s, that swing's
//     decision_hidden_ms ≈ 3 s, every other swing 0. Hole 2 tees off with Enter in a box, and the
//     arrow keys then aim (keyboard back on the game). Hole records carry the typed predictions,
//     and the per-hole saves carry the same records.
//  V. fb-visible vs fb-hidden (course-s1, study mode): screenshots of the hole-complete card and the
//     Section complete card in both. In fb-hidden, at every hole-complete card and on the Section
//     complete card, the header scorecard shows hole numbers only, the hole-complete card reads
//     "HOLE n COMPLETE" only, the Section complete card has no strokes or par, the HUD has no stroke
//     counter, and a scan of all visible game text (except the per-shot toast and shot log, which the
//     condition keeps, and the map key) finds no score name, TOTAL, "n strokes" or "STROKE n". The
//     same checks in fb-visible find the scores (so the scan can see them). Records are the same shape.
//     Local testing, course-all, fb-hidden: the 9-hole round card has no "You" row, totals or summary.
//  R. Replay tries (debug=1, study mode, course-s2): hole 4 played (try 1, two extra short swings),
//     replayed with the researcher button (try 2, fewer swings), replayed again and left after one
//     swing (try 3), then try 4 to the end. Every try keeps its own hole and shot records (ids h4,
//     h4-t2, h4-t2-s1 …, a `try` field), nothing is overwritten or mixed, the saves are …_h4.json and
//     …_h4-t2.json …, and the final save carries all of them.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO, serve, routes, sleep } from './lib.mjs';
import * as H from './course-helpers.mjs';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch (e) { pw = await import('playwright'); }

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const ENGINES = (opt('--browser') || 'chromium,firefox,webkit').split(',').map((s) => s.trim()).filter(Boolean);
const OUT = opt('--out'), SHOTS = opt('--shots');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const HIDE_MS = 3000;

const { server, base } = await serve({ '/': REPO });
const port = new URL(base).port;
const MOCK = `http://127.0.0.1:${port}/test/mock-qualtrics.html`;
const GAME = `http://127.0.0.1:${port}/course.html`;
const ENDPOINT = `http://127.0.0.1:${port}/__save`;

const results = { started: new Date().toISOString(), engines: {}, tests: [] };
let failed = 0;
function report(engine, name, ok, detail) {
  results.tests.push({ engine, name, ok, detail });
  if (!ok) failed++;
  const d = detail == null ? '' : '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail));
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${engine}] ${name}${d.length > 600 ? d.slice(0, 600) + '…' : d}`);
}

// ---- helpers ---------------------------------------------------------------------------------
async function newContext(browser, viewport = { width: 1280, height: 720 }) {
  const context = await browser.newContext({ viewport });
  await routes(context);
  const posts = [];
  await context.route(/\/__save$/, async (route) => {
    let body = null; try { body = JSON.parse(route.request().postData()); } catch (e) { body = { unparsed: true }; }
    posts.push(body);
    await route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'Access-Control-Allow-Origin': '*' }, body: 'ok' });
  });
  await context.addInitScript((ep) => { window.NF_BRIDGE_CONFIG = { DATA_ENDPOINT: ep }; }, ENDPOINT);
  return { context, posts };
}
function watch(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return errors;
}
// The tab hidden / shown, as the browser reports it (same technique as tests/target-logging.mjs).
async function setHidden(f, hidden) {
  await f.evaluate((h) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}
const cards = (f) => f.evaluate(() => [...document.querySelectorAll('.overlay')].filter((o) => !o.hidden).map((o) => o.id));
const getLog = (f) => f.evaluate(() => JSON.parse(JSON.stringify(window.NF_LOG)));
const predState = (f) => f.evaluate(() => ({
  disabled: document.getElementById('teeBtn').disabled, msg: document.getElementById('predMsg').textContent,
  bad: ['predStrokes', 'predLow', 'predHigh'].filter((id) => document.getElementById(id).classList.contains('bad')),
  values: ['predStrokes', 'predLow', 'predHigh'].map((id) => document.getElementById(id).value)
}));
async function shotOf(f, file) {
  if (!SHOTS) return;
  const el = await f.frameElement().catch(() => null);
  if (el) await el.screenshot({ path: path.join(SHOTS, file) });
  else await f.page().screenshot({ path: path.join(SHOTS, file) });
}
// Advance through cards to the next aim phase (the hole card gets the scripted prediction).
async function toAim(f) {
  for (let i = 0; i < 20; i++) {
    const c = await cards(f);
    if (c.includes('howCard')) { await f.click('#howBtn'); continue; }
    if (c.includes('sectionCard')) { await f.click('#secBtn'); continue; }
    if (c.includes('holeCard')) { await H.teeOff(f); await H.waitPhase(f, ['aim']); return; }
    if ((await H.phase(f)) === 'aim') return;
    await sleep(50);
  }
  throw new Error('no aim phase');
}
// Short swing: shortest club, 5% power, aimed at the pin (a deliberate extra stroke).
async function shortSwing(page, f) {
  const club = await f.evaluate(() => { const { S } = NeonFairway; return S.bag.slice().sort((a, b) => NF.getClub(a.id).maxDistance - NF.getClub(b.id).maxDistance)[0].id; });
  await f.click(`#clubs button[data-club="${club}"]`);
  await f.evaluate(() => { const sl = document.getElementById('powerSlider'); sl.value = 5; sl.dispatchEvent(new Event('input', { bubbles: true })); });
  await f.click('#aimPin');
  await f.click('#swing');
  await H.waitPhase(f, ['aim', 'done']);
}
// Play the current hole to its done card with the scripted policy.
async function finishHole(page, f) {
  for (let i = 0; i < 60; i++) {
    if ((await cards(f)).includes('doneCard')) return;
    if ((await H.phase(f)) === 'aim') await H.scriptedSwing(page, f); else await sleep(50);
  }
  throw new Error('hole did not finish');
}

// What is on screen, for the fb-hidden checks. allText = all visible game text except the per-shot
// toast and shot log (kept by the condition), the map key (rules text) and the researcher panel.
const screenText = (f) => f.evaluate(() => {
  const vis = (el) => !!el && !el.closest('[hidden]') && el.getClientRects().length > 0;
  const t = (el) => (vis(el) ? el.innerText.replace(/\s+/g, ' ').trim() : '');
  const $ = (id) => document.getElementById(id);
  let all = t(document.body);
  for (const id of ['log', 'toast', 'legend', 'research']) { const s = t($(id)); if (s) all = all.split(s).join(' '); }
  return { scorecard: t($('scorecard')), done: t($('doneCard')), section: t($('sectionDone')), round: t($('roundCard')), hudMeta: t($('hudMeta')), all: all.replace(/\s+/g, ' ') };
});
const SCORE_RE = /ALBATROSS|EAGLE|BIRDIE|BOGEY|\bTOTAL\b|\b\d+\s*STROKES?\b|\bSTROKE\s+\d|\bYOU\b|VS PAR|EVEN PAR/i;

// =========================================================================================
// P. Prediction card, pred_ms, hidden time
// =========================================================================================
async function predictionRun(browser, engine) {
  const { context, posts } = await newContext(browser);
  const page = await context.newPage();
  const errors = watch(page);
  const pid = `R_pred_${engine}`;
  const f = await H.openMockCourse(page, MOCK, { pid, rng: 2468, seg: 'course-s1', bag: 'DCHPWV', cond: 'fb-visible' });
  await H.waitMockLog(page, /received nf-ready/);
  await f.click('#howBtn');
  await sleep(1000);                                  // on the section briefing: not prediction time
  await f.click('#secBtn');
  const tShown = Date.now();
  const s0 = await predState(f);
  const focus0 = await f.evaluate(() => document.activeElement && document.activeElement.id);
  await shotOf(f, `${engine}-hole-card-prediction-empty.png`);
  report(engine, 'P1 hole card: three empty boxes, TEE OFF disabled, "Fill in all three…", first box focused',
    s0.disabled && s0.values.every((v) => v === '') && /Fill in all three/.test(s0.msg) && s0.bad.length === 0 && focus0 === 'predStrokes', { ...s0, focus: focus0 });
  // Invalid and valid inputs.
  const cases = [
    { v: ['4', '', ''], ok: false, name: 'one box only' },
    { v: ['0', '1', '5'], ok: false, name: '0 (below 1)', bad: ['predStrokes'] },
    { v: ['13', '2', '12'], ok: false, name: '13 (above 12)', bad: ['predStrokes'] },
    { v: ['4.5', '3', '6'], ok: false, name: '4.5 (not whole)', bad: ['predStrokes'] },
    { v: ['4', '5', '6'], ok: false, name: 'low above the prediction', bad: ['predLow'], msg: /between your two numbers/ },
    { v: ['7', '3', '6'], ok: false, name: 'prediction above high', bad: ['predHigh'], msg: /between your two numbers/ },
    { v: ['4', '4', '4'], ok: true, name: 'all equal (allowed)' },
    { v: ['1', '1', '12'], ok: true, name: '1 to 12 (the limits)' },
    { v: ['', '1', '12'], ok: false, name: 'prediction cleared again' }
  ];
  const bad = [];
  for (const c of cases) {
    await f.fill('#predStrokes', c.v[0]); await f.fill('#predLow', c.v[1]); await f.fill('#predHigh', c.v[2]);
    const st = await predState(f);
    if (st.disabled === c.ok) bad.push(`${c.name}: TEE OFF ${st.disabled ? 'disabled' : 'enabled'}`);
    if (c.bad && !c.bad.every((id) => st.bad.includes(id))) bad.push(`${c.name}: marked ${st.bad}`);
    if (c.msg && !c.msg.test(st.msg)) bad.push(`${c.name}: message "${st.msg}"`);
  }
  report(engine, `P2 validation: ${cases.map((c) => `${c.name} → ${c.ok ? 'on' : 'off'}`).join('; ')}`, bad.length === 0, bad);
  // Enter while invalid, and keys typed in the boxes.
  const club0 = await f.evaluate(() => NeonFairway.S.club);
  await f.click('#predLow'); await page.keyboard.press('Enter');
  await f.click('#predStrokes'); await page.keyboard.type('2'); await page.keyboard.press('Backspace'); await page.keyboard.press('Space');
  const after = await f.evaluate(() => ({ club: NeonFairway.S.club, phase: NeonFairway.S.phase, swings: NeonFairway.S.shots.length, card: !document.getElementById('holeCard').hidden }));
  report(engine, 'P3 Enter on an invalid card, digits and Space typed in a box: still on the card, club unchanged, no swing',
    after.card && after.phase === 'card' && after.club === club0 && after.swings === 0, after);
  // The real prediction.
  const want1 = H.scriptPrediction(1);
  await sleep(700);
  await H.fillPrediction(f, want1);
  const sOk = await predState(f);
  await shotOf(f, `${engine}-hole-card-prediction-filled.png`);
  await f.click('#teeBtn');
  const predWall = Date.now() - tShown;
  await H.waitPhase(f, ['aim']);
  report(engine, `P4 valid prediction (${want1.strokes}; ${want1.low}–${want1.high}): no message, TEE OFF on; play starts`, !sOk.disabled && sOk.msg === '' && sOk.bad.length === 0, sOk);
  // Swing 1 with the tab visible, then hide the tab for 3 s during swing 2's decision, then the rest.
  await H.scriptedSwing(page, f);
  if ((await cards(f)).includes('doneCard')) throw new Error('hole 1 ended in one swing; choose another rng');
  await sleep(300);
  await setHidden(f, true); await sleep(HIDE_MS); await setHidden(f, false);
  await sleep(300);
  await H.scriptedSwing(page, f);
  await finishHole(page, f);
  await shotOf(f, `${engine}-pred-hole1-complete.png`);
  const log1 = await getLog(f);
  const h1 = log1.find((r) => r.record_type === 'hole' && r.hole_no === 1);
  const s1 = log1.filter((r) => r.record_type === 'shot' && r.hole_no === 1);
  report(engine, `P5 hole 1 record: pred_strokes ${h1.pred_strokes}, pred_low ${h1.pred_low}, pred_high ${h1.pred_high} = typed; try 1, id …-h1`,
    h1.pred_strokes === want1.strokes && h1.pred_low === want1.low && h1.pred_high === want1.high && h1.try === 1 && h1.record_id === `${pid}-course-s1-a1-h1`,
    { pred_strokes: h1.pred_strokes, pred_low: h1.pred_low, pred_high: h1.pred_high, try: h1.try, id: h1.record_id });
  report(engine, `P6 pred_ms ${h1.pred_ms} ≈ time from START SECTION to TEE OFF (${predWall} ms by the test clock); the 1 s briefing is in card_ms (${h1.card_ms}) but not pred_ms`,
    Number.isInteger(h1.pred_ms) && Math.abs(h1.pred_ms - predWall) < 600 && h1.card_ms >= h1.pred_ms + 900, { pred_ms: h1.pred_ms, wall: predWall, card_ms: h1.card_ms });
  report(engine, `P7 hole 1 hidden_ms ${h1.hidden_ms} ≈ ${HIDE_MS} (tab hidden mid-hole), ≤ play_ms ${h1.play_ms}; idle_ms ${h1.idle_ms}`,
    h1.hidden_ms >= HIDE_MS - 150 && h1.hidden_ms <= HIDE_MS + 1500 && h1.hidden_ms <= h1.play_ms && h1.idle_ms === 0, { hidden_ms: h1.hidden_ms, play_ms: h1.play_ms, idle_ms: h1.idle_ms });
  const sh2 = s1[1];
  report(engine, `P8 shot records: swing 2 decision_hidden_ms ${sh2 && sh2.decision_hidden_ms} ≈ ${HIDE_MS} and ≤ decision_ms ${sh2 && sh2.decision_ms}; the other ${s1.length - 1} swings 0; all try 1`,
    !!sh2 && sh2.decision_hidden_ms >= HIDE_MS - 150 && sh2.decision_hidden_ms <= HIDE_MS + 1500 && sh2.decision_hidden_ms <= sh2.decision_ms
      && s1.every((s, i) => i === 1 || s.decision_hidden_ms === 0) && s1.every((s) => s.try === 1 && s.record_id === `${pid}-course-s1-a1-h1-s${s.swing_no}`),
    s1.map((s) => [s.record_id.split('-').slice(-2).join('-'), s.decision_ms, s.decision_hidden_ms]));
  // Hole 2: TEE OFF with Enter in the last box, then the arrow keys aim.
  await f.click('#nextBtn');
  await f.waitForFunction(() => !document.getElementById('holeCard').hidden);
  const want2 = H.scriptPrediction(2);
  await f.fill('#predStrokes', String(want2.strokes)); await f.fill('#predLow', String(want2.low)); await f.fill('#predHigh', String(want2.high));
  await f.focus('#predHigh'); await page.keyboard.press('Enter');
  await H.waitPhase(f, ['aim']);
  const t0 = await f.evaluate(() => ({ ...NeonFairway.S.target }));
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  const t1 = await f.evaluate(() => ({ target: { ...NeonFairway.S.target }, aimChanges: NeonFairway.S.track.aim, active: document.activeElement && document.activeElement.id }));
  report(engine, 'P9 hole 2: Enter in a box tees off; the arrow keys then aim (2 aim changes), keyboard back on the game',
    (t1.target.x !== t0.x || t1.target.y !== t0.y) && t1.aimChanges === 2, t1);
  // Rest of the section.
  await H.playSegment(page, f, { continueAtEnd: false });
  const log = await getLog(f);
  const holes = log.filter((r) => r.record_type === 'hole');
  const hb = holes.filter((h) => { const w = H.scriptPrediction(h.hole_no); return !(h.pred_strokes === w.strokes && h.pred_low === w.low && h.pred_high === w.high && h.pred_ms > 0 && h.pred_ms <= h.card_ms); });
  const saves = holes.map((h) => posts.find((b) => b.file === `${pid}_course-s1_a1_h${h.hole_no}.json`));
  const savesOk = saves.every((b, i) => b && b.holes.length === 1 && JSON.stringify(b.holes[0]) === JSON.stringify(holes[i]));
  report(engine, `P10 holes 1–3: each hole record has its typed prediction and pred_ms ≤ card_ms; each per-hole save carries that exact record (hidden_ms ${holes.map((h) => h.hidden_ms).join(', ')})`,
    holes.length === 3 && hb.length === 0 && savesOk && holes[1].hidden_ms === 0 && holes[2].hidden_ms === 0,
    holes.map((h) => ({ h: h.hole_no, pred: [h.pred_strokes, h.pred_low, h.pred_high], pred_ms: h.pred_ms, card_ms: h.card_ms, hidden_ms: h.hidden_ms })));
  report(engine, 'P11 no page errors', errors.length === 0, errors.slice(0, 4));
  await context.close();
  return { hole1: h1, swing2: sh2 };
}

// =========================================================================================
// V. fb-visible vs fb-hidden
// =========================================================================================
async function conditionRun(browser, engine, cond) {
  const { context, posts } = await newContext(browser);
  const page = await context.newPage();
  const errors = watch(page);
  const pid = `R_${cond}_${engine}`;
  const f = await H.openMockCourse(page, MOCK, { pid, rng: 1357, seg: 'course-s1', bag: 'DCHPWV', cond });
  await H.waitMockLog(page, /received nf-ready/);
  const applied = await f.evaluate(() => NFBridge.settings.cond);
  const seen = [];   // screen text at each hole-complete card and the Section complete card
  // Mid-hole: the stroke counter is kept in both conditions.
  await toAim(f);
  const midHud = (await screenText(f)).hudMeta;
  await H.playSegment(page, f, {
    continueAtEnd: false,
    onHoleDone: async (holes) => {
      await sleep(150);
      const st = await screenText(f), h = holes[holes.length - 1];
      seen.push({ where: `hole ${h.hole_no} complete`, strokes: h.strokes, ...st });
      if (h.hole_no === 1) await shotOf(f, `${engine}-${cond}-hole-complete.png`);
    }
  });
  await sleep(200);
  const sd = await screenText(f);
  seen.push({ where: 'section complete', ...sd });
  await shotOf(f, `${engine}-${cond}-section-complete.png`);
  const log = await getLog(f);
  const holes = log.filter((r) => r.record_type === 'hole');
  const scores = holes.map((h) => h.strokes), total = scores.reduce((a, b) => a + b, 0);
  const hidden = cond === 'fb-hidden';
  report(engine, `V0 ${cond}: the game applied cond=${applied}; mid-hole HUD keeps the stroke counter ("${midHud}")`, applied === cond && /STROKE\s+1/.test(midHud), { applied, midHud });
  if (hidden) {
    const bad = [];
    for (const s of seen) {
      if (!/^(H\d\s*)+BAG\s+[A-Z]+$/.test(s.scorecard)) bad.push(`${s.where}: scorecard "${s.scorecard}"`);
      if (SCORE_RE.test(s.all)) bad.push(`${s.where}: "${(s.all.match(SCORE_RE) || [])[0]}" on screen`);
      if (/STROKE/i.test(s.hudMeta)) bad.push(`${s.where}: HUD "${s.hudMeta}"`);
    }
    for (const s of seen.filter((x) => x.where.startsWith('hole'))) {
      const n = s.where.match(/\d+/)[0];   // the card reads "HOLE n COMPLETE" and its button, nothing else
      if (!new RegExp(`^HOLE ${n} COMPLETE (NEXT HOLE|FINISH SECTION)$`).test(s.done)) bad.push(`${s.where}: card "${s.done}"`);
    }
    const sec = seen[seen.length - 1].section;
    if (/STROKE|PAR|TOTAL/i.test(sec) || sec.replace(/SECTION 1 OF 3 · HOLES 1–3/, '').match(/\d/)) bad.push(`section card "${sec}"`);
    if (!/CONTINUE/.test(sec)) bad.push('section card: no CONTINUE');
    report(engine, `V1 fb-hidden: no completed-hole score or total anywhere (scores were ${scores.join(', ')}, total ${total}); scorecard "${seen[0].scorecard}"; hole card "${seen[0].done}"; section card "${sec}"`,
      bad.length === 0, bad.length ? bad : seen.map((s) => ({ where: s.where, scorecard: s.scorecard, card: s.where.startsWith('hole') ? s.done : s.section, hud: s.hudMeta })));
  } else {
    const bad = [];
    seen.filter((s) => s.where.startsWith('hole')).forEach((s) => {
      if (!new RegExp(`\\b${s.strokes} strokes\\b`).test(s.done)) bad.push(`${s.where}: card "${s.done}"`);
      if (!s.scorecard.includes(`H${s.where.match(/\d+/)[0]} ${s.strokes}`)) bad.push(`${s.where}: scorecard "${s.scorecard}"`);
      if (!SCORE_RE.test(s.all)) bad.push(`${s.where}: the scan saw no score`);
    });
    const sec = seen[seen.length - 1].section;
    if (!sec.includes(`${total} STROKES · PAR 12`)) bad.push(`section card "${sec}"`);
    report(engine, `V1 fb-visible: scores shown as before (scorecard "${seen[seen.length - 1].scorecard}", section card "${sec.match(/\d+ STROKES · PAR \d+/)}"); the fb-hidden scan finds them here`,
      bad.length === 0, bad);
  }
  // CONTINUE still works and the summary still carries the scores (Qualtrics data, not shown).
  await f.click('#sdContinue');
  await H.waitMockLog(page, /received nf-done/);
  const m = await H.mockState(page);
  const done = m.received.map((x) => x.data || x).find((d) => d && d.type === 'nf-done');
  report(engine, `V2 ${cond}: CONTINUE sends nf-done with the scores (crs_s1_total ${done && done.summary.crs_s1_total}); records carry cond=${cond}`,
    !!done && done.summary.crs_s1_total === total && log.every((r) => r.cond === cond) && posts.some((b) => /_final\.json$/.test(b.file)),
    done && done.summary);
  report(engine, `V3 ${cond}: no page errors`, errors.length === 0, errors.slice(0, 4));
  await context.close();
  return { scores, total, seen: seen.map((s) => ({ where: s.where, scorecard: s.scorecard, card: s.where.startsWith('hole') ? s.done : s.section, hud: s.hudMeta })) };
}
// Local testing, course-all, fb-hidden: the 9-hole round card.
async function roundCardRun(browser, engine) {
  const { context } = await newContext(browser, { width: 1280, height: 800 });
  const page = await context.newPage();
  const errors = watch(page);
  await page.goto(`${GAME}?segment=course-all&bag=DCHPWV&rng=99&cond=fb-hidden`);
  await page.waitForFunction(() => window.NeonFairway && NeonFairway.S.phase === 'card');
  const f = page.mainFrame();
  await H.playSegment(page, f, { continueAtEnd: false, maxSwings: 400 });
  await sleep(200);
  const st = await screenText(f);
  await shotOf(f, `${engine}-fb-hidden-course-all-round-card.png`);
  report(engine, `V4 local testing, course-all, fb-hidden: round card "${st.round.slice(0, 120)}…" has hole numbers and pars only; header "${st.scorecard}"`,
    /ROUND COMPLETE/.test(st.round) && !SCORE_RE.test(st.all) && /^(H\d\s*){9}BAG\s+[A-Z]+$/.test(st.scorecard) && errors.length === 0, { round: st.round, errors });
  await context.close();
}

// =========================================================================================
// R. Replay tries (debug)
// =========================================================================================
async function replayRun(browser, engine) {
  const { context, posts } = await newContext(browser, { width: 1400, height: 1000 });
  const page = await context.newPage();
  const errors = watch(page);
  const pid = `R_rep_${engine}`, seg = 'course-s2';
  await page.goto(`${GAME}?pid=${pid}&segment=${seg}&bag=DCHPWV&rng=8080&debug=1&cond=fb-visible`);
  await page.waitForFunction(() => window.NeonFairway && NeonFairway.S.phase === 'card');
  const f = page.mainFrame();
  const jump = async (n) => { await f.click(`#holeJump button:has-text("Play hole ${n}")`); };
  // Try 1: two short swings, then the rest.
  await toAim(f);
  await shortSwing(page, f); await shortSwing(page, f);
  await finishHole(page, f);
  const try1 = await f.evaluate(() => NeonFairway.S.shots.length);
  // Try 2: replay hole 4 from the researcher panel, scripted only.
  await jump(4); await toAim(f);
  const holeTry2 = await f.evaluate(() => NeonFairway.S.holeTry);
  await finishHole(page, f);
  const try2 = await f.evaluate(() => NeonFairway.S.shots.length);
  // Try 3: one swing, then replay again mid-hole; try 4 to the end of the section.
  await jump(4); await toAim(f); await H.scriptedSwing(page, f);
  await jump(4);
  await H.playSegment(page, f, { continueAtEnd: false });
  const log = await getLog(f);
  const h4 = log.filter((r) => r.record_type === 'hole' && r.hole_no === 4), s4 = log.filter((r) => r.record_type === 'shot' && r.hole_no === 4);
  const ids = log.map((r) => r.record_id);
  const byTry = (t) => s4.filter((s) => s.try === t);
  const tag = (t) => (t > 1 ? `h4-t${t}` : 'h4');
  const bad = [];
  if (new Set(ids).size !== ids.length) bad.push('duplicate record ids');
  if (h4.map((h) => h.try).join() !== '1,2,4') bad.push(`hole records tries ${h4.map((h) => h.try)}`);
  [1, 2, 4].forEach((t) => {
    const h = h4.find((x) => x.try === t), ss = byTry(t);
    if (!h) return;
    if (h.record_id !== `${pid}-${seg}-a1-${tag(t)}`) bad.push(`try ${t} hole id ${h.record_id}`);
    if (ss.length !== h.swings) bad.push(`try ${t}: ${ss.length} shot records, hole says ${h.swings} swings`);
    ss.forEach((s, i) => { if (s.swing_no !== i + 1 || s.record_id !== `${pid}-${seg}-a1-${tag(t)}-s${i + 1}`) bad.push(`try ${t} shot id ${s.record_id}`); });
    const save = posts.find((b) => b.file === `${pid}_${seg}_a1_${tag(t)}.json`);
    if (!save || save.holes[0].try !== t || save.shots.length !== h.swings || !save.shots.every((s) => s.try === t)) bad.push(`try ${t} save`);
  });
  if (byTry(3).length !== 1 || byTry(3)[0].record_id !== `${pid}-${seg}-a1-h4-t3-s1`) bad.push(`try 3 (left mid-hole): ${byTry(3).map((s) => s.record_id)}`);
  if (!(try1 > try2)) bad.push(`try 1 (${try1} swings) not longer than try 2 (${try2})`);
  report(engine, `R1 hole 4 replayed: try 1 ${try1} swings, try 2 ${try2}, try 3 left after 1, try 4 played; ${h4.length} hole + ${s4.length} shot records, all ids unique, each try's shots match its hole record and its own save (…_h4.json, …_h4-t2.json, …_h4-t4.json)`,
    bad.length === 0 && holeTry2 === 2, bad.length ? bad : s4.map((s) => s.record_id.replace(`${pid}-${seg}-a1-`, '')));
  await f.click('#sdContinue');
  await page.waitForFunction(() => window.NF_LAST_SUMMARY, null, { timeout: 20000 });
  const fin = posts.find((b) => b.file === `${pid}_${seg}_a1_final.json`);
  const sum = await f.evaluate(() => window.NF_LAST_SUMMARY.summary);
  const last4 = h4.find((h) => h.try === 4);
  report(engine, `R2 final save carries every try (${fin && fin.holes.length} hole, ${fin && fin.shots.length} shot records); the summary uses hole 4's latest try (crs_s2_h4 ${sum.crs_s2_h4} = try 4's ${last4 && last4.strokes})`,
    !!fin && fin.holes.length === log.filter((r) => r.record_type === 'hole').length && fin.shots.length === log.filter((r) => r.record_type === 'shot').length
      && !!last4 && sum.crs_s2_h4 === last4.strokes, { holes: fin && fin.holes.map((h) => h.record_id.split('-a1-')[1]) });
  // Without debug there are no hole buttons, so a participant can't replay.
  const p2 = await context.newPage();
  await p2.goto(`${GAME}?pid=${pid}x&segment=${seg}&bag=DCHPWV&rng=8080`);
  await p2.waitForFunction(() => window.NeonFairway && NeonFairway.S.phase === 'card');
  const noJump = await p2.evaluate(() => document.querySelectorAll('#holeJump button').length === 0 && document.getElementById('research').hidden);
  report(engine, 'R3 study mode without debug: no researcher hole buttons', noJump);
  report(engine, 'R4 no page errors', errors.length === 0, errors.slice(0, 4));
  await context.close();
}

// =========================================================================================
for (const engine of ENGINES) {
  const type = pw[engine];
  if (!type) { report(engine, 'unknown engine', false); continue; }
  let browser;
  try {
    browser = await type.launch(engine === 'chromium' ? { args: ['--host-resolver-rules=MAP localhost 127.0.0.1'], ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) } : {});
  } catch (e) {
    results.engines[engine] = { notRun: String(e.message || e).split('\n')[0] };
    console.log(`NOT RUN [${engine}] could not launch: ${String(e.message || e).split('\n')[0]}`);
    continue;
  }
  const E = results.engines[engine] = { version: browser.version() };
  for (const [name, fn] of [['prediction', () => predictionRun(browser, engine)], ['fb-visible', () => conditionRun(browser, engine, 'fb-visible')],
    ['fb-hidden', () => conditionRun(browser, engine, 'fb-hidden')], ['round-card', () => roundCardRun(browser, engine)], ['replay', () => replayRun(browser, engine)]]) {
    try { E[name] = await fn(); } catch (e) { report(engine, `${name}: run stopped`, false, String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')); }
  }
  await browser.close();
}
results.finished = new Date().toISOString();
results.failed = failed;
const notRun = Object.entries(results.engines).filter(([, v]) => v.notRun).map(([k]) => k);
if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(`\n${results.tests.length - failed} passed, ${failed} failed` + (notRun.length ? `; not run: ${notRun.join(', ')}` : ''));
server.close();
process.exit(failed ? 1 : notRun.length ? 2 : 0);
