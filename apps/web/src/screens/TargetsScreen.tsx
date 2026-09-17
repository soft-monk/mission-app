// mission-app · apps/web/src/screens/TargetsScreen.tsx
//
// **目标列表界面（需求专篇 DES-APP-001 SH-11，参考图 `场景1\T4-1.png`）** 与
// **目标详情界面（SH-12，参考图 `场景1\T4-2.png`）** —— 同一个组件的两种形态（`mode`）。
//
// 版式（两屏共用：顶栏/左导航/底部状态条/麦克风球由 `AppShell` 提供，本文件只摆地图上的浮层）：
//   · 左上：地图工具栏（选择 / 标绘 / 测距 / 测面 / 图层 / 3D · 2D/3D）
//     真能点的实现统一在 `shell/MapTools`（量算/手绘/图层/全屏落到 map-2d 的公共命令上），
//     本屏只声明"图上有哪几格、什么字、什么顺序"；**能不能点**由规则包 `view.compose` 说了算。
//   · 右上：显示模式胶囊「显示模式：目标识别」
//   · SH-11：地图右侧**浮动「目标详情」卡**（编号大字 + 徽标 + 类型/置信度/位置/海拔 +
//            「目标特征」2×2 + 「威胁评估」4 项）
//   · SH-12：**右栏整栏「目标详情」**（同上字段 + 「AI分析结果」5 行 + 3 枚通栏按钮）
//   · 地图下方通栏：「目标列表」横向卡条（缩略图位 + 编号 + 威胁等级色字）+ 左右翻页箭头
//   · 右栏（SH-11）：「集群总体状态」（取自 `situation.snapshot`，缺字段如实写"回执未给该字段"）
//
// ★ 纪律（这一屏最容易犯的四个错，写在这里最显眼）：
//   ① **一个数都不编**：编号/类型/置信度/位置/海拔/威胁等级/威胁评分/优先级全部取
//      `targets.list` / `targets.detail` 的**回执字段**；回执没有的字段（目标特征、防护强度、
//      电子干扰、周边态势、行为特征、建议处置）显示"—"并写明"回执未给该字段"
//      —— MUST NOT 抄参考图上的 34.2345°N / 92% / 1287 m / 大型建筑。
//   ② **动作键只认引擎**：3 枚按钮的动作键必须来自 `targets.detail` 的 `declaredActions`
//      （`actions/availableActions` 别名也收）；引擎没给清单 → 三枚按钮**灰置**并写明
//      "引擎未返回可行动作清单"（MUST NOT 拿契约里的 observe/track/strike 假装是引擎给的）。
//   ③ **威胁等级与颜色都取回执**：等级词是 `threatBand` 的域（high/mid/low，经词典折中文），
//      颜色由同一个域映射（高=红 / 中=橙 / 低=绿）；域不认识就原样显示 + 中性灰（不猜）。
//   ④ **不发明按钮**：SH-11 图上只有"目标卡 + 翻页箭头"；SH-12 图上只有那 3 枚处置按钮。
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { C, panel, panelTitle } from '../theme'
import type { CommandReply, FlowState } from '../api'
import type { UseFlow } from '../flow/useFlow'
import {
  isObj, n2s, num, obj, objList, readCompose, replyText, str, strList, threatColor, uavTypeCN, useVerbOnce,
  type Metric,
} from '../flow/useSituation'
import {
  readAct, readTargetDetail, readTargets,
  type ActionOption, type TargetDetailView, type TargetRow,
} from '../flow/useOps'
// 地图工具栏：共享的**真能点**实现（本屏不再自己写一份只读摆设）
import { MapToolbar, ToolModeNote, toolsOf, useMapToolState } from '../shell/MapTools'

/** 地图下方「目标列表」每页几张卡（图上 5 张）。 */
const PAGE_SIZE = 5

/**
 * SH-11 ↔ SH-12 之间共享的**选中目标**。
 *
 * 两屏是同一步（步 7）里的两次挂载，`props` 里没有"选中项"这一位（签名冻在 App.tsx，不改），
 * 所以用模块内记忆把界面选择带过去。它**只是界面选择**：真正的取值仍然只来自宿主回执。
 */
let sharedSelectedId: string | null = null

/** 威胁等级域 → 中文（**词典**；不认识就原样显示域，不猜）。 */
const BAND_CN: Record<string, string> = { high: '高', mid: '中', medium: '中', low: '低' }
function bandCN(band?: string): string | undefined {
  return band ? BAND_CN[band.toLowerCase()] : undefined
}
function bandText(band?: string): string {
  if (!band) return '—'
  return bandCN(band) ?? band
}

/** 置信度口径：0–1 是比例，>1 视为已是百分数（只这一处换算，规则单一）。 */
function confText(v?: number): string {
  if (v === undefined) return '—'
  return `${n2s(v <= 1 ? Number((v * 100).toFixed(0)) : v)}%`
}

/** 经纬度（回执原样位数，四舍五入到 5 位；缺一个就"—"）。 */
function posText(lng?: number, lat?: number): string {
  if (lng === undefined || lat === undefined) return '—'
  return `${lat.toFixed(5)}°N ${lng.toFixed(5)}°E`
}

/** 台账的 `flags[]`（`hv` = 规则包 entityTypes.json 的 flags[].key）。 */
function flagsOf(raw: unknown): string[] {
  return strList(raw, 'flags')
}

// ============================================================================
// 小部件
// ============================================================================

function Section({ title, right, children, testid }: {
  title: ReactNode
  right?: ReactNode
  children: ReactNode
  testid?: string
}) {
  return (
    // box-sizing: border-box —— 避免 `width:100%` + 边框把 `overflowY:auto` 的列顶出横向滚动条
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

/** 一行「名 + 值」：缺值显示"—"，**不补 0**；`miss` 有值时在值后如实写明原因。 */
function Row({ k, v, color, miss, testid }: {
  k: string
  v: string
  color?: string
  miss?: string
  testid?: string
}) {
  return (
    <div data-testid={testid} style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 12.5 }}>
      <span style={{ color: C.textDim, width: 62, flex: '0 0 auto' }}>{k}</span>
      <span style={{ color: color ?? (miss ? C.textDim : C.text), minWidth: 0, wordBreak: 'break-all' }}>
        {v}
        {miss && <span style={{ fontSize: 10.5, color: C.textDim }}>　{miss}</span>}
      </span>
    </div>
  )
}

/** 「名 + 值 + 域原样」：值取自回执的域时，把域一起摆出来（举证用）。 */
function DomRow({ k, text, domain, color, testid }: {
  k: string
  text: string
  domain?: string
  color?: string
  testid?: string
}) {
  return (
    <div data-testid={testid} style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 12.5 }}>
      <span style={{ color: C.textDim, width: 62, flex: '0 0 auto' }}>{k}</span>
      <span style={{ color: color ?? C.text, minWidth: 0 }}>
        {text}
        {domain && <span style={{ fontSize: 10.5, color: C.textDim }}>（{domain}）</span>}
      </span>
    </div>
  )
}

/** 显示模式胶囊（图右上：「显示模式：目标识别 ⌄」）。 */
function ModePill({ prefix, name, right }: { prefix: string; name: string; right: number }) {
  return (
    <div data-testid={`${prefix}-mode`} style={{ ...modePill, right }}>
      <span style={{ color: C.textDim }}>显示模式：</span>
      <span style={{ color: C.text }}>{name}</span>
      <span style={{ color: C.textDim }}>⌄</span>
    </div>
  )
}

// ============================================================================
// 目标详情（SH-11 的浮动卡 / SH-12 的右栏，两套字段不同：variant 决定）
// ============================================================================

/** 目标编号：台账 `no` → `目标00N`（纯显示格式；**没有 no 就显示"—"**，不补号）。 */
function targetNoText(no?: number): string {
  if (no === undefined) return '—'
  return `目标${String(no).padStart(3, '0')}`
}

/** 「高价值目标」徽标：只认台账 `flags[]` 里的 `hv`（规则包 entityTypes.json 声明、upgrade 动作置位）。 */
function ValueBadge({ hv, flags }: { hv: boolean; flags: string[] }) {
  if (!hv) return null
  return (
    <span data-testid="target-value-badge" data-flags={flags.join(',')} style={badge}>
      高价值目标
    </span>
  )
}

/** 目标特征 2×2（图上四项；回执给几条显示几条，缺的格子写"—"）。 */
function FeatureGrid({ features }: { features: string[] }) {
  const cells = [0, 1, 2, 3]
  return (
    <div data-testid="target-features" style={{ marginTop: 6, borderTop: `1px solid ${C.border}`, paddingTop: 5 }}>
      <div style={{ fontSize: 12, color: C.textDim, marginBottom: 4 }}>目标特征</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
        {cells.map((i) => (
          <div key={i} data-testid="target-feature-cell" style={featureCell}>
            {features[i] ?? '—'}
          </div>
        ))}
      </div>
      {features.length === 0 && (
        <div data-testid="target-features-missing" style={missLine}>
          回执未给该字段（`targets.detail` 的 entity / `targets.list` 的行都没有 features[]）
        </div>
      )}
    </div>
  )
}

/** 威胁评估 4 项（图上逐字；回执没有的项写"—" + 原因）。 */
function ThreatAssess({ band, defense, jamming, situation, bandColor, testid }: {
  band?: string
  defense?: Metric
  jamming?: Metric
  situation?: Metric
  bandColor: string
  testid?: string
}) {
  const item = (label: string, m: Metric | undefined) => (
    <div style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 12.5 }}>
      <span style={{ color: C.textDim, width: 62, flex: '0 0 auto' }}>{label}</span>
      <span style={{ color: m ? C.text : C.textDim, minWidth: 0 }}>
        {m ? (m.text ?? (m.value !== undefined ? n2s(m.value, m.unit ?? '') : '—')) : '—'}
        {!m && <span style={{ fontSize: 10.5, color: C.textDim }}>　回执未给该字段</span>}
      </span>
    </div>
  )
  return (
    <div data-testid={testid ?? 'target-threat'} style={{ marginTop: 6, borderTop: `1px solid ${C.border}`, paddingTop: 5 }}>
      <div style={{ fontSize: 12, color: C.textDim, marginBottom: 2 }}>威胁评估</div>
      <div style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 12.5 }}>
        <span style={{ color: C.textDim, width: 62, flex: '0 0 auto' }}>威胁等级</span>
        <span data-testid="target-band" data-band={band ?? ''} style={{ color: bandColor, minWidth: 0 }}>
          {bandText(band)}{band ? <span style={{ fontSize: 10.5, color: C.textDim }}>（{band}）</span> : null}
          {!band && <span style={{ fontSize: 10.5, color: C.textDim }}>　回执未给该字段</span>}
        </span>
      </div>
      {item('防护强度', defense)}
      {item('电子干扰', jamming)}
      {item('周边态势', situation)}
    </div>
  )
}

/** 「AI分析结果」5 行（图上逐字；对不上的行写"—" + 原因）。 */
function AiAnalysis({ rows, testid }: {
  rows: { k: string; v?: string; from?: string; color?: string; miss?: string }[]
  testid?: string
}) {
  return (
    <div data-testid={testid ?? 'sh12-ai-analysis'} style={{ marginTop: 6, borderTop: `1px solid ${C.border}`, paddingTop: 5 }}>
      <div style={{ fontSize: 12, color: C.textDim, marginBottom: 2 }}>AI分析结果</div>
      {rows.map((r) => (
        <div key={r.k} data-testid="sh12-ai-row" data-field={r.from ?? ''}
          style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 12.5 }}>
          <span style={{ color: C.textDim, width: 62, flex: '0 0 auto' }}>{r.k}</span>
          <span style={{ color: r.v ? (r.color ?? C.text) : C.textDim, minWidth: 0, wordBreak: 'break-all' }}>
            {r.v ?? '—'}
            {r.miss && <span style={{ fontSize: 10.5, color: C.textDim }}>　{r.miss}</span>}
          </span>
        </div>
      ))}
    </div>
  )
}

// ============================================================================
// 处置动作（动作键**只认引擎声明的清单**）
// ============================================================================

/**
 * 图上那 3 枚按钮 → 语义匹配的**动作键候选**。
 *
 * 键的取值域来自规则包 `entity-ledger/policies/mapapp/entityTypes.json` 的 `actions[]`
 * （实测 `declaredActions = watch / track / upgrade / strike / reassess`）。这里按**语义**去
 * 引擎清单里认领一个键；一个都认不到 → 按钮灰置（MUST NOT 自己挑一个键发出去）。
 *
 * 三档配色照图：红=升级为打击目标 / 蓝=交由集群重点监视 / 深色描边=持续跟踪。
 */
const actRed: CSSProperties = {
  padding: '9px 12px', fontSize: 13, cursor: 'pointer', borderRadius: 8,
  border: '1px solid rgba(239,68,68,.55)', background: 'rgba(120,30,20,.55)', color: '#ffd9d4',
}
const actBlue: CSSProperties = {
  padding: '9px 12px', fontSize: 13, cursor: 'pointer', borderRadius: 8,
  border: `1px solid ${C.borderStrong}`, background: 'linear-gradient(180deg,#1d4ed8,#1e3a8a)', color: '#eaf4ff',
}
const actGhost: CSSProperties = {
  padding: '9px 12px', fontSize: 13, cursor: 'pointer', borderRadius: 8,
  background: 'rgba(10,20,36,.7)', border: `1px solid ${C.border}`, color: C.text,
}
const ACT_BUTTONS: { label: string; domains: string[]; style: CSSProperties }[] = [
  { label: '升级为打击目标', domains: ['upgrade', 'promote'], style: actRed },
  { label: '交由集群重点监视', domains: ['watch', 'monitor', 'surveil'], style: actBlue },
  { label: '持续跟踪', domains: ['track', 'follow', 'lock'], style: actGhost },
]

function pickAction(list: ActionOption[], domains: string[]): ActionOption | undefined {
  for (const d of domains) {
    const hit = list.find((a) => a.domain.toLowerCase() === d)
    if (hit) return hit
  }
  return undefined
}

function ActButtons({ list, busy, entityId, onAct, prefix }: {
  list: ActionOption[]
  busy: boolean
  entityId: string | null
  onAct: (domain: string) => void
  prefix: string
}) {
  const none = list.length === 0
  return (
    <div data-testid={`${prefix}-actions`} data-actions-source={none ? 'none' : 'engine'}
      style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 8 }}>
      {ACT_BUTTONS.map((b) => {
        const hit = pickAction(list, b.domains)
        const domain = hit?.domain ?? b.domains[0]
        const enabled = !!hit && (hit.enabled ?? true) && !!entityId && !busy
        const title = hit
          ? `动作键 ${hit.domain}（引擎 entity-ledger 规则包声明）${hit.enabled === false && hit.reason ? ` · 引擎标注不可用：${hit.reason}` : ''}`
          : '引擎未返回可行动作清单 → 灰置（本按钮不发送任何命令）'
        return (
          <button
            key={b.label}
            data-testid={`btn-act-${domain}`}
            data-action-domain={hit?.domain ?? ''}
            data-action-enabled={enabled ? '1' : '0'}
            data-image-label={b.label}
            disabled={!enabled}
            title={title}
            onClick={() => hit && onAct(hit.domain)}
            style={enabled ? b.style : actDisabled}
          >
            {b.label}
            {hit && (
              <span style={{ fontSize: 10.5, color: C.textDim }}>（动作键 {hit.domain}）</span>
            )}
          </button>
        )
      })}
      {none ? (
        <div data-testid={`${prefix}-actions-reason`} style={{ fontSize: 11, color: C.warn, lineHeight: 1.6 }}>
          引擎未返回可行动作清单（`targets.detail` 的 actions / availableActions / declaredActions）→ 三枚按钮**灰置**。
          契约冻结取值 observe/track/strike 仅作占位显示，未发送。
        </div>
      ) : (
        <div data-testid={`${prefix}-actions-declared`} style={{ fontSize: 10.5, color: C.textDim, lineHeight: 1.6 }}>
          引擎声明的动作（{list.length} 个）：{list.map((a) => a.domain).join(' / ')}
        </div>
      )}
    </div>
  )
}

// ============================================================================
// 底部「目标列表」条
// ============================================================================

function TargetCard({ t, selected, onPick }: {
  t: TargetRow
  selected: boolean
  onPick: () => void
}) {
  const band = t.threat
  const color = band ? threatColor(band) : C.unknown
  const flags = flagsOf(t.raw)
  const hv = flags.includes('hv')
  return (
    <button
      data-testid="target-card"
      data-entity-id={t.entityId}
      data-threat={band ?? ''}
      data-threat-band={band ?? ''}
      data-selected={selected ? '1' : '0'}
      data-hv={hv ? '1' : '0'}
      onClick={onPick}
      title={`${targetNoText(t.no)}${t.typeName ?? t.typeKey ? ` ｜ ${t.typeName ?? t.typeKey}` : ''}${selected ? '（再点一次进入「目标详情」SH-12）' : ''}`}
      style={{
        width: 138, flex: '0 0 auto', textAlign: 'left', cursor: 'pointer',
        border: `1px solid ${selected ? C.borderStrong : C.border}`, borderRadius: 8,
        background: selected ? 'rgba(29,78,216,.35)' : 'rgba(10,32,58,.6)',
        padding: 6, display: 'flex', flexDirection: 'column', gap: 4,
      }}
    >
      {/* 缩略图位：**不画假影像** —— 回传通道由 `media.channels` 管，这里只如实标出来源 */}
      <div data-testid="target-thumb" style={thumb}>
        <span style={{ fontSize: 9.5, color: C.textDim }}>
          {t.source ? `${t.source}` : '缩略图位（无回传通道）'}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: color, flex: '0 0 auto' }} />
        <span data-testid="target-card-no" style={{ fontSize: 11.5, color: C.text }}>{targetNoText(t.no)}</span>
        <span style={{ flex: 1 }} />
        <span data-testid="target-card-band" data-band={band ?? ''} style={{ fontSize: 11.5, color }}>
          {bandText(band)}
        </span>
      </div>
    </button>
  )
}

// ============================================================================
// 右栏「集群总体状态」（SH-11；同 SH-09 的那一栏）
// ============================================================================

interface ClusterRow {
  key: string
  name: string
  types: string
  count?: number
  batteries: number[]
}

/** `situation.snapshot` 的 groups[] + platforms[] → 逐集群一行（**全是从回执里取的**）。 */
function clusterRowsOf(raw: unknown): ClusterRow[] {
  if (!isObj(raw)) return []
  const groups = objList(raw, 'groups')
  const plats = objList(raw, 'platforms')
  return groups.map((g, i) => {
    const key = str(g, 'key', 'groupId', 'id') ?? `g${i}`
    const name = str(g, 'name', 'label') ?? key
    const mine = plats.filter((p) => str(p, 'groupKey') === key || str(p, 'groupName') === name)
    const types = [...new Set(mine.map((p) => uavTypeCN(str(p, 'typeKey', 'type'))))].filter((x) => x && x !== '—')
    return {
      key,
      name,
      types: types.join('/'),
      count: num(g, 'platformCount') ?? (mine.length || undefined),
      batteries: mine.map((p) => num(p, 'battery', 'batteryPercent')).filter((v): v is number => v !== undefined),
    }
  })
}

function ClusterRail({ snapshotRaw, reply, busy, onRetry, testid }: {
  snapshotRaw: unknown
  reply: CommandReply | null
  busy: boolean
  onRetry: () => void
  testid: string
}) {
  const rows = useMemo(() => clusterRowsOf(snapshotRaw), [snapshotRaw])
  return (
    <Section
      title="集群总体状态"
      right={reply === null || busy ? '读取中…' : reply.code === 0 ? 'situation.snapshot' : '未就绪'}
      testid={testid}
    >
      {rows.length > 0 ? rows.map((r) => (
        <div key={r.key} data-testid="cluster-row" data-cluster-key={r.key}
          style={{ padding: '5px 0', borderBottom: '1px solid rgba(95,176,255,.10)' }}>
          <div style={{ display: 'flex', gap: 7, alignItems: 'baseline', fontSize: 12.5 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: C.accent, flex: '0 0 auto' }} />
            <span style={{ color: C.text, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {r.name}{r.types ? `（${r.types}）` : ''}
            </span>
            <span style={{ color: C.textDim, fontSize: 11 }}>{r.count !== undefined ? `${n2s(r.count)} 架` : '—'}</span>
          </div>
          <div style={{ fontSize: 11.5, color: C.textDim, paddingLeft: 15 }}>
            信号强度 <span style={{ color: C.textDim }}>—（回执未给该字段）</span>
          </div>
          <div style={{ fontSize: 11.5, color: C.textDim, paddingLeft: 15 }}>
            电量{' '}
            <span style={{ color: C.text }}>
              {r.batteries.length ? r.batteries.map((b) => `${n2s(b)}%`).join(' / ') : '—'}
            </span>
            {r.batteries.length > 1 && <span style={{ fontSize: 10.5 }}>（逐架原值）</span>}
            {r.batteries.length === 0 && <span style={{ fontSize: 10.5 }}>（回执未给该字段）</span>}
          </div>
        </div>
      )) : (
        <div data-testid="cluster-rail-empty" style={missLine}>
          {reply === null || busy
            ? '正在读取 situation.snapshot…'
            : '快照未给出集群清单（groups[]）—— 图上 6 条集群状态取自引擎，前端不编'}
          {reply && reply.code !== 0 && <div style={{ color: C.warn, marginTop: 3 }}>{replyText(reply)}</div>}
        </div>
      )}
      {reply && reply.code !== 0 && (
        <button data-testid="cluster-rail-retry" onClick={onRetry} style={retryBtn}>重试</button>
      )}
    </Section>
  )
}

// ============================================================================
// 主组件
// ============================================================================

/**
 * 地图工具栏的**版式**（键位 / 顺序 / 文字照参考图 `场景1\T4-1.png`、`T4-2.png`）：
 *   选择 / 标绘 / 测距 / 测面 / 图层 / 3D·2D/3D。
 *
 * 为什么放在组件外：这排格子在 SH-11 与 SH-12 上是同一份，提成模块级常量后两屏共用、
 * 也避免每次渲染重建数组。**它只声明"图上有哪几格"**；每一格"能不能点、为什么不能点"
 * 由 `shell/MapTools` 从规则包 `view.compose` 翻译（本屏不再自己判可用性）。
 *
 * 与参考图的一处有意偏差：量算在 map-2d 里是「测距 + 测面」两档，图上只有一格"测距"，
 * 故在"测距"后补一格"测面"（量算是用户明确点名要接的能力，见 `TOOL_SPECS` 的注释）。
 */
const TARGETS_TOOLS = toolsOf(['select', 'draw', 'measure', 'measureArea', 'layers', 'mode3d', 'reset'])

export function TargetsScreen({ state, flow, mode = 'list', onGo }: {
  state: FlowState
  flow: UseFlow
  /** 图上 SH-11（目标列表，浮动详情卡）/ SH-12（目标详情，右栏整栏）是同一步里的两屏 */
  mode?: 'list' | 'detail'
  /** 切到另一屏（只改本地屏路由） */
  onGo?: (id: string) => void
}) {
  const P = mode === 'detail' ? 'sh12' : 'sh11'          // 新增 testid 前缀
  const detailMode = mode === 'detail'

  // 工具条状态：可用性一律来自规则包 `view.compose`（`shell/MapTools` 内部发同一条 verb，
  // 幂等只读）。本屏只把 `mt` 交给 `<MapToolbar>`，不再自己算"哪个工具能用"。
  const mt = useMapToolState(flow)

  // ---- 进屏发一次目标台账（幂等）；`entity.changed` 到达时限频重取 ----
  const list = useVerbOnce(flow, 'targets.list', {}, true)
  const tv = useMemo(() => readTargets(list.data), [list.data])

  // ---- 显示模式（`view.compose` 说了算，前端不写死）----
  // ★ 这条调用**保留**：显示模式的取值来源不变（下面用 `cmp.modeName`）；
  //   工具可用性改由 `mt` 负责（`useMapToolState` 内部发的是同一条幂等只读 verb）。
  const compose = useVerbOnce(flow, 'view.compose', {}, true)
  const cmp = useMemo(() => readCompose(compose.data), [compose.data])

  // ---- 右栏「集群总体状态」（**只有 SH-11 图上那一栏用它**；SH-12 的右栏是目标详情） ----
  const snap = useVerbOnce(flow, 'situation.snapshot', {}, !detailMode)

  // ---- 选中目标 ----
  const [selectedId, setSelectedId] = useState<string | null>(sharedSelectedId)
  const [page, setPage] = useState(0)
  const [detailNonce, setDetailNonce] = useState(0)
  const [detailReply, setDetailReply] = useState<CommandReply | null>(null)
  const [detailBusy, setDetailBusy] = useState(false)

  // 台账到手后：选中的 id 若不在台账里 → 默认选"高价值（hv 标志）优先、否则威胁分最高"的一条。
  // （**这是界面默认焦点，不是造数据**；页脚会把口径写出来。）
  useEffect(() => {
    if (tv.items.length === 0) return
    if (selectedId && tv.items.some((t) => t.entityId === selectedId)) return
    const hv = tv.items.find((t) => flagsOf(t.raw).includes('hv'))
    const best = [...tv.items].sort((a, b) => (b.threatScore ?? -1) - (a.threatScore ?? -1))[0]
    const pick = (hv ?? best).entityId
    sharedSelectedId = pick
    setSelectedId(pick)
  }, [tv.items, selectedId])

  const selected = tv.items.find((t) => t.entityId === selectedId)

  const pickTarget = (id: string) => {
    sharedSelectedId = id
    if (selectedId === id && !detailMode) { onGo?.('SH-12'); return }  // 已选中再点 → 进详情屏
    setSelectedId(id)
  }

  // ---- 选中目标 → `targets.detail`（本屏读它做字段与动作清单） ----
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

  // ---- 处置动作（`targets.act{entityId, action}`） ----
  const [actBusy, setActBusy] = useState(false)
  const [actReply, setActReply] = useState<CommandReply | null>(null)
  const onAct = async (domain: string) => {
    if (!selectedId) return
    setActBusy(true)
    try {
      const r = await send('targets.act', { entityId: selectedId, action: domain })
      setActReply(r)
      if (r.code === 0) {
        list.resend()
        setDetailNonce((n) => n + 1)
        // 【升级为打击目标】成功后转入打击决策（SH-13）—— 图上该按钮的去向
        const a = readAct(r.data)
        if ((a.action ?? domain).toLowerCase() === 'upgrade') onGo?.('SH-13')
      }
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

  // ---- 取值（一律来自回执；取不到就 undefined → 界面写"—"） ----
  const band = dv.threat ?? selected?.threat
  const bandColor = band ? threatColor(band) : C.unknown
  const no = dv.no ?? selected?.no
  // 台账 `flags[]`（`hv` = 规则包 entityTypes.json 的 flags[].key）：详情回执的 entity 优先，
  // 其次用列表行的 flags。**没有 hv 就不画徽标**（不假装它是高价值目标）。
  const detailFlags = strList(obj(dv.raw, 'entity'), 'flags')
  const flags = detailFlags.length ? detailFlags : flagsOf(selected?.raw)
  const hv = flags.includes('hv')
  const typeText = dv.typeName ?? selected?.typeName ?? dv.typeKey ?? selected?.typeKey
  const conf = dv.confidence ?? selected?.confidence
  const lng = dv.lng ?? selected?.lng
  const lat = dv.lat ?? selected?.lat
  const alt = dv.altM ?? selected?.altM
  const features = dv.features.length ? dv.features : (selected?.features ?? [])
  const fac = (keys: string[]) => dv.assessment.find((m) => keys.includes(m.key))
  const dynamicRow = fac(['dynamicState', 'activity'])
  const notReady = detailReply !== null && detailReply.code !== 0

  // ---- 分页（每页 5 张，图上是 5 张 + 左右箭头） ----
  const pageCount = Math.max(1, Math.ceil(tv.items.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const pageItems = tv.items.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)
  const canPrev = safePage > 0
  const canNext = safePage < pageCount - 1

  // 工具栏的"哪几格 / 能不能点 / 为什么不能点"都不在这里算了：
  //   版式 → 模块级 `TARGETS_TOOLS`；可用性 + 原话原因 → `mt`（规则包 `view.compose`）。
  const modeName = cmp.modeName ?? cmp.modeKey ?? '目标识别'

  const total = tv.total
  const stripNote = list.reply === null
    ? '正在读取目标台账…'
    : list.reply.code === 0
      ? `targets.list：${tv.items.length} 个${total !== undefined && total !== tv.items.length ? `（宿主总数 ${total}）` : ''}${pageCount > 1 ? ` · 第 ${safePage + 1}/${pageCount} 页` : ''}`
      : `targets.list → ${replyText(list.reply)}`

  return (
    <div data-testid={detailMode ? 'sh-12' : 'sh-11'} data-screen={detailMode ? 'SH-12' : 'SH-11'} style={wrap}>
      {/* 左上：地图工具栏（共享实现；`style` 以本屏浮层容器 `wrap` 为参照系 → 容器左上角） */}
      <MapToolbar testid={`${P}-toolbar`} items={TARGETS_TOOLS} state={mt} style={{ left: 0, top: 0 }} />
      <ToolModeNote state={mt} items={TARGETS_TOOLS} />
      <ModePill prefix={P} name={modeName} right={RAIL_W + 12} />

      {/* ---------------- SH-11：地图上的浮动「目标详情」卡 ---------------- */}
      {!detailMode && (
        <div data-testid="sh11-detail-card" style={floatCard}>
          <div style={{ ...panelTitle, padding: '8px 12px' }}>目标详情</div>
          <div style={{ padding: '8px 12px 10px' }}>
            {!selectedId && <div style={missLine}>未选择目标 —— 点下方目标卡后发 `targets.detail{'{entityId}'}`。</div>}
            {selectedId && notReady && (
              <div data-testid="sh11-detail-not-ready" style={{ fontSize: 12, color: C.warn, lineHeight: 1.7 }}>
                targets.detail 未就绪：{replyText(detailReply)}
              </div>
            )}
            {selectedId && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span data-testid="sh11-target-no" style={{ fontSize: 20, color: C.bad, letterSpacing: 1 }}>
                    {targetNoText(no)}
                  </span>
                  <ValueBadge hv={hv} flags={flags} />
                </div>
                <Row k="目标类型" v={typeText ?? '—'} miss={typeText ? undefined : '回执未给该字段'} testid="sh11-type" />
                <Row k="置信度" v={confText(conf)} miss={conf === undefined ? '回执未给该字段' : undefined} testid="sh11-confidence" />
                <Row k="位置" v={posText(lng, lat)} miss={lng === undefined || lat === undefined ? '回执未给该字段' : undefined} testid="sh11-position" />
                <Row k="海拔" v={alt !== undefined ? `${n2s(alt)} m` : '—'} miss={alt === undefined ? '回执未给该字段' : undefined} testid="sh11-alt" />
                <FeatureGrid features={features} />
                <ThreatAssess
                  band={band}
                  bandColor={bandColor}
                  defense={fac(['defenseLevel', 'defense', 'shelterLevel'])}
                  jamming={fac(['jammingLevel', 'interference', 'ewLevel'])}
                  situation={fac(['surrounding', 'situation'])}
                  testid="sh11-threat"
                />
                <div style={{ fontSize: 10.5, color: C.textDim, lineHeight: 1.5, marginTop: 5 }}>
                  取值：{detailReply?.code === 0 ? '`targets.detail`' : '`targets.list`'} 回执（编号 no / 类型 typeName /
                  置信度 confidence / 位置 lng·lat / 海拔 alt / 等级 threatBand{!hv ? '；台账 flags 未含 hv（「高价值目标」徽标由引擎 upgrade 动作置位后出现）' : ''}）
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ---------------- SH-12：右栏整栏「目标详情」 ---------------- */}
      {detailMode && (
        <div data-testid="target-detail-panel" style={railCol}>
          <Section
            title="目标详情"
            right={detailBusy ? '读取中…' : detailReply?.code === 0 ? 'targets.detail' : (detailReply ? `code=${detailReply.code}` : '—')}
            testid="sh12-detail"
          >
            {!selectedId && <div style={missLine}>未选择目标 —— 点下方目标卡。</div>}
            {selectedId && notReady && (
              <div data-testid="sh12-detail-not-ready" style={{ fontSize: 12, color: C.warn, lineHeight: 1.7 }}>
                targets.detail 未就绪：{replyText(detailReply)}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span data-testid="sh12-target-no" style={{ fontSize: 21, color: C.bad, letterSpacing: 1 }}>
                {targetNoText(no)}
              </span>
              <ValueBadge hv={hv} flags={flags} />
            </div>
            <Row k="目标类型" v={typeText ?? '—'} miss={typeText ? undefined : '回执未给该字段'} testid="sh12-type" />
            <Row k="置信度" v={confText(conf)} miss={conf === undefined ? '回执未给该字段' : undefined} testid="sh12-confidence" />
            <Row k="位置" v={posText(lng, lat)} miss={lng === undefined || lat === undefined ? '回执未给该字段' : undefined} testid="sh12-position" />
            <Row k="海拔" v={alt !== undefined ? `${n2s(alt)} m` : '—'} miss={alt === undefined ? '回执未给该字段' : undefined} testid="sh12-alt" />

            <AiAnalysis
              testid="sh12-ai-analysis"
              rows={[
                { k: '类型判断', v: typeText, from: 'typeName', miss: typeText ? undefined : '回执未给该字段' },
                { k: '行为特征', v: undefined, from: '', miss: '回执未给该字段（最接近的 dynamicState 已用于「活动状态」）' },
                {
                  k: '威胁等级', v: band ? bandText(band) : undefined, from: 'threatBand',
                  color: bandColor, miss: band ? undefined : '回执未给该字段',
                },
                {
                  k: '活动状态', v: dynamicRow?.text, from: 'dynamicState',
                  miss: dynamicRow?.text ? undefined : '回执未给该字段',
                },
                {
                  k: '建议处置', v: dv.suggestion, from: dv.suggestionKey ?? '',
                  miss: dv.suggestion ? undefined : '回执未给该字段（引擎给的是可行动作清单，未给建议结论）',
                },
              ]}
            />

            {/* 3 枚通栏按钮：动作键只认引擎声明的清单 */}
            <ActButtons list={dv.actions} busy={actBusy} entityId={selectedId} onAct={(d) => void onAct(d)} prefix="sh12" />

            {av.entityId && (
              <div data-testid="sh12-act-result" style={{ marginTop: 6, fontSize: 11.5, color: actReply?.code === 0 ? C.ok : C.bad, lineHeight: 1.6 }}>
                targets.act 回执：{av.action ?? '—'}
                {av.to ? ` · 动作后状态 ${av.to}` : ''}
                {av.band ? ` · 威胁 ${av.band}` : ''}
                {av.idempotent ? '（幂等）' : ''}
                {av.conflict ? '（互斥冲突）' : ''}
                {actReply && actReply.code !== 0 ? `｜${replyText(actReply)}` : ''}
                {av.message && <div style={{ color: C.textDim }}>{av.message}</div>}
                {av.unmet.length > 0 && <div style={{ color: C.warn }}>未满足：{av.unmet.join('、')}</div>}
                {av.gateNote && <div style={{ fontSize: 10.5, color: C.textDim }}>{av.gateNote}</div>}
              </div>
            )}
            {dv.notes.slice(0, 2).map((t, i) => (
              <div key={i} style={{ fontSize: 10.5, color: C.textDim, lineHeight: 1.5 }}>· {t}</div>
            ))}
          </Section>

          <Section title="威胁评估（引擎因子）" right="assessment.factors[]" testid="sh12-factors">
            <DomRow k="威胁评分" text={dv.threatScore !== undefined ? n2s(dv.threatScore) : '—'}
              color={bandColor} testid="sh12-threat-score" />
            <DomRow k="等级状态" text={fac(['status'])?.text ?? '—'}
              color={fac(['status'])?.text ? threatColor(fac(['status'])?.text) : C.textDim} />
            <DomRow k="打击优先级" text={dv.priority !== undefined ? n2s(dv.priority) : '—'} />
            {dv.factors.length > 0 ? dv.factors.map((f) => (
              <div key={f.key} data-testid="sh12-factor-row" data-factor={f.key}
                style={{ display: 'flex', gap: 8, padding: '2px 0', fontSize: 11.5 }}>
                <span style={{ color: C.textDim, flex: 1, minWidth: 0 }}>
                  {f.name}{f.missing ? '（缺失）' : ''}
                </span>
                <span style={{ color: C.text, fontVariantNumeric: 'tabular-nums' }}>
                  {f.rawNumber !== undefined ? n2s(f.rawNumber) : (f.rawText ?? '—')}
                  {f.contribution !== undefined ? ` · 贡献 ${n2s(f.contribution)}` : ''}
                </span>
              </div>
            )) : (
              <div style={missLine}>回执未给该字段（`targets.detail` 的 assessment.factors[]）</div>
            )}
          </Section>
        </div>
      )}

      {/* ---------------- SH-11：右栏「集群总体状态」 ---------------- */}
      {!detailMode && (
        <div style={railCol}>
          <ClusterRail
            snapshotRaw={snap.data}
            reply={snap.reply}
            busy={snap.busy}
            onRetry={snap.resend}
            testid="sh11-cluster-rail"
          />
        </div>
      )}

      {/* ---------------- 地图下方通栏：「目标列表」横向卡条 ---------------- */}
      <div data-testid={`${P}-target-list`} style={stripStyle}>
        <div style={{ ...panel, width: '100%', height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
          <div style={{ ...panelTitle, padding: '7px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>目标列表</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: C.textDim }}>
              {stripNote}{detailMode ? '' : ' · 选中后再点一次目标卡进入「目标详情」'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'stretch', gap: 8, padding: '7px 10px 8px', flex: 1, minHeight: 0 }}>
            <button
              data-testid={`${P}-prev`}
              data-page={safePage}
              disabled={!canPrev}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              title={canPrev ? '上一页' : '没有上一页（本页已是第 1 页）'}
              style={canPrev ? arrowBtn : arrowDisabled}
            >‹</button>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', gap: 8, overflowX: 'auto' }}>
              {pageItems.map((t) => (
                <TargetCard
                  key={t.entityId}
                  t={t}
                  selected={t.entityId === selectedId}
                  onPick={() => pickTarget(t.entityId)}
                />
              ))}
              {tv.items.length === 0 && (
                <div style={{ alignSelf: 'center', fontSize: 12, color: C.textDim, lineHeight: 1.7, padding: '0 4px' }}>
                  目标列表为空
                  {list.reply && list.reply.code !== 0
                    ? ` —— 宿主未给出目标台账：${replyText(list.reply)}`
                    : '（宿主回执成功但 0 条：目标随探测出现，此屏数会变）'}
                </div>
              )}
            </div>
            <button
              data-testid={`${P}-next`}
              data-page={safePage}
              disabled={!canNext}
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              title={canNext ? '下一页' : '没有下一页（数据不超过 5 条 / 已是末页）'}
              style={canNext ? arrowBtn : arrowDisabled}
            >›</button>
          </div>
        </div>
      </div>

      <TargetsProbe
        mode={mode}
        step={state.step}
        phase={state.phase}
        listReply={list.reply}
        rows={tv.items}
        pageCount={pageCount}
        page={safePage}
        selectedId={selectedId}
        detailReply={detailReply}
        detail={dv}
        actReply={actReply}
        flags={flags}
        clusters={clusterRowsOf(snap.data)}
      />
    </div>
  )
}

/** 自证句柄 `__sh11Stats` / `__sh12Stats`（截图与验收脚本读它；**只读**）。 */
function TargetsProbe(props: {
  mode: 'list' | 'detail'
  step: number
  phase: string
  listReply: CommandReply | null
  rows: TargetRow[]
  pageCount: number
  page: number
  selectedId: string | null
  detailReply: CommandReply | null
  detail: TargetDetailView
  actReply: CommandReply | null
  flags: string[]
  clusters: ClusterRow[]
}) {
  const { mode, step, phase, listReply, rows, pageCount, page, selectedId, detailReply, detail, actReply, flags, clusters } = props
  const w = window as unknown as Record<string, unknown>
  w[mode === 'detail' ? '__sh12Stats' : '__sh11Stats'] = {
    screen: mode === 'detail' ? 'SH-12' : 'SH-11',
    mode,
    step,
    phase,
    list: {
      reply: listReply,
      count: rows.length,
      rows: rows.map((t) => ({
        entityId: t.entityId, no: t.no ?? null, typeKey: t.typeKey ?? null, typeName: t.typeName ?? null,
        threatBand: t.threat ?? null, threatScore: t.threatScore ?? null,
        confidence: t.confidence ?? null, lng: t.lng ?? null, lat: t.lat ?? null, altM: t.altM ?? null,
        priority: t.priority ?? null, flags: strList(t.raw, 'flags'),
      })),
      page, pageCount,
    },
    selected: {
      entityId: selectedId,
      no: detail.no ?? null,
      typeName: detail.typeName ?? detail.typeKey ?? null,
      confidence: detail.confidence ?? null,
      lng: detail.lng ?? null, lat: detail.lat ?? null, altM: detail.altM ?? null,
      threatBand: detail.threat ?? null,
      threatScore: detail.threatScore ?? null,
      status: detail.status ?? null,
      priority: detail.priority ?? null,
      features: detail.features,
      suggestion: detail.suggestion ?? null,
      flags,
      hv: flags.includes('hv'),
      /** 引擎给的可行动作域（空数组 = 引擎没给 → 界面灰置） */
      actionDomains: detail.actions.map((a) => a.domain),
      actionSource: detail.actions.length ? 'engine' : 'none',
      factorKeys: detail.factors.map((f) => f.key),
    },
    detail: { reply: detailReply },
    act: actReply,
    clusters,
    dom: {
      targetCards: document.querySelectorAll('[data-testid="target-card"]').length,
      detailCard: !!document.querySelector('[data-testid="sh11-detail-card"]'),
      detailPanel: !!document.querySelector('[data-testid="target-detail-panel"]'),
      aiRows: document.querySelectorAll('[data-testid="sh12-ai-row"]').length,
      actionButtons: document.querySelectorAll('[data-testid^="btn-act-"]').length,
      actionsSource: document.querySelector('[data-testid="sh12-actions"]')?.getAttribute('data-actions-source') ?? null,
      clusterRows: document.querySelectorAll('[data-testid="cluster-row"]').length,
    },
  }
  return null
}

// ---- 样式（一律 left/right/top/bottom 长写：**不写 inset 简写**，见 App.tsx 的踩坑注释）----
const RAIL_W = 320
const wrap: CSSProperties = {
  position: 'absolute', left: 12, right: 12, top: 34, bottom: 12, zIndex: 20,
}
const modePill: CSSProperties = {
  position: 'absolute', top: 0, zIndex: 22, display: 'flex', gap: 6, alignItems: 'center',
  padding: '7px 12px', borderRadius: 999, fontSize: 12.5,
  background: 'rgba(6,26,47,.86)', border: `1px solid ${C.border}`,
}
const floatCard: CSSProperties = {
  ...panel, position: 'absolute', right: RAIL_W + 12, top: 44, zIndex: 21,
  width: 292, maxHeight: '58%', overflowY: 'auto', overflowX: 'hidden',
}
const railCol: CSSProperties = {
  position: 'absolute', right: 0, top: 44, bottom: 26, width: RAIL_W, zIndex: 21,
  display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
}
const stripStyle: CSSProperties = {
  position: 'absolute', left: 0, right: RAIL_W + 12, bottom: 26, height: 116, zIndex: 21,
}
const thumb: CSSProperties = {
  height: 34, borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'linear-gradient(135deg, rgba(20,42,68,.9), rgba(8,20,36,.9))',
  border: `1px solid ${C.border}`, overflow: 'hidden',
}
const badge: CSSProperties = {
  fontSize: 10.5, color: '#ffd9d4', borderRadius: 4, padding: '1px 6px',
  border: '1px solid rgba(239,68,68,.55)', background: 'rgba(120,30,20,.45)',
}
const featureCell: CSSProperties = {
  fontSize: 11.5, color: C.text, padding: '5px 7px', borderRadius: 6,
  background: 'rgba(8,24,44,.72)', border: `1px solid ${C.border}`,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}
const missLine: CSSProperties = { fontSize: 11, color: C.textDim, lineHeight: 1.6 }
const retryBtn: CSSProperties = {
  marginTop: 6, padding: '3px 10px', fontSize: 11, cursor: 'pointer', borderRadius: 5,
  background: 'rgba(10,20,36,.7)', border: `1px solid ${C.border}`, color: C.text,
}
const arrowBtn: CSSProperties = {
  width: 26, flex: '0 0 auto', cursor: 'pointer', borderRadius: 6, fontSize: 15,
  background: 'rgba(10,20,36,.75)', border: `1px solid ${C.borderStrong}`, color: C.text,
}
const arrowDisabled: CSSProperties = {
  width: 26, flex: '0 0 auto', cursor: 'default', borderRadius: 6, fontSize: 15,
  background: 'rgba(10,20,36,.45)', border: `1px solid ${C.border}`, color: C.unknown,
}
const actDisabled: CSSProperties = {
  padding: '9px 12px', fontSize: 13, cursor: 'default', borderRadius: 8,
  border: `1px solid ${C.border}`, background: 'rgba(10,20,36,.45)', color: C.unknown,
}

export default TargetsScreen
