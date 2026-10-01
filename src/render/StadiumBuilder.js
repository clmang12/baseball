// Seating bowl, crowd, light towers, video board and night sky, raised from
// the field boundary loop produced by FieldBuilder. Everything repetitive is
// instanced so the whole stadium costs a handful of draw calls.

import * as THREE from 'three';
import { Rng } from '../core/rng.js';
import { lampTexture, crowdAlpha, skyTexture } from './textures.js';

const FIELD_CENTRE = new THREE.Vector2(0, -45);

/** Outward (away-from-field) unit normals for each loop vertex, in the xz plane. */
function outwardNormals(loop) {
  const n = loop.length;
  return loop.map((v, i) => {
    const a = loop[(i - 1 + n) % n].p, b = loop[(i + 1) % n].p;
    let nx = b[1] - a[1], nz = -(b[0] - a[0]);
    const len = Math.hypot(nx, nz) || 1;
    nx /= len; nz /= len;
    if (nx * (v.p[0] - FIELD_CENTRE.x) + nz * (v.p[1] - FIELD_CENTRE.y) < 0) { nx = -nx; nz = -nz; }
    return [nx, nz];
  });
}

/** Splits the loop into contiguous runs of the same seating section. */
function sections(loop) {
  const runs = [];
  const group = (k) => (k === 'foul' || k === 'backstop' ? 'infield' : k);
  for (let i = 0; i < loop.length; i++) {
    const g = group(loop[i].kind);
    if (!runs.length || runs[runs.length - 1].g !== g) runs.push({ g, idx: [] });
    runs[runs.length - 1].idx.push(i);
  }
  return runs;
}

const TIERS = {
  infield: [
    { rows: 26, run: 0.85, rise: 0.42, offset0: 1.5, y0: 1.2 },
    { rows: 22, run: 0.8, rise: 0.55, offset0: 1.5 + 26 * 0.85 + 3, y0: 1.2 + 26 * 0.42 + 7 },
  ],
  outfield: [{ rows: 18, run: 0.85, rise: 0.45, offset0: 4, y0: 3.2 }],
  eye: [],
};

/**
 * Builds the stands and returns { group, lights, banks, videoBoard }.
 * `quality` 0–1 scales crowd density.
 */
export function buildStadium({ boundary, quality = 1, seed = 7 } = {}) {
  const rng = new Rng(seed);
  const group = new THREE.Group();
  group.name = 'stadium';
  const normals = outwardNormals(boundary);

  const seatMat = new THREE.MeshStandardMaterial({ color: 0x1c3f8f, roughness: 0.6 });

  const steps = [];  // {pts, nrm, tier}
  for (const run of sections(boundary)) {
    const idx = run.idx.slice();
    // Extend each run by one neighbour so sections meet without gaps.
    if (idx[0] > 0) idx.unshift(idx[0] - 1);
    for (const tier of TIERS[run.g]) steps.push({ idx, tier });
  }

  // Stepped concrete (riser + tread per row).
  const pos = [], ind = [];
  const seatSlots = [];
  for (const { idx, tier } of steps) {
    for (let k = 0; k < tier.rows; k++) {
      const off = tier.offset0 + k * tier.run;
      const y = tier.y0 + k * tier.rise;
      const ring = idx.map((i) => {
        const [px, pz] = boundary[i].p, [nx, nz] = normals[i];
        return { x: px + nx * off, z: pz + nz * off, nx, nz };
      });
      const base = pos.length / 3;
      for (const r of ring) {
        pos.push(r.x, y, r.z);                                        // riser bottom
        pos.push(r.x, y + tier.rise, r.z);                            // riser top / tread front
        pos.push(r.x + r.nx * tier.run, y + tier.rise, r.z + r.nz * tier.run); // tread back
      }
      for (let j = 1; j < ring.length; j++) {
        const a = base + (j - 1) * 3, b = base + j * 3;
        ind.push(a, b, a + 1, a + 1, b, b + 1);         // riser
        ind.push(a + 1, b + 1, a + 2, a + 2, b + 1, b + 2); // tread
        seatSlots.push({ a: ring[j - 1], b: ring[j], y: y + tier.rise });
      }
    }
    // Back wall behind the top row.
    const off = tier.offset0 + tier.rows * tier.run;
    const top = tier.y0 + tier.rows * tier.rise;
    const base = pos.length / 3;
    idx.forEach((i) => {
      const [px, pz] = boundary[i].p, [nx, nz] = normals[i];
      pos.push(px + nx * off, top, pz + nz * off, px + nx * off, top + 3, pz + nz * off);
    });
    for (let j = 1; j < idx.length; j++) {
      const a = base + (j - 1) * 2, b = base + j * 2;
      ind.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const bowlGeo = new THREE.BufferGeometry();
  bowlGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  bowlGeo.setIndex(ind);
  bowlGeo.computeVertexNormals();
  const bowl = new THREE.Mesh(bowlGeo, new THREE.MeshStandardMaterial({ color: 0x3a3f47, roughness: 0.92, side: THREE.DoubleSide }));
  bowl.receiveShadow = true;
  bowl.name = 'bowl';
  group.add(bowl);

  // Seat rows (one thin box per row segment) and seated fans.
  const seatGeo = new THREE.BoxGeometry(1, 0.42, 0.45);
  const seats = new THREE.InstancedMesh(seatGeo, seatMat, seatSlots.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);
  seatSlots.forEach((slot, i) => {
    const dx = slot.b.x - slot.a.x, dz = slot.b.z - slot.a.z;
    const len = Math.hypot(dx, dz);
    q.setFromAxisAngle(yAxis, Math.atan2(-dz, dx));
    p.set((slot.a.x + slot.b.x) / 2 + slot.a.nx * 0.35, slot.y + 0.21, (slot.a.z + slot.b.z) / 2 + slot.a.nz * 0.35);
    s.set(len, 1, 1);
    seats.setMatrixAt(i, m.compose(p, q, s));
  });
  seats.receiveShadow = true;
  seats.name = 'seats';
  group.add(seats);

  const palette = [0xf2f2f2, 0x1d2a5c, 0x0c2340, 0xc4ced3, 0x222222, 0xb3282d, 0x7a8597, 0xe8d9b5, 0x2f4f7f, 0xffffff, 0x3b3b3b, 0x9e1b32];
  const fans = [];
  const spacing = 0.62;
  const occupancy = 0.55 + 0.3 * quality;
  for (const slot of seatSlots) {
    const len = Math.hypot(slot.b.x - slot.a.x, slot.b.z - slot.a.z);
    const count = Math.floor(len / spacing);
    for (let k = 0; k < count; k++) {
      if (rng.next() > occupancy) continue;
      const t = (k + 0.5 + rng.uniform(-0.15, 0.15)) / count;
      fans.push({
        x: slot.a.x + (slot.b.x - slot.a.x) * t + slot.a.nx * 0.55,
        y: slot.y + 0.62 + rng.uniform(-0.05, 0.05),
        z: slot.a.z + (slot.b.z - slot.a.z) * t + slot.a.nz * 0.55,
        yaw: Math.atan2(-slot.a.nx, -slot.a.nz),
        color: palette[rng.int(palette.length)],
        scale: rng.uniform(0.9, 1.1),
      });
    }
  }
  const fanMat = new THREE.MeshLambertMaterial({ alphaMap: crowdAlpha(), alphaTest: 0.5, side: THREE.DoubleSide });
  const crowd = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.55, 0.85), fanMat, fans.length);
  const c = new THREE.Color();
  fans.forEach((f, i) => {
    q.setFromAxisAngle(yAxis, f.yaw);
    crowd.setMatrixAt(i, m.compose(p.set(f.x, f.y, f.z), q, s.set(f.scale, f.scale, 1)));
    crowd.setColorAt(i, c.setHex(f.color));
  });
  crowd.name = 'crowd';
  crowd.userData.fans = fans;
  group.add(crowd);

  // Batter's eye: matte black block in straight-away centre field.
  const eyeIdx = boundary.map((b, i) => (b.kind === 'eye' ? i : -1)).filter((i) => i >= 0);
  if (eyeIdx.length > 1) {
    const ePos = [], eInd = [];
    eyeIdx.forEach((i) => {
      const [px, pz] = boundary[i].p, [nx, nz] = normals[i];
      ePos.push(px + nx * 3, 0, pz + nz * 3, px + nx * 3, 12, pz + nz * 3);
    });
    for (let j = 1; j < eyeIdx.length; j++) {
      const a = (j - 1) * 2, b = j * 2;
      eInd.push(a, b, a + 1, a + 1, b, b + 1);
    }
    const eyeGeo = new THREE.BufferGeometry();
    eyeGeo.setAttribute('position', new THREE.Float32BufferAttribute(ePos, 3));
    eyeGeo.setIndex(eInd);
    eyeGeo.computeVertexNormals();
    group.add(new THREE.Mesh(eyeGeo, new THREE.MeshStandardMaterial({ color: 0x0b0d0c, roughness: 1, side: THREE.DoubleSide })));
  }

  // Light towers: six banks on top of the stands, aimed at the infield/outfield.
  const lampTex = lampTexture();
  const bankMat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xfff4e0, emissiveMap: lampTex, emissiveIntensity: 7, roughness: 0.4 });
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x5b6068, roughness: 0.6, metalness: 0.6 });
  const towerSprays = [-100, -62, -28, 28, 62, 100];
  const banks = [];
  const lights = [];
  for (const spray of towerSprays) {
    const i = nearestBySpray(boundary, spray);
    const [px, pz] = boundary[i].p, [nx, nz] = normals[i];
    const kind = boundary[i].kind;
    const back = kind === 'outfield' || kind === 'eye' ? 4 + 18 * 0.85 + 2 : 1.5 + 26 * 0.85 + 3 + 22 * 0.8 + 2;
    const x = px + nx * back, z = pz + nz * back;
    const h = kind === 'outfield' ? 42 : 52;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.8, h, 10), poleMat);
    pole.position.set(x, h / 2, z);
    group.add(pole);
    const bank = new THREE.Mesh(new THREE.BoxGeometry(12, 5.5, 0.8), [poleMat, poleMat, poleMat, poleMat, bankMat, poleMat]);
    bank.position.set(x, h + 2.5, z);
    const aim = new THREE.Vector3(0, 0, Math.abs(spray) < 50 ? -55 : -15);
    bank.lookAt(aim);
    group.add(bank);
    banks.push(bank);

    const spot = new THREE.SpotLight(0xfff1dc, 0, 0, 0.5, 0.75, 2);
    spot.position.copy(bank.position);
    spot.target.position.copy(aim);
    spot.userData.baseIntensity = 1;
    group.add(spot, spot.target);
    lights.push(spot);
  }

  // Video board above the centre-field bleachers.
  const boardCanvas = document.createElement('canvas');
  boardCanvas.width = 1024;
  boardCanvas.height = 384;
  const boardTex = new THREE.CanvasTexture(boardCanvas);
  boardTex.colorSpace = THREE.SRGBColorSpace;
  const board = new THREE.Mesh(new THREE.PlaneGeometry(34, 12.75), new THREE.MeshBasicMaterial({ map: boardTex, toneMapped: false }));
  const ci = nearestBySpray(boundary, 0);
  const [bx, bz] = boundary[ci].p;
  board.position.set(bx, 30, bz - 26);
  board.lookAt(0, 22, 0);
  const frame = new THREE.Mesh(new THREE.BoxGeometry(36, 14.5, 1), poleMat);
  frame.position.copy(board.position).add(new THREE.Vector3(0, 0, -0.6));
  frame.lookAt(0, 22, 0);
  const legs = new THREE.Mesh(new THREE.BoxGeometry(2, 24, 2), poleMat);
  legs.position.set(bx, 12, bz - 26.8);
  group.add(frame, board, legs);
  const videoBoard = { canvas: boardCanvas, texture: boardTex, mesh: board };

  // Night sky and stars.
  const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), new THREE.MeshBasicMaterial({ map: skyTexture(), side: THREE.BackSide, fog: false, depthWrite: false }));
  sky.name = 'sky';
  sky.renderOrder = -1;
  group.add(sky);
  const starPos = [];
  for (let i = 0; i < 1400; i++) {
    const u = rng.uniform(0.12, 1), th = rng.uniform(0, Math.PI * 2);
    const r = Math.sqrt(1 - u * u);
    starPos.push(Math.cos(th) * r * 850, u * 850, Math.sin(th) * r * 850);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
  group.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xbfc8ff, size: 1.4, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.7, depthWrite: false })));

  return { group, lights, banks, videoBoard, crowd, counts: { fans: fans.length, seatRows: seatSlots.length } };
}

function nearestBySpray(loop, sprayDeg) {
  let best = 0, bestErr = Infinity;
  loop.forEach((v, i) => {
    const s = Math.atan2(v.p[0], -v.p[1]) * 180 / Math.PI;
    const err = Math.abs(((s - sprayDeg + 540) % 360) - 180);
    if (err < bestErr) { bestErr = err; best = i; }
  });
  return best;
}

/** Redraws the video board with a title and up to five metric tiles. */
export function drawVideoBoard(videoBoard, { title = 'STATCAST', subtitle = '', metrics = [] } = {}) {
  const { canvas, texture } = videoBoard;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = '#050b14';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#1d4ed8';
  ctx.fillRect(0, 0, W, 8);
  ctx.font = '900 54px Inter, Arial, sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'top';
  ctx.fillText(title, 36, 32);
  ctx.font = '600 30px Inter, Arial, sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(subtitle, 36, 98);
  const colors = ['#22d3ee', '#c084fc', '#fbbf24', '#34d399', '#fb7185'];
  const tileW = (W - 72) / Math.max(1, metrics.length);
  metrics.forEach((mt, i) => {
    const x = 36 + i * tileW;
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(x + 4, 160, tileW - 8, 190);
    ctx.font = '700 24px Inter, Arial, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(mt.label, x + 20, 180);
    ctx.font = '900 76px Inter, Arial, sans-serif';
    ctx.fillStyle = colors[i % colors.length];
    ctx.fillText(mt.value, x + 20, 222);
    ctx.font = '700 24px Inter, Arial, sans-serif';
    ctx.fillStyle = '#64748b';
    ctx.fillText(mt.unit ?? '', x + 20, 310);
  });
  texture.needsUpdate = true;
}
