// mission-app · apps/web/src/biz-catalog.ts
//
// **业务图元目录** —— 按改造后的 map-2d 重新包一层业务语义。
//
// 分界线（这是本次业务层改造的核心）：
//   · **绘制交互**（落点 / 两下算尺寸 / 多点收笔 / 预览 / Esc·Enter）→ 模块负责
//   · **画出来是什么业务物件**（任务区？目标点？距离环？）→ 业务层负责，写在本文件
//   · 落在中间的那条缝由模块的 `setGeometry({ make })` 钩子缝合：
//     交互照旧在模块，造什么由本文件的 `make` 决定。
//
// 两类条目：
//   · `geo`  —— 用 map-2d 的**几何原语**画（点/线/闭合线/真面/圆/椭圆）＋ 预设样式 + 预设文本
//   · `make` —— 几何原语表达不了的（军标符号 / 距离环 / 扫描扇区 / 集群 / 脉冲 / 无人机标记），
//               用底层 `MapDraw.add(kind, item)` 造，**同样借用几何原语的交互**（例如距离环借"两下"）
import { PRIMITIVE_CATALOG, TEXT_STYLES, MapDraw, bindTextTo, draw } from 'map-2d'
import type { GeometryKey, TextStyle } from 'map-2d'

/** 起一次绘制所需的全部信息（宿主把它喂给 `mapCommands.setGeometry`） */
export interface BizStart {
  /** 借哪种几何交互（点一下 / 两下 / 多点 / 围合） */
  geo: GeometryKey
  color?: string
  widthPx?: number
  sizePx?: number
  dashed?: boolean
  fillColor?: string
  fillOpacity?: number
  /** 非几何原语的业务物件：由这里造出来（返回图元 id） */
  make?: (pts: { lng: number; lat: number }[], radiusKm: number) => string | null
}

export interface BizEntry {
  key: string
  label: string
  note: string
  /** 归到工具栏哪一格（新建 / 区域 / 标绘） */
  menu: 'create' | 'area' | 'draw'
  start: BizStart
}

let seq = 0
const nid = (k: string) => `B:${k}:${++seq}`

/** 造一个"模块种类"的业务图元，并把名字挂成**绑定文本框**（跟随 + 联动） */
function makeKind(
  kind: 'pulse' | 'drone' | 'scan' | 'cluster' | 'symbol' | 'annulus' | 'target',
  spec: (pts: { lng: number; lat: number }[], radiusKm: number, id: string) => Record<string, unknown>,
  key: string,
  label: string,
): (pts: { lng: number; lat: number }[], radiusKm: number) => string | null {
  return (pts, radiusKm) => {
    if (!pts.length) return null
    const id = nid(key)
    const ok = MapDraw.add(kind as never, { id, ...spec(pts, radiusKm, id) } as never)
    if (!ok) return null
    bindTextTo(kind as never, id, label, 'tag')
    return id
  }
}

/** 纯几何原语条目（点 / 线 / 闭合线 / 真面 / 圆 / 椭圆）—— 直接照抄模块清单的缺省样式 */
function geoEntries(): BizEntry[] {
  const menuOf = (g: string): BizEntry['menu'] => (g === '点' ? 'create' : g === '线' ? 'draw' : 'area')
  return PRIMITIVE_CATALOG.map((d) => ({
    key: `geo:${d.key}`,
    label: d.name,
    note: `${d.geometry} 原语 · ${d.interaction === 'click' ? '落点即建' : d.interaction === 'two-point' ? '两下：中心 → 尺寸' : '多点，双击/Enter 结束'}`,
    menu: menuOf(d.geometry),
    start: {
      geo: d.key,
      color: d.defaults.color,
      widthPx: d.defaults.widthPx,
      sizePx: d.defaults.sizePx,
      dashed: d.defaults.dashed,
    },
  }))
}

/**
 * **业务预设** —— 同一个几何交互，配上业务默认样式与名字。
 *
 * 这些就是"我要画一个什么"的清单：任务区 / 威胁区 / 目标点 / 军标 / 距离环…
 */
const PRESETS: BizEntry[] = [
  // ---------------------------------------------------------------- 新建（点类）
  {
    key: 'biz:mark-point', label: '标注点', note: '落点即建：带名字的点',
    menu: 'create', start: { geo: 'point', sizePx: 6, color: '#eaf6ff' },
  },
  {
    key: 'biz:target-point', label: '目标点', note: '落点即建：目标点（红色）',
    menu: 'create',
    start: {
      geo: 'point', sizePx: 7, color: '#ef4444',
      make: makeKind('target', (pts) => ({ lng: pts[0].lng, lat: pts[0].lat }), 'target', '目标点'),
    },
  },
  {
    key: 'biz:pulse', label: '脉冲点', note: '落点即建：带扩散动效的脉冲圈',
    menu: 'create',
    start: {
      geo: 'point',
      make: makeKind('pulse', (pts) => ({ lng: pts[0].lng, lat: pts[0].lat, radiusKm: 3 }), 'pulse', '脉冲点'),
    },
  },
  {
    key: 'biz:drone-mark', label: '无人机标记', note: '落点即建：**手动**无人机标记（与遥测真机不是一回事）',
    menu: 'create',
    start: {
      geo: 'point',
      make: makeKind('drone', (pts) => ({ lng: pts[0].lng, lat: pts[0].lat, type: 'optical' }), 'dronemark', '无人机标记'),
    },
  },

  // ---------------------------------------------------------------- 区域（面类）
  {
    key: 'biz:task-area', label: '任务区', note: '多点围合：红色实线区域',
    menu: 'area', start: { geo: 'polygon', color: '#ef4444', fillColor: '#ef4444', fillOpacity: 0.1, widthPx: 2, dashed: false },
  },
  {
    key: 'biz:assembly', label: '我方集结区', note: '多点围合：绿色实线区域',
    menu: 'area', start: { geo: 'polygon', color: '#22c55e', fillColor: '#22c55e', fillOpacity: 0.1, widthPx: 2, dashed: false },
  },
  {
    key: 'biz:threat-area', label: '威胁区', note: '多点围合：红色虚线区域',
    menu: 'area', start: { geo: 'polygon', color: '#ef4444', fillColor: '#ef4444', fillOpacity: 0.12, widthPx: 2, dashed: true },
  },
  {
    key: 'biz:target-zone', label: '目标区', note: '两下：中心 → 半径（红色实线圆）',
    menu: 'area', start: { geo: 'circle', color: '#ef4444', fillColor: '#ef4444', fillOpacity: 0.12, widthPx: 2, dashed: false },
  },
  {
    key: 'biz:search-zone', label: '搜索区', note: '两下：中心 → 半径（虚线圆）',
    menu: 'area', start: { geo: 'circle', color: '#22d3ee', fillColor: '#22d3ee', fillOpacity: 0.08, widthPx: 2, dashed: true },
  },
  {
    key: 'biz:scan-zone', label: '扫描扇区', note: '两下：中心 → 半径',
    menu: 'area',
    start: {
      geo: 'circle',
      make: makeKind('scan', (pts, r) => ({ lng: pts[0].lng, lat: pts[0].lat, radiusKm: r || 5 }), 'scan', '扫描扇区'),
    },
  },
  {
    key: 'biz:cluster-zone', label: '集群范围', note: '落点即建：集群标绘',
    menu: 'area',
    start: {
      geo: 'point',
      make: makeKind('cluster', (pts) => ({ lng: pts[0].lng, lat: pts[0].lat }), 'cluster', '集群范围'),
    },
  },

  // ---------------------------------------------------------------- 标绘（线 / 圈层 / 军标）
  {
    key: 'biz:route', label: '航线', note: '多点连线：蓝色实线',
    menu: 'draw', start: { geo: 'line', color: '#38bdf8', widthPx: 2, dashed: false },
  },
  {
    key: 'biz:track', label: '航迹', note: '多点连线：青色虚线',
    menu: 'draw', start: { geo: 'line', color: '#22d3ee', widthPx: 1.6, dashed: true },
  },
  {
    key: 'biz:link', label: '链路', note: '多点连线：紫色细线（两点即一条链路）',
    menu: 'draw', start: { geo: 'line', color: '#a855f7', widthPx: 1.2, dashed: false },
  },
  {
    key: 'biz:ring', label: '距离环', note: '两下：中心 → 最外圈半径（三圈按 1/3、2/3、1 分）',
    menu: 'draw',
    start: {
      geo: 'circle',
      make: makeKind('annulus', (pts, r) => {
        const R = r || 5
        return { kind: 'ring', lng: pts[0].lng, lat: pts[0].lat, radiusKmList: [R / 3, (R * 2) / 3, R] }
      }, 'ring', '距离环'),
    },
  },
  {
    key: 'biz:bearing-ring', label: '方位圈', note: '两下：中心 → 半径',
    menu: 'draw',
    start: {
      geo: 'circle',
      make: makeKind('annulus', (pts, r) => ({ kind: 'bearing-ring', lng: pts[0].lng, lat: pts[0].lat, radiusKm: r || 8, bearing: 30 }), 'bearingring', '方位圈'),
    },
  },
  {
    key: 'biz:bearing-line', label: '方位线', note: '两下：起点 → 方向与长度',
    menu: 'draw',
    start: {
      geo: 'circle',
      make: makeKind('annulus', (pts, r) => {
        const [a, b] = pts
        const dLng = (b.lng - a.lng) * Math.cos((a.lat * Math.PI) / 180)
        const dLat = b.lat - a.lat
        const bearing = (((Math.atan2(dLng, dLat) * 180) / Math.PI) + 360) % 360
        return { kind: 'bearing-line', lng: a.lng, lat: a.lat, bearing, lengthKm: r || 10 }
      }, 'bearingline', '方位线'),
    },
  },
  {
    key: 'biz:grid', label: '九宫格', note: '两下：中心 → 边长',
    menu: 'draw',
    start: {
      geo: 'circle',
      make: makeKind('annulus', (pts, r) => ({ kind: 'grid', lng: pts[0].lng, lat: pts[0].lat, rows: 3, cols: 3, dashed: true, radiusKm: r || 2 }), 'grid', '九宫格'),
    },
  },
  // 军标符号：7 种，一次列全
  ...[
    ['infantry', '步兵'], ['armor', '装甲'], ['artillery', '炮兵'], ['missile', '导弹'],
    ['radar', '雷达'], ['command', '指挥所'], ['recon', '侦察'],
  ].map(([sym, cn]): BizEntry => ({
    key: `biz:sym-${sym}`, label: `军标·${cn}`, note: '落点即建：国军标标绘符号',
    menu: 'draw',
    start: {
      geo: 'point',
      make: makeKind('symbol', (pts) => ({ lng: pts[0].lng, lat: pts[0].lat, symbol: sym }), `sym${sym}`, `军标·${cn}`),
    },
  })),
]

/** 全部条目：**几何原语在前、业务预设在**后（菜单顺序即此顺序） */
export const BIZ_CATALOG: BizEntry[] = [...geoEntries(), ...PRESETS]

/** 三个子菜单（键与工具栏的 新建 / 区域 / 标绘 对齐） */
export const BIZ_MENUS: Record<string, BizEntry[]> = {
  create: BIZ_CATALOG.filter((e) => e.menu === 'create'),
  area: BIZ_CATALOG.filter((e) => e.menu === 'area'),
  draw: BIZ_CATALOG.filter((e) => e.menu === 'draw'),
}

export const bizEntry = (key: string): BizEntry | undefined => BIZ_CATALOG.find((e) => e.key === key)

/** 文本框样式（模块给的三种，界面直接列） */
export const TEXT_STYLE_OPTIONS: { key: TextStyle; name: string; note: string }[] = TEXT_STYLES

/** 供"图元显隐"面板之外的统计用：业务图元 id → 业务名 */
export function bizNameOf(id: string): string | null {
  const hit = BIZ_CATALOG.find((e) => id.startsWith(`B:${e.key.replace(/^biz:|^geo:/, '')}`))
  return hit?.label ?? null
}

// 让 `draw` 被引用到（几何原语由模块的 setGeometry 内部调用；这里保留 re-export 供业务层直接用）
export { draw }
