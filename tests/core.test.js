import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../src/core/vec3.js';
import * as U from '../src/core/units.js';
import { Rng, hashSeed } from '../src/core/rng.js';
import { EventBus } from '../src/core/EventBus.js';
import { BALL, aeroK, PLATE, FIELD } from '../src/core/constants.js';

const close = (a, b, tol = 1e-12) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

test('units round-trip', () => {
  close(U.mpsToMph(U.mphToMps(97.3)), 97.3);
  close(U.radSToRpm(U.rpmToRadS(2400)), 2400);
  close(U.mToFt(U.ftToM(60.5)), 60.5);
  close(U.mToIn(U.inToM(17)), 17);
  close(U.radToDeg(U.degToRad(28)), 28);
});

test('ball and aero constants match the blueprint', () => {
  close(BALL.mass, 0.14529, 1e-4);
  close(BALL.radius, 0.03689, 1e-5);
  close(BALL.area, 4.275e-3, 1e-6);
  close(aeroK(), 0.01802, 1e-5);
  close(PLATE.frontZ, -0.4318, 1e-12);
  close(FIELD.rubberZ, -18.4404, 1e-4);
  assert.ok(Object.isFrozen(BALL));
});

test('vec3 basics', () => {
  const out = V.create();
  assert.deepEqual([...V.add(out, [1, 2, 3], [4, 5, 6])], [5, 7, 9]);
  assert.deepEqual([...V.sub(out, [1, 2, 3], [4, 5, 6])], [-3, -3, -3]);
  assert.deepEqual([...V.cross(out, [1, 0, 0], [0, 1, 0])], [0, 0, 1]);
  close(V.dot([1, 2, 3], [4, 5, 6]), 32);
  close(V.length(V.normalize(out, [3, 4, 12])), 1);
  assert.deepEqual([...V.normalize(out, [0, 0, 0])], [0, 0, 0]);
  assert.deepEqual([...V.rejectUnit(out, [2, 3, 4], [0, 1, 0])], [2, 0, 4]);
  assert.deepEqual([...V.addScaled(out, [1, 1, 1], [1, 2, 3], 2)], [3, 5, 7]);
  close(V.distance([0, 0, 0], [2, 3, 6]), 7);
});

test('vec3 cross is alias-safe', () => {
  const a = V.create(1, 0, 0);
  V.cross(a, a, [0, 1, 0]);
  assert.deepEqual([...a], [0, 0, 1]);
});

test('mat3 multiply and transpose-multiply are inverses for an orthonormal frame', () => {
  const c = Math.cos(0.3), s = Math.sin(0.3);
  const R = [c, 0, -s, 0, 1, 0, s, 0, c]; // column-major R_y(0.3)
  const v = [0.2, -1.1, 3.4];
  const w = V.mulMat3(V.create(), R, v);
  const back = V.mulMat3T(V.create(), R, w);
  for (let i = 0; i < 3; i++) close(back[i], v[i], 1e-12);
  close(w[0], c * 0.2 + s * 3.4); // R_y maps x to (cos, 0, -sin): check first row
});

test('rng is deterministic per seed and well-distributed', () => {
  const a = new Rng(42), b = new Rng(42), c = new Rng(43);
  const seqA = Array.from({ length: 5 }, () => a.next());
  const seqB = Array.from({ length: 5 }, () => b.next());
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, Array.from({ length: 5 }, () => c.next()));
  assert.equal(new Rng('judge-vs-skenes').next(), new Rng('judge-vs-skenes').next());
  assert.equal(hashSeed('x'), hashSeed('x'));

  const r = new Rng(7);
  let sum = 0, sumSq = 0;
  const n = 20000;
  for (let i = 0; i < n; i++) {
    const g = r.gaussian(2, 3);
    sum += g;
    sumSq += g * g;
  }
  const mean = sum / n;
  const sd = Math.sqrt(sumSq / n - mean * mean);
  close(mean, 2, 0.1);
  close(sd, 3, 0.1);

  for (let i = 0; i < 1000; i++) {
    const u = r.next();
    assert.ok(u >= 0 && u < 1);
    const k = r.int(5);
    assert.ok(Number.isInteger(k) && k >= 0 && k < 5);
  }
});

test('rng weightedIndex follows weights and ignores zero weights', () => {
  const r = new Rng(11);
  const counts = [0, 0, 0];
  for (let i = 0; i < 10000; i++) counts[r.weightedIndex([1, 0, 3])]++;
  assert.equal(counts[1], 0);
  close(counts[2] / counts[0], 3, 0.3);
});

test('event bus: on/off/once, unsubscribe during dispatch, listener isolation', () => {
  const bus = new EventBus();
  const seen = [];
  const off = bus.on('pitch', (p) => seen.push(['a', p]));
  bus.once('pitch', (p) => seen.push(['once', p]));
  bus.on('pitch', () => { throw new Error('boom'); });
  bus.on('pitch', (p) => seen.push(['c', p]));

  const origError = console.error;
  console.error = () => {};
  try {
    bus.emit('pitch', 1);
    off();
    bus.emit('pitch', 2);
  } finally {
    console.error = origError;
  }
  assert.deepEqual(seen, [['a', 1], ['once', 1], ['c', 1], ['c', 2]]);
  bus.emit('nothing-listens', 3); // no throw
});
