/**
 * 功能：为第一和第三人称开火创建短促的不规则枪口焰贴图。
 * 时间：2026-09-29；作者：lq。
 */
import * as THREE from 'three';

/** 功能：使用透明尖瓣和亮芯替代圆形烟雾贴图，贴近 CS 1.5 的枪口闪光。时间：2026-09-29；作者：lq。 */
export function makeMuzzleTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const context = canvas.getContext('2d')!;
  context.translate(64, 64);
  for (let i = 0; i < 7; i++) {
    context.save();
    context.rotate(i * Math.PI * 2 / 7);
    const flame = context.createLinearGradient(0, 0, 0, -59);
    flame.addColorStop(0, 'rgba(255,255,225,0.95)');
    flame.addColorStop(0.36, 'rgba(255,217,91,0.9)');
    flame.addColorStop(0.78, 'rgba(255,111,23,0.55)');
    flame.addColorStop(1, 'rgba(255,92,14,0)');
    context.fillStyle = flame;
    context.beginPath();
    context.moveTo(-12, 1);
    context.quadraticCurveTo(-8, -25, -2, -58 + (i % 3) * 9);
    context.quadraticCurveTo(7, -28, 12, 1);
    context.closePath();
    context.fill();
    context.restore();
  }
  const core = context.createRadialGradient(0, 0, 1, 0, 0, 19);
  core.addColorStop(0, 'rgba(255,255,255,1)');
  core.addColorStop(0.42, 'rgba(255,249,185,0.95)');
  core.addColorStop(1, 'rgba(255,192,58,0)');
  context.fillStyle = core;
  context.beginPath();
  context.arc(0, 0, 19, 0, Math.PI * 2);
  context.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
