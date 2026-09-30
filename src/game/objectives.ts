/**
 * Round objectives extracted from the map.
 *
 * Bomb sites are *brush* entities: they have no "origin" key, only a "model"
 * pointing at one of the BSP's submodels, so their centre has to come from that
 * model's bounding box.
 */

import type { Vec3 } from '../engine/math.ts';
import { v3 } from '../engine/math.ts';
import type { BspFile } from '../engine/bsp/types.ts';

export interface ObjectiveArea {
  name: string;
  center: Vec3;
  mins: Vec3;
  maxs: Vec3;
}

function modelIndexFromEntity(properties: Record<string, string>): number | null {
  const model = properties['model'];
  if (!model || !model.startsWith('*')) return null;
  const index = Number(model.slice(1));
  return Number.isFinite(index) ? index : null;
}

/** Bomb sites (func_bomb_target) with their world-space footprints. */
export function bombSitesFromBsp(bsp: BspFile): ObjectiveArea[] {
  const sites: ObjectiveArea[] = [];

  for (const entity of bsp.entityList) {
    const classname = entity.classname.toLowerCase();
    if (!classname.includes('bomb_target')) continue;

    if (entity.origin) {
      sites.push({
        name: entity.properties['targetname'] || classname,
        center: v3(entity.origin.x, entity.origin.y, entity.origin.z),
        mins: v3(entity.origin.x - 64, entity.origin.y - 64, entity.origin.z - 64),
        maxs: v3(entity.origin.x + 64, entity.origin.y + 64, entity.origin.z + 64),
      });
      continue;
    }

    const modelIndex = modelIndexFromEntity(entity.properties);
    if (modelIndex === null) continue;
    const model = bsp.models[modelIndex];
    if (!model) continue;

    sites.push({
      name: entity.properties['targetname'] || `site${sites.length + 1}`,
      center: v3(
        (model.mins.x + model.maxs.x) / 2,
        (model.mins.y + model.maxs.y) / 2,
        model.mins.z + 24,
      ),
      mins: v3(model.mins.x, model.mins.y, model.mins.z),
      maxs: v3(model.maxs.x, model.maxs.y, model.maxs.z),
    });
  }

  // Give the sites stable A/B names, ordered west to east as players expect.
  sites.sort((a, b) => a.center.x - b.center.x);
  return sites.map((site, index) => ({
    ...site,
    name: index === 0 ? 'A' : index === 1 ? 'B' : String(index + 1),
  }));
}

export function insideArea(area: ObjectiveArea, point: Vec3, margin = 0): boolean {
  return (
    point.x >= area.mins.x - margin &&
    point.x <= area.maxs.x + margin &&
    point.y >= area.mins.y - margin &&
    point.y <= area.maxs.y + margin &&
    point.z >= area.mins.z - margin &&
    point.z <= area.maxs.z + margin
  );
}
