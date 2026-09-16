// mission-app · apps/web/src/theme.ts
//
// 视觉令牌：**只放颜色与字号**，不放任何业务取值。
// 取值对齐参考图（深蓝指挥风格）：底色 #04182f、面板 rgba(10,32,58,.72)、
// 描边 rgba(95,176,255,.25)、强调 #5fb0ff；状态色只表达"好/中/坏/未知"四种，
// 具体哪个业务项算什么状态由**宿主的负载**决定（本文件不认识 business 词）。
import type { CSSProperties } from 'react'

export const C = {
  bg: '#04182f',
  bg2: '#061c33',
  panel: 'rgba(10, 32, 58, 0.72)',
  panelSolid: '#0a2039',
  border: 'rgba(95, 176, 255, 0.25)',
  borderStrong: 'rgba(95, 176, 255, 0.45)',
  accent: '#5fb0ff',
  accentDim: '#8fb0cc',
  text: '#cfe3f5',
  textDim: '#8fb0cc',
  ok: '#22c55e',
  warn: '#f59e0b',
  bad: '#ef4444',
  unknown: '#64748b',
  /**
   * 「已失效 / 已清除」的中性色（步 10 目标命中变灰、步 11 毁伤评估同一口径）。
   *
   * 为什么不叫 gray/disabled：**这个色的含义由引擎给的状态决定**（`target.state` 的
   * `status=gray` / `dynamicState=destroyed`），不是在说"这个控件不能点"。规则包给别的
   * 状态名时，取值仍然走 `statusColor()`，本令牌只负责"失效"这一档。
   */
  muted: '#8b93a7',
  bar: 'linear-gradient(90deg, #1d4ed8 0%, #38bdf8 100%)',
} as const

export const panel: CSSProperties = {
  background: C.panel,
  border: `1px solid ${C.border}`,
  borderRadius: 10,
  // 刻意**不用** backdrop-filter：headless（无 GPU）下它会导致整块面板不参与合成，
  // 截图里表现为"面板消失"，而且真实设备上它也是可观的绘制开销。要毛玻璃就交给底图那张图。
}

export const panelTitle: CSSProperties = {
  padding: '9px 14px',
  borderBottom: `1px solid ${C.border}`,
  color: C.text,
  fontSize: 13.5,
  letterSpacing: 0.5,
}

/** 状态色：`status` 文案由规则包给出（normal/abnormal/online/stable/…），这里只做**颜色归类**。 */
export function statusColor(status?: string): string {
  const s = (status ?? '').toLowerCase()
  if (['ok', 'normal', 'online', 'stable', 'safe', 'ready', 'fixed', 'pass', 'green'].includes(s)) return C.ok
  if (['degraded', 'unstable', 'warn', 'partial', 'attention', 'yellow'].includes(s)) return C.warn
  if (['fail', 'abnormal', 'offline', 'broken', 'risk', 'lost', 'fault', 'red'].includes(s)) return C.bad
  // 规则包 `threatFactors.json` 的 `bands[].state` 取值域就是 red/yellow/gray；
  // gray = 该档威胁等级判为"已失效"，用中性令牌（不是"未知"）。
  if (['gray', 'grey', 'muted', 'inactive', 'cleared', 'destroyed', 'struck'].includes(s)) return C.muted
  return C.unknown
}

/** 等级（ok/unconfigured/degraded/fail）→ 颜色；未配置按"中性"处理（规则包也是这个口径）。 */
export function levelColor(level?: string): string {
  switch ((level ?? '').toLowerCase()) {
    case 'ok': return C.ok
    case 'unconfigured': return C.accent
    case 'degraded': return C.warn
    case 'fail': return C.bad
    default: return C.unknown
  }
}

/** 整体 status → 一句人话（用于顶部/大标题；取值不认识就原样显示，不编）。 */
export function statusText(status?: string): string {
  switch ((status ?? '').toLowerCase()) {
    case 'ok': return '正常'
    case 'degraded': return '降级'
    case 'fail': return '异常'
    case 'unknown': return '未知'
    default: return status ?? '未知'
  }
}
