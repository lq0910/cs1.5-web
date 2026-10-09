/** 功能：在 Dust2 警家横幅墙挂载实体 LED 资讯屏，播放真实科技与 AI 新闻。时间：2026-10-09；作者：lq。 */
import * as THREE from 'three';
import type { BspFile } from '../bsp/types.ts';
import type { Vec3 } from '../math.ts';
import { toThree } from './boxGeometry.ts';

/** 功能：描述资讯屏的位置、朝向和覆盖尺寸，便于无浏览器校验墙面定位。时间：2026-10-09；作者：lq。 */
export interface ScreenPlacement { position: Vec3; normal: Vec3; width: number; height: number }
interface ScreenNews { title: string; source: string; publishedAt: string; category: string }
interface ScreenFeed { items: ScreenNews[]; fetchedAt: string | null; stale: boolean; unavailableSources: string[] }

/** 功能：合并原版 GAMEHELPER 横幅的 BSP 切分面，选择靠近警家的一面墙。时间：2026-10-09；作者：lq。 */
export function findNewsScreenWall(bsp: BspFile, ctSpawn: Vec3): ScreenPlacement | null {
  const groups = new Map<string, { normal: Vec3; vertices: Vec3[] }>();
  for (const face of bsp.faces) {
    const info = bsp.texinfo[face.texinfo];
    if (!info || !/^csSandWallGH1[ab]$/i.test(bsp.miptex[info.miptex]?.name ?? '')) continue;
    const plane = bsp.planes[face.planenum]!;
    if (Math.abs(plane.normal.z) > 0.01) continue;
    const key = `${face.planenum}:${face.side}`;
    const sign = face.side ? -1 : 1;
    const group = groups.get(key) ?? { normal: { x: plane.normal.x * sign, y: plane.normal.y * sign, z: 0 }, vertices: [] };
    for (let i = 0; i < face.numedges; i++) {
      const surfedge = bsp.surfedges[face.firstedge + i]!;
      const edge = bsp.edges[Math.abs(surfedge)]!;
      group.vertices.push(bsp.vertices[surfedge >= 0 ? edge.v[0] : edge.v[1]]!);
    }
    groups.set(key, group);
  }
  const placements = [...groups.values()].map(({ normal, vertices }) => {
    const min = { x: Math.min(...vertices.map((v) => v.x)), y: Math.min(...vertices.map((v) => v.y)), z: Math.min(...vertices.map((v) => v.z)) };
    const max = { x: Math.max(...vertices.map((v) => v.x)), y: Math.max(...vertices.map((v) => v.y)), z: Math.max(...vertices.map((v) => v.z)) };
    return { position: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 + 16 },
      normal, width: Math.hypot(max.x - min.x, max.y - min.y), height: 160 };
  });
  placements.sort((a, b) => Math.hypot(a.position.x - ctSpawn.x, a.position.y - ctSpawn.y)
    - Math.hypot(b.position.x - ctSpawn.x, b.position.y - ctSpawn.y));
  return placements[0] ?? null;
}

/** 功能：画布动态纹理、金属外框、滚动新闻和五分钟更新；离线状态明确显示。时间：2026-10-09；作者：lq。 */
export class NewsScreen {
  readonly object = new THREE.Group();
  private readonly canvas = document.createElement('canvas');
  private readonly context: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private feed: ScreenFeed = { items: [], fetchedAt: null, stale: false, unavailableSources: [] };
  private loading = true;
  private lastDraw = -Infinity;
  private nextFetch = 0;
  private fetching = false;
  private tickerText = '正在连接科技与 AI 资讯源…';
  private tickerWidth = 0;
  private startedAt = performance.now() / 1000;
  private disposed = false;
  private request: AbortController | null = null;

  /** 功能：将屏幕按墙法线竖直安装，使用自发光材质并保留墙体遮挡。时间：2026-10-09；作者：lq。 */
  constructor(scene: THREE.Scene, placement: ScreenPlacement) {
    this.canvas.width = 1536;
    this.canvas.height = 480;
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('LED canvas unavailable');
    this.context = context;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    const normal = new THREE.Vector3(...toThree(placement.normal.x, placement.normal.y, placement.normal.z)).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(up, normal).normalize();
    this.object.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, normal));
    this.object.position.set(...toThree(placement.position.x, placement.position.y, placement.position.z)).addScaledVector(normal, 0.5);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(placement.width + 12, placement.height + 12, 8),
      new THREE.MeshBasicMaterial({ color: 0x151b20 }));
    frame.position.z = 4;
    this.object.add(frame);
    const display = new THREE.Mesh(new THREE.PlaneGeometry(placement.width, placement.height),
      new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false }));
    display.position.z = 8.1;
    this.object.add(display);
    // 功能：外框细亮边和两枚电源指示灯提供商场 LED 面板的实体感。时间：2026-10-09；作者：lq。
    const trim = new THREE.LineSegments(new THREE.EdgesGeometry(frame.geometry), new THREE.LineBasicMaterial({ color: 0x445663 }));
    trim.position.z = 4;
    this.object.add(trim);
    const indicator = new THREE.Mesh(new THREE.PlaneGeometry(3, 1), new THREE.MeshBasicMaterial({ color: 0x59ffe3, toneMapped: false }));
    indicator.position.set(placement.width / 2 - 12, -placement.height / 2 - 3, 8.15);
    this.object.add(indicator);
    scene.add(this.object);
    this.draw(0);
    void this.refresh();
  }

  /** 功能：请求同源聚合接口，验证数据结构；失败时保留旧标题并提示缓存状态。时间：2026-10-09；作者：lq。 */
  private async refresh(): Promise<void> {
    if (this.fetching || this.disposed) return;
    this.fetching = true;
    const controller = new AbortController();
    this.request = controller;
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/api/tech-news', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`News HTTP ${response.status}`);
      const payload = await response.json() as ScreenFeed;
      if (!Array.isArray(payload.items)) throw new Error('Invalid news feed');
      const items = payload.items.filter((item) => typeof item.title === 'string' && typeof item.source === 'string'
        && typeof item.category === 'string' && Number.isFinite(Date.parse(item.publishedAt)))
        .slice(0, 20).map((item) => ({ ...item, title: item.title.slice(0, 220), source: item.source.slice(0, 40) }));
      if (!items.length) throw new Error('Empty news feed');
      if (this.disposed) return;
      this.feed = { items, fetchedAt: typeof payload.fetchedAt === 'string' ? payload.fetchedAt : null,
        stale: Boolean(payload.stale), unavailableSources: Array.isArray(payload.unavailableSources) ? payload.unavailableSources : [] };
      this.tickerText = items.map((item) => `${item.category}  /  ${item.title}`).join('     •     ');
      this.tickerWidth = 0;
      this.nextFetch = performance.now() / 1000 + 300;
    } catch {
      if (this.disposed) return;
      this.feed.stale = true;
      this.nextFetch = performance.now() / 1000 + 30;
      if (!this.feed.items.length) this.tickerText = '资讯连接暂时不可用，正在重试…';
    } finally {
      window.clearTimeout(timeout);
      this.loading = false;
      this.fetching = false;
      this.request = null;
      this.lastDraw = -Infinity;
    }
  }

  /** 功能：每秒最多刷新 15 次纹理，远处不重绘；新闻拉取独立于对局暂停。时间：2026-10-09；作者：lq。 */
  update(now: number, camera: THREE.Camera): void {
    if (this.disposed) return;
    if (now >= this.nextFetch && !this.fetching) void this.refresh();
    if (now - this.lastDraw < 1 / 15 || camera.position.distanceToSquared(this.object.position) > 3000 ** 2) return;
    this.lastDraw = now;
    this.draw(Math.max(0, now - this.startedAt));
  }

  /** 功能：按可用宽度折行中英文标题，标题最多三行并裁剪超长内容。时间：2026-10-09；作者：lq。 */
  private titleLines(text: string, maxWidth: number): string[] {
    const lines: string[] = [];
    let current = '';
    for (const char of text) {
      if (current && this.context.measureText(current + char).width > maxWidth) { lines.push(current); current = ''; }
      current += char;
    }
    if (current) lines.push(current);
    const visible = lines.slice(0, 3);
    if (lines.length > 3) visible[2] = `${visible[2]!.slice(0, -1)}…`;
    return visible;
  }

  /** 功能：绘制青色科技标题、轮播进度、来源日期、LED 扫描线与匀速跑马灯。时间：2026-10-09；作者：lq。 */
  private draw(elapsed: number): void {
    const ctx = this.context;
    const width = this.canvas.width;
    ctx.fillStyle = '#061017'; ctx.fillRect(0, 0, width, 480);
    ctx.fillStyle = '#66f4dc'; ctx.fillRect(36, 32, 6, 34);
    ctx.font = 'bold 30px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText('前沿科技  /  AI NEWS', 58, 59);
    ctx.font = '20px "PingFang SC", sans-serif'; ctx.textAlign = 'right';
    const status = this.loading ? '正在连接' : this.feed.stale ? (this.feed.items.length ? '缓存资讯 · 部分源离线' : '离线 · 自动重试') : '资讯在线';
    ctx.fillStyle = this.feed.stale ? '#e3b66d' : '#66f4dc'; ctx.fillText(`● ${status}`, width - 36, 55);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#24404c'; ctx.fillRect(36, 82, width - 72, 1);
    const index = Math.floor(elapsed / 12) % Math.max(1, this.feed.items.length);
    const item = this.feed.items[index];
    const phase = elapsed % 12;
    ctx.save();
    ctx.globalAlpha = Math.min(1, phase / 0.45, (12 - phase) / 0.45);
    ctx.fillStyle = '#66f4dc'; ctx.font = '22px "PingFang SC", sans-serif';
    ctx.fillText(item ? `${item.category}  /  ${String(index + 1).padStart(2, '0')}` : '科技 · 人工智能 · 前沿研究', 40, 122);
    ctx.fillStyle = '#f0f6f7'; ctx.font = 'bold 44px "PingFang SC", "Microsoft YaHei", sans-serif';
    const headline = item?.title ?? (this.loading ? '正在获取最新科技资讯' : '资讯源暂时无法连接');
    this.titleLines(headline, 1110).forEach((line, row) => ctx.fillText(line, 40, 190 + row * 59));
    ctx.font = '21px "PingFang SC", sans-serif'; ctx.fillStyle = '#9cafbc';
    const published = item ? new Date(item.publishedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
    ctx.fillText(item ? `${item.source}  ·  ${published} 发布` : 'IT之家 + MIT News  /  每 5 分钟更新', 40, 354);
    // 功能：显示最近成功同步时间，便于判断屏幕上的缓存是否仍然新鲜。时间：2026-10-09；作者：lq。
    if (this.feed.fetchedAt && Number.isFinite(Date.parse(this.feed.fetchedAt))) {
      const synced = new Date(this.feed.fetchedAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
      ctx.textAlign = 'right'; ctx.fillText(`同步 ${synced}`, width - 40, 354); ctx.textAlign = 'left';
    }
    ctx.restore();
    // 功能：抽象地球经纬线缓慢旋转，形成屏幕右侧的科技视觉锚点。时间：2026-10-09；作者：lq。
    ctx.save(); ctx.translate(1332, 230); ctx.strokeStyle = '#225760'; ctx.lineWidth = 1.5;
    for (let ring = 0; ring < 4; ring++) {
      ctx.beginPath(); ctx.ellipse(0, 0, 104 * Math.max(0.05, Math.abs(Math.sin(elapsed * 0.12 + ring * Math.PI / 4))), 104, 0, 0, Math.PI * 2); ctx.stroke();
    }
    for (const offset of [-56, 0, 56]) { ctx.beginPath(); ctx.ellipse(0, offset, Math.sqrt(104 ** 2 - offset ** 2), 14, 0, 0, Math.PI * 2); ctx.stroke(); }
    ctx.beginPath(); ctx.arc(0, 0, 104, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    ctx.fillStyle = '#18333d'; ctx.fillRect(40, 378, width - 80, 2);
    ctx.fillStyle = '#66f4dc'; ctx.fillRect(40, 378, (width - 80) * phase / 12, 2);
    ctx.fillStyle = '#101f28'; ctx.fillRect(0, 399, width, 81);
    ctx.fillStyle = '#66f4dc'; ctx.fillRect(0, 399, 170, 81);
    ctx.font = 'bold 25px "PingFang SC", sans-serif'; ctx.fillStyle = '#061017'; ctx.fillText('科技快讯', 32, 450);
    ctx.save(); ctx.beginPath(); ctx.rect(190, 400, width - 210, 79); ctx.clip();
    ctx.font = '27px "PingFang SC", "Microsoft YaHei", sans-serif'; ctx.fillStyle = '#e2eef1';
    if (!this.tickerWidth) this.tickerWidth = ctx.measureText(this.tickerText).width + 160;
    const offset = elapsed * 65 % this.tickerWidth;
    ctx.fillText(this.tickerText, 200 - offset, 450);
    ctx.fillText(this.tickerText, 200 - offset + this.tickerWidth, 450);
    ctx.restore();
    // 功能：低透明扫描线体现 LED 像素质感，避免高亮屏幕破坏原版地图氛围。时间：2026-10-09；作者：lq。
    ctx.fillStyle = 'rgba(0,0,0,0.17)';
    for (let y = 0; y < 480; y += 4) ctx.fillRect(0, y, width, 1);
    this.texture.needsUpdate = true;
  }

  /** 功能：移除屏幕并释放纹理、几何体、材料及进行中的请求。时间：2026-10-09；作者：lq。 */
  dispose(): void {
    this.disposed = true;
    this.request?.abort();
    this.object.removeFromParent();
    this.object.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => material.dispose());
      }
    });
    this.texture.dispose();
  }
}
