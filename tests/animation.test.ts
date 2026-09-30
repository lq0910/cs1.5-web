/**
 * 功能：使用本地 CS 原版模型校验人物持枪姿态和枪口方向。
 * 时间：2026-09-29；作者：lq。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { parseMdl, findSequence } from '../src/engine/mdl/parser.ts';
import { buildStudio, setStudioPose, studioHandPosition, studioHandLocalPosition, studioMuzzleLocalPosition, studioViewMuzzlePosition } from '../src/engine/render/studio.ts';
import { samplePose } from '../src/engine/mdl/animation.ts';
import { ActorRenderer, placeWeaponAtHand } from '../src/engine/render/actors.ts';
import { createActor } from '../src/game/actors.ts';
import { v3 } from '../src/engine/math.ts';

/** 功能：读取本地 CS 模型并计算 WebGL 网格边界。时间：2026-09-29；作者：lq。 */
function modelBounds(path: string, height?: number, sequence?: string): THREE.Vector3 {
  const mdl = parseMdl(new Uint8Array(readFileSync(`public/cstrike/models/${path}`)));
  return new THREE.Box3().setFromObject(buildStudio(mdl, height, sequence)).getSize(new THREE.Vector3());
}

test('原版人物持枪姿态收起平举的双臂', () => {
  const size = modelBounds('player/urban/urban.mdl', 72, 'ref_aim_carbine');
  assert.ok(size.x > 25 && size.x < 55, `人物宽度异常：${size.x}`);
  assert.ok(Math.abs(size.y - 72) < 0.01);
});

test('原版枪械待机帧沿镜头前方摆放', () => {
  const size = modelBounds('v_ak47.mdl', undefined, 'idle1');
  assert.ok(size.z > size.x * 2, `枪口未指向镜头前方：${size.toArray()}`);
  assert.ok(size.z > 0.3 && size.z < 1);
});

test('原版奔跑帧更新人物网格且不产生无效顶点', () => {
  const mdl = parseMdl(new Uint8Array(readFileSync('public/cstrike/models/player/urban/urban.mdl')));
  const group = buildStudio(mdl, 72, 'ref_aim_carbine');
  const mesh = group.children[0] as THREE.Mesh;
  const before = (mesh.geometry.getAttribute('position') as THREE.BufferAttribute).array.slice();
  setStudioPose(group, 'run', 12);
  const after = (mesh.geometry.getAttribute('position') as THREE.BufferAttribute).array;
  assert.ok(Array.from(after).every(Number.isFinite));
  assert.ok(Array.from(after).some((value, index) => Math.abs(value - before[index]!) > 0.01));
});

// 功能：真实四套匪徒模型在奔跑与瞄准混合时不产生拉长的三角面，防止臀部皮肤撕裂。时间：2026-09-29；作者：lq。
test('匪徒奔跑时皮肤三角面保持原版比例', () => {
  for (const skin of ['terror', 'leet', 'arctic', 'guerilla']) {
    const mdl = parseMdl(new Uint8Array(readFileSync(`public/cstrike/models/player/${skin}/${skin}.mdl`)));
    const group = buildStudio(mdl, 72, 'ref_aim_ak47');
    for (const frame of [0, 9, 18, 27, 36]) {
      setStudioPose(group, 'run', frame, 'ref_aim_ak47');
      let longestEdge = 0;
      group.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const positions = object.geometry.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i + 2 < positions.count; i += 3) {
          const a = new THREE.Vector3().fromBufferAttribute(positions, i);
          for (const offset of [1, 2]) {
            const b = new THREE.Vector3().fromBufferAttribute(positions, i + offset);
            longestEdge = Math.max(longestEdge, a.distanceTo(b) * group.scale.x);
          }
        }
      });
      assert.ok(longestEdge < 18, `${skin} 第 ${frame} 帧皮肤拉伸到 ${longestEdge.toFixed(1)} 单位`);
    }
  }
});

// 功能：验证 CS 原版阵亡序列会从站立姿态跌倒，末帧可作为留在地面的尸体。时间：2026-09-29；作者：lq。
test('原版人物死亡动画会落地并保留终帧', () => {
  const mdl = parseMdl(new Uint8Array(readFileSync('public/cstrike/models/player/urban/urban.mdl')));
  const sequence = findSequence(mdl, 'death1');
  assert.ok(sequence && sequence.numFrames > 10);
  const group = buildStudio(mdl, 72, 'ref_aim_carbine');
  const mesh = group.children[0] as THREE.Mesh;
  setStudioPose(group, 'death1', 0);
  const first = (mesh.geometry.getAttribute('position') as THREE.BufferAttribute).array.slice();
  setStudioPose(group, 'death1', sequence.numFrames - 1);
  const last = (mesh.geometry.getAttribute('position') as THREE.BufferAttribute).array;
  assert.ok(Array.from(last).some((value, index) => Math.abs(value - first[index]!) > 10));
  assert.ok(Array.from(last).every(Number.isFinite));
});

// 功能：验证阵亡角色仍保留在世界场景中，模型加载前也有可见的贴地尸体。时间：2026-09-29；作者：lq。
test('阵亡角色不会从场景中消失', () => {
  // 功能：无头测试直接提供本地模型文件，避免 Node 将浏览器相对路径当成无效 URL。时间：2026-09-29；作者：lq。
  const previousFetch = globalThis.fetch;
  const modelBytes = new Uint8Array(readFileSync('public/cstrike/models/player/urban/urban.mdl'));
  globalThis.fetch = async () => new Response(modelBytes.slice().buffer);
  const scene = new THREE.Scene();
  const renderer = new ActorRenderer(scene);
  const actor = createActor({
    name: 'fallen', team: 'ct', isBot: true, spawn: v3(0, 0, 40), yaw: 0,
    weapons: { 1: 'm4a1', 2: 'usp45', 3: 'knife' },
  });
  actor.alive = false;
  actor.diedAt = 1;
  try {
    renderer.update([actor], null, 1.1);
    const corpse = scene.children.find((object) => object instanceof THREE.Group) as THREE.Group | undefined;
    assert.ok(corpse?.visible);
    assert.ok(corpse.children[0]!.position.y < 0);
  } finally {
    renderer.dispose();
    globalThis.fetch = previousFetch;
  }
});

// 功能：验证第三人称枪械可找到原版骨骼的右手挂点，且跑动时挂点会变化。时间：2026-09-29；作者：lq。
test('第三人称武器随原版右手骨骼移动', () => {
  const mdl = parseMdl(new Uint8Array(readFileSync('public/cstrike/models/player/urban/urban.mdl')));
  const group = buildStudio(mdl, 72, 'ref_aim_carbine');
  const idle = studioHandPosition(group, 'ref_aim_carbine', 0);
  const running = studioHandPosition(group, 'run', 12);
  assert.ok(idle && running);
  assert.ok(idle.toArray().every(Number.isFinite));
  assert.ok(running.toArray().every(Number.isFinite));
  assert.ok(idle.distanceTo(running) > 0.1);
});

/** 功能：防止 AK 瞄准动作一直使用 -90° 首档混合帧，导致人物仰头举枪。时间：2026-09-29；作者：lq。 */
test('AK 九档瞄准动画默认使用水平混合帧', () => {
  const mdl = parseMdl(new Uint8Array(readFileSync('public/cstrike/models/player/urban/urban.mdl')));
  const sequence = findSequence(mdl, 'ref_aim_ak47');
  assert.ok(sequence);
  assert.equal(sequence.numBlends, 9);
  assert.equal(sequence.blendStart, -90);
  assert.equal(sequence.blendEnd, 90);
  const handIndex = mdl.bones.findIndex((bone) => bone.name === 'Bip01 R Hand');
  const lookingUp = samplePose(mdl, sequence, 0, -90)[handIndex]!.position;
  const level = samplePose(mdl, sequence, 0, 0)[handIndex]!.position;
  assert.ok(level.distanceTo(lookingUp) > 5);
});

/** 功能：验证 p_ 枪械保持原始比例，右手挂点能和人物手部准确重合。时间：2026-09-29；作者：lq。 */
test('第三人称 M4A1 按人物比例附着在右手', () => {
  const playerMdl = parseMdl(new Uint8Array(readFileSync('public/cstrike/models/player/urban/urban.mdl')));
  const weaponMdl = parseMdl(new Uint8Array(readFileSync('public/cstrike/models/p_m4a1.mdl')));
  const player = buildStudio(playerMdl, 72, 'ref_aim_carbine');
  const weapon = buildStudio(weaponMdl, undefined, 'idle', player.scale.x);
  const hand = studioHandPosition(player, 'ref_aim_carbine', 0)!;
  const weaponHand = studioHandLocalPosition(weapon, 'idle', 0)!;
  weapon.position.copy(hand).sub(weaponHand.multiplyScalar(weapon.scale.x));
  weapon.updateMatrixWorld(true);
  const attachedHand = weapon.localToWorld(studioHandLocalPosition(weapon, 'idle', 0)!);
  assert.ok(attachedHand.distanceTo(hand) < 0.001);
  const muzzle = weapon.localToWorld(studioMuzzleLocalPosition(weapon)!);
  assert.ok(muzzle.x > hand.x + 20 && muzzle.x < hand.x + 55);
});

// 功能：验证第三人称 p_ 枪械统一把枪口轴转到人物正前方，防止不同队友枪械出现反向。时间：2026-09-30；作者：lq。
test('第三人称 AK 枪口朝向人物正前方', () => {
  const player = buildStudio(parseMdl(new Uint8Array(readFileSync('public/cstrike/models/player/urban/urban.mdl'))), 72, 'ref_aim_ak47');
  const weapon = buildStudio(parseMdl(new Uint8Array(readFileSync('public/cstrike/models/p_ak47.mdl'))), undefined, 'idle', player.scale.x);
  const body = new THREE.Group();
  body.add(player, weapon);
  const hand = studioHandPosition(player, 'ref_aim_ak47', 0)!;
  placeWeaponAtHand(body, weapon, hand);
  weapon.updateMatrixWorld(true);
  const muzzle = weapon.localToWorld(studioMuzzleLocalPosition(weapon)!);
  assert.ok(muzzle.x > hand.x + 20, `枪口没有朝向人物前方：hand=${hand.toArray()} muzzle=${muzzle.toArray()}`);
});

/** 功能：第一人称枪口焰锚点位于原版枪管前端，而不是固定浮在武器前方。时间：2026-09-29；作者：lq。 */
test('第一人称 AK 枪口锚点取自模型网格', () => {
  const mdl = parseMdl(new Uint8Array(readFileSync('public/cstrike/models/v_ak47.mdl')));
  const model = buildStudio(mdl);
  const muzzle = studioViewMuzzlePosition(model)!;
  const bounds = new THREE.Box3().setFromObject(model);
  assert.ok(muzzle.z <= bounds.min.z + 0.001);
  assert.ok(muzzle.z > -0.4);
});

// 功能：确认烟雾弹使用本地 CS 原版 v_ 模型，而不是临时刀状几何占位。时间：2026-09-30；作者：lq。
test('烟雾弹原版模型包含手部与罐体贴图', () => {
  const mdl = parseMdl(new Uint8Array(readFileSync('public/cstrike/models/v_smokegrenade.mdl')));
  assert.ok(mdl.textures.some((texture) => texture.name === 'body.bmp'));
  assert.ok(mdl.textures.some((texture) => texture.name === 'hand.bmp'));
  assert.ok(findSequence(mdl, 'pullpin'));
});
