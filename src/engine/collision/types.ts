/**
 * Collision interface shared by every collision backend.
 *
 * Two backends implement this:
 *   - BrushWorld (collision/brush.ts): convex brushes, used by the built-in
 *     "white house" test map and by any hand-authored map data.
 *   - BspWorld (bsp/clip.ts): real GoldSrc clipnodes from a .bsp file.
 *
 * The movement code only ever talks to this interface, so swapping the backend
 * never touches the movement maths.
 */

import type { Vec3 } from '../math.ts';

/** Axis-aligned bounding hull, expressed as mins/maxs relative to the entity origin. */
export interface Hull {
  mins: Vec3;
  maxs: Vec3;
}

export interface TraceResult {
  /** Fraction of the requested movement that was possible, 0..1. */
  fraction: number;
  /** Final position (start + (end-start) * fraction). */
  endpos: Vec3;
  /** Surface normal of the plane that stopped the movement. */
  normal: Vec3;
  /** Plane offset: the surface is `dot(normal, x) = dist`. */
  dist: number;
  /** True when the trace started inside a solid. */
  startsolid: boolean;
  /** True when the whole hull is embedded in a solid. */
  allsolid: boolean;
}

export function makeTrace(): TraceResult {
  return {
    fraction: 1,
    endpos: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 0 },
    dist: 0,
    startsolid: false,
    allsolid: false,
  };
}

export interface CollisionWorld {
  /** Sweeps `hull` along the segment start->end and reports the first impact. */
  traceHull(hull: Hull, start: Vec3, end: Vec3): TraceResult;
  /** GoldSrc contents value at a point: 0 = empty, CONTENTS_SOLID = -2. */
  pointContents(p: Vec3): number;
}

/**
 * GoldSrc contents flags (subset).
 * NOTE: the values match the engine exactly because negative BSP children are
 * literally contents values (`-1` empty, `-2` solid) in node/clipnode trees.
 */
export const CONTENTS_EMPTY = -1;
export const CONTENTS_SOLID = -2;
export const CONTENTS_WATER = -3;

/** Player hulls, exactly as GoldSrc defines them (units, Z-up). */
export const HULL_STANDING: Hull = {
  mins: { x: -16, y: -16, z: -36 },
  maxs: { x: 16, y: 16, z: 36 },
};

export const HULL_DUCKING: Hull = {
  mins: { x: -16, y: -16, z: -18 },
  maxs: { x: 16, y: 16, z: 18 },
};

export const HULL_LARGE: Hull = {
  mins: { x: -32, y: -32, z: -32 },
  maxs: { x: 32, y: 32, z: 32 },
};

/**
 * Maximum distance the game will consider a point to be "on" a surface.
 * GoldSrc uses the same value in pm_shared.
 */
export const DIST_EPSILON = 0.03125;

/** Support of an AABB hull along `n`: max over h in hull of dot(n, h). */
export function hullSupport(hull: Hull, n: Vec3): number {
  return (
    (n.x > 0 ? n.x * hull.maxs.x : n.x * hull.mins.x) +
    (n.y > 0 ? n.y * hull.maxs.y : n.y * hull.mins.y) +
    (n.z > 0 ? n.z * hull.maxs.z : n.z * hull.mins.z)
  );
}

/** Lowest point of the hull along `n` (used for plane expansion the other way). */
export function hullSupportNeg(hull: Hull, n: Vec3): number {
  return (
    (n.x > 0 ? n.x * hull.mins.x : n.x * hull.maxs.x) +
    (n.y > 0 ? n.y * hull.mins.y : n.y * hull.maxs.y) +
    (n.z > 0 ? n.z * hull.mins.z : n.z * hull.maxs.z)
  );
}
