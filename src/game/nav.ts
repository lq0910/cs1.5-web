/**
 * Automatic navigation graph.
 *
 * Hand-authored waypoints are not an option (any BSP must work), so the graph is
 * derived from the collision world at load time:
 *
 *   1. sample a grid over the map bounds;
 *   2. for every cell, cast a ray downwards and collect *every* standable floor
 *      inside it (dust2 has tunnels and two-storey areas, so one height per cell
 *      is not enough);
 *   3. keep the floors where the standing player hull fits (head room) and the
 *      surface is walkable (normal.z >= 0.7);
 *   4. link neighbouring cells when the step between them is small enough to walk
 *      up, or small enough to drop down, and the hull can actually pass between
 *      them.
 *
 * The result is a small weighted graph that A* can run on, and bots then drive
 * the *same* pmove code the player uses.
 */

import type { Vec3 } from '../engine/math.ts';
import { v3 } from '../engine/math.ts';
import type { CollisionWorld, Hull } from '../engine/collision/types.ts';
import { HULL_STANDING } from '../engine/collision/types.ts';

/** GoldSrc player hull centre is 36 units above the feet. */
const HULL_CENTRE_Z = 36;

/** How far up a bot can step, and how far down it is willing to drop. */
const MAX_STEP_UP = 20;
const MAX_DROP = 220;

export interface NavNode {
  /** Hull centre position (feet + 36). */
  x: number;
  y: number;
  z: number;
  /** Indices into NavGraph.nodes with traversal costs. */
  neighbors: number[];
  costs: number[];
  /** Grid cell, kept for debugging and for nearest-node lookup. */
  cellX: number;
  cellY: number;
}

export interface NavGraph {
  nodes: NavNode[];
  cellSize: number;
  bounds: { mins: Vec3; maxs: Vec3 };
  /** Grid index -> node indices, for fast nearest-node queries. */
  cells: Map<number, number[]>;
  /** Milliseconds spent building, for the HUD. */
  buildTimeMs: number;
  stats: {
    floors: number;
    links: number;
    /** Size of the largest connected component (spawnable area). */
    largestComponent: number;
  };
}

export interface NavBuildOptions {
  cellSize?: number;
  /** Skip nodes whose floor is above this (sky boxes / rooflines). */
  maxFloorsPerCell?: number;
}

function cellKey(cellX: number, cellY: number): number {
  // Cantor-ish packing; cells are small non-negative ints.
  return cellX * 100003 + cellY;
}

const POINT_HULL: Hull = { mins: v3(0, 0, 0), maxs: v3(0, 0, 0) };
const CONTENTS_SOLID = -2;

/** Steps down until the point is no longer inside solid geometry. */
function escapeSolid(world: CollisionWorld, x: number, y: number, fromZ: number, bottomZ: number): number {
  let z = fromZ;
  let guard = 0;
  while (z > bottomZ && guard++ < 512 && world.pointContents(v3(x, y, z)) === CONTENTS_SOLID) {
    z -= 16;
  }
  return z;
}

/**
 * Every standable floor under a cell, top to bottom.
 *
 * A single long ray is not enough: GoldSrc maps are wrapped in sky brushes, so a
 * ray from above the map starts inside solid and would report "startsolid" and
 * nothing else. Instead we skip the leading solid and then walk downwards from
 * surface to surface, which also finds tunnel and basement floors.
 */
function collectFloors(
  world: CollisionWorld,
  x: number,
  y: number,
  topZ: number,
  bottomZ: number,
  maxFloors: number,
): { z: number; normal: Vec3 }[] {
  const out: { z: number; normal: Vec3 }[] = [];
  let z = escapeSolid(world, x, y, topZ, bottomZ);
  let guard = 0;

  while (z > bottomZ && out.length < maxFloors && guard++ < 64) {
    const trace = world.traceHull(POINT_HULL, v3(x, y, z), v3(x, y, bottomZ));
    if (trace.fraction >= 1 || trace.startsolid) break;
    const hitZ = z + (bottomZ - z) * trace.fraction;
    out.push({ z: hitZ, normal: trace.normal });
    z = escapeSolid(world, x, y, hitZ - 8, bottomZ);
  }

  return out;
}

const POINT_HULL_LOCAL: Hull = { mins: v3(0, 0, 0), maxs: v3(0, 0, 0) };

/**
 * Can a bot walk straight from one node to another?
 *
 * Testing this with the standing hull alone is far too strict: a 2 unit bump in
 * the floor, or a step the player can simply walk up, rejects the link and the
 * graph shatters into islands. Instead:
 *   - a *point* trace proves there is no wall in the way (it happily clears
 *     steps, which a walking player also clears);
 *   - the standing hull must fit at the mid-point, which is what stops a link
 *     being created through a gap too narrow for the player.
 * Drops are exempt from the mid-point test because the bot is in the air.
 */
function linkReachable(world: CollisionWorld, from: Vec3, to: Vec3, dz: number): boolean {
  // Strongest evidence: the standing hull can sweep the whole way (lifted by the
  // step height so a staircase counts as walkable).
  const lift = Math.max(0, dz) + 2;
  const sweep = world.traceHull(
    HULL_STANDING,
    v3(from.x, from.y, from.z + lift),
    v3(to.x, to.y, to.z + lift),
  );
  if (sweep.fraction >= 0.9) return true;
  // A drop: the bot is briefly airborne, so the lifted sweep must still be clear.
  if (dz < -MAX_STEP_UP) {
    const dropSweep = world.traceHull(
      HULL_STANDING,
      v3(from.x, from.y, from.z + 2),
      v3(to.x, to.y, to.z + 2),
    );
    return dropSweep.fraction >= 0.9;
  }

  // Otherwise let the mid-point decide (a bump or a step edge in the way).
  const point = world.traceHull(POINT_HULL_LOCAL, from, to);
  if (point.fraction < 0.9) return false;
  const mid = v3((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
  return hullSupported(world, mid, MAX_STEP_UP + 4);
}

/** True when a walkable floor is within `tolerance` below the hull centre. */
function hullSupported(world: CollisionWorld, centre: Vec3, tolerance: number): boolean {
  const inside = world.traceHull(HULL_STANDING, centre, centre);
  if (inside.startsolid || inside.allsolid) return false;
  const below = world.traceHull(
    HULL_STANDING,
    centre,
    v3(centre.x, centre.y, centre.z - tolerance),
  );
  return below.fraction < 1 && below.normal.z >= 0.7;
}

function hullFits(world: CollisionWorld, centre: Vec3): boolean {
  const trace = world.traceHull(HULL_STANDING, centre, centre);
  if (trace.startsolid || trace.allsolid) return false;
  // Must have a floor within the step tolerance, i.e. actually standable.
  const below = world.traceHull(HULL_STANDING, centre, v3(centre.x, centre.y, centre.z - 4));
  return below.fraction < 1 && below.normal.z >= 0.7;
}

export function buildNavGraph(
  world: CollisionWorld,
  bounds: { mins: Vec3; maxs: Vec3 },
  options: NavBuildOptions = {},
): NavGraph {
  const started = Date.now();
  const cellSize = options.cellSize ?? 64;
  const maxFloors = options.maxFloorsPerCell ?? 6;

  const minX = Math.floor(bounds.mins.x / cellSize) * cellSize;
  const minY = Math.floor(bounds.mins.y / cellSize) * cellSize;
  const maxX = Math.ceil(bounds.maxs.x / cellSize) * cellSize;
  const maxY = Math.ceil(bounds.maxs.y / cellSize) * cellSize;
  const topZ = bounds.maxs.z + 64;
  const bottomZ = bounds.mins.z - 64;

  const nodes: NavNode[] = [];
  const cells = new Map<number, number[]>();
  let floors = 0;

  for (let x = minX; x <= maxX; x += cellSize) {
    for (let y = minY; y <= maxY; y += cellSize) {
      const cx = Math.round((x - minX) / cellSize);
      const cy = Math.round((y - minY) / cellSize);
      const key = cellKey(cx, cy);
      const found: number[] = [];

      for (const hit of collectFloors(world, x, y, topZ, bottomZ, maxFloors)) {
        floors++;
        if (hit.normal.z < 0.7) continue;
        const centre = v3(x, y, hit.z + HULL_CENTRE_Z);
        if (!hullFits(world, centre)) continue;
        const index = nodes.length;
        nodes.push({ x, y, z: centre.z, neighbors: [], costs: [], cellX: cx, cellY: cy });
        found.push(index);
      }

      if (found.length > 0) cells.set(key, found);
    }
  }

  // ---- connectivity
  // Link over a two-cell radius as well as the immediate neighbours: a 64 unit
  // grid alone leaves the graph shattered into islands wherever a doorway or a
  // step sits between two grid points.
  const offsets: [number, number][] = [];
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      if (dx === 0 && dy === 0) continue;
      if (Math.max(Math.abs(dx), Math.abs(dy)) > 2) continue;
      offsets.push([dx, dy]);
    }
  }

  let links = 0;
  const neighbourOf = (nodeIndex: number, dx: number, dy: number): number[] =>
    cells.get(cellKey(nodes[nodeIndex]!.cellX + dx, nodes[nodeIndex]!.cellY + dy)) ?? [];

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const from = v3(node.x, node.y, node.z);

    for (const [dx, dy] of offsets) {
      const candidates = neighbourOf(i, dx, dy);
      if (candidates.length === 0) continue;

      // Order the candidates by how natural the step is, then take the first one
      // that is actually reachable. Trying only the best candidate loses the
      // link entirely when a cell holds several floors (multi-storey maps).
      const scored: { index: number; score: number; dz: number }[] = [];
      for (const candidate of candidates) {
        const target = nodes[candidate]!;
        const dz = target.z - node.z;
        if (dz > MAX_STEP_UP || dz < -MAX_DROP) continue;
        const distance = Math.hypot(target.x - node.x, target.y - node.y);
        if (distance > cellSize * 2.3) continue;
        scored.push({ index: candidate, score: Math.abs(dz) + distance * 0.01, dz });
      }
      scored.sort((a, b) => a.score - b.score);

      for (const candidate of scored) {
        const target = nodes[candidate.index]!;
        if (node.neighbors.includes(candidate.index)) break;
        if (!linkReachable(world, from, v3(target.x, target.y, target.z), candidate.dz)) continue;

        node.neighbors.push(candidate.index);
        node.costs.push(
          Math.hypot(target.x - node.x, target.y - node.y) + Math.abs(target.z - node.z) * 0.6,
        );
        links++;
        break;
      }
    }
  }

  // ---- rescue pass: connect stranded nodes to their nearest reachable neighbour
  const stranded: number[] = [];
  for (let i = 0; i < nodes.length; i++) if (nodes[i]!.neighbors.length === 0) stranded.push(i);

  for (const index of stranded) {
    const node = nodes[index]!;
    let best = -1;
    let bestDistance = Infinity;
    for (let other = 0; other < nodes.length; other++) {
      if (other === index) continue;
      const target = nodes[other]!;
      const distance = Math.hypot(target.x - node.x, target.y - node.y);
      if (distance > cellSize * 3 || distance >= bestDistance) continue;
      if (Math.abs(target.z - node.z) > MAX_DROP) continue;

      if (!linkReachable(world, v3(node.x, node.y, node.z), v3(target.x, target.y, target.z), target.z - node.z)) {
        continue;
      }

      best = other;
      bestDistance = distance;
    }

    if (best >= 0) {
      const target = nodes[best]!;
      const cost = Math.hypot(target.x - node.x, target.y - node.y) * 2;
      node.neighbors.push(best);
      node.costs.push(cost);
      target.neighbors.push(index);
      target.costs.push(cost);
      links += 2;
    }
  }

  // ---- largest connected component (a map can have sealed-off pockets)
  let largest = 0;
  const seen = new Uint8Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    if (seen[i]) continue;
    let size = 0;
    const stack = [i];
    seen[i] = 1;
    while (stack.length > 0) {
      const current = stack.pop()!;
      size++;
      for (const next of nodes[current]!.neighbors) {
        if (!seen[next]) {
          seen[next] = 1;
          stack.push(next);
        }
      }
    }
    if (size > largest) largest = size;
  }

  return {
    nodes,
    cellSize,
    bounds,
    cells,
    buildTimeMs: Date.now() - started,
    stats: { floors, links, largestComponent: largest },
  };
}

/** Nearest node to a point, preferring nodes on a similar floor. */
export function nearestNode(graph: NavGraph, point: Vec3): number {
  if (graph.nodes.length === 0) return -1;
  const cellSize = graph.cellSize;
  const cellX = Math.round((point.x - Math.floor(graph.bounds.mins.x / cellSize) * cellSize) / cellSize);
  const cellY = Math.round((point.y - Math.floor(graph.bounds.mins.y / cellSize) * cellSize) / cellSize);

  let best = -1;
  let bestScore = Infinity;
  for (let radius = 0; radius <= 8; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (radius > 0 && Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const list = graph.cells.get(cellKey(cellX + dx, cellY + dy));
        if (!list) continue;
        for (const index of list) {
          const node = graph.nodes[index]!;
          const score =
            Math.hypot(node.x - point.x, node.y - point.y) + Math.abs(node.z - point.z) * 1.5;
          if (score < bestScore) {
            bestScore = score;
            best = index;
          }
        }
      }
    }
    if (best >= 0 && radius >= 1) break;
  }
  return best;
}

/** Minimal binary heap for A*. */
class MinHeap {
  private readonly items: number[] = [];
  private readonly priority: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: number, priority: number): void {
    this.items.push(item);
    this.priority.push(priority);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.priority[parent]! <= this.priority[i]!) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.items[0]!;
    const lastItem = this.items.pop()!;
    const lastPriority = this.priority.pop()!;
    if (this.items.length > 0) {
      this.items[0] = lastItem;
      this.priority[0] = lastPriority;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let smallest = i;
        if (left < this.items.length && this.priority[left]! < this.priority[smallest]!) smallest = left;
        if (right < this.items.length && this.priority[right]! < this.priority[smallest]!) smallest = right;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const item = this.items[a]!;
    this.items[a] = this.items[b]!;
    this.items[b] = item;
    const priority = this.priority[a]!;
    this.priority[a] = this.priority[b]!;
    this.priority[b] = priority;
  }
}

export interface PathResult {
  /** Waypoints (hull centres) from start to goal, start excluded. */
  points: Vec3[];
  nodes: number[];
  cost: number;
  /** True when the goal could not be reached exactly and a nearby node was used. */
  approximate: boolean;
}

/**
 * A* over the navigation graph.
 * Returns null when no path exists between the two points.
 */
export function findPath(graph: NavGraph, from: Vec3, to: Vec3, maxExpansions = 20000): PathResult | null {
  const start = nearestNode(graph, from);
  const goal = nearestNode(graph, to);
  if (start < 0 || goal < 0) return null;

  const goalNode = graph.nodes[goal]!;
  const count = graph.nodes.length;
  const gScore = new Float64Array(count).fill(Infinity);
  const cameFrom = new Int32Array(count).fill(-1);
  const closed = new Uint8Array(count);

  const heuristic = (index: number): number => {
    const node = graph.nodes[index]!;
    return Math.hypot(node.x - goalNode.x, node.y - goalNode.y) + Math.abs(node.z - goalNode.z) * 0.8;
  };

  const open = new MinHeap();
  gScore[start] = 0;
  open.push(start, heuristic(start));

  let expansions = 0;
  while (open.size > 0 && expansions < maxExpansions) {
    const current = open.pop();
    if (closed[current]) continue;
    closed[current] = 1;
    expansions++;

    if (current === goal) break;

    const node = graph.nodes[current]!;
    for (let i = 0; i < node.neighbors.length; i++) {
      const next = node.neighbors[i]!;
      if (closed[next]) continue;
      const tentative = gScore[current]! + node.costs[i]!;
      if (tentative < gScore[next]!) {
        gScore[next] = tentative;
        cameFrom[next] = current;
        open.push(next, tentative + heuristic(next));
      }
    }
  }

  if (!Number.isFinite(gScore[goal]!)) return null;

  const nodes: number[] = [];
  let cursor = goal;
  while (cursor >= 0) {
    nodes.push(cursor);
    if (cursor === start) break;
    cursor = cameFrom[cursor]!;
  }
  nodes.reverse();

  const points = nodes.map((index) => {
    const node = graph.nodes[index]!;
    return v3(node.x, node.y, node.z);
  });

  // Replace the first waypoint with the actual start when it is close enough,
  // so bots do not walk backwards to the grid point.
  const startNode = graph.nodes[start]!;
  if (nodes[0] === start && Math.hypot(from.x - startNode.x, from.y - startNode.y) < 8) {
    points.shift();
  }

  return {
    points,
    nodes,
    cost: gScore[goal]!,
    approximate: Math.hypot(goalNode.x - to.x, goalNode.y - to.y) > graph.cellSize,
  };
}

/** Number of nodes reachable from a node (used to validate a map's navmesh). */
export function reachableCount(graph: NavGraph, from: Vec3): number {
  const start = nearestNode(graph, from);
  if (start < 0) return 0;
  const seen = new Uint8Array(graph.nodes.length);
  const stack = [start];
  seen[start] = 1;
  let count = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    count++;
    for (const next of graph.nodes[current]!.neighbors) {
      if (!seen[next]) {
        seen[next] = 1;
        stack.push(next);
      }
    }
  }
  return count;
}

/** Random walkable node near a point (for patrols), within `radius` units. */
export function randomNodeNear(graph: NavGraph, point: Vec3, radius: number, random: () => number): number {
  const origin = nearestNode(graph, point);
  if (origin < 0) return -1;
  const originNode = graph.nodes[origin]!;
  const candidates: number[] = [];
  for (let i = 0; i < graph.nodes.length; i++) {
    const node = graph.nodes[i]!;
    if (Math.hypot(node.x - originNode.x, node.y - originNode.y) > radius) continue;
    if (Math.abs(node.z - originNode.z) > 160) continue;
    candidates.push(i);
  }
  if (candidates.length === 0) return origin;
  return candidates[Math.floor(random() * candidates.length)]!;
}
