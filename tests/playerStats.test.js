import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as PS from '../src/PlayerStats.js';
import { MPH, RPM, IN, FT } from '../src/core/units.js';
import { FIELD } from '../src/core/constants.js';

test('shipped roster validates and meets the size requirement', () => {
  assert.equal(PS.validateRoster(), true);
  const names = new Set([...PS.listBatters(), ...PS.listPitchers()].map((p) => p.name));
  assert.ok(names.size >= 6, `expected at least 6 distinct players, got ${names.size}`);
  for (const required of ['Aaron Judge', 'Shohei Ohtani', 'Juan Soto', 'Paul Skenes', 'Gerrit Cole', 'Corbin Burnes']) {
    assert.ok(names.has(required), `missing ${required}`);
  }
  assert.ok(PS.listPitchers().some((p) => p.throws === 'L'), 'need a LHP so vs-LHP splits are exercised');
});

test('roster is deeply frozen', () => {
  const skenes = PS.getPitcher('skenes');
  assert.ok(Object.isFrozen(skenes) && Object.isFrozen(skenes.arsenal[0]) && Object.isFrozen(skenes.ratings));
  assert.throws(() => { skenes.ratings.control = 1; }, TypeError);
});

test('every pitch has a name, color and family, and the splinker keeps its custom name', () => {
  for (const p of PS.listPitchers()) {
    for (const pitch of p.arsenal) {
      assert.ok(pitch.name, `${p.id} ${pitch.code} name`);
      assert.match(PS.PITCH_TYPES[pitch.code].color, /^#[0-9a-f]{6}$/);
    }
  }
  assert.equal(PS.getPitch(PS.getPitcher('skenes'), 'FS').name, 'Splinker');
});

test('getters throw on unknown ids', () => {
  assert.throws(() => PS.getBatter('nobody'), /Unknown batter/);
  assert.throws(() => PS.getPitcher('nobody'), /Unknown pitcher/);
  assert.throws(() => PS.getPitch(PS.getPitcher('cole'), 'ST'), /no pitch/);
});

test('validateRoster reports readable paths', () => {
  const bad = structuredClone({ batters: PS.listBatters(), pitchers: PS.listPitchers() });
  bad.pitchers[0].arsenal[1].rpm = 99999;
  assert.throws(() => PS.validateRoster(bad), /skenes\.arsenal\[1\]\.rpm/);

  const usage = structuredClone({ batters: PS.listBatters(), pitchers: PS.listPitchers() });
  usage.pitchers[1].arsenal[0].usage += 10;
  assert.throws(() => PS.validateRoster(usage), /cole\.arsenal: usage sums/);

  const side = structuredClone({ batters: PS.listBatters(), pitchers: PS.listPitchers() });
  side.pitchers.find((p) => p.id === 'skubal').release.sideFt = -2;
  assert.throws(() => PS.validateRoster(side), /skubal\.release\.sideFt/);

  const rating = structuredClone({ batters: PS.listBatters(), pitchers: PS.listPitchers() });
  rating.batters[0].ratings.contact.vsL = 100;
  assert.throws(() => PS.validateRoster(rating), /judge\.ratings\.contact\.vsL/);
});

test('no pitch exceeds its pitcher velocity cap', () => {
  for (const p of PS.listPitchers()) {
    const cap = PS.fastballCapMph(p.ratings.velocity);
    for (const pitch of p.arsenal) assert.ok(pitch.mph <= cap, `${p.id} ${pitch.code} ${pitch.mph} > ${cap}`);
  }
});

test('switch-hitters bat opposite the pitcher arm; splits follow pitcher hand', () => {
  const raleigh = PS.getBatter('raleigh');
  const skubal = PS.getPitcher('skubal');
  const cole = PS.getPitcher('cole');
  assert.equal(PS.battingSide(raleigh, skubal), 'R');
  assert.equal(PS.battingSide(raleigh, cole), 'L');

  const vsL = PS.ratingsVs(raleigh, skubal);
  assert.equal(vsL.split, 'vsL');
  assert.equal(vsL.contact, raleigh.ratings.contact.vsL);
  assert.equal(vsL.hb, 1);
  const vsR = PS.ratingsVs(PS.getBatter('soto'), cole);
  assert.equal(vsR.power, 92);
  assert.equal(vsR.hb, -1);
});

const monotone = (fn, increasing = true) => {
  let prev = fn(1);
  for (let r = 2; r <= 99; r++) {
    const v = fn(r);
    if (increasing) assert.ok(v >= prev, `not increasing at ${r}`);
    else assert.ok(v <= prev, `not decreasing at ${r}`);
    prev = v;
  }
};

test('rating curves are monotone with the documented end points', () => {
  monotone(PS.pciRadiusM);
  monotone(PS.handEyeEta);
  monotone(PS.maxBatSpeedMph);
  monotone(PS.timingWindowMs);
  monotone(PS.perfectBandMs);
  monotone(PS.recognitionFt, false);
  monotone(PS.fastballCapMph);
  monotone(PS.breakMultiplier);
  monotone(PS.meterGreenHalfWidth);
  monotone(PS.movementSigma, false);
  monotone((c) => PS.reticleModel(c).rMinIn, false);
  monotone((c) => PS.reticleModel(c).tauS, false);

  assert.ok(Math.abs(PS.pciRadiusM(99) - 0.10) < 1e-12);
  assert.ok(Math.abs(PS.maxBatSpeedMph(99) - 84) < 1e-12);
  assert.ok(Math.abs(PS.fastballCapMph(98) - 101.56) < 1e-9);
  assert.equal(PS.breakMultiplier(80), 1);
  assert.equal(PS.breakMultiplier(1), 0.7);
  assert.ok(PS.breakMultiplier(99) > 1.2 && PS.breakMultiplier(99) <= 1.3);
  // Out-of-range inputs are clamped rather than extrapolated.
  assert.equal(PS.pciRadiusM(500), PS.pciRadiusM(99));
});

test('reticle shrinks from r0 toward rMin', () => {
  const m = PS.reticleModel(90);
  assert.equal(m.radiusAt(0), m.r0In);
  assert.ok(m.radiusAt(0.5) < m.r0In && m.radiusAt(0.5) > m.rMinIn);
  assert.ok(Math.abs(m.radiusAt(60) - m.rMinIn) < 1e-9);
});

test('scatter: perfect release is reticle-only; early sails arm-side high, late yanks glove-side low', () => {
  const rhp = PS.scatterModel(90, 'R');
  const perfect = rhp(0, 2);
  assert.equal(perfect.sigmaIn, 1);
  assert.deepEqual(perfect.biasIn, { x: -0, y: 0 });
  assert.ok(perfect.inGreen);

  const early = rhp(-0.6, 2);
  assert.ok(early.biasIn.x < 0 && early.biasIn.y > 0, 'RHP early → -x (arm side) and high');
  assert.ok(early.sigmaIn > perfect.sigmaIn);
  const late = rhp(0.6, 2);
  assert.ok(late.biasIn.x > 0 && late.biasIn.y < 0, 'RHP late → +x (glove side) and low');

  const lhpEarly = PS.scatterModel(90, 'L')(-0.6, 2);
  assert.ok(lhpEarly.biasIn.x > 0, 'LHP arm side is +x');

  // Worse control → bigger miss for the same timing error.
  assert.ok(PS.scatterModel(40, 'R')(0.6, 2).sigmaIn > late.sigmaIn);
});

test('breakScale is 1 at shipped ratings and moves with overrides', () => {
  try {
    assert.equal(PS.breakScale(PS.getPitcher('burnes')), 1);
    PS.applyOverrides({ pitchers: { burnes: { ratings: { break: 76 } } } });
    const s = PS.breakScale(PS.getPitcher('burnes'));
    assert.ok(Math.abs(s - PS.breakMultiplier(76) / PS.breakMultiplier(96)) < 1e-12);
    assert.ok(s < 1);
  } finally {
    PS.resetRoster();
  }
});

test('applyOverrides merges ratings, rejects bad input atomically', () => {
  try {
    PS.applyOverrides({ batters: { judge: { ratings: { contact: { vsR: 70 } } } } });
    const judge = PS.getBatter('judge');
    assert.equal(judge.ratings.contact.vsR, 70);
    assert.equal(judge.ratings.contact.vsL, 86, 'sibling split preserved');

    assert.throws(() => PS.applyOverrides({ batters: { judge: { ratings: { vision: 0 } } } }), /judge\.ratings\.vision/);
    assert.equal(PS.getBatter('judge').ratings.vision, 93, 'failed override leaves roster untouched');
    assert.throws(() => PS.applyOverrides({ pitchers: { cole: { team: 'LAD' } } }), /may only override ratings/);
    assert.throws(() => PS.applyOverrides({ pitchers: { ghost: { ratings: {} } } }), /unknown pitcher/);
  } finally {
    PS.resetRoster();
  }
  assert.equal(PS.getBatter('judge').ratings.contact.vsR, 84);
});

test('strike zone and OVR are sane', () => {
  const zone = PS.strikeZone(PS.getBatter('judge'));
  assert.ok(zone.botM > 1.6 * FT && zone.botM < 2.0 * FT, `bot ${zone.botM}`);
  assert.ok(zone.topM > 3.3 * FT && zone.topM < 3.8 * FT, `top ${zone.topM}`);
  for (const p of [...PS.listBatters(), ...PS.listPitchers()]) {
    const o = PS.overall(p);
    assert.ok(Number.isInteger(o) && o >= 1 && o <= 99, `${p.id} OVR ${o}`);
  }
});

test('break % and arsenal rows', () => {
  const avgFF = { code: 'FF', ...PS.LEAGUE_AVG_MOVEMENT.FF };
  assert.equal(PS.pitchBreakPct(avgFF), 0);
  const rows = PS.arsenalForUI(PS.getPitcher('skubal'));
  assert.deepEqual(rows.map((r) => r.hotkey), ['1', '2', '3', '4', '5']);
  assert.ok(rows.find((r) => r.code === 'CH').breakPct > 0, 'Skubal CH moves more than league average');
});

test('CPU weights normalize and shift with the count', () => {
  const skenes = PS.getPitcher('skenes');
  const sum = (ws) => ws.reduce((a, w) => a + w.weight, 0);
  const share = (ws, family) => ws.filter((w) => PS.PITCH_TYPES[w.code].family === family).reduce((a, w) => a + w.weight, 0);

  const even = PS.pickCpuWeights(skenes, { balls: 1, strikes: 1 });
  const ahead = PS.pickCpuWeights(skenes, { balls: 0, strikes: 2 });
  const behind = PS.pickCpuWeights(skenes, { balls: 3, strikes: 1 });
  for (const ws of [even, ahead, behind]) assert.ok(Math.abs(sum(ws) - 1) < 1e-12);
  assert.ok(share(ahead, 'FB') < share(even, 'FB'));
  assert.ok(share(behind, 'FB') > share(even, 'FB'));
});

test('SI conversion: release point and arm-side → world x', () => {
  const skubal = PS.getPitcher('skubal');
  const [x, y, z] = PS.releasePoint(skubal);
  assert.ok(x > 0, 'LHP releases from the first-base side');
  assert.ok(Math.abs(y - 6.1 * FT) < 1e-12);
  assert.ok(Math.abs(z - (FIELD.rubberZ + 6.8 * FT)) < 1e-12);

  const ch = PS.pitchSI(PS.getPitch(skubal, 'CH'), skubal);
  assert.ok(ch.hbWorldM > 0, 'LHP arm-side run is +x');
  assert.ok(Math.abs(ch.speedMps - 88 * MPH) < 1e-12);
  assert.ok(Math.abs(ch.omegaRadS - 1650 * RPM) < 1e-12);
  assert.equal(ch.activeSpin, 0.79);

  const cole = PS.getPitcher('cole');
  const ff = PS.pitchSI(PS.getPitch(cole, 'FF'), cole);
  assert.ok(Math.abs(ff.hbWorldM - -6.6 * IN) < 1e-12, 'RHP arm-side run is -x');
});
