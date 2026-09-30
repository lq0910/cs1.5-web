/**
 * 功能：绘制原版第一人称枪械模型并保留移动、后坐力和换弹视图运动。
 * 时间：2026-09-29；作者：lq。
 */

import * as THREE from 'three';
import type { WeaponId } from '../../game/weapons.ts';
import type { PunchAngle } from '../../game/weapons.ts';
import { reloadDuration } from '../../game/weapons.ts';
import { getMaterial } from './textures.ts';
import { buildStudio, disposeStudio, loadStudio, setStudioPose, studioSequenceFrames, studioViewMuzzlePosition } from './studio.ts';
import { makeMuzzleTexture } from './muzzle.ts';

export interface ViewModelState {
  /** Horizontal speed in u/s. */
  speed: number;
  onGround: boolean;
  ducked: boolean;
  scoped: boolean;
  /** 1 right after a reload starts, easing to 0 when it finishes. */
  reloadProgress: number;
  /** 1 right after switching, easing to 0 when the weapon is up. */
  deployProgress: number;
  /** 功能：当前手雷动作及剩余时间，用于播放拔销和投掷序列。时间：2026-09-29；作者：lq。 */
  grenadeAction: 'pullpin' | 'hold' | 'throw' | null;
  grenadeActionEndTime: number;
  /** 功能：C4 安装进度驱动原版 pressbutton 第一人称动作。时间：2026-09-30；作者：lq。 */
  bombPlantProgress: number;
  now: number;
  punch: PunchAngle;
  /** View angles this frame (for sway lag). */
  pitch: number;
  yaw: number;
}

/** Resting pose in view space: right, slightly down, in front of the camera. */
const REST = {
  rifle: { x: 0.22, y: -0.2, z: -0.5, yaw: -0.04, pitch: 0.01, roll: 0.02 },
  sniper: { x: 0.2, y: -0.19, z: -0.48, yaw: -0.03, pitch: 0.01, roll: 0.03 },
  pistol: { x: 0.18, y: -0.17, z: -0.36, yaw: -0.02, pitch: 0.01, roll: 0.01 },
  smg: { x: 0.2, y: -0.18, z: -0.42, yaw: -0.03, pitch: 0.01, roll: 0.02 },
  knife: { x: 0.2, y: -0.18, z: -0.34, yaw: -0.12, pitch: -0.05, roll: 0.06 },
};

// 功能：按 CS 1.5 第一人称视图比例放大原版 v_ 模型，使枪和双臂在 16:9 画面中占据与原版一致的下方区域。时间：2026-09-30；作者：lq。
const VIEWMODEL_MODEL_SCALE = 1.2;

function box(
  parent: THREE.Object3D,
  material: THREE.Material,
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  rotX = 0,
  rotZ = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  mesh.rotation.x = rotX;
  mesh.rotation.z = rotZ;
  parent.add(mesh);
  return mesh;
}

export class ViewModel {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** Barrel tip, used to place the muzzle flash in world space. */
  readonly muzzle = new THREE.Object3D();
  private readonly muzzleFlash: THREE.Sprite;

  private readonly root = new THREE.Group();
  /** Muzzle offsets per weapon kind, in the weapon's local space. */
  private static readonly MUZZLE: Record<string, [number, number, number]> = {
    rifle: [0, 0.01, -0.66],
    smg: [0, 0.01, -0.56],
    sniper: [0, 0.005, -0.78],
    pistol: [0, -0.01, -0.26],
    knife: [0, 0, -0.3],
  };
  private weapon: THREE.Group | null = null;
  private studio: THREE.Group | null = null;
  private loadGeneration = 0;
  private weaponId: WeaponId | 'c4' | null = null;
  private bobPhase = 0;
  private swayPitch = 0;
  private swayYaw = 0;
  private lastPitch = 0;
  private lastYaw = 0;
  private recoil = 0;
  private lowered = 0;
  private actionSequence = '';
  private shootTimer = 0;
  private knifeAction = '';
  private knifeActionTime = 0;
  private knifeActionDuration = 0;
  private knifeSwing = 0;
  private flashTimer = 0;

  constructor() {
    this.camera = new THREE.PerspectiveCamera(54, 1, 0.02, 24);
    this.scene.add(this.root);
    // 功能：第一人称枪口焰挂在视图模型枪管上，与枪身一起在独立渲染层显示。时间：2026-09-29；作者：lq。
    this.muzzleFlash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeMuzzleTexture(), transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    this.muzzleFlash.scale.setScalar(0.15);
    this.muzzleFlash.visible = false;
    this.muzzle.add(this.muzzleFlash);

    // The view model needs its own light: the world is lit by baked lightmaps.
    const key = new THREE.DirectionalLight(0xfff0d8, 1.5);
    key.position.set(-0.4, 1, 0.6);
    this.scene.add(key);
    this.scene.add(new THREE.HemisphereLight(0xcfd8e4, 0x6b6252, 0.9));
  }

  /** Recentres the model on a new weapon (called on weapon switch). */
  setWeapon(id: WeaponId | 'c4', kind: 'rifle' | 'sniper' | 'pistol' | 'smg' | 'knife'): void {
    if (this.weaponId === id) return;
    this.weaponId = id;
    if (this.weapon) {
      this.root.remove(this.weapon);
      if (this.studio) disposeStudio(this.studio);
      this.studio = null;
      this.weapon.traverse((child) => {
        if (child instanceof THREE.Mesh) child.geometry.dispose();
      });
    }
    this.weapon = buildWeapon(id, kind);
    this.weapon.add(this.muzzle);
    const offset = ViewModel.MUZZLE[kind] ?? ViewModel.MUZZLE.rifle!;
    this.muzzle.position.set(offset[0], offset[1], offset[2]);
    this.root.add(this.weapon);
    this.recoil = 0;
    this.knifeAction = '';
    this.knifeActionTime = 0;
    const generation = ++this.loadGeneration;
    // 功能：加载本地原版第一人称枪械皮肤，加载期间保留临时模型。时间：2026-09-29；作者：lq。
    // 功能：持包者选择 C4 时加载安装包的原版第一人称模型。时间：2026-09-30；作者：lq。
    const modelName: Record<WeaponId | 'c4', string> = {
      knife: 'knife', glock18: 'glock18', usp45: 'usp', deagle: 'deagle',
      mp5navy: 'mp5', ak47: 'ak47', m4a1: 'm4a1', awp: 'awp',
      p228: 'p228', elite: 'elite', fiveseven: 'fiveseven', m3: 'm3', xm1014: 'xm1014',
      mac10: 'mac10', tmp: 'tmp', ump45: 'ump45', p90: 'p90', aug: 'aug', sg552: 'sg552',
      scout: 'scout', g3sg1: 'g3sg1', sg550: 'sg550', m249: 'm249',
      hegrenade: 'hegrenade', flashbang: 'flashbang', smokegrenade: 'smokegrenade',
      c4: 'c4',
    };
    void loadStudio(`v_${modelName[id]}.mdl`).then((mdl) => {
      if (!mdl || this.loadGeneration !== generation || !this.weapon) return;
      const studio = buildStudio(mdl);
      // 功能：统一放大原版手臂与枪械网格，保持二者相对挂点不变。时间：2026-09-30；作者：lq。
      studio.scale.multiplyScalar(VIEWMODEL_MODEL_SCALE);
      for (const child of [...this.weapon.children]) {
        if (child !== this.muzzle) {
          this.weapon.remove(child);
          if (child instanceof THREE.Mesh) child.geometry.dispose();
        }
      }
      this.weapon.add(studio);
      this.studio = studio;
      // 功能：枪口焰贴合原版 v_ 网格的枪管最前端，切枪后重新计算位置。时间：2026-09-29；作者：lq。
      const barrel = studioViewMuzzlePosition(studio);
      if (barrel) this.muzzle.position.copy(barrel);
    });
  }

  /** Triggers the recoil kick; call once per shot. */
  kick(strength = 1, alternate = false): void {
    // 功能：刀的左键交替播放原版两种挥砍，右键播放独立刺击动画。时间：2026-09-29；作者：lq。
    if (this.weaponId === 'knife') {
      this.knifeAction = alternate ? 'stab' : this.knifeSwing++ % 2 === 0 ? 'slash1' : 'slash2';
      this.knifeActionDuration = alternate ? 0.55 : 0.32;
      this.knifeActionTime = this.knifeActionDuration;
      return;
    }
    // 功能：把本发枪械动作限制为短促后撤，镜头抬升由战斗层 punch 控制，避免枪身与准星双重夸张上跳。时间：2026-09-30；作者：lq。
    this.recoil = Math.min(1.2, this.recoil + strength);
    // 功能：触发原版第一人称 shoot1 击发序列，与后坐力和枪口火焰同步。时间：2026-09-29；作者：lq。
    this.shootTimer = 0.12;
    if (this.weaponId && !['knife', 'hegrenade', 'flashbang', 'smokegrenade'].includes(this.weaponId)) {
      this.flashTimer = 0.06;
      this.muzzleFlash.visible = true;
      (this.muzzleFlash.material as THREE.SpriteMaterial).rotation = Math.random() * Math.PI * 2;
    }
  }

  /** 功能：阵亡观战时隐藏本地第一人称手臂和枪械。时间：2026-09-29；作者：lq。 */
  setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  update(dt: number, state: ViewModelState): void {
    const pose = REST[this.weaponId ? kindOf(this.weaponId) : 'rifle'];

    // ---- sway: the model lags behind the view
    const deltaPitch = state.pitch - this.lastPitch;
    const deltaYaw = state.yaw - this.lastYaw;
    this.lastPitch = state.pitch;
    this.lastYaw = state.yaw;
    const swayTargetPitch = THREE.MathUtils.clamp(-deltaPitch * 0.012, -0.09, 0.09);
    const swayTargetYaw = THREE.MathUtils.clamp(deltaYaw * 0.012, -0.09, 0.09);
    const swayLerp = 1 - Math.exp(-dt * 12);
    this.swayPitch += (swayTargetPitch - this.swayPitch) * swayLerp;
    this.swayYaw += (swayTargetYaw - this.swayYaw) * swayLerp;

    // ---- bob: only while actually moving on the ground
    const speedFraction = Math.min(1, state.speed / 250);
    if (state.onGround) {
      this.bobPhase += dt * (4.6 + speedFraction * 6.5) * Math.max(0.12, speedFraction);
    }
    const bobAmount = state.onGround ? speedFraction * (state.ducked ? 0.012 : 0.026) : 0;
    const bobX = Math.sin(this.bobPhase) * bobAmount;
    const bobY = -Math.abs(Math.cos(this.bobPhase)) * bobAmount * 0.8;

    // ---- recoil decay
    this.recoil = Math.max(0, this.recoil - dt * 6.5);
    this.shootTimer = Math.max(0, this.shootTimer - dt);
    this.knifeActionTime = Math.max(0, this.knifeActionTime - dt);
    this.flashTimer = Math.max(0, this.flashTimer - dt);
    this.muzzleFlash.visible = this.flashTimer > 0;
    (this.muzzleFlash.material as THREE.SpriteMaterial).opacity = this.flashTimer / 0.06;

    // ---- reload / deploy
    const reload = state.reloadProgress;
    this.lowered = state.deployProgress;

    const weapon = this.weapon;
    if (!weapon) return;

    // 功能：使用 v_*.mdl 的原版动作序列替换简化换弹/投雷姿态。时间：2026-09-29；作者：lq。
    if (this.studio) {
      const sequence = this.weaponId === 'c4' && state.bombPlantProgress > 0
        ? 'pressbutton'
        : state.grenadeAction === 'pullpin'
        ? 'pullpin'
        : state.grenadeAction === 'hold'
          ? 'pullpin'
        : state.grenadeAction === 'throw'
          ? 'throw'
          : this.knifeActionTime > 0 ? this.knifeAction
          : this.shootTimer > 0 ? 'shoot1'
          : reload > 0 ? 'reload' : '';
      if (sequence) {
        const frames = studioSequenceFrames(this.studio, sequence);
        const duration = this.weaponId === 'c4' && state.bombPlantProgress > 0 ? 3
          : state.grenadeAction
          ? (state.grenadeAction === 'throw' ? 0.35 : 0.55)
          : this.knifeActionTime > 0 ? this.knifeActionDuration
          : this.shootTimer > 0 ? 0.12
          : Math.max(0.1, this.weaponId && this.weaponId !== 'c4' ? reloadDuration(this.weaponId) : 1);
        const elapsed = this.weaponId === 'c4' && state.bombPlantProgress > 0 ? state.bombPlantProgress * 3
          : state.grenadeAction
          ? state.grenadeAction === 'hold' ? duration : Math.max(0, duration - (state.grenadeActionEndTime - state.now))
          : this.knifeActionTime > 0 ? duration - this.knifeActionTime
          : this.shootTimer > 0 ? duration - this.shootTimer
          : duration * (1 - reload);
        const frame = Math.min(Math.max(0, frames - 1), elapsed / duration * Math.max(0, frames - 1));
        setStudioPose(this.studio, sequence, frame);
        this.actionSequence = sequence;
      } else if (this.actionSequence) {
        setStudioPose(this.studio, 'idle', 0);
        this.actionSequence = '';
      }
    }

    // 功能：投掷物加载原版 v_*.mdl 前隐藏临时几何占位，避免烟雾弹显示成刀状几何体；模型成功加载后再显示经典贴图。时间：2026-09-30；作者：lq。
    const grenadeModel = this.weaponId === 'hegrenade' || this.weaponId === 'flashbang' || this.weaponId === 'smokegrenade';
    weapon.visible = !state.scoped && (!grenadeModel || this.studio !== null);
    if (state.scoped) return;

    // 功能：换弹时先放低再抬回武器，避免全程缓慢抬升的迟滞感。时间：2026-09-29；作者：lq。
    const reloadMotion = Math.sin(Math.PI * (1 - reload));
    weapon.position.set(
      pose.x + bobX + this.swayYaw,
      pose.y + bobY + this.swayPitch - reloadMotion * 0.13 - this.lowered * 0.45,
      pose.z + this.recoil * 0.035,
    );
    weapon.rotation.set(
      pose.pitch + this.recoil * 0.09 + reloadMotion * 0.26 + this.lowered * 0.7 - state.punch.pitch * 0.003,
      pose.yaw + this.swayYaw * 1.4,
      pose.roll + reloadMotion * 0.3,
    );

    weapon.updateMatrixWorld(true);
  }

  /** World-space muzzle position, for the flash and the tracer origin. */
  muzzleWorldPosition(): THREE.Vector3 {
    this.muzzle.updateMatrixWorld(true);
    return this.muzzle.getWorldPosition(new THREE.Vector3());
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}

function kindOf(id: WeaponId | 'c4'): 'rifle' | 'sniper' | 'pistol' | 'smg' | 'knife' {
  switch (id) {
    case 'awp':
      return 'sniper';
    case 'glock18':
    case 'usp45':
    case 'deagle':
    case 'p228':
    case 'elite':
    case 'fiveseven':
      return 'pistol';
    case 'mp5navy':
    case 'mac10':
    case 'tmp':
    case 'ump45':
    case 'p90':
      return 'smg';
    case 'knife':
    case 'c4':
    case 'hegrenade':
    case 'flashbang':
    case 'smokegrenade':
      return 'knife';
    default:
      return 'rifle';
  }
}

function buildWeapon(id: WeaponId | 'c4', kind: 'rifle' | 'sniper' | 'pistol' | 'smg' | 'knife'): THREE.Group {
  const group = new THREE.Group();
  const metal = getMaterial('metal').material;
  const wood = getMaterial('wood').material;
  const dark = new THREE.MeshBasicMaterial({ color: 0x1b1d20 });
  const grip = kind === 'rifle' && id === 'ak47' ? wood : dark;

  if (kind === 'knife') {
    box(group, metal, 0.05, 0.012, 0.26, 0, 0.005, -0.16);
    box(group, dark, 0.035, 0.05, 0.09, 0, -0.03, 0.02);
    return group;
  }

  if (kind === 'pistol') {
    box(group, dark, 0.055, 0.075, 0.2, 0, 0, -0.06); // slide
    box(group, grip, 0.05, 0.13, 0.07, 0, -0.09, 0.02, 0.22); // grip
    box(group, metal, 0.02, 0.02, 0.1, 0, -0.01, -0.18); // barrel
  } else if (kind === 'sniper') {
    box(group, dark, 0.06, 0.08, 0.52, 0, 0, -0.22); // body
    box(group, metal, 0.025, 0.025, 0.34, 0, 0.005, -0.55); // barrel
    box(group, dark, 0.09, 0.1, 0.16, 0, -0.09, 0.06, 0.16); // stock
    box(group, dark, 0.05, 0.13, 0.07, 0, -0.1, -0.02, 0.2); // grip
    const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.2, 10), dark);
    scope.rotation.x = Math.PI / 2;
    scope.position.set(0, 0.062, -0.16);
    group.add(scope);
  } else {
    // rifle / smg
    const bodyLength = kind === 'smg' ? 0.34 : 0.44;
    box(group, dark, 0.06, 0.075, bodyLength, 0, 0, -0.2); // receiver
    box(group, metal, 0.022, 0.022, 0.3, 0, 0.01, -0.5); // barrel
    box(group, grip, 0.05, 0.13, 0.07, 0, -0.09, 0.0, 0.24); // grip
    box(group, grip, 0.055, 0.16, 0.05, 0, -0.085, -0.12, 0.12); // magazine
    box(group, grip, 0.055, 0.07, 0.2, 0, -0.01, -0.34); // handguard
    if (kind === 'rifle') box(group, dark, 0.06, 0.09, 0.18, 0, -0.01, 0.08); // stock
  }

  group.position.set(0, 0, 0);
  return group;
}
