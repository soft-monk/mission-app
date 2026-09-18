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
import type { AreaItem, LabelItem } from 'map-2d'

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

// ---------------------------------------------------------------- 内联数据（照抄 JSON）
const DEPLOYMENT_AREAS: ScenarioArea[] = [
  {
    key: 'friendly-assembly-a',
    name: '我方集结区 A',
    role: 'assembly',
    polygon: [[116.595, 39.735], [116.625, 39.735], [116.625, 39.755], [116.595, 39.755]],
  },
]

const DEPLOYMENT_NODES: { key: string; name: string; position: [number, number] }[] = [
  { key: 'friendly-forward-node', name: '前沿指挥节点', position: [116.61, 39.745] },
]

const TASK_AREAS: ScenarioArea[] = [
  {
    key: 'area-a', name: 'A 区', role: 'assembly', color: 'blue',
    polygon: [[116.586, 39.744], [116.618, 39.744], [116.618, 39.764], [116.586, 39.764]],
  },
  {
    key: 'area-b', name: 'B 区', role: 'monitor', color: 'green',
    polygon: [[116.556, 39.782], [116.604, 39.782], [116.604, 39.806], [116.556, 39.806]],
  },
  {
    key: 'area-c', name: 'C 区', role: 'hvt', color: 'red',
    polygon: [[116.528, 39.752], [116.568, 39.752], [116.568, 39.776], [116.528, 39.776]],
  },
  {
    key: 'area-enemy-deploy', name: '敌方潜在部署区', role: 'threat', color: 'red', dashed: true,
    polygon: [[116.494, 39.792], [116.556, 39.792], [116.556, 39.826], [116.494, 39.826]],
  },
]

const AIRSPACE_ZONES: ScenarioZone[] = [
  {
    key: 'nfz-core', name: '核心禁飞区', kind: 'no-fly', hardness: 'hard', color: 'red',
    polygon: [[116.56, 39.764], [116.582, 39.764], [116.582, 39.78], [116.56, 39.78]],
  },
  {
    key: 'threat-sam', name: '威胁区（防空）', kind: 'threat', level: 'high', color: 'orange',
    polygon: [[116.54, 39.784], [116.568, 39.784], [116.568, 39.798], [116.54, 39.798]],
  },
  {
    key: 'geofence-ew', name: '电子围栏', kind: 'geofence', action: 'warn', color: 'yellow',
    polygon: [[116.5, 39.76], [116.522, 39.76], [116.522, 39.778], [116.5, 39.778]],
  },
  {
    key: 'corridor-main', name: '出航通道', kind: 'corridor', widthM: 800, color: 'cyan',
    line: [[116.6, 39.742], [116.578, 39.752], [116.552, 39.766]],
  },
]

/** 内联的场景数据（= data/scenario-1/ 三份 JSON 的并集） */
export const DEFAULT_SCENARIO: ScenarioData = {
  // ★ 2026-09-18 用户第 2 条："为什么地图缩放不能缩放，放大到一个城市后不能继续放大？之前不能全球都能看的吗"
  //   原因就在这里：旧值 `minZoom: 10 / maxZoom: 14` 把地图**锁死在 z10–z14**（缩不出去、也放不大）。
  //   瓦片包 `map-2d/tiles/raster` 实际有 **z0–z14**：下限放到 2 就能看全球；
  //   上限放到 18 —— z14 以上由地图模块"超采样"父瓦片（画面变糊，但能继续放大，比卡死好）。
  //   磁盘上的 `data/scenario-1/task-areas.json` 已同步改成同一组值（两份保持一致）。
  center: [116.574, 39.77],
  zoom: 12,
  minZoom: 2,
  maxZoom: 18,
  areas: [...TASK_AREAS, ...DEPLOYMENT_AREAS],
  zones: AIRSPACE_ZONES,
  nodes: DEPLOYMENT_NODES,
  corridor: AIRSPACE_ZONES.find((z) => z.kind === 'corridor'),
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

// ---------------------------------------------------------------- 数据 → 图元
/** 区域（含我方集结区与空域各要素）→ `AreaItem[]`；`dashed` 只对显式给了的数据生效 */
export function toAreaItems(data: ScenarioData): AreaItem[] {
  const items: AreaItem[] = []
  const push = (id: string, name: string, polygon: [number, number][], color?: string, dashed?: boolean, opacity = 0.1) => {
    if (polygon.length < 3) return
    items.push({ id, polygon, color: resolveColor(color), label: name, dashed: dashed ?? true, opacity })
  }

  for (const a of data.areas) push(`AREA:${a.key}`, a.name, a.polygon, a.color, a.dashed)
  for (const z of data.zones) {
    if (z.kind === 'corridor') continue                      // 通道单独处理（线 → 面）
    push(`ZONE:${z.key}`, z.name, z.polygon ?? [], z.color, true, z.kind === 'no-fly' ? 0.16 : 0.1)
  }
  // 出航通道：`line` + `widthM` → 带状面（宽度取自数据，不猜）
  if (data.corridor?.line && data.corridor.widthM) {
    const band = corridorBand(data.corridor.line, data.corridor.widthM)
    push(`ZONE:${data.corridor.key}`, `${data.corridor.name}（${data.corridor.widthM} m）`, band, data.corridor.color, true, 0.12)
  }
  return items
}

/** 区域名 / 节点名 → `LabelItem[]`（每个面一个名，便于在图上直接读） */
export function toLabelItems(data: ScenarioData): LabelItem[] {
  const items: LabelItem[] = []
  const centroid = (ring: [number, number][]): [number, number] => {
    const n = ring.length || 1
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n]
  }

  for (const a of data.areas) {
    if (a.polygon.length < 3) continue
    items.push({ id: `LBL:${a.key}`, ...toLngLat(centroid(a.polygon)), text: a.name, color: resolveColor(a.color) ?? '#cfe3f5', size: 12, radius: 0 })
  }
  for (const z of data.zones) {
    if (z.kind === 'corridor') {
      const line = z.line ?? []
      if (!line.length) continue
      const mid = line[Math.floor(line.length / 2)]
      items.push({ id: `LBL:${z.key}`, lng: mid[0], lat: mid[1], text: z.name, color: resolveColor(z.color) ?? '#cfe3f5', size: 11, radius: 0 })
      continue
    }
    if (!z.polygon || z.polygon.length < 3) continue
    items.push({ id: `LBL:${z.key}`, ...toLngLat(centroid(z.polygon)), text: z.name, color: resolveColor(z.color) ?? '#cfe3f5', size: 12, radius: 0 })
  }
  for (const n of data.nodes) {
    // 节点额外画一个标记点（radius > 0 才会画点，见 LabelItem 契约）
    items.push({ id: `LBL:${n.key}`, lng: n.position[0], lat: n.position[1], text: n.name, color: '#7fd1ff', size: 12, radius: 4 })
  }
  return items
}

/** `[lng, lat]` → `{ lng, lat }`（只是解构，避免手写 repeat） */
function toLngLat(p: [number, number]): { lng: number; lat: number } {
  return { lng: p[0], lat: p[1] }
}
