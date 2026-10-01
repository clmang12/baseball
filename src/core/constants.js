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
  // Lift multiplier for batted balls, fitted so carry matches Statcast distance
  // references (RMS 7 ft over 90–110 mph, 15–30°). Pitches use per-pitch calibration instead.
  battedLiftScale: 0.75,
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
  planeMatch: 0.7,                        // fraction of the swing-path rise that follows the pitch's descent angle
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
  // Rolling deceleration = rolling·g + rollDrag·v² (grass and skipping hops slow fast rollers hard).
  grass: { restitution: 0.45, friction: 0.40, rolling: 0.25, rollDrag: 0.015 },
  dirt: { restitution: 0.50, friction: 0.30, rolling: 0.35, rollDrag: 0.006 },
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

// speed: top sprint speed (m/s); accel: m/s^2 from a standing start; react: s before the first step
// (infielders are set and read the ball off the bat); reach: glove + dive radius (m).
export const FIELDERS = deepFreeze([
  { pos: 'P', distFt: 58, sprayDeg: 0, speed: 6.5, accel: 4.5, react: 0.35, reach: 1.0, infield: true },
  { pos: '1B', infield: true, distFt: 110, sprayDeg: 33, speed: 7.6, accel: 6.0, react: 0.20, reach: 1.6 },
  { pos: '2B', infield: true, distFt: 150, sprayDeg: 17, speed: 7.6, accel: 6.0, react: 0.20, reach: 1.6 },
  { pos: 'SS', infield: true, distFt: 150, sprayDeg: -17, speed: 7.6, accel: 6.0, react: 0.20, reach: 1.6 },
  { pos: '3B', infield: true, distFt: 115, sprayDeg: -33, speed: 7.6, accel: 6.0, react: 0.20, reach: 1.6 },
  { pos: 'LF', infield: false, distFt: 290, sprayDeg: -28, speed: 8.2, accel: 4.5, react: 0.45, reach: 0.9 },
  { pos: 'CF', infield: false, distFt: 320, sprayDeg: 0, speed: 8.2, accel: 4.5, react: 0.45, reach: 0.9 },
  { pos: 'RF', infield: false, distFt: 290, sprayDeg: 28, speed: 8.2, accel: 4.5, react: 0.45, reach: 0.9 },
]);

export const FIELDING = deepFreeze({
  catchGrace: 0,                          // s of slack allowed when a fielder arrives just after the ball
  throwSpeed: 38,                         // m/s
  transferTime: 0.6,                      // s, glove to release (infield)
  outfieldTransferTime: 1.0,              // s, pick up a moving ball, set and throw
  outfieldThrowSpeed: 30,                 // m/s effective, including arc and cut-off
  timeToFirst: { R: 4.25, L: 4.10 },      // s, home to first
  timeBetweenBases: 3.9,                  // s, each additional base
  extraBaseMargin: 0.3,                   // s the runner wants in hand before taking a base
  catchHeight: 2.4,                       // m, highest a fielder can catch / field the ball
  foulPlayableDepth: 15,                  // m of foul territory where pop-ups can be caught
});

export const SIM = deepFreeze({
  pitchStep: 0.001,                       // s
  battedStep: 0.002,                      // s
  maxPitchTime: 1.5,                      // s
  pitchEndZ: 0.9,                         // m, catcher's glove depth behind the plate tip
  maxBattedTime: 12,                      // s
  visualSpinCapRevPerSec: 9,
});
