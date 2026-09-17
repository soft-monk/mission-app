// mission-app · apps/web/src/screens/StrikeScreen.tsx
//
// **AI决策界面（需求专篇 DES-APP-001 SH-13，参考图 `场景1\T5-1.png`，1536×1024）**。
//
// 版式（图的四块；顶栏/左导航/底部状态条/麦克风球由 `AppShell` 提供，本文件只摆浮层）：
//   · 左上：地图工具栏（选择 / 测距 / 图层 / 3D · 2D/3D）
//   · 右上：显示模式胶囊「显示模式：任务规划」
//   · 地图下方：「打击方案」**3 张卡**横排 —— 每卡 4 个字段**逐字**：
//            打击方式 / 参与集群 / 成功率预估 / 打击效果
//   · 右栏整栏：「AI语音交互」（`VoiceStrip`，三段式文案取自 `config.json` 的
//            `flow.labels` 的 `voice.sh13.system|user|reply`）+ 底部一颗【进入打击确认 ≫】
//
// ★ 纪律（这一屏最容易犯的三个错）：
//   ① **图上没有"确认"按钮**（§6 E-22：Excel 说"卡片栏右上方有确认按钮"，图上没有）——
//      所以本屏**不加**确认/采纳按钮；点卡只 `onSelectPlan`（选中），进入下一屏由右栏那颗
//      【进入打击确认 ≫】承担（`onGo('SH-14')`）。采纳（`strike.adopt`）按 §4.3 归下一步的
//      【生成打击任务】。
//   ② **一个数都不编**：成功率/评分/排名/预计完成/协同方式全部取 `strike.plans` 回执
//      （图上 68/82/61% 是示意值 —— 本屏只显示引擎给的数，缺就"—"）。
//   ③ **推荐不是前端挑的**：绿角标「推荐方案」只认 `recommendedId`（或候选自带
//      `recommendedHint/recommended`）；引擎没指定 → 一张都不标，并在卡片栏写明"引擎未指定推荐"。
import { useMemo, type CSSProperties, type ReactNode } from 'react'
import { C, panel, panelTitle } from '../theme'
import type { FlowState } from '../api'
import type { UseFlow } from '../flow/useFlow'
import { n2s, readCompose, replyText, useVerbOnce } from '../flow/useSituation'
import { readStrikePlans, type StrikePlanView } from '../flow/useStrike'
import { VoiceStrip, useLabels } from '../shell/VoiceStrip'

/**
 * 方案名显示：宿主回执里是「方案一 光电精确打击」，参考图上是「方案一：光电精确打击」
 * —— 差别只有「方案N」后面那个分隔符。这里**只把分隔符显示成全角冒号**，
 * 原文一个字不改（`data-plan-name-raw` 留着，`title` 也摆出来）。
 */
function planTitle(raw: string): string {
  const m = /^(方案[一二三四五六七八九十0-9]+)[\s　]+(.+)$/.exec(raw)
  return m ? `${m[1]}：${m[2]}` : raw
}

function Section({ title, right, children, testid }: {
  title: ReactNode
  right?: ReactNode
  children: ReactNode
  testid?: string
}) {
  return (
    <div data-testid={testid} style={{ ...panel, width: '100%', boxSizing: 'border-box' }}>
      <div style={{ ...panelTitle, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>{title}</span>
        <span style={{ flex: 1 }} />
        {right !== undefined && <span style={{ fontSize: 11, color: C.textDim }}>{right}</span>}
      </div>
      <div style={{ padding: '7px 12px 9px' }}>{children}</div>
    </div>
  )
}

/** 地图工具栏（图上那一排；可用性由 `view.compose` 说了算，未实现者灰置 + 写明原因）。 */
function MapToolbar({ items }: {
  items: { key: string; label: string; sub?: string; on?: boolean; hint?: string }[]
}) {
  return (
    <div data-testid="sh13-toolbar" style={toolbarStyle}>
      {items.map((t) => (
        <button
          key={t.key}
          data-testid={`sh13-tool-${t.key}`}
          data-tool-enabled={t.on ? '1' : '0'}
          title={t.hint}
          style={{
            ...toolBtn,
            color: t.on ? C.accent : (t.hint ? C.unknown : C.text),
            borderColor: t.on ? C.borderStrong : 'transparent',
            cursor: t.hint ? 'not-allowed' : 'default',
          }}
        >
          <span style={{ fontSize: 12.5, lineHeight: 1.1 }}>{t.label}</span>
          {t.sub && <span style={{ fontSize: 9.5, color: t.on ? C.accent : C.textDim }}>{t.sub}</span>}
        </button>
      ))}
    </div>
  )
}

/** 打击方案卡里的一行「名 + 值」（缺值显示"—" + 原因，**不补 0**）。 */
function CRow({ k, v, miss, color, testid }: {
  k: string
  v?: string
  miss?: string
  color?: string
  testid?: string
}) {
  return (
    <div data-testid={testid} style={{ display: 'flex', gap: 6, padding: '2px 0', fontSize: 11.5 }}>
      <span style={{ color: C.textDim, width: 58, flex: '0 0 auto' }}>{k}</span>
      <span style={{ color: v ? (color ?? C.text) : C.textDim, minWidth: 0, flex: 1, wordBreak: 'break-word' }}>
        {v ?? '—'}
        {!v && miss && <span style={{ fontSize: 10, color: C.textDim }}>（{miss}）</span>}
      </span>
    </div>
  )
}

/**
 * 一张打击方案卡（图上 3 张）。
 *
 * 字段逐字：打击方式 / 参与集群 / 成功率预估 / 打击效果；取值全部来自 `strike.plans`。
 * 卡头右边那枚绿角标「推荐方案」**只由 `recommendedId`/`recommendedHint` 决定**。
 */
function PlanCard({ plan, index, selected, onSelect }: {
  plan: StrikePlanView
  index: number
  selected: boolean
  onSelect: () => void
}) {
  const border = plan.recommended ? 'rgba(34,197,94,.85)' : selected ? C.borderStrong : C.border
  const clusters = plan.clusters.length ? plan.clusters.join(' / ') : undefined
  const finish = plan.plannedFinish
  const extras = [
    plan.coordination ? `协同 ${plan.coordinationCN}（${plan.coordination}）` : null,
    finish ? `预计完成 ${finish.text}${finish.basis ? `（basis=${finish.basis}）` : ''}` : null,
    plan.score !== undefined ? `评分 ${n2s(plan.score)}` : null,
    plan.rank !== undefined ? `排名 ${plan.rank}` : null,
  ].filter(Boolean).join(' · ')
  return (
    <div
      data-testid="strike-plan-card"
      data-plan-id={plan.id}
      data-plan-index={index}
      data-plan-name={plan.name}
      data-plan-recommended={plan.recommended ? '1' : '0'}
      data-plan-success={plan.successRate !== undefined ? String(plan.successRate) : ''}
      data-plan-method={plan.method ?? ''}
      data-plan-clusters={plan.clusters.join('|')}
      data-selected={selected ? '1' : '0'}
      onClick={onSelect}
      title={`${plan.name}（${plan.id}）`}
      style={{
        flex: '1 1 0', minWidth: 196, display: 'flex', flexDirection: 'column', cursor: 'pointer',
        border: `1px solid ${border}`, borderRadius: 8, overflow: 'hidden',
        background: plan.recommended ? 'rgba(34,197,94,.10)' : selected ? 'rgba(29,78,216,.22)' : 'rgba(10,32,58,.55)',
      }}
    >
      <div style={{ padding: '6px 9px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span data-testid="strike-plan-index" style={badgeNum}>{index + 1}</span>
        <span
          data-testid="strike-plan-name"
          data-plan-name-raw={plan.name}
          style={{ fontSize: 12.5, color: C.text, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {planTitle(plan.name)}
        </span>
        {/* 绿角标「推荐方案」：只认引擎的 recommendedId / 候选自带的 recommendedHint */}
        {plan.recommended && <span data-testid="strike-recommend-badge" style={recBadge}>推荐方案</span>}
      </div>

      <div style={{ padding: '6px 9px 8px', display: 'flex', flexDirection: 'column', minHeight: 0, overflowY: 'auto' }}>
        <CRow k="打击方式" v={plan.method} miss="回执未给该字段" testid="strike-plan-method" />
        <CRow k="参与集群" v={clusters} miss="回执未给该字段" testid="strike-plan-clusters" />
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, padding: '2px 0' }}>
          <span style={{ color: C.textDim, width: 58, flex: '0 0 auto', fontSize: 11.5 }}>成功率预估</span>
          <span data-testid="strike-plan-success" style={{ fontSize: 17, color: C.accent, fontVariantNumeric: 'tabular-nums' }}>
            {plan.successRate !== undefined ? `${n2s(plan.successRate)}%` : '—'}
          </span>
          {plan.successRate === undefined && <span style={{ fontSize: 10, color: C.textDim }}>（回执未给该字段）</span>}
        </div>
        <CRow k="打击效果" v={plan.effect} miss="回执未给该字段" testid="strike-plan-effect" />
        {plan.clusters.length > 1 && (
          <div style={{ fontSize: 10, color: C.textDim }}>参与集群 {plan.clusters.length} 个（逐名见上）</div>
        )}
        {extras && (
          <div data-testid="strike-plan-extras" title={extras}
            style={{ marginTop: 4, borderTop: `1px solid ${C.border}`, paddingTop: 3, fontSize: 10, color: C.textDim, lineHeight: 1.5 }}>
            引擎字段：{extras}
          </div>
        )}
        {plan.inapplicableReasons.length > 0 && (
          <div style={{ fontSize: 10, color: C.warn, marginTop: 3 }}>不适用原因：{plan.inapplicableReasons.join('；')}</div>
        )}
      </div>
    </div>
  )
}

export function StrikeScreen({ state, flow, selectedPlanId, onSelectPlan, onNext, onGo }: {
  state: FlowState
  flow: UseFlow
  /** 由本屏选中/采纳的方案（步 9 要沿用同一个 planId） */
  selectedPlanId: string | null
  onSelectPlan: (id: string) => void
  /** 进入步 9（切步一律发 `flow.goto`，step 归宿主；App 未传时由 `onGo` 承担切屏） */
  onNext?: () => void
  /** 切到另一屏（只改本地屏路由）—— SH-13 → SH-14 */
  onGo?: (id: string) => void
}) {
  // ---- 进屏发一次（幂等读命令）----
  const plans = useVerbOnce(flow, 'strike.plans', { count: 3 }, true)
  const compose = useVerbOnce(flow, 'view.compose', { phase: state.phase || 'T5' }, true)
  const pv = useMemo(() => readStrikePlans(plans.data), [plans.data])
  const cmp = readCompose(compose.data)
  const labels = useLabels()

  const recPlan = pv.plans.find((p) => p.id === pv.recommendedId) ?? pv.plans.find((p) => p.recommended)
  const badgeCount = pv.plans.filter((p) => p.recommended).length
  // 当前选中：显式选中 → 引擎推荐 → 第一张（**不按成功率自己排"最优"**）
  const selected = pv.plans.find((p) => p.id === selectedPlanId) ?? recPlan ?? pv.plans[0]

  const tools = cmp.tools
  const toolOn = (key: string) => tools.find((t) => t.key === key)?.on ?? false
  const toolHint = (key: string, fallback: string) => {
    const t = tools.find((x) => x.key === key)
    if (!t) return fallback
    if (t.on) return undefined
    return t.reason ?? '宿主未声明该工具可用'
  }
  const toolbar = [
    { key: 'select', label: '选择', on: toolOn('select') || !tools.length, hint: toolHint('select', 'view.compose 未声明「选择」工具') },
    { key: 'measure', label: '测距', hint: toolHint('measure', '测距未实现（消费侧 map-2d 未提供该工具）') },
    { key: 'layer', label: '图层', hint: toolHint('layer', '图层未实现（图层开关由 view.compose 下发）') },
    { key: 'mode3d', label: '3D', sub: '2D/3D', on: true },
  ]

  const goNext = () => {
    if (onNext) onNext()          // 有 onNext（发 flow.goto）时先走流程
    onGo?.('SH-14')               // 再切屏（只改本地屏路由，步号归宿主）
  }

  return (
    <div data-testid="sh-13" data-screen="SH-13" style={wrap}>
      <MapToolbar items={toolbar} />
      <div data-testid="sh13-mode" style={{ ...modePill, right: RAIL_W + 12 }}>
        <span style={{ color: C.textDim }}>显示模式：</span>
        <span style={{ color: C.text }}>{cmp.modeName ?? cmp.modeKey ?? '任务规划'}</span>
        <span style={{ color: C.textDim }}>⌄</span>
      </div>

      {/* ---------------- 地图下方：「打击方案」3 张卡 ---------------- */}
      <div data-testid="sh13-plans" style={cardsStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 2px 6px' }}>
          <span style={{ fontSize: 13, color: C.text, letterSpacing: 0.5 }}>打击方案</span>
          <span data-testid="strike-plan-count" style={{ fontSize: 11.5, color: C.accent }}>方案 {pv.plans.length}</span>
          {/* 推荐标记只认引擎；0 个 = 引擎没指定，>1 个 = 回执自相矛盾，界面都如实说 */}
          <span data-testid="strike-recommend-count" style={{ fontSize: 11.5, color: badgeCount === 1 ? C.ok : C.warn }}>
            推荐标记 {badgeCount} 个{pv.recommendedId ? `（recommendedId=${pv.recommendedId}）` : '（回执未给 recommendedId → 引擎未指定推荐）'}
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 10.5, color: C.textDim }}>
            方案名/方式/集群/成功率/效果均取 `strike.plans` 回执；「方案N」后的空格按图显示为「：」
          </span>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'stretch', flex: 1, minHeight: 0, overflowX: 'auto' }}>
          {pv.plans.map((p, i) => (
            <PlanCard key={p.id} plan={p} index={i} selected={p.id === selected?.id} onSelect={() => onSelectPlan(p.id)} />
          ))}
          {pv.plans.length === 0 && (
            <div data-testid="sh13-plans-empty" style={{ ...panel, flex: 1, padding: 13, fontSize: 12.5, color: C.textDim, lineHeight: 1.9 }}>
              <div>打击方案未就绪：`strike.plans` 没有返回候选方案。</div>
              {plans.sent && plans.reply && plans.reply.code !== 0 && (
                <div style={{ color: C.warn }}>strike.plans → {replyText(plans.reply)}</div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ---------------- 右栏整栏：「AI语音交互」 ---------------- */}
      <div style={railCol}>
        <VoiceStrip labels={labels} screen="sh13" title="AI语音交互" />
        <Section title="当前方案" right="strike.plans" testid="sh13-current">
          <div data-testid="strike-current-plan" style={{ fontSize: 12.5, color: C.accent }}>
            {selected ? planTitle(selected.name) : '—'}
          </div>
          <div style={{ fontSize: 11, color: C.textDim, lineHeight: 1.6 }}>
            {selected?.id ? `planId=${selected.id}` : '未返回方案'}
            {selected?.successRate !== undefined ? ` · 成功率预估 ${n2s(selected.successRate)}%` : ''}
            {recPlan ? ` · 引擎推荐：${planTitle(recPlan.name)}` : ' · 引擎未指定推荐'}
          </div>
          <div style={{ fontSize: 10.5, color: C.textDim, lineHeight: 1.6, marginTop: 3 }}>
            点卡片 = 选中（`onSelectPlan`）；图上**没有**"确认"按钮（§6 E-22）→ 本屏不加确认/采纳按钮，
            采纳（`strike.adopt`）由下一屏【生成打击任务】承担（§4.3）。
          </div>
        </Section>
        <div style={{ flex: 1 }} />
        {/* 图上无按钮；进入下一屏的这一颗是全屏唯一的动作（step 10 的采纳仍在 SH-14） */}
        <button data-testid="btn-strike-next" style={primaryBtn} onClick={goNext}>
          {/* 旧 testid 别名（图上没有"采纳"按钮，采纳动作在 SH-14）：挂在文字上，点击冒泡到本按钮 */}
          <span
            data-testid="btn-strike-adopt"
            data-alias-of="btn-strike-next"
            title="旧 testid 别名：本屏唯一的前进按钮（进入 SH-14）。图上无「采纳」按钮（E-22），strike.adopt 由 SH-14【生成打击任务】承担"
            style={{ display: 'inline-block' }}
          >进入打击确认</span>
          <span style={{ fontSize: 15, letterSpacing: -1 }}> ≫</span>
        </button>
        {plans.reply && plans.reply.code !== 0 && (
          <div data-testid="sh13-plans-err" style={{ fontSize: 11, color: C.warn, lineHeight: 1.6 }}>
            strike.plans → {replyText(plans.reply)}
          </div>
        )}
        <div style={{ fontSize: 10.5, color: C.textDim, lineHeight: 1.6 }}>
          view.compose：{compose.reply === null ? '读取中…' : compose.reply.code === 0 ? `code=0（${cmp.visibleGroups.length} 图层组）` : replyText(compose.reply)}
          {pv.missingInputs.length > 0 ? ` · 采集口径提示：${pv.missingInputs.join('；')}` : ''}
        </div>
      </div>

      <StrikeProbe
        step={state.step}
        phase={state.phase}
        plansReply={plans.reply}
        plansRaw={plans.data}
        pv={pv}
        selectedId={selected?.id ?? null}
      />
    </div>
  )
}

/** 自证句柄 `__sh13Stats`（并保留旧键 `__p5Stats`，供既有排障脚本读；**只读**）。 */
function StrikeProbe(props: {
  step: number
  phase: string
  plansReply: import('../api').CommandReply | null
  plansRaw: unknown
  pv: ReturnType<typeof readStrikePlans>
  selectedId: string | null
}) {
  const { step, phase, plansReply, plansRaw, pv, selectedId } = props
  const stats = {
    screen: 'SH-13',
    step,
    phase,
    plans: {
      reply: plansReply,
      raw: plansRaw ?? null,
      count: pv.plans.length,
      recommendedId: pv.recommendedId ?? null,
      recommendedPercent: pv.recommendedPercent ?? null,
      rows: pv.plans.map((p) => ({
        id: p.id, name: p.name, recommended: p.recommended,
        method: p.method ?? null, effect: p.effect ?? null,
        successRate: p.successRate ?? null, clusters: p.clusters,
        coordination: p.coordination ?? null, coordinationCN: p.coordinationCN,
        plannedMinutes: p.plannedFinish?.minutes ?? null,
        plannedBasis: p.plannedFinish?.basis ?? null,
      })),
    },
    selectedId,
    dom: {
      cards: document.querySelectorAll('[data-testid="strike-plan-card"]').length,
      recommendBadges: document.querySelectorAll('[data-testid="strike-recommend-badge"]').length,
      selected: document.querySelector('[data-testid="strike-plan-card"][data-selected="1"]')?.getAttribute('data-plan-id') ?? null,
      hasNextBtn: !!document.querySelector('[data-testid="btn-strike-next"]'),
      /** **必须为 false**：图上没有"确认"/"采纳"按钮（E-22） */
      hasConfirmBtn: !!document.querySelector('[data-testid="btn-strike-confirm"]'),
      voice: document.querySelector('[data-testid="voice-sh13"]')?.textContent ?? null,
    },
  }
  const w = window as unknown as Record<string, unknown>
  w.__sh13Stats = stats
  w.__p5Stats = { ...((w.__p5Stats as Record<string, unknown> | undefined) ?? {}), ...stats }
  return null
}

// ---- 样式（一律 left/right/top/bottom 长写：**不写 inset 简写**，见 App.tsx 的踩坑注释）----
const RAIL_W = 320
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
  background: 'transparent', border: '1px solid transparent', color: C.text,
}
const modePill: CSSProperties = {
  position: 'absolute', top: 0, zIndex: 22, display: 'flex', gap: 6, alignItems: 'center',
  padding: '7px 12px', borderRadius: 999, fontSize: 12.5,
  background: 'rgba(6,26,47,.86)', border: `1px solid ${C.border}`,
}
const cardsStyle: CSSProperties = {
  position: 'absolute', left: 0, right: RAIL_W + 12, bottom: 26, height: 214,
  display: 'flex', flexDirection: 'column', minHeight: 0,
}
const railCol: CSSProperties = {
  position: 'absolute', right: 0, top: 44, bottom: 26, width: RAIL_W, zIndex: 21,
  display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
}
const badgeNum: CSSProperties = {
  width: 17, height: 17, borderRadius: 5, flex: '0 0 auto', textAlign: 'center', lineHeight: '16px',
  fontSize: 11, color: C.accent, border: `1px solid ${C.border}`, background: 'rgba(95,176,255,.08)',
}
const recBadge: CSSProperties = {
  fontSize: 10.5, color: '#0b2b16', background: 'linear-gradient(180deg,#34d399,#22c55e)',
  border: '1px solid rgba(34,197,94,.7)', borderRadius: 4, padding: '0 6px', flex: '0 0 auto',
}
const primaryBtn: CSSProperties = {
  padding: '11px 16px', fontSize: 14, cursor: 'pointer', borderRadius: 8, whiteSpace: 'nowrap',
  letterSpacing: 1, border: '1px solid rgba(34,197,94,.6)',
  background: 'linear-gradient(180deg,#16a34a,#15803d)', color: '#eafff2',
}

export default StrikeScreen
