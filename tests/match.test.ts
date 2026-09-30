/**
 * M3 tests: actors, hitboxes, damage, rounds, the bomb and the match loop.
 *
 * The interesting property here is that a whole 4v4 match can be played inside
 * the test runner: if bots stop fighting, if rounds never end, if the bomb never
 * explodes — the assertions catch it without a browser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { v3 } from '../src/engine/math.ts';
import { HULL_STANDING } from '../src/engine/collision/types.ts';
import { makeTestRoom } from '../src/game/map/build.ts';
import { createActor, damageActor, traceActors, PLAYER_HITBOXES } from '../src/game/actors.ts';
import { aimDirection, applyArmor, damageAtDistance, makeWeaponRuntime } from '../src/game/combat.ts';
import { WEAPONS } from '../src/game/weapons.ts';
import { GameMode, BUY_MENU, buyMenuOptions } from '../src/game/gamemode.ts';
import { Match, idleCommand } from '../src/game/match.ts';
import { buildNavGraph } from '../src/game/nav.ts';
import { IN_ATTACK, IN_USE, TICK_INTERVAL } from '../src/game/constants.ts';

function actorAt(x: number, y: number, team: 'ct' | 't' = 't') {
  return createActor({
    name: `${team}@${x}`,
    team,
    isBot: true,
    spawn: v3(x, y, 36),
    yaw: 0,
    weapons: { 1: 'ak47', 2: 'usp45', 3: 'knife' },
    seed: 1,
  });
}

// ------------------------------------------------------------------ hitboxes

test('hitboxes cover head, chest, stomach and legs in the right places', () => {
  const origin = v3(0, 0, 0);
  const target = actorAt(200, 0);
  const direction = v3(1, 0, 0);

  // Aim at the head (centre 36 above the hull centre is the top of the head).
  for (const [label, z, expected] of [
    ['head', 30, 'head'],
    ['chest', 10, 'chest'],
    ['stomach', -8, 'stomach'],
    ['legs', -28, 'leg'],
  ] as const) {
    target.move.origin = v3(200, 0, 0);
    const from = v3(0, 0, z);
    const hit = traceActors(from, direction, [target], 1000);
    assert.ok(hit, `${label}: expected a hit`);
    assert.equal(hit!.hit.group, expected, `${label} resolved to the wrong hitbox`);
  }

  // A shot above the head misses entirely.
  target.move.origin = v3(200, 0, 0);
  assert.equal(traceActors(v3(0, 0, 60), direction, [target], 1000), null);

  // The world distance caps the search: a wall closer than the actor wins.
  const behindWall = traceActors(v3(0, 0, 10), direction, [target], 100);
  assert.equal(behindWall, null, 'a wall at 100 units must block the shot');

  assert.equal(PLAYER_HITBOXES.length, 4);
  void origin;
});

test('the nearest actor is hit first', () => {
  const near = actorAt(150, 0);
  const far = actorAt(300, 0);
  const hit = traceActors(v3(0, 0, 10), v3(1, 0, 0), [far, near], 1000);
  assert.ok(hit);
  assert.equal(hit!.actor, near);
  assert.ok(Math.abs(hit!.hit.distance - 150) < 12, `distance was ${hit!.hit.distance}`);
});

// -------------------------------------------------------------------- damage

test('an AK headshot one-taps through a helmet, chest shots do not', () => {
  const ak = WEAPONS.ak47;
  const headDamage = damageAtDistance(ak, 300, 'head');
  assert.ok(headDamage > 100, `head damage ${headDamage} should be lethal`);

  const bare = actorAt(0, 0);
  const bareResult = damageActor(bare, headDamage, ak.armorRatio);
  assert.equal(bareResult.killed, true);
  assert.equal(bare.alive, false);
  assert.equal(bare.deaths, 1);

  // With a helmet the AK still one-taps (that is the AK's whole reputation),
  // but it does less damage and the armour is consumed.
  const armoured = actorAt(0, 0);
  armoured.armor = 100;
  const applied = applyArmor(headDamage, ak.armorRatio, 100);
  assert.ok(applied.damage < headDamage, 'armor must reduce the damage');
  assert.ok(applied.armor < 100, 'armor must be consumed');
  const armouredResult = damageActor(armoured, headDamage, ak.armorRatio);
  assert.equal(armouredResult.killed, true, 'an AK headshot goes through a helmet');
  assert.equal(armoured.health, 0, 'health is clamped at zero');

  // A chest shot through armour is survivable; legs definitely are.
  const chest = actorAt(0, 0);
  chest.armor = 100;
  assert.equal(damageActor(chest, damageAtDistance(ak, 300, 'chest'), ak.armorRatio).killed, false);

  const legs = actorAt(0, 0);
  damageActor(legs, damageAtDistance(ak, 300, 'leg'), ak.armorRatio);
  assert.equal(legs.alive, true, 'a leg shot should not kill');
});

// 功能：对局级验证 AWP 开镜第一发打中胸部时可以击杀满血满甲敌人。时间：2026-09-30；作者：lq。
test('a scoped AWP chest shot kills a fully armored enemy', () => {
  const match = new Match({ map: makeTestRoom(2048), graph: null, sites: [], teamSize: 1, seed: 17 });
  match.startNow();
  match.mode.phase = 'live';
  const player = match.player!;
  const target = match.actors.find((actor) => actor.team !== player.team)!;
  // 功能：测试狙击枪胸部伤害前显式装备主武器，不依赖玩家出生默认枪。时间：2026-09-30；作者：lq。
  player.combat.selectSlot(1, 0);
  player.move.origin = v3(0, 0, 36);
  player.combat.loadout[1] = makeWeaponRuntime('awp');
  player.combat.current().scoped = true;
  player.combat.current().zoomLevel = 1;
  target.move.origin = v3(300, 0, 36);
  target.armor = 100;
  const command = idleCommand(0);
  command.buttons = IN_ATTACK;
  const shot = match.update(2, command).shots.find((event) => event.shooter === player);
  assert.ok(shot);
  assert.equal(shot.victim, target);
  assert.equal(shot.killed, true);
  assert.equal(shot.headshot, false);
});

// -------------------------------------------------------------------- rounds

test('round phases advance and elimination ends the round', () => {
  const mode = new GameMode([], { warmupTime: 0.5, freezeTime: 1, roundTime: 5 });
  mode.setSpawns({ ct: [v3(0, 0, 36)], t: [v3(100, 0, 36)] });

  const ct = actorAt(0, 0, 'ct');
  const t = actorAt(100, 0, 't');
  const actors = [ct, t];
  mode.setActors(actors);

  let events = mode.update(0.2, actors, 0.2);
  assert.equal(mode.phase, 'warmup');
  void events;

  events = mode.update(0.4, actors, 0.6);
  assert.equal(mode.phase, 'freeze', 'warmup should hand over to freeze');
  assert.equal(events.roundStarted, 1);
  assert.equal(mode.round, 1);

  mode.update(1.1, actors, 1.7);
  assert.equal(mode.phase, 'live');

  // Kill the terrorist: CT should win immediately.
  t.alive = false;
  events = mode.update(TICK_INTERVAL, actors, 1.8);
  assert.equal(mode.phase, 'over');
  assert.equal(events.roundEnded?.winner, 'ct');
  assert.equal(mode.score.ct, 1);

  // Rewards were paid.
  assert.ok(ct.money > 800, `CT money should grow, got ${ct.money}`);
});

// 功能：验证玩家阵亡不会被 Match 特殊重置，仍由正常回合胜负决定下一局。时间：2026-09-30；作者：lq。
test('a dead player remains in spectator state until the round ends', () => {
  const match = new Match({ map: makeTestRoom(512, 256), graph: null, sites: [], teamSize: 2, seed: 71 });
  match.startNow();
  match.mode.phase = 'live';
  const player = match.player!;
  const teammate = match.actors.find((actor) => actor.team === player.team && actor !== player)!;
  const enemy = match.actors.find((actor) => actor.team !== player.team)!;
  player.alive = false;
  player.health = 0;
  const roundBefore = match.mode.round;
  const event = match.update(1, { buttons: 0, forwardmove: 0, sidemove: 0, upmove: 0, yaw: 0, pitch: 0 });
  assert.equal(player.alive, false);
  assert.equal(match.mode.round, roundBefore);
  assert.equal(event.mode.roundEnded, null);
  teammate.alive = false;
  enemy.alive = true;
  const ended = match.update(1.1, { buttons: 0, forwardmove: 0, sidemove: 0, upmove: 0, yaw: 0, pitch: 0 });
  assert.equal(ended.mode.roundEnded?.winner, enemy.team);
  assert.equal(player.alive, false);
  for (let tick = 1; tick <= 5 / TICK_INTERVAL; tick++) match.update(1.1 + tick * TICK_INTERVAL, idleCommand(0));
  assert.equal(match.mode.round, roundBefore + 1);
  assert.equal(match.mode.phase, 'freeze');
  assert.equal(player.alive, true);
});

// 功能：确认默认 3 分钟到时正常结算，并保留显式配置的自定义回合时长。时间：2026-09-30；作者：lq。
test('round timeout defaults to three minutes and supports custom duration', () => {
  for (const duration of [undefined, 60]) {
    const mode = new GameMode([], { warmupTime: 0, freezeTime: 0, roundTime: duration });
    const actors = [actorAt(-200, 0, 'ct'), actorAt(200, 0, 't')];
    mode.setActors(actors);
    mode.setSpawns({ ct: [v3(-200, 0, 36)], t: [v3(200, 0, 36)] });
    mode.update(0, actors, 0);
    mode.update(0, actors, 0);
    const expected = duration ?? 180;
    assert.equal(mode.phase, 'live');
    assert.equal(mode.timeLeft, expected);
    assert.equal(mode.update(expected - 1, actors, expected - 1).roundEnded, null);
    assert.equal(mode.update(1, actors, expected).roundEnded?.reason, '时间到');
    assert.equal(mode.score.ct, 1);
  }
});

test('the bomb arms, ticks down and wins the round for the terrorists', () => {
  const sites = [
    {
      name: 'A',
      center: v3(0, 0, 36),
      mins: v3(-100, -100, 0),
      maxs: v3(100, 100, 100),
    },
  ];
  const mode = new GameMode(sites, { warmupTime: 0.1, freezeTime: 0.1, roundTime: 5, bombTime: 2 });
  mode.setSpawns({ ct: [v3(400, 0, 36)], t: [v3(0, 0, 36)] });
  const ct = actorAt(400, 0, 'ct');
  const t = actorAt(0, 0, 't');
  const actors = [ct, t];
  mode.setActors(actors);

  mode.update(0.05, actors, 0.05);   // warmup
  mode.update(0.3, actors, 0.35);    // -> freeze
  mode.update(0.2, actors, 0.55);    // -> live
  assert.equal(mode.phase, 'live');

  // The carrier stands in the site, so the plant succeeds.
  const events = {
    roundStarted: null,
    roundEnded: null,
    killFeed: [],
    bombPlanted: null,
    bombDefused: false,
    bombExploded: false,
    moneyAwards: [],
  } as Parameters<typeof mode.tryPlant>[2];
  assert.equal(mode.tryPlant(t, 1, events), true);
  assert.equal(mode.bomb.state, 'planted');
  assert.ok(events.bombPlanted);
  assert.ok(t.money >= 800 + 300, 'planting pays');

  // Tick past the fuse.
  let exploded = false;
  let now = 1;
  for (let i = 0; i < 200 && !exploded; i++) {
    now += TICK_INTERVAL;
    const tick = mode.update(TICK_INTERVAL, actors, now);
    if (tick.bombExploded) exploded = true;
  }
  assert.equal(exploded, true, 'the bomb should explode');
  assert.equal(mode.score.t, 1, 'the terrorists win');
  assert.equal(mode.bomb.state, 'exploded');
});

test('defusing the bomb wins the round for the CTs', () => {
  const sites = [
    { name: 'A', center: v3(0, 0, 36), mins: v3(-100, -100, 0), maxs: v3(100, 100, 100) },
  ];
  const mode = new GameMode(sites, { warmupTime: 0.1, freezeTime: 0.1, roundTime: 30, bombTime: 35, defuseTime: 1 });
  mode.setSpawns({ ct: [v3(0, 0, 36)], t: [v3(0, 0, 36)] });
  const ct = actorAt(0, 0, 'ct');
  const t = actorAt(0, 0, 't');
  const actors = [ct, t];
  mode.setActors(actors);

  mode.update(0.05, actors, 0.05);   // warmup
  mode.update(0.3, actors, 0.35);    // -> freeze
  mode.update(0.2, actors, 0.55);    // -> live

  const events = {
    roundStarted: null,
    roundEnded: null,
    killFeed: [],
    bombPlanted: null,
    bombDefused: false,
    bombExploded: false,
    moneyAwards: [],
  } as Parameters<typeof mode.tryPlant>[2];
  mode.tryPlant(t, 1, events);

  // Stand on the bomb and defuse.
  let now = 1;
  let done = false;
  for (let i = 0; i < 200 && !done; i++) {
    now += TICK_INTERVAL;
    mode.update(TICK_INTERVAL, actors, now);
    if (mode.progressDefuse(ct, TICK_INTERVAL, events)) done = true;
  }
  assert.equal(done, true, 'the defuse should complete');
  assert.equal(mode.bomb.state, 'defused');
  assert.equal(mode.score.ct, 1);
});

// 功能：验证原版 C4 装包需持续三秒，松开后进度清零，拆弹器将拆包时间减半。时间：2026-09-30；作者：lq。
test('C4 planting and defusing require uninterrupted input', () => {
  const site = { name: 'A', center: v3(0, 0, 36), mins: v3(-100, -100, 0), maxs: v3(100, 100, 100) };
  const mode = new GameMode([site], { plantTime: 3, defuseTime: 10, defuseTimeWithKit: 5 });
  const t = actorAt(0, 0, 't');
  const ct = actorAt(0, 0, 'ct');
  mode.phase = 'live';
  mode.bomb.carrier = t;
  // 功能：原版只有站在地面才能安装 C4，测试显式设置站立状态。时间：2026-09-30；作者：lq。
  t.move.onground = true;
  const events = { roundStarted: null, roundEnded: null, killFeed: [], bombPlanted: null, bombDefused: false, bombExploded: false, moneyAwards: [] } as Parameters<typeof mode.progressPlant>[3];
  assert.equal(mode.progressPlant(t, 1, 1, events), false);
  assert.ok(mode.bomb.plantProgress > 0);
  mode.cancelPlant();
  assert.equal(mode.bomb.plantProgress, 0);
  assert.equal(mode.progressPlant(t, 2, 3, events), false);
  assert.equal(mode.progressPlant(t, 1, 4, events), true);
  assert.equal(mode.bomb.state, 'planted');
  assert.equal(mode.progressDefuse(t, 10, events), false, 'terrorists cannot defuse');
  assert.equal(mode.buy(ct, 'defusekit'), true);
  assert.equal(ct.hasDefuseKit, true);
  assert.equal(mode.progressDefuse(ct, 2.5, events), false);
  assert.equal(mode.bomb.defuseProgress, 0.5);
  mode.cancelDefuse(ct);
  assert.equal(mode.bomb.defuseProgress, 0);
  assert.equal(mode.progressDefuse(ct, 5, events), true);
  assert.equal(mode.bomb.state, 'defused');
});

// 功能：持包 T 阵亡后 C4 掉落，其他 T 接触后恢复携带状态。时间：2026-09-30；作者：lq。
test('a dead bomb carrier drops C4 for a teammate to collect', () => {
  const mode = new GameMode([]);
  const carrier = actorAt(0, 0, 't');
  const teammate = actorAt(120, 0, 't');
  mode.bomb.carrier = carrier;
  carrier.alive = false;
  mode.dropBomb();
  assert.equal(mode.bomb.state, 'dropped');
  assert.equal(mode.pickupBomb(teammate), false);
  teammate.move.origin = v3(20, 0, 36);
  assert.equal(mode.pickupBomb(teammate), true);
  assert.equal(mode.bomb.carrier, teammate);
});

// 功能：对局层验证 CT 按住 E 拆包，松开后进度归零。时间：2026-09-30；作者：lq。
test('player use command advances and cancels bomb defuse', () => {
  const site = { name: 'A', center: v3(0, 0, 36), mins: v3(-100, -100, 0), maxs: v3(100, 100, 100) };
  const match = new Match({ map: makeTestRoom(2048), graph: null, sites: [site], teamSize: 1, seed: 5 });
  match.startNow();
  match.mode.phase = 'live';
  const player = match.player!;
  player.move.origin = v3(0, 0, 36);
  match.mode.bomb.state = 'planted';
  match.mode.bomb.position = v3(0, 0, 0);
  match.mode.bombTimeLeft = 35;
  const cmd = idleCommand(0);
  cmd.buttons = IN_USE;
  match.update(TICK_INTERVAL, cmd);
  assert.ok(match.mode.bomb.defuseProgress > 0);
  cmd.buttons = 0;
  match.update(TICK_INTERVAL * 2, cmd);
  assert.equal(match.mode.bomb.defuseProgress, 0);
});

// 功能：验证玩家 T 按住左键装包三秒后才触发 C4 安装。时间：2026-09-30；作者：lq。
test('terrorist player plants C4 by holding attack in a bombsite', () => {
  const site = { name: 'A', center: v3(0, 0, 36), mins: v3(-100, -100, 0), maxs: v3(100, 100, 100) };
  const match = new Match({ map: makeTestRoom(4096), graph: null, sites: [site], teamSize: 1, playerTeam: 't', seed: 21 });
  match.startNow();
  match.mode.phase = 'live';
  match.mode.timeLeft = 100;
  const player = match.player!;
  const ct = match.actors.find((actor) => actor.team === 'ct')!;
  player.move.origin = v3(0, 0, 36);
  ct.move.origin = v3(1600, 0, 36);
  ct.combat.selectSlot(3, 0);
  player.selectedBomb = true;
  assert.equal(match.mode.bomb.carrier, player);
  const cmd = idleCommand(0);
  cmd.buttons = IN_ATTACK;
  let planted = false;
  for (let tick = 1; tick <= 200 && !planted; tick++) {
    planted = match.update(tick * TICK_INTERVAL, cmd).mode.bombPlanted !== null;
    if (tick === 100) assert.equal(planted, false);
  }
  assert.equal(planted, true);
  assert.equal(match.mode.bomb.state, 'planted');
  assert.equal(player.selectedBomb, false);
});

// 功能：C4 引信归零同时造成周围伤害并产生爆炸事件。时间：2026-09-30；作者：lq。
test('C4 explosion damages nearby actors and ends the round', () => {
  const match = new Match({ map: makeTestRoom(2048), graph: null, sites: [], teamSize: 1, seed: 22 });
  match.startNow();
  match.mode.phase = 'live';
  const player = match.player!;
  player.move.origin = v3(0, 0, 36);
  match.mode.bomb.state = 'planted';
  match.mode.bomb.position = v3(0, 0, 0);
  match.mode.bombTimeLeft = TICK_INTERVAL;
  const events = match.update(TICK_INTERVAL, idleCommand(0));
  assert.equal(events.mode.bombExploded, true);
  assert.equal(player.alive, false);
  assert.equal(events.mode.roundEnded?.winner, 't');
});

test('buying deducts money and changes the loadout', () => {
  const mode = new GameMode([], { warmupTime: 0.1, freezeTime: 30 });
  const actor = actorAt(0, 0, 'ct');
  actor.money = 5000;

  assert.equal(mode.buy(actor, 'armor'), true);
  assert.equal(actor.armor, 100);
  assert.equal(actor.money, 4000);

  assert.equal(mode.buy(actor, 'm4a1'), true);
  assert.equal(actor.combat.loadout[1].id, 'm4a1');
  assert.equal(actor.money, 900);

  assert.equal(mode.buy(actor, 'awp'), false, 'cannot afford an AWP');
  assert.equal(mode.buy(actor, 'defusekit'), true, 'CTs may buy a kit');
  assert.equal(actor.money, 700);

  const terrorist = actorAt(0, 0, 't');
  terrorist.money = 5000;
  assert.equal(mode.buy(terrorist, 'defusekit'), false, 'Ts may not buy a kit');
  assert.equal(mode.buy(terrorist, 'ak47'), true);
  assert.equal(BUY_MENU.length >= 5, true);
});

// 功能：验证本地无限资金能买任意阵营枪械与三种手雷，购买不会减少资金。时间：2026-09-29；作者：lq。
test('unlimited local player can buy every gun and grenade', () => {
  const mode = new GameMode([]);
  const actor = actorAt(0, 0, 'ct');
  actor.unlimitedFunds = true;
  actor.money = Infinity;
  for (const item of BUY_MENU.filter((entry) => entry.weapon || entry.grenade)) {
    assert.equal(mode.buy(actor, item.id), true, `${item.id} should be purchasable`);
  }
  assert.equal(actor.money, Infinity);
  assert.equal(actor.grenades.hegrenade, 1);
  assert.equal(actor.grenades.flashbang, 1);
  assert.equal(actor.grenades.smokegrenade, 1);
});

// --------------------------------------------------------------------- match

test('a full 4v4 match on the built-in map produces kills and finished rounds', () => {
  const map = makeTestRoom(768, 256);
  const graph = buildNavGraph(map.collision, map.bounds, { cellSize: 64 });
  const sites = [
    { name: 'A', center: v3(200, 200, 36), mins: v3(150, 150, 0), maxs: v3(250, 250, 100) },
  ];

  const match = new Match({ map, graph, sites, teamSize: 4, skill: 0.6, seed: 4242 });
  assert.equal(match.actors.length, 8);
  assert.equal(match.actors.filter((a) => a.team === 'ct').length, 4);
  assert.equal(match.actors.filter((a) => a.team === 't').length, 4);
  match.startNow(0);

  let now = 0;
  let kills = 0;
  let roundsFinished = 0;
  for (let tick = 0; tick < 64 * 600 && roundsFinished < 3; tick++) {
    now += TICK_INTERVAL;
    const events = match.update(now, {
      buttons: 0,
      forwardmove: 0,
      sidemove: 0,
      upmove: 0,
      yaw: 0,
      pitch: 0,
    });
    kills += events.shots.filter((shot) => shot.killed).length;
    if (events.mode.roundEnded) roundsFinished++;
  }

  assert.ok(kills > 0, 'bots must actually fight: no kills in the whole match');
  assert.ok(roundsFinished >= 1, `expected at least one finished round, got ${roundsFinished}`);
  assert.equal(
    match.mode.score.ct + match.mode.score.t,
    roundsFinished,
    'the score must count exactly the finished rounds',
  );
  assert.ok(
    match.actors.some((actor) => actor.deaths > 0),
    'somebody must have died',
  );

  // Nobody may end up embedded in the geometry.
  for (const actor of match.actors) {
    const probe = map.collision.traceHull(HULL_STANDING, actor.move.origin, actor.move.origin);
    assert.equal(probe.allsolid, false, `${actor.name} ended up inside geometry`);
  }
});

test('bots turn to face a visible enemy and open fire', () => {
  const map = makeTestRoom(512, 256);
  const graph = buildNavGraph(map.collision, map.bounds, { cellSize: 64 });
  // 功能：由静止的 T 玩家充当观测目标，避免准确性提升后敌方 BOT 先开枪结束测试。时间：2026-09-30；作者：lq。
  const match = new Match({ map, graph, sites: [], teamSize: 2, skill: 0.8, seed: 99, playerTeam: 't' });
  match.startNow(0);

  // Freeze time: nothing may move or shoot yet, so skip past warmup + freeze
  // before expecting a firefight (this is exactly what CS does).
  let warmup = 0;
  for (let tick = 0; tick < 64 * 12 && match.mode.phase !== 'live'; tick++) {
    warmup += TICK_INTERVAL;
    match.update(warmup, { buttons: 0, forwardmove: 0, sidemove: 0, upmove: 0, yaw: 0, pitch: 0 });
  }
  assert.equal(match.mode.phase, 'live', 'the round should go live');

  // Put a CT bot and a T bot in the open, facing each other.
  const ct = match.actors.find((a) => a.team === 'ct' && a.isBot)!;
  const t = match.player!;
  ct.move.origin = v3(-200, 0, 36);
  t.move.origin = v3(200, 0, 36);
  ct.yaw = 0;
  t.yaw = 180;
  ct.alive = true;
  t.alive = true;
  for (const other of match.actors) {
    if (other !== ct && other !== t) other.alive = false;
  }

  const startAmmo = ct.combat.current().ammo;
  let now = warmup;
  let shots = 0;
  for (let tick = 0; tick < 64 * 4; tick++) {
    now += TICK_INTERVAL;
    const events = match.update(now, {
      buttons: 0,
      forwardmove: 0,
      sidemove: 0,
      upmove: 0,
      yaw: 0,
      pitch: 0,
    });
    shots += events.shots.filter((shot) => shot.shooter === ct).length;
  }

  assert.ok(shots > 0, 'the CT bot never fired at the enemy in front of it');
  assert.ok(ct.combat.current().ammo < startAmmo, 'firing should consume ammo');
  void aimDirection;
});

// 功能：验证阵亡枪械会留在地面，并能被存活角色拾取到原有弹药状态。时间：2026-09-29；作者：lq。
test('阵亡枪械可掉落并被拾取', () => {
  const map = makeTestRoom(512, 256);
  const match = new Match({ map, graph: null, sites: [], teamSize: 1, seed: 7 });
  match.startNow(0);
  match.mode.phase = 'live';
  const player = match.player!;
  // 功能：枪械掉落用例显式装备主武器，避免依赖本地玩家出生的 P228。时间：2026-09-30；作者：lq。
  player.combat.selectSlot(1, 0);
  player.combat.current().ammo = 11;
  const dropped = match.dropCurrentWeapon(player, 1);
  assert.ok(dropped);
  assert.equal(dropped!.weapon.id, 'm4a1');
  assert.equal(player.combat.loadout[1].id, 'knife');
  assert.equal(match.pickupNearestWeapon(player, 1.1), null, 'pickup has a short spawn protection window');
  const picked = match.pickupNearestWeapon(player, 1.5);
  assert.ok(picked);
  assert.equal(player.combat.current().id, 'm4a1');
  assert.equal(player.combat.current().ammo, 11);
  assert.equal(match.droppedWeapons.length, 0);
});

// 功能：验证选匪后本地角色归属正确，双方各自只使用四套经典皮肤且每套恰好出现一次。时间：2026-09-29；作者：lq。
test('team selection keeps four classic skins on each side', () => {
  const match = new Match({ map: makeTestRoom(), graph: null, sites: [], teamSize: 4, playerTeam: 't', seed: 23 });
  assert.equal(match.player?.team, 't');
  assert.equal(match.player?.isBot, false);
  for (const team of ['ct', 't'] as const) {
    const members = match.actors.filter((actor) => actor.team === team);
    assert.equal(members.length, 4);
    assert.deepEqual(members.map((actor) => actor.skinIndex).sort(), [0, 1, 2, 3]);
  }
});

// 功能：验证 B31、B42 和 B83～B85 的经典购买数字序列会映射到正确阵营与装备。时间：2026-09-29；作者：lq。
test('classic numeric buy menu keeps team rifle and grenade positions', () => {
  const itemAt = (team: 'ct' | 't', category: 'smgs' | 'rifles' | 'equipment', digit: number) =>
    buyMenuOptions(team, category).find((option) => option.digit === digit)?.item.id;
  assert.equal(itemAt('ct', 'smgs', 1), 'mp5navy');
  assert.equal(itemAt('t', 'smgs', 1), 'mp5navy');
  assert.equal(itemAt('ct', 'rifles', 2), 'm4a1');
  assert.equal(itemAt('t', 'rifles', 2), 'ak47');
  assert.equal(itemAt('ct', 'equipment', 3), 'flashbang');
  assert.equal(itemAt('ct', 'equipment', 4), 'hegrenade');
  assert.equal(itemAt('ct', 'equipment', 5), 'smokegrenade');
  assert.equal(itemAt('t', 'equipment', 7), undefined);
});

// 功能：验证手雷拔销、松键投出、抛物线落地弹跳以及引信到时在落点爆炸的完整流程。时间：2026-09-29；作者：lq。
test('grenade flies, bounces and explodes at its final world position', () => {
  const map = makeTestRoom(2048);
  map.spawns = [
    { origin: v3(-700, 0, 40), yaw: 90, team: 'ct' },
    { origin: v3(700, 0, 40), yaw: 180, team: 't' },
  ];
  const match = new Match({ map, graph: null, sites: [], teamSize: 1, seed: 41 });
  match.startNow();
  match.mode.phase = 'live';
  match.mode.timeLeft = 115;
  const player = match.player!;
  // 功能：使用开局的无限手雷库存，验证投掷不会消耗。时间：2026-09-30；作者：lq。
  player.selectedGrenade = 'hegrenade';
  // 功能：远处 BOT 只持刀，使此测试聚焦投掷物物理而不受交火结果干扰。时间：2026-09-29；作者：lq。
  match.actors.find((actor) => actor.team === 't')!.combat.selectSlot(3, 0);
  let now = 0;
  const command = idleCommand(90);
  command.buttons = IN_ATTACK;
  for (let i = 0; i < 48; i++) match.update(now += TICK_INTERVAL, command);
  assert.equal(player.grenadeAction, 'hold');
  command.buttons = 0;
  match.update(now += TICK_INTERVAL, command);
  assert.equal(match.grenadeProjectiles.length, 1);
  assert.equal(player.grenades.hegrenade, Infinity);
  const start = { ...match.grenadeProjectiles[0]!.position };
  let moved = false;
  let bounced = false;
  let explosion = null as ReturnType<typeof match.update>['grenades'][number] | null;
  for (let i = 0; i < 125 && !explosion; i++) {
    const events = match.update(now += TICK_INTERVAL, command);
    const projectile = match.grenadeProjectiles[0];
    if (projectile && Math.hypot(projectile.position.x - start.x, projectile.position.y - start.y) > 20) moved = true;
    if (events.grenadeBounces.length > 0) bounced = true;
    explosion = events.grenades[0] ?? null;
  }
  assert.equal(moved, true);
  assert.equal(bounced, true);
  assert.equal(explosion?.kind, 'hegrenade');
  assert.equal(match.grenadeProjectiles.length, 0);
  assert.ok(explosion!.position.z < start.z, 'the blast should occur after falling to the ground');
  // 功能：水平投掷至少前进 600 单位，防止重力或摩擦回归到脚边爆炸的问题。时间：2026-09-30；作者：lq。
  assert.ok(Math.hypot(explosion!.position.x - start.x, explosion!.position.y - start.y) > 600);
});

// 功能：验证最后一发触发的自动换弹从战斗层传到对局事件，供音频层按时播放退匣等声音。时间：2026-09-29；作者：lq。
test('auto reload reaches the match audio event stream', () => {
  const match = new Match({ map: makeTestRoom(2048), graph: null, sites: [], teamSize: 1, seed: 31 });
  match.startNow();
  match.mode.phase = 'live';
  const player = match.player!;
  // 功能：自动换弹用例显式装备主武器，确保验证对象为 M4A1。时间：2026-09-30；作者：lq。
  player.combat.selectSlot(1, 0);
  player.combat.current().ammo = 1;
  const command = idleCommand(0);
  command.buttons = IN_ATTACK;
  const events = match.update(1, command);
  assert.equal(events.shots.some((shot) => shot.shooter === player), true);
  assert.deepEqual(events.reloads.filter((reload) => reload.actor === player).map((reload) => reload.weapon), ['m4a1']);
});

// 功能：验证冻结阶段 BOT 按首回合经济随机购买手枪，阵亡后有钱可换购本阵营主武器。时间：2026-09-29；作者：lq。
test('bots buy affordable classic weapons at round start', () => {
  const match = new Match({ map: makeTestRoom(2048), graph: null, sites: [], teamSize: 4, seed: 99 });
  match.startNow();
  const bots = match.actors.filter((actor) => actor.isBot);
  assert.equal(bots.length, 7);
  assert.ok(bots.every((actor) => actor.combat.activeSlot === 2));
  assert.ok(bots.every((actor) => actor.combat.current().id !== (actor.team === 'ct' ? 'usp45' : 'glock18')));
  assert.ok(bots.every((actor) => actor.money < 800));

  const terrorist = bots.find((actor) => actor.team === 't')!;
  terrorist.money = 5000;
  terrorist.alive = false;
  match.mode.phase = 'over';
  match.mode.timeLeft = 0;
  match.update(10, idleCommand(0));
  assert.equal(terrorist.alive, true);
  assert.equal(terrorist.diedAt, -99);
  assert.equal(terrorist.combat.activeSlot, 1);
  assert.ok(['mac10', 'mp5navy', 'ump45', 'p90', 'm3', 'xm1014', 'scout', 'ak47', 'sg552', 'awp', 'g3sg1'].includes(terrorist.combat.current().id));
  assert.ok(terrorist.money < 5000);
});

// 功能：验证两个阵营本地玩家每回合获得无限三种手雷与无限备用弹药，BOT 库存保持有限。时间：2026-09-30；作者：lq。
test('local player starts with infinite grenades and reserve ammo on either team', () => {
  for (const playerTeam of ['ct', 't'] as const) {
    const match = new Match({ map: makeTestRoom(2048), graph: null, sites: [], teamSize: 1, seed: 100, playerTeam });
    match.startNow();
    const player = match.player!;
    // 功能：两个阵营的本地玩家出生均已装备 B14 的 P228“小白银”。时间：2026-09-30；作者：lq。
    assert.equal(player.combat.current().id, 'p228');
    assert.equal(player.combat.activeSlot, 2);
    assert.equal(player.unlimitedAmmo, true);
    assert.deepEqual(player.grenades, { hegrenade: Infinity, flashbang: Infinity, smokegrenade: Infinity });
    assert.equal(player.combat.loadout[1].reserve, Infinity);
    assert.equal(player.combat.loadout[2].reserve, Infinity);
    assert.ok(match.actors.filter((actor) => actor.isBot).every((actor) => Object.values(actor.grenades).every(Number.isFinite)));
  }
});
