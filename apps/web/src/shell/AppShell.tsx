// mission-app · apps/web/src/shell/AppShell.tsx
//
// **全局框架**（需求专篇 DES-APP-001 §2 / G-02…G-06、G-12）：
//   顶栏（Chrome.TopBar） ｜ 左侧 7 项功能导航 ｜ 内容区（各屏自己的地图/面板） ｜ 底部 6 段全局状态条 ｜ 右下角麦克风球
//
// ★ 纪律：
//   · 这一层只摆位置、只切高亮，**不写业务文案、不编状态值** —— 6 段状态的文字全部来自宿主
//     （`statusBar`，取不到就回落 `systemOverview`，再取不到显示"—"）。
//   · 启动两屏（SH-01/SH-02）与两张**大屏**（SH-19/SH-20）不套这层壳（图上它们没有左导航/状态条/麦克风）。
import { type CSSProperties, type ReactNode } from 'react'
import { C, statusColor } from '../theme'
import type { FlowState } from '../api'

/** 左侧导航 7 项（逐字来自界面图：态势 / 任务 / 目标 / 区域 / 资源 / 告警 / 设置）。 */
export const NAV_ITEMS = ['态势', '任务', '目标', '区域', '资源', '告警', '设置'] as const
export type NavKey = (typeof NAV_ITEMS)[number]

/** 底部全局状态条 6 段（逐字来自界面图）。 */
export const STATUS_SLOTS: Array<{ key: string; name: string; from: string[] }> = [
  { key: 'system', name: '系统状态', from: ['system', 'network'] },
  { key: 'uav', name: '无人机状态', from: ['uav', 'drones', 'fleet'] },
  { key: 'datalink', name: '数据链路', from: ['datalink', 'link'] },
  { key: 'position', name: '定位状态', from: ['position', 'gps'] },
  { key: 'ai', name: 'AI决策引擎', from: ['ai'] },
  { key: 'security', name: '安全状态', from: ['security'] },
]

const TOP_H = 42
const NAV_W = 74
const BOTTOM_H = 30

/** 内容区（地图/面板）的可用矩形：各屏把它当"整屏"用即可。 */
export const CONTENT_INSET: CSSProperties = {
  position: 'absolute', left: NAV_W, right: 0, top: 0, bottom: 0,
}

function pick(state: FlowState | null, slot: { from: string[] }): string {
  const bars = state?.statusBar ?? []
  for (const key of slot.from) {
    const hit = bars.find((b) => b.key === key)
    if (hit) return hit.text || hit.status
  }
  // 回落：`systemOverview`（/health 的四项）—— 仍取不到就如实显示"—"
  const ov = state?.systemOverview ?? []
  for (const key of slot.from) {
    const hit = ov.find((o) => o.key === key)
    if (hit) return hit.text || hit.status
  }
  return '—'
}

function statusSlotValue(state: FlowState | null, slot: { from: string[] }): { text: string; band: string } {
  const bars = state?.statusBar ?? []
  for (const key of slot.from) {
    const hit = bars.find((b) => b.key === key)
    if (hit) return { text: hit.text || hit.status, band: hit.status }
  }
  const ov = state?.systemOverview ?? []
  for (const key of slot.from) {
    const hit = ov.find((o) => o.key === key)
    if (hit) return { text: hit.text || hit.status, band: hit.status }
  }
  return { text: pick(state, slot), band: 'unknown' }
}

export function LeftNav({ active, onPick }: { active: NavKey; onPick?: (k: NavKey) => void }) {
  return (
    <div style={navStyle}>
      {NAV_ITEMS.map((k) => {
        const on = k === active
        return (
          <button
            key={k}
            data-testid={`nav-${k}`}
            data-nav-active={on ? '1' : '0'}
            onClick={() => onPick?.(k)}
            style={{
              width: 56, padding: '9px 0', borderRadius: 8, cursor: 'pointer',
              border: `1px solid ${on ? C.borderStrong : 'transparent'}`,
              background: on ? 'rgba(29,78,216,.45)' : 'transparent',
              color: on ? C.text : C.textDim, fontSize: 12.5, lineHeight: 1.2,
            }}
          >{k}</button>
        )
      })}
    </div>
  )
}

/** 底部 6 段全局状态条（图上逐字 6 项；值取宿主，取不到给"—"）。 */
export function BottomStatusBar({ state }: { state: FlowState | null }) {
  return (
    <div data-testid="bottom-status" style={bottomStyle}>
      {STATUS_SLOTS.map((s) => {
        const v = statusSlotValue(state, s)
        return (
          <span key={s.key} data-status-key={s.key} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <span style={{ color: C.textDim }}>{s.name}：</span>
            <span style={{ color: statusColor(v.band) }}>{v.text}</span>
          </span>
        )
      })}
    </div>
  )
}

/** 右下角圆形麦克风球（图上每屏都有；点击展开/收起当前屏的 AI 语音条）。 */
export function MicBall({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      data-testid="mic-ball"
      data-open={open ? '1' : '0'}
      title="AI 语音（点击展开本屏语音条）"
      onClick={onToggle}
      style={{
        position: 'absolute', right: 16, bottom: BOTTOM_H + 14, zIndex: 45,
        width: 44, height: 44, borderRadius: '50%', cursor: 'pointer',
        border: `1px solid ${C.borderStrong}`,
        background: open ? 'rgba(56,189,248,.35)' : 'rgba(29,78,216,.55)',
        color: '#eaf6ff', fontSize: 18, lineHeight: 1,
        boxShadow: '0 0 12px rgba(56,189,248,.35)',
      }}
    >🎙</button>
  )
}

/**
 * 整屏壳：顶栏 + 左导航 + 内容区 + 底部状态条 + 麦克风球。
 * 各屏把内容放进 `children`（内容区已避开左导航与底部状态条）。
 */
export function AppShell({ state, nav, onNav, voice, children }: {
  state: FlowState | null
  nav: NavKey
  onNav?: (k: NavKey) => void
  /** 语音条（由调用方决定展开与否与内容） */
  voice?: ReactNode
  children: ReactNode
}) {
  return (
    <>
      <LeftNav active={nav} onPick={onNav} />
      <div style={CONTENT_INSET}>{children}</div>
      {voice}
      <BottomStatusBar state={state} />
    </>
  )
}

export const SHELL_METRICS = { TOP_H, NAV_W, BOTTOM_H }

const navStyle: CSSProperties = {
  position: 'absolute', left: 0, top: 0, bottom: BOTTOM_H, width: NAV_W, zIndex: 25,
  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, paddingTop: 10,
  background: 'rgba(5,20,38,.92)', borderRight: `1px solid ${C.border}`,
}
const bottomStyle: CSSProperties = {
  position: 'absolute', left: 0, right: 0, bottom: 0, height: BOTTOM_H, zIndex: 30,
  display: 'flex', gap: 18, alignItems: 'center', padding: '0 14px', flexWrap: 'nowrap',
  background: 'rgba(6, 26, 47, 0.95)', borderTop: `1px solid ${C.border}`, fontSize: 12,
}
