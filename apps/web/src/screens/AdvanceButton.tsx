// mission-app · apps/web/src/screens/AdvanceButton.tsx
//
// 「进入下一步」的共用控件 —— 六处"下一步"按钮用的都是它。
//
// ★ 口径（这块最容易做错，所以只写一遍）：
//   ① **阶段推进走引擎的 Gate**：界面只发 `mission.advance {to:"T?"}`，由宿主把阶段映射成
//      步号（T1→4 / T2→6 / T4→7 / T5→8 / T6→10 / T7→11）。前端 MUST NOT 自己改 step。
//   ② **Gate 是引擎的规则**：被挡下时**原样照抄**它的 `unmet` / `skippedGates` / `status`，
//      不美化、不吞掉。
//   ③ 被挡下时给一个**显式**的「强制推进（force）」入口：越过 Gate 是操作员的决定，
//      不是界面的默认行为 —— 所以它只在失败之后出现，且回执照旧留在界面上。
import { useState, type CSSProperties } from 'react'
import { C } from '../theme'
import type { CommandReply } from '../api'
import type { UseFlow } from '../flow/useFlow'

/** 回执里的 `unmet` / `skippedGates` 形状不稳定（引擎原样负载），这里只做安全取值。 */
function gateText(data: unknown): string {
  if (!data || typeof data !== 'object') return ''
  const d = data as Record<string, unknown>
  const unmet = Array.isArray(d.unmet) ? d.unmet.map(String) : []
  const skipped = Array.isArray(d.skippedGates) ? d.skippedGates.map(String) : []
  const parts: string[] = []
  if (unmet.length) parts.push(`未满足：${unmet.join(' / ')}`)
  if (skipped.length) parts.push(`跳过的门禁：${skipped.join(' / ')}`)
  if (typeof d.status === 'string' && d.status) parts.push(`status=${d.status}`)
  return parts.join('；')
}

export function AdvanceButton({ flow, to, via, label, disabled, style, align = 'flex-end', testId }: {
  flow: UseFlow
  /** 目标阶段（T0..T7，取值由 phase-engine 的规则包定义） */
  to: string
  /**
   * 要依次发的阶段链（默认 `[to]`）。**为什么要链**：阶段图是按"相邻边"走的
   * （T2 的 next 只有 T3），直接跳 T4 会被引擎回 `1000/1003`；所以步 6 → 步 7 这种
   * "跨一个中间阶段"的推进，界面上按 `["T3","T4"]` 依次发两条 —— 与规则包里的图一致。
   */
  via?: string[]
  /** 按钮文字（逐屏自己写，例如「进入任务执行 ≫」） */
  label: string
  disabled?: boolean
  style?: CSSProperties
  align?: 'flex-end' | 'flex-start'
  /** 覆盖按钮的 `data-testid`（沿用旧名字，界面级自证脚本的选择器就不会因为换实现而失效） */
  testId?: string
}) {
  const [busy, setBusy] = useState(false)
  const [reply, setReply] = useState<CommandReply | null>(null)
  const [failedAt, setFailedAt] = useState<string | null>(null)
  const chain = via && via.length ? via : [to]

  const run = async (phase: string, force: boolean) => {
    if (busy) return
    setBusy(true)
    try {
      setReply(await flow.send('mission.advance', force ? { to: phase, force: true } : { to: phase }))
    } finally {
      setBusy(false)
    }
  }

  /** 依次走链：某一段失败就停在那儿（不偷偷跳过），失败的那一段就是 force 的对象。 */
  const runChain = async () => {
    if (busy) return
    setBusy(true)
    setFailedAt(null)
    try {
      for (const phase of chain) {
        const r = await flow.send('mission.advance', { to: phase })
        setReply(r)
        if (r.code !== 0) { setFailedAt(phase); return }
      }
    } finally {
      setBusy(false)
    }
  }

  const failed = !!reply && reply.code !== 0
  const ok = !!reply && reply.code === 0
  const d = (reply?.data ?? {}) as Record<string, unknown>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: align }}>
      <button
        data-testid={testId ?? `btn-advance-${to.toLowerCase()}`}
        style={style}
        disabled={disabled || busy}
        onClick={() => void runChain()}
      >
        {busy ? '推进中…' : label}
      </button>

      {ok && !failedAt && (
        <div data-testid="advance-ok" style={{ fontSize: 11.5, color: C.ok, textAlign: align === 'flex-end' ? 'right' : 'left' }}>
          mission.advance → code=0 · 步 {String(d.step ?? '—')} · 阶段 {String(d.phase ?? to)}
          {d.simNote ? ` · ${String(d.simNote)}` : ''}
        </div>
      )}

      {failed && (
        <div data-testid="advance-blocked" style={{
          fontSize: 11.5, color: C.bad, maxWidth: 460,
          textAlign: align === 'flex-end' ? 'right' : 'left', lineHeight: 1.7,
        }}>
          mission.advance&#123;to:"{failedAt ?? to}"&#125; → code={reply!.code}：{reply!.error?.message ?? '（阶段被规则挡下）'}
          {gateText(reply!.data) ? <div>{gateText(reply!.data)}</div> : <div>{gateText(reply!.error)}</div>}
          <button
            data-testid={`btn-advance-force-${to.toLowerCase()}`}
            onClick={() => void run(failedAt ?? to, true)}
            disabled={busy}
            style={{
              marginTop: 6, padding: '4px 10px', fontSize: 11.5, cursor: busy ? 'default' : 'pointer',
              borderRadius: 6, border: `1px solid ${C.borderStrong}`, background: 'rgba(239,68,68,.10)', color: C.text,
            }}
          >
            强制推进（force，越过未满足的阶段门禁）
          </button>
        </div>
      )}
    </div>
  )
}
