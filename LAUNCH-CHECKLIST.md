# Neon Fairway: launch checklist

Work through this in order before the study opens. Tick each box. Companion docs (in the Claude project):
`claude/qualtrics-setup-guide.md` (v4), `claude/course-data-logging-spec.md` (v3.1), `claude/tp-data-logging-spec.md` (v2.1).

Versions this checklist was written for:

| File | Version | Where to see it |
|---|---|---|
| `target.html` | **v41** | `const GAME_VERSION` near the top of the game script; `game_version` on every Target Practice record |
| `course.html` | **V23** | `const GAME_VERSION`; `game_version` on every course record |
| `js/nf-bridge.js` | **bridge 3** | Changelog at the top of the file |
| `test/mock-qualtrics.html` | **mock 2** | Changelog at the top (runs the guide v4 page script) |

If any file changes after the pilot, bump its version, re-run the tests in step 6, and pilot again.

---

## 1. Decide the open items

- [ ] **Club names in the course.** Target Practice labels clubs "Driver B", "Hybrid A", "Wedge C" and never shows a variety. The course labels the same clubs "Driver (Power)", "Hybrid (Control)", "Wedge (Vertical)", both on its buttons and on its How to play card ("You play with the three clubs you chose in Target Practice: …"), and doesn't use the letters. Either keep this, and make sure the bag reveal page before the course says which letter was which variety, or ask for a course change (e.g. "Driver B · Power"). `tests/e2e-study.mjs` reports this as DECIDE until it is settled.
- [ ] **Shared `tp_` prefix.** Both Target Practice pages accept any `tp_` field, so a bug in `tp-rounds` could overwrite `tp_bag`. The end-to-end run found `tp-rounds` sends only its seven fields. Keep it, or switch to separate prefixes now (this renames fields).
- [ ] **Data endpoint chosen and set up** (Optional prompt A: DataPipe → OSF, Google Apps Script, or a university server), with IRB approval for where the data is stored.

## 2. Set the two constants in `js/nf-bridge.js`

Near the top, under "Set these for the study":

- [ ] `DATA_ENDPOINT = 'https://…'`: the URL the games POST to. It must accept `Content-Type: text/plain` and answer 2xx with `Access-Control-Allow-Origin` for your GitHub Pages origin (`https://<you>.github.io`).
- [ ] `QUALTRICS_ORIGIN = 'https://<yourschool>.qualtrics.com'`: the origin of your survey, without a path or a trailing slash. Find it by opening the anonymous link and copying the address up to the first `/` after the host (e.g. `https://yourschool.az1.qualtrics.com`). The page script also passes this origin to the game (`qorigin`), and the game uses that when it ends in `.qualtrics.com`; the constant is the fallback, and it's required if your survey uses a custom domain that isn't `….qualtrics.com`.
- [ ] Commit, push, wait ~10 minutes for GitHub Pages, then open `https://<you>.github.io/neon-fairway/js/nf-bridge.js` and confirm both values are there.
- [ ] Endpoint test from the browser console on any game page of the live site (e.g. `…/stub.html?pid=R_endpointtest&segment=course-s1`):
  ```js
  NFBridge.save('console-test', { note: [{ record_type: 'note', record_id: 'console-test-1' }] }).then(ok => console.log('saved:', ok))
  ```
  It should print `saved: true`, and `R_endpointtest_course-s1_a1_console-test.json` should appear in the data store. Delete it afterwards.

## 3. Confirm debug is off in study links

The Qualtrics page script never adds `debug=1`, and with a `pid` the games run in study mode with debug off. Check on the live site:

- [ ] `https://<you>.github.io/neon-fairway/target.html?pid=R_check&segment=tp-practice&rng=1&cond=fb-visible`: no tester switch, no researcher panel (Alt+Shift+T and five clicks on the title do nothing), no Download data button.
- [ ] `https://<you>.github.io/neon-fairway/course.html?pid=R_check&segment=course-s1&bag=DCHPWV&letters=A,B,C&rng=1&cond=fb-visible`: no seed card, no hole buttons, spread preview, routes, club or reach tables.
- [ ] In the browser console on both: `NFBridge.settings.debug` is `false` and `NFBridge.settings.test` is `false`.
- [ ] No game page in Qualtrics has `debug` in its script, and `nf_url` has no query string.

## 4. Point Qualtrics at the live games

- [ ] In the Survey Flow's top Embedded Data block, set `nf_url` to `https://<you>.github.io/neon-fairway/` (your GitHub Pages address, **ending with `/`**). The page script adds `target.html` or `course.html`.
- [ ] Open `<nf_url>target.html` and `<nf_url>course.html` in a browser: both load (with no `pid` they open in local-testing mode, which is fine here).
- [ ] Any game page still set to `GAME_FILE = 'stub.html'` from earlier testing is switched back (guide 4c: `target.html` for tp-practice and tp-rounds, `course.html` for course-s1/s2/s3).

## 5. Survey build (guide v4)

- [ ] Layout Flat or Modern; Back button off; page transitions none.
- [ ] The 65 embedded data fields of guide 2a are declared at the top of the Survey Flow (copy the list there).
- [ ] The condition randomizer sets `cond` to exactly `fb-visible` and `fb-hidden` (evenly presented). Anything else silently runs as fb-visible.
- [ ] The five game pages use the guide 4b script word for word, with the three settings lines from the table in 4c.
- [ ] Device check page (guide 3) before the first game page, with its end-of-survey branch.
- [ ] Block order as in guide 2c: the recall questions come before any page that pipes a score.

## 6. Automated tests (local, before the pilot)

From the repo folder, with Node and Playwright installed (`npm i -D playwright`, `npx playwright install chromium firefox webkit`):

- [ ] `node tests/e2e-study.mjs`: whole study path in both conditions, reloads, endpoint down, keys, layout. Expect only the DECIDE item from step 1 (exit code 2) unless it has been resolved.
- [ ] `node tests/qualtrics.mjs --guide /path/to/qualtrics-setup-guide.md`: also confirms the mock still runs the guide's page script word for word.
- [ ] The game suites listed in `README.md` → Tests.

## 7. Manual check in real browsers

The automated tests ran only in Chromium (Firefox and WebKit couldn't be installed in the test environment), so do this by hand in **Safari** and **Firefox** (and Chrome or Edge). Use Qualtrics Preview or the anonymous link, with the browser window at about 1100 × 650 and again maximised.

For each browser:
- [ ] Every game page loads and the game sits at the top of the window once loaded (the page scrolls it there if needed); Next and Back are hidden.
- [ ] Click once on the game (the map), then: ←/→ change the aim, ↑/↓ the power, 1/2/3 the club, Space shoots or swings. The survey page never scrolls with Space or the arrow keys.
- [ ] Clicking outside the game and then once on the map gives the keys back to the game.
- [ ] No scrollbar inside the game on any screen (intro, practice, estimate cards, choose clubs, prediction card, rounds, round card, How to play, section briefing, hole card, Section complete).
- [ ] tp-rounds and every course section show the clubs chosen in practice (Target Practice: the same "Driver B"-style labels; course: see step 1).
- [ ] CONTINUE on each end card reads "Saving…" briefly, then the survey moves on by itself.
- [ ] Reload a game page halfway once: the game restarts the segment, and at the end `…_attempt` is 2. (Safari limits storage for games inside another site's page, so the game may not find its earlier attempt there; the page's own counter still makes it 2. The "reloaded" record for attempt 1 may then be missing in Safari, but attempt 1's earlier saves are in the store.)

## 8. Pilot: 3 people through the anonymous link

- [ ] Three people take the whole survey through the **anonymous link** (not Preview), on different browsers (Chrome, Safari, Firefox) and computers, at least one in each condition. With three people, evenly presented gives 2 + 1; if both land in the same condition, run a fourth.
- [ ] Ask one of them to reload one game page once mid-segment.
- [ ] Note each pilot's ResponseID, browser and condition.

## 9. Check the pilot data: Qualtrics export against the data store, by pid

Export from Data & Analysis → Export & Import → Export data (CSV, embedded data included). In the data store, a response's files are named `{pid}_{segment}_a{attempt}_{tag}.json`; when a record arrives more than once, keep the last copy per `record_id`.

For every pilot response:
- [ ] All 65 embedded data fields are present; every game field is filled in (only the `…_error` fields are empty); nothing is cut off.
- [ ] `…_saved = 1`, `…_failed = 0` and `…_error` empty for all five segments. A `…_saved = 0` means the final save didn't arrive in time: check the store for that pid and segment.
- [ ] The data store has files for the ResponseID as `pid` for all five segments, each with a segment record of `status: "complete"` whose `attempt` equals Qualtrics' `…_attempt`. The reloaded segment also has a segment record for the earlier attempt with `status: "reloaded"`.
- [ ] Scores agree: `tp_r1`–`tp_r5` = the `round` records' `score`; `tp_total` = their sum; each `crs_sN_h#` = that hole record's `strokes`; `crs_sN_total` / `_par` / `_ob` / `_pen` = the segment record's `total_strokes` / `total_par` / `ob_count` / `penalty_strokes`.
- [ ] Bag agrees: `tp_bag` = `bag_seed` on the tp-rounds and course records; `tp_letters` = `letters` on their segment records and `letters_chosen` on the `bag_choice` record.
- [ ] Every record has `test: false` and the same `rng_seed` as Qualtrics' `rng_seed`; `game_version` is `v41` (Target Practice) or `V23` (course).
- [ ] **Condition check.** For every segment record of the response, `feedback` matches Qualtrics' `cond`: `fb-visible` → `visible`, `fb-hidden` → `hidden`. Any mismatch means the randomizer's values are mistyped (the games treat an unknown value as fb-visible): fix them before launch and re-pilot.
- [ ] **No early scores in fb-hidden.** No page a participant sees before the recall questions pipes `tp_r1`–`tp_r5`, `tp_total` or any `crs_` score. To check: export the survey (Tools → Import/Export → Export Survey, a `.qsf` file) and search it for `e://Field/tp_r`, `e://Field/tp_total` and `e://Field/crs_`; every hit must be on or after the recall page, or hidden from fb-hidden by Display Logic. Then confirm with the fb-hidden pilot: no round or hole score appeared anywhere before they answered the recall questions.
- [ ] Record counts look right: tp-rounds has 5 `round`, 5 `prediction` and 60 round `shot` records; each course section has 3 `hole` records with predictions filled in.

## 10. Go

- [ ] Tag the commit that goes live (e.g. `git tag launch-v41-V23`) and don't push changes to the Pages branch during data collection.
- [ ] Remove the pilot responses from Qualtrics (or mark them) and move the pilot files out of the data store.
- [ ] During collection, watch for `…_saved = 0`, `…_failed = 1`, and `…_attempt` above 1 in the export.
