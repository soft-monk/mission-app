import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

// mission-app · apps/web
//
// ★ 纪律：map-2d / media-player / realtime-hub 都是**同级仓库里的包**，这里用别名
//   **原地引用**，一行都不拷。改模块源码 → 本前端下次构建即刻生效。
//
// 端口 5180/5181 被 map-2d / media-player 的独立宿主占用，本应用用 5190。
const BACKEND = process.env.MISSION_APP_BACKEND ?? 'http://127.0.0.1:8099'

/** 场景数据目录（`mission-app/data/`）——只读，且**不改后端** */
const DATA_DIR = fileURLToPath(new URL('../../data', import.meta.url))

const MIME: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
}

/**
 * 开发期把 `/data/*` 直接映射到仓库里的 `data/`（只读）。
 *
 * 为什么需要它：宿主的 `/` 只托管 `apps/web/dist`，**不托管 `data/`**；而页面要支持
 * `?style=<url>` 覆盖样式配置。有了这条映射，开发时可以写
 *   http://127.0.0.1:5190/?style=/data/scenario-1/map-style.json
 * 直接读**任务下发的那份 JSON 原件**，不必手工拷贝、也不必给后端加路由（本轮明确不改后端）。
 *
 * 只读、只认白名单后缀、拒绝 `..`；生产构建不含本插件（`apply: 'serve'`）。
 */
function localScenarioData(): Plugin {
  return {
    name: 'mission-app-local-data',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0]
        if (!url.startsWith('/data/')) return next()
        const rel = decodeURIComponent(url.slice('/data/'.length))
        if (!rel || rel.includes('..')) return next()
        const ext = path.extname(rel).toLowerCase()
        if (!MIME[ext]) return next()
        const file = path.join(DATA_DIR, rel)
        fs.stat(file, (err, st) => {
          if (err || !st.isFile()) return next()
          res.setHeader('Content-Type', MIME[ext])
          res.setHeader('Content-Length', String(st.size))
          res.setHeader('Cache-Control', 'no-cache')
          fs.createReadStream(file).pipe(res)
        })
      })
    },
  }
}

/**
 * 去掉源码 import 里的显式 `.ts` / `.tsx` 扩展名，再交给 Vite 解析。
 *
 * 为什么需要它：`media-player` 的源码内部 import 带显式扩展名（`./react/MediaPlayer.tsx`），
 * 那是为了让 `node tests/unit-test.mjs` 能**直接跑 TS 源码**（Node 的 ESM 解析要求显式扩展名）。
 * 打包器默认不带 tsconfig 的 `allowImportingTsExtensions` 语义，所以它自己的
 * `media-player/vite.config.ts` 里也挂着**同一个插件**；本应用用别名原地引用它的 `src`，
 * 于情于理都得有这一层（否则构建报 `Could not resolve "./react/MediaPlayer.ts"`）。
 *
 * 只对"带显式扩展名"的 specifier 生效：本应用自己的相对 import 不带扩展名，不受影响。
 */
function stripTsExtension(): Plugin {
  return {
    name: 'mission-app-strip-ts-extension',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!/\.tsx?$/.test(source)) return null
      const stripped = source.replace(/\.tsx?$/, '')
      return this.resolve(stripped, importer, { ...options, skipSelf: true })
    },
  }
}

export default defineConfig({
  plugins: [stripTsExtension(), react(), localScenarioData()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // 原地引用（不是 node_modules 里的副本）
      'map-2d': fileURLToPath(new URL('../../../map-2d/src/index.ts', import.meta.url)),
      'media-player': fileURLToPath(new URL('../../../media-player/src/index.ts', import.meta.url)),
      // realtime-hub 的**浏览器侧客户端**（零运行时依赖）。走它的构建产物：
      // 与 Node 侧验收脚本（mission-app/scripts/ws-client.mjs 的裸 WebSocket）用的是同一份协议实现，
      // 但这里是"带重连/心跳/未知事件落点"的那一份，正是页面上要的。
      'ws-client': fileURLToPath(new URL('../../../realtime-hub/client/dist/index.js', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5190,
    strictPort: false,
    // 编辑器/工具做"原子写"时会先在源码目录建一个临时目录再改名；Windows 上这个中间态
    // 目录经常已经被删掉 → chokidar 去 watch 时 EBUSY，**直接把 dev server 打挂**。
    // 这些中间态目录与构建产物都不需要监听。
    watch: {
      ignored: ['**/.*.tmpdir/**', '**/*.tmpdir/**', '**/dist/**'],
    },
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
