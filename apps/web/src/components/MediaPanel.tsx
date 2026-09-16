// mission-app · apps/web/src/components/MediaPanel.tsx
//
// 视频 / SAR 回传面板（Excel 步 7 `T4-1/T4-2`、步 10 的实时回传画面共用）。
//
// 数据来源：宿主的 `media.channels`（**事件**或 verb，两者都收，清单原样）。
// 渲染：`media-player` 包（Vite 别名原地引用，**不深层导入**——一切以它的 index.ts 为准）。
//
// ★ 纪律（这一块最容易被"补一个假画面"糊过去）：
//   · **没有通道就是没有**：不画黑框、不画占位图、不编一路假视频。宿主没给就写
//     "未配置 + 原因（事件没来 / verb 回 code=xxxx 原话）"，并给重试入口；
//   · 通道清单**原样**交给 media-player 归一化（它自己会逐条判可用性并给可读原因），
//     本组件不替它挑、也不替它算可用率；
//   · 不为渲染而注入任何业务文案：名称/来源/倍率全来自宿主字段。
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { MEDIA_PLAYER_CSS, MediaPlayer, normalizeChannels } from 'media-player'
import { C, panelTitle } from '../theme'
import type { CommandReply } from '../api'
import { replyText } from '../flow/useSituation'
import { readMedia } from '../flow/useOps'

/** 面板入参：清单 + 它的来源（事件/verb）+ 当前选中目标（有就作为叠加角标）。 */
export function MediaPanel({
  raw,
  from,
  reply,
  busy,
  onRetry,
  /** 面板标题（默认「视频 / SAR 回传」） */
  title = '视频 / SAR 回传',
  /** 叠加角标：当前目标编号/名称（宿主字段，不是我们编的） */
  overlayName,
  height = 168,
  testid = 'media-panel',
}: {
  raw: unknown
  from: 'event' | 'verb' | 'none'
  /** verb 回执（来自 `/api/command`；事件来源时为 null） */
  reply?: CommandReply | null
  busy?: boolean
  onRetry?: () => void
  title?: string
  overlayName?: string
  height?: number
  testid?: string
}) {
  const mv = useMemo(() => readMedia(raw, from), [raw, from])

  /** media-player 自报的"空清单原因"（它比我更清楚清单为什么不可用） */
  const [empty, setEmpty] = useState<{ reason: string; message: string } | null>(null)
  useEffect(() => { setEmpty(null) }, [raw])

  /** 归一化**只用于显示口径**（条数/可用数/被拒原因）；渲染仍把原始清单直投给组件 */
  const norm = useMemo(() => {
    try { return normalizeChannels(raw, { defaultKind: 'video' }) } catch { return null }
  }, [raw])
  const rejected = norm?.data?.rejected ?? []

  // 实测形状先落一条日志（排障用；控制台里能看到宿主到底给了什么）
  useEffect(() => {
    if (raw === null || raw === undefined) return
    console.log('[media.channels] 实测形状', JSON.parse(JSON.stringify(raw)))
  }, [raw])

  const usable = norm?.data?.usable ?? 0
  const total = mv.channels.length

  return (
    <div data-testid={testid} style={{ ...panelStyle, height }}>
      <style>{MEDIA_PLAYER_CSS}</style>
      <div style={{ ...panelTitle, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>{title}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11.5, color: C.textDim }}>
          {from === 'none'
            ? '未配置'
            : `通道 ${total} 路 · 可用 ${usable} 路（${from === 'event' ? 'media.channels 事件' : 'media.channels verb'}）`}
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, padding: '7px 10px 9px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {/* ---- ① 一条清单都没有：如实说清"为什么没有" ---- */}
        {from === 'none' && (
          <div data-testid="media-not-configured" style={noticeStyle}>
            <div style={{ fontSize: 12.5, color: C.text }}>媒体通道未配置</div>
            <div style={{ fontSize: 11.5, color: C.textDim, lineHeight: 1.7 }}>
              宿主既没有推送 `media.channels` 事件，也没有实现 `media.channels` verb。
              <br />
              verb 回执：
              <span style={{ color: reply && reply.code !== 0 ? C.warn : C.textDim }}>
                {reply ? (reply.code === 0 ? 'code=0（未给出通道清单）' : replyText(reply)) : '（本屏未发）'}
              </span>
              <br />
              事件面：<span style={{ color: C.textDim }}>本次会话未收到 media.channels（`flow.events` 里无该键）</span>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {onRetry && (
                <button data-testid="media-retry" onClick={onRetry} disabled={busy} style={miniBtn}>
                  {busy ? '重试中…' : '重试 media.channels'}
                </button>
              )}
            </div>
          </div>
        )}

        {/* ---- ② 有清单但没有通道：说清"清单是空的"，不画空框 ---- */}
        {from !== 'none' && total === 0 && (
          <div data-testid="media-empty" style={noticeStyle}>
            <div style={{ fontSize: 12.5, color: C.text }}>通道清单为空</div>
            <div style={{ fontSize: 11.5, color: C.textDim, lineHeight: 1.7 }}>
              宿主给出的清单里 `channels` 为 0 条（来源：{from === 'event' ? 'media.channels 事件' : 'media.channels verb'}）。
              {mv.schemaVersion && <><br />schemaVersion={mv.schemaVersion}</>}
              {mv.notes.slice(0, 2).map((t, i) => <div key={i}>· {t}</div>)}
            </div>
          </div>
        )}

        {/* ---- ③ 有通道：交给 media-player；它自己会画可用/不可用/失败态 ---- */}
        {from !== 'none' && total > 0 && (
          <>
            <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
              <MediaPlayer
                channels={raw}
                options={{ autoPlay: false, audioPolicy: 'none' }}
                mainChannelId={mv.channels[0]?.id ?? null}
                // 1–2 路单列（每格给足控制条的高度），3 路以上按参考图铺网格
                columns={total <= 2 ? 1 : 3}
                onEmpty={(reason, detail) => setEmpty({ reason: String(reason), message: detail.message })}
              />
            </div>
            {/* 通道逐条状态（**原样**：kind / 帧数 / 可用性 / 原因） */}
            <div style={{ maxHeight: 46, overflowY: 'auto' }} data-testid="media-channel-list">
              {mv.channels.map((c) => {
                const n = norm?.channels.find((x) => x.id === c.id)
                const reason = n?.unavailableReason ?? c.reason
                return (
                  <div key={c.id} data-testid="media-channel-row" data-channel-id={c.id} style={{ display: 'flex', gap: 8, fontSize: 11, padding: '1px 0' }}>
                    <span style={{ flex: 1, minWidth: 0, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {overlayName ? `${overlayName} · ` : ''}{c.name}
                    </span>
                    <span style={{ color: C.textDim }}>{n?.kind ?? c.kind ?? '—'}</span>
                    <span style={{ color: n && !n.available ? C.bad : C.ok }}>
                      {n && !n.available
                        ? (reason ?? '不可用')
                        : (n?.kind === 'image-seq' ? `${n.frameCount} 帧` : 'video')}
                    </span>
                  </div>
                )
              })}
            </div>
            {/* media-player 报了空清单原因（清单有通道但全部不可用时会走这里） */}
            {empty && (
              <div data-testid="media-player-empty" style={{ fontSize: 11, color: C.warn, lineHeight: 1.6 }}>
                media-player 未渲染任何通道：{empty.reason} —— {empty.message}
              </div>
            )}
          </>
        )}

        {/* 被归一化拒绝的条目（宿主字段写错时**必须可见**，别让它静默消失） */}
        {rejected.length > 0 && (
          <div data-testid="media-rejected" style={{ fontSize: 11, color: C.warn, lineHeight: 1.55 }}>
            {rejected.length} 条通道被 media-player 拒绝：
            {rejected.slice(0, 2).map((r) => ` [${r.index}] ${r.reason}`).join('；')}
          </div>
        )}
      </div>
    </div>
  )
}

const panelStyle: CSSProperties = {
  display: 'flex', flexDirection: 'column',
  background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10,
  // 刻意不用 backdrop-filter（headless 无 GPU 下整块面板不参与合成 → 截图里"面板消失"）
  overflow: 'hidden',
}
const noticeStyle: CSSProperties = {
  flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 5,
  alignItems: 'center', justifyContent: 'center', textAlign: 'center',
  border: `1px dashed ${C.border}`, borderRadius: 8, padding: '8px 10px',
}
const miniBtn: CSSProperties = {
  padding: '3px 10px', fontSize: 11.5, cursor: 'pointer', borderRadius: 6,
  background: 'rgba(10,20,36,.7)', border: `1px solid ${C.border}`, color: C.text,
}

export default MediaPanel
