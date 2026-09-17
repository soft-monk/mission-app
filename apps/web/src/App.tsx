// mission-app · apps/web/src/App.tsx
//
// 前端总入口 = **屏路由**（需求专篇 DES-APP-001 §1/§4）。
//   ① 与宿主同步状态（`useFlow`：轮询 + WS）
//   ② 按 `state.step` 选"这一步的默认屏"，并允许用户在同一组内切子屏（`setScreen`）
//   ③ 给所有屏套**全局框架**（顶栏 + 左导航 7 项 + 底部 6 段状态条 + 麦克风球）
//
// ★ 纪律：
//   · 本文件不写业务文案、不编百分比、不判断"通过与否"——取值全部来自 `/api/state`（源头是引擎+规则包）；
//   · **前端不许自己改步号**：切屏只改本地 `screenId`，要动流程一律发命令（`flow.goto` / `mission.advance`）；
//   · 图上没有的屏不做，图上没有的按钮不加（例外见 README「本轮的已知偏差」）。
//
// 排障后门：`?stage=map` 直接进地图台；`?screen=SH-09` 直达某一屏（截图脚本用）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useFlow } from './flow/useFlow'
import { useGoto } from './flow/useSituation'
import { DEFAULT_WS_URL } from './telemetry'
import { C } from './theme'
import { TopBar } from './screens/Chrome'
import { AppShell, MicBall, type NavKey } from './shell/AppShell'
import { VoiceStrip, voiceLine, useLabels } from './shell/VoiceStrip'
import { SCREEN_BY_ID, defaultScreenForStep, NAV_TARGET } from './screens/registry'
import { BootScreen } from './screens/BootScreen'
import { SelfCheckScreen } from './screens/SelfCheckScreen'
import { SituationScreen } from './screens/SituationScreen'
import { SceneConfirmScreen } from './screens/SceneConfirmScreen'
import { GroupingScreen } from './screens/GroupingScreen'
import { GroupConfirmScreen } from './screens/GroupConfirmScreen'
import { LinkTopologyScreen } from './screens/LinkTopologyScreen'
import { LinkStableScreen } from './screens/LinkStableScreen'
import { ReconExpandScreen } from './screens/ReconExpandScreen'
import { ReconFusionScreen } from './screens/ReconFusionScreen'
import { TargetsScreen } from './screens/TargetsScreen'
import { StrikeScreen } from './screens/StrikeScreen'
import { StrikeConfirmScreen } from './screens/StrikeConfirmScreen'
import { GuidanceScreen } from './screens/GuidanceScreen'
import { DamageAssessScreen } from './screens/DamageAssessScreen'
import { SummaryScreen } from './screens/SummaryScreen'
import { BigScreenExec } from './screens/BigScreenExec'
import { BigScreenRecon } from './screens/BigScreenRecon'
import { MapStage } from './MapStage'

function param(name: string): string | null {
  try { return new URLSearchParams(window.location.search).get(name) } catch { return null }
}

/**
 * 步号 → 要依次推进的**阶段链**（按 `phase-engine/policies/mapapp/phases.json` 的阶段图：
 * 只能沿相邻边前进，所以"步 6 → 步 7"是 `T3` 再 `T4`）。
 * 与 `config.json` 的 `flow.steps[].phase` 是同一份事实，这里只是"从当前步走到目标步要过哪几个阶段"。
 */
const ADVANCE_CHAIN: Record<number, string[]> = {
  3: ['T0'],
  4: ['T1'],
  6: ['T2'],
  7: ['T3', 'T4'],
  8: ['T5'],
  10: ['T6'],
  11: ['T7'],
}

export function App() {
  const wsUrl = param('ws') ?? DEFAULT_WS_URL
  const stageOverride = param('stage')
  const screenParam = param('screen')
  const flow = useFlow(wsUrl)
  const { state, error, send, lastReply } = flow
  const labels = useLabels()

  const [busy, setBusy] = useState(false)
  // 本地"这一步里的哪一屏"。null = 跟随宿主步号（`?screen=` 深链时锁定不跟随）
  const [screenId, setScreenId] = useState<string | null>(screenParam)
  const locked = useRef(!!screenParam)
  const [planId, setPlanId] = useState<string | null>(null)
  const [strikePlanId, setStrikePlanId] = useState<string | null>(null)
  const [nav, setNav] = useState<NavKey>('态势')
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  /**
   * **走流程**：把"进入第 N 步"翻译成**先推进阶段、再落屏**。
   *
   * 为什么不是一句 `flow.goto{step:N}`：`flow.goto` 只换屏、**不动阶段**（阶段图是引擎的规则），
   * 于是屏上写的"步 6"和引擎里的阶段 T0 会对不上，后续所有靠阶段门禁的 verb 都会被拒
   * （实测：一路 `flow.goto` 走到步 6，阶段仍停在 T0，`mission.advance{T3}` 直接被门禁挡下）。
   *
   * 所以：① 按阶段图的**边**依次 `mission.advance`（跨中间阶段的走链，例：步 7 = T3 → T4）；
   *      ② 再发一次 `flow.goto{step}` 把屏定死（阶段推进成功时它本来就落到同一步，是幂等收尾）。
   * 阶段推进被 Gate 挡下时**照实回执**（界面会显示），随后仍把屏切过去 —— 不假装阶段成功。
   */
  const goto = useCallback(async (target: number) => {
    const chain = ADVANCE_CHAIN[target] ?? []
    for (const phase of chain) {
      const r = await send('mission.advance', { to: phase })
      if (r.code !== 0) break
    }
    await send('flow.goto', { step: target })
  }, [send])

  const run = useCallback(async (verb: string, params: Record<string, unknown> = {}) => {
    setBusy(true)
    try { await send(verb, params) } finally { setBusy(false) }
  }, [send])

  const step = state?.step ?? 0
  // 宿主步号变了 → 回到这一步的默认屏（深链锁定时不跟随，截图脚本要它停在指定屏）
  const prevStep = useRef<number | null>(null)
  useEffect(() => {
    if (prevStep.current !== null && prevStep.current !== step && !locked.current) setScreenId(null)
    prevStep.current = step
  }, [step])

  // 当前屏：`?screen=` 深链优先，否则跟随宿主步号（步 1/2 是启动与自检两屏）
  const activeId = screenId ?? defaultScreenForStep(step || 1)
  const def = SCREEN_BY_ID[activeId] ?? SCREEN_BY_ID['SH-03']

  const go = useCallback((id: string) => {
    const d = SCREEN_BY_ID[id]
    setScreenId(id)
    if (d) setNav(d.nav)
  }, [])

  const onNav = useCallback((k: NavKey) => {
    setNav(k)
    const target = NAV_TARGET[k]
    if (!target) { setNotice(`左导航「${k}」本期未实现（图上保留该入口）`); return }
    if (step < target.needStep) { setNotice(`「${k}」要第 ${target.needStep} 步之后才可用（当前第 ${step} 步）`); return }
    setNotice(null)
    const sameStep = target.screens.find((id) => SCREEN_BY_ID[id]?.steps.includes(step))
    go(sameStep ?? target.screens[0])
  }, [go, step])

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

  // ---- 首帧：还没拿到状态 ----
  // ★ 别用 `inset` 简写（曾踩过：简写移除会连带清掉 top，整屏容器塌成 0 高）——一律长写。
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

  // ---- SH-01 / SH-02：图上另有版式（无左导航/状态条/麦克风）----
  // 注意：判据是**当前屏**而不是宿主步号 —— 这样 `?screen=SH-03` 在宿主还停在步 2 时也能直达
  // （截图脚本要靠它；屏上的数据可能未就绪，那是当期真实状态）。
  if (def.id === 'SH-01') {
    return (
      <div style={{ position: 'absolute', inset: 0, background: C.bg, color: C.text }}>
        <TopBar linkOk={state.wsClients > 0} />
        <div style={{ position: 'absolute', top: 42, left: 0, right: 0, bottom: 0 }}>
          <BootScreen state={state} running={busy} onStart={() => void run('boot.run', { pacingMs: 400 })} />
        </div>
        <FlowBadge state={state} lastReply={lastReply} screenId="SH-01" />
        {screenParam && <ForcedNotice step={state.step} screen={def.id} />}
        <Probe state={state} />
      </div>
    )
  }
  if (def.id === 'SH-02') {
    return (
      <div style={{ position: 'absolute', inset: 0, background: C.bg, color: C.text }}>
        <TopBar linkOk={state.wsClients > 0} />
        <div style={{ position: 'absolute', top: 42, left: 0, right: 0, bottom: 0 }}>
          <SelfCheckScreen
            state={state}
            busy={busy}
            reply={lastReply}
            onRun={() => void run('selfcheck.run', { bypassCache: true })}
            onRecheck={() => void run('selfcheck.recheck', {})}
            onEnter={() => void run('flow.enter', {})}
          />
        </div>
        <FlowBadge state={state} lastReply={lastReply} screenId="SH-02" />
        {screenParam && <ForcedNotice step={state.step} screen={def.id} />}
        <Probe state={state} />
      </div>
    )
  }

  // ---- SH-19 / SH-20：两张**大屏**（图上自成一壳：居中大标题、无左导航/状态条/麦克风）----
  if (def.id === 'SH-19' || def.id === 'SH-20') {
    return (
      <div style={{ position: 'absolute', inset: 0, background: C.bg, color: C.text }}>
        <TopBar linkOk={state.wsClients > 0} />
        <div style={{ position: 'absolute', top: 42, left: 0, right: 0, bottom: 0 }}>
          {def.id === 'SH-19'
            ? <BigScreenExec state={state} flow={flow} />
            : <BigScreenRecon state={state} flow={flow} />}
        </div>
        <FlowBadge state={state} lastReply={lastReply} screenId={def.id} />
        <Probe state={state} />
        <BackToFlow onBack={() => { locked.current = false; setScreenId(null) }} />
      </div>
    )
  }

  // ---- 其余（SH-03…SH-18）：全局框架 + 分屏 ----
  const vScreen = activeId.toLowerCase().replace('-', '') // 'SH-04' → 'sh04'
  const hasVoice = !!(voiceLine(labels, vScreen, 'system') || voiceLine(labels, vScreen, 'question'))
  return (
    <div style={{ position: 'absolute', inset: 0, background: C.bg, color: C.text }}>
      <TopBar linkOk={state.wsClients > 0} />
      <div style={{ position: 'absolute', top: 42, left: 0, right: 0, bottom: 0 }} data-ma-stagestrip="1">
        <AppShell
          state={state}
          nav={nav}
          onNav={onNav}
          voice={voiceOpen ? (
            <div style={{ position: 'absolute', right: 16, bottom: 88, zIndex: 44, width: 340 }}>
              {hasVoice
                ? <VoiceStrip labels={labels} screen={vScreen} title={`AI语音（${def.title}）`} />
                : <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 12px', background: 'rgba(10,32,58,.85)', fontSize: 11.5, color: C.textDim }}>
                    本屏图上没有语音台词（`flow.labels` 里没有 `voice.{vScreen}.*`）
                  </div>}
            </div>
          ) : null}
        >
          {activeId !== 'SH-03' && <MapLayer state={state} screenId={activeId} />}
          <ScreenBody
            id={activeId}
            state={state}
            flow={flow}
            busy={busy}
            lastReply={lastReply}
            goto={goto}
            go={go}
            planId={planId}
            setPlanId={setPlanId}
            strikePlanId={strikePlanId}
            setStrikePlanId={setStrikePlanId}
          />
        </AppShell>
        <MicBall open={voiceOpen} onToggle={() => setVoiceOpen((v) => !v)} />
      </div>

      {notice && (
        <div data-testid="nav-notice" style={noticeStyle} onClick={() => setNotice(null)}>
          {notice}（点这条提示关掉）
        </div>
      )}
      <FlowBadge state={state} lastReply={lastReply} screenId={activeId} />
      <Probe state={state} />
    </div>
  )
}

/** 地图台：除 SH-03（态势主界面自己带地图）外的屏都在同一张地图上叠面板。 */
function MapLayer({ state, screenId }: { state: NonNullable<ReturnType<typeof useFlow>['state']>; screenId: string }) {
  // SH-04/SH-05/SH-06/SH-09/SH-10/SH-11/SH-12 需要地图；SH-07/SH-08 是拓扑屏（图上无地图）
  const noMap = ['SH-07', 'SH-08'].includes(screenId)
  if (noMap) return null
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}>
      <MapStage phase={state.phase} />
    </div>
  )
}

function ScreenBody(p: {
  id: string
  state: NonNullable<ReturnType<typeof useFlow>['state']>
  flow: ReturnType<typeof useFlow>
  busy: boolean
  lastReply: ReturnType<typeof useFlow>['lastReply']
  goto: (n: number) => void
  go: (id: string) => void
  planId: string | null
  setPlanId: (v: string | null) => void
  strikePlanId: string | null
  setStrikePlanId: (v: string | null) => void
}) {
  const { id, state, flow, goto, go } = p
  switch (id) {
    case 'SH-03': return <SituationScreen state={state} flow={flow} onGo={go} />
    case 'SH-04': return <SceneConfirmScreen state={state} flow={flow} onGo={go} goto={goto} />
    case 'SH-05': return <GroupingScreen state={state} flow={flow} onSelectPlan={p.setPlanId} onGo={go} />
    case 'SH-06': return <GroupConfirmScreen state={state} flow={flow} selectedPlanId={p.planId} onPickPlan={p.setPlanId} onGo={go} goto={goto} />
    case 'SH-07': return <LinkTopologyScreen state={state} flow={flow} onGo={go} />
    case 'SH-08': return <LinkStableScreen state={state} flow={flow} onGo={go} goto={goto} />
    case 'SH-09': return <ReconExpandScreen state={state} flow={flow} onGo={go} goto={goto} />
    case 'SH-10': return <ReconFusionScreen state={state} flow={flow} onGo={go} goto={goto} />
    case 'SH-11': return <TargetsScreen state={state} flow={flow} mode="list" onGo={go} />
    case 'SH-12': return <TargetsScreen state={state} flow={flow} mode="detail" onGo={go} />
    case 'SH-13': return <StrikeScreen state={state} flow={flow} selectedPlanId={p.strikePlanId} onSelectPlan={p.setStrikePlanId} onGo={go} />
    case 'SH-14': return <StrikeConfirmScreen state={state} flow={flow} selectedPlanId={p.strikePlanId} onSelectPlan={p.setStrikePlanId} onBack={() => go('SH-13')} onGo={go} goto={goto} />
    case 'SH-15': return <GuidanceScreen state={state} flow={flow} mode="exec" onGo={go} />
    case 'SH-16': return <GuidanceScreen state={state} flow={flow} mode="control" onGo={go} />
    case 'SH-17': return <DamageAssessScreen state={state} flow={flow} onGo={go} goto={goto} />
    case 'SH-18': return <SummaryScreen state={state} flow={flow} onBack={() => go('SH-15')} onGo={go} goto={goto} />
    default: return null
  }
}

/** 左下角流程徽标：`步 N/11 · 屏名 · 阶段`（屏名取注册表，与左上角口径一致）。 */
function FlowBadge({ state, lastReply, screenId }: {
  state: NonNullable<ReturnType<typeof useFlow>['state']>
  lastReply: ReturnType<typeof useFlow>['lastReply']
  screenId: string
}) {
  const def = SCREEN_BY_ID[screenId]
  return (
    <div style={flowBadgeStyle} data-testid="flow-badge" data-screen={screenId}>
      步 {state.step}/11 · {def?.title ?? (state.stepTitle || state.stepKey)}
      {state.phase ? ` · 阶段 ${state.phase}` : ''}
      {lastReply && lastReply.code !== 0
        ? ` · 命令失败 code=${lastReply.code}（${lastReply.error?.message ?? ''}）`
        : ''}
    </div>
  )
}

/** `?screen=` 深链与宿主当前步不一致时的如实提示（截图脚本会用到这个能力）。 */
function ForcedNotice({ step, screen }: { step: number; screen: string }) {
  return (
    <div data-testid="forced-notice" style={{
      position: 'absolute', right: 16, top: 52, zIndex: 60, fontSize: 11.5, lineHeight: 1.7,
      color: C.warn, background: 'rgba(6,26,47,.92)', border: '1px solid rgba(245,158,11,.5)',
      borderRadius: 8, padding: '6px 10px', maxWidth: 380,
    }}>
      本屏由 `?screen={screen}` 强制显示；宿主当前在**第 {step} 步** —— 屏上数据可能尚未就绪（如实显示，不代填）。
    </div>
  )
}

/** 大屏返回按钮（图上没有；大屏是独立壳，没有它就没法回到流程）。 */
function BackToFlow({ onBack }: { onBack: () => void }) {
  return (
    <button
      data-testid="bigscreen-back"
      onClick={onBack}
      style={{
        position: 'absolute', left: 16, top: 56, zIndex: 50, padding: '6px 12px', fontSize: 12,
        borderRadius: 8, border: '1px solid rgba(95,176,255,.45)', background: 'rgba(10,32,58,.85)',
        color: '#cfe3f5', cursor: 'pointer',
      }}
    >← 回到流程界面</button>
  )
}

const flowBadgeStyle = {
  position: 'absolute' as const, left: 12, bottom: 36, zIndex: 40, fontSize: 11.5,
  color: C.textDim, background: 'rgba(6,26,47,.72)', border: `1px solid ${C.border}`,
  borderRadius: 6, padding: '2px 8px', pointerEvents: 'none' as const,
}
const noticeStyle = {
  position: 'absolute' as const, left: 90, bottom: 44, zIndex: 60, fontSize: 12,
  color: C.text, background: 'rgba(120,60,10,.92)', border: '1px solid rgba(245,158,11,.6)',
  borderRadius: 8, padding: '6px 10px', cursor: 'pointer', maxWidth: 520,
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
