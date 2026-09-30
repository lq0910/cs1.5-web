/**
 * GoldSrc studio model (`.mdl`, version 10) parser.
 *
 * This is the format the original Counter-Strike 1.5 weapons and players use.
 * Only the parts needed for rendering are decoded:
 *
 *   - the header (verified field by field against the real v_ak47.mdl);
 *   - the skeleton, with bind-pose bone transforms accumulated through the
 *     parent chain — studio vertices are stored in *bone-local* space, so this
 *     accumulation is what puts the model together;
 *   - body parts → models → meshes → vertices/triangles, plus each vertex's
 *     single bone index (v10 has no smooth skin weights: one bone per vertex);
 *   - textures: 8-bit paletted pixels with the 768-byte palette that follows
 *     them, honouring the masked/alpha flags.
 *
 * Skeletal animation (sequences) is parsed for its metadata so the model knows
 * what animations exist; sampling the animation values comes next.
 */

export const STUDIO_VERSION = 10;

/** Texture flags, from the Half-Life SDK (`studio.h`). */
export const STUDIO_NF_FLATSHADE = 0x0001;
export const STUDIO_NF_CHROME = 0x0002;
export const STUDIO_NF_FULLBRIGHT = 0x0004;
export const STUDIO_NF_MASKED = 0x0040;
export const STUDIO_NF_ADDITIVE = 0x0020;

export interface MdlTexture {
  name: string;
  flags: number;
  width: number;
  height: number;
  /** RGBA, row 0 first. Index 255 is transparent for masked textures. */
  rgba: Uint8Array;
  /** True when the palette was found; otherwise the pixels are greyscale. */
  hasPalette: boolean;
}

export interface MdlBone {
  name: string;
  parent: number;
  flags: number;
  /** Bind-pose local translation. */
  value: [number, number, number];
  /** Bind-pose local rotation in radians (Euler, applied X then Y then Z). */
  rotation: [number, number, number];
  scale: [number, number, number, number, number, number];
  /** Bind-pose transform accumulated through the parent chain. */
  worldPosition: [number, number, number];
  worldRotation: [number, number, number, number];
}

/**
 * 功能：表示三角带/三角扇中的一个顶点；原版命令记录顺序为 vertex、normal、s、t。
 * 时间：2026-09-29；作者：lq。
 */
export interface MdlTriangleCorner {
  /** Texel coordinates; divide by the texture size for UV. */
  s: number;
  t: number;
  vertex: number;
  normal: number;
}

export interface MdlMesh {
  numTriangles: number;
  triangleOffset: number;
  skinRef: number;
  numNorms: number;
  normOffset: number;
  triangles: MdlTriangleCorner[][];
}

export interface MdlModel {
  name: string;
  type: number;
  boundingRadius: number;
  meshes: MdlMesh[];
  /** Vertex positions in bone-local space. */
  vertices: [number, number, number][];
  normals: [number, number, number][];
  /** Bone index for each vertex (v10 stores one bone per vertex). */
  boneIndices: number[];
  numVertices: number;
}

export interface MdlBodyPart {
  name: string;
  base: number;
  models: MdlModel[];
}

export interface MdlSequence {
  label: string;
  fps: number;
  flags: number;
  activity: number;
  numFrames: number;
  numBlends: number;
  /** 功能：原版人物瞄准动画的俯仰混合范围。时间：2026-09-29；作者：lq。 */
  blendStart: number;
  blendEnd: number;
  /** Byte offset of the animation data (0 = in this file). */
  animIndex: number;
  seqGroup: number;
}

export interface MdlHitbox {
  bone: number;
  group: number;
  mins: [number, number, number];
  maxs: [number, number, number];
}

export interface Mdl {
  name: string;
  version: number;
  length: number;
  bones: MdlBone[];
  bodyParts: MdlBodyPart[];
  textures: MdlTexture[];
  sequences: MdlSequence[];
  hitboxes: MdlHitbox[];
  /** Flat RGBA pixels of the first skin family (texture order). */
  skinFamilies: number[][];
  totalTriangles: number;
  /** 原始 MDL 数据，供动作帧采样使用。时间：2026-09-29；作者：lq。 */
  bytes: Uint8Array;
}

class Reader {
  readonly bytes: Uint8Array;
  offset: number;

  constructor(bytes: Uint8Array, offset = 0) {
    this.bytes = bytes;
    this.offset = offset;
  }

  int32(at = this.offset): number {
    const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + at, 4).getInt32(0, true);
    return value;
  }

  float32(at = this.offset): number {
    return new DataView(this.bytes.buffer, this.bytes.byteOffset + at, 4).getFloat32(0, true);
  }

  string(at: number, length: number): string {
    let out = '';
    for (let i = 0; i < length; i++) {
      const byte = this.bytes[at + i] ?? 0;
      if (byte === 0) break;
      out += String.fromCharCode(byte);
    }
    return out;
  }
}

function quaternionFromEuler(x: number, y: number, z: number): [number, number, number, number] {
  // Half-Life stores bone rotations as Euler angles in radians and applies them
  // as R = Rz * Ry * Rx (the classic AngleQuaternion from the SDK).
  const sx = Math.sin(x / 2);
  const cx = Math.cos(x / 2);
  const sy = Math.sin(y / 2);
  const cy = Math.cos(y / 2);
  const sz = Math.sin(z / 2);
  const cz = Math.cos(z / 2);

  return [
    sx * cy * cz - cx * sy * sz,
    cx * sy * cz + sx * cy * sz,
    cx * cy * sz - sx * sy * cz,
    cx * cy * cz + sx * sy * sz,
  ];
}

function rotateByQuaternion(
  q: [number, number, number, number],
  v: [number, number, number],
): [number, number, number] {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  // v' = v + 2w(q x v) + 2(q x (q x v))
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

function multiplyQuaternion(
  a: [number, number, number, number],
  b: [number, number, number, number],
): [number, number, number, number] {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/** Decodes one 8-bit paletted studio texture into RGBA. */
function decodeTexture(
  bytes: Uint8Array,
  name: string,
  flags: number,
  width: number,
  height: number,
  pixelIndex: number,
): MdlTexture {
  const rgba = new Uint8Array(width * height * 4);
  const pixels = width * height;
  const paletteAt = pixelIndex + pixels;
  const hasPalette = paletteAt + 768 <= bytes.length;

  for (let i = 0; i < pixels; i++) {
    const index = bytes[pixelIndex + i] ?? 0;
    const target = i * 4;
    if (hasPalette) {
      rgba[target] = bytes[paletteAt + index * 3] ?? 0;
      rgba[target + 1] = bytes[paletteAt + index * 3 + 1] ?? 0;
      rgba[target + 2] = bytes[paletteAt + index * 3 + 2] ?? 0;
    } else {
      rgba[target] = index;
      rgba[target + 1] = index;
      rgba[target + 2] = index;
    }
    // Masked textures use palette index 255 as "see through".
    rgba[target + 3] = (flags & STUDIO_NF_MASKED) !== 0 && index === 255 ? 0 : 255;
  }

  return { name, flags, width, height, rgba, hasPalette };
}

export function parseMdl(bytes: Uint8Array): Mdl {
  const reader = new Reader(bytes);
  const magic = reader.string(0, 4);
  if (magic !== 'IDST') throw new Error(`not a studio model (magic "${magic}")`);

  const version = reader.int32(4);
  if (version !== STUDIO_VERSION) {
    throw new Error(`unsupported studio version ${version} (expected ${STUDIO_VERSION})`);
  }

  const name = reader.string(8, 64);
  const length = reader.int32(72);
  const flags = reader.int32(136);
  const numBones = reader.int32(140);
  const boneIndex = reader.int32(144);
  const numBoneControllers = reader.int32(148);
  const numHitboxes = reader.int32(156);
  const hitboxIndex = reader.int32(160);
  const numSequences = reader.int32(164);
  const sequenceIndex = reader.int32(168);
  const numSeqGroups = reader.int32(172);
  const numTextures = reader.int32(180);
  const textureIndex = reader.int32(184);
  const textureDataIndex = reader.int32(188);
  const numSkinRef = reader.int32(192);
  const numSkinFamilies = reader.int32(196);
  const skinIndex = reader.int32(200);
  const numBodyParts = reader.int32(204);
  const bodyPartIndex = reader.int32(208);

  // ---- skeleton
  const bones: MdlBone[] = [];
  const BONE_SIZE = 112;
  for (let i = 0; i < numBones; i++) {
    const at = boneIndex + i * BONE_SIZE;
    const parent = reader.int32(at + 32);
    const value: [number, number, number] = [
      reader.float32(at + 64),
      reader.float32(at + 68),
      reader.float32(at + 72),
    ];
    // 功能：骨骼控制器占用 40..63，value[6] 从偏移 64 开始；维持原版骨骼姿态。时间：2026-09-29；作者：lq。
    const rotation: [number, number, number] = [
      reader.float32(at + 76),
      reader.float32(at + 80),
      reader.float32(at + 84),
    ];
    // 功能：读取六个动作通道的缩放值，后三个是骨骼旋转采样必需的数据。时间：2026-09-29；作者：lq。
    const scale: [number, number, number, number, number, number] = [
      reader.float32(at + 88),
      reader.float32(at + 92),
      reader.float32(at + 96),
      reader.float32(at + 100),
      reader.float32(at + 104),
      reader.float32(at + 108),
    ];

    bones.push({
      name: reader.string(at, 32),
      parent,
      flags: reader.int32(at + 36),
      value,
      rotation,
      scale,
      worldPosition: [0, 0, 0],
      worldRotation: [0, 0, 0, 1],
    });
  }

  // Bind pose: studio vertices live in bone-local space, so accumulate the
  // parent chain to place the skeleton in model space.
  for (let i = 0; i < bones.length; i++) {
    const bone = bones[i]!;
    const localRotation = quaternionFromEuler(bone.rotation[0], bone.rotation[1], bone.rotation[2]);
    const parent = bone.parent >= 0 && bone.parent < i ? bones[bone.parent]! : null;
    if (parent) {
      const rotated = rotateByQuaternion(parent.worldRotation, bone.value);
      bone.worldPosition = [
        parent.worldPosition[0] + rotated[0],
        parent.worldPosition[1] + rotated[1],
        parent.worldPosition[2] + rotated[2],
      ];
      bone.worldRotation = multiplyQuaternion(parent.worldRotation, localRotation);
    } else {
      bone.worldPosition = [...bone.value];
      bone.worldRotation = localRotation;
    }
  }

  // ---- body parts / models / meshes
  const BODY_PART_SIZE = 76;
  const bodyParts: MdlBodyPart[] = [];
  let totalTriangles = 0;

  for (let b = 0; b < numBodyParts; b++) {
    const at = bodyPartIndex + b * BODY_PART_SIZE;
    const numModels = reader.int32(at + 64);
    const base = reader.int32(at + 68);
    const modelIndex = reader.int32(at + 72);
    const models: MdlModel[] = [];

    for (let m = 0; m < numModels; m++) {
      const modelAt = modelIndex + m * 112;
      const modelName = reader.string(modelAt, 64);
      const type = reader.int32(modelAt + 64);
      const boundingRadius = reader.float32(modelAt + 68);
      const numMesh = reader.int32(modelAt + 72);
      const meshIndex = reader.int32(modelAt + 76);
      const numVertices = reader.int32(modelAt + 80);
      const vertexInfoIndex = reader.int32(modelAt + 84);
      const vertexIndex = reader.int32(modelAt + 88);
      const numNormals = reader.int32(modelAt + 92);
      const normalInfoIndex = reader.int32(modelAt + 96);
      const normalIndex = reader.int32(modelAt + 100);

      const meshes: MdlMesh[] = [];
      for (let mesh = 0; mesh < numMesh; mesh++) {
        const meshAt = meshIndex + mesh * 20;
        const numTriangles = reader.int32(meshAt);
        const triangleOffset = reader.int32(meshAt + 4);
        const skinRef = reader.int32(meshAt + 8);
        const numNorms = reader.int32(meshAt + 12);
        const normOffset = reader.int32(meshAt + 16);

        // 功能：按 GoldSrc 三角带/三角扇命令还原网格，避免人物和枪械面片错连。时间：2026-09-29；作者：lq。
        const triangles: MdlTriangleCorner[][] = [];
        let cursor = triangleOffset;
        let commandCount = 0;
        while (cursor + 2 <= bytes.length && commandCount++ < 100000) {
          const count = new DataView(bytes.buffer, bytes.byteOffset + cursor, 2).getInt16(0, true);
          cursor += 2;
          if (count === 0) break;
          const vertexCount = Math.abs(count);
          if (vertexCount < 3 || cursor + vertexCount * 8 > bytes.length) break;
          const commandVertices: MdlTriangleCorner[] = [];
          for (let c = 0; c < vertexCount; c++) {
            const view = new DataView(bytes.buffer, bytes.byteOffset + cursor, 8);
            commandVertices.push({
              vertex: view.getInt16(0, true),
              normal: view.getInt16(2, true),
              s: view.getInt16(4, true),
              t: view.getInt16(6, true),
            });
            cursor += 8;
          }
          for (let c = 2; c < vertexCount; c++) {
            const corners = count > 0
              ? (c % 2 === 0
                ? [commandVertices[c - 2]!, commandVertices[c - 1]!, commandVertices[c]!]
                : [commandVertices[c - 1]!, commandVertices[c - 2]!, commandVertices[c]!])
              : [commandVertices[0]!, commandVertices[c - 1]!, commandVertices[c]!];
            if (corners.every((corner) => corner.vertex >= 0 && corner.vertex < numVertices &&
              corner.normal >= 0 && corner.normal < numNormals)) triangles.push(corners);
          }
        }

        meshes.push({
          numTriangles,
          triangleOffset,
          skinRef,
          numNorms,
          normOffset,
          triangles,
        });
        totalTriangles += triangles.length;
      }

      // vertices: 3 float32 each; boneIndices: one byte each (numVertices long)
      const vertices: [number, number, number][] = [];
      for (let v = 0; v < numVertices; v++) {
        const vertexAt = vertexIndex + v * 12;
        vertices.push([
          reader.float32(vertexAt),
          reader.float32(vertexAt + 4),
          reader.float32(vertexAt + 8),
        ]);
      }

      const boneIndices: number[] = [];
      for (let v = 0; v < numVertices; v++) boneIndices.push(bytes[vertexInfoIndex + v] ?? 0);

      const normals: [number, number, number][] = [];
      for (let n = 0; n < numNormals; n++) {
        const normalAt = normalIndex + n * 12;
        normals.push([
          reader.float32(normalAt),
          reader.float32(normalAt + 4),
          reader.float32(normalAt + 8),
        ]);
      }
      void normalInfoIndex;

      models.push({
        name: modelName,
        type,
        boundingRadius,
        meshes,
        vertices,
        normals,
        boneIndices,
        numVertices,
      });
    }

    bodyParts.push({ name: reader.string(at, 64), base, models });
  }

  // ---- textures (pixels live in the texture data block, palette follows them)
  const textures: MdlTexture[] = [];
  const TEXTURE_SIZE = 80;
  for (let t = 0; t < numTextures; t++) {
    const at = textureIndex + t * TEXTURE_SIZE;
    const textureName = reader.string(at, 64);
    const textureFlags = reader.int32(at + 64);
    const width = reader.int32(at + 68);
    const height = reader.int32(at + 72);
    const pixelOffset = reader.int32(at + 76);

    // Half-Life model textures are frequently *not* power-of-two (the AK's is
    // 128x92), so the sanity check is about the data fitting in the file rather
    // than about the dimensions being tidy.
    const pixels = width * height;
    const dataFits = pixelOffset >= 0 && pixelOffset + pixels <= bytes.length;
    const sane = width > 0 && height > 0 && width <= 4096 && height <= 4096 && dataFits;
    if (!sane) {
      textures.push({
        name: textureName || `texture${t}`,
        flags: textureFlags,
        width: 1,
        height: 1,
        rgba: new Uint8Array([255, 255, 255, 255]),
        hasPalette: false,
      });
      continue;
    }

    const base = pixelOffset >= 0 ? pixelOffset : textureDataIndex;
    textures.push(
      decodeTexture(bytes, textureName || `texture${t}`, textureFlags, width, height, base),
    );
  }

  // ---- skin families (which texture each skin reference uses)
  const skinFamilies: number[][] = [];
  for (let family = 0; family < numSkinFamilies; family++) {
    const row: number[] = [];
    for (let ref = 0; ref < numSkinRef; ref++) {
      row.push(bytes[skinIndex + (family * numSkinRef + ref) * 2] ?? 0);
    }
    skinFamilies.push(row);
  }

  // ---- sequences (metadata; frame data is decoded by the animation sampler)
  //
  // The 176 byte stride is measured, not guessed: consecutive sequence labels
  // ("idle1" → "reload" → "draw" → "shoot1" → "shoot2") sit exactly 176 bytes
  // apart in the file. `numframes` is confirmed at +56 (idle1 has 17 frames on
  // the AK, 61 on the player model); numblends/animindex live further in and are
  // marked below.
  const SEQUENCE_SIZE = 176;
  const sequences: MdlSequence[] = [];
  for (let s = 0; s < numSequences; s++) {
    const at = sequenceIndex + s * SEQUENCE_SIZE;
    sequences.push({
      label: reader.string(at, 32),
      fps: reader.float32(at + 32),
      flags: reader.int32(at + 36),
      activity: reader.int32(at + 40),
      numFrames: reader.int32(at + 56),
      numBlends: reader.int32(at + 120),
      blendStart: reader.float32(at + 136),
      blendEnd: reader.float32(at + 144),
      animIndex: reader.int32(at + 124),
      seqGroup: reader.int32(at + 156),
    });
  }

  // ---- hitboxes
  const HITBOX_SIZE = 32;
  const hitboxes: MdlHitbox[] = [];
  for (let h = 0; h < numHitboxes; h++) {
    const at = hitboxIndex + h * HITBOX_SIZE;
    hitboxes.push({
      bone: reader.int32(at),
      group: reader.int32(at + 4),
      mins: [reader.float32(at + 8), reader.float32(at + 12), reader.float32(at + 16)],
      maxs: [reader.float32(at + 20), reader.float32(at + 24), reader.float32(at + 28)],
    });
  }

  void flags;
  void numBoneControllers;
  void numSeqGroups;

  return {
    name,
    version,
    length,
    bones,
    bodyParts,
    textures,
    sequences,
    hitboxes,
    skinFamilies,
    totalTriangles,
    bytes,
  };
}

/** Finds a sequence by label (case-insensitive), as the AI needs `idle`/`run`. */
export function findSequence(mdl: Mdl, label: string): MdlSequence | null {
  const wanted = label.toLowerCase();
  for (const sequence of mdl.sequences) {
    if (sequence.label.toLowerCase() === wanted) return sequence;
  }
  for (const sequence of mdl.sequences) {
    if (sequence.label.toLowerCase().includes(wanted)) return sequence;
  }
  return null;
}
