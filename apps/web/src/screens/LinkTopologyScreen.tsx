// mission-app · apps/web/src/screens/LinkTopologyScreen.tsx
//
// SH-07「链路拓扑界面」（需求专篇 DES-APP-001 §3 SH-07 / 参考图 `场景1\T2-1.png`）。
//
// 版式（照图）：左导航（全局壳）｜中区链路拓扑大图（约占 2/3）｜右栏「AI链路分析」（贯通上下）
//              ｜底部通栏 4 张状态卡｜中区右下 2 枚按钮【自动优化链路】【进入侦察阶段】。
//              本屏**没有**地图工具条/显示模式/比例尺/罗盘（图上就没有）。
//
// ★ 数据纪律（本屏最容易犯的三个错，写在这里）：
//   ① **节点与连线是"版式"**：图上是固定拓扑（6 个六边形集群 + 前沿指挥节点、绿实线成网、
//      橙黄虚线接指挥节点与部分集群），所以节点坐标写死为版式坐标（`SLOTS`）；
//      **但每一条线的状态只认 `topology.evaluate` 的读数**：`data-read="engine"` 的线按引擎
//      给的域经 `linkColor()` 上色；引擎没给这一对节点的读数时，线**按版式配色绘制但状态标
//      「—」**（`data-state=""` + tooltip 写明"引擎未给该节点对的链路读数"），
//      MUST NOT 把版式绿当成"引擎判绿"。
//   ② **右栏数值全部取引擎**：4 个环形表 = `evaluation.items[]`（stability/coverage/cooperation/
//      interference，尺度 0–1 → ×100 显示并在 tooltip 里标出原始值）；6 行质量指标里
//      `signal / bandwidthMbps / latencyMs / coverageKm2` 本工程**没有实测源**（宿主 `notes[]`
//      明说），一律「—」+ 原因；`lossRate` / `meshProgress` 取真实读数。
//   ③ **仿真控制条是"额外保留"**（图上没有这一条）：演示与验收脚本要用旧 ExecuteScreen 的
//      `btn-sim-start / btn-sim-pause / btn-sim-resume / btn-speed-1|8|60 / btn-link-optimize`
//      这几个 testid 与 sim.* 能力，所以它作为一条紧凑控制条保留在本屏（见 `SimControlStrip`）。
//
// 复用：`LinkStableScreen`（SH-08）与本屏共用拓扑图、读数、底卡、仿真条与按钮，组件从本文件导出。
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { C, panel, panelTitle, statusColor } from '../theme'
import type { CommandReply, FlowState } from '../api'
import type { UseFlow } from '../flow/useFlow'
import {
  isObj, n2s, num, obj, objList, readInventory, replyText, str, strList, useVerbOnce, type Metric,
} from '../flow/useSituation'
import { linkColor, ms2clock, readSim, readTopology, SIM_SPEEDS, type TopologyView } from '../flow/useOps'
import { VerbVerdict } from './VerbVerdict'

// ============================================================================
// ① 版式拓扑（节点坐标 = 版式坐标，照 T2-1；节点名逐字照图）
// ============================================================================

/** 版式槽位键（与引擎 `primitives.clusters[].id` 的 `grp:<key>` 对齐，便于把读数绑到节点上）。 */
export type SlotKey = 'recon-1' | 'recon-2' | 'radar-1' | 'relay-1' | 'ew-1' | 'reserve-1' | 'cmd'

interface Slot {
  key: SlotKey
  /** 逐字照图 */
  label: string
  x: number
  y: number
  role: 'cluster' | 'command'
}

/** 版式坐标（viewBox 1000×700）：与 T2-1 的相对位置一致（左上/右上/左中/右中/左下/右下 + 左下角指挥节点）。
 *  同列节点的垂直间距 ≥ 162（六边形高 132）—— 免得两个六边形叠在一起。 */
const SLOTS: Slot[] = [
  { key: 'recon-1', label: '前出侦察集群', x: 305, y: 120, role: 'cluster' },
  { key: 'recon-2', label: '侧翼侦察集群', x: 700, y: 116, role: 'cluster' },
  { key: 'radar-1', label: '雷达探测集群', x: 238, y: 272, role: 'cluster' },
  { key: 'relay-1', label: '通信中继集群', x: 700, y: 286, role: 'cluster' },
  { key: 'ew-1', label: '电子压制集群', x: 312, y: 420, role: 'cluster' },
  { key: 'reserve-1', label: '机动预备集群', x: 700, y: 448, role: 'cluster' },
  { key: 'cmd', label: '前沿指挥节点', x: 222, y: 588, role: 'command' },
]

const SLOT_BY_KEY: Record<string, Slot> = Object.fromEntries(SLOTS.map((s) => [s.key, s]))

/** 绿色实线成网（照图：6 个集群之间成网并在画面正中交汇）。 */
const MESH_EDGES: [SlotKey, SlotKey][] = [
  ['recon-1', 'recon-2'], ['recon-1', 'radar-1'], ['recon-1', 'relay-1'], ['recon-1', 'ew-1'],
  ['recon-1', 'reserve-1'], ['recon-2', 'radar-1'], ['recon-2', 'relay-1'], ['recon-2', 'ew-1'],
  ['recon-2', 'reserve-1'], ['radar-1', 'relay-1'],
]

/** 橙黄虚线（照图：接指挥节点与部分集群）。 */
const COMMAND_EDGES: [SlotKey, SlotKey][] = [
  ['cmd', 'ew-1'], ['cmd', 'reserve-1'], ['radar-1', 'ew-1'], ['relay-1', 'reserve-1'], ['ew-1', 'reserve-1'],
]

/** 图例口径（图上无图例，这里只作为 tooltip/脚注的措辞，不新增图例控件）。 */
const CLASS_TEXT = { mesh: '集群成网（绿实线）', command: '指挥节点/部分集群（橙黄虚线）' } as const

// ============================================================================
// ② 读取器：`topology.evaluate` 的原始负载 → 本屏要的形状（只取字段，不判断）
// ============================================================================

/** 一个网络评估项（`evaluation.items[]`，字段原样）。 */
export interface EvalItemView {
  key: string
  /** 界面用的中文名（词典：key 不认识就显示原 key，不猜） */
  cn: string
  value?: number
  normalized?: number
  scaleMin?: number
  scaleMax?: number
  weight?: number
  /** `requirement.satisfied`（引擎的判据结论，**界面不自己判**） */
  satisfied?: boolean
  reqMetric?: string
  reqOp?: string
  reqLimit?: number
  reqActual?: number
}

/** `metricDetail[]` 的一行（实测：`{linkId, ingested[], notIngested[], lossRate, throughputMbps…}`）。 */
export interface MetricDetailRow {
  linkId: string
  deviceType?: string
  ingested: string[]
  notIngested: string[]
  lossRate?: number
  throughputMbps?: number
}

/** `primitives`（引擎给 map-2d 的图元：集群有真实坐标与名字）。 */
export interface PrimView {
  topologyId?: string
  structureKey?: string
  clusters: { id: string; name?: string; lng?: number; lat?: number }[]
  linkCount: number
  graphicCount: number
  missing: string[]
  missingClusterCoordinates: string[]
}

/** 塌缩到集群层的引擎链路读数（一对节点 → 该对上的链路）。 */
export interface PairRead {
  count: number
  /** 引擎判的状态域（原样，可能为空 = 引擎未判） */
  states: string[]
  scores: number[]
  linkIds: string[]
}

export interface LinkReadings {
  raw: unknown
  linkCount?: number
  linksWithState?: number
  linksWithScore?: number
  evalItems: EvalItemView[]
  overall?: number
  /** `evaluation.inputs`（键原样：linkUpRatio / meshProgress / coverageRatio…） */
  inputs: Record<string, number>
  /** 宿主的口径说明（`notes[]`，原话） */
  notes: string[]
  metricDetail: MetricDetailRow[]
  prim: PrimView
  /** 版式槽位 → 引擎集群（名字/坐标；引擎没给就没有这一项） */
  clusterBySlot: Partial<Record<SlotKey, { id: string; name?: string; lng?: number; lat?: number }>>
  /** 节点对 → 该对上的引擎链路（`grp:a` + `grp:b` 归并；平台端按 `topology.linkTo` 塌缩到它的集群） */
  pairReads: Record<string, PairRead>
  /** 每个槽位上的链路条数（含平台↔集群的自环链路，是宿主的数） */
  slotLinkCount: Record<string, number>
  /** 端点塌缩不到集群的链路 id（本屏不画，但要如实计数） */
  unmappedLinks: string[]
  linkTo: Record<string, string>
}

/** 评估项 key → 中文（词典；不认识就显示原 key —— 不猜）。 */
const EVAL_KEY_CN: Record<string, string> = {
  stability: '链路稳定度',
  coverage: '覆盖率',
  cooperation: '协同效率',
  coordination: '协同效率',
  interference: '抗干扰能力',
  antiJamming: '抗干扰能力',
  jamming: '抗干扰能力',
}

/** 本屏 4 个环形表要的项：显示名 + 引擎可能的 key（顺序即界面顺序，照图）。 */
export const RING_SLOTS: { cn: string; keys: string[] }[] = [
  { cn: '链路稳定度', keys: ['stability'] },
  { cn: '覆盖率', keys: ['coverage'] },
  { cn: '协同效率', keys: ['cooperation', 'coordination'] },
  { cn: '抗干扰能力', keys: ['interference', 'antiJamming', 'jamming'] },
]

export function evalItemOf(rd: LinkReadings, keys: string[]): EvalItemView | undefined {
  for (const k of keys) {
    const hit = rd.evalItems.find((i) => i.key.toLowerCase() === k.toLowerCase())
    if (hit) return hit
  }
  return undefined
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join('|')
}

/** 把引擎节点 id 塌缩到版式槽位：`grp:xxx` → xxx；平台节点按 `topology.linkTo` 找它归属的集群。 */
function slotOfNode(nodeId: string, linkTo: Record<string, string>): SlotKey | undefined {
  const id = nodeId.startsWith('grp:') ? nodeId.slice(4) : (linkTo[nodeId] ?? '')
  const key = id.startsWith('grp:') ? id.slice(4) : id
  return key && SLOT_BY_KEY[key] ? (key as SlotKey) : undefined
}

/**
 * 读 `topology.evaluate` 的回执。
 *
 * 只做"取字段 + 归并"，**一个数都不加**：读不到的留 undefined，界面显示「—」。
 */
export function readLinkReadings(data: unknown): LinkReadings {
  const src = isObj(data) ? data : undefined
  const ev = obj(src, 'evaluation')
  const inputsRaw = obj(ev, 'inputs') ?? obj(src, 'inputs')
  const inputs: Record<string, number> = {}
  if (inputsRaw) for (const [k, v] of Object.entries(inputsRaw)) {
    if (typeof v === 'number' && Number.isFinite(v)) inputs[k] = v
  }
  const evalItems: EvalItemView[] = objList(ev, 'items').map((it, i) => {
    const key = str(it, 'key', 'id') ?? `e${i}`
    const req = obj(it, 'requirement')
    return {
      key,
      cn: EVAL_KEY_CN[key.toLowerCase()] ?? str(it, 'name', 'label') ?? key,
      value: num(it, 'value'),
      normalized: num(it, 'normalized'),
      scaleMin: num(it, 'scaleMin'),
      scaleMax: num(it, 'scaleMax'),
      weight: num(it, 'weight'),
      satisfied: typeof req?.satisfied === 'boolean' ? req.satisfied : undefined,
      reqMetric: str(req, 'metric'),
      reqOp: str(req, 'op'),
      reqLimit: num(req, 'limit'),
      reqActual: num(req, 'actual'),
    }
  })

  const metricDetail: MetricDetailRow[] = objList(src, 'metricDetail').map((r, i) => ({
    linkId: str(r, 'linkId', 'id') ?? `m${i}`,
    deviceType: str(r, 'deviceType'),
    ingested: strList(r, 'ingested'),
    notIngested: strList(r, 'notIngested'),
    lossRate: num(r, 'lossRate'),
    throughputMbps: num(r, 'throughputMbps'),
  }))

  const primRaw = obj(src, 'primitives')
  const prim: PrimView = {
    topologyId: str(primRaw, 'topologyId'),
    structureKey: str(primRaw, 'structureKey'),
    clusters: objList(primRaw, 'clusters').map((c, i) => ({
      id: str(c, 'id', 'key') ?? `c${i}`,
      name: str(c, 'name', 'label'),
      lng: num(c, 'lng'),
      lat: num(c, 'lat'),
    })),
    linkCount: objList(primRaw, 'links').length,
    graphicCount: objList(primRaw, 'graphics').length,
    missing: strList(primRaw, 'missingCoordinates'),
    missingClusterCoordinates: strList(primRaw, 'missingClusterCoordinates'),
  }

  const clusterBySlot: LinkReadings['clusterBySlot'] = {}
  for (const c of prim.clusters) {
    const key = (c.id.startsWith('grp:') ? c.id.slice(4) : c.id) as SlotKey
    if (SLOT_BY_KEY[key]) clusterBySlot[key] = c
  }

  const linkToRaw = obj(obj(src, 'topology'), 'linkTo')
  const linkTo: Record<string, string> = {}
  if (linkToRaw) for (const [k, v] of Object.entries(linkToRaw)) if (typeof v === 'string') linkTo[k] = v

  const pairReads: Record<string, PairRead> = {}
  const slotLinkCount: Record<string, number> = {}
  const unmappedLinks: string[] = []
  for (const l of objList(src, 'links')) {
    const id = str(l, 'linkId', 'id', 'key') ?? ''
    const a = slotOfNode(str(l, 'from', 'source') ?? '', linkTo)
    const b = slotOfNode(str(l, 'to', 'target') ?? '', linkTo)
    if (!a || !b) { if (id) unmappedLinks.push(id); continue }
    // 节点上的链路条数 = 触及该节点的链路数（自环只算一次；两个端点各记一次）
    slotLinkCount[a] = (slotLinkCount[a] ?? 0) + 1
    if (a !== b) slotLinkCount[b] = (slotLinkCount[b] ?? 0) + 1
    if (a === b) continue // 集群内部链路（平台↔其集群）：节点计数已记，节点对上不画
    const k = pairKey(a, b)
    const cur = pairReads[k] ?? { count: 0, states: [], scores: [], linkIds: [] }
    const st = str(l, 'state', 'status', 'quality')
    const sc = num(l, 'score')
    pairReads[k] = {
      count: cur.count + 1,
      states: st !== undefined ? [...cur.states, st] : cur.states,
      scores: sc !== undefined ? [...cur.scores, sc] : cur.scores,
      linkIds: id ? [...cur.linkIds, id] : cur.linkIds,
    }
  }

  return {
    raw: data,
    linkCount: num(src, 'linkCount', 'totalLinks'),
    linksWithState: num(src, 'linksWithState'),
    linksWithScore: num(src, 'linksWithScore'),
    evalItems,
    overall: num(ev, 'overall', 'score'),
    inputs,
    notes: strList(src, 'notes'),
    metricDetail,
    prim,
    clusterBySlot,
    pairReads,
    slotLinkCount,
    unmappedLinks,
    linkTo,
  }
}

/** 本屏的读数钩子：进屏发一次 `topology.evaluate`（幂等由宿主保证），三份视图一起给。 */
export function useLinkReadings(flow: UseFlow) {
  const call = useVerbOnce(flow, 'topology.evaluate', {}, true)
  const tv: TopologyView = useMemo(() => readTopology(call.data), [call.data])
  const rd: LinkReadings = useMemo(() => readLinkReadings(call.data), [call.data])
  return { call, tv, rd }
}

// ============================================================================
// ③ 小工具（百分比换算只有这一处，规则单一：scaleMax ≤ 1 或值 ≤ 1 视为比例）
// ============================================================================

/**
 * 0–1 比例 → 百分数（**唯一的换算点**）。
 *
 * 为什么允许换算：引擎的 `evaluation.items[].value` 明写 `scaleMin/scaleMax = 0–1`，
 * 环形表只能画百分数；所以这里按引擎自己声明的尺度换算，并把原始值与尺度写进 tooltip。
 */
export function pctOf(v: number | undefined, scaleMax?: number): number | undefined {
  if (v === undefined) return undefined
  const ratio = (scaleMax !== undefined && scaleMax <= 1) || (scaleMax === undefined && v <= 1)
  return ratio ? Number((v * 100).toFixed(1)) : v
}

/** 数值 + 单位（缺失→「—」，不补 0）。 */
function v2s(v: number | undefined, unit = '', digits = 1): string {
  if (v === undefined) return '—'
  return `${Number.isInteger(v) ? v : Number(v.toFixed(digits))}${unit}`
}

/** 宿主 `notes[]` 里与某个字段相关的那一条（拿不到就 undefined —— 不编原因）。 */
function noteOf(notes: string[], ...needles: string[]): string | undefined {
  return notes.find((n) => needles.some((x) => n.toLowerCase().includes(x.toLowerCase())))
}

/**
 * 某指标"没有读数"的原因（**先给证据，再抄宿主原话**）。
 *
 * 证据分两种，不能混为一谈：
 *   · `metricDetail[].notIngested` 里点了名 → "引擎未投该字段"（有据可查的主动不投）；
 *   · 回执里根本没有这个键 → "回执里没有该字段"（别写"未投"，那是另一回事）。
 * 宿主 `notes[]` 的原话附在后面（例如 signal 没有射频测量源、吞吐不是标称带宽）。
 */
export function missingReasonFor(rd: LinkReadings, field: string, cn: string): string {
  const total = rd.metricDetail.length
  const n = rd.metricDetail.filter((r) => r.notIngested.includes(field)).length
  const head = n > 0
    ? `引擎未投 ${field}：${n}/${total} 条链路的 metricDetail[].notIngested 里列着它`
    : `引擎回执里没有 ${field}（links[].metrics[] 与 metricDetail[].ingested 都没出现）`
  const note = noteOf(rd.notes, field, cn)
  return note ? `${head}；宿主口径：${note}` : head
}

/** 一行「名 + 值」：值缺失显示「—」，**不补 0**。 */
function Row({ k, v, color, sub, testid }: { k: string; v: string; color?: string; sub?: string; testid?: string }) {
  return (
    <div data-testid={testid} style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 12.5 }}>
      <span style={{ color: C.textDim, flex: 1, minWidth: 0 }}>{k}</span>
      <span style={{ color: color ?? C.text, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{v}</span>
      {sub !== undefined && <span style={{ color: C.textDim, fontSize: 10.5, whiteSpace: 'nowrap' }}>{sub}</span>}
    </div>
  )
}

/** 右栏分组标题（照图：「推荐链路组织方式」「网络评估」「链路质量指标」）。 */
function GroupTitle({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 12, color: C.textDim, margin: '9px 0 5px' }}>{children}</div>
}

function Section({ title, children, testid, right }: {
  title: ReactNode
  children: ReactNode
  testid?: string
  right?: ReactNode
}) {
  return (
    // box-sizing: border-box —— 免得 width:100% + 边框把 overflowY:auto 的右栏顶出横向滚动条
    <div data-testid={testid} style={{ ...panel, width: '100%', boxSizing: 'border-box' }}>
      <div style={panelTitle}>
        {title}
        {right !== undefined && <span style={{ float: 'right', fontSize: 11.5, color: C.textDim }}>{right}</span>}
      </div>
      <div style={{ padding: '7px 12px 9px' }}>{children}</div>
    </div>
  )
}

// ============================================================================
// ④ 拓扑图（SVG，版式坐标 + 引擎状态）
// ============================================================================

/**
 * 一条版式连线的取色/线形。
 *
 * 规则（**只做"域 → 颜色/线形"的映射，不判好坏**）：
 *   · 引擎给了该节点对的链路状态 → 用 `linkColor(域)`（绿实线 / 橙黄虚线 / 红实线 / 不认识→中性灰）；
 *   · 引擎没给（或给了但未判状态）→ **按版式类配色**（mesh=绿实线、command=橙黄虚线），
 *     状态位留空（界面显示「—」），tooltip 写明"引擎未给该节点对的链路读数"。
 */
function lineStyle(cls: 'mesh' | 'command', read?: PairRead) {
  const state = read?.states.find((s) => s !== undefined && s !== '')
  if (state) {
    const color = linkColor(state)
    const dashed = color === C.warn
    return { color, dashed, state, engine: true }
  }
  return {
    color: cls === 'mesh' ? C.ok : C.warn,
    dashed: cls === 'command',
    state: undefined,
    engine: !!read,
  }
}

/** 拓扑图：6 个六边形集群 + 「前沿指挥节点」+ 两类连线（绿实线成网 / 橙黄虚线接指挥节点）。 */
export function TopologyGraph({ readings, testid, height = 320 }: {
  readings: LinkReadings
  testid: string
  /** 容器最小高度（px；flex 布局里用） */
  height?: number
}) {
  const defs = [...MESH_EDGES.map((e) => ({ e, cls: 'mesh' as const })), ...COMMAND_EDGES.map((e) => ({ e, cls: 'command' as const }))]
  const engineLines = defs.filter(({ e, cls }) => !!readings.pairReads[pairKey(e[0], e[1])] || false).length
  const knownLines = defs.filter(({ e }) => {
    const r = readings.pairReads[pairKey(e[0], e[1])]
    return !!r?.states.some((s) => s)
  }).length

  return (
    <div
      data-testid={testid}
      data-slots={SLOTS.length}
      data-engine-clusters={readings.prim.clusters.length}
      data-lines={defs.length}
      data-lines-with-engine-read={engineLines}
      data-lines-with-state={knownLines}
      style={{
        position: 'relative', flex: 1, minHeight: height, width: '100%', boxSizing: 'border-box',
        border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden',
        // 底图：图上是一张深色卫星影像；本屏不挂地图，用深色渐变 + 淡网格替代（不伪造地形）
        background:
          'radial-gradient(120% 90% at 40% 35%, rgba(12,40,72,.85) 0%, rgba(4,20,38,.96) 60%, rgba(3,14,28,1) 100%)',
      }}
    >
      <svg viewBox="0 0 1000 700" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, width: '100%', height: '100%' }}>
        <defs>
          <pattern id="sh07-grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M40 0 L0 0 0 40" fill="none" stroke="rgba(95,176,255,.10)" strokeWidth="1" />
          </pattern>
          <filter id="sh07-glow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="3" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <rect x="0" y="0" width="1000" height="700" fill="url(#sh07-grid)" />

        {/* ---- 连线（先画线，节点压在上面）---- */}
        {defs.map(({ e, cls }) => {
          const a = SLOT_BY_KEY[e[0]]
          const b = SLOT_BY_KEY[e[1]]
          if (!a || !b) return null
          const read = readings.pairReads[pairKey(e[0], e[1])]
          const st = lineStyle(cls, read)
          const title = [
            `${a.label} ↔ ${b.label}`,
            `${CLASS_TEXT[cls]}（版式）`,
            read
              ? `引擎读数：${read.count} 条链路（${read.linkIds.slice(0, 3).join('、')}${read.linkIds.length > 3 ? '…' : ''}）· 状态 ${st.state ?? '—'}${st.state ? '' : '（引擎未判状态）'}`
              : '引擎未给该节点对的链路读数 → 状态「—」（线形与配色按版式，MUST NOT 当作引擎判绿）',
          ].join('\n')
          return (
            <line
              key={`${cls}-${e[0]}-${e[1]}`}
              data-testid={`sh07-line-${cls}`}
              data-link-class={cls}
              data-pair={`${e[0]}|${e[1]}`}
              data-read={st.engine ? 'engine' : 'none'}
              data-state={st.state ?? ''}
              x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke={st.color}
              strokeWidth={cls === 'mesh' ? 2.4 : 2}
              strokeDasharray={st.dashed ? '9 7' : undefined}
              opacity={st.state ? 0.95 : 0.6}
              filter="url(#sh07-glow)"
            >
              <title>{title}</title>
            </line>
          )
        })}

        {/* ---- 节点 ---- */}
        {SLOTS.map((s) => {
          const eng = readings.clusterBySlot[s.key]
          const label = eng?.name ?? s.label
          const links = readings.slotLinkCount[s.key] ?? 0
          // 该节点上引擎判过的状态（去重）：0 个 → 中性灰；恰好 1 个 → 该域的颜色；多个 → 中性灰（不替引擎取舍）
          const states = new Set<string>()
          for (const [k, r] of Object.entries(readings.pairReads)) {
            if (!k.split('|').includes(s.key)) continue
            for (const st of r.states) if (st) states.add(st)
          }
          const only = states.size === 1 ? [...states][0] : undefined
          const dotColor = only ? linkColor(only) : C.unknown
          if (s.role === 'command') {
            return (
              <g key={s.key} data-testid="sh07-node" data-node={s.key} data-engine={eng ? '1' : '0'} data-state={only ?? ''}>
                <circle cx={s.x} cy={s.y} r={26} fill="rgba(10,32,58,.55)" stroke="rgba(95,176,255,.45)" strokeWidth="1.2" />
                <circle cx={s.x} cy={s.y} r={16} fill="none" stroke="#5fb0ff" strokeWidth="1.6" />
                <circle cx={s.x} cy={s.y} r={5} fill="#8fd0ff" />
                <text x={s.x} y={s.y + 46} textAnchor="middle" fill={C.text} fontSize="20">{label}</text>
                <title>{`${label}\n引擎拓扑（topology.evaluate.primitives）里没有指挥节点：只有 ${readings.prim.clusters.length} 个集群 + ${readings.prim.graphicCount} 个平台节点 → 本节点与它的连线是版式（照图）`}</title>
              </g>
            )
          }
          const rx = 112
          const ry = 66
          const hex = [
            `${s.x - rx * 0.55},${s.y - ry}`, `${s.x + rx * 0.55},${s.y - ry}`, `${s.x + rx},${s.y}`,
            `${s.x + rx * 0.55},${s.y + ry}`, `${s.x - rx * 0.55},${s.y + ry}`, `${s.x - rx},${s.y}`,
          ].join(' ')
          return (
            <g key={s.key} data-testid="sh07-node" data-node={s.key} data-engine={eng ? '1' : '0'} data-state={only ?? ''} data-links={links}>
              <polygon points={hex} fill="rgba(14,42,74,.55)" stroke="rgba(120,200,255,.75)" strokeWidth="1.6" filter="url(#sh07-glow)" />
              <text x={s.x} y={s.y - 2} textAnchor="middle" fill="#eaf4ff" fontSize="21" style={{ letterSpacing: 0.5 }}>{label}</text>
              <text x={s.x} y={s.y + 26} textAnchor="middle" fill={C.textDim} fontSize="15">
                {`链路 ${links} 条${only ? ` · ${only}` : ' · 状态 —'}`}
              </text>
              <circle cx={s.x + rx - 14} cy={s.y - ry + 16} r={6} fill={dotColor} stroke="rgba(0,0,0,.35)" strokeWidth="1" />
              <title>{[
                `${label}${eng ? `（引擎 id=${eng.id}${eng.lng !== undefined ? ` · ${n2s(eng.lng, '')},${n2s(eng.lat, '')}` : ''}）` : '（引擎未给该集群 → 名字按图）'}`,
                `该节点上的链路 ${links} 条（topology.evaluate.links[] 按 linkTo 塌缩到集群后计数）`,
                `状态集合：${states.size ? [...states].join(' / ') : '引擎未判（—）'}`,
              ].join('\n')}</title>
            </g>
          )
        })}
      </svg>

      {/* 脚注：把"哪些线是版式、哪些线有引擎读数"写在图上（图上无图例，故用一行小字，不新增图例控件） */}
      <div data-testid="sh07-topo-note" style={{
        position: 'absolute', left: 10, right: 10, bottom: 8, fontSize: 10.5, color: C.textDim, lineHeight: 1.5,
        background: 'rgba(3,14,28,.72)', border: `1px solid ${C.border}`, borderRadius: 6, padding: '4px 8px',
      }}>
        版式拓扑（照图 T2-1）：<span style={{ color: C.ok }}>绿实线</span>=集群成网、
        <span style={{ color: C.warn }}>橙黄虚线</span>=接前沿指挥节点与部分集群；共 {defs.length} 条线，
        其中 <span style={{ color: C.text }}>{engineLines}</span> 条在本轮 `topology.evaluate` 里有对应链路读数、
        <span style={{ color: C.text }}>{knownLines}</span> 条被引擎判过状态；其余按版式配色绘制且状态标「—」
        （引擎没给该节点对的读数 → MUST NOT 当作引擎判绿）。
      </div>
    </div>
  )
}

// ============================================================================
// ⑤ 环形表 + 右栏「AI链路分析」（SH-07）
// ============================================================================

/** 环形进度表（4 个并排；值缺失画灰环 + 「—」）。 */
function Ring({ value, name, color, testid, title }: {
  value?: number
  name: string
  color: string
  testid?: string
  title?: string
}) {
  const R = 21
  const CIRC = 2 * Math.PI * R
  const pct = value === undefined ? undefined : Math.max(0, Math.min(100, value))
  const dash = pct === undefined ? 0 : (pct / 100) * CIRC
  return (
    <div data-testid={testid} data-ring-name={name} data-value={pct ?? ''} title={title} style={{ width: 76, textAlign: 'center' }}>
      <svg viewBox="0 0 56 56" style={{ width: 56, height: 56 }}>
        <circle cx="28" cy="28" r={R} fill="none" stroke="rgba(95,176,255,.22)" strokeWidth="5" />
        <circle
          cx="28" cy="28" r={R} fill="none" stroke={color} strokeWidth="5" strokeLinecap="round"
          strokeDasharray={`${dash} ${CIRC - dash}`} transform="rotate(-90 28 28)"
        />
        <text x="28" y="32" textAnchor="middle" fill={pct === undefined ? C.unknown : C.text} fontSize="14" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {pct === undefined ? '—' : `${n2s(pct)}%`}
        </text>
      </svg>
      <div style={{ fontSize: 11, color: C.textDim, marginTop: 1, lineHeight: 1.25 }}>{name}</div>
    </div>
  )
}

/** 网络评估 4 环（值 = `evaluation.items[]`，尺度换算与原始值都标出来）。 */
export function EvalRings({ rd }: { rd: LinkReadings }) {
  return (
    <div data-testid="sh07-eval-rings" style={{ display: 'flex', gap: 6, justifyContent: 'space-between' }}>
      {RING_SLOTS.map((slot) => {
        const it = evalItemOf(rd, slot.keys)
        const pct = pctOf(it?.value, it?.scaleMax)
        const color = it === undefined ? C.unknown : it.satisfied === false ? C.warn : C.ok
        const title = it === undefined
          ? `${slot.cn}：引擎 evaluation.items[] 里没有这笔（期望 key：${slot.keys.join(' / ')}）→ 显示「—」`
          : [
            `${slot.cn}（引擎 key=${it.key}）`,
            `value=${it.value ?? '—'} · normalized=${it.normalized ?? '—'} · 尺度 ${it.scaleMin ?? '—'}–${it.scaleMax ?? '—'}`,
            it.reqMetric !== undefined ? `判据 ${it.reqMetric} ${it.reqOp ?? ''} ${it.reqLimit ?? '—'}（actual ${it.reqActual ?? '—'}）→ ${it.satisfied === undefined ? '未给结论' : it.satisfied ? '满足' : '未满足'}` : '引擎未给 requirement',
            `权重 ${it.weight ?? '—'}`,
          ].join('\n')
        return <Ring key={slot.cn} testid="sh07-eval-ring" name={slot.cn} value={pct} color={color} title={title} />
      })}
    </div>
  )
}

/** 「推荐链路组织方式」蓝卡：结论只在引擎全项达标时给出，否则如实列出未满足项。 */
export function VerdictCard({ rd }: { rd: LinkReadings }) {
  const unmet = rd.evalItems.filter((i) => i.satisfied === false)
  const allOk = rd.evalItems.length > 0 && unmet.length === 0
  const st = evalItemOf(rd, ['stability'])
  const coop = evalItemOf(rd, ['cooperation', 'coordination'])
  const latNote = noteOf(rd.notes, 'latencyMs', 'latency', '时延')
  const bullet = (text: string, ok: boolean | undefined, sub: string) => (
    <div data-testid="sh07-verdict-bullet" data-ok={ok === undefined ? '' : ok ? '1' : '0'} title={sub}
      style={{ display: 'flex', gap: 7, alignItems: 'flex-start', fontSize: 12, padding: '2px 0' }}>
      <span style={{
        width: 15, height: 15, flex: '0 0 auto', marginTop: 1, borderRadius: '50%', fontSize: 10.5, lineHeight: '15px',
        textAlign: 'center', color: '#04121f', background: ok === undefined ? C.unknown : ok ? C.ok : C.warn,
      }}>{ok === undefined ? '—' : ok ? '✓' : '!'}</span>
      <span style={{ color: C.text, minWidth: 0 }}>{text}</span>
    </div>
  )
  return (
    <div data-testid="sh07-verdict-card" style={{
      border: `1px solid rgba(95,176,255,.45)`, borderRadius: 9, padding: '10px 11px',
      background: 'linear-gradient(180deg, rgba(29,78,216,.32), rgba(10,32,58,.55))',
    }}>
      <div style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
        <svg viewBox="0 0 24 24" style={{ width: 26, height: 26, flex: '0 0 auto' }}>
          <rect x="7" y="7" width="10" height="10" rx="2" fill="none" stroke="#8fd0ff" strokeWidth="1.6" />
          <path d="M12 3v3M12 18v3M3 12h3M18 12h3" stroke="#8fd0ff" strokeWidth="1.6" />
        </svg>
        <div style={{ minWidth: 0 }}>
          <div data-testid="sh07-verdict-title" style={{
            fontSize: 15.5, color: rd.evalItems.length === 0 ? C.textDim : allOk ? C.ok : C.warn,
          }}>
            {rd.evalItems.length === 0 ? '—（未就绪）' : allOk ? '当前网络稳定' : '当前网络未全项达标'}
          </div>
          <div style={{ fontSize: 10.5, color: C.textDim, lineHeight: 1.4 }}>
            {rd.evalItems.length === 0
              ? 'topology.evaluate 未给出 evaluation.items[] → 不给结论'
              : allOk
                ? `结论口径：evaluation.items[] 全项 requirement.satisfied=true（${rd.evalItems.length} 项）`
                : `${unmet.length}/${rd.evalItems.length} 项未满足：${unmet.map((i) => i.cn).join('、')}（引擎 requirement 原话见 tooltip）`}
          </div>
        </div>
      </div>
      <div style={{ marginTop: 6 }}>
        {bullet(
          '支持多链路协同',
          coop?.satisfied,
          coop
            ? `cooperation：${coop.reqMetric ?? '—'} ${coop.reqOp ?? ''} ${coop.reqLimit ?? '—'}（actual ${coop.reqActual ?? '—'}）→ ${coop.satisfied === undefined ? '引擎未给结论' : coop.satisfied ? '满足' : '未满足'}`
            : 'cooperation：引擎 evaluation.items[] 里没有这一项',
        )}
        {bullet(
          '链路延迟满足实时控制要求',
          undefined,
          latNote
            ? `引擎未提供时延读数（宿主 notes 原话）：${latNote}`
            : '引擎未提供 latencyMs 读数（links[].metrics[] 与时延字段都没出现）→ 该项无法判定，显示「—」',
        )}
      </div>
      {st?.satisfied === false && (
        <div style={{ fontSize: 10.5, color: C.warn, marginTop: 4, lineHeight: 1.5 }}>
          链路稳定度未满足：{st.reqMetric} {st.reqOp} {st.reqLimit}（actual {st.reqActual ?? '—'}）
        </div>
      )}
    </div>
  )
}

/** 一行链路质量指标（值 + 单位 + 来源说明；缺失给「—」+ 原因）。 */
export interface QualityRow {
  key: string
  name: string
  /** 主值文本（缺失 = '—'） */
  text: string
  /** 是否有真实读数 */
  has: boolean
  /** 数值（有进度条时用） */
  value?: number
  unit?: string
  /** 来源/缺失原因（宿主原话优先） */
  note: string
  /** 进度条百分比（局部组网进度这类 0–100 的字段） */
  bar?: number
}

/** 链路质量指标（照图 6 行）：读数取引擎；本工程没有实测源的字段给「—」+ 原因。 */
export function qualityRows(rd: LinkReadings): QualityRow[] {
  const rows: QualityRow[] = []
  /** 汇总某指标在所有链路 `metrics[]` 里的读数（`last` 优先，与 ExecuteScreen 同口径）。 */
  const agg = (keys: string[]) => {
    const vals: number[] = []
    let unit: string | undefined
    for (const l of objList(isObj(rd.raw) ? rd.raw : undefined, 'links')) {
      for (const m of objList(l, 'metrics')) {
        const k = str(m, 'key', 'id') ?? ''
        if (!keys.includes(k)) continue
        const v = num(m, 'last', 'mean', 'value')
        if (v !== undefined) vals.push(v)
        unit = unit ?? str(m, 'unit')
      }
    }
    return { vals, unit }
  }
  // ① 信号强度
  {
    const { vals } = agg(['signal', 'signalStrength', 'rssi'])
    rows.push({
      key: 'signal', name: '信号强度', has: vals.length > 0,
      text: vals.length ? `${n2s(Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1)), ' dBm')}` : '—',
      value: vals.length ? vals[0] : undefined, unit: 'dBm',
      note: vals.length ? `links[].metrics[signal].last 均值（${vals.length} 条）` : missingReasonFor(rd, 'signal', '信号强度'),
    })
  }
  // ② 带宽
  {
    const { vals } = agg(['bandwidthMbps', 'bandwidth'])
    rows.push({
      key: 'bandwidth', name: '带宽', has: vals.length > 0,
      text: vals.length ? v2s(vals[0], ' Mbps') : '—', unit: 'Mbps',
      note: vals.length ? `links[].metrics[bandwidthMbps]` : missingReasonFor(rd, 'bandwidthMbps', '带宽'),
    })
  }
  // ③ 时延
  {
    const { vals } = agg(['latencyMs', 'latency', 'delayMs'])
    rows.push({
      key: 'latency', name: '时延', has: vals.length > 0,
      text: vals.length ? v2s(vals[0], ' ms') : '—', unit: 'ms',
      note: vals.length ? `links[].metrics[latencyMs]` : missingReasonFor(rd, 'latencyMs', '时延'),
    })
  }
  // ④ 丢包率（真实读数：unit=ratio → ×100 显示）
  {
    const { vals, unit } = agg(['lossRate', 'packetLoss'])
    const mean = vals.length ? Number(((vals.reduce((a, b) => a + b, 0) / vals.length) * 100).toFixed(2)) : undefined
    rows.push({
      key: 'loss', name: '丢包率', has: mean !== undefined,
      text: mean === undefined ? '—' : `${mean}`, unit: '%', value: mean,
      note: mean === undefined
        ? missingReasonFor(rd, 'lossRate', '丢包率')
        : `links[].metrics[lossRate].last 均值（${vals.length} 条，unit=${unit ?? 'ratio'} → ×100）`,
    })
  }
  // ⑤ 覆盖范围（链路级覆盖无实测源 —— 宿主 notes 明说，不许拿 sensor.status 的覆盖冒充）
  {
    const { vals } = agg(['coverageKm2', 'coverage'])
    rows.push({
      key: 'coverage', name: '覆盖范围', has: vals.length > 0,
      text: vals.length ? v2s(vals[0], ' km²') : '—', unit: 'km²',
      note: vals.length ? `links[].metrics[coverageKm2]` : missingReasonFor(rd, 'coverageKm2', '覆盖范围'),
    })
  }
  // ⑥ 局部组网进度（`evaluation.inputs.meshProgress`，进度类字段，原样）
  {
    const v = rd.inputs['meshProgress']
    rows.push({
      key: 'mesh', name: '局部组网进度', has: v !== undefined,
      text: v === undefined ? '—' : `${n2s(Number(v.toFixed(1)))}%`, unit: '%', value: v,
      bar: v === undefined ? undefined : Math.max(0, Math.min(100, v)),
      note: v === undefined ? 'evaluation.inputs.meshProgress 未给' : 'evaluation.inputs.meshProgress（原样，进度类字段）',
    })
  }
  return rows
}

/** 6 行质量指标 + 逐条链路读数（折在 details 里，展开即见引擎原话）。 */
export function QualityPanel({ rd }: { rd: LinkReadings }) {
  const rows = qualityRows(rd)
  const links = objList(isObj(rd.raw) ? rd.raw : undefined, 'links')
  return (
    <div data-testid="sh07-quality-panel">
      {rows.map((r) => (
        <div key={r.key} data-testid="sh07-quality-row" data-field={r.key} data-has={r.has ? '1' : '0'} style={{ padding: '2px 0' }}>
          <Row
            k={r.name}
            v={r.has ? `${r.text}${r.unit && !r.text.includes(r.unit) ? ` ${r.unit}` : ''}` : '—'}
            color={r.has ? C.text : C.unknown}
          />
          {r.bar !== undefined && (
            <div style={{ height: 5, borderRadius: 3, background: 'rgba(95,176,255,.18)', overflow: 'hidden', margin: '1px 0 3px' }}>
              <div style={{ width: `${r.bar}%`, height: '100%', background: C.bar }} />
            </div>
          )}
          {/* 缺失/来源说明：屏上只留 2 行（完整原话在 tooltip 里）——免得把 6 行指标撑成一面墙 */}
          <div
            title={r.note}
            style={{
              fontSize: 10, color: r.has ? C.textDim : C.warn, lineHeight: '14px', maxHeight: 28, overflow: 'hidden',
            }}
          >{r.note}</div>
        </div>
      ))}
      <details style={{ marginTop: 4 }} data-testid="sh07-links-details">
        <summary style={{ fontSize: 11, color: C.textDim, cursor: 'pointer' }}>
          链路读数（topology.evaluate.links[]：{links.length} 条 · 已判状态 {rd.linksWithState ?? '—'} · 有评分 {rd.linksWithScore ?? '—'}）
        </summary>
        <div style={{ marginTop: 3 }}>
          {links.map((l, i) => {
            const id = str(l, 'linkId', 'id') ?? `l${i}`
            const st = str(l, 'state', 'status', 'quality')
            const sc = num(l, 'score')
            const ms: Metric[] = objList(l, 'metrics').map((m, j) => ({
              key: str(m, 'key', 'id') ?? `m${j}`,
              name: str(m, 'key', 'id') ?? `m${j}`,
              value: num(m, 'last', 'mean', 'value'),
              unit: str(m, 'unit'),
            }))
            return (
              <div key={id} data-testid="sh07-link-row" data-link-id={id} data-state={st ?? ''}
                style={{ display: 'flex', gap: 6, fontSize: 10.5, padding: '1px 0', borderBottom: '1px solid rgba(95,176,255,.08)' }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, marginTop: 3, flex: '0 0 auto', background: linkColor(st) }} />
                <span style={{ minWidth: 0, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {str(l, 'from', 'source') ?? '?'} → {str(l, 'to', 'target') ?? '?'}
                </span>
                <span style={{ flex: 1 }} />
                <span style={{ color: st ? linkColor(st) : C.unknown }}>{st ?? '—'}</span>
                <span style={{ color: C.textDim }}>{sc !== undefined ? `score ${sc}` : 'score —'}</span>
                <span style={{ color: C.textDim }}>
                  {ms.length ? ms.map((m) => `${m.name}=${m.value !== undefined ? n2s(m.value, m.unit ?? '') : '—'}`).join(' ') : 'metrics —'}
                </span>
              </div>
            )
          })}
          {links.length === 0 && (
            <div style={{ fontSize: 11, color: C.textDim, lineHeight: 1.6 }}>
              `topology.evaluate` 未给出 `links[]` → 无逐条读数（界面不补数）。
            </div>
          )}
        </div>
      </details>
    </div>
  )
}

// ============================================================================
// ⑥ 底部 4 张状态卡 + 仿真控制条 + 两个按钮（SH-07/SH-08 共用）
// ============================================================================

/** 一张底部状态卡：图标 + 名目 + 数值 + 状态词。 */
function StatusCard({ testid, name, value, word, wordColor, sub }: {
  testid: string
  name: string
  value: string
  word: string
  wordColor: string
  sub: string
}) {
  return (
    <div data-testid={testid} style={{ ...panel, flex: 1, minWidth: 0, boxSizing: 'border-box', padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ width: 10, height: 26, borderRadius: 3, background: wordColor, flex: '0 0 auto', opacity: 0.85 }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 11.5, color: C.textDim }}>{name}</div>
        <div style={{ fontSize: 16, color: C.text, fontVariantNumeric: 'tabular-nums' }}>
          {value} <span style={{ fontSize: 12, color: wordColor }}>{word}</span>
        </div>
        <div style={{ fontSize: 9.5, color: C.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</div>
      </div>
    </div>
  )
}

/** 底部 4 卡（照图：资源状态 / 集群数量 / 链路就绪 / AI状态）。数值全部取宿主。 */
export function LinkBottomCards({ state, flow, rd, testidPrefix }: {
  state: FlowState
  flow: UseFlow
  rd: LinkReadings
  testidPrefix: 'sh07' | 'sh08'
}) {
  // 资源台账：`alloc.inventory`（幂等读；数值是宿主的，界面不编）
  const inv = useVerbOnce(flow, 'alloc.inventory', {}, true)
  const invView = useMemo(() => readInventory(inv.data), [inv.data])
  const grouped = invView.totals.find((t) => t.key === 'grouped')
  const onlineRate = invView.totals.find((t) => t.key === 'onlineRate')
  // 卡片主值按图上的排版（「124 / 132」）显示**宿主的两个数**；宿主只给了拼好的串时才用它
  const invRaw = isObj(inv.data) ? inv.data : undefined
  const allocTotal = num(invRaw, 'allocatedTotal', 'allocated')
  const allTotal = num(invRaw, 'totalAll', 'total')
  const resourceValue = allocTotal !== undefined || allTotal !== undefined
    ? `${n2s(allocTotal)} / ${n2s(allTotal)}`
    : (grouped?.text ?? '—')

  const caps = state.capabilities ?? {}
  const capNum = (k: string) => (typeof caps[k] === 'number' ? (caps[k] as number) : undefined)
  const deviceOnlineRate = capNum('deviceOnlineRate')
  const nodesOnline = capNum('clusterNodesOnline')
  const nodesExpected = capNum('clusterNodesExpected')
  const scenarioGroups = capNum('scenarioGroups')

  // 集群数量：优先引擎拓扑的集群数（本屏画的就是它），回落 capabilities.scenarioGroups
  const engineClusters = rd.prim.clusters.length
  const clusterCount = engineClusters > 0 ? engineClusters : scenarioGroups

  // 链路就绪：`evaluation.inputs.linkUpRatio`（引擎算的连通比）
  const upRatio = rd.inputs['linkUpRatio']
  const upPct = upRatio === undefined ? undefined : Number((upRatio <= 1 ? upRatio * 100 : upRatio).toFixed(1))
  const coop = evalItemOf(rd, ['cooperation', 'coordination'])
  const readyWord = upRatio === undefined ? '—' : coop?.satisfied === false ? '未达标' : '达标'
  const readyColor = upRatio === undefined ? C.unknown : coop?.satisfied === false ? C.warn : C.ok

  // AI状态：`/api/state` 的 statusBar（key=ai）
  const ai = (state.statusBar ?? []).find((b) => b.key === 'ai')

  const onlineColor = deviceOnlineRate === undefined ? C.unknown : deviceOnlineRate >= 1 ? C.ok : C.warn
  return (
    <div data-testid={`${testidPrefix}-cards`} style={{ display: 'flex', gap: 8, height: '100%' }}>
      <StatusCard
        testid={`${testidPrefix}-card-resource`}
        name="资源状态"
        value={resourceValue !== '—' ? resourceValue : (nodesOnline !== undefined && nodesExpected !== undefined ? `${nodesOnline} / ${nodesExpected}` : '—')}
        word={deviceOnlineRate === undefined ? '—' : deviceOnlineRate >= 1 ? '在线' : `在线率 ${n2s(Number((deviceOnlineRate * 100).toFixed(1)))}%`}
        wordColor={onlineColor}
        sub={grouped
          ? `alloc.inventory：当前编组 ${grouped.text}${onlineRate ? ` · ${onlineRate.name} ${n2s(onlineRate.value, onlineRate.unit ?? '')}` : ''}`
          : `capabilities.clusterNodesOnline/Expected = ${nodesOnline ?? '—'}/${nodesExpected ?? '—'}`}
      />
      <StatusCard
        testid={`${testidPrefix}-cluster-status`}
        name="集群数量"
        value={clusterCount === undefined ? '—' : `${clusterCount} 个`}
        word={engineClusters > 0 ? '引擎拓扑' : scenarioGroups !== undefined ? '场景编组' : '—'}
        wordColor={engineClusters > 0 ? C.ok : C.unknown}
        sub={engineClusters > 0
          ? `topology.evaluate.primitives.clusters（${rd.prim.clusters.map((c) => c.name ?? c.id).slice(0, 3).join('、')}…）`
          : 'capabilities.scenarioGroups'}
      />
      <StatusCard
        testid={`${testidPrefix}-link-ready`}
        name="链路就绪"
        value={upPct === undefined ? '—' : `${n2s(upPct)}%`}
        word={readyWord}
        wordColor={readyColor}
        sub={`evaluation.inputs.linkUpRatio=${upRatio ?? '—'}${rd.linkCount !== undefined ? ` · 链路 ${rd.linkCount} 条` : ''}`}
      />
      <StatusCard
        testid={`${testidPrefix}-ai-status`}
        name="AI状态"
        value={ai?.text ?? '—'}
        word={ai?.status ?? '—'}
        wordColor={ai ? statusColor(ai.status) : C.unknown}
        sub={`/api/state statusBar[key=ai]${typeof caps['aiBridgeReachable'] === 'boolean' ? ` · aiBridgeReachable=${String(caps['aiBridgeReachable'])}` : ''}`}
      />
    </div>
  )
}

/**
 * 紧凑「仿真控制」条 —— **图上（T2-1/T2-2）没有这一条**。
 *
 * 保留原因（写在代码里，免得后来者当垃圾删掉）：演示与验收脚本要用旧 `ExecuteScreen` 的
 * 仿真控制能力与 testid（`btn-sim-start / btn-sim-pause / btn-sim-resume / btn-speed-1|8|60`），
 * 所以它作为一条紧凑控制条留在拓扑屏上；倍速只有契约冻结的 1 / 8 / 60 三档，
 * **界面上的当前倍速来自 `sim.state` 事件**（不是本地变量）。
 */
export function SimControlStrip({ flow, testidPrefix }: { flow: UseFlow; testidPrefix: 'sh07' | 'sh08' }) {
  const simSlot = flow.events['sim.state']
  const sim = useMemo(() => readSim(simSlot?.data, simSlot?.ts), [simSlot?.data, simSlot?.ts])
  const [busy, setBusy] = useState(false)
  const [replies, setReplies] = useState<Record<string, CommandReply>>({})
  const sendSim = useCallback(async (verb: string, params: Record<string, unknown>) => {
    setBusy(true)
    try {
      const r = await flow.send(verb, params)
      setReplies((prev) => ({ ...prev, [verb]: r }))
    } finally {
      setBusy(false)
    }
  }, [flow])
  const speed = sim.speed
  const speedText = speed === undefined ? '—' : `${n2s(speed)}×`
  const lastReply = replies['sim.speed'] ?? replies['sim.start'] ?? replies['sim.pause'] ?? replies['sim.resume'] ?? null
  return (
    <div data-testid={`${testidPrefix}-sim-strip`} style={{
      ...panel, boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', fontSize: 11.5,
    }}>
      <span style={{ color: C.warn, whiteSpace: 'nowrap' }} title="图上没有这一条：为演示与验收脚本保留旧 ExecuteScreen 的 sim.* 控制与 testid">
        仿真控制
      </span>
      <span style={{ color: C.textDim, whiteSpace: 'nowrap' }}>
        {sim.running === undefined ? '未收到 sim.state（—）' : sim.running ? '运行中' : '已暂停'}
      </span>
      <span data-testid={`${testidPrefix}-sim-speed`} style={{ color: C.text, whiteSpace: 'nowrap' }}>{speedText}</span>
      <span style={{ color: C.textDim, whiteSpace: 'nowrap' }}>{ms2clock(sim.simElapsedMs)}</span>
      <button data-testid="btn-sim-start" style={miniBtn} disabled={busy} onClick={() => void sendSim('sim.start', {})}>启动/继续链路</button>
      <button data-testid="btn-sim-pause" style={miniBtn} disabled={busy} onClick={() => void sendSim('sim.pause', {})}>暂停</button>
      <button data-testid="btn-sim-resume" style={miniBtn} disabled={busy} onClick={() => void sendSim('sim.resume', {})}>恢复</button>
      <span style={{ color: C.textDim }}>倍速</span>
      {SIM_SPEEDS.map((s) => {
        const on = speed === s
        return (
          <button
            key={s}
            data-testid={`btn-speed-${s}`}
            data-speed={s}
            data-on={on ? '1' : '0'}
            disabled={busy}
            onClick={() => void sendSim('sim.speed', { speed: s })}
            style={{
              ...miniBtn,
              borderColor: on ? C.borderStrong : C.border,
              background: on ? 'rgba(29,78,216,.5)' : 'rgba(10,20,36,.7)',
              color: on ? '#eaf4ff' : C.text,
            }}
          >{s}×</button>
        )
      })}
      <span style={{ flex: 1 }} />
      <span data-testid={`${testidPrefix}-sim-verdict`} style={{ color: lastReply ? (lastReply.code === 0 ? C.ok : C.bad) : C.textDim, whiteSpace: 'nowrap' }}>
        {lastReply ? `${lastReply.verb} → ${lastReply.code === 0 ? 'code=0' : replyText(lastReply)}` : `sim.state 事件：${simSlot ? '已收到' : '未收到（倍速与在跑状态由宿主事件给出）'}`}
      </span>
    </div>
  )
}

/**
 * 右下两枚按钮（照图）：【自动优化链路】（`topology.evaluate` 重算）+【进入侦察阶段】（推进阶段）。
 *
 * `optimizeGoTo`：SH-07 上点【自动优化链路】= 重算 + 进入 SH-08（专篇 §3 SH-07 的"本屏（→ SH-08）"）；
 * SH-08 上不传 = 只重算、留在本屏。
 * 【进入侦察阶段】：有 `goto` 的屏走 `goto(7)`（宿主改步号）；没有 `goto` 的屏（SH-07 的契约里没有它）
 * 走 `mission.advance{to:"T3"}→{to:"T4"}` 这条等价的宿主门禁链 —— **前端不自己改步号**。
 */
export function LinkActionButtons({ flow, rd, call, goto, onGo, optimizeGoTo, testidPrefix }: {
  flow: UseFlow
  rd: LinkReadings
  call: { busy: boolean; resend: () => void; reply: CommandReply | null }
  goto?: (step: number) => void
  onGo?: (id: string) => void
  optimizeGoTo?: string
  testidPrefix: 'sh07' | 'sh08'
}) {
  const [adv, setAdv] = useState<CommandReply | null>(null)
  const [advBusy, setAdvBusy] = useState(false)
  const [blockedAt, setBlockedAt] = useState<string | null>(null)

  const advance = async (chain: string[], force = false) => {
    setAdvBusy(true)
    setBlockedAt(null)
    try {
      let last: CommandReply | null = null
      for (const to of chain) {
        last = await flow.send('mission.advance', force ? { to, force: true } : { to })
        setAdv(last)
        if (last.code !== 0) { setBlockedAt(to); return }
      }
      onGo?.('SH-09')
    } finally {
      setAdvBusy(false)
    }
  }

  const enterRecon = () => {
    if (advBusy) return
    if (goto) {
      // 有 goto 的屏（SH-08）：按专篇口径 `goto(7)` —— 由宿主决定落在哪一步
      goto(7)
      setAdv({ code: 0, verb: 'flow.goto', data: { step: 7 } })
      onGo?.('SH-09')
      return
    }
    // SH-07 的导出契约里没有 goto（App.tsx 只传 onGo）→ 用等价的宿主命令：T3→T4 阶段链
    void advance(['T3', 'T4'])
  }

  const d = (adv?.data ?? {}) as Record<string, unknown>
  const unmet = strList(d, 'unmet')
  const skipped = strList(d, 'skippedGates')
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: '100%' }}>
      <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: C.textDim, lineHeight: 1.45 }}>
        {adv === null
          ? '【自动优化链路】重发 `topology.evaluate`；【进入侦察阶段】走宿主阶段推进（前端不改步号）'
          : adv.code === 0
            ? `${adv.verb} → code=0 · 步 ${String(d.step ?? '—')} · 阶段 ${String(d.phase ?? '—')}`
            : `${adv.verb} → ${replyText(adv)}${unmet.length ? ` · 未满足 ${unmet.join('/')}` : ''}${skipped.length ? ` · 跳过门禁 ${skipped.join('/')}` : ''}`}
      </span>
      {blockedAt !== null && (
        <button
          data-testid={`btn-advance-force-t4`}
          style={ghostBtn}
          disabled={advBusy}
          onClick={() => void advance([blockedAt], true)}
        >强制推进（force）</button>
      )}
      <button
        data-testid="btn-link-optimize"
        data-target-screen={optimizeGoTo ?? ''}
        style={ghostBtn}
        disabled={call.busy}
        title={`topology.evaluate（重算链路与质量指标）${optimizeGoTo ? ` → 进入 ${optimizeGoTo}` : ''}`}
        onClick={() => { call.resend(); if (optimizeGoTo) onGo?.(optimizeGoTo) }}
      >{call.busy ? '评估中…' : '自动优化链路'}</button>
      <button
        data-testid="btn-enter-recon"
        style={primaryBtn}
        disabled={advBusy}
        title={goto ? 'flow.goto{step:7} 并切到 SH-09' : 'mission.advance{to:"T3"}→{to:"T4"} 并切到 SH-09'}
        onClick={enterRecon}
      >{advBusy ? '推进中…' : '进入侦察阶段'}</button>
      <span data-testid={`${testidPrefix}-line-count`} style={{ fontSize: 11, color: C.textDim, whiteSpace: 'nowrap' }}>
        链路 {rd.linkCount ?? '—'} 条
      </span>
    </div>
  )
}

// ============================================================================
// ⑦ 屏体（SH-07）
// ============================================================================

export function LinkTopologyScreen({ state, flow, onGo }: {
  state: FlowState
  flow: UseFlow
  onGo?: (id: string) => void
}) {
  const { call, rd } = useLinkReadings(flow)

  return (
    <div data-testid="sh-07" data-screen="SH-07" style={rootStyle}>
      {/* 中区：拓扑 + 仿真控制条（额外保留）+ 两枚按钮 */}
      <div style={midColStyle}>
        <TopologyGraph readings={rd} testid="sh07-topology" />

        <SimControlStrip flow={flow} testidPrefix="sh07" />

        <div style={{ height: 38 }}>
          <LinkActionButtons
            flow={flow}
            rd={rd}
            call={call}
            onGo={onGo}
            optimizeGoTo="SH-08"
            testidPrefix="sh07"
          />
        </div>
      </div>

      {/* 右栏：「AI链路分析」（照图三组） */}
      <div style={rightColStyle}>
        <Section
          title="AI链路分析"
          testid="sh07-analysis-panel"
          right={<span style={{ fontFamily: 'ui-monospace, Consolas, monospace' }}>topology.evaluate</span>}
        >
          <GroupTitle>推荐链路组织方式</GroupTitle>
          <VerdictCard rd={rd} />

          <GroupTitle>网络评估</GroupTitle>
          <EvalRings rd={rd} />
          <div
            title={`4 项 = evaluation.items[]（引擎 key：${rd.evalItems.map((i) => i.key).join(' / ') || '—'}）；value 为引擎 0–1 尺度，环内数字 ×100 显示，原始值与判据见各环 tooltip${rd.overall !== undefined ? `；网络评估总分 overall=${rd.overall}` : ''}`}
            style={{ fontSize: 10, color: C.textDim, lineHeight: '14px', maxHeight: 28, overflow: 'hidden', marginTop: 5 }}
          >
            4 项 = `evaluation.items[]`（引擎 key：{rd.evalItems.map((i) => i.key).join(' / ') || '—'}）；
            value 为引擎 0–1 尺度，环内数字 ×100 显示，原始值与判据见各环 tooltip。
            {rd.overall !== undefined && ` 网络评估总分 overall=${rd.overall}。`}
          </div>

          <GroupTitle>链路质量指标</GroupTitle>
          <QualityPanel rd={rd} />
        </Section>

        <VerbVerdict
          rows={[
            {
              verb: 'topology.evaluate', reply: call.reply, busy: call.busy, onRetry: call.resend,
              okNote: `链路 ${rd.linkCount ?? '—'} 条 · 已判状态 ${rd.linksWithState ?? '—'} · 集群 ${rd.prim.clusters.length}`,
            },
          ]}
        />

        {/* 排障：读数来源与"没读数"的部分（如实列出，不补数） */}
        <Section title="读数来源与缺口（如实）" testid="sh07-gaps-panel">
          <Row k="引擎链路" v={rd.linkCount !== undefined ? `${rd.linkCount} 条` : '—'} sub="linkCount" />
          <Row k="塌缩到集群的链路" v={`${Object.values(rd.pairReads).reduce((a, b) => a + b.count, 0)} 条`} sub="按 topology.linkTo" />
          <Row k="画不出的链路" v={`${rd.unmappedLinks.length} 条`} color={rd.unmappedLinks.length ? C.warn : C.text} sub="端点塌缩不到 6 个集群" />
          <Row k="引擎集群（带坐标）" v={`${rd.prim.clusters.length} 个`} sub="primitives.clusters" />
          <Row k="缺坐标的集群" v={`${rd.prim.missingClusterCoordinates.length} 个`} color={rd.prim.missingClusterCoordinates.length ? C.warn : C.text} />
          <Row k="拓扑结构" v={rd.prim.structureKey ?? '—'} sub={rd.prim.topologyId ?? ''} />
          {rd.notes.slice(0, 3).map((t, i) => (
            <div
              key={i}
              title={t}
              style={{ fontSize: 10, color: C.textDim, lineHeight: '14px', maxHeight: 28, overflow: 'hidden', marginTop: 3 }}
            >· {t}</div>
          ))}
        </Section>
      </div>

      {/* 底部 4 张状态卡（照图） */}
      <div style={cardsRowStyle}>
        <LinkBottomCards state={state} flow={flow} rd={rd} testidPrefix="sh07" />
      </div>
    </div>
  )
}

// ---- 样式（一律 left/right/top/bottom 长写：**不写 inset 简写**，见 App.tsx 的踩坑注释）----
const rootStyle: CSSProperties = {
  position: 'absolute', left: 12, right: 12, top: 34, bottom: 36, zIndex: 20,
}
const midColStyle: CSSProperties = {
  position: 'absolute', left: 0, right: 342, top: 0, bottom: 82,
  display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0,
}
const rightColStyle: CSSProperties = {
  position: 'absolute', right: 0, top: 0, bottom: 82, width: 334,
  display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
}
const cardsRowStyle: CSSProperties = {
  position: 'absolute', left: 0, right: 0, bottom: 0, height: 74,
}
const miniBtn: CSSProperties = {
  padding: '3px 9px', fontSize: 11.5, cursor: 'pointer', borderRadius: 6, whiteSpace: 'nowrap',
  background: 'rgba(10,20,36,.7)', border: `1px solid ${C.border}`, color: C.text,
}
const ghostBtn: CSSProperties = {
  padding: '9px 18px', fontSize: 13, cursor: 'pointer', borderRadius: 8, whiteSpace: 'nowrap',
  background: 'rgba(10,20,36,.75)', border: `1px solid ${C.borderStrong}`, color: C.text,
}
const primaryBtn: CSSProperties = {
  padding: '9px 20px', fontSize: 13.5, cursor: 'pointer', borderRadius: 8, whiteSpace: 'nowrap',
  letterSpacing: 0.5, border: '1px solid rgba(34,197,94,.6)',
  background: 'linear-gradient(180deg,#16a34a,#15803d)', color: '#eafff2',
}

export default LinkTopologyScreen
