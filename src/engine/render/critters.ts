/**
 * 功能：把模拟层随机撒下的小鸡绘制成低多边形原版风格模型，并播放啄食、扇翅和倒地动画。
 * 时间：2026-10-21；作者：lq。
 *
 * 优先加载原版 cs_italy 的 models/chick.mdl 皮肤和网格，素材缺失时以几何体占位。
 */

import * as THREE from 'three';
import type { Critter } from '../../game/critters.ts';
import { buildStudio, loadStudio, setStudioPose, disposeStudio } from './studio.ts';
import { toThree } from './boxGeometry.ts';

interface CritterView {
  root: THREE.Group;
  /** 功能：只有身体参与死亡侧翻，脚下的阴影始终保持平贴地面。时间：2026-10-21；作者：lq。 */
  tilt: THREE.Group;
  body: THREE.Group;
  head: THREE.Group;
  tail: THREE.Group;
  wings: THREE.Object3D[];
  phase: number;
  /** 功能：保存原版小鸡网格；原版只有 peck 动画，迈步由腿骨偏移补足。时间：2026-10-21；作者：lq。 */
  studio: THREE.Group | null;
  legs: THREE.Group[];
}

const BODY_COLORS = [0xf2ece0, 0xb98552, 0x8c6b4f];
const sharedGeometry = {
  sphere: new THREE.SphereGeometry(1, 8, 6),
  box: new THREE.BoxGeometry(1, 1, 1),
  cone: new THREE.ConeGeometry(1, 2, 5),
  leg: new THREE.CylinderGeometry(0.55, 0.55, 1, 5),
  shadow: new THREE.CircleGeometry(1, 14),
};
const sharedMaterial = {
  beaks: new THREE.MeshLambertMaterial({ color: 0xe8a020, flatShading: true }),
  comb: new THREE.MeshLambertMaterial({ color: 0xc02323, flatShading: true }),
  eyes: new THREE.MeshLambertMaterial({ color: 0x141414 }),
  legs: new THREE.MeshLambertMaterial({ color: 0xd08a1c, flatShading: true }),
  shadow: new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false }),
};

function tinted(color: number): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color, flatShading: true });
}

/** 功能：给模型加一个部件并设置局部位置、缩放和旋转。时间：2026-10-21；作者：lq。 */
function part(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  position: [number, number, number],
  scale: [number, number, number],
  rotation: [number, number, number] = [0, 0, 0],
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...position);
  mesh.scale.set(...scale);
  mesh.rotation.set(...rotation);
  parent.add(mesh);
  return mesh;
}

export class CritterRenderer {
  private readonly views = new Map<number, CritterView>();
  private readonly bodyMaterials: THREE.MeshLambertMaterial[];

  constructor(private readonly scene: THREE.Scene) {
    this.bodyMaterials = BODY_COLORS.map(tinted);
  }

  /** 功能：按当前模拟层小鸡列表增删模型，并逐帧更新动画。时间：2026-10-21；作者：lq。 */
  update(critters: readonly Critter[], now: number): void {
    const seen = new Set<number>();
    for (const critter of critters) {
      seen.add(critter.id);
      let view = this.views.get(critter.id);
      if (!view) {
        view = this.build(critter);
        this.views.set(critter.id, view);
        this.scene.add(view.root);
      }
      const [x, y, z] = toThree(critter.position.x, critter.position.y, critter.position.z);
      view.root.position.set(x, y, z);
      view.root.rotation.y = (critter.yaw * Math.PI) / 180;
      this.animate(view, critter, now);
    }
    for (const [id, view] of this.views) {
      if (seen.has(id)) continue;
      if (view.studio) disposeStudio(view.studio);
      this.scene.remove(view.root);
      this.views.delete(id);
    }
  }

  /** 功能：搭建一只面向 +X 的小鸡，脚底位于组原点。时间：2026-10-21；作者：lq。 */
  private build(critter: Critter): CritterView {
    const root = new THREE.Group();
    const tilt = new THREE.Group();
    root.add(tilt);
    const body = new THREE.Group();
    body.position.y = 10;
    tilt.add(body);

    const feather = this.bodyMaterials[critter.variant % this.bodyMaterials.length]!;
    // 功能：躯干、胸脯和尾羽构成原版小鸡的圆润剪影。时间：2026-10-21；作者：lq。
    part(body, sharedGeometry.sphere, feather, [0, 0, 0], [7.2, 5.6, 7.4], [0, 0, -0.12]);
    part(body, sharedGeometry.sphere, feather, [3.4, 0.6, 0], [4.2, 4.4, 5.2]);
    const tail = new THREE.Group();
    tail.position.set(-6.4, 3.4, 0);
    body.add(tail);
    for (let i = -1; i <= 1; i++) {
      part(tail, sharedGeometry.box, feather, [-1.4, i * 1.4, 0], [4.6, 1.2, 1.6], [0, 0, 0.55 + i * 0.12]);
    }

    const head = new THREE.Group();
    head.position.set(6.6, 5.6, 0);
    body.add(head);
    part(head, sharedGeometry.sphere, feather, [0, 0, 0], [3.1, 3.1, 3.1]);
    // 功能：左右眼、喙、鸡冠和肉垂让小鸡从远处也能一眼辨认。时间：2026-10-21；作者：lq。
    for (const side of [-1, 1]) {
      part(head, sharedGeometry.sphere, sharedMaterial.eyes, [1.9, 0.7, side * 2.05], [0.55, 0.55, 0.55]);
      part(head, sharedGeometry.cone, sharedMaterial.beaks, [3.3, 0.1, side * 0.65], [0.85, 1.15, 0.85], [0, 0, -Math.PI / 2]);
    }
    for (let i = 0; i < 3; i++) {
      part(head, sharedGeometry.box, sharedMaterial.comb, [-0.4 + i * 0.8, 3.1 - i * 0.12, 0], [0.9, 0.9 + i * 0.3, 0.7], [0, 0, 0.12]);
    }
    part(head, sharedGeometry.sphere, sharedMaterial.comb, [2.4, -1.8, 0], [0.8, 1.1, 0.8]);

    const wings: THREE.Object3D[] = [];
    for (const side of [-1, 1]) {
      const wing = part(body, sharedGeometry.box, feather, [-0.2, 0.4, side * 6.8], [4.4, 1.2, 0.7], [0, 0, 0.12]);
      wings.push(wing);
    }

    // 功能：细腿和脚掌挂在侧翻组上，身体上下起伏时双脚仍踩在地面，死亡时随身体一起倒下。时间：2026-10-21；作者：lq。
    const legs: THREE.Group[] = [];
    for (const side of [-1, 1]) {
      const leg = new THREE.Group();
      tilt.add(leg);
      legs.push(leg);
      part(leg, sharedGeometry.leg, sharedMaterial.legs, [0.2, 4.1, side * 2.4], [1, 8.2, 1]);
      part(leg, sharedGeometry.box, sharedMaterial.legs, [1.6, 0.35, side * 2.4], [3.4, 0.7, 1.4]);
    }
    const shadow = new THREE.Mesh(sharedGeometry.shadow, sharedMaterial.shadow);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.45;
    shadow.scale.setScalar(8);
    root.add(shadow);

    const view: CritterView = { root, tilt, body, head, tail, wings, legs, phase: critter.phase, studio: null };
    // 功能：异步替换为原版 MDL 的网格与调色板贴图，回合已结束则丢弃结果。时间：2026-10-21；作者：lq。
    void loadStudio('chick.mdl').then((mdl) => {
      if (!mdl || this.views.get(critter.id) !== view) return;
      const studio = buildStudio(mdl, 22, 'peck');
      // 功能：原版鸡头朝 +Y，转换后朝 -Z；居中偏移与模型同时旋转到 +X，脚底对齐命中盒。时间：2026-10-21；作者：lq。
      studio.rotation.y = -Math.PI / 2;
      studio.position.applyAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
      studio.position.y += 11;
      body.visible = false;
      legs.forEach((leg) => { leg.visible = false; });
      tilt.add(studio);
      view.studio = studio;
    });
    return view;
  }

  /** 功能：待机时呼吸、随机啄食和扇翅；受击短暂抖动；死亡后向侧面倒下。时间：2026-10-21；作者：lq。 */
  private animate(view: CritterView, critter: Critter, now: number): void {
    // 功能：按实际行走距离交替抬腿；停步时继续原版 peck，死亡后冻结骨骼。时间：2026-10-21；作者：lq。
    const stride = (critter.walkDistance ?? 0) * 0.5;
    const swing = critter.moving ? Math.sin(stride) : 0;
    if (view.studio && critter.alive) {
      const offsets: Record<string, readonly [number, number, number]> = {};
      for (const [prefix, sign] of [['lt', 1], ['rt', -1]] as const) {
        for (const name of ['Hip', 'Joint', 'Foot']) {
          const weight = name === 'Hip' ? 0.35 : 1;
          offsets[prefix + name] = [0, swing * sign * 2 * weight, Math.max(0, swing * sign) * 1.5 * weight];
        }
      }
      setStudioPose(view.studio, 'peck', (now + view.phase) * 30 % 99, undefined, 0, offsets);
    }
    view.legs.forEach((leg, index) => { leg.rotation.z = swing * (index ? -0.4 : 0.4); });
    if (!critter.alive) {
      const fall = Math.max(0, Math.min(1, (now - critter.diedAt) / 0.42));
      // 功能：使用缓出曲线让倒地动作先快后慢，避免瞬间翻转。时间：2026-10-21；作者：lq。
      const eased = 1 - (1 - fall) * (1 - fall);
      view.tilt.rotation.z = -eased * Math.PI * 0.5;
      view.body.position.y = 10 - eased * 2.2;
      view.head.rotation.z = eased * 0.4;
      return;
    }
    const t = now + view.phase;
    const bob = Math.abs(Math.sin(t * 2.2)) * 0.8;
    const peck = Math.pow(Math.max(0, Math.sin(t * 0.85)), 8);
    const flinch = Math.max(0, 1 - (now - critter.hitAt) / 0.2);
    view.tilt.rotation.z = 0;
    view.body.position.y = 10 + bob - flinch * 1.6;
    view.body.rotation.z = -flinch * 0.25;
    view.head.rotation.z = -peck * 0.85 - flinch * 0.3;
    view.tail.rotation.y = Math.sin(t * 1.35) * 0.24;
    view.wings[0]!.rotation.x = 0.12 + Math.sin(t * 2.2) * 0.1;
    view.wings[1]!.rotation.x = -0.12 - Math.sin(t * 2.2) * 0.1;
  }
}
