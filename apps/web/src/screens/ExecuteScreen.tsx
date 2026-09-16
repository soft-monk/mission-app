// mission-app · apps/web/src/screens/ExecuteScreen.tsx
//
// Excel 步 6 · 任务执行（参考图 `T2-1.png` 链路拓扑 / `T3-1.png` 侦察展开）。
//
// 它是**覆盖层**：底下的 `MapStage` 照常跑（地图、无人机、航迹由它自己画），本文件只往地图上摆：
//   · 顶部压条：阶段 / 仿真状态 / 倍速 / 链路条数 / 覆盖率 / 遍历周期
//   · 左栏：任务执行控制（启动/继续链路 · 暂停 · 恢复 · 倍速 1×/8×/60×）+ 仿真事件读数 + 四条命令回执
//     注：**起飞属启动加载阶段**（`simAutoStart=true` —— 链路/集群探针要真实报文与在线设备才算就绪，
//     不起仿真源的话启动加载永远停在 50%、进不了第 2 步）。所以这一步的语义是"控制正在执行的任务"。
//   · 右栏：链路评估（`topology.evaluate`）+ 侦察覆盖（`sensor.status`）
//   · 底栏：【自动优化链路】【进入侦察阶段】
//
// ★ 纪律（这一屏最容易犯的三个错，写在这里提醒）：
//   ① **倍速只发契约冻结的 1/8/60**（`sim.speed{speed}`），界面上的当前倍速来自
//      `sim.state` **事件**，不是本地变量——宿主说多少就是多少；
//   ② **链路绿/黄/红不自己判**：颜色只由规则包给的域经词典映射（`useOps.linkColor`），
//      域不认识就是中性灰 + 原样显示域文本；
//   ③ **覆盖率/遍历周期不自己算**：全部来自 `sensor.status` 回执（引擎算的），
//      读不到就是"—"+"未就绪 + code"，MUST NOT 补 0。
import { useCallback, useMemo, useState, type CSSProperties } from 'react'
import { C, panel, panelTitle } from '../theme'
import type { CommandReply, FlowState } from '../api'
import type { UseFlow } from '../flow/useFlow'
import { n2s, replyText, useVerbOnce, type Metric } from '../flow/useSituation'
import {
  linkColor, ms2clock, readSensor, readSim, readTopology, SIM_SPEEDS,
  type SimView, type SensorView, type TopologyView,
} from '../flow/useOps'
import { VerbVerdict } from './VerbVerdict'
import { StageStrip } from './StageOverlay'

/** 一行「名 + 值」：值缺失显示"—"，**不补 0**。 */
function Row({ k, v, color, testid }: { k: string; v: string; color?: string; testid?: string }) {
  return (
    <div data-testid={testid} style={{ display: 'flex', gap: 8, padding: '2px 0', fontSize: 12 }}>
      <span style={{ color: C.textDim, flex: 1, minWidth: 0 }}>{k}</span>
      <span style={{ color: color ?? C.text, fontVariantNumeric: 'tabular-nums' }}>{v}</span>
    </div>
  )
}

/** 计量行（宿主给的指标统一走它）。 */
function MetricRow({ m }: { m: Metric }) {
  return (
    <div data-testid="metric-row" style={{ display: 'flex', gap: 8, padding: '2px 0', fontSize: 12 }}>
      <span style={{ color: C.textDim, flex: 1, minWidth: 0 }}>{m.name}</span>
      <span style={{ color: C.text, fontVariantNumeric: 'tabular-nums' }}>
        {m.value !== undefined ? n2s(m.value, m.unit ?? '') : (m.text ?? '—')}
      </span>
    </div>
  )
}

function Section({ title, children, testid }: { title: React.ReactNode; children: React.ReactNode; testid?: string }) {
  return (
    // box-sizing: border-box —— `width:100%` + 1px 边框在 content-box 下会比列宽多 2px，
    // 那一丁点溢出会让 `overflowY:auto` 的列底部多出一条横向滚动条（实测踩到）。
    <div data-testid={testid} style={{ ...panel, width: '100%', boxSizing: 'border-box' }}>
      <div style={panelTitle}>{title}</div>
      <div style={{ padding: '7px 12px 9px' }}>{children}</div>
    </div>
  )
}

/** 未就绪时的一句话：**把 verb 的 code 与宿主原话摆出来**，并给个重试入口。 */
function NotReady({ what, verb, reply, busy, onRetry }: {
  what: string
  verb: string
  reply: CommandReply | null
  busy?: boolean
  onRetry?: () => void
}) {
  return (
    <div data-testid="not-ready" style={{ fontSize: 12, color: C.textDim, lineHeight: 1.7 }}>
      {what}未就绪：{verb}
      {reply === null
        ? '（正在读取…）'
        : reply.code === 0
          ? ' 回执成功但未给出本屏可显示的字段（界面不补数）'
          : ` → ${replyText(reply)}`}
      {onRetry && (
        <button onClick={onRetry} disabled={busy} style={{ ...ghostBtn, marginLeft: 8, padding: '2px 8px', fontSize: 11 }}>
          重试
        </button>
      )}
    </div>
  )
}

export function ExecuteScreen({ state, flow }: {
  state: FlowState
  flow: UseFlow
}) {
  // ---- 进屏按契约发一次：链路评估 + 传感器读数（都是幂等的）----
  const topo = useVerbOnce(flow, 'topology.evaluate', {}, true)
  const sensor = useVerbOnce(flow, 'sensor.status', {}, true)

  const tv: TopologyView = useMemo(() => readTopology(topo.data), [topo.data])
  const sv: SensorView = useMemo(() => readSensor(sensor.data), [sensor.data])

  // ---- `sim.state` 是**事件**驱动的（`useFlow` 订阅；界面不自己造状态）----
  const simSlot = flow.events['sim.state']
  const sim: SimView = useMemo(() => readSim(simSlot?.data, simSlot?.ts), [simSlot?.data, simSlot?.ts])

  // ---- 四条仿真命令的回执（交互式发送，逐条留痕）----
  const [busy, setBusy] = useState(false)
  const [simReplies, setSimReplies] = useState<Record<string, CommandReply>>({})

  const sendSim = useCallback(async (verb: string, params: Record<string, unknown>) => {
    setBusy(true)
    try {
      const r = await flow.send(verb, params)
      setSimReplies((prev) => ({ ...prev, [verb]: r }))
    } finally {
      setBusy(false)
    }
  }, [flow])

  const running = sim.running
  const speed = sim.speed
  const speedText = speed === undefined ? '—' : `${n2s(speed)}×`
  const simText = running === undefined ? '宿主未给出（未收到 sim.state）' : running ? '运行中' : '已暂停（链路未在推进）'

  return (
    <>
      {/* ---------------- 顶部压条 ---------------- */}
      <StageStrip
        items={[
          { k: '阶段', v: state.phase || '—' },
          { k: '仿真', v: simText, color: running === undefined ? C.unknown : running ? C.ok : C.warn },
          { k: '倍速', v: speedText, color: speed !== undefined && speed !== 1 ? C.accent : undefined },
          { k: '链路', v: tv.links.length ? `${tv.links.length} 条` : '—' },
          { k: '覆盖率', v: sv.coverage?.value !== undefined ? n2s(sv.coverage.value, sv.coverage.unit ?? '') : (sv.coverage?.text ?? '—') },
          { k: '遍历周期', v: sv.sweep?.value !== undefined ? n2s(sv.sweep.value, sv.sweep.unit ?? '') : (sv.sweep?.text ?? '—') },
        ]}
        right={<span style={{ color: simSlot ? C.textDim : C.warn }}>
          {simSlot
            ? `sim.state 事件于 ${new Date(simSlot.ts).toLocaleTimeString()} 到达（speed=${speed ?? '—'} · emitted=${sim.emitted ?? '—'}）`
            : '尚未收到 sim.state 事件（倍速与在跑状态由宿主事件给出）'}
        </span>}
      />

      {/* ---------------- 左：任务执行控制 ---------------- */}
      <div style={leftColStyle}>
        <Section title="任务执行控制" testid="exec-control-panel">
          <Row k="仿真在跑" v={running === undefined ? '—' : String(running)} testid="sim-running" />
          <Row k="当前倍速" v={speedText} testid="sim-speed" />
          <Row k="仿真时长" v={ms2clock(sim.simElapsedMs)} testid="sim-elapsed" />
          <Row k="平台数" v={n2s(sim.platforms)} testid="sim-platforms" />
          <Row k="已发事件" v={n2s(sim.emitted)} />
          {sim.note && <div style={{ fontSize: 11, color: C.textDim, marginTop: 3 }}>{sim.note}</div>}
          {sim.metrics.slice(0, 4).map((m) => <MetricRow key={m.key} m={m} />)}
          {!simSlot && (
            <div data-testid="sim-note" style={{ fontSize: 11, color: C.warn, marginTop: 4, lineHeight: 1.6 }}>
              未收到 `sim.state` 事件 → 倍速/在跑状态显示"—"；按下面任一按钮发命令，宿主若已装配会立刻回事件。
            </div>
          )}

          {/* 起飞 / 暂停 / 恢复 */}
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button data-testid="btn-sim-start" style={actionBtn} disabled={busy} onClick={() => void sendSim('sim.start', {})}>启动/继续链路</button>
            <button data-testid="btn-sim-pause" style={actionBtn} disabled={busy} onClick={() => void sendSim('sim.pause', {})}>暂停</button>
            <button data-testid="btn-sim-resume" style={actionBtn} disabled={busy} onClick={() => void sendSim('sim.resume', {})}>恢复</button>
          </div>

          {/* 倍速：**契约冻结的三档** */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 7 }}>
            <span style={{ fontSize: 11.5, color: C.textDim }}>倍速</span>
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
                    padding: '4px 12px', fontSize: 12.5, cursor: busy ? 'default' : 'pointer', borderRadius: 6,
                    border: `1px solid ${on ? C.borderStrong : C.border}`,
                    background: on ? 'rgba(29,78,216,.5)' : 'rgba(10,20,36,.7)',
                    color: on ? '#eaf4ff' : C.text,
                  }}
                >{s}×</button>
              )
            })}
            <span style={{ fontSize: 11, color: C.textDim }}>（当前 {speedText}，来自 sim.state）</span>
          </div>
        </Section>

        <VerbVerdict
          title="仿真命令回执"
          rows={[
            { verb: 'sim.start', reply: simReplies['sim.start'] ?? null, busy, onRetry: () => void sendSim('sim.start', {}) },
            { verb: 'sim.pause', reply: simReplies['sim.pause'] ?? null, busy, onRetry: () => void sendSim('sim.pause', {}) },
            { verb: 'sim.resume', reply: simReplies['sim.resume'] ?? null, busy, onRetry: () => void sendSim('sim.resume', {}) },
            { verb: 'sim.speed', reply: simReplies['sim.speed'] ?? null, busy, okNote: `speed=${speed ?? '—'}（事件确认）` },
          ]}
        />
      </div>

      {/* ---------------- 右：链路评估 + 侦察覆盖 ---------------- */}
      <div style={rightColStyle}>
        <Section
          title={<span>链路评估
            <span style={{ float: 'right', fontSize: 11.5, color: C.textDim }}>topology.evaluate</span>
          </span>}
          testid="topology-panel"
        >
          {tv.totals.length > 0 && (
            <div style={{ marginBottom: 5, borderBottom: `1px solid ${C.border}`, paddingBottom: 4 }}>
              {tv.totals.map((m) => <MetricRow key={m.key} m={m} />)}
            </div>
          )}
          {/* 链路状态分布：**数宿主给的 links[]**（不是判状态）——一眼看出红/黄/绿各几条 */}
          {tv.byState.length > 0 && (
            <div data-testid="link-state-dist" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 5, borderBottom: `1px solid ${C.border}`, paddingBottom: 4 }}>
              {tv.byState.map((s) => (
                <span key={s.state} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: linkColor(s.state), border: `1px solid ${C.border}` }} />
                  <span style={{ color: linkColor(s.state) }}>{s.state}</span>
                  <span style={{ color: C.text }}>{s.count} 条</span>
                </span>
              ))}
            </div>
          )}
          {tv.metrics.length > 0 && (
            <div style={{ marginBottom: 5, borderBottom: `1px solid ${C.border}`, paddingBottom: 4 }}>
              {/* 网络评估（实测 0–1 尺度）：值原样显示，尺度/权重/判据写在后面 */}
              {tv.metrics.slice(0, 6).map((m) => (
                <div key={m.key} data-testid="eval-row" style={{ display: 'flex', gap: 8, padding: '2px 0', fontSize: 12 }}>
                  <span style={{ color: C.textDim, flex: 1, minWidth: 0 }}>{m.name}</span>
                  <span style={{ color: C.text, fontVariantNumeric: 'tabular-nums' }}>
                    {m.value !== undefined ? n2s(m.value) : (m.text ?? '—')}
                  </span>
                </div>
              ))}
              {tv.metrics[0]?.text && (
                <div style={{ fontSize: 10.5, color: C.textDim }}>{tv.metrics[0].text}</div>
              )}
              {tv.overall !== undefined && (
                <div style={{ fontSize: 11.5, color: C.accent, marginTop: 2 }}>
                  网络评估总分 {n2s(tv.overall)}（evaluation.overall，尺度 0–1）
                </div>
              )}
            </div>
          )}
          {tv.links.map((l) => (
            <div key={l.key} data-testid="link-row" data-link-status={l.status ?? ''} style={{ padding: '4px 0', borderBottom: '1px solid rgba(95,176,255,.10)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12 }}>
                {/* 颜色只由域映射（不认识 → 中性灰）；**不判"好不好"** */}
                <span style={{
                  width: 9, height: 9, borderRadius: '50%', flex: '0 0 auto',
                  background: linkColor(l.status), border: `1px solid ${C.border}`,
                }} />
                <span style={{ flex: 1, minWidth: 0, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {l.from && l.to ? `${l.from} → ${l.to}` : l.name}
                </span>
                <span style={{ color: l.status ? linkColor(l.status) : C.unknown, fontVariantNumeric: 'tabular-nums' }}>
                  {l.status ?? '—'}
                </span>
              </div>
              {l.metrics.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginLeft: 16, marginTop: 2 }}>
                  {l.metrics.map((m) => (
                    <span key={m.key} style={{ fontSize: 11, color: C.textDim }}>
                      {m.name} <span style={{ color: C.text }}>{m.value !== undefined ? n2s(m.value, m.unit ?? '') : (m.text ?? '—')}</span>
                    </span>
                  ))}
                </div>
              )}
              {l.note && <div style={{ fontSize: 11, color: C.textDim, marginLeft: 16 }}>{l.note}</div>}
            </div>
          ))}
          {tv.links.length === 0 && (
            <NotReady what="链路拓扑" verb="topology.evaluate" reply={topo.reply} busy={topo.busy} onRetry={topo.resend} />
          )}
          {tv.advice.length > 0 && (
            <div style={{ marginTop: 5, borderTop: `1px solid ${C.border}`, paddingTop: 4 }}>
              {tv.advice.slice(0, 4).map((t, i) => (
                <div key={i} style={{ fontSize: 11.5, color: C.text, lineHeight: 1.65 }}>· {t}</div>
              ))}
            </div>
          )}
          {tv.notes.slice(0, 2).map((t, i) => (
            <div key={i} style={{ fontSize: 11, color: C.textDim, lineHeight: 1.55 }}>· {t}</div>
          ))}
        </Section>

        <Section
          title={<span>侦察覆盖
            <span style={{ float: 'right', fontSize: 11.5, color: C.textDim }}>sensor.status</span>
          </span>}
          testid="sensor-panel"
        >
          {/* 覆盖率 / 遍历周期：**引擎算的**，本屏只显示（值缺失就"—"） */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 5 }}>
            <div style={{ flex: 1, border: `1px solid ${C.border}`, borderRadius: 8, padding: '6px 9px', background: 'rgba(10,32,58,.5)' }}>
              <div style={{ fontSize: 11.5, color: C.textDim }}>区域覆盖率</div>
              <div data-testid="coverage-value" style={{ fontSize: 19, color: C.accent, fontVariantNumeric: 'tabular-nums' }}>
                {sv.coverage?.value !== undefined ? n2s(sv.coverage.value, sv.coverage.unit ?? '') : (sv.coverage?.text ?? '—')}
              </div>
              <div style={{ fontSize: 10.5, color: C.textDim }}>{sv.coverage ? `字段 ${sv.coverage.key}` : '未提供该字段'}</div>
              {sv.coverage?.text && <div style={{ fontSize: 10, color: C.textDim }}>{sv.coverage.text}</div>}
            </div>
            <div style={{ flex: 1, border: `1px solid ${C.border}`, borderRadius: 8, padding: '6px 9px', background: 'rgba(10,32,58,.5)' }}>
              <div style={{ fontSize: 11.5, color: C.textDim }}>遍历周期</div>
              <div data-testid="sweep-value" style={{ fontSize: 19, color: C.accent, fontVariantNumeric: 'tabular-nums' }}>
                {sv.sweep?.value !== undefined ? n2s(sv.sweep.value, sv.sweep.unit ?? '') : (sv.sweep?.text ?? '—')}
              </div>
              <div style={{ fontSize: 10.5, color: C.textDim }}>{sv.sweep ? `字段 ${sv.sweep.key}` : '未提供该字段'}</div>
              {sv.sweep?.text && <div style={{ fontSize: 10, color: C.textDim }}>{sv.sweep.text}</div>}
            </div>
          </div>
          {sv.metrics.slice(0, 6).map((m) => <MetricRow key={m.key} m={m} />)}
          {/* 按机型汇总（实测 `byType`）：机型 / 平台数 / 覆盖面积 / 重访周期 */}
          {sv.byType.length > 0 && (
            <div data-testid="sensor-bytype" style={{ marginTop: 4, borderTop: `1px solid ${C.border}`, paddingTop: 4 }}>
              {sv.byType.map((b) => (
                <div key={b.key} style={{ display: 'flex', gap: 8, fontSize: 11.5, padding: '1px 0' }}>
                  <span style={{ color: C.text, width: 34, flex: '0 0 auto' }}>{b.name}</span>
                  <span style={{ color: C.textDim, flex: 1 }}>
                    {b.platforms !== undefined ? `${n2s(b.platforms)} 台` : ''}
                    {b.coverageKm2 !== undefined ? ` · 覆盖 ${n2s(b.coverageKm2)} km²` : ''}
                  </span>
                  <span style={{ color: C.text }}>{b.revisitMs !== undefined ? `重访 ${n2s(b.revisitMs, 'ms')}` : '—'}</span>
                </div>
              ))}
            </div>
          )}
          {sv.rows.map((r) => (
            <div key={r.key} data-testid="sensor-row" style={{ padding: '3px 0', borderBottom: '1px solid rgba(95,176,255,.10)' }}>
              <div style={{ display: 'flex', gap: 8, fontSize: 12 }}>
                <span style={{ flex: 1, minWidth: 0, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                {r.status && <span style={{ color: C.textDim }}>{r.status}</span>}
              </div>
              {r.metrics.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {r.metrics.slice(0, 6).map((m) => (
                    <span key={m.key} style={{ fontSize: 11, color: C.textDim }}>
                      {m.name} <span style={{ color: C.text }}>{m.value !== undefined ? n2s(m.value, m.unit ?? '') : (m.text ?? '—')}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
          {/* 兜底：回执里所有数值字段的原样清单（字段改名也看得见，且不改口径） */}
          {sv.pairs.length > 0 && (
            <details style={{ marginTop: 5 }} data-testid="sensor-raw-pairs">
              <summary style={{ fontSize: 11, color: C.textDim, cursor: 'pointer' }}>
                sensor.status 回执全部字段（{sv.pairs.length} 项，原样）
              </summary>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px', marginTop: 3, maxHeight: 96, overflowY: 'auto' }}>
                {sv.pairs.slice(0, 24).map((p, i) => (
                  <span key={i} style={{ fontSize: 10.5, color: C.textDim }}>
                    {p.path}=<span style={{ color: C.text }}>{p.value}</span>
                  </span>
                ))}
              </div>
            </details>
          )}
          {!sv.coverage && !sv.sweep && sv.rows.length === 0 && (
            <NotReady what="传感器读数" verb="sensor.status" reply={sensor.reply} busy={sensor.busy} onRetry={sensor.resend} />
          )}
          {sv.notes.slice(0, 2).map((t, i) => (
            <div key={i} style={{ fontSize: 11, color: C.textDim, lineHeight: 1.55 }}>· {t}</div>
          ))}
        </Section>

        <VerbVerdict
          rows={[
            { verb: 'topology.evaluate', reply: topo.reply, busy: topo.busy, onRetry: topo.resend, okNote: `${tv.links.length} 条链路` },
            { verb: 'sensor.status', reply: sensor.reply, busy: sensor.busy, onRetry: sensor.resend, okNote: `${sv.rows.length} 条读数` },
          ]}
        />
      </div>

      {/* ---------------- 底：链路优化 / 进入侦察阶段 ---------------- */}
      <div style={bottomStyle}>
        <div style={{ ...panel, flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 14, padding: '0 14px', height: 46 }}>
          <span style={{ fontSize: 12, color: C.textDim }}>步 {state.step}/11</span>
          <span style={{ fontSize: 12.5, color: C.text }}>{state.stepTitle || state.stepKey}</span>
          <span style={{ fontSize: 12, color: C.textDim }}>阶段 {state.phase || '—'}</span>
          <span style={{ fontSize: 12, color: C.textDim }}>倍速 {speedText}</span>
          <span style={{ fontSize: 12, color: C.textDim }}>链路 {tv.links.length || '—'}</span>
          <span style={{ fontSize: 12, color: C.textDim }}>
            覆盖率 {sv.coverage?.value !== undefined ? n2s(sv.coverage.value, sv.coverage.unit ?? '') : '—'}
          </span>
          <span style={{ fontSize: 12, color: C.textDim }}>
            遍历周期 {sv.sweep?.value !== undefined ? n2s(sv.sweep.value, sv.sweep.unit ?? '') : '—'}
          </span>
        </div>
        <button data-testid="btn-link-optimize" style={ghostBtn} disabled={topo.busy} onClick={topo.resend}>
          {topo.busy ? '评估中…' : '自动优化链路'}
        </button>
        <button data-testid="btn-enter-recon" style={primaryBtn} onClick={() => void flow.send('flow.goto', { step: 7 })}>
          进入侦察阶段 ≫
        </button>
      </div>

      <ExecuteProbe
        step={state.step}
        phase={state.phase}
        simRaw={simSlot?.data ?? null}
        simTs={simSlot?.ts ?? null}
        sim={sim}
        simReplies={simReplies}
        topoReply={topo.reply}
        topoRaw={topo.data}
        linkCount={tv.links.length}
        sensorReply={sensor.reply}
        sensorRaw={sensor.data}
        coverage={sv.coverage ?? null}
        sweep={sv.sweep ?? null}
        wsStats={flow.wsStats}
      />
    </>
  )
}

/** 自证句柄 `window.__p4Stats`（步 6 的部分；步 7 只叠加自己的键，不覆盖这一份）。 */
function ExecuteProbe({ step, phase, simRaw, simTs, sim, simReplies, topoReply, topoRaw, linkCount, sensorReply, sensorRaw, coverage, sweep, wsStats }: {
  step: number
  phase: string
  simRaw: unknown
  simTs: number | null
  sim: SimView
  simReplies: Record<string, CommandReply>
  topoReply: CommandReply | null
  topoRaw: unknown
  linkCount: number
  sensorReply: CommandReply | null
  sensorRaw: unknown
  coverage: Metric | null
  sweep: Metric | null
  wsStats: UseFlow['wsStats']
}) {
  const w = window as unknown as { __p4Stats?: Record<string, unknown> }
  w.__p4Stats = {
    ...(w.__p4Stats ?? {}),
    step,
    screen: 'execute',
    phase,
    sim: {
      /** 事件原文（`sim.state` 的 data；没收到就是 null） */
      raw: simRaw,
      ts: simTs,
      running: sim.running ?? null,
      speed: sim.speed ?? null,
      simElapsedMs: sim.simElapsedMs ?? null,
      platforms: sim.platforms ?? null,
      emitted: sim.emitted ?? null,
    },
    simReplies,
    topology: { reply: topoReply, raw: topoRaw ?? null, linkCount },
    sensor: { reply: sensorReply, raw: sensorRaw ?? null, coverage, sweep },
    wsStats,
    dom: {
      controlPanel: !!document.querySelector('[data-testid="exec-control-panel"]'),
      topologyPanel: !!document.querySelector('[data-testid="topology-panel"]'),
      sensorPanel: !!document.querySelector('[data-testid="sensor-panel"]'),
      speedButtons: document.querySelectorAll('[data-testid^="btn-speed-"]').length,
      linkRows: document.querySelectorAll('[data-testid="link-row"]').length,
      sensorRows: document.querySelectorAll('[data-testid="sensor-row"]').length,
      coverageText: document.querySelector('[data-testid="coverage-value"]')?.textContent ?? null,
      sweepText: document.querySelector('[data-testid="sweep-value"]')?.textContent ?? null,
      speedText: document.querySelector('[data-testid="sim-speed"]')?.textContent ?? null,
      hasStart: !!document.querySelector('[data-testid="btn-sim-start"]'),
      hasPause: !!document.querySelector('[data-testid="btn-sim-pause"]'),
      hasResume: !!document.querySelector('[data-testid="btn-sim-resume"]'),
      hasEnter: !!document.querySelector('[data-testid="btn-enter-recon"]'),
    },
  }
  return null
}

// ---- 样式（一律 left/right/bottom 长写：**不写 inset 简写**，见 App.tsx 的踩坑注释）----
const leftColStyle: CSSProperties = {
  position: 'absolute', left: 12, top: 34, bottom: 56, zIndex: 20, width: 300,
  display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', overflowX: 'hidden',
}
const rightColStyle: CSSProperties = {
  position: 'absolute', right: 12, top: 34, bottom: 56, zIndex: 20, width: 318,
  display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', overflowX: 'hidden',
}
const bottomStyle: CSSProperties = {
  position: 'absolute', left: 12, right: 12, bottom: 6, zIndex: 21,
  display: 'flex', alignItems: 'center', gap: 10, height: 46,
}
const actionBtn: CSSProperties = {
  flex: 1, padding: '7px 10px', fontSize: 12.5, cursor: 'pointer', borderRadius: 7,
  background: 'rgba(10,20,36,.7)', border: `1px solid ${C.border}`, color: C.text,
}
const primaryBtn: CSSProperties = {
  padding: '11px 26px', fontSize: 14, cursor: 'pointer', borderRadius: 8, whiteSpace: 'nowrap',
  letterSpacing: 1, border: '1px solid rgba(34,197,94,.6)',
  background: 'linear-gradient(180deg,#16a34a,#15803d)', color: '#eafff2',
}
const ghostBtn: CSSProperties = {
  padding: '11px 20px', fontSize: 13.5, cursor: 'pointer', borderRadius: 8, whiteSpace: 'nowrap',
  background: 'rgba(10,20,36,.75)', border: `1px solid ${C.borderStrong}`, color: C.text,
}

export default ExecuteScreen
