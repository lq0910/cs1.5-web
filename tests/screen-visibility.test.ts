/** 功能：验证大屏视野、距离、墙体遮挡和有声直播按需启停，避免后台偷跑直播。时间：2026-10-21；作者：lq。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { canSeeScreen } from '../src/engine/render/screenVisibility.ts';
import { LiveScreen } from '../src/engine/render/liveScreen.ts';
import type { CollisionWorld } from '../src/engine/collision/types.ts';
import { makeTrace } from '../src/engine/collision/types.ts';

const placement = { position: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: -1, z: 0 }, width: 256, height: 144 };
const world: CollisionWorld = { pointContents: () => -1, traceHull: () => makeTrace() };
/** 功能：建立正面观察屏幕的测试相机，沿用游戏的 Y-up 渲染坐标。时间：2026-10-21；作者：lq。 */
function camera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
  camera.position.set(0, 0, 300);
  camera.lookAt(0, 0, 0);
  return camera;
}

// 功能：完整/局部入镜均播放，转身、远离、屏幕后方和实体墙遮挡时不播放。时间：2026-10-21；作者：lq。
test('screen visibility requires front-facing nearby unobstructed pixels', () => {
  const view = camera();
  assert.equal(canSeeScreen(placement, view, world), true);
  view.lookAt(200, 0, 0);
  assert.equal(canSeeScreen(placement, view, world), true, 'a visible edge counts even when the screen center is off camera');
  view.lookAt(500, 0, 0);
  assert.equal(canSeeScreen(placement, view, world), false);
  view.lookAt(0, 0, 600);
  assert.equal(canSeeScreen(placement, view, world), false);
  view.position.z = -300;
  view.lookAt(0, 0, 0);
  assert.equal(canSeeScreen(placement, view, world), false);
  view.position.z = 1200;
  assert.equal(canSeeScreen(placement, view, world), false);
  view.position.z = 300;
  view.lookAt(0, 0, 0);
  const blocked: CollisionWorld = { ...world, traceHull: () => ({ ...makeTrace(), fraction: 0.5 }) };
  assert.equal(canSeeScreen(placement, view, blocked), false);
  const partiallyBlocked: CollisionWorld = { ...world, traceHull: (_hull, _from, to) => ({ ...makeTrace(), fraction: Math.abs(to.x) < 30 ? 0.5 : 1 }) };
  assert.equal(canSeeScreen(placement, view, partiallyBlocked), true);
});

// 功能：真实播放器控制逻辑在看到时才设置源并解除静音，离开后清空源且不会被点击误唤醒。时间：2026-10-21；作者：lq。
test('live screen loads only while visible and stops audio and media when hidden', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const events = new Map<string, () => void>();
  let source = '', loads = 0, plays = 0, pauses = 0;
  const video = {
    muted: true, volume: 1, currentTime: 0, readyState: 0, videoWidth: 0, videoHeight: 0,
    src: '', preload: '', autoplay: false, crossOrigin: '', playsInline: false,
    setAttribute() {}, addEventListener() {}, removeEventListener() {},
    canPlayType: () => 'probably',
    play: async () => { plays++; source = video.src; },
    pause() { pauses++; }, load() { loads++; }, removeAttribute() { video.src = ''; source = ''; },
  };
  const context = { fillRect() {}, fillText() {}, drawImage() {}, fillStyle: '', textAlign: '', font: '' };
  const doc = {
    hidden: false,
    createElement: (tag: string) => tag === 'video' ? video : { width: 0, height: 0, getContext: () => context },
    addEventListener: (name: string, handler: () => void) => events.set(name, handler),
    removeEventListener: (name: string) => events.delete(name),
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  try {
    const screen = new LiveScreen(new THREE.Scene(), placement, 'https://example.com/test.m3u8');
    const view = camera();
    assert.equal(source, '');
    assert.equal(plays, 0, 'constructing the screen must not request or play media');
    screen.update(0, view, world, false);
    assert.equal(plays, 0);
    screen.update(1, view, world, true);
    await Promise.resolve();
    assert.equal(source, 'https://example.com/test.m3u8');
    assert.equal(video.muted, false);
    assert.ok(video.volume > 0 && video.volume < 0.65);
    view.lookAt(0, 0, 600);
    screen.update(2, view, world, true);
    assert.equal(source, '');
    assert.equal(video.muted, true);
    assert.ok(loads > 0 && pauses > 0);
    const oldPlays = plays;
    events.get('pointerdown')?.();
    assert.equal(plays, oldPlays);
    view.lookAt(0, 0, 0);
    screen.update(3, view, world, true);
    assert.equal(source, 'https://example.com/test.m3u8');
    doc.hidden = true;
    events.get('visibilitychange')?.();
    assert.equal(source, '');
    assert.equal(video.muted, true);
    doc.hidden = false;
    screen.update(4, view, world, true);
    screen.update(5, view, world, false);
    assert.equal(source, '');
    screen.dispose();
    assert.equal(events.size, 0);
  } finally {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
