// mission-app · apps/web/src/screens/GuidanceScreen.tsx
//
// Excel 步 10 · 协同执行与引导（参考图 `T6-1.png` 实时态势 / `T6-2.png` 引导控制）。
//
// 它是一层**覆盖层**（不改 `MapStage`）：地图台照常跑实时态势与无人机，本文件往地图上补
// **被处置目标**的图元，并在右侧/底部摆控制与回执面板：
//   · 地图：逐个目标画 `MapDraw` 的 `target` 图元；**颜色只由引擎状态决定**——
//     `targets.list` / `target.state` 给的 `status`（规则包 `bands[].state`：red/yellow/gray）
//     经 `statusColor()` 落到 `theme` 令牌：gray（= 引擎判"已失效"）就取 `C.muted`（灰）。
//     ★ **MUST NOT 前端自己判定命中**：没有引擎状态就不变色、不置灰、不改透明度。
//   · 右栏：AI 提示/实时跟踪状态（引擎读数）+ 协同链路（topology）+ 引导控制回执
//   · 底栏：目标列表（点选）+【执行处置】`exec.run{entityId}` /【中止处置】`exec.abort{entityId}`
//   · 回传画面：`components/MediaPanel`（`media.channels`，事件优先、verb 兜底）
//
// ★ 纪律：
//   ① 拿不到的字段写"—/未就绪 + code"；三条 verb（`exec.run` / `exec.abort` / `report.generate`）
//      本机实测仍是 `code=1000 未知 verb` 时，界面**如实显示宿主原话**并把按钮**可用**
//      （点下去就是把这句话拿回来，不假装成功、也不偷偷藏起来）。
//   ② 回执**逐条显示**：顶层认得字段之外，宿主给的所有标量叶子（含 `basis` 判据）原样摊平列出。
//   ③ 状态变化的唯一来源是**事件** `target.state`（引擎 `TargetStateEvent`）与 `entity.changed`；
//      前端只在事件到达时更新状态，不预测、不补间。
//   ④ 样式：`theme.ts` 令牌；不用 `backdrop-filter`；不用 `inset` 简写（与 `top` 混用会清掉 top）。
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { DEFAULT_INSTANCE_ID, getMapInstance, MapDraw, type PrimitiveKind } from 'map-2d'
import { C, panel, panelTitle, statusColor } from '../theme'
import type { CommandReply, FlowState } from '../api'
import type { UseFlow } from '../flow/useFlow'
import { n2s, replyText, useVerbOnce, type Metric } from '../flow/useSituation'
import { linkColor, ms2clock, readSim, readTopology, type LinkRow } from '../flow/useOps'
import { dynamicStateName, isStruckState, readExecReceipt, readTargetState, targetColor, type ExecReceiptView } from '../flow/useExec'
import { readTargets, type TargetRow } from '../flow/useOps'
import { MediaPanel } from '../components/MediaPanel'
import { VerbVerdict } from './VerbVerdict'
import { AdvanceButton } from './AdvanceButton'
import { StageStrip } from './StageOverlay'

/** 本屏画的图元 id 前缀（清理与计数只认它；MapStage 的图元一个都不碰）。 */
const TGT_PREFIX = 'TGT6:'

/** `exec.run` / `exec.abort` 的两条 verb（本屏的全部命令面）。 */
const V_RUN = 'exec.run'
const V_ABORT = 'exec.abort'

/** 一条命令的回执 + 它属于哪个目标（逐条留在界面上，切目标也不丢）。 */
interface ReceiptRow {
  verb: string
  entityId: string
  at: number
  reply: CommandReply | null
  busy: boolean
  view: ExecReceiptView | null
}

/** 一行「名 + 值」：值缺失显示"—"，**不补 0**。 */
function Row({ k, v, color, testid }: { k: string; v: string; color?: string; testid?: string }) {
  return (
    <div data-testid={testid} style={{ display: 'flex', gap: 8, padding: '2px 0', fontSize: 12 }}>
      <span style={{ color: C.textDim, width: 76, flex: '0 0 auto' }}>{k}</span>
      <span style={{ color: color ?? C.text, minWidth: 0, wordBreak: 'break-word' }}>{v}</span>
    </div>
  )
}

function Section({ title, children, testid }: { title: React.ReactNode; children: React.ReactNode; testid?: string }) {
  return (
    // box-sizing: border-box —— 免得 `width:100%` + 边框把 `overflowY:auto` 的列顶出横向滚动条
    <div data-testid={testid} style={{ ...panel, width: '100%', boxSizing: 'border-box' }}>
      <div style={panelTitle}>{title}</div>
      <div style={{ padding: '7px 12px 9px' }}>{children}</div>
    </div>
  )
}

function MetricRow({ m }: { m: Metric }) {
  return (
    <div data-testid="metric-row" style={{ display: 'flex', gap: 8, padding: '2px 0', fontSize: 12 }}>
      <span style={{ color: C.textDim, flex: 1, minWidth: 0 }}>{m.name}</span>
      <span style={{ color: m.status ? statusColor(m.status) : C.text, fontVariantNumeric: 'tabular-nums' }}>
        {m.value !== undefined ? n2s(m.value, m.unit ?? '') : (m.text ?? '—')}
      </span>
    </div>
  )
}

function posText(lng?: number, lat?: number): string {
  if (lng === undefined || lat === undefined) return '—'
  return `${lat.toFixed(5)}N ${lng.toFixed(5)}E`
}

/**
 * 「目标 + 引擎状态」的合成读数（本屏渲染的唯一数据源）。
 *
 * 合成规则（**以引擎状态为准**，前端不判命中）：
 *   · 台账行来自 `targets.list`（静态属性：编号/类型/威胁/坐标）；
 *   · 状态字段（`status` / `dynamicState`）用过**事件的**那一份：`target.state` 事件
 *     比轮询到的台账新，且它才是"命中/变灰"的权威；事件里没有该字段时回落台账行。
 */
interface TargetLive {
  row: TargetRow
  entityId: string
  status?: string
  dynamicState?: string
  /** 状态来自哪里（界面标注：`event` / `list` / `none`） */
  source: 'event' | 'list' | 'none'
  lng?: number
  lat?: number
  /** 引擎状态判为"已失效"（灰） */
  struck: boolean
  /** 最近一次状态迁移的原文（`target.state` 的 from→to + reason） */
  lastFrom?: string
  lastReason?: string
  lastAt?: number
}

/** `p6Read` 要暴露的"只读排障句柄"（挂到 `window.__p6Read`，验收脚本读它）。 */
export interface P6Read {
  /** 本屏画在地图上的目标图元：id/颜色/可见性（**只读快照**，不改渲染） */
  mapCounts: () => Record<string, unknown>
  /** 一个目标在图上当前的画法（颜色/可见性/状态），脚本用它做"变了没有"的前后对比 */
  targetPrimitive: (entityId: string) => Record<string, unknown> | null
  /** 用**合成回执**预演读取器（宿主 verb 未实现时也能验口径） */
  readExecReceipt: (data: unknown) => ExecReceiptView
  /** 用**合成事件**预演 `target.state` 的读取器 */
  readTargetState: (data: unknown) => unknown
  /** 引擎状态 → 图上颜色（`statusColor` 的落点；脚本据此对账颜色确实按域变） */
  colorOf: (status?: string, dynamicState?: string) => string
  /** 一条回执摊平后的叶子（断言"逐条显示"用） */
  leavesOf: (data: unknown) => { path: string; value: string }[]
}

export function GuidanceScreen({ state, flow, onNext }: {
  state: FlowState
  flow: UseFlow
  /** 下一步（本屏不自己改 step，切步一律发 `flow.goto`） */
  onNext?: () => void
}) {
  // ---- 台账（静态属性 + 基准状态）----
  const list = useVerbOnce(flow, 'targets.list', {}, true)
  const tv = useMemo(() => readTargets(list.data), [list.data])

  // ---- 事件：`target.state` / `entity.changed` 的**累积**状态（只认引擎给的事实）----
  const [evStates, setEvStates] = useState<Record<string, {
    status?: string; dynamicState?: string; from?: string; reason?: string; ts?: number
    threat?: string; confidence?: number; lng?: number; lat?: number
  }>>({})
  const [evCount, setEvCount] = useState(0)
  const [evLast, setEvLast] = useState<{ id?: string; from?: string; to?: string; reason?: string; status?: string; at: number } | null>(null)
  const send = flow.send
  const bind = flow.bind
  const lastListRef = useRef(0)
  const listRef = useRef(list.resend)
  listRef.current = list.resend

  // 事件挂到 `useFlow` 的**同一条** WS 通道上（`flow.bind`）——不在本屏另开一条连接：
  // 那样会多一份心跳与解析开销，而且"到底收没收到事件"会变成两处真相。
  useEffect(() => {
    const off1 = bind('target.state', (d) => {
      const st = readTargetState(d)
      if (!st.targetId) return
      setEvStates((prev) => ({
        ...prev,
        [st.targetId as string]: {
          status: st.status, dynamicState: st.dynamicState,
          from: prev[st.targetId as string]?.status, // 上一条的 to 即本条的 from（仅用于显示链）
          reason: typeof d.reason === 'string' ? d.reason : undefined,
          ts: st.ts, threat: st.threat, confidence: st.confidence, lng: st.lng, lat: st.lat,
        },
      }))
      setEvCount((n) => n + 1)
      setEvLast({
        id: st.targetId, from: st.status, to: st.dynamicState,
        reason: typeof d.reason === 'string' ? d.reason : undefined,
        status: st.status, at: Date.now(),
      })
    })
    // `entity.changed` 到达 → 台账可能变了，限频重取一次（状态字段仍只认上面那份）
    const off2 = bind('entity.changed', () => {
      const now = Date.now()
      if (now - lastListRef.current < 1500) return
      lastListRef.current = now
      listRef.current()
    })
    return () => { off1(); off2() }
  }, [bind])

  // ---- 媒体通道：**事件优先**、verb 兜底（与步 7 同一口径）----
  const mediaSlot = flow.events['media.channels']
  const mediaVerb = useVerbOnce(flow, 'media.channels', {}, true)
  const mediaRaw = mediaSlot?.data ?? (mediaVerb.reply?.code === 0 ? mediaVerb.reply.data : null)
  const mediaFrom: 'event' | 'verb' | 'none' = mediaSlot ? 'event' : (mediaVerb.reply?.code === 0 && mediaVerb.reply.data ? 'verb' : 'none')

  // ---- 链路（协同链路面板）：topology.evaluate ----
  const topo = useVerbOnce(flow, 'topology.evaluate', {}, true)
  const tv2 = useMemo(() => readTopology(topo.data), [topo.data])

  // ---- 仿真读数（`sim.state` 事件）：只显示宿主给的字段 ----
  const sim = useMemo(() => readSim(flow.events['sim.state']?.data ?? null), [flow.events['sim.state']])

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
      lastFrom: ev?.from,
      lastReason: ev?.reason,
      lastAt: ev?.ts,
    }
  }), [tv.items, evStates])

  const struckCount = live.filter((t) => t.struck).length
  const stateChanges = evCount

  // ---- 选中目标 + 命令回执（逐条留下）----
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = live.find((t) => t.entityId === selectedId) ?? live[0] ?? null
  /** 选中目标跟着台账走：台账换了一批就把选中改成第一个（不改任何状态字段） */
  useEffect(() => {
    if (!selectedId && live.length) setSelectedId(live[0].entityId)
    if (selectedId && live.length && !live.some((t) => t.entityId === selectedId)) setSelectedId(live[0].entityId)
  }, [live, selectedId])

  const [rows, setRows] = useState<ReceiptRow[]>([])
  const [busyVerb, setBusyVerb] = useState<string | null>(null)

  /**
   * 发一条处置命令并**把回执留在列表里**（成功/失败/未实现都留）。
   *
   * 宿主未实现时（`code=1000`）它返回的就是"未知 verb：exec.run"——界面照抄，
   * 并把这条也当成"结论"（按钮不重复狂点，可再点一次重试）。
   */
  const fire = async (verb: string, entityId: string) => {
    const key = `${verb}#${entityId}#${Date.now()}`
    setRows((prev) => [{ verb, entityId, at: Date.now(), reply: null, busy: true, view: null }, ...prev].slice(0, 6))
    setBusyVerb(key)
    try {
      const r = await send(verb, { entityId })
      setRows((prev) => prev.map((x, i) => (i === 0 && x.busy ? { ...x, reply: r, busy: false, view: readExecReceipt(r.data) } : x)))
      // 命令成功 → 台账/状态可能已变：重取一次列表（状态字段仍只认事件）
      if (r.code === 0) listRef.current()
    } catch (e) {
      const r: CommandReply = { code: -1, verb, error: { message: String((e as Error)?.message ?? e) } }
      setRows((prev) => prev.map((x, i) => (i === 0 && x.busy ? { ...x, reply: r, busy: false, view: null } : x)))
    } finally {
      setBusyVerb(null)
    }
  }

  // ---- 向导/动作回执（`targets.act` 等）不是本屏命令面；只读最近一次 `flow.lastReply` 里的本屏 verb ----
  const runReplies = rows.filter((r) => r.verb === V_RUN)
  const abortReplies = rows.filter((r) => r.verb === V_ABORT)
  const lastRun = runReplies[0] ?? null

  /**
   * 引擎给的"处置依据/时间轴"若跟着回执一起来（宿主可选），把它原样列出来。
   * 读不到就不显示——**不编时刻、不编偏差**。
   */
  const runView = lastRun?.view ?? null

  // ---------------- 地图叠加：目标图元（颜色/可见性只由引擎状态决定） ----------------
  const drawnRef = useRef<{ kind: PrimitiveKind; id: string }[]>([])
  useEffect(() => {
    const prev = drawnRef.current
    const next: { kind: PrimitiveKind; id: string }[] = []
    MapDraw.batch(() => {
      for (const d of prev) MapDraw.remove(d.kind, d.id)
      for (const t of live) {
        if (t.lng === undefined || t.lat === undefined) continue   // 没有坐标 → 不画（不编坐标）
        const id = `${TGT_PREFIX}${t.entityId}`
        MapDraw.add('target', {
          id,
          lng: t.lng,
          lat: t.lat,
          // 颜色：**已处置（dynamicState=struck/destroyed）→ theme.muted 灰**；
          // 否则按引擎给的 `status` 域（规则包 bands[].state：red/yellow/gray）映射。
          // ⚠ `status=gray` 只表示"低威胁档"，**不等于**已失效 —— 所以判定只用 dynamicState。
          color: targetColor(t.status, t.dynamicState) === 'muted' ? C.muted
            : (t.status ? statusColor(t.status) : C.unknown),
          // 状态域原样带上（map-2d 的 target 图元有这个字段；也便于别人读快照对账）
          status: t.struck ? 'gray' : t.status,
          label: t.row.no !== undefined ? `目标${String(t.row.no).padStart(3, '0')}` : (t.row.name || t.entityId),
          selected: t.entityId === selected?.entityId,
        })
        next.push({ kind: 'target', id })
      }
    })
    drawnRef.current = next
    return () => {
      // 离开本屏：把本屏的目标图元清干净（MapStage 的 drone/track/label/area 不动）
      const mine = drawnRef.current
      MapDraw.batch(() => { for (const d of mine) MapDraw.remove(d.kind, d.id) })
      drawnRef.current = []
    }
  }, [live, selected?.entityId])

  // ---------------- 只读排障句柄（验收脚本读它；不改渲染、不改 MapStage） ----------------
  const readHandle: P6Read = useMemo(() => ({
    mapCounts: () => mapCounts(),
    targetPrimitive: (entityId: string) => {
      const items = MapDraw.list('target') as unknown as { id: string; color?: string; status?: string; lng: number; lat: number }[]
      const it = items.find((x) => x.id === `${TGT_PREFIX}${entityId}`)
      if (!it) return null
      return {
        id: it.id, color: it.color ?? null, status: it.status ?? null,
        lng: it.lng, lat: it.lat, visible: MapDraw.isVisible('target', it.id),
      }
    },
    readExecReceipt: (data: unknown) => readExecReceipt(data),
    readTargetState: (data: unknown) => readTargetState(data),
    /** 引擎状态 → 图上颜色。口径：`dynamicState=struck/destroyed` → 灰（`theme.muted`）；
     *  否则按 `status` 域（规则包 bands[].state：red/yellow/gray）映射。 */
    colorOf: (status?: string, dynamicState?: string) => {
      const kind = targetColor(status, dynamicState)
      return kind === 'muted' ? C.muted : (kind === 'status' ? statusColor(status) : C.unknown)
    },
    leavesOf: (data: unknown) => readExecReceipt(data).leaves,
  }), [])
  useEffect(() => { installP6Read(readHandle) }, [readHandle])

  const county = live.filter((t) => t.struck).length
  const phaseText = state.phase || '—'

  return (
    <>
      {/* ---------------- 顶部压条（显示模式取自 view-composer 的读数，没读到就写"—"）---------------- */}
      <StageStrip
        items={[
          { k: '显示模式', v: '实时态势 / 引导控制' },
          { k: '阶段', v: phaseText },
          { k: '目标', v: `${live.length}${tv.total !== undefined && tv.total !== live.length ? `/${tv.total}` : ''}` },
          { k: '已失效', v: `${county}`, color: county > 0 ? C.muted : C.textDim },
          { k: '状态变更', v: `${stateChanges} 次`, color: stateChanges > 0 ? C.accent : C.textDim },
        ]}
        right={<span style={{ color: C.textDim }}>
          {list.reply === null
            ? '目标台账读取中…'
            : list.reply.code === 0
              ? `targets.list 已就绪（${live.length} 个目标）`
              : `targets.list：${replyText(list.reply)}`}
        </span>}
      />

      {/* ---------------- 左栏：回传画面 + 目标实时状态 + 链路 ---------------- */}
      <div style={leftColStyle}>
        <MediaPanel
          raw={mediaRaw}
          from={mediaFrom}
          reply={mediaVerb.reply}
          busy={mediaVerb.busy}
          onRetry={mediaVerb.resend}
          overlayName={selected?.row.name}
          title="回传画面（视频 / SAR）"
          height={252}
          testid="p6-media-panel"
        />

        <Section title="目标实时状态" testid="p6-live-state-panel">
          {selected ? (
            <>
              <Row
                k="目标编号"
                v={selected.row.no !== undefined ? `目标${String(selected.row.no).padStart(3, '0')}` : selected.entityId}
                testid="p6-live-target-no"
              />
              <Row k="目标名称" v={selected.row.name || selected.row.typeName || '—'} />
              <Row k="威胁等级" v={selected.row.threat ?? '—'} color={selected.row.threat ? statusColor(selected.row.threat) : C.textDim} />
              <Row
                k="动态状态"
                v={(() => {
                  const n = dynamicStateName(selected.dynamicState)
                  return n.source === 'key' ? `${n.text}（规则包未给中文名，显示键）` : n.text
                })()}
                color={selected.struck ? C.muted : C.text}
                testid="p6-live-dynamic-state"
              />
              <Row
                k="台账状态"
                v={selected.status ? `${selected.status}（规则包 bands[].state）` : '未给状态字段'}
                color={selected.status ? statusColor(selected.status) : C.textDim}
                testid="p6-live-status"
              />
              <Row k="状态来源" v={selected.source === 'event' ? 'target.state 事件' : selected.source === 'list' ? 'targets.list 台账' : '宿主未给'} />
              <Row k="位置" v={posText(selected.lng, selected.lat)} testid="p6-live-pos" />
              <Row k="置信度" v={selected.row.confidence !== undefined ? `${(selected.row.confidence <= 1 ? selected.row.confidence * 100 : selected.row.confidence).toFixed(0)}%` : '—'} />
              {selected.lastFrom && <Row k="由" v={selected.lastFrom} />}
              {selected.lastReason && <Row k="引擎原因" v={selected.lastReason} />}
              {selected.lastAt !== undefined && <Row k="事件时刻" v={new Date(selected.lastAt).toLocaleTimeString()} />}
              {!selected.struck && selected.source === 'none' && (
                <div data-testid="p6-state-unknown" style={{ fontSize: 11, color: C.warn, lineHeight: 1.6, marginTop: 3 }}>
                  宿主未给出该目标的动态状态（`targets.list` 无 status/dynamicState，且未收到 `target.state`）
                  → 图上不变色（前端 MUST NOT 自己判命中）。
                </div>
              )}
            </>
          ) : (
            <div style={{ fontSize: 12, color: C.textDim, lineHeight: 1.7 }}>
              目标台账为空（{list.reply ? `targets.list → ${replyText(list.reply)}` : '正在读取…'}）。
            </div>
          )}
          {stateChanges > 0 && (
            <div data-testid="p6-state-changes" style={{ fontSize: 11, color: C.accent, marginTop: 4 }}>
              已收到 target.state 事件 {stateChanges} 条
              {evLast?.id ? ` · 最近：${evLast.id} → ${evLast.to ?? '—'}（status=${evLast.status ?? '—'}）` : ''}
            </div>
          )}
        </Section>

        <Section title="协同链路" testid="p6-link-panel">
          {tv2.links.length === 0 && (
            <div style={{ fontSize: 11.5, color: C.textDim, lineHeight: 1.7 }}>
              链路未就绪：{topo.reply ? replyText(topo.reply) : 'topology.evaluate 未发送'}
            </div>
          )}
          {tv2.links.slice(0, 6).map((l: LinkRow) => (
            <div key={l.key} data-testid="p6-link-row" style={{ display: 'flex', gap: 8, padding: '2px 0', fontSize: 12 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: linkColor(l.status), marginTop: 4, flex: '0 0 auto' }} />
              <span style={{ flex: 1, minWidth: 0, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name || l.key}</span>
              <span style={{ color: linkColor(l.status) }}>{l.status ?? '—'}</span>
            </div>
          ))}
          {tv2.links.length > 0 && (
            <div style={{ fontSize: 10.5, color: C.textDim, marginTop: 3 }}>
              {tv2.links.length} 条链路（`topology.evaluate` 的 data.links，原样；颜色只做映射不判级）
            </div>
          )}
        </Section>
      </div>

      {/* ---------------- 右栏：引导提示 + 仿真读数 + 处置回执 ---------------- */}
      <div style={rightColStyle}>
        <Section title="AI 引导提示" testid="p6-advice-panel">
          {selected ? (
            <>
              <div style={{ fontSize: 12, color: C.text, lineHeight: 1.7 }}>
                当前引导目标：{selected.row.no !== undefined ? `目标${String(selected.row.no).padStart(3, '0')} ` : ''}
                {selected.row.name || '—'}
              </div>
              <div style={{ fontSize: 11.5, color: selected.struck ? C.muted : C.textDim, lineHeight: 1.7, marginTop: 3 }}>
                引擎状态：{dynamicStateName(selected.dynamicState).text}
                {selected.status ? ` · ${selected.status}` : ''}
              </div>
              {selected.struck && (
                <div data-testid="p6-advice-struck" style={{ fontSize: 11.5, color: C.muted, lineHeight: 1.7, marginTop: 3 }}>
                  该目标已被引擎判为失效（图上取 `theme.muted` 灰）——可发【中止处置】`{V_ABORT}`
                  或继续对其他目标执行处置。
                </div>
              )}
              {!selected.struck && (
                <div style={{ fontSize: 11.5, color: C.textDim, lineHeight: 1.7, marginTop: 3 }}>
                  处置动作由引擎裁决（状态机迁移未声明会回 `1003`）；本屏只负责把命令与回执摆在一起，
                  不预测命中、不编偏差/命中概率。
                </div>
              )}
            </>
          ) : <div style={{ fontSize: 11.5, color: C.textDim }}>无目标可引导</div>}
          {runView?.notes.slice(0, 3).map((t, i) => (
            <div key={i} style={{ fontSize: 10.5, color: C.textDim, lineHeight: 1.55, marginTop: 3 }}>· {t}</div>
          ))}
        </Section>

        <Section title="仿真 / 引导读数" testid="p6-sim-panel">
          <Row k="仿真运行" v={sim.running === undefined ? '—' : sim.running ? '运行中' : '已暂停'} color={sim.running ? C.ok : C.textDim} />
          <Row k="倍速" v={sim.speed !== undefined ? `${sim.speed}×` : '—'} />
          <Row k="仿真时刻" v={ms2clock(sim.simElapsedMs)} testid="p6-sim-elapsed" />
          <Row k="平台数" v={sim.platforms !== undefined ? n2s(sim.platforms) : '—'} />
          <Row k="事件数" v={sim.emitted !== undefined ? n2s(sim.emitted) : '—'} />
          {(sim.running === undefined) && (
            <div style={{ fontSize: 10.5, color: C.textDim, lineHeight: 1.55 }}>
              未收到 `sim.state` 事件（本屏不自己起仿真；起飞/倍速由步 6 控制）
            </div>
          )}
        </Section>

        <VerbVerdict
          title="处置命令"
          rows={[
            { verb: V_RUN, reply: lastRun?.reply ?? null, busy: busyVerb?.startsWith(V_RUN) ?? false, okNote: `${lastRun?.entityId ?? '—'} → ${lastRun?.view?.dynamicState ?? '—'}${lastRun?.view?.idempotent ? ' · 幂等' : ''}` },
            { verb: V_ABORT, reply: abortReplies[0]?.reply ?? null, busy: busyVerb?.startsWith(V_ABORT) ?? false, okNote: `${abortReplies[0]?.entityId ?? '—'} → ${abortReplies[0]?.view?.dynamicState ?? '—'}` },
            { verb: 'targets.list', reply: list.reply, busy: list.busy, onRetry: list.resend, okNote: `${live.length} 个目标` },
            { verb: 'media.channels', reply: mediaVerb.reply, busy: mediaVerb.busy, onRetry: mediaVerb.resend, okNote: `${mediaFrom === 'none' ? 0 : (mediaSlot ? ((mediaSlot.data.channels as unknown[] | undefined)?.length ?? 0) : 0)} 路通道` },
          ]}
        />

        {/* 回执逐条：宿主给什么显示什么（含 basis 判据 + 全部标量叶子） */}
        <Section
          title={<span>处置回执明细（逐条）
            <span style={{ float: 'right', fontSize: 11.5, color: C.textDim }}>{rows.length} 条</span>
          </span>}
          testid="p6-receipt-panel"
        >
          {rows.length === 0 && (
            <div data-testid="p6-receipt-empty" style={{ fontSize: 11.5, color: C.textDim, lineHeight: 1.7 }}>
              尚未发过命令。选中目标后点【执行处置】发 `{V_RUN}{'{entityId}'}`，
              或点【中止处置】发 `{V_ABORT}{'{entityId}'}`。
            </div>
          )}
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
              {r.view?.dynamicState && (
                <div style={{ fontSize: 11, color: C.textDim }}>
                  状态 → {dynamicStateName(r.view.dynamicState, r.view.dynamicStateName).text}
                  {r.view.from ? `（from ${r.view.from}）` : ''}
                  {r.view.status ? ` · status=${r.view.status}` : ''}
                  {r.view.idempotent ? ' · 幂等' : ''}
                </div>
              )}
              {(r.view?.entityId || r.view?.action) && (
                <div style={{ fontSize: 11, color: C.textDim }}>
                  {r.view.entityId ? `entityId=${r.view.entityId}` : ''}{r.view.action ? ` · action=${r.view.action}` : ''}
                </div>
              )}
              {/* ↓ 判据：宿主给的那个字段名 + 原话（拿不到就明说"未给出判据"） */}
              <div
                data-testid="p6-receipt-basis"
                style={{ fontSize: 10.5, lineHeight: 1.5, color: r.view?.basis ? C.textDim : C.warn, wordBreak: 'break-word' }}
              >
                {r.view?.basis
                  ? `${r.view.basisKey ?? 'basis'}：${r.view.basis}`
                  : (r.reply?.code === 0 ? '宿主未给出判据（basis）' : '无判据（命令未成功）')}
              </div>
              {r.view && r.view.basisInputs.length > 0 && (
                <div style={{ fontSize: 10, color: C.textDim, wordBreak: 'break-word' }}>
                  {r.view.basisInputs.slice(0, 8).map((p) => `${p.path}=${p.value}`).join(' · ')}
                </div>
              )}
              {r.view && (r.view.unmet.length > 0 || r.view.skipped.length > 0) && (
                <div style={{ fontSize: 10.5, color: C.warn }}>
                  {r.view.unmet.length > 0 ? `未满足：${r.view.unmet.join('、')}` : ''}
                  {r.view.skipped.length > 0 ? ` 跳过：${r.view.skipped.join('、')}` : ''}
                </div>
              )}
              {/* 回执里其余标量叶子：逐条摊平（字段名不猜，给什么抄什么） */}
              {r.view && r.view.leaves.length > 0 && (
                <div data-testid="p6-receipt-leaves" style={{ display: 'flex', flexWrap: 'wrap', gap: '1px 9px', marginTop: 2 }}>
                  {r.view.leaves.slice(0, 24).map((p) => (
                    <span key={p.path} style={{ fontSize: 9.5, color: C.textDim }}>
                      {p.path}=<span style={{ color: C.text }}>{p.value}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </Section>
      </div>

      {/* ---------------- 底部：目标列表 + 两个处置按钮 ---------------- */}
      <div style={bottomStyle}>
        <div style={{ ...panel, flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={panelTitle}>
            协同执行目标
            <span style={{ float: 'right', fontSize: 11.5, color: C.textDim }}>
              {live.length} 个 · 已失效 {county} 个（状态来自引擎）
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8, padding: 9, flex: 1, minHeight: 0, overflowX: 'auto' }}>
            {live.map((t) => {
              const color = t.struck ? C.muted : statusColor(t.status)
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
                  style={{
                    width: 150, flex: '0 0 auto', textAlign: 'left', cursor: 'pointer',
                    border: `1px solid ${picked ? C.borderStrong : C.border}`, borderRadius: 8,
                    background: picked ? 'rgba(29,78,216,.35)' : 'rgba(10,32,58,.6)',
                    padding: '7px 9px', display: 'flex', flexDirection: 'column', gap: 3,
                    opacity: t.struck ? 0.72 : 1,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 11, color: C.textDim }}>
                      {t.row.no !== undefined ? `目标${String(t.row.no).padStart(3, '0')}` : `#${t.entityId}`}
                    </span>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: color, flex: '0 0 auto' }} />
                    <span style={{ fontSize: 11, color }}>{t.status ?? '—'}</span>
                  </div>
                  <div style={{ fontSize: 12, color: C.text, lineHeight: 1.35 }}>{t.row.name || t.row.typeName || '—'}</div>
                  <div data-testid="p6-card-state" style={{ fontSize: 11, color: t.struck ? C.muted : C.text }}>
                    {dynamicStateName(t.dynamicState).text}
                  </div>
                  <div style={{ fontSize: 10, color: C.textDim }}>
                    状态源 {t.source === 'event' ? 'target.state' : t.source === 'list' ? 'targets.list' : '未给'}
                  </div>
                </button>
              )
            })}
            {live.length === 0 && (
              <div style={{ alignSelf: 'center', fontSize: 12, color: C.textDim, lineHeight: 1.7, padding: '0 4px' }}>
                目标列表为空{list.reply && list.reply.code !== 0 ? ` —— ${replyText(list.reply)}` : '（目标随探测出现）'}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ---------------- 右下：执行 / 中止 ---------------- */}
      <div style={actionBarStyle}>
        <button
          data-testid="p6-btn-run"
          style={busyVerb?.startsWith(V_RUN) || !selected ? ghostDisabled : primaryBtn}
          disabled={(busyVerb?.startsWith(V_RUN) ?? false) || !selected}
          title={selected ? `${V_RUN} {entityId:"${selected.entityId}"}` : '未选中目标'}
          onClick={() => { if (selected) void fire(V_RUN, selected.entityId) }}
        >{busyVerb?.startsWith(V_RUN) ? '执行中…' : '执行处置'}</button>
        <button
          data-testid="p6-btn-abort"
          style={busyVerb?.startsWith(V_ABORT) || !selected ? ghostDisabled : ghostBtn}
          disabled={(busyVerb?.startsWith(V_ABORT) ?? false) || !selected}
          title={selected ? `${V_ABORT} {entityId:"${selected.entityId}"}` : '未选中目标'}
          onClick={() => { if (selected) void fire(V_ABORT, selected.entityId) }}
        >{busyVerb?.startsWith(V_ABORT) ? '中止中…' : '中止处置'}</button>
        {onNext && (
          <button data-testid="p6-btn-next" style={ghostBtn} onClick={onNext}>下一步：任务总结</button>
        )}
        {/* 步 10 → 步 11：**阶段推进**走引擎门禁（`mission.advance{to:"T7"}` → 步 11）。
            与上面的 `onNext`（纯切屏）并存：切屏负责"让你看到那一屏"，推进负责"报告里的阶段对得上"。 */}
        <AdvanceButton flow={flow} to="T7" label="推进阶段并进入总结 ≫" style={primaryBtn} />
        {lastRun && !lastRun.busy && lastRun.reply && lastRun.reply.code !== 0 && (
          <span data-testid="p6-run-verdict" style={{ fontSize: 11.5, color: C.bad, maxWidth: 420, lineHeight: 1.5 }}>
            {V_RUN} → {replyText(lastRun.reply)}
          </span>
        )}
      </div>

      <P6Probe
        step={state.step}
        phase={state.phase}
        listReply={list.reply}
        live={live}
        selectedId={selected?.entityId ?? null}
        evCount={evCount}
        evLast={evLast}
        rows={rows}
        replies={flow.replies}
        lastReply={flow.lastReply}
        mediaFrom={mediaFrom}
        topologyLinks={tv2.links.length}
        struckCount={struckCount}
        runView={runView}
      />
    </>
  )
}

/** 本屏在地图上画了什么（**只读**：`MapDraw.list` 的快照 + 相机读数，不改渲染）。 */
function mapCounts(): Record<string, unknown> {
  const targets = MapDraw.list('target') as unknown as { id: string; color?: string; status?: string; lng: number; lat: number; label?: string }[]
  const mine = targets.filter((t) => t.id.startsWith(TGT_PREFIX))
  const map = getMapInstance(DEFAULT_INSTANCE_ID)
  const b = map?.getBounds()
  const inside = (lng: number, lat: number) => !!b
    && lng >= b.getWest() && lng <= b.getEast() && lat >= b.getSouth() && lat <= b.getNorth()
  return {
    /** 本屏画的目标图元数（前缀 TGT6:） */
    mine: mine.length,
    /** 整袋大小（含别人画的，便于分辨"是谁画的"） */
    targetTotal: targets.length,
    items: mine.map((t) => ({
      id: t.id,
      entityId: t.id.slice(TGT_PREFIX.length),
      color: t.color ?? null,
      status: t.status ?? null,
      label: t.label ?? null,
      lng: t.lng, lat: t.lat,
      visible: MapDraw.isVisible('target', t.id),
      inView: inside(t.lng, t.lat),
    })),
    drones: MapDraw.list('drone').length,
    viewport: map ? { lng: map.getCenter().lng, lat: map.getCenter().lat, zoom: map.getZoom() } : null,
  }
}

/** 把只读句柄挂到 `window.__p6Read`（含 `mapCounts()`，验收脚本读它，**不改 MapStage**）。 */
function installP6Read(h: P6Read) {
  const w = window as unknown as { __p6Read?: Record<string, unknown> }
  w.__p6Read = { ...(w.__p6Read ?? {}), ...h }
}

/** 自证句柄：`window.__p6Stats`（步 10 部分）。 */
function P6Probe(props: {
  step: number
  phase: string
  listReply: CommandReply | null
  live: TargetLive[]
  selectedId: string | null
  evCount: number
  evLast: { id?: string; from?: string; to?: string; reason?: string; status?: string; at: number } | null
  rows: ReceiptRow[]
  replies: Record<string, CommandReply>
  lastReply: CommandReply | null
  mediaFrom: 'event' | 'verb' | 'none'
  topologyLinks: number
  struckCount: number
  runView: ExecReceiptView | null
}) {
  const { step, phase, listReply, live, selectedId, evCount, evLast, rows, replies, lastReply, mediaFrom, topologyLinks, struckCount, runView } = props
  const w = window as unknown as { __p6Stats?: Record<string, unknown> }
  w.__p6Stats = {
    ...(w.__p6Stats ?? {}),
    step,
    screen: 'guidance',
    phase,
    targets: {
      reply: listReply,
      count: live.length,
      rows: live.map((t) => ({
        entityId: t.entityId, no: t.row.no ?? null, name: t.row.name ?? null,
        status: t.status ?? null, dynamicState: t.dynamicState ?? null,
        struck: t.struck, source: t.source,
        lng: t.lng ?? null, lat: t.lat ?? null,
      })),
      struckCount,
    },
    targetState: {
      /** 本屏**收到**的 `target.state` 事件条数（累积；前端不自己造状态） */
      events: evCount,
      last: evLast,
    },
    selectedId,
    /** 处置命令回执（逐条：verb/code/原话/判据/命中状态） */
    receipts: rows.map((r) => ({
      verb: r.verb, entityId: r.entityId, code: r.reply?.code ?? null,
      message: r.reply?.error?.message ?? null,
      basis: r.view?.basis ?? null, basisKey: r.view?.basisKey ?? null,
      dynamicState: r.view?.dynamicState ?? null, status: r.view?.status ?? null,
      leaves: r.view?.leaves ?? [],
    })),
    runView,
    replies: Object.fromEntries(Object.entries(replies ?? {}).map(([k, v]) => [k, { verb: v.verb, code: v.code, message: v.error?.message ?? null }])),
    lastReply: lastReply ? { verb: lastReply.verb, code: lastReply.code, message: lastReply.error?.message ?? null } : null,
    media: { from: mediaFrom },
    topologyLinks,
    dom: {
      cards: document.querySelectorAll('[data-testid="p6-target-card"]').length,
      struckCards: Array.from(document.querySelectorAll('[data-testid="p6-target-card"]')).filter((el) => el.getAttribute('data-struck') === '1').length,
      hasRun: !!document.querySelector('[data-testid="p6-btn-run"]'),
      hasAbort: !!document.querySelector('[data-testid="p6-btn-abort"]'),
      hasMedia: !!document.querySelector('[data-testid="p6-media-panel"]'),
      receiptRows: document.querySelectorAll('[data-testid="p6-receipt-row"]').length,
      selectedStateText: document.querySelector('[data-testid="p6-live-dynamic-state"]')?.textContent ?? null,
      selectedStatusText: document.querySelector('[data-testid="p6-live-status"]')?.textContent ?? null,
      stateChangesText: document.querySelector('[data-testid="p6-state-changes"]')?.textContent ?? null,
    },
  }
  return null
}

// ---- 样式（一律 left/right/bottom 长写：**不写 inset 简写**，见 App.tsx 的踩坑注释）----
const leftColStyle: CSSProperties = {
  position: 'absolute', left: 12, top: 34, bottom: 186, zIndex: 20, width: 298,
  display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
}
const rightColStyle: CSSProperties = {
  position: 'absolute', right: 12, top: 34, bottom: 186, zIndex: 20, width: 320,
  display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
}
const bottomStyle: CSSProperties = {
  position: 'absolute', left: 12, right: 12, bottom: 54, zIndex: 21, height: 106,
}
/**
 * 底栏按钮条。
 *
 * `bottom: 24` 是**算过的**：宿主底部有一条全局状态条（`App.tsx` 的 `statusBarStyle`：
 * `bottom:0; height:28`），覆盖层里所有贴底元素都得让开这 28 px，否则会被它压住半行。
 */
const actionBarStyle: CSSProperties = {
  position: 'absolute', left: 12, right: 12, bottom: 24, zIndex: 22,
  display: 'flex', alignItems: 'center', gap: 10, height: 30,
}
const primaryBtn: CSSProperties = {
  padding: '6px 18px', fontSize: 13, cursor: 'pointer', borderRadius: 8, whiteSpace: 'nowrap',
  letterSpacing: 0.5, border: '1px solid rgba(34,197,94,.6)',
  background: 'linear-gradient(180deg,#16a34a,#15803d)', color: '#eafff2',
}
const ghostBtn: CSSProperties = {
  padding: '6px 14px', fontSize: 12.5, cursor: 'pointer', borderRadius: 8, whiteSpace: 'nowrap',
  background: 'rgba(10,20,36,.75)', border: `1px solid ${C.borderStrong}`, color: C.text,
}
const ghostDisabled: CSSProperties = {
  padding: '6px 14px', fontSize: 12.5, cursor: 'default', borderRadius: 8, whiteSpace: 'nowrap',
  background: 'rgba(10,20,36,.5)', border: `1px solid ${C.border}`, color: C.unknown,
}

export default GuidanceScreen
