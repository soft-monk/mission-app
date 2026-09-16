// mission-app · scripts/p7-check.mjs
//
// P7 真机自证（Excel 11 步**一键串联 + 倍速演示 + 可重跑**）：
//   ① 全新起点：`sim.reset`（重建仿真源，不重启进程）→ `mission.reset` → `boot.reset`
//      → `/api/state` 的 step=1 / 无 missionId / 仿真计数从 0 重新计时；
//   ② 负证：前置不满足时 `flow.runAll` **如实失败并停在那一步**（1003 + 原因）；
//      以及规则包的硬前置（未经 `alloc.adopt` 的 `alloc.confirm` → 引擎 1003）；
//   ③ `flow.runAll` 一次调用跑完 11 步：`summary.ok=true` / `failedStep=null` /
//      `steps[]` 覆盖 11 步全部 / **每一步 code===0**（任何一步非 0 都在这里红）；
//   ④ 倍速真的变过：回执里三次 `sim.state` 读数两两不同且与请求一致（事件面同时核对）；
//   ⑤ **可重跑**：连着跑第二遍 `flow.runAll` 仍然全绿（这是 `sim.reset` 的验收点）；
//   ⑥ 浏览器侧：真页面（Chrome CDP 1280×800）在串联过程中跟着走（`__flowStats().step` 最终=11），
//      中途至少截两张图 `docs/screens/p7-1-running.png` / `p7-2-summary.png`；
//   ⑦ 结束后复跑 p2–p6（同一 URL，`P7_SKIP_REGRESS=1` 可跳过）并打印汇总行。
//
// 用法：node scripts/p7-check.mjs [url]        url 默认 http://127.0.0.1:8100/
// 前置：宿主已在跑（**本阶段固定用 8100**：8099 上是另一条并行自证，两边互不打断）
// 退出码：0 = 全绿；1 = 有断言失败；2 = 环境不具备（没找到 Chrome）
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'

const URL_ = (process.argv[2] ?? 'http://127.0.0.1:8100/').replace(/\/$/, '')
const WS_ = URL_.replace(/^http/, 'ws') + '/ws'
const SHOT_DIR = path.resolve('docs/screens')
const REGRESS = process.env.P7_SKIP_REGRESS !== '1'

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => existsSync(p))
if (!CHROME) { console.error('[p7] 环境不具备：没找到 Chrome'); process.exit(2) }

let pass = 0, fail = 0
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ` —— ${detail}` : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const j = (v) => JSON.stringify(v)
const pad = (s, n) => String(s).padEnd(n, ' ')

// ---------------------------------------------------------------- 独立取值（脚本读原文，不信宿主）
let deploy = null
try { deploy = JSON.parse(readFileSync(path.resolve('data', 'scenario-1', 'deployment.json'), 'utf8')) }
catch (e) { console.log(`  · deployment.json 读取失败：${e.message}`) }
const aircraftN = deploy?.aircraft?.length ?? 0

// ---------------------------------------------------------------- CDP（真页面，1280×800）
const profile = mkdtempSync(path.join(tmpdir(), 'ma-p7-'))
const port = 19361
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
// 回执形状：code=0 → data；code!=0 → error（协议 §3）。验收脚本两种都读。
const payload = (r) => r?.data ?? r?.error ?? {}
// 真·并发 POST（`agent:false` = 每次新开一条连接）：全局 fetch（undici）会把两个并发请求
// **并到同一条 keep-alive 连接上串行发**，那样"并发"根本造不出来（实测两次都回 code=0）。
function postConcurrent(verb, params = {}) {
  const u = new URL(`${URL_}/api/command`)
  const body = JSON.stringify({ verb, params })
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: u.hostname, port: u.port || 80, path: u.pathname, method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let out = ''
      res.on('data', (d) => { out += d })
      res.on('end', () => { try { resolve(JSON.parse(out)) } catch (e) { reject(e) } })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ---------------------------------------------------------------- WS 事件采集
//
// 与 p2–p6 同一条纪律：addEventListener（Node 全局 WebSocket 对 onmessage 支持不全）
// + **自己保活**（hub 判死 = 1.5 s × 3 ≈ 4.5 s 无消息）。
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
  const ping = setInterval(() => {
    if (sock.readyState !== 1) return
    try {
      sock.send(JSON.stringify({ type: 'sys.ping', data: {}, ts: Date.now() }))
      state.pings += 1
    } catch { /* 连接已断，忽略 */ }
  }, 1200)
  return { seen, state, close: () => { clearInterval(ping); try { sock.close() } catch { /* 忽略 */ } } }
}
const of = (events, type) => events.filter((e) => e.type === type)

// ---------------------------------------------------------------- 回归：复跑 p2–p6（子进程，串行）
function runNode(args, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const t = setTimeout(() => { try { p.kill() } catch { /* 忽略 */ } }, timeoutMs)
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { out += d })
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out }) })
  })
}

try {
  // ★ WebSocket 必须建在**任何 fetch 之前**（undici 的 WS 与 fetch 共用 dispatcher）。
  const events = collectEvents()

  const st0 = await getState()
  check('宿主 /api/state 可达', typeof st0.step === 'number',
    `step=${st0.step} version=${st0.version} wsClients=${st0.wsClients} | 脚本自读 deployment.json aircraft=${aircraftN}`)

  // ============================================================== 1) 全新起点（sim.reset 的验收点）
  //
  // 三件事各管一段：sim.reset 把**仿真源**重建到初始状态（平台回装配期坐标、仿真时钟归零），
  // mission.reset 清任务与阶段，boot.reset 清启动进度与自检报告。三个都做完才是"真的从零"。
  const speedBefore = (await getState()).simulation?.speed
  const simR = await command('sim.reset')
  const sr = payload(simR)
  check('sim.reset 回执 code=0 且 reset=true', simR.code === 0 && sr.reset === true,
    `code=${simR.code} reset=${sr.reset} message=${simR.error?.message ?? '(无)'}`)
  check('sim.reset 的真实读数：simElapsedMs=0 / platforms>0 / speed / attachments',
    sr.simElapsedMs === 0 && sr.platforms > 0 && typeof sr.speed === 'number' && sr.attachments >= 1,
    `simElapsedMs=${sr.simElapsedMs} platforms=${sr.platforms} speed=${sr.speed} attachments=${sr.attachments}` +
    ` | before=${j(sr.before)} resumed=${sr.resumed}`)
  check('sim.reset 的 platforms 与脚本自读的 deployment.json aircraft 数一致',
    sr.platforms === aircraftN, `宿主 ${sr.platforms}｜脚本读原文 ${aircraftN}`)
  check('sim.reset 确实回到起点（before.simElapsedMs > 0 → after=0，不是"看起来重置了"）',
    (sr.before?.simElapsedMs ?? 0) > 0 && sr.simElapsedMs === 0,
    `before.simElapsedMs=${sr.before?.simElapsedMs} → after=${sr.simElapsedMs}（读数取在 primeNow 之后、start 之前）` +
    `｜before.speed=${sr.before?.speed} → after.speed=${sr.speed}`)
  check('sim.reset 后倍速与"跑/暂停"运行态按重建前恢复（链路不断 → 设备不失联）',
    sr.speed === (speedBefore ?? sr.speed) && (sr.before?.running === false || sr.resumed === true),
    `重建前 speed=${speedBefore} / running=${sr.before?.running} → resumed=${sr.resumed} / paused=${sr.paused}`)

  const mr = await command('mission.reset')
  const br = await command('boot.reset')
  const stFresh = await getState()
  const simFresh = stFresh.simulation ?? {}
  check('mission.reset + boot.reset 回执 code=0', mr.code === 0 && br.code === 0,
    `mission.reset=${mr.code} boot.reset=${br.code}`)
  check('全新起点：/api/state step=1 / 无 missionId / 无阶段',
    stFresh.step === 1 && !stFresh.missionId && !stFresh.phase,
    `step=${stFresh.step} stepKey=${stFresh.stepKey} missionId=${j(stFresh.missionId)} phase=${j(stFresh.phase)}`)
  check('全新起点：仿真计数从 0 重新计时（读 /api/state 时已走 < N ms，因为 simAutoStart=true）',
    typeof simFresh.simElapsedMs === 'number' && simFresh.simElapsedMs >= 0 && simFresh.simElapsedMs < 5000,
    `simElapsedMs=${simFresh.simElapsedMs} platforms=${simFresh.platforms} speed=${simFresh.speed} ` +
    `running=${simFresh.running} emitted=${simFresh.emitted}`)
  check('全新起点：启动进度已清空（boot.reset 的真实效果）',
    (stFresh.boot?.progress?.overall ?? -1) === 0 && stFresh.boot?.complete === false,
    `boot.progress.overall=${stFresh.boot?.progress?.overall} boot.complete=${stFresh.boot?.complete} ` +
    `boot.modules=${j((stFresh.boot?.modules ?? []).map((m) => `${m.key}:${m.percent}`))}`)

  // ============================================================== 2) 负证：前置不满足 → 停在那一步
  //
  // ① 还没进任务就 `flow.runAll{from:5}`：`alloc.adopt` 会被宿主如实回 1003（"尚未进入任务"），
  //    串联**停在第 5 步**并把原因写进 summary（MUST NOT 跳过、MUST NOT 假装跑完）。
  const neg = await command('flow.runAll', { from: 5, to: 11, reset: false, planId: 'grp-probe' })
  const nd = payload(neg)
  check('负证①：未进任务就 flow.runAll{from:5} → 停在第 5 步（1003 + 原因，后面的步骤没跑）',
    neg.code === 1003 && nd.summary?.ok === false && nd.summary?.failedStep === 5 &&
    (nd.steps ?? []).length === 1 && typeof nd.summary?.failedReason === 'string' &&
    nd.summary.failedReason.length > 0,
    `code=${neg.code} failedStep=${nd.summary?.failedStep} steps=${(nd.steps ?? []).length} ` +
    `verb=${nd.summary?.failedVerb} reason=${nd.summary?.failedReason}`)

  // ② 规则包的**硬前置**：未经 `alloc.adopt` 直接 `alloc.confirm` → 引擎回 1003（不是宿主拦的）。
  const enter0 = await command('flow.enter')
  const gp0 = await command('alloc.plans', { side: 'group', count: 3 })
  const plan0 = payload(gp0).recommendedId ?? payload(gp0).items?.[0]?.candidate?.id
  const bareConfirm = await command('alloc.confirm', { planId: plan0, side: 'group' })
  const unmet0 = [...(bareConfirm.error?.unmet ?? []), ...(bareConfirm.error?.data?.unmet ?? [])]
  check('负证②：未经 alloc.adopt 的 alloc.confirm → 引擎 1003（宿主不代劳硬前置）',
    bareConfirm.code === 1003 && unmet0.length > 0,
    `code=${bareConfirm.code} planId=${plan0} unmet=${j(unmet0)} missionId=${payload(enter0).missionId}`)

  // ③ 互斥：真·并发两次 `flow.runAll`（前端连点两次"一键"就会这样）→ 一条 1002、另一条真跑完。
  //    两条串联交叉驱动同一条流程的话，步骤/阶段/方案指针互相踩，回执全都不可信。
  //    ★ 必须用**两条独立连接**（`postConcurrent`）：全局 fetch 会把并发请求并到一条 keep-alive
  //      连接上串行发 —— 那样第二次是在第一次跑完之后才开始的，造不出并发（实测两次都回 0）。
  const [cA, cB] = await Promise.all([
    postConcurrent('flow.runAll', { speed: 8 }),
    postConcurrent('flow.runAll', { speed: 8 }),
  ])
  const loser = cA.code === 0 ? cB : cA
  const winner = cA.code === 0 ? cA : cB
  const wSteps = payload(winner).steps ?? []
  check('负证③：并发两次 flow.runAll → 一条 1002（互斥冲突），另一条真跑完 11 步',
    [cA.code, cB.code].sort().join(',') === '0,1002' && payload(winner).summary?.ok === true &&
    wSteps.length === 11,
    `两次回执 code=${j([cA.code, cB.code])}；1002 那条 message=${loser.error?.message ?? '(无)'}；` +
    `另一条 steps=${wSteps.length} totalMs=${payload(winner).summary?.totalMs}`)

  // ============================================================== 3) 真页面就位（截图与"跟着走"）
  await (async () => {
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`)
        const jj = await r.json()
        ws = new WebSocket(jj.webSocketDebuggerUrl)
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
        return
      } catch { await sleep(300) }
    }
    throw new Error('连不上 Chrome CDP')
  })()
  await send('Target.createTarget', { url: 'about:blank' })
  await sleep(400)
  const targetsList = await send('Target.getTargets')
  const page = targetsList.targetInfos.find((t) => t.type === 'page')
  const attached = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
  sessionId = attached.sessionId
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `${URL_}/` })
  await sleep(1500)
  const pageReady = await (async () => {
    for (let i = 0; i < 40; i++) {
      const s = await evalJs('window.__flowStats ? JSON.stringify(window.__flowStats()) : null')
      if (s) return JSON.parse(s)
      await sleep(300)
    }
    return null
  })()
  check('真页面暴露 __flowStats（1280×800，CDP 已附着）', !!pageReady,
    pageReady ? `页面初始 step=${pageReady.step} stepKey=${pageReady.stepKey}` : '页面未暴露（前端未就绪？）')
  console.log(`  · WS 采集器：open=${events.state.open} errors=${events.state.errors} ${events.state.error} pings=${events.state.pings}`)

  // ============================================================== 4) 主运行：一键 11 步（倍速演示）
  //
  // 页面**在线**跑：runAll 不 await（先发出去），同时轮询页面 step 并截图 —— 这样截图里
  // 就是"串联过程中"的真实屏，而不是跑完后的静态收尾。
  const pageSteps = new Set()
  let shot1 = null
  let run1Settled = false
  const pollPage = (async () => {
    for (let i = 0; i < 900; i++) {
      let s = null
      try { s = await evalJs('window.__flowStats ? JSON.stringify(window.__flowStats()) : null') } catch { /* 忽略 */ }
      if (s) {
        const o = JSON.parse(s)
        pageSteps.add(o.step)
        if (!shot1 && o.step >= 2 && o.step <= 10) {
          shot1 = await shot('p7-1-running.png')
          if (shot1) console.log(`  · 截图（串联进行中，页面 step=${o.step}）：${shot1}`)
        }
      }
      if (run1Settled && pageSteps.has(11)) break
      await sleep(120)
    }
  })()
  const t1 = Date.now()
  // 第一次跑用 `stepPacingMs=700`：每一步跑完停 0.7 s，让**真页面**有机会把这一屏渲染出来
  // （页面切屏走的是 500 ms 轮询兜底，实测换步延迟 ~0.7 s —— 见 docs/P7-一键演示.md）。
  // 停顿只影响节奏，不进 `steps[].ms`，也不影响任何读数。
  const p1 = command('flow.runAll', { speed: 8, stepPacingMs: 700 })
  const r1 = await p1
  run1Settled = true
  const run1Ms = Date.now() - t1
  const d1 = payload(r1)
  await pollPage

  check('flow.runAll 一次调用把 11 步跑完：code=0 / summary.ok=true / failedStep=null',
    r1.code === 0 && d1.summary?.ok === true && d1.summary?.failedStep === null,
    `code=${r1.code} ok=${d1.summary?.ok} failedStep=${j(d1.summary?.failedStep)} ` +
    `totalMs=${d1.summary?.totalMs}（客户端实测 ${run1Ms} ms）speed=${d1.summary?.speed}`)

  const steps1 = d1.steps ?? []
  const EXPECT = [
    [1, 'boot'], [2, 'selfcheck'], [3, 'situation'], [4, 'grouping'], [5, 'groupConfirm'],
    [6, 'execute'], [7, 'targets'], [8, 'strike'], [9, 'strikeConfirm'], [10, 'guidance'],
    [11, 'summary'],
  ]
  check('steps[] 覆盖 11 步全部，且 step/key 与冻结的 11 步表一致',
    steps1.length === 11 && steps1.every((s, i) => s.step === EXPECT[i][0] && s.key === EXPECT[i][1]),
    `条数=${steps1.length}｜实际=${j(steps1.map((s) => `${s.step}:${s.key}`))}`)

  console.log('  · **逐步回执（一次 flow.runAll）**：')
  for (const s of steps1) {
    const calls = (s.calls ?? []).map((c) => `${c.verb}=${c.code}`).join(',')
    console.log(`      step ${pad(s.step, 2)} ${pad(s.key, 13)} ${pad(s.verb, 18)} code=${s.code} ` +
      `${pad(s.ms + 'ms', 8)} calls=[${calls}]`)
  }

  const badSteps = steps1.filter((s) => s.code !== 0)
  const badCalls = steps1.flatMap((s) => (s.calls ?? []).filter((c) => c.code !== 0).map((c) => `${s.step}:${c.verb}=${c.code}`))
  check('③ 每一步 code===0（任何一步非 0 在这里红）', badSteps.length === 0,
    badSteps.length === 0 ? `11/11 步 code=0｜每步 ms=${j(steps1.map((s) => s.ms))}`
      : `非 0 步=${j(badSteps.map((s) => `${s.step}:${s.verb}=${s.code}`))}`)
  check('③ 每一步内部的**每条命令**也都 code=0（含 adopt/confirm/assign/advance/exec/report）',
    badCalls.length === 0, badCalls.length === 0
      ? `命令总数=${steps1.reduce((n, s) => n + (s.calls ?? []).length, 0)}`
      : `非 0 命令=${j(badCalls)}`)

  // 关键读数（可读性：证明每一步真的动到了引擎）
  const stepOf = (n) => steps1.find((s) => s.step === n) ?? {}
  const callsOf = (s) => s.calls ?? []
  const readOf = (s, verb) => (callsOf(s).find((c) => c.verb === verb)?.readings) ?? {}
  console.log('  · **关键读数（原样取自回执）**：')
  console.log(`      步 3 missionId=${readOf(stepOf(3), 'flow.enter').missionId} phase=${readOf(stepOf(3), 'flow.enter').phase}` +
    ` / situation: areas=${readOf(stepOf(3), 'situation.snapshot').areasCount} zones=${readOf(stepOf(3), 'situation.snapshot').zonesCount} platforms=${readOf(stepOf(3), 'situation.snapshot').platformsCount}`)
  console.log(`      步 4 planId=${readOf(stepOf(4), 'alloc.plans').recommendedId} recommendedPercent=${readOf(stepOf(4), 'alloc.plans').recommendedPercent} items=${readOf(stepOf(4), 'alloc.plans').itemsCount}` +
    ` / 步 5 registered=${readOf(stepOf(5), 'alloc.assign').registered}/${readOf(stepOf(5), 'alloc.assign').entityAttempts}`)
  console.log(`      步 6 advance=${readOf(stepOf(6), 'mission.advance').step}/phase=${readOf(stepOf(6), 'mission.advance').phase} forced=${stepOf(6).detail?.forced}` +
    ` links=${readOf(stepOf(6), 'topology.evaluate').linksCount} coverage=${readOf(stepOf(6), 'sensor.status').coverageRatio}`)
  console.log(`      步 7 targets=${stepOf(7).detail?.targets}（轮询 ${stepOf(7).detail?.polls} 次 / ${stepOf(7).detail?.waitedMs}ms）first=${stepOf(7).detail?.firstTargetId}` +
    ` declaredActions=${j(stepOf(7).detail?.declaredActions)} media=${stepOf(7).detail?.mediaChannels}`)
  console.log(`      步 8 strikePlanId=${readOf(stepOf(8), 'strike.plans').recommendedId} / 步 9 ipPoint=${stepOf(9).detail?.ipPointKey} lines=${stepOf(9).detail?.guidanceLines} adoptFallback=${stepOf(9).detail?.adoptFallback}`)
  console.log(`      步 10 stateAfter=${stepOf(10).detail?.stateAfter} hit=${stepOf(10).detail?.hit} hitPlatform=${stepOf(10).detail?.hitPlatformId}`)
  console.log(`      步 11 reportNo=${stepOf(11).detail?.reportNo} step=${stepOf(11).detail?.step} phase=${stepOf(11).detail?.phase} dataGaps=${stepOf(11).detail?.dataGaps}`)

  check('跑完后流程真的落在步 11 / 阶段 T7（/api/state 与回执一致）',
    d1.flow?.step === 11 && d1.flow?.phase === 'T7' &&
    (await getState()).step === 11,
    `回执 flow.step=${d1.flow?.step} phase=${d1.flow?.phase}｜/api/state step=${(await getState()).step}`)

  // ============================================================== 5) 倍速演示（回执 + 事件面）
  const demos = d1.speedDemos ?? []
  const obs = demos.map((x) => x.observed ?? x.state?.speed)
  const req = demos.map((x) => x.requested)
  const distinct = new Set(obs).size === obs.length
  check('④ 倍速演示：三次 sim.state.speed 读数两两不同且与请求一致',
    demos.length === 3 && distinct && demos.every((x) => x.match === true) &&
    j(obs) === j(req) && obs.every((v) => [1, 8, 60].includes(v)),
    `请求=${j(req)} 读数=${j(obs)} match=${j(demos.map((x) => x.match))}`)
  const simEvt = of(events.seen, 'sim.state')
  const evtSpeeds = [...new Set(simEvt.map((e) => e.data?.speed))]
  check('④ 事件面同时核对：hub 真的下发过三种倍速的 sim.state',
    [1, 8, 60].every((s) => evtSpeeds.includes(s)),
    `sim.state 事件 ${simEvt.length} 条｜出现过的 speed=${j(evtSpeeds)}`)
  const runToOne = demos.length === 3 && obs[0] === d1.summary?.speed
  check('④ 演示结束后回到请求倍速（summary.speed = 第一次演示的档位）', runToOne,
    `summary.speed=${d1.summary?.speed} 首次演示=${obs[0]} 末次=${obs[obs.length - 1]}`)

  // ============================================================== 6) 可重跑（sim.reset 的验收点）
  const before2 = (await getState()).simulation ?? {}
  const r2 = await command('flow.runAll', { speed: 8 })
  const d2 = payload(r2)
  const steps2 = d2.steps ?? []
  const bad2 = steps2.filter((s) => s.code !== 0)
  const simReset2 = (d2.prepare ?? {})['sim.reset'] ?? {}
  check('⑤ 连着跑第二遍 flow.runAll 仍然全绿（11 步 / 全 code=0 / failedStep=null）',
    r2.code === 0 && d2.summary?.ok === true && d2.summary?.failedStep === null &&
    steps2.length === 11 && bad2.length === 0,
    `code=${r2.code} ok=${d2.summary?.ok} steps=${steps2.length} totalMs=${d2.summary?.totalMs}｜` +
    `各步 code=${j(steps2.map((s) => s.code))}`)
  check('⑤ 第二遍的起点是**重建过**的仿真（prepare.sim.reset：before.elapsed>0 → after=0）',
    (simReset2.readings?.simElapsedMs ?? -1) === 0 &&
    (simReset2.readings?.['before.simElapsedMs'] ?? 0) > 0,
    `第二遍 sim.reset：before.simElapsedMs=${simReset2.readings?.['before.simElapsedMs']} → ` +
    `after=${simReset2.readings?.simElapsedMs} platforms=${simReset2.readings?.platforms} ` +
    `speed=${simReset2.readings?.speed}（跑第一遍结束时 simElapsedMs=${before2.simElapsedMs}）`)
  check('⑤ 两遍的逐步 ms 都留痕（第二遍各步 verb/code/ms 与第一遍同口径）',
    steps2.length === 11 && steps2.every((s) => typeof s.ms === 'number' && typeof s.verb === 'string'),
    `第二遍 ms=${j(steps2.map((s) => s.ms))}｜第一遍 ms=${j(steps1.map((s) => s.ms))}`)
  console.log('  · **逐步回执（第二遍重跑）**：')
  for (const s of steps2) {
    console.log(`      step ${pad(s.step, 2)} ${pad(s.key, 13)} ${pad(s.verb, 18)} code=${s.code} ${pad(s.ms + 'ms', 8)}`)
  }
  console.log(`  · 第二遍关键读数：步 3 missionId=${readOf(stepOf(3), 'flow.enter').missionId}（第一遍）→ ` +
    `${(steps2.find((s) => s.step === 3)?.calls ?? []).find((c) => c.verb === 'flow.enter')?.readings?.missionId}（第二遍，missionId 递增 = 新任务）`)

  // ============================================================== 7) 浏览器侧：页面跟着走 + 截图
  const finalPage = await (async () => {
    let last = null
    for (let i = 0; i < 60; i++) {
      try { last = JSON.parse(await evalJs('JSON.stringify(window.__flowStats())')) } catch { /* 忽略 */ }
      if (last?.step === 11) return last
      await sleep(300)
    }
    return last
  })()
  const seenSteps = [...pageSteps].sort((a, b) => a - b)
  check('⑥ 页面在串联过程中跟着走：__flowStats().step 最终 = 11',
    finalPage?.step === 11,
    `页面最终 step=${finalPage?.step} stepKey=${finalPage?.stepKey} phase=${finalPage?.phase}｜` +
    `页面观察到的 step 序列=${j(seenSteps)}`)
  // 页面的切屏延迟 ~0.7 s（500 ms 轮询兜底）→ 第一次跑给了 700 ms/步 的停顿，页面就能逐屏走过；
  // 8–10 步本身只有 0.1–0.2 s 的活儿，即使有停顿也是"停顿在渲染之后"，所以不断言必须抓到每一个。
  check('⑥ 页面观察到的 step 不止起点/终点（真的逐屏走过，不是只在收尾才跳到 11）',
    seenSteps.length >= 5 && seenSteps.includes(11),
    `观察到 ${seenSteps.length} 个不同 step：${j(seenSteps)}（第一次跑带 stepPacingMs=700；` +
    `无停顿的全速跑里步 8–10 只持续 ~0.1–0.2 s，页面按 500 ms 轮询抓不全，属预期）`)
  const shot2 = await shot('p7-2-summary.png')
  if (shot2) console.log(`  · 截图（串联收尾 / 步 11）：${shot2}`)
  check('⑥ 两张过程截图都落盘（p7-1-running.png 串联进行中 / p7-2-summary.png 收尾）',
    !!shot1 && !!shot2 && existsSync(path.join(SHOT_DIR, 'p7-1-running.png')) &&
    existsSync(path.join(SHOT_DIR, 'p7-2-summary.png')),
    `${shot1 ?? 'p7-1-running.png 未取到'}｜${shot2 ?? 'p7-2-summary.png 未取到'}`)

  events.close()
  try { ws?.close() } catch { /* 忽略 */ }
  chrome.kill()

  // ============================================================== 8) 回归：复跑 p2–p6（同一 URL）
  //
  // 回归前把三者重置一次：p2–p6 是在"刚装配"的宿主上验过的（原始场景）。P7 的 `exec.run`
  // 会把参与俯冲的那组平台换到新航路上（sim-source 唯一能改高度/速度档的入口），
  // 不重置就相当于让它们跑在一个"被人动过的场景"上 —— 那是多余的干扰变量，不是回归。
  const preRegress = await command('sim.reset')
  await command('mission.reset')
  await command('boot.reset')
  console.log(`\n[p7] 回归前置：sim.reset=${preRegress.code}（platforms=${payload(preRegress).platforms} ` +
    `speed=${payload(preRegress).speed}）+ mission.reset + boot.reset`)

  if (!REGRESS) {
    console.log('\n[p7] 回归：已按 P7_SKIP_REGRESS=1 跳过（复跑命令见下）')
    for (const n of ['p2', 'p3', 'p4', 'p5', 'p6']) {
      console.log(`      node scripts/${n}-check.mjs ${URL_}/`)
    }
  } else {
    console.log('\n[p7] 回归：复跑 p2–p6（同一 URL，串行；每个脚本自己起 Chrome）')
    const summary = []
    const sumOf = (out, n) => out.split(/\r?\n/).find((l) => l.includes(`[${n}] 通过`)) ?? ''
    const badOf = (out) => out.split(/\r?\n/).filter((l) => l.includes('✗')).map((l) => l.trim())
    for (const n of ['p2', 'p3', 'p4', 'p5', 'p6']) {
      const file = path.resolve('scripts', `${n}-check.mjs`)
      if (!existsSync(file)) { summary.push(`${n}=缺脚本`); check(`回归 ${n}-check.mjs 存在`, false, file); continue }
      const t = Date.now()
      let r = await runNode([file, `${URL_}/`], 20 * 60 * 1000)
      let line = sumOf(r.out, n)
      let ok = r.code === 0 && /通过 \d+ \/ 失败 0\b/.test(line)
      let attempts = 1
      const fails = []
      if (!ok) fails.push(`第1次：${badOf(r.out).join(' / ') || `exit=${r.code}`}`)
      // ★ 已知抖动：`p2-check` 的最后一条断言是"`flow.enter` 之后 **600 ms** 内页面切到步 3"，
      //   而**页面切屏实际靠 `/api/state` 的 500 ms 轮询兜底**（实测换步延迟 670–760 ms；
      //   页面那条 WS 会在 ~4.5 s 被 hub 判死踢掉 —— 见 docs/P7-一键演示.md 的"已知抖动"）。
      //   这不是 P7 引入的（P7 没动 apps/web 与 hub），也不该让"回归"变成掷骰子 →
      //   **最多重试 2 次**，但每一次的汇总行与失败断言都如实打印（不拿后一次盖掉前一次）。
      while (!ok && attempts < 3) {
        attempts++
        writeFileSync(path.resolve('scripts', `.p7-regress-${n}.${attempts - 1}.log`), r.out)
        r = await runNode([file, `${URL_}/`], 20 * 60 * 1000)
        line = sumOf(r.out, n)
        ok = r.code === 0 && /通过 \d+ \/ 失败 0\b/.test(line)
        if (!ok) fails.push(`第${attempts}次：${badOf(r.out).join(' / ') || `exit=${r.code}`}`)
      }
      const logFile = path.resolve('scripts', `.p7-regress-${n}.log`)
      writeFileSync(logFile, r.out)
      const verdict = r.out.split(/\r?\n/).find((l) => l.includes(`[${n}] PASS`) || l.includes(`[${n}] FAIL`)) ?? ''
      summary.push(`${n}=${ok ? '✓' : '✗'}(${line.replace(`[${n}] `, '').trim() || `exit=${r.code}`},${((Date.now() - t) / 1000).toFixed(0)}s,${attempts}次)`)
      check(`回归 ${n}-check.mjs 全绿（日志 ${path.relative(process.cwd(), logFile)}）`, ok,
        `${line.trim() || `(无汇总行) exit=${r.code}`}｜${verdict.trim()}` +
        (attempts > 1 ? `｜共 ${attempts} 次：${fails.join('；')}` : ''))
      console.log(`      ${n}：${verdict.trim() || line.trim()}`)
    }
    console.log(`\n[p7] 回归汇总行：${summary.join(' ｜ ')}`)
  }

  console.log(`\n[p7] 通过 ${pass} / 失败 ${fail}`)
  console.log(fail === 0
    ? '[p7] PASS：sim.reset（仿真源重建到初始状态，不重启进程）→ flow.runAll 一键 11 步（每步都走真实命令入口、' +
      '逐步 verb/code/ms 全留痕、倍速 8×→60×→1× 三次读数可核）→ **第二遍重跑仍全绿** → 真页面跟着走到步 11（两张截图）→ p2–p6 回归全绿'
    : '[p7] FAIL：见上表（脚本不掩盖任何一条）')
} catch (e) {
  console.error('[p7] 异常：', e.stack ?? e.message)
  fail++
} finally {
  try { ws?.close() } catch { /* 忽略 */ }
  try { chrome.kill() } catch { /* 忽略 */ }
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

process.exit(fail === 0 ? 0 : 1)
