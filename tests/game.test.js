import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameLoop, meterToTau, METER, _internal } from '../src/GameLoop.js';
import * as AI from '../src/AIController.js';
import * as PS from '../src/PlayerStats.js';
import * as PE from '../src/PhysicsEngine.js';
import { Rng } from '../src/core/rng.js';

test('meter mapping: green centre, early/late sign, effort zone, timeout', () => {
  assert.deepEqual(meterToTau(METER.center), { tau: 0, effort: false });
  assert.ok(meterToTau(0.4).tau < 0 && meterToTau(0.85).tau > 0);
  assert.equal(meterToTau(0).tau, -1);
  const effort = meterToTau(0.95);
  assert.ok(effort.effort && Math.abs(effort.tau) < 1e-12);
  assert.deepEqual(meterToTau(1), { tau: 1, effort: false });
  assert.equal(_internal.meterGrade(0.01, 0.1, false), 'PERFECT');
  assert.equal(_internal.meterGrade(-0.2, 0.1, false), 'EARLY');
  assert.equal(_internal.meterGrade(0.9, 0.1, false), 'WAY LATE');
});

test('CPU batter: perception blends naive and true paths by vision', () => {
  const ohtani = PS.getPitcher('ohtaniP');
  const pitch = PE.throwPitch({ pitcher: ohtani, pitchCode: 'ST', target: { x: 0.2, y: 0.7 } });
  const good = AI.perceivePitch(pitch, PS.getBatter('soto'), ohtani);     // vision 99
  const weak = AI.perceivePitch(pitch, PS.getBatter('raleigh'), ohtani);  // vision 80
  const err = (p) => Math.hypot(p.x - p.truth.x, p.y - p.truth.y);
  assert.ok(err(good) < err(weak), `${err(good)} vs ${err(weak)}`);
  assert.ok(Math.hypot(good.naive.x - good.truth.x, good.naive.y - good.truth.y) > 0.1, 'sweeper breaks well away from its spinless path');
});

test('CPU batter swings at strikes more than chases, and protects with two strikes', () => {
  const zone = { botM: 0.5, topM: 1.05 };
  assert.equal(AI.zoneDistance({ x: 0, y: 0.8 }, zone), 0);
  assert.ok(AI.zoneDistance({ x: 0.5, y: 0.8 }, zone) > 0.2);
  const inZone = AI.swingProbability(0, { balls: 1, strikes: 1 }, 90);
  const chase = AI.swingProbability(0.1, { balls: 1, strikes: 1 }, 90);
  assert.ok(inZone > 0.6 && chase < 0.15);
  assert.ok(AI.swingProbability(0.1, { balls: 1, strikes: 2 }, 90) > chase);
  assert.ok(AI.swingProbability(0, { balls: 3, strikes: 0 }, 90) < 0.3, '3-0 take');
  assert.ok(AI.swingProbability(0.1, { balls: 1, strikes: 1 }, 99) < AI.swingProbability(0.1, { balls: 1, strikes: 1 }, 60), 'vision lowers chase');
});

test('CPU batter is early on a changeup after a fastball', () => {
  const skubal = PS.getPitcher('skubal');
  const ff = PE.throwPitch({ pitcher: skubal, pitchCode: 'FF', target: { x: 0, y: 0.8 } });
  const ch = PE.throwPitch({ pitcher: skubal, pitchCode: 'CH', target: { x: 0, y: 0.8 } });
  const d = AI.decideSwing({ pitch: ch, batter: PS.getBatter('judge'), pitcher: skubal, count: { balls: 0, strikes: 1 }, prevPitch: ff });
  assert.ok(d.debug.dtMs < -5, `dt ${d.debug.dtMs}`);
});

function autoPitcher(loop, rng) {
  // Drives the user side: aim somewhere near the zone, lock, then stop the meter.
  const snap = loop.snapshot();
  if (snap.phase === 'aim' && loop._since() > 0.3) {
    loop.handle({ type: 'select', index: rng.int(loop.pitcher.arsenal.length) });
    loop.handle({ type: 'aim', x: rng.uniform(-0.3, 0.3), y: rng.uniform(0.4, 1.15) });
    loop.handle({ type: 'press' });
  } else if (snap.phase === 'meter' && loop._since() > 0.55 + rng.uniform(0, 0.3)) {
    loop.handle({ type: 'press' });
  }
}

test('a full half-inning plays to game over with consistent bookkeeping', () => {
  for (const seed of [1, 2, 3]) {
    const loop = new GameLoop();
    const events = [];
    loop.bus.on('result', ({ payload }) => events.push(payload));
    loop.start({ pitcherId: 'skenes', batterId: 'judge', seed, scenario: { inning: 9, half: 'top', outs: 0, battingRuns: 0, fieldingRuns: 1, bases: [false, false, false] } });
    const rng = new Rng(seed);
    let steps = 0;
    while (loop.phase !== 'gameover' && steps < 60 * 60 * 30) {
      autoPitcher(loop, rng);
      loop.tick(1 / 60);
      steps++;
    }
    assert.equal(loop.phase, 'gameover', `seed ${seed} did not finish`);
    const g = loop.game;
    assert.ok(g.outs >= 3);
    assert.equal(g.stats.outsRecorded, g.outs);
    assert.equal(g.pitchCount, events.length);
    assert.ok(events.every((p) => Number.isFinite(p.pitch.releaseMph) && Number.isFinite(p.pitch.rpm)));
    assert.ok(events.some((p) => p.contact), `seed ${seed}: no contact in a whole half-inning`);
    for (const p of events.filter((e) => e.contact)) {
      assert.ok(Number.isFinite(p.contact.evMph) && Number.isFinite(p.contact.laDeg));
    }
  }
});

test('pause freezes the clock; replay runs at 1/8 speed and returns to the result', () => {
  const loop = new GameLoop();
  loop.start({ pitcherId: 'cole', batterId: 'soto', seed: 9 });
  loop.handle({ type: 'pause' });
  const t0 = loop.t;
  loop.tick(1);
  assert.equal(loop.t, t0);
  loop.handle({ type: 'pause' });
  loop.handle({ type: 'aim', x: 0, y: 0.8 });
  loop.handle({ type: 'press' });
  assert.equal(loop.phase, 'meter');
  for (let i = 0; i < 40; i++) loop.tick(1 / 60);
  loop.handle({ type: 'press' });
  assert.equal(loop.phase, 'windup');
  let guard = 0;
  while (loop.phase !== 'result' && guard++ < 2000) loop.tick(1 / 60);
  assert.equal(loop.phase, 'result');
  loop.handle({ type: 'replay' });
  assert.equal(loop.phase, 'replay');
  assert.equal(loop.timeScale, 0.125);
  guard = 0;
  while (loop.phase === 'replay' && guard++ < 5000) loop.tick(1 / 60);
  assert.equal(loop.phase, 'result');
  assert.equal(loop.timeScale, 1);
});

test('meter times out as a late release', () => {
  const loop = new GameLoop();
  loop.start({ pitcherId: 'burnes', batterId: 'ohtani', seed: 4 });
  loop.handle({ type: 'press' });
  for (let i = 0; i < 90; i++) loop.tick(1 / 60);
  assert.notEqual(loop.phase, 'meter');
  assert.equal(loop.play.meter.tau, 1);
});

test('balance: an average human pitcher vs the CPU lineup lands in MLB-like ranges', () => {
  const tot = { PA: 0, K: 0, BB: 0, H: 0, HR: 0, swings: 0, contact: 0, pitches: 0 };
  for (let seed = 1; seed <= 40; seed++) {
    const loop = new GameLoop();
    loop.start({
      pitcherId: PS.listPitchers()[seed % 5].id, batterId: PS.listBatters()[seed % 4].id, seed,
      scenario: { inning: 9, half: 'top', outs: 0, battingRuns: 0, fieldingRuns: 1, bases: [false, false, false] },
    });
    const rng = new Rng(seed * 7);
    loop.bus.on('result', ({ play }) => {
      tot.pitches++;
      if (play.swing) tot.swings++;
      if (play.collision) tot.contact++;
    });
    let steps = 0;
    while (loop.phase !== 'gameover' && steps++ < 200000) {
      const s = loop.snapshot();
      if (s.phase === 'aim' && loop._since() > 0.3) {
        const pitch = loop.pitcher.arsenal[rng.weightedIndex(loop.pitcher.arsenal.map((a) => a.usage))];
        loop.handle({ type: 'select', code: pitch.code });
        loop.handle({ type: 'aim', x: rng.gaussian(0, 0.17), y: rng.gaussian(0.78, 0.2) });
        loop.handle({ type: 'press' });
      } else if (s.phase === 'meter' && loop._since() > 0.77 + rng.gaussian(0, 0.06)) {
        loop.handle({ type: 'press' });
      }
      loop.tick(1 / 60);
    }
    tot.PA += loop.game.paCount;
    for (const k of ['K', 'BB', 'H', 'HR']) tot[k] += loop.game.stats[k];
  }
  const rate = (k) => tot[k] / tot.PA;
  const contact = tot.contact / tot.swings;
  // Broad guard rails (elite lineup): see docs §7.3 for the measured values.
  assert.ok(rate('K') > 0.10 && rate('K') < 0.32, `K% ${rate('K')}`);
  assert.ok(rate('H') > 0.15 && rate('H') < 0.42, `H/PA ${rate('H')}`);
  assert.ok(rate('HR') < 0.12, `HR/PA ${rate('HR')}`);
  assert.ok(contact > 0.65 && contact < 0.88, `contact/swing ${contact}`);
  const pPerPA = tot.pitches / tot.PA;
  assert.ok(pPerPA > 2.6 && pPerPA < 4.6, `P/PA ${pPerPA}`);
});

test('snapshot is safe before a game starts', () => {
  const loop = new GameLoop();
  assert.deepEqual(loop.snapshot().game, null);
  loop.tick(0.016);
  assert.equal(loop.phase, 'menu');
});
