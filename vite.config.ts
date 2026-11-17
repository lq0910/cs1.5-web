import { defineConfig } from 'vite';
// 功能：LED 大屏通过同源接口获取真实 RSS 资讯。时间：2026-10-09；作者：lq。
import { techNewsPlugin } from './server/techNews.ts';

export default defineConfig({
  // 功能：开发与生产预览共用新闻聚合和缓存。时间：2026-10-09；作者：lq。
  plugins: [techNewsPlugin()],
  // Relative base so the built output can be served from any sub-path.
  base: './',
  // 功能：仅扫描游戏入口，避免 shots 下的本地验收页影响开发依赖预构建。时间：2026-10-22；作者：lq。
  optimizeDeps: {
    entries: ['index.html'],
    // 功能：Three/HLS 已提供浏览器 ESM，直接加载以避免并行开发服务或重启造成旧预构建哈希 504，阻断地图与开始按钮；时间：2026-11-17；作者：lq。
    exclude: ['three', 'hls.js'],
  },
  server: {
    // 功能：房主将前端共享给局域网队友，联机状态仍由独立房主服务判定；时间：2026-11-17；作者：lq。
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // Assets extracted from the user's local CS 1.5 install live in public/cstrike.
    fs: { strict: false },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
