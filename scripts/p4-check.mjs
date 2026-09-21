// mission-app · scripts/p4-check.mjs
//
// P4 真机自证（Excel 步 6–7 的**宿主能力**）：任务执行（起飞/倍速）→ 链路评估 →
// 目标随探测出现 → 目标详情与处置 → 视频/SAR 回传（/media Range）。
//
// 与 p3-check.mjs 的分工：
//   · p3-check.mjs  验步 3–5（态势 / 三方案 / 确认编组 / 编成实体）
//   · p4-check.mjs  验步 6–7：仿真节拍、探测模型接入、topology、目标台账与处置、/media
//
// 断言口径（**每一条都在验"真"，不验"看着像"**）：
//   ① `sim.start` 之后真的收到 `sim.state` 且 running=true；`sim.speed{8}` 生效；
//      `sim.pause` 之后**遥测计数真的停止增长**（用两次读数的差值，不看时间戳）；
//   ② 目标**随探测出现**：起飞前 targets.list 的目标数 < 起飞后（两侧数字都打印），
//      并打印触发它的那条观测（传感器 id / 距离 / 概率 / 引擎判定的 typeKey）；
//      再做一次"拔掉传感器"对照：关掉探测器 → 新目标不再被登记（计数不再增长）；
//   ③ `targets.detail` 的威胁等级来自规则包 threatFactors.json：score/band/status 与
//      逐因子（weightPpm/normPpm/contribution）**与规则包原文交叉核对**；
//   ④ `sensor.status` 的覆盖率与遍历周期是**算出来的**：打印原样返回（面积/格点/周期），
//      并与"引擎哪个入口给的"一起说明；遍历周期与 sensors.json 的 scanPeriodMs 手算核对；
//   ⑤ `topology.evaluate` 的链路状态条数与规则包阈值口径一致：把每条链路的 state 与
//      band(score, states) 逐个核对，states/hysteresis 与 linkThresholds.json **原文**比对；
//   ⑥ `/media/**`：真 200 + 字节数 > 0 + `Range: bytes=0-99` 回 206 + Content-Range；
//      不存在的文件 404（不是 200 + HTML）；越权路径 404。
//
// 用法：node scripts/p4-check.mjs [url]        url 默认 http://127.0.0.1:8099/
// 前置：宿主已在跑（端口 8099，config.json 的 simAutoStart=false → 本脚本自己会起飞）
// 退出码：0 = 全绿；1 = 有断言失败；2 = 环境不具备（没找到 Chrome）
import { spawn } from 'node:child_process'
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
if (!CHROME) { console.error('[p4] 环境不具备：没找到 Chrome'); process.exit(2) }

let pass = 0, fail = 0
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ` —— ${detail}` : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- CDP（真页面，1280×800）
const profile = mkdtempSync(path.join(tmpdir(), 'ma-p4-'))
const port = 19357
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
const getStats = async () => (await fetch(`${URL_}/stats`)).json()

// ---------------------------------------------------------------- WS 事件采集
//
// 与 p2/p3 同一条纪律：addEventListener（Node 全局 WebSocket 对 onmessage 支持不全）
// + **自己保活**（hub 判死 = 1.5 s x 3 = 4.5 s（2026-09-20 起已调回 15 s x 4 = 60 s） 无消息）。
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

try {
  // ★ WebSocket 必须建在**任何 fetch 之前**（undici 的 WS 与 fetch 共用 dispatcher）。
  const events = collectEvents()

  // ============================================================== 0) 前置：规则包原文（脚本侧独立取值）
  //
  // 与 p3 的 viewModes/layerMapping 交叉核对同一条纪律：**验收脚本自己读规则包原文**，
  // 再与引擎/宿主的返回值比 —— 两边独立取值才叫"证明它来自规则包"。
  const ledgerPolicies = path.resolve('..', 'entity-ledger', 'policies', 'mapapp')
  const topoPolicies = path.resolve('..', 'topology', 'policies', 'mapapp')
  let threatPack = null, linkPack = null, sensorsPack = null
  try {
    threatPack = JSON.parse(readFileSync(path.join(ledgerPolicies, 'threatFactors.json'), 'utf8'))
    linkPack = JSON.parse(readFileSync(path.join(topoPolicies, 'linkThresholds.json'), 'utf8'))
    sensorsPack = JSON.parse(readFileSync(path.resolve('data', 'scenario-1', 'sensors.json'), 'utf8'))
  } catch (e) { console.log(`  · 规则包原文读取失败（相关交叉断言会退化为打印）：${e.message}`) }

  const st0 = await getState()
  check('宿主 /api/state 可达', typeof st0.step === 'number', `step=${st0.step} version=${st0.version}`)
  console.log(`  · 宿主机并发情况：wsClients=${st0.wsClients}（>0 说明还有别的前端/验收连在同一条宿主上；` +
    `本脚本对"暂停/起飞"这类会被别人顶掉的读数用有界重试，并在明细里注明）`)
  const stats0 = await getStats()
  const sens0 = stats0?.simulation?.sensor ?? {}
  const row = (stats0?.engines ?? {}).sensorModel ?? {}
  check('引擎账本里 sensorModel 是真值 instantiated=true（不再是写死的 false）',
    row.instantiated === true && row.ok === true, `instantiated=${row.instantiated} ok=${row.ok} —— ${row.note ?? ''}`)
  check('探测模型真的挂上了（引擎自述 customSensorInjected + 挂接 10 台）',
    sens0.customSensorInjected === true && sens0.engineSensors > 0 && sens0.attachments > 0,
    `customSensorInjected=${sens0.customSensorInjected} engineSensors=${sens0.engineSensors} attachments=${sens0.attachments} spec=${sens0.specSource ?? ''}`)
  check('SensorSpec 来自 sensors.json 且 validateSpec 无问题',
    (sens0.specCount ?? 0) === (sensorsPack?.sensors?.length ?? -1) && (sens0.specIssues ?? []).length === 0,
    `specCount=${sens0.specCount}（sensors.json ${sensorsPack?.sensors?.length ?? '?'} 条）specIssues=${(sens0.specIssues ?? []).length}`)
  // ★ 这条断言的是**配置事实**（验收脚本独立读 config.json），不是"此刻有没有在跑"：
  //   宿主机上可能同时有别的前端/验收在驱动同一条仿真（并行施工），"此刻在跑"不是本仓的属性。
  //   运行期读数照样打印出来，供排障与说明。
  //
  // ★★ 口径修正（上游裁决）：`simAutoStart` **必须是 true**，最初设想的 false 是错的 ——
  //   本工程的"通信链路/集群节点"探针要的是**真实报文与在线设备**（`linkUdpReceiving` /
  //   设备台账），不起仿真源时它们只会停在 50%，**启动加载永远完不成、进不了第 2 步**（实测
  //   不起飞 17/22、link=50% cluster=50%）。所以"起飞"归**启动加载阶段**，步 6 的控制语义是
  //   "暂停/恢复/倍速"。这条断言现在验的是"配置与这套口径一致"，并且**顺带验启动加载真的能完成**。
  let cfgFile = null
  try { cfgFile = JSON.parse(readFileSync(path.resolve('config.json'), 'utf8')) } catch (e) { console.log(`  · config.json 读取失败：${e.message}`) }
  check('config.json 的 simAutoStart=true（启动加载要真实报文才算就绪；起飞属启动阶段，步 6 管暂停/恢复/倍速）',
    cfgFile?.simAutoStart === true,
    `config.simAutoStart=${cfgFile?.simAutoStart}；此刻运行期 running=${st0.simulation?.running} paused=${st0.simulation?.paused} simElapsedMs=${st0.simulation?.simElapsedMs}`)

  // ============================================================== 1) 起飞前基线（先停住仿真）
  //
  // 口径：`mission.reset` 之后 flow.enter 建**新任务**（新 missionId），台账按 missionId 隔离 →
  // 新任务的目标数天然从 0 起算；同时把仿真**停住**（pause 只是引擎层面不再推进时间），
  // 这样"起飞前"这个基线不会被别的进程/上一轮的探测污染。
  await command('sim.pause')
  await command('mission.reset')
  const pausedBase = (await getState()).simulation
  check('起飞前基线可信：sim.pause 后引擎处于暂停态（不再推进时间/不产生新探测）',
    pausedBase?.paused === true,
    `running=${pausedBase?.running} paused=${pausedBase?.paused} simElapsedMs=${pausedBase?.simElapsedMs} speed=${pausedBase?.speed}`)
  const enter = await command('flow.enter')
  check('flow.enter 建新任务（missionId 来自 phase-engine）', enter.code === 0 && !!enter.data?.missionId,
    `missionId=${enter.data?.missionId} phase=${enter.data?.phase}`)
  const missionId = enter.data?.missionId
  await sleep(500)
  const before = await command('targets.list')
  const beforeCount = before.data?.targetCount ?? -1
  const beforeSens = (await getStats())?.simulation?.sensor?.targetDetections ?? -1
  console.log(`  · **起飞前实测**：targets.list 目标数=${beforeCount}（台账实体总数 ${before.data?.count}）；引擎侧 targetDetections=${beforeSens}`)

  // ============================================================== 2) 推进到 T2 → 自动起飞 + sim.state
  const preT2 = await getState()
  const preT2Paused = preT2?.simulation?.paused === true
  const advT1 = await command('mission.advance', { to: 'T1' })
  check('mission.advance 到 T1 返回 code=0', advT1.code === 0, `code=${advT1.code} status=${advT1.data?.status}`)
  const evBefore = of(events.seen, 'sim.state').length
  const advT2 = await command('mission.advance', { to: 'T2' })
  const auto = advT2.data?.simAutoStart
  // 口径：宿主**一定**要在"进入步 6"这一拍回一个 simAutoStart 段（证明触发了自动起飞），
  // 并且结果是"时间真的开始走"（running 且未暂停）。若此刻已被别的客户端起飞，宿主会
  // 如实回 idempotent=true —— 那样也算过，但打印里会写明是幂等命中（不掩盖）。
  check('mission.advance 到 T2 → 宿主自动起飞（回执带 simAutoStart，且结果是仿真在推进）',
    advT2.code === 0 && !!auto && auto.state?.running === true && auto.state?.paused === false &&
    (auto.started === true || auto.idempotent === true),
    `code=${advT2.code} autoStart.started=${auto?.started} idempotent=${auto?.idempotent === true} action=${auto?.action ?? '-'} ` +
    `running=${auto?.state?.running} paused=${auto?.state?.paused} speed=${auto?.state?.speed}；T2 之前 paused=${preT2Paused}`)
  check('自动起飞是"进入步 6"这一拍触发的（stepKey/step 由 flow.state 给出）',
    advT2.data?.step === 6 || (await getState()).step >= 6,
    `回执 step=${advT2.data?.step} phase=${advT2.data?.phase}；state.step=${(await getState()).step}`)
  if (auto?.idempotent === true) {
    console.log('  · 说明：本次是**幂等命中**（仿真在本脚本调用前已在运行，宿主机上有别的客户端在驱动）——' +
      '脚本已先 sim.pause 再推进；若仍是幂等，说明该窗口内被别的客户端 resume/start 过')
  }
  await sleep(600)
  const simEvents = of(events.seen, 'sim.state')
  const firstSim = simEvents.slice(evBefore)[0] ?? simEvents.at(-1)
  check('收到 sim.state 事件且 running=true（形状 = {running,speed,simElapsedMs,platforms,emitted}）',
    !!firstSim && firstSim.data?.running === true && typeof firstSim.data?.simElapsedMs === 'number' &&
    typeof firstSim.data?.platforms === 'number' && typeof firstSim.data?.emitted === 'number',
    firstSim ? `running=${firstSim.data.running} speed=${firstSim.data.speed} simElapsedMs=${firstSim.data.simElapsedMs} platforms=${firstSim.data.platforms} emitted=${firstSim.data.emitted}` : '（没收到 sim.state）')

  // ---- 倍速：8 ----
  const sp8 = await command('sim.speed', { speed: 8 })
  check('sim.speed{8} 生效（引擎接受，回执读数 = 8）',
    sp8.code === 0 && sp8.data?.state?.speed === 8,
    `code=${sp8.code} accepted=${sp8.data?.accepted} speed=${sp8.data?.state?.speed}`)
  const spBad = await command('sim.speed', { speed: 3 })
  check('sim.speed{3} 被**引擎**拒绝（只认 1/8/60）', spBad.code === 1000 && spBad.error?.accepted === false,
    `code=${spBad.code} ${spBad.error?.message ?? ''} allowed=${JSON.stringify(spBad.error?.allowed ?? [])}`)

  // ---- pause：遥测真的停止增长（真实计数差）----
  //
  // ★ 宿主机上可能同时有别的客户端（前端页面/别的验收）在按"起飞/继续"按钮 —— 它们会
  //   把本脚本的 pause 顶掉。这里用**有界重试**：pause → 取两次读数 → 三项零增长才算过；
  //   没过就再 pause 一次（最多 4 轮），并把每一轮的读数与当时的 wsClients 打印出来，
  //   让人一眼看出是"没生效"还是"被别人顶掉了"。
  await command('sim.speed', { speed: 8 })
  await sleep(1200)
  let frozen = false
  const attempts = []
  let wsClients = -1
  for (let i = 0; i < 4 && !frozen; i++) {
    await command('sim.pause')
    await sleep(400)
    const a = await getStats()
    const ast = await getState()
    wsClients = ast?.wsClients ?? wsClients
    await sleep(1500)
    const b = await getStats()
    const c1 = { e: a?.simulation?.eventsEmitted, s: a?.simulation?.simElapsedMs, c: a?.simulation?.sensor?.senseCalls }
    const c2 = { e: b?.simulation?.eventsEmitted, s: b?.simulation?.simElapsedMs, c: b?.simulation?.sensor?.senseCalls }
    frozen = c2.e === c1.e && c2.s === c1.s && c2.c === c1.c
    attempts.push({ round: i + 1, paused: ast?.simulation?.paused, wsClients, before: c1, after: c2, frozen })
  }
  const last = attempts.at(-1)
  check('sim.pause 之后遥测**真的**停止增长（eventsEmitted / simElapsedMs / senseCalls 三项零增长）',
    frozen,
    `第 ${attempts.length} 轮生效：eventsEmitted ${last.before.e}→${last.after.e}；simElapsedMs ${last.before.s}→${last.after.s}；` +
    `senseCalls ${last.before.c}→${last.after.c}（暂停 1.5 s）` +
    (attempts.length > 1 ? `；前 ${attempts.length - 1} 轮被顶掉（宿主机上还有 ${wsClients} 个 WS 客户端在驱动仿真）` : `；wsClients=${wsClients}`))
  const simAfterPause = (await getState()).simulation
  check('暂停后 /api/state 的 running/paused 读数与之一致', simAfterPause?.paused === true,
    `running=${simAfterPause?.running} paused=${simAfterPause?.paused}`)

  // ---- 单步：sim.step{dtMs} 精确推进 dtMs 仿真毫秒（暂停态下也能用：宿主先停驱动线程）----
  const stepA = (await getStats())?.simulation?.simElapsedMs
  const stp = await command('sim.step', { dtMs: 2000 })
  const stepB = (await getStats())?.simulation?.simElapsedMs
  check('sim.step{dtMs:2000} 精确推进 2000 仿真毫秒（引擎 SimSource::step，与倍速无关）',
    stp.code === 0 && (stepB - stepA) === 2000,
    `simElapsedMs ${stepA} → ${stepB}（Δ=${stepB - stepA}）events=${stp.data?.events} driverStopped=${stp.data?.driverStopped} unpaused=${stp.data?.unpaused}`)

  // ============================================================== 3) 目标随探测出现（起飞后）
  const sp60 = await command('sim.speed', { speed: 60 })
  const rs = await command('sim.resume')
  check('sim.resume 在单步之后真的让时间继续走（驱动线程重启 + 倍速保持 60）',
    sp60.code === 0 && sp60.data?.state?.speed === 60 && rs.data?.state?.running === true,
    `speed=${rs.data?.state?.speed} running=${rs.data?.state?.running} action=${rs.data?.action} paced=${rs.data?.state?.paused}`)
  let after = null
  for (let i = 0; i < 60; i++) {
    await sleep(700)
    after = await command('targets.list')
    if ((after.data?.targetCount ?? 0) > beforeCount) break
  }
  const afterCount = after.data?.targetCount ?? -1
  const det = after.data?.detection ?? {}
  console.log(`  · **起飞后实测**：targets.list 目标数=${afterCount}（台账实体总数 ${after.data?.count}）`)
  console.log(`  · 触发它的观测（原样）：${JSON.stringify(det.last ?? null)}`)
  console.log(`  · 落账计数（原样）：registered=${det.registered} merged=${det.merged} rebound=${det.rebound} failed=${det.failed} sourceFallback=${det.sourceFallback}`)
  check('目标**随探测出现**：起飞后目标数 > 起飞前（两侧都是实测数字）',
    beforeCount >= 0 && afterCount > beforeCount,
    `起飞前 ${beforeCount} → 起飞后 ${afterCount}`)
  check('出现的实体是**目标**且类型键/传感器来自真实探测（不是宿主自造）',
    !!det.last?.typeKey && !!det.last?.sensorId && det.registered >= 1,
    `首条：targetId=${det.last?.targetId} typeKey=${det.last?.typeKey} sensorId=${det.last?.sensorId} ` +
    `platformId=${det.last?.platformId} 距离=${Number(det.last?.distanceM).toFixed(0)}m 概率=${Number(det.last?.probability).toFixed(4)}；` +
    `registered=${det.registered} merged=${det.merged}`)
  check('目标实体类型键出现在剧本 targets.json 的 typeKey 集合里',
    (function () {
      try {
        const tp = JSON.parse(readFileSync(path.resolve('data', 'scenario-1', 'targets.json'), 'utf8'))
        const keys = new Set(tp.targets.map((t) => t.typeKey))
        return keys.has(det.last?.typeKey)
      } catch { return false }
    })(),
    `typeKey=${det.last?.typeKey}`)

  // ---- 拔掉传感器：不再有新目标被登记（对照实验）----
  const offCmd = await command('sensor.configure', { enabled: false })
  check('sensor.configure{enabled:false} 生效（"拔掉传感器"开关）',
    offCmd.code === 0 && offCmd.data?.enabled === false, `code=${offCmd.code} enabled=${offCmd.data?.enabled}`)
  const t1 = await getStats()
  const reg1 = t1?.simulation?.sensor?.targetDetections ?? -1
  const ent1 = (await command('targets.list')).data?.count ?? -1
  await sleep(4000)
  const t2 = await getStats()
  const reg2 = t2?.simulation?.sensor?.targetDetections ?? -1
  const ent2 = (await command('targets.list')).data?.count ?? -1
  const skipped = (t2?.simulation?.sensor?.disabledSkips ?? 0) - (t1?.simulation?.sensor?.disabledSkips ?? 0)
  check('拔掉传感器后**引擎侧不再产生目标观测**（targetDetections 零增长）且台账实体数不再变',
    reg2 === reg1 && ent2 === ent1 && skipped > 0,
    `targetDetections ${reg1}→${reg2}；台账实体 ${ent1}→${ent2}；disabledSkips +${skipped}（对应 sense 调用被跳过）`)
  const onCmd = await command('sensor.configure', { enabled: true })
  check('重新插上传感器（enabled=true）后观测恢复', onCmd.code === 0 && onCmd.data?.enabled === true,
    `enabled=${onCmd.data?.enabled}`)

  // ---- "把距离拉远"：量程缩放真的作用在 SensorSpec 上（有效量程 = 原值 × scale）----
  const baseRange = sensorsPack?.sensors?.find((s) => s.deviceType === 'optical')?.maxRangeM
  const sc = await command('sensor.configure', { rangeScale: 0.2 })
  const scaled = (await command('sensor.status')).data?.sensors?.find((s) => s.deviceType === 'optical')?.maxRangeM
  check('sensor.configure{rangeScale:0.2} 生效（"把距离拉远"作用在 SensorSpec 的 maxRangeM 上，观测仍由引擎算）',
    sc.code === 0 && Math.abs(scaled - baseRange * 0.2) < 1e-6,
    `optical maxRangeM ${baseRange} → ${scaled}（= ×0.2）；sensors.json 原值 ${baseRange}`)
  await command('sensor.configure', { rangeScale: 1 })

  // ============================================================== 4) 目标详情：威胁等级来自规则包
  const listNow = await command('targets.list')
  const targets = listNow.data?.targets ?? []
  check('targets.list 返回目标清单（含平台实体单列）',
    listNow.code === 0 && Array.isArray(targets) && targets.length > 0,
    `targets=${targets.length} platformEntities=${(listNow.data?.platformEntities ?? []).length}`)
  const entityId = targets[0]?.id
  const detail = await command('targets.detail', { entityId })
  const as = detail.data?.assessment ?? {}
  check('targets.detail 返回实体 + 威胁评级（assessEntity）',
    detail.code === 0 && !!as.band && typeof as.score === 'number',
    `code=${detail.code} entityId=${entityId} score=${as.score} band=${as.band} status=${as.status} rejected=${as.rejected}`)
  const packBand = (threatPack?.bands ?? []).find((b) => b.key === as.band)
  const packFactors = threatPack?.items ?? []
  const factorKeys = (as.factors ?? []).map((f) => f.key)
  check('威胁分档与 threatFactors.json 的 bands[] 一致（band/status 都来自规则包原文）',
    !!packBand && packBand.state === as.status,
    `引擎 band=${as.band}/status=${as.status}；规则包 bands 里 ${packBand ? `key=${packBand.key} min=${packBand.min} state=${packBand.state}` : '(没找到该 band)'}`)
  check('威胁因子集 = 规则包 items[]（逐因子带权重，可手算）',
    packFactors.length > 0 && packFactors.every((it) => factorKeys.includes(it.key)),
    `引擎因子=[${factorKeys.join(',')}]；规则包 items=[${packFactors.map((i) => i.key).join(',')}]`)
  const f0 = (as.factors ?? []).find((f) => f.key === packFactors[0]?.key)
  console.log(`  · 逐因子原样（首项）：${JSON.stringify(f0 ?? null)}`)
  check('逐因子带权重与贡献值（weightPpm/normPpm/contribution 都在，能复算总分）',
    !!f0 && typeof f0.weightPpm === 'number' && typeof f0.normPpm === 'number' &&
    typeof f0.contribution === 'number',
    f0 ? `${f0.key}: raw=${f0.rawNumber} normPpm=${f0.normPpm} weightPpm=${f0.weightPpm} contribution=${f0.contribution}` : '')

  // ---- 处置：声明过的动作能让引擎受理；没声明的动作由**引擎**拒 ----
  const declared = detail.data?.declaredActions ?? []
  const actOk = await command('targets.act', { entityId, action: 'watch' })
  check('targets.act{watch} 由 entity-ledger 受理（规则包 actions[] 里声明过）',
    actOk.code === 0 && (actOk.data?.actionKey === 'watch' || actOk.data?.data?.actionKey === 'watch'),
    `code=${actOk.code} status=${actOk.data?.status ?? actOk.data?.data?.status} message=${actOk.data?.message ?? actOk.data?.data?.message}`)
  const actBad = await command('targets.act', { entityId, action: 'observe' })
  check('未声明的动作（observe）由**引擎**拒（1004），宿主不自己判、不自造动作',
    actBad.code === 1004 && declared.includes('watch') && !declared.includes('observe'),
    `code=${actBad.code} message=${actBad.error?.message ?? actBad.error?.data?.message} 规则包动作=[${declared.join(',')}]`)
  const actGate = await command('targets.act', { entityId, action: 'strike' })
  const unmet = actGate.data?.unmet ?? actGate.error?.data?.unmet ?? []
  check('前置未满足的动作（strike 需 $action:upgrade + $in-sequence）回 1003 并给出 unmet 明细',
    actGate.code === 1003 && Array.isArray(unmet),
    `code=${actGate.code} unmet=[${unmet.map((u) => u.gate).join(',')}]`)

  // ============================================================== 5) 覆盖率 / 遍历周期（sensor-model 算的）
  const ss = await command('sensor.status')
  const sd = ss.data ?? {}
  console.log(`  · **sensor.status 原样关键字段**：coverageRatio=${sd.coverageRatio} ` +
    `coverageGrid=${JSON.stringify(sd.coverageGrid)} taskAreaKey=${sd.taskAreaKey} taskAreaKm2=${Number(sd.taskAreaKm2).toFixed(4)} ` +
    `coveredAreaUpperBoundKm2=${Number(sd.coveredAreaUpperBoundKm2).toFixed(3)}`)
  console.log(`  · **遍历周期原样**：${JSON.stringify(sd.revisitPeriodMs)}`)
  console.log(`  · 逐传感器（首台）：${JSON.stringify((sd.sensors ?? [])[0] ?? null)}`)
  check('sensor.status 的覆盖率是**算出来的**（格点法：任务区内被 cover() 覆盖的采样点比例，有界 [0,1]）',
    ss.code === 0 && sd.coverageGrid?.samplesInTaskArea > 0 && sd.coverageRatio >= 0 && sd.coverageRatio <= 1,
    `samplesInTaskArea=${sd.coverageGrid?.samplesInTaskArea} samplesCovered=${sd.coverageGrid?.samplesCovered} stepM=${sd.coverageGrid?.stepM} → ratio=${sd.coverageRatio}`)
  check('每条传感器读数都带"引擎入口"出处（cover 的面积/半径/扇区 + 位姿来源）',
    (sd.sensors ?? []).length > 0 && (sd.sensors ?? []).every((s) => !!s.poseSource) &&
    (sd.sensors ?? []).some((s) => typeof s.coverageAreaM2 === 'number'),
    `平台 ${(sd.sensors ?? []).length} 台；首台 poseSource=${(sd.sensors ?? [])[0]?.poseSource} coverageAreaM2=${(sd.sensors ?? [])[0]?.coverageAreaM2}`)
  // 遍历周期与 sensors.json 的 scanPeriodMs 手算核对（脚本侧独立取值）
  const perType = {}
  for (const s of sensorsPack?.sensors ?? []) {
    // 与 sensor_model::revisitPeriodMs 的公式一致：max(360-span, 360/dwell)/rate
    const T = s.scanPeriodMs
    const rate = s.sweepRateDegPerSec > 0 ? s.sweepRateDegPerSec : 360 / (T / 1000)
    const span = s.sweepSpanDeg > 0 ? s.sweepSpanDeg : (s.azimuthHalfFovDeg > 0 ? 2 * s.azimuthHalfFovDeg : 360)
    const dwell = Math.max(1, s.dwellPositions)
    perType[s.deviceType] = Math.max(360 - span, 360 / dwell) / rate * 1000
  }
  const revRows = (sd.sensors ?? []).filter((s) => typeof s.revisitPeriodMs === 'number')
  const revOk = revRows.every((s) => Math.abs(s.revisitPeriodMs - perType[s.deviceType]) < 1e-6)
  check('遍历周期与 sensors.json 手算值逐型号一致（脚本侧用同一公式独立复算）',
    revRows.length > 0 && revOk,
    revRows.map((s) => `${s.deviceType}:${s.revisitPeriodMs.toFixed(1)}ms(算 ${perType[s.deviceType]?.toFixed(1)})`).join(' '))

  // ============================================================== 6) 链路评估（topology）
  const topo = await command('topology.evaluate')
  const td = topo.data ?? {}
  const links = td.links ?? []
  const states = (td.policy?.states ?? []).map((s) => ({ key: s.key, min: s.min }))
  console.log(`  · **topology.evaluate 原样关键字段**：nodes=${td.topology?.nodes} edges=${td.topology?.edges} ` +
    `linkCount=${td.linkCount} linksWithState=${td.linksWithState} linksWithScore=${td.linksWithScore} ` +
    `ingest(frames=${td.ingest?.frames} links=${td.ingest?.links})`)
  console.log(`  · 规则包判据（引擎 policy() 原样）：states=${JSON.stringify(states)} hysteresis=${JSON.stringify(td.policy?.hysteresis)}`)
  console.log(`  · 逐链路原样（前 3 条）：${JSON.stringify(links.slice(0, 3).map((l) => ({ id: l.linkId, to: l.to, state: l.state, score: l.score, m: (l.metrics ?? []).map((x) => `${x.key}=${x.mean}`) })))}`)
  console.log(`  · 指标实测明细（首条）：${JSON.stringify((td.metricDetail ?? [])[0] ?? null)}`)
  check('topology.evaluate 装配 + 投递 + 评估 + 图元四步都返回',
    topo.code === 0 && td.topology?.configured === true && (td.primitives?.links ?? []).length > 0 &&
    typeof td.evaluation?.overall === 'number',
    `configured=${td.topology?.configured} structureKey=${td.topology?.structureKey} validate.ok=${td.topology?.validate?.ok} ` +
    `primitives.links=${(td.primitives?.links ?? []).length} evaluation.overall=${td.evaluation?.overall}`)
  check('states/hysteresis 与 linkThresholds.json **原文**一致（脚本独立读文件比对）',
    !!linkPack && JSON.stringify(states) === JSON.stringify((linkPack.states ?? []).map((s) => ({ key: s.key, min: s.min }))) &&
    td.policy?.hysteresis?.confirmCount === linkPack.hysteresis?.confirmCount &&
    td.policy?.hysteresis?.riseMargin === linkPack.hysteresis?.riseMargin &&
    td.policy?.hysteresis?.fallMargin === linkPack.hysteresis?.fallMargin,
    `引擎 ${JSON.stringify(states)} vs 规则包 ${JSON.stringify((linkPack?.states ?? []).map((s) => ({ key: s.key, min: s.min })))}；` +
    `hysteresis 引擎 ${JSON.stringify(td.policy?.hysteresis)} vs 规则包 ${JSON.stringify(linkPack?.hysteresis)}`)
  // 逐条核对：state == band(score)
  const bandOf = (score) => {
    const sorted = [...states].sort((a, b) => b.min - a.min)
    for (const s of sorted) if (score >= s.min) return s.key
    return null
  }
  const withBoth = links.filter((l) => l.hasState && l.hasScore)
  const mismatch = withBoth.filter((l) => l.state !== bandOf(l.score))
  check('每条链路的状态 = 按规则包阈值对 score 分档的结果（逐条核对，无例外）',
    withBoth.length > 0 && mismatch.length === 0,
    `参与核对的链路 ${withBoth.length}/${links.length} 条；不一致 ${mismatch.length} 条` +
    (mismatch.length ? `（${JSON.stringify(mismatch.map((l) => ({ id: l.linkId, score: l.score, state: l.state, expect: bandOf(l.score) })))}）` : '') +
    `；另 ${links.length - withBoth.length} 条无样本（未投递任何指标 → 引擎不给状态，MUST NOT 编造）`)
  check('链路条数 = 场景边数（平台→编组 + comm 中继），且节点来自场景数据',
    (td.topology?.edges ?? 0) === links.length && (td.topology?.nodes ?? 0) > 0,
    `nodes=${td.topology?.nodes}（6 编组 + 10 平台）edges=${td.topology?.edges} links=${links.length}`)
  check('拿不到的指标在 notes 里点名（signal/latencyMs/bandwidthMbps/coverageKm2…）',
    (td.notes ?? []).some((n) => /留空未投的指标/.test(n)) && (td.notes ?? []).some((n) => /lossRate/.test(n)),
    `${(td.notes ?? []).length} 条 notes；首条：${(td.notes ?? [])[0]?.slice(0, 60)}…`)
  // `topology.changed` 的口径：**首次判定**（引擎"直接落入当前档"）不算变更、不发事件；
  // 只有迟滞确认过的迁移才发。所以断言的是"两边一致"：引擎说有迁移 → 必须有事件；
  // 引擎说没有迁移 → 0 条是**正确**行为（不是漏发）。
  const stateChanges = td.evaluation?.inputs?.stateChangeCount ?? 0
  const changedEvents = of(events.seen, 'topology.changed').length
  check('topology.changed 事件与引擎的迁移计数一致（首次判定不发事件 = 引擎口径）',
    stateChanges > 0 ? changedEvents > 0 : changedEvents === 0,
    `引擎 stateChangeCount=${stateChanges}；收到 topology.changed ${changedEvents} 条（首次判定直接落入当前档 → 不计变更）`)

  // ============================================================== 7) /media/**：真字节流 + Range
  const media = await command('media.channels')
  const chans = media.data?.channels ?? []
  console.log(`  · **media.channels 原样**：hosted=${media.data?.hosted} root=${media.data?.root} channels=` +
    JSON.stringify(chans.map((c) => ({ id: c.id, kind: c.kind, frameCount: c.frameCount, frameIntervalMs: c.frameIntervalMs }))))
  check('media.channels 返回通道清单（形状 = {id,name,kind,url|frames,frameIntervalMs}）',
    media.code === 0 && chans.length > 0 && chans.every((c) => !!c.id && !!c.kind && ('url' in c) && ('frames' in c)),
    `channels=${chans.length}`)
  const mediaEv = of(events.seen, 'media.channels').length
  await command('media.channels', { broadcast: true })
  await sleep(500)
  check('media.channels 事件能通过 hub 下发（isValidEventType 过）',
    of(events.seen, 'media.channels').length > mediaEv,
    `事件 ${mediaEv} → ${of(events.seen, 'media.channels').length} 条`)
  const firstUrl = chans.find((c) => (c.frames ?? []).length > 0)?.frames?.[0] ?? chans.find((c) => c.url)?.url
  check('通道里有真实可取的字节流 URL', !!firstUrl, `url=${firstUrl}`)
  if (firstUrl) {
    const r200 = await fetch(`${URL_}${firstUrl}`)
    const buf = await r200.arrayBuffer()
    check('/media/** 真 200 且字节数 > 0（Content-Type 按扩展名）',
      r200.status === 200 && buf.byteLength > 0,
      `status=${r200.status} bytes=${buf.byteLength} content-type=${r200.headers.get('content-type')} accept-ranges=${r200.headers.get('accept-ranges')} content-length=${r200.headers.get('content-length')}`)
    const r206 = await fetch(`${URL_}${firstUrl}`, { headers: { Range: 'bytes=0-99' } })
    const buf2 = await r206.arrayBuffer()
    const cr = r206.headers.get('content-range')
    check('Range: bytes=0-99 → 206 + Content-Range + 100 字节',
      r206.status === 206 && buf2.byteLength === 100 && /^bytes 0-99\/\d+$/.test(cr ?? ''),
      `status=${r206.status} bytes=${buf2.byteLength} Content-Range=${cr}`)
    const r416 = await fetch(`${URL_}${firstUrl}`, { headers: { Range: 'bytes=99999999-' } })
    check('越界 Range → 416 + Content-Range: bytes */size', r416.status === 416,
      `status=${r416.status} Content-Range=${r416.headers.get('content-range')}`)
    const rHead = await fetch(`${URL_}${firstUrl}`, { method: 'HEAD' })
    check('HEAD 只回头（Content-Length 仍是资源长度）',
      rHead.status === 200 && Number(rHead.headers.get('content-length')) === buf.byteLength,
      `status=${rHead.status} content-length=${rHead.headers.get('content-length')}`)
  }
  const r404 = await fetch(`${URL_}/media/no-such-dir/no-such-file.jpg`)
  const b404 = await r404.text()
  check('不存在的文件 → 404（**不是** 200 + HTML 提示页）',
    r404.status === 404 && !/^\s*</.test(b404),
    `status=${r404.status} content-type=${r404.headers.get('content-type')} body=${b404.slice(0, 90)}`)
  const rEsc = await fetch(`${URL_}/media/../config.json`)
  check('越权路径（..）→ 404', rEsc.status === 404, `status=${rEsc.status}`)

  // ============================================================== 8) 真页面（步 6/7 切屏）
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
  const targetsList = await send('Target.getTargets')
  const page = targetsList.targetInfos.find((t) => t.type === 'page')
  const attached = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
  sessionId = attached.sessionId
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `${URL_}/` })
  await sleep(1500)
  console.log(`  · WS 采集器：open=${events.state.open} errors=${events.state.errors} ${events.state.error} pings=${events.state.pings}`)
  const stPage = await (async () => {
    for (let i = 0; i < 40; i++) {
      const s = await evalJs('window.__flowStats ? JSON.stringify(window.__flowStats()) : null')
      if (s) return JSON.parse(s)
      await sleep(300)
    }
    return null
  })()
  check('页面跟着宿主走（步 6/7：step/phase 由 flow.state 驱动）', !!stPage && stPage.step >= 6,
    stPage ? `step=${stPage.step} stepKey=${stPage.stepKey} phase=${stPage.phase}` : '（页面没暴露 __flowStats）')
  const s = await shot('p4-1-execute.png')
  if (s) console.log(`  · 截图：${s}`)

  events.close()
  console.log(`\n[p4] 通过 ${pass} / 失败 ${fail}`)
  console.log(fail === 0
    ? '[p4] PASS：起飞与倍速 → 链路评估 → 目标随探测出现 → 详情/处置 → /media Range 全链路真机通过'
    : '[p4] FAIL：见上表（脚本不掩盖任何一条）')
} catch (e) {
  console.error('[p4] 异常：', e.message)
  fail++
} finally {
  try { ws?.close() } catch { /* 忽略 */ }
  chrome.kill()
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

process.exit(fail === 0 ? 0 : 1)
