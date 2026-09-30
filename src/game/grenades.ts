/** 功能：复用 CS / GoldSrc 手雷投掷角度、速度和半重力参数。时间：2026-09-30；作者：lq。 */
import type { Vec3 } from '../engine/math.ts';
import { v3 } from '../engine/math.ts';
import { aimDirection } from './combat.ts';

/** 功能：原版手雷 gravity=0.5、friction=0.8，高爆与闪光引信为 1.5 秒。时间：2026-09-30；作者：lq。 */
export const GRENADE_GRAVITY = 400;
export const GRENADE_FRICTION = 0.8;
export const GRENADE_FUSE = 1.5;

/** 功能：CS 1.5 高爆手雷以 100 基础伤害在 350 单位内线性衰减。时间：2026-09-30；作者：lq。 */
export function heDamage(distance: number): number {
  return Math.max(0, 100 * (1 - distance / 350));
}

/** 功能：按原版非线性俯仰修正计算初速度，完整继承跑动和跳跃速度。时间：2026-09-30；作者：lq。 */
export function grenadeLaunch(eye: Vec3, pitch: number, yaw: number, playerVelocity: Vec3): { position: Vec3; velocity: Vec3 } {
  const throwPitch = -10 + pitch * (pitch < 0 ? 80 : 100) / 90;
  const speed = Math.min(750, (90 - throwPitch) * 6);
  const direction = aimDirection(throwPitch, yaw);
  return {
    position: v3(eye.x + direction.x * 16, eye.y + direction.y * 16, eye.z + direction.z * 16),
    velocity: v3(
      direction.x * speed + playerVelocity.x,
      direction.y * speed + playerVelocity.y,
      direction.z * speed + playerVelocity.z,
    ),
  };
}
