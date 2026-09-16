import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// mission-app · apps/web
//
// ★ 纪律：map-2d / media-player 是**同级仓库里的 npm 包**，这里用别名**原地引用源码**，
//   一行都不拷。改模块源码 → 本前端下次构建即刻生效。
//
// 端口 5180/5181 被 map-2d / media-player 的独立宿主占用，本应用用 5190。
const BACKEND = process.env.MISSION_APP_BACKEND ?? 'http://127.0.0.1:8099'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // 原地引用（不是 node_modules 里的副本）
      'map-2d': fileURLToPath(new URL('../../../map-2d/src/index.ts', import.meta.url)),
      'media-player': fileURLToPath(new URL('../../../media-player/src/index.ts', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5190,
    strictPort: false,
    proxy: {
      '/health': BACKEND,
      '/stats': BACKEND,
      '/runtime-config': BACKEND,
      '/tiles': BACKEND,
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 3000,
  },
})
