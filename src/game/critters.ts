/**
 * 功能：在每回合随机放置可射击的小鸡彩蛋，并处理子弹与小鸡的命中检测。
 * 时间：2026-10-21；作者：lq。
 *
 * 原版 cs_italy 通过 cycler_sprite 引用 models/chick.mdl 放置小鸡；本项目把同样的
 * “地图里能打的小动物”做成不依赖额外素材的轻量玩法：位置来自导航图的可行走节点，
 * 沿可行走地面游走，只参与子弹判定，不影响回合胜负、经济与比分。
 */

import type { Vec3 } from '../engine/math.ts';
import { v3 } from '../engine/math.ts';
import type { CollisionWorld, Hull } from '../engine/collision/types.ts';
import type { NavGraph } from './nav.ts';

/** 功能：小鸡默认血量，手枪一发可击杀，刀具需要两下。时间：2026-10-21；作者：lq。 */
export const CRITTER_HEALTH = 30;
/** 功能：小鸡的碰撞盒以脚底为原点，与原版小鸡约 20 单位的高度接近。时间：2026-10-21；作者：lq。 */
export const CRITTER_HALF_WIDTH = 9;
export const CRITTER_HEIGHT = 22;
/** 功能：单张地图最多八只，避免小动物数量随地图规模失控。时间：2026-10-21；作者：lq。 */
export const MAX_CRITTERS = 8;

export interface Critter {
  id: number;
  /** 功能：脚底位置，渲染和命中盒都以这里为基准。时间：2026-10-21；作者：lq。 */
  position: Vec3;
  yaw: number;
  /** 功能：每只小鸡独立的动画相位与配色，避免齐步走。时间：2026-10-21；作者：lq。 */
  phase: number;
  variant: number;
  /** 功能：记录实际步行距离和移动状态以驱动原版模型迈步。时间：2026-10-21；作者：lq。 */
  walkDistance?: number;
  moving?: boolean;
  health: number;
  alive: boolean;
  hitAt: number;
  diedAt: number;
}

const ZERO_HULL: Hull = { mins: v3(0, 0, 0), maxs: v3(0, 0, 0) };

let nextCritterId = 1;

/** 功能：按可行走节点随机撒点，避开双方出生区和彼此过近的位置。时间：2026-10-21；作者：lq。 */
export function placeCritters(options: {
  graph: NavGraph | null;
  world: CollisionWorld;
  spawns: Vec3[];
  random: () => number;
  count?: number;
}): Critter[] {
  const { graph, world, spawns, random } = options;
  if (!graph || graph.nodes.length === 0) return [];
  const count = options.count ?? Math.min(MAX_CRITTERS, Math.max(2, Math.round(graph.nodes.length / 350)));
  const placed: Critter[] = [];
  for (let attempt = 0; attempt < 900 && placed.length < count; attempt++) {
    const node = graph.nodes[Math.floor(random() * graph.nodes.length)];
    if (!node) continue;
    const x = node.x;
    const y = node.y;
    // 功能：导航节点保存的是站立 hull 中心，小鸡脚底在下方 36 单位。时间：2026-10-21；作者：lq。
    const down = world.traceHull(ZERO_HULL, v3(x, y, node.z - 20), v3(x, y, node.z - 58));
    const z = down.fraction < 1 && !down.startsolid ? down.endpos.z + 0.5 : node.z - 36;
    // 功能：出生点附近不放小鸡，避免开局被队友或敌人顺手打掉。时间：2026-10-21；作者：lq。
    if (spawns.some((spawn) => Math.hypot(spawn.x - x, spawn.y - y) < 420)) continue;
    if (placed.some((critter) => Math.hypot(critter.position.x - x, critter.position.y - y) < 180)) continue;
    // 功能：只接受脚底上方为空的位置，防止小动物卡进箱体或墙体。时间：2026-10-21；作者：lq。
    if (world.pointContents(v3(x, y, z + 10)) === -2) continue;
    placed.push({
      id: nextCritterId++,
      position: v3(x, y, z),
      yaw: random() * 360,
      phase: random() * 12,
      variant: Math.floor(random() * 3),
      health: CRITTER_HEALTH,
      alive: true,
      hitAt: -99,
      diedAt: -99,
    });
  }
  return placed;
}

export interface CritterHit {
  critter: Critter;
  distance: number;
  point: Vec3;
}

/** 功能：沿子弹方向检测存活小鸡的轴对齐碰撞盒，返回最近命中。时间：2026-10-21；作者：lq。 */
export function traceCritters(
  origin: Vec3,
  direction: Vec3,
  critters: readonly Critter[],
  maxDistance: number,
): CritterHit | null {
  let best: CritterHit | null = null;
  for (const critter of critters) {
    if (!critter.alive) continue;
    const feet = critter.position;
    const mins = { x: feet.x - CRITTER_HALF_WIDTH, y: feet.y - CRITTER_HALF_WIDTH, z: feet.z };
    const maxs = { x: feet.x + CRITTER_HALF_WIDTH, y: feet.y + CRITTER_HALF_WIDTH, z: feet.z + CRITTER_HEIGHT };
    let tMin = 0;
    let tMax = maxDistance;
    let hit = true;
    for (const axis of ['x', 'y', 'z'] as const) {
      if (Math.abs(direction[axis]) < 1e-8) {
        if (origin[axis] < mins[axis] || origin[axis] > maxs[axis]) {
          hit = false;
          break;
        }
        continue;
      }
      const inverse = 1 / direction[axis];
      let near = (mins[axis] - origin[axis]) * inverse;
      let far = (maxs[axis] - origin[axis]) * inverse;
      if (near > far) [near, far] = [far, near];
      if (near > tMin) tMin = near;
      if (far < tMax) tMax = far;
      if (tMin > tMax) {
        hit = false;
        break;
      }
    }
    if (!hit || tMin < 0) continue;
    if (best && tMin >= best.distance) continue;
    best = {
      critter,
      distance: tMin,
      point: v3(origin.x + direction.x * tMin, origin.y + direction.y * tMin, origin.z + direction.z * tMin),
    };
  }
  return best;
}

/** 功能：保存每只小鸡的游走决策，弱引用允许回合结束自动回收。时间：2026-10-21；作者：lq。 */
const wander = new WeakMap<Critter, { turnAt: number; restUntil: number }>();
// 功能：BSP 只有预编译玩家 hull，小鸡使用多条点探针覆盖身体，兼容 BSP 和 BrushWorld。时间：2026-10-21；作者：lq。
const WALK_PROBES = [[0, 0], [-6, -6], [-6, 6], [6, -6], [6, 6]] as const;

/** 功能：小鸡随机走停、遇墙转向，检测脚下地面以避免穿墙、掉崖或爬上高台。时间：2026-10-21；作者：lq。 */
export function updateCritters(critters: readonly Critter[], world: CollisionWorld, dt: number, now: number, random: () => number): void {
  for (const bird of critters) {
    bird.moving = false;
    if (!bird.alive) continue;
    let state = wander.get(bird);
    if (!state) { state = { turnAt: now + 2 + random() * 3, restUntil: 0 }; wander.set(bird, state); }
    if (now < state.restUntil) continue;
    if (now >= state.turnAt) {
      bird.yaw += (random() - 0.5) * 150;
      state.turnAt = now + 2 + random() * 4;
      if (random() < 0.3) { state.restUntil = now + 0.6 + random() * 1.4; continue; }
    }
    const angle = bird.yaw * Math.PI / 180;
    const distance = (22 + bird.variant * 3) * dt;
    const target = v3(bird.position.x + Math.cos(angle) * distance, bird.position.y + Math.sin(angle) * distance, bird.position.z);
    const floor = world.traceHull(ZERO_HULL, v3(target.x, target.y, target.z + 8), v3(target.x, target.y, target.z - 12));
    if (floor.startsolid || floor.allsolid || floor.fraction >= 1 || floor.normal.z < 0.7) {
      bird.yaw += 100 + random() * 100;
      state.turnAt = now + 1 + random();
      continue;
    }
    const next = v3(target.x, target.y, floor.endpos.z + 0.5);
    if (Math.abs(next.z - bird.position.z) > 7) { bird.yaw += 135; continue; }
    // 功能：先随坡面调整脚底高度，再在身体中心和四角检测墙壁，不让小鸡半身穿墙。时间：2026-10-21；作者：lq。
    const blocked = WALK_PROBES.some(([dx, dy]) => {
      const start = v3(bird.position.x + dx, bird.position.y + dy, bird.position.z + 10);
      const end = v3(next.x + dx, next.y + dy, next.z + 10);
      const trace = world.traceHull(ZERO_HULL, start, end);
      return trace.startsolid || trace.allsolid || trace.fraction < 1;
    });
    if (blocked) { bird.yaw += 100 + random() * 100; continue; }
    bird.walkDistance = (bird.walkDistance ?? 0) + distance;
    bird.position = next;
    bird.moving = true;
  }
}
