/** 功能：月球基地本地原版贴图适配、星空地球、月面景观及基地动态地标；时间：2026-11-17；作者：lq。 */
import * as THREE from 'three';
import { parseWad3 } from '../bsp/wad.ts';
import { generateTexture } from '../bsp/write.ts';
import type { BspMiptex } from '../bsp/types.ts';
import type { MaterialEntry } from './textures.ts';
import { toThree } from './boxGeometry.ts';
import { MOONBASE_MATERIALS as MATERIALS } from '../../game/map/moonbaseMaterials.ts';
import { MOONBASE_AIRLOCKS, MOONBASE_LAUNCH_PADS, moonbaseDoorPanels } from '../../game/map/moonbaseInteractions.ts';
import type { MapInteractions } from '../../game/map/interactions.ts';

/** 功能：解码原版索引色，可对月壤和岩石去色，再保留 GoldSrc 的像素过滤；时间：2026-11-17；作者：lq。 */
function textureFromMiptex(source: Pick<BspMiptex, 'width' | 'height' | 'pixels' | 'palette'>, gray = false): THREE.DataTexture {
  const pixels = new Uint8Array(source.width * source.height * 4);
  for (let i = 0; i < source.width * source.height; i++) {
    const index = (source.pixels[i] ?? 0) * 3;
    const r = source.palette[index] ?? 128, g = source.palette[index + 1] ?? 128, b = source.palette[index + 2] ?? 128;
    const luminance = r * 0.299 + g * 0.587 + b * 0.114;
    pixels.set([gray ? luminance : r, gray ? luminance : g, gray ? luminance : b, 255], i * 4);
  }
  const texture = new THREE.DataTexture(pixels, source.width, source.height, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** 功能：优先使用随图精简 WAD，缺失时兼容本机导入素材，再逐材料程序回退；时间：2026-11-17；作者：lq。 */
export async function loadMoonbaseMaterials(): Promise<{ materials: Map<string, MaterialEntry>; note: string }> {
  // 功能：先读取随图精简包，完整包只需一次请求，无需导入任何原版目录；时间：2026-11-17；作者：lq。
  let bundled = new Map<string, BspMiptex>();
  try {
    // 功能：精简包允许版本更新后重验证，防止浏览器永久显示旧月壤贴图；时间：2026-11-17；作者：lq。
    const response = await fetch('moonbase/materials.wad', { cache: 'no-cache' });
    if (response.ok) bundled = parseWad3(await response.arrayBuffer()).textures;
  } catch { /* 功能：随图包缺失时仍可回退到本机素材；时间：2026-11-17；作者：lq。 */ }
  const sources = [...new Set(MATERIALS.filter((entry) => !bundled.has(entry.name)).map((material) => material.source))];
  const archives = new Map<string, Map<string, BspMiptex>>();
  await Promise.all(sources.map(async (name) => {
    try {
      const response = await fetch(`cstrike/${name}.wad`, { cache: 'force-cache' });
      if (response.ok) archives.set(name, parseWad3(await response.arrayBuffer()).textures);
    } catch { /* 功能：素材缺失、损坏或离线不阻止进入原创地图；时间：2026-11-17；作者：lq。 */ }
  }));
  const materials = new Map<string, MaterialEntry>();
  let resolved = 0;
  for (const entry of MATERIALS) {
    const original = bundled.get(entry.name) ?? archives.get(entry.source)?.get(entry.texture);
    const source = original && !original.external ? original : generateTexture(entry.fallback, 64);
    if (source === original) resolved++;
    materials.set(entry.name, {
      material: new THREE.MeshLambertMaterial({ color: entry.tint, map: textureFromMiptex(source, entry.gray) }),
      tileUnits: entry.tile,
    });
  }
  for (const [name, color] of [['luna_cyan', 0x56ddeb], ['luna_gold', 0xf4bc59]] as const) materials.set(name, {
    material: new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.65 }), tileUnits: 64,
  });
  return { materials, note: `月球基地 · 随图/本地原版贴图 ${resolved}/${MATERIALS.length} · A 反应堆 / B 登月坪 · 室外低重力，密封舱内标准重力` };
}

/** 功能：Canvas 只负责原创指示牌和地球程序纹理，所有建筑仍优先使用原版地图素材；时间：2026-11-17；作者：lq。 */
function canvasTexture(width: number, height: number, paint: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('月球基地标牌需要 Canvas 2D');
  paint(context);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** 功能：绘制低分辨率地球海洋、大陆、冰盖和云层，提供月球地平线的视觉锚点；时间：2026-11-17；作者：lq。 */
function earthTexture(): THREE.CanvasTexture {
  return canvasTexture(512, 256, (ctx) => {
    ctx.fillStyle = '#1c5683'; ctx.fillRect(0, 0, 512, 256);
    const continents = [
      [[34, 55], [60, 37], [118, 38], [151, 63], [123, 90], [109, 106], [88, 92], [74, 117], [65, 84]],
      [[113, 116], [140, 117], [158, 143], [141, 174], [131, 207], [114, 185], [106, 144]],
      [[234, 62], [273, 48], [319, 60], [343, 37], [425, 47], [463, 83], [414, 111], [381, 95], [354, 128], [329, 102], [303, 112], [273, 87]],
      [[252, 101], [294, 105], [310, 136], [279, 176], [258, 156], [242, 117]],
      [[405, 171], [436, 162], [453, 179], [436, 196], [409, 192]],
    ];
    ctx.fillStyle = '#7b967c';
    for (const points of continents) {
      ctx.beginPath(); points.forEach(([x, y], index) => index ? ctx.lineTo(x!, y!) : ctx.moveTo(x!, y!)); ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = '#d5e6e9'; ctx.fillRect(0, 0, 512, 18); ctx.fillRect(0, 239, 512, 17);
    for (let i = 0; i < 90; i++) {
      ctx.fillStyle = 'rgba(236,247,255,.32)';
      ctx.beginPath(); ctx.ellipse((i * 137.3) % 512, 22 + (i * 53.7) % 214, 14 + i % 20, 2 + i % 5, -0.18, 0, Math.PI * 2); ctx.fill();
    }
  });
}

/** 功能：构造独立的原创环境物件，模拟时间驱动地球、天线和反应堆，暂停时全部冻结；时间：2026-11-17；作者：lq。 */
export function createMoonbaseVisuals(materials: Map<string, MaterialEntry>, interactions?: MapInteractions): { object: THREE.Group; update: (time: number) => void } {
  const group = new THREE.Group();
  group.name = '月球基地 / LUNA-15';
  const metal = materials.get('luna_metal')!.material;
  const rock = materials.get('luna_rock')!.material;
  const cyan = new THREE.MeshBasicMaterial({ color: 0x68e8f8 });
  const gold = new THREE.MeshBasicMaterial({ color: 0xf1bf67 });
  const place = <T extends THREE.Object3D>(object: T, x: number, y: number, z: number, parent = group): T => {
    object.position.set(...toThree(x, y, z)); parent.add(object); return object;
  };

  // 功能：确定性星空不使用外网图片，星点禁用雾化且位于所有战斗地形之外；时间：2026-11-17；作者：lq。
  const stars: number[] = [];
  let seed = 15017;
  const random = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 1300; i++) {
    const yaw = random() * Math.PI * 2, elevation = 0.02 + random() * 1.5;
    stars.push(Math.cos(yaw) * Math.cos(elevation) * 11000, Math.sin(elevation) * 11000, Math.sin(yaw) * Math.cos(elevation) * 11000);
  }
  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute('position', new THREE.Float32BufferAttribute(stars, 3));
  group.add(new THREE.Points(starGeometry, new THREE.PointsMaterial({ color: 0xc9dfef, size: 9, sizeAttenuation: true, fog: false })));
  const earth = place(new THREE.Mesh(new THREE.SphereGeometry(670, 48, 32), new THREE.MeshLambertMaterial({ map: earthTexture(), fog: false })), -4200, 6800, 3000);
  earth.rotation.z = -0.25;
  const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(687, 48, 32), new THREE.MeshBasicMaterial({ color: 0x68baff, transparent: true, opacity: 0.12, side: THREE.BackSide, fog: false }));
  earth.add(atmosphere);

  // 功能：边界外陨石山脊和环形坑提供月面轮廓；可玩的岩石碰撞仍由地图 boxes 定义；时间：2026-11-17；作者：lq。
  const boulderGeometry = new THREE.DodecahedronGeometry(1, 0);
  for (let i = 0; i < 42; i++) {
    const angle = i / 42 * Math.PI * 2, radius = 1900 + random() * 450;
    const boulder = place(new THREE.Mesh(boulderGeometry, rock), Math.cos(angle) * radius * 1.1, Math.sin(angle) * radius, 70 + random() * 100);
    boulder.scale.set(150 + random() * 270, 160 + random() * 180, 130 + random() * 240);
    boulder.rotation.set(random(), random(), random());
  }
  for (const [x, y, radius] of [[-1040, -592, 112], [1120, 592, 120], [280, -496, 80]]) {
    const crater = place(new THREE.Mesh(new THREE.TorusGeometry(radius!, 10, 4, 32), rock), x!, y!, 3);
    crater.rotation.x = -Math.PI / 2; crater.scale.y = 0.8;
  }

  // 功能：可从远处辨识的太阳能阵列、三足通信天线和着陆舱喷口强化原创基地轮廓；时间：2026-11-17；作者：lq。
  const solarMaterial = new THREE.MeshBasicMaterial({ color: 0x183f61, wireframe: false });
  for (const side of [-1, 1]) {
    const panels = place(new THREE.Group(), side * 1060, side * 1020, 150);
    panels.rotation.z = side * 0.15;
    for (let i = 0; i < 4; i++) {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(72, 5, 160), solarMaterial);
      panel.position.x = (i - 1.5) * 80; panels.add(panel);
      const frame = new THREE.LineSegments(new THREE.EdgesGeometry(panel.geometry), new THREE.LineBasicMaterial({ color: 0x8eabbf }));
      frame.position.copy(panel.position); panels.add(frame);
    }
    const mast = place(new THREE.Mesh(new THREE.CylinderGeometry(5, 8, 144, 6), metal), side * 1060, side * 1020, 72);
    mast.name = '太阳能阵列支架';
  }
  const antenna = place(new THREE.Group(), -1248, 288, 240);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(8, 16, 144, 8), metal); mast.position.y = 72; antenna.add(mast);
  const dish = new THREE.Mesh(new THREE.SphereGeometry(80, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0xcbd9e1, side: THREE.DoubleSide }));
  dish.position.y = 160; dish.rotation.z = 0.55; antenna.add(dish);
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(8, 8, 6), cyan); beacon.position.y = 230; antenna.add(beacon);
  place(new THREE.Mesh(new THREE.ConeGeometry(45, 56, 8), metal), 1176, 184, 228);
  const nozzle = place(new THREE.Mesh(new THREE.CylinderGeometry(28, 44, 36, 8), metal), 1176, 184, 32);
  nozzle.name = '登月舱发动机';
  const reactor = place(new THREE.Mesh(new THREE.TorusGeometry(62, 4, 6, 32), cyan), -1048, -56, 98);
  reactor.rotation.x = -Math.PI / 2;

  // 功能：出生舱观景窗可以看见地球，透明玻璃与舱体外轮廓一致；时间：2026-11-17；作者：lq。
  const glass = new THREE.MeshBasicMaterial({ color: 0x83bbd1, opacity: 0.15, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  for (const side of [-1, 1]) {
    place(new THREE.Mesh(new THREE.BoxGeometry(832, 192, 8), glass), 0, side * 1244, 96);
    for (const x of [-408, -208, 0, 208, 408]) place(new THREE.Mesh(new THREE.BoxGeometry(8, 192, 12), metal), x, side * 1244, 96);
  }

  // 功能：原创中英标牌为路线、包点和重力规则提供场景内提示；时间：2026-11-17；作者：lq。
  const sign = (title: string, subtitle: string, x: number, y: number, z: number, width: number, color: string, ground = false, facing = 1): void => {
    const texture = canvasTexture(768, 192, (ctx) => {
      ctx.fillStyle = '#0b1721'; ctx.fillRect(0, 0, 768, 192);
      ctx.fillStyle = color; ctx.fillRect(0, 0, 8, 192);
      ctx.font = 'bold 56px sans-serif'; ctx.fillText(title, 32, 84);
      ctx.font = '24px monospace'; ctx.fillStyle = '#c0d1dc'; ctx.fillText(subtitle, 34, 143);
    });
    const mesh = place(new THREE.Mesh(new THREE.PlaneGeometry(width, width / 4), new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide })), x, y, z);
    if (ground) mesh.rotation.x = -Math.PI / 2;
    else if (facing < 0) mesh.rotation.y = Math.PI;
  };
  sign('月球基地 / LUNA-15', 'TRAVEL LIGHT. WATCH THE SKY.', 0, 1270, 280, 650, '#65d8eb');
  sign('A  反应堆', 'REACTOR  /  STANDARD GRAVITY', -1056, -418, 192, 344, '#65d8eb');
  sign('A  反应堆', 'REACTOR  /  STANDARD GRAVITY', -1056, 418, 192, 344, '#65d8eb', false, -1);
  sign('B  登月坪', 'LANDING PAD  /  LOW GRAVITY', 1008, -192, 18, 360, '#f1bf67', true);
  sign('A  REACTOR', 'ARM THE CHARGE HERE', -1016, 128, 3, 280, '#65d8eb', true);
  sign('观测桥', 'OBSERVATION / UPPER DECK', 0, -130, 184, 280, '#65d8eb');
  sign('维护通道 →', 'CROUCH / QUIET FLANK', -1410, -514, 78, 116, '#65d8eb');
  for (const side of [-1, 1]) sign('月面低重力', 'SPACE: LONG JUMP  /  A ←   → B', 0, side * 958, 174, 340, '#65d8eb', false, side < 0 ? -1 : 1);

  // 功能：双扇气闸网格由模拟层相同面板定义生成，每帧只同步坐标，避免门显示与碰撞分离；时间：2026-11-17；作者：lq。
  const airlocks = MOONBASE_AIRLOCKS.map((door, index) => {
    const panels = moonbaseDoorPanels(index, 0).map((panel) => {
      const width = panel.maxs.x - panel.mins.x, depth = panel.maxs.y - panel.mins.y;
      const mesh = place(new THREE.Mesh(new THREE.BoxGeometry(width, 160, depth), materials.get('luna_shell')!.material), 0, 0, 80);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color: 0x62cddd }));
      mesh.add(edges);
      return mesh;
    });
    const control = place(new THREE.Mesh(new THREE.BoxGeometry(door.axis === 'x' ? 48 : 5, 22, door.axis === 'x' ? 5 : 48), cyan),
      door.center.x, door.center.y, 164);
    control.name = '气闸 / E 开关';
    return panels;
  });
  const padLights = MOONBASE_LAUNCH_PADS.map(({ center }, index) => {
    const material = new THREE.MeshBasicMaterial({ color: 0x526577 });
    const ring = place(new THREE.Mesh(new THREE.TorusGeometry(51, 5, 6, 32), material), center.x, center.y, 10);
    ring.rotation.x = -Math.PI / 2;
    const arrow = place(new THREE.Mesh(new THREE.ConeGeometry(13, 34, 3), material), center.x, center.y, 12);
    arrow.rotation.x = index === 0 ? -Math.PI / 2 : Math.PI / 2;
    sign('E / 弹射平台', 'ARM 8s / TO UPPER DECK', center.x, center.y - (index === 0 ? 28 : -28), 9, 116, '#65d8eb', true);
    return material;
  });

  // 功能：登月坪四角灯、反应堆脉冲与慢速天线使用少量基础材质，避免叠加实时光源；时间：2026-11-17；作者：lq。
  for (const x of [752, 1360]) for (const y of [-368, 368]) place(new THREE.Mesh(new THREE.CylinderGeometry(6, 9, 24, 8), gold), x, y, 28);
  return { object: group, update: (time) => {
    earth.rotation.y = time * 0.006 + 0.6;
    dish.rotation.y = Math.sin(time * 0.12) * 0.45;
    beacon.scale.setScalar(0.85 + Math.sin(time * 2) * 0.15);
    reactor.rotation.z = time * 0.35;
    reactor.scale.setScalar(1 + Math.sin(time * 2.4) * 0.035);
    // 功能：房主和本地对局均从地图快照读取同一气闸与平台状态，关机灰灯、启动青灯；时间：2026-11-17；作者：lq。
    for (const state of interactions?.snapshotDoors?.() ?? []) {
      if (state.index < airlocks.length) moonbaseDoorPanels(state.index, state.progress).forEach((panel, index) => {
        airlocks[state.index]![index]!.position.set(...toThree((panel.mins.x + panel.maxs.x) / 2, (panel.mins.y + panel.maxs.y) / 2, 80));
      });
      else if (state.index >= 100 && padLights[state.index - 100]) padLights[state.index - 100]!.color.setHex(state.progress > 0 ? 0x56e8eb : 0x526577);
    }
  } };
}
