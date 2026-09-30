/**
 * Counter-Strike 1.5 weapon data and the accuracy/recoil model.
 *
 * Accuracy model (deliberately data-driven and CS-shaped):
 *   - every weapon has a *cone half-angle* that depends on the player's state:
 *     standing still, moving on the ground, airborne, and crouched (a
 *     multiplier on top);
 *   - speed on the ground interpolates between the standing and moving cones, so
 *     walking is punished less than running;
 *   - the first shot after a pause uses a tighter cone, which is what makes
 *     tap-firing and burst control matter;
 *   - recoil is a decaying *punch angle* added to both the camera and the bullet
 *     direction (exactly how GoldSrc does it), driven by a per-shot spray
 *     pattern. A player who does not compensate will see the classic AK climb.
 *
 * Damage model: distance falloff, hitgroup multiplier and CS's armor formula are
 * all in combat.ts so they can be unit-tested without a browser.
 */

import { clamp } from '../engine/math.ts';

export type CoreWeaponId =
  | 'knife'
  | 'glock18'
  | 'usp45'
  | 'deagle'
  | 'mp5navy'
  | 'ak47'
  | 'm4a1'
  | 'awp';

/** 功能：补齐 CS 1.5 原版可购买枪械与投掷物。时间：2026-09-29；作者：lq。 */
export type ExtraWeaponId =
  | 'p228' | 'elite' | 'fiveseven' | 'm3' | 'xm1014'
  | 'mac10' | 'tmp' | 'ump45' | 'p90' | 'aug' | 'sg552'
  | 'scout' | 'g3sg1' | 'sg550' | 'm249'
  | 'hegrenade' | 'flashbang' | 'smokegrenade';
export type WeaponId = CoreWeaponId | ExtraWeaponId;

export type WeaponSlot = 1 | 2 | 3;

export interface AccuracyProfile {
  /** Cone half-angle in degrees while standing still. */
  standing: number;
  /** Cone half-angle while running at full speed on the ground. */
  moving: number;
  /** Cone half-angle while airborne. */
  air: number;
  /** Multiplier applied when crouched. */
  duckMultiplier: number;
  /** Speed (u/s) at which the moving cone is fully applied. */
  speedForMax: number;
  /** Extra multiplier for the first shot after this many seconds of not firing. */
  firstShotMultiplier: number;
}

export interface RecoilProfile {
  /** [yawDeg, pitchUpDeg] added to the punch angle per shot, in order. */
  pattern: [number, number][];
  /** How fast the punch angle returns to zero, degrees per second. */
  recovery: number;
  /** Extra pitch added on the very first shot (kick), degrees. */
  firstShotKick: number;
  /** Max total punch pitch, degrees. */
  maxPunch: number;
  /** 功能：横向后坐力独立上限，用于还原步枪比纵向更窄的摆动范围。时间：2026-09-30；作者：lq。 */
  maxYawPunch?: number;
}

export interface WeaponSounds {
  fire: string[];
  clipout?: string;
  clipin?: string;
  boltpull?: string;
  deploy?: string;
  dryfire?: string;
  /** Alternative fire (knife stab, etc.). */
  altFire?: string[];
}

export interface WeaponDef {
  id: WeaponId;
  name: string;
  kind: 'rifle' | 'sniper' | 'pistol' | 'smg' | 'knife';
  slot: WeaponSlot | 4;
  automatic: boolean;
  damage: number;
  /** Fraction of damage that ignores armor (CS "armor ratio"). */
  armorRatio: number;
  /** Damage multiplier per 500 units of distance. */
  rangeModifier: number;
  /** Seconds between shots. */
  cycleTime: number;
  magSize: number;
  reloadTime: number;
  deployTime: number;
  /** Max player speed while this weapon is out (CS weapon max speeds). */
  maxSpeed: number;
  /** Hitscan range in units (GoldSrc bullets travel 8192 units). */
  range: number;
  accuracy: AccuracyProfile;
  recoil: RecoilProfile;
  sounds: WeaponSounds;
  price: number;
  canScope?: boolean;
  /** Damage multiplier per hitgroup. */
  hitgroups: { head: number; chest: number; stomach: number; leg: number };
}

const RIFLE_HITGROUPS = { head: 4, chest: 1, stomach: 1.25, leg: 0.75 };

/** Builds a spray pattern from a compact description. */
function pattern(entries: [number, number][]): [number, number][] {
  return entries;
}

const CORE_WEAPONS: Record<CoreWeaponId, WeaponDef> = {
  knife: {
    id: 'knife',
    name: 'Knife',
    kind: 'knife',
    slot: 3,
    automatic: false,
    damage: 15,
    armorRatio: 0.85,
    rangeModifier: 1,
    cycleTime: 0.4,
    magSize: Infinity,
    reloadTime: 0,
    deployTime: 0.25,
    maxSpeed: 250,
    range: 64,
    accuracy: {
      standing: 0,
      moving: 0,
      air: 0,
      duckMultiplier: 1,
      speedForMax: 250,
      firstShotMultiplier: 1,
    },
    recoil: { pattern: pattern([[0, 0]]), recovery: 20, firstShotKick: 0, maxPunch: 0 },
    sounds: {
      fire: ['sound/weapons/knife_slash1.wav', 'sound/weapons/knife_slash2.wav'],
      altFire: ['sound/weapons/knife_stab.wav'],
      deploy: 'sound/weapons/knife_deploy1.wav',
    },
    price: 0,
    hitgroups: RIFLE_HITGROUPS,
  },

  glock18: {
    id: 'glock18',
    name: 'Glock 18',
    kind: 'pistol',
    slot: 2,
    automatic: false,
    damage: 25,
    armorRatio: 0.525,
    rangeModifier: 0.75,
    cycleTime: 0.15,
    magSize: 20,
    reloadTime: 2.2,
    deployTime: 0.5,
    maxSpeed: 250,
    range: 8192,
    accuracy: {
      standing: 0.55,
      moving: 4.8,
      air: 9.5,
      duckMultiplier: 0.72,
      speedForMax: 200,
      firstShotMultiplier: 0.7,
    },
    recoil: {
      pattern: pattern([
        [0.1, 1.1],
        [-0.15, 1.0],
        [0.2, 0.9],
        [-0.1, 0.85],
      ]),
      recovery: 11,
      firstShotKick: 0.6,
      maxPunch: 6,
    },
    sounds: {
      fire: ['sound/weapons/glock18-1.wav', 'sound/weapons/glock18-2.wav'],
      clipout: 'sound/weapons/clipout1.wav',
      clipin: 'sound/weapons/clipin1.wav',
      dryfire: 'sound/weapons/dryfire_pistol.wav',
    },
    price: 400,
    hitgroups: RIFLE_HITGROUPS,
  },

  usp45: {
    id: 'usp45',
    name: 'USP .45',
    kind: 'pistol',
    slot: 2,
    automatic: false,
    damage: 34,
    armorRatio: 0.5,
    rangeModifier: 0.79,
    cycleTime: 0.15,
    magSize: 12,
    reloadTime: 2.2,
    deployTime: 0.5,
    maxSpeed: 250,
    range: 8192,
    accuracy: {
      standing: 0.45,
      moving: 4.6,
      air: 9,
      duckMultiplier: 0.7,
      speedForMax: 200,
      firstShotMultiplier: 0.68,
    },
    recoil: {
      pattern: pattern([
        [0.1, 1.35],
        [-0.2, 1.2],
        [0.15, 1.05],
        [0, 0.95],
      ]),
      recovery: 11,
      firstShotKick: 0.7,
      maxPunch: 6.5,
    },
    sounds: {
      fire: ['sound/weapons/usp1.wav', 'sound/weapons/usp2.wav'],
      clipout: 'sound/weapons/usp_clipout.wav',
      clipin: 'sound/weapons/usp_clipin.wav',
      dryfire: 'sound/weapons/dryfire_pistol.wav',
    },
    price: 500,
    hitgroups: RIFLE_HITGROUPS,
  },

  deagle: {
    id: 'deagle',
    name: 'Desert Eagle',
    kind: 'pistol',
    slot: 2,
    automatic: false,
    damage: 54,
    armorRatio: 0.75,
    rangeModifier: 0.81,
    cycleTime: 0.3,
    magSize: 7,
    reloadTime: 2.2,
    deployTime: 0.5,
    maxSpeed: 230,
    range: 8192,
    accuracy: {
      standing: 0.42,
      moving: 6.2,
      air: 12.5,
      duckMultiplier: 0.62,
      speedForMax: 190,
      firstShotMultiplier: 0.5,
    },
    recoil: {
      pattern: pattern([
        [0.2, 2.6],
        [-0.3, 2.4],
        [0.25, 2.2],
        [0.1, 2.0],
      ]),
      recovery: 13,
      firstShotKick: 1.6,
      maxPunch: 10,
    },
    sounds: {
      fire: ['sound/weapons/deagle-1.wav', 'sound/weapons/deagle-2.wav'],
      clipout: 'sound/weapons/de_clipout.wav',
      clipin: 'sound/weapons/de_clipin.wav',
      dryfire: 'sound/weapons/dryfire_pistol.wav',
    },
    price: 650,
    hitgroups: RIFLE_HITGROUPS,
  },

  mp5navy: {
    id: 'mp5navy',
    name: 'MP5 Navy',
    kind: 'smg',
    slot: 1,
    automatic: true,
    damage: 26,
    armorRatio: 0.5,
    rangeModifier: 0.84,
    cycleTime: 0.08,
    magSize: 30,
    reloadTime: 2.6,
    deployTime: 0.6,
    maxSpeed: 250,
    range: 8192,
    accuracy: {
      standing: 0.5,
      moving: 3.2,
      air: 8,
      duckMultiplier: 0.7,
      speedForMax: 210,
      firstShotMultiplier: 0.7,
    },
    recoil: {
      pattern: pattern([
        [0.05, 0.85],
        [-0.1, 0.8],
        [0.15, 0.75],
        [-0.05, 0.7],
        [0.1, 0.62],
        [-0.12, 0.58],
      ]),
      recovery: 9,
      firstShotKick: 0.4,
      maxPunch: 5,
    },
    sounds: {
      fire: ['sound/weapons/mp5-1.wav', 'sound/weapons/mp5-2.wav'],
      clipout: 'sound/weapons/mp5_clipout.wav',
      clipin: 'sound/weapons/mp5_clipin.wav',
      boltpull: 'sound/weapons/mp5_slideback.wav',
      dryfire: 'sound/weapons/dryfire_rifle.wav',
    },
    price: 1500,
    hitgroups: RIFLE_HITGROUPS,
  },

  ak47: {
    id: 'ak47',
    name: 'AK-47',
    kind: 'rifle',
    slot: 1,
    automatic: true,
    damage: 36,
    armorRatio: 0.775,
    rangeModifier: 0.98,
    cycleTime: 0.1,
    magSize: 30,
    reloadTime: 2.45,
    deployTime: 0.6,
    maxSpeed: 221,
    range: 8192,
    accuracy: {
      standing: 0.28,
      moving: 5.6,
      air: 12,
      duckMultiplier: 0.68,
      speedForMax: 210,
      firstShotMultiplier: 0.45,
    },
    // The classic AK climb: straight up for ~5 shots, then right, then a hard
    // pull back to the left, then drifting right again. The per-shot yaw values
    // are chosen so the *accumulated* punch crosses zero and goes negative.
    recoil: {
      pattern: pattern([
        [0.0, 1.0],
        [0.05, 1.95],
        [0.1, 1.7],
        [0.25, 1.35],
        [0.45, 1.1],
        [0.6, 0.9],
        [0.65, 0.75],
        [0.6, 0.6],
        [0.4, 0.5],
        [0.0, 0.42],
        [-0.5, 0.34],
        [-0.95, 0.26],
        [-1.15, 0.18],
        [-1.0, -0.1],
        [-0.6, -0.3],
        [-0.15, -0.35],
        [0.3, -0.2],
        [0.55, 0.0],
      ]),
      recovery: 7,
      firstShotKick: 0,
      maxPunch: 5.75,
      maxYawPunch: 1.75,
    },
    sounds: {
      fire: ['sound/weapons/ak47-1.wav', 'sound/weapons/ak47-2.wav'],
      clipout: 'sound/weapons/ak47_clipout.wav',
      clipin: 'sound/weapons/ak47_clipin.wav',
      boltpull: 'sound/weapons/ak47_boltpull.wav',
      dryfire: 'sound/weapons/dryfire_rifle.wav',
    },
    price: 2500,
    hitgroups: RIFLE_HITGROUPS,
  },

  m4a1: {
    id: 'm4a1',
    name: 'M4A1',
    kind: 'rifle',
    slot: 1,
    automatic: true,
    damage: 32,
    armorRatio: 0.7,
    rangeModifier: 0.97,
    cycleTime: 0.09,
    magSize: 30,
    reloadTime: 3.05,
    deployTime: 0.6,
    maxSpeed: 230,
    range: 8192,
    accuracy: {
      standing: 0.24,
      moving: 5.2,
      air: 11.5,
      duckMultiplier: 0.66,
      speedForMax: 215,
      firstShotMultiplier: 0.42,
    },
    // Gentler than the AK, but the same up -> right -> left shape.
    recoil: {
      pattern: pattern([
        [0.0, 0.65],
        [0.05, 1.55],
        [0.1, 1.35],
        [0.18, 1.1],
        [0.3, 0.9],
        [0.4, 0.75],
        [0.45, 0.62],
        [0.4, 0.52],
        [0.2, 0.45],
        [-0.1, 0.4],
        [-0.45, 0.34],
        [-0.7, 0.28],
        [-0.8, 0.2],
        [-0.7, 0.05],
        [-0.45, -0.15],
        [-0.15, -0.28],
        [0.15, -0.2],
        [0.35, -0.05],
      ]),
      recovery: 7.5,
      firstShotKick: 0,
      maxPunch: 3.5,
      maxYawPunch: 2.25,
    },
    sounds: {
      fire: ['sound/weapons/m4a1-1.wav'],
      clipout: 'sound/weapons/m4a1_clipout.wav',
      clipin: 'sound/weapons/m4a1_clipin.wav',
      boltpull: 'sound/weapons/m4a1_boltpull.wav',
      dryfire: 'sound/weapons/dryfire_rifle.wav',
    },
    price: 3100,
    hitgroups: RIFLE_HITGROUPS,
  },

  awp: {
    id: 'awp',
    name: 'AWP',
    kind: 'sniper',
    slot: 1,
    automatic: false,
    damage: 115,
    armorRatio: 0.975,
    rangeModifier: 0.99,
    cycleTime: 1.45,
    magSize: 10,
    reloadTime: 2.5,
    deployTime: 0.9,
    maxSpeed: 210,
    range: 8192,
    accuracy: {
      standing: 0.9,
      moving: 14,
      air: 24,
      duckMultiplier: 0.75,
      speedForMax: 150,
      firstShotMultiplier: 0.55,
    },
    recoil: {
      pattern: pattern([
        [0, 2],
      ]),
      recovery: 6,
      firstShotKick: 0,
      maxPunch: 2,
    },
    sounds: {
      fire: ['sound/weapons/awp1.wav'],
      clipout: 'sound/weapons/awp_clipout.wav',
      clipin: 'sound/weapons/awp_clipin.wav',
      boltpull: 'sound/weapons/boltpull1.wav',
      deploy: 'sound/weapons/awp_deploy.wav',
      dryfire: 'sound/weapons/dryfire_rifle.wav',
    },
    price: 4750,
    canScope: true,
    hitgroups: RIFLE_HITGROUPS,
  },
};

/** 功能：沿用同类枪械的后坐力/散布基线，给本地原版模型配置可用的战斗数值。时间：2026-09-29；作者：lq。 */
function extraWeapon(
  id: ExtraWeaponId,
  name: string,
  template: CoreWeaponId,
  price: number,
  damage: number,
  magSize: number,
  cycleTime: number,
  sound: string,
  scoped = false,
  overrides: Partial<Pick<WeaponDef, 'armorRatio' | 'rangeModifier'>> = {},
): WeaponDef {
  const base = CORE_WEAPONS[template];
  return {
    ...base, id, name, price, damage, magSize, cycleTime, canScope: scoped, ...overrides,
    sounds: { ...base.sounds, fire: [`sound/weapons/${sound}`] },
  };
}

/** 功能：原版 CS 1.5 枪械目录，双方武器均允许玩家自由购买。时间：2026-09-29；作者：lq。 */
export const WEAPONS: Record<WeaponId, WeaponDef> = {
  ...CORE_WEAPONS,
  // 功能：扩展枪械使用原版独立的护甲穿透和距离衰减常量，避免误继承模板枪的杀伤力。时间：2026-09-30；作者：lq。
  p228: extraWeapon('p228', 'P228', 'usp45', 600, 32, 13, 0.18, 'p228-1.wav', false, { armorRatio: 0.625, rangeModifier: 0.8 }),
  elite: extraWeapon('elite', 'Dual Berettas', 'glock18', 800, 36, 30, 0.12, 'elite_fire.wav', false, { rangeModifier: 0.75 }),
  fiveseven: extraWeapon('fiveseven', 'Five-SeveN', 'usp45', 750, 20, 20, 0.15, 'fiveseven-1.wav', false, { armorRatio: 0.75, rangeModifier: 0.885 }),
  m3: extraWeapon('m3', 'M3 Shotgun', 'm4a1', 1700, 90, 8, 0.9, 'm3-1.wav'),
  xm1014: extraWeapon('xm1014', 'XM1014', 'm4a1', 3000, 75, 7, 0.25, 'xm1014-1.wav'),
  mac10: extraWeapon('mac10', 'MAC-10', 'mp5navy', 1400, 29, 30, 0.075, 'mac10-1.wav', false, { armorRatio: 0.475, rangeModifier: 0.82 }),
  tmp: extraWeapon('tmp', 'TMP', 'mp5navy', 1250, 20, 30, 0.07, 'tmp-1.wav', false, { rangeModifier: 0.85 }),
  ump45: extraWeapon('ump45', 'UMP45', 'mp5navy', 1700, 30, 25, 0.09, 'ump45-1.wav', false, { rangeModifier: 0.82 }),
  p90: extraWeapon('p90', 'P90', 'mp5navy', 2350, 21, 50, 0.07, 'p90-1.wav', false, { armorRatio: 0.75, rangeModifier: 0.885 }),
  aug: extraWeapon('aug', 'AUG', 'm4a1', 3500, 32, 30, 0.09, 'aug-1.wav', true, { rangeModifier: 0.96 }),
  sg552: extraWeapon('sg552', 'SG552', 'ak47', 3500, 33, 30, 0.09, 'sg552-1.wav', true, { armorRatio: 0.7, rangeModifier: 0.955 }),
  scout: extraWeapon('scout', 'Scout', 'awp', 2750, 75, 10, 1.25, 'scout_fire-1.wav', true, { armorRatio: 0.85, rangeModifier: 0.98 }),
  g3sg1: extraWeapon('g3sg1', 'G3SG1', 'awp', 5000, 80, 20, 0.25, 'g3sg1-1.wav', true, { armorRatio: 0.825, rangeModifier: 0.98 }),
  sg550: extraWeapon('sg550', 'SG550', 'awp', 4200, 70, 30, 0.25, 'sg550-1.wav', true, { armorRatio: 0.725, rangeModifier: 0.98 }),
  m249: extraWeapon('m249', 'M249', 'm4a1', 5750, 32, 100, 0.075, 'm249-1.wav', false, { armorRatio: 0.75 }),
  hegrenade: extraWeapon('hegrenade', 'HE Grenade', 'knife', 300, 95, 1, 1, 'hegrenade-1.wav'),
  flashbang: extraWeapon('flashbang', 'Flashbang', 'knife', 200, 0, 1, 1, 'flashbang-1.wav'),
  smokegrenade: extraWeapon('smokegrenade', 'Smoke Grenade', 'knife', 300, 0, 1, 1, 'hegrenade-1.wav'),
};

for (const id of ['hegrenade', 'flashbang', 'smokegrenade'] as const) WEAPONS[id].slot = 4;
WEAPONS.m3.automatic = false;
WEAPONS.xm1014.automatic = false;

export const WEAPON_ORDER: WeaponId[] = [
  'knife',
  'glock18',
  'usp45',
  'deagle',
  'mp5navy',
  'ak47',
  'm4a1',
  'awp',
  'p228', 'elite', 'fiveseven', 'm3', 'xm1014', 'mac10', 'tmp', 'ump45', 'p90',
  'aug', 'sg552', 'scout', 'g3sg1', 'sg550', 'm249',
  'hegrenade', 'flashbang', 'smokegrenade',
];

export function weaponById(id: WeaponId): WeaponDef {
  return WEAPONS[id];
}

// --------------------------------------------------------------- accuracy

export interface AccuracyContext {
  /** Horizontal speed in u/s. */
  speed: number;
  onGround: boolean;
  ducked: boolean;
  /** True when the player is scoped (snipers only). */
  scoped: boolean;
  /** Seconds since the last shot (for the first-shot bonus). */
  timeSinceLastShot: number;
}

/**
 * Cone half-angle in degrees for the current player state.
 *
 * Ground speed interpolates between the standing and moving cones so that a
 * slow walk is not punished as hard as a full sprint.
 */
export function accuracyCone(weapon: WeaponDef, context: AccuracyContext): number {
  const accuracy = weapon.accuracy;

  let cone: number;
  if (!context.onGround) {
    cone = accuracy.air;
  } else {
    // In CS the moving penalty is a blend, not a step.
    const t = clamp(context.speed / Math.max(1, accuracy.speedForMax), 0, 1);
    cone = accuracy.standing + (accuracy.moving - accuracy.standing) * t;
  }

  if (context.ducked) cone *= accuracy.duckMultiplier;

  // First shot after a pause is the accurate one.
  const quiet = context.timeSinceLastShot > weapon.cycleTime * 2.5;
  if (quiet) cone *= accuracy.firstShotMultiplier;

  if (context.scoped && weapon.canScope) cone *= 0.03;

  return Math.max(0, cone);
}

// ----------------------------------------------------------------- recoil

export interface PunchAngle {
  pitch: number;
  yaw: number;
}

/**
 * Applies one shot's worth of recoil to the punch angle.
 * `shotIndex` walks the weapon's spray pattern; it is expected to be reset after
 * a pause (see combat.ts).
 */
export function applyRecoil(
  punch: PunchAngle,
  weapon: WeaponDef,
  shotIndex: number,
): PunchAngle {
  const pattern = weapon.recoil.pattern;
  const entry = pattern[Math.min(shotIndex, pattern.length - 1)] ?? [0, 0];

  let pitch = punch.pitch - entry[1]; // screen up = negative pitch in GoldSrc
  let yaw = punch.yaw + entry[0];

  if (shotIndex === 0) {
    pitch -= weapon.recoil.firstShotKick;
  }

  const limit = weapon.recoil.maxPunch;
  pitch = clamp(pitch, -limit, limit);
  yaw = clamp(yaw, -(weapon.recoil.maxYawPunch ?? limit), weapon.recoil.maxYawPunch ?? limit);

  return { pitch, yaw };
}

/** Decays the punch angle towards zero. */
export function decayPunch(punch: PunchAngle, weapon: WeaponDef, dt: number): PunchAngle {
  const recovery = weapon.recoil.recovery * dt;
  const magnitude = Math.hypot(punch.pitch, punch.yaw);
  if (magnitude <= recovery || magnitude === 0) return { pitch: 0, yaw: 0 };
  const scale = (magnitude - recovery) / magnitude;
  return { pitch: punch.pitch * scale, yaw: punch.yaw * scale };
}

// ----------------------------------------------------------------- spread

/**
 * Random offset inside the cone, in degrees, as [yaw, pitch] deltas.
 * Uniform over the disc (sqrt of the radius) so the distribution looks right.
 */
export function spreadOffset(
  coneDeg: number,
  random: () => number,
): { yaw: number; pitch: number } {
  if (coneDeg <= 0) return { yaw: 0, pitch: 0 };
  const angle = random() * Math.PI * 2;
  const radius = Math.sqrt(random()) * coneDeg;
  return {
    yaw: Math.cos(angle) * radius,
    pitch: Math.sin(angle) * radius,
  };
}

/** Weapon slots the player can cycle with the 1/2/3 keys. */
export function defaultLoadout(): Record<WeaponSlot, WeaponId> {
  return { 1: 'ak47', 2: 'usp45', 3: 'knife' };
}

/** 功能：将原版换弹基准时长压缩约 18%，并统一供弹药计时、动画和音效使用。时间：2026-09-29；作者：lq。 */
export function reloadDuration(id: WeaponId): number {
  return WEAPONS[id].reloadTime * 0.82;
}
