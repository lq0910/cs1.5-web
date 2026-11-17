/** 功能：验证原创月球基地的真实碰撞、双包点/观测桥导航、重力和维护道，以及默认随图贴图；时间：2026-11-17；作者：lq。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildMoonbase, moonbaseGravityAt } from '../src/game/map/moonbase.ts';
import { loadMap } from '../src/game/map/loader.ts';
import { MOONBASE_MATERIALS } from '../src/game/map/moonbaseMaterials.ts';
import { buildNavGraph, findPath } from '../src/game/nav.ts';
import { HULL_STANDING } from '../src/engine/collision/types.ts';
import { createMoveState, makeUserCmd, pmPlayerMove } from '../src/game/movement.ts';
import { IN_DUCK, IN_JUMP, TICK_INTERVAL } from '../src/game/constants.ts';
import { parseWad3 } from '../src/engine/bsp/wad.ts';
import { v3 } from '../src/engine/math.ts';
import { Match } from '../src/game/match.ts';
import type { RoundEvents } from '../src/game/gamemode.ts';
import { MOONBASE_LAUNCH_PADS, MoonbaseWorld } from '../src/game/map/moonbaseInteractions.ts';

const map = buildMoonbase();
const graph = buildNavGraph(map.collision, map.bounds, { cellSize: 64 });

// 功能：无 URL 地图参数和缺少原版 BSP 时默认进入月球基地；时间：2026-11-17；作者：lq。
test('moonbase is the default map when no map is requested', async () => {
  const loaded = await loadMap(null);
  assert.equal(loaded.map.id, map.id);
  assert.equal(loaded.source, 'boxes');
});

// 功能：防止出生舱、货箱或舱顶修改后导致出生重叠、卡墙或缺少落脚地面；时间：2026-11-17；作者：lq。
test('moonbase has twelve clear, separated spawns with supported floors', () => {
  assert.equal(map.spawns.filter((spawn) => spawn.team === 'ct').length, 6);
  assert.equal(map.spawns.filter((spawn) => spawn.team === 't').length, 6);
  for (const spawn of map.spawns) {
    assert.equal(map.collision.traceHull(HULL_STANDING, spawn.origin, spawn.origin).startsolid, false);
    const down = map.collision.traceHull(HULL_STANDING, spawn.origin, v3(spawn.origin.x, spawn.origin.y, spawn.origin.z - 8));
    assert.ok(down.fraction < 1 && down.normal.z > 0.7);
    for (const other of map.spawns) if (other !== spawn) assert.ok(Math.hypot(other.origin.x - spawn.origin.x, other.origin.y - spawn.origin.y) >= 64);
  }
});

// 功能：所有出生点到 A/B 和桥两端都必须有实际导航通路，不能只把视觉平台摆在空中；时间：2026-11-17；作者：lq。
test('both bombsites and both upper bridge entrances are reachable from every spawn', () => {
  const targets = [...map.sites!.map((site) => site.center), v3(-544, 0, 196), v3(544, 0, 196)];
  for (const spawn of map.spawns) for (const target of targets) {
    const route = findPath(graph, spawn.origin, target);
    assert.ok(route && !route.approximate, `${spawn.team} at ${spawn.origin.x},${spawn.origin.y} cannot reach ${target.x},${target.y},${target.z}`);
  }
});

// 功能：同一套移动代码在月面和实验室得到不同跳高，其余原版冲量不变；时间：2026-11-17；作者：lq。
test('outdoor jumps reach the moon ledges while indoor jumps retain classic height', () => {
  const heights = [v3(-800, -600, 37), v3(-1056, 240, 37)].map((origin) => {
    const state = createMoveState(origin);
    const command = makeUserCmd();
    for (let i = 0; i < 12; i++) pmPlayerMove(state, map.collision, command, TICK_INTERVAL);
    const ground = state.origin.z;
    let peak = ground;
    command.buttons = IN_JUMP;
    for (let i = 0; i < 128; i++) {
      pmPlayerMove(state, map.collision, command, TICK_INTERVAL);
      peak = Math.max(peak, state.origin.z);
    }
    return peak - ground;
  });
  assert.ok(heights[0]! > 110 && heights[0]! < 122);
  assert.ok(heights[1]! > 42 && heights[1]! < 46);
  assert.equal(moonbaseGravityAt(v3(-1056, 240, 280)), 300, 'lab roof must be outdoors');
});

// 功能：验证 44 单位维护道确实需要蹲行，玩家能从入口穿到出口；时间：2026-11-17；作者：lq。
test('the hidden maintenance flank requires crouching and can be traversed end to end', () => {
  for (const crouched of [false, true]) {
    const state = createMoveState(v3(-1416, -600, 37), 90);
    const command = { ...makeUserCmd(), yaw: 90, forwardmove: 400, buttons: crouched ? IN_DUCK : 0 };
    for (let i = 0; i < 1000; i++) pmPlayerMove(state, map.collision, command, TICK_INTERVAL);
    if (crouched) assert.ok(state.origin.y > 600, `crouching stopped at ${state.origin.y}`);
    else assert.ok(state.origin.y < -520, `standing passed the duct at ${state.origin.y}`);
  }
});

// 功能：即使完全没有 public/cstrike，默认随图包仍包含所有八种真实材质及有效调色板；时间：2026-11-17；作者：lq。
test('the bundled moonbase WAD contains every required original texture without a full CS install', () => {
  const bytes = readFileSync(new URL('../public/moonbase/materials.wad', import.meta.url));
  const wad = parseWad3(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.equal(wad.textures.size, MOONBASE_MATERIALS.length);
  for (const entry of MOONBASE_MATERIALS) {
    const texture = wad.textures.get(entry.name);
    assert.ok(texture && !texture.external && texture.pixels.length === texture.width * texture.height);
    assert.equal(texture.palette.length, 768);
  }
});

// 功能：直接用原创包点启动共享对局，确认 C4、BOT 目标和回合创建使用同一张月球地图；时间：2026-11-17；作者：lq。
test('moonbase starts a full six versus six bomb round with valid site goals', () => {
  const match = new Match({ map, graph, sites: map.sites!, ctSize: 6, tSize: 6, seed: 15017 });
  match.startNow();
  assert.equal(match.actors.length, 12);
  assert.equal(match.mode.bomb.state, 'carried');
  assert.equal(match.mode.bomb.carrier?.team, 't');
  assert.equal(match.mode.phase, 'live');
});

// 功能：逐包点落地后完成三秒安装、五秒拆除，验证地图触发区域与地面高度对齐；时间：2026-11-17；作者：lq。
test('the real A and B floors allow planting and defusing a bomb', () => {
  for (const site of map.sites!) {
    const match = new Match({ map, graph, sites: map.sites!, ctSize: 1, tSize: 1, seed: 15017 });
    match.startNow();
    const terrorist = match.mode.bomb.carrier!;
    const counter = match.actors.find((actor) => actor.team === 'ct')!;
    const down = map.collision.traceHull(HULL_STANDING, v3(site.center.x, site.center.y, 180), v3(site.center.x, site.center.y, -64));
    terrorist.move.origin = down.endpos;
    terrorist.move.onground = true;
    const events: RoundEvents = { roundStarted: null, roundEnded: null, killFeed: [], bombPlanted: null,
      bombDefused: false, bombExploded: false, moneyAwards: [] };
    for (let tick = 0; tick < 193; tick++) match.mode.progressPlant(terrorist, TICK_INTERVAL, tick * TICK_INTERVAL, events);
    assert.equal(match.mode.bomb.state, 'planted', `${site.name} must permit planting`);
    assert.equal(match.mode.bomb.siteName, site.name);
    counter.move.origin = { ...terrorist.move.origin };
    counter.hasDefuseKit = true;
    for (let tick = 0; tick < 321; tick++) match.mode.progressDefuse(counter, TICK_INTERVAL, events);
    assert.equal(match.mode.bomb.state, 'defused', `${site.name} must permit defusing`);
  }
});

// 功能：默认首个阵营出生点朝正门跑动，避免出生后直走顶墙的开局体验；时间：2026-11-17；作者：lq。
test('the first spawn for each team walks directly through its habitat exit', () => {
  for (const team of ['ct', 't']) {
    const spawn = map.spawns.find((candidate) => candidate.team === team)!;
    const state = createMoveState(spawn.origin, spawn.yaw);
    const command = { ...makeUserCmd(), yaw: spawn.yaw, forwardmove: 400 };
    for (let i = 0; i < 64; i++) pmPlayerMove(state, map.collision, command, TICK_INTERVAL);
    assert.ok(Math.abs(state.origin.y) < 900, `${team} was blocked at ${state.origin.y}`);
  }
});

// 功能：手动开关门同步影响射线与角色碰撞，长按 E 不反复切换，关闭遇人会停止；时间：2026-11-17；作者：lq。
test('airlocks respond to E once per press, block bullets when closed, and never close on occupants', () => {
  const fresh = buildMoonbase();
  const world = fresh.collision as MoonbaseWorld;
  world.reset();
  const point = { mins: v3(), maxs: v3() };
  const eye = v3(-640, 0, 80), end = v3(-784, 0, 80), direction = v3(-1, 0, 0);
  assert.ok(world.traceHull(point, eye, end).fraction < 1);
  assert.ok(world.use(eye, direction));
  for (let i = 0; i < 64; i++) { world.update(TICK_INTERVAL, []); world.use(eye, direction); }
  assert.equal(world.snapshotDoors()[0]!.progress, 1, 'holding E must leave it open');
  assert.equal(world.traceHull(point, eye, end).fraction, 1);
  world.update(0.2, []);
  assert.ok(world.use(eye, direction));
  const occupant = { origin: v3(-712, 0, 37), hull: HULL_STANDING };
  for (let i = 0; i < 64; i++) world.update(TICK_INTERVAL, [occupant]);
  assert.equal(world.traceHull(HULL_STANDING, occupant.origin, occupant.origin).startsolid, false);
  for (let i = 0; i < 256; i++) world.update(TICK_INTERVAL, []);
  assert.equal(world.snapshotDoors()[0]!.progress, 0);
});

// 功能：弹射平台默认关闭，按 E 限时启动；真实物理抛物线落在观测桥上，超时停止；时间：2026-11-17；作者：lq。
test('launch pads require activation, propel onto the upper bridge and expire after eight seconds', () => {
  for (const pad of MOONBASE_LAUNCH_PADS) {
    const world = buildMoonbase().collision as MoonbaseWorld;
    world.reset();
    const origin = v3(pad.center.x, pad.center.y, 44);
    assert.equal(world.launchAt(origin), null);
    const eye = v3(origin.x, origin.y - 72, 61);
    const delta = v3(0, 72, pad.center.z - eye.z);
    const distance = Math.hypot(delta.y, delta.z);
    assert.ok(world.use(eye, v3(0, delta.y / distance, delta.z / distance)));
    const state = createMoveState(origin);
    let peak = origin.z, bridgeLanding = false;
    for (let i = 0; i < 200; i++) {
      world.update(TICK_INTERVAL, []);
      pmPlayerMove(state, world, makeUserCmd(), TICK_INTERVAL);
      peak = Math.max(peak, state.origin.z);
      if (state.onground && Math.abs(state.origin.z - 196) < 1) bridgeLanding = true;
    }
    assert.ok(peak > 230);
    assert.ok(bridgeLanding, `pad at ${origin.x},${origin.y} did not land on bridge: ${JSON.stringify(state.origin)}`);
    world.update(8, []);
    assert.equal(world.launchAt(origin), null);
  }
});

// 功能：地图快照包含气闸开度与平台剩余时间，客户端重建后碰撞和弹射行为一致；时间：2026-11-17；作者：lq。
test('moonbase interaction snapshots restore door collision and armed launch pads', () => {
  const host = buildMoonbase().collision as MoonbaseWorld;
  const client = buildMoonbase().collision as MoonbaseWorld;
  host.applyDoors([{ index: 0, progress: 0.5 }, { index: 100, progress: 0.75 }]);
  client.applyDoors(host.snapshotDoors());
  assert.deepEqual(client.snapshotDoors(), host.snapshotDoors());
  assert.deepEqual(client.launchAt(v3(-256, -352, 44)), host.launchAt(v3(-256, -352, 44)));
  host.reset();
  assert.ok(host.snapshotDoors().every(({ progress }) => progress === 0));
});
