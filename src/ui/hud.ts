/**
 * In-game HUD: physics readout, weapon/ammo, health/armor, the dynamic
 * crosshair, round state, kill feed and the buy menu.
 */

import type { Vec3 } from '../engine/math.ts';

export interface KillFeedLine {
  killer: string;
  victim: string;
  weapon: string;
  headshot: boolean;
}

export interface HudData {
  fps: number;
  tickRate: number;
  mapName: string;
  mapNote: string;
  origin: Vec3;
  velocity: Vec3;
  speed: number;
  onground: boolean;
  ducked: boolean;
  noclip: boolean;
  stepUps: number;
  sensitivity: number;
  tickMs: number;
  weaponName: string;
  /** 功能：区分无限手雷库存与近战武器的无弹药状态。时间：2026-09-30；作者：lq。 */
  holdingGrenade?: boolean;
  ammo: number;
  reserve: number;
  reloading: boolean;
  health: number;
  armor: number;
  coneDeg: number;
  scoped: boolean;
  /** Round state. */
  phase: string;
  phaseTime: string;
  scoreCT: number;
  scoreT: number;
  aliveCT: number;
  aliveT: number;
  money: number;
  kills: number;
  deaths: number;
  bombStatus: string;
  /** 功能：显示安装、拆包进度与对应持续按键提示。时间：2026-09-30；作者：lq。 */
  objectiveAction?: string;
  killFeed: KillFeedLine[];
  buyMenuOpen: boolean;
  /** 功能：原版购买菜单先选择分类再按数字购买。时间：2026-09-29；作者：lq。 */
  buyCategory: string | null;
  buyItems: { digit: number; label: string; price: number; affordable: boolean }[];
  /** 功能：雷达显示队友与敌人相对玩家的位置，并携带阵营关系用于区分颜色。时间：2026-09-30；作者：lq。 */
  radarDots: { x: number; y: number; relation: 'ally' | 'enemy' }[];
  dead: boolean;
  /** 功能：阵亡观战对象、Tab 战绩和无线电字幕的数据。时间：2026-09-30；作者：lq。 */
  spectating: string | null;
  scoreboardOpen: boolean;
  scoreRows: { name: string; team: 'ct' | 't'; kills: number; deaths: number; alive: boolean; local: boolean }[];
  radioLine: string;
  respawnIn: number;
  matchOver: string | null;
  render: {
    webglVersion: number;
    drawCalls: number;
    triangles: number;
    materials: number;
  };
}

function fmt(value: number, width = 8, decimals = 1): string {
  return value.toFixed(decimals).padStart(width);
}

/** 功能：将战绩和无线电文本转义后写入 HTML，避免名称影响界面结构。时间：2026-09-29；作者：lq。 */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

export class Hud {
  private readonly element: HTMLElement;
  private readonly crosshair: HTMLElement;
  private readonly scope: HTMLElement;
  private readonly status: HTMLElement;
  private readonly roundBar: HTMLElement;
  private readonly feed: HTMLElement;
  private readonly buy: HTMLElement;
  private readonly centre: HTMLElement;
  private readonly radar: HTMLElement;
  private readonly scoreboard: HTMLElement;
  private readonly radioCaption: HTMLElement;

  constructor(options: {
    hud: HTMLElement;
    crosshair: HTMLElement;
    scope: HTMLElement;
    status: HTMLElement;
    roundBar: HTMLElement;
    feed: HTMLElement;
    buy: HTMLElement;
    centre: HTMLElement;
    radar: HTMLElement;
    scoreboard: HTMLElement;
    radioCaption: HTMLElement;
  }) {
    this.element = options.hud;
    this.crosshair = options.crosshair;
    this.scope = options.scope;
    this.status = options.status;
    this.roundBar = options.roundBar;
    this.feed = options.feed;
    this.buy = options.buy;
    this.centre = options.centre;
    this.radar = options.radar;
    this.scoreboard = options.scoreboard;
    this.radioCaption = options.radioCaption;
  }

  update(data: HudData): void {
    const lines = [
      `FPS ${String(Math.round(data.fps)).padStart(3)}   tick ${data.tickRate}Hz`,
      `map    ${data.mapName}`,
      `       ${data.mapNote}`,
      `origin ${fmt(data.origin.x)} ${fmt(data.origin.y)} ${fmt(data.origin.z)}`,
      `vel    ${fmt(data.velocity.x)} ${fmt(data.velocity.y)} ${fmt(data.velocity.z)}`,
      `speed  ${fmt(data.speed, 6)} u/s   ground ${data.onground ? 'YES' : 'no '}`,
      `spread ${data.coneDeg.toFixed(2)}°  ${data.scoped ? 'SCOPED' : ''}  duck ${data.ducked ? 'YES' : 'no'}`,
      `draw   webgl${data.render.webglVersion} ${data.render.drawCalls} calls, ${data.render.triangles} tris`,
      '',
      'WASD 移动 · Space 跳 · Ctrl 蹲 · Shift 走',
      '左键 开火 · 右键 开镜/刀捅 · R 换弹',
      // 功能：调试说明补充 G 丢枪与 E 拾取尸体枪械快捷键。时间：2026-09-29；作者：lq。
      '1/2/3 主副刀 · 4/5/6 三种雷 · Q/滚轮 切换 · G 丢枪 · E 拾枪 · B 购买 · Tab 战绩 · M 选队',
      'F 穿墙 · K 回出生点 · [ ] 灵敏度 · Esc 释放鼠标',
    ];
    this.element.textContent = lines.join('\n');

    // Dynamic crosshair.
    const gap = 4 + Math.min(48, data.coneDeg * 6.5);
    this.crosshair.style.setProperty('--gap', `${gap.toFixed(1)}px`);
    this.crosshair.classList.toggle('scoped', data.scoped || data.dead);
    this.scope.classList.toggle('on', data.scoped && !data.dead);
    // 功能：简化原版圆形雷达，中心为玩家，绿色点标记队友、红色点标记敌人。时间：2026-09-30；作者：lq。
    this.radar.innerHTML = '<span class="self"></span>' + data.radarDots.map((dot) =>
      `<span class="${dot.relation}" style="left:${Math.max(4, Math.min(96, dot.x)).toFixed(1)}%;top:${Math.max(4, Math.min(96, dot.y)).toFixed(1)}%"></span>`,
    ).join('');

    // Round bar.
    const bombClass =
      data.bombStatus.includes('已下包') ? 'armed' : data.bombStatus.includes('拆除') ? 'defused' : '';
    this.roundBar.innerHTML =
      `<span class="score ct">${data.aliveCT}</span>` +
      `<span class="clock ${bombClass}">${data.phaseTime}</span>` +
      `<span class="score t">${data.aliveT}</span>`;

    // Kill feed.
    this.feed.innerHTML = data.killFeed
      .map(
        (line) =>
          `<div class="entry"><b class="${line.killer === 'YOU' ? 'me' : ''}">${line.killer}</b>` +
          `<span class="w">${line.headshot ? '☠ ' : ''}${line.weapon}</span>` +
          `<b>${line.victim}</b></div>`,
      )
      .join('');

    // Ammo / vitals.
    // 功能：以经典 CS 风格分区显示生命、护甲、无限资金和弹药。时间：2026-09-29；作者：lq。
    // 功能：无限备用弹药显示 CS 风格的 ∞，保留当前弹匣数字与换弹反馈。时间：2026-09-30；作者：lq。
    const reserveText = Number.isFinite(data.reserve) ? String(data.reserve) : '∞';
    // 功能：无限手雷显示 ∞；近战武器仍保留无弹药的横线表示。时间：2026-09-30；作者：lq。
    const ammoText = Number.isFinite(data.ammo) ? `${data.ammo} <small>/ ${reserveText}</small>` : data.holdingGrenade ? '∞' : '—';
    this.status.innerHTML =
      `<span class="vitals"><span class="health">✚ <b>${Math.round(data.health)}</b></span><span class="armor">▣ <b>${Math.round(data.armor)}</b></span></span>` +
      `<span class="money">$${Number.isFinite(data.money) ? data.money : '∞'}</span>` +
      `<span class="ammo">${ammoText}</span>`;

    // 功能：按住 Tab 显示原版半透明战绩表，双方角色按击杀数排序，死亡者标为阵亡。时间：2026-09-30；作者：lq。
    this.scoreboard.classList.toggle('on', data.scoreboardOpen);
    if (data.scoreboardOpen) {
      const teamRows = (team: 'ct' | 't') => data.scoreRows.filter((row) => row.team === team)
        .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
        .map((row) => `<tr class="${row.alive ? '' : 'out'} ${row.local ? 'local' : ''}"><td>${escapeHtml(row.name)}${row.local ? ' *' : ''}</td><td>${row.kills}</td><td>${row.deaths}</td><td>${row.alive ? '存活' : '阵亡'}</td></tr>`).join('');
      this.scoreboard.innerHTML = `<div class="scoreboard-head">Counter-Strike · ${escapeHtml(data.mapName)}</div>` +
        `<div class="scoreboard-team ct">Counter-Terrorists <span>胜场 ${data.scoreCT}</span></div>` +
        `<table><thead><tr><th>玩家</th><th>击杀</th><th>阵亡</th><th>状态</th></tr></thead><tbody>${teamRows('ct')}</tbody></table>` +
        `<div class="scoreboard-team t">Terrorists <span>胜场 ${data.scoreT}</span></div>` +
        `<table><thead><tr><th>玩家</th><th>击杀</th><th>阵亡</th><th>状态</th></tr></thead><tbody>${teamRows('t')}</tbody></table>`;
    }
    this.radioCaption.textContent = data.radioLine;
    this.radioCaption.classList.toggle('on', data.radioLine.length > 0);

    // Buy menu.
    this.buy.classList.toggle('on', data.buyMenuOpen);
    if (data.buyMenuOpen) {
      // 功能：购买菜单展示六大分类，选中后仅展示该分类的 1–8 号商品；与数字键逻辑一致。时间：2026-09-29；作者：lq。
      const categories = [
        [1, '手枪'], [2, '霰弹枪'], [3, '冲锋枪'], [4, '步枪'],
        [5, '机枪'], [6, '主武器弹药'], [7, '副武器弹药'], [8, '装备 / 手雷'],
      ];
      const rows = data.buyCategory
        ? data.buyItems
          .map(
            (item) =>
              `<div class="row ${item.affordable ? '' : 'poor'}">` +
              `<kbd>${item.digit}</kbd><span>${item.label}</span><em>$${item.price}</em></div>`,
          )
          .join('')
        : categories.map(([digit, label]) => `<div class="row"><kbd>${digit}</kbd><span>${label}</span></div>`).join('');
      this.buy.innerHTML = `<h3>购买菜单 <small>${data.buyCategory ?? '选择武器分类'}</small></h3>${rows}<p>0 返回 · B 关闭</p>`;
    }

    // Centre message (death / round over).
    const centreText = data.matchOver
      ? `比赛结束 — ${data.matchOver}`
      : data.dead
        ? data.spectating
          ? `观战：${data.spectating}`
          : '本回合已阵亡 · 等待下一回合'
        : data.objectiveAction
          ? data.objectiveAction
        : data.phase === 'freeze'
          ? `准备… ${data.respawnIn.toFixed(1)}s`
          : '';
    this.centre.textContent = centreText;
    this.centre.classList.toggle('on', centreText.length > 0);
    this.centre.classList.toggle('spectating', data.dead && Boolean(data.spectating));
    this.centre.classList.toggle('objective', Boolean(data.objectiveAction) && !data.matchOver && !data.dead);
  }
}
