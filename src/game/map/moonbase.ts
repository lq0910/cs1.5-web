/**
 * 功能：月球基地原创双包点地图；月壤外场、反应堆实验室、登月坪与双层观测桥组成三路回环。
 * 时间：2026-11-17；作者：lq。
 */
import { v3 } from '../../engine/math.ts';
import type { Vec3 } from '../../engine/math.ts';
import type { BoxDef } from '../../engine/collision/brush.ts';
import type { MapData, MapSpawn } from './build.ts';
import type { ObjectiveArea } from '../objectives.ts';
import { box, wallWithHoles } from './build.ts';
import { MoonbaseWorld, MOONBASE_LAUNCH_PADS } from './moonbaseInteractions.ts';

/** 功能：提供菜单、无头模拟和渲染共同使用的地图标识及包点；时间：2026-11-17；作者：lq。 */
export const MOONBASE_ID = 'moonbase';
export const MOONBASE_SITES: ObjectiveArea[] = [
  { name: 'A', center: v3(-1008, 96, 36), mins: v3(-1232, -192, 0), maxs: v3(-816, 256, 96) },
  { name: 'B', center: v3(960, -96, 52), mins: v3(784, -288, 16), maxs: v3(1248, 96, 112) },
];

/** 功能：密封舱内保留标准重力，室外用 300 重力形成约 115 单位的战术跳跃；时间：2026-11-17；作者：lq。 */
export function moonbaseGravityAt(point: Vec3): number {
  const laboratory = point.x > -1376 && point.x < -704 && Math.abs(point.y) < 416 && point.z < 224;
  const habitat = Math.abs(point.x) < 416 && Math.abs(point.y) > 960 && Math.abs(point.y) < 1248 && point.z < 192;
  return laboratory || habitat ? 800 : 300;
}

/** 功能：以真实碰撞盒制作地形，装饰灯带不参与碰撞，避免 BOT 被小物件卡住；时间：2026-11-17；作者：lq。 */
export function buildMoonbase(): MapData {
  const boxes: BoxDef[] = [];
  const add = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, material: string, solid = true): void => {
    boxes.push({ ...box(v3(x0, y0, z0), v3(x1, y1, z1), material), solid });
  };
  const wall = (axis: 'x' | 'y', from: number, to: number, lo: number, hi: number, top: number,
    openings: { from: number; to: number; bottom: number; top: number }[], material = 'luna_shell'): void => {
    boxes.push(...wallWithHoles(axis, from, to, lo, hi, 0, top, openings, material));
  };

  // 功能：封闭月壤场地与外圈岩壁，边界高度超过低重力最大跳跃，避免出界；时间：2026-11-17；作者：lq。
  add(-1536, -1280, -32, 1536, 1280, 0, 'luna_dust');
  add(-1584, -1328, -32, -1536, 1328, 384, 'luna_rock');
  add(1536, -1328, -32, 1584, 1328, 384, 'luna_rock');
  add(-1536, -1328, -32, 1536, -1280, 384, 'luna_rock');
  add(-1536, 1280, -32, 1536, 1328, 384, 'luna_rock');

  // 功能：南北出生舱正门及侧门提供三路分流，舱内有完整顶棚和原版机柜；时间：2026-11-17；作者：lq。
  for (const side of [-1, 1]) {
    const front = side * 960;
    const back = side * 1248;
    wall('x', -416, 416, Math.min(front, front + side * 16), Math.max(front, front + side * 16), 192,
      [{ from: -128, to: 128, bottom: 0, top: 144 }]);
    for (const x of [-416, 400]) wall('y', Math.min(front, back), Math.max(front, back), x, x + 16, 192,
      [{ from: Math.min(side * 1024, side * 1184), to: Math.max(side * 1024, side * 1184), bottom: 0, top: 128 }]);
    add(-416, Math.min(front, back), 192, 416, Math.max(front, back), 208, 'luna_shell');
    add(-128, Math.min(front, front + side * 4), 140, 128, Math.max(front, front + side * 4), 148, 'luna_cyan', false);
    add(-376, Math.min(side * 1008, side * 1088), 0, -304, Math.max(side * 1008, side * 1088), 88, 'luna_console');
  }

  // 功能：A 反应堆实验室以北、南、东三扇气闸连通；西侧维护道是可蹲行的绕后捷径；时间：2026-11-17；作者：lq。
  for (const y of [-416, 400]) wall('x', -1376, -704, y, y + 16, 224,
    [{ from: -1152, to: -960, bottom: 0, top: 160 }]);
  wall('y', -416, 416, -720, -704, 224, [{ from: -144, to: 144, bottom: 0, top: 160 }]);
  wall('y', -416, 416, -1376, -1360, 224, [{ from: -96, to: 96, bottom: 0, top: 44 }]);
  add(-1376, -416, 224, -704, 416, 240, 'luna_shell');
  add(-1360, -400, 0, -720, 400, 2, 'luna_floor', false);
  add(-1456, -512, 44, -1376, 512, 64, 'luna_duct');
  add(-1472, -512, 0, -1456, 512, 96, 'luna_metal');
  add(-1344, -128, 0, -1248, 160, 112, 'luna_metal');
  add(-1328, 224, 0, -1248, 368, 80, 'luna_console');
  add(-864, -368, 0, -752, -272, 96, 'luna_crate');
  add(-1088, -96, 0, -1008, -16, 64, 'luna_metal');
  add(-1084, -92, 64, -1012, -20, 108, 'luna_cyan');
  add(-1100, -108, 108, -996, -4, 120, 'luna_metal');

  // 功能：B 登月坪用低矮台阶保证 BOT 可达；登月舱实体同时提供两侧掩体；时间：2026-11-17；作者：lq。
  add(736, -384, 0, 1376, 384, 16, 'luna_floor');
  add(1104, 112, 16, 1248, 256, 160, 'luna_shell');
  add(1088, 96, 144, 1264, 272, 176, 'luna_metal');
  add(1128, 136, 176, 1224, 232, 224, 'luna_gold');
  for (const x of [1056, 1264]) for (const y of [64, 272]) {
    add(x, y, 16, x + 32, y + 32, 72, 'luna_metal');
    add(x - 8, y - 8, 16, x + 40, y + 40, 24, 'luna_gold');
  }
  add(800, 192, 16, 880, 304, 80, 'luna_crate');
  add(1280, -272, 16, 1344, -128, 96, 'luna_crate');

  // 功能：中央观测桥上下均可交战，南北楼梯连通高台，桥两侧可低重力跳上货箱再上桥；时间：2026-11-17；作者：lq。
  add(-640, -128, 144, 640, 128, 160, 'luna_floor');
  add(-192, -176, 0, 192, 176, 112, 'luna_metal');
  add(-160, -152, 112, 160, 152, 120, 'luna_console');
  for (const x of [-640, 608]) for (const y of [-128, 96]) add(x, y, 0, x + 32, y + 32, 144, 'luna_metal');
  for (let step = 0; step < 10; step++) {
    // 功能：踏面偏移导航网格 16 单位，防止采样中心正好压住立面导致楼梯断路；时间：2026-11-17；作者：lq。
    add(-640, -784 + step * 64, 0, -448, -720 + step * 64, (step + 1) * 16, 'luna_floor');
    add(448, 720 - step * 64, 0, 640, 784 - step * 64, (step + 1) * 16, 'luna_floor');
  }
  add(-640, -144, 0, -448, -128, 160, 'luna_floor');
  add(448, 128, 0, 640, 144, 160, 'luna_floor');
  for (const x of [-384, 288]) {
    add(x, -128, 160, x + 96, -112, 208, 'luna_metal');
    add(x, 112, 160, x + 96, 128, 208, 'luna_metal');
  }
  add(-448, 224, 0, -352, 320, 64, 'luna_crate');
  add(352, -320, 0, 448, -224, 64, 'luna_crate');

  // 功能：错列货柜和岩石切断出生点直线视野，让外场进攻可换线而不受单一狙击线压制；时间：2026-11-17；作者：lq。
  for (const [x, y, width, depth, height] of [
    [-832, -816, 192, 96, 112], [640, 720, 192, 96, 112],
    [-1136, 688, 128, 176, 96], [992, -864, 128, 176, 96],
    [-288, -768, 176, 80, 96], [112, 688, 176, 80, 96],
    [416, -720, 128, 96, 64], [-544, 624, 128, 96, 64],
  ]) add(x!, y!, 0, x! + width!, y! + depth!, height!, 'luna_crate');
  for (const [x, y] of [[-1280, -864], [1248, 800], [-64, -544], [64, 512]]) {
    add(x! - 64, y! - 48, 0, x! + 64, y! + 48, 64, 'luna_rock');
    add(x! - 40, y! - 32, 64, x! + 40, y! + 32, 96, 'luna_rock');
  }

  // 功能：连续地面灯带和门框区分 A 冷蓝线路、B 琥珀线路，装饰不阻挡射线和移动；时间：2026-11-17；作者：lq。
  for (const side of [-1, 1]) for (let i = 0; i < 6; i++) {
    const y = -880 + i * 320;
    add(side * 656 - 3, y, 1, side * 656 + 3, y + 144, 3, side < 0 ? 'luna_cyan' : 'luna_gold', false);
  }
  for (const y of [-416, 416]) add(-1152, y - 2, 156, -960, y + 2, 164, 'luna_cyan', false);
  // 功能：弹射平台的八单位底座可直接走上，关机状态仍是普通地形；时间：2026-11-17；作者：lq。
  for (const { center } of MOONBASE_LAUNCH_PADS) add(center.x - 64, center.y - 64, 0, center.x + 64, center.y + 64, 8, 'luna_floor');

  // 功能：六个互不重叠的阵营出生点可支持 6V6，双方朝向基地中心；时间：2026-11-17；作者：lq。
  const spawns: MapSpawn[] = [];
  for (const side of [-1, 1]) for (let i = 0; i < 6; i++) spawns.push({
    // 功能：首个出生点对准正门，默认开局按 W 即可走出出生舱；时间：2026-11-17；作者：lq。
    origin: v3([0, -192, 192][i % 3]!, side * (1064 + Math.floor(i / 3) * 112), 37),
    yaw: side < 0 ? 90 : 270,
    team: side < 0 ? 't' : 'ct',
  });
  const collision = new MoonbaseWorld(boxes, moonbaseGravityAt);
  return {
    id: MOONBASE_ID,
    fingerprint: 'moonbase-v1',
    name: '月球基地 · LUNA-15',
    bounds: { mins: v3(-1536, -1280, -32), maxs: v3(1536, 1280, 512) },
    boxes, collision, interactions: collision, spawns, sites: MOONBASE_SITES,
    skyColor: 0x03060e, fogColor: 0x101824,
  };
}
