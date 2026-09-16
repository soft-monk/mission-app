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

/**
 * 事件面留存的**最近一份**负载（`{ts, data}`）。
 *
 * 为什么需要它：步 6–7 有两个数据源**只走事件不走 verb**——
 * `sim.state`（仿真在不在跑、倍速多少）与 `media.channels`（视频/SAR 通道清单）。
 * 轮询 `/api/state` 拿不到它们，所以这里按事件名留一份最新值给界面读。
 * **原样保留宿主负载**（不改字段、不合成值）。
 */
export interface EventSlot {
  /** 宿主信封里的 `ts`（服务端时钟） */
  ts: number
  data: Record<string, unknown>
}

export interface UseFlow {
  state: FlowState | null
  error: string | null
  /** 发一条命令；成功（code=0）时立刻刷新一次状态 */
  send: <T = unknown>(verb: string, params?: Record<string, unknown>) => Promise<CommandReply<T>>
  /** 最近一次命令回执（界面用来显示"为什么没动"） */
  lastReply: CommandReply | null
  /** 按事件名留存的最近一份负载（`sim.state` / `media.channels` / `entity.changed`…） */
  events: Record<string, EventSlot>
  /** 事件通道的累计计数（排障用；`channel.stats` 原样） */
  wsStats: { received: number; unknown: number; malformed: number } | null
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

/**
 * 本页面**订阅**的事件名（步 3–7 用到的）。
 *
 * 纪律：只订阅要用的事件；没订阅的事件仍会走 `onUnknown`（打日志，不静默丢）。
 * 留一份最新值给界面即可——这几个事件都是"状态快照"语义（`sim.state` / `media.channels`），
 * 不需要队列；真正的台账类数据仍由各屏自己发 verb 取（单一权威来源）。
 */
const EVENT_TOPICS = [
  'sim.state',
  'media.channels',
  'topology.changed',
  'entity.changed',
  'target.state',
] as const

/** `wsStats` 的轮询间隔（排障计数不必跟事件同频） */
const STATS_POLL_MS = 1000

export function useFlow(wsUrl: string): UseFlow {
  const [state, setState] = useState<FlowState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastReply, setLastReply] = useState<CommandReply | null>(null)
  const [replies, setReplies] = useState<Record<string, CommandReply>>({})
  const [events, setEvents] = useState<Record<string, EventSlot>>({})
  const [wsStats, setWsStats] = useState<UseFlow['wsStats']>(null)
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
    let statsTimer: number | null = null
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
      // 只走事件的数据源（`sim.state` / `media.channels`）：留最近一份给界面读，**原样不改**
      for (const type of EVENT_TOPICS) {
        channel.on(type, (data: Record<string, unknown>, env: Envelope) => {
          const slot: EventSlot = { ts: typeof env?.ts === 'number' ? env.ts : Date.now(), data }
          setEvents((prev) => ({ ...prev, [type]: slot }))
        })
      }
      channel.onUnknown((env: Envelope) => console.warn(`[ws] 未订阅事件：${env.type}`))
      channel.onError((e) => console.warn(`[ws] ${e.kind}：${e.message}`))
      channel.start()
      // 排障计数（received/unknown/malformed）：1 s 采一次，不参与渲染逻辑
      statsTimer = window.setInterval(() => {
        const s = channel?.stats
        if (s) setWsStats({ received: s.received, unknown: s.unknown, malformed: s.malformed })
      }, STATS_POLL_MS)
    } catch (e) {
      console.warn('[ws] 通道建立失败（继续用轮询）', e)
    }
    return () => {
      if (statsTimer !== null) window.clearInterval(statsTimer)
      try { channel?.close() } catch { /* 关闭是终态，忽略 */ }
    }
  }, [wsUrl, pull])

  const send = useCallback(async <T,>(verb: string, params: Record<string, unknown> = {}) => {
    const reply = await command<T>(verb, params)
    setLastReply(reply)
    setReplies((prev) => ({ ...prev, [verb]: reply }))
    if (reply.code === 0) void pull()
    return reply
  }, [pull])

  return { state, error, send, lastReply, replies, events, wsStats, refresh: () => void pull() }
}
