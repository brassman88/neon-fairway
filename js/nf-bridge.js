/* ==========================================================================
   nf-bridge.js — shared data logging and Qualtrics messaging for Neon Fairway
   (course.html and target.html). Follows course-data-logging-spec v2 and
   tp-data-logging-spec v1.

   Changelog
   - bridge 3 (2026-11-20, prompt 6: Target Practice logging):
     · activity() also returns hidden_ms: time with the tab hidden since the page loaded
       (or since newAttempt()), so a game can give any wall-clock time a matching hidden_ms
       (active = wall clock − hidden − idle). active_ms / idle_ms are unchanged, and
       segmentInfo() is unchanged (course records keep the same fields).
     · Final-save grouping: record types ending in "y" pluralise to "ies"
       (club_summary → club_summaries). Course types (shot, hole) are unchanged.
     · finish(): saves of this attempt still waiting in the queue (not the one being
       sent) are dropped when the final save is queued, because the final save carries
       every record of the attempt. With a slow endpoint and many small saves (Target
       Practice saves after each estimate) the queue could otherwise outlast
       DONE_TIMEOUT_MS and nf-done would say saved:false. Saves of other attempts
       (e.g. a "reloaded" attempt) are kept.
   - bridge 2 (2026-11-20, prompt 2):
     · postMessage target: the `qorigin` URL setting if it is a
       https://….qualtrics.com origin, else QUALTRICS_ORIGIN, else "*" (warning).
     · New URL settings `letters` and `pos` (pos is logged only).
     · load_id (8 random characters, one per page load) and game added to the
       shared record header; letters and pos added to segmentInfo().
     · nf-done carries the attempt this finish() actually used (captured when
       finish starts; a second finish() call returns the first one's result).
     · NFBridge.error(code, text) posts { type:'nf-error', segment, code, text }.
     · Reload recovery also works when Qualtrics already raised the attempt in
       the URL: attempt = max(URL attempt, stored attempt + 1), and the stored
       attempt is always re-sent as "reloaded" / its queue re-sent. (Before, a
       URL attempt above the stored one skipped recovery and lost that queue.)
   - bridge 1 (2026-11-13): first version.

   What it does
   - Reads the URL settings: pid, segment, bag, letters, cond, rng, attempt,
     pos, qorigin, debug.
   - Builds the shared record header and record ids.
   - Keeps the in-memory log (window.NF_LOG).
   - Queues saves and POSTs them to DATA_ENDPOINT, retrying failures
     (3 tries, increasing wait). Unsent saves stay queued and go out with the
     next save, at the end of the section, or on pagehide (sendBeacon).
   - Keeps a browser-storage backup of this segment after every save. If the
     page is reloaded mid-segment, the old attempt is re-sent as "reloaded"
     and the new attempt number is bumped so record ids never collide.
   - Tracks visible-tab active and idle time (idle = no input for 60 s).
   - Sends nf-ready and nf-done to the Qualtrics parent page.
   - Exports the log as CSV and JSON (researcher/debug use).

   Load it before the game script:  <script src="nf-bridge.js"></script>
   The game then calls NFBridge.init({...}) once.
   ========================================================================== */
(function (root) {
  'use strict';

  // ---- Set these for the study ----------------------------------------------
  // Where the full log is POSTed. Empty = saves are printed to the console only.
  // Bodies are sent as JSON text with Content-Type text/plain, which avoids a
  // CORS preflight (needed for Google Apps Script and similar endpoints).
  // The endpoint must answer with Access-Control-Allow-Origin for the game host.
  var DATA_ENDPOINT = '';
  // Origin of the Qualtrics page that embeds the game, e.g.
  // 'https://yourschool.qualtrics.com'. Used when the page doesn't pass a valid
  // `qorigin` in the URL. Empty (and no valid qorigin) = '*' with a console warning.
  var QUALTRICS_ORIGIN = 'https:ysupsychology.co1.qualtrics.com';
  // A `qorigin` URL setting is only trusted if it looks like this.
  var QORIGIN_RE = /^https:\/\/[a-z0-9.-]+\.qualtrics\.com$/;

  // Testing only: window.NF_BRIDGE_CONFIG, set before this file loads, can
  // override any of these (used by the headless test harness).
  var CFG = Object.assign({
    DATA_ENDPOINT: DATA_ENDPOINT,
    QUALTRICS_ORIGIN: QUALTRICS_ORIGIN,
    CONTENT_TYPE: 'text/plain;charset=utf-8',
    SAVE_TRIES: 3,            // tries per save before it waits in the queue
    RETRY_BASE_MS: 1000,      // wait before try 2; doubles each try
    FETCH_TIMEOUT_MS: 8000,   // one POST gives up after this
    DONE_TIMEOUT_MS: 10000,   // nf-done goes out after this even if the final save hasn't confirmed
    IDLE_MS: 60000            // no input for this long = idle (same rule as Target Practice)
  }, root.NF_BRIDGE_CONFIG || {});

  var TAG = '[nf-bridge]';
  var now = function () { return (root.performance && performance.now) ? performance.now() : Date.now(); };
  var iso = function () { return new Date().toISOString(); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var safe = function (s) { return String(s).replace(/[^A-Za-z0-9_-]+/g, '-'); };

  // ---- URL settings -------------------------------------------------------------
  // Local testing (no pid): pid=local-test, segment=<game default>, debug=1,
  // and every record carries test: true. With a pid, debug is off unless debug=1.
  var q = new URLSearchParams(root.location ? root.location.search : '');
  var given = function (k) { return q.has(k) && q.get(k).trim() !== ''; };
  var intOr = function (v, d) { var n = parseInt(v, 10); return isFinite(n) ? n : d; };
  var localTest = !given('pid');
  var debug = given('debug') ? q.get('debug') === '1' : localTest;
  // 8 random characters [a-z0-9], new on every page load (rejection sampling: no modulo bias).
  function randomId(n) {
    var abc = 'abcdefghijklmnopqrstuvwxyz0123456789', out = '';
    while (out.length < n) {
      var b = new Uint8Array(n * 2);
      if (root.crypto && crypto.getRandomValues) crypto.getRandomValues(b);
      else for (var j = 0; j < b.length; j++) b[j] = Math.floor(Math.random() * 256);
      for (var i = 0; i < b.length && out.length < n; i++) if (b[i] < 252) out += abc[b[i] % 36];
    }
    return out;
  }
  var settings = {
    pid: localTest ? 'local-test' : q.get('pid').trim(),
    segment: given('segment') ? q.get('segment').trim() : null,     // filled by init() if missing
    bag: given('bag') ? q.get('bag').trim() : null,
    // Chosen club letters in Driver, Hybrid, Wedge order, e.g. "B,A,C" (spaces dropped, upper case).
    letters: given('letters') ? q.get('letters').replace(/\s+/g, '').toUpperCase() : null,
    // Play position for counterbalancing. Logged only: a whole number if it is one, else the text.
    pos: given('pos') ? (/^\d+$/.test(q.get('pos').trim()) ? parseInt(q.get('pos'), 10) : q.get('pos').trim()) : null,
    // Origin of the Qualtrics page as it reported it (raw; see targetOrigin below for what is used).
    qorigin: given('qorigin') ? q.get('qorigin').trim() : null,
    load_id: randomId(8),
    cond: given('cond') ? q.get('cond').trim() : null,
    rng: given('rng') ? intOr(q.get('rng'), null) : null,
    rngGiven: false,
    attempt: Math.max(1, intOr(q.get('attempt'), 1)),
    attemptFromUrl: Math.max(1, intOr(q.get('attempt'), 1)),
    debug: debug,
    localTest: localTest,
    test: localTest || debug
  };
  settings.rngGiven = settings.rng != null;
  if (settings.rng == null) {
    // No seed given: draw one so the segment can still be replayed exactly. Logged as rng_seed.
    var buf = new Uint32Array(1);
    if (root.crypto && crypto.getRandomValues) crypto.getRandomValues(buf); else buf[0] = Math.floor(Math.random() * 4294967296);
    settings.rng = buf[0] % 2147483647 + 1;
  }

  // ---- State ------------------------------------------------------------------
  var NF_LOG = [];                 // every record, in the order made (segment record kept current)
  var queue = [];                  // [{ file, body }] not yet confirmed by the data store
  var flushing = null;
  var meta = { game: null, game_version: null, bag_seed: null };
  var segProvider = null;          // game callback: (status) => segment record
  var st = { inited: false, finished: false, finishing: null, saveFailures: 0, startedAt: iso(), consoleOnly: false, errors: [] };
  var sent = [];                   // messages posted to the parent (last 50), for the stub page and tests
  var warned = {};
  function warnOnce(key, msg) { if (!warned[key]) { warned[key] = true; console.warn(TAG, msg); } }
  function dbg() { if (settings.debug) console.info.apply(console, [TAG].concat([].slice.call(arguments))); }

  // ---- Where messages to Qualtrics go ------------------------------------------------
  // 1. `qorigin` from the URL, if it is a https://….qualtrics.com origin;
  // 2. else the QUALTRICS_ORIGIN constant; 3. else "*" (any parent) with a warning.
  var target = (function () {
    if (settings.qorigin && QORIGIN_RE.test(settings.qorigin)) return { origin: settings.qorigin, from: 'qorigin' };
    if (settings.qorigin) warnOnce('qorigin', 'qorigin "' + settings.qorigin + '" is not a https://….qualtrics.com origin; ignored.');
    if (CFG.QUALTRICS_ORIGIN) return { origin: CFG.QUALTRICS_ORIGIN, from: 'constant' };
    return { origin: '*', from: 'any' };
  })();

  // ---- Activity: visible-tab active and idle time ----------------------------------
  var act = { visible: !root.document || document.visibilityState !== 'hidden', last: now(), lastInput: now(), active: 0, idle: 0, hidden: 0 };
  var attemptBase = { active: 0, idle: 0, hidden: 0 };
  function accrue(t) {
    if (act.visible) {
      var span = t - act.last;
      var idlePart = Math.min(span, Math.max(0, t - Math.max(act.last, act.lastInput + CFG.IDLE_MS)));
      act.idle += idlePart; act.active += span - idlePart;
    } else {
      act.hidden += t - act.last;               // bridge 3: hidden-tab time
    }
    act.last = t;
  }
  function onInput() { var t = now(); accrue(t); act.lastInput = t; }
  if (root.addEventListener) {
    ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'].forEach(function (ev) {
      root.addEventListener(ev, onInput, { capture: true, passive: true });
    });
  }
  if (root.document) {
    document.addEventListener('visibilitychange', function () {
      var t = now(); accrue(t);
      act.visible = document.visibilityState !== 'hidden';
      if (act.visible) act.lastInput = t;     // coming back to the tab counts as input
    });
  }
  // Totals since the page loaded (or since newAttempt()).
  // active_ms + idle_ms = visible time; hidden_ms = time with the tab hidden (bridge 3).
  function activity() {
    accrue(now());
    return { active_ms: Math.round(act.active - attemptBase.active), idle_ms: Math.round(act.idle - attemptBase.idle),
      hidden_ms: Math.round(act.hidden - attemptBase.hidden) };
  }

  // ---- Records ------------------------------------------------------------------
  function recordId(suffix) { return settings.pid + '-' + settings.segment + '-a' + settings.attempt + '-' + suffix; }
  function fileName(tag) { return safe(settings.pid) + '_' + safe(settings.segment) + '_a' + settings.attempt + '_' + tag + '.json'; }
  // Shared header (same fields in both games).
  function header(type, suffix) {
    return {
      record_type: type, record_id: recordId(suffix), pid: settings.pid, segment: settings.segment,
      attempt: settings.attempt, load_id: settings.load_id, game: meta.game, game_version: meta.game_version,
      cond: settings.cond, bag_seed: meta.bag_seed, rng_seed: settings.rng, test: settings.test, client_time: iso()
    };
  }
  // Device and timing fields every segment record carries (plus letters and pos from the URL).
  function segmentInfo() {
    var a = activity();
    return {
      letters: settings.letters, pos: settings.pos,
      started_at: st.startedAt, active_ms: a.active_ms, idle_ms: a.idle_ms,
      screen_w: root.screen ? screen.width : null, screen_h: root.screen ? screen.height : null,
      user_agent: root.navigator ? navigator.userAgent : null, save_failures: st.saveFailures
    };
  }
  // Add a record, or replace the one with the same record_id.
  function log(rec) {
    for (var i = 0; i < NF_LOG.length; i++) if (NF_LOG[i].record_id === rec.record_id) { NF_LOG[i] = rec; return rec; }
    NF_LOG.push(rec); return rec;
  }
  function currentSegment(status) {
    if (!segProvider) return null;
    var rec = segProvider(status);
    if (rec) log(rec);
    return rec;
  }

  // ---- Browser-storage backup (best effort; Safari partitions iframe storage) ----------
  function backupKey() { return 'nf-backup:' + settings.pid + ':' + settings.segment; }
  function backup() {
    if (!st.inited) return;
    try {
      var seg = null;
      for (var i = NF_LOG.length - 1; i >= 0; i--) if (NF_LOG[i].record_type === 'segment' && NF_LOG[i].attempt === settings.attempt) { seg = NF_LOG[i]; break; }
      localStorage.setItem(backupKey(), JSON.stringify({
        v: 1, attempt: settings.attempt, finished: st.finished, segment_record: seg,
        records: NF_LOG.filter(function (r) { return r.attempt === settings.attempt; }), queue: queue
      }));
    } catch (e) { /* storage blocked or full: backup is best effort */ }
  }
  // On load: an earlier attempt of this pid + segment in storage means a reload
  // (or a return). Bump the attempt, re-send the old attempt marked "reloaded",
  // and re-queue anything it never managed to send.
  // The new attempt is the larger of the URL's attempt (the Qualtrics page's own
  // reload counter) and the stored attempt + 1, so it never repeats either one.
  function recoverFromBackup() {
    var b = null;
    try { b = JSON.parse(localStorage.getItem(backupKey()) || 'null'); } catch (e) { b = null; }
    if (!b || !b.attempt) return;
    var prevAttempt = b.attempt;
    settings.attempt = Math.max(settings.attempt, prevAttempt + 1);
    var superseded = !b.finished && b.segment_record;     // the "reloaded" record below replaces the exit save
    (b.queue || []).forEach(function (env) { if (!(superseded && /_exit\.json$/.test(env.file))) queue.push(env); });
    if (superseded) {
      var rec = Object.assign({}, b.segment_record, { status: 'reloaded', client_time: iso() });
      var file = safe(settings.pid) + '_' + safe(settings.segment) + '_a' + prevAttempt + '_reloaded.json';
      queue.push({ file: file, body: { file: file, segment: settings.segment, segment_record: rec } });
    }
    dbg('found attempt ' + prevAttempt + ' in storage; this is attempt ' + settings.attempt);
  }

  // ---- Saving ---------------------------------------------------------------------
  function postOnce(env) {
    var ctl = root.AbortController ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, CFG.FETCH_TIMEOUT_MS) : null;
    return fetch(CFG.DATA_ENDPOINT, {
      method: 'POST', mode: 'cors', cache: 'no-store', headers: { 'Content-Type': CFG.CONTENT_TYPE },
      body: JSON.stringify(env.body), signal: ctl ? ctl.signal : undefined
    }).then(function (r) {
      if (timer) clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return true;
    }, function (e) { if (timer) clearTimeout(timer); throw e; });
  }
  async function sendWithRetry(env) {
    if (!CFG.DATA_ENDPOINT) {
      st.consoleOnly = true;
      console.info(TAG, 'save (no DATA_ENDPOINT set):', env.file, env.body);
      return true;
    }
    for (var i = 0; i < CFG.SAVE_TRIES; i++) {
      if (i) await sleep(CFG.RETRY_BASE_MS * Math.pow(2, i - 1));
      try { await postOnce(env); dbg('saved', env.file); return true; }
      catch (e) { st.saveFailures++; console.warn(TAG, 'save failed (try ' + (i + 1) + ' of ' + CFG.SAVE_TRIES + '):', env.file, e && e.message); }
    }
    return false;
  }
  // Send the queue in order. Resolves true once it is empty, false if the head
  // save failed all its tries (it stays queued for the next flush).
  function flush() {
    if (flushing) return flushing;
    flushing = (async function () {
      while (queue.length) {
        var ok = await sendWithRetry(queue[0]);
        if (!ok) return false;
        queue.shift(); backup();
      }
      return true;
    })();
    var p = flushing;
    p.then(function () { if (flushing === p) flushing = null; });
    return p;
  }
  // Save a batch (e.g. one hole). payload holds record arrays, e.g. { holes: [...], shots: [...] }.
  // The current segment record rides along with every save.
  function save(tag, payload) {
    var seg = currentSegment();
    var file = fileName(tag);
    queue.push({ file: file, body: Object.assign({ file: file, segment: settings.segment, segment_record: seg }, payload || {}) });
    backup();
    return flush();
  }
  // Plural used as the key for a record type in save bodies: shot → shots,
  // club_summary → club_summaries (bridge 3).
  function plural(type) { return /[^aeiou]y$/.test(type) ? type.slice(0, -1) + 'ies' : type + 's'; }
  // Records of this attempt grouped by type: { holes: [...], shots: [...] }.
  function recordsByType() {
    var out = {};
    NF_LOG.forEach(function (r) {
      if (r.attempt !== settings.attempt || r.record_type === 'segment') return;
      var k = plural(r.record_type);
      (out[k] = out[k] || []).push(r);
    });
    return out;
  }

  // ---- Qualtrics messages ----------------------------------------------------------
  function post(msg) {
    dbg('message →', target.origin, JSON.stringify(msg));
    sent.push({ at: iso(), to: target.origin, msg: msg });
    if (sent.length > 50) sent.shift();
    if (!root.parent || root.parent === root) return;
    if (target.from === 'any') warnOnce('origin', 'No valid qorigin and QUALTRICS_ORIGIN is not set; messages go to any parent ("*").');
    try { root.parent.postMessage(msg, target.origin); } catch (e) { console.warn(TAG, 'postMessage failed', e); }
  }
  function ready() { post({ type: 'nf-ready', segment: settings.segment }); }
  // Something stops the game (bad bag, unknown segment…): tell the Qualtrics page.
  // code: short upper-case word, e.g. 'BAG' or 'SEGMENT'; text: one line for people.
  function error(code, text) {
    code = String(code == null ? 'ERROR' : code).slice(0, 40);
    text = text == null ? '' : String(text).slice(0, 500);
    st.errors.push({ code: code, text: text, at: iso() });
    console.warn(TAG, 'error ' + code + ': ' + text);
    post({ type: 'nf-error', segment: settings.segment, code: code, text: text });
  }

  // End of section: final save (segment + every hole and shot record of this
  // attempt), then nf-done once it is confirmed or after DONE_TIMEOUT_MS.
  // summaryFn(saved, attempt) returns the Qualtrics summary fields.
  // The attempt is fixed when finish() starts, so the records, the summary and
  // nf-done all carry the same number. Calling finish() again returns the same
  // promise (until newAttempt()).
  function finish(summaryFn) {
    if (st.finishing) return st.finishing;
    if (!st.inited) { warnOnce('init', 'finish() called before init(); using init() defaults.'); init({}); }
    var attempt = settings.attempt;
    st.finished = true;
    var seg = currentSegment('complete');
    var file = fileName('final');
    // bridge 3: the final save supersedes this attempt's waiting saves (queue[0] may be in flight).
    var mine = safe(settings.pid) + '_' + safe(settings.segment) + '_a' + attempt + '_';
    var dropped = 0;
    for (var i = queue.length - 1; i >= (flushing ? 1 : 0); i--) {
      if (queue[i].file.indexOf(mine) === 0) { queue.splice(i, 1); dropped++; }
    }
    if (dropped) dbg('final save supersedes ' + dropped + ' waiting save(s) of attempt ' + attempt);
    queue.push({ file: file, body: Object.assign({ file: file, segment: settings.segment, segment_record: seg }, recordsByType()) });
    backup();
    st.finishing = (async function () {
      var drained = await Promise.race([flush(), sleep(CFG.DONE_TIMEOUT_MS).then(function () { return false; })]);
      var saved = !!CFG.DATA_ENDPOINT && drained && queue.length === 0;
      var summary = summaryFn ? summaryFn(saved, attempt) : {};
      post({ type: 'nf-done', segment: settings.segment, attempt: attempt, saved: saved, summary: summary });
      return { saved: saved, attempt: attempt, summary: summary };
    })();
    return st.finishing;
  }

  // ---- Leaving the page -----------------------------------------------------------
  function beacon(env) {
    var data = JSON.stringify(env.body);
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(CFG.DATA_ENDPOINT, new Blob([data], { type: CFG.CONTENT_TYPE }))) return;
    } catch (e) { /* fall through */ }
    try { fetch(CFG.DATA_ENDPOINT, { method: 'POST', mode: 'cors', keepalive: true, headers: { 'Content-Type': CFG.CONTENT_TYPE }, body: data }); } catch (e) { /* nothing more to try */ }
  }
  if (root.addEventListener) {
    root.addEventListener('pagehide', function () {
      if (!st.inited) return;
      if (!st.finished) {
        var seg = currentSegment('abandoned');
        if (seg) { var file = fileName('exit'); queue.push({ file: file, body: { file: file, segment: settings.segment, segment_record: seg } }); }
      }
      backup();                                   // queue kept: a reload re-sends it (duplicates share record_ids)
      if (!queue.length) return;
      if (!CFG.DATA_ENDPOINT) { console.info(TAG, 'pagehide: unsent (no DATA_ENDPOINT set):', queue.map(function (e) { return e.file; })); return; }
      queue.forEach(beacon);
    });
  }

  // ---- Researcher export ------------------------------------------------------------
  var TYPE_ORDER = { segment: 0, hole: 1, trial: 1, round: 1, bag_choice: 1, club_summary: 1, estimate: 2, shot: 3 };
  function sortedLog() {
    return NF_LOG.map(function (r, i) { return { r: r, i: i }; }).sort(function (a, b) {
      var ta = TYPE_ORDER[a.r.record_type], tb = TYPE_ORDER[b.r.record_type];
      ta = ta == null ? 9 : ta; tb = tb == null ? 9 : tb;
      return a.r.attempt - b.r.attempt || ta - tb || a.i - b.i;
    }).map(function (x) { return x.r; });
  }
  function toCSV(recs) {
    var cols = [];
    recs.forEach(function (r) { Object.keys(r).forEach(function (k) { if (cols.indexOf(k) < 0) cols.push(k); }); });
    var esc = function (v) {
      if (v == null) return '';
      var s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [cols.join(',')].concat(recs.map(function (r) { return cols.map(function (c) { return esc(r[c]); }).join(','); })).join('\r\n') + '\r\n';
  }
  function saveBlob(name, text, type) {
    var url = URL.createObjectURL(new Blob([text], { type: type }));
    var a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  // One CSV (every record, one row each, record_type first) and one JSON file.
  function download(base) {
    base = base || ('nf_' + safe(settings.pid) + '_' + safe(settings.segment) + '_a' + settings.attempt);
    var recs = sortedLog();
    saveBlob(base + '.csv', toCSV(recs), 'text/csv');
    var json = JSON.stringify({ exported_at: iso(), settings: publicSettings(), records: recs }, null, 2);
    setTimeout(function () { saveBlob(base + '.json', json, 'application/json'); }, 400);
  }
  function publicSettings() {
    return { pid: settings.pid, segment: settings.segment, bag: settings.bag, letters: settings.letters, cond: settings.cond,
      rng: settings.rng, rng_given: settings.rngGiven, attempt: settings.attempt, attempt_from_url: settings.attemptFromUrl,
      pos: settings.pos, qorigin: settings.qorigin, post_origin: target.origin, post_origin_from: target.from,
      load_id: settings.load_id, debug: settings.debug, local_test: settings.localTest, test: settings.test,
      endpoint_set: !!CFG.DATA_ENDPOINT };
  }

  // ---- Setup -----------------------------------------------------------------------
  // opts: { game, gameVersion, defaultSegment, segmentRecord: (status) => record }
  function init(opts) {
    opts = opts || {};
    meta.game = opts.game || null;
    meta.game_version = opts.gameVersion || null;
    if (!settings.segment) settings.segment = opts.defaultSegment || 'default';
    segProvider = opts.segmentRecord || null;
    recoverFromBackup();
    st.inited = true;
    if (!CFG.DATA_ENDPOINT) warnOnce('endpoint', 'DATA_ENDPOINT is not set; saves are printed to the console.');
    dbg('settings', JSON.stringify(publicSettings()));
    if (queue.length) { backup(); flush(); }
  }
  // A new attempt in the same page (researcher "play again").
  function newAttempt() {
    settings.attempt += 1; st.finished = false; st.finishing = null; st.startedAt = iso();
    var a = activity();
    attemptBase = { active: attemptBase.active + a.active_ms, idle: attemptBase.idle + a.idle_ms, hidden: attemptBase.hidden + a.hidden_ms };
    backup();
  }

  root.NF_LOG = NF_LOG;
  root.NFBridge = {
    settings: settings,
    get hasEndpoint() { return !!CFG.DATA_ENDPOINT; },
    get finished() { return st.finished; },
    init: init,
    set: function (o) { Object.assign(meta, o || {}); },
    header: header, recordId: recordId, fileName: fileName,
    log: log, save: save, flush: flush, finish: finish, ready: ready, error: error, post: post, newAttempt: newAttempt,
    activity: activity, segmentInfo: segmentInfo, publicSettings: publicSettings, plural: plural,
    get loadId() { return settings.load_id; },
    get targetOrigin() { return target.origin; },     // where messages to the Qualtrics page go
    sent: function () { return sent.slice(); },       // messages posted so far (last 50)
    errors: function () { return st.errors.slice(); },
    saveFailures: function () { return st.saveFailures; },
    queueLength: function () { return queue.length; },
    download: download, toCSV: toCSV
  };
})(typeof window !== 'undefined' ? window : globalThis);
