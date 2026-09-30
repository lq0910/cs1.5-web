/**
 * Map loading.
 *
 * Two sources, one interface:
 *   1. a real GoldSrc BSP (public/cstrike/maps/<name>.bsp) — geometry, textures,
 *      baked lightmaps and clipnode collision all come from the file;
 *   2. the built-in box map — used when no BSP has been extracted yet, so the
 *      project is always runnable.
 *
 * The loader never throws because of a missing asset: a 404 simply falls back,
 * and the reason is reported so the HUD can show which path is active.
 */

import type * as THREE from 'three';
import { v3 } from '../../engine/math.ts';
import type { MapData, MapSpawn } from './build.ts';
import { buildWhiteHouse } from './whitehouse.ts';
import { parseBsp, bspStats } from '../../engine/bsp/reader.ts';
import { BspCollisionWorld } from '../../engine/bsp/collision.ts';
import { buildBspMeshes } from '../../engine/bsp/geometry.ts';
import { parseWad3 } from '../../engine/bsp/wad.ts';
import type { BspMiptex } from '../../engine/bsp/types.ts';
import { HULL_STANDING } from '../../engine/collision/types.ts';
import type { CollisionWorld } from '../../engine/collision/types.ts';
import type { Vec3 } from '../../engine/math.ts';

const PROBE_DIRECTIONS = 8;

/** How much open space surrounds a position (sum of 8 horizontal traces). */
function openness(world: CollisionWorld, eye: Vec3): number {
  let total = 0;
  for (let i = 0; i < PROBE_DIRECTIONS; i++) {
    const angle = (i / PROBE_DIRECTIONS) * Math.PI * 2;
    const trace = world.traceHull(
      HULL_STANDING,
      eye,
      v3(eye.x + Math.cos(angle) * 2048, eye.y + Math.sin(angle) * 2048, eye.z),
    );
    total += Math.min(1024, trace.fraction * 2048);
  }
  return total;
}

/** Distance straight ahead of a yaw, used to detect "spawn facing a wall". */
function forwardSpace(world: CollisionWorld, eye: Vec3, yawDeg: number): number {
  const yaw = (yawDeg * Math.PI) / 180;
  const trace = world.traceHull(
    HULL_STANDING,
    eye,
    v3(eye.x + Math.cos(yaw) * 2048, eye.y + Math.sin(yaw) * 2048, eye.z),
  );
  return trace.fraction * 2048;
}

/** Best yaw for a spawn: the most open of the eight probe directions. */
function bestYaw(world: CollisionWorld, eye: Vec3): number {
  let best = 0;
  let bestSpace = -1;
  for (let i = 0; i < PROBE_DIRECTIONS; i++) {
    const yawDeg = (i / PROBE_DIRECTIONS) * 360;
    const space = forwardSpace(world, eye, yawDeg);
    if (space > bestSpace) {
      bestSpace = space;
      best = yawDeg;
    }
  }
  return best;
}

/**
 * Picks the spawn with the most open space around it.
 *
 * CS 1.5 maps often give spawns no angle at all (dust2 has none on any of its
 * 40 spawns), and picking the first entity can drop the player into a corner
 * staring at a wall. Choosing the roomiest spawn and, if it is still boxed in,
 * aiming at the most open direction keeps a playable first impression without
 * changing the map's intent when it does specify angles.
 */
export function pickSpawn(world: CollisionWorld, spawns: MapSpawn[]): MapSpawn {
  let best = spawns[0];
  let bestScore = -1;
  for (const spawn of spawns) {
    const eye = v3(spawn.origin.x, spawn.origin.y, spawn.origin.z + 17);
    const score = openness(world, eye);
    if (score > bestScore) {
      bestScore = score;
      best = spawn;
    }
  }
  if (!best) return spawns[0]!;

  const eye = v3(best.origin.x, best.origin.y, best.origin.z + 17);
  const yaw = Number.isFinite(best.yaw) && best.yaw !== 0 ? best.yaw : 0;
  if (forwardSpace(world, eye, yaw) < 128) {
    return { ...best, yaw: bestYaw(world, eye) };
  }
  return best;
}

/** True when the standing hull already intersects geometry at this position. */
export function hullIsEmbedded(world: CollisionWorld, origin: Vec3): boolean {
  const trace = world.traceHull(HULL_STANDING, origin, origin);
  return trace.startsolid || trace.allsolid;
}

/**
 * Places a spawn on the floor below it.
 *
 * Real CS maps are inconsistent about whether a spawn origin sits at the feet or
 * at the player centre, so instead of guessing we trace the standing hull
 * downwards and let it land, then verify the result is not embedded.
 */
export function resolveSpawn(world: CollisionWorld, origin: Vec3): Vec3 {
  const start = v3(origin.x, origin.y, origin.z + 64);
  const end = v3(origin.x, origin.y, origin.z - 128);
  const trace = world.traceHull(HULL_STANDING, start, end);
  if (trace.fraction < 1 && !trace.startsolid) {
    const landed = v3(
      trace.endpos.x,
      trace.endpos.y,
      trace.endpos.z + 1,
    );
    if (!hullIsEmbedded(world, landed)) return landed;
  }

  // Fall back to nudging upwards until the hull fits.
  for (const offset of [0, 1, 18, 36, 54, 72]) {
    const candidate = v3(origin.x, origin.y, origin.z + offset);
    if (!hullIsEmbedded(world, candidate)) return candidate;
  }
  return v3(origin.x, origin.y, origin.z);
}


export interface LoadedMap {
  map: MapData;
  /** Render object for BSP maps; undefined for the built-in box map. */
  object?: THREE.Object3D;
  source: 'bsp' | 'boxes';
  /** Human readable summary for the HUD. */
  note: string;
  /** GoldSrc skybox name from worldspawn (e.g. "des" for dust2). */
  skyName?: string;
  stats?: Record<string, number | string>;
}

/**
 * Map preference: the requested map first, then the classic CS maps if the user
 * has extracted them, then the built-in test map (always available).
 */
const DEFAULT_BSP_CHAIN = ['de_dust2', 'cs_estate', 'white_house'];

/** Asset root; anything extracted from the user's CS install lives under here. */
export const CSTRIKE_ASSET_ROOT = 'cstrike';

export function bspUrlFor(name: string): string {
  return `${CSTRIKE_ASSET_ROOT}/maps/${name}.bsp`;
}

/**
 * Team buy zones: the engine's own authority on which side a spawn belongs to
 * (`func_buyzone` team 1 = T, team 2 = CT).
 *
 * 功能：按 GoldSrc 原版阵营编号读取买区，避免 Dust2 警匪出生点互换。
 * 时间：2026-09-29；作者：lq。
 */
function buyZonesFromBsp(data: ReturnType<typeof parseBsp>): { center: Vec3; team: 'ct' | 't' }[] {
  const zones: { center: Vec3; team: 'ct' | 't' }[] = [];
  for (const entity of data.entityList) {
    if ((entity.classname || '').toLowerCase() !== 'func_buyzone') continue;
    const model = entity.properties['model'];
    if (!model || !model.startsWith('*')) continue;
    const submodel = data.models[Number(model.slice(1))];
    if (!submodel) continue;
    const team = entity.properties['team'] === '1' ? 't' : entity.properties['team'] === '2' ? 'ct' : null;
    if (!team) continue;
    zones.push({
      center: v3(
        (submodel.mins.x + submodel.maxs.x) / 2,
        (submodel.mins.y + submodel.maxs.y) / 2,
        (submodel.mins.z + submodel.maxs.z) / 2,
      ),
      team,
    });
  }
  return zones;
}

// 功能：按实体位置与买区团队属性识别 BSP 出生点阵营，防止 Dust2 警匪出生点对调。时间：2026-09-29；作者：lq。
export function spawnsFromBsp(data: ReturnType<typeof parseBsp>): MapSpawn[] {
  const spawns: MapSpawn[] = [];
  const buyZones = buyZonesFromBsp(data);
  for (const entity of data.entityList) {
    const classname = entity.classname.toLowerCase();
    // 功能：原版 start 属于 CT、deathmatch 属于 T；带阵营名的实体按名称判定。时间：2026-09-29；作者：lq。
    let team: 'ct' | 't' | null = null;
    if (classname.includes('counterterrorist')) team = 'ct';
    else if (classname.includes('terrorist')) team = 't';
    else if (classname === 'info_player_start') team = 'ct';
    else if (classname === 'info_player_deathmatch') team = 't';
    if (!team) continue;
    if (!entity.origin) continue;

    // The buy zone wins when the map has them.
    if (buyZones.length > 0) {
      let best = buyZones[0]!;
      let bestDistance = Infinity;
      for (const zone of buyZones) {
        const distance = Math.hypot(zone.center.x - entity.origin.x, zone.center.y - entity.origin.y);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = zone;
        }
      }
      if (bestDistance < 1500) team = best.team;
    }

    // GoldSrc spawns sit at the entity origin (the hull centre); nudge up a
    // little so the player does not start embedded in the floor.
    spawns.push({
      origin: v3(entity.origin.x, entity.origin.y, entity.origin.z + 1),
      yaw: entity.angle,
      team,
    });
  }

  if (spawns.length === 0) {
    // Last resort: the first non-solid leaf centre.
    for (const leaf of data.leaves) {
      if (leaf.contents !== -1) continue;
      const centre = (lo: number, hi: number): number => (lo + hi) / 2;
      const origin = v3(
        centre(leaf.mins[0], leaf.maxs[0]),
        centre(leaf.mins[1], leaf.maxs[1]),
        centre(leaf.mins[2], leaf.maxs[2]) + 36,
      );
      spawns.push({ origin, yaw: 0, team: 'ct' });
      break;
    }
  }

  return spawns;
}

/** WAD names listed by the map's worldspawn entity, e.g. "cstrike.wad;halflife.wad". */
function wadNamesFromEntities(data: ReturnType<typeof parseBsp>): string[] {
  const fromWorldspawn: string[] = [];
  for (const entity of data.entityList) {
    if (entity.classname.toLowerCase() !== 'worldspawn') continue;
    const list = entity.properties['wad'];
    if (!list) continue;
    for (const entry of list.split(';')) {
      const trimmed = entry.trim().split(/[\\/]/).pop() ?? '';
      if (trimmed.toLowerCase().endsWith('.wad')) fromWorldspawn.push(trimmed);
    }
  }
  // Half-Life maps often list nothing, but these two are what the engine falls
  // back to for a CS install.
  const defaults = ['cstrike.wad', 'halflife.wad'];
  const names = [...fromWorldspawn];
  for (const fallback of defaults) {
    if (!names.some((n) => n.toLowerCase() === fallback)) names.push(fallback);
  }
  return names;
}

/**
 * Fetches and parses every WAD the map asks for, tolerating missing ones.
 *
 * The trimmed per-map WAD produced by tools/extract-assets.mjs comes first: it
 * holds exactly the textures this map uses, so a 38 MB halflife.wad is not
 * needed at runtime.
 */
async function loadWads(
  data: ReturnType<typeof parseBsp>,
  mapName: string,
): Promise<{ textures: Map<string, BspMiptex>; loaded: string[]; missing: string[] }> {
  const textures = new Map<string, BspMiptex>();
  const loaded: string[] = [];
  const missing: string[] = [];

  const candidates = [`${mapName}.wad`, ...wadNamesFromEntities(data).filter((n) => n !== `${mapName}.wad`)];

  for (const wadName of candidates) {
    try {
      const response = await fetch(`${CSTRIKE_ASSET_ROOT}/${wadName}`, { cache: 'force-cache' });
      if (!response.ok) {
        missing.push(wadName);
        continue;
      }
      const wad = parseWad3(await response.arrayBuffer());
      // Earlier archives win, matching the engine's search order.
      for (const [key, texture] of wad.textures) {
        if (!textures.has(key)) textures.set(key, texture);
      }
      loaded.push(wadName);
    } catch {
      missing.push(wadName);
    }
  }

  return { textures, loaded, missing };
}

async function loadBspMap(name: string): Promise<LoadedMap | null> {
  const url = bspUrlFor(name);
  let buffer: ArrayBuffer;
  try {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) return null;
    buffer = await response.arrayBuffer();
  } catch {
    return null;
  }

  // Dev servers answer a missing asset with index.html and a 200, so a parse
  // failure has to fall back instead of taking the whole app down.
  let bsp: ReturnType<typeof parseBsp>;
  try {
    bsp = parseBsp(buffer);
  } catch (error) {
    console.warn(`[map] ${url} is not a usable BSP: ${String(error)}`);
    return null;
  }

  const wads = await loadWads(bsp, name);
  // Cheap look-tuning knobs, handy while comparing against the original game:
  //   ?lm=2.5&lmi=2   GoldSrc lightgamma + overbright
  const query = typeof window !== 'undefined' ? window.location?.search ?? '' : '';
  const tuning = new URLSearchParams(query);
  const lightGamma = Number(tuning.get('lm'));
  const lightOverbright = Number(tuning.get('lmi'));
  const meshes = buildBspMeshes(bsp, {
    wadTextures: wads.textures,
    ...(Number.isFinite(lightGamma) && lightGamma > 0 ? { lightGamma } : {}),
    ...(Number.isFinite(lightOverbright) && lightOverbright > 0
      ? { lightOverbright }
      : {}),
  });
  const collision = new BspCollisionWorld(bsp);
  const rawSpawns = spawnsFromBsp(bsp);
  const spawns = rawSpawns.map((spawn) => ({
    ...spawn,
    origin: resolveSpawn(collision, spawn.origin),
  }));
  const stats = bspStats(bsp);

  const wadNote =
    wads.loaded.length > 0
      ? `WAD ${wads.loaded.join('+')} 解析出 ${meshes.resolvedFromWad.length} 张外部贴图`
      : '未找到 WAD（外部贴图用占位贴图代替）';
  const note =
    `BSP ${name}.bsp · ${stats.faces} 面 / ${stats.textures} 贴图 / ${stats.nodes} 节点 · ` +
    `${meshes.externalTextures.length} 张外部贴图未解析 · ${wadNote} · ` +
    `跳过天空/工具面 ${meshes.skippedFaces}`;

  const chosen = spawns.length > 0 ? pickSpawn(collision, spawns) : null;
  const orderedSpawns = chosen
    ? [chosen, ...spawns.filter((spawn) => spawn !== chosen)]
    : buildWhiteHouse().spawns;

  const world = bsp.models[0]!;
  const map: MapData = {
    name: `BSP: ${name}`,
    bounds: {
      mins: v3(world.mins.x, world.mins.y, world.mins.z),
      maxs: v3(world.maxs.x, world.maxs.y, world.maxs.z),
    },
    boxes: [],
    collision,
    spawns: orderedSpawns,
    skyColor: 0x86a8c8,
    fogColor: 0xa8bccd,
    bsp: bsp,
  };

  const skyName =
    bsp.entityList.find((entity) => entity.classname.toLowerCase() === 'worldspawn')?.properties[
      'skyname'
    ] ?? '';

  return {
    map,
    object: meshes.group,
    source: 'bsp',
    note,
    skyName,
    stats: {
      ...stats,
      meshes: meshes.group.children.length,
      triangles: meshes.triangleCount,
      wadTexturesResolved: meshes.resolvedFromWad.length,
    },
  };
}

/**
 * Loads the requested map, falling back to the built-in box map.
 * `requested` is normally the `?map=` URL parameter.
 */
export async function loadMap(requested?: string | null): Promise<LoadedMap> {
  const candidates: string[] = [];
  if (requested) candidates.push(requested);
  for (const name of DEFAULT_BSP_CHAIN) {
    if (!candidates.includes(name)) candidates.push(name);
  }

  for (const candidate of candidates) {
    const loaded = await loadBspMap(candidate);
    if (loaded) return loaded;
  }

  const map = buildWhiteHouse();
  return {
    map,
    source: 'boxes',
    note: `内置盒子地图（未找到 ${CSTRIKE_ASSET_ROOT}/maps/*.bsp，先跑 pnpm make-bsp 或放入原版地图）`,
  };
}
