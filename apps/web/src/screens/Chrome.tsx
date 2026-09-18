// mission-app · apps/web/src/screens/Chrome.tsx
//
// 界面外壳：顶部条 + 系统状态卡。**没有业务词**——所有名称/状态文案都来自宿主的负载
// （其源头是规则包），本文件只决定"摆在哪里、用什么颜色"。
//
// ★ 2026-09-17 按用户逐屏确认（第 1 屏）加的两件事：
//   ① 顶栏的 WiFi 改成**真实探测外网**：浏览器发不出 ICMP，所以用 `fetch(百度 favicon,
//      mode:'no-cors')` 当"能不能通"的判据 —— 通则用素材库的 `wifi-on.png`，不通则 `wifi-off.png`
//      （用户原话："能ping就使用wifi有，不能就用wifi无"）。探测是**如实**的：拿不到就显示"不通"。
//   ② 右侧「系统状态」四行加**素材库图标**（按宿主给的 key 认领：network/datalink/gps/security）。
import { useEffect, useState, type CSSProperties } from 'react'
import { C, panel, panelTitle, statusColor } from '../theme'
import type { OverviewItem } from '../api'

export const SYS_NAME = '智能任务管理系统'

/* ---------------------------------------------------------------------------
 * 外网连通性探测（顶栏 WiFi 图标用它）
 * ------------------------------------------------------------------------- */

/** 探测目标：百度 favicon（体积小；`no-cors` 只要网络通就会 resolve） */
const PROBE_URL = 'https://www.baidu.com/favicon.ico'
/** 单次探测超时（毫秒）——超时按"不通"算 */
const PROBE_TIMEOUT_MS = 3500
/** 重探间隔（毫秒） */
const PROBE_EVERY_MS = 15000

export type NetState = 'probing' | 'yes' | 'no'

/** 探测一次：通 = true。浏览器不给 ICMP，所以这是"HTTP 层能不能到"的判据。 */
async function probeOnce(): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false
  const ctl = new AbortController()
  const timer = window.setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS)
  try {
    // `no-cors`：读不到响应体（跨域），只关心"这一次请求有没有失败"
    await fetch(PROBE_URL, { mode: 'no-cors', cache: 'no-store', signal: ctl.signal })
    return true
  } catch {
    return false
  } finally {
    window.clearTimeout(timer)
  }
}

/** 顶栏用：进页面探一次，之后每 15 s 重探；浏览器 on/offline 事件立刻改判。 */
export function useNetReach(): NetState {
  const [net, setNet] = useState<NetState>('probing')
  useEffect(() => {
    let alive = true
    const run = () => { void probeOnce().then((ok) => { if (alive) setNet(ok ? 'yes' : 'no') }) }
    const onOffline = () => setNet('no')
    const onOnline = () => run()
    run()
    const t = window.setInterval(run, PROBE_EVERY_MS)
    window.addEventListener('offline', onOffline)
    window.addEventListener('online', onOnline)
    return () => {
      alive = false
      window.clearInterval(t)
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('online', onOnline)
    }
  }, [])
  return net
}

/* ---------------------------------------------------------------------------
 * 素材库图标（用户提供：`C:\Users\softmonk\Desktop\png库`，已拷进 apps/web/public，
 * 改成 ASCII 文件名以免 URL 里出现中文；对照关系见下）
 * ------------------------------------------------------------------------- */

/** 右侧「系统状态」四行的图标：按**宿主给的 key** 认领（key 取自 /api/state 的 systemOverview） */
const STATUS_ICON: Record<string, string> = {
  network: '/status-network.png',    // ← 网络连接 (1).png
  datalink: '/status-datalink.png',  // ← 数据链接.png
  gps: '/status-position.png',       // ← 定位.png
  security: '/status-security.png',  // ← 安全.png
}

const barStyle: CSSProperties = {
  position: 'absolute', top: 0, left: 0, right: 0, height: 42, zIndex: 30,
  display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px',
  background: 'rgba(6, 26, 47, 0.92)', borderBottom: `1px solid ${C.border}`,
}

/** 顶栏：Logo + 系统名 +（右侧）网络/电量/时间/头像。时间每 30 s 走一格。 */
export function TopBar({ linkOk }: { linkOk: boolean }) {
  const [now, setNow] = useState(() => new Date())
  const net = useNetReach()
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 30000)
    return () => window.clearInterval(t)
  }, [])
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  // 探测中先按"有"显示（避免每次刷新都闪一下），**确认不通**才换成 wifi无
  const wifiOn = net !== 'no'
  const wifiTitle = net === 'probing'
    ? '正在探测外网（https://www.baidu.com）…'
    : net === 'yes' ? '外网连通（探测百度成功）' : '外网不通（探测百度失败）'
  return (
    <div style={barStyle}>
      <img src="/logo.png" alt="" style={{ width: 24, height: 24, objectFit: 'contain' }} />
      <strong style={{ fontSize: 15, letterSpacing: 0.8 }}>{SYS_NAME}</strong>
      <div style={{ flex: 1 }} />
      <span style={{ fontSize: 12, color: linkOk ? C.ok : C.bad }}>
        网络：{linkOk ? '已连接' : '未连接'}
      </span>
      <img
        data-testid="topbar-wifi"
        data-net={net}
        src={wifiOn ? '/wifi-on.png' : '/wifi-off.png'}
        alt={wifiOn ? 'WiFi 有' : 'WiFi 无'}
        title={wifiTitle}
        style={{ width: 22, height: 22, objectFit: 'contain' }}
      />
      <span style={{ fontSize: 12, color: C.textDim }}>100%</span>
      <span style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>{hh}:{mm}</span>
      {/* 用户头像：素材库的 `用户.png`（蓝色人像），放在原来的圆形底上（原先是空圆） */}
      <span
        data-testid="topbar-user"
        title="用户"
        style={{
          width: 22, height: 22, borderRadius: '50%', background: '#1e3a5f',
          border: `1px solid ${C.borderStrong}`,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          overflow: 'hidden', flex: '0 0 auto',
        }}
      >
        <img src="/user.png" alt="用户" style={{ width: 18, height: 18, objectFit: 'contain' }} />
      </span>
    </div>
  )
}

/**
 * 系统状态卡（右侧四项）。
 *
 * 数据来自宿主的 `systemOverview`（`/health` 的同一份负载）：**每一项的文案都是规则包给的**，
 * 未拿到数据时显示"读取中…"，MUST NOT 编一个"正常"上去。
 * 图标取自素材库、按 `it.key` 认领；**认不到就保留原来的空方块**（不硬套一个图标上去）。
 */
export function StatusPanel({ items, title = '系统状态', loading }: {
  items?: OverviewItem[]
  title?: string
  loading?: boolean
}) {
  return (
    <div style={{ ...panel, width: 210, flex: '0 0 auto' }}>
      <div style={panelTitle}>{title}</div>
      <div style={{ padding: '4px 0 8px' }}>
        {(items ?? []).map((it) => {
          const icon = STATUS_ICON[it.key]
          return (
            <div key={it.key} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '12px 14px', borderBottom: `1px solid rgba(95,176,255,.12)`,
            }}>
              {icon
                ? <img src={icon} alt="" style={{ width: 26, height: 26, flex: '0 0 auto', objectFit: 'contain' }} />
                : <span style={{
                  width: 26, height: 26, borderRadius: 6, flex: '0 0 auto',
                  border: `1px solid ${C.border}`, background: 'rgba(95,176,255,.08)',
                }} />}
              <span style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, color: C.text }}>{it.name}</div>
                <div style={{ fontSize: 12, color: statusColor(it.status) }}>{it.text || it.status}</div>
              </span>
            </div>
          )
        })}
        {!items?.length && (
          <div style={{ padding: '14px', fontSize: 12, color: C.textDim }}>
            {loading ? '读取中…' : '（宿主未给出系统状态）'}
          </div>
        )}
      </div>
    </div>
  )
}

/** 进度条：`percent` 由调用方给（**来自宿主的真实取值**，本组件不猜）。 */
export function ProgressBar({ percent, width = '100%', height = 8, showText = true }: {
  percent: number
  width?: number | string
  height?: number
  showText?: boolean
}) {
  const p = Math.max(0, Math.min(100, Math.round(percent)))
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, width }}>
      <span style={{
        flex: 1, height, borderRadius: height, background: 'rgba(95,176,255,.16)',
        overflow: 'hidden', display: 'inline-block',
      }}>
        <span style={{
          display: 'block', height: '100%', width: `${p}%`,
          background: C.bar, transition: 'width .25s linear',
        }} />
      </span>
      {showText && (
        <span style={{ fontSize: 12, color: C.text, fontVariantNumeric: 'tabular-nums', minWidth: 34, textAlign: 'right' }}>
          {p}%
        </span>
      )}
    </span>
  )
}

/**
 * 底部提示条的高度。
 *
 * ★ 2026-09-17 用户逐屏确认第 1 屏：那条「系统启动中，正在初始化核心模块…」**太矮了，要变高**。
 * 由 34 → 48。**启动页与自检页共用这一条**（`HintBar` 是同一个组件），所以两屏一起变高；
 * 两屏的内容区各自留的 `bottom: 34` 也要跟着用这个常量，否则内容会被提示条压住。
 */
export const HINT_BAR_H = 48

/** 底部提示条（启动/自检界面共用）。 */
export function HintBar({ text }: { text: string }) {
  return (
    <div style={{
      position: 'absolute', left: 0, right: 0, bottom: 0, height: HINT_BAR_H, zIndex: 20,
      display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px',
      background: 'rgba(6, 26, 47, 0.92)', borderTop: `1px solid ${C.border}`,
      fontSize: 12, color: C.textDim,
    }}>
      <span style={{
        width: 14, height: 14, borderRadius: '50%', border: `1px solid ${C.borderStrong}`,
        display: 'inline-block', textAlign: 'center', lineHeight: '12px', fontSize: 10,
      }}>i</span>
      {text}
    </div>
  )
}
