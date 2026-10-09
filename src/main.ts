/**
 * Entry point: fixed 64 Hz simulation + uncapped rendering.
 *
 * The whole match (the local player, seven bots, rounds, the bomb) runs in
 * game/match.ts, which the tests also drive headlessly. This file is only
 * wiring: input -> command, match events -> effects/audio/HUD.
 */

import * as THREE from 'three';
import { Input } from './engine/input.ts';
import { v3 } from './engine/math.ts';
import { AudioSystem } from './engine/audio.ts';
import { loadSkybox, skyGradient } from './engine/bsp/sky.ts';
import { Effects } from './engine/render/effects.ts';
// 功能：T 键涂鸦使用原版喷漆纹理与独立贴花渲染。时间：2026-09-30；作者：lq。
import { SprayRenderer } from './engine/render/sprays.ts';
import { WorldRenderer } from './engine/render/renderer.ts';
import { ViewModel } from './engine/render/viewmodel.ts';
import { ActorRenderer } from './engine/render/actors.ts';
import { GrenadeRenderer } from './engine/render/grenades.ts';
import { DroppedWeaponRenderer } from './engine/render/droppedWeapons.ts';
import { BombRenderer } from './engine/render/bomb.ts';
// 功能：警家原版广告墙显示可滚动的科技资讯屏。时间：2026-10-09；作者：lq。
import { NewsScreen, findNewsScreenWall } from './engine/render/newsScreen.ts';
import { TICK_INTERVAL, TICK_MS, TICK_RATE } from './game/constants.ts';
import { loadMap } from './game/map/loader.ts';
import { buildNavGraph } from './game/nav.ts';
import { bombSitesFromBsp } from './game/objectives.ts';
import { Match } from './game/match.ts';
import { spectatorCameraPose } from './game/spectator.ts';
import type { GrenadeKind } from './game/match.ts';
import { BUY_MENU, DEFUSE_RADIUS, buyMenuOptions } from './game/gamemode.ts';
import { makeUserCmd } from './game/movement.ts';
import { WEAPONS, reloadDuration } from './game/weapons.ts';
import type { WeaponSlot } from './game/weapons.ts';
import type { WeaponId } from './game/weapons.ts';
import { Hud } from './ui/hud.ts';

function must<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element #${id}`);
  return element as T;
}

const container = must('app');
const hudElement = must('hud');
const overlay = must('overlay');
const startButton = must<HTMLButtonElement>('startBtn');
// 功能：区分首次进入的主菜单与对局中的暂停菜单，避免两个界面叠加。时间：2026-10-01；作者：lq。
const pauseMenu = must('pause-menu');
const resumeButton = must<HTMLButtonElement>('resumeBtn');
const pauseExitButton = must<HTMLButtonElement>('pauseExitBtn');
const noMapNotice = must('nomap');
const crosshair = must('crosshair');
const scopeOverlay = must('scope');
const statusBar = must('status');
const roundBar = must('roundbar');
const feedBar = must('feed');
const buyMenu = must('buymenu');
const centreMessage = must('centre');
const radar = must('radar');
// 功能：原版战绩面板和无线电字幕使用独立 HUD 层。时间：2026-09-29；作者：lq。
const scoreboard = must('scoreboard');
const radioCaption = must('radio-caption');
// 功能：原版命中反馈提示只在本地玩家击中敌人时短暂出现。时间：2026-09-29；作者：lq。
const hitMarker = must('hitmarker');
const flashbangOverlay = must('flashbang');
// 功能：C4 引爆时按距离显示短促屏幕闪光。时间：2026-09-30；作者：lq。
const bombFlashOverlay = must('bombflash');

const params = new URLSearchParams(window.location.search);
// 功能：URL 保存当前阵营；M 键打开选队面板后可在 CT/T 间重新加入。时间：2026-09-29；作者：lq。
const playerTeam = params.get('team') === 't' ? 't' : 'ct';
/** ?debug=1 keeps the physics read-out on screen; off by default so the HUD can
 * look like the original game. */
const debug = params.has('debug');
// 功能：调试数据仅在 ?debug=1 时显示，不再遮挡原版风格游戏画面。时间：2026-09-29；作者：lq。
hudElement.style.display = debug ? 'block' : 'none';

// --------------------------------------------------------------------- world
let renderer: WorldRenderer;
try {
  renderer = new WorldRenderer(container);
} catch (error) {
  overlay.classList.remove('hidden');
  must('panel').innerHTML = [
    '<h1>WebGL 初始化失败</h1>',
    `<p>浏览器没能创建 WebGL 上下文：${String(error)}</p>`,
  ].join('');
  throw error;
}

const loaded = await loadMap(params.get('map'));
const map = loaded.map;

if (loaded.object) renderer.addObject(loaded.object);
if (map.boxes.length > 0) renderer.addBoxes(map.boxes);
renderer.setFog(map.fogColor, 1800, 9000);

const gradient = skyGradient(loaded.skyName ?? '');
if (loaded.skyName) {
  const sky = await loadSkybox(loaded.skyName);
  renderer.setSky(sky?.texture ?? null, gradient.top, gradient.horizon);
} else {
  renderer.setSky(null, gradient.top, gradient.horizon);
}

// --- temporary diagnostic probe (enabled with ?probe=1)
let probe: THREE.Mesh | null = null;
if (params.has('probe')) {
  probe = new THREE.Mesh(
    new THREE.BoxGeometry(300, 300, 300),
    new THREE.MeshBasicMaterial({ color: 0xff0000, fog: false }),
  );
  renderer.scene.add(probe);
}

const effects = new Effects(renderer.scene);
// 功能：进入对局前加载原版喷漆，保证首次按 T 即可显示图案。时间：2026-09-30；作者：lq。
const sprayRenderer = new SprayRenderer(renderer.scene);
await sprayRenderer.loadTexture();
const actorRenderer = new ActorRenderer(renderer.scene);
const grenadeRenderer = new GrenadeRenderer(renderer.scene);
// 功能：显示阵亡或 G 键丢弃后可拾取的原版 w_ 枪械模型。时间：2026-09-29；作者：lq。
const droppedWeaponRenderer = new DroppedWeaponRenderer(renderer.scene);
const bombRenderer = new BombRenderer(renderer.scene);
const viewModel = new ViewModel();
renderer.setViewScene(viewModel.scene, viewModel.camera);
const audio = new AudioSystem();

// ------------------------------------------------------------ bots and rounds
const bsp = (map as { bsp?: import('./engine/bsp/types.ts').BspFile }).bsp;
const sites = bsp ? bombSitesFromBsp(bsp) : [];
// 功能：仅在 Dust2 的横幅墙挂屏，其他地图保留自身场景。时间：2026-10-09；作者：lq。
const ctSpawn = map.spawns.find((spawn) => spawn.team === 'ct');
const screenWall = bsp && map.name === 'BSP: de_dust2' && ctSpawn ? findNewsScreenWall(bsp, ctSpawn.origin) : null;
const newsScreen = screenWall ? new NewsScreen(renderer.scene, screenWall) : null;
// 功能：页面离开时释放大屏资源及网络请求。时间：2026-10-09；作者：lq。
window.addEventListener('pagehide', () => newsScreen?.dispose(), { once: true });

const navStarted = performance.now();
const graph = buildNavGraph(map.collision, map.bounds, { cellSize: 64 });
const navMs = Math.round(performance.now() - navStarted);

// 功能：缺少 skill 参数时保留默认 BOT 难度，避免 Number(null) 把难度误设为零。时间：2026-09-29；作者：lq。
const skillParam = params.has('skill') ? Number(params.get('skill')) : NaN;
const match = new Match({
  map,
  graph,
  sites,
  teamSize: 4,
  playerTeam,
  // 功能：未指定参数时使用简单 BOT 难度，保留 URL 参数覆盖能力。时间：2026-09-29；作者：lq。
  skill: Number.isFinite(skillParam) ? Math.max(0, Math.min(1, skillParam)) : 0.15,
  // 功能：每次进入对局都重新打乱双方四套经典人物皮肤。时间：2026-09-29；作者：lq。
  seed: Math.floor(Math.random() * 0xffffffff),
});
const playerActor = match.player!;
// 功能：选队按钮显示当前阵营；切换阵营时重新建立平衡的 4v4 对局。时间：2026-09-29；作者：lq。
for (const team of ['ct', 't'] as const) {
  const button = must<HTMLButtonElement>(`team-${team}`);
  button.classList.toggle('selected', team === playerTeam);
  button.addEventListener('click', () => {
    if (team === playerTeam) {
      input.requestPointerLock();
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set('team', team);
    window.location.assign(url.href);
  });
}

// Debug placement so a reported viewpoint can be reproduced exactly:
//   ?pos=x,y,z&yaw=degrees
{
  const position = params.get('pos');
  if (position) {
    const [x, y, z] = position.split(',').map(Number);
    if ([x, y, z].every((value) => Number.isFinite(value))) {
      playerActor.move.origin.x = x!;
      playerActor.move.origin.y = y!;
      playerActor.move.origin.z = z!;
    }
  }
}
viewModel.setWeapon(
  playerActor.combat.current().id,
  WEAPONS[playerActor.combat.current().id].kind,
);

/** Local look angles; handed to the actor every tick. */
let lookYaw = Number.isFinite(Number(params.get('yaw'))) && params.has('yaw') ? Number(params.get('yaw')) : playerActor.yaw;
let lookPitch = params.has('pitch') ? Number(params.get('pitch')) : 0;
const MAX_PITCH = 89;
const playerCmd = makeUserCmd();

// --------------------------------------------------------------------- input
const input = new Input(renderer.webgl.domElement);
input.attach();
// 功能：记录对局是否已开始以及是否因 Esc 暂停，主菜单和运行 HUD 据此互斥显示。时间：2026-10-01；作者：lq。
let gameStarted = false;
let gamePaused = false;

function setGameState(started: boolean, paused: boolean): void {
  gameStarted = started;
  gamePaused = started && paused;
  overlay.classList.toggle('hidden', started);
  pauseMenu.hidden = !gamePaused;
  document.body.classList.toggle('game-active', started);
  document.body.classList.toggle('game-paused', gamePaused);
}

// 功能：M 键继续返回主菜单用于重新选择阵营，Esc 则只进入对局暂停层。时间：2026-10-01；作者：lq。
input.onPress('KeyM', () => {
  if (!input.locked || !gameStarted) return;
  setGameState(false, false);
  document.exitPointerLock();
});
// 功能：Esc 释放鼠标时暂停固定步长模拟，防止暂停菜单出现后回合仍继续。时间：2026-10-01；作者：lq。
input.onPress('Escape', () => {
  if (gameStarted && input.locked) document.exitPointerLock();
});

let pendingSlot: WeaponSlot | null = null;
let pendingGrenade: GrenadeKind | null = null;
// 功能：玩家按 5 取出或收起 C4，安装动作在固定模拟步长持续处理。时间：2026-09-30；作者：lq。
let pendingBomb = false;
let pendingAmmo: 1 | 2 | null = null;
// 功能：G 丢枪与 E 拾枪在固定模拟步长执行，避免输入时序造成重复交换。时间：2026-09-29；作者：lq。
let pendingDrop = false;
let pendingPickup = false;
input.onPress('KeyG', () => { pendingDrop = true; });
input.onPress('KeyE', () => { pendingPickup = true; });
// 功能：锁定鼠标且关闭购买菜单时，T 键将喷漆请求交给固定模拟步长。时间：2026-09-30；作者：lq。
let pendingSpray = false;
input.onPress('KeyT', () => { if (input.locked && !buyMenuOpen) pendingSpray = true; });
type Equipment = WeaponSlot | GrenadeKind | 'c4';
let previousEquipment: Equipment = 2;
let buyMenuOpen = false;
let pendingBuy: string | null = null;
type BuyCategory = (typeof BUY_MENU)[number]['category'];
const buyCategories: Partial<Record<number, BuyCategory>> = {
  1: 'pistols', 2: 'shotguns', 3: 'smgs', 4: 'rifles', 5: 'machinegun', 8: 'equipment',
};
let buyCategory: BuyCategory | null = null;

/** 功能：统一 1–6、Q 和滚轮切换，记住上一件武器且只选择有库存的手雷。时间：2026-09-29；作者：lq。 */
function requestEquipment(equipment: Equipment): void {
  if (!playerActor.alive || playerActor.grenadeAction) return;
  if (equipment === 'c4' && (playerActor.team !== 't' || match.mode.bomb.carrier !== playerActor || match.mode.bomb.state !== 'carried')) return;
  if (typeof equipment === 'string' && equipment !== 'c4' && playerActor.grenades[equipment] <= 0) return;
  const current: Equipment = playerActor.selectedBomb ? 'c4' : playerActor.selectedGrenade ?? playerActor.combat.activeSlot;
  if (equipment === current) return;
  previousEquipment = current;
  if (typeof equipment === 'number') pendingSlot = equipment;
  else if (equipment === 'c4') pendingBomb = true;
  else pendingGrenade = equipment;
}

// 功能：经典 B→分类→商品数字序列可连续输入，战斗中 4/5/6 直选高爆/闪光/烟雾弹。时间：2026-09-29；作者：lq。
for (let digit = 1; digit <= 9; digit++) {
  // 功能：主键盘和小键盘数字键共用原版购买菜单操作。时间：2026-09-29；作者：lq。
  const selectDigit = () => {
    if (buyMenuOpen) {
      if (!buyCategory) {
        if (digit === 6 || digit === 7) {
          pendingAmmo = digit === 6 ? 1 : 2;
          buyMenuOpen = false;
        } else buyCategory = buyCategories[digit] ?? null;
      } else pendingBuy = buyMenuOptions(playerActor.team, buyCategory).find((option) => option.digit === digit)?.item.id ?? null;
      return;
    }
    if (digit <= 3) requestEquipment(digit as WeaponSlot);
    else if (digit === 5 && playerActor.team === 't' && match.mode.bomb.carrier === playerActor) requestEquipment('c4');
    else if (digit >= 4 && digit <= 6) requestEquipment((['hegrenade', 'flashbang', 'smokegrenade'] as const)[digit - 4]!);
  };
  input.onPress(`Digit${digit}`, selectDigit);
  input.onPress(`Numpad${digit}`, selectDigit);
}
const buyBack = () => { if (buyCategory) buyCategory = null; else buyMenuOpen = false; };
input.onPress('Digit0', buyBack);
input.onPress('Numpad0', buyBack);
input.onPress('KeyB', () => {
  buyMenuOpen = !buyMenuOpen;
  buyCategory = null;
});
input.onPress('KeyQ', () => { if (!buyMenuOpen) requestEquipment(previousEquipment); });
input.onWheel = (direction) => {
  if (buyMenuOpen || direction === 0) return;
  const available: Equipment[] = [1, 2, 3, ...(['hegrenade', 'flashbang', 'smokegrenade'] as const).filter((kind) => playerActor.grenades[kind] > 0), ...(match.mode.bomb.carrier === playerActor && match.mode.bomb.state === 'carried' ? ['c4' as const] : [])];
  const current = playerActor.selectedBomb ? 'c4' : playerActor.selectedGrenade ?? playerActor.combat.activeSlot;
  const index = available.indexOf(current);
  requestEquipment(available[(index + (direction > 0 ? 1 : -1) + available.length) % available.length]!);
};

function soundList(): string[] {
  const names: string[] = [
    'sound/weapons/bullet_hit1.wav',
    'sound/weapons/ric1.wav',
    'sound/player/headshot1.wav',
    'sound/player/bhit_flesh-1.wav',
    'sound/weapons/c4_plant.wav',
    'sound/weapons/c4_explode1.wav',
    // 功能：预载 C4 滴答、安装和拆除音效，确保首次操作即时有声。时间：2026-09-30；作者：lq。
    'sound/weapons/c4_beep1.wav', 'sound/weapons/c4_beep2.wav', 'sound/weapons/c4_beep3.wav', 'sound/weapons/c4_beep4.wav', 'sound/weapons/c4_beep5.wav',
    'sound/weapons/c4_click.wav', 'sound/weapons/c4_disarm.wav', 'sound/weapons/c4_disarmed.wav',
  ];
  for (const slot of [1, 2, 3] as WeaponSlot[]) {
    const def = WEAPONS[playerActor.combat.loadout[slot].id];
    names.push(...def.sounds.fire);
    for (const key of ['clipin', 'clipout', 'boltpull', 'deploy', 'dryfire'] as const) {
      const value = def.sounds[key];
      if (value) names.push(value);
    }
    if (def.sounds.altFire) names.push(...def.sounds.altFire);
  }
  // 功能：预载购买后可切换的原版枪声与三种手雷爆炸音效，避免首发无声。时间：2026-09-29；作者：lq。
  // 功能：预载所有可购买武器的换弹声，确保第一次买枪后换弹不会静音。时间：2026-09-29；作者：lq。
  for (const def of Object.values(WEAPONS)) {
    names.push(...def.sounds.fire);
    for (const key of ['clipout', 'clipin', 'boltpull', 'dryfire'] as const) {
      const file = def.sounds[key];
      if (file) names.push(file);
    }
  }
  names.push('sound/weapons/generic_reload.wav');
  names.push('sound/weapons/hegrenade-1.wav', 'sound/weapons/flashbang-1.wav', 'sound/weapons/sg_explode.wav');
  names.push('sound/weapons/grenade_hit1.wav', 'sound/weapons/grenade_hit2.wav', 'sound/weapons/grenade_hit3.wav');
  // 功能：预载原版 T 键喷漆音效，与表面贴花同步播放。时间：2026-09-30；作者：lq。
  names.push('sound/player/sprayer.wav');
  for (let i = 1; i <= 4; i++) {
    names.push(`sound/player/pl_dirt${i}.wav`, `sound/player/pl_metal${i}.wav`);
  }
  names.push('sound/player/pl_jumpland2.wav');
  // 功能：预载从用户原版 CS 压缩包提取的队员语音与胜负播报。时间：2026-09-29；作者：lq。
  names.push(...['locknload', 'moveout', 'ct_enemys', 'ct_coverme', 'ct_imhit', 'ct_inpos', 'ct_reportingin', 'com_reportin', 'com_go', 'enemydown', 'roger', 'sticktog', 'ctwin', 'terwin', 'rounddraw', 'bombpl', 'bombdef'].map((name) => `sound/radio/${name}.wav`));
  return names;
}

input.onLockChange = (locked) => {
  if (!gameStarted) {
    setGameState(false, false);
  } else if (locked) {
    setGameState(true, false);
  } else {
    setGameState(true, true);
  }
  crosshair.classList.toggle('on', locked && gameStarted && !gamePaused);
  if (locked) {
    void audio.unlock().then(() => {
      audio.retryFailed();
      void audio.preload(soundList());
    });
  }
};

startButton.addEventListener('click', () => {
  // 功能：快速开始只进入运行态，不再复用暂停菜单的显示逻辑。时间：2026-10-01；作者：lq。
  setGameState(true, false);
  input.requestPointerLock();
  void audio.unlock().then(() => {
    audio.retryFailed();
    void audio.preload(soundList());
  });
});

// 功能：恢复暂停前的同一局比赛，并重新锁定鼠标继续操作。时间：2026-10-01；作者：lq。
resumeButton.addEventListener('click', () => {
  setGameState(true, false);
  input.requestPointerLock();
});

// 功能：从暂停菜单返回主菜单但保留当前 Match 状态，之后再次开始可继续原回合。时间：2026-10-01；作者：lq。
pauseExitButton.addEventListener('click', () => {
  setGameState(false, false);
  document.exitPointerLock();
});

// 功能：主菜单热点提供快速开始、服务器、设置等入口反馈；快速开始沿用原有鼠标锁定流程。时间：2026-09-30；作者：lq。
const menuToast = document.getElementById('menu-toast');
const menuLabels: Record<string, string> = {
  servers: '服务器列表正在准备中',
  create: '创建房间：本地 4v4 房间已就绪',
  settings: '游戏设置可在对局中按 Esc 调整',
  ranking: '排行榜：本周最佳 CT_Fan001',
  help: '帮助：点击快速开始进入训练对局',
  profile: 'CT_Fan001 · Lv. 12 · 经验值 3200 / 5000',
  news: '最新公告：CS1.5 Web 测试版上线',
  maps: '热门地图：de_dust2 · de_inferno · cs_assault',
  exit: '感谢游玩 Counter-Strike 1.5 Web',
};
let menuToastTimer = 0;
function showMenuToast(message: string): void {
  if (!menuToast) return;
  menuToast.textContent = message;
  menuToast.classList.add('show');
  window.clearTimeout(menuToastTimer);
  menuToastTimer = window.setTimeout(() => menuToast.classList.remove('show'), 2400);
}
document.querySelectorAll<HTMLElement>('[data-menu]').forEach((button) => {
  // 快速开始按钮已有独立监听器，避免事件冒泡后再次触发 click 造成递归。
  if (button === startButton) return;
  button.addEventListener('click', () => {
    const action = button.dataset.menu ?? '';
    if (action === 'play') {
      startButton.click();
      return;
    }
    showMenuToast(menuLabels[action] ?? '功能即将开放');
  });
});

renderer.webgl.domElement.addEventListener('click', () => {
  // 功能：暂停时点击游戏画布等同于恢复，主菜单阶段不抢占鼠标。时间：2026-10-01；作者：lq。
  if (gameStarted && gamePaused) {
    setGameState(true, false);
    input.requestPointerLock();
  } else if (gameStarted && !input.locked) input.requestPointerLock();
});

if (params.has('nolock')) {
  setGameState(true, false);
  crosshair.classList.add('on');
}

noMapNotice.innerHTML = [
  `当前地图：<b>${map.name}</b>`,
  loaded.note,
  `导航图 ${graph.nodes.length} 个节点（${navMs} ms）· 炸弹点 ${sites.length} 个`,
  '',
  `4v4：你是 ${playerTeam.toUpperCase()}，3 个 BOT 队友，对面 4 个 BOT。按 M 可切换阵营。`,
  '换地图 <code>?map=de_dust2</code>，BOT 强度 <code>?skill=0.9</code>。',
].join('<br>');

// ------------------------------------------------------------------ resizing
function resize(): void {
  renderer.resize(container.clientWidth, container.clientHeight);
  viewModel.setAspect(container.clientWidth / Math.max(1, container.clientHeight));
}
new ResizeObserver(resize).observe(container);
resize();

// --------------------------------------------------------------- frame loop
const hud = new Hud({
  hud: hudElement,
  crosshair,
  scope: scopeOverlay,
  status: statusBar,
  roundBar,
  feed: feedBar,
  buy: buyMenu,
  centre: centreMessage,
  radar,
  scoreboard,
  radioCaption,
});

let accumulator = 0;
let lastTime = performance.now();
let frames = 0;
let fpsAccum = 0;
let fps = 0;
let hudAccum = 0;
let simTime = 0;
/** 功能：以模拟时钟安排退匣、装匣和拉栓声，手动与自动换弹均按同一模型播放。时间：2026-09-29；作者：lq。 */
let reloadSoundCues: { weapon: WeaponId; at: number; file: string }[] = [];
let killFeed: { killer: string; victim: string; weapon: string; headshot: boolean }[] = [];
let roundBanner: string | null = null;
let stepAccumulator = 0;
let lastFootstep = -99;
let localKills = 0;
let localDeaths = 0;
let hitUntil = 0;
let flashUntil = 0;
// 功能：玩家阵亡后在存活队友之间随机切换，队友再次阵亡时自动重新选择。时间：2026-09-29；作者：lq。
let spectator: import('./game/actors.ts').Actor | null = null;
let lastRadioAt = -99;
let radioLine = '';
let radioUntil = 0;
let nextTeamCallAt = 10;
// 功能：按原版炸弹滴答节奏限制音效触发频率，并记录安装/拆除反馈时机。时间：2026-09-30；作者：lq。
let nextBombBeepAt = 0;
let lastPlantProgress = 0;
let lastDefuseProgress = 0;
let bombFlashUntil = 0;
let bombFlashStrength = 0;

/** 功能：按原版无线电节奏播放队员语音并在 HUD 短暂显示发话者。时间：2026-09-29；作者：lq。 */
function playRadio(name: string, speaker: string, subtitle: string, minimumGap = 3): void {
  if (simTime - lastRadioAt < minimumGap) return;
  lastRadioAt = simTime;
  radioLine = `${speaker} (无线电): ${subtitle}`;
  radioUntil = simTime + 2.7;
  audio.play(`sound/radio/${name}.wav`, { volume: 0.72 });
}

/** 功能：优先随机跟随本阵营存活队友，队友全灭时跟随任一存活角色直到新回合。时间：2026-09-29；作者：lq。 */
function chooseSpectator(): import('./game/actors.ts').Actor | null {
  const teammates = match.actors.filter((actor) => actor !== playerActor && actor.alive && actor.team === playerActor.team);
  const candidates = teammates.length ? teammates : match.actors.filter((actor) => actor !== playerActor && actor.alive);
  return candidates.length ? candidates[Math.floor(Math.random() * candidates.length)]! : null;
}

function clockText(): string {
  const total = Math.max(
    0,
    match.mode.bomb.state === 'planted' ? match.mode.bombTimeLeft : match.mode.timeLeft,
  );
  const minutes = Math.floor(total / 60);
  const seconds = Math.floor(total % 60);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function frame(now: number): void {
  const rawDt = (now - lastTime) / 1000;
  lastTime = now;
  const dt = Math.min(rawDt, 0.25);
  // 功能：暂停或主菜单阶段不推进固定步长，确保 Esc 后回合计时、BOT 和物理全部冻结。时间：2026-10-01；作者：lq。
  const simulationActive = gameStarted && !gamePaused;

  fpsAccum += rawDt;
  frames++;
  if (fpsAccum >= 0.5) {
    fps = frames / fpsAccum;
    frames = 0;
    fpsAccum = 0;
  }

  const look = input.consumeLookDelta();
  if (simulationActive) {
    lookYaw += look.yaw;
    if (lookYaw > 180) lookYaw -= 360;
    else if (lookYaw < -180) lookYaw += 360;
    lookPitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, lookPitch + look.pitch));
  }

  if (simulationActive) accumulator += dt;
  let steps = 0;
  while (simulationActive && accumulator >= TICK_INTERVAL && steps < 8) {
    if (pendingBuy) {
      // 功能：购买成功后装备新枪或手雷并关闭菜单，使数字键购买有即时反馈。时间：2026-09-29；作者：lq。
      const item = BUY_MENU.find((entry) => entry.id === pendingBuy);
      const bought = match.mode.buy(playerActor, pendingBuy);
      if (bought && item) {
        if (item.slot) {
          previousEquipment = playerActor.selectedGrenade ?? playerActor.combat.activeSlot;
          playerActor.selectedGrenade = null;
          playerActor.combat.selectSlot(item.slot, simTime);
        }
        if (item.grenade) {
          previousEquipment = playerActor.selectedGrenade ?? playerActor.combat.activeSlot;
          playerActor.selectedGrenade = item.grenade;
          // 功能：购买手雷后保留装备菜单，允许连续购买两枚闪光或补齐三种手雷。时间：2026-09-30；作者：lq。
          buyMenuOpen = true;
          buyCategory = 'equipment';
        } else {
          buyMenuOpen = false;
          buyCategory = null;
        }
      }
      pendingBuy = null;
      viewModel.setWeapon(
        playerActor.combat.current().id,
        WEAPONS[playerActor.combat.current().id].kind,
      );
    }
    if (pendingAmmo !== null) {
      match.mode.buyAmmo(playerActor, pendingAmmo);
      pendingAmmo = null;
    }
    if (pendingGrenade) {
      playerActor.selectedGrenade = pendingGrenade;
      playerActor.selectedBomb = false;
      pendingGrenade = null;
    }
    if (pendingBomb) {
      playerActor.selectedGrenade = null;
      playerActor.selectedBomb = true;
      pendingBomb = false;
    }
    if (pendingSlot !== null) {
      playerActor.selectedGrenade = null;
      playerActor.selectedBomb = false;
      if (playerActor.combat.selectSlot(pendingSlot, simTime)) {
        viewModel.setWeapon(
          playerActor.combat.current().id,
          WEAPONS[playerActor.combat.current().id].kind,
        );
      }
      pendingSlot = null;
    }

    if (pendingDrop) {
      const dropped = match.dropCurrentWeapon(playerActor, simTime);
      if (dropped) {
        playerActor.selectedGrenade = null;
        viewModel.setWeapon(playerActor.combat.current().id, WEAPONS[playerActor.combat.current().id].kind);
      }
      pendingDrop = false;
    }
    if (pendingPickup) {
      // 功能：CT 在炸弹旁按 E 优先拆包，避免同时拾起地面枪械。时间：2026-09-30；作者：lq。
      const bomb = match.mode.bomb;
      const nearBomb = playerActor.team === 'ct' && bomb.state === 'planted' && bomb.position && Math.hypot(playerActor.move.origin.x - bomb.position.x, playerActor.move.origin.y - bomb.position.y, playerActor.move.origin.z - bomb.position.z) <= DEFUSE_RADIUS;
      const picked = nearBomb ? null : match.pickupNearestWeapon(playerActor, simTime);
      if (picked) {
        playerActor.selectedGrenade = null;
        viewModel.setWeapon(picked.weapon.id, WEAPONS[picked.weapon.id].kind);
      }
      pendingPickup = false;
    }

    input.sampleCommand(playerCmd);
    playerActor.yaw = lookYaw;
    playerActor.pitch = lookPitch;

    simTime += TICK_INTERVAL;
    const events = match.update(simTime, {
      buttons: playerCmd.buttons,
      forwardmove: playerCmd.forwardmove,
      sidemove: playerCmd.sidemove,
      upmove: 0,
      yaw: lookYaw,
      pitch: lookPitch,
    });
    // 功能：喷漆成功才添加贴花和空间音效，失败请求不消耗冷却时间。时间：2026-09-30；作者：lq。
    if (pendingSpray) {
      const spray = sprayRenderer.ready && input.locked && !buyMenuOpen ? match.trySpray(simTime) : null;
      if (spray) {
        sprayRenderer.addSpray(spray);
        audio.playAt('sound/player/sprayer.wav', spray.position, { volume: 0.8 });
      }
      pendingSpray = false;
    }
    // 功能：换弹音效分段贴合缩短后的原版模型动作，换枪或阵亡时丢弃未播放的声音。时间：2026-09-29；作者：lq。
    for (const reload of events.reloads) {
      if (reload.actor !== playerActor) continue;
      const sounds = WEAPONS[reload.weapon].sounds;
      const duration = reloadDuration(reload.weapon);
      const planned = [
        { file: sounds.clipout ?? 'sound/weapons/generic_reload.wav', delay: 0.08 },
        { file: sounds.clipin, delay: duration * 0.55 },
        { file: sounds.boltpull, delay: duration * 0.79 },
      ];
      reloadSoundCues = planned.flatMap((cue) => cue.file ? [{ weapon: reload.weapon, at: simTime + cue.delay, file: cue.file }] : []);
    }
    const currentReload = playerActor.combat.current();
    reloadSoundCues = reloadSoundCues.filter((cue) => {
      if (!playerActor.alive || currentReload.id !== cue.weapon || currentReload.reloadEndTime === 0) return false;
      if (simTime < cue.at) return true;
      audio.play(cue.file, { volume: 0.85 });
      return false;
    });
    // 功能：三维枪声、人物受弹声和手雷声以玩家实时位置衰减，近距离命中可清楚听见。时间：2026-09-29；作者：lq。
    // 功能：阵亡观战时声音也跟随当前队员位置，避免画面与枪声距离不一致。时间：2026-09-29；作者：lq。
    audio.listener = (spectator?.alive ? spectator : playerActor).move.origin;

    if (events.mode.roundStarted) {
      killFeed = [];
      spectator = null;
      nextTeamCallAt = simTime + 10 + Math.random() * 8;
      playRadio('locknload', playerActor.team.toUpperCase(), 'Lock and load!', 0);
    }
    if (events.mode.roundEnded) {
      // 功能：平局时显示原版平局结果，避免误报 T 获胜。时间：2026-09-29；作者：lq。
      roundBanner = `${events.mode.roundEnded.winner === 'draw' ? '平局' : `${events.mode.roundEnded.winner === 'ct' ? 'CT' : 'T'} 获胜`} — ${events.mode.roundEnded.reason}`;
      const banner = roundBanner;
      window.setTimeout(() => {
        if (roundBanner === banner) roundBanner = null;
      }, 3500);
      const winner = events.mode.roundEnded.winner;
      playRadio(winner === 'ct' ? 'ctwin' : winner === 't' ? 'terwin' : 'rounddraw', '无线电', winner === 'ct' ? 'Counter-Terrorists win!' : winner === 't' ? 'Terrorists win!' : 'Round draw.', 0);
    }
    if (events.mode.bombPlanted) {
      audio.play('sound/weapons/c4_plant.wav', { volume: 0.8 });
      playRadio('bombpl', '无线电', 'The bomb has been planted.', 0);
      nextBombBeepAt = simTime;
    }
    // 功能：装包和拆包进度变化时播放原版按钮及拆线音效。时间：2026-09-30；作者：lq。
    if (match.mode.bomb.plantProgress > lastPlantProgress && Math.floor(match.mode.bomb.plantProgress * 3) !== Math.floor(lastPlantProgress * 3)) audio.play('sound/weapons/c4_click.wav', { volume: 0.55 });
    if (match.mode.bomb.defuser === playerActor && match.mode.bomb.defuseProgress > lastDefuseProgress && Math.floor(match.mode.bomb.defuseProgress * 10) !== Math.floor(lastDefuseProgress * 10)) audio.play('sound/weapons/c4_disarm.wav', { volume: 0.55 });
    lastPlantProgress = match.mode.bomb.plantProgress;
    lastDefuseProgress = match.mode.bomb.defuseProgress;
    if (events.mode.bombDefused) {
      audio.play('sound/weapons/c4_disarmed.wav', { volume: 0.9 });
      playRadio('bombdef', '无线电', 'The bomb has been defused.', 0);
    }
    // 功能：已安装 C4 按剩余时间逐渐加快的原版滴答音循环播放。时间：2026-09-30；作者：lq。
    if (match.mode.bomb.state === 'planted' && simTime >= nextBombBeepAt) {
      const remaining = match.mode.bombTimeLeft;
      const beep = remaining > 20 ? 1 : remaining > 10 ? 2 : remaining > 5 ? 3 : remaining > 2 ? 4 : 5;
      audio.playAt(`sound/weapons/c4_beep${beep}.wav`, match.mode.bomb.position!, { volume: 0.8, maxDistance: 2400 });
      nextBombBeepAt = simTime + (remaining > 20 ? 1 : remaining > 10 ? 0.7 : remaining > 5 ? 0.5 : remaining > 2 ? 0.35 : 0.2);
    }
    if (events.mode.bombExploded) {
      audio.play('sound/weapons/c4_explode1.wav', { volume: 1 });
      if (match.mode.bomb.position) {
        const blast = match.mode.bomb.position;
        effects.addBombExplosion(blast);
        const distance = Math.hypot(playerActor.move.origin.x - blast.x, playerActor.move.origin.y - blast.y, playerActor.move.origin.z - blast.z);
        bombFlashStrength = Math.max(0, 1 - distance / 1400) * 0.7;
        bombFlashUntil = simTime + 0.38;
      }
    }
    // 功能：交火间隙随机播放原版 CT 队员简短报点语音，避免静止背景音重复刷屏。时间：2026-09-29；作者：lq。
    if (match.mode.phase === 'live' && simTime >= nextTeamCallAt) {
      nextTeamCallAt = simTime + 15 + Math.random() * 12;
      const teammates = match.actors.filter((actor) => actor.team === playerActor.team && actor !== playerActor && actor.alive);
      if (teammates.length) {
        const speaker = teammates[Math.floor(Math.random() * teammates.length)]!;
        const lines = [
          { file: playerActor.team === 'ct' ? 'ct_reportingin' : 'com_reportin', text: 'Reporting in.' },
          { file: playerActor.team === 'ct' ? 'ct_inpos' : 'com_go', text: 'In position.' },
          { file: 'roger', text: 'Roger that.' },
          { file: 'sticktog', text: 'Stick together, team.' },
          { file: 'moveout', text: 'Move out!' },
        ];
        const line = lines[Math.floor(Math.random() * lines.length)]!;
        playRadio(line.file, speaker.name, line.text, 4);
      }
    }

    for (const resolved of events.shots) {
      const def = WEAPONS[resolved.shot.weapon];
      const isLocal = resolved.shooter === playerActor;

      if (isLocal) {
        // 功能：刀右键使用原版刺击声和 stab 动画，左键轮换两种挥砍动作。时间：2026-09-29；作者：lq。
        audio.playRandom(resolved.shot.alternate ? def.sounds.altFire ?? def.sounds.fire : def.sounds.fire, { volume: 0.9 });
        viewModel.kick(def.kind === 'sniper' ? 1.3 : def.kind === 'pistol' ? 0.85 : 1, resolved.shot.alternate);
      } else {
        audio.playAt(def.sounds.fire[0] ?? 'sound/weapons/ak47-1.wav', resolved.shot.start, {
          volume: 0.85,
        });
        // 功能：第三人称火焰从可见枪口发出，刀击与投掷不产生枪口闪光。时间：2026-09-29；作者：lq。
        if (def.kind !== 'knife') {
          const muzzle = actorRenderer.muzzlePosition(resolved.shooter) ?? resolved.shot.start;
          effects.addMuzzleFlash(muzzle, v3(resolved.shot.end.x - muzzle.x, resolved.shot.end.y - muzzle.y, resolved.shot.end.z - muzzle.z));
        }
        if (resolved.shooter.team === playerActor.team && simTime - lastRadioAt > 12 && Math.random() < 0.12) {
          playRadio('ct_enemys', resolved.shooter.name, 'Enemy spotted!');
        }
      }

      if (resolved.victim) {
        effects.addBlood(resolved.shot.end);
        if (isLocal) {
          hitUntil = simTime + 0.18;
          hitMarker.classList.add('on');
        }
      } else if (resolved.shot.hit) {
        effects.addImpact(resolved.shot.end, resolved.shot.normal);
      }

      if (resolved.victim) {
        audio.playAt(
          resolved.headshot ? 'sound/player/headshot1.wav' : 'sound/player/bhit_flesh-1.wav',
          resolved.shot.end,
          { volume: 0.7 },
        );
      }

      if (resolved.killed && resolved.victim) {
        killFeed = [
          {
            killer: resolved.shooter === playerActor ? 'YOU' : resolved.shooter.name,
            victim: resolved.victim === playerActor ? 'YOU' : resolved.victim.name,
            weapon: def.name,
            headshot: resolved.headshot,
          },
          ...killFeed,
        ].slice(0, 5);
        if (resolved.shooter === playerActor) localKills++;
        if (resolved.victim === playerActor) localDeaths++;
        if (resolved.shooter.team === playerActor.team && resolved.shooter !== playerActor && Math.random() < 0.55) {
          playRadio('enemydown', resolved.shooter.name, 'Enemy down.', 5);
        }
      }
    }

    // 功能：手雷引爆事件连接高爆、烟雾粒子与闪光白屏，并使用本地原版音效。时间：2026-09-29；作者：lq。
    for (const grenade of events.grenades) {
      if (grenade.kind === 'hegrenade') {
        effects.addGrenadeBurst(grenade.position, 'hegrenade');
        audio.playAt('sound/weapons/hegrenade-1.wav', grenade.position, { volume: 1 });
      } else if (grenade.kind === 'smokegrenade') {
        effects.addGrenadeBurst(grenade.position, 'smokegrenade');
        audio.playAt('sound/weapons/sg_explode.wav', grenade.position, { volume: 0.8 });
      } else {
        effects.addGrenadeBurst(grenade.position, 'flashbang');
        audio.playAt('sound/weapons/flashbang-1.wav', grenade.position, { volume: 1 });
        const distance = Math.hypot(playerActor.move.origin.x - grenade.position.x, playerActor.move.origin.y - grenade.position.y, playerActor.move.origin.z - grenade.position.z);
        if (distance < 900) flashUntil = Math.max(flashUntil, simTime + 1.8 * (1 - distance / 900));
      }
    }
    // 功能：手雷触地和撞墙时播放原版金属/石面弹跳音。时间：2026-09-29；作者：lq。
    for (const position of events.grenadeBounces) {
      audio.playAt(`sound/weapons/grenade_hit${1 + Math.floor(Math.random() * 3)}.wav`, position, { volume: 0.4, maxDistance: 1100 });
    }

    const speed = Math.hypot(playerActor.move.velocity.x, playerActor.move.velocity.y);
    if (playerActor.move.onground && speed > 90 && playerActor.alive) {
      stepAccumulator += speed * TICK_INTERVAL;
      if (stepAccumulator > 150 && simTime - lastFootstep > 0.26) {
        stepAccumulator = 0;
        lastFootstep = simTime;
        audio.playRandom(
          [1, 2, 3, 4].map((i) => `sound/player/pl_dirt${i}.wav`),
          { volume: 0.32 },
        );
      }
    }

    accumulator -= TICK_INTERVAL;
    steps++;
  }

  // ---- view model and camera
  const punch = playerActor.combat.punchAngle;
  const runtime = playerActor.combat.current();
  const weaponDef = WEAPONS[runtime.id];
  const alive = playerActor.alive;
  // 功能：让第一人称模型跟随手雷选择和投掷自动切回枪械。时间：2026-09-29；作者：lq。
  const shownWeapon = playerActor.selectedBomb ? 'c4' : playerActor.selectedGrenade ?? runtime.id;
  viewModel.setWeapon(shownWeapon, shownWeapon === 'c4' ? 'knife' : WEAPONS[shownWeapon].kind);
  const reloadProgress =
    runtime.reloadEndTime > 0
      ? Math.max(
          0,
          Math.min(1, (runtime.reloadEndTime - simTime) / Math.max(0.001, reloadDuration(runtime.id))),
        )
      : 0;
  const deployProgress =
    runtime.deployEndTime > 0
      ? Math.max(
          0,
          Math.min(1, (runtime.deployEndTime - simTime) / Math.max(0.001, weaponDef.deployTime)),
        )
      : 0;
  const scoped = alive && runtime.scoped && !playerActor.selectedGrenade;

  // 功能：AWP 一档使用原版约 40°视野，二档使用约 10°视野，准星始终锁定屏幕中心。时间：2026-09-30；作者：lq。
  const targetFov = scoped ? (runtime.zoomLevel === 2 ? 10 : 40) : 90;
  if (renderer.fovHorizontal !== targetFov) {
    renderer.fovHorizontal = targetFov;
    renderer.resize(container.clientWidth, container.clientHeight);
  }

  if (alive) spectator = null;
  else if (!spectator || !spectator.alive) spectator = chooseSpectator();
  const observed = spectator ?? playerActor;
  viewModel.setVisible(alive);
  // 功能：阵亡后改用墙体避让的第三人称追随镜头，可看到队友模型和场上尸体。时间：2026-09-29；作者：lq。
  if (alive) renderer.setView(
    v3(playerActor.move.origin.x, playerActor.move.origin.y, playerActor.move.origin.z + (playerActor.move.ducked ? 4 : 17)),
    lookPitch + punch.pitch,
    lookYaw + punch.yaw,
  );
  else {
    const chase = spectatorCameraPose(observed, map.collision);
    renderer.setView(chase.origin, chase.pitch, chase.yaw);
  }
  renderer.camera.updateMatrixWorld();

  viewModel.update(simulationActive ? dt : 0, {
    speed: Math.hypot(playerActor.move.velocity.x, playerActor.move.velocity.y),
    onGround: playerActor.move.onground,
    ducked: playerActor.move.ducked,
    scoped,
    reloadProgress,
    deployProgress,
    grenadeAction: playerActor.grenadeAction,
    grenadeActionEndTime: playerActor.grenadeActionEndTime,
    bombPlantProgress: playerActor.selectedBomb ? match.mode.bomb.plantProgress : 0,
    now: simTime,
    punch,
    pitch: lookPitch,
    yaw: lookYaw,
  });

  // Park the probe 500 units in front of the camera.
  if (probe) {
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(renderer.camera.quaternion);
    probe.position.copy(renderer.camera.position).addScaledVector(dir, 500);
    probe.updateMatrixWorld();
  }

  // 功能：第一人称只隐藏活着的本地模型，观战时保留被观察队友与玩家尸体。时间：2026-09-29；作者：lq。
  actorRenderer.update(match.actors, alive ? playerActor : null, simTime);
  grenadeRenderer.update(match.grenadeProjectiles);
  bombRenderer.update(match.mode);
  droppedWeaponRenderer.update(match.droppedWeapons);
  if (simTime >= hitUntil) hitMarker.classList.remove('on');
  flashbangOverlay.style.opacity = String(Math.max(0, Math.min(1, (flashUntil - simTime) / 0.8)));
  // 功能：C4 爆炸闪光在 0.38 秒内快速淡出，不遮挡下一回合。时间：2026-09-30；作者：lq。
  bombFlashOverlay.style.opacity = String(Math.max(0, (bombFlashUntil - simTime) / 0.38) * bombFlashStrength);
  effects.update(simulationActive ? dt : 0);
  // 功能：资讯屏独立使用真实时间，暂停对局后仍可阅读和刷新新闻。时间：2026-10-09；作者：lq。
  newsScreen?.update(performance.now() / 1000, renderer.camera);
  renderer.render();

  hudAccum += rawDt;
  if (hudAccum >= 0.08) {
    hudAccum = 0;
    const aliveCT = match.actors.filter((a) => a.team === 'ct' && a.alive).length;
    const aliveT = match.actors.filter((a) => a.team === 't' && a.alive).length;
    // 功能：观战时 HUD 的生命、护甲、弹药与雷达一起切换到被观察的队员。时间：2026-09-29；作者：lq。
    const hudActor = spectator ?? playerActor;
    const hudRuntime = hudActor.combat.current();
    const hudWeapon = hudActor.selectedGrenade ?? hudRuntime.id;
    hud.update({
      fps,
      tickRate: TICK_RATE,
      mapName: map.name,
      mapNote: debug
        ? `${loaded.note} · 导航 ${graph.nodes.length} 节点` +
          ` | canvas ${container.clientWidth}x${container.clientHeight}` +
          ` cam ${renderer.camera.position.x.toFixed(0)},${renderer.camera.position.y.toFixed(0)},${renderer.camera.position.z.toFixed(0)}` +
          ` err ${renderer.webgl.getContext().getError()}`
        : `${loaded.note} · 导航 ${graph.nodes.length} 节点`,
      origin: hudActor.move.origin,
      velocity: hudActor.move.velocity,
      speed: Math.hypot(hudActor.move.velocity.x, hudActor.move.velocity.y),
      onground: hudActor.move.onground,
      ducked: hudActor.move.ducked,
      noclip: false,
      stepUps: hudActor.move.lastStepUps,
      sensitivity: input.sensitivity,
      tickMs: TICK_MS,
      // 功能：持包时武器 HUD 显示 C4，不误显示隐藏的枪械。时间：2026-09-30；作者：lq。
      weaponName: hudActor.selectedBomb ? 'C4' : WEAPONS[hudWeapon].name,
      // 功能：HUD 手雷显示无限库存，持枪时继续显示当前弹匣。时间：2026-09-30；作者：lq。
      holdingGrenade: hudActor.selectedGrenade !== null,
      ammo: hudActor.selectedBomb ? 0 : hudActor.selectedGrenade ? hudActor.grenades[hudActor.selectedGrenade] : hudRuntime.ammo,
      reserve: hudActor.selectedBomb || hudActor.selectedGrenade ? 0 : hudRuntime.reserve,
      reloading: reloadProgress > 0,
      health: hudActor.health,
      armor: hudActor.armor,
      coneDeg: playerActor.combat.currentCone(
        {
          eye: v3(playerActor.move.origin.x, playerActor.move.origin.y, playerActor.move.origin.z + 17),
          pitch: lookPitch,
          yaw: lookYaw,
          speed: Math.hypot(playerActor.move.velocity.x, playerActor.move.velocity.y),
          onGround: playerActor.move.onground,
          ducked: playerActor.move.ducked,
        },
        simTime,
      ),
      scoped,
      phase: match.mode.phase,
      phaseTime: clockText(),
      scoreCT: match.mode.score.ct,
      scoreT: match.mode.score.t,
      aliveCT,
      aliveT,
      money: hudActor.unlimitedFunds ? Infinity : hudActor.money,
      kills: localKills,
      deaths: localDeaths,
      bombStatus:
        match.mode.bomb.state === 'planted'
          ? `炸弹已下包 @${match.mode.bomb.siteName}`
          : match.mode.bomb.state === 'defused'
            ? '已拆除'
            : match.mode.bomb.state === 'exploded'
              ? '已爆炸'
              : match.mode.bomb.state === 'dropped'
                ? 'C4 已掉落'
              : 'C4 在 T 手上',
      // 功能：HUD 告知持包者装包进度以及 CT 拆包进度和拆弹器速度。时间：2026-09-30；作者：lq。
      objectiveAction: playerActor.selectedBomb && match.mode.bomb.state === 'carried' && match.mode.bombsiteAt(playerActor.move.origin)
        ? `安装 C4 ${Math.floor(match.mode.bomb.plantProgress * 100)}% · 按住左键`
        : playerActor.team === 'ct' && match.mode.bomb.state === 'planted' && match.mode.bomb.position && Math.hypot(playerActor.move.origin.x - match.mode.bomb.position.x, playerActor.move.origin.y - match.mode.bomb.position.y, playerActor.move.origin.z - match.mode.bomb.position.z) <= DEFUSE_RADIUS
          ? `拆除 C4 ${Math.floor(match.mode.bomb.defuseProgress * 100)}% · 按住 E${playerActor.hasDefuseKit ? ' · 拆弹器' : ''}`
          : playerActor.team === 't' && match.mode.bomb.carrier === playerActor && match.mode.bomb.state === 'carried'
            ? '按 5 取出 C4 · 在包点按住左键安装'
            : match.mode.bomb.state === 'planted' ? 'CT：靠近炸弹按住 E 拆除' : '',
      killFeed,
      buyMenuOpen: buyMenuOpen && match.mode.phase !== 'over',
      buyCategory,
      buyItems: (buyCategory ? buyMenuOptions(playerActor.team, buyCategory) : []).map(({ digit, item }) => ({
        digit,
        label: item.label,
        price: item.price,
        affordable: playerActor.unlimitedFunds || playerActor.money >= item.price,
      })),
      // 功能：按玩家朝向旋转所有存活角色坐标并限制在圆形雷达半径内，敌我用不同颜色区分。时间：2026-09-30；作者：lq。
      radarDots: match.actors.filter((actor) => actor !== hudActor && actor.alive).map((actor) => {
        const dx = actor.move.origin.x - hudActor.move.origin.x;
        const dy = actor.move.origin.y - hudActor.move.origin.y;
        const yaw = (alive ? lookYaw : hudActor.yaw) * Math.PI / 180;
        return {
          x: 50 + (-dx * Math.sin(yaw) + dy * Math.cos(yaw)) / 18,
          y: 50 - (dx * Math.cos(yaw) + dy * Math.sin(yaw)) / 18,
          relation: actor.team === hudActor.team ? 'ally' as const : 'enemy' as const,
        };
      }),
      dead: !alive,
      spectating: spectator?.name ?? null,
      // 功能：按住 Tab 显示原版战绩表，松开立即隐藏。时间：2026-09-30；作者：lq。
      scoreboardOpen: input.isDown('Tab'),
      scoreRows: match.actors.map((actor) => ({ name: actor.name, team: actor.team, kills: actor.kills, deaths: actor.deaths, alive: actor.alive, local: actor === playerActor })),
      radioLine: simTime < radioUntil ? radioLine : '',
      respawnIn: Math.max(0, match.mode.timeLeft),
      matchOver: roundBanner,
      render: renderer.info(),
    });
  }

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
