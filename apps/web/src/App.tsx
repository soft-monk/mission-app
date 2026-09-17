// mission-app · apps/web/src/App.tsx
//
// 前端总入口 = **流程路由**。它只做三件事：
//   ① 维护与宿主的状态同步（`useFlow`：轮询 + WS 事件）
//   ② 按 `state.step` 决定显示哪一屏（Excel 11 步；第 3 步起才有地图）
//   ③ 把用户动作翻译成命令（启动加载 / 一键自检 / 重新检测 / 进入任务）
//
// ★ 纪律：本文件不写任何业务文案、不编任何百分比、不判断"通过与否"——
//   所有取值都来自 `/api/state`（其源头是各引擎 + 规则包）。
//
// 排障后门：`?stage=map` 直接进地图台（P1 的 live-check 用它，跳过启动/自检两屏）。
import { useCallback, useMemo, useState, type CSSProperties } from 'react'
import { useFlow } from './flow/useFlow'
import { useGoto } from './flow/useSituation'
import { DEFAULT_WS_URL } from './telemetry'
import { C, statusColor } from './theme'
import { TopBar } from './screens/Chrome'
import { BootScreen } from './screens/BootScreen'
import { SelfCheckScreen } from './screens/SelfCheckScreen'
import { SituationScreen } from './screens/SituationScreen'
import { GroupingScreen } from './screens/GroupingScreen'
import { GroupConfirmScreen } from './screens/GroupConfirmScreen'
import { StageOverlay } from './screens/StageOverlay'
import { ExecuteScreen } from './screens/ExecuteScreen'
import { TargetsScreen } from './screens/TargetsScreen'
import { StrikeScreen } from './screens/StrikeScreen'
import { StrikeConfirmScreen } from './screens/StrikeConfirmScreen'
import { GuidanceScreen } from './screens/GuidanceScreen'
import { SummaryScreen } from './screens/SummaryScreen'
import { MapStage } from './MapStage'

function param(name: string): string | null {
  try { return new URLSearchParams(window.location.search).get(name) } catch { return null }
}

export function App() {
  const wsUrl = param('ws') ?? DEFAULT_WS_URL
  const stageOverride = param('stage')
  const flow = useFlow(wsUrl)
  // 步 3–5 三屏要发自己的 verb（`situation.snapshot` / `view.compose` / `alloc.*`），
  // 所以整个句柄往下传；命令面仍然只有 `flow.send` → `POST /api/command` 这一条路。
  const { state, error, send, lastReply } = flow
  const [busy, setBusy] = useState(false)
  // 步 4 → 步 5 只带一个"用户选了哪个方案"。切步本身一律发 `flow.goto`（step 归宿主）。
  const [planId, setPlanId] = useState<string | null>(null)
  // 步 8 → 步 9 同理带一个"选了哪个**打击**方案"（步 9 的 `guidance.plan{planId}` 要用它）
  const [strikePlanId, setStrikePlanId] = useState<string | null>(null)
  const goto = useGoto(send)

  const run = useCallback(async (verb: string, params: Record<string, unknown> = {}) => {
    setBusy(true)
    try {
      await send(verb, params)
    } finally {
      setBusy(false)
    }
  }, [send])

  // ---- 排障后门：直接看地图台 ----
  if (stageOverride === 'map') {
    return (
      <div style={{ position: 'absolute', inset: 0, background: C.bg, color: C.text }}>
        <TopBar linkOk />
        <div style={{ position: 'absolute', top: 42, left: 0, right: 0, bottom: 0 }}>
          <MapStage phase="T4" />
        </div>
      </div>
    )
  }

  // ---- 底部全局状态条（Excel 步 3 起显示；项与文案来自宿主的 statusBar）----
  const bottomBar = useMemo(() => {
    const items = state?.statusBar ?? []
    if (!items.length) return null
    return (
      <div style={statusBarStyle}>
        {items.map((it) => (
          <span key={it.key} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <span style={{ color: C.textDim }}>{it.name}</span>
            <span style={{ color: statusColor(it.status) }}>{it.text || it.status}</span>
          </span>
        ))}
      </div>
    )
  }, [state?.statusBar])

  // ---- 首帧：还没拿到状态 ----
  //
  // ★ 千万别在这里用 `inset` 简写（曾经写过 `top:42, inset:42`）：这一块与下面的步容器
  //   处在**同一棵树位置**，React 复用同一个 DOM 节点、按属性逐个 diff —— 切到步容器时
  //   它会移除 `inset`（简写移除会连带清掉 top），而 `top:42` 因为"值没变"不会被重设，
  //   结果整屏容器塌成 0 高、内容全跑到视口外。一律用 left/right/bottom 长写。
  if (!state) {
    return (
      <div style={{ position: 'absolute', inset: 0, background: C.bg, color: C.text }}>
        <TopBar linkOk={false} />
        <div style={{ position: 'absolute', top: 42, left: 0, right: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 15 }}>正在连接宿主…</div>
          <div style={{ fontSize: 12, color: C.textDim }}>通道 {wsUrl}</div>
          {error && <div style={{ fontSize: 12, color: C.bad }}>{error}</div>}
        </div>
      </div>
    )
  }

  const step = state.step

  return (
    <div style={{ position: 'absolute', inset: 0, background: C.bg, color: C.text }}>
      <TopBar linkOk={state.wsClients > 0} />

      <div style={{ position: 'absolute', top: 42, left: 0, right: 0, bottom: 0 }}>
        {step <= 1 && (
          <BootScreen
            state={state}
            running={busy}
            onStart={() => void run('boot.run', { pacingMs: 400 })}
          />
        )}

        {step === 2 && (
          <SelfCheckScreen
            state={state}
            busy={busy}
            reply={lastReply}
            onRun={() => void run('selfcheck.run', { bypassCache: true })}
            onRecheck={() => void run('selfcheck.recheck', {})}
            onEnter={() => void run('flow.enter', {})}
          />
        )}

        {step >= 3 && (
          /* `data-ma-stagestrip` 是给 index.html 里那条 CSS 用的选择器锚点（截断 /health 原文，
             免得它换行把地图挤下去）；不改 MapStage 的 JSX。 */
          <div data-ma-stagestrip="1" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}>
            <MapStage phase={state.phase} bottomBar={bottomBar} />
          </div>
        )}

        {/* 步 3–5 是**覆盖层**（不是整页替换）：地图台照常跑，各屏只往上摆面板。
            摆成 MapStage 的**兄弟节点**（不是 children）——MapStage 是主 agent 的文件，
            步 6–9 的屏幕也要走同一个插槽，所以这里不动它，只用 z-index 叠上去。
            第 6 步起由 C/D 两组写者的屏幕接管这一层。 */}
        {step === 3 && (
          <StageOverlay>
            <SituationScreen state={state} flow={flow} />
          </StageOverlay>
        )}
        {step === 4 && (
          <StageOverlay>
            <GroupingScreen
              state={state}
              flow={flow}
              onNext={(id) => { setPlanId(id); goto(5) }}
              onSelectPlan={setPlanId}
            />
          </StageOverlay>
        )}
        {step === 5 && (
          <StageOverlay>
            <GroupConfirmScreen
              state={state}
              flow={flow}
              selectedPlanId={planId}
              onPickPlan={setPlanId}
            />
          </StageOverlay>
        )}

        {/* 步 6 任务执行（T2-1/T3-1）：同样是覆盖层——地图台照常画无人机与航迹，
            本屏只叠控制条（起飞/暂停/恢复/倍速）与两块引擎读数面板（链路/覆盖）。 */}
        {step === 6 && (
          <StageOverlay>
            <ExecuteScreen state={state} flow={flow} />
          </StageOverlay>
        )}

        {/* 步 7 实时侦察目标显示（T4-1/T4-2）：目标列表 + 详情/处置 + 视频/SAR 回传面板。 */}
        {step === 7 && (
          <StageOverlay>
            <TargetsScreen state={state} flow={flow} />
          </StageOverlay>
        )}

        {/* 步 8 任务决策与打击准备（T5-1）：三张打击方案卡（成功率/协同方式/预计完成时间/
            方案要点/理由）+ 打击窗口 + 采纳回执。推荐标记只认引擎的 `recommendedId`。 */}
        {step === 8 && (
          <StageOverlay>
            <StrikeScreen
              state={state}
              flow={flow}
              selectedPlanId={strikePlanId}
              onSelectPlan={setStrikePlanId}
              onNext={() => goto(9)}
            />
          </StageOverlay>
        )}

        {/* 步 9 打击方案确认（T5-2）：地图上 IP 点高亮 + 引导连线（`MapDraw`，坐标全部取
            `guidance.plan`）+ 打击窗口时间轴（每段带 basis）+ 确认打击回执逐条显示。 */}
        {step === 9 && (
          <StageOverlay>
            <StrikeConfirmScreen
              state={state}
              flow={flow}
              selectedPlanId={strikePlanId}
              onSelectPlan={setStrikePlanId}
              onBack={() => goto(8)}
            />
          </StageOverlay>
        )}

        {/* 步 10 协同执行与引导（T6-1 实时态势 / T6-2 引导控制）：目标处置
            （`exec.run` / `exec.abort`）逐条回执 + `target.state` 事件驱动的状态与**地图变灰**
            （颜色只由引擎状态决定）+ 回传画面（`media.channels`）。 */}
        {step === 10 && (
          <StageOverlay>
            <GuidanceScreen state={state} flow={flow} onNext={() => goto(11)} />
          </StageOverlay>
        )}

        {/* 步 11 任务总结（T7-1 毁伤评估 / T7-2 结果汇总）：`report.generate` 的报告卡
            （分组/字段/缺失原因全部以返回结构为准）+ phase-engine 的时间轴 + 预警计数 + JSON 复看。 */}
        {step === 11 && (
          <StageOverlay>
            <SummaryScreen state={state} flow={flow} onBack={() => goto(10)} />
          </StageOverlay>
        )}
      </div>

      {/* 流程回执（左下角一行）：步骤 + 阶段 + 最近一条命令的结果 */}
      <div style={flowBadgeStyle}>
        步 {state.step}/{11} · {state.stepTitle || state.stepKey}
        {state.phase ? ` · 阶段 ${state.phase}` : ''}
        {lastReply && lastReply.code !== 0
          ? ` · 命令失败 code=${lastReply.code}（${lastReply.error?.message ?? ''}）`
          : ''}
      </div>

      {/* 自证句柄：验收脚本读它（不改渲染行为） */}
      <Probe state={state} />
    </div>
  )
}

const statusBarStyle: CSSProperties = {
  position: 'absolute', left: 0, right: 0, bottom: 0, height: 28, zIndex: 12,
  display: 'flex', gap: 18, alignItems: 'center', padding: '0 14px',
  background: 'rgba(6, 26, 47, 0.9)', borderTop: `1px solid ${C.border}`, fontSize: 12,
}

const flowBadgeStyle: CSSProperties = {
  position: 'absolute', left: 12, bottom: 34, zIndex: 40, fontSize: 11.5,
  color: C.textDim, background: 'rgba(6,26,47,.72)', border: `1px solid ${C.border}`,
  borderRadius: 6, padding: '2px 8px', pointerEvents: 'none',
}

/** 把当前流程状态挂到 window 上供脚本断言（只读，不影响渲染）。 */
function Probe({ state }: { state: NonNullable<ReturnType<typeof useFlow>['state']> }) {
  const w = window as unknown as { __flowStats?: () => unknown }
  w.__flowStats = () => ({
    step: state.step,
    stepKey: state.stepKey,
    stepTitle: state.stepTitle,
    phase: state.phase,
    boot: {
      overall: state.boot.progress?.overall ?? null,
      complete: state.boot.complete ?? null,
      modules: (state.boot.modules ?? []).map((m) => ({ key: m.key, name: m.name, percent: m.percent, status: m.status, detail: m.detail, metric: m.metric })),
    },
    selfCheck: state.selfCheck
      ? {
        status: state.selfCheck.status,
        checkedAt: state.selfCheck.checkedAt,
        elapsedMs: state.selfCheck.elapsedMs,
        items: state.selfCheck.items.map((i) => ({ key: i.key, name: i.name, status: i.status, reason: i.reason, advice: i.advice, metric: i.metric, subs: (i.subs ?? []).map((s) => ({ probe: s.probe, status: s.status })) })),
      }
      : null,
    overview: (state.systemOverview ?? []).map((o) => ({ key: o.key, text: o.text, status: o.status })),
    statusBar: (state.statusBar ?? []).map((o) => ({ key: o.key, text: o.text, status: o.status })),
    wsClients: state.wsClients,
  })
  return null
}

export default App
