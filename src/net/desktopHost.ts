/** 功能：客户端一键创建权威房间，显示分享地址并控制原生房间生命周期；时间：2026-11-17；作者：lq。 */
interface DesktopRoom {
  map: string;
  port: number;
  addresses: string[];
  ctSize: number;
  tSize: number;
  skill: number;
  critters: boolean;
}
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
declare global {
  interface Window { __TAURI__?: { core?: { invoke?: Invoke } }; }
}

/** 功能：浏览器显示客户端建房说明，只有 Tauri 客户端调用受限的房间命令；时间：2026-11-17；作者：lq。 */
export function bindDesktopHostUI(): void {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) return;
  let room: DesktopRoom | null = null;
  let pending = false;
  let notice = '';
  const text = (id: string, value: string): void => {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  };
  const render = (): void => {
    const addresses = room?.addresses.map((address) => `${address}:${room!.port}`).join('、');
    const description = room ? `房间已启动 · ${room.map} · CT ${room.ctSize} / T ${room.tSize} 人。${addresses ? `队友在「局域网」输入 ${addresses}，选择相同地图加入。` : `未找到局域网地址，请连接同一 Wi-Fi 后重建房间；端口 ${room.port}。`}` : '';
    // 功能：返回主菜单后回显实际房间配置，避免表单显示与运行中的房间不一致；时间：2026-11-17；作者：lq。
    if (room) {
      for (const [id, value] of Object.entries({ 'room-map': room.map, 'room-port': room.port, 'room-ct': room.ctSize, 'room-t': room.tSize, 'room-skill': room.skill })) {
        const field = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
        if (field) field.value = String(value);
      }
      const critters = document.getElementById('room-critters') as HTMLInputElement | null;
      if (critters) critters.checked = room.critters;
    }
    text('desktop-host-status', notice || description);
    text('hosted-room-status', description);
    const summary = document.getElementById('hosted-room-status');
    if (summary) summary.hidden = !room;
    const start = document.getElementById('desktop-host-start') as HTMLButtonElement | null;
    if (start) { start.disabled = pending; start.textContent = pending ? '正在创建房间…' : room ? '进入已创建房间' : '创建并进入'; }
    document.querySelectorAll<HTMLButtonElement>('[data-stop-hosted-room]').forEach((button) => {
      button.hidden = !room;
      button.disabled = pending;
    });
    document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-room-option]').forEach((field) => { field.disabled = pending || !!room; });
  };
  const refresh = async (): Promise<void> => {
    try { room = await invoke<DesktopRoom | null>('lan_host_status'); }
    catch (error) { notice = `无法读取房间状态：${String(error)}`; }
    render();
  };
  const enter = (current: DesktopRoom): void => {
    const url = new URL(location.href);
    url.searchParams.set('map', current.map);
    url.searchParams.set('lan', '1'); url.searchParams.set('lanhost', '127.0.0.1');
    url.searchParams.set('lanport', String(current.port));
    url.searchParams.set('team', (document.getElementById('room-team') as HTMLSelectElement | null)?.value || 'ct');
    url.searchParams.set('name', (document.getElementById('room-name') as HTMLInputElement | null)?.value.trim().slice(0, 16) || 'Host');
    url.searchParams.set('ctsize', String(current.ctSize)); url.searchParams.set('tsize', String(current.tSize));
    url.searchParams.set('skill', String(current.skill)); url.searchParams.set('critters', current.critters ? '1' : '0');
    // 功能：重载后保留原生房间，清理调试出生参数，并让已连接的房主直接看到进入对局提示；时间：2026-11-17；作者：lq。
    url.searchParams.set('hostroom', '1');
    for (const key of ['pos', 'yaw', 'pitch', 'fly', 'probe', 'nolock']) url.searchParams.delete(key);
    location.assign(url.href);
  };
  window.addEventListener('cs15-open-map-menu', () => { render(); void refresh(); });
  window.addEventListener('focus', () => { void refresh(); });
  document.addEventListener('click', async (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest('[data-stop-hosted-room]')) {
      if (pending) return;
      pending = true; notice = '正在关闭房间…'; render();
      try {
        await invoke('lan_host_stop');
        room = null; notice = '';
        const url = new URL(location.href);
        if (url.searchParams.get('hostroom') === '1') {
          for (const key of ['lan', 'lanhost', 'lanport', 'hostroom']) url.searchParams.delete(key);
          location.assign(url.href);
        }
      } catch (error) { notice = `关闭失败：${String(error)}`; }
      finally { pending = false; render(); }
      return;
    }
    if (!event.target.closest('#desktop-host-start') || pending) return;
    if (room) { enter(room); return; }
    const value = (id: string): string => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null)?.value ?? '';
    const map = value('room-map');
    const port = Number(value('room-port'));
    const ctSize = Number(value('room-ct')), tSize = Number(value('room-t'));
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || ![ctSize, tSize].every((size) => Number.isInteger(size) && size >= 1 && size <= 6)) {
      notice = '端口需为 1024–65535，双方人数需为 1–6 人。'; render(); return;
    }
    pending = true; notice = '正在准备地图和房间…'; render();
    try {
      let mapBytes: number[] | null = null;
      if (!['moonbase', 'white_house'].includes(map)) {
        const response = await fetch(new URL(`cstrike/maps/${map}.bsp`, document.baseURI));
        if (!response.ok) throw new Error('请先导入所选地图的本地素材');
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length < 124 || bytes.length > 64 * 1024 * 1024 || new DataView(bytes.buffer).getInt32(0, true) !== 30) throw new Error('请先导入有效的 CS 1.5 地图 BSP');
        mapBytes = Array.from(bytes);
      }
      room = await invoke<DesktopRoom>('lan_host_start', { options: {
        map, port, ctSize, tSize, skill: Number(value('room-skill')),
        critters: (document.getElementById('room-critters') as HTMLInputElement | null)?.checked ?? true, mapBytes,
      } });
      notice = ''; render(); enter(room);
    } catch (error) { notice = `创建失败：${String(error)}`; }
    finally { pending = false; render(); }
  });
  void refresh();
}
