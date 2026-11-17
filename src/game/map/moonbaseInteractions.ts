/** 功能：月球基地气闸、弹射平台与共享动态碰撞，支持玩家、BOT 和房主快照；时间：2026-11-17；作者：lq。 */
import { v3 } from '../../engine/math.ts';
import type { Vec3 } from '../../engine/math.ts';
import { BrushWorld } from '../../engine/collision/brush.ts';
import type { BoxDef } from '../../engine/collision/brush.ts';
import type { CollisionWorld, Hull, TraceResult } from '../../engine/collision/types.ts';
import type { MapInteractions, MapOccupant } from './interactions.ts';

/** 功能：各气闸采用双扇侧滑，预留门框墙内行程；时间：2026-11-17；作者：lq。 */
export const MOONBASE_AIRLOCKS = [
  { center: v3(-712, 0, 80), axis: 'y', width: 288, depth: 16 },
  { center: v3(-1056, -408, 80), axis: 'x', width: 192, depth: 16 },
  { center: v3(-1056, 408, 80), axis: 'x', width: 192, depth: 16 },
] as const;

/** 功能：两座对向弹射平台把玩家送上中央观测桥，基础路线仍可走楼梯；时间：2026-11-17；作者：lq。 */
export const MOONBASE_LAUNCH_PADS = [
  { center: v3(-256, -352, 8), impulse: v3(0, 220, 360) },
  { center: v3(256, 352, 8), impulse: v3(0, -220, 360) },
] as const;

/** 功能：返回当前侧滑门扇的真实 AABB，显示和碰撞由同一个进度计算；时间：2026-11-17；作者：lq。 */
export function moonbaseDoorPanels(index: number, progress: number): BoxDef[] {
  const door = MOONBASE_AIRLOCKS[index]!;
  return [-1, 1].map((side) => {
    const offset = side * (door.width / 4 + progress * (door.width / 2 + 4));
    const x = door.center.x + (door.axis === 'x' ? offset : 0);
    const y = door.center.y + (door.axis === 'y' ? offset : 0);
    // 功能：双扇门中缝重叠一单位，避免点射线恰好沿碰撞边界穿透关闭的气闸；时间：2026-11-17；作者：lq。
    const halfX = door.axis === 'x' ? door.width / 4 + 0.5 : door.depth / 2;
    const halfY = door.axis === 'y' ? door.width / 4 + 0.5 : door.depth / 2;
    return { mins: v3(x - halfX, y - halfY, 0), maxs: v3(x + halfX, y + halfY, 160), material: 'luna_shell', solid: true };
  });
}

/** 功能：气闸可近距离感应或按 E 手动保持开门，手动关门后延迟感应，平台启动八秒；时间：2026-11-17；作者：lq。 */
export class MoonbaseWorld implements CollisionWorld, MapInteractions {
  private readonly base: BrushWorld;
  private doors: { progress: number; holdOpen: boolean; sensorDelay: number; wait: number }[];
  private readonly padTime = MOONBASE_LAUNCH_PADS.map(() => 0);
  private useCooldown = 0;
  private dynamic: BrushWorld;
  readonly gravityAt: (origin: Vec3) => number;

  /** 功能：初始全开供导航扫描，回合 reset 时再关门，BOT 路线始终包含合法气闸通道；时间：2026-11-17；作者：lq。 */
  constructor(boxes: BoxDef[], gravityAt: (origin: Vec3) => number) {
    this.base = BrushWorld.fromBoxes(boxes);
    this.gravityAt = gravityAt;
    this.doors = MOONBASE_AIRLOCKS.map(() => ({ progress: 1, holdOpen: false, sensorDelay: 0, wait: 0 }));
    this.dynamic = this.doorWorld();
  }

  /** 功能：动态门扇单独构建碰撞，静态地形不随门动画重建；时间：2026-11-17；作者：lq。 */
  private doorWorld(): BrushWorld {
    return BrushWorld.fromBoxes(this.doors.flatMap((door, index) => moonbaseDoorPanels(index, door.progress)));
  }

  /** 功能：角色、子弹与手雷共用动态门的最早命中结果；时间：2026-11-17；作者：lq。 */
  traceHull(hull: Hull, start: Vec3, end: Vec3): TraceResult {
    const base = this.base.traceHull(hull, start, end);
    const door = this.dynamic.traceHull(hull, start, end);
    const result = door.fraction < base.fraction ? door : base;
    return { ...result, startsolid: base.startsolid || door.startsolid, allsolid: base.allsolid || door.allsolid };
  }

  /** 功能：动态门参与点内容，确保导航、手雷和子弹看到相同实体状态；时间：2026-11-17；作者：lq。 */
  pointContents(point: Vec3): number {
    return this.dynamic.pointContents(point) === -2 ? -2 : this.base.pointContents(point);
  }

  /** 功能：八秒启动期间，仅踏上平台的角色取得冲量；每人冷却由移动状态维护；时间：2026-11-17；作者：lq。 */
  launchAt(point: Vec3): Vec3 | null {
    const index = MOONBASE_LAUNCH_PADS.findIndex(({ center }) => Math.abs(point.x - center.x) < 60
      && Math.abs(point.y - center.y) < 60 && point.z > center.z && point.z < center.z + 64);
    return index >= 0 && this.padTime[index]! > 0 ? { ...MOONBASE_LAUNCH_PADS[index]!.impulse } : null;
  }

  /** 功能：E 操作需朝向 128 单位内可见目标；同次长按只切换一次，松键可再次切换；时间：2026-11-17；作者：lq。 */
  use(eye: Vec3, direction: Vec3): boolean {
    if (this.useCooldown > 0) { this.useCooldown = 0.15; return false; }
    const targets = [
      ...MOONBASE_AIRLOCKS.map(({ center }, index) => ({ center, kind: 'door', index })),
      ...MOONBASE_LAUNCH_PADS.map(({ center }, index) => ({ center, kind: 'pad', index })),
    ];
    const target = targets.map((target) => {
      const delta = v3(target.center.x - eye.x, target.center.y - eye.y, target.center.z - eye.z);
      const distance = Math.hypot(delta.x, delta.y, delta.z);
      const facing = (delta.x * direction.x + delta.y * direction.y + delta.z * direction.z) / Math.max(distance, 1);
      return { ...target, distance, facing };
    }).filter(({ center, distance, facing, kind }) => distance <= 128 && facing > (kind === 'pad' ? 0.35 : 0.25)
      && this.base.traceHull({ mins: v3(), maxs: v3() }, eye, center).fraction > 0.98)
      .sort((a, b) => a.distance - b.distance)[0];
    if (!target) return false;
    this.useCooldown = 0.15;
    if (target.kind === 'pad') this.padTime[target.index] = this.padTime[target.index]! > 0 ? 0 : 8;
    else {
      const door = this.doors[target.index]!;
      const close = door.holdOpen || door.progress > 0.5;
      door.holdOpen = !close;
      door.wait = 0;
      door.sensorDelay = close ? 2 : 0;
    }
    return true;
  }

  /** 功能：开关门碰撞先试算，检测到占用则重新打开，避免夹人或把角色推入实体墙；时间：2026-11-17；作者：lq。 */
  update(dt: number, occupants: MapOccupant[]): void {
    this.useCooldown = Math.max(0, this.useCooldown - dt);
    for (let index = 0; index < this.padTime.length; index++) this.padTime[index] = Math.max(0, this.padTime[index]! - dt);
    let changed = false;
    this.doors.forEach((door, index) => {
      door.sensorDelay = Math.max(0, door.sensorDelay - dt);
      const center = MOONBASE_AIRLOCKS[index]!.center;
      const nearby = occupants.some(({ origin }) => Math.hypot(origin.x - center.x, origin.y - center.y) < 172 && origin.z < 180);
      if (nearby && door.sensorDelay <= 0) door.wait = 1.8;
      else door.wait = Math.max(0, door.wait - dt);
      const opening = door.holdOpen || door.wait > 0;
      const next = Math.max(0, Math.min(1, door.progress + (opening ? 1 : -1) * dt * 1.8));
      if (next === door.progress) return;
      const candidate = BrushWorld.fromBoxes(moonbaseDoorPanels(index, next));
      if (!opening && occupants.some(({ origin, hull }) => candidate.traceHull(hull, origin, origin).startsolid)) {
        door.wait = 1.8; return;
      }
      door.progress = next; changed = true;
    });
    if (changed) this.dynamic = this.doorWorld();
  }

  /** 功能：门快照预留 100 起始编号保存弹射平台剩余时间，复用现有地图状态同步接口；时间：2026-11-17；作者：lq。 */
  snapshotDoors(): { index: number; progress: number }[] {
    return [...this.doors.map(({ progress }, index) => ({ index, progress })),
      ...this.padTime.map((time, index) => ({ index: 100 + index, progress: time / 8 }))];
  }

  /** 功能：客户端按房主进度重建门碰撞和平台启动状态，不在客户端猜测气闸感应；时间：2026-11-17；作者：lq。 */
  applyDoors(states: { index: number; progress: number }[]): void {
    for (const { index, progress } of states) {
      const value = Math.max(0, Math.min(1, progress));
      if (this.doors[index]) this.doors[index]!.progress = value;
      else if (index >= 100 && index < 100 + this.padTime.length) this.padTime[index - 100] = value * 8;
    }
    this.dynamic = this.doorWorld();
  }

  /** 功能：每回合关闭气闸并禁用所有弹射平台，清除手动保持和输入冷却；时间：2026-11-17；作者：lq。 */
  reset(): void {
    this.doors = this.doors.map(() => ({ progress: 0, holdOpen: false, sensorDelay: 0, wait: 0 }));
    this.padTime.fill(0); this.useCooldown = 0;
    this.dynamic = this.doorWorld();
  }
}
