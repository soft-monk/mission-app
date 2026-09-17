// mission-app · apps/web/src/shell/Diag.tsx
//
// **数据来源 / 诊断折叠块**。
//
// ★ 为什么要有它（用户反馈"最基础的排版，为什么排版很奇怪"）：
//   工程纪律要求"屏上每个数字都要能在 verb 回执里找到来源；拿不到就显示『—』+ 写明原因"
//   （需求专篇 G-09）。上一版把这些**出处与缺失原因**直接平铺在右栏正文里，于是产品界面上
//   出现了大量 `来源：（situation.snapshot）`、`快照未提供 analysis 段（…前端不写死）`、
//   `四型数量/在线率 ← alloc.inventory` 之类的句子 —— 排版因此显得很"工程味"。
//   这里把它们收进一个**默认折叠**的小块：产品界面保持干净，但每一条出处**仍在 DOM 里**、
//   点一下就能看到（既不丢可追溯性，也不丢验收脚本能读到的文本）。
import { type CSSProperties, type ReactNode } from 'react'
import { C } from '../theme'

export function DiagBox({ title = '数据来源与诊断', children, testid, defaultOpen = false, style }: {
  title?: string
  children: ReactNode
  testid?: string
  defaultOpen?: boolean
  style?: CSSProperties
}) {
  return (
    <details
      data-testid={testid ?? 'diag-box'}
      open={defaultOpen}
      style={{ ...boxStyle, ...style }}
    >
      <summary style={summaryStyle}>
        <span style={{ color: C.textDim }}>ⓘ {title}</span>
        <span style={{ color: C.unknown, fontSize: 10.5 }}>（点开看每条数值的出处与缺失原因）</span>
      </summary>
      <div style={bodyStyle}>{children}</div>
    </details>
  )
}

/** 一行诊断：左"名"，右"出处/原因"。 */
export function DiagLine({ k, v, warn }: { k: string; v: ReactNode; warn?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '1px 0' }}>
      <span style={{ color: C.textDim, flex: '0 0 auto' }}>{k}</span>
      <span style={{ color: warn ? C.warn : C.unknown, minWidth: 0, wordBreak: 'break-word' }}>{v}</span>
    </div>
  )
}

const boxStyle: CSSProperties = {
  border: `1px solid ${C.border}`, borderRadius: 8,
  background: 'rgba(10,32,58,.42)', fontSize: 11, lineHeight: 1.65,
}
const summaryStyle: CSSProperties = {
  cursor: 'pointer', padding: '5px 10px', display: 'flex', gap: 6, alignItems: 'baseline',
  listStyle: 'none', userSelect: 'none',
}
const bodyStyle: CSSProperties = {
  padding: '2px 10px 8px', borderTop: `1px solid ${C.border}`, color: C.textDim,
}
