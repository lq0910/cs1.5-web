/**
 * Actors: the player and the bots share one model.
 *
 * An actor owns the same movement state and weapon runtime the player uses, so
 * bots are subject to *exactly* the same physics and weapon rules — they cannot
 * cheat, they just have worse aim than a human.
 *
 * Hit registration uses a four-box approximation of the GoldSrc hitboxes
 * (head / chest / stomach / legs); each box carries its damage multiplier, which
 * is what makes headshots matter.
 */

import type { Vec3 } from '../engine/math.ts';
import { v3 } from '../engine/math.ts';
import type { Hull } from '../engine/collision/types.ts';
import { HULL_STANDING } from '../engine/collision/types.ts';
import type { MoveState } from './movement.ts';
import { createMoveState } from './movement.ts';
import type { HitGroup } from './combat.ts';
import { CombatSystem, applyArmor } from './combat.ts';
import type { PunchAngle, WeaponId } from './weapons.ts';
import { WEAPONS } from './weapons.ts';

export type Team = 'ct' | 't';

export interface HitBox {
  mins: Vec3;
  maxs: Vec3;
  group: HitGroup;
}

/**
 * Hitboxes relative to the hull centre (standing hull is -36..36 in Z).
 * Roughly the GoldSrc proportions: head on top, chest, stomach, then legs.
 */
export const PLAYER_HITBOXES: HitBox[] = [
  { mins: v3(-6, -6, 18), maxs: v3(6, 6, 36), group: 'head' },
  { mins: v3(-8, -8, -2), maxs: v3(8, 8, 18), group: 'chest' },
  { mins: v3(-8, -8, -14), maxs: v3(8, 8, -2), group: 'stomach' },
  { mins: v3(-9, -9, -36), maxs: v3(9, 9, -14), group: 'leg' },
];

export interface Actor {
  id: number;
  name: string;
  team: Team;
  /** 功能：阵营四套经典皮肤中的稳定随机编号。时间：2026-09-29；作者：lq。 */
  skinIndex: number;
  isBot: boolean;
  /** Movement state (position, velocity, hull, onground...). */
  move: MoveState;
  hull: Hull;
  pitch: number;
  yaw: number;
  health: number;
  armor: number;
  alive: boolean;
  /** Set on the tick the actor dies; cleared when it respawns. */
  diedAt: number;
  kills: number;
  deaths: number;
  money: number;
  /** 功能：本地玩家无限资金，BOT 仍使用普通经济。时间：2026-09-29；作者：lq。 */
  unlimitedFunds?: boolean;
  /** 功能：本地玩家备用弹药无限，仍保留弹匣、换弹动作和换弹音效。时间：2026-09-30；作者：lq。 */
  unlimitedAmmo?: boolean;
  /** 功能：三种手雷独立库存，本地玩家以 Infinity 表示无限投掷次数。时间：2026-09-30；作者：lq。 */
  grenades: { hegrenade: number; flashbang: number; smokegrenade: number };
  selectedGrenade: 'hegrenade' | 'flashbang' | 'smokegrenade' | null;
  /** 功能：记录手雷拔销与投掷动作，保证第一人称动作完整播放。时间：2026-09-29；作者：lq。 */
  grenadeAction: 'pullpin' | 'hold' | 'throw' | null;
  grenadeActionEndTime: number;
  grenadeAttackHeld: boolean;
  /** 功能：记录 C4 选择与拆弹器归属，供原版装包和拆包操作使用。时间：2026-09-30；作者：lq。 */
  selectedBomb: boolean;
  hasDefuseKit: boolean;
  /** Weapon system: ammo, reload, spray pattern, punch. */
  combat: CombatSystem;
  /** Smoothed camera punch for rendering. */
  punch: PunchAngle;
  /** For bots: set when they last fired, so others can "hear" it. */
  lastShotAt: number;
}

let nextActorId = 1;

export function createActor(options: {
  name: string;
  team: Team;
  skinIndex?: number;
  isBot: boolean;
  spawn: Vec3;
  yaw: number;
  weapons: { 1: WeaponId; 2: WeaponId; 3: WeaponId };
  seed?: number;
}): Actor {
  const move = createMoveState(options.spawn, options.yaw);
  return {
    id: nextActorId++,
    name: options.name,
    team: options.team,
    skinIndex: options.skinIndex ?? 0,
    isBot: options.isBot,
    move,
    hull: HULL_STANDING,
    pitch: 0,
    yaw: options.yaw,
    // 功能：玩家初始血量翻倍至 200，BOT 保持原版 100 血量。时间：2026-09-30；作者：lq。
    health: options.isBot ? 100 : 200,
    armor: 0,
    alive: true,
    diedAt: -99,
    kills: 0,
    deaths: 0,
    money: 800,
    grenades: { hegrenade: 0, flashbang: 0, smokegrenade: 0 },
    selectedGrenade: null,
    grenadeAction: null,
    grenadeActionEndTime: 0,
    grenadeAttackHeld: false,
    selectedBomb: false,
    hasDefuseKit: false,
    combat: new CombatSystem(options.weapons, options.seed ?? Math.floor(Math.random() * 0xffffff)),
    punch: { pitch: 0, yaw: 0 },
    lastShotAt: -99,
  };
}

export function respawnActor(
  actor: Actor,
  spawn: Vec3,
  yaw: number,
  keepMoney = true,
): void {
  actor.move = createMoveState(spawn, yaw);
  actor.hull = HULL_STANDING;
  actor.pitch = 0;
  actor.yaw = yaw;
  // 功能：玩家复活恢复 200 血量，BOT 复活恢复 100 血量。时间：2026-09-30；作者：lq。
  actor.health = actor.isBot ? 100 : 200;
  actor.armor = 0;
  actor.alive = true;
  // 功能：复活后清除上一回合的阵亡时间，避免新角色继续播放倒地动作。时间：2026-09-29；作者：lq。
  actor.diedAt = -99;
  actor.punch = { pitch: 0, yaw: 0 };
  // 功能：复活后清除上一条生命的手雷选择与投掷动作，避免卡在拔销或投掷状态。时间：2026-09-29；作者：lq。
  actor.selectedGrenade = null;
  actor.grenadeAction = null;
  actor.grenadeActionEndTime = 0;
  actor.grenadeAttackHeld = false;
  // 功能：复活清除上一条生命的 C4 操作和拆弹器。时间：2026-09-30；作者：lq。
  actor.selectedBomb = false;
  actor.hasDefuseKit = false;
  if (!keepMoney) actor.money = 800;
  // Fresh magazine each round.
  for (const slot of [1, 2, 3] as const) {
    const runtime = actor.combat.loadout[slot];
    const def = WEAPONS[runtime.id];
    runtime.ammo = Number.isFinite(def.magSize) ? def.magSize : 1;
    runtime.reloadEndTime = 0;
    runtime.deployEndTime = 0;
    runtime.nextFireTime = 0;
    runtime.shotIndex = 0;
    runtime.scoped = false;
    runtime.zoomLevel = 0;
  }
}

/** Eye position of an actor (hull centre + view offset). */
export function actorEye(actor: Actor): Vec3 {
  return v3(actor.move.origin.x, actor.move.origin.y, actor.move.origin.z + 17);
}

export function actorSpeed(actor: Actor): number {
  return Math.hypot(actor.move.velocity.x, actor.move.velocity.y);
}

export interface ActorHit {
  distance: number;
  group: HitGroup;
  point: Vec3;
}

/** Ray/box intersection, returning the nearest hit box of one actor. */
function rayHitBoxes(origin: Vec3, direction: Vec3, actor: Actor, maxDistance: number): ActorHit | null {
  let best: ActorHit | null = null;
  const centre = actor.move.origin;

  for (const box of PLAYER_HITBOXES) {
    // Slab test in the actor's axis-aligned frame.
    let tMin = 0;
    let tMax = maxDistance;
    let hit = true;

    for (const axis of ['x', 'y', 'z'] as const) {
      const min = centre[axis] + box.mins[axis];
      const max = centre[axis] + box.maxs[axis];
      const origin1 = origin[axis];
      const direction1 = direction[axis];

      if (Math.abs(direction1) < 1e-8) {
        if (origin1 < min || origin1 > max) {
          hit = false;
          break;
        }
        continue;
      }

      const inv = 1 / direction1;
      let t1 = (min - origin1) * inv;
      let t2 = (max - origin1) * inv;
      if (t1 > t2) {
        const swap = t1;
        t1 = t2;
        t2 = swap;
      }
      if (t1 > tMin) tMin = t1;
      if (t2 < tMax) tMax = t2;
      if (tMin > tMax) {
        hit = false;
        break;
      }
    }

    if (!hit) continue;
    if (!best || tMin < best.distance) {
      best = {
        distance: tMin,
        group: box.group,
        point: v3(
          origin.x + direction.x * tMin,
          origin.y + direction.y * tMin,
          origin.z + direction.z * tMin,
        ),
      };
    }
  }

  return best;
}

/**
 * First actor hit by a bullet, checking everyone in the line of fire.
 * `worldDistance` caps the search so a wall always wins.
 */
export function traceActors(
  origin: Vec3,
  direction: Vec3,
  actors: Actor[],
  worldDistance: number,
  ignore?: Actor,
): { actor: Actor; hit: ActorHit } | null {
  let best: { actor: Actor; hit: ActorHit } | null = null;
  for (const actor of actors) {
    if (!actor.alive || actor === ignore) continue;
    const hit = rayHitBoxes(origin, direction, actor, worldDistance);
    if (!hit) continue;
    if (!best || hit.distance < best.hit.distance) best = { actor, hit };
  }
  return best;
}

export interface DamageResult {
  damage: number;
  killed: boolean;
  armorLeft: number;
}

/** Applies damage through the CS armor formula and reports a kill. */
export function damageActor(
  actor: Actor,
  rawDamage: number,
  armorRatio: number,
): DamageResult {
  if (!actor.alive) return { damage: 0, killed: false, armorLeft: actor.armor };

  const applied = applyArmor(rawDamage, armorRatio, actor.armor);
  actor.armor = applied.armor;
  actor.health -= applied.damage;

  const killed = actor.health <= 0;
  if (killed) {
    actor.health = 0;
    actor.alive = false;
    actor.deaths++;
  }

  return { damage: applied.damage, killed, armorLeft: actor.armor };
}

/** Line of sight between two points, ignoring actors. */
export function hasLineOfSight(
  world: { traceHull(hull: Hull, start: Vec3, end: Vec3): { fraction: number } },
  from: Vec3,
  to: Vec3,
): boolean {
  const trace = world.traceHull({ mins: v3(0, 0, 0), maxs: v3(0, 0, 0) }, from, to);
  return trace.fraction >= 0.99;
}
