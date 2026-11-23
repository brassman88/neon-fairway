// Neon Fairway: target.html measurement tests (prompt 7, Target Practice v40; v41: spray chart in fb-hidden,
// new wording of the out-of-10 question, hybrid D 116 yd).
//   node tests/target-measure.mjs [--browser chromium,firefox,webkit] [--out results.json] [--shots folder]
// Needs Playwright (npm i -D playwright; npx playwright install chromium).
//
// Runs inside test/mock-qualtrics.html at 1280×720 (the game in its Qualtrics iframe) and checks:
//  m1. True values: the game's truthTable() equals the same simulation run in Node from js/nf-core.js;
//      the three varieties of each type differ and lie between 2 and 9.
//  m2. Estimate card (tp-practice, cond=fb-hidden to show practice is unaffected): two questions with the
//      exact wording, empty boxes, Save off until both are whole numbers in range (301, 11, 2.5, -1, letters
//      rejected), saved answers shown when changing, two estimate records per card (question, answer, truth,
//      card_no), the practice bar, the required cards, the club cards in "Choose your clubs" and the
//      "Clubs chosen" card show both answers; club_summary / bag_choice / nf-done carry them; no slider.
//  m3. Prediction card (tp-rounds, both conditions): opens after the new course is drawn and before ball 1
//      (no shot possible, Space does nothing), the exact questions, empty boxes, the rules (whole numbers,
//      low ≤ prediction ≤ high, 0 … 12 × biggest bullseye), one prediction record per round (saved at once),
//      response_ms, copied to the round record, ball 1's decision_ms and play_ms start after it.
//  m4. fb-visible vs fb-hidden: same rng and bag, so the same shots. In fb-hidden no running or round total is
//      on screen at any checkpoint (after balls 4, 8, 12 of every round, on every round card and the end
//      card): structural checks of each element, and a scan of all visible text for the totals (the same scan
//      finds them in fb-visible). Per-shot feedback (result line, latest shot) stays. Records carry cond; the
//      segment record says feedback hidden / visible. Unknown cond → treated as fb-visible with a warning.
//      v41: in fb-hidden scored rounds the Spray Chart switch is hidden, only the latest ball is drawn and
//      spray_on is false; fb-visible and practice keep the switch, every ball and spray_on true.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO, serve, routes, sleep } from './lib.mjs';
import * as H from './target-helpers.mjs';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch (e) { pw = await import('playwright'); }
const NF = require(path.join(REPO, 'js/nf-core.js'));

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const ENGINES = (opt('--browser') || 'chromium').split(',').map((s) => s.trim()).filter(Boolean);
const OUT = opt('--out'), SHOTS = opt('--shots');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const VERSION = 'v41';
const RNG = 7311;

const { server, base } = await serve({ '/': REPO });
const port = new URL(base).port;
const MOCK = `http://127.0.0.1:${port}/test/mock-qualtrics.html`;
const ENDPOINT = `http://127.0.0.1:${port}/__save`;

const results = { started: new Date().toISOString(), version: VERSION, engines: {}, tests: [], truth: null, examples: {}, leakScan: {} };
let failed = 0, notRun = 0;
function report(engine, name, ok, detail) {
  results.tests.push({ engine, name, ok, detail });
  if (!ok) failed++;
  const d = detail == null ? '' : '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail));
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${engine}] ${name}${d.length > 700 ? d.slice(0, 700) + '…' : d}`);
}

// ---- The same truth simulation in Node (independent copy of the spec's recipe) ----
function nodeTruth() {
  const Q = { driver: { yd: 140, r: 8 }, hybrid: { yd: 116, r: 5 }, wedge: { yd: 60, r: 2 } };   // v41: hybrid 116 yd
  const out = [];
  for (const type of NF.CLUB_TYPES) for (const variety of NF.SPREAD_VARIETIES) {
    const stats = NF.buildClubStats(type, variety), q = Q[type.key];
    const power = Math.min(100, Math.round(100 * q.yd / stats.maxDistance));
    const rng = NF.rng(NF.subSeed(20261120, 'truth', type.key, variety.key));
    let inside = 0;
    for (let i = 0; i < 20000; i++) {
      const sp = NF.rangeSpread(stats, power);
      const zLat = NF.clampedGaussian(rng), off = zLat * sp.latSdDeg;
      const zDist = NF.clampedGaussian(rng), b = stats.maxDistance * power / 100;
      const d = Math.max(5, b + zDist * (b * sp.distSdFrac)), a = off * Math.PI / 180;
      if (Math.hypot(d * Math.cos(a) - q.yd, d * Math.sin(a)) <= q.r) inside++;
    }
    out.push({ type: type.key, variety: variety.key, max_distance: stats.maxDistance, target_yd: q.yd, radius_yd: q.r, power, truth_hits: Math.round(1000 * inside / 20000) / 100 });
  }
  return out;
}

// ---- Screen evidence for the totals scan ----
// Visible text of the game, minus the per-shot feedback the condition keeps (result line, latest shot in
// the log) and the controls (aim / power readouts). Numbers that are a running or round total must not be in it.
const screenText = (f) => f.evaluate(() => {
  const vis = (el) => !!(el && (el.offsetParent || el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden');
  // innerText of the live page (respects display:none); strip allowed parts by subtracting their text.
  let text = document.body.innerText;
  const allowed = [document.getElementById('tp-resultPanel'), document.querySelector('#tp-shotLogList li.latest'), document.querySelector('.tp-controls')];
  allowed.forEach((el) => { if (el && vis(el)) { const t = el.innerText; if (t) text = text.split(t).join(' '); } });
  return { text, nums: (text.match(/\d+/g) || []).map(Number) };
});
// What each total-bearing element shows.
const totalsUi = (f) => f.evaluate(() => {
  const t = (id) => { const e = document.getElementById(id); return e && !e.hidden && e.offsetParent !== null ? e.innerText.trim() : null; };
  return {
    progress: document.getElementById('tp-progressBar').innerText,
    chips: [...document.querySelectorAll('#tp-roundStrip .rchip')].map((c) => c.innerText.replace(/\s+/g, ' ').trim()),
    tvHits: [...document.querySelectorAll('#tp-targetCards .tv-hits')].map((e) => e.innerText.trim()),
    logItems: document.querySelectorAll('#tp-shotLogList li:not(.shot-log-empty)').length,
    roundCard: !document.getElementById('tp-roundOverlay').hidden ? document.querySelector('#tp-roundOverlay .modal').innerText.replace(/\s+/g, ' ').trim() : null,
    endCard: !document.getElementById('tp-endOverlay').hidden ? document.querySelector('#tp-endOverlay .modal').innerText.replace(/\s+/g, ' ').trim() : null,
    result: t('tp-resultPanel'),
    // v41: the Spray Chart switch and the balls drawn on the map
    sprayShown: (() => { const l = document.getElementById('tp-sprayLabel'); return !!(l && !l.hidden && l.offsetParent !== null); })(),
    sprayChecked: document.getElementById('tp-sprayToggle').checked,
    sprayApplied: TargetPractice.sprayApplied,
    balls: TargetPractice.ballsShown()
  };
});
// Totals at this moment, and numbers that are on screen for other reasons (so a total equal to one of them is ambiguous).
const totalsNow = (f) => f.evaluate(() => {
  const s = TargetPractice.state;
  const done = s.rounds.map((r) => r.score);
  const totals = new Set();
  if (s.phase !== 'predict' && s.shotsTaken > 0) totals.add(s.score);
  let run = 0; done.forEach((v) => { totals.add(v); run += v; totals.add(run); });
  s.targets.forEach((t) => { if (t.points) totals.add(t.points); });
  const legit = new Set([...Array(13).keys()]);
  s.layout.targets.forEach((t) => { t.points.forEach((p) => legit.add(p)); legit.add(t.distance); legit.add(Math.round(Math.max(t.ringsN[2].d, t.ringsN[2].w) * 2)); });
  [90, 180, 260, 100].forEach((v) => legit.add(v));
  return { totals: [...totals].filter((v) => v > 0), legit: [...legit] };
});

async function main(engine, browser) {
  const R = (name, ok, detail) => report(engine, name, ok, detail);
  const errors = [];
  const shotEl = async (f, name) => { if (SHOTS) await (await f.frameElement()).screenshot({ path: path.join(SHOTS, `${engine}-${name}.png`) }); };

  // ================= m1. truth table =================
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await routes(ctx);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.goto(base + '/target.html?pid=R_truth&segment=tp-practice&rng=1');
    await p.waitForFunction(() => window.TargetPractice && TargetPractice.state);
    const t0 = Date.now();
    const game = await p.evaluate(() => TargetPractice.truthTable());
    const ms = Date.now() - t0;
    const node = nodeTruth();
    results.truth = game;
    R('m1 truth table: the game equals the Node simulation of the spec recipe (9 clubs, 20,000 shots, fixed seed)', JSON.stringify(game) === JSON.stringify(node), { game, node });
    const byType = ['driver', 'hybrid', 'wedge'].map((t) => game.filter((r) => r.type === t).map((r) => r.truth_hits));
    R('m1 truth table: within each type the three varieties differ by ≥ 1 and all lie in 2–9',
      byType.every((v) => v.every((x) => x >= 2 && x <= 9) && Math.min(Math.abs(v[0] - v[1]), Math.abs(v[0] - v[2]), Math.abs(v[1] - v[2])) >= 1),
      Object.fromEntries(['driver', 'hybrid', 'wedge'].map((t, i) => [t, byType[i]])));
    // v41: the published table (spec, README, changelog) and the hybrid recalibration.
    const PUBLISHED = { driver: { yd: 140, r: 8, control: 7.31, power: 5.60, vertical: 3.87 }, hybrid: { yd: 116, r: 5, control: 7.86, power: 4.43, vertical: 3.26 },
      wedge: { yd: 60, r: 2, control: 7.65, power: 4.50, vertical: 2.94 } };
    const pubBad = game.filter((r) => { const w = PUBLISHED[r.type]; return !(r.target_yd === w.yd && r.radius_yd === w.r && r.truth_hits === w[r.variety]); });
    R('m1 truth table (v41) equals the published table: Driver 140/8 7.31·5.60·3.87, Hybrid 116/5 7.86·4.43·3.26, Wedge 60/2 7.65·4.50·2.94 (Control·Power·Vertical)',
      pubBad.length === 0, pubBad.length ? pubBad : game.map((r) => `${r.type}-${r.variety} ${r.target_yd}/${r.radius_yd} ${r.truth_hits} (${r.power}%)`));
    const hyb = game.filter((r) => r.type === 'hybrid');
    R('m1 hybrid (v41): all three varieties between 3 and 8, Control ≤ 8, the three ≥ 1 apart',
      hyb.every((r) => r.truth_hits >= 3 && r.truth_hits <= 8) && hyb.find((r) => r.variety === 'control').truth_hits <= 8
        && Math.min(...hyb.flatMap((a, i) => hyb.slice(i + 1).map((b) => Math.abs(a.truth_hits - b.truth_hits)))) >= 1,
      hyb.map((r) => `${r.variety} ${r.truth_hits}`));
    R('m1 truth table: distance truth = max distance; power = min(100, round(100·D/max))',
      game.every((r) => r.power === Math.min(100, Math.round(100 * r.target_yd / r.max_distance))), game.map((r) => r.power));
    R('m1 truth table is computed in the page quickly (< 1.5 s for all 9 clubs)', ms < 1500, ms + ' ms');
    await ctx.close();
  }

  // ================= m2. tp-practice: estimate cards =================
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await routes(context);
  const posts = [];
  await context.route(/\/__save$/, async (route) => {
    let body = null; try { body = JSON.parse(route.request().postData()); } catch (e) { body = {}; }
    posts.push(body);
    await route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'Access-Control-Allow-Origin': '*' }, body: 'ok' });
  });
  await context.addInitScript((ep) => { window.NF_BRIDGE_CONFIG = { DATA_ENDPOINT: ep }; }, ENDPOINT);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(String(e && e.stack || e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const PID = 'R_meas1';
  let f = await H.openMockTarget(page, MOCK, { pid: PID, rng: RNG, seg: 'tp-practice', cond: 'fb-hidden' });
  await f.click('#tp-startPracticeBtn');
  await H.waitPhase(f, ['shooting']);
  R('m2 no estimate slider left in the page', await f.evaluate(() => !document.getElementById('tp-estimateSlider') && !document.querySelector('.estimate-modal input[type=range]')));
  // Five shots with club 0 → the 5-shot card.
  for (let i = 0; i < 5; i++) {
    await f.click('#tp-clubButtons button[data-club="0"]');
    await H.setPower(f, 80 + i * 4);
    await f.click('#tp-takeShotBtn');
    await f.waitForFunction(() => TargetPractice.state.phase !== 'animating', null, { timeout: 15000 });
  }
  // Practice is unaffected by fb-hidden: full shot log, hits / points in Target Values, practice chip.
  await H.waitPhase(f, ['estimate']);
  const prac = await f.evaluate(() => ({ log: document.querySelectorAll('#tp-shotLogList li:not(.shot-log-empty)').length,
    tv: [...document.querySelectorAll('#tp-targetCards .tv-hits')].map((e) => e.innerText.trim()), chip: document.querySelector('#tp-roundStrip .rchip.practice') ? document.querySelector('#tp-roundStrip .rchip.practice').innerText : null }));
  R('m2 practice under cond=fb-hidden is unchanged: shot log lists every shot of the club, Target Values show hits and points',
    prac.log === 5 && prac.tv.every((t) => /Practice here: \d+ hits? · \d+ pts/.test(t)), prac);
  const pracSpray = await f.evaluate(() => { const l = document.getElementById('tp-sprayLabel');
    return { toggleShown: !!(l && !l.hidden && l.offsetParent !== null), checked: document.getElementById('tp-sprayToggle').checked, applied: TargetPractice.sprayApplied, balls: TargetPractice.ballsShown(),
      sprayOn: NF_LOG.filter((r) => r.record_type === 'shot').map((r) => r.spray_on) }; });
  R('m2 v41 practice under cond=fb-hidden: Spray Chart switch shown and on, all 5 balls on the map, practice shot records spray_on true',
    pracSpray.toggleShown && pracSpray.checked && pracSpray.applied === true && pracSpray.balls === 5 && pracSpray.sprayOn.length === 5 && pracSpray.sprayOn.every((v) => v === true), pracSpray);
  const club0 = await f.evaluate(() => { const c = TargetPractice.state.practiceClubs[0]; return { label: c.label, type: c.type.key, variety: c.variety.key, max: c.stats.maxDistance }; });
  const truth0 = results.truth.find((r) => r.type === club0.type && r.variety === club0.variety);
  const card = await f.evaluate(() => ({
    q1: document.getElementById('tp-estDistQ').innerText.trim(), q2: document.getElementById('tp-estHitsQ').innerText.trim(),
    v1: document.getElementById('tp-estDist').value, v2: document.getElementById('tp-estHits').value,
    save: document.getElementById('tp-saveEstimateBtn').disabled, msg: document.getElementById('tp-estimateMsg').innerText,
    t1: document.getElementById('tp-estDist').type, t2: document.getElementById('tp-estHits').type,
    min1: document.getElementById('tp-estDist').min, max1: document.getElementById('tp-estDist').max, max2: document.getElementById('tp-estHits').max }));
  const Q1 = `At 100% power, how far does ${club0.label} go on average? (yards)`;
  const Q2 = `You aim at a target ${truth0.target_yd} yd away with ${club0.label}, using the power that sends the ball ${truth0.target_yd} yd on average. Out of 10 balls, how many land within ${truth0.radius_yd} yd of its centre?`;   // v41
  R('m2 5-shot card: the two questions, worded as specified', card.q1 === Q1 && card.q2 === Q2, { q1: card.q1, q2: card.q2 });
  R('m2 5-shot card: number boxes start empty (0–300 and 0–10), Save off, "Answer both questions to save."',
    card.v1 === '' && card.v2 === '' && card.save && card.t1 === 'number' && card.t2 === 'number' && card.min1 === '0' && card.max1 === '300' && card.max2 === '10' && /Answer both/.test(card.msg), card);
  await shotEl(f, 'm2-estimate-card-empty');
  // Validation.
  const tryVals = async (d, h) => { await f.fill('#tp-estDist', d); await f.fill('#tp-estHits', h); return f.evaluate(() => ({ save: document.getElementById('tp-saveEstimateBtn').disabled, msg: document.getElementById('tp-estimateMsg').innerText,
    bad1: document.getElementById('tp-estDist').classList.contains('bad'), bad2: document.getElementById('tp-estHits').classList.contains('bad') })); };
  const v301 = await tryVals('301', '11');
  await shotEl(f, 'm2-estimate-card-out-of-range');
  const vDec = await tryVals('212.5', '6');
  const vNeg = await tryVals('210', '-1');
  const vOne = await tryVals('210', '');
  const vOk = await tryVals('212', '6');
  R('m2 validation: 301 / 11 / 212.5 / −1 rejected with a message, one box empty keeps Save off, 212 + 6 turns Save on',
    v301.save && v301.bad1 && v301.bad2 && /300/.test(v301.msg) && /10/.test(v301.msg) && vDec.save && vDec.bad1 && vNeg.save && vNeg.bad2 && vOne.save && !vOne.bad1 && !vOk.save && !vOk.bad1 && !vOk.bad2,
    { v301, vDec, vNeg, vOne, vOk });
  await shotEl(f, 'm2-estimate-card-filled');
  await f.click('#tp-saveEstimateBtn');
  await H.waitPhase(f, ['shooting']);
  const row = await f.evaluate(() => ({ v: document.getElementById('tp-estValue').innerText, b: document.getElementById('tp-editEstimateBtn').innerText }));
  R('m2 practice bar shows both answers ("212 yd at 100% · 6 of 10", Change)', row.v === '212 yd at 100% · 6 of 10' && /change/i.test(row.b), row);
  // Change: the boxes show the saved answers; cancel.
  await f.click('#tp-editEstimateBtn');
  const edit = await f.evaluate(() => ({ v1: document.getElementById('tp-estDist').value, v2: document.getElementById('tp-estHits').value, save: document.getElementById('tp-saveEstimateBtn').disabled, later: document.getElementById('tp-estimateLaterBtn').innerText }));
  R('m2 changing: the boxes show the saved answers (212, 6), Save on, Cancel', edit.v1 === '212' && edit.v2 === '6' && !edit.save && /cancel/i.test(edit.later), edit);
  await f.click('#tp-estimateLaterBtn');
  // Letters in a number box (badInput) are rejected.
  await f.click('#tp-editEstimateBtn');
  await f.fill('#tp-estDist', '');
  await f.locator('#tp-estDist').pressSequentially('abc');
  const vAbc = await f.evaluate(() => ({ save: document.getElementById('tp-saveEstimateBtn').disabled, val: document.getElementById('tp-estDist').value }));
  R('m2 validation: letters typed in a number box leave Save off', vAbc.save, vAbc);
  await f.click('#tp-estimateLaterBtn');
  // Leave practice: nudge → required cards for the other 8 clubs (first one checked) → chooser.
  await f.click('#tp-endPracticeBtn');
  if (await f.isVisible('#tp-nudgeOverlay')) await f.click('#tp-chooseAnywayBtn');
  await H.waitPhase(f, ['estimate']);
  const fin = await f.evaluate(() => ({ step: document.getElementById('tp-estimateStep').innerText, title: document.getElementById('tp-estimateTitle').innerText,
    v1: document.getElementById('tp-estDist').value, v2: document.getElementById('tp-estHits').value, save: document.getElementById('tp-saveEstimateBtn').disabled }));
  R('m2 required cards before choosing: 8 clubs without answers, boxes empty, Save off', /CLUB 1 OF 8/.test(fin.step) && fin.v1 === '' && fin.v2 === '' && fin.save, fin);
  await shotEl(f, 'm2-estimate-card-required');
  const answers = {};
  for (let i = 0; i < 12 && await f.isVisible('#tp-estimateOverlay'); i++) {
    const idx = await H.estimateClubIdx(f);
    answers[idx] = [H.scriptEstimate(idx), H.scriptHits(idx)];
    await H.answerEstimate(f, ...answers[idx]);
  }
  answers[0] = [212, 6];
  await f.waitForSelector('#tp-bagOverlay:not([hidden])');
  const cards = await f.evaluate(() => [...document.querySelectorAll('#tp-bagSections .bag-card')].map((b) => ({ label: b.dataset.label, text: b.innerText.replace(/\s+/g, ' ').trim() })));
  const clubs = await f.evaluate(() => TargetPractice.state.practiceClubs.map((c) => ({ label: c.label, type: c.type.key, variety: c.variety.key, letter: c.letter, max: c.stats.maxDistance })));
  const qOf = (type) => results.truth.find((r) => r.type === type);
  const cardBad = clubs.filter((c, i) => {
    const t = cards.find((x) => x.label === c.label).text, q = qOf(c.type);
    return !(t.includes(`${answers[i][0]} yd`) && t.includes(`${answers[i][1]} of 10`) && t.includes(`within ${q.radius_yd} yd`) && /average at 100%/.test(t));
  });
  const heads = await f.evaluate(() => [...document.querySelectorAll('#tp-bagSections h3')].map((h) => h.innerText.replace(/\s+/g, ' ').trim()));
  R('m2 "Choose your clubs": every card shows both of the player\'s answers; each type names the two questions once',
    cards.length === 9 && cardBad.length === 0 && heads.length === 3 && heads.every((h, i) => { const q = qOf(['driver', 'hybrid', 'wedge'][i]); return h.includes(`balls of 10 within ${q.radius_yd} yd of a target ${q.target_yd} yd away`) && h.includes('average distance at 100% power'); }),
    cardBad.length ? cardBad : { heads, cards: cards.slice(0, 3).map((c) => c.text) });
  const fits = await f.evaluate(() => { const m = document.querySelector('#tp-bagOverlay .modal'); const r = m.getBoundingClientRect(); return { scroll: m.scrollHeight > m.clientHeight + 1, inView: r.top >= 0 && r.bottom <= innerHeight + 0.5, h: Math.round(r.height), vh: innerHeight }; });
  R('m2 "Choose your clubs" still fits the 1280×720 iframe without scrolling', !fits.scroll && fits.inView, fits);
  await shotEl(f, 'm2-choose-clubs');
  const pick = [clubs.find((c) => c.type === 'driver' && c.letter === 'B'), clubs.find((c) => c.type === 'hybrid' && c.letter === 'C'), clubs.find((c) => c.type === 'wedge' && c.letter === 'A')];
  for (const c of pick) await f.click(`#tp-bagSections .bag-card[data-label="${c.label}"]`);
  await f.click('#tp-confirmBagBtn');
  await f.waitForSelector('#tp-chosenOverlay:not([hidden])');
  const chosenText = await f.evaluate(() => document.getElementById('tp-chosenList').innerText.replace(/\s+/g, ' '));
  R('m2 "Clubs chosen" card shows both answers for each club', pick.every((c) => { const i = clubs.indexOf(c), q = qOf(c.type); return chosenText.includes(`${answers[i][0]} yd at 100% · ${answers[i][1]} of 10 within ${q.radius_yd} yd at ${q.target_yd} yd`); }), chosenText);
  await shotEl(f, 'm2-clubs-chosen');
  const log1 = await f.evaluate(() => JSON.parse(JSON.stringify(NF_LOG)));
  await f.click('#tp-chosenContinueBtn');
  await H.waitMockLog(page, /Would click Next/, 30000);
  const mock1 = await H.mockState(page);
  const done1 = (mock1.received || []).map((m) => m.data).filter((d) => d && d.type === 'nf-done').pop();
  const ests = log1.filter((r) => r.record_type === 'estimate');
  const truthOf = (c) => results.truth.find((r) => r.type === c.type && r.variety === c.variety);
  const byCard = {}; ests.forEach((e) => { (byCard[e.card_no] = byCard[e.card_no] || []).push(e); });
  const cardsOk = Object.values(byCard).every((pair) => pair.length === 2 && pair[0].question === 'distance_100' && pair[1].question === 'hits_of_10' && pair[0].club === pair[1].club
    && pair[0].action === pair[1].action && pair[0].response_ms === pair[1].response_ms);
  R('m2 estimate records: two per card (distance_100, hits_of_10), same card_no, club, action and response_ms', ests.length === 2 * Object.keys(byCard).length && cardsOk,
    Object.values(byCard).map((p) => p.map((e) => `${e.card_no}:${e.question}:${e.action}:${e.answer}`).join(' | ')).slice(0, 4));
  const truthBad = ests.filter((e) => { const c = clubs.find((x) => x.label === e.club), t = truthOf(c);
    return e.question === 'distance_100' ? !(e.truth === c.max && e.target_yd === null && e.radius_yd === null && e.truth_power === 100 && e.question_text === `At 100% power, how far does ${c.label} go on average? (yards)`)
      : !(e.truth === t.truth_hits && e.target_yd === t.target_yd && e.radius_yd === t.radius_yd && e.truth_power === t.power && e.question_text === `You aim at a target ${t.target_yd} yd away with ${c.label}, using the power that sends the ball ${t.target_yd} yd on average. Out of 10 balls, how many land within ${t.radius_yd} yd of its centre?`); });
  R('m2 estimate records: truth = max distance / simulated hits, question_text, target_yd, radius_yd, truth_power', truthBad.length === 0, truthBad.slice(0, 3));
  const first = byCard[1] || [];
  R('m2 first card (auto, saved): answers 212 and 6, start_value null, previous null; then a cancel (answer null, previous 212 / 6)',
    first.length === 2 && first[0].answer === 212 && first[1].answer === 6 && first[0].start_value === null && first[0].previous === null && first[0].when === 'auto' && first[0].action === 'save'
      && byCard[2] && byCard[2][0].action === 'cancel' && byCard[2][0].answer === null && byCard[2][0].start_value === 212 && byCard[2][1].start_value === 6 && byCard[2][0].previous === 212 && byCard[2][1].previous === 6,
    { first, second: byCard[2] });
  const cs = log1.filter((r) => r.record_type === 'club_summary');
  const csBad = cs.filter((r) => { const i = clubs.findIndex((c) => c.label === r.club), c = clubs[i], t = truthOf(c);
    return !(r.final_est_distance === answers[i][0] && r.final_est_hits === answers[i][1] && r.truth_distance === c.max && r.truth_hits === t.truth_hits && r.first_est_distance === answers[i][0] && r.first_est_hits === answers[i][1]); });
  R('m2 club_summary ×9: final_est_distance / _hits, truth_distance / _hits, first_est_*', cs.length === 9 && csBad.length === 0, csBad.slice(0, 2));
  const bc = log1.find((r) => r.record_type === 'bag_choice') || {};
  const bcOk = pick.every((c) => { const i = clubs.indexOf(c), t = truthOf(c); return bc[c.type + '_est_distance'] === answers[i][0] && bc[c.type + '_est_hits'] === answers[i][1] && bc[c.type + '_truth_distance'] === c.max && bc[c.type + '_truth_hits'] === t.truth_hits; })
    && clubs.every((c, i) => bc[`est_distance_${c.type}_${c.letter.toLowerCase()}`] === answers[i][0] && bc[`est_hits_${c.type}_${c.letter.toLowerCase()}`] === answers[i][1]);
  R('m2 bag_choice: both answers and truths for the chosen clubs, both answers for every card', bcOk, Object.fromEntries(Object.entries(bc).filter(([k]) => /est|truth/.test(k))));
  R('m2 nf-done (tp-practice): tp_est_d / _h / _w = the distance answers; exactly the 6 field-reference keys',
    done1 && Object.keys(done1.summary).sort().join() === 'tp_bag,tp_est_d,tp_est_h,tp_est_w,tp_letters,tp_practice_shots'
      && done1.summary.tp_est_d === answers[clubs.indexOf(pick[0])][0] && done1.summary.tp_est_h === answers[clubs.indexOf(pick[1])][0] && done1.summary.tp_est_w === answers[clubs.indexOf(pick[2])][0],
    done1 && done1.summary);
  R('m2 tp-practice records: cond fb-hidden on every record; segment record feedback "hidden"',
    log1.every((r) => r.cond === 'fb-hidden' && r.game_version === VERSION) && log1.filter((r) => r.record_type === 'segment').every((r) => r.feedback === 'hidden'));
  results.examples[engine] = { estimate_distance: first[0], estimate_hits: first[1], club_summary: cs.find((r) => r.chosen), bag_choice: bc };
  const ed = mock1.embedded || mock1.ed || {};
  const bag = ed.tp_bag, letters = ed.tp_letters;
  await context.close();

  // ================= m3 / m4. tp-rounds in both conditions =================
  const runs = {};
  for (const cond of ['fb-visible', 'fb-hidden']) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await routes(ctx);
    const posts2 = [];
    await ctx.route(/\/__save$/, async (route) => {
      let body = null; try { body = JSON.parse(route.request().postData()); } catch (e) { body = {}; }
      posts2.push(body);
      await route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'Access-Control-Allow-Origin': '*' }, body: 'ok' });
    });
    await ctx.addInitScript((ep) => { window.NF_BRIDGE_CONFIG = { DATA_ENDPOINT: ep }; }, ENDPOINT);
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => errors.push(String(e && e.stack || e)));
    pg.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    const pid = cond === 'fb-visible' ? 'R_measV' : 'R_measH';
    await pg.goto(MOCK + '?' + new URLSearchParams({ pid, rng: String(RNG), cond }).toString());
    const g = await H.openMockTarget(pg, MOCK, { pid, rng: RNG, seg: 'tp-rounds', bag, letters, cond, fresh: false });
    const tag = cond === 'fb-visible' ? 'visible' : 'hidden';
    const run = { checkpoints: [], cards: [], preds: [], scan: [] };
    runs[cond] = run;
    await g.click('#tp-startPracticeBtn');
    for (let r = 0; r < 5; r++) {
      // ---- prediction card ----
      await H.waitPhase(g, ['predict']);
      const pc = await g.evaluate(() => {
        const s = TargetPractice.state;
        const cv = document.getElementById('tp-birdCanvas'), g2 = cv.getContext('2d');
        const px = g2.getImageData(0, 0, cv.width, cv.height).data; let lit = 0; for (let i = 0; i < px.length; i += 16) if (px[i] + px[i + 1] + px[i + 2] > 120) lit++;
        return { phase: s.phase, course: s.layout.key, shotsTaken: s.shotsTaken, takeDisabled: document.getElementById('tp-takeShotBtn').disabled, lit,
          tvRows: document.querySelectorAll('#tp-targetCards .tv-row').length, tvTitle: document.getElementById('tp-targetsTitle').innerText,
          q1: document.querySelector('label[for="tp-predPoints"]').innerText.trim(), q2: document.querySelector('.pred-range').innerText.replace(/\s+/g, ' ').trim(),
          vals: ['tp-predPoints', 'tp-predLow', 'tp-predHigh'].map((id) => document.getElementById(id).value), btn: document.getElementById('tp-predictBtn').disabled,
          lead: document.getElementById('tp-predictLead').innerText, maxAttr: document.getElementById('tp-predPoints').max,
          maxWant: 12 * Math.max(...s.layout.targets.map((t) => t.points[0])), bgAlpha: getComputedStyle(document.getElementById('tp-predictOverlay')).backgroundColor,
          sprayShown: (() => { const l = document.getElementById('tp-sprayLabel'); return !!(l && !l.hidden && l.offsetParent !== null); })() };
      });
      // Space must not shoot while the card is open.
      await pg.keyboard.press('Space');
      const still = await g.evaluate(() => TargetPractice.state.shotsTaken === 0 && TargetPractice.state.phase === 'predict');
      run.preds.push({ ...pc, still });
      if (r === 0 || r === 3) await shotEl(g, `m3-prediction-r${r + 1}-${tag}`);
      // validation (round 1)
      if (r === 0) {
        const tryP = async (a, b, c) => { await g.fill('#tp-predPoints', a); await g.fill('#tp-predLow', b); await g.fill('#tp-predHigh', c);
          return g.evaluate(() => ({ btn: document.getElementById('tp-predictBtn').disabled, msg: document.getElementById('tp-predictMsg').innerText,
            bad: ['tp-predPoints', 'tp-predLow', 'tp-predHigh'].filter((id) => document.getElementById(id).classList.contains('bad')) })); };
        const pLow = await tryP('300', '400', '500');
        await shotEl(g, `m3-prediction-error-${tag}`);
        const pHigh = await tryP('300', '100', '250');
        const pMax = await tryP('300', '100', String(pc.maxWant + 1));
        const pDec = await tryP('300.5', '100', '400');
        const pPart = await tryP('300', '100', '');
        const pEq = await tryP('300', '300', '300');
        run.validation = { pLow, pHigh, pMax, pDec, pPart, pEq };
        await sleep(1600);   // response_ms > 1.6 s; must not count toward ball 1's decision_ms or play_ms
      }
      const want = H.scriptPrediction(r + 1);
      await H.answerPrediction(g, want);
      await H.waitPhase(g, ['shooting']);
      // ---- the round ----
      for (let b = 0; b < 12; b++) {
        const s = H.ROUND_SCRIPT[b];
        await g.click(`#tp-clubButtons button[data-club="${s.club}"]`);
        await H.setPower(g, s.power);
        await H.aimDeg(g, s.aim);
        await g.click('#tp-takeShotBtn');
        await g.waitForFunction(() => TargetPractice.state.phase !== 'animating', null, { timeout: 15000, polling: 25 });
        if (b === 3 || b === 7 || b === 11) {
          const ui = await totalsUi(g), tn = await totalsNow(g), st = await screenText(g);
          const leaked = tn.totals.filter((v) => !tn.legit.includes(v) && st.nums.includes(v));
          const checked = tn.totals.filter((v) => !tn.legit.includes(v));
          run.checkpoints.push({ round: r + 1, ball: b + 1, ui, totals: tn.totals, checked, leaked });
        }
        if (b === 5 && (r === 0 || r === 2)) await shotEl(g, `m4-round${r + 1}-ball6-${tag}`);
        if (b === 8 && r === 0) await shotEl(g, `m4-round1-ball9-${tag}`);   // v41: spray chart after several balls
      }
      const next = await H.waitAfterRound(g);
      await sleep(150);
      const ui = await totalsUi(g), tn = await totalsNow(g), st = await screenText(g);
      const leaked = tn.totals.filter((v) => !tn.legit.includes(v) && st.nums.includes(v));
      run.cards.push({ round: r + 1, card: next, ui, totals: tn.totals, checked: tn.totals.filter((v) => !tn.legit.includes(v)), leaked });
      if (r === 1) await shotEl(g, `m4-round2-complete-${tag}`);
      if (next === 'tp-roundOverlay') await g.click('#tp-nextRoundBtn');
    }
    await g.waitForSelector('#tp-endOverlay:not([hidden])');
    await shotEl(g, `m4-all-rounds-complete-${tag}`);
    run.log = await g.evaluate(() => JSON.parse(JSON.stringify(NF_LOG)));
    run.scores = await g.evaluate(() => TargetPractice.state.rounds.map((x) => x.score));
    run.shots = await g.evaluate(() => TargetPractice.state.rounds.map((x) => x.shots.map((s) => [s.distance, s.lateral, s.points])));
    await g.click('#tp-endContinueBtn');
    await H.waitMockLog(pg, /Would click Next/, 30000);
    const ms = await H.mockState(pg);
    run.done = (ms.received || []).map((m) => m.data).filter((d) => d && d.type === 'nf-done').pop();
    run.saves = posts2.map((b) => (b.file || '').replace(/^R_meas[VH]_tp-rounds_a1_/, '').replace(/\.json$/, ''));
    await ctx.close();
  }

  // ---- m3 checks ----
  for (const cond of ['fb-visible', 'fb-hidden']) {
    const run = runs[cond];
    const p1 = run.preds[0];
    const courses = ['sunset', 'pines', 'comet', 'laser', 'nova'];
    R(`m3 ${cond}: prediction card opens on each round's new course (drawn, Target Values shown) before ball 1; no shot possible, Space does nothing`,
      run.preds.every((p, i) => p.phase === 'predict' && p.course === courses[i] && p.shotsTaken === 0 && p.takeDisabled && p.lit > 200 && p.tvRows === 3 && p.still),
      run.preds.map((p) => ({ course: p.course, lit: p.lit, tv: p.tvRows, still: p.still })));
    R(`m3 ${cond}: the two questions as specified; boxes empty; Start Round off; max = 12 × biggest bullseye`,
      run.preds.every((p) => p.q1 === 'How many points will you score this round?' && /^I'm 90% sure my score will be between and pts\.?$/.test(p.q2)
        && p.vals.every((v) => v === '') && p.btn && Number(p.maxAttr) === p.maxWant && p.lead.includes(String(p.maxWant))),
      { q1: p1.q1, q2: p1.q2, max: run.preds.map((p) => p.maxWant) });
    R(`m3 ${cond}: the course stays visible behind the card (light backdrop)`, /rgba\(3, 1, 15, 0\.45\)/.test(p1.bgAlpha), p1.bgAlpha);
    const v = run.validation;
    R(`m3 ${cond}: rules — low above the prediction, high below it, above the max, a decimal, an empty box: Start off with a message; low = prediction = high is allowed`,
      v.pLow.btn && v.pLow.bad.includes('tp-predLow') && /between your two numbers/.test(v.pLow.msg) && v.pHigh.btn && v.pHigh.bad.includes('tp-predHigh')
        && v.pMax.btn && v.pMax.bad.includes('tp-predHigh') && /0 to \d+/.test(v.pMax.msg) && v.pDec.btn && v.pDec.bad.includes('tp-predPoints') && v.pPart.btn && !v.pEq.btn, v);
    const preds = run.log.filter((r) => r.record_type === 'prediction');
    R(`m3 ${cond}: one prediction record per round: round, course, pred_points, pred_low, pred_high, max_points, response_ms (round 1 ≥ 1.6 s)`,
      preds.length === 5 && preds.every((r, i) => { const w = H.scriptPrediction(i + 1); return r.round === i + 1 && r.course === courses[i] && r.pred_points === w.points && r.pred_low === w.low && r.pred_high === w.high
        && r.max_points === run.preds[i].maxWant && Number.isInteger(r.response_ms) && r.response_ms > 0 && r.response_hidden_ms === 0 && r.record_id.endsWith(`-r${i + 1}-pred`); }) && preds[0].response_ms >= 1600,
      preds.map((r) => [r.round, r.course, r.pred_points, r.pred_low, r.pred_high, r.max_points, r.response_ms]));
    const rounds = run.log.filter((r) => r.record_type === 'round');
    const shots = run.log.filter((r) => r.record_type === 'shot');
    R(`m3 ${cond}: round records carry the prediction; ball 1's decision_ms and play_ms start after the prediction`,
      rounds.length === 5 && rounds.every((r, i) => r.pred_points === preds[i].pred_points && r.pred_low === preds[i].pred_low && r.pred_high === preds[i].pred_high)
        && shots[0].decision_ms < 1600 && rounds[0].play_ms < (Date.parse(rounds[0].client_time) - Date.parse(preds[0].client_time)) + 50
        && Date.parse(preds[0].client_time) <= Date.parse(shots[0].client_time),
      { ball1_decision_ms: shots[0].decision_ms, pred_response_ms: preds[0].response_ms, play_ms: rounds[0].play_ms });
    R(`m3 ${cond}: saves r1-pred, r1, r1-review … r5-pred, r5, final`,
      run.saves.join() === 'r1-pred,r1,r1-review,r2-pred,r2,r2-review,r3-pred,r3,r3-review,r4-pred,r4,r4-review,r5-pred,r5,final', run.saves);
    R(`m3 ${cond}: every record carries cond=${cond} and game_version ${VERSION}; segment record feedback ${cond === 'fb-hidden' ? 'hidden' : 'visible'}, predictions 5`,
      run.log.every((r) => r.cond === cond && r.game_version === VERSION) && run.log.filter((r) => r.record_type === 'segment').slice(-1).every((r) => r.feedback === (cond === 'fb-hidden' ? 'hidden' : 'visible') && r.predictions === 5));
    R(`m3 ${cond}: nf-done carries exactly tp_r1..tp_r5, tp_total, tp_best_aims (scores still sent in fb-hidden)`,
      run.done && Object.keys(run.done.summary).sort().join() === 'tp_best_aims,tp_r1,tp_r2,tp_r3,tp_r4,tp_r5,tp_total' && run.scores.every((s, i) => run.done.summary['tp_r' + (i + 1)] === s),
      run.done && run.done.summary);
  }
  // ---- m4 checks ----
  const V = runs['fb-visible'], Hd = runs['fb-hidden'];
  R('m4 same rng and bag: identical shots and scores in both conditions (the condition changes only the screen)', JSON.stringify(V.shots) === JSON.stringify(Hd.shots), { visible: V.scores, hidden: Hd.scores });
  // fb-visible: totals are on screen (positive control for the scan).
  const vLeaks = V.checkpoints.concat(V.cards).filter((c) => c.leaked.length).length;
  R('m4 fb-visible (control): the totals scan finds running / round totals on screen, and every element still shows them',
    vLeaks >= 10 && V.checkpoints.every((c) => /Round score \d+|complete · \d+ pts|^All 5 rounds complete$/.test(c.ui.progress) && c.ui.tvHits.every((t) => /This round: \d+ hits? · \d+ pts/.test(t)))
      && V.cards.filter((c) => c.card === 'tp-roundOverlay').every((c) => /Round \d Complete · .+ \d+/.test(c.ui.roundCard)) && /\d{2,}/.test(V.cards[4].ui.endCard)
      && V.checkpoints.some((c) => c.ui.logItems > 1),
    { checkpointsWithTotals: vLeaks, sample: V.checkpoints[2].ui.progress });
  // fb-hidden: nothing.
  const hLeaks = Hd.checkpoints.concat(Hd.cards).filter((c) => c.leaked.length);
  const hChecked = Hd.checkpoints.concat(Hd.cards).reduce((a, c) => a + c.checked.length, 0);
  results.leakScan[engine] = { hiddenTotalsChecked: hChecked, hiddenLeaks: hLeaks, visibleCheckpointsWithTotals: vLeaks };
  R(`m4 fb-hidden: no running or round total in the visible text at any of ${Hd.checkpoints.length + Hd.cards.length} checkpoints (${hChecked} totals checked)`,
    hLeaks.length === 0 && hChecked > 20, hLeaks.slice(0, 3));
  const bad = [];
  Hd.checkpoints.forEach((c) => {
    if (/score|pts|\d+ ?points/i.test(c.ui.progress)) bad.push(`r${c.round} b${c.ball} progress: ${c.ui.progress}`);
    if (c.ui.chips.some((x) => /^R\d\s+\d+/.test(x) || /\d+$/.test(x.replace(/^R\d/, '')))) bad.push(`r${c.round} b${c.ball} chips: ${c.ui.chips.join(' | ')}`);
    if (c.ui.tvHits.some((t) => t.replace(/ /g, '').trim() !== '')) bad.push(`r${c.round} b${c.ball} target values: ${c.ui.tvHits.join(' | ')}`);
    if (c.ui.logItems !== 1) bad.push(`r${c.round} b${c.ball} shot log items: ${c.ui.logItems}`);
    if (!c.ui.result || !/yd/.test(c.ui.result)) bad.push(`r${c.round} b${c.ball} result line missing`);
  });
  R('m4 fb-hidden during play: progress bar without "Round score", chips ✓ / ▶ / — only, Target Values without hits or points, shot log = latest shot only, result line kept',
    bad.length === 0, bad.length ? bad.slice(0, 6) : { progress: Hd.checkpoints[1].ui.progress, chips: Hd.checkpoints[5].ui.chips, tv: Hd.checkpoints[1].ui.tvHits, result: Hd.checkpoints[1].ui.result.slice(0, 90) });
  const chipDone = Hd.checkpoints.filter((c) => c.round === 3)[0].ui.chips;
  R('m4 fb-hidden round chips: finished rounds ✓, current ▶, later —', chipDone[0] === 'R1 ✓' && chipDone[1] === 'R2 ✓' && chipDone[2] === 'R3 ▶' && chipDone[3] === 'R4 —', chipDone);
  const rc = Hd.cards.filter((c) => c.card === 'tp-roundOverlay');
  R('m4 fb-hidden round-complete card: only "Round k Complete" (and the Start Round button)',
    rc.length === 4 && rc.every((c) => c.ui.roundCard === `Round ${c.round} Complete Start Round ${c.round + 1} of 5: ${['Pixel Pines', 'Comet Ridge', 'Laser Lane', 'Nova Summit'][c.round - 1]}`),
    rc.map((c) => c.ui.roundCard));
  const endH = Hd.cards[4].ui.endCard || '';
  R('m4 fb-hidden "All rounds complete" card: rounds and courses with ✓, no score or other total (no number except round numbers)',
    Hd.cards[4].card === 'tp-endOverlay' && (endH.match(/\d+/g) || []).every((n) => ['5', '1', '2', '3', '4'].includes(n)) && (endH.match(/✓/g) || []).length === 5, endH);
  // v41: spray chart. fb-hidden scored rounds: switch hidden, only the latest ball on the map, spray_on false.
  const sprayV = V.checkpoints.map((c) => ({ r: c.round, b: c.ball, shown: c.ui.sprayShown, balls: c.ui.balls, applied: c.ui.sprayApplied }));
  const sprayH = Hd.checkpoints.map((c) => ({ r: c.round, b: c.ball, shown: c.ui.sprayShown, balls: c.ui.balls, applied: c.ui.sprayApplied }));
  R('m4 v41 fb-hidden scored rounds: Spray Chart switch hidden and only the latest ball on the map (after balls 4, 8, 12 of every round)',
    sprayH.length === 15 && sprayH.every((c) => !c.shown && c.balls === 1 && c.applied === false) && Hd.preds.every((p) => !p.sprayShown), sprayH.filter((c) => c.shown || c.balls !== 1).slice(0, 5));
  R('m4 v41 fb-hidden: the switch stays hidden on the round-complete and end cards',
    Hd.cards.every((c) => !c.ui.sprayShown), Hd.cards.map((c) => c.ui.sprayShown));
  R('m4 v41 fb-visible (unchanged): Spray Chart switch shown and on, every ball of the round on the map (4, 8, 12)',
    sprayV.length === 15 && sprayV.every((c) => c.shown && c.balls === c.b && c.applied === true), sprayV.filter((c) => !c.shown || c.balls !== c.b).slice(0, 5));
  const sOnV = V.log.filter((r) => r.record_type === 'shot').map((r) => r.spray_on), sOnH = Hd.log.filter((r) => r.record_type === 'shot').map((r) => r.spray_on);
  R('m4 v41 shot records: spray_on = the state applied (fb-visible 60 × true, fb-hidden 60 × false)',
    sOnV.length === 60 && sOnV.every((v) => v === true) && sOnH.length === 60 && sOnH.every((v) => v === false),
    { visible: [...new Set(sOnV)], hidden: [...new Set(sOnH)], n: [sOnV.length, sOnH.length] });
  R('m4 fb-hidden status bar after a round: no points', Hd.cards.every((c) => !/pts|score/i.test(c.ui.progress)), Hd.cards.map((c) => c.ui.progress));

  // ---- unknown cond ----
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await routes(ctx);
    const p = await ctx.newPage();
    const warns = []; p.on('console', (m) => { if (m.type() === 'warning') warns.push(m.text()); });
    await p.goto(base + `/target.html?pid=R_cond&segment=tp-rounds&bag=${bag}&letters=${letters}&rng=${RNG}&cond=fb-hiden`);
    await p.waitForFunction(() => window.TargetPractice && TargetPractice.state);
    const x = await p.evaluate(() => ({ hidden: TargetPractice.feedbackHidden, seg: NFBridge.header('x', 'y').cond }));
    R('m4 unknown cond ("fb-hiden"): treated as fb-visible, console warning, cond logged as given', !x.hidden && x.seg === 'fb-hiden' && warns.some((w) => /unknown cond/.test(w)), { ...x, warns });
    await ctx.close();
  }
  R('m* no page or console errors', errors.length === 0, errors.slice(0, 5));
  results.runs = results.runs || {};
  results.runs[engine] = Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, { scores: v.scores, saves: v.saves, predictions: v.log.filter((r) => r.record_type === 'prediction'),
    round2: v.log.filter((r) => r.record_type === 'round')[1], checkpoints: v.checkpoints.map((c) => ({ round: c.round, ball: c.ball, progress: c.ui.progress, chips: c.ui.chips.join(' '), tv: c.ui.tvHits, log: c.ui.logItems, leaked: c.leaked })),
    cards: v.cards.map((c) => ({ round: c.round, card: c.card, round_card: c.ui.roundCard, end_card: c.ui.endCard, leaked: c.leaked })), done: v.done && v.done.summary }]));
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
