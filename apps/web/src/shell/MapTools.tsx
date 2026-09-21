// mission-app · apps/web/src/shell/MapTools.tsx
//
// **地图工具条（真能点的这一版）** + 工具可用性判据。
//
// ★ 为什么要新增这个文件（用户的直接反馈）：
//   之前 20 屏每屏各自写了一份"工具栏"（`SituationScreen` / `SceneConfirmScreen` / `StrikeScreen` /
//   `TargetsScreen` / `StrikeConfirmScreen` / `ReconExpandScreen` / `ReconFusionScreen` 各一份），
//   里面全是 **只读的 `<span>` / `<button>` 摆设**——点了没有任何反应；而 map-2d 模块里
//   **量算（测距/测面/方位角）、手绘（区域/新建/标绘）、图层面板、清屏、全屏** 全都是已实现的
//   （`DrawLayer` / `mapCommands.setDrawMode` / `useInteraction`）。也就是说"模块做了、宿主没接"。
//   本文件就是那个**唯一的接线点**：所有屏共用，按规则包 `view.compose` 的声明决定可用性。
//
// ★ 纪律：
//   · **可用性由宿主/规则包说了算**：`view.compose` 的 `tools[]` 给出 `enabled` 与 `reasons[]`
//     （view-composer 的 VWC-TOOL-01/02）。本文件**不自己判断"这个工具该不该能用"**，
//     只把声明翻译成"能不能点"；声明为不可用 → 灰置并把**原话**放进 `title`。
//   · **不编数据**：工具没有读数，界面不显示任何自造数字。
//   · 工具集的**键位与顺序**属于"图上有什么"（版式），由各屏按参考图给出；
//     "能不能点"属于规则包。两者在这里汇合。
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  mapCommands, useInteraction, useMapUiStore,
  type DrawMode, type MapToolKey,
} from 'map-2d'
import { C } from '../theme'
import { PrimitivePanel } from './PrimitivePanel'
import type { UseFlow } from '../flow/useFlow'
import { readCompose, replyText, useVerbOnce } from '../flow/useSituation'
import { homeView } from '../plan-file'

/** 二级条目：菜单里真正"点一下要画 / 要做的那一条"。 */
export interface SubmenuLeaf {
  key: string
  label: string
  note?: string
  /**
   * 绘制模式（「量算」的测距 / 测面才有）。带它就由**工具条自己**切 `map-2d` 的绘制模式；
   * 不带就交给所在屏的 `onLocal`（业务图元 / 计划）。
   */
  mode?: DrawMode
}

/**
 * 子菜单的一级项。
 *
 * 带 `items` 的：它是**分类**，点一下在右列展开二级（「新建」= 点 / 线 / 面 / 标绘）；
 * 不带 `items` 的：它就是可直接执行的条目（「计划」= 打开 / 保存 / 规划航线，老的一级菜单）。
 */
export interface SubmenuItem extends SubmenuLeaf {
  /** 有它 = 这一项是**分类**（点它展开二级）；没有 = 它自己就是可执行条目（例：量算的测距 / 测面） */
  items?: SubmenuLeaf[]
}

/**
 * 一个工具格里的**可执行条目**（点一下真干事的那些）：
 * 扁平菜单（量算 / 视图 / 计划）= 一级项**自己**；
 * 两级菜单（新建）= 各分类下的**二级项**。
 * 「当前工具」提示、选中态、二级条目高亮都走这一个口径，少一处就会漏（2026-09-19 实测踩到过）。
 */
function leavesOf(t: MapToolSpec): SubmenuLeaf[] {
  return (t.submenu ?? []).flatMap((g) => (g.items?.length ? g.items : [g]))
}

/** 工具条上的一格（**版式**来自参考图：键位与顺序；可用性来自 `view.compose`）。 */
export interface MapToolSpec {
  /**
   * **React key / testid 用的稳定标识**。
   *
   * 为什么要和 `key` 分开：量算在规则包里是**一个** `measure` 工具，但界面上按图/按能力拆成
   * 「测距」与「测面」两格 —— 两格共用同一个 `key`。若直接拿 `key` 当 React key，就会出现
   * 重复 key（React 警告）且两格 testid 撞车。`id` 缺省等于 `key`。
   */
  id?: string
  /** 规则包里的工具 key（select / measure / area / create / draw / layers / clear / fullscreen） */
  key: string
  /** 键面文字（逐字照图） */
  label: string
  /**
   * **图标键**（不给就用 `id` / `key`）。
   * 用途：同一格两种形态时（例：选择 = 浏览的手掌 / 编辑的箭头），testid 要保持稳定，
   * 只换图标  2026-09-20 需求。
   */
  glyph?: string
  /** 右下角小字（图上"3D"下面的"2D/3D"就是它） */
  sub?: string
  /** 该格对应的绘制模式（量算/手绘类才有） */
  mode?: DrawMode
  /** 规则包压根没有这个 key 时，`title` 里如实写明的"为什么没有"（例：3D、复位视角） */
  noteWhenUndeclared?: string
  /**
   * **宿主自带**的控件（不经过规则包）：恒定可点。
   *
   * 为什么需要它：`复位视角` 是宿主为了演示加的便利控件（需求专篇 §12.2 有意保留），
   * 规则包里没有对应的工具 key。它原先是一个浮在地图右下角的独立按钮，**每一屏都被
   * 该屏自己的面板压住**（实测 layout-check：42/60 屏次点不到 —— 右下角要么是"请选择任务场景"
   * 卡区，要么是右栏/底部浮层）。地图四个角在本应用里都被面板占了，唯一恒定空着的位置就是
   * 左上那条**工具条**，所以把它变成工具条上的一格。
   */
  always?: boolean
  /**
   * **本屏自己处理这一格**（2026-09-18 新增）：点了不走地图模块的行为，而是交给所在屏的
   * `MapToolbar.onLocal` 回调（`scene` 就是这种 —— 它开的是应用级面板，不是地图能力）。
   *
   * ★ 只有带这个标记的格子才会被路由过去。早期写成"传了 onLocal 就一律 return"，
   *   结果 SH-03 上**测距/测面/图层/清屏全被吞掉**（量算自证 7/7 → 4/6，实测踩过）。
   */
  local?: boolean
  /**
   * **子菜单**（2026-09-18 用户第 1 条）。
   *
   * 用户原话："map2d 能画出来的所有模型，分布到当前【新建、区域、标绘】三个功能中，
   * 用**子菜单**的方式来确认我到底想画什么"。
   * 带子菜单的格子点一下**先弹菜单**（不直接执行），选中某一项再走 `onLocal(子项key)`。
   */
  submenu?: SubmenuItem[]
}

/** 规则包 key → map-2d 的 `MapToolKey`（两套命名不同，这里是唯一的翻译表）。 */
const MAP2D_KEY: Record<string, MapToolKey> = {
  select: 'select',
  layers: 'layer',
  clear: 'clear',
  fullscreen: 'full',
  measure: 'measure',
  area: 'area',
  create: 'new',
  draw: 'draw',
}

/** 极简线性图标（与参考图上那一排同形；不引第三方图标库）。 */
export function ToolGlyph({ k, size = 16 }: { k: string; size?: number }) {
  const common = {
    width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  }
  switch (k) {
    case 'select': return <svg {...common}><path d="M3 2l10 5-4 1.4L7.6 13z" /></svg>
    // 浏览模式（拖地图）用手掌图标：2026-09-20 新增
    case 'pan': return <svg {...common}><path d="M5 8V5.2a1.2 1.2 0 0 1 2.4 0V7m0-.6V4.4a1.2 1.2 0 0 1 2.4 0V7m0-.4V5.2a1.2 1.2 0 0 1 2.4 0V9.6c0 2.6-1.6 4.4-4.2 4.4-2.2 0-3.4-1-4.2-2.6L3.4 9.4a1.1 1.1 0 0 1 1.9-1.1L6 9.4" /></svg>
    case 'measure': return <svg {...common}><path d="M2 11l9-9 3 3-9 9z" /><path d="M5 8l1.6 1.6M7.5 5.5L9 7" /></svg>
    case 'measure-area': return <svg {...common}><path d="M2.5 4.5l5-2 6 3-1 6-6 2-4-3z" /><path d="M5 9.5l2-2 2 1.5" /></svg>
    case 'scene': return <svg {...common}><rect x='2.2' y='3.4' width='11.6' height='9.2' rx='1.2' /><path d='M2.2 6.6h11.6M5.6 3.4v3.2M10.4 3.4v3.2' /></svg>
  case 'layers': return <svg {...common}><path d="M8 2l6 3.5L8 9 2 5.5z" /><path d="M2 9.5L8 13l6-3.5" /></svg>
    case 'clear': return <svg {...common}><path d="M2 3h12v10H2z" opacity=".45" /><path d="M6 6l4 4M10 6l-4 4" /></svg>
    case 'fullscreen': return <svg {...common}><path d="M2 6V2h4M14 10v4h-4M14 6V2h-4M2 10v4h4" /></svg>
    case 'area': return <svg {...common}><path d="M2.5 4.5l5-2 6 3-1 6-6 2-4-3z" /></svg>
    case 'create': return <svg {...common}><path d="M8 2v12M2 8h12" /></svg>
    case 'draw': return <svg {...common}><path d="M2 13c3-6 6-9 12-11" /><circle cx="13.5" cy="2.5" r="1.3" /></svg>
    // 复位视角：靶心 + 回环箭头（"回到初始视角"）
    case 'reset': return (
      <svg {...common}>
        <circle cx="8" cy="8" r="3.2" />
        <path d="M8 1.4v2.6M8 12v2.6M1.4 8h2.6M12 8h2.6" />
        <path d="M13.6 4.4A6.6 6.6 0 0 0 2.6 6.2" strokeDasharray="2 1.6" />
      </svg>
    )
    default: return <svg {...common}><circle cx="8" cy="8" r="5" /></svg>
  }
}

/** 规则包声明的工具可用性（每个屏一次 `view.compose`，幂等只读）。 */
export function useMapToolState(flow: UseFlow) {
  // ★ 不传 phase 参数：宿主的 `view.compose` 用的是**它自己的当前阶段**（flow.cc:6181
  //   `phaseViewLocked()`），入参里的 phase 根本不参与解算。以前各屏写 `{ phase: state.phase || 'T0' }`
  //   会让人误以为"传错阶段会把工具算灰"，其实是空转；这里统一不传，只有一处口径。
  const compose = useVerbOnce(flow, 'view.compose', {}, true)
  const cmp = readCompose(compose.data)
  const byKey = new Map(cmp.tools.map((t) => [t.key, t]))
  return {
    /** 该工具此刻能不能点（规则包说 available 才算） */
    on: (key: string): boolean => byKey.get(key)?.on ?? false,
    /** 不能点的**原话原因**（规则包给的），拿不到就给 undefined（界面照样灰置） */
    reason: (key: string): string | undefined => byKey.get(key)?.reason,
    /** 规则包里有没有声明这个工具（没声明 = 宿主没这套工具，界面按图保留但如实标注） */
    declared: (key: string): boolean => byKey.has(key),
    views: cmp,
    reply: compose.reply,
    replyText: compose.reply ? replyText(compose.reply) : null,
  }
}

/**
 * 地图工具条。
 *
 * `items` 是**版式**（图上那一排有哪些格、什么字、什么顺序），`state` 是**可用性**（规则包）。
 * 点击行为全部落到 map-2d 的公共命令上，宿主不自己实现任何地图交互：
 *   · 量算/手绘 → `useInteraction.setMode`（`DrawLayer` 消费）
 *   · 图层     → `useMapUiStore.toggleLayersPanel()`（面板是本应用的 `PrimitivePanel`：逐图元显隐）
 *   · 清屏/全屏 → map-2d 的 `clearMode` / 浏览器全屏 API（与模块工具条同一套语义）
 */
export function MapToolbar({ items, state, testid, style, onLocal, activeKeys, onMenuOpened, closeSignal }: {
  items: MapToolSpec[]
  state: ReturnType<typeof useMapToolState>
  testid: string
  style?: CSSProperties
  onLocal?: (key: string, active: boolean) => void
  activeKeys?: Record<string, boolean>
  /**
   * **工具条这边"打开了一个窗口"**（子菜单 / 图层面板）时通知所在屏。
   * 2026-09-20 需求："点击一个菜单，弹出该菜单的窗口，其他菜单的窗口都 hide" 
   * 屏自己的面板（例：态势屏的【场景】）收到这个通知就把自己收起来。
   */
  onMenuOpened?: (key: string) => void
  /**
   * **所在屏打开了它自己的面板**时，把计数 +1  工具条据此关掉自己的子菜单与图层面板。
   * 与 `onMenuOpened` 一起构成双向联动（菜单窗口互斥）。
   */
  closeSignal?: number
}) {
  const drawMode = useInteraction((s) => s.mode)
  const setDrawMode = useInteraction((s) => s.setMode)
  const clearMode = useMapUiStore((s) => s.clearMode)
  const setClearMode = useMapUiStore((s) => s.setClearMode)
  const layersOpen = useMapUiStore((s) => s.layersOpen)
  const toggleLayersPanel = useMapUiStore((s) => s.toggleLayersPanel)
  // 选中的工具（map-2d 的 activeTool 只记"最后点过哪个"；绘制类以 drawMode 为准）
  const activeTool = useMapUiStore((s) => s.activeTool)
  const setLayersPanel = useMapUiStore((s) => s.setLayersPanel)
  const setActiveTool = useMapUiStore((s) => s.setActiveTool)
  /** 当前展开的子菜单（工具格的 key + 该格在工具条内的左偏移；null = 都没展开） */
  const [openMenu, setOpenMenu] = useState<{ key: string; left: number; group?: string } | null>(null)
  /**
   * ★ 2026-09-18（需求方："在功能选择左侧，添加个可以收拢和展开的功能，功能菜单已经很长了"）：
   * **工具条收拢开关**，放在工具条**最左侧**。
   *
   * 状态存在 `localStorage`：切屏时工具条会重建，存本屏 state 会导致每屏都要重新收一次。
   * 收拢时只留这一个按钮（并顺手把展开着的子菜单关掉，免得子菜单孤零零浮在那儿）。
   */
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(TOOLBAR_COLLAPSED_KEY) === '1' } catch { return false }
  })
  const toggleCollapsed = useCallback(() => {
    setCollapsed((v) => {
      const next = !v
      try { localStorage.setItem(TOOLBAR_COLLAPSED_KEY, next ? '1' : '0') } catch { /* 隐私模式：忽略 */ }
      if (next) setOpenMenu(null)
      return next
    })
  }, [])
  /** 2026-09-20 菜单窗口互斥的另一半：所在屏开了它自己的面板  把工具条这边的子菜单/图层面板收掉 */
  useEffect(() => {
    if (closeSignal === undefined) return
    setOpenMenu(null)
    setLayersPanel(false)
  }, [closeSignal, setLayersPanel])

  /** 【图层】那一格在工具条内的左偏移（图元面板要挂到它正下方，与子菜单同一算法） */
  const [layersLeft, setLayersLeft] = useState(0)
  /** 工具条自身的 ref：用来把按钮的位置换算成"工具条内的左偏移" */
  const barRef = useRef<HTMLDivElement | null>(null)

  const act = useCallback((t: MapToolSpec, btn?: HTMLElement | null) => {
    // ★ 2026-09-18 用户第 4 条："子菜单位置为什么默认在最左侧，应该在点击的工具项下方"。
    //   把被点按钮相对工具条左边缘的偏移记下来，子菜单就挂到那一格正下方（右侧越界时再往回收）。
    if (t.submenu?.length) {
      const bar = barRef.current?.getBoundingClientRect()
      const b = btn?.getBoundingClientRect()
      const left = bar && b ? Math.max(0, Math.round(b.left - bar.left)) : 0
      // 2026-09-19：两级菜单（新建 / 点 / 线 / 面 / 标绘）默认展开**第一个分类**，
      //   免得刚点开「新建」时右列是空的；扁平菜单（计划）没有分类，group 为 undefined。
      const firstGroup = t.submenu.find((g) => g.items?.length)?.key
      setOpenMenu((v) => (v?.key === t.key ? null : { key: t.key, left, group: firstGroup }))
      // 2026-09-20 菜单窗口互斥：这次是"打开"（不是再点一下关掉）时，把别的窗口都收掉 
      //   工具栏这边能直接管的：图层面板；屏自己的面板（例【场景】）走 onMenuOpened 通知。
      if (openMenu?.key !== t.key) { setLayersPanel(false); onMenuOpened?.(t.key) }
      return
    }
    setOpenMenu(null)
    if (t.key === 'reset') {
      // 复位视角（2026-09-20 新口径）：图上有可定位图元，就去"第一个元素 + 比例尺 5 km"；
      //   图上一个都没有（空白地图），就去配置里的默认位置（scenario.ts 的 DEFAULT_SCENARIO）。
      //   细节与三条口径见 plan-file.ts 的「家视角」段。
      const h = homeView()
      mapCommands.setView(h.lng, h.lat, h.zoom, 500)
      return
    }
    if (t.key === 'layers') {
      // ★ 2026-09-18 用户："图层，图元显影，为什么没有对齐到功能按钮下面？需要对齐到功能按钮下面"
      //   —— 与子菜单同一套算法：记下【图层】那一格相对工具条左边缘的偏移，面板挂到它正下方。
      const bar = barRef.current?.getBoundingClientRect()
      const b = btn?.getBoundingClientRect()
      setLayersLeft(bar && b ? Math.max(0, Math.round(b.left - bar.left)) : 0)
      toggleLayersPanel()
      // 同上：这次是"打开图层面板"时通知所在屏把它的面板收起来（子菜单已在上面 setOpenMenu(null) 关掉）
      if (!layersOpen) onMenuOpened?.('layers')
      return
    }
    if (t.key === 'clear') { setClearMode(!clearMode); return }
    if (t.key === 'fullscreen') {
      if (document.fullscreenElement) void document.exitFullscreen()
      else void document.documentElement.requestFullscreen().catch(() => undefined)
      return
    }
    // 带子菜单的格子已在最前面处理过（开合自己）；走到这里说明点的是别的格子
    // 本屏自己处理的工具（如「场景」）：**只有带 local 标记的**才交给回调。
    // ★ 别写成 if (onLocal) 就 return —— 那会把测距/测面/图层/清屏全都吞掉（实测踩过：
    //   量算自证从 7/7 掉到 4/6，点测距不再进入测距模式）。
    if (t.local && onLocal) { onLocal(t.key, !!(activeKeys ?? {})[t.key]); return }
    const m2 = MAP2D_KEY[t.key]
    if (m2) setActiveTool(m2)
    if (t.key === 'select') { setDrawMode('none'); setLayersPanel(false); return }
    if (t.mode) setDrawMode(drawMode === t.mode ? 'none' : t.mode)
  }, [clearMode, drawMode, setActiveTool, setClearMode, setDrawMode, setLayersPanel, toggleLayersPanel, onLocal, activeKeys, openMenu, layersOpen, onMenuOpened])

  /**
   * 二级条目此刻是不是"正在用"（判据与一级工具格**完全一致**：绘制模式 / 清屏模式 / 图层开合 / 模块 activeTool）。
   *
   * 为什么要有它：合并后「量算」「视图」自己不带 `mode`，选中态只能看二级条目，
   * 否则原来"点测距后那一格高亮"的提示就丢了。
   * 「新建」的业务条目不带 `mode`（走 `mapCommands.setGeometry`），本来就不参与高亮，与合并前一致。
   */
  const leafActive = useCallback((it: SubmenuLeaf): boolean => {
    if (it.mode) return drawMode === it.mode
    if (it.key === 'clear') return clearMode
    if (it.key === 'layers') return layersOpen
    const m2 = MAP2D_KEY[it.key]
    return m2 ? activeTool === m2 : false
  }, [drawMode, clearMode, layersOpen, activeTool])

  /**
   * **点二级条目**：先关菜单，再按条目类型执行。
   *
   * 为什么在这里分流（而不是一律丢给 `onLocal`）：「量算」的测距 / 测面就是 map-2d 的绘制模式，
   * 「视图」的全屏 / 清屏 / 复位就是工具条自己的三个老行为，它们合并前各占一格、走的是上面的 `act()`；
   * 合并后必须落回**同一套行为**，否则就成了"菜单点了没反应"。
   * 其余条目（业务图元 / 计划）仍交给所在屏的 `onLocal`，与合并前一致。
   */
  const actLeaf = useCallback((it: SubmenuLeaf) => {
    setOpenMenu(null)
    if (it.mode) { setDrawMode(drawMode === it.mode ? 'none' : it.mode); return }
    if (it.key === 'reset') { const h = homeView(); mapCommands.setView(h.lng, h.lat, h.zoom, 500); return }
    if (it.key === 'clear') { setClearMode(!clearMode); return }
    if (it.key === 'fullscreen') {
      if (document.fullscreenElement) void document.exitFullscreen()
      else void document.documentElement.requestFullscreen().catch(() => undefined)
      return
    }
    onLocal?.(it.key, false)
  }, [drawMode, clearMode, setClearMode, setDrawMode, onLocal])

  return (
    <>
      <div ref={barRef} data-testid={testid} style={{ ...toolbarStyle, ...style }}>
        {/* ★ 工具条最左侧的「收拢 / 展开」按钮（需求方 2026-09-18） */}
        <button
          data-testid={`${testid}-collapse`}
          data-collapsed={collapsed ? '1' : '0'}
          onClick={toggleCollapsed}
          title={collapsed ? '展开功能菜单' : '收拢功能菜单'}
          style={collapseBtn}
        >
          <span style={{ fontSize: 13, lineHeight: 1 }}>{collapsed ? '»' : '«'}</span>
        </button>
        {!collapsed && items.map((t) => {
          const on = t.always ? true : state.on(t.key)
          const reason = state.reason(t.key)
          const undeclared = !state.declared(t.key)
          // ★「点击选中状态」：用户 2026-09-18 反馈"点击选中状态，无选中状态"。
          //   原来的高亮太轻（半透明蓝 + 淡边），看起来跟没选一样。现在：
          //   选中 = 实心蓝底 + 亮蓝描边 + 文字转亮 + 底部一条高亮短线，一眼能分辨。
          const m2 = MAP2D_KEY[t.key]
          // 2026-09-19：合并成菜单的格子（新建 / 量算 / 视图）自己不带 `mode`，
          //   选中态改看**它的二级条目**里有没有正在用的（例：正在测距时，「量算」高亮）。
          // 2026-09-20（需求方："点击菜单没有出现选中态变蓝色"）：**菜单正开着**也算选中态；
          //   同时保留原来的"里面某项正在用"（例：正在测距  量算蓝）。
          const menuOpen = openMenu?.key === t.key
          const active = t.submenu?.length
            ? (menuOpen || ((activeKeys ?? {})[t.key] ?? leavesOf(t).some((it) => leafActive(it))))
            : (t.key === 'clear'
              ? clearMode
              : ((activeKeys ?? {})[t.key] ?? (t.mode ? drawMode === t.mode
                : (t.key === 'layers' ? layersOpen : (m2 ? activeTool === m2 : false)))))
          const title = on
            ? (t.mode ? `${t.label}：单击落点，双击 / Enter 结束，Esc 取消` : t.label)
            : `${t.label}（不可用）：${reason
              ?? (undeclared && t.noteWhenUndeclared ? t.noteWhenUndeclared : '规则包 view.compose 未声明该工具可用')}`
          return (
            <button
              key={t.id ?? t.key}
              data-testid={`${testid}-${t.id ?? t.key}`}
              data-tool-key={t.key}
              data-tool-enabled={on ? '1' : '0'}
              data-tool-active={active ? '1' : '0'}
              title={title}
              disabled={!on}
              onClick={(e) => on && act(t, e.currentTarget)}
              style={{
                ...toolBtn,
                opacity: on ? 1 : 0.42,
                cursor: on ? 'pointer' : 'not-allowed',
                color: active ? '#eaf6ff' : (on ? C.text : C.unknown),
                border: `1px solid ${active ? '#5fb0ff' : 'transparent'}`,
                background: active ? 'linear-gradient(180deg,#2563eb,#1d4ed8)' : 'transparent',
                boxShadow: active ? '0 0 10px rgba(56,189,248,.45)' : undefined,
                fontWeight: active ? 600 : 400,
              }}
            >
              <ToolGlyph k={t.glyph ?? t.id ?? t.key} size={15} />
              <span style={{ fontSize: 11.5 }}>{t.label}</span>
              {t.sub && <span style={{ fontSize: 9.5, color: on ? C.accentDim : C.unknown }}>{t.sub}</span>}
            </button>
          )
        })}
      </div>
      {/* ---------------- 子菜单：点了【新建/量算/视图/计划】才弹，浮在工具条正下方 ----------------
           - 两级（新建）：一级 = 分类（点 / 线 / 面 / 标绘），二级 = 这一类的条目；点二级条目才执行。
           - 一级（量算 = 测距 / 测面，视图 = 全屏 / 清屏 / 复位，计划 = 打开 / 保存 / 规划航线）：点条目即执行。
          条目点中后去哪：带 `mode` 的自己切绘制模式；全屏 / 清屏 / 复位的走工具条自己的老行为；
          其余  回调 `onLocal(子项key)`，由所在屏决定是"进入拖画"还是"落点即创建"。 */}
      {openMenu && (() => {
        const t = items.find((x) => x.key === openMenu.key)
        if (!t?.submenu?.length) return null
        // 2026-09-19：一级项里只要有带 `items` 的，就按**两列**渲染（分类 | 该类条目）；
        //   否则还是老的一列（「计划」那种扁平菜单）。
        const nested = t.submenu.some((g) => g.items?.length)
        const groupKey = openMenu.group ?? t.submenu[0]?.key
        const group = nested ? t.submenu.find((g) => g.key === groupKey) : null
        // 挂在**被点那一格的正下方**；贴近右边缘时往回收，别跑出工具条外面（两级菜单更宽）
        const barW = barRef.current?.getBoundingClientRect().width ?? 0
        const menuW = nested ? 300 : 186
        const left = barW > 0 ? Math.min(openMenu.left, Math.max(0, barW - menuW)) : openMenu.left
        return (
          <div
            data-testid={`${testid}-submenu`}
            data-submenu-levels={nested ? '2' : '1'}
            style={{ ...submenuStyle, minWidth: nested ? 292 : 168, left: 12 + left }}
          >
            {nested ? (
              <div style={{ display: 'flex', flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
                {/* 一级：分类。点一下  右列换成这一类的条目 */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 88 }}>
                  {t.submenu.map((g) => (
                    <button
                      key={g.key}
                      data-testid={`${testid}-cat-${g.key}`}
                      data-cat={g.key}
                      data-cat-open={g.key === groupKey ? '1' : '0'}
                      onClick={() => setOpenMenu((v) => (v ? { ...v, group: g.key } : v))}
                      style={g.key === groupKey ? { ...submenuItem, ...submenuCatOn } : submenuItem}
                    >{g.label}</button>
                  ))}
                </div>
                {/* 二级：这一类的条目。点中  关菜单 + 执行（绘制模式 / 全屏 / 交给本屏） */}
                <div style={{
                  display: 'flex', flexDirection: 'column', gap: 1, minWidth: 176,
                  maxHeight: 380, overflowY: 'auto',
                }}>
                  {(group?.items ?? []).map((it) => (
                    <button
                      key={it.key}
                      data-testid={`${testid}-sub-${it.key}`}
                      data-sub-active={leafActive(it) ? '1' : '0'}
                      title={it.note}
                      onClick={() => actLeaf(it)}
                      style={leafActive(it) ? { ...submenuItem, ...submenuItemOn } : submenuItem}
                    >{it.label}</button>
                  ))}
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {t.submenu.map((it) => (
                  <button
                    key={it.key}
                    data-testid={`${testid}-sub-${it.key}`}
                    data-sub-active={leafActive(it) ? '1' : '0'}
                    title={it.note}
                    onClick={() => actLeaf(it)}
                    style={leafActive(it) ? { ...submenuItem, ...submenuItemOn } : submenuItem}
                  >
                    {it.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })()}
      {/* 图层面板：**换成"图元显隐"面板**（用户 2026-09-18 第 7 条："图册开关过于简略，
          需要详细控制每个当前绘制到地图上的显影，并且可以有某类型一下全体显影全部、文本这种"）。
          map-2d 自带的 `LayerPanel` 只到"图层分组"这一层，管不了"逐个图元"，
          所以【图层】这一格现在开的是 `PrimitivePanel`（逐条勾选 + 按类型全显/全隐 + 文本单独一类）。 */}
      {layersOpen && <PrimitivePanel onClose={() => setLayersPanel(false)} left={12 + layersLeft} />}
    </>
  )
}

/**
 * 「点击后的提示」—— 一条**独立的悬浮提示**，浮在工具条正下方。
 *
 * 用户 2026-09-18："点击后的提示，重新 new 一个悬浮的提示在工具栏下方就行，不是现在这样，很丑"。
 * 所以它不看 `props.state`（工具可用性），只看"当前选中的是哪一格"，浮在工具条下方
 * （工具条 top=5、高约 30px → 提示 top=41），不再把工具条撑高。
 *
 * `select`（选择）是"没有工具"的中性态，不弹提示；其余被选中的格子都会如实报出当前工具。
 */
export function ToolModeNote({ items, note, style }: {
  state?: ReturnType<typeof useMapToolState>
  items: MapToolSpec[]
  note?: string
  style?: CSSProperties
}) {
  const drawMode = useInteraction((s) => s.mode)
  const layersOpen = useMapUiStore((s) => s.layersOpen)
  const clearMode = useMapUiStore((s) => s.clearMode)
  const activeTool = useMapUiStore((s) => s.activeTool)
  const cur = items.find((t) => {
    if (t.mode) return t.mode === drawMode
    if (t.key === 'layers') return layersOpen
    if (t.key === 'clear') return clearMode
    if (t.key === 'select') return false          // 中性态，不弹
    if (t.key === 'scene') return false           // 「场景」的选中由它自己的面板开合表达，不再弹一行字
    return MAP2D_KEY[t.key] === activeTool
  })
  // 2026-09-19：合并成菜单后，"当前工具"常常落在**二级条目**上（正在测距 / 正在清屏），
  //   所以一级格找不到时，再翻一遍各菜单的二级条目：判据与一级格一致，只是一并看进去。
  //   注意 `!!MAP2D_KEY[it.key]`：叶子键（plan-open / biz:xxx）不在翻译表里，不能拿 undefined 去比，
  //   否则会和"还没点过任何工具"的 activeTool 撞上、误报一行提示。
  const leaf = items
    .flatMap((t) => leavesOf(t))
    .find((it) => (it.mode ? it.mode === drawMode
      : (it.key === 'clear' ? clearMode : (!!MAP2D_KEY[it.key] && MAP2D_KEY[it.key] === activeTool))))
  const one = cur ?? leaf
  if (!one && !note) return null
  return (
    <div data-testid="map-tool-note" style={{ ...noteStyle, ...style }}>
      {one && <>当前工具：<b style={{ color: C.accent }}>{one.label}</b>
        {one.mode ? '（单击落点，双击 / Enter 结束，Esc 退出）' : ''}</>}
      {one && note ? '　' : ''}
      {note}
    </div>
  )
}

/** 全屏时给 body 一个类名，方便各屏隐藏浮层（目前只用于文档说明，不做行为）。 */
export function useFullscreenFlag(): boolean {
  const setClearMode = useMapUiStore((s) => s.setClearMode)
  useEffect(() => {
    const onFs = () => { if (!document.fullscreenElement) setClearMode(false) }
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [setClearMode])
  return false
}

/** Esc 退出量算/手绘（map-2d 的 DrawLayer 也认 Esc；这里只兜底"清屏模式"的退出）。 */
export function useEscExitDraw() {
  const setDrawMode = useInteraction((s) => s.setMode)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawMode('none') }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setDrawMode])
}

/** 工具条容器：左上浮动，**距顶 5px**（用户 2026-09-18："再靠近上方一些，留大概 5 像素即可"） */
const toolbarStyle: CSSProperties = {
  position: 'absolute', left: 12, top: 5, zIndex: 21,
  display: 'flex', gap: 2, padding: '3px 5px', borderRadius: 8,
  background: 'rgba(6,26,47,.82)', border: `1px solid ${C.border}`,
}
/**
 * 「收拢 / 展开」按钮（工具条最左侧，需求方 2026-09-18）。
 * 比工具格窄（只有一个「« / »」字符）、高度与工具格一致，收拢后整条只剩它 + 提示。
 */
const collapseBtn: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  width: 22, padding: '5px 0', borderRadius: 6, cursor: 'pointer', font: 'inherit',
  background: 'rgba(34,211,238,.14)', border: `1px solid ${C.border}`, color: C.accent,
}
/** 收拢状态存在这里：切屏时工具条重建，也能记住用户的选择 */
const TOOLBAR_COLLAPSED_KEY = 'ma.toolbar.collapsed'
/**
 * 工具格：**单行**（图标 + 文字并排），高度就一个按钮那么高。
 *
 * 用户 2026-09-18："上方工具栏，点击太高了，**只要工具按钮那么高就行**"。
 * 原来是三行竖排（图标 / 文字 / 小字），整个条高约 52px；改成单行后约 30px。
 */
const toolBtn: CSSProperties = {
  display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5,
  padding: '5px 9px', borderRadius: 6, cursor: 'pointer',
  background: 'transparent', border: '1px solid transparent', color: C.text,
  font: 'inherit', lineHeight: 1, whiteSpace: 'nowrap',
}
/**
 * 「点击后的提示」：**独立的一条悬浮提示，浮在工具条正下方**。
 *
 * 用户 2026-09-18："点击后的提示，**重新 new 一个悬浮的提示在工具栏下方就行**，不是现在这样，很丑"。
 * 以前它跟工具条挤在同一块面板里（把工具条撑高）；现在脱离工具条单独浮在下面：
 * 工具条 top=5、高约 30px，所以这里 top≈41。
 */
const noteStyle: CSSProperties = {
  position: 'absolute', left: 12, top: 41, zIndex: 21, maxWidth: 460,
  padding: '5px 10px', borderRadius: 6, fontSize: 11.5, lineHeight: 1.5,
  background: 'rgba(6,26,47,.92)', border: `1px solid ${C.border}`, color: C.text,
  pointerEvents: 'none', boxShadow: '0 2px 10px rgba(0,0,0,.35)',
}
/** 子菜单：浮在工具条正下方，左对齐工具条 */
const submenuStyle: CSSProperties = {
  position: 'absolute', left: 12, top: 41, zIndex: 23,
  display: 'flex', flexDirection: 'column', gap: 4,
  padding: '6px 8px', borderRadius: 8, minWidth: 168,
  background: 'rgba(6,26,47,.96)', border: `1px solid ${C.borderStrong}`,
  boxShadow: '0 6px 20px rgba(0,0,0,.45)',
}
const submenuHead: CSSProperties = { fontSize: 11, color: C.textDim, padding: '2px 4px 4px' }
const submenuItem: CSSProperties = {
  textAlign: 'left', fontSize: 12, padding: '5px 8px', borderRadius: 5, cursor: 'pointer',
  background: 'transparent', border: '1px solid transparent', color: C.text,
  font: 'inherit', lineHeight: 1.3, whiteSpace: 'nowrap',
}

/** 一级分类：**当前展开的那一类**（配色与工具格的选中态同一套，一眼能对上） */
const submenuCatOn: CSSProperties = {
  background: 'rgba(37,99,235,.38)', border: '1px solid #5fb0ff', color: '#eaf6ff', fontWeight: 600,
}
/** 二级条目：**当前正在用的那一条**（例：正在测距） */
const submenuItemOn: CSSProperties = {
  background: 'linear-gradient(180deg,#2563eb,#1d4ed8)', border: '1px solid #5fb0ff', color: '#eaf6ff',
}

/** 供各屏按图声明工具条（键位/顺序/文字逐字照图；可用性一律由规则包给）。 */
export const TOOL_SPECS: Record<string, MapToolSpec> = {
  select: { key: 'select', label: '选择' },
  // 图上写的是"测距"；量算在 map-2d 里是"测距 + 测面"两档，这里按同一格拆成两格
  //（有意偏差，见 README「本轮的已知偏差」：量算是用户明确点名要接的能力）。
  // 两格共用规则包 key `measure`，所以 `id` 必须分开 —— 否则 React key 与 testid 都会撞车。
  measure: { id: 'measure', key: 'measure', label: '测距', mode: 'measure-line' },
  measureArea: { id: 'measure-area', key: 'measure', label: '测面', mode: 'measure-area' },
  draw: { key: 'draw', label: '标绘', mode: 'line' },
  area: { key: 'area', label: '区域', mode: 'area' },
  create: { key: 'create', label: '新建', mode: 'point' },
  layers: { key: 'layers', label: '图层' },
  clear: { key: 'clear', label: '清屏' },
  fullscreen: { key: 'fullscreen', label: '全屏' },
  // ★ 2026-09-18 用户："3d/2d/3d 功能直接删除，目前不需要" —— 这一格已删除（原 `mode3d`）。
  /**
   * **选择场景**（用户 2026-09-18 第 3 条："选择场景功能，添加到上方工具栏中，点击后才显示"）。
   *
   * 它原先常驻在态势屏**底部**（占 152px 高，一直显示），现在收进工具条，**点了才弹**。
   * 与 `reset` 同类：这是**宿主自带能力**（规则包 `view.compose` 里没有这个 key），
   * 所以 `always: true` 恒定可点；点了由所在屏用 `onLocal` 回调自己开面板。
   */
  scene: { key: 'scene', label: '场景', always: true, local: true },
  /**
   * **计划**（★ 2026-09-18，需求方："功能界面添加，计划，子菜单为，打开计划，保存计划，先做打开计划"）。
   *
   * 为什么要有它：态势屏以前一进来就把内联场景画死；现在**进来是空地图**，
   * 由用户自己挑一份计划文件画上去（见 `apps/web/src/plan-file.ts`）。
   * 与「场景」同类：**宿主自带能力**（规则包 `view.compose` 里没有这个 key）→ `always: true`，
   * 点开子菜单后由所在屏用 `onLocal` 处理（`plan-open` / `plan-save`）。
   */
  plan: {
    key: 'plan', label: '计划', always: true, local: true,
    submenu: [
      { key: 'plan-open', label: '打开计划', note: '选一个计划 JSON，画到图上（替换上一个计划）' },
      { key: 'plan-save', label: '保存计划', note: '把当前画出来的计划导出成 JSON 文件' },
      { key: 'plan-route', label: '规划航线', note: '按你画的集结区/任务区用 A* 算航线与航道，自动绕开「威胁」区域' },
    ],
  },
  /** 复位视角 —— **宿主自带**（规则包没有这个 key），恒定可点；理由见 `MapToolSpec.always` */
  reset: { key: 'reset', label: '复位', always: true },
}

/**
 * 按 key 列表造一份 `MapToolSpec[]`（各屏一行搞定）。
 * `keys` 用 `TOOL_SPECS` 的键名（3D 那一格已按用户要求删除）。
 * 本轮没有三维底图，点了也没有可切的东西 → 界面如实灰置，见需求专篇 §12 数据缺口）。
 */
export function toolsOf(keys: (keyof typeof TOOL_SPECS)[]): MapToolSpec[] {
  return keys.map((k) => TOOL_SPECS[k]).filter(Boolean)
}
