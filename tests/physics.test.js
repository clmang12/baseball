import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as PE from '../src/PhysicsEngine.js';
import * as PS from '../src/PlayerStats.js';
import { Rng } from '../src/core/rng.js';
import { MPH, RPM, IN, FT, DEG } from '../src/core/units.js';
import { BALL, PLATE, SWING, aeroK } from '../src/core/constants.js';

// Sea level, 15 °C, dry: ρ = 1.225, the conditions the blueprint benchmarks assume.
const SEA = PE.createEnvironment({ tempC: 15, humidity: 0 });
const within = (actual, expected, tol, label = '') =>
  assert.ok(Math.abs(actual - expected) <= tol, `${label} ${actual} not within ${tol} of ${expected}`);

test('environment: standard density and altitude effect', () => {
  within(SEA.rho, 1.225, 0.001, 'rho');
  within(SEA.K, aeroK(SEA.rho), 1e-12, 'K');
  within(SEA.K, 0.01802, 1e-5, 'K value');
  const coors = PE.createEnvironment({ altitudeM: 1580, tempC: 15, humidity: 0 });
  within(coors.rho / SEA.rho, 0.83, 0.02, 'Coors density ratio');
});

test('spin vector construction (§2.4)', () => {
  const f = [0, 0, 1];
  const w = PE.spinVector(100, 1, 0, 1, f);
  within(w[0], -100, 1e-9, 'pure backspin is -x for a ball moving +z');
  within(Math.hypot(...w), 100, 1e-9);
  const g = PE.spinVector(100, 0.6, 0.3, 1, f);
  within(Math.hypot(...g), 100, 1e-9, '|ω| preserved');
  within(g[2], 80, 1e-9, 'gyro component sqrt(1-ε²)Ω along flight');
  // Magnus direction: ω⊥ × f̂ points along (sin β, cos β).
  const t = PE.spinVector(1, 1, 0.7, 1, f);
  const m = [t[1] * f[2] - t[2] * f[1], t[2] * f[0] - t[0] * f[2]];
  within(m[0], Math.sin(0.7), 1e-12);
  within(m[1], Math.cos(0.7), 1e-12);
  within(PE.savantAxisToTilt(210) / DEG, -30, 1e-9, 'Savant 210° → β = -30°');
  assert.deepEqual(PE.statcastToWorld([1, 2, 3]), [1, 3, -2]);
});

test('spinless 95 mph pitch: plate speed and flight time', () => {
  const p0 = [-1.8 * FT, 6 * FT, -54 * FT];
  const params = PE.flightParams(SEA, { kM: 0 });
  const r = PE.solveRelease({ p0, speed: 95 * MPH, spin: { omega: 0, eps: 1, beta: 0, gyroSign: 1 }, params, target: { x: 0, y: 2.5 * FT } });
  const cross = PE.plateCrossing(r.traj);
  within(cross.speed / MPH, 87.6, 0.3, 'plate speed');
  within(cross.t, 0.395, 0.01, 'flight time');
});

test('release solver hits targets to < 1 mm in ≤ 5 iterations', () => {
  const skubal = PS.getPitcher('skubal');
  for (const code of ['FF', 'CH', 'CU']) {
    for (const target of [{ x: 0, y: 0.75 }, { x: 0.25, y: 0.5 }, { x: -0.3, y: 1.1 }]) {
      const pitch = PE.throwPitch({ pitcher: skubal, pitchCode: code, target });
      const cross = pitch.crossing;
      assert.ok(Math.hypot(cross.x - target.x, cross.y - target.y) < 1e-3, `${code} → ${JSON.stringify(target)}`);
    }
  }
  const p = PS.getPitcher('skenes');
  const cal = PE.calibratePitch(p, PS.getPitch(p, 'FF'));
  const r = PE.solveRelease({
    p0: PS.releasePoint(p), speed: 98 * MPH,
    spin: { omega: 2170 * RPM, eps: cal.eps, beta: cal.beta, gyroSign: 1 },
    params: PE.flightParams(PE.STANDARD_ENV, { kM: cal.cPitch }), target: { x: 0.2, y: 0.6 },
  });
  assert.ok(r.iterations <= 5 && r.residual < 1e-3, `iterations ${r.iterations}, residual ${r.residual}`);
});

test('calibration reproduces every roster pitch within 0.5 in', () => {
  for (const pitcher of PS.listPitchers()) {
    for (const pitch of pitcher.arsenal) {
      const cal = PE.calibratePitch(pitcher, pitch);
      assert.ok(cal.residualIn < 0.5, `${pitcher.id} ${pitch.code} residual ${cal.residualIn}`);
      assert.ok(cal.eps > 0 && cal.eps <= 1, `${pitcher.id} ${pitch.code} eps ${cal.eps}`);
      // A thrown pitch (no variance) shows the published movement.
      const thrown = PE.throwPitch({ pitcher, pitchCode: pitch.code, target: { x: 0, y: 0.76 } });
      within(thrown.metrics.ivbIn, pitch.ivbIn, 0.5, `${pitcher.id} ${pitch.code} IVB`);
      within(thrown.metrics.hbArmIn, pitch.hbArmIn, 0.5, `${pitcher.id} ${pitch.code} HB`);
      within(thrown.metrics.releaseMph, pitch.mph, 1e-9);
      within(thrown.metrics.rpm, pitch.rpm, 1e-6);
    }
  }
});

test('published active spin is respected; low-spin movement falls to seam-shifted wake', () => {
  const skubal = PS.getPitcher('skubal');
  const ch = PE.calibratePitch(skubal, PS.getPitch(skubal, 'CH'));
  assert.equal(ch.eps, 0.79);
  const cole = PS.getPitcher('cole');
  assert.equal(PE.calibratePitch(cole, PS.getPitch(cole, 'SL')).eps, 0.28);
});

test('Break rating scales movement relative to the shipped rating', () => {
  const target = { x: 0, y: 0.76 };
  const base = PE.throwPitch({ pitcher: PS.getPitcher('burnes'), pitchCode: 'CU', target });
  try {
    PS.applyOverrides({ pitchers: { burnes: { ratings: { break: 60 } } } });
    const weak = PE.throwPitch({ pitcher: PS.getPitcher('burnes'), pitchCode: 'CU', target });
    const mag = (m) => Math.hypot(m.ivbIn, m.hbArmIn);
    assert.ok(mag(weak.metrics) < 0.8 * mag(base.metrics), `${mag(weak.metrics)} vs ${mag(base.metrics)}`);
  } finally {
    PS.resetRoster();
  }
});

test('velocity cap, effort and determinism', () => {
  const skenes = PS.getPitcher('skenes');
  const cap = PS.fastballCapMph(skenes.ratings.velocity);
  const hard = PE.throwPitch({ pitcher: skenes, pitchCode: 'FF', target: { x: 0, y: 0.8 }, meter: { tau: 0, reticleIn: 1, effort: true } });
  within(hard.metrics.releaseMph, Math.min(cap, 98.2 + 1.2), 1e-9);

  const throwSeeded = (seed) => PE.throwPitch({ pitcher: skenes, pitchCode: 'ST', target: { x: 0.1, y: 0.7 }, meter: { tau: 0.4, reticleIn: 2 }, rng: new Rng(seed) });
  const a = throwSeeded(5), b = throwSeeded(5), c = throwSeeded(6);
  assert.deepEqual([a.crossing.x, a.crossing.y, a.metrics.releaseMph], [b.crossing.x, b.crossing.y, b.metrics.releaseMph]);
  assert.notEqual(a.crossing.x, c.crossing.x);
  assert.ok(a.aim.sigmaIn > 0);
});

test('pitch in the dirt bounces and still reaches the catcher', () => {
  const pitch = PE.throwPitch({ pitcher: PS.getPitcher('cole'), pitchCode: 'KC', target: { x: 0, y: 0.02 } });
  assert.ok(pitch.traj.events.some((e) => e.type === 'bounce'), 'bounce event');
  assert.ok(pitch.traj.last()[2] > 0.5, 'continues past the plate');
});

test('strike zone edges include any part of the ball', () => {
  const zone = { botM: 0.5, topM: 1.05 };
  const at = (x, y) => PE.isStrike({ x, y }, zone);
  assert.ok(at(0, 0.8));
  assert.ok(at(PLATE.halfWidth + BALL.radius - 1e-6, 0.8));
  assert.ok(!at(PLATE.halfWidth + BALL.radius + 1e-6, 0.8));
  assert.ok(at(0, zone.botM - BALL.radius + 1e-6));
  assert.ok(!at(0, zone.topM + BALL.radius + 1e-6));
  assert.ok(!PE.isStrike(null, zone));
});

test('trajectory sampling: exact at samples, Hermite between, accurate crossings', () => {
  const pitch = PE.throwPitch({ pitcher: PS.getPitcher('cole'), pitchCode: 'FF', target: { x: 0, y: 0.8 } });
  const tr = pitch.traj;
  const i = 200;
  const s = tr.sampleAt(tr.t[i]);
  const stored = tr.state(i);
  for (let k = 0; k < 9; k++) within(s[k], stored[k], 1e-12);
  const tc = tr.crossingTime(2, PLATE.frontZ, 1);
  within(tr.sampleAt(tc)[2], PLATE.frontZ, 1e-9, 'crossing z');
  // Midpoint Hermite position close to a re-integration from the earlier sample.
  const mid = 0.5 * (tr.t[i] + tr.t[i + 1]);
  const Xi = tr.state(i);
  PE.rk4Step(Xi, mid - tr.t[i], pitch.params);
  within(tr.sampleAt(mid)[0], Xi[0], 1e-7);
  within(tr.sampleAt(mid)[1], Xi[1], 1e-7);
});

// --- batted-ball benchmarks -------------------------------------------------

const launch = (evMph, laDeg, backspinRpm, sprayDeg = 0) => {
  const la = laDeg * DEG, sp = sprayDeg * DEG;
  const v = [Math.sin(sp) * Math.cos(la), Math.sin(la), -Math.cos(sp) * Math.cos(la)].map((c) => c * evMph * MPH);
  // Backspin axis: horizontal, perpendicular to the spray direction (right-hand rule gives lift).
  const w = [Math.cos(sp) * backspinRpm * RPM, 0, Math.sin(sp) * backspinRpm * RPM];
  return { p: [0, 0.9, 0], v, w, t: 0 };
};

test('batted-ball distance benchmarks (sea level)', () => {
  const a = PE.simulateBattedBall(launch(100, 28, 2000), SEA);
  within(a.projectedDistFt, 392, 12, '100 mph / 28° / 2000 rpm');
  within(a.hangS, 4.9, 0.3, 'hang time');
  const b = PE.simulateBattedBall(launch(110, 28, 2500), SEA);
  within(b.projectedDistFt, 435, 12, '110 mph / 28° / 2500 rpm');
  assert.ok(b.apexFt > a.apexFt);
});

test('carry matches Statcast distance references (standard conditions)', () => {
  // Typical projected distances for (EV mph, LA °) → ft; spin follows 1200 + 45·LA rpm.
  const refs = [[90, 30, 330], [95, 30, 365], [100, 28, 398], [105, 28, 422], [110, 28, 448], [100, 20, 370], [95, 15, 300]];
  let se = 0;
  for (const [ev, la, ref] of refs) {
    const d = PE.simulateBattedBall(launch(ev, la, 1200 + 45 * la)).projectedDistFt;
    within(d, ref, 20, `${ev} mph / ${la}°`);
    se += (d - ref) ** 2;
  }
  assert.ok(Math.sqrt(se / refs.length) < 10, 'RMS error under 10 ft');
});

test('altitude carries the ball farther', () => {
  const coors = PE.createEnvironment({ altitudeM: 1580, tempC: 15, humidity: 0 });
  const sea = PE.simulateBattedBall(launch(103, 28, 2200), SEA);
  const high = PE.simulateBattedBall(launch(103, 28, 2200), coors);
  assert.ok(high.projectedDistFt > sea.projectedDistFt * 1.05, `${high.projectedDistFt} vs ${sea.projectedDistFt}`);
});

// --- collision ---------------------------------------------------------------

// The prototype geometry used for the §2.10 table: 86 mph pitch, 75 mph bat with
// an 8° attack angle, bat axis along +x, approach along the relative velocity.
function prototypeCollision(D, e = 0.46) {
  const vDir = [0, -0.6, 1].map((c) => c / Math.hypot(0, -0.6, 1));
  const v = vDir.map((c) => c * 86 * MPH);
  const w = [-2300 * RPM, 0, 0];
  const att = 8 * DEG;
  const batVelocity = [0, Math.sin(att), -Math.cos(att)].map((c) => c * 75 * MPH);
  const aHat = [1, 0, 0];
  const u = v.map((c, i) => c - batVelocity[i]);
  const uPerp = [0, u[1], u[2]];
  const n = Math.hypot(...uPerp);
  const uh = uPerp.map((c) => c / n);
  let eD = [0, 1, 0].map((c, i) => c - uh[1] * uh[i]);
  const m = Math.hypot(...eD);
  eD = eD.map((c) => c / m);
  const R = BALL.radius + 0.033;
  const root = Math.sqrt(R * R - D * D);
  const nHat = uh.map((c, i) => (-root * c + D * eD[i]) / R);
  const out = PE.impulseCollision({ v, w, batVelocity, aHat, nHat, e, Me: PE.effectiveMass(0.70) });
  const ev = Math.hypot(...out.v);
  return { ...out, v0: v, w0: w, batVelocity, evMph: ev / MPH, laDeg: Math.asin(out.v[1] / ev) / DEG };
}

test('head-on sweet-spot collision gives ~108 mph EV', () => {
  within(PE.effectiveMass(0.70), 0.687, 0.002, 'effective mass');
  within(prototypeCollision(0).evMph, 107.9, 1, 'EV');
});

test('launch angle rises monotonically with undercut', () => {
  let prev = -Infinity;
  for (let Dmm = -15; Dmm <= 35; Dmm += 5) {
    const la = prototypeCollision(Dmm / 1000).laDeg;
    assert.ok(la > prev, `LA not increasing at D=${Dmm} mm`);
    prev = la;
  }
  // Undercut produces backspin (+x spin for a ball heading to -z), overcut topspin.
  assert.ok(prototypeCollision(0.02).w[0] > 0);
  assert.ok(prototypeCollision(-0.02).w[0] < 0);
});

test('collision never adds kinetic energy in the bat frame', () => {
  const I = BALL.inertiaFactor * BALL.mass * BALL.radius ** 2;
  const ke = (v, w, vb) => 0.5 * BALL.mass * ((v[0] - vb[0]) ** 2 + (v[1] - vb[1]) ** 2 + (v[2] - vb[2]) ** 2) + 0.5 * I * (w[0] ** 2 + w[1] ** 2 + w[2] ** 2);
  for (let Dmm = -60; Dmm <= 60; Dmm += 4) {
    for (const e of [0.1, 0.3, 0.46]) {
      const c = prototypeCollision(Dmm / 1000, e);
      assert.ok(ke(c.v, c.w, c.batVelocity) <= ke(c.v0, c.w0, c.batVelocity) + 1e-9, `D=${Dmm} e=${e}`);
    }
  }
});

test('COR falls off away from the sweet spot', () => {
  assert.equal(PE.corAt(0), 0.46);
  within(PE.corAt(0.15), 0.3475, 1e-12);
  assert.equal(PE.corAt(1), 0.10);
});

// --- swing → contact pipeline ----------------------------------------------

function atBat({ pitcher, batter, code = 'FF', target = { x: 0, y: 0.8 }, dtMs = 0, dy = 0, dx = 0, charge = 0, contact }) {
  const pitch = PE.throwPitch({ pitcher, pitchCode: code, target });
  const ratings = PS.ratingsVs(batter, pitcher);
  if (contact !== undefined) ratings.contact = contact;
  const tStar = pitch.traj.crossingTime(2, SWING.idealContactZ, 1);
  const ball = pitch.traj.sampleAt(tStar);
  const swing = PE.createSwing({
    ratings, attackAngleDeg: batter.swing.attackAngleDeg,
    pci: { x: ball[0] + dx, y: ball[1] + dy }, tStart: tStar - 0.150 + dtMs / 1000,
    pitchTraj: pitch.traj, charge,
  });
  const contactRes = PE.findContact(pitch.traj, swing);
  const collision = contactRes.kind === 'contact' ? PE.resolveCollision(contactRes) : null;
  return { pitch, swing, contact: contactRes, collision };
}

test('squared-up perfect timing: hard contact up the middle', () => {
  const { contact, collision, swing } = atBat({ pitcher: PS.getPitcher('cole'), batter: PS.getBatter('judge') });
  assert.equal(contact.kind, 'contact');
  within(contact.d, 0, 0.01, 'sweet spot');
  assert.ok(collision.evMph > 100 && collision.evMph < 120, `EV ${collision.evMph}`);
  assert.ok(Math.abs(collision.sprayDeg) < 15, `spray ${collision.sprayDeg}`);
  assert.equal(swing.meta.dtMs, 0);
  assert.ok(collision.sweetSpotPct > 95);
});

test('timing controls spray: early pulls, late goes the other way (both hands)', () => {
  const cole = PS.getPitcher('cole');
  const rhb = PS.getBatter('judge');
  const lhb = PS.getBatter('soto');
  const early = atBat({ pitcher: cole, batter: rhb, dtMs: -12 }).collision;
  const late = atBat({ pitcher: cole, batter: rhb, dtMs: 12 }).collision;
  assert.ok(early.sprayDeg < -5, `RHB early spray ${early.sprayDeg}`);
  assert.ok(late.sprayDeg > 5, `RHB late spray ${late.sprayDeg}`);
  const lEarly = atBat({ pitcher: cole, batter: lhb, dtMs: -12 }).collision;
  const lLate = atBat({ pitcher: cole, batter: lhb, dtMs: 12 }).collision;
  assert.ok(lEarly.sprayDeg > 5, `LHB early spray ${lEarly.sprayDeg}`);
  assert.ok(lLate.sprayDeg < -5, `LHB late spray ${lLate.sprayDeg}`);
});

test('PCI height controls launch angle; big misses whiff', () => {
  const args = { pitcher: PS.getPitcher('cole'), batter: PS.getBatter('judge'), contact: 1 };
  const under = atBat({ ...args, dy: -0.03 }).collision; // bat below the ball
  const over = atBat({ ...args, dy: 0.03 }).collision;
  assert.ok(under.laDeg > 15 && over.laDeg < -5, `under ${under.laDeg}, over ${over.laDeg}`);
  assert.equal(atBat({ ...args, dy: -0.2 }).contact.kind, 'whiff');
  assert.equal(atBat({ ...args, dtMs: 80 }).contact.kind, 'whiff');
});

test('higher Contact absorbs more PCI error (hand-eye correction)', () => {
  const args = { pitcher: PS.getPitcher('cole'), batter: PS.getBatter('judge'), dy: -0.04 };
  const low = atBat({ ...args, contact: 1 });
  const high = atBat({ ...args, contact: 99 });
  assert.ok(Math.abs(high.contact.D) < Math.abs(low.contact.D), `${high.contact.D} vs ${low.contact.D}`);
  assert.ok(high.swing.meta.inPci && low.swing.meta.inPci);
});

test('power swing is faster but shrinks the PCI', () => {
  const args = { pitcher: PS.getPitcher('cole'), batter: PS.getBatter('judge') };
  const normal = atBat(args);
  const power = atBat({ ...args, charge: 1 });
  assert.ok(power.collision.evMph > normal.collision.evMph);
  within(power.swing.meta.rPci, normal.swing.meta.rPci * 0.8, 1e-12);
});

test('mirror symmetry: LHB vs mirrored LHP mirrors RHB vs RHP exactly', () => {
  const cole = PS.getPitcher('cole');
  const mirrorPitcher = {
    ...cole, id: 'coleMirror', throws: 'L',
    release: { ...cole.release, sideFt: -cole.release.sideFt },
    arsenal: cole.arsenal.map((p) => ({ ...p, gyroSign: -(p.gyroSign ?? 1) })),
  };
  const judge = PS.getBatter('judge');
  const target = { x: 0.08, y: 0.85 };
  const run = (pitcher, hb, sideTarget) => {
    const pitch = PE.throwPitch({ pitcher, pitchCode: 'SL', target: sideTarget });
    const tStar = pitch.traj.crossingTime(2, SWING.idealContactZ, 1);
    const ball = pitch.traj.sampleAt(tStar);
    const swing = PE.createSwing({
      ratings: { contact: 80, power: 95, vision: 90, hb }, attackAngleDeg: judge.swing.attackAngleDeg,
      pci: { x: ball[0] + 0.01 * hb, y: ball[1] - 0.012 }, tStart: tStar - 0.150 - 0.006, pitchTraj: pitch.traj,
    });
    return { pitch, col: PE.resolveCollision(PE.findContact(pitch.traj, swing)) };
  };
  const r = run(cole, 1, target);
  const l = run(mirrorPitcher, -1, { x: -target.x, y: target.y });
  within(l.pitch.crossing.x, -r.pitch.crossing.x, 1e-9, 'pitch x mirrored');
  within(l.pitch.crossing.y, r.pitch.crossing.y, 1e-9, 'pitch y equal');
  within(l.col.evMph, r.col.evMph, 1e-6, 'EV');
  within(l.col.laDeg, r.col.laDeg, 1e-6, 'LA');
  within(l.col.sprayDeg, -r.col.sprayDeg, 1e-6, 'spray mirrored');
  within(l.col.spinRpm, r.col.spinRpm, 1e-3, 'spin');
});

// --- outcomes and Statcast -------------------------------------------------

test('outcomes: home run, pop-up, grounder, foul', () => {
  const hr = PE.simulateBattedBall(launch(110, 28, 2500));
  assert.ok(hr.isHR && hr.wall.type === 'HR');
  assert.equal(PE.classifyOutcome(hr).result, 'HR');

  const pop = PE.classifyOutcome(PE.simulateBattedBall(launch(75, 70, 4000, 5)));
  assert.equal(pop.result, 'OUT_FLY');

  const weakGrounder = PE.classifyOutcome(PE.simulateBattedBall(launch(65, -8, 1500, -17)));
  assert.equal(weakGrounder.result, 'OUT_GROUND');
  assert.equal(weakGrounder.fielder, 'SS');

  assert.equal(PE.classifyOutcome(PE.simulateBattedBall(launch(95, 20, 2000, 60))).result, 'FOUL');

  // A deep gap shot that doesn't leave the yard goes for extra bases.
  const gap = PE.classifyOutcome(PE.simulateBattedBall(launch(100, 17, 1800, -13)), 'L');
  assert.ok(['2B', '3B'].includes(gap.result), gap.result);
  // A routine fly to center is caught.
  assert.equal(PE.classifyOutcome(PE.simulateBattedBall(launch(90, 25, 2200, 0))).result, 'OUT_FLY');
});

test('ground balls come to rest and report a first bounce', () => {
  const b = PE.simulateBattedBall(launch(90, -5, 1000, 10));
  assert.ok(b.firstGround && b.rest.t > b.firstGround.t);
  const last = b.traj.last();
  within(Math.hypot(last[3], last[5]), 0, 0.06, 'at rest');
});

test('barrel definition and xBA model', () => {
  assert.ok(PE.isBarrel(98, 28));
  assert.ok(!PE.isBarrel(97.9, 28));
  assert.ok(!PE.isBarrel(98, 31));
  assert.ok(PE.isBarrel(100, 24) && PE.isBarrel(100, 33) && !PE.isBarrel(100, 34));
  assert.ok(PE.isBarrel(116, 8) && PE.isBarrel(116, 50));
  for (let ev = 60; ev <= 120; ev += 5) {
    for (let la = -40; la <= 70; la += 5) {
      const x = PE.xBA(ev, la);
      assert.ok(x >= 0 && x <= 1, `xBA ${ev}/${la} = ${x}`);
    }
  }
  assert.ok(PE.xBA(108, 28) > 0.75 && PE.xBA(85, 30) < 0.2);
});

test('statcast payload has the five headline metrics', () => {
  const { pitch, swing, collision } = atBat({ pitcher: PS.getPitcher('skenes'), batter: PS.getBatter('ohtani'), dy: -0.02 });
  const batted = PE.simulateBattedBall(collision);
  const outcome = PE.classifyOutcome(batted, 'L');
  const p = PE.statcastMetrics(pitch, swing, collision, batted, outcome);
  for (const v of [p.pitch.releaseMph, p.pitch.rpm, p.contact.evMph, p.contact.laDeg, p.batted.projDistFt]) {
    assert.ok(Number.isFinite(v));
  }
  assert.equal(p.swing.timing, 'PERFECT');
  assert.equal(p.batted.outcome, outcome.result);
  assert.ok(p.pitch.cross && Number.isFinite(p.pitch.cross.xIn));
  const take = PE.statcastMetrics(pitch);
  assert.equal(take.contact, undefined);
  within(IN, 0.0254, 0);
});
