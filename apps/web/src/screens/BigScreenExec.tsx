// mission-app · apps/web/src/screens/BigScreenExec.tsx
//
// **SH-19 大屏 · 任务执行态势（参考图 `需求图与描述\第二屏.png`）**
//
// 版式（照图，**自成一壳**——图上没有左导航 / 底部 6 段状态条 / 麦克风 / 地图工具条 / 显示模式 / 比例尺，
// 所以本文件**不引用** `AppShell`、`LeftNav`、`BottomStatusBar`、`MicBall`）：
//   顶部：居中大标题「智能任务管理系统 - 任务执行态势」；右上「系统时间 HH:MM:SS」「任务状态 ×××」
//   左栏：「当前任务」「任务阶段」「完成进度 %」（进度条）
//   中区：态势图位（**纯 SVG 示意图**：区域/重点侦察区/战术小组/无人机能力角标 + 右下角图例）
//   右栏：「无人资源状态」（四型各 N 架）与「链路状态」（四条链路 %）
//   底部：「任务执行流程」六段（任务下达 / 方案生成 / 资源调度 / 区域搜索 / 目标确认 / 任务完成）
//
// ★ 为什么不画真实地理底图：本屏**不做地理投影**（那要么引入地图实例、要么自己算坐标）。
//   图位里的形状是**示意绘制**（不含经纬度），右上角如实标注；真实数值全部走下面这些 verb/负载：
//     · `situation.snapshot`（任务名 / 集群 / 平台台账）· `alloc.inventory`（四型架数，台账口径）
//     · `sensor.status`（四型平台数 / 覆盖率）· `topology.evaluate`（逐链路 score/state）
//     · `mission.timeline`（phase::durations 的逐阶段 enteredAt/dwellMs；`/api/state` 的 timeline 同源）
//     · `/api/state`（step/stepKey/stepTitle/phase/missionId/enteredAt/statusBar/capabilities）
//
// ★ 数值纪律（需求专篇 G-09）：图上给的是示意值（重点区域侦察 / 67% / 各 4 架 / 各 100% / 14:05…），
//   **一个都不写死**：字段拿不到就显示"—"并把原因写在卡面小字里（宁缺勿编）。
//
// 样式：`theme.ts` 令牌；不用 `backdrop-filter`；**不用 `inset` 简写**（与 `top` 混用会清掉 top）。
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { C, panel, panelTitle } from '../theme'
import type { FlowState } from '../api'
import type { UseFlow } from '../flow/useFlow'
import { n2s, num, obj, objList, pick, readInventory, readSituation, str, useVerbOnce, type InventoryView } from '../flow/useSituation'
import { linkColor, readSensor, readTopology } from '../flow/useOps'
import { readDurations } from '../flow/useExec'

/** 四型（图上的四行；域 → 图上逐字文案。`linkLabel` 是「链路状态」卡上的逐字文案）。 */
const TYPES: { key: string; label: string; linkLabel: string; badge: string; prefix: string }[] = [
  { key: 'optical', label: '光电侦察', linkLabel: '光电链路', badge: '相机', prefix: 'opt' },
  { key: 'radar', label: '雷达侦察', linkLabel: '雷达链路', badge: '雷达', prefix: 'rad' },
  { key: 'electronic', label: '电子侦察', linkLabel: '电子链路', badge: '电子', prefix: 'ew' },
  { key: 'comm', label: '通信中继', linkLabel: '通信链路', badge: '通信', prefix: 'com' },
]

/**
 * 「任务执行流程」六段 ↔ phase-engine 的阶段键。
 *
 * 这张映射表**不是编的**：阶段键与其含义来自宿主自己的 `/runtime-config.steps[]`
 * （step↔phase↔title：3→T0 任务态势、4/5→T1 编组、6→T2 任务执行、7→T4 目标显示、
 * 8/9→T5 打击决策与确认、10→T6 协同执行、11→T7 总结；T3 = 侦察展开，见需求专篇 §4.3）。
 * 界面上每段的时刻会**把命中的阶段键一起显示**（如 `14:05 · T0`），便于对账。
 */
const STAGES: { name: string; phases: string[] }[] = [
  { name: '任务下达', phases: ['T0'] },
  { name: '方案生成', phases: ['T1'] },
  { name: '资源调度', phases: ['T2'] },
  { name: '区域搜索', phases: ['T3', 'T4'] },
  { name: '目标确认', phases: ['T5'] },
  { name: '任务完成', phases: ['T7'] },
]

/** 一行「名 + 值」。 */
function Row({ k, v, color, sub, testid }: { k: string; v: string; color?: string; sub?: string; testid?: string }) {
  return (
    <div data-testid={testid} style={{ padding: '3px 0' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12.5 }}>
        <span style={{ color: C.textDim, flex: 1, minWidth: 0 }}>{k}</span>
        <span style={{ color: color ?? C.text, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{v}</span>
      </div>
      {sub && <div style={{ fontSize: 9.5, color: C.textDim, lineHeight: 1.45, wordBreak: 'break-word' }}>{sub}</div>}
    </div>
  )
}

function Card({ title, children, testid, right, style }: {
  title: ReactNode
  children: ReactNode
  testid?: string
  right?: ReactNode
  style?: CSSProperties
}) {
  return (
    <div data-testid={testid} style={{ ...panel, boxSizing: 'border-box', ...style }}>
      <div style={{ ...panelTitle, padding: '7px 12px', fontSize: 13 }}>
        {title}
        {right !== undefined && <span style={{ float: 'right', fontSize: 10.5, color: C.textDim }}>{right}</span>}
      </div>
      <div style={{ padding: '6px 12px 8px' }}>{children}</div>
    </div>
  )
}

/** 时刻：epoch ms → `HH:MM`（只做格式化）。 */
function hhmm(ms?: number): string {
  if (ms === undefined) return '—'
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function BigScreenExec({ state, flow, onGo, goto }: {
  state: FlowState
  flow: UseFlow
  onGo?: (id: string) => void
  goto?: (step: number) => void
}) {
  // 大屏是独立壳，图上没有按钮：这两个可选 prop 只用于"自证/排障"读数（不渲染任何控件）
  void onGo; void goto

  // ---- ① 系统时间（真实时钟；图上逐字「系统时间 HH:MM:SS」）----
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(t)
  }, [])
  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`

  // ---- ② 台账与读数（全部只读 verb；进屏发一次）----
  const snap = useVerbOnce(flow, 'situation.snapshot', {}, true)
  const inv = useVerbOnce(flow, 'alloc.inventory', {}, true)
  const sen = useVerbOnce(flow, 'sensor.status', {}, true)
  const topo = useVerbOnce(flow, 'topology.evaluate', {}, true)
  const mtime = useVerbOnce(flow, 'mission.timeline', {}, true)

  const sv = useMemo(() => readSituation(snap.data), [snap.data])
  const iv: InventoryView | null = useMemo(() => (inv.data ? readInventory(inv.data) : null), [inv.data])
  const sens = useMemo(() => readSensor(sen.data), [sen.data])
  const tv = useMemo(() => readTopology(topo.data), [topo.data])
  /** 时间轴：`mission.timeline` 优先，回执未就绪时用 `/api/state.timeline`（同一份 phase::durations）。 */
  const stateTimeline = obj(state as unknown as Record<string, unknown>, 'timeline')
  const dv = useMemo(
    () => readDurations(mtime.data ?? (stateTimeline && obj(stateTimeline, 'durations') ? stateTimeline : undefined)),
    [mtime.data, stateTimeline],
  )

  // ---- ③ 左栏：当前任务 / 任务阶段 / 完成进度 ----
  const missionName = sv.mission?.name ?? undefined
  const phaseName = state.stepTitle || state.stepKey || undefined
  /** 完成进度：只在宿主**真有**进度类字段时显示（本工程实测没有 → "—" + 原因）。 */
  const progress = useMemo<{ value?: number; src: string }>(() => {
    const cands: [string, unknown][] = [
      ['state.timeline.durations', obj(stateTimeline, 'durations')],
      ['mission.timeline', mtime.data],
      ['situation.snapshot.mission', sv.mission],
    ]
    for (const [src, scope] of cands) {
      const v = num(scope, 'progress', 'progressPercent', 'percent', 'completion', '完成进度')
      if (v !== undefined) return { value: v <= 1 ? Number((v * 100).toFixed(0)) : v, src }
    }
    return { src: '' }
  }, [stateTimeline, mtime.data, sv.mission])
  const coverage = sens.coverage

  // ---- ④ 右栏：无人资源状态（四型各 N 架）----
  const resourceRows = useMemo(() => TYPES.map((t) => {
    const row = iv?.rows.find((r) => r.key.toLowerCase() === t.key || r.name.includes(t.label.slice(0, 2)))
    if (row && (row.available !== undefined || row.total !== undefined)) {
      const v = row.available ?? row.total
      return {
        ...t, value: v, unit: row.unit ?? '架',
        src: `alloc.inventory（可用 ${row.available ?? '—'} / 编制 ${row.total ?? '—'}）`,
        missing: undefined as string | undefined,
      }
    }
    const byType = sens.byType.find((b) => b.key.toLowerCase() === t.key)
    if (byType?.platforms !== undefined) {
      return { ...t, value: byType.platforms, unit: '架', src: 'sensor.status.byType.platforms（引擎按机型汇总）', missing: undefined }
    }
    const n = (snap.data ? objList(snap.data, 'platforms') : []).filter((p) => str(p, 'typeKey', 'type') === t.key).length
    if (n > 0) {
      return { ...t, value: n, unit: '架', src: 'situation.snapshot.platforms[].typeKey 计数（台账）', missing: undefined }
    }
    return {
      ...t, value: undefined, unit: '架', src: '',
      missing: inv.reply
        ? `无该型台账行（alloc.inventory → code=${inv.reply.code}）`
        : 'alloc.inventory 未就绪，且 sensor.status.byType / snapshot.platforms 都没有该型',
    }
  }), [iv, sens.byType, snap.data, inv.reply])

  // ---- ⑤ 右栏：链路状态（四条链路 %；取 topology.evaluate 的逐链路 score/state）----
  const rawLinks = useMemo(() => objList(topo.data, 'links'), [topo.data])
  const linkRows = useMemo(() => TYPES.map((t) => {
    const mine = rawLinks.filter((l) => {
      const id = (str(l, 'linkId', 'from', 'id') ?? '').toLowerCase()
      return id.startsWith(`uav-${t.prefix}-`) || id.includes(`-${t.prefix}-`)
    })
    if (mine.length === 0) {
      return {
        ...t, count: 0, value: undefined as number | undefined, stateText: '—', color: C.unknown,
        note: topo.reply ? `拓扑里没有 ${t.label}（linkId 前缀 uav-${t.prefix}-*）——topology.evaluate code=${topo.reply.code}` : 'topology.evaluate 未就绪',
      }
    }
    // 只对"引擎真给了 score"的链路做一致性判断：全都同分才敢显示（**不平均、不折算**）
    const scored = mine.map((l) => ({ l, s: num(l, 'score', 'quality') })).filter((x): x is { l: Record<string, unknown>; s: number } => x.s !== undefined)
    const uniq = [...new Set(scored.map((x) => x.s))]
    const states = [...new Set(mine.map((l) => str(l, 'state', 'status')).filter(Boolean) as string[])]
    const same = uniq.length === 1
    const value = same ? (uniq[0] <= 1 ? Number((uniq[0] * 100).toFixed(0)) : uniq[0]) : undefined
    const stateText = states.length === 1 ? states[0] : states.join('/')
    return {
      ...t, count: mine.length, value,
      stateText: stateText || '—',
      color: states.length === 1 ? linkColor(states[0]) : C.unknown,
      note: scored.length === 0
        ? `${mine.length} 条链路都没有 score 字段（引擎未给分值）→ 显示"—"，只有 state=${stateText}`
        : same
          ? `${scored.length}/${mine.length} 条有 score=${uniq[0]}（0–1 → ×100）· state=${stateText}`
          : `${scored.length}/${mine.length} 条有 score，分值不一致（${uniq.map((s) => n2s(s)).join('/')}）→ 显示"—"（不做平均，MUST NOT 折算）`,
    }
  }), [rawLinks, topo.reply])
  // ---- ⑥ 底部：任务执行流程六段（phase::durations 的 enteredAt）----
  const stageRows = useMemo(() => {
    const byPhase = new Map<string, { enteredAt?: number; dwellMs?: number; current?: boolean }>()
    for (const s of dv.segs) byPhase.set(s.phase.toUpperCase(), { enteredAt: s.enteredAt, dwellMs: s.dwellMs, current: s.current })
    const cur = (state.phase || '').toUpperCase()
    return STAGES.map((st, i) => {
      const hitKey = st.phases.map((p) => p.toUpperCase()).find((p) => byPhase.has(p))
      const hit = hitKey ? byPhase.get(hitKey) : undefined
      const isCurrent = (hit?.current === true) || (!!cur && st.phases.map((p) => p.toUpperCase()).includes(cur))
      const done = !!hit && !isCurrent
      const status = isCurrent ? '执行中' : done ? '已完成' : '待执行'
      const time = hit?.enteredAt !== undefined ? hhmm(hit.enteredAt) : undefined
      return {
        name: st.name, phases: st.phases.join('/'), phaseKey: hitKey ?? st.phases[0],
        time, status, done, isCurrent,
        note: hit
          ? `phase::durations · ${hitKey} · enteredAt=${hit.enteredAt ?? '—'} · dwellMs=${hit.dwellMs ?? '—'}`
          : `该阶段（${st.phases.join('/')}）未出现在 phase::durations → 时刻"—"`,
        idx: i,
      }
    })
  }, [dv.segs, state.phase])

  /** 任务状态：由宿主事实推出（并写明依据）——missionId / phase::durations.endedAt / step。 */
  const missionState = useMemo(() => {
    if (!state.missionId) return { text: '未进入任务', basis: 'state.missionId 为空' }
    const ended = dv.segs.length > 0 && dv.segs.every((s) => s.leftAt !== undefined)
    if (state.step >= 11 || ended) return { text: '已完成', basis: `state.step=${state.step}${ended ? ' · durations 各段都已离开' : ''}` }
    return { text: '执行中', basis: `state.missionId=${state.missionId} · step=${state.step} · phase=${state.phase || '—'}` }
  }, [state.missionId, state.step, state.phase, dv.segs])

  // ---- ⑦ 自证句柄（只读；不改渲染）----
  useEffect(() => {
    const w = window as unknown as { __big19Stats?: Record<string, unknown> }
    w.__big19Stats = {
      screen: 'SH-19',
      step: state.step, stepKey: state.stepKey, stepTitle: state.stepTitle, phase: state.phase, missionId: state.missionId ?? null,
      clock,
      missionState,
      currentTask: missionName ?? null,
      progress,
      coverage: coverage ? { key: coverage.key, value: coverage.value ?? null, unit: coverage.unit ?? null, text: coverage.text ?? null } : null,
      resources: resourceRows.map((r) => ({ type: r.key, label: r.label, value: r.value ?? null, unit: r.unit, src: r.src, missing: r.missing ?? null })),
      links: linkRows.map((l) => ({ type: l.key, label: l.label, count: l.count, value: l.value ?? null, state: l.stateText, note: l.note })),
      stages: stageRows.map((s) => ({ name: s.name, phases: s.phases, phaseKey: s.phaseKey, time: s.time ?? null, status: s.status, note: s.note })),
      durations: { segCount: dv.segs.length, totalMs: dv.totalMs ?? null, missionId: dv.missionId ?? null, segs: dv.segs.map((s) => ({ phase: s.phase, enteredAt: s.enteredAt ?? null, leftAt: s.leftAt ?? null, dwellMs: s.dwellMs ?? null })) },
      /** 中区图位：本屏是**示意绘制**（无经纬度），不参与任何数值断言 */
      mapPanel: { schematic: true, geo: false },
      dom: {
        title: document.querySelector('[data-testid="big19-title"]')?.textContent ?? null,
        clock: document.querySelector('[data-testid="big19-clock"]')?.textContent ?? null,
        stageCount: document.querySelectorAll('[data-testid="big19-stage"]').length,
        resourceCount: document.querySelectorAll('[data-testid="big19-resource-row"]').length,
        linkCount: document.querySelectorAll('[data-testid="big19-link-row"]').length,
      },
    }
  }, [state, clock, missionState, missionName, progress, coverage, resourceRows, linkRows, stageRows, dv])

  return (
    <div data-testid="sh-19" data-screen="SH-19" style={rootStyle}>
      {/* ---------------- 顶部：居中大标题 + 右上系统时间/任务状态 ---------------- */}
      <header style={headerStyle}>
        <div data-testid="big19-title" style={{ flex: 1, textAlign: 'center', fontSize: 21, letterSpacing: 1.5, color: '#eaf3ff', textShadow: '0 0 14px rgba(56,189,248,.35)' }}>
          智能任务管理系统 - 任务执行态势
        </div>
        <div style={{ display: 'flex', gap: 14, alignItems: 'baseline', whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: 12.5, color: C.textDim }}>系统时间 <span data-testid="big19-clock" style={{ color: C.text, fontVariantNumeric: 'tabular-nums' }}>{clock}</span></span>
          <span style={{ fontSize: 12.5, color: C.textDim }} title={missionState.basis}>
            任务状态 <span data-testid="big19-mission-state" style={{ color: missionState.text === '执行中' ? C.ok : C.text }}>{missionState.text}</span>
          </span>
        </div>
      </header>

      {/* ---------------- 中区：左栏 + 图位 + 右栏 ---------------- */}
      <main style={mainStyle}>
        <aside style={{ width: 210, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
          <Card title="当前任务" testid="big19-task-card">
            <div data-testid="big19-task-name" style={{ fontSize: 15, color: missionName ? C.text : C.muted, lineHeight: 1.4 }}>
              {missionName ?? '—'}
            </div>
            <div style={{ fontSize: 9.5, color: C.textDim, marginTop: 3, lineHeight: 1.45 }}>
              {sv.mission?.name
                ? `situation.snapshot.mission.name${sv.mission.id ? ` · missionId=${sv.mission.id}` : ''}`
                : `宿主未给任务名（situation.snapshot → ${snap.reply ? `code=${snap.reply.code}` : '未就绪'}）`}
            </div>
          </Card>
          <Card title="任务阶段" testid="big19-phase-card">
            <div data-testid="big19-phase" style={{ fontSize: 14, color: phaseName ? C.text : C.muted }}>{phaseName ?? '—'}</div>
            <div style={{ fontSize: 9.5, color: C.textDim, marginTop: 3, lineHeight: 1.45 }}>
              /api/state：step {state.step}/11 · phase {state.phase || '—'} · stepKey {state.stepKey || '—'}
            </div>
          </Card>
          <Card title="完成进度" testid="big19-progress-card" right={progress.value !== undefined ? progress.src : '无字段'}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span data-testid="big19-progress" style={{ fontSize: 22, color: progress.value === undefined ? C.muted : C.text, fontVariantNumeric: 'tabular-nums' }}>
                {progress.value !== undefined ? `${progress.value}%` : '—'}
              </span>
            </div>
            <div style={{ height: 9, borderRadius: 4, marginTop: 5, background: 'rgba(6,26,47,.9)', border: `1px solid ${C.border}`, overflow: 'hidden' }}>
              <div style={{ width: `${progress.value ?? 0}%`, height: '100%', background: progress.value === undefined ? 'transparent' : C.accent }} />
            </div>
            <div style={{ fontSize: 9.5, color: progress.value === undefined ? C.warn : C.textDim, marginTop: 4, lineHeight: 1.5 }}>
              {progress.value === undefined
                ? '宿主未给「完成进度 / progress」字段（`/api/state`、`mission.timeline`、`situation.snapshot` 都没有）→ 空条 + 原因（不折算、不编百分比）'
                : `来源 ${progress.src}（≤1 视为比例 → ×100）`}
              {coverage && (
                <span>
                  <br />参考：区域覆盖率 {coverage.value !== undefined ? n2s(coverage.value, coverage.unit ?? '%') : (coverage.text ?? '—')}（sensor.status.coverageRatio）
                </span>
              )}
            </div>
          </Card>
        </aside>

        {/* ---- 中区图位（**纯 SVG 示意图**：不含经纬度；真实数值在左右栏） ---- */}
        <section style={{ flex: 1, minWidth: 0, ...panel, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ ...panelTitle, padding: '6px 12px', fontSize: 13 }}>
            任务执行态势图
            <span style={{ float: 'right', fontSize: 10.5, color: C.warn }}>示意图（区域与平台为示意绘制，不含经纬度；真实读数见左右栏）</span>
          </div>
          <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            <SearchSketch resources={resourceRows} coverage={coverage?.value} />
            {/* 右下角图例（图上逐字三项） */}
            <div data-testid="big19-legend" style={legendStyle}>
              <div style={{ fontSize: 11.5, color: C.textDim, marginBottom: 3 }}>图例</div>
              <LegendRow color="#38bdf8" dashed label="当前搜索区域" />
              <LegendRow color="#f59e0b" dashed label="重点侦察区域" />
              <LegendRow color="rgba(95,176,255,.45)" label="已覆盖区域" />
            </div>
          </div>
        </section>

        <aside style={{ width: 232, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
          <Card title="无人资源状态" testid="big19-resource-card" right="alloc.inventory / sensor.status">
            {resourceRows.map((r) => (
              <div key={r.key} data-testid="big19-resource-row" data-type={r.key} data-value={r.value ?? ''} data-src={r.src}
                style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '3px 0' }}>
                <span style={{ width: 26, height: 18, borderRadius: 4, border: `1px solid ${C.borderStrong}`, fontSize: 10, color: C.accent, textAlign: 'center', lineHeight: '18px', flex: '0 0 auto' }}>{r.badge}</span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: C.text }}>{r.label}</span>
                <span style={{ fontSize: 13.5, color: r.value === undefined ? C.muted : C.text, fontVariantNumeric: 'tabular-nums' }}>
                  {r.value !== undefined ? `${r.value} ${r.unit}` : '—'}
                </span>
              </div>
            ))}
            <div style={{ fontSize: 9.5, color: C.textDim, lineHeight: 1.45, marginTop: 2 }}>
              {resourceRows.every((r) => r.value === undefined)
                ? `四型架数都取不到：${resourceRows[0]?.missing ?? '台账未就绪'}`
                : '数值来源逐行标注（台账行优先，其次 sensor.status.byType，最后 snapshot.platforms 计数）'}
            </div>
          </Card>

          <Card title="链路状态" testid="big19-link-card" right={topo.reply ? `topology.evaluate code=${topo.reply.code}` : 'topology.evaluate 未就绪'}>
            {linkRows.map((l) => (
              <div key={l.key} data-testid="big19-link-row" data-type={l.key} data-value={l.value ?? ''} data-links={l.count}
                style={{ padding: '3px 0' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: C.text }}>{l.linkLabel}</span>
                  <span style={{ fontSize: 12.5, color: l.value === undefined ? C.muted : C.text, fontVariantNumeric: 'tabular-nums' }}>
                    {l.value !== undefined ? `${l.value}%` : '—'}
                  </span>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: l.color, flex: '0 0 auto' }} />
                </div>
                <div style={{ height: 6, borderRadius: 3, marginTop: 3, background: 'rgba(6,26,47,.9)', border: `1px solid ${C.border}`, overflow: 'hidden' }}>
                  <div style={{ width: `${l.value ?? 0}%`, height: '100%', background: l.value === undefined ? 'transparent' : l.color }} />
                </div>
                <div style={{ fontSize: 9.5, color: l.value === undefined ? C.warn : C.textDim, lineHeight: 1.4 }}>{l.note}</div>
              </div>
            ))}
            <div style={{ fontSize: 9.5, color: C.textDim, lineHeight: 1.45 }}>
              四条链路 = 逐链路 score 按 `linkId` 前缀（uav-opt/rad/ew/com-*）归并；**同一型分值一致才显示**，不一致显示"—"。
            </div>
          </Card>
        </aside>
      </main>

      {/* ---------------- 底部：任务执行流程 六段 ---------------- */}
      <footer style={footerStyle}>
        <span style={{ fontSize: 13.5, color: C.text, marginRight: 6 }}>任务执行流程</span>
        {stageRows.map((s) => (
          <div key={s.name} data-testid="big19-stage" data-name={s.name} data-time={s.time ?? ''} data-status={s.status} data-phase={s.phaseKey}
            title={s.note}
            style={{
              flex: '1 1 0', minWidth: 0, display: 'flex', alignItems: 'center', gap: 8,
              border: `1px solid ${s.isCurrent ? C.borderStrong : C.border}`, borderRadius: 8,
              background: s.isCurrent ? 'rgba(29,78,216,.28)' : 'rgba(10,32,58,.6)', padding: '5px 9px',
            }}>
            <span style={{
              width: 18, height: 18, borderRadius: '50%', flex: '0 0 auto', fontSize: 11, lineHeight: '18px', textAlign: 'center',
              border: `1px solid ${s.done ? C.ok : C.border}`, color: s.done ? C.ok : (s.isCurrent ? C.accent : C.textDim),
              background: s.done ? 'rgba(34,197,94,.15)' : 'transparent',
            }}>{s.done ? '✓' : (s.isCurrent ? '▶' : '○')}</span>
            <span style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5, color: C.text, whiteSpace: 'nowrap' }}>{s.name}</div>
              <div data-testid="big19-stage-time" style={{ fontSize: 11, color: s.time ? C.text : (s.isCurrent ? C.accent : C.textDim), fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                {s.time ? `${s.time} · ${s.phaseKey}` : `${s.status} · ${s.phaseKey}`}
              </div>
            </span>
          </div>
        ))}
        <span style={{ fontSize: 9.5, color: C.textDim, maxWidth: 210, lineHeight: 1.4 }}>
          时刻取 phase::durations 的该阶段 enteredAt（`mission.timeline` / `/api/state.timeline` 同源）；
          段名 ↔ 阶段键的映射见源码 STAGES 表（依据宿主 /runtime-config.steps[] 的 step↔phase↔title）。
        </span>
      </footer>
    </div>
  )
}

// ============================================================================
// 中区示意图（纯 SVG；**不含经纬度**，也不显示任何"看起来像数据"的数字）
// ============================================================================

function LegendRow({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '1px 0' }}>
      <span style={{ width: 20, height: 0, borderTop: `2px ${dashed ? 'dashed' : 'solid'} ${color}`, flex: '0 0 auto' }} />
      <span style={{ fontSize: 11.5, color: C.text }}>{label}</span>
    </div>
  )
}

function SearchSketch({ resources, coverage }: {
  resources: { key: string; label: string; badge: string; value?: number }[]
  coverage?: number
}) {
  return (
    <svg width="100%" height="100%" viewBox="0 0 760 420" preserveAspectRatio="xMidYMid slice" style={{ display: 'block' }}>
      {/* 底纹（网格，纯装饰） */}
      <defs>
        <pattern id="big19-grid" width="38" height="38" patternUnits="userSpaceOnUse">
          <path d="M38 0 H0 V38" fill="none" stroke="rgba(95,176,255,.10)" strokeWidth="1" />
        </pattern>
      </defs>
      <rect x="0" y="0" width="760" height="420" fill="#04182f" />
      <rect x="0" y="0" width="760" height="420" fill="url(#big19-grid)" />

      {/* 已覆盖区域（半透明面）——**只是图例语义的示意绘制** */}
      <path d="M120 120 L360 70 L620 150 L560 330 L220 340 Z" fill="rgba(95,176,255,.10)" stroke="rgba(95,176,255,.35)" strokeWidth="1.4" />

      {/* 核心搜索区（蓝色虚线） */}
      <ellipse cx="380" cy="205" rx="150" ry="95" fill="none" stroke="#38bdf8" strokeWidth="1.8" strokeDasharray="8 6" />
      <text x="380" y="215" textAnchor="middle" fontSize="13" fill="#9fd8ff">核心搜索区</text>

      {/* 西侧 / 北侧重点侦察区（黄色虚线椭圆） */}
      <ellipse cx="190" cy="290" rx="96" ry="52" fill="none" stroke="#f59e0b" strokeWidth="1.6" strokeDasharray="7 5" />
      <text x="190" y="294" textAnchor="middle" fontSize="12" fill="#f5c26b">西侧重点侦察区</text>
      <ellipse cx="588" cy="118" rx="94" ry="48" fill="none" stroke="#f59e0b" strokeWidth="1.6" strokeDasharray="7 5" />
      <text x="588" y="122" textAnchor="middle" fontSize="12" fill="#f5c26b">北侧重点侦察区</text>

      {/* 战术小组（绿色人形标记） */}
      <g transform="translate(300,352)">
        <circle cx="0" cy="0" r="13" fill="rgba(34,197,94,.16)" stroke="#22c55e" strokeWidth="1.4" />
        <path d="M0 -7 v8 M-5 3 l5 -4 l5 4" fill="none" stroke="#22c55e" strokeWidth="1.6" strokeLinecap="round" />
        <text x="18" y="5" fontSize="12" fill="#8ff0b5">战术小组</text>
      </g>

      {/* 四型无人机图标（能力角标）——位置为示意图位；数量角标**只在台账给了数时显示** */}
      {resources.map((r, i) => {
        const pos: [number, number][] = [[210, 150], [520, 90], [560, 300], [330, 250]]
        const [x, y] = pos[i] ?? [380, 200]
        return (
          <g key={r.key} transform={`translate(${x},${y})`}>
            <circle cx="0" cy="0" r="14" fill="rgba(56,189,248,.12)" stroke="#38bdf8" strokeWidth="1.4" />
            <path d="M-9 -5 L9 5 M9 -5 L-9 5 M0 0 v0" stroke="#cfe3f5" strokeWidth="1.4" />
            <rect x="12" y="-22" width="34" height="15" rx="3" fill="rgba(6,26,47,.9)" stroke="#5fb0ff" strokeWidth="1" />
            <text x="29" y="-11" textAnchor="middle" fontSize="10" fill="#9fd8ff">{r.badge}</text>
            <text x="0" y="30" textAnchor="middle" fontSize="10.5" fill="#cfe3f5">
              {r.label}{r.value !== undefined ? ` ${r.value} 架` : ' —'}
            </text>
          </g>
        )
      })}

      {/* 虚线搜索航迹（示意；不含坐标语义） */}
      <path d="M120 250 C 220 170, 320 300, 430 230 S 620 180, 690 250" fill="none" stroke="#38bdf8" strokeWidth="1.5" strokeDasharray="6 5" opacity="0.8" />

      <text x="14" y="24" fontSize="11.5" fill={C.textDim}>态势图位（示意绘制）</text>
      {coverage !== undefined && (
        <text x="14" y="42" fontSize="11.5" fill={C.textDim}>已覆盖 {n2s(coverage, '%')}（sensor.status.coverageRatio）</text>
      )}
    </svg>
  )
}

// ---- 样式（一律 left/right/top/bottom 长写：**不写 inset 简写**）----
const rootStyle: CSSProperties = {
  position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
  display: 'flex', flexDirection: 'column', gap: 8, padding: '6px 12px 10px', boxSizing: 'border-box',
  background: 'radial-gradient(1200px 600px at 50% -10%, rgba(29,78,216,.25), rgba(4,24,47,0) 60%), #04182f',
  color: C.text, minHeight: 0,
}
const headerStyle: CSSProperties = {
  position: 'relative', height: 40, flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 12,
  borderBottom: `1px solid ${C.border}`,
}
const mainStyle: CSSProperties = {
  flex: 1, minHeight: 0, display: 'flex', gap: 10, alignItems: 'stretch',
}
const legendStyle: CSSProperties = {
  position: 'absolute', right: 10, bottom: 10, zIndex: 3,
  border: `1px solid ${C.border}`, borderRadius: 8, background: 'rgba(6,26,47,.88)', padding: '6px 10px',
}
const footerStyle: CSSProperties = {
  flex: '0 0 auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'nowrap',
  borderTop: `1px solid ${C.border}`, paddingTop: 7,
}

export default BigScreenExec
