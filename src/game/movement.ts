/**
 * GoldSrc player movement, ported from the Half-Life 1 SDK (pm_shared.c) that
 * Counter-Strike 1.5 ships with.
 *
 * The function names are kept as PM_* so the code can be diffed against the
 * original C sources when the feel is off. Everything is pure maths on a
 * MoveState plus a CollisionWorld, so the whole thing is unit-testable under
 * plain Node (see tests/physics.test.ts) with no browser involved.
 *
 * Reference: HL1 SDK pm_shared.c — PM_PlayerMove / PM_WalkMove / PM_AirMove /
 * PM_Friction / PM_Accelerate / PM_AirAccelerate / PM_SlideMove /
 * PM_StepSlideMove / PM_CategorizePosition / PM_Jump / PM_Duck.
 */

import type { Vec3 } from '../engine/math.ts';
import { angleVectors, clamp, copy, cross, dot, normalize, scale, v3 } from '../engine/math.ts';
import { MAX_CLIP_PLANES, clipVelocity, clampVelocity } from '../engine/collision/clip.ts';
import type { CollisionWorld, Hull } from '../engine/collision/types.ts';
import { HULL_DUCKING, HULL_STANDING } from '../engine/collision/types.ts';
import {
  ACCELERATE,
  AIR_ACCELERATE,
  CL_FORWARD_SPEED,
  CL_SIDE_SPEED,
  DUCK_SPEED_MULTIPLIER,
  FL_DUCKING,
  FL_ONGROUND,
  FRICTION,
  GRAVITY,
  IN_DUCK,
  IN_JUMP,
  IN_WALK,
  JUMP_VELOCITY,
  MAX_VELOCITY,
  STOP_SPEED,
  STEP_SIZE,
  TIME_TO_DUCK_MS,
  WALK_SPEED,
} from './constants.ts';

export interface UserCmd {
  /** Duration of this command in milliseconds (1000/64 at our tick rate). */
  msec: number;
  buttons: number;
  forwardmove: number;
  sidemove: number;
  upmove: number;
  pitch: number;
  yaw: number;
  roll: number;
}

export function makeUserCmd(): UserCmd {
  return {
    msec: 1000 / 64,
    buttons: 0,
    forwardmove: 0,
    sidemove: 0,
    upmove: 0,
    pitch: 0,
    yaw: 0,
    roll: 0,
  };
}

export interface MoveState {
  origin: Vec3;
  velocity: Vec3;
  angles: { pitch: number; yaw: number; roll: number };
  hull: Hull;
  onground: boolean;
  groundNormal: Vec3;
  /** Fully ducked (hull already switched). */
  ducked: boolean;
  /** Duck key currently held. */
  inDuck: boolean;
  /** Time spent transitioning crouch, ms. */
  duckTimeMs: number;
  /** Jump key currently held (kept for auto-bhop semantics). */
  jumpHeld: boolean;
  /** Player speed limit, normally taken from the held weapon. */
  maxspeed: number;
  /** Ground surface friction multiplier (GoldSrc pm->friction, default 1). */
  friction: number;
  flags: number;
  waterlevel: number;
  /** Debug: number of step-ups performed during the last move. */
  lastStepUps: number;
  /** Debug: set when the last move left the ground. */
  airborne: boolean;
}

export function createMoveState(origin: Vec3, yaw = 0): MoveState {
  return {
    origin: copy(origin),
    velocity: v3(),
    angles: { pitch: 0, yaw, roll: 0 },
    hull: HULL_STANDING,
    onground: false,
    groundNormal: v3(),
    ducked: false,
    inDuck: false,
    duckTimeMs: 0,
    jumpHeld: false,
    maxspeed: 250,
    friction: 1,
    flags: 0,
    waterlevel: 0,
    lastStepUps: 0,
    airborne: false,
  };
}

/** PM_AddGravity */
function pmAddGravity(state: MoveState, dt: number): void {
  state.velocity.z -= GRAVITY * dt;
}

/** PM_CheckVelocity (NaN guard + sv_maxvelocity clamp). */
function pmCheckVelocity(state: MoveState): void {
  clampVelocity(state.velocity, MAX_VELOCITY);
}

/** PM_Friction */
function pmFriction(state: MoveState, dt: number): void {
  const vec = v3(state.velocity.x, state.velocity.y, 0);
  const speed = Math.sqrt(vec.x * vec.x + vec.y * vec.y);
  if (speed < 0.1) {
    state.velocity.x = 0;
    state.velocity.y = 0;
    return;
  }

  let drop = 0;
  if (state.onground) {
    const friction = FRICTION * state.friction;
    const control = speed < STOP_SPEED ? STOP_SPEED : speed;
    drop += control * friction * dt;
  }

  let newspeed = speed - drop;
  if (newspeed < 0) newspeed = 0;
  newspeed /= speed;

  state.velocity.x *= newspeed;
  state.velocity.y *= newspeed;
}

/** PM_Accelerate */
function pmAccelerate(state: MoveState, wishdir: Vec3, wishspeed: number, accel: number, dt: number): void {
  const currentspeed = dot(state.velocity, wishdir);
  const addspeed = wishspeed - currentspeed;
  if (addspeed <= 0) return;

  let accelspeed = accel * dt * wishspeed * state.friction;
  if (accelspeed > addspeed) accelspeed = addspeed;

  state.velocity.x += accelspeed * wishdir.x;
  state.velocity.y += accelspeed * wishdir.y;
  state.velocity.z += accelspeed * wishdir.z;
}

/**
 * PM_AirAccelerate — the wish speed used for the "addspeed" test is capped at
 * 30 u/s while the accel term keeps the full wish speed. That asymmetry is what
 * makes strafe jumping work, so both halves must stay exactly like this.
 */
function pmAirAccelerate(state: MoveState, wishdir: Vec3, wishspeed: number, accel: number, dt: number): void {
  let wishspd = wishspeed;
  if (wishspd > 30) wishspd = 30;

  const currentspeed = dot(state.velocity, wishdir);
  const addspeed = wishspd - currentspeed;
  if (addspeed <= 0) return;

  let accelspeed = accel * wishspeed * dt * state.friction;
  if (accelspeed > addspeed) accelspeed = addspeed;

  state.velocity.x += accelspeed * wishdir.x;
  state.velocity.y += accelspeed * wishdir.y;
  state.velocity.z += accelspeed * wishdir.z;
}

/** Builds wishdir/wishspeed from the command, clamped by weapon/duck/walk limits. */
function computeWish(
  state: MoveState,
  cmd: UserCmd,
): { wishdir: Vec3; wishspeed: number } {
  const forward = v3();
  const right = v3();
  const up = v3();
  angleVectors(state.angles.pitch, state.angles.yaw, state.angles.roll, forward, right, up);

  let fmove = clamp(cmd.forwardmove, -CL_FORWARD_SPEED, CL_FORWARD_SPEED);
  let smove = clamp(cmd.sidemove, -CL_SIDE_SPEED, CL_SIDE_SPEED);

  let wishspeed = Math.sqrt(fmove * fmove + smove * smove);

  // PM_WalkMove clamps the whole movement vector to the server max speed.
  if (wishspeed > 0 && wishspeed > state.maxspeed) {
    const ratio = state.maxspeed / wishspeed;
    fmove *= ratio;
    smove *= ratio;
    wishspeed = state.maxspeed;
  }

  // Crouch-walking and shift-walking further cap the speed (CS behaviour).
  let cap = state.maxspeed;
  if (state.ducked) cap = Math.min(cap, state.maxspeed * DUCK_SPEED_MULTIPLIER);
  if (cmd.buttons & IN_WALK) cap = Math.min(cap, WALK_SPEED);
  if (wishspeed > cap) {
    const ratio = cap / wishspeed;
    fmove *= ratio;
    smove *= ratio;
    wishspeed = cap;
  }

  const wishdir = v3(
    forward.x * fmove + right.x * smove,
    forward.y * fmove + right.y * smove,
    0,
  );
  normalize(wishdir);

  return { wishdir, wishspeed };
}

/** PM_SlideMove — the bump-and-slide loop. */
function pmSlideMove(state: MoveState, world: CollisionWorld, dt: number): void {
  const numbumps = 4;
  const primalVelocity = copy(state.velocity);
  const originalVelocity = copy(state.velocity);
  const planes: Vec3[] = [];
  const clipped: Vec3[] = [];
  let timeLeft = dt;

  for (let bumpcount = 0; bumpcount < numbumps; bumpcount++) {
    const end = v3(
      state.origin.x + timeLeft * state.velocity.x,
      state.origin.y + timeLeft * state.velocity.y,
      state.origin.z + timeLeft * state.velocity.z,
    );

    const trace = world.traceHull(state.hull, state.origin, end);

    if (trace.allsolid) {
      state.velocity = v3();
      return;
    }
    if (trace.fraction > 0) {
      state.origin = copy(trace.endpos);
    }
    if (trace.fraction === 1) break;

    timeLeft -= timeLeft * trace.fraction;

    if (planes.length >= MAX_CLIP_PLANES) {
      state.velocity = v3();
      break;
    }

    planes.push(copy(trace.normal));

    // Modify the original velocity so it parallels all of the clip planes.
    let i = 0;
    for (; i < planes.length; i++) {
      clipped[i] = clipVelocity(originalVelocity, planes[i]!, 1.0);
      let j = 0;
      for (; j < planes.length; j++) {
        if (j !== i && dot(clipped[i]!, planes[j]!) < 0) break;
      }
      if (j === planes.length) break;
    }

    if (i !== planes.length) {
      state.velocity = copy(clipped[i]!);
    } else {
      // Going along a crease: GoldSrc only handles the 2-plane case, and it
      // deliberately does not normalise the cross product (kept literal).
      if (planes.length !== 2) {
        state.velocity = v3();
        break;
      }
      const dir = cross(planes[0]!, planes[1]!);
      state.velocity = scale(dir, dot(dir, state.velocity));
    }

    // If velocity is against the original velocity, stop dead.
    if (dot(state.velocity, primalVelocity) <= 0) {
      state.velocity = v3();
      break;
    }
  }
}

function horizontalDistSq(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/**
 * PM_StepSlideMove — performs the slide move twice, once from the current
 * position and once from STEP_SIZE units up, then keeps whichever travelled
 * further horizontally. This is the "magic" that walks players up stairs.
 */
function pmStepSlideMove(state: MoveState, world: CollisionWorld, dt: number): void {
  const startOrigin = copy(state.origin);
  const startVelocity = copy(state.velocity);
  const wasOnGround = state.onground;

  pmSlideMove(state, world, dt);
  const downOrigin = copy(state.origin);
  const downVelocity = copy(state.velocity);

  if (!wasOnGround) return;

  // Try the same movement from one step height up.
  const upFrom = v3(startOrigin.x, startOrigin.y, startOrigin.z + STEP_SIZE);
  const upTrace = world.traceHull(state.hull, startOrigin, upFrom);
  if (upTrace.allsolid || upTrace.startsolid) return;

  state.origin = copy(upTrace.endpos);
  state.velocity = copy(startVelocity);
  pmSlideMove(state, world, dt);

  const slidOrigin = copy(state.origin);
  const slidVelocity = copy(state.velocity);

  // Fall back down onto the step surface.
  const downTo = v3(slidOrigin.x, slidOrigin.y, slidOrigin.z - STEP_SIZE);
  const dropTrace = world.traceHull(state.hull, slidOrigin, downTo);
  const upOrigin = copy(dropTrace.endpos);

  const distDown = horizontalDistSq(downOrigin, startOrigin);
  const distUp = horizontalDistSq(upOrigin, startOrigin);

  if (distUp > distDown) {
    state.origin = upOrigin;
    state.velocity = copy(slidVelocity);
    state.lastStepUps++;
  } else {
    state.origin = downOrigin;
    state.velocity = copy(downVelocity);
  }
}

/**
 * PM_CategorizePosition — decides whether the player is on the ground and
 * records the ground normal (planes flatter than 0.7 are walkable).
 */
function pmCategorizePosition(state: MoveState, world: CollisionWorld): void {
  const below = v3(state.origin.x, state.origin.y, state.origin.z - 2);
  const trace = world.traceHull(state.hull, state.origin, below);

  state.airborne = false;

  if (trace.fraction === 1 || trace.allsolid || trace.normal.z < 0.7) {
    state.onground = false;
    state.groundNormal = v3();
    state.flags &= ~FL_ONGROUND;
    state.airborne = true;
    return;
  }

  state.onground = true;
  state.groundNormal = copy(trace.normal);
  state.flags |= FL_ONGROUND;

  // Kill (or redirect, on ramps) downward velocity now that we have a floor.
  if (state.velocity.z < 0) {
    state.velocity = clipVelocity(state.velocity, state.groundNormal, 1.0);
  }
}

/** PM_Jump. Note: no oldbuttons check, so holding jump auto-bhops like CS 1.5. */
function pmJump(state: MoveState, cmd: UserCmd): void {
  if (state.waterlevel >= 2) return;

  if (!state.onground) {
    state.jumpHeld = false;
    return;
  }
  if (!(cmd.buttons & IN_JUMP)) {
    state.jumpHeld = false;
    return;
  }

  state.jumpHeld = true;
  state.velocity.z = JUMP_VELOCITY;
  state.onground = false;
  state.flags &= ~FL_ONGROUND;
}

/** PM_Duck — also handles standing back up, which requires head room. */
function pmDuck(state: MoveState, world: CollisionWorld, cmd: UserCmd, dt: number): void {
  const wantsDuck = (cmd.buttons & IN_DUCK) !== 0;
  state.inDuck = wantsDuck;

  if (!wantsDuck) {
    state.duckTimeMs = 0;
    if (state.ducked) {
      const standTo = v3(state.origin.x, state.origin.y, state.origin.z + 18);
      const trace = world.traceHull(HULL_STANDING, state.origin, standTo);
      if (trace.fraction === 1) {
        state.hull = HULL_STANDING;
        state.origin = standTo;
        state.ducked = false;
        state.flags &= ~FL_DUCKING;
      }
      // else: no head room, stay crouched
    }
    return;
  }

  state.duckTimeMs = Math.min(state.duckTimeMs + dt * 1000, TIME_TO_DUCK_MS);

  if (!state.ducked) {
    // Lower the hull. The origin sits at the hull centre, so crouching means
    // moving down 18 units; the trace keeps the feet from clipping the floor.
    const duckTo = v3(state.origin.x, state.origin.y, state.origin.z - 18);
    const trace = world.traceHull(HULL_DUCKING, state.origin, duckTo);
    state.hull = HULL_DUCKING;
    state.origin = trace.allsolid ? duckTo : copy(trace.endpos);
    state.ducked = true;
    state.flags |= FL_DUCKING;
  }
}

/** PM_WalkMove (ground branch). */
function pmGroundMove(state: MoveState, world: CollisionWorld, cmd: UserCmd, dt: number): void {
  const { wishdir, wishspeed } = computeWish(state, cmd);
  if (wishspeed > 0) pmAccelerate(state, wishdir, wishspeed, ACCELERATE, dt);
  pmStepSlideMove(state, world, dt);
}

/** PM_AirMove. */
function pmAirMove(state: MoveState, world: CollisionWorld, cmd: UserCmd, dt: number): void {
  const { wishdir, wishspeed } = computeWish(state, cmd);
  if (wishspeed > 0) pmAirAccelerate(state, wishdir, wishspeed, AIR_ACCELERATE, dt);
  pmAddGravity(state, dt);
  pmStepSlideMove(state, world, dt);
}

/**
 * PM_PlayerMove — the per-tick entry point. Order matters and mirrors the SDK:
 * duck -> clamp -> ground check -> friction -> jump -> move -> ground check.
 */
export function pmPlayerMove(
  state: MoveState,
  world: CollisionWorld,
  cmd: UserCmd,
  dt: number,
): void {
  state.lastStepUps = 0;

  pmDuck(state, world, cmd, dt);
  pmCheckVelocity(state);
  pmCategorizePosition(state, world);

  if (state.onground) {
    pmFriction(state, dt);
  }

  pmJump(state, cmd);
  pmCheckVelocity(state);

  if (state.onground) {
    pmGroundMove(state, world, cmd, dt);
  } else {
    pmAirMove(state, world, cmd, dt);
  }

  pmCategorizePosition(state, world);
}

/** Horizontal speed in u/s, handy for the HUD and for tests. */
export function horizontalSpeed(state: MoveState): number {
  return Math.sqrt(state.velocity.x * state.velocity.x + state.velocity.y * state.velocity.y);
}
