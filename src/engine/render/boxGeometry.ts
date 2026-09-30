/**
 * Box -> triangle geometry conversion (pure maths, no Three.js).
 *
 * Kept separate from the renderer for two reasons:
 *   1. it is the part most likely to be subtly wrong (inverted faces, swapped
 *      axes, stretched UVs) and this way it can be unit-tested under plain Node;
 *   2. the BSP loader reuses the same coordinate conversion.
 *
 * Coordinate systems:
 *   simulation: GoldSrc, Z-up  (x east, y north, z up)
 *   rendering : Three.js, Y-up
 *   mapping   : (x, y, z) -> (x, z, -y)
 */

import type { Vec3 } from '../math.ts';

export interface GeoBox {
  mins: Vec3;
  maxs: Vec3;
}

/** GoldSrc (Z-up) -> Three.js (Y-up). */
export function toThree(x: number, y: number, z: number): [number, number, number] {
  return [x, z, -y];
}

interface AxisBox {
  min: [number, number, number];
  max: [number, number, number];
}

export interface FaceDef {
  normal: [number, number, number];
  /** Axis indices holding the face's texture axes; (u x v) must equal normal. */
  u: 0 | 1 | 2;
  v: 0 | 1 | 2;
  base: (b: AxisBox) => [number, number, number];
}

/** Face definitions chosen so that (u x v) == normal, giving outward winding. */
export const FACES: FaceDef[] = [
  { normal: [1, 0, 0], u: 1, v: 2, base: (b) => [b.max[0], b.min[1], b.min[2]] },
  { normal: [-1, 0, 0], u: 2, v: 1, base: (b) => [b.min[0], b.min[1], b.min[2]] },
  { normal: [0, 1, 0], u: 2, v: 0, base: (b) => [b.min[0], b.max[1], b.min[2]] },
  { normal: [0, -1, 0], u: 0, v: 2, base: (b) => [b.min[0], b.min[1], b.min[2]] },
  { normal: [0, 0, 1], u: 0, v: 1, base: (b) => [b.min[0], b.min[1], b.max[2]] },
  { normal: [0, 0, -1], u: 1, v: 0, base: (b) => [b.min[0], b.min[1], b.min[2]] },
];

export interface GeometryArrays {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

export function makeGeometryArrays(): GeometryArrays {
  return { positions: [], normals: [], uvs: [], indices: [] };
}

/**
 * Appends box faces to the given arrays.
 *
 * UVs are computed from world coordinates (axis value / tileUnits) rather than
 * per-box 0..1, which is how the GoldSrc map compiler projects textures: two
 * boxes that share a wall plane tile seamlessly.
 */
export function writeBoxGeometry(boxes: GeoBox[], tileUnits: number, out: GeometryArrays): void {
  const { positions, normals, uvs, indices } = out;

  for (const def of boxes) {
    const b: AxisBox = {
      min: [def.mins.x, def.mins.y, def.mins.z],
      max: [def.maxs.x, def.maxs.y, def.maxs.z],
    };

    // Boxes are solids: if any axis has no extent the "box" is a plane and would
    // emit two coincident quads, so skip it entirely.
    if (
      b.max[0] - b.min[0] <= 0 ||
      b.max[1] - b.min[1] <= 0 ||
      b.max[2] - b.min[2] <= 0
    ) {
      continue;
    }

    for (const face of FACES) {
      const base = face.base(b);
      const du = b.max[face.u] - b.min[face.u];
      const dv = b.max[face.v] - b.min[face.v];
      if (du <= 0 || dv <= 0) continue;

      const offsets: [number, number][] = [
        [0, 0],
        [du, 0],
        [du, dv],
        [0, dv],
      ];

      const startIndex = positions.length / 3;
      for (const [ou, ov] of offsets) {
        const c: [number, number, number] = [base[0], base[1], base[2]];
        c[face.u] += ou;
        c[face.v] += ov;

        const [tx, ty, tz] = toThree(c[0], c[1], c[2]);
        positions.push(tx, ty, tz);
        const [nx, ny, nz] = toThree(face.normal[0], face.normal[1], face.normal[2]);
        normals.push(nx, ny, nz);
        uvs.push(c[face.u] / tileUnits, c[face.v] / tileUnits);
      }
      indices.push(startIndex, startIndex + 1, startIndex + 2);
      indices.push(startIndex, startIndex + 2, startIndex + 3);
    }
  }
}

/** Horizontal FOV (CS 1.5 default 90) converted to Three's vertical FOV. */
export function verticalFovForHorizontal(fovHorizontalDeg: number, aspect: number): number {
  const h = (fovHorizontalDeg * Math.PI) / 180;
  const v = 2 * Math.atan(Math.tan(h / 2) / aspect);
  return (v * 180) / Math.PI;
}
