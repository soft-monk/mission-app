// mission-app · apps/web/src/screens/StrikeScreen.tsx
//
// Excel 步 8 · 任务决策与打击准备（参考图 `T5-1.png`）。
//
// 布局照图：
//   顶 · 压条：显示模式 / 阶段 / 方案数 / 推荐方案 / 选中目标
//   左 · 打击目标（`targets.list` 台账，点一行发 `strike.window{entityId}`）
//        + 打击窗口（`strike.window` 的读数：剩余/时长/起止/最优时刻，**原样**）
//   中 · **三张打击方案卡**（`strike.plans`）：成功率 / 协同方式 / 预计完成时间 /
//        方案要点 / 理由 —— 逐项都来自回执，缺哪项就写"—"
//   右 · AI 决策摘要（`recommendedId` + `reasons[]`）+ 打击命令回执（`strike.adopt`）
//   底 · 【采纳该方案】`strike.adopt` · 【进入打击确认 ≫】`flow.goto{step:9}`
//
// ★ 纪律（这一屏最容易犯的三个错）：
//   ① **推荐不是前端挑的**：卡片上的「引擎推荐」标记只看 `recommendedId` 与候选自带的
//      `recommendedHint/recommended`；两样都没有 → 一张都不标，并在右栏写明"引擎未指定推荐"。
//      MUST NOT 拿 successRate 自己排一个"最优"。
//   ② **协同方式/预计完成时间不是文案**：`coordination`（域）经词典折成中文（宿主给了
//      `coordinationLabel` 就优先用宿主的），`plannedFinish.minutes` 与它的 `basis` 一起显示
//      —— `basis` 就是"这个时间怎么算出来的"。
//   ③ **窗口剩余不做本地倒计时**：屏幕上的数就是 `strike.window` 给的那个数（连字段名一起标），
//      前端每秒减一等于造了一串宿主的时钟没给过的数。
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { C, panel, panelTitle } from '../theme'
import type { CommandReply, FlowState } from '../api'
import type { UseFlow } from '../flow/useFlow'
import { n2s, readCompose, replyText, useVerbOnce } from '../flow/useSituation'
import { readTargets } from '../flow/useOps'
import {
  readReceipt, readStrikePlans, readStrikeWindow,
  type StrikePlanView, type StrikePlansView,
} from '../flow/useStrike'
import { VerbVerdict } from './VerbVerdict'
import { StageStrip } from './StageOverlay'

/** 一行「名 + 值」：值缺失显示"—"，**不补 0**。 */
function Row({ k, v, color, testid }: { k: string; v: string; color?: string; testid?: string }) {
  return (
    <div data-testid={testid} style={{ display: 'flex', gap: 8, padding: '2px 0', fontSize: 12 }}>
      <span style={{ color: C.textDim, width: 76, flex: '0 0 auto' }}>{k}</span>
      <span style={{ color: color ?? C.text, minWidth: 0, wordBreak: 'break-word' }}>{v}</span>
    </div>
  )
}

/**
 * 方案卡里的「名 + 值」行。
 *
 * 卡片只有 ~200px 宽（三张平分中栏），所以键列窄、字号小、值允许换行
 * —— 用外面那个 76px 键列的 `Row` 会把 "（simultaneous）" 挤成两行（实测踩到）。
 */
function CRow({ k, v, color, testid, title }: { k: string; v: string; color?: string; testid?: string; title?: string }) {
  return (
    <div data-testid={testid} style={{ display: 'flex', gap: 6, padding: '1px 0', fontSize: 11 }}>
      <span style={{ color: C.textDim, width: 50, flex: '0 0 auto' }}>{k}</span>
      <span title={title ?? v} style={{ color: color ?? C.text, minWidth: 0, flex: 1, wordBreak: 'break-word' }}>{v}</span>
    </div>
  )
}

/** 经纬高显示（**原样位数**；宿主给了才显示，缺就"—"）。 */
function posText(g: { lng?: number; lat?: number; altM?: number }): string {
  if (g.lng === undefined || g.lat === undefined) return '—'
  return `${g.lat.toFixed(5)}N ${g.lng.toFixed(5)}E${g.altM !== undefined ? ` · 高 ${n2s(g.altM)} m` : ''}`
}

function Section({ title, children, testid }: { title: React.ReactNode; children: React.ReactNode; testid?: string }) {
  return (
    // box-sizing: border-box —— `width:100%` + 边框在 content-box 下会顶出横向滚动条（实测踩到）
    <div data-testid={testid} style={{ ...panel, width: '100%', boxSizing: 'border-box' }}>
      <div style={panelTitle}>{title}</div>
      <div style={{ padding: '7px 12px 9px' }}>{children}</div>
    </div>
  )
}

/**
 * 一张打击方案卡（参考图 T5-1 中央那三张）。
 *
 * 要求逐项落地：**成功率 / 协同方式 / 预计完成时间 / 方案要点 / 理由**。
 * 每一项都带 `data-*`，验收脚本据此与 `strike.plans` 回执逐条对数。
 */
function StrikePlanCard({ plan, index, selected, onSelect }: {
  plan: StrikePlanView
  index: number
  selected: boolean
  onSelect: () => void
}) {
  const border = plan.recommended ? 'rgba(95,176,255,.85)' : selected ? C.borderStrong : C.border
  const minutes = plan.plannedFinish?.minutes
  return (
    <div
      data-testid="strike-plan-card"
      data-plan-id={plan.id}
      data-plan-index={index}
      data-plan-name={plan.name}
      data-plan-recommended={plan.recommended ? '1' : '0'}
      data-plan-success={plan.successRate !== undefined ? String(plan.successRate) : ''}
      data-plan-coordination={plan.coordination ?? ''}
      data-plan-coordination-cn={plan.coordinationCN}
      data-plan-minutes={minutes !== undefined ? String(minutes) : ''}
      data-plan-reason-source={plan.reasonsSource}
      data-selected={selected ? '1' : '0'}
      onClick={onSelect}
      style={{
        // 三张卡**平分**中栏（不再固定 250px）：容器只有 664px 宽，固定宽会顶出横向滚动条（实测踩到）
        flex: '1 1 0', minWidth: 196, display: 'flex', flexDirection: 'column', cursor: 'pointer',
        border: `1px solid ${border}`, borderRadius: 8,
        background: plan.recommended ? 'rgba(29,78,216,.16)' : 'rgba(10,32,58,.55)',
        overflow: 'hidden',
      }}
    >
      {/* 卡头：方案名 + 推荐标记（标记只由 recommendedId/ recommendedHint 决定） */}
      <div style={{ padding: '6px 9px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span data-testid="strike-plan-index" style={{ ...badgeNum }}>{index + 1}</span>
        <span title={plan.name} style={{ fontSize: 12, color: C.text, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {plan.name}
        </span>
        {plan.recommended && <span data-testid="strike-recommend-badge" style={recBadge}>引擎推荐</span>}
      </div>

      {/* 成功率 / 评分 / 排名 —— 分不出"哪个更好"，只把宿主的数摆出来 */}
      <div style={{ padding: '5px 9px 0', display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span data-testid="strike-plan-success" style={{ fontSize: 17, color: C.accent, fontVariantNumeric: 'tabular-nums' }}>
          {plan.successRate !== undefined ? `${n2s(plan.successRate)}%` : '—'}
        </span>
        <span style={{ fontSize: 11, color: C.textDim }}>成功率预估</span>
        {plan.score !== undefined && <span style={{ fontSize: 11, color: C.textDim }}>评分 {n2s(plan.score)}</span>}
        {plan.rank !== undefined && <span style={{ fontSize: 11, color: C.textDim }}>排名 {plan.rank}</span>}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 8px 8px' }}>
        {/* 协同方式：域 + 中文（标注中文是哪来的：宿主的 label / 词典 / 原样域） */}
        <CRow
          k="协同方式"
          testid="strike-plan-coordination"
          v={`${plan.coordinationCN}${plan.coordination ? ` · ${plan.coordination}` : ''}`}
          color={plan.coordination ? C.text : C.textDim}
        />
        <CRow k="中文来源" v={plan.coordinationSource === 'host-label' ? '宿主 coordinationLabel' : plan.coordinationSource === 'dict' ? '本地词典' : plan.coordinationSource === 'raw' ? '域未收录，原样显示' : '—'} />
        {/* 预计完成时间：相对 t0 的分钟数 + basis（"怎么算出来的"）一起显示 */}
        <CRow
          k="预计完成"
          testid="strike-plan-finish"
          v={plan.plannedFinish ? plan.plannedFinish.text : '—'}
          color={plan.plannedFinish ? C.text : C.warn}
        />
        <CRow
          k="时间依据"
          testid="strike-plan-finish-basis"
          v={plan.plannedFinish?.basis ? `${plan.plannedFinish.basis}${minutes !== undefined ? `（t0 + ${n2s(minutes)} 分钟）` : ''}` : '宿主未给出 basis'}
          color={plan.plannedFinish?.basis ? C.textDim : C.warn}
        />
        {plan.method && <CRow k="打击方式" v={plan.method} testid="strike-plan-method" />}
        {plan.effect && <CRow k="打击效果" v={plan.effect} />}
        {plan.summary && <CRow k="方案要点" v={plan.summary} testid="strike-plan-summary" />}
        <CRow k="参与集群" v={plan.clusters.length ? `${plan.clusters.join(' / ')}（${plan.clusters.length} 个）` : '—'} testid="strike-plan-clusters" />
        {(plan.attackStart || plan.assessRoute) && (
          <>
            <CRow
              k="几何引用"
              v={[
                plan.attackStart ? `IP 点 ${plan.attackStart.key ?? '—'}` : null,
                plan.assessRoute ? `评估航线 ${plan.assessRoute.key ?? '—'}${plan.assessRoute.waypointCount !== undefined ? `（${plan.assessRoute.waypointCount} 航点）` : ''}` : null,
              ].filter(Boolean).join(' · ')}
              testid="strike-plan-geometry"
            />
            {/* 宿主是否已把键引用解析成几何（**只标注**：未解析就明说，界面不补坐标） */}
            <CRow
              k="几何解析"
              v={plan.geometryResolved === undefined ? '—' : plan.geometryResolved ? '已解析（geometry.resolved=true）' : '未解析（键引用没有几何 → 步 9 不画）'}
              color={plan.geometryResolved === false ? C.warn : C.textDim}
            />
            {plan.attackStart?.geo && (
              <CRow k="IP 点坐标" v={posText(plan.attackStart.geo)} />
            )}
          </>
        )}

        {/* 理由：候选自带就用候选的；否则用顶层 recommendations 的理由并**标明来源** */}
        <div data-testid="strike-plan-reasons" data-reason-source={plan.reasonsSource}
          style={{ marginTop: 5, borderTop: `1px solid ${C.border}`, paddingTop: 4 }}>
          <div style={{ fontSize: 11, color: C.textDim, marginBottom: 2 }}>
            理由{plan.reasonsSource === 'top-level' ? '（顶层 reasons[]，引擎给的是推荐方案的理由）' : ''}
          </div>
          {plan.reasons.length > 0
            ? plan.reasons.slice(0, 4).map((t, i) => (
              <div key={i} style={{ fontSize: 11, color: C.text, lineHeight: 1.6 }}>· {t}</div>
            ))
            : <div style={{ fontSize: 11, color: C.textDim }}>宿主未给出该方案的理由</div>}
        </div>

        {plan.inapplicableReasons.length > 0 && (
          <div style={{ fontSize: 10.5, color: C.warn, marginTop: 3 }}>
            不适用原因：{plan.inapplicableReasons.join('；')}
          </div>
        )}
        {plan.effects.length > 0 && (
          <div style={{ marginTop: 5, borderTop: `1px solid ${C.border}`, paddingTop: 4 }}>
            <div style={{ fontSize: 11, color: C.textDim, marginBottom: 2 }}>指标（score.metrics[].raw）</div>
            {plan.effects.slice(0, 6).map((m) => (
              <div key={m.key} style={{ display: 'flex', gap: 8, fontSize: 11 }}>
                <span style={{ color: C.textDim, flex: 1, minWidth: 0 }}>{m.name}</span>
                <span style={{ color: C.text, fontVariantNumeric: 'tabular-nums' }}>
                  {m.value !== undefined ? `${n2s(m.value)}${m.unit ?? ''}` : (m.text ?? '—')}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export function StrikeScreen({ state, flow, selectedPlanId, onSelectPlan, onNext }: {
  state: FlowState
  flow: UseFlow
  /** 由本屏选中/采纳的方案（步 9 要沿用同一个 planId） */
  selectedPlanId: string | null
  onSelectPlan: (id: string) => void
  /** 进入步 9（切步一律发 `flow.goto`，step 归宿主） */
  onNext: () => void
}) {
  // ---- 进屏发一次（都是幂等的读命令）----
  const plans = useVerbOnce(flow, 'strike.plans', { count: 3 }, true)
  const targets = useVerbOnce(flow, 'targets.list', {}, true)
  const compose = useVerbOnce(flow, 'view.compose', { phase: state.phase || 'T5' }, true)

  const pv: StrikePlansView = useMemo(() => readStrikePlans(plans.data), [plans.data])
  const tv = useMemo(() => readTargets(targets.data), [targets.data])
  const cmp = readCompose(compose.data)

  // 默认选中：宿主指定的推荐 → 自带推荐标记的 → 第一张（**不按成功率排**）
  const selected = pv.plans.find((p) => p.id === selectedPlanId)
    ?? pv.plans.find((p) => p.id === pv.recommendedId)
    ?? pv.plans.find((p) => p.recommended)
    ?? pv.plans[0]

  // ---- 打击目标 → `strike.window{entityId}` ----
  const [entityId, setEntityId] = useState<string | null>(null)
  const [winReply, setWinReply] = useState<CommandReply | null>(null)
  const [winBusy, setWinBusy] = useState(false)
  const send = flow.send
  const reqRef = useRef<string | null>(null)
  useEffect(() => {
    if (!entityId) { reqRef.current = null; setWinReply(null); return }
    const token = entityId
    reqRef.current = token
    setWinBusy(true)
    void send('strike.window', { entityId })
      .then((r) => { if (reqRef.current === token) setWinReply(r) })
      .catch((e: unknown) => {
        if (reqRef.current === token) {
          setWinReply({ code: -1, verb: 'strike.window', error: { message: String((e as Error)?.message ?? e) } })
        }
      })
      .finally(() => { if (reqRef.current === token) setWinBusy(false) })
  }, [entityId, send])
  const wv = useMemo(() => readStrikeWindow(winReply?.data), [winReply?.data])

  // ---- 【采纳该方案】`strike.adopt{planId}` ----
  const [busy, setBusy] = useState(false)
  const [adoptReply, setAdoptReply] = useState<CommandReply | null>(null)
  const rv = readReceipt(adoptReply?.data)
  const onAdopt = async () => {
    if (!selected || busy) return
    setBusy(true)
    try {
      const r = await send('strike.adopt', { planId: selected.id })
      setAdoptReply(r)
      if (r.code === 0) onSelectPlan(selected.id)
    } finally {
      setBusy(false)
    }
  }
  const adoptedOk = adoptReply?.code === 0

  const recPlan = pv.plans.find((p) => p.id === pv.recommendedId) ?? pv.plans.find((p) => p.recommended)
  const badgeCount = pv.plans.filter((p) => p.recommended).length

  return (
    <>
      {/* ---------------- 顶部压条 ---------------- */}
      <StageStrip
        items={[
          { k: '显示模式', v: cmp.modeName ?? cmp.modeKey ?? '—', color: C.accent },
          { k: '阶段', v: state.phase || '—' },
          { k: '方案', v: `${pv.plans.length} 个` },
          { k: '推荐', v: pv.recommendedId ?? (badgeCount === 1 ? (recPlan?.name ?? '—') : '引擎未指定'), color: pv.recommendedId || badgeCount ? C.ok : C.warn },
          { k: '打击目标', v: entityId ? (tv.items.find((t) => t.entityId === entityId)?.name ?? entityId) : '未选择' },
        ]}
        right={<span style={{ color: plans.reply?.code === 0 ? C.textDim : C.warn }}>
          {plans.reply === null
            ? '打击方案读取中…'
            : plans.reply.code === 0
              ? `strike.plans 已就绪（${pv.plans.length} 个方案；推荐标记 ${badgeCount} 个）`
              : `strike.plans：${replyText(plans.reply)}`}
        </span>}
      />

      {/* ---------------- 左：打击目标 + 打击窗口 ---------------- */}
      <div style={leftColStyle}>
        <Section title={<span>打击目标<span style={{ float: 'right', fontSize: 11.5, color: C.textDim }}>targets.list</span></span>} testid="strike-target-panel">
          <div style={{ maxHeight: 168, overflowY: 'auto' }}>
            {tv.items.map((t) => (
              <button
                key={t.entityId}
                data-testid="strike-target-row"
                data-entity-id={t.entityId}
                data-selected={t.entityId === entityId ? '1' : '0'}
                onClick={() => setEntityId(t.entityId)}
                style={{
                  width: '100%', textAlign: 'left', cursor: 'pointer', marginBottom: 5,
                  border: `1px solid ${t.entityId === entityId ? C.borderStrong : C.border}`, borderRadius: 6,
                  background: t.entityId === entityId ? 'rgba(29,78,216,.35)' : 'rgba(10,32,58,.5)',
                  padding: '5px 8px', display: 'flex', gap: 6, alignItems: 'baseline',
                }}
              >
                <span style={{ fontSize: 11, color: C.textDim }}>{t.no !== undefined ? `#${t.no}` : t.entityId}</span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.name}
                </span>
                {t.threat && <span style={{ fontSize: 11, color: C.textDim }}>{t.threat}</span>}
              </button>
            ))}
            {tv.items.length === 0 && (
              <div style={{ fontSize: 11.5, color: C.textDim, lineHeight: 1.7 }}>
                目标台账为空 / 未就绪
                {targets.reply && targets.reply.code !== 0 ? <div style={{ color: C.warn }}>{replyText(targets.reply)}</div> : null}
              </div>
            )}
          </div>
        </Section>

        <Section title={<span>打击窗口<span style={{ float: 'right', fontSize: 11.5, color: C.textDim }}>strike.window</span></span>} testid="strike-window-panel">
          {!entityId && (
            <div style={{ fontSize: 11.5, color: C.textDim, lineHeight: 1.7 }}>
              未选择目标 —— 点上方目标行后发 `strike.window{'{entityId}'}`。
            </div>
          )}
          {entityId && winReply && winReply.code !== 0 && (
            <div data-testid="strike-window-not-ready" style={{ fontSize: 11.5, color: C.warn, lineHeight: 1.7 }}>
              strike.window 未就绪：{replyText(winReply)}
            </div>
          )}
          {entityId && (
            <>
              <Row k="目标" v={wv.entityId ?? entityId} />
              {/* 剩余/时长：**宿主给的数**，界面不做本地倒计时 */}
              <Row k="窗口剩余" v={wv.remainingMs !== undefined ? `${n2s(wv.remainingMs)} ms（remainingMs）` : '—'} color={wv.remainingMs !== undefined ? C.accent : C.textDim} testid="strike-window-remaining" />
              <Row k="窗口时长" v={wv.durationMs !== undefined ? `${n2s(wv.durationMs)} ms（durationMs）` : '—'} />
              <Row k="开启" v={wv.opensAt ?? '—'} />
              <Row k="关闭" v={wv.closesAt ?? '—'} />
              <Row k="最优时刻" v={wv.optimalAt ?? '—'} />
              {wv.metrics.slice(0, 5).map((m) => (
                <Row key={m.key} k={m.name} v={m.value !== undefined ? n2s(m.value, m.unit ?? '') : (m.text ?? '—')} />
              ))}
              {wv.pairs.length > 0 && (
                <details data-testid="strike-window-raw" style={{ marginTop: 4 }}>
                  <summary style={{ fontSize: 10.5, color: C.textDim, cursor: 'pointer' }}>
                    strike.window 回执全部字段（{wv.pairs.length} 项，原样）
                  </summary>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px', marginTop: 3, maxHeight: 90, overflowY: 'auto' }}>
                    {wv.pairs.slice(0, 24).map((p, i) => (
                      <span key={i} style={{ fontSize: 10, color: C.textDim }}>{p.path}=<span style={{ color: C.text }}>{p.value}</span></span>
                    ))}
                  </div>
                </details>
              )}
              {!wv.remainingMs && !wv.durationMs && !wv.opensAt && !wv.closesAt && wv.pairs.length === 0 && (
                <div style={{ fontSize: 11, color: C.textDim }}>回执成功但没有本屏可显示的字段（界面不补数）</div>
              )}
            </>
          )}
        </Section>

        <VerbVerdict
          rows={[
            { verb: 'strike.plans', reply: plans.reply, busy: plans.busy, onRetry: plans.resend, okNote: `${pv.plans.length} 个方案` },
            { verb: 'targets.list', reply: targets.reply, busy: targets.busy, onRetry: targets.resend, okNote: `${tv.items.length} 个目标` },
            { verb: 'strike.window', reply: winReply, busy: winBusy, okNote: `entityId=${wv.entityId ?? entityId ?? '—'}` },
          ]}
        />
      </div>

      {/* ---------------- 中下：三张打击方案卡 ---------------- */}
      <div style={cardsStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 2px 6px' }}>
          <span style={{ fontSize: 13, color: C.text, letterSpacing: 0.5 }}>打击方案</span>
          <span data-testid="strike-plan-count" style={{ fontSize: 11.5, color: C.accent }}>方案 {pv.plans.length}</span>
          {/* 推荐标记的数量：0 个 = 引擎没指定；>1 个 = 回执自相矛盾；界面都如实说 */}
          <span data-testid="strike-recommend-count" style={{ fontSize: 11.5, color: badgeCount === 1 ? C.ok : C.warn }}>
            推荐标记 {badgeCount} 个{pv.recommendedId ? `（recommendedId=${pv.recommendedId}）` : '（回执未给 recommendedId）'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'stretch', flex: 1, minHeight: 0, overflowX: 'auto' }}>
          {pv.plans.map((p, i) => (
            <StrikePlanCard key={p.id} plan={p} index={i} selected={p.id === selected?.id} onSelect={() => onSelectPlan(p.id)} />
          ))}
          {pv.plans.length === 0 && (
            <div style={{ ...panel, flex: 1, padding: 13, fontSize: 12.5, color: C.textDim, lineHeight: 1.9 }}>
              <div>打击方案未就绪：`strike.plans` 没有返回候选方案。</div>
              {plans.sent && plans.reply && plans.reply.code !== 0 && (
                <div style={{ color: C.warn }}>strike.plans → {replyText(plans.reply)}</div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ---------------- 右：AI 决策摘要 + 采纳回执 ---------------- */}
      <div style={rightColStyle}>
        <Section title="AI 决策摘要" testid="strike-summary-panel">
          <Row k="方案数" v={plans.reply?.code === 0 ? `${pv.plans.length} 套（strike.plans）` : '—'} />
          <Row
            k="推荐方案"
            v={recPlan?.name ?? (pv.recommendedId ? `${pv.recommendedId}（回执里没有同 id 的候选）` : '引擎未指定推荐')}
            color={recPlan ? C.ok : C.warn}
            testid="strike-recommend-name"
          />
          <Row k="推荐评分" v={pv.recommendedPercent !== undefined ? `${n2s(pv.recommendedPercent)}%` : '—'} />
          <Row k="领先次优" v={pv.leadOverNextPercent !== undefined ? `${n2s(pv.leadOverNextPercent)}%${pv.nextId ? `（次优 ${pv.nextId} ${n2s(pv.nextPercent)}%）` : ''}` : '—'} />
          <Row k="当前选中" v={selected?.name ?? '—'} color={C.accent} testid="strike-selected-plan" />

          <div style={{ marginTop: 6, borderTop: `1px solid ${C.border}`, paddingTop: 5 }}>
            <div style={{ fontSize: 12, color: C.textDim, marginBottom: 3 }}>推荐理由（strike.plans.reasons[]）</div>
            {pv.reasons.length > 0
              ? pv.reasons.map((t, i) => (
                <div key={i} data-testid="strike-top-reason" style={{ fontSize: 11.5, color: C.text, lineHeight: 1.65 }}>· {t}</div>
              ))
              : <div style={{ fontSize: 11.5, color: C.textDim }}>宿主未给出推荐理由</div>}
          </div>

          {pv.notes.length > 0 && (
            <div style={{ marginTop: 6, borderTop: `1px solid ${C.border}`, paddingTop: 5 }}>
              {pv.notes.slice(0, 3).map((t, i) => (
                <div key={i} style={{ fontSize: 11, color: C.textDim, lineHeight: 1.55 }}>· {t}</div>
              ))}
            </div>
          )}
          {pv.missingInputs.length > 0 && (
            <div style={{ fontSize: 11, color: C.warn, marginTop: 4 }}>采集口径提示：{pv.missingInputs.join('；')}</div>
          )}
        </Section>

        <Section title={<span>采纳回执<span style={{ float: 'right', fontSize: 11.5, color: C.textDim }}>strike.adopt</span></span>} testid="strike-adopt-panel">
          {!adoptReply && <div style={{ fontSize: 11.5, color: C.textDim, lineHeight: 1.7 }}>尚未采纳 —— 点下方【采纳该方案】发 `strike.adopt{'{planId}'}`。</div>}
          {adoptReply && (
            <div data-testid="strike-adopt-receipt" style={{ fontSize: 11.5, color: adoptReply.code === 0 ? C.ok : C.bad, lineHeight: 1.7 }}>
              <div>code={adoptReply.code}{adoptReply.code === 0 ? '（成功）' : `：${replyText(adoptReply)}`}</div>
              {rv.planId && <div>planId={rv.planId}</div>}
              {rv.planState && <div>planState={rv.planState}{rv.idempotent ? ' · 幂等' : ''}</div>}
              {rv.action && <div>action={rv.action}</div>}
              {rv.toStep !== undefined && <div>宿主推进到步 {rv.toStep}</div>}
              {rv.phase && <div>阶段 {rv.phase}</div>}
              {rv.message && <div style={{ color: C.textDim }}>{rv.message}</div>}
              {rv.unmet.length > 0 && <div style={{ color: C.warn }}>未满足：{rv.unmet.join('、')}</div>}
              {rv.invalidated.length > 0 && <div style={{ color: C.warn }}>已失效：{rv.invalidated.join('、')}</div>}
              {/* 逐条：回执里所有叶子字段（宿主回了什么就显示什么，一个都不吞） */}
              {rv.pairs.length > 0 && (
                <details data-testid="strike-adopt-raw" style={{ marginTop: 4 }}>
                  <summary style={{ fontSize: 10.5, color: C.textDim, cursor: 'pointer' }}>回执逐条（{rv.pairs.length} 项）</summary>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px', marginTop: 3, maxHeight: 90, overflowY: 'auto' }}>
                    {rv.pairs.slice(0, 24).map((p, i) => (
                      <span key={i} style={{ fontSize: 10, color: C.textDim }}>{p.path}=<span style={{ color: C.text }}>{p.value}</span></span>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}
        </Section>

        <VerbVerdict
          title="方案与口径来源"
          rows={[
            { verb: 'view.compose', reply: compose.reply, busy: compose.busy, onRetry: compose.resend },
            { verb: 'strike.adopt', reply: adoptReply, busy, okNote: `planState=${rv.planState ?? '—'}${rv.idempotent ? ' · 幂等' : ''}` },
          ]}
        />
      </div>

      {/* ---------------- 底：采纳 / 进入确认 ---------------- */}
      <div style={bottomStyle}>
        <div style={{ ...panel, flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 14, padding: '0 14px', height: 46 }}>
          <span style={{ fontSize: 12, color: C.textDim }}>步 {state.step}/11</span>
          <span style={{ fontSize: 12.5, color: C.text }}>{state.stepTitle || state.stepKey}</span>
          <span style={{ fontSize: 12, color: C.textDim }}>当前方案</span>
          <span data-testid="strike-current-plan" style={{ fontSize: 13, color: C.accent }}>{selected?.name ?? '—'}</span>
          {selected?.successRate !== undefined && <span style={{ fontSize: 12, color: C.textDim }}>成功率 {n2s(selected.successRate)}%</span>}
          {selected && <span style={{ fontSize: 12, color: C.textDim }}>协同 {selected.coordinationCN}</span>}
          {adoptedOk && <span data-testid="strike-adopted-flag" style={{ fontSize: 12, color: C.ok }}>已采纳</span>}
        </div>
        <button
          data-testid="btn-strike-adopt"
          style={busy || !selected ? ghostDisabled : ghostBtn}
          disabled={busy || !selected}
          onClick={() => void onAdopt()}
        >{busy ? '采纳中…' : adoptedOk ? '重新采纳' : '采纳该方案'}</button>
        <button data-testid="btn-strike-next" style={primaryBtn} onClick={onNext}>进入打击确认 ≫</button>
      </div>

      <StrikeProbe
        step={state.step}
        phase={state.phase}
        plansRaw={plans.data}
        plansReply={plans.reply}
        pv={pv}
        selectedId={selected?.id ?? null}
        targetsCount={tv.items.length}
        windowReply={winReply}
        windowRaw={winReply?.data ?? null}
        entityId={entityId}
        adoptReply={adoptReply}
        replies={flow.replies}
        lastReply={flow.lastReply}
      />
    </>
  )
}

/** 自证句柄 `window.__p5Stats`（步 8 的部分；步 9 只叠加自己的键，不覆盖这一份）。 */
function StrikeProbe(props: {
  step: number
  phase: string
  plansRaw: unknown
  plansReply: CommandReply | null
  pv: StrikePlansView
  selectedId: string | null
  targetsCount: number
  windowReply: CommandReply | null
  windowRaw: unknown
  entityId: string | null
  adoptReply: CommandReply | null
  /** 按 verb 留存的最近回执（`useFlow.replies`）——**切屏后仍读得到**，脚本据此断"按钮真的发过命令" */
  replies: Record<string, CommandReply>
  lastReply: CommandReply | null
}) {
  const { step, phase, plansRaw, plansReply, pv, selectedId, targetsCount, windowReply, windowRaw, entityId, adoptReply, replies, lastReply } = props
  const w = window as unknown as { __p5Stats?: Record<string, unknown> }
  w.__p5Stats = {
    ...(w.__p5Stats ?? {}),
    step,
    screen: 'strike',
    phase,
    /** 按 verb 的最近回执（原样：verb/code/error） */
    replies: Object.fromEntries(Object.entries(replies ?? {}).map(([k, v]) => [k, { verb: v.verb, code: v.code, message: v.error?.message ?? null }])),
    plans: {
      reply: plansReply,
      /** 回执原文（脚本用它和 DOM 卡片逐条对数） */
      raw: plansRaw ?? null,
      count: pv.plans.length,
      recommendedId: pv.recommendedId ?? null,
      recommendedPercent: pv.recommendedPercent ?? null,
      /** 逐张卡的真实取值（脚本按它断言"每张卡都有协同方式与预计分钟"） */
      rows: pv.plans.map((p) => ({
        id: p.id, name: p.name, recommended: p.recommended,
        successRate: p.successRate ?? null,
        coordination: p.coordination ?? null,
        coordinationCN: p.coordinationCN,
        coordinationSource: p.coordinationSource,
        plannedMinutes: p.plannedFinish?.minutes ?? null,
        plannedBasis: p.plannedFinish?.basis ?? null,
        plannedText: p.plannedFinish?.text ?? null,
        method: p.method ?? null,
        effect: p.effect ?? null,
        clusterCount: p.clusters.length,
        reasonsSource: p.reasonsSource,
        reasonCount: p.reasons.length,
        attackStartKey: p.attackStart?.key ?? null,
        assessRouteKey: p.assessRoute?.key ?? null,
      })),
      reasons: pv.reasons,
      notes: pv.notes,
    },
    window: { entityId, reply: windowReply, raw: windowRaw ?? null, view: readStrikeWindow(windowRaw) },
    adopt: { reply: adoptReply, view: readReceipt(adoptReply?.data) },
    lastReply: lastReply ? { verb: lastReply.verb, code: lastReply.code, message: lastReply.error?.message ?? null } : null,
    dom: {
      cards: document.querySelectorAll('[data-testid="strike-plan-card"]').length,
      recommendBadges: document.querySelectorAll('[data-testid="strike-recommend-badge"]').length,
      targetRows: document.querySelectorAll('[data-testid="strike-target-row"]').length,
      selectedId: document.querySelector('[data-testid="strike-plan-card"][data-selected="1"]')?.getAttribute('data-plan-id') ?? null,
      /** 每张卡的 data-*（脚本读它做"逐卡字段齐全"的断言） */
      cardsData: Array.from(document.querySelectorAll('[data-testid="strike-plan-card"]')).map((el) => ({
        id: el.getAttribute('data-plan-id'),
        recommended: el.getAttribute('data-plan-recommended'),
        success: el.getAttribute('data-plan-success'),
        coordination: el.getAttribute('data-plan-coordination-cn'),
        minutes: el.getAttribute('data-plan-minutes'),
        reasonSource: el.getAttribute('data-plan-reason-source'),
      })),
      coordinationTexts: Array.from(document.querySelectorAll('[data-testid="strike-plan-coordination"]')).map((el) => el.textContent),
      finishTexts: Array.from(document.querySelectorAll('[data-testid="strike-plan-finish"]')).map((el) => el.textContent),
      basisTexts: Array.from(document.querySelectorAll('[data-testid="strike-plan-finish-basis"]')).map((el) => el.textContent),
      hasAdoptBtn: !!document.querySelector('[data-testid="btn-strike-adopt"]'),
      hasNextBtn: !!document.querySelector('[data-testid="btn-strike-next"]'),
      targetsCount,
      /** 本屏**渲染那一刻**的采纳回执（切屏后仍读得到这一份快照） */
      hasAdoptReceipt: !!document.querySelector('[data-testid="strike-adopt-receipt"]'),
      adoptReceiptText: document.querySelector('[data-testid="strike-adopt-receipt"]')?.textContent ?? null,
      geometryTexts: Array.from(document.querySelectorAll('[data-testid="strike-plan-geometry"]')).map((el) => el.textContent),
    },
  }
  return null
}

// ---- 样式（一律 left/right/bottom 长写：**不写 inset 简写**，见 App.tsx 的踩坑注释）----
const leftColStyle: CSSProperties = {
  position: 'absolute', left: 12, top: 34, bottom: 170, zIndex: 20, width: 262,
  display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
}
const rightColStyle: CSSProperties = {
  position: 'absolute', right: 12, top: 34, bottom: 170, zIndex: 20, width: 306,
  display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
}
const cardsStyle: CSSProperties = {
  position: 'absolute', left: 286, right: 330, bottom: 58, zIndex: 21, height: 296,
  display: 'flex', flexDirection: 'column', minHeight: 0,
}
const bottomStyle: CSSProperties = {
  position: 'absolute', left: 12, right: 12, bottom: 6, zIndex: 21,
  display: 'flex', alignItems: 'center', gap: 10, height: 46,
}
const badgeNum: CSSProperties = {
  width: 17, height: 17, borderRadius: 5, flex: '0 0 auto', textAlign: 'center', lineHeight: '16px',
  fontSize: 11, color: C.accent, border: `1px solid ${C.border}`, background: 'rgba(95,176,255,.08)',
}
const recBadge: CSSProperties = {
  fontSize: 10.5, color: '#eaf4ff', background: 'linear-gradient(180deg,#1d4ed8,#1e3a8a)',
  border: `1px solid ${C.borderStrong}`, borderRadius: 4, padding: '0 5px', flex: '0 0 auto',
}
const primaryBtn: CSSProperties = {
  padding: '11px 24px', fontSize: 14, cursor: 'pointer', borderRadius: 8, whiteSpace: 'nowrap',
  letterSpacing: 1, border: '1px solid rgba(34,197,94,.6)',
  background: 'linear-gradient(180deg,#16a34a,#15803d)', color: '#eafff2',
}
const ghostBtn: CSSProperties = {
  padding: '11px 18px', fontSize: 13.5, cursor: 'pointer', borderRadius: 8, whiteSpace: 'nowrap',
  background: 'rgba(10,20,36,.75)', border: `1px solid ${C.borderStrong}`, color: C.text,
}
const ghostDisabled: CSSProperties = {
  padding: '11px 18px', fontSize: 13.5, cursor: 'default', borderRadius: 8, whiteSpace: 'nowrap',
  background: 'rgba(10,20,36,.5)', border: `1px solid ${C.border}`, color: C.unknown,
}

export default StrikeScreen
