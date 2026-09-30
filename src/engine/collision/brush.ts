/**
 * Convex-brush collision backend.
 *
 * A brush is a convex polyhedron described by half-spaces: a point is solid when
 * `dot(normal, p) <= dist` for every face. Axis-aligned boxes are the common case
 * (walls, floors, crates, stairs), but the maths below is general, so rotated
 * brushes and wedge ramps work too.
 *
 * Tracing a hull through a brush is done by Minkowski expansion: inflate each face
 * plane by the hull's support along that normal, then the problem reduces to a
 * plain segment-vs-convex test, which is solved with a Liang-Barsky style clip.
 * That gives an exact hit fraction and the exact face normal we hit — both of
 * which the GoldSrc sliding code needs.
 */

import type { Vec3 } from '../math.ts';
import { copy, dot, sub, v3 } from '../math.ts';
import type { CollisionWorld, Hull, TraceResult } from './types.ts';
import {
  CONTENTS_EMPTY,
  CONTENTS_SOLID,
  DIST_EPSILON,
  hullSupport,
  makeTrace,
} from './types.ts';

export interface Plane {
  normal: Vec3;
  dist: number;
}

export interface Brush {
  planes: Plane[];
}

/** Axis-aligned box description used by hand-authored maps and the BSP importer. */
export interface BoxDef {
  mins: Vec3;
  maxs: Vec3;
  /** Texture/material name, used by the renderer only. */
  material?: string;
  /** Non-solid boxes are drawn but do not collide (e.g. decorative trim). */
  solid?: boolean;
}

export const AXIS_NORMALS: Vec3[] = [v3(1, 0, 0), v3(-1, 0, 0), v3(0, 1, 0), v3(0, -1, 0), v3(0, 0, 1), v3(0, 0, -1)];

/** Builds the 6 half-spaces of an axis-aligned box. */
export function brushFromAABB(mins: Vec3, maxs: Vec3): Brush {
  const planes: Plane[] = [
    { normal: v3(1, 0, 0), dist: maxs.x },
    { normal: v3(-1, 0, 0), dist: -mins.x },
    { normal: v3(0, 1, 0), dist: maxs.y },
    { normal: v3(0, -1, 0), dist: -mins.y },
    { normal: v3(0, 0, 1), dist: maxs.z },
    { normal: v3(0, 0, -1), dist: -mins.z },
  ];
  return { planes };
}

interface BrushHit {
  fraction: number;
  normal: Vec3;
  dist: number;
  startsolid: boolean;
  allsolid: boolean;
}

/**
 * Sweeps a hull through one convex brush. Returns null when there is no contact.
 *
 * This is the point-trace formulation: the brush is expanded by the hull, so the
 * swept hull behaves exactly like a swept point.
 */
export function traceHullVsBrush(brush: Brush, hull: Hull, start: Vec3, end: Vec3): BrushHit | null {
  let enterFrac = -1;
  let exitFrac = 1;
  let enterPlane = -1;
  // Plane the hull is closest to touching from the inside; used as the escape
  // normal when the trace starts embedded.
  let nearestPlane = 0;
  let nearestD1 = -Infinity;

  for (let i = 0; i < brush.planes.length; i++) {
    const p = brush.planes[i]!;
    // Minkowski sum of the brush and the hull: support(A + B, n) = support(A, n)
    // + support(B, n), so every face plane moves *outwards* by the hull's extent
    // along that normal. The swept hull then behaves like a swept point.
    // (Both are symmetric about their origin, so the reflected hull is itself.)
    const dist = p.dist + hullSupport(hull, p.normal);

    const d1 = dot(p.normal, start) - dist;
    const d2 = dot(p.normal, end) - dist;

    if (d1 > nearestD1) {
      nearestD1 = d1;
      nearestPlane = i;
    }

    // d == 0 counts as "outside": a hull resting exactly on a surface must not be
    // treated as embedded in it, or standing still would report allsolid.
    if (d1 >= 0 && d2 >= 0) return null; // entirely in front of this face
    if (d1 < 0 && d2 < 0) continue; // entirely behind it: no constraint

    // Only true crossings reach this point, so d1 - d2 is never zero.
    const denom = d1 - d2;
    if (d1 > 0) {
      // entering
      const f = (d1 - DIST_EPSILON) / denom;
      if (f > enterFrac) {
        enterFrac = f;
        enterPlane = i;
      }
    } else {
      // leaving
      const f = (d1 + DIST_EPSILON) / denom;
      if (f < exitFrac) exitFrac = f;
    }
  }

  if (enterFrac >= exitFrac) return null;

  if (enterFrac > -1) {
    const fraction = enterFrac < 0 ? 0 : enterFrac;
    const plane = brush.planes[enterPlane]!;
    return {
      fraction,
      normal: copy(plane.normal),
      dist: plane.dist,
      startsolid: fraction === 0,
      allsolid: false,
    };
  }

  // The hull starts inside the expanded brush. Report the surface it is closest
  // to touching as the escape normal (for a hull resting on a floor that is the
  // floor plane, which is what PM_CategorizePosition needs to see).
  const nearest = brush.planes[nearestPlane]!;
  return {
    fraction: 0,
    normal: copy(nearest.normal),
    dist: nearest.dist,
    startsolid: true,
    allsolid: exitFrac >= 1,
  };
}

/** Point-in-convex test (no hull expansion): is this point inside the solid? */
export function pointInBrush(brush: Brush, p: Vec3): boolean {
  for (const plane of brush.planes) {
    if (dot(plane.normal, p) - plane.dist > 0) return false;
  }
  return true;
}

/** Segment-vs-brush rejection test, cheap broad phase before the real trace. */
function segmentBoxOverlap(bmins: Vec3, bmaxs: Vec3, start: Vec3, end: Vec3): boolean {
  const segMin = v3(
    Math.min(start.x, end.x),
    Math.min(start.y, end.y),
    Math.min(start.z, end.z),
  );
  const segMax = v3(
    Math.max(start.x, end.x),
    Math.max(start.y, end.y),
    Math.max(start.z, end.z),
  );
  return (
    segMax.x >= bmins.x &&
    segMin.x <= bmaxs.x &&
    segMax.y >= bmins.y &&
    segMin.y <= bmaxs.y &&
    segMax.z >= bmins.z &&
    segMin.z <= bmaxs.z
  );
}

/** A brush plus its cached AABB, used only as a broad-phase filter. */
export interface SolidBrush extends Brush {
  mins: Vec3;
  maxs: Vec3;
  /** Contents value, so we can support water and other volumes later. */
  contents: number;
}

export function aabbOfBrush(brush: Brush, contents = CONTENTS_SOLID): SolidBrush {
  // mins starts at +inf and we keep the largest lower bound; maxs starts at -inf
  // and we keep the smallest upper bound.
  const mins = v3(-Infinity, -Infinity, -Infinity);
  const maxs = v3(Infinity, Infinity, Infinity);
  for (const p of brush.planes) {
    for (const axis of ['x', 'y', 'z'] as const) {
      const n = p.normal[axis];
      if (n === 0) continue;
      // Plane: dot(n, x) <= dist.
      //   n > 0 -> x <= dist / n  (upper bound)
      //   n < 0 -> x >= dist / n  (lower bound, division flips the comparison)
      const bound = p.dist / n;
      if (n > 0) {
        if (bound < maxs[axis]) maxs[axis] = bound;
      } else if (bound > mins[axis]) {
        mins[axis] = bound;
      }
    }
  }
  // A brush that only bounds some directions would leave infinities behind; the
  // broad phase needs finite numbers, so clamp to a huge but finite range.
  for (const axis of ['x', 'y', 'z'] as const) {
    if (!Number.isFinite(mins[axis])) mins[axis] = -1e12;
    if (!Number.isFinite(maxs[axis])) maxs[axis] = 1e12;
  }
  return { ...brush, mins, maxs, contents };
}

export class BrushWorld implements CollisionWorld {
  readonly brushes: SolidBrush[];

  constructor(brushes: SolidBrush[]) {
    this.brushes = brushes;
  }

  static fromBoxes(boxes: BoxDef[]): BrushWorld {
    const solids: SolidBrush[] = [];
    for (const box of boxes) {
      if (box.solid === false) continue;
      solids.push(aabbOfBrush(brushFromAABB(box.mins, box.maxs)));
    }
    return new BrushWorld(solids);
  }

  traceHull(hull: Hull, start: Vec3, end: Vec3): TraceResult {
    const result = makeTrace();
    result.endpos = copy(end);
    result.normal = v3(0, 0, 1);

    let bestFraction = 1;
    let bestNormal: Vec3 | null = null;
    let bestDist = 0;

    for (const brush of this.brushes) {
      if (brush.contents !== CONTENTS_SOLID) continue;

      // Broad phase: inflate the brush AABB by the hull extent before comparing.
      const bmins = v3(
        brush.mins.x + hull.mins.x,
        brush.mins.y + hull.mins.y,
        brush.mins.z + hull.mins.z,
      );
      const bmaxs = v3(
        brush.maxs.x + hull.maxs.x,
        brush.maxs.y + hull.maxs.y,
        brush.maxs.z + hull.maxs.z,
      );
      if (!segmentBoxOverlap(bmins, bmaxs, start, end)) continue;

      const hit = traceHullVsBrush(brush, hull, start, end);
      if (!hit) continue;

      if (hit.startsolid) {
        // GoldSrc reports the first solid it finds; movement handles the rest.
        result.fraction = 0;
        result.endpos = copy(start);
        result.normal = hit.normal;
        result.dist = hit.dist;
        result.startsolid = true;
        result.allsolid = hit.allsolid;
        return result;
      }

      if (hit.fraction < bestFraction) {
        bestFraction = hit.fraction;
        bestNormal = hit.normal;
        bestDist = hit.dist;
      }
    }

    if (bestNormal) {
      result.fraction = bestFraction;
      result.endpos = {
        x: start.x + (end.x - start.x) * bestFraction,
        y: start.y + (end.y - start.y) * bestFraction,
        z: start.z + (end.z - start.z) * bestFraction,
      };
      result.normal = bestNormal;
      result.dist = bestDist;
    }

    return result;
  }

  pointContents(p: Vec3): number {
    for (const brush of this.brushes) {
      if (brush.contents !== CONTENTS_SOLID) continue;
      if (pointInBrush(brush, p)) return CONTENTS_SOLID;
    }
    return CONTENTS_EMPTY;
  }
}

/** Convenience: axis-aligned box as a plane set, for callers building brushes by hand. */
export function boxPlanes(mins: Vec3, maxs: Vec3): Plane[] {
  return brushFromAABB(mins, maxs).planes;
}

/** Vector from `start` to `end`; tiny helper kept next to the trace code. */
export function delta(start: Vec3, end: Vec3): Vec3 {
  return sub(end, start);
}
