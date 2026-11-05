/** 功能：依据 ReGameDLL_CS wpn_shared 与 weapons.cpp 恢复按姿态变化的 KickBack；该参考基于后期 CS。时间：2026-11-05；作者：lq。 */
import type { PunchAngle, WeaponId } from './weapons.ts';

export interface RecoilMotion { speed: number; onGround: boolean; ducked: boolean }
/** 功能：横向方向由武器保存，并按原版概率翻转。时间：2026-11-05；作者：lq。 */
export interface RecoilDirection { right: boolean }
type Kick = readonly [number, number, number, number, number, number, number];
const profiles: Partial<Record<WeaponId, { airFirst: boolean; kicks: readonly Kick[] }>> = {
  ak47: { airFirst: false, kicks: [
    [1.5, 0.45, 0.225, 0.05, 6.5, 2.5, 7],
    [2.0, 1.0, 0.5, 0.35, 9.0, 6.0, 5],
    [0.9, 0.35, 0.15, 0.025, 5.5, 1.5, 9],
    [1.0, 0.375, 0.175, 0.0375, 5.75, 1.75, 8],
  ] },
  m4a1: { airFirst: false, kicks: [
    [1.0, 0.45, 0.28, 0.045, 3.75, 3.0, 7],
    [1.2, 0.5, 0.23, 0.15, 5.5, 3.5, 6],
    [0.6, 0.3, 0.2, 0.0125, 3.25, 2.0, 7],
    [0.65, 0.35, 0.25, 0.015, 3.5, 2.25, 7],
  ] },
  mp5navy: { airFirst: true, kicks: [
    [0.9, 0.475, 0.35, 0.0425, 5.0, 3.0, 6],
    [0.5, 0.275, 0.2, 0.03, 3.0, 2.0, 10],
    [0.225, 0.15, 0.1, 0.015, 2.0, 1.0, 10],
    [0.25, 0.175, 0.125, 0.02, 2.25, 1.25, 10],
  ] },
  mac10: { airFirst: true, kicks: [
    [1.3, 0.55, 0.4, 0.05, 4.75, 3.75, 5],
    [0.9, 0.45, 0.25, 0.035, 3.5, 2.75, 7],
    [0.75, 0.4, 0.175, 0.03, 2.75, 2.5, 10],
    [0.775, 0.425, 0.2, 0.03, 3.0, 2.75, 9],
  ] },
  tmp: { airFirst: true, kicks: [
    [1.1, 0.5, 0.35, 0.045, 4.5, 3.5, 6],
    [0.8, 0.4, 0.2, 0.03, 3.0, 2.5, 7],
    [0.7, 0.35, 0.125, 0.025, 2.5, 2.0, 10],
    [0.725, 0.375, 0.15, 0.025, 2.75, 2.25, 9],
  ] },
  ump45: { airFirst: true, kicks: [
    [0.125, 0.65, 0.55, 0.0475, 5.5, 4.0, 10],
    [0.55, 0.3, 0.225, 0.03, 3.5, 2.5, 10],
    [0.25, 0.175, 0.125, 0.02, 2.25, 1.25, 10],
    [0.275, 0.2, 0.15, 0.0225, 2.5, 1.5, 10],
  ] },
  p90: { airFirst: true, kicks: [
    [0.9, 0.45, 0.35, 0.04, 5.25, 3.5, 4],
    [0.45, 0.3, 0.2, 0.0275, 4.0, 2.25, 7],
    [0.275, 0.2, 0.125, 0.02, 3.0, 1.0, 9],
    [0.3, 0.225, 0.125, 0.02, 3.25, 1.25, 8],
  ] },
  aug: { airFirst: false, kicks: [
    [1.0, 0.45, 0.275, 0.05, 4.0, 2.5, 7],
    [1.25, 0.45, 0.22, 0.18, 5.5, 4.0, 5],
    [0.575, 0.325, 0.2, 0.011, 3.25, 2.0, 8],
    [0.625, 0.375, 0.25, 0.0125, 3.5, 2.25, 8],
  ] },
  sg552: { airFirst: false, kicks: [
    [1.0, 0.45, 0.28, 0.04, 4.25, 2.5, 7],
    [1.25, 0.45, 0.22, 0.18, 6.0, 4.0, 5],
    [0.6, 0.35, 0.2, 0.0125, 3.7, 2.0, 10],
    [0.625, 0.375, 0.25, 0.0125, 4.0, 2.25, 9],
  ] },
  m249: { airFirst: true, kicks: [
    [1.8, 0.65, 0.45, 0.125, 5.0, 3.5, 8],
    [1.1, 0.5, 0.3, 0.06, 4.0, 3.0, 8],
    [0.75, 0.325, 0.25, 0.025, 3.5, 2.5, 9],
    [0.8, 0.35, 0.3, 0.03, 3.75, 3.0, 9],
  ] },
};

/** 功能：使用姿态参数、连发增长和随机方向替代固定喷射路线，手枪/霰弹枪保留独立冲量。时间：2026-11-05；作者：lq。 */
export function classicRecoil(punch: PunchAngle, id: WeaponId, shot: number, motion: RecoilMotion,
  random: () => number, direction: RecoilDirection): PunchAngle {
  const profile = profiles[id];
  if (profile) {
    const first = profile.airFirst ? !motion.onGround : motion.speed > 0;
    const second = profile.airFirst ? motion.speed > 0 : !motion.onGround;
    const k = profile.kicks[first ? 0 : second ? 1 : motion.ducked ? 2 : 3]!;
    const count = shot + 1;
    const up = k[0] + (count > 1 ? count * k[2] : 0);
    const side = k[1] + (count > 1 ? count * k[3] : 0);
    const result = { pitch: Math.max(-k[4], punch.pitch - up),
      yaw: Math.max(-k[5], Math.min(k[5], punch.yaw + (direction.right ? side : -side))) };
    if (Math.floor(random() * (k[6] + 1)) === 0) direction.right = !direction.right;
    return result;
  }
  if (id === 'm3' || id === 'xm1014') {
    const low = id === 'm3' ? (motion.onGround ? 4 : 8) : (motion.onGround ? 3 : 7);
    const range = motion.onGround ? 3 : 4;
    return { pitch: punch.pitch - low - Math.floor(random() * range), yaw: punch.yaw };
  }
  if (id === 'g3sg1' || id === 'sg550') {
    const kick = id === 'g3sg1' ? 0.75 + random() : 0.75 + random() * 0.5;
    return { pitch: punch.pitch * 0.75 - kick, yaw: punch.yaw + random() * 1.5 - 0.75 };
  }
  if (id === 'knife' || id === 'glock18' || id.endsWith('grenade') || id === 'flashbang') return { ...punch };
  return { pitch: punch.pitch - 2, yaw: punch.yaw };
}
