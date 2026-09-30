/** 功能：无浏览器验证 T 键喷漆距离、冷却、原版贴图透明度和表面方向。时间：2026-09-30；作者：lq。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { v3 } from '../src/engine/math.ts';
import { parseWad3 } from '../src/engine/bsp/wad.ts';
import { SprayRenderer, sprayTexture } from '../src/engine/render/sprays.ts';
import { Match } from '../src/game/match.ts';
import { makeTestRoom } from '../src/game/map/build.ts';

// 功能：模拟玩家远离墙面、贴近墙面、进入冷却和阵亡，确认只有合法喷漆能成功。时间：2026-09-30；作者：lq。
test('spray requires a nearby surface and respects cooldown and player death', () => {
  const match = new Match({ map: makeTestRoom(1024), graph: null, sites: [], teamSize: 1 });
  match.startNow();
  match.mode.phase = 'live';
  const player = match.player!;
  player.move.origin = v3(0, 0, 36);
  player.pitch = 0;
  player.yaw = 0;
  assert.equal(match.trySpray(1), null);
  player.move.origin = v3(450, 0, 36);
  const event = match.trySpray(1)!;
  assert.ok(event);
  assert.ok(Math.abs(event.position.x - 512) < 0.1);
  assert.deepEqual(event.normal, v3(-1, 0, 0));
  assert.equal(match.trySpray(30), null);
  assert.ok(match.trySpray(31));
  player.alive = false;
  assert.equal(match.trySpray(61), null);
  player.alive = true;
  player.move.origin = v3(0, 0, 36);
  player.pitch = 89;
  assert.ok(match.trySpray(61), 'looking down must allow floor spray');
  match.mode.phase = 'over';
  assert.equal(match.trySpray(91), null);
});

// 功能：校验实际分发的原版 Lambda 图案有透明背景和可见笔画，避免喷漆变成实心方块。时间：2026-09-30；作者：lq。
test('original spray archive decodes into visible glyph with transparent background', () => {
  const data = readFileSync(new URL('../public/cstrike/spraypaint.wad', import.meta.url));
  const source = parseWad3(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)).textures.get('lambda')!;
  assert.ok(source && !source.external);
  const texture = sprayTexture(source);
  const pixels = texture.image.data as Uint8Array;
  assert.equal(texture.image.width, 64);
  assert.equal(texture.image.height, 64);
  assert.ok(source.pixels.some((_, i) => pixels[i * 4 + 3] === 0));
  assert.ok(source.pixels.some((_, i) => pixels[i * 4 + 3] === 255));
  assert.equal(texture.flipY, true);
});

// 功能：在 Three.js 场景中验证喷漆池上限、墙面竖直朝向、地面朝向和深度遮挡。时间：2026-09-30；作者：lq。
test('spray meshes face the surface normal and reuse a bounded pool', () => {
  const scene = new THREE.Scene();
  const texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const renderer = new SprayRenderer(scene, texture);
  const visible = () => scene.children.filter((mesh) => mesh.visible) as THREE.Mesh[];
  const normals = [v3(1, 0, 0), v3(-1, 0, 0), v3(0, 1, 0), v3(0, -1, 0), v3(0, 0, 1)];
  for (const normal of normals) {
    renderer.addSpray({ position: v3(0, 0, 0), normal, yaw: 90 });
    const mesh = visible().at(-1)!;
    const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(mesh.quaternion);
    assert.ok(facing.distanceTo(new THREE.Vector3(normal.x, normal.z, -normal.y)) < 1e-6);
    if (normal.z === 0) assert.ok(new THREE.Vector3(0, 1, 0).applyQuaternion(mesh.quaternion).y > 0.99);
    const material = mesh.material as THREE.MeshBasicMaterial;
    assert.equal(material.depthTest, true);
    assert.equal(material.depthWrite, false);
  }
  for (let i = 0; i < 20; i++) renderer.addSpray({ position: v3(i, 0, 0), normal: v3(0, 0, 1), yaw: i * 30 });
  assert.equal(scene.children.length, 16);
  assert.equal(visible().length, 16);
});
