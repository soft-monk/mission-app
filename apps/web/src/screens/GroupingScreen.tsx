// mission-app · apps/web/src/screens/GroupingScreen.tsx
//
// **SH-05 · 集群编组界面（无人机分组与任务编组）**
// （参考图 `需求图与描述\场景1\T1-1.png`，需求专篇 DES-APP-001 §3 SH-05）
//
// 版式照图：
//   顶 · 压条：显示模式 / 阶段 / 方案数 / 库存型数 + 回执状态
//   左 · **「无人机类型列表」**（4 张机型卡：总数量 / 可用数量 / 任务能力标签 / 已分配·待分配）
//        —— 图上它在**左侧**（Excel 说在右侧，按图）
//   中 · 「集群编组方案生成区」：**三列方案卡"浮"在地图上**，每列 = 方案标题 + 若干集群小卡，
//        集群卡内按 **光电 / 雷达 / 电子 / 通信** 四列给数量
//   右 · 「AI推荐编组方案」：推荐方案 / 推荐评分 / 推荐理由 / 预期效果 / 系统状态
//   底 · 两行：① 当前编组资源 x/y · 待分配资源 · 资源利用率 + **【查看方案详情】【自动优化】
//        【确认采用推荐方案】**；② 4 段状态卡（资源状态 / 集群数量 / 链路就绪 / AI状态）
//
// ★ 纪律：
//   · 评分/百分比/数量/总量**只能来自宿主回执**（`alloc.plans` / `alloc.inventory` / 快照）；
//     宿主没给就显示"—"并写明缺在哪，**MUST NOT 补 0、MUST NOT 编数**（图上的 124/132、86%、
//     93% 都是示意值，一律以引擎实测为准）。
//   · 「AI 推荐」标记看 `candidate.recommendedHint` 或 `recommendedId` 对上 —— 前端**不挑**推荐方案。
//   · 集群卡四列的数量来自 `situation.snapshot` 的**在册平台按型号计数**（与集群名对齐，
//     宿主目前不在这条回执里给编组量）—— 界面上如实标明口径，不冒充引擎编组量。
//   · 样式一律 `left/right/top/bottom` 长写（**不用 `inset` 简写**）。
import { useState, type CSSProperties } from 'react'
import { C, panel, panelTitle } from '../theme'
import type { FlowState } from '../api'
import type { UseFlow } from '../flow/useFlow'
import {
  n2s, readCompose, readInventory, readPlans, readSituation, replyText, sortByType,
  uavTypeCN, useVerbOnce, type Metric, type PlanView,
} from '../flow/useSituation'
import { VerbVerdict } from './VerbVerdict'
import { StageStrip } from './StageOverlay'

/** 集群卡内的**四列固定顺序**（光电 / 雷达 / 电子 / 通信，逐字来自参考图）。 */
const TYPE_COLS: { key: string; label: string }[] = [
  { key: 'optical', label: '光电' },
  { key: 'radar', label: '雷达' },
  { key: 'electronic', label: '电子' },
  { key: 'comm', label: '通信' },
]

/**
 * 取某集群在某一型上的数量。
 *
 * 只在**同名集群**（快照 groups[] ↔ 方案 clusters[]）对齐得到的数据里找 —— 找不到返回
 * `undefined`（界面显示"—"），**绝不补 0**：快照的在册平台清单可能不全，"没记录"不等于"0 架"。
 */
function mixCount(mix: PlanView['groups'][number]['mix'], col: { key: string; label: string }): number | undefined {
  const hit = mix.find((m) => uavTypeCN(m.domain) === col.label || m.domain.toLowerCase() === col.key)
  return hit?.count
}

/** 一张方案卡（= 图上的一"列"）。整列可点：选中该方案并把它带到下一屏。 */
function PlanColumn({ plan, selected, onSelect }: { plan: PlanView; selected: boolean; onSelect: () => void }) {
  const border = plan.recommended ? 'rgba(95,176,255,.85)' : selected ? C.borderStrong : C.border
  const noData = plan.groups.every((g) => !g.mix.length)
  return (
    <div
      data-testid="plan-card"
      data-plan-id={plan.id}
      data-plan-name={plan.name}
      data-plan-recommended={plan.recommended ? '1' : '0'}
      data-plan-score={plan.score !== undefined ? String(plan.score) : ''}
      onClick={onSelect}
      style={{
        flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', cursor: 'pointer',
        border: `1px solid ${border}`, borderRadius: 8,
        background: plan.recommended ? 'rgba(13,45,88,.88)' : 'rgba(8,26,48,.86)',
        boxShadow: plan.recommended ? '0 0 0 1px rgba(95,176,255,.35) inset' : undefined,
        overflow: 'hidden',
      }}
    >
      <div style={{ padding: '6px 9px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 12.5, color: C.text, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={`${plan.name}${plan.score !== undefined ? ` · 评分 ${n2s(plan.score)}` : ''}`}>
          {plan.name}
        </span>
        {plan.recommended && <span data-testid="recommend-badge" style={badgeStyle}>AI 推荐</span>}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '5px 8px 7px' }}>
        {plan.groups.map((g) => (
          <div key={g.key} data-testid="plan-group" style={groupMiniStyle}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
              <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {g.name}
              </span>
              {g.platformCount !== undefined && <span style={{ fontSize: 10.5, color: C.textDim }}>{n2s(g.platformCount)} 架</span>}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 3, marginTop: 3 }}>
              {TYPE_COLS.map((col) => {
                const n = mixCount(g.mix, col)
                return (
                  <div key={col.key} data-testid="plan-group-mix" data-mix-type={col.key}
                    style={{ textAlign: 'center', border: '1px solid rgba(95,176,255,.14)', borderRadius: 4, padding: '2px 0' }}>
                    <div style={{ fontSize: 10, color: C.textDim }}>{col.label}</div>
                    <div style={{ fontSize: 12.5, color: n === undefined ? C.unknown : C.text, fontVariantNumeric: 'tabular-nums' }}>
                      {n2s(n)}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
        {!plan.groups.length && (
          <div style={{ fontSize: 11, color: C.textDim, padding: '6px 0', lineHeight: 1.6 }}>
            该方案未给出集群清单（`alloc.plans` 的 `candidate.clusters[]`）
          </div>
        )}
        {noData && plan.groups.length > 0 && (
          <div style={{ fontSize: 10.5, color: C.warn, paddingTop: 3, lineHeight: 1.6 }}>
            四型数量取不到：快照里没有与这些集群同名的在册平台（配比按 `situation.snapshot` 对齐）
          </div>
        )}
      </div>

      <div style={{ padding: '4px 8px', borderTop: `1px solid ${C.border}`, display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 11 }}>
        <span style={{ color: C.textDim }}>评分</span>
        <span data-testid="plan-score" style={{ color: C.accent, fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
          {n2s(plan.score)}
        </span>
        {plan.rank !== undefined && <span style={{ color: C.textDim }}>排名 {n2s(plan.rank)}</span>}
        <span style={{ flex: 1 }} />
        {plan.successRate !== undefined && <span style={{ color: C.textDim }}>成功率 {n2s(plan.successRate)}%</span>}
      </div>
    </div>
  )
}

/** 底部状态卡（图上第二行那 4 张）。值取不到 → "—" + 原因，**不编**。 */
function StatusCard({ label, value, sub, tone, testid }: {
  label: string; value: string; sub?: string; tone?: string; testid: string
}) {
  return (
    <div data-testid={testid} style={{ ...panel, flex: 1, minWidth: 0, padding: '6px 12px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3 }}>
      <div style={{ fontSize: 11.5, color: C.textDim }}>{label}</div>
      <div style={{ fontSize: 14.5, color: tone ?? C.text, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontSize: 10.5, color: C.textDim }}>{sub}</div>}
    </div>
  )
}

export function GroupingScreen({ state, flow, onNext, onSelectPlan, onGo }: {
  state: FlowState
  flow: UseFlow
  /** 【查看方案详情】/【确认采用推荐方案】→ 把选中的方案带到步 5（切步由宿主 flow.goto 决定） */
  onNext?: (planId: string | null) => void
  /** 卡片被点选：把选择带到步 5（步 5 的"当前方案"要跟过来） */
  onSelectPlan: (planId: string) => void
  /** 切到另一屏（只改本地屏路由）—— 需求专篇 SH-05 → SH-06 */
  onGo?: (id: string) => void
}) {
  const snap = useVerbOnce(flow, 'situation.snapshot', {}, true)
  const plans = useVerbOnce(flow, 'alloc.plans', { side: 'group', count: 3 }, true)
  const inv = useVerbOnce(flow, 'alloc.inventory', {}, true)
  const compose = useVerbOnce(flow, 'view.compose', { phase: state.phase || 'T1' }, true)

  const sit = readSituation(snap.data)
  const pv = readPlans(plans.data, sit.groups)
  const iv = readInventory(inv.data)
  const cmp = readCompose(compose.data)

  const [picked, setPicked] = useState<string | null>(null)
  const selectedId = picked ?? (pv.plans.find((p) => p.recommended)?.id ?? pv.plans[0]?.id ?? null)
  const pick = (id: string) => { setPicked(id); onSelectPlan(id) }

  const recPlan = pv.plans.find((p) => p.id === pv.recommendedId) ?? pv.plans.find((p) => p.recommended)
  const selPlan = pv.plans.find((p) => p.id === selectedId)
  const effects = selPlan?.effects ?? []
  const invRows = sortByType(iv.rows)

  // 底部第一行的三个数：**按 key 从台账 totals 里取**，缺了就"—"（标签是图上的逐字，值必须是真值）
  const totalOf = (key: string): Metric | undefined => iv.totals.find((t) => t.key === key)
  const grouped = totalOf('grouped')
  const pending = totalOf('pending')
  const util = totalOf('utilization')
  const online = totalOf('onlineRate')

  // 底部第二行 4 张状态卡的真值来源
  const clusterCount = iv.totals.find((t) => t.key === 'clusters')
  const linkMetric = selPlan?.effects.find((e) => /链路/.test(e.name))
  const aiSlot = (state.statusBar ?? []).find((b) => b.key === 'ai') ?? (state.systemOverview ?? []).find((o) => o.key === 'ai')
  const tagCount = invRows.reduce((a, r) => a + r.tags.length, 0)

  /** 「查看方案详情」/「确认采用推荐方案」：把选择交给宿主，再切到方案确认屏（SH-06）。 */
  const toConfirm = () => {
    onNext?.(selectedId)
    onGo?.('SH-06')
  }

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

      {/* ---------------- 左：无人机类型列表（图上在**左侧**）---------------- */}
      <div style={leftColStyle}>
        <div style={{ ...panel, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={panelTitle}>
            无人机类型列表
            <span style={{ float: 'right', fontSize: 11, color: C.textDim }}
              title="总数量/可用数量/已分配/待分配/任务能力标签全部来自 alloc.inventory.items[]">ⓘ</span>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 9px 9px' }}>
            {invRows.map((r) => (
              <div key={r.key} data-testid="inv-row" style={invRowStyle}
                title={`alloc.inventory.items[].type=${r.key}${r.onlineRate !== undefined ? ` · 在线率 ${n2s(r.onlineRate)}%` : ''}`}>
                <div style={{ fontSize: 12.5, color: C.text }}>{r.name}</div>
                <div style={{ display: 'flex', gap: 10, marginTop: 3, fontSize: 11.5, color: C.textDim, fontVariantNumeric: 'tabular-nums' }}>
                  <span>总数量 <b style={{ color: C.text }}>{n2s(r.total)}</b></span>
                  <span>可用数量 <b style={{ color: C.text }}>{n2s(r.available)}{r.unit ?? ''}</b></span>
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 10.5, color: C.textDim }}>任务能力</span>
                  {r.tags.length > 0
                    ? r.tags.map((t) => (
                      <span key={t} data-testid="inv-tag" style={{ fontSize: 10.5, color: C.accentDim, border: `1px solid ${C.border}`, borderRadius: 4, padding: '0 5px' }}>{t}</span>
                    ))
                    : <span style={{ fontSize: 10.5, color: C.unknown }}>—（回执无 abilityTags）</span>}
                </div>
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

      {/* ---------------- 中：三列方案卡（浮在地图上）---------------- */}
      <div style={centerStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 9px', marginBottom: 6, borderRadius: 6, background: 'rgba(4,24,47,.84)' }}>
          <span style={{ fontSize: 13, color: C.text, letterSpacing: 0.5 }}>集群编组方案生成区</span>
          <span data-testid="plan-count" style={{ fontSize: 11.5, color: C.accent }}>方案 {pv.plans.length}</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 10.5, color: C.textDim }}>
            四列数量 = 快照在册平台按型号计数（与集群名对齐；不是引擎编组量）
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'stretch', flex: 1, minHeight: 0 }}>
          {pv.plans.map((p) => (
            <PlanColumn key={p.id} plan={p} selected={p.id === selectedId} onSelect={() => pick(p.id)} />
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
              <div style={{ fontSize: 12, color: C.textDim, marginBottom: 3 }}>
                推荐理由（{pv.reasons.length} 条 · alloc.plans.reasons[]）
              </div>
              {pv.reasons.length > 0
                ? pv.reasons.map((r, i) => (
                  <div key={i} data-testid="recommend-reason" style={{ fontSize: 11.5, color: C.text, lineHeight: 1.7 }}>· {r}</div>
                ))
                : <div style={{ fontSize: 11.5, color: C.textDim }}>—（宿主未给出推荐理由）</div>}
            </div>
          </div>
        </div>

        <div style={{ ...panel }}>
          <div style={panelTitle}>
            预期效果
            <span style={{ float: 'right', fontSize: 11, color: C.textDim }}>
              {selPlan?.name ?? '—'}{selPlan?.recommended ? ' · 推荐' : ''}
            </span>
          </div>
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
                —（预期效果未就绪：来自选中方案 `score.metrics[]`，宿主未给出）
              </div>
            )}
            <div style={{ fontSize: 10.5, color: C.textDim, marginTop: 5, lineHeight: 1.6 }}>
              点左侧任意一列方案卡 → 本块换成该方案的评分/理由/预期效果（图上的交互）
            </div>
          </div>
        </div>

        {/* 系统状态：图上 4 条。**每一条都必须有回执兜底** —— 没有证据的就不打勾 */}
        <div style={{ ...panel }}>
          <div style={panelTitle}>系统状态</div>
          <div style={{ padding: '6px 12px 8px' }}>
            <SysRow
              label={`系统自动完成资源注册与能力识别`}
              ok={inv.reply?.code === 0}
              value={inv.reply?.code === 0
                ? `${iv.rows.length} 型 · 能力标签 ${tagCount} 条`
                : (inv.sent ? `alloc.inventory → ${replyText(inv.reply)}` : '读取中…')}
              testid="sh05-sys-row"
            />
            <SysRow
              label={`已完成百架级无人机资源分配`}
              ok={!!grouped}
              value={grouped ? `台账 ${grouped.text ?? n2s(grouped.value)}` : '—（alloc.inventory 未给 allocatedTotal/totalAll）'}
              testid="sh05-sys-row"
            />
            <SysRow
              label={`已生成 ${pv.plans.length || '—'} 套任务编组方案`}
              ok={pv.plans.length > 0}
              value={pv.plans.length > 0 ? `alloc.plans 返回 ${pv.plans.length} 个候选` : '—（alloc.plans 未返回候选）'}
              testid="sh05-sys-row"
            />
            <SysRow
              label="推荐方案已高亮显示"
              ok={!!(pv.recommendedId ?? recPlan)}
              value={pv.recommendedId ? `recommendedId=${pv.recommendedId}` : (recPlan ? `recommendedHint → ${recPlan.id}` : '—（回执未标推荐）')}
              testid="sh05-sys-row"
            />
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

      {/* ---------------- 底部第一行：三个台账读数 + 三个动作 ---------------- */}
      <div style={bottomRow1Style}>
        <div style={{ ...panel, flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 18, padding: '0 14px' }}>
          <LedgerStat name="当前编组资源" m={grouped} fallback="—" />
          <LedgerStat name="待分配资源" m={pending} />
          <LedgerStat name="资源利用率" m={util} showBar />
        </div>
        <button data-testid="btn-plan-detail" style={ghostBtn} onClick={toConfirm}>查看方案详情</button>
        <button
          data-testid="sh05-auto-optimize"
          style={{ ...ghostBtn, color: C.unknown }}
          disabled
          title="自动优化：宿主尚未提供该 verb（无 verb 可发，故灰置）"
        >自动优化</button>
        <button data-testid="btn-adopt-recommended" style={primaryBtn} onClick={toConfirm}>确认采用推荐方案</button>
      </div>

      {/* ---------------- 底部第二行：4 段状态卡 ---------------- */}
      <div style={bottomRow2Style}>
        <StatusCard
          testid="sh05-status-card"
          label="资源状态"
          value={grouped?.text ?? (grouped?.value !== undefined ? n2s(grouped.value) : '—')}
          sub={online ? `在线率 ${n2s(online.value)}${online.unit ?? '%'}` : (grouped ? '台账 alloc.inventory（未给在线率）' : '台账读数缺失')}
          tone={grouped ? C.ok : C.unknown}
        />
        <StatusCard
          testid="sh05-status-card"
          label="集群数量"
          value={clusterCount?.value !== undefined ? `${n2s(clusterCount.value)} 个` : (selPlan ? `${selPlan.clusters.length} 个` : '—')}
          sub={clusterCount ? (clusterCount.text ?? '已编组') : '台账尚无集群 → 显示选中方案的集群数'}
        />
        <StatusCard
          testid="sh05-status-card"
          label="链路就绪"
          value={linkMetric?.value !== undefined ? `${n2s(linkMetric.value)}${linkMetric.unit ?? ''}` : '—'}
          sub={linkMetric ? `引擎键 ${linkMetric.key}（${linkMetric.name}）` : '引擎未给出该指标（链路评估腿未接）'}
          tone={linkMetric?.value !== undefined ? C.accent : C.unknown}
        />
        <StatusCard
          testid="sh05-status-card"
          label="AI状态"
          value={aiSlot ? (aiSlot.text || aiSlot.status) : '—'}
          sub={aiSlot ? `status=${aiSlot.status}` : '宿主 /api/state 未给出 ai 槽位'}
          tone={aiSlot ? C.ok : C.unknown}
        />
      </div>

      <GroupingProbe
        plansRaw={plans.data}
        inventoryRaw={inv.data}
        reasonsRendered={pv.reasons.length}
        selectedId={selectedId}
      />
    </>
  )
}

/** 系统状态的一行：绿勾只在**有回执证据**时出现，否则给"— + 原因"。 */
function SysRow({ label, ok, value, testid }: { label: string; ok: boolean; value: string; testid: string }) {
  return (
    <div data-testid={testid} data-ok={ok ? '1' : '0'} style={{ display: 'flex', gap: 6, padding: '3px 0', alignItems: 'flex-start' }}>
      <span style={{ color: ok ? C.ok : C.warn, flex: '0 0 auto', fontSize: 11.5 }}>{ok ? '✓' : '·'}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 11.5, color: C.text }}>{label}</span>
        <span style={{ display: 'block', fontSize: 10.5, color: ok ? C.textDim : C.warn, lineHeight: 1.6 }}>{value}</span>
      </span>
    </div>
  )
}

/** 底部台账读数（当前编组资源 / 待分配资源 / 资源利用率）。缺 → "—"。 */
function LedgerStat({ name, m, fallback, showBar }: { name: string; m?: Metric; fallback?: string; showBar?: boolean }) {
  const v = m?.value !== undefined ? `${n2s(m.value)}${m.unit ?? ''}` : (m?.text ?? fallback ?? '—')
  const pct = m?.value !== undefined && m.unit === '%' ? Math.max(0, Math.min(100, m.value)) : undefined
  return (
    <span data-testid="inv-total" data-stat-key={m?.key ?? ''} style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12, minWidth: 0 }}>
      <span style={{ color: C.textDim, whiteSpace: 'nowrap' }}>{name}</span>
      <span style={{ color: m ? C.text : C.unknown, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{v}</span>
      {showBar && pct !== undefined && (
        <span style={{ width: 92, height: 6, borderRadius: 3, background: 'rgba(95,176,255,.16)', overflow: 'hidden' }}>
          <span style={{ display: 'block', width: `${pct}%`, height: '100%', background: C.bar }} />
        </span>
      )}
    </span>
  )
}

/** 自证句柄（SH-05 的部分）：把**宿主回执原样**挂到 window 上供脚本断言。 */
function GroupingProbe({ plansRaw, inventoryRaw, reasonsRendered, selectedId }: {
  plansRaw: unknown
  inventoryRaw: unknown
  reasonsRendered: number
  selectedId: string | null
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
      selectedId,
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
      invTags: document.querySelectorAll('[data-testid="inv-tag"]').length,
      planGroups: document.querySelectorAll('[data-testid="plan-group"]').length,
      mixCells: document.querySelectorAll('[data-testid="plan-group-mix"]').length,
      sysRows: document.querySelectorAll('[data-testid="sh05-sys-row"]').length,
      statusCards: document.querySelectorAll('[data-testid="sh05-status-card"]').length,
      hasAutoOptimize: !!document.querySelector('[data-testid="sh05-auto-optimize"]'),
    },
  }
  return null
}

// ---- 样式（left/right/bottom 长写，**不用 inset 简写**）----
const leftColStyle: CSSProperties = {
  position: 'absolute', left: 12, top: 34, bottom: 176, zIndex: 20, width: 224,
  display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0,
}
const centerStyle: CSSProperties = {
  position: 'absolute', left: 248, right: 300, top: 34, bottom: 176, zIndex: 20,
  display: 'flex', flexDirection: 'column', minHeight: 0,
}
const rightColStyle: CSSProperties = {
  position: 'absolute', right: 12, top: 34, bottom: 176, zIndex: 20, width: 276,
  display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto',
}
const bottomRow1Style: CSSProperties = {
  position: 'absolute', left: 12, right: 12, bottom: 104, zIndex: 21,
  display: 'flex', alignItems: 'center', gap: 10, height: 60,
}
const bottomRow2Style: CSSProperties = {
  position: 'absolute', left: 12, right: 12, bottom: 36, zIndex: 21,
  display: 'flex', alignItems: 'stretch', gap: 10, height: 60,
}
const invRowStyle: CSSProperties = {
  border: `1px solid ${C.border}`, borderRadius: 7, background: 'rgba(10,32,58,.55)',
  padding: '6px 9px', marginBottom: 7,
}
const groupMiniStyle: CSSProperties = {
  border: '1px solid rgba(95,176,255,.16)', borderRadius: 6, background: 'rgba(6,22,42,.72)',
  padding: '4px 6px', marginBottom: 5,
}
const badgeStyle: CSSProperties = {
  fontSize: 10.5, color: '#eaf4ff', background: 'linear-gradient(180deg,#16a34a,#15803d)',
  border: '1px solid rgba(34,197,94,.6)', borderRadius: 4, padding: '0 5px', flex: '0 0 auto',
}
const chipAssigned: CSSProperties = {
  fontSize: 10.5, color: C.accent, border: `1px solid ${C.border}`, borderRadius: 4, padding: '0 5px',
}
const chipPending: CSSProperties = {
  fontSize: 10.5, color: C.warn, border: '1px solid rgba(245,158,11,.4)', borderRadius: 4, padding: '0 5px',
}
const ghostBtn: CSSProperties = {
  padding: '9px 14px', fontSize: 13, cursor: 'pointer', borderRadius: 8, whiteSpace: 'nowrap',
  background: 'rgba(10,20,36,.85)', border: `1px solid ${C.borderStrong}`, color: C.text,
}
const primaryBtn: CSSProperties = {
  padding: '9px 16px', fontSize: 13.5, cursor: 'pointer', borderRadius: 8, whiteSpace: 'nowrap',
  border: '1px solid rgba(34,197,94,.6)', background: 'linear-gradient(180deg,#16a34a,#15803d)',
  color: '#eafff2', letterSpacing: 0.5,
}

export default GroupingScreen
