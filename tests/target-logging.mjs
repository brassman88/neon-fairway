// Neon Fairway: target.html data logging tests (prompt 6, Target Practice v39; v40: two estimate questions,
// prediction records, round prediction fields, segment feedback / predictions).
//   node tests/target-logging.mjs [--browser chromium,firefox,webkit] [--out results.json] [--records folder]
// Needs Playwright (npm i -D playwright; npx playwright install chromium).
//
// Plays tp-practice (with one instant batch) and then tp-rounds by script inside
// test/mock-qualtrics.html, with a data endpoint the test answers itself, and checks against
// claude/tp-data-logging-spec.md:
//  1. Every spec field is present on every record (header + type fields); every null is listed with why.
//  2. Shot records match the game's own shots (club, power, aim, distance, lateral, draws, result, points).
//  3. Change counters on every single shot match what the script did (predicted shot by shot), including
//     one slider drag (1 change), one map drag (1 change), a map click, re-picking the selected club (0),
//     keys; decision_ms / decision_hidden_ms (tab hidden 1.5 s before one shot); batch shots: decision
//     null, counters on the first batch shot only.
//  4. Estimate records for every card closed: later / save (auto, edit, final) / cancel / back.
//  5. club_summary ×9 and bag_choice agree with the game and the Qualtrics summary.
//  6. Round records ×5 agree with tp_r1..tp_r5; review time on every round (round 5 via CONTINUE);
//     hidden time during round 1's review; idle time during round 2 (IDLE_MS lowered to 2.5 s for the test).
//  7. Saves: tp-practice every 20 shots, after each estimate, at bag confirm; tp-rounds after each round and
//     its review; then the final save. nf-done carries exactly the field reference's keys.
//  8. Local testing (no pid): test:true, Download data button (CSV + JSON). Study mode without debug: no button.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO, serve, routes, sleep } from './lib.mjs';
import * as H from './target-helpers.mjs';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch (e) { pw = await import('playwright'); }

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const ENGINES = (opt('--browser') || 'chromium').split(',').map((s) => s.trim()).filter(Boolean);
const OUT = opt('--out'), RECORDS = opt('--records');
if (RECORDS) fs.mkdirSync(RECORDS, { recursive: true });
const VERSION = 'v41';
const IDLE_MS = 2500;

const { server, base } = await serve({ '/': REPO });
const port = new URL(base).port;
const MOCK = `http://127.0.0.1:${port}/test/mock-qualtrics.html`;
const ENDPOINT = `http://127.0.0.1:${port}/__save`;

// ---- The spec's fields (claude/tp-data-logging-spec.md) ------------------------------------
const HEADER = ['record_type', 'record_id', 'pid', 'segment', 'attempt', 'load_id', 'game', 'game_version', 'cond', 'bag_seed',
  'rng_seed', 'test', 'client_time'];
const F = {
  shot: ['phase', 'shot_no', 'round', 'ball_no', 'club_shot_no', 'club', 'club_type', 'variety', 'letter', 'course', 'power',
    'aim_deg', 'aim_dist', 'aimed_at', 'aimed_role', 'aimed_best', 'aimed_off', 'nominal', 'total', 'lateral', 'offset_deg',
    'land_x', 'land_y', 'z_lat', 'z_dist', 'result', 'target_hit', 'miss_by', 'points', 'batch', 'batch_id', 'batch_shot_no',
    'decision_ms', 'decision_hidden_ms', 'aim_changes', 'power_changes', 'club_changes', 'spray_on'],
  estimate: ['estimate_no', 'card_no', 'club', 'club_type', 'variety', 'letter', 'question', 'question_text', 'target_yd', 'radius_yd',
    'answer', 'truth', 'truth_power', 'previous', 'start_value', 'shots_at_time', 'when', 'action', 'response_ms', 'response_hidden_ms'],
  club_summary: ['club', 'club_type', 'variety', 'letter', 'shots', 'batch_shots', 'time_ms', 'hidden_ms', 'idle_ms',
    'final_est_distance', 'final_est_hits', 'truth_distance', 'truth_hits', 'estimate_count', 'first_est_distance', 'first_est_hits',
    'first_estimate_shots', 'asked_at_5', 'chosen'],
  bag_choice: ['letters_chosen', 'practice_shots', 'choose_ms', 'choose_hidden_ms', 'chooser_opens', 'card_clicks', 'nudge_shown',
    'nudge_count', 'clubs_under_5']
    .concat(...['driver', 'hybrid', 'wedge'].map((k) => ['_club', '_variety', '_letter', '_est_distance', '_est_hits', '_truth_distance', '_truth_hits'].map((x) => k + x)))
    .concat(...['driver', 'hybrid', 'wedge'].map((k) => ['a', 'b', 'c'].flatMap((l) => [`est_distance_${k}_${l}`, `est_hits_${k}_${l}`]))),
  round: ['round', 'course', 'course_name', 'score', 'hits', 'scored', 'bulls', 'best_shots', 'best_target', 'near_points',
    'mid_points', 'far_points', 'aimed_near', 'aimed_mid', 'aimed_far', 'play_ms', 'hidden_ms', 'idle_ms', 'review_ms',
    'review_hidden_ms', 'review_idle_ms', 'pred_points', 'pred_low', 'pred_high'],
  prediction: ['round', 'course', 'course_name', 'pred_points', 'pred_low', 'pred_high', 'max_points', 'response_ms', 'response_hidden_ms'],
  segment: ['letters', 'pos', 'started_at', 'finished_at', 'active_ms', 'idle_ms', 'hidden_ms', 'screen_w', 'screen_h', 'user_agent',
    'save_failures', 'status', 'error_code', 'practice_shots', 'batch_count', 'batch_shots', 'course_switches', 'estimates_saved',
    'nudge_count', 'rounds_played', 'total_score', 'test_bag', 'feedback', 'predictions']
};
// Fields that may be null, and when.
const NULL_OK = {
  bag_seed: 'before the bag is confirmed (tp-practice practice shots / estimates)',
  round: 'practice shot', ball_no: 'practice shot', club_shot_no: 'round shot',
  target_hit: 'the ball missed every target', miss_by: 'the ball hit a target',
  batch_id: 'single shot', batch_shot_no: 'single shot',
  decision_ms: 'instant-batch shot', decision_hidden_ms: 'instant-batch shot',
  answer: "card put off (action 'later' / 'cancel' / 'back')",
  previous: 'no earlier answer for this club', start_value: 'the boxes started empty (no earlier answer)',
  target_yd: 'distance_100 question (no target)', radius_yd: 'distance_100 question (no target)',
  predictions: 'tp-practice (no rounds)',
  pos: 'no pos in the link', letters: 'no letters in the link (tp-practice)',
  finished_at: 'segment not finished yet (in-progress saves)',
  error_code: 'no error',
  practice_shots: 'tp-rounds (no practice)', batch_count: 'tp-rounds', batch_shots: 'tp-rounds', course_switches: 'tp-rounds',
  estimates_saved: 'tp-rounds', nudge_count: 'tp-rounds',
  rounds_played: 'tp-practice (no rounds)', total_score: 'tp-practice',
  review_ms: 'round record saved before its review ended (r<k> save; the r<k>-review / final save has it)',
  review_hidden_ms: 'as review_ms', review_idle_ms: 'as review_ms'
};
const PRACTICE_SUMMARY = ['tp_bag', 'tp_letters', 'tp_practice_shots', 'tp_est_d', 'tp_est_h', 'tp_est_w'];
const ROUNDS_SUMMARY = ['tp_r1', 'tp_r2', 'tp_r3', 'tp_r4', 'tp_r5', 'tp_total', 'tp_best_aims'];

const results = { started: new Date().toISOString(), version: VERSION, engines: {}, tests: [], examples: {}, summaries: {}, nulls: {} };
let failed = 0, notRun = 0;
function report(engine, name, ok, detail) {
  results.tests.push({ engine, name, ok, detail });
  if (!ok) failed++;
  const d = detail == null ? '' : '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail));
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${engine}] ${name}${d.length > 700 ? d.slice(0, 700) + '…' : d}`);
}

// ---- helpers -----------------------------------------------------------------------------
async function setHidden(f, hidden) {
  await f.evaluate((h) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}
const curState = (f) => f.evaluate(() => {
  const s = TargetPractice.state;
  return { club: s.clubIndex, power: s.power, aim: s.aimAngle, phase: s.phase };
});
// Tracks what the script did since the previous shot, so the counters can be predicted.
function tracker() { return { aim: 0, power: 0, club: 0 }; }

async function main(engine, browser) {
  const R = (name, ok, detail) => report(engine, name, ok, detail);
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
  await routes(context);
  const posts = [];
  await context.route(/\/__save$/, async (route) => {
    let body = null; try { body = JSON.parse(route.request().postData()); } catch (e) { body = { unparsed: route.request().postData() }; }
    posts.push(body);
    await route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'Access-Control-Allow-Origin': '*' }, body: 'ok' });
  });
  await context.addInitScript(({ ep, idle }) => { window.NF_BRIDGE_CONFIG = { DATA_ENDPOINT: ep, IDLE_MS: idle }; }, { ep: ENDPOINT, idle: IDLE_MS });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e && e.stack || e)));

  // ================= tp-practice =================
  const f = await H.openMockTarget(page, MOCK, { pid: 'R_tplog1', rng: 4242, seg: 'tp-practice', cond: 'fb-visible' });
  await f.click('#tp-startPracticeBtn');
  await H.waitPhase(f, ['shooting']);
  const expect = [];      // predicted counters for each single shot, in order; null for batch shots
  let cur = await curState(f);
  let t = tracker();
  let laterDone = false;
  const estimateLog = [];  // what the script did on each estimate card: { when, action }

  async function handleCard() {
    // An estimate card opened after a shot (auto, at 5 shots): put the first one off, answer the rest.
    if (await H.rawPhase(f) !== 'estimate') return;
    if (!laterDone) { laterDone = true; await f.click('#tp-estimateLaterBtn'); estimateLog.push({ when: 'auto', action: 'later' }); return; }
    const idx = await f.evaluate(() => TargetPractice.state.practiceClubs.indexOf(TargetPractice.state.clubs[TargetPractice.state.clubIndex]));
    await H.answerEstimate(f, H.scriptEstimate(idx), H.scriptHits(idx));
    estimateLog.push({ when: 'auto', action: 'save' });
  }
  async function pickClub(i) { await f.click(`#tp-clubButtons button[data-club="${i}"]`); if (i !== cur.club) t.club++; cur.club = i; }
  async function power(v) { await H.setPower(f, v); if (v !== cur.power) t.power++; cur.power = v; }
  async function aim(deg) {
    await f.click('#tp-aimStraight'); if (Math.abs(cur.aim) > 1e-9) t.aim++;
    const id = deg < 0 ? '#tp-rotL' : '#tp-rotR';
    for (let i = 0; i < Math.abs(deg); i++) { await f.click(id); t.aim++; }
    cur.aim = deg;
  }
  async function take(extra = {}) {
    await f.click('#tp-takeShotBtn');
    expect.push({ ...t, ...extra });
    t = tracker();
    await f.waitForFunction(() => TargetPractice.state.phase !== 'animating', null, { timeout: 15000, polling: 25 });
    await handleCard();
  }

  // Shot 1: re-pick the selected club (0 changes), slider to 80, 3 × "1° ▶", ↓ twice (80 → 70).
  await pickClub(cur.club);
  await power(80);
  await f.click('#tp-rotR'); await f.click('#tp-rotR'); await f.click('#tp-rotR'); t.aim += 3; cur.aim = 3;
  await f.press('#tpScreen', 'ArrowDown'); await f.press('#tpScreen', 'ArrowDown'); t.power += 2; cur.power = 70;
  await take();
  // Shot 2: club 3, club 3 again (0), key "5" (club 4); one slider drag; one map drag; one map click; Aim straight;
  // then the tab is hidden for 1.5 s before TAKE SHOT.
  await pickClub(3); await pickClub(3);
  await f.press('#tpScreen', '5'); t.club++; cur.club = 4;
  const sl = await f.locator('#tp-powerSlider').boundingBox();
  await page.mouse.move(sl.x + sl.width * 0.9, sl.y + sl.height / 2);
  await page.mouse.down();
  for (let k = 1; k <= 6; k++) await page.mouse.move(sl.x + sl.width * (0.9 - k * 0.07), sl.y + sl.height / 2);
  await page.mouse.up();
  t.power++; cur.power = (await curState(f)).power;
  const cv = await f.locator('#tp-birdCanvas').boundingBox();
  const cx = cv.x + cv.width / 2, cy = cv.y + cv.height * 0.45;
  await page.mouse.move(cx, cy); await page.mouse.down();
  for (let k = 1; k <= 6; k++) await page.mouse.move(cx + k * 6, cy - k * 4);
  await page.mouse.up(); t.aim++;
  await page.mouse.click(cx - 40, cy + 10); t.aim++;
  cur.aim = (await curState(f)).aim;
  await f.click('#tp-aimStraight'); t.aim++; cur.aim = 0;
  const shot2HiddenFrom = Date.now();
  await setHidden(f, true); await sleep(1500); await setHidden(f, false);
  await take({ hiddenShot: true, hiddenFor: Date.now() - shot2HiddenFrom });
  // Shot 3: nothing changed.
  await take();
  // Scripted practice: 33 more single shots over the clubs and the 5 courses (course buttons every 8 shots),
  // an "edit" estimate (saved) and an "edit" cancelled, and one instant batch (2 per power × 4 powers).
  const courses = ['sunset', 'pines', 'comet', 'laser', 'nova'];
  let switches = 0, curCourse = 'sunset';
  for (let i = 0; i < 33; i++) {
    if (i % 8 === 0) { const c = courses[(i / 8) % 5]; await f.click(`#tp-courseButtons button[data-course="${c}"]`); if (c !== curCourse) switches++; curCourse = c; }
    await pickClub(i % 9);
    await power([100, 80, 60, 45][i % 4]);
    await aim([0, -2, 3, 1][i % 4]);
    await take();
    if (i === 12) {
      await f.click('#tp-editEstimateBtn'); await H.answerEstimate(f, 123, 4); estimateLog.push({ when: 'edit', action: 'save' });
    }
    if (i === 20) {
      await f.click('#tp-editEstimateBtn'); await sleep(200); await f.click('#tp-estimateLaterBtn'); estimateLog.push({ when: 'edit', action: 'cancel' });
    }
    if (i === 16) {
      // instant batch with club 4 at 70%: changes before it go on its first shot
      await pickClub(4); await power(70);
      await f.fill('#tp-batchCount', '2');
      await f.click('#tp-batchAllBtn');
      for (let k = 0; k < 8; k++) expect.push(k === 0 ? { ...t, batch: true } : { aim: 0, power: 0, club: 0, batch: true });
      t = tracker();
      await handleCard();
    }
  }
  // Leave practice: I'm ready → nudge → choose anyway → first required estimate: Back to Practice →
  // I'm ready → nudge → choose anyway → answer every required estimate → club cards → confirm.
  let nudges = 0;
  await f.click('#tp-endPracticeBtn');
  if (await f.isVisible('#tp-nudgeOverlay')) { nudges++; await f.click('#tp-chooseAnywayBtn'); }
  if (await f.isVisible('#tp-estimateOverlay')) { await f.click('#tp-estimateLaterBtn'); estimateLog.push({ when: 'final', action: 'back' }); }
  await H.waitPhase(f, ['shooting']);
  await f.click('#tp-endPracticeBtn');
  if (await f.isVisible('#tp-nudgeOverlay')) { nudges++; await f.click('#tp-chooseAnywayBtn'); }
  for (let i = 0; i < 12 && await f.isVisible('#tp-estimateOverlay'); i++) {
    const idx = await H.estimateClubIdx(f);
    await H.answerEstimate(f, H.scriptEstimate(idx), H.scriptHits(idx));
    estimateLog.push({ when: 'final', action: 'save' });
  }
  await f.waitForSelector('#tp-bagOverlay:not([hidden])');
  await sleep(300);
  await f.click('#tp-bagSections .bag-card[data-label="Driver A"]');   // changed below
  for (const l of ['Driver B', 'Hybrid A', 'Wedge C']) await f.click(`#tp-bagSections .bag-card[data-label="${l}"]`);
  const cardClicks = 4;
  await f.click('#tp-confirmBagBtn');
  await f.waitForSelector('#tp-chosenOverlay:not([hidden])');
  const practiceGame = await f.evaluate(() => {
    const s = TargetPractice.state;
    const sd = (x) => ({ club: x.clubLabel, variety: x.club.variety.key, letter: x.club.letter, course: x.course, power: x.power,
      aimDeg: x.aimDeg, aimDist: x.aimDist, distance: x.distance, lateral: x.lateralYards, zLat: x.zLat, zDist: x.zDist, batch: !!x.batch,
      hit: x.result.hit ? x.result.target.tier.key : null, ring: x.result.hit ? x.result.ring : null, points: x.result.points });
    return {
      shots: s.shotHistory.map(sd), practiceShots: s.practice.shots,
      clubs: s.practiceClubs.map((c) => ({ label: c.label, short: c.short, variety: c.variety.key, letter: c.letter, type: c.type.key,
        shots: c.shots.length, batch: c.shots.filter((x) => x.batch).length, estimate: c.estimate, hits: c.estHits, saved: c.estimateLog.length })),
      bag: s.bag.map((c) => c.label), seed: s.seed
    };
  });
  await f.click('#tp-chosenContinueBtn');
  await H.waitMockLog(page, /Would click Next/, 30000);
  const mock1 = await H.mockState(page);
  const log1 = await f.evaluate(() => JSON.parse(JSON.stringify(NF_LOG))).catch(() => null);
  const posts1 = posts.splice(0);

  // ================= tp-rounds =================
  const g = await H.openMockTarget(page, MOCK, { pid: 'R_tplog1', rng: 4242, seg: 'tp-rounds', fresh: false });
  await g.click('#tp-startPracticeBtn');
  const rExpect = [];
  let rcur = null, rt = tracker();
  const roundsGame = [];
  for (let r = 0; r < 5; r++) {
    await H.startRoundPlay(g);   // v40: prediction first
    rcur = await g.evaluate(() => { const s = TargetPractice.state; return { club: s.clubIndex, power: s.power, aim: s.aimAngle }; });
    for (let b = 0; b < 12; b++) {
      const s = H.ROUND_SCRIPT[b];
      await g.click(`#tp-clubButtons button[data-club="${s.club}"]`); if (s.club !== rcur.club) rt.club++; rcur.club = s.club;
      await H.setPower(g, s.power); if (s.power !== rcur.power) rt.power++; rcur.power = s.power;
      await g.click('#tp-aimStraight'); if (Math.abs(rcur.aim) > 1e-9) rt.aim++;
      for (let i = 0; i < Math.abs(s.aim); i++) { await g.click(s.aim < 0 ? '#tp-rotL' : '#tp-rotR'); rt.aim++; }
      rcur.aim = s.aim;
      if (r === 1 && b === 5) await sleep(IDLE_MS + 1500);   // idle inside round 2's play time
      await g.click('#tp-takeShotBtn');
      rExpect.push(rt); rt = tracker();
      await g.waitForFunction(() => TargetPractice.state.phase !== 'animating', null, { timeout: 15000, polling: 25 });
    }
    const next = await H.waitAfterRound(g);
    if (r === 0) { await setHidden(g, true); await sleep(1200); await setHidden(g, false); }   // hidden during round 1's review
    await sleep(250);
    roundsGame.push(await g.evaluate(() => { const s = TargetPractice.state; const x = s.rounds[s.rounds.length - 1];
      return { score: x.score, hits: x.hits, scored: x.scored, bulls: x.bulls, best: x.bestShots, course: x.course,
        per: x.perTarget.map((p) => [p.key, p.points]),
        shots: s.shotHistory.map((y) => ({ club: y.clubLabel, power: y.power, aimDeg: y.aimDeg, distance: y.distance, lateral: y.lateralYards,
          zLat: y.zLat, zDist: y.zDist, points: y.result.points })) }; }));
    if (next === 'tp-roundOverlay') await g.click('#tp-nextRoundBtn');
  }
  await g.waitForSelector('#tp-endOverlay:not([hidden])');
  await sleep(400);
  await g.click('#tp-endContinueBtn');
  await H.waitMockLog(page, /Would click Next/, 30000);
  const mock2 = await H.mockState(page);
  const log2 = await g.evaluate(() => JSON.parse(JSON.stringify(NF_LOG))).catch(() => null);
  const posts2 = posts.splice(0);
  if (RECORDS) {
    fs.writeFileSync(path.join(RECORDS, `${engine}-tp-practice-saves.json`), JSON.stringify(posts1, null, 1));
    fs.writeFileSync(path.join(RECORDS, `${engine}-tp-rounds-saves.json`), JSON.stringify(posts2, null, 1));
  }

  // ================= checks =================
  // Records as they reached the data store (last version of each record_id wins).
  function stored(postsX) {
    const byId = new Map();
    postsX.forEach((b) => {
      if (b.segment_record) byId.set(b.segment_record.record_id + '#' + (b.segment_record.status || ''), b.segment_record);
      Object.keys(b).forEach((k) => { if (Array.isArray(b[k])) b[k].forEach((r) => byId.set(r.record_id, r)); });
    });
    return [...byId.values()];
  }
  const recs1 = stored(posts1), recs2 = stored(posts2);
  const all = recs1.concat(recs2);
  const ofType = (recs, ty) => recs.filter((r) => r.record_type === ty);
  const finalSeg = (postsX) => postsX.filter((b) => /_final\.json$/.test(b.file)).map((b) => b.segment_record)[0];

  // 1. Field presence and nulls.
  const missing = [], nulls = {};
  for (const r of all) {
    const need = HEADER.concat(F[r.record_type] || []);
    if (!F[r.record_type]) missing.push(`${r.record_id}: unknown type ${r.record_type}`);
    need.forEach((k) => {
      if (!(k in r)) missing.push(`${r.record_type}.${k} (${r.record_id})`);
      else if (r[k] === null) { const key = `${r.record_type}.${k}`; nulls[key] = (nulls[key] || 0) + 1; }
    });
  }
  R('every spec field is present on every record (' + all.length + ' records, both segments)', missing.length === 0, missing.slice(0, 20));
  const badNulls = Object.keys(nulls).filter((k) => !NULL_OK[k.split('.')[1]]);
  results.nulls[engine] = Object.fromEntries(Object.entries(nulls).map(([k, n]) => [k, `${n}× — ${NULL_OK[k.split('.')[1]] || 'UNEXPECTED'}`]));
  R('every null field is an expected one', badNulls.length === 0, badNulls.length ? badNulls : Object.keys(nulls).length + ' kinds of expected nulls (listed in results.nulls)');
  const hdrOk = all.every((r) => r.pid === 'R_tplog1' && r.game === 'target' && r.game_version === VERSION && r.cond === 'fb-visible'
    && r.rng_seed === 4242 && r.test === false && typeof r.load_id === 'string' && r.load_id.length === 8);
  R('header: pid, game target, game_version ' + VERSION + ', cond, rng_seed, test:false, load_id on every record', hdrOk);
  R('tp-practice records carry segment tp-practice, tp-rounds records tp-rounds',
    recs1.every((r) => r.segment === 'tp-practice') && recs2.every((r) => r.segment === 'tp-rounds'));

  // 2. Practice shots vs the game.
  const pShots = ofType(recs1, 'shot').sort((a, b) => a.shot_no - b.shot_no);
  const r1 = (v) => Math.round(v * 10) / 10, r3 = (v) => Math.round(v * 1000) / 1000;
  const shotMismatch = [];
  R('one shot record per practice shot (' + practiceGame.practiceShots + ')', pShots.length === practiceGame.practiceShots && pShots.length === practiceGame.shots.length,
    `${pShots.length} records, game ${practiceGame.practiceShots}`);
  practiceGame.shots.forEach((s, i) => {
    const r = pShots[i]; if (!r) return;
    const want = { club: s.club, variety: s.variety, letter: s.letter, course: s.course, power: s.power, aim_deg: r1(s.aimDeg), aim_dist: r1(s.aimDist),
      total: r1(s.distance), lateral: r1(s.lateral), z_lat: r3(s.zLat), z_dist: r3(s.zDist), batch: s.batch, target_hit: s.hit,
      result: s.hit ? ['bullseye', 'inner', 'outer'][s.ring] : 'miss', points: s.points, phase: 'practice', round: null, shot_no: i + 1 };
    for (const k of Object.keys(want)) if (r[k] !== want[k]) shotMismatch.push(`shot ${i + 1}.${k}: ${JSON.stringify(r[k])} vs ${JSON.stringify(want[k])}`);
  });
  R('practice shot records match the game (club, variety, letter, course, power, aim, total, lateral, z_lat/z_dist to 0.001, result, points)',
    shotMismatch.length === 0, shotMismatch.slice(0, 10));
  // 3. Counters and decision time.
  const cMis = [];
  pShots.forEach((r, i) => {
    const e = expect[i]; if (!e) { cMis.push(`no expectation for shot ${i + 1}`); return; }
    if (r.aim_changes !== e.aim || r.power_changes !== e.power || r.club_changes !== e.club)
      cMis.push(`shot ${i + 1}${e.batch ? ' (batch)' : ''}: got a${r.aim_changes}/p${r.power_changes}/c${r.club_changes}, want a${e.aim}/p${e.power}/c${e.club}`);
  });
  R('aim / power / club change counters match the script on every practice shot (incl. drag = 1, re-pick = 0, keys, batch)', cMis.length === 0, cMis.slice(0, 10));
  R('shot 1 counters: aim 3, power 3, club 0', pShots[0] && pShots[0].aim_changes === 3 && pShots[0].power_changes === 3 && pShots[0].club_changes === 0,
    pShots[0] && { aim: pShots[0].aim_changes, power: pShots[0].power_changes, club: pShots[0].club_changes });
  R('shot 2 counters: aim 3 (map drag 1 + map click 1 + Aim straight 1), power 1 (one slider drag), club 2',
    pShots[1] && pShots[1].aim_changes === 3 && pShots[1].power_changes === 1 && pShots[1].club_changes === 2,
    pShots[1] && { aim: pShots[1].aim_changes, power: pShots[1].power_changes, club: pShots[1].club_changes });
  const s2 = pShots[1];
  R('shot 2: decision_hidden_ms ≈ 1.5 s of hidden tab, ≤ decision_ms', s2 && s2.decision_hidden_ms >= 1400 && s2.decision_hidden_ms <= 2500 && s2.decision_ms >= s2.decision_hidden_ms,
    s2 && { decision_ms: s2.decision_ms, decision_hidden_ms: s2.decision_hidden_ms });
  const singles = pShots.filter((r) => !r.batch), batchRecs = pShots.filter((r) => r.batch);
  R('single shots: decision_ms a positive whole number; hidden 0 except shot 2',
    singles.every((r) => Number.isInteger(r.decision_ms) && r.decision_ms > 0 && (r === s2 || r.decision_hidden_ms === 0)),
    singles.slice(0, 4).map((r) => [r.decision_ms, r.decision_hidden_ms]));
  R('instant batch: 8 shots, same batch_id, batch_shot_no 1–8, decision_ms / decision_hidden_ms null',
    batchRecs.length === 8 && batchRecs.every((r) => r.batch_id === batchRecs[0].batch_id && r.decision_ms === null && r.decision_hidden_ms === null)
      && batchRecs.map((r) => r.batch_shot_no).join() === '1,2,3,4,5,6,7,8' && batchRecs.map((r) => r.power).join() === '25,25,50,50,75,75,100,100',
    batchRecs.map((r) => [r.batch_id, r.batch_shot_no, r.power, r.decision_ms]));
  R('rounding: total / lateral / aim to 0.1, z_lat / z_dist to 0.001',
    pShots.every((r) => [r.total, r.lateral, r.aim_deg, r.aim_dist, r.aimed_off, r.offset_deg].every((v) => v == null || Math.abs(v * 10 - Math.round(v * 10)) < 1e-9)
      && [r.z_lat, r.z_dist].every((v) => Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6)));
  R('club_shot_no counts each club\'s practice shots', practiceGame.clubs.every((c) => {
    const rs = pShots.filter((r) => r.club === c.label); return rs.map((r) => r.club_shot_no).join() === rs.map((_, i) => i + 1).join();
  }));

  // 4. Estimates.
  const ests = ofType(recs1, 'estimate').sort((a, b) => a.estimate_no - b.estimate_no);
  const estD = ests.filter((e) => e.question === 'distance_100'), estH = ests.filter((e) => e.question === 'hits_of_10');
  const got = estD.map((e) => `${e.when}/${e.action}`), want = estimateLog.map((e) => `${e.when}/${e.action}`);
  R('v40: two estimate records per card closed (distance_100 + hits_of_10, same card_no), cards in order (' + want.length + ')',
    got.join() === want.join() && estH.length === estD.length && estD.every((e, i) => e.card_no === i + 1 && estH[i].card_no === i + 1 && estH[i].action === e.action), { got, want });
  R('estimate records: answer set only on save, truth set, response_ms > 0, shots_at_time = club shots so far',
    ests.every((e) => ['distance_100', 'hits_of_10'].includes(e.question) && (e.action === 'save') === (e.answer !== null) && e.truth != null && e.response_ms > 0
      && e.shots_at_time === pShots.filter((r) => r.club === e.club && Date.parse(r.client_time) <= Date.parse(e.client_time)).length),
    ests.slice(0, 3));
  const lastEst = {}; estD.filter((e) => e.action === 'save').forEach((e) => { lastEst[e.club] = e.answer; });

  // 5. club_summary and bag_choice.
  const cs = ofType(recs1, 'club_summary');
  const csMis = [];
  practiceGame.clubs.forEach((c) => {
    const r = cs.find((x) => x.club === c.label);
    if (!r) { csMis.push('no record for ' + c.label); return; }
    if (r.shots !== c.shots || r.batch_shots !== c.batch || r.final_est_distance !== c.estimate || r.final_est_hits !== c.hits || r.estimate_count !== c.saved
      || r.variety !== c.variety || r.letter !== c.letter || r.chosen !== practiceGame.bag.includes(c.label) || lastEst[c.label] !== c.estimate)
      csMis.push(c.label);
  });
  R('club_summary: 9 records; shots, batch_shots, final_est_distance / _hits, estimate_count, chosen match the game', cs.length === 9 && csMis.length === 0, csMis);
  const timeSum = cs.reduce((a, r) => a + r.time_ms, 0);
  R('club_summary: time adds up to practice time (> 0), every club with shots has time', timeSum > 5000 && cs.every((r) => r.shots === 0 || r.time_ms > 0)
    && cs.some((r) => r.hidden_ms >= 1400), { timeSum, hidden: cs.map((r) => r.hidden_ms) });
  const bc = ofType(recs1, 'bag_choice')[0] || {};
  const sum1 = mock1.ed || mock1.embedded || {};
  R('bag_choice: chosen clubs / varieties / letters, estimates on the cards, nudge, clubs_under_5, card clicks',
    bc.driver_club === 'Driver B' && bc.hybrid_club === 'Hybrid A' && bc.wedge_club === 'Wedge C' && bc.letters_chosen === 'B,A,C'
      && bc.nudge_shown === true && bc.nudge_count === nudges && bc.card_clicks === cardClicks && bc.chooser_opens === 1
      && bc.clubs_under_5 === practiceGame.clubs.filter((c) => c.shots < 5).length
      && bc.practice_shots === practiceGame.practiceShots && bc.choose_ms > 0
      && practiceGame.clubs.every((c) => bc[`est_distance_${c.type}_${c.letter.toLowerCase()}`] === c.estimate && bc[`est_hits_${c.type}_${c.letter.toLowerCase()}`] === c.hits)
      && bc.bag_seed === practiceGame.seed,
    { bc_letters: bc.letters_chosen, nudges: bc.nudge_count, clicks: bc.card_clicks, under5: bc.clubs_under_5, seed: bc.bag_seed });

  // 6. Rounds.
  const rShots = ofType(recs2, 'shot').sort((a, b) => a.shot_no - b.shot_no);
  const rMis = [];
  roundsGame.forEach((rg, ri) => rg.shots.forEach((s, b) => {
    const r = rShots[ri * 12 + b]; if (!r) { rMis.push(`r${ri + 1} b${b + 1} missing`); return; }
    if (r.round !== ri + 1 || r.ball_no !== b + 1 || r.phase !== 'round' || r.club !== s.club || r.power !== s.power || r.total !== r1(s.distance)
      || r.lateral !== r1(s.lateral) || r.z_lat !== r3(s.zLat) || r.z_dist !== r3(s.zDist) || r.points !== s.points || r.club_shot_no !== null)
      rMis.push(`r${ri + 1} b${b + 1}`);
    const e = rExpect[ri * 12 + b];
    if (r.aim_changes !== e.aim || r.power_changes !== e.power || r.club_changes !== e.club) rMis.push(`r${ri + 1} b${b + 1} counters a${r.aim_changes}/p${r.power_changes}/c${r.club_changes} want a${e.aim}/p${e.power}/c${e.club}`);
  }));
  R('round shots: 60 records, round / ball_no / club / power / total / lateral / draws / points / counters match', rShots.length === 60 && rMis.length === 0, rMis.slice(0, 8));
  R('round shot labels are the chosen clubs ("Driver B", "Hybrid A", "Wedge C")',
    [...new Set(rShots.map((r) => r.club))].sort().join() === 'Driver B,Hybrid A,Wedge C' && rShots.every((r) => r.letter && r.variety));
  const rounds = ofType(recs2, 'round').sort((a, b) => a.round - b.round);
  const sum2 = mock2.ed || mock2.embedded || {};
  R('round records: 5, scores / hits / bulls / best_shots / per-target points match the game',
    rounds.length === 5 && rounds.every((r, i) => {
      const rg = roundsGame[i], per = Object.fromEntries(rg.per);
      return r.score === rg.score && r.hits === rg.hits && r.scored === rg.scored && r.bulls === rg.bulls && r.best_shots === rg.best && r.course === rg.course
        && r.near_points === per.near && r.mid_points === per.mid && r.far_points === per.far && r.aimed_near + r.aimed_mid + r.aimed_far === 12;
    }), rounds.map((r) => r.score));
  R('round records: play_ms > 0 and review_ms set on all 5 (round 5 from CONTINUE)',
    rounds.every((r) => r.play_ms > 0 && Number.isInteger(r.review_ms) && r.review_ms > 0), rounds.map((r) => [r.play_ms, r.review_ms]));
  R('round 1: review_hidden_ms ≈ 1.2 s (tab hidden on the round card); play hidden 0',
    rounds[0] && rounds[0].review_hidden_ms >= 1100 && rounds[0].review_hidden_ms <= 2200 && rounds[0].hidden_ms === 0,
    rounds[0] && { review_ms: rounds[0].review_ms, review_hidden_ms: rounds[0].review_hidden_ms });
  R(`round 2: idle_ms > 0 (no input for ${IDLE_MS + 1500} ms, IDLE_MS ${IDLE_MS}); idle ≤ play`,
    rounds[1] && rounds[1].idle_ms >= 1000 && rounds[1].idle_ms <= rounds[1].play_ms, rounds[1] && { play_ms: rounds[1].play_ms, idle_ms: rounds[1].idle_ms });

  // 7. Saves and summaries.
  const tags = (p) => p.map((b) => (b.file || '').replace(/^R_tplog1_tp-(practice|rounds)_a1_/, '').replace(/\.json$/, ''));
  const t1 = tags(posts1), t2 = tags(posts2);
  const nEst = estimateLog.length;
  const wantP = (() => { const pc = []; const n = practiceGame.practiceShots; for (let k = 20; k <= n; k += 20) pc.push(k); return pc; })();
  const pTags = t1.filter((x) => /^p\d+$/.test(x)).map((x) => +x.slice(1));
  R('tp-practice saves: one per 20 practice shots, one per estimate record, bag, final',
    pTags.length === wantP.length && pTags.every((v, i) => v >= wantP[i] && v < wantP[i] + 8)
      && t1.filter((x) => /^e\d+$/.test(x)).length === nEst && t1.includes('bag') && t1[t1.length - 1] === 'final',
    t1);
  R('tp-rounds saves: r1-pred, r1, r1-review … r5-pred, r5, final', t2.join() === 'r1-pred,r1,r1-review,r2-pred,r2,r2-review,r3-pred,r3,r3-review,r4-pred,r4,r4-review,r5-pred,r5,final', t2);
  const preds = ofType(recs2, 'prediction').sort((a, b) => a.round - b.round);
  R('v40: prediction records ×5 match the script and are copied onto the round records',
    preds.length === 5 && preds.every((p, i) => { const w = H.scriptPrediction(i + 1); return p.pred_points === w.points && p.pred_low === w.low && p.pred_high === w.high && p.response_ms > 0
      && rounds[i].pred_points === w.points && rounds[i].pred_low === w.low && rounds[i].pred_high === w.high; }), preds.map((p) => [p.round, p.pred_points, p.pred_low, p.pred_high]));
  R('every save carries the segment record', posts1.concat(posts2).every((b) => b.segment_record && b.segment_record.record_type === 'segment'));
  const savedShots = posts1.filter((b) => /^R_.*_p\d+\.json$/.test(b.file)).map((b) => (b.shots || []).length);
  R('practice saves carry the shots not yet saved (no shot is sent twice before the final save)',
    (() => { const ids = posts1.filter((b) => !/_final\.json$/.test(b.file)).flatMap((b) => (b.shots || []).map((r) => r.record_id)); return new Set(ids).size === ids.length && ids.length === pShots.length; })(),
    savedShots);
  const s1 = finalSeg(posts1), sR = finalSeg(posts2);
  R('segment record (tp-practice, final): complete, practice_shots, batch_count 1, batch_shots 8, course_switches, estimates_saved, nudge_count; round fields null',
    s1 && s1.status === 'complete' && s1.finished_at && s1.practice_shots === practiceGame.practiceShots && s1.batch_count === 1 && s1.batch_shots === 8
      && s1.course_switches === switches && s1.estimates_saved === estimateLog.filter((e) => e.action === 'save').length && s1.nudge_count === nudges
      && s1.rounds_played === null && s1.total_score === null && s1.error_code === null && s1.hidden_ms >= 1400,
    s1 && { status: s1.status, practice_shots: s1.practice_shots, batch_count: s1.batch_count, course_switches: s1.course_switches, want_switches: switches,
      estimates_saved: s1.estimates_saved, hidden_ms: s1.hidden_ms });
  R('segment record (tp-rounds, final): complete, rounds_played 5, total_score = tp_total, letters, practice fields null',
    sR && sR.status === 'complete' && sR.rounds_played === 5 && sR.total_score === rounds.reduce((a, r) => a + r.score, 0) && sR.letters === 'B,A,C'
      && sR.practice_shots === null && sR.hidden_ms >= 1100,
    sR && { rounds_played: sR.rounds_played, total_score: sR.total_score, letters: sR.letters, hidden_ms: sR.hidden_ms });
  R('wall clock ≈ active + idle + hidden (tp-rounds segment, ±1.5 s)',
    sR && Math.abs((Date.parse(sR.finished_at) - Date.parse(sR.started_at)) - (sR.active_ms + sR.idle_ms + sR.hidden_ms)) < 1500,
    sR && { wall: Date.parse(sR.finished_at) - Date.parse(sR.started_at), sum: sR.active_ms + sR.idle_ms + sR.hidden_ms });

  // nf-done messages, as the mock page received them.
  const doneMsgs = (st) => (st.log || []).filter((l) => /nf-done/.test(l.text));
  const ed1 = mock1.embedded || mock1.ed || {}, ed2 = mock2.embedded || mock2.ed || {};
  const doneOf = (st) => (st.received || []).map((m) => m.data).filter((d) => d && d.type === 'nf-done').pop() || null;
  results.summaries[engine] = { nf_done_tp_practice: doneOf(mock1), nf_done_tp_rounds: doneOf(mock2), embedded_after_both: ed2 };
  const d1 = doneOf(mock1), d2 = doneOf(mock2);
  R('nf-done summary keys are exactly the field reference (tp-practice 6, tp-rounds 7); attempt 1',
    d1 && d2 && Object.keys(d1.summary).sort().join() === PRACTICE_SUMMARY.slice().sort().join() && Object.keys(d2.summary).sort().join() === ROUNDS_SUMMARY.slice().sort().join()
      && d1.attempt === 1 && d2.attempt === 1 && d1.saved === true && d2.saved === true,
    { tp_practice: d1 && Object.keys(d1.summary), tp_rounds: d2 && Object.keys(d2.summary) });
  const keys1 = Object.keys(ed1).filter((k) => k.startsWith('tp_') && !/_(practice|rounds)_(saved|attempt|failed|error)$/.test(k));
  R('tp-practice nf-done → embedded data: exactly the field reference keys, saved = 1',
    PRACTICE_SUMMARY.every((k) => k in ed1) && String(ed1.tp_practice_saved) === '1' && String(ed1.tp_practice_shots) === String(practiceGame.practiceShots)
      && ed1.tp_bag === practiceGame.seed && ed1.tp_letters === 'B,A,C',
    Object.fromEntries(Object.entries(ed1).filter(([k]) => k.startsWith('tp_'))));
  R('tp-rounds nf-done → embedded data: tp_r1..tp_r5 = round records, tp_total, tp_best_aims, saved = 1',
    ROUNDS_SUMMARY.every((k) => k in ed2) && rounds.every((r, i) => String(ed2['tp_r' + (i + 1)]) === String(r.score))
      && String(ed2.tp_total) === String(rounds.reduce((a, r) => a + r.score, 0)) && String(ed2.tp_best_aims) === String(rounds.reduce((a, r) => a + r.best_shots, 0))
      && String(ed2.tp_rounds_saved) === '1',
    Object.fromEntries(Object.entries(ed2).filter(([k]) => /^tp_(r\d|total|best|rounds_)/.test(k))));
  R('no console errors (both segments)', errors.length === 0, errors.slice(0, 5));

  // Examples for the report: one of each type.
  const pick = (recs, ty, fn) => recs.filter((r) => r.record_type === ty).find(fn || (() => true));
  results.examples[engine] = {
    shot_practice: s2, shot_batch: batchRecs[0], shot_round: rShots[13],
    estimate_later: ests.filter((e) => e.action === 'later'), estimate_save: ests.filter((e) => e.action === 'save' && e.when === 'edit'),
    prediction: preds[1],
    club_summary: cs.find((r) => r.chosen), bag_choice: bc, round: rounds[1],
    segment_tp_practice: s1, segment_tp_rounds: sR
  };
  results.saves = { tp_practice: t1, tp_rounds: t2 };
  await context.close();

  // ================= 8. local testing and lockdown =================
  {
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 }, acceptDownloads: true });
    await routes(ctx);
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
    await p.goto(base + '/target.html?segment=tp-practice&rng=7');
    await p.waitForFunction(() => window.TargetPractice && TargetPractice.state);
    await p.click('#tp-startPracticeBtn');
    await p.click('#tp-takeShotBtn');
    await p.waitForFunction(() => TargetPractice.state.phase === 'shooting');
    const loc = await p.evaluate(() => ({ recs: NF_LOG.map((r) => ({ type: r.record_type, test: r.test, pid: r.pid })), btn: !document.getElementById('dlDataBtn').hidden,
      bar: !document.querySelector('.mode-tabs').hidden }));
    R('local testing (no pid): records marked test:true, pid local-test', loc.recs.length > 0 && loc.recs.every((r) => r.test === true && r.pid === 'local-test'), loc.recs);
    const downloads = [];
    p.on('download', (d) => downloads.push(d.suggestedFilename()));
    await p.click('#dlDataBtn');
    await sleep(1500);
    R('debug: "Download data" button visible and gives CSV + JSON', loc.btn && loc.bar && downloads.length === 2 && downloads.some((d) => d.endsWith('.csv')) && downloads.some((d) => d.endsWith('.json')), downloads);
    await p.goto(base + '/target.html?pid=R_lock&segment=tp-practice&rng=7');
    await p.waitForFunction(() => window.TargetPractice && TargetPractice.state);
    const lock = await p.evaluate(() => ({ btn: !document.getElementById('dlDataBtn').hidden, bar: !document.querySelector('.mode-tabs').hidden, panel: !!document.getElementById('researchPanel') }));
    R('study mode without debug: no Download data button, no bar, no researcher panel', !lock.btn && !lock.bar && !lock.panel, lock);
    await p.goto(base + '/target.html?pid=R_lock&segment=tp-rounds&bag=DCHPWV&letters=B,A,C&rng=7&debug=1');
    await p.waitForFunction(() => window.TargetPractice && TargetPractice.state);
    const dbg = await p.evaluate(() => ({ btn: !document.getElementById('dlDataBtn').hidden, tester: !document.getElementById('testerSwitchBtn').hidden }));
    R('study mode with debug=1 (tp-rounds): Download data shown, tester switch still hidden (tp-all only)', dbg.btn && !dbg.tester, dbg);
    R('no page errors (local / lockdown pages)', errs.length === 0, errs);
    await ctx.close();
  }
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
  try { await main(engine, browser); } catch (e) { report(engine, 'script ran to the end', false, String(e && e.stack || e).slice(0, 1500)); }
  await browser.close();
}
server.close();
results.finished = new Date().toISOString();
results.failed = failed; results.not_run = notRun;
if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(`\n${results.tests.length - failed} passed, ${failed} failed${notRun ? `, ${notRun} engine(s) not run` : ''}`);
process.exit(failed ? 1 : (notRun ? 2 : 0));
