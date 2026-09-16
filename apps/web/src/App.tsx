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
import { DEFAULT_WS_URL } from './telemetry'
import { C, statusColor } from './theme'
import { TopBar } from './screens/Chrome'
import { BootScreen } from './screens/BootScreen'
import { SelfCheckScreen } from './screens/SelfCheckScreen'
import { MapStage } from './MapStage'

function param(name: string): string | null {
  try { return new URLSearchParams(window.location.search).get(name) } catch { return null }
}

export function App() {
  const wsUrl = param('ws') ?? DEFAULT_WS_URL
  const stageOverride = param('stage')
  const { state, error, send, lastReply } = useFlow(wsUrl)
  const [busy, setBusy] = useState(false)

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
          <MapStage phase={state.phase} bottomBar={bottomBar} />
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
