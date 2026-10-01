// The baseball: leather sphere + real seam geometry (108 double stitches along
// the classic two-lobe seam curve), a seam-orientation helper so 4-seam vs
// 2-seam pitches present correctly, a fading trail ribbon, and a contact shadow.

import * as THREE from 'three';
import { BALL } from '../core/constants.js';
import { leatherTextures, radialTexture } from './textures.js';

const R = BALL.radius;
// Seam curve on the unit sphere: s(t) = (a cos t + b cos 3t, a sin t − b sin 3t, 2√(ab) sin 2t), a + b = 1.
const SEAM_A = 0.62, SEAM_B = 0.38;
const SEAM_C = 2 * Math.sqrt(SEAM_A * SEAM_B);

export function seamPoint(t, out = new THREE.Vector3()) {
  return out.set(
    SEAM_A * Math.cos(t) + SEAM_B * Math.cos(3 * t),
    SEAM_A * Math.sin(t) - SEAM_B * Math.sin(3 * t),
    SEAM_C * Math.sin(2 * t),
  );
}

function seamTangent(t, out = new THREE.Vector3()) {
  return out.set(
    -SEAM_A * Math.sin(t) - 3 * SEAM_B * Math.sin(3 * t),
    SEAM_A * Math.cos(t) - 3 * SEAM_B * Math.cos(3 * t),
    2 * SEAM_C * Math.cos(2 * t),
  ).normalize();
}

/** Number of times a great circle perpendicular to `axis` crosses the seam (how many seams a spin about it shows). */
export function seamCrossings(axis, samples = 2048) {
  let count = 0, prev = null;
  const p = new THREE.Vector3();
  for (let i = 0; i <= samples; i++) {
    const d = seamPoint((i / samples) * Math.PI * 2, p).dot(axis);
    if (prev !== null && Math.sign(d) !== Math.sign(prev)) count++;
    prev = d;
  }
  return count;
}

/** Local spin axes for each seam presentation, found once by searching the sphere. */
const SEAM_AXES = (() => {
  const fourSeam = new THREE.Vector3(0, 0, 1); // the equator z = 0 meets the seam 4 times
  let twoSeam = null, best = Infinity;
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < 400; i++) {
    const y = 1 - (i / 399) * 2, r = Math.sqrt(1 - y * y);
    const axis = new THREE.Vector3(Math.cos(golden * i) * r, y, Math.sin(golden * i) * r);
    const n = seamCrossings(axis, 512);
    if (n < best) { best = n; twoSeam = axis; }
  }
  return { fourSeam, twoSeam };
})();

const PRESENTATION = { FF: 'fourSeam', FC: 'fourSeam', SL: 'fourSeam', ST: 'fourSeam', SI: 'twoSeam', CH: 'twoSeam', FS: 'twoSeam', CU: 'fourSeam', KC: 'fourSeam' };

export class Ball {
  constructor({ anisotropy = 4 } = {}) {
    this.group = new THREE.Group();
    this.group.name = 'ball';
    this.spinner = new THREE.Group(); // rotates with the ball's spin
    this.group.add(this.spinner);

    const leather = leatherTextures();
    leather.map.anisotropy = anisotropy;
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(R, 48, 32),
      new THREE.MeshPhysicalMaterial({ map: leather.map, normalMap: leather.normalMap, normalScale: new THREE.Vector2(0.4, 0.4), roughness: 0.55, sheen: 0.4, sheenColor: new THREE.Color(0xffffff), sheenRoughness: 0.6 }),
    );
    sphere.castShadow = true;
    this.spinner.add(sphere);

    // Seam groove.
    const curve = new (class extends THREE.Curve {
      getPoint(u, out = new THREE.Vector3()) { return seamPoint(u * Math.PI * 2, out).multiplyScalar(R * 1.0004); }
    })();
    const groove = new THREE.Mesh(new THREE.TubeGeometry(curve, 400, 0.00075, 6, true), new THREE.MeshStandardMaterial({ color: 0xd8d0bf, roughness: 0.7 }));
    this.spinner.add(groove);

    // 108 double stitches: two short strands forming a V that points along the seam.
    const stitchGeo = new THREE.BoxGeometry(1, 0.0011, 0.0009);
    const stitchMat = new THREE.MeshStandardMaterial({ color: 0xc8102e, roughness: 0.6 });
    const stitches = new THREE.InstancedMesh(stitchGeo, stitchMat, 216);
    const p = new THREE.Vector3(), t = new THREE.Vector3(), side = new THREE.Vector3();
    const a = new THREE.Vector3(), b = new THREE.Vector3(), mid = new THREE.Vector3(), dir = new THREE.Vector3(), up = new THREE.Vector3();
    const basis = new THREE.Matrix4(), m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    let k = 0;
    for (let i = 0; i < 108; i++) {
      const u = ((i + 0.5) / 108) * Math.PI * 2;
      seamPoint(u, p).normalize();
      seamTangent(u, t);
      side.crossVectors(p, t).normalize();
      for (const sgn of [-1, 1]) {
        a.copy(p).addScaledVector(side, sgn * 0.085).addScaledVector(t, -0.03).normalize().multiplyScalar(R * 1.0006);
        b.copy(p).addScaledVector(t, 0.025).normalize().multiplyScalar(R * 1.0006);
        mid.addVectors(a, b).multiplyScalar(0.5).setLength(R * 1.0008);
        dir.subVectors(b, a);
        const len = dir.length();
        dir.normalize();
        up.copy(mid).normalize();
        const zAxis = new THREE.Vector3().crossVectors(dir, up).normalize();
        up.crossVectors(zAxis, dir).normalize();
        basis.makeBasis(dir, up, zAxis);
        q.setFromRotationMatrix(basis);
        stitches.setMatrixAt(k++, m.compose(mid, q, s.set(len, 1, 1)));
      }
    }
    stitches.castShadow = false;
    this.spinner.add(stitches);

    // Trail ribbon (camera-facing, built each frame).
    this.trailMax = 48;
    this.trailPts = [];
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.trailMax * 2 * 3), 3));
    tg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.trailMax * 2 * 4), 4));
    const idx = [];
    for (let i = 0; i < this.trailMax - 1; i++) {
      const v = i * 2;
      idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
    }
    tg.setIndex(idx);
    this.trail = new THREE.Mesh(tg, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false }));
    this.trail.frustumCulled = false;
    this.trail.visible = false;
    this.trailColor = new THREE.Color(0xffffff);
    this.trailWidth = 0.035;

    // Contact shadow (always visible, independent of the shadow-map frustum).
    this.blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: radialTexture({ inner: 'rgba(0,0,0,0.85)' }), transparent: true, depthWrite: false }));
    this.blob.rotation.x = -Math.PI / 2;
    this.blob.renderOrder = 2;

    this._dq = new THREE.Quaternion();
    this._axis = new THREE.Vector3();
    this.setVisible(false);
  }

  addTo(scene) {
    scene.add(this.group, this.trail, this.blob);
  }

  setVisible(v) {
    this.group.visible = v;
    this.blob.visible = v;
    if (!v) this.trail.visible = false;
  }

  /** Orients the seams for a pitch: the presentation's local axis is aligned with the world spin axis. */
  orientForPitch(code, spin, roll = 0) {
    const w = this._axis.set(spin[0], spin[1], spin[2]);
    if (w.lengthSq() < 1e-12) return;
    w.normalize();
    const local = SEAM_AXES[PRESENTATION[code] ?? 'fourSeam'];
    this.spinner.quaternion.setFromUnitVectors(local, w);
    this._dq.setFromAxisAngle(w, roll);
    this.spinner.quaternion.premultiply(this._dq);
  }

  /** Rotates the ball by world angular velocity ω (rad/s) over dt, optionally capping the visual rate. */
  spin(omega, dt, capRadPerSec = Infinity) {
    const w = this._axis.set(omega[0], omega[1], omega[2]);
    const rate = w.length();
    if (rate < 1e-9 || dt === 0) return;
    const angle = Math.min(rate, capRadPerSec) * dt;
    this._dq.setFromAxisAngle(w.divideScalar(rate), angle);
    this.spinner.quaternion.premultiply(this._dq).normalize();
  }

  setPosition(x, y, z) {
    this.group.position.set(x, y, z);
    const h = Math.max(0, y - R);
    this.blob.position.set(x, 0.012, z);
    const size = 0.1 + h * 0.035;
    this.blob.scale.set(size, size, 1);
    this.blob.material.opacity = 0.6 * Math.exp(-h / 2.5);
  }

  resetTrail(color) {
    this.trailPts.length = 0;
    if (color) this.trailColor.set(color);
  }

  pushTrail(pos) {
    const last = this.trailPts[this.trailPts.length - 1];
    if (last && last.distanceToSquared(pos) < 0.04 * 0.04) return;
    this.trailPts.push(pos.clone());
    if (this.trailPts.length > this.trailMax) this.trailPts.shift();
  }

  /** Rebuilds the camera-facing trail strip. */
  updateTrail(camera, enabled) {
    const n = this.trailPts.length;
    this.trail.visible = enabled && n > 1;
    if (!this.trail.visible) return;
    const pos = this.trail.geometry.attributes.position.array;
    const col = this.trail.geometry.attributes.color.array;
    const tangent = new THREE.Vector3(), toCam = new THREE.Vector3(), sideV = new THREE.Vector3();
    for (let i = 0; i < this.trailMax; i++) {
      const j = Math.min(i, n - 1);
      const pt = this.trailPts[j];
      const nb = this.trailPts[Math.min(j + 1, n - 1)], pv = this.trailPts[Math.max(j - 1, 0)];
      tangent.subVectors(nb, pv).normalize();
      toCam.subVectors(camera.position, pt).normalize();
      sideV.crossVectors(tangent, toCam).normalize();
      const f = n > 1 ? j / (n - 1) : 1; // 0 = oldest
      const w = this.trailWidth * (0.25 + 0.75 * f);
      for (let s2 = 0; s2 < 2; s2++) {
        const o = (i * 2 + s2) * 3;
        const sg = s2 === 0 ? -1 : 1;
        pos[o] = pt.x + sideV.x * w * sg;
        pos[o + 1] = pt.y + sideV.y * w * sg;
        pos[o + 2] = pt.z + sideV.z * w * sg;
        const c = (i * 2 + s2) * 4;
        const alpha = i < n ? f * f * 0.85 : 0;
        col[c] = this.trailColor.r; col[c + 1] = this.trailColor.g; col[c + 2] = this.trailColor.b; col[c + 3] = alpha;
      }
    }
    this.trail.geometry.attributes.position.needsUpdate = true;
    this.trail.geometry.attributes.color.needsUpdate = true;
    this.trail.geometry.computeBoundingSphere();
  }
}

export { SEAM_AXES };
