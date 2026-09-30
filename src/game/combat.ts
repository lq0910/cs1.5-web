/**
 * Weapon runtime: firing, reloading, switching, recoil, spread and hitscan.
 *
 * The simulation time is passed in (seconds), so the whole system is
 * deterministic and unit-testable without a browser or a clock.
 *
 * Hitscan goes through the CollisionWorld interface with a *point* hull, which
 * for the BSP backend means hull 0 — the world's node tree, i.e. the exact
 * geometry a GoldSrc bullet trace uses.
 */

import type { Vec3 } from '../engine/math.ts';
import { copy, v3 } from '../engine/math.ts';
import type { CollisionWorld, Hull } from '../engine/collision/types.ts';
import type { WeaponDef, WeaponId, WeaponSlot } from './weapons.ts';
import {
  WEAPONS,
  accuracyCone,
  applyRecoil,
  decayPunch,
  reloadDuration,
  spreadOffset,
} from './weapons.ts';
import type { PunchAngle } from './weapons.ts';
import { IN_ATTACK, IN_ATTACK2, IN_RELOAD } from './constants.ts';

/** GoldSrc bullets are traced with a point hull. */
export const POINT_HULL: Hull = { mins: v3(0, 0, 0), maxs: v3(0, 0, 0) };

export interface WeaponRuntime {
  id: WeaponId;
  ammo: number;
  reserve: number;
  /** Sim time (s) at which this weapon may fire again. */
  nextFireTime: number;
  /** Sim time (s) at which the current reload completes (0 = not reloading). */
  reloadEndTime: number;
  /** Sim time (s) at which the deploy animation completes. */
  deployEndTime: number;
  /** Index into the weapon's spray pattern. */
  shotIndex: number;
  lastFireTime: number;
  scoped: boolean;
  /** 功能：AWP 原版三态开镜等级，0 为腰射、1 为一档、2 为二档。时间：2026-09-30；作者：lq。 */
  zoomLevel: 0 | 1 | 2;
}

export interface ShooterState {
  eye: Vec3;
  pitch: number;
  yaw: number;
  speed: number;
  onGround: boolean;
  ducked: boolean;
}

export interface ShotEvent {
  weapon: WeaponId;
  /** 功能：标识刀的右键重刺，供第一人称播放 stab 而不是 slash 动作。时间：2026-09-29；作者：lq。 */
  alternate: boolean;
  start: Vec3;
  end: Vec3;
  hit: boolean;
  normal: Vec3;
  distance: number;
  coneDeg: number;
  damage: number;
}

export interface CombatEvents {
  shots: ShotEvent[];
  dryFire: boolean;
  reloadStarted: WeaponId | null;
  reloadFinished: WeaponId | null;
  deployFinished: WeaponId | null;
  switchedTo: WeaponId | null;
  /** Punch after this tick (the camera adds it to the view angles). */
  punch: PunchAngle;
}

function emptyEvents(punch: PunchAngle): CombatEvents {
  return {
    shots: [],
    dryFire: false,
    reloadStarted: null,
    reloadFinished: null,
    deployFinished: null,
    switchedTo: null,
    punch,
  };
}

/** Deterministic RNG so tests can pin the spread behaviour. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const RESERVE_AMMO: Partial<Record<WeaponId, number>> = {
  ak47: 90,
  m4a1: 90,
  awp: 30,
  mp5navy: 120,
  deagle: 35,
  usp45: 100,
  glock18: 120,
};

export function makeWeaponRuntime(id: WeaponId): WeaponRuntime {
  const def = WEAPONS[id];
  return {
    id,
    ammo: Number.isFinite(def.magSize) ? def.magSize : 1,
    reserve: RESERVE_AMMO[id] ?? (Number.isFinite(def.magSize) ? Math.max(def.magSize * 3, 30) : 0),
    nextFireTime: 0,
    reloadEndTime: 0,
    deployEndTime: 0,
    shotIndex: 0,
    lastFireTime: -99,
    scoped: false,
    zoomLevel: 0,
  };
}

/** Direction vector from GoldSrc view angles (pitch positive = down). */
export function aimDirection(pitchDeg: number, yawDeg: number): Vec3 {
  const pitch = (pitchDeg * Math.PI) / 180;
  const yaw = (yawDeg * Math.PI) / 180;
  const cp = Math.cos(pitch);
  return v3(cp * Math.cos(yaw), cp * Math.sin(yaw), -Math.sin(pitch));
}

// ------------------------------------------------------------------ damage

export type HitGroup = 'head' | 'chest' | 'stomach' | 'leg';

/** CS damage falloff: damage * rangeModifier ^ (distance / 500), times hitgroup. */
export function damageAtDistance(
  weapon: WeaponDef,
  distance: number,
  hitgroup: HitGroup = 'chest',
): number {
  const falloff = Math.pow(weapon.rangeModifier, distance / 500);
  return weapon.damage * falloff * weapon.hitgroups[hitgroup];
}

/**
 * CS armor formula: armor absorbs part of the damage and is itself consumed.
 * When there is not enough armor left the remainder goes straight through.
 */
export function applyArmor(
  damage: number,
  armorRatio: number,
  armor: number,
): { damage: number; armor: number } {
  if (armor <= 0) return { damage, armor: 0 };

  // 功能：按 GoldSrc TakeDamage 的 ARMOR_BONUS=0.5 公式折算护甲；护甲不足时，剩余伤害只扣除实际剩余护甲。时间：2026-09-30；作者：lq。
  let remaining = damage * armorRatio;
  const armorCost = (damage - remaining) * 0.5;

  if (armorCost > armor) {
    remaining = damage - armor;
    armor = 0;
  } else {
    armor -= armorCost;
  }

  return { damage: Math.max(0, remaining), armor: Math.max(0, armor) };
}

// ------------------------------------------------------------------ combat

export class CombatSystem {
  readonly loadout: Record<WeaponSlot, WeaponRuntime>;
  private slot: WeaponSlot = 1;
  private punch: PunchAngle = { pitch: 0, yaw: 0 };
  private attackHeld = false;
  private altHeld = false;
  private readonly random: () => number;

  constructor(loadout: Record<WeaponSlot, WeaponId>, seed = 0x5eed) {
    this.loadout = {
      1: makeWeaponRuntime(loadout[1]),
      2: makeWeaponRuntime(loadout[2]),
      3: makeWeaponRuntime(loadout[3]),
    };
    this.random = mulberry32(seed);
  }

  get activeSlot(): WeaponSlot {
    return this.slot;
  }

  current(): WeaponRuntime {
    return this.loadout[this.slot];
  }

  get definition(): WeaponDef {
    return WEAPONS[this.current().id];
  }

  get punchAngle(): PunchAngle {
    return { ...this.punch };
  }

  /** Cone half-angle the next shot would use — drives the dynamic crosshair. */
  currentCone(shooter: ShooterState, now: number): number {
    const weapon = this.definition;
    const runtime = this.current();
    return accuracyCone(weapon, {
      speed: shooter.speed,
      onGround: shooter.onGround,
      ducked: shooter.ducked,
      scoped: runtime.scoped,
      timeSinceLastShot: now - runtime.lastFireTime,
    });
  }

  selectSlot(slot: WeaponSlot, now: number): CombatEvents | null {
    if (slot === this.slot) return null;
    const events = emptyEvents(this.punch);
    this.slot = slot;
    const runtime = this.current();
    runtime.deployEndTime = now + WEAPONS[runtime.id].deployTime;
    runtime.reloadEndTime = 0;
    runtime.scoped = false;
    runtime.zoomLevel = 0;
    runtime.shotIndex = 0;
    events.switchedTo = runtime.id;
    return events;
  }

  /** Reloads the active weapon if it makes sense. Returns true when started. */
  startReload(now: number): boolean {
    const runtime = this.current();
    const weapon = WEAPONS[runtime.id];
    if (!Number.isFinite(weapon.magSize)) return false;
    if (runtime.reloadEndTime > 0) return false;
    if (runtime.ammo >= weapon.magSize) return false;
    if (runtime.reserve <= 0) return false;
    // 功能：采用统一的加快换弹时长，使实弹补入与视图动作同刻结束。时间：2026-09-29；作者：lq。
    runtime.reloadEndTime = now + reloadDuration(runtime.id);
    runtime.scoped = false;
    runtime.zoomLevel = 0;
    return true;
  }

  tick(
    shooter: ShooterState,
    world: CollisionWorld,
    buttons: number,
    now: number,
    dt: number,
  ): CombatEvents {
    const events = emptyEvents(this.punch);
    const weapon = this.definition;
    const runtime = this.current();

    // Punch always recovers, even mid-reload.
    this.punch = decayPunch(this.punch, weapon, dt);

    // ---- deploy / reload timers
    if (runtime.deployEndTime > 0 && now >= runtime.deployEndTime) {
      runtime.deployEndTime = 0;
      events.deployFinished = runtime.id;
    }
    if (runtime.reloadEndTime > 0 && now >= runtime.reloadEndTime) {
      const needed = weapon.magSize - runtime.ammo;
      const taken = Math.min(needed, runtime.reserve);
      runtime.ammo += taken;
      runtime.reserve -= taken;
      runtime.reloadEndTime = 0;
      runtime.shotIndex = 0;
      events.reloadFinished = runtime.id;
    }

    const deploying = runtime.deployEndTime > 0;
    const reloading = runtime.reloadEndTime > 0;

    // ---- scope / secondary fire
    const altPressed = (buttons & IN_ATTACK2) !== 0;
    if (altPressed && !this.altHeld && !deploying && !reloading) {
      if (weapon.canScope) {
        // 功能：右键按下按 0→一档→二档→退出循环，使用 CS 1.5 AWP 的 40°/10° 两段视野。时间：2026-09-30；作者：lq。
        runtime.zoomLevel = ((runtime.zoomLevel + 1) % 3) as 0 | 1 | 2;
        runtime.scoped = runtime.zoomLevel > 0;
      } else if (weapon.sounds.altFire) {
        // Knife stab: a slower, much harder hit.
        this.fire(shooter, world, now, events, true);
      }
    }
    this.altHeld = altPressed;

    // ---- reload request
    if ((buttons & IN_RELOAD) !== 0 && !reloading && !deploying) {
      if (this.startReload(now)) events.reloadStarted = runtime.id;
    }

    // 功能：弹匣已经打空且还有备弹时自动开始换弹；空备弹时保留空仓提示。时间：2026-09-29；作者：lq。
    if (!deploying && runtime.reloadEndTime === 0 && runtime.ammo === 0 && runtime.reserve > 0) {
      if (this.startReload(now)) events.reloadStarted = runtime.id;
    }

    // ---- primary fire
    const attackPressed = (buttons & IN_ATTACK) !== 0;
    const wantsFire = weapon.automatic ? attackPressed : attackPressed && !this.attackHeld;

    if (wantsFire && !deploying && runtime.reloadEndTime === 0) {
      if (runtime.ammo <= 0) {
        events.dryFire = true;
        runtime.nextFireTime = Math.max(runtime.nextFireTime, now + 0.25);
      } else {
        this.fire(shooter, world, now, events, false);
      }
    }
    // 功能：最后一发打出后立即启动自动换弹，不必再扣扳机或按 R。时间：2026-09-29；作者：lq。
    if (!deploying && runtime.reloadEndTime === 0 && runtime.ammo === 0 && runtime.reserve > 0) {
      if (this.startReload(now)) events.reloadStarted = runtime.id;
    }
    this.attackHeld = attackPressed;

    events.punch = { ...this.punch };
    return events;
  }

  private fire(
    shooter: ShooterState,
    world: CollisionWorld,
    now: number,
    events: CombatEvents,
    alternate: boolean,
  ): void {
    const runtime = this.current();
    const weapon = this.definition;

    if (now < runtime.nextFireTime) return;

    const cycle = alternate && weapon.kind === 'knife' ? weapon.cycleTime * 2.5 : weapon.cycleTime;
    runtime.nextFireTime = now + cycle;

    if (Number.isFinite(weapon.magSize)) {
      if (runtime.ammo <= 0) return;
      runtime.ammo -= 1;
    }

    // 功能：先以本发之前的 punch 计算弹道；原版 FireBullets3 在 KickBack 之前执行，避免 AWP 首发偏离准星。时间：2026-09-30；作者：lq。
    runtime.shotIndex = now - runtime.lastFireTime > weapon.cycleTime * 3 ? 0 : runtime.shotIndex;
    const shotPunch = { ...this.punch };

    const cone = accuracyCone(weapon, {
      speed: shooter.speed,
      onGround: shooter.onGround,
      ducked: shooter.ducked,
      scoped: runtime.scoped,
      timeSinceLastShot: now - runtime.lastFireTime,
    });
    const spread = spreadOffset(cone, this.random);

    const pitch = shooter.pitch + shotPunch.pitch + spread.pitch;
    const yaw = shooter.yaw + shotPunch.yaw + spread.yaw;
    const direction = aimDirection(pitch, yaw);

    const range = alternate && weapon.kind === 'knife' ? 48 : weapon.range;
    const end = v3(
      shooter.eye.x + direction.x * range,
      shooter.eye.y + direction.y * range,
      shooter.eye.z + direction.z * range,
    );

    const trace = world.traceHull(POINT_HULL, shooter.eye, end);
    const hit = trace.fraction < 1;
    const hitPoint = copy(trace.endpos);
    const distance = Math.hypot(
      hitPoint.x - shooter.eye.x,
      hitPoint.y - shooter.eye.y,
      hitPoint.z - shooter.eye.z,
    );

    const baseDamage = alternate && weapon.kind === 'knife' ? 65 : weapon.damage;

    events.shots.push({
      weapon: weapon.id,
      alternate,
      start: copy(shooter.eye),
      end: hitPoint,
      hit,
      normal: copy(trace.normal),
      distance,
      coneDeg: cone,
      damage: baseDamage * Math.pow(weapon.rangeModifier, distance / 500),
    });

    runtime.lastFireTime = now;
    runtime.shotIndex++;

    // 功能：在子弹完成命中检测后施加本发枪口后坐力，保持原版“当前子弹不受自身后坐力影响、下一发受到影响”的时序。时间：2026-09-30；作者：lq。
    this.punch = applyRecoil(this.punch, weapon, runtime.shotIndex - 1);

    // A scoped sniper drops out of the scope for the bolt cycle, which is
    // already enforced by nextFireTime.
    if (weapon.canScope) runtime.scoped = false;
    if (weapon.canScope) runtime.zoomLevel = 0;
  }
}
