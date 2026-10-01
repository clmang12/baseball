// Ball-flight aerodynamics, pitch release/aiming, swing kinematics, bat–ball
// collision, batted-ball flight and outcome classification.
// Implements docs/ARCHITECTURE.md §2 and §3. Pure module: no Three.js, DOM or
// audio, so it runs (and is tested) under Node.
//
// World frame: origin at the back tip of home plate, +y up, -z toward the
// pitcher, +x toward first base. SI units throughout.
//
// Every trajectory is solved once at the triggering event (release, contact)
// and stored in a Trajectory; the renderer only samples it.

import { AIR, BALL, BAT, SWING, COLLISION, PLATE, FIELD, GROUND, PARK, FIELDERS, FIELDING, SIM, aeroK } from './core/constants.js';
import { MPH, RPM, IN, FT, DEG } from './core/units.js';
import {
  pitchSI, releasePoint, handSign, fastballCapMph, breakScale, movementSigma, scatterModel,
  pciRadiusM, handEyeEta, maxBatSpeedMph, perfectBandMs,
} from './PlayerStats.js';

const R_BALL = BALL.radius;
const G = AIR.gravity;
const STATE = 9; // [px, py, pz, vx, vy, vz, wx, wy, wz]

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * Air density from altitude, temperature and relative humidity (§2.2).
 * @returns {{ rho:number, K:number, wind:Float64Array, altitudeM:number, tempC:number, humidity:number }}
 */
export function createEnvironment({ altitudeM = 0, tempC = 21, humidity = 0.5, windMps = [0, 0, 0] } = {}) {
  const p = AIR.seaLevelPressure * Math.exp(-altitudeM / AIR.scaleHeight);
  const es = 610.94 * Math.exp((17.625 * tempC) / (tempC + 243.04)); // saturation vapour pressure, Pa
  const rho = (p / (AIR.gasConstantDryAir * (tempC + 273.15))) * (1 - (0.378 * humidity * es) / p);
  return Object.freeze({ rho, K: aeroK(rho), wind: Float64Array.from(windMps), altitudeM, tempC, humidity });
}

/** Typical game-time conditions; pitch calibration is done here so parks/weather then shift movement physically. */
export const STANDARD_ENV = createEnvironment();

// ---------------------------------------------------------------------------
// Aerodynamic coefficients
// ---------------------------------------------------------------------------

/** Lift coefficient vs spin factor S = r|ω⊥|/U (Nathan hyperbolic fit). */
export const cl = (S) => (S <= 0 ? 0 : S / (AIR.liftB + AIR.liftA * S));

/** Drag coefficient vs total spin in rpm. */
export const cd = (omegaRpm) => AIR.dragC0 + AIR.dragCSpin * (omegaRpm / 1000);

/**
 * Flight parameters for the ODE.
 * kM: Magnus multiplier; sswScale/sswBeta: seam-shifted-wake coefficient and tilt.
 */
export function flightParams(env, { kM = 1, sswScale = 0, sswBeta = 0, tau = AIR.spinDecayTau } = {}) {
  return { K: env.K, wind: env.wind, kM, sswScale, sswBeta, tau };
}

// ---------------------------------------------------------------------------
// ODE and integrator
// ---------------------------------------------------------------------------

/**
 * Writes dX/dt for the 9-state into `out` (§2.3):
 *   ṗ = v
 *   v̇ = g − K C_D U u + kM K C_L(S) U/|ω⊥| (ω × u) + a_SSW
 *   ω̇ = −ω/τ
 */
export function derivative(X, P, out) {
  const vx = X[3], vy = X[4], vz = X[5];
  const wx = X[6], wy = X[7], wz = X[8];
  const ux = vx - P.wind[0], uy = vy - P.wind[1], uz = vz - P.wind[2];
  const U = Math.sqrt(ux * ux + uy * uy + uz * uz);

  out[0] = vx; out[1] = vy; out[2] = vz;
  let ax = 0, ay = -G, az = 0;

  if (U > 1e-9) {
    const wMag = Math.sqrt(wx * wx + wy * wy + wz * wz);
    const drag = P.K * cd(wMag / RPM) * U;
    ax -= drag * ux; ay -= drag * uy; az -= drag * uz;

    if (P.kM !== 0 && wMag > 1e-9) {
      // ω⊥ = ω − (ω·û)û ; only the transverse spin produces lift.
      const wu = (wx * ux + wy * uy + wz * uz) / U;
      const px = wx - (wu * ux) / U, py = wy - (wu * uy) / U, pz = wz - (wu * uz) / U;
      const wPerp = Math.sqrt(px * px + py * py + pz * pz);
      if (wPerp > 1e-6) {
        const coef = (P.kM * P.K * cl((R_BALL * wPerp) / U) * U) / wPerp;
        ax += coef * (wy * uz - wz * uy);
        ay += coef * (wz * ux - wx * uz);
        az += coef * (wx * uy - wy * ux);
      }
    }

    if (P.sswScale !== 0) {
      // Force fixed in the flight frame F(û) = [e1 e2 û]: direction e1 sinβs + e2 cosβs.
      const fx = ux / U, fy = uy / U, fz = uz / U;
      let e2x = -fy * fx, e2y = 1 - fy * fy, e2z = -fy * fz;
      const n2 = Math.sqrt(e2x * e2x + e2y * e2y + e2z * e2z);
      if (n2 > 1e-9) {
        e2x /= n2; e2y /= n2; e2z /= n2;
        const e1x = e2y * fz - e2z * fy, e1y = e2z * fx - e2x * fz, e1z = e2x * fy - e2y * fx;
        const s = Math.sin(P.sswBeta), c = Math.cos(P.sswBeta);
        const mag = P.sswScale * P.K * U * U;
        ax += mag * (e1x * s + e2x * c);
        ay += mag * (e1y * s + e2y * c);
        az += mag * (e1z * s + e2z * c);
      }
    }
  }

  out[3] = ax; out[4] = ay; out[5] = az;
  const decay = Number.isFinite(P.tau) && P.tau > 0 ? -1 / P.tau : 0;
  out[6] = wx * decay; out[7] = wy * decay; out[8] = wz * decay;
  return out;
}

const _k1 = new Float64Array(STATE), _k2 = new Float64Array(STATE);
const _k3 = new Float64Array(STATE), _k4 = new Float64Array(STATE);
const _tmp = new Float64Array(STATE);

/** One classic RK4 step, in place. */
export function rk4Step(X, h, P) {
  derivative(X, P, _k1);
  for (let i = 0; i < STATE; i++) _tmp[i] = X[i] + 0.5 * h * _k1[i];
  derivative(_tmp, P, _k2);
  for (let i = 0; i < STATE; i++) _tmp[i] = X[i] + 0.5 * h * _k2[i];
  derivative(_tmp, P, _k3);
  for (let i = 0; i < STATE; i++) _tmp[i] = X[i] + h * _k3[i];
  derivative(_tmp, P, _k4);
  for (let i = 0; i < STATE; i++) X[i] += (h / 6) * (_k1[i] + 2 * _k2[i] + 2 * _k3[i] + _k4[i]);
  return X;
}

// ---------------------------------------------------------------------------
// Trajectory storage and sampling
// ---------------------------------------------------------------------------

export class Trajectory {
  constructor(capacity = 512) {
    this.n = 0;
    this.t = new Float64Array(capacity);
    this.x = new Float64Array(capacity * STATE);
    /** @type {{type:string, t:number, [k:string]:any}[]} */
    this.events = [];
  }

  push(t, X) {
    if (this.n === this.t.length) {
      const t2 = new Float64Array(this.t.length * 2);
      t2.set(this.t);
      const x2 = new Float64Array(this.x.length * 2);
      x2.set(this.x);
      this.t = t2;
      this.x = x2;
    }
    this.t[this.n] = t;
    this.x.set(X.subarray ? X.subarray(0, STATE) : X.slice(0, STATE), this.n * STATE);
    this.n++;
  }

  truncate(n) {
    this.n = Math.max(0, Math.min(n, this.n));
    this.events = this.events.filter((e) => e.t <= (this.n ? this.t[this.n - 1] : 0));
  }

  get start() { return this.n ? this.t[0] : 0; }
  get end() { return this.n ? this.t[this.n - 1] : 0; }

  /** Copies sample i's state into out (default: new Float64Array). */
  state(i, out = new Float64Array(STATE)) {
    out.set(this.x.subarray(i * STATE, i * STATE + STATE));
    return out;
  }

  last(out) { return this.state(this.n - 1, out); }

  /** Largest index i with t[i] <= t (clamped to [0, n-2]). */
  indexAt(t) {
    let lo = 0, hi = this.n - 1;
    if (t <= this.t[0]) return 0;
    if (t >= this.t[hi]) return Math.max(0, hi - 1);
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.t[mid] <= t) lo = mid; else hi = mid;
    }
    return lo;
  }

  /**
   * Interpolated state at time t: cubic Hermite for position (using v as the
   * derivative), linear for velocity and spin. Clamps outside the time range.
   */
  sampleAt(t, out = new Float64Array(STATE)) {
    if (this.n === 0) return out.fill(0);
    if (this.n === 1 || t <= this.t[0]) return this.state(0, out);
    if (t >= this.end) return this.last(out);
    const i = this.indexAt(t);
    const t0 = this.t[i], t1 = this.t[i + 1];
    const h = t1 - t0;
    const s = h > 0 ? (t - t0) / h : 0;
    const a = i * STATE, b = a + STATE;
    const X = this.x;
    const s2 = s * s, s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
    for (let k = 0; k < 3; k++) {
      out[k] = h00 * X[a + k] + h10 * h * X[a + 3 + k] + h01 * X[b + k] + h11 * h * X[b + 3 + k];
    }
    for (let k = 3; k < STATE; k++) out[k] = X[a + k] + (X[b + k] - X[a + k]) * s;
    return out;
  }

  /**
   * First time at or after `fromT` where position component `axis` crosses `value`
   * in the given direction (+1 increasing, -1 decreasing), refined by bisection on
   * the Hermite interpolant. Returns null if it never crosses.
   */
  crossingTime(axis, value, direction = 1, fromT = -Infinity) {
    const X = this.x;
    for (let i = 0; i < this.n - 1; i++) {
      if (this.t[i + 1] < fromT) continue;
      const a = X[i * STATE + axis] - value, b = X[(i + 1) * STATE + axis] - value;
      if (direction > 0 ? a < 0 && b >= 0 : a > 0 && b <= 0) {
        let lo = this.t[i], hi = this.t[i + 1];
        const tmp = new Float64Array(STATE);
        for (let k = 0; k < 40; k++) {
          const mid = 0.5 * (lo + hi);
          const d = this.sampleAt(mid, tmp)[axis] - value;
          if (direction > 0 ? d < 0 : d > 0) lo = mid; else hi = mid;
        }
        return 0.5 * (lo + hi);
      }
    }
    return null;
  }
}

/**
 * Integrates from X0 with fixed step h until `stop(prev, next)` returns a
 * fraction s ∈ [0, 1] (the terminal state is linearly interpolated there) or maxT.
 * Appends to `traj` (created if absent). X0 is not modified.
 */
export function simulate(X0, P, { h = SIM.pitchStep, maxT = SIM.maxPitchTime, stop = null, traj = null, t0 = 0 } = {}) {
  const out = traj ?? new Trajectory(Math.ceil(maxT / h) + 2);
  const X = Float64Array.from(X0);
  const prev = new Float64Array(STATE);
  let t = t0;
  if (out.n === 0 || out.end < t0) out.push(t, X);
  let stopped = false;
  const tEnd = t0 + maxT;
  while (t < tEnd - 1e-12) {
    prev.set(X);
    const step = Math.min(h, tEnd - t);
    rk4Step(X, step, P);
    if (stop) {
      const s = stop(prev, X);
      if (s !== null && s !== undefined) {
        const f = Math.min(1, Math.max(0, s));
        for (let i = 0; i < STATE; i++) X[i] = prev[i] + (X[i] - prev[i]) * f;
        t += step * f;
        if (t > out.end) out.push(t, X); else out.x.set(X, (out.n - 1) * STATE);
        stopped = true;
        break;
      }
    }
    t += step;
    out.push(t, X);
  }
  return { traj: out, stopped, X, t };
}

/** stop predicate: position component `axis` reaches `value` going in `direction`. */
export function stopAt(axis, value, direction = 1) {
  return (a, b) => {
    const da = a[axis] - value, db = b[axis] - value;
    const crossed = direction > 0 ? da < 0 && db >= 0 : da > 0 && db <= 0;
    return crossed ? da / (da - db) : null;
  };
}

const groundStop = stopAt(1, R_BALL, -1);

// ---------------------------------------------------------------------------
// Spin construction (§2.4)
// ---------------------------------------------------------------------------

/**
 * Flight frame F(f̂) = [e1 e2 f̂] (column-major 9-array): e2 is "up" perpendicular
 * to the flight direction, e1 = e2 × f̂ is "right" as seen from behind the ball.
 */
export function flightFrame(f, out = new Float64Array(9)) {
  let e2x = -f[1] * f[0], e2y = 1 - f[1] * f[1], e2z = -f[1] * f[2];
  let n = Math.sqrt(e2x * e2x + e2y * e2y + e2z * e2z);
  if (n < 1e-9) { // flight straight up/down: pick -z as "up"
    e2x = 0; e2y = 0; e2z = -1; n = 1;
  }
  e2x /= n; e2y /= n; e2z /= n;
  const e1x = e2y * f[2] - e2z * f[1], e1y = e2z * f[0] - e2x * f[2], e1z = e2x * f[1] - e2y * f[0];
  out[0] = e1x; out[1] = e1y; out[2] = e1z;
  out[3] = e2x; out[4] = e2y; out[5] = e2z;
  out[6] = f[0]; out[7] = f[1]; out[8] = f[2];
  return out;
}

/**
 * ω0 = Ω F(f̂) [−ε cos β, ε sin β, s_g √(1−ε²)]ᵀ.
 * β is the Magnus force tilt seen by the catcher (0 = pure backspin/ride,
 * + toward +x). omega in rad/s.
 */
export function spinVector(omega, eps, beta, gyroSign, f, out = new Float64Array(3)) {
  const F = flightFrame(f);
  const l0 = -eps * Math.cos(beta), l1 = eps * Math.sin(beta), l2 = (gyroSign >= 0 ? 1 : -1) * Math.sqrt(Math.max(0, 1 - eps * eps));
  out[0] = omega * (F[0] * l0 + F[3] * l1 + F[6] * l2);
  out[1] = omega * (F[1] * l0 + F[4] * l1 + F[7] * l2);
  out[2] = omega * (F[2] * l0 + F[5] * l1 + F[8] * l2);
  return out;
}

/** Savant spin-axis angle (180° = pure backspin) → tilt β in radians. */
export const savantAxisToTilt = (deg) => Math.PI - deg * DEG;

/** Statcast (x, y toward pitcher, z up) → world (x, y up, z toward catcher). */
export const statcastToWorld = ([x, y, z]) => [x, z, -y];

// ---------------------------------------------------------------------------
// Pitch flight helpers
// ---------------------------------------------------------------------------

const unitDir = (theta, phi) => [Math.sin(phi) * Math.cos(theta), Math.sin(theta), Math.cos(phi) * Math.cos(theta)];

function makeState(p, v, w) {
  return Float64Array.of(p[0], p[1], p[2], v[0], v[1], v[2], w[0], w[1], w[2]);
}

/** Straight line to the target with a gravity-drop correction: initial (θ, φ) for aiming. */
function initialAim(p0, speed, target) {
  const dx = target.x - p0[0], dy = target.y - p0[1], dz = PLATE.frontZ - p0[2];
  const horiz = Math.hypot(dx, dz);
  const T = (Math.hypot(horiz, dy) / speed) * 1.06;
  return { theta: Math.atan2(dy + 0.5 * G * T * T, horiz), phi: Math.atan2(dx, dz) };
}

/** Plate-plane crossing (front edge of the plate) of a pitch flight. */
function crossPlate(p0, v0, w0, P) {
  const run = simulate(makeState(p0, v0, w0), P, { h: SIM.pitchStep, maxT: SIM.maxPitchTime, stop: stopAt(2, PLATE.frontZ, 1) });
  return run.stopped ? run.X : null;
}

/**
 * Movement as Statcast defines it (§2.5): plate-crossing displacement relative to
 * the same release with lift and SSW switched off (gravity and drag unchanged).
 * Returns metres { dx, dy } and the spinning crossing state.
 */
export function movementVsSpinless(p0, v0, w0, P) {
  const spun = crossPlate(p0, v0, w0, P);
  const plain = crossPlate(p0, v0, w0, { ...P, kM: 0, sswScale: 0 });
  if (!spun || !plain) return null;
  return { dx: spun[0] - plain[0], dy: spun[1] - plain[1], crossing: spun };
}

// ---------------------------------------------------------------------------
// Calibration (§2.5)
// ---------------------------------------------------------------------------

const _calibration = new Map();
const CAL_TARGET = { x: 0, y: 0.76 };

/**
 * Finds { eps, beta, cPitch, cSSW, betaSSW } so the simulated pitch reproduces
 * the stored IVB/HB at the shipped Break rating. Memoized per pitcher+pitch.
 */
export function calibratePitch(pitcher, pitch, env = STANDARD_ENV) {
  const key = `${pitcher.id}:${pitcher.throws}:${pitch.code}:${pitch.mph}:${pitch.rpm}:${pitch.ivbIn}:${pitch.hbArmIn}:${pitch.activeSpin ?? '-'}:${pitch.gyroSign ?? 1}:${env.rho.toFixed(5)}`;
  const cached = _calibration.get(key);
  if (cached) return cached;

  const si = pitchSI(pitch, pitcher);
  const p0 = releasePoint(pitcher);
  const aim = initialAim(p0, si.speedMps, CAL_TARGET);
  const f = unitDir(aim.theta, aim.phi);
  const v0 = f.map((c) => c * si.speedMps);
  const target = [si.hbWorldM, si.ivbM];
  const targetMag = Math.hypot(target[0], target[1]);
  const beta0 = Math.atan2(target[0], target[1]);

  const measure = (eps, beta, c, sx, sy) => {
    const w0 = spinVector(si.omegaRadS, eps, beta, si.gyroSign, f);
    const P = flightParams(env, { kM: c, sswScale: Math.hypot(sx, sy), sswBeta: Math.atan2(sx, sy) });
    const m = movementVsSpinless(p0, v0, w0, P);
    return [m.dx, m.dy];
  };
  const mag = (m) => Math.hypot(m[0], m[1]);

  // 1) Spin efficiency (unless published).
  let eps;
  if (si.activeSpin !== null) {
    eps = si.activeSpin;
  } else if (mag(measure(1, beta0, 1, 0, 0)) <= targetMag) {
    eps = 1;
  } else {
    let lo = 0.02, hi = 1;
    for (let i = 0; i < 40 && hi - lo > 1e-5; i++) {
      const mid = 0.5 * (lo + hi);
      if (mag(measure(mid, beta0, 1, 0, 0)) < targetMag) lo = mid; else hi = mid;
    }
    eps = 0.5 * (lo + hi);
  }

  // 2) Close the remaining error with a 2×2 Newton solve, in Cartesian form so
  //    angles never wrap: Magnus (c sinβ, c cosβ) if lift alone reaches the
  //    target, otherwise seam-shifted wake (cSSW sinβs, cSSW cosβs).
  const mode = mag(measure(eps, beta0, 1, 0, 0)) >= targetMag - 1e-4 ? 'magnus' : 'ssw';
  let q = mode === 'magnus' ? [Math.sin(beta0), Math.cos(beta0)] : [0, 0];
  const evalQ = (qq) => (mode === 'magnus'
    ? measure(eps, Math.atan2(qq[0], qq[1]), Math.hypot(qq[0], qq[1]), 0, 0)
    : measure(eps, beta0, 1, qq[0], qq[1]));

  if (mode === 'ssw') {
    // Seed from the residual and a unit-response probe so Newton starts close.
    const base = evalQ([0, 0]);
    const r = [target[0] - base[0], target[1] - base[1]];
    const probe = 0.01;
    const resp = mag(evalQ([0, probe])) > 0 ? mag(sub2(evalQ([0, probe]), base)) / probe : 1;
    q = [(r[0] / resp), (r[1] / resp)];
  }

  let res = sub2(evalQ(q), target);
  for (let iter = 0; iter < 12 && mag(res) > 2e-5; iter++) {
    const d = 1e-4;
    const fx = sub2(evalQ([q[0] + d, q[1]]), target);
    const fy = sub2(evalQ([q[0], q[1] + d]), target);
    const J = [(fx[0] - res[0]) / d, (fy[0] - res[0]) / d, (fx[1] - res[1]) / d, (fy[1] - res[1]) / d];
    const det = J[0] * J[3] - J[1] * J[2];
    if (Math.abs(det) < 1e-14) break;
    q = [q[0] - (J[3] * res[0] - J[1] * res[1]) / det, q[1] - (-J[2] * res[0] + J[0] * res[1]) / det];
    res = sub2(evalQ(q), target);
  }

  const result = Object.freeze(mode === 'magnus'
    ? { mode, eps, beta: Math.atan2(q[0], q[1]), cPitch: Math.hypot(q[0], q[1]), cSSW: 0, betaSSW: 0, residualIn: mag(res) / IN }
    : { mode, eps, beta: beta0, cPitch: 1, cSSW: Math.hypot(q[0], q[1]), betaSSW: Math.atan2(q[0], q[1]), residualIn: mag(res) / IN });
  _calibration.set(key, result);
  return result;
}

export const clearCalibrationCache = () => _calibration.clear();

function sub2(a, b) {
  return [a[0] - b[0], a[1] - b[1]];
}

// ---------------------------------------------------------------------------
// Release solver (§2.7)
// ---------------------------------------------------------------------------

/**
 * Finds release angles so the pitch crosses the front plate plane at target {x, y}.
 * spin: { omega (rad/s), eps, beta, gyroSign }. Returns the release state and
 * the full flight to the catcher (bouncing in the dirt if needed).
 */
export function solveRelease({ p0, speed, spin, params, target, maxIter = 8, tol = 1e-6 }) {
  let { theta, phi } = initialAim(p0, speed, target);
  const crossAt = (th, ph) => {
    const f = unitDir(th, ph);
    const v0 = f.map((c) => c * speed);
    const w0 = spinVector(spin.omega, spin.eps, spin.beta, spin.gyroSign, f);
    return crossPlate(p0, v0, w0, params);
  };

  let iterations = 0;
  let cross = crossAt(theta, phi);
  let err = [target.x - cross[0], target.y - cross[1]];
  while (iterations < maxIter && Math.hypot(err[0], err[1]) > tol) {
    const d = 1e-4;
    const cPhi = crossAt(theta, phi + d), cTh = crossAt(theta + d, phi);
    const J = [(cPhi[0] - cross[0]) / d, (cTh[0] - cross[0]) / d, (cPhi[1] - cross[1]) / d, (cTh[1] - cross[1]) / d];
    const det = J[0] * J[3] - J[1] * J[2];
    if (Math.abs(det) < 1e-12) break;
    phi += (J[3] * err[0] - J[1] * err[1]) / det;
    theta += (-J[2] * err[0] + J[0] * err[1]) / det;
    cross = crossAt(theta, phi);
    err = [target.x - cross[0], target.y - cross[1]];
    iterations++;
  }

  const f = unitDir(theta, phi);
  const v0 = Float64Array.from(f, (c) => c * speed);
  const w0 = spinVector(spin.omega, spin.eps, spin.beta, spin.gyroSign, f);
  const traj = simulatePitchFlight(makeState(p0, v0, w0), params);
  return { v0, w0, p0: Float64Array.from(p0), traj, iterations, residual: Math.hypot(err[0], err[1]), theta, phi };
}

/** Pitch flight from release to the catcher's glove depth, bouncing off the dirt if it gets there first. */
export function simulatePitchFlight(X0, P) {
  const traj = new Trajectory(1024);
  let X = Float64Array.from(X0);
  let t = 0;
  for (let bounce = 0; bounce < 3; bounce++) {
    const remaining = SIM.maxPitchTime - t;
    if (remaining <= 0) break;
    const run = simulate(X, P, {
      h: SIM.pitchStep, maxT: remaining, traj, t0: t,
      stop: (a, b) => groundStop(a, b) ?? stopAt(2, SIM.pitchEndZ, 1)(a, b),
    });
    X = run.X;
    t = run.t;
    if (!run.stopped || X[2] >= SIM.pitchEndZ - 1e-9) break;
    traj.events.push({ type: 'bounce', t, x: X[0], z: X[2] });
    groundBounce(X, GROUND.dirt);
    t += 1e-6;
    traj.push(t, X);
  }
  return traj;
}

// ---------------------------------------------------------------------------
// Full pitch: ratings, variance, control scatter (§3 steps 9–14)
// ---------------------------------------------------------------------------

/**
 * Throws a pitch.
 * @param {object} o
 * @param {object} o.pitcher    roster pitcher
 * @param {string} o.pitchCode
 * @param {{x:number,y:number}} o.target  intended location at the front of the plate (m)
 * @param {{tau:number, reticleIn:number, effort?:boolean}|null} [o.meter]  null → no scatter
 * @param {import('./core/rng.js').Rng} [o.rng]  null → no randomness at all
 * @param {object} [o.env]
 */
export function throwPitch({ pitcher, pitchCode, target, meter = null, rng = null, env = STANDARD_ENV }) {
  const pitch = pitcher.arsenal.find((p) => p.code === pitchCode);
  if (!pitch) throw new Error(`${pitcher.id} has no pitch "${pitchCode}"`);
  const cal = calibratePitch(pitcher, pitch, STANDARD_ENV);
  const si = pitchSI(pitch, pitcher);
  const gauss = (sigma) => (rng ? rng.gaussian(0, sigma) : 0);

  const effort = Boolean(meter?.effort);
  const capMph = fastballCapMph(pitcher.ratings.velocity);
  const releaseMph = Math.min(pitch.mph + (effort ? 1.2 : 0) + gauss(0.6), capMph);
  const omega = si.omegaRadS * (1 + gauss(0.015));
  const k = breakScale(pitcher) * (1 + gauss(movementSigma(pitcher.ratings.break)));
  const params = flightParams(env, { kM: cal.cPitch * k, sswScale: cal.cSSW * k, sswBeta: cal.betaSSW });

  let aimed = { x: target.x, y: target.y };
  let scatter = { sigmaIn: 0, biasIn: { x: 0, y: 0 }, inGreen: true };
  if (meter) {
    scatter = scatterModel(pitcher.ratings.control, pitcher.throws)(meter.tau, meter.reticleIn, { effort });
    aimed = {
      x: target.x + (scatter.biasIn.x + gauss(scatter.sigmaIn)) * IN,
      y: target.y + (scatter.biasIn.y + gauss(scatter.sigmaIn)) * IN,
    };
  }

  const release = solveRelease({
    p0: releasePoint(pitcher),
    speed: releaseMph * MPH,
    spin: { omega, eps: cal.eps, beta: cal.beta, gyroSign: si.gyroSign },
    params,
    target: aimed,
  });

  const crossing = plateCrossing(release.traj);
  const move = movementVsSpinless(release.p0, release.v0, release.w0, params);
  const hp = handSign(pitcher.throws);
  return {
    pitcherId: pitcher.id,
    code: pitch.code,
    name: pitch.name,
    traj: release.traj,
    release: { p: release.p0, v: release.v0, w: release.w0, t: 0 },
    crossing,
    params,
    aim: { intended: { ...target }, actual: aimed, sigmaIn: scatter.sigmaIn, biasIn: scatter.biasIn, inGreen: scatter.inGreen },
    metrics: {
      releaseMph,
      plateMph: crossing ? crossing.speed / MPH : null,
      rpm: Math.hypot(release.w0[0], release.w0[1], release.w0[2]) / RPM,
      ivbIn: move ? move.dy / IN : null,
      hbArmIn: move ? (-hp * move.dx) / IN : null,
      extensionFt: pitcher.release.extensionFt,
      plateTimeS: crossing ? crossing.t : null,
    },
  };
}

/** Where and when the pitch crosses the front edge of the plate. */
export function plateCrossing(traj) {
  const t = traj.crossingTime(2, PLATE.frontZ, 1);
  if (t === null) return null;
  const X = traj.sampleAt(t);
  return { t, x: X[0], y: X[1], z: X[2], speed: Math.hypot(X[3], X[4], X[5]), state: X };
}

/** Any part of the ball touching the zone at the front plane counts (§3 step 14). */
export function isStrike(crossing, zone) {
  if (!crossing) return false;
  return Math.abs(crossing.x) <= PLATE.halfWidth + R_BALL
    && crossing.y >= zone.botM - R_BALL
    && crossing.y <= zone.topM + R_BALL;
}

// ---------------------------------------------------------------------------
// Swing kinematics (§2.8)
// ---------------------------------------------------------------------------

const R_SS = BAT.pivotToKnob + BAT.sweetSpotFromKnob;
const PSI_ACTIVE = 1.4;    // rad: |ψ| range where the barrel can reach the hitting zone
const PSI_FINISH = 2.6;    // rad: follow-through end
const SQUARE_LEAD = 0.05;  // s of constant-speed sweep before square

export class SwingModel {
  /**
   * @param {object} o
   * @param {number} o.hb               +1 right-handed batter, -1 left
   * @param {{x:number,y:number}} o.aim  sweet-spot target at the ideal contact depth (after hand-eye correction)
   * @param {number} o.tStart           swing start (s, pitch clock)
   * @param {number} o.sweetSpotSpeed   m/s at the sweet spot
   * @param {number} o.attackAngleDeg
   * @param {number} [o.timingFactor=1] bat-speed multiplier from timing error (applied at contact)
   */
  constructor({ hb, aim, tStart, sweetSpotSpeed, attackAngleDeg, approachAngleDeg = null, timingFactor = 1, meta = {} }) {
    this.hb = hb;
    this.aim = { ...aim };
    this.tStart = tStart;
    this.tSquare = tStart + BAT.swingDuration;
    this.vss = sweetSpotSpeed;
    this.alpha = attackAngleDeg * DEG;
    // Path rise used for the barrel's height through the zone: hitters largely
    // match the pitch's plane, so blend the descent angle with the attack angle.
    const vaa = approachAngleDeg === null ? attackAngleDeg : approachAngleDeg;
    this.riseAngle = (SWING.planeMatch * vaa + (1 - SWING.planeMatch) * attackAngleDeg) * DEG;
    this.timingFactor = timingFactor;
    this.omega = sweetSpotSpeed / R_SS;
    const [lo, hi] = SWING.vbaClampDeg;
    const vbaDeg = Math.min(hi, Math.max(lo, SWING.vbaMidDeg + SWING.vbaSlopeDegPerM * (aim.y - SWING.vbaMidHeight)));
    this.lambda = vbaDeg * DEG;
    // Pivot at ψ = 0 so the sweet spot passes exactly through the aim point.
    const a0 = [hb * Math.cos(this.lambda), Math.sin(this.lambda), 0];
    this.pivot0 = [aim.x - R_SS * a0[0], aim.y - R_SS * a0[1], SWING.idealContactZ - R_SS * a0[2]];
    this.meta = meta;
  }

  /**
   * Yaw angle ψ(t) and rate. Constant rate Ω for SQUARE_LEAD before square and
   * through follow-through; a constant-acceleration ease-in from the loaded
   * position before that; a constant-deceleration finish after PSI_ACTIVE.
   */
  yaw(t) {
    const W = this.omega;
    const tLin = this.tSquare - SQUARE_LEAD;
    const T1 = BAT.swingDuration - SQUARE_LEAD;
    const psiLin0 = -W * SQUARE_LEAD;
    if (t <= this.tStart) return { psi: psiLin0 - 0.5 * W * T1, rate: 0 };
    if (t < tLin) {
      const tau = t - this.tStart;
      const acc = W / T1;
      return { psi: psiLin0 - 0.5 * W * T1 + 0.5 * acc * tau * tau, rate: acc * tau };
    }
    const psi = W * (t - this.tSquare);
    if (psi <= PSI_ACTIVE) return { psi, rate: W };
    // Decelerate from Ω to 0 between PSI_ACTIVE and PSI_FINISH.
    const tAct = this.tSquare + PSI_ACTIVE / W;
    const dec = (W * W) / (2 * (PSI_FINISH - PSI_ACTIVE));
    const tau = Math.min(t - tAct, W / dec);
    return { psi: PSI_ACTIVE + W * tau - 0.5 * dec * tau * tau, rate: Math.max(0, W - dec * tau) };
  }

  /** Bat pose at time t: unit axis (knob → tip), pivot, knob, sweet spot and tip positions. */
  pose(t) {
    const { psi, rate } = this.yaw(t);
    const hb = this.hb, cl = Math.cos(this.lambda), sl = Math.sin(this.lambda);
    const aHat = [hb * cl * Math.cos(psi), sl, -cl * Math.sin(psi)];
    const rise = R_SS * Math.sin(Math.max(-PSI_ACTIVE, Math.min(PSI_ACTIVE, psi))) * Math.tan(this.riseAngle);
    const pivot = [this.pivot0[0], this.pivot0[1] + rise, this.pivot0[2]];
    const at = (s) => [pivot[0] + (BAT.pivotToKnob + s) * aHat[0], pivot[1] + (BAT.pivotToKnob + s) * aHat[1], pivot[2] + (BAT.pivotToKnob + s) * aHat[2]];
    return { psi, rate, aHat, pivot, knob: at(0), sweetSpot: at(BAT.sweetSpotFromKnob), tip: at(BAT.length) };
  }

  /** Velocity of the bat point `s` metres from the knob (direction tilted up by the attack angle). */
  pointVelocity(t, s, pose = this.pose(t)) {
    const { psi, rate, aHat } = pose;
    const hb = this.hb;
    const nh = [-hb * Math.sin(psi), 0, -Math.cos(psi)];
    const ca = Math.cos(this.alpha), sa = Math.sin(this.alpha);
    let d = [ca * nh[0], ca * nh[1] + sa, ca * nh[2]];
    const along = d[0] * aHat[0] + d[1] * aHat[1] + d[2] * aHat[2];
    d = [d[0] - along * aHat[0], d[1] - along * aHat[1], d[2] - along * aHat[2]];
    const n = Math.hypot(d[0], d[1], d[2]) || 1;
    const speed = rate * (BAT.pivotToKnob + s) * this.timingFactor;
    return [(d[0] / n) * speed, (d[1] / n) * speed, (d[2] / n) * speed];
  }

  /** True if |ψ| is in the range where the barrel can reach the hitting zone. */
  activeAt(t) {
    return Math.abs(this.yaw(t).psi) <= PSI_ACTIVE;
  }
}

/**
 * Builds a swing from player input (§4.2): applies Contact hand-eye correction
 * inside the PCI, Vision's perfect band, Power bat speed and timing loss.
 *
 * @param {object} o
 * @param {{contact:number, power:number, vision:number, hb:number}} o.ratings  from ratingsVs()
 * @param {number} o.attackAngleDeg
 * @param {{x:number,y:number}} o.pci   PCI centre at the ideal contact depth (m)
 * @param {number} o.tStart             swing start, pitch clock (s)
 * @param {Trajectory} o.pitchTraj
 * @param {number} [o.charge=0]         0 = contact swing … 1 = full power swing
 * @param {import('./core/rng.js').Rng} [o.rng]
 */
export function createSwing({ ratings, attackAngleDeg, pci, tStart, pitchTraj, charge = 0, rng = null }) {
  const power = charge >= 0.5;
  const rPci = pciRadiusM(ratings.contact) * (power ? SWING.powerSwingPciShrink : 1);
  const tStar = pitchTraj.crossingTime(2, SWING.idealContactZ, 1);
  const ball = tStar !== null ? pitchTraj.sampleAt(tStar) : null;

  // Hand-eye correction: inside the PCI, part of the aiming error is absorbed.
  let aim = { x: pci.x, y: pci.y };
  let errorM = null;
  if (ball) {
    const ex = ball[0] - pci.x, ey = ball[1] - pci.y;
    errorM = Math.hypot(ex, ey);
    if (errorM <= rPci) {
      const eta = handEyeEta(ratings.contact);
      aim = { x: pci.x + eta * ex, y: pci.y + eta * ey };
    }
  }

  // Vision: timing inside the perfect band snaps to perfect.
  let start = tStart;
  let dt = tStar !== null ? tStart + BAT.swingDuration - tStar : null;
  if (dt !== null && Math.abs(dt) * 1000 <= perfectBandMs(ratings.vision) / 2) {
    start = tStar - BAT.swingDuration;
    dt = 0;
  }

  const c = Math.min(1, Math.max(0, charge));
  const jitter = rng ? 1 + rng.gaussian(0, SWING.batSpeedJitter) : 1;
  const vss = maxBatSpeedMph(ratings.power) * MPH * (0.9 + 0.1 * c) * jitter;
  const timingFactor = dt === null ? 1
    : Math.max(SWING.timingSpeedFloor, 1 - 0.5 * (dt / SWING.timingSpeedLossWindow) ** 2);

  // Descent angle of the pitch at the ideal contact point (positive = dropping).
  const vaaDeg = ball ? Math.atan2(-ball[4], ball[5]) / DEG : null;

  return new SwingModel({
    hb: ratings.hb,
    aim,
    tStart: start,
    sweetSpotSpeed: vss,
    attackAngleDeg,
    approachAngleDeg: vaaDeg,
    timingFactor,
    meta: { pci: { ...pci }, rPci, power, charge: c, tStar, dtMs: dt === null ? null : dt * 1000, pciErrorM: errorM, inPci: errorM !== null && errorM <= rPci },
  });
}

// ---------------------------------------------------------------------------
// Contact detection (§2.9)
// ---------------------------------------------------------------------------

const R_SIGMA = R_BALL + BAT.barrelRadius;

/**
 * Finds when the bat's vertical plane sweeps through the ball and classifies the
 * result as 'contact', 'foulTip' or 'whiff' (§2.9).
 */
export function findContact(pitchTraj, swing) {
  const tmp = new Float64Array(STATE);
  const g = (t) => {
    const pose = swing.pose(t);
    const X = pitchTraj.sampleAt(t, tmp);
    const qx = X[0] - pose.pivot[0], qz = X[2] - pose.pivot[2];
    return { val: pose.aHat[0] * qz - pose.aHat[2] * qx, along: pose.aHat[0] * qx + pose.aHat[2] * qz };
  };

  const t0 = Math.max(pitchTraj.start, swing.tStart);
  const t1 = pitchTraj.end;
  const step = 0.0005;
  let prev = null, prevT = t0;
  for (let t = t0; t <= t1 + 1e-12; t += step) {
    if (!swing.activeAt(t)) { prev = null; prevT = t; continue; }
    const cur = g(t);
    if (prev && Math.sign(cur.val) !== Math.sign(prev.val) && cur.along > 0) {
      let lo = prevT, hi = t, glo = prev.val;
      for (let k = 0; k < 40; k++) {
        const mid = 0.5 * (lo + hi);
        const gm = g(mid).val;
        if (Math.sign(gm) === Math.sign(glo)) { lo = mid; glo = gm; } else hi = mid;
      }
      return classifyContact(pitchTraj, swing, 0.5 * (lo + hi));
    }
    prev = cur;
    prevT = t;
  }
  return { kind: 'whiff', reason: 'timing', tC: null, dtMs: swing.meta.dtMs };
}

function classifyContact(pitchTraj, swing, tC) {
  const pose = swing.pose(tC);
  const X = pitchTraj.sampleAt(tC);
  const a = pose.aHat;
  const q = [X[0] - pose.pivot[0], X[1] - pose.pivot[1], X[2] - pose.pivot[2]];
  const sAlong = dot3(q, a) - BAT.pivotToKnob;
  const base = { tC, sAlong, d: sAlong - BAT.sweetSpotFromKnob, dtMs: swing.meta.dtMs, ball: X, pose };
  if (sAlong < 0 || sAlong > BAT.length) return { ...base, kind: 'whiff', reason: sAlong < 0 ? 'inside' : 'beyond tip' };

  const vb = swing.pointVelocity(tC, sAlong, pose);
  const u = [X[3] - vb[0], X[4] - vb[1], X[5] - vb[2]];
  const uPerp = rejectFrom(u, a);
  const uh = norm3(uPerp);
  // Cross-section "up": ŷ with the bat-axis and approach components removed.
  let eD = rejectFrom(rejectFrom([0, 1, 0], a), uh);
  eD = norm3(eD);
  const D = dot3(q, eD);
  const ctx = { ...base, D, aHat: a, uPerp, eD, batVelocity: vb };

  if (Math.abs(D) >= R_SIGMA + COLLISION.foulTipMargin) return { ...ctx, kind: 'whiff', reason: D > 0 ? 'under' : 'over' };
  if (Math.abs(D) >= R_SIGMA) return { ...ctx, kind: 'foulTip' };

  const root = Math.sqrt(R_SIGMA * R_SIGMA - D * D);
  const nHat = norm3([-root * uh[0] + D * eD[0], -root * uh[1] + D * eD[1], -root * uh[2] + D * eD[2]]);
  return { ...ctx, kind: 'contact', nHat };
}

// ---------------------------------------------------------------------------
// Bat–ball collision (§2.10)
// ---------------------------------------------------------------------------

/** Coefficient of restitution along the barrel, d = offset from the sweet spot (m). */
export const corAt = (d) => Math.max(COLLISION.corFloor, COLLISION.corSweetSpot - COLLISION.corFalloff * d * d);

/** Effective (recoil) mass of a free bat struck `sAlong` metres from the knob. */
export function effectiveMass(sAlong) {
  const b = sAlong - BAT.knobToCM;
  return 1 / (1 / BAT.mass + (b * b) / BAT.inertiaCM);
}

/**
 * Impulse collision in the contact frame C = [â t̂ n̂] (§2.10). Low-level: all
 * vectors in world coordinates. Returns null if the surfaces are separating.
 */
export function impulseCollision({ v, w, batVelocity, aHat, nHat, e, Me }) {
  const kI = BALL.inertiaFactor;
  const rm = BALL.mass / Me;
  const kn = (1 + e) / (1 + rm);
  const kt = ((1 + COLLISION.tangentialRestitution) * kI) / (1 + kI);

  const tHat = cross3(nHat, aHat);
  // Slip velocity of the ball's contact point (at −r n̂) relative to the bat surface.
  const u = [v[0] - batVelocity[0], v[1] - batVelocity[1], v[2] - batVelocity[2]];
  const spinPart = cross3(w, [-R_BALL * nHat[0], -R_BALL * nHat[1], -R_BALL * nHat[2]]);
  const sigma = [u[0] + spinPart[0], u[1] + spinPart[1], u[2] + spinPart[2]];
  const sL = [dot3(sigma, aHat), dot3(sigma, tHat), dot3(sigma, nHat)];
  if (sL[2] >= 0) return null;

  let dv = [-kt * sL[0], -kt * sL[1], -kn * sL[2]];
  const tangential = Math.hypot(dv[0], dv[1]);
  const capT = COLLISION.friction * Math.abs(dv[2]);
  if (tangential > capT) {
    const f = capT / tangential;
    dv = [dv[0] * f, dv[1] * f, dv[2]];
  }
  const dvW = [
    aHat[0] * dv[0] + tHat[0] * dv[1] + nHat[0] * dv[2],
    aHat[1] * dv[0] + tHat[1] * dv[1] + nHat[1] * dv[2],
    aHat[2] * dv[0] + tHat[2] * dv[1] + nHat[2] * dv[2],
  ];
  const dw = cross3(nHat, dvW);
  const s = 1 / (kI * R_BALL);
  return {
    v: [v[0] + dvW[0], v[1] + dvW[1], v[2] + dvW[2]],
    w: [w[0] - s * dw[0], w[1] - s * dw[1], w[2] - s * dw[2]],
  };
}

/** Full collision for a detected contact: returns outgoing state plus Statcast launch numbers. */
export function resolveCollision(contact) {
  if (contact.kind !== 'contact') return null;
  const X = contact.ball;
  const e = corAt(contact.d);
  const Me = effectiveMass(contact.sAlong);
  const out = impulseCollision({
    v: [X[3], X[4], X[5]], w: [X[6], X[7], X[8]],
    batVelocity: contact.batVelocity, aHat: contact.aHat, nHat: contact.nHat, e, Me,
  });
  if (!out) return null;
  const ev = Math.hypot(out.v[0], out.v[1], out.v[2]);
  return {
    p: [X[0], X[1], X[2]],
    v: out.v,
    w: out.w,
    t: contact.tC,
    evMph: ev / MPH,
    laDeg: Math.asin(out.v[1] / ev) / DEG,
    sprayDeg: sprayAngleDeg(out.v[0], out.v[2]),
    spinRpm: Math.hypot(out.w[0], out.w[1], out.w[2]) / RPM,
    batSpeedMph: Math.hypot(...contact.batVelocity) / MPH,
    sweetSpotPct: 100 * Math.exp(-((contact.d / 0.07) ** 2)),
    e,
    Me,
  };
}

/** Spray angle in degrees, + toward right field (first-base side). */
export const sprayAngleDeg = (x, z) => Math.atan2(x, -z) / DEG;

// ---------------------------------------------------------------------------
// Batted ball: flight, wall, bounces, roll (§2.11)
// ---------------------------------------------------------------------------

/** Wall distance (m) and height (m) at a spray angle, linear between park table points. */
export function wallAt(sprayDeg, park = PARK) {
  const w = park.wall;
  if (sprayDeg <= w[0].sprayDeg) return { dist: w[0].distFt * FT, height: w[0].heightFt * FT };
  for (let i = 0; i < w.length - 1; i++) {
    if (sprayDeg <= w[i + 1].sprayDeg) {
      const s = (sprayDeg - w[i].sprayDeg) / (w[i + 1].sprayDeg - w[i].sprayDeg);
      return {
        dist: (w[i].distFt + s * (w[i + 1].distFt - w[i].distFt)) * FT,
        height: (w[i].heightFt + s * (w[i + 1].heightFt - w[i].heightFt)) * FT,
      };
    }
  }
  const lastW = w[w.length - 1];
  return { dist: lastW.distFt * FT, height: lastW.heightFt * FT };
}

const isFairAngle = (sprayDeg) => Math.abs(sprayDeg) <= FIELD.foulAngleDeg;

const MOUND_CENTER_Z = -59 * FT;
/** Playing surface under (x, z): dirt for the mound, plate circle, infield skin and warning track. */
export function surfaceAt(x, z, park = PARK) {
  const rho = Math.hypot(x, z);
  const toMound = Math.hypot(x, z - MOUND_CENTER_Z);
  if (toMound <= FIELD.moundRadius) return GROUND.dirt;
  if (rho <= 13 * FT) return GROUND.dirt;
  const d = -z; // distance toward second base
  const half = 63.64 * FT; // half-diagonal of the 90 ft diamond
  if (Math.abs(x) + Math.abs(d - half) <= half - 4 * FT) return GROUND.grass;
  if (toMound <= 95 * FT) return GROUND.dirt;
  const spray = sprayAngleDeg(x, z);
  if (isFairAngle(spray) && rho >= wallAt(spray, park).dist - 15 * FT) return GROUND.dirt;
  return GROUND.grass;
}

/** In-place ground bounce (§2.11 matrix): v' = diag(f_t, −e_g, f_t) v; spin halves. */
export function groundBounce(X, surface) {
  const vy = X[4];
  const vh = Math.hypot(X[3], X[5]);
  const ft = vh > 1e-9 ? Math.max(5 / 7, 1 - (surface.friction * (1 + surface.restitution) * Math.abs(vy)) / vh) : 1;
  X[1] = R_BALL;
  X[3] *= ft;
  X[4] = -surface.restitution * vy;
  X[5] *= ft;
  X[6] *= 0.5; X[7] *= 0.5; X[8] *= 0.5;
  return X;
}

function wallStop(park) {
  return (a, b) => {
    const sb = sprayAngleDeg(b[0], b[2]);
    if (!isFairAngle(sb)) return null;
    const wb = wallAt(sb, park).dist;
    const rb = Math.hypot(b[0], b[2]);
    if (rb < wb) return null;
    const ra = Math.hypot(a[0], a[2]);
    const wa = wallAt(sprayAngleDeg(a[0], a[2]), park).dist;
    const da = ra - wa, db = rb - wb;
    return da < 0 ? da / (da - db) : 0;
  };
}

function reflectOffWall(X) {
  const rho = Math.hypot(X[0], X[2]);
  const nx = X[0] / rho, nz = X[2] / rho;
  const vn = X[3] * nx + X[5] * nz;
  if (vn <= 0) return X;
  const tx = X[3] - vn * nx, tz = X[5] - vn * nz;
  X[3] = tx * GROUND.wallTangentialKeep - GROUND.wallRestitution * vn * nx;
  X[5] = tz * GROUND.wallTangentialKeep - GROUND.wallRestitution * vn * nz;
  X[4] *= GROUND.wallTangentialKeep;
  X[0] -= nx * 0.01; X[2] -= nz * 0.01; // step back inside the wall
  return X;
}

/**
 * Simulates a batted ball from the contact state {p, v, w}. Returns the full
 * playback trajectory plus Statcast quantities and wall/landing events.
 */
export function simulateBattedBall(start, env = STANDARD_ENV, park = PARK) {
  const P = flightParams(env, { kM: AIR.battedLiftScale });
  const X0 = makeState(start.p, start.v, start.w);
  const t0 = start.t ?? 0;

  // 1) Projected flight ignoring walls → Statcast distance, hang time, apex.
  const proj = simulate(X0, P, { h: SIM.battedStep, maxT: SIM.maxBattedTime, stop: groundStop, t0 });
  const projTraj = proj.traj;
  let apex = -Infinity;
  for (let i = 0; i < projTraj.n; i++) apex = Math.max(apex, projTraj.x[i * STATE + 1]);
  const landing = { x: proj.X[0], z: proj.X[2], t: proj.t };
  const projectedDist = Math.hypot(landing.x, landing.z);

  // 2) Real path: stop at the wall or the ground.
  const traj = new Trajectory(4096);
  let X = Float64Array.from(X0);
  let t = t0;
  let wall = null;
  let firstGround = null;
  let isHR = false;
  const wallCheck = wallStop(park);

  let run = simulate(X, P, { h: SIM.battedStep, maxT: SIM.maxBattedTime, traj, t0: t, stop: (a, b) => groundStop(a, b) ?? wallCheck(a, b) });
  X = run.X; t = run.t;

  const handleWall = () => {
    const spray = sprayAngleDeg(X[0], X[2]);
    const { height } = wallAt(spray, park);
    if (X[1] > height) {
      isHR = true;
      wall = { type: 'HR', t, x: X[0], y: X[1], z: X[2], sprayDeg: spray };
      traj.events.push({ ...wall });
      // Keep flying into the stands for playback.
      run = simulate(X, P, { h: SIM.battedStep, maxT: SIM.maxBattedTime - (t - t0), traj, t0: t, stop: groundStop });
      X = run.X; t = run.t;
      return true;
    }
    wall = { type: 'WALL', t, x: X[0], y: X[1], z: X[2], sprayDeg: spray };
    traj.events.push({ ...wall });
    reflectOffWall(X);
    t += 1e-6;
    traj.push(t, X);
    return false;
  };

  if (run.stopped && X[1] > R_BALL + 1e-6) {
    if (handleWall()) {
      return finishBatted({ traj, start, landing, projectedDist, apex, wall, isHR, firstGround: null, rest: { x: X[0], z: X[2], t }, t0 });
    }
  }

  // 3) Bounces: X is on the ground here (or bouncing back off the wall in the air).
  const bounceStop = (a, b) => groundStop(a, b) ?? wallCheck(a, b);
  for (let bounce = 0; bounce < 12; bounce++) {
    if (X[1] > R_BALL + 1e-6) {
      // Airborne (after a wall carom): fly until the ground or the wall again.
      run = simulate(X, P, { h: SIM.battedStep, maxT: Math.max(0.05, SIM.maxBattedTime - (t - t0)), traj, t0: t, stop: bounceStop });
      X = run.X; t = run.t;
      if (!run.stopped) break;
      if (X[1] > R_BALL + 1e-6) {
        if (!wall) handleWall();
        else { reflectOffWall(X); t += 1e-6; traj.push(t, X); }
        continue;
      }
    }
    if (!firstGround) {
      firstGround = { x: X[0], z: X[2], t };
      traj.events.push({ type: 'ground', ...firstGround });
    } else {
      traj.events.push({ type: 'bounce', x: X[0], z: X[2], t });
    }
    groundBounce(X, surfaceAt(X[0], X[2], park));
    t += 1e-6;
    traj.push(t, X);
    if (Math.abs(X[4]) < GROUND.rollThreshold) break;
    X[1] = R_BALL + 2e-6; // lift off so the next pass integrates the hop
  }

  // Roll with constant rolling-resistance deceleration, stopping at the wall.
  X[1] = R_BALL; X[4] = 0;
  const dtRoll = 0.02;
  for (let i = 0; i < 2000; i++) {
    const vh = Math.hypot(X[3], X[5]);
    if (vh < 0.05) { X[3] = 0; X[5] = 0; break; }
    const surface = surfaceAt(X[0], X[2], park);
    const decel = surface.rolling * G + surface.rollDrag * vh * vh;
    const dt = Math.min(dtRoll, vh / decel);
    const scale = Math.max(0, vh - decel * dt) / vh;
    X[0] += X[3] * dt * (1 + scale) / 2;
    X[2] += X[5] * dt * (1 + scale) / 2;
    X[3] *= scale; X[5] *= scale;
    X[6] *= 0.98; X[7] *= 0.98; X[8] *= 0.98;
    t += dt;
    const spray = sprayAngleDeg(X[0], X[2]);
    if (isFairAngle(spray) && Math.hypot(X[0], X[2]) >= wallAt(spray, park).dist) {
      X[3] = 0; X[5] = 0;
      traj.push(t, X);
      if (!wall) {
        wall = { type: 'ROLL_TO_WALL', t, x: X[0], y: X[1], z: X[2], sprayDeg: spray };
        traj.events.push({ ...wall });
      }
      break;
    }
    traj.push(t, X);
  }
  return finishBatted({ traj, start, landing, projectedDist, apex, wall, isHR, firstGround, rest: { x: X[0], z: X[2], t }, t0 });
}

function finishBatted({ traj, start, landing, projectedDist, apex, wall, isHR, firstGround, rest, t0 }) {
  const ev = Math.hypot(start.v[0], start.v[1], start.v[2]);
  return {
    traj,
    landing,
    projectedDistFt: projectedDist / FT,
    apexFt: apex / FT,
    hangS: landing.t - t0,
    wall,
    isHR,
    firstGround,
    rest,
    evMph: ev / MPH,
    laDeg: Math.asin(start.v[1] / ev) / DEG,
    sprayDeg: sprayAngleDeg(start.v[0], start.v[2]),
  };
}

// ---------------------------------------------------------------------------
// Outcome classification (§2.11)
// ---------------------------------------------------------------------------

const fielderPos = (f) => [Math.sin(f.sprayDeg * DEG) * f.distFt * FT, -Math.cos(f.sprayDeg * DEG) * f.distFt * FT];
const BASES = [
  [63.64 * FT, -63.64 * FT],   // 1B
  [0, -127.28 * FT],           // 2B
  [-63.64 * FT, -63.64 * FT],  // 3B
];

/**
 * Classifies the batted ball: 'HR' | '3B' | '2B' | '1B' | 'OUT_FLY' | 'OUT_LINE'
 * | 'OUT_GROUND' | 'FOUL', plus the fielder involved. Deterministic.
 * @param {object} batted       simulateBattedBall() result
 * @param {'R'|'L'} battingSide  for time to first base
 */
export function classifyOutcome(batted, battingSide = 'R', park = PARK) {
  const traj = batted.traj;
  const tStart = traj.start;
  const tAirEnd = batted.firstGround?.t ?? batted.wall?.t ?? traj.end;
  const fielders = FIELDERS.map((f) => ({ ...f, xz: fielderPos(f) }));
  const reach = (f, x, z, t) => fielderTime(f, Math.hypot(x - f.xz[0], z - f.xz[1])) <= t - tStart + FIELDING.catchGrace;

  if (batted.isHR) return { result: 'HR', fielder: null, fair: true };

  // 1) Catch in the air (fair, or foul pop-ups within playable foul ground).
  const X = new Float64Array(STATE);
  for (let i = 0; i < traj.n && traj.t[i] <= tAirEnd; i++) {
    traj.state(i, X);
    if (X[1] > FIELDING.catchHeight || X[4] > 0 && traj.t[i] - tStart < 0.3) continue;
    const spray = sprayAngleDeg(X[0], X[2]);
    const rho = Math.hypot(X[0], X[2]);
    if (!isFairAngle(spray)) {
      const beyondLine = rho * Math.sin((Math.abs(spray) - FIELD.foulAngleDeg) * DEG);
      if (beyondLine > FIELDING.foulPlayableDepth || Math.abs(spray) > 90) continue;
    } else if (rho > wallAt(spray, park).dist) continue;
    const catcher = fielders.find((f) => reach(f, X[0], X[2], traj.t[i]));
    if (catcher) {
      return { result: batted.laDeg >= 25 ? 'OUT_FLY' : 'OUT_LINE', fielder: catcher.pos, fair: isFairAngle(spray), t: traj.t[i] };
    }
  }

  // 2) Fair or foul: decided where the ball first lands beyond the bases, else
  //    where it is when it passes 90 ft or stops.
  const decision = fairDecisionPoint(batted);
  if (!isFairAngle(sprayAngleDeg(decision.x, decision.z))) return { result: 'FOUL', fielder: null, fair: false };

  // 3) Fielded on the ground: earliest fielder to reach the ball's path.
  let best = null;
  for (let i = 0; i < traj.n; i++) {
    if (traj.t[i] < tAirEnd) continue;
    traj.state(i, X);
    if (X[1] > FIELDING.catchHeight) continue;
    for (const f of fielders) {
      if (reach(f, X[0], X[2], traj.t[i])) { best = { f, t: traj.t[i], x: X[0], z: X[2] }; break; }
    }
    if (best) break;
  }
  if (!best) {
    // Nobody got there while it moved: the nearest outfielder picks it up at rest.
    const r = batted.rest;
    const of = fielders.filter((f) => !f.infield).map((f) => ({ f, t: tStart + fielderTime(f, Math.hypot(r.x - f.xz[0], r.z - f.xz[1])) }))
      .sort((a, b) => a.t - b.t)[0];
    best = { f: of.f, t: Math.max(of.t, r.t), x: r.x, z: r.z };
  }

  const tFirst = FIELDING.timeToFirst[battingSide] ?? FIELDING.timeToFirst.R;
  const throwTime = (b) => (best.f.infield
    ? FIELDING.transferTime + Math.hypot(b[0] - best.x, b[1] - best.z) / FIELDING.throwSpeed
    : FIELDING.outfieldTransferTime + Math.hypot(b[0] - best.x, b[1] - best.z) / FIELDING.outfieldThrowSpeed);
  const elapsed = best.t - tStart;

  if (best.f.infield) {
    const out = elapsed + throwTime(BASES[0]) <= tFirst;
    return { result: out ? 'OUT_GROUND' : '1B', fielder: best.f.pos, fair: true, t: best.t };
  }

  // Outfield hit: take extra bases while the throw would arrive late.
  let bases = 1;
  for (let k = 1; k <= 2; k++) {
    const runnerArrives = tFirst + k * FIELDING.timeBetweenBases;
    if (elapsed + throwTime(BASES[k]) > runnerArrives + FIELDING.extraBaseMargin) bases = k + 1; else break;
  }
  return { result: ['1B', '2B', '3B'][bases - 1], fielder: best.f.pos, fair: true, t: best.t };
}

/** Time for a fielder to cover `dist` metres: reaction, then accelerate to top speed and cruise. */
export function fielderTime(f, dist) {
  const d = Math.max(0, dist - f.reach);
  const accelDist = (f.speed * f.speed) / (2 * f.accel);
  const run = d <= accelDist ? Math.sqrt((2 * d) / f.accel) : d / f.speed + f.speed / (2 * f.accel);
  return f.react + run;
}

function fairDecisionPoint(batted) {
  const fg = batted.firstGround ?? batted.wall ?? batted.rest;
  if (Math.hypot(fg.x, fg.z) >= 90 * FT || batted.wall) return fg;
  const traj = batted.traj;
  const X = new Float64Array(STATE);
  for (let i = 0; i < traj.n; i++) {
    if (traj.t[i] < fg.t) continue;
    traj.state(i, X);
    if (Math.hypot(X[0], X[2]) >= 90 * FT) return { x: X[0], z: X[2] };
  }
  return batted.rest;
}

// ---------------------------------------------------------------------------
// Statcast metrics (§2.11, §6.3)
// ---------------------------------------------------------------------------

/** Statcast barrel: EV ≥ 98 mph with a launch-angle window that widens with EV. */
export function isBarrel(evMph, laDeg) {
  if (evMph < 98) return false;
  const lo = Math.max(8, 26 - (evMph - 98));
  const hi = evMph < 100 ? 30 + 1.5 * (evMph - 98) : Math.min(50, 33 + (17 / 16) * (evMph - 100));
  return laDeg >= lo && laDeg <= hi;
}

const XBA_EV = [60, 70, 80, 85, 90, 95, 100, 105, 110, 115];
const XBA_LA = [-30, -10, 0, 10, 15, 20, 25, 30, 35, 40, 50, 60];
// Model expected batting average by (LA row, EV column). Approximates the shape of
// Statcast's xBA surface; display-only, not used for outcomes.
const XBA = [
  [0.05, 0.08, 0.10, 0.12, 0.15, 0.18, 0.22, 0.28, 0.35, 0.40],
  [0.10, 0.14, 0.18, 0.22, 0.27, 0.33, 0.40, 0.48, 0.55, 0.60],
  [0.15, 0.20, 0.25, 0.30, 0.35, 0.42, 0.50, 0.58, 0.65, 0.70],
  [0.30, 0.40, 0.50, 0.55, 0.60, 0.67, 0.73, 0.78, 0.82, 0.85],
  [0.40, 0.55, 0.65, 0.70, 0.72, 0.76, 0.80, 0.84, 0.88, 0.90],
  [0.35, 0.50, 0.62, 0.66, 0.65, 0.65, 0.70, 0.78, 0.85, 0.90],
  [0.15, 0.25, 0.30, 0.30, 0.25, 0.35, 0.55, 0.75, 0.88, 0.93],
  [0.05, 0.10, 0.12, 0.10, 0.10, 0.20, 0.45, 0.75, 0.90, 0.95],
  [0.03, 0.05, 0.06, 0.06, 0.07, 0.12, 0.30, 0.62, 0.85, 0.92],
  [0.02, 0.03, 0.04, 0.04, 0.05, 0.08, 0.18, 0.40, 0.65, 0.80],
  [0.01, 0.02, 0.02, 0.02, 0.03, 0.04, 0.06, 0.10, 0.18, 0.30],
  [0.01, 0.01, 0.01, 0.01, 0.01, 0.02, 0.02, 0.03, 0.05, 0.08],
];

/** Bilinear lookup in the model xBA table. */
export function xBA(evMph, laDeg) {
  const locate = (arr, v) => {
    if (v <= arr[0]) return [0, 0];
    if (v >= arr[arr.length - 1]) return [arr.length - 2, 1];
    let i = 0;
    while (v > arr[i + 1]) i++;
    return [i, (v - arr[i]) / (arr[i + 1] - arr[i])];
  };
  const [i, fi] = locate(XBA_LA, laDeg);
  const [j, fj] = locate(XBA_EV, evMph);
  const a = XBA[i][j] + (XBA[i][j + 1] - XBA[i][j]) * fj;
  const b = XBA[i + 1][j] + (XBA[i + 1][j + 1] - XBA[i + 1][j]) * fj;
  return a + (b - a) * fi;
}

/**
 * Telemetry payload pieces for TelemetryUI (§6.3). GameLoop adds players,
 * count, outs and the umpire call.
 */
export function statcastMetrics(pitch, swing = null, collision = null, batted = null, outcome = null) {
  const m = pitch.metrics;
  const payload = {
    pitch: {
      code: pitch.code,
      name: pitch.name,
      releaseMph: m.releaseMph,
      plateMph: m.plateMph,
      rpm: m.rpm,
      ivbIn: m.ivbIn,
      hbArmIn: m.hbArmIn,
      extensionFt: m.extensionFt,
      plateTimeS: m.plateTimeS,
      cross: pitch.crossing ? { xIn: pitch.crossing.x / IN, zIn: pitch.crossing.y / IN } : null,
    },
  };
  if (swing) {
    const dt = swing.meta.dtMs;
    payload.swing = {
      dtMs: dt,
      timing: dt === null ? null : dt === 0 ? 'PERFECT' : dt < 0 ? 'EARLY' : 'LATE',
      batSpeedMph: (swing.vss * swing.timingFactor) / MPH,
      attackAngleDeg: swing.alpha / DEG,
      power: swing.meta.power,
    };
  }
  if (collision) {
    payload.contact = {
      evMph: collision.evMph,
      laDeg: collision.laDeg,
      sprayDeg: collision.sprayDeg,
      spinRpm: collision.spinRpm,
      sweetSpotPct: collision.sweetSpotPct,
      barrel: isBarrel(collision.evMph, collision.laDeg),
      xBA: xBA(collision.evMph, collision.laDeg),
    };
  }
  if (batted) {
    payload.batted = {
      projDistFt: batted.projectedDistFt,
      hangS: batted.hangS,
      apexFt: batted.apexFt,
      landing: { x: batted.landing.x, z: batted.landing.z },
      isHR: batted.isHR,
      outcome: outcome?.result ?? null,
      fielder: outcome?.fielder ?? null,
    };
  }
  return payload;
}

// ---------------------------------------------------------------------------
// small vector helpers (array-returning; not used in the integrator hot loop)
// ---------------------------------------------------------------------------

function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross3(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm3(a) { const n = Math.hypot(a[0], a[1], a[2]); return n > 0 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 0]; }
function rejectFrom(a, n) { const d = dot3(a, n); return [a[0] - d * n[0], a[1] - d * n[1], a[2] - d * n[2]]; }
