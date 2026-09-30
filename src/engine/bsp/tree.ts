/**
 * A small BSP tree builder for axis-aligned solid boxes.
 *
 * Real GoldSrc maps are compiled by qbsp/HLCSG, which we cannot run here. This
 * builder produces a *proper* BSP tree (a full space partition, not an
 * ad-hoc decision list) for box worlds, which is exactly what the collision
 * code assumes when it traverses clipnodes:
 *
 *   - the root region is the bounding box of the world;
 *   - a region wholly inside some solid box becomes a SOLID leaf;
 *   - otherwise a box face plane that cuts the region in two becomes the split,
 *     and the region is divided into its positive and negative halves;
 *   - a region with no solid box left and no splitting plane becomes EMPTY.
 *
 * Because every split strictly shrinks an axis-aligned region, the recursion
 * always terminates, and because children are exactly the two half-spaces of
 * the node plane, the partition invariant holds.
 *
 * Planes use the GoldSrc convention: the solid side of a plane is
 * `dot(normal, x) <= dist`.
 */

export interface AxisAlignedBox {
  mins: [number, number, number];
  maxs: [number, number, number];
}

export interface TreePlane {
  /** Unit axis normal: one component is +1 or -1, the rest are 0. */
  normal: [number, number, number];
  dist: number;
}

export interface TreeLeaf {
  contents: number;
  mins: [number, number, number];
  maxs: [number, number, number];
}

export interface TreeNode {
  planeIndex: number;
  /** children[0] = positive side, children[1] = negative side (GoldSrc order). */
  children: [number, number];
}

export interface TreeResult {
  nodes: TreeNode[];
  leaves: TreeLeaf[];
  /** Root: >= 0 node index, < 0 leaf reference encoded as (-1 - leafIndex). */
  root: number;
}

export interface PlaneRegistry {
  planes: TreePlane[];
  indexOf(plane: TreePlane): number;
}

export function createPlaneRegistry(): PlaneRegistry {
  const planes: TreePlane[] = [];
  const keys = new Map<string, number>();

  const keyOf = (plane: TreePlane): string => {
    // Round to 1/1000 of a unit: the compiler does the same kind of normalisation.
    const n = plane.normal.map((v) => Math.round(v));
    const d = Math.round(plane.dist * 1000) / 1000;
    return `${n[0]},${n[1]},${n[2]},${d}`;
  };

  return {
    planes,
    indexOf(plane: TreePlane): number {
      const key = keyOf(plane);
      const existing = keys.get(key);
      if (existing !== undefined) return existing;
      const index = planes.length;
      planes.push({ normal: [...plane.normal] as [number, number, number], dist: plane.dist });
      keys.set(key, index);
      return index;
    },
  };
}

/** A single axis-aligned face plane of a box, in canonical form. */
interface FacePlane {
  plane: TreePlane;
  axis: 0 | 1 | 2;
  /** The solid side is coord <= dist for dir=+1, coord >= -dist for dir=-1. */
  dir: 1 | -1;
}

/** The 6 face planes of a box (solid side towards the interior). */
export function boxFacePlanes(box: AxisAlignedBox, expansion: [number, number, number] = [0, 0, 0]): FacePlane[] {
  const planes: FacePlane[] = [];
  for (let axis = 0; axis < 3; axis++) {
    const a = axis as 0 | 1 | 2;
    const lo = box.mins[a] - expansion[a];
    const hi = box.maxs[a] + expansion[a];
    // Normal +axis at hi: solid where coord <= hi.
    planes.push({ plane: { normal: axisNormal(a, 1), dist: hi }, axis: a, dir: 1 });
    // Normal -axis at lo: solid where -coord <= -lo  =>  coord >= lo.
    planes.push({ plane: { normal: axisNormal(a, -1), dist: -lo }, axis: a, dir: -1 });
  }
  return planes;
}

function axisNormal(axis: 0 | 1 | 2, dir: 1 | -1): [number, number, number] {
  const normal: [number, number, number] = [0, 0, 0];
  normal[axis] = dir;
  return normal;
}

/** Value of the split coordinate on the positive side of the plane. */
function planeValue(face: FacePlane): number {
  return face.dir === 1 ? face.plane.dist : -face.plane.dist;
}

function regionContains(outer: AxisAlignedBox, inner: AxisAlignedBox): boolean {
  for (let axis = 0; axis < 3; axis++) {
    if (outer.mins[axis]! > inner.mins[axis]!) return false;
    if (outer.maxs[axis]! < inner.maxs[axis]!) return false;
  }
  return true;
}

function regionIsEmpty(region: AxisAlignedBox): boolean {
  for (let axis = 0; axis < 3; axis++) {
    if (region.maxs[axis]! - region.mins[axis]! < MIN_REGION) return true;
  }
  return false;
}

function clipBoxToRegion(box: AxisAlignedBox, region: AxisAlignedBox): AxisAlignedBox | null {
  const out: AxisAlignedBox = { mins: [0, 0, 0], maxs: [0, 0, 0] };
  for (let axis = 0; axis < 3; axis++) {
    const lo = Math.max(box.mins[axis]!, region.mins[axis]!);
    const hi = Math.min(box.maxs[axis]!, region.maxs[axis]!);
    if (hi - lo < MIN_REGION) return null;
    out.mins[axis] = lo;
    out.maxs[axis] = hi;
  }
  return out;
}

/** Regions thinner than this collapse into a leaf. */
const MIN_REGION = 0.05;

export interface BuildTreeOptions {
  /** Expansion applied to the solid boxes (the GoldSrc hull dilation). */
  expansion?: [number, number, number];
  emptyContents: number;
  solidContents: number;
}

/**
 * Builds the tree for one hull. `region` should comfortably contain every box.
 */
export function buildTree(
  boxes: AxisAlignedBox[],
  region: AxisAlignedBox,
  registry: PlaneRegistry,
  options: BuildTreeOptions,
): TreeResult {
  const expansion = options.expansion ?? [0, 0, 0];
  const nodes: TreeNode[] = [];
  const leaves: TreeLeaf[] = [];

  // The hull dilation must be applied to the solid boxes themselves, not just to
  // the splitting planes: the "is this region solid?" test below compares the
  // region against these boxes, and getting that wrong leaves hulls 1..3 with no
  // solid leaves at all (every trace then reports "nothing hit").
  const expandedBoxes: AxisAlignedBox[] = boxes.map((box) => ({
    mins: [
      box.mins[0] - expansion[0],
      box.mins[1] - expansion[1],
      box.mins[2] - expansion[2],
    ],
    maxs: [
      box.maxs[0] + expansion[0],
      box.maxs[1] + expansion[1],
      box.maxs[2] + expansion[2],
    ],
  }));

  const addLeaf = (contents: number, leafRegion: AxisAlignedBox): number => {
    const index = leaves.length;
    leaves.push({
      contents,
      mins: [...leafRegion.mins],
      maxs: [...leafRegion.maxs],
    });
    return -1 - index;
  };

  const build = (solid: AxisAlignedBox[], current: AxisAlignedBox): number => {
    // A region entirely inside one solid box is solid.
    for (const box of solid) {
      if (regionContains(box, current)) return addLeaf(options.solidContents, current);
    }
    if (solid.length === 0 || regionIsEmpty(current)) {
      return addLeaf(options.emptyContents, current);
    }

    // Candidate splitters: face planes of the remaining boxes that cut the
    // region's interior. Prefer a balanced split to keep the tree shallow.
    let best: FacePlane | null = null;
    let bestValue = 0;
    let bestScore = Infinity;
    const seen = new Set<string>();

    for (const box of solid) {
      for (const face of boxFacePlanes(box)) {
        const value = planeValue(face);
        const axis = face.axis;

        const key = `${axis}:${Math.round(value * 100) / 100}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // The plane must cut through the inside of the region.
        if (value <= current.mins[axis]! + MIN_REGION) continue;
        if (value >= current.maxs[axis]! - MIN_REGION) continue;

        // Score: how evenly the remaining boxes land on the two sides. Boxes
        // that straddle the plane will have to be split, so they cost extra.
        let positiveCount = 0;
        let negativeCount = 0;
        for (const other of solid) {
          if (face.dir === 1) {
            if (other.mins[axis]! >= value - MIN_REGION) positiveCount++;
            else if (other.maxs[axis]! <= value + MIN_REGION) negativeCount++;
          } else {
            if (other.maxs[axis]! <= value + MIN_REGION) positiveCount++;
            else if (other.mins[axis]! >= value - MIN_REGION) negativeCount++;
          }
        }
        const straddling = solid.length - positiveCount - negativeCount;
        const score = Math.abs(positiveCount - negativeCount) + straddling * 2;
        if (score < bestScore) {
          bestScore = score;
          best = face;
          bestValue = value;
        }
      }
    }

    if (!best) return addLeaf(options.emptyContents, current);

    const value = bestValue;
    const axis = best.axis;

    const positiveRegion: AxisAlignedBox = {
      mins: [...current.mins],
      maxs: [...current.maxs],
    };
    const negativeRegion: AxisAlignedBox = {
      mins: [...current.mins],
      maxs: [...current.maxs],
    };

    // Positive side = dot(normal, x) >= dist.
    if (best.dir === 1) {
      positiveRegion.mins[axis] = value;
      negativeRegion.maxs[axis] = value;
    } else {
      positiveRegion.maxs[axis] = value;
      negativeRegion.mins[axis] = value;
    }

    const positiveBoxes: AxisAlignedBox[] = [];
    const negativeBoxes: AxisAlignedBox[] = [];
    for (const box of solid) {
      const pos = clipBoxToRegion(box, positiveRegion);
      if (pos) positiveBoxes.push(pos);
      const neg = clipBoxToRegion(box, negativeRegion);
      if (neg) negativeBoxes.push(neg);
    }

    const positiveChild = build(positiveBoxes, positiveRegion);
    const negativeChild = build(negativeBoxes, negativeRegion);

    const planeIndex = registry.indexOf(best.plane);
    const nodeIndex = nodes.length;
    nodes.push({ planeIndex, children: [positiveChild, negativeChild] });
    return nodeIndex;
  };

  const root = build(expandedBoxes, region);
  return { nodes, leaves, root };
}
