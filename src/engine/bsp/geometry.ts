/**
 * Turns a parsed BSP into renderable Three.js geometry.
 *
 * What it reproduces from the original engine:
 *   - 8-bit palettised miptex data expanded through each texture's own palette;
 *   - per-face texture coordinates from the texinfo basis vectors (so a 64 px
 *     texture covers 64 world units by default, but per-face scaling is honoured);
 *   - **baked lightmaps**: GoldSrc stores one byte per 16-unit luxel per face.
 *     The lightmaps are packed into an atlas and used as `lightMap` on a basic
 *     material, so the world is lit entirely by the map's baked lighting — no
 *     dynamic lights, exactly like the original renderer.
 *
 * Faces whose miptex lives in an external WAD (offset -1) get a deterministic
 * procedural fallback until the WAD loader lands.
 */

import * as THREE from 'three';
import type { Vec3 } from '../math.ts';
import { toThree } from './../render/boxGeometry.ts';
import { generateTexture } from './write.ts';
import { CONTENTS_SOLID, STYLE_NONE } from './types.ts';

/**
 * Textures that must never be drawn as walls.
 *
 * GoldSrc's "tool" textures mark volumes rather than surfaces: aaatrigger is a
 * trigger brush, clip/null are invisible collision, sky marks sky brushes (the
 * skybox is drawn instead). Rendering them turns whole maps into purple boxes
 * because the tool textures are garish on purpose.
 */
const TOOL_TEXTURE = /^(sky|clip|aaatrigger|null|origin|trigger|hint|skip|ladder|waterskip|placeholder|fog)/i;

/** Water surfaces are drawn translucent instead of solid. */
const WATER_TEXTURE = /water/i;
import type { BspFile, BspMiptex } from './types.ts';

export interface BspMeshResult {
  group: THREE.Group;
  /** 功能：独立活动门网格与静态场景共享原版贴图/光照 atlas，由实体模拟更新姿态；时间：2026-11-05；作者：lq。 */
  modelGroups: Map<number, THREE.Group>;
  faceCount: number;
  triangleCount: number;
  textureCount: number;
  /** External textures that are still unresolved (no WAD loaded). */
  externalTextures: string[];
  /** External textures that were resolved from a WAD. */
  resolvedFromWad: string[];
  /** Lit faces that did not fit in the atlas (should be 0). */
  unlitFaces: number;
  /** Faces skipped because they carry a tool/sky texture. */
  skippedFaces: number;
  lightmapPixels: number;
}

/** GoldSrc lightmap luxel size in world units. */
const LUXEL = 16;

interface LightmapRect {
  x: number;
  y: number;
  width: number;
  height: number;
  minLuxelU: number;
  minLuxelV: number;
}

/** Dirty-rectangle-ish atlas packer: simple shelf packing. */
class AtlasPacker {
  private readonly width: number;
  private readonly height: number;
  private shelfY = 0;
  private shelfHeight = 0;
  private cursorX = 0;
  private readonly padding = 1;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  place(w: number, h: number): { x: number; y: number } | null {
    const needW = w + this.padding * 2;
    const needH = h + this.padding * 2;
    if (this.cursorX + needW > this.width) {
      this.shelfY += this.shelfHeight;
      this.shelfHeight = 0;
      this.cursorX = 0;
    }
    if (this.shelfY + needH > this.height) return null;
    const x = this.cursorX + this.padding;
    const y = this.shelfY + this.padding;
    this.cursorX += needW;
    this.shelfHeight = Math.max(this.shelfHeight, needH);
    return { x, y };
  }
}

/** 功能：参照 GoldSrc 兼容引擎 BuildGammaTable 的 brightness 暗部拐点，保留黑场和满亮端点。时间：2026-11-05；作者：lq。 */
export function goldsrcLightByte(value: number, overbright = 2): number {
  const input = Math.min(1, Math.max(0, value * overbright / 255));
  const lit = Math.pow(input, 2.5);
  const knee = 0.05; // brightness=1：0.125 - brightness² × 0.075。
  const mapped = lit <= knee ? lit / knee * 0.125 : (lit - knee) / (1 - knee) * 0.875 + 0.125;
  return Math.round(255 * Math.pow(mapped, 1 / 2.2));
}

/** Per-face lightmap block size, as computed by the map compiler. */
function lightmapSize(
  bsp: BspFile,
  faceIndex: number,
): { width: number; height: number; minLuxelU: number; minLuxelV: number } {
  const face = bsp.faces[faceIndex]!;
  const info = bsp.texinfo[face.texinfo]!;
  const count = face.numedges;
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;

  for (let i = 0; i < count; i++) {
    const surfedge = bsp.surfedges[face.firstedge + i]!;
    const edge = bsp.edges[Math.abs(surfedge)]!;
    const vertexIndex = surfedge >= 0 ? edge.v[0] : edge.v[1];
    const vertex = bsp.vertices[vertexIndex]!;
    const u = vertex.x * info.vecs[0][0] + vertex.y * info.vecs[0][1] + vertex.z * info.vecs[0][2] + info.vecs[0][3];
    const v = vertex.x * info.vecs[1][0] + vertex.y * info.vecs[1][1] + vertex.z * info.vecs[1][2] + info.vecs[1][3];
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }

  const minLuxelU = Math.floor(minU / LUXEL);
  const minLuxelV = Math.floor(minV / LUXEL);
  const width = Math.min(16, Math.ceil(maxU / LUXEL) - minLuxelU + 1);
  const height = Math.min(16, Math.ceil(maxV / LUXEL) - minLuxelV + 1);
  return { width: Math.max(1, width), height: Math.max(1, height), minLuxelU, minLuxelV };
}

function miptexToTexture(
  texture: BspMiptex,
  wadTextures?: Map<string, BspMiptex>,
): { texture: THREE.Texture; resolvedFromWad: boolean } {
  // A texture whose offsets are -1 lives in an external WAD: look it up by name.
  let source = texture;
  let resolvedFromWad = false;
  if (texture.external && wadTextures) {
    const found = wadTextures.get((texture.name || '').toLowerCase());
    if (found) {
      source = found;
      resolvedFromWad = true;
    }
  }

  const { width, height, pixels, palette } = source;
  if (source.external || pixels.length < width * height || palette.length < 3) {
    // Stand-in until the matching WAD is available.
    const generated = generateTexture(source.name || 'missing', 64);
    return {
      texture: dataTextureFromPalette(generated.width, generated.height, generated.pixels, generated.palette),
      resolvedFromWad,
    };
  }

  // 功能：GoldSrc 的 { 前缀贴图以调色板索引 255 镂空，恢复 Assault 梯子、铁丝网和栏杆；时间：2026-11-05；作者：lq。
  return { texture: dataTextureFromPalette(width, height, pixels, palette, texture.name.startsWith('{')), resolvedFromWad };
}

function dataTextureFromPalette(
  width: number,
  height: number,
  pixels: Uint8Array,
  palette: Uint8Array,
  // 功能：普通贴图的索引 255 仍是实色，仅对原版镂空贴图启用透明；时间：2026-11-05；作者：lq。
  masked = false,
): THREE.Texture {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const colorIndex = pixels[i] ?? 0;
    const base = colorIndex * 3;
    rgba[i * 4] = palette[base] ?? 200;
    rgba[i * 4 + 1] = palette[base + 1] ?? 200;
    rgba[i * 4 + 2] = palette[base + 2] ?? 200;
    rgba[i * 4 + 3] = masked && colorIndex === 255 ? 0 : 255;
  }

  const texture = new THREE.DataTexture(rgba, width, height, THREE.RGBAFormat);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestMipmapLinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export interface BspMeshOptions {
  /** 功能：按 BSP 子模型拆分活动门，防止门被永久合并在仓库墙面中；时间：2026-11-05；作者：lq。 */
  dynamicModels?: number[];
  /** 功能：仅绘制世界模型及明确可见的实体子模型，隐藏买区/触发器等不可见 brush；时间：2026-11-05；作者：lq。 */
  visibleModels?: number[];
  /** 功能：可选手动 gamma 校准，省略时使用默认亮度表；不等同于引擎 lightgamma。时间：2026-11-05；作者：lq。 */
  lightGamma?: number;
  /** Lightmap multiplier before the gamma table (the Quake lineage uses 2). */
  lightOverbright?: number;
  /** Textures loaded from external WAD3 archives, keyed by lower case name. */
  wadTextures?: Map<string, BspMiptex>;
}

export function buildBspMeshes(bsp: BspFile, options: BspMeshOptions = {}): BspMeshResult {
  const group = new THREE.Group();
  // 功能：为活动子模型建立独立变换组，其余材质仍合并以保持渲染性能；时间：2026-11-05；作者：lq。
  const modelGroups = new Map<number, THREE.Group>();
  const faceModels = new Map<number, number>();
  const visibleModels = new Set(options.visibleModels ?? []);
  // 功能：解析每张面所属的 BSP 子模型，避免把买区、触发器 brush 当作世界几何画出来；时间：2026-11-05；作者：lq。
  for (const [modelIndex, model] of bsp.models.entries()) {
    if (modelIndex === 0) continue;
    for (let face = model.firstface; face < model.firstface + model.numfaces; face++) faceModels.set(face, modelIndex);
  }
  for (const index of options.dynamicModels ?? []) {
    const model = bsp.models[index];
    if (!model) continue;
    const object = new THREE.Group();
    modelGroups.set(index, object); group.add(object);
    visibleModels.add(index);
    for (let face = model.firstface; face < model.firstface + model.numfaces; face++) faceModels.set(face, index);
  }
  const externalTextures: string[] = [];
  const resolvedFromWad: string[] = [];

  const textures = bsp.miptex.map((texture, index) => {
    const result = miptexToTexture(texture, options.wadTextures);
    if (texture.external) {
      (result.resolvedFromWad ? resolvedFromWad : externalTextures).push(texture.name || `#${index}`);
    }
    return result.texture;
  });

  // ---- lightmap atlas
  const rects = new Map<number, LightmapRect>();
  let atlasWidth = 512;
  let atlasHeight = 512;
  const faceSizes = new Map<number, { width: number; height: number; minLuxelU: number; minLuxelV: number }>();

  const litFaces = bsp.faces
    .map((face, index) => ({ face, index }))
    .filter(({ face }) => face.lightofs >= 0 && face.styles[0] !== STYLE_NONE);

  /** Packs every lit face; returns false when the atlas is too small. */
  const packAll = (size: number): boolean => {
    atlasWidth = size;
    atlasHeight = size;
    const packer = new AtlasPacker(size, size);
    rects.clear();
    for (const { index } of litFaces) {
      let rect = faceSizes.get(index);
      if (!rect) {
        rect = lightmapSize(bsp, index);
        faceSizes.set(index, rect);
      }
      const spot = packer.place(rect.width, rect.height);
      if (!spot) return false;
      rects.set(index, { ...spot, ...rect });
    }
    return true;
  };

  // Real maps need more room than the built-in test map: dust2 has ~4000 lit
  // faces and a quarter of a million luxels.
  let packed = false;
  for (const size of [512, 1024, 2048, 4096]) {
    if (packAll(size)) {
      packed = true;
      break;
    }
  }
  if (!packed) {
    console.warn(
      `[bsp] lightmap atlas could not fit ${litFaces.length} faces; ` +
        `${litFaces.length - rects.size} will render unlit`,
    );
  }
  const unlitFaces = litFaces.length - rects.size;

  // Valve's maps store three bytes (RGB) per luxel; the compiler used by this
  // project writes one (grey). Reading a 3-byte stream as 1 byte per luxel shifts
  // by one byte for every luxel, which scrambles the baked lighting into mottled
  // dark patches — that is exactly what real maps looked like before this check.
  const luxelCount = [...faceSizes.values()].reduce((sum, size) => sum + size.width * size.height, 0);
  const bytesPerLuxel = bsp.lighting.length >= luxelCount * 2.5 ? 3 : 1;

  // 功能：真实 RGB BSP 默认使用带 brightness 拐点的光照表，修复室内偏暗；URL lm 保留手动校准。时间：2026-11-05；作者：lq。
  const lightGamma = Math.max(1, options.lightGamma ?? 1);
  const overbright = Math.max(0, options.lightOverbright ?? (bytesPerLuxel === 3 ? 2 : 1));
  const shade = (value: number): number => {
    if (bytesPerLuxel === 3 && options.lightGamma === undefined) return goldsrcLightByte(value, overbright);
    const scaled = Math.min(255, value * overbright);
    return lightGamma === 1 ? Math.round(scaled)
      : Math.max(0, Math.min(255, Math.round(255 * Math.pow((scaled + 0.5) / 255.5, 1 / lightGamma))));
  };

  const lightmapData = new Uint8Array(atlasWidth * atlasHeight * 4).fill(255);
  let lightmapPixels = 0;
  for (const [faceIndex, rect] of rects) {
    const face = bsp.faces[faceIndex]!;
    const { width, height } = rect;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const base = face.lightofs + (y * width + x) * bytesPerLuxel;
        const raw0 = bsp.lighting[base] ?? 0;
        const r = shade(raw0);
        const g2 = bytesPerLuxel === 3 ? shade(bsp.lighting[base + 1] ?? raw0) : r;
        const b = bytesPerLuxel === 3 ? shade(bsp.lighting[base + 2] ?? raw0) : r;
        const target = ((rect.y + y) * atlasWidth + rect.x + x) * 4;
        lightmapData[target] = r;
        lightmapData[target + 1] = g2;
        lightmapData[target + 2] = b;
        lightmapData[target + 3] = 255;
        lightmapPixels++;
      }
    }
  }

  const lightmapTexture = new THREE.DataTexture(lightmapData, atlasWidth, atlasHeight, THREE.RGBAFormat);
  // 功能：原版光照图采用双线性采样，避免暗部出现 luxel 方块。时间：2026-11-05；作者：lq。
  lightmapTexture.magFilter = THREE.LinearFilter;
  lightmapTexture.minFilter = THREE.LinearFilter;
  lightmapTexture.generateMipmaps = false;
  // 功能：贴图和光照均声明 sRGB，由渲染器解码后相乘，输出重新编码，接近 GoldSrc gamma 空间调制。时间：2026-11-05；作者：lq。
  lightmapTexture.colorSpace = THREE.SRGBColorSpace;
  // Three.js picks the UV set from texture.channel (0 -> 'uv', 1 -> 'uv1').
  // The lightmap must sample the second UV channel or it would be sampled with
  // the diffuse texture coordinates.
  lightmapTexture.channel = 1;
  lightmapTexture.needsUpdate = true;

  // ---- geometry, merged per texture
  const perTexture = new Map<string, {
    modelIndex: number;
    textureIndex: number;
    positions: number[];
    normals: number[];
    uvs: number[];
    lightUvs: number[];
    indices: number[];
  }>();

  let triangleCount = 0;
  let faceCount = 0;
  let skippedFaces = 0;

  for (const [faceIndex, face] of bsp.faces.entries()) {
    const modelIndex = faceModels.get(faceIndex) ?? 0;
    if (modelIndex !== 0 && !visibleModels.has(modelIndex)) continue;
    const info = bsp.texinfo[face.texinfo];
    if (!info) continue;
    const plane = bsp.planes[face.planenum];
    if (!plane) continue;

    // Sky brushes and trigger/clip volumes are invisible in the engine.
    const textureName = bsp.miptex[info.miptex]?.name ?? '';
    if (TOOL_TEXTURE.test(textureName)) {
      skippedFaces++;
      continue;
    }

    // Resolve the face's polygon.
    const polygon: Vec3[] = [];
    for (let i = 0; i < face.numedges; i++) {
      const surfedge = bsp.surfedges[face.firstedge + i];
      if (surfedge === undefined) break;
      const edge = bsp.edges[Math.abs(surfedge)];
      if (!edge) break;
      const vertexIndex = surfedge >= 0 ? edge.v[0] : edge.v[1];
      const vertex = bsp.vertices[vertexIndex];
      if (vertex) polygon.push(vertex);
    }
    if (polygon.length < 3) continue;

    // ---- winding
    //
    // GoldSrc stores faces with the winding of *its* renderer, which is the
    // opposite of the counter-clockwise front face three.js (OpenGL) expects:
    // on dust2 about 60% of the faces came out backwards, so the depth buffer
    // and backface culling simply erased the floor and most walls — the map
    // looked like it had holes into a black void.
    //
    // Orientation is derived from the plane the face belongs to: the front side
    // of a GoldSrc face plane is the empty space, so the visible winding must
    // agree with the (side-adjusted) plane normal.
    {
      const sign = face.side === 1 ? -1 : 1;
      const nx = plane.normal.x * sign;
      const ny = plane.normal.y * sign;
      const nz = plane.normal.z * sign;
      // 功能：跳过共线的前三点，使用首个有面积的三角形决定 BSP 面朝向，修复地面透出天空盒。时间：2026-09-29；作者：lq。
      const a = polygon[0]!;
      for (let i = 1; i + 1 < polygon.length; i++) {
        const b = polygon[i]!;
        const c = polygon[i + 1]!;
        const abx = b.x - a.x;
        const aby = b.y - a.y;
        const abz = b.z - a.z;
        const acx = c.x - a.x;
        const acy = c.y - a.y;
        const acz = c.z - a.z;
        const wx = aby * acz - abz * acy;
        const wy = abz * acx - abx * acz;
        const wz = abx * acy - aby * acx;
        const dot = wx * nx + wy * ny + wz * nz;
        if (Math.abs(dot) < 0.00001) continue;
        if (dot < 0) polygon.reverse();
        break;
      }
    }

    const textureIndex = info.miptex;
    const texture = bsp.miptex[textureIndex];
    const texWidth = texture && texture.width > 0 ? texture.width : 64;
    const texHeight = texture && texture.height > 0 ? texture.height : 64;

    // 功能：门和世界即使用同一贴图，也必须保留各自的模型归属及局部顶点；时间：2026-11-05；作者：lq。
    const materialKey = `${modelIndex}:${textureIndex}`;
    let arrays = perTexture.get(materialKey);
    if (!arrays) {
      arrays = { modelIndex, textureIndex, positions: [], normals: [], uvs: [], lightUvs: [], indices: [] };
      perTexture.set(materialKey, arrays);
    }

    const rect = rects.get(faceIndex);
    const size = rect ?? faceSizes.get(faceIndex);
    const base = arrays.positions.length / 3;

    // Surface normal: the face plane, flipped when side == 1.
    const sign = face.side === 1 ? -1 : 1;
    const normalThree = toThree(
      plane.normal.x * sign,
      plane.normal.y * sign,
      plane.normal.z * sign,
    );

    for (const vertex of polygon) {
      const [tx, ty, tz] = toThree(vertex.x, vertex.y, vertex.z);
      arrays.positions.push(tx, ty, tz);
      arrays.normals.push(normalThree[0], normalThree[1], normalThree[2]);

      const u = vertex.x * info.vecs[0][0] + vertex.y * info.vecs[0][1] + vertex.z * info.vecs[0][2] + info.vecs[0][3];
      const v = vertex.x * info.vecs[1][0] + vertex.y * info.vecs[1][1] + vertex.z * info.vecs[1][2] + info.vecs[1][3];
      arrays.uvs.push(u / texWidth, v / texHeight);

      if (rect && size) {
        const luxelU = u / LUXEL - size.minLuxelU;
        const luxelV = v / LUXEL - size.minLuxelV;
        arrays.lightUvs.push(
          (rect.x + 0.5 + luxelU) / atlasWidth,
          (rect.y + 0.5 + luxelV) / atlasHeight,
        );
      } else {
        arrays.lightUvs.push(0, 0);
      }
    }

    // Triangle fan: BSP faces are convex polygons.
    for (let i = 1; i + 1 < polygon.length; i++) {
      arrays.indices.push(base, base + i, base + i + 1);
      triangleCount++;
    }
    faceCount++;
  }

  for (const arrays of perTexture.values()) {
    const { textureIndex, modelIndex } = arrays;
    if (arrays.indices.length === 0) continue;
    const name = bsp.miptex[textureIndex]?.name ?? '';
    const isWater = WATER_TEXTURE.test(name);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(arrays.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(arrays.normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(arrays.uvs, 2));
    // Three.js samples lightMap from the second UV channel, named uv1.
    geometry.setAttribute('uv1', new THREE.Float32BufferAttribute(arrays.lightUvs, 2));
    geometry.setIndex(arrays.indices);
    geometry.computeBoundingSphere();

    const material = new THREE.MeshBasicMaterial({
      map: textures[textureIndex] ?? null,
      lightMap: lightmapTexture,
      // 功能：Three r186 MeshBasic 的 lightMap 自带 RECIPROCAL_PI；乘 π 恢复 GoldSrc 的单位调制，防止整图压暗。时间：2026-11-05；作者：lq。
      lightMapIntensity: Math.PI,
      fog: true,
      transparent: isWater,
      opacity: isWater ? 0.72 : 1,
      depthWrite: !isWater,
      // 功能：使用 Alpha 裁剪显示原版镂空表面，保留深度写入且避免透明排序错误；时间：2026-11-05；作者：lq。
      alphaTest: name.startsWith('{') ? 0.5 : 0,
      // 功能：原版 BSP 存在 T 形接缝及局部反向三角形，双面绘制避免地面/墙面露出天空盒。时间：2026-09-29；作者：lq。
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    (modelGroups.get(modelIndex) ?? group).add(mesh);
  }

  return {
    group,
    modelGroups,
    faceCount,
    triangleCount,
    textureCount: bsp.miptex.length,
    externalTextures,
    resolvedFromWad,
    unlitFaces,
    skippedFaces,
    lightmapPixels,
  };
}

/** Contents of a leaf that a point falls into; handy for spawn validation. */
export function pointIsSolid(bsp: BspFile, point: Vec3): boolean {
  // Cheap approximation used only for diagnostics in the loader.
  return bsp.leaves.some(
    (leaf) =>
      leaf.contents === CONTENTS_SOLID &&
      point.x >= leaf.mins[0] &&
      point.x <= leaf.maxs[0] &&
      point.y >= leaf.mins[1] &&
      point.y <= leaf.maxs[1] &&
      point.z >= leaf.mins[2] &&
      point.z <= leaf.maxs[2],
  );
}
