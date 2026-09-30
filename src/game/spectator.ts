/**
 * 功能：为阵亡后的第三人称观战生成带墙体避让的跟随镜头。
 * 时间：2026-09-29；作者：lq。
 */
import type { Vec3 } from '../engine/math.ts';
import { v3 } from '../engine/math.ts';
import type { CollisionWorld } from '../engine/collision/types.ts';
import type { Actor } from './actors.ts';
import { aimDirection, POINT_HULL } from './combat.ts';

export interface SpectatorCameraPose { origin: Vec3; pitch: number; yaw: number }

/** 功能：把镜头放在队友后上方，墙体阻挡时沿视线前移，并始终朝向队友前方。时间：2026-09-29；作者：lq。 */
export function spectatorCameraPose(actor: Actor, world: CollisionWorld): SpectatorCameraPose {
  const forward = aimDirection(0, actor.yaw);
  const anchor = v3(actor.move.origin.x, actor.move.origin.y, actor.move.origin.z + 37);
  const desired = v3(anchor.x - forward.x * 112, anchor.y - forward.y * 112, anchor.z + 31);
  const trace = world.traceHull(POINT_HULL, anchor, desired);
  const hit = trace.endpos;
  const towardActor = v3(anchor.x - hit.x, anchor.y - hit.y, anchor.z - hit.z);
  const hitDistance = Math.hypot(towardActor.x, towardActor.y, towardActor.z);
  const clearance = trace.fraction < 1 && hitDistance > 0 ? Math.min(1, 6 / hitDistance) : 0;
  const origin = v3(hit.x + towardActor.x * clearance, hit.y + towardActor.y * clearance, hit.z + towardActor.z * clearance);
  const focus = v3(actor.move.origin.x + forward.x * 26, actor.move.origin.y + forward.y * 26, actor.move.origin.z + 22);
  const dx = focus.x - origin.x;
  const dy = focus.y - origin.y;
  const horizontal = Math.hypot(dx, dy);
  return {
    origin,
    pitch: Math.atan2(origin.z - focus.z, Math.max(horizontal, 1)) * 180 / Math.PI,
    yaw: Math.atan2(dy, dx) * 180 / Math.PI,
  };
}
