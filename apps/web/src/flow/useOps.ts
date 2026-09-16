// mission-app · apps/web/src/flow/useOps.ts
//
// 步 6–7（任务执行 / 实时侦察目标显示）的**数据层**。
//
// 与 `useSituation.ts` 同一套路，三层职责：
//   ① 复用 `useVerbOnce` 发命令（在屏里调，不在这里）；
//   ② `readSim / readTopology / readSensor / readTargets / readTargetDetail / readMedia`
//      —— 把宿主的 JSON 读成界面要的形状。只做"取字段 + 兜底"，**不加一个数、不判一次状态**；
//   ③ `linkColor / actionCN` —— 词典：把规则包给的**域**（domain）折成颜色 / 中文。
//      域不认识就原样显示英文，MUST NOT 猜。
//
// ★ 本文件为什么存在（写给后来者）：
//   写这份代码时，步 6–7 的 verb（`sim.*` / `topology.evaluate` / `sensor.status` /
//   `targets.*` / `media.channels`）在宿主侧**还没装配**（实测一律 `code=1000 未知 verb`）。
//   所以这里对字段名全部**防御式读取**：同一语义按"契约名 → 常见别名"依次试；
//   读不到就留空，界面显示"未就绪 + code"，绝不补 0、绝不编一个绿黄红。
//
// ⚠ 两条最容易被写错的纪律，写在这里：
//   · **链路颜色不自己判**：绿/黄/红只由规则包给的域经词典映射（`linkColor`），
//     域不认识 → 中性灰 + 原样显示域文本；
//   · **覆盖率/遍历周期不自己算**：全部来自 `sensor.status` 回执；字段改名了就用
//     `SensorView.pairs`（回执里所有数值字段的原样清单）兜住，保证"看见的数就是宿主给的数"。
import { C } from '../theme'
import {
  arr, bool, isObj, n2s, num, obj, objList, pick, str, strList, toMetrics,
  type Metric,
} from './useSituation'

type J = Record<string, unknown>

/**
 * 计量行**净化**：`toMetrics` 会把裸对象里的字符串值也塞进 `value` 位
 * （`Number("（合成负载预演）")` → `NaN`），而界面"有 value 就显示 value"→ 屏上出现 `NaN`。
 * **NaN 上屏等于编了一个数**，所以这里把非有限值退回文本位、数值位留空（界面显示文字）。
 */
function sane(rows: Metric[]): Metric[] {
  return rows.map((m) => (
    m.value !== undefined && !Number.isFinite(m.value)
      ? { ...m, value: undefined, text: m.text ?? String(m.value) }
      : m
  ))
}

/**
 * 读"一组计量行"。三种形状都收：
 *   ① 直接用数组 `[{name,value}]`；② 对象包一层 `{items|metrics|lines:[…]}`；③ 裸对象 `{a:1,b:2}`。
 *
 * （`toMetrics` 本身既能读数组也能读对象，但它带 keys 时会先 `pick` —— 对"已经是数组"
 *  的入参就会读空。所以统一从这里进，三种形状分流一次。）
 */
function metricsAt(v: unknown, ...keys: string[]): Metric[] {
  const x = keys.length ? pick(v, ...keys) : v
  if (Array.isArray(x)) return sane(toMetrics(x))
  if (isObj(x)) {
    if (Array.isArray(x.items) || Array.isArray(x.metrics) || Array.isArray(x.lines)) {
      return sane(toMetrics(x, 'items', 'metrics', 'lines'))
    }
    return sane(toMetrics(x))
  }
  return []
}

// ============================================================================
// ① 仿真控制面（`sim.start` / `sim.pause` / `sim.resume` / `sim.speed` / `sim.state`）
// ============================================================================

/** 契约冻结的三档倍速（`sim.speed{speed:1|8|60}`）。界面只发这三个值。 */
export const SIM_SPEEDS = [1, 8, 60] as const
export type SimSpeed = (typeof SIM_SPEEDS)[number]

/**
 * `sim.state` 事件的视图（**事件**驱动，不是 verb）。
 *
 * 契约形状：`{running, speed, simElapsedMs, platforms, emitted}`。
 * `platforms` 宿主可能给数、也可能给数组（那就显示数组长度——那是宿主的数，不是我们算的）。
 */
export interface SimView {
  raw: unknown
  running?: boolean
  speed?: number
  simElapsedMs?: number
  /** 在跑的平台数（宿主给数就用数；给数组就用它自己的长度） */
  platforms?: number
  /** 已发出的仿真事件数（宿主计数） */
  emitted?: number
  /** 宿主给的其它数值/文本（原样列出，界面不挑） */
  metrics: Metric[]
  /** 宿主给的说明（有就显示） */
  note?: string
  /** 事件到达时刻（前端时钟；只用于显示"多久没更新"） */
  at?: number
}

export function readSim(data: unknown, at?: number): SimView {
  const src = isObj(data) ? data : undefined
  const platformsRaw = pick(src, 'platforms', 'platformCount', 'uavs')
  const platforms = typeof platformsRaw === 'number'
    ? platformsRaw
    : Array.isArray(platformsRaw) ? platformsRaw.length : undefined
  // 已经单独显示的字段、以及"文本类"字段（note/message/detail）不再重复列进 metrics
  const shown = new Set(['running', 'speed', 'simElapsedMs', 'platforms', 'platformCount', 'uavs', 'emitted', 'note', 'message', 'detail'])
  return {
    raw: data,
    running: bool(src, 'running', 'started', 'active'),
    speed: num(src, 'speed', 'speedMultiple', 'rate'),
    simElapsedMs: num(src, 'simElapsedMs', 'elapsedMs', 'simTimeMs'),
    platforms,
    emitted: num(src, 'emitted', 'emittedCount', 'events'),
    metrics: sane(toMetrics(src)).filter((m) => !shown.has(m.key)),
    note: str(src, 'note', 'message', 'detail'),
    at,
  }
}

/** 仿真时长（ms）→ 人话（`mm:ss`）。**只做单位换算，不改数值口径。** */
export function ms2clock(ms?: number): string {
  if (ms === undefined) return '—'
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// ============================================================================
// ② 链路评估（`topology.evaluate`）
// ============================================================================

/**
 * 链路状态域 → 颜色。
 *
 * **这是词典，不是判断**：域来自规则包（`stable/weak/limited` 或 `green/yellow/red`…），
 * 本函数只做"域 → 颜色"。不认识 → `C.unknown`（中性灰）+ 界面原样显示域文本（不猜成绿的）。
 * 口径对齐需求文档 §9.4：绿=稳定/已连接、黄=波动/弱链路、红=受限。
 *
 * ⚠ 实测（`topology.evaluate` 回执 `links[].state`）本工程用的是**颜色词**：`green/yellow/red`
 *   —— 所以两套词汇都要收；将来规则包换成语义词（stable/weak/limited）也不用改这里。
 */
export function linkColor(domain?: string): string {
  const s = (domain ?? '').toLowerCase()
  if (['stable', 'connected', 'ok', 'normal', 'online', 'good', 'strong', 'up', 'green'].includes(s)) return C.ok
  if (['weak', 'fluctuating', 'degraded', 'unstable', 'warn', 'partial', 'intermittent', 'yellow', 'amber', 'orange'].includes(s)) return C.warn
  if (['limited', 'restricted', 'blocked', 'down', 'lost', 'fail', 'failed', 'offline', 'broken', 'red'].includes(s)) return C.bad
  return C.unknown
}

/** 一条链路（宿主给什么显示什么）。 */
export interface LinkRow {
  key: string
  name: string
  from?: string
  to?: string
  /** 规则包给的域（原样显示；颜色由 `linkColor` 映射） */
  status?: string
  /** 该链路的质量指标（信号强度/带宽/时延/丢包率…宿主给多少显示多少） */
  metrics: Metric[]
  note?: string
}

export interface TopologyView {
  raw: unknown
  links: LinkRow[]
  /** 宿主自报的链路总数（实测量 `linkCount`；没给就 undefined，不拿 `links.length` 冒充） */
  linkCount?: number
  /** 按域统计的链路条数（**数宿主给的 links[]**，只用于显示分布） */
  byState: { state: string; count: number }[]
  /** 链路两端节点（宿主给了就画列表；没给就不显示这一块） */
  nodes: { key: string; name: string; status?: string; text?: string }[]
  /** 评估汇总（链路总数/各状态条数/稳定度…宿主给了才显示） */
  totals: Metric[]
  /** 网络评估类指标（链路稳定度/覆盖率/协同效率/抗干扰能力…） */
  metrics: Metric[]
  /** 网络评估总分（实测 `evaluation.overall`，0–1；没给就是 undefined） */
  overall?: number
  /** 推荐链路组织方式等**结论文本**（宿主原话） */
  advice: string[]
  notes: string[]
}

/** 网络评估项 key → 中文（词典；不认识就显示原 key）。 */
const EVAL_KEY_CN: Record<string, string> = {
  stability: '链路稳定度', coverage: '覆盖率', coordination: '协同效率',
  antiJamming: '抗干扰能力', jamming: '抗干扰能力', efficiency: '效率', reliability: '可靠性',
}

/**
 * 把 `evaluation.items[]` 读成"名 + 值"。
 *
 * 实测：`{key:"stability", value:0.5625, weight:0.35, scaleMin:0, scaleMax:1, requirement:{satisfied:false}}`
 * —— 值是**宿主的 0–1 尺度**，本函数**不换算成百分比**（换算就等于替宿主定口径了），
 * 只在 text 里把权重/尺度/判据原样标出来。
 */
function evalMetrics(ev: unknown): Metric[] {
  return objList(ev, 'items').map((it, i) => {
    const key = str(it, 'key', 'id') ?? `e${i}`
    const scaleMin = num(it, 'scaleMin')
    const scaleMax = num(it, 'scaleMax')
    const weight = num(it, 'weight')
    const satisfied = bool(obj(it, 'requirement'), 'satisfied')
    return {
      key,
      // 加"网络·"前缀：这一组是**网络评估**的项（0–1 尺度），与 `sensor.status` 的
      // 区域覆盖率是两套口径，同屏出现时必须能分辨（实测两者会同时为 0 与 100%）
      name: `网络·${EVAL_KEY_CN[key] ?? str(it, 'name') ?? key}`,
      value: num(it, 'value', 'normalized'),
      text: [
        weight !== undefined ? `权重 ${weight}` : null,
        scaleMin !== undefined && scaleMax !== undefined ? `尺度 ${scaleMin}–${scaleMax}` : null,
        satisfied !== undefined ? `判据 ${satisfied ? '满足' : '未满足'}` : null,
      ].filter(Boolean).join(' · ') || undefined,
    }
  })
}

/** 取链路行的"端点名"：`from/to` 可能是字符串、也可能是 `{id,name}`。 */
function endpointName(v: unknown): string | undefined {
  if (typeof v === 'string' && v) return v
  if (typeof v === 'number') return String(v)
  if (isObj(v)) return str(v, 'name', 'label', 'key', 'id')
  return undefined
}

/**
 * 行内指标。
 *
 * 实测两种形状都要收：
 *   ① 链路：`metrics:[{key:"bandwidthMbps", last:0.0196, mean:…, max:…, unit:"Mbps"}]`
 *      —— **数值在 `last`（最新一次观测）**，不是 `value`；键是 `bandwidthMbps/lossRate` 这种英文键。
 *   ② 传感器行：`coverageAreaKm2 / revisitPeriodMs / maxRangeM …` 直接挂在行上（标量）。
 * `rowMetrics` 把两种都读出来，并给英文键配中文名（词典，不认识就显示原键）。
 */
function rowMetrics(row: J): Metric[] {
  const out: Metric[] = []
  // ① 数组形态：链路 `metrics[]`（key + last/mean）与传感器那类 `indicators[]`
  const list = pick(row, 'metrics', 'indicators', 'quality', 'values')
  if (Array.isArray(list)) {
    for (const it of list) {
      if (!isObj(it)) continue
      const key = str(it, 'key', 'id') ?? ''
      out.push({
        key: key || `m${out.length}`,
        name: linkMetricCN(key, str(it, 'name', 'label', 'title')),
        value: num(it, 'last', 'mean', 'value', 'raw'),
        unit: str(it, 'unit'),
        text: str(it, 'text', 'detail'),
      })
    }
  } else if (isObj(list)) {
    out.push(...metricsAt(list))
  }
  const known: [string, string, string?][] = [
    ['signalStrength', '信号强度'], ['rssi', '信号强度'],
    ['bandwidth', '带宽'], ['bandwidthMbps', '带宽', 'Mbps'],
    ['latencyMs', '时延', 'ms'], ['delayMs', '时延', 'ms'], ['latency', '时延'],
    ['lossRate', '丢包率'], ['packetLoss', '丢包率'],
    ['coverage', '覆盖范围'], ['rangeKm', '覆盖范围', 'km'], ['rangeM', '覆盖范围', 'm'],
    ['progress', '局部组网进度'], ['meshProgress', '局部组网进度'],
    ['load', '负载'], ['utilization', '利用率'],
    // —— 传感器行（`sensor.status.sensors[]`）的实测字段
    ['coverageAreaKm2', '覆盖面积', 'km²'],
    ['revisitPeriodMs', '重访周期', 'ms'], ['scanPeriodMs', '扫描周期', 'ms'],
    ['maxRangeM', '最大距离', 'm'], ['sectorRadiusM', '扇区半径', 'm'],
    ['sectorSpanDeg', '扇区张角', '°'], ['altM', '高度', 'm'], ['headingDeg', '航向', '°'],
  ]
  const have = new Set(out.map((m) => m.key))
  for (const [key, name, unit] of known) {
    const v = num(row, key)
    if (v === undefined || have.has(key)) continue
    out.push({ key, name, value: v, unit: str(row, `${key}Unit`) ?? unit })
    have.add(key)
  }
  return out
}

/** 链路指标英文键 → 中文（词典；不认识就显示原键）。 */
const LINK_METRIC_CN: Record<string, string> = {
  bandwidthMbps: '带宽', lossRate: '丢包率', latencyMs: '时延', signal: '信号强度',
  coverageKm2: '覆盖范围', nodeLoad: '节点负载', cacheAvailable: '本地缓存可用',
  cacheTotal: '本地缓存总量', meshProgress: '局部组网进度',
}
function linkMetricCN(key: string, fallback?: string): string {
  return fallback ?? LINK_METRIC_CN[key] ?? key
}

export function readTopology(data: unknown): TopologyView {
  const src = isObj(data) ? data : undefined
  /**
   * 链路数组在哪一层 —— **不能无脑 `data.topology`**：
   * 实测 `data` 自己带 `links`（10~15 条），而 `data.topology` 是**另一份结构**
   * （`{nodes,edges,linkTo,configured,reused,topologyId}`，里面没有 links）。
   * 所以按"哪层真有数组"依次试，而不是按"哪个键名更像"。
   */
  const topLevel = objList(pick(src, 'links', 'edges', 'items', 'rows', 'pairs'))
  const linkRaw = topLevel.length
    ? topLevel
    : [...objList(obj(src, 'topology'), 'links', 'edges'), ...objList(obj(src, 'snapshot'), 'links', 'edges')]
  const links: LinkRow[] = linkRaw.map((r, i) => {
    const from = endpointName(pick(r, 'from', 'source', 'src', 'a', 'fromName'))
    const to = endpointName(pick(r, 'to', 'target', 'dst', 'b', 'toName'))
    const name = str(r, 'name', 'label', 'id', 'key', 'linkId')
      ?? (from || to ? `${from ?? '?'} → ${to ?? '?'}` : `链路 ${i + 1}`)
    return {
      key: str(r, 'linkId', 'id', 'key') ?? `l${i}`,
      name,
      from,
      to,
      // 「状态」位按实测名 → 契约名 → 常见别名依次试；一律**原样**（域不翻译成结论）
      status: str(r, 'state', 'status', 'quality', 'linkState', 'level', 'health'),
      metrics: rowMetrics(r),
      note: str(r, 'note', 'reason', 'detail', 'message'),
    }
  })
  const nodes = objList(pick(src, 'nodes', 'vertices', 'points')).map((n, i) => ({
    key: str(n, 'id', 'key') ?? `n${i}`,
    name: str(n, 'name', 'label') ?? `节点 ${i + 1}`,
    status: str(n, 'status', 'state', 'kind', 'role'),
    text: str(n, 'text', 'detail'),
  }))
  // 汇总：`linkCount`（宿主自报）+ `totals/summary/counts` 里的其它数
  const totals: Metric[] = []
  const linkCount = num(src, 'linkCount', 'totalLinks')
  if (linkCount !== undefined) totals.push({ key: 'linkCount', name: '链路总数（宿主字段）', value: linkCount })
  totals.push(...metricsAt(pick(src, 'totals', 'summary', 'counts', 'byStatus', 'stats')))
  // 按域统计（数宿主给的 links[]，不是判状态）
  const stateCount = new Map<string, number>()
  for (const l of links) if (l.status) stateCount.set(l.status, (stateCount.get(l.status) ?? 0) + 1)
  const byState = [...stateCount.entries()].map(([state, count]) => ({ state, count }))
  const ev = obj(src, 'evaluation') ?? obj(src, 'network')
  const metrics = [...evalMetrics(ev), ...metricsAt(src, 'metrics')]
  const advice = [
    ...strList(src, 'advice', 'recommendation', 'recommendations', 'conclusions', 'suggestions'),
    ...strList(ev, 'advice', 'message', 'conclusions'),
  ]
  return {
    raw: data,
    links,
    linkCount,
    byState,
    nodes,
    totals,
    metrics,
    overall: num(ev, 'overall', 'score'),
    advice,
    notes: strList(src, 'notes', 'note', 'explain'),
  }
}

// ============================================================================
// ③ 传感器读数（`sensor.status`）—— 覆盖率 / 遍历周期
// ============================================================================

/** 一行传感器读数（逐设备/逐平台，引擎算的，界面只显示）。 */
export interface SensorRow {
  key: string
  name: string
  status?: string
  metrics: Metric[]
  note?: string
}

export interface SensorView {
  raw: unknown
  /** 覆盖率类读数（字段名按别名试；读不到就是 undefined —— 界面显示"—"） */
  coverage?: Metric
  /** 遍历周期类读数（同上） */
  sweep?: Metric
  /** 头部汇总指标（除已单列的 coverage/sweep 之外，宿主给的都列出来） */
  metrics: Metric[]
  /** 逐传感器/逐平台明细 */
  rows: SensorRow[]
  /** 按机型汇总（实测 `byType`：平台数 / 覆盖面积 / 重访周期） */
  byType: { key: string; name: string; platforms?: number; coverageKm2?: number; revisitMs?: number }[]
  /**
   * 兜底：回执里**所有**数值/短文本字段的原样清单（`路径 → 值`）。
   *
   * 为什么要有它：契约只钉死了 verb 名，没钉死字段名。字段一旦改名（`coverage` →
   * `coverageRatio` 之类），"界面看不见覆盖率"会伪装成"引擎没算"。这一栏保证
   * **宿主给了什么数，界面上就一定能看到**，且不带任何口径改写。
   */
  pairs: { path: string; value: string }[]
  notes: string[]
}

/** 递归收集"数值/短文本"叶子（最多 `limit` 条，避免把大结构铺满屏）。 */
function numericPairs(v: unknown, prefix = '', out: { path: string; value: string }[] = [], limit = 60): { path: string; value: string }[] {
  if (out.length >= limit) return out
  if (v === null || v === undefined) return out
  if (typeof v === 'number' || typeof v === 'boolean') {
    out.push({ path: prefix || 'value', value: String(v) })
    return out
  }
  if (typeof v === 'string') {
    if (v.length > 0 && v.length <= 40) out.push({ path: prefix || 'value', value: v })
    return out
  }
  if (Array.isArray(v)) {
    v.slice(0, 8).forEach((it, i) => numericPairs(it, `${prefix}[${i}]`, out, limit))
    return out
  }
  if (isObj(v)) {
    for (const [k, val] of Object.entries(v)) {
      if (out.length >= limit) break
      numericPairs(val, prefix ? `${prefix}.${k}` : k, out, limit)
    }
  }
  return out
}

/**
 * 从一组候选键里挑第一个"有值"的读成 Metric。
 *
 * 两种取值形态都收（实测都有）：
 *   · 标量：`coverageRatio: 283.11` → value + 单位推断；
 *   · **对象**：`revisitPeriodMs: {count:10, mean:2966.7, min:1000, max:4000}`
 *     → 取 `mean` 当主值，`min/max/样本数` 进 text（**原样标注，不改口径**）。
 */
function pickMetric(src: unknown, keys: string[], name: string): Metric | undefined {
  for (const k of keys) {
    const raw = isObj(src) ? src[k] : undefined
    if (isObj(raw)) {
      const mean = num(raw, 'mean', 'avg', 'last')
      if (mean !== undefined) {
        const unit = str(raw, 'unit') ?? unitOf(k)
        const min = num(raw, 'min')
        const max = num(raw, 'max')
        const count = num(raw, 'count', 'samples')
        return {
          key: k, name, value: mean, unit,
          text: [
            min !== undefined ? `min ${n2s(min, unit ?? '')}` : null,
            max !== undefined ? `max ${n2s(max, unit ?? '')}` : null,
            count !== undefined ? `样本 ${count}` : null,
          ].filter(Boolean).join(' · ') || undefined,
        }
      }
      // 只有 max/min 的对象：退而取 max（并把原始字段名标出来）
      const only = num(raw, 'max', 'min')
      if (only !== undefined) return { key: k, name, value: only, unit: unitOf(k), text: '（对象里只有 max/min）' }
    }
    const v = num(src, k)
    if (v !== undefined) {
      return { key: k, name, value: v, unit: str(src, `${k}Unit`) ?? unitOf(k), text: str(src, `${k}Text`) }
    }
    const t = str(src, k)
    if (t !== undefined) return { key: k, name, text: t }
  }
  return undefined
}

/**
 * 字段名 → 单位（**只是显示后缀**，不改数值；唯一的例外是 `coverageRatio`，见 `readSensor`）。
 */
function unitOf(k: string): string | undefined {
  if (/Percent$/.test(k)) return '%'
  if (/Ms$/.test(k)) return 'ms'
  if (/Km2$/.test(k)) return 'km²'
  if (/M2$/.test(k)) return 'm²'
  if (/Km$/.test(k)) return 'km'
  if (/M$/.test(k)) return 'm'
  if (/Deg$/.test(k)) return '°'
  return undefined
}

/** 0–1 比例 → 百分数（**只这一处换算**，规则单一：≤1 视为比例；与 `useSituation.ratioToPercent` 同口径）。 */
function ratioToPercent(v: number | undefined): number | undefined {
  if (v === undefined) return undefined
  return v <= 1 ? Number((v * 100).toFixed(1)) : v
}

export function readSensor(data: unknown): SensorView {
  // 顶层就是那份读数（实测）；给 `sensor/sensors` 包一层的形状也收
  const inner = obj(data, 'sensor') ?? obj(data, 'sensors')
  const src = inner && (num(inner, 'coverageRatio', 'coverageRate') !== undefined) ? inner : (isObj(data) ? data : undefined)
  /**
   * 覆盖率 —— 实测两个字段**口径不同**，界面必须分开写清楚（宿主 notes 原话）：
   *   · `coverageRatio`：**任务区被覆盖的比例**，有界 [0,1]（打格点判定、重叠只算一次）→ 本屏按 % 显示（×100，一处换算）；
   *   · `coverageUpperBoundRatio`：Σ覆盖面积 ÷ 任务区面积（**未去重叠**、含全向大范围传感器），
   *     只作**上界参照**，不是覆盖率 → 单独一行标"上界"，绝不当覆盖率用。
   */
  const coverRaw = num(src, 'coverageRatio', 'coverageRate', 'coveragePercent')
  const coverage: Metric | undefined = coverRaw === undefined
    ? pickMetric(src, ['coverage', 'coveredPercent', 'areaCoverage'], '区域覆盖率')
    : {
      key: 'coverageRatio',
      name: '区域覆盖率',
      value: ratioToPercent(coverRaw),
      unit: '%',
      text: coverRaw <= 1 ? `字段 coverageRatio=${coverRaw}（0–1 比例 → ×100 显示）` : `字段 coverageRatio=${coverRaw}（已是百分数量纲）`,
    }
  // 遍历周期：实测 `revisitPeriodMs`（对象 {count,mean,min,max}）；扫描周期单列 `scanPeriodMs`
  const sweep = pickMetric(src,
    ['revisitPeriodMs', 'scanPeriodMs', 'sweepPeriodMs', 'traversalPeriodMs', 'cycleMs', 'scanCycleMs', 'traversalPeriod'], '遍历周期')
  const rows = objList(pick(src, 'sensors', 'items', 'devices', 'rows', 'readings', 'platforms')).map((r, i) => {
    const sensorId = str(r, 'sensorId', 'deviceId', 'id', 'key')
    const platform = str(r, 'platformId', 'deviceId')
    const device = str(r, 'deviceType', 'typeKey')
    return {
      key: sensorId ?? platform ?? `s${i}`,
      name: [sensorId, platform, device].filter(Boolean).join(' · ') || `#${i + 1}`,
      status: str(r, 'sensorClass', 'scanPattern', 'class', 'status', 'state'),
      metrics: rowMetrics(r),
      note: str(r, 'poseSource', 'note', 'reason', 'detail'),
    }
  })
  // `byType` 汇总（实测：{optical:{platforms, coverageAreaM2, revisitPeriodMs}, …}）
  const byTypeRaw = obj(src, 'byType')
  const byType = byTypeRaw
    ? Object.entries(byTypeRaw).filter(([, v]) => isObj(v)).map(([k, v]) => ({
      key: k,
      name: uavTypeLabel(k),
      platforms: num(v, 'platforms', 'count'),
      coverageKm2: (() => { const m2 = num(v, 'coverageAreaM2'); return m2 === undefined ? undefined : Number((m2 / 1e6).toFixed(2)) })(),
      revisitMs: num(v, 'revisitPeriodMs', 'scanPeriodMs'),
    }))
    : []
  const shown = new Set([coverage?.key, sweep?.key].filter(Boolean) as string[])
  const upper = num(src, 'coverageUpperBoundRatio')
  const sensitive = num(src, 'sensitiveAreaKm2')
  return {
    raw: data,
    coverage,
    sweep,
    metrics: [
      ...(num(src, 'coveredAreaKm2') !== undefined ? [{ key: 'coveredAreaKm2', name: '已覆盖面积', value: num(src, 'coveredAreaKm2'), unit: 'km²' }] : []),
      ...(num(src, 'taskAreaKm2') !== undefined ? [{ key: 'taskAreaKm2', name: '任务区面积', value: num(src, 'taskAreaKm2'), unit: 'km²' }] : []),
      ...(upper !== undefined ? [{ key: 'coverageUpperBoundRatio', name: '覆盖上界（非覆盖率）', value: ratioToPercent(upper), unit: '%', text: 'Σ覆盖面积÷任务区面积，未去重叠' }] : []),
      ...(sensitive !== undefined ? [{ key: 'sensitiveAreaKm2', name: '敏感区面积', value: sensitive, unit: 'km²' }] : []),
      ...(num(src, 'attachmentCount') !== undefined ? [{ key: 'attachmentCount', name: '挂载传感器数', value: num(src, 'attachmentCount'), unit: '个' }] : []),
      ...metricsAt(src, 'metrics', 'summary', 'totals', 'overview').filter((m) => !shown.has(m.key)),
    ],
    rows,
    byType,
    pairs: numericPairs(data),
    notes: strList(src, 'notes', 'note', 'explain'),
  }
}

/** 机型域 → 中文（词典；不认识就显示原键）——与 `useSituation.uavTypeCN` 同一口径。 */
function uavTypeLabel(key: string): string {
  const map: Record<string, string> = { optical: '光电', radar: '雷达', electronic: '电子', comm: '通信' }
  return map[key] ?? key
}

// ============================================================================
// ④ 目标台账（`targets.list` / `targets.detail`）
// ============================================================================

/** 坐标：`position:[lng,lat]` / `{lng,lat}` / `lon/lat` 三种都收。 */
export function readLngLat(row: unknown): { lng?: number; lat?: number } {
  const p = pick(row, 'position', 'pos', 'coord', 'coordinates', 'location')
  if (Array.isArray(p)) {
    const a = typeof p[0] === 'number' ? p[0] : undefined
    const b = typeof p[1] === 'number' ? p[1] : undefined
    if (a !== undefined && b !== undefined) return { lng: a, lat: b }
  }
  if (isObj(p)) return { lng: num(p, 'lng', 'lon', 'longitude'), lat: num(p, 'lat', 'latitude') }
  return {
    lng: num(row, 'lng', 'lon', 'longitude', 'x'),
    lat: num(row, 'lat', 'latitude', 'y'),
  }
}

export interface TargetRow {
  /** 台账实体 id（`targets.detail{entityId}` 就是发它）。实测字段名就是 `id`（`ent-…`） */
  entityId: string
  name: string
  /** 目标编号（实测 `no`） */
  no?: number
  typeKey?: string
  /** 类型中文名（实测 `typeName`，宿主已本地化） */
  typeName?: string
  /** 威胁等级域（实测 `threatBand`：规则包给的，**原样**；颜色由 `threatColor` 映射） */
  threat?: string
  /** 威胁评分（实测 `threatScore`，宿主算的） */
  threatScore?: number
  /** 来源（实测 `sources[].name` 拼成一行，如"电子 / 雷达"） */
  source?: string
  sourceCount?: number
  /** 动态状态（实测 `dynamicState`：onMove/active/briefStop…） */
  motion?: string
  /** 台账状态域（实测 `status`：gray 等；步 10 的"变灰"就是它） */
  status?: string
  confidence?: number
  /** 打击优先级（实测 `priority`） */
  priority?: number
  multiSource?: boolean
  retired?: boolean
  lng?: number
  lat?: number
  altM?: number
  valueTag?: string
  features: string[]
  metrics: Metric[]
  raw: unknown
}

export interface TargetsView {
  raw: unknown
  items: TargetRow[]
  /** 宿主给的**目标总数**（给了就显示宿主的数；没给显示列表长度并注明口径） */
  total?: number
  totals: Metric[]
  notes: string[]
  /** 探测口径说明（实测 `detectionNotes[]`：宿主解释为什么某些目标没出现） */
  detectionNotes: string[]
}

function readTargetRow(t: J, i: number): TargetRow {
  const { lng, lat } = readLngLat(t)
  const pos = pick(t, 'position', 'pos', 'coord', 'coordinates', 'location')
  const altM = num(t, 'altM', 'altitudeM', 'altitude', 'alt', 'elevationM')
    ?? (isObj(pos) ? num(pos, 'altM', 'altitude', 'alt') : undefined)
    ?? (Array.isArray(pos) && typeof pos[2] === 'number' ? pos[2] : undefined)
  const shown = new Set(['confidence', 'lng', 'lat', 'altM'])
  /**
   * 来源：实测是**数组** `sources:[{source:"electronic",name:"电子",confidence,count}]`
   * —— 取 `name`（宿主已本地化）拼成一行；没有数组再看单值字段。
   */
  const sources = objList(t, 'sources').map((s) => str(s, 'name', 'label') ?? str(s, 'source', 'key') ?? '').filter(Boolean)
  const source = sources.length
    ? [...new Set(sources)].join(' / ')
    : str(t, 'source', 'from', 'sensor', 'detectedBy', 'origin')
  return {
    entityId: str(t, 'entityId', 'id', 'key', 'targetId') ?? `t${i}`,
    // 实测没有 `name`，只有 `typeName`（"防空火力阵地"）；`no` 是目标编号
    name: str(t, 'name', 'label', 'title', 'typeName') ?? `目标 ${i + 1}`,
    no: num(t, 'no', 'number', 'seq'),
    typeKey: str(t, 'typeKey', 'type', 'kind', 'category'),
    typeName: str(t, 'typeName'),
    // 实测威胁等级字段名是 `threatBand`（另有 `threatScore` 数值）
    threat: str(t, 'threatBand', 'threat', 'threatLevel', 'level', 'risk'),
    threatScore: num(t, 'threatScore'),
    source,
    sourceCount: num(t, 'sourceCount') ?? (sources.length || undefined),
    motion: str(t, 'dynamicState', 'motion', 'activity', 'state'),
    /** 台账状态域（实测 `status:"gray"` —— 步 10 变灰就是它，步 7 只显示） */
    status: str(t, 'status'),
    confidence: num(t, 'confidence', 'confidencePercent', 'probability'),
    priority: num(t, 'priority'),
    multiSource: bool(t, 'multiSource'),
    retired: bool(t, 'retired'),
    lng,
    lat,
    altM,
    valueTag: str(t, 'valueTag', 'value'),
    features: strList(t, 'features', 'tags', 'characteristics'),
    metrics: sane(toMetrics(t)).filter((m) => !shown.has(m.key)),
    raw: t,
  }
}

export function readTargets(data: unknown): TargetsView {
  const src = isObj(data) ? data : undefined
  const list = objList(pick(src, 'items', 'targets', 'entities', 'rows', 'list'))
  return {
    raw: data,
    items: list.map(readTargetRow),
    total: num(src, 'total', 'targetCount', 'totalCount', 'count'),
    // 实测还有 `detection`（探测统计）与 `coverage`（覆盖统计）两段，原样列出来
    totals: [
      ...metricsAt(src, 'detection'),
      ...metricsAt(src, 'coverage'),
      ...metricsAt(src, 'totals', 'summary', 'stats', 'overview'),
    ],
    notes: strList(src, 'notes', 'note', 'explain'),
    detectionNotes: strList(src, 'detectionNotes'),
  }
}

/**
 * 处置动作**域 → 按钮文案**（词典）。
 *
 * 域来自引擎（`targets.detail` 给的可行动作清单，或契约 `targets.act{action}`）；
 * 不认识就**原样显示域**（不猜它的中文、更不猜它能不能点）。
 *
 * ⚠ 实测契约与规则包**不一致**（本屏必须如实反映，不许自己改名）：
 *   · 契约 `流程接口冻结.md` §2 写的是 `observe|track|strike`；
 *   · 规则包 `entity-ledger/policies/mapapp/entityTypes.json` 的 `actions[]` 是
 *     `watch / track / upgrade / strike / reassess`（**没有 observe**），
 *     宿主对 `observe` 实测回 `1004 unknown action`。
 *   所以这里把两套都收进词典，但**取值一律以引擎回执为准**（读不到就灰置按钮）。
 */
const ACTION_CN: Record<string, string> = {
  observe: '持续观察', watch: '重点监视', monitor: '重点监视', surveil: '重点监视',
  track: '持续跟踪', follow: '持续跟踪', lock: '持续跟踪',
  strike: '打击', attack: '打击', engage: '打击',
  upgrade: '升级为打击目标', promote: '升级为打击目标',
  reassess: '复核评估', reassessment: '复核评估',
}
export function actionCN(domain: string): string {
  return ACTION_CN[domain.toLowerCase()] ?? domain
}

/** 一个可行动作（域 + 可读标签 + 能不能点 + 不能点的原因）。 */
export interface ActionOption {
  domain: string
  label: string
  enabled: boolean
  reason?: string
  /** 取值来源：`engine`=引擎给的清单；`contract`=契约冻结值（界面必须写明） */
  origin: 'engine' | 'contract'
}

/**
 * 从 `targets.detail` 回执里读"可行动作清单"。
 *
 * **实测字段名是 `declaredActions`**（`["watch","track","upgrade","strike","reassess"]`，
 * 宿主注："动作清单来自规则包 entityTypes.json 的 actions[]：5 个（宿主不自造动作）"）。
 * 其余别名（`actions/availableActions/…`）一并收，顶层或嵌在 `detail/assessment/entity` 下都行；
 * 每项可以是字符串（域），也可以是 `{key|domain|action, label, enabled, reason}`。
 * **一个都读不到就返回 []**——界面据此把按钮灰置并写明原因（MUST NOT 拿契约值假装是引擎给的）。
 */
export function readActions(data: unknown): ActionOption[] {
  const src = isObj(data) ? data : undefined
  const scopes = [
    src,
    obj(src, 'detail'), obj(src, 'assessment'), obj(src, 'entity'), obj(src, 'target'),
  ].filter(Boolean) as J[]
  const keys = [
    'declaredActions', 'actions', 'availableActions', 'allowedActions',
    'actionOptions', 'options', 'verbs', 'commands',
  ]
  for (const scope of scopes) {
    for (const k of keys) {
      const raw = scope[k]
      if (!Array.isArray(raw) || raw.length === 0) continue
      const out: ActionOption[] = []
      for (const it of raw) {
        if (typeof it === 'string' && it) {
          out.push({ domain: it, label: actionCN(it), enabled: true, origin: 'engine' })
          continue
        }
        if (!isObj(it)) continue
        const domain = str(it, 'key', 'domain', 'action', 'id', 'verb')
        if (!domain) continue
        out.push({
          domain,
          label: str(it, 'label', 'name', 'title') ?? actionCN(domain),
          enabled: bool(it, 'enabled', 'available', 'allowed') ?? true,
          reason: str(it, 'reason', 'disabledReason', 'message', 'detail')
            ?? strList(it, 'reasons')[0],
          origin: 'engine',
        })
      }
      if (out.length) return out
    }
  }
  return []
}

/** 威胁评估的一个因子（实测 `assessment.factors[]`：逐因子得分与权重，可手算核对）。 */
export interface ThreatFactor {
  key: string
  name: string
  /** 该因子对总分的贡献（实测 `contribution`） */
  contribution?: number
  /** 原始读数（实测 `rawNumber`）与文本读数（实测 `rawText`） */
  rawNumber?: number
  rawText?: string
  /** 权重（实测 `weightPpm`，百万分比；**原样显示**，不换算） */
  weightPpm?: number
  missing?: boolean
}

/** `targets.detail` 的视图。 */
export interface TargetDetailView {
  raw: unknown
  entityId?: string
  /** 目标编号（实测 `no`） */
  no?: number
  name?: string
  typeKey?: string
  /** 类型中文名（实测 `typeName`） */
  typeName?: string
  /** 威胁等级域（实测 `threatBand`；**原样**，颜色由 `threatColor` 映射） */
  threat?: string
  /** 威胁评分（实测 `threatScore`） */
  threatScore?: number
  /** 来源（实测 `sources[].name`） */
  source?: string
  confidence?: number
  lng?: number
  lat?: number
  altM?: number
  valueTag?: string
  /** 台账状态域（实测 `status`：red/yellow/gray —— 规则包 threatFactors 的 bands[].state） */
  status?: string
  /** 打击优先级（实测 `priority`） */
  priority?: number
  features: string[]
  /** 评估行（威胁等级/防护强度/电子干扰/周边态势…名 + 域/值，**原样**） */
  assessment: Metric[]
  /** 威胁评估的逐因子明细（实测 `assessment.factors[]`） */
  factors: ThreatFactor[]
  /** AI 分析/结论条目（宿主给的文本，逐条显示） */
  analysis: string[]
  /** 引擎给的可行动作清单（实测 `declaredActions`；读不到就是空数组） */
  actions: ActionOption[]
  /** 建议处置（`suggestion/suggestedAction/advice`；文本或域，原样） */
  suggestion?: string
  /** 处置建议所在的字段名（界面标注数据来源用） */
  suggestionKey?: string
  /** 动作日志（实测 `actionLog[]`：最近一条 = 最后一次处置） */
  actionLog: { actionKey?: string; status?: string; at?: number; reason?: string; reversible?: boolean }[]
  /** 口径说明（实测 `notes[]`：威胁分值/等级/动作清单的来源，宿主原话） */
  notes: string[]
}

export function readTargetDetail(data: unknown): TargetDetailView {
  const src = isObj(data) ? data : undefined
  const d = obj(src, 'detail') ?? obj(src, 'target') ?? obj(src, 'entity') ?? src
  const asmt = obj(src, 'assessment') ?? obj(d, 'assessment') ?? obj(src, 'threatAssessment')
  const { lng, lat } = readLngLat(d)
  const pos = pick(d, 'position', 'pos', 'coord', 'coordinates', 'location')
  const altM = num(d, 'altM', 'altitudeM', 'altitude', 'alt')
    ?? (isObj(pos) ? num(pos, 'altM', 'altitude', 'alt') : undefined)
    ?? (Array.isArray(pos) && typeof pos[2] === 'number' ? pos[2] : undefined)
  const shown = new Set(['confidence', 'lng', 'lat', 'altM'])
  // 评估行：**只取评估口径里该显示的那几项**（不要 `metricsAt(asmt)` 通铺——
  // 实测 assessment 里还有 entityId/missionId/ts/totalWeightPpm 这类内部字段，
  // 铺出来会把面板撑长、还挤掉下面的处置动作区）
  const assessment: Metric[] = []
  const band = str(asmt, 'band', 'threatBand', 'level')
  if (band !== undefined) assessment.push({ key: 'band', name: '威胁等级', text: band, status: band })
  const score = num(asmt, 'score', 'threatScore')
  if (score !== undefined) assessment.push({ key: 'score', name: '威胁评分', value: score })
  const bandStatus = str(asmt, 'status')
  if (bandStatus !== undefined) assessment.push({ key: 'status', name: '等级状态（红/黄/灰）', text: bandStatus, status: bandStatus })
  const rejected = bool(asmt, 'rejected')
  if (rejected !== undefined) {
    assessment.push({
      key: 'rejected', name: '评估是否被拒', text: rejected ? '已拒绝' : '未拒绝',
      ...(rejected ? { status: 'fail' } : {}),
    })
  }
  const rejectReason = str(asmt, 'rejectReason')
  if (rejectReason) assessment.push({ key: 'rejectReason', name: '拒绝原因', text: rejectReason })
  const knownThreat: [string, string][] = [
    // 注意：`threatBand`/`threatScore` 已由上面的 band/score 显示（同一份评估），这里不再重复
    ['defenseLevel', '防护强度'], ['defense', '防护强度'],
    ['jammingLevel', '电子干扰'], ['interference', '电子干扰'], ['ewLevel', '电子干扰'],
    ['surrounding', '周边态势'], ['situation', '周边态势'],
    ['valueTag', '价值标签'], ['dynamicState', '活动状态'], ['activity', '活动状态'],
    ['priority', '打击优先级'], ['status', '台账状态'],
  ]
  const scanned = [asmt, d, src].filter(Boolean) as J[]
  for (const [k, name] of knownThreat) {
    if (assessment.some((m) => m.key === k)) continue
    for (const scope of scanned) {
      const v = str(scope, k)
      if (v !== undefined) { assessment.push({ key: k, name, text: v, status: v }); break }
    }
  }
  const suggestionKey = ['suggestion', 'suggestedAction', 'suggestedActionKey', 'advice', 'recommendedAction', 'disposal']
    .find((k) => str(src, k) ?? str(d, k) ?? str(asmt, k))
  const suggestion = suggestionKey ? (str(src, suggestionKey) ?? str(d, suggestionKey) ?? str(asmt, suggestionKey)) : undefined
  // 来源：实测是 `sources[]`（数组）——详情里也拼成一行
  const sources = objList(d, 'sources').concat(objList(src, 'sources'))
    .map((s) => str(s, 'name', 'label') ?? str(s, 'source', 'key') ?? '').filter(Boolean)
  // 逐因子明细（实测 `assessment.factors[]`）
  const factors: ThreatFactor[] = objList(asmt, 'factors').map((f, i) => ({
    key: str(f, 'key', 'source', 'id') ?? `f${i}`,
    name: str(f, 'name', 'label') ?? str(f, 'key') ?? `因子 ${i + 1}`,
    contribution: num(f, 'contribution', 'score'),
    rawNumber: num(f, 'rawNumber', 'raw'),
    rawText: str(f, 'rawText'),
    weightPpm: num(f, 'weightPpm', 'weight'),
    missing: bool(f, 'missing'),
  }))
  // 动作日志（实测 `actionLog[]`，取最近几条）
  const actionLog = objList(src, 'actionLog').map((a) => ({
    actionKey: str(a, 'actionKey', 'action'),
    status: str(a, 'status'),
    at: num(a, 'at', 'ts'),
    reason: str(a, 'reason'),
    reversible: bool(a, 'reversible'),
  })).sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, 4)
  return {
    raw: data,
    entityId: str(src, 'entityId', 'id') ?? str(d, 'entityId', 'id'),
    no: num(d, 'no') ?? num(src, 'no'),
    name: str(d, 'name', 'label', 'title', 'typeName') ?? str(src, 'name', 'typeName'),
    typeKey: str(d, 'typeKey', 'type', 'kind', 'category') ?? str(asmt, 'typeKey', 'typeJudgement', '类型判断'),
    typeName: str(d, 'typeName') ?? str(src, 'typeName'),
    threat: str(d, 'threatBand', 'threat', 'threatLevel', 'level', 'risk')
      ?? str(asmt, 'band', 'threatBand', 'threat', 'threatLevel', '威胁等级'),
    threatScore: num(d, 'threatScore') ?? num(asmt, 'score') ?? num(src, 'threatScore'),
    source: sources.length ? [...new Set(sources)].join(' / ') : str(d, 'source', 'from', 'origin'),
    confidence: num(d, 'confidence', 'confidencePercent', 'probability') ?? num(src, 'confidence'),
    lng, lat, altM,
    valueTag: str(d, 'valueTag', 'value'),
    status: str(d, 'status') ?? str(asmt, 'status') ?? str(src, 'status'),
    priority: num(d, 'priority') ?? num(src, 'priority'),
    features: strList(d, 'features', 'tags', 'characteristics'),
    assessment,
    factors,
    analysis: [
      ...strList(src, 'analysis', 'conclusions', 'findings', 'notes', 'ai'),
      ...strList(asmt, 'analysis', 'notes', 'conclusions'),
    ],
    actions: readActions(data),
    suggestion,
    suggestionKey,
    actionLog,
    notes: strList(src, 'notes', 'note', 'explain'),
  }
}

/** `targets.act` 的视图（回执本身要显示：动作键、迁移后状态、幂等/冲突/被拒原因）。 */
export interface ActView {
  raw: unknown
  entityId?: string
  /** 动作键（实测字段名是 `actionKey`） */
  action?: string
  /** 动作后的状态摘要（实测 `state.status` / `state.dynamicState`） */
  to?: string
  /** 该实体的威胁等级（实测 `state.threatBand`） */
  band?: string
  status?: string
  idempotent?: boolean
  conflict?: boolean
  /** 被跳过的前置 gate（实测 `skippedGates[]`） */
  skippedGates: string[]
  message?: string
  /** 被拒绝的原因（`unmet[]` / `blocked.reason`，照抄） */
  unmet: string[]
  /** 宿主对"闸门/动作来源"的口径说明（实测 `gateNote`） */
  gateNote?: string
  /** 宿主注册的闸门数（实测 `registeredGates`） */
  registeredGates?: number
}

/**
 * 读 `targets.act` 的回执。
 *
 * ⚠ 实测宿主**套了两层**：`reply.data = {code, data:{actionKey, state, …}, declaredActions,
 *   gateNote, message, registeredGates}` —— 真正的动作结果在 `reply.data.data` 里。
 *   所以这里按 `data → data.data → result → event` 依次找"哪层有 actionKey/entityId"。
 */
export function readAct(data: unknown): ActView {
  const outer = isObj(data) ? data : undefined
  const inner = obj(outer, 'data')
  const src = (inner && (str(inner, 'actionKey', 'action') ?? str(inner, 'entityId'))) ? inner : outer
  const ev = obj(src, 'event') ?? obj(src, 'transition')
  const st = obj(src, 'state') ?? obj(ev, 'state')
  const blocked = obj(src, 'blocked')
  return {
    raw: data,
    entityId: str(src, 'entityId', 'id') ?? str(outer, 'entityId') ?? str(ev, 'entityId', 'id'),
    action: str(src, 'actionKey', 'action', 'verb') ?? str(outer, 'actionKey') ?? str(ev, 'actionKey', 'action'),
    to: str(st, 'status', 'dynamicState') ?? str(src, 'to', 'nextState'),
    band: str(st, 'threatBand') ?? str(src, 'band'),
    status: str(src, 'status', 'planState') ?? str(outer, 'message'),
    idempotent: bool(src, 'idempotent') ?? bool(outer, 'idempotent') ?? bool(ev, 'idempotent'),
    conflict: bool(src, 'conflict') ?? bool(outer, 'conflict') ?? bool(ev, 'conflict'),
    skippedGates: strList(src, 'skippedGates'),
    message: str(src, 'message', 'reason', 'detail') ?? str(outer, 'message') ?? str(blocked, 'reason'),
    unmet: [...strList(src, 'unmet'), ...strList(outer, 'unmet'), ...strList(blocked, 'needs', 'unmet')],
    gateNote: str(outer, 'gateNote'),
    registeredGates: num(outer, 'registeredGates'),
  }
}

// ============================================================================
// ⑤ 媒体通道（`media.channels` 事件 / verb）
// ============================================================================

/** 一路通道（宿主给的字段原样；归一化交给 media-player 自己）。 */
export interface MediaChannelRow {
  id: string
  name: string
  kind?: string
  url?: string
  frames?: number
  frameIntervalMs?: number
  available?: boolean
  reason?: string
}

export interface MediaView {
  raw: unknown
  /** 清单来源：事件 / verb / 都没有 */
  from: 'event' | 'verb' | 'none'
  channels: MediaChannelRow[]
  /** 宿主给的 schemaVersion（有就显示，便于判断兼容性） */
  schemaVersion?: string
  notes: string[]
}

/**
 * 读媒体通道清单。
 *
 * 实测口径（`流程接口冻结.md` §1）：事件 `media.channels` 的 data 形状是
 * `{channels:[{id,name,kind,url|frames,frameIntervalMs}]}`。这里**同时**兼容 verb 回执
 * （`code=0` 时 `data` 同样是那份对象）与裸数组；读不到的字段留空。
 */
export function readMedia(data: unknown, from: MediaView['from']): MediaView {
  const src = isObj(data) ? data : undefined
  const list = Array.isArray(data) ? data : arr(src, 'channels')
  const channels: MediaChannelRow[] = list.filter(isObj).map((c, i) => ({
    id: str(c, 'id', 'channelId', 'key') ?? `c${i}`,
    name: str(c, 'name', 'label', 'title') ?? `通道 ${i + 1}`,
    kind: str(c, 'kind', 'type', 'source'),
    url: str(c, 'url', 'src', 'href'),
    frames: Array.isArray(c.frames) ? (c.frames as unknown[]).length : num(c, 'frames', 'frameCount'),
    frameIntervalMs: num(c, 'frameIntervalMs', 'intervalMs'),
    available: bool(c, 'available', 'enabled', 'ok'),
    reason: str(c, 'unavailableReason', 'reason', 'message'),
  }))
  return {
    raw: data,
    from,
    channels,
    schemaVersion: str(src, 'schemaVersion'),
    notes: strList(src, 'notes', 'note', 'explain'),
  }
}

// ============================================================================
// ⑥ 回执的一句话（步 6–7 复用 P3 的口径：宿主的原话照抄）
// ============================================================================

/** `n2s` 的再导出，省得各屏都从 useSituation 引一遍（同一份实现）。 */
export { n2s }

// ============================================================================
// ⑦ 排障后门：把"读取器"挂到 window 上（**只读、不改渲染**）
// ============================================================================
//
// 用途：验收脚本可以在页面上用**合成负载**调一遍读取器，回答"宿主真按契约给字段时，
// 界面能不能读出来"——尤其是 verb 还没装配的时候（否则只能等）。这**不是**数据源：
// 渲染路径永远只读宿主回执 / 宿主事件，本后门不参与任何渲染（与 App.tsx 的 `?stage=map`
// 后门同一性质：排障用，可随时删）。
if (typeof window !== 'undefined') {
  const w = window as unknown as { __p4Read?: Record<string, unknown> }
  w.__p4Read = { readSim, readTopology, readSensor, readTargets, readTargetDetail, readActions, readMedia, linkColor }
}
