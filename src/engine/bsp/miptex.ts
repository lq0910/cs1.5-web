/**
 * Miptex decoding, shared by the BSP reader and the WAD3 reader.
 *
 * Both formats store the *same* structure: a 16 byte name, width/height, four
 * mip level offsets relative to the start of the structure, the 8-bit palettised
 * pixels, then a 256 entry RGB palette. Keeping one decoder guarantees a texture
 * looks identical whether it came from inside the BSP or from an external WAD.
 */

import type { BspMiptex } from './types.ts';

export const MIPTEX_HEADER_SIZE = 40;

/** Size in bytes of the four mip levels of a width x height texture. */
export function mipLevelSizes(width: number, height: number): [number, number, number, number] {
  return [
    width * height,
    Math.max(1, width >> 1) * Math.max(1, height >> 1),
    Math.max(1, width >> 2) * Math.max(1, height >> 2),
    Math.max(1, width >> 3) * Math.max(1, height >> 3),
  ];
}

function cstring(bytes: Uint8Array, offset: number, maxLength: number): string {
  let end = offset;
  const limit = Math.min(offset + maxLength, bytes.length);
  while (end < limit && bytes[end] !== 0) end++;
  let out = '';
  for (let i = offset; i < end; i++) out += String.fromCharCode(bytes[i]!);
  return out;
}

/**
 * Decodes one miptex structure starting at `base`.
 * Throws when the structure runs past the end of the buffer.
 */
export function decodeMiptex(bytes: Uint8Array, base: number, label = 'miptex'): BspMiptex {
  if (base < 0 || base + MIPTEX_HEADER_SIZE > bytes.length) {
    throw new Error(`${label}: header runs past the end of the file`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const name = cstring(bytes, base, 16);
  const width = view.getUint32(base + 16, true);
  const height = view.getUint32(base + 20, true);
  const mipOffsets: [number, number, number, number] = [
    view.getInt32(base + 24, true),
    view.getInt32(base + 28, true),
    view.getInt32(base + 32, true),
    view.getInt32(base + 36, true),
  ];

  if (width === 0 || height === 0 || width > 4096 || height > 4096) {
    throw new Error(`${label} "${name}": implausible size ${width}x${height}`);
  }

  // The pixels are not in this file when the first mip offset is negative
  // (explicitly external) or zero (header-only entry, as produced by texture
  // stripping tools and used for engine-generated textures such as "clip",
  // "sky", "white" and the "+0~" animated frames). The header — and therefore
  // the name — is still present, which is what makes a WAD lookup possible.
  if (mipOffsets[0] <= 0) {
    return { name, width, height, pixels: new Uint8Array(0), palette: new Uint8Array(0), external: true };
  }

  const sizes = mipLevelSizes(width, height);
  const pixelStart = base + mipOffsets[0];
  const paletteStart = base + mipOffsets[3] + sizes[3];

  // Truncated or partially stripped BSPs are common in the wild (and in CD
  // repacks): treat anything that does not fit as external instead of failing
  // the whole map over one texture.
  if (pixelStart + sizes[0] > bytes.length || paletteStart + 2 > bytes.length) {
    return { name, width, height, pixels: new Uint8Array(0), palette: new Uint8Array(0), external: true };
  }
  const paletteCount = Math.min(view.getUint16(paletteStart, true), 256);
  const paletteBytes = Math.min(paletteCount, 256) * 3;
  const paletteOffset = paletteStart + 2;
  const paletteLength = Math.min(paletteBytes, bytes.length - paletteOffset);

  return {
    name,
    width,
    height,
    pixels: bytes.slice(pixelStart, pixelStart + sizes[0]),
    palette: bytes.slice(paletteOffset, paletteOffset + paletteLength),
    external: false,
  };
}
