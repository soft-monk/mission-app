// mission-app · apps/web/src/route-compute.ts
//
// **规划航线**（★ 2026-09-18，需求方："添加规划航线功能，就是使用 a* 算法，用户在界面上绘制的集结区与任务区，
//   如果都只有一个区域，那就直接算让开威胁字样的区域位置，画出航线航道；如果有多个，
//   让用户选择是计算哪两个的航线"）。
//
// 口径（都在这里，界面只负责选"哪两个"）：
//   · **集结区 / 任务区 / 障碍区** = 用户在图上画的 `area` 图元，按它的**文本**认：
//     含「集结」→ 集结区；含「任务」→ 任务区；含「威胁」**或「禁飞」**→ 要绕开的障碍。
//     （画完可以用"点文本改字"改成这些名字；认不出来就不猜，如实报"没找到"。）
//     ★ 2026-09-21：新增「禁飞区」（与威胁区同款单条目）后，障碍判据由"含威胁"扩成"含威胁或含禁飞"。
//   · **起终点**：两块区域**互相朝向的那条边**的中点 —— 与 scenario.ts 里
//     "集结区北沿中点 → 任务区南沿中点"同一口径，只是这里按两块的实际相对方位自动选边。
//   · **A\***：直接用 `route-plan.ts` 的 `aStar`（0.25km 网格），绕开所有威胁区；
//     规划不出来（起终点被威胁区盖住等）→ **不画假的**，如实报失败。
//   · 画出来两条：`规划航线`（线，**画全程**）+ `出航通道`（带状面，1000 m 宽，
//     **只跟踪航路前 5 km** —— 2026-09-21 需求方："只需要出集结区后包裹航路 5km 即可"；
//     标注只写名字、不再带宽度 —— 需求方："只需要出航通道即可，删除（1000m）"）。
import { draw, MapDraw } from 'map-2d'
import { aStar, simplify } from './route-plan'
import { corridorBand } from './scenario'

export interface DrawnArea {
  id: string
  /** 用户给它写的文本（面板/选中时看到的就是它） */
  text: string
  ring: [number, number][]
}

/** 图上所有"面"图元（带文本）。`draw.list()` 只给 id，所以还要按 id 取回几何。 */
export function drawnAreas(): DrawnArea[] {
  const out: DrawnArea[] = []
  for (const it of MapDraw.list('area') as unknown as Record<string, unknown>[]) {
    const id = it?.id
    // ⚠️ 面图元的几何字段叫 **`polygon`**（不是 `ring`，那是绘制入参的名字）；
    //    文本字段叫 **`label`**（见 map-2d `NATIVE_TEXT_FIELD`，不是 `text`）。
    //    这两个读错就会"区域明明在图上，却认不出它是什么"（实测踩到：集结区 0 个）。
    const ring = (it?.polygon ?? it?.ring) as [number, number][] | undefined
    if (typeof id !== 'string' || !Array.isArray(ring) || ring.length < 3) continue
    const label = typeof it.label === 'string' ? it.label : (typeof it.text === 'string' ? it.text : '')
    out.push({ id, text: label, ring })
  }
  return out
}

/** 按文本把面分成三类（认不出名字的不进任何一类 —— 不猜） */
export function classifyAreas(areas = drawnAreas()) {
  /**
   * 文本里含**任一**关键词就算这一类。
   * 现在只有障碍用到多个关键词：**「威胁」或「禁飞」**（2026-09-21 加禁飞区时扩的）。
   */
  const pick = (...kws: string[]) => areas.filter((a) => kws.some((kw) => a.text.includes(kw)))
  return {
    assemblies: pick('集结'),
    tasks: pick('任务'),
    threats: pick('威胁', '禁飞'),
    all: areas,
  }
}

const centerOf = (ring: [number, number][]) => {
  let x = 0, y = 0
  for (const [lng, lat] of ring) { x += lng; y += lat }
  return { lng: x / ring.length, lat: y / ring.length }
}

/**
 * 取"朝向对方的那条边的中点"：在环上找**离对方中心最近的点**，再取它所在边的中点。
 * 这样两块区域不管上下还是左右排布都对（scenario.ts 里是上下排，取到的就是南北沿中点）。
 */
function facingPoint(ring: [number, number][], other: { lng: number; lat: number }) {
  let best = 0, bestD = Infinity
  for (let i = 0; i < ring.length; i++) {
    const d = (ring[i][0] - other.lng) ** 2 + (ring[i][1] - other.lat) ** 2
    if (d < bestD) { bestD = d; best = i }
  }
  const a = ring[best]
  const b = ring[(best + 1) % ring.length]
  return { lng: (a[0] + b[0]) / 2, lat: (a[1] + b[1]) / 2 }
}

/**
 * **出航通道只跟踪航路多长**（km）—— 2026-09-21 需求方：
 * "出航通道…现在是完全跟踪、把所有的航路都包裹住的，**只需要出集结区后包裹航路 5km 即可**"。
 * 宽度仍是 1 km（`corridorWidthM`），这里只管**长度**。
 */
const CORRIDOR_TRACK_KM = 5

/** 等距圆柱近似的两点距离（km）——与本文件算 `lengthKm` 用的是同一套常数，不引第二套口径 */
function kmBetween(a: [number, number], b: [number, number]): number {
  const dx = (b[0] - a[0]) * 111.32 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180)
  const dy = (b[1] - a[1]) * 110.54
  return Math.hypot(dx, dy)
}

/**
 * **按"沿航路累计的长度"截断折线**（需求方选定的甲口径）。
 *
 * 用途：出航通道只包**前 5 km 航路**，所以先把航路截到 5 km，再拿去做带宽。
 *
 * 三条口径：
 *   · 逐段累加，**凑到 `maxKm` 就在那一段上按比例插一个点**收尾（插点是必要的：
 *     否则通道会在最后一个整点处突然断掉，看着像被切了一刀）；
 *   · **不足 `maxKm` 时不补、不造假** —— 返回整条（"能包多少包多少"）；
 *   · 点数 < 2 时原样返回（不生成无意义的"带"）。
 */
function cumulativeSlice(line: [number, number][], maxKm: number): [number, number][] {
  if (line.length < 2 || !(maxKm > 0)) return line
  const out: [number, number][] = [line[0]]
  let acc = 0
  for (let i = 1; i < line.length; i++) {
    const seg = kmBetween(line[i - 1], line[i])
    if (seg <= 0) continue
    if (acc + seg <= maxKm) {                 // 整段都在预算内 → 收下整段
      out.push(line[i])
      acc += seg
      continue
    }
    const t = (maxKm - acc) / seg             // 在这一段上按比例插点收尾
    if (t > 0) {
      out.push([
        line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t,
        line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t,
      ])
    }
    break
  }
  return out
}

/** 规划出来的结果（给界面报数用） */
export interface RouteResult {
  ok: boolean
  reason?: string
  /** 航路点个数与总长（km） */
  points?: number
  lengthKm?: number
  /** 绕开了几个威胁区 */
  avoided?: number
}

/**
 * **算并画出航线 + 航道**（幂等：固定 id `PLAN:route` / `PLAN:corridor`，重算是覆盖）。
 * @param assemblyId 集结区图元 id
 * @param taskId 任务区图元 id
 * @param corridorWidthM 航道宽度（默认 1000m，与需求方口径一致）
 */
export function planAndDrawRoute(assemblyId: string, taskId: string, corridorWidthM = 1000): RouteResult {
  const { assemblies, tasks, threats } = classifyAreas()
  const a = assemblies.find((x) => x.id === assemblyId)
  const t = tasks.find((x) => x.id === taskId)
  if (!a) return { ok: false, reason: '没找到这个集结区（可能已被删掉）' }
  if (!t) return { ok: false, reason: '没找到这个任务区（可能已被删掉）' }

  const ca = centerOf(a.ring), ct = centerOf(t.ring)
  const start = facingPoint(a.ring, ct)
  const goal = facingPoint(t.ring, ca)
  const obstacles = threats.map((x) => x.ring)

  const path = simplify(aStar(start, goal, obstacles, 0.25))
  if (path.length < 2) {
    return {
      ok: false, avoided: obstacles.length,
      reason: `A* 规划不出航线（起点/终点可能落在威胁区里，或威胁区把通道整个挡住）—— 不画假航线`,
    }
  }

  const line = path.map((p) => [p.lng, p.lat] as [number, number])
  // 长度按等距圆柱近似累加（只用于回报，不参与几何）
  let lenKm = 0
  for (let i = 1; i < line.length; i++) {
    const dx = (line[i][0] - line[i - 1][0]) * 111.32 * Math.cos((line[i][1] * Math.PI) / 180)
    const dy = (line[i][1] - line[i - 1][1]) * 110.54
    lenKm += Math.hypot(dx, dy)
  }

  draw.line({ id: 'PLAN:route', points: line, color: '#38bdf8', widthPx: 2, dashed: false, text: '规划航线' })
  // ★ 2026-09-21 需求方："出航通道…现在是完全跟踪、把所有的航路都包裹住的，**只需要出集结区后包裹航路 5km 即可**"
  //   → 通道**不再是全程带**：只覆盖**航路起点之后 5 km**（沿航路累计，甲口径）；
  //   **宽度不变**（仍 1000 m），**航路线本身照旧画全程**（上面那行没动）。
  const band = corridorBand(cumulativeSlice(line, CORRIDOR_TRACK_KM), corridorWidthM)
  if (band.length >= 3) {
    draw.polygon({
      id: 'PLAN:corridor', ring: band, color: '#3b82f6', fillColor: '#3b82f6',
      fillOpacity: 0.08, strokeWidthPx: 1.4, dashed: true,
      // 2026-09-21 需求方："修改出航通道标注名称，只需要出航通道即可，删除（1000m）"
      //   —— 宽度仍按 1000 m 生效（`corridorWidthM`），只是**不再写进标注**。
      text: '出航通道',
    })
  }
  return { ok: true, points: line.length, lengthKm: lenKm, avoided: obstacles.length }
}
