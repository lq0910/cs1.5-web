/** 功能：验证原版投掷速度、抛物线、无限库存和贴墙出生点。时间：2026-09-30；作者：lq。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { v3 } from '../src/engine/math.ts';
import { grenadeLaunch, heDamage } from '../src/game/grenades.ts';

// 功能：验证高爆手雷使用 100 基础伤害、350 单位边界的衰减曲线。时间：2026-09-30；作者：lq。
test('HE damage falls to zero at the original blast radius', () => {
  assert.equal(heDamage(0), 100);
  assert.equal(heDamage(175), 50);
  assert.equal(heDamage(350), 0);
  assert.equal(heDamage(500), 0);
});
import { Match, idleCommand } from '../src/game/match.ts';
import { makeTestRoom } from '../src/game/map/build.ts';
import { TICK_INTERVAL, IN_ATTACK } from '../src/game/constants.ts';

/** 功能：构造宽阔无交火空间，确保测试只受手雷模拟影响。时间：2026-09-30；作者：lq。 */
function grenadeMatch(map = makeTestRoom(4096, 2048)): Match {
  const match = new Match({ map, graph: null, sites: [], teamSize: 1 });
  match.startNow();
  match.mode.phase = 'live';
  for (const actor of match.actors) actor.combat.selectSlot(3, 0);
  match.player!.move.origin = v3(0, 0, 36);
  return match;
}

// 功能：锁定水平投掷 600 速度与抬头投掷 750 上限，并验证完整继承玩家速度。时间：2026-09-30；作者：lq。
test('GoldSrc launch remaps pitch, caps speed and inherits full player velocity', () => {
  const eye = v3(0, 0, 53);
  const level = grenadeLaunch(eye, 0, 0, v3(0, 0, 0));
  assert.ok(Math.abs(Math.hypot(level.velocity.x, level.velocity.y, level.velocity.z) - 600) < 1e-6);
  assert.ok(Math.abs(level.velocity.z - 600 * Math.sin(Math.PI / 18)) < 1e-6);
  const raised = grenadeLaunch(eye, -45, 0, v3(0, 0, 0));
  assert.ok(Math.abs(Math.hypot(raised.velocity.x, raised.velocity.y, raised.velocity.z) - 750) < 1e-6);
  const moving = grenadeLaunch(eye, -45, 0, v3(250, 20, 180));
  assert.ok(Math.abs(moving.velocity.x - raised.velocity.x - 250) < 1e-6);
  assert.ok(Math.abs(moving.velocity.y - raised.velocity.y - 20) < 1e-6);
  assert.ok(Math.abs(moving.velocity.z - raised.velocity.z - 180) < 1e-6);
  const downward = grenadeLaunch(eye, 89, 0, v3(0, 0, 0));
  assert.ok(downward.velocity.z < 0);
});

// 功能：以实际固定步长验证飞行重力与侧墙反射，切向速度不应被碰撞统一减半。时间：2026-09-30；作者：lq。
test('grenade flight uses half gravity and wall bounce preserves tangential speed', () => {
  const match = grenadeMatch();
  match.grenadeProjectiles.push({ id: 1, kind: 'flashbang', thrower: match.player!, position: v3(0, 0, 600), velocity: v3(700, 100, 0), detonateAt: 99, lastBounceAt: -99 });
  for (let i = 1; i <= 32; i++) match.update(i * TICK_INTERVAL, idleCommand(0));
  const grenade = match.grenadeProjectiles[0]!;
  assert.ok(Math.abs(grenade.position.x - 350) < 1e-6);
  assert.ok(Math.abs(grenade.position.z - 550) < 1e-6);
  grenade.position = v3(2040, 0, 600);
  grenade.velocity = v3(700, 100, 0);
  match.update(1, idleCommand(0));
  assert.ok(grenade.velocity.x < 0);
  assert.ok(Math.abs(grenade.velocity.y - 100) < 1e-6);
});

// 功能：实际连投三种手雷，验证不消耗库存、松键投出及贴墙出生点位于空处。时间：2026-09-30；作者：lq。
test('all player grenades remain infinite across repeated throws and spawn outside walls', () => {
  const map = makeTestRoom(4096, 2048);
  const match = grenadeMatch(map);
  const player = match.player!;
  player.move.origin = v3(2030, 0, 36);
  const command = idleCommand(0);
  let now = 0;
  for (const kind of ['hegrenade', 'flashbang', 'smokegrenade', 'hegrenade'] as const) {
    player.selectedGrenade = kind;
    command.buttons = IN_ATTACK;
    for (let i = 0; i < 40; i++) match.update(now += TICK_INTERVAL, command);
    command.buttons = 0;
    match.update(now += TICK_INTERVAL, command);
    const grenade = match.grenadeProjectiles.at(-1)!;
    assert.equal(grenade.kind, kind);
    assert.equal(player.grenades[kind], Infinity);
    assert.ok(grenade.position.x < 2048);
    assert.notEqual(map.collision.pointContents(grenade.position), -2);
    assert.ok(Math.abs(grenade.detonateAt - now - (kind === 'smokegrenade' ? 3 : 1.5)) < 1e-6);
    match.grenadeProjectiles.length = 0;
    for (let i = 0; i < 24; i++) match.update(now += TICK_INTERVAL, command);
    assert.equal(player.grenadeAction, null);
  }
});
