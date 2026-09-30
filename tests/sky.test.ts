/**
 * Skybox tests.
 *
 * The risky part of the skybox path is the TGA decoder (channel order, row
 * origin, RLE) — the canvas step after it is a standard browser API. These tests
 * decode the *real* install files from public/cstrike/gfx/env, so a regression
 * that turns the sky black is caught without a browser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { decodeTga, skyGradient } from '../src/engine/bsp/sky.ts';

const ENV_DIR = 'public/cstrike/gfx/env';

function average(data: Uint8Array, stride = 4): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i + 3 < data.length; i += stride) {
    sum += data[i]! + data[i + 1]! + data[i + 2]!;
    count += 3;
  }
  return count > 0 ? sum / count : 0;
}

test('the skybox decoder turns real install files into visible pixels', () => {
  assert.ok(existsSync(ENV_DIR), `missing skybox folder ${ENV_DIR}`);
  const files = readdirSync(ENV_DIR).filter((name) => name.endsWith('.tga'));
  assert.ok(files.length > 0, 'no skybox files were copied into public/');

  // Check the desert sky used by de_dust2, plus one more for variety.
  for (const candidate of ['desrt.tga', 'desbk.tga', files[0]!]) {
    const path = join(ENV_DIR, candidate);
    if (!existsSync(path)) continue;
    const bytes = new Uint8Array(readFileSync(path));
    const decoded = decodeTga(bytes);

    assert.ok(decoded.width > 0 && decoded.height > 0, `${candidate}: bad size`);
    assert.equal(
      decoded.rgba.length,
      decoded.width * decoded.height * 4,
      `${candidate}: RGBA buffer has the wrong length`,
    );
    assert.equal(decoded.width, decoded.height, `${candidate}: skybox faces are square`);

    const brightness = average(decoded.rgba);
    assert.ok(brightness > 1, `${candidate}: decoded to an all-black image (avg ${brightness})`);

    // A real sky is not a single flat colour: check that some pixels differ.
    let distinct = false;
    for (let i = 0; i + 7 < Math.min(decoded.rgba.length, 4000); i += 4) {
      if (
        decoded.rgba[i] !== decoded.rgba[0] ||
        decoded.rgba[i + 1] !== decoded.rgba[1] ||
        decoded.rgba[i + 2] !== decoded.rgba[2]
      ) {
        distinct = true;
        break;
      }
    }
    assert.ok(distinct, `${candidate}: decoded to one flat colour`);
  }
});

/** TGA header: idLength, cmap, type, cmap spec, origin, width, height, bpp, flags. */
function tgaHeader(width: number, height: number, bpp: number, imageType: number, flags = 0): Uint8Array {
  const header = new Uint8Array(18);
  header[2] = imageType;
  header[12] = width & 0xff;
  header[13] = (width >> 8) & 0xff;
  header[14] = height & 0xff;
  header[15] = (height >> 8) & 0xff;
  header[16] = bpp;
  header[17] = flags;
  return header;
}

test('the TGA decoder handles the formats GoldSrc actually ships', () => {
  // Uncompressed 24-bit, top-left origin.
  const uncompressed = new Uint8Array(18 + 6);
  uncompressed.set(tgaHeader(2, 1, 24, 2), 0);
  uncompressed.set([3, 2, 1, 6, 5, 4], 18); // stored BGR
  const decoded = decodeTga(uncompressed);
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 1);
  // BGR must be swapped into RGBA.
  assert.deepEqual([...decoded.rgba], [1, 2, 3, 255, 4, 5, 6, 255]);

  // 32-bit with a real alpha channel.
  const withAlpha = new Uint8Array(18 + 8);
  withAlpha.set(tgaHeader(2, 1, 32, 2), 0);
  withAlpha.set([9, 8, 7, 200, 30, 20, 10, 99], 18);
  assert.deepEqual([...decodeTga(withAlpha).rgba], [7, 8, 9, 200, 10, 20, 30, 99]);

  // RLE compressed true colour: one raw packet, then a run of two.
  const rle = new Uint8Array(18 + 1 + 3 + 1 + 3);
  rle.set(tgaHeader(3, 1, 24, 10), 0);
  let offset = 18;
  rle[offset++] = 0x00; // raw packet of one pixel
  rle.set([3, 2, 1], offset);
  offset += 3;
  rle[offset++] = 0x81; // run of two pixels
  rle.set([6, 5, 4], offset);
  assert.deepEqual([...decodeTga(rle).rgba], [1, 2, 3, 255, 4, 5, 6, 255, 4, 5, 6, 255]);

  // Bottom-left origin (flag bit 5 clear) must be flipped, not scrambled.
  const bottomUp = new Uint8Array(18 + 6);
  bottomUp.set(tgaHeader(1, 2, 24, 2, 0), 0);
  bottomUp.set([1, 1, 1, 2, 2, 2], 18); // first row on disk is the bottom row
  assert.deepEqual([...decodeTga(bottomUp).rgba], [2, 2, 2, 255, 1, 1, 1, 255]);
});

test('maps without a shipped skybox fall back to a gradient', () => {
  const gradient = skyGradient('no_such_sky');
  assert.ok(Number.isInteger(gradient.top));
  assert.ok(Number.isInteger(gradient.horizon));
  // The top of the sky is darker than the horizon.
  assert.notEqual(gradient.top, gradient.horizon);

  const desert = skyGradient('des');
  assert.notEqual(desert.top, gradient.top, 'different skies should look different');
});
