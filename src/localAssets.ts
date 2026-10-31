// 功能：把用户自行选择的本地素材保存到浏览器本地，并接管 cstrike/* 请求；时间：2026-10-30；作者：lq。
const DB_NAME = 'cs15-web-local-assets';
const STORE_NAME = 'files';
const DB_VERSION = 1;
// 功能：应用内自动解锁分享素材包，阻止普通解压工具直接展开原版素材；时间：2026-10-31；作者：lq。
const ASSET_PACKAGE_PASSWORD = 'cs15-web-local-assets-v1';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开本地素材存储'));
  });
}

function assetKey(file: File): string {
  const raw = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
  const parts = raw.split('/').filter(Boolean);
  const cstrike = parts.findIndex((part) => part.toLowerCase() === 'cstrike');
  return (cstrike >= 0 ? parts.slice(cstrike + 1) : parts.length > 1 ? parts.slice(1) : parts).join('/');
}

function mimeFor(key: string): string {
  const extension = key.split('.').pop()?.toLowerCase();
  return ({ bsp: 'application/octet-stream', wad: 'application/octet-stream', mdl: 'application/octet-stream', wav: 'audio/wav', mp3: 'audio/mpeg', bmp: 'image/bmp', tga: 'image/x-tga', png: 'image/png' } as Record<string, string>)[extension ?? ''] ?? 'application/octet-stream';
}

function crc32Byte(crc: number, value: number): number {
  let next = (crc ^ value) >>> 0;
  for (let bit = 0; bit < 8; bit += 1) next = (next & 1) ? (next >>> 1) ^ 0xedb88320 : next >>> 1;
  return next >>> 0;
}

function decryptZipCrypto(data: Uint8Array, password: string, checkByte: number): Uint8Array {
  let key0 = 0x12345678;
  let key1 = 0x23456789;
  let key2 = 0x34567890;
  const update = (value: number): void => {
    key0 = crc32Byte(key0, value);
    key1 = (Math.imul((key1 + (key0 & 0xff)) >>> 0, 134775813) + 1) >>> 0;
    key2 = crc32Byte(key2, key1 >>> 24);
  };
  for (let index = 0; index < password.length; index += 1) update(password.charCodeAt(index) & 0xff);
  const plain = new Uint8Array(data.length);
  for (let index = 0; index < data.length; index += 1) {
    const temp = (key2 | 2) >>> 0;
    const magic = ((Math.imul(temp, temp ^ 1) >>> 8) & 0xff);
    plain[index] = data[index]! ^ magic;
    update(plain[index]!);
  }
  if (plain.length < 12 || plain[11] !== checkByte) throw new Error('素材 ZIP 密码不匹配');
  return plain.slice(12);
}

/** 功能：读取 ZIP 中的 cstrike/* 文件，支持浏览器直接导入本地素材包；时间：2026-10-31；作者：lq。 */
async function unzipCstrike(file: File): Promise<{ key: string; file: File }[]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 0xffff - 22); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 素材包');
  const entries = view.getUint16(eocd + 10, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  const result: { key: string; file: File }[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < entries; index += 1) {
    const centralEntry = cursor;
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error('ZIP 目录损坏');
    const method = view.getUint16(cursor + 10, true);
    const flags = view.getUint16(cursor + 8, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)).replaceAll('\\', '/');
    cursor += 46 + nameLength + extraLength + commentLength;
    const marker = name.toLowerCase().indexOf('cstrike/');
    if (marker < 0 || name.endsWith('/')) continue;
    const key = name.slice(marker + 'cstrike/'.length);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    let compressed: Uint8Array<ArrayBufferLike> = bytes.slice(dataStart, dataStart + compressedSize);
    if (flags & 1) {
      // 功能：兼容 zip 命令写入数据描述符时的传统加密校验字节；时间：2026-10-31；作者：lq。
      const checkByte = (flags & 8) ? (view.getUint16(centralEntry + 12, true) >>> 8) : (crc >>> 24) & 0xff;
      compressed = decryptZipCrypto(compressed, ASSET_PACKAGE_PASSWORD, checkByte);
    }
    let data: ArrayBuffer;
    if (method === 0) data = compressed.buffer as ArrayBuffer;
    else if (method === 8) {
      const stream = new Blob([compressed.buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      data = await new Response(stream).arrayBuffer();
    } else throw new Error(`ZIP 使用了不支持的压缩方式：${method}`);
    if (data.byteLength !== uncompressedSize) throw new Error(`ZIP 文件大小校验失败：${key}`);
    result.push({ key, file: new File([data], key, { type: mimeFor(key) }) });
  }
  if (!result.length) throw new Error('ZIP 中没有找到 cstrike 素材');
  return result;
}

async function readAsset(key: string): Promise<Blob | null> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result instanceof Blob ? request.result : null);
    request.onerror = () => reject(request.error ?? new Error('读取本地素材失败'));
  });
}

/** 功能：安装素材请求拦截，未导入的资源继续走默认网络/打包路径；时间：2026-10-30；作者：lq。 */
export function installLocalAssetFetch(): void {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url, window.location.href);
    const marker = '/cstrike/';
    const markerIndex = url.pathname.indexOf(marker);
    if (markerIndex >= 0) {
      const key = decodeURIComponent(url.pathname.slice(markerIndex + marker.length));
      const blob = await readAsset(key);
      if (blob) return new Response(blob, { status: 200, headers: { 'Content-Type': mimeFor(key) } });
    }
    return originalFetch(input, init);
  };
}

/** 功能：导入用户自行拥有的 CS 素材目录，不上传文件；时间：2026-10-30；作者：lq。 */
export async function importLocalAssets(files: File[]): Promise<number> {
  return importAssetEntries(files.map((file) => ({ file, key: assetKey(file) })));
}

/** 功能：把已解析的目录或 ZIP 素材写入本机 IndexedDB；时间：2026-10-31；作者：lq。 */
async function importAssetEntries(entries: { file: File; key: string }[]): Promise<number> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    store.clear();
    for (const { file, key } of entries) {
      if (key) store.put(file, key);
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('保存本地素材失败'));
  });
  return entries.filter(({ key }) => Boolean(key)).length;
}

/** 功能：绑定主菜单本地素材导入入口，导入后重新加载地图；时间：2026-10-30；作者：lq。 */
export function bindLocalAssetImporter(): void {
  const button = document.getElementById('importAssetsBtn');
  const input = document.getElementById('localAssetsInput') as HTMLInputElement | null;
  const zipInput = document.getElementById('localAssetsZipInput') as HTMLInputElement | null;
  const zipButton = document.getElementById('importAssetsZipBtn');
  const status = document.getElementById('assetImportStatus');
  if (!button || !input) return;
  button.addEventListener('click', () => input.click());
  zipButton?.addEventListener('click', () => zipInput?.click());
  input.addEventListener('change', async () => {
    const files = Array.from(input.files ?? []);
    if (!files.length) return;
    if (status) status.textContent = '正在导入素材…';
    try {
      const count = await importLocalAssets(files);
      if (status) status.textContent = `已导入 ${count} 个文件，正在重新加载…`;
      window.setTimeout(() => window.location.reload(), 350);
    } catch (error) {
      if (status) status.textContent = `导入失败：${String(error)}`;
    }
  });
  zipInput?.addEventListener('change', async () => {
    const zip = zipInput.files?.[0];
    if (!zip) return;
    if (status) status.textContent = '正在读取 ZIP 素材包…';
    try {
      // 功能：兼容 macOS 文件选择器不识别 ZIP MIME 的情况，选择后再校验扩展名；时间：2026-10-31；作者：lq。
      if (!zip.name.toLowerCase().endsWith('.zip')) throw new Error('请选择 .zip 素材包');
      const entries = await unzipCstrike(zip);
      const count = await importAssetEntries(entries);
      if (status) status.textContent = `已从 ZIP 导入 ${count} 个文件，正在重新加载…`;
      window.setTimeout(() => window.location.reload(), 350);
    } catch (error) {
      if (status) status.textContent = `ZIP 导入失败：${String(error)}`;
    } finally {
      zipInput.value = '';
    }
  });
}
