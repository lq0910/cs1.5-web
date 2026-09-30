/**
 * Collision against a real GoldSrc BSP: the recursive hull check that the
 * original engine (and every Quake derivative) uses.
 *
 * In a compiled map the player hulls are *baked* into the tree: the compiler
 * expands the world by the hull extents, so at runtime a hull-1 trace is a plain
 * point trace through `clipnodes`. Hull 0 (the point hull) lives in the node
 * tree; GoldSrc converts node children into contents values at load time
 * (`Mod_MakeHull0`), which is what the constructor below reproduces.
 *
 * Everything here works on the trace conventions the movement code expects:
 * fraction/endpos/normal/startsolid/allsolid.
 */

import type { Vec3 } from '../math.ts';
import { copy, dot, v3 } from '../math.ts';
import type { CollisionWorld, Hull, TraceResult } from '../collision/types.ts';
import { DIST_EPSILON, makeTrace } from '../collision/types.ts';
import { CONTENTS_EMPTY, CONTENTS_SOLID, CONTENTS_WATER } from './types.ts';
import type { BspClipnode, BspFile } from './types.ts';

/**
 * Hull slots inside the BSP model.
 *
 * The order is Quake's, which GoldSrc kept: 0 = point, 1 = player standing
 * (32x32x72), 2 = large (64x64x64), 3 = player ducking (32x32x36).
 *
 * This is measurable from any map: tracing straight down from a known floor
 * stops the hull centre at floor+36, +32 and +18 respectively. Getting the order
 * wrong means a crouching player collides as a 64x64x64 box, so they cannot fit
 * through the gaps they should.
 */
export const HULL_INDEX_POINT = 0;
export const HULL_INDEX_STANDING = 1;
export const HULL_INDEX_LARGE = 2;
export const HULL_INDEX_DUCKING = 3;

const INDEX_HULLS: { index: number; mins: Vec3; maxs: Vec3 }[] = [
  { index: HULL_INDEX_STANDING, mins: v3(-16, -16, -36), maxs: v3(16, 16, 36) },
  { index: HULL_INDEX_LARGE, mins: v3(-32, -32, -32), maxs: v3(32, 32, 32) },
  { index: HULL_INDEX_DUCKING, mins: v3(-16, -16, -18), maxs: v3(16, 16, 18) },
];

function close(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.05;
}

/** Maps a hull definition onto the compiled hull slot it corresponds to. */
export function hullIndexForHull(hull: Hull): number {
  for (const candidate of INDEX_HULLS) {
    if (
      close(hull.mins.x, candidate.mins.x) &&
      close(hull.mins.y, candidate.mins.y) &&
      close(hull.mins.z, candidate.mins.z) &&
      close(hull.maxs.x, candidate.maxs.x) &&
      close(hull.maxs.y, candidate.maxs.y) &&
      close(hull.maxs.z, candidate.maxs.z)
    ) {
      return candidate.index;
    }
  }
  // Unknown hull (or a point hull): fall back to the point tree.
  return HULL_INDEX_POINT;
}

export class BspCollisionWorld implements CollisionWorld {
  private readonly bsp: BspFile;
  private readonly modelIndex: number;
  /** Node tree with leaf children resolved to contents (GoldSrc Mod_MakeHull0). */
  private readonly hull0: BspClipnode[];

  constructor(bsp: BspFile, modelIndex = 0) {
    this.bsp = bsp;
    this.modelIndex = modelIndex;
    this.hull0 = bsp.nodes.map((node) => ({
      planenum: node.planenum,
      children: [this.resolveNodeChild(node.children[0]), this.resolveNodeChild(node.children[1])],
    }));
  }

  private resolveNodeChild(child: number): number {
    if (child >= 0) return child;
    const leaf = this.bsp.leaves[-1 - child];
    return leaf ? leaf.contents : CONTENTS_EMPTY;
  }

  private treeFor(hullIndex: number): BspClipnode[] {
    return hullIndex === HULL_INDEX_POINT ? this.hull0 : this.bsp.clipnodes;
  }

  private rootFor(hullIndex: number): number {
    const model = this.bsp.models[this.modelIndex];
    if (!model) return CONTENTS_EMPTY;
    return model.headnode[hullIndex] ?? CONTENTS_EMPTY;
  }

  traceHull(hull: Hull, start: Vec3, end: Vec3): TraceResult {
    const hullIndex = hullIndexForHull(hull);
    const tree = this.treeFor(hullIndex);
    const root = this.rootFor(hullIndex);

    const trace = makeTrace();
    // GoldSrc starts optimistic: any empty leaf we reach clears this.
    trace.allsolid = true;
    trace.endpos = copy(end);

    if (tree.length === 0 || root < 0) {
      trace.allsolid = false;
      return trace;
    }

    this.recursiveHullCheck(tree, root, start, end, 0, 1, trace, 0);

    if (trace.startsolid) {
      trace.fraction = 0;
      trace.endpos = copy(start);
      // NOTE: do *not* force allsolid here. Quake only reports allsolid when the
      // entire sweep stayed inside solid geometry; the recursion above already
      // decided that (it clears allsolid as soon as it reaches an empty leaf).
      // Forcing it would freeze a hull that merely grazes a surface, because
      // PM_SlideMove zeroes the velocity and bails out whenever allsolid is set.
    } else if (trace.fraction >= 1) {
      trace.fraction = 1;
      trace.endpos = copy(end);
      trace.allsolid = false;
    }

    return trace;
  }

  /** SV_RecursiveHullCheck. */
  private recursiveHullCheck(
    tree: BspClipnode[],
    nodeIndex: number,
    p1: Vec3,
    p2: Vec3,
    p1f: number,
    p2f: number,
    trace: TraceResult,
    depth: number,
  ): void {
    if (depth > 512) return;
    if (p1f > 0 && trace.fraction <= p1f) return; // already blocked nearer

    if (nodeIndex < 0) {
      // A negative child is a contents value.
      if (nodeIndex !== CONTENTS_SOLID) {
        trace.allsolid = false;
      } else {
        trace.startsolid = true;
      }
      return;
    }

    const node = tree[nodeIndex];
    const plane = node ? this.bsp.planes[node.planenum] : undefined;
    if (!node || !plane) {
      trace.allsolid = false;
      return;
    }

    const t1 = dot(plane.normal, p1) - plane.dist;
    const t2 = dot(plane.normal, p2) - plane.dist;

    if (t1 >= 0 && t2 >= 0) {
      this.recursiveHullCheck(tree, node.children[0], p1, p2, p1f, p2f, trace, depth + 1);
      return;
    }
    if (t1 < 0 && t2 < 0) {
      this.recursiveHullCheck(tree, node.children[1], p1, p2, p1f, p2f, trace, depth + 1);
      return;
    }

    // The segment crosses the plane: split it.
    //
    // The epsilon must be applied towards the side the trace came from. Quake's
    // original formula (t1 - eps) implicitly assumes t1 > 0, i.e. that wall
    // planes point into the room. GoldSrc's clipnode trees frequently orient a
    // face the other way (normal pointing into the solid), and with the
    // unguarded formula the split point lands *inside* the solid: the trace then
    // stops far short of the surface (24 units on dust2) and the back-off loop
    // below makes it worse.
    const shift = t1 >= 0 ? DIST_EPSILON : -DIST_EPSILON;
    let frac = (t1 - shift) / (t1 - t2);
    if (frac < 0) frac = 0;
    if (frac > 1) frac = 1;

    let midf = p1f + (p2f - p1f) * frac;
    let mid = v3(
      p1.x + frac * (p2.x - p1.x),
      p1.y + frac * (p2.y - p1.y),
      p1.z + frac * (p2.z - p1.z),
    );

    const side = t1 < 0 ? 1 : 0;

    // Near side first.
    this.recursiveHullCheck(tree, node.children[side]!, p1, mid, p1f, midf, trace, depth + 1);
    if (trace.allsolid) return;

    const farChild = node.children[side ^ 1]!;
    if (this.pointContentsInTree(tree, farChild, mid) !== CONTENTS_SOLID) {
      // The crossing point is open space: keep going past the node.
      this.recursiveHullCheck(tree, farChild, mid, p2, midf, p2f, trace, depth + 1);
      return;
    }

    // The far side is solid: this is the impact point.
    const impactNormal = side
      ? v3(-plane.normal.x, -plane.normal.y, -plane.normal.z)
      : copy(plane.normal);
    const impactDist = side ? -plane.dist : plane.dist;

    // Rare: if the crossing point itself sits inside solid geometry, back off
    // along the segment. This must sample the *whole world* (Quake tests from
    // the hull root) and not the far subtree: the impact point is expected to be
    // inside the far subtree, so testing that would always back off and push the
    // hit far away from the real surface.
    let guard = 0;
    while (this.pointContents(mid) === CONTENTS_SOLID && guard++ < 16) {
      // Small steps: a 0.1 step of the whole segment is metres of error.
      frac -= 0.01;
      if (frac < 0) break;
      midf = p1f + (p2f - p1f) * frac;
      mid = v3(
        p1.x + frac * (p2.x - p1.x),
        p1.y + frac * (p2.y - p1.y),
        p1.z + frac * (p2.z - p1.z),
      );
    }

    if (midf < trace.fraction) {
      trace.fraction = midf;
      trace.endpos = copy(mid);
      trace.normal = impactNormal;
      trace.dist = impactDist;
    }
  }

  /** Walks a single point down a tree, returning the contents it lands in. */
  private pointContentsInTree(tree: BspClipnode[], nodeIndex: number, p: Vec3): number {
    let current = nodeIndex;
    let guard = 0;
    while (current >= 0 && guard++ < 4096) {
      const node = tree[current];
      if (!node) return CONTENTS_EMPTY;
      const plane = this.bsp.planes[node.planenum];
      if (!plane) return CONTENTS_EMPTY;
      const d = dot(plane.normal, p) - plane.dist;
      current = d >= 0 ? node.children[0]! : node.children[1]!;
    }
    return current;
  }

  pointContents(p: Vec3): number {
    const root = this.rootFor(HULL_INDEX_POINT);
    if (this.hull0.length === 0 || root < 0) return CONTENTS_EMPTY;
    const contents = this.pointContentsInTree(this.hull0, root, p);
    return contents === CONTENTS_SOLID ? CONTENTS_SOLID : contents === CONTENTS_WATER ? CONTENTS_WATER : CONTENTS_EMPTY;
  }
}
