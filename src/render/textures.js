// Procedural canvas textures, so the game ships without image assets.
// Every generator is deterministic (seeded) so the field looks the same each load.

import * as THREE from 'three';
import { Rng } from '../core/rng.js';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function finish(c, { srgb = true, repeat = null, anisotropy = 8 } = {}) {
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = anisotropy;
  if (repeat) {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat[0], repeat[1]);
  }
  tex.needsUpdate = true;
  return tex;
}

/** Tileable value noise in [0,1] on a size×size grid (sum of octaves). */
function tileNoise(size, rng, octaves = 4, base = 8) {
  const out = new Float32Array(size * size);
  let amp = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    const cells = base << o;
    const grid = new Float32Array(cells * cells);
    for (let i = 0; i < grid.length; i++) grid[i] = rng.next();
    const at = (x, y) => grid[((y + cells) % cells) * cells + ((x + cells) % cells)];
    for (let y = 0; y < size; y++) {
      const gy = (y / size) * cells, y0 = Math.floor(gy), fy = gy - y0, sy = fy * fy * (3 - 2 * fy);
      for (let x = 0; x < size; x++) {
        const gx = (x / size) * cells, x0 = Math.floor(gx), fx = gx - x0, sx = fx * fx * (3 - 2 * fx);
        const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
        const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
        out[y * size + x] += amp * (a + (b - a) * sy);
      }
    }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/** Normal map (tangent space) from a tileable height field. */
function normalFromHeight(height, size, strength) {
  const c = canvas(size, size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const h = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * strength;
      const dy = (h(x, y + 1) - h(x, y - 1)) * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y * size + x) * 4;
      img.data[i] = (-dx * inv * 0.5 + 0.5) * 255;
      img.data[i + 1] = (dy * inv * 0.5 + 0.5) * 255;
      img.data[i + 2] = (inv * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * Outfield grass: two mowing bands per tile (light/dark) plus blade-scale noise.
 * The tile is repeated so one band is `bandWidth` metres wide in the world.
 */
export function grassTextures({ size = 512, seed = 11 } = {}) {
  const rng = new Rng(seed);
  const n = tileNoise(size, rng, 5, 4);
  const fine = tileNoise(size, rng, 2, 64);
  const c = canvas(size, size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    const band = y < size / 2 ? 1.06 : 0.94; // mow direction alternates every half tile
    for (let x = 0; x < size; x++) {
      const k = y * size + x;
      const v = band * (0.82 + 0.25 * n[k] + 0.18 * (fine[k] - 0.5));
      const i = k * 4;
      img.data[i] = Math.min(255, 52 * v);
      img.data[i + 1] = Math.min(255, 104 * v);
      img.data[i + 2] = Math.min(255, 40 * v);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const height = new Float32Array(size * size);
  for (let i = 0; i < height.length; i++) height[i] = fine[i] * 0.7 + n[i] * 0.3;
  return { map: finish(c), normalMap: finish(normalFromHeight(height, size, 6), { srgb: false }) };
}

/** Infield clay: warm brown with mottling, pebbles and a matching normal map. */
export function dirtTextures({ size = 512, seed = 23, tint = [154, 104, 70] } = {}) {
  const rng = new Rng(seed);
  const n = tileNoise(size, rng, 5, 6);
  const fine = tileNoise(size, rng, 2, 96);
  const c = canvas(size, size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let k = 0; k < size * size; k++) {
    const v = 0.78 + 0.3 * n[k] + 0.22 * (fine[k] - 0.5);
    const i = k * 4;
    img.data[i] = Math.min(255, tint[0] * v);
    img.data[i + 1] = Math.min(255, tint[1] * v);
    img.data[i + 2] = Math.min(255, tint[2] * v);
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  // Pebbles and cleat marks.
  for (let i = 0; i < 900; i++) {
    const r = rng.uniform(0.6, 2.2);
    ctx.fillStyle = rng.next() < 0.5 ? 'rgba(70,45,30,0.35)' : 'rgba(220,190,160,0.25)';
    ctx.beginPath();
    ctx.arc(rng.uniform(0, size), rng.uniform(0, size), r, 0, Math.PI * 2);
    ctx.fill();
  }
  const height = new Float32Array(size * size);
  for (let i = 0; i < height.length; i++) height[i] = fine[i] * 0.6 + n[i] * 0.4;
  return { map: finish(c), normalMap: finish(normalFromHeight(height, size, 4), { srgb: false }) };
}

/** Night sky dome: deep navy at the zenith, a faint warm haze at the horizon from the stadium lights. */
export function skyTexture() {
  const c = canvas(16, 512);
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0.0, '#01030a');
  g.addColorStop(0.35, '#040a1a');
  g.addColorStop(0.47, '#0f1a33');
  g.addColorStop(0.5, '#2a3348');
  g.addColorStop(0.53, '#0b0f18');
  g.addColorStop(1.0, '#050608');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 16, 512);
  return finish(c, { anisotropy: 1 });
}

/** Light-bank face: a grid of bright lamps on a dark housing (drives bloom). */
export function lampTexture({ cols = 8, rows = 4 } = {}) {
  const w = cols * 32, h = rows * 32;
  const c = canvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#15171c';
  ctx.fillRect(0, 0, w, h);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const cx = x * 32 + 16, cy = y * 32 + 16;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 14);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.5, '#fff3dc');
      g.addColorStop(1, 'rgba(255,240,210,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, 14, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return finish(c, { anisotropy: 1 });
}

/** Alpha mask of a seated fan (head + shoulders) for crowd billboards. */
export function crowdAlpha() {
  const c = canvas(64, 96);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 64, 96);
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(32, 26, 13, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(6, 96);
  ctx.quadraticCurveTo(8, 46, 32, 44);
  ctx.quadraticCurveTo(56, 46, 58, 96);
  ctx.fill();
  return finish(c, { srgb: false, anisotropy: 1 });
}

/** Soft round blob for the ball's contact shadow and dust sprites. */
export function radialTexture({ inner = 'rgba(0,0,0,1)', outer = 'rgba(0,0,0,0)', size = 128 } = {}) {
  const c = canvas(size, size);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return finish(c, { anisotropy: 1 });
}

/** Ball leather: off-white with subtle mottling (seams/stitches are real geometry). */
export function leatherTextures({ size = 256, seed = 5 } = {}) {
  const rng = new Rng(seed);
  const n = tileNoise(size, rng, 4, 8);
  const c = canvas(size, size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let k = 0; k < size * size; k++) {
    const v = 0.93 + 0.07 * n[k];
    const i = k * 4;
    img.data[i] = 246 * v;
    img.data[i + 1] = 240 * v;
    img.data[i + 2] = 226 * v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return { map: finish(c), normalMap: finish(normalFromHeight(n, size, 2.5), { srgb: false }) };
}
