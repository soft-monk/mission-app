// mission-app · apps/web/src/screens/GroupConfirmScreen.tsx
//
// Excel 步 5 · 编组确认（参考图 `T1-2.png`）。
//
// 布局照图：
//   顶   · 压条：阶段 / 当前方案 / 集群数 / 确认状态
//   左   · 方案资源总览（`alloc.inventory` 台账）+ 集群列表（方案的 clusters[]）
//   中   · 方案切换（`alloc.plans`）+ 选中方案的集群明细卡（组成 / 角色 / 平台数）
//   右   · 方案确认信息（评分 / 覆盖类指标 / 方案优势）+ **编组命令回执**
//   底   · 【确认编组】【自动优化】
//
// 唯一的写动作：`alloc.confirm{planId}` → `alloc.assign{planId}`（顺序发，**两条回执都显示**）。
// 成功后由宿主推进到步 6 —— 前端**不自己改 step**（`flow.state` 事件会把它带过来）。
//
// ★ 纪律（这一屏最容易犯的错，写在这里提醒）：
//   · `alloc.assign` 可能 **code=0 但逐设备登记失败**（实测：平台型号不在 entityTypes.json 里，
//     引擎回 1000）。所以本屏**不只显示 code**：逐集群 code、逐设备错误、以及 `blocked.reason`
//     全部照抄出来。绝不用"整体成功"盖住局部失败。
//   · 覆盖率/就绪率/评分一律取自宿主回执；没给就显示"—"。
import { useState, type CSSProperties } from 'react'
import { C, panel, panelTitle } from '../theme'
import type { CommandReply, FlowState } from '../api'
import type { UseFlow } from '../flow/useFlow'
import {
  n2s, replyText, useVerbOnce,
  readAssign, readConfirm, readInventory, readPlans, readSituation,
  type GroupView, type PlanView,
} from '../flow/useSituation'
import { VerbVerdict } from './VerbVerdict'
import { StageStrip } from './StageOverlay'

function MixInline({ mix }: { mix: GroupView['mix'] }) {
  if (!mix.length) return <span style={{ fontSize: 11, color: C.textDim }}>在册平台里无同名集群</span>
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 7 }}>
      {mix.map((m) => (
        <span key={m.domain} style={{ fontSize: 11, color: C.textDim, whiteSpace: 'nowrap' }}>
          {m.label}
          <span style={{ color: C.text, marginLeft: 3 }}>{n2s(m.count)}</span>
          {m.percent !== undefined && <span style={{ color: C.accentDim, marginLeft: 3 }}>({n2s(m.percent)}%)</span>}
        </span>
      ))}
    </span>
  )
}

/** 集群明细卡（T1-2 地图上那几圈任务区；这里放在中间栏，编号与宿主给的顺序一致）。 */
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
        {g.task && <div>角色：{g.task}</div>}
        {g.cooperation && <div>协同关系：{g.cooperation}</div>}
      </div>
    </div>
  )
}

export function GroupConfirmScreen({ state, flow, selectedPlanId, onPickPlan }: {
  state: FlowState
  flow: UseFlow
  /** 由步 4 带过来的选择（步 5 里也能改） */
  selectedPlanId: string | null
  onPickPlan: (id: string) => void
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
   * 【确认编组】的命令序：`alloc.adopt` → `alloc.confirm` → `alloc.assign`。
   *
   * ⚠ 为什么有 adopt（契约文档里没写死这一步）：
   *   实测 `alloc.confirm` 直接发会回 `1003` + `data.unmet=["not-adopted"]`，
   *   `alloc.assign` 也会回 `1003 编组前置未满足：先 alloc.adopt → alloc.confirm`。
   *   所以界面按引擎的真实前置顺序发三条；三条回执**都留在界面上**，失败原因照抄、不美化。
   *   三条都是幂等的（宿主回 `idempotent=true`），重复点不会重复占用资源。
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
  const metricsOfPlan = plan?.effects ?? []
  // 首条未成功的回执（用来把"卡在哪一条"显示清楚）
  const firstBad = [adoptReply, confirmReply, assignReply].find((r) => r && r.code !== 0) ?? null
  const unmet = [...av0.unmet, ...cv.unmet]

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
            ? `有 ${entityFail} 个平台未登记成实体（详见右侧回执）`
            : (confirmReply?.code === 0 ? '确认与下达回执见右栏' : '确认编组后由宿主推进到步 6')}
        </span>}
      />

      {/* ---------------- 左：方案资源总览 + 集群列表 ---------------- */}
      <div style={leftColStyle}>
        <div style={{ ...panel }}>
          <div style={panelTitle}>方案资源总览</div>
          <div style={{ padding: '7px 12px 9px' }}>
            <div style={{ fontSize: 12.5, color: C.text }}>
              当前方案：<b>{plan?.name ?? '—'}</b>
            </div>
            <div style={{ fontSize: 11.5, color: confirmed ? C.ok : C.textDim, marginTop: 3 }}>
              {confirmed ? `已确认（planState=${cv.planState ?? '—'}）` : '待确认'}
            </div>
            <div style={{ marginTop: 5, borderTop: `1px solid ${C.border}`, paddingTop: 5 }}>
              <RowKV k="集群总数" v={plan ? `${plan.clusters.length}` : '—'} />
              {iv.totals.slice(0, 5).map((t) => (
                <RowKV key={t.key} k={t.name} v={t.value !== undefined ? n2s(t.value, t.unit ?? '') : (t.text ?? '—')} />
              ))}
            </div>
          </div>
        </div>

        <div style={{ ...panel, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={panelTitle}>集群列表</div>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 10px 9px' }}>
            {(plan?.groups ?? []).map((g, i) => (
              <div key={g.key} data-testid="confirm-cluster-row" style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', marginBottom: 6,
                border: `1px solid ${C.border}`, borderRadius: 6, background: 'rgba(10,32,58,.5)',
              }}>
                <span style={numBadge}>{i + 1}</span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {g.name}
                </span>
                <span style={{ fontSize: 11.5, color: C.textDim }}>
                  {g.platformCount !== undefined ? `${n2s(g.platformCount)} 架` : ''}
                </span>
              </div>
            ))}
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

      {/* ---------------- 中：方案切换 + 集群明细 ---------------- */}
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
                  padding: '6px 12px', fontSize: 12.5, cursor: 'pointer', whiteSpace: 'nowrap',
                  borderRadius: 7, color: on ? '#eaf4ff' : C.text,
                  border: `1px solid ${p.recommended ? 'rgba(95,176,255,.85)' : on ? C.borderStrong : C.border}`,
                  background: on ? 'rgba(29,78,216,.45)' : 'rgba(10,32,58,.55)',
                }}
              >
                {p.name}{p.recommended ? ' ★' : ''}{p.score !== undefined ? ` · ${n2s(p.score)}` : ''}
              </button>
            )
          })}
          {!pv.plans.length && (
            <span style={{ fontSize: 12, color: C.textDim }}>
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
            <div style={{ fontSize: 12.5, color: C.text }}>
              当前方案：<b>{plan?.name ?? '—'}</b>
            </div>
            <div style={{ fontSize: 11.5, color: confirmed ? C.ok : C.textDim, marginTop: 3 }}>
              {confirmed ? '✓ 已确认并下达' : '待确认'}
            </div>
            <div style={{ marginTop: 6, borderTop: `1px solid ${C.border}`, paddingTop: 5 }}>
              <RowKV k="方案评分" v={plan?.score !== undefined ? n2s(plan.score) : '—'} />
              <RowKV k="与次优领先" v={plan?.id === pv.recommendedId && pv.leadOverNextPercent !== undefined ? `${n2s(pv.leadOverNextPercent)}%` : '—'} />
              {metricsOfPlan.slice(0, 6).map((m) => (
                <RowKV key={m.key} k={m.name} v={m.value !== undefined ? `${n2s(m.value)}${m.unit ?? ''}` : (m.text ?? '—')} />
              ))}
            </div>

            <div style={{ marginTop: 6, borderTop: `1px solid ${C.border}`, paddingTop: 5 }}>
              <div style={{ fontSize: 12, color: C.textDim, marginBottom: 3 }}>方案优势</div>
              {pv.reasons.length > 0
                ? pv.reasons.map((t, i) => (
                  <div key={i} data-testid="confirm-advantage" style={{ fontSize: 11.5, color: C.text, lineHeight: 1.7 }}>· {t}</div>
                ))
                : <div style={{ fontSize: 11.5, color: C.textDim }}>宿主未给出方案优势</div>}
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

        {assignOk && entityFail === 0 && (
          <div style={{ ...panel, padding: '7px 12px', fontSize: 12, color: C.ok, lineHeight: 1.7 }}>
            编组已下达。步 6（任务执行）由宿主推进——本屏不自己改 step。
          </div>
        )}
      </div>

      {/* ---------------- 底部：确认编组 / 自动优化 ---------------- */}
      <div style={bottomStyle}>
        <div style={{ ...panel, flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 14, padding: '0 14px', height: 46 }}>
          <span style={{ fontSize: 12, color: C.textDim }}>当前方案</span>
          <span data-testid="confirm-current-plan" style={{ fontSize: 13, color: C.text }}>{plan?.name ?? '—'}</span>
          <span style={{ fontSize: 12, color: C.textDim }}>集群 {plan ? plan.clusters.length : '—'}</span>
          <span style={{ fontSize: 12, color: C.textDim }}>阶段 {state.phase || '—'}</span>
          {plan?.score !== undefined && <span style={{ fontSize: 12, color: C.accent }}>评分 {n2s(plan.score)}</span>}
        </div>
        <button data-testid="btn-confirm-group" style={primaryBtn(confirmEnabled(plans.sent, busy))} disabled={!confirmEnabled(plans.sent, busy)} onClick={() => void onConfirm()}>
          {busy ? '下达中…' : confirmed ? '重新确认编组' : '确认编组'}
        </button>
        <button style={ghostBtn} disabled title="自动优化：宿主尚未提供该 verb">自动优化</button>
      </div>

      <GroupConfirmProbe
        adoptReply={adoptReply}
        confirmReply={confirmReply}
        assignReply={assignReply}
        planId={plan?.id ?? null}
        planName={plan?.name ?? null}
        clusterCount={plan?.clusters.length ?? 0}
        entityFail={entityFail}
      />
    </>
  )
}

/** 方案回执没回来 / 正在下发时禁用（其余情况允许点：先给回执，不闷着用户）。 */
function confirmEnabled(sent: boolean, busy: boolean) { return sent && !busy }

function RowKV({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '2px 0', fontSize: 12 }}>
      <span style={{ color: C.textDim, flex: 1, minWidth: 0 }}>{k}</span>
      <span style={{ color: C.text, fontVariantNumeric: 'tabular-nums' }}>{v}</span>
    </div>
  )
}

/** 自证句柄（步 5 的部分）。 */
function GroupConfirmProbe({ adoptReply, confirmReply, assignReply, planId, planName, clusterCount, entityFail }: {
  adoptReply: CommandReply | null
  confirmReply: CommandReply | null
  assignReply: CommandReply | null
  planId: string | null
  planName: string | null
  clusterCount: number
  entityFail: number
}) {
  const w = window as unknown as { __p3Stats?: Record<string, unknown> }
  w.__p3Stats = {
    ...(w.__p3Stats ?? {}),
    step: 5,
    screen: 'groupConfirm',
    confirm: {
      planId, planName, clusterCount, entityFail,
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
      hasBlockedNote: !!document.querySelector('[data-testid="blocked-reason"]') || !!document.querySelector('[data-testid="blocked-note"]'),
      hasConfirmBtn: !!document.querySelector('[data-testid="btn-confirm-group"]'),
    },
    clusterNames: Array.from(document.querySelectorAll('[data-testid="confirm-cluster-row"]'))
      .map((el) => (el.textContent ?? '').trim()),
  }
  return null
}

// ---- 样式 ----
const leftColStyle: CSSProperties = {
  position: 'absolute', left: 12, top: 34, bottom: 56, zIndex: 20, width: 250,
  display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0,
}
const centerStyle: CSSProperties = {
  position: 'absolute', left: 274, right: 320, top: 34, bottom: 56, zIndex: 20,
  display: 'flex', flexDirection: 'column', minHeight: 0,
}
const rightColStyle: CSSProperties = {
  position: 'absolute', right: 12, top: 34, bottom: 56, zIndex: 20, width: 296,
  display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto',
}
const bottomStyle: CSSProperties = {
  position: 'absolute', left: 12, right: 12, bottom: 6, zIndex: 21,
  display: 'flex', alignItems: 'center', gap: 10, height: 46,
}
const groupCardStyle: CSSProperties = {
  width: 232, border: `1px solid ${C.border}`, borderRadius: 8, background: 'rgba(10,32,58,.62)',
  padding: '8px 10px',
}
const numBadge: CSSProperties = {
  width: 18, height: 18, borderRadius: 5, flex: '0 0 auto', textAlign: 'center', lineHeight: '17px',
  fontSize: 11, color: C.accent, border: `1px solid ${C.border}`, background: 'rgba(95,176,255,.08)',
}
const primaryBtn = (enabled: boolean): CSSProperties => ({
  padding: '11px 26px', fontSize: 14, cursor: enabled ? 'pointer' : 'default', borderRadius: 8,
  whiteSpace: 'nowrap', letterSpacing: 1,
  border: '1px solid rgba(34,197,94,.6)',
  background: enabled ? 'linear-gradient(180deg,#16a34a,#15803d)' : 'rgba(30,58,95,.6)',
  color: '#eafff2',
})
const ghostBtn: CSSProperties = {
  padding: '11px 20px', fontSize: 13.5, cursor: 'pointer', borderRadius: 8, whiteSpace: 'nowrap',
  background: 'rgba(10,20,36,.75)', border: `1px solid ${C.borderStrong}`, color: C.text,
}

export default GroupConfirmScreen
