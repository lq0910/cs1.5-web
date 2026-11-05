/** 功能：验证原版精灵透明度、爆炸阶段及 BSP 单位光照，防止视觉还原回归。时间：2026-11-05；作者：lq。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { parseSprite } from '../src/engine/sprite/parser.ts';
import { explosionStages } from '../src/engine/render/explosions.ts';
import { buildBspMeshes, goldsrcLightByte } from '../src/engine/bsp/geometry.ts';
import { compileBsp } from '../src/engine/bsp/write.ts';
import { parseBsp } from '../src/engine/bsp/reader.ts';
import { makeTestRoom } from '../src/game/map/build.ts';

/** 功能：构建仅含一个两像素帧的合法 IDSP v2，测试不依赖可分发原版素材。时间：2026-11-05；作者：lq。 */
function spriteBytes(format: number): Uint8Array {
  const bytes = new Uint8Array(42 + 256 * 3 + 20 + 2);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x50534449, true);
  view.setInt32(4, 2, true);
  view.setInt32(12, format, true);
  view.setInt32(28, 1, true);
  view.setUint16(40, 256, true);
  bytes.set([120, 80, 40], 42 + 10 * 3);
  bytes.set([210, 220, 230], 42 + 255 * 3);
  const offset = 42 + 256 * 3;
  view.setInt32(offset + 4, -1, true);
  view.setInt32(offset + 8, 1, true);
  view.setInt32(offset + 12, 2, true);
  view.setInt32(offset + 16, 1, true);
  bytes.set([10, 255], offset + 20);
  return bytes;
}

test('IDSP decodes indexed RGB, alpha test and index alpha without shifting the palette', () => {
  assert.deepEqual([...parseSprite(spriteBytes(0)).frames[0]!.rgba], [120, 80, 40, 255, 210, 220, 230, 255]);
  assert.equal(parseSprite(spriteBytes(3)).frames[0]!.rgba[7], 0);
  assert.deepEqual([...parseSprite(spriteBytes(2)).frames[0]!.rgba], [210, 220, 230, 10, 210, 220, 230, 255]);
  assert.throws(() => parseSprite(spriteBytes(0).slice(0, -1)), /Truncated/);
  const invalid = spriteBytes(0);
  new DataView(invalid.buffer).setInt32(42 + 768 + 12, -1, true);
  assert.throws(() => parseSprite(invalid), /dimensions/);
});

test('HE uses two fireballs followed by delayed low-fps smoke; flash has no orange fireball', () => {
  assert.deepEqual(explosionStages('hegrenade').map(s => [s.asset, s.delay, s.fps]), [
    ['fexplo', 0, 30], ['eexplo', 0, 30], ['steam1', 0.55, 5],
  ]);
  assert.ok(explosionStages('flashbang').every(s => s.asset === 'steam1'));
});

test('BSP lightmap cancels the basic shader PI attenuation and keeps shadow contrast', () => {
  const map = makeTestRoom(256, 256);
  const bsp = parseBsp(compileBsp({ boxes: map.boxes, spawns: [] }).buffer);
  const built = buildBspMeshes(bsp);
  const materials: THREE.MeshBasicMaterial[] = [];
  built.group.traverse(object => {
    if (object instanceof THREE.Mesh) materials.push(object.material as THREE.MeshBasicMaterial);
  });
  assert.ok(materials.length > 0);
  for (const material of materials) {
    assert.equal(material.lightMapIntensity, Math.PI);
    assert.equal(material.lightMap?.colorSpace, THREE.SRGBColorSpace);
    assert.equal(material.lightMap?.magFilter, THREE.LinearFilter);
  }
  assert.equal(goldsrcLightByte(0), 0);
  assert.equal(goldsrcLightByte(255), 255);
  assert.ok(goldsrcLightByte(32) > 64);
  assert.ok(goldsrcLightByte(96) < goldsrcLightByte(128));
});
