// mission-app · apps/web/src/screens/TargetsScreen.tsx
//
// Excel 步 7 · 实时侦察目标显示（参考图 `T4-1.png` 目标列表 / `T4-2.png` 目标详情与处置）。
//
// 它是**覆盖层**：底下的 `MapStage` 照常跑（目标标记/锁定框由地图台自己画），本文件摆：
//   · 顶部压条：阶段 / 目标数 / 当前选中 / 威胁等级
//   · 左栏：视频 / SAR 回传（`MediaPanel`）+ 目标来源汇总
//   · 右栏：目标详情（`targets.detail`：威胁等级 / 置信度 / 位置 / 海拔 / 特征 / 评估行）
//           + 处置动作（可行动作清单取自引擎）
//   · 底栏：目标列表（**横向卡片条**，条数随探测变化；点选发 `targets.detail`）
//
// ★ 纪律（写在最显眼处）：
//   ① **列表条数就是 `targets.list` 的条数**：不预置 5 张卡、不补占位卡；点第一张卡才会发
//      `targets.detail`，详情面板里的威胁等级/置信度/位置全部来自回执；
//   ② **处置按钮取值以引擎为准**：`targets.detail` 给了可行动作清单就按清单渲染；
//      给不出清单就把三个契约动作**灰置**并写明原因（MUST NOT 假装是引擎给的）；
//   ③ 视频面板没通道就如实写"未配置 + 原因"（见 `MediaPanel`），不画假画面。
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { C, panel, panelTitle } from '../theme'
import type { CommandReply, FlowState } from '../api'
import type { UseFlow } from '../flow/useFlow'
import { n2s, replyText, threatColor, useVerbOnce, type Metric } from '../flow/useSituation'
import {
  actionCN, readAct, readMedia, readTargetDetail, readTargets,
  type ActionOption, type TargetDetailView, type TargetRow, type TargetsView,
} from '../flow/useOps'
import { MediaPanel } from '../components/MediaPanel'
import { VerbVerdict } from './VerbVerdict'
import { StageStrip } from './StageOverlay'

/** 契约冻结的三个动作（`targets.act{action}`）。**仅当引擎没给清单时**用来占位显示（灰置）。 */
const CONTRACT_ACTIONS = ['observe', 'track', 'strike'] as const

/** 置信度口径：0–1 是比例，>1 视为已是百分数（只这一处换算，规则单一）。 */
function confText(v?: number): string {
  if (v === undefined) return '—'
  return `${n2s(v <= 1 ? Number((v * 100).toFixed(0)) : v)}%`
}

/** 经纬度显示（原样位数，四舍五入到 5 位；缺一个就显示"—"）。 */
function posText(lng?: number, lat?: number): string {
  if (lng === undefined || lat === undefined) return '—'
  return `${lat.toFixed(5)}N ${lng.toFixed(5)}E`
}

function Row({ k, v, color, testid }: { k: string; v: string; color?: string; testid?: string }) {
  return (
    <div data-testid={testid} style={{ display: 'flex', gap: 8, padding: '2px 0', fontSize: 12 }}>
      <span style={{ color: C.textDim, width: 72, flex: '0 0 auto' }}>{k}</span>
      <span style={{ color: color ?? C.text, minWidth: 0, wordBreak: 'break-all' }}>{v}</span>
    </div>
  )
}

function MetricRow({ m }: { m: Metric }) {
  return (
    <div data-testid="metric-row" style={{ display: 'flex', gap: 8, padding: '2px 0', fontSize: 12 }}>
      <span style={{ color: C.textDim, flex: 1, minWidth: 0 }}>{m.name}</span>
      <span style={{ color: m.status ? threatColor(m.status) : C.text, fontVariantNumeric: 'tabular-nums' }}>
        {m.value !== undefined ? n2s(m.value, m.unit ?? '') : (m.text ?? '—')}
      </span>
    </div>
  )
}

function Section({ title, children, testid }: { title: React.ReactNode; children: React.ReactNode; testid?: string }) {
  return (
    // box-sizing: border-box —— 避免 `width:100%` + 边框把 `overflowY:auto` 的列顶出横向滚动条
    <div data-testid={testid} style={{ ...panel, width: '100%', boxSizing: 'border-box' }}>
      <div style={panelTitle}>{title}</div>
      <div style={{ padding: '7px 12px 9px' }}>{children}</div>
    </div>
  )
}

/** 目标卡（T4-1 底部那条横向列表）。**内容全部来自 `targets.list` 的行**。 */
function TargetCard({ t, index, selected, onPick }: {
  t: TargetRow
  index: number
  selected: boolean
  onPick: () => void
}) {
  const threat = t.threat
  const color = threat ? threatColor(threat) : C.unknown
  return (
    <button
      data-testid="target-card"
      data-entity-id={t.entityId}
      data-threat={threat ?? ''}
      data-selected={selected ? '1' : '0'}
      onClick={onPick}
      style={{
        width: 132, flex: '0 0 auto', textAlign: 'left', cursor: 'pointer',
        border: `1px solid ${selected ? C.borderStrong : C.border}`, borderRadius: 8,
        background: selected ? 'rgba(29,78,216,.35)' : 'rgba(10,32,58,.6)',
        padding: '7px 9px', display: 'flex', flexDirection: 'column', gap: 3,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {/* 编号用宿主的 `no`；没有就退回落位序号（并标注是落位） */}
        <span style={{ fontSize: 11, color: C.textDim }}>{t.no !== undefined ? `#${t.no}` : `#${index + 1}*`}</span>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: color, flex: '0 0 auto' }} />
        <span style={{ fontSize: 11.5, color: color }}>{threat ?? '—'}</span>
        {t.threatScore !== undefined && <span style={{ fontSize: 10, color: C.textDim }}>{n2s(t.threatScore)}</span>}
      </div>
      <div style={{ fontSize: 12, color: C.text, lineHeight: 1.35 }}>{t.name}</div>
      <div style={{ fontSize: 10.5, color: C.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {t.typeKey ?? '—'}{t.source ? ` · ${t.source}` : ''}
      </div>
      <div style={{ fontSize: 10.5, color: C.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {t.motion ?? ''}{t.confidence !== undefined ? ` · 置信 ${confText(t.confidence)}` : ''}
        {t.status ? ` · ${t.status}` : ''}
      </div>
    </button>
  )
}

/** 处置动作按钮：引擎给了清单就按清单，没给就**灰置 + 写明原因**（并给一个"按动作键试发"的口子）。 */
function ActionButtons({ list, busy, onAct, entityId }: {
  list: ActionOption[]
  busy: boolean
  onAct: (domain: string) => void
  entityId: string | null
}) {
  /** 引擎没给清单时，操作员可以**自己敲动作键**（域不猜，回执原样显示） */
  const [manualKey, setManualKey] = useState('')
  if (list.length > 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="action-buttons" data-actions-source="engine">
        {list.map((a, i) => (
          <button
            key={a.domain}
            data-testid={`btn-act-${a.domain}`}
            data-action-domain={a.domain}
            data-action-enabled={a.enabled ? '1' : '0'}
            disabled={busy || !a.enabled || !entityId}
            onClick={() => onAct(a.domain)}
            title={a.reason ?? ''}
            style={i === 0 ? actPrimary : actGhost}
          >
            {a.label}
            {!a.enabled && a.reason ? `（${a.reason}）` : ''}
          </button>
        ))}
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="action-buttons" data-actions-source="none">
      {CONTRACT_ACTIONS.map((d) => (
        <button key={d} data-testid={`btn-act-${d}`} data-action-domain={d} data-action-enabled="0" disabled style={actDisabled}>
          {actionCN(d)}
        </button>
      ))}
      <div data-testid="actions-reason" style={{ fontSize: 11, color: C.warn, lineHeight: 1.6 }}>
        引擎未返回可行动作清单（`targets.detail` 的 actions / availableActions）→ 按纪律**灰置**。
        契约冻结取值 observe/track/strike 仅作占位，未发送。
      </div>
      {/* 契约与规则包的取值实测不一致（规则包是 watch/track/upgrade/strike/reassess）：
          与其猜，不如把"试发一个动作键"的口子留给操作员——**键是你敲的，回执照抄**。 */}
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          data-testid="act-key-input"
          value={manualKey}
          onChange={(e) => setManualKey(e.target.value)}
          placeholder="动作键（如 watch）"
          style={{
            flex: 1, minWidth: 0, padding: '5px 8px', fontSize: 12, borderRadius: 6,
            background: 'rgba(6,26,47,.8)', border: `1px solid ${C.border}`, color: C.text,
          }}
        />
        <button
          data-testid="btn-act-manual"
          disabled={busy || !entityId || !manualKey.trim()}
          onClick={() => onAct(manualKey.trim())}
          style={actGhost}
        >试发</button>
      </div>
    </div>
  )
}

export function TargetsScreen({ state, flow }: {
  state: FlowState
  flow: UseFlow
}) {
  // ---- 进屏发一次目标台账（幂等）；`entity.changed` 到达时限频重取 ----
  const list = useVerbOnce(flow, 'targets.list', {}, true)
  const tv: TargetsView = useMemo(() => readTargets(list.data), [list.data])

  // ---- 媒体通道：**事件优先**（`media.channels`），事件没来再退回 verb ----
  const mediaSlot = flow.events['media.channels']
  const mediaVerb = useVerbOnce(flow, 'media.channels', {}, true)
  const mediaRaw = mediaSlot?.data ?? (mediaVerb.reply?.code === 0 ? mediaVerb.reply.data : null)
  const mediaFrom: 'event' | 'verb' | 'none' = mediaSlot ? 'event' : (mediaVerb.reply?.code === 0 && mediaVerb.reply.data ? 'verb' : 'none')
  const mediaView = useMemo(() => readMedia(mediaRaw, mediaFrom), [mediaRaw, mediaFrom])

  // ---- 选中目标 → `targets.detail` ----
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detailNonce, setDetailNonce] = useState(0)
  const [detailReply, setDetailReply] = useState<CommandReply | null>(null)
  const [detailBusy, setDetailBusy] = useState(false)
  const send = flow.send
  const reqRef = useRef<string | null>(null)

  useEffect(() => {
    if (!selectedId) { reqRef.current = null; setDetailReply(null); return }
    const token = `${selectedId}#${detailNonce}`
    reqRef.current = token
    setDetailBusy(true)
    void send('targets.detail', { entityId: selectedId })
      .then((r) => { if (reqRef.current === token) setDetailReply(r) })
      .catch((e: unknown) => {
        if (reqRef.current === token) {
          setDetailReply({ code: -1, verb: 'targets.detail', error: { message: String((e as Error)?.message ?? e) } })
        }
      })
      .finally(() => { if (reqRef.current === token) setDetailBusy(false) })
  }, [selectedId, detailNonce, send])

  const dv: TargetDetailView = useMemo(() => readTargetDetail(detailReply?.data), [detailReply?.data])

  // ---- 处置动作 ----
  const [actBusy, setActBusy] = useState(false)
  const [actReply, setActReply] = useState<CommandReply | null>(null)
  const onAct = async (domain: string) => {
    if (!selectedId) return
    setActBusy(true)
    try {
      const r = await send('targets.act', { entityId: selectedId, action: domain })
      setActReply(r)
      // 动作成功后按需刷新台账（宿主可能已改该实体状态）；失败也刷新，看看台账有没有动
      if (r.code === 0) { list.resend(); setDetailNonce((n) => n + 1) }
    } finally {
      setActBusy(false)
    }
  }
  const av = readAct(actReply?.data)

  // ---- `entity.changed`（目标随探测出现/消失）→ 限频重取列表 ----
  const entityTs = flow.events['entity.changed']?.ts ?? 0
  const lastRefreshRef = useRef(0)
  const resendRef = useRef(list.resend)
  resendRef.current = list.resend
  useEffect(() => {
    if (!entityTs) return
    const now = Date.now()
    if (now - lastRefreshRef.current < 1500) return
    lastRefreshRef.current = now
    resendRef.current()
  }, [entityTs])

  const count = tv.items.length
  const hostTotal = tv.total
  const selected = tv.items.find((t) => t.entityId === selectedId)
  const threat = dv.threat ?? selected?.threat

  return (
    <>
      {/* ---------------- 顶部压条 ---------------- */}
      <StageStrip
        items={[
          { k: '阶段', v: state.phase || '—' },
          { k: '目标', v: `${count}${hostTotal !== undefined && hostTotal !== count ? `/${hostTotal}` : ''}`, color: C.accent },
          { k: '来源', v: strSources(tv) || '—' },
          { k: '选中', v: selectedId ? (dv.name ?? selected?.name ?? selectedId) : '未选择' },
          { k: '威胁等级', v: threat ?? '—', color: threat ? threatColor(threat) : C.unknown },
        ]}
        right={<span style={{ color: list.reply?.code === 0 ? C.textDim : C.warn }}>
          {list.reply === null
            ? '目标台账读取中…'
            : list.reply.code === 0
              ? `targets.list 已就绪（${count} 个目标${hostTotal !== undefined && hostTotal !== count ? `，宿主总数 ${hostTotal}` : ''}）`
              : `targets.list：${replyText(list.reply)}`}
        </span>}
      />

      {/* ---------------- 左：视频/SAR 回传 + 目标来源 ---------------- */}
      <div style={leftColStyle}>
        <MediaPanel
          raw={mediaRaw}
          from={mediaFrom}
          reply={mediaVerb.reply}
          busy={mediaVerb.busy}
          onRetry={mediaVerb.resend}
          overlayName={selected?.name}
          height={300}
        />
        <Section title="目标来源汇总" testid="target-summary-panel">
          {tv.totals.slice(0, 6).map((m) => <MetricRow key={m.key} m={m} />)}
          <Row k="目标总数" v={hostTotal !== undefined ? `${n2s(hostTotal)}（宿主字段）` : `${count}（列表条数）`} testid="target-total" />
          <Row k="列表条数" v={`${count}`} testid="target-count" />
          {tv.notes.slice(0, 3).map((t, i) => (
            <div key={i} style={{ fontSize: 11, color: C.textDim, lineHeight: 1.55 }}>· {t}</div>
          ))}
          {mediaView.from !== 'none' && (
            <div style={{ fontSize: 11, color: C.textDim, marginTop: 4 }}>
              媒体通道 {mediaView.channels.length} 路（{mediaView.from === 'event' ? '事件' : 'verb'}）
            </div>
          )}
        </Section>
      </div>

      {/* ---------------- 右：目标详情 + 处置动作 + 回执 ---------------- */}
      <div style={rightColStyle}>
        <Section
          title={<span>目标详情
            <span style={{ float: 'right', fontSize: 11.5, color: C.textDim }}>targets.detail</span>
          </span>}
          testid="target-detail-panel"
        >
          {!selectedId && (
            <div style={{ fontSize: 12, color: C.textDim, lineHeight: 1.7 }}>
              未选择目标 —— 点下方目标卡后发 `targets.detail{'{entityId}'}`。
            </div>
          )}
          {selectedId && detailReply && detailReply.code !== 0 && (
            <div data-testid="detail-not-ready" style={{ fontSize: 12, color: C.warn, lineHeight: 1.7 }}>
              targets.detail 未就绪：{replyText(detailReply)}
            </div>
          )}
          {selectedId && (
            <>
              <Row k="目标编号" v={dv.no !== undefined ? `#${dv.no}` : (dv.entityId ?? selectedId)} testid="detail-entity" />
              <Row k="实体 ID" v={dv.entityId ?? selectedId} />
              <Row k="目标名称" v={dv.name ?? selected?.name ?? '—'} />
              <Row k="目标类型" v={dv.typeKey ?? selected?.typeKey ?? '—'} testid="detail-type" />
              <Row
                k="威胁等级"
                v={dv.threat ?? (detailReply && detailReply.code === 0 ? '未提供' : '—')}
                color={dv.threat ? threatColor(dv.threat) : C.textDim}
                testid="detail-threat"
              />
              <Row k="威胁评分" v={dv.threatScore !== undefined ? n2s(dv.threatScore) : (selected?.threatScore !== undefined ? n2s(selected.threatScore) : '—')} />
              <Row k="置信度" v={confText(dv.confidence ?? selected?.confidence)} testid="detail-confidence" />
              <Row k="位置" v={posText(dv.lng ?? selected?.lng, dv.lat ?? selected?.lat)} testid="detail-position" />
              <Row k="海拔" v={dv.altM !== undefined ? `${n2s(dv.altM)} m` : (selected?.altM !== undefined ? `${n2s(selected.altM)} m` : '—')} />
              <Row k="来源" v={dv.source ?? selected?.source ?? '—'} testid="detail-source" />
              <Row k="动态状态" v={dv.status ?? selected?.status ?? '—'} />
              <Row k="打击优先级" v={dv.priority !== undefined ? n2s(dv.priority) : (selected?.priority !== undefined ? n2s(selected.priority) : '—')} />
              {dv.valueTag && <Row k="价值标签" v={dv.valueTag} color={C.bad} />}
              {dv.features.length > 0 && <Row k="目标特征" v={dv.features.join('、')} />}
              {dv.assessment.length > 0 && (
                <div style={{ marginTop: 5, borderTop: `1px solid ${C.border}`, paddingTop: 4 }}>
                  <div style={{ fontSize: 11.5, color: C.textDim, marginBottom: 2 }}>威胁评估（引擎）</div>
                  {dv.assessment.map((m) => <MetricRow key={m.key} m={m} />)}
                </div>
              )}
              {dv.analysis.length > 0 && (
                <div style={{ marginTop: 5, borderTop: `1px solid ${C.border}`, paddingTop: 4 }}>
                  <div style={{ fontSize: 11.5, color: C.textDim, marginBottom: 2 }}>AI 分析结果（引擎）</div>
                  {dv.analysis.slice(0, 4).map((t, i) => (
                    <div key={i} style={{ fontSize: 11.5, color: C.text, lineHeight: 1.65 }}>· {t}</div>
                  ))}
                </div>
              )}
              {dv.suggestion && (
                <div data-testid="detail-suggestion" style={{ marginTop: 5, fontSize: 12, color: C.accent }}>
                  建议处置：{dv.suggestion}
                  {dv.suggestionKey && <span style={{ color: C.textDim, fontSize: 10.5 }}>（字段 {dv.suggestionKey}）</span>}
                </div>
              )}
            </>
          )}
        </Section>

        <Section title="处置动作" testid="action-panel">
          {/* 动作清单来自引擎（实测 `declaredActions`）；本行把清单原样列出来，便于和按钮对数 */}
          {dv.actions.length > 0 && (
            <div data-testid="actions-declared" style={{ fontSize: 11, color: C.textDim, marginBottom: 5 }}>
              引擎声明的动作（{dv.actions.length} 个）：{dv.actions.map((a) => a.domain).join(' / ')}
            </div>
          )}
          <ActionButtons list={dv.actions} busy={actBusy} onAct={(d) => void onAct(d)} entityId={selectedId} />
          {av.entityId && (
            <div data-testid="act-result" style={{ marginTop: 6, fontSize: 11.5, color: actReply?.code === 0 ? C.ok : C.bad, lineHeight: 1.6 }}>
              targets.act 回执：{av.action ?? '—'}
              {av.to ? ` · 动作后状态 ${av.to}` : ''}
              {av.band ? ` · 威胁 ${av.band}` : ''}
              {av.idempotent ? '（幂等）' : ''}
              {av.conflict ? '（互斥冲突）' : ''}
              {actReply && actReply.code !== 0 ? `｜${replyText(actReply)}` : ''}
              {av.message && <div style={{ color: C.textDim }}>{av.message}</div>}
              {av.skippedGates.length > 0 && <div style={{ color: C.textDim }}>跳过的门禁：{av.skippedGates.join('、')}</div>}
              {av.unmet.length > 0 && <div style={{ color: C.warn }}>未满足：{av.unmet.join('、')}</div>}
              {av.gateNote && <div style={{ color: C.textDim, fontSize: 10.5 }}>{av.gateNote}</div>}
            </div>
          )}
          {/* 动作日志（实测 `actionLog[]`）：最后一次处置的结果（含被拒）照抄 */}
          {dv.actionLog.length > 0 && (
            <div data-testid="action-log" style={{ marginTop: 6, borderTop: `1px solid ${C.border}`, paddingTop: 4 }}>
              <div style={{ fontSize: 11, color: C.textDim, marginBottom: 2 }}>动作日志（引擎台账）</div>
              {dv.actionLog.map((a, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, fontSize: 11 }}>
                  <span style={{ color: C.text, width: 66, flex: '0 0 auto' }}>{a.actionKey ?? '—'}</span>
                  <span style={{ color: a.status === 'ok' ? C.ok : C.warn, flex: 1 }}>{a.status ?? '—'}</span>
                  <span style={{ color: C.textDim }}>{a.at ? new Date(a.at).toLocaleTimeString() : ''}</span>
                </div>
              ))}
            </div>
          )}
          {dv.notes.slice(0, 2).map((t, i) => (
            <div key={i} style={{ fontSize: 10.5, color: C.textDim, lineHeight: 1.5 }}>· {t}</div>
          ))}
        </Section>

        <VerbVerdict
          rows={[
            { verb: 'targets.list', reply: list.reply, busy: list.busy, onRetry: list.resend, okNote: `${count} 个目标` },
            { verb: 'targets.detail', reply: detailReply, busy: detailBusy, onRetry: () => setDetailNonce((n) => n + 1), okNote: `entityId=${dv.entityId ?? selectedId ?? '—'}` },
            { verb: 'targets.act', reply: actReply, busy: actBusy, okNote: `${av.action ?? '—'} → ${av.to ?? '—'}` },
            { verb: 'media.channels', reply: mediaVerb.reply, busy: mediaVerb.busy, onRetry: mediaVerb.resend, okNote: `${mediaView.channels.length} 路通道` },
          ]}
        />
      </div>

      {/* ---------------- 底：目标列表（条数随探测变化） ---------------- */}
      <div style={bottomStyle}>
        <div style={{ ...panel, flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={panelTitle}>
            目标列表
            <span style={{ float: 'right', fontSize: 11.5, color: C.textDim }}>
              {list.reply?.code === 0
                ? `targets.list：${count} 个${hostTotal !== undefined && hostTotal !== count ? `（宿主总数 ${hostTotal}）` : ''}`
                : (list.reply ? `targets.list → ${replyText(list.reply)}` : '正在读取目标台账…')}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8, padding: 9, flex: 1, minHeight: 0, overflowX: 'auto', alignItems: 'stretch' }}>
            {tv.items.map((t, i) => (
              <TargetCard
                key={t.entityId}
                t={t}
                index={i}
                selected={t.entityId === selectedId}
                onPick={() => setSelectedId(t.entityId)}
              />
            ))}
            {count === 0 && (
              <div style={{ alignSelf: 'center', fontSize: 12, color: C.textDim, lineHeight: 1.7, padding: '0 4px' }}>
                目标列表为空
                {list.reply && list.reply.code !== 0
                  ? ` —— 宿主未给出目标台账：${replyText(list.reply)}`
                  : '（宿主回执成功但 0 条：目标随探测出现，此屏数会变）'}
              </div>
            )}
          </div>
        </div>
      </div>

      <TargetsProbe
        step={state.step}
        phase={state.phase}
        listReply={list.reply}
        listRaw={list.data}
        count={count}
        hostTotal={hostTotal ?? null}
        targets={tv.items}
        selectedId={selectedId}
        detailReply={detailReply}
        detail={dv}
        actReply={actReply}
        lastReply={flow.lastReply}
        mediaFrom={mediaFrom}
        mediaRaw={mediaRaw}
        mediaVerbReply={mediaVerb.reply}
        mediaView={mediaView}
        eventKeys={Object.keys(flow.events)}
      />
    </>
  )
}

/** 顶部压条用：把（已读到的）来源域去重成一行。 */
function strSources(tv: TargetsView): string {
  const set = new Set<string>()
  for (const t of tv.items) if (t.source) set.add(t.source)
  return [...set].join('/')
}

/** 自证句柄 `window.__p4Stats`（步 7 的部分；步 6 的键保留，便于脚本一次读全）。 */
function TargetsProbe(props: {
  step: number
  phase: string
  listReply: CommandReply | null
  listRaw: unknown
  count: number
  hostTotal: number | null
  targets: TargetRow[]
  selectedId: string | null
  detailReply: CommandReply | null
  detail: TargetDetailView
  actReply: CommandReply | null
  /** 页面**最后一条**命令回执（App 底部徽标读的就是它；用来解释徽标上为什么有失败行） */
  lastReply: CommandReply | null
  mediaFrom: 'event' | 'verb' | 'none'
  mediaRaw: unknown
  mediaVerbReply: CommandReply | null
  mediaView: ReturnType<typeof readMedia>
  eventKeys: string[]
}) {
  const { step, phase, listReply, listRaw, count, hostTotal, targets, selectedId, detailReply, detail, actReply, lastReply, mediaFrom, mediaRaw, mediaVerbReply, mediaView, eventKeys } = props
  const w = window as unknown as { __p4Stats?: Record<string, unknown> }
  w.__p4Stats = {
    ...(w.__p4Stats ?? {}),
    step,
    screen: 'targets',
    phase,
    targets: {
      reply: listReply,
      raw: listRaw ?? null,
      count,
      hostTotal,
      /** 逐条实读（脚本用它和 DOM 卡片对齐） */
      rows: targets.map((t) => ({
        entityId: t.entityId, name: t.name, typeKey: t.typeKey ?? null, threat: t.threat ?? null,
        source: t.source ?? null, motion: t.motion ?? null, confidence: t.confidence ?? null,
        lng: t.lng ?? null, lat: t.lat ?? null,
      })),
    },
    selected: {
      entityId: selectedId,
      reply: detailReply,
      threat: detail.threat ?? null,
      typeKey: detail.typeKey ?? null,
      confidence: detail.confidence ?? null,
      lng: detail.lng ?? null,
      lat: detail.lat ?? null,
      altM: detail.altM ?? null,
      assessmentRows: detail.assessment.length,
      features: detail.features,
      analysis: detail.analysis,
      suggestion: detail.suggestion ?? null,
      /** 引擎给的可行动作域（空数组 = 引擎没给 → 界面灰置） */
      actionDomains: detail.actions.map((a) => a.domain),
      actionSource: detail.actions.length ? 'engine' : 'none',
    },
    act: actReply,
    /** 页面最后一条回执（徽标来源）：verb + code + 原话，用于解释界面上任何失败行 */
    lastReply: lastReply
      ? { verb: lastReply.verb, code: lastReply.code, message: lastReply.error?.message ?? null }
      : null,
    media: {
      from: mediaFrom,
      /** 清单原文（事件优先） */
      raw: mediaRaw ?? null,
      verbReply: mediaVerbReply,
      channels: mediaView.channels,
      eventKeys,
      domVideo: document.querySelectorAll('video').length,
      domImg: document.querySelectorAll('[data-media-tile] img').length,
      domTiles: document.querySelectorAll('[data-media-tile]').length,
    },
    dom: {
      targetCards: document.querySelectorAll('[data-testid="target-card"]').length,
      detailPanel: !!document.querySelector('[data-testid="target-detail-panel"]'),
      detailThreatText: document.querySelector('[data-testid="detail-threat"]')?.textContent ?? null,
      actionButtons: document.querySelectorAll('[data-testid="action-buttons"] button').length,
      actionsSource: document.querySelector('[data-testid="action-buttons"]')?.getAttribute('data-actions-source') ?? null,
      mediaPanel: !!document.querySelector('[data-testid="media-panel"]'),
      mediaNotConfigured: !!document.querySelector('[data-testid="media-not-configured"]'),
      mediaEmpty: !!document.querySelector('[data-testid="media-empty"]'),
    },
  }
  return null
}

// ---- 样式（一律 left/right/bottom 长写：**不写 inset 简写**）----
const leftColStyle: CSSProperties = {
  position: 'absolute', left: 12, top: 34, bottom: 200, zIndex: 20, width: 300,
  display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, overflowX: 'hidden',
}
const rightColStyle: CSSProperties = {
  position: 'absolute', right: 12, top: 34, bottom: 200, zIndex: 20, width: 320,
  display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', overflowX: 'hidden',
}
const bottomStyle: CSSProperties = {
  position: 'absolute', left: 12, right: 12, bottom: 6, zIndex: 21, height: 186,
}
const actPrimary: CSSProperties = {
  padding: '8px 12px', fontSize: 12.5, cursor: 'pointer', borderRadius: 7,
  border: '1px solid rgba(239,68,68,.55)', background: 'rgba(120,30,20,.55)', color: '#ffd9d4',
}
const actGhost: CSSProperties = {
  padding: '8px 12px', fontSize: 12.5, cursor: 'pointer', borderRadius: 7,
  border: `1px solid ${C.borderStrong}`, background: 'rgba(10,20,36,.7)', color: C.text,
}
const actDisabled: CSSProperties = {
  padding: '8px 12px', fontSize: 12.5, cursor: 'default', borderRadius: 7,
  border: `1px solid ${C.border}`, background: 'rgba(10,20,36,.5)', color: C.unknown,
}

export default TargetsScreen
