/** 功能：读取用户本地 CS 1.5 狙击镜精灵，在全高圆形镜口中显示原版刻度和红点。时间：2026-11-05；作者：lq。 */
import { parseSprite } from '../engine/sprite/parser.ts';

export class ScopeOverlay {
  private readonly canvas = document.createElement('canvas');
  private readonly context: CanvasRenderingContext2D;
  private reticle: HTMLCanvasElement | null = null;
  /** 功能：原包红点与纹理几何中心略有偏移，保存实际瞄点归一化坐标以对齐弹道。时间：2026-11-05；作者：lq。 */
  private reticleCenter = { x: 0.5, y: 0.5 };
  private width = 0;
  private height = 0;
  private ratio = 0;

  /** 功能：狙击镜只加载一次；本地素材缺失时保留清晰的十字线回退。时间：2026-11-05；作者：lq。 */
  constructor(element: HTMLElement) {
    this.context = this.canvas.getContext('2d')!;
    this.canvas.setAttribute('aria-hidden', 'true');
    element.replaceChildren(this.canvas);
    void this.loadReticle();
  }

  /** 功能：沿用本地素材 fetch 接管，不依赖转换生成的 PNG 或远程素材。时间：2026-11-05；作者：lq。 */
  private async loadReticle(): Promise<void> {
    try {
      const response = await fetch('cstrike/sprites/sniper_scope.spr');
      if (!response.ok) return;
      const frame = parseSprite(new Uint8Array(await response.arrayBuffer())).frames[0]!;
      const image = document.createElement('canvas');
      image.width = frame.width;
      image.height = frame.height;
      const context = image.getContext('2d')!;
      const pixels = context.createImageData(frame.width, frame.height);
      pixels.data.set(frame.rgba);
      context.putImageData(pixels, 0, 0);
      // 功能：仅在中心附近查找原版红点，其他镜片无红点时仍按几何中心放置。时间：2026-11-05；作者：lq。
      let redX = 0;
      let redY = 0;
      let redCount = 0;
      for (let y = Math.max(0, Math.floor(frame.height / 2) - 8); y < Math.min(frame.height, frame.height / 2 + 8); y++) {
        for (let x = Math.max(0, Math.floor(frame.width / 2) - 8); x < Math.min(frame.width, frame.width / 2 + 8); x++) {
          const offset = (y * frame.width + x) * 4;
          const [r, g, b, a] = frame.rgba.subarray(offset, offset + 4);
          if (a! > 0 && r! > 80 && r! > g! * 2 && r! > b! * 2) {
            redX += x + 0.5;
            redY += y + 0.5;
            redCount++;
          }
        }
      }
      if (redCount > 0) this.reticleCenter = { x: redX / redCount / frame.width, y: redY / redCount / frame.height };
      this.reticle = image;
      this.canvas.dataset.source = 'original';
      if (this.width > 0) this.draw();
    } catch {
      // 功能：损坏或未导入的精灵安全回退，不阻塞游戏与瞄准输入。时间：2026-11-05；作者：lq。
    }
  }

  /** 功能：仅视口或 DPR 改变时重绘，镜口按短边保持正圆，不使用随宽高比变化的渐变百分比。时间：2026-11-05；作者：lq。 */
  resize(width: number, height: number, pixelRatio: number): void {
    const ratio = Math.min(2, pixelRatio || 1);
    if (width <= 0 || height <= 0 || (width === this.width && height === this.height && ratio === this.ratio)) return;
    this.width = width;
    this.height = height;
    this.ratio = ratio;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.draw();
  }

  /** 功能：镜外纯黑、镜内透明，保留边界抗锯齿但移除大范围渐暗；原版精灵负责全部刻度。时间：2026-11-05；作者：lq。 */
  private draw(): void {
    const context = this.context;
    const { width, height, ratio } = this;
    const size = Math.min(width, height);
    const x = (width - size) / 2;
    const y = (height - size) / 2;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#000';
    context.beginPath();
    context.rect(0, 0, width, height);
    context.arc(width / 2, height / 2, size / 2, 0, Math.PI * 2);
    context.fill('evenodd');
    context.save();
    context.beginPath();
    context.arc(width / 2, height / 2, size / 2, 0, Math.PI * 2);
    context.clip();
    if (this.reticle) {
      context.drawImage(this.reticle, width / 2 - this.reticleCenter.x * size,
        height / 2 - this.reticleCenter.y * size, size, size);
    } else {
      context.fillRect(width / 2 - 0.5, y, 1, size);
      context.fillRect(x, height / 2 - 0.5, size, 1);
    }
    context.restore();
  }
}
