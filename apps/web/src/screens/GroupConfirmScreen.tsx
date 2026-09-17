// mission-app · apps/web/src/screens/GroupConfirmScreen.tsx
//
// **SH-06 · 方案确认界面（编组确认）**
// （参考图 `需求图与描述\场景1\T1-2.png`，需求专篇 DES-APP-001 §3 SH-06）
//
// 版式照图：
//   顶 · 压条：阶段 / 当前方案 / 集群数 / 确认状态 / 台账实体
//   左 · ①「方案资源总览」（当前方案 / 集群总数 / 参与资源总数 / 资源就绪率）
//        ②「集群列表」（逐集群一行：名称 + 资源 x/y + 就绪率%）
//   中 · 方案集群卡**浮在地图上**（编号 + 集群名 + 架构组成四型数量与占比 + 任务属性 + 协同关系）
//   右 · 「方案确认信息」（当前方案 + ✓已选择并确认 / 任务区域覆盖率 / 链路就绪率 /
//        协同效率预估 / 方案优势 / 方案备注）+ **编组命令回执**（逐条，不美化）
//   底 · 右下两枚按钮：**【确认编组】**【自动优化】**；下达成功后另给【进入任务执行 ≫】
//
// 唯一的写动作：`alloc.confirm` 的前置链 `alloc.adopt` → `alloc.confirm` → `alloc.assign`
// （P3 实测：直接 confirm 回 1003 + unmet=["not-adopted"]；跳过 adopt/confirm 直接 assign 也回 1003）。
// 三条回执**全部留在界面上**，失败原因照抄、不美化。
//
// ★ 数据纪律（这一屏最容易犯的错）：
//   · 图上右栏的 93% / 96% / 91% 是**示意值**，一律不抄：字段名按图，**数值取引擎**；
//     引擎没有该指标 → 显示"—"并写明"引擎未给出该指标"。
//   · `alloc.assign` 可能 **code=0 但逐设备登记失败**（平台型号不在 entityTypes.json 时引擎回 1000），
//     所以本屏**不只显示 code**：逐集群 code、逐设备错误、`blocked.reason` 全部照抄。
//   · 样式一律 `left/right/top/bottom` 长写（**不用 `inset` 简写**）。
import { useState, type CSSProperties } from 'react'
import { C, panel, panelTitle } from '../theme'
import type { CommandReply, FlowState } from '../api'
import type { UseFlow } from '../flow/useFlow'
import {
  n2s, num, objList, readAssign, readConfirm, readInventory, readPlans, readSituation,
  replyText, str, useVerbOnce,
  type GroupView, type PlanView,
} from '../flow/useSituation'
import { VerbVerdict } from './VerbVerdict'
import { StageStrip } from './StageOverlay'

/** 0..1 的比例 → 百分数（引擎两种口径都给过；**只换单位，不改数值**）。 */
function asPercent(v: number | undefined): number | undefined {
  if (v === undefined) return undefined
  return v <= 1 ? Number((v * 100).toFixed(0)) : v
}

/** 集群的四型组成（数量 + 占比）。数值缺失显示"—"。 */
function MixInline({ mix }: { mix: GroupView['mix'] }) {
  if (!mix.length) return <span style={{ fontSize: 11, color: C.textDim }}>—（快照无同名集群，配比取不到）</span>
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

/** 集群明细卡（图上那 6 张浮在地图上的卡：编号 + 名称 + 架构组成 + 任务属性 + 协同关系）。 */
function GroupCard({ g, index }: { g: GroupView; index: number }) {
  return (
    <div data-testid="confirm-group-card" style={groupCardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={numBadge}>{index + 1}</span>
        <span style={{ fontSize: 12.5, color: C.text, flex: 1, minWidth: 0 }}>{g.name}</span>
        {g.platformCount !== undefined && (
          <span style={{ fontSize: 11.5, color: C.accent, fontVariantNumeric: 'tabular-nums' }}>{n2s(g.platformCount)} 架</span>
        )}
      </div>
      <div style={{ marginTop: 5 }}>
        <div style={{ fontSize: 11, color: C.textDim, marginBottom: 2 }}>架构组成（在册平台按型号）</div>
        <MixInline mix={g.mix} />
      </div>
      <div style={{ marginTop: 4, fontSize: 11.5, color: C.textDim, lineHeight: 1.6 }}>
        {g.task && <div>任务属性：{g.task}</div>}
        {g.cooperation && <div>协同关系：{g.cooperation}</div>}
      </div>
    </div>
  )
}

/** 一行「名 → 值」（左栏两块与右栏都用它）。值缺失 → "—"。 */
function RowKV({ k, v, tone, testid }: { k: string; v: string; tone?: string; testid?: string }) {
  return (
    <div data-testid={testid} style={{ display: 'flex', gap: 8, padding: '2px 0', fontSize: 12 }}>
      <span style={{ color: C.textDim, flex: 1, minWidth: 0 }}>{k}</span>
      <span style={{ color: tone ?? C.text, fontVariantNumeric: 'tabular-nums' }}>{v}</span>
    </div>
  )
}

/**
 * 右栏「方案确认信息」里那三项率值的**取值口径**：
 * 字段名按图（任务区域覆盖率 / 链路就绪率 / 协同效率预估），值只能来自引擎的 `score.metrics[]`
 * —— 认的是**引擎自己的指标键/名**，认不出就留"—"并写明"引擎未给出该指标"，
 * **绝不用图上的 93/96/91 去填**。
 */
function metricOf(plan: PlanView | undefined, re: RegExp) {
  return plan?.effects.find((e) => re.test(e.key) || re.test(e.name))
}

export function GroupConfirmScreen({ state, flow, selectedPlanId, onPickPlan, onGo, goto }: {
  state: FlowState
  flow: UseFlow
  /** 由步 4 带过来的选择（本屏里也能改） */
  selectedPlanId: string | null
  onPickPlan: (id: string) => void
  /** 切到另一屏（只改本地屏路由）—— SH-06 → SH-07 */
  onGo?: (id: string) => void
  /** 走流程（步号归宿主）：【进入任务执行 ≫】= 步 6 */
  goto?: (step: number) => void
}) {
  const snap = useVerbOnce(flow, 'situation.snapshot', {}, true)
  const plans = useVerbOnce(flow, 'alloc.plans', { side: 'group', count: 3 }, true)
  const inv = useVerbOnce(flow, 'alloc.inventory', {}, true)

  const sit = readSituation(snap.data)
  const pv = readPlans(plans.data, sit.groups)
  const iv = readInventory(inv.data)

  const plan: PlanView | undefined =
    pv.plans.find((p) => p.id === selectedPlanId)
    ?? pv.plans.find((p) => p.id === pv.recommendedId)
    ?? pv.plans.find((p) => p.recommended)
    ?? pv.plans[0]

  const [busy, setBusy] = useState(false)
  const [adoptReply, setAdoptReply] = useState<CommandReply | null>(null)
  const [confirmReply, setConfirmReply] = useState<CommandReply | null>(null)
  const [assignReply, setAssignReply] = useState<CommandReply | null>(null)
  const av0 = readConfirm(adoptReply?.data)
  const cv = readConfirm(confirmReply?.data)
  const av = readAssign(assignReply?.data)

  /**
   * 【确认编组】的命令序：`alloc.adopt` → `alloc.confirm` → `alloc.assign`（三条都幂等，重复点安全）。
   * 三条回执**都留在界面上**，哪一条卡住就停在哪一条（不假装成功）。
   */
  const onConfirm = async () => {
    if (busy) return
    const id = plan?.id ?? ''
    setBusy(true)
    try {
      const a = await flow.send('alloc.adopt', { planId: id })
      setAdoptReply(a)
      if (a.code !== 0) return
      const c = await flow.send('alloc.confirm', { planId: id })
      setConfirmReply(c)
      if (c.code !== 0) return
      const g = await flow.send('alloc.assign', { planId: id })
      setAssignReply(g)
    } finally {
      setBusy(false)
    }
  }

  const confirmed = cv.planState === 'confirmed' || (confirmReply?.code === 0 && !!confirmReply)
  const adopted = av0.planState === 'adopted' || adoptReply?.code === 0
  const assignOk = assignReply?.code === 0
  // 逐设备登记的失败数（**不隐藏**）：assign 说"成功"但实体没建起来时，这条数就是真相
  const entityFail = av.entities.filter((e) => e.ok === false || (e.code !== undefined && e.code !== 0)).length
  // 首条未成功的回执（用来把"卡在哪一条"显示清楚）
  const firstBad = [adoptReply, confirmReply, assignReply].find((r) => r && r.code !== 0) ?? null
  const unmet = [...av0.unmet, ...cv.unmet]

  // ---- 左栏①「方案资源总览」------------------------------------------------
  const grouped = iv.totals.find((t) => t.key === 'grouped')
  const readyRate = asPercent(num(inv.data, 'readyRate'))

  // ---- 左栏②「集群列表」：资源 x/y + 就绪率% 的真值来源 --------------------
  //   ① 台账 `alloc.inventory.clusters[]`（`{clusterId, readyCount, allocatedTotal, readyPercent}`）
  //   ② `alloc.plans` 的 `snapshot.resources.clusters[]`（`{clusterId, total, available}`）
  //   ③ `alloc.assign` 的逐集群 `allocation[]`（`{planCluster, count, allocatedTotal}`）
  // 名称 → 台账 clusterId 的对齐靠**宿主给的键**：快照 groups[].key，或 assign 的 clusterMapping[].groupKey。
  const ledgerClusters = objList(inv.data, 'clusters')
  const keyOfName = (name: string): string | undefined => {
    const mapped = av.clusterMapping.find((m) => m.planCluster === name && m.groupKey)
    if (mapped?.groupKey) return mapped.groupKey
    return sit.groups.find((g) => g.name === name)?.key
  }
  const resourceOf = (name: string, i: number): { xy: string; ready: string; source: string } => {
    const key = keyOfName(name)
    const hit = (key !== undefined ? ledgerClusters.find((r) => str(r, 'clusterId', 'id', 'key') === key) : undefined)
      ?? ledgerClusters.find((r) => str(r, 'name') === name)
      ?? (ledgerClusters.length === (plan?.groups.length ?? -1) ? ledgerClusters[i] : undefined)
    if (hit) {
      const x = num(hit, 'readyCount', 'available', 'allocated')
      const y = num(hit, 'allocatedTotal', 'total')
      return {
        xy: x === undefined && y === undefined ? '—' : `${n2s(x)}/${n2s(y)}`,
        ready: (() => { const p = asPercent(num(hit, 'readyPercent', 'readyRate')); return p === undefined ? '—' : `${n2s(p)}%` })(),
        source: 'alloc.inventory.clusters[]',
      }
    }
    // ② `alloc.plans` 的 `snapshot.resources.clusters[]`（宿主真填的那一份：`{clusterId,total,available}`）
    const pd = plans.data as Record<string, unknown> | null
    const ss = pd && typeof pd === 'object' ? (pd.snapshot as Record<string, unknown> | undefined) : undefined
    const rr = ss && typeof ss === 'object' ? (ss.resources as Record<string, unknown> | undefined) : undefined
    const snapCl = objList(rr, 'clusters')
    const sh = (key !== undefined ? snapCl.find((r) => str(r, 'clusterId', 'key') === key) : undefined)
      ?? (snapCl.length === (plan?.groups.length ?? -1) ? snapCl[i] : undefined)
    if (sh) {
      return {
        xy: `${n2s(num(sh, 'available'))}/${n2s(num(sh, 'total'))}`,
        ready: '—',
        source: 'alloc.plans.snapshot.resources.clusters[]',
      }
    }
    const ap = av.perCluster.find((a) => a.planCluster === name)
    if (ap) {
      return {
        xy: `${n2s(ap.count)}/${n2s(ap.allocatedTotal)}`,
        ready: '—',
        source: 'alloc.assign.allocation[]',
      }
    }
    return { xy: '—', ready: '—', source: '（台账/方案/回执都没给该集群的资源数）' }
  }

  // ---- 右栏「方案确认信息」-------------------------------------------------
  const coverage = metricOf(plan, /覆盖率|coverage/i)
  const linkReady = metricOf(plan, /链路|link/i)
  const synergy = metricOf(plan, /协同|coordination|synergy/i)
  const notes = plan?.inapplicableReasons?.length ? plan.inapplicableReasons : pv.notes

  return (
    <>
      {/* ---------------- 顶部压条 ---------------- */}
      <StageStrip
        items={[
          { k: '阶段', v: state.phase || '—' },
          { k: '当前方案', v: plan?.name ?? '—', color: C.accent },
          { k: '集群', v: plan ? `${plan.clusters.length} 个` : '—' },
          { k: '编组确认', v: confirmed ? `已确认（${cv.planState ?? '—'}）` : '待确认', color: confirmed ? C.ok : C.textDim },
          { k: '台账实体', v: av.entities.length ? `${av.entities.length - entityFail}/${av.entities.length} 成功` : '—', color: entityFail ? C.bad : undefined },
        ]}
        right={<span style={{ color: entityFail ? C.bad : C.textDim }}>
          {entityFail
            ? `有 ${entityFail} 个平台未登记成实体（详见右栏回执）`
            : (assignOk ? '编组已下达：点右下【进入任务执行 ≫】' : '确认编组后由宿主推进到步 6')}
        </span>}
      />

      {/* ---------------- 左：方案资源总览 + 集群列表 ---------------- */}
      <div style={leftColStyle}>
        <div style={{ ...panel }}>
          <div style={panelTitle}>方案资源总览</div>
          <div style={{ padding: '7px 12px 9px' }}>
            <RowKV k="当前方案" v={plan?.name ?? '—'} testid="confirm-current-plan" />
            <div style={{ fontSize: 11.5, color: (confirmed || adopted) ? C.ok : C.textDim, margin: '2px 0 4px' }}>
              {confirmed
                ? `✓ 已选择并确认（planState=${cv.planState ?? '—'}）`
                : adopted
                  ? '已采纳（planState=adopted），待确认'
                  : '待确认（尚未发 alloc.adopt / alloc.confirm）'}
            </div>
            <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 4 }}>
              <RowKV k="集群总数" v={plan ? `${plan.clusters.length} 个` : '—'} />
              <RowKV k="参与资源总数" v={grouped?.text ?? (grouped?.value !== undefined ? n2s(grouped.value) : '—')} />
              <RowKV k="资源就绪率" v={readyRate === undefined ? '—' : `${n2s(readyRate)}%`} />
            </div>
            {readyRate !== undefined && (
              <div style={{ marginTop: 4, height: 6, borderRadius: 3, background: 'rgba(95,176,255,.16)', overflow: 'hidden' }}>
                <span style={{ display: 'block', width: `${Math.max(0, Math.min(100, readyRate))}%`, height: '100%', background: C.bar }} />
              </div>
            )}
            <div style={{ fontSize: 10.5, color: C.textDim, marginTop: 5, lineHeight: 1.6 }}>
              参与资源总数/资源就绪率 ← alloc.inventory（{grouped ? '已给' : '未给 allocatedTotal/totalAll'}；
              {readyRate === undefined ? '未给 readyRate' : 'readyRate 已换算为百分数'}）
            </div>
          </div>
        </div>

        <div style={{ ...panel, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={panelTitle}>集群列表</div>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 10px 9px' }}>
            {(plan?.groups ?? []).map((g, i) => {
              const r = resourceOf(g.name, i)
              return (
                <div key={g.key} data-testid="confirm-cluster-row" data-res-source={r.source}
                  title={`资源数来源：${r.source}`}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', marginBottom: 6,
                    border: `1px solid ${C.border}`, borderRadius: 6, background: 'rgba(10,32,58,.5)',
                  }}>
                  <span style={numBadge}>{i + 1}</span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {g.name}
                  </span>
                  <span style={{ fontSize: 11, color: C.textDim, fontVariantNumeric: 'tabular-nums' }}>资源 {r.xy}</span>
                  <span style={{ fontSize: 11, color: r.ready === '—' ? C.unknown : C.ok, fontVariantNumeric: 'tabular-nums' }}>
                    就绪 {r.ready}
                  </span>
                </div>
              )
            })}
            {!plan?.groups.length && (
              <div style={{ fontSize: 12, color: C.textDim, padding: '8px 2px', lineHeight: 1.7 }}>
                集群列表未就绪
                {plans.sent && plans.reply && plans.reply.code !== 0 && (
                  <div style={{ color: C.warn, marginTop: 4 }}>{replyText(plans.reply)}</div>
                )}
              </div>
            )}
          </div>
        </div>

        <VerbVerdict
          rows={[
            { verb: 'alloc.plans', reply: plans.reply, busy: plans.busy, onRetry: plans.resend, okNote: `${pv.plans.length} 个方案` },
            { verb: 'alloc.inventory', reply: inv.reply, busy: inv.busy, onRetry: inv.resend, okNote: `${iv.rows.length} 型` },
          ]}
        />
      </div>

      {/* ---------------- 中：方案切换 + 集群明细（浮在地图上）---------------- */}
      <div style={centerStyle}>
        <div style={{ display: 'flex', gap: 8, paddingBottom: 8, overflowX: 'auto' }}>
          {pv.plans.map((p) => {
            const on = p.id === plan?.id
            return (
              <button
                key={p.id}
                data-testid="confirm-plan-tab"
                data-plan-id={p.id}
                data-plan-recommended={p.recommended ? '1' : '0'}
                onClick={() => onPickPlan(p.id)}
                style={{
                  padding: '5px 11px', fontSize: 12.5, cursor: 'pointer', whiteSpace: 'nowrap',
                  borderRadius: 7, color: on ? '#eaf4ff' : C.text,
                  border: `1px solid ${p.recommended ? 'rgba(95,176,255,.85)' : on ? C.borderStrong : C.border}`,
                  background: on ? 'rgba(29,78,216,.55)' : 'rgba(8,26,48,.86)',
                }}
              >
                {p.name}{p.recommended ? ' ★' : ''}{p.score !== undefined ? ` · ${n2s(p.score)}` : ''}
              </button>
            )
          })}
          {!pv.plans.length && (
            <span style={{ fontSize: 12, color: C.textDim, background: 'rgba(8,26,48,.86)', padding: '4px 8px', borderRadius: 6 }}>
              {plans.busy ? '正在读取方案…' : '方案未就绪（alloc.plans）'}
            </span>
          )}
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexWrap: 'wrap', gap: 10, alignContent: 'flex-start' }}>
          {(plan?.groups ?? []).map((g, i) => <GroupCard key={g.key} g={g} index={i} />)}
          {!plan?.groups.length && (
            <div style={{ ...panel, padding: 13, fontSize: 12.5, color: C.textDim, lineHeight: 1.9, width: '100%' }}>
              <div>集群明细未就绪：需要 `alloc.plans` 的候选方案（`candidate.clusters[]`）。</div>
              {plans.sent && plans.reply && plans.reply.code !== 0 && (
                <div style={{ color: C.warn }}>alloc.plans → {replyText(plans.reply)}</div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ---------------- 右：方案确认信息 + 编组回执 ---------------- */}
      <div style={rightColStyle}>
        <div style={{ ...panel }}>
          <div style={panelTitle}>方案确认信息</div>
          <div style={{ padding: '7px 12px 9px' }}>
            <RowKV k="当前方案" v={plan?.name ?? '—'} />
            <div style={{ fontSize: 11.5, color: (confirmed || adopted) ? C.ok : C.textDim, marginBottom: 4 }}>
              {confirmed ? '✓ 已选择并确认' : adopted ? '已选择（已采纳，待确认）' : '待选择确认'}
            </div>

            <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 5, marginTop: 4 }}>
              {/* 字段名按图；值是引擎 score.metrics[] 里**对应指标**的原值，并把引擎键写出来可复核 */}
              <RowKV
                k="任务区域覆盖率"
                v={coverage?.value !== undefined ? `${n2s(coverage.value)}${coverage.unit ?? '%'}` : '—'}
                tone={coverage?.value !== undefined ? C.ok : C.unknown}
              />
              <div style={subNote}>
                已覆盖区域数：引擎未给出该指标{coverage ? `（引擎键 ${coverage.key}「${coverage.name}」）` : ''}
              </div>
              <RowKV
                k="链路就绪率"
                v={linkReady?.value !== undefined ? `${n2s(linkReady.value)}${linkReady.unit ?? '%'}` : '—'}
                tone={linkReady?.value !== undefined ? C.ok : C.unknown}
              />
              <div style={subNote}>
                {linkReady ? `引擎键 ${linkReady.key}「${linkReady.name}」` : '引擎未给出该指标（链路评估腿未接）'}
              </div>
              <RowKV
                k="协同效率预估"
                v={synergy?.value !== undefined ? `${n2s(synergy.value)}${synergy.unit ?? '%'}` : '—'}
                tone={synergy?.value !== undefined ? C.ok : C.unknown}
              />
              <div style={subNote}>
                {synergy ? `引擎键 ${synergy.key}「${synergy.name}」` : '引擎未给出该指标（协同效率属 topology 腿，本步未接）'}
              </div>
            </div>

            {/* 引擎真给的 6 项预期效果**原样列出**（图上的三个率值不一定都在里面，缺的就显示"—"） */}
            {plan && plan.effects.length > 0 && (
              <div style={{ marginTop: 6, borderTop: `1px solid ${C.border}`, paddingTop: 5 }}>
                <div style={{ fontSize: 11.5, color: C.textDim, marginBottom: 2 }}>
                  引擎指标原值（{plan.name} · score.metrics[]）
                </div>
                {plan.effects.map((e) => (
                  <RowKV key={e.key} k={e.name} v={e.value !== undefined ? `${n2s(e.value)}${e.unit ?? ''}` : '—'} />
                ))}
              </div>
            )}

            <div style={{ marginTop: 6, borderTop: `1px solid ${C.border}`, paddingTop: 5 }}>
              <div style={{ fontSize: 12, color: C.textDim, marginBottom: 3 }}>
                方案优势（{pv.reasons.length} 条）
              </div>
              {pv.reasons.length > 0
                ? pv.reasons.map((t, i) => (
                  <div key={i} data-testid="confirm-advantage" style={{ fontSize: 11.5, color: C.text, lineHeight: 1.7 }}>
                    <span style={{ color: C.ok }}>✓ </span>{t}
                  </div>
                ))
                : <div style={{ fontSize: 11.5, color: C.textDim }}>—（宿主未给出方案优势：alloc.plans.reasons[] 为空）</div>}
              {pv.reasons.length > 0 && (
                <div style={subNote}>来源：alloc.plans.reasons[]（宿主的评分理由原话，不是界面文案）</div>
              )}
            </div>

            <div style={{ marginTop: 6, borderTop: `1px solid ${C.border}`, paddingTop: 5 }}>
              <div style={{ fontSize: 12, color: C.textDim, marginBottom: 3 }}>方案备注</div>
              {notes.length > 0
                ? notes.map((t, i) => (
                  <div key={i} style={{ fontSize: 11.5, color: C.text, lineHeight: 1.7 }}>· {t}</div>
                ))
                : <div style={{ fontSize: 11.5, color: C.textDim }}>—（宿主未给出方案备注：alloc.plans 未给 notes/inapplicableReasons）</div>}
              {notes.length > 0 && (
                <div style={subNote}>
                  来源：{plan?.inapplicableReasons?.length ? 'candidate.inapplicableReasons[]' : 'alloc.plans.notes[]'}
                </div>
              )}
            </div>
          </div>
        </div>

        <VerbVerdict
          title="编组命令回执"
          rows={[
            {
              verb: 'alloc.adopt', reply: adoptReply, busy,
              okNote: `planState=${av0.planState ?? '—'}${av0.idempotent ? ' · 幂等' : ''}`,
            },
            {
              verb: 'alloc.confirm', reply: confirmReply, busy,
              okNote: `planState=${cv.planState ?? '—'}${cv.idempotent ? ' · 幂等' : ''}`,
            },
            {
              verb: 'alloc.assign', reply: assignReply, busy: busy && !!confirmReply && confirmReply.code === 0,
              okNote: assignReply?.code === 0
                ? `${av.allocatedClusters ?? av.clusterCount ?? 0} 个集群已下达`
                : undefined,
              onRetry: () => void onConfirm(),
            },
          ]}
        />

        {firstBad && unmet.length > 0 && (
          <div data-testid="unmet-note" style={{ ...panel, borderColor: 'rgba(245,158,11,.5)', padding: '7px 10px', fontSize: 11, color: C.warn, lineHeight: 1.6 }}>
            前置未满足（{firstBad.verb} code={firstBad.code}）：{unmet.join('、')}
          </div>
        )}

        {/* 下达明细：逐集群 code + 逐设备登记结果 + blocked 原因（**局部失败必须可见**） */}
        {av.perCluster.length > 0 && (
          <div style={{ ...panel }}>
            <div style={panelTitle}>下达明细（alloc.assign）</div>
            <div style={{ padding: '6px 10px 8px', maxHeight: 168, overflowY: 'auto' }}>
              {av.perCluster.map((a, i) => (
                <div key={`${a.clusterId}-${i}`} data-testid="assign-row" style={{ padding: '3px 0', borderBottom: '1px solid rgba(95,176,255,.10)' }}>
                  <div style={{ display: 'flex', gap: 6, fontSize: 11.5 }}>
                    <span style={{ flex: 1, minWidth: 0, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {a.planCluster ?? a.clusterId ?? `#${i + 1}`}
                    </span>
                    <span style={{ color: a.code === 0 ? C.ok : C.bad }}>code={a.code ?? '—'}</span>
                    {a.idempotent && <span style={{ color: C.textDim }}>幂等</span>}
                  </div>
                  <div style={{ fontSize: 11, color: C.textDim }}>
                    {a.mix.map((m) => `${m.label} ${m.count}`).join(' · ')}
                    {a.allocatedTotal !== undefined ? ` ｜台账 ${n2s(a.allocatedTotal)}` : ''}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {entityFail > 0 && (
          <div data-testid="blocked-note" style={{ ...panel, borderColor: 'rgba(239,68,68,.5)', padding: '7px 10px', fontSize: 11, color: C.bad, lineHeight: 1.6 }}>
            台账登记有 {entityFail} 项未成功（assign 整体 code=0，但实体没建成）：
            {av.entities.find((e) => e.ok === false)?.message ?? ''}
          </div>
        )}
        {av.blocked && (
          <div data-testid="blocked-reason" style={{ ...panel, borderColor: 'rgba(245,158,11,.5)', padding: '7px 10px', fontSize: 11, color: C.warn, lineHeight: 1.6 }}>
            被挡下的阶段：{av.blocked.stage ?? '—'}
            <div>{av.blocked.reason ?? ''}</div>
            {av.blocked.needs && <div style={{ color: C.textDim }}>需要：{av.blocked.needs}</div>}
          </div>
        )}
        {cv.unmet.length > 0 && (
          <div style={{ ...panel, padding: '7px 10px', fontSize: 11, color: C.warn, lineHeight: 1.6 }}>
            未满足项：{cv.unmet.join('；')}
          </div>
        )}
      </div>

      {/* ---------------- 底部右下：确认编组 / 自动优化（+ 下达成功后的入口）---------------- */}
      <div style={bottomStyle}>
        {assignOk && entityFail === 0 && (
          <button
            data-testid="btn-advance-t2"
            data-sh="sh06"
            style={enterBtn}
            onClick={() => { goto?.(6); onGo?.('SH-07') }}
            title="进入任务执行：先走宿主步号 6（flow.goto{step:6}），再切到 SH-07"
          >进入任务执行 ≫</button>
        )}
        <button
          data-testid="btn-confirm-group"
          style={confirmBtn(confirmEnabled(plans.sent, busy))}
          disabled={!confirmEnabled(plans.sent, busy)}
          onClick={() => void onConfirm()}
        >
          {busy ? '下达中…' : confirmed ? '重新确认编组' : '✓ 确认编组'}
        </button>
        <button
          data-testid="sh06-auto-optimize"
          style={{ ...autoBtn, cursor: 'default' }}
          disabled
          title="自动优化：宿主尚未提供该 verb（无 verb 可发，故灰置）"
        >自动优化</button>
      </div>

      <GroupConfirmProbe
        adoptReply={adoptReply}
        confirmReply={confirmReply}
        assignReply={assignReply}
        planId={plan?.id ?? null}
        planName={plan?.name ?? null}
        clusterCount={plan?.clusters.length ?? 0}
        entityFail={entityFail}
        assignOk={assignOk}
      />
    </>
  )
}

/** 方案回执没回来 / 正在下发时禁用（其余情况允许点：先给回执，不闷着用户）。 */
function confirmEnabled(sent: boolean, busy: boolean) { return sent && !busy }

/** 自证句柄（SH-06 的部分）。 */
function GroupConfirmProbe({ adoptReply, confirmReply, assignReply, planId, planName, clusterCount, entityFail, assignOk }: {
  adoptReply: CommandReply | null
  confirmReply: CommandReply | null
  assignReply: CommandReply | null
  planId: string | null
  planName: string | null
  clusterCount: number
  entityFail: number
  assignOk: boolean
}) {
  const w = window as unknown as { __p3Stats?: Record<string, unknown> }
  w.__p3Stats = {
    ...(w.__p3Stats ?? {}),
    step: 5,
    screen: 'groupConfirm',
    confirm: {
      planId, planName, clusterCount, entityFail, assignOk,
      adoptReply, confirmReply, assignReply,
      adoptView: readConfirm(adoptReply?.data),
      confirmView: readConfirm(confirmReply?.data),
      assignView: readAssign(assignReply?.data),
    },
    dom: {
      planTabs: document.querySelectorAll('[data-testid="confirm-plan-tab"]').length,
      clusterRows: document.querySelectorAll('[data-testid="confirm-cluster-row"]').length,
      groupCards: document.querySelectorAll('[data-testid="confirm-group-card"]').length,
      assignRows: document.querySelectorAll('[data-testid="assign-row"]').length,
      advantages: document.querySelectorAll('[data-testid="confirm-advantage"]').length,
      hasBlockedNote: !!document.querySelector('[data-testid="blocked-reason"]') || !!document.querySelector('[data-testid="blocked-note"]'),
      hasConfirmBtn: !!document.querySelector('[data-testid="btn-confirm-group"]'),
      hasAutoOptimize: !!document.querySelector('[data-testid="sh06-auto-optimize"]'),
      hasEnterExec: !!document.querySelector('[data-testid="btn-advance-t2"]'),
    },
    clusterNames: Array.from(document.querySelectorAll('[data-testid="confirm-cluster-row"]'))
      .map((el) => (el.textContent ?? '').trim()),
  }
  return null
}

// ---- 样式（left/right/bottom 长写，**不用 inset 简写**）----
const leftColStyle: CSSProperties = {
  position: 'absolute', left: 12, top: 34, bottom: 96, zIndex: 20, width: 254,
  display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0,
}
const centerStyle: CSSProperties = {
  position: 'absolute', left: 278, right: 314, top: 34, bottom: 96, zIndex: 20,
  display: 'flex', flexDirection: 'column', minHeight: 0,
}
const rightColStyle: CSSProperties = {
  position: 'absolute', right: 12, top: 34, bottom: 96, zIndex: 20, width: 290,
  display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto',
}
const bottomStyle: CSSProperties = {
  position: 'absolute', left: 12, right: 12, bottom: 36, zIndex: 21,
  display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, height: 52,
}
const groupCardStyle: CSSProperties = {
  width: 236, border: `1px solid ${C.border}`, borderRadius: 8, background: 'rgba(8,26,48,.86)',
  padding: '8px 10px',
}
const numBadge: CSSProperties = {
  width: 18, height: 18, borderRadius: '50%', flex: '0 0 auto', textAlign: 'center', lineHeight: '17px',
  fontSize: 11, color: C.accent, border: `1px solid ${C.border}`, background: 'rgba(95,176,255,.08)',
}
const subNote: CSSProperties = {
  fontSize: 10.5, color: C.textDim, lineHeight: 1.6, marginBottom: 3,
}
const enterBtn: CSSProperties = {
  padding: '11px 22px', fontSize: 14, cursor: 'pointer', borderRadius: 8, whiteSpace: 'nowrap',
  letterSpacing: 1, border: '1px solid rgba(34,197,94,.6)',
  background: 'linear-gradient(180deg,#16a34a,#15803d)', color: '#eafff2',
}
const confirmBtn = (enabled: boolean): CSSProperties => ({
  padding: '11px 26px', fontSize: 14, cursor: enabled ? 'pointer' : 'default', borderRadius: 8,
  whiteSpace: 'nowrap', letterSpacing: 1,
  border: `1px solid ${C.borderStrong}`,
  background: enabled ? 'linear-gradient(180deg,#1d4ed8,#1e3a8a)' : 'rgba(30,58,95,.6)',
  color: '#eaf4ff',
})
const autoBtn: CSSProperties = {
  padding: '11px 20px', fontSize: 14, cursor: 'pointer', borderRadius: 8, whiteSpace: 'nowrap',
  border: '1px solid rgba(129,140,248,.5)', background: 'rgba(49,46,129,.55)', color: '#c7d2fe',
}

export default GroupConfirmScreen
