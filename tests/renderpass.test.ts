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

import { renderTwoPass } from '../src/engine/render/renderer.ts';

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
