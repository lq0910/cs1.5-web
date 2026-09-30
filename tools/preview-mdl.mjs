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
import { parseMdl } from '../src/engine/mdl/parser.ts';

const VIEW_W = 320;
const VIEW_H = 320;

/** Triangle corner layouts we are deciding between. */
const LAYOUTS = {
  // 12 bytes/triangle, per corner: short vertex index, byte s, byte t
  a: (dv, at) => {
    const vert = [];
    const s = [];
    const t = [];
    for (let c = 0; c < 3; c++) {
      const o = at + c * 4;
      vert.push(dv.getInt16(o, true));
      s.push(dv.getUint8(o + 2));
      t.push(dv.getUint8(o + 3));
    }
    return { vert, s, t };
  },
  // 12 bytes/triangle, per corner: short vertex index, byte t, byte s
  b: (dv, at) => {
    const vert = [];
    const s = [];
    const t = [];
    for (let c = 0; c < 3; c++) {
      const o = at + c * 4;
      vert.push(dv.getInt16(o, true));
      t.push(dv.getUint8(o + 2));
      s.push(dv.getUint8(o + 3));
    }
    return { vert, s, t };
  },
  // 24 bytes/triangle, per corner: short s, short t, short vertex, short normal
  c: (dv, at) => {
    const vert = [];
    const s = [];
    const t = [];
    for (let c = 0; c < 3; c++) {
      const o = at + c * 8;
      s.push(dv.getInt16(o, true));
      t.push(dv.getInt16(o + 2, true));
      vert.push(dv.getInt16(o + 4, true));
    }
    return { vert, s, t };
  },
};

function rotate(q, v) {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}

function renderView(mdl, layoutName, label) {
  const bytes = new Uint8Array(readFileSync(mdl));
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parsed = parseMdl(bytes);

  const model = parsed.bodyParts[0]!.models[0]!;
  // world-space vertices (bind pose)
  const world = model.vertices.map((v, index) => {
    const bone = parsed.bones[model.boneIndices[index] ?? 0] ?? parsed.bones[0]!;
    const r = rotate(bone.worldRotation, v);
    return [r[0] + bone.worldPosition[0], r[1] + bone.worldPosition[1], r[2] + bone.worldPosition[2]];
  });

  // ---- collect triangles with their texture
  const bodyPartOffset = dv.getInt32(208, true);
  const modelIndex = dv.getInt32(bodyPartOffset + 72, true);
  const numMesh = dv.getInt32(modelIndex + 72, true);
  const meshIndex = dv.getInt32(modelIndex + 76, true);
  const numVerts = dv.getInt32(modelIndex + 80, true);
  const numTextures = dv.getInt32(180, true);
  const textureIndex = dv.getInt32(184, true);
  const skinIndex = dv.getInt32(200, true);
  const textureName = (i) => {
    const at = textureIndex + i * 80;
    let name = '';
    for (let k = 0; k < 64 && bytes[at + k]; k++) name += String.fromCharCode(bytes[at + k]);
    return { name, w: dv.getInt32(at + 68, true), h: dv.getInt32(at + 72, true) };
  };

  const triangles = [];
  for (let m = 0; m < numMesh; m++) {
    const at = meshIndex + m * 20;
    const numtris = dv.getInt32(at, true);
    const triindex = dv.getInt32(at + 4, true);
    const skinref = dv.getInt32(at + 8, true);
    const skin = dv.getInt16(skinIndex + skinref * 2, true);
    const tex = skin >= 0 && skin < numTextures ? parsed.textures[skin] : null;
    for (let k = 0; k < numtris; k++) {
      const { vert, s, t } = LAYOUTS[layoutName](dv, triindex + k * (layoutName === 'c' ? 24 : 12));
      if (vert.some((v) => v < 0 || v >= numVerts)) continue;
      triangles.push({ vert, s, t, tex });
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
  const project = (v) => [
    VIEW_W / 2 + (v[ax] - (min[ax] + max[ax]) / 2) * scale,
    VIEW_H / 2 - (v[ay] - (min[ay] + max[ay]) / 2) * scale,
    v[az],
  ];

  const colour = new Uint8Array(VIEW_W * VIEW_H * 3).fill(24);
  const depth = new Float32Array(VIEW_W * VIEW_H).fill(-Infinity);

  for (const tri of triangles) {
    const p = tri.vert.map((i) => project(world[i]));
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

        let r = 200;
        let g = 200;
        let b = 200;
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
const [, , modelPath, outPath, mode = 'aut'] = process.argv;
const chosen = mode === 'aut' ? ['a', 'b', 'c'] : [mode];
const views = chosen.map((name) => renderView(modelPath, name, name.toUpperCase()));
const W = VIEW_W * views.length;
const H = VIEW_H;
const header = Buffer.from(`P6\n${W} ${H}\n255\n`, 'ascii');
const pixels = Buffer.alloc(W * H * 3);
for (let v = 0; v < views.length; v++) {
  for (let y = 0; y < VIEW_H; y++) {
    for (let x = 0; x < VIEW_W; x++) {
      const src = (y * VIEW_W + x) * 3;
      const dst = (y * W + v * VIEW_W + x) * 3;
      pixels[dst] = views[v].colour[src];
      pixels[dst + 1] = views[v].colour[src + 1];
      pixels[dst + 2] = views[v].colour[src + 2];
    }
  }
}
writeFileSync(outPath, Buffer.concat([header, pixels]));
console.log(
  `${modelPath} → ${outPath}: ` + views.map((v) => `布局${v.label} ${v.triangles} 三角`).join(' | '),
);
