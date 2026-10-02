// Camera rig: preset views with eased transitions, a ball-chase mode and
// contact shake. Positions are in the physics frame (metres; -z toward the mound).

import * as THREE from 'three';

const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** Preset views. `hb` is the batter's hand sign (+1 right-handed, -1 left-handed). */
export const VIEWS = {
  // Over the batter's back shoulder, looking out at the release point.
  batting: (hb = 1) => ({ pos: [-hb * 0.55, 1.62, 1.35], target: [0.15 * hb, 1.15, -18.4], fov: 38 }),
  // Gameplay pitching camera: behind the mound on a long lens so the zone is big enough to aim at.
  pitching: () => ({ pos: [0, 2.4, -24.5], target: [0, 0.85, -0.3], fov: 13, maxWiden: 1.5 }),
  // Wide cinematic view from behind and above the mound.
  mound: () => ({ pos: [0, 3.6, -27.5], target: [0, 0.85, -1], fov: 34 }),
  // Classic TV centre-field camera: long lens, slightly off-centre — shows break best.
  broadcast: () => ({ pos: [-1.1, 4.6, -38], target: [0, 0.95, 0], fov: 11 }),
  // Side-on over the plate for slow-motion replays.
  replaySide: (hb = 1) => ({ pos: [hb * 5.2, 1.15, -0.9], target: [0, 0.95, -0.9], fov: 26 }),
  // High behind home: follow fly balls into the outfield.
  highHome: () => ({ pos: [0, 24, 30], target: [0, 0, -80], fov: 50 }),
  centerfield: () => ({ pos: [0, 32, -150], target: [0, 0, -40], fov: 45 }),
  // Batted-ball broadcast camera: fixed high behind home; the target and zoom follow the ball.
  track: () => ({ pos: [0, 15, 24], target: [0, 2, -30], fov: 50 }),
};

export class CameraRig {
  constructor(aspect = 16 / 9) {
    this.camera = new THREE.PerspectiveCamera(38, aspect, 0.1, 2500);
    this.mode = 'pitching';
    this.cur = { pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: 38 };
    this.from = null;
    this.to = null;
    this.blend = 1;
    this.blendDur = 0.6;
    this.follow = null; // { pos: Vector3, vel: Vector3 }
    this.shakeAmp = 0;
    this.shakeTime = 0;
    this.shakeDur = 0;
    this.idle = 0;
    this._tmp = new THREE.Vector3();
    this.set('pitching', {}, 0);
  }

  /** Switch to a preset (or 'chase') with an eased transition of `duration` seconds. */
  set(mode, opts = {}, duration = 0.6) {
    this.mode = mode;
    this._trackTarget = null;
    this.opts = opts;
    const goal = mode === 'chase' ? this._chaseGoal() : this._preset(mode, opts);
    this.from = { pos: this.cur.pos.clone(), target: this.cur.target.clone(), fov: this.cur.fov };
    this.to = goal;
    this.blendDur = duration;
    this.blend = duration > 0 ? 0 : 1;
    if (duration === 0) this._apply(goal);
  }

  _preset(mode, opts) {
    const v = (VIEWS[mode] ?? VIEWS.pitching)(opts.hb);
    this.maxWiden = v.maxWiden ?? Infinity;
    return { pos: new THREE.Vector3(...v.pos), target: new THREE.Vector3(...v.target), fov: v.fov };
  }

  /** Chase goal: behind and above the ball along its horizontal velocity, looking slightly ahead. */
  _chaseGoal() {
    if (!this.follow) return { pos: this.cur.pos.clone(), target: this.cur.target.clone(), fov: this.cur.fov };
    const { pos, vel } = this.follow;
    const h = this._tmp.set(vel.x, 0, vel.z);
    const speed = h.length() || 1;
    h.divideScalar(speed);
    const camPos = new THREE.Vector3(pos.x - h.x * 14, Math.max(4, pos.y + 5), pos.z - h.z * 14);
    const target = new THREE.Vector3(pos.x + h.x * 6, pos.y * 0.85, pos.z + h.z * 6);
    return { pos: camPos, target, fov: 42 + Math.min(18, speed * 0.4) };
  }

  setFollow(pos, vel) {
    this.follow = { pos: pos.clone(), vel: vel.clone() };
  }

  shake(amplitude = 0.02, duration = 0.12) {
    this.shakeAmp = amplitude;
    this.shakeDur = duration;
    this.shakeTime = duration;
  }

  /**
   * Preset FOVs are vertical FOVs authored for 16:9. On narrower screens (portrait
   * phones) widen the vertical FOV so the horizontal coverage stays the same.
   */
  fitFov(fov) {
    const ref = 16 / 9;
    if (this.camera.aspect >= ref) return fov;
    // Gameplay views cap the widening so the strike zone stays large enough to aim at.
    const widen = Math.min(ref / this.camera.aspect, this.maxWiden ?? Infinity);
    const half = Math.atan(Math.tan((fov * Math.PI) / 360) * widen);
    return Math.min(80, (half * 360) / Math.PI);
  }

  setAspect(aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  _apply(s) {
    this.cur.pos.copy(s.pos);
    this.cur.target.copy(s.target);
    this.cur.fov = s.fov;
  }

  update(dt) {
    this.idle += dt;
    if (this.mode === 'track') {
      // Position eases to the fixed broadcast spot; the look-at point and zoom chase the ball.
      const goal = this.to;
      if (this.blend < 1) this.blend = Math.min(1, this.blend + dt / Math.max(1e-6, this.blendDur));
      const e = ease(this.blend);
      this.cur.pos.lerpVectors(this.from.pos, goal.pos, e);
      if (this.follow) {
        const k = 1 - Math.exp(-dt * 7);
        const aim = this._tmp.copy(this.follow.pos);
        aim.y *= 0.8;
        if (!this._trackTarget) this._trackTarget = this.from.target.clone();
        this._trackTarget.lerp(aim, k);
        this.cur.target.lerpVectors(this.from.target, this._trackTarget, e);
        const dist = this.cur.pos.distanceTo(this.follow.pos);
        const fovGoal = Math.max(20, Math.min(52, (2 * Math.atan(26 / Math.max(1, dist)) * 180) / Math.PI));
        this.cur.fov += (fovGoal - this.cur.fov) * k;
      }
    } else if (this.mode === 'chase') {
      // Critically damped follow toward the moving goal.
      const goal = this._chaseGoal();
      const k = 1 - Math.exp(-dt * 4);
      if (this.blend < 1) {
        this.blend = Math.min(1, this.blend + dt / Math.max(1e-6, this.blendDur));
        const e = ease(this.blend);
        this.cur.pos.lerpVectors(this.from.pos, goal.pos, e);
        this.cur.target.lerpVectors(this.from.target, goal.target, e);
        this.cur.fov = this.from.fov + (goal.fov - this.from.fov) * e;
      } else {
        this.cur.pos.lerp(goal.pos, k);
        this.cur.target.lerp(goal.target, Math.min(1, k * 2));
        this.cur.fov += (goal.fov - this.cur.fov) * k;
      }
    } else if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / Math.max(1e-6, this.blendDur));
      const e = ease(this.blend);
      this.cur.pos.lerpVectors(this.from.pos, this.to.pos, e);
      this.cur.target.lerpVectors(this.from.target, this.to.target, e);
      this.cur.fov = this.from.fov + (this.to.fov - this.from.fov) * e;
    }

    const cam = this.camera;
    cam.position.copy(this.cur.pos);
    // Gentle breathing sway on the hand-held batting view.
    if (this.mode === 'batting' && this.blend >= 1) {
      cam.position.x += Math.sin(this.idle * 1.5 * Math.PI * 2 * 0.2) * 0.004;
      cam.position.y += Math.sin(this.idle * 1.1 * Math.PI * 2 * 0.2) * 0.003;
    }
    if (this.shakeTime > 0) {
      this.shakeTime = Math.max(0, this.shakeTime - dt);
      const decay = this.shakeTime / this.shakeDur;
      const a = this.shakeAmp * decay;
      cam.position.x += Math.sin(this.shakeTime * 190) * a;
      cam.position.y += Math.cos(this.shakeTime * 230) * a;
    }
    cam.lookAt(this.cur.target);
    const fov = this.fitFov(this.cur.fov);
    if (Math.abs(cam.fov - fov) > 1e-4) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }
}
