// mission-app · apps/web/src/map-style.ts
//
// 地图样式配置（无人机位图图标 / 缺省画点 / 轨迹线宽）——**内联为前端默认值**。
//
// 为什么内联而不是 fetch：
//   宿主的 `/` 只托管 apps/web/dist，**不托管 data/**（见 vite.config.ts 的 proxy 白名单：
//   /health、/stats、/runtime-config、/tiles）。所以 data/scenario-1/map-style.json
//   在运行时既不在 dist 里、也没有对应的 HTTP 路由——fetch 它必然 404。
//   与其依赖后端加路由（本轮明确"别去改后端"），不如把**默认值内联在前端**：
//   它本来就是"样式默认值"，不是业务数据。
//
// 字段与任务下发的 `data/scenario-1/map-style.json` 逐字段一致（含 `drone.byType`），
// 用 `?style=` 可以覆盖成另一份 JSON 的 URL（部署时把样式放到静态目录即可，无需改代码）。
import type { MapStyleConfig } from 'map-2d'

/**
 * 与 `data/scenario-1/map-style.json` **逐字段一致**的默认值。
 *
 * 说明两处刻意的取值（都不是笔误）：
 *   · `useIcon: false` —— 任务下发的 JSON 里就是 false。
 *     即"这批默认值下，无人机走**画点**、不画位图"；位图能力保留（改成 true + 放一张图到
 *     `public/icons/` 就能用），`byType` 的四色也照旧生效。
 *   · 颜色写在 `point.color` 而不是 `byType`——渲染时的优先级是
 *     图元字段 > 机型段 > 顶层，所以 `byType` 里的四色会覆盖顶层 `point.color`。
 *     为了让"顶层 #22d3ee"与"byType 四色"同时可读，这里照抄 JSON，不做"优化"。
 */
export const DEFAULT_MAP_STYLE: MapStyleConfig = {
  schemaVersion: '1.0.0',
  note: '个性化需求 1/2。useIcon=false 或缺 icon.url → 回落画点，不报错。',
  drone: {
    useIcon: false,
    icon: {
      url: '/icons/uav-optical.png',
      sizePx: [28, 28],
      anchor: 'center',
    },
    point: {
      radiusPx: 5,
      color: '#22d3ee',
      strokeColor: '#0b1220',
      strokeWidthPx: 1,
    },
    byType: {
      optical: { point: { color: '#22d3ee' } },
      radar: { point: { color: '#f59e0b' } },
      electronic: { point: { color: '#a855f7' } },
      comm: { point: { color: '#22c55e' } },
    },
  },
  track: {
    widthPx: 2,
    dashed: false,
    color: '#38bdf8',
    opacity: 0.85,
  },
  // 编队配色。**键是 `groupId`（g1..g6），不是配置里的 `groupKey`（recon-1 等）**——
  // 线上事件的 `groupId` 由 scenario-data 的 `groupIdOf()` 按 `groups[]` 声明序生成
  // （recon-1→g1 / recon-2→g2 / radar-1→g3 / relay-1→g4 / ew-1→g5 / reserve-1→g6）。
  // 配色沿用配置 `map-style.json` 里 `groupColors` 的取值，只把键换成 groupId。
  groupColors: {
    g1: '#22d3ee', // recon-1  前出侦察集群
    g2: '#22c55e', // recon-2  侧翼侦察集群
    g3: '#f59e0b', // radar-1  雷达探测集群
    g4: '#22c55e', // relay-1  通信中继集群
    g5: '#a855f7', // ew-1     电子压制集群
    g6: '#8b5cf6', // reserve-1 机动预备集群
  },
  target: {
    radiusPx: 6,
    highColor: '#ef4444',
    midColor: '#f59e0b',
    lowColor: '#22d3ee',
  },
  /**
   * **地图控件**的显隐与落位（2026-09-18 新增，用户第 1 条）。
   *
   * 用户原话："默认显示的鼠标坐标，显示的东西被遮挡了？如果是，那么修改 map2d 接口，
   * 要求不只是 true false，可以自己使用配置文件和哪些之前写的配置文件一起，**可配置显影与位置**"。
   *
   * 事实核查：坐标读数此前**根本没显示**（`controls.coords` 默认 false，且 `CoordReadout`
   * 要宿主自己渲染 —— 宿主没渲染）。现在按这份配置开启并定位：
   *   · `show`   —— 显隐
   *   · `anchor` —— `top-left` / `top-right` / `bottom-left` / `bottom-right`
   *   · `offset` —— 在锚点基础上的像素微调 `[dx, dy]`
   * 字段与 `data/scenario-1/map-style.json` 的 `controls` 段**逐字段一致**（两份同步改）。
   */
  controls: {
    // 鼠标经纬度：左下角，往上抬 56px —— 避开底部那条全局状态条与比例尺
    coords: { show: true, anchor: 'bottom-left', offset: [0, 56] },
    // 比例尺：右下角（模块缺省位置），往上抬 56px 同样避开状态条
    scale: { show: true, anchor: 'bottom-right', offset: [0, 56] },
    // 指北针：**默认关**。模块缺省把它放在右上角，而本应用每个地图屏的右上角都是右栏面板，
    // 开了会被面板盖住（实测）。要用的话把 show 改 true 并给一个不被遮挡的锚点。
    compass: { show: false, anchor: 'bottom-left', offset: [0, 96] },
    // 缩放按钮同理默认关（滚轮/键盘 ± 可用）
    zoom: { show: false, anchor: 'bottom-right', offset: [0, 96] },
    legend: { show: false, anchor: 'bottom-right', offset: [0, 136] },
    layerPanel: { show: false, anchor: 'top-left', offset: [0, 44] },
    modeBadge: { show: false, anchor: 'top-right', offset: [0, 0] },
  },
}

/** 一个控件的配置（`map-style.json` 的 `controls.<key>`） */
export interface ControlCfgEntry {
  show?: boolean
  anchor?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  offset?: [number, number]
}

/**
 * 把配置里的 `controls` 段翻成 map-2d 的 `ControlSpec[]`（**只做翻译，不做判断**）。
 * 拿不到配置就给 `undefined` —— 调用方届时用模块缺省行为，**不自己编一份控件清单**。
 */
export function controlSpecsOf(style: MapStyleConfig): { key: string; on?: boolean; anchor?: ControlCfgEntry['anchor']; offset?: [number, number] }[] | undefined {
  const c = (style as unknown as { controls?: Record<string, ControlCfgEntry> }).controls
  if (!c || typeof c !== 'object') return undefined
  const out: { key: string; on?: boolean; anchor?: ControlCfgEntry['anchor']; offset?: [number, number] }[] = []
  for (const [key, v] of Object.entries(c)) {
    if (!v || typeof v !== 'object') continue
    const off = Array.isArray(v.offset) && v.offset.length === 2 ? [Number(v.offset[0]) || 0, Number(v.offset[1]) || 0] as [number, number] : undefined
    out.push({ key, on: typeof v.show === 'boolean' ? v.show : undefined, anchor: v.anchor, offset: off })
  }
  return out.length ? out : undefined
}

/** 编队配色兜底（`groupColors` 里没有该 groupId 时用） */
const FALLBACK_GROUP_COLOR = '#8b93a7'

/** 读取编队配色；`groupId` 缺失或未登记时返回兜底色 */
export function groupColorOf(style: MapStyleConfig, groupId?: string | null): string {
  if (!groupId) return FALLBACK_GROUP_COLOR
  const table = style.groupColors as Record<string, string> | undefined
  return table?.[groupId] ?? FALLBACK_GROUP_COLOR
}

/** 轨迹线样式（按 `track` 段取值，缺字段时给 map-2d 的同一套缺省） */
export function trackStyleOf(style: MapStyleConfig) {
  const t = style.track ?? {}
  return {
    widthPx: typeof t.widthPx === 'number' ? t.widthPx : 2,
    dashed: typeof t.dashed === 'boolean' ? t.dashed : true,
    color: typeof t.color === 'string' ? t.color : '#38bdf8',
    opacity: typeof t.opacity === 'number' ? t.opacity : 0.9,
  }
}

/**
 * 读取要生效的样式配置。
 *
 * 优先级：`?style=<url>` 成功取到 → 用它；取不到（网络/解析失败）→ **回落内联默认值并给出原因**。
 * 不给 `?style=` 时**同步**返回内联默认值（不发任何请求）。
 *
 * 为什么单列一个异步函数而不是在组件里 fetch：
 *   取样式是"启动前的一次决定"，放在组件里会让它和渲染时机纠缠；
 *   而且失败必须**可见**（返回 reason），不能静默用半份配置。
 */
export async function loadMapStyle(
  search: string = window.location.search,
): Promise<{ style: MapStyleConfig; source: string; warning?: string }> {
  const url = new URLSearchParams(search).get('style')
  if (!url) return { style: DEFAULT_MAP_STYLE, source: '内联默认值（data/scenario-1/map-style.json 同字段）' }
  try {
    const res = await fetch(url, { cache: 'no-cache' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = (await res.json()) as MapStyleConfig
    return { style: json, source: `?style=${url}` }
  } catch (e) {
    return {
      style: DEFAULT_MAP_STYLE,
      source: '内联默认值（?style= 覆盖失败）',
      warning: `?style=${url} 读取失败（${String((e as Error)?.message ?? e)}），已回落内联默认值`,
    }
  }
}
