/** 功能：从本机原版地图中只提取月球基地使用的八张贴图，生成默认随图包与来源清单；时间：2026-11-17；作者：lq。 */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { parseWad3 } from '../src/engine/bsp/wad.ts';
import { buildWad3 } from '../src/engine/bsp/write.ts';
import { MOONBASE_MATERIALS } from '../src/game/map/moonbaseMaterials.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const archives = new Map();
const entries = [];
const manifest = { map: 'moonbase', author: 'lq', date: '2026-11-17',
  notice: 'Original Counter-Strike/GoldSrc textures retain their original rights. Original map layout does not grant texture redistribution permission.', textures: [] };
for (const entry of MOONBASE_MATERIALS) {
  if (!archives.has(entry.source)) {
    const bytes = await readFile(resolve(root, 'public/cstrike', `${entry.source}.wad`));
    archives.set(entry.source, parseWad3(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)).textures);
  }
  const texture = archives.get(entry.source).get(entry.texture);
  if (!texture || texture.external) throw new Error(`缺少原版贴图 ${entry.source}/${entry.texture}`);
  entries.push({ name: entry.name, texture });
  manifest.textures.push({ material: entry.name, map: entry.source, texture: entry.texture, width: texture.width, height: texture.height });
}
const target = resolve(root, 'public/moonbase');
await mkdir(target, { recursive: true });
const wad = buildWad3(entries);
await writeFile(resolve(target, 'materials.wad'), new Uint8Array(wad));
await writeFile(resolve(target, 'materials.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`月球基地随图包：${entries.length} 张贴图，${(wad.byteLength / 1024).toFixed(1)} KB`);
