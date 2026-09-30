/** 功能：从原版 spraypaint.wad 加载 Lambda 喷漆，以有限贴花池附着在世界表面。时间：2026-09-30；作者：lq。 */
import * as THREE from 'three';
import type { BspMiptex } from '../bsp/types.ts';
import { parseWad3 } from '../bsp/wad.ts';
import type { SprayEvent } from '../../game/match.ts';
import { toThree } from './boxGeometry.ts';

/** 功能：原版单色喷漆按灰度表示透明度，黑色背景透明，白色图案由材料染色。时间：2026-09-30；作者：lq。 */
export function sprayTexture(source: BspMiptex): THREE.DataTexture {
  const rgba = new Uint8Array(source.width * source.height * 4);
  for (let i = 0; i < source.width * source.height; i++) {
    rgba[i * 4] = 255;
    rgba[i * 4 + 1] = 255;
    rgba[i * 4 + 2] = 255;
    rgba[i * 4 + 3] = source.palette[source.pixels[i]! * 3] ?? 0;
  }
  const texture = new THREE.DataTexture(rgba, source.width, source.height, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = true;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** 功能：独立保存最多 16 张喷漆，后续喷漆循环替换旧贴花，不受枪弹贴花池影响。时间：2026-09-30；作者：lq。 */
export class SprayRenderer {
  private readonly meshes: THREE.Mesh[] = [];
  private readonly material: THREE.MeshBasicMaterial;
  private cursor = 0;

  /** 功能：预分配喷漆平面和共享材料，支持使用已解码的原版贴图。时间：2026-09-30；作者：lq。 */
  constructor(scene: THREE.Scene, texture: THREE.DataTexture | null = null) {
    this.material = new THREE.MeshBasicMaterial({
      map: texture,
      color: 0xc45b2c,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    const geometry = new THREE.PlaneGeometry(64, 64);
    for (let i = 0; i < 16; i++) {
      const mesh = new THREE.Mesh(geometry, this.material);
      mesh.visible = false;
      mesh.matrixAutoUpdate = false;
      scene.add(mesh);
      this.meshes.push(mesh);
    }
  }

  /** 功能：预载用户原版资源中的 Lambda 喷漆；缺失资源时保留游戏运行并报告原因。时间：2026-09-30；作者：lq。 */
  async loadTexture(): Promise<void> {
    try {
      const response = await fetch('/cstrike/spraypaint.wad', { cache: 'force-cache' });
      if (!response.ok) throw new Error(`spraypaint.wad: HTTP ${response.status}`);
      const source = parseWad3(await response.arrayBuffer()).textures.get('lambda');
      if (!source || source.external) throw new Error('spraypaint.wad: missing Lambda texture');
      this.material.map?.dispose();
      this.material.map = sprayTexture(source);
      this.material.needsUpdate = true;
    } catch (error) {
      console.warn('Original spray texture could not be loaded:', error);
    }
  }

  /** 功能：只有原版喷漆资源加载完成后，才接受 T 键请求。时间：2026-09-30；作者：lq。 */
  get ready(): boolean {
    return this.material.map !== null;
  }

  /** 功能：墙面喷漆保持竖直，地面喷漆跟随玩家朝向，略微偏离表面避免闪烁。时间：2026-09-30；作者：lq。 */
  addSpray(event: SprayEvent): void {
    if (!this.ready) return;
    const mesh = this.meshes[this.cursor++ % this.meshes.length]!;
    const normal = new THREE.Vector3(...toThree(event.normal.x, event.normal.y, event.normal.z)).normalize();
    const up = Math.abs(normal.y) > 0.99
      ? new THREE.Vector3(Math.cos(event.yaw * Math.PI / 180), 0, -Math.sin(event.yaw * Math.PI / 180))
      : new THREE.Vector3(0, 1, 0);
    up.addScaledVector(normal, -up.dot(normal)).normalize();
    const right = new THREE.Vector3().crossVectors(up, normal).normalize();
    up.crossVectors(normal, right).normalize();
    mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, normal));
    mesh.position.set(...toThree(event.position.x, event.position.y, event.position.z)).addScaledVector(normal, 0.12);
    mesh.visible = true;
    mesh.updateMatrix();
  }
}
