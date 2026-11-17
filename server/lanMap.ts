/** 功能：房主只读取地图碰撞与出生点，不创建 WebGL 或加载贴图；时间：2026-11-17；作者：lq。 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseBsp } from '../src/engine/bsp/reader.ts';
import { BspCollisionWorld } from '../src/engine/bsp/collision.ts';
import { BspEntityWorld } from '../src/game/map/interactions.ts';
import { spawnsFromBsp, resolveSpawn, pickSpawn } from '../src/game/map/loader.ts';
import type { MapData } from '../src/game/map/build.ts';
import { buildWhiteHouse } from '../src/game/map/whitehouse.ts';
import { mapFingerprint } from '../src/net/protocol.ts';
import { buildMoonbase, MOONBASE_ID } from '../src/game/map/moonbase.ts';

/** 功能：指定地图必须存在，禁止服务端静默换图造成客户端穿墙；时间：2026-11-17；作者：lq。 */
export async function loadLanMap(root: string, name: string): Promise<MapData> {
  if (!/^[a-z0-9_-]+$/.test(name)) throw new Error('地图名称无效');
  if (name === MOONBASE_ID) return { ...buildMoonbase(), fingerprint: 'moonbase-v1' };
  if (name === 'white_house') return { ...buildWhiteHouse(), fingerprint: 'white-house-boxes-v1' };
  let bytes: Buffer;
  try { bytes = await readFile(resolve(root, 'public/cstrike/maps', `${name}.bsp`)); }
  catch (error) {
    throw new Error(`找不到地图 ${name}.bsp，请先准备房主本机素材。`);
  }
  const bsp = parseBsp(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const interactions = name === 'cs_assault' ? new BspEntityWorld(bsp) : undefined;
  const collision = interactions ?? new BspCollisionWorld(bsp);
  const spawns = spawnsFromBsp(bsp).map((spawn) => ({ ...spawn, origin: resolveSpawn(collision, spawn.origin) }));
  const chosen = spawns.length ? pickSpawn(collision, spawns) : null;
  const model = bsp.models[0]!;
  return {
    name: `BSP: ${name}`, id: name, fingerprint: mapFingerprint(bytes), bsp, collision, interactions,
    spawns: chosen ? [chosen, ...spawns.filter((spawn) => spawn !== chosen)] : buildWhiteHouse().spawns,
    bounds: { mins: model.mins, maxs: model.maxs }, boxes: [], skyColor: 0x86a8c8, fogColor: 0xa8bccd,
  };
}
