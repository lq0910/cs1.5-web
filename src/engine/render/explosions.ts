/** 功能：按 CS Explode3 / Smoke3_C 分阶段播放原版火球与延迟烟尘；缺少 SPR 时使用程序回退。时间：2026-11-05；作者：lq。 */
import * as THREE from 'three';
import { parseSprite } from '../sprite/parser.ts';
import type { Vec3 } from '../math.ts';
import { toThree } from './boxGeometry.ts';

type Kind = 'hegrenade' | 'flashbang' | 'smokegrenade';
type AssetName = 'fexplo' | 'eexplo' | 'steam1';
interface SpriteAsset { frames: THREE.Texture[]; widths: number[]; heights: number[]; centers: THREE.Vector2[] }
interface Burst { sprite: THREE.Sprite; asset: AssetName; elapsed: number; delay: number; fps: number; scale: number; opacity: number; velocity: THREE.Vector3 }
export interface ExplosionStage { asset: AssetName; delay: number; fps: number; scale: number }

/** 功能：HE 两团火球使用 30fps，0.55 秒后出现 5fps 烟雾；闪光弹无橙色爆炸。时间：2026-11-05；作者：lq。 */
export function explosionStages(kind: Kind): ExplosionStage[] {
  if (kind === 'hegrenade') return [
    { asset: 'fexplo', delay: 0, fps: 30, scale: 2.5 },
    { asset: 'eexplo', delay: 0, fps: 30, scale: 3 },
    { asset: 'steam1', delay: 0.55, fps: 5, scale: 3.5 },
  ];
  if (kind === 'flashbang') return [{ asset: 'steam1', delay: 0.3, fps: 6, scale: 2.5 }];
  return [{ asset: 'steam1', delay: 0, fps: 5, scale: 3.5 }];
}

/** 功能：没有本地原版 SPR 时生成多瓣火球/烟团，保持完整时长而不伪称为原版素材。时间：2026-11-05；作者：lq。 */
function fallbackAsset(smoke: boolean): SpriteAsset {
  const frames: THREE.Texture[] = [];
  for (let frame = 0; frame < 24; frame++) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const context = canvas.getContext('2d')!;
    const t = frame / 23;
    for (let lobe = 0; lobe < 11; lobe++) {
      const angle = lobe * 2.399;
      const spread = 8 + t * 20;
      const x = 64 + Math.cos(angle) * spread;
      const y = 70 + Math.sin(angle) * spread - t * 12;
      const radius = 14 + t * 19 + lobe % 3 * 3;
      const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, smoke ? 'rgba(165,160,149,.38)' : `rgba(255,${Math.round(230 - t * 160)},55,${0.9 - t * 0.7})`);
      gradient.addColorStop(0.5, smoke ? 'rgba(118,117,111,.24)' : `rgba(210,${Math.round(95 - t * 60)},15,${0.6 - t * 0.5})`);
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      context.fillStyle = gradient;
      context.fillRect(0, 0, 128, 128);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    frames.push(texture);
  }
  return { frames, widths: Array(24).fill(64), heights: Array(24).fill(64), centers: Array.from({ length: 24 }, () => new THREE.Vector2(0.5, 0.5)) };
}

export class GrenadeEffects {
  private readonly assets = new Map<AssetName, SpriteAsset>();
  private readonly bursts: Burst[] = [];
  private readonly lights: { light: THREE.PointLight; elapsed: number }[] = [];

  /** 功能：从用户本地素材读取 SPR，不下载或内置原版资源。时间：2026-11-05；作者：lq。 */
  private readonly scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    const smoke = fallbackAsset(true);
    const fire = fallbackAsset(false);
    this.assets.set('steam1', smoke);
    this.assets.set('fexplo', fire);
    this.assets.set('eexplo', fire);
    for (const name of ['fexplo', 'eexplo', 'steam1'] as const) void this.load(name);
  }

  /** 功能：解析原版精灵帧尺寸、原点与透明度，加载失败保留回退。时间：2026-11-05；作者：lq。 */
  private async load(name: AssetName): Promise<void> {
    try {
      const response = await fetch(`cstrike/sprites/${name}.spr`);
      if (!response.ok) return;
      const parsed = parseSprite(new Uint8Array(await response.arrayBuffer()));
      const asset: SpriteAsset = { frames: [], widths: [], heights: [], centers: [] };
      for (const frame of parsed.frames) {
        const texture = new THREE.DataTexture(frame.rgba, frame.width, frame.height, THREE.RGBAFormat);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.flipY = true;
        texture.magFilter = texture.minFilter = THREE.LinearFilter;
        texture.needsUpdate = true;
        asset.frames.push(texture);
        asset.widths.push(frame.width);
        asset.heights.push(frame.height);
        asset.centers.push(new THREE.Vector2(-frame.originX / frame.width, 1 - frame.originY / frame.height));
      }
      this.assets.set(name, asset);
    } catch { /* 功能：缺失、损坏或分组 SPR 不影响投掷和伤害。时间：2026-11-05；作者：lq。 */ }
  }

  /** 功能：独立管理爆炸效果，避免连续射击的 32 槽灰尘池覆盖正在升起的烟雾。时间：2026-11-05；作者：lq。 */
  add(point: Vec3, kind: Kind): void {
    const position = new THREE.Vector3(...toThree(point.x, point.y, point.z));
    const stages = explosionStages(kind);
    if (kind === 'smokegrenade') {
      // 功能：烟雾弹持续喷出多批普通混合烟团，形成约 18 秒可见烟区。时间：2026-11-05；作者：lq。
      for (let batch = 0; batch < 7; batch++) for (let puff = 0; puff < 5; puff++) {
        stages.push({ asset: 'steam1', delay: batch * 2, fps: 5, scale: 2.5 });
      }
    }
    for (const [index, stage] of stages.entries()) {
      // 功能：限制可见精灵总数，连续投雷时只淘汰最旧效果。时间：2026-11-05；作者：lq。
      if (this.bursts.length >= 160) this.remove(this.bursts.shift()!);
      const material = new THREE.SpriteMaterial({ transparent: true, depthWrite: false,
        blending: stage.asset === 'steam1' ? THREE.NormalBlending : THREE.AdditiveBlending });
      const sprite = new THREE.Sprite(material);
      sprite.position.copy(position);
      sprite.visible = false;
      if (stage.asset !== 'steam1') sprite.position.y += index === 0 ? 20 : 32;
      if (index === 1 && kind === 'hegrenade') { sprite.position.x += 38; sprite.position.z -= 28; }
      if (kind === 'smokegrenade') {
        const angle = index * 2.399;
        sprite.position.x += Math.cos(angle) * (index % 5) * 15;
        sprite.position.z += Math.sin(angle) * (index % 5) * 15;
      }
      this.scene.add(sprite);
      this.bursts.push({ sprite, ...stage, elapsed: 0,
        opacity: kind === 'flashbang' ? 0.35 : 0.85, velocity: new THREE.Vector3(0, stage.asset === 'steam1' ? 10 : 0, 0) });
    }
    if (kind === 'hegrenade') {
      const light = new THREE.PointLight(0xffbd69, 6, 500, 1.4);
      light.position.copy(position).y += 24;
      this.scene.add(light);
      this.lights.push({ light, elapsed: 0 });
    }
  }

  /** 功能：按原版帧率播放火球、延迟启动烟雾，尾段平滑消散并释放材质。时间：2026-11-05；作者：lq。 */
  update(dt: number): void {
    for (let index = this.bursts.length - 1; index >= 0; index--) {
      const burst = this.bursts[index]!;
      const previousAge = Math.max(0, burst.elapsed - burst.delay);
      burst.elapsed += Math.max(0, dt);
      const age = burst.elapsed - burst.delay;
      if (age < 0) continue;
      const asset = this.assets.get(burst.asset)!;
      const life = asset.frames.length / burst.fps;
      if (age >= life) { this.remove(burst); this.bursts.splice(index, 1); continue; }
      const frame = Math.min(asset.frames.length - 1, Math.floor(age * burst.fps));
      burst.sprite.visible = true;
      burst.sprite.material.map = asset.frames[frame]!;
      burst.sprite.material.opacity = burst.opacity * (burst.asset === 'steam1' ? Math.min(1, age * 4) * Math.min(1, (life - age) / 1.2) : 1);
      burst.sprite.scale.set(asset.widths[frame]! * burst.scale, asset.heights[frame]! * burst.scale, 1);
      burst.sprite.center.copy(asset.centers[frame]!);
      burst.sprite.position.addScaledVector(burst.velocity, age - previousAge);
    }
    for (let index = this.lights.length - 1; index >= 0; index--) {
      const entry = this.lights[index]!;
      entry.elapsed += Math.max(0, dt);
      entry.light.intensity = 6 * Math.max(0, 1 - entry.elapsed / 0.3);
      if (entry.elapsed >= 0.3) { this.scene.remove(entry.light); entry.light.dispose(); this.lights.splice(index, 1); }
    }
  }

  /** 功能：释放过期精灵的独立材质，共享帧贴图继续复用。时间：2026-11-05；作者：lq。 */
  private remove(burst: Burst): void { this.scene.remove(burst.sprite); burst.sprite.material.dispose(); }
}
