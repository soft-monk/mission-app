// mission-app · apps/web/src/screens/ReconExpandScreen.tsx
//
// **侦察展开地图界面（需求专篇 DES-APP-001 SH-09，参考图 `场景1\T3-1.png`，1536×1024）**。
//
// 版式（本屏是**覆盖层**：底下的 `MapStage` 由 App 渲染，本文件只往地图上摆浮层）：
//   · 左上：地图工具栏 5 键「选择 / 测距 / 测面 / 图层 / 3D · 2D/3D」（工具条本体在 shell/MapTools）
//   · 右上：显示模式胶囊「显示模式：侦察展开」
//   · 地图：**6 个扁平半透明六边形**（两排三列，各含一枚四旋翼图标与标签）
//   · 右栏：「集群总体状态」6 条（圆点 + 名称 + 在线 / 信号强度 / 电量 +【更多详情 >】）
//   · 右下麦克风球与底部 6 段状态条由框架（AppShell）提供
//
// ★ 纪律：
//   ① **数值一律来自宿主**：集群清单/名称/机型/平台数取 `situation.snapshot`（groups + platforms）；
//   ② 图上是"电量 78%"这类数：宿主的快照里**没有**集群级聚合电量，但 `platforms[].battery`
//      是真实字段 → 本屏显示的是**该集群各架真实电量的均值**，并在界面上写明"n 架均值"，
//      绝不冒充宿主的聚合值；**信号强度宿主未给出**（无该字段，`sensor.status` 也没有）→ 显示"—"
//      并写明"引擎/宿主未给出"，MUST NOT 编一个"强/中"；
//   ③ **不做图上没有的东西**（§6 E-17：图上前出轨迹 / 扫描扇区 / 热点标记**全部未见**）；
//   ④ 六边形的屏幕落位**沿用参考图的示意排布**（地图台没有对外暴露"经纬度 → 屏幕"的投影），
//      界面上如实标注"示意位置"，集群本身的数据仍来自快照。
import { useMemo, useState, type CSSProperties } from 'react'
import { C, panel, panelTitle } from '../theme'
import type { FlowState } from '../api'
import type { UseFlow } from '../flow/useFlow'
import { isObj, n2s, replyText, useVerbOnce } from '../flow/useSituation'
import { MapToolbar, ToolModeNote, toolsOf, useMapToolState } from '../shell/MapTools'

type J = Record<string, unknown>

/** 分组配色（**照图**：集群1 蓝 / 集群2 绿 / 集群3 金黄 / 集群4 紫 / 集群5 青 / 集群6 橙）。 */
const CLUSTER_PALETTE = ['#3b82f6', '#22c55e', '#eab308', '#a855f7', '#06b6d4', '#f97316'] as const

/**
 * 本屏工具条的**键位与顺序逐字照参考图**（`场景1\T3-1.png`）：选择 / 测距 / 图层 / 3D(2D-3D)。
 * 「测面」插在「测距」后一格：map-2d 的量算本来就是测距/测面两档，图上只有一格"测距"，
 * 这是**有意偏差**（把已实现的量算真的接出来）；能不能点仍由规则包 view.compose 说了算。
 */
const SH09_TOOLS = toolsOf(['select', 'measure', 'measureArea', 'layers', 'mode3d', 'reset'])

/** 快照 `groups[].role` 域 → 中文机型（词典；不认识就原样显示域，不猜）。 */
const ROLE_CN: Record<string, string> = {
  optical: '光电', eo: '光电', recon: '侦察', photoelectric: '光电',
  radar: '雷达', sar: '雷达',
  electronic: '电子', ew: '电子', jammer: '电子', jamming: '电子',
  comm: '通信', relay: '通信', communication: '通信',
  reserve: '预备',
}

/** 信号强度域 → 中文（宿主给了才用；没给显示"—"）。 */
function signalCN(v?: string): string | undefined {
  if (!v) return undefined
  const s = v.toLowerCase()
  if (['strong', 'high', 'good', '强'].includes(s)) return '强'
  if (['medium', 'mid', 'moderate', '中'].includes(s)) return '中'
  if (['weak', 'low', '弱'].includes(s)) return '弱'
  return v
}

/** 一行集群状态（SH-10 的右栏是同一个面板，所以在这里导出）。 */
export interface ClusterRow {
  key: string
  /** 名称（宿主的 `groups[].name`；没有就退回落位名并标注） */
  name: string
  /** 名称是不是落位名（界面要如实标注） */
  nameFallback: boolean
  /** 机型标签（来自 `groups[].role` 字典；读不到就是"—"） */
  typeLabel?: string
  /** 原始机型域（明细行用） */
  roleDomain?: string
  platformCount?: number
  /** 在线平台数（**数平台，不判状态**） */
  online?: number
  /** 电量（宿主的聚合值优先；否则是该集群各架 `platforms[].battery` 的**均值** + 样本数） */
  battery?: number
  batteryFromMean?: boolean
  batterySamples?: number
  /** 信号强度（宿主给了才显示；没给就是 undefined → 界面显示"—"） */
  signal?: string
  /** 信号强度百分数（宿主给了才有；没给就不画进度条） */
  signalPercent?: number
  /** 在线状态词（宿主给了才有） */
  onlineWord?: string
  color: string
}

/** 读一列对象数组（防御式：不是数组就 []）。 */
function rows(v: unknown, key: string): J[] {
  if (!isObj(v)) return []
  const x = v[key]
  return Array.isArray(x) ? x.filter(isObj) : []
}

function strOf(v: unknown, key: string): string | undefined {
  if (!isObj(v)) return undefined
  const x = v[key]
  if (typeof x === 'string' && x) return x
  if (typeof x === 'number') return String(x)
  return undefined
}

function numOf(v: unknown, key: string): number | undefined {
  if (!isObj(v)) return undefined
  const x = v[key]
  if (typeof x === 'number' && Number.isFinite(x)) return x
  if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x))) return Number(x)
  return undefined
}

export interface ClusterStatusView {
  rows: ClusterRow[]
  /** 清单来源（界面必须写清楚） */
  from: 'snapshot' | 'none'
  notes: string[]
}

/**
 * 把 `situation.snapshot` 读成"集群总体状态"的行。
 *
 * **只做取字段 + 归类**：名称/机型/平台数是宿主的；电量取 `platforms[].battery` 的均值
 * （同一口径的恒等式计算，并标注样本数）；信号强度没有任何来源 → 留空（界面显示"—"）。
 */
export function readClusterStatus(data: unknown): ClusterStatusView {
  const snap = isObj(data) ? (isObj(data.snapshot) ? (data.snapshot as J) : data) : undefined
  const groupRows = rows(snap, 'groups').length ? rows(snap, 'groups') : rows(snap, 'clusters')
  const platRows = rows(snap, 'platforms').length ? rows(snap, 'platforms') : rows(snap, 'assets')

  interface Acc { batteries: number[]; count: number; online: number; signal?: string; signalPercent?: number }
  const acc = new Map<string, Acc>()
  const nameByKey = new Map<string, string>()
  for (const g of groupRows) {
    const key = strOf(g, 'key') ?? strOf(g, 'groupId') ?? strOf(g, 'id')
    const name = strOf(g, 'name') ?? strOf(g, 'label')
    if (key && name) nameByKey.set(key, name)
  }
  for (const p of platRows) {
    const gk = strOf(p, 'groupKey') ?? strOf(p, 'groupName') ?? '—'
    const a = acc.get(gk) ?? { batteries: [], count: 0, online: 0 }
    a.count += 1
    const b = numOf(p, 'battery')
    // 电量口径：0–100 直接收；0–1 的比例按 **×100** 显示（与 useSituation 的比例口径同一规则）
    if (b !== undefined) a.batteries.push(b <= 1 ? Number((b * 100).toFixed(0)) : b)
    const st = strOf(p, 'status') ?? strOf(p, 'state') ?? strOf(p, 'link')
    if (st && ['online', 'ok', 'normal', 'active'].includes(st.toLowerCase())) a.online += 1
    const sg = strOf(p, 'signal') ?? strOf(p, 'signalStrength')
    if (sg !== undefined && a.signal === undefined) a.signal = sg
    const sp = numOf(p, 'signalPercent')
    if (sp !== undefined && a.signalPercent === undefined) {
      a.signalPercent = sp <= 1 ? Number((sp * 100).toFixed(0)) : sp
    }
    acc.set(gk, a)
  }

  const out: ClusterRow[] = groupRows.map((g, i) => {
    const key = strOf(g, 'key') ?? strOf(g, 'groupId') ?? strOf(g, 'id') ?? `g${i}`
    const hostName = strOf(g, 'name') ?? strOf(g, 'label')
    const a = acc.get(key) ?? (hostName ? acc.get(hostName) : undefined) ?? { batteries: [], count: 0, online: 0 }
    const role = strOf(g, 'role') ?? strOf(g, 'typeKey') ?? strOf(g, 'kind')
    const bat = numOf(g, 'battery') ?? numOf(g, 'batteryPercent')
    const mean = a.batteries.length
      ? Number((a.batteries.reduce((s, x) => s + x, 0) / a.batteries.length).toFixed(1))
      : undefined
    return {
      key,
      name: hostName ?? `集群${i + 1}`,
      nameFallback: hostName === undefined,
      typeLabel: role ? (ROLE_CN[role.toLowerCase()] ?? role) : undefined,
      roleDomain: role,
      platformCount: numOf(g, 'platformCount') ?? numOf(g, 'count') ?? (a.count || undefined),
      online: a.count ? a.online : undefined,
      battery: bat ?? mean,
      batteryFromMean: bat === undefined && mean !== undefined,
      batterySamples: bat === undefined && a.batteries.length ? a.batteries.length : undefined,
      signal: signalCN(strOf(g, 'signal') ?? strOf(g, 'signalStrength') ?? strOf(g, 'signalLevel') ?? a.signal),
      signalPercent: numOf(g, 'signalPercent') ?? a.signalPercent,
      onlineWord: strOf(g, 'status') ?? strOf(g, 'state'),
      color: CLUSTER_PALETTE[i % CLUSTER_PALETTE.length],
    }
  })

  const notes: string[] = []
  if (!out.length) {
    notes.push('宿主未返回集群清单：situation.snapshot 的 groups 为空（场景数据/引擎未装配时就是这样）')
    return { rows: [], from: 'none', notes }
  }
  notes.push('集群名称 / 机型 / 平台数来自 situation.snapshot.groups[]（**不是图上写死的"集群1…6"**）')
  if (out.some((r) => r.nameFallback)) notes.push('部分集群宿主没给 name → 退回落位名，已标注')
  if (out.some((r) => r.batteryFromMean)) {
    notes.push('电量：宿主没给集群级聚合值 → 显示的是该集群各架 platforms[].battery 的**均值**（已标 n 架均值）')
  }
  if (out.every((r) => r.signal === undefined)) {
    notes.push('信号强度：宿主与 sensor.status 都没有该字段 → 只能显示"—（引擎/宿主未给出）"，不编"强/中"')
  }
  notes.push('六边形的屏幕落位沿用参考图示意排布（地图台未暴露经纬度→屏幕的投影）')
  return { rows: out, from: 'snapshot', notes }
}

function Bar({ percent, color }: { percent: number; color: string }) {
  const w = Math.max(0, Math.min(100, percent))
  return (
    <span style={{ flex: 1, minWidth: 0, height: 5, borderRadius: 3, background: 'rgba(95,176,255,.16)', display: 'inline-block' }}>
      <span style={{ display: 'block', width: `${w}%`, height: 5, borderRadius: 3, background: color }} />
    </span>
  )
}

/**
 * 「集群总体状态」面板（SH-09 有【更多详情 >】，SH-10 没有）。
 * 两个屏共用同一份渲染口径，避免同一块面板出现两套写法。
 */
export function ClusterStatusPanel({ rows: list, notes, onMore, more, testid, idPrefix }: {
  rows: ClusterRow[]
  notes: string[]
  onMore?: () => void
  more?: boolean
  testid: string
  /** 行 `data-testid` 前缀（如 `sh09-cluster-row`） */
  idPrefix: string
}) {
  return (
    <div data-testid={testid} style={{ ...panel, width: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div style={{ ...panelTitle, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>集群总体状态</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: C.textDim }}>{list.length ? `${list.length} 个集群` : '未就绪'}</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 12px 8px' }}>
        {list.length === 0 && (
          <div data-testid={`${idPrefix}-missing`} style={{ fontSize: 11.5, color: C.warn, lineHeight: 1.7 }}>
            {notes[0] ?? '宿主未返回集群清单'}
          </div>
        )}
        {list.map((r, i) => (
          <div key={r.key} data-testid={`${idPrefix}-${i + 1}`} data-cluster={r.name} style={{ padding: '3px 0 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 9, height: 9, borderRadius: 5, background: r.color, flex: '0 0 auto' }} />
              <span style={{ fontSize: 12.5, color: C.text, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.name}
                {r.typeLabel ? <span style={{ color: C.textDim }}>（{r.typeLabel}）</span> : null}
                {r.nameFallback ? <span style={{ color: C.warn, fontSize: 10 }}>〔宿主未给名，落位名〕</span> : null}
              </span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 11.5, color: r.onlineWord ? C.ok : C.textDim }}>{r.onlineWord ?? '—'}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
              <span style={{ fontSize: 11, color: C.textDim, width: 42, flex: '0 0 auto' }}>信号强度</span>
              <span style={{ fontSize: 11.5, color: r.signal ? C.text : C.warn, width: 22, flex: '0 0 auto' }}>
                {r.signal ?? '—'}
              </span>
              {r.signalPercent !== undefined ? (
                <Bar percent={r.signalPercent} color={r.color} />
              ) : (
                <span style={{ fontSize: 10, color: C.textDim, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  引擎/宿主未给出信号强度数值
                </span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
              <span style={{ fontSize: 11, color: C.textDim, width: 42, flex: '0 0 auto' }}>电量</span>
              {r.battery !== undefined ? (
                <>
                  <Bar percent={r.battery} color={r.color} />
                  <span style={{ fontSize: 11.5, color: C.text, width: 52, textAlign: 'right', flex: '0 0 auto', fontVariantNumeric: 'tabular-nums' }}>
                    {n2s(r.battery)}%
                  </span>
                </>
              ) : (
                <span style={{ fontSize: 10.5, color: C.warn, flex: 1, minWidth: 0 }}>
                  —（宿主未给出电量字段 platforms[].battery）
                </span>
              )}
            </div>
            {more && (
              <div data-testid={`${idPrefix}-detail-${i + 1}`} style={{ marginTop: 3, fontSize: 10.5, color: C.textDim, lineHeight: 1.6 }}>
                机型域 {r.roleDomain ?? '—'} · 平台数 {r.platformCount !== undefined ? n2s(r.platformCount) : '—'}
                {r.batterySamples !== undefined ? ` · 电量样本 ${r.batterySamples} 架（均值）` : ''}
                {r.online !== undefined ? ` · 在线平台 ${r.online}/${r.platformCount ?? '—'}` : ''}
              </div>
            )}
            <div style={{ height: 1, background: 'rgba(95,176,255,.12)', margin: '5px 0 4px' }} />
          </div>
        ))}
      </div>
      {onMore && (
        <button data-testid="sh09-more" data-more={more ? '1' : '0'} onClick={onMore} style={moreBtn}>
          {more ? '收起详情 ‹' : '更多详情 >'}
        </button>
      )}
      {notes.length > 0 && (
        <div data-testid={`${idPrefix}-notes`} style={{ borderTop: `1px solid ${C.border}`, padding: '5px 12px 7px', fontSize: 10, color: C.textDim, lineHeight: 1.55 }}>
          {notes.slice(0, more ? 6 : 3).map((t, i) => <div key={i}>· {t}</div>)}
        </div>
      )}
    </div>
  )
}

/** 四旋翼图标（示意图标，不是业务数据）。 */
function DroneGlyph({ color, size = 30 }: { color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ display: 'block' }}>
      <circle cx="12" cy="12" r="2.6" fill={color} opacity="0.95" />
      <g stroke={color} strokeWidth="1.3" fill="none" opacity="0.95">
        <line x1="9.6" y1="9.6" x2="5.6" y2="5.6" />
        <line x1="14.4" y1="9.6" x2="18.4" y2="5.6" />
        <line x1="9.6" y1="14.4" x2="5.6" y2="18.4" />
        <line x1="14.4" y1="14.4" x2="18.4" y2="18.4" />
      </g>
      <g fill="none" stroke={color} strokeWidth="1.1" opacity="0.85">
        <circle cx="5.6" cy="5.6" r="2.4" />
        <circle cx="18.4" cy="5.6" r="2.4" />
        <circle cx="5.6" cy="18.4" r="2.4" />
        <circle cx="18.4" cy="18.4" r="2.4" />
      </g>
    </svg>
  )
}

/** 扁平半透明六边形（**屏幕示意位**：地图台未暴露经纬度→屏幕投影）。 */
function HexCluster({ row, testid, dataIndex }: { row: ClusterRow; testid: string; dataIndex: number }) {
  const pts = '50,4 93,27 93,73 50,96 7,73 7,27'
  return (
    <div data-testid={testid} data-cluster={row.name} data-index={dataIndex} style={{ position: 'relative', minHeight: 138 }}>
      <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }}>
        <defs>
          <filter id={`sh09-glow-${dataIndex}`} x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="1.6" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <polygon
          points={pts}
          fill={row.color}
          fillOpacity="0.12"
          stroke={row.color}
          strokeOpacity="0.85"
          strokeWidth="0.9"
          filter={`url(#sh09-glow-${dataIndex})`}
        />
      </svg>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
        <DroneGlyph color={row.color} />
        <div style={{ fontSize: 12, color: row.color, textShadow: '0 0 6px rgba(0,0,0,.85)' }}>{row.name}</div>
      </div>
    </div>
  )
}

export function ReconExpandScreen({ state, flow, onGo, goto }: {
  state: FlowState
  flow: UseFlow
  onGo?: (id: string) => void
  goto?: (step: number) => void
}) {
  const snap = useVerbOnce(flow, 'situation.snapshot', {}, true)
  const compose = useVerbOnce(flow, 'view.compose', {}, true)
  const sensor = useVerbOnce(flow, 'sensor.status', {}, true)
  const clusters = useMemo(() => readClusterStatus(snap.data), [snap.data])
  const [more, setMore] = useState(false)
  // 工具可用性一律问规则包（`view.compose`）；本屏只负责"图上有哪几格、什么字、什么顺序"
  const mt = useMapToolState(flow)

  const modeName = useMemo(() => {
    const src = isObj(compose.data) ? compose.data : undefined
    const views = rows(src, 'views')
    return strOf(views[0], 'modeName') ?? strOf(src, 'modeName') ?? '侦察展开'
  }, [compose.data])

  /** SH-09 图上**没有**按钮：唯一交互控件是右栏的【更多详情 >】。
   *  `goto` / `onGo` 保留在契约里，供后续"显示模式下拉真的切屏"接线（§9-10 待裁决）。 */
  void goto
  void onGo

  const sensorNote = sensor.reply
    ? (sensor.reply.code === 0
      ? `sensor.status code=0${sensor.data ? '（有读数）' : '（读数为空）'}`
      : replyText(sensor.reply))
    : 'sensor.status 读取中…'

  return (
    <div data-testid="sh-09" data-screen="SH-09" style={wrap}>
      {/* ---------------- 左上：工具栏 5 键（图上逐字；点击落 map-2d，坐标以本屏 wrap 为准） ---------------- */}
      <MapToolbar testid="sh09-toolbar" items={SH09_TOOLS} state={mt} style={{ left: 0, top: 0 }} />
      <ToolModeNote state={mt} items={SH09_TOOLS} />

      {/* ---------------- 右上：显示模式胶囊（可切"侦察展开 / 侦察融合"两屏，见需求专篇 §4.1 过渡①） ---------------- */}
      <div data-testid="sh09-mode" style={modePill}>
        <span style={{ color: C.textDim }}>显示模式：</span>
        <span style={{ color: C.text }}>{modeName}</span>
        <select
          data-testid="sh09-mode-select"
          aria-label="显示模式"
          value="expand"
          onChange={(e) => { if (e.target.value === 'fusion') onGo?.('SH-10') }}
          style={{
            marginLeft: 6, background: 'rgba(6,26,47,.9)', color: C.text, fontSize: 11.5,
            border: `1px solid ${C.border}`, borderRadius: 6, padding: '2px 4px', cursor: 'pointer',
          }}
        >
          <option value="expand">侦察展开</option>
          <option value="fusion">侦察融合</option>
        </select>
      </div>

      {/* ---------------- 地图：6 个扁平半透明六边形（两排三列） ---------------- */}
      <div data-testid="sh09-hexes" style={hexArea}>
        {clusters.rows.slice(0, 6).map((r, i) => (
          <HexCluster key={r.key} row={r} testid={`sh09-hex-cluster${i + 1}`} dataIndex={i} />
        ))}
        {clusters.rows.length === 0 && (
          <div data-testid="sh09-hexes-missing" style={{ gridColumn: '1 / span 3', fontSize: 12, color: C.warn, lineHeight: 1.8, padding: 8 }}>
            宿主未返回集群清单（situation.snapshot.groups 为空）→ 六边形集群位无法落位。
            <br />
            图上的"集群1…集群6"是**示意标签**，本屏不写死；引擎给出集群后才画。
          </div>
        )}
        <div data-testid="sh09-hex-note" style={{ gridColumn: '1 / span 3', fontSize: 10.5, color: C.textDim, lineHeight: 1.5 }}>
          六边形为**示意落位**（沿用参考图两排三列；地图台未暴露经纬度→屏幕投影），标签用宿主 groups[].name。
        </div>
      </div>

      {/* ---------------- 右栏：集群总体状态（含【更多详情 >】） ---------------- */}
      <div style={rightColStyle}>
        <ClusterStatusPanel
          rows={clusters.rows}
          notes={clusters.notes}
          more={more}
          onMore={() => setMore((v) => !v)}
          testid="sh09-cluster-status"
          idPrefix="sh09-cluster-row"
        />
        <div style={{ fontSize: 10, color: C.textDim, padding: '0 2px' }}>{sensorNote}</div>
      </div>

      <ReconExpandProbe
        step={state.step}
        phase={state.phase}
        raw={snap.data}
        view={clusters}
        snapshotReply={snap.reply}
        sensorReply={sensor.reply}
        composeReply={compose.reply}
        more={more}
      />
    </div>
  )
}

/** 自证句柄 `window.__sh09Stats`。 */
function ReconExpandProbe(props: {
  step: number
  phase: string
  raw: unknown
  view: ClusterStatusView
  snapshotReply: { code: number; error?: { message?: string } } | null
  sensorReply: { code: number; error?: { message?: string } } | null
  composeReply: { code: number; error?: { message?: string } } | null
  more: boolean
}) {
  const w = window as unknown as { __sh09Stats?: Record<string, unknown> }
  w.__sh09Stats = {
    screen: 'SH-09',
    step: props.step,
    phase: props.phase,
    verbs: { situation: props.snapshotReply, sensor: props.sensorReply, compose: props.composeReply },
    clusters: {
      from: props.view.from,
      rows: props.view.rows.map((r) => ({
        key: r.key, name: r.name, nameFallback: r.nameFallback, type: r.typeLabel ?? null,
        role: r.roleDomain ?? null, platformCount: r.platformCount ?? null,
        online: r.online ?? null, battery: r.battery ?? null, batteryFromMean: !!r.batteryFromMean,
        batterySamples: r.batterySamples ?? null, signal: r.signal ?? null, signalPercent: r.signalPercent ?? null,
      })),
      notes: props.view.notes,
      /** 快照原文（脚本自己核对"界面上的数 = 宿主给的数"） */
      snapshotRaw: props.raw ?? null,
    },
    dom: {
      hexes: document.querySelectorAll('[data-testid^="sh09-hex-cluster"]').length,
      rows: document.querySelectorAll('[data-testid^="sh09-cluster-row-"]').length,
      more: !!document.querySelector('[data-testid="sh09-more"]'),
      moreOpen: props.more,
      panel: !!document.querySelector('[data-testid="sh09-cluster-status"]'),
    },
  }
  return null
}

// ---- 样式（一律 left/right/top/bottom 长写：**不写 inset 简写**）----
const wrap: CSSProperties = {
  position: 'absolute', left: 12, right: 12, top: 34, bottom: 12, zIndex: 20,
}
const modePill: CSSProperties = {
  position: 'absolute', right: 0, top: 0, zIndex: 22, display: 'flex', gap: 6, alignItems: 'center',
  padding: '7px 12px', borderRadius: 999, fontSize: 12.5,
  background: 'rgba(6,26,47,.86)', border: `1px solid ${C.border}`,
}
const hexArea: CSSProperties = {
  position: 'absolute', left: 10, right: 312, top: 62, zIndex: 19,
  display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gridAutoRows: 'minmax(0, 1fr)', gap: 10,
}
const rightColStyle: CSSProperties = {
  position: 'absolute', right: 0, top: 40, bottom: 0, zIndex: 21, width: 292,
  display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0,
}
const moreBtn: CSSProperties = {
  margin: '0 12px 8px', padding: '7px 10px', fontSize: 12, cursor: 'pointer', borderRadius: 7,
  border: `1px solid ${C.borderStrong}`, background: 'rgba(29,78,216,.28)', color: C.text,
}

export default ReconExpandScreen
