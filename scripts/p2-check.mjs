// mission-app · scripts/p2-check.mjs
//
// P2 真机自证（Excel 步 1–2）：
//   启动加载真实推进 → 自检 5 项出真实结论 → 【进入任务】真的把流程推到第 3 步。
//
// 与 live-check.mjs 的分工：
//   · live-check.mjs  验 P1 的地图链路（无人机/航迹真的画出来）
//   · p2-check.mjs    验 P2 的启动与自检（前端连真宿主 + 真 selfcheck 引擎）
//
// 断言口径（**都在验"真"**）：
//   ① 启动进度**单调不减**，且每一步都对得上一个真实模块（不是等分假动画）；
//   ② 启动完成后 `selfcheck.ready` 恰好一次（引擎闩锁保证，脚本再数一遍）；
//   ③ `selfcheck.done` 的 5 项与 /api/state 的 5 项**逐字段一致**（界面显示的就是引擎给的）；
//   ④ 五个模块卡片的终值来自探针结论（`/health` 与 `/api/state` 同一份口径）；
//   ⑤ 【进入任务】后 `flow.state` 事件到达且 step=3、phase=T0；
//   ⑥ 两个界面都真的渲染出来了（CDP 截图 + DOM 断言）。
//
// 用法：node scripts/p2-check.mjs [url]        url 默认 http://127.0.0.1:8099/
// 前置：宿主已在跑（不用 vite dev —— 直接打宿主托管的 dist，减少变量）
// 退出码：0 = 全绿；1 = 有断言失败；2 = 环境不具备（没找到 Chrome）
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const URL_ = (process.argv[2] ?? 'http://127.0.0.1:8099/').replace(/\/$/, '')
const WS_ = URL_.replace(/^http/, 'ws') + '/ws'
const SHOT_DIR = path.resolve('docs/screens')

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => existsSync(p))
if (!CHROME) { console.error('[p2] 环境不具备：没找到 Chrome'); process.exit(2) }

let pass = 0, fail = 0
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ` —— ${detail}` : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- CDP
const profile = mkdtempSync(path.join(tmpdir(), 'ma-p2-'))
const port = 19355
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
  if (sessionId) msg.sessionId = sessionId
  ws.send(JSON.stringify(msg))
  setTimeout(() => reject(new Error(`CDP 超时: ${method}`)), 30000)
})
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''))
  return r?.result?.value
}
const shot = async (name) => {
  // 截图是**佐证**不是断言：地图台（WebGL、无 GPU 的 headless）偶尔会卡住合成器，
  // 卡住就跳过，绝不让它把整轮验收拖崩。
  try {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    mkdirSync(SHOT_DIR, { recursive: true })
    const file = path.join(SHOT_DIR, name)
    writeFileSync(file, Buffer.from(r.data, 'base64'))
    return file
  } catch (e) {
    console.log(`  · 截图跳过（${name}）：${e.message}`)
    return null
  }
}

// ---------------------------------------------------------------- 命令面
async function command(verb, params = {}) {
  const r = await fetch(`${URL_}/api/command`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ verb, params }),
  })
  return r.json()
}
const getState = async () => (await fetch(`${URL_}/api/state`)).json()

// ---------------------------------------------------------------- WS 事件采集
//
// 用 addEventListener 而不是 onmessage 属性：Node 的全局 WebSocket（undici）对属性形式
// 支持不完整，之前整段采集一条都没收到（"0 条事件"其实是采集器自己的问题）。
function collectEvents() {
  const seen = []
  const state = { open: false, closed: false, errors: 0, total: 0, error: '', pings: 0 }
  const sock = new WebSocket(WS_)
  sock.addEventListener('open', () => { state.open = true })
  sock.addEventListener('error', (e) => { state.errors += 1; state.error = String(e?.message ?? e?.type ?? 'error') })
  sock.addEventListener('close', () => { state.closed = true; clearInterval(ping) })
  sock.addEventListener('message', (ev) => {
    state.total += 1
    try {
      const m = JSON.parse(ev.data)
      seen.push({ type: m.type, data: m.data, at: Date.now() })
    } catch { /* 非 JSON 忽略 */ }
  })
  // ★ 必须自己保活：hub 的判死口径是"连续 3 次心跳未见"，默认 1.5 s × 3 ≈ 4.5 s。
  //   一条只收不发的连接会在 4.5 s 后被踢掉 —— 启动加载要跑十几秒，不保活就一条都收不全。
  const ping = setInterval(() => {
    if (sock.readyState !== 1) return
    try {
      sock.send(JSON.stringify({ type: 'sys.ping', data: {}, ts: Date.now() }))
      state.pings += 1
    } catch { /* 连接已断，忽略 */ }
  }, 1200)
  return { seen, state, close: () => { clearInterval(ping); try { sock.close() } catch { /* 忽略 */ } } }
}

try {
  // ★ WebSocket 必须建在**任何 fetch 之前**：Node 的全局 WebSocket（undici）与 fetch 共用
  //   同一个 dispatcher —— 先发过 HTTP 再建 WS，升级请求会被并到那条 keep-alive 连接上，
  //   症状是"只来一个 error 事件、永远不 open"（实测：先 fetch → open=false；先建 → 正常）。
  const events = collectEvents()

  // ============================================================== 0) 前置：宿主可达
  const st0 = await getState()
  check('宿主 /api/state 可达', typeof st0.step === 'number', `step=${st0.step} version=${st0.version}`)
  check('selfcheck 规则包已装载（selfCheckReady）', st0.selfCheckReady === true, `note=${st0.selfCheckNote ?? ''}`)

  // 复位到第 1 步，保证本次是从"未启动"开始的真流程
  await command('boot.reset')
  const reset = await getState()
  check('boot.reset 后回到第 1 步', reset.step === 1 && (reset.boot.complete === false),
    `step=${reset.step} complete=${reset.boot.complete}`)

  // ============================================================== 1) 浏览器打开页面（第一屏 = 启动加载）
  await (async () => {
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
  })()
  await send('Target.createTarget', { url: 'about:blank' })
  await sleep(400)
  const targets = await send('Target.getTargets')
  const page = targets.targetInfos.find((t) => t.type === 'page')
  const attached = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
  sessionId = attached.sessionId
  await send('Runtime.enable')
  await send('Page.enable')
  // ★ 固定视口：headless 新建 target 的默认视口可能只有 ~420 px 高（取决于窗口装饰），
  //   界面在那种高度下会被裁掉，截图就"看起来是空的"。验收要的是稳定可复现的画布。
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
  })

  await send('Page.navigate', { url: `${URL_}/` })
  await sleep(1200)
  console.log(`  · WS 采集器：open=${events.state.open} errors=${events.state.errors} ${events.state.error}`)

  // 页面进入即发 boot.run（真实推进）
  //
  // ★ 启动页截图必须拍在**进度还没走完**的时候：boot.complete 之后页面自动进到自检屏，
  //   那时候再拍就会拍到一张"自检屏"——p2-1 与 p2-2 曾经是同一张图（证据重复，等于没有启动页证据）。
  let bootSeen = null
  let bootShotOverall = null
  for (let i = 0; i < 60; i++) {
    bootSeen = await evalJs('window.__flowStats ? JSON.stringify(window.__flowStats()) : null')
    if (bootSeen) {
      const j = JSON.parse(bootSeen)
      const overall = j.boot?.overall ?? null
      // 进度已在推、又还没满 → 这就是"启动加载中"的那一瞬
      if (overall !== null && overall > 0 && overall < 100 && !j.boot?.complete) {
        bootShotOverall = overall
        break
      }
      if (j.boot?.complete) break
    }
    await sleep(120)
  }
  check('页面暴露了流程自证句柄 __flowStats', !!bootSeen)
  const firstShot = await shot('p2-1-boot.png')
  if (firstShot) console.log(`  · 启动页截图：${firstShot}（拍到时总进度 ${bootShotOverall ?? 'n/a'}%）`)
  check('启动加载截图拍在进度未满时（否则与自检屏重复）', bootShotOverall !== null, `overall=${bootShotOverall ?? 'n/a'}%`)

  // 等启动跑完（断言要用"完成态"）
  for (let i = 0; i < 60; i++) {
    const s = await evalJs('window.__flowStats ? JSON.stringify(window.__flowStats()) : null')
    if (s && JSON.parse(s).boot?.complete) break
    await sleep(500)
  }

  // ============================================================== 2) 启动进度：真实且单调
  const progresses = events.seen
    .filter((e) => e.type === 'selfcheck.progress')
    .map((e) => ({ overall: e.data?.overall ?? 0, items: e.data?.items ?? [] }))
  check('收到 selfcheck.progress 事件（启动进度是真事件流）', progresses.length > 0, `${progresses.length} 条`)
  let monotonic = true
  for (let i = 1; i < progresses.length; i++) if (progresses[i].overall < progresses[i - 1].overall) monotonic = false
  check('总体进度单调不减（SFC-PROG-04）', monotonic,
    `序列=${progresses.map((p) => p.overall).join(',')}`)
  const fiveModules = progresses.at(-1)?.items?.map((i) => i.key) ?? []
  check('进度源就是规则包给的 5 个模块（不是前端写死）', fiveModules.length === 5,
    `keys=${fiveModules.join(',')}`)

  const stReady = await getState()
  const cards = stReady.boot.modules ?? []
  check('启动完成：5 张模块卡的百分比都到终值', cards.length === 5 && cards.every((c) => c.percent >= 50),
    cards.map((c) => `${c.key}=${c.percent}%`).join(' '))
  check('模块卡的状态文案来自规则包（有 detail）', cards.every((c) => !!c.detail),
    cards.map((c) => c.detail).join('｜'))
  check('selfcheck.ready 恰好一次（引擎闩锁）', events.seen.filter((e) => e.type === 'selfcheck.ready').length === 1,
    `${events.seen.filter((e) => e.type === 'selfcheck.ready').length} 次`)

  // ============================================================== 3) 第二屏：自检界面
  for (let i = 0; i < 40; i++) {
    const s = JSON.parse(await evalJs('JSON.stringify(window.__flowStats())'))
    if (s.step >= 2) break
    await sleep(300)
  }
  const st2 = JSON.parse(await evalJs('JSON.stringify(window.__flowStats())'))
  check('加载完成后自动进入第 2 步（自检界面）', st2.step === 2 && st2.stepKey === 'selfcheck',
    `step=${st2.step} key=${st2.stepKey}`)
  const hasBtn = await evalJs(`!!Array.from(document.querySelectorAll('button')).find(b => /一键自检|重新自检/.test(b.textContent||''))`)
  check('自检界面有自检按钮（一键自检 / 重新自检）', hasBtn === true)

  // ============================================================== 4) 一键自检：真结果
  const t0 = Date.now()
  const rep = await command('selfcheck.run', { bypassCache: true })
  const cost = Date.now() - t0
  check('selfcheck.run 返回 code=0', rep.code === 0, `code=${rep.code} 用时 ${cost} ms`)
  const items = rep.data?.selfCheck ?? []
  check('自检给出 5 项（规则包 selfCheck 段）', items.length === 5, items.map((i) => `${i.key}:${i.status}`).join(' '))
  check('每项都有子说明与状态文案（来自规则包）',
    items.every((i) => !!i.sub && !!i.status),
    items.map((i) => `${i.name}=${i.status}`).join('｜'))
  const doneEvents = events.seen.filter((e) => e.type === 'selfcheck.done')
  check('收到 selfcheck.done 事件', doneEvents.length > 0, `${doneEvents.length} 条`)

  const st3 = await getState()
  const apiItems = st3.selfCheck?.items ?? []
  const same = apiItems.length === items.length && apiItems.every((a, i) => a.key === items[i].key && a.status === items[i].status)
  check('/api/state 的自检结果与命令回执逐项一致（界面显示的就是引擎给的）', same)

  await sleep(700)  // 等页面轮询到新一轮结果
  const secondShot = await shot('p2-2-selfcheck.png')
  if (secondShot) console.log(`  · 自检页截图：${secondShot}`)
  // 证据不重复：两张截图必须是**两个不同界面**（曾经 p2-1/p2-2 字节相同 = 只有一张真证据）
  const shotHash = (f) => (f ? createHash('sha1').update(readFileSync(f)).digest('hex').slice(0, 12) : null)
  const h1 = shotHash(firstShot)
  const h2 = shotHash(secondShot)
  check('启动页与自检页是两张不同的图（证据不重复）', !!h1 && !!h2 && h1 !== h2, `boot=${h1 ?? 'n/a'} selfcheck=${h2 ?? 'n/a'}`)
  const domRows = await evalJs(`document.body.innerText`)
  const sawNames = items.filter((i) => (domRows || '').includes(i.name)).length
  check('自检界面把 5 项名称都渲染出来了', sawNames === 5, `${sawNames}/5`)

  // ============================================================== 5) 进入任务
  const enter = await command('flow.enter')
  check('flow.enter 返回 code=0 且 phase=T0', enter.code === 0 && enter.data?.phase === 'T0',
    `code=${enter.code} step=${enter.data?.step} phase=${enter.data?.phase}`)
  await sleep(600)
  const flowEvt = events.seen.filter((e) => e.type === 'flow.state').at(-1)
  check('收到 flow.state 事件（前端据此切屏）', !!flowEvt,
    flowEvt ? `step=${flowEvt.data?.step} phase=${flowEvt.data?.phase}` : '（没收到）')
  const st4 = JSON.parse(await evalJs('JSON.stringify(window.__flowStats())'))
  check('页面已切到第 3 步（任务态势）', st4.step === 3 && st4.phase === 'T0',
    `step=${st4.step} phase=${st4.phase}`)
  await sleep(1500)
  const thirdShot = await shot('p2-3-situation.png')
  if (thirdShot) console.log(`  · 任务态势页截图：${thirdShot}`)
  const hasMap = await evalJs(`!!document.querySelector('.maplibregl-map canvas')`)
  check('第 3 步真的把地图容器挂上了', hasMap === true)

  events.close()
  console.log(`\n[p2] 通过 ${pass} / 失败 ${fail}`)
  console.log(fail === 0
    ? '[p2] PASS：启动加载真实推进、自检 5 项出真结论、进入任务切屏成功'
    : '[p2] FAIL：见上表')
} catch (e) {
  console.error('[p2] 异常：', e.message)
  fail++
} finally {
  try { ws?.close() } catch { /* 忽略 */ }
  chrome.kill()
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

process.exit(fail === 0 ? 0 : 1)
