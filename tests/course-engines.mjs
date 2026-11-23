// Neon Fairway: course.html cards, keys and focus in three browser engines (prompt 3 follow-up, V20;
// updated for V21: one save per hole before the final save, and the four new summary fields).
//   node tests/course-engines.mjs [--browser chromium,firefox,webkit] [--out results.json] [--shots folder]
// Needs Playwright and its engines: npm i -D playwright; npx playwright install chromium firefox webkit
//
// For each engine, course-s1 and course-s2 run inside test/mock-qualtrics.html (cross-origin, as on
// the real survey), with a fake data endpoint that answers after 1.5 s:
//   1. The right first card: full "How to play" (clubs named as on the club buttons, six points,
//      keys) on course-s1; the short "Same controls as before" card with the keys on course-s2.
//      The time on it is kept (S.howCardMs).
//   2. Space and arrow keys don't scroll the survey page (on a card and while aiming).
//   3. After focus moves to the survey page, one click on the map gives the game the keyboard:
//      ←/→ aim, ↓/↑ power, 2 club, Space swings.
//   4. The whole section is played by script. On the Section complete card nothing is sent and
//      Qualtrics doesn't move on until CONTINUE is clicked; the button then reads "Saving…" and is
//      disabled until the save answers, then nf-done goes out and the page moves on (saved = 1).
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
const OUT = opt('--out');
const SHOTS = opt('--shots');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const SAVE_DELAY_MS = 1500;
const WAIT_BEFORE_CONTINUE_MS = 2500;

const { server, base } = await serve({ '/': REPO });
const port = new URL(base).port;
const MOCK = `http://127.0.0.1:${port}/test/mock-qualtrics.html`;   // the game loads from localhost: cross-origin
const ENDPOINT = `http://127.0.0.1:${port}/__save`;

const results = { started: new Date().toISOString(), engines: {}, tests: [] };
let failed = 0;
function report(engine, name, ok, detail) {
  results.tests.push({ engine, name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${engine}] ${name}${detail ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
}

async function runSegment(browser, engine, seg) {
  const tag = `${engine}-${seg}`;
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await routes(context);
  // A data endpoint that answers after SAVE_DELAY_MS, so the "Saving…" state can be seen.
  const posts = [];
  await context.route(/\/__save$/, async (route) => {
    posts.push({ at: Date.now(), body: route.request().postData() });
    await sleep(SAVE_DELAY_MS);
    await route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'Access-Control-Allow-Origin': '*' }, body: 'ok' });
  });
  await context.addInitScript((ep) => { window.NF_BRIDGE_CONFIG = { DATA_ENDPOINT: ep }; }, ENDPOINT);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${tag}-${name}.png`) }); };

  const frame = await H.openMockCourse(page, MOCK, { pid: 'R_eng_' + engine + '_' + seg.slice(-2), rng: 31337, seg, bag: 'DCHPWV' });
  await H.waitMockLog(page, /received nf-ready/);
  await sleep(200);

  // ---- 1. First card ----
  const card = await frame.evaluate(() => {
    const vis = [...document.querySelectorAll('.overlay')].filter((o) => !o.hidden).map((o) => o.id);
    const inView = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.top >= 0 && r.bottom <= innerHeight + 0.5; };
    return { vis, title: document.getElementById('howTitle').textContent, list: [...document.querySelectorAll('#howList li')].map((li) => li.textContent),
      listShown: !document.getElementById('howList').hidden, keys: [...document.querySelectorAll('#howKeys dd')].map((d) => d.textContent),
      buttons: [...document.querySelectorAll('#clubs button')].map((b) => b.childNodes[1].textContent + ' (' + b.querySelector('.v').textContent + ')'),
      btnInView: inView(document.getElementById('howBtn')), hole: NeonFairway.S.holeIdx + 1 };
  });
  await shot('1-first-card');
  const full = seg === 'course-s1';
  const keysOk = card.keys.length === 4 && ['club', 'swing', 'power', 'aim'].every((w, i) => card.keys[i].includes(w));
  const clubsOk = card.buttons.length === 3 && card.buttons.every((b) => card.list.length && card.list[0].includes(b));
  const cardOk = card.vis.join() === 'howCard' && card.btnInView && keysOk && (full
    ? card.title === 'HOW TO PLAY' && card.listShown && card.list.length === 6 && clubsOk && !card.list.some((t) => /seed|training/i.test(t))
    : card.title === 'SAME CONTROLS AS BEFORE' && !card.listShown);
  report(engine, `${seg}: first card is the ${full ? 'full How to play card (clubs as on the buttons, 6 points, keys)' : 'short "Same controls as before" card with the keys'}`, cardOk,
    { title: card.title, clubs: card.buttons, points: card.list.length, keys: card.keys.length, hole: card.hole });

  // ---- 2a. Keys on the card don't scroll the survey page ----
  const box = await (await frame.frameElement()).boundingBox();
  await page.evaluate((y) => window.scrollTo(0, Math.max(0, window.scrollY + y)), Math.round(box.y - 4));   // box.y is window-relative (prompt 9: the page may already be scrolled)
  await sleep(150);
  const y0 = await page.evaluate(() => window.scrollY);
  const scrollable = await page.evaluate(() => document.documentElement.scrollHeight > innerHeight + 50);
  const off0 = await H.frameOffset(page, frame);
  // one click on the map area (around the card) puts the keyboard in the game
  await page.mouse.click(off0.x + 30, off0.y + 300);
  for (const k of ['Space', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Space']) { await page.keyboard.press(k); await sleep(40); }
  const yCard = await page.evaluate(() => window.scrollY);
  const stillHow = await frame.evaluate(() => !document.getElementById('howCard').hidden);
  await sleep(400);
  await frame.click('#howBtn');
  const howMs = await frame.evaluate(() => NeonFairway.S.howCardMs);
  const brief = await frame.evaluate(() => ({ vis: [...document.querySelectorAll('.overlay')].filter((o) => !o.hidden).map((o) => o.id), num: document.getElementById('secNum').textContent }));
  report(engine, `${seg}: How to play → section briefing; time on the card kept`, brief.vis.join() === 'sectionCard' && brief.num === `SECTION ${seg.slice(-1)} OF 3` && howMs >= 400,
    { next: brief.vis, briefing: brief.num, howCardMs: howMs });

  // ---- 3. Focus: survey page first, then one click on the map ----
  await frame.click('#secBtn');
  await H.teeOff(frame);   // V22: prediction first
  await H.waitPhase(frame, ['aim']);
  await page.mouse.click(8, Math.max(8, Math.round(off0.y) - 12));          // click the survey page above the game
  await sleep(100);
  const focusOut = await frame.evaluate(() => document.hasFocus());
  const p = await H.planSwing(frame);
  const off = await H.frameOffset(page, frame);
  await page.mouse.click(off.x + p.px, off.y + p.py);                       // the one click on the map
  await sleep(100);
  const before = await frame.evaluate(() => ({ tx: NeonFairway.S.target.x, ty: NeonFairway.S.target.y, power: NeonFairway.S.power, club: NeonFairway.S.club, bag: NeonFairway.S.bag.map((c) => c.id), focus: document.hasFocus() }));
  const keyLog = [];
  const step = async (k, read) => { await page.keyboard.press(k); await sleep(60); keyLog.push([k, await frame.evaluate(read)]); };
  await step('ArrowLeft', () => NeonFairway.S.target.x);
  await step('ArrowRight', () => NeonFairway.S.target.x);
  await step('ArrowRight', () => NeonFairway.S.target.x);
  await step('ArrowDown', () => NeonFairway.S.power);
  await step('ArrowUp', () => NeonFairway.S.power);
  await step('ArrowDown', () => NeonFairway.S.power);
  await step('2', () => NeonFairway.S.club);
  await step('1', () => NeonFairway.S.club);
  const yAim = await page.evaluate(() => window.scrollY);
  await shot('2-aim-after-keys');
  await page.keyboard.press('Space');
  await frame.waitForFunction(() => NeonFairway.S.shots.length === 1 || NeonFairway.S.phase === 'fly', null, { timeout: 5000 });
  await H.waitPhase(frame, ['aim', 'done']);
  const ySwing = await page.evaluate(() => window.scrollY);
  const swung = await frame.evaluate(() => NeonFairway.S.shots.length);
  const kv = Object.fromEntries(keyLog.map(([k, v], i) => [i + ':' + k, v]));
  const keysWork = !focusOut && before.focus &&
    keyLog[0][1] !== before.tx && keyLog[2][1] !== keyLog[0][1] &&
    keyLog[3][1] === before.power - 5 && keyLog[4][1] === before.power && keyLog[5][1] === before.power - 5 &&
    keyLog[6][1] === before.bag[1] && keyLog[7][1] === before.bag[0] && swung === 1;
  report(engine, `${seg}: after one click on the map the keys work (←/→ aim, ↓/↑ power, 1/2 club, Space swings)`, keysWork,
    { focusBeforeClick: focusOut, focusAfterClick: before.focus, keys: kv, swung });
  report(engine, `${seg}: Space and arrow keys never scroll the survey page`, scrollable && yCard === y0 && yAim === y0 && ySwing === y0 && stillHow,
    { scrollable, y0, onCard: yCard, aiming: yAim, afterSwing: ySwing, cardStayed: stillHow });

  // ---- 4. Play to the end; Qualtrics only moves on after CONTINUE ----
  const holes = await H.playSegment(page, frame, { continueAtEnd: false });
  const endCard = await frame.evaluate(() => ({ vis: [...document.querySelectorAll('.overlay')].filter((o) => !o.hidden).map((o) => o.id),
    btn: document.getElementById('sdContinue').textContent, disabled: document.getElementById('sdContinue').disabled, meta: document.getElementById('sdMeta').textContent }));
  await shot('3-section-complete');
  await sleep(WAIT_BEFORE_CONTINUE_MS);
  const M0 = await H.mockState(page);
  const sentBefore = await frame.evaluate(() => NFBridge.sent().map((m) => m.msg.type));
  // V21: each hole is saved when it ends (…_h<n>.json); the final save waits for CONTINUE.
  const fileOf = (p) => { try { return JSON.parse(p.body).file; } catch (e) { return '?'; } };
  const waited = { nextClicks: M0.nextClicks, nfDone: M0.received.filter((r) => r.data && r.data.type === 'nf-done').length, posts: posts.map(fileOf), sent: sentBefore };
  const postsBefore = posts.length;
  report(engine, `${seg}: Section complete card waits — no nf-done, no final save, no Next for ${WAIT_BEFORE_CONTINUE_MS / 1000} s (only the ${holes.length} per-hole saves)`,
    endCard.vis.join() === 'sectionDone' && endCard.btn === 'CONTINUE' && !endCard.disabled && waited.nextClicks === 0 && waited.nfDone === 0 &&
    waited.posts.length === holes.length && waited.posts.every((f) => /_h\d\.json$/.test(f)) && !sentBefore.includes('nf-done'),
    { card: endCard, waited });

  const tClick = Date.now();
  await frame.click('#sdContinue');
  const saving = await frame.evaluate(() => ({ text: document.getElementById('sdContinue').textContent, disabled: document.getElementById('sdContinue').disabled }));
  await sleep(300);
  const savingLater = await frame.evaluate(() => ({ text: document.getElementById('sdContinue').textContent, disabled: document.getElementById('sdContinue').disabled }));
  const M1 = await H.mockState(page);
  await shot('4-saving');
  await page.waitForFunction(() => window.MOCKQ.nextClicks > 0, null, { timeout: 20000 });
  const tNext = Date.now();
  const M2 = await H.mockState(page);
  const done = M2.received.filter((r) => r.data && r.data.type === 'nf-done');
  const set = Object.fromEntries(M2.calls.map((c) => [c.key, c.value]));
  const n = seg.slice(-1), want = (n === '1' ? [1, 2, 3] : [4, 5, 6]).map((h) => `crs_s${n}_h${h}`).concat(['total', 'par', 'ob', 'pen', 'shortcut', 'pickups'].map((f) => `crs_s${n}_${f}`));
  const sum = done[0] && done[0].data.summary;
  report(engine, `${seg}: CONTINUE reads "Saving…" and is disabled while saving; Qualtrics moves on only after the save`,
    saving.text === 'Saving…' && saving.disabled && savingLater.text === 'Saving…' && savingLater.disabled && M1.nextClicks === 0 &&
    posts.length === postsBefore + 1 && /_final\.json$/.test(fileOf(posts[posts.length - 1])) && tNext - tClick >= SAVE_DELAY_MS - 100 && done.length === 1 && done[0].data.saved === true,
    { atClick: saving, after300ms: savingLater, nextClicksWhileSaving: M1.nextClicks, posts: posts.map(fileOf), msToNext: tNext - tClick, saved: done[0] && done[0].data.saved });
  report(engine, `${seg}: holes ${holes.map((h) => h.hole_no).join(',')} played; nf-done carries ${want.join(', ')}; Qualtrics saved them (saved 1, attempt 1)`,
    JSON.stringify(holes.map((h) => h.hole_no)) === JSON.stringify(want.slice(0, 3).map((k) => +k.slice(-1))) && !!sum &&
    JSON.stringify(Object.keys(sum).sort()) === JSON.stringify(want.slice().sort()) && want.every((k) => set[k] === String(sum[k])) &&
    set[`crs_s${n}_saved`] === '1' && set[`crs_s${n}_attempt`] === '1' && set[`crs_s${n}_failed`] === '0',
    { summary: sum, saved: set[`crs_s${n}_saved`], attempt: set[`crs_s${n}_attempt`] });
  report(engine, `${seg}: no page errors`, errors.length === 0, errors.slice(0, 4));
  await context.close();
  return { card, howMs, holes: holes.map((h) => ({ hole: h.hole_no, strokes: h.strokes, swings: h.shots.length })), keyLog };
}

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
  results.engines[engine] = { version: browser.version(), runs: {} };
  for (const seg of ['course-s1', 'course-s2']) {
    try { results.engines[engine].runs[seg] = await runSegment(browser, engine, seg); }
    catch (e) { report(engine, `${seg}: run stopped`, false, String(e.message || e).split('\n')[0]); }
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
