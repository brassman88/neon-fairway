// Shared helpers for the target.html Playwright tests (tests/target-study.mjs).
// Scripted play uses real UI input: card buttons, club buttons, the power slider, the aim
// buttons (Aim straight, ◀ 1°, 1° ▶), TAKE SHOT, the estimate boxes, the prediction boxes and the bag cards.
// v40: estimate cards have two number boxes (distance, hits of 10); each scored round opens with a
// prediction card (points, low, high) before ball 1.
// `f` is a Playwright Frame (page.mainFrame() for a top-level page, or the game's iframe).
import { sleep } from './lib.mjs';

// Start a mock Qualtrics response (pid, rng, cond), optionally put tp_bag / tp_letters in its
// embedded data, then open a Target Practice page with the real game. Returns the game's frame.
export async function openMockTarget(page, mock, { pid, rng, seg, bag, letters, cond = 'fb-visible', fresh = true }) {
  if (fresh) await page.goto(mock + '?' + new URLSearchParams({ pid, rng: String(rng), cond }).toString());
  if (bag !== undefined || letters !== undefined) {
    await page.evaluate(({ bag, letters }) => {
      const ed = JSON.parse(sessionStorage.getItem('mockq:ed') || '{}');
      if (bag !== undefined) { if (bag == null) delete ed.tp_bag; else ed.tp_bag = bag; }
      if (letters !== undefined) { if (letters == null) delete ed.tp_letters; else ed.tp_letters = letters; }
      sessionStorage.setItem('mockq:ed', JSON.stringify(ed));
    }, { bag, letters });
  }
  await page.goto(mock + '?' + new URLSearchParams({ page: seg, file: 'game' }).toString());
  return gameFrame(page);
}
export async function gameFrame(page) {
  await page.waitForFunction(() => window.MOCKQ && window.MOCKQ.iframeSrc, null, { timeout: 15000 });
  let frame = null;
  for (let i = 0; i < 400 && !frame; i++) {
    frame = page.frames().find((f) => f.parentFrame() === page.mainFrame() && /target\.html/.test(f.url()));
    if (!frame) await sleep(25);
  }
  if (!frame) throw new Error('game iframe not found');
  await frame.waitForFunction(() => window.TargetPractice && window.NFBridge, null, { timeout: 30000 });
  return frame;
}
export const mockState = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.MOCKQ)));
export async function waitMockLog(page, re, timeout = 30000) {
  await page.waitForFunction((src) => window.MOCKQ && window.MOCKQ.log.some((l) => new RegExp(src).test(l.text)), re.source, { timeout, polling: 50 });
}
export async function frameOffset(page, frame) {
  if (frame === page.mainFrame()) return { x: 0, y: 0 };
  const box = await (await frame.frameElement()).boundingBox();
  return { x: box.x, y: box.y };
}

export const rawPhase = (f) => f.evaluate(() => TargetPractice.state && TargetPractice.state.phase);
export const visibleOverlays = (f) => f.evaluate(() => [...document.querySelectorAll('.overlay')].filter((o) => !o.hidden).map((o) => o.id));
export async function waitPhase(f, phases, timeout = 30000) {
  await f.waitForFunction((ps) => TargetPractice.state && ps.includes(TargetPractice.state.phase), phases, { timeout, polling: 25 });
}

// The latest shot as plain data (full precision).
export const lastShot = (f) => f.evaluate(() => {
  const h = TargetPractice.state.shotHistory, s = h[h.length - 1];
  return s && shotData(s);
  function shotData(s) {
    return { club: s.clubLabel, variety: s.club.variety.key, course: s.course, power: s.power, aimDeg: s.aimDeg,
      distance: s.distance, angle: s.angle, lateral: s.lateralYards, zLat: s.zLat, zDist: s.zDist,
      batch: !!s.batch, result: s.result ? (s.result.hit ? s.result.target.tier.key + ':' + s.result.ring : (s.result.hazard ? 'water' : 'miss')) : null,
      points: s.result ? s.result.points : null };
  }
});
export const allShots = (f) => f.evaluate(() => TargetPractice.state.shotHistory.map((s) => ({
  club: s.clubLabel, variety: s.club.variety.key, course: s.course, power: s.power, aimDeg: s.aimDeg,
  distance: s.distance, angle: s.angle, lateral: s.lateralYards, zLat: s.zLat, zDist: s.zDist,
  batch: !!s.batch, result: s.result ? (s.result.hit ? s.result.target.tier.key + ':' + s.result.ring : (s.result.hazard ? 'water' : 'miss')) : null,
  points: s.result ? s.result.points : null })));

// Set the power slider as a drag would (input events).
export async function setPower(f, v) {
  await f.evaluate((v) => { const sl = document.getElementById('tp-powerSlider'); sl.value = v; sl.dispatchEvent(new Event('input', { bubbles: true })); }, v);
}
// Aim: "Aim straight", then ◀ / ▶ one degree at a time.
export async function aimDeg(f, deg) {
  await f.click('#tp-aimStraight');
  const id = deg < 0 ? '#tp-rotL' : '#tp-rotR';
  for (let i = 0; i < Math.abs(deg); i++) await f.click(id);
}
// Answer an open estimate card (auto, edit or final): `yd` in the distance box, `hits` in the hits box.
export async function answerEstimate(f, yd, hits = 5) {
  await f.fill('#tp-estDist', String(yd));
  await f.fill('#tp-estHits', String(hits));
  await f.click('#tp-saveEstimateBtn');
}
// The answers a script gives a club: index-dependent but fixed.
export const scriptEstimate = (clubIdx) => 60 + clubIdx * 15;
export const scriptHits = (clubIdx) => (clubIdx * 3) % 11;
// Index (in practiceClubs) of the club the open estimate card asks about.
export const estimateClubIdx = (f) => f.evaluate(() => {
  const label = TargetPractice.status().estimateClub;
  return TargetPractice.state.practiceClubs.findIndex((c) => c.label === label);
});
// v40: the prediction card before each scored round. Fixed script answers per round (1–5).
export const scriptPrediction = (round) => ({ points: 150 + 20 * round, low: 60 + round, high: 420 + round });
export async function answerPrediction(f, p) {
  await f.fill('#tp-predPoints', String(p.points));
  await f.fill('#tp-predLow', String(p.low));
  await f.fill('#tp-predHigh', String(p.high));
  await f.click('#tp-predictBtn');
}
// From a round's start (after Start Round / next round): answer the prediction if it is open,
// then wait until shooting is possible.
export async function startRoundPlay(f) {
  await waitPhase(f, ['predict', 'shooting']);
  if (await rawPhase(f) === 'predict') {
    const k = await f.evaluate(() => TargetPractice.state.roundIndex + 1);
    await answerPrediction(f, scriptPrediction(k));
  }
  await waitPhase(f, ['shooting']);
}

// One shot from the shooting phase: club button, power, aim, TAKE SHOT. Waits for it to land.
// If the 5-shot estimate card opens afterwards, it is answered (scriptEstimate).
export async function shoot(f, { club, power, aim }) {
  await f.click(`#tp-clubButtons button[data-club="${club}"]`);
  await setPower(f, power);
  await aimDeg(f, aim);
  await f.click('#tp-takeShotBtn');
  await f.waitForFunction(() => TargetPractice.state.phase !== 'animating', null, { timeout: 15000, polling: 25 });
  await handleEstimate(f);
  return lastShot(f);
}
export async function handleEstimate(f) {
  if (await rawPhase(f) !== 'estimate') return;
  const idx = await f.evaluate(() => TargetPractice.state.practiceClubs.indexOf(TargetPractice.state.clubs[TargetPractice.state.clubIndex]));
  await answerEstimate(f, scriptEstimate(idx), scriptHits(idx));
}
// Instant batch (practice): `per` shots per power, sweep or current power.
export async function batch(f, { club, power, per, sweep }) {
  await f.click(`#tp-clubButtons button[data-club="${club}"]`);
  await setPower(f, power);
  await f.fill('#tp-batchCount', String(per));
  await f.click(sweep ? '#tp-batchAllBtn' : '#tp-batchCurBtn');
  await handleEstimate(f);
}
// Practice script: `n` single shots spread over the 9 clubs and the 5 courses, then optionally a
// batch. Deterministic: shot i uses club i % 9, a fixed power and aim.
export async function practiceScript(f, { n, batchShots = 0 }) {
  const courses = ['sunset', 'pines', 'comet', 'laser', 'nova'];
  for (let i = 0; i < n; i++) {
    if (i % 8 === 0) await f.click(`#tp-courseButtons button[data-course="${courses[(i / 8) % 5]}"]`);
    await shoot(f, { club: i % 9, power: [100, 80, 60, 45][i % 4], aim: [0, -2, 3, 1][i % 4] });
  }
  if (batchShots) await batch(f, { club: 4, power: 70, per: batchShots / 4, sweep: true });
}
// Leave practice: I'm ready → (nudge: choose anyway) → final estimates → bag chooser → pick labels → confirm.
export async function chooseClubs(f, labels) {
  await f.click('#tp-endPracticeBtn');
  if (await f.isVisible('#tp-nudgeOverlay')) await f.click('#tp-chooseAnywayBtn');
  for (let i = 0; i < 12 && await f.isVisible('#tp-estimateOverlay'); i++) {
    const idx = await estimateClubIdx(f);
    await answerEstimate(f, scriptEstimate(idx), scriptHits(idx));
  }
  await f.waitForSelector('#tp-bagOverlay:not([hidden])');
  for (const l of labels) await f.click(`#tp-bagSections .bag-card[data-label="${l}"]`);
  await f.click('#tp-confirmBagBtn');
}
// A scripted scored round: 12 balls, ball b uses club b % 3, a fixed power and aim.
export const ROUND_SCRIPT = Array.from({ length: 12 }, (_, b) => ({ club: b % 3, power: [100, 85, 70, 55][b % 4], aim: [-3, 0, 2, 5][b % 4] }));
// Plays the current round with ROUND_SCRIPT. Returns the 12 shots (full precision).
export async function playRound(f) {
  await startRoundPlay(f);   // v40: prediction first
  const shots = [];
  for (const s of ROUND_SCRIPT) shots.push(await shoot(f, s));
  return shots;
}
// After a round: wait for the next card. Returns the overlay id that opened.
export async function waitAfterRound(f) {
  await f.waitForFunction(() => ['tp-roundOverlay', 'tp-finalOverlay', 'tp-endOverlay'].some((id) => !document.getElementById(id).hidden), null, { timeout: 15000, polling: 50 });
  return f.evaluate(() => ['tp-roundOverlay', 'tp-finalOverlay', 'tp-endOverlay'].find((id) => !document.getElementById(id).hidden));
}
// Plays `rounds` scored rounds (from the start of round 1). Returns the shots per round.
export async function playRounds(f, rounds = 5) {
  const out = [];
  for (let r = 0; r < rounds; r++) {
    out.push(await playRound(f));
    const next = await waitAfterRound(f);
    if (next === 'tp-roundOverlay' && r < rounds - 1) await f.click('#tp-nextRoundBtn');
  }
  return out;
}
