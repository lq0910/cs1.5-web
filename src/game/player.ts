/**
 * The local player: movement state + view angles + the camera eye position.
 *
 * M1 scope: walking, jumping, crouching, noclip debug flight. Weapons, view bob
 * and view punch arrive in M2 — the hooks for them (eyePosition, visualOffset)
 * are already here.
 */

import type { CollisionWorld } from '../engine/collision/types.ts';
import type { Vec3 } from '../engine/math.ts';
import { addScaled, angleVectors, clamp, copy, normalize, scale, v3 } from '../engine/math.ts';
import { IN_DUCK, IN_JUMP, VIEW_OFFSET_Z } from './constants.ts';
import type { MoveState, UserCmd } from './movement.ts';
import { createMoveState, horizontalSpeed, makeUserCmd, pmPlayerMove } from './movement.ts';

/** GoldSrc clamps the view pitch to +/-89 degrees. */
const MAX_PITCH = 89;

export class Player {
  move: MoveState;
  pitch = 0;
  yaw = 0;
  noclip = false;
  health = 100;
  armor = 0;

  /** Smooths the visual crouch transition (the physics hull snaps instantly). */
  private visualOffset = 0;
  private wasDucked = false;

  readonly cmd: UserCmd = makeUserCmd();

  constructor(spawn: Vec3, yaw: number) {
    this.move = createMoveState(spawn, yaw);
    this.yaw = yaw;
    this.move.maxspeed = 250;
  }

  respawn(origin: Vec3, yaw: number): void {
    this.move = createMoveState(origin, yaw);
    this.move.maxspeed = 250;
    this.health = 100;
    this.armor = 0;
    this.yaw = yaw;
    this.pitch = 0;
    this.visualOffset = 0;
    this.wasDucked = false;
    this.noclip = false;
  }

  applyLook(deltaYaw: number, deltaPitch: number): void {
    this.yaw += deltaYaw;
    if (this.yaw > 180) this.yaw -= 360;
    else if (this.yaw < -180) this.yaw += 360;
    this.pitch = clamp(this.pitch + deltaPitch, -MAX_PITCH, MAX_PITCH);
  }

  get speed(): number {
    return horizontalSpeed(this.move);
  }

  /** Camera position: the hull centre plus the eye offset (and crouch easing). */
  get eyePosition(): Vec3 {
    return v3(
      this.move.origin.x,
      this.move.origin.y,
      this.move.origin.z + VIEW_OFFSET_Z + this.visualOffset,
    );
  }

  tick(world: CollisionWorld, cmd: UserCmd, dt: number): void {
    if (this.noclip) {
      this.noclipMove(cmd, dt);
      return;
    }

    this.move.angles.pitch = 0; // movement only uses yaw
    this.move.angles.yaw = this.yaw;
    this.move.angles.roll = 0;

    pmPlayerMove(this.move, world, cmd, dt);

    // Ease the camera so the crouch transition is not an instant 18 u snap.
    if (this.move.ducked !== this.wasDucked) {
      this.visualOffset = this.move.ducked ? 18 : -18;
      this.wasDucked = this.move.ducked;
    }
    const k = 1 - Math.exp(-dt * 14);
    this.visualOffset += (0 - this.visualOffset) * k;
    if (Math.abs(this.visualOffset) < 0.05) this.visualOffset = 0;
  }

  private noclipMove(cmd: UserCmd, dt: number): void {
    const forward = v3();
    const right = v3();
    const up = v3();
    angleVectors(this.pitch, this.yaw, 0, forward, right, up);

    const wish = v3(
      forward.x * (cmd.forwardmove / 400) + right.x * (cmd.sidemove / 400),
      forward.y * (cmd.forwardmove / 400) + right.y * (cmd.sidemove / 400),
      forward.z * (cmd.forwardmove / 400) + right.z * (cmd.sidemove / 400),
    );
    if (cmd.buttons & IN_JUMP) wish.z += 1;
    if (cmd.buttons & IN_DUCK) wish.z -= 1;

    if (normalize(wish) > 0) {
      const speed = 1200;
      this.move.origin = addScaled(copy(this.move.origin), this.move.origin, wish, speed * dt);
      this.move.velocity = scale(wish, speed);
    } else {
      this.move.velocity = v3();
    }
    this.move.onground = false;
    this.move.groundNormal = v3();
  }
}
