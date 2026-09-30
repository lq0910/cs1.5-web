/**
 * 功能：在世界中显示飞行、弹跳和落地的 CS 1.5 原版手雷模型。
 * 时间：2026-09-29；作者：lq。
 */
import * as THREE from 'three';
import type { GrenadeProjectile } from '../../game/match.ts';
import { toThree } from './boxGeometry.ts';
import { buildStudio, disposeStudio, loadStudio } from './studio.ts';

interface GrenadeView { group: THREE.Group; studio: THREE.Group | null }

export class GrenadeRenderer {
  private readonly views = new Map<number, GrenadeView>();

  constructor(private readonly scene: THREE.Scene) {}

  /** 功能：按模拟层的投掷物位置更新原版 w_ 模型，并在引爆后移除。时间：2026-09-29；作者：lq。 */
  update(projectiles: readonly GrenadeProjectile[]): void {
    const seen = new Set<number>();
    for (const projectile of projectiles) {
      seen.add(projectile.id);
      let view = this.views.get(projectile.id);
      if (!view) {
        const group = new THREE.Group();
        const fallback = new THREE.Mesh(
          new THREE.SphereGeometry(4, 8, 6),
          new THREE.MeshLambertMaterial({ color: projectile.kind === 'flashbang' ? 0xd8d4b7 : 0x506342 }),
        );
        group.add(fallback);
        this.scene.add(group);
        view = { group, studio: null };
        this.views.set(projectile.id, view);
        const current = view;
        void loadStudio(`w_${projectile.kind}.mdl`).then((mdl) => {
          if (!mdl || this.views.get(projectile.id) !== current) return;
          const studio = buildStudio(mdl, 8, 'idle');
          for (const child of [...group.children]) {
            group.remove(child);
            if (child instanceof THREE.Mesh) child.geometry.dispose();
          }
          group.add(studio);
          current.studio = studio;
        });
      }
      const [x, y, z] = toThree(projectile.position.x, projectile.position.y, projectile.position.z);
      view.group.position.set(x, y, z);
      // 功能：按真实飞行速度缓慢滚转原版 w_ 手雷，落地后停止，避免每帧 0.3 弧度造成陀螺式乱转。时间：2026-09-30；作者：lq。
      const speed = Math.hypot(projectile.velocity.x, projectile.velocity.y, projectile.velocity.z);
      if (speed > 22) {
        view.group.rotation.x += Math.min(0.08, speed / 12000);
        view.group.rotation.y += Math.min(0.05, speed / 18000);
      }
    }
    for (const [id, view] of this.views) {
      if (seen.has(id)) continue;
      this.scene.remove(view.group);
      if (view.studio) disposeStudio(view.studio);
      this.views.delete(id);
    }
  }
}
