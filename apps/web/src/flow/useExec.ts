// mission-app · apps/web/src/flow/useExec.ts
//
// 步 10（协同执行与引导）与步 11（任务总结）的**数据层**：只做"取字段 + 归类"，
// 不产生任何数值、不判命中、不补时刻、不合成百分比。
//
// 与 `useOps.ts` / `useStrike.ts` 同一套路（读得懂就用，读不到就 undefined → 界面显示"—/未就绪"）：
//   ① `readExecReceipt()`  —— `exec.run` / `exec.abort` 的回执（**逐条叶子字段**都读出来，含 `basis`）
//   ② `readTargetState()`  —— `target.state` 事件（引擎的命中/状态迁移事实；前端不自己判）
//   ③ `readDurations()`    —— phase-engine 的逐阶段耗时（**逐段显示，前端不自己算**）
//   ④ `readReport()`       —— `report.generate` 的文档（分组 + 字段 + 缺失语义 + 溯源）
//   ⑤ `readAlertCounts()`  —— alert-engine 的计数（原样显示；一个数都不换算）
//
// ⚠ 实测状态（写下这份代码时宿主侧 `exec.run` / `exec.abort` / `report.generate` 三条 verb
//   还回 `code=1000 未知 verb`）：字段名一律**防御式**读取（同一语义试多个别名），
//   这样宿主补上实现后前端零改动；对不上的部分不会显示错值，而是显示"未就绪 + code + 原话"。
import type { CommandReply } from '../api'

type J = Record<string, unknown>

/** 是"能当对象读"的值（排除 null 与数组）。 */
function isObj(v: unknown): v is J {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** 依次试多个字段名，返回第一个"存在且不是 null/undefined"的值。 */
function pick(v: unknown, ...keys: string[]): unknown {
  if (!isObj(v)) return undefined
  for (const k of keys) {
    const c = v[k]
    if (c !== undefined && c !== null && c !== '') return c
  }
  return undefined
}

/** 取字符串（数字/布尔也转成串；对象与数组不转，免得显示成 `[object Object]`）。 */
function str(v: unknown, ...keys: string[]): string | undefined {
  const x = pick(v, ...keys)
  if (typeof x === 'string') return x
  if (typeof x === 'number' || typeof x === 'boolean') return String(x)
  return undefined
}

/** 取数值。**只认宿主给的数**（字符串数字也收），其余 undefined —— 界面据此显示"—"，不补 0。 */
function num(v: unknown, ...keys: string[]): number | undefined {
  const x = pick(v, ...keys)
  if (typeof x === 'number' && Number.isFinite(x)) return x
  if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x))) return Number(x)
  return undefined
}

function arr(v: unknown, ...keys: string[]): unknown[] {
  const x = keys.length ? pick(v, ...keys) : v
  return Array.isArray(x) ? x : []
}

/** 取"字符串数组"。 */
function strList(v: unknown, ...keys: string[]): string[] {
  const x = pick(v, ...keys)
  if (!Array.isArray(x)) return []
  const out: string[] = []
  for (const it of x) {
    if (typeof it === 'string' && it) out.push(it)
    else if (typeof it === 'number') out.push(String(it))
    else if (isObj(it)) {
      const t = str(it, 'text', 'label', 'name', 'reason', 'detail', 'message')
      if (t) out.push(t)
    }
  }
  return out
}

/** 一条「路径 = 值」叶子（回执里所有标量都摊平成这个形状，用来"逐条照抄"）。 */
export interface Leaf { path: string; value: string }

/**
 * 把任意 JSON 摊平成 `a.b[0].c = v` 的叶子表（深度/条数有界）。
 *
 * 为什么需要它：契约要求回执**逐条显示**并且"拿不到的字段如实写未就绪"。
 * 用摊平表就**不需要猜宿主给了什么字段名**：给什么就照抄什么，一条不漏；
 * 同时顶层已识别的字段（id/verdict/basis…）再单独认一遍，用于面板标题行。
 */
function flatten(v: unknown, prefix = '', out: Leaf[] = [], depth = 0): Leaf[] {
  if (out.length >= 48 || depth > 4) return out
  if (v === null || v === undefined) return out
  if (Array.isArray(v)) {
    v.slice(0, 12).forEach((it, i) => {
      if (isObj(it) || Array.isArray(it)) flatten(it, `${prefix}[${i}]`, out, depth + 1)
      else out.push({ path: `${prefix}[${i}]`, value: scalarText(it) })
    })
    return out
  }
  if (isObj(v)) {
    for (const [k, val] of Object.entries(v)) {
      if (out.length >= 48) break
      const p = prefix ? `${prefix}.${k}` : k
      if (isObj(val) || Array.isArray(val)) flatten(val, p, out, depth + 1)
      else out.push({ path: p, value: scalarText(val) })
    }
    return out
  }
  out.push({ path: prefix || 'value', value: scalarText(v) })
  return out
}

function scalarText(v: unknown): string {
  if (v === null) return 'null'
  if (v === undefined) return '—'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') return v
  try { return JSON.stringify(v) } catch { return String(v) }
}

// ============================================================================
// ① 执行回执（`exec.run{entityId}` / `exec.abort{entityId}`）
// ============================================================================

/**
 * 「判据」：回执里"凭什么这么判"的那句话。
 *
 * 实测宿主在别的 verb 上有三种写法：`basis: "…"`（字符串）、
 * `basis: {formula,inputs,source}`（对象，见 `guidance.plan` 的时间轴）、
 * 以及 `reason` / `verdict` / `message`。这里按顺序找一句，找不到就**不编**。
 * 返回的 `key` 是**命中哪个字段名**（界面把它一并显示出来，便于对账）。
 */
function readBasis(src: unknown): { text?: string; key?: string; inputs: Leaf[] } {
  if (!isObj(src)) return { inputs: [] }
  for (const k of ['basis', 'criterion', 'rationale']) {
    const b = src[k]
    if (typeof b === 'string' && b) return { text: b, key: k, inputs: [] }
    if (isObj(b)) {
      const formula = str(b, 'formula', 'text', 'expr')
      const source = str(b, 'source', 'note')
      const inputs = flatten(pick(b, 'inputs') ?? {}, '', [], 0)
      const text = [formula, source].filter(Boolean).join('　·　')
      return { text: text || JSON.stringify(b), key: k, inputs }
    }
  }
  for (const k of ['verdict', 'reason', 'message', 'detail', 'note', 'explain']) {
    const t = str(src, k)
    if (t) return { text: t, key: k, inputs: [] }
  }
  return { inputs: [] }
}

/** `exec.run` / `exec.abort` 的回执视图（**原样照抄**；读不到就是 undefined）。 */
export interface ExecReceiptView {
  /** 原始 data（界面的"原文"折叠区用它，字段再变也藏不住） */
  raw: unknown
  entityId?: string
  /** 命中后的动态状态（引擎 `dynamicStates` 的 key，如 `struck` / `destroyed`） */
  dynamicState?: string
  /** 该状态的中文名 —— **只有宿主给了才显示**（见 `dynamicStateName`） */
  dynamicStateName?: string
  /** 迁移的起点（引擎给就显示） */
  from?: string
  /** 台账里的状态色域（规则包 `bands[].state`：red/yellow/gray） */
  status?: string
  threat?: string
  confidence?: number
  /** 动作键（`exec.run` → 引擎的动作 key；宿主给就显示） */
  action?: string
  idempotent?: boolean
  /** 判据（见 `readBasis`）/ 命中哪个字段名 */
  basis?: string
  basisKey?: string
  basisInputs: Leaf[]
  /** 顶层已识别的字段之外，回执里**所有**标量叶子（逐条显示，不猜字段名） */
  leaves: Leaf[]
  /** 回执里被引擎接受/忽略/未满足的东西（有就显示） */
  unmet: string[]
  skipped: string[]
  /** 宿主给的一句话（`message`/`detail`） */
  message?: string
  notes: string[]
}

export function readExecReceipt(data: unknown): ExecReceiptView {
  // 实测（2026-09-16，宿主 `exec.run` 装配后）：
  // ```json
  // {"entityId":"ent-…-000001","stateBefore":"briefStop","stateAfter":"struck",
  //  "entity":{…,"dynamicState":"struck","status":"gray","threatBand":"low",…},
  //  "stateTransitions":[{"to":"struck","code":0,"data":{"changes":[{"field":"dynamicState",
  //      "from":"briefStop","to":"struck"}],"state":{…},"engineEntry":"…setDynamicState"}}],
  //  "actions":[{…applyAction 回执…}],"prerequisites":[…],"declaredAction":{…},"notes":[…]}
  // ```
  // 另有 `targets.act` 那种**双层**写法（动作结果在 `reply.data.data`）——两种都认。
  const inner = isObj(pick(data, 'data')) ? (pick(data, 'data') as J) : undefined
  const d = inner ?? data
  const entity = pick(d, 'entity', 'state', 'record', 'target')
  const transitions = arr(d, 'stateTransitions', 'transitions')
  const t0 = transitions.find(isObj)
  // `stateAfter` 是宿主对"这次处置把状态推到了哪"的直接回答；没有就看最后一条迁移的 `to`
  const tLast = [...transitions].reverse().find(isObj)
  const basis = readBasis(
    isObj(t0) ? { ...t0, basis: pick(t0, 'basis', 'judgement') ?? pick(d, 'basis') } : d,
  )
  return {
    raw: data,
    entityId: str(d, 'entityId', 'targetId', 'id') ?? str(entity, 'id', 'entityId'),
    dynamicState: str(d, 'stateAfter', 'toState', 'dynamicState', 'to', 'stateKey', 'newState')
      ?? (isObj(tLast) ? str(tLast, 'to', 'stateAfter') : undefined)
      ?? str(entity, 'dynamicState'),
    dynamicStateName: str(d, 'stateAfterName', 'dynamicStateName', 'stateName', 'toStateName', 'toName'),
    from: str(d, 'stateBefore', 'fromState', 'from', 'oldState')
      ?? (isObj(t0) ? str(pick(t0, 'data') ?? t0, 'from') : undefined)
      ?? str(entity, 'fromState'),
    status: str(entity, 'status', 'band') ?? str(d, 'status', 'band', 'state'),
    threat: str(entity, 'threatBand', 'threat') ?? str(d, 'threat', 'threatBand'),
    confidence: num(entity, 'confidence') ?? num(d, 'confidence'),
    action: str(d, 'requestedAction', 'action', 'actionKey'),
    idempotent: pick(d, 'idempotent') === true || (isObj(t0) && pick(t0, 'idempotent') === true),
    basis: basis.text,
    basisKey: basis.key,
    basisInputs: basis.inputs,
    leaves: flatten(d),
    unmet: strList(d, 'unmet'),
    skipped: [...strList(d, 'skipped'), ...strList(d, 'ignored')],
    message: str(d, 'message', 'detail'),
    notes: strList(d, 'notes'),
  }
}

// ============================================================================
// ② `target.state` 事件（引擎给的"命中/状态迁移"事实）
// ============================================================================

/** `target.state` 的负载视图（`TargetStateEvent.toJson()`；字段一个个读，读不到就 undefined）。 */
export interface TargetStateView {
  targetId?: string
  targetNo?: number
  threat?: string
  confidence?: number
  /** 引擎的动态状态 key（`struck` / `destroyed` / …） */
  dynamicState?: string
  /** 规则包 `bands[].state`（red/yellow/gray）——**变灰的判据** */
  status?: string
  lng?: number
  lat?: number
  ts?: number
}

export function readTargetState(data: unknown): TargetStateView {
  return {
    targetId: str(data, 'targetId', 'entityId', 'id'),
    targetNo: num(data, 'targetNo', 'no'),
    threat: str(data, 'threat', 'threatBand'),
    confidence: num(data, 'confidence'),
    dynamicState: str(data, 'dynamicState', 'to', 'state'),
    status: str(data, 'status', 'band'),
    lng: num(data, 'lng'),
    lat: num(data, 'lat'),
    ts: num(data, 'ts'),
  }
}

/**
 * 动态状态 key → **显示文案**。
 *
 * ★ 纪律：中文名是**规则包**的数据（`entity-ledger/policies/mapapp/entityTypes.json` 的
 *   `dynamicStates.items[].name`）。前端拿不到规则包时**不猜**：优先用回执/事件里的
 *   `dynamicStateName`（宿主给了就用），其次用下面这份**规则包实测取值的对照**，
 *   都没有就**原样显示 key**（并标注"未给中文名"）。
 *
 * 这份对照的取值来自规则包实测（8 项全列），不是前端编的：
 *   onMove 机动中 / active 活跃 / deploying 部署中 / relocating 转移中 /
 *   briefStop 短暂停留 / static 静止 / struck 已打击（待评估）/ destroyed 已摧毁（终态）
 */
const DYNAMIC_STATE_CN: Record<string, string> = {
  onmove: '机动中',
  active: '活跃',
  deploying: '部署中',
  relocating: '转移中',
  briefstop: '短暂停留',
  static: '静止',
  struck: '已打击（待评估）',
  destroyed: '已摧毁（终态）',
}

/** 返回 `{ text, source }`：`source='host'` 宿主给了名字 / `'policies'` 规则包对照 / `'key'` 只能显示键。 */
export function dynamicStateName(key?: string, hostName?: string): { text: string; source: 'host' | 'policies' | 'key' | 'none' } {
  if (hostName) return { text: hostName, source: 'host' }
  if (!key) return { text: '—', source: 'none' }
  const cn = DYNAMIC_STATE_CN[key.toLowerCase()]
  if (cn) return { text: cn, source: 'policies' }
  return { text: key, source: 'key' }
}

/**
 * 状态是否算"已失效 / 已处置"（图上变灰、卡片置灰）。
 *
 * ★ 口径（**实测查清，写在这里免得再踩**）：`targets.list[].status` 是规则包
 *   `threatFactors.json` 的 `bands[].state`（red/yellow/gray），它是**威胁分档**的颜色，
 *   **不是**"打没打掉"：低威胁档（score < 40）本来就是 `gray`，与 `dynamicState` 无关。
 *   所以"变灰"只认 **`dynamicState` 的 `struck` / `destroyed`**（引擎在 `setDynamicState`
 *   里写入的唯一事实）。`status` 只用来上色，不用来判定命中。
 */
export function isStruckState(_status?: string, dynamicState?: string): boolean {
  const d = (dynamicState ?? '').toLowerCase()
  return d === 'struck' || d === 'destroyed'
}

/** 图上颜色：**已处置的取 `theme.muted` 灰**；否则按引擎给的 `status` 域映射。 */
export function targetColor(status?: string, dynamicState?: string): 'muted' | 'status' | 'unknown' {
  if (isStruckState(status, dynamicState)) return 'muted'
  if (status) return 'status'
  return 'unknown'
}

// ============================================================================
// ③ phase-engine 的逐阶段耗时（步 11 时间轴）
// ============================================================================

/** 一段阶段驻留（`PhaseDuration.toJson()` + `DurationReport` 的汇总字段）。 */
export interface DurationSeg {
  key: string
  phase: string
  /** 台账里的进入序号（`seq`）；没给就 undefined */
  seq?: number
  /** 进入/离开时刻（epoch ms；`leftAt` 缺失 = 该阶段还在进行中，**照实空着**） */
  enteredAt?: number
  leftAt?: number
  /** 驻留时长（ms）——**引擎的读数**，前端不自己算 */
  dwellMs?: number
  /** 该段是不是"当前正在进行的阶段"（引擎给了 `current` 就用它） */
  current?: boolean
  /** 引擎给的其它叶子（有些规则包会多给几项） */
  extra: Leaf[]
}

export interface DurationsView {
  raw: unknown
  missionId?: string
  startedAt?: number
  endedAt?: number
  /** 任务总用时（ms）——引擎的 `totalMs` */
  totalMs?: number
  /** 逐段（**顺序即引擎给的顺序**，一段都不增不减） */
  segs: DurationSeg[]
  /** 按阶段聚合（`byPhase`），有就显示 */
  byPhase: { phase: string; visits?: number; totalDwellMs?: number }[]
}

/**
 * 读 `phase::durations(missionId)` 的 `DurationReport.toJson()`
 * （phase_engine `record.cc:190`：`{missionId,startedAt,endedAt?,totalMs,perPhase[],byPhase[]}`）。
 *
 * **实测形状（2026-09-16，宿主装配后）**：`report.generate` 回执把它放在
 * `data.timeline.durations`（另有 `data.timeline.durationsDigest` / `durationsRaw` /
 * `clockNote` / `snapshotInputEqual` 等旁证字段）。所以这里按**由深到浅**依次找：
 *   `data.timeline.durations` → `data.durations` → `data.report.durations` → 直接给 DurationReport；
 * 找到哪份就用哪份，找不到就返回空段（界面如实写"未就绪 + 为什么"）。
 */
export function readDurations(data: unknown): DurationsView {
  const d = isObj(data) ? data : undefined
  const rep = pick(d, 'report', 'generate', 'result')
  const tl = pick(d, 'timeline')
  const cands: unknown[] = [
    pick(tl, 'durations'),            // ← 实测路径
    pick(d, 'durations'),
    pick(rep, 'durations'),
    pick(pick(d, 'missionTimeline'), 'durations'),
    tl,
    pick(rep, 'missionTimeline'),
    d,                                 // 直接就是 DurationReport 的情况
  ]
  const src = cands.find((c) => isObj(c) && (Array.isArray((c as J).perPhase) || Array.isArray((c as J).items) || Array.isArray((c as J).phases)))

  const perPhase = arr(src, 'perPhase', 'items', 'phases', 'segments')
  const segs: DurationSeg[] = perPhase.filter(isObj).map((p, i) => {
    const phase = str(p, 'phase', 'phaseKey', 'key') ?? `#${i + 1}`
    return {
      key: `${phase}-${str(p, 'seq') ?? i}`,
      phase,
      seq: num(p, 'seq'),
      enteredAt: num(p, 'enteredAt', 'at', 'from'),
      leftAt: num(p, 'leftAt', 'to'),
      dwellMs: num(p, 'dwellMs', 'durationMs', 'ms'),
      current: pick(p, 'current') === true ? true : (pick(p, 'current') === false ? false : undefined),
      extra: flatten(p),
    }
  })

  const byPhase = arr(src, 'byPhase', 'aggregates').filter(isObj).map((b) => ({
    phase: str(b, 'phase', 'key') ?? '—',
    visits: num(b, 'visits', 'count'),
    totalDwellMs: num(b, 'totalDwellMs', 'ms'),
  }))

  return {
    raw: src ?? data ?? null,
    missionId: str(src, 'missionId') ?? str(d, 'missionId'),
    startedAt: num(src, 'startedAt'),
    endedAt: num(src, 'endedAt'),
    totalMs: num(src, 'totalMs', 'durationMs'),
    segs,
    byPhase,
  }
}

/** 时长显示：ms → `1.2 s` / `2 分 03 秒`（**只格式化，不换算别的口径**）。 */
export function msText(ms?: number): string {
  if (ms === undefined) return '—'
  if (ms < 1000) return `${ms} ms`
  const s = ms / 1000
  if (s < 60) return `${Number(s.toFixed(1))} s`
  const m = Math.floor(s / 60)
  const rest = Math.round(s - m * 60)
  return `${m} 分 ${String(rest).padStart(2, '0')} 秒`
}

// ============================================================================
// ④ `report.generate` 的报告文档
// ============================================================================

/** 报告字段的来源（`ReportField.toJson().source`；RPT-SCHEMA-02 的溯源）。 */
export interface ReportSource {
  engine?: string
  path?: string
  snapshot?: string
  snapshotId?: string
  compute?: string
}

/** 报告里的一个字段（`ReportField.toJson()`，engine.cc:72）。 */
export interface ReportFieldView {
  key: string
  name: string
  unit?: string
  /** 已格式化文本（缺失时 = `missingMarker`，通常是 "—"） */
  text: string
  /** **是否缺失**（RPT-SCHEMA-03：缺失就是缺失，绝不用 0 顶替） */
  missing: boolean
  missingMarker?: string
  /** 数值（缺失时宿主给 `null` → 这里 undefined；**不补 0**） */
  value?: number
  source: ReportSource
  /** 列表型字段（逐目标结果这类）：行列与单元格 */
  list?: { rowsTotal?: number; rowsShown?: number; truncated?: boolean; columns: string[]; cells: { key: string; text: string; missing: boolean }[] }
}

export interface ReportGroupView {
  key: string
  name: string
  order?: number
  fields: ReportFieldView[]
}

export interface ReportView {
  /** 原始 data（界面的"报告 JSON"折叠区用它） */
  raw: unknown
  /** 文档本体（`data.document` / `data.report.document` / 直接就是文档） */
  doc: unknown
  title?: string
  reportNo?: string
  missionId?: string
  schemaVersion?: string
  generatedAt?: string
  generatedAtMs?: number
  timeBasis?: string
  timeBasisName?: string
  footer?: string
  groups: ReportGroupView[]
  /** 字段总数 / 缺失字段数（**数出来的**，不是编的） */
  fieldCount: number
  missingCount: number
  /** 归档元数据（`data.archive`，RPT-ARCH-04） */
  archive?: { reportNo?: string; fileName?: string; generatedAt?: string; missionId?: string; schemaVersion?: string }
  /** 报告编号/文件名规则的落值（`data.numbering`） */
  numbering?: { dayKey?: string; seq?: number; present?: boolean }
  /** 渲染结果（`data.render`：ok/format/bytes） */
  render?: { ok?: boolean; format?: string; bytes?: number; reason?: string }
  /** 引擎自己的 code/message（`GenerateResult` 内层，与 `/api/command` 的 code 是两回事） */
  engineCode?: number
  engineMessage?: string
  /** 引擎列的"缺失字段 key"（`GenerateResult.missing` / 宿主 `data.missingFields`） */
  missingKeys: string[]
  /** **每条"没有数"的宿主原话**，按字段 key 索引（实测 `data.warnings[]` 形如
   *  `coopEfficiency: missing (scoring: metrics block absent: cluster)`）——这是最直接的原因 */
  reasonByKey: Record<string, string>
  warnings: string[]
}

function readField(f: unknown, i: number): ReportFieldView {
  const src = isObj(pick(f, 'source')) ?? {}
  const listRaw = pick(f, 'list')
  const list: ReportFieldView['list'] = isObj(listRaw)
    ? {
      rowsTotal: num(listRaw, 'rowsTotal'),
      rowsShown: num(listRaw, 'rowsShown'),
      truncated: pick(listRaw, 'truncated') === true,
      columns: strList(listRaw, 'columns'),
      cells: arr(listRaw, 'cells').filter(isObj).map((c, ci) => ({
        key: str(c, 'key') ?? `#${ci + 1}`,
        text: str(c, 'text') ?? '—',
        missing: pick(c, 'missing') === true,
      })),
    }
    : undefined
  return {
    key: str(f, 'key', 'id') ?? `field-${i}`,
    name: str(f, 'name', 'label', 'title') ?? str(f, 'key') ?? `#${i + 1}`,
    unit: str(f, 'unit'),
    // 文本缺失时用 missingMarker（宿主给），再不行 "—" —— 不显示 0
    text: str(f, 'text', 'display') ?? str(f, 'missingMarker') ?? '—',
    missing: pick(f, 'missing') === true,
    missingMarker: str(f, 'missingMarker'),
    value: num(f, 'value'),
    source: {
      engine: str(src, 'engine'),
      path: str(src, 'path'),
      snapshot: str(src, 'snapshot'),
      snapshotId: str(src, 'snapshotId'),
      compute: str(src, 'compute'),
    },
    list,
  }
}

export function readReport(data: unknown): ReportView {
  const d = isObj(data) ? data : undefined
  const rep = pick(d, 'report', 'generate', 'result')
  const docCand = [pick(d, 'document'), pick(rep, 'document'), pick(d, 'report'), pick(rep, 'report'), d]
  const doc = docCand.find((c) => isObj(c) && (Array.isArray((c as J).groups) || typeof (c as J).reportNo === 'string')) ?? null

  const groups: ReportGroupView[] = arr(doc, 'groups').filter(isObj).map((g, gi) => ({
    key: str(g, 'key', 'id') ?? `group-${gi}`,
    name: str(g, 'name', 'title') ?? str(g, 'key') ?? `分组 #${gi + 1}`,
    order: num(g, 'order'),
    fields: arr(g, 'fields', 'items').filter(isObj).map(readField),
  }))
  const fieldCount = groups.reduce((a, g) => a + g.fields.length, 0)
  const missingCount = groups.reduce((a, g) => a + g.fields.filter((f) => f.missing).length, 0)

  const archRaw = pick(d, 'archive') ?? pick(rep, 'archive')
  const numRaw = pick(d, 'numbering') ?? pick(rep, 'numbering')
  const renRaw = pick(d, 'render') ?? pick(rep, 'render')
  const warnings = [...strList(d, 'warnings'), ...strList(rep, 'warnings')]
  /**
   * 把宿主 `warnings[]` 里"`<字段key>: <原因>`"这类行**按字段索引**出来。
   *
   * 为什么这么做：这条 verb 的 warnings 里带的正是"哪个来源模块缺了哪个 metrics block"
   * （实测原话：`coopEfficiency: missing (scoring: metrics block absent: cluster)`）——
   * 那是"无数据"段落最权威的原因，比我们按 source 反推准确得多。
   */
  const reasonByKey: Record<string, string> = {}
  for (const w of warnings) {
    const m = /^([A-Za-z0-9_]+)\s*:\s*(.+)$/.exec(w.trim())
    if (m && !reasonByKey[m[1]]) reasonByKey[m[1]] = m[2]
  }

  return {
    raw: data,
    doc,
    title: str(doc, 'title'),
    reportNo: str(doc, 'reportNo') ?? str(archRaw, 'reportNo'),
    missionId: str(doc, 'missionId') ?? str(archRaw, 'missionId'),
    schemaVersion: str(doc, 'schemaVersion') ?? str(archRaw, 'schemaVersion'),
    generatedAt: str(doc, 'generatedAt', 'generatedAtText') ?? str(archRaw, 'generatedAt'),
    generatedAtMs: num(doc, 'generatedAtMs') ?? num(archRaw, 'generatedAtMs'),
    timeBasis: str(doc, 'timeBasis'),
    timeBasisName: str(doc, 'timeBasisName'),
    footer: str(doc, 'footer'),
    groups,
    fieldCount,
    missingCount,
    archive: isObj(archRaw)
      ? {
        reportNo: str(archRaw, 'reportNo'),
        fileName: str(archRaw, 'fileName'),
        generatedAt: str(archRaw, 'generatedAt'),
        missionId: str(archRaw, 'missionId'),
        schemaVersion: str(archRaw, 'schemaVersion'),
      }
      : undefined,
    numbering: isObj(numRaw)
      ? { dayKey: str(numRaw, 'dayKey'), seq: num(numRaw, 'seq'), present: pick(numRaw, 'present') === true }
      : undefined,
    render: isObj(renRaw)
      ? { ok: pick(renRaw, 'ok') === true, format: str(renRaw, 'format'), bytes: num(renRaw, 'bytes'), reason: str(renRaw, 'reason') }
      : undefined,
    engineCode: num(rep, 'code') ?? num(d, 'code'),
    engineMessage: str(rep, 'message') ?? str(d, 'engineMessage'),
    // 缺失字段：宿主在顶层给 `missingFields[]`，引擎在 GenerateResult 里给 `missing[]`（两份都收）
    missingKeys: [...new Set([...strList(d, 'missingFields'), ...strList(d, 'missing'), ...strList(rep, 'missing')])],
    reasonByKey,
    warnings,
  }
}

/**
 * 报告里"无数据"的段落 → 一句**宿主给的原因**。
 *
 * ★ 纪律（本轮任务点名的一条）：MUST NOT 把"没数据"画成空白的 0。
 *   能拿到的原因按优先级：
 *     ① **宿主 `warnings[]` 里针对本字段的那句原话**（实测最具体：
 *        `coopEfficiency: missing (scoring: metrics block absent: cluster)`）；
 *     ② 该字段的来源模块 + 取值路径（`source.engine` / `source.path`）→
 *        "该来源模块本次未给数"，这是 RPT-SCHEMA-02 的溯源字段，是**事实**不是我们编的；
 *     ③ 引擎的缺失标记本身（`missingMarker`，例如 "—"）；
 *     ④ 引擎/宿主列的缺失字段清单（`missingFields[]`）；
 *     ⑤ 都没有 → 写"宿主未给出原因"。
 */
export function missingReason(f: ReportFieldView, rv: ReportView): string {
  const parts: string[] = []
  const host = rv.reasonByKey[f.key]
  if (host) parts.push(host)
  if (f.source.engine || f.source.path) {
    parts.push(`来源 ${[f.source.engine, f.source.path].filter(Boolean).join(' / ')} 本次未给数`)
  }
  if (f.missingMarker) parts.push(`引擎缺失标记「${f.missingMarker}」`)
  if (rv.missingKeys.includes(f.key)) parts.push('引擎 missingFields[] 列了本字段')
  if (parts.length === 0) parts.push('宿主未给出原因（回执里既没有 warnings 也没有 source）')
  return parts.join('；')
}

// ============================================================================
// ⑤ alert-engine 的计数（步 11 的"预警次数"）
// ============================================================================

export interface AlertCountsView {
  raw: unknown
  /** `basis`：`deduplicated` | `raw` —— 宿主声明"报告该取哪个"（ALT-GEN-05） */
  basis?: string
  /** 去重后条数（台账记录总数） */
  alertCount?: number
  /** 原始触发条数 */
  rawRaises?: number
  alertsRaised?: number
  merged?: number
  recoveries?: number
  aggregates?: number
  suppressed?: number
  folded?: number
  openActive?: number
  /** 其余标量叶子（口径可复算的旁证） */
  extra: Leaf[]
}

/** 已知的计数字段（其余进 `extra`；**不做任何加减乘除**）。 */
const COUNT_KEYS = ['alertCount', 'rawRaises', 'alertsRaised', 'merged', 'recoveries', 'aggregates', 'suppressed', 'folded', 'openActive'] as const

export function readAlertCounts(data: unknown): AlertCountsView {
  const d = isObj(data) ? data : undefined
  const rep = pick(d, 'report', 'generate', 'result')
  // **实测形状**：`data.alerts = {basis, counts:{…}, entry, list}`
  //  —— `basis` 在外层，逐项计数在 `counts` 里（于是"口径"与"数"要分别取）。
  //  下面把几种可能的层级都认了：alerts / alertCounts / counts / alert 段里的 counts。
  const outer = [pick(d, 'alerts', 'alertCounts', 'counts'), pick(rep, 'alerts', 'alertCounts', 'counts')].find(isObj)
  const inner = isObj(outer) ? (isObj((outer as J).counts) ? ((outer as J).counts as J) : undefined) : undefined
  const o = inner ?? (isObj(outer) ? outer as J : undefined)
  return {
    raw: outer ?? null,
    // 口径优先取"计数那一层"，没有再取外层（实测两层都有，且值一致）
    basis: str(o, 'basis') ?? str(outer, 'basis'),
    alertCount: num(o, 'alertCount'),
    rawRaises: num(o, 'rawRaises'),
    alertsRaised: num(o, 'alertsRaised'),
    merged: num(o, 'merged'),
    recoveries: num(o, 'recoveries'),
    aggregates: num(o, 'aggregates'),
    suppressed: num(o, 'suppressed'),
    folded: num(o, 'folded'),
    openActive: num(o, 'openActive'),
    extra: flatten(o ?? {}).filter((l) => !(COUNT_KEYS as readonly string[]).includes(l.path)),
  }
}

/**
 * 报告该显示的"预警次数" = **按 `basis` 取**（宿主声明取哪个口径）。
 *
 * 为什么不能自己挑一个：两个口径同时在案（去重 vs 原始），报告必须与声明一致，
 * 否则口径会漂移（`alert_engine.h:466` 的原话）。`basis` 不认识时**不用猜**：
 * 返回 undefined，界面显示"—（未声明口径）"。
 */
export function alertCountOf(av: AlertCountsView): { value?: number; by: string } {
  const b = (av.basis ?? '').toLowerCase()
  if (b === 'raw') return { value: av.rawRaises, by: 'rawRaises（basis=raw）' }
  if (b === 'deduplicated') return { value: av.alertCount, by: 'alertCount（basis=deduplicated）' }
  return { value: undefined, by: av.basis ? `未知口径 ${av.basis}` : '宿主未声明 basis' }
}

// ============================================================================
// ⑥ 小工具
// ============================================================================

/** 回执失败时的一句话（宿主原话优先；1000/1005 说明"没实现/没装配"）。 */
export function execVerdict(reply: CommandReply | null | undefined): { ok: boolean; text: string } {
  if (!reply) return { ok: false, text: '未发送' }
  if (reply.code === 0) return { ok: true, text: '成功（code=0）' }
  const msg = reply.error?.message ?? (isObj(reply.data) ? str(reply.data, 'message', 'reason') : undefined)
  const kind = reply.code === 1000 ? '宿主未实现该 verb'
    : reply.code === 1005 ? '宿主模块未就绪'
      : reply.code === 1003 ? '前置条件不满足'
        : reply.code === 1004 ? '未找到'
          : '失败'
  return { ok: false, text: `code=${reply.code} ${kind}${msg ? `：${msg}` : '（宿主未给原因）'}` }
}
