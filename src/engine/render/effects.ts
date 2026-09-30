/**
 * Combat visual effects: bullet decals, tracers, impact puffs, muzzle flash.
 *
 * Everything is pooled and preallocated so firing never allocates during play.
 * Positions arrive in GoldSrc Z-up space and are converted here, like the rest
 * of the renderer.
 */

import * as THREE from 'three';
import type { Vec3 } from '../math.ts';
import { toThree } from './boxGeometry.ts';
import { makeMuzzleTexture } from './muzzle.ts';

const DECAL_POOL = 96;
const TRACER_POOL = 32;
const PUFF_POOL = 32;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A dark, irregular bullet hole with a lighter ring. */
function makeDecalTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);

  const rand = mulberry32(0xdecaf);
  // Soft scorch ring.
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(12,10,8,0.95)');
  gradient.addColorStop(0.45, 'rgba(30,26,22,0.75)');
  gradient.addColorStop(0.75, 'rgba(60,55,48,0.35)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  // Ragged edge.
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 26; i++) {
    const angle = rand() * Math.PI * 2;
    const radius = size * (0.34 + rand() * 0.14);
    ctx.beginPath();
    ctx.arc(size / 2 + Math.cos(angle) * radius, size / 2 + Math.sin(angle) * radius, 1 + rand() * 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** A soft round puff, used for dust sparks off walls. */
function makePuffTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,244,214,0.95)');
  gradient.addColorStop(0.35, 'rgba(226,206,160,0.55)');
  gradient.addColorStop(1, 'rgba(180,168,140,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

interface Decal {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
}

interface Puff {
  sprite: THREE.Sprite;
  life: number;
  maxLife: number;
  velocity: THREE.Vector3;
  startSize: number;
  endSize: number;
}

interface Tracer {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
}

export class Effects {
  private readonly decals: Decal[] = [];
  private readonly puffs: Puff[] = [];
  private readonly tracers: Tracer[] = [];
  private decalCursor = 0;
  private puffCursor = 0;
  private tracerCursor = 0;
  private readonly rand = mulberry32(0xbeef);

  private readonly decalGeometry = new THREE.PlaneGeometry(1, 1);
  private readonly decalMaterial: THREE.MeshBasicMaterial;
  private readonly tracerGeometry: THREE.PlaneGeometry;
  private readonly flash: THREE.Sprite;
  private readonly flashLight: THREE.PointLight;
  private flashLife = 0;
  // 功能：火焰闪光按效果自身时长衰减，避免 C4 爆炸沿用短枪口焰的固定 0.06 秒曲线。时间：2026-09-30；作者：lq。
  private flashDuration = 0.06;
  private flashIntensity = 2.4;

  constructor(scene: THREE.Scene) {
    this.decalMaterial = new THREE.MeshBasicMaterial({
      map: makeDecalTexture(),
      transparent: true,
      depthWrite: false,
      opacity: 1,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });

    for (let i = 0; i < DECAL_POOL; i++) {
      const mesh = new THREE.Mesh(this.decalGeometry, this.decalMaterial);
      mesh.visible = false;
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.decals.push({ mesh, life: 0, maxLife: 12 });
    }

    // Tracers: a thin quad stretched from the muzzle to the impact point.
    this.tracerGeometry = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < TRACER_POOL; i++) {
      const mesh = new THREE.Mesh(
        this.tracerGeometry,
        new THREE.MeshBasicMaterial({
          color: 0xffe9a8,
          transparent: true,
          opacity: 0.75,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        }),
      );
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.tracers.push({ mesh, life: 0, maxLife: 0.06 });
    }

    const puffTexture = makePuffTexture();
    for (let i = 0; i < PUFF_POOL; i++) {
      const material = new THREE.SpriteMaterial({
        map: puffTexture,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const sprite = new THREE.Sprite(material);
      sprite.visible = false;
      scene.add(sprite);
      this.puffs.push({ sprite, life: 0, maxLife: 0.22, velocity: new THREE.Vector3(), startSize: 1.2, endSize: 4.4 });
    }

    // Muzzle flash: an additive sprite plus a short-lived light.
    this.flash = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeMuzzleTexture(),
        color: 0xffffff,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.flash.visible = false;
    this.flash.frustumCulled = false;
    scene.add(this.flash);

    this.flashLight = new THREE.PointLight(0xffcf8a, 0, 420, 1.4);
    scene.add(this.flashLight);
  }

  /** Bullet hole + dust puff at an impact. */
  addImpact(point: Vec3, normal: Vec3, scale = 1): void {
    const decal = this.decals[this.decalCursor % DECAL_POOL]!;
    this.decalCursor++;

    const [x, y, z] = toThree(point.x, point.y, point.z);
    const [nx, ny, nz] = toThree(normal.x, normal.y, normal.z);
    const n = new THREE.Vector3(nx, ny, nz).normalize();

    decal.mesh.position.set(x + n.x * 0.12, y + n.y * 0.12, z + n.z * 0.12);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    const roll = new THREE.Quaternion().setFromAxisAngle(n, this.rand() * Math.PI * 2);
    decal.mesh.quaternion.copy(roll.multiply(quaternion));
    const size = (4.5 + this.rand() * 2.5) * scale;
    decal.mesh.scale.set(size, size, size);
    decal.mesh.visible = true;
    decal.life = decal.maxLife;
    decal.mesh.updateMatrix();

    // A couple of dust particles.
    for (let i = 0; i < 3; i++) {
      const puff = this.puffs[this.puffCursor % PUFF_POOL]!;
      this.puffCursor++;
      // 功能：复用血效粒子槽时恢复墙体灰尘的颜色和寿命。时间：2026-09-29；作者：lq。
      puff.maxLife = 0.22;
      puff.startSize = 1.2;
      puff.endSize = 4.4;
      (puff.sprite.material as THREE.SpriteMaterial).color.setHex(0xffffff);
      (puff.sprite.material as THREE.SpriteMaterial).blending = THREE.AdditiveBlending;
      puff.sprite.position.set(
        x + n.x * 0.5 + (this.rand() - 0.5) * 3,
        y + n.y * 0.5 + (this.rand() - 0.5) * 3,
        z + n.z * 0.5 + (this.rand() - 0.5) * 3,
      );
      puff.velocity.set(
        n.x * 26 + (this.rand() - 0.5) * 34,
        n.y * 26 + (this.rand() - 0.5) * 34,
        n.z * 26 + (this.rand() - 0.5) * 34 + 18,
      );
      const start = 1.2 + this.rand() * 1.4;
      puff.sprite.scale.setScalar(start);
      puff.sprite.visible = true;
      puff.life = puff.maxLife;
    }
  }

  /** 功能：人物受弹时喷出短暂红色粒子，明确区分人体命中与墙体弹痕。时间：2026-09-29；作者：lq。 */
  addBlood(point: Vec3): void {
    const [x, y, z] = toThree(point.x, point.y, point.z);
    for (let i = 0; i < 7; i++) {
      const puff = this.puffs[this.puffCursor % PUFF_POOL]!;
      this.puffCursor++;
      puff.sprite.position.set(x, y, z);
      puff.velocity.set((this.rand() - 0.5) * 95, this.rand() * 50, (this.rand() - 0.5) * 95);
      puff.maxLife = 0.32;
      puff.startSize = 3;
      puff.endSize = 9;
      puff.life = puff.maxLife;
      puff.sprite.scale.setScalar(3 + this.rand() * 3);
      const material = puff.sprite.material as THREE.SpriteMaterial;
      material.color.setHex(0xd8271b);
      material.blending = THREE.AdditiveBlending;
      material.opacity = 0.95;
      puff.sprite.visible = true;
    }
  }

  /** 功能：高爆弹、烟雾弹引爆时生成对应颜色与持续时间的原版风格粒子。时间：2026-09-29；作者：lq。 */
  addGrenadeBurst(point: Vec3, kind: 'hegrenade' | 'smokegrenade' | 'flashbang'): void {
    const [x, y, z] = toThree(point.x, point.y, point.z);
    const smoke = kind === 'smokegrenade';
    const flash = kind === 'flashbang';
    for (let i = 0; i < (smoke ? 18 : 14); i++) {
      const puff = this.puffs[this.puffCursor % PUFF_POOL]!;
      this.puffCursor++;
      puff.sprite.position.set(x, y, z);
      puff.velocity.set((this.rand() - 0.5) * (smoke ? 24 : 180), this.rand() * (smoke ? 22 : 125), (this.rand() - 0.5) * (smoke ? 24 : 180));
      puff.maxLife = smoke ? 7 : flash ? 0.24 : 0.7;
      puff.life = puff.maxLife;
      puff.startSize = smoke ? 20 : flash ? 5 : 7;
      puff.endSize = smoke ? 100 : flash ? 22 : 34;
      const material = puff.sprite.material as THREE.SpriteMaterial;
      material.color.setHex(smoke ? 0x9c9b91 : flash ? 0xffffff : 0xffb657);
      material.blending = smoke ? THREE.NormalBlending : THREE.AdditiveBlending;
      material.opacity = smoke ? 0.55 : 0.95;
      puff.sprite.visible = true;
    }
  }

  /** 功能：C4 爆炸产生大范围橙色火光、烟尘和短暂点光，匹配原版终局反馈。时间：2026-09-30；作者：lq。 */
  addBombExplosion(point: Vec3): void {
    this.addGrenadeBurst(point, 'hegrenade');
    const [x, y, z] = toThree(point.x, point.y, point.z);
    // 功能：爆炸先闪出火焰，再向四周扩散深色烟尘。时间：2026-09-30；作者：lq。
    for (let i = 0; i < 18; i++) {
      const puff = this.puffs[this.puffCursor % PUFF_POOL]!;
      this.puffCursor++;
      puff.sprite.position.set(x, y, z);
      puff.velocity.set((this.rand() - 0.5) * 260, 35 + this.rand() * 145, (this.rand() - 0.5) * 260);
      puff.maxLife = 1.8 + this.rand() * 0.7;
      puff.life = puff.maxLife;
      puff.startSize = 30;
      puff.endSize = 180;
      puff.sprite.scale.setScalar(puff.startSize);
      const material = puff.sprite.material as THREE.SpriteMaterial;
      material.color.setHex(i % 3 === 0 ? 0x775f45 : 0x62605a);
      material.blending = THREE.NormalBlending;
      material.opacity = 0.8;
      puff.sprite.visible = true;
    }
    this.flash.position.set(x, y, z);
    this.flash.scale.setScalar(44);
    (this.flash.material as THREE.SpriteMaterial).opacity = 1;
    this.flash.visible = true;
    this.flashLife = 0.32;
    this.flashDuration = 0.32;
    this.flashIntensity = 12;
    this.flashLight.position.set(x, y, z);
    this.flashLight.intensity = 12;
    this.flashLight.distance = 1500;
  }

  /** A tracer line from the muzzle to the impact point. */
  addTracer(from: Vec3, to: Vec3): void {
    const tracer = this.tracers[this.tracerCursor % TRACER_POOL]!;
    this.tracerCursor++;

    const [ax, ay, az] = toThree(from.x, from.y, from.z);
    const [bx, by, bz] = toThree(to.x, to.y, to.z);
    const start = new THREE.Vector3(ax, ay, az);
    const end = new THREE.Vector3(bx, by, bz);
    const direction = end.clone().sub(start);
    const length = direction.length();
    if (length < 1) return;

    tracer.mesh.position.copy(start.clone().add(end).multiplyScalar(0.5));
    // The quad is 1x1 with +Y as its length axis after this rotation.
    tracer.mesh.scale.set(0.55, length, 1);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      direction.clone().normalize(),
    );
    tracer.mesh.quaternion.copy(quaternion);
    tracer.mesh.visible = true;
    tracer.life = tracer.maxLife;
    tracer.mesh.updateMatrix();
  }

  /** Muzzle flash at a world-space position, oriented along the shot. */
  addMuzzleFlash(position: Vec3, direction: Vec3): void {
    const [x, y, z] = toThree(position.x, position.y, position.z);
    this.flash.position.set(x, y, z);
    // 功能：枪口焰保持在枪管附近的小尺寸，避免原先圆形光团遮挡人物。时间：2026-09-29；作者：lq。
    this.flash.scale.setScalar(9 + this.rand() * 5);
    this.flash.material.rotation = this.rand() * Math.PI * 2;
    (this.flash.material as THREE.SpriteMaterial).opacity = 0.9;
    this.flash.visible = true;
    this.flashLife = 0.06;
    this.flashDuration = 0.06;
    this.flashIntensity = 2.4;

    this.flashLight.position.set(x, y, z);
    this.flashLight.intensity = 2.4;
    this.flashLight.distance = 420;
    void direction;
  }

  update(dt: number): void {
    for (const decal of this.decals) {
      if (decal.life <= 0) continue;
      decal.life -= dt;
      if (decal.life <= 0) {
        decal.mesh.visible = false;
        continue;
      }
      decal.mesh.visible = true;
    }

    for (const puff of this.puffs) {
      if (puff.life <= 0) continue;
      puff.life -= dt;
      if (puff.life <= 0) {
        puff.sprite.visible = false;
        continue;
      }
      const t = 1 - puff.life / puff.maxLife;
      puff.sprite.position.addScaledVector(puff.velocity, dt);
      // Each sprite owns its material, so per-particle opacity works.
      (puff.sprite.material as THREE.SpriteMaterial).opacity = Math.max(0, 1 - t);
      puff.sprite.scale.setScalar(puff.startSize + t * (puff.endSize - puff.startSize));
    }

    for (const tracer of this.tracers) {
      if (tracer.life <= 0) continue;
      tracer.life -= dt;
      if (tracer.life <= 0) {
        tracer.mesh.visible = false;
        continue;
      }
      const material = tracer.mesh.material as THREE.MeshBasicMaterial;
      material.opacity = Math.max(0, (tracer.life / tracer.maxLife) * 0.75);
    }

    if (this.flashLife > 0) {
      this.flashLife -= dt;
      (this.flash.material as THREE.SpriteMaterial).opacity = Math.max(0, this.flashLife / this.flashDuration);
      this.flashLight.intensity = Math.max(0, (this.flashLife / this.flashDuration) * this.flashIntensity);
      if (this.flashLife <= 0) {
        this.flash.visible = false;
        this.flashLight.intensity = 0;
      }
    }
  }
}
