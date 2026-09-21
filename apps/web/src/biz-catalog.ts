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
  /**
   * **指定尺寸模式**（2026-09-21 需求）。
   *
   * 有这一项的条目，点了**不进入鼠标绘制**：先点一个**中心点**，然后在合并框里**填尺寸与标注名称**，
   * 确定即画出（需求方原话："点击一个中心点后，用户指定区域长宽 / 半径大小 / 每格长度，自动绘制"）。
   *
   * 为什么做成**独立条目**而不是同一个条目里再选模式：需求方对四种交互都在说"两种模式"，
   * 而菜单里一条 = 一种确定的交互，点下去不用再选一次（避免"点了还要再弹一层"）。
   * 条目名 = 原名 + 后缀（例：任务区（长宽）），一眼能看出它要填什么。
   */
  size?: BizSizeSpec
}

/**
 * 尺寸模式的**字段定义**（框里显示哪几个数字框，以及它们的单位 / 默认值）。
 *
 * 只要 `fields`，不在这里写业务语义 —— "填完画成什么"由 `SITUATION` 侧的尺寸提交函数决定，
 * 那需要 2D 绘制接口（本文件不引 `draw`，见文件头"分界线"）。
 */
export interface BizSizeSpec {
  fields: { key: string; label: string; def: number; unit: string; min: number }[]
  /** 图上默认标注名称（与手动模式同款：任务区 / 我方集结区 …） */
  defaultLabel: string
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

/**
 * 纯几何原语条目（点 / 线 / 闭合线 / 真面 / 圆 / 椭圆） 直接照抄模块清单的缺省样式。
 * 2026-09-20 需求：模块原语的「线」「面」在业务层叫「标注线」「标注面」（菜单与图上默认文本都用这个名）。
 */
const GEO_NAME: Record<string, string> = { line: '标注线', polygon: '标注面' }

function geoEntries(): BizEntry[] {
  const menuOf = (g: string): BizEntry['menu'] => (g === '点' ? 'create' : g === '线' ? 'draw' : 'area')
  return PRIMITIVE_CATALOG.map((d) => ({
    key: `geo:${d.key}`,
    label: GEO_NAME[d.key] ?? d.name,
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
 * **指定尺寸模式的条目**（2026-09-21 需求方逐条点名要的五个）。
 *
 * 交互：点中心点 → 合并框里填尺寸 + 标注名称 → 确定画出（**不走鼠标第二下**）。
 * `key` 沿用原名加 `:size` 后缀；`start.geo` 只用来告诉模块"要点几个点"——
 * 长宽/半径类的都是 `point`（点一下中心就够），九宫格也是 `point`。
 * 真正"填完画成什么"由 `SituationScreen` 的尺寸提交函数按 `key` 分派（要 2D 绘制接口，见文件头）。
 *
 * ⚠️ 定义位置：**必须在这批条目被引用之前**（`PRESETS` 末尾与 `BIZ_CATALOG` 都在它后面），
 * 否则是 TDZ 错误（`const` 不提升）。所以这段放在 `PRESETS` 之前。
 */
const SIZE_ENTRIES: BizEntry[] = [
  {
    key: 'biz:task-area:size', label: '任务区（长宽）', note: '点中心 → 填长宽（km）→ 自动画出矩形',
    menu: 'area',
    start: { geo: 'point', color: '#ef4444', fillColor: '#ef4444', fillOpacity: 0.1, widthPx: 2 },
    size: {
      fields: [
        { key: 'w', label: '长（东西向）', def: 20, unit: 'km', min: 0.1 },
        { key: 'h', label: '宽（南北向）', def: 10, unit: 'km', min: 0.1 },
      ],
      defaultLabel: '任务区',
    },
  },
  {
    key: 'biz:assembly:size', label: '我方集结区（长宽）', note: '点中心 → 填长宽（km）→ 自动画出矩形',
    menu: 'area',
    start: { geo: 'point', color: '#22c55e', fillColor: '#22c55e', fillOpacity: 0.1, widthPx: 2 },
    size: {
      fields: [
        { key: 'w', label: '长（东西向）', def: 20, unit: 'km', min: 0.1 },
        { key: 'h', label: '宽（南北向）', def: 10, unit: 'km', min: 0.1 },
      ],
      defaultLabel: '我方集结区',
    },
  },
  {
    key: 'biz:ring:size', label: '距离环（半径）', note: '点中心 → 填半径（km）→ 自动画出三圈',
    menu: 'draw',
    start: { geo: 'point' },
    size: {
      // 距离环的"大小"就是最外圈半径；内两圈按 1/3、2/3 分（与手动模式同一口径，见上面 biz:ring）
      fields: [{ key: 'r', label: '半径（km）', def: 5, unit: 'km', min: 0.1 }],
      defaultLabel: '距离环',
    },
  },
  {
    key: 'biz:bearing-ring:size', label: '方位圈（半径）', note: '点中心 → 填半径（km）→ 自动画出（刻度 30°）',
    menu: 'draw',
    start: { geo: 'point' },
    size: {
      fields: [{ key: 'r', label: '半径（km）', def: 8, unit: 'km', min: 0.1 }],
      defaultLabel: '方位圈',
    },
  },
  {
    key: 'biz:grid:size', label: '九宫格（每格长度）', note: '点中心 → 填每格长度与行列 → 自动画出',
    menu: 'draw',
    start: { geo: 'point' },
    size: {
      fields: [
        { key: 'r', label: '每格长度（km）', def: 2, unit: 'km', min: 0.1 },
        { key: 'rows', label: '行', def: 3, unit: '', min: 1 },
        { key: 'cols', label: '列', def: 3, unit: '', min: 1 },
      ],
      defaultLabel: '九宫格',
    },
  },
]

/**
 * **"两种模式"的五组分组的定义**（2026-09-21 需求方最终口径）。
 *
 * 需求原话："任务区重做，把之前的任务区变成二级菜单，点击后出现任务区（手动点位）、
 * 任务区（自动长宽）；集结区同上，其他刚刚加的同上。"
 *
 * 于是这五条在菜单里**不再是可点条目，而是"带子项的分组"**（工具条在最右侧展开第三列）：
 *   手动模式 = 原来的交互（多点围合 / 两下：中心→半径）；
 *   自动模式 = 点中心 → 在合并框里填尺寸 + 标注名称 → 确定画出（尺寸逻辑一个字没改）。
 *
 * ⚠️ 定义位置：这几段**必须在 `BIZ_CATALOG` 之前**（`const` 不提升，否则 TDZ 报错：
 *   "Block-scoped variable 'MANUAL_ENTRIES' used before its declaration" —— 实测踩过）。
 */
export interface BizModeGroup {
  key: string
  label: string
  /** 分组自己的说明（悬停提示） */
  note: string
  /** 两个模式（手动 / 自动），顺序即显示顺序 */
  modes: BizEntry[]
}

/** 五组的**手动模式**条目（原来的交互，key 加 `:manual` 后缀；不在扁平菜单里出现） */
const MANUAL_ENTRIES: BizEntry[] = [
  {
    key: 'biz:task-area:manual', label: '任务区（手动点位）', note: '多点围合：红色实线区域',
    menu: 'area', start: { geo: 'polygon', color: '#ef4444', fillColor: '#ef4444', fillOpacity: 0.1, widthPx: 2, dashed: false },
  },
  {
    key: 'biz:assembly:manual', label: '我方集结区（手动点位）', note: '多点围合：绿色实线区域',
    menu: 'area', start: { geo: 'polygon', color: '#22c55e', fillColor: '#22c55e', fillOpacity: 0.1, widthPx: 2, dashed: false },
  },
  {
    key: 'biz:ring:manual', label: '距离环（手动半径）', note: '两下：中心 → 最外圈半径（三圈按 1/3、2/3、1 分）',
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
    key: 'biz:bearing-ring:manual', label: '方位圈（手动半径）', note: '两下：中心 → 半径',
    menu: 'draw',
    start: {
      geo: 'circle',
      make: makeKind('annulus', (pts, r) => ({ kind: 'bearing-ring', lng: pts[0].lng, lat: pts[0].lat, radiusKm: r || 8, bearing: 30 }), 'bearingring', '方位圈'),
    },
  },
  {
    key: 'biz:grid:manual', label: '九宫格（手动边长）', note: '两下：中心 → 边长',
    menu: 'draw',
    start: {
      geo: 'circle',
      make: makeKind('annulus', (pts, r) => ({ kind: 'grid', lng: pts[0].lng, lat: pts[0].lat, rows: 3, cols: 3, dashed: true, radiusKm: r || 2 }), 'grid', '九宫格'),
    },
  },
]

/** 五组：分组名 + 两个模式（手动 / 自动）。自动那条直接引用 `SIZE_ENTRIES` 里的同 key 条目 */
export const MODE_GROUPS: BizModeGroup[] = [
  { key: 'biz:task-area', label: '任务区', note: '两种模式：手动点位 / 自动长宽', modes: ['biz:task-area:manual', 'biz:task-area:size'].map(bizEntryOf) },
  { key: 'biz:assembly', label: '我方集结区', note: '两种模式：手动点位 / 自动长宽', modes: ['biz:assembly:manual', 'biz:assembly:size'].map(bizEntryOf) },
  { key: 'biz:ring', label: '距离环', note: '两种模式：手动半径 / 自动半径', modes: ['biz:ring:manual', 'biz:ring:size'].map(bizEntryOf) },
  { key: 'biz:bearing-ring', label: '方位圈', note: '两种模式：手动半径 / 自动半径', modes: ['biz:bearing-ring:manual', 'biz:bearing-ring:size'].map(bizEntryOf) },
  { key: 'biz:grid', label: '九宫格', note: '两种模式：手动边长 / 自动每格', modes: ['biz:grid:manual', 'biz:grid:size'].map(bizEntryOf) },
]

/**
 * 按 key 取条目（**模块体里建表时用**，不依赖 `BIZ_CATALOG` 的赋值时机）。
 *
 * 为什么要单独一个：`MODE_GROUPS` 要按 key 拿条目，而 `BIZ_CATALOG` 是另一个 `const`
 * —— 直接用 `bizEntry` 会撞上 TDZ（就是上面那条注释里记的错）。
 * 这里查的三份数组都在它之前声明，顺序安全；`BIZ_CATALOG` 也是这三份的并集，口径一致。
 * 找不到**直接抛**（宁可启动就报，也不要菜单里静默少一项）。
 */
function bizEntryOf(key: string): BizEntry {
  const hit = [...SIZE_ENTRIES, ...MANUAL_ENTRIES].find((e) => e.key === key)
  if (!hit) throw new Error(`biz-catalog: 没有这个条目 key = ${key}`)
  return hit
}

/** 分组键 → 分组（工具条点击时用） */
export const modeGroupOf = (key: string): BizModeGroup | undefined => MODE_GROUPS.find((g) => g.key === key)

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

/** 全部条目：几何原语 + 业务预设 + **尺寸模式 5 条** + **手动模式 5 条**（菜单顺序即此顺序） */
export const BIZ_CATALOG: BizEntry[] = [...geoEntries(), ...PRESETS, ...SIZE_ENTRIES, ...MANUAL_ENTRIES]

/** 三个子菜单（键与工具栏的 新建 / 区域 / 标绘 对齐） */
export const BIZ_MENUS: Record<string, BizEntry[]> = {
  create: BIZ_CATALOG.filter((e) => e.menu === 'create'),
  area: BIZ_CATALOG.filter((e) => e.menu === 'area'),
  draw: BIZ_CATALOG.filter((e) => e.menu === 'draw'),
}

export const bizEntry = (key: string): BizEntry | undefined => BIZ_CATALOG.find((e) => e.key === key)

/**
 * **四个一级分类**（用户 2026-09-19："新建、区域、标绘，合并为一个功能叫「新建」，一级子菜单显示分类，
 * 二级子菜单才显示当前的内容"）。
 *
 * 分类按**几何维度**走：点 / 线 / 面；几何表达不了的那一批（距离环、方位圈、九宫格、军标）单列「标绘」。
 *
 * ★ 2026-09-21：需求方要"两种模式"，最终口径是**三级菜单**（见 `MODE_GROUPS`）——
 *   菜单里显示的是**分组名**（任务区 / 我方集结区 / 距离环 / 方位圈 / 九宫格），
 *   点分组才在最右侧展开两个模式（手动 / 自动）。所以：
 *   · 一级分类里放的是**分组键**（`biz:task-area` 等），工具条认它是"带 items 的分组"；
 *   · 真正可执行的模式条目由 `MODE_GROUPS[].modes` 提供；
 *   · 扁平几何原语（标注面 / 标注线…）与军标仍是单条目。
 *   项数：点 2 + 线 2 + 面 4（标注面 / 任务区组 / 集结区组 / 威胁区）+ 标绘 10（3 组 + 7 军标）= **18**，
 *   与合并前的项数一致 —— 增加的是"层级"，不是条目。
 *
 * 为什么用 `keys` 显式列、而不是按 `menu` 字段分组：`menu` 是**旧版工具栏那三格**（新建/区域/标绘），
 * 用户点名要"另起分类名"；显式列也方便单改某一类。`BIZ_MENUS` 原样保留（没有别的引用，留着对照）。
 */
export interface BizGroup {
  key: string
  label: string
  items: BizEntry[]
}

const GROUP_KEYS: { key: string; label: string; keys: string[] }[] = [
  {
    key: 'point', label: '点',
    keys: ['biz:mark-point', 'biz:target-point'],
  },
  {
    key: 'line', label: '线',
    keys: ['geo:line', 'biz:route'],
  },
  {
    key: 'area', label: '面',
    keys: [
      'geo:polygon',
      // 2026-09-21：这三条里，前两条是**分组**（点开有两个模式可选），第三条是可点条目 —— 见 MODE_GROUPS
      'biz:task-area', 'biz:assembly', 'biz:threat-area',
    ],
  },
  {
    key: 'mark', label: '标绘',
    keys: [
      // 同上：前三条是分组
      'biz:ring', 'biz:bearing-ring', 'biz:grid',
      'biz:sym-infantry', 'biz:sym-armor', 'biz:sym-artillery', 'biz:sym-missile',
      'biz:sym-radar', 'biz:sym-command', 'biz:sym-recon',
    ],
  },
]

/** 一级分类（分类键 + 分类名 + 该类条目），供态势屏「新建」的两级菜单直接使用 */
export const BIZ_GROUPS: BizGroup[] = GROUP_KEYS.map((g) => ({
  key: g.key,
  label: g.label,
  items: g.keys.map((k) => bizEntry(k)).filter((e): e is BizEntry => !!e),
}))

/** 文本框样式（模块给的三种，界面直接列） */
export const TEXT_STYLE_OPTIONS: { key: TextStyle; name: string; note: string }[] = TEXT_STYLES

/**
 * **业务图元 id → 业务名**（供"图元显隐"面板兜底显示用；面板只在图元自己没有文本时才走到这里）。
 *
 * id 的构成：由 `makeKind()`（`map-2d/src/primitives/draw-api.ts`）造出来的业务图元长这样 ——
 * `B:<条目 key 去掉 biz:/geo: 前缀>:<自增序号>`，例如 `B:task-area:manual:3`、`B:ring:1`。
 *
 * ⚠️ **2026-09-21 修的缺陷**（排查"名称和之前任务区不一样"时发现的）：
 *   原实现是 `BIZ_CATALOG.find((e) => id.startsWith('B:' + stripped))` —— 两个问题：
 *   ① **前缀匹配会串**：`B:task-area:manual:3` 与目录里更短的 `biz:task-area`（label = `任务区`）
 *      也构成前缀关系，而 `find` 返回的是**先出现的那个**（短键在前）→ 面板把
 *      「任务区（手动点位）」显示成 `任务区`；
 *   ② **键里的冒号会打断匹配**：`biz:ring:manual` 对应的图元 id 是 `B:ring:1`
 *      （`makeKind` 用的 key 是 `ring`），`B:ring:manual` 并不是 `B:ring:1` 的前缀 → 落空。
 *   现在改成：**先按"精确一段"匹配（`B:<key>:`），再退回整段相等（`B:<key>`）**，
 *   并把目录**按键长从长到短**排一遍（长的更具体，必须先试），于是 `:manual` / `:size` 这类
 *   带后缀的条目不会再被它们的短前缀抢走。
 *
 * 影响面：只影响"面板里兜底显示的名字"（正常路径是图元自己的 `text`/`label`/`name` → 绑定文本 → 这里）。
 */
export function bizNameOf(id: string): string | null {
  const byKeyLen = [...BIZ_CATALOG].sort(
    (a, b) => b.key.replace(/^biz:|^geo:/, '').length - a.key.replace(/^biz:|^geo:/, '').length,
  )
  for (const e of byKeyLen) {
    const k = e.key.replace(/^biz:|^geo:/, '')
    if (id.startsWith(`B:${k}:`) || id === `B:${k}`) return e.label
  }
  return null
}

// 让 `draw` 被引用到（几何原语由模块的 setGeometry 内部调用；这里保留 re-export 供业务层直接用）
export { draw }
