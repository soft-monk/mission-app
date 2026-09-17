// mission-app · apps/web/src/shell/VoiceStrip.tsx
//
// **AI 语音交互条**（需求专篇 DES-APP-001 G-08 / SH-04 的「AI语音助手」区 / SH-13 的「AI语音交互」栏）。
//
// 三段式（图上与文字稿一致）：**系统说 → 用户说 → 系统回复**。
//
// ★ 文案从哪来：`config.json` 的 `flow.labels`（键 `voice.<screen>.<part>`），由宿主
//   `/runtime-config` 的 `labels` 透传给前端。**前端一个字都不写死**（沿用 A16 的词汇表纪律：
//   要改台词改配置，重启即可；配置缺这条 → 如实显示"（未配置语音文案）"，不编）。
import { useEffect, useState, type CSSProperties } from 'react'
import { C, panel } from '../theme'

type Labels = Record<string, string>
let cached: Labels | null = null
const waiters: Array<(l: Labels) => void> = []

/** 拉一次 `/runtime-config` 的 `labels`（进程内缓存；失败就当空表，界面如实显示未配置）。 */
export function useLabels(): Labels {
  const [labels, setLabels] = useState<Labels>(cached ?? {})
  useEffect(() => {
    if (cached) return
    let alive = true
    waiters.push((l) => { if (alive) setLabels(l) })
    fetch('/runtime-config')
      .then((r) => r.json())
      .then((j: { labels?: Labels }) => {
        cached = j.labels ?? {}
        for (const w of waiters.splice(0)) w(cached)
      })
      .catch(() => { cached = {}; for (const w of waiters.splice(0)) w({}) })
    return () => { alive = false }
  }, [])
  return labels
}

/** 取一条语音文案：`voice.<screen>.<part>`；缺 → 空串（调用方决定怎么如实标注）。 */
export function voiceLine(labels: Labels, screen: string, part: string): string {
  return labels[`voice.${screen}.${part}`] ?? ''
}

/**
 * 语音条（竖排三段的紧凑形态；SH-13 右栏整栏用）。
 * `parts` 决定显示哪几段（图上 SH-04 是"问句 + 答复标签 + 回答"另一种形态，由屏自己拼）。
 */
export function VoiceStrip({ labels, screen, title = 'AI语音交互', compact = false }: {
  labels: Labels
  /** 屏标识，用于拼 `voice.<screen>.*` 的键（如 `sh13`） */
  screen: string
  title?: string
  compact?: boolean
}) {
  const sys = voiceLine(labels, screen, 'system')
  const usr = voiceLine(labels, screen, 'user')
  const rep = voiceLine(labels, screen, 'reply')
  const missing = !sys && !usr && !rep
  return (
    <div style={{ ...panel, padding: compact ? '8px 10px' : '10px 12px' }} data-testid={`voice-${screen}`}>
      <div style={{ fontSize: 12.5, color: C.text, marginBottom: 6 }}>{title}</div>
      {missing && (
        <div style={{ fontSize: 11.5, color: C.warn, lineHeight: 1.7 }}>
          （未配置语音文案：`config.json` 的 `flow.labels` 里缺 `voice.{screen}.*`）
        </div>
      )}
      {sys && <Row tag="系统说" text={sys} color={C.accent} />}
      {usr && <Row tag="用户说" text={usr} color={C.text} />}
      {rep && <Row tag="系统回复" text={rep} color={C.ok} />}
    </div>
  )
}

function Row({ tag, text, color }: { tag: string; text: string; color: string }) {
  return (
    <div style={{ marginBottom: 6, lineHeight: 1.65 }}>
      <span style={{ fontSize: 11.5, color, marginRight: 6 }}>{tag}：</span>
      <span style={{ fontSize: 11.5, color: C.text }}>{text}</span>
    </div>
  )
}

export const voiceHintStyle: CSSProperties = {
  position: 'absolute', right: 16, bottom: 88, zIndex: 44, width: 320,
}
