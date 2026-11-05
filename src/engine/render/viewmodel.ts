/**
 * 功能：绘制原版第一人称枪械模型并保留移动、后坐力和换弹视图运动。
 * 时间：2026-09-29；作者：lq。
 */

import * as THREE from 'three';
import type { WeaponId } from '../../game/weapons.ts';
import type { PunchAngle } from '../../game/weapons.ts';
import { GRENADE_PULLPIN_TIME, GRENADE_THROW_TIME } from '../../game/grenades.ts';
import { reloadDuration } from '../../game/weapons.ts';
import { getMaterial } from './textures.ts';
import { buildStudio, disposeStudio, loadStudio, setStudioPose, studioSequence, studioViewMuzzlePosition } from './studio.ts';
import { verticalFovForHorizontal } from './boxGeometry.ts';
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
  /** 功能：保留当前视角输入，不添加鼠标滞后横摆。时间：2026-11-05；作者：lq。 */
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

/** 功能：移植 Valve SDK view.cpp 的 V_CalcBob，默认 cl_bob=0.01、cycle=0.8、up=0.5。时间：2026-11-05；作者：lq。 */
export function classicBob(time: number, speed: number): number {
  return THREE.MathUtils.clamp(speed * 0.01 * (0.3 + 0.7 * Math.sin(time / 0.8 * Math.PI * 2)), -7, 4);
}

// 功能：独立武器层采用较轻的移动幅度，避免 SDK 整体转角使手臂大幅左右摇摆；保留原有步频与镜头 bob。时间：2026-11-05；作者：lq。
const WEAPON_BOB_SCALE = 0.35;
// 功能：以时间常数平滑水平速度，减轻固定模拟步长和起停造成的视图跳变。时间：2026-11-05；作者：lq。
const BOB_SPEED_RESPONSE = 0.08;

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
  // 功能：动作计时独立于网络/战斗冷却，按 MDL 原始 fps 播放到结束。时间：2026-11-05；作者：lq。
  private bobPhase = 0;
  private bob = 0;
  /** 功能：保存视图用平滑速度，不改变玩家物理速度、枪械散布或脚步声。时间：2026-11-05；作者：lq。 */
  private bobSpeed = 0;
  private actionSequence = '';
  private actionElapsed = 0;
  private actionKind: 'draw' | 'shoot' | 'knife' | '' = '';
  private idleElapsed = 0;
  private shotNumber = 0;
  private flashTimer = 0;

  constructor() {
    this.camera = new THREE.PerspectiveCamera(90, 1, 0.001, 24);
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

  /** 功能：切换原版模型并启动拔枪动作，保留作者定义的眼睛坐标原点。时间：2026-11-05；作者：lq。 */
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
    this.actionKind = 'draw';
    this.actionSequence = '';
    this.actionElapsed = 0;
    this.idleElapsed = 0;
    this.flashTimer = 0;
    this.shotNumber = 0;
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
      // 功能：保留原版视点及比例，异步加载完成后从 draw 首帧开始播放，避免首次切枪丢失动画。时间：2026-11-05；作者：lq。
      this.actionKind = 'draw';
      this.actionElapsed = 0;
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

  /** 功能：每次开火重启动作，枪械后坐由原版 shoot 序列承担，镜头由 punch 承担。时间：2026-11-05；作者：lq。 */
  kick(_strength = 1, alternate = false): void {
    this.shotNumber++;
    this.actionKind = this.weaponId === 'knife' ? 'knife' : 'shoot';
    const sequence = this.studio ? studioSequence(this.studio, this.weaponId === 'knife'
      ? [alternate ? 'stab' : this.shotNumber % 2 ? 'slash1' : 'slash2']
      : this.weaponId === 'elite'
        ? [this.shotNumber % 2 ? 'shoot_left1' : 'shoot_right1']
        : ['shoot' + (1 + (this.shotNumber - 1) % 3), 'shoot', 'shoot1']) : null;
    this.actionSequence = sequence?.label ?? '';
    this.actionElapsed = 0;
    if (this.weaponId !== 'knife') {
      this.flashTimer = 0.05;
      this.muzzleFlash.visible = true;
      this.muzzleFlash.material.rotation = Math.random() * Math.PI * 2;
    }
  }

  /** 功能：阵亡观战时隐藏本地第一人称手臂和枪械。时间：2026-09-29；作者：lq。 */
  setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  /** 功能：按原版 Studio 帧率播放拔枪、击发、换弹和投掷，移除自制大幅摇摆与重复后坐力。时间：2026-11-05；作者：lq。 */
  update(dt: number, state: ViewModelState): void {
    const weapon = this.weapon;
    if (!weapon) return;
    const step = Math.max(0, dt);
    if (state.onGround && step > 0) {
      this.bobPhase += step;
      // 功能：指数响应与渲染帧率无关，停步后快速回稳；暂停和空中保持既有 bob。时间：2026-11-05；作者：lq。
      this.bobSpeed += (state.speed - this.bobSpeed) * -Math.expm1(-step / BOB_SPEED_RESPONSE);
      if (this.bobSpeed < 0.01) this.bobSpeed = 0;
      this.bob = classicBob(this.bobPhase, this.bobSpeed);
    }
    this.flashTimer = Math.max(0, this.flashTimer - step);
    this.muzzleFlash.visible = this.flashTimer > 0;
    this.muzzleFlash.material.opacity = this.flashTimer / 0.05;

    if (this.studio) {
      const active = studioSequence(this.studio, this.actionKind === 'draw'
        ? ['draw', 'deploy'] : [this.actionSequence]);
      const actionDuration = active ? (active.numFrames - 1) / Math.max(1, active.fps) : 0;
      if (this.actionElapsed >= actionDuration) this.actionKind = '';
      let sequence = active;
      let elapsed = this.actionElapsed;
      let holdLast = false;
      if (this.weaponId === 'c4' && state.bombPlantProgress > 0) {
        sequence = studioSequence(this.studio, ['pressbutton']);
        elapsed = state.bombPlantProgress * 3;
      } else if (state.grenadeAction) {
        sequence = studioSequence(this.studio, [state.grenadeAction === 'throw' ? 'throw' : 'pullpin']);
        const duration = state.grenadeAction === 'throw' ? GRENADE_THROW_TIME : GRENADE_PULLPIN_TIME;
        elapsed = Math.max(0, duration - (state.grenadeActionEndTime - state.now));
        holdLast = state.grenadeAction === 'hold';
      } else if (state.reloadProgress > 0) {
        sequence = studioSequence(this.studio, ['reload', 'insert']);
        elapsed = (1 - state.reloadProgress) * (this.weaponId && this.weaponId !== 'c4' ? reloadDuration(this.weaponId) : 1);
      } else if (!this.actionKind) {
        sequence = studioSequence(this.studio, ['idle', 'idle1', 'idle3']);
        elapsed = this.idleElapsed;
      }
      if (sequence) {
        const last = Math.max(0, sequence.numFrames - 1);
        const rawFrame = elapsed * sequence.fps;
        const idle = !this.actionKind && !state.grenadeAction && state.reloadProgress <= 0 && state.bombPlantProgress <= 0;
        const frame = holdLast ? last : idle && last > 0 && (sequence.flags & 1) ? rawFrame % last : Math.min(last, rawFrame);
        setStudioPose(this.studio, sequence.label, frame);
      }
      this.actionElapsed += step;
      this.idleElapsed += step;
      // 功能：动作每帧更新枪口挂点，泵动与拔枪时火焰始终附着枪管。时间：2026-11-05；作者：lq。
      const muzzle = studioViewMuzzlePosition(this.studio);
      if (muzzle) this.muzzle.position.copy(muzzle);
    }

    const grenade = this.weaponId === 'hegrenade' || this.weaponId === 'flashbang' || this.weaponId === 'smokegrenade';
    weapon.visible = !state.scoped && (!grenade || this.studio !== null);
    if (this.studio) {
      // 功能：仅缩小行走引起的前后位移和转角，开火 punch 与原版模型动作独立保留。时间：2026-11-05；作者：lq。
      const scale = this.studio.scale.x;
      const weaponBob = this.bob * WEAPON_BOB_SCALE;
      weapon.position.set(0, 0, -weaponBob * 0.4 * scale);
      weapon.rotation.set(
        THREE.MathUtils.degToRad(weaponBob * 0.3 + state.punch.pitch),
        THREE.MathUtils.degToRad(-weaponBob * 0.5 - state.punch.yaw),
        THREE.MathUtils.degToRad(-weaponBob),
      );
    } else {
      const pose = REST[this.weaponId ? kindOf(this.weaponId) : 'rifle'];
      weapon.position.set(pose.x, pose.y - state.deployProgress * 0.45, pose.z);
      weapon.rotation.set(pose.pitch, pose.yaw, pose.roll);
    }
    weapon.updateMatrixWorld(true);
  }

  /** 功能：相机和枪械共享原版竖直 bob，返回 GoldSrc 单位供世界镜头使用。时间：2026-11-05；作者：lq。 */
  get cameraBob(): number { return this.bob; }

  /** World-space muzzle position, for the flash and the tracer origin. */
  muzzleWorldPosition(): THREE.Vector3 {
    this.muzzle.updateMatrixWorld(true);
    return this.muzzle.getWorldPosition(new THREE.Vector3());
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.fov = verticalFovForHorizontal(90, aspect);
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
