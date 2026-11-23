// RETIRED (2026-11-20, target.html v41): the games now differ from the original v36 / V17 files on purpose, so this comparison no longer applies; kept for reference only.
// Neon Fairway refactor tests: original single-file games vs this repo.
//   node tests/archive/run-all.mjs <Learn_and_Practice_v36.html> <Course_Mode_V17.html> [--out results.json]
// Needs Playwright (npm i -D playwright; npx playwright install chromium), or set
// CHROME_PATH to a Chrome/Chromium binary.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO, serve, SEEDED_RANDOM, routes, watchErrors, sleep, waitFor, firstDiff } from '../lib.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = await import('playwright')); }

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = outIdx >= 0 ? args.splice(outIdx, 2)[1] : null;
const [ORIG_TP, ORIG_COURSE] = args;
if (!ORIG_TP || !ORIG_COURSE) { console.error('usage: node tests/archive/run-all.mjs <v36.html> <V17.html> [--out file.json]'); process.exit(2); }

const { server, base } = await serve({ '/': REPO, '/__orig/target.html': path.resolve(ORIG_TP), '/__orig/course.html': path.resolve(ORIG_COURSE) });
const PAGES = {
  old: { target: `${base}/__orig/target.html`, course: `${base}/__orig/course.html` },
  new: { target: `${base}/target.html`, course: `${base}/course.html` }
};
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const results = { started: new Date().toISOString(), tests: [] };
let failed = 0;
function report(name, ok, detail) {
  results.tests.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
}
async function newPage({ seeded = false, stubFonts = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  await routes(context, { stubFonts });
  if (seeded) await context.addInitScript(SEEDED_RANDOM);
  const page = await context.newPage();
  const errors = watchErrors(page);
  return { context, page, errors };
}

// ---------------------------------------------------------------------------
// 1) Club numbers: 9 clubs × powers 1–100, old vs new.
// ---------------------------------------------------------------------------
async function tpClubTable(url) {
  const { context, page } = await newPage();
  await page.goto(url);
  const rows = await page.evaluate(() => {
    const out = [];
    for (const t of CLUB_TYPES) for (const v of SPREAD_VARIETIES) {
      const stats = buildClubStats(t, v);
      for (let p = 1; p <= 100; p++) {
        const sp = getSpread(stats, p);
        out.push({ club: t.key + '-' + v.key, p, maxDistance: stats.maxDistance, latSdDeg: sp.latSdDeg, distSdFrac: sp.distSdFrac,
          mult: getPowerSpreadMult(stats, p), varLat: stats.variety.latMult, varDist: stats.variety.distMult, sweet: stats.sweetSpot,
          seedLetters: t.seed + v.seed });
      }
    }
    return { rows: out, seed: makeClubSeed([{ typeKey: 'wedge', varietyKey: 'vertical' }, { typeKey: 'driver', varietyKey: 'control' }, { typeKey: 'hybrid', varietyKey: 'power' }]) };
  });
  await context.close();
  return rows;
}
async function courseClubTable(url) {
  const { context, page } = await newPage();
  await page.goto(url);
  await waitFor(page, () => window.NF && window.NeonFairway);
  const rows = await page.evaluate(() => {
    const out = [];
    for (const c of NF.ALL_CLUBS) for (let p = 1; p <= 100; p++) {
      const sp = NF.getSpread(c, p);
      out.push({ club: c.id, p, maxDistance: c.maxDistance, latSdDeg: sp.latSdDeg, distSdFrac: sp.distSdFrac, nominal: NF.nominalDistance(c, p, 'fairway') });
    }
    return out;
  });
  await context.close();
  return rows;
}
{
  const a = await tpClubTable(PAGES.old.target), b = await tpClubTable(PAGES.new.target);
  const d = firstDiff(a, b);
  report('Target Practice: 9 clubs × power 1–100 (maxDistance, latSdDeg, distSdFrac, multipliers, club seed) old v36 = new v37',
    !d && a.rows.length === 900, d || `${a.rows.length} rows identical; seed ${b.seed}`);
  const c = await courseClubTable(PAGES.old.course), e = await courseClubTable(PAGES.new.course);
  const d2 = firstDiff(c, e);
  report('Course: 9 clubs × power 1–100 (maxDistance, latSdDeg, distSdFrac, nominal) old V17 = new V18', !d2 && c.length === 900, d2 || `${c.length} rows identical`);
  // Cross-check: Target Practice and the course now share one model; they agreed before too.
  const cross = a.rows.map((r) => ({ club: r.club, p: r.p, maxDistance: r.maxDistance, latSdDeg: r.latSdDeg, distSdFrac: r.distSdFrac }));
  const cross2 = c.map((r) => ({ club: r.club, p: r.p, maxDistance: r.maxDistance, latSdDeg: r.latSdDeg, distSdFrac: r.distSdFrac }));
  const d3 = firstDiff(cross, cross2);
  report('Cross-check: original Target Practice v36 club numbers = original Course V17 club numbers', !d3, d3 || 'identical');
}

// ---------------------------------------------------------------------------
// 1b) Power colours and course wording (the "noticed" fixes).
//   Target Practice colours must be unchanged; the course now uses the same scale.
// ---------------------------------------------------------------------------
{
  const colours = async (url, ready) => {
    const { context, page } = await newPage();
    await page.goto(url);
    await waitFor(page, ready);
    const c = await page.evaluate(() => { const out = []; for (let p = 1; p <= 100; p++) out.push(window.NF && NF.powerColor ? NF.powerColor(p) : null); return out; });
    const local = await page.evaluate(() => {
      // the page's own powerColor: global in target.html; in course.html read it off the slider underline colour
      if (typeof powerColor === 'function') { const out = []; for (let p = 1; p <= 100; p++) out.push(powerColor(p)); return out; }
      return null;
    });
    const text = await page.evaluate(() => ({ title: document.title, header: (document.querySelector('header') || {}).innerText || '',
      start: (document.getElementById('startCard') || {}).innerText || '', grad: (document.getElementById('powerBox') || { style: { getPropertyValue: () => '' } }).style.getPropertyValue('--pgrad') }));
    await context.close();
    return { nf: c, local, text };
  };
  const oldTp = await colours(PAGES.old.target, () => window.TargetPractice);
  const newTp = await colours(PAGES.new.target, () => window.TargetPractice);
  const newCourse = await colours(PAGES.new.course, () => window.NeonFairway);
  const d = firstDiff(oldTp.local, newTp.local);
  report('Power colours: Target Practice powerColor(1–100) old v36 = new v37', !d && oldTp.local.length === 100, d || '100 colours identical');
  const d2 = firstDiff(oldTp.local, newCourse.nf);
  const wantGrad = 'linear-gradient(90deg,#00c8ff 0.0%,#00c8ff 39.4%,#ffd23f 74.7%,#ff8c42 84.8%,#ff2e9a 100.0%)';
  report('Power colours: course uses the same scale (NF.powerColor = Target Practice v36), slider gradient follows',
    !d2 && newCourse.text.grad === wantGrad, d2 || `100 colours identical; course slider ${newCourse.text.grad}`);
  const t = newCourse.text;
  const okText = !/learn mode/i.test(t.start) && /chose in Target Practice/.test(t.start) && !/STEP 2|Clubs & shots/i.test(t.header + t.title) && /The Course/.test(t.header);
  report('Course wording: header/title no longer "STEP 2 · Clubs & shots"; start card says Target Practice, not Learn Mode', okText,
    { title: t.title, header: t.header.split('\n').slice(0, 2).join(' / ') });
}

// ---------------------------------------------------------------------------
// 2a) Golden replay — Target Practice, 60 shots.
//   30 practice shots (20 animated + 2 batches of 3 + 1 sweep of 4) on several
//   courses, then the tester shortcut and 30 scored shots (rounds 1–2, part of 3).
// ---------------------------------------------------------------------------
async function tpReplay(url) {
  const { context, page, errors } = await newPage({ seeded: true });
  await page.goto(url);
  await waitFor(page, () => window.TargetPractice && !document.getElementById('tp-introOverlay').hidden);
  // Record every random shot draw at full precision (wraps the page's own functions).
  await page.evaluate(() => {
    window.__draws = [];
    const od = window.getDistance, ol = window.getLateralOffsetDeg;
    window.getDistance = function (c, p) { const r = od.apply(this, arguments); __draws.push({ f: 'dist', max: c.maxDistance, p, r }); return r; };
    window.getLateralOffsetDeg = function (c, p) { const r = ol.apply(this, arguments); __draws.push({ f: 'lat', max: c.maxDistance, p, r }); return r; };
  });
  const rngAtStart = await page.evaluate(() => window.__rngCalls);
  const click = (sel) => page.click(sel);
  const ready = () => page.evaluate(() => !document.getElementById('tp-takeShotBtn').disabled || !document.getElementById('tp-estimateOverlay').hidden || !document.getElementById('tp-roundOverlay').hidden);
  async function settle() {
    await waitFor(page, () => !document.getElementById('tp-takeShotBtn').disabled || !document.getElementById('tp-estimateOverlay').hidden || !document.getElementById('tp-roundOverlay').hidden || !document.getElementById('tp-finalOverlay').hidden);
    if (await page.evaluate(() => !document.getElementById('tp-estimateOverlay').hidden)) await click('#tp-estimateLaterBtn');
  }
  async function setPower(p) { await page.evaluate((p) => { const s = document.getElementById('tp-powerSlider'); s.value = p; s.dispatchEvent(new Event('input')); }, p); }
  async function aim(steps) {
    await click('#tp-aimStraight');
    for (let k = 0; k < Math.abs(steps); k++) await click(steps < 0 ? '#tp-rotL' : '#tp-rotR');
  }
  const snap = async (tag) => page.evaluate((tag) => ({
    tag,
    result: document.getElementById('tp-resultPanel').innerText,
    progress: document.getElementById('tp-progressBar').innerText,
    status: (({ phase, roundIndex, shotsTaken, practiceShots, club, clubVariety, layout, roundScores, seed }) => ({ phase, roundIndex, shotsTaken, practiceShots, club, clubVariety, layout, roundScores, seed }))(TargetPractice.status())
  }), tag);

  const log = [];
  let shots = 0;
  await click('#tp-startPracticeBtn');
  await ready();
  const POWERS = [100, 73, 45, 88, 20, 61, 95, 52];
  const COURSES = ['sunset', 'pines', 'comet', 'laser', 'nova'];
  for (let i = 0; i < 20; i++) {
    if (i % 4 === 0) await click(`#tp-courseButtons button[data-course="${COURSES[(i / 4) % COURSES.length]}"]`);
    await click(`#tp-clubButtons button[data-club="${(i * 4) % 9}"]`);
    await setPower(POWERS[i % POWERS.length]);
    await aim(((i * 7) % 11) - 5);
    await click('#tp-takeShotBtn');
    await settle();
    shots++; log.push(await snap(`practice ${i + 1}`));
  }
  // Instant batches: 3 at the current power (twice), then a 25–100% sweep of 1 each.
  await page.fill('#tp-batchCount', '3');
  for (const [clubIdx, p] of [[2, 66], [7, 90]]) {
    await click(`#tp-clubButtons button[data-club="${clubIdx}"]`); await setPower(p); await aim(clubIdx - 4);
    await click('#tp-batchCurBtn'); await settle(); shots += 3; log.push(await snap(`batch x3 club ${clubIdx}`));
  }
  await page.fill('#tp-batchCount', '1');
  await click('#tp-clubButtons button[data-club="4"]'); await aim(2);
  await click('#tp-batchAllBtn'); await settle(); shots += 4; log.push(await snap('sweep x4'));

  // Scored rounds with the tester shortcut (three Control clubs).
  await click('#testerSwitchBtn');
  await ready();
  for (let i = 0; i < 30; i++) {
    if (await page.evaluate(() => !document.getElementById('tp-roundOverlay').hidden)) { log.push(await snap('round over')); await click('#tp-nextRoundBtn'); }
    await click(`#tp-clubButtons button[data-club="${i % 3}"]`);
    await setPower([100, 80, 64, 77, 92, 58][i % 6]);
    await aim([0, -10, 25, -25, 6, 0][i % 6]);
    await click('#tp-takeShotBtn');
    await settle();
    shots++; log.push(await snap(`scored ${i + 1}`));
    if (i === 11 || i === 23) await waitFor(page, () => !document.getElementById('tp-roundOverlay').hidden);
  }
  const out = await page.evaluate(() => ({ draws: window.__draws, rngCalls: window.__rngCalls, status: TargetPractice.status() }));
  await context.close();
  return { shots, rngAtStart, log, ...out, errors };
}
{
  const a = await tpReplay(PAGES.old.target), b = await tpReplay(PAGES.new.target);
  const strip = (x) => ({ shots: x.shots, rngAtStart: x.rngAtStart, log: x.log, draws: x.draws, rngCalls: x.rngCalls, roundScores: x.status.roundScores });
  const d = firstDiff(strip(a), strip(b));
  const landed = a.draws.filter((x) => x.f === 'dist').length;
  report('Golden replay — Target Practice, 60 shots (30 practice incl. 2 batches + sweep, 30 scored): every draw, landing text, score',
    !d && a.shots === 60 && landed === 60,
    d || `${a.shots} shots, ${a.draws.length} full-precision draws identical, ${a.rngCalls} Math.random calls each, round scores ${JSON.stringify(a.status.roundScores)} + ${a.status.shotsTaken} balls into round 3 (${a.log[a.log.length - 1].progress})`);
  if (a.errors.length || b.errors.length) report('Target Practice replay pages: no errors', false, { old: a.errors, new: b.errors });
  results.tpSample = { first: a.log[0], last: a.log[a.log.length - 1], firstDraws: a.draws.slice(0, 4) };
}

// ---------------------------------------------------------------------------
// 2b) Golden replay — Course, 3 holes (hole 1 · section 1, hole 4 · section 2,
//   hole 7 · section 3), scripted swings: aim at the pin ± a set angle, the
//   shortest club that reaches, power to match the distance.
// ---------------------------------------------------------------------------
async function courseReplay(url, bagSeed) {
  const { context, page, errors } = await newPage({ seeded: true });
  await page.goto(url);
  await waitFor(page, () => window.NeonFairway && !document.getElementById('startCard').hidden);
  await page.fill('#seedInput', bagSeed);
  await page.click('#startBtn');
  const holes = [];
  for (const idx of [0, 3, 6]) {
    if (idx > 0) await page.click(`#holeJump button:nth-child(${idx + 1 + (await page.evaluate(() => document.querySelectorAll('#holeJump button').length) - 9)})`);
    await waitFor(page, () => !document.getElementById('sectionCard').hidden);
    await page.click('#secBtn');
    await page.click('#teeBtn');
    const swings = [];
    for (let guard = 0; guard < 40; guard++) {
      await waitFor(page, () => ['aim', 'done'].includes(NeonFairway.S.phase), null, 20000);
      if (await page.evaluate(() => NeonFairway.S.phase === 'done')) break;
      const plan = await page.evaluate(() => {
        const S = NeonFairway.S, hole = S.hole, b = S.ball, n = S.shots.length;
        const d = NF.dist(b, hole.pin);
        const clubs = S.bag.slice().sort((x, y) => x.maxDistance - y.maxDistance);
        const club = clubs.find((c) => NF.nominalDistance(c, 100, b.lie, hole.lies) >= d) || clubs[clubs.length - 1];
        const full = NF.nominalDistance(club, 100, b.lie, hole.lies);
        const power = Math.max(1, Math.min(100, Math.round(100 * d / full)));
        const off = [15, -12, 8, -6, 10, 0, -4][n % 7];   // degrees off the pin line (wide, so out of bounds happens in every section)
        const h = (NF.headingTo(b, hole.pin) + off) * Math.PI / 180, reach = Math.min(d, full * power / 100);
        return { club: club.id, power, off, target: { x: b.x + Math.sin(h) * reach, y: b.y + Math.cos(h) * reach } };
      });
      await page.click(`#clubs button[data-club="${plan.club}"]`);
      await page.evaluate((p) => { const s = document.getElementById('powerSlider'); s.value = p; s.dispatchEvent(new Event('input')); }, plan.power);
      await page.evaluate((t) => { NeonFairway.S.target = t; }, plan.target);   // same as clicking that spot on the map
      const before = await page.evaluate(() => window.__rngCalls);
      await page.click('#swing');
      await waitFor(page, () => NeonFairway.S.phase !== 'fly', null, 20000);
      const after = await page.evaluate(() => window.__rngCalls);
      swings.push({ ...plan, rngUsed: after - before });
    }
    const h = await page.evaluate(() => ({ hole: NeonFairway.S.holeIdx + 1, name: NeonFairway.S.hole.name, section: NeonFairway.S.hole.sectionNo,
      strokes: NeonFairway.S.strokes, penalties: NeonFairway.S.penalties, replays: NeonFairway.S.replays,
      score: NeonFairway.S.scores[NeonFairway.S.holeIdx], shots: NeonFairway.S.shots, doneText: document.getElementById('doneMeta').innerText }));
    holes.push({ ...h, swings });
  }
  const out = { holes, rngCalls: await page.evaluate(() => window.__rngCalls), scorecard: await page.evaluate(() => document.getElementById('scorecard').innerText) };
  await context.close();
  return { ...out, errors };
}
{
  const BAG = 'DVHPWC';
  const a = await courseReplay(PAGES.old.course, BAG), b = await courseReplay(PAGES.new.course, BAG);
  const strip = (x) => ({ holes: x.holes, rngCalls: x.rngCalls, scorecard: x.scorecard });
  const d = firstDiff(strip(a), strip(b));
  const nShots = a.holes.reduce((s, h) => s + h.shots.length, 0);
  const obs = a.holes.map((h) => h.shots.filter((s) => s.hazard).length);
  const drops = a.holes.map((h) => h.shots.filter((s) => s.dropX != null).length);
  report(`Golden replay — Course, holes 1 / 4 / 7 (one per section), bag ${BAG}: every landing spot, OB relief, stroke count, score`,
    !d, d || `${nShots} swings identical; ` + a.holes.map((h, i) => `H${h.hole} ${h.name} (S${h.section}): ${h.score} strokes, ${obs[i]} OB (${h.penalties} penalised, ${h.replays} no-penalty replays, ${drops[i]} fairway drops)`).join(' · ') + `; ${a.rngCalls} Math.random calls each`);
  report('Course replay covered every section\'s out-of-bounds rule (S1 replay, S2 drop, S3 stroke-and-distance)',
    obs.every((n) => n > 0) && a.holes[0].replays > 0 && drops[1] > 0 && a.holes[2].penalties > 0, { obs, drops, replaysS1: a.holes[0].replays, penaltiesS3: a.holes[2].penalties });
  if (a.errors.length || b.errors.length) report('Course replay pages: no errors', false, { old: a.errors, new: b.errors });
  results.courseSample = a.holes.map((h) => ({ hole: h.hole, score: h.score, firstShot: h.shots[0], swings: h.swings.length, rngPerSwing: [...new Set(h.swings.map((s) => s.rngUsed))] }));
}

// ---------------------------------------------------------------------------
// 3) Page loads: no console errors (local server, and via index.html links).
// ---------------------------------------------------------------------------
async function loadCheck(url, waitFn) {
  const { context, page, errors } = await newPage();
  const resp = await page.goto(url);
  if (waitFn) await waitFor(page, waitFn);
  await sleep(800);
  const title = await page.title();
  await context.close();
  return { url, status: resp && resp.status(), title, errors };
}
const TP_READY = () => window.TargetPractice && !document.getElementById('tp-introOverlay').hidden;
const COURSE_READY = () => window.NeonFairway && window.NeonFairway.MX && !document.getElementById('startCard').hidden;
{
  const checks = [
    [`${base}/`, null],
    [`${base}/target.html`, TP_READY],
    [`${base}/course.html`, COURSE_READY],
    [`${base}/target.html?pid=R_test1&segment=tp-practice&bag=DCHPWV&debug=1`, TP_READY],
    [`${base}/course.html?pid=R_test1&segment=course-s2&bag=DCHPWV&debug=1`, COURSE_READY]
  ];
  for (const [u, w] of checks) {
    const r = await loadCheck(u, w);
    report(`Loads with no console errors: ${u.replace(base, '')}`, r.status === 200 && !r.errors.length, r.errors.length ? r.errors : `HTTP ${r.status} · "${r.title}"`);
  }
  // Every link on the launcher, clicked from index.html.
  const { context, page, errors } = await newPage();
  await page.goto(`${base}/`);
  const hrefs = await page.$$eval('#rows a', (as) => as.map((a) => a.getAttribute('href')));
  const bad = [];
  for (let i = 0; i < hrefs.length; i++) {
    await page.goto(`${base}/`);
    await Promise.all([page.waitForLoadState('load'), page.click(`#rows a >> nth=${i}`)]);
    await waitFor(page, /course\.html/.test(hrefs[i]) ? COURSE_READY : TP_READY);
    await sleep(300);
    if (errors.length) { bad.push({ href: hrefs[i], errors: errors.splice(0) }); }
  }
  await context.close();
  report(`index.html: all ${hrefs.length} launcher links open a working game with no console errors`, !bad.length && hrefs.length === 12, bad.length ? bad : hrefs.join('  '));
}
// Same pages without the font stub: shows what happens when Google Fonts can't be reached.
{
  const r1 = await (async () => { const { context, page, errors } = await newPage({ stubFonts: false }); await page.goto(`${base}/course.html`); await waitFor(page, COURSE_READY); await sleep(800); await context.close(); return errors; })();
  const r2 = await (async () => { const { context, page, errors } = await newPage({ stubFonts: false }); await page.goto(`${base}/target.html`); await waitFor(page, TP_READY); await sleep(800); await context.close(); return errors; })();
  const all = [...r1, ...r2];
  const nonFont = all.filter((e) => !/fonts\.(googleapis|gstatic)\.com/.test(e.text + e.url));
  report('Without the font stub: the only errors are Google Fonts requests (blocked in this sandbox)', !nonFont.length,
    nonFont.length ? nonFont : `${all.length} font-request errors, nothing else`);
}

await browser.close();
server.close();
results.finished = new Date().toISOString();
results.failed = failed;
if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
