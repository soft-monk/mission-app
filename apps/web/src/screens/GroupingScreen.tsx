// mission-app · apps/web/src/screens/GroupingScreen.tsx
//
// Excel 步 4 · 无人机分组与任务编组（参考图 `T1-1.png`）。
//
// 四块内容，按参考图的位置摆在地图之上：
//   顶 · 压条：显示模式 / 阶段 / 方案数 / 库存型数
//   左 · 无人机类型列表（`alloc.inventory.items[]`：总数/可用/已分配/待分配/能力标签）
//   中 · 三张方案卡（`alloc.plans.items[].candidate` + `.score`，**原样**）
//   右 · AI 推荐编组方案（`recommendedId/recommendedPercent/leadOverNextPercent/reasons`）
//         + 推荐方案的预期效果（`score.metrics[].raw`，即规则包的 6 项指标）
//   底 · 台账信息条（`allocatedTotal/totalAll/utilization/onlineRate/clusters`）+ 三个动作
//
// ★ 纪律：
//   · 评分/百分比/数量**只能来自宿主回执**；宿主没给就显示"—"或整块不画。
//   · 「AI 推荐」标记看 `candidate.recommendedHint` 或 `recommendedId` 对上——前端**不挑**推荐方案。
//   · 集群组成（四型配比）来自 `situation.snapshot.groups[].byType`（按**平台型号计数**，
//     不是引擎的编组量）：界面会标明它是"在册平台按型号"，不冒充编组量。
import { useState, type CSSProperties } from 'react'
import { C, panel, panelTitle } from '../theme'
import type { FlowState } from '../api'
import type { UseFlow } from '../flow/useFlow'
import {
  n2s, replyText, sortByType, useVerbOnce,
  readCompose, readInventory, readPlans, readSituation, type PlanView,
} from '../flow/useSituation'
import { VerbVerdict } from './VerbVerdict'
import { StageStrip } from './StageOverlay'

/** 集群的四型组成（数量 + 占比）。数值缺失显示"—"。 */
function MixRow({ mix }: { mix: PlanView['groups'][number]['mix'] }) {
  if (!mix.length) return <span style={{ fontSize: 11, color: C.textDim }}>配比：在册平台里无同名集群</span>
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 7 }}>
      {mix.map((m) => (
        <span key={m.domain} style={{ fontSize: 11, color: C.textDim, whiteSpace: 'nowrap' }}>
          {m.label}
          <span style={{ color: C.text, marginLeft: 3, fontVariantNumeric: 'tabular-nums' }}>{n2s(m.count)}</span>
          {m.percent !== undefined && <span style={{ color: C.accentDim, marginLeft: 3 }}>({n2s(m.percent)}%)</span>}
        </span>
      ))}
    </span>
  )
}

/** 一张方案卡。 */
function PlanCard({ plan, selected, onSelect }: { plan: PlanView; selected: boolean; onSelect: () => void }) {
  const border = plan.recommended ? 'rgba(95,176,255,.85)' : selected ? C.borderStrong : C.border
  return (
    <div
      data-testid="plan-card"
      data-plan-id={plan.id}
      data-plan-name={plan.name}
      data-plan-recommended={plan.recommended ? '1' : '0'}
      data-plan-score={plan.score !== undefined ? String(plan.score) : ''}
      onClick={onSelect}
      style={{
        width: 214, flex: '0 0 auto', display: 'flex', flexDirection: 'column', cursor: 'pointer',
        border: `1px solid ${border}`, borderRadius: 8,
        background: plan.recommended ? 'rgba(29,78,216,.16)' : 'rgba(10,32,58,.55)',
        boxShadow: plan.recommended ? '0 0 0 1px rgba(95,176,255,.35) inset' : undefined,
        overflow: 'hidden',
      }}
    >
      <div style={{ padding: '6px 9px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 12.5, color: C.text, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {plan.name}
        </span>
        {plan.recommended && <span data-testid="recommend-badge" style={badgeStyle}>AI 推荐</span>}
      </div>

      <div style={{ padding: '4px 9px 0', display: 'flex', gap: 10, alignItems: 'baseline' }}>
        {plan.score !== undefined && (
          <span data-testid="plan-score" style={{ fontSize: 15, color: C.accent, fontVariantNumeric: 'tabular-nums' }}>
            {n2s(plan.score)}
          </span>
        )}
        {plan.rank !== undefined && <span style={{ fontSize: 11, color: C.textDim }}>排名 {plan.rank}</span>}
        {plan.successRate !== undefined && <span style={{ fontSize: 11, color: C.textDim }}>成功率 {n2s(plan.successRate)}%</span>}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 9px 7px' }}>
        {plan.method && <div style={{ fontSize: 11.5, color: C.text, margin: '2px 0' }}>方式：{plan.method}</div>}
        {plan.effect && <div style={{ fontSize: 11.5, color: C.textDim }}>预期：{plan.effect}</div>}
        {plan.groups.map((g) => (
          <div key={g.key} data-testid="plan-group" style={{ borderTop: '1px solid rgba(95,176,255,.12)', padding: '4px 0' }}>
            <div style={{ fontSize: 11.5, color: C.text, display: 'flex', gap: 6 }}>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.name}</span>
              {g.platformCount !== undefined && <span style={{ color: C.textDim }}>{n2s(g.platformCount)} 架</span>}
            </div>
            <MixRow mix={g.mix} />
          </div>
        ))}
        {!plan.groups.length && (
          <div style={{ fontSize: 11, color: C.textDim, padding: '6px 0' }}>该方案未给出集群清单</div>
        )}
      </div>
    </div>
  )
}

export function GroupingScreen({ state, flow, onNext, onSelectPlan }: {
  state: FlowState
  flow: UseFlow
  /** 【查看方案详情】/【确认采用推荐方案】→ 步 5（切步由宿主 flow.goto 决定） */
  onNext: (planId: string | null) => void
  /** 卡片被点选：把选择带到步 5（步 5 的"当前方案"要跟过来） */
  onSelectPlan: (planId: string) => void
}) {
  const snap = useVerbOnce(flow, 'situation.snapshot', {}, true)
  const plans = useVerbOnce(flow, 'alloc.plans', { side: 'group', count: 3 }, true)
  const inv = useVerbOnce(flow, 'alloc.inventory', {}, true)
  const compose = useVerbOnce(flow, 'view.compose', { phase: state.phase || 'T1' }, true)

  // 集群组成来自快照（同名对齐）；快照没回来就先不显示配比，**不补 0**
  const sit = readSituation(snap.data)
  const pv = readPlans(plans.data, sit.groups)
  const iv = readInventory(inv.data)
  const cmp = readCompose(compose.data)

  const [picked, setPicked] = useState<string | null>(null)
  const selectedId = picked ?? (pv.plans.find((p) => p.recommended)?.id ?? pv.plans[0]?.id ?? null)
  const pick = (id: string) => { setPicked(id); onSelectPlan(id) }

  const recPlan = pv.plans.find((p) => p.id === pv.recommendedId) ?? pv.plans.find((p) => p.recommended)
  const effects = (recPlan ?? pv.plans.find((p) => p.id === selectedId))?.effects ?? []
  const invRows = sortByType(iv.rows)

  return (
    <>
      {/* ---------------- 顶部压条 ---------------- */}
      <StageStrip
        items={[
          { k: '显示模式', v: cmp.modeName ?? cmp.modeKey ?? '—', color: C.accent },
          { k: '阶段', v: state.phase || '—' },
          { k: '方案', v: `${pv.plans.length} 个` },
          { k: '库存', v: `${iv.rows.length} 型` },
        ]}
        right={<span style={{ color: plans.reply?.code === 0 ? C.ok : C.warn }}>
          {plans.reply === null
            ? '方案读取中…'
            : plans.reply.code === 0
              ? `方案来自 alloc.plans（推荐 ${n2s(pv.recommendedPercent)}%）`
              : `alloc.plans：${replyText(plans.reply)}`}
        </span>}
      />

      {/* ---------------- 左：无人机类型列表（库存视图） ---------------- */}
      <div style={leftColStyle}>
        <div style={{ ...panel, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={panelTitle}>无人机类型列表</div>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 9px 9px' }}>
            {invRows.map((r) => (
              <div key={r.key} data-testid="inv-row" style={invRowStyle}>
                <div style={{ fontSize: 12.5, color: C.text }}>{r.name}</div>
                <div style={{ display: 'flex', gap: 10, marginTop: 3, fontSize: 11.5, color: C.textDim, fontVariantNumeric: 'tabular-nums' }}>
                  <span>总数 <b style={{ color: C.text }}>{n2s(r.total)}</b></span>
                  <span>可用 <b style={{ color: C.text }}>{n2s(r.available)}{r.unit ?? ''}</b></span>
                </div>
                {r.tags.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                    {r.tags.map((t) => (
                      <span key={t} style={{ fontSize: 10.5, color: C.accentDim, border: `1px solid ${C.border}`, borderRadius: 4, padding: '0 5px' }}>{t}</span>
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 5 }}>
                  <span style={chipAssigned}>已分配 {n2s(r.assigned)}</span>
                  <span style={chipPending}>待分配 {n2s(r.unassigned)}</span>
                </div>
              </div>
            ))}
            {!invRows.length && (
              <div style={{ fontSize: 12, color: C.textDim, padding: '10px 2px', lineHeight: 1.7 }}>
                库存未就绪
                {inv.sent && inv.reply && inv.reply.code !== 0 && (
                  <div style={{ color: C.warn, marginTop: 4 }}>{replyText(inv.reply)}</div>
                )}
              </div>
            )}
          </div>
        </div>

        <VerbVerdict
          rows={[
            { verb: 'alloc.inventory', reply: inv.reply, busy: inv.busy, onRetry: inv.resend, okNote: `${iv.rows.length} 型` },
            { verb: 'view.compose', reply: compose.reply, busy: compose.busy, onRetry: compose.resend },
          ]}
        />
      </div>

      {/* ---------------- 中：三张方案卡 ---------------- */}
      <div style={centerStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 2px 6px' }}>
          <span style={{ fontSize: 13, color: C.text, letterSpacing: 0.5 }}>集群编组方案生成区</span>
          <span data-testid="plan-count" style={{ fontSize: 11.5, color: C.accent }}>方案 {pv.plans.length}</span>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'stretch', flex: 1, minHeight: 0, overflowX: 'auto' }}>
          {pv.plans.map((p) => (
            <PlanCard key={p.id} plan={p} selected={p.id === selectedId} onSelect={() => pick(p.id)} />
          ))}
          {!pv.plans.length && (
            <div style={{ ...panel, flex: 1, padding: 13, fontSize: 12.5, color: C.textDim, lineHeight: 1.9 }}>
              <div>方案未就绪：宿主还没有返回候选方案。</div>
              {plans.sent && plans.reply && plans.reply.code !== 0 && (
                <div style={{ color: C.warn }}>alloc.plans → {replyText(plans.reply)}</div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ---------------- 右：AI 推荐编组方案 ---------------- */}
      <div style={rightColStyle}>
        <div style={{ ...panel }}>
          <div style={panelTitle}>AI 推荐编组方案</div>
          <div style={{ padding: '7px 12px 9px' }}>
            <div style={{ fontSize: 12.5, color: C.text }}>
              推荐方案：<b>{recPlan?.name ?? '—'}</b>
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 5 }}>
              <span style={{ fontSize: 12, color: C.textDim }}>推荐评分</span>
              <span data-testid="recommend-percent" style={{ fontSize: 20, color: C.ok, fontVariantNumeric: 'tabular-nums' }}>
                {pv.recommendedPercent !== undefined ? `${n2s(pv.recommendedPercent)}%` : '—'}
              </span>
              <span style={{ fontSize: 11.5, color: C.textDim }}>
                领先次优 {pv.leadOverNextPercent !== undefined ? `${n2s(pv.leadOverNextPercent)}%` : '—'}
                {pv.nextId ? `（次优 ${pv.nextId} ${n2s(pv.nextPercent)}%）` : ''}
              </span>
            </div>

            <div style={{ marginTop: 7, borderTop: `1px solid ${C.border}`, paddingTop: 5 }}>
              <div style={{ fontSize: 12, color: C.textDim, marginBottom: 3 }}>推荐理由</div>
              {pv.reasons.length > 0
                ? pv.reasons.map((r, i) => (
                  <div key={i} data-testid="recommend-reason" style={{ fontSize: 11.5, color: C.text, lineHeight: 1.7 }}>· {r}</div>
                ))
                : <div style={{ fontSize: 11.5, color: C.textDim }}>宿主未给出推荐理由</div>}
            </div>
          </div>
        </div>

        <div style={{ ...panel }}>
          <div style={panelTitle}>预期效果（{recPlan?.name ?? '推荐方案'}）</div>
          <div style={{ padding: '7px 12px 9px' }}>
            {effects.length > 0 ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 10px' }}>
                {effects.map((e) => (
                  <div key={e.key} data-testid="effect-item" style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: '5px 8px' }}>
                    <div style={{ fontSize: 11, color: C.textDim }}>{e.name}</div>
                    <div style={{ fontSize: 16, color: C.accent, fontVariantNumeric: 'tabular-nums' }}>
                      {e.value !== undefined ? `${n2s(e.value)}${e.unit ?? ''}` : '—'}
                    </div>
                    {e.text && <div style={{ fontSize: 10, color: C.warn }}>{e.text}</div>}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 11.5, color: C.textDim, lineHeight: 1.7 }}>
                预期效果未就绪（来自推荐方案的 score.metrics）
              </div>
            )}
          </div>
        </div>

        <VerbVerdict
          title="方案与口径来源"
          rows={[{ verb: 'alloc.plans', reply: plans.reply, busy: plans.busy, onRetry: plans.resend, okNote: `${pv.plans.length} 个方案` }]}
        />
        {pv.missingInputs.length > 0 && (
          <div style={{ ...panel, padding: '7px 10px', fontSize: 11, color: C.warn, lineHeight: 1.6 }}>
            采集口径提示：{pv.missingInputs.join('；')}
          </div>
        )}
      </div>

      {/* ---------------- 底部：台账信息条 + 三个动作 ---------------- */}
      <div style={bottomStyle}>
        <div style={{ ...panel, flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 16, padding: '0 14px' }}>
          {iv.totals.length > 0
            ? iv.totals.slice(0, 6).map((t) => (
              <span key={t.key} data-testid="inv-total" style={{ display: 'inline-flex', gap: 6, alignItems: 'baseline', fontSize: 12 }}>
                <span style={{ color: C.textDim }}>{t.name}</span>
                <span style={{ color: C.text, fontVariantNumeric: 'tabular-nums' }}>
                  {t.value !== undefined ? n2s(t.value, t.unit ?? '') : (t.text ?? '—')}
                </span>
                {t.text && t.value !== undefined && <span style={{ color: C.textDim, fontSize: 11 }}>{t.text}</span>}
              </span>
            ))
            : (
              <span style={{ fontSize: 12, color: C.textDim }}>
                编组资源信息条未就绪（alloc.inventory）
              </span>
            )}
        </div>
        <button data-testid="btn-plan-detail" style={ghostBtn} onClick={() => onNext(selectedId)}>查看方案详情</button>
        <button style={ghostBtn} disabled title="自动优化：宿主尚未提供该 verb">自动优化</button>
        <button data-testid="btn-adopt-recommended" style={primaryBtn} onClick={() => onNext(selectedId)}>确认采用推荐方案</button>
      </div>

      <GroupingProbe plansRaw={plans.data} inventoryRaw={inv.data} reasonsRendered={pv.reasons.length} />
    </>
  )
}

/** 自证句柄（步 4 的部分）：把**宿主回执原样**挂到 window 上供脚本断言。 */
function GroupingProbe({ plansRaw, inventoryRaw, reasonsRendered }: {
  plansRaw: unknown
  inventoryRaw: unknown
  reasonsRendered: number
}) {
  const w = window as unknown as { __p3Stats?: Record<string, unknown> }
  const pv = readPlans(plansRaw)
  w.__p3Stats = {
    ...(w.__p3Stats ?? {}),
    step: 4,
    screen: 'grouping',
    plans: {
      data: plansRaw ?? null,
      count: pv.plans.length,
      recommendedId: pv.recommendedId ?? null,
      recommendedPercent: pv.recommendedPercent ?? null,
      leadOverNextPercent: pv.leadOverNextPercent ?? null,
      reasons: pv.reasons,
      reasonsRendered,
      names: pv.plans.map((p) => p.name),
      scores: pv.plans.map((p) => p.score ?? null),
      clustersPerPlan: pv.plans.map((p) => p.clusters.length),
      recommendedFlags: pv.plans.map((p) => p.recommended),
      effectsOfRecommended: (pv.plans.find((p) => p.id === pv.recommendedId) ?? pv.plans[0])?.effects.map((e) => ({ name: e.name, value: e.value })),
    },
    inventory: { data: inventoryRaw ?? null, rows: readInventory(inventoryRaw).rows.length },
    dom: {
      planCards: document.querySelectorAll('[data-testid="plan-card"]').length,
      recommendBadges: document.querySelectorAll('[data-testid="recommend-badge"]').length,
      recommendReasons: document.querySelectorAll('[data-testid="recommend-reason"]').length,
      effectItems: document.querySelectorAll('[data-testid="effect-item"]').length,
      invRows: document.querySelectorAll('[data-testid="inv-row"]').length,
      planGroups: document.querySelectorAll('[data-testid="plan-group"]').length,
    },
  }
  return null
}

// ---- 样式（left/right/bottom 长写，**不用 inset 简写**）----
const leftColStyle: CSSProperties = {
  position: 'absolute', left: 12, top: 34, bottom: 150, zIndex: 20, width: 240,
  display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0,
}
const centerStyle: CSSProperties = {
  position: 'absolute', left: 262, right: 316, top: 34, bottom: 150, zIndex: 20,
  display: 'flex', flexDirection: 'column', minHeight: 0,
}
const rightColStyle: CSSProperties = {
  position: 'absolute', right: 12, top: 34, bottom: 150, zIndex: 20, width: 292,
  display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto',
}
const bottomStyle: CSSProperties = {
  position: 'absolute', left: 12, right: 12, bottom: 36, zIndex: 21,
  display: 'flex', alignItems: 'center', gap: 10, height: 104,
}
const invRowStyle: CSSProperties = {
  border: `1px solid ${C.border}`, borderRadius: 7, background: 'rgba(10,32,58,.55)',
  padding: '6px 9px', marginBottom: 7,
}
const badgeStyle: CSSProperties = {
  fontSize: 10.5, color: '#eaf4ff', background: 'linear-gradient(180deg,#1d4ed8,#1e3a8a)',
  border: `1px solid ${C.borderStrong}`, borderRadius: 4, padding: '0 5px', flex: '0 0 auto',
}
const chipAssigned: CSSProperties = {
  fontSize: 10.5, color: C.accent, border: `1px solid ${C.border}`, borderRadius: 4, padding: '0 5px',
}
const chipPending: CSSProperties = {
  fontSize: 10.5, color: C.warn, border: '1px solid rgba(245,158,11,.4)', borderRadius: 4, padding: '0 5px',
}
const ghostBtn: CSSProperties = {
  padding: '9px 16px', fontSize: 13, cursor: 'pointer', borderRadius: 8, whiteSpace: 'nowrap',
  background: 'rgba(10,20,36,.75)', border: `1px solid ${C.borderStrong}`, color: C.text,
}
const primaryBtn: CSSProperties = {
  padding: '9px 18px', fontSize: 13.5, cursor: 'pointer', borderRadius: 8, whiteSpace: 'nowrap',
  border: '1px solid rgba(34,197,94,.6)', background: 'linear-gradient(180deg,#16a34a,#15803d)',
  color: '#eafff2', letterSpacing: 0.5,
}

export default GroupingScreen
