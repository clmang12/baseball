// Player figures built procedurally from primitives (no model files).
// Phase 3: the batter and his bat. The bat is driven every frame by the same
// SwingModel.pose(t) the physics uses for contact, so what you see is exactly
// what was hit (or missed). Pitcher windup, catcher, umpire and the seven
// fielders join in Phase 5 using the same rig helpers.

import * as THREE from 'three';
import { BAT } from '../core/constants.js';
import { IN } from '../core/units.js';
import { TEAMS } from '../PlayerStats.js';

const UP = new THREE.Vector3(0, 1, 0);

/** Wood bat along +y from the knob (y = 0) to the end cap (y = L). */
function batGeometry() {
  const L = BAT.length;
  const prof = [
    [0, 0], [0.021, 0.002], [0.022, 0.012], [0.013, 0.028], [0.0118, 0.10], [0.0122, 0.30],
    [0.016, 0.44], [0.025, 0.55], [0.031, 0.64], [BAT.barrelRadius, 0.74], [BAT.barrelRadius, L - 0.012],
    [0.03, L - 0.004], [0.018, L], [0, L],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  return new THREE.LatheGeometry(prof, 24);
}

/** A capsule mesh stretched between two points each frame. */
class Limb {
  constructor(radius, material) {
    this.mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, 1, 4, 10), material);
    this.mesh.castShadow = true;
    this.radius = radius;
    this._d = new THREE.Vector3();
  }

  set(a, b) {
    const d = this._d.subVectors(b, a);
    const len = Math.max(1e-4, d.length());
    this.mesh.position.addVectors(a, b).multiplyScalar(0.5);
    this.mesh.quaternion.setFromUnitVectors(UP, d.divideScalar(len));
    this.mesh.scale.set(1, len, 1);
  }
}

/** Two-bone IK: elbow/knee position for root→end with segment lengths a, b, bending toward `pole`. */
function solveTwoBone(root, end, a, b, pole, out) {
  const dir = new THREE.Vector3().subVectors(end, root);
  const d = Math.min(Math.max(dir.length(), 1e-4), a + b - 1e-4);
  dir.normalize();
  const x = (a * a - b * b + d * d) / (2 * d);
  const y = Math.sqrt(Math.max(0, a * a - x * x));
  const bend = pole.clone().sub(dir.clone().multiplyScalar(pole.dot(dir))).normalize();
  return out.copy(root).addScaledVector(dir, x).addScaledVector(bend, y);
}

export class BatterFigure {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'batter';
    this.jersey = new THREE.MeshStandardMaterial({ color: 0x0c2340, roughness: 0.75 });
    this.pants = new THREE.MeshStandardMaterial({ color: 0xd9dbe0, roughness: 0.8 });
    this.skin = new THREE.MeshStandardMaterial({ color: 0xa8775a, roughness: 0.7 });
    this.helmet = new THREE.MeshPhysicalMaterial({ color: 0x0c2340, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.15 });
    this.dark = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6 });
    this.batMat = new THREE.MeshPhysicalMaterial({ color: 0xc8925c, roughness: 0.38, clearcoat: 0.8, clearcoatRoughness: 0.2 });

    this.bat = new THREE.Mesh(batGeometry(), this.batMat);
    this.bat.castShadow = true;
    this.group.add(this.bat);

    this.thighL = new Limb(0.1, this.pants); this.shinL = new Limb(0.075, this.pants);
    this.thighR = new Limb(0.1, this.pants); this.shinR = new Limb(0.075, this.pants);
    this.torso = new Limb(0.19, this.jersey);
    this.upperL = new Limb(0.065, this.jersey); this.foreL = new Limb(0.05, this.skin);
    this.upperR = new Limb(0.065, this.jersey); this.foreR = new Limb(0.05, this.skin);
    for (const l of [this.thighL, this.shinL, this.thighR, this.shinR, this.torso, this.upperL, this.foreL, this.upperR, this.foreR]) {
      this.group.add(l.mesh);
    }
    // Pelvis, shoulder caps, gloves and a belt give the silhouette some mass.
    this.pelvis = new THREE.Mesh(new THREE.SphereGeometry(0.19, 16, 12), this.pants);
    this.pelvis.scale.set(1, 0.75, 0.85);
    this.belt = new THREE.Mesh(new THREE.CylinderGeometry(0.175, 0.175, 0.05, 16), this.dark);
    this.capL = new THREE.Mesh(new THREE.SphereGeometry(0.085, 12, 10), this.jersey);
    this.capR = this.capL.clone();
    this.gloveL = new THREE.Mesh(new THREE.SphereGeometry(0.048, 12, 10), this.dark);
    this.gloveR = this.gloveL.clone();
    for (const m of [this.pelvis, this.belt, this.capL, this.capR, this.gloveL, this.gloveR]) {
      m.castShadow = true;
      this.group.add(m);
    }
    this.head = new THREE.Mesh(new THREE.SphereGeometry(0.105, 20, 14), this.skin);
    this.helmetMesh = new THREE.Mesh(new THREE.SphereGeometry(0.125, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.55), this.helmet);
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.012, 20, 1, false, 0, Math.PI), this.helmet);
    brim.rotation.x = Math.PI / 2;
    brim.position.set(0, -0.01, 0.06);
    brim.rotation.z = Math.PI / 2;
    this.helmetMesh.add(brim);
    this.head.add(this.helmetMesh);
    this.helmetMesh.position.y = 0.02;
    this.head.castShadow = this.helmetMesh.castShadow = true;
    this.group.add(this.head);
    this.footL = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.08, 0.28), this.dark);
    this.footR = this.footL.clone();
    this.footL.castShadow = this.footR.castShadow = true;
    this.group.add(this.footL, this.footR);

    this.swing = null;
    this.offset = 0;
    this.hb = 1;
    this.scale = 1;
    this._v = {};
    for (const k of ['hip', 'neck', 'shL', 'shR', 'hL', 'hR', 'elL', 'elR', 'kneeL', 'kneeR', 'ankL', 'ankR', 'hipL', 'hipR', 'knob', 'dir', 'tmp']) this._v[k] = new THREE.Vector3();
    this._qStance = new THREE.Quaternion();
    this._qSwing = new THREE.Quaternion();
    this.setBatter(null, 1);
  }

  /** Configure for a batter: team colours, height scaling and batting side. */
  setBatter(batter, hb) {
    this.hb = hb;
    if (batter) {
      const team = TEAMS[batter.team];
      this.jersey.color.set(team?.primary ?? '#0c2340');
      this.helmet.color.set(team?.primary ?? '#0c2340');
      this.scale = (batter.heightIn * IN) / 1.88;
    }
    // Body position: in the batter's box, centred alongside the plate.
    this.base = new THREE.Vector3(-hb * 1.02, 0, -0.22);
    this.group.visible = true;
  }

  attachSwing(swing, offset) {
    this.swing = swing;
    this.offset = offset;
  }

  /** Bat pose for the loaded stance: hands by the back shoulder, barrel up and back. */
  _stance(knob, dir) {
    const s = this.scale, hb = this.hb, b = this.base;
    knob.set(b.x + hb * 0.12 * s, 1.18 * s, b.z + 0.16 * s);
    dir.set(-hb * 0.25, 0.9, 0.42).normalize();
  }

  update(tSim) {
    const v = this._v, s = this.scale, hb = this.hb, b = this.base;

    // --- Bat transform: stance, physics swing, or a blend at swing start.
    this._stance(v.knob, v.dir);
    this._qStance.setFromUnitVectors(UP, v.dir);
    let w = 0, psi = 0;
    if (this.swing) {
      const t = tSim - this.offset;
      w = smooth((t - this.swing.tStart) / 0.09);
      if (w > 0) {
        const pose = this.swing.pose(t);
        psi = pose.psi;
        this._qSwing.setFromUnitVectors(UP, v.tmp.set(...pose.aHat));
        const knobSwing = v.tmp.set(...pose.knob);
        v.knob.lerp(knobSwing, w);
      }
    }
    this.bat.position.copy(v.knob);
    this.bat.quaternion.copy(this._qStance).slerp(this._qSwing, w);
    v.dir.copy(UP).applyQuaternion(this.bat.quaternion);

    // --- Body: torso yaws with the swing (clamped), knees flex slightly.
    const yaw = -hb * Math.max(-0.6, Math.min(1.3, w > 0 ? 0.55 * psi + 0.35 : 0));
    const facing = new THREE.Vector3(hb, 0, 0).applyAxisAngle(UP, yaw);    // toward the plate
    const toPitcher = new THREE.Vector3(0, 0, -1).applyAxisAngle(UP, yaw);
    v.hip.set(b.x, 0.98 * s, b.z);
    v.neck.copy(v.hip).addScaledVector(UP, 0.5 * s).addScaledVector(facing, 0.07 * s);
    this.torso.set(v.tmp.copy(v.hip).addScaledVector(UP, 0.12 * s), v.neck);
    this.head.position.copy(v.neck).addScaledVector(UP, 0.17 * s).addScaledVector(facing, 0.02);
    this.head.lookAt(new THREE.Vector3(0, 1.8, -18.4));

    v.shL.copy(v.neck).addScaledVector(UP, -0.05 * s).addScaledVector(toPitcher, 0.19 * s);  // front shoulder
    v.shR.copy(v.neck).addScaledVector(UP, -0.05 * s).addScaledVector(toPitcher, -0.19 * s); // back shoulder
    // Hands on the handle: bottom hand at the knob, top hand just above it.
    v.hL.copy(v.knob).addScaledVector(v.dir, 0.03);
    v.hR.copy(v.knob).addScaledVector(v.dir, 0.1);
    const armPole = new THREE.Vector3(0, -1, 0).addScaledVector(facing, -0.4);
    solveTwoBone(v.shL, v.hL, 0.3 * s, 0.29 * s, armPole, v.elL);
    solveTwoBone(v.shR, v.hR, 0.3 * s, 0.29 * s, armPole, v.elR);
    this.upperL.set(v.shL, v.elL); this.foreL.set(v.elL, v.hL);
    this.upperR.set(v.shR, v.elR); this.foreR.set(v.elR, v.hR);
    this.capL.position.copy(v.shL);
    this.capR.position.copy(v.shR);
    this.gloveL.position.copy(v.hL);
    this.gloveR.position.copy(v.hR);
    this.pelvis.position.copy(v.hip);
    this.pelvis.rotation.y = yaw;
    this.belt.position.copy(v.hip).addScaledVector(UP, 0.1 * s);

    // Legs: front foot strides toward the pitcher once the swing starts.
    const stride = 0.12 * w;
    v.hipL.copy(v.hip).addScaledVector(toPitcher, 0.11 * s);
    v.hipR.copy(v.hip).addScaledVector(toPitcher, -0.11 * s);
    v.ankL.set(b.x, 0.07, b.z - (0.38 + stride) * s);
    v.ankR.set(b.x, 0.07, b.z + 0.36 * s);
    const kneePole = new THREE.Vector3(0, 0, 0).addScaledVector(facing, 1).add(new THREE.Vector3(0, 0.2, 0));
    solveTwoBone(v.hipL, v.ankL, 0.47 * s, 0.46 * s, kneePole, v.kneeL);
    solveTwoBone(v.hipR, v.ankR, 0.47 * s, 0.46 * s, kneePole, v.kneeR);
    this.thighL.set(v.hipL, v.kneeL); this.shinL.set(v.kneeL, v.ankL);
    this.thighR.set(v.hipR, v.kneeR); this.shinR.set(v.kneeR, v.ankR);
    this.footL.position.set(v.ankL.x + hb * 0.05, 0.04, v.ankL.z);
    this.footR.position.set(v.ankR.x + hb * 0.05, 0.04, v.ankR.z);
    this.footL.rotation.y = this.footR.rotation.y = Math.PI / 2 - hb * 0.2;
  }
}

const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
