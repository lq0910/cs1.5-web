#!/usr/bin/env node
/**
 * 功能：把本机已有的 public/cstrike 素材打成首页可直接导入的 ZIP；时间：2026-11-05；作者：lq。
 * 说明：仅处理用户自行准备的素材，不从网络下载或补充第三方文件。
 */
import { access, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(project, 'public', 'cstrike');
const output = join(project, 'release', 'cs15-web-local-assets.zip');
const staging = join(project, '.asset-package-staging');
const password = 'cs15-web-local-assets-v1';

try {
  await access(join(source, 'maps'));
} catch {
  throw new Error('找不到 public/cstrike/maps，请先导入或提取本地 CS 素材');
}

// 功能：构造固定 cstrike/ 根目录，和浏览器导入器的路径解析保持一致；时间：2026-11-05；作者：lq。
await rm(staging, { recursive: true, force: true });
await mkdir(join(staging, 'cstrike'), { recursive: true });
await mkdir(dirname(output), { recursive: true });
await rm(output, { force: true });
await new Promise((resolve, reject) => {
  const process = spawn('ditto', ['--norsrc', source, join(staging, 'cstrike')], { stdio: 'inherit' });
  process.on('error', reject);
  process.on('exit', (code) => code === 0 ? resolve() : reject(new Error('复制素材失败')));
});

// 功能：使用 ZIP 传统加密与前端内置解锁流程匹配，避免普通解压工具直接展开素材；时间：2026-11-05；作者：lq。
await new Promise((resolve, reject) => {
  const process = spawn('zip', ['-qry', '-P', password, output, 'cstrike'], { cwd: staging, stdio: 'inherit' });
  process.on('error', reject);
  process.on('exit', (code) => code === 0 ? resolve() : reject(new Error('ZIP 打包失败')));
});
await rm(staging, { recursive: true, force: true });
console.log(`Created ${output}`);
