/**
 * 功能：将本地 CS 1.5 Studio MDL 的原版网格和调色板贴图加载为 Three.js 模型。
 * 时间：2026-09-29；作者：lq。
 */
import * as THREE from 'three';
import { parseMdl, STUDIO_NF_MASKED } from '../mdl/parser.ts';
import type { Mdl } from '../mdl/parser.ts';
import { findSequence } from '../mdl/parser.ts';
import { samplePose } from '../mdl/animation.ts';
import type { BonePose } from '../mdl/animation.ts';

const cache = new Map<string, Promise<Mdl | null>>();
interface AnimatedMesh {
  geometry: THREE.BufferGeometry;
  vertices: [number, number, number][];
  boneIndices: number[];
}
const animated = new WeakMap<THREE.Group, { mdl: Mdl; meshes: AnimatedMesh[]; player: boolean }>();

/** 功能：缓存原版模型请求，避免多个 BOT 重复下载和解析。时间：2026-09-29；作者：lq。 */
export function loadStudio(path: string): Promise<Mdl | null> {
  const existing = cache.get(path);
  if (existing) return existing;
  const result = fetch(`cstrike/models/${path}`)
    .then(async (response) => response.ok ? parseMdl(new Uint8Array(await response.arrayBuffer())) : null)
    .catch((error) => {
      console.warn(`[mdl] ${path}: ${String(error)}`);
      return null;
    });
  cache.set(path, result);
  return result;
}

/** 功能：把骨骼局部顶点变换到绑定姿态；原版纹理和网格在同一坐标系显示。时间：2026-09-29；作者：lq。 */
function transformVertex(pose: BonePose[], vertex: [number, number, number], boneIndex: number): THREE.Vector3 {
  const bone = pose[boneIndex];
  const point = new THREE.Vector3(...vertex);
  if (bone) {
    point.applyQuaternion(bone.rotation);
    point.add(bone.position);
  }
  return point;
}

/** 功能：构造使用原版皮肤的静态绑定姿态模型。时间：2026-09-29；作者：lq。 */
export function buildStudio(mdl: Mdl, targetHeight?: number, sequenceName?: string, rawScale?: number): THREE.Group {
  const group = new THREE.Group();
  const animatedMeshes: AnimatedMesh[] = [];
  // 功能：优先使用原版持枪/待机动作帧，避免将人物的绑定姿态误当作游戏动作。时间：2026-09-29；作者：lq。
  const pose = samplePose(mdl, findSequence(mdl, sequenceName ?? 'idle'), 0);
  const materials = mdl.textures.map((source) => {
    const map = new THREE.DataTexture(source.rgba, source.width, source.height, THREE.RGBAFormat);
    map.colorSpace = THREE.SRGBColorSpace;
    map.magFilter = THREE.NearestFilter;
    map.minFilter = THREE.NearestMipmapLinearFilter;
    map.generateMipmaps = true;
    map.needsUpdate = true;
    // 功能：第一人称刀与手保持原版贴图亮度，避免场景灯光把刀刃压成黑色；世界模型仍受光照。时间：2026-09-29；作者：lq。
    const Material = targetHeight === undefined && rawScale === undefined ? THREE.MeshBasicMaterial : THREE.MeshLambertMaterial;
    return new Material({
      map,
      side: THREE.DoubleSide,
      transparent: (source.flags & STUDIO_NF_MASKED) !== 0,
      alphaTest: (source.flags & STUDIO_NF_MASKED) !== 0 ? 0.5 : 0,
    });
  });

  for (const part of mdl.bodyParts) {
    const model = part.models[0];
    if (!model) continue;
    for (const mesh of model.meshes) {
      const positions: number[] = [];
      const uvs: number[] = [];
      const sourceVertices: [number, number, number][] = [];
      const boneIndices: number[] = [];
      const textureIndex = mdl.skinFamilies[0]?.[mesh.skinRef] ?? mesh.skinRef;
      const source = mdl.textures[textureIndex];
      if (!source) continue;
      for (const triangle of mesh.triangles) {
        for (const corner of triangle) {
          const raw = model.vertices[corner.vertex];
          if (!raw) continue;
          const point = transformVertex(pose, raw, model.boneIndices[corner.vertex] ?? 0);
          // 功能：原版持枪动作把枪口指向 +X；换成 Three.js 的 -Z 前方，人物则沿地图坐标摆放。时间：2026-09-29；作者：lq。
          if (targetHeight !== undefined || rawScale !== undefined) positions.push(point.x, point.z, -point.y);
          else positions.push(-point.y, point.z, -point.x);
          // 功能：DataTexture 默认不翻转像素行，MDL 的 t=0 须对应纹理首行；修复匪徒脸部与衣服贴图倒置。时间：2026-09-29；作者：lq。
          uvs.push(corner.s / source.width, corner.t / source.height);
          sourceVertices.push(raw);
          boneIndices.push(model.boneIndices[corner.vertex] ?? 0);
        }
      }
      if (positions.length === 0) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geometry.computeVertexNormals();
      group.add(new THREE.Mesh(geometry, materials[textureIndex]!));
      animatedMeshes.push({ geometry, vertices: sourceVertices, boneIndices });
    }
  }

  const bounds = new THREE.Box3().setFromObject(group);
  // 功能：第三人称 p_ 武器保留 MDL 原点，仅按人物比例缩放，才能用两套模型的右手骨骼准确对齐。时间：2026-09-29；作者：lq。
  if (rawScale !== undefined) {
    group.scale.setScalar(rawScale);
  } else if (!bounds.isEmpty()) {
    const size = bounds.getSize(new THREE.Vector3());
    const scale = targetHeight ? targetHeight / Math.max(size.y, 1) : 0.015;
    const center = bounds.getCenter(new THREE.Vector3());
    group.scale.setScalar(scale);
    group.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
  }
  animated.set(group, { mdl, meshes: animatedMeshes, player: targetHeight !== undefined || rawScale !== undefined });
  return group;
}

/** 功能：按原版动作帧更新人物骨骼网格，让奔跑、蹲伏和持枪姿势跟随游戏状态。时间：2026-09-29；作者：lq。 */
export function setStudioPose(group: THREE.Group, sequenceName: string, frame: number, upperSequenceName?: string, pitch = 0): void {
  const state = animated.get(group);
  if (!state) return;
  const sequence = findSequence(state.mdl, sequenceName);
  if (!sequence) return;
  const pose = samplePose(state.mdl, sequence, frame, pitch);
  // 功能：移动时双腿继续播放行走动画，上身保持当前武器的原版持枪姿势，防止手臂甩开后枪械悬空。时间：2026-09-29；作者：lq。
  const upperPose = upperSequenceName ? samplePose(state.mdl, findSequence(state.mdl, upperSequenceName), 0, pitch) : null;
  for (const mesh of state.meshes) {
    const attribute = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < mesh.vertices.length; i++) {
      const boneIndex = mesh.boneIndices[i]!;
      const boneName = state.mdl.bones[boneIndex]?.name ?? '';
      // 功能：臀部辅助骨骼必须随腿部奔跑动作，避免匪徒皮肤在胯部被拉成尖长三角面。时间：2026-09-29；作者：lq。
      const useUpper = upperPose && !/Pelvis|Butt|Thigh|Calf|Foot|Toe|Ankle|Knee/i.test(boneName) && boneIndex > 1;
      const point = transformVertex(useUpper ? upperPose : pose, mesh.vertices[i]!, boneIndex);
      if (state.player) attribute.setXYZ(i, point.x, point.z, -point.y);
      else attribute.setXYZ(i, -point.y, point.z, -point.x);
    }
    attribute.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
    mesh.geometry.computeBoundingSphere();
  }
}

/** 功能：读取原版 MDL 动作帧数，供第一人称按真实时长播放。时间：2026-09-29；作者：lq。 */
export function studioSequenceFrames(group: THREE.Group, sequenceName: string): number {
  const state = animated.get(group);
  if (!state) return 1;
  return findSequence(state.mdl, sequenceName)?.numFrames ?? 1;
}

/** 功能：读取当前人物动作中的右手位置，供第三人称武器逐帧贴合手部。时间：2026-09-29；作者：lq。 */
export function studioHandPosition(group: THREE.Group, sequenceName: string, frame: number, pitch = 0): THREE.Vector3 | null {
  const state = animated.get(group);
  if (!state) return null;
  const index = state.mdl.bones.findIndex((bone) => bone.name === 'Bip01 R Hand');
  if (index < 0) return null;
  const pose = samplePose(state.mdl, findSequence(state.mdl, sequenceName), frame, pitch)[index];
  if (!pose) return null;
  // 功能：将骨骼挂点从 MDL 局部坐标完整转换到场景世界坐标，包含模型居中、缩放和父节点朝向。时间：2026-09-29；作者：lq。
  const point = new THREE.Vector3(pose.position.x, pose.position.z, -pose.position.y);
  group.updateMatrixWorld(true);
  return point.applyMatrix4(group.matrixWorld);
}

/** 功能：读取右手在人物模型局部坐标中的位置，供武器作为人物子节点挂接。时间：2026-09-29；作者：lq。 */
export function studioHandLocalPosition(group: THREE.Group, sequenceName: string, frame: number): THREE.Vector3 | null {
  const state = animated.get(group);
  if (!state) return null;
  const index = state.mdl.bones.findIndex((bone) => bone.name === 'Bip01 R Hand');
  if (index < 0) return null;
  const pose = samplePose(state.mdl, findSequence(state.mdl, sequenceName), frame)[index];
  if (!pose) return null;
  // 功能：返回人物 Group 的局部坐标，避免把父级缩放重复乘到武器上导致挂点漂移。时间：2026-09-29；作者：lq。
  return new THREE.Vector3(pose.position.x, pose.position.z, -pose.position.y);
}

/** 功能：将 GoldSrc 右手骨骼旋转转换到 Three.js 模型局部轴向，供第三人称枪械跟随握姿旋转。时间：2026-09-29；作者：lq。 */
export function studioHandLocalRotation(group: THREE.Group, sequenceName: string, frame: number, pitch = 0): THREE.Quaternion | null {
  const state = animated.get(group);
  if (!state) return null;
  const index = state.mdl.bones.findIndex((bone) => bone.name === 'Bip01 R Hand');
  if (index < 0) return null;
  const pose = samplePose(state.mdl, findSequence(state.mdl, sequenceName), frame, pitch)[index];
  if (!pose) return null;
  const axes = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  return axes.clone().multiply(pose.rotation).multiply(axes.clone().invert());
}

/** 功能：读取人物右手的世界旋转，让枪械在仰俯瞄准时仍与手掌保持同一方向。时间：2026-09-29；作者：lq。 */
export function studioHandWorldRotation(group: THREE.Group, sequenceName: string, frame: number, pitch = 0): THREE.Quaternion | null {
  const hand = studioHandLocalRotation(group, sequenceName, frame, pitch);
  if (!hand) return null;
  group.updateMatrixWorld(true);
  return group.getWorldQuaternion(new THREE.Quaternion()).multiply(hand);
}

/** 功能：读取 p_ 模型最前端的枪口本地坐标，让 BOT 火焰与可见枪管重合。时间：2026-09-29；作者：lq。 */
export function studioMuzzleLocalPosition(group: THREE.Group): THREE.Vector3 | null {
  const state = animated.get(group);
  if (!state) return null;
  const bounds = new THREE.Box3();
  for (const mesh of state.meshes) {
    mesh.geometry.computeBoundingBox();
    if (mesh.geometry.boundingBox) bounds.union(mesh.geometry.boundingBox);
  }
  if (bounds.isEmpty()) return null;
  // 功能：p_ 世界模型转换后枪口位于局部 +X 端，取最前端顶点中心，避免不同队友枪械出现反向。时间：2026-09-30；作者：lq。
  const front = bounds.max.x;
  const limit = front - (front - bounds.min.x) * 0.08;
  const sum = new THREE.Vector3();
  let count = 0;
  for (const mesh of state.meshes) {
    const positions = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < positions.count; i++) {
      if (positions.getX(i) < limit) continue;
      sum.x += positions.getX(i);
      sum.y += positions.getY(i);
      sum.z += positions.getZ(i);
      count++;
    }
  }
  return count > 0 ? sum.multiplyScalar(1 / count) : new THREE.Vector3(front, bounds.getCenter(new THREE.Vector3()).y, bounds.getCenter(new THREE.Vector3()).z);
}

/** 功能：从第一人称 v_ 模型最前端顶点计算枪口，替换会让火焰浮在枪前的固定经验偏移。时间：2026-09-29；作者：lq。 */
export function studioViewMuzzlePosition(group: THREE.Group): THREE.Vector3 | null {
  const state = animated.get(group);
  if (!state) return null;
  let front = Infinity;
  let back = -Infinity;
  for (const mesh of state.meshes) {
    const positions = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < positions.count; i++) {
      front = Math.min(front, positions.getZ(i));
      back = Math.max(back, positions.getZ(i));
    }
  }
  if (!Number.isFinite(front)) return null;
  const limit = front + (back - front) * 0.07;
  let x = 0;
  let y = 0;
  let count = 0;
  for (const mesh of state.meshes) {
    const positions = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < positions.count; i++) {
      if (positions.getZ(i) > limit) continue;
      x += positions.getX(i);
      y += positions.getY(i);
      count++;
    }
  }
  if (!count) return null;
  return new THREE.Vector3(x / count, y / count, front).multiplyScalar(group.scale.x).add(group.position);
}

/** 功能：释放模型实例的几何缓存；共享原版资源仍由请求缓存复用。时间：2026-09-29；作者：lq。 */
export function disposeStudio(group: THREE.Object3D): void {
  if (group instanceof THREE.Group) animated.delete(group);
  group.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        if (material instanceof THREE.MeshLambertMaterial) material.map?.dispose();
        material.dispose();
      }
    }
  });
}
