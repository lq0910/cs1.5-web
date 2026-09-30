/**
 * 功能：绘制 CS 1.5 原版阵营人物模型；素材加载前以简化人形占位。
 * 时间：2026-09-29；作者：lq。
 */

import * as THREE from 'three';
import type { Actor } from '../../game/actors.ts';
import type { Vec3 } from '../math.ts';
import { toThree } from './boxGeometry.ts';
import { buildStudio, disposeStudio, loadStudio, setStudioPose, studioHandPosition, studioHandLocalPosition, studioMuzzleLocalPosition, studioSequenceFrames } from './studio.ts';

/** 功能：以人物和 p_ 模型的右手位置对齐第三人称枪械，保留原版 p_ 模型坐标方向。时间：2026-09-29；作者：lq。 */
export function placeWeaponAtHand(body: THREE.Group, weapon: THREE.Group, hand: THREE.Vector3): void {
  const weaponHand = studioHandLocalPosition(weapon, 'idle', 0);
  if (!weaponHand) return;
  body.updateMatrixWorld(true);
  // 功能：p_ 模型的原版转换已经把枪口轴映射到局部 +X，只需贴合右手位置，避免额外旋转造成队友枪械反向。时间：2026-09-30；作者：lq。
  weapon.rotation.set(0, 0, 0);
  weapon.position.copy(body.worldToLocal(hand.clone())).sub(weaponHand.multiplyScalar(weapon.scale.x));
}

const TEAM_COLORS: Record<string, number> = {
  ct: 0x4a7fd4,
  t: 0xd46a4a,
};

/** 功能：使用 CS 1.5 原版双方各四套人物皮肤，每名角色随机选择并在对局中保持。时间：2026-09-29；作者：lq。 */
const TEAM_SKINS = {
  ct: ['urban', 'gsg9', 'sas', 'gign'],
  t: ['terror', 'leet', 'arctic', 'guerilla'],
} as const;

/** 功能：根据当前枪械选择原版人物的对应持枪骨骼动作，避免手枪与步枪共用握姿。时间：2026-09-29；作者：lq。 */
function aimSequence(actor: Actor): string {
  const id = actor.selectedBomb ? 'c4' : actor.selectedGrenade ?? actor.combat.current().id;
  // 功能：BOT 装包时使用原版 C4 双手动作。时间：2026-09-30；作者：lq。
  if (id === 'c4') return 'c4';
  // 功能：刀具使用原版独立持刀动作，避免左手沿用手枪握姿。时间：2026-09-29；作者：lq。
  if (id === 'knife') return 'knife';
  if (id === 'hegrenade' || id === 'flashbang' || id === 'smokegrenade') return 'grenade';
  if (id === 'elite') return 'dualpistols';
  if (['glock18', 'usp45', 'p228', 'deagle', 'fiveseven'].includes(id)) return 'onehanded';
  if (id === 'm3' || id === 'xm1014') return 'shotgun';
  if (id === 'm249') return 'm249';
  if (['mac10', 'tmp', 'mp5navy', 'ump45', 'p90'].includes(id)) return 'mp5';
  // 功能：使用模型中的 AK-47 与 M4A1 专属瞄准动作；俯仰混合在采样器中处理。时间：2026-09-29；作者：lq。
  return id === 'ak47' ? 'ak47' : id === 'm4a1' ? 'carbine' : 'rifle';
}

interface ActorView {
  group: THREE.Group;
  body: THREE.Group;
  actor: Actor;
  studio: THREE.Group | null;
  weapon: THREE.Group | null;
  weaponId: string;
  weaponGeneration: number;
  lastSequence: string;
  lastFrame: number;
  lastPitch: number;
  /** 功能：记录腿部动作的步态进度和上次位置，按实际移动距离推进动画。时间：2026-09-30；作者：lq。 */
  stridePhase: number;
  lastOrigin: Vec3;
}

export class ActorRenderer {
  private readonly views = new Map<number, ActorView>();
  private readonly scene: THREE.Scene;

  /** 功能：保存世界场景以管理人物与尸体网格，兼容无头 Node 测试。时间：2026-09-29；作者：lq。 */
  constructor(scene: THREE.Scene) { this.scene = scene; }

  private build(actor: Actor): ActorView {
    const color = TEAM_COLORS[actor.team] ?? 0x888888;
    const material = new THREE.MeshLambertMaterial({ color });
    const dark = new THREE.MeshLambertMaterial({ color: 0x2a2f36 });
    const skin = new THREE.MeshLambertMaterial({ color: 0xc9a27a });

    const group = new THREE.Group();
    const body = new THREE.Group();
    group.add(body);

    // Torso, hips, legs, arms, head — roughly the player hull (32x32x72).
    const torso = new THREE.Mesh(new THREE.BoxGeometry(18, 22, 10), material);
    torso.position.y = 8;
    body.add(torso);

    const hips = new THREE.Mesh(new THREE.BoxGeometry(17, 10, 10), dark);
    hips.position.y = -6;
    body.add(hips);

    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(7, 30, 8), dark);
      leg.position.set(side * 5, -26, 0);
      body.add(leg);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(6, 24, 7), material);
      arm.position.set(side * 12, 8, -2);
      body.add(arm);
    }

    const head = new THREE.Mesh(new THREE.BoxGeometry(10, 11, 10), skin);
    head.position.y = 25;
    body.add(head);

    const view: ActorView = {
      group, body, actor, studio: null, weapon: null, weaponId: '', weaponGeneration: 0,
      lastSequence: '', lastFrame: -1, lastPitch: NaN,
      stridePhase: 0, lastOrigin: { ...actor.move.origin },
    };
    this.scene.add(group);
    // 功能：从本地原版 CS 角色模型替换临时方块，按阵营选择皮肤。时间：2026-09-29；作者：lq。
    const skins = TEAM_SKINS[actor.team];
    // 功能：由对局在各阵营四套原版模型内随机分配，避免演员编号奇偶性只出现两套皮肤。时间：2026-09-29；作者：lq。
    const skinName = skins[actor.skinIndex % skins.length]!;
    void loadStudio(`player/${skinName}/${skinName}.mdl`).then((mdl) => {
      if (!mdl || this.views.get(actor.id) !== view) return;
      const studio = buildStudio(mdl, 72, `ref_aim_${aimSequence(actor)}`);
      for (const child of [...body.children]) {
        body.remove(child);
        if (child instanceof THREE.Mesh) child.geometry.dispose();
      }
      body.add(studio);
      view.studio = studio;
      this.setWeapon(view, actor);
    });
    return view;
  }

  /** 功能：给人物装配本地原版第三人称武器模型，并随切枪更新。时间：2026-09-29；作者：lq。 */
  private setWeapon(view: ActorView, actor: Actor): void {
    // 功能：装包中的 BOT 第三人称显示原版 p_c4 模型。时间：2026-09-30；作者：lq。
    const id = actor.selectedBomb ? 'c4' : actor.selectedGrenade ?? actor.combat.loadout[actor.combat.activeSlot].id;
    if (view.weaponId === id || !view.studio) return;
    view.weaponId = id;
    const generation = ++view.weaponGeneration;
    if (view.weapon) {
      view.weapon.parent?.remove(view.weapon);
      disposeStudio(view.weapon);
      view.weapon = null;
    }
    const name = id === 'usp45' ? 'usp' : id === 'mp5navy' ? 'mp5' : id;
    void loadStudio(`p_${name}.mdl`).then((mdl) => {
      if (!mdl || this.views.get(actor.id) !== view || view.weaponGeneration !== generation) return;
      const weapon = buildStudio(mdl, undefined, 'idle', view.studio!.scale.x);
      // 功能：p_ 模型与人物 MDL 使用相同 GoldSrc 轴向，保持原始旋转避免枪口朝向和手部错位。时间：2026-09-29；作者：lq。
      weapon.rotation.set(0, 0, 0);
      // 功能：原版 p_ 武器中心将在更新帧时挂到人物右手骨骼，避免悬在身体旁。时间：2026-09-29；作者：lq。
      weapon.position.set(0, 0, 0);
      // 功能：把 p_ 武器作为人物模型子节点挂接，继承原版人物的缩放、朝向和骨骼局部坐标。时间：2026-09-29；作者：lq。
      view.body.add(weapon);
      view.weapon = weapon;
      // 功能：异步加载的枪械即使人物静止也立刻对齐右手，避免停留在身体原点。时间：2026-09-29；作者：lq。
      const moving = view.lastSequence === 'run' || view.lastSequence === 'walk' || view.lastSequence === 'crouchrun';
      const handSequence = moving
        ? `${view.lastSequence === 'crouchrun' ? 'crouch' : 'ref'}_aim_${aimSequence(actor)}`
        : view.lastSequence || 'ref_aim_carbine';
      const hand = view.studio ? studioHandPosition(view.studio, handSequence, moving ? 0 : Math.max(0, view.lastFrame), actor.pitch) : null;
      if (hand) placeWeaponAtHand(view.body, weapon, hand);
    });
  }

  /** Syncs every actor's mesh; creates and destroys views as needed. */
  update(actors: Actor[], localActor?: Actor | null, now = performance.now() / 1000): void {
    const seen = new Set<number>();
    for (const actor of actors) {
      // 功能：本地玩家使用第一人称视角与武器，完全不创建自己的第三人称皮肤，避免摄像机钻进模型。时间：2026-09-29；作者：lq。
      if (actor === localActor) continue;
      seen.add(actor.id);
      let view = this.views.get(actor.id);
      if (!view) {
        view = this.build(actor);
        this.views.set(actor.id, view);
      }

      const [x, y, z] = toThree(actor.move.origin.x, actor.move.origin.y, actor.move.origin.z);
      // 功能：用水平位移驱动原版腿部序列；出生传送或复活时重置，避免动作突然跳帧。时间：2026-09-30；作者：lq。
      const distanceMoved = Math.hypot(actor.move.origin.x - view.lastOrigin.x, actor.move.origin.y - view.lastOrigin.y);
      view.lastOrigin = { ...actor.move.origin };
      // 功能：人物网格在 buildStudio 中已按 72 单位身高居中，直接对齐碰撞盒中心，避免人物埋入地面、准星与命中盒错位。时间：2026-09-29；作者：lq。
      view.group.position.set(x, y, z);
      // 功能：GoldSrc 模型的 +X 是正前方；地图转为 Three.js 后 yaw 正角直接绕 Y 轴旋转。时间：2026-09-29；作者：lq。
      view.group.rotation.y = (actor.yaw * Math.PI) / 180;
      // 功能：队友与玩家距离过近时隐藏其第三人称网格，避免多人重叠把第一人称镜头塞进皮肤内部。时间：2026-09-29；作者：lq。
      const cameraInsideActor = actor.alive && localActor && Math.hypot(
        actor.move.origin.x - localActor.move.origin.x,
        actor.move.origin.y - localActor.move.origin.y,
      ) < 18 && Math.abs(actor.move.origin.z - localActor.move.origin.z) < 48;
      // 功能：阵亡角色不再直接隐藏，尸体留在死亡位置直到新回合复活。时间：2026-09-29；作者：lq。
      view.group.visible = !cameraInsideActor;
      if (view.weapon) view.weapon.visible = actor.alive;

      if (view.studio && actor.alive) {
        this.setWeapon(view, actor);
        // 功能：根据移动和蹲伏状态播放原版人物动作，避免 BOT 以固定姿势滑行。时间：2026-09-29；作者：lq。
        const speed = Math.hypot(actor.move.velocity.x, actor.move.velocity.y);
        const aim = aimSequence(actor);
        // 功能：只有达到未限速的奔跑速度才播放 run；BOT 的 IN_WALK 约 135u/s 对应原版 walk，避免滑步。时间：2026-09-30；作者：lq。
        const sequence = actor.move.ducked
          ? (speed > 18 ? 'crouchrun' : `crouch_aim_${aim}`)
          : (speed > 190 ? 'run' : speed > 18 ? 'walk' : `ref_aim_${aim}`);
        const moving = sequence === 'run' || sequence === 'walk' || sequence === 'crouchrun';
        const frames = moving ? studioSequenceFrames(view.studio, sequence) : 1;
        const strideLength = sequence === 'run' ? 155 : sequence === 'crouchrun' ? 70 : 130;
        if (moving && actor.move.onground && distanceMoved < 80) {
          view.stridePhase = (view.stridePhase + distanceMoved / strideLength) % 1;
        } else if (distanceMoved >= 80) {
          view.stridePhase = 0;
        }
        const frame = moving ? Math.floor(view.stridePhase * Math.max(1, frames - 1)) : 0;
        if (view.lastSequence !== sequence || view.lastFrame !== frame || Math.abs(view.lastPitch - actor.pitch) > 0.5) {
          const upperSequence = sequence === 'run' || sequence === 'walk'
            ? `ref_aim_${aim}`
            : sequence === 'crouchrun' ? `crouch_aim_${aim}` : undefined;
          setStudioPose(view.studio, sequence, frame, upperSequence, actor.pitch);
          // 功能：使用原版骨骼动画每帧更新枪械挂点，跑动、蹲伏时也随手移动。时间：2026-09-29；作者：lq。
          if (view.weapon) {
            const hand = studioHandPosition(view.studio, upperSequence ?? sequence, upperSequence ? 0 : frame, actor.pitch);
            if (hand) placeWeaponAtHand(view.body, view.weapon, hand);
          }
          view.lastSequence = sequence;
          view.lastFrame = frame;
          view.lastPitch = actor.pitch;
        }
      }

      if (!actor.alive) {
        // 功能：按死亡时间播放原版 death/crouch_die 骨骼动作，末帧保持为地面尸体。时间：2026-09-29；作者：lq。
        if (view.studio) {
          const deathSequence = actor.move.ducked ? 'crouch_die' : actor.id % 2 === 0 ? 'death1' : 'death2';
          const frames = studioSequenceFrames(view.studio, deathSequence);
          const elapsed = actor.diedAt >= 0 ? Math.max(0, now - actor.diedAt) : 10;
          const frame = Math.min(frames - 1, Math.floor(elapsed * 30));
          if (view.lastSequence !== deathSequence || view.lastFrame !== frame) {
            setStudioPose(view.studio, deathSequence, frame);
            view.lastSequence = deathSequence;
            view.lastFrame = frame;
          }
          view.body.rotation.x = 0;
          view.body.position.y = 0;
        } else {
          // 功能：原版模型尚未加载时也保留贴地的临时尸体，避免人物突然消失。时间：2026-09-29；作者：lq。
          view.body.rotation.x = -Math.PI / 2;
          view.body.position.y = -28;
        }
      } else {
        // 功能：人物俯仰由原版 ref_aim/crouch_aim 上身序列表达，身体根节点保持竖直避免姿势翻折。时间：2026-09-29；作者：lq。
        view.body.rotation.x = 0;
        view.body.position.y = 0;
      }
    }

    for (const [id, view] of [...this.views]) {
      if (seen.has(id)) continue;
      this.scene.remove(view.group);
      if (view.studio) disposeStudio(view.studio);
      if (view.weapon) disposeStudio(view.weapon);
      this.views.delete(id);
    }
  }

  /** 功能：取得 BOT 可见枪管最前端的世界坐标，供枪口火焰和弹道使用。时间：2026-09-29；作者：lq。 */
  muzzlePosition(actor: Actor): Vec3 | null {
    const weapon = this.views.get(actor.id)?.weapon;
    if (!weapon) return null;
    const tip = studioMuzzleLocalPosition(weapon);
    if (!tip) return null;
    const world = weapon.localToWorld(tip);
    return { x: world.x, y: -world.z, z: world.y };
  }

  dispose(): void {
    for (const view of this.views.values()) {
      this.scene.remove(view.group);
      if (view.studio) disposeStudio(view.studio);
      if (view.weapon) disposeStudio(view.weapon);
    }
    this.views.clear();
  }
}
