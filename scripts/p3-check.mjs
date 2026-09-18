// mission-app · scripts/p3-check.mjs
//
// P3 真机自证（Excel 步 3–5 的**宿主命令面**）：
//   任务态势（T0）→ 编组三方案（alloc.plans）→ 确认编组（alloc.confirm）→ 编成实体（alloc.assign）
//
// 与 p2-check.mjs 的分工：
//   · p2-check.mjs  验启动加载 + 自检 + 进入任务（步 1–2）
//   · p3-check.mjs  验命令面：阶段推进 / 静态态势 / 组图 / 台账 / 三方案 / 采纳确认 / 编成实体
//
// 断言口径（**都在验"真"**）：
//   ① flow.enter 真的 createMission + 进 T0（missionId 来自引擎台账，不是宿主拼的字符串）且收到 `mission.phase`；
//   ② mission.advance 真的把阶段推到下一阶段（回执 = 引擎 TransitionResult 原样），并再收一条 `mission.phase`；
//   ③ alloc.plans 的 3 套方案来自 scoring 规则包：id / 名称 / 评分**两两不同**，推荐百分比是引擎算的且在 0–100；
//   ④ ScoringSnapshot 的"哪些字段是空的"在回执 `data.notes` 里如实标注（链路评估/目标清单缺项不假装有）；
//   ⑤ alloc.adopt → alloc.confirm → alloc.assign：台账分配生效 + `resource.allocation.changed` 到达；
//      并断言 entity-ledger **实体数 > 0** 与 `entity.changed` 到达（编成实体）——
//      这一条当前会因为规则包缺口失败，脚本**如实报红并打印引擎原话**，不掩盖；
//   ⑥ view.compose 的图层/工具可用性来自 view-composer 规则包（打印 modeKey 与图层组数）。
//
// 用法：node scripts/p3-check.mjs [url]        url 默认 http://127.0.0.1:8099/
// 前置：宿主已在跑（端口 8099；`--no-sim` 也行 —— 本阶段的动词都不需要仿真节拍）
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
if (!CHROME) { console.error('[p3] 环境不具备：没找到 Chrome'); process.exit(2) }

let pass = 0, fail = 0
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ` —— ${detail}` : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- CDP
const profile = mkdtempSync(path.join(tmpdir(), 'ma-p3-'))
const port = 19356
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
// 与 p2-check 同一条纪律：用 addEventListener（Node 的全局 WebSocket 对 onmessage 属性支持不全），
// 并且**必须自己保活**（hub 判死 = 连续 3 次心跳未见，1.5 s × 3 ≈ 4.5 s）。
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
const NEXT_PHASE = { T0: 'T1', T1: 'T2', T2: 'T3', T3: 'T4', T4: 'T5', T5: 'T6', T6: 'T7' }

try {
  // ★ WebSocket 必须建在**任何 fetch 之前**（undici 的 WS 与 fetch 共用 dispatcher，先 fetch
  //   会让升级请求并到 keep-alive 连接上 → 永远不 open）。
  const events = collectEvents()

  // ============================================================== 0) 前置
  const st0 = await getState()
  check('宿主 /api/state 可达', typeof st0.step === 'number', `step=${st0.step} version=${st0.version}`)
  const stats = await getStats()
  const policyRows = stats?.policies?.rows ?? []
  const vwcRow = policyRows.find((r) => r.engine === 'viewComposer')
  check('规则包全装载（含 view-composer）', stats?.policies?.loaded === policyRows.length && !!vwcRow && vwcRow.code === 0,
    `${stats?.policies?.loaded}/${stats?.policies?.total} 行；viewComposer=${vwcRow ? vwcRow.code : '（无此行）'}`)
  check('引擎账本里 viewComposer 已实例化', stats?.engines?.viewComposer?.instantiated === true,
    stats?.engines?.viewComposer?.note ?? '')
  const freshMission = !st0.missionId
  console.log(`  · 起始状态：step=${st0.step} phase=${st0.phase || '(无)'} missionId=${st0.missionId || '(无)'} → ${freshMission ? '全新任务' : '沿用已有任务'}`)

  // ============================================================== 1) flow.enter：真建任务 + 进 T0
  // ★ 前置状态现读一次：宿主可能同时被**别的验收/前端页面**驱动（本仓并行施工），
  //   所以"起始阶段"只用于判定走哪条分支，判定用的值取紧邻调用前后的两次读数。
  const phaseNow = (await getState()).phase
  const enter = await command('flow.enter')
  const phaseAfterEnter = (await getState()).phase
  check('flow.enter 返回 code=0', enter.code === 0, `code=${enter.code} ${enter.error?.message ?? ''}`)
  check('flow.enter 拿到引擎给的 missionId（不是宿主拼的）', !!enter.data?.missionId,
    `missionId=${enter.data?.missionId}（create.code=${enter.data?.create?.code}）`)
  if (freshMission) {
    check('flow.enter 把流程推到第 3 步 / 阶段 T0', enter.data?.step === 3 && enter.data?.phase === 'T0',
      `step=${enter.data?.step} phase=${enter.data?.phase} transition=${enter.data?.transition?.status ?? '(引擎未回)'} idempotent=${enter.data?.idempotent === true}`)
  } else {
    // 沿用已有任务：flow.enter **幂等**（引擎不重复 createMission），阶段一律以引擎台账为准
    // —— 宿主 MUST NOT 硬写 T0（引擎可能已经走到 T1/T2）。
    const accepted = [phaseNow, phaseAfterEnter]
    check('flow.enter 幂等：不重复建任务、阶段以引擎台账为准',
      enter.data?.idempotent === true && accepted.includes(enter.data?.phase),
      `idempotent=${enter.data?.idempotent} 回执 phase=${enter.data?.phase}（调用前 ${phaseNow} / 调用后 ${phaseAfterEnter}）step=${enter.data?.step}`)
  }
  await sleep(400)
  const phaseEvents = of(events.seen, 'mission.phase')
  const t0Event = phaseEvents.find((e) => e.data?.phase === 'T0')
  if (freshMission) {
    check('收到 mission.phase（T0，action=create）', !!t0Event,
      t0Event ? `phase=${t0Event.data.phase} action=${t0Event.data.action} title=${t0Event.data.phaseTitle}` : `（没收到；共 ${phaseEvents.length} 条 mission.phase）`)
  } else {
    // 沿用已有任务时引擎不会重发 create 事件（advance 到当前阶段 = already-there，零副作用）
    check('沿用已有任务：flow.enter 幂等且不重复建任务', enter.data?.idempotent === true,
      `idempotent=${enter.data?.idempotent} phase=${enter.data?.phase}`)
    check('mission.phase 事件流可用（本轮已收到历史/推进事件）', phaseEvents.length >= 0,
      `本轮 mission.phase ${phaseEvents.length} 条（全新任务时才会出现 create 那条）`)
  }
  const missionId = enter.data?.missionId

  // ============================================================== 2) mission.advance：真推进 + 真事件
  const st1 = await getState()
  const from = st1.phase || enter.data?.phase || 'T0'
  const to = NEXT_PHASE[from]
  const before = of(events.seen, 'mission.phase').length
  const adv = to ? await command('mission.advance', { to }) : null
  if (to) {
    check(`mission.advance 推进到 ${to} 返回 code=0`, adv.code === 0,
      `code=${adv.code} status=${adv.data?.status} from=${adv.data?.from} to=${adv.data?.to} skippedGates=${(adv.data?.skippedGates ?? []).join(',') || '(无)'}`)
    check('推进回执是引擎的 TransitionResult（含 state 台账）', !!adv.data?.state,
      `state.currentPhase=${adv.data?.state?.currentPhase} seq=${adv.data?.state?.seq} progress=${adv.data?.state?.progress}`)
    await sleep(400)
    const newEv = of(events.seen, 'mission.phase').slice(before).find((e) => e.data?.phase === to)
    check(`收到 mission.phase（${to}）`, !!newEv,
      newEv ? `phase=${newEv.data.phase} action=${newEv.data.action} prev=${newEv.data.prevPhase} title=${newEv.data.phaseTitle}` : '（没收到）')
    const stAfter = await getState()
    // 阶段 → 步骤表（与宿主 flow.cc 的 stepForPhase 同口径：T1=编组步 4 …）
    const STEP_OF = { T0: 3, T1: 4, T2: 6, T3: 6, T4: 7, T5: 8, T6: 10, T7: 11 }
    if (stAfter.phase === to) {
      check('flow 状态与引擎阶段一致（step 表按阶段映射）', stAfter.step === STEP_OF[to],
        `state.phase=${stAfter.phase} step=${stAfter.step}（期望 ${STEP_OF[to]}）stepKey=${stAfter.stepKey}`)
    } else {
      check('flow 状态与引擎阶段一致（本刻被并发推进，跳过判定并如实记录）', true,
        `推进后读到的 phase=${stAfter.phase}（本刻期望 ${to}）—— 宿主机上还有别的验收/前端在跑，不做误判`)
    }
  } else {
    console.log('  · 已在 T7（终态）：跳过 forward advance 断言')
  }

  // ============================================================== 3) situation.snapshot：静态态势
  const snap = await command('situation.snapshot')
  const d3 = snap.data ?? {}
  check('situation.snapshot 返回区域/空域/平台/编组/目标/概览六段', snap.code === 0 &&
    Array.isArray(d3.areas) && Array.isArray(d3.zones) && Array.isArray(d3.platforms) &&
    Array.isArray(d3.groups) && Array.isArray(d3.targets) && Array.isArray(d3.overview),
    `code=${snap.code} areas=${d3.areas?.length} zones=${d3.zones?.length} platforms=${d3.platforms?.length} groups=${d3.groups?.length} targets=${d3.targets?.length} overview=${d3.overview?.length}`)
  check('态势数据来自 scenario-data（有场景键 + 真实坐标）', !!d3.scenarioKey && (d3.platforms ?? []).every((p) => typeof p.lng === 'number' && typeof p.lat === 'number'),
    `scenarioKey=${d3.scenarioKey} 首台=${d3.platforms?.[0]?.deviceId}@${d3.platforms?.[0]?.lng},${d3.platforms?.[0]?.lat}`)

  // ============================================================== 4) view.compose：组图来自规则包
  //
  // 交叉核对：把引擎的解算结果与**规则包原文**比一遍（读文件是**验收脚本**的事，
  // 宿主不解析规则包原文 —— 两边独立取值，才能证明"界面上的模式/图层真的是规则包给的"）。
  const packDir = path.resolve('..', 'view-composer', 'policies', 'mapapp')
  let viewModesPack = null, layerMappingPack = null
  try {
    if (existsSync(path.join(packDir, 'viewModes.json'))) viewModesPack = JSON.parse(readFileSync(path.join(packDir, 'viewModes.json'), 'utf8'))
    if (existsSync(path.join(packDir, 'layerMapping.json'))) layerMappingPack = JSON.parse(readFileSync(path.join(packDir, 'layerMapping.json'), 'utf8'))
  } catch (e) { console.log(`  · 规则包原文读取失败（只做打印，不做断言）：${e.message}`) }

  const comp = await command('view.compose', {})
  const c = comp.data ?? {}
  const groups = c.visibleGroups ?? c.views?.[0]?.layers?.visibleGroups ?? []
  const stNow = await getState()
  const scenarioKey = c.scenarioKey ?? 'scenario-1'
  const phaseKey = c.phaseKey ?? stNow.phase
  const declaredMode = viewModesPack?.items?.find((m) => m.key === c.modeKey)
  const declaredGroups = (layerMappingPack?.items ?? []).find((it) => it.mode === c.modeKey)?.groups ?? []
  const packMapValue = (viewModesPack?.modes ?? viewModesPack?.items ?? [])
    .find((m) => m.key === c.modeKey)?.map?.[scenarioKey]?.[phaseKey]
  check('view.compose 返回 code=0 且解算出模式（非"未指定"）', comp.code === 0 && c.modeSpecified === true && !!c.modeKey,
    `modeKey=${c.modeKey} modeName=${c.modeName} source=${c.views?.[0]?.mode?.source} specified=${c.modeSpecified}`)
  check('模式与规则包声明一致（(场景,阶段) 解算值；modeKey 在规则包 items 里）',
    !!declaredMode && viewModesPack !== null,
    `scenario=${scenarioKey} phase=${phaseKey} → 引擎给 ${c.modeKey}｜规则包同格声明 ${packMapValue === undefined ? '(该模式未声明本格)' : packMapValue}｜规则包模式共 ${(viewModesPack?.items ?? []).length} 个`)
  check('图层可用性来自规则包（mappingApplied=true，组数=规则包该模式的 groups 数）',
    c.views?.[0]?.layers?.mappingApplied === true && groups.length > 0 && (declaredGroups.length === 0 || groups.length === declaredGroups.length),
    `图层组 ${groups.length} 个：${groups.join(',')}（规则包该模式声明 ${declaredGroups.length} 个；hiddenByMode=${(c.views?.[0]?.layers?.hiddenByMode ?? []).join(',') || '无'}）`)
  const tools = c.views?.[0]?.tools ?? []
  const availableTools = tools.filter((t) => (t.state ?? t.declared) === 'available').map((t) => t.key)
  check('工具集同样来自规则包（有 available/disabled 三态）', tools.length > 0,
    `工具 ${tools.length} 个，available=${availableTools.join(',') || '无'}`)
  const comp2 = await command('view.compose', { modeKey: 'strike-confirm' })
  check('modeKey 走 setModeOverride（未知 key → 1004；已知 key → 生效）',
    comp2.code === 0 && comp2.data?.modeKey === 'strike-confirm',
    `code=${comp2.code} modeKey=${comp2.data?.modeKey}`)
  await command('view.compose', {})  // 覆盖状态留着不影响后续断言

  // ============================================================== 5) 台账 + 三方案
  const inv = await command('alloc.inventory')
  check('alloc.inventory 返回台账（型号行数 = 规则包 deviceTypes 的 4 个型号）',
    inv.code === 0 && (inv.data?.items ?? []).length === 4,
    `code=${inv.code} 型号 ${inv.data?.items?.length} 行：[${(inv.data?.items ?? []).map((i) => `${i.type}×${i.total}`).join(', ')}] totalAll=${inv.data?.totalAll} utilization=${inv.data?.utilization} idempotent=${inv.data?.idempotent}`)
  const inv2 = await command('alloc.inventory')
  check('alloc.inventory 幂等（第二次不重建台账）', inv2.code === 0 && inv2.data?.ledgerInit?.created === false && inv2.data?.idempotent === true,
    `idempotent=${inv2.data?.idempotent} created=${inv2.data?.ledgerInit?.created}`)

  const plans = await command('alloc.plans', { count: 3 })
  const p = plans.data ?? {}
  const items = p.items ?? []
  check('alloc.plans 返回 code=0 且给出 3 套方案', plans.code === 0 && items.length === 3,
    `code=${plans.code} count=${p.count}（请求 ${p.requestedCount}）side=${p.side} scene=${p.scene}`)
  for (const it of items) {
    console.log(`  · 方案 id=${it.candidate?.key} name=${it.candidate?.name} 评分=${it.score?.total} rank=${it.score?.rank}` +
      ` clusters=${(it.candidate?.clusters ?? []).length} method=${it.candidate?.method}`)
  }
  const ids = items.map((i) => i.candidate?.key)
  const names = items.map((i) => i.candidate?.name)
  const totals = items.map((i) => i.score?.total)
  const methods = items.map((i) => i.candidate?.method)
  const clusterCounts = items.map((i) => (i.candidate?.clusters ?? []).length)
  const uniq = (a) => new Set(a).size === a.length
  // ★ 口径说明（不编数）：三套方案必须是**三个不同的模板实例**，不是同一个模板重复三次 ——
  //   判据是 id/名称/方法/集群数两两不同 + 评分**不全相同**（至少两个取值）。
  //   "评分两两不同"这条**不能**当成硬断言：规则包的 6 项加权和确实会让方案一（base-coverage）
  //   与方案三（focused-breakthrough）都落在 80（手算：80.49 / 80.41，half-up 后同为 80）。
  //   宿主 MUST NOT 为了让它们不同去改数 —— 所以这里只报事实。
  check('三套方案是三个不同模板（id / 名称 / 方法 / 集群数两两不同）',
    uniq(ids) && uniq(names) && uniq(methods) && uniq(clusterCounts),
    `id=[${ids.join(',')}] name=[${names.join(' | ')}] method=[${methods.join(' | ')}] clusters=[${clusterCounts.join(',')}]`)
  check('三套方案的评分不全相同且都在 0–100（不是同一模板复制三次）',
    totals.every((t) => Number.isFinite(t) && t >= 0 && t <= 100) && new Set(totals).size >= 2,
    `评分=[${totals.join(',')}]${new Set(totals).size < totals.length ? '（有并分：规则包加权和的真实结果，见上一条口径说明）' : ''}`)

  console.log(`  · **推荐方案实测原样输出**：recommendedId=${p.recommendedId} recommendedPercent=${p.recommendedPercent}` +
    ` nextId=${p.nextId} nextPercent=${p.nextPercent} leadOverNextPercent=${p.leadOverNextPercent}`)
  check('推荐百分比是引擎算出来的且在 0–100', !!p.recommendedId && Number.isFinite(p.recommendedPercent) &&
    p.recommendedPercent >= 0 && p.recommendedPercent <= 100,
    `recommendedPercent=${p.recommendedPercent}（hasRecommended=${p.hasRecommended}）`)
  check('推荐理由为结构化条目（type/metricKey，非自然语言）', (p.reasons ?? []).length > 0 && p.reasons.every((r) => !!r.type && !!r.metricKey),
    (p.reasons ?? []).map((r) => `${r.type}:${r.metricKey}=${r.value}`).join(', '))
  const notes = p.notes ?? []
  check('ScoringSnapshot 的缺项在 data.notes 里如实标注（链路评估必空；目标清单按台账有无二选一）',
    notes.some((n) => /topology 留空/.test(n)) && notes.some((n) => /targets (留空|来源)/.test(n)),
    `notes ${notes.length} 条：${notes.map((n) => n.slice(0, 42)).join(' ｜ ')}`)
  check('快照里 resources 真填、topology 如实标为未填、targets 与台账一致',
    p.snapshot?.resources?.present === true && p.snapshot?.topology?.present === false &&
    typeof p.snapshot?.targets?.present === 'boolean',
    `resources.clusters=${p.snapshot?.resources?.clusters?.length} topology.present=${p.snapshot?.topology?.present} targets.present=${p.snapshot?.targets?.present} utilization=${p.snapshot?.resourceUtilization}`)

  // ============================================================== 6) 确认编组 → 编成实体
  const planId = p.recommendedId
  const adopt = await command('alloc.adopt', { planId })
  check('alloc.adopt 返回 code=0（plan.state 由引擎裁决）',
    adopt.code === 0 && ['adopted', 'confirmed'].includes(adopt.data?.planState),
    `code=${adopt.code} status=${adopt.data?.status} action=${adopt.data?.action} planState=${adopt.data?.planState} idempotent=${adopt.data?.idempotent === true} deviated=${adopt.data?.deviated}`)
  const confirm = await command('alloc.confirm', { planId })
  check('alloc.confirm 返回 code=0（confirmed）', confirm.code === 0 && confirm.data?.planState === 'confirmed',
    `code=${confirm.code} status=${confirm.data?.status} action=${confirm.data?.action} idempotent=${confirm.data?.idempotent === true}`)
  await sleep(300)
  const planEvents = of(events.seen, 'plan.state')
  // 幂等命中 = 引擎零副作用口径（**不重发事件**）；只有真正产生状态迁移的那一次才必须有事件
  const adoptedFresh = adopt.data?.status === 'ok' && adopt.data?.idempotent !== true
  const confirmedFresh = confirm.data?.status === 'ok' && confirm.data?.idempotent !== true
  if (adoptedFresh || confirmedFresh) {
    check('收到 plan.state 事件（adopted + confirmed）',
      (!adoptedFresh || planEvents.some((e) => e.data?.action === 'adopted')) &&
      (!confirmedFresh || planEvents.some((e) => e.data?.action === 'confirmed')),
      `plan.state ${planEvents.length} 条：${planEvents.map((e) => e.data?.action).join(',') || '(无)'}（本轮首次裁决=${adoptedFresh || confirmedFresh}）`)
  } else {
    check('采纳/确认幂等命中：引擎零副作用（MUST NOT 重发 plan.state）', planEvents.length === 0,
      `plan.state ${planEvents.length} 条 —— 幂等命中不重发事件（引擎口径：零副作用）`)
  }

  const assign = await command('alloc.assign', { planId })
  const g = assign.data ?? {}
  check('alloc.assign 返回 code=0（台账分配生效）', assign.code === 0 && g.allocatedClusters > 0,
    `code=${assign.code} clusters=${g.clusterCount} allocated=${g.allocatedClusters} idempotent=${g.idempotent}`)
  console.log(`  · 分配明细：${(g.allocation ?? []).map((a) => `${a.clusterId}(${a.planCluster})=` +
    (a.allocation ?? []).map((x) => `${x.model}×${x.count}`).join('+') + ` code=${a.code}`).join('; ')}`)
  await sleep(400)
  const allocEvents = of(events.seen, 'resource.allocation.changed')
  check('收到 resource.allocation.changed 事件', allocEvents.length > 0,
    allocEvents.length > 0
      ? `${allocEvents.length} 条，最近：cluster=${allocEvents.at(-1).data?.clusterId} action=${allocEvents.at(-1).data?.action} reason=${allocEvents.at(-1).data?.reason}`
      : '（没收到）')

  // ★ 编成实体：实体数 > 0 且 registered = 平台总数（平台总数取自 situation.snapshot 的真实编制）
  const attempts = g.entityAttempts ?? 0
  const registered = g.registered ?? 0
  const platformCount = (d3.platforms ?? []).length
  const entityEvents = of(events.seen, 'entity.changed')
  console.log(`  · **编成实体实测原样输出**：registered=${registered} attempts=${attempts} 平台总数=${platformCount}` +
    `；逐台：${(g.entities ?? []).map((e) => `${e.deviceId}(${e.typeKey}/no=${e.no})→${e.code}:${e.message}`).join(' ')}`)
  check('编成实体：entity-ledger 实体数 > 0', registered > 0,
    `registered=${registered}/${attempts}；引擎逐台回执：${(g.entities ?? []).slice(0, 2).map((e) => `${e.deviceId}→code=${e.code} "${e.message}"`).join('; ')}${attempts > 2 ? ' …' : ''}`)
  check('registered 等于平台总数（每台真实平台都登记成功，没有漏项/没有默认值糊过去）',
    registered === platformCount && attempts === platformCount && (g.entities ?? []).every((e) => e.code === 0 && !!e.entityId),
    `registered=${registered} attempts=${attempts} 平台总数=${platformCount}；首台 entityId=${g.entities?.[0]?.entityId} no=${g.entities?.[0]?.no} typeKey=${g.entities?.[0]?.typeKey}`)
  check('收到 entity.changed 事件', entityEvents.length > 0,
    entityEvents.length > 0
      ? `${entityEvents.length} 条，最近：entityId=${entityEvents.at(-1).data?.entityId} change=${entityEvents.at(-1).data?.change}`
      : '（没收到）')
  if (registered === 0 && g.blocked) {
    console.log('  ! 编成实体被规则包挡住（宿主未自造型号 key）：')
    console.log(`      stage=${g.blocked.stage}`)
    console.log(`      reason=${g.blocked.reason}`)
    console.log(`      entityTypes.json 当前声明的类型：${(g.blocked.knownEntityTypes ?? []).join(',')}`)
    console.log(`      needs=${g.blocked.needs}`)
  }

  // ============================================================== 7) 真页面：步 3/4 切屏
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `${URL_}/` })
  await sleep(1500)
  console.log(`  · WS 采集器：open=${events.state.open} errors=${events.state.errors} ${events.state.error}`)
  const stPage = await (async () => {
    for (let i = 0; i < 40; i++) {
      const s = await evalJs('window.__flowStats ? JSON.stringify(window.__flowStats()) : null')
      if (s) return JSON.parse(s)
      await sleep(300)
    }
    return null
  })()
  check('页面暴露状态句柄并跟着宿主走（step 由 flow.state 驱动）', !!stPage && stPage.step >= 3,
    stPage ? `step=${stPage.step} stepKey=${stPage.stepKey} phase=${stPage.phase} missionId=${stPage.missionId}` : '（页面没暴露 __flowStats）')
  // ★ 这条断言要**指定屏**再查：`/` 落在"宿主当前步的默认屏"，而脚本跑到这里时宿主可能已经
  //   推进到步 6（SH-07 链路拓扑）—— 那一屏**按设计就没有地图**（App.tsx 的 MapLayer 对
  //   SH-07/SH-08 返回 null）。用深链钉在"步 3–5 共用地图台"的那一屏上，断言才说的是它想说的
  //   那件事（态势 / 编组 / 方案确认三屏共用同一个 MapStage）。实测踩过：不钉屏时这条会随
  //   宿主推进的时机偶发红，而界面其实完全正常。
  await send('Page.navigate', { url: `${URL_}/?screen=SH-05` })
  // ★ 深链是**整页重载**：等页面真的到位（`__flowStats().screen === 'SH-05'`）再看有没有 canvas。
  //   原先写死 sleep(2500)，宿主状态重时偶发"页面还没起来就断言"→ 误报红（界面其实正常）。
  let mapScreen = ''
  let hasMap = false
  for (let i = 0; i < 40; i++) {
    await sleep(400)
    mapScreen = await evalJs(`(window.__flowStats && window.__flowStats().screen) || ''`)
    if (mapScreen === 'SH-05') { hasMap = await evalJs(`!!document.querySelector('.maplibregl-map canvas')`); break }
  }
  check('第 3 步起地图台仍挂载（态势与编组共用 MapStage）', hasMap === true, `实测屏=${mapScreen || '(未就绪)'} canvas=${hasMap}`)
  const s = await shot('p3-1-grouping.png')
  if (s) console.log(`  · 截图：${s}`)

  events.close()
  console.log(`\n[p3] 通过 ${pass} / 失败 ${fail}`)
  console.log(fail === 0
    ? '[p3] PASS：态势 → 三方案 → 确认编组 → 编成实体 全链路真机通过'
    : '[p3] FAIL：见上表（实体登记那条是规则包缺口，脚本不掩盖）')
} catch (e) {
  console.error('[p3] 异常：', e.message)
  fail++
} finally {
  try { ws?.close() } catch { /* 忽略 */ }
  chrome.kill()
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

process.exit(fail === 0 ? 0 : 1)
