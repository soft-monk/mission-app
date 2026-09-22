// mission-app · apps/web/src/scenario.ts
//
// 场景几何（区域多边形 / 标注）——**内联为前端默认值**，理由与 map-style.ts 相同：
// 宿主的 `/` 只托管 apps/web/dist，不托管 `data/scenario-1/`，运行时 fetch 必然 404。
//
// 数据来源（逐字段照抄，不做业务加工）：
//   data/scenario-1/deployment.json   → areas[]、aircraft[]、groups[]
//   data/scenario-1/task-areas.json   → areas[]（A/B/C 区 + 敌方潜在部署区）+ center/zoom
//   data/scenario-1/airspace.json     → zones[]（禁飞区 / 威胁区 / 电子围栏 / 出航通道）
//
// ★ 纪律：本文件只做"数据 → map-2d 图元"的**翻译**，不做业务判断
//   （不算威胁等级、不判越界、不推导航路）。颜色的语义令牌 → 十六进制也只在这里做一次。
import { aStar, rectPolygon, simplify, degLatPerKm } from './route-plan'
import { draw } from 'map-2d'

// ---------------------------------------------------------------- 输入数据的形状（照抄 JSON）
export interface ScenarioArea {
  key: string
  name: string
  role?: string
  color?: string
  dashed?: boolean
  polygon: [number, number][]
}

export interface ScenarioZone {
  key: string
  name: string
  kind: 'no-fly' | 'threat' | 'geofence' | 'corridor' | string
  hardness?: string
  level?: string
  action?: string
  /** 通道宽度（米）——只有 corridor 有；用来把折线扩成一条带状面 */
  widthM?: number
  color?: string
  /** 是否虚线（用户布置里的「红色虚线」「蓝色虚线」用这个） */
  dashed?: boolean
  polygon?: [number, number][]
  line?: [number, number][]
}

export interface DeploymentAircraft {
  deviceId: string
  typeKey?: string
  groupKey?: string
  station?: [number, number]
}

export interface ScenarioData {
  /** 视角（来自 task-areas.json 的 center/zoom，逐字段照抄） */
  center: [number, number]
  zoom: number
  minZoom: number
  maxZoom: number
  /** 任务区 + 我方部署区（两类都进 area 图层） */
  areas: ScenarioArea[]
  /** 空域要素（禁飞区 / 威胁区 / 电子围栏 / 出航通道） */
  zones: ScenarioZone[]
  /** 前沿指挥节点等点状要素 */
  nodes: { key: string; name: string; position: [number, number] }[]
  /** 出航通道：只用来算出航通道带状面（不参与其它推导） */
  corridor?: ScenarioZone
}

// ---------------------------------------------------------------- 内联数据（**用户 2026-09-18 亲自安排的布局**）
//
// 用户原话："画的太杂乱了，我来安排，还是现在的北京位置"：
//   · **任务区**：矩形中心 `116.527, 39.864`，边长 **4km**，**红色实线**
//   · **我方集结区**：`116.527, 39.70`，边长 **1km** 的矩形，**绿色实线**
//   · **威胁区**：两个中心连线之间、**靠近任务区一些**，**2km × 4km** 的长条矩形、**横在中间**，**红色虚线**
//   · **出航通道**：用 **A\*** 从集结区到任务区规划一条避开威胁区的航线，航线扩展 **1km** 宽，
//     **蓝色虚线**
//
// 所以：区域几何**由中心点 + 边长推导**（`rectPolygon`），航线与通道由 `route-plan.ts` 现算
// —— 用户以后挪区域，只改下面这几个中心点/边长即可，航线和通道自动跟着重算。
//
// 旧的 A/B/C 区、敌方潜在部署区、核心禁飞区、电子围栏、前沿指挥节点、老的出航通道折线
// **全部删掉**（用户："画的太杂乱了"）。

/** 任务区：中心 + 边长 4km × 4km */
export const TASK_AREA_CENTER = { lng: 116.527, lat: 39.864 }
export const TASK_AREA_SIDE_KM = 4
/** 我方集结区：中心 + 边长 1km × 1km */
export const ASSEMBLY_CENTER = { lng: 116.527, lat: 39.700 }
export const ASSEMBLY_SIDE_KM = 1
/**
 * 威胁区：2km（南北）× 4km（东西）的长条，横在两地之间、**靠近任务区**。
 *
 * "靠近任务区一些"取**从任务区往集结区走三成**的位置：
 *   任务区南沿 39.8459 → 集结区北沿 39.7045，跨度 0.1414°；
 *   39.8459 − 0.3 × 0.1414 ≈ **39.8035**（离任务区更近，肉眼一眼能看出偏上）。
 */
export const THREAT_CENTER = { lng: 116.527, lat: 39.8035 }
export const THREAT_W_KM = 4
export const THREAT_H_KM = 2

const TASK_RECT = rectPolygon(TASK_AREA_CENTER, TASK_AREA_SIDE_KM, TASK_AREA_SIDE_KM)
const ASSEMBLY_RECT = rectPolygon(ASSEMBLY_CENTER, ASSEMBLY_SIDE_KM, ASSEMBLY_SIDE_KM)
const THREAT_RECT = rectPolygon(THREAT_CENTER, THREAT_W_KM, THREAT_H_KM)

/**
 * **把本场景画到地图上** —— 全部走 map-2d 的几何原语 + 绑定文本框。
 *
 * 用户 2026-09-18 布置的四件事，逐个对应：
 *   · 任务区     → `draw.polygon` 红色**实线**，文本「任务区」
 *   · 我方集结区 → `draw.polygon` 绿色**实线**，文本「我方集结区」
 *   · 威胁区     → `draw.polygon` 红色**虚线**，文本「威胁区」
 *   · 出航通道   → A\* 航线扩展 1km 宽的带状面，蓝色**虚线**，文本「出航通道」
 *   · 规划航线   → `draw.line` 蓝色实线，文本「规划航线」
 *
 * 幂等：每条都用固定 id（`SCN:*`），重复调用是**覆盖**而不是叠加。
 * 文字全部由模块的 `TextOverlay` 画 —— 本文件不再手挂 `label` 图元。
 */
export function drawScenario(): void {
  draw.polygon({
    id: 'SCN:task', ring: TASK_RECT,
    color: '#ef4444', fillColor: '#ef4444', fillOpacity: 0.1,
    strokeWidthPx: 2, dashed: false,
    text: '任务区',
  })
  draw.polygon({
    id: 'SCN:assembly', ring: ASSEMBLY_RECT,
    color: '#22c55e', fillColor: '#22c55e', fillOpacity: 0.1,
    strokeWidthPx: 2, dashed: false,
    text: '我方集结区',
  })
  draw.polygon({
    id: 'SCN:threat', ring: THREAT_RECT,
    color: '#ef4444', fillColor: '#ef4444', fillOpacity: 0.12,
    strokeWidthPx: 2, dashed: true,
    text: '威胁区',
  })

  if (PLANNED_ROUTE.length < 2) return
  const line = PLANNED_ROUTE.map((p) => [p.lng, p.lat] as [number, number])
  draw.line({ id: 'SCN:route', points: line, color: '#38bdf8', widthPx: 2, dashed: false, text: '规划航线' })
  const band = corridorBand(line, 1000)
  if (band.length >= 3) {
    draw.polygon({
      id: 'SCN:corridor', ring: band,
      color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.08,
      strokeWidthPx: 1.4, dashed: true,
      // 2026-09-21：标注只留名字（与活路径 `route-compute.ts` 同步；需求方："删除（1000m）"）
      text: '出航通道',
    })
  }
}


/**
 * **A\* 规划出来的航线**：从集结区北沿中点到任务区南沿中点，绕开威胁区。
 *
 * 起终点取两条边的**中点**（正对着，最自然）；若规划不出来（起终点落在威胁区里等）
 * 就是空数组 —— 界面届时只画区域、不画航线和通道，**不编一条假的**。
 */
const ROUTE_START = { lng: ASSEMBLY_CENTER.lng, lat: ASSEMBLY_CENTER.lat + (ASSEMBLY_SIDE_KM / 2) * degLatPerKm() }
const ROUTE_GOAL = { lng: TASK_AREA_CENTER.lng, lat: TASK_AREA_CENTER.lat - (TASK_AREA_SIDE_KM / 2) * degLatPerKm() }
export const PLANNED_ROUTE: { lng: number; lat: number }[] =
  simplify(aStar(ROUTE_START, ROUTE_GOAL, [THREAT_RECT], 0.25))

const DEPLOYMENT_AREAS: ScenarioArea[] = [
  // **绿色实线**（用户："我方集结区……绿色实线"）→ `dashed: false`
  { key: 'friendly-assembly', name: '我方集结区', role: 'assembly', color: 'green', dashed: false, polygon: ASSEMBLY_RECT },
]

const DEPLOYMENT_NODES: { key: string; name: string; position: [number, number] }[] = []

const TASK_AREAS: ScenarioArea[] = [
  // **红色实线**（用户："任务区……红色实线"）→ `dashed: false`
  { key: 'area-task', name: '任务区', role: 'hvt', color: 'red', dashed: false, polygon: TASK_RECT },
]

const AIRSPACE_ZONES: ScenarioZone[] = [
  { key: 'threat-mid', name: '威胁区', kind: 'threat', level: 'high', color: 'red', dashed: true, polygon: THREAT_RECT },
]

/** 内联的场景数据（= data/scenario-1/ 三份 JSON 的并集） */
export const DEFAULT_SCENARIO: ScenarioData = {
  // ★ 2026-09-18 用户第 2 条："为什么地图缩放不能缩放，放大到一个城市后不能继续放大？之前不能全球都能看的吗"
  //   原因就在这里：旧值 `minZoom: 10 / maxZoom: 14` 把地图**锁死在 z10–z14**（缩不出去、也放不大）。
  //   瓦片包 `map-2d/tiles/raster` 实际有 **z0–z14**：下限放到 2 就能看全球；
  //   上限放到 18 —— z14 以上由地图模块"超采样"父瓦片（画面变糊，但能继续放大，比卡死好）。
  //   磁盘上的 `data/scenario-1/task-areas.json` 已同步改成同一组值（两份保持一致）。
  // 视角中心取两个区域的中点（116.527, 39.782），zoom 11 能把两地一屏放下
  center: [116.527, 39.782],
  zoom: 11,
  minZoom: 2,
  maxZoom: 18,
  areas: [...TASK_AREAS, ...DEPLOYMENT_AREAS],
  zones: AIRSPACE_ZONES,
  nodes: DEPLOYMENT_NODES,
  // 出航通道：**由 A\* 规划出的航线扩展 1km 宽**（用户："这条航线扩展宽度为 1km 的矩形，画出出航通道"）。
  // 走已有的 `corridorBand(line, widthM)` 通路（`toAreaItems` 会把它摊成带状面），
  // 不另写一套加宽算法 —— 两份实现迟早会不一致。
  corridor: PLANNED_ROUTE.length >= 2
    ? {
      key: 'corridor-outbound', name: '出航通道', kind: 'corridor', widthM: 1000, color: 'blue', dashed: true,
      line: PLANNED_ROUTE.map((p) => [p.lng, p.lat] as [number, number]),
    }
    : undefined,
}

/**
 * 色彩语义令牌 → 十六进制。
 *
 * 数据里写的是 `"red"` / `"cyan"` 这类**语义名**（契约如此），而 map-2d 的 `color`
 * 收的是 CSS 颜色。这层映射只在前端做一次——它是"宿主的词汇表"，不该塞进地图模块。
 */
const COLOR_TOKEN: Record<string, string> = {
  red: '#ef4444',
  orange: '#f59e0b',
  yellow: '#eab308',
  green: '#22c55e',
  blue: '#3b82f6',
  cyan: '#22d3ee',
  purple: '#a855f7',
  gray: '#8b93a7',
}

/** 未知令牌原样返回（CSS 本身认颜色名）；`undefined` 走调用方的兜底色 */
export function resolveColor(token?: string): string | undefined {
  if (!token) return undefined
  return COLOR_TOKEN[token] ?? token
}

// ---------------------------------------------------------------- 几何：折线 + 宽度 → 带状面
const EARTH_R = 6371008.8
const rad = (d: number) => (d * Math.PI) / 180

/**
 * 把一条中心线按宽度（米）扩成带状多边形。
 *
 * 为什么需要：`airspace.json` 的 `corridor-main` 只给了 `line`（三个点）+ `widthM: 800`。
 * 任务要求通道也用 `AreaItem` 画出来，所以这里把"线 + 宽"如实展开成一个面——
 * **宽度是数据给的**（800 m），不是我们估的。
 *
 * 做法：中心线逐点求左右法向偏移，再"去程 + 回程"拼成闭合环。
 * 精度取舍：按每点的局部法向偏移（不做圆角与自交处理）——通道是近似直线的走廊，
 * 这样足够，且不会引入曲线拟合这类需要调参的东西。
 */
export function corridorBand(line: [number, number][], widthM: number): [number, number][] {
  if (line.length < 2 || !(widthM > 0)) return []
  const half = widthM / 2
  const left: [number, number][] = []
  const right: [number, number][] = []
  for (let i = 0; i < line.length; i++) {
    const [lng, lat] = line[i]
    const prev = line[i - 1] ?? line[i]
    const next = line[i + 1] ?? line[i]
    // 中心线在该点的走向（度）；经度方向按 cos(lat) 折算成"等距"再求法向
    const cosLat = Math.max(1e-6, Math.cos(rad(lat)))
    const dx = (next[0] - prev[0]) * cosLat
    const dy = next[1] - prev[1]
    const len = Math.hypot(dx, dy)
    if (len === 0) { left.push([lng, lat]); right.push([lng, lat]); continue }
    // 左法向（逆时针 90°）= (-dy, dx) 归一化后换算回度
    const nx = -dy / len
    const ny = dx / len
    const dLat = (half * ny) / EARTH_R
    const dLng = (half * nx) / (EARTH_R * cosLat)
    left.push([lng + (dLng * 180) / Math.PI, lat + (dLat * 180) / Math.PI])
    right.push([lng - (dLng * 180) / Math.PI, lat - (dLat * 180) / Math.PI])
  }
  return [...left, ...right.reverse()]
}

/** `[lng, lat]` → `{ lng, lat }`（只是解构，避免手写 repeat） */
export function toLngLat(p: [number, number]): { lng: number; lat: number } {
  return { lng: p[0], lat: p[1] }
}