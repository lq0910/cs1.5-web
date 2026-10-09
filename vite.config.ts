import { defineConfig } from 'vite';
// 功能：LED 大屏通过同源接口获取真实 RSS 资讯。时间：2026-10-09；作者：lq。
import { techNewsPlugin } from './server/techNews.ts';

export default defineConfig({
  // 功能：开发与生产预览共用新闻聚合和缓存。时间：2026-10-09；作者：lq。
  plugins: [techNewsPlugin()],
  // Relative base so the built output can be served from any sub-path.
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    // Assets extracted from the user's local CS 1.5 install live in public/cstrike.
    fs: { strict: false },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
