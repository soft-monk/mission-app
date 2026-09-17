// mission-app · apps/web/src/screens/SummaryScreen.tsx
//
// **SH-18 任务总结界面（参考图 `场景1\T7-2.png`）**
//
// 版式（照图）：顶部压条 ｜ 中区上 3/5 地图（App 的 MapStage，本屏只摆浮层）
//   ｜ 地图下部通栏：**3 张指标卡（目标清除 / 覆盖区域 / 协同效率）** + 「报告生成」进度行
//   + **3 个状态标签（信息包已推送 / 残余风险低 / 链路待释放）** + **3 个按钮**
//   （返回场景选择 / 导出任务报告 / 快速脱离体系）｜ 右栏 3 面板（AI摘要 / 关键结果 / 后续处置）
//   ｜ 左栏：报告时间轴 / 预警次数 / 报告 JSON（需求专篇 §7「报告面板较全」→ 保留，按图补新块）
//
// 数据面（只读为主，两条动作）：
//   · `report.generate{}` —— 报告文档（`document.groups[].fields[]`：**字段名与数值一律以回执为准**）
//     + phase-engine 的 `durations`（逐阶段耗时）+ alert-engine 的 `counts`（预警次数）
//   · `targets.list` / `sensor.status` / `topology.evaluate` —— 指标卡在报告缺字段时的**台账回落**
//     （回落一律在卡面写明来源，不换算、不折算）
//   · 【导出任务报告】= 把**报告 JSON** 复制 + 展开（**不做文件下载、不谎报 PDF**）
//   · 【返回场景选择】= `mission.reset`（结束本轮）→ `flow.goto{step:3}` → 本地切到 SH-03
//   · 【快速脱离体系】= **disabled**，`title` 写明「宿主尚未提供该 verb」（图上按钮保留）
//
// ★ 图上给了示意数值（目标清除 3 / 覆盖区域 24.6 km² / 协同效率 91% / 成功率 92% /
//   组网时长 38分钟）——**一律不写死**：报告字段对得上就显示回执里的数，对不上显示"—"并写明原因
//   （`missingReason`：宿主 warnings 原话 → 溯源模块 → 缺失标记 → missingFields）。
//
// 样式：`theme.ts` 令牌；不用 `backdrop-filter`；**不用 `inset` 简写**（与 `top` 混用会清掉 top）。
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { MapDraw, type PrimitiveKind } from 'map-2d'
import { C, panel, panelTitle, statusColor } from '../theme'
import type { CommandReply, FlowState } from '../api'
import type { UseFlow } from '../flow/useFlow'
import { isObj, obj, objList, pick, replyText, str, useVerbOnce } from '../flow/useSituation'
import { readTargets, readTopology, readSensor } from '../flow/useOps'
import {
  alertCountOf, dynamicStateName, isStruckState, missingReason, msText,
  readAlertCounts, readDurations, readReport,
  type DurationsView, type ReportFieldView, type ReportView,
} from '../flow/useExec'
import { useLabels, voiceLine } from '../shell/VoiceStrip'
import { VerbVerdict } from './VerbVerdict'
import { StageStrip } from './StageOverlay'

/** 一行「名 + 值」：值缺失显示"—"，**不补 0**。 */
function Row({ k, v, color, testid }: { k: string; v: string; color?: string; testid?: string }) {
  return (
    <div data-testid={testid} style={{ display: 'flex', gap: 8, padding: '2px 0', fontSize: 12 }}>
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

/** 报告一个字段的显示值：缺失 → 缺失标记（`—`），**不显示 0**。 */
function fieldValue(f: ReportFieldView): string {
  if (f.missing) return f.missingMarker ?? f.text ?? '—'
  const t = f.text
  return f.unit && !t.includes(f.unit) ? `${t} ${f.unit}` : t
}

/** 字段溯源一行（`source.engine · source.path`，RPT-SCHEMA-02）。 */
function fieldSource(f: ReportFieldView): string {
  return [f.source.engine, f.source.path].filter(Boolean).join(' · ') || '（引擎未给 source）'
}

/** 按 key 优先级找字段（报告结构以回执为准；找不到就是 undefined → 界面显示"—"）。 */
function fieldByKeys(rv: ReportView, keys: string[]): ReportFieldView | undefined {
  for (const k of keys) {
    for (const g of rv.groups) {
      const hit = g.fields.find((f) => f.key.toLowerCase() === k.toLowerCase())
      if (hit) return hit
    }
  }
  return undefined
}

/** 按 key/name 关键字找字段（宿主改字段名时的兜底；仍然只取回执里的字段）。 */
function fieldByKeyword(rv: ReportView, needles: string[]): ReportFieldView | undefined {
  for (const g of rv.groups) {
    for (const f of g.fields) {
      const hay = `${f.key} ${f.name}`.toLowerCase()
      if (needles.some((n) => hay.includes(n.toLowerCase()))) return f
    }
  }
  return undefined
}

/** 报告原文里的标量（递归找 key；找不到 undefined）——用于查"报告里到底有没有这个字段"。 */
function deepScalar(v: unknown, key: string, depth = 0): unknown {
  if (depth > 6 || v === null || v === undefined) return undefined
  if (Array.isArray(v)) {
    for (const it of v) { const hit = deepScalar(it, key, depth + 1); if (hit !== undefined) return hit }
    return undefined
  }
  if (isObj(v)) {
    for (const [k, val] of Object.entries(v)) {
      if (k.toLowerCase() === key.toLowerCase() && (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean')) return val
      const hit = deepScalar(val, key, depth + 1)
      if (hit !== undefined) return hit
    }
  }
  return undefined
}

/** 秒 → 「X 分钟」（**只做单位换算**，并把原始秒数一并写在卡片小字里）。 */
function secText(sec?: number): string {
  if (sec === undefined) return '—'
  if (sec < 60) return `${Number(sec.toFixed(1))} 秒`
  return `${Number((sec / 60).toFixed(1))} 分钟`
}

/** 报告时间轴一段（phase-engine 的 `perPhase[]`）。 */
function SegCard({ seg, index }: { seg: DurationsView['segs'][number]; index: number }) {
  return (
    <div
      data-testid="p6-timeline-seg"
      data-seg-key={seg.key}
      data-seg-phase={seg.phase}
      data-seg-dwell={seg.dwellMs !== undefined ? String(seg.dwellMs) : ''}
      style={{
        flex: '1 0 auto', minWidth: 64, maxWidth: 126, display: 'flex', flexDirection: 'column', gap: 2,
        border: `1px solid ${seg.current ? C.borderStrong : C.border}`, borderRadius: 8,
        background: seg.current ? 'rgba(29,78,216,.28)' : 'rgba(10,32,58,.6)', padding: '6px 8px', overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
        <span style={{ width: 10, height: 10, borderRadius: '50%', flex: '0 0 auto', marginTop: 2, background: seg.current ? C.accent : 'rgba(95,176,255,.35)', border: `1px solid ${C.border}` }} />
        <span data-testid="p6-timeline-seg-phase" style={{ fontSize: 13, color: C.accent, whiteSpace: 'nowrap' }}>{seg.phase}</span>
        <span style={{ fontSize: 10, color: C.textDim }}>#{seg.seq ?? index + 1}</span>
      </div>
      <div data-testid="p6-timeline-seg-dwell" style={{ fontSize: 12, color: C.text, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{msText(seg.dwellMs)}</div>
      <div style={{ fontSize: 9.5, color: C.textDim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>dwellMs={seg.dwellMs ?? '—'}</div>
      <div style={{ fontSize: 9.5, color: C.textDim, whiteSpace: 'nowrap' }}>进 {seg.enteredAt !== undefined ? new Date(seg.enteredAt).toLocaleTimeString() : '—'}</div>
      <div style={{ fontSize: 9.5, color: C.textDim, whiteSpace: 'nowrap' }}>出 {seg.leftAt !== undefined ? new Date(seg.leftAt).toLocaleTimeString() : '（进行中）'}</div>
    </div>
  )
}

/** 报告字段表里的一行（含缺失原因与溯源）。 */
function FieldRow({ f, rv }: { f: ReportFieldView; rv: ReportView }) {
  return (
    <div
      data-testid="p6-report-field"
      data-field-key={f.key}
      data-field-missing={f.missing ? '1' : '0'}
      data-missing-reason={f.missing ? missingReason(f, rv) : ''}
      style={{ padding: '3px 0', borderBottom: '1px solid rgba(95,176,255,.10)' }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
        <span data-testid="p6-field-value" style={{ fontSize: 12, color: f.missing ? C.muted : C.text, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{fieldValue(f)}</span>
        {f.missing && <span style={{ fontSize: 9.5, color: C.warn, whiteSpace: 'nowrap' }}>缺失</span>}
      </div>
      <div style={{ fontSize: 9.5, color: C.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        来源 {f.source.engine ?? '—'}{f.source.path ? ` / ${f.source.path}` : ''}
      </div>
      {f.missing && (
        <div data-testid="p6-field-missing-reason" style={{ fontSize: 9.5, color: C.warn, lineHeight: 1.45 }}>{missingReason(f, rv)}</div>
      )}
    </div>
  )
}

// ============================================================================
// 指标卡（图上 3 张：目标清除 / 覆盖区域 / 协同效率）
// ============================================================================

interface MetricSpec {
  /** 图上逐字的卡名 */
  label: string
  /** 主值（有真实数值时） */
  value?: number
  /** 主值单位（图上写的：km² / %；无单位就空） */
  unit?: string
  /** 无单位时的文本值（宿主 text） */
  text?: string
  /** 值的来源说明（回执字段 → 台账回落都在这里如实写） */
  source: string
  /** 缺数原因（显示在卡面下方，MUST NOT 用 0 顶替） */
  missing?: string
  testid: string
  icon: 'target' | 'area' | 'coop'
}

function MetricCard({ m }: { m: MetricSpec }) {
  const missing = m.value === undefined && !m.text
  const main = missing ? '—' : (m.value !== undefined ? `${Number.isInteger(m.value) ? m.value : Number(m.value.toFixed(1))}${m.unit ?? ''}` : (m.text as string))
  return (
    <div
      /* `p6-big-value` 是**旧脚本的契约名**（结果卡计数），`data-sh-card` 是本轮的新命名（sh18-card-*） */
      data-testid="p6-big-value"
      data-sh-card={m.testid}
      data-field-key={m.testid.replace('sh18-card-', '')}
      data-missing={missing ? '1' : '0'}
      style={{
        flex: '1 1 0', minWidth: 0, border: `1px solid ${missing ? C.border : C.borderStrong}`, borderRadius: 10,
        background: 'rgba(10,32,58,.72)', padding: '8px 11px', display: 'flex', flexDirection: 'column', gap: 3, position: 'relative',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <MetricIcon kind={m.icon} />
        <span style={{ fontSize: 12.5, color: C.text }}>{m.label}</span>
        <span style={{ flex: 1 }} />
        {/* 图上有绿对勾：**只在该卡确实取到真实值时才画**（缺失时画灰圈，不假装有值） */}
        {missing
          ? <span data-testid={`${m.testid}-tick`} title="未取到真实值 → 不画对勾" style={{ width: 14, height: 14, borderRadius: '50%', border: `1px solid ${C.unknown}`, display: 'inline-block' }} />
          : <span data-testid={`${m.testid}-tick`} title="已取到真实值（来源见卡面小字）" style={{ color: C.ok, fontSize: 15, lineHeight: 1 }}>✓</span>}      </div>
      <div style={{ fontSize: 26, lineHeight: 1.1, color: missing ? C.muted : C.text, fontVariantNumeric: 'tabular-nums' }}>{main}</div>
      <div style={{ fontSize: 9.5, color: C.textDim, lineHeight: 1.45, wordBreak: 'break-word' }}>{m.source}</div>
      {missing && m.missing && (
        <div data-testid={`${m.testid}-missing`} style={{ fontSize: 9.5, color: C.warn, lineHeight: 1.45, wordBreak: 'break-word' }}>{m.missing}</div>
      )}
    </div>
  )
}

/** 卡面小图标（照图的准星 / 叠层 / 六边形组网；纯装饰，不含数据）。 */
function MetricIcon({ kind }: { kind: MetricSpec['icon'] }) {
  const s = { stroke: C.accent, strokeWidth: 1.4, fill: 'none' } as const
  return (
    <svg width={18} height={18} viewBox="0 0 18 18" style={{ flex: '0 0 auto' }}>
      {kind === 'target' && (<>
        <circle cx={9} cy={9} r={5.4} {...s} />
        <path d="M9 1v4M9 13v4M1 9h4M13 9h4" {...s} />
      </>)}
      {kind === 'area' && (<>
        <path d="M2 6 L9 2 L16 6 L16 12 L9 16 L2 12 Z" {...s} />
        <path d="M2 9 L16 9" {...s} />
      </>)}
      {kind === 'coop' && (<>
        <path d="M9 2 L15 5.5 L15 12.5 L9 16 L3 12.5 L3 5.5 Z" {...s} />
        <circle cx={9} cy={9} r={2.2} {...s} />
      </>)}
    </svg>
  )
}

/** 状态标签（图上 3 个：信息包已推送 / 残余风险低 / 链路待释放）。 */
function StatusChip({ label, found, positive, value, note, testid }: {
  label: string
  found: boolean
  positive: boolean
  value?: string
  note: string
  testid: string
}) {
  const mark = !found ? '—' : (positive ? '✓' : '●')
  const color = !found ? C.unknown : (positive ? C.ok : C.accent)
  return (
    <span
      data-testid={testid}
      data-found={found ? '1' : '0'}
      title={note}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 7, padding: '4px 10px', borderRadius: 7,
        border: `1px solid ${found ? C.borderStrong : C.border}`, background: 'rgba(6,26,47,.72)',
        fontSize: 12, color: found ? C.text : C.textDim, whiteSpace: 'nowrap',
      }}
    >
      {label}
      <span style={{ color, fontWeight: 700 }}>{mark}</span>
      {value && <span style={{ color: C.textDim, fontSize: 10.5 }}>{value}</span>}
    </span>
  )
}

// ============================================================================
// 屏
// ============================================================================

export function SummaryScreen({ state, flow, onBack, onGo, goto }: {
  state: FlowState
  flow: UseFlow
  /** 回步 10（切步一律发 `flow.goto`；本屏不自己改 step） */
  onBack?: () => void
  /** 切到另一屏（只改本地屏路由） */
  onGo?: (id: string) => void
  /** 走流程（步号归宿主）：【返回场景选择】= 结束本轮（mission.reset）+ step 3 */
  goto?: (step: number) => void
}) {
  const labels = useLabels()

  // ---- ① 报告：`report.generate{}`（幂等由宿主保证）----
  const rep = useVerbOnce(flow, 'report.generate', {}, true)
  /** `/api/state` 里也带"最近一次报告"（`state.report.last`）——回执未就绪时用它顶着，并写明来源。 */
  const stateReport = obj(obj(state as unknown as Record<string, unknown>, 'report'), 'last')
  const reportData = (rep.reply?.code === 0 ? rep.reply.data : undefined)
    ?? (stateReport && isObj(stateReport) ? stateReport : undefined)
  const reportFrom: 'verb' | 'state' | 'none' = rep.reply?.code === 0
    ? 'verb' : (stateReport && isObj(stateReport) ? 'state' : 'none')
  const rv: ReportView = useMemo(() => readReport(reportData), [reportData])
  const dv: DurationsView = useMemo(() => readDurations(reportData), [reportData])
  const av = useMemo(() => readAlertCounts(reportData), [reportData])
  const alertPick = alertCountOf(av)

  /** `report.ready` 事件到达 → 重取一次（报告可能刚落盘）。 */
  const readyTs = flow.events['report.ready']?.ts ?? 0
  const lastReadyRef = useRef(0)
  const resendRef = useRef(rep.resend)
  resendRef.current = rep.resend
  useEffect(() => {
    if (!readyTs || readyTs === lastReadyRef.current) return
    lastReadyRef.current = readyTs
    resendRef.current()
  }, [readyTs])

  const code = rep.reply?.code
  const ok = code === 0 || (reportFrom === 'state' && rv.fieldCount > 0)
  const notImpl = code === 1000 || code === 1005

  // ---- ② 台账回落（报告缺字段时的**真实值**，来源一律写在卡面）----
  const tlist = useVerbOnce(flow, 'targets.list', {}, true)
  const tl = useMemo(() => readTargets(tlist.data), [tlist.data])
  const struckTargets = useMemo(() => tl.items.filter((t) => isStruckState(t.status, t.motion)), [tl])
  const sensor = useVerbOnce(flow, 'sensor.status', {}, true)
  const sv = useMemo(() => readSensor(sensor.data), [sensor.data])
  const topo = useVerbOnce(flow, 'topology.evaluate', {}, true)
  const tv = useMemo(() => readTopology(topo.data), [topo.data])
  const coopEval = tv.metrics.find((m) => m.key === 'cooperation')

  // ---- ③ 指标卡（图上 3 张）----
  const cardDestroyed = fieldByKeys(rv, ['destroyed', 'handledCount', 'damageWeighted'])
  const cardArea = fieldByKeys(rv, ['coveredAreaKm2', 'coverageAreaKm2', 'coverageArea']) ?? fieldByKeyword(rv, ['面积', 'area', 'km²'])
  const cardCoop = fieldByKeys(rv, ['coopEfficiency'])

  const metrics: MetricSpec[] = useMemo(() => {
    const out: MetricSpec[] = []
    // ① 目标清除
    if (cardDestroyed && !cardDestroyed.missing) {
      out.push({
        label: '目标清除', value: cardDestroyed.value, text: cardDestroyed.value === undefined ? cardDestroyed.text : undefined,
        source: `report.generate · ${cardDestroyed.key}（${cardDestroyed.name}）`, testid: 'sh18-card-cleared', icon: 'target',
      })
    } else if (tl.items.length > 0) {
      out.push({
        label: '目标清除', value: struckTargets.length,
        source: `台账回落 · targets.list（dynamicState=struck/destroyed 计数，共 ${tl.items.length} 个目标）`,
        missing: cardDestroyed ? `报告字段缺失：${cardDestroyed.key}` : '报告里没有 destroyed / handledCount 字段',
        testid: 'sh18-card-cleared', icon: 'target',
      })
    } else {
      out.push({
        label: '目标清除',
        source: 'report.generate 与 targets.list 都没给数',
        missing: rep.reply ? `report.generate → ${replyText(rep.reply)}` : '报告未生成（正在请求…）',
        testid: 'sh18-card-cleared', icon: 'target',
      })
    }
    // ② 覆盖区域（km²）
    if (cardArea && !cardArea.missing) {
      out.push({
        label: '覆盖区域', value: cardArea.value, unit: cardArea.unit ?? '', text: cardArea.value === undefined ? cardArea.text : undefined,
        source: `report.generate · ${cardArea.key}（${cardArea.name}）`, testid: 'sh18-card-area', icon: 'area',
      })
    } else if (sv.metrics.some((m) => m.key === 'coveredAreaKm2')) {
      const m = sv.metrics.find((x) => x.key === 'coveredAreaKm2')!
      out.push({
        label: '覆盖区域', value: m.value, unit: ' km²',
        source: '台账回落 · sensor.status.coveredAreaKm2（引擎覆盖读数）',
        testid: 'sh18-card-area', icon: 'area',
      })
    } else {
      out.push({
        label: '覆盖区域', source: '报告与 sensor.status 都没有面积字段',
        missing: sensor.reply ? `sensor.status → ${replyText(sensor.reply)}` : '（报告里没有 km² 量纲的字段；传感器读数未就绪）',
        testid: 'sh18-card-area', icon: 'area',
      })
    }
    // ③ 协同效率（%）
    if (cardCoop && !cardCoop.missing) {
      out.push({
        label: '协同效率', value: cardCoop.value, unit: '%', text: cardCoop.value === undefined ? cardCoop.text : undefined,
        source: `report.generate · ${cardCoop.key}（${cardCoop.name}）`, testid: 'sh18-card-coop', icon: 'coop',
      })
    } else if (coopEval?.value !== undefined) {
      const v = coopEval.value <= 1 ? Number((coopEval.value * 100).toFixed(1)) : coopEval.value
      out.push({
        label: '协同效率', value: v, unit: '%',
        source: `台账回落 · topology.evaluate · evaluation.cooperation（网络·协同效率；0–1 → ×100）`,
        testid: 'sh18-card-coop', icon: 'coop',
      })
    } else {
      out.push({
        label: '协同效率', source: '报告与拓扑评估都没给协同效率',
        missing: cardCoop ? `报告字段缺失：${cardCoop.key}` : '报告里没有 coopEfficiency 字段',
        testid: 'sh18-card-coop', icon: 'coop',
      })
    }
    return out
  }, [cardDestroyed, cardArea, cardCoop, tl.items.length, struckTargets.length, sv, sensor.reply, coopEval, rep.reply])

  // ---- ④ 「报告生成」进度行：**有真实进度才画**，否则空条 + 原因 ----
  // 只认"报告生成进度"这一类字段（别把 recoveryProgress 之类当成它）
  const progField = fieldByKeys(rv, ['reportProgress', 'generateProgress'])
    ?? fieldByKeyword(rv, ['生成进度', '报告进度', 'reportprogress'])
  const progress: { value?: number; note: string; color: string } = (() => {
    if (progField && !progField.missing && progField.value !== undefined) {
      const v = progField.value <= 1 ? Number((progField.value * 100).toFixed(1)) : progField.value
      return { value: v, note: `进度来自报告字段 ${progField.key}`, color: C.ok }
    }
    if (reportData && (rv.doc !== null || rv.fieldCount > 0)) {
      // 报告已生成（code=0 且能读到 document）→ 画满条，但**不编百分比**：写"已完成"而不是数字
      return { value: 100, note: '报告已生成（report.generate code=0）→ 画满条；回执里没有百分比字段，故不显示百分数', color: C.ok }
    }
    return {
      value: undefined,
      note: rep.reply
        ? `报告未生成：${replyText(rep.reply)}${notImpl ? '（宿主侧尚未实现/装配 → 空条 + 原因，不画假进度）' : ''}`
        : '正在请求 report.generate…（空条：无真实进度可画）',
      color: C.unknown,
    }
  })()

  // ---- ⑤ 3 个状态标签：字段有就给 ✓/●，没有就"—"并写明原因 ----
  const chipSpecs: { label: string; keys: string[]; positive: string[]; testid: string }[] = [
    { label: '信息包已推送', keys: ['infoPackPushed', 'infoPackPushState', 'pushResult', 'infoPack'], positive: ['已', 'done', 'ok', '送达', 'complete'], testid: 'sh18-chip-infopack' },
    { label: '残余风险低', keys: ['residualRisk', 'residualRiskLevel', 'riskLevel'], positive: ['低', 'low', 'ok', 'none', 'minimal'], testid: 'sh18-chip-risk' },
    { label: '链路待释放', keys: ['linkRelease', 'linkReleaseState', 'pendingRelease'], positive: [], testid: 'sh18-chip-link' },
  ]
  const chips = chipSpecs.map((c) => {
    const f = fieldByKeys(rv, c.keys)
    if (f && !f.missing) {
      const text = f.text ?? ''
      return { ...c, found: true, positive: c.positive.some((p) => text.toLowerCase().includes(p.toLowerCase())), value: `${f.key}=${text}`, note: `报告字段 ${f.key}（${f.name}）：${text}` }
    }
    const raw = c.keys.map((k) => deepScalar(reportData, k)).find((x) => x !== undefined)
    if (raw !== undefined) {
      const text = String(raw)
      return { ...c, found: true, positive: c.positive.some((p) => text.toLowerCase().includes(p.toLowerCase())), value: `${c.keys[0]}=${text}`, note: `报告原文里的 ${c.keys[0]}：${text}` }
    }
    return {
      ...c, found: false, positive: false, value: undefined,
      note: `回执里没有「${c.label}」对应的状态字段（reportFields.json 的 6 个分组里没有它）→ 显示"—"，不画假对勾`,
    }
  })

  // ---- ⑥ 右栏「关键结果 / 后续处置」（图上逐字的三行 + 三行）----
  const keyRows: { label: string; field?: ReportFieldView; fallback?: string; fallbackSrc?: string; testid: string }[] = [
    { label: '成功率', field: fieldByKeys(rv, ['successRate', 'missionSuccess', 'hitRate', 'survivalRate', 'damageRate']), testid: 'sh18-key-success' },
    { label: '组网时长', field: fieldByKeys(rv, ['meshDurationSec', 'meshDuration']), testid: 'sh18-key-mesh' },
    { label: '推送结果', field: fieldByKeys(rv, ['pushResult', 'pushState', 'delivered']), testid: 'sh18-key-push' },
  ]
  // 组网时长：报告给的是"秒"→ 主显分钟，原始秒数写在来源里（只做单位换算）
  const meshField = keyRows[1].field
  const meshSec = meshField && !meshField.missing ? meshField.value : undefined

  const nextRows: { label: string; field?: ReportFieldView; keys: string[]; testid: string }[] = [
    { label: '资源撤收', field: fieldByKeys(rv, ['resourceRecovery', 'recoveryProgress', 'consumedOptical']), keys: ['resourceRecovery', 'recoveryProgress', 'consumedOptical', 'consumedRadar', 'consumedElectronic', 'consumedComm'], testid: 'sh18-next-resource' },
    { label: '链路释放', field: fieldByKeys(rv, ['linkRelease', 'linkReleaseState']), keys: ['linkRelease', 'linkReleaseState'], testid: 'sh18-next-link' },
    { label: '部署转移', field: fieldByKeys(rv, ['deployTransfer', 'transferState', 'redeploy']), keys: ['deployTransfer', 'transferState', 'redeploy'], testid: 'sh18-next-move' },
  ]
  /** 资源组字段（报告 resource 分组里真实存在的字段数）——用于「资源撤收」行的口径说明。 */
  const resourceGroup = rv.groups.find((g) => g.key === 'resource' || g.name.includes('资源'))

  // ---- ⑦ AI摘要：图上是一句中文（voice.sh18.system）+ 大对勾 ----
  const aiVoice = voiceLine(labels, 'sh18', 'system')
  const aiSummary = useMemo(() => {
    const out: string[] = []
    for (const g of rv.groups) {
      for (const f of g.fields) {
        if (f.value === undefined && !f.missing && f.text && out.length < 3
          && ['summary', 'advice', 'conclusion', 'note', 'comment', '摘要', '建议', '结论'].some((n) => `${f.key}${f.name}`.toLowerCase().includes(n))) {
          out.push(f.text)
        }
      }
    }
    return out
  }, [rv])

  // ---- ⑧ 地图：台账目标按引擎状态重画（已被判失效的取灰；不编残余威胁/航线几何）----
  const drawnRef = useRef<{ kind: PrimitiveKind; id: string }[]>([])
  useEffect(() => {
    const prev = drawnRef.current
    const next: { kind: PrimitiveKind; id: string }[] = []
    MapDraw.batch(() => {
      for (const d of prev) MapDraw.remove(d.kind, d.id)
      for (const t of tl.items) {
        if (t.lng === undefined || t.lat === undefined) continue
        const struck = isStruckState(t.status, t.motion)
        const id = `RPT6:${t.entityId}`
        MapDraw.add('target', {
          id, lng: t.lng, lat: t.lat,
          color: struck ? C.muted : (t.status ? statusColor(t.status) : C.unknown),
          status: struck ? 'gray' : t.status,
          label: t.no !== undefined ? `目标${String(t.no).padStart(3, '0')}` : (t.name || t.entityId),
        })
        next.push({ kind: 'target', id })
      }
    })
    drawnRef.current = next
    return () => {
      const mine = drawnRef.current
      MapDraw.batch(() => { for (const d of mine) MapDraw.remove(d.kind, d.id) })
      drawnRef.current = []
    }
  }, [tl])

  // ---- ⑨ 导出（复制 JSON + 展开）与【返回场景选择】（结束本轮）----
  const [showJson, setShowJson] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [resetNote, setResetNote] = useState<string | null>(null)
  const jsonText = useMemo(() => {
    try { return JSON.stringify(rep.reply ?? reportData ?? null, null, 2) } catch { return '(回执无法序列化)' }
  }, [rep.reply, reportData])

  /** 导出/复看：**只做"把报告 JSON 显示出来"**（复制 + 展开），不下载文件、不谎报导出成功。 */
  const exportJson = async (label: string) => {
    setShowJson(true)
    const tail = '（未下载文件——本轮不做文件导出，避免谎报"已生成 PDF/DOCX"）'
    try {
      await navigator.clipboard.writeText(jsonText)
      setCopied(`${label}：报告 JSON 已复制到剪贴板，并展开在下方${tail}`)
    } catch {
      setCopied(`${label}：报告 JSON 已展开在下方（浏览器拒绝了剪贴板写入，请手动选择复制）${tail}`)
    }
  }

  /** 【返回场景选择】= 先结束本轮（`mission.reset`）→ 宿主步 3 → 本地切到 SH-03。 */
  const backToScenes = async () => {
    try {
      const r = await flow.send('mission.reset', {})
      setResetNote(r.code === 0 ? 'mission.reset → code=0（本轮已结束，下一轮从 step 3 开始）' : `mission.reset → ${replyText(r)}（仍切回场景选择）`)
    } catch (e) {
      setResetNote(`mission.reset 发送失败：${String((e as Error)?.message ?? e)}（仍切回场景选择）`)
    }
    goto?.(3)
    if (onGo) onGo('SH-03'); else onBack?.()
  }

  const struckCount = struckTargets.length

  return (
    <>
      {/* ---------------- 顶部压条 ---------------- */}
      <StageStrip
        items={[
          { k: '显示模式', v: '结果汇总' },
          { k: '阶段', v: state.phase || '—' },
          { k: '报告编号', v: rv.reportNo ?? '—', color: rv.reportNo ? C.text : C.textDim },
          { k: '生成时间', v: rv.generatedAt ?? '—' },
          { k: '字段', v: `${rv.fieldCount}${rv.missingCount > 0 ? `（缺失 ${rv.missingCount}）` : ''}`, color: rv.missingCount > 0 ? C.warn : C.text },
          { k: '来源', v: reportFrom === 'verb' ? 'report.generate 回执' : reportFrom === 'state' ? 'state.report.last' : '未就绪' },
        ]}
        right={<span style={{ color: ok ? C.textDim : (notImpl ? C.warn : C.bad) }}>
          {rep.reply === null ? '报告生成中…' : ok ? 'report.generate 已就绪' : `report.generate → ${replyText(rep.reply)}`}
        </span>}
      />

      {/* ---------------- 左栏：时间轴 + 预警次数 + 报告 JSON ---------------- */}
      <div style={leftColStyle}>
        <div data-testid="p6-timeline-panel" style={{ ...panel, width: '100%', boxSizing: 'border-box' }}>
          <div style={panelTitle}>
            任务时间轴（逐阶段耗时）
            <span style={{ float: 'right', fontSize: 11.5, color: C.textDim }}>
              {dv.segs.length > 0 ? `${dv.segs.length} 段 · 来源 durations` : '未就绪'}
            </span>
          </div>
          <div data-testid="p6-timeline" style={{ display: 'flex', gap: 7, padding: '8px 10px 9px', overflowX: 'auto' }}>
            {dv.segs.map((s, i) => <SegCard key={s.key} seg={s} index={i} />)}
            {dv.segs.length === 0 && (
              <div data-testid="p6-timeline-empty" style={{ flex: 1, minWidth: 200, fontSize: 11.5, color: C.textDim, lineHeight: 1.8, textAlign: 'center', padding: '6px 4px' }}>
                <div>时间轴未就绪：需要 phase-engine 的 `durations`（逐阶段耗时，**前端不自己算**）。</div>
                <div style={{ color: notImpl ? C.warn : C.textDim }}>
                  {rep.reply ? (ok ? '回执里没有 durations（段键/层级见「报告 JSON」原文）' : `report.generate → ${replyText(rep.reply)}`) : '正在请求报告…'}
                </div>
              </div>
            )}
          </div>
          {(dv.missionId || dv.totalMs !== undefined) && (
            <div style={{ fontSize: 10.5, color: C.textDim, padding: '0 12px 7px', lineHeight: 1.55 }}>
              {dv.missionId ? `任务 ${dv.missionId}` : ''}
              {dv.totalMs !== undefined ? ` · 总用时 ${msText(dv.totalMs)}（totalMs=${dv.totalMs}）` : ' · 总用时 —（引擎未给 totalMs）'}
            </div>
          )}
        </div>

        <Section title="预警次数（alert-engine 计数）" testid="p6-alert-panel" right={av.basis ? `basis=${av.basis}` : '未声明 basis'}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span data-testid="p6-alert-count" data-alert-by={alertPick.by} style={{ fontSize: 24, color: alertPick.value === undefined ? C.muted : C.warn, fontVariantNumeric: 'tabular-nums' }}>
              {alertPick.value !== undefined ? alertPick.value : '—'}
            </span>
            <span style={{ fontSize: 11, color: C.textDim }}>{alertPick.by}</span>
          </div>
          {av.raw === null && (
            <div data-testid="p6-alert-empty" style={{ fontSize: 11, color: C.warn, lineHeight: 1.6 }}>
              宿主回执里没有 alert-engine 的 counts 段 → 显示"—"（**不填 0**：0 与"没有这段数据"是两回事）。
            </div>
          )}
          <div style={{ fontSize: 10, color: C.textDim, marginTop: 3, lineHeight: 1.5 }}>
            口径由引擎的 `basis` 声明（deduplicated / raw 两套同时在案，前端不挑、不换算）。
          </div>
        </Section>

        <Section title="报告 JSON（复看 / 导出）" testid="p6-json-panel" right={rv.doc ? 'document 已读到' : 'document 未读到'}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button data-testid="p6-btn-json" style={miniBtn} onClick={() => setShowJson((v) => !v)}>
              {showJson ? '收起 JSON' : '复看报告 JSON'}
            </button>
            <button data-testid="p6-btn-refresh" style={miniBtn} onClick={rep.resend} disabled={rep.busy}>
              {rep.busy ? '生成中…' : '重新生成报告'}
            </button>
          </div>
          {copied && <div data-testid="p6-copy-note" style={{ fontSize: 10.5, color: C.accent, marginTop: 4, lineHeight: 1.55 }}>{copied}</div>}
          {resetNote && <div data-testid="sh18-reset-note" style={{ fontSize: 10.5, color: C.textDim, marginTop: 4, lineHeight: 1.55 }}>{resetNote}</div>}
          {showJson && (
            <pre
              data-testid="p6-report-json"
              style={{
                marginTop: 6, maxHeight: 220, overflow: 'auto', fontSize: 10, lineHeight: 1.45,
                background: 'rgba(4,24,47,.9)', border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 8px',
                color: C.text, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
              }}
            >{jsonText}</pre>
          )}
        </Section>
      </div>

      {/* ---------------- 右栏：3 面板（AI摘要 / 关键结果 / 后续处置）+ 报告字段 ---------------- */}
      <div style={rightColStyle}>
        <Section title="AI摘要" testid="p6-ai-panel" right="voice.sh18.system">
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <div data-testid="sh18-ai-text" style={{ flex: 1, minWidth: 0, fontSize: 12, color: aiVoice ? C.text : C.textDim, lineHeight: 1.7 }}>
              {aiVoice || '（未配置语音文案：`config.json` 的 flow.labels 里缺 voice.sh18.system）'}
              {aiSummary.map((t, i) => <div key={i} data-testid="p6-ai-line" style={{ marginTop: 4, fontSize: 11.5, color: C.text }}>· {t}</div>)}
            </div>
            {/* 图右侧的大号绿色对勾（装饰；不代表任何未取到的结论） */}
            <svg width={44} height={44} viewBox="0 0 44 44" style={{ flex: '0 0 auto' }}>
              <title>装饰图形（图上原样；不作为数据）</title>
              <circle cx={22} cy={22} r={19} fill="none" stroke="rgba(34,197,94,.55)" strokeWidth={2} />
              <circle cx={22} cy={22} r={14} fill="none" stroke="rgba(34,197,94,.35)" strokeWidth={1} />
              <path d="M14 23 L20 29 L31 16" fill="none" stroke={C.ok} strokeWidth={3} strokeLinecap="round" />
            </svg>
          </div>
        </Section>

        <Section title="关键结果" testid="p6-key-panel" right={`${rv.groups.length} 个分组`}>
          {keyRows.map((r) => {
            const f = r.field
            const has = !!f && !f.missing && (f.value !== undefined || !!f.text)
            let value = '—'
            let src = ''
            if (has && f) {
              if (r.label === '组网时长' && meshSec !== undefined) {
                value = secText(meshSec)
                src = `${f.key}（${f.name}）= ${meshSec} 秒`
              } else {
                value = fieldValue(f)
                src = `${f.key}（${f.name}）· ${fieldSource(f)}`
              }
            } else if (r.label === '推送结果') {
              // 报告里没有"推送结果"字段 → 用它**真有**的两样旁证（归档 / 渲染），并如实写出来
              if (rv.archive?.fileName) { value = `已归档（${rv.archive.fileName}）`; src = 'report.generate · archive.fileName' }
              else if (rv.render) { value = `渲染 ${rv.render.ok ? 'ok' : 'fail'}（${rv.render.format ?? '—'} · ${rv.render.bytes ?? '—'} B）`; src = 'report.generate · render' }
              else { value = '—'; src = '报告里没有「推送结果」字段（archive/render 也没给）' }
            } else {
              src = f ? `字段 ${f.key} 缺失：${missingReason(f, rv)}` : `报告里没有「${r.label}」对应字段（reportFields.json 的 taskMetrics/damage 组都没有它）`
            }
            return (
              <div key={r.label} data-testid={r.testid} data-has={has ? '1' : '0'} style={{ padding: '2px 0' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12 }}>
                  <span style={{ color: C.textDim, flex: 1, minWidth: 0 }}>{r.label}</span>
                  <span style={{ color: has ? C.ok : C.muted, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
                </div>
                <div style={{ fontSize: 9.5, color: C.textDim, lineHeight: 1.45, wordBreak: 'break-word' }}>{src}</div>
              </div>
            )
          })}
        </Section>

        <Section title="后续处置" testid="p6-next-panel">
          {nextRows.map((r) => {
            const f = r.field
            const has = !!f && !f.missing
            let value = '—'
            let src = ''
            if (has && f) {
              value = fieldValue(f)
              src = `报告字段 ${f.key}（${f.name}）`
            } else if (r.label === '资源撤收' && resourceGroup && resourceGroup.fields.length > 0) {
              value = `已统计（${resourceGroup.fields.length} 个资源字段）`
              src = `报告 resource 组：${resourceGroup.fields.map((x) => x.key).join('、')}`
            } else {
              src = `报告字段里没有「${r.label}」状态（reportFields.json 的 6 个分组均无此字段）→ 显示"—"（不编状态）`
            }
            return (
              <div key={r.label} data-testid={r.testid} data-has={has ? '1' : '0'} style={{ padding: '2px 0' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12 }}>
                  <span style={{ color: C.textDim, flex: 1, minWidth: 0 }}>{r.label}</span>
                  <span style={{ color: has ? statusColor('ok') : C.muted }}>{value}</span>
                </div>
                <div style={{ fontSize: 9.5, color: C.textDim, lineHeight: 1.45, wordBreak: 'break-word' }}>{src}</div>
              </div>
            )
          })}
        </Section>

        <Section title="目标状态（毁伤评估）" testid="p6-struck-panel" right={tlist.reply?.code === 0 ? `${struckCount}/${tl.items.length} 已失效` : '台账未就绪'}>
          {struckCount === 0 && (
            <div data-testid="p6-struck-empty" style={{ fontSize: 11.5, color: C.textDim, lineHeight: 1.7 }}>
              {tlist.reply?.code === 0
                ? '台账里没有"已失效"的目标（status/dynamicState 都没判灰）→ 图上不变灰（前端不自己判命中）。'
                : `目标台账未就绪：${tlist.reply ? replyText(tlist.reply) : '正在读取…'}`}
            </div>
          )}
          {struckTargets.map((t) => (
            <div key={t.entityId} data-testid="p6-struck-row" data-entity-id={t.entityId} data-status={t.status ?? ''}
              style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '2px 0', fontSize: 11.5 }}>
              <span style={{ color: C.muted, width: 8, height: 8, borderRadius: 2, background: C.muted, flex: '0 0 auto' }} />
              <span style={{ flex: 1, minWidth: 0, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t.no !== undefined ? `目标${String(t.no).padStart(3, '0')} ` : ''}{t.name || t.typeName || t.entityId}
              </span>
              <span style={{ color: C.muted }}>{dynamicStateName(t.motion).text}</span>
            </div>
          ))}
          <div style={{ fontSize: 10, color: C.textDim, marginTop: 3, lineHeight: 1.5 }}>
            状态取自 `targets.list`（源头 entity-ledger 台账）；残余威胁点 / 回收轨迹 / 复核航线三类几何宿主未给 → **不画**。
          </div>
        </Section>

        <Section title="报告字段（按引擎分组）" testid="p6-report-panel" right={ok ? `${rv.groups.length} 组 / ${rv.fieldCount} 字段` : '未就绪'}>
          {!ok && (
            <div data-testid="p6-report-empty" style={{ fontSize: 11.5, color: C.warn, lineHeight: 1.7 }}>
              报告未就绪：{rep.reply ? replyText(rep.reply) : '正在请求 report.generate…'}
              <div style={{ color: C.textDim, marginTop: 3 }}>本屏不预置任何字段名与数值 —— 分组与字段**以 `report.generate` 的返回结构为准**。</div>
            </div>
          )}
          {rv.groups.map((g) => (
            <div key={g.key} data-testid="p6-report-group" data-group-key={g.key} style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 12, color: C.accent, padding: '2px 0' }}>
                {g.name}
                <span style={{ fontSize: 10, color: C.textDim }}>（order={g.order ?? '—'} · {g.fields.length} 字段）</span>
              </div>
              {g.fields.map((f) => <FieldRow key={f.key} f={f} rv={rv} />)}
              {g.fields.length === 0 && <div style={{ fontSize: 10.5, color: C.textDim }}>该分组里没有字段</div>}
            </div>
          ))}
          {ok && rv.fieldCount === 0 && (
            <div data-testid="p6-report-nofields" style={{ fontSize: 11.5, color: C.warn, lineHeight: 1.7 }}>
              report.generate 回了 code=0，但回执里没有任何分组/字段（document 未读到）。界面不补字段、不补数值。
            </div>
          )}
        </Section>

        <VerbVerdict
          title="报告命令"
          rows={[{ verb: 'report.generate', reply: rep.reply, busy: rep.busy, onRetry: rep.resend, okNote: `${rv.fieldCount} 字段 / ${dv.segs.length} 段时间轴 / 预警 ${alertPick.value ?? '—'}` }]}
        />
      </div>

      {/* ---------------- 地图下部通栏：3 指标卡 + 报告生成进度行 + 3 状态标签 + 3 按钮 ---------------- */}
      <div style={bottomBlockStyle}>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 7 }}>
          {/* ① 3 张指标卡（图：目标清除 / 覆盖区域 / 协同效率，各带绿对勾） */}
          <div data-testid="sh18-metrics" style={{ display: 'flex', gap: 10 }}>
            {metrics.map((m) => <MetricCard key={m.label} m={m} />)}
          </div>

          {/* ② 「报告生成」进度行（文档图标 + 绿色进度条；**没有真实进度就空条 + 原因**） */}
          <div data-testid="sh18-report-progress" data-value={progress.value ?? ''} style={{ display: 'flex', alignItems: 'center', gap: 9, height: 24 }}>
            <svg width={15} height={15} viewBox="0 0 16 16" style={{ flex: '0 0 auto' }}>
              <path d="M4 1.5 H10 L13 4.5 V14.5 H4 Z" fill="none" stroke={C.accent} strokeWidth={1.2} />
              <path d="M10 1.5 V4.5 H13" fill="none" stroke={C.accent} strokeWidth={1.2} />
            </svg>
            <span style={{ fontSize: 12, color: C.text, whiteSpace: 'nowrap' }}>报告生成</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ height: 9, borderRadius: 4, background: 'rgba(6,26,47,.9)', border: `1px solid ${C.border}`, overflow: 'hidden' }}>
                <div style={{ width: `${progress.value ?? 0}%`, height: '100%', background: progress.value === undefined ? 'transparent' : C.ok }} />
              </div>
              <div data-testid="sh18-progress-note" style={{ fontSize: 9.5, color: progress.value === undefined ? C.warn : C.textDim, lineHeight: 1.4 }}>{progress.note}</div>
            </div>
            <span style={{ fontSize: 11.5, color: progress.value === undefined ? C.textDim : C.ok, whiteSpace: 'nowrap' }}>
              {progress.value === undefined ? '—' : (progress.value >= 100 ? '已完成' : `${progress.value}%`)}
            </span>
          </div>

          {/* ③ 3 个状态标签（图：信息包已推送 ✓ / 残余风险低 ✓ / 链路待释放 ●） */}
          <div data-testid="sh18-chips" style={{ display: 'flex', gap: 9, alignItems: 'center', flexWrap: 'wrap' }}>
            {chips.map((c) => (
              <StatusChip key={c.label} label={c.label} found={c.found} positive={c.positive} value={c.value} note={c.note} testid={c.testid} />
            ))}
            {chips.every((c) => !c.found) && (
              <span data-testid="sh18-chips-note" style={{ fontSize: 10, color: C.warn, lineHeight: 1.4 }}>
                三项状态在回执里都没有对应字段 → 一律"—"（不画假对勾）
              </span>
            )}
          </div>

          {/* ④ 3 个按钮（图：返回场景选择 / 导出任务报告 / 快速脱离体系） */}
          <div data-testid="sh18-actions" style={{ display: 'flex', gap: 10, alignItems: 'center', height: 32 }}>
            <button data-testid="p6-btn-back" style={ghostBtn} onClick={() => void backToScenes()} title="结束本轮：mission.reset → flow.goto{step:3} → SH-03">
              返回场景选择
            </button>
            <button data-testid="p6-btn-export" style={primaryBtn} onClick={() => void exportJson('导出任务报告')} title="把 /api/command 的报告 JSON 复制到剪贴板并展开（本轮不做文件下载）">
              导出任务报告
            </button>
            <button
              data-testid="sh18-btn-detach"
              style={ghostDisabled}
              disabled
              title="宿主尚未提供该 verb（流程接口冻结 §2 的 11 步命令表里没有「快速脱离体系」；本轮不假装能点）"
            >
              快速脱离体系
            </button>
            <span style={{ fontSize: 10.5, color: C.textDim, whiteSpace: 'nowrap' }}>
              步 {state.step}/11{state.phase ? ` · ${state.phase}` : ''}
            </span>
          </div>
        </div>
      </div>

      <P6SummaryProbe
        step={state.step}
        phase={state.phase}
        reportFrom={reportFrom}
        reply={rep.reply}
        rv={rv}
        dv={dv}
        alertsRaw={av.raw}
        alertValue={alertPick.value ?? null}
        alertBy={alertPick.by}
        metrics={metrics}
        chips={chips.map((c) => ({ label: c.label, found: c.found, positive: c.positive, value: c.value ?? null, note: c.note }))}
        progress={progress}
        keyRows={keyRows.map((r) => ({ label: r.label, key: r.field?.key ?? null, missing: r.field?.missing ?? null, text: r.field?.text ?? null }))}
        stuckCount={struckCount}
        targetCount={tl.items.length}
        replies={flow.replies}
        lastReply={flow.lastReply}
        eventKeys={Object.keys(flow.events)}
        mapItems={tl.items.filter((t) => t.lng !== undefined).length}
      />
    </>
  )
}

/** 自证句柄：`window.__p6Stats`（步 11 部分，与步 10 的键合并在同一对象上）。 */
function P6SummaryProbe(props: {
  step: number
  phase: string
  reportFrom: 'verb' | 'state' | 'none'
  reply: CommandReply | null
  rv: ReportView
  dv: DurationsView
  alertsRaw: unknown
  alertValue: number | null
  alertBy: string
  metrics: MetricSpec[]
  chips: { label: string; found: boolean; positive: boolean; value: string | null; note: string }[]
  progress: { value?: number; note: string; color: string }
  keyRows: { label: string; key: string | null; missing: boolean | null; text: string | null }[]
  stuckCount: number
  targetCount: number
  replies: Record<string, CommandReply>
  lastReply: CommandReply | null
  eventKeys: string[]
  mapItems: number
}) {
  const {
    step, phase, reportFrom, reply, rv, dv, alertsRaw, alertValue, alertBy,
    metrics, chips, progress, keyRows, stuckCount, targetCount, replies, lastReply, eventKeys, mapItems,
  } = props
  const w = window as unknown as { __p6Stats?: Record<string, unknown> }
  w.__p6Stats = {
    ...(w.__p6Stats ?? {}),
    step,
    screen: 'SH-18',
    phase,
    report: {
      reply,
      from: reportFrom,
      reportNo: rv.reportNo ?? null,
      generatedAt: rv.generatedAt ?? null,
      schemaVersion: rv.schemaVersion ?? null,
      groupCount: rv.groups.length,
      fieldCount: rv.fieldCount,
      missingCount: rv.missingCount,
      groups: rv.groups.map((g) => ({
        key: g.key, name: g.name,
        fields: g.fields.map((f) => ({ key: f.key, name: f.name, unit: f.unit ?? null, text: f.text, missing: f.missing, value: f.value ?? null, source: f.source })),
      })),
      archive: rv.archive ?? null,
      render: rv.render ?? null,
      missingKeys: rv.missingKeys,
      warnings: rv.warnings,
    },
    durations: {
      segCount: dv.segs.length,
      segs: dv.segs.map((s) => ({ key: s.key, phase: s.phase, seq: s.seq ?? null, enteredAt: s.enteredAt ?? null, leftAt: s.leftAt ?? null, dwellMs: s.dwellMs ?? null, current: s.current ?? null })),
      totalMs: dv.totalMs ?? null,
      missionId: dv.missionId ?? null,
      domSegs: document.querySelectorAll('[data-testid="p6-timeline-seg"]').length,
    },
    alerts: { value: alertValue, by: alertBy, raw: alertsRaw ?? null },
    /** SH-18 新增三块（图上逐字）——脚本可直接对账"界面上那个数 = 哪个字段" */
    metricCards: metrics.map((m) => ({ label: m.label, value: m.value ?? null, unit: m.unit ?? null, text: m.text ?? null, source: m.source, missing: m.missing ?? null, testid: m.testid })),
    statusChips: chips,
    reportProgress: progress,
    keyResults: keyRows,
    map: { struck: stuckCount, targets: targetCount, mapped: mapItems },
    replies: Object.fromEntries(Object.entries(replies ?? {}).map(([k, v]) => [k, { verb: v.verb, code: v.code, message: v.error?.message ?? null }])),
    lastReply: lastReply ? { verb: lastReply.verb, code: lastReply.code, message: lastReply.error?.message ?? null } : null,
    eventKeys,
    dom: {
      groups: document.querySelectorAll('[data-testid="p6-report-group"]').length,
      fields: document.querySelectorAll('[data-testid="p6-report-field"]').length,
      cardCount: document.querySelectorAll('[data-testid="sh18-metrics"] > *').length,
      chips: document.querySelectorAll('[data-testid="sh18-chips"] > *').length,
      hasExport: !!document.querySelector('[data-testid="p6-btn-export"]'),
      hasBack: !!document.querySelector('[data-testid="p6-btn-back"]'),
      detachDisabled: (document.querySelector('[data-testid="sh18-btn-detach"]') as HTMLButtonElement | null)?.disabled ?? null,
      jsonShown: !!document.querySelector('[data-testid="p6-report-json"]'),
      notReady: !!document.querySelector('[data-testid="p6-report-notready"]'),
      timelineEmpty: !!document.querySelector('[data-testid="p6-timeline-empty"]'),
      alertCountText: document.querySelector('[data-testid="p6-alert-count"]')?.textContent ?? null,
    },
  }
  return null
}

// ---- 样式（一律 left/right/bottom 长写：**不写 inset 简写**）----
//
// 套在 App 的全局框架里（左导航 74 / 底部状态条 30 由壳让开）：
//   · 顶部压条 top:0 h:28（StageStrip 自己定位）
//   · 左右栏让开底部通栏（bottom:244 = 通栏高 196 + 24 间距 + 状态条 24）
//   · 底部通栏 bottom:36（状态条 30 + 6 间距）
const leftColStyle: CSSProperties = {
  position: 'absolute', left: 12, top: 34, bottom: 244, zIndex: 20, width: 340,
  display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
}
const rightColStyle: CSSProperties = {
  position: 'absolute', right: 12, top: 34, bottom: 244, zIndex: 20, width: 306,
  display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
}
const bottomBlockStyle: CSSProperties = {
  position: 'absolute', left: 12, right: 12, bottom: 36, zIndex: 21, height: 196,
  display: 'flex', flexDirection: 'column',
  border: `1px solid ${C.border}`, borderRadius: 10, background: 'rgba(6,26,47,.82)', padding: '8px 10px',
  boxSizing: 'border-box',
}
const miniBtn: CSSProperties = {
  padding: '3px 10px', fontSize: 11.5, cursor: 'pointer', borderRadius: 6,
  background: 'rgba(10,20,36,.7)', border: `1px solid ${C.border}`, color: C.text,
}
const primaryBtn: CSSProperties = {
  padding: '6px 22px', fontSize: 13, cursor: 'pointer', borderRadius: 8, whiteSpace: 'nowrap',
  letterSpacing: 0.5, border: '1px solid rgba(37,99,235,.8)',
  background: 'linear-gradient(180deg,#2563eb,#1d4ed8)', color: '#eaf3ff',
}
const ghostBtn: CSSProperties = {
  padding: '6px 18px', fontSize: 12.5, cursor: 'pointer', borderRadius: 8, whiteSpace: 'nowrap',
  background: 'rgba(10,20,36,.75)', border: `1px solid ${C.borderStrong}`, color: C.text,
}
const ghostDisabled: CSSProperties = {
  padding: '6px 18px', fontSize: 12.5, cursor: 'not-allowed', borderRadius: 8, whiteSpace: 'nowrap',
  background: 'rgba(10,20,36,.5)', border: `1px solid ${C.border}`, color: C.unknown,
}

export default SummaryScreen
