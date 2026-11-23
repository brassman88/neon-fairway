// Shared helpers for the course.html Playwright tests (course-study.mjs, course-engines.mjs, course-logging.mjs,
// course-predict.mjs). V22: the hole card needs a prediction before TEE OFF (fillPrediction / teeOff).
// Scripted play uses real UI input: card buttons, club button, power slider, a mouse click on
// the map to aim, SWING.
import { sleep } from './lib.mjs';

// Start a mock Qualtrics response with this pid, put tp_bag / tp_letters in its embedded data
// (as if Target Practice had run), then open a course page with the real game in the iframe.
// mock: URL of test/mock-qualtrics.html. Returns the game's frame.
export async function openMockCourse(page, mock, { pid, rng, seg, bag, letters = 'B,A,C', cond = 'fb-visible' }) {
  await page.goto(mock + '?' + new URLSearchParams({ pid, rng: String(rng), cond }).toString());
  await page.evaluate(({ bag, letters }) => {
    const ed = JSON.parse(sessionStorage.getItem('mockq:ed') || '{}');
    if (bag == null) delete ed.tp_bag; else ed.tp_bag = bag;
    ed.tp_letters = letters;
    sessionStorage.setItem('mockq:ed', JSON.stringify(ed));
  }, { bag, letters });
  await page.goto(mock + '?' + new URLSearchParams({ page: seg, file: 'game' }).toString());
  await page.waitForFunction(() => window.MOCKQ && window.MOCKQ.iframeSrc, null, { timeout: 15000 });
  let frame = null;
  for (let i = 0; i < 400 && !frame; i++) {
    frame = page.frames().find((f) => f.parentFrame() === page.mainFrame() && /course\.html/.test(f.url()));
    if (!frame) await sleep(25);
  }
  if (!frame) throw new Error('game iframe not found');
  await frame.waitForFunction(() => window.NeonFairway && window.NFBridge, null, { timeout: 30000 });
  return frame;
}
export const mockState = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.MOCKQ)));
export async function waitMockLog(page, re, timeout = 30000) {
  await page.waitForFunction((src) => window.MOCKQ && window.MOCKQ.log.some((l) => new RegExp(src).test(l.text)), re.source, { timeout, polling: 50 });
}

export const phase = (frame) => frame.evaluate(() => NeonFairway.S.phase);

// V22: the scripted hole prediction for a course-wide hole number (always valid: 1–12, low ≤ p ≤ high).
export function scriptPrediction(holeNo) {
  const n = holeNo;
  return { strokes: 3 + (n % 4), low: 2 + (n % 4) - (n % 2), high: 5 + (n % 4) + (n % 3) };
}
// V22: type the three prediction boxes on the hole card (real input events). pred defaults to
// scriptPrediction(current hole). Returns the values typed.
export async function fillPrediction(frame, pred) {
  const p = pred || scriptPrediction(await frame.evaluate(() => NeonFairway.S.holeIdx + 1));
  await frame.fill('#predStrokes', String(p.strokes));
  await frame.fill('#predLow', String(p.low));
  await frame.fill('#predHigh', String(p.high));
  return p;
}
// V22: fill the prediction, then TEE OFF.
export async function teeOff(frame, pred) {
  const p = await fillPrediction(frame, pred);
  await frame.click('#teeBtn');
  return p;
}
export async function waitPhase(frame, phases, timeout = 30000) {
  await frame.waitForFunction((ps) => ps.includes(NeonFairway.S.phase) && !NeonFairway.S.anim, phases, { timeout, polling: 50 });
}
export const visibleCards = (frame) => frame.evaluate(() => [...document.querySelectorAll('.overlay')].filter((o) => !o.hidden).map((o) => o.id));

// Where the game's iframe sits in the page (0,0 for the top frame).
export async function frameOffset(page, frame) {
  if (frame === page.mainFrame()) return { x: 0, y: 0 };
  const box = await (await frame.frameElement()).boundingBox();
  return { x: box.x, y: box.y };
}

// Scripted policy (no randomness): aim at the furthest drawn safe waypoint (or the pin) that
// the longest club can reach from here, with the shortest club that reaches it, at the power
// that matches the distance. Small fixed aim nudges vary by swing number.
// Returns the club, power and the aim point in the frame's own pixels.
export async function planSwing(frame) {
  return frame.evaluate(() => {
    const { S } = NeonFairway, h = S.hole, b = S.ball;
    const reach = (c) => NF.nominalDistance(NF.getClub(c.id), 100, b.lie, h.lies);
    const pts = h.zones.safe.map((z) => ({ x: z.x, y: z.y })).concat([{ x: h.pin.x, y: h.pin.y }]);
    const dPin = NF.dist(b, h.pin);
    const ahead = pts.filter((p) => NF.dist(p, h.pin) < dPin - 5);
    const maxR = Math.max(...S.bag.map(reach));
    const tgt = ahead.slice().reverse().find((p) => NF.dist(b, p) <= maxR) || ahead[0] || h.pin;
    const d = NF.dist(b, tgt);
    const clubs = S.bag.slice().sort((a, c) => reach(a) - reach(c));
    const club = clubs.find((c) => reach(c) >= d) || clubs[clubs.length - 1];
    const power = Math.max(1, Math.min(100, Math.round(100 * d / reach(club))));
    const nudge = [0, 3, -3, 6, -6][S.shots.length % 5];
    const hd = NF.headingTo(b, tgt) * Math.PI / 180;
    const aim = { x: tgt.x + Math.cos(hd) * nudge, y: tgt.y - Math.sin(hd) * nudge };
    const MX = NeonFairway.MX, dpr = Math.min(2, window.devicePixelRatio || 1), r = document.getElementById('game').getBoundingClientRect();
    const px = r.left + (MX.ox + (aim.x - MX.b.minX) * MX.s) / dpr, py = r.top + (MX.oy + (MX.b.maxY - aim.y) * MX.s) / dpr;
    return { club: club.id, power, px, py };
  });
}
// One scripted swing from the aim phase; waits until the ball has come to rest.
export async function scriptedSwing(page, frame) {
  const p = await planSwing(frame);
  await frame.click(`#clubs button[data-club="${p.club}"]`);
  await frame.evaluate((v) => { const sl = document.getElementById('powerSlider'); sl.value = v; sl.dispatchEvent(new Event('input', { bubbles: true })); }, p.power);
  const off = await frameOffset(page, frame);
  await page.mouse.click(off.x + p.px, off.y + p.py);
  await frame.click('#swing');
  await waitPhase(frame, ['aim', 'done']);
}
const holeSnapshot = (frame) => frame.evaluate(() => ({
  hole_no: NeonFairway.S.holeIdx + 1, hole_id: NeonFairway.S.hole.id, strokes: NeonFairway.S.scores[NeonFairway.S.holeIdx],
  shots: NeonFairway.S.shots.map((s) => ({ n: s.n, club: s.club, power: s.power, fromX: s.fromX, fromY: s.fromY, endX: s.endX, endY: s.endY,
    total: s.total, lateral: s.lateral, hazard: s.hazard, dropX: s.dropX == null ? null : s.dropX, zLat: s.zLat, zDist: s.zDist }))
}));

// Play from wherever the game is (any card or mid-hole) to the Section complete card (or the
// course-all round card). Clicks the cards' buttons in turn. Returns the holes played.
// continueAtEnd: also click CONTINUE on the Section complete card (the mock page then moves on).
// onHoleDone(holes): optional callback after each hole-complete card appears.
export async function playSegment(page, frame, { continueAtEnd = true, maxSwings = 200, onHoleDone } = {}) {
  const holes = [];
  let swings = 0;
  for (;;) {
    const st = await frame.evaluate(() => ({ phase: NeonFairway.S.phase, anim: !!NeonFairway.S.anim,
      cards: [...document.querySelectorAll('.overlay')].filter((o) => !o.hidden).map((o) => o.id) }));
    if (st.cards.includes('sectionDone') || st.cards.includes('roundCard')) break;
    if (st.anim || st.phase === 'fly') { await sleep(50); continue; }
    if (st.cards.includes('howCard')) { await frame.click('#howBtn'); continue; }
    if (st.cards.includes('sectionCard')) { await frame.click('#secBtn'); continue; }
    if (st.cards.includes('holeCard')) { await teeOff(frame); await waitPhase(frame, ['aim']); continue; }   // V22: prediction first
    if (st.cards.includes('doneCard')) {
      holes.push(await holeSnapshot(frame));
      if (onHoleDone) await onHoleDone(holes);
      await frame.click('#nextBtn');
      continue;
    }
    if (st.phase === 'aim') {
      if (++swings > maxSwings) throw new Error('too many swings');
      await scriptedSwing(page, frame);
      continue;
    }
    await sleep(50);
  }
  if (continueAtEnd && await frame.isVisible('#sdContinue')) await frame.click('#sdContinue');
  return holes;
}
