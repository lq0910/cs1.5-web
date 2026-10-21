/** 功能：在 Dust2 匪家坡道长墙挂载 CCTV13 直播屏，免登录静音自动播放。时间：2026-10-21；作者：lq。 */
import * as THREE from 'three';
import type Hls from 'hls.js';
import type { BspFile } from '../bsp/types.ts';
import type { ScreenPlacement } from './newsScreen.ts';
import { toThree } from './boxGeometry.ts';

/** 功能：采用已验证清单、分片、跨域与真实画面的公开转播地址；不保存会过期的 CDN 子地址。时间：2026-10-21；作者：lq。 */
export const CCTV13_URL = 'https://play.kankanlive.com/live/1698423543275916.m3u8';

/** 功能：核对 Dust2 匪家南侧长墙，16:9 屏幕置于坡道上方、墙顶装饰线下方。时间：2026-10-21；作者：lq。 */
export function findTSpawnScreenWall(bsp: BspFile): ScreenPlacement | null {
  const exists = bsp.faces.some((face) => {
    const plane = bsp.planes[face.planenum];
    const texture = bsp.miptex[bsp.texinfo[face.texinfo]!.miptex]?.name ?? '';
    return plane?.normal.y === 1 && plane.dist === -1024 && face.side === 0 && /sand/i.test(texture);
  });
  return exists ? { position: { x: -640, y: -1024, z: 232 }, normal: { x: 0, y: 1, z: 0 }, width: 256, height: 144 } : null;
}

/** 功能：在世界场景中绘制真实视频帧，保留墙体遮挡；连接失败与重试状态明确显示。时间：2026-10-21；作者：lq。 */
export class LiveScreen {
  readonly object = new THREE.Group();
  private readonly video = document.createElement('video');
  private readonly canvas = document.createElement('canvas');
  private readonly context: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private hls: Hls | null = null;
  private disposed = false;
  private connecting = false;
  private retryAt = 0;
  private lastDraw = -Infinity;
  private lastProgressAt = performance.now() / 1000;
  private lastVideoTime = -1;
  private readonly url: string;
  private status = '正在连接直播…';

  /** 功能：创建屏幕外框与画布，静音自动播放兼容 Chrome HLS.js 和 Safari 原生 HLS。时间：2026-10-21；作者：lq。 */
  constructor(scene: THREE.Scene, placement: ScreenPlacement, url = CCTV13_URL) {
    this.url = url;
    this.canvas.width = 960;
    this.canvas.height = 540;
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('Live screen canvas unavailable');
    this.context = context;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    const normal = new THREE.Vector3(...toThree(placement.normal.x, placement.normal.y, placement.normal.z)).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(up, normal).normalize();
    this.object.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, normal));
    this.object.position.set(...toThree(placement.position.x, placement.position.y, placement.position.z)).addScaledVector(normal, 1);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(placement.width + 10, placement.height + 10, 6), new THREE.MeshBasicMaterial({ color: 0x171a1f }));
    frame.position.z = 3;
    const display = new THREE.Mesh(new THREE.PlaneGeometry(placement.width, placement.height), new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false }));
    display.position.z = 6.1;
    this.object.add(frame, display);
    scene.add(this.object);
    this.video.crossOrigin = 'anonymous';
    this.video.muted = true;
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.preload = 'auto';
    this.video.setAttribute('aria-label', 'CCTV13 新闻直播');
    this.video.addEventListener('error', this.fail);
    document.addEventListener('pointerdown', this.resume);
    this.draw(false);
    void this.connect();
  }

  /** 功能：复用玩家进入游戏的操作恢复被浏览器阻止的播放，无需额外点击电视。时间：2026-10-21；作者：lq。 */
  private readonly resume = (): void => {
    if (!this.disposed) void this.video.play().catch(() => { /* 功能：保持静音并等待下一次游戏操作。时间：2026-10-21；作者：lq。 */ });
  };

  /** 功能：失败后释放流连接，十秒后重新获取入口清单，不循环请求过期分片。时间：2026-10-21；作者：lq。 */
  private readonly fail = (): void => {
    if (this.disposed || this.retryAt) return;
    this.status = '直播连接暂不可用 · 自动重试中';
    this.retryAt = performance.now() / 1000 + 10;
    this.hls?.destroy();
    this.hls = null;
    this.video.pause();
  };

  /** 功能：按需加载 HLS 播放库，限定缓冲避免长时间游戏积累视频内存。时间：2026-10-21；作者：lq。 */
  private async connect(): Promise<void> {
    if (this.disposed || this.connecting) return;
    this.connecting = true;
    this.retryAt = 0;
    this.status = '正在连接直播…';
    this.lastProgressAt = performance.now() / 1000;
    try {
      if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
        this.video.src = this.url;
      } else {
        const { default: HlsPlayer } = await import('hls.js');
        if (this.disposed) return;
        if (!HlsPlayer.isSupported()) { this.status = '当前浏览器不支持 HLS 直播'; return; }
        this.hls = new HlsPlayer({ maxBufferLength: 10, backBufferLength: 0, capLevelToPlayerSize: true });
        this.hls.on(HlsPlayer.Events.ERROR, (_event, data) => { if (data.fatal) this.fail(); });
        this.hls.loadSource(this.url);
        this.hls.attachMedia(this.video);
      }
      this.resume();
    } catch { this.fail(); }
    finally { this.connecting = false; }
  }

  /** 功能：真实时间推进直播、二十秒停帧自动重连，画布最多每秒十五帧更新。时间：2026-10-21；作者：lq。 */
  update(now: number): void {
    if (this.disposed) return;
    if (this.retryAt && now >= this.retryAt) void this.connect();
    if (this.video.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = this.video.currentTime;
      this.lastProgressAt = now;
    }
    if (!this.retryAt && now - this.lastProgressAt > 20) this.fail();
    if (now - this.lastDraw < 1 / 15) return;
    this.lastDraw = now;
    this.draw(!this.retryAt && this.video.readyState >= 2 && this.video.videoWidth > 0);
  }

  /** 功能：按原视频比例留黑边，连接状态显示频道名称，视频帧不做变形拉伸。时间：2026-10-21；作者：lq。 */
  private draw(playing: boolean): void {
    const ctx = this.context;
    ctx.fillStyle = '#06090f';
    ctx.fillRect(0, 0, 960, 540);
    if (playing) {
      const scale = Math.min(960 / this.video.videoWidth, 540 / this.video.videoHeight);
      const width = this.video.videoWidth * scale, height = this.video.videoHeight * scale;
      ctx.drawImage(this.video, (960 - width) / 2, (540 - height) / 2, width, height);
    } else {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#f4f5f8';
      ctx.font = 'bold 62px sans-serif';
      ctx.fillText('CCTV 13  新闻', 480, 235);
      ctx.fillStyle = '#adb9ca';
      ctx.font = '28px sans-serif';
      ctx.fillText(this.status, 480, 305);
      ctx.font = '22px sans-serif';
      ctx.fillText('静音自动播放', 480, 365);
    }
    this.texture.needsUpdate = true;
  }

  /** 功能：离开页面时终止直播请求、释放纹理网格和用户操作监听。时间：2026-10-21；作者：lq。 */
  dispose(): void {
    this.disposed = true;
    document.removeEventListener('pointerdown', this.resume);
    this.video.removeEventListener('error', this.fail);
    this.hls?.destroy();
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.object.removeFromParent();
    this.object.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach((material) => material.dispose());
      }
    });
    this.texture.dispose();
  }
}
