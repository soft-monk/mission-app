// mission-app · apps/web/src/flow/useStrike.ts
//
// 步 8–9（任务决策与打击准备 / 打击方案确认）的**数据层**。
//
// 与 `useOps.ts` / `useSituation.ts` 同一套路，三层职责：
//   ① 复用 `useVerbOnce` 发命令（在屏里调，不在这里）；
//   ② `readStrikePlans / readStrikeWindow / readGuidance / readReceipt`
//      —— 把宿主/引擎返回的 JSON 读成界面要的形状。只做"取字段 + 兜底"，
//      **不加一个数、不判一次状态、不做一次几何计算**；
//   ③ 词典：`coordinationCN`（协同方式域 → 中文）、`segLabel`（时间轴段域 → 中文）。
//      宿主已给 `coordinationLabel` / `name` 时**优先用宿主的**（宿主本地化的最权威）。
//
// ★ 实测形状（本文件按**实测**写，契约名作兜底；以后字段再变也不会显示错值）：
//
//   `strike.plans{count:3}` →
//   ```json
//   {"items":[{"candidate":{"id":"stk-s1-b","name":"方案二 多集群协同压制","method":"协同压制",
//                           "effect":"压制摧毁","clusters":["集群 1",…],"successRate":82,
//                           "recommendedHint":true,"applicable":true,"inapplicableReasons":[]},
//              "score":{"id":"stk-s1-b","total":90,"rank":1,"recommended":true,
//                       "metrics":[{"key":"coverageRate","name":"区域覆盖率","raw":93,"unit":"%",
//                                   "weight":0.17,"missing":false},…]},
//              "coordination":"simultaneous","coordinationLabel":"同时",
//              "plannedFinish":{"basis":"from-t0","minutes":48},
//              "attackStart":{"key":"ip-c-north","name":"IP 点｜C 区北侧攻击起点"},
//              "assessRoute":{"key":"route-assess-c-north","name":"评估航线｜C 区北侧"},
//              "geometry":{"resolved":true,"attackStart":{…lng,lat,altM…},"assessRoute":{…waypoints…}},
//              "template":{…规则包原文（TemplatesPack.raw）…}}],
//    "recommendedId":"stk-s1-b","recommendedPercent":90,"leadOverNextPercent":12,
//    "reasons":[{"metricKey":"resourceUtilization","type":"top-score","value":96}],
//    "notes":[…],"missingInputs":[]}
//   ```
//   ⚠ **M5 的四个字段（coordination/plannedFinish/attackStart/assessRoute）在 item 行上**
//     （与 `candidate` 平级），不在 `candidate` 里；`template` 里也有一份。三处依次试。
//
//   `guidance.plan{planId}` →
//   ```json
//   {"planId":"stk-s1-b","ipPoint":{"key":"ip-c-north","name":"IP 点｜…","lng":116.548,"lat":39.774,"altM":320},
//    "assessRoute":{"key":"route-assess-c-north","waypoints":[{"lng":116.548,"lat":39.78},…]},
//    "assessRouteSummary":{"lengthM":3811.7,"waypointCount":5,"lengthBasis":"…"},
//    "assessFlight":{"durationMinutes":0,"lengthM":3811.7,"speedMps":0,"speedSamples":0},
//    "guidance":{"clustersDeclared":6,"clustersMatched":0,
//                "groups":[{"planCluster":"集群 1","leader":null,"members":[],"resolved":false,"reason":"…"}],
//                "lines":[],"linesTotal":0,"matchRule":"…"},
//    "timeline":{"anchor":{"atText":"…","enteredAt":…,"phaseKey":"T5","source":"…"},
//                "items":[{"key":"t0","name":"任务进入当前阶段","atMs":…,"atText":"…",
//                          "basis":{"formula":"…","inputs":{…},"source":"…"}},
//                         {"key":"arrival",…},{"key":"strike",…},{"key":"assess",…}]},
//    "notes":[…]}
//   ```
//
// ⚠ 三条最容易写错的纪律，写在这里：
//   ① **推荐不是前端挑的**：只认 `recommendedId` 与候选自带的 `recommendedHint/recommended`；
//      两样都没有就**一张都不标**（MUST NOT 按 successRate 自己排一个"最优"）。
//   ② **坐标只从 `guidance.plan` 的负载里"取"**：不插值、不算中点、不做投影、不拿别处的
//      坐标凑。宿主只给了键引用而没有几何时，界面**不画**，并在 `unresolved[]` 里如实记一笔。
//   ③ **时间轴每段都要带 `basis`**（"这个时刻是怎么算出来的"：宿主给的是
//      `{formula, inputs, source}` 三件套）。宿主留空一段时刻时，界面写"留空 + 原因"，绝不补一个。
import {
  bool, isObj, n2s, num, obj, objList, pick, str, strList, toMetrics,
  type Metric,
} from './useSituation'

type J = Record<string, unknown>

// ============================================================================
// ⓪ 小工具：`pick` 只能"从对象按 key 取"，这里补三个"已取出的值 → 类型"的转换
// ============================================================================

/** 值 → 字符串（数字/布尔也转；对象/数组不转，免得显示成 [object Object]）。 */
function asStr(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return undefined
}
/** 值 → 数值（**只认宿主给的数**；读不出就 undefined → 界面显示"—"）。 */
function asNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}
function asBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

/**
 * 计量行**净化**：`toMetrics` 会把裸对象里的长字符串塞进 `value` 位
 * （`Number("相邻航点大圆距离之和…")` → `NaN`），而界面"有 value 就显示 value"→ 屏上出现 `NaN`。
 * **NaN 上屏等于编了一个数**，所以非有限值一律退回文本位。
 */
function sane(rows: Metric[]): Metric[] {
  return rows.map((m) => (
    m.value !== undefined && !Number.isFinite(m.value)
      ? { ...m, value: undefined, text: m.text ?? String(m.value) }
      : m
  ))
}

/** 递归收集"数值/短文本"叶子（最多 `limit` 条）——回执字段改名时的兜底展示。 */
function rawPairs(v: unknown, prefix = '', out: { path: string; value: string }[] = [], limit = 80): { path: string; value: string }[] {
  if (out.length >= limit) return out
  if (v === null || v === undefined) return out
  if (typeof v === 'number' || typeof v === 'boolean') {
    out.push({ path: prefix || 'value', value: String(v) })
    return out
  }
  if (typeof v === 'string') {
    if (v.length > 0 && v.length <= 70) out.push({ path: prefix || 'value', value: v })
    return out
  }
  if (Array.isArray(v)) {
    v.slice(0, 8).forEach((it, i) => rawPairs(it, `${prefix}[${i}]`, out, limit))
    return out
  }
  if (isObj(v)) {
    for (const [k, val] of Object.entries(v)) {
      if (out.length >= limit) break
      rawPairs(val, prefix ? `${prefix}.${k}` : k, out, limit)
    }
  }
  return out
}

/**
 * 数值 → `T+mm`（**只是显示格式**，不改变数值；缺值给"—"）。
 *
 * 宿主给的是 `offsetMinutes`（相对 t0 的分钟），浮点尾巴很长（实测 `3.890279530481107`）——
 * 这里只**保留 1 位小数**（与 `n2s` 同一口径的显示取整），不改变"相对 t0"这个语义。
 */
export function tPlus(minutes?: number): string {
  if (minutes === undefined) return '—'
  const v = Number.isInteger(minutes) ? minutes : Number(minutes.toFixed(1))
  return `T+${Number.isInteger(v) ? String(v).padStart(2, '0') : v}`
}

/** 长短时刻 → 展示用短串（纯字符串截取，不改数值）：`2026-09-16T22:46:04+08:00` → `22:46:04`。 */
export function shortTime(at?: string): string {
  if (!at) return '—'
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(at)
  return m ? m[1] : at
}

/**
 * 时刻文本。三形态：
 *   · 字符串（`2026-09-16T23:26:29+08:00` / `15:14`）→ 原样；
 *   · 数字（epoch ms，> 1e11）→ 本地时间 + 标注"（epoch ms）"；
 *   · 缺 → undefined（界面显示"—"）。
 */
function timeText(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v > 1e11 ? `${new Date(v).toLocaleString()}（epoch ms）` : String(v)
  }
  if (typeof v === 'string' && v) return v
  return undefined
}

/** 经纬高：只从负载里**读**，读不出就 undefined（调用方据此不画）。 */
export interface GeoPoint { lng: number; lat: number; altM?: number }

export function geoOf(v: unknown): GeoPoint | undefined {
  if (Array.isArray(v)) {
    const lng = typeof v[0] === 'number' ? v[0] : undefined
    const lat = typeof v[1] === 'number' ? v[1] : undefined
    if (lng === undefined || lat === undefined) return undefined
    return { lng, lat, altM: typeof v[2] === 'number' ? v[2] : undefined }
  }
  if (!isObj(v)) return undefined
  // GeoJSON Point：{type:'Point', coordinates:[lng,lat(,alt)]}
  const coords = pick(v, 'coordinates', 'coordSeq')
  if (Array.isArray(coords)) return geoOf(coords)
  const g = obj(v, 'geometry')
  const gc = pick(g, 'coordinates')
  if (Array.isArray(gc)) return geoOf(gc)
  const lng = num(v, 'lng', 'lon', 'longitude', 'x')
  const lat = num(v, 'lat', 'latitude', 'y')
  if (lng === undefined || lat === undefined) return undefined
  return {
    lng, lat,
    altM: num(v, 'altM', 'alt', 'altitude', 'altitudeM', 'heightM', 'height', 'elevM', 'elevationM', 'z'),
  }
}

// ============================================================================
// ① 词典（域 → 中文）。域不认识就**原样显示**，MUST NOT 猜
// ============================================================================

/**
 * 协同方式域 → 中文。
 *
 * 取值域来自规则包：`simultaneous` / `sequential`（`规则包改造M5M6.md` §2）。
 * **宿主给了 `coordinationLabel` 就用宿主的**（引擎本地化最权威），没给才走这张表。
 */
const COORD_CN: Record<string, string> = {
  simultaneous: '同时', concurrent: '同时', parallel: '同时', sync: '同时',
  sequential: '序贯', sequence: '序贯', serial: '序贯', staged: '分阶段',
}
export function coordinationCN(domain?: string, label?: string): string {
  if (label) return label
  if (!domain) return '—'
  return COORD_CN[domain.toLowerCase()] ?? domain
}

/** 时间轴段域 → 中文（契约四段：t0 / 到达 / 打击 / 评估）。不认识就显示原域。 */
const SEG_CN: Record<string, string> = {
  t0: 't0（任务下达）', zero: 't0（任务下达）', start: 't0（任务下达）', base: 't0（任务下达）',
  info: '信息包生成', information: '信息包生成', packet: '信息包生成', infopack: '信息包生成',
  arrive: '到达', arrival: '到达', reach: '到达',
  strike: '打击', strikeStart: '打击', attack: '打击', hit: '打击', engage: '打击',
  assess: '评估', assessment: '评估', evaluate: '评估', evaluation: '评估', reassess: '评估',
}
export function segLabel(domain?: string, label?: string): string {
  if (label) return label
  if (!domain) return '—'
  return SEG_CN[domain.toLowerCase().replace(/\s+/g, '')] ?? domain
}

/** 契约里时间轴的四段顺序（只用于**排序**与"缺哪段"的提示，不用于编数）。 */
export const TIMELINE_ORDER = ['t0', 'arrive', 'strike', 'assess'] as const
/** 四段的**别名表**（宿主用 `arrival` 还是 `arrive` 都认得；界面据此提示"缺哪段"）。 */
export const SEG_ALIASES: Record<string, string[]> = {
  t0: ['t0', 'zero', 'start', 'base'],
  arrive: ['arrive', 'arrival', 'reach'],
  strike: ['strike', 'attack', 'hit', 'engage'],
  assess: ['assess', 'assessment', 'evaluate', 'evaluation', 'reassess'],
}
/** 段键是否属于契约四段中的某一段。 */
export function segMatches(key: string | undefined, canonical: string): boolean {
  const k = (key ?? '').toLowerCase()
  return (SEG_ALIASES[canonical] ?? [canonical]).some((a) => k === a || k.startsWith(a))
}

// ============================================================================
// ② 步 8 · 打击方案（`strike.plans`）
// ============================================================================

/**
 * 预计完成时间（规则包字段 `plannedFinish`）。
 *
 * 判别式 `basis` 把"绝对时刻 vs 相对分钟"变成**纯取值**：
 *   · `from-t0` + `minutes` → 显示 `t0 + N 分钟`（锚点 = 任务下达 t0）；
 *   · `absolute` + `at`     → 显示该时刻。
 * `basis` **必然一起显示**（界面把"怎么算出来的"摆在数字旁边）。
 */
export interface FinishView {
  basis?: string
  minutes?: number
  at?: string
  /** 界面用的一行（由取值形态决定，不换算） */
  text: string
}

function readFinish(v: unknown): FinishView | undefined {
  if (!isObj(v)) return undefined
  const basis = asStr(pick(v, 'basis', 'mode', 'kind', 'reference'))
  const minutes = asNum(pick(v, 'minutes', 'minute', 'minutesFromT0', 'offsetMinutes', 'durationMinutes', 'etaMinutes'))
  const at = timeText(pick(v, 'at', 'time', 'atText', 'iso', 'eta', 'finishAt'))
  if (basis === undefined && minutes === undefined && at === undefined) return undefined
  return { basis, minutes, at, text: minutes !== undefined ? `t0 + ${n2s(minutes)} 分钟` : (at ?? '—') }
}

/** 键引用型几何（`attackStart` / `assessRoute`）：规则包只写 key/name，几何由宿主按键补。 */
export interface RefView {
  key?: string
  name?: string
  /** 宿主**顺带**给了几何就读出来（没给就是 undefined —— 界面不补） */
  geo?: GeoPoint
  /** 几何的来源说明（实测 `source`，宿主写明"来自哪个文件的哪个键"） */
  source?: string
  /** 航线的航点数（宿主给了才显示） */
  waypointCount?: number
}

function readRef(v: unknown): RefView | undefined {
  if (typeof v === 'string') return { key: v }
  if (!isObj(v)) return undefined
  const key = asStr(pick(v, 'key', 'id', 'refKey', 'routeKey', 'pointKey'))
  const name = asStr(pick(v, 'name', 'label', 'title'))
  const source = asStr(pick(v, 'source', 'from'))
  const geo = geoOf(v)
  const waypoints = pick(v, 'waypoints', 'points', 'waypointsRaw')
  const waypointCount = Array.isArray(waypoints) ? waypoints.length : undefined
  if (key === undefined && name === undefined && geo === undefined && waypointCount === undefined) return undefined
  return { key, name, source, geo, waypointCount }
}

/** 一张打击方案卡的全部取值（**逐项都来自宿主回执**）。 */
export interface StrikePlanView {
  id: string
  name: string
  /** 方案要点：`method`（打击方式）+ `effect`（打击效果） */
  method?: string
  effect?: string
  summary?: string
  /** 成功率预估（候选字段 `successRate`；与 score 不是一回事，两个都显示） */
  successRate?: number
  /** 引擎评分（实测 `score.total`/`totalScaled`）——**推荐由 recommendedId 决定，不由它决定** */
  score?: number
  rank?: number
  /** 协同方式域（规则包取值 `simultaneous`/`sequential`） */
  coordination?: string
  /** 协同方式的中文（宿主 `coordinationLabel` 优先，其次词典，最后原样） */
  coordinationCN: string
  /** 这个中文是哪来的：`host-label` / `dict` / `raw` / `none`（界面标注来源用） */
  coordinationSource: 'host-label' | 'dict' | 'raw' | 'none'
  plannedFinish?: FinishView
  attackStart?: RefView
  assessRoute?: RefView
  /** 几何是否已解析（实测 `geometry.resolved`；未解析的项**只标注、不丢**） */
  geometryResolved?: boolean
  /** `recommendedId` 对上、或候选自带 `recommendedHint/recommended` —— 前端**不挑** */
  recommended: boolean
  clusters: string[]
  /** 逐项指标（`score.metrics[].raw`：覆盖率/链路稳定度/…宿主给多少显示多少） */
  effects: Metric[]
  metrics: Metric[]
  /** 该方案的理由（候选自带 `reasons[]`；没有就用顶层 `reasons[]`，并标明来源） */
  reasons: string[]
  reasonsSource: 'plan' | 'top-level' | 'none'
  inapplicableReasons: string[]
  raw: unknown
}

export interface StrikePlansView {
  raw: unknown
  plans: StrikePlanView[]
  /** 引擎指定的推荐（`recommendedId`）——推荐标记**只认它** */
  recommendedId?: string
  recommendedPercent?: number
  leadOverNextPercent?: number
  nextId?: string
  nextPercent?: number
  /** 推荐理由（顶层 `reasons[]`，规则包给的 metricKey/type/value → 人话） */
  reasons: string[]
  notes: string[]
  missingInputs: string[]
  missionId?: string
  scene?: string
  /** 几何解析统计（实测 `geometryResolved/geometryUnresolved`：宿主只标注、不丢） */
  geometryResolved?: number
  geometryUnresolved?: number
}

/** 规则包 metricKey → 中文（**词典**；不认识就显示原 key）。与 useSituation.metricCN 同口径。 */
const METRIC_CN: Record<string, string> = {
  coverageRate: '区域覆盖率',
  linkStability: '链路稳定度',
  targetDetection: '目标发现效率',
  electronicSuppression: '电子压制能力',
  missionSuccess: '任务成功率',
  resourceUtilization: '资源利用率',
  strikeSuccess: '打击成功率',
}
const REASON_TYPE_CN: Record<string, string> = {
  'top-score': '该指标全场最高',
  'top-contribution': '该指标对总分贡献最大',
  lead: '明显领先次优方案',
  advantage: '相对次优方案占优',
}
function reasonText(r: J): string {
  const key = str(r, 'metricKey', 'key', 'metric') ?? ''
  const name = str(r, 'name') ?? METRIC_CN[key] ?? key
  const type = str(r, 'type', 'reasonType') ?? ''
  const value = num(r, 'value', 'valueScaled', 'raw')
  const ref = str(r, 'refKey', 'ref', 'nextId')
  const typeCN = REASON_TYPE_CN[type] ?? type
  const val = value === undefined ? '' : `（${n2s(value)}）`
  return ref ? `${name}：${typeCN}，对比 ${ref}${val}` : `${name}：${typeCN}${val}`
}

/**
 * 把 `strike.plans` 读成视图。
 *
 * 两层形状 `{candidate, score}`（与 `alloc.plans` 同族），**M5 的四个字段在 item 行上**
 * （实测），`template`（规则包原文）与候选里也可能有 —— 三处依次试，谁先有值用谁。
 * 「推荐」口径：`recommendedId` 对上 **或** 候选/评分自带 `recommendedHint/recommended`；
 * 两样都没有 → 一张都不标（界面显示"引擎未指定推荐"）。
 */
export function readStrikePlans(data: unknown): StrikePlansView {
  const src = isObj(data) ? data : undefined
  const items = objList(src, 'items', 'plans', 'candidates')
  const recId = str(src, 'recommendedId', 'recommendId', 'bestId')
  const topReasons = objList(src, 'reasons').map(reasonText)

  const plans: StrikePlanView[] = items.map((row, i) => {
    const cand = obj(row, 'candidate') ?? row
    const sc = obj(row, 'score')
    const tpl = obj(row, 'template') ?? obj(cand, 'template')
    /** M5 字段的三处兜底取值：item 行（实测） → 规则包 template → candidate。 */
    const f = (...keys: string[]) => pick(row, ...keys) ?? pick(tpl, ...keys) ?? pick(cand, ...keys)

    const id = str(cand, 'id', 'planId', 'key') ?? str(sc, 'id') ?? `p${i}`
    const domain = asStr(f('coordination', 'coordinationMode', 'sync', 'coordinationKind'))
    const hostLabel = asStr(f('coordinationLabel', 'coordinationText', 'coordinationName'))
    const ownReasons = strList(cand, 'reasons', 'rationale', 'why', 'advantages')
    const recommended = (asBool(f('recommendedHint', 'recommended', 'isRecommended')) ?? false)
      || (asBool(pick(sc, 'recommended')) ?? false)
      || (recId !== undefined && recId === id)

    // 几何：规则包只给键引用；宿主把 geometry.attackStart / geometry.assessRoute 补齐（含经纬高）
    const geom = obj(row, 'geometry') ?? obj(cand, 'geometry') ?? obj(tpl, 'geometry')
    const attackStart = readRef(f('attackStart', 'attackStartRef', 'ipPoint', 'ip'))
    if (attackStart && !attackStart.geo) {
      const g = geoOf(pick(geom, 'attackStart'))
      if (g) {
        attackStart.geo = g
        attackStart.source = attackStart.source ?? asStr(pick(obj(geom, 'attackStart'), 'source'))
      }
    }
    const assessRoute = readRef(f('assessRoute', 'assessRouteRef', 'route'))
    if (assessRoute && !assessRoute.geo && assessRoute.waypointCount === undefined) {
      const wa = pick(obj(geom, 'assessRoute'), 'waypoints', 'waypointsRaw')
      if (Array.isArray(wa)) assessRoute.waypointCount = wa.length
      assessRoute.source = assessRoute.source ?? asStr(pick(obj(geom, 'assessRoute'), 'source'))
    }

    return {
      id,
      name: str(cand, 'name', 'title', 'label') ?? str(sc, 'name') ?? id,
      method: str(cand, 'method', 'approach', 'strikeMethod'),
      effect: str(cand, 'effect', 'expectedEffect', 'strikeEffect'),
      summary: str(cand, 'summary', 'desc', 'detail', 'points', 'keyPoints'),
      successRate: num(cand, 'successRate', 'rate', 'successPercent'),
      score: num(sc, 'total', 'score', 'percent') ?? num(cand, 'score'),
      rank: num(sc, 'rank', 'seq'),
      coordination: domain,
      coordinationCN: coordinationCN(domain, hostLabel),
      coordinationSource: hostLabel ? 'host-label' : (domain ? (COORD_CN[domain.toLowerCase()] ? 'dict' : 'raw') : 'none'),
      plannedFinish: readFinish(f('plannedFinish', 'finish', 'plannedEnd')),
      attackStart,
      assessRoute,
      geometryResolved: asBool(pick(geom, 'resolved')),
      recommended,
      clusters: strList(cand, 'clusters', 'clusterNames', 'groups'),
      effects: sane(objList(sc, 'metrics').map((m, j) => ({
        key: str(m, 'key', 'id') ?? `m${j}`,
        name: str(m, 'name') ?? METRIC_CN[str(m, 'key') ?? ''] ?? str(m, 'key') ?? `#${j + 1}`,
        value: num(m, 'raw', 'value'),
        unit: str(m, 'unit'),
        text: [
          bool(m, 'missing') ? '缺失（按规则包中性值/baseline）' : null,
          num(m, 'weight') !== undefined ? `权重 ${n2s(num(m, 'weight'))}` : null,
        ].filter(Boolean).join(' · ') || undefined,
      }))),
      metrics: sane(toMetrics(pick(sc, 'metrics', 'items'))),
      reasons: ownReasons.length ? ownReasons : topReasons,
      reasonsSource: ownReasons.length ? 'plan' : (topReasons.length ? 'top-level' : 'none'),
      inapplicableReasons: strList(cand, 'inapplicableReasons', 'unavailableReasons'),
      raw: cand,
    }
  })

  return {
    raw: data,
    plans,
    recommendedId: recId,
    recommendedPercent: num(src, 'recommendedPercent', 'recommendPercent', 'bestPercent'),
    leadOverNextPercent: num(src, 'leadOverNextPercent', 'leadPercent', 'gapPercent', 'leadOverNext'),
    nextId: str(src, 'nextId'),
    nextPercent: num(src, 'nextPercent'),
    reasons: topReasons,
    notes: strList(src, 'notes', 'note', 'summary', 'explain'),
    missingInputs: strList(src, 'missingInputs', 'missing'),
    missionId: str(src, 'missionId'),
    scene: str(src, 'scene', 'scenarioKey'),
    geometryResolved: num(src, 'geometryResolved'),
    geometryUnresolved: num(src, 'geometryUnresolved'),
  }
}

// ============================================================================
// ③ 步 8 · 打击窗口（`strike.window{entityId}`）
// ============================================================================

/**
 * 打击窗口读数。
 *
 * 形状未冻结（契约只钉了 verb 与 `{entityId}`），所以这里做两件事：
 *   · 按别名读常用量（剩余/时长/起止/最优时刻）——**读到就显示，读不到就是"—"**；
 *   · `pairs`：回执里**所有**数值/短文本叶子的原样清单（字段改名也看得见，且不改口径）。
 *
 * ⚠ **不做本地倒计时**：界面上那个"窗口剩余"就是宿主给的数（连同字段名一起显示）。
 *   前端自己每秒减一，等于凭空造了一串宿主的时钟没给过的数。
 */
export interface WindowView {
  raw: unknown
  entityId?: string
  remainingMs?: number
  durationMs?: number
  opensAt?: string
  closesAt?: string
  optimalAt?: string
  metrics: Metric[]
  pairs: { path: string; value: string }[]
  notes: string[]
}

export function readStrikeWindow(data: unknown): WindowView {
  const src = isObj(data) ? (obj(data, 'window') ?? data) : undefined
  const shown = new Set(['remainingMs', 'durationMs', 'opensAt', 'closesAt', 'optimalAt', 'entityId'])
  return {
    raw: data,
    entityId: str(src, 'entityId', 'id', 'targetId'),
    remainingMs: num(src, 'remainingMs', 'remainMs', 'msLeft'),
    durationMs: num(src, 'durationMs', 'windowMs', 'lengthMs'),
    opensAt: timeText(pick(src, 'opensAt', 'openAt', 'startAt', 'from', 'windowStart')),
    closesAt: timeText(pick(src, 'closesAt', 'closeAt', 'endAt', 'to', 'windowEnd', 'deadline')),
    optimalAt: timeText(pick(src, 'optimalAt', 'bestAt', 'recommendedAt', 'optimalTime')),
    metrics: sane(toMetrics(pick(src, 'metrics', 'items', 'readings'))).filter((m) => !shown.has(m.key)),
    pairs: rawPairs(data, '', [], 60),
    notes: strList(src, 'notes', 'note', 'explain', 'basis'),
  }
}

// ============================================================================
// ④ 步 9 · 引导方案（`guidance.plan{planId}`）—— 几何与时间轴的**唯一**权威
// ============================================================================

/** 一个 IP 点（攻击起点 / 信息包点）。`lng/lat` 必须来自宿主的负载。 */
export interface GuidePoint extends GeoPoint {
  id: string
  name?: string
  /** 宿主若给了国军标符号键就画 `symbol`（否则画 `label`） —— 前端**不猜**符号 */
  symbol?: string
  affiliation?: 'friend' | 'hostile' | 'neutral' | 'unknown'
  kind?: string
  /** 这个点的来源（实测 `source`：宿主写明"来自哪个文件的哪个键"） */
  source?: string
  note?: string
  raw: unknown
}

/** 一条引导连线。`resolved=false` 表示宿主只给了键引用而没有几何 → 界面**不画**，只如实记录。 */
export interface GuideLink {
  id: string
  name?: string
  kind?: string
  /** 已解析出的线（至少 2 点才画） */
  points: [number, number][]
  fromId?: string
  toId?: string
  resolved: boolean
  note?: string
  raw: unknown
}

/** 时间轴一段（t0/到达/打击/评估）。`basis` = "这个时刻是怎么算出来的"。 */
export interface TimelineSeg {
  key: string
  /** 段名（宿主 `name/label` 优先，其次词典，最后原域） */
  label: string
  /** 时刻显示：有相对分钟（`offsetMinutes`）→ `T+mm`；否则用宿主给的绝对时刻 */
  tText: string
  minutes?: number
  at?: string
  /** 主时刻取自哪个字段（**排障与举证用**：`offsetMinutes` / `atText` …） */
  timeKey?: string
  /** 推算依据（宿主原话：实测是 `{formula, inputs, source}` 三件套） */
  basis?: string
  /** basis 所在的字段名（排障用：字段改名了也能看出来） */
  basisKey?: string
  /** 推算公式的输入（宿主给的数，原样列出——"不编数"的证据） */
  basisInputs: { path: string; value: string }[]
  /** 这一段的留空原因（实测 `note`：宿主写明为什么留空） */
  note?: string
  metrics: Metric[]
  raw: unknown
}

/** 一个平台成员（实测 `guidance.groups[].members[]`：台账里的实体 + 位置）。 */
export interface ClusterMember {
  key: string
  name: string
  entityId?: string
  model?: string
  no?: number
  /** 台账坐标（宿主给了才显示；界面**不画**它——画平台是 MapStage 的事） */
  geo?: GeoPoint
}

/** 一个方案集群的调度情况（实测 `guidance.groups[]`）。 */
export interface ClusterGroup {
  key: string
  name: string
  leader?: string
  /** 编入的平台（实测是对象数组，不是字符串数组） */
  members: ClusterMember[]
  resolved?: boolean
  /** 集群台账来源（实测 `clusterSource`：已确认的编组方案 / 场景编制） */
  source?: string
  reason?: string
}

export interface GuidanceView {
  raw: unknown
  planId?: string
  planName?: string
  /** 打击目标点（宿主给了才画） */
  target?: GuidePoint
  /** IP 点（攻击起点/信息包点…宿主给几个画几个） */
  points: GuidePoint[]
  /** 引导连线（宿主给的原始清单，含"没几何画不出来"的那些） */
  links: GuideLink[]
  /** 宿主直接给的航线（实测 `assessRoute.waypoints` 等）：`[{id,name,points}]` */
  routes: { id: string; name?: string; kind?: string; points: [number, number][] }[]
  timeline: TimelineSeg[]
  /** t0 的锚点（实测 `timeline.anchor`：宿主写明 t0 是谁的时刻、来自哪个引擎台账） */
  anchor?: { text?: string; source?: string; kind?: string; phaseKey?: string }
  /** 方案集群的调度情况（实测 `guidance.groups[]`） */
  clusters: ClusterGroup[]
  /** 集群匹配口径（实测 `matchRule`）与统计 */
  clusterNote?: string
  clustersDeclared?: number
  clustersMatched?: number
  /** 编入的平台总数（实测 `membersTotal`；与"匹配集群数"是两回事，分开读） */
  membersTotal?: number
  /** 协同/资源类读数（宿主给了就显示） */
  metrics: Metric[]
  /** 结论文本（AI 确认建议 / 口径说明） */
  advice: string[]
  notes: string[]
  /** 兜底：回执里所有数值/短文本叶子（路径 → 值） */
  pairs: { path: string; value: string }[]
  /** 宿主给了但**画不出来**的项（如连线只有键引用）——如实显示，MUST NOT 编坐标 */
  unresolved: string[]
}

/** 逐项读一组点（每项都要有经纬度才算"能画"）。 */
function readPoints(v: unknown, prefix: string): GuidePoint[] {
  return objList(v).map((p, i) => {
    const geo = geoOf(p)
    const id = str(p, 'id', 'key', 'pointKey', 'ipKey', 'name') ?? `${prefix}${i}`
    const aff = str(p, 'affiliation', 'side', 'force')
    // 敌我属性域 → map-2d 的四个取值；不认识就留空（符号框形/颜色由 map-2d 自己决定，前端不猜）
    const affiliation: GuidePoint['affiliation'] =
      aff === 'friend' || aff === 'hostile' || aff === 'neutral' || aff === 'unknown' ? aff : undefined
    return {
      id,
      name: str(p, 'name', 'label', 'title', 'text'),
      lng: geo?.lng ?? NaN,
      lat: geo?.lat ?? NaN,
      altM: geo?.altM,
      symbol: str(p, 'symbol', 'symbolKey', 'milSymbol'),
      affiliation,
      kind: str(p, 'kind', 'type', 'role'),
      source: str(p, 'source', 'from'),
      note: str(p, 'note', 'basis', 'explain'),
      raw: p,
    }
  }).filter((p) => Number.isFinite(p.lng) && Number.isFinite(p.lat))
}

/** 一组坐标点 → `[lng,lat][]`（只接受**成对数字**；非法项丢弃，不补）。 */
function toLine(v: unknown): [number, number][] {
  if (!Array.isArray(v)) return []
  const out: [number, number][] = []
  for (const it of v) {
    const g = geoOf(it)
    if (g) out.push([g.lng, g.lat])
  }
  return out
}

/** 从若干候选 key 里挑第一个"真有数组（或对象）"的读点列。 */
function firstLine(scopes: (J | undefined)[], keys: string[]): { key: string; points: [number, number][] } | undefined {
  for (const scope of scopes) {
    if (!scope) continue
    for (const k of keys) {
      const raw = scope[k]
      const pts = toLine(Array.isArray(raw) ? raw : (isObj(raw) ? pick(raw, 'waypoints', 'points', 'path', 'coordinates', 'coords') : undefined))
      if (pts.length >= 2) return { key: k, points: pts }
    }
  }
  return undefined
}

/** 端点：可能是坐标（数组/对象），也可能是**键引用**（字符串/id）。 */
function endpoint(v: unknown, pts: GuidePoint[], target?: GuidePoint): { geo?: GeoPoint; id?: string; name?: string } {
  if (typeof v === 'string') {
    const hit = pts.find((p) => p.id === v || p.name === v) ?? (target && (target.id === v || target.name === v) ? target : undefined)
    return hit ? { geo: { lng: hit.lng, lat: hit.lat, altM: hit.altM }, id: hit.id, name: hit.name } : { id: v }
  }
  const g = geoOf(v)
  const id = str(v, 'id', 'key', 'pointKey', 'refKey', 'entityId')
  const name = str(v, 'name', 'label', 'title')
  if (g) return { geo: g, id, name }
  // 只给了键引用：{key:'ip-c-north'} / {entityId:'target-003'} → 去**回执自己的点表**里找
  if (id) {
    const hit = pts.find((p) => p.id === id) ?? (target && (target.id === id || target.name === id) ? target : undefined)
    if (hit) return { geo: { lng: hit.lng, lat: hit.lat, altM: hit.altM }, id: hit.id, name: hit.name ?? name }
    return { id, name }
  }
  return { name }
}

/** 推算依据：宿主给字符串就直接用；给对象就读 `formula/text/expr/how` + `source`。 */
function readBasis(v: unknown): { text?: string; key?: string; inputs: { path: string; value: string }[] } {
  if (typeof v === 'string' && v) return { text: v, inputs: [] }
  if (!isObj(v)) return { inputs: [] }
  const formula = asStr(pick(v, 'formula', 'text', 'expr', 'how', 'rule', 'detail'))
  const source = asStr(pick(v, 'source', 'from', 'origin'))
  const text = [formula, source].filter(Boolean).join(' ｜ ') || undefined
  return { text, inputs: rawPairs(pick(v, 'inputs', 'values', 'params'), '', [], 12) }
}

/**
 * 把 `guidance.plan` 读成视图。
 *
 * 契约（`流程接口冻结.md` §2 步 9）：宿主给"IP 点 + 引导连线 + 时间轴"，几何来自 `scenario-data`
 * （`data/scenario-1/strike-geometry.json`）。实测形状见文件头。
 * 各组按常见命名逐组试：**哪组真有数组就用哪组**（不是"哪个键名更像"）。
 */
export function readGuidance(data: unknown): GuidanceView {
  const dataObj = isObj(data) ? data : undefined
  // 有的实现会包一层 `{plan:{…}}`；实测是**平铺**（`data` 自己就是引导方案）
  const src = obj(dataObj, 'plan') ?? dataObj
  // `guidance` 子对象：实测是**集群调度段**；也兼容"整份负载被包在 guidance 里"的实现
  // → 两个作用域都当候选，哪层真有数组就用哪层
  const inner = obj(src, 'guidance')
  const scopes: (J | undefined)[] = [src, inner]

  // ---- 目标点 ----
  const targetRaw = pick(src, 'target', 'aim', 'aimPoint', 'targetPoint', 'targetInfo')
  const targetPts = readPoints(Array.isArray(targetRaw) ? targetRaw : (targetRaw ? [targetRaw] : []), 'TGT:')
  const target = targetPts[0]

  // ---- IP 点（实测单数 `ipPoint`；也收复数/数组形态；两层作用域都试） ----
  const pointKeys = ['ipPoints', 'ips', 'ipPoint', 'ip', 'points', 'attackStarts', 'attackStart', 'infoPoints', 'informationPoints', 'informationPoint', 'nodes', 'marks']
  let points: GuidePoint[] = []
  outer:
  for (const scope of scopes) {
    if (!scope) continue
    for (const k of pointKeys) {
      const raw = scope[k]
      if (Array.isArray(raw) && raw.length) { points = readPoints(raw, 'IP:'); if (points.length) break outer }
      if (isObj(raw)) { const one = readPoints([raw], 'IP:'); if (one.length) { points = one; break outer } }
    }
  }

  // ---- 引导连线 ----
  const linkKeys = ['links', 'guidanceLinks', 'guideLinks', 'lines', 'connections', 'edges']
  let linksRaw: J[] = []
  for (const scope of scopes) {
    for (const k of linkKeys) {
      const raw = objList(scope, k)
      if (raw.length) { linksRaw = raw; break }
    }
    if (linksRaw.length) break
  }
  const unresolved: string[] = []
  const links: GuideLink[] = linksRaw.map((l, i) => {
    const id = str(l, 'id', 'key', 'linkId') ?? `gl${i}`
    const name = str(l, 'name', 'label', 'title')
    const kind = str(l, 'kind', 'type', 'role')
    // 形态一：直接给了点列
    const direct = toLine(pick(l, 'points', 'path', 'coordinates', 'coords', 'line'))
      .concat(toLine(pick(l, 'waypoints')))
    if (direct.length >= 2) {
      return { id, name, kind, points: direct, fromId: str(l, 'fromId'), toId: str(l, 'toId'), resolved: true, raw: l }
    }
    // 形态二：from → to（坐标或键引用）
    const f = endpoint(pick(l, 'from', 'source', 'src', 'start', 'a'), points, target)
    const t = endpoint(pick(l, 'to', 'target', 'dst', 'end', 'b'), points, target)
    const pts: [number, number][] = f.geo && t.geo ? [[f.geo.lng, f.geo.lat], [t.geo.lng, t.geo.lat]] : []
    const note = str(l, 'note', 'basis', 'explain', 'reason')
    if (pts.length < 2) {
      unresolved.push(`连线 ${id}${name ? `（${name}）` : ''}：只给了键引用 ${f.id ?? '?'} → ${t.id ?? '?'}，未给几何 → **不画**（前端不编坐标）`)
    }
    return { id, name, kind, points: pts, fromId: f.id, toId: t.id, resolved: pts.length >= 2, note, raw: l }
  })

  // ---- 航线（实测 `assessRoute.waypoints`；也收 `routes[]`/`assessRoutes[]` 等） ----
  const routes: GuidanceView['routes'] = []
  const routeKeys = ['routes', 'assessRoutes', 'assessRoute', 'flightRoutes', 'paths', 'polylines']
  for (const scope of scopes) {
    if (!scope) continue
    for (const k of routeKeys) {
      const raw = scope[k]
      if (Array.isArray(raw) && raw.length) {
        for (const [i, r] of objList(raw).entries()) {
          const pts = toLine(pick(r, 'points', 'waypoints', 'path', 'coordinates', 'coords'))
          if (pts.length >= 2) routes.push({ id: str(r, 'id', 'key', 'routeKey') ?? `${k}${i}`, name: str(r, 'name', 'label', 'title'), kind: str(r, 'kind', 'type', 'role'), points: pts })
        }
      } else if (isObj(raw)) {
        const pts = toLine(pick(raw, 'waypoints', 'points', 'path', 'coordinates', 'coords'))
        if (pts.length >= 2) routes.push({ id: str(raw, 'key', 'id', 'routeKey') ?? k, name: str(raw, 'name', 'label', 'title'), kind: k, points: pts })
      }
      if (routes.length) break
    }
    if (routes.length) break
  }

  // ---- 时间轴（实测 `timeline:{anchor, items[]}`；也收数组形态；两层作用域都试） ----
  const tlObj = obj(src, 'timeline') ?? obj(inner, 'timeline')
  let tlRaw: J[] = []
  const tlArrayKeys = ['timelineItems', 'segments', 'phases', 'steps', 'timeLine', 'times', 'schedule']
  for (const scope of scopes) {
    if (!scope) continue
    for (const k of tlArrayKeys) {
      const raw = objList(scope, k)
      if (raw.length) { tlRaw = raw; break }
    }
    if (tlRaw.length) break
  }
  if (!tlRaw.length) {
    // `timeline` 本身是数组 → 直接用；是对象 → 读它的 items/segments
    for (const scope of scopes) {
      const raw = scope?.timeline
      if (Array.isArray(raw) && raw.length) { tlRaw = objList(raw); break }
    }
    if (!tlRaw.length && tlObj) {
      for (const k of ['items', 'segments', 'steps', 'phases']) {
        const list = objList(tlObj, k)
        if (list.length) { tlRaw = list; break }
      }
    }
  }
  // 有的实现把四段摊成 `{t0:{…}, arrive:{…}}`：也收
  if (!tlRaw.length && isObj(src)) {
    const flat = Object.entries(src)
      .filter(([k, v]) => isObj(v) && TIMELINE_ORDER.some((c) => segMatches(k, c)))
      .map(([k, v]) => ({ key: k, ...(v as J) }))
    if (flat.length) tlRaw = flat
  }
  const basisKeys = ['basis', 'derivation', 'derived', 'derivedFrom', 'formula', 'how', 'method', 'rule', 'reason', 'explain', 'source']
  const timeKeys = ['minutes', 'minute', 'offsetMinutes', 'minutesFromT0', 'tPlusMinutes', 'tPlus', 'offsetMin']
  const atKeys = ['at', 'time', 'atText', 'iso', 'ts', 'atMs', 'epochMs']
  const timeline: TimelineSeg[] = tlRaw.map((s, i) => {
    const key = str(s, 'key', 'id', 'segment', 'phase', 'code') ?? str(s, 'name') ?? `seg${i}`
    const label = segLabel(key, str(s, 'label', 'title', 'displayName', 'segmentName', 'name', 'text'))
    const mKey = timeKeys.find((k) => num(s, k) !== undefined)
    const minutes = mKey ? num(s, mKey) : undefined
    const aKey = atKeys.find((k) => pick(s, k) !== undefined)
    const at = aKey ? timeText(pick(s, aKey)) : undefined
    let basis: string | undefined
    let basisKey: string | undefined
    let basisInputs: { path: string; value: string }[] = []
    for (const k of basisKeys) {
      const v = isObj(s) ? s[k] : undefined
      const b = readBasis(v)
      if (b.text) { basis = b.text; basisKey = k; basisInputs = b.inputs; break }
    }
    const shown = new Set(['key', 'id', 'segment', 'phase', 'code', 'label', 'title', 'text', 'segmentName', 'displayName', 'name',
      ...timeKeys, ...atKeys, ...basisKeys, 'note', 'detail', 'message', 'emptyReason'])
    return {
      key,
      label,
      tText: minutes !== undefined ? tPlus(minutes) : (at ?? '—'),
      minutes,
      at,
      timeKey: minutes !== undefined ? mKey : aKey,
      basis,
      basisKey,
      basisInputs,
      note: str(s, 'note', 'detail', 'message', 'emptyReason'),
      metrics: sane(toMetrics(pick(s, 'metrics', 'items', 'values'))).filter((m) => !shown.has(m.key)),
      raw: s,
    }
  })

  // ---- 集群调度（实测 `guidance.groups[]`：**members 是对象数组**，逐集群说明编入/未编入与原因） ----
  const clusters: ClusterGroup[] = objList(inner, 'groups', 'clusters').map((c, i) => ({
    key: str(c, 'key', 'id', 'groupId', 'groupKey', 'planCluster') ?? `c${i}`,
    name: str(c, 'planCluster', 'name', 'label', 'groupName') ?? `集群 ${i + 1}`,
    leader: str(c, 'leader', 'leaderId', 'lead'),
    members: objList(c, 'members', 'devices', 'platforms').map((m, j) => ({
      key: str(m, 'entityId', 'deviceId', 'id', 'key') ?? `m${j}`,
      // 名字优先用台账里的可读字段；都没有就用 id（**不编**）
      name: str(m, 'deviceId', 'name', 'label', 'no') ?? str(m, 'entityId', 'id') ?? `#${j + 1}`,
      entityId: str(m, 'entityId', 'id'),
      model: str(m, 'model', 'typeKey', 'type'),
      no: num(m, 'no', 'seq'),
      geo: geoOf(pick(m, 'position', 'pos', 'station', 'location')),
    })),
    resolved: bool(c, 'resolved', 'matched'),
    source: str(c, 'clusterSource', 'source'),
    reason: str(c, 'reason', 'note', 'detail'),
  }))

  const advBase = obj(src, 'assessRouteSummary')
  const advFlight = obj(src, 'assessFlight')
  const metrics = [
    ...sane(toMetrics(pick(advBase, 'lengthM', 'waypointCount', 'lengthBasis'))),
    ...sane(toMetrics(pick(advFlight, 'durationMinutes', 'speedMps', 'speedSamples', 'lengthM'))),
    ...sane(toMetrics(pick(src, 'metrics', 'summary', 'totals'))),
  ]
  const advice = [
    ...strList(src, 'advice', 'suggestion', 'suggestions', 'recommendation', 'recommendations', 'conclusions'),
    ...strList(obj(src, 'ai'), 'advice', 'suggestion', 'text', 'message'),
  ]

  return {
    raw: data,
    planId: str(src, 'planId', 'id') ?? str(obj(src, 'plan'), 'id'),
    planName: str(src, 'planName', 'name') ?? str(obj(src, 'plan'), 'name'),
    target,
    points,
    links,
    routes,
    timeline,
    anchor: tlObj
      ? {
        text: asStr(pick(obj(tlObj, 'anchor'), 'atText', 'text', 'at')),
        source: asStr(pick(obj(tlObj, 'anchor'), 'source', 'from')),
        kind: asStr(pick(obj(tlObj, 'anchor'), 'kind', 'type')),
        phaseKey: asStr(pick(obj(tlObj, 'anchor'), 'phaseKey', 'phase')),
      }
      : undefined,
    clusters,
    clusterNote: inner ? asStr(pick(inner, 'matchRule', 'note')) : undefined,
    clustersDeclared: inner ? num(inner, 'clustersDeclared') : undefined,
    clustersMatched: inner ? num(inner, 'clustersMatched') : undefined,
    membersTotal: inner ? num(inner, 'membersTotal', 'memberCount') : undefined,
    metrics,
    advice,
    notes: strList(src, 'notes', 'note', 'explain'),
    pairs: rawPairs(data, '', [], 80),
    unresolved,
  }
}

// ============================================================================
// ⑤ 步 9 · 打击命令回执（`strike.adopt` / `strike.confirm`）——「逐条显示」
// ============================================================================

/**
 * 命令回执视图。
 *
 * 契约把细节放在 `data` 里（P3 实测：1003 的 `unmet` 在 **data** 而不是 error 里），
 * 所以这里两面都读；同时给出 `pairs`（回执里所有叶子的原样清单），保证**逐条显示**：
 * 宿主回了什么，界面上就能看到什么，一个字段都不吞。
 * ⚠ `advance`（阶段引擎的整棵台账：audit/timeline/state…）**不铺进 pairs** ——
 *   它会把回执本身的字段淹掉；阶段结论用 `toStep/phase` 两行显示。
 */
export interface ReceiptView {
  raw: unknown
  planId?: string
  /** scoring 的 planState（`adopted` / `confirmed`…）——**域，不翻译成结论** */
  planState?: string
  action?: string
  status?: string
  idempotent?: boolean
  conflict?: boolean
  deviated?: boolean
  /** 宿主推进到的步（给了才显示；宿主不自动推进时就是"—"） */
  toStep?: number
  phase?: string
  message?: string
  recommendedId?: string
  autoAdopted?: boolean
  unmet: string[]
  invalidated: string[]
  /** 逐条：回执里所有数值/短文本叶子（`advance` 除外） */
  pairs: { path: string; value: string }[]
}

export function readReceipt(data: unknown): ReceiptView {
  const outer = isObj(data) ? data : undefined
  const inner = obj(outer, 'data')
  const src = (inner && (str(inner, 'planId') ?? str(inner, 'planState') ?? str(inner, 'status'))) ? inner : outer
  const ev = obj(src, 'event')
  const flat = src && isObj(src)
    ? Object.fromEntries(Object.entries(src).filter(([k]) => k !== 'advance' && k !== 'event'))
    : src
  return {
    raw: data,
    planId: str(src, 'planId') ?? str(outer, 'planId') ?? str(ev, 'planId'),
    planState: str(src, 'planState') ?? str(outer, 'planState') ?? str(ev, 'planState'),
    action: str(src, 'action', 'actionKey') ?? str(outer, 'action') ?? str(ev, 'action'),
    status: str(src, 'status', 'state', 'result') ?? str(outer, 'status'),
    idempotent: bool(src, 'idempotent') ?? bool(outer, 'idempotent') ?? bool(ev, 'idempotent'),
    conflict: bool(src, 'conflict') ?? bool(outer, 'conflict') ?? bool(ev, 'conflict'),
    deviated: bool(src, 'deviated') ?? bool(outer, 'deviated') ?? bool(ev, 'deviated'),
    toStep: num(src, 'toStep', 'nextStep') ?? num(outer, 'toStep', 'nextStep'),
    phase: str(src, 'phase', 'phaseKey', 'toPhase') ?? str(outer, 'phase', 'phaseKey'),
    message: str(src, 'message', 'reason', 'detail') ?? str(outer, 'message'),
    recommendedId: str(src, 'recommendedId') ?? str(outer, 'recommendedId') ?? str(ev, 'recommendedId'),
    autoAdopted: bool(src, 'autoAdopted') ?? bool(outer, 'autoAdopted'),
    unmet: [...strList(src, 'unmet'), ...strList(outer, 'unmet')],
    invalidated: [...strList(src, 'invalidated'), ...strList(outer, 'invalidated')],
    pairs: rawPairs(flat, '', [], 40),
  }
}

// ============================================================================
// ⑥ 排障后门：把"读取器"挂到 window 上（**只读、不改渲染**）
// ============================================================================
//
// 用途：宿主 verb 还没装配时，验收脚本可以在真页面上用**合成负载**调一遍读取器，
// 回答"宿主真按契约给字段时，界面能不能读出来"。这**不是**数据源：
// 渲染路径永远只读宿主回执（与 useOps 的 `__p4Read`、App 的 `?stage=map` 同一性质）。
// 步 9 的地图图元计数会由 `StrikeConfirmScreen` 追加到同一个句柄的 `map` 键上。
if (typeof window !== 'undefined') {
  const w = window as unknown as { __p5Read?: Record<string, unknown> }
  w.__p5Read = {
    ...(w.__p5Read ?? {}),
    readStrikePlans, readStrikeWindow, readGuidance, readReceipt,
    coordinationCN, segLabel, segMatches, geoOf, tPlus, shortTime,
  }
}
