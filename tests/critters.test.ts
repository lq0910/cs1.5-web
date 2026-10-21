/** 功能：验证地图小鸡的随机放置、命中盒与可射击行为，不启动浏览器。时间：2026-10-21；作者：lq。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { v3 } from '../src/engine/math.ts';
import { buildNavGraph } from '../src/game/nav.ts';
import { CRITTER_HEIGHT, placeCritters, traceCritters, updateCritters } from '../src/game/critters.ts';
import type { Critter } from '../src/game/critters.ts';
import { Match } from '../src/game/match.ts';
import { IN_ATTACK } from '../src/game/constants.ts';
import { makeTestRoom } from '../src/game/map/build.ts';
import type { MapData, MapSpawn } from '../src/game/map/build.ts';

function spawns(ctCount: number, tCount: number): MapSpawn[] {
  return (['ct', 't'] as const).flatMap((team) => Array.from({ length: team === 'ct' ? ctCount : tCount }, (_, index) => ({
    team, yaw: 0, origin: { x: team === 'ct' ? -512 : 512, y: index * 64, z: 36 },
  })));
}

function testMap(): MapData {
  return { ...makeTestRoom(2048), spawns: spawns(8, 8) };
}

function critterAt(x: number, y: number): Critter {
  return {
    id: 999, position: v3(x, y, 0), yaw: 0, phase: 0, variant: 0,
    health: 30, alive: true, hitAt: -99, diedAt: -99,
  };
}

// 功能：射线只命中最近的小鸡，墙距和死亡状态都不会让子弹穿墙打到小鸡。时间：2026-10-21；作者：lq。
test('critter hitboxes follow the bullet ray and respect walls', () => {
  const near = critterAt(100, 0);
  const far = critterAt(200, 0);
  const hit = traceCritters(v3(0, 0, 10), v3(1, 0, 0), [near, far], 400);
  assert.ok(hit);
  assert.equal(hit.critter, near);
  assert.ok(Math.abs(hit.distance - 91) < 0.01);
  assert.equal(hit.point.z, 10);
  assert.equal(traceCritters(v3(0, 0, 10), v3(1, 0, 0), [near, far], 50), null);
  near.alive = false;
  assert.equal(traceCritters(v3(0, 0, 10), v3(1, 0, 0), [near], 400), null);
  // 功能：从小鸡上方射入时仍能命中 22 单位高的身体。时间：2026-10-21；作者：lq。
  const fromAbove = traceCritters(v3(120, 0, 30), v3(0, 0, -1), [critterAt(120, 0)], 100);
  assert.ok(fromAbove);
  assert.ok(fromAbove.point.z >= 0 && fromAbove.point.z <= CRITTER_HEIGHT);
});

// 功能：关闭开关不生成小鸡，开启后每回合在出生点之外的地面放置。时间：2026-10-21；作者：lq。
test('critters are placed away from spawns only when enabled', () => {
  const map = testMap();
  const graph = buildNavGraph(map.collision, map.bounds, { cellSize: 64 });
  const disabled = new Match({ map, graph, sites: [], ctSize: 1, tSize: 1, critters: false, seed: 3 });
  disabled.startNow();
  assert.equal(disabled.critters.length, 0);

  const enabled = new Match({ map, graph, sites: [], ctSize: 1, tSize: 1, critters: true, seed: 3 });
  enabled.startNow();
  assert.ok(enabled.critters.length >= 2, `expected several critters, got ${enabled.critters.length}`);
  for (const critter of enabled.critters) {
    assert.equal(map.collision.pointContents(v3(critter.position.x, critter.position.y, critter.position.z + 10)), -1);
    assert.ok(Math.hypot(critter.position.x + 512, critter.position.y) > 420);
    assert.ok(Math.hypot(critter.position.x - 512, critter.position.y) > 420);
  }

  // 功能：直接调用放置函数也能限制在小鸡上限内且彼此不过近。时间：2026-10-21；作者：lq。
  const placed = placeCritters({
    graph, world: map.collision, spawns: [], random: () => 0.5, count: 4,
  });
  assert.equal(placed.length, 1, 'the same node must not be placed twice');
});

// 功能：玩家可以打中小鸡，命中后小鸡死亡、子弹停住且不产生击杀播报。时间：2026-10-21；作者：lq。
test('shooting a critter kills it without affecting the score', () => {
  const map = testMap();
  const graph = buildNavGraph(map.collision, map.bounds, { cellSize: 64 });
  const match = new Match({ map, graph, sites: [], ctSize: 1, tSize: 1, critters: true, seed: 11 });
  match.startNow();
  match.mode.phase = 'live';
  const player = match.player!;
  const target = critterAt(120, 0);
  match.critters.length = 0;
  match.critters.push(target);
  player.move.origin = v3(0, 0, 36);
  player.yaw = 0;
  player.combat.selectSlot(2, 1);

  const events = match.update(2, {
    buttons: IN_ATTACK,
    forwardmove: 0,
    sidemove: 0,
    upmove: 0,
    yaw: 0,
    // 功能：从眼睛高度向下瞄准 22 单位高的小鸡中心。时间：2026-10-21；作者：lq。
    pitch: 19.3,
  });
  const hit = events.critterHits.find((entry) => entry.critter === target);
  assert.ok(hit, 'the bullet must hit the critter');
  assert.equal(hit.killed, true);
  assert.equal(target.alive, false);
  assert.equal(hit.shooter, player);
  assert.ok(events.shots.some((shot) => shot.shooter === player && shot.victim === null));
  assert.equal(match.mode.score.ct + match.mode.score.t, 0);
});

// 功能：真实地面上能走动，遇到边墙/落差会转向且死亡后停止。时间：2026-10-21；作者：lq。
test('critters walk on floors, turn at walls and stop when dead', () => {
  const world = makeTestRoom(512).collision;
  const bird = critterAt(0, 0);
  for (let i = 0; i < 60; i++) updateCritters([bird], world, 1 / 60, i / 60, () => 0.5);
  assert.ok(bird.position.x > 20 && bird.position.x < 24);
  assert.ok((bird.walkDistance ?? 0) > 20);
  bird.alive = false;
  const stopped = { ...bird.position };
  updateCritters([bird], world, 1 / 60, 2, () => 0.5);
  assert.deepEqual(bird.position, stopped);
  assert.equal(bird.moving, false);
  bird.alive = true;
  for (let i = 0; i < 3600; i++) {
    updateCritters([bird], world, 1 / 60, 3 + i / 60, () => 0.5);
    assert.ok(Math.abs(bird.position.x) < 510 && Math.abs(bird.position.y) < 510);
    assert.ok(bird.position.z < 2);
  }
});

// 功能：悬崖前不前进，墙体探针在碰撞盒穿墙之前阻止移动。时间：2026-10-21；作者：lq。
test('critters reject cliffs and solid walls', () => {
  const bird = critterAt(0, 0);
  const world = makeTestRoom(512).collision;
  const cliff = { pointContents: world.pointContents.bind(world), traceHull: () => ({ fraction: 1, endpos: v3(1, 0, -100), normal: v3(0, 0, 0), dist: 0, startsolid: false, allsolid: false }) };
  updateCritters([bird], cliff, 1 / 60, 0, () => 0.5);
  assert.deepEqual(bird.position, v3(0, 0, 0));
  assert.notEqual(bird.yaw, 0);
  bird.position = v3(504, 0, 0.5);
  bird.yaw = 0;
  updateCritters([bird], world, 1 / 60, 1, () => 0.5);
  assert.equal(bird.position.x, 504);
});
