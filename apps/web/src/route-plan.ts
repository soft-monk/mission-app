// mission-app · apps/web/src/route-plan.ts
//
// **按用户给的布局算几何 + A\* 规划航线 + 航线扩展成出航通道**。
//
// 用户 2026-09-18 的布置（原话）：
//   · 任务区：矩形中心 116.527, 39.864，边长 4km，红色实线
//   · 我方集结区：116.527, 39.70，边长 1km 的矩形，绿色实线
//   · 威胁区：放在两个区域中心点连线之间、**靠近任务区一些**，2km × 4km 的长条矩形、
//     **横在中间**，红色虚线
//   · 用 **A\*** 从集结区到任务区规划一条避开威胁区的航线，航线扩展 1km 宽 → 出航通道，蓝色虚线
//
// ★ 为什么算在前端而不是写死坐标：用户明说"我来安排" —— 他还会挪区域。把这些几何做成
//   **由中心点 + 边长推导**（区域改一个数，航线与通道自动重算），比抄一串写死的经纬度经用。
// ★ 纪律：本文件只做几何与寻路，**不引入任何业务判断**（不算威胁等级、不判越界）。
//   航线的性质是"**一条规划出来的线**"，不是测量值 —— 界面上照此标注。

export interface LL { lng: number; lat: number }

const EARTH_R = 6371008.8
const rad = (d: number) => (d * Math.PI) / 180

/** 纬度方向：1km 对应多少度（地球平均半径，够用；误差 << 图上 1px） */
export const degLatPerKm = () => (1000 / EARTH_R) * (180 / Math.PI)

/** 经度方向：同样 1km 对应多少度 —— **随纬度收缩**（39.8° 处约 0.7679），不能拿纬度的值顶 */
const degLngPerKm = (lat: number) => degLatPerKm() / Math.cos(rad(lat))

/**
 * 以 `center` 为中心、**东西向 `wKm` × 南北向 `hKm`** 的矩形（四个角，逆时针，首尾不闭合）。
 * @param wKm 东西向边长（公里）
 * @param hKm 南北向边长（公里）
 */
export function rectPolygon(center: LL, wKm: number, hKm: number): [number, number][] {
  const dLat = (hKm / 2) * degLatPerKm()
  const dLng = (wKm / 2) * degLngPerKm(center.lat)
  return [
    [center.lng - dLng, center.lat - dLat],
    [center.lng + dLng, center.lat - dLat],
    [center.lng + dLng, center.lat + dLat],
    [center.lng - dLng, center.lat + dLat],
  ]
}

/** 点是否落在矩形内（含边界） */
function inRect(p: LL, r: [number, number][]): boolean {
  const xs = r.map((q) => q[0])
  const ys = r.map((q) => q[1])
  return p.lng >= Math.min(...xs) && p.lng <= Math.max(...xs)
    && p.lat >= Math.min(...ys) && p.lat <= Math.max(...ys)
}

/**
 * **A\* 寻路**：在经纬度网格上从 `start` 走到 `goal`，绕开 `obstacles`（矩形列表）。
 *
 * 网格步长 `stepKm`（默认 0.25km）：步长越小越贴合，但节点数按平方涨。
 * 启发式用**欧氏距离**（可采纳，保证最优）；邻居取 8 邻域（允许斜走，航线才不呈直角楼梯）。
 * 走不通返回空数组（**不编一条假的**）。
 */
export function aStar(start: LL, goal: LL, obstacles: [number, number][][], stepKm = 0.25): LL[] {
  const dLat = stepKm * degLatPerKm()
  const dLng = stepKm * degLngPerKm((start.lat + goal.lat) / 2)
  const key = (ix: number, iy: number) => `${ix},${iy}`
  const toIdx = (p: LL): [number, number] => [Math.round(p.lng / dLng), Math.round(p.lat / dLat)]
  const toLL = (ix: number, iy: number): LL => ({ lng: ix * dLng, lat: iy * dLat })
  const blocked = (ix: number, iy: number) => obstacles.some((r) => inRect(toLL(ix, iy), r))

  const [sx, sy] = toIdx(start)
  const [gx, gy] = toIdx(goal)
  if (blocked(sx, sy) || blocked(gx, gy)) return []   // 起点或终点落在威胁区里 → 如实返回"规划不出来"

  const h = (ix: number, iy: number) => Math.hypot(ix - gx, iy - gy)
  const open = new Map<string, { ix: number; iy: number; g: number; f: number; from: string | null }>()
  const closed = new Set<string>()
  // 父节点表：节点从 open 挪进 closed 之后，回溯还要能找到它的来路（**每次调用独立**，
  // 放模块级会跨调用串味 —— 上一轮的父节点会把这一轮的路径指到别处）
  const from = new Map<string, string | null>()
  open.set(key(sx, sy), { ix: sx, iy: sy, g: 0, f: h(sx, sy), from: null })
  from.set(key(sx, sy), null)

  const N8: [number, number, number][] = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
  ]
  // 上限兜底：网格再大也不会把页面卡死（正常路径几十步就出来了）
  for (let iter = 0; iter < 200000 && open.size; iter++) {
    let bestK = ''
    let best: { ix: number; iy: number; g: number; f: number; from: string | null } | null = null
    for (const [k, v] of open) if (!best || v.f < best.f) { best = v; bestK = k }
    if (!best) break
    open.delete(bestK)
    closed.add(bestK)

    if (best.ix === gx && best.iy === gy) {
      // 回溯
      const out: LL[] = []
      let cur: string | null = bestK
      while (cur) {
        const [ix, iy] = cur.split(',').map(Number)
        out.push(toLL(ix, iy))
        cur = from.get(cur) ?? null
      }
      return out.reverse()
    }

    for (const [dx, dy, cost] of N8) {
      const nx = best.ix + dx
      const ny = best.iy + dy
      const nk = key(nx, ny)
      if (closed.has(nk) || blocked(nx, ny)) continue
      const g = best.g + cost
      const prev = open.get(nk)
      if (!prev || g < prev.g) {
        open.set(nk, { ix: nx, iy: ny, g, f: g + h(nx, ny), from: bestK })
        from.set(nk, bestK)
      }
    }
  }
  return []
}

/** 去掉共线的中间点（网格路径全是小台阶，简化后才是看得懂的航线） */
export function simplify(path: LL[]): LL[] {
  if (path.length <= 2) return path
  const out: LL[] = [path[0]]
  for (let i = 1; i < path.length - 1; i++) {
    const a = out[out.length - 1]
    const b = path[i]
    const c = path[i + 1]
    const cross = (b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng)
    if (Math.abs(cross) > 1e-12) out.push(b)
  }
  out.push(path[path.length - 1])
  return out
}

/**
 * **航线扩展成通道**：把折线按 `widthKm` 加宽成一个多边形（用户："扩展宽度为 1km 的矩形"）。
 *
 * 做法是最常用的"粗线"多边形：每个顶点取**相邻两段法线的平均**，向两侧各推 `widthKm/2`，
 * 左边正着走、右边倒着走，合起来一圈。拐角不尖（比逐段拼矩形少很多自交），
 * 对"画一条通道"这个用途足够；航点很多时视觉上就是一条带宽度的带子。
 */
export function corridor(path: LL[], widthKm: number): [number, number][] {
  const pts = simplify(path)
  if (pts.length < 2) return []
  const half = widthKm / 2
  const dLat = degLatPerKm()
  const latMid = (pts[0].lat + pts[pts.length - 1].lat) / 2
  const dLng = degLngPerKm(latMid)

  // 统一换算成"公里平面"再算法线，最后换回经纬度 —— 直接拿经纬度算会因经度收缩而歪掉
  const km = pts.map((p) => ({ x: p.lng / dLng, y: p.lat / dLat }))
  const left: { x: number; y: number }[] = []
  const right: { x: number; y: number }[] = []
  for (let i = 0; i < km.length; i++) {
    const prev = km[Math.max(0, i - 1)]
    const next = km[Math.min(km.length - 1, i + 1)]
    let dx = next.x - prev.x
    let dy = next.y - prev.y
    const len = Math.hypot(dx, dy) || 1
    dx /= len; dy /= len
    // 法线（左）
    const nx = -dy, ny = dx
    left.push({ x: km[i].x + nx * half, y: km[i].y + ny * half })
    right.push({ x: km[i].x - nx * half, y: km[i].y - ny * half })
  }
  const ring = [...left, ...right.reverse()]
  return ring.map((p) => [p.x * dLng, p.y * dLat] as [number, number])
}

/**
 * 把任意多边形**向外扩张 `padKm`**（用于通道要盖住端点：起点/终点各补半圆太麻烦，
 * 这里直接把通道两端各外推 `padKm`，等价效果、实现简单）。
 */
export function extendEnds(path: LL[], padKm: number): LL[] {
  if (path.length < 2) return path
  const dLat = degLatPerKm()
  const dLng = degLngPerKm(path[0].lat)
  const push = (a: LL, b: LL, sign: number): LL => {
    const dx = (b.lng - a.lng) / dLng
    const dy = (b.lat - a.lat) / dLat
    const len = Math.hypot(dx, dy) || 1
    return { lng: b.lng + (dx / len) * padKm * dLng * sign, lat: b.lat + (dy / len) * padKm * dLat * sign }
  }
  const out = [...path]
  out[0] = push(path[1], path[0], 1)
  out[out.length - 1] = push(path[path.length - 2], path[path.length - 1], 1)
  return out
}
