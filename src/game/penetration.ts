/** 功能：共享枪械穿墙弹道，按枪械、材质、实际厚度和穿透次数衰减，供单机与联机房主共用；时间：2026-11-17；作者：lq。 */
import { copy, v3 } from '../engine/math.ts';
import type { Vec3 } from '../engine/math.ts';
import { CONTENTS_SOLID } from '../engine/collision/types.ts';
import type { CollisionWorld } from '../engine/collision/types.ts';
import type { WeaponDef } from './weapons.ts';

/** 功能：只记录空气中的有效弹道段，防止墙体内部人物被错误命中；时间：2026-11-17；作者：lq。 */
export interface BulletSegment {
  start: Vec3;
  end: Vec3;
  startDistance: number;
  damageScale: number;
  hit: boolean;
  normal: Vec3;
}

/** 功能：区分步枪、狙击枪和沙鹰的穿透强度；普通手枪、冲锋枪、霰弹枪和刀不穿实体墙；时间：2026-11-17；作者：lq。 */
function penetrationProfile(weapon: WeaponDef): { power: number; count: number; distance: number } {
  switch (weapon.id) {
    case 'awp': return { power: 45, count: 3, distance: 8000 };
    case 'scout': case 'g3sg1': return { power: 39, count: 2, distance: 5000 };
    case 'ak47': return { power: 39, count: 2, distance: 5000 };
    case 'm4a1': case 'aug': case 'sg552': case 'sg550': case 'm249':
      return { power: 35, count: 2, distance: 4000 };
    case 'deagle': return { power: 30, count: 1, distance: 3000 };
    default: return { power: 0, count: 0, distance: 0 };
  }
}

/** 功能：厚普通墙和木门可穿；铁箱、金属掩体、天空及专用阻弹材质挡弹，原创地图贴图采用相同规则；时间：2026-11-17；作者：lq。 */
function materialResistance(name = ''): { depth: number; retained: number } {
  const material = name.toLowerCase();
  if (/metal|steel|iron|mtl|crate.*(?:metal|steel)|duct|grate|computer|comp\d|luna_(?:metal|floor|console|duct)|sky|clip|nodraw|reinforced/.test(material)) {
    return { depth: 0, retained: 0 };
  }
  if (/wood|door|crate|crte|timber/.test(material)) return { depth: 3.5, retained: 0.65 };
  if (/glass|window/.test(material)) return { depth: 4, retained: 0.8 };
  if (/rock|stone|luna_dust/.test(material)) return { depth: 1.5, retained: 0.4 };
  return { depth: 2.5, retained: 0.5 };
}

/** 功能：沿射线逐半单位寻找实体出口并细化边界；无出口或超过厚度/射程时停止，不能跳过后方独立墙面；时间：2026-11-17；作者：lq。 */
function findExit(world: CollisionWorld, entry: Vec3, direction: Vec3, limit: number): { point: Vec3; depth: number; material?: string } | null {
  const at = (distance: number): Vec3 => v3(entry.x + direction.x * distance,
    entry.y + direction.y * distance, entry.z + direction.z * distance);
  let solidDistance = 0;
  for (let distance = Math.min(0.0625, limit); distance <= limit; distance = Math.min(distance + 0.5, limit)) {
    if (world.pointContents(at(distance)) !== CONTENTS_SOLID) {
      let low = solidDistance, high = distance;
      for (let i = 0; i < 10; i++) {
        const middle = (low + high) / 2;
        if (world.pointContents(at(middle)) === CONTENTS_SOLID) low = middle;
        else high = middle;
      }
      // 功能：反向检查出口材质，防止木墙紧贴铁箱时把连续实体整体当木材穿透；时间：2026-11-17；作者：lq。
      const reverse = world.traceHull({ mins: v3(), maxs: v3() }, at(distance), entry);
      return { point: at(high), depth: high,
        material: reverse.material ?? world.surfaceMaterial?.(reverse.endpos, reverse.normal) };
    }
    solidDistance = distance;
    if (distance === limit) break;
  }
  return null;
}

/** 功能：首段保留原命中面，其后各段独立判定人物和伤害；限制穿透次数和累计射程以避免无限穿墙；时间：2026-11-17；作者：lq。 */
export function traceBullet(world: CollisionWorld, weapon: WeaponDef, start: Vec3, end: Vec3): BulletSegment[] {
  const range = Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z);
  const direction = v3((end.x - start.x) / (range || 1), (end.y - start.y) / (range || 1), (end.z - start.z) / (range || 1));
  const profile = penetrationProfile(weapon);
  const pointHull = { mins: v3(), maxs: v3() };
  const segments: BulletSegment[] = [];
  let from = copy(start), startDistance = 0, damageScale = 1;
  for (let penetrations = 0; penetrations <= profile.count; penetrations++) {
    const trace = world.traceHull(pointHull, from, end);
    const hit = trace.fraction < 1 || trace.startsolid || trace.allsolid;
    segments.push({ start: copy(from), end: copy(trace.endpos), startDistance, damageScale, hit, normal: copy(trace.normal) });
    const distance = startDistance + Math.hypot(trace.endpos.x - from.x, trace.endpos.y - from.y, trace.endpos.z - from.z);
    if (!hit || trace.startsolid || trace.allsolid || penetrations === profile.count || distance > profile.distance) break;
    const material = materialResistance(trace.material ?? world.surfaceMaterial?.(trace.endpos, trace.normal));
    const depthLimit = Math.min(profile.power * material.depth, range - distance);
    if (depthLimit <= 0) break;
    const exit = findExit(world, trace.endpos, direction, depthLimit);
    if (!exit) break;
    // 功能：进出口采用更坚硬的一侧，连续实体的总厚度同样受限制；时间：2026-11-17；作者：lq。
    const exitMaterial = materialResistance(exit.material);
    const effectiveLimit = Math.min(depthLimit, profile.power * exitMaterial.depth);
    if (exit.depth > effectiveLimit) break;
    damageScale *= Math.min(material.retained, exitMaterial.retained) * Math.pow(0.75, exit.depth / effectiveLimit);
    startDistance = distance + exit.depth;
    if (startDistance >= range || weapon.damage * damageScale < 1) break;
    from = exit.point;
  }
  return segments;
}
