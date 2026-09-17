// mission-app · apps/web/src/shell/AppShell.tsx
//
// **全局框架**（需求专篇 DES-APP-001 §2 / G-02…G-06、G-12）：
//   顶栏（Chrome.TopBar） ｜ 左侧 7 项功能导航 ｜ 内容区（各屏自己的地图/面板） ｜ 底部 6 段全局状态条 ｜ 右下角麦克风球
//
// ★ 纪律：
//   · 这一层只摆位置、只切高亮，**不写业务文案、不编状态值** —— 6 段状态的文字全部来自宿主
//     （`statusBar`，取不到就回落 `systemOverview`，再取不到显示"—"）。
//   · 启动两屏（SH-01/SH-02）与两张**大屏**（SH-19/SH-20）不套这层壳（图上它们没有左导航/状态条/麦克风）。
//
// ★ 2026-09-17 返工（用户反馈"左侧菜单栏连图标都没了"）：
//   参考图（`场景1\T0-1.png`）的左导航是**图标 + 文字卡片**、底部状态条是**图标 + 标签 + 值的小卡片**，
//   而需求专篇 §3 SH-03 的版式也白纸黑字写着"左侧竖向 **7 项图标导航**"。
//   上一版只渲染了文字（图标缺失），属于**没照图做**。这里按参考图逐项补回：
//   态势=准星环 / 任务=靶环 / 目标=取景框 / 区域=六边形 / 资源=节点图 / 告警=铃 / 设置=齿轮；
//   状态条 6 项各配一枚小图标（系统=盾勾、无人机=警示三角、链路=云链、定位=定位环、
//   AI=节点图、安全=盾勾）。图标是**纯装饰**（不承载业务取值），颜色跟随宿主给的状态。
import { type CSSProperties, type ReactNode } from 'react'
import { C, statusColor } from '../theme'
import type { FlowState } from '../api'

/** 左侧导航 7 项（逐字来自界面图：态势 / 任务 / 目标 / 区域 / 资源 / 告警 / 设置）。 */
export const NAV_ITEMS = ['态势', '任务', '目标', '区域', '资源', '告警', '设置'] as const
export type NavKey = (typeof NAV_ITEMS)[number]

/** 底部全局状态条 6 段（逐字来自界面图）。 */
export const STATUS_SLOTS: Array<{ key: string; name: string; from: string[]; icon: StatusIconKey }> = [
  { key: 'system', name: '系统状态', from: ['system', 'network'], icon: 'shield' },
  { key: 'uav', name: '无人机状态', from: ['uav', 'drones', 'fleet'], icon: 'warn' },
  { key: 'datalink', name: '数据链路', from: ['datalink', 'link'], icon: 'link' },
  { key: 'position', name: '定位状态', from: ['position', 'gps'], icon: 'position' },
  { key: 'ai', name: 'AI决策引擎', from: ['ai'], icon: 'ai' },
  { key: 'security', name: '安全状态', from: ['security'], icon: 'shield' },
]

const TOP_H = 42
const NAV_W = 78
const BOTTOM_H = 34

/**
 * 内容区（地图/面板）的可用矩形：各屏把它当"整屏"用即可。
 *
 * ★ `bottom: BOTTOM_H` 是**故意**的：底部 6 段状态条是 `zIndex 30` 的浮层，内容区若铺到
 *   `bottom: 0`，各屏写在 `bottom: 12` 的按钮就会落到状态条底下 —— 实测"复位视角"按钮的
 *   中心点命中的就是 `bottom-status`，真人点不动（layout-check 的 covered 判据抓到 28 处）。
 *   把内容区的下边界抬到状态条之上，这一类问题一次性消失，各屏也不必各自记住这个数字。
 */
export const CONTENT_INSET: CSSProperties = {
  position: 'absolute', left: NAV_W, right: 0, top: 0, bottom: BOTTOM_H,
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

// ============================================================================
// 图标（内联 SVG，**照参考图逐项描的形**；纯装饰，不含任何业务取值）
// ============================================================================

const svgBase = {
  fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
}

/** 左导航图标（参考图 7 项） */
function NavGlyph({ k, size = 21 }: { k: NavKey; size?: number }) {
  const p = { width: size, height: size, viewBox: '0 0 24 24', ...svgBase }
  switch (k) {
    // 态势：准星环（外环 + 十字 + 中心圈 + 四向刻度）
    case '态势': return (
      <svg {...p}>
        <circle cx="12" cy="12" r="7" />
        <circle cx="12" cy="12" r="2.4" />
        <path d="M12 2v3.4M12 18.6V22M2 12h3.4M18.6 12H22" />
      </svg>
    )
    // 任务：靶环（外环带刻度 + 内环 + 心点）
    case '任务': return (
      <svg {...p}>
        <circle cx="12" cy="12" r="8" />
        <circle cx="12" cy="12" r="4.2" />
        <circle cx="12" cy="12" r="1" />
        <path d="M12 1.6v3M12 19.4v3M1.6 12h3M19.4 12h3" />
      </svg>
    )
    // 目标：取景框（四角括号 + 中心方块）
    case '目标': return (
      <svg {...p}>
        <path d="M3 8V4.5A1.5 1.5 0 0 1 4.5 3H8M16 3h3.5A1.5 1.5 0 0 1 21 4.5V8M21 16v3.5a1.5 1.5 0 0 1-1.5 1.5H16M8 21H4.5A1.5 1.5 0 0 1 3 19.5V16" />
        <rect x="9" y="9" width="6" height="6" rx="1" />
      </svg>
    )
    // 区域：六边形 + 中心标记
    case '区域': return (
      <svg {...p}>
        <path d="M12 2.6l8.1 4.7v9.4L12 21.4 3.9 16.7V7.3z" />
        <path d="M12 8.2l1.9 1.1v2.2L12 12.6l-1.9-1.1V9.3z" />
        <path d="M12 12.6v2.6M9.6 13.9l-2.2 1.3M14.4 13.9l2.2 1.3" />
      </svg>
    )
    // 资源：节点图（三节点互连）
    case '资源': return (
      <svg {...p}>
        <circle cx="6" cy="7" r="2.6" />
        <circle cx="17.5" cy="6" r="2.2" />
        <circle cx="12" cy="17.5" r="2.6" />
        <path d="M8.3 8.4l6.5 6.3M15.9 7.9l-2.6 7.2M8.4 7.2l6.8-1" />
      </svg>
    )
    // 告警：铃
    case '告警': return (
      <svg {...p}>
        <path d="M12 3a6 6 0 0 0-6 6c0 4.2-1.4 5.6-1.4 5.6h14.8S18 13.2 18 9a6 6 0 0 0-6-6z" />
        <path d="M10.2 18.4a2 2 0 0 0 3.6 0" />
      </svg>
    )
    // 设置：齿轮
    case '设置': return (
      <svg {...p}>
        <circle cx="12" cy="12" r="3.2" />
        <path d="M19.3 14.4a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.5 1z" />
      </svg>
    )
  }
}

type StatusIconKey = 'shield' | 'warn' | 'link' | 'position' | 'ai'

/** 底部状态条小图标（参考图 6 项的样子；颜色由调用方按状态给） */
function StatusGlyph({ k }: { k: StatusIconKey }) {
  const p = { width: 15, height: 15, viewBox: '0 0 24 24', ...svgBase }
  switch (k) {
    case 'shield': return (
      <svg {...p}><path d="M12 2.8l7 2.6v6c0 4.5-3 7.7-7 9.8-4-2.1-7-5.3-7-9.8v-6z" /><path d="M8.6 12.1l2.3 2.3 4.5-4.6" /></svg>
    )
    case 'warn': return (
      <svg {...p}><path d="M12 3.6L21 19.4H3z" /><path d="M12 9.4v4.4M12 16.6v.1" /></svg>
    )
    case 'link': return (
      <svg {...p}><path d="M7 15.5H6a4 4 0 0 1 0-8h2.2" /><path d="M17 7.5h1a4 4 0 0 1 0 8h-2.2" /><path d="M9.4 11.5h5.2" /></svg>
    )
    case 'position': return (
      <svg {...p}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="2.2" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>
    )
    case 'ai': return (
      <svg {...p}><circle cx="12" cy="6" r="2.6" /><circle cx="6" cy="17" r="2.6" /><circle cx="18" cy="17" r="2.6" /><path d="M10.6 8.2L7.4 14.8M13.4 8.2l3.2 6.6M8.6 17h6.8" /></svg>
    )
  }
}

export function LeftNav({ active, onPick }: { active: NavKey; onPick?: (k: NavKey) => void }) {
  return (
    <nav data-testid="left-nav" style={navStyle}>
      {NAV_ITEMS.map((k) => {
        const on = k === active
        return (
          <button
            key={k}
            data-testid={`nav-${k}`}
            data-nav-active={on ? '1' : '0'}
            title={k}
            onClick={() => onPick?.(k)}
            style={{
              width: 64, padding: '7px 0 6px', borderRadius: 8, cursor: 'pointer',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
              border: `1px solid ${on ? 'rgba(95,176,255,.8)' : 'rgba(95,176,255,.14)'}`,
              background: on ? 'linear-gradient(180deg, rgba(29,78,216,.92), rgba(29,78,216,.42))' : 'rgba(8,24,44,.35)',
              color: on ? '#eaf6ff' : C.textDim, fontSize: 11.5, lineHeight: 1.15, font: 'inherit',
              boxShadow: on ? '0 0 10px rgba(56,189,248,.25)' : undefined,
            }}
          >
            <NavGlyph k={k} />
            <span>{k}</span>
          </button>
        )
      })}
    </nav>
  )
}

/** 底部 6 段全局状态条（图上逐字 6 项；值取宿主，取不到给"—"）。 */
export function BottomStatusBar({ state }: { state: FlowState | null }) {
  return (
    <div data-testid="bottom-status" style={bottomStyle}>
      {STATUS_SLOTS.map((s) => {
        const v = statusSlotValue(state, s)
        const col = statusColor(v.band)
        return (
          <span key={s.key} data-status-key={s.key} style={statusCard}>
            <span style={{ color: col, display: 'inline-flex' }}><StatusGlyph k={s.icon} /></span>
            <span style={{ color: C.textDim, whiteSpace: 'nowrap' }}>{s.name}：</span>
            <span style={{ color: col, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.text}</span>
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
        position: 'absolute', right: 16, bottom: BOTTOM_H + 12, zIndex: 45,
        width: 42, height: 42, borderRadius: '50%', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: `1px solid ${C.borderStrong}`,
        background: open ? 'rgba(56,189,248,.35)' : 'rgba(29,78,216,.55)',
        color: '#eaf6ff',
        boxShadow: '0 0 12px rgba(56,189,248,.35)', fontSize: 18, lineHeight: 1,
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
  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, paddingTop: 8,
  background: 'rgba(5,20,38,.92)', borderRight: `1px solid ${C.border}`,
  overflowY: 'auto',
}
const bottomStyle: CSSProperties = {
  position: 'absolute', left: 0, right: 0, bottom: 0, height: BOTTOM_H, zIndex: 30,
  display: 'flex', gap: 8, alignItems: 'center', padding: '0 10px', flexWrap: 'nowrap',
  background: 'rgba(6, 26, 47, 0.95)', borderTop: `1px solid ${C.border}`,
  fontSize: 12, overflow: 'hidden',
}
const statusCard: CSSProperties = {
  display: 'inline-flex', gap: 6, alignItems: 'center', minWidth: 0,
  padding: '3px 10px', borderRadius: 8,
  border: '1px solid rgba(95,176,255,.16)', background: 'rgba(10,32,58,.55)',
}
