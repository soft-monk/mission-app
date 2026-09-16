// mission-app · apps/web/src/flow/useSituation.ts
//
// 步 3–5（任务态势 / 无人机分组与任务编组 / 编组确认）的**数据层**。
//
// 三层职责，写清楚免得后来者把规则塞进来：
//   ① `useVerbOnce`  —— 进入某步时按契约发一次命令（幂等：宿主自己保证），并把回执留着；
//   ② `readXxx()`    —— 把宿主/引擎返回的 JSON **读成界面要的形状**。只做"取字段 + 兜底"，
//                       不做几何计算、不做评分、不做百分比换算；
//   ③ `domain.*`     —— 词典：把规则包给的域（domain）折成中文。域不认识就**原样显示英文**，
//                       MUST NOT 猜。
//
// ★ 纪律（与 api.ts 一致）：
//   · 前端**不产生**任何数值。评分、百分比、数量、就绪率、覆盖率全部来自宿主回执；
//     宿主没给就显示"未就绪"，绝不用假数据兜底。
//   · verb 没实现（`code=1000` 未知 verb / `1005` 未装配）时，把**宿主的原话**显示出来。
//
// ⚠ 字段名口径：写这份代码时宿主侧 P3 的 verb（`situation.snapshot` / `view.compose` /
//   `alloc.*`）还没装配（实测返回 `code=1000 未知 verb`），所以本文件对字段名采取
//   **防御式读取**：同一语义按"契约里的名字 → 常见别名"依次试，读到就用，读不到就 undefined。
//   这样宿主补上后无需改前端；对不上的部分也不会显示错值，而是显示"未就绪"。
import { useEffect, useRef, useState } from 'react'
import type { CommandReply } from '../api'
import { statusColor } from '../theme'
import type { UseFlow } from './useFlow'

// ============================================================================
// ① 发命令（每步一次）
// ============================================================================

/** 一次 verb 调用的状态。`sent=false` 表示这次会话里还没发过（正在发）。 */
export interface VerbCall<T> {
  /** 宿主的回执（没发过 / 还没回来时为 null） */
  reply: CommandReply<T> | null
  /** 契约形状的数据（宿主没实现或形状对不上时为 null） */
  data: T | null
  /** 真的发了并拿到结果（无论 code 是多少）——用来区分"还没回来"和"失败了" */
  sent: boolean
  /** 正在进行（按钮用） */
  busy: boolean
  /** 再发一次（用户点"重试"） */
  resend: () => void
}

/**
 * 进入某屏时发**一次**某个 verb，并把回执留在这个组件的生命周期里。
 *
 * 为什么不用 `lastReply`：那是"最近一条命令"，会被屏幕上别的动作覆盖。
 * 为什么每屏自己发：宿主对这几条 verb 都按幂等处理（契约 §2），重复发不会产生副作用；
 * 但**前端不该重复发**——所以只在 `enabled` 从 false→true（即真的进了这一步）时发一次。
 *
 * `sent=false`（本次会话这条 verb 还没回来）时会回落到 `flow.replies[verb]`：
 * 步 4→步 5 会重复用到 `alloc.plans`，回落能让界面立刻显示上一步已经拿到的那份回执，
 * 而不是先闪一下"未发送"。回落的是**同一份宿主回执**，不是本地缓存出来的假数据。
 */
export function useVerbOnce<P extends Record<string, unknown>, T = unknown>(
  flow: UseFlow,
  verb: string,
  params: P,
  enabled: boolean,
): VerbCall<T> {
  const send = flow.send
  const [reply, setReply] = useState<CommandReply<T> | null>(null)
  const [busy, setBusy] = useState(false)
  const [nonce, setNonce] = useState(0)
  const firedRef = useRef(false)
  const retryRef = useRef(0)
  // params 是字面量对象，每次渲染都是新引用；序列化后当依赖，避免无限重发。
  const key = JSON.stringify(params)

  useEffect(() => {
    if (!enabled) { firedRef.current = false; return }
    if (firedRef.current && nonce === 0) return
    firedRef.current = true
    let alive = true
    setBusy(true)
    void send<T>(verb, JSON.parse(key) as P)
      .then((r) => {
        if (!alive) return
        // 前置不满足的重试：步 3 刚进入时 `alloc.*` 会回 1003（宿主还没把台账/阶段准备好）。
        // 只在**明确的 1003** 上重试一次（有界、可解释），其它错误一律不重试。
        if (r.code === 1003 && retryRef.current < 1) {
          retryRef.current += 1
          window.setTimeout(() => { if (alive) setNonce((n) => n + 1) }, 2500)
          return
        }
        setReply(r)
      })
      .catch((e: unknown) => {
        if (!alive) return
        setReply({ code: -1, verb, error: { message: String((e as Error)?.message ?? e) } })
      })
      .finally(() => { if (alive) setBusy(false) })
    return () => { alive = false }
  }, [enabled, verb, key, nonce, send])

  const effective = reply ?? (flow.replies[verb] as CommandReply<T> | undefined) ?? null

  return {
    reply: effective,
    data: effective && effective.code === 0 ? ((effective.data ?? null) as T | null) : null,
    // `sent` 的口径是"回执里已经有这条 verb 的结论了"（本屏发的或本会话早先发的都算）
    sent: effective !== null,
    busy,
    resend: () => setNonce((n) => n + 1),
  }
}

/** 把 `flow.goto`（切步）包成一个动作：宿主不认识就什么都不做，界面照常显示。 */
export function useGoto(send: UseFlow['send']) {
  return (step: number) => void send('flow.goto', { step })
}

// ============================================================================
// ② 防御式读取
// ============================================================================

type J = Record<string, unknown>

/** 是"能当对象读"的值（排除 null 与数组）。 */
export function isObj(v: unknown): v is J {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** 取子对象；不是对象就 undefined。 */
export function obj(v: unknown, key: string): J | undefined {
  if (!isObj(v)) return undefined
  const c = v[key]
  return isObj(c) ? c : undefined
}

/** 取数组；不是数组就 []。 */
export function arr(v: unknown, key: string): unknown[] {
  if (!isObj(v)) return []
  const c = v[key]
  return Array.isArray(c) ? c : []
}

/** 依次试多个字段名，返回第一个"存在且不是 null/undefined"的值。 */
export function pick(v: unknown, ...keys: string[]): unknown {
  if (!isObj(v)) return undefined
  for (const k of keys) {
    const c = v[k]
    if (c !== undefined && c !== null && c !== '') return c
  }
  return undefined
}

/** 取字符串（数字也转成串；对象/数组不转，避免把结构显示成 "[object Object]"）。 */
export function str(v: unknown, ...keys: string[]): string | undefined {
  const x = pick(v, ...keys)
  if (typeof x === 'string') return x
  if (typeof x === 'number' || typeof x === 'boolean') return String(x)
  return undefined
}

/**
 * 取数值。**只认宿主给的数**：字符串数字也接受（宿主偶尔把数当串给），
 * 其余一律 undefined——界面据此显示"—"，不换算、不补 0。
 */
export function num(v: unknown, ...keys: string[]): number | undefined {
  const x = pick(v, ...keys)
  if (typeof x === 'number' && Number.isFinite(x)) return x
  if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x))) return Number(x)
  return undefined
}

/** 取布尔。 */
export function bool(v: unknown, ...keys: string[]): boolean | undefined {
  const x = pick(v, ...keys)
  return typeof x === 'boolean' ? x : undefined
}

/**
 * 取"字符串数组"。宿主可能给 `["a","b"]`，也可能给 `[{text:"a"},{reason:"b"}]`
 * （自检那套就是这么给的）——两种都收，读不出文字就丢掉。
 */
export function strList(v: unknown, ...keys: string[]): string[] {
  const x = pick(v, ...keys)
  if (!Array.isArray(x)) return []
  const out: string[] = []
  for (const it of x) {
    if (typeof it === 'string') { if (it) out.push(it); continue }
    if (typeof it === 'number') { out.push(String(it)); continue }
    if (isObj(it)) {
      const t = str(it, 'text', 'label', 'title', 'reason', 'name', 'detail', 'value')
      if (t) out.push(t)
    }
  }
  return out
}

/** 取"对象数组"，读不出对象就丢掉。 */
export function objList(v: unknown, ...keys: string[]): J[] {
  const x = keys.length ? pick(v, ...keys) : v
  if (!Array.isArray(x)) return []
  return x.filter(isObj)
}

/** 「名 + 值」这类计量条：宿主给 `[{name,value,status}]` / `{a:1,b:2}` 都能读。 */
export interface Metric { key: string; name: string; value?: number; unit?: string; status?: string; text?: string }

export function toMetrics(v: unknown, ...keys: string[]): Metric[] {
  const x = keys.length ? pick(v, ...keys) : v
  const out: Metric[] = []
  if (Array.isArray(x)) {
    x.forEach((it, i) => {
      if (!isObj(it)) return
      const name = str(it, 'name', 'label', 'title', 'key') ?? `#${i + 1}`
      out.push({
        key: str(it, 'key', 'id') ?? `${name}-${i}`,
        name,
        value: num(it, 'value', 'percent', 'pct', 'rate', 'score'),
        unit: str(it, 'unit', 'suffix'),
        status: str(it, 'status', 'level'),
        text: str(it, 'text', 'detail'),
      })
    })
    return out
  }
  if (isObj(x)) {
    for (const [k, val] of Object.entries(x)) {
      if (isObj(val)) {
        out.push({
          key: k,
          name: str(val, 'name', 'label') ?? k,
          value: num(val, 'value', 'percent', 'pct', 'rate', 'score'),
          unit: str(val, 'unit'),
          status: str(val, 'status', 'level'),
          text: str(val, 'text', 'detail'),
        })
      } else if (typeof val === 'number' || typeof val === 'string') {
        out.push({ key: k, name: k, value: typeof val === 'number' ? val : Number(val), text: typeof val === 'string' ? val : undefined })
      }
    }
  }
  return out
}

/** 数值 → 显示串（`undefined` → `—`，**不补 0**）。 */
export function n2s(n: number | undefined, unit = ''): string {
  if (n === undefined) return '—'
  return `${Number.isInteger(n) ? n : Number(n.toFixed(1))}${unit}`
}

// ============================================================================
// ③ 域词典（域 → 中文）。域是规则包给的，不认识就原样显示。
// ============================================================================

/**
 * UAV 型号域 → 中文。**实测的场景数据取值为**
 * `optical / radar / electronic / comm`（见 `situation.snapshot.platforms[].typeKey` 与
 * `alloc.inventory.items[].type`），这里把常见别名一起收；不认识的原样显示（不猜）。
 */
const UAV_TYPE_CN: Record<string, string> = {
  optical: '光电', eo: '光电', ir: '光电', eoir: '光电', photoelectric: '光电',
  radar: '雷达', sar: '雷达',
  electronic: '电子', ew: '电子', jammer: '电子',
  comm: '通信', relay: '通信', communication: '通信',
}
export function uavTypeCN(t?: string): string {
  if (!t) return '—'
  return UAV_TYPE_CN[t.toLowerCase()] ?? t
}

/** 威胁/风险等级域 → 颜色。规则包的域（high/medium/low）与自检那套（ok/fail…）都收；
 *  完全不认识的域给中性色（**不猜**）。 */
export function threatColor(level?: string): string {
  const s = (level ?? '').toLowerCase()
  if (['low', '低', 'none', 'safe', 'minimal'].includes(s)) return '#22c55e'
  if (['medium', 'mid', '中', 'moderate', 'elevated'].includes(s)) return '#f59e0b'
  if (['high', '高', 'critical', 'severe', 'extreme'].includes(s)) return '#ef4444'
  return statusColor(level)
}

/** 资源/方案状态域 → 颜色（在线=绿、待命=蓝、不可用=灰）。 */
export function resColor(status?: string): string {
  const s = (status ?? '').toLowerCase()
  if (['online', 'ready', 'available', 'ok', 'idle'].includes(s)) return '#22c55e'
  if (['assigned', 'allocated', 'busy', 'reserved'].includes(s)) return '#5fb0ff'
  if (['offline', 'unavailable', 'fail', 'fault', 'damaged'].includes(s)) return '#ef4444'
  if (['maintenance', 'charging', 'warn', 'degraded'].includes(s)) return '#f59e0b'
  return '#64748b'
}

// ============================================================================
// 契约视图（步 3–5）
// ============================================================================

/**
 * 步 3 · `situation.snapshot` 的视图。
 *
 * 实测回执（宿主已装配后的原样字段）：
 * ```json
 * {"mission":{"name":"敏捷拒止布控（演示）","region":"西南方向山区","startAt":"2026-09-16 15:14",
 *             "timeRequirement":"自任务下达起 4 小时内完成侦察与处置","type":"侦察/打击"},
 *  "areas":[{"key":"area-a","name":"A 区","areaKind":"task","role":"assembly","color":"blue",
 *            "polygon":[[116.586,39.744],…]}],
 *  "zones":[{"key":"nfz-core","name":"核心禁飞区","kind":"no-fly","hardness":"hard",…}],
 *  "groups":[{"groupId":"g1","key":"recon-1","name":"前出侦察集群","platformCount":2,"role":"recon"}],
 *  "platforms":[{"deviceId":"uav-opt-001","typeKey":"optical","groupName":"前出侦察集群",…}],
 *  "targets":[{"id":"target-001","name":"机动指挥节点","threat":"high","valueTag":"高价值",…}],
 *  "overview":[…], "notes":["areas/zones/platforms/groups/targets 全部来自 scenario-data 的本地配置…"]}
 * ```
 * 本函数只做"取字段 + 归类"，**不加一个数**。
 */
export interface SituationView {
  /** 原始回执（界面折叠区原样展示；字段再变也不会藏起来） */
  raw: unknown
  mission?: {
    name?: string; type?: string; region?: string; startAt?: string
    timeRequirement?: string; status?: string; id?: string
  }
  /** 态势/威胁等"名 + 值 + 等级"的分析行 */
  analysis: Metric[]
  /** 整句结论（宿主给的 note / 简述） */
  notes: string[]
  /** 区域（A/B/C… 及敌方部署区）：名字 + 角色域 */
  areas: Metric[]
  /** 空域/禁飞区：名字 + 类型域 + 硬度 */
  airspaces: Metric[]
  /** 平台：按集群分组的明细 */
  platforms: Metric[]
  /** 集群（来自 snapshot.groups）：步 4/5 的集群组成要跟它对齐 */
  groups: GroupInfo[]
  /** 目标初始位置 */
  targets: Metric[]
  /** 概览（宿主给的 overview，与自检的报告同一份口径） */
  overview: Metric[]
}

/** 场景数据里的集群（`scenario-1/deployment.json` → snapshot.groups[]）。 */
export interface GroupInfo {
  key: string
  name: string
  role?: string
  /** 该集群的平台数（宿主的数，不重算） */
  platformCount?: number
  /** 平台按型号的分布（**本函数按 device 计数**，不是引擎给的编组量） */
  byType: { type: string; label: string; count: number }[]
}

/** 把 `situation.snapshot` 的回执读成视图。读不到的字段留空——界面显示"未就绪"。 */
export function readSituation(data: unknown): SituationView {
  const snap = isObj(data) ? (obj(data, 'snapshot') ?? data) : undefined
  const missionRaw = pick(snap, 'mission', 'missionInfo', 'task')

  // 平台按集群归类（`platforms[].groupName` 是场景数据里就有的，宿主原样转发）
  const platRaw = objList(snap, 'platforms', 'assets')
  const groupRaw = objList(snap, 'groups', 'clusters')
  const groups: GroupInfo[] = groupRaw.map((g, i) => {
    const key = str(g, 'key', 'groupId', 'id') ?? `g${i}`
    const name = str(g, 'name', 'label') ?? key
    const mine = platRaw.filter((p) => str(p, 'groupName', 'groupKey') === name || str(p, 'groupKey') === key)
    const byType = new Map<string, number>()
    for (const p of mine) {
      const t = str(p, 'typeKey', 'type') ?? 'unknown'
      byType.set(t, (byType.get(t) ?? 0) + 1)
    }
    return {
      key,
      name,
      role: str(g, 'role', 'kind'),
      platformCount: num(g, 'platformCount', 'count'),
      byType: [...byType.entries()].map(([type, count]) => ({ type, label: uavTypeCN(type), count })),
    }
  })

  return {
    raw: data,
    mission: {
      name: str(missionRaw, 'name', 'title', 'missionName') ?? str(snap, 'missionName'),
      type: str(missionRaw, 'type', 'missionType', 'kind') ?? str(snap, 'missionType'),
      region: str(missionRaw, 'region', 'area', 'zone'),
      startAt: str(missionRaw, 'startAt', 'time', 'timeText', 'at'),
      timeRequirement: str(missionRaw, 'timeRequirement', 'requirement'),
      status: str(missionRaw, 'status', 'state') ?? str(snap, 'missionStatus'),
      id: str(snap, 'missionId', 'id'),
    },
    analysis: toMetrics(pick(snap, 'analysis', 'aiAnalysis', 'threat'), 'items', 'metrics', 'lines'),
    notes: [...strList(snap, 'notes', 'situation', 'brief'), ...strList(pick(snap, 'analysis', 'aiAnalysis'), 'notes', 'conclusions')],
    // 区域/空域：把"角色/类型域"放进 status 位（界面按"域 → 颜色"上色，不猜语义）
    areas: objList(snap, 'areas', 'regions', 'taskAreas').map((a, i) => ({
      key: str(a, 'key', 'id') ?? `a${i}`,
      name: str(a, 'name', 'label') ?? `#${i + 1}`,
      status: str(a, 'role', 'areaKind', 'kind', 'color'),
      text: str(a, 'areaKind', 'kind'),
    })),
    airspaces: objList(snap, 'zones', 'airspaces', 'airspace', 'corridors', 'channels').map((z, i) => ({
      key: str(z, 'key', 'id') ?? `z${i}`,
      name: str(z, 'name', 'label') ?? `#${i + 1}`,
      status: str(z, 'level', 'kind', 'hardness'),
      text: str(z, 'hardness', 'kind'),
    })),
    platforms: groups.map((g) => ({
      key: g.key,
      name: g.name,
      value: g.platformCount,
      text: g.byType.length ? g.byType.map((t) => `${t.label} ${t.count}`).join(' · ') : undefined,
      status: g.role,
    })),
    groups,
    targets: objList(snap, 'targets', 'entities', 'initialTargets').map((t, i) => ({
      key: str(t, 'id', 'key') ?? `t${i}`,
      name: str(t, 'name', 'label') ?? `#${i + 1}`,
      status: str(t, 'threat', 'level'),
      text: str(t, 'valueTag', 'typeKey', 'motion'),
    })),
    overview: toMetrics(pick(snap, 'overview', 'systemOverview')),
  }
}

/**
 * 步 3 · `view.compose` 的视图（图层与工具可用性）。
 *
 * 实测回执（原样字段）：
 * ```json
 * {"modeKey":"overview","modeName":"综合态势","phaseKey":"T1","ok":true,"issues":[],
 *  "visibleGroups":["area","route","link","group","target","uav","mark"],
 *  "views":[{"viewKey":"","viewName":"","mode":{"modeKey":"overview","modeName":"综合态势"},
 *            "layers":{"visibleGroups":[…],"hiddenByMode":[…],"policy":…,"order":[…]},
 *            "tools":[{"key":"select","label":"选择","enabled":true,"implemented":true,
 *                      "state":"available","reasons":[]},
 *                     {"key":"measure","label":"测距","enabled":false,"implemented":false,
 *                      "reasons":["消费侧尚未实现（map-2d 仍未实现该工具）"]}],
 *            "controls":[{"key":"compass","label":"指北针","enabled":true}],
 *            "legend":[…]}]}
 * ```
 * 「能不能画」是 view-composer 说了算：本函数只把 `enabled/implemented/reasons` 读出来显示。
 */
export interface ComposeView {
  raw: unknown
  phase?: string
  modeKey?: string
  modeName?: string
  /** 可见的图层组（`visibleGroups` 的字符串数组，原样） */
  visibleGroups: string[]
  /** 可用工具（含"为什么不可用"的 reasons） */
  tools: { key: string; name: string; on: boolean; reason?: string }[]
  /** 控件（指北针/比例尺/缩放…） */
  controls: { key: string; name: string; on: boolean }[]
  /** 图例条目 */
  legend: string[]
  /** 宿主给的告警 */
  warnings: string[]
  issues: string[]
}

export function readCompose(data: unknown): ComposeView {
  const src = isObj(data) ? data : undefined
  const views = objList(src, 'views')
  const v0 = views[0]
  const mode = obj(v0, 'mode')
  return {
    raw: data,
    phase: str(src, 'phaseKey', 'phase') ?? str(mode, 'phaseKey'),
    modeKey: str(src, 'modeKey') ?? str(mode, 'modeKey'),
    modeName: str(src, 'modeName') ?? str(mode, 'modeName'),
    visibleGroups: strList(src, 'visibleGroups').length
      ? strList(src, 'visibleGroups')
      : strList(obj(v0, 'layers'), 'visibleGroups'),
    tools: objList(v0, 'tools').map((t, i) => {
      const key = str(t, 'key', 'id') ?? `t${i}`
      return {
        key,
        name: str(t, 'label', 'name', 'title') ?? key,
        on: bool(t, 'enabled', 'available', 'on') ?? true,
        reason: strList(t, 'reasons')[0] ?? str(t, 'state', 'declared'),
      }
    }),
    controls: objList(v0, 'controls').map((c, i) => {
      const key = str(c, 'key', 'id') ?? `c${i}`
      return { key, name: str(c, 'label', 'name') ?? key, on: bool(c, 'enabled', 'available') ?? true }
    }),
    legend: objList(v0, 'legend').flatMap((l) => strList(l, 'label', 'name', 'text')),
    warnings: strList(src, 'warnings'),
    issues: strList(src, 'issues'),
  }
}

// ---- 步 4/5 · 资源分配（alloc.*）------------------------------------------

/** 一个集群（方案里的一格）。字段全部"有就读、没有就空"。 */
export interface GroupView {
  key: string
  name: string
  /** 任务方向/任务属性（宿主给了才显示） */
  task?: string
  /** 覆盖区域 */
  area?: string
  /** 协同关系 */
  cooperation?: string
  /** 该集群的四型组成：域（原始英文/规则包取值）→ 数量 */
  mix: { domain: string; label: string; count?: number; percent?: number }[]
  /** 该集群的平台数（来自 `situation.snapshot.groups[].platformCount`） */
  platformCount?: number
  /** 资源 id（有就显示，便于和台账对数） */
  resourceIds: string[]
  /** 宿主给的其它数值（就绪率/资源数…） */
  metrics: Metric[]
}

/** 一个候选方案的视图。数值全部原样来自宿主。 */
export interface PlanView {
  id: string
  name: string
  /** 方案要点：`method`（如"多域协同压制"）+ `effect`（如"压制并覆盖"） */
  method?: string
  effect?: string
  summary?: string
  /** 预期效果（**来自 `score.metrics[].raw`**：覆盖率/链路稳定度/…） */
  effects: Metric[]
  /** 评分（`score`，宿主算的加权总分） */
  score?: number
  /** 候选自带的成功率（候选字段 `successRate`，与 score 不是一回事） */
  successRate?: number
  /** 宿主是否标了推荐（`candidate.recommendedHint` 或 `recommendedId` 对上） */
  recommended: boolean
  /** 该方案的排名（`score.rank`） */
  rank?: number
  /** 集群名列表（`candidate.clusters[]`，**名字是宿主的**） */
  clusters: string[]
  /** 集群明细（用 `clusters[]` 去 `situation.snapshot.groups[]` 对齐得到组成） */
  groups: GroupView[]
  /** 宿主给的其它数值 */
  metrics: Metric[]
  /** 该方案不适用的原因（宿主给了就显示） */
  inapplicableReasons: string[]
}

/** `alloc.plans` 的视图。 */
export interface PlansView {
  raw: unknown
  plans: PlanView[]
  recommendedId?: string
  /** 推荐评分（契约字段 `recommendedPercent`） */
  recommendedPercent?: number
  /** 与次优的领先幅度（契约字段 `leadOverNextPercent`） */
  leadOverNextPercent?: number
  /** 推荐理由（`reasons[]`：`{metricKey,type,value,refKey?}` → 人话） */
  reasons: string[]
  /** 次优方案（`nextId` / `nextPercent`，用于"领先次优"那句） */
  nextId?: string
  nextPercent?: number
  /** 台账/口径说明（`notes[]`，宿主原话） */
  notes: string[]
  /** 采集口径告警（`missingInputs[]`） */
  missingInputs: string[]
  missionId?: string
  scene?: string
}

/** 规则包给的 metric key → 中文（**只是词典**：键不认识就显示原 key）。 */
const METRIC_CN: Record<string, string> = {
  coverageRate: '区域覆盖率',
  linkStability: '链路稳定度',
  targetDetection: '目标发现效率',
  electronicSuppression: '电子压制能力',
  missionSuccess: '任务成功率',
  resourceUtilization: '资源利用率',
  strikeSuccess: '打击成功率',
}
export function metricCN(key: string, fallback?: string): string {
  return fallback ?? METRIC_CN[key] ?? key
}

/** 规则包给的评分理由类型 → 人话（不认识就显示原类型）。 */
const REASON_TYPE_CN: Record<string, string> = {
  'top-score': '该指标全场最高',
  'top-contribution': '该指标对总分贡献最大',
  lead: '明显领先次优方案',
  advantage: '相对次优方案占优',
}

/**
 * 把 `alloc.plans.reasons[]` 读成人话。
 *
 * 实测形状：`{"metricKey":"coverageRate","type":"top-score","value":96,"valueScaled":9600}`，
 * 也会带 `refKey`（比较对象）。**数值来自宿主**，这里只按 known-type 组成一句中文。
 */
function readPlanReasons(src: unknown): string[] {
  return objList(src, 'reasons').map((r) => {
    const key = str(r, 'metricKey', 'key') ?? ''
    const name = metricCN(key, str(r, 'name'))
    const type = str(r, 'type') ?? ''
    const value = num(r, 'value', 'valueScaled')
    const ref = str(r, 'refKey')
    const typeCN = REASON_TYPE_CN[type] ?? type
    const valTxt = value === undefined ? '' : `（${n2s(value)}）`
    return ref ? `${name}：${typeCN}，对比 ${ref}${valTxt}` : `${name}：${typeCN}${valTxt}`
  })
}

/** 一个集群的组成 → GroupView.mix。`counts` 有数才显示数，没有就不显示（不补 0）。 */
function mixFrom(byType?: { type: string; label: string; count: number }[]): GroupView['mix'] {
  if (!byType?.length) return []
  const sum = byType.reduce((a, b) => a + b.count, 0)
  return byType.map((t) => ({
    domain: t.type,
    label: t.label || uavTypeCN(t.type),
    count: t.count,
    // 百分比是**由宿主给的计数算出来的**（计数本身就是宿主的数），sum=0 时不给百分比
    percent: sum > 0 ? Number(((t.count / sum) * 100).toFixed(0)) : undefined,
  }))
}

/**
 * 把 `alloc.plans` 的回执读成视图。
 *
 * 实测形状（宿主已装配）：
 * ```json
 * {"items":[{"candidate":{"id":"grp-s1-b","name":"方案二｜多域协同压制方案","method":"多域协同压制",
 *                          "effect":"压制并覆盖","successRate":93,"recommendedHint":true,
 *                          "clusters":["前出侦察集群",…],"applicable":true,"inapplicableReasons":[]},
 *            "score":{"id":"grp-s1-b","score":93,"rank":1,"leadOverNextPercent":13,
 *                     "metrics":[{"key":"coverageRate","name":"区域覆盖率","raw":96,"unit":"%","weight":0.17},…]}}],
 *  "recommendedId":"grp-s1-b","recommendedPercent":93,"leadOverNextPercent":13,
 *  "nextId":"grp-s1-a","nextPercent":80,"reasons":[…],"notes":[…]}
 * ```
 * 「推荐」口径：`candidate.recommendedHint` 或 `recommendedId` 对上；两样都没有就**不标**。
 */
export function readPlans(data: unknown, groups?: GroupInfo[]): PlansView {
  const src = isObj(data) ? (obj(data, 'plans') ?? data) : undefined
  const items = objList(src, 'items', 'plans', 'candidates')
  const recId = str(src, 'recommendedId', 'recommendId', 'bestId')
  const recPercent = num(src, 'recommendedPercent', 'recommendPercent', 'bestPercent')

  /** 用集群名去 snapshot.groups 里找组成（同名才算，找不到就不给配比）。 */
  const groupOf = (name: string): GroupInfo | undefined => groups?.find((g) => g.name === name)

  const plans = items.map((row, i) => {
    // 实测：items[] 是 `{candidate, score}`；也兼容"候选字段直接摊平在 items[] 上"
    const cand = obj(row, 'candidate') ?? row
    const sc = obj(row, 'score')
    const id = str(cand, 'id', 'planId', 'key') ?? str(sc, 'id') ?? `p${i}`
    const rank = num(sc, 'rank', 'seq')
    const clusters = strList(cand, 'clusters', 'clusterNames')
    const successRate = num(cand, 'successRate', 'rate')
    const metrics = toMetrics(pick(sc, 'metrics', 'items'))
      // 预期效果：`raw` 是规则包给的原始值（覆盖率 96 等），`value` 位没有就落到 raw
      .map((m) => ({ ...m }))
    const effects: Metric[] = objList(sc, 'metrics').map((m, j) => ({
      key: str(m, 'key', 'id') ?? `m${j}`,
      name: metricCN(str(m, 'key') ?? '', str(m, 'name')),
      value: num(m, 'raw', 'value'),
      unit: str(m, 'unit'),
      text: bool(m, 'missing') ? `缺失（${str(m, 'missingMarker') ?? '—'}）` : undefined,
    }))
    const scoreTotal = num(sc, 'score', 'total', 'percent') ?? num(cand, 'score')
    return {
      id,
      name: str(cand, 'name', 'title', 'label') ?? str(sc, 'name') ?? id,
      method: str(cand, 'method', 'approach'),
      effect: str(cand, 'effect', 'expectedEffect'),
      summary: str(cand, 'summary', 'desc', 'detail'),
      effects,
      score: scoreTotal,
      successRate,
      recommended: (bool(cand, 'recommendedHint', 'recommended') ?? false) || (recId !== undefined && recId === id),
      rank,
      clusters,
      groups: clusters.map((cn, k) => {
        const gi = groupOf(cn)
        return {
          key: `${id}-${k}`,
          name: cn,
          mix: mixFrom(gi?.byType),
          platformCount: gi?.platformCount,
          task: gi?.role,
          resourceIds: [],
          metrics: [],
        }
      }),
      metrics,
      inapplicableReasons: strList(cand, 'inapplicableReasons'),
    }
  })

  return {
    raw: data,
    plans,
    recommendedId: recId,
    recommendedPercent: recPercent,
    leadOverNextPercent: num(src, 'leadOverNextPercent', 'leadPercent', 'gapPercent'),
    reasons: readPlanReasons(src),
    nextId: str(src, 'nextId'),
    nextPercent: num(src, 'nextPercent'),
    notes: strList(src, 'notes', 'summary', 'brief'),
    missingInputs: strList(src, 'missingInputs'),
    missionId: str(src, 'missionId'),
    scene: str(src, 'scene', 'scenarioKey'),
  }
}

/**
 * `alloc.inventory` 的视图（库存视图：四型 总/可用/已分配/待分配）。
 *
 * 实测形状：
 * ```json
 * {"items":[{"type":"comm","name":"通信中继无人机","total":24,"available":24,"allocated":0,
 *            "pending":24,"unit":"架","abilityTags":["中继","组网"],"onlineRate":0,"onlineDevices":0}],
 *  "totals":{"comm":24,…},"totalAll":132,"allocatedTotal":0,"pendingTotal":132,
 *  "utilization":0,"onlineRate":0,"clusters":[…],"idempotent":true}
 * ```
 * 参考图底部那条「当前编组资源 124/132 · 待分配 · 资源利用率 86%」就读它。
 */
export interface InventoryView {
  raw: unknown
  rows: {
    key: string
    name: string
    total?: number
    available?: number
    assigned?: number
    unassigned?: number
    unit?: string
    onlineRate?: number
    /** 任务能力标签（宿主给了才显示） */
    tags: string[]
  }[]
  /** 台账总体数值（当前编组资源 / 待分配资源 / 资源利用率 / 在线率 / 集群数…） */
  totals: Metric[]
}

/** 台账里 0..1 的比例 → 百分数。**只有这一处换算**，且规则单一：≤1 视为比例。 */
function ratioToPercent(v: number | undefined): number | undefined {
  if (v === undefined) return undefined
  return v <= 1 ? Number((v * 100).toFixed(0)) : v
}

function readInvRow(v: unknown, i: number) {
  const key = str(v, 'type', 'key', 'id', 'domain') ?? `r${i}`
  const total = num(v, 'total', 'count', 'qty')
  const assigned = num(v, 'allocated', 'assigned', 'used')
  return {
    key,
    name: str(v, 'name', 'label', 'title') ?? uavTypeCN(key),
    total,
    available: num(v, 'available', 'usable', 'online', 'avail'),
    assigned,
    // 待分配：宿主给了就用；只给了 total/allocated 才做**减法**（恒等式，不是业务判断）。
    unassigned: num(v, 'pending', 'unassigned', 'free', 'idle')
      ?? (total !== undefined && assigned !== undefined ? Math.max(0, total - assigned) : undefined),
    unit: str(v, 'unit'),
    onlineRate: num(v, 'onlineRate'),
    tags: strList(v, 'abilityTags', 'tags', 'capabilities'),
  }
}

export function readInventory(data: unknown): InventoryView {
  const src = isObj(data) ? data : undefined
  const rows = objList(src, 'items', 'rows', 'types', 'resources', 'byType')
  const unit = str(src, 'unit') ?? '架'
  const totalAll = num(src, 'totalAll', 'total')
  const allocatedTotal = num(src, 'allocatedTotal', 'allocated')
  const pendingTotal = num(src, 'pendingTotal')
  const clusters = objList(src, 'clusters')

  const totals: Metric[] = []
  if (totalAll !== undefined || allocatedTotal !== undefined) {
    totals.push({ key: 'grouped', name: '当前编组资源', text: `${n2s(allocatedTotal)}/${n2s(totalAll)}` })
  }
  if (pendingTotal !== undefined) totals.push({ key: 'pending', name: '待分配资源', value: pendingTotal, unit })
  const util = ratioToPercent(num(src, 'utilization'))
  if (util !== undefined) totals.push({ key: 'utilization', name: '资源利用率', value: util, unit: '%' })
  const online = ratioToPercent(num(src, 'onlineRate'))
  if (online !== undefined) totals.push({ key: 'onlineRate', name: '在线率', value: online, unit: '%' })
  if (clusters.length) {
    totals.push({
      key: 'clusters', name: '集群数量', value: clusters.length, unit: '个',
      text: `${clusters.filter((c) => (num(c, 'total') ?? 0) > 0).length} 已编组`,
    })
  }
  return { raw: data, rows: rows.map(readInvRow), totals }
}

/** 从库存行里按域取一行（找不到返回 undefined——界面显示"—"，不编 0）。 */
export function invRowOf(inv: InventoryView | null, domain: string) {
  if (!inv) return undefined
  const d = domain.toLowerCase()
  return inv.rows.find((r) => r.key.toLowerCase() === d
    || uavTypeCN(r.key) === uavTypeCN(domain)
    || r.name.includes(uavTypeCN(domain)))
}

// ---- 步 5 · 编组下达（alloc.confirm / alloc.assign）------------------------

/** `alloc.confirm` 的视图。 */
export interface ConfirmView {
  raw: unknown
  planId?: string
  /** scoring 的 planState（`confirmed`…）——**域，不翻译成结论** */
  planState?: string
  /** 本次动作（`confirmed` / `already-applied`…） */
  action?: string
  status?: string
  idempotent?: boolean
  /** 偏离/冲突标志（宿主给了就显示，别让它们静默） */
  deviated?: boolean
  conflict?: boolean
  autoAdopted?: boolean
  /** 促使采纳的未满足项（`unmet[]`） */
  unmet: string[]
  invalidated: string[]
}

export function readConfirm(data: unknown): ConfirmView {
  const src = isObj(data) ? data : undefined
  const ev = obj(src, 'event')
  return {
    raw: data,
    planId: str(src, 'planId') ?? str(ev, 'planId'),
    planState: str(src, 'planState') ?? str(ev, 'planState'),
    action: str(src, 'action') ?? str(ev, 'action'),
    status: str(src, 'status'),
    idempotent: bool(src, 'idempotent') ?? bool(ev, 'idempotent'),
    deviated: bool(src, 'deviated'),
    conflict: bool(src, 'conflict'),
    autoAdopted: bool(src, 'autoAdopted'),
    unmet: strList(src, 'unmet'),
    invalidated: strList(src, 'invalidated'),
  }
}

/** `alloc.assign` 的视图。 */
export interface AssignView {
  raw: unknown
  clusterCount?: number
  allocatedClusters?: number
  /** 每个集群的下达结果（**`code` 逐集群给**，不是"整体成功"） */
  perCluster: {
    clusterId?: string
    planCluster?: string
    count?: number
    mix: { model: string; label: string; count: number }[]
    applied?: boolean
    idempotent?: boolean
    code?: number
    message?: string
    allocatedTotal?: number
  }[]
  /** 逐设备注册结果（台账实体） */
  entities: { clusterId?: string; deviceId?: string; model?: string; ok?: boolean; code?: number; message?: string }[]
  /** 台账登记被挡下的原因（**必须显示**：assign 可能 code=0 但实体没建成） */
  blocked?: { stage?: string; reason?: string; needs?: string }
  /** 集群映射（方案集群名 ↔ 台账 groupKey） */
  clusterMapping: { groupKey?: string; planCluster?: string; matched?: boolean; platforms?: number }[]
}

export function readAssign(data: unknown): AssignView {
  const src = isObj(data) ? data : undefined
  const list = objList(src, 'allocation')
  const blockedRaw = obj(src, 'blocked')
  return {
    raw: data,
    clusterCount: num(src, 'clusterCount'),
    allocatedClusters: num(src, 'allocatedClusters'),
    perCluster: list.map((a) => ({
      clusterId: str(a, 'clusterId'),
      planCluster: str(a, 'planCluster'),
      count: num(a, 'count'),
      allocatedTotal: num(a, 'allocatedTotal'),
      mix: objList(a, 'allocation').map((m) => {
        const model = str(m, 'model', 'type') ?? 'unknown'
        return { model, label: uavTypeCN(model), count: num(m, 'count') ?? 0 }
      }),
      applied: bool(a, 'applied'),
      idempotent: bool(a, 'idempotent'),
      code: num(a, 'code'),
      message: str(a, 'message'),
    })),
    entities: objList(src, 'entities').map((e) => ({
      clusterId: str(e, 'clusterId'),
      deviceId: str(e, 'deviceId'),
      model: str(e, 'model', 'typeKey'),
      ok: bool(e, 'ok'),
      code: num(e, 'code'),
      message: str(e, 'message'),
    })),
    blocked: blockedRaw
      ? { stage: str(blockedRaw, 'stage'), reason: str(blockedRaw, 'reason'), needs: str(blockedRaw, 'needs') }
      : undefined,
    clusterMapping: objList(src, 'clusterMapping').map((m) => ({
      groupKey: str(m, 'groupKey'),
      planCluster: str(m, 'planCluster'),
      matched: bool(m, 'matched'),
      platforms: num(m, 'platforms'),
    })),
  }
}

/** 四型顺序（只用于**排序**，不用于编数）：场景一就这四型，宿主没给的类型不显示。 */
export const TYPE_ORDER = ['optical', 'radar', 'electronic', 'comm']

/** 按四型顺序排一下（读不到的排在后面，保持宿主给的原顺序）。 */
export function sortByType<T extends { key: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const ia = TYPE_ORDER.indexOf(a.key.toLowerCase())
    const ib = TYPE_ORDER.indexOf(b.key.toLowerCase())
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })
}

/**
 * 回执的一句话人话。**宿主的原话照抄**，前端只补一句前缀。
 * 这一步是"如实显示未实现"的落点：`code=1000 未知 verb：alloc.plans` 会原样出现在界面上。
 */
export function replyText(reply: CommandReply | null | undefined): string {
  if (!reply) return ''
  if (reply.code === 0) return ''
  return `code=${reply.code}：${reply.error?.message ?? '（宿主未给原因）'}`
}

/** 宿主是否"还不认识这条 verb"（未实现 / 未装配）——界面据此换一种措辞。 */
export function notImplemented(reply: CommandReply | null | undefined): boolean {
  return !!reply && (reply.code === 1000 || reply.code === 1005)
}

/** 状态标签的三种颜色：好/坏/未知（与 theme.statusColor 同口径，这里给未实现用）。 */
export function replyColor(reply: CommandReply | null | undefined): string {
  if (!reply || reply.code === 0) return '#64748b'
  return notImplemented(reply) ? '#f59e0b' : '#ef4444'
}
