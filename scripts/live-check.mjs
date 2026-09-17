// mission-app · scripts/live-check.mjs
//
// 端到端真机自证：**前端连真后端**（不是脚本自己造的 WS 服务端），验证
//   「本地配置 → sim-source → UDP → device-ingest → hub → WS → 前端 → map-2d 上屏」
// 这条链真的通了，且**无人机与航迹真的画出来了**。
//
// 与 render-check-map.mjs 的分工：
//   · render-check-map.mjs  —— 验**前端本身**（自带 WS 服务端，注入受控数据）
//   · live-check.mjs（本脚本）—— 验**真链路**（后端必须已在跑）
//
// 用法：
//   node scripts/live-check.mjs [url]
//   url 默认 http://127.0.0.1:5190/（apps/web 的 vite dev server）
// 前置：① 宿主在跑（127.0.0.1:8099）；② apps/web 的 dev server 在跑
// 注：脚本会自带 `?stage=map`（直接进地图台，跳过启动/自检两屏）——那是页面给验收留的后门，
//     否则 P2 之后页面默认停在"启动加载"屏，地图根本不会挂载。
// 退出码：0 = 全绿；1 = 有断言失败；2 = 环境不具备（没找到 Chrome）
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const URL_ = process.argv[2] ?? 'http://127.0.0.1:5190/'
const KEEP = process.argv.includes('--keep')

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => existsSync(p))
if (!CHROME) { console.error('[live-check] 环境不具备：没找到 Chrome'); process.exit(2) }

let pass = 0, fail = 0
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ` —— ${detail}` : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const profile = mkdtempSync(path.join(tmpdir(), 'ma-live-'))
const port = 19333
const chrome = spawn(CHROME, [
  '--headless=new', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,800',
  'about:blank',
], { stdio: 'ignore' })

let ws = null
let sessionId = null
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = Math.floor(Math.random() * 1e9)
  const onMsg = (ev) => {
    let m; try { m = JSON.parse(ev.data) } catch { return }
    if (m.id === id) { ws.removeEventListener('message', onMsg); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result) }
  }
  ws.addEventListener('message', onMsg)
  const msg = { id, method, params }
  // flatten 模式下，页面级命令 MUST 带上 sessionId（否则报 "… wasn't found"）
  if (sessionId) msg.sessionId = sessionId
  ws.send(JSON.stringify(msg))
  setTimeout(() => reject(new Error(`CDP 超时: ${method}`)), 20000)
})

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`)
      const j = await r.json()
      ws = new WebSocket(j.webSocketDebuggerUrl)
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
      return
    } catch { await sleep(300) }
  }
  throw new Error('连不上 Chrome CDP')
}

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return r?.result?.value
}

try {
  // ★ P4 起 `config.json` 的 simAutoStart=false：**"起飞"发生在步 6（任务执行）**，
  //   打开页面不再自动有遥测。本脚本只验"真链路能从后端流到前端"，所以先显式起飞一次
  //   （否则 uavCount 恒为 0，页面上一架无人机都没有）。
  //   注：url 默认是 vite dev server（5190），它只代理 /health /stats /runtime-config /tiles，
  //   所以命令面要打到后端（MISSION_APP_BACKEND，缺省 8099）。
  const backend = process.env.MISSION_APP_BACKEND ?? 'http://127.0.0.1:8099'
  for (const base of [...new Set([URL_, backend])]) {
    try {
      const r = await fetch(`${base}/api/command`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verb: 'sim.start', params: {} }),
      })
      if (r.ok && (await r.json())?.code === 0) break
    } catch { /* 换下一个落点 */ }
  }

  await connect()
  await send('Target.createTarget', { url: 'about:blank' })
  await sleep(400)
  const targets = await send('Target.getTargets')
  const page = targets.targetInfos.find((t) => t.type === 'page')
  const attached = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
  sessionId = attached.sessionId
  await send('Page.bringToFront')  // ★ 后台 tab 的 rAF 被节流 → MapLibre 样式装载会卡死（实测）
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Page.navigate', { url: URL_ + (URL_.includes('?') ? '&' : '?') + 'stage=map' })
  await sleep(1500)

  // 等页面把 __maStats 挂上，并等无人机累积
  let stats = null
  for (let i = 0; i < 40; i++) {
    stats = await evalJs('window.__maStats ? JSON.stringify(window.__maStats()) : null')
    if (stats) { const j = JSON.parse(stats); if (j.uavCount > 0) break }
    await sleep(500)
  }

  if (!stats) { check('页面暴露了可查句柄 __maStats', false); throw new Error('拿不到 __maStats') }
  const j = JSON.parse(stats)

  console.log(`\n[live-check] url=${URL_}`)
  check('页面挂上了地图容器', (await evalJs('!!document.querySelector(".maplibregl-map canvas")')) === true)
  check('实时通道已连接真后端', j.link?.state === 'open', `state=${j.link?.state} url=${j.link?.url ?? ''}`)
  check('收到了无人机遥测', j.uavCount > 0, `uavCount=${j.uavCount}`)
  check('无人机真的画在图上（MapDraw 里有 drone 图元）', j.drones > 0, `drones=${j.drones} 与 uavCount 一致=${j.drones === j.uavCount}`)
  check('航迹真的画在图上', j.tracksOnMap > 0, `tracksOnMap=${j.tracksOnMap} 各条点数=${(j.tracks || []).map((t) => t.points).join(',')}`)
  check('静态态势区域已上屏', j.areas > 0, `areas=${j.areas}`)
  check('无被拒事件、无未知事件类型', j.rejected === 0 && (j.unknownEventTypes?.length ?? 0) === 0,
    `rejected=${j.rejected} unknown=${JSON.stringify(j.unknownEventTypes ?? [])}`)

  // type 必须是机型（不是 "uav" 这种笼统值）—— 这是 P1 的关键断言
  const types = [...new Set((j.updates || []).map((u) => u.type))]
  const valid = ['optical', 'radar', 'electronic', 'comm']
  check('event.type 是机型（optical/radar/electronic/comm）', types.length > 0 && types.every((t) => valid.includes(t)),
    `实测 types=${JSON.stringify(types)}`)
  const groups = [...new Set((j.updates || []).map((u) => u.groupId))].filter(Boolean)
  check('groupId 已带上（编队配色可用）', groups.length > 0, `groups=${JSON.stringify(groups)}`)

  // 再等一轮，证明是**增量**而非一帧快照
  const before = j.uavCount
  const updBefore = (j.updates || []).map((u) => u.updates).reduce((a, b) => a + b, 0)
  await sleep(3000)
  const j2 = JSON.parse(await evalJs('JSON.stringify(window.__maStats())'))
  const updAfter = (j2.updates || []).map((u) => u.updates).reduce((a, b) => a + b, 0)
  check('数据在持续更新（updates 总数增长）', updAfter > updBefore, `${updBefore} -> ${updAfter}`)
  const pts2 = (j2.tracks || []).map((t) => t.points).reduce((a, b) => a + b, 0)
  const pts1 = (j.tracks || []).map((t) => t.points).reduce((a, b) => a + b, 0)
  check('航迹在增长（不是停在第一帧）', pts2 >= pts1, `点数 ${pts1} -> ${pts2}`)

  console.log(`\n[live-check] 通过 ${pass} / 失败 ${fail}`)
  console.log(fail === 0 ? '[live-check] PASS：真链路端到端通了，无人机与航迹已上屏' : '[live-check] FAIL：见上表')
} catch (e) {
  console.error('[live-check] 异常：', e.message)
  fail++
} finally {
  try { ws?.close() } catch {}
  chrome.kill()
  if (!KEEP) { try { rmSync(profile, { recursive: true, force: true }) } catch {} }
}

process.exit(fail === 0 ? 0 : 1)
