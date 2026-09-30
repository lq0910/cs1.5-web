/**
 * "白房子" (White House) — the built-in test map for milestone M1.
 *
 * It is deliberately a movement laboratory rather than art: a courtyard, a two
 * storey white house with a door, windows and a staircase, plus every feature
 * the GoldSrc movement code needs to be verified by hand:
 *
 *   - a long straight run          -> ground acceleration / max speed
 *   - a long thin wall             -> PM_SlideMove wall hugging
 *   - a 4 step staircase (16 rise) -> PM_StepSlideMove step-up (stepsize 18)
 *   - a 16 u ledge                 -> the step-up limit
 *   - 32 u and 64 u crates         -> 45 u jump height
 *   - a 40 u crawl gap             -> duck hull (36 u) vs stand hull (72 u)
 *   - an open courtyard            -> strafe jumping / bunny hop
 *
 * All lengths are GoldSrc units. 1 unit = 1 inch, the player is 72 units tall.
 */

import type { Vec3 } from '../../engine/math.ts';
import { v3 } from '../../engine/math.ts';
import type { BoxDef } from '../../engine/collision/brush.ts';
import type { MapData } from './build.ts';
import { box, collisionFromBoxes, stairs, wallWithHoles } from './build.ts';

const COURTYARD_HALF = 640;
const WALL_THICKNESS = 32;
const WALL_HEIGHT = 384;

const HOUSE_X = 256;
const HOUSE_Y = 192;
const HOUSE_T = 16;

const FLOOR1_TOP = 128; // ceiling of the ground floor / underside of the slab
const SLAB = 16;
const FLOOR2_BOTTOM = FLOOR1_TOP + SLAB; // 144
const ROOF_BOTTOM = 272;
const HOUSE_TOP = ROOF_BOTTOM + SLAB; // 288

const DOOR_HALF_WIDTH = 40;
const DOOR_HEIGHT = 80;

/** Stairwell footprint punched out of the first floor slab. */
const STAIR_X0 = -240;
const STAIR_X1 = -144;
const STAIR_Y0 = -176;
const STAIR_Y1 = -16;
const STAIR_RISE = 16;
const STAIR_TREAD = 20;
const STAIR_STEPS = 8; // 8 * 16 = 128 == FLOOR1_TOP

export function buildWhiteHouse(): MapData {
  const boxes: BoxDef[] = [];
  const add = (...list: BoxDef[]): void => {
    for (const b of list) boxes.push(b);
  };

  // ---------------------------------------------------------------- courtyard
  add(box(v3(-COURTYARD_HALF, -COURTYARD_HALF, -16), v3(COURTYARD_HALF, COURTYARD_HALF, 0), 'sand'));

  const outer = COURTYARD_HALF + WALL_THICKNESS;
  add(
    box(v3(-outer, -outer, 0), v3(outer, -COURTYARD_HALF, WALL_HEIGHT), 'brick'), // -Y
    box(v3(-outer, COURTYARD_HALF, 0), v3(outer, outer, WALL_HEIGHT), 'brick'), // +Y
    box(v3(-outer, -COURTYARD_HALF, 0), v3(-COURTYARD_HALF, COURTYARD_HALF, WALL_HEIGHT), 'brick'), // -X
    box(v3(COURTYARD_HALF, -COURTYARD_HALF, 0), v3(outer, COURTYARD_HALF, WALL_HEIGHT), 'brick'), // +X
  );

  // ------------------------------------------------------------------- house
  // Ground floor slab (sits on the courtyard ground).
  add(box(v3(-HOUSE_X, -HOUSE_Y, 0), v3(HOUSE_X, HOUSE_Y, 8), 'concrete'));

  // +Y wall with the front door.
  add(
    ...wallWithHoles(
      'x',
      -HOUSE_X,
      HOUSE_X,
      HOUSE_Y - HOUSE_T,
      HOUSE_Y,
      8,
      HOUSE_TOP,
      [{ from: -DOOR_HALF_WIDTH, to: DOOR_HALF_WIDTH, bottom: 0, top: DOOR_HEIGHT }],
      'stucco',
    ),
  );

  // -Y wall (back of the house) with two ground floor windows.
  add(
    ...wallWithHoles(
      'x',
      -HOUSE_X,
      HOUSE_X,
      -HOUSE_Y,
      -HOUSE_Y + HOUSE_T,
      8,
      HOUSE_TOP,
      [
        { from: -104, to: -40, bottom: 48, top: 112 },
        { from: 40, to: 104, bottom: 48, top: 112 },
      ],
      'stucco',
    ),
  );

  // -X wall (solid; the staircase runs along it).
  add(box(v3(-HOUSE_X, -HOUSE_Y + HOUSE_T, 8), v3(-HOUSE_X + HOUSE_T, HOUSE_Y - HOUSE_T, HOUSE_TOP), 'stucco'));

  // +X wall with two second floor windows.
  add(
    ...wallWithHoles(
      'y',
      -HOUSE_Y + HOUSE_T,
      HOUSE_Y - HOUSE_T,
      HOUSE_X - HOUSE_T,
      HOUSE_X,
      8,
      HOUSE_TOP,
      [
        { from: -104, to: -40, bottom: 176, top: 240 },
        { from: 40, to: 104, bottom: 176, top: 240 },
      ],
      'stucco',
    ),
  );

  // First floor slab, minus the stairwell hole.
  add(
    box(v3(STAIR_X1, -HOUSE_Y + HOUSE_T, FLOOR1_TOP), v3(HOUSE_X - HOUSE_T, HOUSE_Y - HOUSE_T, FLOOR2_BOTTOM), 'wood'),
    box(v3(STAIR_X0, STAIR_Y1, FLOOR1_TOP), v3(STAIR_X1, HOUSE_Y - HOUSE_T, FLOOR2_BOTTOM), 'wood'),
  );

  // Staircase up to the first floor.
  add(...stairs(STAIR_X0, STAIR_X1, STAIR_Y0, STAIR_STEPS, STAIR_RISE, STAIR_TREAD, 'wood'));

  // Interior partition on the second floor (cover / sightline break).
  add(box(v3(112, -HOUSE_Y + HOUSE_T, FLOOR2_BOTTOM), v3(128, 40, 224), 'wood'));

  // Roof.
  add(box(v3(-HOUSE_X, -HOUSE_Y, ROOF_BOTTOM), v3(HOUSE_X, HOUSE_Y, HOUSE_TOP), 'stucco'));

  // -------------------------------------------------------- movement test rig
  // Long thin wall for PM_SlideMove (walk into it at an angle and you should
  // keep sliding along it).
  add(box(v3(320, -192, 0), v3(336, 192, 128), 'concrete'));

  // Four step staircase: 16 u rise is under stepsize 18, so you walk up it.
  add(...stairs(400, 504, 160, 4, 16, 24, 'concrete'));

  // A 16 u ledge (walk up) next to a 24 u ledge (must jump).
  add(
    box(v3(400, -320, 0), v3(560, -192, 16), 'concrete'),
    box(v3(400, -480, 0), v3(560, -320, 24), 'concrete'),
  );

  // Crates: 32 u is a single jump, 64 u needs a jump from the 32 u crate.
  add(
    box(v3(-560, 320, 0), v3(-496, 384, 32), 'metal'),
    box(v3(-560, 400, 0), v3(-496, 464, 64), 'metal'),
    box(v3(-480, 320, 0), v3(-416, 384, 32), 'metal'),
  );

  // Crawl gap: a solid beam with a 40 u passage underneath. The standing hull is
  // 72 u tall and cannot pass; the ducking hull is 36 u and can.
  add(box(v3(-160, -560, 40), v3(160, -480, 128), 'metal'));

  // A ramp-ish set of low steps in the corner, to check repeated step-ups.
  add(...stairs(-600, -520, -600, 6, 14, 20, 'concrete'));

  const spawns = [
    { origin: v3(0, 520, 48), yaw: 270, team: 'ct' as const },
    { origin: v3(0, -520, 48), yaw: 90, team: 't' as const },
    { origin: v3(-360, 200, 48), yaw: 200, team: 'ct' as const },
    { origin: v3(360, -200, 48), yaw: 20, team: 't' as const },
  ];

  return {
    name: '白房子 (white_house)',
    bounds: {
      mins: v3(-COURTYARD_HALF - WALL_THICKNESS, -COURTYARD_HALF - WALL_THICKNESS, -16),
      maxs: v3(COURTYARD_HALF + WALL_THICKNESS, COURTYARD_HALF + WALL_THICKNESS, WALL_HEIGHT),
    },
    boxes,
    collision: collisionFromBoxes(boxes),
    spawns,
    skyColor: 0x86a8c8,
    fogColor: 0xa8bccd,
  };
}

/** Exposed for tests and for the debug HUD. */
export const WHITE_HOUSE_INFO = {
  courtyardHalf: COURTYARD_HALF,
  floor1Top: FLOOR1_TOP,
  floor2Bottom: FLOOR2_BOTTOM,
  houseTop: HOUSE_TOP,
  stairs: { steps: STAIR_STEPS, rise: STAIR_RISE, tread: STAIR_TREAD },
};

/** Used by the map loader to place the player on a spawn safely. */
export function spawnPointFor(map: MapData, index = 0): { origin: Vec3; yaw: number } {
  const spawn = map.spawns[index % map.spawns.length]!;
  return { origin: v3(spawn.origin.x, spawn.origin.y, spawn.origin.z), yaw: spawn.yaw };
}
