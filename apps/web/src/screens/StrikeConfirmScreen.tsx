// mission-app · apps/web/src/screens/StrikeConfirmScreen.tsx
//
// Excel 步 9 · 打击方案确认（参考图 `T5-2.png`）。
//
// 它是**覆盖层**：底下的 `MapStage` 照常跑（地图、无人机、航迹由它自己画），本文件往地图上补：
//   · **地图叠加**：IP 点（`MapDraw.add('label'|'symbol', …)`）+ 引导连线
//     （`MapDraw.set('route', [{id,points:[…]}])`）+ 宿主给的评估航线；颜色/线宽用 `theme.ts` 令牌。
//   · 左栏：目标清单（`targets.list`）+ 引导点清单（逐点列出 `guidance.plan` 给的经纬高）
//   · 下中：**打击窗口时间轴**（`guidance.plan` 的时间轴：t0/到达/打击/评估）——每段都把
//     `basis`（这个时刻怎么算出来的）摆在时刻旁边，那是"不编数"的证据
//   · 右栏：协同与信息包状态 + AI 确认建议 + 命令回执（`strike.adopt` / `strike.confirm`）
//   · 底栏：【调整方案】→ 步 8 · 【确认打击】`strike.confirm{planId}`
//
// ★ 纪律（这一屏最容易犯的四个错）：
//   ① **坐标一律取 `guidance.plan` 的返回值**：不插值、不算中点、不做投影、不拿 targets.list
//      的坐标凑。宿主只给了键引用（`attackStart.key=ip-c-west`）而没给几何时 → **不画**，
//      并在界面上如实写"未给几何 → 不画（前端不编坐标）"。
//   ② **不改 MapStage**：本屏只用 `MapDraw` 的公共 API，并且只碰 `label`(加自己的 id 前缀)/
//      `symbol`/`route` 三类；`route` 整类只有本屏用，卸载时清干净（不留残影）。
//   ③ **不做本地倒计时**：窗口剩余就是宿主给的数（连字段名一起标）。前端每秒减一 = 编数。
//   ④ 拿不到的字段写"— / 未就绪 + code"：`guidance.plan` 没装配时，时间轴与地图叠加**都不画**，
//      只显示宿主原话 + code。
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { DEFAULT_INSTANCE_ID, getMapInstance, MapDraw, mapCommands, type PrimitiveKind } from 'map-2d'
import { C, panel, panelTitle } from '../theme'
import type { CommandReply, FlowState } from '../api'
import type { UseFlow } from '../flow/useFlow'
import { n2s, obj, readCompose, replyText, useVerbOnce } from '../flow/useSituation'
import { readTargets } from '../flow/useOps'
import {
  readGuidance, readReceipt, readStrikePlans, readStrikeWindow, segMatches, shortTime,
  TIMELINE_ORDER, type GuidanceView, type TimelineSeg,
} from '../flow/useStrike'
import { VerbVerdict } from './VerbVerdict'
import { StageStrip } from './StageOverlay'

// 图元 id 前缀：**只用来认领本屏画的东西**（清理与计数都靠它；MapStage 的图元一个都不碰）
const IP_PREFIX = 'IP:'
const TGT_PREFIX = 'TGT:'
const GL_PREFIX = 'GL:'   // 引导连线
const RT_PREFIX = 'RT:'   // 宿主给的航线（评估航线等）

/** 一行「名 + 值」：值缺失显示"—"，**不补 0**。 */
function Row({ k, v, color, testid }: { k: string; v: string; color?: string; testid?: string }) {
  return (
    <div data-testid={testid} style={{ display: 'flex', gap: 8, padding: '2px 0', fontSize: 12 }}>
      <span style={{ color: C.textDim, width: 84, flex: '0 0 auto' }}>{k}</span>
      <span style={{ color: color ?? C.text, minWidth: 0, wordBreak: 'break-word' }}>{v}</span>
    </div>
  )
}

function Section({ title, children, testid }: { title: React.ReactNode; children: React.ReactNode; testid?: string }) {
  return (
    <div data-testid={testid} style={{ ...panel, width: '100%', boxSizing: 'border-box' }}>
      <div style={panelTitle}>{title}</div>
      <div style={{ padding: '7px 12px 9px' }}>{children}</div>
    </div>
  )
}

/** 一个点的经纬高显示（**原样位数**，四舍五入到 5 位；缺一个就"—"）。 */
function geoText(p: { lng?: number; lat?: number; altM?: number }): string {
  const ll = p.lng !== undefined && p.lat !== undefined ? `${p.lat.toFixed(5)}N ${p.lng.toFixed(5)}E` : '—'
  return p.altM !== undefined ? `${ll} · 高 ${n2s(p.altM)} m` : ll
}

/** 时间轴一段（T5-2 中部那条 T+00 → T+03 → …）。 */
function SegCard({ seg, index, active }: { seg: TimelineSeg; index: number; active: boolean }) {
  // 主时刻：宿主给了相对分钟就用 `T+mm`，否则用绝对时刻的**短形式**（`22:46:04`，纯字符串截取）；
  // 完整的宿主原文（`atText`/`atMs`）永远摆在下一行，谁也改不掉。
  const primary = seg.minutes !== undefined ? seg.tText : shortTime(seg.at)
  return (
    <div
      data-testid="timeline-seg"
      data-seg-key={seg.key}
      data-seg-label={seg.label}
      data-seg-minutes={seg.minutes !== undefined ? String(seg.minutes) : ''}
      data-seg-time-key={seg.timeKey ?? ''}
      data-seg-time-text={seg.tText}
      data-seg-basis={seg.basis ?? ''}
      title={[seg.label, seg.tText, seg.basis, seg.note].filter(Boolean).join('\n')}
      style={{
        flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2,
        border: `1px solid ${active ? C.borderStrong : C.border}`, borderRadius: 8,
        background: active ? 'rgba(29,78,216,.28)' : 'rgba(10,32,58,.6)', padding: '6px 8px',
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
        <span style={{ width: 12, height: 12, borderRadius: '50%', flex: '0 0 auto', marginTop: 2, background: active ? C.accent : 'rgba(95,176,255,.35)', border: `1px solid ${C.border}` }} />
        <span data-testid="timeline-seg-time" style={{ fontSize: 14, color: C.accent, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{primary}</span>
        <span style={{ fontSize: 10.5, color: C.textDim }}>#{index + 1}</span>
      </div>
      <div data-testid="timeline-seg-label" style={{ fontSize: 11.5, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{seg.label}</div>
      {/* 宿主给的原文时刻与字段名（相对时刻用 T+mm 时，这里把原时刻也摆出来） */}
      {seg.at && (
        <div style={{ fontSize: 9.5, color: C.textDim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {seg.at}{seg.timeKey ? `（${seg.timeKey}）` : ''}
        </div>
      )}
      {/* ↓ 这一段"怎么算出来的"：宿主原话，缺了就说缺（MUST NOT 自己推一个） */}
      <div
        data-testid="timeline-seg-basis"
        style={{
          fontSize: 10, lineHeight: 1.45, color: seg.basis ? C.textDim : C.warn,
          wordBreak: 'break-word', maxHeight: 44, overflow: 'hidden',
        }}
      >
        {seg.basis ? `${seg.basisKey ?? 'basis'}：${seg.basis}` : '宿主未给出推算依据（basis）'}
      </div>
      {/* 公式的输入（宿主给的数，原样列出来——"不编数"的实证） */}
      {seg.basisInputs.length > 0 && (
        <div data-testid="timeline-seg-inputs" style={{ fontSize: 9.5, color: C.textDim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {seg.basisInputs.slice(0, 4).map((p) => `${p.path}=${p.value}`).join(' · ')}
        </div>
      )}
      {seg.note && (
        <div data-testid="timeline-seg-note" style={{ fontSize: 9.5, color: C.warn, lineHeight: 1.4, maxHeight: 28, overflow: 'hidden' }}>{seg.note}</div>
      )}
      {seg.metrics.slice(0, 2).map((m) => (
        <div key={m.key} style={{ fontSize: 10, color: C.textDim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {m.name} <span style={{ color: C.text }}>{m.value !== undefined ? n2s(m.value, m.unit ?? '') : (m.text ?? '—')}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * 本屏在地图上画了什么（`__p5Read.map` 的读数；纯只读，不改渲染）。
 *
 * 除了"画了几件"，还报**是否落在当前视口内**：实测踩过一次"图元在 MapDraw 里、
 * 但相机不在这片地方 → 截图上看不见"。`inView` 就是把这件事变成可断言的值
 * （只读相机与图元，不动镜头）。
 */
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
  // 相机与视口（只读：拿 maplibre 实例的 bounds 判断"看不看得见"）
  const map = getMapInstance(DEFAULT_INSTANCE_ID)
  const b = map?.getBounds()
  const inside = (lng: number, lat: number) => !!b
    && lng >= b.getWest() && lng <= b.getEast() && lat >= b.getSouth() && lat <= b.getNorth()
  return {
    /** 本屏画的 IP 点（label + symbol 两种画法加起来） */
    ipPoints: ipLabels.length + ipSymbols.length,
    ipLabels: ipLabels.length,
    ipSymbols: ipSymbols.length,
    targetMarks: labels.filter((l) => l.id.startsWith(TGT_PREFIX)).length + symbols.filter((s) => s.id.startsWith(TGT_PREFIX)).length,
    /** 引导连线条数（前缀 GL:） */
    guideLinks: routes.filter((r) => r.id.startsWith(GL_PREFIX)).length,
    /** 宿主给的航线（评估航线等） */
    hostRoutes: routes.filter((r) => r.id.startsWith(RT_PREFIX)).length,
    /** 整袋大小（含 MapStage 的静态标注与区域，便于分辨"是谁画的"） */
    routeTotal: routes.length,
    labelTotal: labels.length,
    symbolTotal: symbols.length,
    /** 逐点坐标：脚本用它与 `guidance.plan` 回执**逐位对账**（证明坐标不是前端编的） */
    ipDrawn,
    routesDrawn: routes.map((r) => ({ id: r.id, points: r.points })),
    /** 视口读数：中心/缩放 + 我画的点是否落在可见范围内 */
    viewport: map
      ? {
        lng: map.getCenter().lng, lat: map.getCenter().lat, zoom: map.getZoom(),
        bounds: b ? [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] : null,
      }
      : null,
    ipInView: ipDrawn.filter((p) => inside(p.lng, p.lat)).length,
    routePointsInView: routes.reduce((a, r) => a + r.points.filter((p) => inside(p[0], p[1])).length, 0),
    ids: {
      labels: labels.map((l) => l.id),
      symbols: symbols.map((s) => s.id),
      routes: routes.map((r) => r.id),
    },
  }
}

export function StrikeConfirmScreen({ state, flow, selectedPlanId, onSelectPlan, onBack }: {
  state: FlowState
  flow: UseFlow
  /** 步 8 带过来的方案（本屏也能改；改了会重发 `guidance.plan{planId}`） */
  selectedPlanId: string | null
  onSelectPlan: (id: string) => void
  /** 回步 8（切步一律发 `flow.goto`） */
  onBack: () => void
}) {
  // ---- 进屏发一次打击方案（挑 planId 用；幂等）----
  const plans = useVerbOnce(flow, 'strike.plans', { count: 3 }, true)
  const pv = useMemo(() => readStrikePlans(plans.data), [plans.data])
  const plan = pv.plans.find((p) => p.id === selectedPlanId)
    ?? pv.plans.find((p) => p.id === pv.recommendedId)
    ?? pv.plans.find((p) => p.recommended)
    ?? pv.plans[0]

  // ---- `guidance.plan{planId}`：**几何与时间轴的唯一权威** ----
  // `useVerbOnce` 在 enabled 从 false→true 时发一次，所以等 planId 到手才发（不发空参数）。
  const guidance = useVerbOnce(flow, 'guidance.plan', plan ? { planId: plan.id } : {}, !!plan)
  const gv: GuidanceView = useMemo(() => readGuidance(guidance.data), [guidance.data])

  // 目标清单（只用于显示"打谁"；**坐标不从这里取**——几何权威是 guidance.plan）
  const targets = useVerbOnce(flow, 'targets.list', {}, true)
  const tv = useMemo(() => readTargets(targets.data), [targets.data])

  // 显示模式：问 view-composer（**不写死"打击确认"这种业务文案**——模式名由引擎给）
  const compose = useVerbOnce(flow, 'view.compose', { phase: state.phase || 'T5' }, true)
  const cmp = readCompose(compose.data)

  // 宿主若在 guidance.plan 里带了窗口读数就显示（**只在显式 `window` 子对象里读**，不乱猜）
  const winSub = useMemo(() => obj(gv.raw, 'window'), [gv.raw])
  const wv = useMemo(() => (winSub ? readStrikeWindow(winSub) : null), [winSub])

  // ---------------- 地图叠加（只用 MapDraw 公共 API，不碰 MapStage） ----------------
  const drawnRef = useRef<{ kind: PrimitiveKind; id: string }[]>([])
  useEffect(() => {
    const prev = drawnRef.current
    const next: { kind: PrimitiveKind; id: string }[] = []
    MapDraw.batch(() => {
      for (const d of prev) MapDraw.remove(d.kind, d.id)

      // ① IP 点：宿主给了国军标符号键就画 symbol，否则画 label（都能画在经纬度上）
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
          id: `${GL_PREFIX}${l.id}`,
          points: l.points,
          color: C.accent,
          dashed: true,
          name: l.name ?? l.id,
        })),
        ...gv.routes.map((r) => ({
          id: `${RT_PREFIX}${r.id}`,
          points: r.points,
          color: C.warn,
          dashed: false,
          name: r.name ?? r.id,
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

  // ---------------- 【确认打击】`strike.confirm{planId}`（先确认；1003 才补 adopt，回执逐条留下） ----------------
  const [busy, setBusy] = useState(false)
  const [adoptReply, setAdoptReply] = useState<CommandReply | null>(null)
  const [confirmReply, setConfirmReply] = useState<CommandReply | null>(null)
  const ar = readReceipt(adoptReply?.data)
  const cr = readReceipt(confirmReply?.data)

  /**
   * 【确认打击】的命令序：**先 `strike.confirm`**，只有引擎说"前置未满足"才补 `strike.adopt`。
   *
   * 为什么不是"先 adopt 再 confirm"（步 5 的 `alloc.*` 是那个顺序）：
   *   实测 `strike.adopt` 会把流程切回**步 8**（它是步 8 的动作），而 `strike.confirm` 落在步 9。
   *   在本屏无条件先发 adopt，会把操作员从这个屏踢回上一步。
   *   而 scoring 的 `confirmPrecondition=reject-if-not-adopted`（未采纳直接确认 → `1003` +
   *   `data.unmet=["not-adopted"]`）依然要照顾，所以走"**先确认；1003 才补采纳并重试一次**"。
   *   两条回执都留在屏幕上——顺序与失败原因照抄，不美化、也不因为第一条失败就闷掉第二条。
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
    } finally {
      setBusy(false)
    }
  }
  const confirmedOk = confirmReply?.code === 0

  /**
   * 契约四段是否都在（t0/到达/打击/评估）——界面自己先对一遍，缺哪段就摆出来。
   * 段键按**别名表**认（宿主用 `arrival` 还是 `arrive` 都算"到达"），中文名再兜一层。
   */
  const CANON_CN: Record<string, RegExp> = {
    t0: /t0|信息包|下达|进入当前阶段|阶段进入/i,
    arrive: /到达|arrive|arrival|reach/i,
    strike: /打击|strike|attack|命中/i,
    assess: /评估|assess|evaluat/i,
  }
  const missingSegs = TIMELINE_ORDER.filter((k) => !gv.timeline.some((s) => segMatches(s.key, k) || CANON_CN[k].test(`${s.key} ${s.label}`)))

  return (
    <>
      {/* ---------------- 顶部压条 ---------------- */}
      <StageStrip
        items={[
          { k: '显示模式', v: cmp.modeName ?? cmp.modeKey ?? '—', color: C.accent },
          { k: '阶段', v: state.phase || '—' },
          { k: '当前方案', v: plan?.name ?? '—' },
          { k: 'IP 点', v: `${gv.points.length} 个`, color: gv.points.length ? C.text : C.warn },
          { k: '引导连线', v: `${gv.links.filter((l) => l.resolved).length} 条`, color: gv.links.some((l) => l.resolved) ? C.text : C.warn },
          { k: '时间轴', v: `${gv.timeline.length} 段`, color: gv.timeline.length ? C.text : C.warn },
        ]}
        right={<span style={{ color: guidance.reply?.code === 0 ? C.textDim : C.warn }}>
          {guidance.reply === null
            ? '引导方案读取中…'
            : guidance.reply.code === 0
              ? `guidance.plan 已就绪（planId=${gv.planId ?? plan?.id ?? '—'}）`
              : `guidance.plan：${replyText(guidance.reply)}`}
        </span>}
      />

      {/* ---------------- 左：目标清单 + 引导点清单 ---------------- */}
      <div style={leftColStyle}>
        <Section
          title={<span>目标清单<span style={{ float: 'right', fontSize: 11.5, color: C.textDim }}>targets.list</span></span>}
          testid="strike-confirm-targets"
        >
          <div style={{ maxHeight: 132, overflowY: 'auto' }}>
            {tv.items.map((t) => (
              <div key={t.entityId} data-testid="confirm-target-row" data-entity-id={t.entityId} style={targetRowStyle}>
                <span style={{ fontSize: 11, color: C.textDim }}>{t.no !== undefined ? `#${t.no}` : t.entityId}</span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
                {t.threat && <span style={{ fontSize: 11, color: C.textDim }}>{t.threat}</span>}
              </div>
            ))}
            {tv.items.length === 0 && (
              <div style={{ fontSize: 11.5, color: C.textDim, lineHeight: 1.7 }}>
                目标台账为空 / 未就绪
                {targets.reply && targets.reply.code !== 0 ? <div style={{ color: C.warn }}>{replyText(targets.reply)}</div> : null}
              </div>
            )}
          </div>
        </Section>

        <Section
          title={<span>引导点（IP）<span style={{ float: 'right', fontSize: 11.5, color: C.textDim }}>guidance.plan</span></span>}
          testid="strike-ip-panel"
        >
          {/* 定位按钮：**只把镜头挪到宿主给的坐标上**（不改数据、不缩放、不算任何几何）。
              相机默认停在 MapStage 的初始视角，打击区有时不在屏内 —— 给操作员一个一键定位。 */}
          {gv.points.length > 0 && (
            <button
              data-testid="btn-locate-ip"
              onClick={() => {
                const p = gv.points[0]
                if (p) mapCommands.setView(p.lng, p.lat)
              }}
              style={{
                width: '100%', marginBottom: 5, padding: '4px 8px', fontSize: 11.5, cursor: 'pointer',
                borderRadius: 6, background: 'rgba(10,20,36,.7)', border: `1px solid ${C.borderStrong}`, color: C.text,
              }}
            >定位到 IP 点（镜头移到宿主给的坐标）</button>
          )}
          {gv.points.map((p) => (
            <div key={p.id} data-testid="strike-ip-row" data-ip-id={p.id} data-ip-symbol={p.symbol ?? ''} style={{ padding: '3px 0', borderBottom: '1px solid rgba(95,176,255,.10)' }}>
              <div style={{ fontSize: 12, color: C.text }}>{p.name ?? p.id}</div>
              <div data-testid="strike-ip-geo" style={{ fontSize: 11, color: C.textDim, fontVariantNumeric: 'tabular-nums' }}>
                {geoText(p)}{p.symbol ? ` · 符号 ${p.symbol}` : ''}{p.altM !== undefined ? '' : ' · 未给高度'}
              </div>
              {p.kind && <div style={{ fontSize: 10.5, color: C.textDim }}>类型 {p.kind}</div>}
            </div>
          ))}
          {gv.points.length === 0 && (
            <div data-testid="strike-ip-empty" style={{ fontSize: 11.5, color: C.textDim, lineHeight: 1.7 }}>
              `guidance.plan` 未给出带经纬度的 IP 点 → 地图上**不画**（前端不编坐标）
              {guidance.reply && guidance.reply.code !== 0 ? <div style={{ color: C.warn }}>{replyText(guidance.reply)}</div> : null}
            </div>
          )}
          {gv.target && (
            <div style={{ marginTop: 5, borderTop: `1px solid ${C.border}`, paddingTop: 4 }}>
              <div style={{ fontSize: 11.5, color: C.bad }}>打击目标：{gv.target.name ?? gv.target.id}</div>
              <div style={{ fontSize: 11, color: C.textDim, fontVariantNumeric: 'tabular-nums' }}>{geoText(gv.target)}</div>
            </div>
          )}
          {/* 宿主给了但**画不出来**的项：如实摆出来（不画，也不编） */}
          {gv.unresolved.length > 0 && (
            <div data-testid="strike-unresolved" style={{ marginTop: 5, fontSize: 10.5, color: C.warn, lineHeight: 1.6 }}>
              {gv.unresolved.slice(0, 4).map((t, i) => <div key={i}>· {t}</div>)}
            </div>
          )}
        </Section>

        <VerbVerdict
          rows={[
            { verb: 'guidance.plan', reply: guidance.reply, busy: guidance.busy, onRetry: guidance.resend, okNote: `${gv.points.length} 点 / ${gv.links.filter((l) => l.resolved).length} 线 / ${gv.timeline.length} 段` },
            { verb: 'strike.plans', reply: plans.reply, busy: plans.busy, onRetry: plans.resend, okNote: `${pv.plans.length} 个方案` },
            { verb: 'view.compose', reply: compose.reply, busy: compose.busy, onRetry: compose.resend },
          ]}
        />
      </div>

      {/* ---------------- 右：协同状态 + AI 建议 + 回执 ---------------- */}
      <div style={rightColStyle}>
        <Section title="资源调度情况" testid="strike-coord-panel">
          {/* 逐集群的编入结果（实测 `guidance.groups[]`）：resolved=false 的**把原因照抄** */}
          {gv.clusters.map((c) => (
            <div key={c.key} data-testid="cluster-row" data-resolved={c.resolved === undefined ? '' : c.resolved ? '1' : '0'}
              data-member-count={c.members.length}
              style={{ padding: '3px 0', borderBottom: '1px solid rgba(95,176,255,.10)' }}>
              <div style={{ display: 'flex', gap: 8, fontSize: 11.5 }}>
                <span style={{ flex: 1, minWidth: 0, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                <span style={{ color: c.resolved ? C.ok : C.warn }}>
                  {c.resolved === undefined ? '—' : `${c.members.length} 个平台`}
                </span>
              </div>
              {/* 编入的平台（台账实体；名字来自宿主，界面**不画**它们——画平台是 MapStage 的事） */}
              {c.members.length > 0 && (
                <div data-testid="cluster-members" style={{ fontSize: 10.5, color: C.textDim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {c.members.slice(0, 4).map((m) => m.name).join(' / ')}{c.members.length > 4 ? ` …共 ${c.members.length} 个` : ''}
                </div>
              )}
              {c.leader && <div style={{ fontSize: 10.5, color: C.textDim }}>领机 {c.leader}</div>}
              {!c.resolved && c.reason && <div style={{ fontSize: 10.5, color: C.textDim, lineHeight: 1.5 }}>{c.reason}</div>}
            </div>
          ))}
          {gv.clusters.length > 0 && (
            <div data-testid="cluster-summary" style={{ fontSize: 10.5, color: C.textDim, marginTop: 3, lineHeight: 1.5 }}>
              声明 {n2s(gv.clustersDeclared)} 个集群 / 匹配 {n2s(gv.clustersMatched)} 个 /
              编入平台 {n2s(gv.membersTotal ?? gv.clusters.reduce((a, c) => a + c.members.length, 0))}
              {gv.membersTotal !== undefined ? '（membersTotal）' : '（逐集群计数）'}
              {gv.clusterNote ? <div>口径：{gv.clusterNote}</div> : null}
            </div>
          )}
          {wv && (
            <div style={{ marginTop: 5, borderTop: `1px solid ${C.border}`, paddingTop: 4 }}>
              <Row k="窗口剩余" v={wv.remainingMs !== undefined ? `${n2s(wv.remainingMs)} ms（window.remainingMs）` : '—'} color={wv.remainingMs !== undefined ? C.accent : C.textDim} testid="confirm-window-remaining" />
              <Row k="窗口时长" v={wv.durationMs !== undefined ? `${n2s(wv.durationMs)} ms（window.durationMs）` : '—'} />
              <Row k="最优时刻" v={wv.optimalAt ?? '—'} />
            </div>
          )}
          {wv?.metrics.slice(0, 6).map((m) => (
            <Row key={m.key} k={m.name} v={m.value !== undefined ? n2s(m.value, m.unit ?? '') : (m.text ?? '—')} />
          ))}
          {gv.metrics.slice(0, 8).map((m) => (
            <Row key={m.key} k={m.name} v={m.value !== undefined ? n2s(m.value, m.unit ?? '') : (m.text ?? '—')} />
          ))}
          {/* 引导连线逐条列出（实测一次给 10 条，铺开会把面板撑爆 → 默认折叠，条数与来源仍可见） */}
          {gv.links.length > 0 && (
            <details data-testid="guidance-links" style={{ marginTop: 4 }}>
              <summary style={{ fontSize: 11, color: C.textDim, cursor: 'pointer' }}>
                引导连线 {gv.links.length} 条（已画在地图上；点击展开逐条来源）
              </summary>
              <div style={{ maxHeight: 120, overflowY: 'auto', marginTop: 3 }}>
                {gv.links.map((l) => (
                  <Row
                    key={l.id}
                    k={l.id}
                    v={`${l.fromId ?? '?'} → ${l.toId ?? '?'}${l.resolved ? '' : ' · 未给几何（不画）'}`}
                    color={l.resolved ? C.textDim : C.warn}
                  />
                ))}
              </div>
            </details>
          )}
          {gv.routes.map((r) => (
            <Row key={r.id} k="评估航线" v={`${r.name ?? r.id}（${r.points.length} 航点，已画在地图上）`} color={C.textDim} />
          ))}
          {!wv && gv.metrics.length === 0 && gv.links.length === 0 && gv.clusters.length === 0 && (
            <div style={{ fontSize: 11.5, color: C.textDim, lineHeight: 1.7 }}>
              协同/信息包读数未就绪：`guidance.plan` 未返回本屏可显示的字段（界面不补数）
            </div>
          )}
          {gv.pairs.length > 0 && (
            <details data-testid="guidance-raw-pairs" style={{ marginTop: 5 }}>
              <summary style={{ fontSize: 10.5, color: C.textDim, cursor: 'pointer' }}>
                guidance.plan 回执全部字段（{gv.pairs.length} 项，原样）
              </summary>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px', marginTop: 3, maxHeight: 96, overflowY: 'auto' }}>
                {gv.pairs.slice(0, 30).map((p, i) => (
                  <span key={i} style={{ fontSize: 10, color: C.textDim }}>{p.path}=<span style={{ color: C.text }}>{p.value}</span></span>
                ))}
              </div>
            </details>
          )}
        </Section>

        <Section title="AI 确认建议" testid="strike-advice-panel">
          {gv.advice.length > 0
            ? gv.advice.slice(0, 4).map((t, i) => (
              <div key={i} data-testid="confirm-advice" style={{ fontSize: 11.5, color: C.text, lineHeight: 1.7 }}>· {t}</div>
            ))
            : <div style={{ fontSize: 11.5, color: C.textDim }}>宿主未给出确认建议</div>}
          {gv.notes.slice(0, 3).map((t, i) => (
            <div key={i} style={{ fontSize: 11, color: C.textDim, lineHeight: 1.55, marginTop: 3 }}>· {t}</div>
          ))}
        </Section>

        <VerbVerdict
          title="打击命令回执"
          rows={[
            { verb: 'strike.adopt', reply: adoptReply, busy, okNote: `planState=${ar.planState ?? '—'}${ar.idempotent ? ' · 幂等' : ''}` },
            { verb: 'strike.confirm', reply: confirmReply, busy: busy && !!adoptReply, okNote: `planState=${cr.planState ?? '—'}${cr.idempotent ? ' · 幂等' : ''}${cr.toStep !== undefined ? ` · → 步 ${cr.toStep}` : ''}` },
            { verb: 'targets.list', reply: targets.reply, busy: targets.busy, onRetry: targets.resend, okNote: `${tv.items.length} 个目标` },
          ]}
        />

        {/* 回执逐条：宿主回了什么就显示什么（含 code / planState / unmet / 每个叶子字段） */}
        {(adoptReply || confirmReply) && (
          <Section title="确认回执明细（逐条）" testid="strike-confirm-receipt">
            {[{ v: 'strike.adopt', r: adoptReply, view: ar }, { v: 'strike.confirm', r: confirmReply, view: cr }].map(({ v, r, view }) => (
              <div key={v} data-testid={`receipt-${v}`} style={{ padding: '4px 0', borderBottom: '1px solid rgba(95,176,255,.12)' }}>
                <div style={{ fontSize: 11.5, color: r?.code === 0 ? C.ok : C.bad }}>
                  {v} → code={r?.code ?? '—'}{r && r.code !== 0 ? `：${replyText(r)}` : ''}
                </div>
                {view.planId && <div style={{ fontSize: 11, color: C.textDim }}>planId={view.planId}</div>}
                {view.planState && <div style={{ fontSize: 11, color: C.textDim }}>planState={view.planState}{view.idempotent ? ' · 幂等' : ''}{view.conflict ? ' · 互斥冲突' : ''}{view.deviated ? ' · 已偏离' : ''}</div>}
                {view.action && <div style={{ fontSize: 11, color: C.textDim }}>action={view.action}</div>}
                {view.toStep !== undefined && <div style={{ fontSize: 11, color: C.accent }}>宿主推进到步 {view.toStep}</div>}
                {view.phase && <div style={{ fontSize: 11, color: C.textDim }}>阶段 {view.phase}</div>}
                {view.message && <div style={{ fontSize: 11, color: C.textDim }}>{view.message}</div>}
                {view.unmet.length > 0 && <div style={{ fontSize: 11, color: C.warn }}>未满足：{view.unmet.join('、')}</div>}
                {view.invalidated.length > 0 && <div style={{ fontSize: 11, color: C.warn }}>已失效：{view.invalidated.join('、')}</div>}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px', marginTop: 2 }}>
                  {view.pairs.slice(0, 20).map((p, i) => (
                    <span key={i} style={{ fontSize: 10, color: C.textDim }}>{p.path}=<span style={{ color: C.text }}>{p.value}</span></span>
                  ))}
                </div>
              </div>
            ))}
            {confirmedOk && (
              <div data-testid="confirm-ok" style={{ fontSize: 11.5, color: C.ok, marginTop: 4 }}>
                打击已确认{cr.toStep !== undefined ? `，宿主推进到步 ${cr.toStep}` : '（步进由宿主决定，前端不自己改 step）'}
              </div>
            )}
          </Section>
        )}
      </div>

      {/* ---------------- 下中：打击窗口时间轴 ---------------- */}
      <div style={timelinePanelStyle}>
        <div style={{ ...panel, width: '100%', height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
          <div style={panelTitle}>
            打击窗口时间轴
            <span style={{ float: 'right', fontSize: 11.5, color: C.textDim }}>
              {guidance.reply?.code === 0
                ? `${gv.timeline.length} 段 · 来源 guidance.plan`
                : (guidance.reply ? `guidance.plan → ${replyText(guidance.reply)}` : '正在读取引导方案…')}
            </span>
          </div>
          <div data-testid="strike-timeline" style={{ flex: 1, minHeight: 0, display: 'flex', gap: 8, padding: '9px 12px 10px', overflowX: 'auto' }}>
            {gv.timeline.map((s, i) => <SegCard key={`${s.key}-${i}`} seg={s} index={i} active={i === 0} />)}
            {gv.timeline.length === 0 && (
              <div data-testid="timeline-empty" style={{ margin: 'auto', fontSize: 12, color: C.textDim, lineHeight: 1.8, textAlign: 'center' }}>
                <div>打击窗口时间轴未就绪：需要 `guidance.plan` 的时间轴（t0/到达/打击/评估）。</div>
                {guidance.reply && guidance.reply.code !== 0 && (
                  <div style={{ color: C.warn }}>guidance.plan → {replyText(guidance.reply)}</div>
                )}
              </div>
            )}
          </div>
          {gv.timeline.length > 0 && (gv.anchor?.text || gv.anchor?.source) && (
            <div data-testid="timeline-anchor" style={{ fontSize: 10.5, color: C.textDim, padding: '0 12px 6px', lineHeight: 1.5 }}>
              t0 锚点：{gv.anchor?.text ?? '—'}
              {gv.anchor?.kind || gv.anchor?.phaseKey ? `（${[gv.anchor?.kind, gv.anchor?.phaseKey].filter(Boolean).join(' · ')}）` : ''}
              {gv.anchor?.source ? ` · 来源 ${gv.anchor.source}` : ''}
            </div>
          )}
          {gv.timeline.length > 0 && missingSegs.length > 0 && (
            <div data-testid="timeline-missing" style={{ fontSize: 11, color: C.warn, padding: '0 12px 8px' }}>
              契约四段里缺：{missingSegs.join(' / ')}（界面按宿主给的实际段数显示，MUST NOT 补段）
            </div>
          )}
        </div>
      </div>

      {/* ---------------- 底：调整方案 / 确认打击 ---------------- */}
      <div style={bottomStyle}>
        <div style={{ ...panel, flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 14, padding: '0 14px', height: 46 }}>
          <span style={{ fontSize: 12, color: C.textDim }}>步 {state.step}/11</span>
          <span style={{ fontSize: 12.5, color: C.text }}>{state.stepTitle || state.stepKey}</span>
          <span style={{ fontSize: 12, color: C.textDim }}>方案</span>
          <span data-testid="confirm-current-plan" style={{ fontSize: 13, color: C.accent }}>{plan?.name ?? '—'}</span>
          <span style={{ fontSize: 12, color: C.textDim }}>协同 {plan?.coordinationCN ?? '—'}</span>
          <span style={{ fontSize: 12, color: C.textDim }}>
            预计完成 {plan?.plannedFinish?.text ?? '—'}
          </span>
          {confirmedOk && <span data-testid="confirm-done-flag" style={{ fontSize: 12, color: C.ok }}>已确认</span>}
        </div>
        <button data-testid="btn-strike-back" style={ghostBtn} onClick={onBack}>调整方案</button>
        <button
          data-testid="btn-strike-confirm"
          style={busy || !plan ? ghostDisabled : primaryBtn}
          disabled={busy || !plan}
          onClick={() => void onConfirm()}
        >{busy ? '确认中…' : confirmedOk ? '重新确认打击' : '确认打击'}</button>
      </div>

      {/* 方案切换：改 planId 会重发 `guidance.plan`（几何与时间轴随之重取） */}
      {pv.plans.length > 1 && (
        <div data-testid="confirm-plan-switch" style={planSwitchStyle}>
          <span style={{ fontSize: 11.5, color: C.textDim }}>方案</span>
          {pv.plans.map((p) => (
            <button
              key={p.id}
              data-testid="confirm-plan-tab"
              data-plan-id={p.id}
              data-plan-recommended={p.recommended ? '1' : '0'}
              onClick={() => onSelectPlan(p.id)}
              style={{
                padding: '3px 10px', fontSize: 11.5, cursor: 'pointer', borderRadius: 6, whiteSpace: 'nowrap',
                color: p.id === plan?.id ? '#eaf4ff' : C.text,
                border: `1px solid ${p.recommended ? 'rgba(95,176,255,.85)' : p.id === plan?.id ? C.borderStrong : C.border}`,
                background: p.id === plan?.id ? 'rgba(29,78,216,.45)' : 'rgba(10,32,58,.55)',
              }}
            >{p.name}{p.recommended ? ' ★' : ''}</button>
          ))}
        </div>
      )}

      <ConfirmProbe
        step={state.step}
        phase={state.phase}
        gRaw={guidance.data}
        gReply={guidance.reply}
        gv={gv}
        planId={plan?.id ?? null}
        planName={plan?.name ?? null}
        adoptReply={adoptReply}
        confirmReply={confirmReply}
        replies={flow.replies}
        lastReply={flow.lastReply}
      />
    </>
  )
}

/** 自证句柄：`__p5Stats`（本屏部分）+ `__p5Read.map`（地图图元计数，**只读**）。 */
function ConfirmProbe(props: {
  step: number
  phase: string
  gRaw: unknown
  gReply: CommandReply | null
  gv: GuidanceView
  planId: string | null
  planName: string | null
  adoptReply: CommandReply | null
  confirmReply: CommandReply | null
  /** 按 verb 留存的最近回执（`useFlow.replies`）——**切屏后仍读得到**，脚本据此断"按钮真的发过命令" */
  replies: Record<string, CommandReply>
  lastReply: CommandReply | null
}) {
  const { step, phase, gRaw, gReply, gv, planId, planName, adoptReply, confirmReply, replies, lastReply } = props
  const counts = mapCounts()
  const w = window as unknown as {
    __p5Stats?: Record<string, unknown>
    __p5Read?: Record<string, unknown>
  }
  w.__p5Stats = {
    ...(w.__p5Stats ?? {}),
    step,
    screen: 'strikeConfirm',
    phase,
    planId,
    planName,
    /** 按 verb 的最近回执（原样：verb/code/error） */
    replies: Object.fromEntries(Object.entries(replies ?? {}).map(([k, v]) => [k, { verb: v.verb, code: v.code, message: v.error?.message ?? null }])),
    guidance: {
      reply: gReply,
      raw: gRaw ?? null,
      pointCount: gv.points.length,
      linkCount: gv.links.length,
      resolvedLinks: gv.links.filter((l) => l.resolved).length,
      routeCount: gv.routes.length,
      timelineCount: gv.timeline.length,
      timelineKeys: gv.timeline.map((s) => s.key),
      timeline: gv.timeline.map((s) => ({ key: s.key, label: s.label, tText: s.tText, minutes: s.minutes ?? null, at: s.at ?? null, basis: s.basis ?? null, basisKey: s.basisKey ?? null })),
      /** 逐点坐标：**全部来自 guidance.plan**（脚本用它和 MapDraw 里的图元对数） */
      points: gv.points.map((p) => ({ id: p.id, name: p.name ?? null, lng: p.lng, lat: p.lat, altM: p.altM ?? null, symbol: p.symbol ?? null })),
      target: gv.target ? { id: gv.target.id, lng: gv.target.lng, lat: gv.target.lat, altM: gv.target.altM ?? null } : null,
      unresolved: gv.unresolved,
    },
    confirm: { adoptReply, confirmReply, adoptView: readReceipt(adoptReply?.data), confirmView: readReceipt(confirmReply?.data) },
    /** 地图图元计数（**只读**；MapDraw 的快照，不改渲染） */
    map: counts,
    lastReply: lastReply ? { verb: lastReply.verb, code: lastReply.code, message: lastReply.error?.message ?? null } : null,
    dom: {
      timelineSegs: document.querySelectorAll('[data-testid="timeline-seg"]').length,
      timelineBasisShown: Array.from(document.querySelectorAll('[data-testid="timeline-seg-basis"]'))
        .filter((el) => !(el.textContent ?? '').includes('未给出推算依据')).length,
      ipRows: document.querySelectorAll('[data-testid="strike-ip-row"]').length,
      targetRows: document.querySelectorAll('[data-testid="confirm-target-row"]').length,
      clusterRows: document.querySelectorAll('[data-testid="cluster-row"]').length,
      hasConfirmBtn: !!document.querySelector('[data-testid="btn-strike-confirm"]'),
      hasBackBtn: !!document.querySelector('[data-testid="btn-strike-back"]'),
      hasUnresolvedNote: !!document.querySelector('[data-testid="strike-unresolved"]'),
      timelineEmpty: !!document.querySelector('[data-testid="timeline-empty"]'),
      ipEmpty: !!document.querySelector('[data-testid="strike-ip-empty"]'),
      /** 本屏**渲染那一刻**的确认回执文本（切屏后仍读得到这一份快照） */
      confirmReceiptText: document.querySelector('[data-testid="receipt-strike.confirm"]')?.textContent ?? null,
      hasConfirmDone: !!document.querySelector('[data-testid="confirm-done-flag"]'),
    },
  }
  // 把地图图元计数挂到**只读排障句柄** `__p5Read` 上（验收脚本读它，不改 MapStage）
  w.__p5Read = { ...(w.__p5Read ?? {}), map: counts, mapCounts }
  return null
}

// ---- 样式（一律 left/right/bottom 长写：**不写 inset 简写**，见 App.tsx 的踩坑注释）----
const leftColStyle: CSSProperties = {
  position: 'absolute', left: 12, top: 34, bottom: 240, zIndex: 20, width: 246,
  display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
}
const rightColStyle: CSSProperties = {
  position: 'absolute', right: 12, top: 34, bottom: 240, zIndex: 20, width: 292,
  display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
}
const timelinePanelStyle: CSSProperties = {
  position: 'absolute', left: 270, right: 316, bottom: 58, zIndex: 21, height: 172,
}
const bottomStyle: CSSProperties = {
  position: 'absolute', left: 12, right: 12, bottom: 6, zIndex: 21,
  display: 'flex', alignItems: 'center', gap: 10, height: 46,
}
const planSwitchStyle: CSSProperties = {
  position: 'absolute', left: 270, right: 316, top: 34, zIndex: 21,
  display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap',
  background: 'rgba(4,24,47,.72)', border: `1px solid ${C.border}`, borderRadius: 8, padding: '5px 9px',
}
const targetRowStyle: CSSProperties = {
  display: 'flex', gap: 7, alignItems: 'baseline', padding: '4px 7px', marginBottom: 4,
  border: `1px solid ${C.border}`, borderRadius: 6, background: 'rgba(10,32,58,.5)',
}
const primaryBtn: CSSProperties = {
  padding: '11px 24px', fontSize: 14, cursor: 'pointer', borderRadius: 8, whiteSpace: 'nowrap',
  letterSpacing: 1, border: '1px solid rgba(34,197,94,.6)',
  background: 'linear-gradient(180deg,#16a34a,#15803d)', color: '#eafff2',
}
const ghostBtn: CSSProperties = {
  padding: '11px 18px', fontSize: 13.5, cursor: 'pointer', borderRadius: 8, whiteSpace: 'nowrap',
  background: 'rgba(10,20,36,.75)', border: `1px solid ${C.borderStrong}`, color: C.text,
}
const ghostDisabled: CSSProperties = {
  padding: '11px 18px', fontSize: 13.5, cursor: 'default', borderRadius: 8, whiteSpace: 'nowrap',
  background: 'rgba(10,20,36,.5)', border: `1px solid ${C.border}`, color: C.unknown,
}

export default StrikeConfirmScreen
