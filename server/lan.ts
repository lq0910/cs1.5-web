/** 功能：运行 64Hz 权威局域网房间，校验输入并按 20Hz 广播模拟快照；时间：2026-11-17；作者：lq。 */
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { buildNavGraph } from '../src/game/nav.ts';
import { bombSitesFromBsp } from '../src/game/objectives.ts';
import { Match } from '../src/game/match.ts';
// 功能：房主共用固定步预算和装备购买回执；时间：2026-11-18；作者：lq。
import { fixedFrameSteps } from '../src/game/clock.ts';
import { applyPlayerActions } from '../src/net/actions.ts';
import { TICK_INTERVAL } from '../src/game/constants.ts';
import { mapTeamSizeLimits } from '../src/game/matchSettings.ts';
import { LAN_PROTOCOL, encodeEvents, snapshotWorld } from '../src/net/protocol.ts';
import type { InputPacket, PlayerActions, RoomInfo, WorldSnapshot } from '../src/net/protocol.ts';
import type { Actor, Team } from '../src/game/actors.ts';
import type { MapData } from '../src/game/map/build.ts';
import { loadLanMap } from './lanMap.ts';

interface Client {
  socket: WebSocket;
  id: string;
  actor: Actor;
  latest: InputPacket;
  seq: number;
  pending: PlayerActions;
  ack: number;
}

const arg = (key: string, fallback: string): string => {
  const index = process.argv.indexOf(key);
  return index < 0 ? fallback : process.argv[index + 1] ?? fallback;
};
const mapName = arg('--map', 'de_dust2');
const port = Math.max(1024, Math.min(65535, Number(arg('--port', '3001')) || 3001));
const webPort = Math.max(1024, Math.min(65535, Number(arg('--web-port', '5173')) || 5173));
// 功能：客户端传入私有地图目录和对局配置，不依赖安装目录可写或当前工作目录；时间：2026-11-17；作者：lq。
const root = resolve(arg('--root', process.cwd()));
const parentPid = Number(arg('--parent-pid', '0'));

function addresses(): string[] {
  return Object.values(networkInterfaces()).flatMap((list) => (list ?? [])
    .filter((entry) => {
      if (entry.family !== 'IPv4' || entry.internal) return false;
      const [a, b] = entry.address.split('.').map(Number);
      return a === 10 || (a === 192 && b === 168) || (a === 172 && b! >= 16 && b! <= 31);
    }).map((entry) => entry.address));
}

function playerName(value: unknown): string {
  const clean = String(value ?? '').replace(/[^\p{L}\p{N}_ -]/gu, '').trim().slice(0, 16);
  return clean || 'Player';
}

async function start(): Promise<void> {
  const map: MapData = await loadLanMap(root, mapName);
  const graph = buildNavGraph(map.collision, map.bounds, { cellSize: 64 });
  const limits = mapTeamSizeLimits(map.spawns);
  const ctSize = Math.max(1, Math.min(limits.ct, Number(arg('--ctsize', String(limits.ct))) || 1));
  const tSize = Math.max(1, Math.min(limits.t, Number(arg('--tsize', String(limits.t))) || 1));
  const skill = Math.max(0, Math.min(1, Number(arg('--skill', '0.45')) || 0));
  const critters = arg('--critters', '1') !== '0';
  const seed = Math.floor(Math.random() * 0xffffffff);
  const match = new Match({ map, graph, sites: map.sites ?? (map.bsp ? bombSitesFromBsp(map.bsp as never) : []), ctSize, tSize,
    seed, skill, critters, multiplayer: true });
  match.startNow();
  const clients = new Map<string, Client>();
  const wss = new WebSocketServer({ host: '0.0.0.0', port, maxPayload: 8192 });
  await new Promise<void>((resolveListen, rejectListen) => {
    wss.once('listening', () => resolveListen());
    wss.once('error', rejectListen);
  });
  const room: RoomInfo & { seed: number } = {
    protocol: LAN_PROTOCOL, map: mapName, fingerprint: map.fingerprint ?? 'missing', ctSize, tSize,
    skill, seed, players: [], urls: addresses().map((address) => `http://${address}:${webPort}/?map=${mapName}&lan=1`),
  };
  let tick = 0;
  let generation = 0;
  let simTime = 0;
  let pendingEvents: ReturnType<typeof encodeEvents>[] = [];
  const ids = new WeakMap<WebSocket, string>();

  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      let message: Record<string, unknown>;
      try { message = JSON.parse(raw.toString()) as Record<string, unknown>; } catch { socket.close(1003, 'invalid json'); return; }
      if (message.type === 'hello') {
        if (message.protocol !== LAN_PROTOCOL || message.map !== mapName || message.fingerprint !== room.fingerprint) {
          socket.send(JSON.stringify({ type: 'error', message: `版本或地图不匹配。房间地图：${mapName}，请双方导入同一地图素材。` }));
          socket.close(1008, 'map mismatch'); return;
        }
        const team: Team = message.team === 't' ? 't' : 'ct';
        const actor = match.claimSeat(team, playerName(message.name));
        if (!actor) { socket.send(JSON.stringify({ type: 'error', message: `${team.toUpperCase()} 队伍已满。` })); socket.close(1008, 'team full'); return; }
        const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
        const client: Client = { socket, id, actor, latest: { type: 'input', seq: 0, command: { buttons: 0, forwardmove: 0, sidemove: 0, upmove: 0, yaw: actor.yaw, pitch: actor.pitch }, actions: {} }, seq: -1, pending: {}, ack: 0 };
        clients.set(id, client); ids.set(socket, id);
        socket.send(JSON.stringify({ type: 'welcome', id, actorId: actor.id, team, room }));
        return;
      }
      const id = ids.get(socket), client = id ? clients.get(id) : undefined;
      // 功能：允许已握手的任一房间玩家请求整局重开，由房主权威模拟统一执行；时间：2026-11-17；作者：lq。
      if (message.type === 'restart' && client) {
        generation++;
        match.restartNow(simTime);
        for (const roomClient of clients.values()) {
          roomClient.pending = {};
          roomClient.latest = { ...roomClient.latest, command: {
            ...roomClient.latest.command, buttons: 0, forwardmove: 0, sidemove: 0, upmove: 0,
          } };
        }
        pendingEvents = [];
        return;
      }
      if (message.type === 'input' && client) {
        const packet = message as unknown as InputPacket;
        if (!Number.isInteger(packet.seq) || packet.seq <= client.seq || !packet.command
          || !Number.isFinite(packet.command.yaw) || !Number.isFinite(packet.command.pitch)
          || !Number.isFinite(packet.command.forwardmove) || !Number.isFinite(packet.command.sidemove)) return;
        client.seq = packet.seq; client.ack = packet.seq;
        client.latest = { ...packet, command: { ...packet.command,
          yaw: Math.max(-3600, Math.min(3600, packet.command.yaw)),
          pitch: Math.max(-89, Math.min(89, packet.command.pitch)),
          forwardmove: Math.max(-400, Math.min(400, packet.command.forwardmove)),
          sidemove: Math.max(-400, Math.min(400, packet.command.sidemove)), buttons: packet.command.buttons & 65535,
        } };
        client.pending = { ...client.pending, ...(packet.actions ?? {}) };
      }
    });
    socket.on('close', () => {
      const id = ids.get(socket), client = id ? clients.get(id) : undefined;
      if (!client) return;
      match.releaseSeat(client.actor); clients.delete(client.id);
    });
  });

  console.log(`LAN room: ${map.name} (${mapName}) · ${ctSize} CT / ${tSize} T`);
  console.log(`Join in a browser: ${room.urls.join('  ') || `http://<房主局域网IP>:${webPort}/?map=${mapName}&lan=1`}`);
  console.log(`WebSocket: ws://<房主局域网IP>:${port} · matching local BSP required`);
  // 功能：监听成功后才通知桌面壳，避免创建按钮在端口冲突或地图失败时误报成功；时间：2026-11-17；作者：lq。
  console.log(`CS15_LAN_READY ${JSON.stringify({ map: mapName, port, addresses: addresses(), ctSize, tSize, skill, critters })}`);
  // 功能：按真实经过时间分配 64Hz 模拟步，避免 Node 将 15.625ms 定时器取整造成房间整体加速；时间：2026-11-18；作者：lq。
  let previousTime = performance.now();
  let accumulator = 0;
  const timer = setInterval(() => {
    const currentTime = performance.now();
    const budget = fixedFrameSteps(accumulator, (currentTime - previousTime) / 1000);
    previousTime = currentTime;
    accumulator = budget.remainder;
    for (let step = 0; step < budget.steps; step++) {
    tick++; simTime += TICK_INTERVAL;
    const commands = new Map<number, InputPacket['command']>();
    for (const client of clients.values()) {
      commands.set(client.actor.id, client.latest.command);
      if (Object.keys(client.pending).length) {
        const results = applyPlayerActions(match, client.actor, client.pending, simTime);
        if (results.length && client.socket.readyState === WebSocket.OPEN) {
          client.socket.send(JSON.stringify({ type: 'purchase-results', results }));
        }
        client.pending = {};
      }
    }
    pendingEvents.push(encodeEvents(match.update(simTime, undefined, commands)));
    if (tick % 3 !== 0) continue;
    const events = pendingEvents; pendingEvents = [];
    for (const client of clients.values()) {
      if (client.socket.readyState !== WebSocket.OPEN) continue;
      const snapshot: WorldSnapshot = snapshotWorld(match, tick, simTime, map.interactions?.snapshotDoors?.() ?? [], events, generation);
      snapshot.ack = client.ack;
      client.socket.send(JSON.stringify(snapshot));
    }
    }
  }, TICK_INTERVAL * 1000);
  // 功能：桌面壳异常退出时也停止子进程；正常关闭立即释放玩家连接、计时器与监听端口；时间：2026-11-17；作者：lq。
  const parentTimer = parentPid > 0 ? setInterval(() => {
    try { process.kill(parentPid, 0); } catch { stop(); }
  }, 2000) : null;
  const stop = (): void => {
    clearInterval(timer);
    if (parentTimer) clearInterval(parentTimer);
    for (const client of clients.values()) client.socket.terminate();
    wss.close();
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}

start().catch((error: unknown) => { console.error(`[lan] ${String(error)}`); process.exitCode = 1; });
