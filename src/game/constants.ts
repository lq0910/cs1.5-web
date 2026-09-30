/**
 * GoldSrc / Counter-Strike 1.5 movement constants.
 *
 * Every value is taken from the Half-Life 1 SDK movevars and the CS 1.5 weapon
 * table. Do not "tidy" these numbers: the feel of the game is entirely encoded
 * in them. Player speed comes from the held weapon, which is why the weapon
 * speeds table lives here instead of in the weapon code.
 */

/** sv_gravity */
export const GRAVITY = 800;

/** sv_maxvelocity */
export const MAX_VELOCITY = 2000;

/** sv_friction */
export const FRICTION = 4;

/** sv_stopspeed — below this speed, friction uses stopspeed instead of speed. */
export const STOP_SPEED = 100;

/** sv_accelerate */
export const ACCELERATE = 10;

/** sv_airaccelerate — paired with the 30 u/s wish-speed cap this creates strafe-jumping. */
export const AIR_ACCELERATE = 10;

/** sv_stepsize — the free step-up height that makes CS stairs feel smooth. */
export const STEP_SIZE = 18;

/** sv_maxspeed (server default; individual weapons override it) */
export const MAX_SPEED = 320;

/** cl_forwardspeed / cl_sidespeed — the raw command magnitude. */
export const CL_FORWARD_SPEED = 400;
export const CL_SIDE_SPEED = 400;

/** Jump impulse: sqrt(2 * gravity * 45) — a 45 unit jump, exactly as GoldSrc. */
export const JUMP_VELOCITY = Math.sqrt(2 * GRAVITY * 45);

/** Crouch-walking is 34% of the weapon's max speed in CS. */
export const DUCK_SPEED_MULTIPLIER = 0.34;

/** Shift-walking (IN_WALK) speed cap in CS. */
export const WALK_SPEED = 135;

/** Time to duck / unduck, in milliseconds (GoldSrc TIME_TO_DUCK). */
export const TIME_TO_DUCK_MS = 400;

/** Player eye height above the hull centre (GoldSrc view_ofs for players). */
export const VIEW_OFFSET_Z = 17;

/** Simulation tick: 64 ticks per second, like a modern CS server. */
export const TICK_RATE = 64;
export const TICK_INTERVAL = 1 / TICK_RATE;
export const TICK_MS = 1000 / TICK_RATE;

/**
 * CS 1.5 weapon max speeds (u/s). Player speed is min(command speed, this value),
 * so switching from the knife to the AWP really does slow you down.
 */
export const WEAPON_MAX_SPEEDS: Record<string, number> = {
  knife: 250,
  glock18: 250,
  usp45: 250,
  p228: 250,
  deagle: 230,
  elites: 250,
  fiveseven: 240,
  m3: 230,
  xm1014: 215,
  mp5navy: 250,
  tmp: 250,
  p90: 245,
  mac10: 250,
  ump45: 250,
  ak47: 221,
  sg552: 235,
  m4a1: 230,
  aug: 240,
  scout: 260,
  awp: 210,
  g3sg1: 210,
  sg550: 210,
  m249: 220,
  c4: 250,
  grenade: 250,
};

/** GoldSrc entity flags we care about (subset). */
export const FL_ONGROUND = 1 << 9;
export const FL_DUCKING = 1 << 14;
export const FL_WATERJUMP = 1 << 11;

/** GoldSrc usercmd buttons (subset, exact bit values). */
export const IN_ATTACK = 1 << 0;
export const IN_JUMP = 1 << 1;
export const IN_DUCK = 1 << 2;
export const IN_FORWARD = 1 << 3;
export const IN_BACK = 1 << 4;
export const IN_USE = 1 << 5;
export const IN_CANCEL = 1 << 6;
export const IN_LEFT = 1 << 7;
export const IN_RIGHT = 1 << 8;
export const IN_MOVELEFT = 1 << 9;
export const IN_MOVERIGHT = 1 << 10;
export const IN_ATTACK2 = 1 << 11;
export const IN_RUN = 1 << 12;
export const IN_RELOAD = 1 << 13;
export const IN_ALT1 = 1 << 14;
export const IN_SCORE = 1 << 15;
export const IN_SPEED = 1 << 16;
export const IN_WALK = 1 << 17;
