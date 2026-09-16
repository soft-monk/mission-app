// mission-app · apps/web/src/flow/useFlow.ts
//
// 流程状态钩子：把"宿主状态"与"WS 事件"合成一份前端状态。
//
// 两条来源，各有分工：
//   · **轮询 `/api/state`**（默认 500 ms）——兜底与首帧。断线、丢事件、页面刷新都能自愈；
//   · **WS 事件**——低延迟。`selfcheck.progress` 一到达就把启动进度条推进到最新值
//     （不必等下一次轮询），`flow.state` 到达即切屏。
//
// ★ 纪律：这里**不合成**任何进度值。事件带什么就显示什么；事件缺字段时等下一次轮询。
import { useCallback, useEffect, useRef, useState } from 'react'
import { command, fetchState, type CommandReply, type FlowState } from '../api'
import { createChannel, type Channel, type Envelope } from 'ws-client'

export interface UseFlow {
  state: FlowState | null
  error: string | null
  /** 发一条命令；成功（code=0）时立刻刷新一次状态 */
  send: <T = unknown>(verb: string, params?: Record<string, unknown>) => Promise<CommandReply<T>>
  /** 最近一次命令回执（界面用来显示"为什么没动"） */
  lastReply: CommandReply | null
  /**
   * 按 verb 留存的最近一次回执。
   *
   * 用途：各屏要显示"这条 verb 到底成没成、宿主给了什么"，而**只有一条** `lastReply` 会被
   * 别的动作覆盖（比如"进入编组"发完 `flow.state` 就把 `alloc.plans` 的回执挤掉了）。
   * 保留最近一次 = 界面回执不会因为无关命令而闪没。
   */
  replies: Record<string, CommandReply>
  refresh: () => void
}

const POLL_MS = 500

export function useFlow(wsUrl: string): UseFlow {
  const [state, setState] = useState<FlowState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastReply, setLastReply] = useState<CommandReply | null>(null)
  const [replies, setReplies] = useState<Record<string, CommandReply>>({})
  const stateRef = useRef<FlowState | null>(null)
  stateRef.current = state

  const pull = useCallback(async () => {
    try {
      const s = await fetchState()
      setState(s)
      setError(null)
    } catch (e) {
      setError(String((e as Error).message ?? e))
    }
  }, [])

  // ---- 轮询（兜底）----
  useEffect(() => {
    let alive = true
    const tick = () => { if (alive) void pull() }
    tick()
    const t = window.setInterval(tick, POLL_MS)
    return () => { alive = false; window.clearInterval(t) }
  }, [pull])

  // ---- WS（低延迟；断线由 ws-client 自己重连）----
  useEffect(() => {
    let channel: Channel | null = null
    try {
      channel = createChannel({
        url: wsUrl,
        autoStart: false,
        onWarn: (m, d) => console.warn(`[ws] ${m}`, d ?? ''),
      })
      // 进度事件：直接把 items 合并进当前状态的 boot 段（不重算整体，尊重宿主的加权口径）
      channel.on('selfcheck.progress', (data: Record<string, unknown>) => {
        const items = Array.isArray(data.items) ? (data.items as { key: string; percent: number }[]) : []
        const overall = typeof data.overall === 'number' ? data.overall : undefined
        setState((prev) => {
          if (!prev) return prev
          const byKey = new Map(items.map((i) => [i.key, i.percent]))
          const modules = (prev.boot.modules ?? []).map((m) => (
            byKey.has(m.key) ? { ...m, percent: byKey.get(m.key) as number } : m
          ))
          return {
            ...prev,
            boot: {
              ...prev.boot,
              overall: overall ?? prev.boot.overall,
              progress: { items, overall: overall ?? prev.boot.progress?.overall ?? 0 },
              modules,
            },
          }
        })
      })
      // 状态类事件：改结构（ready 带终值、done 带结论、flow.state 带步骤）→ 直接拉一次全量
      for (const type of ['selfcheck.ready', 'selfcheck.done', 'flow.state']) {
        channel.on(type, (_data: Record<string, unknown>, env: Envelope) => {
          void env
          void pull()
        })
      }
      channel.onUnknown((env: Envelope) => console.warn(`[ws] 未订阅事件：${env.type}`))
      channel.onError((e) => console.warn(`[ws] ${e.kind}：${e.message}`))
      channel.start()
    } catch (e) {
      console.warn('[ws] 通道建立失败（继续用轮询）', e)
    }
    return () => { try { channel?.close() } catch { /* 关闭是终态，忽略 */ } }
  }, [wsUrl, pull])

  const send = useCallback(async <T,>(verb: string, params: Record<string, unknown> = {}) => {
    const reply = await command<T>(verb, params)
    setLastReply(reply)
    setReplies((prev) => ({ ...prev, [verb]: reply }))
    if (reply.code === 0) void pull()
    return reply
  }, [pull])

  return { state, error, send, lastReply, replies, refresh: () => void pull() }
}
