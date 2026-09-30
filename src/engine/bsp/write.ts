/**
 * Writes a valid GoldSrc BSP v30 file from a box map.
 *
 * Why this exists: the reader and the clipnode collision code must be verified
 * before the user hands over a real map, and the only reliable way to verify a
 * binary format is to produce a file in that format and read it back. It also
 * gives the project a compiler of its own, so hand-authored box maps can ship as
 * real .bsp files.
 *
 * Conventions match Valve's compiler:
 *   - one miptex per material (8-bit palettised, 4 mip levels);
 *   - one quad face per box face with edge/surfedge tables;
 *   - texinfo basis vectors = unit axes, so a texcoord is world units / texture
 *     size (a 64 px texture covers 64 units, the same TILE_UNITS the renderer
 *     uses for hand-built maps);
 *   - per-face lightmap blocks with 16 unit luxels, shaded by a fake sun;
 *   - a proper BSP tree per hull (tree.ts), with the player hulls dilated the
 *     way qbsp does it, so a hull trace is a point trace;
 *   - an entity lump carrying the spawn points.
 *
 * No Three.js or DOM dependency: this runs in Node and in the browser.
 */

import type { Vec3 } from '../math.ts';
import type { BoxDef } from '../collision/brush.ts';
import { FACES } from '../render/boxGeometry.ts';
import type { AxisAlignedBox, PlaneRegistry, TreeResult } from './tree.ts';
import { buildTree, createPlaneRegistry } from './tree.ts';
import { CONTENTS_EMPTY, CONTENTS_SOLID, NUM_LUMPS, STRUCT_SIZE } from './types.ts';

export interface BspSpawn {
  origin: Vec3;
  yaw: number;
  classname: string;
}

export interface BuildBspOptions {
  boxes: BoxDef[];
  spawns: BspSpawn[];
  /** Texture size in pixels (square). GoldSrc maps use 64 or 128. */
  textureSize?: number;
  /**
   * Material names whose texture should be written as *external* (miptex offset
   * -1), i.e. resolved from a WAD at load time — exactly what real CS maps do.
   */
  externalTextures?: string[];
  /** Extra key/values for the worldspawn entity (e.g. "wad", "skyname"). */
  worldspawn?: Record<string, string>;
}

export interface BspBuildReport {
  buffer: ArrayBuffer;
  stats: {
    planes: number;
    nodes: number;
    leaves: number;
    clipnodes: number;
    faces: number;
    textures: number;
    lightingBytes: number;
    entities: number;
    entityBytes: number;
    totalBytes: number;
  };
}

/**
 * Hull dilations, in the BSP's fixed slot order (Quake's, inherited by GoldSrc):
 * 0 = point, 1 = standing 32x32x72, 2 = large 64x64x64, 3 = ducking 32x32x36.
 */
const HULL_EXPANSIONS: [number, number, number][] = [
  [0, 0, 0],
  [16, 16, 36],
  [32, 32, 32],
  [16, 16, 18],
];

const MARGIN = 96;

// --------------------------------------------------------------- textures

const BASE_COLORS: Record<string, [number, number, number]> = {
  stucco: [232, 230, 220],
  concrete: [158, 158, 152],
  sand: [196, 176, 132],
  brick: [150, 84, 66],
  wood: [138, 106, 69],
  metal: [128, 134, 140],
};

function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 6x6x6 RGB cube (216 entries) then 40 greys, so quantisation is a lookup. */
export function buildPalette(): Uint8Array {
  const palette = new Uint8Array(256 * 3);
  const levels = [0, 51, 102, 153, 204, 255];
  let index = 0;
  for (const r of levels) {
    for (const g of levels) {
      for (const b of levels) {
        palette[index * 3] = r;
        palette[index * 3 + 1] = g;
        palette[index * 3 + 2] = b;
        index++;
      }
    }
  }
  for (let i = 0; i < 40; i++) {
    const v = Math.round((i * 255) / 39);
    palette[index * 3] = v;
    palette[index * 3 + 1] = v;
    palette[index * 3 + 2] = v;
    index++;
  }
  return palette;
}

function quantizeCube(r: number, g: number, b: number): number {
  const level = (v: number): number => {
    const clamped = v < 0 ? 0 : v > 255 ? 255 : v;
    return Math.min(5, Math.max(0, Math.round(clamped / 51)));
  };
  return level(r) * 36 + level(g) * 6 + level(b);
}

export interface GeneratedTexture {
  width: number;
  height: number;
  pixels: Uint8Array;
  palette: Uint8Array;
}

/** Deterministic 8-bit texture for a material name. */
export function generateTexture(name: string, size = 64): GeneratedTexture {
  const base = BASE_COLORS[name] ?? [160, 160, 160];
  const rand = mulberry32(hashString(name));
  const pixels = new Uint8Array(size * size);
  const palette = buildPalette();

  const blobs: { x: number; y: number; r: number; shade: number }[] = [];
  for (let i = 0; i < 5; i++) {
    blobs.push({
      x: rand() * size,
      y: rand() * size,
      r: size * (0.08 + rand() * 0.18),
      shade: 0.78 + rand() * 0.3,
    });
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let shade = 0.94 + rand() * 0.12;
      for (const blob of blobs) {
        const dx = x - blob.x;
        const dy = y - blob.y;
        if (dx * dx + dy * dy < blob.r * blob.r) shade *= blob.shade;
      }
      // A visible border on every tile makes UV tiling obvious at a glance.
      if (Math.min(x, y, size - 1 - x, size - 1 - y) < 1) shade *= 0.72;

      pixels[y * size + x] = quantizeCube(base[0]! * shade, base[1]! * shade, base[2]! * shade);
    }
  }

  return { width: size, height: size, pixels, palette };
}

function downsample(pixels: Uint8Array, width: number, height: number, level: number): Uint8Array {
  const w = Math.max(1, width >> level);
  const h = Math.max(1, height >> level);
  const out = new Uint8Array(w * h);
  const step = 1 << level;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out[y * w + x] = pixels[(y * step) * width + x * step]!;
    }
  }
  return out;
}

// --------------------------------------------------------------- byte utils

function i16(value: number): Uint8Array {
  const buffer = new ArrayBuffer(2);
  new DataView(buffer).setInt16(0, value, true);
  return new Uint8Array(buffer);
}

function u16(value: number): Uint8Array {
  const buffer = new ArrayBuffer(2);
  new DataView(buffer).setUint16(0, value, true);
  return new Uint8Array(buffer);
}

function i32(value: number): Uint8Array {
  const buffer = new ArrayBuffer(4);
  new DataView(buffer).setInt32(0, value, true);
  return new Uint8Array(buffer);
}

function f32(value: number): Uint8Array {
  const buffer = new ArrayBuffer(4);
  new DataView(buffer).setFloat32(0, value, true);
  return new Uint8Array(buffer);
}

class Chunks {
  private readonly parts: Uint8Array[] = [];
  length = 0;

  push(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.parts.push(bytes);
    this.length += bytes.length;
  }

  pad4(): void {
    const remainder = this.length % 4;
    if (remainder !== 0) this.push(new Uint8Array(4 - remainder));
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

function cstring(text: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < Math.min(text.length, length - 1); i++) {
    out[i] = text.charCodeAt(i) & 0xff;
  }
  return out;
}

// --------------------------------------------------------------- compiler

interface CompiledFace {
  planenum: number;
  side: number;
  firstedge: number;
  numedges: number;
  texinfo: number;
  styles: [number, number, number, number];
  lightofs: number;
}

interface CompiledTexinfo {
  vecs: [number, number, number, number][];
  miptex: number;
  flags: number;
}

export function compileBsp(options: BuildBspOptions): BspBuildReport {
  const textureSize = options.textureSize ?? 64;
  const boxes = options.boxes.filter(
    (box) =>
      box.solid !== false &&
      box.maxs.x - box.mins.x > 0 &&
      box.maxs.y - box.mins.y > 0 &&
      box.maxs.z - box.mins.z > 0,
  );
  if (boxes.length === 0) throw new Error('compileBsp: no solid boxes to compile');

  const registry: PlaneRegistry = createPlaneRegistry();

  // Materials -> miptex order.
  const materials: string[] = [];
  const materialIndex = new Map<string, number>();
  for (const box of boxes) {
    const name = box.material ?? 'concrete';
    if (!materialIndex.has(name)) {
      materialIndex.set(name, materials.length);
      materials.push(name);
    }
  }
  const textures = materials.map((name) => generateTexture(name, textureSize));

  // ---- faces, edges, texture coordinates, lightmaps
  const positions: Vec3[] = [];
  const edges: { v: [number, number] }[] = [];
  const surfedges: number[] = [];
  const faces: CompiledFace[] = [];
  const texinfoList: CompiledTexinfo[] = [];
  const texinfoIndex = new Map<string, number>();
  const lighting: number[] = [];

  const sun = normalize3([-0.42, 0.36, 0.83]);

  for (const box of boxes) {
    const miptex = materialIndex.get(box.material ?? 'concrete')!;
    // FACES.base works on the [min,max] triple form used by the render geometry.
    const axisBox = {
      min: [box.mins.x, box.mins.y, box.mins.z] as [number, number, number],
      max: [box.maxs.x, box.maxs.y, box.maxs.z] as [number, number, number],
    };

    for (const face of FACES) {
      const base = face.base(axisBox);
      const du = axisBox.max[face.u]! - axisBox.min[face.u]!;
      const dv = axisBox.max[face.v]! - axisBox.min[face.v]!;
      if (du <= 0 || dv <= 0) continue;

      const offsets: [number, number][] = [
        [0, 0],
        [du, 0],
        [du, dv],
        [0, dv],
      ];
      const corners: Vec3[] = offsets.map(([ou, ov]) => {
        const c: [number, number, number] = [base[0], base[1], base[2]];
        c[face.u] += ou;
        c[face.v] += ov;
        return { x: c[0], y: c[1], z: c[2] };
      });

      const normal: [number, number, number] = [
        face.normal[0],
        face.normal[1],
        face.normal[2],
      ];
      const axis = (normal[0] !== 0 ? 0 : normal[1] !== 0 ? 1 : 2) as 0 | 1 | 2;
      const dir = normal[axis]! as 1 | -1;
      // dot(normal, x) <= dist is the box interior.
      const dist = dir === 1 ? axisBox.max[axis]! : -axisBox.min[axis]!;
      const planenum = registry.indexOf({ normal, dist });

      const vecs: [number, number, number, number][] = [
        axisVector(face.u),
        axisVector(face.v),
      ];
      const key = `${miptex}:${face.u}:${face.v}`;
      let texinfo = texinfoIndex.get(key);
      if (texinfo === undefined) {
        texinfo = texinfoList.length;
        texinfoIndex.set(key, texinfo);
        texinfoList.push({ vecs, miptex, flags: 0 });
      }

      // Lightmap block: 16 unit luxels in texture space, capped at 16x16.
      let minU = Infinity;
      let maxU = -Infinity;
      let minV = Infinity;
      let maxV = -Infinity;
      for (const corner of corners) {
        const u = corner.x * vecs[0]![0]! + corner.y * vecs[0]![1]! + corner.z * vecs[0]![2]!;
        const v = corner.x * vecs[1]![0]! + corner.y * vecs[1]![1]! + corner.z * vecs[1]![2]!;
        if (u < minU) minU = u;
        if (u > maxU) maxU = u;
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }
      const blockWidth = Math.min(16, Math.ceil(maxU / 16) - Math.floor(minU / 16) + 1);
      const blockHeight = Math.min(16, Math.ceil(maxV / 16) - Math.floor(minV / 16) + 1);
      const dotSun =
        normal[0]! * sun[0]! + normal[1]! * sun[1]! + normal[2]! * sun[2]!;
      const shade = Math.max(0, Math.min(255, Math.round(96 + 132 * Math.max(0, dotSun))));

      const lightofs = lighting.length;
      const luxels = blockWidth * blockHeight;
      for (let i = 0; i < luxels; i++) lighting.push(shade);

      const firstedge = surfedges.length;
      const baseVertex = positions.length;
      for (let i = 0; i < 4; i++) positions.push(corners[i]!);
      for (let i = 0; i < 4; i++) {
        const next = (i + 1) % 4;
        edges.push({ v: [baseVertex + i, baseVertex + next] });
        surfedges.push(edges.length - 1);
      }

      faces.push({
        planenum,
        side: 0,
        firstedge,
        numedges: 4,
        texinfo,
        styles: [0, 255, 255, 255],
        lightofs,
      });
    }
  }

  // ---- one BSP tree per hull
  const region = mapRegion(boxes, MARGIN);
  const trees: TreeResult[] = HULL_EXPANSIONS.map((expansion) =>
    buildTree(boxes.map(toAxisBox), region, registry, {
      expansion,
      emptyContents: CONTENTS_EMPTY,
      solidContents: CONTENTS_SOLID,
    }),
  );

  const hull0 = trees[0]!;
  const clipStarts = [0, trees[1]!.nodes.length, trees[1]!.nodes.length + trees[2]!.nodes.length];
  const totalClipnodes = clipStarts[2]! + trees[3]!.nodes.length;

  // ---- lump serialisation
  const entityBytes = serializeEntities(options.spawns, options.worldspawn);
  const textureBytes = serializeTextures(materials, textures, new Set(options.externalTextures ?? []));
  const planeBytes = serializePlanes(registry);
  const vertexBytes = serializeVertices(positions);
  const nodeBytes = serializeNodes(hull0);
  const texinfoBytes = serializeTexinfo(texinfoList);
  const faceBytes = serializeFaces(faces);
  const lightingBytes = Uint8Array.from(lighting);
  const clipnodeBytes = serializeClipnodes([trees[1]!, trees[2]!, trees[3]!], clipStarts);
  const leafBytes = serializeLeaves(hull0);
  const edgeBytes = serializeEdges(edges);
  const surfedgeBytes = serializeSurfEdges(surfedges);
  const modelBytes = serializeModel(region, faces.length, [
    hull0.root >= 0 ? hull0.root : 0,
    trees[1]!.nodes.length > 0 ? clipStarts[0]! + Math.max(0, trees[1]!.root) : CONTENTS_EMPTY,
    trees[2]!.nodes.length > 0 ? clipStarts[1]! + Math.max(0, trees[2]!.root) : CONTENTS_EMPTY,
    trees[3]!.nodes.length > 0 ? clipStarts[2]! + Math.max(0, trees[3]!.root) : CONTENTS_EMPTY,
  ]);

  const lumps: Uint8Array[] = [
    entityBytes,
    planeBytes,
    textureBytes,
    vertexBytes,
    new Uint8Array(0), // visibility
    nodeBytes,
    texinfoBytes,
    faceBytes,
    lightingBytes,
    clipnodeBytes,
    leafBytes,
    new Uint8Array(0), // marksurfaces
    edgeBytes,
    surfedgeBytes,
    modelBytes,
  ];

  const chunks = new Chunks();
  const header = new Uint8Array(4 + NUM_LUMPS * 8);
  const headerView = new DataView(header.buffer);
  headerView.setInt32(0, 30, true);
  chunks.push(header);

  lumps.forEach((bytes, index) => {
    chunks.pad4();
    const offset = chunks.length;
    chunks.push(bytes);
    headerView.setInt32(4 + index * 8, offset, true);
    headerView.setInt32(8 + index * 8, bytes.length, true);
  });
  chunks.pad4();

  const bytes = chunks.toBytes();
  bytes.set(header, 0);

  return {
    buffer: bytes.buffer as ArrayBuffer,
    stats: {
      planes: registry.planes.length,
      nodes: hull0.nodes.length,
      leaves: hull0.leaves.length,
      clipnodes: totalClipnodes,
      faces: faces.length,
      textures: materials.length,
      lightingBytes: lighting.length,
      entities: options.spawns.length,
      entityBytes: entityBytes.length,
      totalBytes: bytes.length,
    },
  };
}

function axisVector(axis: 0 | 1 | 2): [number, number, number, number] {
  const vec: [number, number, number, number] = [0, 0, 0, 0];
  vec[axis] = 1;
  return vec;
}

function normalize3(v: [number, number, number]): [number, number, number] {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

function toAxisBox(box: BoxDef): AxisAlignedBox {
  return {
    mins: [box.mins.x, box.mins.y, box.mins.z],
    maxs: [box.maxs.x, box.maxs.y, box.maxs.z],
  };
}

function mapRegion(boxes: BoxDef[], margin: number): AxisAlignedBox {
  const mins: [number, number, number] = [Infinity, Infinity, Infinity];
  const maxs: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const box of boxes) {
    const lo = [box.mins.x, box.mins.y, box.mins.z];
    const hi = [box.maxs.x, box.maxs.y, box.maxs.z];
    for (let axis = 0; axis < 3; axis++) {
      if (lo[axis]! < mins[axis]!) mins[axis] = lo[axis]!;
      if (hi[axis]! > maxs[axis]!) maxs[axis] = hi[axis]!;
    }
  }
  for (let axis = 0; axis < 3; axis++) {
    mins[axis] -= margin;
    maxs[axis] += margin;
  }
  return { mins, maxs };
}

// ---- individual lumps

function serializeEntities(
  spawns: BspSpawn[],
  worldspawn?: Record<string, string>,
): Uint8Array {
  const parts: string[] = [];

  // worldspawn always comes first: it carries the WAD list the loader needs.
  const worldspawnKeys = Object.keys(worldspawn ?? {});
  if (worldspawnKeys.length > 0) {
    const lines = ['{', '"classname" "worldspawn"'];
    for (const key of worldspawnKeys) lines.push(`"${key}" "${worldspawn![key]}"`);
    lines.push('}', '');
    parts.push(lines.join('\n'));
  }

  for (const spawn of spawns) {
    parts.push(
      [
        '{',
        `"classname" "${spawn.classname}"`,
        `"origin" "${spawn.origin.x} ${spawn.origin.y} ${spawn.origin.z}"`,
        `"angle" "${spawn.yaw}"`,
        '}',
        '',
      ].join('\n'),
    );
  }
  const text = `${parts.join('\n')}\0`;
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** One miptex structure: header, four mip levels, palette. */
export function miptexBlob(name: string, texture: GeneratedTexture): Uint8Array {
  {
    const levels = [
      texture.pixels,
      downsample(texture.pixels, texture.width, texture.height, 1),
      downsample(texture.pixels, texture.width, texture.height, 2),
      downsample(texture.pixels, texture.width, texture.height, 3),
    ];

    const header = new Uint8Array(STRUCT_SIZE.miptex);
    header.set(cstring(name, 16), 0);
    const view = new DataView(header.buffer);
    view.setUint32(16, texture.width, true);
    view.setUint32(20, texture.height, true);

    let offset = STRUCT_SIZE.miptex;
    levels.forEach((level, levelIndex) => {
      view.setUint32(24 + levelIndex * 4, offset, true);
      offset += level.length;
    });

    const blob = new Uint8Array(offset + 2 + texture.palette.length);
    blob.set(header, 0);
    let at = STRUCT_SIZE.miptex;
    for (const level of levels) {
      blob.set(level, at);
      at += level.length;
    }
    new DataView(blob.buffer).setUint16(at, 256, true);
    blob.set(texture.palette, at + 2);
    return blob;
  }
}

/**
 * The BSP texture lump: a count, then one offset per texture (-1 = the texture
 * lives in an external WAD), then the miptex blobs.
 */
function serializeTextures(
  materials: string[],
  textures: GeneratedTexture[],
  external: Set<string>,
): Uint8Array {
  const blobs: (Uint8Array | null)[] = materials.map((name, index) =>
    external.has(name) ? miptexHeaderOnly(name, textures[index]!) : miptexBlob(name, textures[index]!),
  );

  const tableSize = 4 + blobs.length * 4;
  const offsets: number[] = [];
  let total = tableSize;
  for (const blob of blobs) {
    if (!blob) {
      offsets.push(-1);
      continue;
    }
    offsets.push(total);
    total += blob.length;
    total += (4 - (total % 4)) % 4;
  }

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setInt32(0, blobs.length, true);
  blobs.forEach((blob, index) => {
    view.setInt32(4 + index * 4, offsets[index]!, true);
    if (blob) out.set(blob, offsets[index]!);
  });
  return out;
}

/** Builds a WAD3 archive; used by tests and by the asset pipeline. */
/**
 * A header-only miptex: the name and size are kept so the loader can look the
 * pixels up in a WAD, but every mip offset is -1 (not in this file).
 */
function miptexHeaderOnly(name: string, texture: GeneratedTexture): Uint8Array {
  const header = new Uint8Array(STRUCT_SIZE.miptex);
  header.set(cstring(name, 16), 0);
  const view = new DataView(header.buffer);
  view.setUint32(16, texture.width, true);
  view.setUint32(20, texture.height, true);
  for (let i = 0; i < 4; i++) view.setInt32(24 + i * 4, -1, true);
  return header;
}

/** Builds a WAD3 archive; used by tests and by the asset pipeline. */
export function buildWad3(entries: { name: string; texture: GeneratedTexture }[]): ArrayBuffer {
  const blobs = entries.map((entry) => miptexBlob(entry.name, entry.texture));

  const headerSize = 12;
  const directorySize = entries.length * 32;
  const positions: number[] = [];
  let total = headerSize + directorySize;
  for (const blob of blobs) {
    positions.push(total);
    total += blob.length;
  }

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set([0x57, 0x41, 0x44, 0x33], 0); // "WAD3"
  view.setInt32(4, entries.length, true);
  view.setInt32(8, headerSize, true);

  entries.forEach((entry, index) => {
    const dir = headerSize + index * 32;
    view.setInt32(dir, positions[index]!, true);
    view.setInt32(dir + 4, blobs[index]!.length, true);
    view.setInt32(dir + 8, blobs[index]!.length, true);
    out[dir + 12] = 0x43; // TYP_MIPTEX
    out[dir + 13] = 0; // no compression
    for (let c = 0; c < 16; c++) {
      out[dir + 16 + c] = c < entry.name.length ? entry.name.charCodeAt(c) & 0xff : 0;
    }
    out.set(blobs[index]!, positions[index]!);
  });

  return out.buffer;
}

function serializePlanes(registry: PlaneRegistry): Uint8Array {
  const chunks = new Chunks();
  for (const plane of registry.planes) {
    chunks.push(f32(plane.normal[0]));
    chunks.push(f32(plane.normal[1]));
    chunks.push(f32(plane.normal[2]));
    chunks.push(f32(plane.dist));
    // type: 0..2 for axis-aligned planes, 3 = any, 4 = any +X ...
    const axis = plane.normal[0] !== 0 ? 0 : plane.normal[1] !== 0 ? 1 : 2;
    chunks.push(i32(plane.normal[axis] === 1 ? axis : 3));
  }
  return chunks.toBytes();
}

function serializeVertices(vertices: Vec3[]): Uint8Array {
  const chunks = new Chunks();
  for (const vertex of vertices) {
    chunks.push(f32(vertex.x));
    chunks.push(f32(vertex.y));
    chunks.push(f32(vertex.z));
  }
  return chunks.toBytes();
}

function serializeEdges(edges: { v: [number, number] }[]): Uint8Array {
  const chunks = new Chunks();
  for (const edge of edges) {
    chunks.push(u16(edge.v[0]));
    chunks.push(u16(edge.v[1]));
  }
  return chunks.toBytes();
}

function serializeSurfEdges(surfedges: number[]): Uint8Array {
  const chunks = new Chunks();
  for (const value of surfedges) chunks.push(i32(value));
  return chunks.toBytes();
}

function serializeFaces(faces: CompiledFace[]): Uint8Array {
  const chunks = new Chunks();
  for (const face of faces) {
    chunks.push(i16(face.planenum));
    chunks.push(i16(face.side));
    chunks.push(i32(face.firstedge));
    chunks.push(i16(face.numedges));
    chunks.push(i16(face.texinfo));
    for (const style of face.styles) chunks.push(new Uint8Array([style]));
    chunks.push(i32(face.lightofs));
  }
  return chunks.toBytes();
}

function serializeTexinfo(list: CompiledTexinfo[]): Uint8Array {
  const chunks = new Chunks();
  for (const info of list) {
    for (const vec of info.vecs) {
      for (const component of vec) chunks.push(f32(component));
    }
    chunks.push(i32(info.miptex));
    chunks.push(i32(info.flags));
  }
  return chunks.toBytes();
}

interface NodeBounds {
  mins: [number, number, number];
  maxs: [number, number, number];
}

/** Union bounds for every node, computed bottom-up (children have lower indices). */
function nodeBounds(tree: TreeResult): NodeBounds[] {
  const bounds: NodeBounds[] = [];

  const boundsOfChild = (child: number): NodeBounds => {
    if (child >= 0) return bounds[child]!;
    const leaf = tree.leaves[-1 - child];
    return leaf ? { mins: leaf.mins, maxs: leaf.maxs } : { mins: [0, 0, 0], maxs: [0, 0, 0] };
  };

  for (let index = 0; index < tree.nodes.length; index++) {
    const node = tree.nodes[index]!;
    const mins: [number, number, number] = [Infinity, Infinity, Infinity];
    const maxs: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const child of node.children) {
      const childBounds = boundsOfChild(child);
      for (let axis = 0; axis < 3; axis++) {
        if (childBounds.mins[axis]! < mins[axis]!) mins[axis] = childBounds.mins[axis]!;
        if (childBounds.maxs[axis]! > maxs[axis]!) maxs[axis] = childBounds.maxs[axis]!;
      }
    }
    for (let axis = 0; axis < 3; axis++) {
      if (!Number.isFinite(mins[axis]!)) mins[axis] = 0;
      if (!Number.isFinite(maxs[axis]!)) maxs[axis] = 0;
    }
    bounds.push({ mins, maxs });
  }
  return bounds;
}

function serializeNodes(tree: TreeResult): Uint8Array {
  const bounds = nodeBounds(tree);
  const chunks = new Chunks();
  tree.nodes.forEach((node, index) => {
    const box = bounds[index]!;
    chunks.push(i32(node.planeIndex));
    chunks.push(i16(node.children[0]));
    chunks.push(i16(node.children[1]));
    for (let axis = 0; axis < 3; axis++) chunks.push(i16(Math.round(box.mins[axis]!)));
    for (let axis = 0; axis < 3; axis++) chunks.push(i16(Math.round(box.maxs[axis]!)));
    chunks.push(u16(0)); // firstface
    chunks.push(u16(0)); // numfaces
  });
  return chunks.toBytes();
}

function serializeLeaves(tree: TreeResult): Uint8Array {
  const chunks = new Chunks();
  for (const leaf of tree.leaves) {
    chunks.push(i32(leaf.contents));
    chunks.push(i32(-1)); // visofs: no visibility data
    for (let axis = 0; axis < 3; axis++) chunks.push(i16(Math.round(leaf.mins[axis]!)));
    for (let axis = 0; axis < 3; axis++) chunks.push(i16(Math.round(leaf.maxs[axis]!)));
    chunks.push(u16(0)); // firstmarksurface
    chunks.push(u16(0)); // nummarksurfaces
    chunks.push(new Uint8Array([0, 0, 0, 0])); // ambient levels
  }
  return chunks.toBytes();
}

/**
 * Clipnodes for hulls 1..3, concatenated. Children that point at a leaf are
 * written as the leaf's *contents* value, which is the convention GoldSrc uses
 * for clipnodes.
 */
function serializeClipnodes(trees: TreeResult[], starts: number[]): Uint8Array {
  const chunks = new Chunks();
  trees.forEach((tree, treeIndex) => {
    const start = starts[treeIndex]!;
    for (const node of tree.nodes) {
      const children: [number, number] = [0, 0];
      for (let side = 0; side < 2; side++) {
        const child = node.children[side]!;
        if (child >= 0) {
          children[side] = start + child;
        } else {
          const leaf = tree.leaves[-1 - child];
          children[side] = leaf ? leaf.contents : CONTENTS_EMPTY;
        }
      }
      chunks.push(i32(node.planeIndex));
      chunks.push(i16(children[0]));
      chunks.push(i16(children[1]));
    }
  });
  return chunks.toBytes();
}

function serializeModel(
  region: AxisAlignedBox,
  numFaces: number,
  headnodes: [number, number, number, number],
): Uint8Array {
  const chunks = new Chunks();
  for (let axis = 0; axis < 3; axis++) chunks.push(f32(region.mins[axis]!));
  for (let axis = 0; axis < 3; axis++) chunks.push(f32(region.maxs[axis]!));
  for (let axis = 0; axis < 3; axis++) chunks.push(f32(0)); // origin
  for (const headnode of headnodes) chunks.push(i32(headnode));
  chunks.push(i32(0)); // visleafs
  chunks.push(i32(0)); // firstface
  chunks.push(i32(numFaces));
  return chunks.toBytes();
}
