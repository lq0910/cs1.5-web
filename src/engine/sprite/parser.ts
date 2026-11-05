/** 功能：解析 GoldSrc IDSP v2 调色板精灵，供原版爆炸/烟雾逐帧播放。时间：2026-11-05；作者：lq。 */
export interface SpriteFrame { width: number; height: number; originX: number; originY: number; rgba: Uint8Array }
export interface GoldSrcSprite { format: number; frames: SpriteFrame[] }

/** 功能：校验文件边界并解码普通、加色、索引透明与掩码精灵，损坏素材安全回退。时间：2026-11-05；作者：lq。 */
export function parseSprite(bytes: Uint8Array): GoldSrcSprite {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const check = (offset: number, length: number) => {
    if (offset < 0 || length < 0 || offset + length > bytes.length) throw new Error('Truncated GoldSrc sprite');
  };
  check(0, 42);
  if (view.getUint32(0, true) !== 0x50534449 || view.getInt32(4, true) !== 2) throw new Error('Expected IDSP v2');
  const format = view.getInt32(12, true);
  const count = view.getInt32(28, true);
  const colors = view.getUint16(40, true);
  if (format < 0 || format > 3 || count < 1 || count > 1024 || colors < 1 || colors > 256) throw new Error('Invalid sprite header');
  check(42, colors * 3);
  const palette = bytes.subarray(42, 42 + colors * 3);
  let cursor = 42 + colors * 3;
  const frames: SpriteFrame[] = [];
  for (let index = 0; index < count; index++) {
    check(cursor, 20);
    if (view.getInt32(cursor, true) !== 0) throw new Error('Grouped sprites are unsupported');
    const originX = view.getInt32(cursor + 4, true);
    const originY = view.getInt32(cursor + 8, true);
    const width = view.getInt32(cursor + 12, true);
    const height = view.getInt32(cursor + 16, true);
    if (width < 1 || height < 1 || width > 2048 || height > 2048) throw new Error('Invalid sprite dimensions');
    cursor += 20;
    check(cursor, width * height);
    const rgba = new Uint8Array(width * height * 4);
    for (let pixel = 0; pixel < width * height; pixel++) {
      const color = bytes[cursor + pixel]!;
      if (color >= colors) throw new Error('Invalid sprite palette index');
      const entry = (format === 2 ? colors - 1 : color) * 3;
      rgba.set([palette[entry]!, palette[entry + 1]!, palette[entry + 2]!, format === 2 ? color : format === 3 && color === 255 ? 0 : 255], pixel * 4);
    }
    cursor += width * height;
    frames.push({ width, height, originX, originY, rgba });
  }
  return { format, frames };
}
