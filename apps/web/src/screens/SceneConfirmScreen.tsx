// mission-app · apps/web/src/screens/SceneConfirmScreen.tsx
//
// **场景确认界面（需求专篇 DES-APP-001 SH-04，参考图 `场景1\T0-2.png`，1536×1024）**。
//
// 版式（图的四块，本文件只往地图上摆浮层——底下的 `MapStage` 由 App 渲染，区域/敌情标绘照常）：
//   · 左上：地图工具栏（选择 / 标绘 / 测距 / 图层 / 3D · 2D/3D）
//   · 右上：显示模式胶囊「显示模式：综合态势」
//   · 右栏：「AI任务分析」（当前风险等级 / 敌方威胁强度 / 通信干扰强度 + AI分析结果 3 条）
//           +「任务信息」（任务名称 / 任务类型 / 任务区域 / 任务时间 / 任务状态）
//           + 两枚通栏按钮【进入任务执行 ≫】【返回场景选择】
//   · 底部通栏：「AI语音助手」对话区（问句气泡 / 绿色答复标签 / 【AI语音解读】/ 回答气泡）
//
// ★ 纪律（与工程既有口径一致，写在这里最显眼）：
//   ① **数字一律来自宿主**：右栏三行取 `situation.snapshot` 的 analysis 段；快照没给这一段
//      就如实写「快照未提供 analysis 段」——MUST NOT 写死"高/中/低"，也 MUST NOT 补 0；
//   ② **语音文案从配置取**：`config.json` 的 `flow.labels` → `voice.sh04.question|answerLabel|answer`
//      （宿主 `/runtime-config` 透传）。缺配置就显示「未配置」+ 键名，**源码里没有中文兜底**；
//   ③ **不发明按钮**：图上只有那两个（【进入任务执行】【返回场景选择】），另有图上就有的
//      【AI语音解读】；
//   ④ 工具栏的可用性与"为什么不可用"由 `view.compose` 说了算（消费侧未实现 → 灰置 + 原话）。
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { C, panel, panelTitle, statusColor } from '../theme'
import type { FlowState } from '../api'
import type { UseFlow } from '../flow/useFlow'
import {
  n2s, readSituation, replyText, threatColor, useVerbOnce, type Metric,
} from '../flow/useSituation'
import { useLabels, voiceLine } from '../shell/VoiceStrip'
import { MapToolbar, ToolModeNote, toolsOf, useMapToolState } from '../shell/MapTools'

type Labels = Record<string, string>

/** 一行"名 + 等级/值"（SH-04 右栏的头三行就是它）。值缺失显示"—"，**不补 0**。 */
function MetricRow({ m, testid }: { m: Metric; testid?: string }) {
  const color = m.status ? threatColor(m.status) : C.text
  const shown = m.value !== undefined ? n2s(m.value, m.unit ?? '') : (m.text ?? '—')
  return (
    <div data-testid={testid} style={metricRow}>
      <span style={{ color: C.textDim, flex: '0 0 auto' }}>{m.name}</span>
      <span style={dotted} />
      <span style={{ color, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{shown}</span>
    </div>
  )
}

/** 一段"名字 → 值"（任务信息那块）。 */
function KV({ k, v, color }: { k: string; v?: string; color?: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '4px 0', fontSize: 12.5 }}>
      <span style={{ color: C.textDim, width: 62, flex: '0 0 auto' }}>{k}</span>
      <span style={{ color: color ?? C.text, minWidth: 0, wordBreak: 'break-all' }}>{v ?? '—'}</span>
    </div>
  )
}

function Section({ title, right, children, testid }: {
  title: string
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

/** 地图工具栏（图上那一排）—— 由 `shell/MapTools` 统一实现：**真能点**，可用性看规则包。
 *  这里只声明"图上有哪几个格"（键位/顺序/文字逐字照图 T0-2）。 */
const SH04_TOOLS = toolsOf(['select', 'draw', 'measure', 'measureArea', 'layers', 'reset'])

export function SceneConfirmScreen({ state, flow, onGo, goto }: {
  state: FlowState
  flow: UseFlow
  onGo?: (id: string) => void
  goto?: (step: number) => void
}) {
  const snap = useVerbOnce(flow, 'situation.snapshot', {}, true)
  const sit = useMemo(() => readSituation(snap.data), [snap.data])
  const labels: Labels = useLabels()
  // 工具可用性一律来自规则包 `view.compose`（VWC-TOOL-01/02）——前端不自己判"该不该能用"
  const mt = useMapToolState(flow)

  // 「AI语音解读」：图上点了是"播报/展开解读"。解读内容来自配置（`voice.sh04.answer`），
  // **不是引擎读数** —— 所以界面必须标出它的来源，别让它看起来像实时分析结果。
  const [interpreted, setInterpreted] = useState(false)

  const question = voiceLine(labels, 'sh04', 'question')
  const answerLabel = voiceLine(labels, 'sh04', 'answerLabel')
  const answer = voiceLine(labels, 'sh04', 'answer')

  /** 任务状态（图上是"任务准备中"）：宿主给了用什么，没给显示"—"。 */
  const missionStatus = sit.mission?.status

  return (
    <div data-testid="sh-04" data-screen="SH-04" style={wrap}>
      {/* ---------------- 左上：地图工具栏（真能点：选择/标绘/测距/测面/图层） ---------------- */}
      <MapToolbar
        testid="sh04-toolbar"
        items={SH04_TOOLS}
        state={mt}
        style={{ left: 0, top: -3 }}
      />
      <ToolModeNote state={mt} items={SH04_TOOLS} />

      {/* ---------------- 右上：显示模式胶囊 ---------------- */}
      <div data-testid="sh04-mode" style={modePill}>
        <span style={{ color: C.textDim }}>显示模式：</span>
        <span style={{ color: C.text }}>{mt.views.modeName ?? mt.views.modeKey ?? '综合态势'}</span>
        <span style={{ color: C.textDim }}>⌄</span>
      </div>

      {/* ---------------- 右栏：AI任务分析 / 任务信息 + **钉在栏底的**两枚按钮 ----------------
           ★ P0 修复（用户："卡在第三步没有办法点击进入下一阶段"）：
             上一版把两枚按钮放进**可滚动**的右栏里用 `marginTop:'auto'` 顶到底部；视口高度
             小于约 950px 时（实测 1366×768 / 1280×720）按钮被挤出滚动容器的可视区，
             `getBoundingClientRect()` 仍返回坐标、脚本 `el.click()` 也仍能触发 ——
             但**真人用鼠标点在那个坐标上，命中的是外层容器**，于是彻底卡死在第 3 步。
             现在拆成"可滚动的内容区 + 不参与滚动的按钮区"，按钮**任何视口高度都钉在栏底**。 */}
      <div style={rightColStyle}>
        <div data-testid="sh04-rail-scroll" style={railScrollStyle}>
          <Section
            title="AI任务分析"
            right={snap.reply === null ? '读取中…' : (snap.reply.code === 0 ? 'situation.snapshot' : '未就绪')}
            testid="sh04-analysis"
          >
            {sit.analysis.length > 0 ? (
              sit.analysis.slice(0, 6).map((m) => <MetricRow key={m.key} m={m} testid="sh04-metric-row" />)
            ) : (
              <div data-testid="sh04-analysis-missing" style={dimLine}>
                {snap.reply === null
                  ? '正在读取 situation.snapshot…'
                  : `快照未提供 analysis 段（当前风险等级 / 敌方威胁强度 / 通信干扰强度来自引擎，前端不写死）`}
                {snap.reply && snap.reply.code !== 0 && (
                  <div style={{ color: C.warn, marginTop: 3 }}>{replyText(snap.reply)}</div>
                )}
              </div>
            )}

            {/* 「AI分析结果」3 条 —— 快照的结论行（notes / analysis.notes），有几条显示几条 */}
            <div style={{ marginTop: 6, borderTop: `1px solid ${C.border}`, paddingTop: 5 }}>
              <div style={{ fontSize: 11.5, color: C.textDim, marginBottom: 2 }}>AI分析结果</div>
              {sit.notes.length > 0 ? (
                sit.notes.slice(0, 3).map((t, i) => (
                  <div key={i} data-testid="sh04-analysis-line" style={{ fontSize: 11.5, color: C.text, lineHeight: 1.65 }}>
                    · {t}
                  </div>
                ))
              ) : (
                <div data-testid="sh04-analysis-line-missing" style={{ fontSize: 11, color: C.textDim, lineHeight: 1.65 }}>
                  快照未给出结论行（notes）—— 图上这 3 条来自规则包/文案表，引擎没给就留空
                </div>
              )}
            </div>

            {/* 两批 verb 的可用性（宿主未实现时**原话**可见） */}
            <div style={{ marginTop: 6, borderTop: `1px solid ${C.border}`, paddingTop: 4, fontSize: 10.5, color: C.textDim, lineHeight: 1.6 }}>
              <div>
                区域 {sit.areas.length} 个 · 目标 {sit.targets.length} 个 · 集群 {sit.groups.length} 个
                （均数自 situation.snapshot）
              </div>
            </div>
          </Section>

          <Section title="任务信息" right="situation.snapshot" testid="sh04-mission">
            <KV k="任务名称" v={sit.mission?.name ?? (state.missionId || undefined)} />
            <KV k="任务类型" v={sit.mission?.type} />
            <KV k="任务区域" v={sit.mission?.region} />
            <KV k="任务时间" v={sit.mission?.startAt} />
            <KV k="任务状态" v={missionStatus} color={missionStatus ? statusColor(missionStatus) : C.text} />
            {sit.areas.length > 0 && (
              <div style={{ marginTop: 4, borderTop: `1px solid ${C.border}`, paddingTop: 4, fontSize: 11, color: C.textDim, lineHeight: 1.6 }}>
                区域（快照 areas，地图上的多边形就是它们）：{sit.areas.map((a) => a.name).join('、')}
              </div>
            )}
          </Section>
        </div>

        <div data-testid="sh04-rail-actions" style={railActionsStyle}>
          {/* 图上按钮逐字：【进入任务执行】（右侧双箭头）。语义 = 建任务（阶段 T0→T1）进编组。 */}
          <button
            data-testid="sh04-enter"
            style={primaryBtn}
            onClick={() => {
              // ① 走流程（宿主的门禁/阶段映射说了算）；② 同时切到编组屏（只改本地屏路由）
              goto?.(4)
              onGo?.('SH-05')
            }}
          >
            进入任务执行 <span style={{ fontSize: 14, letterSpacing: -1 }}>»</span>
          </button>
          {/* 图上按钮逐字：【返回场景选择】 */}
          <button data-testid="sh04-back" style={ghostBtn} onClick={() => onGo?.('SH-03')}>
            返回场景选择
          </button>
        </div>
      </div>

      {/* ---------------- 底部通栏：AI语音助手对话区 ---------------- */}
      <div data-testid="sh04-voice" style={voicePanel}>
        <div style={{ ...panelTitle, display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px' }}>
          <span>AI语音助手</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: C.textDim }}>
            文案来自 config.json 的 flow.labels（voice.sh04.*）
          </span>
        </div>
        <div style={{ display: 'flex', gap: 12, padding: '8px 12px', minHeight: 0 }}>
          {/* 左：问句气泡（用户侧） */}
          <div style={{ flex: '1 1 46%', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div data-testid="sh04-question" style={bubbleLeft}>
              {question || (
                <span style={{ color: C.warn }}>
                  未配置 —— flow.labels 缺 `voice.sh04.question`
                </span>
              )}
            </div>
            {/* 绿色答复标签「好的，解读一下。」 */}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <div data-testid="sh04-answer-label" style={answerTag}>
                {answerLabel || <span style={{ color: C.warn }}>未配置 —— voice.sh04.answerLabel</span>}
              </div>
            </div>
          </div>

          {/* 中：按钮【AI语音解读】 */}
          <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center' }}>
            <button
              data-testid="sh04-interpret"
              data-interpreted={interpreted ? '1' : '0'}
              style={interpretBtn}
              title="播报/展开 AI 对该场景的解读（解读文案来自 flow.labels，不是引擎读数）"
              onClick={() => setInterpreted(true)}
            >
              <span style={{ fontSize: 13 }}>🔊</span> AI语音解读
            </button>
          </div>

          {/* 右：AI 回答气泡 */}
          <div style={{ flex: '1 1 46%', minWidth: 0 }}>
            <div data-testid="sh04-answer" style={{ ...bubbleRight, borderColor: interpreted ? C.borderStrong : C.border }}>
              {answer ? (
                <>
                  {answer}
                  <div style={{ fontSize: 10.5, color: C.textDim, marginTop: 3 }}>
                    来源：flow.labels 的 `voice.sh04.answer`（配置文案；不是引擎结论）
                    {interpreted ? ' · 已解读' : ' · 点左侧按钮播放/展开'}
                  </div>
                </>
              ) : (
                <span style={{ color: C.warn }}>
                  未配置 —— flow.labels 缺 `voice.sh04.answer`（源码里没有中文兜底）
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 自证：把本屏读到的两个 verb 的结论挂到 window（只读，不参与渲染） */}
      <SceneConfirmProbe
        step={state.step}
        phase={state.phase}
        analysis={sit.analysis}
        notes={sit.notes}
        snapshotReply={snap.reply}
        composeReply={mt.reply}
        voice={{ question: !!question, answerLabel: !!answerLabel, answer: !!answer }}
      />
    </div>
  )
}

/** 自证句柄 `window.__sh04Stats`（截图/验收脚本读它）。 */
function SceneConfirmProbe(props: {
  step: number
  phase: string
  analysis: Metric[]
  notes: string[]
  snapshotReply: { code: number; error?: { message?: string } } | null
  composeReply: { code: number; error?: { message?: string } } | null
  voice: { question: boolean; answerLabel: boolean; answer: boolean }
}) {
  const w = window as unknown as { __sh04Stats?: Record<string, unknown> }
  w.__sh04Stats = {
    screen: 'SH-04',
    step: props.step,
    phase: props.phase,
    situation: {
      reply: props.snapshotReply,
      /** 引擎给的分析行（**逐条原样**：界面显示的数就是这些） */
      analysis: props.analysis.map((m) => ({ key: m.key, name: m.name, value: m.value ?? null, status: m.status ?? null, text: m.text ?? null })),
      notes: props.notes,
    },
    compose: { reply: props.composeReply },
    voice: props.voice,
    dom: {
      voice: !!document.querySelector('[data-testid="sh04-voice"]'),
      question: document.querySelector('[data-testid="sh04-question"]')?.textContent ?? null,
      answerLabel: document.querySelector('[data-testid="sh04-answer-label"]')?.textContent ?? null,
      enter: !!document.querySelector('[data-testid="sh04-enter"]'),
      back: !!document.querySelector('[data-testid="sh04-back"]'),
      interpret: !!document.querySelector('[data-testid="sh04-interpret"]'),
      metricRows: document.querySelectorAll('[data-testid="sh04-metric-row"]').length,
      analysisLines: document.querySelectorAll('[data-testid="sh04-analysis-line"]').length,
    },
  }
  return null
}

// ---- 样式（一律 left/right/top/bottom 长写：**不写 inset 简写**，见 App.tsx 的踩坑注释）----
const wrap: CSSProperties = {
  // 不再留 top:34 —— `MapStage` 的开发自证信息条已只在排障后门出现，产品屏顶上没有东西要躲
  position: 'absolute', left: 12, right: 12, top: 8, bottom: 8, zIndex: 20,
}
const modePill: CSSProperties = {
  position: 'absolute', right: 0, top: 0, zIndex: 22, display: 'flex', gap: 6, alignItems: 'center',
  padding: '7px 12px', borderRadius: 999, fontSize: 12.5,
  background: 'rgba(6,26,47,.86)', border: `1px solid ${C.border}`,
}
const rightColStyle: CSSProperties = {
  position: 'absolute', right: 0, top: 40, bottom: 130, zIndex: 21, width: 300,
  display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0,
}
/** 可滚动的内容区（**只有面板滚，按钮不滚**） */
const railScrollStyle: CSSProperties = {
  flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
  display: 'flex', flexDirection: 'column', gap: 8, paddingRight: 2,
}
/** 钉在栏底的按钮区（`flex: 0 0 auto` —— 任何视口高度都不会被挤出可视区） */
const railActionsStyle: CSSProperties = {
  flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: 8,
  borderTop: `1px solid ${C.border}`, paddingTop: 8,
}
const voicePanel: CSSProperties = {
  ...panel, position: 'absolute', left: 0, right: 312, bottom: 0, zIndex: 21, overflow: 'hidden',
}
const bubbleLeft: CSSProperties = {
  alignSelf: 'flex-start', maxWidth: '100%', padding: '7px 10px', borderRadius: 10,
  background: 'rgba(8,24,44,.92)', border: `1px solid ${C.border}`, fontSize: 12, color: C.text, lineHeight: 1.6,
}
const bubbleRight: CSSProperties = {
  padding: '7px 10px', borderRadius: 10,
  background: 'rgba(8,24,44,.92)', border: `1px solid ${C.border}`, fontSize: 12, color: C.text, lineHeight: 1.6,
}
const answerTag: CSSProperties = {
  padding: '4px 10px', borderRadius: 999, fontSize: 12, color: '#0b2b16',
  background: 'linear-gradient(180deg,#34d399,#22c55e)', border: '1px solid rgba(34,197,94,.7)',
}
const interpretBtn: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 14px', borderRadius: 8,
  fontSize: 12.5, cursor: 'pointer', color: '#eaf4ff',
  border: `1px solid ${C.borderStrong}`, background: 'linear-gradient(180deg,#1d4ed8,#1e3a8a)',
}
const primaryBtn: CSSProperties = {
  padding: '10px 12px', fontSize: 13, cursor: 'pointer', borderRadius: 8,
  border: `1px solid ${C.borderStrong}`, background: 'linear-gradient(180deg,#1d4ed8,#1e3a8a)',
  color: '#eaf4ff', letterSpacing: 1,
}
const ghostBtn: CSSProperties = {
  padding: '9px 12px', fontSize: 12.5, cursor: 'pointer', borderRadius: 8,
  background: 'rgba(10,20,36,.7)', border: `1px solid ${C.border}`, color: C.text,
}
const metricRow: CSSProperties = {
  display: 'flex', alignItems: 'baseline', gap: 8, padding: '3px 0', fontSize: 12.5,
}
const dotted: CSSProperties = {
  flex: 1, borderBottom: '1px dotted rgba(95,176,255,.25)', transform: 'translateY(-3px)',
}
const dimLine: CSSProperties = { fontSize: 11.5, color: C.textDim, lineHeight: 1.7 }

export default SceneConfirmScreen
