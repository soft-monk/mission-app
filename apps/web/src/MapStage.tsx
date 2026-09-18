// mission-app · apps/web/src/MapStage.tsx
//
// 页面做五件事，别的都不做（没有阶段规则、没有评分、没有告警逻辑）：
//   ① 底图与视角：瓦片模板从宿主 `/runtime-config` 拿，视角用场景数据里的 center/zoom
//   ② 静态态势：把 deployment / task-areas / airspace 的区域多边形与标注画出来（AreaItem / LabelItem）
//   ③ 实时态势：订阅 `telemetry.uav.pos`，按 uavId 增量维护无人机与航迹，再按节拍上屏
//   ④ 如实显示链路状态（连接中 / 已连接 / 已断开，断开时提示"数据可能已过期"）
//   ⑤ **交互层**：挂 map-2d 的 `<DrawLayer/>`（量算 / 手绘 / 图元编辑，M2-DRAW-08 / M2-CTRL-10），
//      并按规则包 `view.compose` 声明的控件把 指北针 / 比例尺 / 缩放按钮 打开（M2-CTRL-01）
//
// ★ 纪律：不改 packages/（后端）、不改其它模块仓；map-2d 用别名原地引用。
//
// 上屏路径说明（为什么实时数据不放进 `MapData.uavs`）：
//   `MapData.uavs` 走的是 map-2d 的 `LayerManager.setUavs()`——那条路是"整表替换"，
//   每来一帧就重灌一次，且不吃本批新增的位图图标能力。
//   本页要的是"按 uavId 增量更新"，所以实时无人机与航迹统一经 `MapDraw` 上屏，
//   `MapData.uavs` 保持空数组（两者同时用会互相覆盖同一个数据源）。
//
// 排障信息条：`debug` 为真时才渲染那条 `mission-app | 通道 | /health | engines` 自证信息条。
//   产品屏一律 `debug={false}`（它属于开发自证，不该出现在交付界面上）；
//   `?stage=map` 排障后门传 `debug` 保留原始信息条。
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { CoordReadout, DrawLayer, MapDraw, MapView, mapCommands, mapInstance, useInteraction, type MapData } from 'map-2d'
import { DEFAULT_MAP_STYLE, controlSpecsOf, groupColorOf, loadMapStyle, trackStyleOf } from './map-style'
import { DEFAULT_SCENARIO, toAreaItems, toLabelItems } from './scenario'
import { DEFAULT_WS_URL, TelemetryStore, connectTelemetry, type LinkState } from './telemetry'

/** 瓦片模板缺省值（与 config.json 的 tiles.template 一致；运行时以宿主 /runtime-config 为准） */
const DEFAULT_TILE_TEMPLATE = '/tiles/{z}/{x}/{y}.jpg'

/** 上屏节拍（ms）：WS 可能 10 Hz 到达，地图不需要跟着 10 Hz 重画 */
const FLUSH_INTERVAL_MS = 120
/** 超过这么久没有新数据就提示"数据可能已过期" */
const STALE_AFTER_MS = 5000

interface EngineRow { linked: boolean; instantiated: boolean; ok: boolean; note?: string }
interface RuntimeConfig {
  version: string
  tiles: { template: string }
  stats: { engines: Record<string, EngineRow> }
}

/** 从 URL 取参数（`?ws=` 覆盖通道地址，`?style=` 覆盖样式配置，见 map-style.ts） */
function param(name: string): string | null {
  try { return new URLSearchParams(window.location.search).get(name) } catch { return null }
}

const barStyle: CSSProperties = {
  position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10,
  display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap',
  padding: '6px 12px',
  background: 'rgba(4, 24, 47, 0.82)',
  borderBottom: '1px solid rgba(95, 176, 255, 0.25)',
  backdropFilter: 'blur(4px)',
  pointerEvents: 'none',
  fontVariantNumeric: 'tabular-nums',
  fontSize: 12,
}

/** 连接状态指示灯（颜色 + 文案；断开时页面顶部还会多一条醒目提示） */
function LinkBadge({ link }: { link: LinkState }) {
  const color = link.state === 'open' ? '#22c55e' : link.state === 'connecting' ? '#f59e0b' : '#ef4444'
  const text = link.state === 'open' ? '实时通道已连接' : link.state === 'connecting' ? '实时通道连接中…' : '实时通道已断开'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, boxShadow: `0 0 6px ${color}` }} />
      <span style={{ color }}>{text}</span>
      {link.state === 'closed' && link.willReconnect && <span style={{ color: '#8fb0cc' }}>（自动重连中）</span>}
      {link.reconnects > 0 && <span style={{ color: '#8fb0cc' }}>重连 {link.reconnects} 次</span>}
    </span>
  )
}

const warnStyle: CSSProperties = {
  position: 'absolute', top: 40, left: '50%', transform: 'translateX(-50%)', zIndex: 12,
  padding: '6px 14px', borderRadius: 6,
  background: 'rgba(120, 30, 20, 0.9)', border: '1px solid #ef4444',
  color: '#ffd9d4', fontSize: 12.5, pointerEvents: 'none', whiteSpace: 'nowrap',
}

const noteStyle: CSSProperties = {
  // 同样避开底部 30px 的全局状态条
  position: 'absolute', left: 12, bottom: 44, zIndex: 10, maxWidth: '60vw',
  padding: '6px 10px', borderRadius: 6,
  background: 'rgba(4, 24, 47, 0.82)', border: '1px solid rgba(95, 176, 255, 0.25)',
  pointerEvents: 'none', fontSize: 12, color: '#cfe3f5',
}

/**
 * 图内同步层：只在 `<MapView>` 的 children 里渲染（此时地图已就绪）。
 *
 * 两个 effect 各管一件事：
 *   · 静态态势：区域 + 标注，只在数据变化时重灌一次
 *   · 实时态势：订阅 flux 的节拍回调，按"脏 uavId"增量更新，整表最多 120 ms 重建一次
 */
function SituationLayer({ store, styleCfg }: { store: TelemetryStore; styleCfg: typeof DEFAULT_MAP_STYLE }) {
  const scene = DEFAULT_SCENARIO
  const areas = useMemo(() => toAreaItems(scene), [scene])
  const labels = useMemo(() => toLabelItems(scene), [scene])

  // ---- 静态态势：区域多边形 + 标注 ----
  useEffect(() => {
    MapDraw.set('area', areas)
    MapDraw.set('label', labels)
  }, [areas, labels])

  // ---- 实时态势：按节拍把累积结果上屏 ----
  useEffect(() => {
    const trk = trackStyleOf(styleCfg)
    let stopped = false

    const flush = () => {
      if (stopped) return
      const dirty = store.takeDirty()
      if (dirty.length) {
        // batch：本批内的多次增删改**只渲染一次**（map-2d M2-API-07）
        MapDraw.batch(() => {
          for (const uavId of dirty) {
            const u = store.get(uavId)
            if (!u) continue
            MapDraw.add('drone', {
              id: u.uavId,
              lng: u.lng,
              lat: u.lat,
              type: u.type,
              // 编队配色取自 map-style.json 的 groupColors[groupId]
              color: groupColorOf(styleCfg, u.groupId),
              label: u.uavId,
            })
          }
        })
      }
      // 航迹：map-2d 的 track 是"整类替换"，所以这里整表提交一次；
      // 但**点列本身是增量累积的**（store 里按 uavId 追加尾点），不是每帧重算历史。
      MapDraw.set('track', store.tracks().map((t) => {
        const u = store.get(t.uavId)
        return {
          id: `TRK:${t.uavId}`,
          points: t.points,
          color: groupColorOf(styleCfg, u?.groupId),
          widthPx: trk.widthPx,
          dashed: trk.dashed,
          opacity: trk.opacity,
        }
      }))
    }

    flush()
    const timer = window.setInterval(flush, FLUSH_INTERVAL_MS)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [store, styleCfg])

  return null
}

export function MapStage({ phase, bottomBar, debug = false }: {
  phase?: string
  bottomBar?: React.ReactNode
  /** 是否渲染开发自证信息条（`mission-app | 通道 | /health | engines`）。产品屏一律 false。 */
  debug?: boolean
}) {
  const [cfg, setCfg] = useState<RuntimeConfig | null>(null)
  const [health, setHealth] = useState<string>('(未探测)')
  const [note, setNote] = useState<string>('')
  const [styleCfg, setStyleCfg] = useState(() => DEFAULT_MAP_STYLE)
  const [styleSource, setStyleSource] = useState('内联默认值')
  const [link, setLink] = useState<LinkState>({ state: 'connecting', reconnects: 0 })
  const [uavCount, setUavCount] = useState(0)
  const [lastSeenAgo, setLastSeenAgo] = useState<number | null>(null)

  const wsUrl = param('ws') ?? DEFAULT_WS_URL

  // 累积器与通道：整个页面生命周期一份（用 ref 持有，避免每次渲染新建）
  const storeRef = useRef<TelemetryStore | null>(null)
  if (!storeRef.current) storeRef.current = new TelemetryStore({})
  const store = storeRef.current

  // ---- 样式配置：默认内联，`?style=` 可覆盖 ----
  useEffect(() => {
    let alive = true
    void loadMapStyle().then((r) => {
      if (!alive) return
      setStyleCfg(r.style)
      setStyleSource(r.source)
      if (r.warning) setNote(r.warning)
    })
    return () => { alive = false }
  }, [])

  // ---- 装配信息（瓦片模板 + 各引擎是否就绪）----
  useEffect(() => {
    let alive = true
    fetch('/runtime-config')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: RuntimeConfig) => { if (alive) setCfg(j) })
      .catch((e: unknown) => { if (alive) setNote(`/runtime-config 没读到（${String(e)}）`) })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    let alive = true
    fetch('/health')
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      // ★ 只留一行摘要：`/health` 现在是 selfcheck 的**完整聚合负载**（好几 KB），
      //   原样塞进顶部信息条会把地图挤下去。全文仍可直接打开 http://127.0.0.1:8099/health 看。
      .then((t) => {
        if (!alive) return
        try {
          const j = JSON.parse(t) as { status?: string; checkedAt?: string; wsClients?: number }
          setHealth(`${j.status ?? '?'} · ${j.checkedAt ?? '?'} · ws=${j.wsClients ?? '?'}`)
        } catch {
          setHealth(`${t.slice(0, 40)}…`)
        }
      })
      .catch((e: unknown) => { if (alive) setHealth(`不可达（${String(e)}）`) })
    return () => { alive = false }
  }, [])

  // 瓦片拉不到时给一句提示（地图自己会回落纯色缺口底色）
  useEffect(() => {
    const onError = (ev: Event) => {
      const el = ev.target as HTMLElement | null
      const src = el && 'src' in el ? String((el as HTMLImageElement).src) : ''
      if (!src.includes('/tiles/')) return
      setNote('底图瓦片不可达 → 地图回落纯色兜底（P0 不托管瓦片包，这是预期内的）')
    }
    window.addEventListener('error', onError, true)
    return () => window.removeEventListener('error', onError, true)
  }, [])

  // ---- 实时通道：订阅 telemetry.uav.pos，连上就累积 ----
  useEffect(() => {
    const { dispose } = connectTelemetry(store, {
      url: wsUrl,
      // **不启用节流**（`throttleMs` 不传）。
      //
      // 原因：`ws-client` 的 throttle 语义是「**按事件类型**全局合并，窗口内只保留最新一条」
      // （见其 dispatch.ts 的 ThrottleConfig 注释）。而 `telemetry.uav.pos` 是**10 架无人机
      // 共用**的一个类型、约 100 事件/秒 —— 开 50 ms 窗口会把同一窗口内其它无人机的数据
      // 直接丢掉，表现为"地图上只有一两架无人机"，且丢哪几架是随机的。
      //
      // 渲染侧本来就不需要它：累积器（TelemetryStore）按 uavId 增量记录，上屏由下面的
      // `MapDraw.batch()` + 120 ms 节拍统一合并 —— 合并该发生在**渲染**这一层，不是接收层。
      // 节流仍可用于"每类事件只有一份状态"的场景（如 link.quality 的全局面板）。
      onLinkChange: (s) => {
        setLink(s)
        // 重连成功时如实报告缺口（不补发、不伪造——补发是留存层的事）
        if (s.state === 'open' && s.gapMs && s.gapMs > 1000) {
          setNote(`断线 ${(s.gapMs / 1000).toFixed(1)}s 后已重连；期间的数据不会补发（协议：断了就是丢了）`)
        }
      },
    })
    return dispose
  }, [store, wsUrl])

  // ---- 地图控件：按需开启（M2-CTRL-01：模块默认全部不显示）----
  //
  // 参考图每个地图屏上都有 **指北针 N / 比例尺 / 缩放 ±**（需求专篇 G-06），map-2d 早就实现了
  // 这些控件，但**宿主从来没调用过 `showControls`**，于是界面上一个都看不到 —— 这也是
  // "模块里已经做了的小功能没接进来"的一类。
  //
  // ★ 只开 `scale`（比例尺，右下角）：它与任何面板都不冲突，实测每屏可见可读（"1 km"）。
  //
  // ★ `zoom`（缩放按钮）与 `compass`（指北针）**有意不开**，理由是同一个：
  //   模块把缩放按钮固定在 `top-right`、把指北针固定在它正下方（`right:12, top:78`）
  //   —— 见 `map-2d/src/core/controls.ts` 的 POSITION 表与 `ui/Compass.tsx:41`，**宿主不可配**。
  //   而本应用**每个地图屏的右上角都是右栏面板**（AI任务分析 / 任务信息 / 资源概况 …），
  //   开了只有两种结果：被面板盖住点不到，或者压住面板正文（实测：`layout-check` 在开 zoom 时
  //   报 48/60 屏次"缩放按钮被面板遮挡"）。缩放用滚轮 / 双指 / 键盘 `+` `-` / 方向键平移都可用
  //   （M2-CTRL-14）；指北针在本应用里也不承载信息（`MapView` 建图时 `dragRotate:false`，
  //   它恒指正北）。**不做一个看不见或点不到的控件**，理由写在这里与 README §2.3。
  // ★ 2026-09-18：控件不再写死 —— **显隐与位置都由配置说了算**（用户第 1 条）。
  //   配置来自 `map-style.json` 的 `controls` 段（内联默认值同上；`?style=` 可整份覆盖）。
  //   走的是 map-2d 新加的 `mapCommands.configureControls([{key,on,anchor,offset}])`。
  useEffect(() => {
    let timer = 0
    let alive = true
    const specs = controlSpecsOf(styleCfg)
    const tick = () => {
      if (!alive) return
      if (mapCommands.isReady()) {
        if (specs) mapCommands.configureControls(specs as never)
        else mapCommands.showControls(['scale'])   // 配置里没有 controls 段 → 回落模块缺省行为
      } else timer = window.setTimeout(tick, 120)
    }
    tick()
    return () => { alive = false; window.clearTimeout(timer) }
  }, [styleCfg])

  // ---- 指标：每秒刷新一次（UAV 数 + 数据新鲜度）----
  useEffect(() => {
    const t = window.setInterval(() => {
      setUavCount(store.uavs().length)
      const seen = store.lastSeenAt()
      setLastSeenAgo(seen === undefined ? null : Date.now() - seen)
    }, 500)
    return () => window.clearInterval(t)
  }, [store])

  const tileTemplate = cfg?.tiles?.template || DEFAULT_TILE_TEMPLATE

  // 地图数据：只给"地图自己的配置"与静态台账；实时无人机走 MapDraw（见文件头说明）
  const data = useMemo<MapData>(() => ({
    config: {
      center: DEFAULT_SCENARIO.center,
      zoom: DEFAULT_SCENARIO.zoom,
      minZoom: DEFAULT_SCENARIO.minZoom,
      maxZoom: DEFAULT_SCENARIO.maxZoom,
      basemap: { tileUrlTemplate: tileTemplate, attribution: 'geo-data' },
    },
    scenarioKey: 'scenario-1',
    // 阶段由**流程层**给出（Excel 步 ↔ T0–T7 的对应见 host 的 flow.cc）；
    // 空值回落 T4 = map-2d 阶段规则下无人机/目标/扫描/脉冲可见。
    phase: ((phase && phase.trim()) ? phase : 'T4') as MapData['phase'],
    targets: [],
    groups: [],
    uavs: [],
    edges: [],
    topology: null,
    track: [],
  }), [tileTemplate, phase])

  const engines = cfg?.stats?.engines ?? {}
  const keys = Object.keys(engines)
  const readyCount = keys.filter((k) => engines[k].instantiated).length

  const stale = link.state !== 'open' || (lastSeenAgo !== null && lastSeenAgo > STALE_AFTER_MS)
  const showStaleBanner = stale && (uavCount > 0 || link.state === 'closed')

  const onFlushProbe = useCallback(() => {
    // 自证脚本用：把模块统计挂到 window 上（不改变任何渲染行为）
    const w = window as unknown as {
      __maStats?: () => unknown
      __measureProbe?: () => unknown
    }
    w.__maStats = () => ({
      uavCount: store.uavs().length,
      trackCount: store.tracks().length,
      tracks: store.tracks().map((t) => ({ uavId: t.uavId, points: t.points.length })),
      updates: store.uavs().map((u) => ({ uavId: u.uavId, updates: u.updates, groupId: u.groupId, type: u.type })),
      rejected: store.rejected,
      unknownEventTypes: store.unknownEventTypes(),
      drones: MapDraw.list('drone').length,
      tracksOnMap: MapDraw.list('track').length,
      areas: MapDraw.list('area').length,
      labels: MapDraw.list('label').length,
      areaIds: MapDraw.list('area').map((a) => a.id),
      labelIds: MapDraw.list('label').map((l) => l.id),
      link,
      styleSource,
    })
    /**
     * 量算自证（`scripts/measure-check.mjs` 读它）：把 map-2d **交互层里那一份**测量结果
     * 原样交出来（`mapCommands.getMeasurement()`，M2-CTRL-10）。**只读**，不参与渲染，
     * 也不做任何加工 —— 脚本断言的数值就是 `DrawLayer` 浮层上显示的那个数。
     */
    w.__measureProbe = () => {
      const st = useInteraction.getState()
      const m = mapCommands.getMeasurement()
      const mp = mapInstance.current
      return {
        mode: st.mode,
        livePoints: st.points.length,
        // 交互层是否真的挂上了（DrawLayer 的 setup() 会加这个预览源；没挂上 → 点击不会被接收）
        drawLayerReady: !!(mp && mp.getSource && mp.getSource('src-2d-interaction')),
        mapReady: !!mp,
        styleLoaded: mp && mp.isStyleLoaded ? mp.isStyleLoaded() : null,
        hasAreaSource: !!(mp && mp.getSource && mp.getSource('src-area')),
        mapLoaded: !!(mp && mp.loaded && mp.loaded()),
        // 视角范围（用户第 2 条"为什么缩放不能缩放" —— 让自证脚本能直接读到 min/max）
        zoom: mp && mp.getZoom ? mp.getZoom() : null,
        minZoom: mp && mp.getMinZoom ? mp.getMinZoom() : null,
        maxZoom: mp && mp.getMaxZoom ? mp.getMaxZoom() : null,
        sourceIds: mp && mp.getStyle ? Object.keys(mp.getStyle()?.sources ?? {}) : null,
        measurement: m
          ? {
            mode: m.mode,
            meters: m.meters ?? null,
            areaM2: m.areaM2 ?? null,
            bearing: m.bearing ?? null,
            vertices: Array.isArray(m.points) ? m.points.length : null,
            points: m.points ?? null,
          }
          : null,
      }
    }
  }, [store, link, styleSource])
  useEffect(() => { onFlushProbe() }, [onFlushProbe])

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      {debug && (
        <div style={barStyle}>
          <strong>mission-app</strong>
          <LinkBadge link={link} />
          <span>无人机 {uavCount}</span>
          <span style={{ color: '#8fb0cc' }}>
            {lastSeenAgo === null ? '尚未收到遥测' : `最近数据 ${(lastSeenAgo / 1000).toFixed(1)}s 前`}
          </span>
          <span>engines 就绪 {keys.length ? `${readyCount}/${keys.length}` : '—'}</span>
          <span title={health}>/health {health}</span>
          <span style={{ color: '#8fb0cc' }}>style {styleSource}</span>
          <span style={{ color: '#8fb0cc' }}>通道 {wsUrl}</span>
        </div>
      )}

      {showStaleBanner && (
        <div style={warnStyle}>
          ⚠ 数据可能已过期
          {link.state === 'closed' ? '（实时通道已断开，画面停留在断开前那一帧）' : '（已有一段时间没收到遥测）'}
        </div>
      )}

      <MapView data={data} style={styleCfg}>
        <SituationLayer store={store} styleCfg={styleCfg} />
        {/* 交互层（量算 / 手绘 / 图元编辑）：map-2d 的实现，必须挂进 `<MapView>` 才生效。
            各屏工具栏的"测距 / 测面 / 区域 / 新建 / 标绘"就是把它切到对应绘制模式。 */}
        <DrawLayer />
        {/* 鼠标经纬度读数：显隐与落位由配置决定（`map-style.json` 的 controls.coords）；
            组件在控件关闭时自己返回 null，所以这里常挂即可 */}
        <CoordReadout />
      </MapView>

      {note ? <div style={noteStyle}>{note}</div> : null}

      {bottomBar}
    </div>
  )
}

export default MapStage
