// mission-app · apps/web/src/screens/ReconFusionScreen.tsx
//
// **侦察数据融合界面（需求专篇 DES-APP-001 SH-10，参考图 `场景1\T3-2.png`，1536×1024）**。
//
// 版式（**本屏没有地图主体**，App 渲染的 MapStage 会被下面的宫格覆盖）：
//   · 左上：工具栏 5 键「选择 / 标绘 / 测距 / 图层 / 3D · 2D/3D」   · 右上：显示模式「侦察融合」
//   · 中区：**2×3 六路宫格**（每格＝深色卡 + 四角白色直角括号 + 左上同色无人机小图标 + 标题
//            「集群n（机型）」，格内是**媒体通道画面**）
//   · 宫格下方：竖排三字「数据源」+ 4 个小窗（光电 / 雷达 / 电子 / 通用）
//   · 右栏：「集群总体状态」6 条（**本屏没有**【更多详情 >】按钮）
//
// ★ 数据来源与纪律：
//   ① 画面一律来自 `media.channels`（**事件优先**，事件没来退 verb，再退 `/api/state` 的 `media` 段）；
//      通道是宿主扫盘得到的 `image-seq`（帧序列）或 `video`（url）——**用 `<img>` 显示真实帧**，
//      由 media-player 控制器解析帧 URL（`getFrameUrl`，它自己含模板/显式帧/单帧三种来源）。
//      没有通道的格子**画空框并写明原因**，绝不画假画面（沿用 MediaPanel 的纪律）；
//   ② 格子标题用**宿主的集群名**（`situation.snapshot.groups[]`，与 SH-09 同一份读取器）+ 机型；
//      通道与集群是**两套清单**，对应关系只有"名字里含集群名/机型"时才成立 → 这种格子标"匹配"，
//      其余按宿主给的顺序**顺位对应**并明确标出"顺位"（不谎称是集群专属回传）；
//   ③ 集群电量为各架真实 `battery` 的均值；信号强度宿主未给出 → "—" + 原因（与 SH-09 同一口径）；
//   ④ 图上"检测到异常电磁信号聚集区域…"这类 AI 提示**全屏未见**（§6 E-18）→ 不做。
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createMediaController, type MediaChannel, type MediaController } from 'media-player'
import { C, panel, panelTitle } from '../theme'
import type { FlowState } from '../api'
import type { UseFlow } from '../flow/useFlow'
import { isObj, replyText, useVerbOnce } from '../flow/useSituation'
import { readMedia } from '../flow/useOps'
import { ClusterStatusPanel, readClusterStatus, type ClusterRow } from './ReconExpandScreen'

type J = Record<string, unknown>

/** 机型域 → 中文（词典；不认识原样显示）。 */
const TYPE_CN: Record<string, string> = {
  optical: '光电', eo: '光电', photoelectric: '光电', recon: '光电',
  radar: '雷达', sar: '雷达',
  electronic: '电子', ew: '电子', jammer: '电子', jamming: '电子',
  comm: '通信', relay: '通信', communication: '通信',
  reserve: '预备',
}
function typeCN(domain?: string): string | undefined {
  if (!domain) return undefined
  return TYPE_CN[domain.toLowerCase()] ?? domain
}

function strOf(v: unknown, key: string): string | undefined {
  if (!isObj(v)) return undefined
  const x = v[key]
  if (typeof x === 'string' && x) return x
  if (typeof x === 'number') return String(x)
  return undefined
}
function rows(v: unknown, key: string): J[] {
  if (!isObj(v)) return []
  const x = v[key]
  return Array.isArray(x) ? x.filter(isObj) : []
}

// ---------------------------------------------------------------------------
// ① 媒体通道：事件 → verb → /api/state.media（三级来源，逐级如实标注）
// ---------------------------------------------------------------------------

export interface MediaSourceView {
  raw: unknown
  from: 'event' | 'verb' | 'state' | 'none'
  note: string
}

export function useMediaChannels(flow: UseFlow, state: FlowState): MediaSourceView {
  const slot = flow.events['media.channels']
  const verb = useVerbOnce(flow, 'media.channels', {}, true)
  const st = state as unknown as Record<string, unknown>
  return useMemo(() => {
    if (slot?.data) {
      return { raw: slot.data, from: 'event', note: '来源：media.channels 事件（宿主推送）' }
    }
    if (verb.reply?.code === 0 && verb.reply.data) {
      return { raw: verb.reply.data, from: 'verb', note: '来源：media.channels verb（code=0）' }
    }
    if (st.media) {
      return { raw: st.media, from: 'state', note: '来源：/api/state 的 media 段（事件与 verb 都没给）' }
    }
    const why = slot
      ? 'media.channels 事件到达但未带清单'
      : verb.reply
        ? `media.channels verb → ${verb.reply.code === 0 ? 'code=0 但清单为空' : replyText(verb.reply)}`
        : 'media.channels verb 未返回'
    return { raw: null, from: 'none', note: `未拿到通道清单：${why}` }
  }, [slot, verb.reply, st.media])
}

/** 一路通道 → 它属于哪个机型域（用于 4 个数据源小窗；名字里认得出才算）。 */
function kindOf(c: MediaChannel): string | undefined {
  const n = c.name.toLowerCase()
  if (/光电|eo|optical|可见/.test(n)) return 'optical'
  if (/雷达|sar|radar/.test(n)) return 'radar'
  if (/电子|ew|jam|频谱|electronic/.test(n)) return 'electronic'
  if (/通信|relay|comm|数据链/.test(n)) return 'comm'
  return undefined
}

interface CellAssign { channel: MediaChannel | null; matched: boolean; reason?: string }

/**
 * 把通道清单分配到 6 个格子。
 *
 * 规则（**能证实的匹配优先，剩下的按宿主顺序顺位，并如实标注**）：
 *   ① 通道名里含集群名或该集群机型 → 匹配（标"匹配"）；
 *   ② 其余通道按宿主给的顺序填进还没分配的格子 → 标"顺位"（不是集群专属回传）；
 *   ③ 一个都没剩 → 该格写"该集群未接回传通道（media.channels 未给）"。
 */
export function assignChannels(
  clusters: ClusterRow[],
  channels: MediaChannel[],
  from: MediaSourceView['from'],
): { list: CellAssign[]; notes: string[] } {
  const used = new Set<string>()
  const list: CellAssign[] = clusters.map(() => ({ channel: null, matched: false }))

  clusters.forEach((c, i) => {
    const tn = c.typeLabel
    const hit = channels.find((ch) => {
      if (used.has(ch.id)) return false
      const n = ch.name
      if (c.name && n.includes(c.name)) return true
      // 退化到"机型 + 集群序号"（如名字里同时出现"光电"与"1"）
      if (tn && n.includes(tn) && new RegExp(`${i + 1}`).test(n)) return true
      return false
    })
    if (hit) {
      list[i] = { channel: hit, matched: true }
      used.add(hit.id)
    }
  })

  const leftovers = channels.filter((ch) => !used.has(ch.id))
  list.forEach((a, i) => {
    if (a.channel) return
    const nxt = leftovers.shift()
    if (nxt) {
      list[i] = { channel: nxt, matched: false }
      used.add(nxt.id)
    }
  })

  const notes: string[] = []
  if (!channels.length) {
    notes.push(from === 'none'
      ? '宿主未给出任何媒体通道（事件 / verb / /api/state.media 三处都没有）→ 6 格全是空框'
      : '通道清单为空（宿主给出的 channels 为 0 条）→ 6 格全是空框')
  } else {
    const matched = list.filter((a) => a.channel && a.matched).length
    const loose = list.filter((a) => a.channel && !a.matched).length
    notes.push(`宿主给出 ${channels.length} 路通道：${matched} 路按名称匹配到集群，${loose} 路为顺位对应（非集群专属）`)
    if (matched === 0 && loose > 0) {
      notes.push('通道名里没有集群名/机型信息 → 无法证实"某路属于某集群"，格内的集群归属标为"顺位"')
    }
  }
  return { list, notes }
}

// ---------------------------------------------------------------------------
// ② media-player 控制器：真实帧（image-seq 自动轮播 / video 取首帧）
// ---------------------------------------------------------------------------

/**
 * 建一个 media-player 控制器并把宿主清单喂进去。
 *
 * 它负责**解析帧 URL**（`getFrameUrl`：显式 frames / url 模板 / 单帧三种来源同一入口）
 * 与逐路状态；本组件只用这两样渲染 `<img>`。控制器创建失败（浏览器无相关能力）时返回 null，
 * 界面会退到"空框 + 原因"，不会崩。
 */
function useMediaController(raw: unknown): { ctl: MediaController | null; version: number; error: string | null } {
  const [version, setVersion] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const ctl = useMemo<MediaController | null>(() => {
    try {
      return createMediaController({ channels: raw ?? undefined })
    } catch (e) {
      return null
    }
  }, [])
  const key = useMemo(() => {
    try { return JSON.stringify(raw ?? null) } catch { return String(Math.random()) }
  }, [raw])

  useEffect(() => {
    if (!ctl) {
      if (raw) setError('media-player 控制器创建失败（界面退到空框 + 原因）')
      return
    }
    try {
      ctl.setChannels(raw ?? undefined)
      setError(null)
    } catch (e) {
      setError(`媒体清单装载失败：${String((e as Error)?.message ?? e)}`)
    }
    const un = ctl.subscribe(() => setVersion((n) => n + 1))
    const t = window.setInterval(() => setVersion((n) => n + 1), 260)
    return () => { un(); window.clearInterval(t) }
  }, [ctl, key, raw])

  return { ctl, version, error }
}

// ---------------------------------------------------------------------------
// ③ 宫格与数据源小窗
// ---------------------------------------------------------------------------

/** 四角白色直角括号（**取景框样式**，照图；纯装饰）。 */
function CornerBrackets({ color = '#ffffff' }: { color?: string }) {
  const base: CSSProperties = { position: 'absolute', width: 14, height: 14, borderColor: color, borderStyle: 'solid', opacity: 0.9, pointerEvents: 'none' }
  return (
    <>
      <span style={{ ...base, left: 4, top: 4, borderWidth: '2px 0 0 2px' }} />
      <span style={{ ...base, right: 4, top: 4, borderWidth: '2px 2px 0 0' }} />
      <span style={{ ...base, left: 4, bottom: 4, borderWidth: '0 0 2px 2px' }} />
      <span style={{ ...base, right: 4, bottom: 4, borderWidth: '0 2px 2px 0' }} />
    </>
  )
}

/** 四旋翼小图标（示意图形，不是数据）。 */
function DroneGlyph({ color, size = 15 }: { color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ display: 'block' }}>
      <circle cx="12" cy="12" r="2.6" fill={color} />
      <g stroke={color} strokeWidth="1.4" fill="none">
        <line x1="9.6" y1="9.6" x2="5.6" y2="5.6" />
        <line x1="14.4" y1="9.6" x2="18.4" y2="5.6" />
        <line x1="9.6" y1="14.4" x2="5.6" y2="18.4" />
        <line x1="14.4" y1="14.4" x2="18.4" y2="18.4" />
        <circle cx="5.6" cy="5.6" r="2.4" />
        <circle cx="18.4" cy="5.6" r="2.4" />
        <circle cx="5.6" cy="18.4" r="2.4" />
        <circle cx="18.4" cy="18.4" r="2.4" />
      </g>
    </svg>
  )
}

/** 画面：**真实帧**（`<img>`）或空框 + 原因。 */
function MediaFrame({ ctl, channel, color, height, testid }: {
  ctl: MediaController | null
  channel: MediaChannel | null
  color: string
  height: number | 'fill'
  testid: string
}) {
  // 每次 version 变化都重取一次帧 URL（image-seq 用控制器自己的帧下标主动画）
  const frameUrl = ctl && channel ? ctl.getFrameUrl(channel.id) : null
  // 控制器的 `getFrameUrl` **只解析 image-seq**；video 通道退到它的 url/poster 静态首帧
  const url = frameUrl ?? (channel && channel.kind !== 'image-seq' ? (channel.poster ?? channel.url) : null)
  const staticVideo = !frameUrl && !!url
  const st = ctl && channel ? ctl.getStatus(channel.id) : null
  const playing = st ? !['idle', 'paused', 'error'].includes(st.state) : false

  const box: CSSProperties = height === 'fill'
    ? { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, background: '#040f1d' }
    : { position: 'relative', height, background: '#040f1d' }

  return (
    <div data-testid={testid} data-media-channel={channel?.id ?? ''} data-playing={playing ? '1' : '0'} style={box}>
      {channel && url ? (
        <img
          src={url}
          alt={`${channel.name} 回传画面`}
          data-testid={`${testid}-img`}
          data-static-frame={staticVideo ? '1' : '0'}
          style={height === 'fill'
            ? { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, width: '100%', height: '100%', objectFit: 'cover' }
            : { display: 'block', width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        <div
          data-testid={`${testid}-empty`}
          style={{
            position: 'absolute', left: 4, right: 4, top: 4, bottom: 4,
            display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center',
            border: `1px dashed ${C.border}`, borderRadius: 6, padding: '4px 8px',
            fontSize: 10.5, lineHeight: 1.6, color: C.warn,
          }}
        >
          {channel
            ? `通道 ${channel.name} 无可用帧：${st?.reason ?? channel.unavailableReason ?? '宿主未给帧 URL / 帧序列为空'}`
            : '该集群未接回传通道（media.channels 未给）'}
        </div>
      )}
      {/* 同色细边框（照图：格边框与该集群同色） */}
      <span style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, border: `1px solid ${color}`, opacity: 0.55, pointerEvents: 'none' }} />
      {channel && (
        <span style={{ position: 'absolute', left: 6, bottom: 4, fontSize: 9.5, color: '#dbeafe', background: 'rgba(3,12,24,.72)', borderRadius: 4, padding: '0 4px' }}>
          {channel.name} · {channel.kind}{channel.kind === 'image-seq' ? ` · ${channel.frameCount} 帧` : ''}
          {staticVideo ? ' · 静态首帧' : (ctl && channel ? (playing ? ' · 播放中' : ' · 静止') : ' · 无控制器')}
        </span>
      )}
    </div>
  )
}

/** 6 路宫格的一格（深色卡 + 四角括号 + 左上同色小图标 + 标题 + 画面）。 */
function FusionCell({ index, cluster, assign, ctl, from }: {
  index: number
  cluster: ClusterRow
  assign: CellAssign
  ctl: MediaController | null
  from: MediaSourceView['from']
}) {
  const color = cluster.color
  const typeLabel = cluster.typeLabel
  const [playing, setPlaying] = useState(false)

  const toggle = () => {
    const ch = assign.channel
    if (!ctl || !ch) return
    try {
      if (playing) ctl.pause(ch.id)
      else ctl.play(ch.id)
      setPlaying(!playing)
    } catch { /* 控制器拒绝（通道不可用）时保持静止——界面照样显示真实帧 */ }
  }

  return (
    <div
      data-testid={`sh10-cell-cluster${index + 1}`}
      data-cluster={cluster.name}
      data-channel-id={assign.channel?.id ?? ''}
      data-channel-match={assign.channel ? (assign.matched ? 'matched' : 'order') : 'none'}
      style={{ position: 'relative', background: 'rgba(6,20,38,.92)', borderRadius: 6, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}
    >
      {/* 标题行：左上角同色无人机小图标 + 「集群n（机型）」 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderBottom: '1px solid rgba(95,176,255,.18)', flex: '0 0 auto' }}>
        <DroneGlyph color={color} />
        <span style={{ fontSize: 12, color: C.text }}>
          {cluster.name}
          <span style={{ color: C.textDim }}>（{typeLabel ?? '机型未给'}）</span>
        </span>
        <span style={{ flex: 1 }} />
        <button
          data-testid={`sh10-cell-play-${index + 1}`}
          onClick={toggle}
          disabled={!assign.channel || !ctl}
          title={assign.channel ? '播放 / 暂停该通道（真实帧序列）' : '该格没有回传通道'}
          style={{
            fontSize: 10.5, padding: '1px 7px', borderRadius: 5, cursor: assign.channel ? 'pointer' : 'not-allowed',
            background: 'rgba(10,20,36,.7)', border: `1px solid ${C.border}`, color: assign.channel ? C.text : C.unknown,
          }}
        >{playing ? '暂停' : '播放'}</button>
      </div>

      {/* 画面（真实帧 / 空框 + 原因） */}
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <MediaFrame ctl={ctl} channel={assign.channel} color={color} height="fill" testid={`sh10-cell-frame-${index + 1}`} />
        <CornerBrackets />
      </div>

      {/* 归属说明（**不谎称**通道就是该集群的专属回传） */}
      <div style={{ flex: '0 0 auto', padding: '3px 8px 4px', fontSize: 9.5, color: C.textDim, lineHeight: 1.4 }}>
        {assign.channel
          ? (assign.matched
            ? '通道归属：按名称匹配到本集群'
            : `通道归属：顺位对应（${from === 'event' ? '事件' : from === 'verb' ? 'verb' : from === 'state' ? '/api/state.media' : '无来源'}给出的顺序；通道名未含集群信息，无法证实专属）`)
          : '该集群未接回传通道（media.channels 未给）'}
      </div>
    </div>
  )
}

/** 「数据源」竖排三字 + 4 个小窗（光电 / 雷达 / 电子 / 通用）。 */
function DataSourceStrip({ ctl, channels, from }: {
  ctl: MediaController | null
  channels: MediaChannel[]
  from: MediaSourceView['from']
}) {
  /**
   * 小窗取值：名字里认得出机型的通道优先；「通用」取**没被其它小窗认领**的第一路。
   * 认领不到就返回 null → 小窗画空框并写明"未给"（绝不拿别的通道冒充）。
   */
  const used = new Set<string>()
  const take = (want: string): MediaChannel | null => {
    const unclaimed = (c: MediaChannel) => !used.has(c.id)
    let hit: MediaChannel | undefined
    if (want === 'any') {
      hit = channels.find((c) => unclaimed(c) && !kindOf(c)) ?? channels.find(unclaimed)
    } else {
      hit = channels.find((c) => unclaimed(c) && kindOf(c) === want)
    }
    if (hit) used.add(hit.id)
    return hit ?? null
  }
  const wins: { key: string; label: string; want: string; color: string; ch: MediaChannel | null }[] = [
    { key: 'optical', label: '光电', want: 'optical', color: '#5fb0ff' },
    { key: 'radar', label: '雷达', want: 'radar', color: '#38bdf8' },
    { key: 'electronic', label: '电子', want: 'electronic', color: '#a855f7' },
    { key: 'generic', label: '通用', want: 'any', color: '#22d3ee' },
  ].map((w) => ({ ...w, ch: take(w.want) }))
  return (
    <div data-testid="sh10-datasource" style={{ display: 'flex', gap: 8, minHeight: 0, flex: '0 0 auto', height: 158 }}>
      {/* 竖排三字「数据源」 */}
      <div style={{ flex: '0 0 26px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, fontSize: 12.5, color: C.textDim, letterSpacing: 1 }}>
        <span>数</span><span>据</span><span>源</span>
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
        {wins.map((w) => {
          const ch = w.ch
          return (
            <div key={w.key} data-testid={`sh10-source-${w.key}`} data-channel-id={ch?.id ?? ''} style={{ position: 'relative', minWidth: 0, display: 'flex', flexDirection: 'column', background: 'rgba(6,20,38,.92)', border: `1px solid ${C.border}`, borderRadius: 6, overflow: 'hidden' }}>
              <div style={{ padding: '3px 8px', fontSize: 11.5, color: C.text, borderBottom: '1px solid rgba(95,176,255,.18)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: w.color }} />
                {w.label}
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 10, color: C.textDim }}>{ch ? ch.kind : '无来源'}</span>
              </div>
              <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
                {/* 图形提示层：纯示意（极坐标网格 / 频谱框 / 节点连线），**不含任何读数** */}
                <HintArt kind={w.key} color={w.color} />
                <MediaFrame ctl={ctl} channel={ch} color={w.color} height="fill" testid={`sh10-source-frame-${w.key}`} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 4 个小窗的**示意图形**（照图的形态：极坐标扇区 / 频谱曲线 / 节点网络）。
 *  ⚠ 它们是 UI 示意装饰，**不承载任何数值**；真实画面来自上面的 `<img>`。 */
function HintArt({ kind, color }: { kind: string; color: string }) {
  return (
    <svg viewBox="0 0 100 60" preserveAspectRatio="none" aria-hidden="true" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, width: '100%', height: '100%', opacity: 0.5 }}>
      {kind === 'radar' && (
        <g stroke={color} fill="none" strokeWidth="0.6" opacity="0.75">
          <circle cx="50" cy="30" r="8" /><circle cx="50" cy="30" r="16" /><circle cx="50" cy="30" r="24" />
          <line x1="50" y1="30" x2="50" y2="4" /><line x1="50" y1="30" x2="76" y2="30" />
          <line x1="50" y1="30" x2="50" y2="56" /><line x1="50" y1="30" x2="24" y2="30" />
          <path d="M50 30 L50 6 A24 24 0 0 1 72 22 Z" fill={color} fillOpacity="0.35" stroke="none" />
        </g>
      )}
      {kind === 'electronic' && (
        <g stroke={color} fill="none" strokeWidth="0.8">
          <polyline points="2,50 12,49 18,20 24,52 30,44 36,12 42,54 48,46 54,26 60,50 66,40 72,16 78,52 84,45 90,30 98,49" />
        </g>
      )}
      {kind === 'generic' && (
        <g stroke={color} fill={color} strokeWidth="0.7" opacity="0.85">
          <line x1="18" y1="16" x2="50" y2="30" /><line x1="50" y1="30" x2="82" y2="14" />
          <line x1="50" y1="30" x2="30" y2="50" /><line x1="50" y1="30" x2="74" y2="48" />
          <circle cx="18" cy="16" r="2.4" /><circle cx="50" cy="30" r="3" /><circle cx="82" cy="14" r="2.4" />
          <circle cx="30" cy="50" r="2.4" /><circle cx="74" cy="48" r="2.4" />
        </g>
      )}
      {kind === 'optical' && (
        <g stroke={color} fill="none" strokeWidth="0.6" opacity="0.5">
          <rect x="6" y="8" width="88" height="44" rx="3" strokeDasharray="3 3" />
        </g>
      )}
    </svg>
  )
}

// ---------------------------------------------------------------------------
// ④ 屏
// ---------------------------------------------------------------------------

export function ReconFusionScreen({ state, flow, onGo, goto }: {
  state: FlowState
  flow: UseFlow
  onGo?: (id: string) => void
  goto?: (step: number) => void
}) {
  const snap = useVerbOnce(flow, 'situation.snapshot', {}, true)
  const compose = useVerbOnce(flow, 'view.compose', { phase: state.phase || 'T4' }, true)
  const clusters = useMemo(() => readClusterStatus(snap.data), [snap.data])
  const media = useMediaChannels(flow, state)
  const mv = useMemo(() => readMedia(media.raw, media.from === 'none' ? 'none' : media.from === 'state' ? 'verb' : media.from), [media.raw, media.from])
  const { ctl, version, error } = useMediaController(media.raw)

  /**
   * 用的通道清单：**控制器归一化后的清单优先**（它保留了真实帧与可用性）；
   * 控制器建不起来时退到"从宿主原文直读的通道"（同样保留 frames/url → 仍能显示真实帧）；
   * 再不行才用 `readMedia` 的行（只有名字与原因，画面必然空框——那时备注里会写明）。
   */
  const fallback = useMemo(() => nativeChannels(media.raw), [media.raw])
  const channels = useMemo(() => {
    if (ctl) {
      try {
        const c = ctl.getChannels()
        if (c.length) return c
      } catch { /* 控制器读不出来就退到 fallback */ }
    }
    return fallback.length ? fallback : mv.channels.map(toChannelLike)
  }, [ctl, version, fallback, mv.channels])
  const assign = useMemo(() => assignChannels(clusters.rows, channels, media.from), [clusters.rows, channels, media.from])

  // 工具条（`view.compose` 说了算；未实现者灰置 + title 写原因）—— 图上 5 键
  const tools = useMemo(() => {
    const src = isObj(compose.data) ? compose.data : undefined
    const views = rows(src, 'views')
    const t = views.length ? rows(views[0], 'tools') : []
    return t.map((x) => ({
      key: strOf(x, 'key') ?? strOf(x, 'id') ?? '',
      on: isObj(x) && typeof x.enabled === 'boolean' ? x.enabled : true,
      reason: Array.isArray(x.reasons) && typeof x.reasons[0] === 'string' ? x.reasons[0] : strOf(x, 'state'),
    })).filter((x) => x.key)
  }, [compose.data])
  const toolOf = (key: string) => tools.find((t) => t.key === key)
  const toolbar = [
    {
      key: 'select', label: '选择', on: toolOf('select')?.on ?? true,
      hint: (toolOf('select')?.on ?? true) ? undefined : (toolOf('select')?.reason ?? '宿主未声明「选择」可用'),
    },
    { key: 'mark', label: '标绘', hint: toolOf('mark')?.reason ?? '标绘未实现：消费侧 map-2d 未提供该工具' },
    { key: 'measure', label: '测距', hint: toolOf('measure')?.reason ?? '测距未实现：消费侧 map-2d 未提供该工具' },
    { key: 'layer', label: '图层', hint: toolOf('layer')?.reason ?? '图层未实现：图层开关由 view.compose 下发，前端不自行切换' },
    { key: 'mode3d', label: '3D', sub: '2D/3D', on: true },
  ]
  const modeName = useMemo(() => {
    const src = isObj(compose.data) ? compose.data : undefined
    const views = rows(src, 'views')
    return strOf(views[0], 'modeName') ?? strOf(src, 'modeName') ?? '侦察融合'
  }, [compose.data])

  /** SH-10 图上没有按钮：宫格点开放大**图未画 → 不实现**（§3 SH-10）。
   *  `goto` 仍留在契约里；`onGo` 用于**显示模式胶囊**切回"侦察展开"（需求专篇 §4.1 过渡①）。 */
  void goto

  // 6 格：集群清单不足 6 个时，用快照里的占位（名称标"未给"）把图上 6 格补满——**空框 + 原因**
  const slots = useMemo<ClusterRow[]>(() => {
    const base = clusters.rows.slice(0, 6)
    const out = [...base]
    for (let i = base.length; i < 6; i++) {
      out.push({
        key: `slot-${i + 1}`, name: `集群${i + 1}`, nameFallback: true, color: PALETTE[i % PALETTE.length],
      })
    }
    return out
  }, [clusters.rows])

  return (
    <div data-testid="sh-10" data-screen="SH-10" style={wrap}>
      {/* ---------------- 左上：工具栏 5 键（图上逐字） ---------------- */}
      <div data-testid="sh10-toolbar" style={toolbarStyle}>
        {toolbar.map((t) => (
          <button
            key={t.key}
            data-testid={`sh10-tool-${t.key}`}
            data-tool-enabled={t.hint ? '0' : '1'}
            title={t.hint}
            style={{
              ...toolBtn,
              color: t.on ? C.accent : C.unknown,
              borderColor: t.on ? C.borderStrong : 'transparent',
              cursor: t.hint ? 'not-allowed' : 'default',
            }}
          >
            <span style={{ fontSize: 12.5, lineHeight: 1.1 }}>{t.label}</span>
            {t.sub && <span style={{ fontSize: 9.5, color: C.accent }}>{t.sub}</span>}
          </button>
        ))}
      </div>

      {/* ---------------- 右上：显示模式胶囊 ---------------- */}
      <div data-testid="sh10-mode" style={modePill}>
        <span style={{ color: C.textDim }}>显示模式：</span>
        <span style={{ color: C.text }}>{modeName}</span>
        <select
          data-testid="sh10-mode-select"
          aria-label="显示模式"
          value="fusion"
          onChange={(e) => { if (e.target.value === 'expand') onGo?.('SH-09') }}
          style={{
            marginLeft: 6, background: 'rgba(6,26,47,.9)', color: C.text, fontSize: 11.5,
            border: `1px solid ${C.border}`, borderRadius: 6, padding: '2px 4px', cursor: 'pointer',
          }}
        >
          <option value="expand">侦察展开</option>
          <option value="fusion">侦察融合</option>
        </select>
      </div>

      {/* ---------------- 中区：2×3 六路宫格 + 数据源小窗条 ---------------- */}
      <div style={centerStyle}>
        <div data-testid="sh10-grid" style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gridTemplateRows: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
          {slots.map((c, i) => (
            <FusionCell
              key={c.key}
              index={i}
              cluster={c}
              assign={assign.list[i] ?? { channel: null, matched: false }}
              ctl={ctl}
              from={media.from}
            />
          ))}
        </div>

        <DataSourceStrip ctl={ctl} channels={channels} from={media.from} />

        {/* 来源与口径（缺数据时必须看得见原因；矮视口下允许裁切，避免把宫格压扁） */}
        <div data-testid="sh10-notes" style={{ flex: '0 1 auto', minHeight: 0, overflow: 'hidden', fontSize: 10, color: C.textDim, lineHeight: 1.55 }}>
          <div>· {media.note}{media.from === 'none' && media.raw === null && verb0(flow) ? `（verb 回执：${verb0(flow)}）` : ''}</div>
          {error && <div style={{ color: C.warn }}>· {error}</div>}
          {assign.notes.map((t, i) => <div key={i}>· {t}</div>)}
          <div>· 通道与集群是两套清单（media.channels ↔ situation.snapshot.groups），本屏不假设它们的对应关系是权威的</div>
        </div>
      </div>

      {/* ---------------- 右栏：集群总体状态（**本屏没有**【更多详情 >】） ---------------- */}
      <div style={rightColStyle}>
        <ClusterStatusPanel
          rows={clusters.rows}
          notes={clusters.notes}
          testid="sh10-cluster-status"
          idPrefix="sh10-cluster-row"
        />
      </div>

      <ReconFusionProbe
        step={state.step}
        phase={state.phase}
        clusters={clusters.rows}
        clustersFrom={clusters.from}
        mediaFrom={media.from}
        mediaRaw={media.raw}
        channels={channels}
        assign={assign.list.map((a) => ({ id: a.channel?.id ?? null, name: a.channel?.name ?? null, matched: a.matched }))}
        snapshotReply={snap.reply}
        composeReply={compose.reply}
        notes={[...assign.notes, ...clusters.notes]}
      />
    </div>
  )
}

/** `media.channels` verb 的失败原话（没有就空串）——用于备注行。 */
function verb0(flow: UseFlow): string {
  const r = flow.replies['media.channels']
  if (!r || r.code === 0) return ''
  return replyText(r)
}

/**
 * 从宿主原文直读通道（**保留 frames 与 url**）。
 *
 * 为什么需要它：`readMedia` 只留了帧**数量**，控制器又可能建不起来（无浏览器能力时）。
 * 这一路保证"宿主给了帧，界面就还能显示真实帧"，而不是只剩一个空框。
 */
function nativeChannels(raw: unknown): MediaChannel[] {
  if (!isObj(raw)) return []
  const arr = raw.channels
  if (!Array.isArray(arr)) return []
  const out: MediaChannel[] = []
  arr.forEach((c, i) => {
    if (!isObj(c)) return
    const id = strOf(c, 'id') ?? strOf(c, 'channelId') ?? `c${i}`
    const name = strOf(c, 'name') ?? id
    const kindRaw = (strOf(c, 'kind') ?? strOf(c, 'type') ?? '').toLowerCase()
    const frames = Array.isArray(c.frames) ? c.frames.filter((u): u is string => typeof u === 'string' && !!u) : []
    const kind: MediaChannel['kind'] = frames.length || kindRaw.includes('image') || kindRaw.includes('seq') ? 'image-seq' : 'video'
    const availability = isObj(c) && typeof c.available === 'boolean' ? c.available : undefined
    const reason = strOf(c, 'unavailableReason') ?? strOf(c, 'reason')
    out.push({
      id,
      name,
      kind,
      url: strOf(c, 'url') ?? strOf(c, 'src') ?? null,
      frames: kind === 'image-seq' ? frames : null,
      frameCount: kind === 'image-seq' ? frames.length : 0,
      frameIntervalMs: 200,
      sourceLabel: strOf(c, 'sourceLabel') ?? null,
      available: availability ?? !reason,
      unavailableReason: reason ?? null,
      loop: false,
      poster: strOf(c, 'poster') ?? null,
      overlayKeys: [],
      meta: {},
    })
  })
  return out
}

/** 兜底：控制器不可用时，把 `readMedia` 读到的行做成"最小通道形状"（**不解析帧**，只用于显示名称/原因）。 */
function toChannelLike(c: { id: string; name: string; kind?: string; url?: string; frames?: number; available?: boolean; reason?: string }): MediaChannel {
  return {
    id: c.id,
    name: c.name,
    kind: (c.kind === 'image-seq' ? 'image-seq' : 'video') as MediaChannel['kind'],
    url: c.url ?? null,
    frames: null,
    frameCount: c.frames ?? 0,
    frameIntervalMs: 200,
    sourceLabel: null,
    available: c.available ?? true,
    unavailableReason: c.reason ?? null,
    loop: false,
    poster: null,
    overlayKeys: [],
    meta: {},
  }
}

function ReconFusionProbe(props: {
  step: number
  phase: string
  clusters: ClusterRow[]
  clustersFrom: string
  mediaFrom: string
  mediaRaw: unknown
  channels: MediaChannel[]
  assign: { id: string | null; name: string | null; matched: boolean }[]
  snapshotReply: { code: number; error?: { message?: string } } | null
  composeReply: { code: number; error?: { message?: string } } | null
  notes: string[]
}) {
  const w = window as unknown as { __sh10Stats?: Record<string, unknown> }
  w.__sh10Stats = {
    screen: 'SH-10',
    step: props.step,
    phase: props.phase,
    verb: { situation: props.snapshotReply, compose: props.composeReply },
    clusters: { from: props.clustersFrom, rows: props.clusters.map((c) => ({ key: c.key, name: c.name, type: c.typeLabel ?? null, battery: c.battery ?? null, signal: c.signal ?? null })) },
    media: {
      from: props.mediaFrom,
      raw: props.mediaRaw ?? null,
      channels: props.channels.map((c) => ({ id: c.id, name: c.name, kind: c.kind, frames: c.frameCount, available: c.available, reason: c.unavailableReason })),
      assign: props.assign,
    },
    notes: props.notes,
    dom: {
      cells: document.querySelectorAll('[data-testid^="sh10-cell-cluster"]').length,
      imgs: document.querySelectorAll('[data-testid$="-img"]').length,
      empty: document.querySelectorAll('[data-testid$="-empty"]').length,
      sources: document.querySelectorAll('[data-testid^="sh10-source-"]').length,
      rows: document.querySelectorAll('[data-testid^="sh10-cluster-row-"]').length,
      more: !!document.querySelector('[data-testid="sh10-more"]'),
    },
  }
  return null
}

// ---- 样式（一律 left/right/top/bottom 长写：**不写 inset 简写**）----
const PALETTE = ['#3b82f6', '#22c55e', '#eab308', '#a855f7', '#06b6d4', '#f97316'] as const
const wrap: CSSProperties = {
  position: 'absolute', left: 12, right: 12, top: 34, bottom: 12, zIndex: 20,
}
const toolbarStyle: CSSProperties = {
  position: 'absolute', left: 0, top: 0, zIndex: 22,
  display: 'flex', gap: 2, padding: '4px 6px', borderRadius: 8,
  background: 'rgba(6,26,47,.82)', border: `1px solid ${C.border}`,
}
const toolBtn: CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
  minWidth: 52, padding: '4px 8px', borderRadius: 6, cursor: 'default',
  background: 'transparent', border: '1px solid transparent',
}
const modePill: CSSProperties = {
  position: 'absolute', right: 0, top: 0, zIndex: 22, display: 'flex', gap: 6, alignItems: 'center',
  padding: '7px 12px', borderRadius: 999, fontSize: 12.5,
  background: 'rgba(6,26,47,.86)', border: `1px solid ${C.border}`,
}
const centerStyle: CSSProperties = {
  position: 'absolute', left: 0, right: 312, top: 52, bottom: 0, zIndex: 21,
  display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0,
}
const rightColStyle: CSSProperties = {
  position: 'absolute', right: 0, top: 40, bottom: 0, zIndex: 21, width: 292,
  display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0,
}
/** 面板基础（宫格外框；`panel` 令牌直接复用） */
export const fusionPanel = panel
export const fusionPanelTitle = panelTitle

export default ReconFusionScreen
