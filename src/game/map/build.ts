/**
 * Map data model + authoring helpers shared by the built-in maps and (later) the
 * BSP importer.
 *
 * The runtime only needs three things from a map: render boxes (or a mesh),
 * a CollisionWorld, and spawn points. Keeping that contract tiny means the BSP
 * backend and the hand-authored backend are interchangeable.
 */

import type { Vec3 } from '../../engine/math.ts';
import { v3 } from '../../engine/math.ts';
import type { CollisionWorld, Hull } from '../../engine/collision/types.ts';
import type { BoxDef } from '../../engine/collision/brush.ts';
import { BrushWorld } from '../../engine/collision/brush.ts';

export interface MapSpawn {
  origin: Vec3;
  yaw: number;
  team: 'ct' | 't';
}

export interface MapBounds {
  mins: Vec3;
  maxs: Vec3;
}

export interface MapData {
  name: string;
  /** World bounds, used to place the navigation grid. */
  bounds: MapBounds;
  /** Axis-aligned boxes used for rendering (materials drive the texturing). */
  boxes: BoxDef[];
  collision: CollisionWorld;
  spawns: MapSpawn[];
  /** Sky/fog tint for the renderer. */
  skyColor: number;
  fogColor: number;
  /** Optional external render mesh (used by the BSP loader). */
  bsp?: unknown;
}

export function box(mins: Vec3, maxs: Vec3, material: string): BoxDef {
  return { mins, maxs, material, solid: true };
}

interface Rect {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

/**
 * Cuts rectangular holes out of a rectangle by recursive guillotine splitting.
 * Used to punch doors and windows into walls without a CSG library.
 */
export function subtractRectHoles(rect: Rect, holes: Rect[]): Rect[] {
  let pieces: Rect[] = [rect];

  for (const hole of holes) {
    const next: Rect[] = [];
    for (const p of pieces) {
      const noOverlap =
        hole.a1 <= p.a0 || hole.a0 >= p.a1 || hole.b1 <= p.b0 || hole.b0 >= p.b1;
      if (noOverlap) {
        next.push(p);
        continue;
      }
      // Split off the parts left and right of the hole.
      if (hole.a0 > p.a0) next.push({ a0: p.a0, a1: hole.a0, b0: p.b0, b1: p.b1 });
      if (hole.a1 < p.a1) next.push({ a0: hole.a1, a1: p.a1, b0: p.b0, b1: p.b1 });
      // Then the parts above and below it, inside the hole's span.
      const a0 = Math.max(p.a0, hole.a0);
      const a1 = Math.min(p.a1, hole.a1);
      if (a1 > a0) {
        if (hole.b0 > p.b0) next.push({ a0, a1, b0: p.b0, b1: hole.b0 });
        if (hole.b1 < p.b1) next.push({ a0, a1, b0: hole.b1, b1: p.b1 });
      }
    }
    pieces = next;
  }

  return pieces;
}

export interface WallHole {
  /** Opening span along the wall's horizontal axis. */
  from: number;
  to: number;
  /** Opening span in Z (height). */
  bottom: number;
  top: number;
}

/**
 * Builds a wall along X (`axis: 'x'`) or along Y, with door/window openings.
 *
 * - `axis: 'x'` => the wall runs along X, i.e. it is thin in Y.
 */
export function wallWithHoles(
  axis: 'x' | 'y',
  /** Horizontal extent of the wall. */
  from: number,
  to: number,
  /** Thickness extent: the wall occupies this range on the other horizontal axis. */
  thicknessFrom: number,
  thicknessTo: number,
  /** Vertical extent. */
  zFrom: number,
  zTo: number,
  holes: WallHole[],
  material: string,
): BoxDef[] {
  const rect: Rect = { a0: from, a1: to, b0: zFrom, b1: zTo };
  const holeRects: Rect[] = holes.map((h) => ({ a0: h.from, a1: h.to, b0: h.bottom, b1: h.top }));
  const pieces = subtractRectHoles(rect, holeRects);

  return pieces.map((p) => {
    const mins = v3();
    const maxs = v3();
    if (axis === 'x') {
      mins.x = p.a0;
      maxs.x = p.a1;
      mins.y = thicknessFrom;
      maxs.y = thicknessTo;
    } else {
      mins.y = p.a0;
      maxs.y = p.a1;
      mins.x = thicknessFrom;
      maxs.x = thicknessTo;
    }
    mins.z = p.b0;
    maxs.z = p.b1;
    return box(mins, maxs, material);
  });
}

/** A flight of stairs climbing in +Z along +Y, starting at `startY`. */
export function stairs(
  xFrom: number,
  xTo: number,
  startY: number,
  steps: number,
  rise: number,
  tread: number,
  material: string,
): BoxDef[] {
  const out: BoxDef[] = [];
  for (let i = 0; i < steps; i++) {
    out.push(
      box(
        v3(xFrom, startY + i * tread, 0),
        v3(xTo, startY + (i + 1) * tread, (i + 1) * rise),
        material,
      ),
    );
  }
  return out;
}

/** Builds the collision world for a box list, ignoring non-solid (decorative) boxes. */
export function collisionFromBoxes(boxes: BoxDef[]): CollisionWorld {
  return BrushWorld.fromBoxes(boxes);
}

/** Convenience used by tests: a closed room with a floor. */
export function makeTestRoom(size = 512, height = 256): MapData {
  const h = size / 2;
  const t = 16;
  const boxes: BoxDef[] = [
    box(v3(-h, -h, -t), v3(h, h, 0), 'concrete'),
    box(v3(-h - t, -h - t, 0), v3(h + t, -h, height), 'stucco'),
    box(v3(-h - t, h, 0), v3(h + t, h + t, height), 'stucco'),
    box(v3(-h - t, -h - t, 0), v3(-h, h + t, height), 'stucco'),
    box(v3(h, -h - t, 0), v3(h + t, h + t, height), 'stucco'),
  ];
  return {
    name: 'test_room',
    bounds: { mins: v3(-h - t, -h - t, -t), maxs: v3(h + t, h + t, height) },
    boxes,
    collision: collisionFromBoxes(boxes),
    spawns: [{ origin: v3(0, 0, 40), yaw: 0, team: 'ct' }],
    skyColor: 0x4a6b8a,
    fogColor: 0x8fa4b8,
  };
}

/** Returns true when the hull at `origin` is not intersecting anything. */
export function positionIsFree(world: CollisionWorld, hull: Hull, origin: Vec3): boolean {
  const probe = v3(origin.x, origin.y, origin.z - 2);
  const trace = world.traceHull(hull, origin, probe);
  return !trace.startsolid && !trace.allsolid;
}
