// mission-app · scripts/p6-check.mjs
//
// P6 真机自证（Excel 步 10–11 的**宿主能力**）：协同执行与引导（目标动作 → 状态推进 →
// 仿真侧俯冲 + **由读数派生**的命中 → 步 10）→ 任务总结报告（report-engine 生成 + 时间轴逐字
// + 预警计数 + 台账汇总 + 留存层如实留空 → 步 11）。
//
// 与 p2–p5-check.mjs 的分工：
//   · p2-check.mjs  验步 1–2（启动加载 / 自检）
//   · p3-check.mjs  验步 3–5（态势 / 三方案 / 确认编组 / 编成实体）
//   · p4-check.mjs  验步 6–7（仿真节拍 / 探测 / topology / 目标 / media）
//   · p5-check.mjs  验步 8–9（打击三方案 / M5 字段 / 采纳确认 / IP 点 + 引导连线 + 时间轴）
//   · p6-check.mjs  验步 10–11：exec.run（含读数派生命中）/ exec.abort / report.generate
//
// 断言口径（**每一条都在验"真"，不验"看着像"**）：
//   ① `exec.run` 前打印目标 `dynamicState` **原样**；之后必须变成 `struck` / `destroyed`，
//      且 `target.state` 事件（冻结名）真的经 hub 下发（两条：→struck、→destroyed）；
//   ② **命中判定必须有 basis**（判据 + 输入 + 来源）：脚本按 basis 里的判据与 inputs、用
//      `dive.samples` 的**逐帧读数**独立复算最近接近距离/命中时刻/命中平台，并另用 haversine
//      交叉核对投影；俯冲终端速度也按 basis 的算式（√(v₀²+2gΔh)）复算；
//   ③ `exec.abort` 的语义：能退就退（`upgrade` 可撤销 → 真退掉），不能退**如实回 1003**
//      （`strike` 不可逆 + 规则包没有声明 destroyed→… 的迁移）并把引擎的 `unmet[]` 原样带出；
//   ④ `report.generate` 返回 `code=0`，且**时间轴 durations 与 `phase::durations()` 逐字相等**
//      （脚本另走 `mission.timeline` 取一次，比 `durationsRaw` 字符串 + digest）；
//   ⑤ 报告里凡"留存层无数据"的段落 MUST 带**可读原因**（脚本断言 `retention.note` / `dataGaps` /
//      快照 `extra.retention.note` 三处都在，且 `report.missing` 的每一项都能被解释）；
//   ⑥ 反证：**未经前置的 `targets.act{action:"strike"}` 必须被引擎回 1003**（`$action:upgrade` +
//      `$in-sequence`）—— 证明宿主补前置是为了过引擎的 Gate，而不是绕过它；
//   ⑦ 状态不回弹：`exec.run` 之后仿真继续跑（探测继续落账），目标状态必须**仍是** destroyed
//      （engine-ledger 的 `registerEntity` 在观测不带状态时会写回规则默认态 —— 宿主已按台账现值带回）。
//
// 用法：node scripts/p6-check.mjs [url]        url 默认 http://127.0.0.1:8099/
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
if (!CHROME) { console.error('[p6] 环境不具备：没找到 Chrome'); process.exit(2) }

let pass = 0, fail = 0
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ` —— ${detail}` : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const j = (v) => JSON.stringify(v)
const f3 = (v) => (typeof v === 'number' ? v.toFixed(3) : String(v))
const f6 = (v) => (typeof v === 'number' ? v.toFixed(6) : String(v))

// ---------------------------------------------------------------- 独立复算工具（脚本侧，不用宿主的结果）
const R_EARTH = 6371008.8
const G_STD = 9.80665
const rad = (d) => d * Math.PI / 180
function haversineM(lng1, lat1, lng2, lat2) {
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2
  return R_EARTH * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
// 宿主 basis 里声明的投影：e=Δlng·R·cos(lat₀)，n=Δlat·R，u=alt（参考点 = 目标台账位置）
function enu(lng, lat, altM, refLng, refLat) {
  return { e: rad(lng - refLng) * R_EARTH * Math.cos(rad(refLat)), n: rad(lat - refLat) * R_EARTH, u: altM }
}
const sub = (a, b) => ({ e: a.e - b.e, n: a.n - b.n, u: a.u - b.u })
const len = (v) => Math.sqrt(v.e * v.e + v.n * v.n + v.u * v.u)
function segDist(a, b, p) {
  const d = sub(b, a)
  const den = d.e * d.e + d.n * d.n + d.u * d.u
  let t = 0
  if (den > 1e-12) {
    t = ((p.e - a.e) * d.e + (p.n - a.n) * d.n + (p.u - a.u) * d.u) / den
    t = Math.max(0, Math.min(1, t))
  }
  const q = { e: a.e + d.e * t, n: a.n + d.n * t, u: a.u + d.u * t }
  return { d: len(sub(p, q)), t }
}
const fnv1a64 = (text) => {
  let h = 1469598103934665603n
  const M = 1099511628211n, MASK = (1n << 64n) - 1n
  for (const ch of Buffer.from(text, 'utf8')) { h = (h ^ BigInt(ch)) & MASK; h = (h * M) & MASK }
  return h.toString(16).padStart(16, '0')
}

// ---------------------------------------------------------------- CDP（真页面，1280×800）
const profile = mkdtempSync(path.join(tmpdir(), 'ma-p6-'))
const port = 19359
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
// 与 p2–p5 同一条纪律：addEventListener（Node 全局 WebSocket 对 onmessage 支持不全）
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

try {
  // ★ WebSocket 必须建在**任何 fetch 之前**（undici 的 WS 与 fetch 共用 dispatcher）。
  const events = collectEvents()

  // ============================================================== 0) 前置：脚本自己读两份规则包原文
  //
  // 与 p3–p5 同一条纪律：**验收脚本自己读原文**（动作清单/requires、IP 点几何），再与宿主的
  // 返回值比 —— 两边独立取值才叫"证明它来自规则包/数据"。
  let typesPack = null, geo = null
  try { typesPack = JSON.parse(readFileSync(path.resolve('..', 'entity-ledger', 'policies', 'mapapp', 'entityTypes.json'), 'utf8')) }
  catch (e) { console.log(`  · entityTypes.json 读取失败：${e.message}`) }
  try { geo = JSON.parse(readFileSync(path.resolve('data', 'scenario-1', 'strike-geometry.json'), 'utf8')) }
  catch (e) { console.log(`  · strike-geometry.json 读取失败：${e.message}`) }
  const acts = new Map((typesPack?.actions ?? []).map((a) => [a.key, a]))
  const states = new Set((typesPack?.dynamicStates?.items ?? []).map((s) => s.key))
  const transitions = new Set((typesPack?.dynamicStates?.transitions ?? []).map((t) => `${t.from}->${t.to}`))
  const dedupRadiusM = typesPack?.dedup?.spaceRadiusM
  const geoIp = new Map((geo?.attackStarts ?? []).map((r) => [r.key, r]))
  console.log(`  · 原文：动作 ${acts.size} 个｜状态 ${states.size} 个｜迁移 ${transitions.size} 条｜` +
    `dedup.spaceRadiusM=${dedupRadiusM}｜几何 IP 点 ${geoIp.size} 个`)
  console.log(`  · strike 的 requires（规则包原文）：${j(acts.get('strike')?.requires)}｜reversible=${acts.get('strike')?.reversible}`)

  const st0 = await getState()
  check('宿主 /api/state 可达', typeof st0.step === 'number',
    `step=${st0.step} version=${st0.version} wsClients=${st0.wsClients}`)

  // ============================================================== 1) 前置流程（新任务 → 编组 → 目标 → 步 9）
  //
  // ★ 并行施工的实测坑：同一个宿主端口上**可能有别的自证脚本/前端探针在发命令**
  //   （本工程实测：另一个 agent 的 `.p6-ui.mjs` 会把流程推到 T7）。所以前置流程结束后
  //   **复验"步 9 / 阶段 T5"**，被外部命令改动就整段重跑（阶段 T5/T6 不可回退，只能重来）。
  let pf = null
  let attempts = 0
  for (attempts = 1; attempts <= 3 && pf === null; attempts++) {
    await command('mission.reset')
    const enter = await command('flow.enter')
    const missionId = enter.data?.missionId
    await sleep(300)
    const gp = await command('alloc.plans', { side: 'group', count: 3 })
    const gPlanId = gp.data?.recommendedId ?? gp.data?.items?.[0]?.candidate?.key
    const gAd = await command('alloc.adopt', { planId: gPlanId, side: 'group' })
    const gCf = await command('alloc.confirm', { planId: gPlanId, side: 'group' })
    const gAs = await command('alloc.assign', { planId: gPlanId, side: 'group' })
    await command('sim.speed', { speed: 8 })
    let advT2 = await command('mission.advance', { to: 'T2' })
    let forcedT2 = false
    if (advT2.code !== 0) { advT2 = await command('mission.advance', { to: 'T2', force: true }); forcedT2 = true }
    let targets = []
    let waited = 0
    for (; waited < 90; waited += 2) {
      const tl = await command('targets.list')
      targets = tl.data?.targets ?? []
      if (targets.length > 0) break
      await sleep(2000)
    }
    const sp = await command('strike.plans', { count: 3 })
    const recId = sp.data?.recommendedId ?? sp.data?.items?.[0]?.candidate?.key
    await command('strike.adopt', { planId: recId })
    const cf = await command('strike.confirm', { planId: recId })
    const gd = await command('guidance.plan', { planId: recId })
    const stNow = await getState()
    if (enter.code === 0 && missionId && targets.length > 0 && cf.code === 0 && gd.code === 0 &&
        stNow.step === 9 && stNow.phase === 'T5') {
      pf = { enter, missionId, gp, gPlanId, gAd, gCf, gAs, advT2, forcedT2, targets, waited, sp, recId, cf, gd, stNow }
      continue
    }
    console.log(`  · 第 ${attempts} 次前置流程收尾时不在步 9/T5（step=${stNow.step}/${stNow.phase}，` +
      `confirm=${cf.code} targets=${targets.length}）→ 疑似被外部命令改动，重跑前置流程`)
  }
  check('前置流程就位：步 9 / 阶段 T5（若被外部命令改动过会自动重跑；最多 3 次）',
    pf !== null, pf ? `第 ${attempts - 1} 次尝试成功` : `3 次尝试都被外部命令打断`)
  if (!pf) throw new Error('前置流程无法就位（宿主端口疑似被其它脚本占用）')

  const { enter, missionId, gAs, targets, advT2, forcedT2, waited, cf, gd, recId } = pf
  check('flow.enter 建新任务（missionId 来自 phase-engine）', enter.code === 0 && !!missionId,
    `missionId=${missionId} phase=${enter.data?.phase}`)
  check('编组落地：alloc.plans→adopt→confirm→assign（台账里才有平台实体）',
    pf.gAd.code === 0 && pf.gCf.code === 0 && gAs.code === 0 && (gAs.data?.registered ?? 0) > 0,
    `planId=${pf.gPlanId} registered=${gAs.data?.registered}/${gAs.data?.entityAttempts}`)
  check('目标随**真实探测**出现（exec.run 要有实体可打）',
    targets.length > 0 && advT2.code === 0,
    `advanceT2=${advT2.code}${forcedT2 ? '(force)' : ''} step=${advT2.data?.step} 等待 ${waited} s → ` +
    `targets=${targets.length} 条`)
  const target = targets[0]
  const targetEntityId = target?.id
  console.log('  · **exec.run 前目标原样**：' + j({
    id: target?.id, no: target?.no, typeKey: target?.typeKey, dynamicState: target?.dynamicState,
    threatBand: target?.threatBand, threatScore: target?.threatScore, confidence: target?.confidence,
    lng: target?.lng, lat: target?.lat, alt: target?.alt,
  }))

  check('strike.confirm 后停在步 9（P5 实测：它**不自动**推进到步 10）',
    cf.code === 0 && pf.stNow.step === 9 && pf.stNow.phase === 'T5',
    `confirm=${cf.code} step=${pf.stNow.step} stepKey=${pf.stNow.stepKey} phase=${pf.stNow.phase}`)
  check('guidance.plan 给出 IP 点（步 10 的俯冲起点几何）',
    gd.code === 0 && !!gd.data?.ipPoint?.key,
    `code=${gd.code} ipPoint=${gd.data?.ipPoint?.key} lng=${f6(gd.data?.ipPoint?.lng)} ` +
    `lat=${f6(gd.data?.ipPoint?.lat)} altM=${gd.data?.ipPoint?.altM} lines=${gd.data?.guidance?.linesTotal}`)

  // ============================================================== 2) 反证：未经前置的 strike 被引擎拒
  //
  // 这条是"宿主补前置 ≠ 绕过 Gate"的正证：同一个 verb（targets.act）**直打** strike，引擎必须回
  // 1003 且 unmet 里指名 `$action:upgrade` 与 `$in-sequence`（规则包原文的 requires）。
  const bare = await command('targets.act', { entityId: targetEntityId, action: 'strike' })
  // ★ 形状口径（实测）：引擎的 `ActionResult::toJson()` 是**双层**信封（与 targets.act 同一条，
  //   P4 实测）→ unmet 在 `error.data.unmet`；宿主包的 `error.unmet` 也一并读，两种都在就都算。
  const bareUnmet = [...(bare.error?.unmet ?? []), ...(bare.error?.data?.unmet ?? [])].map((u) => u.gate ?? u)
  check('反证：未经前置的 targets.act{action:"strike"} → 1003 + unmet 指名规则包的 requires（宿主不绕 Gate）',
    bare.code === 1003 && bareUnmet.includes('$action:upgrade') && bareUnmet.includes('$in-sequence'),
    `code=${bare.code} unmet=${j(bareUnmet)} message=${bare.error?.message ?? bare.error?.data?.message}` +
    `（规则包 requires=${j(acts.get('strike')?.requires)}）`)

  // ============================================================== 3) exec.run：动作 → 状态 → 俯冲/命中 → 步 10
  const tlEarly = await command('mission.timeline')
  check('mission.timeline 给出 durations 的原样字符串（报告要逐字比的那一份）',
    tlEarly.code === 0 && typeof tlEarly.data?.durationsRaw === 'string' && tlEarly.data.durationsRaw.length > 0,
    `rawlen=${tlEarly.data?.durationsRaw?.length} digest=${tlEarly.data?.durationsDigest} ` +
    `totalMs=${tlEarly.data?.anchors?.totalMs}`)
  const digestEarly = tlEarly.data?.durationsDigest
  check('durationsDigest = 脚本按 FNV-1a 64 独立复算的同一值（逐字相等的另一半证据）',
    digestEarly === fnv1a64(tlEarly.data?.durationsRaw ?? ''),
    `宿主 ${digestEarly}｜脚本 ${fnv1a64(tlEarly.data?.durationsRaw ?? '')}`)

  const tsEventsBefore = of(events.seen, 'target.state').length
  const er = await command('exec.run', { entityId: targetEntityId })
  const ed = er.data ?? {}
  check('exec.run 回执 code=0（三件事都过引擎裁决）', er.code === 0,
    `code=${er.code}${er.code !== 0 ? ` message=${er.error?.message ?? er.error?.reason}` : ''}` +
    ` step=${ed.step} stepKey=${ed.stepKey} phase=${ed.phase}`)

  // ---- ① 目标动作（动作键与 requires 来自规则包；前置按声明顺序补齐）----
  const actRows = ed.actions ?? []
  const byKey = Object.fromEntries(actRows.map((r) => [r.actionKey, r]))
  check('① 目标动作：upgrade（前置）与 strike（主动作）都真跑过引擎、都 code=0',
    byKey.upgrade?.code === 0 && byKey.strike?.code === 0,
    actRows.map((r) => `${r.actionKey}:code=${r.code}/status=${r.data?.status}/idem=${r.data?.idempotent}`).join(' ｜ '))
  check('① 动作清单与 requires 取自规则包（脚本自读原文逐字比）',
    j(ed.declaredActions) === j([...acts.keys()]) && j(ed.declaredRequires) === j(acts.get('strike')?.requires),
    `宿主 declaredActions=${j(ed.declaredActions)}｜declaredRequires=${j(ed.declaredRequires)}`)
  const pre = ed.prerequisites ?? []
  check('① 前置补齐：$action:upgrade → applyAction(upgrade)、$in-sequence → addToSequence（都 code=0）',
    pre.some((p) => p.gate === '$action:upgrade' && p.code === 0) &&
    pre.some((p) => p.gate === '$in-sequence' && (p.code === 0 || p.data?.status === 'added')),
    pre.map((p) => `${p.gate}:${p.code ?? p.data?.status ?? '宿主不代劳'}`).join(' ｜ '))

  // ---- ② 状态推进（struck → destroyed），以及 target.state 事件 ----
  const trans = ed.stateTransitions ?? []
  const toStruck = trans.find((t) => t.to === 'struck')
  const toDestroyed = trans.find((t) => t.to === 'destroyed')
  check('② 状态推进：briefStop/mid → struck → destroyed（两次都由引擎裁决 code=0）',
    ed.stateBefore === target?.dynamicState && toStruck?.code === 0 && toDestroyed?.code === 0,
    `stateBefore=${ed.stateBefore}（exec.run 前 targets.list 原样=${target?.dynamicState}）→ ` +
    `stateAfter=${ed.stateAfter}；transitions=${trans.map((t) => `${t.to}:${t.code}`).join(' → ')}`)
  const after = (await command('targets.detail', { entityId: targetEntityId })).data
  check('② 台账现值 = destroyed（不是只看回执；脚本另查一次 targets.detail）',
    after?.entity?.dynamicState === 'destroyed',
    `dynamicState=${after?.entity?.dynamicState} status=${after?.entity?.status}（灰/红由规则包 bands 声明）`)
  const tsEvents = of(events.seen, 'target.state').slice(tsEventsBefore)
  const tsStates = tsEvents.filter((e) => e.data?.targetId === targetEntityId).map((e) => e.data?.dynamicState)
  // ★ 实测坑：探测落账时 entity-ledger **每次观测归并都发一条 `target.state`**（同一状态也会重发）→
  //   8 倍速下 WS 上每秒几百条，脚本侧的处理会滞后于 HTTP 回执。所以这里等一会儿再读（不是放宽判据：
  //   仍然要求真的收到 →struck 与 →destroyed 两条）。
  let statesSeen = tsStates
  for (let w = 0; w < 20 && !(statesSeen.includes('struck') && statesSeen.includes('destroyed')); w++) {
    await sleep(500)
    statesSeen = of(events.seen, 'target.state').slice(tsEventsBefore)
      .filter((e) => e.data?.targetId === targetEntityId).map((e) => e.data?.dynamicState)
  }
  const tsAll = of(events.seen, 'target.state').slice(tsEventsBefore)
  check('② 收到 target.state 事件（冻结名，经 hub 下发；含 →struck 与 →destroyed）',
    statesSeen.includes('struck') && statesSeen.includes('destroyed'),
    `本段 target.state ${tsAll.length} 条（探测归并会重发同一状态）｜本目标状态序列去重=` +
    `${j([...new Set(statesSeen)])}｜末条=${j(tsAll.filter((e) => e.data?.targetId === targetEntityId).at(-1)?.data)}`)

  // ---- ③ 仿真侧俯冲 + **由读数派生**的命中 ----
  const dive = ed.dive ?? {}
  check('③ 俯冲剖面已由 sim-bridge 施加（SimSource::init，引擎校验通过）',
    dive.applied === true,
    `applied=${dive.applied} lead=${dive.scenario?.leadPlatformId} diveDevices=${j(dive.scenario?.diveDevices)} ` +
    `ipPoint=${dive.scenario?.ipPoint?.key} legFromIpM=${f3(dive.scenario?.legFromIpM)}`)
  const prof = dive.profile ?? {}
  const v0 = prof.basis?.inputs?.v0_mps, dh = prof.basis?.inputs?.dh_m, g = prof.basis?.inputs?.g_mps2
  const vRecomp = Math.sqrt(v0 * v0 + 2 * g * dh)
  check('③ 俯冲终端速度可独立复算：√(v₀²+2gΔh)（inputs 全部有出处）',
    Number.isFinite(vRecomp) && Math.abs(vRecomp - prof.diveSpeedMps) < 1e-9 && g === G_STD,
    `v₀=${v0} m/s（${prof.basis?.v0Source}）Δh=${dh} m（巡航 ${prof.cruiseAltM} → 终端 ${prof.diveAltM}，` +
    `目标台账高度）g=${g} → 复算 ${f3(vRecomp)}｜宿主 ${f3(prof.diveSpeedMps)} m/s`)

  const hit = dive.hit ?? {}
  const crit = dive.hitCriterion ?? {}
  check('③ 命中由**读数**派生（不是写死）：detected=true + basis（判据/输入/来源）齐全',
    hit.detected === true && typeof hit.basis?.formula === 'string' && !!hit.basis?.inputs &&
    typeof hit.basis?.source === 'string' && crit.R_m === dedupRadiusM,
    `platformId=${hit.platformId} minDistanceM=${f3(hit.minDistanceM)} R=${crit.R_m} m` +
    `（= 规则包 dedup.spaceRadiusM=${dedupRadiusM}）crossings=${crit.crossings}`)

  // —— 脚本按 basis 的判据**独立复算**：逐帧读数 → 段-点最近接近（含投影交叉核对） ——
  const samples = dive.samples ?? []
  const tgt = dive.scenario?.target
  const byPlatform = new Map()
  for (const s of samples) {
    if (!byPlatform.has(s.platformId)) byPlatform.set(s.platformId, [])
    byPlatform.get(s.platformId).push(s)
  }
  let bestAll = { d: Infinity }
  for (const [pid, rows] of byPlatform) {
    for (let i = 1; i < rows.length; i++) {
      const a = enu(rows[i - 1].lng, rows[i - 1].lat, rows[i - 1].altM, tgt.lng, tgt.lat)
      const b = enu(rows[i].lng, rows[i].lat, rows[i].altM, tgt.lng, tgt.lat)
      const p = { e: 0, n: 0, u: tgt.altM }
      const { d, t } = segDist(a, b, p)
      if (d < bestAll.d) bestAll = { d, t, pid, i, a, b, rows }
    }
  }
  check('②/③ 脚本按**逐帧读数**独立复算最近接近距离 —— 与回执的命中段一致（判据可复算）',
    Number.isFinite(bestAll.d) && Math.abs(bestAll.d - (hit.minDistanceM ?? NaN)) <= 1e-6 &&
    bestAll.pid === hit.platformId,
    `脚本复算 d=${f6(bestAll.d)} m（平台 ${bestAll.pid}，第 ${bestAll.i - 1}→${bestAll.i} 帧）｜` +
    `宿主 hit.minDistanceM=${f6(hit.minDistanceM)} 平台 ${hit.platformId}`)
  check('③ 命中判据成立：复算 d ≤ R（且 R 来自规则包，不是宿主自造）',
    bestAll.d <= crit.R_m,
    `d=${f3(bestAll.d)} m ≤ R=${crit.R_m} m（余量 ${f3(crit.R_m - bestAll.d)} m）`)
  // 投影交叉核对：脚本另用 haversine 算同一段的水平距离，与 ENU 的 sqrt(de²+dn²) 比
  const rowA = bestAll.rows[bestAll.i - 1], rowB = bestAll.rows[bestAll.i]
  const hav = haversineM(rowA.lng, rowA.lat, rowB.lng, rowB.lat)
  const enuH = Math.sqrt((bestAll.b.e - bestAll.a.e) ** 2 + (bestAll.b.n - bestAll.a.n) ** 2)
  check('③ 投影交叉核对：ENU 水平距离 ≈ haversine（同一段的两种算法，误差 < 1 m）',
    Math.abs(hav - enuH) < 1,
    `haversine=${f3(hav)} m｜ENU=${f3(enuH)} m（差 ${f6(Math.abs(hav - enuH))} m）`)
  const segLen = len(sub(bestAll.b, bestAll.a))
  const atRecomp = rowA.simElapsedMs + bestAll.t * (rowB.simElapsedMs - rowA.simElapsedMs)
  check('③ 命中时刻可独立复算：t_i + t*·(t_i+1 − t_i)',
    Math.abs(atRecomp - (hit.atSimElapsedMs ?? NaN)) <= 1,
    `t_i=${rowA.simElapsedMs} t*=${bestAll.t.toFixed(6)} t_i+1=${rowB.simElapsedMs} → 复算 ` +
    `${Math.round(atRecomp)} ms｜宿主 ${hit.atSimElapsedMs} ms（段长 ${f3(segLen)} m）`)
  check('③ 命中段的读数齐全（6 个自由度 + 时刻都在样本里，脚本用的就是它们）',
    !!hit.segment?.from && !!hit.segment?.to && rowA.lng === hit.segment.from.lng &&
    rowB.lng === hit.segment.to.lng && hit.segment.from.simElapsedMs === rowA.simElapsedMs,
    'from=' + j({
      lng: f6(hit.segment?.from?.lng), lat: f6(hit.segment?.from?.lat),
      altM: hit.segment?.from?.altM, v: hit.segment?.from?.speedMps,
      t: hit.segment?.from?.simElapsedMs,
    }))
  const ranges = byPlatform.get(hit.platformId)?.map((s) => s.rangeToTargetM) ?? []
  const minRange = Math.min(...ranges)
  check('③ 逐帧读数显示"真的飞到了目标上空"（rangeToTargetM 收敛到 0）',
    ranges.length > 2 && minRange < 1,
    `样本 ${ranges.length} 帧｜range 从 ${f3(ranges[0])} m 收敛到 ${f6(minRange)} m（末帧 ` +
    `${byPlatform.get(hit.platformId)?.at(-1)?.motionState}）`)
  // IP 点：宿主用的必须就是场景几何里的那个（脚本自读原文）
  const ipHost = dive.scenario?.ipPoint
  const ipRef = geoIp.get(ipHost?.key)
  check('③ 俯冲起点 = strike-geometry.json 的 IP 点（脚本自读原文逐字段对账）',
    !!ipRef && ipHost?.lng === ipRef.lng && ipHost?.lat === ipRef.lat && ipHost?.altM === ipRef.altM,
    `key=${ipHost?.key} 宿主(${f6(ipHost?.lng)},${f6(ipHost?.lat)},${ipHost?.altM})｜` +
    `原文(${f6(ipRef?.lng)},${f6(ipRef?.lat)},${ipRef?.altM})`)
  // 俯冲终点 = 台账里**exec.run 那一刻**的目标位置（同一瞬间 → 逐字段相等）；台账位置会被后续探测
  // 持续更新（目标移动/观测抖动），所以这里另给"与当前台账位置的位移"作对照，不当成失败。
  const ledgerAtRun = ed.entity
  const movedM = (tgt && after?.entity)
    ? haversineM(tgt.lng, tgt.lat, after.entity.lng, after.entity.lat) : NaN
  check('③ 俯冲终点 = entity-ledger 台账里的目标位置（逐字段比 exec.run 那一刻的台账快照）',
    !!tgt && !!ledgerAtRun && tgt.lng === ledgerAtRun.lng && tgt.lat === ledgerAtRun.lat,
    `俯冲终点(${f6(tgt?.lng)},${f6(tgt?.lat)},${tgt?.altM})｜exec.run 时台账(${f6(ledgerAtRun?.lng)},` +
    `${f6(ledgerAtRun?.lat)},${ledgerAtRun?.alt})｜当前台账(${f6(after?.entity?.lng)},` +
    `${f6(after?.entity?.lat)}) 位移 ${f3(movedM)} m（探测持续更新台账位置）｜来源=${tgt?.source}`)
  check('③ 剖面与判据的来源与"引擎没有命中事件"的事实都写进了回执',
    typeof prof.basis?.note === 'string' && prof.basis.note.includes('MUST NOT') &&
    typeof crit.R_source === 'string' && crit.R_source.includes('spaceRadiusM'),
    `profile.basis.note=${prof.basis?.note?.slice(0, 60)}…｜R_source=${crit.R_source?.slice(0, 40)}…`)
  console.log(`  · **命中回执原样**：谁=${hit.platformId}（${hit.groupKey}）｜何时=${hit.atSimElapsedMs} ms` +
    `（simEpoch0Ms=${hit.simEpoch0Ms}）｜最近接近=${f6(hit.minDistanceM)} m｜判据 R=${crit.R_m} m｜` +
    `命中段 ${hit.segment?.from?.i}→${hit.segment?.to?.i}`)
  console.log(`  · **俯冲剖面原样**：巡航 ${prof.cruiseAltM} m / ${prof.cruiseSpeedMps} m/s → 终端 ` +
    `${prof.diveAltM} m / ${f3(prof.diveSpeedMps)} m/s（Δh=${dh} m；sim-source 无垂直运动学，剖面=两档）`)

  // ---- ④ 步 10 的语义 ----
  check('④ exec.run 把流程落到步 10 / 阶段 T6（P5 实测 confirm 不自动推进，宿主收口）',
    ed.step === 10 && ed.phase === 'T6' && ed.stepKey === 'guidance',
    `step=${ed.step} stepKey=${ed.stepKey} phase=${ed.phase} advance.code=${ed.advance?.code} ` +
    `forced=${ed.advance?.forced}（advance.stepSemantics=${ed.advance?.stepSemantics?.slice(0, 30)}…）`)
  const fsEvents = of(events.seen, 'flow.state').filter((e) => e.data?.step === 10)
  const stAfterRun = await getState()
  check('④ flow.state 事件里也真的看到步 10（事件面与 /api/state 两处一致）',
    fsEvents.length > 0 && stAfterRun.step >= 10,
    `本段 flow.state 中 step=10 的 ${fsEvents.length} 条｜/api/state.step=${stAfterRun.step} ` +
    `（若 >10 说明同一宿主上有别的客户端又推进了流程；本轮回执里的 step=${ed.step} 是权威）`)

  // ---- ⑤ 状态不回弹（踩过的坑：观测会把状态写回规则默认态）----
  await sleep(6000)
  const tl2 = await command('targets.list')
  const still = (tl2.data?.targets ?? []).find((t) => t.id === targetEntityId)
  check('⑤ 仿真继续跑（探测继续落账）6 s 后，目标状态**仍是** destroyed（观测不覆盖任务状态）',
    still?.dynamicState === 'destroyed',
    `dynamicState=${still?.dynamicState}（exec.run 后一直是 destroyed；` +
    `探测计数 registered=${tl2.data?.detection?.registered} merged=${tl2.data?.detection?.merged}）`)

  // ============================================================== 4) exec.abort：能退就退，不能退如实 1003
  const ab = await command('exec.abort', { entityId: targetEntityId })
  const abr = ab.code === 0 ? ab.data : (ab.error ?? {})
  const undos = abr.undos ?? []
  const undById = Object.fromEntries(undos.map((u) => [u.actionKey, u]))
  check('⑤ exec.abort 逐动作撤销：**可逆的 upgrade 真退掉了**（code=0，changes 非空）',
    undById.upgrade?.code === 0,
    `undone=${undos.filter((u) => u.code === 0).map((u) => u.actionKey).join(',') || '(无)'}` +
    `｜upgrade.changes=${j(undById.upgrade?.data?.changes)}（flags/priority 回到原值）`)
  check('⑤ exec.abort **不可逆的 strike 如实回 1003 + 引擎原因**（$irreversible，宿主不绕过）',
    undById.strike?.code === 1003 &&
    (undById.strike?.data?.unmet ?? []).some((u) => (u.gate ?? u) === '$irreversible') &&
    acts.get('strike')?.reversible === false,
    `strike:code=${undById.strike?.code} unmet=${j((undById.strike?.data?.unmet ?? []).map((u) => u.gate))}` +
    `（规则包 reversible=${acts.get('strike')?.reversible}）`)
  const roll = abr.stateRollback ?? {}
  const rollUnmet = (roll.unmet ?? []).map((u) => `${u.gate}:${u.detail}`)
  const canRollBack = transitions.has(`${abr.stateBefore ?? ''}->${roll.requested ?? ''}`)
  check('⑤ 状态回退：能退就退 / 不能退如实 1003（判据 = 规则包声明的迁移表，脚本自读原文判）',
    (roll.code === 0 && abr.stateAfter === roll.requested) ||
    (roll.code === 1003 && !canRollBack && rollUnmet.length > 0),
    `请求回退到 ${j(roll.requested)}（从 ${j(roll.from)}）：code=${roll.code} unmet=${j(rollUnmet)}｜` +
    `规则包是否声明该迁移=${canRollBack}｜stateAfter=${abr.stateAfter}`)
  check('⑤ 整体语义：退不动 → code=1003 且 error.unmet 非空、说明可读（不是静默成功）',
    (ab.code === 1003 && (ab.error?.unmet ?? []).length > 0 && typeof ab.error?.message === 'string') ||
    (ab.code === 0 && abr.reversible === true),
    `code=${ab.code} message=${ab.error?.message ?? ab.data?.message ?? '(code=0)'} ` +
    `unmet=${j((ab.error?.unmet ?? []).map((u) => u.gate))} reversible=${abr.reversible}`)
  check('⑤ 回执写明"仿真侧不可回退"（MUST NOT 声称仿真回退了）',
    (abr.notes ?? []).some((n) => n.includes('不可回退')),
    (abr.notes ?? []).map((n) => n.slice(0, 34) + '…').join(' ｜ '))

  // ============================================================== 5) report.generate（步 11）
  //
  // ★ durations 的"逐字相等"要在**同一任务状态**上比：报告在 `advance(T7)` **之前**取 durations，
  //   所以脚本要在 report.generate 之前取一次（exec.run 已经把阶段推到 T6，时间轴因此变长）。
  const tlBefore = await command('mission.timeline')
  const durationsRawBefore = tlBefore.data?.durationsRaw
  const digestBefore = tlBefore.data?.durationsDigest
  check('exec.run 之后 phase::durations() 真的变了（多出 T6 段）——步 10 是"真推进"而不是只改宿主步号',
    durationsRawBefore !== tlEarly.data?.durationsRaw &&
    (tlBefore.data?.timeline ?? []).some((e) => e.phase === 'T6'),
    `exec.run 前 rawlen=${tlEarly.data?.durationsRaw?.length} → 之后 rawlen=${durationsRawBefore?.length}｜` +
    `timeline 段=${j((tlBefore.data?.timeline ?? []).map((e) => e.phase))}`)

  const rg = await command('report.generate', {})
  const rd = rg.data ?? {}
  check('report.generate 回执 code=0（report-engine generate 成功）', rg.code === 0,
    `code=${rg.code} report.code=${rd.report?.code} reportNo=${rd.report?.archive?.reportNo} ` +
    `html.len=${rd.report?.html?.length}${rg.code !== 0 ? ` message=${rg.error?.message}` : ''}`)
  check('报告规则包走"宿主读 JSON → loadPolicies(json)"（不用那个恒失败的 loadPoliciesFile）',
    rd.policies?.code === 0 && rd.policies?.entry?.includes('loadPolicies(json)') &&
    (rd.policies?.fieldCount ?? 0) > 0,
    `path=${rd.policies?.path} fields=${rd.policies?.fieldCount} groups=${rd.policies?.groupCount} ` +
    `digest=${rd.policies?.digest} namespace=${rd.policies?.namespace}`)
  check('模板来源如实写明（注入了 ITemplateSource → 用规则包模板；否则回落内置模板）',
    typeof rd.template?.source === 'string' && rd.template.source.length > 0 &&
    (rd.template.loaded === true ? rd.template.bytes > 0 : rd.template.fallback === true),
    `source=${rd.template?.source} file=${path.basename(rd.template?.file ?? '')} ` +
    `bytes=${rd.template?.bytes} templateName=${rd.template?.templateName}`)

  // ---- ④ 时间轴 durations **逐字相等** ----
  const tlAfter = await command('mission.timeline')
  check('④ 时间轴 durations 与 phase::durations() **逐字相等**（脚本另走 mission.timeline 取一次比）',
    rd.timeline?.durationsRaw === durationsRawBefore && rd.timeline?.durationsDigest === digestBefore &&
    fnv1a64(rd.timeline?.durationsRaw ?? '') === digestBefore,
    `报告 durationsRaw 长度=${rd.timeline?.durationsRaw?.length}｜mission.timeline 长度=` +
    `${durationsRawBefore?.length}｜digest 一致=${rd.timeline?.durationsDigest === digestBefore}｜` +
    `snapshotInputEqual=${rd.timeline?.snapshotInputEqual}`)
  check('④ 报告里的时间轴就是喂给引擎的那一份（snapshotInputEqual=true，且 totalMs 来自引擎）',
    rd.timeline?.snapshotInputEqual === true &&
    rd.timeline?.anchors?.totalMs === tlBefore.data?.anchors?.totalMs,
    `totalMs=${rd.timeline?.anchors?.totalMs} startedAt=${rd.timeline?.anchors?.startedAt} ` +
    `endedAtSet=${rd.timeline?.anchors?.endedAtSet}`)
  check('④ durations().totalMs=0 时**必须给出可读原因**（注入时钟是装配时刻的冻结值 → 引擎钳到 0；宿主不改引擎的数）',
    (rd.timeline?.anchors?.totalMs ?? -1) !== 0 ||
    (typeof rd.timeline?.totalMsZeroReason?.reason === 'string' &&
      rd.timeline.totalMsZeroReason.reason.length > 20 &&
      (rd.dataGaps ?? []).some((g) => g.key === 'timeline.totalMs')),
    rd.timeline?.anchors?.totalMs === 0
      ? `totalMs=0（engineClockMs=${rd.timeline?.totalMsZeroReason?.engineClockMs} < missionStartedAt=` +
        `${rd.timeline?.totalMsZeroReason?.missionStartedAt}）→ 原因：${rd.timeline?.totalMsZeroReason?.reason?.slice(0, 56)}…`
      : `totalMs=${rd.timeline?.anchors?.totalMs}（非 0，无需该说明）`)
  check('④ 时间轴**不是**宿主另算的：报告 durationSec 字段的用时口径与 durations 自洽',
    (() => {
      const sec = (rd.document?.groups ?? []).flatMap((g) => g.fields ?? [])
        .find((f) => f.key === 'durationSec')
      return !!sec && !sec.missing
    })(),
    (() => {
      const sec = (rd.document?.groups ?? []).flatMap((g) => g.fields ?? []).find((f) => f.key === 'durationSec')
      return `durationSec=${sec?.text}（口径 mission = created→generated；createdAt=${rd.timeline?.anchors?.startedAt}）`
    })())

  // ---- 预警计数来自 alert-engine ----
  check('预警计数 ← alert-engine counts()/listAlerts()（口径 basis 一并落进回执）',
    !!rd.alerts?.counts && typeof rd.alerts?.basis === 'string' &&
    rd.alerts?.basis === rd.alerts?.counts?.basis && rd.alerts?.rules?.loaded === true,
    'counts=' + j({
      alertCount: rd.alerts?.counts?.alertCount, rawRaises: rd.alerts?.counts?.rawRaises,
      openActive: rd.alerts?.counts?.openActive,
    }) + ` basis=${rd.alerts?.basis} ` +
    `规则 ${rd.alerts?.rules?.ruleCount} 条｜list.total=${rd.alerts?.list?.total}`)
  check('预警计数为 0 时**必须给出可读原因**（不是裸 0：要么没规则，要么没有观测入口）',
    (rd.alerts?.counts?.alertCount ?? -1) !== 0 || (typeof rd.alerts?.note === 'string' && rd.alerts.note.length > 10),
    `${rd.alerts?.counts?.alertCount === 0 ? rd.alerts?.note : '（计数非 0）'}`)

  // ---- 台账汇总（目标/平台）----
  const led = rd.ledger ?? {}
  check('台账汇总 ← entity-ledger（目标逐条含状态与处置档、平台逐台）',
    (led.targets ?? []).length > 0 && (led.platforms ?? []).length > 0 && led.targetsFound === led.targets.length,
    `targets=${(led.targets ?? []).length} platforms=${(led.platforms ?? []).length} ` +
    `handledTotal=${led.handledTotal}｜例：${j((led.targets ?? []).find((t) => t.id === targetEntityId))}`)
  const hitRow = (led.targets ?? []).find((t) => t.id === targetEntityId)
  check('被打击的那个目标在报告台账里 = destroyed + 处置档来自规则包词表（不是宿主写死的中文）',
    hitRow?.state === 'destroyed' && typeof hitRow?.result === 'string' && hitRow.result.length > 0 &&
    hitRow?.handled === true,
    `state=${hitRow?.state} stateName=${hitRow?.stateName} result=${hitRow?.result} handled=${hitRow?.handled}｜` +
    `档位规则=${j((led.gradeRules ?? [])[0]?.rule)?.slice(0, 60)}…`)
  check('报告文档结构与台账自洽（damage 分组：被摧毁数 = 处置档=d destroyed 的条数，脚本独立数一遍）',
    (() => {
      const fields = (rd.document?.groups ?? []).flatMap((g) => g.fields ?? [])
      const destroyed = fields.find((f) => f.key === 'destroyed')
      const mine = (led.targets ?? []).filter((t) => t.result === '已摧毁').length
      return !!destroyed && Number(destroyed.text) === mine
    })(),
    (() => {
      const fields = (rd.document?.groups ?? []).flatMap((g) => g.fields ?? [])
      const g = (k) => fields.find((f) => f.key === k)
      return `被摧毁=${g('destroyed')?.text} 总体毁伤率=${g('damageRate')?.text} 目标总数=${g('targetTotal')?.text}`
    })())

  // ---- ⑤ 留存层无数据 + 可读原因 ----
  const ret = rd.retention ?? {}
  const retGap = (rd.dataGaps ?? []).find((g) => g.key === 'retention.replay')
  const snapRet = rd.snapshotRoot?.extra?.retention
  console.log(`  · **留存层读数原样**：rows=${ret.rows} gaps=${(ret.gaps ?? []).length} ` +
    `appendCallers=${ret.appendCallers} status.appended=${ret.status?.appended} ` +
    `status.persisted=${ret.status?.persisted}`)
  check('⑤ 留存层无数据时报告里**带可读原因**（三处都在：retention.note / dataGaps / 快照 extra）',
    ret.rows === 0 && typeof ret.note === 'string' && ret.note.length > 20 &&
    ret.note.includes('append') && !!retGap && (retGap.reason ?? '').length > 20 &&
    typeof snapRet?.note === 'string' && snapRet.note.length > 20,
    `retention.note=${ret.note?.slice(0, 74)}…｜dataGaps[retention.replay].reason 长度=${retGap?.reason?.length}` +
    `｜快照 extra.retention.note 长度=${snapRet?.note?.length}`)
  check('⑤ 回放/统计段 MUST NOT 用空数组了事：查询结果与状态一并给出（rows/scanned/backend 都是真读数）',
    !!ret.query && ret.query.rows?.length === 0 && ret.query.rejected === false &&
    typeof ret.status?.backend === 'string',
    'query=' + j({
      rows: ret.query?.rows?.length, scanned: ret.query?.scanned,
      rejected: ret.query?.rejected, hasMore: ret.query?.hasMore,
    }) + `｜backend=${ret.status?.backend} buffered=${ret.status?.buffered}`)

  // ---- 报告里其它留空处也必须有解释（missing ↔ dataGaps/warnings 一一对得上）----
  const missing = rd.report?.missing ?? []
  const warnings = rd.report?.warnings ?? []
  const unexplained = missing.filter((k) => {
    const byGap = (rd.dataGaps ?? []).some((g) => (g.key ?? '').split('.').pop() === k ||
      (g.key ?? '').includes(k))
    const byWarn = warnings.some((w) => w.includes(k) && w.includes('missing'))
    return !byGap && !byWarn
  })
  check('留空项都能被解释（每个 report.missing 都能在 dataGaps 或引擎 warnings 里找到原因）',
    unexplained.length === 0,
    `missing=${j(missing)}｜未被解释=${j(unexplained)}｜dataGaps=${(rd.dataGaps ?? []).length} 条`)
  console.log('  · **报告分组原样**（字段=值，缺=引擎的缺失标记）：')
  for (const g of rd.document?.groups ?? []) {
    console.log(`      ${g.key}｜${(g.fields ?? []).map((f) => `${f.key}=${f.text}${f.missing ? '(缺)' : ''}`).join('，')}`)
  }
  console.log(`  · **报告编号/归档**：reportNo=${rd.report?.archive?.reportNo} ` +
    `fileName=${rd.report?.archive?.fileName} generatedAt=${rd.report?.archive?.generatedAt} ` +
    `schemaVersion=${rd.report?.archive?.schemaVersion}｜渲染=${rd.report?.renderFormat} ok=${rd.report?.renderOk}`)
  console.log(`  · **dataGaps（留空 + 点名）**：`)
  for (const g of rd.dataGaps ?? []) console.log(`      ${g.key} ← ${g.engine}：${g.reason}`)

  // ---- 步 11 ----
  check('report.generate 把流程落到步 11 / 阶段 T7',
    rd.step === 11 && rd.phase === 'T7' && rd.stepKey === 'summary',
    `step=${rd.step} stepKey=${rd.stepKey} phase=${rd.phase} advance.code=${rd.advance?.code} ` +
    `forced=${rd.advance?.forced}`)
  const st11 = await getState()
  check('/api/state 里也带一份（report.available + exec.records + timeline，前端挂载即可画步 10/11）',
    st11.step === 11 && st11.report?.available === true && (st11.exec?.records ?? []).length > 0 &&
    st11.exec?.diveApplied >= 1 && typeof st11.timeline?.durationsRaw === 'string',
    `step=${st11.step} report.available=${st11.report?.available} exec.records=${(st11.exec?.records ?? []).length} ` +
    `diveApplied=${st11.exec?.diveApplied}｜exec[0]=${j((st11.exec?.records ?? [])[0])}`)

  // ============================================================== 6) mission.advance{to:"T6"} 的步 10 语义
  //
  // P5 的实测是 `strike.confirm` 不自动推进；本波要求 `exec.run` / `mission.advance{to:"T6"}` 都能进
  // 步 10。上面验了 exec.run；这里用**新任务**单独验 mission.advance（force 越过阶段图是流程步进，
  // 回执里原样给出）。
  await command('mission.reset')
  const enter2 = await command('flow.enter')
  const advT6 = await command('mission.advance', { to: 'T6', force: true })
  check('mission.advance{to:"T6"} → 步 10（stepKey=guidance，回执里带 step）',
    advT6.code === 0 && advT6.data?.step === 10 && advT6.data?.stepKey === 'guidance',
    `code=${advT6.code} step=${advT6.data?.step} stepKey=${advT6.data?.stepKey} phase=${advT6.data?.phase} ` +
    `missionId=${enter2.data?.missionId} forced=force`)

  // ============================================================== 7) 真页面（1280×800）
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
  // 步 10–11 的前端屏由另一个 agent 施工：这里只软校验"页面跟着宿主走"，不把交付押在它身上
  if (stPage) {
    check('页面跟着宿主走（步 10/11：step/phase 由 flow.state 驱动）', stPage.step >= 10,
      `step=${stPage.step} stepKey=${stPage.stepKey} phase=${stPage.phase}`)
  } else {
    console.log('  · 页面未暴露 __flowStats（步 10–11 前端由另一 agent 施工）→ 本项不判失败，只截图')
  }
  const s = await shot('p6-1-guidance.png')
  if (s) console.log(`  · 截图：${s}`)

  events.close()
  console.log(`\n[p6] 通过 ${pass} / 失败 ${fail}`)
  console.log(fail === 0
    ? '[p6] PASS：exec.run（动作+前置 Gate → struck/destroyed + target.state → 俯冲剖面与**读数派生**命中（可独立复算） → 步 10）' +
      ' / exec.abort（能退就退、不能退如实 1003） / report.generate（规则包+模板+逐字时间轴+预警计数+台账汇总+留存层留空带原因 → 步 11）全链路真机通过'
    : '[p6] FAIL：见上表（脚本不掩盖任何一条）')
} catch (e) {
  console.error('[p6] 异常：', e.message)
  fail++
} finally {
  try { ws?.close() } catch { /* 忽略 */ }
  chrome.kill()
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

process.exit(fail === 0 ? 0 : 1)
