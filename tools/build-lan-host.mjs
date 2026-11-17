/** 功能：将权威房间服务及当前平台 Node 运行时打入桌面资源，用户无需安装 Node；时间：2026-11-17；作者：lq。 */
import { build } from 'vite';
import { copyFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const output = resolve('src-tauri/resources/lan-host');
await build({
  configFile: false,
  publicDir: false,
  ssr: { noExternal: true },
  build: {
    ssr: resolve('server/lan.ts'),
    outDir: output,
    emptyOutDir: true,
    minify: false,
    rollupOptions: { output: { entryFileNames: 'server.mjs' } },
  },
});
await mkdir(output, { recursive: true });
const runtime = resolve(output, process.platform === 'win32' ? 'node.exe' : 'node');
await copyFile(process.execPath, runtime);
if (process.platform !== 'win32') await chmod(runtime, 0o755);

// 功能：随内置运行时和打包依赖保留许可证；官方 Node 安装包与 nvm 安装布局均可读取；时间：2026-11-17；作者：lq。
async function findLicense(paths) {
  for (const path of paths) {
    try { return await readFile(path, 'utf8'); } catch { /* 功能：尝试下一个官方安装布局；时间：2026-11-17；作者：lq。 */ }
  }
  throw new Error('无法找到 Node 许可证，请使用官方 Node 安装包构建客户端');
}
const runtimeDir = dirname(process.execPath);
const nodeLicense = await findLicense([
  resolve(runtimeDir, '../LICENSE'), resolve(runtimeDir, 'LICENSE'), resolve(runtimeDir, 'LICENSE.txt'),
  resolve(runtimeDir, '../share/doc/node/LICENSE'),
]);
await writeFile(resolve(output, 'LICENSES.txt'), [nodeLicense,
  await readFile('node_modules/ws/LICENSE', 'utf8'),
  await readFile('node_modules/three/LICENSE', 'utf8'),
].join('\n\n'));
console.log(`Desktop LAN runtime ready: ${process.platform}/${process.arch}`);
