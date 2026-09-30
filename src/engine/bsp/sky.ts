/**
 * GoldSrc skyboxes.
 *
 * A map's `skyname` (e.g. "des" for dust2) names six TGA faces in gfx/env/:
 *   rt/lf = +/-X, ft/bk = +/-Y, up/dn = +/-Z   (GoldSrc is Z-up)
 *
 * Sky *brushes* in the BSP carry a "sky" texture and are never drawn: the engine
 * renders these six faces behind everything instead. That is why rendering sky
 * faces as walls turns whole maps purple.
 *
 * The TGA decoder handles what GoldSrc skyboxes actually use: 24/32-bit
 * true-colour, uncompressed or RLE, either row order.
 */

import * as THREE from 'three';

export interface DecodedTga {
  width: number;
  height: number;
  /** RGBA, top-down row order. */
  rgba: Uint8Array;
}

export function decodeTga(bytes: Uint8Array): DecodedTga {
  if (bytes.length < 18) throw new Error('TGA header is truncated');

  const idLength = bytes[0]!;
  const colorMapType = bytes[1]!;
  const imageType = bytes[2]!;
  const width = bytes[12]! | (bytes[13]! << 8);
  const height = bytes[14]! | (bytes[15]! << 8);
  const depth = bytes[16]!;
  const descriptor = bytes[17]!;

  if (colorMapType !== 0) throw new Error('colour-mapped TGA is not supported');
  if (width === 0 || height === 0) throw new Error('TGA has no pixels');

  const grayscale = imageType === 3 || imageType === 11;
  const rle = imageType === 10 || imageType === 11;
  if (!grayscale && imageType !== 2 && imageType !== 10) {
    throw new Error(`unsupported TGA image type ${imageType}`);
  }

  const bytesPerPixel = depth >> 3;
  if (!grayscale && bytesPerPixel !== 3 && bytesPerPixel !== 4) {
    throw new Error(`unsupported TGA pixel depth ${depth}`);
  }

  const pixelCount = width * height;
  const raw = new Uint8Array(pixelCount * bytesPerPixel);
  let at = 18 + idLength;

  if (!rle) {
    if (at + raw.length > bytes.length) throw new Error('TGA pixel data is truncated');
    raw.set(bytes.subarray(at, at + raw.length));
  } else {
    let written = 0;
    while (written < pixelCount) {
      if (at >= bytes.length) throw new Error('TGA RLE data is truncated');
      const header = bytes[at]!;
      at += 1;
      const count = (header & 0x7f) + 1;
      if (header & 0x80) {
        // Run-length packet: one pixel repeated.
        if (at + bytesPerPixel > bytes.length) throw new Error('TGA RLE packet is truncated');
        for (let i = 0; i < count && written < pixelCount; i++) {
          raw.set(bytes.subarray(at, at + bytesPerPixel), written * bytesPerPixel);
          written++;
        }
        at += bytesPerPixel;
      } else {
        const span = count * bytesPerPixel;
        if (at + span > bytes.length) throw new Error('TGA raw packet is truncated');
        for (let i = 0; i < count && written < pixelCount; i++) {
          raw.set(bytes.subarray(at + i * bytesPerPixel, at + (i + 1) * bytesPerPixel), written * bytesPerPixel);
          written++;
        }
        at += span;
      }
    }
  }

  const rgba = new Uint8Array(pixelCount * 4);
  const topDown = (descriptor & 0x20) !== 0;

  for (let y = 0; y < height; y++) {
    const sourceY = topDown ? y : height - 1 - y;
    for (let x = 0; x < width; x++) {
      const source = (sourceY * width + x) * bytesPerPixel;
      const target = (y * width + x) * 4;
      if (grayscale) {
        const value = raw[source]!;
        rgba[target] = value;
        rgba[target + 1] = value;
        rgba[target + 2] = value;
        rgba[target + 3] = 255;
      } else {
        rgba[target] = raw[source + 2]!; // TGA stores BGR(A)
        rgba[target + 1] = raw[source + 1]!;
        rgba[target + 2] = raw[source]!;
        rgba[target + 3] = bytesPerPixel === 4 ? raw[source + 3]! : 255;
      }
    }
  }

  return { width, height, rgba };
}

/** GoldSrc face suffixes mapped to Three.js cube-map order. */
/**
 * Skybox face order, converted from GoldSrc's axes to three.js's.
 *
 * GoldSrc is Z-up with +X "right" and +Y "back", and the renderer converts a
 * point with `(x, y, z) → (x, z, -y)`. That maps:
 *   rt  (+X) → +X      lf  (-X) → -X
 *   up  (+Z) → +Y      dn  (-Z) → -Y
 *   bk  (+Y) → -Z      ft  (-Y) → +Z
 * three.js wants [+X, -X, +Y, -Y, +Z, -Z], so `ft` comes before `bk` — the pair
 * used to be swapped, which mirrors the sky front-to-back.
 *
 * The up/down faces additionally ship rotated a quarter turn, which the GoldSrc
 * and Source engines undo when they build the cube map; `rotateFace` handles it.
 */
const CUBE_FACES: { suffix: string; label: string; rotate: number }[] = [
  { suffix: 'rt', label: '+X', rotate: 0 },
  { suffix: 'lf', label: '-X', rotate: 0 },
  { suffix: 'up', label: '+Y', rotate: 90 },
  { suffix: 'dn', label: '-Y', rotate: 270 },
  { suffix: 'ft', label: '+Z', rotate: 0 },
  { suffix: 'bk', label: '-Z', rotate: 0 },
];

/** Rotates a decoded face by 0/90/180/270 degrees (clockwise). */
function rotateFace(texture: DecodedTga, degrees: number): DecodedTga {
  if (degrees === 0) return texture;
  const { width, height, rgba } = texture;
  const out = new Uint8Array(rgba.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      let dx = x;
      let dy = y;
      if (degrees === 90) {
        dx = height - 1 - y;
        dy = x;
      } else if (degrees === 270) {
        dx = y;
        dy = width - 1 - x;
      } else {
        dx = width - 1 - x;
        dy = height - 1 - y;
      }
      const dst = (dy * width + dx) * 4;
      out[dst] = rgba[src] ?? 0;
      out[dst + 1] = rgba[src + 1] ?? 0;
      out[dst + 2] = rgba[src + 2] ?? 0;
      out[dst + 3] = rgba[src + 3] ?? 255;
    }
  }
  return { ...texture, rgba: out };
}

function toCanvas(texture: DecodedTga): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = texture.width;
  canvas.height = texture.height;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(texture.width, texture.height);
  image.data.set(texture.rgba);
  ctx.putImageData(image, 0, 0);
  return canvas;
}

export interface SkyboxResult {
  texture: THREE.CubeTexture;
  faces: number;
}

/**
 * Loads a skybox by skyname. Returns null when the install has no such skybox,
 * in which case the caller falls back to a gradient background.
 */
export async function loadSkybox(
  skyName: string,
  baseUrl = 'cstrike/gfx/env/',
): Promise<SkyboxResult | null> {
  if (!skyName) return null;
  const name = skyName.trim().toLowerCase();
  if (!name) return null;

  try {
    const canvases = await Promise.all(
      CUBE_FACES.map(async ({ suffix, rotate }) => {
        const response = await fetch(`${baseUrl}${name}${suffix}.tga`, { cache: 'force-cache' });
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${name}${suffix}.tga`);
        const buffer = await response.arrayBuffer();
        const decoded = decodeTga(new Uint8Array(buffer));
        // 功能：仅在天空盒加载时忽略原版 TGA 全零 Alpha，保持通用 TGA 解码器的透明度语义。时间：2026-09-29；作者：lq。
        for (let pixel = 3; pixel < decoded.rgba.length; pixel += 4) decoded.rgba[pixel] = 255;
        return toCanvas(rotateFace(decoded, rotate));
      }),
    );

    const texture = new THREE.CubeTexture(canvases);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return { texture, faces: canvases.length };
  } catch (error) {
    console.warn(`[sky] falling back to a gradient: ${String(error)}`);
    return null;
  }
}

/** Approximate sky colours per GoldSrc skyname, used when no TGA is available. */
export function skyGradient(skyName: string): { top: number; horizon: number } {
  switch (skyName.trim().toLowerCase()) {
    case 'des':
    case 'desert':
      return { top: 0x5f8fc4, horizon: 0xd8d2b4 };
    case 'morningdew':
      return { top: 0x6fa8d8, horizon: 0xdff0f4 };
    case 'doom1':
      return { top: 0x2b3a4a, horizon: 0x6d7f8c };
    case 'office':
      return { top: 0x7c93a8, horizon: 0xdfe4e6 };
    case 'city1':
      return { top: 0x4a5f78, horizon: 0xb9c4cc };
    case 'green':
      return { top: 0x6f9fd0, horizon: 0xd8e8d0 };
    case 'badlands':
      return { top: 0x6a93c8, horizon: 0xe0d6ba };
    case 'backalley':
      return { top: 0x3f4d5c, horizon: 0x9aa7b0 };
    default:
      return { top: 0x4d7fb3, horizon: 0xd7e6f2 };
  }
}
