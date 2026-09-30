/**
 * Round logic: freeze time, live round, bomb plant/defuse, economy, score.
 *
 * The mode owns no rendering and no physics: it is told about the actors each
 * tick and returns what happened, which keeps it testable headlessly (the tests
 * drive whole rounds with no browser involved).
 */

import type { Vec3 } from '../engine/math.ts';
import { v3 } from '../engine/math.ts';
import type { ObjectiveArea } from './objectives.ts';
import { insideArea } from './objectives.ts';
import type { Actor, Team } from './actors.ts';
import { WEAPONS } from './weapons.ts';
import type { WeaponId } from './weapons.ts';
import { makeWeaponRuntime } from './combat.ts';

export type RoundPhase = 'warmup' | 'freeze' | 'live' | 'over';
export type BombState = 'carried' | 'dropped' | 'planted' | 'defused' | 'exploded';

export interface KillFeedEntry {
  killer: string;
  victim: string;
  weapon: string;
  headshot: boolean;
  at: number;
}

export interface RoundEvents {
  roundStarted: number | null;
  roundEnded: { winner: Team | 'draw'; reason: string } | null;
  killFeed: KillFeedEntry[];
  bombPlanted: { site: string; position: Vec3 } | null;
  bombDefused: boolean;
  bombExploded: boolean;
  /** Money awarded this tick, for the HUD. */
  moneyAwards: { actor: Actor; amount: number; reason: string }[];
}

export interface GameModeOptions {
  /** Seconds of warmup before the first round. */
  warmupTime?: number;
  /** Seconds of freeze time before the round goes live. */
  freezeTime?: number;
  /** 功能：实战回合时长，默认 3 分钟，可显式覆盖。时间：2026-09-30；作者：lq。 */
  roundTime?: number;
  /** Bomb fuse in seconds. */
  bombTime?: number;
  /** Defuse time, with and without a kit. */
  defuseTime?: number;
  defuseTimeWithKit?: number;
  /** 功能：原版 C4 按住攻击键约三秒完成安装。时间：2026-09-30；作者：lq。 */
  plantTime?: number;
  /** Rounds needed to win the match. */
  roundsToWin?: number;
}

const START_MONEY = 800;
const MAX_MONEY = 16000;
// 功能：将默认实战回合从 5 分钟缩短到 3 分钟；玩家阵亡后继续观战，回合按正常胜负结束。时间：2026-09-30；作者：lq。
const DEFAULT_ROUND_TIME = 180;
const KILL_REWARD = 300;
const WIN_REWARD = 3250;
const LOSS_REWARD = 1400;
const PLANT_REWARD = 300;
const DEFUSE_REWARD = 300;
/** Extra reward per consecutive loss, as in CS. */
const LOSS_BONUS_STEP = 500;
const MAX_LOSS_BONUS = 3;
/** 功能：原版 CT 必须在 C4 周围约 75 单位内持续使用才能拆除。时间：2026-09-30；作者：lq。 */
export const DEFUSE_RADIUS = 75;

export interface BuyItem {
  id: string;
  label: string;
  price: number;
  category: 'pistols' | 'shotguns' | 'smgs' | 'rifles' | 'machinegun' | 'equipment';
  weapon?: WeaponId;
  slot?: 1 | 2 | 3;
  armor?: number;
  kit?: boolean;
  grenade?: 'hegrenade' | 'flashbang' | 'smokegrenade';
}

export type BuyCategory = BuyItem['category'];

/** 功能：按 CS 1.5 数字购买顺序映射不同阵营商品，支持 B31、B42 与 B83/B84/B85。时间：2026-09-29；作者：lq。 */
export function buyMenuOptions(team: Team, category: BuyCategory): { digit: number; item: BuyItem }[] {
  const shared: Record<BuyCategory, (string | null)[]> = {
    pistols: ['glock18', 'usp45', 'p228', 'deagle', 'elite', 'fiveseven'],
    shotguns: ['m3', 'xm1014'],
    smgs: ['mp5navy', team === 'ct' ? 'tmp' : 'mac10', 'ump45', 'p90'],
    rifles: ['scout', team === 'ct' ? 'm4a1' : 'ak47', team === 'ct' ? 'aug' : 'sg552', 'awp', team === 'ct' ? 'sg550' : 'g3sg1'],
    machinegun: ['m249'],
    equipment: ['kevlar', 'armor', 'flashbang', 'hegrenade', 'smokegrenade', null, team === 'ct' ? 'defusekit' : null],
  };
  return shared[category].flatMap((id, index) => {
    const item = id ? BUY_MENU.find((entry) => entry.id === id) : null;
    return item ? [{ digit: index + 1, item }] : [];
  });
}

/** 功能：列出 CS 1.5 原版可购枪械、护甲与三种手雷，供分类购买菜单使用。时间：2026-09-29；作者：lq。 */
export const BUY_MENU: BuyItem[] = [
  { id: 'glock18', label: 'Glock 18', price: 400, category: 'pistols', weapon: 'glock18', slot: 2 },
  { id: 'usp45', label: 'USP .45', price: 500, category: 'pistols', weapon: 'usp45', slot: 2 },
  { id: 'p228', label: 'P228', price: 600, category: 'pistols', weapon: 'p228', slot: 2 },
  { id: 'deagle', label: 'Desert Eagle', price: 650, category: 'pistols', weapon: 'deagle', slot: 2 },
  { id: 'elite', label: 'Dual Berettas', price: 800, category: 'pistols', weapon: 'elite', slot: 2 },
  { id: 'fiveseven', label: 'Five-SeveN', price: 750, category: 'pistols', weapon: 'fiveseven', slot: 2 },
  { id: 'm3', label: 'M3', price: 1700, category: 'shotguns', weapon: 'm3', slot: 1 },
  { id: 'xm1014', label: 'XM1014', price: 3000, category: 'shotguns', weapon: 'xm1014', slot: 1 },
  { id: 'mac10', label: 'MAC-10', price: 1400, category: 'smgs', weapon: 'mac10', slot: 1 },
  { id: 'tmp', label: 'TMP', price: 1250, category: 'smgs', weapon: 'tmp', slot: 1 },
  { id: 'mp5navy', label: 'MP5 Navy', price: 1500, category: 'smgs', weapon: 'mp5navy', slot: 1 },
  { id: 'ump45', label: 'UMP45', price: 1700, category: 'smgs', weapon: 'ump45', slot: 1 },
  { id: 'p90', label: 'P90', price: 2350, category: 'smgs', weapon: 'p90', slot: 1 },
  { id: 'ak47', label: 'AK-47', price: 2500, category: 'rifles', weapon: 'ak47', slot: 1 },
  { id: 'm4a1', label: 'M4A1', price: 3100, category: 'rifles', weapon: 'm4a1', slot: 1 },
  { id: 'aug', label: 'AUG', price: 3500, category: 'rifles', weapon: 'aug', slot: 1 },
  { id: 'sg552', label: 'SG552', price: 3500, category: 'rifles', weapon: 'sg552', slot: 1 },
  { id: 'scout', label: 'Scout', price: 2750, category: 'rifles', weapon: 'scout', slot: 1 },
  { id: 'awp', label: 'AWP', price: 4750, category: 'rifles', weapon: 'awp', slot: 1 },
  { id: 'g3sg1', label: 'G3SG1', price: 5000, category: 'rifles', weapon: 'g3sg1', slot: 1 },
  { id: 'sg550', label: 'SG550', price: 4200, category: 'rifles', weapon: 'sg550', slot: 1 },
  { id: 'm249', label: 'M249', price: 5750, category: 'machinegun', weapon: 'm249', slot: 1 },
  { id: 'kevlar', label: 'Kevlar', price: 650, category: 'equipment', armor: 80 },
  { id: 'armor', label: 'Kevlar + Helmet', price: 1000, category: 'equipment', armor: 100 },
  { id: 'hegrenade', label: 'HE Grenade', price: 300, category: 'equipment', grenade: 'hegrenade' },
  { id: 'flashbang', label: 'Flashbang', price: 200, category: 'equipment', grenade: 'flashbang' },
  { id: 'smokegrenade', label: 'Smoke Grenade', price: 300, category: 'equipment', grenade: 'smokegrenade' },
  { id: 'defusekit', label: 'Defuse Kit', price: 200, category: 'equipment', kit: true },
];

export class GameMode {
  phase: RoundPhase = 'warmup';
  round = 0;
  score: Record<Team, number> = { ct: 0, t: 0 };
  timeLeft = 0;
  bombTimeLeft = 0;
  /** Consecutive losses per team, for the loss bonus. */
  lossStreak: Record<Team, number> = { ct: 0, t: 0 };
  bomb: {
    state: BombState;
    carrier: Actor | null;
    position: Vec3 | null;
    planter: Actor | null;
    defuser: Actor | null;
    defuseProgress: number;
    plantProgress: number;
    siteName: string;
  } = {
    state: 'carried',
    carrier: null,
    position: null,
    planter: null,
    defuser: null,
    defuseProgress: 0,
    plantProgress: 0,
    siteName: '',
  };
  readonly killFeed: KillFeedEntry[] = [];
  matchOver = false;
  winner: Team | 'draw' | null = null;

  private readonly options: Required<GameModeOptions>;
  private readonly sites: ObjectiveArea[];

  constructor(sites: ObjectiveArea[], options: GameModeOptions = {}) {
    this.sites = sites;
    this.options = {
      warmupTime: options.warmupTime ?? 3,
      freezeTime: options.freezeTime ?? 5,
      roundTime: options.roundTime ?? DEFAULT_ROUND_TIME,
      bombTime: options.bombTime ?? 35,
      defuseTime: options.defuseTime ?? 10,
      defuseTimeWithKit: options.defuseTimeWithKit ?? 5,
      plantTime: options.plantTime ?? 3,
      roundsToWin: options.roundsToWin ?? 16,
    };
    this.phase = 'warmup';
    this.timeLeft = this.options.warmupTime;
  }

  get sitesList(): ObjectiveArea[] {
    return this.sites;
  }

  private emptyEvents(): RoundEvents {
    return {
      roundStarted: null,
      roundEnded: null,
      killFeed: [],
      bombPlanted: null,
      bombDefused: false,
      bombExploded: false,
      moneyAwards: [],
    };
  }

  private award(events: RoundEvents, actor: Actor, amount: number, reason: string): void {
    if (actor.unlimitedFunds) {
      events.moneyAwards.push({ actor, amount: 0, reason });
      return;
    }
    const before = actor.money;
    actor.money = Math.min(MAX_MONEY, actor.money + amount);
    events.moneyAwards.push({ actor, amount: actor.money - before, reason });
  }

  /** Records a kill, pays the killer and prints to the feed. */
  registerKill(killer: Actor | null, victim: Actor, weapon: string, headshot: boolean, now: number): void {
    this.killFeed.unshift({
      killer: killer ? killer.name : '世界',
      victim: victim.name,
      weapon,
      headshot,
      at: now,
    });
    if (this.killFeed.length > 5) this.killFeed.pop();
  }

  /** Called from the shot handler when a bullet kills someone. */
  payKill(killer: Actor | null, events: RoundEvents): void {
    if (killer) this.award(events, killer, KILL_REWARD, 'kill');
  }

  /** Starts a fresh round: positions, money, bomb carrier. */
  startRound(actors: Actor[], spawns: { ct: Vec3[]; t: Vec3[] }, now: number, events: RoundEvents): void {
    this.round++;
    this.phase = 'freeze';
    this.timeLeft = this.options.freezeTime;
    this.bomb = {
      state: 'carried',
      carrier: null,
      position: null,
      planter: null,
      defuser: null,
      defuseProgress: 0,
      plantProgress: 0,
      siteName: '',
    };

    const counters: Record<Team, number> = { ct: 0, t: 0 };
    for (const actor of actors) {
      const survived = actor.alive;
      // 功能：阵亡者下一局只带阵营初始手枪，已掉落的枪不再凭空回到玩家或 BOT 身上。时间：2026-09-29；作者：lq。
      if (!survived) {
        actor.combat.loadout[1] = makeWeaponRuntime('knife');
        // 功能：玩家下一回合复活仍携带“小白银”P228，BOT 保留 CS 1.5 双方默认手枪。时间：2026-09-30；作者：lq。
        actor.combat.loadout[2] = makeWeaponRuntime(actor.unlimitedFunds ? 'p228' : actor.team === 'ct' ? 'usp45' : 'glock18');
        actor.combat.selectSlot(2, now);
      }
      const list = spawns[actor.team];
      const spawn = list.length > 0 ? list[counters[actor.team]++ % list.length]! : actor.move.origin;
      actor.move.origin = v3(spawn.x, spawn.y, spawn.z);
      actor.move.velocity = v3(0, 0, 0);
      actor.move.onground = true;
      // 功能：每回合开始恢复玩家双倍血量 200，BOT 保持 100。时间：2026-09-30；作者：lq。
      actor.health = actor.isBot ? 100 : 200;
      // 功能：阵亡者下一局重新购买护甲，存活者保留原有护甲。时间：2026-09-29；作者：lq。
      if (!survived) actor.armor = 0;
      actor.alive = true;
      // 功能：每局复活清除上一局阵亡时间，尸体只保留在当前回合。时间：2026-09-29；作者：lq。
      actor.diedAt = -99;
      actor.punch = { pitch: 0, yaw: 0 };
      // 功能：新回合重置手雷动作与当前选择，避免阵亡时的拔销状态延续到下一回合。时间：2026-09-29；作者：lq。
      actor.selectedGrenade = null;
      actor.grenadeAction = null;
      actor.grenadeActionEndTime = 0;
      actor.grenadeAttackHeld = false;
      // 功能：新回合重新发放 C4 并重置拆弹器。时间：2026-09-30；作者：lq。
      actor.selectedBomb = false;
      actor.hasDefuseKit = false;
      // Face the middle of the map.
      actor.yaw = (Math.atan2(-spawn.y, -spawn.x) * 180) / Math.PI;
      for (const slot of [1, 2, 3] as const) {
        const runtime = actor.combat.loadout[slot];
        const def = WEAPONS[runtime.id];
        runtime.ammo = Number.isFinite(def.magSize) ? def.magSize : 1;
        // 功能：本地玩家每回合自动补齐三种经典手雷，并保持备用弹药无限。时间：2026-09-30；作者：lq。
        if (actor.unlimitedAmmo) runtime.reserve = Infinity;
        runtime.reloadEndTime = 0;
        runtime.deployEndTime = 0;
        runtime.nextFireTime = 0;
        runtime.shotIndex = 0;
        runtime.scoped = false;
        runtime.zoomLevel = 0;
      }
      // 功能：本地玩家每回合拥有无限高爆、闪光与烟雾弹，无需投掷后重新购买。时间：2026-09-30；作者：lq。
      if (actor.unlimitedFunds) {
        actor.grenades.hegrenade = Infinity;
        actor.grenades.flashbang = Infinity;
        actor.grenades.smokegrenade = Infinity;
      }
    }

    const terrorists = actors.filter((actor) => actor.team === 't');
    if (terrorists.length > 0) {
      // 功能：玩家选择 T 时优先携带 C4，以便亲自执行原版安装操作。时间：2026-09-30；作者：lq。
      this.bomb.carrier = terrorists.find((actor) => !actor.isBot) ?? terrorists[Math.floor(Math.random() * terrorists.length)]!;
    }

    events.roundStarted = this.round;
    void now;
  }

  /** Tick the round. Returns everything that happened this tick. */
  update(dt: number, actors: Actor[], now: number): RoundEvents {
    const events = this.emptyEvents();
    if (this.matchOver) return events;

    const aliveCT = actors.filter((actor) => actor.team === 'ct' && actor.alive).length;
    const aliveT = actors.filter((actor) => actor.team === 't' && actor.alive).length;

    switch (this.phase) {
      case 'warmup': {
        this.timeLeft -= dt;
        if (this.timeLeft <= 0) {
          this.startRound(actors, this.lastSpawns, now, events);
        }
        return events;
      }

      case 'freeze': {
        this.timeLeft -= dt;
        if (this.timeLeft <= 0) {
          this.phase = 'live';
          this.timeLeft = this.options.roundTime;
        }
        return events;
      }

      case 'live': {
        // The bomb, when planted, replaces the round clock.
        if (this.bomb.state === 'planted') {
          this.bombTimeLeft -= dt;
          if (this.bombTimeLeft <= 0) {
            this.bomb.state = 'exploded';
            events.bombExploded = true;
            this.endRound('t', '炸弹爆炸', events);
            return events;
          }
        } else {
          this.timeLeft -= dt;
          if (this.timeLeft <= 0) {
            this.endRound('ct', '时间到', events);
            return events;
          }
        }

        // Elimination.
        if (aliveT === 0 && this.bomb.state !== 'planted') {
          this.endRound('ct', '消灭所有恐怖分子', events);
          return events;
        }
        if (aliveCT === 0) {
          this.endRound('t', '消灭所有反恐精英', events);
          return events;
        }
        return events;
      }

      case 'over': {
        this.timeLeft -= dt;
        if (this.timeLeft <= 0) {
          if (this.score.ct >= this.options.roundsToWin || this.score.t >= this.options.roundsToWin) {
            this.matchOver = true;
            this.winner = this.score.ct > this.score.t ? 'ct' : this.score.t > this.score.ct ? 't' : 'draw';
          } else {
            this.startRound(actors, this.lastSpawns, now, events);
          }
        }
        return events;
      }

      default:
        return events;
    }
  }

  private lastSpawns: { ct: Vec3[]; t: Vec3[] } = { ct: [], t: [] };

  /** Remembers the spawn lists so rounds can be restarted from update(). */
  setSpawns(spawns: { ct: Vec3[]; t: Vec3[] }): void {
    this.lastSpawns = spawns;
  }

  private endRound(winner: Team | 'draw', reason: string, events: RoundEvents): void {
    this.phase = 'over';
    this.timeLeft = 5;
    events.roundEnded = { winner, reason };

    if (winner === 'draw') return;
    this.score[winner] += 1;
    const loser: Team = winner === 'ct' ? 't' : 'ct';
    this.lossStreak[winner] = 0;
    this.lossStreak[loser] = Math.min(MAX_LOSS_BONUS, this.lossStreak[loser] + 1);

    for (const actor of this.lastActors) {
      if (actor.team === winner) this.award(events, actor, WIN_REWARD, 'win');
      else this.award(events, actor, LOSS_REWARD + this.lossStreak[loser] * LOSS_BONUS_STEP - LOSS_BONUS_STEP, 'loss');
    }
  }

  private lastActors: Actor[] = [];

  /** Keeps a reference to the roster so end-of-round rewards can be paid. */
  setActors(actors: Actor[]): void {
    this.lastActors = actors;
  }

  /** True when an actor stands inside a bombsite with the bomb. */
  bombsiteAt(position: Vec3): ObjectiveArea | null {
    for (const site of this.sites) {
      if (insideArea(site, position, 0)) return site;
    }
    return null;
  }

  /** 功能：持续装包满三秒才启动引信，离开包点或松开按键会清零进度。时间：2026-09-30；作者：lq。 */
  progressPlant(actor: Actor, dt: number, now: number, events: RoundEvents): boolean {
    if (!actor.alive || actor.team !== 't' || this.phase !== 'live' || this.bomb.state !== 'carried' || this.bomb.carrier !== actor || !this.bombsiteAt(actor.move.origin) || !actor.move.onground) {
      this.bomb.plantProgress = 0;
      return false;
    }
    this.bomb.plantProgress += dt / this.options.plantTime;
    if (this.bomb.plantProgress < 1) return false;
    return this.tryPlant(actor, now, events);
  }

  /** 功能：松开装包键即取消尚未完成的安装。时间：2026-09-30；作者：lq。 */
  cancelPlant(): void { this.bomb.plantProgress = 0; }

  /** 功能：持包者阵亡时 C4 留在地面，其他存活 T 靠近后可重新拾取。时间：2026-09-30；作者：lq。 */
  dropBomb(): void {
    const carrier = this.bomb.carrier;
    if (this.bomb.state !== 'carried' || !carrier || carrier.alive) return;
    this.bomb.position = v3(carrier.move.origin.x, carrier.move.origin.y, carrier.move.origin.z - 34);
    this.bomb.carrier = null;
    this.bomb.state = 'dropped';
    this.bomb.plantProgress = 0;
    carrier.selectedBomb = false;
  }

  /** 功能：T 接触地面 C4 自动拾取，恢复可安装状态。时间：2026-09-30；作者：lq。 */
  pickupBomb(actor: Actor): boolean {
    if (!actor.alive || actor.team !== 't' || this.bomb.state !== 'dropped' || !this.bomb.position) return false;
    if (Math.hypot(actor.move.origin.x - this.bomb.position.x, actor.move.origin.y - this.bomb.position.y) > 48) return false;
    this.bomb.state = 'carried';
    this.bomb.carrier = actor;
    this.bomb.position = null;
    // 功能：拾起地面 C4 后立即切换到 C4，符合原版触碰拾包体验。时间：2026-09-30；作者：lq。
    actor.selectedBomb = true;
    return true;
  }

  /** Tries to plant; returns true when the bomb is now ticking. */
  tryPlant(actor: Actor, now: number, events: RoundEvents): boolean {
    if (!actor.alive || actor.team !== 't' || this.bomb.state !== 'carried' || this.bomb.carrier !== actor) return false;
    if (this.phase !== 'live') return false;
    const site = this.bombsiteAt(actor.move.origin);
    if (!site) return false;

    this.bomb.state = 'planted';
    this.bomb.plantProgress = 0;
    actor.selectedBomb = false;
    this.bomb.position = v3(actor.move.origin.x, actor.move.origin.y, actor.move.origin.z - 36);
    this.bomb.planter = actor;
    this.bomb.siteName = site.name;
    this.bombTimeLeft = this.options.bombTime;
    this.award(events, actor, PLANT_REWARD, 'plant');
    events.bombPlanted = { site: site.name, position: this.bomb.position };
    void now;
    return true;
  }

  /** 功能：中断拆包时重置进度，普通拆包十秒、带拆弹器五秒。时间：2026-09-30；作者：lq。 */
  cancelDefuse(actor?: Actor): void {
    if (!actor || this.bomb.defuser === actor) {
      this.bomb.defuser = null;
      this.bomb.defuseProgress = 0;
    }
  }

  /** Advances a defuse; the bomb is defused once progress reaches 1. */
  progressDefuse(actor: Actor, dt: number, events: RoundEvents): boolean {
    if (!actor.alive || actor.team !== 'ct' || this.phase !== 'live' || this.bomb.state !== 'planted') return false;
    const distance = this.bomb.position
      ? Math.hypot(
          actor.move.origin.x - this.bomb.position.x,
          actor.move.origin.y - this.bomb.position.y,
          actor.move.origin.z - this.bomb.position.z,
        )
      : Infinity;
    if (distance > DEFUSE_RADIUS) {
      this.cancelDefuse(actor);
      return false;
    }

    if (this.bomb.defuser !== actor) this.bomb.defuseProgress = 0;
    this.bomb.defuser = actor;
    const duration = actor.hasDefuseKit ? this.options.defuseTimeWithKit : this.options.defuseTime;
    this.bomb.defuseProgress += dt / duration;
    if (this.bomb.defuseProgress >= 1) {
      this.bomb.state = 'defused';
      this.award(events, actor, DEFUSE_REWARD, 'defuse');
      events.bombDefused = true;
      this.endRound('ct', '炸弹已拆除', events);
      return true;
    }
    return false;
  }

  /** Buys an item during freeze time. */
  buy(actor: Actor, itemId: string): boolean {
    // Buying is allowed during warmup, freeze time and the live round (but not
    // after the match is decided).
    if (this.phase === 'over') return false;
    const item = BUY_MENU.find((entry) => entry.id === itemId);
    if (!item) return false;
    // 功能：拆弹器仅反恐精英可购，枪械和手雷则按本地无限资金要求自由购买。时间：2026-09-29；作者：lq。
    if (item.kit && actor.team !== 'ct') return false;
    if (!actor.unlimitedFunds && actor.money < item.price) return false;

    if (!actor.unlimitedFunds) actor.money -= item.price;
    // 功能：购买拆弹器后立即生效，下一回合需重新购入。时间：2026-09-30；作者：lq。
    if (item.kit) { actor.hasDefuseKit = true; return true; }
    if (item.grenade) {
      // 功能：手雷可重复购买，库存独立于主武器和副武器。时间：2026-09-29；作者：lq。
      actor.grenades[item.grenade]++;
      return true;
    }
    if (item.armor) {
      actor.armor = item.armor;
      return true;
    }
    if (item.weapon && item.slot) {
      const runtime = actor.combat.loadout[item.slot];
      const def = WEAPONS[item.weapon];
      runtime.id = item.weapon;
      runtime.ammo = Number.isFinite(def.magSize) ? def.magSize : 1;
      // 功能：本地玩家购买新枪后立即获得无限备用弹药，不必等下一次模拟 tick 刷新。时间：2026-09-30；作者：lq。
      runtime.reserve = actor.unlimitedAmmo ? Infinity : Math.max(def.magSize * 3, 30);
      runtime.reloadEndTime = 0;
      runtime.deployEndTime = 0;
      runtime.shotIndex = 0;
      return true;
    }
    return true;
  }

  /** 功能：B6/B7 按原版购买主副武器备用弹药，尊重弹药上限与经济。时间：2026-09-29；作者：lq。 */
  buyAmmo(actor: Actor, slot: 1 | 2): boolean {
    if (this.phase === 'over') return false;
    const runtime = actor.combat.loadout[slot];
    const size = WEAPONS[runtime.id].magSize;
    if (!Number.isFinite(size) || runtime.reserve >= size * 3) return false;
    const price = slot === 1 ? 60 : 20;
    if (!actor.unlimitedFunds && actor.money < price) return false;
    if (!actor.unlimitedFunds) actor.money -= price;
    runtime.reserve = Math.min(size * 3, runtime.reserve + size);
    return true;
  }
}

export { START_MONEY, MAX_MONEY, KILL_REWARD };
