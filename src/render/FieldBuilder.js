// Playing field geometry: grass, infield skin, mound, plate, bases, chalk,
// warning track, outfield wall and foul poles. World units are metres in the
// physics frame (origin at the back tip of home plate, -z toward the pitcher,
// +x toward first base), so the field lines up exactly with the simulation.

import * as THREE from 'three';
import { FT, IN } from '../core/units.js';
import { PARK, FIELD, PLATE } from '../core/constants.js';
import { wallAt } from '../PhysicsEngine.js';
import { grassTextures, dirtTextures } from './textures.js';

const DEG = Math.PI / 180;
const RUBBER_D = 60.5 * FT;
const MOUND_D = 59 * FT;
const BASE_DIAG = 63.64 * FT; // half the home–2B diagonal

/** World (x, z) for a spray angle (deg, + = right field) and distance (m). */
export const sprayPoint = (sprayDeg, dist) => [Math.sin(sprayDeg * DEG) * dist, -Math.cos(sprayDeg * DEG) * dist];

/** Flat shape helper: shape coordinates (x, d) where d = -z (distance toward centre field). */
function flatMesh(shape, material, y, { curveSegments = 64 } = {}) {
  const geo = new THREE.ShapeGeometry(shape, curveSegments);
  geo.rotateX(-Math.PI / 2); // (x, d, 0) → (x, 0, -d)
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.y = y;
  mesh.receiveShadow = true;
  return mesh;
}

/** Uses world-space planar UVs so textures tile at a fixed metres-per-repeat. */
function worldUVs(geo, metresPerTile) {
  const pos = geo.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i) / metresPerTile;
    uv[i * 2 + 1] = pos.getZ(i) / metresPerTile;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** Polygon (shape coords) for the infield grass: the diamond inset by the base paths, with dirt cut-outs at each base. */
function infieldGrassPolygon() {
  const inset = 3 * FT;
  const half = BASE_DIAG - inset * Math.SQRT2;
  const centre = [0, BASE_DIAG];
  const corners = [[0, centre[1] - half], [half, centre[1]], [0, centre[1] + half], [-half, centre[1]]];
  const cuts = [
    { c: [0, 0], r: 13 * FT },              // home plate circle
    { c: [BASE_DIAG, BASE_DIAG], r: 13 * FT }, // first base cut-out
    { c: [0, 2 * BASE_DIAG], r: 13 * FT },  // second base
    { c: [-BASE_DIAG, BASE_DIAG], r: 13 * FT },
    { c: [0, MOUND_D], r: 9 * FT + 0.3 },   // mound
  ];
  const pts = [];
  for (let e = 0; e < 4; e++) {
    const a = corners[e], b = corners[(e + 1) % 4];
    for (let i = 0; i < 120; i++) {
      const s = i / 120;
      let p = [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s];
      for (const { c, r } of cuts.slice(0, 4)) {
        const dx = p[0] - c[0], dy = p[1] - c[1], d = Math.hypot(dx, dy);
        if (d < r) p = [c[0] + (dx / d) * r, c[1] + (dy / d) * r];
      }
      pts.push(p);
    }
  }
  return pts;
}

/** Outline (shape coords) of the infield skin: arc in fair ground, base paths, home circle. */
function skinOutline() {
  const R = 95 * FT, path = 3 * FT, rHome = 13 * FT;
  const pts = [];
  // Distance s along a foul line (sign -1 = third base) to the skin arc, on the path's outer edge.
  const lineDir = (sign) => [sign * Math.SQRT1_2, Math.SQRT1_2];
  const outward = (sign) => [sign * Math.SQRT1_2, -Math.SQRT1_2];
  const onPath = (sign, s) => {
    const d = lineDir(sign), o = outward(sign);
    return [d[0] * s + o[0] * path, d[1] * s + o[1] * path];
  };
  const reach = (sign) => { // solve |onPath(s) - (0, RUBBER_D)| = R for s
    let lo = 0, hi = 200 * FT;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2, [x, d] = onPath(sign, mid);
      if (Math.hypot(x, d - RUBBER_D) < R) lo = mid; else hi = mid;
    }
    return lo;
  };
  const sL = reach(-1), sR = reach(1);
  const angleOf = ([x, d]) => Math.atan2(d - RUBBER_D, x);
  // Home circle (behind the plate), from the first-base path round to the third-base path.
  const a0 = Math.atan2(onPath(1, rHome)[1], onPath(1, rHome)[0]);
  const a1 = Math.atan2(onPath(-1, rHome)[1], onPath(-1, rHome)[0]) - Math.PI * 2;
  for (let i = 0; i <= 32; i++) {
    const a = a0 + (a1 - a0) * (i / 32);
    pts.push([Math.cos(a) * rHome, Math.sin(a) * rHome]);
  }
  // Third-base path out to the arc.
  for (let i = 0; i <= 20; i++) pts.push(onPath(-1, rHome + (sL - rHome) * (i / 20)));
  // Arc across fair territory from the third-base side to the first-base side.
  let b0 = angleOf(onPath(-1, sL)), b1 = angleOf(onPath(1, sR));
  if (b1 > b0) b1 -= Math.PI * 2;
  for (let i = 1; i < 96; i++) {
    const a = b0 + (b1 - b0) * (i / 96);
    pts.push([Math.cos(a) * R, RUBBER_D + Math.sin(a) * R]);
  }
  // First-base path back toward home.
  for (let i = 0; i < 20; i++) pts.push(onPath(1, sR + (rHome - sR) * (i / 20)));
  return pts;
}

/** Closed loop (world x, z) bounding the playing field: foul-territory fence + outfield wall. */
export function fieldBoundary(park = PARK) {
  const loop = [];
  const offset = 45 * FT;
  const rBack = 60 * FT;
  const s0 = Math.sqrt(rBack * rBack - offset * offset);
  // Foul-line direction and the perpendicular pointing away from fair territory.
  const line = (sign) => ({
    dir: [sign * Math.SQRT1_2, -Math.SQRT1_2],
    perp: [sign * Math.SQRT1_2, Math.SQRT1_2],
  });
  const left = line(-1), right = line(1);
  const poleL = wallAt(-45, park).dist, poleR = wallAt(45, park).dist;
  // Left-field pole → down the left fence toward home.
  for (let i = 0; i <= 24; i++) {
    const s = poleL + (s0 - poleL) * (i / 24);
    loop.push({ p: [left.dir[0] * s + left.perp[0] * offset, left.dir[1] * s + left.perp[1] * offset], kind: 'foul' });
  }
  // Arc behind home plate.
  const a0 = Math.atan2(loop[loop.length - 1].p[1], loop[loop.length - 1].p[0]);
  const a1 = Math.PI - a0;
  for (let i = 1; i < 24; i++) {
    const a = a0 + (a1 - a0) * (i / 24);
    loop.push({ p: [Math.cos(a) * rBack, Math.sin(a) * rBack], kind: 'backstop' });
  }
  // Up the right fence to the right-field pole.
  for (let i = 0; i <= 24; i++) {
    const s = s0 + (poleR - s0) * (i / 24);
    loop.push({ p: [right.dir[0] * s + right.perp[0] * offset, right.dir[1] * s + right.perp[1] * offset], kind: 'foul' });
  }
  // Along the outfield wall from right field back to left field.
  for (let a = 45; a >= -45; a -= 1.5) {
    loop.push({ p: sprayPoint(a, wallAt(a, park).dist), kind: Math.abs(a) <= 8 ? 'eye' : 'outfield', spray: a });
  }
  return loop;
}

/**
 * Builds the field. Returns { group, boundary, materials } — boundary is the
 * loop StadiumBuilder raises the stands from.
 */
export function buildField({ park = PARK, anisotropy = 8 } = {}) {
  const group = new THREE.Group();
  group.name = 'field';

  const grass = grassTextures();
  const dirt = dirtTextures();
  const track = dirtTextures({ seed: 31, tint: [120, 86, 64] });
  for (const t of [grass.map, grass.normalMap, dirt.map, dirt.normalMap, track.map, track.normalMap]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = anisotropy;
  }

  const grassMat = new THREE.MeshStandardMaterial({ map: grass.map, normalMap: grass.normalMap, normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.93, metalness: 0 });
  const dirtMat = new THREE.MeshStandardMaterial({ map: dirt.map, normalMap: dirt.normalMap, normalScale: new THREE.Vector2(0.8, 0.8), roughness: 0.97, metalness: 0 });
  const trackMat = new THREE.MeshStandardMaterial({ map: track.map, normalMap: track.normalMap, roughness: 0.98 });
  const chalkMat = new THREE.MeshStandardMaterial({ color: 0xc9c7bf, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });

  // --- Grass: one big disc; 9 m tile = two 4.5 m mowing bands.
  const groundGeo = new THREE.CircleGeometry(230, 96);
  groundGeo.rotateX(-Math.PI / 2);
  worldUVs(groundGeo, 9);
  const ground = new THREE.Mesh(groundGeo, grassMat);
  ground.receiveShadow = true;
  ground.name = 'grass';
  group.add(ground);

  // --- Infield skin: the 95 ft arc about the rubber in fair territory, 3 ft base
  //     paths along the foul lines, and the 13 ft circle around home; minus the infield grass.
  const skin = new THREE.Shape(skinOutline().map(([x, d]) => new THREE.Vector2(x, d)));
  const hole = new THREE.Path(infieldGrassPolygon().map(([x, d]) => new THREE.Vector2(x, d)));
  skin.holes.push(hole);
  const skinMesh = flatMesh(skin, dirtMat, 0.004, { curveSegments: 128 });
  worldUVs(skinMesh.geometry, 6);
  skinMesh.name = 'infieldSkin';
  group.add(skinMesh);

  // --- Mound: lathe profile, 10 in high, 18 ft diameter, flat top around the rubber.
  const moundTop = FIELD.moundHeight;
  const profile = [];
  profile.push(new THREE.Vector2(0, moundTop));
  profile.push(new THREE.Vector2(0.9, moundTop));
  for (let i = 1; i <= 12; i++) {
    const s = i / 12;
    const r = 0.9 + (FIELD.moundRadius - 0.9) * s;
    profile.push(new THREE.Vector2(r, moundTop * (1 - s * s * (3 - 2 * s)) + 0.004));
  }
  const moundGeo = new THREE.LatheGeometry(profile.reverse(), 64);
  worldUVs(moundGeo, 6);
  const mound = new THREE.Mesh(moundGeo, dirtMat);
  mound.position.set(0, 0, -MOUND_D);
  mound.receiveShadow = true;
  mound.name = 'mound';
  group.add(mound);

  // --- Pitching rubber (24 x 6 in), front edge 60'6" from the plate tip.
  const rubber = new THREE.Mesh(new THREE.BoxGeometry(24 * IN, 0.03, 6 * IN), new THREE.MeshStandardMaterial({ color: 0xd8d6cf, roughness: 0.7 }));
  rubber.position.set(0, moundTop + 0.01, -(RUBBER_D + 3 * IN));
  rubber.receiveShadow = true;
  group.add(rubber);

  // --- Home plate: pentagon, tip at the origin, front edge at z = -17 in.
  const plateShape = new THREE.Shape([
    new THREE.Vector2(0, 0), new THREE.Vector2(8.5 * IN, 8.5 * IN), new THREE.Vector2(8.5 * IN, 17 * IN),
    new THREE.Vector2(-8.5 * IN, 17 * IN), new THREE.Vector2(-8.5 * IN, 8.5 * IN),
  ]);
  const plateGeo = new THREE.ExtrudeGeometry(plateShape, { depth: 0.012, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.004, bevelSegments: 2 });
  plateGeo.rotateX(-Math.PI / 2);
  const plate = new THREE.Mesh(plateGeo, new THREE.MeshStandardMaterial({ color: 0xd8d6cf, roughness: 0.6 }));
  plate.position.y = 0.002;
  plate.receiveShadow = true;
  plate.name = 'homePlate';
  group.add(plate);

  // --- Bases: 15 in bags at the corners of the diamond.
  const bagMat = new THREE.MeshStandardMaterial({ color: 0xfbfbf8, roughness: 0.5 });
  const bagGeo = new THREE.BoxGeometry(15 * IN, 4 * IN, 15 * IN);
  for (const [x, d] of [[BASE_DIAG - 0.2, BASE_DIAG], [0, 2 * BASE_DIAG], [-BASE_DIAG + 0.2, BASE_DIAG]]) {
    const bag = new THREE.Mesh(bagGeo, bagMat);
    bag.position.set(x, 2 * IN, -d);
    bag.rotation.y = Math.PI / 4;
    bag.castShadow = bag.receiveShadow = true;
    group.add(bag);
  }

  // --- Chalk: foul lines, batter's boxes, catcher's box.
  const chalk = new THREE.Group();
  chalk.name = 'chalk';
  const W = 3 * IN;
  const strip = (x0, z0, x1, z1, width = W) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(width, len), chalkMat);
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = -Math.atan2(x1 - x0, -(z1 - z0));
    m.position.set((x0 + x1) / 2, 0.008, (z0 + z1) / 2);
    m.receiveShadow = true;
    chalk.add(m);
  };
  for (const sign of [-1, 1]) {
    const [x1, z1] = sprayPoint(sign * 45, wallAt(sign * 45, park).dist);
    strip(sign * PLATE.halfWidth * 0.0, 0, x1, z1);
    // Batter's box: 4 x 6 ft, 6 in from the plate.
    const inner = PLATE.halfWidth + 6 * IN, outer = inner + 4 * FT;
    const zc = PLATE.frontZ / 2, half = 3 * FT;
    strip(sign * inner, zc - half, sign * inner, zc + half);
    strip(sign * outer, zc - half, sign * outer, zc + half);
    strip(sign * inner, zc - half, sign * outer, zc - half);
    strip(sign * inner, zc + half, sign * outer, zc + half);
  }
  // Catcher's box behind the plate.
  const cbHalf = 43 * IN / 2;
  strip(-cbHalf, 0.3, -cbHalf, 0.3 + 8 * FT);
  strip(cbHalf, 0.3, cbHalf, 0.3 + 8 * FT);
  group.add(chalk);

  // --- Warning track and outfield wall, sampled every degree of spray.
  const samples = [];
  for (let a = -45; a <= 45; a += 1) samples.push({ a, ...wallAt(a, park) });
  const trackPos = [];
  const trackIdx = [];
  samples.forEach(({ a, dist }, i) => {
    const [xi, zi] = sprayPoint(a, dist - 15 * FT);
    const [xo, zo] = sprayPoint(a, dist + 0.3);
    trackPos.push(xi, 0.005, zi, xo, 0.005, zo);
    if (i > 0) {
      const b = (i - 1) * 2;
      trackIdx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    }
  });
  const trackGeo = new THREE.BufferGeometry();
  trackGeo.setAttribute('position', new THREE.Float32BufferAttribute(trackPos, 3));
  trackGeo.setIndex(trackIdx);
  trackGeo.computeVertexNormals();
  worldUVs(trackGeo, 6);
  const trackMesh = new THREE.Mesh(trackGeo, trackMat);
  trackMesh.receiveShadow = true;
  trackMesh.name = 'warningTrack';
  group.add(trackMesh);

  const wallMat = new THREE.MeshStandardMaterial({ color: 0x173a26, roughness: 0.82, side: THREE.DoubleSide });
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xf5c518, emissive: 0xf5c518, emissiveIntensity: 0.25, roughness: 0.6 });
  // Front face (padding), a separate top cap, and the yellow home-run line.
  const ribbon = (pointsA, pointsB) => {
    const pos = [], idx = [];
    pointsA.forEach((a, i) => {
      pos.push(...a, ...pointsB[i]);
      if (i > 0) {
        const b = (i - 1) * 2;
        idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
      }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  };
  const at = (a, dist, y) => { const [x, z] = sprayPoint(a, dist); return [x, y, z]; };
  const front = new THREE.Mesh(ribbon(samples.map((s) => at(s.a, s.dist, 0)), samples.map((s) => at(s.a, s.dist, s.height))), wallMat);
  front.castShadow = front.receiveShadow = true;
  front.name = 'outfieldWall';
  group.add(front);
  group.add(new THREE.Mesh(ribbon(samples.map((s) => at(s.a, s.dist, s.height + 0.12)), samples.map((s) => at(s.a, s.dist + 0.6, s.height + 0.12))), wallMat));
  group.add(new THREE.Mesh(ribbon(samples.map((s) => at(s.a, s.dist - 0.01, s.height)), samples.map((s) => at(s.a, s.dist - 0.01, s.height + 0.12))), lineMat));

  // Distance markers painted on the wall.
  for (const a of [-45, -22.5, 0, 22.5, 45]) {
    const { dist, height } = wallAt(a, park);
    const label = makeLabel(String(Math.round(dist / FT)));
    const [x, z] = sprayPoint(a + (Math.abs(a) === 45 ? -Math.sign(a) * 2.5 : 0), dist - 0.25);
    label.position.set(x, height * 0.55, z);
    label.lookAt(0, height * 0.55, 0);
    group.add(label);
  }

  // Foul poles.
  const poleMat = new THREE.MeshStandardMaterial({ color: 0xf5c518, emissive: 0xf5c518, emissiveIntensity: 0.55, roughness: 0.5 });
  for (const sign of [-1, 1]) {
    const { dist } = wallAt(sign * 45, park);
    const [x, z] = sprayPoint(sign * 45, dist + 0.3);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 26, 12), poleMat);
    pole.position.set(x, 13, z);
    pole.castShadow = true;
    group.add(pole);
  }

  // Low padded fence around foul territory.
  const boundary = fieldBoundary(park);
  const fence = boundary.filter((b) => b.kind !== 'outfield' && b.kind !== 'eye');
  const fPos = [], fIdx = [];
  fence.forEach(({ p }, i) => {
    fPos.push(p[0], 0, p[1], p[0], 1.2, p[1]);
    if (i > 0) {
      const b = (i - 1) * 2;
      fIdx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
    }
  });
  const fenceGeo = new THREE.BufferGeometry();
  fenceGeo.setAttribute('position', new THREE.Float32BufferAttribute(fPos, 3));
  fenceGeo.setIndex(fIdx);
  fenceGeo.computeVertexNormals();
  const fenceMesh = new THREE.Mesh(fenceGeo, new THREE.MeshStandardMaterial({ color: 0x0f2340, roughness: 0.8, side: THREE.DoubleSide }));
  fenceMesh.receiveShadow = true;
  group.add(fenceMesh);

  return { group, boundary, materials: { grassMat, dirtMat, chalkMat } };
}

function makeLabel(text) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.font = 'bold 96px Inter, Arial, sans-serif';
  ctx.fillStyle = '#f1f1ea';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 68);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2 });
  return new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.6), mat);
}
