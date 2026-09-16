// mission-app · apps/web/src/screens/BootScreen.tsx
//
// Excel 步 1 · 启动加载界面（参考图 `系统启动界面一.png`）。
//
// 五张模块卡片的百分比**不是动画**：它们来自宿主 `boot.modules[].percent`，
// 而那个值来自 selfcheck 引擎的进度源，由**真实条件**推进（见 host 的 flow.cc 注释）：
//   10 = 该模块的体检已开始 · 50 = 已完成一次真实体检 · 100 = 规则包判定为就绪。
// 页面做两件事：进入时发一次 `boot.run`（幂等），以及把状态画出来。
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { C, panel, panelTitle, levelColor, statusColor } from '../theme'
import { HintBar, ProgressBar, StatusPanel, SYS_NAME } from './Chrome'
import type { FlowState } from '../api'

const MODULE_ICON: Record<string, string> = {
  map: '▤', link: '◍', ai: '⌘', cluster: '⛓', data: '▥',
}

export function BootScreen({ state, onStart, running }: {
  state: FlowState
  onStart: () => void
  running: boolean
}) {
  const boot = state.boot
  const modules = boot.modules ?? []
  const overall = boot.progress?.overall ?? boot.overall ?? 0
  const started = useRef(false)

  // 进入即发一次（幂等：宿主在跑/已完成时会回 accepted=false + 原因，不会重复跑）
  useEffect(() => {
    if (started.current) return
    started.current = true
    onStart()
  }, [onStart])

  return (
    <div style={{ position: 'absolute', inset: 0, background: `radial-gradient(120% 90% at 50% 10%, #0a2547 0%, ${C.bg} 55%, #02101f 100%)` }}>
      <div style={{ position: 'absolute', top: 0, bottom: 34, left: 0, right: 0, display: 'flex', gap: 14, padding: 14 }}>
        {/* 中间：Logo + 进度（小窗口下可滚动，不裁内容） */}
        <div style={{ flex: 1, minWidth: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          <img src="/logo.png" alt="" style={{ width: 84, height: 84, objectFit: 'contain', filter: 'drop-shadow(0 0 24px rgba(95,176,255,.55))' }} />
          <div style={{ fontSize: 22, letterSpacing: 4, color: '#eaf4ff', textShadow: '0 0 18px rgba(95,176,255,.5)' }}>{SYS_NAME}</div>
          <div style={{ fontSize: 13, color: C.textDim }}>
            {boot.complete ? '初始化完成' : '系统启动中，请稍候…'}
          </div>
          <div style={{ width: '56%', marginTop: 4 }}>
            <ProgressBar percent={overall} height={9} />
          </div>

          {/* 模块加载进度 */}
          <div style={{ ...panel, width: '64%', marginTop: 14 }}>
            <div style={panelTitle}>模块加载进度</div>
            <div style={{ display: 'flex', padding: '10px 8px' }}>
              {modules.map((m) => (
                <div key={m.key} style={{ flex: 1, textAlign: 'center', padding: '0 6px' }}>
                  <div style={{ fontSize: 20, color: C.accent, lineHeight: '26px' }}>
                    {MODULE_ICON[m.key] ?? '◈'}
                  </div>
                  <div style={{ fontSize: 12, color: C.text, marginTop: 4 }}>{m.name ?? m.key}</div>
                  <div style={{ marginTop: 6 }}>
                    <ProgressBar percent={m.percent} height={3} showText={false} />
                  </div>
                  <div style={{ fontSize: 11.5, color: C.textDim, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
                    {Math.round(m.percent)}%
                  </div>
                  {m.detail && (
                    <div style={{ fontSize: 11, color: levelColor(m.level), marginTop: 2 }}>{m.detail}</div>
                  )}
                </div>
              ))}
              {!modules.length && (
                <div style={{ padding: '0 12px', fontSize: 12, color: C.textDim }}>
                  {state.boot.note || '（宿主未给出模块进度）'}
                </div>
              )}
            </div>
          </div>

          {!running && !boot.complete && (
            <button onClick={onStart} style={retryStyle}>重新加载</button>
          )}
        </div>

        <StatusPanel items={state.systemOverview} loading={!state.selfCheckReady} />
      </div>
      <HintBar text={boot.complete
        ? '初始化完成，正在进入系统状态自检…'
        : `系统启动中，正在初始化核心模块…${state.wsClients ? '' : '（实时通道未连接）'}`} />
    </div>
  )
}

const retryStyle: CSSProperties = {
  marginTop: 10, padding: '5px 14px', fontSize: 12, cursor: 'pointer', borderRadius: 6,
  background: 'rgba(10,20,36,.8)', border: `1px solid ${C.border}`, color: C.text,
}

/** 启动页的自证句柄（`window.__bootStats`）：验收脚本读它，不改渲染行为。 */
export function bootProbe(state: FlowState) {
  return {
    step: state.step,
    stepKey: state.stepKey,
    overall: state.boot.progress?.overall ?? null,
    complete: state.boot.complete ?? null,
    modules: (state.boot.modules ?? []).map((m) => ({ key: m.key, name: m.name, percent: m.percent, status: m.status, detail: m.detail })),
    overview: (state.systemOverview ?? []).map((o) => ({ key: o.key, text: o.text, status: o.status })),
    wsClients: state.wsClients,
    colorOf: statusColor,
  }
}
