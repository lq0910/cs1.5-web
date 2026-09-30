/**
 * Offline studio-model previewer.
 *
 * Rasterises an `.mdl` to a PPM image in pure JavaScript (no WebGL, no browser),
 * which makes model work testable: geometry, bone assembly and texture mapping
 * can all be checked in a second instead of a multi-minute headless screenshot.
 *
 * Usage: node tools/preview-mdl.mjs <model.mdl> <out.ppm> [layout]
 *   layout: aut | a | b | c   (how the triangle records are interpreted)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { parseMdl } from '../src/engine/mdl/parser.ts';

/** Minimal PNG encoder: no image libraries needed in this sandbox. */
function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // filter: none
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(
      raw,
      y * (width * 3 + 1) + 1,
    );
  }

  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buffer: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const VIEW_W = 320;
const VIEW_H = 320;

/** Triangle corner layouts we are deciding between. */
// Historical candidates, kept for reference while the format was reverse
// engineered; the confirmed layout lives in the parser.
export const LAYOUTS: Record<string, (dv: DataView, at: number) => { vert: number[]; s: number[]; t: number[] }> = {
  // 12 bytes/triangle, per corner: short vertex index, byte s, byte t
  a: (dv: DataView, at: number) => {
    const vert: number[] = [];
    const s: number[] = [];
    const t: number[] = [];
    for (let c = 0; c < 3; c++) {
      const o = at + c * 4;
      vert.push(dv.getInt16(o, true));
      s.push(dv.getUint8(o + 2));
      t.push(dv.getUint8(o + 3));
    }
    return { vert, s, t };
  },
  // 12 bytes/triangle, per corner: short vertex index, byte t, byte s
  b: (dv: DataView, at: number) => {
    const vert = [];
    const s: number[] = [];
    const t: number[] = [];
    for (let c = 0; c < 3; c++) {
      const o = at + c * 4;
      vert.push(dv.getInt16(o, true));
      t.push(dv.getUint8(o + 2));
      s.push(dv.getUint8(o + 3));
    }
    return { vert, s, t };
  },
  // 12 bytes/triangle: short vert[3], byte s[3], byte t[3]
  f: (dv: DataView, at: number) => {
    const vert = [dv.getInt16(at, true), dv.getInt16(at + 2, true), dv.getInt16(at + 4, true)];
    return {
      vert,
      s: [dv.getUint8(at + 6), dv.getUint8(at + 7), dv.getUint8(at + 8)],
      t: [dv.getUint8(at + 9), dv.getUint8(at + 10), dv.getUint8(at + 11)],
    };
  },
  // 12 bytes/triangle: short vert[3], short norm[3] (geometry only)
  g: (dv: DataView, at: number) => ({
    vert: [dv.getInt16(at, true), dv.getInt16(at + 2, true), dv.getInt16(at + 4, true)],
    s: [0, 0, 0],
    t: [0, 0, 0],
  }),
  // 24 bytes/triangle, per corner: short s, short t, short vertex, short normal
  c: (dv: DataView, at: number) => {
    const vert = [];
    const s: number[] = [];
    const t: number[] = [];
    for (let c = 0; c < 3; c++) {
      const o = at + c * 8;
      s.push(dv.getInt16(o, true));
      t.push(dv.getInt16(o + 2, true));
      vert.push(dv.getInt16(o + 4, true));
    }
    return { vert, s, t };
  },
};

function rotate(q: number[], v: number[]) {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}

function renderView(mdl: string, layoutName: string, label: string, vertexMode: 'raw' | 'posed' = 'posed') {
  void vertexMode;
  const bytes = new Uint8Array(readFileSync(mdl));
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parsed = parseMdl(bytes);

  const firstPart = parsed.bodyParts[0];
  if (!firstPart) throw new Error('model has no body parts');
  const model = firstPart.models[0];
  if (!model) throw new Error('body part has no models');
  // world-space vertices (bind pose)
  const world = model.vertices.map((v: number[], index: number) => {
    if (vertexMode === 'raw') return [v[0], v[1], v[2]];
    const bone = parsed.bones[model.boneIndices[index] ?? 0] ?? parsed.bones[0];
    const r = rotate(bone.worldRotation, v);
    return [r[0] + bone.worldPosition[0], r[1] + bone.worldPosition[1], r[2] + bone.worldPosition[2]];
  });

  // ---- collect triangles with their texture
  const bodyPartOffset = dv.getInt32(208, true);
  const modelIndex = dv.getInt32(bodyPartOffset + 72, true);
  void dv.getInt32(modelIndex + 72, true); // numMesh: triangles come from the parser
  const meshIndex = dv.getInt32(modelIndex + 76, true);
  const numVerts = dv.getInt32(modelIndex + 80, true);
  const numTextures = dv.getInt32(180, true);
  const textureIndex = dv.getInt32(184, true);
  void numTextures;
  const skinIndex = dv.getInt32(200, true);
  const _textureName = (i: number) => {
    const at = textureIndex + i * 80;
    let name = '';
    for (let k = 0; k < 64 && bytes[at + k]; k++) name += String.fromCharCode(bytes[at + k]);
    return { name, w: dv.getInt32(at + 68, true), h: dv.getInt32(at + 72, true) };
  };

  const triangles: { vert: number[]; s: number[]; t: number[]; tex: any }[] = [];
  void layoutName;
  void dv;
  void meshIndex;
  void numVerts;
  for (const mesh of model.meshes) {
    const skin = dv.getInt16(skinIndex + mesh.skinRef * 2, true);
    const tex = skin >= 0 && skin < numTextures ? parsed.textures[skin] : null;
    for (const corners of mesh.triangles) {
      triangles.push({
        vert: corners.map((c) => c.vertex),
        s: corners.map((c) => c.s),
        t: corners.map((c) => c.t),
        tex,
      });
    }
  }

  // ---- project: use the two widest axes
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const v of world) for (let a = 0; a < 3; a++) { if (v[a] < min[a]) min[a] = v[a]; if (v[a] > max[a]) max[a] = v[a]; }
  const extent = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const axes = [0, 1, 2].sort((a, b) => extent[b] - extent[a]);
  const [ax, ay, az] = [axes[0], axes[1], axes[2]];
  const scale = Math.min(VIEW_W / Math.max(1e-3, extent[ax]), VIEW_H / Math.max(1e-3, extent[ay])) * 0.85;
  const project = (v: number[]) => [
    VIEW_W / 2 + (v[ax] - (min[ax] + max[ax]) / 2) * scale,
    VIEW_H / 2 - (v[ay] - (min[ay] + max[ay]) / 2) * scale,
    v[az],
  ];

  const colour = new Uint8Array(VIEW_W * VIEW_H * 3).fill(24);
  const depth = new Float32Array(VIEW_W * VIEW_H).fill(-Infinity);

  for (const tri of triangles) {
    const p = tri.vert.map((i: number) => project(world[i] ?? [0,0,0]));
    const minX = Math.max(0, Math.floor(Math.min(p[0][0], p[1][0], p[2][0])));
    const maxX = Math.min(VIEW_W - 1, Math.ceil(Math.max(p[0][0], p[1][0], p[2][0])));
    const minY = Math.max(0, Math.floor(Math.min(p[0][1], p[1][1], p[2][1])));
    const maxY = Math.min(VIEW_H - 1, Math.ceil(Math.max(p[0][1], p[1][1], p[2][1])));
    const area = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (p[1][1] - p[0][1]);
    if (Math.abs(area) < 1e-6) continue;

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const w0 = ((p[1][0] - x) * (p[2][1] - y) - (p[2][0] - x) * (p[1][1] - y)) / area;
        const w1 = ((p[2][0] - x) * (p[0][1] - y) - (p[0][0] - x) * (p[2][1] - y)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * p[0][2] + w1 * p[1][2] + w2 * p[2][2];
        const index = y * VIEW_W + x;
        if (z <= depth[index]) continue;
        depth[index] = z;

        let r = 170;
        let g = 170;
        let b = 180;
        if (tri.tex) {
          const u = w0 * tri.s[0] + w1 * tri.s[1] + w2 * tri.s[2];
          const v = w0 * tri.t[0] + w1 * tri.t[1] + w2 * tri.t[2];
          const tx = ((Math.round(u) % tri.tex.width) + tri.tex.width) % tri.tex.width;
          const ty = ((Math.round(v) % tri.tex.height) + tri.tex.height) % tri.tex.height;
          const at = (ty * tri.tex.width + tx) * 4;
          r = tri.tex.rgba[at] ?? 128;
          g = tri.tex.rgba[at + 1] ?? 128;
          b = tri.tex.rgba[at + 2] ?? 128;
        }
        colour[index * 3] = r;
        colour[index * 3 + 1] = g;
        colour[index * 3 + 2] = b;
      }
    }
  }

  return { colour, label, triangles: triangles.length };
}

// ---- render the requested layouts into one strip
const [, , modelPath, outPath, mode = 'aut', vertexMode = 'posed'] = process.argv;
const chosen = mode === 'aut' ? ['r','p','q'] : [mode];
const views = chosen.map((name) => renderView(modelPath, 'v', name === 'r' ? 'RAW' : name === 'p' ? 'POSE' : 'RAW2', name === 'p' ? 'posed' : 'raw'));
const W = VIEW_W * views.length;
const H = VIEW_H;
const pixels = new Uint8Array(W * H * 3);
for (let v = 0; v < views.length; v++) {
  for (let y = 0; y < VIEW_H; y++) {
    for (let x = 0; x < VIEW_W; x++) {
      const src = (y * VIEW_W + x) * 3;
      const dst = (y * W + v * VIEW_W + x) * 3;
      pixels[dst] = views[v]!.colour[src] ?? 0;
      pixels[dst + 1] = views[v]!.colour[src + 1] ?? 0;
      pixels[dst + 2] = views[v]!.colour[src + 2] ?? 0;
    }
  }
}
writeFileSync(outPath, encodePng(W, H, pixels));
console.log(
  `${modelPath} → ${outPath}: ` + views.map((v) => `布局${v.label} ${v.triangles} 三角`).join(' | '),
);
