/** 功能：定义局域网输入、快照与事件协议，所有对象引用通过稳定 ID 传输；时间：2026-11-17；作者：lq。 */
import type { Actor, Team } from '../game/actors.ts';
import type { ActorCommand, Match, MatchEvents, GrenadeKind } from '../game/match.ts';
import type { WeaponRuntime } from '../game/combat.ts';
import type { WeaponSlot } from '../game/weapons.ts';
import { createActor } from '../game/actors.ts';
import type { MapInteractions } from '../game/map/interactions.ts';
import type { Critter } from '../game/critters.ts';

// 功能：购买结果消息与计时修复要求房主和客户端使用同一协议版本；时间：2026-11-18；作者：lq。
export const LAN_PROTOCOL = 3;
/** 功能：权威购买回执包含商品、结果和可显示的原因；时间：2026-11-18；作者：lq。 */
export interface PurchaseResult { kind: 'buy' | 'ammo'; item: string; success: boolean; message: string }
export type NetworkActor = Omit<Actor, 'combat'> & {
  combat: { slot: WeaponSlot; loadout: Record<WeaponSlot, WeaponRuntime> };
};
export interface PlayerActions {
  buy?: string;
  slot?: WeaponSlot;
  grenade?: GrenadeKind;
  bomb?: boolean;
  ammo?: 1 | 2;
  drop?: boolean;
  pickup?: boolean;
}
export interface InputPacket {
  type: 'input';
  seq: number;
  command: ActorCommand;
  actions: PlayerActions;
}
export interface RoomInfo {
  protocol: number;
  map: string;
  fingerprint: string;
  ctSize: number;
  tSize: number;
  skill: number;
  players: { name: string; team: Team }[];
  urls: string[];
}
export interface WireEvents {
  mode: Omit<MatchEvents['mode'], 'moneyAwards'>;
  shots: (Omit<MatchEvents['shots'][number], 'shooter' | 'victim'> & { shooter: number; victim: number | null })[];
  grenades: { kind: GrenadeKind; position: Actor['move']['origin']; thrower: number }[];
  grenadeBounces: MatchEvents['grenadeBounces'];
  reloads: { actor: number; weapon: WeaponRuntime['id'] }[];
  /** 功能：局域网同步小鸡命中和羽毛反馈；时间：2026-11-17；作者：lq。 */
  critterHits: { critter: number; shooter: number; point: Actor['move']['origin']; killed: boolean; weapon: WeaponRuntime['id'] }[];
}
export interface WorldSnapshot {
  type: 'snapshot';
  tick: number;
  /** 功能：标识整局重开，让客户端同步清理上一局的 HUD 与临时效果；时间：2026-11-17；作者：lq。 */
  generation: number;
  now: number;
  ack: number;
  actors: NetworkActor[];
  /** 功能：房主权威生成并判定可射击小鸡，客户端只负责显示；时间：2026-11-17；作者：lq。 */
  critters: Critter[];
  mode: Pick<Match['mode'], 'phase' | 'round' | 'score' | 'timeLeft' | 'bombTimeLeft' | 'matchOver' | 'winner' | 'killFeed'> & {
    bomb: Omit<Match['mode']['bomb'], 'carrier' | 'planter' | 'defuser'> & { carrier: number | null; planter: number | null; defuser: number | null };
  };
  projectiles: (Omit<Match['grenadeProjectiles'][number], 'thrower'> & { thrower: number })[];
  dropped: Match['droppedWeapons'];
  doors: { index: number; progress: number }[];
  events: WireEvents[];
}

/** 功能：校验 BSP 字节和长度，阻止不同版本或回退地图进入同局；时间：2026-11-17；作者：lq。 */
export function mapFingerprint(bytes: Uint8Array): string {
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return `${bytes.length}-${hash.toString(16)}`;
}

/** 功能：将模拟事件转换成只包含 ID 的传输对象，避免 C4/角色循环引用；时间：2026-11-17；作者：lq。 */
export function encodeEvents(events: MatchEvents): WireEvents {
  const { moneyAwards: _awards, ...mode } = events.mode;
  return {
    mode,
    shots: events.shots.map(({ shooter, victim, ...shot }) => ({ ...shot, shooter: shooter.id, victim: victim?.id ?? null })),
    grenades: events.grenades.map(({ thrower, ...grenade }) => ({ ...grenade, thrower: thrower.id })),
    grenadeBounces: events.grenadeBounces,
    reloads: events.reloads.map(({ actor, weapon }) => ({ actor: actor.id, weapon })),
    critterHits: events.critterHits.map(({ critter, shooter, point, killed, weapon }) => ({ critter: critter.id, shooter: shooter.id, point, killed, weapon })),
  };
}

/** 功能：恢复权威事件中的角色引用，复用现有音效、命中特效和回合提示；时间：2026-11-17；作者：lq。 */
export function decodeEvents(wire: WireEvents, actors: Actor[], critters: Critter[] = []): MatchEvents {
  const actor = (id: number): Actor => actors.find((candidate) => candidate.id === id)!;
  return {
    mode: { ...wire.mode, moneyAwards: [] },
    shots: wire.shots.map(({ shooter, victim, ...shot }) => ({ ...shot, shooter: actor(shooter), victim: victim === null ? null : actor(victim) })),
    grenades: wire.grenades.map(({ thrower, ...grenade }) => ({ ...grenade, thrower: actor(thrower) })),
    grenadeBounces: wire.grenadeBounces,
    reloads: wire.reloads.map(({ actor: id, weapon }) => ({ actor: actor(id), weapon })),
    critterHits: wire.critterHits.flatMap(({ critter, shooter, point, killed, weapon }) => {
      const target = critters.find((candidate) => candidate.id === critter);
      return target ? [{ critter: target, shooter: actor(shooter), point, killed, weapon }] : [];
    }), noises: [],
  };
}

/** 功能：快照只传输玩法状态，渲染资源和私有随机序列留在各自进程；时间：2026-11-17；作者：lq。 */
export function snapshotWorld(match: Match, tick: number, now: number, doors: WorldSnapshot['doors'], events: WireEvents[], generation = 0): WorldSnapshot {
  const { bomb, ...mode } = match.mode;
  return {
    type: 'snapshot', tick, now, ack: 0, generation,
    actors: match.actors.map(({ combat, ...actor }) => ({ ...actor, combat: { slot: combat.activeSlot, loadout: combat.loadout } })),
    critters: match.critters,
    mode: {
      phase: mode.phase, round: mode.round, score: mode.score, timeLeft: mode.timeLeft,
      bombTimeLeft: mode.bombTimeLeft, matchOver: mode.matchOver, winner: mode.winner, killFeed: mode.killFeed,
      bomb: { ...bomb, carrier: bomb.carrier?.id ?? null, planter: bomb.planter?.id ?? null, defuser: bomb.defuser?.id ?? null },
    },
    projectiles: match.grenadeProjectiles.map(({ thrower, ...projectile }) => ({ ...projectile, thrower: thrower.id })),
    dropped: match.droppedWeapons, doors, events,
  };
}

/** 功能：将服务端快照应用到本地展示对象，保留角色/炸弹引用稳定供渲染器复用；时间：2026-11-17；作者：lq。 */
export function applySnapshot(match: Match, snapshot: WorldSnapshot, interactions?: MapInteractions): void {
  const previous = new Map(match.actors.map((actor) => [actor.id, actor]));
  const actors = snapshot.actors.map((state) => {
    const current = previous.get(state.id) ?? createActor({ name: state.name, team: state.team, isBot: true,
      spawn: state.move.origin, yaw: state.yaw, weapons: { 1: state.combat.loadout[1].id,
        2: state.combat.loadout[2].id, 3: state.combat.loadout[3].id }, seed: state.id });
    current.id = state.id;
    const { combat: _combat, ...actorState } = state;
    Object.assign(current, actorState);
    current.combat.applyNetworkState(state.combat.slot, state.combat.loadout, state.punch);
    return current;
  });
  match.actors.splice(0, match.actors.length, ...actors);
  match.critters.splice(0, match.critters.length, ...snapshot.critters.map((state) => ({ ...state, position: { ...state.position } })));
  const get = (id: number | null): Actor | null => id === null ? null : actors.find((actor) => actor.id === id) ?? null;
  Object.assign(match.mode, snapshot.mode, {
    bomb: { ...snapshot.mode.bomb, carrier: get(snapshot.mode.bomb.carrier),
      planter: get(snapshot.mode.bomb.planter), defuser: get(snapshot.mode.bomb.defuser) },
  });
  match.mode.killFeed.splice(0, match.mode.killFeed.length, ...snapshot.mode.killFeed);
  match.grenadeProjectiles.splice(0, match.grenadeProjectiles.length,
    ...snapshot.projectiles.map((projectile) => ({ ...projectile, thrower: get(projectile.thrower)! })));
  match.droppedWeapons.splice(0, match.droppedWeapons.length,
    ...snapshot.dropped.map((dropped) => ({ ...dropped, weapon: { ...dropped.weapon } })));
  interactions?.applyDoors?.(snapshot.doors);
}
