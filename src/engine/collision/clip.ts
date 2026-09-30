/**
 * GoldSrc velocity clipping.
 *
 * Ported from the Half-Life 1 SDK (pm_shared.c) that CS 1.5 is built on. The
 * exact behaviour here is what makes wall-hugging and stair movement feel like
 * Counter-Strike rather than like a generic character controller, so it is kept
 * literal instead of "cleaned up".
 */

import type { Vec3 } from '../math.ts';
import { copy, dot, length } from '../math.ts';

export const MAX_CLIP_PLANES = 5;

/**
 * PM_ClipVelocity: removes the component of `vel` that pushes into `normal`.
 * `overbounce` = 1.0 for normal movement.
 */
export function clipVelocity(vel: Vec3, normal: Vec3, overbounce = 1.0): Vec3 {
  const n = copy(normal);
  length(n); // NormalizeVector — GoldSrc normalizes defensively

  let backoff = dot(vel, n);
  if (backoff < 0) backoff *= overbounce;
  else backoff /= overbounce;

  return {
    x: vel.x - n.x * backoff,
    y: vel.y - n.y * backoff,
    z: vel.z - n.z * backoff,
  };
}

/** PM_CheckVelocity: clamp to sv_maxvelocity (GoldSrc default 2000). */
export function clampVelocity(vel: Vec3, maxVelocity: number): void {
  for (const axis of ['x', 'y', 'z'] as const) {
    if (Number.isNaN(vel[axis])) vel[axis] = 0;
    if (vel[axis] > maxVelocity) vel[axis] = maxVelocity;
    else if (vel[axis] < -maxVelocity) vel[axis] = -maxVelocity;
  }
}

/** Small helper: does the velocity have any meaningful z motion (going up)? */
export function goingUp(vel: Vec3): boolean {
  return vel.z > 0;
}
