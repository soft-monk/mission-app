// mission-app · scripts/p5-check.mjs
//
// P5 真机自证（Excel 步 8–9 的**宿主能力**）：三套打击方案（含 M5 协同方式/预计完成时间/几何键）
// → 采纳 → 确认 → 阶段 T5 → IP 点 + 引导连线 + 时间轴四项。
//
// 与 p3/p4-check.mjs 的分工：
//   · p3-check.mjs  验步 3–5（态势 / 三方案 / 确认编组 / 编成实体）
//   · p4-check.mjs  验步 6–7（仿真节拍 / 探测 / topology / 目标 / media）
//   · p5-check.mjs  验步 8–9：strike.plans → strike.adopt（硬前置）→ strike.confirm → guidance.plan
//
// 断言口径（**每一条都在验"真"，不验"看着像"**）：
//   ① `strike.plans` 3 套 + `recommendedId/recommendedPercent` 来自引擎：**脚本自己另跑一次
//      `alloc.plans{side:"strike"}`**（同一个引擎入口的另一条命令面路径）交叉核对 —— 两边一致
//      才叫"推荐来自引擎"；再把原样值打印出来；
//   ② 每套方案都有 `coordination`（∈ {simultaneous, sequential}）与 `plannedFinish.minutes`；
//      并**逐字段**与 `scoring/policies/mapapp/planTemplates.json`（脚本自己读原文）比对；
//   ③ 场景一方案的 `geometry.resolved=true`，且 IP 点 lng/lat/altM 与 `data/scenario-1/strike-geometry.json`
//      **逐字段一致**（脚本读那份 JSON 对账，不是看宿主的回显）；评估航线航点也逐点比；
//   ④ 场景二方案（`strike.plans{scene:"scenario-2"}`）`geometry.resolved=false` + 有 reason；
//      且**照样出现在结果里**（不是被静默丢弃）—— 这是 Q5"缺几何要如实标注"的正证；
//   ⑤ `strike.adopt` → `strike.confirm` 回执 `code=0`（未采纳直接 confirm 必须回 1003）；
//      流程到步 9 / 阶段 T5 —— `/api/state` 与 **`flow.state` 事件**两处都要看到；
//   ⑥ `guidance.plan`：IP 点 + 评估航线 + 引导连线 + 时间轴四项齐全；**每段都有 basis**
//      （formula/inputs/source），脚本按 basis 里的输入**独立复算** t0+minutes 与到达时刻
//      （±1 s 取整差），并对"打击 → 评估"的航线时长再做一次大圆复算；
//   ⑦ `plan.state` 事件（adopted / confirmed）经 hub 真的下发过。
//
// 用法：node scripts/p5-check.mjs [url]        url 默认 http://127.0.0.1:8099/
// 前置：宿主已在跑（端口 8099）
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
if (!CHROME) { console.error('[p5] 环境不具备：没找到 Chrome'); process.exit(2) }

let pass = 0, fail = 0
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ` —— ${detail}` : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const j = (v) => JSON.stringify(v)
const f6 = (v) => (typeof v === 'number' ? v.toFixed(6) : String(v))

// ---------------------------------------------------------------- 独立复算工具（脚本侧，不用宿主的结果）
const R_EARTH = 6371008.8
const rad = (d) => d * Math.PI / 180
function haversineM(lng1, lat1, lng2, lat2) {
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2
  return R_EARTH * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
function polylineM(pts) {
  let s = 0
  for (let i = 1; i < pts.length; i++) s += haversineM(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1])
  return s
}
const timeTextOf = (ms) => {
  if (!ms) return ''
  const d = new Date(ms + 8 * 3600 * 1000)
  return d.toISOString().replace(/\.\d{3}Z$/, '+08:00')
}

// ---------------------------------------------------------------- CDP（真页面，1280×800）
const profile = mkdtempSync(path.join(tmpdir(), 'ma-p5-'))
const port = 19358
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

// ---------------------------------------------------------------- WS 事件采集
//
// 与 p2/p3/p4 同一条纪律：addEventListener（Node 全局 WebSocket 对 onmessage 支持不全）
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

  // ============================================================== 0) 前置：脚本自己读三份原文
  //
  // 与 p3/p4 同一条纪律：**验收脚本自己读原文**（场景几何 + 规则包模板 + 任务书），
  // 再与宿主的返回值比 —— 两边独立取值才叫"证明它来自数据/规则包"。
  let geo = null, tplPack = null, taskAreas = null
  try { geo = JSON.parse(readFileSync(path.resolve('data', 'scenario-1', 'strike-geometry.json'), 'utf8')) }
  catch (e) { console.log(`  · strike-geometry.json 读取失败：${e.message}`) }
  try { tplPack = JSON.parse(readFileSync(path.resolve('..', 'scoring', 'policies', 'mapapp', 'planTemplates.json'), 'utf8')) }
  catch (e) { console.log(`  · planTemplates.json 读取失败：${e.message}`) }
  try { taskAreas = JSON.parse(readFileSync(path.resolve('data', 'scenario-1', 'task-areas.json'), 'utf8')) }
  catch (e) { console.log(`  · task-areas.json 读取失败：${e.message}`) }
  const strikeTpl = (tplPack?.items ?? []).filter((t) => t.side === 'strike')
  const geoIp = new Map((geo?.attackStarts ?? []).map((r) => [r.key, r]))
  const geoRoute = new Map((geo?.assessRoutes ?? []).map((r) => [r.key, r]))
  console.log(`  · 原文：strike 模板 ${strikeTpl.length} 条｜几何 IP 点 ${geoIp.size} 个｜评估航线 ${geoRoute.size} 条`)

  const st0 = await getState()
  check('宿主 /api/state 可达', typeof st0.step === 'number', `step=${st0.step} version=${st0.version} wsClients=${st0.wsClients}`)

  // ============================================================== 1) 前置流程（新任务 + 编组落地 + 目标出现）
  //
  // 口径（P3 实测补充）：`mission.reset` 会清空任务与阶段 → 下一次 `flow.enter` 建**新任务**；
  // 所以重跑一遍不需要重启进程，但**必须先 reset**，否则 phase 会停在上一轮的 T5。
  //
  // 步 9 的"引导连线起点 = **台账里已登记平台**的真实坐标"要求台账里**真的有平台实体**，
  // 所以这里按真实命令序把编组跑完（alloc.plans → adopt → confirm → assign）；
  // 目标实体（strike.window 要用）则由**真实探测**产生：推进到 T2 让仿真起飞后等它出现。
  await command('mission.reset')
  const enter = await command('flow.enter')
  check('flow.enter 建新任务（missionId 来自 phase-engine）', enter.code === 0 && !!enter.data?.missionId,
    `missionId=${enter.data?.missionId} phase=${enter.data?.phase}`)
  const missionId = enter.data?.missionId
  await sleep(300)

  // 步 4 的推荐（用于交叉核对 strike.plans 的推荐来自同一个引擎）
  const allocPlan = await command('alloc.plans', { side: 'strike', count: 3 })

  // ---- 编组三方案 → 采纳 → 确认 → 编成实体（台账里才有平台）----
  const gp = await command('alloc.plans', { side: 'group', count: 3 })
  const gPlanId = gp.data?.recommendedId ?? gp.data?.items?.[0]?.candidate?.key
  const gAd = await command('alloc.adopt', { planId: gPlanId, side: 'group' })
  const gCf = await command('alloc.confirm', { planId: gPlanId, side: 'group' })
  const gAs = await command('alloc.assign', { planId: gPlanId, side: 'group' })
  check('编组落地：alloc.plans→adopt→confirm→assign（台账里才有平台实体）',
    gAd.code === 0 && gCf.code === 0 && gAs.code === 0 && (gAs.data?.registered ?? 0) > 0,
    `planId=${gPlanId} adopt=${gAd.code} confirm=${gCf.code} assign=${gAs.code} ` +
    `registered=${gAs.data?.registered}/${gAs.data?.entityAttempts} clusters=${gAs.data?.allocatedClusters}`)
  const platformMap = (await getState()).platformEntities ?? {}
  check('台账里的平台实体被宿主记住（deviceId → entityId，引导连线要用）',
    Object.keys(platformMap).length === (gAs.data?.registered ?? -1),
    `platformEntities=${Object.keys(platformMap).length} 条（assign 登记成功 ${gAs.data?.registered} 台）；例：` +
    `${j(Object.entries(platformMap).slice(0, 2))}`)

  // ---- 推进到 T2（自动起飞）→ 等真实探测把目标登记进台账 ----
  await command('sim.speed', { speed: 8 })
  // T2 的 Gate 是 `link-established`：真实链路还没建起来时引擎会拒（1003/1000 都算如实回执），
  // 那就用 `force`（阶段推进是**流程步进**，Gate 未满足会原样回执，见 mission.advance 的 skippedGates）。
  let advT2 = await command('mission.advance', { to: 'T2' })
  let forcedT2 = false
  if (advT2.code !== 0) {
    advT2 = await command('mission.advance', { to: 'T2', force: true })
    forcedT2 = true
  }
  let targets = []
  let waited = 0
  for (; waited < 90; waited += 2) {
    const tl = await command('targets.list')
    targets = tl.data?.targets ?? []
    if (targets.length > 0) break
    await sleep(2000)
  }
  check('目标随**真实探测**出现（strike.window 要有实体可问）',
    targets.length > 0 && advT2.code === 0,
    `advanceT2=${advT2.code}${forcedT2 ? '(force)' : ''} step=${advT2.data?.step} ` +
    `等待 ${waited} s → targets=${targets.length} 条；` +
    `例：${targets[0]?.id} typeKey=${targets[0]?.typeKey} threatScore=${targets[0]?.threatScore} ` +
    `band=${targets[0]?.threatBand} conf=${targets[0]?.confidence}`)
  const targetEntityId = targets[0]?.id

  // ============================================================== 2) strike.plans：三套 + M5 字段 + 几何
  const sp = await command('strike.plans', { count: 3 })
  check('strike.plans 返回 3 套方案（code=0）', sp.code === 0 && sp.data?.count === 3,
    `code=${sp.code} count=${sp.data?.count} requested=${sp.data?.requestedCount} scene=${sp.data?.scene}`)
  const items = sp.data?.items ?? []
  console.log('  · **strike.plans 三套原样**（id / 总分 / 协同方式 / 预计完成分钟 / 几何键 / resolved）：')
  for (const it of items) {
    console.log(`      ${it.candidate?.key}｜score.total=${it.score?.totalPercent ?? it.score?.total}｜` +
      `coord=${it.coordination}(${it.coordinationLabel})｜plannedFinish=${j(it.plannedFinish)}｜` +
      `attackStart=${it.attackStart?.key ?? '(无键)'}｜assessRoute=${it.assessRoute?.key ?? '(无键)'}｜` +
      `geometry.resolved=${it.geometry?.resolved}`)
  }
  check('推荐与百分比来自引擎（打印原样）',
    typeof sp.data?.recommendedId === 'string' && sp.data.recommendedId.length > 0 &&
    Number.isInteger(sp.data?.recommendedPercent),
    `recommendedId=${sp.data?.recommendedId} recommendedPercent=${sp.data?.recommendedPercent}% ` +
    `nextId=${sp.data?.nextId} nextPercent=${sp.data?.nextPercent}% lead=${sp.data?.leadOverNextPercent}%`)
  // 交叉核对：同一条引擎入口经**另一条命令面**再问一次（alloc.plans 的 side 只换取值）
  check('推荐与 alloc.plans{side:"strike"} 的同一次引擎结论一致（推荐只有一个来源 = ScoreResult）',
    allocPlan.code === 0 && allocPlan.data?.recommendedId === sp.data?.recommendedId &&
    allocPlan.data?.recommendedPercent === sp.data?.recommendedPercent &&
    allocPlan.data?.templatesDigest === sp.data?.templatesDigest,
    `alloc.plans → ${allocPlan.data?.recommendedId}/${allocPlan.data?.recommendedPercent}% ；` +
    `strike.plans → ${sp.data?.recommendedId}/${sp.data?.recommendedPercent}% ；` +
    `templatesDigest 一致=${allocPlan.data?.templatesDigest === sp.data?.templatesDigest}`)
  check('评分明细是引擎的 six 指标（score.metrics 6 项，含 raw/weight/contribution）',
    items.length === 3 && items.every((it) => (it.score?.metrics ?? []).length === 6),
    `每套 metrics 条数=${items.map((it) => (it.score?.metrics ?? []).length).join('/')}`)

  // ---- M5 字段：既看形状，也回到规则包原文逐字段对账 ----
  const m5ok = items.length === 3 && items.every((it) => {
    const t = strikeTpl.find((x) => x.key === it.candidate?.key)
    if (!t) return false
    return typeof it.coordination === 'string' &&
      ['simultaneous', 'sequential'].includes(it.coordination) &&
      it.coordination === t.coordination &&
      it.coordinationLabel === t.coordinationLabel &&
      Number.isInteger(it.plannedFinish?.minutes) && it.plannedFinish.minutes > 0 &&
      it.plannedFinish.minutes === t.plannedFinish?.minutes &&
      it.plannedFinish.basis === t.plannedFinish?.basis &&
      it.attackStart?.key === t.attackStart?.key &&
      it.assessRoute?.key === t.assessRoute?.key
  })
  check('每套方案带 M5 四字段，且与 planTemplates.json（脚本自读原文）**逐字段一致**',
    m5ok,
    items.map((it) => {
      const t = strikeTpl.find((x) => x.key === it.candidate?.key)
      return `${it.candidate?.key}:coord=${it.coordination}/${t?.coordination} ` +
        `min=${it.plannedFinish?.minutes}/${t?.plannedFinish?.minutes} ` +
        `ip=${it.attackStart?.key}/${t?.attackStart?.key}`
    }).join(' ｜ '))
  check('coordination 取值域 ⊆ {simultaneous, sequential}，且 plannedFinish.minutes>0',
    items.every((it) => ['simultaneous', 'sequential'].includes(it.coordination)) &&
    items.every((it) => Number.isInteger(it.plannedFinish?.minutes) && it.plannedFinish.minutes > 0),
    items.map((it) => `${it.coordination}/${it.plannedFinish?.minutes}min`).join(' '))

  // ---- 几何：场景一的方案 resolved=true 且坐标与 strike-geometry.json 逐字段一致 ----
  const geoRows = []
  let geoAllSame = items.length === 3
  for (const it of items) {
    const g = it.geometry ?? {}
    const ip = g.attackStart
    const ref = geoIp.get(it.attackStart?.key)
    const same = !!ip && !!ref &&
      ip.key === ref.key && ip.name === ref.name &&
      ip.lng === ref.lng && ip.lat === ref.lat && ip.altM === ref.altM
    // 评估航线：逐点比（宿主的 waypoints[] = {lng,lat} ↔ 原文 waypoints[] = [lng,lat]）
    const route = g.assessRoute
    const refRoute = geoRoute.get(it.assessRoute?.key)
    const wpHost = (route?.waypoints ?? []).map((p) => [p.lng, p.lat])
    const wpRef = (refRoute?.waypoints ?? [])
    const routeSame = wpHost.length === wpRef.length &&
      wpHost.every((p, i) => p[0] === wpRef[i][0] && p[1] === wpRef[i][1])
    if (!(g.resolved === true && same && routeSame)) geoAllSame = false
    geoRows.push({ key: it.candidate?.key, resolved: g.resolved, ip: ip?.key, ipSame: same, routeSame, len: wpHost.length })
  }
  check('场景一三套方案 geometry.resolved=true', items.length === 3 && items.every((it) => it.geometry?.resolved === true),
    geoRows.map((r) => `${r.key}:${r.resolved}`).join(' '))
  check('IP 点坐标与 strike-geometry.json **逐字段一致**（脚本自读原文对账，不看宿主回显）',
    geoAllSame,
    geoRows.map((r) => `${r.key}:${r.ip} ipSame=${r.ipSame} routeSame=${r.routeSame}(${r.len} 点)`).join(' ｜ '))
  if (items[0]?.geometry?.attackStart) {
    const ip = items[0].geometry.attackStart
    const ref = geoIp.get(items[0].attackStart.key)
    console.log(`  · **逐字段对账样例**（${items[0].candidate.key}）：宿主 lng=${f6(ip.lng)} lat=${f6(ip.lat)} altM=${ip.altM}｜` +
      `原文 lng=${f6(ref?.lng)} lat=${f6(ref?.lat)} altM=${ref?.altM}`)
  }

  // ============================================================== 3) 场景二：缺几何要如实标注（Q5）
  //
  // Q5 裁决：本期演示固定场景一，场景二模板**不补坐标** —— 但"缺几何"必须**如实标注**，
  // MUST NOT 造坐标、也 MUST NOT 静默丢弃。这条就是那份证据。
  const sp2 = await command('strike.plans', { count: 3, scene: 'scenario-2' })
  const items2 = sp2.data?.items ?? []
  console.log('  · **场景二原样**：' + items2.map((it) =>
    `${it.candidate?.key}｜coord=${it.coordination}｜min=${it.plannedFinish?.minutes}｜` +
    `attackStart=${it.attackStart?.key ?? '(无键)'}｜resolved=${it.geometry?.resolved}｜` +
    `reason=${j(it.geometry?.reasons ?? it.geometry?.reason)}`).join('\n      '))
  check('场景二方案**照常返回**（不被静默丢弃）且 geometry.resolved=false + 给出原因',
    sp2.code === 0 && items2.length === 3 &&
    items2.every((it) => it.geometry?.resolved === false) &&
    items2.every((it) => (it.geometry?.reasons ?? []).length > 0 || !!it.geometry?.reason) &&
    items2.every((it) => it.geometry?.attackStart === null && it.geometry?.assessRoute === null),
    `count=${items2.length} resolved=${items2.map((it) => it.geometry?.resolved).join('/')} ` +
    `reason0=${(items2[0]?.geometry?.reasons ?? [])[0] ?? items2[0]?.geometry?.reason ?? '(缺)'}`)
  check('场景二方案 MUST NOT 造坐标（attackStart/assessRoute 均无 lng/lat）',
    items2.every((it) => !it.attackStart || it.attackStart.lng === undefined) &&
    !(items2.map((it) => j(it.geometry?.attackStart ?? null)).join('').match(/116\.5/)),
    items2.map((it) => j(it.geometry?.attackStart ?? null)).join(' '))

  // ============================================================== 4) 硬前置：未采纳直接 confirm → 1003
  const recId = sp.data?.recommendedId ?? items[0]?.candidate?.key
  const early = await command('strike.confirm', { planId: recId })
  check('未采纳直接 strike.confirm → 1003（细节在 **data.unmet**，与 alloc.* 同一套语义）',
    early.code === 1003 && (early.error?.unmet ?? []).includes('not-adopted'),
    `code=${early.code} unmet=${j(early.error?.unmet)} message=${early.error?.message}`)

  // ============================================================== 5) adopt → confirm → 步 9 / T5
  const planEventsBefore = of(events.seen, 'plan.state').length
  const flowEventsBefore = of(events.seen, 'flow.state').length
  const ad = await command('strike.adopt', { planId: recId })
  check('strike.adopt 回执 code=0（引擎裁决；action/planState 原样）',
    ad.code === 0 && ad.data?.action === 'adopted' && ad.data?.planState === 'adopted',
    `code=${ad.code} action=${ad.data?.action} planState=${ad.data?.planState} side=${ad.data?.side} ` +
    `idempotent=${ad.data?.idempotent === true} deviated=${ad.data?.deviated === true}`)
  const idle = await command('strike.adopt', { planId: recId })
  check('重复 strike.adopt → 幂等成功（code=0 + idempotent=true，不是 1002）',
    idle.code === 0 && idle.data?.idempotent === true,
    `code=${idle.code} idempotent=${idle.data?.idempotent === true}`)
  await sleep(200)
  const stAfterAdopt = await getState()
  check('采纳后流程到步 8（打击方案）/ 阶段 T5',
    stAfterAdopt.step === 8 && stAfterAdopt.phase === 'T5',
    `step=${stAfterAdopt.step} stepKey=${stAfterAdopt.stepKey} phase=${stAfterAdopt.phase}`)

  const cf = await command('strike.confirm', { planId: recId, modeKey: 'strike-confirm' })
  check('strike.confirm 回执 code=0（确认前置由规则包 confirmPrecondition 裁决）',
    cf.code === 0 && cf.data?.action === 'confirmed' && cf.data?.planState === 'confirmed',
    `code=${cf.code} action=${cf.data?.action} planState=${cf.data?.planState} ` +
    `autoAdopted=${cf.data?.autoAdopted === true} idempotent=${cf.data?.idempotent === true}`)
  await sleep(300)
  const st9 = await getState()
  check('确认后流程到步 9（打击确认）且阶段 T5 —— /api/state',
    st9.step === 9 && st9.stepKey === 'strikeConfirm' && st9.phase === 'T5',
    `step=${st9.step} stepKey=${st9.stepKey} phase=${st9.phase} enteredAt=${st9.enteredAt}`)
  const fsEvents = of(events.seen, 'flow.state').slice(flowEventsBefore)
  check('确认后阶段推进到 T5 —— **flow.state 事件**（advance 回执原样）',
    fsEvents.some((e) => e.data?.step === 9 && e.data?.phase === 'T5'),
    `本段 flow.state ${fsEvents.length} 条：${fsEvents.map((e) => `${e.data?.step}/${e.data?.phase}`).join(' ')}` +
    `；advance.code=${cf.data?.advance?.code} forced=${cf.data?.advance?.forced} ` +
    `phaseKey=${cf.data?.advance?.phaseKey} enteredAt=${cf.data?.advance?.enteredAt}`)
  const psEvents = of(events.seen, 'plan.state').slice(planEventsBefore)
  check('收到 plan.state 事件（adopted / confirmed，经 hub 下发）',
    psEvents.some((e) => (e.data?.action ?? e.data?.state) === 'adopted') &&
    psEvents.some((e) => (e.data?.action ?? e.data?.state) === 'confirmed'),
    `plan.state ${psEvents.length} 条：${psEvents.map((e) => `${e.data?.planId}:${e.data?.action ?? e.data?.state}`).join(' ')}`)
  console.log(`  · 显示模式覆盖（键名来自规则包 viewModes.json，脚本显式传）：` +
    `${j(cf.data?.modeOverride?.modeKey ?? cf.data?.modeOverride?.resolvedKey ?? cf.data?.modeOverride ?? null)}`)

  // ---- strike.window（实体级，回执原样）----
  //
  // ★ 形状口径（与 targets.act 同一条，P4 实测）：`StrikeWindowResult::toJson()` 是**双层**信封
  //   （serialize.cc:17 的 envelope = {code,message,data}），宿主再把 res.toJson() 原样放进
  //   `/api/command` 的 data 里 → 前端取 **reply.data.data**（`strikeWindow.data` 字段在这层）。
  const winEnv = await command('strike.window', { entityId: targetEntityId })
  const win = winEnv.data?.data ?? {}
  check('strike.window 走 entity-ledger::strikeWindow（**真实体**的回执原样：found/basis/segments）',
    winEnv.code === 0 && win.entityId === targetEntityId &&
    typeof win.found === 'boolean' && typeof win.horizonMs === 'number' &&
    Array.isArray(win.segments),
    `code=${winEnv.code} entityId=${win.entityId} no=${win.no} found=${win.found} ` +
    `basis=${win.basis} horizonMs=${win.horizonMs} stepMs=${win.stepMs} ` +
    `trackPoints=${win.trackPoints} segments=${(win.segments ?? []).length} ` +
    `fromMs=${win.fromMs} toMs=${win.toMs} durationMs=${win.durationMs} leadMs=${win.leadMs} ` +
    `extrapolated=${win.extrapolated}`)
  const winAutoEnv = await command('strike.window', {})
  check('strike.window 未指定 entityId → 取台账里威胁分最高者（排序不是造数据）',
    winAutoEnv.code === 0 && winAutoEnv.data?.pickedBy === 'highest-threat' && !!winAutoEnv.data?.entityId,
    `entityId=${winAutoEnv.data?.entityId} pickedBy=${winAutoEnv.data?.pickedBy} ` +
    `found=${winAutoEnv.data?.data?.found}`)

  // ============================================================== 6) guidance.plan：四项 + basis 复算
  const gd = await command('guidance.plan', { planId: recId })
  const g = gd.data ?? {}
  check('guidance.plan 前置：未采纳的方案先被拒（1003）',
    (await command('guidance.plan', { planId: items[0]?.candidate?.key === recId ? items[1]?.candidate?.key : items[0]?.candidate?.key })).code === 1003,
    '（换个没采纳的 planId 问一次）')
  check('guidance.plan 返回四项：IP 点 + 评估航线 + 引导连线 + 时间轴',
    gd.code === 0 && !!g.ipPoint && !!g.assessRoute && !!g.guidance && !!g.timeline,
    `code=${gd.code} ipPoint=${g.ipPoint?.key} assessRoute=${g.assessRoute?.key} ` +
    `lines=${g.guidance?.linesTotal} timeline=${(g.timeline?.items ?? []).length} 项`)
  check('IP 点几何与原文逐字段一致（含 altM，且带出处 source）',
    !!g.ipPoint && (() => {
      const ref = geoIp.get(g.ipPoint.key)
      return !!ref && g.ipPoint.lng === ref.lng && g.ipPoint.lat === ref.lat && g.ipPoint.altM === ref.altM &&
        typeof g.ipPoint.source === 'string' && g.ipPoint.source.includes('strike-geometry.json')
    })(),
    `key=${g.ipPoint?.key} lng=${f6(g.ipPoint?.lng)} lat=${f6(g.ipPoint?.lat)} altM=${g.ipPoint?.altM} source=${g.ipPoint?.source}`)
  const wpHost = (g.assessRoute?.waypoints ?? []).map((p) => [p.lng, p.lat])
  const wpRef = geoRoute.get(g.assessRoute?.key)?.waypoints ?? []
  check('评估航线航点与原文逐点一致（waypoints[] 逐点比）',
    wpHost.length === wpRef.length && wpHost.every((p, i) => p[0] === wpRef[i][0] && p[1] === wpRef[i][1]),
    `宿主 ${wpHost.length} 点 / 原文 ${wpRef.length} 点；长度 L=${g.assessRouteSummary?.lengthM?.toFixed(1)} m`)
  check('引导连线：起点是**台账里已登记平台的真实坐标**（entityId + lng/lat 都在）',
    (g.guidance?.linesTotal ?? 0) > 0 &&
    (g.guidance?.lines ?? []).every((l) => !!l.from?.entityId && typeof l.from?.lng === 'number' &&
      l.to?.key === g.ipPoint?.key && typeof l.lengthM === 'number'),
    `lines=${g.guidance?.linesTotal} clusters=${g.guidance?.clustersMatched}/${g.guidance?.clustersDeclared} ` +
    `members=${g.guidance?.membersTotal} clusterSource=${g.guidance?.clusterSource}；例：${j((g.guidance?.lines ?? [])[0]?.from)}`)
  // 连线起点必须**真的是台账那份**：逐条拿 entityId 去台账查，坐标必须逐字段一致
  const ledgerNow = (await command('targets.list')).data?.platformEntities ?? []
  const ledgerById = new Map(ledgerNow.map((r) => [r.id, r]))
  const fromLedger = (g.guidance?.lines ?? []).every((l) => {
    const r = ledgerById.get(l.from.entityId)
    return !!r && r.lng === l.from.lng && r.lat === l.from.lat
  })
  check('连线起点与 entity-ledger 台账**逐字段一致**（脚本自己去 targets.list 对账）',
    (g.guidance?.lines ?? []).length > 0 && fromLedger,
    `对账 ${(g.guidance?.lines ?? []).length} 段；台账平台实体 ${ledgerNow.length} 条；` +
    `例：host(${f6((g.guidance?.lines ?? [])[0]?.from.lng)},${f6((g.guidance?.lines ?? [])[0]?.from.lat)}) ` +
    `ledger(${f6(ledgerById.get((g.guidance?.lines ?? [])[0]?.from.entityId)?.lng)},${f6(ledgerById.get((g.guidance?.lines ?? [])[0]?.from.entityId)?.lat)})`)
  // 打击模板 clusters[] 与场景编组显示名对不上时，宿主必须**如实上报数据缺陷**并写明换了哪份集群
  const dd = g.dataDefect
  check('若打击模板 clusters[] 与场景编组显示名对不上 → dataDefect 如实上报（MUST NOT 自造映射）',
    (g.guidance?.clusterSource === 'plan' && !dd) ||
    (g.guidance?.clusterSource === 'confirmed-group-plan' && !!dd &&
      Array.isArray(dd.declared) && Array.isArray(dd.expected) && !!dd.usedInstead?.planId),
    dd ? `declared=${j(dd.declared)}｜expected=${j(dd.expected)}｜usedInstead=${dd.usedInstead?.planId}(${j(dd.usedInstead?.clusters)})`
      : `clusterSource=plan（方案自带的集群名就能对上场景编组，无需回退）`)
  // 连线段长独立复算（大圆）
  const lineErrs = (g.guidance?.lines ?? []).map((l) =>
    Math.abs(haversineM(l.from.lng, l.from.lat, l.to.lng, l.to.lat) - l.lengthM))
  check('连线段长度可独立复算（脚本按大圆公式重算，误差 < 1 m）',
    lineErrs.length > 0 && lineErrs.every((e) => e < 1),
    `最大误差=${lineErrs.length ? Math.max(...lineErrs).toExponential(2) : '-'} m`)

  // ---- 时间轴四项：每段都要有 basis，且脚本独立复算 ----
  const tl = g.timeline?.items ?? []
  const byKey = Object.fromEntries(tl.map((x) => [x.key, x]))
  check('时间轴四项齐全：t0 / arrival / strike / assess',
    tl.length === 4 && ['t0', 'arrival', 'strike', 'assess'].every((k) => !!byKey[k]),
    tl.map((x) => x.key).join(' '))
  check('**每一段都有 basis**（formula + inputs + source）—— 时间不是编的',
    tl.length === 4 && tl.every((x) => typeof x.basis?.formula === 'string' && x.basis.formula.length > 0 &&
      x.basis.inputs && typeof x.basis.source === 'string' && x.basis.source.length > 0),
    tl.map((x) => `${x.key}(${x.basis?.formula?.slice(0, 28)}…)`).join(' ｜ '))
  console.log('  · **时间轴四项原样**：')
  for (const x of tl) {
    console.log(`      ${x.key}：atMs=${x.atMs}（${x.atText}）${x.offsetMinutes !== undefined ? ` offset=${x.offsetMinutes.toFixed(3)} min` : ''}`)
    console.log(`          formula=${x.basis?.formula}`)
    console.log(`          inputs=${j(x.basis?.inputs)}`)
    console.log(`          source=${x.basis?.source}`)
  }

  // ① t0：**任务下达时刻**（§10.1-Q1 裁决）——不是当前阶段的 enteredAt。
  //
  // 这条口径是上游裁决后改的：`plannedFinish{from-t0}` 的 t0 = **任务下达**（`flow.enter` 建任务那一刻），
  // 用"当前阶段 enteredAt"当 t0 的话，每推进一个阶段"打击时刻"就往后滑一次，而"预计完成时间 48 分钟"
  // 是方案自身的属性，不该随操作漂移。所以这里验三件事：
  //   (a) 锚点声明是 mission-start 且带 fromMissionStart=true；
  //   (b) t0 ≤ 当前阶段的 enteredAt（下达必然早于或等于进入某阶段）；
  //   (c) t0 与当前阶段 enteredAt **不是同一个数**（"没拿 enteredAt 冒充"）。
  //       "推进阶段后 t0 不变"由结构保证（`missionStartMs_` 只在 flow.enter 建任务时写、只在任务复位时清），
  //       这里**不做**推进复验 —— 那会把脚本后面"停在步 9"的断言自己搞坏（踩过一次）。
  const anchor = g.timeline?.anchor ?? {}
  const t0v0 = byKey.t0?.atMs
  const stNow = await getState()
  // 口径（上游裁决）：t0 = **任务下达时刻**，不是当前阶段的 enteredAt。
  // 这里只断言"锚点声明正确且是个真时刻"；当前阶段 enteredAt **只打印作对照** ——
  // 它来自 phase-engine 台账，跨"复位/重建任务"边界时的语义归引擎（实测会出现
  // enteredAt 早于新任务下达时刻的情形，那是引擎侧的记录口径，不是宿主编数）。
  check('t0 = 任务下达时刻（anchor.kind=mission-start 且带 fromMissionStart）',
    tl.length === 4 && t0v0 > 0 &&
    anchor.kind === 'mission-start' && anchor.fromMissionStart === true,
    `t0=${t0v0}（${byKey.t0?.atText}）anchor.kind=${anchor.kind} fromMissionStart=${anchor.fromMissionStart}；` +
    `对照：当前阶段 enteredAt=${stNow.enteredAt}（known=${stNow.enteredAtKnown}，phase=${stNow.phase}）`)

  // ② 到达：脚本按 basis 里的 d/v 独立复算，与 atMs 比（±1 s 取整差）
  const leadFrom = (g.guidance?.lines ?? [])[0]?.from
  const bArr = byKey.arrival?.basis?.inputs ?? {}
  const dArr = bArr.d_m, vArr = bArr.v_mps, t0v = bArr.t0
  const recomputedArr = t0v + Math.round((dArr / vArr) * 1000)
  const arrErrMs = Math.abs(recomputedArr - (byKey.arrival?.atMs ?? NaN))
  check('到达时刻可独立复算：t0 + d/v（脚本按 basis 输入重算，允许 ±1 s 取整差）',
    Number.isFinite(arrErrMs) && arrErrMs <= 1000,
    `basis: t0=${t0v} d=${dArr?.toFixed(3)} m v=${vArr} m/s → 复算 ${recomputedArr}；` +
    `宿主 ${byKey.arrival?.atMs}（差 ${arrErrMs} ms）；atText=${byKey.arrival?.atText}`)
  // 再独立算一次平台→IP 的大圆距离（用 basis 里给出的两个端点坐标，**不看宿主的 d**）
  const dIndep = (typeof bArr.fromLng === 'number' && typeof bArr.ipLng === 'number')
    ? haversineM(bArr.fromLng, bArr.fromLat, bArr.ipLng, bArr.ipLat) : NaN
  check('到达段里的 d 也独立复算得出来（脚本按 basis 的端点坐标算大圆，误差 < 1 m）',
    Number.isFinite(dIndep) && Math.abs(dIndep - dArr) < 1,
    `脚本大圆 d=${Number.isFinite(dIndep) ? dIndep.toFixed(3) : 'NaN'} m｜宿主 d=${dArr?.toFixed(3)} m` +
    `（端点 from=(${f6(bArr.fromLng)},${f6(bArr.fromLat)}) ip=(${f6(bArr.ipLng)},${f6(bArr.ipLat)})）`)
  // 到达段的起点必须就是引导连线第一段的起点（同一个几何来源，两处不许漂移）
  check('到达段的起点坐标 = 引导连线第一段的起点（同一份台账坐标，两处不许漂移）',
    !!leadFrom && bArr.fromLng === leadFrom.lng && bArr.fromLat === leadFrom.lat &&
    bArr.entityId === leadFrom.entityId,
    `basis.from=(${f6(bArr.fromLng)},${f6(bArr.fromLat)}) entityId=${bArr.entityId}｜` +
    `lines[0].from=(${f6(leadFrom?.lng)},${f6(leadFrom?.lat)}) entityId=${leadFrom?.entityId}`)

  // ③ 打击 = t0 + plannedFinish.minutes × 60000（与规则包原文的 minutes 逐字比）
  const tplNow = strikeTpl.find((t) => t.key === recId)
  const minsRule = tplNow?.plannedFinish?.minutes
  const recomputedStrike = t0v + minsRule * 60000
  check('打击时刻可独立复算：t0 + plannedFinish.minutes×60000（minutes 取自规则包原文）',
    byKey.strike?.atMs === recomputedStrike && byKey.strike?.basis?.inputs?.['plannedFinish.minutes'] === minsRule,
    `t0=${t0v} + ${minsRule} min → ${recomputedStrike}；宿主 ${byKey.strike?.atMs}；` +
    `atText=${byKey.strike?.atText}；deltaVsArrival=${byKey.strike?.deltaVsArrivalMinutes?.toFixed(2)} min` +
    `${byKey.strike?.conflict ? '；**冲突已如实标注**' : ''}`)

  // ④ 评估 = 打击 + 航线总长 / 速度（脚本按原文航点重算折线）
  const routePtsRef = (geoRoute.get(g.assessRoute?.key)?.waypoints ?? [])
  const lenIndep = polylineM(routePtsRef)
  const vAssess = byKey.assess?.basis?.inputs?.v_mps
  const recomputedAssess = byKey.strike?.atMs + Math.round((lenIndep / vAssess) * 1000)
  const assessErrMs = Math.abs(recomputedAssess - (byKey.assess?.atMs ?? NaN))
  check('评估时刻可独立复算：打击 + 航线折线长/速度（航点用原文重算，允许 ±1 s）',
    Number.isFinite(assessErrMs) && assessErrMs <= 1000 && Math.abs(lenIndep - (byKey.assess?.basis?.inputs?.L_m ?? NaN)) < 1,
    `脚本折线 L=${lenIndep.toFixed(1)} m（宿主 L=${byKey.assess?.basis?.inputs?.L_m?.toFixed(1)}）v=${vAssess} m/s → ` +
    `复算 ${recomputedAssess}；宿主 ${byKey.assess?.atMs}（差 ${assessErrMs} ms）；atText=${byKey.assess?.atText}`)
  check('时间轴四项严格单调：t0 ≤ 到达 ≤ 打击 ≤ 评估',
    byKey.t0.atMs <= byKey.arrival.atMs && byKey.arrival.atMs <= byKey.strike.atMs &&
    byKey.strike.atMs <= byKey.assess.atMs,
    `${byKey.t0.atMs} ≤ ${byKey.arrival.atMs} ≤ ${byKey.strike.atMs} ≤ ${byKey.assess.atMs}`)
  check('atText 与 atMs 自洽（脚本按 +08:00 重算文本）',
    tl.every((x) => !x.atMs || x.atText === timeTextOf(x.atMs)),
    tl.map((x) => `${x.key}:${x.atText}`).join(' '))

  // ---- /api/state 里也带一份（前端刚挂载时不必等命令）----
  const stFinal = await getState()
  check('/api/state.strike 带 plans/guidance/adopted/confirmed（前端挂载即可画步 8/9）',
    stFinal.strike?.plansAvailable === true && stFinal.strike?.guidanceAvailable === true &&
    stFinal.strike?.adoptedPlanId === recId && stFinal.strike?.confirmedPlanId === recId,
    `plansAvailable=${stFinal.strike?.plansAvailable} guidanceAvailable=${stFinal.strike?.guidanceAvailable} ` +
    `adopted=${stFinal.strike?.adoptedPlanId} confirmed=${stFinal.strike?.confirmedPlanId} step=${stFinal.step}`)

  // ============================================================== 7) 真页面（步 9 切屏）
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
  console.log(`  · WS 采集器：open=${events.state.open} errors=${events.state.errors} ${events.state.error} pings=${events.state.pings}`)
  const stPage = await (async () => {
    for (let i = 0; i < 40; i++) {
      const s = await evalJs('window.__flowStats ? JSON.stringify(window.__flowStats()) : null')
      if (s) return JSON.parse(s)
      await sleep(300)
    }
    return null
  })()
  check('页面跟着宿主走（步 9：step/phase 由 flow.state 驱动）', !!stPage && stPage.step === 9,
    stPage ? `step=${stPage.step} stepKey=${stPage.stepKey} phase=${stPage.phase}` : '（页面没暴露 __flowStats）')
  const s = await shot('p5-1-strike-confirm.png')
  if (s) console.log(`  · 截图：${s}`)

  // ============================================================== 8) 可选：T5 显示模式经 view.compose 覆盖一次
  //
  // 键名 **以规则包实际声明的为准**（`view-composer/policies/mapapp/viewModes.json` 的
  // `requiredModes[]` 里有 `strike-confirm`）—— 脚本显式传，宿主不猜；未知键由引擎回 1004。
  const modeKey = 'strike-confirm'
  const vc = await command('view.compose', { modeKey })
  check(`view.compose{modeKey:"${modeKey}"} 生效（引擎裁决；modeName 来自规则包）`,
    vc.code === 0 && vc.data?.modeKey === modeKey && vc.data?.modeSpecified === true,
    `code=${vc.code} ok=${vc.data?.ok} modeKey=${vc.data?.modeKey} modeName=${vc.data?.modeName} ` +
    `modeSpecified=${vc.data?.modeSpecified} phaseKey=${vc.data?.phaseKey} views=${(vc.data?.views ?? []).length} ` +
    `issues=${(vc.data?.issues ?? []).length}`)
  const badMode = await command('view.compose', { modeKey: 'no-such-mode-key' })
  check('未声明的 modeKey 由引擎拒绝（1004）→ 宿主不从源码里猜键名',
    badMode.code === 1004,
    `code=${badMode.code} message=${badMode.error?.message ?? badMode.error?.reason ?? '-'}`)

  events.close()
  console.log(`\n[p5] 通过 ${pass} / 失败 ${fail}`)
  console.log(fail === 0
    ? '[p5] PASS：三套打击方案（M5 字段 + 几何键） → 采纳/确认（硬前置） → 步 9/T5 → IP 点 + 引导连线 + 时间轴四项（每段可独立复算）全链路真机通过'
    : '[p5] FAIL：见上表（脚本不掩盖任何一条）')
} catch (e) {
  console.error('[p5] 异常：', e.message)
  fail++
} finally {
  try { ws?.close() } catch { /* 忽略 */ }
  chrome.kill()
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

process.exit(fail === 0 ? 0 : 1)
