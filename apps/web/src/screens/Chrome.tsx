// mission-app · apps/web/src/screens/Chrome.tsx
//
// 界面外壳：顶部条 + 系统状态卡。**没有业务词**——所有名称/状态文案都来自宿主的负载
// （其源头是规则包），本文件只决定"摆在哪里、用什么颜色"。
import { useEffect, useState, type CSSProperties } from 'react'
import { C, panel, panelTitle, statusColor } from '../theme'
import type { OverviewItem } from '../api'

export const SYS_NAME = '智能任务管理系统'

const barStyle: CSSProperties = {
  position: 'absolute', top: 0, left: 0, right: 0, height: 42, zIndex: 30,
  display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px',
  background: 'rgba(6, 26, 47, 0.92)', borderBottom: `1px solid ${C.border}`,
}

/** 顶栏：Logo + 系统名 +（右侧）网络/电量/时间/头像。时间每 30 s 走一格。 */
export function TopBar({ linkOk }: { linkOk: boolean }) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 30000)
    return () => window.clearInterval(t)
  }, [])
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  return (
    <div style={barStyle}>
      <img src="/logo.png" alt="" style={{ width: 24, height: 24, objectFit: 'contain' }} />
      <strong style={{ fontSize: 15, letterSpacing: 0.8 }}>{SYS_NAME}</strong>
      <div style={{ flex: 1 }} />
      <span style={{ fontSize: 12, color: linkOk ? C.ok : C.bad }}>
        网络：{linkOk ? '已连接' : '未连接'}
      </span>
      <span style={{ fontSize: 12, color: C.textDim }}>WiFi</span>
      <span style={{ fontSize: 12, color: C.textDim }}>100%</span>
      <span style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>{hh}:{mm}</span>
      <span style={{
        width: 22, height: 22, borderRadius: '50%', background: '#1e3a5f',
        border: `1px solid ${C.borderStrong}`, display: 'inline-block',
      }} />
    </div>
  )
}

/**
 * 系统状态卡（右侧四项）。
 *
 * 数据来自宿主的 `systemOverview`（`/health` 的同一份负载）：**每一项的文案都是规则包给的**，
 * 未拿到数据时显示"读取中…"，MUST NOT 编一个"正常"上去。
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
        {(items ?? []).map((it) => (
          <div key={it.key} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '12px 14px', borderBottom: `1px solid rgba(95,176,255,.12)`,
          }}>
            <span style={{
              width: 26, height: 26, borderRadius: 6, flex: '0 0 auto',
              border: `1px solid ${C.border}`, background: 'rgba(95,176,255,.08)',
            }} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, color: C.text }}>{it.name}</div>
              <div style={{ fontSize: 12, color: statusColor(it.status) }}>{it.text || it.status}</div>
            </span>
          </div>
        ))}
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

/** 底部提示条（启动/自检界面共用）。 */
export function HintBar({ text }: { text: string }) {
  return (
    <div style={{
      position: 'absolute', left: 0, right: 0, bottom: 0, height: 34, zIndex: 20,
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
