#!/usr/bin/env node
/**
 * Converts a map from a local Counter-Strike installation into web assets.
 *
 *   node tools/extract-assets.mjs --game "<CS1.5目录>" --map de_dust2
 *   node tools/extract-assets.mjs --game "<CS1.5目录>" --all
 *
 * What it does, and why:
 *   - reads the .bsp and finds which textures it stores *externally* (Valve's maps
 *     keep most textures in WAD archives, referenced by name);
 *   - finds those textures in the install's WADs (cstrike.wad, halflife.wad, ...);
 *   - writes a **trimmed** WAD containing only the textures this map needs. A full
 *     halflife.wad is 38 MB; dust2 only needs a few hundred kB of it;
 *   - copies the .bsp into public/cstrike/maps/.
 *
 * Nothing here is redistributed: the output stays in your project directory and
 * public/cstrike/ is git-ignored.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseBsp, bspStats } from '../src/engine/bsp/reader.ts';
import { parseWad3 } from '../src/engine/bsp/wad.ts';
import { buildWad3 } from '../src/engine/bsp/write.ts';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

// ------------------------------------------------------------------ arguments

const args = process.argv.slice(2);
function argValue(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const gameDirArg = argValue('--game');
const mapArg = argValue('--map');
const all = args.includes('--all');
const outDir = resolve(projectRoot, argValue('--out', 'public/cstrike'));

if (!gameDirArg || (!mapArg && !all)) {
  console.log(`用法:
  node tools/extract-assets.mjs --game "<CS1.5目录>" --map de_dust2
  node tools/extract-assets.mjs --game "<CS1.5目录>" --all

  --game 指向包含 cstrike/ 与 valve/ 的目录（也可以直接指向 cstrike/）
  --out  输出目录，默认 public/cstrike`);
  process.exit(1);
}

// ------------------------------------------------------------------ locations

function findGameDirs(input) {
  const root = resolve(input.replace(/^~/, process.env.HOME ?? '~'));
  const candidates = [
    { cstrike: join(root, 'cstrike'), valve: join(root, 'valve') },
    { cstrike: root, valve: join(root, '..', 'valve') },
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(join(candidate.cstrike, 'maps')).isDirectory()) return candidate;
    } catch {
      /* keep looking */
    }
  }
  throw new Error(`在 ${root} 里找不到 cstrike/maps 目录`);
}

const game = findGameDirs(gameDirArg);

function listFiles(dir, extension) {
  try {
    return readdirSync(dir).filter((f) => f.toLowerCase().endsWith(extension));
  } catch {
    return [];
  }
}

function human(bytes) {
  return bytes > 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(2)} MB`
    : `${(bytes / 1024).toFixed(0)} KB`;
}

const wadPaths = [
  ...listFiles(game.cstrike, '.wad').map((f) => join(game.cstrike, f)),
  ...listFiles(game.valve, '.wad').map((f) => join(game.valve, f)),
];

// ------------------------------------------------------------------ WAD index

/** Parses WAD archives lazily and keeps a name -> texture index. */
function createWadIndex() {
  const loaded = new Map(); // path -> Wad3File
  const byName = new Map(); // lower case texture name -> texture
  const loadedNames = [];

  const load = (path) => {
    if (loaded.has(path)) return loaded.get(path);
    const buffer = readFileSync(path);
    const parsed = parseWad3(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    );
    loaded.set(path, parsed);
    loadedNames.push(join(path).split('/').pop());
    for (const [key, texture] of parsed.textures) {
      if (!byName.has(key)) byName.set(key, texture);
    }
    return parsed;
  };

  return { load, byName, loadedNames };
}

// ------------------------------------------------------------------ conversion

function preferredWads(bsp) {
  const names = [];
  for (const entity of bsp.entityList) {
    if (entity.classname.toLowerCase() !== 'worldspawn') continue;
    const list = entity.properties['wad'];
    if (!list) continue;
    for (const entry of list.split(';')) {
      const base = entry.trim().split(/[\\/]/).pop();
      if (base && base.toLowerCase().endsWith('.wad')) names.push(base.toLowerCase());
    }
  }
  return names;
}

function convertMap(mapName, index, sourceCache) {
  const bspPath = join(game.cstrike, 'maps', `${mapName}.bsp`);
  if (!statSync(bspPath, { throwIfNoEntry: false })) {
    return { mapName, error: '找不到 .bsp' };
  }

  const raw = readFileSync(bspPath);
  const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const bsp = parseBsp(buffer);
  const stats = bspStats(bsp);

  const externalNames = [...new Set(bsp.miptex.filter((t) => t.external).map((t) => t.name))];

  // Load the WADs the map itself asks for first, then everything else.
  const wanted = preferredWads(bsp);
  const ordered = [
    ...wadPaths.filter((p) => wanted.includes(p.split('/').pop().toLowerCase())),
    ...wadPaths.filter((p) => !wanted.includes(p.split('/').pop().toLowerCase())),
  ];
  for (const path of ordered) {
    if (externalNames.every((name) => index.byName.has(name.toLowerCase()))) break;
    index.load(path);
  }

  const found = [];
  const missing = [];
  for (const name of externalNames) {
    const texture = index.byName.get(name.toLowerCase());
    if (!texture) missing.push(name);
    else found.push({ name, texture });
  }

  mkdirSync(join(outDir, 'maps'), { recursive: true });
  writeFileSync(join(outDir, 'maps', `${mapName}.bsp`), raw);

  let wadBytes = 0;
  if (found.length > 0) {
    const wad = buildWad3(found);
    wadBytes = wad.byteLength;
    writeFileSync(join(outDir, `${mapName}.wad`), Buffer.from(wad));
  }

  sourceCache.push({ mapName, stats, external: externalNames.length, packed: found.length, missing, wadBytes, bspBytes: raw.length });
  return { mapName, stats, external: externalNames.length, packed: found.length, missing, wadBytes };
}

// ------------------------------------------------------------------ run

const mapNames = all
  ? listFiles(join(game.cstrike, 'maps'), '.bsp').map((f) => f.replace(/\.bsp$/i, '')).sort()
  : [mapArg];

console.log(`游戏目录  ${game.cstrike}`);
console.log(`输出目录  ${outDir}`);
console.log(`待处理    ${mapNames.length} 张地图`);
console.log('');

const index = createWadIndex();
const results = [];
const started = Date.now();

for (const name of mapNames) {
  try {
    const result = convertMap(name, index, results);
    if ('error' in result && result.error) {
      console.log(`${name.padEnd(16)} ✗ ${result.error}`);
      continue;
    }
    const missingNote = result.missing.length > 0 ? `  ⚠ 缺 ${result.missing.length} 张: ${result.missing.slice(0, 4).join(',')}` : '';
    console.log(
      `${name.padEnd(16)} 面 ${String(result.stats.faces).padStart(6)}  ` +
        `外部贴图 ${String(result.external).padStart(3)} → 打包 ${String(result.packed).padStart(3)}  ` +
        `WAD ${human(result.wadBytes).padStart(9)}${missingNote}`,
    );
  } catch (error) {
    console.log(`${name.padEnd(16)} ✗ ${String(error).slice(0, 90)}`);
  }
}

const totalWad = results.reduce((sum, r) => sum + r.wadBytes, 0);
const totalBsp = results.reduce((sum, r) => sum + r.bspBytes, 0);
console.log('');
console.log(`完成：${results.length} 张地图，用时 ${((Date.now() - started) / 1000).toFixed(1)} s`);
console.log(`  BSP 合计 ${human(totalBsp)}   WAD 合计 ${human(totalWad)}（已加载 ${index.loadedNames.length} 个源 WAD）`);
console.log('');
console.log('在浏览器里打开： http://127.0.0.1:5173/?map=' + (mapNames[0] ?? 'de_dust2'));
