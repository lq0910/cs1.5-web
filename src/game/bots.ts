/**
 * Bot brains.
 *
 * Bots drive the *same* movement and weapon code as the player; the brain only
 * decides a command each tick (move/look/fire) and hands it to the simulation.
 * Everything that makes a bot feel human lives here:
 *
 *   - vision: field of view + line of sight + a distance limit;
 *   - reaction time: it does not shoot on the first frame it sees you;
 *   - aim: the view turns at a limited rate, with an error that settles over
 *     time, and the weapon's own accuracy cone (movement, spray) still applies;
 *   - burst discipline: rifles fire in bursts instead of emptying the magazine;
 *   - navigation: A* path following, with a stuck detector that jogs and jumps.
 */

import type { Vec3 } from '../engine/math.ts';
import { v3 } from '../engine/math.ts';
// 功能：用玩家碰撞体校验网格终点到掉落 C4 的最后一段路。时间：2026-10-09；作者：lq。
import { HULL_STANDING } from '../engine/collision/types.ts';
import type { CollisionWorld } from '../engine/collision/types.ts';
import type { NavGraph, PathResult } from './nav.ts';
import { findPath, randomNodeNear } from './nav.ts';
import type { Actor } from './actors.ts';
import { actorEye, hasLineOfSight } from './actors.ts';
import { WEAPONS } from './weapons.ts';
import {
  IN_FORWARD,
  IN_JUMP,
  IN_MOVELEFT,
  IN_MOVERIGHT,
  IN_ATTACK,
  IN_WALK,
  CL_FORWARD_SPEED,
  CL_SIDE_SPEED,
} from './constants.ts';

export type BotState = 'idle' | 'advance' | 'engage' | 'reload' | 'plant' | 'defuse' | 'dead';

export interface BotGoal {
  position: Vec3;
  kind: 'site' | 'bomb' | 'patrol' | 'defuse';
}

export interface BotContext {
  world: CollisionWorld;
  graph: NavGraph | null;
  self: Actor;
  enemies: Actor[];
  goal: BotGoal | null;
  now: number;
  /** 0 = easy, 1 = expert: scales aim error and reaction time. */
  skill: number;
  /** Set when the bot is standing inside a bombsite and may plant. */
  canPlant: boolean;
  /** Set when the bot is close enough to a planted bomb to defuse. */
  canDefuse: boolean;
}

export interface BotCommand {
  forwardmove: number;
  sidemove: number;
  buttons: number;
  yaw: number;
  pitch: number;
  state: BotState;
  /** Action the round logic should apply this tick. */
  action: 'none' | 'plant' | 'defuse';
}

// 功能：使用 110 度前方视野，近距离仍可察觉身后敌人。时间：2026-10-10；作者：lq。
const FOV_COS = Math.cos((55 * Math.PI) / 180);
const MAX_VIEW_DISTANCE = 3200;
// 功能：降低 BOT 转身角速度，避免导航路点切换时高速原地旋转。时间：2026-09-30；作者：lq。
const TURN_RATE_DEG = 240;
// 功能：缩小转角路点的通过半径，避免提前切弯撞到门框。时间：2026-10-09；作者：lq。
const WAYPOINT_RADIUS = 24;

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

function normalizeAngle(degrees: number): number {
  let value = degrees;
  while (value > 180) value -= 360;
  while (value < -180) value += 360;
  return value;
}

export class BotBrain {
  state: BotState = 'idle';
  private readonly random: () => number;
  /** 功能：保存本回合独立通道偏好，重规划仍保持自然连续的路线。时间：2026-10-10；作者：lq。 */
  private readonly routeSeed: number;
  private path: PathResult | null = null;
  private pathIndex = 0;
  private repathAt = 0;
  private target: Actor | null = null;
  private targetSeenAt = 0;
  private lastKnownPosition: Vec3 | null = null;
  private aimErrorYaw = 0;
  private aimErrorPitch = 0;
  private nextBurstAt = 0;
  private burstEndsAt = 0;
  /** 功能：半自动武器下一次扣扳机时间，保证两发之间至少有一帧松开攻击键。时间：2026-09-30；作者：lq。 */
  private nextSemiAutoAt = 0;
  private stuckSince = 0;
  /** When the current waypoint was first targeted (to time out bad ones). */
  private waypointSince = 0;
  private waypointSkips = 0;
  /** One hop at a time: a bot must not look like it is on a pogo stick. */
  private nextJumpAt = 0;
  /** Set once the bot is close enough to its objective to hold position. */
  private arrived = false;
  /** How many repaths in a row failed to find a route. */
  private routeFailures = 0;
  private lastPosition: Vec3;
  private strafeUntil = 0;
  private strafeDirection = 1;
  private investigating: Vec3 | null = null;
  /** 功能：分别记录战斗反应和导航目标，防止枪声或发现敌人不断重置进攻路线。时间：2026-10-09；作者：lq。 */
  private reactionReadyAt = 0;
  private navigationGoal: Vec3 | null = null;

  constructor(seed: number, start: Vec3) {
    this.random = mulberry32(seed);
    // 功能：不同机器人和回合使用不同区域偏好。时间：2026-10-10；作者：lq。
    this.routeSeed = seed;
    this.lastPosition = v3(start.x, start.y, start.z);
  }

  /** Snapshot for diagnostics/tests: why is this bot behaving oddly? */
  debugState(): {
    state: BotState;
    arrived: boolean;
    stuckFor: number;
    pathLength: number;
    pathIndex: number;
    goalDistance: number;
  } {
    return {
      state: this.state,
      arrived: this.arrived,
      stuckFor: this.stuckSince === 0 ? 0 : this.lastNow - this.stuckSince,
      pathLength: this.path ? this.path.points.length : 0,
      pathIndex: this.pathIndex,
      goalDistance: this.lastGoalDistance,
    };
  }

  private lastNow = 0;
  private lastGoalDistance = 0;

  /** Called when a shot is heard nearby. */
  hearNoise(position: Vec3): void {
    if (this.state === 'engage') return;
    this.investigating = v3(position.x, position.y, position.z);
    // 功能：有明确包点任务时只记录声音，不打断正在执行的路径。时间：2026-10-09；作者：lq。
    if (!this.navigationGoal) this.repathAt = 0;
  }

  think(dt: number, context: BotContext): BotCommand {
    const { self, now } = context;
    this.lastNow = now;
    const command: BotCommand = {
      forwardmove: 0,
      sidemove: 0,
      buttons: 0,
      yaw: self.yaw,
      pitch: self.pitch,
      state: this.state,
      action: 'none',
    };

    if (!self.alive) {
      this.state = 'dead';
      command.state = 'dead';
      return command;
    }

    // ---- reload when the magazine is empty
    const runtime = self.combat.current();
    const weapon = WEAPONS[runtime.id];
    if (Number.isFinite(weapon.magSize) && runtime.ammo <= 0 && runtime.reloadEndTime === 0) {
      command.buttons |= 1 << 13; // IN_RELOAD
      this.state = 'reload';
    }

    // ---- vision
    const enemies = context.enemies.filter((enemy) => enemy.alive && enemy.team !== self.team);
    const eye = actorEye(self);
    let bestEnemy: Actor | null = null;
    let bestDistance = Infinity;

    for (const enemy of enemies) {
      const target = v3(enemy.move.origin.x, enemy.move.origin.y, enemy.move.origin.z + 4);
      const dx = target.x - eye.x;
      const dy = target.y - eye.y;
      const dz = target.z - eye.z;
      const distance = Math.hypot(dx, dy, dz);
      if (distance > MAX_VIEW_DISTANCE) continue;

      // Field of view: skip enemies behind the bot unless they are very close.
      const yaw = (self.yaw * Math.PI) / 180;
      const forwardX = Math.cos(yaw);
      const forwardY = Math.sin(yaw);
      const length2d = Math.hypot(dx, dy) || 1;
      const toward = (dx / length2d) * forwardX + (dy / length2d) * forwardY;
      if (toward < FOV_COS && distance > 320) continue;

      if (!hasLineOfSight(context.world, eye, target)) continue;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestEnemy = enemy;
      }
    }

    if (bestEnemy && bestEnemy !== this.target) {
      this.target = bestEnemy;
      this.targetSeenAt = now;
      // Reaction time: better bots react faster.
      const reaction = 0.32 - context.skill * 0.2 + this.random() * 0.1;
      // 功能：反应计时独立于寻路计时，保持简单难度的枪法而不降低进攻执行力。时间：2026-10-09；作者：lq。
      this.reactionReadyAt = now + reaction;
    } else if (bestEnemy) {
      this.target = bestEnemy;
    } else {
      this.target = null;
    }

    if (this.target && this.target.alive) {
      this.lastKnownPosition = v3(
        this.target.move.origin.x,
        this.target.move.origin.y,
        this.target.move.origin.z,
      );
    } else if (this.lastKnownPosition && this.investigating === null) {
      // Lost sight: go and check where the enemy was.
      this.investigating = this.lastKnownPosition;
      this.lastKnownPosition = null;
      if (!context.goal) this.repathAt = 0;
    }

    // ---- aiming
    const aimAt = (point: Vec3, speedDeg: number): void => {
      const dx = point.x - eye.x;
      const dy = point.y - eye.y;
      const dz = point.z - eye.z;
      const desiredYaw = (Math.atan2(dy, dx) * 180) / Math.PI;
      const horizontal = Math.hypot(dx, dy);
      const desiredPitch = (-Math.atan2(dz, horizontal) * 180) / Math.PI;

      const maxStep = speedDeg * dt;
      const deltaYaw = normalizeAngle(desiredYaw - command.yaw);
      const deltaPitch = desiredPitch - command.pitch;
      command.yaw += Math.max(-maxStep, Math.min(maxStep, deltaYaw));
      command.pitch += Math.max(-maxStep, Math.min(maxStep, deltaPitch));
    };

    // ---- objectives
    if (context.canPlant && (!this.target || bestDistance > 600)) {
      this.state = 'plant';
      command.state = 'plant';
      command.action = 'plant';
      command.forwardmove = 0;
      command.sidemove = 0;
      return this.finish(command, context, now, dt);
    }
    if (context.canDefuse && (!this.target || bestDistance > 600)) {
      this.state = 'defuse';
      command.state = 'defuse';
      command.action = 'defuse';
      command.forwardmove = 0;
      command.sidemove = 0;
      return this.finish(command, context, now, dt);
    }

    // 功能：持包者和拆包者不因远处敌人永久停下，近距离遭遇仍先自卫。时间：2026-10-10；作者：lq。
    const urgentObjective = context.goal?.kind === 'defuse' || context.goal?.kind === 'site';
    if (this.target && !(urgentObjective && bestDistance > 900)) {
      // Aim error shrinks the longer the bot holds the aim on the target.
      const settle = Math.min(1, (now - this.targetSeenAt) / 0.6);
      const errorScale = (1 - context.skill * 0.85) * 3.4 * (1 - settle * 0.7);
      this.aimErrorYaw += (this.random() - 0.5) * errorScale * dt * 12;
      this.aimErrorPitch += (this.random() - 0.5) * errorScale * dt * 12;
      this.aimErrorYaw *= 1 - Math.min(1, dt * 3);
      this.aimErrorPitch *= 1 - Math.min(1, dt * 3);

      const target = this.target;
      const chest = v3(target.move.origin.x, target.move.origin.y, target.move.origin.z + 2);
      aimAt(
        v3(chest.x + Math.sin((this.aimErrorYaw * Math.PI) / 180) * 40, chest.y, chest.z + this.aimErrorPitch * 8),
        TURN_RATE_DEG,
      );

      this.state = 'engage';
      command.state = 'engage';

      // Fire when settled and the reaction time has passed.
      const aimError = Math.hypot(this.aimErrorYaw, this.aimErrorPitch);
      const ready = now > this.reactionReadyAt && aimError < 2.2 + context.skill * 2;
      if (ready && runtime.reloadEndTime === 0) {
        if (weapon.automatic) {
          if (now > this.nextBurstAt) {
            this.burstEndsAt = now + 0.22 + this.random() * 0.25;
            this.nextBurstAt = this.burstEndsAt + 0.18 + this.random() * 0.35;
          }
          if (now < this.burstEndsAt) command.buttons |= IN_ATTACK;
        } else {
          // 功能：BOT 的手枪和狙击枪按原版半自动方式点击射击，避免持续按住左键只打出第一发。时间：2026-09-30；作者：lq。
          if (now >= this.nextSemiAutoAt) {
            command.buttons |= IN_ATTACK;
            this.nextSemiAutoAt = now + Math.max(weapon.cycleTime + dt, dt * 2);
          }
        }
      }

      // 功能：保留轻微横移节奏但让身体转向同步移动方向，避免固定朝敌人侧身平移。时间：2026-09-30；作者：lq。
      if (now > this.strafeUntil) {
        this.strafeUntil = now + 0.4 + this.random() * 0.7;
        this.strafeDirection = this.random() < 0.5 ? -1 : 1;
      }
      if (bestDistance > 500) {
        // Close the gap when far away, but stop to shoot when close.
        command.forwardmove = this.random() < 0.6 ? 0 : CL_FORWARD_SPEED * 0.5;
      } else if (this.random() < 0.7) {
        command.forwardmove = 0;
      }
      // 功能：第三人称原版玩家模型只有前进步态，交火时取消大幅侧移，避免枪口朝向与脚步方向不一致产生飘移感。时间：2026-09-30；作者：lq。
      command.sidemove = 0;
      void this.strafeDirection;
      return this.finish(command, context, now, dt);
    }

    // ---- navigation
    let goalPosition = context.goal?.position ?? this.investigating;
    if (!goalPosition) {
      if (this.state !== 'advance' || !this.path) {
        const graph = context.graph;
        const wander = graph
          ? randomNodeNear(graph, self.move.origin, 1400, this.random)
          : -1;
        if (graph && wander >= 0) {
          const node = graph.nodes[wander]!;
          goalPosition = v3(node.x, node.y, node.z);
        }
      }
    }

    if (goalPosition) {
      // 功能：目标切换立即重新规划；保持同一路径直至失败，避免每两秒返回身后的网格点。时间：2026-10-09；作者：lq。
      const goalChanged = !this.navigationGoal || Math.hypot(
        goalPosition.x - this.navigationGoal.x, goalPosition.y - this.navigationGoal.y,
        goalPosition.z - this.navigationGoal.z,
      ) > 32;
      if (goalChanged) {
        this.navigationGoal = v3(goalPosition.x, goalPosition.y, goalPosition.z);
        this.arrived = false;
        this.path = null;
        this.repathAt = 0;
      }
      // 功能：持包、捡包和拆包必须走到交互范围内，不能在距离目标 200 单位处停步。时间：2026-10-09；作者：lq。
      // 功能：巡逻也靠近独立站位再停步，避免多个队员在同一入口提前站住。时间：2026-10-10；作者：lq。
      const arrivalRadius = context.goal?.kind === 'patrol' ? 64 : 24;
      this.lastGoalDistance = Math.hypot(goalPosition.x - self.move.origin.x, goalPosition.y - self.move.origin.y);
      this.arrived = this.lastGoalDistance < arrivalRadius && Math.abs(goalPosition.z - self.move.origin.z) < 48;
      if (!this.arrived && (goalChanged || now >= this.repathAt)) {
        // 功能：拆雷倒计时阶段走最快路线，平时进攻才使用随机通道偏好。时间：2026-10-10；作者：lq。
        this.path = context.graph ? findPath(context.graph, self.move.origin, goalPosition, 20000,
          context.goal?.kind === 'defuse' ? undefined : this.routeSeed) : null;
        // 功能：可直达的最后一段补到真实交互位置，避免网格取整后停在 C4 拾取范围外。时间：2026-10-09；作者：lq。
        const end = this.path?.points.at(-1);
        if (end && Math.abs(end.z - goalPosition.z) < 48 && context.world.traceHull(
          HULL_STANDING, v3(end.x, end.y, end.z + 2), v3(goalPosition.x, goalPosition.y, end.z + 2),
        ).fraction === 1) this.path!.points.push(v3(goalPosition.x, goalPosition.y, end.z));
        this.pathIndex = 0;
        this.waypointSince = now;
        this.waypointSkips = 0;
        // 功能：有效路线一直走完，仅目标变化、脱困或路点耗尽时重算，避免定时回头拖慢拆雷。时间：2026-10-10；作者：lq。
        this.repathAt = Infinity;
        this.arrived = false;

        if (!this.path) {
          // The objective is unreachable from here (the navmesh is fragmented on
          // some maps). Walking straight at it grinds the bot into whatever wall
          // separates them — which is what produced the endless on-the-spot
          // hopping. Patrol a nearby spot instead.
          this.routeFailures++;
          this.repathAt = now + 3;
          const wander = context.graph
            ? randomNodeNear(context.graph, self.move.origin, 1400, this.random)
            : -1;
          if (context.graph && wander >= 0) {
            const node = context.graph.nodes[wander]!;
            this.path = findPath(context.graph, self.move.origin, v3(node.x, node.y, node.z));
            this.pathIndex = 0;
            if (this.path) this.waypointSince = now;
          }
          if (this.investigating) this.investigating = null;
        } else {
          this.routeFailures = 0;
          if (this.investigating) this.investigating = null;
        }
      }

      if (this.path && this.pathIndex < this.path.points.length) {
        // Advance past reached waypoints.
        while (this.pathIndex < this.path.points.length) {
          const waypoint = this.path.points[this.pathIndex]!;
          const distance = Math.hypot(
            waypoint.x - self.move.origin.x,
            waypoint.y - self.move.origin.y,
          );
          if (distance > WAYPOINT_RADIUS) break;
          this.pathIndex++;
          this.waypointSince = now;
        }
      }

      // A waypoint that cannot be reached in a few seconds is skipped: a node
      // inside a doorway or on a ledge would otherwise pin the bot forever.
      if (this.path && this.pathIndex < this.path.points.length && now - this.waypointSince > 3) {
        this.pathIndex++;
        this.waypointSince = now;
        this.waypointSkips++;
        if (this.waypointSkips > 2) this.repathAt = 0;
      }

      if (this.path && this.pathIndex < this.path.points.length) {
        const waypoint = this.path.points[this.pathIndex]!;
        // 功能：导航时只水平转向路点，避免近距离路点高度差让 BOT 仰头举枪并扭曲持枪皮肤。时间：2026-09-29；作者：lq。
        aimAt(v3(waypoint.x, waypoint.y, eye.z), TURN_RATE_DEG * 0.7);

        const distance = Math.hypot(waypoint.x - self.move.origin.x, waypoint.y - self.move.origin.y);
        const goalDistance = Math.hypot(
          goalPosition.x - self.move.origin.x,
          goalPosition.y - self.move.origin.y,
        );
        this.lastGoalDistance = goalDistance;
        // Close enough to the objective: hold the position instead of shoving
        // into whatever happens to be in the way.
        if (goalDistance < arrivalRadius && Math.abs(goalPosition.z - self.move.origin.z) < 48) {
          this.arrived = true;
          this.path = null;
        }

        // Turn first, walk second: pushing forward while facing a wall just
        // grinds the bot into the geometry.
        const desiredYaw =
          (Math.atan2(waypoint.y - self.move.origin.y, waypoint.x - self.move.origin.x) * 180) /
          Math.PI;
        // 功能：急转弯先收速并对准，避免跑步惯性越过路点撞入墙角。时间：2026-10-09；作者：lq。
        const facing = Math.abs(normalizeAngle(desiredYaw - command.yaw)) < 25;

        if (distance > 24 && facing && !this.arrived) {
          this.state = 'advance';
          command.state = 'advance';
          command.forwardmove = Math.min(CL_FORWARD_SPEED, Math.max(80, distance * 2));
          command.buttons |= IN_FORWARD;
        }
      } else {
        // 功能：路点耗尽但尚未到达交互位置时重新寻路，避免永远站在 C4 附近。时间：2026-10-10；作者：lq。
        if (!this.arrived) this.repathAt = 0;
        // 功能：无路点时保持当前朝向，避免 BOT 原地持续转圈。时间：2026-09-30；作者：lq。
        command.state = 'idle';
        this.state = 'idle';
        command.yaw = self.yaw;
      }
    }

    // ---- stuck detection: squeeze past, then change route
    const moved = Math.hypot(
      self.move.origin.x - this.lastPosition.x,
      self.move.origin.y - this.lastPosition.y,
    );
    if (command.forwardmove !== 0 && moved < 0.6 && self.move.onground) {
      if (this.stuckSince === 0) {
        this.stuckSince = now;
        this.strafeDirection = this.random() < 0.5 ? -1 : 1;
      }
    } else if (moved > 1.5 || command.forwardmove === 0) {
      this.stuckSince = 0;
    }

    if (this.stuckSince > 0 && self.move.onground) {
      const stuckFor = now - this.stuckSince;
      if (stuckFor > 0.4) {
        // Slide along the obstacle instead of hopping on the spot.
        // 功能：脱困横移数值与随机左右方向一致，避免永远向同一侧挤墙。时间：2026-10-09；作者：lq。
        command.sidemove = CL_SIDE_SPEED * 0.8 * this.strafeDirection;
        command.buttons |= this.strafeDirection > 0 ? IN_MOVERIGHT : IN_MOVELEFT;
        command.forwardmove = CL_FORWARD_SPEED * 0.35;
      }
      if (stuckFor > 1.2 && now > this.nextJumpAt) {
        // Last resort: one hop, a fresh route, and a cooldown.
        command.buttons |= IN_JUMP;
        this.nextJumpAt = now + 2.5;
        this.repathAt = 0;
        this.waypointSkips = 0;
      }
    }

    this.lastPosition = v3(self.move.origin.x, self.move.origin.y, self.move.origin.z);
    return this.finish(command, context, now, dt);
  }

  private finish(command: BotCommand, context: BotContext, now: number, dt: number): BotCommand {
    const self = context.self;
    // 功能：队友间留出身体间距，前方拥堵时减速并向可通行一侧避让，装拆包不受干扰。时间：2026-10-10；作者：lq。
    if (command.action === 'none') {
      const yaw = command.yaw * Math.PI / 180;
      let separation = 0;
      for (const teammate of context.enemies) {
        if (teammate === self || !teammate.alive || teammate.team !== self.team) continue;
        const dx = teammate.move.origin.x - self.move.origin.x;
        const dy = teammate.move.origin.y - self.move.origin.y;
        const distance = Math.hypot(dx, dy);
        if (distance > 100 || Math.abs(teammate.move.origin.z - self.move.origin.z) > 48) continue;
        const ahead = dx * Math.cos(yaw) + dy * Math.sin(yaw);
        const right = dx * Math.sin(yaw) - dy * Math.cos(yaw);
        if (ahead > 0 && Math.abs(right) < 36 && command.forwardmove > 0) command.forwardmove *= 0.35;
        if (distance < 72) separation += (Math.abs(right) < 4 ? (self.id < teammate.id ? -1 : 1) : -Math.sign(right)) * (72 - distance) * 3;
      }
      if (Math.abs(separation) > 1) {
        const side = Math.max(-160, Math.min(160, separation));
        const end = v3(self.move.origin.x + Math.sin(yaw) * Math.sign(side) * 24,
          self.move.origin.y - Math.cos(yaw) * Math.sign(side) * 24, self.move.origin.z + 2);
        if (context.world.traceHull(HULL_STANDING, v3(self.move.origin.x, self.move.origin.y, self.move.origin.z + 2), end).fraction === 1) {
          command.sidemove = side;
          command.buttons |= side > 0 ? IN_MOVERIGHT : IN_MOVELEFT;
        }
      }
    }
    // 功能：进攻时正常跑步，交火时慢走；避免所有难度都以步行速度耗完回合。时间：2026-10-09；作者：lq。
    if (command.state === 'engage' && (command.forwardmove !== 0 || command.sidemove !== 0)) command.buttons |= IN_WALK;
    this.lastPosition = v3(self.move.origin.x, self.move.origin.y, self.move.origin.z);
    void dt;
    void now;
    return command;
  }
}
