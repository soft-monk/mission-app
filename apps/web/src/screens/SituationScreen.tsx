// mission-app · apps/web/src/screens/SituationScreen.tsx
//
// Excel 步 3 · 任务态势（参考图 `T0-1.png` / `T0-2.png`）。
//
// 它是**覆盖层**：底下的 `MapStage` 照常跑（地图、区域标绘、实时无人机都在），
// 本文件只往地图上摆四块东西——
//   · 顶部压条：显示模式 / 阶段 / 态势快照状态
//   · 左上：当前显示模式 + 地图工具/控件可用性（**画不画由 view-composer 说了算**）
//   · 右上：AI 任务分析 + 任务信息 + 资源概况（数值全部来自 `situation.snapshot`）
//   · 底部：场景确认（区域清单 + 目标清单 + 【确认场景，进入编组】）
//
// ★ 纪律：
//   · **不编任何数值**。快照没给的行显示"—"或整块不画；宿主没实现 verb 时显示宿主的原话 + code。
//   · 不写死"高/中/低"：等级域来自规则包，本文件只做"域 → 颜色"。
//   · 地图本体不改（MapStage 是主 agent 的文件）；本屏只叠加。
import type { CSSProperties } from 'react'
import { C, panel, panelTitle } from '../theme'
import type { FlowState } from '../api'
import type { UseFlow } from '../flow/useFlow'
import {
  n2s, readCompose, readSituation, replyColor, replyText, threatColor,
  useVerbOnce, type Metric,
} from '../flow/useSituation'
import { VerbVerdict } from './VerbVerdict'
import { AdvanceButton } from './AdvanceButton'
import { StageStrip } from './StageOverlay'

/** 一行计量：名 + 值（值缺失显示"—"，**不补 0**）。 */
function MetricRow({ m }: { m: Metric }) {
  const color = m.status ? threatColor(m.status) : C.text
  return (
    <div data-testid="metric-row" style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '3px 0', fontSize: 12.5 }}>
      <span style={{ color: C.textDim, flex: '0 0 auto' }}>{m.name}</span>
      <span style={{ flex: 1, borderBottom: '1px dotted rgba(95,176,255,.25)', transform: 'translateY(-3px)' }} />
      <span style={{ color, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
        {m.value !== undefined ? n2s(m.value, m.unit ?? '') : (m.text ?? '—')}
      </span>
    </div>
  )
}

/** 一段"名字 → 值"的键值对（任务信息那块用的就是它）。 */
function KV({ k, v }: { k: string; v?: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '4px 0', fontSize: 12.5 }}>
      <span style={{ color: C.textDim, width: 76, flex: '0 0 auto' }}>{k}</span>
      <span style={{ color: C.text, minWidth: 0, wordBreak: 'break-all' }}>{v ?? '—'}</span>
    </div>
  )
}

function Section({ title, children, testid }: { title: string; children: React.ReactNode; testid?: string }) {
  return (
    <div data-testid={testid} style={{ ...panel, width: '100%' }}>
      <div style={panelTitle}>{title}</div>
      <div style={{ padding: '7px 12px 9px' }}>{children}</div>
    </div>
  )
}

export function SituationScreen({ state, flow }: {
  state: FlowState
  flow: UseFlow
}) {
  const snap = useVerbOnce(flow, 'situation.snapshot', {}, true)
  const compose = useVerbOnce(flow, 'view.compose', { phase: state.phase || 'T0' }, true)
  const sit = readSituation(snap.data)
  const cmp = readCompose(compose.data)

  const overview = sit.overview.length ? sit.overview : (state.systemOverview ?? []).map((o) => ({
    key: o.key, name: o.name, status: o.status, text: o.text,
  }))
  const okTools = cmp.tools.filter((t) => t.on)
  const offTools = cmp.tools.filter((t) => !t.on)
  const labels = (arr: { name: string }[]) => arr.map((x) => x.name).join('、')

  return (
    <>
      {/* ---------------- 顶部压条（盖住地图台的自证信息条） ---------------- */}
      <StageStrip
        items={[
          { k: '显示模式', v: cmp.modeName ?? cmp.modeKey ?? '—', color: C.accent },
          { k: '阶段', v: state.phase || '—' },
          { k: '任务态势', v: state.stepTitle },
          { k: '区域', v: `${sit.areas.length}` },
          { k: '目标', v: `${sit.targets.length}` },
        ]}
        right={<span style={{ color: snap.reply?.code === 0 ? C.ok : C.warn }}>
          {snap.reply === null
            ? '态势快照读取中…'
            : snap.reply.code === 0
              ? '态势快照已就绪（situation.snapshot）'
              : `态势快照：${replyText(snap.reply)}`}
        </span>}
      />

      {/* ---------------- 左上：图层与工具（view.compose 说了算） ---------------- */}
      <div style={topLeftStyle}>
        <Section title="地图图层与工具" testid="compose-panel">
          {cmp.visibleGroups.length > 0 && (
            <div style={{ marginBottom: 5 }}>
              <span style={{ fontSize: 11.5, color: C.textDim }}>可见图层 </span>
              <span style={{ fontSize: 11.5, color: C.accent }}>{cmp.visibleGroups.join(' / ')}</span>
            </div>
          )}
          {okTools.length > 0 && (
            <div style={{ fontSize: 12, color: C.text, lineHeight: 1.7 }}>
              <span style={{ color: C.textDim }}>可用工具 </span>◉ {labels(okTools)}
            </div>
          )}
          {offTools.length > 0 && (
            <div style={{ fontSize: 12, color: C.unknown, lineHeight: 1.7 }}>
              <span style={{ color: C.textDim }}>不可用 </span>○ {labels(offTools)}
              <div style={{ fontSize: 11, color: C.textDim }}>{offTools[0].reason ?? ''}</div>
            </div>
          )}
          {cmp.controls.length > 0 && (
            <div style={{ fontSize: 11.5, color: C.textDim, marginTop: 4, lineHeight: 1.7 }}>
              地图控件：{labels(cmp.controls)}
            </div>
          )}
          {!cmp.tools.length && !cmp.visibleGroups.length && (
            <div style={{ fontSize: 12, color: C.textDim, lineHeight: 1.7 }}>
              图层与工具未就绪
              {compose.reply && compose.reply.code !== 0 && (
                <div style={{ color: C.warn }}>view.compose → {replyText(compose.reply)}</div>
              )}
            </div>
          )}
        </Section>
      </div>

      {/* ---------------- 右侧：AI 任务分析 / 任务信息 / 资源概况 ---------------- */}
      <div style={rightColStyle}>
        <Section title="AI 任务分析" testid="analysis-panel">
          {/* 快照没有 analysis 段时，**不编**：改为如实标出"数据源没给"，并附上快照自带的口径说明 */}
          {sit.analysis.length > 0
            ? sit.analysis.map((m) => <MetricRow key={m.key} m={m} />)
            : (
              <div style={{ fontSize: 11.5, color: C.textDim, lineHeight: 1.7 }}>
                situation.snapshot 未提供 analysis 段（威胁等级/防御强度/干扰强度不在快照里）
              </div>
            )}
          {sit.targets.some((t) => t.status) && (
            <div style={{ marginTop: 6, borderTop: `1px solid ${C.border}`, paddingTop: 5 }}>
              <div style={{ fontSize: 11.5, color: C.textDim, marginBottom: 2 }}>
                目标威胁等级（快照 targets[].threat）
              </div>
              {sit.targets.map((t) => (
                <div key={t.key} style={{ display: 'flex', gap: 8, fontSize: 12, padding: '2px 0' }}>
                  <span style={{ flex: 1, minWidth: 0, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.name}
                  </span>
                  {t.text && <span style={{ color: C.textDim }}>{t.text}</span>}
                  <span style={{ color: threatColor(t.status), width: 34, textAlign: 'right' }}>{t.status ?? '—'}</span>
                </div>
              ))}
            </div>
          )}
          {sit.notes.length > 0 && (
            <div style={{ marginTop: 6, borderTop: `1px solid ${C.border}`, paddingTop: 5 }}>
              {sit.notes.slice(0, 3).map((t, i) => (
                <div key={i} style={{ fontSize: 11, color: C.textDim, lineHeight: 1.6 }}>· {t}</div>
              ))}
            </div>
          )}
        </Section>

        <Section title="任务信息" testid="mission-panel">
          <KV k="任务名称" v={sit.mission?.name ?? (state.missionId || undefined)} />
          <KV k="任务类型" v={sit.mission?.type} />
          <KV k="任务区域" v={sit.mission?.region} />
          <KV k="任务时间" v={sit.mission?.startAt} />
          <KV k="时间要求" v={sit.mission?.timeRequirement} />
          <KV k="任务状态" v={sit.mission?.status} />
          {(sit.areas.length > 0 || sit.airspaces.length > 0) && (
            <div style={{ marginTop: 5, borderTop: `1px solid ${C.border}`, paddingTop: 5 }}>
              <div style={{ fontSize: 11.5, color: C.textDim, marginBottom: 2 }}>区域 / 空域</div>
              {[...sit.areas, ...sit.airspaces].map((m) => <MetricRow key={m.key} m={m} />)}
            </div>
          )}
        </Section>

        <Section title="资源概况" testid="resource-panel">
          {sit.platforms.length > 0
            ? sit.platforms.map((m) => <MetricRow key={m.key} m={m} />)
            : <div style={dimLine}>快照未给出平台/集群</div>}
          {overview.length > 0 && (
            <div style={{ marginTop: 5, borderTop: `1px solid ${C.border}`, paddingTop: 5 }}>
              {overview.map((o) => (
                <div key={o.key} style={{ display: 'flex', gap: 8, padding: '2px 0', fontSize: 12 }}>
                  <span style={{ color: C.textDim, width: 72, flex: '0 0 auto' }}>{o.name}</span>
                  <span style={{ color: threatColor(o.status) }}>{o.text ?? o.status ?? '—'}</span>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* 回执：宿主未实现时**原样**说清楚（这是本屏最该被看见的一行之一） */}
        <VerbVerdict
          rows={[
            { verb: 'situation.snapshot', reply: snap.reply, busy: snap.busy, onRetry: snap.resend, okNote: `${sit.areas.length} 区域 / ${sit.targets.length} 目标` },
            { verb: 'view.compose', reply: compose.reply, busy: compose.busy, onRetry: compose.resend, okNote: `${cmp.visibleGroups.length} 图层组` },
          ]}
        />
      </div>

      {/* ---------------- 底部：场景确认 ---------------- */}
      <div style={bottomStyle}>
        <div style={{ ...panel, flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={panelTitle}>
            请确认任务场景
            <span style={{ float: 'right', fontSize: 11.5, color: replyColor(snap.reply) }}>
              {snap.reply && snap.reply.code === 0
                ? `场景 ${(snap.data as Record<string, unknown> | null)?.scenarioKey ?? '—'} · 任务 ${(snap.data as Record<string, unknown> | null)?.missionId ?? '—'}`
                : (snap.reply ? '场景清单来自 situation.snapshot（未就绪）' : '正在读取场景清单…')}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 10, padding: 9, flex: 1, minHeight: 0, overflowX: 'auto' }}>
            {sit.areas.map((a) => (
              <div key={a.key} data-testid="scene-area-card" style={sceneCardStyle}>
                <div style={{ fontSize: 12.5, color: C.text }}>{a.name}</div>
                <div style={{ fontSize: 11.5, color: threatColor(a.status), marginTop: 3 }}>{a.status ?? '—'}</div>
                <div style={{ flex: 1 }} />
                <div style={{ fontSize: 11, color: C.textDim }}>{a.text ?? ''}</div>
              </div>
            ))}
            {sit.airspaces.length > 0 && (
              <div data-testid="scene-airspace-card" style={{ ...sceneCardStyle, width: 170 }}>
                <div style={{ fontSize: 12.5, color: C.text }}>空域 / 禁飞</div>
                <div style={{ fontSize: 11.5, color: C.textDim, marginTop: 3 }}>
                  {sit.airspaces.map((z) => z.name).join('、')}
                </div>
              </div>
            )}
            {!sit.areas.length && (
              <div style={{ ...dimLine, alignSelf: 'center' }}>
                {snap.sent && snap.reply && snap.reply.code !== 0
                  ? `宿主未给出场景清单 —— ${replyText(snap.reply)}`
                  : '正在读取场景清单…'}
              </div>
            )}
          </div>
        </div>

        {/* 场景确认（T0-2 右下的动作 + 目标清单） */}
        <div style={{ ...panel, width: 246, flex: '0 0 auto', padding: 11, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 12.5, color: C.text }}>场景确认</div>
          <div style={{ fontSize: 11.5, color: C.textDim, lineHeight: 1.6 }}>
            阶段 {state.phase || '—'} · {state.stepTitle}<br />
            目标 {sit.targets.length} 个 · 集群 {sit.groups.length} 个
          </div>
          <div style={{ flex: 1 }} />
          {/* 切步归宿主：这里发 `mission.advance{to:"T1"}`（阶段 T1 → 步 4），不再直接 flow.goto */}
          <AdvanceButton flow={flow} to="T1" label="确认场景，进入编组 ≫" style={primaryBtn} testId="btn-confirm-scene" />
          <button style={ghostBtn} onClick={snap.resend} disabled={snap.busy}>刷新态势快照</button>
        </div>
      </div>

      <SituationProbe
        situationRaw={snap.data}
        composeRaw={compose.data}
        snapshotReply={snap.reply}
        composeReply={compose.reply}
        areas={sit.areas.length}
        targets={sit.targets.length}
        groups={sit.groups.length}
      />
    </>
  )
}

/** 自证句柄 `window.__p3Stats`（步 3 的部分）。 */
function SituationProbe({ situationRaw, composeRaw, snapshotReply, composeReply, areas, targets, groups }: {
  situationRaw: unknown
  composeRaw: unknown
  snapshotReply: { code: number; error?: { message?: string } } | null
  composeReply: { code: number; error?: { message?: string } } | null
  areas: number
  targets: number
  groups: number
}) {
  const w = window as unknown as { __p3Stats?: Record<string, unknown> }
  w.__p3Stats = {
    ...(w.__p3Stats ?? {}),
    step: 3,
    screen: 'situation',
    situation: { reply: snapshotReply, data: situationRaw ?? null, counts: { areas, targets, groups } },
    compose: { reply: composeReply, data: composeRaw ?? null },
    dom: {
      areaCards: document.querySelectorAll('[data-testid="scene-area-card"]').length,
      analysisPanel: !!document.querySelector('[data-testid="analysis-panel"]'),
      missionPanel: !!document.querySelector('[data-testid="mission-panel"]'),
      resourcePanel: !!document.querySelector('[data-testid="resource-panel"]'),
      composePanel: !!document.querySelector('[data-testid="compose-panel"]'),
      metricRows: document.querySelectorAll('[data-testid="metric-row"]').length,
      hasConfirmScene: !!document.querySelector('[data-testid="btn-confirm-scene"]'),
    },
  }
  return null
}

// ---- 样式（一律 left/right/bottom 长写：**不写 inset 简写**，见 App.tsx 的踩坑注释）----
const topLeftStyle: CSSProperties = {
  position: 'absolute', left: 12, top: 34, zIndex: 20, width: 322,
}
const rightColStyle: CSSProperties = {
  position: 'absolute', right: 12, top: 34, zIndex: 20, width: 300,
  display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 'calc(100% - 190px)', overflowY: 'auto',
}
const bottomStyle: CSSProperties = {
  position: 'absolute', left: 12, right: 12, bottom: 36, zIndex: 20,
  display: 'flex', gap: 10, height: 132,
}
const sceneCardStyle: CSSProperties = {
  width: 148, flex: '0 0 auto', border: `1px solid ${C.border}`, borderRadius: 8,
  background: 'rgba(10,32,58,.55)', padding: 9, display: 'flex', flexDirection: 'column',
}
const dimLine: CSSProperties = { fontSize: 12, color: C.textDim, padding: '10px 2px' }
const primaryBtn: CSSProperties = {
  padding: '9px 12px', fontSize: 13, cursor: 'pointer', borderRadius: 8,
  border: `1px solid ${C.borderStrong}`, background: 'linear-gradient(180deg,#1d4ed8,#1e3a8a)',
  color: '#eaf4ff', letterSpacing: 0.5,
}
const ghostBtn: CSSProperties = {
  padding: '7px 12px', fontSize: 12.5, cursor: 'pointer', borderRadius: 8,
  background: 'rgba(10,20,36,.7)', border: `1px solid ${C.border}`, color: C.text,
}

export default SituationScreen
