/** 功能：集中处理默认 5V5、设置持久化数据校验和地图人数上限。时间：2026-10-10；作者：lq。 */
import type { Team } from './actors.ts';
import type { MapSpawn } from './map/build.ts';

// 功能：浏览器对局默认十人，最多十二人，避免机器人与人物渲染数量无限增长。时间：2026-10-10；作者：lq。
export const DEFAULT_TEAM_SIZE = 5;
export const MAX_TEAM_SIZE = 6;

/** 功能：保存玩家阵营、难度与双方机器人总数（不含玩家）。时间：2026-10-10；作者：lq。 */
export interface MatchSettings {
  team: Team;
  skill: number;
  bots: number;
}

/** 功能：读取有限数字，空值、对象和异常值均使用默认值。时间：2026-10-10；作者：lq。 */
export function settingNumber(value: unknown, fallback: number): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && value.trim() === '')) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 功能：损坏或不可用的旧设置不影响游戏启动，机器人数量按平衡双方规范化。时间：2026-10-10；作者：lq。 */
export function parseMatchSettings(raw: string | null): MatchSettings {
  let saved: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed as Record<string, unknown>;
  } catch { /* 功能：无效 JSON 使用默认设置。时间：2026-10-10；作者：lq。 */ }
  // 功能：旧面板的机器人滑块从未生效，旧版占位数量不覆盖新的默认 5V5。时间：2026-10-10；作者：lq。
  const requestedBots = saved.version === 2 ? saved.bots : DEFAULT_TEAM_SIZE * 2 - 1;
  const teamSize = Math.max(1, Math.min(MAX_TEAM_SIZE, Math.floor((settingNumber(requestedBots, DEFAULT_TEAM_SIZE * 2 - 1) + 1) / 2)));
  return { team: saved.team === 't' ? 't' : 'ct', skill: Math.max(0, Math.min(1, settingNumber(saved.skill, 0.15))),
    bots: teamSize * 2 - 1 };
}

/** 功能：按双方不重复出生点的较小数量限制人数，缺阵营地图保守限制为 1V1。时间：2026-10-10；作者：lq。 */
export function mapTeamSizeLimit(spawns: MapSpawn[]): number {
  const count = (team: Team): number => new Set(spawns.filter((spawn) => spawn.team === team)
    .map(({ origin }) => `${origin.x},${origin.y},${origin.z}`)).size;
  return Math.max(1, Math.min(MAX_TEAM_SIZE, count('ct'), count('t')));
}

/** 功能：URL 和保存设置均受地图与性能上限约束，双方各自占用独立出生点。时间：2026-10-10；作者：lq。 */
export function teamSizeForBots(bots: unknown, limit: number): number {
  return Math.max(1, Math.min(limit, Math.floor((settingNumber(bots, DEFAULT_TEAM_SIZE * 2 - 1) + 1) / 2)));
}
