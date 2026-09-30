/**
 * GoldSrc BSP version 30 data structures (the on-disk Half-Life map format that
 * Counter-Strike 1.5 uses).
 *
 * Layout reference (all little-endian, packed):
 *   header : int32 version, then 15 lumps of {int32 offset, int32 length}
 *   lumps  : 0 entities, 1 planes, 2 textures, 3 vertexes, 4 visibility,
 *            5 nodes, 6 texinfo, 7 faces, 8 lighting, 9 clipnodes, 10 leaves,
 *            11 marksurfaces, 12 edges, 13 surfedges, 14 models
 *
 * Every struct in this file is byte-exact; the reader and the writer (used to
 * generate a test map) both validate against these sizes.
 */

import type { Vec3 } from '../math.ts';

export const BSP_VERSION = 30;
export const HEADER_SIZE = 4 + 15 * 8;
export const NUM_LUMPS = 15;

/** Contents values, exactly as GoldSrc defines them. */
export const CONTENTS_EMPTY = -1;
export const CONTENTS_SOLID = -2;
export const CONTENTS_WATER = -3;
export const CONTENTS_SLIME = -4;
export const CONTENTS_LAVA = -5;

export const LUMP = {
  ENTITIES: 0,
  PLANES: 1,
  TEXTURES: 2,
  VERTEXES: 3,
  VISIBILITY: 4,
  NODES: 5,
  TEXINFO: 6,
  FACES: 7,
  LIGHTING: 8,
  CLIPNODES: 9,
  LEAVES: 10,
  MARKSURFACES: 11,
  EDGES: 12,
  SURFEDGES: 13,
  MODELS: 14,
} as const;

export interface LumpEntry {
  offset: number;
  length: number;
}

export interface BspPlane {
  normal: Vec3;
  dist: number;
  type: number;
}

export interface BspNode {
  planenum: number;
  /**
   * children[0] = front, children[1] = back. A negative value encodes a leaf as
   * (-1 - leafIndex), which is the on-disk GoldSrc convention.
   */
  children: [number, number];
  mins: [number, number, number];
  maxs: [number, number, number];
  firstface: number;
  numfaces: number;
}

export interface BspLeaf {
  contents: number;
  visofs: number;
  mins: [number, number, number];
  maxs: [number, number, number];
  firstmarksurface: number;
  nummarksurfaces: number;
  ambient: [number, number, number, number];
}

/** Hulls 1..3 are traced through clipnodes; children < 0 are contents values. */
export interface BspClipnode {
  planenum: number;
  children: [number, number];
}

export interface BspFace {
  planenum: number;
  side: number;
  firstedge: number;
  numedges: number;
  texinfo: number;
  styles: [number, number, number, number];
  /** Offset into the lighting lump, or -1 when the face is unlit. */
  lightofs: number;
}

export interface BspTexinfo {
  /** Two texture-space basis vectors: u = vecs[0], v = vecs[1] (each x,y,z,shift). */
  vecs: [
    [number, number, number, number],
    [number, number, number, number],
  ];
  miptex: number;
  flags: number;
}

export interface BspMiptex {
  name: string;
  width: number;
  height: number;
  /** 8-bit palettised pixels of mip level 0 (width * height bytes). */
  pixels: Uint8Array;
  /** 256 * 3 RGB palette. */
  palette: Uint8Array;
  /** True when the texture lives in an external WAD (offsets == -1). */
  external: boolean;
}

export interface BspEdge {
  v: [number, number];
}

export interface BspModel {
  mins: Vec3;
  maxs: Vec3;
  origin: Vec3;
  /** Root node per hull: 0 = point, 1 = standing, 2 = ducking, 3 = large. */
  headnode: [number, number, number, number];
  visleafs: number;
  firstface: number;
  numfaces: number;
}

export interface BspEntity {
  classname: string;
  origin: Vec3 | null;
  angle: number;
  properties: Record<string, string>;
}

export interface BspFile {
  version: number;
  lumps: LumpEntry[];
  planes: BspPlane[];
  nodes: BspNode[];
  leaves: BspLeaf[];
  clipnodes: BspClipnode[];
  faces: BspFace[];
  texinfo: BspTexinfo[];
  miptex: BspMiptex[];
  vertices: Vec3[];
  edges: BspEdge[];
  surfedges: number[];
  marksurfaces: number[];
  models: BspModel[];
  lighting: Uint8Array;
  entities: string;
  entityList: BspEntity[];
}

/** Byte sizes, used by the writer and asserted by tests. */
export const STRUCT_SIZE = {
  plane: 20,
  node: 24,
  leaf: 28,
  clipnode: 8,
  face: 20,
  texinfo: 40,
  miptex: 40,
  edge: 4,
  surfedge: 4,
  marksurface: 2,
  model: 64,
  vertex: 12,
} as const;

/** GoldSrc face styles value meaning "no more lightmaps". */
export const STYLE_NONE = 255;
