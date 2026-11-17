/** 功能：验证厚墙/门穿透、金属阻弹、墙后扣血、BSP 材质与局域网事件，防止只显示穿墙而不实际伤人；时间：2026-11-17；作者：lq。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { v3 } from '../src/engine/math.ts';
import { BrushWorld, type BoxDef } from '../src/engine/collision/brush.ts';
import { HULL_STANDING } from '../src/engine/collision/types.ts';
import { compileBsp } from '../src/engine/bsp/write.ts';
import { parseBsp } from '../src/engine/bsp/reader.ts';
import { BspCollisionWorld } from '../src/engine/bsp/collision.ts';
import { BspEntityWorld } from '../src/game/map/interactions.ts';
import { MoonbaseWorld } from '../src/game/map/moonbaseInteractions.ts';
import { traceBullet } from '../src/game/penetration.ts';
import { WEAPONS } from '../src/game/weapons.ts';
import { makeWeaponRuntime } from '../src/game/combat.ts';
import { makeTestRoom } from '../src/game/map/build.ts';
import { Match, idleCommand } from '../src/game/match.ts';
import { IN_ATTACK } from '../src/game/constants.ts';
import { encodeEvents, decodeEvents } from '../src/net/protocol.ts';

/** 功能：构造跨越射线的可指定厚度和材质的测试掩体；时间：2026-11-17；作者：lq。 */
function wall(material: string, depth = 64, x = 100, y = 0): BoxDef {
  return { mins: v3(x, y - 64, 0), maxs: v3(x + depth, y + 64, 128), material };
}

// 功能：普通厚墙和木门须能穿透，同时保留角色实体碰撞与原始墙面反馈；时间：2026-11-17；作者：lq。
test('rifles penetrate thick ordinary walls and doors with reduced damage', () => {
  for (const material of ['concrete', 'brick', 'stucco', 'wood', 'door', 'luna_shell']) {
    const world = BrushWorld.fromBoxes([wall(material)]);
    const path = traceBullet(world, WEAPONS.ak47, v3(0, 0, 60), v3(500, 0, 60));
    assert.equal(path.length, 2, material);
    assert.ok(path[0]!.end.x < 100);
    assert.ok(path[1]!.start.x >= 164 && path[1]!.start.x < 164.01);
    assert.equal(path[1]!.end.x, 500);
    assert.ok(path[1]!.damageScale > 0 && path[1]!.damageScale < 1);
    assert.ok(world.traceHull(HULL_STANDING, v3(0, 0, 36), v3(300, 0, 36)).fraction < 1);
  }
});

// 功能：铁箱和金属隔板须挡住步枪与 AWP，不能因为很薄而直接穿过；时间：2026-11-17；作者：lq。
test('metal cover blocks even sniper bullets and cannot hide behind a wooden surface', () => {
  for (const material of ['metal', 'steel_crate', 'iron', 'drkmtlt_flr01', 'luna_metal']) {
    const world = BrushWorld.fromBoxes([wall(material, 4)]);
    assert.equal(traceBullet(world, WEAPONS.awp, v3(0, 0, 60), v3(500, 0, 60)).length, 1, material);
  }
  const adjacent = BrushWorld.fromBoxes([wall('wood', 4), wall('steel', 4, 104)]);
  assert.equal(traceBullet(adjacent, WEAPONS.ak47, v3(0, 0, 60), v3(500, 0, 60)).length, 1);
});

// 功能：特别厚的实体、长距离和多层墙受到上限控制，墙内或射程末端不能生成穿透段；时间：2026-11-17；作者：lq。
test('penetration respects thickness, range, solid starts and layer limits', () => {
  const thick = BrushWorld.fromBoxes([wall('concrete', 256)]);
  assert.equal(traceBullet(thick, WEAPONS.awp, v3(0, 0, 60), v3(500, 0, 60)).length, 1);
  assert.equal(traceBullet(thick, WEAPONS.awp, v3(110, 0, 60), v3(500, 0, 60)).length, 1);
  assert.equal(traceBullet(BrushWorld.fromBoxes([wall('wood')]), WEAPONS.ak47, v3(0, 0, 60), v3(120, 0, 60)).length, 1);
  const far = BrushWorld.fromBoxes([wall('wood', 16, 5100)]);
  assert.equal(traceBullet(far, WEAPONS.ak47, v3(0, 0, 60), v3(7000, 0, 60)).length, 1);
  const layers = BrushWorld.fromBoxes([wall('wood', 8), wall('wood', 8, 200), wall('wood', 8, 300)]);
  const path = traceBullet(layers, WEAPONS.ak47, v3(0, 0, 60), v3(500, 0, 60));
  assert.equal(path.length, 3);
  assert.ok(path[2]!.end.x < 300 && path[2]!.hit);
  assert.ok(path[2]!.damageScale < path[1]!.damageScale);
});

// 功能：不同枪械保留穿透差异，刀和霰弹枪不能通过墙面伤人；时间：2026-11-17；作者：lq。
test('Deagle penetrates one wall while ordinary pistols, SMGs, shotguns and knife do not', () => {
  const world = BrushWorld.fromBoxes([wall('wood', 8), wall('wood', 8, 200)]);
  assert.equal(traceBullet(world, WEAPONS.deagle, v3(0, 0, 60), v3(500, 0, 60)).length, 2);
  for (const id of ['usp45', 'glock18', 'mp5navy', 'm3', 'xm1014', 'knife'] as const) {
    assert.equal(traceBullet(world, WEAPONS[id], v3(0, 0, 60), v3(500, 0, 60)).length, 1, id);
  }
});

// 功能：从真实 BSP 格式查询同平面不同多边形材质，防止铁箱被相邻墙面的贴图覆盖；时间：2026-11-17；作者：lq。
test('BSP penetration resolves the material of the actual face polygon', () => {
  const bsp = parseBsp(compileBsp({ boxes: [wall('wood', 64), wall('steel', 64, 100, 160)], spawns: [] }).buffer);
  const world = new BspCollisionWorld(bsp);
  assert.equal(world.surfaceMaterial(v3(100, 0, 60), v3(-1, 0, 0)), 'wood');
  assert.equal(world.surfaceMaterial(v3(100, 160, 60), v3(-1, 0, 0)), 'steel');
  assert.equal(traceBullet(world, WEAPONS.ak47, v3(0, 0, 60), v3(500, 0, 60)).length, 2);
  assert.equal(traceBullet(world, WEAPONS.awp, v3(0, 160, 60), v3(500, 160, 60)).length, 1);
});

// 功能：动态 BSP 门和月球气闸沿用实体碰撞，子弹独立获得可穿透弹道；时间：2026-11-17；作者：lq。
test('dynamic BSP doors and moonbase airlocks allow bullet penetration', () => {
  const bsp = parseBsp(compileBsp({ boxes: [wall('wood', 16)], spawns: [] }).buffer);
  const doorModel = bsp.models[0]!;
  // 功能：编译器给世界模型留有外部边距；门子模型包围盒必须使用真实门体尺寸；时间：2026-11-17；作者：lq。
  doorModel.mins = v3(100, -64, 0);
  doorModel.maxs = v3(116, 64, 128);
  bsp.models.unshift({ ...doorModel, headnode: [-1, -1, -1, -1], numfaces: 0 });
  bsp.entityList.push({ classname: 'func_door', origin: v3(), angle: 0, properties: { model: '*1', angle: '90' } });
  const world = new BspEntityWorld(bsp);
  assert.equal(traceBullet(world, WEAPONS.ak47, v3(0, 0, 60), v3(500, 0, 60)).length, 2);
  const moon = new MoonbaseWorld([], () => 800);
  moon.reset();
  assert.equal(traceBullet(moon, WEAPONS.ak47, v3(-900, 0, 60), v3(-500, 0, 60)).length, 2);
});

/** 功能：创建人物在墙前或墙后的完整对局，让公共 update 流程实际执行穿墙和扣血；时间：2026-11-17；作者：lq。 */
function fireAtCover(material?: string, targetX = 300, multiplayer = false) {
  const map = makeTestRoom(2048);
  if (material) map.boxes.push(wall(material));
  map.collision = BrushWorld.fromBoxes(map.boxes);
  const match = new Match({ map, graph: null, sites: [], teamSize: 1, multiplayer, seed: 17 });
  match.startNow();
  match.mode.phase = 'live';
  const player = multiplayer ? match.claimSeat('ct', 'Shooter')! : match.player!;
  const target = multiplayer ? match.claimSeat('t', 'Target')! : match.actors.find((actor) => actor.team !== player.team)!;
  player.move.origin = v3(0, 0, 36);
  player.combat.selectSlot(1, 0);
  player.combat.loadout[1] = makeWeaponRuntime('ak47');
  target.move.origin = v3(targetX, 0, 36);
  target.armor = 0;
  target.isBot = false;
  const command = { ...idleCommand(0), buttons: IN_ATTACK };
  const events = multiplayer ? match.update(2, undefined, new Map([[player.id, command]])) : match.update(2, command);
  const resolved = events.shots.find((event) => event.shooter === player)!;
  return { match, player, target, events, resolved };
}

// 功能：墙后目标必须实际扣血，并且同距离的穿墙伤害少于无遮挡伤害；时间：2026-11-17；作者：lq。
test('match applies reduced damage behind thick walls and stops damage at iron cover', () => {
  const clear = fireAtCover();
  const covered = fireAtCover('concrete');
  assert.equal(covered.resolved.victim, covered.target);
  assert.ok(covered.resolved.damage > 0 && covered.resolved.damage < clear.resolved.damage);
  assert.ok(covered.resolved.shot.distance > 280 && covered.resolved.shot.distance < 300);
  assert.ok(covered.target.health < 100);
  const iron = fireAtCover('steel');
  assert.equal(iron.resolved.victim, null);
  assert.equal(iron.target.health, 100);
  const before = fireAtCover('concrete', 50);
  assert.equal(before.resolved.victim, before.target);
  assert.ok(before.resolved.damage > covered.resolved.damage);
});

// 功能：通过房主权威输入和 JSON 事件往返验证，确保局域网不会丢失穿墙伤害和弹孔段；时间：2026-11-17；作者：lq。
test('LAN authoritative shots preserve penetration hits and feedback through JSON', () => {
  const { match, target, events, resolved } = fireAtCover('wood', 300, true);
  assert.equal(resolved.victim, target);
  assert.ok(resolved.damage > 0);
  const wire = JSON.parse(JSON.stringify(encodeEvents(events)));
  const restored = decodeEvents(wire, match.actors, match.critters).shots.find((shot) => shot.victim === target)!;
  assert.equal(restored.damage, resolved.damage);
  assert.deepEqual(restored.shot.segments, resolved.shot.segments);
});
