/**
 * 功能：渲染地面和已安装的 C4 世界模型，保持原版包点物件可见。
 * 时间：2026-09-30；作者：lq。
 */
import * as THREE from 'three';
import type { GameMode } from '../../game/gamemode.ts';
import { toThree } from './boxGeometry.ts';
import { buildStudio, disposeStudio, loadStudio } from './studio.ts';

export class BombRenderer {
  private readonly group = new THREE.Group();
  private studio: THREE.Group | null = null;
  private requested = false;

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
    this.group.visible = false;
  }

  /** 功能：按模拟层 C4 状态显示 w_c4，爆炸或拆除后隐藏。时间：2026-09-30；作者：lq。 */
  update(mode: GameMode): void {
    const bomb = mode.bomb;
    const visible = (bomb.state === 'dropped' || bomb.state === 'planted') && bomb.position !== null;
    this.group.visible = visible;
    if (!visible || !bomb.position) return;
    const [x, y, z] = toThree(bomb.position.x, bomb.position.y, bomb.position.z);
    this.group.position.set(x, y, z);
    if (!this.requested) {
      this.requested = true;
      void loadStudio('w_c4.mdl').then((mdl) => {
        if (!mdl) return;
        // 功能：w_c4 使用模型原始世界单位，避免缩小后难以找到炸弹。时间：2026-09-30；作者：lq。
        this.studio = buildStudio(mdl, undefined, 'idle', 1);
        this.group.add(this.studio);
      });
    }
  }

  dispose(): void {
    if (this.studio) disposeStudio(this.studio);
    this.group.removeFromParent();
  }
}
