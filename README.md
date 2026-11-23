# Neon Fairway

A research golf game in two parts, shown inside Qualtrics (one segment per Qualtrics page):

| File | Game | Version |
|---|---|---|
| `target.html` | Learn & Target Practice | v41 |
| `course.html` | 9-hole course | V23 |
| `index.html` | Test launcher (researchers only) | — |
| `stub.html` | Stub game for testing the Qualtrics pages | stub 1 |
| `test/mock-qualtrics.html` | Imitation Qualtrics page (runs the guide's page script) | mock 2 |
| `js/nf-bridge.js` | Data logging + Qualtrics messages | bridge 3 |

Plain HTML, CSS and JavaScript. No build step, no frameworks.

**Before launch:** work through [`LAUNCH-CHECKLIST.md`](LAUNCH-CHECKLIST.md).

## Layout

```
neon-fairway/
  index.html            test launcher: every segment, with and without a fake pid
  stub.html             stub game: shows the URL settings, sends nf-ready / nf-done / nf-error
  target.html           Learn & Target Practice
  course.html           the 9-hole course
  js/nf-core.js         shared club model and shot math (window.NF)
  js/nf-bridge.js       data logging + Qualtrics messages (course.html from V19, full records from V21; target.html from v38, full records from v39)
  data/course-data.js   hole geometry: window.NF_COURSE_DATA = { holes: [...] }
  vendor/phaser.min.js  Phaser 3.80.1 (used by course.html)
  test/mock-qualtrics.html  imitation Qualtrics game page (for testing the connection)
  tests/                headless tests (Playwright); not needed to run the games
```

Load order in `course.html`: `vendor/phaser.min.js` → `js/nf-core.js` → `data/course-data.js` → `js/nf-bridge.js` → game script.
`target.html` loads `js/nf-core.js` → `js/nf-bridge.js` before its own scripts.

## Run locally

The games load other files, so open them through a web server, not by double-clicking.

```
cd neon-fairway
python3 -m http.server 8000
```

Then open <http://localhost:8000/> (the launcher), or go straight to
<http://localhost:8000/target.html> or <http://localhost:8000/course.html>.

URL settings (read by `js/nf-bridge.js`; `course.html` uses them from V19, `target.html` from v38):

- `pid` — participant id. With a pid it's **study mode**; without one it's **local testing** (debug on, every record marked `test: true`, whole game: segment `tp-all` / `course-all`).
- `segment` — `tp-practice`, `tp-rounds`, `course-s1`, `course-s2`, `course-s3`.
- `bag` — club seed, e.g. `DCHPWV`.
- `letters` — chosen club letters in Driver, Hybrid, Wedge order, e.g. `B,A,C`.
- `cond`, `rng`, `attempt`, `debug=1`.
- `pos` — play position for counterbalancing (logged only).
- `qorigin` — the Qualtrics page's origin. Messages to Qualtrics go there if it is a `https://….qualtrics.com` address, else to `QUALTRICS_ORIGIN` in `js/nf-bridge.js`, else to any parent (`"*"`, with a console warning).

Example: `course.html?pid=R_test1&segment=course-s2&bag=DCHPWV&debug=1`

### target.html (v41)

- v41 (prompt 7/8 review): in `fb-hidden` scored rounds the map shows only the latest ball and the Spray Chart switch is
  hidden (`spray_on` false in those shot records); practice and `fb-visible` unchanged. The out-of-10 question now reads
  "You aim at a target D yd away with [club], using the power that sends the ball D yd on average. Out of 10 balls, how
  many land within R yd of its centre?" Hybrid D is now 116 yd (R 5): true values 7.86 / 4.43 / 3.26.

- v40 (prompt 7): **estimate questions** — the 5-shot / edit / required card asks two questions in number boxes that start
  empty: "At 100% power, how far does [club] go on average? (yards)" (0–300; truth = the club's max distance) and (v41
  wording) "You aim at a target D yd away with [club], using the power that sends the ball D yd on average. Out of 10
  balls, how many land within R yd of its centre?" (0–10). D / R per type: Driver 140 / 8, Hybrid 116 / 5 (v41; was
  110 / 5), Wedge 60 / 2. The truth is 10 × the share of 20,000 simulated shots landing within R (power
  min(100, round(100·D/max)), aimed straight, fixed-seed stream `NF.subSeed(20261120, 'truth', type, variety)`):
  Driver 7.31 / 5.60 / 3.87, Hybrid 7.86 / 4.43 / 3.26, Wedge 7.65 / 4.50 / 2.94 (Control / Power / Vertical).
  `TargetPractice.truthTable()` lists them. Two `estimate` records per card (question, answer, truth); the club cards in
  "Choose your clubs" show both answers. `tp_est_d/_h/_w` are still the distance answers.
- v40: **prediction** before ball 1 of each scored round (course drawn behind it): points, and a 90% range; whole numbers,
  low ≤ prediction ≤ high, 0 … 12 × the course's biggest bullseye. A `prediction` record per round (saved as `…_r2-pred.json`).
- v40: **`cond=fb-hidden`** hides every running and round total in the scored rounds (progress bar score, round-chip scores →
  ✓, Target Values hits/points, round card → "Round k Complete" only, end-card scores, shot log → latest shot only).
  `fb-visible` or no `cond` = as before. Practice is never affected. Records carry `cond`; the segment record `feedback`.

- `segment=tp-practice`: intro → practice (all 9 clubs) → distance estimates → choose clubs → "Clubs chosen" card.
  CONTINUE sends `nf-done` with `tp_bag`, `tp_letters` (letters of the chosen Driver, Hybrid, Wedge, e.g. `B,A,C`),
  `tp_practice_shots` (single and instant-batch shots) and `tp_est_d` / `tp_est_h` / `tp_est_w` (the player's estimate for
  each chosen club). The button reads "Saving…" until the save answers.
- `segment=tp-rounds`: the bag comes from `bag` and the labels from `letters` ("Driver B", as in practice). A short
  "Scored rounds" card, the 5 rounds, then "All rounds complete"; CONTINUE sends `tp_r1`…`tp_r5`, `tp_total` and
  `tp_best_aims` (balls, of 60, meant for each course's best target). A missing or invalid `bag` shows an error card and
  sends `nf-error` `BAG` (also without a pid). Missing or malformed `letters` only drops the letter from the labels
  (console warning).
- `tp-all` (the default with no pid): the whole game without stopping. Local testing keeps the round pick, reflection,
  bag reveal and Play Again and sends one `nf-done` with all 13 fields at the end. With a pid (`segment=tp-all` given
  explicitly) those are gone and the game ends on "All rounds complete" + CONTINUE. A pid with no segment, or an unknown
  segment, is an error (`SEGMENT`).
- Luck is seeded, one stream per job: club letters `NF.rng(NF.subSeed(rng, 'letters'))`, practice shots and instant
  batches `NF.rng(NF.subSeed(rng, 'practice'))`, round k `NF.rng(NF.subSeed(rng, 'round', k))`. Practice can't change round
  luck, and the same `rng` gives the same letters, so `tp-rounds` can check the handed-on letters
  (`TargetPractice.lettersMatch()`). Each shot keeps its two random draws as `zLat` / `zDist`.
- Study mode (pid): tester switch (tp-all only), researcher time-tracking panel and its openers only with `debug=1`.
  Without debug nothing is written to `localStorage` by the game (the bridge's own backup still is).
- Short windows (≤ 820 px tall, ≥ 900 px wide, as in the Qualtrics iframe) use a compact layout: map and target values
  on the left, controls, result and shot log on the right, so nothing scrolls inside the iframe.
- Data logging (v39, `claude/tp-data-logging-spec.md`): `shot` (every practice, batch and round shot), `estimate` (every
  estimate card closed, answered or put off), `club_summary` (9, at bag confirm), `bag_choice`, `round` and `segment`
  records, all through `js/nf-bridge.js`. tp-practice saves every 20 practice shots (`…_p20.json`), after each estimate
  (`…_e3.json`) and at bag confirm (`…_bag.json`); tp-rounds after each round (`…_r2.json`) and when its card is left
  (`…_r2-review.json`); then everything at CONTINUE (`…_final.json`; bridge 3 drops this attempt's saves still waiting
  in the queue at that point, since the final save carries all of them). With debug, a **Download data** button (CSV + JSON)
  sits above the game and in the researcher panel. How the less obvious fields are counted:
  - `decision_ms`: time a shot could be taken (controls on, no card open) since the previous shot / batch / round start /
    practice start, up to TAKE SHOT; `decision_hidden_ms` is the hidden-tab part. Null for instant-batch shots.
  - `aim_changes` (◀ ▶, ←/→, Aim straight, one per map click or drag), `power_changes` (↑/↓, slider keys, one per slider
    drag), `club_changes` (a different club picked). Batch shots: the first shot of the batch carries the counters.
  - Every wall-clock time has a hidden part (bridge 3: `NFBridge.activity().hidden_ms`) and club / round times an idle part.

### course.html (V23)

- V23 (prompt 9): the segment record gets `feedback` (`hidden` / `visible`), the condition the game applied, as in
  Target Practice. Logging only: nothing on screen changes.

- V22 (prompt 8): **hole prediction** on every hole card, before TEE OFF: "How many strokes will you take on this hole?"
  and "I'm 90% sure it will be between __ and __ strokes." Whole numbers 1–12, boxes start empty, low ≤ prediction ≤ high;
  TEE OFF stays disabled until all three are valid (Enter in a box tees off once they are). The hole record gets
  `pred_strokes`, `pred_low`, `pred_high` and `pred_ms` (from the hole card showing to TEE OFF; on a section's first hole
  the clock starts at START SECTION, so the briefing is in `card_ms` but not `pred_ms`). The hole card is now as wide as
  the How to play card (540 px) so the longest one still fits a 620 px iframe.
- V22: **`cond=fb-hidden`** hides completed-hole scores and totals: the header scorecard shows hole numbers only (no
  scores, no TOTAL), the hole-complete card reads "HOLE 4 COMPLETE" only, the Section complete card has no strokes or
  par (CONTINUE stays), the HUD drops its stroke counter once the hole is over, and in local testing the course-all
  round card has no "You" row, totals or summary line. Kept in both conditions: the HUD stroke counter during the hole,
  the per-shot toasts and the shot log. `fb-visible`, no `cond` or an unknown `cond` (console warning) = as before.
- V22: **hidden-tab time**: `hidden_ms` on the hole record (the part of `play_ms` with the tab hidden; active play =
  `play_ms − hidden_ms − idle_ms`) and `decision_hidden_ms` on the shot record (the part of `decision_ms`).
- V22: **replay tries** (debug only): every opening of a hole's card in an attempt is a new try. Hole and shot records
  carry `try`; a replay with the researcher hole buttons gets its own ids (`h4-t2`, `h4-t2-s1`) and save file
  (`…_h4-t2.json`), so no record is overwritten or mixed. Try 1 (all a participant ever plays) keeps `h4`, `h4-s1`,
  `…_h4.json`. The summary uses each hole's latest try.

- `segment=course-s1` / `-s2` / `-s3` plays that section's three holes (numbered 1–3, 4–6, 7–9 as on the
  full course). A "How to play" card comes first (full on `course-s1` / `course-all`, a short "Same controls
  as before" reminder on `course-s2` / `-s3`). After the last hole, "Section complete" waits for CONTINUE, then
  sends `nf-done` with `crs_sN_h#`, `crs_sN_total`, `crs_sN_par` (the button reads "Saving…" until the save answers).
  `course-all` (the default with no pid) plays all 9.
- With a pid the bag must come from `bag`; there is no seed card. A missing or invalid bag, or an unknown
  segment, shows an error card and sends `nf-error` (`BAG` / `SEGMENT`). Without a pid and without a bag
  the seed card still appears.
- Luck is seeded: each hole draws from `NF.rng(NF.subSeed(rng, 'hole', holeNo))`, so the same `rng` and the
  same swings give the same shots.
- Researcher tools only with no pid or with `debug=1`.
- Data logging (V21, `claude/course-data-logging-spec.md`): a `shot` record per swing, a `hole` record per hole and the
  `segment` record, all through `js/nf-bridge.js`. Each hole is saved when it ends (`{pid}_{segment}_a{attempt}_h{n}.json`),
  then everything once more at CONTINUE (`…_final.json`). `nf-done` also carries `crs_sN_ob`, `crs_sN_pen`,
  `crs_sN_shortcut` and `crs_sN_pickups`. With debug, the researcher panel has a **Download data** button (CSV + JSON).
  How the less obvious fields are counted:
  - `decision_ms`: from the start of the aim phase (TEE OFF, or the ball coming to rest) to SWING.
  - `aim_changes`: ◀ / ▶ buttons and ←/→ keys, Aim at pin (if the aim moved), a click on the map, one per drag.
    `club_changes`: a different club picked. `power_changes`: each new value from − / +, ↑/↓, or the slider's keys;
    one per slider drag.
  - `putts`: putts that count toward the score (the 12-stroke cap can cut them). `picked_up`: the cap ended the hole
    before the ball reached the green.
  - `card_ms`: How-to-play card (first hole of the segment only) + section briefing + hole card, up to TEE OFF.
    `play_ms`: TEE OFF to the hole done card. `idle_ms`: idle time inside `play_ms` (no input for 60 s, visible tab).
    V22: `hidden_ms`: hidden-tab time inside `play_ms`; `pred_ms`: hole card shown → TEE OFF (inside `card_ms`);
    `decision_hidden_ms` (shot): hidden-tab time inside `decision_ms`.
  - Yards and degrees are rounded to 0.1; `z_lat` / `z_dist` (standard units) to 0.001.

Fonts (Orbitron, Rajdhani) still come from Google Fonts. Without internet the games fall back to system fonts and still work.

## Deploy to GitHub Pages

1. Create a repository (e.g. `neon-fairway`) and push these files to the `main` branch, with `index.html` at the root.
2. On GitHub: **Settings → Pages**. Under *Build and deployment*, set **Source: Deploy from a branch**, **Branch: `main`**, folder **`/ (root)`**, then **Save**.
3. After a minute the site is at `https://<your-user>.github.io/neon-fairway/`. The games are at `…/target.html` and `…/course.html`.
4. Use those URLs in the Qualtrics iframes (see `claude/qualtrics-setup-guide.md` in the project).

GitHub Pages caches files for about 10 minutes. After pushing a change, wait, or add `&v=2` to the URL while testing.

## Testing the Qualtrics connection

With the local server running, open <http://localhost:8000/test/mock-qualtrics.html>. It imitates a Qualtrics game
page: pick a page (segment), pid and condition and press **Open page**. It runs the page script from
`claude/qualtrics-setup-guide.md` word for word, loads `stub.html` (or the real game) in the iframe, shows the
embedded data Qualtrics would save and logs every message, including ones it ignores. Embedded data carries over
between pages in the same tab, so running the five pages in order passes `tp_bag` and `tp_letters` on.

Automated version (all five segments, wrong-origin and wrong-prefix messages, reloads, `nf-error`, a game that
never loads, real-looking https origins, bridge checks):

```
node tests/qualtrics.mjs --guide /path/to/qualtrics-setup-guide.md [--out results.json] [--shots folder]
```

`--guide` also checks that the mock's copy of the page script still matches the guide.

Mock 2 (guide v4): when the game says it is ready, the page script scrolls the game to the top of the window if it
doesn't fit below the survey header (the arrow keys can't scroll the survey page while the game has the keyboard).

### Whole study path (prompt 9)

All five pages in order through the mock with the real games, one pid and rng, in both conditions, plus a run with the
data endpoint unreachable (about 6 minutes per engine). Checks the bag and club labels across segments, that every
summary field arrives (and nothing else), every record's header, segment, attempt and `load_id`, the segment
record's `feedback` against `cond`, a reload mid-segment in each game, keys after one click with no scrolling of the
survey page, no scrolling inside the iframe at 1100 × 600 (and 1083 × 600, the same window with a Windows scrollbar),
and that the Qualtrics values equal the data store's records. Findings that need a researcher's decision are
reported as DECIDE (exit code 2):

```
node tests/e2e-study.mjs [--browser chromium,firefox,webkit] [--only visible,hidden,down] [--out results.json] [--records folder] [--shots folder]
```

## Tests

Target Practice measurement (v40: true-value table vs a Node run of the same recipe, the estimate card and its rules, the
prediction card and its rules, records, fb-visible vs fb-hidden with a scan for totals on screen; v41: the published
true-value table, the hybrid range, the spray chart and `spray_on` in both conditions; about 2 minutes).
`--shots folder` saves screenshots of each new card and of rounds in both conditions:

```
node tests/target-measure.mjs [--browser chromium,firefox,webkit] [--out results.json] [--shots folder]
```

Target Practice data logging (v39/v40: tp-practice with an instant batch, then tp-rounds, inside the mock page with a data
endpoint the test answers; every spec field on every record, counters predicted shot by shot, hidden and idle time,
saves, both summaries, local testing and lockdown; about 2 minutes). `--records folder` writes every save:

```
node tests/target-logging.mjs [--browser chromium,firefox,webkit] [--out results.json] [--records folder]
```

Course data logging (course-s1, course-s3 and course-s2 by script, every spec field on every record, per-hole saves,
the summary, a reload mid-section; V22: the scripted predictions, `pred_ms`, `try` 1, no hidden time; about 3 minutes). `--records folder` writes every save and the `nf-done` message:

```
node tests/course-logging.mjs [--out results.json] [--records folder] [--shots folder]
```

Course prompt 8 (V22: the prediction card and its rules, `pred_ms`, the tab hidden 3 s mid-hole → `hidden_ms` /
`decision_hidden_ms`, Enter to tee off then arrow keys, fb-visible vs fb-hidden with a scan for scores on screen, the
course-all round card in fb-hidden, replaying a hole in debug keeps every try's records; about 2 minutes per engine).
`--shots folder` saves the hole card with the prediction boxes and the hole-complete / Section complete cards in both
conditions:

```
node tests/course-predict.mjs [--browser chromium,firefox,webkit] [--out results.json] [--shots folder]
```

The course tests' scripted play (`tests/course-helpers.mjs`) fills the prediction before TEE OFF (`H.teeOff(frame)`).

Target Practice study mode (v38: shot math, determinism, 0 vs 40 practice shots, tp-practice → tp-rounds through the
mock page, lockdown, errors, iframe fit at 1100×620 / 1280×720 / 1440×800; about 8 minutes). `--only t1,t5` runs some groups:

```
node tests/target-study.mjs [--browser chromium,firefox,webkit] [--only t1,…,t7] [--out results.json] [--shots folder]
```

Course study mode (segments, bag, errors, lockdown, seeded luck, iframe fit; about 2 minutes):

```
node tests/course-study.mjs [--out results.json] [--shots folder]
```

Course cards, keys and focus in Chromium, Firefox and WebKit (course-s1 and course-s2 in the mock Qualtrics
page; about 1 minute per engine). Install the engines once with `npx playwright install chromium firefox webkit`:

```
node tests/course-engines.mjs [--browser chromium,firefox,webkit] [--out results.json] [--shots folder]
```

An engine that isn't installed is reported as NOT RUN (exit code 2), not as passed.

All tests need Node and Playwright (`npm i -D playwright`, then `npx playwright install chromium`, once).

`tests/archive/run-all.mjs` (the refactor comparison against the original v36 / V17 files) is retired: the games now
behave differently on purpose. It is kept for reference only and is not part of the test runs above.
