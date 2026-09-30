#!/usr/bin/env node
/**
 * Compiles the built-in box map into a real GoldSrc BSP v30 file.
 *
 * Usage:
 *   node tools/make-bsp.mjs                 # writes public/cstrike/maps/white_house.bsp
 *   node tools/make-bsp.mjs --out foo.bsp
 *
 * Why: it exercises the whole BSP path (reader, clipnode collision, palettised
 * textures, lightmaps, entities) in the browser without needing any of Valve's
 * data, and it means the built-in map is loaded through exactly the same code
 * path a real de_dust2.bsp will use.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildWhiteHouse } from '../src/game/map/whitehouse.ts';
import { buildWad3, compileBsp, generateTexture } from '../src/engine/bsp/write.ts';
import { parseBsp, bspStats } from '../src/engine/bsp/reader.ts';
import { BspCollisionWorld } from '../src/engine/bsp/collision.ts';
import { HULL_STANDING } from '../src/engine/collision/types.ts';
import { v3 } from '../src/engine/math.ts';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outPath =
  outIndex >= 0 && args[outIndex + 1]
    ? resolve(process.cwd(), args[outIndex + 1])
    : resolve(projectRoot, 'public/cstrike/maps/white_house.bsp');

const map = buildWhiteHouse();
const spawns = map.spawns.map((spawn, index) => ({
  origin: spawn.origin,
  yaw: spawn.yaw,
  classname:
    index === 0
      ? 'info_player_counterterrorist'
      : spawn.team === 'ct'
        ? 'info_player_counterterrorist'
        : 'info_player_terrorist',
}));

// Deliberately move two materials into a WAD, the way Valve's maps do it, so the
// browser exercises the external-texture path (bsp -> wad -> texture lookup).
const EXTERNAL = ['sand', 'brick'];
const WAD_NAME = 'white_house.wad';

console.log(`编译 ${map.name}：${map.boxes.length} 个 brush …`);
const started = Date.now();
const report = compileBsp({
  boxes: map.boxes,
  spawns,
  externalTextures: EXTERNAL,
  worldspawn: { wad: WAD_NAME, skyname: 'desert' },
});
const elapsed = Date.now() - started;

// Read it straight back: a writer that cannot be read is worthless.
const parsed = parseBsp(report.buffer);
const stats = bspStats(parsed);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, Buffer.from(report.buffer));

// And the WAD those two materials now live in.
const wadPath = resolve(dirname(outPath), '..', WAD_NAME);
const wad = buildWad3(
  EXTERNAL.map((name) => ({ name, texture: generateTexture(name, 64) })),
);
writeFileSync(wadPath, Buffer.from(wad));

const collision = new BspCollisionWorld(parsed);
const floorProbe = collision.traceHull(HULL_STANDING, v3(0, 520, 120), v3(0, 520, -40));

console.log(`完成，用时 ${elapsed} ms`);
console.log(`  输出      ${outPath}`);
console.log(`  WAD       ${wadPath}  (${EXTERNAL.join(', ')})`);
console.log(`  大小      ${(report.buffer.byteLength / 1024).toFixed(1)} KB`);
console.log(`  planes    ${stats.planes}`);
console.log(`  nodes     ${stats.nodes}  (hull 0)`);
console.log(`  clipnodes ${stats.clipnodes}  (hulls 1-3)`);
console.log(`  leaves    ${stats.leaves}  其中实心 ${stats.solidLeaves}`);
console.log(`  faces     ${stats.faces}  有光照图 ${stats.litFaces}`);
console.log(`  textures  ${stats.textures}`);
console.log(`  entities  ${stats.entities}`);
console.log(
  `  自检      从 z=120 落到 z=-40 的 hull1 射线 fraction=${floorProbe.fraction.toFixed(4)} ` +
    `(约落在 z=${(120 + floorProbe.fraction * -160).toFixed(2)}，地面应为 36)`,
);
