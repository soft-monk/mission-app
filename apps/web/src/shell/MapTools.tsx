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
import { useCallback, useEffect, type CSSProperties } from 'react'
import {
  mapCommands, useInteraction, useMapUiStore, LayerPanel,
  type DrawMode, type MapToolKey,
} from 'map-2d'
import { C } from '../theme'
import type { UseFlow } from '../flow/useFlow'
import { readCompose, replyText, useVerbOnce } from '../flow/useSituation'

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
    case 'measure': return <svg {...common}><path d="M2 11l9-9 3 3-9 9z" /><path d="M5 8l1.6 1.6M7.5 5.5L9 7" /></svg>
    case 'measure-area': return <svg {...common}><path d="M2.5 4.5l5-2 6 3-1 6-6 2-4-3z" /><path d="M5 9.5l2-2 2 1.5" /></svg>
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
    case 'mode3d': return <svg {...common}><path d="M8 1.6l5.6 3.2v6.4L8 14.4 2.4 11.2V4.8z" /><path d="M8 8.2l5.6-3.4M8 8.2v6.2M8 8.2L2.4 4.8" /></svg>
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
 *   · 图层     → `useMapUiStore.toggleLayersPanel()`（面板是 map-2d 的 `LayerPanel`）
 *   · 清屏/全屏 → map-2d 的 `clearMode` / 浏览器全屏 API（与模块工具条同一套语义）
 */
export function MapToolbar({ items, state, testid, style }: {
  items: MapToolSpec[]
  state: ReturnType<typeof useMapToolState>
  testid: string
  style?: CSSProperties
}) {
  const drawMode = useInteraction((s) => s.mode)
  const setDrawMode = useInteraction((s) => s.setMode)
  const clearMode = useMapUiStore((s) => s.clearMode)
  const setClearMode = useMapUiStore((s) => s.setClearMode)
  const layersOpen = useMapUiStore((s) => s.layersOpen)
  const toggleLayersPanel = useMapUiStore((s) => s.toggleLayersPanel)
  const setLayersPanel = useMapUiStore((s) => s.setLayersPanel)
  const setActiveTool = useMapUiStore((s) => s.setActiveTool)

  const act = useCallback((t: MapToolSpec) => {
    if (t.key === 'reset') {
      // 复位视角：回到本场景的初始中心/缩放（宿主的默认视角来自 scenario.ts 的 DEFAULT_SCENARIO）
      mapCommands.resetView()
      return
    }
    if (t.key === 'layers') { toggleLayersPanel(); return }
    if (t.key === 'clear') { setClearMode(!clearMode); return }
    if (t.key === 'fullscreen') {
      if (document.fullscreenElement) void document.exitFullscreen()
      else void document.documentElement.requestFullscreen().catch(() => undefined)
      return
    }
    const m2 = MAP2D_KEY[t.key]
    if (m2) setActiveTool(m2)
    if (t.key === 'select') { setDrawMode('none'); setLayersPanel(false); return }
    if (t.mode) setDrawMode(drawMode === t.mode ? 'none' : t.mode)
  }, [clearMode, drawMode, setActiveTool, setClearMode, setDrawMode, setLayersPanel, toggleLayersPanel])

  return (
    <>
      <div data-testid={testid} style={{ ...toolbarStyle, ...style }}>
        {items.map((t) => {
          const on = t.always ? true : state.on(t.key)
          const reason = state.reason(t.key)
          const undeclared = !state.declared(t.key)
          const active = t.key === 'clear'
            ? clearMode
            : (t.mode ? drawMode === t.mode : (t.key === 'layers' ? layersOpen : false))
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
              onClick={() => on && act(t)}
              style={{
                ...toolBtn,
                opacity: on ? 1 : 0.42,
                cursor: on ? 'pointer' : 'not-allowed',
                color: active ? '#eaf6ff' : (on ? C.text : C.unknown),
                border: `1px solid ${active ? C.borderStrong : 'transparent'}`,
                background: active ? 'rgba(29,78,216,.55)' : 'transparent',
              }}
            >
              <ToolGlyph k={t.id ?? t.key} size={15} />
              <span style={{ fontSize: 11, lineHeight: 1.1 }}>{t.label}</span>
              {t.sub && <span style={{ fontSize: 9, color: on ? C.accentDim : C.unknown }}>{t.sub}</span>}
            </button>
          )
        })}
      </div>
      {/* 图层面板：map-2d 自己的组件（M2-CTRL-06），挂在这里以免每个屏各写一份 */}
      {layersOpen && <LayerPanel />}
    </>
  )
}

/**
 * 光标跟随的"量算读数条"。
 *
 * `DrawLayer` 自己已经渲染了一条交互提示浮层（落点数 / 实时长度面积 / 操作说明），
 * 这里**不再重复画一份**，只把"当前处于什么工具模式"如实标在工具条旁边
 * （哪一格高亮已经表达了它，所以本组件默认只在工具条下方补一行文字说明来源）。
 */
export function ToolModeNote({ state, items, note, style }: {
  state: ReturnType<typeof useMapToolState>
  items: MapToolSpec[]
  note?: string
  style?: CSSProperties
}) {
  const drawMode = useInteraction((s) => s.mode)
  if (drawMode === 'none' && !note) return null
  const cur = items.find((t) => t.mode === drawMode)
  return (
    <div
      data-testid="map-tool-note"
      style={{ ...noteStyle, ...style }}
    >
      {cur && <span>当前工具：<b style={{ color: C.accent }}>{cur.label}</b>（map-2d 交互层，Esc 退出）　</span>}
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

/** 工具条容器：左上浮动（与参考图一致；`MapStage` 的自证信息条已不在产品屏出现，故 top 更小） */
const toolbarStyle: CSSProperties = {
  position: 'absolute', left: 12, top: 12, zIndex: 21,
  display: 'flex', gap: 2, padding: '4px 6px', borderRadius: 8,
  background: 'rgba(6,26,47,.82)', border: `1px solid ${C.border}`,
}
const toolBtn: CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
  minWidth: 50, padding: '5px 8px', borderRadius: 6, cursor: 'pointer',
  background: 'transparent', border: '1px solid transparent', color: C.text,
  font: 'inherit',
}
const noteStyle: CSSProperties = {
  position: 'absolute', left: 0, top: 58, zIndex: 21, maxWidth: 460,
  padding: '5px 10px', borderRadius: 8, fontSize: 11.5, lineHeight: 1.6,
  background: 'rgba(6,26,47,.88)', border: `1px solid ${C.border}`, color: C.text,
  pointerEvents: 'none',
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
  mode3d: {
    key: 'mode3d', label: '3D', sub: '2D/3D',
    // 图上每个地图屏右上都有这枚 3D / 2D 角标；本轮**没有三维底图**（三维已放弃），
    // 所以它恒灰置 —— 但原因不是"规则包忘了声明"，而是产品口径，这里如实写清楚。
    noteWhenUndeclared: '本轮无三维底图（个性化需求：三维已放弃，底图为二维瓦片）',
  },
  /** 复位视角 —— **宿主自带**（规则包没有这个 key），恒定可点；理由见 `MapToolSpec.always` */
  reset: { key: 'reset', label: '复位', always: true },
}

/**
 * 按 key 列表造一份 `MapToolSpec[]`（各屏一行搞定）。
 * `keys` 用 `TOOL_SPECS` 的键名；`mode3d` 是无行为键（图上只有一个 3D/2D 角标，
 * 本轮没有三维底图，点了也没有可切的东西 → 界面如实灰置，见需求专篇 §12 数据缺口）。
 */
export function toolsOf(keys: (keyof typeof TOOL_SPECS)[]): MapToolSpec[] {
  return keys.map((k) => TOOL_SPECS[k]).filter(Boolean)
}
