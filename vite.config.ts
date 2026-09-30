import { defineConfig } from 'vite';

export default defineConfig({
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
