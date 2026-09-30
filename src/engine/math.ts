/**
 * Minimal vector math for the simulation layer.
 *
 * IMPORTANT: the whole simulation runs in GoldSrc's coordinate system, which is
 * Z-UP (x = east, y = north, z = up). Three.js is Y-up, so the renderer converts
 * at the boundary (see engine/render/renderer.ts). Keeping physics in Z-up means
 * every constant taken from the GoldSrc/CS source (gravity 800, jump 268, step 18,
 * hull sizes 32x32x72, ...) can be used literally instead of being remapped.
 *
 * This file must stay free of any three.js / DOM dependency so that the physics
 * can be unit-tested under plain Node.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function v3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function copy(a: Vec3): Vec3 {
  return { x: a.x, y: a.y, z: a.z };
}

export function set(out: Vec3, x: number, y: number, z: number): Vec3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function setFrom(out: Vec3, a: Vec3): Vec3 {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

/** out = a + b * s (in place on `out`). */
export function addScaled(out: Vec3, a: Vec3, b: Vec3, s: number): Vec3 {
  out.x = a.x + b.x * s;
  out.y = a.y + b.y * s;
  out.z = a.z + b.z * s;
  return out;
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function lengthSq(a: Vec3): number {
  return a.x * a.x + a.y * a.y + a.z * a.z;
}

export function length2d(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y);
}

export function length(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

export function distance(a: Vec3, b: Vec3): number {
  return length(sub(a, b));
}

/** Normalizes in place; returns the original length (0 => vector untouched). */
export function normalize(a: Vec3): number {
  const len = length(a);
  if (len === 0) return 0;
  const inv = 1 / len;
  a.x *= inv;
  a.y *= inv;
  a.z *= inv;
  return len;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * AngleVectors (GoldSrc): turns pitch/yaw/roll in degrees into forward/right/up.
 * The renderer feeds the same angles to the Three.js camera, so the mapping only
 * has to be right once, here.
 */
export function angleVectors(
  pitchDeg: number,
  yawDeg: number,
  rollDeg: number,
  forward: Vec3,
  right: Vec3,
  up: Vec3,
): void {
  const p = (pitchDeg * Math.PI) / 180;
  const y = (yawDeg * Math.PI) / 180;
  const r = (rollDeg * Math.PI) / 180;

  const sp = Math.sin(p);
  const cp = Math.cos(p);
  const sy = Math.sin(y);
  const cy = Math.cos(y);
  const sr = Math.sin(r);
  const cr = Math.cos(r);

  forward.x = cp * cy;
  forward.y = cp * sy;
  forward.z = -sp;

  right.x = -sr * sp * cy + cr * sy;
  right.y = -sr * sp * sy - cr * cy;
  right.z = -sr * cp;

  up.x = cr * sp * cy + sr * sy;
  up.y = cr * sp * sy - sr * cy;
  up.z = cr * cp;
}
