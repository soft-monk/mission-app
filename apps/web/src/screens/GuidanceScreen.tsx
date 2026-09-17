// mission-app · apps/web/src/screens/GuidanceScreen.tsx
//
// **SH-15 执行态势界面（`mode="exec"`，参考图 `场景1\T6-1.png`）**
// **SH-16 引导控制界面（`mode="control"`，参考图 `场景1\T6-2.png`）**
//
// 两屏是宿主**同一步（步 10 / 阶段 T6）**里的两屏，版式同族：
//   顶部压条（盖住 MapStage 的信息条）｜ 中区 3D 地图占满（本屏往图上叠图元）
//   ｜ 地图左下浮层：3 个状态标签 + 2 个按钮 ｜ 右栏 3 面板 ｜ 底部全局状态条（App 的壳）
//
// ★ 地图叠加（只画宿主给了坐标的东西）：
//   · `target`：锁定目标（红环 + 光晕 + 「目标xxx」标签；`selected=true` 加粗）——
//     坐标来自 `targets.list`，**前端不编坐标**；SH-16 标签第二行是「位置更新」。
//   · `route`：SH-16 的**修正后引导轨迹**（青色实线）＝ `guidance.plan` 的 IP 点 + 评估航线；
//     **原轨迹**＝上一份 `guidance.plan` 的同一条几何（虚线灰）——两份都是宿主回执，
//     本次会话只收到一份时**不画**原轨迹并如实写明。
//   · `link`：SH-15 的引导线（IP 点 → 目标，青色）；SH-16 的「信息同步」（目标 → 前沿指挥节点，
//     绿色虚线）——两端坐标分别来自 `guidance.plan` 与 `situation.snapshot.areas[]`。
//   · ⚠ map-2d 的线图元**没有箭头**（`route`/`link` 只画折线）→ 图上的"带箭头"画不出来，
//     如实登记在右栏与 `__p6Stats`（不伪造箭头图元）。
//
// ★ 数据纪律（沿用本仓既有口径）：
//   ① 屏上每个数都能在 verb 回执 / 事件里找到同源字段；**取不到显示"—"并写明原因**；
//   ② **偏差 / 命中概率**这两项图上给了数值（12m / 84%），但引擎本轮**没有这两个字段**：
//      `guidance.plan` 里没有偏差输入（只有 IP 点 + 评估航线 + 时刻），`exec.run` 回执里
//      也没有概率类字段 → 一律显示"—"并写明「无偏差输入 / 回执未给概率字段」，
//      **绝不写死 12m / 84%**（图上的数是示意值，见需求专篇 §9-11）；
//   ③ 状态变化的唯一来源是 `target.state` 事件；前端不预测命中、不补间。
//
// ★ 数据来源一览（每块面板都把来源写在标题栏）：
//   · 锁定目标 / 来源数 / 置信度 ← `targets.list`（+ `target.state` 事件的状态字段）
//   · 引导几何（IP 点 / 评估航线 / 时刻 / 判据） ← `guidance.plan{planId}`
//     （planId 取自 `state.strike.confirmedPlanId/adoptedPlanId` 或上一条 `guidance.plan` 回执）
//   · 协同链路 ← `topology.evaluate`（链路 state 域 + linkId；绿/黄/红→稳定/波动/受限 只用
//     需求专篇 §9.4 声明的词典）
//   · 处置回执 ← `exec.run{entityId}`（**逐条**留在界面上，含 basis 判据与全部标量叶子）
//
// 样式：`theme.ts` 令牌；不用 `backdrop-filter`；**不用 `inset` 简写**（与 `top` 混用会清掉 top）。
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { MapDraw, type PrimitiveKind } from 'map-2d'
import { C, panel, panelTitle, statusColor } from '../theme'
import type { CommandReply, FlowState } from '../api'
import type { UseFlow } from '../flow/useFlow'
import { isObj, n2s, num, obj, objList, pick, replyText, str, useVerbOnce } from '../flow/useSituation'
import { linkColor, readTargets, readTopology, type LinkRow, type TopologyView } from '../flow/useOps'
import {
  dynamicStateName, isStruckState, readExecReceipt, readTargetState,
  type ExecReceiptView,
} from '../flow/useExec'
import { readGuidance, type GuidanceView } from '../flow/useStrike'
import { useLabels, voiceLine } from '../shell/VoiceStrip'
import { StageStrip } from './StageOverlay'

/** 本屏往地图上画的图元 id 前缀（清理与计数只认它们；MapStage 的图元一个都不碰）。 */
const P_TARGET = 'G6T:'
const P_ROUTE = 'G6R:'
const P_LINK = 'G6L:'
const P_LABEL = 'G6B:'

/** 本屏的命令面：`exec.run{entityId}`（【确认引导】）与 `guidance.plan{planId}`（重取几何）。 */
const V_RUN = 'exec.run'
const V_GUIDE = 'guidance.plan'

// ============================================================================
// 小工具
// ============================================================================

/** 一行「名 + 值」：值缺失显示"—"，**不补 0**。 */
function Row({ k, v, color, testid, title }: { k: string; v: string; color?: string; testid?: string; title?: string }) {
  return (
    <div data-testid={testid} title={title} style={{ display: 'flex', gap: 8, padding: '2px 0', fontSize: 12 }}>
      <span style={{ color: C.textDim, width: 84, flex: '0 0 auto' }}>{k}</span>
      <span style={{ color: color ?? C.text, minWidth: 0, wordBreak: 'break-word' }}>{v}</span>
    </div>
  )
}

function Section({ title, children, testid, right }: {
  title: ReactNode
  children: ReactNode
  testid?: string
  right?: ReactNode
}) {
  return (
    <div data-testid={testid} style={{ ...panel, width: '100%', boxSizing: 'border-box' }}>
      <div style={panelTitle}>
        {title}
        {right !== undefined && <span style={{ float: 'right', fontSize: 11.5, color: C.textDim }}>{right}</span>}
      </div>
      <div style={{ padding: '7px 12px 9px' }}>{children}</div>
    </div>
  )
}

/** 条形进度（**只在有真实数值时画**；没有就画空条并写明原因）。 */
function Bar({ value, unit = '%', color = C.accent }: { value?: number; unit?: string; color?: string }) {
  const pct = value === undefined ? 0 : Math.max(0, Math.min(100, value))
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '3px 0' }}>
      <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'rgba(6,26,47,.9)', border: `1px solid ${C.border}`, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, opacity: value === undefined ? 0.25 : 1 }} />
      </div>
      <span data-testid="p6-bar-value" style={{ fontSize: 12, color: value === undefined ? C.textDim : C.text, fontVariantNumeric: 'tabular-nums', minWidth: 42, textAlign: 'right' }}>
        {value === undefined ? '—' : n2s(value, unit)}
      </span>
    </div>
  )
}

/** 环形读数（SH-16 的命中概率）；**没有真实数值就不画环**，只画一个空环 + "—"。 */
function Ring({ value, label, testid }: { value?: number; label: string; testid?: string }) {
  const pct = value === undefined ? 0 : Math.max(0, Math.min(100, value))
  const R = 30
  const CIRC = 2 * Math.PI * R
  return (
    <div data-testid={testid} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      <svg width={78} height={78} viewBox="0 0 78 78" style={{ flex: '0 0 auto' }}>
        <circle cx={39} cy={39} r={R} fill="none" stroke="rgba(95,176,255,.25)" strokeWidth={7} />
        {value !== undefined && (
          <circle
            cx={39} cy={39} r={R} fill="none" stroke={C.accent} strokeWidth={7} strokeLinecap="round"
            strokeDasharray={`${(CIRC * pct) / 100} ${CIRC}`} transform="rotate(-90 39 39)"
          />
        )}
        <text x={39} y={45} textAnchor="middle" fontSize={value === undefined ? 16 : 19} fill={value === undefined ? C.muted : C.text}>
          {value === undefined ? '—' : `${n2s(value)}%`}
        </text>
      </svg>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, color: C.textDim }}>{label}</div>
        {value === undefined && (
          <div data-testid="p6-ring-empty" style={{ fontSize: 10.5, color: C.warn, lineHeight: 1.5, marginTop: 2 }}>
            回执里没有概率类字段（不写死 84%）
          </div>
        )}
      </div>
    </div>
  )
}

/** 地图左下浮层的状态标签（图上逐字；点色由**是否有真实数据**决定，标题写明依据）。 */
function Chip({ text, on, why, testid }: { text: string; on: boolean; why: string; testid: string }) {
  return (
    <span
      data-testid={testid}
      data-on={on ? '1' : '0'}
      title={why}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 6,
        border: `1px solid ${on ? C.borderStrong : C.border}`, background: 'rgba(6,26,47,.78)',
        fontSize: 12, color: on ? C.text : C.textDim, whiteSpace: 'nowrap',
      }}
    >
      {text}
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: on ? C.ok : C.unknown, boxShadow: on ? `0 0 6px ${C.ok}` : 'none' }} />
    </span>
  )
}

/** 地图浮层按钮。`legacyTestid` 是给"旧脚本迁移"用的别名（`data-legacy-testid`）。 */
function MapBtn({ text, testid, legacyTestid, onClick, primary, disabled, title, busy }: {
  text: string
  testid: string
  legacyTestid?: string
  onClick: () => void
  primary?: boolean
  disabled?: boolean
  title?: string
  busy?: boolean
}) {
  const style: CSSProperties = disabled
    ? ghostDisabled
    : primary
      ? { ...primaryBtn, flex: '0 1 240px' }
      : { ...ghostBtn, flex: '0 1 200px' }
  return (
    <button data-testid={testid} data-legacy-testid={legacyTestid} style={style} disabled={disabled} title={title} onClick={onClick}>
      {busy ? '发送中…' : text}
    </button>
  )
}

// ============================================================================
// 视图数据
// ============================================================================

/** 「目标 + 引擎状态」的合成读数：台账（`targets.list`）+ 事件（`target.state`）。 */
interface TargetLive {
  row: ReturnType<typeof readTargets>['items'][number]
  entityId: string
  status?: string
  dynamicState?: string
  source: 'event' | 'list' | 'none'
  lng?: number
  lat?: number
  struck: boolean
  lastReason?: string
  lastAt?: number
}

/** 一条命令回执 + 它属于哪个目标（逐条留在界面上）。 */
interface ReceiptRow {
  verb: string
  entityId: string
  at: number
  reply: CommandReply | null
  busy: boolean
  view: ExecReceiptView | null
}

/**
 * 从**回执的摊平叶子**里找"概率 / 命中判据"类字段。
 * 找到就显示（并标出字段路径），找不到返回 undefined —— 界面显示"—"，**不写死 84%**。
 */
function probOf(view: ExecReceiptView | null): { value?: number; key?: string } {
  if (!view) return {}
  // 逐个候选叶子试：**只认能解析成有限数的那个**（`hitPlatformId` 这种文本叶子不算概率）
  for (const l of view.leaves) {
    if (!/prob|hit|pk|命中|概率|chance/i.test(l.path)) continue
    const n = Number(l.value)
    if (Number.isFinite(n)) return { value: n <= 1 ? Number((n * 100).toFixed(1)) : n, key: `${l.path}=${l.value}` }
    return { key: `${l.path}=${l.value}（不是数值 → 不当作概率）` }
  }
  if (view.confidence !== undefined) {
    return { value: view.confidence <= 1 ? Number((view.confidence * 100).toFixed(1)) : view.confidence, key: 'confidence' }
  }
  return {}
}

/**
 * 从 `guidance.plan` 回执的数值叶子里找"偏差"类字段（图上标的是 12m）。
 *
 * ⚠ 本工程的 `guidance.plan` **没有偏差输入**（回执只有 IP 点几何、评估航线、时刻与判据），
 *   所以这里通常返回 undefined → 界面显示"—（无偏差输入）"。
 */
function deviationOf(gv: GuidanceView | null): { value?: number; key?: string } {
  if (!gv) return {}
  const hit = gv.pairs.find((p) => /deviation|offset|miss|偏差|误差/i.test(p.path))
  if (hit) {
    const n = Number(hit.value)
    if (Number.isFinite(n)) return { value: n, key: `${hit.path}=${hit.value}` }
  }
  return {}
}

/** 链路 state 域 → 需求专篇 §9.4 声明的中文（绿=稳定 / 黄=波动 / 红=受限）。不认识就原样。 */
function linkStateCN(domain?: string): string {
  const s = (domain ?? '').toLowerCase()
  if (['stable', 'connected', 'ok', 'normal', 'online', 'good', 'strong', 'up', 'green'].includes(s)) return '稳定'
  if (['weak', 'fluctuating', 'degraded', 'unstable', 'warn', 'partial', 'intermittent', 'yellow', 'amber', 'orange'].includes(s)) return '波动'
  if (['limited', 'restricted', 'blocked', 'down', 'lost', 'fail', 'failed', 'offline', 'broken', 'red'].includes(s)) return '受限'
  return s ? domain as string : '—'
}

/** 按关键字在链路表里挑一条（`火力协同链路` / `雷达数据` / `电子侦察` 三行用）。 */
function linkByKeyword(tv: TopologyView, ...needles: string[]): LinkRow | undefined {
  return tv.links.find((l) => {
    const hay = `${l.key} ${l.name} ${l.from ?? ''} ${l.to ?? ''}`.toLowerCase()
    return needles.some((n) => hay.includes(n.toLowerCase()))
  })
}

export function GuidanceScreen({ state, flow, mode = 'exec', onNext, onGo }: {
  state: FlowState
  flow: UseFlow
  /** 图上 SH-15（执行态势）/ SH-16（引导控制）是同一步里的两屏 */
  mode?: 'exec' | 'control'
  /** 下一步（本屏不自己改 step，切步一律发 `flow.goto`） */
  onNext?: () => void
  /** 切到另一屏（只改本地屏路由）—— SH-15 ↔ SH-16 → SH-17 */
  onGo?: (id: string) => void
}) {
  const labels = useLabels()

  // ---- 台账（静态属性 + 基准状态）----
  const list = useVerbOnce(flow, 'targets.list', {}, true)
  const tv = useMemo(() => readTargets(list.data), [list.data])

  // ---- 事件：`target.state` / `entity.changed` 的**累积**状态（只认引擎给的事实）----
  const [evStates, setEvStates] = useState<Record<string, {
    status?: string; dynamicState?: string; from?: string; reason?: string; ts?: number
    threat?: string; confidence?: number; lng?: number; lat?: number
  }>>({})
  const [evCount, setEvCount] = useState(0)
  const [evLast, setEvLast] = useState<{ id?: string; to?: string; status?: string; at: number } | null>(null)
  const send = flow.send
  const bind = flow.bind
  const lastListRef = useRef(0)
  const listRef = useRef(list.resend)
  listRef.current = list.resend

  useEffect(() => {
    const off1 = bind('target.state', (d) => {
      const st = readTargetState(d)
      if (!st.targetId) return
      setEvStates((prev) => ({
        ...prev,
        [st.targetId as string]: {
          status: st.status, dynamicState: st.dynamicState,
          from: prev[st.targetId as string]?.status,
          reason: typeof d.reason === 'string' ? d.reason : undefined,
          ts: st.ts, threat: st.threat, confidence: st.confidence, lng: st.lng, lat: st.lat,
        },
      }))
      setEvCount((n) => n + 1)
      setEvLast({ id: st.targetId, to: st.dynamicState, status: st.status, at: Date.now() })
    })
    const off2 = bind('entity.changed', () => {
      const now = Date.now()
      if (now - lastListRef.current < 1500) return
      lastListRef.current = now
      listRef.current()
    })
    return () => { off1(); off2() }
  }, [bind])

  // ---- 链路（协同链路面板）：`topology.evaluate` ----
  const topo = useVerbOnce(flow, 'topology.evaluate', {}, true)
  const tv2 = useMemo(() => readTopology(topo.data), [topo.data])

  // ---- 引导几何（本屏地图叠加与时刻的**唯一**权威）：`guidance.plan{planId}` ----
  const stRaw = state as unknown as Record<string, unknown>
  const strikeRaw = obj(stRaw, 'strike')
  const stateGuidance = pick(strikeRaw, 'guidance')
  const confirmedPlanId = str(strikeRaw, 'confirmedPlanId') ?? str(strikeRaw, 'adoptedPlanId')
  const guideReply = flow.replies[V_GUIDE] ?? null
  const planId = str(guideReply?.data, 'planId') ?? confirmedPlanId ?? undefined
  const [guideLocal, setGuideLocal] = useState<CommandReply | null>(null)
  const [guideBusy, setGuideBusy] = useState(false)
  const guideData = (guideLocal?.code === 0 ? guideLocal.data : undefined)
    ?? (guideReply?.code === 0 ? guideReply.data : undefined)
    ?? (stateGuidance && isObj(stateGuidance) ? stateGuidance : undefined)
  const gv: GuidanceView | null = useMemo(() => (guideData ? readGuidance(guideData) : null), [guideData])
  /** 上一份引导几何（SH-16 的"原轨迹"）——两份都是宿主回执，第二份到达时把第一份留档。 */
  const prevGeoRef = useRef<[number, number][][]>([])
  const curGeo: [number, number][][] = useMemo(() => {
    if (!gv) return []
    const out: [number, number][][] = []
    for (const r of gv.routes) if (r.points.length >= 2) out.push(r.points)
    if (out.length === 0) {
      const pts: [number, number][] = []
      for (const p of gv.points) pts.push([p.lng, p.lat])
      if (gv.target) pts.push([gv.target.lng, gv.target.lat])
      if (pts.length >= 2) out.push(pts)
    }
    return out
  }, [gv])
  const curKey = JSON.stringify(curGeo)
  const lastKeyRef = useRef('')
  useEffect(() => {
    if (!curKey || curKey === '[]') return
    if (lastKeyRef.current && lastKeyRef.current !== curKey) {
      try { prevGeoRef.current = JSON.parse(lastKeyRef.current) as [number, number][][] } catch { prevGeoRef.current = [] }
    }
    lastKeyRef.current = curKey
  }, [curKey])
  const prevGeo = prevGeoRef.current

  /**
   * 重取引导几何（SH-15【调整观察角度】与 SH-16【重新规划】共用）。
   *
   * ⚠ 本工程的命令面里**没有"场景编辑 / 观察角度"verb**（`流程接口冻结.md` §2 的 11 步命令表
   *   只有 `guidance.plan`）→ 本屏能做的就是把 `guidance.plan{planId}` 重发一次（宿主幂等），
   *   并把这句话如实写在按钮的 `title` 与回执区里（**不假装改了观察角度**）。
   */
  const reguide = async () => {
    if (!planId) return
    setGuideBusy(true)
    try {
      const r = await send(V_GUIDE, { planId })
      setGuideLocal(r)
    } catch (e) {
      setGuideLocal({ code: -1, verb: V_GUIDE, error: { message: String((e as Error)?.message ?? e) } })
    } finally { setGuideBusy(false) }
  }

  // ---- 合成：台账 × 事件状态 ----
  const live: TargetLive[] = useMemo(() => tv.items.map((row) => {
    const ev = evStates[row.entityId]
    const status = ev?.status ?? row.status
    const dynamicState = ev?.dynamicState ?? row.motion
    return {
      row,
      entityId: row.entityId,
      status,
      dynamicState,
      source: ev ? 'event' : (row.status || row.motion ? 'list' : 'none'),
      lng: ev?.lng ?? row.lng,
      lat: ev?.lat ?? row.lat,
      struck: isStruckState(status, dynamicState),
      lastReason: ev?.reason,
      lastAt: ev?.ts,
    }
  }), [tv.items, evStates])

  const struckCount = live.filter((t) => t.struck).length

  // ---- 选中（锁定）目标：优先取"还没失效 + 有坐标 + 优先级最小"的那个；用户可点小卡切换 ----
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const primaryId = useMemo(() => {
    const cand = live.filter((t) => !t.struck && t.lng !== undefined && t.lat !== undefined)
    const pool = cand.length ? cand : live
    const sorted = [...pool].sort((a, b) => (a.row.priority ?? 99) - (b.row.priority ?? 99))
    return sorted[0]?.entityId ?? null
  }, [live])
  const selected = live.find((t) => t.entityId === (selectedId ?? primaryId)) ?? null
  useEffect(() => {
    if (selectedId && live.length && !live.some((t) => t.entityId === selectedId)) setSelectedId(null)
  }, [live, selectedId])

  // ---- 命令回执（逐条留下）----
  const [rows, setRows] = useState<ReceiptRow[]>([])
  const [busyVerb, setBusyVerb] = useState<string | null>(null)
  const fire = async (verb: string, entityId: string) => {
    const key = `${verb}#${entityId}#${Date.now()}`
    setRows((prev) => [{ verb, entityId, at: Date.now(), reply: null, busy: true, view: null }, ...prev].slice(0, 6))
    setBusyVerb(key)
    try {
      const r = await send(verb, { entityId })
      setRows((prev) => prev.map((x, i) => (i === 0 && x.busy ? { ...x, reply: r, busy: false, view: readExecReceipt(r.data) } : x)))
      if (r.code === 0) listRef.current()
      return r
    } catch (e) {
      const r: CommandReply = { code: -1, verb, error: { message: String((e as Error)?.message ?? e) } }
      setRows((prev) => prev.map((x, i) => (i === 0 && x.busy ? { ...x, reply: r, busy: false, view: null } : x)))
      return r
    } finally { setBusyVerb(null) }
  }
  const lastRun = rows.find((r) => r.verb === V_RUN) ?? null
  const runView = lastRun?.view ?? null
  const prob = probOf(runView)
  const dev = deviationOf(gv)

  // ---- 前沿指挥节点坐标（SH-16 的「信息同步」虚线用）----
  const snap = useVerbOnce(flow, 'situation.snapshot', {}, true)
  const fwdNode = useMemo<{ name: string; lng: number; lat: number } | null>(() => {
    for (const a of objList(snap.data, 'areas')) {
      if (str(a, 'role') !== 'forward-node') continue
      const pos = pick(a, 'position', 'pos', 'coord')
      const lng = Array.isArray(pos) ? Number(pos[0]) : num(a, 'lng')
      const lat = Array.isArray(pos) ? Number(pos[1]) : num(a, 'lat')
      if (typeof lng === 'number' && typeof lat === 'number' && Number.isFinite(lng) && Number.isFinite(lat)) {
        return { name: str(a, 'name') ?? '前沿指挥节点', lng, lat }
      }
    }
    return null
  }, [snap.data])

  // ---- 目标跟踪稳定度：只在宿主真给了这类字段时才显示（本工程实测没有 → "—"）----
  const trackStability = useMemo(() => {
    for (const cand of [flow.events['target.state']?.data, selected?.row.raw, stateGuidance]) {
      const v = num(cand, 'trackStability', 'trackingStability', 'stability', '跟踪稳定度')
      if (v !== undefined) return v <= 1 ? Number((v * 100).toFixed(0)) : v
    }
    return undefined
  }, [flow.events, selected?.row.raw, stateGuidance])

  // ---------------- 地图叠加：锁定目标 + 引导轨迹 + 连线（坐标全部来自宿主） ----------------
  const drawnRef = useRef<{ kind: PrimitiveKind; id: string }[]>([])
  const drawnKey = JSON.stringify({
    id: selected?.entityId ?? null, lng: selected?.lng ?? null, lat: selected?.lat ?? null,
    status: selected?.status ?? null, struck: selected?.struck ?? null,
    mode, cur: curGeo, prev: mode === 'control' ? prevGeo : [],
    fwd: mode === 'control' ? fwdNode : null,
    ip: gv?.points[0] ? [gv.points[0].lng, gv.points[0].lat] : null,
  })
  useEffect(() => {
    const prev = drawnRef.current
    const next: { kind: PrimitiveKind; id: string }[] = []
    MapDraw.batch(() => {
      for (const d of prev) MapDraw.remove(d.kind, d.id)
      // ① 锁定目标（红环 + 光晕 + 标签；坐标来自 targets.list / target.state）
      if (selected?.lng !== undefined && selected?.lat !== undefined) {
        const id = `${P_TARGET}${selected.entityId}`
        MapDraw.add('target', {
          id, lng: selected.lng, lat: selected.lat,
          color: C.bad,
          status: selected.struck ? 'gray' : 'red',
          label: targetLabel(selected),
          selected: true,
        })
        next.push({ kind: 'target', id })
        // 「位置更新」第二行标签（SH-16 图上逐字；用 label 图元另起一行）
        if (mode === 'control') {
          const lid = `${P_LABEL}${selected.entityId}`
          MapDraw.add('label', { id: lid, lng: selected.lng, lat: selected.lat, text: '位置更新', color: C.bad, size: 11, radius: 0 })
          next.push({ kind: 'label', id: lid })
        }
      }
      // ② SH-15：一条浅蓝实线由 IP 点直指目标（引导线）
      if (mode === 'exec' && gv?.points[0] && selected?.lng !== undefined && selected?.lat !== undefined) {
        const p = gv.points[0]
        const id = `${P_LINK}guide`
        MapDraw.add('link', { id, from: [p.lng, p.lat], to: [selected.lng, selected.lat], color: '#38bdf8', label: '引导线' })
        next.push({ kind: 'link', id })
      }
      // ③ SH-16：修正后引导轨迹（青色实线）＋ 原轨迹（上一份回执，虚线灰）＋ 信息同步（绿色虚线）
      if (mode === 'control') {
        curGeo.forEach((pts, i) => {
          const id = `${P_ROUTE}new-${i}`
          MapDraw.add('route', { id, points: pts, color: '#22d3ee', dashed: false, name: '修正后引导轨迹' })
          next.push({ kind: 'route', id })
        })
        prevGeo.forEach((pts, i) => {
          const id = `${P_ROUTE}old-${i}`
          MapDraw.add('route', { id, points: pts, color: '#8b93a7', dashed: true, name: '原轨迹' })
          next.push({ kind: 'route', id })
        })
        if (fwdNode && selected?.lng !== undefined && selected?.lat !== undefined) {
          const id = `${P_LINK}sync`
          MapDraw.add('link', { id, from: [selected.lng, selected.lat], to: [fwdNode.lng, fwdNode.lat], color: C.ok, label: '信息同步' })
          next.push({ kind: 'link', id })
        }
      }
    })
    drawnRef.current = next
    return () => {
      const mine = drawnRef.current
      MapDraw.batch(() => { for (const d of mine) MapDraw.remove(d.kind, d.id) })
      drawnRef.current = []
    }
    // drawnKey 把"要画什么"压成一个串，避免每个事件都重画
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawnKey])

  // ---------------- 只读排障句柄（验收脚本读它；不改渲染、不改 MapStage） ----------------
  const readHandle = useMemo(() => ({
    mapCounts: () => mapCounts(),
    readExecReceipt: (data: unknown) => readExecReceipt(data),
    readTargetState: (data: unknown) => readTargetState(data),
    probOf: (data: unknown) => probOf(readExecReceipt(data)),
    deviationOf: (data: unknown) => deviationOf(data ? readGuidance(data) : null),
    linkStateCN,
  }), [])
  useEffect(() => { installP6Read(readHandle) }, [readHandle])

  // ---------------- 渲染 ----------------
  const voice15 = voiceLine(labels, 'sh15', 'system')
  const voice16 = voiceLine(labels, 'sh16', 'system')
  const isExec = mode === 'exec'
  const phaseText = state.phase || '—'
  const eventsRecent = evLast && Date.now() - evLast.at < 15000
  /** 图上「协同链路」三行 → 本工程拓扑里的链路（按关键字匹配；匹配不到就 "—"）。 */
  const linkRows: [string, LinkRow | undefined][] = [
    ['火力协同链路', linkByKeyword(tv2, '火力', 'fire', 'strike')],
    ['雷达数据', linkByKeyword(tv2, '雷达', 'radar')],
    ['电子侦察', linkByKeyword(tv2, '电子', 'ew', 'jam')],
  ]

  return (
    <>
      {/* ---------------- 顶部压条（显示模式/阶段/锁定目标/事件） ---------------- */}
      <StageStrip
        items={[
          { k: '显示模式', v: isExec ? '实时态势' : '引导控制' },
          { k: '阶段', v: phaseText },
          { k: '锁定目标', v: selected ? targetLabel(selected) : '—', color: selected ? C.bad : C.textDim },
          { k: '目标事件', v: `${evCount} 条`, color: evCount > 0 ? C.accent : C.textDim },
          { k: '引导几何', v: gv ? `${gv.points.length} 点 / ${gv.routes.length} 航线` : '—', color: gv ? C.text : C.textDim },
        ]}
        right={<span style={{ color: C.textDim }}>
          {list.reply === null
            ? '目标台账读取中…'
            : list.reply.code === 0
              ? `targets.list 已就绪（${live.length} 个目标）`
              : `targets.list：${replyText(list.reply)}`}
        </span>}
      />

      {/* ---------------- 右栏 3 面板（图上逐字：AI提示/跟踪状态/协同链路 · AI轨迹修正/命中概率/同步状态） ---------------- */}
      <div style={rightColStyle}>
        {isExec ? (
          <>
            <Section title="AI提示" testid="sh15-ai-panel" right="voice.sh15.system">
              <div data-testid="sh15-ai-text" style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 10px', fontSize: 12, color: C.text, lineHeight: 1.7, background: 'rgba(6,26,47,.6)' }}>
                {voice15 || '（未配置语音文案：`config.json` 的 flow.labels 里缺 voice.sh15.system）'}
              </div>
            </Section>

            <Section title="跟踪状态" testid="sh15-track-panel" right="targets.list / target.state">
              <Row k="锁定目标" v={selected ? targetLabel(selected) : '—'} color={selected ? C.bad : C.textDim} testid="sh15-locked-target" />
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '2px 0', fontSize: 12 }}>
                <span style={{ color: C.textDim, width: 84, flex: '0 0 auto' }}>目标跟踪稳定度</span>
                <span style={{ flex: 1, minWidth: 0 }}><Bar value={trackStability} /></span>
              </div>
              {trackStability === undefined && (
                <div data-testid="sh15-stability-missing" style={{ fontSize: 10.5, color: C.warn, lineHeight: 1.55 }}>
                  宿主未给"目标跟踪稳定度"（`targets.list` / `target.state` 都没有该字段）→ 显示"—"（不写死 87%）
                </div>
              )}
              <Row
                k="位置校正"
                v={evCount > 0 ? `进行中（target.state ${evCount} 条${eventsRecent ? ' · 最近 15s 内有更新' : ' · 最近一次较早'}）` : '—'}
                color={evCount > 0 ? C.accent : C.textDim}
                testid="sh15-position-fix"
              />
              {evCount === 0 && (
                <div style={{ fontSize: 10.5, color: C.textDim, lineHeight: 1.55 }}>未收到 `target.state` 事件 → 「位置校正」不写"进行中"</div>
              )}
              {selected?.status && <Row k="台账状态" v={selected.status} color={statusColor(selected.status)} />}
              {selected && (
                <Row k="动态状态" v={dynamicStateName(selected.dynamicState).text} color={selected.struck ? C.muted : C.text} />
              )}
            </Section>

            <Section title="协同链路" testid="sh15-link-panel" right={`topology.evaluate（${tv2.links.length} 条）`}>
              {linkRows
                .map(([name, l]) => (
                  <div key={name} data-testid="sh15-link-row" data-link-id={l?.key ?? ''} style={{ display: 'flex', gap: 8, padding: '2px 0', fontSize: 12 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: l ? linkColor(l.status) : C.unknown, marginTop: 4, flex: '0 0 auto' }} />
                    <span style={{ flex: 1, minWidth: 0, color: C.text }}>{name}</span>
                    <span style={{ color: l ? linkColor(l.status) : C.textDim }} title={l ? `${l.key} state=${l.status ?? '—'}` : '拓扑里没有匹配该关键字的链路'}>
                      {l ? `${linkStateCN(l.status)}（${l.status ?? '—'}）` : '—'}
                    </span>
                  </div>
                ))}
              {tv2.links.length === 0 && (
                <div data-testid="sh15-link-empty" style={{ fontSize: 11, color: C.textDim, lineHeight: 1.6 }}>
                  链路未就绪：{topo.reply ? replyText(topo.reply) : 'topology.evaluate 未发送'}
                </div>
              )}
              {tv2.links.length > 0 && (
                <div style={{ fontSize: 10, color: C.textDim, marginTop: 3, lineHeight: 1.5 }}>
                  按链路 `linkId/name` 关键字匹配（火力协同链路在本轮拓扑里没有同名项 → "—"）；
                  绿/黄/红 → 稳定/波动/受限 用需求专篇 §9.4 声明的词典。链路总数 {tv2.linkCount ?? tv2.links.length}。
                </div>
              )}
            </Section>
          </>
        ) : (
          <>
            <Section title="AI轨迹修正" testid="sh16-ai-panel" right="voice.sh16.system">
              <div data-testid="sh16-ai-text" style={{ fontSize: 12, color: C.text, lineHeight: 1.7 }}>
                {voice16 || '（未配置语音文案：`config.json` 的 flow.labels 里缺 voice.sh16.system）'}
              </div>
              {/* 小示意图（图上的"小示意图位"）：纯示意图形，不含任何坐标或数值 */}
              <svg width="100%" height="58" viewBox="0 0 240 58" style={{ marginTop: 6, border: `1px solid ${C.border}`, borderRadius: 6, background: 'rgba(6,26,47,.6)' }}>
                <path d="M8 46 C 70 40, 130 16, 208 22" fill="none" stroke="#22d3ee" strokeWidth="2" />
                <path d="M8 52 L 190 40" fill="none" stroke="#8b93a7" strokeWidth="1.4" strokeDasharray="4 3" />
                <circle cx="212" cy="22" r="9" fill="none" stroke="#ef4444" strokeWidth="2" />
                <circle cx="212" cy="22" r="3" fill="#ef4444" />
                <text x="8" y="14" fontSize="9" fill="#8fb0cc">示意：修正后轨迹（青实线） / 原轨迹（灰虚线）</text>
              </svg>
            </Section>

            <Section title="命中概率" testid="sh16-hit-panel" right="exec.run 回执">
              <Ring value={prob.value} label={prob.key ? `来源字段 ${prob.key}` : '回执未给概率类字段'} testid="sh16-hit-ring" />
              {prob.value === undefined && (
                <div data-testid="sh16-hit-missing" style={{ fontSize: 10.5, color: C.warn, lineHeight: 1.55, marginTop: 2 }}>
                  `exec.run` 回执里没有命中概率/判据数值 → 显示"—"（图上的 84% 是示意值，不写死）
                </div>
              )}
              {runView && (
                <div style={{ fontSize: 10.5, color: C.textDim, lineHeight: 1.6, marginTop: 4 }}>
                  <div>回执：stateAfter={runView.dynamicState ?? '—'} · status={runView.status ?? '—'}{runView.idempotent ? ' · 幂等' : ''}</div>
                  {runView.basis && <div data-testid="sh16-hit-basis">判据（{runView.basisKey ?? 'basis'}）：{runView.basis}</div>}
                  {!runView.basis && <div style={{ color: C.warn }}>宿主未给出判据（basis）</div>}
                </div>
              )}
              <div style={{ fontSize: 10, color: C.textDim, marginTop: 4, lineHeight: 1.5 }}>
                趋势（"持续上升"）：{str(runView?.raw, 'trend', 'trendText') ?? '—（回执未给趋势字段）'}
              </div>
            </Section>

            <Section title="同步状态" testid="sh16-sync-panel" right="target.state / guidance.plan">
              <Row
                k="目标位置"
                v={evCount > 0 ? `实时更新（target.state ${evCount} 条）` : '—（未收到 target.state）'}
                color={evCount > 0 ? C.ok : C.textDim}
                testid="sh16-sync-pos"
              />
              <Row
                k="火力引导信息"
                v={gv ? `已同步（guidance.plan：IP 点 ${gv.points.length} · 航线 ${gv.routes.length}${planId ? ` · planId=${planId}` : ''}）` : `—（${guideLocal ? replyText(guideLocal) : 'guidance.plan 未就绪'}）`}
                color={gv ? C.ok : C.textDim}
                testid="sh16-sync-guide"
              />
              <Row
                k="偏差修正"
                v={dev.value !== undefined ? `已生成（${dev.key}=${dev.value} m）` : '—（无偏差输入）'}
                color={dev.value !== undefined ? C.ok : C.textDim}
                testid="sh16-sync-deviation"
              />
              <div style={{ fontSize: 10.5, color: C.warn, lineHeight: 1.55, marginTop: 2 }}>
                偏差：{dev.value !== undefined ? `guidance.plan 给了 ${dev.key}` : '`guidance.plan` 回执里没有任何偏差/偏移字段（只有 IP 点几何、评估航线与时刻）→ 显示"—"，图上的「偏差 12m」不写死'}
              </div>
            </Section>
          </>
        )}

        {/* 锁定目标台账（p6-target-card 契约保留；点小卡切换锁定对象） */}
        <Section title="锁定目标（台账）" testid="sh15-target-panel" right={`${live.length} 个 · 已失效 ${struckCount}`}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {live.map((t) => {
              const picked = t.entityId === selected?.entityId
              return (
                <button
                  key={t.entityId}
                  data-testid="p6-target-card"
                  data-entity-id={t.entityId}
                  data-status={t.status ?? ''}
                  data-dynamic-state={t.dynamicState ?? ''}
                  data-struck={t.struck ? '1' : '0'}
                  data-state-source={t.source}
                  onClick={() => setSelectedId(t.entityId)}
                  title={`${t.entityId} · 状态源 ${t.source}`}
                  style={{
                    textAlign: 'left', cursor: 'pointer', padding: '4px 8px', borderRadius: 6,
                    border: `1px solid ${picked ? C.borderStrong : C.border}`,
                    background: picked ? 'rgba(29,78,216,.35)' : 'rgba(10,32,58,.6)',
                    color: t.struck ? C.muted : C.text, fontSize: 11.5,
                  }}
                >
                  {targetLabel(t)}
                  <span style={{ marginLeft: 6, color: t.struck ? C.muted : statusColor(t.status) }}>{t.status ?? '—'}</span>
                </button>
              )
            })}
            {live.length === 0 && (
              <div data-testid="sh15-target-empty" style={{ fontSize: 11.5, color: C.textDim, lineHeight: 1.7 }}>
                目标台账为空{list.reply ? `：targets.list → ${replyText(list.reply)}` : '（正在读取…）'}
              </div>
            )}
          </div>
        </Section>

        {/* 处置回执（有才出现；逐条显示宿主的原话与判据） */}
        {rows.length > 0 && (
          <Section title="引导命令回执（逐条）" testid="p6-receipt-panel" right={`${rows.length} 条`}>
            {rows.map((r) => (
              <div
                key={`${r.verb}-${r.entityId}-${r.at}`}
                data-testid="p6-receipt-row"
                data-verb={r.verb}
                data-entity-id={r.entityId}
                data-code={r.reply ? String(r.reply.code) : ''}
                data-basis={r.view?.basis ?? ''}
                data-to-state={r.view?.dynamicState ?? ''}
                style={{ padding: '4px 0', borderBottom: '1px solid rgba(95,176,255,.12)' }}
              >
                <div style={{ fontSize: 11.5, color: r.busy ? C.textDim : (r.reply?.code === 0 ? C.ok : C.bad) }}>
                  {r.verb} · {r.entityId} → {r.busy ? '发送中…' : (r.reply ? `code=${r.reply.code}` : '—')}
                  {!r.busy && r.reply && r.reply.code !== 0 ? `：${replyText(r.reply)}` : ''}
                </div>
                <div data-testid="p6-receipt-basis" style={{ fontSize: 10.5, color: r.view?.basis ? C.textDim : C.warn, lineHeight: 1.5, wordBreak: 'break-word' }}>
                  {r.view?.basis ? `${r.view.basisKey ?? 'basis'}：${r.view.basis}` : (r.reply?.code === 0 ? '宿主未给出判据（basis）' : '无判据（命令未成功）')}
                </div>
                {r.view && r.view.leaves.length > 0 && (
                  <div data-testid="p6-receipt-leaves" style={{ display: 'flex', flexWrap: 'wrap', gap: '1px 9px', marginTop: 2 }}>
                    {r.view.leaves.slice(0, 18).map((p) => (
                      <span key={p.path} style={{ fontSize: 9.5, color: C.textDim }}>{p.path}=<span style={{ color: C.text }}>{p.value}</span></span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </Section>
        )}
      </div>

      {/* ---------------- 地图左下浮层：3 状态标签 ---------------- */}
      <div style={chipRowStyle}>
        {isExec ? (
          <>
            <Chip
              testid="sh15-chip-multisource"
              text="多源数据叠加"
              on={!!selected && ((selected.row.sourceCount ?? 0) > 0 || !!selected.row.source)}
              why={`来源＝targets.list.sources[]：${selected?.row.source || '—'}（sourceCount=${selected?.row.sourceCount ?? '—'}）`}
            />
            <Chip
              testid="sh15-chip-lock"
              text="实时锁定"
              on={!!selected && selected.lng !== undefined}
              why={`锁定目标 ${selected ? targetLabel(selected) : '—'}；坐标来自 targets.list/target.state（${selected?.lng ?? '—'}, ${selected?.lat ?? '—'}）`}
            />
            <Chip
              testid="sh15-chip-trackfix"
              text="轨迹修正"
              on={!!gv && (gv.routes.length > 0 || gv.points.length > 0)}
              why={`guidance.plan 几何：IP 点 ${gv?.points.length ?? 0} · 航线 ${gv?.routes.length ?? 0}`}
            />
          </>
        ) : (
          <>
            <Chip
              testid="sh16-chip-fixed"
              text="轨迹已修正"
              on={!!gv && (gv.routes.length > 0 || gv.points.length > 0)}
              why={`修正后轨迹＝guidance.plan 的 IP 点 + 评估航线（${gv?.routes.length ?? 0} 条）`}
            />
            <Chip
              testid="sh16-chip-target"
              text="目标锁定"
              on={!!selected && selected.lng !== undefined}
              why={`锁定目标 ${selected ? targetLabel(selected) : '—'}`}
            />
            <Chip
              testid="sh16-chip-sync"
              text="信息同步"
              on={!!(fwdNode && selected?.lng !== undefined)}
              why={fwdNode ? `目标 → ${fwdNode.name}（两端坐标分别来自 targets.list 与 situation.snapshot.areas[]）` : '前端指挥节点坐标未读到（situation.snapshot 没给 forward-node 的 position）'}
            />
          </>
        )}
      </div>

      {/* ---------------- 地图下方两按钮（图上逐字） ---------------- */}
      <div style={actionBarStyle}>
        {isExec ? (
          <>
            <MapBtn
              testid="sh15-btn-observe"
              legacyTestid="p6-btn-run"
              text="调整观察角度"
              primary
              busy={guideBusy}
              disabled={!planId}
              title={planId
                ? `重取 ${V_GUIDE}{planId:"${planId}"}。⚠ 本工程命令面里没有"观察角度/场景编辑"verb（流程接口冻结 §2）→ 本屏只重取几何，不假装改了观察角度`
                : '缺 planId（state.strike.confirmedPlanId / guidance.plan 回执都没给）→ 发不出 guidance.plan'}
              onClick={() => void reguide()}
            />
            <MapBtn
              testid="sh15-btn-track"
              legacyTestid="p6-btn-next"
              text="保持跟踪"
              title="进入引导控制（SH-16，本屏内切换）"
              onClick={() => (onGo ? onGo('SH-16') : onNext?.())}
            />
          </>
        ) : (
          <>
            <MapBtn
              testid="p6-btn-run"
              text="确认引导"
              primary
              busy={busyVerb?.startsWith(V_RUN) ?? false}
              disabled={(busyVerb?.startsWith(V_RUN) ?? false) || !selected}
              title={selected ? `${V_RUN} {entityId:"${selected.entityId}"}；成功后进入 SH-17 毁伤评估` : '没有锁定目标（targets.list 为空）'}
              onClick={() => {
                if (!selected) return
                void fire(V_RUN, selected.entityId).then((r) => { if (r.code === 0) onGo?.('SH-17') })
              }}
            />
            <MapBtn
              testid="sh16-btn-replan"
              text="重新规划"
              busy={guideBusy}
              disabled={!planId}
              title={planId ? `重下引导：${V_GUIDE}{planId:"${planId}"}（宿主幂等，重算几何与时刻）` : '缺 planId → 发不出 guidance.plan'}
              onClick={() => void reguide()}
            />
          </>
        )}
        {!gv && (
          <span data-testid="sh15-guide-note" style={{ fontSize: 10.5, color: C.warn, maxWidth: 360, lineHeight: 1.5 }}>
            guidance.plan 未就绪：{guideLocal ? replyText(guideLocal) : (planId ? '正在读取…' : '没有 planId（先在第 9 步 strike.confirm）')}
          </span>
        )}
      </div>

      <P6Probe
        step={state.step}
        phase={state.phase}
        mode={mode}
        listReply={list.reply}
        live={live}
        selectedId={selected?.entityId ?? null}
        evCount={evCount}
        evLast={evLast}
        rows={rows}
        lastRun={lastRun}
        prob={prob}
        dev={dev}
        guidance={{
          planId: planId ?? null,
          points: gv?.points.length ?? 0,
          routes: gv?.routes.length ?? 0,
          timeline: gv?.timeline.length ?? 0,
          from: guideData === stateGuidance && !guideReply ? 'state.strike.guidance' : 'guidance.plan',
        }}
        links={tv2.links.length}
        fwdNode={fwdNode}
        prevRoutes={prevGeo.length}
        onMap={mapCounts()}
      />
    </>
  )
}

/** 「目标xxx」标签（编号取台账真实值；没有编号就退回实体 id）。 */
function targetLabel(t: { row: { no?: number; name?: string; typeName?: string }; entityId: string }): string {
  if (t.row.no !== undefined) return `目标${String(t.row.no).padStart(3, '0')}`
  return t.row.name || t.row.typeName || t.entityId
}

/** 本屏在地图上画了什么（**只读**：`MapDraw.list` 快照，不改渲染）。 */
function mapCounts(): Record<string, unknown> {
  const targets = MapDraw.list('target') as unknown as { id: string; color?: string; status?: string; lng: number; lat: number; label?: string }[]
  const routes = MapDraw.list('route') as unknown as { id: string; points: [number, number][]; color?: string; dashed?: boolean }[]
  const links = MapDraw.list('link') as unknown as { id: string; color?: string; from: [number, number]; to: [number, number] }[]
  const labels = MapDraw.list('label') as unknown as { id: string; text: string }[]
  const mine = (arr: { id: string }[], p: string) => arr.filter((x) => x.id.startsWith(p)).length
  return {
    target: mine(targets, P_TARGET), route: mine(routes, P_ROUTE),
    link: mine(links, P_LINK), label: mine(labels, P_LABEL),
    routes: routes.filter((r) => r.id.startsWith(P_ROUTE)).map((r) => ({ id: r.id, n: r.points.length, dashed: !!r.dashed })),
    targetsOnMap: targets.filter((t) => t.id.startsWith(P_TARGET)).map((t) => ({ id: t.id, color: t.color ?? null, status: t.status ?? null, label: t.label ?? null })),
    /** ⚠ map-2d 的线图元没有箭头 → 屏上"带箭头"画不出来（如实登记，不伪造） */
    arrowSupported: false,
  }
}

export interface P6Read {
  mapCounts: () => Record<string, unknown>
  readExecReceipt: (data: unknown) => ExecReceiptView
  readTargetState: (data: unknown) => unknown
  probOf: (data: unknown) => { value?: number; key?: string }
  deviationOf: (data: unknown) => { value?: number; key?: string }
  linkStateCN: (d?: string) => string
}

/** 把只读句柄挂到 `window.__p6Read`（含 `mapCounts()`，验收脚本读它，**不改 MapStage**）。 */
function installP6Read(h: P6Read) {
  const w = window as unknown as { __p6Read?: Record<string, unknown> }
  w.__p6Read = { ...(w.__p6Read ?? {}), ...h }
}

/** 自证句柄：`window.__p6Stats`（步 10：SH-15 / SH-16 两份读数）。 */
function P6Probe(props: {
  step: number
  phase: string
  mode: 'exec' | 'control'
  listReply: CommandReply | null
  live: TargetLive[]
  selectedId: string | null
  evCount: number
  evLast: { id?: string; to?: string; status?: string; at: number } | null
  rows: ReceiptRow[]
  lastRun: ReceiptRow | null
  prob: { value?: number; key?: string }
  dev: { value?: number; key?: string }
  guidance: { planId: string | null; points: number; routes: number; timeline: number; from: string }
  links: number
  fwdNode: { name: string; lng: number; lat: number } | null
  prevRoutes: number
  onMap: Record<string, unknown>
}) {
  const { step, phase, mode, listReply, live, selectedId, evCount, evLast, rows, lastRun, prob, dev, guidance, links, fwdNode, prevRoutes, onMap } = props
  const w = window as unknown as { __p6Stats?: Record<string, unknown> }
  w.__p6Stats = {
    ...(w.__p6Stats ?? {}),
    step,
    screen: mode === 'exec' ? 'SH-15' : 'SH-16',
    phase,
    targets: {
      reply: listReply,
      count: live.length,
      rows: live.map((t) => ({
        entityId: t.entityId, no: t.row.no ?? null, name: t.row.name ?? null,
        status: t.status ?? null, dynamicState: t.dynamicState ?? null,
        struck: t.struck, source: t.source, lng: t.lng ?? null, lat: t.lat ?? null,
        sourceCount: t.row.sourceCount ?? null,
      })),
    },
    targetState: { events: evCount, last: evLast },
    selectedId,
    receipts: rows.map((r) => ({
      verb: r.verb, entityId: r.entityId, code: r.reply?.code ?? null,
      message: r.reply?.error?.message ?? null,
      basis: r.view?.basis ?? null, dynamicState: r.view?.dynamicState ?? null,
      leaves: r.view?.leaves ?? [],
    })),
    runView: lastRun?.view ?? null,
    /** 图上要点：偏差与命中概率都是"—"（引擎没有这两个字段），脚本据此断言"没编数" */
    deviation: dev,
    hitProbability: prob,
    guidance: { ...guidance, prevRoutes },
    topologyLinks: links,
    forwardNode: fwdNode ? { name: fwdNode.name } : null,
    map: onMap,
    dom: {
      cards: document.querySelectorAll('[data-testid="p6-target-card"]').length,
      hasObserve: !!document.querySelector('[data-testid="sh15-btn-observe"]'),
      hasTrack: !!document.querySelector('[data-testid="sh15-btn-track"]'),
      hasConfirm: !!document.querySelector('[data-testid="p6-btn-run"]'),
      hasReplan: !!document.querySelector('[data-testid="sh16-btn-replan"]'),
      aiText: (document.querySelector('[data-testid="sh15-ai-text"]') ?? document.querySelector('[data-testid="sh16-ai-text"]'))?.textContent ?? null,
      hitRing: document.querySelector('[data-testid="sh16-hit-ring"]')?.textContent ?? null,
      deviationText: document.querySelector('[data-testid="sh16-sync-deviation"]')?.textContent ?? null,
      stabilityText: document.querySelector('[data-testid="sh15-stability-missing"]')?.textContent ?? null,
      receiptRows: document.querySelectorAll('[data-testid="p6-receipt-row"]').length,
    },
  }
  return null
}

// ---- 样式（一律 left/right/bottom 长写：**不写 inset 简写**）----
//
// 本屏套在 App 的全局框架里（左导航 74 / 底部状态条 30 由壳让开）：
//   · 顶部压条 top:0 h:28（`StageStrip` 自己定位）
//   · 右栏 right:12 top:34 bottom:36（避开底部状态条）
//   · 左下浮层标签 bottom:78、按钮行 bottom:36（图上：标签在按钮上方一行）
const rightColStyle: CSSProperties = {
  position: 'absolute', right: 12, top: 34, bottom: 36, zIndex: 20, width: 322,
  display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
}
const chipRowStyle: CSSProperties = {
  position: 'absolute', left: 12, bottom: 78, zIndex: 21,
  display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'nowrap',
}
const actionBarStyle: CSSProperties = {
  position: 'absolute', left: 12, right: 346, bottom: 36, zIndex: 22,
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, minHeight: 32,
}
const primaryBtn: CSSProperties = {
  padding: '7px 26px', fontSize: 13.5, cursor: 'pointer', borderRadius: 8, whiteSpace: 'nowrap',
  letterSpacing: 0.5, border: '1px solid rgba(37,99,235,.8)',
  background: 'linear-gradient(180deg,#2563eb,#1d4ed8)', color: '#eaf3ff',
}
const ghostBtn: CSSProperties = {
  padding: '7px 22px', fontSize: 13, cursor: 'pointer', borderRadius: 8, whiteSpace: 'nowrap',
  background: 'rgba(10,20,36,.75)', border: `1px solid ${C.borderStrong}`, color: C.text,
}
const ghostDisabled: CSSProperties = {
  padding: '7px 22px', fontSize: 13, cursor: 'default', borderRadius: 8, whiteSpace: 'nowrap',
  background: 'rgba(10,20,36,.5)', border: `1px solid ${C.border}`, color: C.unknown,
}

export default GuidanceScreen
