/**
 * Match runner: the whole 4v4 round loop, headless.
 *
 * Both the browser game and the tests drive this one class. That is deliberate:
 * a bot-vs-bot match can then be simulated in Node, which is the only practical
 * way to verify that rounds actually start, fights resolve, the bomb gets
 * planted and defused, and the score adds up.
 *
 * Per tick, for every living actor:
 *   1. a command is produced (input for the human, a bot brain otherwise);
 *   2. the *same* pmove code advances the actor;
 *   3. the *same* weapon code fires, and bullets are traced against the world
 *      and then against actor hitboxes;
 *   4. damage goes through the CS armor formula and kills are reported.
 */

import type { Vec3 } from '../engine/math.ts';
import { v3 } from '../engine/math.ts';
import type { CollisionWorld } from '../engine/collision/types.ts';
import type { MapData } from './map/build.ts';
import type { NavGraph } from './nav.ts';
import { nearestNode, randomNodeNear } from './nav.ts';
import type { ObjectiveArea } from './objectives.ts';
import {
  createActor,
  actorEye,
  actorSpeed,
  damageActor,
  traceActors,
} from './actors.ts';
import type { Actor, Team } from './actors.ts';
import { aimDirection, makeWeaponRuntime, POINT_HULL } from './combat.ts';
import type { CombatEvents, ShotEvent } from './combat.ts';
import type { WeaponRuntime } from './combat.ts';
import { BUY_MENU, GameMode } from './gamemode.ts';
import type { RoundEvents } from './gamemode.ts';
import { BotBrain } from './bots.ts';
import type { BotGoal } from './bots.ts';
import { WEAPONS } from './weapons.ts';
// 功能：对局模拟使用原版手雷投掷与物理参数。时间：2026-09-30；作者：lq。
import { grenadeLaunch, heDamage, GRENADE_GRAVITY, GRENADE_FRICTION, GRENADE_FUSE } from './grenades.ts';
import type { WeaponId } from './weapons.ts';
import { IN_ATTACK, IN_ATTACK2, IN_FORWARD, IN_MOVELEFT, IN_MOVERIGHT, IN_USE, TICK_INTERVAL } from './constants.ts';

export type GrenadeKind = 'hegrenade' | 'flashbang' | 'smokegrenade';
export interface GrenadeEvent { kind: GrenadeKind; position: Vec3; thrower: Actor }
/** 功能：记录手雷飞行、弹跳和引信，供模拟与世界渲染共用。时间：2026-09-29；作者：lq。 */
export interface GrenadeProjectile extends GrenadeEvent { id: number; velocity: Vec3; detonateAt: number; lastBounceAt: number }

/** 功能：记录 T 键喷漆命中的表面和方向，供贴花渲染与原版音效共用。时间：2026-09-30；作者：lq。 */
export interface SprayEvent { position: Vec3; normal: Vec3; yaw: number }

/** 功能：保存阵亡或主动丢弃的枪械、剩余弹药与可拾取位置，供模拟和世界模型共用。时间：2026-09-29；作者：lq。 */
export interface DroppedWeapon { id: number; weapon: WeaponRuntime; position: Vec3; yaw: number; availableAt: number }

export interface ActorCommand {
  buttons: number;
  forwardmove: number;
  sidemove: number;
  upmove: number;
  yaw: number;
  pitch: number;
}

export interface ResolvedShot {
  shooter: Actor;
  shot: ShotEvent;
  victim: Actor | null;
  damage: number;
  killed: boolean;
  headshot: boolean;
}

export interface MatchEvents {
  mode: RoundEvents;
  shots: ResolvedShot[];
  /** Sounds the audio layer should play (already positioned). */
  noises: { name: string[]; position: Vec3 }[];
  grenades: GrenadeEvent[];
  grenadeBounces: Vec3[];
  /** 功能：把各角色换弹起始事件传给音频层，供原版音效按动作时序播放。时间：2026-09-29；作者：lq。 */
  reloads: { actor: Actor; weapon: WeaponId }[];
}

export interface MatchOptions {
  map: MapData;
  graph: NavGraph | null;
  sites: ObjectiveArea[];
  /** Team sizes; the player counts towards `ct`. */
  teamSize?: number;
  /** 功能：本地玩家可选择反恐精英或恐怖分子阵营。时间：2026-09-29；作者：lq。 */
  playerTeam?: Team;
  skill?: number;
  seed?: number;
  /** Ticks per second (fixed step). */
  tickRate?: number;
}

/**
 * Buckets the map's spawn points per team.
 *
 * Falls back to a geometric split (the two clusters furthest apart) when a map
 * only ships one kind of spawn entity, so a custom map cannot put both teams on
 * top of each other.
 */
function groupSpawnsByTeam(spawns: { origin: Vec3; team: 'ct' | 't' }[]): { ct: Vec3[]; t: Vec3[] } {
  const ct = spawns.filter((spawn) => spawn.team === 'ct').map((spawn) => spawn.origin);
  const t = spawns.filter((spawn) => spawn.team === 't').map((spawn) => spawn.origin);

  if (ct.length > 0 && t.length > 0) return { ct, t };
  if (spawns.length === 0) return { ct: [v3(0, 0, 36)], t: [v3(256, 0, 36)] };

  const all = spawns.map((spawn) => spawn.origin);
  // Split along the axis with the widest spread, at the median.
  let axis: 'x' | 'y' = 'x';
  let widest = -1;
  for (const candidate of ['x', 'y'] as const) {
    const values = all.map((point) => point[candidate]);
    const spread = Math.max(...values) - Math.min(...values);
    if (spread > widest) {
      widest = spread;
      axis = candidate;
    }
  }
  const sorted = [...all].sort((a, b) => a[axis] - b[axis]);
  const half = Math.max(1, Math.floor(sorted.length / 2));
  return { ct: sorted.slice(0, half), t: sorted.slice(half).length > 0 ? sorted.slice(half) : sorted.slice(0, half) };
}

const BOT_NAMES_T = ['Vitaliy', 'Rasim', 'Anton', 'Sergei', 'Nikita', 'Oleg'];
const BOT_NAMES_CT = ['Alex', 'Chris', 'Danny', 'Emil', 'Frank', 'Gus'];

export class Match {
  readonly actors: Actor[] = [];
  readonly mode: GameMode;
  readonly player: Actor | null = null;
  private readonly brains = new Map<number, BotBrain>();
  private readonly world: CollisionWorld;
  private readonly graph: NavGraph | null;
  private readonly sites: ObjectiveArea[];
  private readonly skill: number;
  private readonly teamSize: number;
  private readonly dt = TICK_INTERVAL;
  private readonly spawns: { ct: Vec3[]; t: Vec3[] };
  private readonly randomness: () => number;
  /** 功能：BOT 购买使用独立随机序列，避免影响战斗和导航的随机行为。时间：2026-09-29；作者：lq。 */
  private readonly shoppingRandom: () => number;
  readonly grenadeProjectiles: GrenadeProjectile[] = [];
  private nextGrenadeId = 1;
  /** 功能：原版 decalfrequency 默认 30 秒，仅成功喷到表面后进入冷却。时间：2026-09-30；作者：lq。 */
  private nextSprayAt = 0;
  /** 功能：当前回合留在地面的原版枪械，拾取后立即从场景中移除。时间：2026-09-29；作者：lq。 */
  readonly droppedWeapons: DroppedWeapon[] = [];
  private nextDroppedWeaponId = 1;
  /**
   * Bomb sites snapped onto the navmesh.
   *
   * The site centre comes from a brush bounding box, which frequently sits
   * inside a wall. Sending bots there makes them grind against geometry for the
   * rest of the round (and repeatedly hop) — so every goal is snapped to a real
   * walkable node first.
   */
  private readonly siteGoals: Vec3[] = [];
  /** Bombsite the terrorists attack this round (chosen once per round). */
  private roundSiteIndex = 0;

  constructor(options: MatchOptions) {
    this.world = options.map.collision;
    this.graph = options.graph;
    this.sites = options.sites;
    // 功能：默认使用简单 BOT 难度，降低玩家遭遇的命中与反应压力。时间：2026-09-29；作者：lq。
    this.skill = options.skill ?? 0.15;
    this.teamSize = options.teamSize ?? 4;

    let seed = options.seed ?? 12345;
    this.randomness = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    // 功能：皮肤随机数使用独立序列，避免改变 BOT 行为的可复现实验种子。时间：2026-09-29；作者：lq。
    let skinSeed = ((options.seed ?? 12345) ^ 0x9e3779b9) >>> 0;
    const skinRandom = () => {
      skinSeed = (skinSeed * 1664525 + 1013904223) >>> 0;
      return skinSeed / 0xffffffff;
    };
    // 功能：为每局 BOT 购枪选择建立可复现的独立随机种子。时间：2026-09-29；作者：lq。
    let shoppingSeed = ((options.seed ?? 12345) ^ 0x85ebca6b) >>> 0;
    this.shoppingRandom = () => {
      shoppingSeed = (shoppingSeed * 1664525 + 1013904223) >>> 0;
      return shoppingSeed / 0x100000000;
    };

    // 功能：按地图解析后的阵营标签分组出生点；原版 start 为 CT、deathmatch 为 T。时间：2026-09-29；作者：lq。
    this.spawns = groupSpawnsByTeam(options.map.spawns);
    const playerTeam = options.playerTeam ?? 'ct';
    // 功能：每阵营独立打乱四套经典皮肤；4v4 对局会各出现四种且每次开局顺序变化。时间：2026-09-29；作者：lq。
    const shuffleSkins = (): number[] => {
      const order = [0, 1, 2, 3];
      for (let i = order.length - 1; i > 0; i--) {
        const pick = Math.floor(skinRandom() * (i + 1));
        [order[i], order[pick]] = [order[pick]!, order[i]!];
      }
      return order;
    };
    const ctSkins = shuffleSkins();
    const tSkins = shuffleSkins();

    // 功能：玩家开局副武器固定为经典 P228“小白银”，BOT 仍使用双方原版默认手枪。时间：2026-09-30；作者：lq。
    const tLoadout: { 1: WeaponId; 2: WeaponId; 3: WeaponId } = { 1: 'ak47', 2: 'p228', 3: 'knife' };
    const ctLoadout: { 1: WeaponId; 2: WeaponId; 3: WeaponId } = { 1: 'm4a1', 2: 'p228', 3: 'knife' };
    // 功能：BOT 从初始手枪开始按回合经济自动购买，而本地玩家保留现有初始枪。时间：2026-09-29；作者：lq。
    const tBotLoadout: typeof tLoadout = { 1: 'knife', 2: 'glock18', 3: 'knife' };
    const ctBotLoadout: typeof ctLoadout = { 1: 'knife', 2: 'usp45', 3: 'knife' };

    for (let i = 0; i < this.teamSize; i++) {
      const ctSpawn = this.spawns.ct[i % this.spawns.ct.length]!;
      const tSpawn = this.spawns.t[i % this.spawns.t.length]!;
      const ctHuman = playerTeam === 'ct' && i === 0;
      const tHuman = playerTeam === 't' && i === 0;

      const ct: Actor = createActor({
        name: ctHuman ? 'YOU' : (BOT_NAMES_CT[playerTeam === 'ct' ? i - 1 : i] ?? `CT${i}`),
        team: 'ct',
        skinIndex: ctSkins[i % 4],
        isBot: !ctHuman,
        spawn: ctSpawn,
        yaw: (Math.atan2(-ctSpawn.y, -ctSpawn.x) * 180) / Math.PI,
        weapons: ctHuman ? ctLoadout : ctBotLoadout,
        seed: Math.floor(this.randomness() * 0xffffff),
      });
      this.actors.push(ct);
      if (ctHuman) {
        // The local player: not driven by a brain.
        (this as { player: Actor | null }).player = ct;
        // 功能：本地玩家 CT 出场直接持有 B14 对应的 P228“小白银”。时间：2026-09-30；作者：lq。
        ct.combat.selectSlot(2, 0);
        // 功能：本地玩家无需经济限制，可持续购买所有原版枪械和手雷。时间：2026-09-29；作者：lq。
        ct.unlimitedFunds = true;
        // 功能：本地玩家每个弹匣仍需换弹，但备用弹药永久无限。时间：2026-09-30；作者：lq。
        ct.unlimitedAmmo = true;
        ct.money = Infinity;
      } else {
        this.brains.set(ct.id, new BotBrain(Math.floor(this.randomness() * 0xffffff), ctSpawn));
      }

      const t: Actor = createActor({
        name: tHuman ? 'YOU' : (BOT_NAMES_T[playerTeam === 't' ? i - 1 : i] ?? `T${i}`),
        team: 't',
        skinIndex: tSkins[i % 4],
        isBot: !tHuman,
        spawn: tSpawn,
        yaw: (Math.atan2(-tSpawn.y, -tSpawn.x) * 180) / Math.PI,
        weapons: tHuman ? tLoadout : tBotLoadout,
        seed: Math.floor(this.randomness() * 0xffffff),
      });
      this.actors.push(t);
      if (tHuman) {
        (this as { player: Actor | null }).player = t;
        // 功能：本地玩家 T 出场直接持有 B14 对应的 P228“小白银”。时间：2026-09-30；作者：lq。
        t.combat.selectSlot(2, 0);
        t.unlimitedFunds = true;
        // 功能：本地玩家每个弹匣仍需换弹，但备用弹药永久无限。时间：2026-09-30；作者：lq。
        t.unlimitedAmmo = true;
        t.money = Infinity;
      } else {
        this.brains.set(t.id, new BotBrain(Math.floor(this.randomness() * 0xffffff), tSpawn));
      }
    }

    for (const site of this.sites) {
      const node = this.graph ? nearestNode(this.graph, site.center) : -1;
      this.siteGoals.push(
        node >= 0 && this.graph
          ? v3(this.graph.nodes[node]!.x, this.graph.nodes[node]!.y, this.graph.nodes[node]!.z)
          : site.center,
      );
    }

    this.mode = new GameMode(this.sites);
    this.mode.setSpawns(this.spawns);
    this.mode.setActors(this.actors);
  }

  /** Starts the first round immediately (skips the warmup delay in tests). */
  startNow(now = 0): void {
    const events: RoundEvents = {
      roundStarted: null,
      roundEnded: null,
      killFeed: [],
      bombPlanted: null,
      bombDefused: false,
      bombExploded: false,
      moneyAwards: [],
    };
    this.mode.startRound(this.actors, this.spawns, now, events);
    this.droppedWeapons.length = 0;
    this.autoBuyBots(now);
  }

  /** 功能：把指定栏位枪械放在脚边地面，保留弹夹与备用弹药供队员拾取。时间：2026-09-29；作者：lq。 */
  private dropWeaponFromSlot(actor: Actor, slot: 1 | 2, now: number): DroppedWeapon | null {
    const runtime = actor.combat.loadout[slot];
    if (runtime.id === 'knife') return null;
    const forward = aimDirection(0, actor.yaw);
    const origin = v3(actor.move.origin.x + forward.x * 12, actor.move.origin.y + forward.y * 12, actor.move.origin.z);
    const floor = this.world.traceHull(POINT_HULL, v3(origin.x, origin.y, origin.z + 20), v3(origin.x, origin.y, origin.z - 96));
    const position = floor.fraction < 1 && !floor.startsolid
      ? v3(floor.endpos.x, floor.endpos.y, floor.endpos.z + 3)
      : v3(origin.x, origin.y, origin.z - 30);
    const dropped: DroppedWeapon = {
      id: this.nextDroppedWeaponId++, weapon: { ...runtime }, position, yaw: actor.yaw, availableAt: now + 0.35,
    };
    this.droppedWeapons.push(dropped);
    actor.combat.loadout[slot] = makeWeaponRuntime('knife');
    if (actor.alive && actor.combat.activeSlot === slot) {
      const other = slot === 1 ? 2 : 1;
      actor.combat.selectSlot(actor.combat.loadout[other].id !== 'knife' ? other : 3, now);
    }
    return dropped;
  }

  /** 功能：G 键丢弃当前主枪或手枪；持刀时不丢弃装备。时间：2026-09-29；作者：lq。 */
  dropCurrentWeapon(actor: Actor, now: number): DroppedWeapon | null {
    if (!actor.alive || this.mode.phase !== 'live') return null;
    const slot = actor.combat.activeSlot;
    return slot === 1 || slot === 2 ? this.dropWeaponFromSlot(actor, slot, now) : null;
  }

  /** 功能：靠近尸体枪械按 E 交换同栏位装备；空栏位可直接走过拾取。时间：2026-09-29；作者：lq。 */
  pickupNearestWeapon(actor: Actor, now: number, allowSwap = true): DroppedWeapon | null {
    if (!actor.alive || this.mode.phase !== 'live') return null;
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (const [index, dropped] of this.droppedWeapons.entries()) {
      if (now < dropped.availableAt) continue;
      const slot = WEAPONS[dropped.weapon.id].slot;
      if (slot !== 1 && slot !== 2) continue;
      if (!allowSwap && actor.combat.loadout[slot].id !== 'knife') continue;
      const distance = Math.hypot(actor.move.origin.x - dropped.position.x, actor.move.origin.y - dropped.position.y);
      if (distance > 54 || Math.abs(actor.move.origin.z - dropped.position.z) > 64 || distance >= bestDistance) continue;
      const eye = actorEye(actor);
      if (this.world.traceHull(POINT_HULL, eye, v3(dropped.position.x, dropped.position.y, dropped.position.z + 8)).fraction < 0.98) continue;
      bestIndex = index;
      bestDistance = distance;
    }
    if (bestIndex < 0) return null;
    const [dropped] = this.droppedWeapons.splice(bestIndex, 1);
    const slot = WEAPONS[dropped!.weapon.id].slot as 1 | 2;
    if (actor.combat.loadout[slot].id !== 'knife') this.dropWeaponFromSlot(actor, slot, now);
    actor.combat.loadout[slot] = {
      ...dropped!.weapon, reloadEndTime: 0, nextFireTime: 0,
      deployEndTime: now + WEAPONS[dropped!.weapon.id].deployTime, scoped: false, zoomLevel: 0,
    };
    actor.combat.selectSlot(slot, now);
    return dropped!;
  }

  /** 功能：角色阵亡时优先掉落正在使用的枪，持刀时掉落背上的主枪或手枪。时间：2026-09-29；作者：lq。 */
  private dropOnDeath(actor: Actor, now: number): void {
    const active = actor.combat.activeSlot;
    const slot = (active === 1 || active === 2) && actor.combat.loadout[active].id !== 'knife'
      ? active : actor.combat.loadout[1].id !== 'knife' ? 1 : 2;
    this.dropWeaponFromSlot(actor, slot, now);
  }

  /** 功能：冻结阶段按经济与阵营为 BOT 随机购买经典手枪、冲锋枪或步枪，并装备购买结果。时间：2026-09-29；作者：lq。 */
  private autoBuyBots(now: number): void {
    const ctPistols: WeaponId[] = ['p228', 'deagle', 'fiveseven'];
    const tPistols: WeaponId[] = ['p228', 'deagle', 'elite'];
    const ctPrimary: WeaponId[] = ['tmp', 'mp5navy', 'ump45', 'p90', 'm3', 'xm1014', 'scout', 'm4a1', 'aug', 'awp', 'sg550'];
    const tPrimary: WeaponId[] = ['mac10', 'mp5navy', 'ump45', 'p90', 'm3', 'xm1014', 'scout', 'ak47', 'sg552', 'awp', 'g3sg1'];
    for (const actor of this.actors) {
      if (!actor.isBot) continue;
      if (actor.combat.loadout[1].id !== 'knife') {
        actor.combat.selectSlot(1, now);
      } else {
        const primaryPool = actor.team === 'ct' ? ctPrimary : tPrimary;
        const pistolPool = actor.team === 'ct' ? ctPistols : tPistols;
        const canAfford = (id: WeaponId) => (BUY_MENU.find((item) => item.id === id)?.price ?? Infinity) <= actor.money;
        const affordablePrimary = actor.money >= 1250 ? primaryPool.filter(canAfford) : [];
        // 功能：当前阵营没有买得起的主武器时退回手枪菜单，不让 BOT 空手攒钱。时间：2026-09-29；作者：lq。
        const affordable = affordablePrimary.length ? affordablePrimary : pistolPool.filter(canAfford);
        if (affordable.length > 0) {
          const chosen = affordable[Math.floor(this.shoppingRandom() * affordable.length)]!;
          this.mode.buy(actor, chosen);
          actor.combat.selectSlot(WEAPONS[chosen].slot as 1 | 2, now);
        } else actor.combat.selectSlot(2, now);
      }
      // 功能：购枪后有余钱的 BOT 随机补防弹衣和 CT 拆弹器，保留 CS 开局购物差异。时间：2026-09-29；作者：lq。
      if (actor.armor < 80 && actor.money >= 1000 && this.shoppingRandom() < 0.55) this.mode.buy(actor, 'armor');
      else if (actor.armor < 80 && actor.money >= 650 && this.shoppingRandom() < 0.4) this.mode.buy(actor, 'kevlar');
      if (actor.team === 'ct' && actor.money >= 200 && this.shoppingRandom() < 0.3) this.mode.buy(actor, 'defusekit');
    }
  }

  /**
   * Bot goal for the current round state.
   *
   * The site choice is made *once per round* (see roundSiteIndex): picking a
   * random site every tick makes the bomb carrier oscillate between A and B and
   * the terrorists never commit, which showed up as a 6-0 CT sweep.
   */
  private goalFor(actor: Actor): BotGoal | null {
    const mode = this.mode;
    const target = this.siteGoals[this.roundSiteIndex] ?? this.siteGoals[0] ?? null;

    /** A walkable spot near a world position (falls back to the position). */
    const near = (position: Vec3, radius: number): Vec3 => {
      if (!this.graph) return position;
      const node = randomNodeNear(this.graph, position, radius, this.randomness);
      if (node < 0) return position;
      const picked = this.graph.nodes[node]!;
      return v3(picked.x, picked.y, picked.z);
    };

    if (actor.team === 't') {
      // 功能：C4 掉落时队员先回收背包，再继续进攻包点。时间：2026-09-30；作者：lq。
      if (mode.bomb.state === 'dropped' && mode.bomb.position) return { position: mode.bomb.position, kind: 'bomb' };
      if (mode.bomb.state === 'planted' && mode.bomb.position) {
        // Defend the bomb: spread out around it.
        return { position: near(mode.bomb.position, 360), kind: 'bomb' };
      }
      // Everyone escorts the carrier to the chosen site.
      return target ? { position: target, kind: 'site' } : null;
    }

    if (mode.bomb.state === 'planted' && mode.bomb.position) {
      return { position: near(mode.bomb.position, 120), kind: 'defuse' };
    }
    // CTs split between the sites, holding angles.
    if (this.siteGoals.length > 1) {
      return { position: this.siteGoals[actor.id % this.siteGoals.length]!, kind: 'site' };
    }
    return target ? { position: target, kind: 'site' } : null;
  }

  /** 功能：存活玩家在 128 单位内对墙地喷漆，空中、实体内部和冷却期不生成贴花。时间：2026-09-30；作者：lq。 */
  trySpray(now: number): SprayEvent | null {
    const actor = this.player;
    if (!actor?.alive || this.mode.phase === 'over' || now < this.nextSprayAt) return null;
    const eye = actorEye(actor);
    const direction = aimDirection(actor.pitch, actor.yaw);
    const end = v3(eye.x + direction.x * 128, eye.y + direction.y * 128, eye.z + direction.z * 128);
    const trace = this.world.traceHull(POINT_HULL, eye, end);
    if (trace.fraction >= 1 || trace.startsolid || trace.allsolid || Math.hypot(trace.normal.x, trace.normal.y, trace.normal.z) < 0.5) return null;
    this.nextSprayAt = now + 30;
    return { position: trace.endpos, normal: trace.normal, yaw: actor.yaw };
  }

  update(now: number, playerCommand?: ActorCommand): MatchEvents {
    // 功能：回合更新前处理 C4 掉落，避免死亡持包者仍被视为可装包。时间：2026-09-30；作者：lq。
    this.mode.dropBomb();
    // 功能：拆包者阵亡即取消进度，下一名 CT 必须重新拆除。时间：2026-09-30；作者：lq。
    if (this.mode.bomb.defuser && !this.mode.bomb.defuser.alive) this.mode.cancelDefuse(this.mode.bomb.defuser);
    const events: MatchEvents = {
      mode: this.mode.update(this.dt, this.actors, now),
      shots: [],
      noises: [],
      grenades: [],
      grenadeBounces: [],
      reloads: [],
    };

    if (events.mode.roundStarted) {
      this.grenadeProjectiles.length = 0;
      // 功能：每局开始清空上一局地面的枪械，防止跨回合重复拾取。时间：2026-09-29；作者：lq。
      this.droppedWeapons.length = 0;
      this.autoBuyBots(now);
    }
    // 功能：C4 倒计时归零后按爆心距离结算伤害，保留原版爆炸会杀伤附近角色的玩法。时间：2026-09-30；作者：lq。
    if (events.mode.bombExploded && this.mode.bomb.position) {
      const blast = this.mode.bomb.position;
      for (const victim of this.actors) {
        if (!victim.alive) continue;
        const distance = Math.hypot(victim.move.origin.x - blast.x, victim.move.origin.y - blast.y, victim.move.origin.z - blast.z);
        const damage = Math.max(0, 500 * (1 - distance / 1000));
        if (damage <= 0) continue;
        const result = damageActor(victim, damage, 1);
        if (result.killed) { victim.diedAt = now; this.dropOnDeath(victim, now); }
      }
    }
    // 功能：每个固定步长推进手雷抛物线与墙地弹跳，直到引信到时才在当前位置爆炸。时间：2026-09-29；作者：lq。
    for (let i = this.grenadeProjectiles.length - 1; i >= 0; i--) {
      const grenade = this.grenadeProjectiles[i]!;
      // 功能：以原版半重力积分抛物线，避免全重力造成提前落在脚边。时间：2026-09-30；作者：lq。
      const target = v3(
        grenade.position.x + grenade.velocity.x * this.dt,
        grenade.position.y + grenade.velocity.y * this.dt,
        grenade.position.z + grenade.velocity.z * this.dt - 0.5 * GRENADE_GRAVITY * this.dt * this.dt,
      );
      grenade.velocity.z -= GRENADE_GRAVITY * this.dt;
      const trace = this.world.traceHull(POINT_HULL, grenade.position, target);
      if (trace.fraction < 1) {
        const normal = trace.normal;
        const speed = Math.hypot(grenade.velocity.x, grenade.velocity.y, grenade.velocity.z);
        grenade.position = v3(trace.endpos.x + normal.x * 1.5, trace.endpos.y + normal.y * 1.5, trace.endpos.z + normal.z * 1.5);
        const dot = grenade.velocity.x * normal.x + grenade.velocity.y * normal.y + grenade.velocity.z * normal.z;
        if (dot < 0) {
          // 功能：GoldSrc MOVETYPE_BOUNCE 按 2-friction 反射法向速度，保留切向飞行速度。时间：2026-09-30；作者：lq。
          const backoff = dot * (2 - GRENADE_FRICTION);
          grenade.velocity = v3(
            grenade.velocity.x - backoff * normal.x,
            grenade.velocity.y - backoff * normal.y,
            grenade.velocity.z - backoff * normal.z,
          );
        }
        if (normal.z > 0.6) {
          // 功能：落地后按原版摩擦减速，低速停稳后不再反复弹跳。时间：2026-09-30；作者：lq。
          grenade.velocity.x *= GRENADE_FRICTION;
          grenade.velocity.y *= GRENADE_FRICTION;
          if (Math.abs(grenade.velocity.z) < 60) grenade.velocity.z = 0;
          if (Math.hypot(grenade.velocity.x, grenade.velocity.y, grenade.velocity.z) < 60) grenade.velocity = v3(0, 0, 0);
        }
        if (speed > 90 && now - grenade.lastBounceAt > 0.08) {
          events.grenadeBounces.push(v3(grenade.position.x, grenade.position.y, grenade.position.z));
          grenade.lastBounceAt = now;
        }
      } else grenade.position = target;
      if (now < grenade.detonateAt) continue;
      this.grenadeProjectiles.splice(i, 1);
      events.grenades.push({ kind: grenade.kind, position: grenade.position, thrower: grenade.thrower });
      if (grenade.kind !== 'hegrenade') continue;
      for (const victim of this.actors) {
        if (!victim.alive) continue;
        // 功能：默认关闭队友伤害，但投掷者仍承受自己手雷的爆炸。时间：2026-09-30；作者：lq。
        if (victim.team === grenade.thrower.team && victim !== grenade.thrower) continue;
        const distance = Math.hypot(
          victim.move.origin.x - grenade.position.x,
          victim.move.origin.y - grenade.position.y,
          victim.move.origin.z - grenade.position.z,
        );
        const damage = heDamage(distance);
        if (damage <= 0) continue;
        // 功能：高爆弹的墙体遮挡以人物胸部射线判定，隔墙不造成爆炸伤害。时间：2026-09-30；作者：lq。
        const chest = v3(victim.move.origin.x, victim.move.origin.y, victim.move.origin.z + 8);
        if (this.world.traceHull(POINT_HULL, grenade.position, chest).fraction < 0.99) continue;
        const result = damageActor(victim, damage, 0.5);
        if (result.killed) {
          // 功能：记录爆炸致死的时刻，驱动原版人物倒地动画。时间：2026-09-29；作者：lq。
          victim.diedAt = now;
          this.dropOnDeath(victim, now);
          grenade.thrower.kills++;
          this.mode.registerKill(grenade.thrower, victim, 'HE Grenade', false, now);
        }
      }
    }

    if (events.mode.roundStarted && this.sites.length > 0) {
      this.roundSiteIndex = Math.floor(this.randomness() * this.sites.length);
    }

    for (const actor of this.actors) {
      if (!actor.alive) continue;
      // 功能：T 路过地面 C4 时自动拾取，与原版背包拾取一致。时间：2026-09-30；作者：lq。
      this.mode.pickupBomb(actor);

      // ---- 1. command
      let command: ActorCommand;
      if (actor === this.player && playerCommand) {
        command = playerCommand;
      } else {
        const brain = this.brains.get(actor.id);
        if (!brain) continue;
        const brainCommand = brain.think(this.dt, {
          world: this.world,
          graph: this.graph,
          self: actor,
          enemies: this.actors,
          goal: this.goalFor(actor),
          now,
          skill: this.skill,
          canPlant:
            actor.team === 't' &&
            this.mode.bomb.state === 'carried' &&
            this.mode.bomb.carrier === actor &&
            this.mode.bombsiteAt(actor.move.origin) !== null,
          canDefuse:
            actor.team === 'ct' &&
            this.mode.bomb.state === 'planted' &&
            this.mode.bomb.position !== null &&
            Math.hypot(
              actor.move.origin.x - this.mode.bomb.position.x,
              actor.move.origin.y - this.mode.bomb.position.y,
            ) < 64,
        });
        actor.yaw = brainCommand.yaw;
        actor.pitch = brainCommand.pitch;
        command = {
          buttons: brainCommand.buttons,
          forwardmove: brainCommand.forwardmove,
          sidemove: brainCommand.sidemove,
          upmove: 0,
          yaw: brainCommand.yaw,
          pitch: brainCommand.pitch,
        };

        // 功能：BOT 与玩家使用相同的持续装包及拆包计时。时间：2026-09-30；作者：lq。
        if (brainCommand.action === 'plant') {
          actor.selectedBomb = true;
          this.mode.progressPlant(actor, this.dt, now, events.mode);
        } else if (actor === this.mode.bomb.carrier) {
          actor.selectedBomb = false;
          this.mode.cancelPlant();
        }
        if (brainCommand.action === 'defuse') this.mode.progressDefuse(actor, this.dt, events.mode);
        else this.mode.cancelDefuse(actor);
      }

      // ---- 2. freeze time: in CS nothing moves or fires until "go"
      if (this.mode.phase === 'freeze' || this.mode.phase === 'warmup' || this.mode.phase === 'over') {
        command.buttons = 0;
        command.forwardmove = 0;
        command.sidemove = 0;
      }

      // ---- 3. movement (identical code path for bots and the player)
      const cmd = {
        msec: this.dt * 1000,
        buttons: command.buttons,
        forwardmove: command.forwardmove,
        sidemove: command.sidemove,
        upmove: 0,
        pitch: command.pitch,
        yaw: command.yaw,
        roll: 0,
      };
      actor.move.maxspeed = WEAPONS[actor.combat.current().id].maxSpeed;
      // 功能：无限子弹只锁定本地玩家的备用弹药，不跳过弹匣耗尽、自动换弹和动作音效。时间：2026-09-30；作者：lq。
      if (actor.unlimitedAmmo) {
        for (const slot of [1, 2, 3] as const) actor.combat.loadout[slot].reserve = Infinity;
      }
      // The movement code builds its wish direction from *state.angles*, not from
      // the command's angles: forgetting this makes every bot walk in the
      // direction it happened to spawn facing.
      actor.move.angles.pitch = 0;
      actor.move.angles.yaw = command.yaw;
      actor.move.angles.roll = 0;
      // 功能：保存装包前的 C4 选择状态，完成安装的同一帧仍阻止枪械误击。时间：2026-09-30；作者：lq。
      const bombWasSelected = actor.selectedBomb;
      pmPlayerMove(actor.move, this.world, cmd, this.dt);
      // 功能：持包 T 在包点按住左键安装；CT 靠近炸弹按住 E 拆除，松键立即中断。时间：2026-09-30；作者：lq。
      if (actor === this.player) {
        if (actor.selectedBomb && (command.buttons & IN_ATTACK)) this.mode.progressPlant(actor, this.dt, now, events.mode);
        else if (actor === this.mode.bomb.carrier) this.mode.cancelPlant();
        if (command.buttons & IN_USE) this.mode.progressDefuse(actor, this.dt, events.mode);
        else this.mode.cancelDefuse(actor);
      }
      // 功能：空枪位路过掉落武器时自动拾取，符合原版触碰拾枪操作。时间：2026-09-29；作者：lq。
      if (this.mode.phase === 'live') this.pickupNearestWeapon(actor, now, false);

      // ---- 3. weapons
      // 功能：手持手雷时左键投掷，屏蔽当前枪械的射击输入。时间：2026-09-29；作者：lq。
      const attackPressed = (command.buttons & IN_ATTACK) !== 0;
      const grenadeWasSelected = actor.selectedGrenade !== null;
      if (actor.selectedGrenade && attackPressed && !actor.grenadeAttackHeld && this.mode.phase === 'live') {
        const kind = actor.selectedGrenade;
        if (actor.grenades[kind] > 0 && !actor.grenadeAction) {
          // 功能：先播放拔销动作，再在动作结束时生成飞行手雷。时间：2026-09-29；作者：lq。
          actor.grenadeAction = 'pullpin';
          actor.grenadeActionEndTime = now + 0.55;
        }
        actor.grenadeAttackHeld = true;
      }
      // 功能：拔销完成后可持雷等待，松开左键才生成带初速度的可见手雷；投掷动画结束再切回枪。时间：2026-09-29；作者：lq。
      if (actor.grenadeAction === 'pullpin' && now >= actor.grenadeActionEndTime) actor.grenadeAction = 'hold';
      if (actor.grenadeAction === 'hold' && !attackPressed && actor.selectedGrenade) {
        const kind = actor.selectedGrenade;
        // 功能：用原版投掷公式和出生点碰撞检测，贴墙投掷不会把手雷生成在墙内。时间：2026-09-30；作者：lq。
        const eye = actorEye(actor);
        const launch = grenadeLaunch(eye, command.pitch, command.yaw, actor.move.velocity);
        const spawnTrace = this.world.traceHull(POINT_HULL, eye, launch.position);
        const position = spawnTrace.fraction < 1
          ? v3(spawnTrace.endpos.x + spawnTrace.normal.x, spawnTrace.endpos.y + spawnTrace.normal.y, spawnTrace.endpos.z + spawnTrace.normal.z)
          : launch.position;
        this.grenadeProjectiles.push({
          id: this.nextGrenadeId++, kind, position, thrower: actor,
          velocity: launch.velocity,
          // 功能：原版高爆/闪光投出后 1.5 秒引爆，烟雾弹延长至 3 秒。时间：2026-09-30；作者：lq。
          detonateAt: now + (kind === 'smokegrenade' ? 3 : GRENADE_FUSE), lastBounceAt: -99,
        });
        // 功能：本地无限手雷不消耗，普通角色仍按库存逐枚扣除。时间：2026-09-30；作者：lq。
        if (Number.isFinite(actor.grenades[kind])) actor.grenades[kind]--;
        actor.grenadeAction = 'throw';
        actor.grenadeActionEndTime = now + 0.35;
      } else if (actor.grenadeAction === 'throw' && now >= actor.grenadeActionEndTime) {
        actor.grenadeAction = null;
        actor.grenadeActionEndTime = 0;
        actor.selectedGrenade = null;
      }
      // 功能：投雷按键保持按下时持续阻止枪械误开火，松开后恢复枪械输入。时间：2026-09-29；作者：lq。
      const blockGunAttack = grenadeWasSelected || actor.grenadeAttackHeld || bombWasSelected || (command.buttons & IN_USE) !== 0;
      if (!attackPressed) actor.grenadeAttackHeld = false;
      const combatEvents: CombatEvents = actor.combat.tick(
        {
          eye: actorEye(actor),
          pitch: command.pitch,
          yaw: command.yaw,
          speed: actorSpeed(actor),
          onGround: actor.move.onground,
          ducked: actor.move.ducked,
        },
        this.world,
        blockGunAttack ? command.buttons & ~(IN_ATTACK | IN_ATTACK2) : command.buttons,
        now,
        this.dt,
      );
      actor.punch = combatEvents.punch;
      // 功能：手动与自动换弹共用同一事件，避免仅模型换弹而音效缺失。时间：2026-09-29；作者：lq。
      if (combatEvents.reloadStarted) events.reloads.push({ actor, weapon: combatEvents.reloadStarted });

      if (combatEvents.shots.length > 0) {
        actor.lastShotAt = now;
        const weapon = WEAPONS[actor.combat.current().id];
        this.notifyNoise(actor, events);
        void weapon;
      }

      for (const shot of combatEvents.shots) {
        const resolved = this.resolveShot(actor, shot, events, now);
        events.shots.push(resolved);
      }
    }

    return events;
  }

  /** Lets nearby enemies hear a shot and come looking. */
  private notifyNoise(shooter: Actor, events: MatchEvents): void {
    const weapon = WEAPONS[shooter.combat.current().id];
    events.noises.push({
      name: weapon.sounds.fire,
      position: v3(shooter.move.origin.x, shooter.move.origin.y, shooter.move.origin.z),
    });

    for (const actor of this.actors) {
      if (!actor.alive || actor.team === shooter.team) continue;
      const brain = this.brains.get(actor.id);
      if (!brain) continue;
      const distance = Math.hypot(
        actor.move.origin.x - shooter.move.origin.x,
        actor.move.origin.y - shooter.move.origin.y,
      );
      if (distance < 2200) {
        brain.hearNoise(shooter.move.origin);
      }
    }
  }

  /** Traces one bullet against actors, then applies damage. */
  private resolveShot(shooter: Actor, shot: ShotEvent, events: MatchEvents, now: number): ResolvedShot {
    const direction = v3(
      shot.end.x - shot.start.x,
      shot.end.y - shot.start.y,
      shot.end.z - shot.start.z,
    );
    const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
    direction.x /= length;
    direction.y /= length;
    direction.z /= length;

    const worldDistance = length;
    const actorHit = traceActors(shot.start, direction, this.actors, worldDistance, shooter);
    const weapon = WEAPONS[shot.weapon];

    if (!actorHit || actorHit.actor.team === shooter.team) {
      return { shooter, shot, victim: null, damage: 0, killed: false, headshot: false };
    }

    const { actor: victim, hit } = actorHit;
    const headshot = hit.group === 'head';
    // 功能：子弹命中人物时使用人物表面位置计算衰减和特效终点，避免穿透到背后墙面。时间：2026-09-29；作者：lq。
    shot.end = hit.point;
    shot.hit = false;
    shot.distance = hit.distance;
    const raw = weapon.damage * Math.pow(weapon.rangeModifier, hit.distance / 500) * weapon.hitgroups[hit.group];
    const result = damageActor(victim, raw, weapon.armorRatio);

    if (result.killed) {
      // 功能：记录中弹致死的时刻，让尸体从死亡动作起点播放并留至下回合。时间：2026-09-29；作者：lq。
      victim.diedAt = now;
      this.dropOnDeath(victim, now);
      shooter.kills++;
      this.mode.registerKill(shooter, victim, weapon.name, headshot, now);
      this.mode.payKill(shooter, events.mode);
      events.noises.push({
        name: ['sound/player/headshot1.wav', 'sound/player/bhit_flesh-1.wav'],
        position: v3(victim.move.origin.x, victim.move.origin.y, victim.move.origin.z),
      });
    }

    return {
      shooter,
      shot,
      victim,
      damage: result.damage,
      killed: result.killed,
      headshot,
    };
  }
}

// Imported at the bottom to keep the module graph acyclic for the test runner.
import { pmPlayerMove } from './movement.ts';

/** Convenience for tests: a command that walks straight ahead. */
export function forwardCommand(yaw: number): ActorCommand {
  return {
    buttons: IN_FORWARD,
    forwardmove: 400,
    sidemove: 0,
    upmove: 0,
    yaw,
    pitch: 0,
  };
}

/** Convenience for tests: a command that stands still. */
export function idleCommand(yaw: number): ActorCommand {
  return { buttons: 0, forwardmove: 0, sidemove: 0, upmove: 0, yaw, pitch: 0 };
}

export { aimDirection, IN_MOVELEFT, IN_MOVERIGHT };
