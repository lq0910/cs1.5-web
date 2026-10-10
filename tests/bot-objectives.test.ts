/** 功能：真实 Dust2 的低难度 BOT 导航、进入包点及持续装包回归测试。时间：2026-10-09；作者：lq。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseBsp } from '../src/engine/bsp/reader.ts';
import { BspCollisionWorld } from '../src/engine/bsp/collision.ts';
import { buildNavGraph, findPath, nearestNode } from '../src/game/nav.ts';
import { bombSitesFromBsp, insideArea } from '../src/game/objectives.ts';
import { spawnsFromBsp } from '../src/game/map/loader.ts';
import { createActor } from '../src/game/actors.ts';
import { BotBrain } from '../src/game/bots.ts';
import { pmPlayerMove } from '../src/game/movement.ts';
import { TICK_INTERVAL, TICK_MS } from '../src/game/constants.ts';
import { GameMode } from '../src/game/gamemode.ts';
// 功能：通过完整对局验证冻结时间后仍能执行匪徒装包任务。时间：2026-10-09；作者：lq。
import { Match, idleCommand } from '../src/game/match.ts';

// 功能：复用本机原版地图和真实碰撞，防止仅用空房间测试掩盖坡道断路。时间：2026-10-09；作者：lq。
const bytes = readFileSync(new URL('../public/cstrike/maps/de_dust2.bsp', import.meta.url));
const bsp = parseBsp(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const world = new BspCollisionWorld(bsp);
const graph = buildNavGraph(world, bsp.models[0]!);
const spawns = spawnsFromBsp(bsp).filter((spawn) => spawn.team === 't');
const sites = bombSitesFromBsp(bsp);

// 功能：确认所有匪家出生点均有到 A、B 的连通路线。时间：2026-10-09；作者：lq。
test('every Dust2 terrorist spawn has a path to both bombsites', () => {
  for (const spawn of spawns) for (const site of sites) assert.ok(findPath(graph, spawn.origin, site.center), `${site.name}: ${JSON.stringify(spawn.origin)}`);
});

for (const site of sites) {
  // 功能：无敌人干扰的真实移动验证，最低难度也必须在回合内走入包点并装包。时间：2026-10-09；作者：lq。
  test(`easy bot runs from Dust2 spawn to ${site.name} and plants C4`, () => {
    const actor = createActor({ name: 'objective-test', team: 't', isBot: true, spawn: spawns[0]!.origin, yaw: 0,
      weapons: { 1: 'ak47', 2: 'glock18', 3: 'knife' }, seed: 2 });
    const brain = new BotBrain(2, actor.move.origin);
    const node = graph.nodes[nearestNode(graph, site.center)]!;
    const goal = { position: { x: node.x, y: node.y, z: node.z }, kind: 'site' as const };
    const mode = new GameMode([site]);
    mode.phase = 'live';
    mode.bomb.carrier = actor;
    const events = { roundStarted: null, roundEnded: null, killFeed: [], bombPlanted: null, bombDefused: false,
      bombExploded: false, moneyAwards: [] } as Parameters<typeof mode.progressPlant>[3];
    for (let tick = 1; tick <= 120 / TICK_INTERVAL; tick++) {
      const now = tick * TICK_INTERVAL;
      const command = brain.think(TICK_INTERVAL, { world, graph, self: actor, enemies: [], goal, now, skill: 0,
        canPlant: insideArea(site, actor.move.origin), canDefuse: false });
      if (command.action === 'plant') mode.progressPlant(actor, TICK_INTERVAL, now, events);
      else mode.cancelPlant();
      if (mode.bomb.state === 'planted') break;
      actor.yaw = command.yaw;
      actor.pitch = command.pitch;
      actor.move.angles.yaw = command.yaw;
      actor.move.angles.pitch = command.pitch;
      pmPlayerMove(actor.move, world, { ...command, msec: TICK_MS, upmove: 0, roll: 0 }, TICK_INTERVAL);
    }
    assert.equal(mode.bomb.state, 'planted', `position=${JSON.stringify(actor.move.origin)} brain=${JSON.stringify(brain.debugState())}`);
  });
}

// 功能：走过真实冻结阶段和多队员任务分配，避免单脑测试掩盖回合级路线重置问题。时间：2026-10-09；作者：lq。
test('easy Dust2 squad plants after freeze time in the actual match loop', () => {
  const map = { name: 'BSP: de_dust2', collision: world, bounds: bsp.models[0]!, boxes: [],
    spawns: spawnsFromBsp(bsp), skyColor: 0, fogColor: 0 };
  for (const seed of [5, 21, 77]) {
    const match = new Match({ map, graph, sites, teamSize: 4, skill: 0, seed });
    match.startNow();
    // 功能：隔离枪战干扰，CT 保持存活但位于视距外，专门验证匪徒任务执行。时间：2026-10-09；作者：lq。
    for (const actor of match.actors.filter((actor) => actor.team === 'ct')) actor.move.origin = { x: 50000, y: 50000, z: 36 };
    let planted = false;
    for (let tick = 1; tick < 120 / TICK_INTERVAL; tick++) {
      if (match.update(tick * TICK_INTERVAL, idleCommand(0)).mode.bombPlanted) { planted = true; break; }
    }
    assert.ok(planted, `seed ${seed}: T squad should execute bomb objective after freeze`);
  }
});

// 功能：相同出生点和包点在不同偏好下应走不同区域，且始终保持连通。时间：2026-10-10；作者：lq。
test('round route preferences vary Dust2 corridors without losing bombsite reachability', () => {
  for (const site of sites) {
    const corridors = new Set<string>();
    for (let seed = 1; seed <= 16; seed++) {
      const path = findPath(graph, spawns[0]!.origin, site.center, 20000, seed * 73856093);
      assert.ok(path);
      corridors.add(path.points.map((point) => `${Math.floor(point.x / 384)},${Math.floor(point.y / 384)}`)
        .filter((region, index, regions) => index === 0 || region !== regions[index - 1]).join('|'));
    }
    assert.ok(corridors.size > 1, `${site.name}: bots should choose more than one corridor sequence`);
  }
});

// 功能：真实地图上 CT 从出生区转去拆包，多名队员不能反复抢占拆包进度。时间：2026-10-10；作者：lq。
test('Dust2 CT squad rotates from spawn and completes one uninterrupted defuse', () => {
  const map = { name: 'BSP: de_dust2', collision: world, bounds: bsp.models[0]!, boxes: [],
    spawns: spawnsFromBsp(bsp), skyColor: 0, fogColor: 0 };
  for (const seed of [5, 21, 77]) for (const site of sites) {
    const match = new Match({ map, graph, sites, teamSize: 4, skill: 0, seed });
    match.startNow();
    match.mode.phase = 'live';
    for (const actor of match.actors.filter((actor) => actor.team === 't')) actor.move.origin = { x: 50000, y: 50000, z: 36 };
    match.mode.bomb.state = 'planted';
    match.mode.bomb.carrier = null;
    const node = graph.nodes.filter((node) => insideArea(site, node)).sort((a, b) => a.z - b.z)[0]!;
    // 功能：C4 放在地面而非人物中心；测试延长倒计时以隔离长距离导航，游戏默认仍为 35 秒。时间：2026-10-10；作者：lq。
    match.mode.bomb.position = { x: node.x, y: node.y, z: node.z - 36 };
    match.mode.bombTimeLeft = 90;
    let defused = false;
    const defusers = new Set<number>();
    for (let tick = 1; tick < 90 / TICK_INTERVAL; tick++) {
      const events = match.update(tick * TICK_INTERVAL, idleCommand(0));
      if (match.mode.bomb.defuser) defusers.add(match.mode.bomb.defuser.id);
      if (events.mode.bombDefused) { defused = true; break; }
      if (events.mode.bombExploded) break;
    }
    assert.ok(defused, `seed ${seed}, site ${site.name}: CT squad should rotate to the bomb and defuse`);
    assert.equal(defusers.size, 1, 'covering teammates must not reset the active defuser');
  }
});

// 功能：队友挤在前方时减速并横向让开，独自装包时保持静止。时间：2026-10-10；作者：lq。
test('bots leave space for a teammate instead of marching through them', () => {
  const node = graph.nodes[nearestNode(graph, sites[0]!.center)]!;
  const actor = createActor({ name: 'spacing', team: 't', isBot: true, spawn: node, yaw: 0,
    weapons: { 1: 'ak47', 2: 'glock18', 3: 'knife' }, seed: 2 });
  const teammate = createActor({ name: 'ahead', team: 't', isBot: true,
    spawn: { x: node.x + 40, y: node.y, z: node.z }, yaw: 0,
    weapons: { 1: 'ak47', 2: 'glock18', 3: 'knife' }, seed: 3 });
  const context = { world, graph, self: actor, enemies: [actor, teammate],
    goal: { position: { x: node.x + 200, y: node.y, z: node.z }, kind: 'patrol' as const },
    now: 1, skill: 0, canPlant: false, canDefuse: false };
  const crowded = new BotBrain(2, node).think(TICK_INTERVAL, context);
  const alone = new BotBrain(2, node).think(TICK_INTERVAL, { ...context, enemies: [actor] });
  assert.ok(Math.abs(crowded.sidemove) > 0 || crowded.forwardmove < alone.forwardmove);
  const planting = new BotBrain(2, node).think(TICK_INTERVAL, { ...context, canPlant: true });
  assert.equal(planting.action, 'plant');
  assert.equal(planting.sidemove, 0);
});

// 功能：默认 35 秒内验证玩家放弃拆雷后的接替，以及拆雷 BOT 阵亡后的重新分工。时间：2026-10-10；作者：lq。
test('bots resume a released player defuse and replace a dead defuser within the normal timer', () => {
  const map = { name: 'BSP: de_dust2', collision: world, bounds: bsp.models[0]!, boxes: [],
    spawns: spawnsFromBsp(bsp), skyColor: 0, fogColor: 0 };
  const match = new Match({ map, graph, sites, teamSize: 4, skill: 0, seed: 21 });
  match.startNow();
  match.mode.phase = 'live';
  const node = graph.nodes.filter((node) => insideArea(sites[0]!, node)).sort((a, b) => a.z - b.z)[0]!;
  for (const actor of match.actors) actor.move.origin = actor.team === 'ct'
    ? { x: node.x, y: node.y, z: node.z } : { x: 50000, y: 50000, z: 36 };
  match.mode.bomb.state = 'planted';
  match.mode.bomb.carrier = null;
  match.mode.bomb.position = { x: node.x, y: node.y, z: node.z - 36 };
  match.mode.bombTimeLeft = 35;
  match.mode.bomb.defuser = match.player;
  match.mode.bomb.defuseProgress = 0.1;
  let replaced = false;
  let defused = false;
  for (let tick = 1; tick < 35 / TICK_INTERVAL; tick++) {
    const events = match.update(tick * TICK_INTERVAL, idleCommand(0));
    const defuser = match.mode.bomb.defuser;
    if (!replaced && defuser?.isBot && match.mode.bomb.defuseProgress > 0.1) {
      defuser.alive = false;
      defuser.health = 0;
      replaced = true;
    }
    if (events.mode.bombDefused) { defused = true; break; }
    if (events.mode.bombExploded) break;
  }
  assert.ok(replaced, 'a bot should take over when the player releases use');
  assert.ok(defused, 'another bot should finish after the first defuser dies');
});
