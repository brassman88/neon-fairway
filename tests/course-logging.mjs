// Neon Fairway: course.html data logging tests (prompt 4, course V21; prompt 8, course V22: predictions,
// hidden_ms / decision_hidden_ms (0 here: the tab stays visible; tests/course-predict.mjs hides it), try).
//   node tests/course-logging.mjs [--out results.json] [--records folder] [--shots folder]
// Needs Playwright (npm i -D playwright; npx playwright install chromium), or set CHROME_PATH.
//
// Plays course-s1 and course-s3 (and course-s2, for the penalty-drop fields) by script inside
// test/mock-qualtrics.html, with a data endpoint the test answers itself, then checks:
//  1. Every field of claude/course-data-logging-spec.md (sections 3, 3a-3c) is present on every
//     record; lists every field that is null and why.
//  2. Shot records agree with the game's own shot list (distance, landing, random draws, strokes),
//     and the change counters / decision_ms match what the script did.
//  3. Hole records add up (strokes = counted swings + penalties + putts) and match the scores.
//  4. One save per hole (…_a1_h<n>.json with that hole and its shots) plus the final save.
//  5. nf-done carries exactly the spec's summary fields, and they agree with the hole records.
//  6. A reload mid-section gives attempt 2, and attempt 1 is re-sent as a "reloaded" record.
// The script forces a few situations so every branch is logged: a tee shot at the shortcut,
// out-of-bounds swings in each section, and a picked-up hole (hole 9: out of bounds until 12).
// Swings use real UI input: club button, power slider (typed value or a mouse drag), a click or
// mouse drag on the map, arrow keys, SWING.
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
const OUT = opt('--out'), RECORDS = opt('--records'), SHOTS = opt('--shots');
if (RECORDS) fs.mkdirSync(RECORDS, { recursive: true });
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const { server, base } = await serve({ '/': REPO });
const port = new URL(base).port;
const MOCK = `http://127.0.0.1:${port}/test/mock-qualtrics.html`;
const ENDPOINT = `http://127.0.0.1:${port}/__save`;
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

// ---- The spec's fields (claude/course-data-logging-spec.md) ------------------------------
const HEADER = ['record_type', 'record_id', 'pid', 'segment', 'attempt', 'cond', 'bag_seed', 'game_version', 'rng_seed', 'test', 'client_time'];
const SEGMENT = ['started_at', 'finished_at', 'status', 'holes_played', 'total_strokes', 'total_par', 'ob_count', 'penalty_strokes',
  'active_ms', 'idle_ms', 'screen_w', 'screen_h', 'user_agent', 'save_failures', 'feedback'];   // V23: feedback
const HOLE = ['hole_no', 'try', 'hole_id', 'hole_name', 'par', 'yards', 'section', 'ob_rule', 'strokes', 'swings', 'putts', 'penalty_strokes',
  'ob_count', 'ob_no_penalty', 'picked_up', 'route_first_shot', 'shortcut_aims', 'card_ms', 'play_ms', 'idle_ms', 'hidden_ms',
  'pred_strokes', 'pred_low', 'pred_high', 'pred_ms'];
const SHOT = ['hole_no', 'try', 'swing_no', 'stroke_no', 'club', 'club_type', 'variety', 'power', 'from_x', 'from_y', 'from_lie', 'from_to_pin',
  'aim_x', 'aim_y', 'aim_dist', 'aim_deg', 'aim_vs_pin_deg', 'aim_zone', 'aim_zone_dist', 'nominal', 'z_lat', 'z_dist',
  'offset_deg', 'total', 'lateral', 'land_x', 'land_y', 'land_terrain', 'land_to_pin', 'ob', 'penalty_added', 'swing_counted',
  'relief', 'drop_x', 'drop_y', 'drop_yards', 'on_green', 'putts', 'decision_ms', 'decision_hidden_ms', 'aim_changes', 'club_changes', 'power_changes',
  'spread_preview_on'];
const FIELDS = { segment: HEADER.concat(SEGMENT), hole: HEADER.concat(HOLE), shot: HEADER.concat(SHOT) };
// Fields that may legitimately be null, and why.
const NULL_OK = {
  cond: 'no cond in the link (the test gives one, so it should not be null here)',
  finished_at: 'segment not finished yet (per-hole saves); set on the final save',
  drop_x: 'ball not placed on the fairway (only penalty-drop section, out of bounds)',
  drop_y: 'ball not placed on the fairway (only penalty-drop section, out of bounds)',
  drop_yards: 'ball not placed on the fairway (only penalty-drop section, out of bounds)',
  stroke_no: 'swing not counted (free do-over rule; no current section uses it)'
};
const SUMMARY_KEYS = (n) => [1, 2, 3].map((k) => `crs_s${n}_h${(n - 1) * 3 + k}`).concat(['total', 'par', 'ob', 'pen', 'shortcut', 'pickups'].map((f) => `crs_s${n}_${f}`));

// ---- Browser helpers ----------------------------------------------------------------------
async function newContext() {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await routes(context);
  const posts = [];
  await context.route(/\/__save$/, async (route) => {
    let body = null; try { body = JSON.parse(route.request().postData()); } catch (e) { body = { unparsed: route.request().postData() }; }
    posts.push(body);
    await route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'Access-Control-Allow-Origin': '*' }, body: 'ok' });
  });
  await context.addInitScript((ep) => { window.NF_BRIDGE_CONFIG = { DATA_ENDPOINT: ep }; }, ENDPOINT);
  return { context, posts };
}
function watch(page) {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e && e.stack || e)));
  return errors;
}
const pageXY = async (page, frame, p) => { const off = await H.frameOffset(page, frame); return { x: off.x + p.px, y: off.y + p.py }; };

// A plan for one swing, worked out in the page: 'normal' (tests/course-helpers.mjs policy),
// 'shortcut' (longest club, 100%, at the shortcut circle) or 'ob' (shortest club, 100%, at a
// spot where the whole landing area is out of bounds).
async function plan(frame, kind) {
  if (kind === 'normal') return H.planSwing(frame);
  return frame.evaluate((kind) => {
    const { S } = NeonFairway, h = S.hole, b = S.ball;
    const reach = (c) => NF.nominalDistance(NF.getClub(c.id), 100, b.lie, h.lies);
    const clubs = S.bag.slice().sort((a, c) => reach(a) - reach(c));
    let club, aim;
    if (kind === 'shortcut') {
      club = clubs[clubs.length - 1]; const z = h.zones.shortcut[0]; aim = { x: z.x, y: z.y };
    } else {
      club = clubs[0]; const d = reach(club), B = NeonFairway.MX.b;
      let best = null;
      for (let a = 0; a < 360 && !best; a += 5) {
        const r = a * Math.PI / 180, ok = [];
        for (const dd of [-22, -11, 0, 11, 22]) for (const ll of [-14, 0, 14]) {
          const x = b.x + Math.sin(r) * (d + dd) + Math.cos(r) * ll, y = b.y + Math.cos(r) * (d + dd) - Math.sin(r) * ll;
          ok.push(NF.terrainAt(h, x, y) === 'ob');
        }
        const ax = b.x + Math.sin(r) * d, ay = b.y + Math.cos(r) * d;
        if (ok.every(Boolean) && ax > B.minX + 5 && ax < B.maxX - 5 && ay > B.minY + 5 && ay < B.maxY - 5) best = { x: ax, y: ay };
      }
      if (!best) return null;
      aim = best;
    }
    const MX = NeonFairway.MX, dpr = Math.min(2, window.devicePixelRatio || 1), rr = document.getElementById('game').getBoundingClientRect();
    return { club: club.id, power: 100, px: rr.left + (MX.ox + (aim.x - MX.b.minX) * MX.s) / dpr, py: rr.top + (MX.oy + (MX.b.maxY - aim.y) * MX.s) / dpr };
  }, kind);
}

// One swing from the aim phase. Returns what the script did (expected change counts, wait).
//   drag: aim with a mouse drag instead of a click · sliderDrag: drag the power slider first
//   keys: ← then → (aim +2) and Shift+↓ then Shift+↑ (power +2), each pair ending where it started
async function swing(page, frame, kind, { drag = false, sliderDrag = false, keys = true, waitMs = 250 } = {}) {
  let p = await plan(frame, kind);
  if (!p) { kind = 'normal'; p = await plan(frame, 'normal'); }
  const before = await frame.evaluate(() => ({ club: NeonFairway.S.club, power: NeonFairway.S.power }));
  const exp = { kind, aim: 0, club: p.club !== before.club ? 1 : 0, power: 0, waitMs };
  await frame.click(`#clubs button[data-club="${p.club}"]`);            // same club again must not count
  let pw = before.power;
  if (sliderDrag) {
    const box = await (await frame.$('#powerSlider')).boundingBox();   // already in page coordinates
    const x0 = box.x + 8 + (box.width - 16) * (pw - 1) / 99, y0 = box.y + box.height / 2;   // on the thumb
    await page.mouse.move(x0, y0); await page.mouse.down();
    for (let k = 1; k <= 8; k++) await page.mouse.move(x0 - k * box.width * 0.04, y0);
    await page.mouse.up();
    const v = await frame.evaluate(() => NeonFairway.S.power);
    if (v !== pw) exp.power++;
    exp.sliderDrag = { from: pw, to: v }; pw = v;
  }
  if (p.power !== pw) exp.power++;
  await frame.evaluate((v) => { const sl = document.getElementById('powerSlider'); sl.value = v; sl.dispatchEvent(new Event('input', { bubbles: true })); }, p.power);
  const to = await pageXY(page, frame, p);
  if (drag) {
    await page.mouse.move(to.x - 60, to.y + 40); await page.mouse.down();
    for (let k = 1; k <= 10; k++) await page.mouse.move(to.x - 60 + 6 * k, to.y + 40 - 4 * k);
    await page.mouse.up();
  } else {
    await page.mouse.click(to.x, to.y);
  }
  exp.aim++;
  if (keys) {
    await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowRight'); exp.aim += 2;
    if (p.power > 1) { await page.keyboard.press('Shift+ArrowDown'); await page.keyboard.press('Shift+ArrowUp'); }
    else { await page.keyboard.press('Shift+ArrowUp'); await page.keyboard.press('Shift+ArrowDown'); }
    exp.power += 2;
  }
  await sleep(waitMs);
  const st = await frame.evaluate(() => ({ club: NeonFairway.S.club, power: NeonFairway.S.power }));
  exp.club_id = st.club; exp.power_value = st.power;
  await frame.click('#swing');
  await H.waitPhase(frame, ['aim', 'done']);
  return exp;
}

// Play from wherever the game is to the Section complete card. script(holeNo, swingNo) → swing options.
async function playScripted(page, frame, script, { stopAfter } = {}) {
  const expected = [];   // one per swing, in order
  const snaps = [];
  for (;;) {
    const st = await frame.evaluate(() => ({ phase: NeonFairway.S.phase, anim: !!NeonFairway.S.anim, hole: NeonFairway.S.holeIdx + 1,
      swings: NeonFairway.S.shots.length, cards: [...document.querySelectorAll('.overlay')].filter((o) => !o.hidden).map((o) => o.id) }));
    if (st.cards.includes('sectionDone') || st.cards.includes('roundCard')) break;
    if (stopAfter && stopAfter(st)) return { expected, snaps, stopped: true };
    if (st.anim || st.phase === 'fly') { await sleep(50); continue; }
    if (st.cards.includes('howCard')) { await sleep(300); await frame.click('#howBtn'); continue; }
    if (st.cards.includes('sectionCard')) { await sleep(200); await frame.click('#secBtn'); continue; }
    if (st.cards.includes('holeCard')) { await sleep(200); await H.teeOff(frame); await H.waitPhase(frame, ['aim']); continue; }   // V22: prediction first
    if (st.cards.includes('doneCard')) {
      snaps.push(await frame.evaluate(() => ({ hole_no: NeonFairway.S.holeIdx + 1, strokes: NeonFairway.S.scores[NeonFairway.S.holeIdx],
        shots: NeonFairway.S.shots.map((s) => ({ n: s.n, club: s.club, power: s.power, total: s.total, lateral: s.lateral, endX: s.endX, endY: s.endY,
          hazard: s.hazard, dropX: s.dropX == null ? null : s.dropX, zLat: s.zLat, zDist: s.zDist })) })));
      await frame.click('#nextBtn');
      continue;
    }
    if (st.phase === 'aim') {
      if (expected.length > 120) throw new Error('too many swings');
      const o = script(st.hole, st.swings + 1) || {};
      const e = await swing(page, frame, o.kind || 'normal', o);
      e.hole_no = st.hole; e.swing_no = st.swings + 1;
      expected.push(e);
      continue;
    }
    await sleep(50);
  }
  return { expected, snaps, stopped: false };
}

const getLog = (frame) => frame.evaluate(() => JSON.parse(JSON.stringify(window.NF_LOG)));

// ---- Checks ----------------------------------------------------------------------------------
function fieldCheck(label, records) {
  const missing = [], nulls = {};
  for (const r of records) {
    const want = FIELDS[r.record_type]; if (!want) continue;
    for (const f of want) {
      if (!Object.prototype.hasOwnProperty.call(r, f)) missing.push(`${r.record_id}.${f}`);
      else if (r[f] === null) (nulls[`${r.record_type}.${f}`] = nulls[`${r.record_type}.${f}`] || []).push(r.record_id);
    }
  }
  const unexplained = Object.keys(nulls).filter((k) => !NULL_OK[k.split('.')[1]] || k.endsWith('.cond'));
  const types = {}; records.forEach((r) => { types[r.record_type] = (types[r.record_type] || 0) + 1; });
  report(`${label}: every spec field present on every record (${Object.entries(types).map(([t, n]) => `${n} ${t}`).join(', ')})`, missing.length === 0, missing.slice(0, 10).join(', '));
  report(`${label}: no unexplained nulls`, unexplained.length === 0, unexplained.length ? unexplained : Object.fromEntries(Object.entries(nulls).map(([k, v]) => [k, `${v.length}× — ${NULL_OK[k.split('.')[1]]}`])));
  return { missing, nulls: Object.fromEntries(Object.entries(nulls).map(([k, v]) => [k, { count: v.length, why: NULL_OK[k.split('.')[1]] || '?' }])) };
}

function consistency(label, { recs, expected, snaps, seg, n }) {
  const shots = recs.filter((r) => r.record_type === 'shot'), holes = recs.filter((r) => r.record_type === 'hole');
  const r1 = (v) => Math.round(v * 10) / 10, r3 = (v) => Math.round(v * 1000) / 1000;
  const bad = [];
  // Shots vs the game's own list, and vs what the script did.
  report(`${label}: one shot record per swing (${shots.length} records, ${expected.length} swings)`, shots.length === expected.length);
  shots.forEach((s, i) => {
    const e = expected[i], snap = (snaps.find((h) => h.hole_no === s.hole_no) || { shots: [] }).shots[s.swing_no - 1];
    if (!e || !snap) { bad.push(`${s.record_id}: no matching swing`); return; }
    const want = { hole_no: e.hole_no, swing_no: e.swing_no, aim_changes: e.aim, club_changes: e.club, power_changes: e.power, club: e.club_id, power: e.power_value,
      total: r1(snap.total), lateral: r1(snap.lateral), land_x: r1(snap.endX), land_y: r1(snap.endY), z_lat: r3(snap.zLat), z_dist: r3(snap.zDist),
      ob: snap.hazard === 'ob', drop_x: snap.dropX == null ? null : r1(snap.dropX), stroke_no: typeof snap.n === 'number' ? snap.n : null };
    for (const [k, v] of Object.entries(want)) if (s[k] !== v) bad.push(`${s.record_id}.${k}: ${JSON.stringify(s[k])} ≠ ${JSON.stringify(v)}`);
    if (!(Number.isInteger(s.decision_ms) && s.decision_ms >= e.waitMs)) bad.push(`${s.record_id}.decision_ms ${s.decision_ms} < wait ${e.waitMs}`);
    if (s.record_id !== `${s.pid}-${s.segment}-a${s.attempt}-h${s.hole_no}-s${s.swing_no}`) bad.push(`${s.record_id}: id format`);
    if (s.ob && s.relief === 'none') bad.push(`${s.record_id}: out of bounds with relief none`);
    if (!s.ob && (s.relief !== 'none' || s.penalty_added !== 0)) bad.push(`${s.record_id}: not out of bounds but relief/penalty set`);
    if (s.spread_preview_on !== false) bad.push(`${s.record_id}: spread_preview_on`);
    if (s.try !== 1 || s.decision_hidden_ms !== 0) bad.push(`${s.record_id}: try ${s.try} / decision_hidden_ms ${s.decision_hidden_ms}`);   // V22
  });
  report(`${label}: shot records match the game's shots and the scripted input (club, power, change counts, decision_ms, z, landing, OB, drop)`, bad.length === 0, bad.slice(0, 8).join(' | '));
  const sd = expected.find((e) => e.sliderDrag);
  if (sd) report(`${label}: a slider drag (${sd.sliderDrag.from}% → ${sd.sliderDrag.to}%, many input events) counted as one power change`, sd.sliderDrag.to !== sd.sliderDrag.from && sd.sliderDrag.to < 95, sd.sliderDrag);
  // Holes add up.
  const hb = [];
  holes.forEach((h) => {
    const hs = shots.filter((s) => s.hole_no === h.hole_no), snap = snaps.find((x) => x.hole_no === h.hole_no);
    const counted = hs.filter((s) => s.swing_counted).length, pen = hs.reduce((a, s) => a + s.penalty_added, 0), putts = hs.reduce((a, s) => a + s.putts, 0);
    if (h.strokes !== snap.strokes) hb.push(`h${h.hole_no} strokes ${h.strokes} ≠ game ${snap.strokes}`);
    if (h.strokes !== counted + pen + putts) hb.push(`h${h.hole_no} strokes ${h.strokes} ≠ swings ${counted} + pen ${pen} + putts ${putts}`);
    if (h.swings !== hs.length || h.penalty_strokes !== pen || h.putts !== putts) hb.push(`h${h.hole_no} swings/pen/putts`);
    if (h.ob_count !== hs.filter((s) => s.ob).length) hb.push(`h${h.hole_no} ob_count`);
    if (h.route_first_shot !== hs[0].aim_zone) hb.push(`h${h.hole_no} route_first_shot`);
    if (h.shortcut_aims !== hs.filter((s) => s.aim_zone === 'shortcut').length) hb.push(`h${h.hole_no} shortcut_aims`);
    if (h.section !== seg.section || h.ob_rule !== seg.rule) hb.push(`h${h.hole_no} section/rule ${h.section} ${h.ob_rule}`);
    if (!(h.card_ms > 0 && h.play_ms > 0 && h.idle_ms >= 0 && h.idle_ms <= h.play_ms)) hb.push(`h${h.hole_no} timers ${h.card_ms}/${h.play_ms}/${h.idle_ms}`);
    if (h.picked_up !== (h.strokes >= 12 && !hs[hs.length - 1].on_green)) hb.push(`h${h.hole_no} picked_up`);
    // V22: the scripted prediction, its time (inside card_ms), try 1, no hidden time (tab visible).
    const w = H.scriptPrediction(h.hole_no);
    if (h.pred_strokes !== w.strokes || h.pred_low !== w.low || h.pred_high !== w.high) hb.push(`h${h.hole_no} prediction ${h.pred_strokes}/${h.pred_low}/${h.pred_high}`);
    if (!(Number.isInteger(h.pred_ms) && h.pred_ms >= 200 && h.pred_ms <= h.card_ms)) hb.push(`h${h.hole_no} pred_ms ${h.pred_ms} (card_ms ${h.card_ms})`);
    if (h.try !== 1 || h.hidden_ms !== 0 || h.record_id !== `${h.pid}-${h.segment}-a${h.attempt}-h${h.hole_no}`) hb.push(`h${h.hole_no} try/hidden_ms/id`);
  });
  report(`${label}: hole records add up (strokes = counted swings + penalties + putts; counts, route, rule, timers, picked_up; V22: prediction, pred_ms ≤ card_ms, try 1, hidden_ms 0)`, hb.length === 0, hb.join(' | '));
  return { shots, holes };
}

function summaryCheck(label, n, done, holes, ed) {
  const keys = Object.keys(done.summary).sort(), want = SUMMARY_KEYS(n).sort();
  report(`${label}: nf-done summary has exactly the spec's fields`, JSON.stringify(keys) === JSON.stringify(want), keys.join(','));
  const sum = (k) => holes.reduce((a, h) => a + h[k], 0);
  const exp = { [`crs_s${n}_total`]: sum('strokes'), [`crs_s${n}_par`]: sum('par'), [`crs_s${n}_ob`]: sum('ob_count'), [`crs_s${n}_pen`]: sum('penalty_strokes'),
    [`crs_s${n}_shortcut`]: holes.filter((h) => h.route_first_shot === 'shortcut').length, [`crs_s${n}_pickups`]: holes.filter((h) => h.picked_up).length };
  holes.forEach((h) => { exp[`crs_s${n}_h${h.hole_no}`] = h.strokes; });
  const diff = Object.entries(exp).filter(([k, v]) => done.summary[k] !== v).map(([k, v]) => `${k}: ${done.summary[k]} ≠ ${v}`);
  report(`${label}: summary values agree with the hole records`, diff.length === 0, diff.join(', '));
  const savedOk = want.every((k) => ed[k] === String(done.summary[k])) && ed[`crs_s${n}_saved`] === '1' && ed[`crs_s${n}_attempt`] === String(done.attempt);
  report(`${label}: mock Qualtrics saved them (+ _saved 1, _attempt ${done.attempt})`, savedOk, Object.fromEntries(Object.entries(ed).filter(([k]) => k.startsWith(`crs_s${n}_`))));
}

function savesCheck(label, posts, pid, seg, holeNos, attempt = 1) {
  const files = posts.map((b) => b.file);
  const want = holeNos.map((h) => `${pid}_${seg}_a${attempt}_h${h}.json`).concat([`${pid}_${seg}_a${attempt}_final.json`]);
  const missing = want.filter((f) => !files.includes(f));
  const bad = [];
  holeNos.forEach((h) => {
    const b = posts.find((x) => x.file === `${pid}_${seg}_a${attempt}_h${h}.json`); if (!b) return;
    if (!(b.holes.length === 1 && b.holes[0].hole_no === h)) bad.push(`h${h}: holes`);
    if (!(b.shots.length === b.holes[0].swings && b.shots.every((s) => s.hole_no === h))) bad.push(`h${h}: shots`);
    if (!(b.segment_record && b.segment_record.status === 'in_progress' && b.segment_record.attempt === attempt)) bad.push(`h${h}: segment_record`);
  });
  const fin = posts.find((x) => x.file === `${pid}_${seg}_a${attempt}_final.json`);
  if (fin && !(fin.segment_record.status === 'complete' && fin.segment_record.finished_at && fin.holes.length === holeNos.length)) bad.push('final');
  report(`${label}: one save per hole + final (${want.map((f) => f.replace(pid + '_', '')).join(', ')})`, missing.length === 0 && bad.length === 0, missing.concat(bad).join(', '));
  return fin;
}

// =========================================================================================
// Segment runs
// =========================================================================================
const SEGS = {
  'course-s1': { n: 1, section: 1, rule: 'no-penalty-replay', pid: 'R_log_s1', rng: 4242,
    // hole 1: tee shot at the shortcut, aimed by a mouse drag after a slider drag; hole 2: swing 2 out of bounds
    script: (h, s) => (h === 1 && s === 1 ? { kind: 'shortcut', drag: true, sliderDrag: true } : h === 2 && s === 2 ? { kind: 'ob' } : {}) },
  'course-s2': { n: 2, section: 2, rule: 'penalty-drop', pid: 'R_log_s2', rng: 4242,
    script: (h, s) => (h === 4 && s === 1 ? { kind: 'ob' } : h === 5 && s === 1 ? { kind: 'shortcut' } : {}) },
  'course-s3': { n: 3, section: 3, rule: 'stroke-distance', pid: 'R_log_s3', rng: 4242,
    // hole 7: tee shot out of bounds; hole 9: out of bounds every swing until picked up (6 × 2 = 12)
    script: (h, s) => (h === 7 && s === 1 ? { kind: 'ob' } : h === 9 ? { kind: 'ob', keys: s <= 2, waitMs: 120 } : {}) }
};

async function runSegment(seg) {
  const cfg = SEGS[seg];
  const { context, posts } = await newContext();
  const page = await context.newPage();
  const errors = watch(page);
  const frame = await H.openMockCourse(page, MOCK, { pid: cfg.pid, rng: cfg.rng, seg, bag: 'DCHPWV', cond: 'fb-visible' });
  await H.waitMockLog(page, /received nf-ready/);
  const run = await playScripted(page, frame, cfg.script);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${seg}-section-complete.png`) });
  const before = await getLog(frame);
  await frame.click('#sdContinue');
  await H.waitMockLog(page, /received nf-done/);
  const m = await H.mockState(page);
  const doneMsg = m.received.map((x) => x.data || x).find((d) => d && d.type === 'nf-done');
  const fin = savesCheck(seg, posts, cfg.pid, seg, run.snaps.map((s) => s.hole_no));
  const recs = before.filter((r) => r.record_type !== 'segment').concat([fin.segment_record]);
  const fc = fieldCheck(seg, recs);
  const { shots, holes } = consistency(seg, { recs, expected: run.expected, snaps: run.snaps, seg: cfg, n: cfg.n });
  summaryCheck(seg, cfg.n, doneMsg, holes, m.ed);
  const sr = fin.segment_record;
  report(`${seg}: segment record totals (holes ${sr.holes_played}, strokes ${sr.total_strokes}, par ${sr.total_par}, ob ${sr.ob_count}, pen ${sr.penalty_strokes})`,
    sr.holes_played === holes.length && sr.total_strokes === holes.reduce((a, h) => a + h.strokes, 0) && sr.ob_count === holes.reduce((a, h) => a + h.ob_count, 0) &&
    sr.penalty_strokes === holes.reduce((a, h) => a + h.penalty_strokes, 0) && sr.active_ms > 0 && sr.save_failures === 0 && sr.game_version === 'V23' && sr.cond === 'fb-visible' && sr.feedback === 'visible');
  report(`${seg}: no console errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
  const forced = run.expected.filter((e) => e.kind !== 'normal').map((e) => `h${e.hole_no}s${e.swing_no}:${e.kind}`);
  results.runs[seg] = { forced, nullFields: fc.nulls, summary: doneMsg, segment_record: sr, holes, shots, posts: posts.map((b) => b.file) };
  if (RECORDS) fs.writeFileSync(path.join(RECORDS, `${seg}-records.json`), JSON.stringify({ nf_done: doneMsg, saves: posts }, null, 2));
  await context.close();
  return results.runs[seg];
}

// =========================================================================================
// Reload mid-section
// =========================================================================================
async function reloadTest() {
  const { context, posts } = await newContext();
  const page = await context.newPage();
  const errors = watch(page);
  const pid = 'R_log_rl', seg = 'course-s1';
  let frame = await H.openMockCourse(page, MOCK, { pid, rng: 777, seg, bag: 'DCHPWV' });
  await H.waitMockLog(page, /received nf-ready/);
  // Hole 1 in full, then one swing on hole 2, then reload.
  await playScripted(page, frame, () => ({ keys: false, waitMs: 50 }), { stopAfter: (st) => st.hole === 2 && st.swings >= 1 && st.phase === 'aim' });
  const a1 = await frame.evaluate(() => ({ attempt: NFBridge.settings.attempt, log: JSON.parse(JSON.stringify(NF_LOG)) }));
  await page.reload();
  await H.waitMockLog(page, /received nf-ready/);
  frame = null;
  for (let i = 0; i < 400 && !frame; i++) { frame = page.frames().find((f) => f.parentFrame() === page.mainFrame() && /course\.html/.test(f.url())); if (!frame) await sleep(25); }
  await frame.waitForFunction(() => window.NeonFairway && window.NFBridge);
  await frame.waitForFunction(() => NFBridge.queueLength() === 0, null, { timeout: 15000 });
  const s2 = await frame.evaluate(() => NFBridge.publicSettings());
  const rel = posts.find((b) => b.file === `${pid}_${seg}_a1_reloaded.json`);
  report('Reload: before it, attempt 1 had saved hole 1 (…_a1_h1.json)', a1.attempt === 1 && posts.some((b) => b.file === `${pid}_${seg}_a1_h1.json`));
  report(`Reload: the game is now attempt 2 (URL attempt ${s2.attempt_from_url}, game attempt ${s2.attempt})`, s2.attempt === 2);
  report('Reload: attempt 1 re-sent as …_a1_reloaded.json with a "reloaded" segment record for attempt 1',
    !!rel && rel.segment_record.status === 'reloaded' && rel.segment_record.attempt === 1 && rel.segment_record.holes_played === 1,
    rel ? { status: rel.segment_record.status, attempt: rel.segment_record.attempt, holes_played: rel.segment_record.holes_played, total_strokes: rel.segment_record.total_strokes } : 'missing');
  // Finish attempt 2.
  await playScripted(page, frame, () => ({ keys: false, waitMs: 50 }));
  await frame.click('#sdContinue');
  await H.waitMockLog(page, /received nf-done/);
  const m = await H.mockState(page);
  const done = m.received.map((x) => x.data || x).find((d) => d && d.type === 'nf-done');
  const fin = posts.find((b) => b.file === `${pid}_${seg}_a2_final.json`);
  const ids = fin ? fin.holes.concat(fin.shots).map((r) => r.record_id) : [];
  report('Reload: attempt 2 plays the section from hole 1, its records carry -a2- ids, nf-done attempt 2, Qualtrics saved crs_s1_attempt 2',
    !!fin && fin.holes.map((h) => h.hole_no).join() === '1,2,3' && ids.every((id) => id.includes('-a2-')) && done.attempt === 2 && m.ed.crs_s1_attempt === '2',
    { files: posts.map((b) => b.file), nf_done_attempt: done && done.attempt, saved_attempt: m.ed.crs_s1_attempt });
  report('Reload: no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  results.runs.reload = { files: posts.map((b) => b.file), reloaded_record: rel && rel.segment_record };
  await context.close();
}

// =========================================================================================
// Download button (debug only) and change counting on the − / + buttons
// =========================================================================================
async function debugChecks() {
  const { context } = await newContext();
  const page = await context.newPage();
  // Study mode without debug: no panel, so no button.
  await page.goto(`${base}/course.html?pid=R_log_dl&segment=course-s1&bag=DCHPWV&rng=5`);
  await page.waitForFunction(() => window.NeonFairway && NeonFairway.S.phase === 'card');
  const hidden = await page.evaluate(() => document.getElementById('research').hidden && document.getElementById('dlBtn').closest('[hidden]') != null);
  // debug=1: the button downloads CSV + JSON.
  await page.goto(`${base}/course.html?pid=R_log_dl&segment=course-s1&bag=DCHPWV&rng=5&debug=1`);
  await page.waitForFunction(() => window.NeonFairway && NeonFairway.S.phase === 'card');
  await page.click('#howBtn'); await page.click('#secBtn'); await H.teeOff(page);   // V22: prediction first
  await page.click('#pwDown'); await page.click('#pwDown'); await page.click('#pwUp');   // 3 power changes
  await page.click('#rotR'); await page.click('#aimPin');                               // 2 aim changes
  await page.click('#aimPin');                                                           // already at the pin: not a change
  await page.click('#swing');
  await page.waitForFunction(() => NF_LOG.some((r) => r.record_type === 'shot'));
  const shotRec = await page.evaluate(() => NF_LOG.find((r) => r.record_type === 'shot'));
  const downloads = [];
  page.on('download', (d) => downloads.push(d.suggestedFilename()));
  const visible = await page.isVisible('#dlBtn');
  await page.click('#dlBtn');
  await sleep(1500);
  report('Download data: hidden with a pid and no debug; with debug=1 it saves CSV + JSON', hidden && visible && downloads.some((f) => f.endsWith('.csv')) && downloads.some((f) => f.endsWith('.json')), { hidden, visible, downloads });
  report('Buttons: − − + = 3 power changes; ▶ then Aim at pin = 2 aim changes (Aim at pin again, already there = none); no club change',
    shotRec.power_changes === 3 && shotRec.aim_changes === 2 && shotRec.club_changes === 0 && shotRec.power === 99,
    { power_changes: shotRec.power_changes, aim_changes: shotRec.aim_changes, club_changes: shotRec.club_changes, power: shotRec.power });
  await context.close();
}

try {
  for (const seg of ['course-s1', 'course-s3', 'course-s2']) await runSegment(seg);
  await reloadTest();
  await debugChecks();
} catch (e) {
  report('test run finished without an exception', false, String(e && e.stack || e));
}
await browser.close();
server.close();
results.finished = new Date().toISOString();
results.failed = failed;
if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
