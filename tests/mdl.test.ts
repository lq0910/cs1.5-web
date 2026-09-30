/**
 * Studio model parser tests, run against the *real* Counter-Strike 1.5 models
 * extracted from the user's local install.
 *
 * The important check is geometric: studio vertices are stored in bone-local
 * space, so if the skeleton accumulation or the struct offsets were wrong, the
 * assembled model would explode into a scattered cloud of triangles. Asserting
 * that the assembled bounding box is a sensible size proves the bone chain,
 * the vertex/bone-index arrays and the mesh offsets all line up.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { parseMdl, findSequence } from '../src/engine/mdl/parser.ts';

const MODELS = 'public/cstrike/models';

function load(path: string) {
  return parseMdl(new Uint8Array(readFileSync(path)));
}

/** Bounding box of every vertex after applying its bone's bind-pose transform. */
function assembledBox(mdl: ReturnType<typeof parseMdl>) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  for (const part of mdl.bodyParts) {
    for (const model of part.models) {
      for (let v = 0; v < model.vertices.length; v++) {
        const vertex = model.vertices[v]!;
        const bone = mdl.bones[model.boneIndices[v] ?? 0] ?? mdl.bones[0]!;
        // v' = R * v + bonePosition
        const [x, y, z, w] = bone.worldRotation;
        const [vx, vy, vz] = vertex;
        const tx = 2 * (y * vz - z * vy);
        const ty = 2 * (z * vx - x * vz);
        const tz = 2 * (x * vy - y * vx);
        const world = [
          vx + w * tx + (y * tz - z * ty) + bone.worldPosition[0],
          vy + w * ty + (z * tx - x * tz) + bone.worldPosition[1],
          vz + w * tz + (x * ty - y * tx) + bone.worldPosition[2],
        ];
        for (let axis = 0; axis < 3; axis++) {
          if (world[axis]! < min[axis]!) min[axis] = world[axis]!;
          if (world[axis]! > max[axis]!) max[axis] = world[axis]!;
        }
      }
    }
  }
  return { min, max, size: [max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!] };
}

test('the AK-47 view model parses into a reasonably sized, assembled weapon', (t) => {
  const path = `${MODELS}/v_ak47.mdl`;
  if (!existsSync(path)) {
    t.skip('local CS 1.5 models are not installed');
    return;
  }

  const mdl = load(path);
  assert.equal(mdl.version, 10);
  assert.match(mdl.name, /ak47/i);
  assert.equal(mdl.bones.length, 42, 'AK-47 has 42 bones');
  assert.equal(mdl.bodyParts.length, 1);
  assert.equal(mdl.bodyParts[0]!.models.length, 1);

  const model = mdl.bodyParts[0]!.models[0]!;
  assert.equal(model.meshes.length, 10, 'ten meshes (body, clip, slide...)');
  assert.equal(model.numVertices, 550);
  assert.ok(mdl.totalTriangles > 500, `triangle count was ${mdl.totalTriangles}`);
  assert.equal(model.boneIndices.length, model.vertices.length);

  // Triangle records: 24 bytes, four shorts per corner in the order
  // s, t, vertex, normal. Every decoded corner must reference a real vertex,
  // and each mesh must have produced triangles.
  for (const mesh of model.meshes) {
    assert.ok(mesh.triangles.length > 0, 'a mesh decoded to no triangles');
    for (const corners of mesh.triangles) {
      assert.equal(corners.length, 3);
      for (const corner of corners) {
        assert.ok(corner.vertex >= 0 && corner.vertex < model.numVertices);
        // Normal indices are scoped to the *model*, not the mesh: the mesh's own
        // numnorms/normindex are the software renderer's "peak normals", which is
        // a different table (mesh0 declares 12 while its corners use index 125).
        assert.ok(
          corner.normal >= 0 && corner.normal < model.normals.length,
          `normal index ${corner.normal} outside ${model.normals.length} model normals`,
        );
      }
    }
  }
  // Adjacent vertices are within a few units: a correct decode connects nearby
  // points, a wrong one throws triangles across the whole model.
  const spans: number[] = [];
  for (const mesh of model.meshes) {
    for (const corners of mesh.triangles) {
      const v = corners.map((c) => c.vertex);
      spans.push(Math.max(...v) - Math.min(...v));
    }
  }
  spans.sort((a, b) => a - b);
  assert.ok(spans[Math.floor(spans.length / 2)]! < 40, 'triangle vertex spread is far too wide');

  // Every bone index must be in range.
  for (const index of model.boneIndices) {
    assert.ok(index < mdl.bones.length, `bone index ${index} out of range`);
  }

  // View models store their vertices in model space already: the raw cloud is a
  // rifle (long, narrow, shallow). Applying the bind pose instead scatters it -
  // the previewer renders both, and only the raw one looks like a weapon.
  const raw = model.vertices;
  const rawMin = [Infinity, Infinity, Infinity];
  const rawMax = [-Infinity, -Infinity, -Infinity];
  for (const v of raw) {
    for (let a = 0; a < 3; a++) {
      if (v[a]! < rawMin[a]!) rawMin[a] = v[a]!;
      if (v[a]! > rawMax[a]!) rawMax[a] = v[a]!;
    }
  }
  const rawSize = [0, 1, 2].map((a) => rawMax[a]! - rawMin[a]!);
  rawSize.sort((a, b) => b - a);
  assert.ok(rawSize[0]! > 20 && rawSize[0]! < 60, `rifle length ${rawSize[0]!.toFixed(0)}`);
  assert.ok(rawSize[2]! < 12, `rifle thickness ${rawSize[2]!.toFixed(0)} should be thin`);

  // Textures: the AK's ten textures come with an embedded palette.
  assert.equal(mdl.textures.length, 10);
  assert.equal(mdl.textures[0]!.width, 128);
  assert.equal(mdl.textures[0]!.height, 92);
  assert.equal(mdl.textures[0]!.hasPalette, true);

  // The palette must produce more than one colour (not a decoding failure).
  const colours = new Set<string>();
  const rgba = mdl.textures[0]!.rgba;
  for (let i = 0; i + 3 < rgba.length; i += 4 * 97) {
    colours.add(`${rgba[i]},${rgba[i + 1]},${rgba[i + 2]}`);
  }
  assert.ok(colours.size > 4, `the texture decoded to ${colours.size} distinct colours`);
});

test('the player model parses with its skeleton, skins and animations', (t) => {
  const path = `${MODELS}/player/urban/urban.mdl`;
  if (!existsSync(path)) {
    t.skip('local CS 1.5 player models are not installed');
    return;
  }

  const mdl = load(path);
  assert.equal(mdl.bones.length, 53, 'the CS player skeleton has 53 bones');
  assert.equal(mdl.sequences.length, 95, 'and 95 animation sequences');
  assert.equal(mdl.bodyParts.length, 2, 'body + something extra (head/gear)');
  assert.equal(mdl.hitboxes.length, 20, 'hitboxes drive the damage model');

  const box = assembledBox(mdl);
  // A player is about 72 units tall and 32 wide.
  assert.ok(box.size[2] > 40 && box.size[2] < 120, `player height ${box.size[2].toFixed(0)}`);
  assert.ok(box.size[0] < 120 && box.size[1] < 120, `player footprint ${box.size[0].toFixed(0)}x${box.size[1].toFixed(0)}`);

  assert.equal(mdl.textures.length, 2);
  assert.equal(mdl.textures[0]!.width, 512);
  assert.equal(mdl.textures[0]!.height, 512);

  // Animation lookups the AI will need.
  const idle = findSequence(mdl, 'idle');
  assert.ok(idle, 'expected an idle animation');
  assert.ok(idle!.numFrames > 0);
  assert.ok(mdl.sequences.some((s) => /run/i.test(s.label)), 'expected a run animation');
  assert.ok(mdl.sequences.some((s) => /shoot/i.test(s.label)), 'expected shooting animations');

  // Skin families map skin references to textures.
  assert.ok(mdl.skinFamilies.length >= 1);
  assert.equal(mdl.skinFamilies[0]!.length, 2);
});

test('the parser rejects data that is not a studio model', () => {
  assert.throws(() => parseMdl(new Uint8Array(256)), /studio/);
  const wrongVersion = new Uint8Array(256);
  wrongVersion.set([0x49, 0x44, 0x53, 0x54], 0); // IDST
  new DataView(wrongVersion.buffer).setInt32(4, 6, true);
  assert.throws(() => parseMdl(wrongVersion), /version/);
});
