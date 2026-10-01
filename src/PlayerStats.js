// MLB roster database, ratings, and the rating → physics curves from
// docs/ARCHITECTURE.md §4. Pure module: no Three.js, DOM or audio.
//
// Data is authored in baseball units (mph, rpm, in, ft) and converted to SI
// through the helpers at the bottom of the file.
//
// DATA PROVENANCE: each player carries a `source` block. Values marked
// confidence 'medium' were cross-checked against published 2024–25 Statcast
// figures (via MLB.com / FanGraphs / Pitcher List reporting); everything not
// covered there is an engineering estimate. Re-verify against Baseball Savant
// before treating any number as authoritative.

import { MPH, RPM, IN, FT } from './core/units.js';
import { PLATE, FIELD } from './core/constants.js';

// ---------------------------------------------------------------------------
// Reference tables
// ---------------------------------------------------------------------------

/** League-average movement by pitch type (IVB in, HB arm-side in) used for "break %". */
export const LEAGUE_AVG_MOVEMENT = deepFreeze({
  FF: { ivbIn: 15.8, hbArmIn: 7.5 },
  SI: { ivbIn: 7.5, hbArmIn: 15.0 },
  FC: { ivbIn: 8.0, hbArmIn: -2.5 },
  SL: { ivbIn: 2.0, hbArmIn: -5.0 },
  ST: { ivbIn: 0.5, hbArmIn: -14.0 },
  CU: { ivbIn: -10.0, hbArmIn: -8.0 },
  KC: { ivbIn: -10.0, hbArmIn: -8.0 },
  CH: { ivbIn: 6.0, hbArmIn: 14.0 },
  FS: { ivbIn: 2.5, hbArmIn: 10.0 },
});

/** Pitch-type display metadata; colors follow the common broadcast palette. */
export const PITCH_TYPES = deepFreeze({
  FF: { name: '4-Seam Fastball', short: '4-Seam', color: '#d22d49', family: 'FB' },
  SI: { name: 'Sinker', short: 'Sinker', color: '#fe9d00', family: 'FB' },
  FC: { name: 'Cutter', short: 'Cutter', color: '#933f2c', family: 'FB' },
  SL: { name: 'Slider', short: 'Slider', color: '#eee716', family: 'BR' },
  ST: { name: 'Sweeper', short: 'Sweeper', color: '#ddb33a', family: 'BR' },
  CU: { name: 'Curveball', short: 'Curve', color: '#00d1ed', family: 'BR' },
  KC: { name: 'Knuckle Curve', short: 'Knuckle-Curve', color: '#6236cd', family: 'BR' },
  CH: { name: 'Changeup', short: 'Changeup', color: '#1dbe3a', family: 'OS' },
  FS: { name: 'Splitter', short: 'Splitter', color: '#3bacac', family: 'OS' },
});

export const TEAMS = deepFreeze({
  NYY: { name: 'New York Yankees', primary: '#0c2340', accent: '#c4ced3' },
  LAD: { name: 'Los Angeles Dodgers', primary: '#005a9c', accent: '#ef3e42' },
  NYM: { name: 'New York Mets', primary: '#002d72', accent: '#ff5910' },
  SEA: { name: 'Seattle Mariners', primary: '#0c2c56', accent: '#005c5c' },
  PIT: { name: 'Pittsburgh Pirates', primary: '#27251f', accent: '#fdb827' },
  ARI: { name: 'Arizona Diamondbacks', primary: '#a71930', accent: '#e3d4ad' },
  DET: { name: 'Detroit Tigers', primary: '#0c2340', accent: '#fa4616' },
});

// ---------------------------------------------------------------------------
// Roster (shipped baseline). Ratings are 1–99; contact/power split vs LHP/RHP.
// ---------------------------------------------------------------------------

const BASE_BATTERS = [
  {
    id: 'judge', name: 'Aaron Judge', team: 'NYY', bats: 'R', heightIn: 79,
    ratings: { contact: { vsL: 86, vsR: 84 }, power: { vsL: 99, vsR: 99 }, vision: 93 },
    swing: { avgBatSpeedMph: 76.5, attackAngleDeg: 12 },
    ref: { maxEvMph: 119, avgEvMph: 95.5 },
    source: { season: 2024, confidence: 'medium', note: 'Bat speed 76.5 mph (2024 bat tracking); EV and attack angle estimated.' },
  },
  {
    id: 'ohtani', name: 'Shohei Ohtani', team: 'LAD', bats: 'L', heightIn: 76, twoWayOf: 'ohtaniP',
    ratings: { contact: { vsL: 80, vsR: 88 }, power: { vsL: 94, vsR: 99 }, vision: 90 },
    swing: { avgBatSpeedMph: 76.3, attackAngleDeg: 13 },
    ref: { maxEvMph: 119, avgEvMph: 94.5 },
    source: { season: 2024, confidence: 'medium', note: 'Bat speed 76.3 mph (2024 bat tracking); EV and attack angle estimated.' },
  },
  {
    id: 'soto', name: 'Juan Soto', team: 'NYM', bats: 'L', heightIn: 74,
    ratings: { contact: { vsL: 84, vsR: 90 }, power: { vsL: 86, vsR: 92 }, vision: 99 },
    swing: { avgBatSpeedMph: 75.5, attackAngleDeg: 9 },
    ref: { maxEvMph: 116, avgEvMph: 93.5 },
    source: { season: 2024, confidence: 'medium', note: 'Bat speed 75.5 mph (2024 bat tracking); EV and attack angle estimated.' },
  },
  {
    id: 'raleigh', name: 'Cal Raleigh', team: 'SEA', bats: 'S', heightIn: 74,
    ratings: { contact: { vsL: 70, vsR: 74 }, power: { vsL: 93, vsR: 96 }, vision: 80 },
    swing: { avgBatSpeedMph: 74.5, attackAngleDeg: 15 },
    ref: { maxEvMph: 114.7, avgEvMph: 91.3 },
    source: { season: 2025, confidence: 'medium', note: '60 HR season; max EV 114.7, avg EV 91.3. Bat speed and attack angle estimated.' },
  },
];

// Arsenal rows: mph · rpm · IVB (in) · HB arm-side (in, + = arm side) · usage (%).
// Arsenals are trimmed to each pitcher's top five pitches with usage renormalized
// to 100. `activeSpin` (spin efficiency 0–1) is included only where published.
const BASE_PITCHERS = [
  {
    id: 'skenes', name: 'Paul Skenes', team: 'PIT', throws: 'R',
    ratings: { velocity: 98, control: 90, break: 93 },
    release: { heightFt: 5.7, sideFt: -1.9, extensionFt: 6.6 },
    arsenal: [
      { code: 'FF', mph: 98.2, rpm: 2170, ivbIn: 11.6, hbArmIn: 14.0, usage: 42, stuff: 92 },
      { code: 'ST', mph: 84.5, rpm: 2450, ivbIn: 5.7, hbArmIn: -12.0, usage: 17, stuff: 88 },
      { code: 'FS', name: 'Splinker', mph: 94.0, rpm: 1800, ivbIn: 4.0, hbArmIn: 15.0, usage: 14, stuff: 97 },
      { code: 'SI', mph: 97.2, rpm: 2150, ivbIn: 8.0, hbArmIn: 17.0, usage: 13, stuff: 85 },
      { code: 'CH', mph: 88.7, rpm: 1700, ivbIn: 6.0, hbArmIn: 16.0, usage: 14, stuff: 84 },
    ],
    source: {
      season: 2025, confidence: 'medium',
      note: 'FF 98.2 mph / 2166 rpm / 11.6 IVB / 14.0 HB and ST 84.5 mph / 5.7 IVB reported for 2025; splinker ~1,800 rpm with ~15 in arm-side run. Other spin and break values estimated.',
    },
  },
  {
    id: 'cole', name: 'Gerrit Cole', team: 'NYY', throws: 'R',
    ratings: { velocity: 92, control: 92, break: 88 },
    release: { heightFt: 5.9, sideFt: -2.1, extensionFt: 6.5 },
    arsenal: [
      { code: 'FF', mph: 95.9, rpm: 2362, ivbIn: 17.6, hbArmIn: 6.6, usage: 49, activeSpin: 0.914, stuff: 90 },
      { code: 'SL', mph: 88.3, rpm: 2450, ivbIn: 3.0, hbArmIn: -5.3, usage: 20, activeSpin: 0.28, stuff: 86 },
      { code: 'KC', mph: 82.5, rpm: 2700, ivbIn: -9.0, hbArmIn: -8.0, usage: 14, stuff: 87 },
      { code: 'CH', mph: 85.3, rpm: 1700, ivbIn: 9.1, hbArmIn: 12.0, usage: 13, stuff: 80 },
      { code: 'SI', mph: 95.0, rpm: 2250, ivbIn: 10.0, hbArmIn: 15.0, usage: 4, stuff: 75 },
    ],
    source: {
      season: 2024, confidence: 'medium',
      note: 'Pre-Tommy John (Mar 2025) baseline. 2024: FF 95.9 mph / 2362 rpm / 17.6 IVB / 6.6 HB / 91.4% active; SL 88.3 mph, 6.1 in total movement, 28% active; CH 10.6 mph & 8.5 in IVB off the FF.',
    },
  },
  {
    id: 'burnes', name: 'Corbin Burnes', team: 'ARI', throws: 'R',
    ratings: { velocity: 86, control: 89, break: 96 },
    release: { heightFt: 5.9, sideFt: -2.3, extensionFt: 6.4 },
    arsenal: [
      { code: 'FC', mph: 95.3, rpm: 2600, ivbIn: 11.4, hbArmIn: -3.0, usage: 54, activeSpin: 0.62, stuff: 93 },
      { code: 'CU', mph: 81.5, rpm: 2800, ivbIn: -10.0, hbArmIn: -9.0, usage: 24, stuff: 90 },
      { code: 'CH', mph: 89.5, rpm: 1900, ivbIn: 6.0, hbArmIn: 14.0, usage: 11, stuff: 82 },
      { code: 'SI', mph: 97.0, rpm: 2350, ivbIn: 9.0, hbArmIn: 16.0, usage: 7, stuff: 80 },
      { code: 'SL', mph: 88.0, rpm: 2600, ivbIn: 2.0, hbArmIn: -5.0, usage: 4, stuff: 78 },
    ],
    source: {
      season: 2025, confidence: 'medium',
      note: 'Partial 2025 (Tommy John, June 2025). Usage FC 53.5 / CU 23.7 / CH 11.1 / SI 7.6 / SL 4.0; FC 95.3 mph, 62% active, 11.8 in total movement; SI 97.0 mph. Spin and remaining break values estimated.',
    },
  },
  {
    id: 'ohtaniP', name: 'Shohei Ohtani', team: 'LAD', throws: 'R', twoWayOf: 'ohtani',
    ratings: { velocity: 97, control: 78, break: 97 },
    release: { heightFt: 5.6, sideFt: -2.6, extensionFt: 6.3 },
    arsenal: [
      { code: 'FF', mph: 98.1, rpm: 2450, ivbIn: 15.5, hbArmIn: 8.5, usage: 45, stuff: 90 },
      { code: 'ST', mph: 85.0, rpm: 2700, ivbIn: 2.0, hbArmIn: -16.0, usage: 30, stuff: 96 },
      { code: 'CU', mph: 77.5, rpm: 2600, ivbIn: -8.0, hbArmIn: -11.0, usage: 10, stuff: 82 },
      { code: 'FS', mph: 89.0, rpm: 1350, ivbIn: 3.5, hbArmIn: 10.0, usage: 9, stuff: 88 },
      { code: 'SI', mph: 96.5, rpm: 2350, ivbIn: 9.0, hbArmIn: 15.0, usage: 6, stuff: 80 },
    ],
    source: {
      season: 2025, confidence: 'medium',
      note: 'Usage FF 45.1 / ST 29.4 / CU 10.0 / FS 8.5 / SI 5.2; FF 98.1 mph ~2,435–2,490 rpm; ST 85.0 mph ~2,700 rpm. Break values estimated.',
    },
  },
  {
    id: 'skubal', name: 'Tarik Skubal', team: 'DET', throws: 'L',
    ratings: { velocity: 96, control: 95, break: 88 },
    release: { heightFt: 6.1, sideFt: 2.0, extensionFt: 6.8 },
    arsenal: [
      { code: 'FF', mph: 97.6, rpm: 2350, ivbIn: 15.0, hbArmIn: 8.0, usage: 38, activeSpin: 0.90, stuff: 91 },
      { code: 'CH', mph: 88.0, rpm: 1650, ivbIn: 5.0, hbArmIn: 16.0, usage: 26, activeSpin: 0.79, stuff: 99 },
      { code: 'SI', mph: 97.3, rpm: 2200, ivbIn: 8.0, hbArmIn: 17.0, usage: 18, activeSpin: 0.87, stuff: 86 },
      { code: 'SL', mph: 89.0, rpm: 2550, ivbIn: 3.0, hbArmIn: -3.0, usage: 13, stuff: 82 },
      { code: 'CU', mph: 80.0, rpm: 2600, ivbIn: -8.0, hbArmIn: -9.0, usage: 5, stuff: 78 },
    ],
    source: {
      season: 2025, confidence: 'medium',
      note: 'Usage FF 38.0 / CH 25.6 / SI 17.5 / SL 13.9 / CU 5.0; FF 97.6 mph, 90% active, 16.9 in total; CH 88.0 mph, 79% active, 16.7 in total; SI 97.3 mph, 87% active, 18.9 in total. Spin and the IVB/HB split estimated.',
    },
  },
];

// ---------------------------------------------------------------------------
// Roster state (frozen snapshots; overrides produce a new snapshot)
// ---------------------------------------------------------------------------

function buildRoster(batters, pitchers) {
  const withPitchNames = pitchers.map((p) => ({
    ...p,
    arsenal: p.arsenal.map((pitch) => ({ ...pitch, name: pitch.name ?? PITCH_TYPES[pitch.code]?.name ?? pitch.code })),
  }));
  return deepFreeze({ batters: structuredClone(batters), pitchers: withPitchNames });
}

const SHIPPED = buildRoster(BASE_BATTERS, BASE_PITCHERS);
let roster = SHIPPED;

export const listBatters = () => roster.batters;
export const listPitchers = () => roster.pitchers;

export function getBatter(id) {
  const b = roster.batters.find((x) => x.id === id);
  if (!b) throw new Error(`Unknown batter "${id}"`);
  return b;
}

export function getPitcher(id) {
  const p = roster.pitchers.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown pitcher "${id}"`);
  return p;
}

export function getPitch(pitcher, code) {
  const pitch = pitcher.arsenal.find((x) => x.code === code);
  if (!pitch) throw new Error(`${pitcher.id} has no pitch "${code}"`);
  return pitch;
}

/** The shipped (pre-override) version of a pitcher; Break scaling is anchored to it. */
export const shippedPitcher = (id) => SHIPPED.pitchers.find((x) => x.id === id) ?? null;

/**
 * Applies rating overrides, e.g. from a roster editor:
 *   { batters: { judge: { ratings: { vision: 95 } } }, pitchers: { skenes: { ratings: { control: 80 } } } }
 * Only `ratings` (and nested split values) may change. Validates before committing;
 * on failure the current roster is left untouched and the error is thrown.
 */
export function applyOverrides(overrides = {}) {
  const batters = structuredClone(roster.batters);
  const pitchers = structuredClone(roster.pitchers);
  const merge = (list, patch, kind) => {
    for (const [id, change] of Object.entries(patch ?? {})) {
      const target = list.find((x) => x.id === id);
      if (!target) throw new Error(`applyOverrides: unknown ${kind} "${id}"`);
      const extra = Object.keys(change).filter((k) => k !== 'ratings');
      if (extra.length) throw new Error(`applyOverrides: ${kind} "${id}" may only override ratings (got ${extra.join(', ')})`);
      target.ratings = mergeDeep(target.ratings, change.ratings ?? {});
    }
  };
  merge(batters, overrides.batters, 'batter');
  merge(pitchers, overrides.pitchers, 'pitcher');
  const next = buildRoster(batters, pitchers);
  validateRoster(next);
  roster = next;
  return roster;
}

export function resetRoster() {
  roster = SHIPPED;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const RANGES = {
  mph: [65, 105], rpm: [800, 3500], ivbIn: [-25, 25], hbArmIn: [-25, 25],
  heightIn: [64, 84], releaseHeightFt: [4.0, 7.5], releaseSideFt: [-4.0, 4.0], extensionFt: [5.0, 8.0],
  batSpeedMph: [60, 85], attackAngleDeg: [-5, 25],
};

/** Throws a readable error (with a path like `skenes.arsenal[1].rpm`) on the first problem found. */
export function validateRoster(r = roster) {
  const fail = (path, msg) => {
    throw new Error(`Roster invalid at ${path}: ${msg}`);
  };
  const rating = (path, v) => {
    if (!Number.isInteger(v) || v < 1 || v > 99) fail(path, `rating must be an integer 1–99 (got ${v})`);
  };
  const inRange = (path, v, [lo, hi]) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) fail(path, `${v} outside [${lo}, ${hi}]`);
  };

  const ids = new Set();
  const uniqueId = (id, path) => {
    if (typeof id !== 'string' || !id) fail(path, 'missing id');
    if (ids.has(id)) fail(path, `duplicate id "${id}"`);
    ids.add(id);
  };

  if (r.batters.length < 1 || r.pitchers.length < 1) fail('roster', 'needs at least one batter and one pitcher');

  for (const b of r.batters) {
    const p = b.id ?? '?';
    uniqueId(b.id, p);
    if (!['R', 'L', 'S'].includes(b.bats)) fail(`${p}.bats`, `must be R, L or S (got ${b.bats})`);
    if (!TEAMS[b.team]) fail(`${p}.team`, `unknown team ${b.team}`);
    inRange(`${p}.heightIn`, b.heightIn, RANGES.heightIn);
    for (const key of ['contact', 'power']) {
      rating(`${p}.ratings.${key}.vsL`, b.ratings[key]?.vsL);
      rating(`${p}.ratings.${key}.vsR`, b.ratings[key]?.vsR);
    }
    rating(`${p}.ratings.vision`, b.ratings.vision);
    inRange(`${p}.swing.avgBatSpeedMph`, b.swing.avgBatSpeedMph, RANGES.batSpeedMph);
    inRange(`${p}.swing.attackAngleDeg`, b.swing.attackAngleDeg, RANGES.attackAngleDeg);
  }

  for (const pt of r.pitchers) {
    const p = pt.id ?? '?';
    uniqueId(pt.id, p);
    if (!['R', 'L'].includes(pt.throws)) fail(`${p}.throws`, `must be R or L (got ${pt.throws})`);
    if (!TEAMS[pt.team]) fail(`${p}.team`, `unknown team ${pt.team}`);
    for (const key of ['velocity', 'control', 'break']) rating(`${p}.ratings.${key}`, pt.ratings[key]);
    inRange(`${p}.release.heightFt`, pt.release.heightFt, RANGES.releaseHeightFt);
    inRange(`${p}.release.sideFt`, pt.release.sideFt, RANGES.releaseSideFt);
    inRange(`${p}.release.extensionFt`, pt.release.extensionFt, RANGES.extensionFt);
    // Release side must be on the throwing-arm side (catcher view: RHP at -x, LHP at +x).
    if (Math.sign(pt.release.sideFt) !== (pt.throws === 'R' ? -1 : 1)) {
      fail(`${p}.release.sideFt`, `sign does not match throws=${pt.throws}`);
    }

    if (!Array.isArray(pt.arsenal) || pt.arsenal.length < 2 || pt.arsenal.length > 5) {
      fail(`${p}.arsenal`, 'needs 2–5 pitches (hotkeys 1–5)');
    }
    const codes = new Set();
    let usage = 0;
    const cap = fastballCapMph(pt.ratings.velocity);
    pt.arsenal.forEach((pitch, i) => {
      const pp = `${p}.arsenal[${i}]`;
      if (!PITCH_TYPES[pitch.code]) fail(`${pp}.code`, `unknown pitch code ${pitch.code}`);
      if (codes.has(pitch.code)) fail(`${pp}.code`, `duplicate pitch code ${pitch.code}`);
      codes.add(pitch.code);
      inRange(`${pp}.mph`, pitch.mph, RANGES.mph);
      inRange(`${pp}.rpm`, pitch.rpm, RANGES.rpm);
      inRange(`${pp}.ivbIn`, pitch.ivbIn, RANGES.ivbIn);
      inRange(`${pp}.hbArmIn`, pitch.hbArmIn, RANGES.hbArmIn);
      inRange(`${pp}.usage`, pitch.usage, [0, 100]);
      rating(`${pp}.stuff`, pitch.stuff);
      if (pitch.activeSpin !== undefined) inRange(`${pp}.activeSpin`, pitch.activeSpin, [0.05, 1]);
      if (pitch.gyroSign !== undefined && pitch.gyroSign !== 1 && pitch.gyroSign !== -1) {
        fail(`${pp}.gyroSign`, 'must be +1 or -1');
      }
      if (pitch.mph > cap) fail(`${pp}.mph`, `${pitch.mph} mph exceeds the velocity-rating cap ${cap.toFixed(1)} mph`);
      usage += pitch.usage;
    });
    if (Math.abs(usage - 100) > 1) fail(`${p}.arsenal`, `usage sums to ${usage}, expected 100 ± 1`);
  }

  for (const b of r.batters) {
    if (b.twoWayOf && !r.pitchers.some((x) => x.id === b.twoWayOf)) fail(`${b.id}.twoWayOf`, `no pitcher "${b.twoWayOf}"`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Matchup resolution
// ---------------------------------------------------------------------------

/** 'R' or 'L' for this plate appearance; switch-hitters bat opposite the pitcher's arm. */
export function battingSide(batter, pitcher) {
  if (batter.bats !== 'S') return batter.bats;
  return pitcher.throws === 'R' ? 'L' : 'R';
}

/** Handedness sign: +1 right, -1 left (h_b / h_p in the blueprint). */
export const handSign = (side) => (side === 'R' ? 1 : -1);

/** Ratings the batter uses against this pitcher, plus the batting-side sign h_b. */
export function ratingsVs(batter, pitcher) {
  const split = pitcher.throws === 'L' ? 'vsL' : 'vsR';
  const side = battingSide(batter, pitcher);
  return {
    contact: batter.ratings.contact[split],
    power: batter.ratings.power[split],
    vision: batter.ratings.vision,
    split,
    side,
    hb: handSign(side),
  };
}

// ---------------------------------------------------------------------------
// Rating → physics curves (docs/ARCHITECTURE.md §4.2 / §4.3)
// ---------------------------------------------------------------------------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const unit = (rating) => clamp(rating, 1, 99) / 99;

// Batter
/** Plate Coverage Indicator radius, metres (4.5–10 cm). */
export const pciRadiusM = (contact) => 0.045 + 0.055 * unit(contact);
/** Fraction of in-PCI aiming error absorbed by hand-eye correction. */
export const handEyeEta = (contact) => 0.25 + 0.45 * unit(contact);
/** Sweet-spot speed of the batter's hardest swing, mph. */
export const maxBatSpeedMph = (power) => 62 + 22 * unit(power);
/** Width of the on-screen timing window, ms. */
export const timingWindowMs = (vision) => 25 + 45 * unit(vision);
/** Width of the "perfect" band inside which timing error snaps to zero, ms. */
export const perfectBandMs = (vision) => 3 + 5 * unit(vision);
/** Distance after release at which the pitch type is revealed, ft. */
export const recognitionFt = (vision) => 20 + 25 * unit(vision);

// Pitcher
/** Maximum release speed the Velocity rating allows, mph. */
export const fastballCapMph = (velocity) => 80 + 0.22 * clamp(velocity, 1, 99);
/** Magnus/SSW multiplier k_B. */
export const breakMultiplier = (brk) => clamp(1 + 0.012 * (clamp(brk, 1, 99) - 80), 0.7, 1.3);
/** Relative pitch-to-pitch movement sigma. */
export const movementSigma = (brk) => 0.02 + 0.06 * (1 - unit(brk));
/** Half-width of the meter's green zone as a fraction of the meter span. */
export const meterGreenHalfWidth = (control) => 0.04 + 0.08 * unit(control);

/** Aim reticle: r(t) = rMin + (r0 - rMin) e^(-t/tau), inches. */
export function reticleModel(control) {
  const c = unit(control);
  const model = { r0In: 9, rMinIn: 1 + 3 * (1 - c), tauS: 0.9 - 0.55 * c };
  model.radiusAt = (tS) => model.rMinIn + (model.r0In - model.rMinIn) * Math.exp(-Math.max(0, tS) / model.tauS);
  return Object.freeze(model);
}

/**
 * Location scatter for a release. `tau` ∈ [-1, 1] is the meter timing error
 * (negative = early); `reticleIn` is the aim reticle radius at release.
 * Returns the Gaussian sigma and the deterministic bias, in inches at the plate,
 * with bias.x in world x (+ = first-base side).
 */
export function scatterModel(control, throws) {
  const c = unit(control);
  const k = 1.25 - c;
  const w = meterGreenHalfWidth(control);
  const hp = handSign(throws);
  // `effort` (meter overdrive, +1.2 mph) doubles the timing component.
  return (tau, reticleIn, { effort = false } = {}) => {
    const t = clamp(tau, -1, 1);
    const a = Math.abs(t);
    const sigmaReticle = reticleIn / 2;
    const sigmaTiming = (a <= w ? 0 : 6 * Math.pow((a - w) / 0.5, 1.5) * k) * (effort ? 2 : 1);
    const s = t < 0 ? 1 : t > 0 ? -1 : 0; // early → +1 (arm side, high), late → -1 (glove side, low)
    const mag = 2.5 * a * k * s;
    return {
      sigmaIn: Math.hypot(sigmaReticle, sigmaTiming),
      biasIn: { x: -hp * mag, y: mag },
      inGreen: a <= w,
    };
  };
}

/**
 * Break scale relative to the shipped rating: calibration reproduces the real
 * pitch at the shipped Break, so only rating changes move the movement.
 */
export function breakScale(pitcher) {
  const shipped = shippedPitcher(pitcher.id);
  const base = shipped ? shipped.ratings.break : pitcher.ratings.break;
  return breakMultiplier(pitcher.ratings.break) / breakMultiplier(base);
}

// ---------------------------------------------------------------------------
// Derived values
// ---------------------------------------------------------------------------

/** Strike zone from batter height, metres above ground. */
export function strikeZone(batter) {
  const h = batter.heightIn * IN;
  return { botM: PLATE.zoneBottomFrac * h, topM: PLATE.zoneTopFrac * h };
}

/** OVR shown on the matchup card. */
export function overall(player) {
  const r = player.ratings;
  if ('contact' in r) {
    const avg = (s) => (s.vsL + s.vsR) / 2;
    return Math.round(0.35 * avg(r.contact) + 0.4 * avg(r.power) + 0.25 * r.vision);
  }
  return Math.round(0.35 * r.velocity + 0.35 * r.control + 0.3 * r.break);
}

/** Movement relative to the league average for the pitch type, in percent (e.g. +24). */
export function pitchBreakPct(pitch) {
  const avg = LEAGUE_AVG_MOVEMENT[pitch.code];
  const mag = Math.hypot(pitch.ivbIn, pitch.hbArmIn);
  const ref = Math.hypot(avg.ivbIn, avg.hbArmIn);
  return Math.round(100 * (mag / ref - 1));
}

/** Display rows for the arsenal / scouting panel. */
export function arsenalForUI(pitcher) {
  return pitcher.arsenal.map((pitch, i) => ({
    code: pitch.code,
    name: pitch.name,
    mph: pitch.mph,
    rpm: pitch.rpm,
    breakPct: pitchBreakPct(pitch),
    usage: pitch.usage,
    stuff: pitch.stuff,
    color: PITCH_TYPES[pitch.code].color,
    family: PITCH_TYPES[pitch.code].family,
    hotkey: String(i + 1),
  }));
}

/**
 * CPU pitch-selection weights for a count, normalized to sum to 1.
 * Ahead (0-2, 1-2): breaking/offspeed ×1.4. Behind (2-0, 3-0, 3-1): fastballs ×1.5.
 */
export function pickCpuWeights(pitcher, { balls, strikes }) {
  const ahead = strikes === 2 && balls <= 1;
  const behind = (balls === 2 && strikes === 0) || (balls === 3 && strikes <= 1);
  const raw = pitcher.arsenal.map((pitch) => {
    const family = PITCH_TYPES[pitch.code].family;
    let w = pitch.usage;
    if (ahead && family !== 'FB') w *= 1.4;
    if (behind && family === 'FB') w *= 1.5;
    return w;
  });
  const total = raw.reduce((a, b) => a + b, 0);
  return pitcher.arsenal.map((pitch, i) => ({ code: pitch.code, weight: raw[i] / total }));
}

// ---------------------------------------------------------------------------
// SI conversion for the physics layer
// ---------------------------------------------------------------------------

/** Release point in world metres: x = release side, y = height, z = -(60.5 ft - extension). */
export function releasePoint(pitcher) {
  const { heightFt, sideFt, extensionFt } = pitcher.release;
  return [sideFt * FT, heightFt * FT, FIELD.rubberZ + extensionFt * FT];
}

/**
 * Pitch data in SI. Horizontal break is converted from arm-side to world x:
 * arm side is -x for a right-hander and +x for a left-hander.
 */
export function pitchSI(pitch, pitcher) {
  const hp = handSign(pitcher.throws);
  return {
    code: pitch.code,
    speedMps: pitch.mph * MPH,
    omegaRadS: pitch.rpm * RPM,
    ivbM: pitch.ivbIn * IN,
    hbWorldM: -hp * pitch.hbArmIn * IN,
    activeSpin: pitch.activeSpin ?? null,
    gyroSign: pitch.gyroSign ?? 1,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function deepFreeze(obj) {
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) deepFreeze(value);
  }
  return Object.freeze(obj);
}

function mergeDeep(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? mergeDeep(base[k] ?? {}, v) : v;
  }
  return out;
}

validateRoster(SHIPPED);
