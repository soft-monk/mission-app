// mission-app · apps/web/src/screens/StrikeConfirmScreen.tsx
//
// **打击确认界面（需求专篇 DES-APP-001 SH-14，参考图 `场景1\T5-2.png`，1519×1035）**。
//
// 版式（图的四块；顶栏/左导航/底部状态条/麦克风球由 `AppShell` 提供，本文件只摆浮层）：
//   · 左上：地图工具栏（选择 / 测距 / 图层 / 3D · 2D/3D）｜ 右上：显示模式「打击确认」
//   · 中区下部左：「目标清单」（图上 3 行：编号 + 类型 + 威胁标签 + 优先级）
//   · 中区下部中：「打击窗口时间轴」（面板右端「窗口剩余 mm:ss」+ 图上 4 段卡片）
//   · 其下两按钮：【生成打击任务】（`strike.confirm{planId}`）/【调整方案】（回 SH-13）
//   · 右栏 3 面板：「资源调度情况」/「信息包与协同状态」/「AI确认建议」
//
// ★ 纪律（这一屏最容易犯的四个错）：
//   ① **一个数都不编**：目标清单取 `targets.list` 真回执（威胁分值降序，域与优先级原样）；
//      「窗口剩余」就是 `strike.window` 回执的 `remainingMs`（**前端不做本地倒计时**）；
//      取不到就写"—"并说明原因。图上 08:42 / 92% / 已接入 / 稳定 一律**不写死**。
//   ② **时间轴：段名照图、时刻留白**（§9-9 待裁决）：图上四段是「T+00 信息包生成 / T+03 火力
//      协同确认 / T+06 空中支援接入 / T+09 等待任务生成」，而引擎给的是 t0/到达/打击/评估
//      ——时刻值没有引擎来源 → 段名照图写，**时刻位显示"—"**，并在面板下如实写一行口径；
//      引擎自己的四段（含 basis）另起一行原样摆出（那是真实数据，不冒充图上的段名）。
//   ③ **右栏三面板取不到就留白**：`guidance.plan` 没有"信息包/远程火力/空中支援"这类字段
//      （全工程只有 `config.json` 的语音文案里出现过这些词）→ 如实写"回执未给该字段"，
//      MUST NOT 抄图上的 92% / 已接入 / 待确认 / 稳定。
//   ④ 地图叠加只用 `MapDraw` 的公共 API 画**引擎给的几何**（`guidance.plan` 的 IP 点/引导
//      连线/航线）：坐标只"取"不算，没给几何就不画。
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { DEFAULT_INSTANCE_ID, getMapInstance, MapDraw, mapCommands, type PrimitiveKind } from 'map-2d'
import { C, panel, panelTitle } from '../theme'
import type { CommandReply, FlowState } from '../api'
import type { UseFlow } from '../flow/useFlow'
import { n2s, obj, readCompose, replyText, useVerbOnce } from '../flow/useSituation'
import { ms2clock, readTargets, type TargetRow } from '../flow/useOps'
import {
  readGuidance, readReceipt, readStrikePlans, readStrikeWindow, shortTime,
  type GuidanceView,
} from '../flow/useStrike'
import { voiceLine, useLabels } from '../shell/VoiceStrip'
// 工具条改用**共享的**实现（`shell/MapTools`）：真能点的量算/手绘/图层面板都落在这里，
// 各屏只声明"图上有哪几格"，能不能点由规则包 `view.compose` 说了算。
import { MapToolbar, ToolModeNote, toolsOf, useMapToolState } from '../shell/MapTools'

// 图元 id 前缀：**只用来认领本屏画的东西**（清理与计数都靠它；MapStage 的图元一个都不碰）
const IP_PREFIX = 'IP:'
const TGT_PREFIX = 'TGT:'
const GL_PREFIX = 'GL:'   // 引导连线
const RT_PREFIX = 'RT:'   // 宿主给的航线（评估航线等）

/** 图上「打击窗口时间轴」的四段（**逐字照图**；时刻值没有引擎来源 → 一律"—"）。 */
const IMAGE_SEGS: { t: string; label: string }[] = [
  { t: 'T+00', label: '信息包生成' },
  { t: 'T+03', label: '火力协同确认' },
  { t: 'T+06', label: '空中支援接入' },
  { t: 'T+09', label: '等待任务生成' },
]

/** 「资源调度情况」的 4 行（图上逐字）→ 拿它去 `guidance.plan` 的集群里按语义认领。 */
const RES_ROWS: { label: string; keys: string[] }[] = [
  { label: '光电集群', keys: ['optical', '光电', 'eo'] },
  { label: '雷达集群', keys: ['radar', '雷达', 'sar'] },
  { label: '电子集群', keys: ['electronic', '电子', 'ew', 'jammer'] },
  { label: '通信集群', keys: ['comm', '通信', 'relay'] },
]

/** 「信息包与协同状态」的 4 行（图上逐字；引擎没这些字段 → 留白 + 写原因）。 */
const COORD_ROWS = ['目标信息包生成状态', '远程火力协同状态', '空中支援接入状态', '链路稳定性']

/** 威胁标签：`hv` 标志 → 「高价值」；否则用 `threatBand` 的域（高/中/低 + 威胁二字）。 */
const BAND_CN: Record<string, string> = { high: '高', mid: '中', medium: '中', low: '低' }

function Section({ title, right, children, testid }: {
  title: ReactNode
  right?: ReactNode
  children: ReactNode
  testid?: string
}) {
  return (
    <div data-testid={testid} style={{ ...panel, width: '100%', boxSizing: 'border-box' }}>
      <div style={{ ...panelTitle, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>{title}</span>
        <span style={{ flex: 1 }} />
        {right !== undefined && <span style={{ fontSize: 11, color: C.textDim }}>{right}</span>}
      </div>
      <div style={{ padding: '7px 12px 9px' }}>{children}</div>
    </div>
  )
}

/**
 * 本屏工具条的**版式**（键位/顺序逐字照参考图 `场景1\T5-2.png`）。
 *
 * 图上是「选择 / 测距 / 图层 / 3D · 2D/3D」四格，这里**保持原顺序一个字不改**，
 * 只把「测面」插在「测距」后一格：map-2d 的量算本来就分"测距 + 测面"两档（M2-CTRL-10），
 * 规则包 key 同为 `measure`，而量算是用户本轮点名要接的能力（同类偏差已在 README 登记）。
 * 每一格**能不能点**不看这张表，一律由规则包 `view.compose` 的声明决定（VWC-TOOL-01/02）。
 */
const SH14_TOOLS = toolsOf(['select', 'measure', 'measureArea', 'layers', 'mode3d', 'reset'])

/** 一行「名 + 值」：值缺失显示"—"，**不补 0**；`miss` 写明为什么缺。 */
function Row({ k, v, color, miss, testid }: {
  k: string
  v?: string
  color?: string
  miss?: string
  testid?: string
}) {
  return (
    <div data-testid={testid} style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 12 }}>
      <span style={{ color: C.textDim, flex: 1, minWidth: 0 }}>{k}</span>
      <span style={{ color: v ? (color ?? C.text) : C.textDim, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
        {v ?? '—'}
      </span>
      {!v && miss && <span style={{ fontSize: 10.5, color: C.textDim, flex: '0 0 auto' }}>{miss}</span>}
    </div>
  )
}

/** 本屏在地图上画了什么（`__sh14Stats.map` 的读数；纯只读，不改渲染）。 */
function mapCounts() {
  const labels = MapDraw.list('label')
  const symbols = MapDraw.list('symbol')
  const routes = MapDraw.list('route')
  const ipLabels = labels.filter((l) => l.id.startsWith(IP_PREFIX))
  const ipSymbols = symbols.filter((s) => s.id.startsWith(IP_PREFIX))
  const ipDrawn = [
    ...ipLabels.map((l) => ({ id: l.id, kind: 'label' as const, lng: l.lng, lat: l.lat, text: l.text })),
    ...ipSymbols.map((s) => ({ id: s.id, kind: 'symbol' as const, lng: s.lng, lat: s.lat, text: s.label ?? '' })),
  ]
  const map = getMapInstance(DEFAULT_INSTANCE_ID)
  const b = map?.getBounds()
  const inside = (lng: number, lat: number) => !!b
    && lng >= b.getWest() && lng <= b.getEast() && lat >= b.getSouth() && lat <= b.getNorth()
  return {
    ipPoints: ipLabels.length + ipSymbols.length,
    targetMarks: labels.filter((l) => l.id.startsWith(TGT_PREFIX)).length + symbols.filter((s) => s.id.startsWith(TGT_PREFIX)).length,
    guideLinks: routes.filter((r) => r.id.startsWith(GL_PREFIX)).length,
    hostRoutes: routes.filter((r) => r.id.startsWith(RT_PREFIX)).length,
    routeTotal: routes.length,
    ipDrawn,
    viewport: map ? { lng: map.getCenter().lng, lat: map.getCenter().lat, zoom: map.getZoom() } : null,
    ipInView: ipDrawn.filter((p) => inside(p.lng, p.lat)).length,
  }
}

export function StrikeConfirmScreen({ state, flow, selectedPlanId, onSelectPlan, onBack, onGo, goto }: {
  state: FlowState
  flow: UseFlow
  /** 步 8 带过来的方案（本屏也能改；改了会重发 `guidance.plan{planId}`） */
  selectedPlanId: string | null
  onSelectPlan: (id: string) => void
  /** 回步 8（切步一律发 `flow.goto`）——【调整方案】 */
  onBack: () => void
  /** 切到另一屏（只改本地屏路由）—— SH-14 → SH-15 */
  onGo?: (id: string) => void
  /** 走流程（步号归宿主）：【生成打击任务】= strike.confirm → step 10 */
  goto?: (step: number) => void
}) {
  // ---- 进屏发一次打击方案（挑 planId 用；幂等）----
  const plans = useVerbOnce(flow, 'strike.plans', { count: 3 }, true)
  const pv = useMemo(() => readStrikePlans(plans.data), [plans.data])
  const plan = pv.plans.find((p) => p.id === selectedPlanId)
    ?? pv.plans.find((p) => p.id === pv.recommendedId)
    ?? pv.plans.find((p) => p.recommended)
    ?? pv.plans[0]

  // ---- `guidance.plan{planId}`：**几何与引擎时间轴的唯一权威** ----
  const guidance = useVerbOnce(flow, 'guidance.plan', plan ? { planId: plan.id } : {}, !!plan)
  const gv: GuidanceView = useMemo(() => readGuidance(guidance.data), [guidance.data])
  /**
   * 换方案 → **重发** `guidance.plan`（几何/引导连线/引擎时间轴跟着换）。
   *
   * 为什么要显式 resend：`useVerbOnce` 只在 `enabled` 由 false→true 时发一次（见其实现），
   * 光改 params 不会重发；首帧由它自己发（这里 `lastRef` 为空时只记不重发，避免重复读）。
   */
  const lastPlanRef = useRef<string | null>(null)
  const guidanceResend = guidance.resend
  useEffect(() => {
    const id = plan?.id ?? null
    if (!id) return
    if (lastPlanRef.current === null) { lastPlanRef.current = id; return }
    if (lastPlanRef.current === id) return
    lastPlanRef.current = id
    guidanceResend()
  }, [plan?.id, guidanceResend])

  // ---- 目标清单（`targets.list`；坐标不从这里取——几何权威是 guidance.plan）----
  const targets = useVerbOnce(flow, 'targets.list', {}, true)
  const tv = useMemo(() => readTargets(targets.data), [targets.data])

  // ---- 显示模式：问 view-composer（不写死业务文案）----
  const compose = useVerbOnce(flow, 'view.compose', {}, true)
  const cmp = readCompose(compose.data)
  // 工具可用性：一律以规则包 `view.compose` 的声明为准（VWC-TOOL-01/02）——前端不自己判"该不该能用"
  const mt = useMapToolState(flow)

  // ---- 语音文案（AI确认建议）：`config.json` 的 `flow.labels` 的 `voice.sh14.advice` ----
  const labels = useLabels()
  const advice = voiceLine(labels, 'sh14', 'advice')

  /**
   * 目标清单：**按威胁降序**（`hv` 标志优先 → `threatScore` 降序 → `threatBand` 档位 → 编号升序）。
   * 只排序、不改值 —— 屏上的每个数都是回执里的原值。
   */
  const sortedTargets = useMemo(() => {
    const rank = (b?: string) => (b === 'high' ? 3 : b === 'mid' || b === 'medium' ? 2 : b === 'low' ? 1 : 0)
    return [...tv.items].sort((a, b) => {
      const ah = (a.raw as { flags?: unknown }).flags
      const bh = (b.raw as { flags?: unknown }).flags
      const aHv = Array.isArray(ah) && ah.includes('hv') ? 1 : 0
      const bHv = Array.isArray(bh) && bh.includes('hv') ? 1 : 0
      if (aHv !== bHv) return bHv - aHv
      const as = a.threatScore ?? -1
      const bs = b.threatScore ?? -1
      if (as !== bs) return bs - as
      const ar = rank(a.threat)
      const br = rank(b.threat)
      if (ar !== br) return br - ar
      return (a.no ?? 0) - (b.no ?? 0)
    })
  }, [tv.items])

  // ---- 打击窗口（`strike.window{entityId}`）：窗口剩余取它的 `remainingMs` ----
  const strikeTarget = sortedTargets[0]
  const [winReply, setWinReply] = useState<CommandReply | null>(null)
  const [winBusy, setWinBusy] = useState(false)
  const send = flow.send
  const winReqRef = useRef<string | null>(null)
  useEffect(() => {
    const token = strikeTarget?.entityId ?? ''
    if (!token) { winReqRef.current = null; setWinReply(null); return }
    winReqRef.current = token
    setWinBusy(true)
    void send('strike.window', { entityId: token })
      .then((r) => { if (winReqRef.current === token) setWinReply(r) })
      .catch((e: unknown) => {
        if (winReqRef.current === token) {
          setWinReply({ code: -1, verb: 'strike.window', error: { message: String((e as Error)?.message ?? e) } })
        }
      })
      .finally(() => { if (winReqRef.current === token) setWinBusy(false) })
  }, [strikeTarget?.entityId, send])

  const wv = useMemo(() => readStrikeWindow(winReply?.data), [winReply?.data])
  // 宿主若把窗口读数塞在 guidance.plan 的 `window` 子对象里，也读（**只在显式子对象里读**，不乱猜）
  const winSub = useMemo(() => obj(gv.raw, 'window'), [gv.raw])
  const wv2 = useMemo(() => (winSub ? readStrikeWindow(winSub) : null), [winSub])
  const remainingMs = wv.remainingMs ?? wv2?.remainingMs
  const remainingFrom = wv.remainingMs !== undefined ? 'strike.window.remainingMs' : (wv2?.remainingMs !== undefined ? 'guidance.plan.window.remainingMs' : '')

  // ---------------- 地图叠加（只用 MapDraw 公共 API，不碰 MapStage） ----------------
  const drawnRef = useRef<{ kind: PrimitiveKind; id: string }[]>([])
  useEffect(() => {
    const prev = drawnRef.current
    const next: { kind: PrimitiveKind; id: string }[] = []
    MapDraw.batch(() => {
      for (const d of prev) MapDraw.remove(d.kind, d.id)

      // ① IP 点：宿主给了国军标符号键就画 symbol，否则画 label（都只画宿主给的经纬度）
      for (const p of gv.points) {
        const id = `${IP_PREFIX}${p.id}`
        if (p.symbol) {
          MapDraw.add('symbol', {
            id, lng: p.lng, lat: p.lat, symbol: p.symbol,
            affiliation: p.affiliation, label: p.name, color: C.accent,
          })
        } else {
          MapDraw.add('label', {
            id, lng: p.lng, lat: p.lat, text: p.name ?? p.id,
            color: C.accent, size: 12, radius: 5,
          })
        }
        next.push({ kind: p.symbol ? 'symbol' : 'label', id })
      }

      // ② 打击目标点（宿主给了坐标才画；红色 = 与 IP 点区分）
      if (gv.target) {
        const id = `${TGT_PREFIX}${gv.target.id}`
        MapDraw.add('label', {
          id, lng: gv.target.lng, lat: gv.target.lat,
          text: gv.target.name ?? gv.target.id, color: C.bad, size: 12, radius: 4,
        })
        next.push({ kind: 'label', id })
      }

      // ③ 引导连线 + 宿主给的航线：`route` 整类替换（这一类只有本屏用，不会碰到 MapStage）
      MapDraw.set('route', [
        ...gv.links.filter((l) => l.resolved).map((l) => ({
          id: `${GL_PREFIX}${l.id}`, points: l.points, color: C.accent, dashed: true, name: l.name ?? l.id,
        })),
        ...gv.routes.map((r) => ({
          id: `${RT_PREFIX}${r.id}`, points: r.points, color: C.warn, dashed: false, name: r.name ?? r.id,
        })),
      ])
    })
    drawnRef.current = next
    return () => {
      // 离开本屏（或换方案）时把本屏的图元清干净，绝不留残影
      const mine = drawnRef.current
      MapDraw.batch(() => {
        for (const d of mine) MapDraw.remove(d.kind, d.id)
        MapDraw.set('route', [])
      })
      drawnRef.current = []
    }
  }, [gv])

  // ---------------- 【生成打击任务】`strike.confirm{planId}`（1003 才补 adopt，回执逐条留下） ----------------
  const [busy, setBusy] = useState(false)
  const [adoptReply, setAdoptReply] = useState<CommandReply | null>(null)
  const [confirmReply, setConfirmReply] = useState<CommandReply | null>(null)
  const ar = readReceipt(adoptReply?.data)
  const cr = readReceipt(confirmReply?.data)

  /**
   * 命令序：**先 `strike.confirm`**；只有引擎说"前置未满足"（1003）才补 `strike.adopt` 再重试一次
   * （实测 adopt 会把流程切回步 8 —— 在本屏无条件先发 adopt 会把操作员踢回上一步）。
   * 两条回执都留在屏幕上：顺序与失败原因照抄，不美化。
   * 成功（code=0）后：`goto?.(10)`（宿主落步）+ `onGo('SH-15')`（本地切屏）。
   */
  const onConfirm = async () => {
    if (busy || !plan) return
    setBusy(true)
    try {
      const id = plan.id
      let c = await flow.send('strike.confirm', { planId: id })
      setConfirmReply(c)
      if (c.code === 1003) {
        const a = await flow.send('strike.adopt', { planId: id })
        setAdoptReply(a)
        if (a.code === 0) {
          c = await flow.send('strike.confirm', { planId: id })
          setConfirmReply(c)
        }
      }
      if (c.code === 0) {
        goto?.(10)
        onGo?.('SH-15')
      }
    } finally {
      setBusy(false)
    }
  }
  const confirmedOk = confirmReply?.code === 0

  /** 资源调度：把图上那 4 行按语义去 `guidance.groups[]` 里认领（名字含关键词 或 成员 model 命中）。 */
  const resRow = (keys: string[]) => gv.clusters.find((c) => {
    const n = c.name.toLowerCase()
    if (keys.some((k) => n.includes(k.toLowerCase()))) return true
    return c.members.some((m) => keys.some((k) => (m.model ?? '').toLowerCase() === k.toLowerCase()))
  })

  return (
    <div data-testid="sh-14" data-screen="SH-14" style={wrap}>
      {/* 左上：地图工具栏（共享实现，真能点；坐标相对本屏浮层容器 `wrap`，故 left/top 归 0） */}
      <MapToolbar testid="sh14-toolbar" items={SH14_TOOLS} state={mt} style={{ left: 0, top: 0 }} />
      <ToolModeNote state={mt} items={SH14_TOOLS} />
      <div data-testid="sh14-mode" style={{ ...modePill, right: RAIL_W + 12 }}>
        <span style={{ color: C.textDim }}>显示模式：</span>
        <span style={{ color: C.text }}>{cmp.modeName ?? cmp.modeKey ?? '打击确认'}</span>
        <span style={{ color: C.textDim }}>⌄</span>
      </div>

      {/* ---------------- 中区下部：目标清单 + 打击窗口时间轴 + 两按钮 ---------------- */}
      <div data-testid="sh14-bottom" style={bottomRegion}>
        <div style={{ display: 'flex', gap: 10, height: 182, minHeight: 0 }}>
          {/* ① 目标清单（图上 3 行；条数多时本卡内滚动，**不裁剪数据**） */}
          <div data-testid="sh14-targets" style={{ ...panel, flex: '0 0 38%', minWidth: 300, display: 'flex', flexDirection: 'column' }}>
            <div style={{ ...panelTitle, padding: '7px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>目标清单</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 11, color: C.textDim }}>
                {targets.reply === null ? '读取中…' : `targets.list：${tv.items.length} 条 · 威胁降序`}
              </span>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 10px 8px' }}>
              {sortedTargets.map((t, i) => <TargetRowItem key={t.entityId} t={t} index={i} />)}
              {tv.items.length === 0 && (
                <div data-testid="sh14-targets-empty" style={missLine}>
                  目标台账为空 / 未就绪
                  {targets.reply && targets.reply.code !== 0 && <div style={{ color: C.warn }}>{replyText(targets.reply)}</div>}
                </div>
              )}
            </div>
          </div>

          {/* ② 打击窗口时间轴 */}
          <div data-testid="sh14-timeline" style={{ ...panel, flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ ...panelTitle, padding: '7px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>打击窗口时间轴</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 12, color: C.textDim }}>窗口剩余</span>
              <span
                data-testid="sh14-window-remaining"
                data-source={remainingFrom}
                title={remainingFrom ? `取自 ${remainingFrom}` : '回执未给该字段'}
                style={{ fontSize: 14, color: remainingMs !== undefined ? C.accent : C.textDim, fontVariantNumeric: 'tabular-nums' }}
              >
                {remainingMs !== undefined ? ms2clock(remainingMs) : '—'}
              </span>
            </div>
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '8px 12px 6px' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
                {IMAGE_SEGS.map((s, i) => (
                  <div key={s.t} data-testid="sh14-seg" data-seg-time={s.t} data-seg-label={s.label}
                    style={{
                      flex: '1 1 0', minWidth: 0, borderRadius: 8, padding: '6px 8px',
                      border: `1px solid ${i === 0 ? 'rgba(34,197,94,.7)' : C.border}`,
                      background: i === 0 ? 'rgba(34,197,94,.14)' : 'rgba(10,32,58,.6)',
                    }}>
                    {/* 段名逐字照图（「T+00 信息包生成」是一个整体） */}
                    <div data-testid="sh14-seg-label" style={{ fontSize: 12, color: C.text }}>
                      <span style={{ color: C.accent, fontVariantNumeric: 'tabular-nums' }}>{s.t}</span> {s.label}
                    </div>
                    {/* 时刻位：**没有引擎来源 → 一律"—"**（前端不编时刻） */}
                    <div data-testid="sh14-seg-time" data-time-source="none"
                      title="时刻值没有引擎来源（§9-9 待裁决）：引擎给的是 t0/到达/打击/评估"
                      style={{ fontSize: 11, color: C.textDim, marginTop: 2 }}>
                      时刻 <span style={{ color: C.textDim }}>—</span>
                      <span style={{ fontSize: 10 }}>（回执未给该字段）</span>
                    </div>
                  </div>
                ))}
              </div>
              {/* 图上那条节点进度线（绿实心 → 蓝实心 → 蓝环 → 灰空心），只为照图，不承载数值 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 2px 4px' }}>
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={nodeDot(i)} />
                    {i < 3 && <span style={{ flex: 1, height: 1, background: i === 0 ? C.ok : i === 1 ? C.accent : 'rgba(148,163,184,.5)' }} />}
                  </div>
                ))}
              </div>
              <div data-testid="sh14-timeline-note" style={{ fontSize: 10.5, color: C.warn, lineHeight: 1.5 }}>
                图上段名按参考图；引擎给的是 t0/到达/打击/评估（§9-9 待裁决）→ 时刻位一律留"—"（前端不编时刻）。
              </div>
              {/* 引擎自己的四段（**真实时刻 + basis**，原样摆出，不冒充图上的段名） */}
              <div data-testid="sh14-engine-timeline" style={{ fontSize: 10.5, color: C.textDim, lineHeight: 1.5 }}>
                {gv.timeline.length > 0
                  ? <>引擎时间轴（guidance.plan）：{gv.timeline.map((s) => `${s.label} ${s.tText}${s.at ? `（${shortTime(s.at)}）` : ''}`).join(' · ')}</>
                  : (guidance.reply === null
                    ? '正在读取 guidance.plan 的引擎时间轴…'
                    : `引擎时间轴未就绪${guidance.reply.code !== 0 ? `：${replyText(guidance.reply)}` : '（回执未给 timeline）'}`)}
              </div>
            </div>
          </div>
        </div>

        {/* 回执：宿主回了什么就显示什么（含 planState / unmet / 逐条叶子字段） */}
        {(adoptReply || confirmReply) && (
          <div data-testid="sh14-receipt" style={{ fontSize: 11, lineHeight: 1.6, marginTop: 6 }}>
            {[{ v: 'strike.adopt', r: adoptReply, view: ar }, { v: 'strike.confirm', r: confirmReply, view: cr }].map(({ v, r, view }) => (
              <div key={v} data-testid={`receipt-${v}`} style={{ color: r?.code === 0 ? C.ok : C.bad }}>
                {v} → code={r?.code ?? '—'}
                {view.planState ? ` · planState=${view.planState}` : ''}
                {view.idempotent ? ' · 幂等' : ''}
                {view.toStep !== undefined ? ` · 宿主推进到步 ${view.toStep}` : ''}
                {view.unmet.length > 0 ? ` · 未满足：${view.unmet.join('、')}` : ''}
                {r && r.code !== 0 ? `：${replyText(r)}` : ''}
                {view.pairs.length > 0 && (
                  <details style={{ display: 'inline-block', marginLeft: 6 }}>
                    <summary style={{ fontSize: 10, color: C.textDim, cursor: 'pointer', display: 'inline' }}>逐条（{view.pairs.length}）</summary>
                    <span style={{ display: 'block', fontSize: 10, color: C.textDim }}>
                      {view.pairs.slice(0, 16).map((p, i) => <span key={i}>{p.path}=<span style={{ color: C.text }}>{p.value}</span>{'  '}</span>)}
                    </span>
                  </details>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ③ 两按钮（图上逐字）*/}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, height: 44 }}>
          <span style={{ fontSize: 11.5, color: C.textDim }}>
            方案 <span data-testid="confirm-current-plan" style={{ color: C.accent }}>{plan?.name ?? '—'}</span>
            {plan?.id ? `（${plan.id}）` : ''}
            {plan?.successRate !== undefined ? ` · 成功率预估 ${n2s(plan.successRate)}%` : ''}
            {plan?.plannedFinish ? ` · 预计完成 ${plan.plannedFinish.text}` : ''}
          </span>
          <span style={{ flex: 1 }} />
          {/* 方案切换：改 planId 会重发 guidance.plan（几何与引擎时间轴随之重取） */}
          {pv.plans.length > 1 && (
            <div data-testid="confirm-plan-switch" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, color: C.textDim }}>切换方案</span>
              {pv.plans.map((p) => (
                <button
                  key={p.id}
                  data-testid="confirm-plan-tab"
                  data-plan-id={p.id}
                  data-plan-recommended={p.recommended ? '1' : '0'}
                  onClick={() => onSelectPlan(p.id)}
                  title={p.recommended ? '引擎推荐方案（recommendedId / recommendedHint）' : undefined}
                  style={{
                    padding: '3px 9px', fontSize: 11, cursor: 'pointer', borderRadius: 6, whiteSpace: 'nowrap',
                    color: p.id === plan?.id ? '#eaf4ff' : C.text,
                    border: `1px solid ${p.recommended ? 'rgba(34,197,94,.8)' : p.id === plan?.id ? C.borderStrong : C.border}`,
                    background: p.id === plan?.id ? 'rgba(29,78,216,.45)' : 'rgba(10,32,58,.55)',
                  }}
                >{p.name}{p.recommended ? ' ★' : ''}</button>
              ))}
            </div>
          )}
          <button data-testid="btn-strike-back" style={ghostBtn} onClick={onBack}>调整方案</button>
          <button
            data-testid="btn-strike-confirm"
            style={busy || !plan ? confirmDisabled : confirmBtn}
            disabled={busy || !plan}
            title="确认方案并生成打击任务信息包（`strike.confirm{planId}`；1003 时补 `strike.adopt` 后重试一次）"
            onClick={() => void onConfirm()}
          >{busy ? '生成中…' : '生成打击任务'}</button>
          {confirmedOk && <span data-testid="confirm-done-flag" style={{ fontSize: 12, color: C.ok }}>已下发</span>}
        </div>
      </div>

      {/* ---------------- 右栏 3 面板 ---------------- */}
      <div style={railCol}>
        {/* ① 资源调度情况 */}
        <Section
          title="资源调度情况"
          right={guidance.reply === null ? '读取中…' : guidance.reply.code === 0 ? 'guidance.plan' : '未就绪'}
          testid="sh14-resource"
        >
          {RES_ROWS.map((r) => {
            const c = resRow(r.keys)
            const state = c
              ? (c.resolved === false
                ? '未编入'
                : c.members.length > 0 ? `已编入 ${c.members.length} 个平台` : '已编入（成员未列出）')
              : undefined
            return (
              <div key={r.label} data-testid="sh14-res-row" data-cluster={c?.key ?? ''}
                style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '4px 0', fontSize: 12 }}>
                <span style={{ color: C.text, width: 62, flex: '0 0 auto' }}>{r.label}：</span>
                <span
                  data-testid="sh14-res-state"
                  data-source={state ? 'guidance.plan' : ''}
                  title={c ? `guidance.plan 的集群「${c.name}」（按名称/成员机型语义认领；resolved=${String(c.resolved)}）` : '回执未给该字段'}
                  style={{
                    flex: 1, minWidth: 0, color: state ? C.ok : C.textDim, lineHeight: 1.5,
                  }}
                >
                  {state ?? '—'}
                  {!state && <span style={{ fontSize: 10, color: C.textDim }}>（回执未给该字段）</span>}
                </span>
              </div>
            )
          })}
          <div style={{ fontSize: 10.5, color: C.textDim, lineHeight: 1.6, marginTop: 3 }}>
            {gv.clusters.length > 0
              ? <>图上那 4 个"状态词"（持续跟踪/位置校正/压制待命/链路中继）**引擎没有对应字段** → 这里只如实显示
                `guidance.groups[]` 能对上的编入情况（声明 {n2s(gv.clustersDeclared)} / 匹配 {n2s(gv.clustersMatched)} /
                编入平台 {n2s(gv.membersTotal ?? gv.clusters.reduce((a, c) => a + c.members.length, 0))}）。</>
              : 'guidance.plan 未返回集群调度段（groups[]）'}
            {gv.clusterNote && <div>口径：{gv.clusterNote}</div>}
            {c1Reason(gv)}
          </div>
        </Section>

        {/* ② 信息包与协同状态 */}
        <Section title="信息包与协同状态" right="guidance.plan / strike.*" testid="sh14-coord">
          {COORD_ROWS.map((k) => (
            <Row key={k} k={k} v={undefined} miss="回执未给该字段" testid="sh14-coord-row" />
          ))}
          <div style={{ fontSize: 10.5, color: C.textDim, lineHeight: 1.6, marginTop: 3 }}>
            图上这 4 行（92% / 已接入 / 待确认 / 稳定）在全工程只有 `config.json` 的语音文案里出现过对应词，
            **引擎与规则包都没有这些字段** → 一律留"—"（MUST NOT 抄图上的数）。
          </div>
          {(gv.metrics.length > 0 || wv.metrics.length > 0) && (
            <div style={{ marginTop: 5, borderTop: `1px solid ${C.border}`, paddingTop: 4 }}>
              <div style={{ fontSize: 10.5, color: C.textDim, marginBottom: 2 }}>引擎给的读数（原样）</div>
              {[...gv.metrics, ...wv.metrics].slice(0, 8).map((m) => (
                <Row key={m.key} k={m.name} v={m.value !== undefined ? n2s(m.value, m.unit ?? '') : (m.text ?? undefined)} />
              ))}
            </div>
          )}
          {wv.durationMs !== undefined && (
            <Row k="窗口时长" v={`${n2s(wv.durationMs)} ms`} miss="（strike.window.durationMs）" />
          )}
          {wv.optimalAt && <Row k="最优时刻" v={wv.optimalAt} />}
          {remainingMs === undefined && winReply && winReply.code !== 0 && (
            <div style={{ fontSize: 10.5, color: C.warn, lineHeight: 1.5 }}>strike.window → {replyText(winReply)}</div>
          )}
        </Section>

        {/* ③ AI确认建议（文案取 `voice.sh14.advice`） */}
        <Section title="AI确认建议" right="voice.sh14.advice" testid="sh14-advice">
          {advice
            ? (
              <div data-testid="sh14-advice-text" style={{ fontSize: 12, color: C.text, lineHeight: 1.7 }}>
                {advice}
                <div style={{ fontSize: 10.5, color: C.textDim, marginTop: 3 }}>
                  来源：`config.json` 的 `flow.labels`（配置文案，不是引擎结论）
                </div>
              </div>
            )
            : (
              <div data-testid="sh14-advice-missing" style={{ fontSize: 11.5, color: C.warn, lineHeight: 1.7 }}>
                未配置 —— `flow.labels` 缺 `voice.sh14.advice`（源码里没有中文兜底）
              </div>
            )}
          {gv.advice.length > 0 && (
            <div style={{ marginTop: 5, borderTop: `1px solid ${C.border}`, paddingTop: 4 }}>
              <div style={{ fontSize: 10.5, color: C.textDim, marginBottom: 2 }}>引擎建议（guidance.plan.advice）</div>
              {gv.advice.slice(0, 4).map((t, i) => (
                <div key={i} data-testid="sh14-engine-advice" style={{ fontSize: 11.5, color: C.text, lineHeight: 1.65 }}>· {t}</div>
              ))}
            </div>
          )}
          {gv.notes.slice(0, 2).map((t, i) => (
            <div key={i} style={{ fontSize: 10.5, color: C.textDim, lineHeight: 1.5, marginTop: 3 }}>· {t}</div>
          ))}
          {gv.unresolved.length > 0 && (
            <div data-testid="sh14-unresolved" style={{ fontSize: 10.5, color: C.warn, lineHeight: 1.5, marginTop: 3 }}>
              {gv.unresolved.slice(0, 3).map((t, i) => <div key={i}>· {t}</div>)}
            </div>
          )}
          <button
            data-testid="sh14-locate-ip"
            onClick={() => { const p = gv.points[0]; if (p) mapCommands.setView(p.lng, p.lat) }}
            disabled={gv.points.length === 0}
            title={gv.points.length ? '把镜头移到宿主给的 IP 点坐标（只改视角，不算几何）' : '宿主未给 IP 点几何'}
            style={gv.points.length ? locateBtn : locateDisabled}
          >定位到 IP 点（镜头移到宿主给的坐标）</button>
        </Section>
      </div>

      <ConfirmProbe
        step={state.step}
        phase={state.phase}
        gRaw={guidance.data}
        gReply={guidance.reply}
        gv={gv}
        planId={plan?.id ?? null}
        planName={plan?.name ?? null}
        targets={sortedTargets}
        winReply={winReply}
        remainingMs={remainingMs ?? null}
        remainingFrom={remainingFrom}
        adoptReply={adoptReply}
        confirmReply={confirmReply}
      />
    </div>
  )
}

/** 集群未编入的原因（有就摆一行原话）。 */
function c1Reason(gv: GuidanceView): ReactNode {
  const miss = gv.clusters.filter((c) => c.resolved === false)
  if (miss.length === 0) return null
  return (
    <div style={{ color: C.warn }}>
      {miss.slice(0, 2).map((c) => `${c.name}：${c.reason ?? '未编入（回执未给原因）'}`).join('；')}
    </div>
  )
}

/** 目标清单的一行（菱形序号 + 编号 + 类型 + 威胁标签 + 优先级）——值全部来自 `targets.list`。 */
function TargetRowItem({ t, index }: { t: TargetRow; index: number }) {
  const flags = Array.isArray((t.raw as { flags?: unknown }).flags) ? ((t.raw as { flags: string[] }).flags) : []
  const hv = flags.includes('hv')
  const band = t.threat
  const bandCN = band ? (BAND_CN[band.toLowerCase()] ?? band) : undefined
  const tag = hv ? '高价值' : bandCN ? `${bandCN}威胁` : '—'
  const tagStyle = hv
    ? { border: '1px solid rgba(239,68,68,.75)', color: '#ffb4ab' }
    : band?.toLowerCase() === 'high'
      ? { border: '1px solid rgba(239,68,68,.55)', color: '#ffb4ab' }
      : band?.toLowerCase() === 'mid' || band?.toLowerCase() === 'medium'
        ? { border: '1px solid rgba(245,158,11,.55)', color: '#fcd34d' }
        : band?.toLowerCase() === 'low'
          ? { border: '1px solid rgba(34,197,94,.55)', color: '#86efac' }
          : { border: `1px solid ${C.border}`, color: C.textDim }
  const no = t.no !== undefined ? `目标${String(t.no).padStart(3, '0')}` : t.entityId
  return (
    <div
      data-testid="sh14-target-row"
      data-entity-id={t.entityId}
      data-hv={hv ? '1' : '0'}
      data-band={band ?? ''}
      data-priority={t.priority !== undefined ? String(t.priority) : ''}
      style={{
        display: 'flex', gap: 7, alignItems: 'center', padding: '5px 8px', marginBottom: 4,
        border: `1px solid ${index === 0 ? C.borderStrong : C.border}`, borderRadius: 6,
        background: index === 0 ? 'rgba(29,78,216,.28)' : 'rgba(10,32,58,.5)',
      }}
    >
      <span style={diamond}>{index + 1}</span>
      <span style={{ fontSize: 12.5, color: C.text, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {no} ｜ {t.typeName ?? t.typeKey ?? '—'}
      </span>
      <span data-testid="sh14-target-tag" data-band={band ?? ''} style={{ ...tagChip, ...tagStyle }}>{tag}</span>
      <span style={{ flex: 1 }} />
      <span style={{ fontSize: 11.5, color: C.textDim }}>
        优先级 {t.priority !== undefined ? n2s(t.priority) : '—'}
      </span>
      {t.threatScore !== undefined && (
        <span style={{ fontSize: 10.5, color: C.textDim }} title="threatScore（台账）">威胁分 {n2s(t.threatScore)}</span>
      )}
    </div>
  )
}

/** 节点进度线的圆点（纯照图：绿实心 / 蓝实心 / 蓝环 / 灰空心）。 */
function nodeDot(i: number): CSSProperties {
  if (i === 0) return { width: 11, height: 11, borderRadius: '50%', background: C.ok, flex: '0 0 auto' }
  if (i === 1) return { width: 11, height: 11, borderRadius: '50%', background: C.accent, flex: '0 0 auto' }
  if (i === 2) return { width: 11, height: 11, borderRadius: '50%', background: 'transparent', border: `2px solid ${C.accent}`, flex: '0 0 auto' }
  return { width: 11, height: 11, borderRadius: '50%', background: 'transparent', border: '2px solid rgba(148,163,184,.65)', flex: '0 0 auto' }
}

/** 自证句柄 `__sh14Stats`（并保留旧键 `__p5Stats` 的 map/guidance 段；**只读**）。 */
function ConfirmProbe(props: {
  step: number
  phase: string
  gRaw: unknown
  gReply: CommandReply | null
  gv: GuidanceView
  planId: string | null
  planName: string | null
  targets: TargetRow[]
  winReply: CommandReply | null
  remainingMs: number | null
  remainingFrom: string
  adoptReply: CommandReply | null
  confirmReply: CommandReply | null
}) {
  const { step, phase, gRaw, gReply, gv, planId, planName, targets, winReply, remainingMs, remainingFrom, adoptReply, confirmReply } = props
  const counts = mapCounts()
  const stats = {
    screen: 'SH-14',
    step,
    phase,
    planId,
    planName,
    targets: targets.map((t) => ({
      entityId: t.entityId, no: t.no ?? null, typeName: t.typeName ?? null,
      typeKey: t.typeKey ?? null, threatBand: t.threat ?? null, threatScore: t.threatScore ?? null,
      priority: t.priority ?? null, flags: (t.raw as { flags?: string[] }).flags ?? [],
    })),
    window: {
      reply: winReply,
      remainingMs,
      remainingFrom,
      /** 图上写的 08:42 是示意值；界面只显示回执给的那个数（前端不做本地倒计时） */
      clockShown: remainingMs !== null ? ms2clock(remainingMs) : null,
    },
    guidance: {
      reply: gReply,
      raw: gRaw ?? null,
      planId: gv.planId ?? null,
      pointCount: gv.points.length,
      linkCount: gv.links.length,
      resolvedLinks: gv.links.filter((l) => l.resolved).length,
      routeCount: gv.routes.length,
      timeline: gv.timeline.map((s) => ({ key: s.key, label: s.label, tText: s.tText, at: s.at ?? null, basis: s.basis ?? null })),
      clusters: gv.clusters.map((c) => ({ key: c.key, name: c.name, resolved: c.resolved ?? null, members: c.members.length, reason: c.reason ?? null })),
      advice: gv.advice,
      unresolved: gv.unresolved,
    },
    confirm: { adoptReply, confirmReply, adoptView: readReceipt(adoptReply?.data), confirmView: readReceipt(confirmReply?.data) },
    map: counts,
    dom: {
      targetRows: document.querySelectorAll('[data-testid="sh14-target-row"]').length,
      segs: document.querySelectorAll('[data-testid="sh14-seg"]').length,
      resRows: document.querySelectorAll('[data-testid="sh14-res-row"]').length,
      coordRows: document.querySelectorAll('[data-testid="sh14-coord-row"]').length,
      windowText: document.querySelector('[data-testid="sh14-window-remaining"]')?.textContent ?? null,
      hasConfirmBtn: !!document.querySelector('[data-testid="btn-strike-confirm"]'),
      hasBackBtn: !!document.querySelector('[data-testid="btn-strike-back"]'),
      advice: document.querySelector('[data-testid="sh14-advice-text"]')?.textContent ?? null,
    },
  }
  const w = window as unknown as Record<string, unknown>
  w.__sh14Stats = stats
  w.__p5Stats = { ...((w.__p5Stats as Record<string, unknown> | undefined) ?? {}), ...stats }
  w.__p5Read = { ...((w.__p5Read as Record<string, unknown> | undefined) ?? {}), map: counts, mapCounts }
  return null
}

// ---- 样式（一律 left/right/top/bottom 长写：**不写 inset 简写**，见 App.tsx 的踩坑注释）----
const RAIL_W = 306
const wrap: CSSProperties = {
  position: 'absolute', left: 12, right: 12, top: 34, bottom: 12, zIndex: 20,
}
const modePill: CSSProperties = {
  position: 'absolute', top: 0, zIndex: 22, display: 'flex', gap: 6, alignItems: 'center',
  padding: '7px 12px', borderRadius: 999, fontSize: 12.5,
  background: 'rgba(6,26,47,.86)', border: `1px solid ${C.border}`,
}
const bottomRegion: CSSProperties = {
  position: 'absolute', left: 0, right: RAIL_W + 12, bottom: 26, zIndex: 21,
  display: 'flex', flexDirection: 'column', minHeight: 0,
}
const railCol: CSSProperties = {
  position: 'absolute', right: 0, top: 44, bottom: 26, width: RAIL_W, zIndex: 21,
  display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
}
const missLine: CSSProperties = { fontSize: 11.5, color: C.textDim, lineHeight: 1.7 }
const diamond: CSSProperties = {
  width: 16, height: 16, flex: '0 0 auto', transform: 'rotate(45deg)', borderRadius: 3,
  border: `1px solid ${C.borderStrong}`, background: 'rgba(95,176,255,.18)',
  fontSize: 10, lineHeight: '15px', textAlign: 'center', color: C.text,
}
const tagChip: CSSProperties = {
  fontSize: 10.5, borderRadius: 4, padding: '0 5px', flex: '0 0 auto', lineHeight: '16px',
}
const confirmBtn: CSSProperties = {
  padding: '10px 26px', fontSize: 14, cursor: 'pointer', borderRadius: 8, whiteSpace: 'nowrap',
  letterSpacing: 1, border: '1px solid rgba(95,176,255,.7)',
  background: 'linear-gradient(180deg,#2563eb,#1d4ed8)', color: '#eaf4ff',
}
const ghostBtn: CSSProperties = {
  padding: '10px 20px', fontSize: 13.5, cursor: 'pointer', borderRadius: 8, whiteSpace: 'nowrap',
  background: 'rgba(10,20,36,.75)', border: `1px solid ${C.borderStrong}`, color: C.text,
}
const confirmDisabled: CSSProperties = {
  padding: '10px 26px', fontSize: 14, cursor: 'default', borderRadius: 8, whiteSpace: 'nowrap',
  letterSpacing: 1, background: 'rgba(10,20,36,.5)', border: `1px solid ${C.border}`, color: C.unknown,
}
const locateDisabled: CSSProperties = {
  width: '100%', marginTop: 6, padding: '5px 8px', fontSize: 11.5, cursor: 'default',
  borderRadius: 6, background: 'rgba(10,20,36,.5)', border: `1px solid ${C.border}`, color: C.unknown,
}
const locateBtn: CSSProperties = {
  width: '100%', marginTop: 6, padding: '5px 8px', fontSize: 11.5, cursor: 'pointer',
  borderRadius: 6, background: 'rgba(10,20,36,.7)', border: `1px solid ${C.borderStrong}`, color: C.text,
}

export default StrikeConfirmScreen
