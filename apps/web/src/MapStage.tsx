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
import { CoordReadout, DrawLayer, MapDraw, MapView, draftNow, draw, mapCommands, mapInstance, useInteraction, type MapData } from 'map-2d'
import { DEFAULT_MAP_STYLE, controlSpecsOf, droneColorOf, groupColorOf, loadMapStyle, trackStyleOf } from './map-style'
import { DEFAULT_SCENARIO, drawScenario } from './scenario'
import { DEFAULT_WS_URL, TelemetryStore, connectTelemetry, type LinkState } from './telemetry'
import { uavTypeCN } from './flow/useSituation'
import { pickModeNow } from './pick-mode'

/** 瓦片模板缺省值（与 config.json 的 tiles.template 一致；运行时以宿主 /runtime-config 为准） */
const DEFAULT_TILE_TEMPLATE = '/tiles/{z}/{x}/{y}.jpg'

/** 上屏节拍（ms）：WS 可能 10 Hz 到达，地图不需要跟着 10 Hz 重画 */
const FLUSH_INTERVAL_MS = 120
/** 超过这么久没有新数据就提示"数据可能已过期" */
const STALE_AFTER_MS = 5000

// 2026-09-20：原先这里有个 `MAP_PICK_DELETE` 常量（2026-09-19 用来整条屏蔽"点选 + 删除"）。
// 现在改成**按"选择模式"决定**（浏览 / 编辑，见 `./pick-mode`）常量已移除，行为见下面那个 effect。

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
 * ★ 2026-09-18：**删除确认条**（选中图元后按 Delete 出现）。
 * 放在底部中间偏上，不挡工具栏与右栏；两个按钮都带 `data-testid` 便于自测。
 */
const deleteBarStyle: CSSProperties = {
  position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 56, zIndex: 30,
  display: 'flex', alignItems: 'center', gap: 10,
  padding: '8px 12px', borderRadius: 8, fontSize: 12.5, color: '#eaf6ff',
  background: 'rgba(30,12,8,.94)', border: '1px solid rgba(245,158,11,.65)',
  boxShadow: '0 6px 20px rgba(0,0,0,.5)',
}
const deleteYesStyle: CSSProperties = {
  padding: '4px 10px', borderRadius: 6, cursor: 'pointer', font: 'inherit', fontSize: 12,
  background: 'rgba(220,38,38,.85)', border: '1px solid rgba(248,113,113,.8)', color: '#fff',
}
const deleteNoStyle: CSSProperties = {
  padding: '4px 10px', borderRadius: 6, cursor: 'pointer', font: 'inherit', fontSize: 12,
  background: 'transparent', border: '1px solid rgba(148,163,184,.5)', color: '#cfe3f5',
}

/**
 * 图内同步层：只在 `<MapView>` 的 children 里渲染（此时地图已就绪）。
 *
 * 两个 effect 各管一件事：
 *   · 静态态势：区域 + 标注，只在数据变化时重灌一次
 *   · 实时态势：订阅 flux 的节拍回调，按"脏 uavId"增量更新，整表最多 120 ms 重建一次
 */
function SituationLayer({ store, styleCfg }: { store: TelemetryStore; styleCfg: typeof DEFAULT_MAP_STYLE }) {
  // ★ 2026-09-18：**把样式配置登记给 map-2d**。
  //   以前应用只把 `map-style.json` 用在自己的取色/取线宽上，**从没调用过 `MapDraw.setStyle()`** ——
  //   于是模块的"位图图标"能力一直没被点亮，无人机只能是画点（这就是"没看到无人机图标"的原因）。
  //   登记之后：`drone.useIcon` + `byType[type].icon.url` 生效，模块负责加载位图，
  //   并按"图元字段 > 机型段 > 顶层"解析颜色；加载失败会自动回落画点（不报错）。
  useEffect(() => { MapDraw.setStyle(styleCfg as never) }, [styleCfg])

  // ---- 静态态势：区域 + 出航通道 + 航线，**全部走 map-2d 的几何原语 + 绑定文本框** ----
  //
  // ★ 2026-09-18 业务层改造：以前是把 `toAreaItems/toLabelItems` 的结果塞进
  //   `MapDraw.set('area'|'label')`，标注是**手挂的 label 图元**（和图形是两条互不相干的东西）。
  //   现在：图形用 `draw.polygon / draw.line`（几何原语），文字用几何原语的 `text` 字段。
  // ★ 2026-09-18（需求方："每次启动态势界面后，不是直接读取显示固定文件，而是显示什么都没有画的地图，
  //   我手动选择计划文件，读取我选择的计划文件，来进行绘制"）：
  //   **这里原来会 `drawScenario()` 把内联场景画死** —— 现在不画了，进屏就是空地图；
  //   由用户从工具条的【计划 → 打开计划】挑一份计划文件，再画（见 apps/web/src/plan-file.ts）。
  useEffect(() => { /* 故意留空：等用户打开计划 */ }, [])

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
              // ★ 2026-09-18：颜色改成**按机型取**（`drone.byType[type].point.color`），
              //   与下面航迹用的是**同一个函数** —— 需求方要求"航迹与无人机颜色一样"。
              //   这个色同时也是"图标加载失败时回落画点"的颜色，以及图标本身的同色系。
              color: droneColorOf(styleCfg, u.type),
              // ★ 用户 2026-09-18 第 3 条："画出来的所有东西，都需要有文本文字标签，**包括这一开始加载的**"。
              //   无人机是开机后由遥测增量画上来的（不是用户画的），原来只有点、没有文字。
              //   ★ 文字现在由 map-2d 的**原生 symbol 图层**画（`lyr-text` 读要素的 `label` 字段），
              //     所以这里直接把"机型 + 编号"作为 `label` 一起提交 —— 与点位同一次更新，
              //     不会出现"点到了、字还没到"，也不再需要单独的绑定调用。
              label: `${uavTypeCN(u.type)} ${u.uavId.replace(/^uav-/, '')}`,
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
          // ★ 2026-09-18：航迹颜色与**无人机颜色同源**（同一个 `droneColorOf`），
          //   需求方："需要航迹与无人机颜色一样"。
          color: droneColorOf(styleCfg, u?.type),
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
  /**
   * ★ 2026-09-18：**待确认的删除**。
   *
   * map-2d 已经把"点图元即选中 + 虚线高亮"做在模块里；用户在选中状态下按 `Delete`
   * 时模块只是**把"想删哪个"报出来**（`mapCommands.onDeleteRequest`）——
   * 这里存下来、弹一条确认，确认了才真删（误删不可逆，这一步不能省）。
   */
  const [pendingDelete, setPendingDelete] = useState<{ kind: string; id: string; label: string } | null>(null)
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
  /**
   * **点图元  选中/高亮  编辑**（2026-09-20 需求："选择按钮两个状态：浏览 / 编辑"）。
   *
   *  **浏览**（默认）：模块那边"点图元即选中"照旧发生，但这里**一收到就立刻取消** 
   *   视觉与行为都是"纯看图"（同一条同步链里完成，浏览器不会画出中间那一帧高亮）。
   *  **编辑**：保留选中（虚线高亮），并让模块进入**编辑态**（顶点手柄 / 拖顶点 / 拖整块 / 吸附）；
   *   此时按 Delete 才弹确认条（确认后 `deleteSelection()`）。
   *  点空白处取消选中时：顺手退出编辑态（否则手柄会留在屏幕上）。
   *
   * 历史：2026-09-19 需求方曾要求"点图元完全没反应（纯看图）"，当时用一个常量把整条链屏蔽；
   *      现在改成**按模式**，常量不再需要。
   */
  useEffect(() => {
    mapCommands.onDeleteRequest((sel) => {
      if (pickModeNow() !== 'edit') return          // 浏览模式：Delete 不删任何东西
      // 显示名取图元自己的文本/名字，没有就退回 id（面板里也是这么显示的）
      const items = MapDraw.list(sel.kind as never) as unknown as { id?: string; text?: string; label?: string; name?: string }[]
      const it = items.find((x) => x?.id === sel.id)
      const label = it?.text || it?.label || it?.name || sel.id
      setPendingDelete({ kind: sel.kind, id: sel.id, label })
    })
    const offSel = mapCommands.onSelectionChange((sel) => {
      if (!sel) {
        // 点地图空白处：收确认条 + 退出编辑态
        setPendingDelete(null)
        if (pickModeNow() === 'edit') mapCommands.finishEdit()
        return
      }
      if (pickModeNow() === 'browse') mapCommands.clearSelection()   // 浏览：点图元没有任何反应
      else {
        // 编辑模式：**只有在没画东西的时候**才进编辑态。
        // 为什么：画多点图形（线/面）时，中途点到已有图元会走"选中  进编辑"，
        // 而 `startEdit()` 会把正在画的半成品取消掉（实测：面根本画不出来）。
        // ★ 2026-09-21：**草稿态也算"正在画"** —— 合并框开着的时候（收笔已发生、还没确认），
        //   点图元若进了编辑态，就会把草稿的手柄抢掉（需求要的是"草稿态手柄亮着、框开着"）。
        const st = useInteraction.getState()
        const drawing = !!st.geo || st.mode !== 'none' || !!draftNow()
        if (drawing) mapCommands.clearSelection()
        else mapCommands.editPrimitive(sel.kind, sel.id)             // 可拖顶点 / 拖整块
      }
    })
    return () => { mapCommands.onDeleteRequest(null); offSel() }
  }, [])

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
      // 自证用（2026-09-18 第 2 条要能验）：跟随文本的内容、圆形/扇区的**实际半径**
      labelTexts: (MapDraw.list('label') ?? []).map((i: { id: string; text?: string }) => ({ id: i.id, text: i.text })),
      shapeRadii: (MapDraw.list('shape') ?? []).map((i: { id: string; radiusKm?: number; radiusKmMinor?: number }) => ({ id: i.id, radiusKm: i.radiusKm, minor: i.radiusKmMinor })),
      // 航线顶点（自证"A\* 真的绕开了威胁区"）
      routePoints: (MapDraw.list('route') ?? []).map((i: { id: string; points?: [number, number][] }) => ({ id: i.id, points: i.points })),
      // 区域面的虚线标记（自证"区域能不能画实线"这条链路的**第一段**：图元 → 属性）
      areaDashed: (MapDraw.list('area') ?? []).map((i: { id: string; dashed?: boolean }) => ({ id: i.id, dashed: i.dashed === true })),
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
        // 自证用：把 map 实例挂到 window（只读，方便脚本查图层/要素）
        __mapForProbe: (() => {
          const w = window as unknown as { __maMapRef?: unknown; __maDraw?: unknown }
          w.__maMapRef = mp
          w.__maDraw = MapDraw   // 自证脚本要能直接调新 API（on('change') / add / setVisible …）
          ;(w as unknown as { __maDrawApi?: unknown }).__maDrawApi = draw   // 几何原语 API
          ;(w as unknown as { __maCommands?: unknown }).__maCommands = mapCommands  // 自证：setGeometry 等
          return true
        })(),
        // 自证"区域能不能画实线"链路的**第二段**：两条区域边界图层在不在、各自有没有 dasharray
        areaLayers: mp && mp.getLayer
          ? ['lyr-area-line', 'lyr-area-line-dashed'].map((id) => {
            const l = mp.getLayer(id) as { id: string; paint?: Record<string, unknown> } | undefined
            return l ? { id, dasharray: (l.paint ?? {})['line-dasharray'] ?? null } : { id, missing: true }
          })
          : null,
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

      {/* ★ 2026-09-18（需求方："点击选中状态，按键盘 delete，提示删除，确认删除"）：
          选中与高亮由 map-2d 负责（点图元即选中，虚线高亮）；
          用户按 Delete 时模块**只把"想删"报出来**，确认框在这里 —— 确认了才真删。 */}
      {pendingDelete && (
        <div data-testid="delete-confirm" style={deleteBarStyle}>
          <span>
            删除图元 <b style={{ color: '#ffd400' }}>{pendingDelete.label}</b>？
            <span style={{ color: '#8fb0cc' }}>（{pendingDelete.kind}）</span>
          </span>
          <button
            data-testid="delete-confirm-yes"
            onClick={() => {
              // ★ 2026-09-18（需求方："左下角的已删除提示，删除，不需要"）：
              //   删完**不写任何提示**（原来会往左下角的 note 条写"已删除 xxx"）。
              mapCommands.deleteSelection()
              setPendingDelete(null)
            }}
            style={deleteYesStyle}
          >确认删除</button>
          <button
            data-testid="delete-confirm-no"
            onClick={() => setPendingDelete(null)}
            style={deleteNoStyle}
          >取消</button>
        </div>
      )}

      {note ? <div style={noteStyle}>{note}</div> : null}

      {bottomBar}
    </div>
  )
}

export default MapStage
