#!/usr/bin/env node
/**
 * Lists the maps and assets inside a local Counter-Strike installation.
 *
 * Nothing is uploaded or redistributed: this only reads a directory you point it
 * at and prints what is there, so you can pick which .bsp to convert.
 *
 * Usage:
 *   node tools/list-maps.mjs "/path/to/Counter-Strike 1.5/cstrike"
 *   node tools/list-maps.mjs ~/CS1.5 --json
 *
 * If you omit the path, a few common locations are probed.
 */

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const givenPath = args.find((a) => !a.startsWith('--'));

const CANDIDATES = [
  'cstrike',
  'Counter-Strike/cstrike',
  'Counter-Strike 1.5/cstrike',
  'CS1.5/cstrike',
  'cs1.5/cstrike',
  'Program Files (x86)/Steam/steamapps/common/Half-Life/cstrike',
  'Library/Application Support/Steam/steamapps/common/Half-Life/cstrike',
];

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Finds the directory that actually contains maps/ and *.wad files. */
function findGameDir(input) {
  const tried = [];
  const roots = input ? [resolve(input.replace(/^~/, homedir()))] : CANDIDATES.map((c) => join(homedir(), c));

  for (const root of roots) {
    tried.push(root);
    if (!isDir(root)) continue;

    const subdirs = [root, join(root, 'cstrike'), join(root, 'valve'), join(root, 'maps')];
    for (const dir of subdirs) {
      if (!isDir(dir)) continue;
      const hasMaps = isDir(join(dir, 'maps'));
      const target = hasMaps ? join(dir, 'maps') : dir;
      let entries = [];
      try {
        entries = readdirSync(target);
      } catch {
        continue;
      }
      if (entries.some((e) => e.toLowerCase().endsWith('.bsp'))) {
        return { gameDir: hasMaps ? dir : dir, mapsDir: target, tried };
      }
    }
  }
  return { gameDir: null, mapsDir: null, tried };
}

function listFiles(dir, extension) {
  if (!dir || !isDir(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(extension))
    .map((name) => {
      const full = join(dir, name);
      const stat = statSync(full);
      return { name, bytes: stat.size, mtime: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.bytes - a.bytes);
}

function human(bytes) {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

const found = findGameDir(givenPath);

if (!found.mapsDir) {
  const message = [
    '没有找到 Counter-Strike 的 maps 目录。',
    '',
    '请把 CS 1.5（或 CS 1.6）里 cstrike 目录的路径作为参数传进来，例如：',
    '   node tools/list-maps.mjs "/Users/liqiang/Downloads/CS1.5/cstrike"',
    '',
    '已尝试过的路径：',
    ...found.tried.map((p) => `   ${p}`),
  ].join('\n');

  if (asJson) {
    console.log(JSON.stringify({ ok: false, error: 'maps directory not found', tried: found.tried }, null, 2));
  } else {
    console.log(message);
  }
  process.exit(found.mapsDir ? 0 : 1);
}

const maps = listFiles(found.mapsDir, '.bsp');
// WADs usually sit one level above maps/.
const wadDirs = [found.gameDir, join(found.gameDir, '..')];
const wads = [];
for (const dir of wadDirs) {
  for (const wad of listFiles(dir, '.wad')) {
    if (!wads.some((w) => w.name === wad.name && w.bytes === wad.bytes)) wads.push(wad);
  }
}

const soundDir = join(found.gameDir, 'sound');
const modelDir = join(found.gameDir, 'models');
const hasSound = isDir(soundDir);
const hasModels = isDir(modelDir);

if (asJson) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        gameDir: found.gameDir,
        mapsDir: found.mapsDir,
        maps,
        wads,
        sound: hasSound,
        models: hasModels,
      },
      null,
      2,
    ),
  );
} else {
  console.log(`游戏目录 : ${found.gameDir}`);
  console.log(`地图目录 : ${found.mapsDir}`);
  console.log(`音效目录 : ${hasSound ? join(soundDir, '') : '（未找到 sound/）'}`);
  console.log(`模型目录 : ${hasModels ? join(modelDir, '') : '（未找到 models/）'}`);
  console.log('');
  console.log(`地图 ${maps.length} 张：`);
  for (const m of maps) {
    console.log(`  ${basename(m.name, '.bsp').padEnd(24)} ${human(m.bytes).padStart(9)}   ${m.mtime.slice(0, 10)}`);
  }
  console.log('');
  console.log(`WAD 贴图包 ${wads.length} 个：`);
  for (const w of wads) {
    console.log(`  ${w.name.padEnd(24)} ${human(w.bytes).padStart(9)}`);
  }
  console.log('');
  console.log('挑好之后把地图名告诉助手，例如 de_dust2 或 cs_xxx，');
  console.log('下一步会用 tools/extract-assets.mjs 把这张图和它引用的贴图转换到 public/cstrike/。');
}
