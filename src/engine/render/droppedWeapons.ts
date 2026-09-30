/**
 * 功能：把阵亡或主动丢弃的枪械显示为原版 w_ 世界模型，并在拾取或新回合时移除。
 * 时间：2026-09-29；作者：lq。
 */
import * as THREE from 'three';
import type { DroppedWeapon } from '../../game/match.ts';
import { toThree } from './boxGeometry.ts';
import { buildStudio, disposeStudio, loadStudio } from './studio.ts';

interface DroppedWeaponView { group: THREE.Group; studio: THREE.Group | null }

export class DroppedWeaponRenderer {
  private readonly views = new Map<number, DroppedWeaponView>();

  constructor(private readonly scene: THREE.Scene) {}

  /** 功能：按模拟层枪械列表同步地面模型，异步加载期间提供可见占位物。时间：2026-09-29；作者：lq。 */
  update(droppedWeapons: readonly DroppedWeapon[]): void {
    const seen = new Set<number>();
    for (const dropped of droppedWeapons) {
      seen.add(dropped.id);
      let view = this.views.get(dropped.id);
      if (!view) {
        const group = new THREE.Group();
        const fallback = new THREE.Mesh(
          new THREE.BoxGeometry(26, 3, 8),
          new THREE.MeshLambertMaterial({ color: 0x272727 }),
        );
        group.add(fallback);
        this.scene.add(group);
        view = { group, studio: null };
        this.views.set(dropped.id, view);
        const current = view;
        const name = dropped.weapon.id === 'usp45' ? 'usp' : dropped.weapon.id === 'mp5navy' ? 'mp5' : dropped.weapon.id;
        void loadStudio(`w_${name}.mdl`).then((mdl) => {
          if (!mdl || this.views.get(dropped.id) !== current) return;
          // 功能：w_ 模型本来就按世界单位制作，保留原始比例与平躺姿态。时间：2026-09-29；作者：lq。
          const studio = buildStudio(mdl, undefined, 'idle', 1);
          for (const child of [...group.children]) {
            group.remove(child);
            if (child instanceof THREE.Mesh) {
              child.geometry.dispose();
              const materials = Array.isArray(child.material) ? child.material : [child.material];
              for (const material of materials) material.dispose();
            }
          }
          group.add(studio);
          current.studio = studio;
        });
      }
      const [x, y, z] = toThree(dropped.position.x, dropped.position.y, dropped.position.z);
      view.group.position.set(x, y, z);
      view.group.rotation.y = dropped.yaw * Math.PI / 180;
    }
    for (const [id, view] of this.views) {
      if (seen.has(id)) continue;
      this.scene.remove(view.group);
      if (view.studio) disposeStudio(view.studio);
      this.views.delete(id);
    }
  }
}
