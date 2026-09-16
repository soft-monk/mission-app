// mission-app · apps/web/src/screens/SummaryScreen.tsx
//
// Excel 步 11 · 任务总结（参考图 `T7-1.png` 毁伤评估地图 / `T7-2.png` 任务总结）。
//
// 数据面只有一条命令：`report.generate{}`（宿主 = report-engine `generate` + alert-engine `counts`
// + store `query`）。本屏把它拆成四块如实渲染：
//   · **报告卡**：字段与分组**以返回结构为准**（`document.groups[].fields[]`）——
//     每个字段显示 `text`（引擎已格式化）+ `source{engine,path}`（RPT-SCHEMA-02 的溯源），
//     `missing=true` 的**把宿主给的原因显示出来**（缺失标记 / 来源模块 / 引擎 missing[] 清单），
//     绝不用 0 顶替（RPT-SCHEMA-03）。
//   · **时间轴**：`durations`（phase-engine 的逐阶段耗时）——段数与顺序**原样**，前端不自己算。
//   · **预警次数**：alert-engine 的计数**原样**（并标出 `basis` 声明取的是哪个口径）。
//   · **导出/复看**：只做"把报告 JSON 显示出来"（复制到剪贴板 + 展开原文），**不做文件下载**、
//     不伪造"已导出报告 xx.pdf"。
//
// ★ 纪律：拿不到的字段写"—/未就绪 + code"；这条 verb 未实现时把宿主原话摆在最显眼处，
//   并明确写出"报告未生成"，不画假数字、不画假时间轴。
//
// 地图（T7-1 的"毁伤评估"部分）：本屏只把**台账目标**按引擎状态重画一遍
//   （已被判失效的用 `theme` 的 muted 灰、其余按状态色），**不编残余威胁点、不编回收轨迹/
//   复核航线**——那三类几何宿主没给（契约里步 11 只有 `report.generate` 一条 verb），
//   谁画谁就是编数据。
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { DEFAULT_INSTANCE_ID, getMapInstance, MapDraw, type PrimitiveKind } from 'map-2d'
import { C, panel, panelTitle, statusColor } from '../theme'
import type { CommandReply, FlowState } from '../api'
import type { UseFlow } from '../flow/useFlow'
import { n2s, replyText, useVerbOnce } from '../flow/useSituation'
import { readTargets } from '../flow/useOps'
import {
  alertCountOf, dynamicStateName, isStruckState, missingReason, msText,
  readAlertCounts, readDurations, readReport,
  type DurationsView, type ReportFieldView, type ReportView,
} from '../flow/useExec'
import { VerbVerdict } from './VerbVerdict'
import { StageOverlay, StageStrip } from './StageOverlay'

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
  title: React.ReactNode
  children: React.ReactNode
  testid?: string
  right?: React.ReactNode
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

/** 一个报告字段的显示值：缺失 → 缺失标记（`—`），**不显示 0**。 */
function fieldValue(f: ReportFieldView): string {
  if (f.missing) return f.missingMarker ?? f.text ?? '—'
  const t = f.text
  return f.unit && !t.includes(f.unit) ? `${t} ${f.unit}` : t
}

/** 时间轴一段（phase-engine 的 `perPhase[]`，逐段显示）。 */
function SegCard({ seg, index }: { seg: DurationsView['segs'][number]; index: number }) {
  return (
    <div
      data-testid="p6-timeline-seg"
      data-seg-key={seg.key}
      data-seg-phase={seg.phase}
      data-seg-dwell={seg.dwellMs !== undefined ? String(seg.dwellMs) : ''}
      title={[seg.phase, msText(seg.dwellMs)].join(' · ')}
      style={{
        // `minWidth` + `flexShrink:0`：段数多（实测最多 12 段）时**横向滚动**，
        // 而不是把每张卡压到 20 px、把「0 ms」拆成两行（review 截图里踩到过）。
        flex: '1 0 auto', minWidth: 68, maxWidth: 132, display: 'flex', flexDirection: 'column', gap: 2,
        border: `1px solid ${seg.current ? C.borderStrong : C.border}`, borderRadius: 8,
        background: seg.current ? 'rgba(29,78,216,.28)' : 'rgba(10,32,58,.6)', padding: '6px 8px', overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
        <span style={{ width: 11, height: 11, borderRadius: '50%', flex: '0 0 auto', marginTop: 2, background: seg.current ? C.accent : 'rgba(95,176,255,.35)', border: `1px solid ${C.border}` }} />
        <span data-testid="p6-timeline-seg-phase" style={{ fontSize: 13.5, color: C.accent, whiteSpace: 'nowrap' }}>{seg.phase}</span>
        <span style={{ fontSize: 10.5, color: C.textDim }}>#{seg.seq ?? index + 1}</span>
      </div>
      <div data-testid="p6-timeline-seg-dwell" style={{ fontSize: 12.5, color: C.text, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
        {msText(seg.dwellMs)}
      </div>
      <div style={{ fontSize: 9.5, color: C.textDim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        dwellMs={seg.dwellMs ?? '—'}
      </div>
      <div style={{ fontSize: 9.5, color: C.textDim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        进 {seg.enteredAt !== undefined ? new Date(seg.enteredAt).toLocaleTimeString() : '—'}
      </div>
      <div style={{ fontSize: 9.5, color: C.textDim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        出 {seg.leftAt !== undefined ? new Date(seg.leftAt).toLocaleTimeString() : '（进行中）'}
      </div>
      {seg.current && <div style={{ fontSize: 9.5, color: C.accent, whiteSpace: 'nowrap' }}>当前阶段</div>}
    </div>
  )
}

/** 中心结果卡里的一张"关键数值"卡（只显示引擎给了数的字段）。 */
function BigValue({ f }: { f: ReportFieldView }) {
  return (
    <div
      data-testid="p6-big-value"
      data-field-key={f.key}
      data-missing={f.missing ? '1' : '0'}
      style={{
        flex: '1 1 0', minWidth: 0, border: `1px solid ${f.missing ? C.border : C.borderStrong}`, borderRadius: 9,
        background: 'rgba(10,32,58,.62)', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 2,
      }}
    >
      <div style={{ fontSize: 11, color: C.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</div>
      <div style={{ fontSize: 20, color: f.missing ? C.muted : C.accent, fontVariantNumeric: 'tabular-nums', lineHeight: 1.15 }}>
        {fieldValue(f)}
      </div>
      <div style={{ fontSize: 9.5, color: C.textDim }}>
        {f.source.engine ?? '—'}{f.source.path ? ` · ${f.source.path}` : ''}
      </div>
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
        <span
          data-testid="p6-field-value"
          style={{ fontSize: 12, color: f.missing ? C.muted : C.text, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
        >{fieldValue(f)}</span>
        {f.missing && <span style={{ fontSize: 9.5, color: C.warn, whiteSpace: 'nowrap' }}>缺失</span>}
      </div>
      <div style={{ fontSize: 9.5, color: C.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        来源 {f.source.engine ?? '—'}{f.source.path ? ` / ${f.source.path}` : ''}{f.source.compute ? ` · ${f.source.compute}` : ''}
      </div>
      {/* ↓ 无数据时必须写出**宿主给的原因**（MUST NOT 显示成空白的 0） */}
      {f.missing && (
        <div data-testid="p6-field-missing-reason" style={{ fontSize: 9.5, color: C.warn, lineHeight: 1.45 }}>
          {missingReason(f, rv)}
        </div>
      )}
      {/* 列表型字段（逐目标结果这类）：行数按引擎给的来，超限截断要如实说 */}
      {f.list && f.list.cells.length > 0 && (
        <div data-testid="p6-field-list" style={{ fontSize: 9.5, color: C.textDim, marginTop: 1 }}>
          {f.list.columns.length > 0 && <span>{f.list.columns.join(' / ')} · </span>}
          行 {f.list.rowsShown ?? f.list.cells.length}/{f.list.rowsTotal ?? '—'}
          {f.list.truncated ? '（引擎截断）' : ''}
          <div style={{ color: C.text }}>
            {f.list.cells.slice(0, 8).map((c) => `${c.key}=${c.missing ? '—' : c.text}`).join(' · ')}
          </div>
        </div>
      )}
    </div>
  )
}

export function SummaryScreen({ state, flow, onBack }: {
  state: FlowState
  flow: UseFlow
  /** 回步 10（切步一律发 `flow.goto`；本屏不自己改 step） */
  onBack?: () => void
}) {
  // ---- 唯一一条命令：`report.generate{}`（幂等由宿主保证）----
  const rep = useVerbOnce(flow, 'report.generate', {}, true)
  const rv: ReportView = useMemo(() => readReport(rep.data), [rep.data])
  const dv: DurationsView = useMemo(() => readDurations(rep.data), [rep.data])
  const av = useMemo(() => readAlertCounts(rep.data), [rep.data])
  const alertPick = alertCountOf(av)

  // **实测形状先落一条日志**（排障用：控制台里能看到宿主到底给了什么结构）
  useEffect(() => {
    if (rep.reply === null) return
    console.log('[report.generate] 实测回执', JSON.parse(JSON.stringify(rep.reply)))
  }, [rep.reply])

  // ---- `report.ready` 事件到达 → 重取一次（报告可能刚落盘）----
  const readyTs = flow.events['report.ready']?.ts ?? 0
  const lastReadyRef = useRef(0)
  const resendRef = useRef(rep.resend)
  resendRef.current = rep.resend
  useEffect(() => {
    if (!readyTs || readyTs === lastReadyRef.current) return
    lastReadyRef.current = readyTs
    resendRef.current()
  }, [readyTs])

  // ---- 中心结果卡：取"有数值的字段"前 4 个（读不到就空着，卡片区如实写未就绪）----
  const bigValues = useMemo(() => {
    const out: ReportFieldView[] = []
    for (const g of rv.groups) {
      for (const f of g.fields) {
        if (!f.missing && f.value !== undefined && out.length < 4) out.push(f)
      }
    }
    return out
  }, [rv])

  // ---- 关键结果 / 后续处置：按**字段 key 关键字**从报告里找（找不到就说"报告里没有这一段"）----
  const pickByKeys = (needles: string[], limit = 5): ReportFieldView[] => {
    const out: ReportFieldView[] = []
    for (const g of rv.groups) {
      for (const f of g.fields) {
        const hay = `${f.key} ${f.name} ${g.key} ${g.name}`.toLowerCase()
        if (needles.some((n) => hay.includes(n)) && out.length < limit) out.push(f)
      }
    }
    return out
  }
  const keyResults = useMemo(() => pickByKeys(['success', 'rate', 'efficiency', 'link', 'coverage', 'duration', '组网', '成功', '效率', '链路', '覆盖'], 5), [rv])
  const nextSteps = useMemo(() => pickByKeys(['resource', 'release', 'recover', 'follow', '撤收', '释放', '转移', '处置'], 4), [rv])

  // ---- AI 摘要：报告里"文本类"字段（引擎已本地化）----
  const aiSummary = useMemo(() => {
    const out: string[] = []
    for (const g of rv.groups) {
      for (const f of g.fields) {
        if (f.value === undefined && !f.missing && f.text && out.length < 4
          && ['summary', 'advice', 'conclusion', 'note', 'comment', '摘要', '建议', '结论'].some((n) => `${f.key}${f.name}`.toLowerCase().includes(n))) {
          out.push(f.text)
        }
      }
    }
    return out
  }, [rv])

  // ---- 台账目标（步 11 的地图）：状态只用于**上色**，不作为报告字段的来源 ----
  const tlist = useVerbOnce(flow, 'targets.list', {}, true)
  const tl = useMemo(() => readTargets(tlist.data), [tlist.data])
  const struckTargets = useMemo(() => tl.items.filter((t) => isStruckState(t.status, t.motion)), [tl])

  /** 本屏在地图上画的图元（前缀 `RPT6:`）：只画台账里给了坐标的目标 */
  const drawnRef = useRef<{ kind: PrimitiveKind; id: string }[]>([])
  useEffect(() => {
    const prev = drawnRef.current
    const next: { kind: PrimitiveKind; id: string }[] = []
    MapDraw.batch(() => {
      for (const d of prev) MapDraw.remove(d.kind, d.id)
      for (const t of tl.items) {
        if (t.lng === undefined || t.lat === undefined) continue      // 没坐标 → 不画（不编坐标）
        const struck = isStruckState(t.status, t.motion)
        const id = `RPT6:${t.entityId}`
        MapDraw.add('target', {
          id, lng: t.lng, lat: t.lat,
          // 与步 10 同一口径：**已处置（dynamicState=struck/destroyed）→ 灰**；
          // 否则按 `status` 域映射（`status=gray` 只表示低威胁档，不等于已失效）
          color: isStruckState(t.status, t.motion) ? C.muted : (t.status ? statusColor(t.status) : C.unknown),
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

  const [showJson, setShowJson] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const jsonText = useMemo(() => {
    try { return JSON.stringify(rep.reply ?? null, null, 2) } catch { return '(回执无法序列化)' }
  }, [rep.reply])

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

  const code = rep.reply?.code
  const ok = code === 0
  const notImpl = code === 1000 || code === 1005

  return (
    <>
      {/* ---------------- 顶部压条 ---------------- */}
      <StageStrip
        items={[
          { k: '显示模式', v: '复核态势 / 结果汇总' },
          { k: '阶段', v: state.phase || '—' },
          { k: '报告编号', v: rv.reportNo ?? '—', color: rv.reportNo ? C.text : C.textDim },
          { k: '生成时间', v: rv.generatedAt ?? '—' },
          { k: '结构版本', v: rv.schemaVersion ?? '—' },
          { k: '字段', v: `${rv.fieldCount}${rv.missingCount > 0 ? `（缺失 ${rv.missingCount}）` : ''}`, color: rv.missingCount > 0 ? C.warn : C.text },
        ]}
        right={<span style={{ color: ok ? C.textDim : (notImpl ? C.warn : C.bad) }}>
          {rep.reply === null ? '报告生成中…' : ok ? 'report.generate 已就绪' : `report.generate → ${replyText(rep.reply)}`}
        </span>}
      />

      {/* ---------------- 左栏：时间轴 + 预警次数 + 报告 JSON ---------------- */}
      <div style={leftColStyle}>
        {/* 时间轴：`durations`（phase-engine），逐段显示 */}
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
                  {rep.reply
                    ? (ok
                      ? 'report.generate 回了 code=0，但回执里没有 durations（段键/层级见右侧「报告 JSON」原文）'
                      : `report.generate → ${replyText(rep.reply)}`)
                    : '正在请求报告…'}
                </div>
              </div>
            )}
          </div>
          {(dv.missionId || dv.totalMs !== undefined || dv.startedAt !== undefined) && (
            <div style={{ fontSize: 10.5, color: C.textDim, padding: '0 12px 7px', lineHeight: 1.55 }}>
              {dv.missionId ? `任务 ${dv.missionId}` : ''}
              {dv.totalMs !== undefined ? ` · 总用时 ${msText(dv.totalMs)}（totalMs=${dv.totalMs}）` : ' · 总用时 —（引擎未给 totalMs）'}
              {dv.startedAt !== undefined ? ` · 起 ${new Date(dv.startedAt).toLocaleTimeString()}` : ''}
              {dv.endedAt !== undefined ? ` · 止 ${new Date(dv.endedAt).toLocaleTimeString()}` : '（endedAt 未给 = 进行中）'}
            </div>
          )}
          {dv.byPhase.length > 0 && (
            <div style={{ fontSize: 10.5, color: C.textDim, padding: '0 12px 7px', lineHeight: 1.55 }}>
              按阶段聚合：{dv.byPhase.slice(0, 8).map((b) => `${b.phase} ${msText(b.totalDwellMs)}×${b.visits ?? '—'}`).join(' · ')}
            </div>
          )}
        </div>

        {/* 预警次数：alert-engine 的计数**原样** */}
        <Section
          title="预警次数（alert-engine 计数）"
          testid="p6-alert-panel"
          right={av.basis ? `basis=${av.basis}` : '未声明 basis'}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span data-testid="p6-alert-count" data-alert-by={alertPick.by} style={{ fontSize: 26, color: alertPick.value === undefined ? C.muted : C.warn, fontVariantNumeric: 'tabular-nums' }}>
              {alertPick.value !== undefined ? alertPick.value : '—'}
            </span>
            <span style={{ fontSize: 11, color: C.textDim }}>{alertPick.by}</span>
          </div>
          {av.raw === null && (
            <div data-testid="p6-alert-empty" style={{ fontSize: 11, color: C.warn, lineHeight: 1.6 }}>
              宿主回执里没有 alert-engine 的 counts 段 → 显示"—"（**不填 0**：0 与"没有这段数据"是两回事）。
              实测形状见右侧「报告 JSON」原文。
            </div>
          )}
          {av.raw !== null && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 12px', marginTop: 4 }}>
              {([['alertCount', av.alertCount], ['rawRaises', av.rawRaises], ['alertsRaised', av.alertsRaised],
                ['merged', av.merged], ['recoveries', av.recoveries], ['aggregates', av.aggregates],
                ['suppressed', av.suppressed], ['folded', av.folded], ['openActive', av.openActive]] as const).map(([k, v]) => (
                <span key={k} data-testid="p6-alert-metric" data-metric={k} style={{ fontSize: 10.5, color: C.textDim }}>
                  {k}=<span style={{ color: C.text }}>{v !== undefined ? v : '—'}</span>
                </span>
              ))}
            </div>
          )}
          <div style={{ fontSize: 10, color: C.textDim, marginTop: 3, lineHeight: 1.5 }}>
            口径由引擎的 `basis` 声明（deduplicated / raw 两套同时在案，前端不挑、不换算）。
            {flow.events['alert.raised'] ? ` 最近一条 alert.raised：${String(flow.events['alert.raised'].data.level ?? '—')} · ${String(flow.events['alert.raised'].data.ruleId ?? '—')}` : ''}
          </div>
        </Section>

        {/* 报告生成进度 / 推送与风险：报告里"有就显示"的状态字段 */}
        <Section title="报告生成状态" testid="p6-report-status-panel">
          <Row k="生成结果" v={rep.reply ? (ok ? `code=0（${rv.engineMessage ?? 'ok'}）` : `code=${code} ${replyText(rep.reply)}`) : '未发送'} color={ok ? C.ok : C.warn} />
          <Row k="渲染" v={rv.render ? `ok=${rv.render.ok ? 'true' : 'false'} · ${rv.render.format ?? '—'} · ${rv.render.bytes ?? '—'} B${rv.render.reason ? `（${rv.render.reason}）` : ''}` : '—'} />
          <Row k="归档" v={rv.archive?.fileName ?? '—'} />
          <Row k="编号" v={rv.numbering ? `${rv.numbering.dayKey ?? '—'} #${rv.numbering.seq ?? '—'}${rv.numbering.present ? '（已落库）' : '（引擎 numbering.present=false）'}` : '—'} />
          <Row k="时间口径" v={rv.timeBasisName ?? rv.timeBasis ?? '—'} />
          <Row k="缺失字段" v={rv.missingKeys.length ? rv.missingKeys.join('、') : (rv.fieldCount > 0 ? '（引擎未列 missing[]）' : '—')} color={rv.missingKeys.length ? C.warn : C.text} />
          {rv.warnings.slice(0, 3).map((t, i) => (
            <div key={i} style={{ fontSize: 10.5, color: C.warn, lineHeight: 1.55 }}>· {t}</div>
          ))}
          {!ok && (
            <div data-testid="p6-report-notready" style={{ fontSize: 11, color: C.warn, lineHeight: 1.65, marginTop: 3 }}>
              报告未生成：{rep.reply ? replyText(rep.reply) : '正在请求…'}
              {notImpl ? '（宿主侧 report.generate 尚未实现/装配 —— 界面按"未就绪 + code"如实呈现，未画出任何报告字段与时间轴）' : ''}
            </div>
          )}
        </Section>

        {/* 导出/复看：只做"把报告 JSON 显示出来" */}
        <Section
          title="报告 JSON（复看 / 导出）"
          testid="p6-json-panel"
          right={rv.doc ? 'document 已读到' : 'document 未读到'}
        >
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button data-testid="p6-btn-json" style={miniBtn} onClick={() => void exportJson('复看报告')}>
              {showJson ? '收起 JSON' : '复看报告 JSON'}
            </button>
            <button data-testid="p6-btn-copy" style={miniBtn} onClick={() => void exportJson('导出报告')}>导出任务报告（复制 JSON）</button>
          </div>
          {copied && <div data-testid="p6-copy-note" style={{ fontSize: 10.5, color: C.accent, marginTop: 4, lineHeight: 1.55 }}>{copied}</div>}
          <div style={{ fontSize: 10, color: C.textDim, marginTop: 3, lineHeight: 1.5 }}>
            本轮不做文件下载（不生成 PDF/DOCX，也不谎报"已导出"）；这里显示的就是 `/api/command` 的**原始回执**。
          </div>
          {showJson && (
            <pre
              data-testid="p6-report-json"
              style={{
                marginTop: 6, maxHeight: 240, overflow: 'auto', fontSize: 10, lineHeight: 1.45,
                background: 'rgba(4,24,47,.9)', border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 8px',
                color: C.text, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
              }}
            >{jsonText}</pre>
          )}
        </Section>
      </div>

      {/* ---------------- 右栏：AI 摘要 / 关键结果 / 后续处置 / 报告字段 ---------------- */}
      <div style={rightColStyle}>
        <Section
          title="目标状态（毁伤评估）"
          testid="p6-struck-panel"
          right={tlist.reply?.code === 0 ? `${struckTargets.length}/${tl.items.length} 已失效` : '台账未就绪'}
        >
          {struckTargets.length === 0 && (
            <div data-testid="p6-struck-empty" style={{ fontSize: 11.5, color: C.textDim, lineHeight: 1.7 }}>
              {tlist.reply?.code === 0
                ? `台账里没有"已失效"的目标（status/dynamicState 一栏都没判灰）→ 图上不变灰（前端不自己判命中）。`
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
            状态取自 `targets.list`（源头 entity-ledger 台账）；残余威胁点 / 回收轨迹 / 复核航线
            三类几何宿主未给 → **不画**（不编几何）。
          </div>
        </Section>

        <Section title="AI 摘要" testid="p6-ai-panel">
          {aiSummary.length > 0
            ? aiSummary.map((t, i) => <div key={i} data-testid="p6-ai-line" style={{ fontSize: 11.5, color: C.text, lineHeight: 1.7 }}>· {t}</div>)
            : (
              <div data-testid="p6-ai-empty" style={{ fontSize: 11.5, color: C.textDim, lineHeight: 1.7 }}>
                报告里没有文本类摘要字段
                {ok ? '（引擎的规则包未声明摘要字段 —— 不编一段"主要威胁节点已清除"之类的话）' : `（${rep.reply ? replyText(rep.reply) : '报告未生成'}）`}
              </div>
            )}
          {rv.title && <div style={{ fontSize: 11, color: C.accent, marginTop: 4 }}>{rv.title}</div>}
          {rv.footer && <div style={{ fontSize: 10, color: C.textDim, marginTop: 2 }}>{rv.footer}</div>}
        </Section>

        <Section title="关键结果" testid="p6-key-panel" right={`${rv.groups.length} 个分组`}>
          {keyResults.length > 0
            ? keyResults.map((f) => <FieldRow key={f.key} f={f} rv={rv} />)
            : <div data-testid="p6-key-empty" style={{ fontSize: 11.5, color: C.textDim, lineHeight: 1.7 }}>报告里没有"成功率 / 组网时长 / 推送结果"这类字段（按字段名找的，找不到就如实空着）。</div>}
        </Section>

        <Section title="后续处置" testid="p6-next-panel">
          {nextSteps.length > 0
            ? nextSteps.map((f) => <FieldRow key={f.key} f={f} rv={rv} />)
            : <div data-testid="p6-next-empty" style={{ fontSize: 11.5, color: C.textDim, lineHeight: 1.7 }}>报告里没有"资源撤收 / 链路释放 / 部署转移"这类字段。</div>}
        </Section>

        {/* 报告全字段（按引擎给的分组与顺序；缺失带原因） */}
        <Section
          title="报告字段（按引擎分组）"
          testid="p6-report-panel"
          right={ok ? `${rv.groups.length} 组 / ${rv.fieldCount} 字段` : '未就绪'}
        >
          {!ok && (
            <div data-testid="p6-report-empty" style={{ fontSize: 11.5, color: C.warn, lineHeight: 1.7 }}>
              报告未就绪：{rep.reply ? replyText(rep.reply) : '正在请求 report.generate…'}
              <div style={{ color: C.textDim, marginTop: 3 }}>
                本屏不预置任何字段名与数值 —— 分组与字段**以 `report.generate` 的返回结构为准**。
              </div>
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
              report.generate 回了 code=0，但回执里没有任何分组/字段（document 未读到）。
              界面不补字段、不补数值；请对照右侧「报告 JSON」原文的层级。
            </div>
          )}
        </Section>

        <VerbVerdict
          title="报告命令"
          rows={[{ verb: 'report.generate', reply: rep.reply, busy: rep.busy, onRetry: rep.resend, okNote: `${rv.fieldCount} 字段 / ${dv.segs.length} 段时间轴 / 预警 ${alertPick.value ?? '—'}` }]}
        />
      </div>

      {/* ---------------- 中心结果卡 ---------------- */}
      <div style={cardStyle}>
        <div style={{ ...panel, width: '100%', height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
          <div style={panelTitle}>
            任务结果
            <span style={{ float: 'right', fontSize: 11.5, color: C.textDim }}>
              {rv.reportNo ? `报告 ${rv.reportNo}` : (ok ? '报告已生成（未给编号）' : '报告未生成')}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8, padding: '9px 10px', flex: 1, minHeight: 0, overflowX: 'auto' }}>
            {bigValues.map((f) => <BigValue key={f.key} f={f} />)}
            {bigValues.length === 0 && (
              <div data-testid="p6-big-empty" style={{ margin: 'auto', fontSize: 12, color: C.textDim, lineHeight: 1.8, textAlign: 'center' }}>
                <div>结果卡未就绪：需要 `report.generate` 返回带数值的报告字段。</div>
                <div style={{ color: notImpl ? C.warn : C.textDim }}>
                  {rep.reply ? (ok ? '回执 code=0 但没有「非缺失且有 value」的字段' : replyText(rep.reply)) : '正在请求…'}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ---------------- 底部按钮条 ---------------- */}
      <div style={bottomStyle}>
        {onBack && <button data-testid="p6-btn-back" style={ghostBtn} onClick={onBack}>返回协同执行</button>}
        <button data-testid="p6-btn-export" style={primaryBtn} onClick={() => void exportJson('导出任务报告')}>导出任务报告</button>
        <button data-testid="p6-btn-refresh" style={ghostBtn} onClick={rep.resend} disabled={rep.busy}>{rep.busy ? '生成中…' : '重新生成报告'}</button>
        <span style={{ fontSize: 10.5, color: C.textDim, whiteSpace: 'nowrap' }}>
          步 {state.step}/11{state.phase ? ` · ${state.phase}` : ''}
        </span>
      </div>

      <P6SummaryProbe
        step={state.step}
        phase={state.phase}
        reply={rep.reply}
        rv={rv}
        dv={dv}
        alertsRaw={av.raw}
        alertValue={alertPick.value ?? null}
        alertBy={alertPick.by}
        showJson={showJson}
        replies={flow.replies}
        lastReply={flow.lastReply}
        eventKeys={Object.keys(flow.events)}
        struckCount={struckTargets.length}
        targetCount={tl.items.length}
      />
    </>
  )
}

/** 本屏在地图上画了什么（**只读**：`MapDraw.list` 快照，不改渲染）。 */
function mapCounts(): Record<string, unknown> {
  const targets = MapDraw.list('target') as unknown as { id: string; color?: string; status?: string; lng: number; lat: number }[]
  const mine = targets.filter((t) => t.id.startsWith('RPT6:'))
  const map = getMapInstance(DEFAULT_INSTANCE_ID)
  return {
    mine: mine.length,
    targetTotal: targets.length,
    items: mine.map((t) => ({ id: t.id, color: t.color ?? null, status: t.status ?? null, visible: MapDraw.isVisible('target', t.id) })),
    drones: MapDraw.list('drone').length,
    viewport: map ? { lng: map.getCenter().lng, lat: map.getCenter().lat, zoom: map.getZoom() } : null,
  }
}

/** 把只读句柄挂到 `window.__p6Read`（步 11 补 `mapCounts`，步 10 的键保留）。 */
function installP6Read() {
  const w = window as unknown as { __p6Read?: Record<string, unknown> }
  w.__p6Read = { ...(w.__p6Read ?? {}), mapCounts }
}

/** 自证句柄：`window.__p6Stats`（步 11 部分，与步 10 的键合并在同一对象上）。 */
function P6SummaryProbe(props: {
  step: number
  phase: string
  reply: CommandReply | null
  rv: ReportView
  dv: DurationsView
  /** alert-engine 的计数原文（脚本对账"界面上那个数就是回执里那个数"） */
  alertsRaw: unknown
  alertValue: number | null
  alertBy: string
  showJson: boolean
  replies: Record<string, CommandReply>
  lastReply: CommandReply | null
  eventKeys: string[]
  struckCount: number
  targetCount: number
}) {
  const { step, phase, reply, rv, dv, alertsRaw, alertValue, alertBy, showJson, replies, lastReply, eventKeys, struckCount, targetCount } = props
  useEffect(() => { installP6Read() })
  const w = window as unknown as { __p6Stats?: Record<string, unknown> }
  w.__p6Stats = {
    ...(w.__p6Stats ?? {}),
    step,
    screen: 'summary',
    phase,
    report: {
      reply,
      /** 分组/字段/缺失（**逐字段**给脚本对账；值就是界面显示的那一份） */
      groups: rv.groups.map((g) => ({
        key: g.key, name: g.name, order: g.order ?? null,
        fields: g.fields.map((f) => ({
          key: f.key, name: f.name, unit: f.unit ?? null, text: f.text,
          missing: f.missing, missingMarker: f.missingMarker ?? null,
          value: f.value ?? null, source: f.source,
        })),
      })),
      groupCount: rv.groups.length,
      fieldCount: rv.fieldCount,
      missingCount: rv.missingCount,
      reportNo: rv.reportNo ?? null,
      generatedAt: rv.generatedAt ?? null,
      schemaVersion: rv.schemaVersion ?? null,
      archive: rv.archive ?? null,
      render: rv.render ?? null,
      missingKeys: rv.missingKeys,
      warnings: rv.warnings,
    },
    /** 时间轴（phase-engine `durations`）：段数与顺序**原样** */
    durations: {
      raw: dv.raw ?? null,
      segCount: dv.segs.length,
      segs: dv.segs.map((s) => ({ key: s.key, phase: s.phase, seq: s.seq ?? null, enteredAt: s.enteredAt ?? null, leftAt: s.leftAt ?? null, dwellMs: s.dwellMs ?? null, current: s.current ?? null })),
      totalMs: dv.totalMs ?? null,
      missionId: dv.missionId ?? null,
      /** 「时间轴段数 == 回执段数」的那两个数（脚本直接对账，见 .p6-ui.mjs 的断言） */
      receiptSegs: dv.segs.length,
      domSegs: document.querySelectorAll('[data-testid="p6-timeline-seg"]').length,
    },
    /** 预警计数：口径 + 值（与界面上那个数**同源**） */
    alerts: { value: alertValue, by: alertBy, raw: alertsRaw ?? null },
    /** 地图（本屏画的台账目标）：失效数与总数 */
    map: { struck: struckCount, targets: targetCount, counts: mapCounts() },
    showJson,
    replies: Object.fromEntries(Object.entries(replies ?? {}).map(([k, v]) => [k, { verb: v.verb, code: v.code, message: v.error?.message ?? null }])),
    lastReply: lastReply ? { verb: lastReply.verb, code: lastReply.code, message: lastReply.error?.message ?? null } : null,
    eventKeys,
    dom: {
      groups: document.querySelectorAll('[data-testid="p6-report-group"]').length,
      fields: document.querySelectorAll('[data-testid="p6-report-field"]').length,
      missingFields: Array.from(document.querySelectorAll('[data-testid="p6-report-field"]')).filter((el) => el.getAttribute('data-field-missing') === '1').length,
      missingReasons: document.querySelectorAll('[data-testid="p6-field-missing-reason"]').length,
      bigValues: document.querySelectorAll('[data-testid="p6-big-value"]').length,
      timelineSegs: document.querySelectorAll('[data-testid="p6-timeline-seg"]').length,
      alertCountText: document.querySelector('[data-testid="p6-alert-count"]')?.textContent ?? null,
      hasExport: !!document.querySelector('[data-testid="p6-btn-export"]'),
      jsonShown: !!document.querySelector('[data-testid="p6-report-json"]'),
      notReady: !!document.querySelector('[data-testid="p6-report-notready"]'),
      timelineEmpty: !!document.querySelector('[data-testid="p6-timeline-empty"]'),
    },
  }
  return null
}

// ---- 样式（一律 left/right/bottom 长写：**不写 inset 简写**）----
const leftColStyle: CSSProperties = {
  position: 'absolute', left: 12, top: 34, bottom: 58, zIndex: 20, width: 372,
  display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
}
const rightColStyle: CSSProperties = {
  position: 'absolute', right: 12, top: 34, bottom: 58, zIndex: 20, width: 300,
  display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
}
const cardStyle: CSSProperties = {
  position: 'absolute', left: 396, right: 324, bottom: 196, zIndex: 21, height: 158,
}
/**
 * 底栏按钮条：`bottom: 24` 是**算过的** —— 宿主底部有全局状态条
 * （`App.tsx` 的 `statusBarStyle`：`bottom:0; height:28`），贴底元素必须让开它。
 * 三个按钮 + 步号一行放得下（`nowrap`），免得换行把按钮顶出可视区。
 */
const bottomStyle: CSSProperties = {
  position: 'absolute', left: 396, right: 324, bottom: 24, zIndex: 22,
  display: 'flex', alignItems: 'center', gap: 9, height: 30, flexWrap: 'nowrap', overflow: 'hidden',
}
const miniBtn: CSSProperties = {
  padding: '3px 10px', fontSize: 11.5, cursor: 'pointer', borderRadius: 6,
  background: 'rgba(10,20,36,.7)', border: `1px solid ${C.border}`, color: C.text,
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

export default SummaryScreen
