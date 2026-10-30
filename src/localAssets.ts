// 功能：把用户自行选择的本地素材保存到浏览器本地，并接管 cstrike/* 请求；时间：2026-10-30；作者：lq。
const DB_NAME = 'cs15-web-local-assets';
const STORE_NAME = 'files';
const DB_VERSION = 1;

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
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    store.clear();
    for (const file of files) {
      const key = assetKey(file);
      if (key) store.put(file, key);
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('保存本地素材失败'));
  });
  return files.length;
}

/** 功能：绑定主菜单本地素材导入入口，导入后重新加载地图；时间：2026-10-30；作者：lq。 */
export function bindLocalAssetImporter(): void {
  const button = document.getElementById('importAssetsBtn');
  const input = document.getElementById('localAssetsInput') as HTMLInputElement | null;
  const status = document.getElementById('assetImportStatus');
  if (!button || !input) return;
  button.addEventListener('click', () => input.click());
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
}
