// mission-app · apps/web/src/screens/BigScreenRecon.tsx
//
// **SH-20 大屏 · 红方侦察态势（参考图 `需求图与描述\第三屏.png`）**
//
// 版式（照图，**自成一壳**——图上没有左导航 / 底部状态条 / 麦克风 / 工具条 / 比例尺，
// 所以本文件**不引用** `AppShell`、`LeftNav`、`BottomStatusBar`、`MicBall`）：
//   顶部：居中大标题「智能任务管理系统 - 红方侦察态势」；右上「系统时间 HH:MM:SS」「任务状态 ×××」
//   左栏：「信息汇聚来源」（侦察集群 1–4 / 发现目标 N 个 + 历史情报关联 / 关联目标 N 个）
//   中栏：「红方综合态势图」（图位 + 标注位 + 左下角图例「威胁等级 高/中/低」）
//   右栏：「AI态势研判」（3 行）与「态势统计」（4 行）
//   底部：「情报关联关系图」六节点链（通信节点—指挥节点—火力阵地—装甲目标—集结区域—后勤保障节点）
//
// ★ 本屏必须说清楚的一件事（**没有来源就不许编**）：
//   参考图讲的是"**红方**侦察集群 + 情报关联"，而本工程（场景一）的台账里**只有我方平台/目标**，
//   引擎也没有"红方侦察集群""情报关联度""集结趋势""下一步行动建议"这些字段。所以：
//     · 左栏四条「侦察集群 i / 发现目标 N 个」→ 用**真实来源维度**（`targets.list` 的 `sources[]`：
//       光电 / 雷达 / 电子 / 通信 四型）计数，并在面板脚注**逐字写明这个替代表**；
//       台账没给就显示"—"并写明原因；**绝不写死 3/2/4/1**；
//     · 右栏「AI态势研判」三行：能对上台账事实的（疑似指挥节点的置信度/关联目标数）就显示并标注字段；
//       对不上的（集结趋势预计时间、下一步行动建议）显示"—（无数据来源）"；
//     · 中栏图位与底部关系图是**纯 SVG 示意结构**（图上就是这么画的；不含经纬度、不含数值）。
//
// ★ 数据来源（全部只读）：`targets.list`（目标 + sources[] + detection/统计块）、
//   `situation.snapshot`（集群/区域/威胁区/任务信息）、`topology.evaluate`（链路结论文本）、
//   `alloc.inventory`（编制口径）、`/api/state`（step/phase/missionId/statusBar/timeline）。
//
// 样式：`theme.ts` 令牌；不用 `backdrop-filter`；**不用 `inset` 简写**（与 `top` 混用会清掉 top）。
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { C, panel, panelTitle } from '../theme'
import type { FlowState } from '../api'
import type { UseFlow } from '../flow/useFlow'
import { isObj, n2s, num, objList, readSituation, str, strList, useVerbOnce } from '../flow/useSituation'
import { readTargets, readTopology, type TargetRow } from '../flow/useOps'
import { readDurations } from '../flow/useExec'

/** 左栏四条 ↔ 真实来源维度（**替代表**：台账里没有"红方侦察集群"这个实体）。 */
const CLUSTERS: { label: string; type: string; cn: string }[] = [
  { label: '侦察集群 1', type: 'optical', cn: '光电' },
  { label: '侦察集群 2', type: 'radar', cn: '雷达' },
  { label: '侦察集群 3', type: 'electronic', cn: '电子' },
  { label: '侦察集群 4', type: 'comm', cn: '通信' },
]

/** 底部「情报关联关系图」六节点（图上逐字；**纯示意结构**，不是数据）。 */
const CHAIN = ['通信节点', '指挥节点', '火力阵地', '装甲目标', '集结区域', '后勤保障节点']

/** 中栏图上的标注位（图上逐字；示意位置，不绑数据）。 */
const MAP_LABELS: { text: string; x: number; y: number; kind: 'node' | 'suspect' }[] = [
  { text: '通信节点', x: 300, y: 78, kind: 'node' },
  { text: '指挥节点', x: 168, y: 120, kind: 'node' },
  { text: '火力阵地', x: 250, y: 208, kind: 'node' },
  { text: '装甲目标', x: 392, y: 246, kind: 'node' },
  { text: '疑似通联群 1', x: 560, y: 92, kind: 'suspect' },
]

/**
 * 在宿主 JSON 里按 key 找第一个标量（**防御式读取**：同一语义试多个键名）。
 * 返回命中的路径与值——界面把它一并显示出来，便于对账"这个数是回执里哪个字段"。
 */
function deepFind(v: unknown, keys: string[], depth = 0, path = ''): { path: string; value: string | number | boolean } | undefined {
  if (depth > 6 || v === null || v === undefined) return undefined
  if (Array.isArray(v)) {
    for (const [i, it] of v.slice(0, 24).entries()) {
      const hit = deepFind(it, keys, depth + 1, `${path}[${i}]`)
      if (hit) return hit
    }
    return undefined
  }
  if (isObj(v)) {
    for (const [k, val] of Object.entries(v)) {
      const p = path ? `${path}.${k}` : k
      if (keys.some((n) => k.toLowerCase() === n.toLowerCase()) && (typeof val === 'number' || typeof val === 'string' || typeof val === 'boolean')) {
        return { path: p, value: val }
      }
      const hit = deepFind(val, keys, depth + 1, p)
      if (hit) return hit
    }
  }
  return undefined
}

/** 一个目标是否由某型来源发现（`sources[]` 里出现该型的英文键或中文名）。 */
function fromSource(t: TargetRow, type: string, cn: string): boolean {
  const hay = `${t.source ?? ''} ${JSON.stringify(t.raw ?? {})}`.toLowerCase()
  return hay.includes(type.toLowerCase()) || hay.includes(cn)
}

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

export function BigScreenRecon({ state, flow, onGo, goto }: {
  state: FlowState
  flow: UseFlow
  onGo?: (id: string) => void
  goto?: (step: number) => void
}) {
  // 大屏是独立壳，图上没有按钮：这两个可选 prop 不渲染任何控件（保留签名兼容）
  void onGo; void goto

  // ---- 系统时间（真实时钟）----
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(t)
  }, [])
  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`

  // ---- 数据面（只读）----
  const tlist = useVerbOnce(flow, 'targets.list', {}, true)
  const snap = useVerbOnce(flow, 'situation.snapshot', {}, true)
  const topo = useVerbOnce(flow, 'topology.evaluate', {}, true)
  const mtime = useVerbOnce(flow, 'mission.timeline', {}, true)

  const tl = useMemo(() => readTargets(tlist.data), [tlist.data])
  const sv = useMemo(() => readSituation(snap.data), [snap.data])
  const tv = useMemo(() => readTopology(topo.data), [topo.data])
  const dv = useMemo(() => readDurations(mtime.data), [mtime.data])

  const tlistCode = tlist.reply ? `targets.list code=${tlist.reply.code}` : 'targets.list 未就绪'
  const zones = useMemo(() => objList(snap.data, 'zones'), [snap.data])
  const targetsRaw = useMemo(() => objList(tlist.data, 'items', 'targets', 'entities', 'rows', 'list'), [tlist.data])

  // ---- ① 左栏「信息汇聚来源」：四条侦察集群 + 历史情报关联 ----
  const sourceRows = useMemo(() => CLUSTERS.map((c) => {
    // ㈠ 宿主自己给的按来源计数（detection/sources/bySource… 里的标量）
    const found = deepFind(tlist.data, [`bySource.${c.type}`, `${c.type}Count`, `${c.type}`, `source.${c.type}`])
    if (found && typeof found.value === 'number') {
      return { ...c, value: found.value, src: `targets.list · ${found.path}=${found.value}` }
    }
    // ㈡ 台账逐目标计数（`sources[]` 里出现该型）——**前端只做筛选计数**，值来自台账
    if (tl.items.length > 0) {
      const n = tl.items.filter((t) => fromSource(t, c.type, c.cn)).length
      return { ...c, value: n, src: `targets.list.items[] 中 sources[] 含「${c.cn}」的目标数（共 ${tl.items.length} 个）` }
    }
    return {
      ...c, value: undefined as number | undefined,
      src: `无数据来源：${tlistCode}${tlist.reply && tlist.reply.code !== 0 ? `（${tlist.reply.error?.message ?? ''}）` : ''}，且回执里没有 bySource.${c.type}`,
    }
  }), [tlist.data, tlist.reply, tl.items, tlistCode])

  const historyRow = useMemo(() => {
    const found = deepFind(tlist.data, ['historicLinked', 'historyLinked', 'linkedCount', 'associatedCount', 'relations', 'linked'])
    if (found) return { value: String(found.value), src: `targets.list · ${found.path}=${String(found.value)}` }
    const multi = tl.items.filter((t) => t.multiSource === true)
    if (multi.length > 0) {
      return { value: String(multi.length), src: `targets.list.items[] 中 multiSource=true 的目标数（多源关联口径，共 ${tl.items.length} 个）` }
    }
    return { value: undefined as string | undefined, src: `无数据来源：${tlistCode}，且回执里没有关联/历史情报类字段（也不含 multiSource=true 的目标）` }
  }, [tlist.data, tlist.reply, tl.items, tlistCode])

  // ---- ② 右栏「AI态势研判」三行 ----
  /**
   * 疑似指挥节点：先查 `targets.list`（探测后的台账），**未就绪时回落 `situation.snapshot.targets[]`**
   * （场景初始台账，同样带 `confidence`）——两处都是宿主负载，界面把命中的那一处写在来源行里。
   */
  const cmdTarget = useMemo(() => {
    const hit = tl.items.find((t) => /指挥|cmd/i.test(`${t.typeKey ?? ''} ${t.name ?? ''} ${t.typeName ?? ''}`))
    if (hit) {
      const conf = hit.confidence
      return {
        name: hit.name || hit.typeName || hit.entityId,
        confidence: conf !== undefined ? (conf <= 1 ? Number((conf * 100).toFixed(1)) : conf) : undefined,
        related: hit.sourceCount ?? (hit.source ? hit.source.split('/').length : undefined),
        src: `targets.list · entityId=${hit.entityId}${hit.typeKey ? ` · typeKey=${hit.typeKey}` : ''}`,
      }
    }
    const raw = objList(snap.data, 'targets').find((t) => /指挥|cmd/i.test(`${str(t, 'typeKey', 'type') ?? ''} ${str(t, 'name') ?? ''}`))
    if (raw) {
      const conf = num(raw, 'confidence', 'confidencePercent')
      return {
        name: str(raw, 'name') ?? str(raw, 'typeKey') ?? '—',
        confidence: conf !== undefined ? (conf <= 1 ? Number((conf * 100).toFixed(1)) : conf) : undefined,
        related: undefined as number | undefined,
        src: `situation.snapshot.targets[]（场景初始台账；targets.list → ${tlist.reply ? `code=${tlist.reply.code}` : '未就绪'}）`,
      }
    }
    return null
  }, [tl.items, snap.data, tlist.reply])

  const trend = useMemo(() => {
    const a = deepFind(tlist.data, ['gatheringTrend', 'assemblyTrend', 'trend', 'etaMinutes', 'expectedMinutes', 'eta'])
    if (a) return { value: String(a.value), src: `targets.list · ${a.path}=${String(a.value)}` }
    const b = deepFind(snap.data, ['gatheringTrend', 'assemblyTrend', 'etaMinutes', 'expectedMinutes'])
    if (b) return { value: String(b.value), src: `situation.snapshot · ${b.path}=${String(b.value)}` }
    return { value: undefined as string | undefined, src: '无数据来源（引擎未提供集结趋势 / 预计时间字段）' }
  }, [tlist.data, snap.data])

  const advice = useMemo(() => {
    const fromTopo = strList(topo.data, 'advice', 'recommendation', 'conclusions').concat(tv.advice)
    if (fromTopo.length > 0) return { value: fromTopo[0], src: 'topology.evaluate · advice[]' }
    const notes = strList(snap.data, 'notes').filter((n) => /建议|加强|优先/.test(n))
    if (notes.length > 0) return { value: notes[0], src: 'situation.snapshot · notes[]' }
    return { value: undefined as string | undefined, src: '无数据来源（回执里没有"下一步行动建议"类文本）' }
  }, [topo.data, tv.advice, snap.data])

  // ---- ③ 右栏「态势统计」四行 ----
  const stats = useMemo(() => {
    const pick = (keys: string[], label: string, fallback?: () => { value?: number; src: string } | undefined) => {
      const found = deepFind(tlist.data, keys)
      if (found && (typeof found.value === 'number' || !Number.isNaN(Number(found.value)))) {
        return { label, value: Number(found.value), src: `targets.list · ${found.path}=${String(found.value)}` }
      }
      const fb = fallback?.()
      if (fb && fb.value !== undefined) return { label, value: fb.value, src: fb.src }
      return { label, value: undefined as number | undefined, src: `无数据来源：${tlistCode}，且回执里没有 ${keys[0]} 类计数` }
    }
    const highZones = zones.filter((z) => {
      const lv = (str(z, 'level') ?? '').toLowerCase()
      const kind = (str(z, 'kind') ?? '').toLowerCase()
      return lv === 'high' || kind === 'threat'
    }).length
    return [
      pick(['confirmedTargets', 'confirmedCount', 'confirmed'], '已确认目标'),
      pick(['suspectedTargets', 'suspectCount', 'suspected'], '疑似目标'),
      pick(['linkedTargets', 'associatedCount', 'linkedCount', 'linked'], '关联目标', () => {
        const n = tl.items.filter((t) => t.multiSource === true).length
        return n > 0 ? { value: n, src: `targets.list.items[] 中 multiSource=true 的计数（共 ${tl.items.length} 个）` } : undefined
      }),
      pick(['highThreatAreas', 'highThreatAreaCount'], '高威胁区域', () => (
        highZones > 0 ? { value: highZones, src: `situation.snapshot.zones[] 中 level=high 或 kind=threat 的计数（共 ${zones.length} 个区域）` } : undefined
      )),
    ]
  }, [tlist.data, tlist.reply, tl.items, zones, tlistCode])

  // ---- ④ 任务状态（由宿主事实推出，依据写在 title 里）----
  const missionState = useMemo(() => {
    if (!state.missionId) return { text: '未进入任务', basis: 'state.missionId 为空' }
    const ended = dv.segs.length > 0 && dv.segs.every((s) => s.leftAt !== undefined)
    if (state.step >= 11 || ended) return { text: '已完成', basis: `state.step=${state.step}` }
    return { text: '执行中', basis: `state.missionId=${state.missionId} · step=${state.step} · phase=${state.phase || '—'}` }
  }, [state.missionId, state.step, state.phase, dv.segs])

  // ---- ⑤ 自证句柄 ----
  useEffect(() => {
    const w = window as unknown as { __big20Stats?: Record<string, unknown> }
    w.__big20Stats = {
      screen: 'SH-20',
      step: state.step, phase: state.phase, missionId: state.missionId ?? null,
      clock,
      missionState,
      sources: sourceRows.map((r) => ({ label: r.label, type: r.type, value: r.value ?? null, src: r.src })),
      history: historyRow,
      aiJudgement: {
        cmdNode: cmdTarget,
        trend,
        advice,
      },
      stats,
      topology: { links: tv.links.length, adviceCount: tv.advice.length },
      zones: zones.length,
      targets: { replyCode: tlist.reply?.code ?? null, count: tl.items.length, raw: targetsRaw.length },
      /** 中栏图位与底部关系图：**纯示意结构**（无经纬度、无数值），不参与数值断言 */
      diagrams: { mapSchematic: true, chainSchematic: true, chain: CHAIN },
      dom: {
        title: document.querySelector('[data-testid="big20-title"]')?.textContent ?? null,
        clock: document.querySelector('[data-testid="big20-clock"]')?.textContent ?? null,
        sourceCount: document.querySelectorAll('[data-testid="big20-source-row"]').length,
        statCount: document.querySelectorAll('[data-testid="big20-stat-row"]').length,
        chainNodes: document.querySelectorAll('[data-testid="big20-chain-node"]').length,
      },
    }
  }, [state, clock, missionState, sourceRows, historyRow, cmdTarget, trend, advice, stats, tv, zones.length, tl, targetsRaw])

  return (
    <div data-testid="sh-20" data-screen="SH-20" style={rootStyle}>
      {/* ---------------- 顶部 ---------------- */}
      <header style={headerStyle}>
        <div data-testid="big20-title" style={{ flex: 1, textAlign: 'center', fontSize: 21, letterSpacing: 1.5, color: '#eaf3ff', textShadow: '0 0 14px rgba(56,189,248,.35)' }}>
          智能任务管理系统 - 红方侦察态势
        </div>
        <div style={{ display: 'flex', gap: 14, alignItems: 'baseline', whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: 12.5, color: C.textDim }}>系统时间 <span data-testid="big20-clock" style={{ color: C.text, fontVariantNumeric: 'tabular-nums' }}>{clock}</span></span>
          <span style={{ fontSize: 12.5, color: C.textDim }} title={missionState.basis}>
            任务状态 <span data-testid="big20-mission-state" style={{ color: missionState.text === '执行中' ? C.ok : C.text }}>{missionState.text}</span>
          </span>
        </div>
      </header>

      {/* ---------------- 中区：左（信息汇聚来源）+ 汇聚箭头 + 中（态势图）+ 右（研判/统计） ---------------- */}
      <main style={mainStyle}>
        <aside style={{ width: 216, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
          <Card title="信息汇聚来源" testid="big20-source-card" right="targets.list">
            {sourceRows.map((r) => (
              <div key={r.label} data-testid="big20-source-row" data-label={r.label} data-value={r.value ?? ''} data-src={r.src}
                style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0', borderBottom: '1px solid rgba(95,176,255,.12)' }}>
                {/* 小图标（图上是一条横线 + 圆点的抽象无人机标；纯装饰） */}
                <svg width={20} height={14} viewBox="0 0 20 14" style={{ flex: '0 0 auto' }}>
                  <path d="M2 7 H18 M6 3 L14 11 M14 3 L6 11" stroke={C.accent} strokeWidth="1.2" />
                </svg>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, color: C.text }}>{r.label}</div>
                  <div style={{ fontSize: 9.5, color: C.textDim, lineHeight: 1.4 }}>{r.src}</div>
                </span>
                <span data-testid="big20-source-value" style={{ fontSize: 13, color: r.value === undefined ? C.muted : C.text, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                  发现目标 {r.value !== undefined ? `${r.value} 个` : '—'}
                </span>
              </div>
            ))}
            <div data-testid="big20-source-row" data-label="历史情报关联" data-value={historyRow.value ?? ''} data-src={historyRow.src}
              style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}>
              <svg width={20} height={14} viewBox="0 0 20 14" style={{ flex: '0 0 auto' }}>
                <circle cx="10" cy="7" r="5" fill="none" stroke={C.warn} strokeWidth="1.2" />
                <path d="M10 2 v10" stroke={C.warn} strokeWidth="1.2" />
              </svg>
              <span style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, color: C.text }}>历史情报关联</div>
                <div style={{ fontSize: 9.5, color: C.textDim, lineHeight: 1.4 }}>{historyRow.src}</div>
              </span>
              <span style={{ fontSize: 13, color: historyRow.value === undefined ? C.muted : C.text, whiteSpace: 'nowrap' }}>
                关联目标 {historyRow.value !== undefined ? `${historyRow.value} 个` : '—'}
              </span>
            </div>
            <div style={{ fontSize: 9.5, color: C.warn, lineHeight: 1.45, marginTop: 4 }}>
              替代表（必须写清）：本工程台账里没有"红方侦察集群"实体 → 侦察集群 1–4 依次对应
              **光电 / 雷达 / 电子 / 通信** 四个来源维度（按 `targets.list` 的 `sources[]` 计数）。
            </div>
          </Card>
        </aside>

        {/* 「多源信息汇聚」箭头（图上在左栏与地图之间） */}
        <div style={arrowColStyle} data-testid="big20-arrow">
          <svg width={54} height={54} viewBox="0 0 54 54">
            <path d="M4 18 H34" stroke={C.accent} strokeWidth="6" opacity="0.85" />
            <path d="M30 10 L46 18 L30 26 Z" fill={C.accent} opacity="0.9" />
            <path d="M4 40 H34" stroke={C.accent} strokeWidth="6" opacity="0.6" />
            <path d="M30 32 L46 40 L30 48 Z" fill={C.accent} opacity="0.65" />
          </svg>
          <div style={{ fontSize: 12, color: C.text, marginTop: 4, whiteSpace: 'nowrap' }}>多源信息汇聚</div>
        </div>

        {/* 中栏图位（纯 SVG 示意） */}
        <section style={{ flex: 1, minWidth: 0, ...panel, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ ...panelTitle, padding: '6px 12px', fontSize: 13 }}>
            红方综合态势图
            <span style={{ float: 'right', fontSize: 10.5, color: C.warn }}>示意图（标注位为示意绘制，不含经纬度；数值见左右栏）</span>
          </div>
          <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            <ReconSketch sourceRows={sourceRows} />
            {/* 左下角图例（图上逐字：威胁等级 高/中/低） */}
            <div data-testid="big20-legend" style={legendStyle}>
              <div style={{ fontSize: 11.5, color: C.textDim, marginBottom: 3 }}>威胁等级</div>
              <ThreatRow color={C.bad} label="高" />
              <ThreatRow color={C.warn} label="中" />
              <ThreatRow color="#22c55e" label="低" />
            </div>
          </div>
        </section>

        {/* 右栏：AI态势研判 + 态势统计 */}
        <aside style={{ width: 268, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
          <Card title="AI态势研判" testid="big20-ai-card" right="targets.list / topology.evaluate">
            {/* ① 疑似指挥节点（台账里真有 cmdNode 型目标时显示其置信度与关联数） */}
            <div data-testid="big20-ai-row" data-kind="cmd" data-has={cmdTarget?.confidence !== undefined ? '1' : '0'} style={{ padding: '4px 0', borderBottom: '1px solid rgba(95,176,255,.12)' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ width: 22, height: 22, borderRadius: 5, border: `1px solid ${C.bad}`, color: C.bad, fontSize: 11, textAlign: 'center', lineHeight: '22px', flex: '0 0 auto' }}>红</span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: C.text }}>发现疑似指挥节点</span>
                <span style={{ fontSize: 12.5, color: cmdTarget?.confidence !== undefined ? C.text : C.muted, whiteSpace: 'nowrap' }}>
                  {cmdTarget?.confidence !== undefined ? `置信度 ${n2s(cmdTarget.confidence)}%` : '置信度 —'}
                </span>
              </div>
              <div style={{ fontSize: 10.5, color: C.textDim, lineHeight: 1.45, marginTop: 2 }}>
                {cmdTarget
                  ? `${cmdTarget.name} · 关联目标 ${cmdTarget.related !== undefined ? `${cmdTarget.related} 个` : '—'} · ${cmdTarget.src}`
                  : `无数据来源（台账里没有名字/类型含「指挥」的目标）· ${tlistCode}`}
              </div>
            </div>

            {/* ② 目标集结趋势 */}
            <div data-testid="big20-ai-row" data-kind="trend" data-has={trend.value !== undefined ? '1' : '0'} style={{ padding: '4px 0', borderBottom: '1px solid rgba(95,176,255,.12)' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ width: 22, height: 22, borderRadius: 5, border: `1px solid ${C.warn}`, color: C.warn, fontSize: 11, textAlign: 'center', lineHeight: '22px', flex: '0 0 auto' }}>势</span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: C.text }}>发现目标集结趋势</span>
                <span style={{ fontSize: 12.5, color: trend.value !== undefined ? C.text : C.muted, whiteSpace: 'nowrap' }}>
                  {trend.value !== undefined ? trend.value : '—'}
                </span>
              </div>
              <div style={{ fontSize: 10.5, color: C.textDim, lineHeight: 1.45, marginTop: 2 }}>
                {trend.value !== undefined ? trend.src : `${trend.src}（图上"预计 20 分钟后 / 向东侧区域转移"不写死）`}
              </div>
            </div>

            {/* ③ 建议下一步行动 */}
            <div data-testid="big20-ai-row" data-kind="advice" data-has={advice.value !== undefined ? '1' : '0'} style={{ padding: '4px 0' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ width: 22, height: 22, borderRadius: 5, border: `1px solid ${C.ok}`, color: C.ok, fontSize: 11, textAlign: 'center', lineHeight: '22px', flex: '0 0 auto' }}>议</span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: C.text }}>建议下一步行动</span>
              </div>
              <div style={{ fontSize: 11.5, color: advice.value !== undefined ? C.text : C.muted, lineHeight: 1.5, marginTop: 2 }}>
                {advice.value !== undefined ? advice.value : '—'}
              </div>
              <div style={{ fontSize: 10.5, color: C.textDim, lineHeight: 1.45 }}>
                {advice.src}{advice.value === undefined ? '（图上"加强东北方向侦察"不写死）' : ''}
              </div>
            </div>
          </Card>

          <Card title="态势统计" testid="big20-stats-card" right={tlistCode}>
            {stats.map((s) => (
              <div key={s.label} data-testid="big20-stat-row" data-label={s.label} data-value={s.value ?? ''} data-src={s.src}
                style={{ padding: '3px 0' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12.5 }}>
                  <span style={{ flex: 1, minWidth: 0, color: C.textDim }}>{s.label}</span>
                  <span style={{ color: s.value === undefined ? C.muted : C.text, fontVariantNumeric: 'tabular-nums' }}>
                    {s.value !== undefined ? `${s.value} 个` : '—'}
                  </span>
                </div>
                <div style={{ fontSize: 9.5, color: s.value === undefined ? C.warn : C.textDim, lineHeight: 1.4, wordBreak: 'break-word' }}>{s.src}</div>
              </div>
            ))}
            <div style={{ fontSize: 9.5, color: C.textDim, lineHeight: 1.45, marginTop: 2 }}>
              只显示引擎/台账真给了的计数；取不到的显示"—"并写明"无数据来源"（图上的 15/9/24/3 是示意值）。
            </div>
          </Card>

          {/* 引擎侧的其它真实读数（有就显示，没有就空着——不算图上的元素） */}
          {(tv.links.length > 0 || zones.length > 0) && (
            <Card title="引擎读数（旁证）" testid="big20-side-card">
              <Row k="链路条数" v={String(tv.links.length)} sub="topology.evaluate · links[]" testid="big20-side-links" />
              <Row k="空域/威胁区" v={String(zones.length)} sub="situation.snapshot · zones[]" testid="big20-side-zones" />
              {sv.groups.length > 0 && <Row k="我方编组" v={`${sv.groups.length} 个`} sub="situation.snapshot · groups[]（供「多源信息汇聚」对账）" />}
            </Card>
          )}
        </aside>
      </main>

      {/* ---------------- 底部：情报关联关系图（六节点链；**纯示意结构**） ---------------- */}
      <footer style={footerStyle}>
        <div style={{ fontSize: 13.5, color: C.text, marginBottom: 4 }}>
          情报关联关系图
          <span style={{ fontSize: 10, color: C.textDim, marginLeft: 8 }}>（示意结构：节点与连线由界面绘制，不代表任何引擎研判结果）</span>
        </div>
        <svg width="100%" height="62" viewBox="0 0 1000 62" preserveAspectRatio="xMidYMid meet">
          {CHAIN.map((name, i) => {
            const x = 70 + i * 168
            return (
              <g key={name} data-testid="big20-chain-node" data-node={name}>
                <rect x={x - 52} y={10} width={104} height={34} rx={7} fill="rgba(10,32,58,.85)" stroke={C.borderStrong} />
                <text x={x} y={32} textAnchor="middle" fontSize="13" fill={C.text}>{name}</text>
                <circle cx={x - 36} cy={27} r={5} fill="none" stroke={C.accent} strokeWidth="1.3" />
                {i < CHAIN.length - 1 && (
                  <g>
                    <path d={`M${x + 54} 27 H${x + 108}`} stroke={C.accent} strokeWidth="1.6" />
                    <path d={`M${x + 102} 22 L${x + 112} 27 L${x + 102} 32 Z`} fill={C.accent} />
                  </g>
                )}
              </g>
            )
          })}
        </svg>
      </footer>
    </div>
  )
}

/** 一格图例。 */
function ThreatRow({ color, label }: { color: string; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '1px 0' }}>
      <span style={{ width: 10, height: 10, borderRadius: 2, background: color, flex: '0 0 auto' }} />
      <span style={{ fontSize: 11.5, color: C.text }}>{label}</span>
    </div>
  )
}

/** 中栏「红方综合态势图」示意图（纯 SVG：热力块 + 标注位 + 侦察集群标注位）。 */
function ReconSketch({ sourceRows }: { sourceRows: { label: string; value?: number; cn: string }[] }) {
  return (
    <svg width="100%" height="100%" viewBox="0 0 760 420" preserveAspectRatio="xMidYMid slice" style={{ display: 'block' }}>
      <defs>
        <radialGradient id="big20-heat-red" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="rgba(239,68,68,.55)" />
          <stop offset="100%" stopColor="rgba(239,68,68,0)" />
        </radialGradient>
        <radialGradient id="big20-heat-yellow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="rgba(245,158,11,.45)" />
          <stop offset="100%" stopColor="rgba(245,158,11,0)" />
        </radialGradient>
        <pattern id="big20-grid" width="40" height="40" patternUnits="userSpaceOnUse">
          <path d="M40 0 H0 V40" fill="none" stroke="rgba(95,176,255,.08)" strokeWidth="1" />
        </pattern>
      </defs>
      <rect x="0" y="0" width="760" height="420" fill="#04182f" />
      <rect x="0" y="0" width="760" height="420" fill="url(#big20-grid)" />

      {/* 热力区块（威胁等级图例的语义就用它表达；纯示意） */}
      <ellipse cx="560" cy="190" rx="180" ry="120" fill="url(#big20-heat-red)" />
      <ellipse cx="330" cy="250" rx="150" ry="100" fill="url(#big20-heat-yellow)" />

      {/* 标注位（图上逐字：指挥节点 / 通信节点 / 火力阵地 / 装甲目标 / 疑似通联群 1） */}
      {MAP_LABELS.map((l) => (
        <g key={l.text} transform={`translate(${l.x},${l.y})`}>
          {l.kind === 'suspect'
            ? <rect x={-58} y={-14} width={116} height={28} rx={6} fill="rgba(6,26,47,.85)" stroke={C.border} strokeDasharray="5 4" />
            : <rect x={-46} y={-13} width={92} height={26} rx={6} fill="rgba(6,26,47,.85)" stroke={C.border} />}
          <circle cx={l.kind === 'suspect' ? -40 : -30} cy={0} r={5} fill="none" stroke={l.kind === 'suspect' ? C.warn : C.bad} strokeWidth="1.3" />
          <text x={l.kind === 'suspect' ? 4 : -18} y={4} textAnchor="middle" fontSize="11.5" fill={C.text}>
            {l.kind === 'suspect' ? '？' : ''}
          </text>
          <text x={l.kind === 'suspect' ? 26 : 16} y={5} textAnchor="middle" fontSize="11.5" fill={C.text}>
            {l.kind === 'suspect' ? l.text : l.text}
          </text>
        </g>
      ))}

      {/* 侦察集群标注位（数值来自左栏同一份台账口径；没有就显示"—"） */}
      {sourceRows.slice(1, 4).map((r, i) => {
        const pos: [number, number][] = [[470, 330], [620, 300], [250, 140]]
        const [x, y] = pos[i] ?? [400, 300]
        return (
          <g key={r.label} transform={`translate(${x},${y})`}>
            <rect x={-64} y={-15} width={128} height={30} rx={6} fill="rgba(6,26,47,.85)" stroke={C.border} />
            <circle cx={-50} cy={0} r={5} fill="none" stroke={C.accent} strokeWidth="1.3" />
            <text x={6} y={-2} textAnchor="middle" fontSize="11" fill={C.text}>{r.label}</text>
            <text x={6} y={11} textAnchor="middle" fontSize="10" fill={C.textDim}>
              发现目标 {r.value !== undefined ? `${r.value} 个` : '—'}
            </text>
          </g>
        )
      })}

      {/* 通联连线（示意） */}
      <path d="M168 120 L300 78 L560 92" fill="none" stroke="rgba(239,68,68,.55)" strokeWidth="1.3" strokeDasharray="5 4" />
      <path d="M250 208 L392 246" fill="none" stroke="rgba(56,189,248,.5)" strokeWidth="1.3" />
      <text x="14" y="24" fontSize="11.5" fill={C.textDim}>态势图位（示意绘制）</text>
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
const arrowColStyle: CSSProperties = {
  flex: '0 0 auto', width: 74, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
}
const legendStyle: CSSProperties = {
  position: 'absolute', left: 10, bottom: 10, zIndex: 3,
  border: `1px solid ${C.border}`, borderRadius: 8, background: 'rgba(6,26,47,.88)', padding: '6px 10px',
}
const footerStyle: CSSProperties = {
  flex: '0 0 auto', borderTop: `1px solid ${C.border}`, paddingTop: 5, height: 88, boxSizing: 'border-box',
}

export default BigScreenRecon
