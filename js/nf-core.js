/* ==========================================================================
   js/nf-core.js — Neon Fairway shared club model and shot math
   Used by target.html (Target Practice) and course.html (the 9-hole course).

   Changelog
   - 2026-11-19  Created for the GitHub Pages repo (target.html v37, course.html V18).
                 Part 1 is the "NEON FAIRWAY CORE" script from Course Mode V17,
                 moved here unchanged (byte-for-byte). Part 2 adds what Target
                 Practice needs (makeClubSeed, buildClubStats and the range-shot
                 helpers that keep v36's exact arithmetic), plus NF.rng and
                 NF.subSeed (not used yet).
                 Same day: added the shared power colour scale (NF.POWER_COLOR_STOPS,
                 NF.powerColor), Target Practice's scale, now used by both games.
   - 2026-11-20  (prompt 3, course.html V19) NF.simulateShot also returns zLat and
                 zDist, the two clamped random draws it used (lateral, distance).
                 Same draw order and arithmetic, so every result is unchanged.
                 NF.rng / NF.subSeed are now used by course.html (one stream per hole).

   Load it before the game scripts:  <script src="js/nf-core.js"></script>
   It sets window.NF (or module.exports under Node, for tests).
   ========================================================================== */

/* ==========================================================================
   NEON FAIRWAY CORE — rules, shot physics, terrain lookup.
   Pure functions, no DOM: the Phaser game and the balance simulator both
   run this exact code, so simulated odds match what players experience.
   ========================================================================== */
(function (root) {
  'use strict';

  // ---- Clubs: same club model as Learn Mode / Target Practice (v24) --------
  // Three club types, each in three varieties. A player's bag (one variety
  // per type) comes from the club seed they got at the end of Target
  // Practice, e.g. "DCHPWV" = Control Driver, Power Hybrid, Vertical Wedge.
  //   latSdDeg   — baseline left/right std dev, degrees off the aim line
  //   distSdFrac — baseline long/short std dev, fraction of shot distance
  //   sweetSpot  — power % where the spread is tightest
  //   apex       — arc height for the ball-flight animation only
  const CLUB_TYPES = [
    { key: 'driver', name: 'Driver', seed: 'D', maxDistance: 230, latSdDeg: 3.5, distSdFrac: 0.050, sweetSpot: 70, apex: 0.13 },
    { key: 'hybrid', name: 'Hybrid', seed: 'H', maxDistance: 170, latSdDeg: 2.8, distSdFrac: 0.045, sweetSpot: 75, apex: 0.15 },
    { key: 'wedge',  name: 'Wedge',  seed: 'W', maxDistance: 80,  latSdDeg: 2.0, distSdFrac: 0.040, sweetSpot: 85, apex: 0.32 }
  ];
  //   Control  (C) — shorter, tight in both directions (Driver 0.6 × 0.6, others 0.45 × 0.45)
  //   Vertical (V) — full distance, big long/short miss, tight left/right (0.45 × 1.8)
  //   Power    (P) — 5 yd longer than Control, bigger spread in both directions (0.8 × 0.8)
  const CONTROL_MAX_DISTANCE = { driver: 195, hybrid: 145, wedge: 68 };
  const POWER_EXTRA_YARDS = 5;
  const POWER_MAX_DISTANCE = { driver: 195 + POWER_EXTRA_YARDS, hybrid: 145 + POWER_EXTRA_YARDS, wedge: 68 + POWER_EXTRA_YARDS };
  const SPREAD_VARIETIES = [
    { key: 'control',  name: 'Control',  seed: 'C', latMult: 0.45, distMult: 0.45, maxDistanceByType: CONTROL_MAX_DISTANCE, spreadByType: { driver: { latMult: 0.6, distMult: 0.6 } }, desc: 'shorter, but tight in every direction' },
    { key: 'vertical', name: 'Vertical', seed: 'V', latMult: 0.45, distMult: 1.8, desc: 'full distance, big long/short miss, tight left/right' },
    { key: 'power',    name: 'Power',    seed: 'P', latMult: 0.8,  distMult: 0.8, maxDistanceByType: POWER_MAX_DISTANCE, desc: '5 yd longer than Control, but a bigger spread in every direction' }
  ];
  const POWER_OPTIONS = [100, 85, 75, 40];   // V12: sample powers for tables only; players use a 1-100% slider
  const POWER_MIN = 1, POWER_MAX = 100;

  // Power still widens the spread on a U-curve: tightest at the club type's
  // sweet spot, 1.8x at 100%, 1.4x at very low power. Same as the other modes.
  const POWER_SPREAD = { sweet: 1.0, max: 1.8, low: 1.4 };
  const GAUSS_CLAMP = 3;   // random draws capped at ±3 std devs

  function makeClub(type, variety) {
    const o = (variety.spreadByType && variety.spreadByType[type.key]) || {};
    return {
      id: type.key + '-' + variety.key, type: type.key, variety: variety.key,
      name: type.name, varietyName: variety.name, desc: variety.desc, seed: type.seed + variety.seed,
      maxDistance: (variety.maxDistanceByType && variety.maxDistanceByType[type.key]) || type.maxDistance,
      latSdDeg: type.latSdDeg, distSdFrac: type.distSdFrac, sweetSpot: type.sweetSpot, apex: type.apex,
      latMult: o.latMult != null ? o.latMult : variety.latMult,
      distMult: o.distMult != null ? o.distMult : variety.distMult
    };
  }
  const ALL_CLUBS = [];
  CLUB_TYPES.forEach((t) => SPREAD_VARIETIES.forEach((v) => ALL_CLUBS.push(makeClub(t, v))));
  function getClub(id) { return typeof id === 'object' ? id : ALL_CLUBS.find((c) => c.id === id); }

  // Club seed → bag. Each pair is a type letter (D/H/W) and a variety letter
  // (C/V/P). Pairs may come in either letter order ("WV" or "VW") and any
  // club order; the returned seed is always in Driver, Hybrid, Wedge order.
  function parseSeed(text) {
    const s = String(text || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (s.length !== 6) return { ok: false, error: 'A club seed has 6 letters, like DCHPWV.' };
    const bag = {};
    for (let i = 0; i < 6; i += 2) {
      const a = s[i], b = s[i + 1];
      let type = CLUB_TYPES.find((t) => t.seed === a), variety = SPREAD_VARIETIES.find((v) => v.seed === b);
      if (!type || !variety) { type = CLUB_TYPES.find((t) => t.seed === b); variety = SPREAD_VARIETIES.find((v) => v.seed === a); }
      if (!type || !variety) return { ok: false, error: `"${a}${b}" isn't a club. Each pair needs D, H or W plus C, V or P.` };
      if (bag[type.key]) return { ok: false, error: `The seed lists the ${type.name} twice.` };
      bag[type.key] = makeClub(type, variety);
    }
    const clubs = CLUB_TYPES.map((t) => bag[t.key]);
    return { ok: true, seed: clubs.map((c) => c.seed).join(''), clubs };
  }

  // ---- Terrain & lies -----------------------------------------------------
  const TERRAIN_IDS = ['rock', 'water', 'rough', 'fairway', 'green', 'bunker', 'ob', 'ruins', 'dunes', 'tee', 'canyon', 'quicksand'];
  const T = {}; TERRAIN_IDS.forEach((n, i) => { T[n] = i; });

  // dist: distance multiplier for the NEXT shot from this lie
  // spread: multiplier on both lateral dispersion and distance variability
  // roll: unused since v2 (the ball no longer rolls); kept for reference
  const LIES = {
    tee:     { label: 'Tee box',          dist: 1.00, spread: 1.00, roll: 1.00 },
    fairway: { label: 'Fairway',          dist: 1.00, spread: 1.00, roll: 1.00 },
    rough:   { label: 'Rough',            dist: 0.85, spread: 1.15, roll: 0.35 },
    green:   { label: 'Green',            dist: 1.00, spread: 1.00, roll: 0.70 },
    bunker:  { label: 'Pink sand bunker', dist: 0.65, wedgeDist: 0.90, spread: 1.30, roll: 0 },
    dunes:   { label: 'Pink dunes',       dist: 0.45, wedgeDist: 0.80, spread: 1.50, roll: 0.10 },
    rock:    { label: 'Mountain rocks',   dist: 0.70, spread: 1.30, roll: 0.30 },
    canyon:  { label: 'Canyon rock',      dist: 0.50, spread: 1.50, roll: 0.20 },
    ruins:   { label: 'Marble ruins',     dist: 0.60, spread: 1.40, roll: 0.30 },
    water:   { label: 'Electric field',   hazard: 'electric' },
    quicksand: { label: 'Quicksand',      hazard: 'quicksand' },
    ob:      { label: 'Out of bounds',    hazard: 'ob' }
  };

  const DEFAULT_RULES = {
    penaltyStrokes: 1,          // added on top of the swing itself
    maxStrokes: 12,             // hole is picked up at this many strokes
    putting: [                  // automatic putting once the ball rests on the green
      { maxYards: 3, putts: 1 },
      { maxYards: 20, putts: 2 },
      { maxYards: Infinity, putts: 3 }
    ]
  };

  // ---- Random helpers -------------------------------------------------------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gaussian(rng) {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // ---- Spread math (same as Learn Mode / Target Practice v24) ---------------
  function powerSpreadMult(club, power) {
    const s = club.sweetSpot;
    if (power >= s) return POWER_SPREAD.sweet + ((power - s) / (100 - s)) * (POWER_SPREAD.max - POWER_SPREAD.sweet);
    return POWER_SPREAD.sweet + ((s - power) / s) * (POWER_SPREAD.low - POWER_SPREAD.sweet);
  }
  // Std devs for one swing: latSdDeg (degrees), distSdFrac (fraction of distance)
  function getSpread(club, power) {
    const m = powerSpreadMult(club, power);
    return { latSdDeg: club.latSdDeg * club.latMult * m, distSdFrac: club.distSdFrac * club.distMult * m };
  }
  function clampedGaussian(rng) { return Math.max(-GAUSS_CLAMP, Math.min(GAUSS_CLAMP, gaussian(rng))); }
  function lieDistanceMultiplier(lieName, club, lies) {
    const lie = (lies || LIES)[lieName] || LIES.fairway;
    if (club.type === 'wedge' && lie.wedgeDist) return lie.wedgeDist;
    return lie.dist == null ? 1 : lie.dist;
  }
  function nominalDistance(club, power, lieName, lies) {
    return club.maxDistance * (power / 100) * lieDistanceMultiplier(lieName, club, lies);
  }

  // ---- Course: scale polygons, rasterize terrain grid -------------------------
  function prepareHole(src, opts) {
    const k = opts.scale || 1;
    const sc = (arr) => arr.map((v) => Math.round(v * k * 100) / 100);
    const cmap = Object.assign({ waste: 'rock', sand: 'dunes', column: 'ruins' }, opts.classMap || {});
    const mapT = (t) => cmap[t] || t;
    const lies = JSON.parse(JSON.stringify(LIES));
    for (const key of Object.keys(opts.lieOverrides || {})) lies[key] = Object.assign({}, lies[key], opts.lieOverrides[key]);
    const hole = {
      id: src.id, name: src.name, par: opts.par, base: mapT(opts.base || 'waste'), scale: k, lies,
      bounds: { minX: src.bounds.minX * k, maxX: src.bounds.maxX * k, minY: src.bounds.minY * k, maxY: src.bounds.maxY * k },
      tee: { x: 0, y: 0 },
      pin: { x: src.pin[0] * k, y: src.pin[1] * k },
      polys: src.polys.map((p) => ({ t: mapT(p.t), p: sc(p.p) })),
      zones: {
        safe: src.zones.safe.map((z) => ({ x: z.x * k, y: z.y * k, r: z.r * k })),
        shortcut: src.zones.shortcut.map((z) => ({ x: z.x * k, y: z.y * k, r: z.r * k })),
        alt: (src.zones.alt || []).map((z) => ({ x: z.x * k, y: z.y * k, r: z.r * k }))
      },
      decor: {}
    };
    for (const key of Object.keys(src.decor || {})) {
      const d = src.decor[key];
      hole.decor[key] = Array.isArray(d[0]) ? d.map(sc) : sc(d);
    }
    // order safe waypoints from tee toward the pin
    hole.zones.safe.sort((a, b) => dist(b, hole.pin) - dist(a, hole.pin));
    // strategy routes used by the balance bots (default: the drawn circles)
    hole.routes = { safe: hole.zones.safe.slice(), shortcut: hole.zones.shortcut.slice() };
    for (const key of Object.keys(opts.routes || {})) {
      hole.routes[key] = opts.routes[key].map((w) => ({ x: w[0] * k, y: w[1] * k, r: (w[2] || 30) * k }));
    }
    hole.greenAim = { x: hole.pin.x, y: hole.pin.y, r: 0 };
    hole.grid = rasterize(hole, opts.gridRes || 1);
    if (opts.smartAim !== false) {
      // bots aim at the best-quality ground inside each drawn zone, and at the fat part of the green
      for (const key of Object.keys(hole.routes)) hole.routes[key] = hole.routes[key].map((z) => refineAim(hole, z, z.r, 14));
      hole.greenAim = refineAim(hole, hole.pin, 16, 8);
    }
    hole.lengthYards = Math.round(dist(hole.tee, hole.pin));
    return hole;
  }

  function rasterize(hole, res) {
    const b = hole.bounds;
    const w = Math.ceil((b.maxX - b.minX) / res), h = Math.ceil((b.maxY - b.minY) / res);
    const data = new Uint8Array(w * h).fill(T[hole.base]);
    const xs = new Float64Array(512);
    for (const poly of hole.polys) {
      const p = poly.p, n = p.length / 2, val = T[poly.t];
      let minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < n; i++) { const y = p[2 * i + 1]; if (y < minY) minY = y; if (y > maxY) maxY = y; }
      const j0 = Math.max(0, Math.floor((minY - b.minY) / res - 0.5));
      const j1 = Math.min(h - 1, Math.ceil((maxY - b.minY) / res));
      for (let j = j0; j <= j1; j++) {
        const yc = b.minY + (j + 0.5) * res;
        let cnt = 0;
        for (let i = 0, k = n - 1; i < n; k = i++) {
          const yi = p[2 * i + 1], yk = p[2 * k + 1];
          if ((yi > yc) !== (yk > yc)) {
            const xi = p[2 * i], xk = p[2 * k];
            xs[cnt++] = xi + ((yc - yi) / (yk - yi)) * (xk - xi);
          }
        }
        if (cnt < 2) continue;
        const arr = Array.prototype.slice.call(xs, 0, cnt).sort((u, v) => u - v);
        for (let q = 0; q + 1 < arr.length; q += 2) {
          const i0 = Math.max(0, Math.ceil((arr[q] - b.minX) / res - 0.5));
          const i1 = Math.min(w - 1, Math.floor((arr[q + 1] - b.minX) / res - 0.5));
          for (let i = i0; i <= i1; i++) data[j * w + i] = val;
        }
      }
    }
    return { w, h, res, minX: b.minX, minY: b.minY, data };
  }

  const AIM_VALUE = { fairway: 1, tee: 1, green: 1.1, rough: 0.7, bunker: 0.3, dunes: 0.3, rock: 0.4, canyon: 0.3, ruins: 0.3, water: -1.5, ob: -1.5, quicksand: -1.5 };
  function refineAim(hole, center, radius, rho) {
    const offs = [];
    for (let dx = -rho; dx <= rho; dx += 3) for (let dy = -rho; dy <= rho; dy += 3) if (dx * dx + dy * dy <= rho * rho) offs.push([dx, dy]);
    let best = { x: center.x, y: center.y, r: center.r, score: -Infinity };
    for (let cx = -radius; cx <= radius; cx += 3) for (let cy = -radius; cy <= radius; cy += 3) {
      if (cx * cx + cy * cy > radius * radius) continue;
      const px = center.x + cx, py = center.y + cy;
      let sum = 0;
      for (const [dx, dy] of offs) { const v = AIM_VALUE[terrainAt(hole, px + dx, py + dy)]; sum += v == null ? 0.3 : v; }
      const score = sum / offs.length - 0.002 * Math.hypot(cx, cy);
      if (score > best.score) best = { x: px, y: py, r: center.r, score };
    }
    return best;
  }

  function terrainAt(hole, x, y) {
    const g = hole.grid;
    const i = Math.floor((x - g.minX) / g.res), j = Math.floor((y - g.minY) / g.res);
    if (i < 0 || j < 0 || i >= g.w || j >= g.h) return 'ob';
    return TERRAIN_IDS[g.data[j * g.w + i]];
  }

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function headingTo(from, to) { return Math.atan2(to.x - from.x, to.y - from.y) * 180 / Math.PI; }
  function normDeg(d) { d = ((d + 180) % 360 + 360) % 360 - 180; return d; }

  // ---- One swing --------------------------------------------------------------
  // aimDeg: compass-style heading, 0 = straight up the map (+y), positive = right.
  // No carry and no roll: the ball flies the full distance and stops exactly
  // where it lands, same as Learn Mode and Target Practice. Penalty areas are
  // judged at that landing spot.
  function simulateShot(hole, ball, shot, rng) {
    const club = getClub(shot.club);
    const LZ = hole.lies || LIES;
    const lie = LZ[ball.lie] || LZ.fairway;
    const lieSpread = lie.spread || 1;
    const sp = getSpread(club, shot.power);
    // The two random draws (standard units, clamped to ±3), kept for logging as
    // zLat / zDist. Same draw order and arithmetic as before, so results are unchanged.
    const zLat = clampedGaussian(rng);
    const offsetAngle = zLat * sp.latSdDeg * lieSpread;
    const base = nominalDistance(club, shot.power, ball.lie, LZ);
    const zDist = clampedGaussian(rng);
    const total = Math.max(5, base + zDist * base * sp.distSdFrac * lieSpread);   // 5 yd floor
    const heading = shot.aimDeg + offsetAngle;
    const rad = heading * Math.PI / 180;
    const land = { x: ball.x + Math.sin(rad) * total, y: ball.y + Math.cos(rad) * total };
    const landTerrain = terrainAt(hole, land.x, land.y);
    const out = {
      club: club.id, power: shot.power, aimDeg: shot.aimDeg, offsetAngle, heading,
      nominal: base, total, carry: total, apex: 4 + total * club.apex,
      landX: land.x, landY: land.y, landTerrain,
      endX: land.x, endY: land.y, endTerrain: landTerrain, hazard: null,
      zLat, zDist
    };
    if (LZ[landTerrain] && LZ[landTerrain].hazard) out.hazard = LZ[landTerrain].hazard;
    return out;
  }

  // Penalty-area relief: nearest playable spot to where the ball entered, no nearer the hole.
  function dropNear(hole, x, y) {
    const LZ = hole.lies || LIES;
    const limit = Math.hypot(x - hole.pin.x, y - hole.pin.y) - 0.5;
    for (let r = 2; r <= 80; r += 2) {
      const steps = Math.max(12, Math.round(2 * Math.PI * r / 2));
      let best = null;
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * 2 * Math.PI;
        const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
        const t = terrainAt(hole, px, py);
        if (!LZ[t] || LZ[t].hazard || t === 'green') continue;
        const dp = Math.hypot(px - hole.pin.x, py - hole.pin.y);
        if (dp < limit) continue;
        if (!best || dp < best.dp) best = { x: px, y: py, lie: t, dp };
      }
      if (best) return best;
    }
    return null;
  }

  // V13 out-of-bounds relief: the centre of the nearest grid cell of the
  // given kind(s) of ground (default: fairway) to where the ball came to rest.
  // Works for landings off the map too. With opts.noNearerHole, cells closer
  // to the pin than the landing spot are skipped (golf's usual relief rule).
  function nearestTerrain(hole, x, y, types, opts) {
    const g = hole.grid, want = new Set((types || ['fairway']).map((t) => T[t]));
    const limit = opts && opts.noNearerHole ? Math.hypot(x - hole.pin.x, y - hole.pin.y) - 0.5 : -Infinity;
    const ci = Math.max(0, Math.min(g.w - 1, Math.floor((x - g.minX) / g.res)));
    const cj = Math.max(0, Math.min(g.h - 1, Math.floor((y - g.minY) / g.res)));
    const off = Math.hypot(x - (g.minX + (ci + 0.5) * g.res), y - (g.minY + (cj + 0.5) * g.res));
    let best = null;
    for (let r = 0, maxR = Math.max(g.w, g.h); r <= maxR; r++) {
      if (best && r * g.res - off > best.d) break;   // nothing in this ring or beyond can be closer
      for (let dj = -r; dj <= r; dj++) {
        const j = cj + dj; if (j < 0 || j >= g.h) continue;
        const edgeRow = Math.abs(dj) === r, stepI = edgeRow || r === 0 ? 1 : 2 * r;
        for (let di = -r; di <= r; di += stepI) {
          const i = ci + di; if (i < 0 || i >= g.w) continue;
          const v = g.data[j * g.w + i]; if (!want.has(v)) continue;
          const px = g.minX + (i + 0.5) * g.res, py = g.minY + (j + 0.5) * g.res;
          if (Math.hypot(px - hole.pin.x, py - hole.pin.y) < limit) continue;
          const d = Math.hypot(px - x, py - y);
          if (!best || d < best.d) best = { x: px, y: py, lie: TERRAIN_IDS[v], d };
        }
      }
    }
    return best;
  }

  function puttsFor(yards, rules) {
    for (const r of (rules || DEFAULT_RULES).putting) if (yards <= r.maxYards) return r.putts;
    return 3;
  }

  // Which planned landing area a shot was aimed at (for research logging).
  function classifyTarget(hole, from, aimDeg, nominal) {
    const rad = aimDeg * Math.PI / 180;
    const tx = from.x + Math.sin(rad) * nominal, ty = from.y + Math.cos(rad) * nominal;
    const cands = [];
    hole.zones.shortcut.forEach((z) => cands.push({ name: 'shortcut', z }));
    (hole.zones.alt || []).forEach((z, i) => cands.push({ name: 'alt_' + (i + 1), z }));
    hole.zones.safe.forEach((z, i) => cands.push({ name: 'safe_' + (i + 1), z }));
    let best = null;
    for (const c of cands) {
      const d = Math.hypot(tx - c.z.x, ty - c.z.y);
      if (!best || d < best.d) best = { name: c.name, d };
    }
    const limit = 2.2 * (hole.zones.shortcut[0] ? hole.zones.shortcut[0].r : 38);
    return { targetX: tx, targetY: ty, zone: best && best.d <= limit ? best.name : 'other', zoneDistance: best ? best.d : null };
  }

  // ---- Simple strategy bots (balance testing only) -----------------------------
  function chooseShot(hole, ball, target, policy, bag) {
    const D = dist(ball, target);
    const aimDeg = headingTo(ball, target);
    let best = null;
    for (const club of (bag || ALL_CLUBS)) {
      const full = nominalDistance(club, 100, ball.lie, hole.lies);
      const exact = Math.max(POWER_MIN, Math.min(POWER_MAX, Math.round(100 * D / full)));
      for (const power of new Set([...POWER_OPTIONS, exact])) {
        const nom = nominalDistance(club, power, ball.lie, hole.lies);
        const latSd = nom * Math.sin(getSpread(club, power).latSdDeg * Math.PI / 180);
        const over = Math.max(0, nom - D);
        const cost = Math.abs(nom - D) + policy.spreadWeight * latSd + (policy.overshootWeight || 0) * over;
        if (!best || cost < best.cost) best = { club: club.id, power, aimDeg, cost, nom };
      }
    }
    return best;
  }

  function playHole(hole, routeName, rng, policy, rules, bag) {
    rules = rules || DEFAULT_RULES;
    const route = [...(hole.routes ? hole.routes[routeName] : hole.zones[routeName])];
    route.push(hole.greenAim || { x: hole.pin.x, y: hole.pin.y, r: 0 });
    let ball = { x: hole.tee.x, y: hole.tee.y, lie: 'tee' };
    let strokes = 0, wp = 0, penalties = 0, firstSwingEnd = null;
    const log = [];
    while (strokes < rules.maxStrokes) {
      while (wp < route.length - 1 && (dist(ball, route[wp]) <= Math.max(20, 1.5 * route[wp].r) ||
             dist(ball, hole.pin) <= dist(route[wp], hole.pin) + policy.advanceMargin)) wp++;
      const reach = Math.max(...(bag || ALL_CLUBS).map((c) => nominalDistance(c, 100, ball.lie, hole.lies)));
      const target = dist(ball, hole.pin) <= reach * (policy.goForGreen || 1.0) ? route[route.length - 1] : route[wp];
      const choice = chooseShot(hole, ball, target, policy, bag);
      const res = simulateShot(hole, ball, choice, rng);
      strokes += 1;
      if (firstSwingEnd === null) firstSwingEnd = res;
      log.push(res);
      if (res.hazard) {
        strokes += rules.penaltyStrokes; penalties++;
        const hz = (hole.lies || LIES)[res.endTerrain];
        if (hz && hz.relief === 'drop') { const d = dropNear(hole, res.endX, res.endY); if (d) ball = { x: d.x, y: d.y, lie: d.lie }; }
        if (hz && hz.relief === 'fairway') { const d = nearestTerrain(hole, res.endX, res.endY, ['fairway'], { noNearerHole: !!rules.dropNoNearerHole }); if (d) ball = { x: d.x, y: d.y, lie: d.lie }; }
        continue;
      }
      ball = { x: res.endX, y: res.endY, lie: res.endTerrain };
      if (res.endTerrain === 'green') {
        strokes += puttsFor(dist(ball, hole.pin), rules);
        break;
      }
    }
    return { strokes: Math.min(strokes, rules.maxStrokes), penalties, log, firstSwingEnd };
  }

  const API = {
    CLUB_TYPES, SPREAD_VARIETIES, ALL_CLUBS, CLUBS: ALL_CLUBS, POWER_OPTIONS, POWER_MIN, POWER_MAX, LIES, TERRAIN_IDS, DEFAULT_RULES,
    makeClub, getClub, parseSeed, powerSpreadMult, getSpread,
    mulberry32, gaussian, nominalDistance, lieDistanceMultiplier,
    prepareHole, terrainAt, refineAim, dropNear, nearestTerrain, simulateShot, puttsFor, classifyTarget, dist, headingTo, normDeg,
    chooseShot, playHole
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.NF = API;
})(typeof window !== 'undefined' ? window : globalThis);

/* ==========================================================================
   Part 2 — Target Practice helpers and seeded random streams (added in the
   repo refactor). Extends NF; nothing above is changed.
   ========================================================================== */
(function (root) {
  'use strict';
  const NF = (typeof module !== 'undefined' && module.exports && module.exports.makeClub) ? module.exports : root.NF;
  const GAUSS_CLAMP = 3;   // same ±3 std dev cap as the core

  // ---- Club seed (Target Practice v24) ----------------------------------------
  // One letter for the club type plus one for its variety, in Driver → Hybrid
  // → Wedge order. Control Driver + Power Hybrid + Vertical Wedge → "DCHPWV".
  // bagClubs: [{ typeKey, varietyKey, ... }]. A missing type gives "?".
  function makeClubSeed(bagClubs) {
    return NF.CLUB_TYPES.map((t) => {
      const c = bagClubs.find((x) => x.typeKey === t.key);
      const v = c && NF.SPREAD_VARIETIES.find((x) => x.key === c.varietyKey);
      return t.seed + (v ? v.seed : '?');
    }).join('');
  }

  // ---- Target Practice club stats ---------------------------------------------
  // Same output shape as Target Practice v36: { ...type, variety, maxDistance }.
  // `variety` is a copy with the per-type spread override applied (Control
  // Driver: 0.6 × 0.6), keeping the variety's key/name/desc.
  function buildClubStats(type, variety) {
    const maxDistance = (variety.maxDistanceByType && variety.maxDistanceByType[type.key]) || type.maxDistance;
    const spreadOverride = variety.spreadByType && variety.spreadByType[type.key];
    const v = spreadOverride ? Object.assign({}, variety, spreadOverride) : variety;
    return Object.assign({}, type, { variety: v, maxDistance });
  }

  // ---- Range shots (Target Practice) ------------------------------------------
  // `stats` is a buildClubStats() object. These keep Target Practice v36's
  // exact arithmetic order. NF.simulateShot computes the same thing for a
  // fairway lie, but multiplies the distance noise in a different order
  // (g·base·sd vs g·(base·sd)), which can differ in the last binary digit.
  function rangeSpread(stats, power) {
    return NF.getSpread({
      latSdDeg: stats.latSdDeg, distSdFrac: stats.distSdFrac, sweetSpot: stats.sweetSpot,
      latMult: stats.variety.latMult, distMult: stats.variety.distMult
    }, power);
  }
  function clampedGaussian(rng) {
    return Math.max(-GAUSS_CLAMP, Math.min(GAUSS_CLAMP, NF.gaussian(rng)));
  }
  // Left/right miss in degrees off the aim line (one random draw).
  function rangeLateralDeg(stats, power, rng) {
    return clampedGaussian(rng) * rangeSpread(stats, power).latSdDeg;
  }
  // Distance flown in yards, 5 yd floor (one random draw).
  function rangeDistance(stats, power, rng) {
    const base = stats.maxDistance * (power / 100);
    const stdDev = base * rangeSpread(stats, power).distSdFrac;
    return Math.max(5, base + clampedGaussian(rng) * stdDev);
  }

  // ---- Power colour (shared by both games) ----------------------------------------
  // Runs smoothly through four colours: 40% and below blue · 75% gold ·
  // 85% orange · 100% pink. Same scale and code as Target Practice v36.
  const POWER_COLOR_STOPS = [[1, '#00c8ff'], [40, '#00c8ff'], [75, '#ffd23f'], [85, '#ff8c42'], [100, '#ff2e9a']];
  function powerColor(p) {
    const stops = POWER_COLOR_STOPS;
    p = Math.max(stops[0][0], Math.min(stops[stops.length - 1][0], p));
    for (let i = 1; i < stops.length; i++) {
      const [p1, c1] = stops[i - 1], [p2, c2] = stops[i];
      if (p <= p2) {
        const t = p2 === p1 ? 0 : (p - p1) / (p2 - p1);
        const a = parseInt(c1.slice(1), 16), b = parseInt(c2.slice(1), 16);
        const mix = (sh) => Math.round(((a >> sh) & 255) * (1 - t) + ((b >> sh) & 255) * t);
        return '#' + [16, 8, 0].map((sh) => mix(sh).toString(16).padStart(2, '0')).join('');
      }
    }
    return stops[stops.length - 1][1];
  }

  // ---- Seeded random streams (course.html: one stream per hole) ------------------------
  // NF.rng(seed) → a mulberry32 generator returning floats in [0, 1).
  function rng(seed) { return NF.mulberry32(seed); }
  // cyrb53 string hash (public domain, bryc). Returns a 53-bit integer.
  function cyrb53(str, seed) {
    let h1 = 0xdeadbeef ^ (seed || 0), h2 = 0x41c6ce57 ^ (seed || 0);
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }
  // NF.subSeed(seed, ...parts) → unsigned 32-bit integer from hashing the seed
  // and the parts, e.g. NF.subSeed(rngSeed, 'course', holeNo) gives each hole
  // its own stream: NF.rng(NF.subSeed(rngSeed, 'course', 3)).
  function subSeed(seed, ...parts) {
    return cyrb53([seed].concat(parts).map(String).join('␟')) >>> 0;
  }

  Object.assign(NF, {
    makeClubSeed, buildClubStats,
    rangeSpread, rangeLateralDeg, rangeDistance, clampedGaussian,
    POWER_COLOR_STOPS, powerColor,
    rng, subSeed, cyrb53
  });
})(typeof window !== 'undefined' ? window : globalThis);
