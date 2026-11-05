/** 功能：为仓库 BSP 的实体刷子添加门体碰撞、自动/使用开门和梯子触发区；时间：2026-11-05；作者：lq。 */
import type { Vec3 } from '../../engine/math.ts';
import { dot, v3 } from '../../engine/math.ts';
import type { CollisionWorld, Hull, TraceResult, LadderContact } from '../../engine/collision/types.ts';
import { CONTENTS_SOLID } from '../../engine/collision/types.ts';
import { BspCollisionWorld } from '../../engine/bsp/collision.ts';
import type { BspFile, BspEntity } from '../../engine/bsp/types.ts';
import { brushFromAABB, pointInBrush, traceHullVsBrush } from '../../engine/collision/brush.ts';
import type { Brush } from '../../engine/collision/brush.ts';

/** 功能：只传递碰撞所需的角色姿态，保持地图交互与游戏角色、Three.js 解耦；时间：2026-11-05；作者：lq。 */
export interface MapOccupant { origin: Vec3; hull: Hull }
export interface DoorPose { origin: Vec3; yaw: number }
export interface MapInteractions {
  update(dt: number, occupants: MapOccupant[]): void;
  use(eye: Vec3, direction: Vec3): boolean;
  reset(): void;
}

/** 功能：保存局部 BSP 碰撞及世界坐标包围盒，先做包围盒剔除以控制射线成本；时间：2026-11-05；作者：lq。 */
interface EntityBody {
  index: number;
  entity: BspEntity;
  world: BspCollisionWorld;
  origin: Vec3;
  mins: Vec3;
  maxs: Vec3;
}
interface Door extends EntityBody {
  progress: number;
  hold: number;
  requested: boolean;
  rotating: boolean;
  travel: Vec3;
  degrees: number;
  duration: number;
  wait: number;
  brush: Brush;
}

/** 功能：平移局部 BSP 坐标，普通 func_wall 无 origin 时保持原有世界坐标；时间：2026-11-05；作者：lq。 */
function shifted(point: Vec3, offset: Vec3, sign = 1): Vec3 {
  return v3(point.x + offset.x * sign, point.y + offset.y * sign, point.z + offset.z * sign);
}

/** 功能：线段扩展到角色 hull 后与实体包围盒做宽相位检查；时间：2026-11-05；作者：lq。 */
function overlaps(body: EntityBody, hull: Hull, start: Vec3, end = start, padding = 0): boolean {
  return (['x', 'y', 'z'] as const).every((axis) =>
    Math.max(start[axis], end[axis]) + hull.maxs[axis] + padding >= body.mins[axis] + body.origin[axis]
    && Math.min(start[axis], end[axis]) + hull.mins[axis] - padding <= body.maxs[axis] + body.origin[axis]);
}

/** 功能：门体是旋转后的凸六面体，用世界平面扩大角色 hull，避免把旋转门误当轴对齐墙；时间：2026-11-05；作者：lq。 */
function doorBrush(door: Door, progress: number): Brush {
  const yaw = door.rotating ? door.degrees * progress * Math.PI / 180 : 0;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const offset = shifted(door.origin, v3(door.travel.x * progress, door.travel.y * progress, door.travel.z * progress));
  return { planes: brushFromAABB(door.mins, door.maxs).planes.map((plane) => {
    const normal = v3(c * plane.normal.x - s * plane.normal.y, s * plane.normal.x + c * plane.normal.y, plane.normal.z);
    return { normal, dist: plane.dist + dot(normal, offset) };
  }) };
}

/** 功能：组合世界 BSP、实体实墙及活动门，供移动、子弹和手雷共用同一碰撞结果；时间：2026-11-05；作者：lq。 */
export class BspEntityWorld implements CollisionWorld, MapInteractions {
  private readonly base: BspCollisionWorld;
  private readonly solids: EntityBody[] = [];
  private readonly ladders: EntityBody[] = [];
  private readonly doors: Door[] = [];
  readonly doorModels: number[] = [];
  /** 功能：保存可选的门体显示回调，纯模拟测试无需渲染器；时间：2026-11-05；作者：lq。 */
  private readonly onDoorPose?: (index: number, pose: DoorPose) => void;

  /** 功能：从真实 BSP 实体读取门方向、速度和等待时间，静态实体保持编译后的精确 clipnode；时间：2026-11-05；作者：lq。 */
  constructor(bsp: BspFile, onDoorPose?: (index: number, pose: DoorPose) => void) {
    this.onDoorPose = onDoorPose;
    this.base = new BspCollisionWorld(bsp);
    for (const entity of bsp.entityList) {
      if (!/^\*\d+$/.test(entity.properties.model ?? '')) continue;
      const index = Number(entity.properties.model!.slice(1));
      const model = bsp.models[index];
      if (!model || index === 0) continue;
      const body: EntityBody = { index, entity, world: new BspCollisionWorld(bsp, index),
        origin: entity.origin ?? v3(), mins: model.mins, maxs: model.maxs };
      if (entity.classname === 'func_ladder') { this.ladders.push(body); continue; }
      if (entity.classname === 'func_door' || entity.classname === 'func_door_rotating') {
        const rotating = entity.classname === 'func_door_rotating';
        const degrees = Number(entity.properties.distance) || 90;
        const angle = Number(entity.properties.angle) || 0;
        const direction = angle === -1 ? v3(0, 0, 1) : angle === -2 ? v3(0, 0, -1)
          : v3(Math.cos(angle * Math.PI / 180), Math.sin(angle * Math.PI / 180), 0);
        const travelDistance = Math.max(1, Math.abs(direction.x) * (model.maxs.x - model.mins.x)
          + Math.abs(direction.y) * (model.maxs.y - model.mins.y)
          + Math.abs(direction.z) * (model.maxs.z - model.mins.z) - (Number(entity.properties.lip) || 0));
        const flags = Number(entity.properties.spawnflags) || 0;
        const door: Door = { ...body, progress: 0, hold: 0, requested: false, rotating,
          degrees: flags & 2 ? -degrees : degrees,
          travel: rotating ? v3() : v3(direction.x * travelDistance, direction.y * travelDistance, direction.z * travelDistance),
          duration: (rotating ? Math.abs(degrees) : travelDistance) / Math.max(1, Number(entity.properties.speed) || 100),
          wait: Number.isFinite(Number(entity.properties.wait)) ? Number(entity.properties.wait) : 3,
          brush: { planes: [] } };
        door.brush = doorBrush(door, 0);
        this.doors.push(door); this.doorModels.push(index);
      } else if (['func_wall', 'func_breakable', 'func_button'].includes(entity.classname)) {
        this.solids.push(body);
      }
    }
    this.reset();
  }

  /** 功能：合并所有实体命中，保留最早命中面和实体的起点/全程实心状态；时间：2026-11-05；作者：lq。 */
  traceHull(hull: Hull, start: Vec3, end: Vec3): TraceResult {
    let result = this.base.traceHull(hull, start, end);
    const merge = (hit: TraceResult): void => {
      const startsolid = result.startsolid || hit.startsolid, allsolid = result.allsolid || hit.allsolid;
      if (hit.fraction < result.fraction) result = hit;
      result.startsolid = startsolid; result.allsolid = allsolid;
      if (startsolid) { result.fraction = 0; result.endpos = { ...start }; }
    };
    for (const body of this.solids) {
      if (!overlaps(body, hull, start, end)) continue;
      const hit = body.world.traceHull(hull, shifted(start, body.origin, -1), shifted(end, body.origin, -1));
      hit.endpos = shifted(hit.endpos, body.origin);
      hit.dist += dot(hit.normal, body.origin);
      merge(hit);
    }
    for (const door of this.doors) {
      const hit = traceHullVsBrush(door.brush, hull, start, end);
      if (!hit) continue;
      merge({ ...hit, endpos: v3(start.x + (end.x - start.x) * hit.fraction,
        start.y + (end.y - start.y) * hit.fraction, start.z + (end.z - start.z) * hit.fraction) });
    }
    return result;
  }

  /** 功能：实体墙与当前门姿态参与点内容检测，水等非实心世界内容继续沿用原 BSP；时间：2026-11-05；作者：lq。 */
  pointContents(point: Vec3): number {
    const contents = this.base.pointContents(point);
    if (contents === CONTENTS_SOLID || this.doors.some((door) => pointInBrush(door.brush, point))) return CONTENTS_SOLID;
    for (const body of this.solids) {
      if (overlaps(body, { mins: v3(), maxs: v3() }, point)
        && body.world.pointContents(shifted(point, body.origin, -1)) === CONTENTS_SOLID) return CONTENTS_SOLID;
    }
    return contents;
  }

  /** 功能：只在角色身体触及梯子薄层时提供表面法线，不把普通墙面当作可攀爬表面；时间：2026-11-05；作者：lq。 */
  ladderAt(hull: Hull, origin: Vec3): LadderContact | null {
    for (const ladder of this.ladders) {
      if (!overlaps(ladder, hull, origin, origin, 1)) continue;
      const mins = shifted(ladder.mins, ladder.origin), maxs = shifted(ladder.maxs, ladder.origin);
      const axis = maxs.x - mins.x <= maxs.y - mins.y ? 'x' : 'y';
      const normal = v3(); normal[axis] = origin[axis] < (mins[axis] + maxs[axis]) / 2 ? -1 : 1;
      return { normal, mins, maxs };
    }
    return null;
  }

  /** 功能：门的显示位移和旋转由同一进度驱动，防止画面开启但碰撞仍关闭；时间：2026-11-05；作者：lq。 */
  private publish(door: Door): void {
    this.onDoorPose?.(door.index, { origin: shifted(door.origin,
      v3(door.travel.x * door.progress, door.travel.y * door.progress, door.travel.z * door.progress)),
      yaw: door.rotating ? door.degrees * door.progress : 0 });
  }

  /** 功能：原版触碰开门加宽为近距离自动开门，关门遇人则暂停并重新打开，暂停游戏不推进；时间：2026-11-05；作者：lq。 */
  update(dt: number, occupants: MapOccupant[]): void {
    for (const door of this.doors) {
      const automatic = !door.entity.properties.targetname && !(Number(door.entity.properties.spawnflags) & 256);
      const nearby = automatic && occupants.some((actor) => overlaps(door, actor.hull, actor.origin, actor.origin, 28));
      if (door.requested || nearby) door.hold = Math.max(0, door.wait);
      const opening = door.requested || nearby || door.hold > 0 || (door.wait < 0 && door.progress > 0);
      door.requested = false;
      if (!nearby) door.hold = Math.max(0, door.hold - dt);
      const next = Math.max(0, Math.min(1, door.progress + (opening ? 1 : -1) * dt / door.duration));
      const brush = doorBrush(door, next);
      const blocked = occupants.some((actor) => traceHullVsBrush(brush, actor.hull, actor.origin, actor.origin)?.startsolid);
      if (blocked) { door.hold = Math.max(door.hold, 1); continue; }
      door.progress = next; door.brush = brush; this.publish(door);
    }
  }

  /** 功能：E 键使用必须在 96 单位内且视线无遮挡，避免隔墙或背对门时开门；时间：2026-11-05；作者：lq。 */
  use(eye: Vec3, direction: Vec3): boolean {
    const end = shifted(eye, v3(direction.x * 96, direction.y * 96, direction.z * 96));
    const hull = { mins: v3(), maxs: v3() };
    const visible = this.traceHull(hull, eye, end);
    let selected: Door | undefined; let nearest = 1;
    for (const door of this.doors) {
      const hit = traceHullVsBrush(door.brush, hull, eye, end);
      if (hit && hit.fraction <= visible.fraction + 0.001 && hit.fraction < nearest) {
        selected = door; nearest = hit.fraction;
      }
    }
    if (!selected) return false;
    selected.requested = true;
    return true;
  }

  /** 功能：回合重开时门回到关闭姿态，清除上一局等待与触发状态；时间：2026-11-05；作者：lq。 */
  reset(): void {
    for (const door of this.doors) {
      door.progress = 0; door.hold = 0; door.requested = false;
      door.brush = doorBrush(door, 0); this.publish(door);
    }
  }
}
