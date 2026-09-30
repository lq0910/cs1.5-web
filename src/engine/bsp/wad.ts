/**
 * WAD3 reader (Quake/Half-Life texture archives).
 *
 * CS 1.5 maps keep most of their textures outside the BSP, in `cstrike.wad` and
 * `halflife.wad`. A face whose miptex offset is -1 is resolved by looking its
 * texture name up in these archives, which is exactly what the original engine
 * does at load time.
 *
 * WAD3 layout:
 *   header   : char magic[4] = "WAD3", int32 numlumps, int32 infotableofs
 *   lumpinfo : int32 filepos, int32 disksize, int32 size, uint8 type,
 *              uint8 compression, uint8 pad1, uint8 pad2, char name[16]   (32 B)
 *   type 0x43 ('C') is a miptex.
 */

import { decodeMiptex } from './miptex.ts';
import type { BspMiptex } from './types.ts';

export const WAD3_HEADER_SIZE = 12;
export const WAD3_LUMPINFO_SIZE = 32;
export const WAD3_TYPE_MIPTEX = 0x43;

export interface Wad3File {
  numlumps: number;
  /** Texture name (lower case) -> decoded miptex. */
  textures: Map<string, BspMiptex>;
  /** Names of the lumps that were skipped (not miptex, or compressed). */
  skipped: string[];
}

export class WadParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WadParseError';
  }
}

export function parseWad3(buffer: ArrayBuffer): Wad3File {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < WAD3_HEADER_SIZE) throw new WadParseError('file is too small to be a WAD');

  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  if (magic !== 'WAD3') {
    throw new WadParseError(`unsupported WAD magic "${magic}" (expected WAD3)`);
  }

  const view = new DataView(buffer);
  const numlumps = view.getInt32(4, true);
  const infoTable = view.getInt32(8, true);
  if (numlumps < 0 || infoTable < 0) throw new WadParseError('WAD header is corrupt');
  if (infoTable + numlumps * WAD3_LUMPINFO_SIZE > bytes.length) {
    throw new WadParseError('WAD directory runs past the end of the file');
  }

  const textures = new Map<string, BspMiptex>();
  const skipped: string[] = [];

  for (let i = 0; i < numlumps; i++) {
    const entry = infoTable + i * WAD3_LUMPINFO_SIZE;
    const filepos = view.getInt32(entry, true);
    const diskSize = view.getInt32(entry + 4, true);
    const size = view.getInt32(entry + 8, true);
    const type = bytes[entry + 12]!;
    const compression = bytes[entry + 13]!;

    let name = '';
    for (let c = 0; c < 16 && bytes[entry + 16 + c] !== 0; c++) {
      name += String.fromCharCode(bytes[entry + 16 + c]!);
    }

    if (compression !== 0 || type !== WAD3_TYPE_MIPTEX) {
      skipped.push(name);
      continue;
    }
    if (filepos < 0 || size <= 0 || filepos + size > bytes.length) {
      skipped.push(name);
      continue;
    }

    try {
      const texture = decodeMiptex(bytes, filepos, `wad lump "${name}"`);
      textures.set(texture.name.toLowerCase(), texture);
    } catch {
      // A single bad lump must not take down the whole map.
      skipped.push(name);
    }
    void diskSize;
  }

  return { numlumps, textures, skipped };
}

/**
 * Resolves a texture by name from a set of loaded WADs (later archives win, as
 * in the engine, where the map's own WAD takes precedence).
 */
export function lookupTexture(
  wads: Wad3File[],
  name: string,
): BspMiptex | undefined {
  const key = name.toLowerCase();
  for (const wad of wads) {
    const found = wad.textures.get(key);
    if (found) return found;
  }
  return undefined;
}
