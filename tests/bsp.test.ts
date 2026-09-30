/**
 * BSP pipeline tests.
 *
 * The strategy is a round trip plus a differential test:
 *
 *   1. compile the built-in white house into a real BSP v30 file image;
 *   2. parse that file back and check every lump;
 *   3. run identical movement scripts against the hand-built brush collision
 *      world and the BSP clipnode world, and compare the trajectories.
 *
 * Step 3 is the one that matters: it proves the clipnode traversal reproduces
 * the GoldSrc movement results of the already-verified brush backend, on a map
 * with doors, windows, a staircase, crates and a crawl gap.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { v3 } from '../src/engine/math.ts';
import type { Vec3 } from '../src/engine/math.ts';
import { BrushWorld } from '../src/engine/collision/brush.ts';
import { HULL_DUCKING, HULL_STANDING } from '../src/engine/collision/types.ts';
import type { CollisionWorld } from '../src/engine/collision/types.ts';
import { buildWhiteHouse } from '../src/game/map/whitehouse.ts';
import { createMoveState, pmPlayerMove } from '../src/game/movement.ts';
import type { MoveState, UserCmd } from '../src/game/movement.ts';
import { IN_DUCK, IN_FORWARD, IN_JUMP, IN_MOVERIGHT, TICK_INTERVAL } from '../src/game/constants.ts';
import { compileBsp } from '../src/engine/bsp/write.ts';
import type { BspSpawn } from '../src/engine/bsp/write.ts';
import { bspStats, parseBsp } from '../src/engine/bsp/reader.ts';
import { BspCollisionWorld } from '../src/engine/bsp/collision.ts';
import { CONTENTS_SOLID } from '../src/engine/bsp/types.ts';
import { readFile } from 'node:fs/promises';
import { spawnsFromBsp } from '../src/game/map/loader.ts';

const TICK_MS = TICK_INTERVAL * 1000;

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

const CT_CLASS = 'info_player_counterterrorist';
const T_CLASS = 'info_player_terrorist';

function whiteHouseBsp() {
  const map = buildWhiteHouse();
  const spawns: BspSpawn[] = map.spawns.map((spawn, index) => ({
    origin: spawn.origin,
    yaw: spawn.yaw,
    classname: index === 0 ? 'info_player_start' : spawn.team === 'ct' ? CT_CLASS : T_CLASS,
  }));
  return { map, report: compileBsp({ boxes: map.boxes, spawns }) };
}

/** Runs a scripted movement and records the trajectory. */
function trajectory(
  world: CollisionWorld,
  start: Vec3,
  yaw: number,
  ticks: number,
  makeCmd: (tick: number) => UserCmd,
): Vec3[] {
  const state: MoveState = createMoveState(start, yaw);
  const out: Vec3[] = [];
  for (let i = 0; i < ticks; i++) {
    pmPlayerMove(state, world, makeCmd(i), TICK_INTERVAL);
    out.push({ x: state.origin.x, y: state.origin.y, z: state.origin.z });
  }
  return out;
}

function compareTrajectories(a: Vec3[], b: Vec3[], tolerance: number, label: string): number {
  assert.equal(a.length, b.length);
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    const dx = Math.abs(a[i]!.x - b[i]!.x);
    const dy = Math.abs(a[i]!.y - b[i]!.y);
    const dz = Math.abs(a[i]!.z - b[i]!.z);
    const error = Math.max(dx, dy, dz);
    if (error > worst) worst = error;
    assert.ok(
      error <= tolerance,
      `${label}: tick ${i} diverged by ${error.toFixed(3)} units ` +
        `(brush ${JSON.stringify(a[i])} vs bsp ${JSON.stringify(b[i])})`,
    );
  }
  return worst;
}

test('compiles the white house and parses it back with matching lump counts', () => {
  const { report } = whiteHouseBsp();
  const bsp = parseBsp(report.buffer);
  const stats = bspStats(bsp);

  assert.equal(bsp.version, 30);
  assert.equal(bsp.planes.length, report.stats.planes, 'plane count');
  assert.equal(bsp.nodes.length, report.stats.nodes, 'node count');
  assert.equal(bsp.leaves.length, report.stats.leaves, 'leaf count');
  assert.equal(bsp.clipnodes.length, report.stats.clipnodes, 'clipnode count');
  assert.equal(bsp.faces.length, report.stats.faces, 'face count');
  assert.equal(bsp.miptex.length, report.stats.textures, 'texture count');
  assert.equal(bsp.lighting.length, report.stats.lightingBytes, 'lighting bytes');
  assert.ok(bsp.faces.length > 0 && bsp.nodes.length > 1, 'compiled map should not be trivial');
  assert.ok(bsp.entities.includes('info_player_start'), 'entity lump keeps spawn points');
  assert.equal(bsp.entityList.length, report.stats.entities);
  assert.equal(stats.litFaces, bsp.faces.length, 'every face has a lightmap');
});

test('every face is a quad with valid edge and vertex indices', () => {
  const { report } = whiteHouseBsp();
  const bsp = parseBsp(report.buffer);

  for (const [index, face] of bsp.faces.entries()) {
    assert.equal(face.numedges, 4, `face ${index} should be a quad`);
    assert.ok(face.texinfo >= 0 && face.texinfo < bsp.texinfo.length, `face ${index} texinfo`);
    assert.ok(face.planenum >= 0 && face.planenum < bsp.planes.length, `face ${index} plane`);

    for (let e = 0; e < face.numedges; e++) {
      const surfedge = bsp.surfedges[face.firstedge + e];
      assert.ok(surfedge !== undefined, `face ${index} surfedge ${e} missing`);
      const edgeIndex = Math.abs(surfedge!) ;
      const edge = bsp.edges[edgeIndex];
      assert.ok(edge, `face ${index} edge ${edgeIndex} out of range`);
      assert.ok(edge!.v[0] < bsp.vertices.length, `face ${index} edge vertex A`);
      assert.ok(edge!.v[1] < bsp.vertices.length, `face ${index} edge vertex B`);
    }
  }
});

test('parsed textures keep their name, size and palette', () => {
  const { map, report } = whiteHouseBsp();
  const bsp = parseBsp(report.buffer);

  const materials = new Set(map.boxes.map((box) => box.material));
  assert.equal(bsp.miptex.length, materials.size, 'one miptex per material');

  for (const texture of bsp.miptex) {
    assert.ok(texture.name.length > 0, 'texture has a name');
    assert.equal(texture.external, false);
    assert.equal(texture.width, 64);
    assert.equal(texture.height, 64);
    assert.equal(texture.pixels.length, 64 * 64);
    assert.equal(texture.palette.length, 256 * 3);
  }
});

test('entity lump round-trips spawn positions', () => {
  const { map, report } = whiteHouseBsp();
  const bsp = parseBsp(report.buffer);

  const starts = bsp.entityList.filter((entity) => entity.classname === 'info_player_start');
  assert.equal(starts.length, 1);
  const origin = starts[0]!.origin;
  assert.ok(origin, 'spawn has an origin');
  const expected = map.spawns[0]!.origin;
  assert.equal(Math.round(origin!.x), Math.round(expected.x));
  assert.equal(Math.round(origin!.y), Math.round(expected.y));
  assert.equal(Math.round(origin!.z), Math.round(expected.z));

  const terrorist = bsp.entityList.find((entity) => entity.classname === T_CLASS);
  assert.ok(terrorist, 'T spawn present');
});

// 功能：用仓库内真实 Dust2 BSP 校验 T 在西侧、CT 在东侧的原版出生位置。时间：2026-09-29；作者：lq。
test('real de_dust2 BSP maps start entities to their buy-zone teams', async () => {
  const bytes = await readFile(new URL('../public/cstrike/maps/de_dust2.bsp', import.meta.url));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const bsp = parseBsp(buffer);
  const spawns = spawnsFromBsp(bsp);
  const terrorists = spawns.filter((spawn) => spawn.team === 't');
  const counterTerrorists = spawns.filter((spawn) => spawn.team === 'ct');

  assert.equal(spawns.length, 40);
  assert.equal(terrorists.length, 20);
  assert.equal(counterTerrorists.length, 20);
  assert.ok(terrorists.every((spawn) => spawn.origin.y < 0), 'T spawns belong to the west buy zone');
  assert.ok(counterTerrorists.every((spawn) => spawn.origin.y > 1900), 'CT spawns belong to the east buy zone');
});

test('point contents: solid inside the ground, empty in the air', () => {
  const { report } = whiteHouseBsp();
  const bsp = parseBsp(report.buffer);
  const world = new BspCollisionWorld(bsp);

  // The courtyard floor slab occupies z in [-16, 0].
  assert.equal(world.pointContents(v3(0, 0, -8)), CONTENTS_SOLID, 'inside the floor slab');
  assert.notEqual(world.pointContents(v3(0, 0, 64)), CONTENTS_SOLID, 'above the floor is open');
});

test('clipnode collision: falls, lands and is blocked by walls', () => {
  const { report } = whiteHouseBsp();
  const bsp = parseBsp(report.buffer);
  const world = new BspCollisionWorld(bsp);

  // Landing on the courtyard floor: top surface z = 0, hull is 72 tall.
  // (Drop in the open courtyard, not over the house roof.)
  const fall = createMoveState(v3(0, 420, 300));
  for (let i = 0; i < 200; i++) pmPlayerMove(fall, world, cmd(), TICK_INTERVAL);
  assert.equal(fall.onground, true, 'should be standing');
  assert.ok(Math.abs(fall.origin.z - 36) < 0.5, `resting z was ${fall.origin.z}, want ~36`);

  // A point trace into the courtyard's outer wall must be blocked.
  const wallTrace = world.traceHull(
    HULL_STANDING,
    v3(0, 560, 40),
    v3(0, 900, 40),
  );
  assert.ok(wallTrace.fraction < 1, 'the outer wall must stop the trace');
  assert.ok(wallTrace.normal.y < -0.9, `expected a -Y wall normal, got ${JSON.stringify(wallTrace.normal)}`);
});

test('clipnode collision matches the brush backend on the white house', () => {
  const { map, report } = whiteHouseBsp();
  const bsp = parseBsp(report.buffer);
  const bspWorld = new BspCollisionWorld(bsp);
  const brushWorld: CollisionWorld = new BrushWorld(
    BrushWorld.fromBoxes(map.boxes).brushes,
  );

  const start = v3(0, 520, 48);

  // 1. Walk straight into the house.
  const walk = (tick: number): UserCmd =>
    cmd({ buttons: IN_FORWARD | (tick % 40 < 20 ? IN_JUMP : 0), forwardmove: 400 });

  const brushTrail = trajectory(brushWorld, start, 270, 300, walk);
  const bspTrail = trajectory(bspWorld, start, 270, 300, walk);
  const walkError = compareTrajectories(brushTrail, bspTrail, 0.75, 'walk');

  // 2. Strafe-jump around the courtyard.
  const strafe = (_tick: number): UserCmd =>
    cmd({
      buttons: IN_FORWARD | IN_MOVERIGHT | IN_JUMP,
      forwardmove: 400,
      sidemove: 400,
    });
  const brushStrafe = trajectory(brushWorld, v3(-400, -400, 48), 45, 240, strafe);
  const bspStrafe = trajectory(bspWorld, v3(-400, -400, 48), 45, 240, strafe);
  const strafeError = compareTrajectories(brushStrafe, bspStrafe, 0.75, 'strafe');

  // 3. Crouch-walk through the crawl gap: the ducking hull uses hull 2.
  const crouch = (): UserCmd => cmd({ buttons: IN_FORWARD | IN_DUCK, forwardmove: 400 });
  const brushCrouch = trajectory(brushWorld, v3(0, -440, 48), 90, 200, crouch);
  const bspCrouch = trajectory(bspWorld, v3(0, -440, 48), 90, 200, crouch);
  const crouchError = compareTrajectories(brushCrouch, bspCrouch, 0.75, 'crouch');

  // Sanity: the crouching player actually got somewhere.
  const crouchEnd = bspCrouch[bspCrouch.length - 1]!;
  assert.ok(crouchEnd.y > -300, `crouch walk should advance, ended at y=${crouchEnd.y}`);

  void walkError;
  void strafeError;
  void crouchError;
});

test('the BSP hull trace agrees with the brush trace for the standing hull', () => {
  const { map, report } = whiteHouseBsp();
  const bsp = parseBsp(report.buffer);
  const bspWorld = new BspCollisionWorld(bsp);
  const brushWorld = BrushWorld.fromBoxes(map.boxes);

  // Sample a grid of rays through the courtyard and the house.
  let compared = 0;
  let worst = 0;
  for (let x = -520; x <= 520; x += 65) {
    for (let y = -520; y <= 520; y += 65) {
      for (const [start, end] of [
        [v3(x, y, 40), v3(x, y, 260)],
        [v3(x, y, 200), v3(x, y, -40)],
      ] as [Vec3, Vec3][]) {
        const a = brushWorld.traceHull(HULL_STANDING, start, end);
        const b = bspWorld.traceHull(HULL_STANDING, start, end);
        const difference = Math.abs(a.fraction - b.fraction);
        if (difference > worst) worst = difference;
        assert.ok(
          difference < 0.02,
          `trace from ${JSON.stringify(start)} to ${JSON.stringify(end)} disagreed: ` +
            `brush fraction ${a.fraction.toFixed(4)} vs bsp ${b.fraction.toFixed(4)}`,
        );
        compared++;
      }
    }
  }
  assert.ok(compared > 400, `expected a decent sample size, compared ${compared}`);
  void worst;
});

test('ducking hull fits through the crawl gap in the BSP world too', () => {
  const { report } = whiteHouseBsp();
  const bsp = parseBsp(report.buffer);
  const world = new BspCollisionWorld(bsp);

  // The crawl gap sits at x in [-160,160], y in [-560,-480]: 40 units high.
  const standTrace = world.traceHull(HULL_STANDING, v3(0, -600, 20), v3(0, -440, 20));
  const duckTrace = world.traceHull(HULL_DUCKING, v3(0, -600, 20), v3(0, -440, 20));

  assert.ok(standTrace.fraction < 1, 'the standing hull must be blocked');
  assert.equal(duckTrace.fraction, 1, 'the ducking hull must pass through');
});

test('BSP geometry builds into renderable meshes with all attributes', async () => {
  const { buildBspMeshes } = await import('../src/engine/bsp/geometry.ts');
  const { report } = whiteHouseBsp();
  const bsp = parseBsp(report.buffer);

  const meshes = buildBspMeshes(bsp);
  assert.equal(meshes.faceCount, bsp.faces.length, 'every face should produce geometry');
  assert.ok(meshes.triangleCount > 0, 'triangles were generated');
  assert.ok(meshes.group.children.length > 0, 'at least one mesh per texture');
  assert.ok(meshes.lightmapPixels > 0, 'lightmap atlas has data');

  for (const child of meshes.group.children) {
    const mesh = child as unknown as {
      geometry: {
        getAttribute(name: string): { count: number } | undefined;
        getIndex(): { count: number } | null;
      };
    };
    const position = mesh.geometry.getAttribute('position');
    const normal = mesh.geometry.getAttribute('normal');
    const uv = mesh.geometry.getAttribute('uv');
    const uv1 = mesh.geometry.getAttribute('uv1');
    const index = mesh.geometry.getIndex();
    assert.ok(position && normal && uv && uv1, 'all attributes present');
    assert.equal(position!.count, normal!.count, 'position/normal counts');
    assert.equal(position!.count, uv!.count, 'position/uv counts');
    assert.equal(position!.count, uv1!.count, 'position/lightmap-uv counts');
    assert.ok(index && index.count > 0 && index.count % 3 === 0, 'index buffer is triangles');
  }
});

test('spawn resolution places the hull on the floor, not inside geometry', async () => {
  const { resolveSpawn, hullIsEmbedded } = await import('../src/game/map/loader.ts');
  const { report } = whiteHouseBsp();
  const bsp = parseBsp(report.buffer);
  const world = new BspCollisionWorld(bsp);

  // Spawns in the generated file sit on the courtyard floor at z = 48.
  const resolved = resolveSpawn(world, v3(0, 520, 48));
  assert.equal(hullIsEmbedded(world, resolved), false, 'resolved spawn must be free');
  assert.ok(resolved.z > 30 && resolved.z < 45, `resolved z was ${resolved.z}, want the hull centre ~36`);
});

test('pointing the camera at the player spawn sees the world, not the void', () => {
  const { report } = whiteHouseBsp();
  const bsp = parseBsp(report.buffer);
  const world = new BspCollisionWorld(bsp);

  // Rays in the four cardinal directions from eye height should hit something
  // within the courtyard unless they go out through a window; check the ground
  // and the house are both reachable.
  const down = world.traceHull(HULL_STANDING, v3(0, 520, 60), v3(0, 520, -64));
  assert.ok(down.fraction < 1, 'the ground must be below the spawn');

  // Offset in x so the ray does not simply fly through the front door.
  const towardHouse = world.traceHull(HULL_STANDING, v3(120, 300, 60), v3(120, 100, 60));
  assert.ok(towardHouse.fraction < 1, 'the house must be in front of the spawn');
  // The ray travels in -Y, so the blocking surface normal points back at us: +Y.
  assert.ok(towardHouse.normal.y > 0.9, 'and its wall normal should face the courtyard');
});

test('WAD3 archives round-trip: names, sizes, pixels and palette', async () => {
  const { buildWad3, generateTexture } = await import('../src/engine/bsp/write.ts');
  const { parseWad3, lookupTexture } = await import('../src/engine/bsp/wad.ts');

  const entries = [
    { name: 'cstrike_test', texture: generateTexture('brick', 64) },
    { name: 'hl_test', texture: generateTexture('sand', 64) },
  ];
  const wad = parseWad3(buildWad3(entries));

  assert.equal(wad.numlumps, 2);
  assert.equal(wad.textures.size, 2, 'both miptex lumps decoded');
  assert.equal(wad.skipped.length, 0);

  for (const entry of entries) {
    const texture = lookupTexture([wad], entry.name);
    assert.ok(texture, `${entry.name} should be found`);
    assert.equal(texture!.width, 64);
    assert.equal(texture!.height, 64);
    assert.equal(texture!.pixels.length, 64 * 64);
    assert.equal(texture!.palette.length, 256 * 3);
    // The pixels must come back identical to what was written.
    const original = entry.texture.pixels;
    for (let i = 0; i < original.length; i += 97) {
      assert.equal(texture!.pixels[i], original[i], `pixel ${i} of ${entry.name}`);
    }
  }

  assert.equal(lookupTexture([wad], 'not_there'), undefined);
});

test('external BSP textures are resolved from a WAD by name', async () => {
  const { buildWad3, compileBsp, generateTexture } = await import('../src/engine/bsp/write.ts');
  const { parseWad3 } = await import('../src/engine/bsp/wad.ts');
  const { buildBspMeshes } = await import('../src/engine/bsp/geometry.ts');

  const map = buildWhiteHouse();
  const spawns = map.spawns.map((spawn, index) => ({
    origin: spawn.origin,
    yaw: spawn.yaw,
    classname: index === 0 ? 'info_player_start' : 'info_player_terrorist',
  }));

  const external = ['sand', 'brick'];
  const report = compileBsp({
    boxes: map.boxes,
    spawns,
    externalTextures: external,
    worldspawn: { wad: 'test.wad', skyname: 'desert' },
  });
  const bsp = parseBsp(report.buffer);

  // The compiler marked those two as external and recorded the WAD in worldspawn.
  const externalTextures = bsp.miptex.filter((texture) => texture.external);
  assert.equal(externalTextures.length, external.length, 'two textures should be external');
  assert.ok(
    bsp.entityList.some(
      (entity) => entity.classname === 'worldspawn' && entity.properties['wad'] === 'test.wad',
    ),
    'worldspawn must carry the wad list',
  );

  // Without a WAD the textures fall back to placeholders.
  const withoutWad = buildBspMeshes(bsp);
  assert.equal(withoutWad.externalTextures.length, 2);
  assert.equal(withoutWad.resolvedFromWad.length, 0);

  // With the WAD they resolve.
  const wad = parseWad3(
    buildWad3(external.map((name) => ({ name, texture: generateTexture(name, 64) }))),
  );
  const withWad = buildBspMeshes(bsp, { wadTextures: wad.textures });
  assert.equal(withWad.externalTextures.length, 0, 'nothing left unresolved');
  assert.equal(withWad.resolvedFromWad.length, 2, 'both came from the WAD');
  assert.equal(withWad.faceCount, bsp.faces.length, 'geometry unaffected');
});
