/**
 * Weapon system tests.
 *
 * Everything here runs headless: the accuracy model, the spray pattern, the
 * damage/armor formulas and the fire/reload/switch state machine are all pure
 * functions plus a simulated clock, so the "feel" is pinned down by assertions
 * instead of by eyeballing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { v3 } from '../src/engine/math.ts';
import { BrushWorld } from '../src/engine/collision/brush.ts';
import type { BoxDef } from '../src/engine/collision/brush.ts';
import {
  WEAPONS,
  accuracyCone,
  applyRecoil,
  decayPunch,
  reloadDuration,
  spreadOffset,
} from '../src/game/weapons.ts';
import {
  CombatSystem,
  aimDirection,
  applyArmor,
  damageAtDistance,
  makeWeaponRuntime,
} from '../src/game/combat.ts';
import type { ShooterState } from '../src/game/combat.ts';
import { IN_ATTACK, IN_ATTACK2, IN_RELOAD, TICK_INTERVAL } from '../src/game/constants.ts';

function box(mins: [number, number, number], maxs: [number, number, number]): BoxDef {
  return { mins: v3(...mins), maxs: v3(...maxs), material: 'concrete', solid: true };
}

/** A closed room so shots hit something. */
const ROOM = new BrushWorld(
  BrushWorld.fromBoxes([
    box([-256, -256, -16], [256, 256, 0]),
    box([-272, -272, 0], [256, -256, 256]),
    box([-272, 256, 0], [256, 272, 256]),
    box([-272, -272, 0], [-256, 272, 256]),
    box([256, -272, 0], [272, 272, 256]),
  ]).brushes,
);

const EYE: ShooterState = {
  eye: v3(0, 0, 36),
  pitch: 0,
  yaw: 0,
  speed: 0,
  onGround: true,
  ducked: false,
};

function shooter(partial: Partial<ShooterState> = {}): ShooterState {
  return { ...EYE, eye: v3(EYE.eye.x, EYE.eye.y, EYE.eye.z), ...partial };
}

// ------------------------------------------------------------------- tables

test('weapon table matches the CS 1.5 numbers we care about', () => {
  assert.equal(WEAPONS.ak47.magSize, 30);
  assert.equal(WEAPONS.m4a1.magSize, 30);
  assert.equal(WEAPONS.awp.magSize, 10);
  assert.equal(WEAPONS.deagle.magSize, 7);
  assert.equal(WEAPONS.usp45.magSize, 12);
  assert.equal(WEAPONS.glock18.magSize, 20);

  // Weapon max speeds decide how fast the player moves while holding it.
  assert.equal(WEAPONS.ak47.maxSpeed, 221);
  assert.equal(WEAPONS.m4a1.maxSpeed, 230);
  assert.equal(WEAPONS.awp.maxSpeed, 210);
  assert.equal(WEAPONS.deagle.maxSpeed, 230);

  // The AWP is a one-shot-kill body shot on an unarmoured target.
  assert.ok(WEAPONS.awp.damage >= 100, 'AWP should one-shot the chest');
  assert.ok(WEAPONS.ak47.damage > WEAPONS.m4a1.damage, 'AK hits harder than M4');
  assert.ok(WEAPONS.ak47.cycleTime > WEAPONS.m4a1.cycleTime, 'AK fires slower than M4');

  for (const [id, weapon] of Object.entries(WEAPONS)) {
    // 功能：投掷装备独立测试；闪光弹和烟雾弹不应被当成有伤害的枪械。时间：2026-09-29；作者：lq。
    if (weapon.slot === 4) continue;
    assert.ok(weapon.damage > 0, `${id} damage`);
    assert.ok(weapon.cycleTime > 0, `${id} cycle time`);
    assert.ok(weapon.sounds.fire.length > 0, `${id} has a fire sound`);
    assert.ok(weapon.range > 0, `${id} range`);
  }
});

// ----------------------------------------------------------------- accuracy

test('the accuracy cone widens with movement and narrows when crouched', () => {
  const ak = WEAPONS.ak47;
  const still = accuracyCone(ak, { speed: 0, onGround: true, ducked: false, scoped: false, timeSinceLastShot: 99 });
  const walking = accuracyCone(ak, { speed: 100, onGround: true, ducked: false, scoped: false, timeSinceLastShot: 99 });
  const running = accuracyCone(ak, { speed: 250, onGround: true, ducked: false, scoped: false, timeSinceLastShot: 99 });
  const air = accuracyCone(ak, { speed: 250, onGround: false, ducked: false, scoped: false, timeSinceLastShot: 99 });
  const crouched = accuracyCone(ak, { speed: 0, onGround: true, ducked: true, scoped: false, timeSinceLastShot: 99 });

  assert.ok(still < walking, `still ${still} should beat walking ${walking}`);
  assert.ok(walking < running, 'walking should beat running');
  assert.ok(running < air, 'running should beat jumping');
  assert.ok(crouched < still, 'crouching should be the most accurate');
});

test('the first shot after a pause is tighter than a sustained one', () => {
  const ak = WEAPONS.ak47;
  const quiet = accuracyCone(ak, { speed: 0, onGround: true, ducked: false, scoped: false, timeSinceLastShot: 5 });
  const spraying = accuracyCone(ak, { speed: 0, onGround: true, ducked: false, scoped: false, timeSinceLastShot: 0.05 });
  assert.ok(quiet < spraying, `first shot ${quiet} should be tighter than spray ${spraying}`);
});

test('scoping collapses the AWP cone', () => {
  const awp = WEAPONS.awp;
  const hip = accuracyCone(awp, { speed: 0, onGround: true, ducked: false, scoped: false, timeSinceLastShot: 5 });
  const scoped = accuracyCone(awp, { speed: 0, onGround: true, ducked: false, scoped: true, timeSinceLastShot: 5 });
  assert.ok(scoped < hip * 0.1, `scoped cone ${scoped} should be far tighter than ${hip}`);
  // ... and it only applies to weapons that can scope.
  const akScoped = accuracyCone(WEAPONS.ak47, { speed: 0, onGround: true, ducked: false, scoped: true, timeSinceLastShot: 5 });
  const akHip = accuracyCone(WEAPONS.ak47, { speed: 0, onGround: true, ducked: false, scoped: false, timeSinceLastShot: 5 });
  assert.equal(akScoped, akHip);
});

// ------------------------------------------------------------------- recoil

test('the AK spray climbs first, then wanders sideways', () => {
  const ak = WEAPONS.ak47;
  let punch = { pitch: 0, yaw: 0 };
  const pitches: number[] = [];
  const yaws: number[] = [];

  for (let shot = 0; shot < 18; shot++) {
    punch = applyRecoil(punch, ak, shot);
    pitches.push(punch.pitch);
    yaws.push(punch.yaw);
  }

  // GoldSrc pitch is positive-down, so recoil makes the value more negative.
  // 功能：AK 站立首发回弹约 1°，后续连发继续抬升，符合原版 KickBack 基线。时间：2026-09-30；作者：lq。
  assert.ok(pitches[0]! <= -0.9 && pitches[0]! >= -1.1, `first shot should kick about 1°, got ${pitches[0]}`);
  assert.ok(pitches[3]! < pitches[0]!, 'the climb should continue early on');
  // Later shots pull left (negative yaw) after drifting right.
  assert.ok(Math.max(...yaws) > 0.5, 'the pattern should drift right at some point');
  assert.ok(Math.min(...yaws) < -0.5, 'and then pull left');
  // The punch is clamped.
  for (const value of [...pitches, ...yaws]) {
    assert.ok(Math.abs(value) <= ak.recoil.maxPunch + 1e-6, `punch ${value} exceeds the cap`);
  }
  assert.ok(yaws.every((value) => Math.abs(value) <= ak.recoil.maxYawPunch! + 1e-6));
});

test('very long bursts stay finite and inside the punch cap', () => {
  const ak = WEAPONS.ak47;
  let punch = { pitch: 0, yaw: 0 };
  for (let shot = 0; shot < 300; shot++) {
    punch = applyRecoil(punch, ak, shot);
    assert.ok(Number.isFinite(punch.pitch) && Number.isFinite(punch.yaw), `NaN at shot ${shot}`);
    assert.ok(Math.abs(punch.pitch) <= ak.recoil.maxPunch + 1e-6, `pitch escaped the cap at ${shot}`);
    assert.ok(Math.abs(punch.yaw) <= ak.recoil.maxPunch + 1e-6, `yaw escaped the cap at ${shot}`);
  }
  assert.ok(Math.abs(punch.pitch) + Math.abs(punch.yaw) > 0, 'recoil must keep applying');
});

test('punch recovers to zero', () => {
  const ak = WEAPONS.ak47;
  let punch = { pitch: -8, yaw: 4 };
  for (let i = 0; i < 200; i++) punch = decayPunch(punch, ak, 1 / 64);
  assert.equal(punch.pitch, 0);
  assert.equal(punch.yaw, 0);
});

// ------------------------------------------------------------------- spread

test('spread stays inside the cone and is deterministic per seed', () => {
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

  const cone = 3.5;
  const rand = mulberry32(1234);
  let maxRadius = 0;
  for (let i = 0; i < 500; i++) {
    const offset = spreadOffset(cone, rand);
    const radius = Math.hypot(offset.yaw, offset.pitch);
    assert.ok(radius <= cone + 1e-9, `spread ${radius} escaped the ${cone}° cone`);
    maxRadius = Math.max(maxRadius, radius);
  }
  assert.ok(maxRadius > cone * 0.6, 'the distribution should reach the cone edge');

  const a = spreadOffset(2, mulberry32(7));
  const b = spreadOffset(2, mulberry32(7));
  assert.deepEqual(a, b, 'same seed, same spread');

  assert.deepEqual(spreadOffset(0, Math.random), { yaw: 0, pitch: 0 });
});

test('aimDirection matches the GoldSrc angle convention', () => {
  const forwardX = aimDirection(0, 0);
  assert.ok(Math.abs(forwardX.x - 1) < 1e-9 && Math.abs(forwardX.y) < 1e-9);

  const forwardY = aimDirection(0, 90);
  assert.ok(Math.abs(forwardY.y - 1) < 1e-9, 'yaw 90 points along +Y');

  const down = aimDirection(90, 0);
  assert.ok(Math.abs(down.z + 1) < 1e-9, 'positive pitch looks down');
});

// ------------------------------------------------------------------- damage

test('damage falls off with distance and scales with hitgroup', () => {
  const ak = WEAPONS.ak47;
  const pointBlank = damageAtDistance(ak, 0, 'chest');
  const far = damageAtDistance(ak, 3000, 'chest');
  assert.ok(Math.abs(pointBlank - ak.damage) < 1e-9);
  assert.ok(far < pointBlank, 'damage must drop off');
  assert.ok(far > pointBlank * 0.7, 'but only gently for a rifle');

  const head = damageAtDistance(ak, 500, 'head');
  const chest = damageAtDistance(ak, 500, 'chest');
  const leg = damageAtDistance(ak, 500, 'leg');
  assert.ok(head > chest * 3.5, 'headshots multiply hard');
  assert.ok(leg < chest, 'legs take less');
});

test('armor absorbs damage and is consumed; empty armor lets it through', () => {
  const ak = WEAPONS.ak47;
  const raw = damageAtDistance(ak, 0, 'chest');

  const withArmor = applyArmor(raw, ak.armorRatio, 100);
  assert.ok(withArmor.damage < raw, 'armor should reduce damage');
  assert.ok(withArmor.armor < 100, 'armor should be consumed');
  assert.ok(withArmor.armor >= 0);

  const noArmor = applyArmor(raw, ak.armorRatio, 0);
  assert.equal(noArmor.damage, raw);
  assert.equal(noArmor.armor, 0);

  // A nearly broken vest absorbs a little and passes the rest.
  const broken = applyArmor(raw, ak.armorRatio, 3);
  assert.equal(broken.armor, 0);
  assert.ok(broken.damage > withArmor.damage, 'less armor means more damage through');
  assert.ok(broken.damage <= raw);
});

// --------------------------------------------------------------- fire logic

test('a rifle fires at its cycle rate while the trigger is held', () => {
  const combat = new CombatSystem({ 1: 'ak47', 2: 'usp45', 3: 'knife' }, 42);
  let now = 1; // past the deploy time
  let shots = 0;
  for (let i = 0; i < 64; i++) {
    const events = combat.tick(shooter(), ROOM, IN_ATTACK, now, TICK_INTERVAL);
    shots += events.shots.length;
    now += TICK_INTERVAL;
  }
  // 1 second of AK fire at 0.1 s per shot => about 10 shots.
  assert.ok(shots >= 9 && shots <= 11, `expected ~10 shots per second, got ${shots}`);
  assert.equal(combat.current().ammo, 30 - shots);
});

test('a pistol is semi-automatic: one shot per click', () => {
  const combat = new CombatSystem({ 1: 'ak47', 2: 'usp45', 3: 'knife' }, 42);
  combat.selectSlot(2, 0);
  let now = 2;
  let shots = 0;

  // Holding the button fires exactly once.
  for (let i = 0; i < 32; i++) {
    const events = combat.tick(shooter(), ROOM, IN_ATTACK, now, TICK_INTERVAL);
    shots += events.shots.length;
    now += TICK_INTERVAL;
  }
  assert.equal(shots, 1, 'holding the trigger must not auto-fire a pistol');

  // Release, then click again: one more shot.
  combat.tick(shooter(), ROOM, 0, now, TICK_INTERVAL);
  now += TICK_INTERVAL;
  let more = 0;
  for (let i = 0; i < 32; i++) {
    const events = combat.tick(shooter(), ROOM, IN_ATTACK, now, TICK_INTERVAL);
    more += events.shots.length;
    now += TICK_INTERVAL;
  }
  assert.equal(more, 1, 'the second click should fire exactly one more round');
});

// 功能：验证最后一发后自动换弹、换弹期间禁止射击，并在加快的动作结束后补入弹药。时间：2026-09-29；作者：lq。
test('empty magazine automatically reloads from reserve', () => {
  const combat = new CombatSystem({ 1: 'glock18', 2: 'usp45', 3: 'knife' }, 7);
  let now = 2;
  const mag = WEAPONS.glock18.magSize;
  let automatic = null as string | null;

  for (let shot = 0; shot < mag; shot++) {
    const events = combat.tick(shooter(), ROOM, IN_ATTACK, now, TICK_INTERVAL);
    automatic = events.reloadStarted ?? automatic;
    combat.tick(shooter(), ROOM, 0, now + 0.001, TICK_INTERVAL); // release for semi-auto
    now += 0.2;
  }
  assert.equal(combat.current().ammo, 0);
  assert.equal(automatic, 'glock18');
  assert.ok(combat.current().reloadEndTime > now);
  assert.ok(reloadDuration('glock18') < WEAPONS.glock18.reloadTime);
  assert.equal(combat.tick(shooter(), ROOM, IN_ATTACK, now, TICK_INTERVAL).shots.length, 0);

  const reserveBefore = combat.current().reserve;
  now += reloadDuration('glock18') + 0.05;
  const finished = combat.tick(shooter(), ROOM, 0, now, TICK_INTERVAL);
  assert.equal(finished.reloadFinished, 'glock18');
  assert.equal(combat.current().ammo, mag);
  assert.equal(combat.current().reserve, reserveBefore - mag);
});

// 功能：保留 R 键主动换弹与彻底耗尽备弹时的空仓提示。时间：2026-09-29；作者：lq。
test('manual reload still works and no reserve still dry-fires', () => {
  const combat = new CombatSystem({ 1: 'glock18', 2: 'usp45', 3: 'knife' }, 7);
  combat.tick(shooter(), ROOM, IN_ATTACK, 2, TICK_INTERVAL);
  const manual = combat.tick(shooter(), ROOM, IN_RELOAD, 2.2, TICK_INTERVAL);
  assert.equal(manual.reloadStarted, 'glock18');
  combat.current().reloadEndTime = 0;
  combat.current().ammo = 0;
  combat.current().reserve = 0;
  const dry = combat.tick(shooter(), ROOM, IN_ATTACK, 3, TICK_INTERVAL);
  assert.equal(dry.dryFire, true);
  assert.equal(dry.reloadStarted, null);
});

test('the knife never runs out of ammo and stabs harder', () => {
  const combat = new CombatSystem({ 1: 'ak47', 2: 'usp45', 3: 'knife' }, 3);
  combat.selectSlot(3, 0);
  let now = 2;

  const slash = combat.tick(shooter(), ROOM, IN_ATTACK, now, TICK_INTERVAL);
  assert.equal(slash.shots.length, 1);
  // 功能：左右键击打事件分别驱动挥砍和刺击原版动作序列。时间：2026-09-29；作者：lq。
  assert.equal(slash.shots[0]!.alternate, false);
  const slashDamage = slash.shots[0]!.damage;
  assert.equal(combat.current().ammo, 1, 'knife ammo is not consumed');

  // Wait out the cycle and stab.
  now += 1.5;
  const stab = combat.tick(shooter(), ROOM, IN_ATTACK2, now, TICK_INTERVAL);
  assert.equal(stab.shots.length, 1);
  assert.equal(stab.shots[0]!.alternate, true);
  assert.ok(stab.shots[0]!.damage > slashDamage * 3, 'the stab should hit far harder');
});

test('shots trace the world and report hits and normals', () => {
  const combat = new CombatSystem({ 1: 'ak47', 2: 'usp45', 3: 'knife' }, 11);
  const events = combat.tick(shooter({ yaw: 0 }), ROOM, IN_ATTACK, 2, TICK_INTERVAL);
  assert.equal(events.shots.length, 1);
  const shot = events.shots[0]!;
  assert.equal(shot.hit, true, 'the east wall is 256 units away');
  assert.ok(shot.distance > 200 && shot.distance < 260, `distance was ${shot.distance}`);
  assert.ok(shot.normal.x < -0.9, `expected the wall normal to face us, got ${JSON.stringify(shot.normal)}`);

  // A weapon with nothing in front reports a miss at maximum range.
  const open = new BrushWorld([]);
  const miss = combat.tick(shooter(), open, 0, 3, TICK_INTERVAL).shots;
  void miss;
  const combat2 = new CombatSystem({ 1: 'ak47', 2: 'usp45', 3: 'knife' }, 12);
  const sky = combat2.tick(shooter(), open, IN_ATTACK, 2, TICK_INTERVAL).shots[0]!;
  assert.equal(sky.hit, false);
  assert.ok(sky.distance > 8000, 'an unobstructed bullet should travel its full range');
});

test('switching weapons takes time before you can shoot', () => {
  const combat = new CombatSystem({ 1: 'ak47', 2: 'usp45', 3: 'knife' }, 5);
  const switched = combat.selectSlot(2, 10);
  assert.equal(switched?.switchedTo, 'usp45');

  // Immediately after the switch the weapon is still coming up.
  const tooEarly = combat.tick(shooter(), ROOM, IN_ATTACK, 10.05, TICK_INTERVAL);
  assert.equal(tooEarly.shots.length, 0, 'cannot fire while deploying');

  // Release the trigger first: a pistol needs a fresh click.
  combat.tick(shooter(), ROOM, 0, 10 + WEAPONS.usp45.deployTime, TICK_INTERVAL);
  const after = combat.tick(shooter(), ROOM, IN_ATTACK, 10 + WEAPONS.usp45.deployTime + 0.02, TICK_INTERVAL);
  assert.equal(after.shots.length, 1, 'and can fire once it is up');
});

test('recoil pushes the bullet direction, not just the camera', () => {
  const combat = new CombatSystem({ 1: 'ak47', 2: 'usp45', 3: 'knife' }, 99);
  let now = 2;
  const directions: number[] = [];
  for (let i = 0; i < 4; i++) {
    const events = combat.tick(shooter(), ROOM, IN_ATTACK, now, TICK_INTERVAL);
    const shot = events.shots[0]!;
    const dz = shot.end.z - shot.start.z;
    directions.push(dz);
    now += WEAPONS.ak47.cycleTime;
  }
  // The muzzle should climb: later shots end up higher than the first.
  assert.ok(directions[3]! > directions[0]!, `bullet path should climb: ${directions.join(', ')}`);
});

// 功能：确认 AWP 首发子弹先按准星发射、开枪后才抬升镜头，避免近距离瞄胸却打偏。时间：2026-09-30；作者：lq。
test('AWP first scoped shot follows the crosshair before recoil is applied', () => {
  const combat = new CombatSystem({ 1: 'awp', 2: 'usp45', 3: 'knife' }, 99);
  combat.current().scoped = true;
  const events = combat.tick(shooter(), new BrushWorld([]), IN_ATTACK, 2, TICK_INTERVAL);
  const shot = events.shots[0]!;
  const angle = Math.atan2(Math.hypot(shot.end.y - shot.start.y, shot.end.z - shot.start.z), shot.end.x - shot.start.x) * 180 / Math.PI;
  assert.ok(angle < 0.05, `first bullet deviated ${angle}° from the scoped crosshair`);
  assert.ok(events.punch.pitch <= -1.9, 'camera should kick after the bullet leaves');
});

// 功能：验证原版护甲不足时仅扣除剩余护甲值，不会发生双倍穿透。时间：2026-09-30；作者：lq。
test('partial armor uses the original damage remainder', () => {
  const result = applyArmor(100, 0.5, 10);
  assert.equal(result.damage, 90);
  assert.equal(result.armor, 0);
});

test('runtime starts loaded with the right magazine size', () => {
  const ak = makeWeaponRuntime('ak47');
  assert.equal(ak.ammo, 30);
  assert.ok(ak.reserve > 0);
  const knife = makeWeaponRuntime('knife');
  assert.equal(knife.reserve, 0);
  assert.equal(knife.reloadEndTime, 0);
});
