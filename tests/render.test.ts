/**
 * Geometry / camera maths tests.
 *
 * These cover the parts of the renderer that can be wrong without any error
 * being visible: inverted faces (you would only notice as see-through walls),
 * axis mix-ups, and stretched textures.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { v3 } from '../src/engine/math.ts';
import { createActor } from '../src/game/actors.ts';
import { makeTestRoom } from '../src/game/map/build.ts';
import { spectatorCameraPose } from '../src/game/spectator.ts';
import {
  FACES,
  makeGeometryArrays,
  toThree,
  verticalFovForHorizontal,
  writeBoxGeometry,
} from '../src/engine/render/boxGeometry.ts';
import { angleVectors } from '../src/engine/math.ts';

const CUBE = [{ mins: v3(-32, -32, 0), maxs: v3(32, 32, 64) }];

test('a box emits 6 quads = 12 triangles = 24 vertices', () => {
  const arrays = makeGeometryArrays();
  writeBoxGeometry(CUBE, 64, arrays);

  assert.equal(arrays.positions.length / 3, 24, 'vertex count');
  assert.equal(arrays.indices.length, 36, 'index count');
  assert.equal(arrays.normals.length / 3, 24, 'normal count');
  assert.equal(arrays.uvs.length / 2, 24, 'uv count');
});

test('triangle winding matches the face normals (no inverted faces)', () => {
  const arrays = makeGeometryArrays();
  writeBoxGeometry(CUBE, 64, arrays);

  const corner = (i: number): [number, number, number] => [
    arrays.positions[i * 3]!,
    arrays.positions[i * 3 + 1]!,
    arrays.positions[i * 3 + 2]!,
  ];
  const normalAt = (i: number): [number, number, number] => [
    arrays.normals[i * 3]!,
    arrays.normals[i * 3 + 1]!,
    arrays.normals[i * 3 + 2]!,
  ];

  for (let tri = 0; tri < arrays.indices.length; tri += 3) {
    const [ia, ib, ic] = [
      arrays.indices[tri]!,
      arrays.indices[tri + 1]!,
      arrays.indices[tri + 2]!,
    ];
    const a = corner(ia);
    const b = corner(ib);
    const c = corner(ic);

    // Geometric normal from the winding order.
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const geo = [
      ab[1]! * ac[2]! - ab[2]! * ac[1]!,
      ab[2]! * ac[0]! - ab[0]! * ac[2]!,
      ab[0]! * ac[1]! - ab[1]! * ac[0]!,
    ];
    const len = Math.hypot(geo[0]!, geo[1]!, geo[2]!);
    assert.ok(len > 1e-6, 'degenerate triangle');
    const unit = [geo[0]! / len, geo[1]! / len, geo[2]! / len];

    // Every vertex of the quad carries the same shading normal.
    for (const index of [ia, ib, ic]) {
      const n = normalAt(index);
      const dot = unit[0]! * n[0]! + unit[1]! * n[1]! + unit[2]! * n[2]!;
      assert.ok(dot > 0.99, `winding disagrees with the shading normal (dot=${dot})`);
    }
  }
});

test('all six face directions are present exactly once', () => {
  const arrays = makeGeometryArrays();
  writeBoxGeometry(CUBE, 64, arrays);

  const seen = new Set<string>();
  for (let i = 0; i < arrays.normals.length / 3; i += 4) {
    seen.add(`${arrays.normals[i * 3]},${arrays.normals[i * 3 + 1]},${arrays.normals[i * 3 + 2]}`);
  }
  assert.equal(seen.size, FACES.length);
  for (const face of FACES) {
    const [x, y, z] = toThree(face.normal[0], face.normal[1], face.normal[2]);
    assert.ok(seen.has(`${x},${y},${z}`), `missing face ${face.normal}`);
  }
});

test('Z-up geometry lands in the right place in Three.js Y-up space', () => {
  // Feet on the ground at z=0, head at z=64, offset in x and y.
  const arrays = makeGeometryArrays();
  writeBoxGeometry([{ mins: v3(10, 20, 0), maxs: v3(40, 50, 64) }], 64, arrays);

  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (let i = 0; i < arrays.positions.length; i += 3) {
    xs.push(arrays.positions[i]!);
    ys.push(arrays.positions[i + 1]!);
    zs.push(arrays.positions[i + 2]!);
  }

  assert.deepEqual([Math.min(...xs), Math.max(...xs)], [10, 40], 'x is unchanged');
  // GoldSrc z (up) becomes Three y.
  assert.deepEqual([Math.min(...ys), Math.max(...ys)], [0, 64], 'z (up) maps to y');
  // GoldSrc y (north) becomes -z, so it is mirrored: 20..50 -> -50..-20.
  assert.deepEqual([Math.min(...zs), Math.max(...zs)], [-50, -20], 'y maps to -z');
});

test('texture coordinates follow world size / tile units', () => {
  const arrays = makeGeometryArrays();
  // A 128 x 128 top face with a 64 unit tile => 2 x 2 texture repeats.
  writeBoxGeometry([{ mins: v3(0, 0, 0), maxs: v3(128, 128, 16) }], 64, arrays);

  let maxU = 0;
  let maxV = 0;
  for (let i = 0; i < arrays.uvs.length; i += 2) {
    maxU = Math.max(maxU, arrays.uvs[i]!);
    maxV = Math.max(maxV, arrays.uvs[i + 1]!);
  }
  assert.equal(maxU, 2, 'u repeat count');
  assert.equal(maxV, 2, 'v repeat count');

  // Halving the tile size doubles the repeats.
  const half = makeGeometryArrays();
  writeBoxGeometry([{ mins: v3(0, 0, 0), maxs: v3(128, 128, 16) }], 32, half);
  let maxU2 = 0;
  for (let i = 0; i < half.uvs.length; i += 2) maxU2 = Math.max(maxU2, half.uvs[i]!);
  assert.equal(maxU2, 4);
});

test('degenerate (zero thickness) boxes emit no geometry', () => {
  const arrays = makeGeometryArrays();
  writeBoxGeometry([{ mins: v3(0, 0, 0), maxs: v3(0, 32, 32) }], 64, arrays);
  assert.equal(arrays.positions.length, 0);
});

test('90 degree horizontal FOV gives the expected vertical FOV', () => {
  // 16:9, 90 horizontal -> ~58.7 vertical
  const v = verticalFovForHorizontal(90, 16 / 9);
  assert.ok(Math.abs(v - 58.72) < 0.1, `vertical fov was ${v}`);
  // Square aspect: identical.
  assert.ok(Math.abs(verticalFovForHorizontal(90, 1) - 90) < 1e-9);
});

test('the renderer camera mapping still matches GoldSrc forward vectors', () => {
  // Same check as the physics suite, kept here so both suites fail loudly if the
  // conversion in boxGeometry.ts or renderer.ts drifts.
  for (const [pitch, yaw] of [
    [0, 0],
    [45, 90],
    [-45, 200],
  ] as [number, number][]) {
    const forward = v3();
    const right = v3();
    const up = v3();
    angleVectors(pitch, yaw, 0, forward, right, up);
    const want = toThree(forward.x, forward.y, forward.z);

    const phi = (-pitch * Math.PI) / 180;
    const theta = (yaw * Math.PI) / 180 - Math.PI / 2;
    const got = [-Math.cos(phi) * Math.sin(theta), Math.sin(phi), -Math.cos(phi) * Math.cos(theta)];

    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(got[i]! - want[i]!) < 1e-9, `axis ${i} mismatch at pitch=${pitch} yaw=${yaw}`);
    }
  }
});

// 功能：验证第三人称观战镜头在队友身后，墙体挡住时不会穿出地图。时间：2026-09-29；作者：lq。
test('spectator camera follows from behind and stops before a wall', () => {
  const map = makeTestRoom(512);
  const actor = createActor({
    name: 'teammate', team: 'ct', isBot: true, spawn: v3(0, 0, 40), yaw: 0,
    weapons: { 1: 'm4a1', 2: 'usp45', 3: 'knife' },
  });
  const open = spectatorCameraPose(actor, map.collision);
  assert.ok(open.origin.x < actor.move.origin.x - 80);
  assert.ok(open.pitch > 0);
  actor.move.origin = v3(-230, 0, 40);
  const blocked = spectatorCameraPose(actor, map.collision);
  assert.ok(blocked.origin.x > -256 && blocked.origin.x < actor.move.origin.x);
});
