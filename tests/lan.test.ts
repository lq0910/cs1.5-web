/** 功能：验证房主多人席位、输入路由、快照和局域网事件引用；时间：2026-11-17；作者：lq。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestRoom } from '../src/game/map/build.ts';
import { Match, idleCommand } from '../src/game/match.ts';
import { snapshotWorld, applySnapshot, encodeEvents, decodeEvents, mapFingerprint } from '../src/net/protocol.ts';
import { IN_FORWARD, TICK_INTERVAL } from '../src/game/constants.ts';

test('LAN seats are controlled by player IDs and survive a snapshot round-trip', () => {
  const map = makeTestRoom(1024);
  const host = new Match({ map, graph: null, sites: [], teamSize: 2, multiplayer: true, seed: 14 });
  host.startNow();
  const ct = host.claimSeat('ct', 'Alice')!;
  const t = host.claimSeat('t', 'Bob')!;
  assert.ok(ct && t);
  assert.equal(ct.maxHealth, 100);
  assert.equal(ct.unlimitedFunds, false);
  assert.equal(host.claimSeat('ct', 'Charlie')?.team, 'ct');

  const command = { ...idleCommand(ct.yaw), buttons: IN_FORWARD, forwardmove: 400 };
  for (let tick = 1; tick <= 20; tick++) {
    host.update(tick * TICK_INTERVAL, undefined, new Map([[ct.id, command], [t.id, idleCommand(t.yaw)]]));
  }
  assert.ok(ct.move.origin.x !== map.spawns[0]!.origin.x || ct.move.origin.y !== map.spawns[0]!.origin.y);

  const wireEvents = encodeEvents(host.update(21 * TICK_INTERVAL));
  const snapshot = JSON.parse(JSON.stringify(snapshotWorld(host, 21, 21 * TICK_INTERVAL, [], [wireEvents], 3))) as ReturnType<typeof snapshotWorld>;
  assert.equal(snapshot.generation, 3);
  const before = ct.move.origin.x;
  ct.move.origin.x += 20;
  applySnapshot(host, snapshot);
  assert.equal(ct.move.origin.x, before);
  assert.equal(decodeEvents(wireEvents, host.actors).shots.length, 0);
});

// 功能：重开后真人保持原席位与昵称，客户端按新代数接收第一回合且不继承旧经济；时间：2026-11-17；作者：lq。
test('LAN restart keeps connected seats and synchronizes a fresh game', () => {
  const map = makeTestRoom(1024);
  const host = new Match({ map, graph: null, sites: [], teamSize: 1, multiplayer: true, seed: 14 });
  host.startNow();
  const ct = host.claimSeat('ct', 'Alice')!;
  const t = host.claimSeat('t', 'Bob')!;
  const viewer = new Match({ map: makeTestRoom(1024), graph: null, sites: [], teamSize: 1 });
  host.mode.round = 18;
  host.mode.matchOver = true;
  host.mode.score.ct = 16;
  ct.money = 16000;
  ct.kills = 20;
  t.alive = false;
  t.health = 0;
  host.restartNow(100);
  assert.equal(host.actors.find((actor) => actor.id === ct.id), ct);
  assert.equal(ct.name, 'Alice');
  assert.equal(t.name, 'Bob');
  assert.equal(ct.isBot, false);
  assert.equal(t.isBot, false);
  assert.equal(ct.health, 100);
  assert.equal(t.health, 100);
  assert.equal(ct.money, 800);
  assert.equal(ct.kills, 0);
  assert.equal(ct.combat.loadout[1].id, 'knife');
  const snapshot = JSON.parse(JSON.stringify(snapshotWorld(host, 6400, 100, [], [], 1)));
  applySnapshot(viewer, snapshot);
  assert.deepEqual(viewer.mode.score, { ct: 0, t: 0 });
  assert.equal(viewer.mode.round, 1);
  assert.equal(viewer.mode.matchOver, false);
  assert.equal(viewer.actors.find((actor) => actor.id === t.id)?.alive, true);
  host.restartNow(101);
  assert.equal(host.mode.round, 1);
  assert.equal(host.actors.length, 2);
});

test('map fingerprints include both content bytes and map length', () => {
  assert.equal(mapFingerprint(new Uint8Array([1, 2, 3])), mapFingerprint(new Uint8Array([1, 2, 3])));
  assert.notEqual(mapFingerprint(new Uint8Array([1, 2, 3])), mapFingerprint(new Uint8Array([1, 2, 4])));
});
