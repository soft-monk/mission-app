// mission-app · apps/web/src/screens/DamageAssessScreen.tsx
//
// SH-17「毁伤评估地图界面」（需求专篇 DES-APP-001 §3 SH-17 / 参考图 `场景1\T7-1.png`）。
//
// 版式（照图）：顶栏/左导航（全局壳）｜中区 3D 地图占满（左下浮层 3 标签 + 2 按钮）
//              ｜右栏 3 面板（目标状态 / 集群回收 / 节点状态）｜底部 6 项全局状态条（全局壳）。
//              `MapStage` 由 App 渲染，本屏只摆**浮层与地图叠加图元**。
//
// ★ 地图上画什么、不画什么（**坐标必须有出处**，逐条写清楚）：
//   画：
//     · 灰色准星 + 「目标NNN」「已失效」→ `targets.list` 里**第一个已处置目标**
//       （判定只认引擎的 `dynamicState = struck / destroyed`，见 `useExec.isStruckState`；
//        颜色取 `theme.muted` 灰 —— 需求 §6 E-25：本图目标已是灰的）；
//     · 黄色三角「残余威胁」×N → 台账里**仍未失效**的目标（引擎状态为唯一判据；N = 真实条数，
//        图上画 2 个是示意，界面不写死条数），每处都带上引擎的 `threatBand/status` 原样值；
//     · 浅蓝白虚线「复核航线」→ `guidance.plan` 的 `assessRoute.waypoints`
//       （几何来源：场景数据 `strike-geometry.json`，经宿主 `/api/state` 的 `strike.guidance` 带出）；
//     · 青色「返航轨迹」→ **台账平台位置按台账顺序连线**（`targets.list.platformEntities` 的
//       真实坐标；引擎没有"返航航路"几何，故图上写明这是平台位置连线，不是计划航路）。
//   不画（每条都写出原因，落在左下「地图缺失几何」里，MUST NOT 编几何）：
//     · 灰色椭圆「已清除」：没有半径/多边形来源（`strike-geometry.json` 只有 IP 点与评估航线）；
//     · 绿色环形地面节点 +「节点待脱离」：引擎拓扑（`topology.evaluate.primitives`）只有 6 个集群
//       + 10 个平台节点，没有地面/前沿节点的坐标；
//     · 返航轨迹的**箭头**：map-2d 的 `route` 图元没有箭头样式（不为像图而伪造箭头）。
//   右栏三面板里凡引擎没有字段的项（区域状态 / 残余风险等级 / 回收进度 / 返航集群数 / 节点状态）
//   一律显示「—」+ 原因：规则包 `entityTypes.json` 的 `dynamicStates` 只有
//   onMove/active/deploying/relocating/briefStop/static/struck/destroyed —— 没有"返航/回收/脱离"。
//
// ★ 两个按钮（照图）：【继续复核】= 本屏重取台账（`targets.list`）；【准备脱离】= `onGo('SH-18')`。
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { DEFAULT_INSTANCE_ID, getMapInstance, MapDraw, type PrimitiveKind } from 'map-2d'
import { C, panel, panelTitle } from '../theme'
import type { FlowState } from '../api'
import type { UseFlow } from '../flow/useFlow'
import { isObj, n2s, num, obj, objList, pick, replyText, str, useVerbOnce } from '../flow/useSituation'
import { readTargets, type TargetRow } from '../flow/useOps'
import { dynamicStateName, isStruckState } from '../flow/useExec'
import { VerbVerdict } from './VerbVerdict'

/** 本屏画在地图上的图元 id 前缀（清理与计数只认它；MapStage / 其它屏的图元一个都不碰）。 */
const PREFIX = 'DMG7:'

/** 平台机型的域（用于把台账行分成"目标"与"平台"——取自本工程四型词汇，见 entityTypes.json）。 */
const PLATFORM_TYPE_KEYS = ['optical', 'radar', 'electronic', 'comm']

// ============================================================================
// ① 读取器（只取字段：读不到就 undefined，界面显示「—」）
// ============================================================================

/** `/api/state` 里本屏要用、但 `FlowState` 类型未声明的段（**经类型断言读真实负载，字段名不改**）。 */
export interface StateExtras {
  /** `state.strike`：方案/引导可用性 */
  strike: { adoptedPlanId?: string; confirmedPlanId?: string; guidanceAvailable?: boolean }
  /** `state.strike.guidance.assessRoute`（复核/评估航线的**唯一几何来源**） */
  assessRoute?: { key?: string; name?: string; points: [number, number][] }
  /** `state.exec`：执行记录（`exec.run` 的引擎裁决原样） */
  exec: {
    count?: number
    diveApplied?: number
    records: { entityId?: string; stateBefore?: string; stateAfter?: string; hitPlatformId?: string; atMs?: number; aborted?: boolean }[]
  }
  /** `/api/state.platformEntities` 的条目数（设备 → 台账实体） */
  platformEntityCount?: number
}

/** 读 `assessRoute.waypoints`：数组 `[lng,lat]` 与对象 `{lng,lat}` 两种形状都收（宿主两种都给过）。 */
function readWaypoints(v: unknown): [number, number][] {
  const out: [number, number][] = []
  if (!Array.isArray(v)) return out
  for (const w of v) {
    if (Array.isArray(w) && typeof w[0] === 'number' && typeof w[1] === 'number') { out.push([w[0], w[1]]); continue }
    if (isObj(w)) {
      const lng = num(w, 'lng', 'lon', 'longitude')
      const lat = num(w, 'lat', 'latitude')
      if (lng !== undefined && lat !== undefined) out.push([lng, lat])
    }
  }
  return out
}

export function readStateExtras(state: FlowState): StateExtras {
  const root = state as unknown as Record<string, unknown>
  const strike = obj(root, 'strike')
  const guidance = obj(strike, 'guidance')
  const routeRaw = obj(guidance, 'assessRoute')
  const points = readWaypoints(pick(routeRaw, 'waypoints'))
  const execRaw = obj(root, 'exec')
  const pe = root['platformEntities']
  return {
    strike: {
      adoptedPlanId: str(strike, 'adoptedPlanId'),
      confirmedPlanId: str(strike, 'confirmedPlanId'),
      guidanceAvailable: typeof strike?.guidanceAvailable === 'boolean' ? strike.guidanceAvailable : undefined,
    },
    assessRoute: routeRaw || points.length
      ? { key: str(routeRaw, 'key', 'id'), name: str(routeRaw, 'name', 'label'), points }
      : undefined,
    exec: {
      count: num(execRaw, 'count'),
      diveApplied: num(execRaw, 'diveApplied'),
      records: objList(execRaw, 'records').map((r) => ({
        entityId: str(r, 'entityId', 'id'),
        stateBefore: str(r, 'stateBefore'),
        stateAfter: str(r, 'stateAfter'),
        hitPlatformId: str(r, 'hitPlatformId'),
        atMs: num(r, 'atMs'),
        aborted: typeof r.aborted === 'boolean' ? r.aborted : undefined,
      })),
    },
    platformEntityCount: isObj(pe) ? Object.keys(pe).length : undefined,
  }
}

/** 台账行的分类：目标 / 平台（用 `/api/state`+回执里显式的 `targets[]`、`platformEntities[]` 两侧名单）。 */
export interface LedgerSplit {
  targets: TargetRow[]
  platforms: TargetRow[]
  /** 分类口径（界面标注用） */
  basis: string
}

export function splitLedger(rows: TargetRow[], rawData: unknown): LedgerSplit {
  const src = isObj(rawData) ? rawData : undefined
  const idOf = (r: Record<string, unknown>) => str(r, 'id', 'entityId', 'key')
  const targetIds = new Set(objList(src, 'targets').map(idOf).filter(Boolean) as string[])
  const platformIds = new Set(objList(src, 'platformEntities').map(idOf).filter(Boolean) as string[])
  const targets: TargetRow[] = []
  const platforms: TargetRow[] = []
  for (const r of rows) {
    if (targetIds.size || platformIds.size) {
      if (targetIds.has(r.entityId)) { targets.push(r); continue }
      if (platformIds.has(r.entityId)) { platforms.push(r); continue }
    }
    // 两侧名单都读不到时的回落：按机型域分（平台四型 vs 其它）
    const key = (r.typeKey ?? '').toLowerCase()
    if (PLATFORM_TYPE_KEYS.includes(key)) platforms.push(r)
    else targets.push(r)
  }
  return {
    targets,
    platforms,
    basis: targetIds.size || platformIds.size
      ? `回执里的 targets[]（${targetIds.size}）/ platformEntities[]（${platformIds.size}）名单`
      : '两侧名单缺失 → 按 typeKey 是否属于平台四型（optical/radar/electronic/comm）分',
  }
}

/** 目标编号文本（`no` → 「目标003」；没有就退回台账 id）。 */
function targetLabel(t: TargetRow): string {
  return t.no !== undefined ? `目标${String(t.no).padStart(3, '0')}` : (t.name || t.entityId)
}

// ============================================================================
// ② 地图投影（DOM 浮层标签跟着地图走；纯只读，不改 MapStage）
// ============================================================================

interface Anchor { id: string; lng: number; lat: number }

/**
 * 把一组经纬度锚点投到屏幕坐标（像素，相对地图容器 = 本覆盖层的坐标系）。
 *
 * 地图实例由 `MapView` 在 load 后登记，可能**晚于**本屏挂载 → 先按 300 ms 轮询等它出现，
 * 出现后改为地图事件驱动（move/zoom/resize），并把结果缓存（不变就不 setState，避免空转渲染）。
 */
function useProjected(anchors: Anchor[]): Record<string, { x: number; y: number }> {
  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>({})
  const key = anchors.map((a) => `${a.id}@${a.lng},${a.lat}`).join(';')
  const ref = useRef(anchors)
  ref.current = anchors
  useEffect(() => {
    let stopped = false
    let raf = 0
    let last = ''
    const update = (): boolean => {
      const map = getMapInstance(DEFAULT_INSTANCE_ID)
      if (!map) return false
      const next: Record<string, { x: number; y: number }> = {}
      for (const a of ref.current) {
        const q = map.project([a.lng, a.lat])
        next[a.id] = { x: q.x, y: q.y }
      }
      const sig = JSON.stringify(next)
      if (sig !== last) { last = sig; setPos(next) }
      return true
    }
    const onMove = () => {
      if (raf) return
      raf = window.requestAnimationFrame(() => { raf = 0; update() })
    }
    const timer = window.setInterval(() => {
      if (stopped) return
      if (!update()) return
      const map = getMapInstance(DEFAULT_INSTANCE_ID)
      map?.on('move', onMove)
      map?.on('zoom', onMove)
      map?.on('resize', onMove)
      window.clearInterval(timer)
    }, 300)
    return () => {
      stopped = true
      window.clearInterval(timer)
      if (raf) window.cancelAnimationFrame(raf)
      const map = getMapInstance(DEFAULT_INSTANCE_ID)
      map?.off('move', onMove)
      map?.off('zoom', onMove)
      map?.off('resize', onMove)
    }
  }, [key])
  return pos
}

// ============================================================================
// ③ 小件
// ============================================================================

/** 一行「名 + 值」：值缺失显示「—」，**不补 0**。 */
function Row({ k, v, color, sub, testid }: { k: string; v: string; color?: string; sub?: string; testid?: string }) {
  return (
    <div data-testid={testid} style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 12.5, alignItems: 'baseline' }}>
      <span style={{ color: C.textDim, width: 74, flex: '0 0 auto' }}>{k}</span>
      <span style={{ color: color ?? C.text, minWidth: 0, wordBreak: 'break-word' }}>{v}</span>
      {sub !== undefined && <span style={{ color: C.textDim, fontSize: 10, flex: 1, textAlign: 'right' }}>{sub}</span>}
    </div>
  )
}

function Section({ title, children, testid, right }: {
  title: React.ReactNode
  children: React.ReactNode
  testid?: string
  right?: React.ReactNode
}) {
  return (
    <div data-testid={testid} style={{ ...panel, width: '100%', boxSizing: 'border-box', pointerEvents: 'auto' }}>
      <div style={panelTitle}>
        {title}
        {right !== undefined && <span style={{ float: 'right', fontSize: 11.5, color: C.textDim }}>{right}</span>}
      </div>
      <div style={{ padding: '7px 12px 9px' }}>{children}</div>
    </div>
  )
}

/** 左下浮层的一个状态标签（照图：「目标灰化 ●」…；点 = 该要素此刻有没有几何，绿=有、灰=缺）。 */
function Tag({ text, on, title, testid }: { text: string; on: boolean; title: string; testid?: string }) {
  return (
    <span
      data-testid={testid}
      data-on={on ? '1' : '0'}
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 14, fontSize: 12,
        background: 'rgba(6,26,47,.85)', border: `1px solid ${C.border}`, color: C.text,
      }}
    >
      {text}
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: on ? C.ok : C.unknown }} />
    </span>
  )
}

// ============================================================================
// ④ 屏体（SH-17）
// ============================================================================

export function DamageAssessScreen({ state, flow, onGo, goto }: {
  state: FlowState
  flow: UseFlow
  onGo?: (id: string) => void
  /** 走流程（步号归宿主）：本屏【准备脱离】优先用 `onGo('SH-18')`，没有它时回落 `goto(11)` */
  goto?: (step: number) => void
}) {
  // ---- 台账（本屏唯一的数据命令；【继续复核】= 重发它）----
  const list = useVerbOnce(flow, 'targets.list', {}, true)
  const tl = useMemo(() => readTargets(list.data), [list.data])
  const split = useMemo(() => splitLedger(tl.items, list.data), [tl, list.data])

  const struck = useMemo(
    () => split.targets.find((t) => isStruckState(t.status, t.motion) && t.lng !== undefined && t.lat !== undefined),
    [split],
  )
  const residual = useMemo(
    () => split.targets.filter((t) => !isStruckState(t.status, t.motion) && t.lng !== undefined && t.lat !== undefined),
    [split],
  )
  /** 执行记录（`state.exec`）：引擎给的处置事实（stateBefore → stateAfter / 命中平台） */
  const extras = useMemo(() => readStateExtras(state), [state])
  const struckRecord = useMemo(
    () => (struck ? extras.exec.records.find((r) => r.entityId === struck.entityId) : undefined),
    [extras, struck],
  )

  const routePoints = useMemo(() => extras.assessRoute?.points ?? [], [extras])
  const platformPoints = useMemo(
    () => split.platforms.filter((p) => p.lng !== undefined && p.lat !== undefined).map((p) => [p.lng as number, p.lat as number] as [number, number]),
    [split],
  )

  // ---- 地图叠加（只画有出处的几何；离开本屏清干净）----
  //
  // 依赖用**几何内容签名**而不是对象引用：`/api/state` 每 500 ms 轮询一次，对象每次都换新，
  // 直接把它们当依赖会让图元每 500 ms 清一次重画一遍（画面会闪）。签名不变 = 不动图元。
  const drawSig = useMemo(() => [
    struck ? `${struck.entityId}:${struck.lng},${struck.lat}` : '-',
    residual.map((t) => `${t.entityId}:${t.lng},${t.lat}`).join(';'),
    routePoints.map((p) => p.join(',')).join(';'),
    platformPoints.map((p) => p.join(',')).join(';'),
    extras.assessRoute?.name ?? '',
  ].join('|'), [struck, residual, routePoints, platformPoints, extras.assessRoute?.name])
  const drawnRef = useRef<{ kind: PrimitiveKind; id: string }[]>([])
  useEffect(() => {
    const prev = drawnRef.current
    const next: { kind: PrimitiveKind; id: string }[] = []
    MapDraw.batch(() => {
      for (const d of prev) MapDraw.remove(d.kind, d.id)
      // ① 目标灰化准星（引擎判 struck/destroyed 的目标；颜色取 theme.muted 灰）
      if (struck && struck.lng !== undefined && struck.lat !== undefined) {
        const id = `${PREFIX}target:${struck.entityId}`
        MapDraw.add('target', {
          id, lng: struck.lng, lat: struck.lat,
          color: C.muted, status: 'gray', label: targetLabel(struck),
        })
        next.push({ kind: 'target', id })
      }
      // ② 残余威胁（仍未失效的台账目标）→ 黄三角：map-2d 没有"三角警示"图元，用 label 图元画 ▲ 字形
      for (const t of residual) {
        if (t.lng === undefined || t.lat === undefined) continue
        const id = `${PREFIX}residual:${t.entityId}`
        MapDraw.add('label', { id, lng: t.lng, lat: t.lat, text: '▲', color: C.warn, size: 15, radius: 0 })
        next.push({ kind: 'label', id })
      }
      // ③ 复核航线（评估航线几何，来源 strike-geometry.json → /api/state 的 strike.guidance）
      if (routePoints.length >= 2) {
        const id = `${PREFIX}assess-route`
        MapDraw.add('route', { id, points: routePoints, color: '#dbeafe', dashed: true, name: extras.assessRoute?.name ?? 'assessRoute' })
        next.push({ kind: 'route', id })
      }
      // ④ 返航轨迹：引擎没有返航航路几何 → 画"台账平台位置按台账顺序的连线"，并在界面写明口径
      if (platformPoints.length >= 2) {
        const id = `${PREFIX}return-track`
        MapDraw.add('route', { id, points: platformPoints, color: '#22d3ee', dashed: false, name: '台账平台位置连线' })
        next.push({ kind: 'route', id })
      }
    })
    drawnRef.current = next
    return () => {
      const mine = drawnRef.current
      MapDraw.batch(() => { for (const d of mine) MapDraw.remove(d.kind, d.id) })
      drawnRef.current = []
    }
  }, [drawSig])

  // ---- DOM 浮层标签：锚在地图坐标上（随地图移动）----
  const anchors: Anchor[] = useMemo(() => {
    const a: Anchor[] = []
    if (struck && struck.lng !== undefined && struck.lat !== undefined) a.push({ id: 'struck', lng: struck.lng, lat: struck.lat })
    for (const t of residual) if (t.lng !== undefined && t.lat !== undefined) a.push({ id: `res:${t.entityId}`, lng: t.lng, lat: t.lat })
    if (routePoints.length >= 1) a.push({ id: 'route', lng: routePoints[0][0], lat: routePoints[0][1] })
    return a
  }, [struck, residual, routePoints])
  const px = useProjected(anchors)

  const ledgerErr = list.reply !== null && list.reply.code !== 0 ? replyText(list.reply) : ''

  /** 「地图缺失几何」逐条（不画就写明原因 —— 这一块是本屏"不编几何"的证据） */
  const missing: { key: string; name: string; reason: string }[] = [
    {
      key: 'cleared-area', name: '灰色椭圆「已清除」',
      reason: '没有半径/多边形来源：strike-geometry.json 只有 IP 点与评估航线，台账实体也没有"清除区"字段 → 不画（不编几何）',
    },
    {
      key: 'ground-node', name: '绿色环形地面节点「节点待脱离」',
      reason: `引擎拓扑（topology.evaluate.primitives）里只有集群与平台节点，没有地面/前沿节点坐标 → 不画`,
    },
    {
      key: 'return-arrow', name: '返航轨迹箭头',
      reason: 'map-2d 的 route 图元没有箭头样式（只有 dashed/color/width）→ 只画线、不加箭头',
    },
  ]

  return (
    <div data-testid="sh-17" data-screen="SH-17" style={rootStyle}>
      {/* ---------------- 地图浮层标签（灰色准星两行 + 残余威胁）---------------- */}
      {struck && px['struck'] && (
        <div
          data-testid="sh17-target-label"
          data-entity-id={struck.entityId}
          data-state={struck.motion ?? ''}
          style={{ position: 'absolute', left: px['struck'].x + 14, top: px['struck'].y - 30, pointerEvents: 'none' }}
        >
          <div style={labelBox(C.muted)}>
            <div style={{ fontSize: 13, color: '#e6e9f0' }}>{targetLabel(struck)}</div>
            <div data-testid="sh17-target-state" style={{ fontSize: 12, color: C.muted }}>已失效</div>
            <div style={{ fontSize: 9.5, color: C.textDim, marginTop: 1 }}>
              {`引擎 dynamicState=${struck.motion ?? '—'}`}
            </div>
          </div>
        </div>
      )}
      {residual.map((t) => {
        const p = t.lng !== undefined && t.lat !== undefined ? px[`res:${t.entityId}`] : undefined
        if (!p) return null
        return (
          <div
            key={t.entityId}
            data-testid="sh17-residual-label"
            data-entity-id={t.entityId}
            data-threat={t.threat ?? ''}
            data-status={t.status ?? ''}
            style={{ position: 'absolute', left: p.x + 10, top: p.y - 12, pointerEvents: 'none' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: C.warn, fontSize: 15, lineHeight: '15px' }}>▲</span>
              <span style={{ ...labelBox(C.warn), padding: '1px 6px', fontSize: 11.5 }}>残余威胁</span>
            </div>
            <div style={{ fontSize: 9, color: C.textDim, marginLeft: 16 }}>
              {`${targetLabel(t)} · threatBand=${t.threat ?? '—'} · status=${t.status ?? '—'}`}
            </div>
          </div>
        )
      })}
      {routePoints.length >= 2 && px['route'] && (
        <div
          data-testid="sh17-route-label"
          style={{ position: 'absolute', left: px['route'].x - 30, top: px['route'].y - 16, pointerEvents: 'none' }}
        >
          <span style={{ ...labelBox('#dbeafe'), fontSize: 11.5 }}>
            复核航线（assessRoute · {routePoints.length} 个航点）
          </span>
        </div>
      )}

      {/* ---------------- 左下浮层：3 标签 + 2 按钮 + 缺失几何 ---------------- */}
      <div style={leftBottomStyle}>
        <div data-testid="sh17-tags" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Tag
            testid="sh17-tag-target" text="目标灰化" on={!!struck}
            title={struck
              ? `${targetLabel(struck)} 由图元 DMG7:target:${struck.entityId} 画成灰色准星（引擎 dynamicState=${struck.motion ?? '—'}）`
              : `台账里没有"已处置（dynamicState=struck/destroyed）"的目标 → 不画灰化准星${ledgerErr ? `（targets.list → ${ledgerErr}）` : ''}`}
          />
          <Tag
            testid="sh17-tag-residual" text="残余标记" on={residual.length > 0}
            title={residual.length > 0
              ? `${residual.length} 个仍未失效的台账目标以 ▲ 标出（坐标来自 targets.list；状态原样显示在标签下）`
              : '台账里没有被判"仍未失效"的目标 → 不画残余威胁标记（不编）'}
          />
          <Tag
            testid="sh17-tag-return" text="返航轨迹" on={platformPoints.length >= 2}
            title={platformPoints.length >= 2
              ? `青色轨迹 = 台账平台位置按台账顺序连线（${platformPoints.length} 台）；引擎未给返航航路几何`
              : `台账平台坐标不足 2 个（${platformPoints.length} 个）→ 不画返航轨迹`}
          />
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          <button data-testid="sh17-btn-recheck" style={primaryBtn} disabled={list.busy} onClick={list.resend}>
            {list.busy ? '复核中…' : '继续复核'}
          </button>
          <button data-testid="sh17-btn-detach" style={ghostBtn} onClick={() => { if (onGo) onGo('SH-18'); else goto?.(11) }}>
            准备脱离
          </button>
          <span style={{ fontSize: 10.5, color: C.textDim, alignSelf: 'center', maxWidth: 250, lineHeight: 1.45 }}>
            【继续复核】重发 `targets.list`（本屏重取台账）；【准备脱离】切到 SH-18 任务总结。
          </span>
        </div>

        <div
          data-testid="sh17-missing-note"
          style={{ ...panel, boxSizing: 'border-box', marginTop: 8, padding: '7px 10px', pointerEvents: 'auto' }}
        >
          <div style={{ fontSize: 11.5, color: C.warn, marginBottom: 3 }}>
            地图缺失几何（引擎/台账没给坐标的一律不画，逐条写明原因）
          </div>
          {missing.map((m) => (
            <div key={m.key} data-testid="sh17-missing-row" data-element={m.key} style={{ fontSize: 10.5, color: C.textDim, lineHeight: 1.5 }}>
              · {m.name}：{m.reason}
            </div>
          ))}
          {!extras.assessRoute && (
            <div data-testid="sh17-missing-row" data-element="assess-route" style={{ fontSize: 10.5, color: C.textDim, lineHeight: 1.5 }}>
              · 复核航线：`/api/state` 的 `strike.guidance.assessRoute.waypoints` 未就绪
              （需要先 `strike.adopt → strike.confirm → guidance.plan`）→ 不画虚线环（不编几何）
            </div>
          )}
        </div>
      </div>

      {/* ---------------- 右栏 3 面板（照图）---------------- */}
      <div style={rightColStyle}>
        <Section
          title="目标状态"
          testid="sh17-target-panel"
          right={struck ? `dynamicState=${struck.motion ?? '—'}` : '台账未就绪'}
        >
          {struck ? (
            <>
              <Row k="目标" v={targetLabel(struck)} testid="sh17-panel-target" />
              <Row
                k="状态"
                v={isStruckState(struck.status, struck.motion) ? '已失效' : '—'}
                color={C.muted}
                sub={struck.motion ? `dynamicState=${struck.motion}` : '未给'}
                testid="sh17-panel-target-state"
              />
              <Row
                k="引擎状态名"
                v={(() => { const n = dynamicStateName(struck.motion); return n.source === 'key' ? `${n.text}（规则包未给中文名，显示键）` : n.text })()}
                sub="entityTypes.json dynamicStates"
              />
              <Row
                k="处置回执"
                v={struckRecord ? `${struckRecord.stateBefore ?? '—'} → ${struckRecord.stateAfter ?? '—'}` : '—'}
                sub={struckRecord ? `exec.run 记录（sim ${n2s(struckRecord.atMs, ' ms')}）` : 'state.exec 无该目标记录'}
              />
              <Row k="命中平台" v={struckRecord?.hitPlatformId ?? '—'} sub="exec.run 的 hitPlatformId" />
              <Row k="区域状态" v="—" color={C.unknown} sub="引擎无该字段" />
              <Row k="残余风险" v="—" color={C.unknown} sub="引擎无风险等级字段" />
              <Row
                k="台账计数"
                v={`目标 ${split.targets.length} 个 · 已失效 ${split.targets.filter((t) => isStruckState(t.status, t.motion)).length} 个`}
                sub={split.basis}
                testid="sh17-panel-counts"
              />
              <div style={{ fontSize: 10, color: C.warn, lineHeight: 1.5, marginTop: 3 }}>
                「区域状态 / 残余风险」引擎没有字段（本屏 step 10 的命令面只有 `targets.list` / `exec.run` / `exec.abort`）
                → 显示「—」，MUST NOT 编"已复核/低"。
              </div>
            </>
          ) : (
            <div data-testid="sh17-no-struck" style={{ fontSize: 11.5, color: C.warn, lineHeight: 1.7 }}>
              台账里没有"已处置"的目标（判定只认引擎 `dynamicState = struck / destroyed`）→ 编号与状态显示「—」。
              {ledgerErr ? <div style={{ color: C.textDim }}>targets.list → {ledgerErr}</div> : null}
            </div>
          )}
        </Section>

        <Section title="集群回收" testid="sh17-recover-panel" right="引擎无该字段">
          <Row k="回收进度" v="—" color={C.unknown} sub="无分子/分母" testid="sh17-recover-progress" />
          <div style={{ height: 6, borderRadius: 3, background: 'rgba(95,176,255,.18)', overflow: 'hidden', margin: '2px 0 4px' }}>
            <div data-testid="sh17-recover-bar" style={{ width: '0%', height: '100%', background: C.bar }} />
          </div>
          <Row k="返航集群" v="—" color={C.unknown} sub="无该状态" />
          <Row k="台账平台" v={`${split.platforms.length} 台`} sub="targets.list（platformEntities）" />
          <Row k="平台实体映射" v={extras.platformEntityCount !== undefined ? `${extras.platformEntityCount} 条` : '—'} sub="/api/state.platformEntities" />
          <Row k="编组集群" v={typeof state.capabilities?.['scenarioGroups'] === 'number' ? `${state.capabilities['scenarioGroups']} 个` : '—'} sub="capabilities.scenarioGroups" />
          <div style={{ fontSize: 10, color: C.warn, lineHeight: 1.5, marginTop: 3 }}>
            规则包 `entityTypes.json` 的 `dynamicStates` 只有
            onMove/active/deploying/relocating/briefStop/static/struck/destroyed —— 其中没有"返航/回收"状态，
            所以「回收进度 68%」「3 个集群返航中」这两个槽位没有数据来源，显示「—」（不抄图上的示意值）。
          </div>
        </Section>

        <Section title="节点状态" testid="sh17-node-panel" right="引擎无该字段">
          <Row k="前沿节点" v="—" color={C.unknown} sub="无地面/前沿节点台账" testid="sh17-node-front" />
          <Row k="复核侦察" v="—" color={C.unknown} sub="无该阶段状态" />
          <Row k="链路释放" v="—" color={C.unknown} sub="无该状态" />
          <Row k="执行记录" v={extras.exec.count !== undefined ? `${extras.exec.count} 条` : '—'} sub="/api/state.exec.count" />
          <Row k="俯冲生效" v={extras.exec.diveApplied !== undefined ? `${extras.exec.diveApplied} 次` : '—'} sub="/api/state.exec.diveApplied" />
          <Row k="方案/引导" v={`adopted=${extras.strike.adoptedPlanId || '—'} · confirmed=${extras.strike.confirmedPlanId || '—'}`} sub={`guidanceAvailable=${String(extras.strike.guidanceAvailable ?? '—')}`} />
          <div style={{ fontSize: 10, color: C.warn, lineHeight: 1.5, marginTop: 3 }}>
            「前沿节点待脱离 / 复核侦察进行中 / 链路释放准备中」在引擎侧没有对应状态与命令
            （`topology.evaluate.primitives` 里也只有集群与平台节点）→ 三个槽位显示「—」。
          </div>
        </Section>

        <VerbVerdict
          rows={[
            {
              verb: 'targets.list', reply: list.reply, busy: list.busy, onRetry: list.resend,
              okNote: `${split.targets.length} 个目标 · ${split.platforms.length} 台平台 · 已失效 ${split.targets.filter((t) => isStruckState(t.status, t.motion)).length}`,
            },
          ]}
        />
      </div>
    </div>
  )
}

/** 浮层小标签的统一样式（灰底 + 描边 + 单色字）。 */
function labelBox(color: string): CSSProperties {
  return {
    display: 'inline-block', padding: '3px 8px', borderRadius: 6,
    background: 'rgba(6,20,36,.86)', border: `1px solid ${color}`,
    color, lineHeight: 1.35, whiteSpace: 'nowrap',
  }
}

// ---- 样式（一律 left/right/top/bottom 长写：**不写 inset 简写**，见 App.tsx 的踩坑注释）----
// `pointerEvents:'none'`：本层是地图浮层，除了面板与按钮都别挡住地图操作。
const rootStyle: CSSProperties = {
  position: 'absolute', left: 12, right: 12, top: 34, bottom: 36, zIndex: 20, pointerEvents: 'none',
}
const leftBottomStyle: CSSProperties = {
  position: 'absolute', left: 0, bottom: 0, width: 560, pointerEvents: 'auto',
}
const rightColStyle: CSSProperties = {
  position: 'absolute', right: 0, top: 0, bottom: 0, width: 302,
  display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
  pointerEvents: 'auto',
}
const primaryBtn: CSSProperties = {
  padding: '9px 22px', fontSize: 14, cursor: 'pointer', borderRadius: 8, whiteSpace: 'nowrap',
  letterSpacing: 0.5, border: '1px solid rgba(95,176,255,.6)',
  background: 'linear-gradient(180deg,#2563eb,#1d4ed8)', color: '#eaf4ff',
}
const ghostBtn: CSSProperties = {
  padding: '9px 20px', fontSize: 13.5, cursor: 'pointer', borderRadius: 8, whiteSpace: 'nowrap',
  background: 'rgba(10,20,36,.75)', border: `1px solid ${C.borderStrong}`, color: C.text,
}

export default DamageAssessScreen
