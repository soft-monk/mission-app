// mission-app · apps/web/src/screens/LinkStableScreen.tsx
//
// SH-08「链路稳定界面」（需求专篇 DES-APP-001 §3 SH-08 / 参考图 `场景1\T2-2.png`）。
//
// 版式（照图）：与 SH-07 同构 —— 顶栏/左导航（全局壳）｜中区链路拓扑大图（同 T2-1 的固定拓扑）
//              ｜右栏「链路稳定评估」（贯通上下）｜底部通栏 4 张状态卡｜中区右下 2 枚按钮。
//
// ★ 本屏与 SH-07 的两处差别（照图，其余复用 `LinkTopologyScreen` 导出的组件）：
//   ① 右栏换成「链路稳定评估」：绿卡「当前网络稳定」+「前沿局部网络已建立」、**两条曲线**
//      （带宽提升曲线 / 时延降低曲线）、2×2 四张指标小卡；SH-07 的「AI链路分析」4 环 + 6 行指标不在本屏。
//   ② 底部「链路就绪」按图是本屏的强调项（值仍取引擎 `evaluation.inputs.linkUpRatio`，不抄图上的 100%）。
//
// ★ 两条曲线为什么不画数据点（**这一条最容易被"为了像图"而违反纪律**）：
//   宿主目前**没有历史采样接口**——`/api/state` 与 `topology.evaluate` 都只给"当前值"，
//   没有任何时序字段；而且本工程**带宽与时延本来就没有实测源**：
//     · `bandwidthMbps`：宿主 `notes[]` 明说"实测吞吐（throughputMbps）不是标称带宽，投进去会让
//       规则包把零丢包的链路判红"，所以 `metricDetail[].notIngested` 里逐条列着它；
//     · `latencyMs`：接入层不记录到货时延（报文 ts 是仿真时间，60 倍速下与挂钟不可比）。
//   所以本屏**照图画轴、但不画线**，并把"采样点数 / 为什么没有点"逐条写在曲线下面；
//   一旦引擎给出当前读数（哪怕只有一个点）就会画成**单点**并标注"仅一个采样点：引擎未提供历史序列"。
//   MUST NOT 编造一条好看的上升/下降曲线。
import { useMemo, type CSSProperties } from 'react'
import { C, panel, panelTitle } from '../theme'
import type { FlowState } from '../api'
import type { UseFlow } from '../flow/useFlow'
import { isObj, n2s, num, objList, str } from '../flow/useSituation'
import {
  evalItemOf, LinkActionButtons, LinkBottomCards, missingReasonFor, qualityRows, RING_SLOTS,
  SimControlStrip, TopologyGraph, useLinkReadings, type LinkReadings,
} from './LinkTopologyScreen'
import { VerbVerdict } from './VerbVerdict'

// ============================================================================
// ① 曲线读数（当前值 = 引擎给的；历史序列 = 引擎没有 → 就一个点，甚至 0 个点）
// ============================================================================

export interface SeriesRead {
  key: string
  name: string
  /** 采样点（引擎只给当前值时最多 1 个；**没有就不画**） */
  points: number[]
  unit?: string
  /** 曲线标题下如实写的那句话 */
  reason: string
  /** 引擎是否给了当前读数 */
  hasCurrent: boolean
}

/** 汇总某指标在所有链路 `metrics[]` 里的读数（`last` 优先，与其余屏同口径）。 */
function linkMetricValues(rd: LinkReadings, keys: string[]): { vals: number[]; unit?: string } {
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

/** 宿主 `notes[]` 里与某字段相关的那一条（拿不到就 undefined —— 不编原因）。 */
function noteOf(notes: string[], ...needles: string[]): string | undefined {
  return notes.find((n) => needles.some((x) => n.toLowerCase().includes(x.toLowerCase())))
}

/** 带宽提升曲线（纵轴 100%/50%/0%，横轴 00:00/05:00/10:00/15:00 —— 刻度照图）。 */
export function readBandwidthSeries(rd: LinkReadings): SeriesRead {
  const { vals, unit } = linkMetricValues(rd, ['bandwidthMbps', 'bandwidth'])
  const notIngested = rd.metricDetail.filter((r) => r.notIngested.includes('bandwidthMbps')).length
  return {
    key: 'bandwidth',
    name: '带宽提升曲线',
    points: vals.slice(0, 1),
    unit: unit ?? 'Mbps',
    hasCurrent: vals.length > 0,
    reason: vals.length > 0
      ? `仅一个采样点：引擎未提供历史序列（${vals.length} 条链路有带宽读数，取首条当前值 ${n2s(vals[0])} ${unit ?? 'Mbps'}）`
      : `0 个采样点：引擎既未提供历史序列，也没有当前带宽读数 —— ${missingReasonFor(rd, 'bandwidthMbps', '带宽')}${notIngested > 0 ? '' : ''}`,
  }
}

/** 时延降低曲线（纵轴 120ms/60ms/0ms，横轴同上）。 */
export function readLatencySeries(rd: LinkReadings): SeriesRead {
  const { vals, unit } = linkMetricValues(rd, ['latencyMs', 'latency', 'delayMs'])
  return {
    key: 'latency',
    name: '时延降低曲线',
    points: vals.slice(0, 1),
    unit: unit ?? 'ms',
    hasCurrent: vals.length > 0,
    reason: vals.length > 0
      ? `仅一个采样点：引擎未提供历史序列（取首条当前值 ${n2s(vals[0])} ${unit ?? 'ms'}）`
      : `0 个采样点：引擎既未提供历史序列，也没有当前时延读数 —— ${missingReasonFor(rd, 'latencyMs', '时延')}`,
  }
}

// ============================================================================
// ② 曲线控件（SVG 折线；几个点画几个点，0 个点就只画轴 + 写明原因）
// ============================================================================

function Curve({ series, testid, yTicks, yMax, unit, color = C.ok }: {
  series: SeriesRead
  testid: string
  /** 纵轴刻度（自上而下，照图） */
  yTicks: string[]
  /** 纵轴满量程（用于把当前值换算到画布 y） */
  yMax: number
  unit: string
  color?: string
}) {
  const W = 292
  const H = 92
  const padL = 38
  const padB = 18
  const padT = 6
  const xTicks = ['00:00', '05:00', '10:00', '15:00']
  const plotW = W - padL - 8
  const plotH = H - padB - padT
  const x = (i: number, n: number) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW)
  const y = (v: number) => padT + plotH - Math.max(0, Math.min(1, v / yMax)) * plotH
  const n = series.points.length
  const pts = series.points.map((v, i) => `${x(i, n).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  return (
    <div
      data-testid={testid}
      data-samples={n}
      data-has-current={series.hasCurrent ? '1' : '0'}
      style={{ ...panel, boxSizing: 'border-box', marginBottom: 8 }}
    >
      <div style={{ ...panelTitle, fontSize: 12, padding: '6px 11px' }}>
        {series.name}
        <span style={{ float: 'right', color: series.hasCurrent ? C.ok : C.warn, fontSize: 10.5 }}>
          采样点 {n}
        </span>
      </div>
      <div style={{ padding: '6px 8px 4px' }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: H }}>
          {/* 轴：刻度照图（纵轴 3 档、横轴 4 档） */}
          {yTicks.map((t, i) => (
            <g key={t}>
              <line
                x1={padL} y1={padT + (i / (yTicks.length - 1)) * plotH}
                x2={W - 8} y2={padT + (i / (yTicks.length - 1)) * plotH}
                stroke="rgba(95,176,255,.16)" strokeWidth="1"
              />
              <text x={padL - 5} y={padT + (i / (yTicks.length - 1)) * plotH + 3.5} textAnchor="end" fill={C.textDim} fontSize="9">
                {t}
              </text>
            </g>
          ))}
          {xTicks.map((t, i) => (
            <text key={t} x={padL + (i / (xTicks.length - 1)) * plotW} y={H - 4} textAnchor="middle" fill={C.textDim} fontSize="9">
              {t}
            </text>
          ))}
          {/* 折线：只有真读数才画（1 个点 = 单点；0 个点 = 只画轴） */}
          {n >= 2 && <polyline points={pts} fill="none" stroke={color} strokeWidth="2" />}
          {n >= 1 && series.points.map((v, i) => (
            <circle key={i} cx={x(i, n)} cy={y(v)} r="3" fill={color} stroke="#04121f" strokeWidth="1" />
          ))}
          {n === 0 && (
            <text x={padL + plotW / 2} y={padT + plotH / 2} textAnchor="middle" fill={C.warn} fontSize="10.5">
              无数据点（引擎未提供该指标读数与历史序列）
            </text>
          )}
          {n === 1 && (
            <text x={padL + plotW / 2 + 8} y={padT + plotH / 2 - 6} textAnchor="middle" fill={C.ok} fontSize="9.5">
              仅一个采样点（{n2s(series.points[0])} {unit}）
            </text>
          )}
        </svg>
        <div
          title={series.reason}
          style={{ fontSize: 10, color: n > 0 ? C.textDim : C.warn, lineHeight: '14px', maxHeight: 28, overflow: 'hidden' }}
        >{series.reason}</div>
      </div>
    </div>
  )
}

// ============================================================================
// ③ 右栏「链路稳定评估」（照图）
// ============================================================================

/** 绿卡：结论只在引擎全项达标时给出；「前沿局部网络已建立」只在引擎给了组网进度时给。 */
function StableCard({ rd }: { rd: LinkReadings }) {
  const unmet = rd.evalItems.filter((i) => i.satisfied === false)
  const allOk = rd.evalItems.length > 0 && unmet.length === 0
  const mesh = rd.inputs['meshProgress']
  const st = evalItemOf(rd, ['stability'])
  return (
    <div data-testid="sh08-stable-card" style={{
      border: `1px solid rgba(34,197,94,.55)`, borderRadius: 9, padding: '10px 11px',
      background: 'linear-gradient(180deg, rgba(22,101,52,.42), rgba(10,32,58,.55))',
    }}>
      <div style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
        <svg viewBox="0 0 24 24" style={{ width: 28, height: 28, flex: '0 0 auto' }}>
          <path d="M12 2.5 20 6v6.2c0 4.6-3.3 8.1-8 9.3-4.7-1.2-8-4.7-8-9.3V6z" fill="rgba(34,197,94,.18)" stroke="#22c55e" strokeWidth="1.5" />
          <path d="M8.2 12.2 11 15l5-5.4" fill="none" stroke="#bff7d2" strokeWidth="1.8" />
        </svg>
        <div style={{ minWidth: 0 }}>
          <div data-testid="sh08-stable-title" style={{ fontSize: 16, color: rd.evalItems.length === 0 ? C.textDim : allOk ? C.ok : C.warn }}>
            {rd.evalItems.length === 0 ? '—（未就绪）' : allOk ? '当前网络稳定' : '当前网络未全项达标'}
          </div>
          <div data-testid="sh08-stable-sub" style={{ fontSize: 11.5, color: C.textDim, lineHeight: 1.45 }}>
            {mesh !== undefined && mesh > 0
              ? `前沿局部网络已建立（engine meshProgress=${n2s(Number(mesh.toFixed(1)))}%）`
              : `前沿局部网络：引擎未给 meshProgress → 不给这一结论`}
          </div>
        </div>
      </div>
      <div style={{ fontSize: 10, color: C.textDim, lineHeight: 1.5, marginTop: 5 }}>
        {rd.evalItems.length === 0
          ? '结论口径：`evaluation.items[]` 未就绪 → 界面不给"当前网络稳定"这类结论。'
          : allOk
            ? `结论口径：evaluation.items[] 全项 requirement.satisfied=true（${rd.evalItems.length} 项）；链路稳定度 stability=${st?.value ?? '—'}（尺度 ${st?.scaleMin ?? '—'}–${st?.scaleMax ?? '—'}）。`
            : `${unmet.length}/${rd.evalItems.length} 项未满足：${unmet.map((i) => `${i.cn}(${i.reqMetric ?? '—'} ${i.reqOp ?? ''} ${i.reqLimit ?? '—'} vs ${i.reqActual ?? '—'})`).join('；')}`}
      </div>
    </div>
  )
}

/** 2×2 指标小卡（4 项 = `evaluation.items[]`；缺项画灰 + 「—」）。 */
function MetricGrid({ rd }: { rd: LinkReadings }) {
  return (
    <div data-testid="sh08-metrics" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7 }}>
      {RING_SLOTS.map((slot) => {
        const it = evalItemOf(rd, slot.keys)
        const pct = it?.value === undefined ? undefined : (it.scaleMax !== undefined && it.scaleMax <= 1) || it.value <= 1
          ? Number((it.value * 100).toFixed(1))
          : it.value
        const color = it === undefined ? C.unknown : it.satisfied === false ? C.warn : C.ok
        return (
          <div
            key={slot.cn}
            data-testid="sh08-metric-card"
            data-metric={slot.cn}
            data-engine-key={it?.key ?? ''}
            data-value={pct ?? ''}
            title={it
              ? `${slot.cn}：引擎 key=${it.key} · value=${it.value} · normalized=${it.normalized ?? '—'} · 尺度 ${it.scaleMin ?? '—'}–${it.scaleMax ?? '—'} · 权重 ${it.weight ?? '—'}${it.satisfied !== undefined ? ` · 判据 ${it.satisfied ? '满足' : '未满足'}` : ''}`
              : `${slot.cn}：引擎 evaluation.items[] 里没有这笔（期望 key：${slot.keys.join(' / ')}）`}
            style={{ ...panel, boxSizing: 'border-box', padding: '7px 9px' }}
          >
            <div style={{ fontSize: 11, color: C.textDim }}>{slot.cn}</div>
            <div style={{ fontSize: 18, color: pct === undefined ? C.unknown : color, fontVariantNumeric: 'tabular-nums' }}>
              {pct === undefined ? '—' : `${n2s(pct)}%`}
            </div>
            <div style={{ fontSize: 9.5, color: C.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {it ? `${it.key}=${n2s(it.value)}` : `缺项（${slot.keys[0]}）`}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ============================================================================
// ④ 屏体（SH-08）
// ============================================================================

export function LinkStableScreen({ state, flow, onGo, goto }: {
  state: FlowState
  flow: UseFlow
  onGo?: (id: string) => void
  goto?: (step: number) => void
}) {
  const { call, rd } = useLinkReadings(flow)
  const bw = useMemo(() => readBandwidthSeries(rd), [rd])
  const lat = useMemo(() => readLatencySeries(rd), [rd])
  const rows = useMemo(() => qualityRows(rd), [rd])

  return (
    <div data-testid="sh-08" data-screen="SH-08" style={rootStyle}>
      {/* 中区：同 SH-07 的版式拓扑 + 仿真控制条（额外保留）+ 两枚按钮 */}
      <div style={midColStyle}>
        <TopologyGraph readings={rd} testid="sh08-topology" height={300} />

        <SimControlStrip flow={flow} testidPrefix="sh08" />

        <div style={{ height: 38 }}>
          <LinkActionButtons
            flow={flow}
            rd={rd}
            call={call}
            goto={goto}
            onGo={onGo}
            testidPrefix="sh08"
          />
        </div>
      </div>

      {/* 右栏：「链路稳定评估」（照图） */}
      <div style={rightColStyle}>
        <div data-testid="sh08-stable-panel" style={{ ...panel, width: '100%', boxSizing: 'border-box' }}>
          <div style={panelTitle}>
            链路稳定评估
            <span style={{ float: 'right', fontSize: 11.5, color: C.textDim, fontFamily: 'ui-monospace, Consolas, monospace' }}>
              topology.evaluate
            </span>
          </div>
          <div style={{ padding: '8px 11px 10px' }}>
            <StableCard rd={rd} />

            <div style={{ fontSize: 12, color: C.textDim, margin: '9px 0 5px' }}>链路质量趋势</div>
            <Curve series={bw} testid="sh08-bandwidth-curve" yTicks={['100%', '50%', '0%']} yMax={100} unit="Mbps" />
            <Curve series={lat} testid="sh08-latency-curve" yTicks={['120ms', '60ms', '0ms']} yMax={120} unit="ms" color="#38bdf8" />
            <div
              data-testid="sh08-curve-note"
              title="横纵轴刻度照图；线只按引擎给的读数画：宿主没有历史采样接口（/api/state 与 topology.evaluate 都只给当前值），所以引擎给了当前值也只是 1 个点，没有就 0 个点（不编曲线）。"
              style={{ fontSize: 10, color: C.textDim, lineHeight: '14px', maxHeight: 28, overflow: 'hidden', marginBottom: 8 }}
            >
              两图的横轴刻度（00:00 / 05:00 / 10:00 / 15:00）与纵轴刻度照图；<span style={{ color: C.text }}>线只按引擎给的读数画</span>：
              宿主目前没有历史采样接口（`/api/state` 与 `topology.evaluate` 都只给当前值），
              所以引擎给了当前值也只是 1 个点，没有就 0 个点（不编曲线）。
            </div>

            <div style={{ fontSize: 12, color: C.textDim, margin: '4px 0 5px' }}>网络评估</div>
            <MetricGrid rd={rd} />

            {/* 6 行链路质量指标：本屏照图不重复铺满（图上只有 2×2 四卡），折在 details 里备查（数值与 SH-07 同源） */}
            <details style={{ marginTop: 7 }} data-testid="sh08-quality-details">
              <summary style={{ fontSize: 11, color: C.textDim, cursor: 'pointer' }}>
                链路质量指标（{rows.filter((r) => r.has).length}/{rows.length} 项有引擎读数）
              </summary>
              <div style={{ marginTop: 3 }}>
                {rows.map((r) => (
                  <div key={r.key} data-testid="sh08-quality-row" data-field={r.key} data-has={r.has ? '1' : '0'} style={{ fontSize: 11, padding: '1px 0' }}>
                    <span style={{ color: C.textDim }}>{r.name}</span>{' '}
                    <span style={{ color: r.has ? C.text : C.unknown }}>{r.has ? `${r.text}${r.unit ?? ''}` : '—'}</span>{' '}
                    <span style={{ color: C.textDim, fontSize: 9.5 }}>{r.note}</span>
                  </div>
                ))}
              </div>
            </details>
          </div>
        </div>

        <VerbVerdict
          rows={[
            {
              verb: 'topology.evaluate', reply: call.reply, busy: call.busy, onRetry: call.resend,
              okNote: `链路 ${rd.linkCount ?? '—'} 条 · 已判状态 ${rd.linksWithState ?? '—'} · 集群 ${rd.prim.clusters.length}`,
            },
          ]}
        />
      </div>

      {/* 底部 4 张状态卡（照图；就绪率取引擎 `evaluation.inputs.linkUpRatio`） */}
      <div style={cardsRowStyle}>
        <LinkBottomCards state={state} flow={flow} rd={rd} testidPrefix="sh08" />
      </div>
    </div>
  )
}

// ---- 样式（与 SH-07 同口径：一律 left/right/top/bottom 长写，不写 inset 简写）----
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

export default LinkStableScreen
