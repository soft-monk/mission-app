// mission-app · apps/web/src/screens/SituationScreen.tsx
//
// **SH-03 · 任务态势主界面**（参考图 `需求图与描述\场景1\T0-1.png`，需求专篇 DES-APP-001 §3 SH-03）。
//
// 版式照图（自上而下 / 自左而右）：
//   · 顶部压条：**显示模式：综合态势** / 阶段 / 区域 / 目标 + 回执状态
//   · 中区：二维瓦片底图（**由 App 的 `MapLayer` 统一渲染**，所有屏共用一张；2026-09-18 从本屏搬走）
//           + 左上浮动工具栏（**工具与可用性全部由 `view.compose` 说了算**）
//   · 右栏 3 面板：**AI任务分析** / **任务信息** / **资源概况**
//   · 底部：**「请选择任务场景」+ 三张场景入口卡**（场景一：敏捷拒止布控 / 场景二：集群协同突击 /
//           场景三：立体融合攻坚，各带小地图缩略图位 + 圆形 ▶）
//
// ★ 与旧版的三处关键差别（按图改的，别再改回去）：
//   ① **图上没有【确认场景，进入编组 ≫】** —— 那颗按钮属于 SH-04（场景确认），本屏删掉；
//   ② 底部不是"区域/空域清单"，是**三张场景入口卡**：点卡 → `onGo('SH-04')`；
//      场景二/三本轮未实现（个性化需求：先固定场景一）→ **提示，且不假装切过去**；
//   ③ 左上的"地图图层与工具"由一整段文字改成**图上那样的浮动工具栏**（工具条 + 显示模式）。
//
// ★ 纪律（与本仓其它屏一致）：
//   · **不编任何数值**：三面板的每个数都来自 `situation.snapshot` / `view.compose` / 资源台账
//     （`alloc.inventory`）的回执；取不到就显示"—"并写明缺在哪（G-09）。
//   · 图上是**三维地形底图**，我们只有**二维瓦片** —— 如实写一行小字，**不假装三维**。
//   · 样式一律 `left/right/top/bottom` 长写（**不用 `inset` 简写**：React 的 style diff 曾把
//     `top` 连带清掉、整屏塌成 0 高，见 `流程接口冻结.md` §7）。
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { C, panel, panelTitle } from '../theme'
import type { FlowState } from '../api'
import type { UseFlow } from '../flow/useFlow'
import {
  n2s, readCompose, readInventory, readSituation, replyText, sortByType, threatColor,
  uavTypeCN, useVerbOnce, type Metric,
} from '../flow/useSituation'
import { VerbVerdict } from './VerbVerdict'

import { MapToolbar, ToolModeNote, TOOL_SPECS, useMapToolState, type MapToolSpec } from '../shell/MapTools'
// ★ 2026-09-21：`TEXT_STYLE_OPTIONS` 不再 import —— 需求方点名"所有的标签编辑框，都删除选标签样式"，
//   本屏不再渲染样式选择器（样式清单 `TEXT_STYLES` 仍留在 map-2d / biz-catalog 里，随时可再接回来）。
import { BIZ_GROUPS, bizEntry, bizNameOf, modeGroupOf, type BizSizeSpec } from '../biz-catalog'
import { pickModeNow, usePickMode } from '../pick-mode'
// map-2d：`mapInstance` 取当前地图实例（"落点即创建"要挂 click）；`useInteraction` 取绘制模式
// `boundStyleOf` 随样式选择器一起不再用（2026-09-21）；`setBoundStyle` 保留：保存时把样式写回固定档
// ★ 2026-09-21「合并框」新增的能力：
//   `useGeometryDraft` —— 点/线/面"收笔 → 弹框 → 确认才落图"那条路的草稿（读它 = 拿到刚画的顶点与标签）；
//   `verticesOfId / setVerticesOfId / findGeometry / isVertexListKind` —— 编辑态按 id 读写顶点；
//   `GEOMETRY_KEYS` —— 判"选中的是不是几何原语图元"（决定 加行/删行 按钮出不出来）。
import {
  MapDraw, boundTextOf, mapCommands, mapInstance, setBoundStyle, setBoundText, useInteraction,
  useGeometryDraft, useShapePreview, draftVertexError, minVerticesOf,
  findGeometry, verticesOfId, setVerticesOfId, isVertexListKind, GEOMETRY_KEYS,
  type TextStyle, type LngLat, type GeometryKey, type GeometryDraft, type AnnulusItem,
} from 'map-2d'
// ★ 2026-09-18「计划」：计划文件的读写（空地图 + 手动打开计划）
import { applyPlan, homeView, loadPlanConfig, parsePlan, pickPlanToOpen, pickPlanToSave, savableCount, serializePlan } from '../plan-file'
// ★ 2026-09-18「规划航线」：A* 按界面上画的集结区/任务区算航线 + 航道
import { classifyAreas, planAndDrawRoute } from '../route-compute'
// ★ 2026-09-18：`DiagBox/DiagLine`（`../shell/Diag`）的 import 随"视图声明"浮层一起删掉了 ——
//   本屏不再显示任何诊断浮层；工具可用性仍然照发 `view.compose`（见下面的 `cmp`）。

/**
 * **跟随文本框的固定样式**（2026-09-21 按需求新增）。
 *
 * 需求方原话："所有的标签编辑框，都删除选标签样式" —— 界面上不再提供切换入口，
 * 所以绑定文本的样式统一钉在**角标**（`'tag'`：一行小字贴着图元，最省地方）。
 * 模块侧的三种样式（`TEXT_STYLES`）与 `setBoundStyle()` **能力都还在**，
 * 将来要放开切换，只需把选择器接回来、把这里换成 `editing.style`。
 */
const BOUND_TEXT_STYLE: TextStyle = 'tag'

// ============================================================================
// 合并框（标签 + 逐顶点经纬度）—— 2026-09-21 需求
// ============================================================================
//
// 需求原话："点 / 线 / 面绘制完成后，不仅弹出标签编辑框，还需要弹出经纬度编辑框，合并为一起，
// 点击确认后绘制"；随后逐轮敲定的口径：
//   · 先落图（画出来看）→ 框里可改 → **确认才定死**（草稿态 = 预览 + 手柄亮着 + 框开着）；
//   · 每个顶点一行，行内 经度 / 纬度；**5 位小数**；经度 ±180、纬度 ±90；
//   · 框**限高 + 内部滚动**；**加行 / 删行**（点没有这两枚按钮）；
//   · 改坐标 / 拖手柄 → **图上形状实时跟着变**（同一份数据，两个入口）；
//   · 顶点到下限：**不允许继续删**（删行按钮灰掉）、**确定仍可点但拦住并提示**；
//   · 加行默认坐标 = **复制最后一个顶点**，追加到末尾；
//   · 【取消】/ **Esc = 放弃**：新画的 → 撤掉不留痕；改已有的 → **还原成改之前**。

/** 坐标保留几位小数（与屏上左下角读数同口径：5 位 ≈ 1 米） */
const COORD_DECIMALS = 5
/** 经度 / 纬度的合法范围（需求方定） */
const LNG_LIMIT = 180
const LAT_LIMIT = 90

/** 合并框的三种来源 */
type EditorState =
  | {
    mode: 'draw'
    kind: GeometryKey
    label: string
    points: LngLat[]
    /** 地图 onDone 回调（模块不落图，这个回调本轮已不用；留着是为了排障时能看出是谁发起的） */
  }
  | {
    mode: 'edit'
    /** 被编辑的图元（`kind:id`，模块的顶点读写按 id 走，这里只为显示与排障） */
    ref: string
    kind: GeometryKey
    label: string
    points: LngLat[]
    /** 改动前的样子（放弃时还原；需求："编辑态改已有图元 → 放弃 = 还原成改之前"） */
    snapshot: { id: string; kind: string; item: Record<string, unknown>; text: string | null }
  }
  | {
    /**
     * **指定尺寸模式**（2026-09-21 需求）：点一个中心点 → 填尺寸 + 标注名称 → 确定画出。
     * 只在"已点了中心点之后"才存在这个形态（点中心之前盒子里什么都没有）。
     */
    mode: 'size'
    /** 业务条目 key（决定填完画成什么：矩形 / 距离环 / 方位圈 / 九宫格） */
    bizKey: string
    /** 条目名（框标题用） */
    title: string
    /** 字段定义（来自 `biz-catalog.ts`，宿主不另抄一份） */
    spec: BizSizeSpec
    /** 点下的中心点（经纬度） */
    center: LngLat
    label: string
    /** 各字段**当前输入文本**（键 = field.key）。用文本而不是数字：允许"打到一半"（如 `1.`）不被打断 */
    values: Record<string, string>
  }

/** 顶点数下限：点 1、线 2、面 3（与模块 `minVerticesOf` 同一口径，不另抄一份规则） */
const minOfKind = (k: GeometryKey): number => minVerticesOf(k as never)

/** 顶点数的中文名（拦住时的提示文案要用） */
const kindNameOf = (k: GeometryKey): string =>
  k === 'point' ? '点' : k === 'line' ? '线' : k === 'closedLine' ? '闭合线' : '面'

/** 数字 → 输入框里的文本（固定 5 位小数，不去尾零：保持"看多少位就是多少精度"） */
const fmtCoord = (v: number): string => (Number.isFinite(v) ? v.toFixed(COORD_DECIMALS) : '')

/** 输入框文本 → 数字（空 / 非数字 / 超范围 → null，由调用方决定怎么提示） */
function parseCoord(raw: string, axis: 'lng' | 'lat'): number | null {
  const s = raw.trim()
  if (!s) return null
  const v = Number(s)
  if (!Number.isFinite(v)) return null
  const lim = axis === 'lng' ? LNG_LIMIT : LAT_LIMIT
  if (v < -lim || v > lim) return null
  return v
}

/** 两组顶点是不是**一模一样**（按数字比，不比对象身份）——拖拽每秒来几十次变更，没变就别重渲染 */
function samePoints(a: LngLat[], b: LngLat[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false
  return true
}

/**
 * **把"图元里的顶点"规范成"框里要显示的顶点"**（2026-09-21）。
 *
 * 为什么需要这一步：**面的环（`area.polygon`）是"闭合环"** —— 存的是"首点又补了一遍"
 * （`draw.polygon` 直接落 `ring`，模块自己的预览也是这样画的）。若原样显示到框里，
 * 一个 4 顶点面会显示 **5 行**，确认写回时还会**再补一个重复点**，点越改越多。
 * 所以统一口径：**框里一行 = 一个真顶点**，读出时去掉末尾那个与首点重复的点，写回时由模块自己闭合。
 */
function editorPointsOf(id: string): LngLat[] {
  const pts = verticesOfId(id)
  if (pts.length >= 2) {
    const a = pts[0]
    const b = pts[pts.length - 1]
    if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) return pts.slice(0, -1)
  }
  return pts
}

/**
 * **把框里的顶点写回图元**（写回前把面补成闭合环，与 `draw.polygon` 的落库口径一致）。
 *
 * 为什么要补：面图元存的是"闭合环"（末尾重复首点）——量算面积、闭合渲染都按这个口径读。
 * 框里是"一行一个真顶点"（不重复），所以写回前补一次；线 / 点不需要补。
 */
function writeEditorPoints(id: string, kind: GeometryKey, pts: LngLat[]): boolean {
  if (kind !== 'polygon' || pts.length < 3) return setVerticesOfId(id, pts)
  return setVerticesOfId(id, [...pts, [pts[0][0], pts[0][1]] as LngLat])
}

// ---------------------------------------------------------------- 指定尺寸模式（2026-09-21）
//
// 需求（原话）："在画任务区，集结区，需要两种模式……一种是点击一个中心点后，用户指定区域长宽，自动绘制"；
// 圈层类同理（距离环 / 方位圈填半径、九宫格填每格长度 + 行列）。
//
// 实现口径：
//   · 中心点 + 长宽 → 生成**4 个角点的普通 polygon**（正南北朝向；朝向由编辑态的 `R` 旋转负责）——
//     复用现有图元，导出 / 计划文件 / 显隐面板 / 合并框全都不用改；
//   · 三类圈层 → 直接造 `annulus` 图元（字段语义见 `map-2d/src/core/annulus.ts`）：
//     距离环 `radiusKmList`（三圈按 1/3、2/3、1）、方位圈 `radiusKm`（刻度 30°）、
//     九宫格 `radiusKm`（= **每格边长**）+ `rows`/`cols`。
//   名与标注都进 `label`，图上会显示（与手动模式一致）。

/** 每度纬度约多少公里、每度经度约多少公里（按所在纬度折算）——与模块 `annulus.ts` 同口径 */
const KM_PER_DEG_LAT = 111.32
const kmPerDegLng = (lat: number): number => 111.32 * Math.max(1e-6, Math.cos((lat * Math.PI) / 180))

/** 中心 + 长（东西向）+ 宽（南北向）→ 矩形的 4 个角点（正南北朝向，首尾不重复） */
function rectRing(center: LngLat, wKm: number, hKm: number): LngLat[] {
  const dLng = (wKm / 2) / kmPerDegLng(center[1])
  const dLat = (hKm / 2) / KM_PER_DEG_LAT
  return [
    [center[0] - dLng, center[1] - dLat],
    [center[0] + dLng, center[1] - dLat],
    [center[0] + dLng, center[1] + dLat],
    [center[0] - dLng, center[1] + dLat],
  ]
}

/** 数字文本 → 正数（空 / 非数字 / 小于下限 → null，由调用方提示） */
function parseSize(raw: string, min: number): number | null {
  const s = raw.trim()
  if (!s) return null
  const v = Number(s)
  if (!Number.isFinite(v) || v < min) return null
  return v
}

/**
 * **一份"要画什么"的规格**（2026-09-21 新增，为"实时预览"抽出）。
 *
 * 为什么要把"解析 + 判形"从 `submitSizeEditor` 里抽出来：预览与确定**必须用同一份规格** ——
 * 预览一个样、落图另一个样是最难查的一类缺陷。所以现在：
 *   解析一次 → 得到 `SizeSpec` → **预览用它**（交给模块的 `useShapePreview`）→ **确定也用它**。
 */
type SizeSpec =
  | { form: 'rect'; center: LngLat; wKm: number; hKm: number }
  | { form: 'ring'; center: LngLat; kind: 'ring'; radiiKm: number[] }
  | { form: 'ring'; center: LngLat; kind: 'bearing-ring'; radiusKm: number; stepDeg: number }
  | { form: 'ring'; center: LngLat; kind: 'grid'; sideKm: number; rows: number; cols: number }

/**
 * 把框里的数字解析成 `SizeSpec`。
 * @returns `{ spec }` 或 `{ error }`（**任何一个字段不合法就整体拦住**，不做"部分生效"）
 */
function sizeSpecOf(e: Extract<EditorState, { mode: 'size' }>): { spec: SizeSpec } | { error: string } {
  const v: Record<string, number> = {}
  for (const f of e.spec.fields) {
    const n = parseSize(e.values[f.key] ?? '', f.min)
    if (n === null) return { error: `${f.label}要是 ≥ ${f.min} 的数字` }
    v[f.key] = n
  }
  const center = e.center
  if (e.bizKey === 'biz:task-area:size' || e.bizKey === 'biz:assembly:size') {
    return { spec: { form: 'rect', center, wKm: v.w, hKm: v.h } }
  }
  if (e.bizKey === 'biz:ring:size') {
    return { spec: { form: 'ring', center, kind: 'ring', radiiKm: [v.r / 3, (v.r * 2) / 3, v.r] } }
  }
  if (e.bizKey === 'biz:bearing-ring:size') {
    return { spec: { form: 'ring', center, kind: 'bearing-ring', radiusKm: v.r, stepDeg: 30 } }
  }
  if (e.bizKey === 'biz:grid:size') {
    // 行列数按整数用（`Math.round`，最小 1）：输入框允许打分号，但画出来必须是整格
    return {
      spec: {
        form: 'ring', center, kind: 'grid', sideKm: v.r,
        rows: Math.max(1, Math.round(v.rows)), cols: Math.max(1, Math.round(v.cols)),
      },
    }
  }
  return { error: '这个条目没有尺寸模式（配置可能过期了）' }
}

/** 把 `SizeSpec` 交给模块的**形状预览**通道（虚线青色实时预览；不进图元集合） */
function showShapePreview(bizKey: string, spec: SizeSpec): void {
  const show = useShapePreview.getState().show
  if (spec.form === 'rect') {
    // 矩形：给模块"中心 + 半宽/半高"，它按同一口径（111.32 km/度、按纬度折经度）画虚线环
    show({ key: bizKey, kind: 'rect', center: spec.center, halfWkm: spec.wKm / 2, halfHkm: spec.hKm / 2 })
    return
  }
  if (spec.kind === 'ring') show({ key: bizKey, kind: 'ring', center: spec.center, radiusKmList: spec.radiiKm })
  else if (spec.kind === 'bearing-ring') show({ key: bizKey, kind: 'bearing-ring', center: spec.center, radiusKmList: [spec.radiusKm], bearingStepDeg: spec.stepDeg })
  else show({ key: bizKey, kind: 'grid', center: spec.center, sideKm: spec.sideKm, rows: spec.rows, cols: spec.cols })
}

/**
 * **按填写的尺寸把图元画出来**（确定时调用一次）。
 * @returns 提示语：null = 成功；有字 = 拦住（框继续开着）
 */
function submitSizeEditor(e: Extract<EditorState, { mode: 'size' }>): string | null {
  const parsed = sizeSpecOf(e)
  if ('error' in parsed) return parsed.error
  const spec = parsed.spec
  const color = bizEntry(e.bizKey)?.start.color
  const label = e.label || e.spec.defaultLabel

  if (spec.form === 'rect') {
    // 长宽模式 → 4 角点的面（中心来自框里的"中心点"，可手动改）
    return drawPolygon(rectRing(spec.center, spec.wKm, spec.hKm), label, color) ? null : '矩形没画出来（顶点不合法）'
  }

  // 三类圈层：造同一个 `annulus` 图元，只是参数不同（与手动模式造出来的东西完全一致）
  const mk = (item: Record<string, unknown>) => {
    const ok = MapDraw.add('annulus', item as never)
    return ok ? null : '圈层图元没画出来'
  }
  const center = { lng: spec.center[0], lat: spec.center[1] }
  if (spec.kind === 'ring') {
    return mk({ ...center, kind: 'ring', radiusKmList: spec.radiiKm, label, color: color ?? '#22d3ee' })
  }
  if (spec.kind === 'bearing-ring') {
    return mk({ ...center, kind: 'bearing-ring', radiusKm: spec.radiusKm, bearing: spec.stepDeg, label, color: color ?? '#22d3ee' })
  }
  if (spec.kind === 'grid') {
    // 九宫格的字段名叫 `radiusKm`，语义是**每格边长**（见 `map-2d/src/core/annulus.ts`）
    return mk({ ...center, kind: 'grid', radiusKm: spec.sideKm, rows: spec.rows, cols: spec.cols, dashed: true, label, color: color ?? '#22d3ee' })
  }
  return '这个条目没有尺寸模式（配置可能过期了）'
}

/** 面的一步落库（尺寸模式用；比走 `draw.polygon` 更直接：宿主已经在用 `MapDraw`） */
function drawPolygon(ring: LngLat[], label: string, color?: string): boolean {
  const id = `size-area-${Date.now().toString(36)}`
  const ok = MapDraw.add('area', {
    id, polygon: [...ring, [ring[0][0], ring[0][1]]],     // 闭合环（模块的落库口径）
    color: color ?? '#ef4444', opacity: 0.1, weight: 2,
    label, textStyle: BOUND_TEXT_STYLE,
  } as never)
  return ok
}

/**
 * **顶点数的当前问题**（返回 null = 合法）。
 * 拦住的话术与模块 `draftVertexError` 同款（"面至少 3 个顶点"），宿主不另起一套说辞。
 */
function pointsError(kind: GeometryKey, points: LngLat[]): string | null {
  const min = minOfKind(kind)
  if (points.length >= min) return null
  return `${kindNameOf(kind)}至少 ${min} 个顶点（现在 ${points.length} 个）`
}

/**
 * **从图元记录反推它的几何种类**（编辑态弹框前判"这个图元可不可编辑"）。
 *
 * 判据全部来自模块：三种多顶点种类看"哪个顶点字段有值"（`points` / `polygon`），
 * 单点种类看"有没有 lng+lat"。**不猜、不按 id 前缀认**（业务 id 是宿主自己编的，不可靠）。
 * 返回 null = 不是几何原语（军标 / 距离环 / 无人机 / 航迹…）→ 不进合并框。
 */
function kindOfGeometry(item: Record<string, unknown>): GeometryKey | null {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(item, k) && item[k] != null
  if (has('polygon')) return 'polygon'                 // area 图元：带填充的真面
  if (Array.isArray(item.points) && (item.points as unknown[]).length) {
    // route 图元既被"线"用、也被"闭合线"用：**首尾同点 = 闭合线**（`draw.closedLine` 就是这么落库的：
    // 首尾不同才补一个首点）。按 1e-6 度（约 0.1 米）容差比，不要求严格相等。
    const pts = item.points as LngLat[]
    const same = (a: LngLat, b: LngLat) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6
    const closed = pts.length >= 3 && same(pts[0], pts[pts.length - 1])
    return closed ? 'closedLine' : 'line'
  }
  if (has('lng') && has('lat')) {
    // shape（圆 / 椭圆）也是 lng+lat：它们没有"顶点列表"，按单点处理（不给加删行）
    return 'point'
  }
  return null
}

/**
 * **合并框**：标签 + 逐顶点经纬度（2026-09-21 需求）。
 *
 * 分工：本组件只管**画**与**收集输入**；数据落在哪（草稿 / 图元）由外面的回调决定 ——
 * 这样"框里的数字"与"图上的形状"永远走同一条路，不会出现两处状态各说各话。
 *
 * 按钮：`确定`（顶点到下限时仍可点，点了由外面拦住并提示）+ `取消`（= Esc，放弃绘制 / 还原）。
 */
function GeometryEditor(p: {
  editor: EditorState
  /** 模块里的草稿（`draw` 模式的唯一事实；`edit` 模式为 null） */
  draft: GeometryDraft | null
  /** 拦住 / 失败的回执 */
  message: string | null
  onLabel: (v: string) => void
  /** 尺寸模式：改某一个尺寸字段（`key` 来自 `biz-catalog.ts` 的 `size.fields`） */
  onSizeValue: (key: string, raw: string) => void
  /** 尺寸模式：改中心点（`axis` = 经度 / 纬度；用户手动编辑那两格时调用） */
  onCenter: (axis: 'lng' | 'lat', raw: string) => void
  /** 坐标输入框获得 / 失去焦点（宿主据此决定"要不要从图元回读坐标"） */
  onCoordsFocus: (focused: boolean) => void
  onPoint: (i: number, axis: 'lng' | 'lat', raw: string) => void
  onAddRow: () => void
  onRemoveRow: (i: number) => void
  onConfirm: () => void
  onCancel: () => void
}) {
  const { editor, draft, message } = p
  // `draw` 模式以草稿为唯一事实：地图上拖手柄改的也是它 —— 框里因此实时跟着变
  const points = editor.mode === 'draw' ? (draft?.points ?? editor.points) : (editor.mode === 'edit' ? editor.points : [])
  // 尺寸模式没有"几何种类"这回事（它是按尺寸造图元），所以这三个值只在另外两种模式下有意义
  const geomKind: GeometryKey = editor.mode === 'size' ? 'point' : editor.kind
  const min = minOfKind(geomKind)
  const canRows = geomKind !== 'point'        // 需求："点没有加删按钮"
  const canRemove = canRows && points.length > min   // 到下限那枚 × 就灰掉（不允许继续删）
  const tooFew = pointsError(geomKind, points)

  /**
   * **输入中的文本**（键 = `行号:轴`）。
   *
   * 为什么不能直接受控于数字：坐标要能一个字符一个字符地打（`-`、`116.` 这些**中间态不是合法数字**），
   * 直接受控会在你敲第二个字符时把框弹回原值，根本打不进去。
   * 所以：正在输入的那一格显示你打的字；**只要解析出合法数字就立刻生效**（图上形状实时跟着变）；
   * 失焦后丢掉这份"输入中文本"，回到唯一的数字事实（`toFixed(5)`）。
   */
  const [texts, setTexts] = useState<Record<string, string>>({})
  /** 正在输入哪一格 —— 只有这一格跳过"实时值覆盖"，否则拖手柄时会把你正在打的字冲掉 */
  const focusKey = useRef<string | null>(null)

  // Esc = 放弃绘制、Enter = 确定（需求："esc 也加放弃绘制"）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); p.onCancel() }
      if (e.key === 'Enter' && !(e.target as HTMLElement | null)?.dataset?.editorBtn) p.onConfirm()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const title = editor.mode === 'draw'
    ? `绘制${kindNameOf(editor.kind)} · 确认后落图`
    : editor.mode === 'edit'
      // 2026-09-21：标题**优先显示标注名称**（原先是 `编辑面 · area:size-area-xxx` 这种 id 号，
      // 需求方报"弹窗没有使用标注名称，而是 id 号"）。没有名字才退回 id；完整 id 挂在 `title` 里备查。
      ? `编辑${kindNameOf(editor.kind)} · ${editor.label.trim() || editor.ref}`
      : `${editor.title} · 指定尺寸`

  return (
    <div data-testid="geometry-editor" style={geoEditorStyle}>
      <div style={geoEditorHeadStyle}>
        {/* 标题：编辑态优先显示**标注名称**；`title` 属性里挂完整 id（`kind:id`）供排障时悬停查看 */}
        <span title={editor.mode === 'edit' ? editor.ref : undefined}>{title}</span>
        {/* 草稿态：明确告诉用户"现在还是草稿"（需求方问过"怎么体现画出来看 vs 真画出来固定"） */}
        {editor.mode === 'draw' && <span style={{ color: C.warn }}>草稿（未落图）</span>}
      </div>

      <div style={geoEditorRowStyle}>
        <span style={geoEditorLabelStyle}>标签</span>
        <input
          data-testid="geometry-editor-label"
          autoFocus
          value={editor.label}
          onChange={(e) => p.onLabel(e.target.value)}
          style={geoLabelInputStyle}
        />
      </div>

      {/* ---- 尺寸模式：中心点（可手改）+ 尺寸字段（+ 名称），没有顶点表 ---- */}
      {editor.mode === 'size' && (
        <>
          {/* ★ 2026-09-21 需求："中心点点击的位置，也可以手动编辑" —— 只读文字改成经纬度两格输入，
              与顶点表同一套样式与校验；改完图上预览实时跟着平移（`onPoint` 那条预览 effect）。 */}
          <div style={geoEditorRowStyle}>
            <span style={{ ...geoEditorLabelStyle, width: 108 }}>中心点</span>
            <span style={geoEditorLabelStyle}>经度</span>
            <input
              data-testid="geometry-editor-center-lng"
              value={editor.values.centerLng ?? fmtCoord(editor.center[0])}
              onChange={(e) => p.onCenter('lng', e.target.value)}
              style={geoCoordInputStyle}
            />
            <span style={geoEditorLabelStyle}>纬度</span>
            <input
              data-testid="geometry-editor-center-lat"
              value={editor.values.centerLat ?? fmtCoord(editor.center[1])}
              onChange={(e) => p.onCenter('lat', e.target.value)}
              style={geoCoordInputStyle}
            />
          </div>
          <div data-testid="geometry-editor-size" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {editor.spec.fields.map((f) => (
              <div key={f.key} style={geoEditorRowStyle}>
                <span style={{ ...geoEditorLabelStyle, width: 108 }}>{f.label}</span>
                <input
                  data-testid={`geometry-editor-size-${f.key}`}
                  value={editor.values[f.key] ?? ''}
                  onChange={(e) => p.onSizeValue(f.key, e.target.value)}
                  style={geoSizeInputStyle}
                />
                {f.unit && <span style={geoEditorLabelStyle}>{f.unit}</span>}
              </div>
            ))}
          </div>
        </>
      )}

      {/* ---- 顶点表：手绘 / 编辑已有图元两种模式共用 ---- */}
      {editor.mode !== 'size' && (
        <>
          <div style={{ ...geoEditorLabelStyle, marginTop: 2 }}>
            顶点坐标（{points.length} 个{canRows ? `，最少 ${min} 个` : ''}）
          </div>
          <div data-testid="geometry-editor-rows" style={geoRowsStyle}>
        {points.map((pt, i) => (
          <div key={i} style={geoEditorRowStyle}>
            <span style={{ ...geoEditorLabelStyle, width: 18 }}>{i + 1}</span>
            <span style={geoEditorLabelStyle}>经度</span>
            <input
              data-testid={`geometry-editor-lng-${i}`}
              // 正在输入的这一格显示你打的字；其余格子一律显示数字事实（拖手柄时会实时变）
              value={focusKey.current === `${i}:lng` ? (texts[`${i}:lng`] ?? fmtCoord(pt[0])) : fmtCoord(pt[0])}
              onFocus={() => {
                focusKey.current = `${i}:lng`
                setTexts((s) => ({ ...s, [`${i}:lng`]: fmtCoord(pt[0]) }))
                p.onCoordsFocus(true)
              }}
              onBlur={() => { focusKey.current = null; p.onCoordsFocus(false) }}
              onChange={(e) => {
                const raw = e.target.value
                setTexts((s) => ({ ...s, [`${i}:lng`]: raw }))
                p.onPoint(i, 'lng', raw)          // 合法数字立即生效；不合法只是不生效（回执条会给话）
              }}
              style={geoCoordInputStyle}
            />
            <span style={geoEditorLabelStyle}>纬度</span>
            <input
              data-testid={`geometry-editor-lat-${i}`}
              value={focusKey.current === `${i}:lat` ? (texts[`${i}:lat`] ?? fmtCoord(pt[1])) : fmtCoord(pt[1])}
              onFocus={() => {
                focusKey.current = `${i}:lat`
                setTexts((s) => ({ ...s, [`${i}:lat`]: fmtCoord(pt[1]) }))
                p.onCoordsFocus(true)
              }}
              onBlur={() => { focusKey.current = null; p.onCoordsFocus(false) }}
              onChange={(e) => {
                const raw = e.target.value
                setTexts((s) => ({ ...s, [`${i}:lat`]: raw }))
                p.onPoint(i, 'lat', raw)
              }}
              style={geoCoordInputStyle}
            />
            {canRows && (
              <button
                data-testid={`geometry-editor-del-${i}`}
                disabled={!canRemove}
                title={canRemove
                  ? `删掉第 ${i + 1} 个顶点`
                  : `${kindNameOf(geomKind)}至少 ${min} 个顶点，不能再删`}
                onClick={() => p.onRemoveRow(i)}
                style={canRemove ? geoRowBtnStyle : geoRowBtnOffStyle}
              >×</button>
            )}
          </div>
        ))}
        {!points.length && <div style={{ ...geoEditorLabelStyle }}>（没有顶点）</div>}
      </div>
      {canRows && (
        <div style={geoEditorRowStyle}>
          <button
            data-testid="geometry-editor-add"
            title="在末尾加一个顶点（默认坐标 = 复制最后一个顶点）"
            onClick={p.onAddRow}
            style={geoRowBtnStyle}
          >加行</button>
        </div>
      )}
        </>
      )}

      {/* 拦住 / 失败的回执（需求："【确定】仍可点，点了拦住并提示"） */}
      {message && <div data-testid="geometry-editor-msg" style={geoMsgStyle}>{message}</div>}
      {/* 尺寸模式没有"顶点数不够"这回事，所以那条灰字只在前两种模式显示 */}
      {!message && editor.mode !== 'size' && tooFew && <div style={geoMsgDimStyle}>{tooFew}</div>}

      <div style={geoEditorFootStyle}>
        <button
          data-testid="geometry-editor-ok"
          data-editor-btn="1"
          onClick={p.onConfirm}
          style={geoOkBtnStyle}
        >确定</button>
        <button
          data-testid="geometry-editor-cancel"
          data-editor-btn="1"
          onClick={p.onCancel}
          style={geoCancelBtnStyle}
        >取消（Esc）</button>
      </div>
    </div>
  )
}

/**
 * 三张场景入口卡（**文案逐字来自参考图**，不是引擎数据）。
 *
 * `implemented` 是本轮范围的事实（`个性化需求.txt`：流程先固定只实现**场景一**）——
 * 图上有三张卡，但场景二/三还没有任何一屏，所以点它们只给提示，**不切换**（§9-4/§9-5）。
 */
const SCENES: { id: string; no: string; name: string; accent: string; implemented: boolean }[] = [
  { id: 'scenario-1', no: '场景一', name: '敏捷拒止布控', accent: 'rgba(95,176,255,.85)', implemented: true },
  { id: 'scenario-2', no: '场景二', name: '集群协同突击', accent: 'rgba(34,197,94,.85)', implemented: false },
  { id: 'scenario-3', no: '场景三', name: '立体融合攻坚', accent: 'rgba(245,158,11,.85)', implemented: false },
]

/**
 * 本屏工具条的**版式**（2026-09-19 用户合并后的版式）。
 *
 * 用户原话："态势界面，工具栏中，新建、区域、标绘，合并为一个功能叫「新建」，一级子菜单显示分类，
 * 二级子菜单才显示当前的内容；测距、测面合并为「量算」；全屏、清屏、复位合并叫「视图」，放在最后面。"
 *
 * 顺序：**选择 / 新建 / 量算 / 场景 / 计划 / 图层 / 视图**（新建仍在"选择"之后、量算紧跟新建、视图在末尾）。
 * 「新建」的一级分类来自 `biz-catalog.ts` 的 `BIZ_GROUPS`（点 / 线 / 面 / 标绘，31 项一个不丢）；
 * 「量算」= 测距 / 测面（走 map-2d 的绘制模式，选中态由工具条按二级条目判）；
 * 「视图」= 全屏 / 清屏 / 复位，图标沿用原来的【全屏】（`id: 'fullscreen'` 就是给 `ToolGlyph` 的键）。
 *
 * 2026-09-19 用户追加："『不可用就灰』这个行为不需要"，且**只对本屏**：
 *   末尾统一 `always: true`，本屏这一排一律可点、一律不灰；其他屏仍按规则包 `view.compose` 如实灰置
 *   （共用组件的灰置判据一行没动）。
 */
const SH03_ITEMS: MapToolSpec[] = [
  {
    id: 'create', key: 'create', label: '新建',
    /**
     * 一级分类 → 二级条目 →（部分条目的）**三级模式**。
     *
     * 2026-09-21 需求："把之前的任务区变成二级菜单，点击后出现任务区（手动点位）、任务区（自动长宽）；
     * 集结区同上，其他刚刚加的同上" —— 于是这五条（任务区 / 集结区 / 距离环 / 方位圈 / 九宫格）
     * 在二级里是**带 `items` 的分组**（行尾有 ▸），点它才在最右侧展开两个模式；
     * 其余条目（标注面 / 威胁区 / 军标…）仍是点中即执行。
     */
    submenu: BIZ_GROUPS.map((g) => ({
      key: g.key, label: g.label,
      items: g.items.map((e) => {
        const modes = modeGroupOf(e.key)
        return modes
          ? { key: e.key, label: e.label, note: modes.note, items: modes.modes.map((m) => ({ key: m.key, label: m.label, note: m.note })) }
          : { key: e.key, label: e.label, note: e.note }
      }),
    })),
  },
  {
    id: 'measure', key: 'measure', label: '量算',
    submenu: [
      { key: 'measure-line', label: '测距', mode: 'measure-line', note: '单击落点，双击 / Enter 结束，Esc 取消' },
      { key: 'measure-area', label: '测面', mode: 'measure-area', note: '单击落点，双击 / Enter 结束，Esc 取消' },
    ],
  },
  TOOL_SPECS.scene,
  TOOL_SPECS.plan,
  TOOL_SPECS.layers,
  {
    id: 'fullscreen', key: 'view', label: '视图',
    submenu: [
      { key: 'fullscreen', label: '全屏', note: '进入 / 退出浏览器全屏' },
      { key: 'clear', label: '清屏', note: '隐藏各面板浮层、只留地图（Esc 或再点一次退出）' },
      { key: 'reset', label: '复位', note: '回到本场景的初始中心与缩放' },
    ],
  },
]

/** 本屏工具条里**静态**的那几格（"选择"格随模式变，所以放在组件里动态拼）；一律常开，本屏不灰。 */

// 2026-09-20：原先这里有个 `PICK_OPEN_TEXT_EDITOR` 常量（2026-09-19 用来屏蔽"点图元弹编辑器"）。
// 现在改成**按选择模式**：只有"编辑"模式下点图元才弹编辑器（见下面那个 useEffect）。常量已移除。

/** 一行计量：名 + 值（值缺失显示"—"，**不补 0**）。 */
function MetricRow({ m }: { m: Metric }) {
  const color = m.status ? threatColor(m.status) : C.text
  return (
    <div data-testid="metric-row" style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '3px 0', fontSize: 12.5 }}>
      <span style={{ color: C.textDim, flex: '0 0 auto' }}>{m.name}</span>
      <span style={{ flex: 1, borderBottom: '1px dotted rgba(95,176,255,.25)', transform: 'translateY(-3px)' }} />
      <span style={{ color, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
        {m.value !== undefined ? n2s(m.value, m.unit ?? '') : (m.text ?? '—')}
      </span>
    </div>
  )
}

/** 「名 → 值」键值对（**任务信息 / AI任务分析** 用的就是它）。值取不到 → "—"。 */
function KV({ k, v, color }: { k: string; v?: string; color?: string }) {
  return (
    <div data-testid="kv-row" style={{ display: 'flex', gap: 8, padding: '4px 0', fontSize: 12.5 }}>
      <span style={{ color: C.textDim, width: 92, flex: '0 0 auto' }}>{k}</span>
      <span style={{ color: color ?? C.text, minWidth: 0, wordBreak: 'break-all', fontVariantNumeric: 'tabular-nums' }}>
        {v ?? '—'}
      </span>
    </div>
  )
}

function Section({ title, children, testid, extra }: {
  title: string; children: React.ReactNode; testid?: string; extra?: React.ReactNode
}) {
  return (
    <div data-testid={testid} style={{ ...panel, width: '100%' }}>
      <div style={panelTitle}>
        {title}
        {extra && <span style={{ float: 'right', fontSize: 11, color: C.textDim }}>{extra}</span>}
      </div>
      <div style={{ padding: '7px 12px 9px' }}>{children}</div>
    </div>
  )
}

/** 缺数据时的统一一行：**写清缺在哪**，不是空白。 */
function Missing({ text }: { text: string }) {
  return <div style={{ fontSize: 11, color: C.warn, lineHeight: 1.6 }}>{text}</div>
}

/**
 * 场景入口卡的"小地图缩略图位"。
 *
 * 图上那三张缩略图是**三维地形截图**；我们没有它们的图源，所以这里画的是**装饰性示意块**
 * （渐变 + 网格 + 一个节点符号），并在 `title` 里如实说明它**不是**真实底图截图 —— 不拿别的
 * 画面冒充。
 */
function MiniMapThumb({ accent }: { accent: string }) {
  return (
    <div
      title="小地图缩略图位：图上为三维地形截图，本轮没有对应图源（装饰性示意，不是真实底图）"
      style={{
        position: 'relative', flex: 1, minHeight: 0, borderRadius: 6, overflow: 'hidden',
        border: `1px solid ${accent}`,
        background: 'radial-gradient(120% 90% at 30% 25%, rgba(29,78,216,.35), rgba(4,24,47,.9) 70%)',
      }}
    >
      <div style={{
        position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, opacity: 0.5,
        backgroundImage:
          'repeating-linear-gradient(0deg, rgba(95,176,255,.18) 0 1px, transparent 1px 14px),' +
          'repeating-linear-gradient(90deg, rgba(95,176,255,.18) 0 1px, transparent 1px 14px)',
      }} />
      <div style={{
        position: 'absolute', left: '22%', top: '30%', width: 10, height: 10, borderRadius: '50%',
        border: `1px solid ${accent}`, background: 'rgba(4,24,47,.85)',
      }} />
      <div style={{
        position: 'absolute', left: '52%', top: '56%', width: 34, height: 20,
        border: `1px dashed ${accent}`, borderRadius: 4, opacity: 0.85,
      }} />
    </div>
  )
}

export function SituationScreen({ state, flow, onGo }: {
  state: FlowState
  flow: UseFlow
  /** 切到另一屏（只改本地屏路由；流程步号归宿主）—— 需求专篇 SH-03 → SH-04 */
  onGo?: (id: string) => void
}) {
  const snap = useVerbOnce(flow, 'situation.snapshot', {}, true)
  const compose = useVerbOnce(flow, 'view.compose', {}, true)
  // 资源概况取**资源台账**（需求专篇 SH-03 的"数据来源"第三条）。
  // `alloc.inventory` 自己会在台账不存在时初始化（宿主 ensureLedger，幂等），所以步 3 也能读。
  const inv = useVerbOnce(flow, 'alloc.inventory', {}, true)
  // 工具可用性：一律以规则包 `view.compose` 的声明为准（VWC-TOOL-01/02）
  const mt = useMapToolState(flow)
  // 绘制模式（子菜单里"交给交互层拖画"那几项用）：map-2d 的交互状态
  const setDrawMode = useInteraction((s) => s.setMode)

  const sit = readSituation(snap.data)
  const cmp = readCompose(compose.data)
  const iv = readInventory(inv.data)

  const [notice, setNotice] = useState<string | null>(null)
  const [picked, setPicked] = useState<string | null>(null)

  // 当前场景：快照给了 `scenarioKey` 就按它高亮，否则默认场景一（图上高亮的就是场景一）
  const sceneKey = typeof (snap.data as Record<string, unknown> | null)?.scenarioKey === 'string'
    ? String((snap.data as Record<string, unknown>).scenarioKey)
    : ''
  const activeScene = picked ?? (SCENES.find((s) => s.id === sceneKey)?.id ?? SCENES[0].id)

  const onPickScene = (s: typeof SCENES[number]) => {
    if (!s.implemented) {
      // **不假装切过去**：本轮只实现场景一（个性化需求），场景二/三连屏都还没有
      setNotice(`「${s.no}：${s.name}」本轮未实现（个性化需求：流程先固定只实现场景一），界面未切换`)
      return
    }
    setPicked(s.id)
    setNotice(null)
    onGo?.('SH-04')
  }

  // ---- AI任务分析：图上三行等级 + 态势简述 + 建议方向 --------------------
  // 三行的取值**只认快照里的 analysis 段**（键/名里出现威胁/防御/干扰才算）；
  // 宿主目前没有这一段 → 三行都显示"—"并写明缺在哪（**不拿目标威胁去凑区域威胁等级**，
  // 那是业务判断，前端不做）。
  const byName = (re: RegExp) => sit.analysis.find((m) => re.test(m.key) || re.test(m.name))
  const levelText = (m?: Metric): string | undefined => {
    if (!m) return undefined
    if (m.status) return m.status
    if (m.value !== undefined) return n2s(m.value, m.unit ?? '')
    return m.text
  }
  const threatRow = byName(/威胁|threat/i)
  const defRow = byName(/防御|defen/i)
  const jamRow = byName(/干扰|jam|interfer/i)
  const adviceRow = byName(/建议|方向|advice|suggest/i)
  const analysisMissing = !threatRow && !defRow && !jamRow

  // ---- 任务信息：任务名称/任务类型/任务区域/任务时间/任务状态（图上 5 行，**无"时间要求"**）----
  const m = sit.mission
  const missionMissing: string[] = []
  if (!m?.name) missionMissing.push('任务名称')
  if (!m?.type) missionMissing.push('任务类型')
  if (!m?.region) missionMissing.push('任务区域')
  if (!m?.startAt) missionMissing.push('任务时间')
  if (!m?.status) missionMissing.push('任务状态')

  // ---- 资源概况：四型数量 + 集群可用 + 在线率 ---------------------------
  const invRows = sortByType(iv.rows)
  const online = iv.totals.find((t) => t.key === 'onlineRate')
  const clustersAvailable = sit.groups.length

  // 「场景」面板开合（用户第 3 条：点了工具栏的【场景】才显示）
  const [sceneOpen, setSceneOpen] = useState(false)
  /**
   * 2026-09-20 菜单窗口互斥：本屏打开了【场景】面板时，把它 +1，
   * 工具条据此关掉它那边的子菜单与图层面板（与工具条的 `onMenuOpened` 是一对）。
   */
  const [closeSignal, setCloseSignal] = useState(0)

  /** 选择模式：浏览（只拖地图）/ 编辑（点图元  高亮 + 拖拽编辑 + 吸附），默认浏览（见 pick-mode.ts） */
  const pickMode = usePickMode((s) => s.mode)
  const setPickMode = usePickMode((s) => s.setMode)

  /**
   * 本屏工具条：第一格是**两态的选择格**（浏览 / 编辑），其余是静态那几格；本屏一律常开。
   *
   * ★ 2026-09-21 新需求（原话）："浏览态，禁用新建，编辑态才启用新建"。
   *
   * **实现方式说明（第一版做错了，这里是更正后的）**：最初想借 `always: pickMode === 'edit'`
   * 让规则包去判灰 —— **走不通**：实测正在跑的宿主对 `view.compose` 的声明是
   * `create: enabled=true, state=available`（工具本身没问题，是**此刻的界面状态**不该用），
   * 于是 `always: false` 反而让它变成"可用"。所以改用 `MapToolSpec.disabled`（本屏点名的禁用位）。
   *
   * 范围：**只有【新建】这一格**跟着选择模式走；**【量算】等其余格子一个字不改**
   * （需求方点名："只【新建】，量算随时能用"）。
   */
  const SH03_TOOLS: MapToolSpec[] = useMemo(() => [
    {
      id: 'select', key: 'select', glyph: pickMode === 'browse' ? 'pan' : 'select',
      label: pickMode === 'browse' ? '浏览' : '编辑',
      local: true,     // 由本屏自己处理点击（切模式），工具条不碰绘制模式
    },
    ...SH03_ITEMS.map((t) => (t.key === 'create'
      // 浏览态：灰置 + 点不动，并在 title 里如实说明为什么
      ? { ...t, disabled: pickMode === 'browse', disabledReason: '浏览态不能新建，切到「编辑」再用' }
      : { ...t, always: true })),
  ], [pickMode])
  /**
   * **合并框**：标签 + 逐顶点经纬度（2026-09-21 需求）。
   *
   * 三种来源共用一个框：
   *   · `draw`  —— 刚画完的点 / 线 / 面（数据在模块的**草稿**里；确认才落图，取消 = 图上不留痕）；
   *   · `edit`  —— 编辑态点选了一个已有的几何原语图元（数据在图元里；取消 = 还原成改之前）。
   *
   * 为什么不把顶点存进本组件的 state：草稿的顶点**还要供地图预览用**（拖手柄也要写回它），
   * 存两份必然对不上。所以 `draw` 模式一律以模块草稿为唯一事实，本组件的 `points` 只在 `edit` 模式用。
   */
  const [editor, setEditor] = useState<EditorState | null>(null)
  /** 保存 / 取消的回执（"面至少 3 个顶点"这类拦住的话写这里） */
  const [editMsg, setEditMsg] = useState<string | null>(null)
  /**
   * 两个闸门 ref（2026-09-21 修"拖拽后确认还是原样"这条缺陷时加的，理由见下面那个 `MapDraw.on('change')`）：
   *   · `coordsFocused` —— 坐标输入框有没有焦点（有则不用模块的值回读，别冲掉正在打的字）；
   *   · `editorSyncing` —— 确认 / 取消正在进行中（那两步自己会写图元，回读会打架）。
   */
  const coordsFocused = useRef(false)
  const editorSyncing = useRef(false)
  /**
   * **"下一次点地图 = 落尺寸模式的中心点"**（2026-09-21）。
   *
   * 为什么用 ref 而不是 state：它只是"等一个点击"的标记，不参与渲染；
   * 点了【新建】里某个带尺寸的条目时置上，地图 `click` 回调读到就消费掉并弹框。
   */
  const pendingSizeBiz = useRef<string | null>(null)
  /**
   * 模块里的草稿（订阅它）：
   *   · 收笔产生草稿 → 宿主把框开起来；
   *   · 宿主 / 地图改草稿 → 框里的数字与图上的预览一起变（同一个来源）；
   *   · 确认 / 放弃后草稿置空 → 框自己收掉。
   */
  const draft = useGeometryDraft((s) => s.draft)
  /** ★ 2026-09-18「计划」的结果回执（打开成功/失败都写这里，不给假成功） */
  const [planMsg, setPlanMsg] = useState<string | null>(null)

  /**
   * **打开计划**：弹系统选文件框 → 读 JSON → 校验 → 画到图上（替换上一个计划）。
   *
   * 为什么用 `<input type="file">` 而不是后端上传：计划是本地文件，浏览器直读即可，
   * 不引入新的宿主接口（需求方只要求"我手动选择计划文件"）。
   */
  const openPlanFile = useCallback(async () => {
    try {
      // ★ 2026-09-18：改用带**默认目录**的系统对话框（File System Access API），
      //   不支持时 `pickPlanToOpen` 自己退回 `<input type=file>`。
      const picked = await pickPlanToOpen()
      if (!picked) return                       // 用户取消 → 什么都不做
      const { plan, error } = parsePlan(picked.text)
      if (error || !plan) { setPlanMsg(`计划读取失败：${error ?? '未知原因'}`); return }
      // 2026-09-20：打开计划**不听文件里的 view**，直接去"家视角"（第一个能定位的元素 + 比例尺 5 km；
      //   图上没有可定位元素时回配置默认位置）。口径见 plan-file.ts 的「家视角」段。
      const { drawn, failed } = applyPlan(plan, { applyFileView: false })
      const home = homeView()
      mapCommands.setView(home.lng, home.lat, home.zoom, 700)
      setPlanMsg(failed.length
        ? `已打开 ${picked.name}：画了 ${drawn} 个，${failed.length} 个有问题 —— ${failed.join('；')}`
        : `已打开 ${picked.name}：${plan.name ? `「${plan.name}」` : ''}画了 ${drawn} 个图元`)
    } catch (e) {
      setPlanMsg(`计划读取失败：${String((e as Error)?.message ?? e)}`)
    }
  }, [])

  /** **保存计划**：弹"另存为"对话框（默认文件名，可改）→ 存到所选/默认目录 */
  const savePlanFile = useCallback(async () => {
    const plan = serializePlan('态势计划')
    // ★ 修 bug：以前这里是 `plan.items.length`，而"手动标绘"的图元不在 items 里 →
    //   画了一堆却提示"没有可保存的计划图元"。现在数**整图快照**里的条数。
    const n = savableCount(plan)
    if (!n) { setPlanMsg('当前没有可保存的图元（先打开一份计划，或在地图上画点东西）'); return }
    try {
      // 默认文件名来自 /plan-config.json（换机器改配置即可），带日期便于区分
      const name = await pickPlanToSave(plan)
      if (!name) return                       // 用户取消
      setPlanMsg(`已保存 ${n} 个图元 → ${name}`)
    } catch (e) {
      setPlanMsg(`保存失败：${String((e as Error)?.message ?? e)}`)
    }
  }, [])

  /**
   * ★ 2026-09-18 配置兜底：`/plan-config.json` 里填了 `defaultPlanUrl` 就在进屏时自动打开它。
   * 留空（默认）= 空地图，由用户自己选计划 —— 需求方要的正是"进屏什么都没有画"。
   */
  useEffect(() => {
    let alive = true
    void (async () => {
      const cfg = await loadPlanConfig()
      if (!cfg.defaultPlanUrl || !alive) return
      try {
        const r = await fetch(cfg.defaultPlanUrl, { cache: 'no-cache' })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const { plan, error } = parsePlan(await r.text())
        if (error || !plan) throw new Error(error ?? '解析失败')
        // 同上（自动打开那条路也走"家视角"）
        const { drawn } = applyPlan(plan, { applyFileView: false })
        const home = homeView()
        mapCommands.setView(home.lng, home.lat, home.zoom, 700)
        if (alive) setPlanMsg(`按配置自动打开了 ${cfg.defaultPlanUrl}（${drawn} 个图元）`)
      } catch (e) {
        if (alive) setPlanMsg(`配置里的 defaultPlanUrl 打不开：${String((e as Error)?.message ?? e)}`)
      }
    })()
    return () => { alive = false }
  }, [])

  /**
   * ★ 2026-09-18 **规划航线**（需求方："使用 a* 算法，用界面上绘制的集结区与任务区算；
   *   都只有一个区域就直接算，有多个就让用户选是哪两个"）。
   *
   * 认区域靠**文本**：含「集结」/「任务」/「威胁」（画完可用"点文本改字"改名）。
   * 恰好各一个 → 直接算；否则弹选择框（见下面的 `routePick`）。
   */
  const [routePick, setRoutePick] = useState<{ assemblyId: string; taskId: string } | null>(null)

  /** 算并画，把结果如实写到回执条 */
  const runRoutePlan = useCallback((assemblyId: string, taskId: string) => {
    const r = planAndDrawRoute(assemblyId, taskId)
    setRoutePick(null)
    setPlanMsg(r.ok
      ? `已规划航线：${r.points} 个航路点、约 ${r.lengthKm?.toFixed(1)} km，绕开 ${r.avoided} 个威胁区，并画出 ${1000} m 宽航道`
      : `规划航线失败：${r.reason ?? '未知原因'}`)
  }, [])

  const startRoutePlan = useCallback(() => {
    const { assemblies, tasks, threats } = classifyAreas()
    if (!assemblies.length || !tasks.length) {
      setPlanMsg(`规划航线需要图上有「集结区」和「任务区」：现在集结区 ${assemblies.length} 个、任务区 ${tasks.length} 个`
        + `（区域图元的文本里分别要含「集结」「任务」；用"点文本改字"可改）`)
      return
    }
    // 恰好各一个 → 直接算（需求方："如果都只有一个区域，那就直接算"）
    if (assemblies.length === 1 && tasks.length === 1) {
      runRoutePlan(assemblies[0].id, tasks[0].id)
      return
    }
    // 多个 → 让用户选是哪两个（默认选第一个，减少点击）
    setRoutePick({
      assemblyId: assemblies[0].id,
      taskId: tasks[0].id,
    })
    setPlanMsg(`图上有 ${assemblies.length} 个集结区、${tasks.length} 个任务区，请选择要算哪两个`
      + `（会自动绕开 ${threats.length} 个威胁 / 禁飞区）`)
  }, [runRoutePlan])

  /**
   * **编辑态点图元 → 弹合并框**（用户第 2 条"点图元可改" + 2026-09-21"也是弹出合并框，不只是标题框"）。
   *
   * 走 map-2d 的图元命中回调 `MapDraw.on('click')`：
   *   · 浏览态：什么都不做（点图元不弹框）；
   *   · 编辑态：命中的若是**几何原语图元**（`GEOMETRY_KEYS` 认的种类）→ 弹合并框，
   *     顶点用模块的 `verticesOfId` 读（宿主不猜 id 落在哪一类、顶点存哪个字段）；
   *   · 军标 / 距离轴 / 无人机 / 航迹这些**非几何原语**：没有可编辑的顶点 → 不弹
   *     （本轮范围："放弃=还原"只对几何原语图元生效）。
   */
  useEffect(() => {
    const off = MapDraw.on('click', (e) => {
      if (pickModeNow() !== 'edit') return   // 浏览模式：点图元不弹编辑器（编辑模式才弹）
      const hit = findGeometry(e.id)
      if (!hit) return
      const kind = kindOfGeometry(hit.item)
      if (!kind) return                       // 不是几何原语（军标/无人机/航迹…）→ 不弹
      setEditMsg(null)
      setEditor({
        mode: 'edit',
        ref: `${hit.kind}:${e.id}`,
        kind,
        /**
         * **标签初值**（2026-09-21 修 bug："编辑模式点图元，弹窗没有使用标注名称，而是 id 号"）。
         *
         * 原先只读 `item.text` —— 但 `map-2d` 的**原生文字字段按种类不同**（`NATIVE_TEXT_FIELD`）：
         *   `label`(点) → `text`；**`area`(面)** / `route` / `shape` / `drone` / `target` / `scan` / `symbol` → **`label`**；
         *   `link` / `cluster` → `name`。
         * 而**尺寸模式画的矩形是宿主直接 `MapDraw.add('area', { label })`** 落的库 → 字在 `label` 字段、
         * `text` 是 undefined → 标签格子空白（手动那条路因为模块会把同一个字同时写进 `text` 与 `label`，
         * 所以早先没暴露）。这里改成与图层面板 `PrimitivePanel.nameOf()` **同一口径**：
         *   图元自己的文本（三种字段都试） → 模块绑定文本 → 业务目录名。
         */
        label: (() => {
          const own = [hit.item.text, hit.item.label, hit.item.name]
            .find((v): v is string => typeof v === 'string' && v.trim() !== '')
          return own ?? boundTextOf(e.id) ?? bizNameOf(e.id) ?? ''
        })(),
        points: editorPointsOf(e.id),
        snapshot: { id: e.id, kind: hit.kind, item: { ...hit.item }, text: boundTextOf(e.id) },
      })
    })
    return off
  }, [])

  /**
   * **图上改了图元 → 框里的坐标跟着刷新**（2026-09-21 修缺陷）。
   *
   * 背景（实测踩到的真缺陷）：编辑态拖拽（拖顶点 / 拖整块）走的是模块内部那条路 ——
   * `DrawLayer` 在拖动中**直接改图元**，所以图上实时看得到在动；但框里的 `editor.points`
   * 是**打开框那一刻**读到的一份副本，拖拽时没人刷新它 → 点【确定】时反倒用**旧坐标**
   * 覆盖掉刚拖出来的新坐标，表现就是"拖了、确认了，还是原样"。
   *
   * 修法：订阅 `MapDraw` 的 `'change'`（图元数据变更，含拖拽写入），把该图元的顶点**现读**回框里。
   *
   * 两条闸门（都必须有，否则会引入新毛病）：
   *   · **坐标输入框有焦点时不回读** —— 否则你正在框里打的字会被模块的值冲掉；
   *   · **确认 / 取消的过程中不回读** —— 那两个动作自己会关框、也会写图元，
   *     让它在半途把框里的值改掉会打架。
   */
  useEffect(() => {
    const off = MapDraw.on('change', (e) => {
      if (editorSyncing.current) return
      if (coordsFocused.current) return
      setEditor((cur) => {
        if (!cur || cur.mode !== 'edit' || e.id !== cur.snapshot.id) return cur
        const pts = editorPointsOf(cur.snapshot.id)
        if (!pts.length || samePoints(pts, cur.points)) return cur      // 没变就不重渲染（拖拽每秒会来几十次）
        return { ...cur, points: pts }
      })
    })
    return off
  }, [])

  /**
   * **中心点落点 → 把尺寸表单开起来**（2026-09-21 需求："指定尺寸模式"）。
   *
   * 与"手动模式"的区别只在**收笔之后**：手动模式产生的是**草稿**（要确认才落图），
   * 尺寸模式产生的是**一张待填的表单**（确定时才按填的数造图元）。
   * 两条路的**弹框与确定/取消/Esc 习惯完全一致**，所以都挂在同一个 `editor` 状态上。
   *
   * ⚠️ **不能用 `MapDraw.on('click')` 接这一下点击**（2026-09-21 实测踩到："新建任务区长宽，
   *   点击地图无效"）：模块那条事件是**图元命中事件** —— `primitiveEvents.ts` 里写着
   *   "空白处点击不触发"（`if (!hit) return`）。而尺寸模式要点的恰恰是**空地上的中心点**，
   *   所以回调永远不来。改用**地图原始点击** `map.on('click')`（空地也发），这是唯一正确的入口。
   */
  useEffect(() => {
    const map = mapInstance.current
    if (!map) return                                   // 地图还没就绪：本屏在地图就绪后重渲染，下一次会接上
    const onClick = (e: { lngLat: { lng: number; lat: number } }) => {
      const bizKey = pendingSizeBiz.current
      if (!bizKey) return                              // 没在等中心点 → 这一下点击不关我事
      pendingSizeBiz.current = null
      const entry = bizEntry(bizKey)
      if (!entry?.size) return
      setEditMsg(null)
      setEditor({
        mode: 'size',
        bizKey,
        title: entry.label,
        spec: entry.size,
        center: [e.lngLat.lng, e.lngLat.lat],
        label: entry.size.defaultLabel,
        values: Object.fromEntries(entry.size.fields.map((f) => [f.key, String(f.def)])),
      })
    }
    map.on('click', onClick as never)
    return () => { map.off('click', onClick as never) }
  })

  /**
   * **尺寸模式的实时预览**（2026-09-21 需求："需要预览，默认宽度也能预览"）。
   *
   * 效果：**弹框那一刻就按默认值画出来**；改中心 / 改长宽 / 改半径 / 改行列 → 图上立刻跟着变。
   * 通道：模块的 `useShapePreview`（**虚线青色**，与几何草稿同一套预览图层；**不进图元集合** ——
   * 所以确定前它只是预览，不进图层面板、不参与导出）。
   *
   * 三条口径：
   *   · 用**同一份 `SizeSpec`** 驱动预览与确定（`sizeSpecOf`），保证"预览一个样、落图另一个样"不会发生；
   *   · 数字不合法时就**不预览**（框里会给回执），而不是画一个错的形状；
   *   · **确定 / 取消都会清掉预览** —— 确定时由 `confirmEditor` 先清再落图，取消时随框一起消失。
   */
  useEffect(() => {
    if (editor?.mode !== 'size') return
    const parsed = sizeSpecOf(editor)
    if ('error' in parsed) { useShapePreview.getState().clear(); return }
    showShapePreview(editor.bizKey, parsed.spec)
    return () => { useShapePreview.getState().clear() }
    // `editor` 是整体替换的对象 → 中心/尺寸/标签任一处改动都会进来；依赖它一个就够
  }, [editor])

  /**
   * **收笔产生草稿 → 把框开起来**（2026-09-21）。
   *
   * 不订阅 `setGeometry` 的 `onDone` 而订阅草稿本身，是因为草稿才是**唯一事实**：
   * 它由模块在收笔时建立，宿主、地图两边都改它；这里只负责"有草稿就开框、草稿没了就收框"。
   */
  const draftRef = useRef<GeometryDraft | null>(null)
  useEffect(() => {
    const prev = draftRef.current
    draftRef.current = draft
    if (draft && !prev) {
      setEditMsg(null)
      setEditor({ mode: 'draw', kind: draft.kind, label: draft.label, points: draft.points })
      return
    }
    if (!draft && prev) {
      // 草稿被清掉（确认 / 放弃都走这条）→ 框跟着收，别让它挂在那儿
      setEditor((cur) => (cur && cur.mode === 'draw' ? null : cur))
    }
  }, [draft])

  /**
   * ★ 2026-09-18（需求方："无人机仿真一直开着的？让无人机动起来"）：
   * **进态势屏就自动启动仿真**（`sim.start`，1 倍速）。
   *
   * 仿真不是常开的：它由 `sim.start` / `sim.pause` 驱动（按钮在"链路/执行"屏上），
   * 不启动时遥测只是一张静止的快照 —— 所以在态势屏上看着"无人机不动"。
   * 这里只发一次；已经在跑时再发 `sim.start` 是幂等的（引擎侧就是"启动/继续"）。
   */
  useEffect(() => {
    void flow.send('sim.start', {})
    void flow.send('sim.speed', { speed: 1 })
    // 只在进入本屏时发一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------------- 合并框的动作：确定 / 取消（Esc 同效） ----------------

  /**
   * **确定**（需求："点击确认后绘制"）。
   *
   * 两条来源各自的落点：
   *   · `draw`（新画的）→ 校验顶点数 → `commit()`：**这一刻才写进图元集合**，草稿随即清空；
   *   · `edit`（改已有的）→ 校验顶点数 → 把顶点写回图元、标签写回绑定文本 → 收手柄。
   * 顶点不够时**不静默**：把"面至少 3 个顶点"写进回执条，框继续开着（需求方定的口径：
   * "【确定】仍可点，点了拦住并提示"）。
   */
  const confirmEditor = () => {
    if (!editor) return
    // ---- 指定尺寸模式：按填的数直接造图元（不走草稿、不进编辑态）----
    if (editor.mode === 'size') {
      const err = submitSizeEditor(editor)
      if (err) { setEditMsg(err); return }   // 被拦住 → 框继续开着、**预览也留着**（用户接着改）
      useShapePreview.getState().clear()     // 落库成功 → 清掉虚线预览（此时图上已是正式图元）
      setEditMsg(null)
      setEditor(null)
      return
    }
    // 非尺寸模式：先校验顶点数（`editor` 此时已只可能是 draw / edit）
    if (editor.mode === 'draw') {
      const err = pointsError(editor.kind, draft?.points ?? editor.points)
      if (err) { setEditMsg(err); return }
    } else {
      const err = pointsError(editor.kind, editor.points)
      if (err) { setEditMsg(err); return }
    }
    // 确认过程中关掉"从图元回读"（本函数自己会写图元，回读会跟它抢）
    editorSyncing.current = true

    if (editor.mode === 'draw' && draft) {
      // 标签先写回草稿（框里可能改过），再提交
      useGeometryDraft.getState().setLabel(editor.label)
      const id = useGeometryDraft.getState().commit()
      if (!id) { setEditMsg('落图失败：顶点数不合法或图元没造出来'); editorSyncing.current = false; return }
      setBoundStyle(id, BOUND_TEXT_STYLE)
      setEditMsg(null)
      setEditor(null)
      editorSyncing.current = false
      return
    }

    if (editor.mode === 'edit') {
      if (!writeEditorPoints(editor.snapshot.id, editor.kind, editor.points)) { setEditMsg('写回顶点失败（图元已不在图上）'); editorSyncing.current = false; return }
      setBoundText(editor.snapshot.id, editor.label)
      setBoundStyle(editor.snapshot.id, BOUND_TEXT_STYLE)
      // 收尾两件事（缺一不可）：
      //   · `finishEdit()`  → 结束编辑会话（顶点手柄收起）
      //   · `clearSelection()` → **清掉选中态**。虚线高亮是**选中态**画的，而选中与编辑会话
      //     是模块里两件独立的事：只 `finishEdit()` 的话，那圈虚线会一直留着，
      //     直到用户点一下地图空白处才消失（2026-09-21 实测踩到："拖动点击确认后，虚线还在"）。
      mapCommands.finishEdit()
      mapCommands.clearSelection()
      setEditMsg(null)
      setEditor(null)
      editorSyncing.current = false
    }
  }

  /**
   * **取消 / Esc**（需求："取消加回来，并且 esc 也加放弃绘制"）。
   *
   * 两种语义**不一样**（需求方点名"两条都要"）：
   *   · 新画的（`draw`）→ `discard()`：撤掉草稿，**图上什么都不留**；
   *   · 改已有的（`edit`）→ 用快照**还原成改之前的样子**（图元留着，不是删掉）。
   */
  const cancelEditor = () => {
    if (!editor) return
    // 尺寸模式还没造过任何图元 → 取消就是"什么都不做"（没有草稿要撤、没有选中要清）
    if (editor.mode === 'size') {
      useShapePreview.getState().clear()     // 预览随框一起消失（图上不留痕）
      setEditMsg(null)
      setEditor(null)
      return
    }
    editorSyncing.current = true
    if (editor.mode === 'draw') {
      useGeometryDraft.getState().discard()
    } else {
      const s = editor.snapshot
      MapDraw.add(s.kind as never, s.item as never)          // 顶点 / 其它字段恢复原样
      // 只还原**原来就有的**绑定文本（放弃编辑不新增文本、也不删文本 —— 本轮不含"删标签"）
      if (s.text !== null) setBoundText(s.id, s.text)
      // 与【确定】同一套收尾：结束编辑会话 + 清选中态（否则那圈虚线会留在图上）
      mapCommands.finishEdit()
      mapCommands.clearSelection()
    }
    setEditMsg(null)
    setEditor(null)
    editorSyncing.current = false
  }

  return (
    <>
      {/* 底图不在这里：2026-09-18 起地图由 App 的 MapLayer 统一渲染（所有屏共用一张，清屏才做得干净） */}

      {/* ---------------- 左上：地图浮动工具栏 ----------------
           上一版这一排是**只读的 `<span>` 摆设**（点了没反应），而 map-2d 里量算/手绘/
           图层面板/清屏/全屏**早就实现了**。现在统一走 `shell/MapTools`（真能点）。
           2026-09-19 起本屏键位 = 用户合并后的版式：
           选择 / 新建（点 / 线 / 面 / 标绘，两级）/ 量算（测距 / 测面）/ 场景 / 计划 / 图层 / 视图（全屏 / 清屏 / 复位）；
           本屏**一律不灰**（用户点名要求）；其他屏仍按规则包 `view.compose` 如实灰置。 ---------------- */}
      <MapToolbar
        testid="sh03-toolbar"
        items={SH03_TOOLS}
        state={mt}
        style={{ left: 12, top: 5 }}
        onLocal={(k) => {
          // 2026-09-20 需求：选择 = 两态（浏览 / 编辑） 点一下切换，并把绘制/编辑/选中都收干净
          if (k === 'select') {
            pendingSizeBiz.current = null     // 收掉"等中心点"的标记（2026-09-21：否则下次点地图会莫名弹尺寸框）
            mapCommands.cancelInteraction()
            mapCommands.finishEdit()
            mapCommands.clearSelection()
            setPickMode(pickMode === 'browse' ? 'edit' : 'browse')
            return
          }
          if (k === 'scene') {
            // 2026-09-20 菜单窗口互斥：打开【场景】时，顺手把工具条那边的子菜单 / 图层面板收掉
            const next = !sceneOpen
            setSceneOpen(next)
            if (next) setCloseSignal((n) => n + 1)
            return
          }
          // ★ 2026-09-18「计划」子菜单（需求方："打开计划、保存计划，先做打开计划"）
          if (k === 'plan-open') { void openPlanFile(); return }
          if (k === 'plan-save') { savePlanFile(); return }
          // ★「规划航线」：只有一个集结区 + 一个任务区时**直接算**；有多个才弹选择框
          if (k === 'plan-route') { startRoutePlan(); return }
          // ---------------- 子菜单选中的业务图元 ----------------
          // ★ 业务层改造后：宿主只把「借哪种几何交互 + 预设样式 + 业务名字」交给模块，**一次调用**；
          //   落点/两下/多点、预览、收笔、挂文本框全在 map-2d 里。
          //   不是几何原语的业务物件（军标/距离环/扫描扇区…）走 `make` 钩子：
          //   交互仍在模块，造什么由业务目录 `biz-catalog.ts` 决定。
          const e = bizEntry(k)
          if (!e) return
          // ★ 2026-09-21 新需求："两种模式"。同一批条目里，带 `size` 的走**指定尺寸模式**：
          //   不进入鼠标绘制，只挂一个"等中心点"的标记 —— 用户在地图上点一下，
          //   上面的 click 回调就把**尺寸表单**开起来（填长宽 / 半径 / 每格长度 + 名称 → 确定画出）。
          if (e.size) {
            useGeometryDraft.getState().discard()      // 顺手把上一份草稿丢掉（避免两种模式的预览打架）
            mapCommands.cancelInteraction()
            pendingSizeBiz.current = e.key
            setPlanMsg(`「${e.label}」：在地图上点一下作为中心点（会自动弹出尺寸输入框）`)
            return
          }
          pendingSizeBiz.current = null
          setDrawMode('none')   // 关掉老的 mode，避免两套交互打架
          // ★ 2026-09-21：起一次新绘制前，先把**上一份草稿**丢掉 —— 否则会出现
          //   "老草稿的预览 + 新绘制的预览"两份预览叠在图上（都是预览图层，肉眼分不清谁是谁）。
          //   这是有意的取舍：草稿不落图，丢掉不留痕（用户没有"同时画两个"的需求）。
          useGeometryDraft.getState().discard()
          mapCommands.setGeometry({
            key: e.start.geo,
            color: e.start.color,
            widthPx: e.start.widthPx,
            sizePx: e.start.sizePx,
            dashed: e.start.dashed,
            fillColor: e.start.fillColor,
            fillOpacity: e.start.fillOpacity,
            make: e.start.make,
            text: e.label,            // 默认就把业务名挂上，用户随后可改
            textStyle: BOUND_TEXT_STYLE,
            // ★ 2026-09-21：**不再用 `onDone` 弹框**。模块收笔时改为产生一份**草稿**
            //   （`useGeometryDraft`），上面的订阅负责把合并框开起来 —— 这样"框里的数字"与
            //   "图上的预览"共用同一份数据；`onDone` 也就不需要了（模块提交时才真正落图）。
          })
        }}
        // 2026-09-20 需求：浏览 / 编辑**两个状态都高亮**（它永远是"当前工具"，换的只是图标与文字）
        activeKeys={{ scene: sceneOpen, select: true }}
        // 菜单窗口互斥（2026-09-20）：工具条打开任一菜单/面板  本屏把自己的【场景】面板收掉
        onMenuOpened={() => setSceneOpen(false)}
        closeSignal={closeSignal}
      />
      <ToolModeNote state={mt} items={SH03_TOOLS} style={{ left: 12, top: 46 }} />

      {/* ---------------- 合并框：标签 + 逐顶点经纬度（2026-09-21 需求） ----------------
          两个入口共用一个框：**画完自动弹**（点/线/面收笔）、**编辑态点选图元也弹**。

          变更轨迹（都是需求方逐轮点名的，别当历史包袱删掉）：
            · 2026-09-17/18：先做"画完给个输入框"；
            · 2026-09-21 ①："所有的标签编辑框，都删除选标签样式" → 样式选择器整块删掉；
            · 2026-09-21 ②："弹出标签框，隐藏取消按钮" → 那时去掉了【取消】与 Esc；
            · 2026-09-21 ③（本条）："绘制完成后…弹出经纬度编辑框，合并为一起，点击确认后绘制"
              + "取消加回来，并且 esc 也加放弃绘制" → 【取消】回来、Esc 回来、坐标进框、
              逐顶点一行、加行/删行、实时联动、顶点到下限拦住确认。
          事实来源：`draw` 模式读模块的**草稿**（`useGeometryDraft`），`edit` 模式读本组件的
          `editor.points`；两边的每次改动都会写回同一份数据，所以"框里的数字"与"图上的形状"不会分叉。 */}
      {editor && (
        <GeometryEditor
          editor={editor}
          draft={draft}
          message={editMsg}
          onLabel={(v) => {
            if (editor.mode === 'draw') useGeometryDraft.getState().setLabel(v)
            setEditor({ ...editor, label: v })
          }}
          onSizeValue={(key, raw) => {
            // 尺寸模式：只改框里的文本；**合法性在"确定"时统一校验**（允许打到一半，如 `1.`）
            if (editor.mode !== 'size') return
            setEditor({ ...editor, values: { ...editor.values, [key]: raw } })
          }}
          onCenter={(axis, raw) => {
            // 中心点手改（2026-09-21）：合法就**立刻写进 `center`** —— 图上的虚线预览随即跟着平移；
            // 不合法只留文本、不动 `center`（并给回执），这样"预览的画的就是将要落库的位置"。
            if (editor.mode !== 'size') return
            const key = axis === 'lng' ? 'centerLng' : 'centerLat'
            const v = parseCoord(raw, axis)
            if (v === null) {
              setEditMsg(axis === 'lng' ? '经度要是 -180 ~ 180 的数字' : '纬度要是 -90 ~ 90 的数字')
              setEditor({ ...editor, values: { ...editor.values, [key]: raw } })
              return
            }
            setEditMsg(null)
            const center: LngLat = axis === 'lng' ? [v, editor.center[1]] : [editor.center[0], v]
            setEditor({ ...editor, center, values: { ...editor.values, [key]: raw } })
          }}
          // 坐标输入框的焦点 → 决定"图元变更要不要回读到框里"（有焦点就别回读，会冲掉正在打的字）
          onCoordsFocus={(f) => { coordsFocused.current = f }}
          onPoint={(i, axis, raw) => {
            const v = parseCoord(raw, axis)
            if (v === null) { setEditMsg(axis === 'lng' ? '经度要是 -180 ~ 180 的数字' : '纬度要是 -90 ~ 90 的数字'); return }
            setEditMsg(null)
            // 三态收窄：这里只在"手绘草稿 / 编辑已有图元"两种形态下有意义（尺寸模式没有顶点表）
            if (editor.mode === 'draw') {
              const d = draft
              if (!d) return
              const pts = d.points.map((p, j) => (j === i ? ([axis === 'lng' ? v : p[0], axis === 'lat' ? v : p[1]] as LngLat) : p))
              useGeometryDraft.getState().setPoints(pts)      // 图上预览实时跟着变
            } else if (editor.mode === 'edit') {
              const E = editor
              const pts = E.points.map((p, j) => (j === i ? ([axis === 'lng' ? v : p[0], axis === 'lat' ? v : p[1]] as LngLat) : p))
              setEditor({ ...E, points: pts })
              writeEditorPoints(E.snapshot.id, E.kind, pts)   // 已存在的图元：直接写回，实时可见
            }
          }}
          onAddRow={() => {
            if (editor.mode === 'draw') {
              useGeometryDraft.getState().addRow()             // 默认坐标 = 复制最后一个顶点（模块里定）
              return
            }
            if (editor.mode !== 'edit') return
            const E = editor
            const last = E.points[E.points.length - 1] ?? [0, 0]
            const pts = [...E.points, [last[0], last[1]] as LngLat]
            setEditor({ ...E, points: pts })
            writeEditorPoints(E.snapshot.id, E.kind, pts)   // 加行也实时写回
          }}
          onRemoveRow={(i) => {
            if (editor.mode === 'draw') {
              useGeometryDraft.getState().removeRow(i)
              return
            }
            if (editor.mode !== 'edit') return
            const E = editor
            if (E.points.length <= minOfKind(E.kind)) return   // 到下限：按钮已经灰了，这里兜底
            const pts = E.points.filter((_, j) => j !== i)
            setEditor({ ...E, points: pts })
            writeEditorPoints(E.snapshot.id, E.kind, pts)   // 删行也实时写回
          }}
          onConfirm={confirmEditor}
          onCancel={cancelEditor}
        />
      )}

      {/* ---------------- 显示模式：**独立的下拉框**（不在工具条那一排里） ----------------
          用户 2026-09-18 第 8 条："显示模式：综合态势，应该单独是一个下拉框，而不是和功能一起"。
          候选清单来自宿主 `view.compose` 的 `modes[]`（宿主从引擎 availableModes() 补出来的，
          前端**不自己编一份模式清单**）；选中即发 `view.mode{modeKey}`。
          拿不到清单时退化成"只有当前这一档"的只读展示，并如实标注原因。 */}
      <div style={displayModeBox}>
        <span style={{ fontSize: 12, color: C.textDim, flex: '0 0 auto' }}>显示模式</span>
        {cmp.modes.length > 0 ? (
          <select
            data-testid="sh03-display-mode"
            value={cmp.modeKey ?? ''}
            onChange={(e) => void flow.send('view.mode', { modeKey: e.target.value })}
            title="显示模式（视图声明由规则包给出；切档即发 view.mode）"
            style={displayModeSelect}
          >
            {cmp.modes.map((m) => <option key={m.key} value={m.key}>{m.name || m.key}</option>)}
          </select>
        ) : (
          <span
            data-testid="sh03-display-mode"
            title="宿主没有给出可选显示模式清单（view.compose.modes 为空），这里只如实显示当前档"
            style={{ fontSize: 12.5, color: C.accent }}
          >{cmp.modeName ?? cmp.modeKey ?? '—'}（清单未提供）</span>
        )}
      </div>

      {/* ★ 2026-09-18（需求方："这个删除，不需要显示"）：原来这里浮着一个
          「视图声明（view.compose）」折叠块（图层组/控件/工具可用性/快照出处）。
          产品界面上不需要它 —— 已整块移除。
          注意：**`compose` 这条 verb 仍然照发**（工具栏的可用性、显示模式清单都靠它，
          见上面 `useVerbOnce(flow, 'view.compose')`），只是不再把结果显示成一块浮层。 */}

      {/* ---------------- 右栏：AI任务分析 / 任务信息 / 资源概况 ---------------- */}
      <div style={rightColStyle} data-ma-noscrollbar="1">
        <Section
          title="AI任务分析"
          testid="analysis-panel"
          extra={analysisMissing ? '引擎未给出' : undefined}
        >
          <KV k="当前区域威胁等级" v={levelText(threatRow)} color={threatRow ? threatColor(threatRow.status) : C.textDim} />
          <KV k="敌方防御强度" v={levelText(defRow)} color={defRow ? threatColor(defRow.status) : C.textDim} />
          <KV k="通信干扰强度" v={levelText(jamRow)} color={jamRow ? threatColor(jamRow.status) : C.textDim} />
          {analysisMissing && (
            <Missing text="situation.snapshot 没有 analysis 段：以上三项引擎未给出该指标（前端不拼一个等级出来）" />
          )}

          <div style={{ marginTop: 6, borderTop: `1px solid ${C.border}`, paddingTop: 5 }}>
            <div style={{ fontSize: 11.5, color: C.textDim, marginBottom: 2 }}>态势简述</div>
            {sit.notes.length > 0
              ? sit.notes.slice(0, 4).map((t, i) => (
                <div key={i} style={{ fontSize: 11.5, color: C.text, lineHeight: 1.65 }}>· {t}</div>
              ))
              : <div style={{ fontSize: 11.5, color: C.textDim }}>—（快照未给出 notes/态势简述）</div>}
            {sit.notes.length > 0 && (
              <div style={{ fontSize: 10.5, color: C.textDim, marginTop: 2 }}>来源：situation.snapshot.notes[]（宿主原话）</div>
            )}
          </div>

          <div style={{ marginTop: 6, borderTop: `1px solid ${C.border}`, paddingTop: 5 }}>
            <div style={{ fontSize: 11.5, color: C.textDim, marginBottom: 2 }}>建议方向</div>
            <div style={{ fontSize: 11.5, color: adviceRow ? C.text : C.textDim, lineHeight: 1.65 }}>
              {levelText(adviceRow) ?? '—'}
            </div>
            {!adviceRow && <Missing text="situation.snapshot 未给出「建议方向」字段（引擎未给出该指标）" />}
          </div>

          {/* 目标威胁等级：**这是快照真有的字段**（targets[].threat），所以另起一块如实列出，
              而不是拿它去顶上面那三行区域级等级。 */}
          {sit.targets.some((t) => t.status) && (
            <div style={{ marginTop: 6, borderTop: `1px solid ${C.border}`, paddingTop: 5 }}>
              <div style={{ fontSize: 11.5, color: C.textDim, marginBottom: 2 }}>
                目标威胁等级（situation.snapshot.targets[].threat）
              </div>
              {sit.targets.map((t) => (
                <div key={t.key} style={{ display: 'flex', gap: 8, fontSize: 12, padding: '2px 0' }}>
                  <span style={{ flex: 1, minWidth: 0, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.name}
                  </span>
                  {t.text && <span style={{ color: C.textDim }}>{t.text}</span>}
                  <span style={{ color: threatColor(t.status), width: 34, textAlign: 'right' }}>{t.status ?? '—'}</span>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="任务信息" testid="mission-panel">
          <KV k="任务名称" v={m?.name} />
          <KV k="任务类型" v={m?.type} />
          <KV k="任务区域" v={m?.region} />
          <KV k="任务时间" v={m?.startAt} />
          <KV k="任务状态" v={m?.status} />
          {missionMissing.length > 0 && (
            <Missing text={`缺失字段：${missionMissing.join('、')}（situation.snapshot.mission 未给出）`} />
          )}
        </Section>

        <Section
          title="资源概况"
          testid="resource-panel"
          extra={inv.reply && inv.reply.code !== 0 ? '台账未就绪' : undefined}
        >
          {invRows.length > 0 ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
              {invRows.slice(0, 4).map((r) => (
                <div key={r.key} data-testid="sh03-res-cell" title={`${r.name}（alloc.inventory.items[].type=${r.key}）`}
                  style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: '5px 6px', textAlign: 'center' }}>
                  <div style={{ fontSize: 11, color: C.textDim }}>{uavTypeCN(r.key)}</div>
                  <div style={{ fontSize: 17, color: C.accent, fontVariantNumeric: 'tabular-nums' }}>{n2s(r.total)}</div>
                  <div style={{ fontSize: 10.5, color: C.textDim }}>可用 {n2s(r.available)}</div>
                </div>
              ))}
            </div>
          ) : (
            <Missing text={
              inv.sent && inv.reply && inv.reply.code !== 0
                ? `四型数量未就绪：alloc.inventory → ${replyText(inv.reply)}`
                : '四型数量读取中…（alloc.inventory）'
            } />
          )}

          <div style={{ marginTop: 6, borderTop: `1px solid ${C.border}`, paddingTop: 4 }}>
            <MetricRow m={{ key: 'clusters', name: '集群可用', value: clustersAvailable, unit: '个' }} />
            <MetricRow m={online ?? { key: 'onlineRate', name: '在线率' }} />
          </div>
          <div style={{ fontSize: 10.5, color: C.textDim, lineHeight: 1.6, marginTop: 3 }}>
            四型数量/在线率 ← alloc.inventory；集群可用 ← situation.snapshot.groups[]（{clustersAvailable} 条）
          </div>
        </Section>

        {/* 回执：宿主未实现时**原样**说清楚 */}
        <VerbVerdict
          rows={[
            { verb: 'situation.snapshot', reply: snap.reply, busy: snap.busy, onRetry: snap.resend, okNote: `${sit.areas.length} 区域 / ${sit.targets.length} 目标` },
            { verb: 'view.compose', reply: compose.reply, busy: compose.busy, onRetry: compose.resend, okNote: `${cmp.visibleGroups.length} 图层组` },
            { verb: 'alloc.inventory', reply: inv.reply, busy: inv.busy, onRetry: inv.resend, okNote: `${iv.rows.length} 型` },
          ]}
        />
      </div>

      {/* ---------------- 场景二/三的提示（可关闭；不遮地图关键区）---------------- */}
      {notice && (
        <div data-testid="sh03-scene-notice" style={noticeStyle} onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}

      {/* ★ 2026-09-18「计划」结果回执：打开成功/失败都如实显示，点一下关掉 */}
      {planMsg && (
        <div data-testid="sh03-plan-msg" style={planMsgStyle} onClick={() => setPlanMsg(null)}>
          📄 {planMsg}
        </div>
      )}

      {/* ★ 2026-09-18 规划航线：图上有多个集结区/任务区时，让用户选是哪两个 */}
      {routePick && (() => {
        const { assemblies, tasks, threats } = classifyAreas()
        const opts = (list: { id: string; text: string }[]) =>
          list.map((a) => <option key={a.id} value={a.id}>{a.text || a.id}</option>)
        return (
          <div data-testid="sh03-route-pick" style={routePickStyle}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>规划航线：选择起终点区域</div>
            <label style={routePickRow}>
              <span style={{ color: C.textDim, width: 62 }}>集结区</span>
              <select
                data-testid="route-pick-assembly"
                value={routePick.assemblyId}
                onChange={(e) => setRoutePick({ ...routePick, assemblyId: e.target.value })}
                style={routeSelectStyle}
              >{opts(assemblies)}</select>
            </label>
            <label style={routePickRow}>
              <span style={{ color: C.textDim, width: 62 }}>任务区</span>
              <select
                data-testid="route-pick-task"
                value={routePick.taskId}
                onChange={(e) => setRoutePick({ ...routePick, taskId: e.target.value })}
                style={routeSelectStyle}
              >{opts(tasks)}</select>
            </label>
            <div style={{ fontSize: 11.5, color: C.textDim, margin: '4px 0 8px' }}>
              自动绕开 {threats.length} 个「威胁 / 禁飞」区域；算出来会画<b>规划航线</b>与 <b>1000 m 宽航道</b>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                data-testid="route-pick-ok"
                onClick={() => runRoutePlan(routePick.assemblyId, routePick.taskId)}
                style={deleteYesStyleInApp}
              >计算并画出</button>
              <button data-testid="route-pick-cancel" onClick={() => setRoutePick(null)} style={deleteNoStyleInApp}>取消</button>
            </div>
          </div>
        )
      })()}

      {/* ---------------- 「请选择任务场景」：**点了工具栏的【场景】才弹** ----------------
           用户 2026-09-18 第 3 条："选择场景功能，添加到上方工具栏中，点击后才显示"。
           原来它常驻屏幕底部（一直占 152px 高）；现在收进工具条，弹在工具条正下方，
           不点就不占地方 —— 地图也因此多出 152px 可视高度。 ---------------- */}
      {sceneOpen && (
      <div style={{ position: 'absolute', left: 12, right: 292, top: 46, height: 152, zIndex: 22 }}>
        <div style={{ ...panel, flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={panelTitle}>
            请选择任务场景
            <span style={{ float: 'right', fontSize: 11, color: C.textDim }}>
              底图为二维瓦片（图上是三维地形）
            </span>
          </div>
          <div style={{ display: 'flex', gap: 10, padding: 9, flex: 1, minHeight: 0 }}>
            {SCENES.map((s) => {
              const on = s.id === activeScene
              return (
                <button
                  key={s.id}
                  data-testid="sh03-scene-card"
                  data-scene={s.id}
                  data-scene-selected={on ? '1' : '0'}
                  data-scene-implemented={s.implemented ? '1' : '0'}
                  onClick={() => onPickScene(s)}
                  title={s.implemented
                    ? `选中场景并进入场景确认（SH-04）`
                    : `本轮未实现（个性化需求：先固定只实现场景一）——点击只给提示，不切换`}
                  style={{
                    flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5, cursor: 'pointer',
                    textAlign: 'left', borderRadius: 8, padding: 8,
                    border: `1px solid ${on ? s.accent : C.border}`,
                    background: on ? 'rgba(29,78,216,.18)' : 'rgba(10,32,58,.55)',
                    boxShadow: on ? `0 0 0 1px ${s.accent} inset` : undefined,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 12.5, color: on ? C.text : C.accentDim, flex: 1, minWidth: 0 }}>
                      {s.no}：{s.name}
                    </span>
                    {!s.implemented && <span style={notImplChip}>未实现</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flex: 1, minHeight: 0 }}>
                    <MiniMapThumb accent={s.accent} />
                    <span style={{
                      alignSelf: 'center', flex: '0 0 auto', width: 30, height: 30, borderRadius: '50%',
                      border: `1px solid ${s.accent}`, background: 'rgba(4,24,47,.8)', color: '#eaf4ff',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12,
                    }}>▶</span>
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      </div>
      )}

      <SituationProbe
        situationRaw={snap.data}
        composeRaw={compose.data}
        inventoryRaw={inv.data}
        snapshotReply={snap.reply}
        composeReply={compose.reply}
        areas={sit.areas.length}
        targets={sit.targets.length}
        groups={sit.groups.length}
        scenes={SCENES.length}
        analysisRows={[threatRow, defRow, jamRow].filter(Boolean).length}
      />
    </>
  )
}

/** 自证句柄 `window.__p3Stats`（SH-03 的部分）。 */
function SituationProbe({ situationRaw, composeRaw, inventoryRaw, snapshotReply, composeReply, areas, targets, groups, scenes, analysisRows }: {
  situationRaw: unknown
  composeRaw: unknown
  inventoryRaw: unknown
  snapshotReply: { code: number; error?: { message?: string } } | null
  composeReply: { code: number; error?: { message?: string } } | null
  areas: number
  targets: number
  groups: number
  scenes: number
  analysisRows: number
}) {
  const w = window as unknown as { __p3Stats?: Record<string, unknown> }
  w.__p3Stats = {
    ...(w.__p3Stats ?? {}),
    step: 3,
    screen: 'situation',
    situation: { reply: snapshotReply, data: situationRaw ?? null, counts: { areas, targets, groups } },
    compose: { reply: composeReply, data: composeRaw ?? null },
    inventory: { data: inventoryRaw ?? null },
    dom: {
      sceneCards: document.querySelectorAll('[data-testid="sh03-scene-card"]').length,
      scenes,
      analysisRows,
      analysisPanel: !!document.querySelector('[data-testid="analysis-panel"]'),
      missionPanel: !!document.querySelector('[data-testid="mission-panel"]'),
      resourcePanel: !!document.querySelector('[data-testid="resource-panel"]'),
      composePanel: !!document.querySelector('[data-testid="compose-panel"]'),
      displayMode: !!(document.querySelector('[data-testid="sh03-display-mode"]')?.textContent ?? '').trim(),
      metricRows: document.querySelectorAll('[data-testid="metric-row"]').length,
      // **图上没有这颗按钮**（它属于 SH-04）：这里如实记为 false，供脚本反向断言
      hasConfirmScene: !!document.querySelector('[data-testid="btn-confirm-scene"]'),
    },
  }
  return null
}

// ---- 样式（一律 left/right/bottom 长写：**不写 inset 简写**，见 App.tsx 的踩坑注释）----
// 顶部压条已删（`MapStage` 的自证信息条不再出现在产品屏），所以各面板的 top 从 34 收到 12
/**
 * 右栏：**变窄 + 用满整条高度 + 不画滚动条**（用户 2026-09-18 第 4 条："把滚动条删了，
 * 右栏整体变窄/重排（视觉干净）"）。
 *
 * 实测病因：四块面板加起来 **1098px**，可视区只有 **705px**（`top:12` + `bottom:216` ——
 * 那 216px 是给旧的常驻"请选择任务场景"面板留的位，现在它已收进工具条、这块地空出来了），
 * 于是浏览器画出竖 15px + 横 15px 两条滚动条。
 *
 * 三处一起改：
 *   · `bottom: 216 → 8`  —— 把场景面板让出来的 208px 收回来（可视区 705 → 962）
 *   · `width: 300 → 264` —— 变窄（用户点名）
 *   · `gap: 8 → 6`；滚动条的"皮"隐藏掉（`data-ma-noscrollbar`，规则在 index.html）
 */
const rightColStyle: CSSProperties = {
  position: 'absolute', right: 12, top: 12, bottom: 8, zIndex: 20, width: 264,
  display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto',
}
/**
 * **合并框**：浮在工具条下方（与老文本框编辑器的位置一致），从"横排一条"改成**竖排面板**。
 *
 * 需求方定的两条形态约束都在这里：
 *   · **限高 + 内部滚动**（`maxHeight` + 顶点列表 `overflowY: auto`）—— 顶点多了也不会顶出屏幕；
 *   · 顶点一行一个（行内 经度 / 纬度）。
 */
const geoEditorStyle: CSSProperties = {
  position: 'absolute', left: 12, top: 41, zIndex: 26, width: 430, maxHeight: '68vh',
  display: 'flex', flexDirection: 'column', gap: 5,
  padding: '8px 10px', borderRadius: 8,
  background: 'rgba(6,26,47,.97)', border: `1px solid ${C.borderStrong}`,
  boxShadow: '0 6px 20px rgba(0,0,0,.5)', fontSize: 11.5, color: C.text,
}
const geoEditorHeadStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  color: C.textDim, borderBottom: `1px solid ${C.border}`, paddingBottom: 4,
}
const geoEditorRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 5 }
const geoEditorLabelStyle: CSSProperties = { color: C.textDim, flex: '0 0 auto' }
/** 顶点列表：**限高 + 内部滚动**（需求方点名） */
const geoRowsStyle: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 4,
  maxHeight: 168, overflowY: 'auto', paddingRight: 2,
}
const geoLabelInputStyle: CSSProperties = {
  flex: 1, minWidth: 0, fontSize: 12, padding: '4px 7px', borderRadius: 5,
  background: 'rgba(10,32,58,.9)', border: `1px solid ${C.border}`, color: C.text, outline: 'none',
}
const geoCoordInputStyle: CSSProperties = {
  width: 96, fontSize: 11.5, padding: '3px 6px', borderRadius: 5, fontFamily: 'Consolas, monospace',
  background: 'rgba(10,32,58,.9)', border: `1px solid ${C.border}`, color: C.text, outline: 'none',
}
/** 尺寸模式的数字框（长宽 / 半径 / 每格长度 / 行列）——比坐标框宽一点，能放下整数与小数 */
const geoSizeInputStyle: CSSProperties = {
  width: 96, fontSize: 12, padding: '3px 6px', borderRadius: 5, fontFamily: 'Consolas, monospace',
  background: 'rgba(10,32,58,.9)', border: `1px solid ${C.border}`, color: C.text, outline: 'none',
}
const geoRowBtnStyle: CSSProperties = {
  fontSize: 11, padding: '2px 7px', borderRadius: 5, cursor: 'pointer', font: 'inherit',
  background: 'rgba(29,78,216,.3)', border: `1px solid ${C.border}`, color: C.text,
}
/** 到下限的「×」：灰掉、点不动（需求："删到下限时不允许继续删"） */
const geoRowBtnOffStyle: CSSProperties = {
  ...geoRowBtnStyle, cursor: 'not-allowed', opacity: .4,
}
const geoMsgStyle: CSSProperties = { color: C.warn, fontSize: 11.5 }
const geoMsgDimStyle: CSSProperties = { color: C.textDim, fontSize: 11 }
const geoEditorFootStyle: CSSProperties = {
  display: 'flex', justifyContent: 'flex-end', gap: 6,
  borderTop: `1px solid ${C.border}`, paddingTop: 5,
}
const geoOkBtnStyle: CSSProperties = {
  fontSize: 12, padding: '4px 14px', borderRadius: 6, cursor: 'pointer', font: 'inherit',
  background: 'linear-gradient(180deg,#1d4ed8,#1e3a8a)', border: `1px solid ${C.borderStrong}`, color: '#eaf4ff',
}
const geoCancelBtnStyle: CSSProperties = {
  fontSize: 12, padding: '4px 12px', borderRadius: 6, cursor: 'pointer', font: 'inherit',
  background: 'rgba(10,20,36,.85)', border: `1px solid ${C.border}`, color: C.text,
}
const bottomStyle: CSSProperties = {
  position: 'absolute', left: 12, right: 12, bottom: 56, zIndex: 20, height: 152,
}
/**
 * 显示模式：**独立的下拉框**（自己一块，不并进工具条那一排）。
 * 位置在工具条同一水平带的最右侧（`right: 328` = 让开右侧面板 300px + 间距），
 * `top: 5` 与工具条对齐。
 */
const displayModeBox: CSSProperties = {
  position: 'absolute', right: 292, top: 5, zIndex: 22,
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '4px 10px', borderRadius: 8,
  background: 'rgba(6,26,47,.86)', border: `1px solid ${C.border}`, whiteSpace: 'nowrap',
}
const displayModeSelect: CSSProperties = {
  fontSize: 12.5, color: C.accent, background: 'rgba(10,32,58,.9)',
  border: `1px solid ${C.borderStrong}`, borderRadius: 6, padding: '3px 6px',
  cursor: 'pointer', outline: 'none',
}
const noticeStyle: CSSProperties = {
  position: 'absolute', left: 12, bottom: 216, zIndex: 24, maxWidth: 560,
  fontSize: 12, color: C.text, background: 'rgba(120,60,10,.94)',
  border: '1px solid rgba(245,158,11,.6)', borderRadius: 8, padding: '6px 10px', cursor: 'pointer',
}
/** ★「计划」结果回执（打开/保存后的一条短提示，点一下关掉） */
const planMsgStyle: CSSProperties = {
  position: 'absolute', left: 12, bottom: 258, zIndex: 25, maxWidth: 620,
  fontSize: 12, color: C.text, background: 'rgba(8,40,70,.96)',
  border: '1px solid rgba(95,176,255,.55)', borderRadius: 8, padding: '6px 10px', cursor: 'pointer',
}
/** ★「规划航线」的起终点选择框（图上有多个集结区/任务区时才出现） */
const routePickStyle: CSSProperties = {
  position: 'absolute', left: '50%', top: 96, transform: 'translateX(-50%)', zIndex: 32,
  width: 320, padding: '10px 12px', borderRadius: 10, fontSize: 12.5, color: C.text,
  background: 'rgba(6,26,47,.97)', border: `1px solid ${C.borderStrong}`,
  boxShadow: '0 8px 24px rgba(0,0,0,.5)',
}
const routePickRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }
const routeSelectStyle: CSSProperties = {
  flex: 1, fontSize: 12, color: C.accent, background: 'rgba(10,32,58,.9)',
  border: `1px solid ${C.borderStrong}`, borderRadius: 6, padding: '3px 6px', outline: 'none',
}
const deleteYesStyleInApp: CSSProperties = {
  padding: '4px 10px', borderRadius: 6, cursor: 'pointer', font: 'inherit', fontSize: 12,
  background: 'linear-gradient(180deg,#2563eb,#1d4ed8)', border: '1px solid #5fb0ff', color: '#eaf6ff',
}
const deleteNoStyleInApp: CSSProperties = {
  padding: '4px 10px', borderRadius: 6, cursor: 'pointer', font: 'inherit', fontSize: 12,
  background: 'transparent', border: '1px solid rgba(148,163,184,.5)', color: C.text,
}
const notImplChip: CSSProperties = {
  fontSize: 10.5, color: C.warn, border: '1px solid rgba(245,158,11,.45)', borderRadius: 4, padding: '0 5px',
}

export default SituationScreen
