/** 功能：集中处理默认 5V5、分阵营人数、设置持久化校验和地图人数上限。时间：2026-10-21；作者：lq。 */
import type { Team } from './actors.ts';
import type { MapSpawn } from './map/build.ts';

// 功能：浏览器对局默认十人，每队最多六人，避免机器人与人物渲染数量无限增长。时间：2026-10-21；作者：lq。
export const DEFAULT_TEAM_SIZE = 5;
export const MAX_TEAM_SIZE = 6;

/** 功能：每队人数均包含玩家自己；玩家所在阵营为 1 时表示独自作战。时间：2026-10-21；作者：lq。 */
export interface TeamSizes {
  ct: number;
  t: number;
}

/** 功能：保存玩家阵营、难度、双方人数与地图小鸡开关。时间：2026-10-21；作者：lq。 */
export interface MatchSettings {
  team: Team;
  skill: number;
  ctSize: number;
  tSize: number;
  /** 功能：是否在每回合随机放置可射击的小鸡。时间：2026-10-21；作者：lq。 */
  critters: boolean;
}

/** 功能：读取有限数字，空值、对象和异常值均使用默认值。时间：2026-10-10；作者：lq。 */
export function settingNumber(value: unknown, fallback: number): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && value.trim() === '')) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 功能：单队人数只允许 1..6 的整数，异常输入回退到默认值。时间：2026-10-21；作者：lq。 */
function teamSizeSetting(value: unknown, fallback: number): number {
  return Math.max(1, Math.min(MAX_TEAM_SIZE, Math.floor(settingNumber(value, fallback))));
}

/** 功能：损坏或不可用的旧设置不影响游戏启动，旧版平衡人数自动迁移为双方人数。时间：2026-10-21；作者：lq。 */
export function parseMatchSettings(raw: string | null): MatchSettings {
  let saved: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed as Record<string, unknown>;
  } catch { /* 功能：无效 JSON 使用默认设置。时间：2026-10-10；作者：lq。 */ }
  let ctSize = DEFAULT_TEAM_SIZE;
  let tSize = DEFAULT_TEAM_SIZE;
  let critters = true;
  if (saved.version === 3) {
    // 功能：新版本分别保存两队人数，并保留地图小鸡开关。时间：2026-10-21；作者：lq。
    ctSize = teamSizeSetting(saved.ctSize, DEFAULT_TEAM_SIZE);
    tSize = teamSizeSetting(saved.tSize, DEFAULT_TEAM_SIZE);
    critters = saved.critters !== false;
  } else if (saved.version === 2) {
    // 功能：旧版只有一个平衡人数滑块，迁移为双方相同人数。时间：2026-10-21；作者：lq。
    const size = teamSizeForBots(saved.bots, MAX_TEAM_SIZE);
    ctSize = size;
    tSize = size;
  }
  // 功能：旧面板的机器人滑块从未生效，无版本号的占位数量不覆盖新的默认 5V5。时间：2026-10-10；作者：lq。
  return {
    team: saved.team === 't' ? 't' : 'ct',
    skill: Math.max(0, Math.min(1, settingNumber(saved.skill, 0.15))),
    ctSize,
    tSize,
    critters,
  };
}

/** 功能：分别统计双方不重复出生点，缺阵营的地图保守限制为 1 人。时间：2026-10-21；作者：lq。 */
export function mapTeamSizeLimits(spawns: MapSpawn[]): TeamSizes {
  const count = (team: Team): number => new Set(spawns.filter((spawn) => spawn.team === team)
    .map(({ origin }) => `${origin.x},${origin.y},${origin.z}`)).size;
  return {
    ct: Math.max(1, Math.min(MAX_TEAM_SIZE, count('ct'))),
    t: Math.max(1, Math.min(MAX_TEAM_SIZE, count('t'))),
  };
}

/** 功能：兼容旧的平衡人数容量，返回双方都能容纳的最小人数。时间：2026-10-10；作者：lq。 */
export function mapTeamSizeLimit(spawns: MapSpawn[]): number {
  const limits = mapTeamSizeLimits(spawns);
  return Math.max(1, Math.min(limits.ct, limits.t));
}

/** 功能：URL、存档和设置面板的人数都受各自阵营的地图容量限制。时间：2026-10-21；作者：lq。 */
export function clampTeamSizes(
  ct: unknown,
  t: unknown,
  limits: TeamSizes,
  fallback: TeamSizes = { ct: DEFAULT_TEAM_SIZE, t: DEFAULT_TEAM_SIZE },
): TeamSizes {
  return {
    ct: Math.max(1, Math.min(limits.ct, Math.floor(settingNumber(ct, fallback.ct)))),
    t: Math.max(1, Math.min(limits.t, Math.floor(settingNumber(t, fallback.t)))),
  };
}

/** 功能：旧版 URL 的 BOT 总数按平衡对局换算成单队人数，且不超过地图上限。时间：2026-10-10；作者：lq。 */
export function teamSizeForBots(bots: unknown, limit: number): number {
  return Math.max(1, Math.min(limit, Math.floor((settingNumber(bots, DEFAULT_TEAM_SIZE * 2 - 1) + 1) / 2)));
}
