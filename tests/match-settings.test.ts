/** 功能：验证默认 5V5、分阵营人数、地图容量及损坏设置的安全回退，不启动浏览器。时间：2026-10-21；作者：lq。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampTeamSizes, mapTeamSizeLimit, mapTeamSizeLimits, parseMatchSettings, teamSizeForBots } from '../src/game/matchSettings.ts';
import { Match } from '../src/game/match.ts';
import { makeTestRoom } from '../src/game/map/build.ts';
import type { MapSpawn } from '../src/game/map/build.ts';

/** 功能：构建双方独立且间距足够的测试出生点。时间：2026-10-10；作者：lq。 */
function spawns(ctCount: number, tCount: number): MapSpawn[] {
  return (['ct', 't'] as const).flatMap((team) => Array.from({ length: team === 'ct' ? ctCount : tCount }, (_, index) => ({
    team, yaw: 0, origin: { x: team === 'ct' ? -512 : 512, y: index * 64, z: 36 },
  })));
}

const defaults = { team: 'ct', skill: 0.15, ctSize: 5, tSize: 5, critters: true } as const;

// 功能：默认九名机器人加一名玩家，生成双方各五人。时间：2026-10-10；作者：lq。
test('default settings create a 5V5 match with nine bots', () => {
  assert.deepEqual(parseMatchSettings(null), defaults);
  const map = { ...makeTestRoom(2048), spawns: spawns(8, 8) };
  const match = new Match({ map, graph: null, sites: [] });
  assert.equal(match.actors.length, 10);
  assert.equal(match.actors.filter((actor) => actor.isBot).length, 9);
  for (const team of ['ct', 't']) assert.equal(match.actors.filter((actor) => actor.team === team).length, 5);
});

// 功能：双方容量分别统计，重复出生点不扩大容量，单队最多六人。时间：2026-10-21；作者：lq。
test('map capacity counts each team separately and obeys the performance ceiling', () => {
  assert.deepEqual(mapTeamSizeLimits(spawns(4, 12)), { ct: 4, t: 6 });
  assert.deepEqual(mapTeamSizeLimits(spawns(16, 3)), { ct: 6, t: 3 });
  assert.equal(mapTeamSizeLimit(spawns(4, 12)), 4);
  assert.equal(mapTeamSizeLimit(spawns(16, 16)), 6);
  const points = spawns(2, 3);
  assert.equal(mapTeamSizeLimit([...points, points[0]!, points[0]!]), 2);
  assert.equal(mapTeamSizeLimit(spawns(0, 8)), 1);
  assert.equal(mapTeamSizeLimit([]), 1);
  const match = new Match({ map: { ...makeTestRoom(2048), spawns: points }, graph: null, sites: [] });
  assert.equal(match.actors.length, 4);
});

// 功能：恶意 URL、极端人数与小地图设置不会突破上限，偶数总 BOT 数归入较小平衡档。时间：2026-10-10；作者：lq。
test('requested bot counts are bounded and balanced', () => {
  assert.equal(teamSizeForBots('99999', 6), 6);
  assert.equal(teamSizeForBots(9, 3), 3);
  assert.equal(teamSizeForBots('-5', 6), 1);
  assert.equal(teamSizeForBots('8', 6), 4);
  assert.equal(teamSizeForBots('not-a-number', 6), 5);
  assert.equal(teamSizeForBots(null, 6), 5);
  assert.deepEqual(clampTeamSizes('99', '-5', { ct: 4, t: 2 }), { ct: 4, t: 1 });
  assert.deepEqual(clampTeamSizes(null, undefined, { ct: 6, t: 6 }), { ct: 5, t: 5 });
});

// 功能：玩家所在阵营可以只留玩家自己，敌方仍保留完整 BOT 队伍。时间：2026-10-21；作者：lq。
test('each team size is independent and the player can fight alone', () => {
  const map = { ...makeTestRoom(2048), spawns: spawns(8, 8) };
  const solo = new Match({ map, graph: null, sites: [], ctSize: 1, tSize: 5, playerTeam: 'ct' });
  assert.equal(solo.actors.length, 6);
  assert.equal(solo.actors.filter((actor) => actor.team === 'ct').length, 1);
  assert.equal(solo.actors.filter((actor) => actor.team === 't').length, 5);
  assert.equal(solo.actors.filter((actor) => actor.isBot).length, 5);
  assert.equal(solo.player?.team, 'ct');
  assert.equal(solo.actors.filter((actor) => actor.team === 'ct' && actor.isBot).length, 0);

  const soloT = new Match({ map, graph: null, sites: [], ctSize: 5, tSize: 1, playerTeam: 't' });
  assert.equal(soloT.player?.team, 't');
  assert.equal(soloT.actors.filter((actor) => actor.team === 't').length, 1);
  assert.equal(soloT.actors.filter((actor) => actor.team === 'ct').length, 5);
});

// 功能：保存的设置准确回显，旧版平衡人数自动迁移，JSON 损坏及非法值均有合理结果。时间：2026-10-21；作者：lq。
test('saved settings persist choices and recover from malformed values', () => {
  assert.deepEqual(parseMatchSettings('{"version":2,"team":"t","skill":"0.75","bots":"7"}'), {
    team: 't', skill: 0.75, ctSize: 4, tSize: 4, critters: true,
  });
  assert.deepEqual(parseMatchSettings('{"version":3,"team":"t","skill":"0.45","ctSize":"1","tSize":"6","critters":false}'), {
    team: 't', skill: 0.45, ctSize: 1, tSize: 6, critters: false,
  });
  for (const raw of ['broken', 'null', '[]', '{"bots":null,"skill":null}', '{"bots":" ","skill":""}']) {
    assert.deepEqual(parseMatchSettings(raw), defaults);
  }
  // 功能：旧面板保存的占位人数不影响新默认人数。时间：2026-10-10；作者：lq。
  assert.deepEqual(parseMatchSettings('{"team":"t","skill":0.45,"bots":3}'), { ...defaults, team: 't', skill: 0.45 });
  assert.deepEqual(parseMatchSettings('{"version":2,"team":"other","skill":9,"bots":9999}'), {
    ...defaults, skill: 1, ctSize: 6, tSize: 6,
  });
  // 功能：版本 3 的越界人数被单独收敛，缺失小鸡字段默认开启。时间：2026-10-21；作者：lq。
  assert.deepEqual(parseMatchSettings('{"version":3,"ctSize":0,"tSize":99}'), {
    ...defaults, ctSize: 1, tSize: 6,
  });
});
