// Physical constants, field geometry and tuning knobs — the single source of
// truth referenced by docs/ARCHITECTURE.md. SI units unless the name says otherwise.
// World frame: origin at the back tip of home plate, +y up, -z toward the pitcher,
// +x toward the first-base side (catcher's right).

import { FT, IN, OZ } from './units.js';

const deepFreeze = (obj) => {
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) deepFreeze(value);
  }
  return Object.freeze(obj);
};

const ballRadius = (9.125 * IN) / (2 * Math.PI);

export const BALL = deepFreeze({
  mass: 5.125 * OZ,                       // 0.1453 kg
  radius: ballRadius,                     // 0.03689 m
  area: Math.PI * ballRadius * ballRadius,
  inertiaFactor: 0.4,                     // k_I in I = k_I m r^2
});

export const AIR = deepFreeze({
  rhoSeaLevel: 1.225,                     // kg/m^3 at 15 °C
  gravity: 9.80665,                       // m/s^2
  dragC0: 0.3008,                         // C_D0 (Nathan)
  dragCSpin: 0.0292,                      // C_D per 1000 rpm
  liftA: 2.32,                            // C_L = 1 / (liftA + liftB / S)
  liftB: 0.4,
  spinDecayTau: 25,                       // s
  scaleHeight: 8434,                      // m, for density vs altitude
  gasConstantDryAir: 287.05,              // J/(kg·K)
  seaLevelPressure: 101325,               // Pa
});

/** Aerodynamic constant K = rho A / 2m at a given air density. */
export const aeroK = (rho = AIR.rhoSeaLevel) => (rho * BALL.area) / (2 * BALL.mass);

export const BAT = deepFreeze({
  length: 34 * IN,                        // 0.864 m
  mass: 32 * OZ,                          // 0.907 kg
  barrelRadius: 0.0330,                   // m (2.6 in barrel)
  knobToCM: 0.57,                         // m
  inertiaCM: 0.048,                       // kg·m^2 about the centre of mass
  sweetSpotFromKnob: 0.70,                // m (~6.5 in from the tip)
  pivotToKnob: 0.25,                      // rho_0: swing pivot (hands) to knob, m
  swingDuration: 0.150,                   // s from swing start until the bat is square
});

export const SWING = deepFreeze({
  idealContactZ: -0.45,                   // m, z* (just in front of the plate)
  vbaMidDeg: -28,                         // vertical bat angle at mid-zone height
  vbaSlopeDegPerM: 40,                    // VBA change per metre of pitch height
  vbaMidHeight: 0.75,                     // m
  vbaClampDeg: [-45, -12],
  timingSpeedLossWindow: 0.040,           // s, f_t = max(0.6, 1 - 0.5 (dt / window)^2)
  timingSpeedFloor: 0.6,
  powerSwingHoldMs: 120,
  powerSwingPciShrink: 0.8,
  batSpeedJitter: 0.015,                  // relative sigma per swing
});

export const COLLISION = deepFreeze({
  corSweetSpot: 0.46,                     // e0, wood
  corFalloff: 5.0,                        // e(d) = e0 - corFalloff * d^2
  corFloor: 0.10,
  tangentialRestitution: 0,               // e_T (ball leaves rolling)
  friction: 0.50,                         // mu, Coulomb cap
  foulTipMargin: 0.006,                   // m beyond R_sigma that still nicks the ball
});

export const PLATE = deepFreeze({
  width: 17 * IN,                         // 0.4318 m
  halfWidth: 8.5 * IN,
  frontZ: -17 * IN,                       // Statcast evaluates the zone at the plate's front edge
  zoneBottomFrac: 0.27,                   // of batter height
  zoneTopFrac: 0.535,
});

export const FIELD = deepFreeze({
  rubberZ: -60.5 * FT,                    // rubber is 60'6" from the back point of the plate
  moundHeight: 10 * IN,
  moundRadius: 9 * FT,
  baseDistance: 90 * FT,
  foulAngleDeg: 45,
});

export const GROUND = deepFreeze({
  grass: { restitution: 0.45, friction: 0.40, rolling: 0.25 },
  dirt: { restitution: 0.50, friction: 0.30, rolling: 0.35 },
  rollThreshold: 0.5,                     // m/s vertical speed below which the ball rolls
  wallRestitution: 0.30,
  wallTangentialKeep: 0.8,
});

/** Default park: symmetric, wall distances in ft by spray angle (deg, + = right field). */
export const PARK = deepFreeze({
  name: 'Showdown Park',
  altitudeM: 0,
  wall: [
    { sprayDeg: -45, distFt: 330, heightFt: 10 },
    { sprayDeg: -22.5, distFt: 375, heightFt: 10 },
    { sprayDeg: 0, distFt: 405, heightFt: 10 },
    { sprayDeg: 22.5, distFt: 375, heightFt: 10 },
    { sprayDeg: 45, distFt: 330, heightFt: 10 },
  ],
});

export const FIELDERS = deepFreeze([
  { pos: '1B', distFt: 110, sprayDeg: 33, speed: 7.6 },
  { pos: '2B', distFt: 150, sprayDeg: 17, speed: 7.6 },
  { pos: 'SS', distFt: 150, sprayDeg: -17, speed: 7.6 },
  { pos: '3B', distFt: 115, sprayDeg: -33, speed: 7.6 },
  { pos: 'LF', distFt: 290, sprayDeg: -28, speed: 8.2 },
  { pos: 'CF', distFt: 320, sprayDeg: 0, speed: 8.2 },
  { pos: 'RF', distFt: 290, sprayDeg: 28, speed: 8.2 },
]);

export const FIELDING = deepFreeze({
  reactionTime: 0.45,                     // s
  catchGrace: 0.10,                       // s
  throwSpeed: 38,                         // m/s
  timeToFirst: { R: 4.25, L: 4.10 },      // s, home to first
});

export const SIM = deepFreeze({
  pitchStep: 0.001,                       // s
  battedStep: 0.002,                      // s
  eventRefineWindow: 0.2,                 // s before an event where steps shrink back to 1 ms
  maxPitchTime: 1.5,                      // s
  maxBattedTime: 12,                      // s
  visualSpinCapRevPerSec: 9,
});
