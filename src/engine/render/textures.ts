/**
 * Procedural textures.
 *
 * Nothing here is loaded from disk, which keeps the project free of third-party
 * art while the real maps are still awaiting the user's own CS 1.5 files. When
 * the WAD3 loader lands, these are used as fallbacks for missing textures.
 *
 * Sizes are small and filtering is NEAREST on purpose: GoldSrc (and CS 1.5)
 * render 8-bit palettised textures with no smoothing, and that crispness is a
 * large part of the look.
 */

import * as THREE from 'three';

/** World units covered by one texture repeat. GoldSrc maps are modulo-scaled like this. */
export const TILE_UNITS = 64;

/** Deterministic PRNG so textures look identical on every reload. */
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

function makeCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  return { canvas, ctx };
}

function noiseOverlay(
  ctx: CanvasRenderingContext2D,
  size: number,
  rand: () => number,
  amount: number,
  alpha: number,
): void {
  for (let i = 0; i < amount; i++) {
    const x = Math.floor(rand() * size);
    const y = Math.floor(rand() * size);
    const shade = Math.floor(rand() * 60) - 30;
    ctx.fillStyle = `rgba(${128 + shade},${128 + shade},${128 + shade},${alpha})`;
    ctx.fillRect(x, y, 1 + Math.floor(rand() * 2), 1 + Math.floor(rand() * 2));
  }
}

function speckle(
  ctx: CanvasRenderingContext2D,
  size: number,
  rand: () => number,
  count: number,
  color: string,
  maxR: number,
): void {
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    const r = 0.5 + rand() * maxR;
    ctx.beginPath();
    ctx.arc(rand() * size, rand() * size, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

type DrawFn = (ctx: CanvasRenderingContext2D, size: number, rand: () => number) => void;

const PAINTERS: Record<string, DrawFn> = {
  // White stucco — the walls of the white house.
  stucco: (ctx, size, rand) => {
    ctx.fillStyle = '#e9e7de';
    ctx.fillRect(0, 0, size, size);
    noiseOverlay(ctx, size, rand, size * 26, 0.06);
    speckle(ctx, size, rand, size * 0.5, 'rgba(206,203,190,0.5)', 1.5);
    // Faint horizontal seams, as if rendered in coats.
    ctx.strokeStyle = 'rgba(180,178,166,0.5)';
    ctx.lineWidth = 1;
    for (let y = size / 4; y < size; y += size / 4) {
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(size, y + 0.5);
      ctx.stroke();
    }
  },

  concrete: (ctx, size, rand) => {
    ctx.fillStyle = '#9d9d98';
    ctx.fillRect(0, 0, size, size);
    noiseOverlay(ctx, size, rand, size * 40, 0.09);
    speckle(ctx, size, rand, size * 0.7, 'rgba(120,120,116,0.45)', 2);
    ctx.strokeStyle = 'rgba(90,90,88,0.35)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      let x = rand() * size;
      let y = rand() * size;
      ctx.moveTo(x, y);
      for (let s = 0; s < 5; s++) {
        x += (rand() - 0.5) * size * 0.3;
        y += (rand() - 0.5) * size * 0.3;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  },

  // Courtyard ground.
  sand: (ctx, size, rand) => {
    ctx.fillStyle = '#c3ae83';
    ctx.fillRect(0, 0, size, size);
    noiseOverlay(ctx, size, rand, size * 45, 0.08);
    speckle(ctx, size, rand, size * 1.4, 'rgba(168,148,110,0.45)', 2.5);
    speckle(ctx, size, rand, size * 0.6, 'rgba(226,214,184,0.4)', 1.5);
  },

  brick: (ctx, size, rand) => {
    ctx.fillStyle = '#8d8c86'; // mortar
    ctx.fillRect(0, 0, size, size);
    const rows = 8;
    const rowH = size / rows;
    const brickW = size / 4;
    for (let r = 0; r < rows; r++) {
      const offset = r % 2 === 0 ? 0 : brickW / 2;
      for (let c = -1; c < 5; c++) {
        const x = c * brickW + offset + 1;
        const y = r * rowH + 1;
        const shade = 0.85 + rand() * 0.3;
        ctx.fillStyle = `rgb(${Math.floor(150 * shade)},${Math.floor(84 * shade)},${Math.floor(66 * shade)})`;
        ctx.fillRect(x, y, brickW - 2, rowH - 2);
      }
    }
    noiseOverlay(ctx, size, rand, size * 20, 0.07);
  },

  wood: (ctx, size, rand) => {
    ctx.fillStyle = '#8a6a45';
    ctx.fillRect(0, 0, size, size);
    const planks = 4;
    const w = size / planks;
    for (let p = 0; p < planks; p++) {
      const shade = 0.88 + rand() * 0.24;
      ctx.fillStyle = `rgb(${Math.floor(138 * shade)},${Math.floor(106 * shade)},${Math.floor(69 * shade)})`;
      ctx.fillRect(p * w, 0, w - 1, size);
      ctx.strokeStyle = 'rgba(70,50,30,0.5)';
      ctx.lineWidth = 1;
      for (let g = 0; g < 4; g++) {
        ctx.beginPath();
        const x = p * w + rand() * w;
        ctx.moveTo(x, 0);
        ctx.bezierCurveTo(x + 3, size / 3, x - 3, (size * 2) / 3, x, size);
        ctx.stroke();
      }
    }
    ctx.strokeStyle = 'rgba(50,35,20,0.6)';
    for (let p = 1; p < planks; p++) {
      ctx.beginPath();
      ctx.moveTo(p * w, 0);
      ctx.lineTo(p * w, size);
      ctx.stroke();
    }
  },

  metal: (ctx, size, rand) => {
    ctx.fillStyle = '#7f858c';
    ctx.fillRect(0, 0, size, size);
    noiseOverlay(ctx, size, rand, size * 30, 0.1);
    ctx.strokeStyle = 'rgba(60,65,70,0.5)';
    ctx.lineWidth = 2;
    ctx.strokeRect(2, 2, size - 4, size - 4);
    ctx.fillStyle = 'rgba(190,196,204,0.85)';
    const rivets = 4;
    const step = size / rivets;
    for (let i = 0; i < rivets; i++) {
      for (let j = 0; j < rivets; j++) {
        ctx.beginPath();
        ctx.arc(step * (i + 0.5), step * (j + 0.5), 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  },
};

export interface MaterialEntry {
  material: THREE.MeshLambertMaterial;
  tileUnits: number;
}

const cache = new Map<string, MaterialEntry>();

function textureFor(name: string): THREE.Texture {
  const size = 128;
  const { canvas, ctx } = makeCanvas(size);
  const rand = mulberry32(hashName(name));
  const painter = PAINTERS[name] ?? PAINTERS.concrete!;
  painter(ctx, size, rand);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function hashName(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function getMaterial(name: string): MaterialEntry {
  const existing = cache.get(name);
  if (existing) return existing;

  const entry: MaterialEntry = {
    material: new THREE.MeshLambertMaterial({ map: textureFor(name) }),
    tileUnits: TILE_UNITS,
  };
  cache.set(name, entry);
  return entry;
}

export function knownMaterialNames(): string[] {
  return Object.keys(PAINTERS);
}

/** Vertical gradient used as the sky background. */
export function createSkyTexture(top = 0x4d7fb3, horizon = 0xd7e6f2): THREE.Texture {
  const size = 256;
  const { canvas, ctx } = makeCanvas(size);
  const gradient = ctx.createLinearGradient(0, 0, 0, size);
  gradient.addColorStop(0, `#${top.toString(16).padStart(6, '0')}`);
  gradient.addColorStop(0.62, `#${horizon.toString(16).padStart(6, '0')}`);
  gradient.addColorStop(1, '#c9d6de');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
