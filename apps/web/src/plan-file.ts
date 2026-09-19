// mission-app · apps/web/src/plan-file.ts
//
// **计划文件**（★ 2026-09-18，需求方："每次启动态势界面后……显示什么都没有画的地图，
//   我手动选择计划文件，读取我选择的计划文件，来进行绘制"）。
//
// 为什么要文件：以前态势屏一进来就 `drawScenario()` 画死在那份内联常量上，需求方要的是
// **空地图 + 自己挑计划**。所以把"画什么"从代码里搬到一个可读写的 JSON 里。
//
// 文件格式（与 map-2d 的 `draw.*` 参数**一一对应**，不做二次翻译）：
// {
//   "schemaVersion": "1.0.0",
//   "name": "场景1 · 敏捷拒止布控",
//   "view": { "center": [116.527, 39.78], "zoom": 11 },   // 可选：打开后把视角挪过去
//   "items": [
//     { "kind": "polygon", "id": "PLAN:task", "ring": [[lng,lat],...], "color": "#ef4444",
//       "fillColor": "#ef4444", "fillOpacity": 0.1, "strokeWidthPx": 2, "dashed": false, "text": "任务区" },
//     { "kind": "line", "id": "PLAN:route", "points": [[lng,lat],...], "color": "#38bdf8",
//       "widthPx": 2, "dashed": false, "text": "规划航线" },
//     { "kind": "point", "id": "PLAN:p1", "lng": 116.5, "lat": 39.8, "color": "#ffd400", "sizePx": 6, "text": "要点" }
//   ]
// }
//
// ⚠️ 这个文件用编辑工具改，**不要过 PowerShell 的 Get-Content/Set-Content**：无 BOM 的 .ts
//    会被按 ANSI 读，中文变乱码、引号还会被吃掉（本项目已因此损坏过多次）。
import { draw, MapDraw, mapInstance } from 'map-2d'

/**
 * 计划里的一条图形（kind 决定用哪个绘制函数）
 *
 * ★ 2026-09-18：**保存改成"整图快照"**（见下面的 `primitives`）—— 因为需求方发现
 *   "手动在地图上标绘的东西存不下来"：旧格式只存 id 以 `PLAN:` 开头的图元，
 *   而手绘的 id 是 `area-1` / `route-2` 这种，于是被整批丢掉、提示"没有可保存的计划图元"。
 *   现在保存走 map-2d 的 `MapDraw.export()`（逐字段原样），**用户画什么都能存、打开能还原**。
 *   `items` 这种简写格式仍然**支持打开**（早先的示例计划文件就是它）。
 */
export type PlanItem =
  | ({ kind: 'polygon'; id: string; ring: [number, number][]; text?: string } & PlanStyle)
  | ({ kind: 'line'; id: string; points: [number, number][]; text?: string } & PlanStyle)
  | ({ kind: 'point'; id: string; lng: number; lat: number; text?: string } & PlanStyle)

interface PlanStyle {
  /** 描边色（线的颜色） */
  color?: string
  fillColor?: string
  fillOpacity?: number
  strokeWidthPx?: number
  widthPx?: number
  dashed?: boolean
  sizePx?: number
}

export interface PlanFile {
  schemaVersion?: string
  name?: string
  view?: { center?: [number, number]; zoom?: number }
  /** 简写格式（示例计划文件用）：逐条图形 */
  items?: PlanItem[]
  /** ★ 整图快照格式（保存计划用）：`MapDraw.export()` 的原样结果，按图元种类分组 */
  primitives?: Record<string, unknown[]>
}

/**
 * **可保存的图元种类** = 用户画得出来的那些。
 * 排除遥测驱动的（`drone` / `track` / `target` / `link` / `scan` / `pulse` / `cluster`）：
 * 它们由数据流每拍重灌，存下来没意义、还原时还会和实时数据打架。
 */
const SAVABLE_KINDS = ['area', 'shape', 'route', 'annulus', 'symbol', 'label'] as const

/** 「清空全部/打开计划」时**保留**的种类（遥测驱动，删了下一拍就回来） */
const KEEP_ON_CLEAR = ['drone', 'track', 'target', 'link', 'scan', 'pulse', 'cluster'] as const

/** 计划图元的 id 前缀 —— 打开新计划时**只清自己的**，不动用户手画的东西 */
const PLAN_PREFIX = 'PLAN:'

/** 计划里 id 缺失时补一个（保证可清、可重复打开） */
function withId(it: PlanItem, i: number): PlanItem {
  if (it.id && it.id.startsWith(PLAN_PREFIX)) return it
  return { ...it, id: `${PLAN_PREFIX}${it.kind}:${(it.id ?? i).toString().replace(/^PLAN:/, '')}` } as PlanItem
}

/** 校验：不是对象、既没有 items 也没有 primitives → 报错（不猜、不静默画一半） */
export function parsePlan(text: string): { plan?: PlanFile; error?: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { error: `不是合法 JSON：${String((e as Error)?.message ?? e)}` }
  }
  const p = raw as PlanFile
  if (!p || typeof p !== 'object') return { error: 'JSON 顶层不是对象' }
  const hasItems = Array.isArray(p.items)
  const hasSnapshot = !!p.primitives && typeof p.primitives === 'object'
  if (!hasItems && !hasSnapshot) return { error: '既没有 items 数组、也没有 primitives 快照（文件里没有任何图元）' }
  if (hasItems) {
    const bad = (p.items as PlanItem[]).findIndex((x) => !x || typeof x !== 'object' || !(x as PlanItem).kind)
    if (bad >= 0) return { error: `items[${bad}] 缺少 kind` }
  }
  return { plan: p }
}

/**
 * **清空地图上所有图元**（★ 需求方："打开计划时，先优先删除所有图元，再画"）。
 * 保留 `KEEP_ON_CLEAR`（无人机/航迹/目标…由数据流驱动，删了下一拍就回来）。
 * @returns 清掉的条数
 */
export function clearAllPrimitives(): number {
  let n = 0
  const all = ['area', 'shape', 'route', 'annulus', 'symbol', 'label', 'drone', 'track', 'target', 'link', 'scan', 'pulse', 'cluster']
  for (const kind of all) {
    if ((KEEP_ON_CLEAR as readonly string[]).includes(kind)) continue
    n += (MapDraw.list(kind as never) as unknown as unknown[]).length
    MapDraw.clear(kind as never)
  }
  return n
}

/** 清掉上一次打开的计划（幂等；保留手绘与遥测 —— 给"重画同一份计划"用） */
export function clearPlan(): void {
  for (const ids of Object.values(draw.list())) {
    for (const id of ids ?? []) {
      if (typeof id === 'string' && id.startsWith(PLAN_PREFIX)) draw.remove(id)
    }
  }
}

/**
 * **把计划画到地图上**。
 *
 * ★ 2026-09-18（需求方："打开计划时，先优先删除所有图元，再画"）：
 *   **先清空所有图元**（保留遥测驱动的 drone/track/target…），再按文件内容画 ——
 *   这样不会出现"上一份计划的图形还留在图上"的叠加。
 *
 * 两种格式都认：`primitives`（整图快照，保存计划产出的）与 `items`（简写，示例计划文件用）。
 * @returns 画成功的条数与失败明细（失败**如实报出**，不静默跳过）
 */
export function applyPlan(plan: PlanFile): { drawn: number; failed: string[]; cleared: number } {
  // ① 先清空（需求方要求）
  const cleared = clearAllPrimitives()

  // ② 整图快照格式：直接交给模块还原（逐字段原样，连样式一起回来）
  if (plan.primitives && typeof plan.primitives === 'object') {
    const snap: Record<string, unknown[]> = {}
    for (const k of SAVABLE_KINDS) {
      const arr = plan.primitives[k]
      if (Array.isArray(arr)) snap[k] = arr
    }
    MapDraw.load(snap as never)
  }

  // ③ 简写格式：逐条用绘制函数画（早先的示例计划文件）
  const failed: string[] = []
  let drawn = 0
  const items = Array.isArray(plan.items) ? plan.items : []
  items.forEach((raw, i) => {
    const it = withId(raw, i)
    try {
      if (it.kind === 'polygon') {
        if (!Array.isArray(it.ring) || it.ring.length < 3) throw new Error('ring 少于 3 个点')
        draw.polygon({
          id: it.id, ring: it.ring, color: it.color ?? '#38bdf8', fillColor: it.fillColor ?? it.color,
          fillOpacity: it.fillOpacity ?? 0.1, strokeWidthPx: it.strokeWidthPx ?? 2, dashed: !!it.dashed,
          ...(it.text ? { text: it.text } : {}),
        })
      } else if (it.kind === 'line') {
        if (!Array.isArray(it.points) || it.points.length < 2) throw new Error('points 少于 2 个点')
        draw.line({
          id: it.id, points: it.points, color: it.color ?? '#38bdf8', widthPx: it.widthPx ?? 2,
          dashed: !!it.dashed, ...(it.text ? { text: it.text } : {}),
        })
      } else if (it.kind === 'point') {
        if (typeof it.lng !== 'number' || typeof it.lat !== 'number') throw new Error('lng/lat 不是数字')
        draw.point({
          id: it.id, lng: it.lng, lat: it.lat, color: it.color ?? '#ffd400', sizePx: it.sizePx ?? 6,
          ...(it.text ? { text: it.text } : {}),
        })
      } else {
        throw new Error(`不认识的 kind=${String((it as { kind?: string }).kind)}`)
      }
      drawn++
    } catch (e) {
      failed.push(`items[${i}]（${String((it as { id?: string }).id)}）：${String((e as Error)?.message ?? e)}`)
    }
  })

  // ④ 视角：文件里带了就跳过去
  const v = plan.view
  if (v?.center && Array.isArray(v.center) && typeof v.zoom === 'number') {
    mapInstance.current?.jumpTo({ center: v.center, zoom: v.zoom })
  }
  return { drawn: drawn + (plan.primitives ? countSnapshot(plan.primitives) : 0), failed, cleared }
}

/** 数一数快照里有多少条图元（只为回报"画了几个"） */
function countSnapshot(prims: Record<string, unknown[]>): number {
  let n = 0
  for (const k of SAVABLE_KINDS) {
    const arr = prims[k]
    if (Array.isArray(arr)) n += arr.length
  }
  return n
}

/**
 * 把**当前地图上所有画出来的图元**导出成一份计划文件（供「保存计划」用）。
 *
 * ★ 2026-09-18 修 bug：以前只收 id 以 `PLAN:` 开头的图元 —— 用户**手动标绘**的 id 是
 *   `area-1` 这种，于是"画了一堆、点保存却说没有可保存的图元"。
 *   现在改用 map-2d 的 `MapDraw.export()` **整图快照**（逐字段原样），用户画什么都能存。
 */
export function serializePlan(name = '未命名计划'): PlanFile {
  const full = MapDraw.export() as unknown as Record<string, unknown[]>
  const primitives: Record<string, unknown[]> = {}
  for (const k of SAVABLE_KINDS) {
    const arr = full?.[k]
    if (Array.isArray(arr) && arr.length) primitives[k] = arr
  }
  const map = mapInstance.current
  const c = map?.getCenter()
  return {
    schemaVersion: '2.0.0', name, primitives,
    ...(map && c ? { view: { center: [c.lng, c.lat] as [number, number], zoom: map.getZoom() } } : {}),
  }
}

/** 当前有多少条"可保存"的图元（给"没有可保存的图元"这句提示用） */
export function savableCount(plan: PlanFile): number {
  return plan.primitives ? countSnapshot(plan.primitives) : (plan.items?.length ?? 0)
}

/** 触发浏览器下载（「保存计划」用；不依赖任何后端） */
export function downloadPlan(plan: PlanFile, fileName = 'plan.json'): void {
  const blob = new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 计划图元 id 前缀（面板/宿主判断"这条是不是计划里的"用） */
export const PLAN_ID_PREFIX = PLAN_PREFIX

// ---------------------------------------------------------------- 文件对话框
//
// ★ 2026-09-18（需求方："打开计划与保存计划，都需要自动打开默认文件夹位置；保存计划也需要弹窗写文件名称，
//   然后自动保存到默认位置"）。
//
// 浏览器里能同时做到"默认目录 + 写文件名"的只有 **File System Access API**
// （`showOpenFilePicker({startIn})` / `showSaveFilePicker({suggestedName, startIn})`，Chrome/Edge 支持）。
// 普通 `<input type="file">` **不允许**指定默认目录（安全限制），所以它只作为兜底。
//
// "默认位置"的实现：**记住上一次用过的那份文件句柄**（内存 + IndexedDB），下次打开/保存就落回同一个目录；
// 没有记录时用系统"文档"目录（`startIn: 'documents'`）。浏览器不允许直接写死某个盘符路径。

/** 最小类型声明（TS 的 lib.dom 尚未包含这些方法） */
interface FsWritable { write(data: Blob | string): Promise<void>; close(): Promise<void> }
interface FsFileHandle {
  kind: 'file'
  name: string
  getFile(): Promise<File>
  createWritable(): Promise<FsWritable>
}
interface FsPickerOptions {
  suggestedName?: string
  startIn?: string | unknown
  types?: { description?: string; accept: Record<string, string[]> }[]
  multiple?: boolean
  excludeAcceptAllOption?: boolean
}
type PickerOpen = (opts?: FsPickerOptions) => Promise<FsFileHandle[]>
/**
 * ⚠️ **`showSaveFilePicker` 返回的是"单个句柄"，不是数组**（与 `showOpenFilePicker` 不同）。
 *    踩过：按数组取 `[0]` → 拿到 `undefined` → 被当成"用户取消"直接返回，
 *    而对话框已经把文件建出来了 → **落一个 0 字节的空文件**（需求方实测："保存计划……无效，内容为空"）。
 */
type PickerSave = (opts?: FsPickerOptions) => Promise<FsFileHandle>
interface FsWindow {
  showOpenFilePicker?: PickerOpen
  showSaveFilePicker?: PickerSave
}

const PLAN_TYPES = [{ description: '计划文件（JSON）', accept: { 'application/json': ['.json'] } }]

/** 记住的上一次文件句柄（内存） */
let lastHandle: unknown = null

/** 句柄也存一份到 IndexedDB，刷新/重开页面后仍能回到同一个目录 */
const IDB_NAME = 'ma-plan-fs'
const IDB_STORE = 'handles'
function idb(): Promise<IDBDatabase | null> {
  return new Promise((res) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1)
      req.onupgradeneeded = () => { req.result.createObjectStore(IDB_STORE) }
      req.onsuccess = () => res(req.result)
      req.onerror = () => res(null)
    } catch { res(null) }
  })
}
async function rememberHandle(h: unknown): Promise<void> {
  lastHandle = h
  const db = await idb()
  if (!db) return
  try { db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).put(h, 'last') } catch { /* 忽略 */ }
}
async function recallHandle(): Promise<unknown> {
  if (lastHandle) return lastHandle
  const db = await idb()
  if (!db) return null
  return new Promise((res) => {
    try {
      const r = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get('last')
      r.onsuccess = () => { lastHandle = r.result ?? null; res(lastHandle) }
      r.onerror = () => res(null)
    } catch { res(null) }
  })
}

/** 系统支持"指定默认目录"的文件对话框吗 */
export function hasFsPicker(): boolean {
  const w = window as unknown as FsWindow
  return typeof w.showOpenFilePicker === 'function' && typeof w.showSaveFilePicker === 'function'
}

// ---------------------------------------------------------------- 配置兜底
//
// ★ 2026-09-18（需求方："添加记忆兜底，换电脑修改配置也能使用"）。
//
// "记住上次目录"是**浏览器本地**的（IndexedDB），换电脑就没了。所以再加一层**配置文件**：
// `public/plan-config.json`（跟页面一起部署的静态文件，改完刷新即生效，不用改代码/重编宿主）。
// 优先级：**上次用过的目录 > 配置里的 startIn > 'documents'**。

export interface PlanConfig {
  startIn: string
  saveNamePrefix: string
  /** 可选：进态势屏自动打开的默认计划 URL（留空 = 空地图，用户自己选） */
  defaultPlanUrl: string
  /** 配置来源说明（界面上如实显示"用的是配置还是内置默认"） */
  source: string
}

const BUILTIN_PLAN_CONFIG: PlanConfig = {
  startIn: 'documents',
  saveNamePrefix: '态势计划',
  defaultPlanUrl: '',
  source: '内置默认（没读到 /plan-config.json）',
}

let cachedConfig: PlanConfig | null = null

/** 读 /plan-config.json（缓存一次；读不到就用内置默认并说明原因） */
export async function loadPlanConfig(): Promise<PlanConfig> {
  if (cachedConfig) return cachedConfig
  try {
    const r = await fetch('/plan-config.json', { cache: 'no-cache' })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const j = (await r.json()) as Partial<PlanConfig> & { note?: unknown }
    cachedConfig = {
      startIn: typeof j.startIn === 'string' && j.startIn ? j.startIn : BUILTIN_PLAN_CONFIG.startIn,
      saveNamePrefix: typeof j.saveNamePrefix === 'string' && j.saveNamePrefix ? j.saveNamePrefix : BUILTIN_PLAN_CONFIG.saveNamePrefix,
      defaultPlanUrl: typeof j.defaultPlanUrl === 'string' ? j.defaultPlanUrl : '',
      source: '/plan-config.json',
    }
  } catch (e) {
    cachedConfig = { ...BUILTIN_PLAN_CONFIG, source: `${BUILTIN_PLAN_CONFIG.source}：${String((e as Error)?.message ?? e)}` }
  }
  return cachedConfig
}

/** 已经读到过的配置（没读过时给内置默认，不发请求）—— 给同步渲染用 */
export function planConfigSync(): PlanConfig {
  return cachedConfig ?? BUILTIN_PLAN_CONFIG
}

/**
 * **打开计划**：优先用带默认目录的系统对话框；不支持时退回 `<input type="file">`。
 * @returns 文件内容与文件名（用户取消 → null）
 */
export async function pickPlanToOpen(): Promise<{ text: string; name: string } | null> {
  const w = window as unknown as FsWindow
  if (w.showOpenFilePicker) {
    try {
      const cfg = await loadPlanConfig()
      const [handle] = await w.showOpenFilePicker({
        types: PLAN_TYPES, multiple: false, excludeAcceptAllOption: false,
        // 上次用过的目录（浏览器记的）优先；换机器没有记忆 → 用配置里的 startIn
        startIn: (await recallHandle()) ?? cfg.startIn,
      })
      if (!handle) return null
      await rememberHandle(handle)
      const f = await handle.getFile()
      return { text: await f.text(), name: f.name }
    } catch (e) {
      // 用户按了取消 → 静默返回；其它错误交给调用方报
      if ((e as DOMException)?.name === 'AbortError') return null
      throw e
    }
  }
  // 兜底：老的 input[type=file]（**无法指定默认目录**）
  return new Promise((res) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.style.display = 'none'
    document.body.appendChild(input)
    input.onchange = async () => {
      const f = input.files?.[0]
      input.remove()
      if (!f) { res(null); return }
      res({ text: await f.text(), name: f.name })
    }
    input.click()
  })
}

/**
 * **保存计划**：弹"另存为"对话框（带默认文件名，用户可改名）→ 写到所选位置；
 * 不支持时退回浏览器下载（文件名固定）。
 * @returns 实际保存的文件名；用户取消 → null
 */
export async function pickPlanToSave(plan: PlanFile, suggestedName?: string): Promise<string | null> {
  const w = window as unknown as FsWindow
  if (w.showSaveFilePicker) {
    try {
      const cfg = await loadPlanConfig()
      const name = suggestedName ?? `${cfg.saveNamePrefix}-${new Date().toISOString().slice(0, 10)}.json`
      const picked = await w.showSaveFilePicker({
        suggestedName: name, types: PLAN_TYPES,
        startIn: (await recallHandle()) ?? cfg.startIn,
      })
      // 兼容两种返回形状（规范是单个句柄；个别实现给数组）—— 见 PickerSave 的说明
      const handle = (Array.isArray(picked) ? picked[0] : picked) as FsFileHandle | undefined
      if (!handle) return null
      await rememberHandle(handle)
      const wr = await handle.createWritable()
      await wr.write(new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' }))
      await wr.close()
      return handle.name
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return null
      throw e
    }
  }
  // 兜底：浏览器下载（文件名固定，无法让用户改）
  const cfg = await loadPlanConfig()
  const name = suggestedName ?? `${cfg.saveNamePrefix}-${new Date().toISOString().slice(0, 10)}.json`
  downloadPlan(plan, name)
  return name
}
