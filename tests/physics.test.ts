/**
 * Headless physics tests.
 *
 * These exercise the GoldSrc movement port with no browser at all, which is the
 * only way to actually verify the maths. Run with: pnpm test
 * (Node 24+ strips the TypeScript types natively, so no build step is needed.)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { angleVectors, v3 } from '../src/engine/math.ts';
import { BrushWorld } from '../src/engine/collision/brush.ts';
import type { BoxDef } from '../src/engine/collision/brush.ts';
import type { CollisionWorld } from '../src/engine/collision/types.ts';
import { HULL_DUCKING, HULL_STANDING } from '../src/engine/collision/types.ts';
import { createMoveState, horizontalSpeed, pmPlayerMove } from '../src/game/movement.ts';
import type { MoveState, UserCmd } from '../src/game/movement.ts';
import { IN_DUCK, IN_FORWARD, IN_JUMP, IN_MOVERIGHT, TICK_INTERVAL } from '../src/game/constants.ts';

const DT = TICK_INTERVAL;
const TICK_MS = DT * 1000;

function box(mins: [number, number, number], maxs: [number, number, number]): BoxDef {
  return { mins: v3(...mins), maxs: v3(...maxs), material: 'concrete', solid: true };
}

function world(boxes: BoxDef[]): BrushWorld {
  return BrushWorld.fromBoxes(boxes);
}

function cmd(partial: Partial<UserCmd> = {}): UserCmd {
  return {
    msec: TICK_MS,
    buttons: 0,
    forwardmove: 0,
    sidemove: 0,
    upmove: 0,
    pitch: 0,
    yaw: 0,
    roll: 0,
    ...partial,
  };
}

function simulate(
  state: MoveState,
  collision: CollisionWorld,
  ticks: number,
  command: UserCmd,
  onTick?: (state: MoveState, tick: number) => void,
): void {
  for (let i = 0; i < ticks; i++) {
    pmPlayerMove(state, collision, command, DT);
    onTick?.(state, i);
  }
}

/** Floor of 512x512 whose top surface is z = 0. */
const FLOOR: BoxDef[] = [box([-256, -256, -16], [256, 256, 0])];

test('falls under gravity and lands with the feet on the floor', () => {
  const collision = world(FLOOR);
  const state = createMoveState(v3(0, 0, 200));
  simulate(state, collision, 200, cmd());

  assert.equal(state.onground, true, 'expected to be on the ground');
  // Hull is 72 tall with the origin in the middle, so the resting origin is 36.
  assert.ok(Math.abs(state.origin.z - 36) < 0.5, `resting z was ${state.origin.z}, want ~36`);
  assert.ok(Math.abs(state.velocity.z) < 1e-6, `z velocity should settle, got ${state.velocity.z}`);
});

test('does not walk through a wall', () => {
  const collision = world([...FLOOR, box([128, -64, 0], [144, 64, 128])]);
  const state = createMoveState(v3(0, 0, 36), 0);
  simulate(state, collision, 128, cmd({ buttons: IN_FORWARD, forwardmove: 400 }));

  // Front face of the hull is at origin.x + 16, the wall starts at x = 128.
  assert.ok(state.origin.x <= 128 - 16 + 0.5, `travelled to x=${state.origin.x}, expected to stop at ~112`);
  assert.ok(state.origin.x > 100, `should have walked up to the wall, got x=${state.origin.x}`);
});

test('walks up 16 unit stairs (stepsize 18) and reports step-ups', () => {
  const steps: BoxDef[] = [];
  for (let i = 0; i < 4; i++) {
    steps.push(box([i * 24, -64, 0], [(i + 1) * 24, 64, (i + 1) * 16]));
  }
  // A wide floor plus a landing at the top, so the player stays on solid
  // ground for the whole run instead of walking off the last step.
  const landing = box([96, -64, 0], [2048, 64, 64]);
  const collision = world([box([-512, -512, -16], [4096, 512, 0]), ...steps, landing]);
  const state = createMoveState(v3(-64, 0, 36), 0);

  let stepUps = 0;
  let peakZ = state.origin.z;
  simulate(state, collision, 160, cmd({ buttons: IN_FORWARD, forwardmove: 400 }), (s) => {
    stepUps += s.lastStepUps;
    if (s.origin.z > peakZ) peakZ = s.origin.z;
  });

  // Four 16 u risers => the top step sits at z = 64, so the origin reaches 100.
  assert.ok(peakZ >= 36 + 48, `should have climbed the stairs, peak z=${peakZ}`);
  assert.ok(state.origin.x > 40, `should have advanced along the stairs, x=${state.origin.x}`);
  assert.ok(stepUps > 0, 'expected PM_StepSlideMove to report step-ups');
  assert.equal(state.onground, true, 'should still be standing on the top step');
});

test('a 24 unit ledge blocks a walking player (above stepsize)', () => {
  const collision = world([...FLOOR, box([0, -64, 0], [96, 64, 24])]);
  const state = createMoveState(v3(-64, 0, 36), 0);
  simulate(state, collision, 128, cmd({ buttons: IN_FORWARD, forwardmove: 400 }));

  assert.ok(state.origin.x < -14, `should be stopped by the ledge, x=${state.origin.x}`);
  assert.ok(Math.abs(state.origin.z - 36) < 1, `should not have climbed, z=${state.origin.z}`);
});

test('slides along a wall when moving into it at 45 degrees', () => {
  const collision = world([...FLOOR, box([128, -256, 0], [144, 256, 128])]);
  const state = createMoveState(v3(0, 0, 36), 45); // yaw 45 = (+X, +Y)
  simulate(state, collision, 64, cmd({ buttons: IN_FORWARD, forwardmove: 400 }));

  assert.ok(state.origin.x <= 128 - 16 + 0.5, `should be stopped by the wall, x=${state.origin.x}`);
  assert.ok(state.origin.y > 100, `should keep sliding along the wall, y=${state.origin.y}`);
});

test('jump apex is the CS 1.5 45 units', () => {
  const collision = world(FLOOR);
  const state = createMoveState(v3(0, 0, 36));
  simulate(state, collision, 8, cmd()); // settle on the ground first

  const groundZ = state.origin.z;
  let peak = groundZ;
  simulate(state, collision, 128, cmd({ buttons: IN_JUMP }), (s) => {
    if (s.origin.z > peak) peak = s.origin.z;
  });

  const height = peak - groundZ;
  assert.ok(height > 42 && height < 46, `jump height was ${height.toFixed(2)} units, want ~45`);
});

test('air acceleration pushes past the ground max speed (strafe jumping)', () => {
  // No floor anywhere near: the player stays airborne.
  const collision = world([box([-256, -256, -4096], [256, 256, -2048])]);
  const state = createMoveState(v3(0, 0, 512), 0);
  state.velocity = v3(250, 0, 0);
  state.onground = false;

  const startSpeed = horizontalSpeed(state);
  let yaw = 0;
  for (let i = 0; i < 24; i++) {
    yaw += 8;
    state.angles.yaw = yaw;
    pmPlayerMove(state, collision, cmd({ buttons: IN_MOVERIGHT, sidemove: 400 }), DT);
  }

  const endSpeed = horizontalSpeed(state);
  assert.ok(endSpeed > startSpeed + 1, `air strafing should gain speed: ${startSpeed} -> ${endSpeed}`);
});

test('ducking fits through a 40 unit gap that blocks a standing player', () => {
  // Passage: floor below, ceiling slab starting at z = 40.
  const collision = world([...FLOOR, box([0, -64, 40], [256, 64, 80])]);

  const standing = createMoveState(v3(-64, 0, 36), 0);
  simulate(standing, collision, 128, cmd({ buttons: IN_FORWARD, forwardmove: 400 }));
  assert.ok(standing.origin.x < -14, `standing player should be blocked, x=${standing.origin.x}`);

  const ducking = createMoveState(v3(-64, 0, 36), 0);
  simulate(ducking, collision, 160, cmd({ buttons: IN_FORWARD | IN_DUCK, forwardmove: 400 }));
  assert.equal(ducking.ducked, true, 'expected the duck hull to be active');
  assert.equal(ducking.hull, HULL_DUCKING);
  assert.ok(ducking.origin.x > 100, `ducking player should pass, x=${ducking.origin.x}`);
});

test('crouch-walking is slower than running', () => {
  const collision = world([box([-4096, -4096, -16], [4096, 4096, 0])]);
  const running = createMoveState(v3(0, 0, 36), 0);
  simulate(running, collision, 64, cmd({ buttons: IN_FORWARD, forwardmove: 400 }));

  const ducked = createMoveState(v3(0, 0, 36), 0);
  // Hold duck long enough for the hull switch, then measure.
  simulate(ducked, collision, 64, cmd({ buttons: IN_FORWARD | IN_DUCK, forwardmove: 400 }));

  assert.equal(ducked.ducked, true);
  assert.ok(
    horizontalSpeed(ducked) < horizontalSpeed(running) * 0.5,
    `crouch speed ${horizontalSpeed(ducked).toFixed(1)} should be well below run speed ${horizontalSpeed(running).toFixed(1)}`,
  );
  // 250 * 0.34 = 85 u/s
  assert.ok(Math.abs(horizontalSpeed(ducked) - 85) < 3, `crouch speed was ${horizontalSpeed(ducked).toFixed(2)}, want ~85`);
});

test('the standing hull is 72 tall and the ducking hull 36', () => {
  assert.equal(HULL_STANDING.maxs.z - HULL_STANDING.mins.z, 72);
  assert.equal(HULL_DUCKING.maxs.z - HULL_DUCKING.mins.z, 36);
});

/**
 * The renderer maps GoldSrc Z-up angles onto a Three.js YXZ camera. If this
 * mapping is wrong the world looks mirrored, so it is pinned down numerically.
 */
test('camera rotation mapping reproduces the GoldSrc forward vector', () => {
  const cases: [number, number][] = [
    [0, 0],
    [0, 90],
    [0, 180],
    [0, 270],
    [30, 45],
    [-25, 135],
    [-60, 300],
  ];

  for (const [pitch, yaw] of cases) {
    const forward = v3();
    const right = v3();
    const up = v3();
    angleVectors(pitch, yaw, 0, forward, right, up);

    // GoldSrc -> Three: (x, y, z) -> (x, z, -y)
    const want = [forward.x, forward.z, -forward.y];

    // Three YXZ camera forward with rotation.x = -pitch, rotation.y = yaw - 90deg.
    const phi = (-pitch * Math.PI) / 180;
    const theta = (yaw * Math.PI) / 180 - Math.PI / 2;
    const got = [
      -Math.cos(phi) * Math.sin(theta),
      Math.sin(phi),
      -Math.cos(phi) * Math.cos(theta),
    ];

    for (let i = 0; i < 3; i++) {
      assert.ok(
        Math.abs(got[i]! - want[i]!) < 1e-9,
        `pitch=${pitch} yaw=${yaw} axis ${i}: got ${got[i]}, want ${want[i]}`,
      );
    }
  }
});

test('spawn points in the white house map are not inside geometry', async () => {
  const { buildWhiteHouse } = await import('../src/game/map/whitehouse.ts');
  const map = buildWhiteHouse();
  const spawn = map.spawns[0]!;

  const state = createMoveState(spawn.origin, spawn.yaw);
  pmPlayerMove(state, map.collision, cmd(), DT);
  assert.equal(state.onground || state.origin.z > 0, true);

  // Drop to the ground and make sure we end up standing on something.
  simulate(state, map.collision, 120, cmd());
  assert.equal(state.onground, true, `spawn ${JSON.stringify(spawn.origin)} never reached the ground`);
});
