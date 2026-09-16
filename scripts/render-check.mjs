// mission-app · scripts/render-check.mjs
//
// 可选的真机自证：用无头 Chrome 打开页面，确认**地图容器真的挂上了**（不是只返回了 HTML）。
//
// 为什么值得单独一个脚本：acceptance.ps1 能证明"index.html 与 /assets/ 取得到"，
// 但取得到 ≠ 渲染出来了。这里补上"渲染出来了"这半句。
//
// 用法（需要本机有 Chrome）：
//   node scripts/render-check.mjs [url] [--keep]
// 退出码：0 = 渲染成功；1 = 失败；2 = 环境不具备（没有 Chrome）
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const url = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : 'http://127.0.0.1:8099/'
const keep = process.argv.includes('--keep')

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => existsSync(p))

if (!CHROME) {
  console.error('[render-check] 没找到 Chrome —— 这一步是可选自证，跳过。')
  process.exit(2)
}

const profile = mkdtempSync(path.join(tmpdir(), 'ma-render-'))
const port = 9333 + (process.pid % 200)

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${port}`,
  '--window-size=1280,800',
  'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`)
      const j = await r.json()
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl
    } catch { /* 还没起来 */ }
    await sleep(200)
  }
  throw new Error('Chrome 调试端口没起来')
}

function connect(u) {
  const ws = new WebSocket(u)
  let id = 0
  const pending = new Map()
  const events = []
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    } else if (msg.method) {
      events.push(msg)
    }
  })
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const mid = ++id
    pending.set(mid, { resolve, reject })
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  return { ws, ready, send, events }
}

let exitCode = 1
try {
  const browser = connect(await wsUrl())
  await browser.ready

  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })

  const consoleErrors = []
  browser.ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
    }
  })

  await browser.send('Page.enable', {}, sessionId)
  await browser.send('Runtime.enable', {}, sessionId)
  await browser.send('Page.navigate', { url }, sessionId)

  // 等地图容器挂上（map-2d 用 maplibre，容器类名是 maplibregl-map）
  let state = null
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    const r = await browser.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        ready: document.readyState,
        hasRoot: !!document.querySelector('#root'),
        canvases: document.querySelectorAll('canvas').length,
        mapContainers: document.querySelectorAll('.maplibregl-map').length,
        bodyChildren: document.body.children.length
      })`,
      returnByValue: true,
    }, sessionId)
    state = JSON.parse(r.result.value)
    if (state.mapContainers > 0 && state.canvases > 0) break
  }

  const ok = state && state.mapContainers > 0 && state.canvases > 0
  console.log(`[render-check] url=${url}`)
  console.log(`[render-check] DOM: ${JSON.stringify(state)}`)
  if (consoleErrors.length) {
    console.log(`[render-check] 页面 console.error ${consoleErrors.length} 条（前 5 条）：`)
    for (const e of consoleErrors.slice(0, 5)) console.log(`    ${e}`)
  }
  console.log(ok
    ? '[render-check] PASS：地图容器与 canvas 都已挂上 —— 页面真的出图了'
    : '[render-check] FAIL：没等到地图容器/canvas')
  exitCode = ok ? 0 : 1
} catch (e) {
  console.error('[render-check] 失败：', e?.message ?? e)
  exitCode = 1
} finally {
  try { chrome.kill() } catch { /* ignore */ }
  if (!keep) { try { rmSync(profile, { recursive: true, force: true }) } catch { /* ignore */ } }
}

process.exit(exitCode)
