// CPU opponents (docs/ARCHITECTURE.md §7.3). Phase 3: the CPU batter.
// The CPU pitcher arrives with batting mode in Phase 4.
//
// The batter is fooled by physics, not dice: it reads the pitch at a
// recognition point, extrapolates it as if it had no spin, and blends that
// with the true path according to its Vision. Late, sharp break therefore
// fools weaker eyes more.

import * as PE from './PhysicsEngine.js';
import { ratingsVs, strikeZone, recognitionFt } from './PlayerStats.js';
import { BAT, PLATE, SWING, BALL } from './core/constants.js';
import { FT, IN } from './core/units.js';

/**
 * CPU batter tuning, balanced against MLB plate-discipline rates for an average
 * human pitcher (see tests/game.test.js and docs §7.3).
 */
export const BALANCE = Object.freeze({
  readBase: 0.35,        // weight on the true path vs. the spinless extrapolation …
  readVision: 0.5,       // … plus this much × vision/99
  locSigmaIn: 2.0,       // perception noise at the contact plane (in) …
  locSigmaVision: 4.0,   // … plus this much × (1 − vision/99)
  timingMs: 10,          // swing timing spread (ms) …
  timingContactMs: 16,   // … plus this much × (1 − contact/99)
});

export const DIFFICULTY = Object.freeze({
  rookie: { label: 'Rookie', timing: 1.5, vision: 1.6, chase: 1.4 },
  pro: { label: 'Pro', timing: 1.0, vision: 1.0, chase: 1.0 },
  allstar: { label: 'All-Star', timing: 0.85, vision: 0.8, chase: 0.85 },
  mvp: { label: 'MVP', timing: 0.7, vision: 0.65, chase: 0.7 },
});

/** Where the batter believes the pitch will be at the ideal contact depth. */
export function perceivePitch(pitch, batter, pitcher, { rng = null, difficulty = DIFFICULTY.pro } = {}) {
  const { vision } = ratingsVs(batter, pitcher);
  const traj = pitch.traj;
  const tStar = traj.crossingTime(2, SWING.idealContactZ, 1);
  if (tStar === null) return null;
  const truth = traj.sampleAt(tStar);

  // State at the recognition point, then extrapolate with no lift or seam force.
  const recZ = pitch.release.p[2] + recognitionFt(vision) * FT;
  const tRec = traj.crossingTime(2, recZ, 1) ?? traj.start;
  const X = traj.sampleAt(tRec);
  const naive = PE.simulate(X, { ...pitch.params, kM: 0, sswScale: 0 }, {
    maxT: 1, t0: tRec, stop: PE.stopAt(2, SWING.idealContactZ, 1),
  }).X;

  const w = BALANCE.readBase + BALANCE.readVision * (vision / 99);
  const sigma = (BALANCE.locSigmaIn + BALANCE.locSigmaVision * (1 - vision / 99)) * IN * difficulty.vision;
  const noise = () => (rng ? rng.gaussian(0, sigma) : 0);
  return {
    x: naive[0] + w * (truth[0] - naive[0]) + noise(),
    y: naive[1] + w * (truth[1] - naive[1]) + noise(),
    truth: { x: truth[0], y: truth[1] },
    naive: { x: naive[0], y: naive[1] },
    tStar,
  };
}

/** Distance (m) outside the strike zone, 0 inside. Zone edges include the ball's radius. */
export function zoneDistance(p, zone) {
  const hx = PLATE.halfWidth + BALL.radius;
  const dx = Math.max(0, Math.abs(p.x) - hx);
  const dy = Math.max(0, zone.botM - BALL.radius - p.y, p.y - (zone.topM + BALL.radius));
  return Math.hypot(dx, dy);
}

/** Probability of swinging given perceived distance from the zone, count and vision. */
export function swingProbability(dist, { balls, strikes }, vision, difficulty = DIFFICULTY.pro) {
  let p;
  if (dist === 0) {
    p = 0.70;
    if (strikes === 2) p += 0.18;
    if (balls === 0 && strikes === 0) p *= 0.85;
    if (balls === 3 && strikes === 0) p *= 0.3;
  } else {
    p = 0.32 * Math.exp(-dist / 0.08) * (1.35 - vision / 99) * difficulty.chase;
    if (strikes === 2) p *= 1.6;
    if (balls === 3 && strikes === 0) p *= 0.2;
  }
  return Math.min(0.97, Math.max(0, p));
}

/**
 * Full CPU batter decision for a pitch already solved by PhysicsEngine.
 * Returns { swing, tStart, pci, charge, debug }. Times are on the pitch clock (release = 0).
 */
export function decideSwing({ pitch, batter, pitcher, count, prevPitch = null, rng = null, difficulty = DIFFICULTY.pro }) {
  const ratings = ratingsVs(batter, pitcher);
  const seen = perceivePitch(pitch, batter, pitcher, { rng, difficulty });
  if (!seen) return { swing: false, debug: { reason: 'no crossing' } };

  const zone = strikeZone(batter);
  const dist = zoneDistance(seen, zone);
  const pSwing = swingProbability(dist, count, ratings.vision, difficulty);
  const swing = (rng ? rng.next() : 0.5) < pSwing;

  // Timing: contact-driven spread; a slower pitch after a fast one makes the batter early.
  const sigmaMs = (BALANCE.timingMs + BALANCE.timingContactMs * (1 - ratings.contact / 99)) * difficulty.timing;
  const speedDrop = prevPitch ? prevPitch.metrics.releaseMph - pitch.metrics.releaseMph : 0;
  const meanMs = -0.8 * speedDrop;
  const dtMs = meanMs + (rng ? rng.gaussian(0, sigmaMs) : 0);

  // Power swing when ahead in the count; protect with two strikes.
  const hitterCount = count.balls > count.strikes && count.strikes < 2;
  const charge = count.strikes === 2 ? 0 : hitterCount ? 0.8 * (ratings.power / 99) : 0.3 * (ratings.power / 99);

  return {
    swing,
    tStart: seen.tStar - BAT.swingDuration + dtMs / 1000,
    pci: { x: seen.x, y: seen.y },
    charge,
    debug: { perceived: { x: seen.x, y: seen.y }, truth: seen.truth, naive: seen.naive, dist, pSwing, dtMs, speedDrop },
  };
}

/**
 * Resolves one pitch end to end: CPU decision, swing, contact, collision,
 * batted ball and outcome. Pure given its inputs; GameLoop presents it over time.
 */
export function resolvePitchVsCpu({ pitch, batter, pitcher, count, prevPitch, rng, difficulty, env }) {
  const decision = decideSwing({ pitch, batter, pitcher, count, prevPitch, rng, difficulty });
  const ratings = ratingsVs(batter, pitcher);
  const play = { pitch, decision, swing: null, contact: null, collision: null, batted: null, outcome: null };
  if (!decision.swing) return play;

  play.swing = PE.createSwing({
    ratings, attackAngleDeg: batter.swing.attackAngleDeg, pci: decision.pci,
    tStart: decision.tStart, pitchTraj: pitch.traj, charge: decision.charge, rng,
  });
  play.contact = PE.findContact(pitch.traj, play.swing);
  if (play.contact.kind === 'contact') {
    play.collision = PE.resolveCollision(play.contact);
    if (!play.collision) {
      play.contact = { ...play.contact, kind: 'foulTip' }; // glancing, surfaces separating
    } else {
      play.batted = PE.simulateBattedBall(play.collision, env);
      play.outcome = PE.classifyOutcome(play.batted, ratings.side);
    }
  }
  return play;
}

