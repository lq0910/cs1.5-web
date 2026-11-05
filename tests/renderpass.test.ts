/**
 * Regression test for the first-person overlay pass.
 *
 * The bug this locks down: three.js clears the colour buffer at the start of
 * every render() call. The weapon is drawn as a *second* pass, so leaving
 * autoClear on wiped the world and left a black frame containing nothing but the
 * gun (6 draw calls / 72 triangles, while the map's 34 meshes and ~10k triangles
 * were drawn and then thrown away).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { WorldRenderer, renderTwoPass } from '../src/engine/render/renderer.ts';

function fakeTarget(calls: number, triangles: number) {
  const log: string[] = [];
  const target = {
    autoClear: true,
    clearDepth(): void {
      log.push('clearDepth');
    },
    render(scene: THREE.Scene): void {
      log.push(`render(${scene.name}, autoClear=${this.autoClear})`);
      this.info.render.calls = calls;
      this.info.render.triangles = triangles;
    },
    info: { render: { calls: 0, triangles: 0 } },
  };
  return { target, log };
}

test('the weapon overlay must not clear the colour buffer the world was drawn into', () => {
  const world = new THREE.Scene();
  world.name = 'world';
  const view = new THREE.Scene();
  view.name = 'view';
  const camera = new THREE.PerspectiveCamera();

  const { target, log } = fakeTarget(34, 9932);
  const stats = renderTwoPass(target, world, camera, view, camera);

  assert.deepEqual(
    log,
    ['render(world, autoClear=true)', 'clearDepth', 'render(view, autoClear=false)'],
    'the overlay pass must run with colour clearing disabled',
  );
  assert.equal(stats.drawCalls, 68, 'the HUD must report both passes, not just the weapon');
  assert.equal(stats.triangles, 19864);
  assert.equal(target.autoClear, true, 'autoClear must be restored for the next frame');
});

test('a single-pass render still clears and reports its own counts', () => {
  const world = new THREE.Scene();
  world.name = 'world';
  const camera = new THREE.PerspectiveCamera();

  const { target, log } = fakeTarget(12, 500);
  const stats = renderTwoPass(target, world, camera, null, null);

  assert.deepEqual(log, ['render(world, autoClear=true)']);
  assert.deepEqual(stats, { drawCalls: 12, triangles: 500 });
});

// Exercise the actual resize/render methods without creating a WebGL context.
// The sizing target models Three.js's CSS-pixel / drawing-buffer contract.
function sizingFixture() {
  const { target } = fakeTarget(1, 12);
  let pixelRatio = 1;
  let sizeCalls = 0;
  const canvas = { width: 0, height: 0, style: { width: '', height: '' } };
  const webgl = {
    ...target,
    getPixelRatio: () => pixelRatio,
    setPixelRatio(value: number) { pixelRatio = value; },
    setSize(width: number, height: number, updateStyle = true) {
      sizeCalls++;
      canvas.width = Math.floor(width * pixelRatio);
      canvas.height = Math.floor(height * pixelRatio);
      if (updateStyle) {
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }
    },
  };
  const viewCamera = new THREE.PerspectiveCamera(54, 1, 0.02, 24);
  const renderer = Object.assign(Object.create(WorldRenderer.prototype), {
    webgl,
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(90, 1, 4, 16384),
    viewScene: new THREE.Scene(),
    viewCamera,
    viewportSize: new THREE.Vector2(),
    fovHorizontal: 90,
    disposed: false,
  }) as WorldRenderer;
  return { renderer, viewCamera, webgl, canvas, sizeCalls: () => sizeCalls };
}

function withDisplay(dpr: number, run: (display: { devicePixelRatio: number }) => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const display = { devicePixelRatio: dpr };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: display });
  try {
    run(display);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

for (const dpr of [1, 1.25, 1.5, 2, 3]) {
  test(`initial resize at DPR ${dpr} keeps the whole canvas in the CSS viewport`, () => {
    withDisplay(dpr, () => {
      const { renderer, viewCamera, canvas, webgl } = sizingFixture();
      renderer.resize(1080, 600);
      const effectiveDpr = Math.min(dpr, 2);
      assert.equal(webgl.getPixelRatio(), effectiveDpr);
      assert.deepEqual([canvas.width, canvas.height], [1080 * effectiveDpr, 600 * effectiveDpr]);
      assert.deepEqual(canvas.style, { width: '1080px', height: '600px' });
      assert.equal(renderer.camera.aspect, 1.8);
      assert.equal(viewCamera.aspect, 1.8);
      // 功能：世界与武器使用相同的水平 90° 基准，Retina/宽屏不裁掉手臂。时间：2026-11-05；作者：lq。
      assert.equal(viewCamera.fov, renderer.camera.fov);
      assert.ok(Math.abs(renderer.camera.fov - 2 * Math.atan(1 / 1.8) * 180 / Math.PI) < 1e-9);
    });
  });
}

test('cross-display DPR changes are applied before drawing even without a resize event', () => {
  withDisplay(1, (display) => {
    const { renderer, viewCamera, canvas, webgl, sizeCalls } = sizingFixture();
    renderer.resize(1080, 600);
    const worldProjection = renderer.camera.projectionMatrix.clone();
    const weaponProjection = viewCamera.projectionMatrix.clone();
    renderer.render();
    assert.equal(sizeCalls(), 1, 'stable DPR must not resize every frame');
    for (const dpr of [2, 1.5, 1]) {
      display.devicePixelRatio = dpr;
      const before = sizeCalls();
      renderer.render();
      assert.equal(sizeCalls(), before + 1);
      assert.equal(webgl.getPixelRatio(), dpr);
      assert.deepEqual([canvas.width, canvas.height], [1080 * dpr, 600 * dpr]);
      assert.deepEqual(canvas.style, { width: '1080px', height: '600px' });
      assert.ok(renderer.camera.projectionMatrix.equals(worldProjection));
      assert.ok(viewCamera.projectionMatrix.equals(weaponProjection));
      renderer.render();
      assert.equal(sizeCalls(), before + 1, 'no repeated allocation once DPR is synchronized');
    }
  });
});

test('viewport resizing and late weapon-camera registration keep both cameras in sync', () => {
  withDisplay(2, () => {
    const { renderer, canvas } = sizingFixture();
    renderer.resize(1920, 1080);
    const camera = new THREE.PerspectiveCamera(54, 1, 0.02, 24);
    renderer.setViewScene(new THREE.Scene(), camera);
    assert.equal(camera.aspect, 16 / 9);
    renderer.resize(1440, 900);
    assert.equal(camera.aspect, 1.6);
    assert.equal(renderer.camera.aspect, 1.6);
    assert.deepEqual(canvas.style, { width: '1440px', height: '900px' });
    assert.deepEqual([canvas.width, canvas.height], [2880, 1800]);
    const projection = renderer.camera.projectionMatrix.clone();
    for (const [width, height] of [[0, 900], [1440, 0], [-1, 900], [NaN, 900], [Infinity, 900]]) {
      renderer.resize(width, height);
      assert.ok(renderer.camera.projectionMatrix.equals(projection));
      assert.equal(camera.aspect, 1.6);
      assert.deepEqual(canvas.style, { width: '1440px', height: '900px' });
    }
  });
});
