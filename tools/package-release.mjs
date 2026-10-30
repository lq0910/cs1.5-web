import { mkdir, cp, rm, writeFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 功能：将生产构建整理成可上传 GitHub Release 的 zip；时间：2026-10-25；作者：lq。
const root = dirname(fileURLToPath(import.meta.url));
const project = dirname(root);
const dist = join(project, 'dist');
const out = join(project, 'release');
const name = `cs15-web-${process.env.RELEASE_VERSION ?? 'snapshot'}`;
const staging = join(out, name);
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await cp(dist, staging, { recursive: true });
// 功能：移除构建缓存和系统元数据，减小面向普通用户的下载包。时间：2026-10-30；作者：lq。
await rm(join(staging, '.DS_Store'), { force: true });
await rm(join(staging, 'ui', '.DS_Store'), { force: true });
for (const file of await readdir(join(staging, 'assets'))) {
  if (file.endsWith('.map')) await rm(join(staging, 'assets', file), { force: true });
}
// 功能：公开 ZIP 明确移除本机提取的原版 CS 素材，避免误打包再分发。时间：2026-10-30；作者：lq。
await rm(join(staging, 'cstrike'), { recursive: true, force: true });
// 功能：保留项目自制 white_house 测试地图，让无素材的下载包也能直接试玩。时间：2026-10-30；作者：lq。
const bundledMap = join(staging, 'cstrike');
await mkdir(join(bundledMap, 'maps'), { recursive: true });
for (const relative of ['maps/white_house.bsp', 'white_house.wad']) {
  const source = join(dist, 'cstrike', relative);
  try { await cp(source, join(bundledMap, relative)); } catch { /* CI may regenerate it below. */ }
}
await writeFile(join(staging, 'README.txt'), 'CS 1.5 Web\n\n解压后使用任意静态 HTTP 服务器打开 index.html。\n发布包只包含项目自制 white_house 测试地图，不包含原版 CS 地图、模型、贴图或音频。\n');
await mkdir(out, { recursive: true });
const archive = join(out, `${name}.zip`);
await rm(archive, { force: true });
await new Promise((resolve, reject) => {
  const proc = spawn('zip', ['-qr', archive, name], { cwd: out, stdio: 'inherit' });
  proc.on('error', reject);
  proc.on('exit', (code) => code === 0 ? resolve() : reject(new Error('zip command failed')));
});
console.log(`Created ${archive}`);
