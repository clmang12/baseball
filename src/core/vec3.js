// Allocation-free 3-vector math for the physics hot path.
// Vectors are any indexable [x, y, z] (plain arrays or Float64Array views);
// every op writes into `out` and returns it, so callers can reuse scratch buffers.

export const create = (x = 0, y = 0, z = 0) => Float64Array.of(x, y, z);

export function set(out, x, y, z) {
  out[0] = x; out[1] = y; out[2] = z;
  return out;
}

export function copy(out, a) {
  out[0] = a[0]; out[1] = a[1]; out[2] = a[2];
  return out;
}

export function add(out, a, b) {
  out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2];
  return out;
}

export function sub(out, a, b) {
  out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2];
  return out;
}

export function scale(out, a, s) {
  out[0] = a[0] * s; out[1] = a[1] * s; out[2] = a[2] * s;
  return out;
}

/** out = a + b * s */
export function addScaled(out, a, b, s) {
  out[0] = a[0] + b[0] * s; out[1] = a[1] + b[1] * s; out[2] = a[2] + b[2] * s;
  return out;
}

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Safe when `out` aliases `a` or `b`. */
export function cross(out, a, b) {
  const x = a[1] * b[2] - a[2] * b[1];
  const y = a[2] * b[0] - a[0] * b[2];
  const z = a[0] * b[1] - a[1] * b[0];
  out[0] = x; out[1] = y; out[2] = z;
  return out;
}

export const lengthSq = (a) => a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
export const length = (a) => Math.sqrt(lengthSq(a));

export function distance(a, b) {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Normalizes `a` into `out`; a zero vector stays zero instead of producing NaN. */
export function normalize(out, a) {
  const len = length(a);
  return len > 0 ? scale(out, a, 1 / len) : set(out, 0, 0, 0);
}

/** out = a - (a·n) n, i.e. the component of `a` perpendicular to unit vector `n`. */
export function rejectUnit(out, a, n) {
  const d = dot(a, n);
  out[0] = a[0] - d * n[0]; out[1] = a[1] - d * n[1]; out[2] = a[2] - d * n[2];
  return out;
}

/** Linear interpolation out = a + (b - a) t. */
export function lerp(out, a, b, t) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

/** Multiplies a 3x3 column-major matrix (columns c0,c1,c2 as 9-array) by v. */
export function mulMat3(out, m, v) {
  const x = m[0] * v[0] + m[3] * v[1] + m[6] * v[2];
  const y = m[1] * v[0] + m[4] * v[1] + m[7] * v[2];
  const z = m[2] * v[0] + m[5] * v[1] + m[8] * v[2];
  out[0] = x; out[1] = y; out[2] = z;
  return out;
}

/** Multiplies the transpose of a column-major 3x3 matrix by v (world → local for orthonormal frames). */
export function mulMat3T(out, m, v) {
  const x = m[0] * v[0] + m[1] * v[1] + m[2] * v[2];
  const y = m[3] * v[0] + m[4] * v[1] + m[5] * v[2];
  const z = m[6] * v[0] + m[7] * v[1] + m[8] * v[2];
  out[0] = x; out[1] = y; out[2] = z;
  return out;
}
