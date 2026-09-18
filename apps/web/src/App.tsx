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
import { AppShell, MicBall, SHELL_METRICS, type NavKey } from './shell/AppShell'
import { VoiceStrip, voiceLine, useLabels } from './shell/VoiceStrip'
import { SCREEN_BY_ID, defaultScreenForStep, NAV_TARGET } from './screens/registry'
import { BootScreen, BOOT_HOLD_FOR_DEBUG } from './screens/BootScreen'
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
import { useMapUiStore } from 'map-2d'

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
  // 清屏模式（map-2d 的 UI 状态；工具栏的【清屏】把它置 true）
  const clearMode = useMapUiStore((s) => s.clearMode)
  const setClearMode = useMapUiStore((s) => s.setClearMode)
  /**
   * 清屏时按 **Esc** 退出（用户第 6 条："按 Esc 再次显示出来"）。
   * 与 map-2d `DrawLayer` 自己的 Esc（退出绘制模式）互不冲突：那一条只把 mode 置 none。
   * 两件事同时发生（退出绘制 + 退出清屏）符合直觉。
   */
  useEffect(() => {
    if (!clearMode) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.fullscreenElement) setClearMode(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [clearMode, setClearMode])
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

  /**
   * **启动页的调试闸门**（用户 2026-09-17 逐屏确认第 2 条）。
   *
   * 交付形态：`BOOT_HOLD_FOR_DEBUG = false` → 界面照宿主的步号走，启动加载一完成就自动落到下一屏。
   * 调试形态（当前）：宿主的步号**其实已经推进到步 2**，但界面**先不跟**，继续停在 SH-01，
   * 直到屏上的【进入下一屏（调试）】被点 —— 点之前 `bootReleased` 一直是 false。
   *
   * 为什么放在这一层：自动跳转是**宿主**的行为（boot 完成即推进步号），前端要"按住"它，
   * 只能在**屏路由**这一层让 SH-01 的渲染优先于宿主步号。深链 `?screen=` 时闸门让位（拍图/排障要用）。
   */
  const [bootReleased, setBootReleased] = useState(!BOOT_HOLD_FOR_DEBUG)
  const holdBoot = !bootReleased && !screenParam && step >= 1 && step <= 2
  const showBootScreen = def.id === 'SH-01' || holdBoot

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

  // ---- 排障后门：直接看地图台（**保留开发自证信息条**，产品屏上没有它）----
  if (stageOverride === 'map') {
    return (
      <div style={{ position: 'absolute', inset: 0, background: C.bg, color: C.text }}>
        <TopBar linkOk />
        <div style={{ position: 'absolute', top: 42, left: 0, right: 0, bottom: 0 }}>
          <MapStage phase="T4" debug />
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
  // `showBootScreen` 额外覆盖了"启动页调试闸门"按住的这一种情况（见上面的注释）。
  if (showBootScreen) {
    return (
      <div style={{ position: 'absolute', inset: 0, background: C.bg, color: C.text }}>
        <TopBar linkOk={state.wsClients > 0} />
        <div style={{ position: 'absolute', top: 42, left: 0, right: 0, bottom: 0 }}>
          <BootScreen
            state={state}
            running={busy}
            /**
             * 启动加载的**节拍**（每个模块体检完之后歇一下）。
             *
             * 用户 2026-09-18："启动界面太快了，**加载总长度 30 秒左右**，修改一下"。
             * 宿主的 `boot.run{pacingMs}` 是"**每个模块**处理完后 sleep 这么多"，
             * 而模块是 5 个（地图引擎/通信链路/AI引擎/集群管理/数据服务）→ 5 × 6000 ≈ **30 秒**。
             * 注意：`demo.ps1 runAll` / `flow.runAll` 走的是它们自己的 pacing（默认 0），**不受这里影响**
             * —— 一键演示不会因此变慢。
             */
            onStart={() => void run('boot.run', { pacingMs: 6000 })}
            onEnterNext={() => setBootReleased(true)}
          />
        </div>
        {screenParam && <ForcedNotice step={state.step} screen={def.id} />}
        <Probe state={state} screen={def.id} />
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
            // 逐项重检：屏上按 4 秒节拍一项一项发（合计约 20 秒，落在"15~30 秒"里）。
            // 每一下都是真的 selfcheck.recheck{keys:[该项]}，引擎只重跑该项的探针、其余项沿用上次结论
            //（selfcheck/src/engine.cc:737-739）。
            onRecheckOne={(key) => send('selfcheck.recheck', { keys: [key] }).then(() => undefined)}
            onEnter={() => void run('flow.enter', {})}
          />
        </div>
        {screenParam && <ForcedNotice step={state.step} screen={def.id} />}
        <Probe state={state} screen={def.id} />
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
        <Probe state={state} screen={def.id} />
        <BackToFlow onBack={() => { locked.current = false; setScreenId(null) }} />
      </div>
    )
  }

  // ---- 其余（SH-03…SH-18）：全局框架 + 分屏 ----
  const vScreen = activeId.toLowerCase().replace('-', '') // 'SH-04' → 'sh04'
  const hasVoice = !!(voiceLine(labels, vScreen, 'system') || voiceLine(labels, vScreen, 'question'))
  return (
    <div style={{ position: 'absolute', inset: 0, background: C.bg, color: C.text }}>
      {/* 地图层挪到下面 UI 之后渲染（见文件末尾）—— 那里有为什么 */}

      {/* ---------------- 其余 UI：清屏时整体隐藏（保持挂载，图元不丢） ---------------- */}
      <div style={{ display: clearMode ? 'none' : 'contents' }}>
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
      </div>

      {/* ---------------- 地图层：**所有屏共用**（含 SH-03） ----------------
          ★ 用户第 6 条："清屏功能，不同于全屏功能，清屏应该隐藏所有**没有绘制在地图上**的东西，
            按 Esc 再次显示出来"。为实现它，地图从 SH-03 的屏内搬到这一层（`SituationScreen` 不再
            自带 `MapStage`）：清屏 = UI 整体 `display:none`（**只隐藏、不卸载** —— 各屏往地图上画的
            图元是命令式写入的，卸载会把它们一起清掉），地图原样留着。

          ★ **为什么放在 UI 之后（DOM 顺序靠后）**：实测踩过 —— 放在 UI 之前时，`AppShell` 的
            `CONTENT_INSET` 是一个铺满内容区的定位盒子，它会把地图上的**点击全部吃掉**
            （表现：量算点不出点、量算自证 4/6 挂）。挪到 UI 之后，地图在"没有面板的地方"就是
            最上层，点击直达地图；而各屏的面板都有 `z-index: 20+`，仍旧压在地图之上。
          ★ 不在清屏时地图让开左侧导航（`NAV_W`）与顶栏；清屏时铺满整屏（导航顶栏都隐掉了）。 */}
      <div
        style={{
          position: 'absolute',
          top: clearMode ? 0 : 42,
          left: clearMode ? 0 : SHELL_METRICS.NAV_W,
          right: 0, bottom: 0,
        }}
        data-ma-stagestrip={clearMode ? undefined : '1'}
      >
        <MapLayer state={state} screenId={activeId} />
      </div>

      {/* 清屏时的唯一出口（图上没有；不给出口就出不来） */}
      {clearMode && <ExitClearMode onExit={() => setClearMode(false)} />}
      <Probe state={state} screen={def.id} />
    </div>
  )
}

/** 清屏模式的退出按钮（右下角，Esc 同效）。 */
function ExitClearMode({ onExit }: { onExit: () => void }) {
  return (
    <button
      data-testid="exit-clear-mode"
      onClick={onExit}
      title="退出清屏（Esc）"
      style={{
        position: 'absolute', right: 16, bottom: 16, zIndex: 60,
        padding: '7px 14px', fontSize: 12.5, cursor: 'pointer', borderRadius: 8,
        background: 'rgba(10,20,36,.85)', border: `1px solid ${C.borderStrong}`, color: C.text,
      }}
    >退出清屏 (Esc)</button>
  )
}

/**
 * 地图台：**所有屏共用同一张地图**（含 SH-03，2026-09-18 从 `SituationScreen` 搬到这里，
 * 好让"清屏"能统一实现：地图留在外面，其余 UI 整体隐藏）。
 * SH-07 / SH-08 是拓扑屏（图上无地图）→ 返回 null。
 */
function MapLayer({ state, screenId }: { state: NonNullable<ReturnType<typeof useFlow>['state']>; screenId: string }) {
  // SH-04/SH-05/SH-06/SH-09…SH-18 需要地图；SH-07/SH-08 是拓扑屏（图上无地图）
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

/**
 * 左下角**流程徽标已按用户要求删除**（2026-09-18："左下角，每个界面都有的第几阶段那个去除，
 * 没必要使用，演示也不需要，删除吧"）。
 *
 * 它原先显示 `步 N/11 · 屏名 · 阶段 Tx`，并在命令失败时追加一行 `命令失败 code=…`。
 * 删除后：
 *   · "当前在哪一屏"这件事仍可从 `window.__flowStats().screen` 读到（原来是靠这个徽标的
 *     `data-screen` 属性，验收脚本都在读它 —— 见下面的 `Probe`，**脚本因此不用改口径**）；
 *   · "哪条命令失败了"仍有出口：各屏自己的红字回执 + 右栏/折叠块里的「命令回执」。
 */

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

const noticeStyle = {
  position: 'absolute' as const, left: 90, bottom: 44, zIndex: 60, fontSize: 12,
  color: C.text, background: 'rgba(120,60,10,.92)', border: '1px solid rgba(245,158,11,.6)',
  borderRadius: 8, padding: '6px 10px', cursor: 'pointer', maxWidth: 520,
}

/**
 * 把当前流程状态挂到 window 上供脚本断言（只读，不影响渲染）。
 *
 * ★ `screen` 是 2026-09-18 从**已删除的左下角流程徽标**搬过来的：那个徽标原先带着
 * `data-screen`，四个验收脚本（`click-check` / `click-real` / `screenshots` / `p3-check`）
 * 都靠它判断"现在在哪一屏"。徽标按用户要求删掉后，"在哪一屏"这件事改由这里提供 ——
 * **脚本的口径因此不必变**（它们改成读 `__flowStats().screen` 即可）。
 */
function Probe({ state, screen }: { state: NonNullable<ReturnType<typeof useFlow>['state']>; screen: string }) {
  const w = window as unknown as { __flowStats?: () => unknown }
  w.__flowStats = () => ({
    /** 当前渲染的是哪一屏（SH-01…SH-20）—— 从已删除的流程徽标搬来 */
    screen,
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
