/**
 * GoldSrc BSP v30 reader.
 *
 * Reads a Counter-Strike 1.5 / Half-Life map file into plain arrays. No Three.js
 * or DOM dependency, so a real .bsp can be parsed and validated in Node tests.
 *
 * Robustness notes:
 *  - every lump is bounds-checked, so a truncated or non-BSP file fails with a
 *    clear message instead of reading garbage;
 *  - miptex entries whose offsets are -1 are kept (name only) and marked as
 *    external: those textures live in an external WAD (cstrike.wad, halflife.wad,
 *    ...) exactly like in the original engine.
 */

import type { Vec3 } from '../math.ts';
import { decodeMiptex } from './miptex.ts';
import { v3 } from '../math.ts';
import {
  BSP_VERSION,
  HEADER_SIZE,
  LUMP,
  NUM_LUMPS,
  STRUCT_SIZE,
  STYLE_NONE,
} from './types.ts';
import type {
  BspClipnode,
  BspEdge,
  BspEntity,
  BspFace,
  BspFile,
  BspLeaf,
  BspMiptex,
  BspModel,
  BspNode,
  BspPlane,
  BspTexinfo,
  LumpEntry,
} from './types.ts';

export class BspParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BspParseError';
  }
}

class Reader {
  readonly view: DataView;
  readonly bytes: Uint8Array;

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
  }

  get length(): number {
    return this.bytes.length;
  }

  require(offset: number, size: number, what: string): void {
    if (offset < 0 || size < 0 || offset + size > this.bytes.length) {
      throw new BspParseError(
        `${what}: needs ${size} bytes at offset ${offset} but the file is ${this.bytes.length} bytes`,
      );
    }
  }

  i32(offset: number): number {
    this.require(offset, 4, 'int32');
    return this.view.getInt32(offset, true);
  }

  u32(offset: number): number {
    this.require(offset, 4, 'uint32');
    return this.view.getUint32(offset, true);
  }

  i16(offset: number): number {
    this.require(offset, 2, 'int16');
    return this.view.getInt16(offset, true);
  }

  u16(offset: number): number {
    this.require(offset, 2, 'uint16');
    return this.view.getUint16(offset, true);
  }

  f32(offset: number): number {
    this.require(offset, 4, 'float32');
    return this.view.getFloat32(offset, true);
  }

  string(offset: number, maxLength: number): string {
    this.require(offset, maxLength, 'string');
    let end = offset;
    const limit = offset + maxLength;
    while (end < limit && this.bytes[end] !== 0) end++;
    let out = '';
    for (let i = offset; i < end; i++) out += String.fromCharCode(this.bytes[i]!);
    return out;
  }

  vec3(offset: number): Vec3 {
    return v3(this.f32(offset), this.f32(offset + 4), this.f32(offset + 8));
  }
}

function lumpEntry(reader: Reader, index: number): LumpEntry {
  const offset = reader.i32(4 + index * 8);
  const length = reader.i32(8 + index * 8);
  if (length > 0) reader.require(offset, length, `lump ${index}`);
  return { offset, length };
}

/** Reads a lump into the listed structures, ignoring any trailing partial entry. */
function readStructs<T>(
  _reader: Reader,
  lump: LumpEntry,
  size: number,
  name: string,
  read: (offset: number) => T,
): T[] {
  if (lump.length <= 0) return [];
  const count = Math.floor(lump.length / size);
  if (count * size !== lump.length) {
    throw new BspParseError(
      `${name} lump is ${lump.length} bytes, which is not a multiple of ${size}`,
    );
  }
  const out: T[] = new Array(count);
  for (let i = 0; i < count; i++) out[i] = read(lump.offset + i * size);
  return out;
}

function readMiptex(reader: Reader, textureLump: LumpEntry, index: number): BspMiptex {
  const offsetsBase = textureLump.offset + 4;
  const textureOffset = reader.i32(offsetsBase + index * 4);
  if (textureOffset === -1) {
    return {
      name: `missing_${index}`,
      width: 0,
      height: 0,
      pixels: new Uint8Array(0),
      palette: new Uint8Array(0),
      external: true,
    };
  }

  return decodeMiptex(reader.bytes, textureLump.offset + textureOffset, 'bsp miptex');
}

/** Parses the entity lump: `{ "key" "value" ... }` blocks. */
export function parseEntityLump(text: string): BspEntity[] {
  const tokens = text.match(/"[^"]*"|\{|\}/g);
  if (!tokens) return [];

  const entities: BspEntity[] = [];
  let properties: Record<string, string> | null = null;
  let pendingKey: string | null = null;

  for (const token of tokens) {
    if (token === '{') {
      properties = {};
      pendingKey = null;
      continue;
    }
    if (token === '}') {
      if (properties) entities.push(makeEntity(properties));
      properties = null;
      pendingKey = null;
      continue;
    }
    const value = token.slice(1, -1);
    if (!properties) continue;
    if (pendingKey === null) {
      pendingKey = value;
    } else {
      properties[pendingKey.toLowerCase()] = value;
      pendingKey = null;
    }
  }

  return entities;
}

function makeEntity(properties: Record<string, string>): BspEntity {
  const originText = properties['origin'];
  let origin: Vec3 | null = null;
  if (originText) {
    const parts = originText.trim().split(/\s+/).map(Number);
    if (parts.length >= 3 && parts.every((n) => Number.isFinite(n))) {
      origin = v3(parts[0]!, parts[1]!, parts[2]!);
    }
  }
  const angle = properties['angle'] !== undefined ? Number(properties['angle']) : 0;
  return {
    classname: properties['classname'] ?? '',
    origin,
    angle: Number.isFinite(angle) ? angle : 0,
    properties,
  };
}

export function parseBsp(buffer: ArrayBuffer): BspFile {
  const reader = new Reader(buffer);

  if (reader.length < HEADER_SIZE) {
    throw new BspParseError(`file is only ${reader.length} bytes; too small to be a BSP`);
  }

  const version = reader.i32(0);
  if (version !== BSP_VERSION) {
    throw new BspParseError(`unsupported BSP version ${version} (expected ${BSP_VERSION})`);
  }

  const lumps: LumpEntry[] = new Array(NUM_LUMPS);
  for (let i = 0; i < NUM_LUMPS; i++) lumps[i] = lumpEntry(reader, i);

  const planes = readStructs<BspPlane>(reader, lumps[LUMP.PLANES]!, STRUCT_SIZE.plane, 'planes', (o) => ({
    normal: reader.vec3(o),
    dist: reader.f32(o + 12),
    type: reader.i32(o + 16),
  }));

  const vertices = readStructs<Vec3>(reader, lumps[LUMP.VERTEXES]!, STRUCT_SIZE.vertex, 'vertexes', (o) =>
    reader.vec3(o),
  );

  const nodes = readStructs<BspNode>(reader, lumps[LUMP.NODES]!, STRUCT_SIZE.node, 'nodes', (o) => ({
    planenum: reader.i32(o),
    children: [reader.i16(o + 4), reader.i16(o + 6)],
    mins: [reader.i16(o + 8), reader.i16(o + 10), reader.i16(o + 12)],
    maxs: [reader.i16(o + 14), reader.i16(o + 16), reader.i16(o + 18)],
    firstface: reader.u16(o + 20),
    numfaces: reader.u16(o + 22),
  }));

  const leaves = readStructs<BspLeaf>(reader, lumps[LUMP.LEAVES]!, STRUCT_SIZE.leaf, 'leaves', (o) => ({
    contents: reader.i32(o),
    visofs: reader.i32(o + 4),
    mins: [reader.i16(o + 8), reader.i16(o + 10), reader.i16(o + 12)],
    maxs: [reader.i16(o + 14), reader.i16(o + 16), reader.i16(o + 18)],
    firstmarksurface: reader.u16(o + 20),
    nummarksurfaces: reader.u16(o + 22),
    ambient: [reader.bytes[o + 24]!, reader.bytes[o + 25]!, reader.bytes[o + 26]!, reader.bytes[o + 27]!],
  }));

  const clipnodes = readStructs<BspClipnode>(
    reader,
    lumps[LUMP.CLIPNODES]!,
    STRUCT_SIZE.clipnode,
    'clipnodes',
    (o) => ({
      planenum: reader.i32(o),
      children: [reader.i16(o + 4), reader.i16(o + 6)],
    }),
  );

  const faces = readStructs<BspFace>(reader, lumps[LUMP.FACES]!, STRUCT_SIZE.face, 'faces', (o) => ({
    planenum: reader.i16(o),
    side: reader.i16(o + 2),
    firstedge: reader.i32(o + 4),
    numedges: reader.i16(o + 8),
    texinfo: reader.i16(o + 10),
    styles: [
      reader.bytes[o + 12]!,
      reader.bytes[o + 13]!,
      reader.bytes[o + 14]!,
      reader.bytes[o + 15]!,
    ],
    lightofs: reader.i32(o + 16),
  }));

  const texinfo = readStructs<BspTexinfo>(reader, lumps[LUMP.TEXINFO]!, STRUCT_SIZE.texinfo, 'texinfo', (o) => ({
    vecs: [
      [reader.f32(o), reader.f32(o + 4), reader.f32(o + 8), reader.f32(o + 12)],
      [reader.f32(o + 16), reader.f32(o + 20), reader.f32(o + 24), reader.f32(o + 28)],
    ],
    miptex: reader.i32(o + 32),
    flags: reader.i32(o + 36),
  }));

  const edges = readStructs<BspEdge>(reader, lumps[LUMP.EDGES]!, STRUCT_SIZE.edge, 'edges', (o) => ({
    v: [reader.u16(o), reader.u16(o + 2)],
  }));

  const surfedges = readStructs<number>(
    reader,
    lumps[LUMP.SURFEDGES]!,
    STRUCT_SIZE.surfedge,
    'surfedges',
    (o) => reader.i32(o),
  );

  const marksurfaces = readStructs<number>(
    reader,
    lumps[LUMP.MARKSURFACES]!,
    STRUCT_SIZE.marksurface,
    'marksurfaces',
    (o) => reader.u16(o),
  );

  const models = readStructs<BspModel>(reader, lumps[LUMP.MODELS]!, STRUCT_SIZE.model, 'models', (o) => ({
    mins: reader.vec3(o),
    maxs: reader.vec3(o + 12),
    origin: reader.vec3(o + 24),
    headnode: [reader.i32(o + 36), reader.i32(o + 40), reader.i32(o + 44), reader.i32(o + 48)],
    visleafs: reader.i32(o + 52),
    firstface: reader.i32(o + 56),
    numfaces: reader.i32(o + 60),
  }));

  // Textures: a count, then an offset (relative to the lump) per texture.
  const textureLump = lumps[LUMP.TEXTURES]!;
  const miptex: BspMiptex[] = [];
  if (textureLump.length >= 4) {
    const count = reader.i32(textureLump.offset);
    if (count > 0 && 4 + count * 4 <= textureLump.length + 4) {
      for (let i = 0; i < count; i++) miptex.push(readMiptex(reader, textureLump, i));
    }
  }

  const lightingLump = lumps[LUMP.LIGHTING]!;
  const lighting =
    lightingLump.length > 0
      ? new Uint8Array(
          reader.bytes.buffer,
          reader.bytes.byteOffset + lightingLump.offset,
          lightingLump.length,
        ).slice()
      : new Uint8Array(0);

  const entityLump = lumps[LUMP.ENTITIES]!;
  const entitiesText =
    entityLump.length > 0 ? reader.string(entityLump.offset, entityLump.length) : '';

  if (models.length === 0) {
    throw new BspParseError('BSP has no models (the world model is always model 0)');
  }

  return {
    version,
    lumps,
    planes,
    nodes,
    leaves,
    clipnodes,
    faces,
    texinfo,
    miptex,
    vertices,
    edges,
    surfedges,
    marksurfaces,
    models,
    lighting,
    entities: entitiesText,
    entityList: parseEntityLump(entitiesText),
  };
}

/** Statistics useful for logging and for the asset pipeline report. */
export function bspStats(bsp: BspFile): Record<string, number | string> {
  let solidLeaves = 0;
  for (const leaf of bsp.leaves) if (leaf.contents === -2) solidLeaves++;
  return {
    version: bsp.version,
    planes: bsp.planes.length,
    nodes: bsp.nodes.length,
    leaves: bsp.leaves.length,
    solidLeaves,
    clipnodes: bsp.clipnodes.length,
    faces: bsp.faces.length,
    textures: bsp.miptex.length,
    vertices: bsp.vertices.length,
    lightingBytes: bsp.lighting.length,
    entities: bsp.entityList.length,
    litFaces: bsp.faces.filter((f) => f.lightofs >= 0 && f.styles[0] !== STYLE_NONE).length,
  };
}
