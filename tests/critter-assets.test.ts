/** 功能：用真实 Dust2 和原版小鸡资源验证游走、墙面挂屏及皮肤适配。时间：2026-10-21；作者：lq。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { parseBsp } from '../src/engine/bsp/reader.ts';
import { BspCollisionWorld } from '../src/engine/bsp/collision.ts';
import { buildNavGraph } from '../src/game/nav.ts';
import { placeCritters, updateCritters } from '../src/game/critters.ts';
import { findTSpawnScreenWall } from '../src/engine/render/liveScreen.ts';
import { parseMdl } from '../src/engine/mdl/parser.ts';
import { buildStudio, setStudioPose, disposeStudio } from '../src/engine/render/studio.ts';

// 功能：真实 BSP 上小鸡能够持续移动且脚下始终有地面，避免空房间测试掩盖原图停滞。时间：2026-10-21；作者：lq。
test('original Dust2 supports walking critters and a wall-mounted live screen', () => {
  const bytes = readFileSync('public/cstrike/maps/de_dust2.bsp');
  const bsp = parseBsp(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const world = new BspCollisionWorld(bsp);
  const graph = buildNavGraph(world, bsp.models[0]!);
  let seed = 17;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const birds = placeCritters({ graph, world, spawns: [], random });
  for (let frame = 0; frame < 1800; frame++) {
    updateCritters(birds, world, 1 / 60, frame / 60, random);
    for (const bird of birds) assert.notEqual(world.pointContents({ ...bird.position, z: bird.position.z + 10 }), -2);
  }
  assert.ok(birds.length >= 2);
  assert.ok(birds.every((bird) => (bird.walkDistance ?? 0) > 30), 'every bird must be able to leave its initial point');
  const placement = findTSpawnScreenWall(bsp);
  assert.ok(placement);
  assert.equal(placement.width / placement.height, 16 / 9);
  // 功能：屏幕四角背后均有实体墙，前方为空，避免画面悬空或埋入墙体。时间：2026-10-21；作者：lq。
  for (const x of [-1, 1]) for (const z of [-1, 1]) {
    const p = { x: placement.position.x + x * placement.width / 2, y: placement.position.y + 10, z: placement.position.z + z * placement.height / 2 };
    assert.notEqual(world.pointContents(p), -2);
    const hit = world.traceHull({ mins: { x: 0, y: 0, z: 0 }, maxs: { x: 0, y: 0, z: 0 } }, p, { ...p, y: p.y - 15 });
    assert.ok(hit.fraction < 1 && !hit.startsolid);
  }
});

// 功能：原版调色板皮肤被实际绑定，左右腿的位移会更新顶点且不改变躯干拓扑。时间：2026-10-21；作者：lq。
test('original chick skin and procedural leg animation retain valid geometry', () => {
  const mdl = parseMdl(new Uint8Array(readFileSync('public/cstrike/models/chick.mdl')));
  assert.equal(mdl.textures[0]?.name, 'skin.bmp');
  assert.deepEqual(mdl.sequences.map((sequence) => sequence.label), ['peck']);
  const model = buildStudio(mdl, 22, 'peck');
  const mesh = model.children[0] as THREE.Mesh;
  const before = Array.from(mesh.geometry.getAttribute('position').array);
  assert.ok((mesh.material as THREE.MeshLambertMaterial).map);
  setStudioPose(model, 'peck', 0, undefined, 0, { ltFoot: [0, 2, 1.5], rtFoot: [0, -2, 0] });
  const after = Array.from(mesh.geometry.getAttribute('position').array);
  assert.ok(after.every(Number.isFinite));
  assert.ok(after.some((value, index) => Math.abs(value - before[index]!) > 0.01));
  assert.ok(after.every((value, index) => Math.abs(value - before[index]!) <= 2.01));
  disposeStudio(model);
});
