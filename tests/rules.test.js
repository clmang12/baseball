import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../src/game/rules.js';

const play = (state, ...types) => types.reduce((s, t) => R.applyPitch(s, typeof t === 'string' ? { type: t } : t).state, state);
const fresh = (over = {}) => ({ ...R.newGame(), ...over, bases: over.bases ?? [false, false, false] });
const inPlay = (result, batted = {}) => ({ type: 'in_play', outcome: { result }, batted });

test('showdown scenario defaults', () => {
  const s = R.newGame();
  assert.deepEqual([s.inning, s.half, s.outs, s.score.batting, s.score.fielding], [9, 'top', 1, 3, 4]);
  assert.equal(R.countString(s), '0-0');
});

test('applyPitch does not mutate its input', () => {
  const s = R.newGame();
  const copy = structuredClone(s);
  R.applyPitch(s, { type: 'ball' });
  assert.deepEqual(s, copy);
});

test('strikeout, fouls with two strikes, foul tip on two strikes', () => {
  let s = play(fresh(), 'called_strike', 'foul', 'foul', 'foul');
  assert.equal(s.strikes, 2, 'fouls do not add a third strike');
  const k = R.applyPitch(s, { type: 'swinging_strike' });
  assert.equal(k.result, 'K');
  assert.equal(k.state.outs, 2);
  assert.equal(k.state.strikes, 0);
  const tip = R.applyPitch(s, { type: 'foul_tip' });
  assert.equal(tip.result, 'K', 'caught foul tip with two strikes is strike three');
});

test('walks force runners only when forced', () => {
  const walk = (bases) => R.applyPitch({ ...fresh({ bases }), balls: 3 }, { type: 'ball' });
  assert.deepEqual(walk([false, false, false]).state.bases, [true, false, false]);
  assert.deepEqual(walk([false, true, false]).state.bases, [true, true, false], 'runner on 2nd not forced');
  assert.deepEqual(walk([true, false, true]).state.bases, [true, true, true]);
  const loaded = walk([true, true, true]);
  assert.equal(loaded.runs, 1);
  assert.deepEqual(loaded.state.bases, [true, true, true]);
  assert.equal(loaded.result, 'BB');
});

test('hits advance runners; runner on second scores on a single', () => {
  const single = R.applyPitch(fresh({ bases: [true, true, false] }), inPlay('1B'));
  assert.equal(single.runs, 1);
  assert.deepEqual(single.state.bases, [true, true, false]);
  const dbl = R.applyPitch(fresh({ bases: [true, false, false] }), inPlay('2B'));
  assert.deepEqual(dbl.state.bases, [false, true, true]);
  assert.equal(dbl.runs, 0);
  const hr = R.applyPitch(fresh({ bases: [true, false, true] }), inPlay('HR'));
  assert.equal(hr.runs, 3);
  assert.deepEqual(hr.state.bases, [false, false, false]);
  assert.equal(hr.state.score.batting, 6);
  assert.equal(hr.state.stats.HR, 1);
});

test('double play, fielder\'s choice, sacrifice fly', () => {
  const dp = R.applyPitch(fresh({ outs: 0, bases: [true, false, false] }), inPlay('OUT_GROUND', { evMph: 95 }));
  assert.equal(dp.state.outs, 2);
  assert.deepEqual(dp.state.bases, [false, false, false]);
  const fc = R.applyPitch(fresh({ outs: 0, bases: [true, false, false] }), inPlay('OUT_GROUND', { evMph: 70 }));
  assert.equal(fc.state.outs, 1);
  assert.deepEqual(fc.state.bases, [true, false, false]);
  assert.equal(fc.text, "Fielder's choice");
  const sf = R.applyPitch(fresh({ outs: 1, bases: [false, false, true] }), inPlay('OUT_FLY', { projectedDistFt: 320 }));
  assert.equal(sf.runs, 1);
  assert.equal(sf.text, 'Sacrifice fly');
  const shallow = R.applyPitch(fresh({ outs: 1, bases: [false, false, true] }), inPlay('OUT_FLY', { projectedDistFt: 180 }));
  assert.equal(shallow.runs, 0);
  const third = R.applyPitch(fresh({ outs: 2, bases: [false, false, true] }), inPlay('OUT_FLY', { projectedDistFt: 320 }));
  assert.equal(third.runs, 0, 'no run scores on the third out');
  assert.ok(third.state.over);
});

test('three outs end the half-inning and the verdict reflects the score', () => {
  let s = fresh({ outs: 2 });
  s = R.applyPitch(s, inPlay('OUT_LINE')).state;
  assert.ok(s.over);
  assert.equal(R.verdict(s).win, true);
  const blown = { ...s, score: { batting: 5, fielding: 4 } };
  assert.equal(R.verdict(blown).title, 'Blown save');
});

test('nonContactEvent mapping', () => {
  assert.equal(R.nonContactEvent({ swung: false, isStrike: true }), 'called_strike');
  assert.equal(R.nonContactEvent({ swung: false, isStrike: false }), 'ball');
  assert.equal(R.nonContactEvent({ swung: true, contactKind: 'whiff' }), 'swinging_strike');
  assert.equal(R.nonContactEvent({ swung: true, contactKind: 'foulTip' }), 'foul_tip');
});
