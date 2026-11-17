/** 功能：月球基地精简贴图清单，供随图打包工具和浏览器共用；时间：2026-11-17；作者：lq。 */
export const MOONBASE_MATERIALS = [
  { name: 'luna_dust', source: 'de_dust2', texture: '-0sand', fallback: 'sand', tile: 192, gray: true, tint: 0xd5d6dc },
  { name: 'luna_rock', source: 'de_aztec', texture: '-0cstrike_fj2dk', fallback: 'concrete', tile: 192, gray: true, tint: 0x777f8c },
  { name: 'luna_shell', source: 'cs_747', texture: 'planewhite', fallback: 'stucco', tile: 128, gray: false, tint: 0xd3dde7 },
  { name: 'luna_metal', source: 'cs_assault', texture: 'metal_wall05b', fallback: 'metal', tile: 128, gray: true, tint: 0xa5b6c8 },
  { name: 'luna_floor', source: 'cs_747', texture: 'drkmtlt_flr01', fallback: 'metal', tile: 128, gray: false, tint: 0xb6c1cd },
  { name: 'luna_console', source: 'cs_office', texture: '~lab1_comp8b', fallback: 'metal', tile: 96, gray: false, tint: 0xd6f6ff },
  { name: 'luna_crate', source: 'de_dust2', texture: 'mltrycrtesd', fallback: 'wood', tile: 96, gray: false, tint: 0xb4bfab },
  { name: 'luna_duct', source: 'cs_assault', texture: 'duct_flr01', fallback: 'metal', tile: 64, gray: false, tint: 0x869aa8 },
] as const;
