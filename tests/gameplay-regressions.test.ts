/** 功能：回归验证真实时间步进、连续购买、自然换局、BOT 难度及阵营模型更新；时间：2026-11-18；作者：lq。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { fixedFrameSteps } from '../src/game/clock.ts';
import { Match, idleCommand } from '../src/game/match.ts';
import { makeTestRoom } from '../src/game/map/build.ts';
import { makeWeaponRuntime } from '../src/game/combat.ts';
import { BotBrain } from '../src/game/bots.ts';
import { IN_ATTACK, IN_FORWARD, TICK_INTERVAL } from '../src/game/constants.ts';
import { HULL_DUCKING, HULL_STANDING } from '../src/engine/collision/types.ts';
import { applyPlayerActions } from '../src/net/actions.ts';
import { applySnapshot, snapshotWorld } from '../src/net/protocol.ts';
import { ActorRenderer } from '../src/engine/render/actors.ts';
import { v3 } from '../src/engine/math.ts';

/** 功能：不同刷新率和 Node 的 15ms 定时器都应保持一秒 64 步，行走和射击结果一致；时间：2026-11-18；作者：lq。 */
test('wall-clock pacing keeps movement, shots and round time stable across refresh rates', () => {
  const outcomes = [30, 60, 144, 200 / 3].map((rate) => {
    const match = new Match({ map: makeTestRoom(4096), graph: null, sites: [], teamSize: 1, multiplayer: true, seed: 8 });
    match.startNow();
    const player = match.claimSeat('ct', 'Walker')!;
    const target = match.claimSeat('t', 'Target')!;
    player.move.origin = v3(-600, 0, 36);
    target.move.origin = v3(1500, 1000, 36);
    player.combat.loadout[1] = makeWeaponRuntime('m4a1');
    player.combat.selectSlot(1, -10);
    let accumulator = 0, now = 0, shots = 0;
    // 功能：统一以完整三秒为测量窗口，最后一帧用剩余真实时间；时间：2026-11-18；作者：lq。
    for (let real = 0; real < 3 - 1e-9;) {
      const elapsed = Math.min(1 / rate, 3 - real);
      real += elapsed;
      const budget = fixedFrameSteps(accumulator, elapsed);
      accumulator = budget.remainder;
      for (let step = 0; step < budget.steps; step++) {
        now += TICK_INTERVAL;
        const events = match.update(now, undefined, new Map([[player.id, {
          ...idleCommand(0), buttons: IN_FORWARD | IN_ATTACK, forwardmove: 400,
        }]]));
        shots += events.shots.length;
      }
    }
    assert.equal(now, 3);
    assert.equal(match.mode.timeLeft, 177);
    return { x: player.move.origin.x, shots };
  });
  for (const outcome of outcomes) assert.deepEqual(outcome, outcomes[0]);
  assert.ok(outcomes[0]!.shots >= 20 && outcomes[0]!.shots <= 30);
  assert.ok(outcomes[0]!.x > 0);
});

/** 功能：卡顿恢复只处理有限补偿步，后续零时间帧不能继续快进；时间：2026-11-18；作者：lq。 */
test('a stalled frame discards excess backlog rather than fast-forwarding later frames', () => {
  const stalled = fixedFrameSteps(0, 10);
  assert.equal(stalled.steps, 8);
  assert.ok(stalled.remainder < TICK_INTERVAL);
  assert.equal(fixedFrameSteps(stalled.remainder, 0).steps, 0);
  assert.equal(fixedFrameSteps(0, -1).steps, 0);
});

/** 功能：足额资金可连续更换主副武器；余额不足有原因、不扣款、不锁住下一次购买；时间：2026-11-18；作者：lq。 */
test('LAN purchases can repeat with explicit success and failure results', () => {
  const match = new Match({ map: makeTestRoom(), graph: null, sites: [], teamSize: 1, multiplayer: true });
  match.startNow();
  const actor = match.claimSeat('ct', 'Buyer')!;
  actor.money = 16000;
  actor.selectedBomb = true;
  for (const item of ['m4a1', 'awp', 'deagle', 'flashbang', 'flashbang']) {
    const [result] = applyPlayerActions(match, actor, { buy: item }, 1);
    assert.equal(result?.success, true, result?.message);
  }
  assert.equal(actor.combat.loadout[1].id, 'awp');
  assert.equal(actor.combat.loadout[2].id, 'deagle');
  assert.equal(actor.grenades.flashbang, 2);
  assert.equal(actor.selectedBomb, false);
  actor.money = 10;
  const before = actor.combat.loadout[1];
  const [failure] = applyPlayerActions(match, actor, { buy: 'm4a1' }, 2);
  assert.match(failure!.message, /资金不足/);
  assert.equal(failure?.success, false);
  assert.equal(actor.money, 10);
  assert.equal(actor.combat.loadout[1], before);
  actor.money = 4000;
  before.nextFireTime = 999;
  before.scoped = true;
  assert.equal(applyPlayerActions(match, actor, { buy: 'm4a1' }, 3)[0]?.success, true);
  assert.equal(actor.combat.loadout[1].nextFireTime, 0);
  assert.equal(actor.combat.loadout[1].scoped, false);
  actor.alive = false;
  assert.match(applyPlayerActions(match, actor, { buy: 'flashbang' }, 4)[0]!.message, /已阵亡/);
});

/** 功能：同一联机房间连续结束四局，验证五秒换局、真人复活、移动碰撞体重置和快照同步；时间：2026-11-18；作者：lq。 */
test('LAN rounds automatically respawn and synchronize without carrying stale movement state', () => {
  const host = new Match({ map: makeTestRoom(2048), graph: null, sites: [], teamSize: 1, multiplayer: true });
  host.startNow();
  const ct = host.claimSeat('ct', 'CT')!;
  const terrorist = host.claimSeat('t', 'T')!;
  const viewer = new Match({ map: makeTestRoom(2048), graph: null, sites: [], teamSize: 1 });
  let now = 0;
  for (let round = 1; round <= 4; round++) {
    ct.move.ducked = true;
    ct.move.hull = HULL_DUCKING;
    ct.move.ladderDetachTime = 100;
    ct.move.mapLaunchCooldown = 100;
    terrorist.alive = false;
    terrorist.health = 0;
    assert.ok(host.update(now += TICK_INTERVAL).mode.roundEnded);
    assert.match(applyPlayerActions(host, ct, { buy: 'flashbang' }, now)[0]!.message, /回合已结束/);
    let started = false;
    for (let tick = 0; tick < 321 && !started; tick++) started = host.update(now += TICK_INTERVAL).mode.roundStarted !== null;
    assert.equal(started, true);
    assert.equal(host.mode.round, round + 1);
    assert.equal(host.mode.phase, 'live');
    assert.equal(terrorist.alive, true);
    assert.equal(terrorist.health, 100);
    assert.equal(ct.move.ducked, false);
    assert.deepEqual(ct.move.hull, HULL_STANDING);
    assert.equal(ct.move.ladderDetachTime, 0);
    assert.equal(ct.move.mapLaunchCooldown, 0);
    applySnapshot(viewer, JSON.parse(JSON.stringify(snapshotWorld(host, 1, now, [], []))));
    assert.equal(viewer.mode.round, round + 1);
    assert.equal(viewer.actors.find((actor) => actor.id === terrorist.id)?.alive, true);
    const x = ct.move.origin.x;
    for (let tick = 0; tick < 16; tick++) host.update(now += TICK_INTERVAL, undefined,
      new Map([[ct.id, { ...idleCommand(0), buttons: IN_FORWARD, forwardmove: 400 }]]));
    assert.ok(ct.move.origin.x > x + 10);
  }
});

/** 功能：固定 BOT 瞄准与武器以比较真实命中伤害，局域网简单难度应和单机一致且小于专家；时间：2026-11-18；作者：lq。 */
test('LAN bots respect difficulty damage while human shots keep full damage', () => {
  const originalThink = BotBrain.prototype.think;
  BotBrain.prototype.think = () => ({ ...idleCommand(180), buttons: IN_ATTACK,
    state: 'engage', action: 'none', switchTo: null });
  try {
    const damage = (multiplayer: boolean, skill: number, human = false): number => {
      const match = new Match({ map: makeTestRoom(2048), graph: null, sites: [], teamSize: 1, multiplayer, skill, seed: 9 });
      match.startNow();
      const target = multiplayer ? match.claimSeat('ct', 'Target')! : match.player!;
      const shooter = human ? match.claimSeat('t', 'Shooter')! : match.actors.find((actor) => actor.team === 't')!;
      target.move.origin = v3(0, 0, 36);
      target.armor = 0;
      shooter.move.origin = v3(200, 0, 36);
      shooter.combat.loadout[1] = makeWeaponRuntime('ak47');
      shooter.combat.selectSlot(1, -10);
      const events = match.update(2, undefined, human ? new Map([[shooter.id, { ...idleCommand(180), buttons: IN_ATTACK }]]) : undefined);
      const shot = events.shots.find((entry) => entry.shooter === shooter && entry.victim === target);
      assert.ok(shot, 'controlled shot must hit the target');
      return shot.damage;
    };
    const easy = damage(true, 0.15);
    assert.ok(Math.abs(easy - damage(false, 0.15)) < 1e-4);
    assert.ok(easy < damage(true, 1) * 0.5);
    assert.ok(Math.abs(damage(true, 0.15, true) - damage(true, 1, true)) < 1e-4);
  } finally { BotBrain.prototype.think = originalThink; }
});

/** 功能：同一角色对象被快照改成另一阵营后必须重建外观，旧异步模型不能再覆盖新皮肤；时间：2026-11-18；作者：lq。 */
test('same-ID network appearance changes rebuild models and ignore stale loads', async () => {
  const originalFetch = globalThis.fetch;
  const pending = new Map<string, (response: Response) => void>();
  globalThis.fetch = (input) => new Promise<Response>((resolve) => { pending.set(String(input), resolve); });
  const match = new Match({ map: makeTestRoom(), graph: null, sites: [], teamSize: 1 });
  const actor = match.player!;
  actor.team = 'ct'; actor.skinIndex = 0;
  const scene = new THREE.Scene();
  const renderer = new ActorRenderer(scene);
  try {
    renderer.update([actor], null, 0);
    const originalGroup = scene.children[0];
    actor.team = 't'; actor.skinIndex = 2;
    renderer.update([actor], null, 0.1);
    const newGroup = scene.children[0]!;
    assert.notEqual(newGroup, originalGroup);
    assert.equal(scene.children.length, 1);
    for (const skin of ['arctic', 'urban']) {
      const path = `player/${skin}/${skin}.mdl`;
      assert.ok(pending.has(`cstrike/models/${path}`));
      pending.get(`cstrike/models/${path}`)!(new Response(new Uint8Array(readFileSync(`public/cstrike/models/${path}`))));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(originalGroup!.children[0]!.children.length, 7, 'stale model must not replace removed placeholder');
    assert.equal(newGroup.children[0]!.children.length, 1, 'new team model must replace its placeholder');
    actor.skinIndex = 3;
    renderer.update([actor], null, 0.2);
    assert.notEqual(scene.children[0], newGroup);
  } finally {
    renderer.dispose();
    globalThis.fetch = originalFetch;
    // 功能：完成遗留模型请求，让测试退出时不留下未结束的资源加载；时间：2026-11-18；作者：lq。
    for (const resolve of pending.values()) resolve(new Response(null, { status: 404 }));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
});
