// mission-app · apps/web/src/shell/PrimitivePanel.tsx
//
// **「图元显隐」面板** —— 用户 2026-09-18 第 7 条：
// "图册开关过于简略，需要**详细控制每个当前绘制到地图上的**显影，并且可以有**某类型一下全体显影全部**、
//  **文本**这种"。
//
// 和 map-2d 自带 `LayerPanel` 的区别（两个不是一回事，别混）：
//   · `LayerPanel`（模块自带）管的是**图层分组**（area / link / target … 十几组的静态显隐）
//   · 本面板管的是**地图上现在真实有的每一个图元**：逐条勾选、按类型一键全显/全隐
// 用户说"过于简略"指的是后者，所以【图层】这一格现在开的是本面板。
//
// 数据全部来自 map-2d 的公开面：`MapDraw.list(kind)` / `isVisible` / `setVisible` /
// `showAll` / `hideAll` —— 面板自己不存一份镜像（存了就会和地图不同步）。
import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { MapDraw, boundTextOf, draw, mapCommands } from 'map-2d'
import { bizNameOf } from '../biz-catalog'
import { C } from '../theme'


/** 面板里的图元种类名（map-2d 的 13 种；这里只用于**分组显示**） */
type KindName =
  | 'area' | 'shape' | 'scan' | 'cluster' | 'route' | 'track' | 'link'
  | 'annulus' | 'symbol' | 'target' | 'pulse' | 'drone' | 'label'

/**
 * 面板里的分组（按"看着像什么"排，顺序即面板顺序）。
 *
 * ★ 2026-09-18：这组定义原来放在 `draw-catalog.ts` 里 —— 但那是**绘制菜单**的东西，
 *   显隐面板的分组跟"能画什么"不是一回事，放一起只会让两边互相牵扯。搬到面板自己这里。
 */
const KIND_GROUPS: { kind: KindName; name: string }[] = [
  { kind: 'area', name: '面（区域）' },
  { kind: 'shape', name: '圆 / 椭圆' },
  { kind: 'route', name: '线（航线 / 折线）' },
  { kind: 'track', name: '航迹' },
  { kind: 'link', name: '链路' },
  { kind: 'scan', name: '扫描扇区' },
  { kind: 'cluster', name: '集群范围' },
  { kind: 'annulus', name: '圈层（距离环 / 方位线 / 九宫格）' },
  { kind: 'symbol', name: '军标符号' },
  { kind: 'target', name: '目标点' },
  { kind: 'pulse', name: '脉冲点' },
  { kind: 'drone', name: '无人机点' },
  { kind: 'label', name: '文本 / 标注点' },
]

/** 一条图元（面板只关心这三个字段） */
interface Row { id: string; name: string; visible: boolean }

/**
 * ★ 2026-09-18（需求方："一键删除全部图元，**除了无人机**，因为无人机属于另一套，
 *   无人机数据传递进来就会画，所以删除无人机也会默认再次创建"）
 *
 * 「清空全部」时**跳过的种类**：
 *   · `drone` —— 需求方点名的：遥测一到就会重画，删了等于没删；
 *   · `track` —— 同理：航迹每 120ms 由 store 整表重灌（`MapDraw.set('track', …)`），
 *     删掉下一拍就回来。跳过并在按钮提示里写明，免得看起来"点了没用"。
 */
const KEEP_ON_CLEAR: KindName[] = ['drone', 'track']

/** 读某一类的全部图元；读不到就给空数组（不编） */
function rowsOf(kind: KindName): Row[] {
  try {
    const items = (MapDraw.list(kind as never) ?? []) as unknown as Record<string, unknown>[]
    return items
      .filter((x) => typeof x.id === 'string')
      .map((x) => {
        const id = x.id as string
        return { id, name: nameOf(x, id), visible: MapDraw.isVisible(kind as never, id) }
      })
  } catch {
    return []
  }
}

export function PrimitivePanel({ onClose, left = 12 }: {
  onClose: () => void
  /** 面板左边缘 —— 由工具条把【图层】那一格的偏移算好传进来（对齐到按钮正下方） */
  left?: number
}) {
  /** 每次操作后 +1，用来强制重读地图（地图不是 React 状态，得手动催一下） */
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick((v) => v + 1), [])
  /** 哪些类型展开了逐条列表 */
  const [open, setOpen] = useState<Record<string, boolean>>({})
  /**
   * **待确认的单条删除**（用户 2026-09-19："删除的时候需要二次确认，就像图元清空全部一样，再次点击才能删除"）。
   * 与「清空全部」同一套口径：点一次只是**变成确认态**，再点才真删；鼠标移开 / 去点别的一条就退回。
   * 存的是图元 id（同一时刻只允许一行处于确认态）。
   */
  const [confirmDel, setConfirmDel] = useState<string | null>(null)

  // ★ 2026-09-18：改成**事件驱动** —— map-2d 补了图元变更事件 MapDraw.on('change')，
  //   面板不再每 1.2 秒把全表重读一遍（改造前只能轮询，因为地图不是 React 状态）。
  useEffect(() => MapDraw.on('change', refresh), [refresh])

  const groups = KIND_GROUPS.map((g) => ({ ...g, rows: rowsOf(g.kind) })).filter((g) => g.rows.length > 0)
  const total = groups.reduce((a, g) => a + g.rows.length, 0)

  // ★ 2026-09-18（需求方："图元显示隐藏功能，**添加标签显示隐藏**，并且需要**一键显示隐藏**"）：
  //   ① 标签：文字与底块是所有图元共用的一条统一图层，不能按图元种类开关，单独一行 + 模块命令
  //      `mapCommands.setLabelsVisible/labelsVisible`（背后是 map-2d 的 `'text'` 图层分组）。
  //   ② 一键：**两个按钮**（全隐 / 全显），不是单个开关 —— 因为无人机这类图元每 120 ms 被遥测
  //      重新添加、立刻又变可见，"按当前状态取反"的开关会自己翻回去（实测踩到）。两个按钮幂等。
  const labelsOn = mapCommands.labelsVisible()
  const toggleAll = (to: boolean) => {
    for (const g of KIND_GROUPS) {
      if (to) MapDraw.showAll(g.kind as never)
      else MapDraw.hideAll(g.kind as never)
    }
    mapCommands.setLabelsVisible(to)
    refresh()
  }

  /**
   * **一键清空全部图元**（跳过 `KEEP_ON_CLEAR`：无人机 / 航迹）。
   * 破坏性操作 → 两步确认（点一次变「确认清空？」，再点才真删；鼠标移开就退回）。
   */
  const [confirmClear, setConfirmClear] = useState(false)
  const [cleared, setCleared] = useState<string | null>(null)
  const doClearAll = () => {
    let n = 0
    const skipped: string[] = []
    for (const g of KIND_GROUPS) {
      const count = ((MapDraw.list(g.kind as never) ?? []) as unknown as unknown[]).length
      if (KEEP_ON_CLEAR.includes(g.kind)) {
        if (count) skipped.push(`${g.name} ${count}`)
        continue
      }
      n += count
      MapDraw.clear(g.kind as never)
    }
    mapCommands.clearSelection()
    setConfirmClear(false)
    setCleared(`已清空 ${n} 个图元${skipped.length ? `（保留：${skipped.join('、')}）` : ''}`)
    refresh()
  }

  /**
   * **删一条图元**（用户 2026-09-19："每个图元最后添加删除按钮，点击按钮后直接删除图元"）。
   *
   * 走的是模块的**规范删除路径**（`core/selection.ts` 的 `deleteSelection()` 也就这两步）：
   *    `draw.remove(id)`：几何原语（新建 / 区域 / 标绘 画出来的那些）走这条，**顺带解绑它的文本**；
   *    返回 false（不是几何原语，如军标 / 脉冲 / 集群）就退回 `MapDraw.remove(kind, id)`。
   * 删完清一次选中（免得"删除确认条"挂在一个已经没了的图元上）。
   * 按用户口径：**不弹二次确认、不写任何提示**。
   */
  const delRow = useCallback((kind: KindName, id: string) => {
    if (!draw.remove(id)) MapDraw.remove(kind as never, id)
    mapCommands.clearSelection()
    refresh()
  }, [refresh])

  return (
    <div data-testid="primitive-panel" data-ma-noscrollbar="1" style={{ ...panelStyle, left: clampLeft(left) }}>
      <div style={headStyle}>
        <span style={headTitleStyle}>图元显隐（地图上现在有的）</span>
        <div style={headBtnsStyle}>
          {/* 一键：全隐 / 全显（含标签） */}
          <button data-testid="prim-hide-all" onClick={() => toggleAll(false)} style={oneKeyBtnStyle}
            title="一键：隐藏全部图元与标签">一键全隐</button>
          <button data-testid="prim-show-all" onClick={() => toggleAll(true)} style={oneKeyBtnStyle}
            title="一键：显示全部图元与标签">一键全显</button>
          {/* ★ 一键清空（破坏性）：无人机/航迹由遥测驱动，删了会立刻重画 → 跳过 */}
          {confirmClear ? (
            <button
              data-testid="prim-clear-all-confirm"
              onClick={doClearAll}
              onMouseLeave={() => setConfirmClear(false)}
              style={clearConfirmStyle}
              title={`真删（保留：${KEEP_ON_CLEAR.map((k) => KIND_GROUPS.find((g) => g.kind === k)?.name ?? k).join('、')}）`}
            >确认清空？</button>
          ) : (
            <button
              data-testid="prim-clear-all"
              onClick={() => setConfirmClear(true)}
              style={clearBtnStyle}
              title="一键：删除全部图元（无人机与航迹是遥测驱动的，会跳过）"
            >清空全部</button>
          )}
          <button data-testid="primitive-panel-close" onClick={onClose} style={closeStyle} title="收起">×</button>
        </div>
      </div>
      {/* ★ 用户 2026-09-18 第 5 条：原来这里那行「共 N 个图元 · 按类型可一键全显/全隐 · 「文本」单独一类」
          已**删除**（用户点名删的）。 */}

      <div style={{ overflowY: 'auto', flex: 1 }}>
        {/* ---- 标签（文字与底块）显隐：与图元种类并列的一行 ---- */}
        <div style={{ borderTop: `1px solid ${C.border}` }}>
          <div style={groupRowStyle}>
            <label style={{ ...groupBtnStyle, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }} data-testid="prim-group-text">
              <input
                type="checkbox"
                checked={labelsOn}
                onChange={(e) => { mapCommands.setLabelsVisible(e.target.checked); refresh() }}
              />
              标签（文字与底块）
            </label>
            <button
              data-testid="prim-all-text"
              onClick={() => { mapCommands.setLabelsVisible(!labelsOn); refresh() }}
              style={miniBtnStyle}
              title={labelsOn ? '标签全部隐藏' : '标签全部显示'}
            >{labelsOn ? '全隐' : '全显'}</button>
          </div>
        </div>
        {groups.map((g) => {
          const allOn = g.rows.every((r) => r.visible)
          const expanded = !!open[g.kind]
          return (
            <div key={g.kind} style={{ borderTop: `1px solid ${C.border}` }}>
              <div style={groupRowStyle}>
                <button
                  data-testid={`prim-group-${g.kind}`}
                  onClick={() => setOpen((v) => ({ ...v, [g.kind]: !v[g.kind] }))}
                  style={groupBtnStyle}
                  title={expanded ? '收起逐条列表' : '展开逐条列表'}
                >
                  {expanded ? '▾' : '▸'} {g.name}
                  <span style={{ color: C.textDim }}> ({g.rows.filter((r) => r.visible).length}/{g.rows.length})</span>
                </button>
                <button
                  data-testid={`prim-all-${g.kind}`}
                  onClick={() => { if (allOn) MapDraw.hideAll(g.kind as never); else MapDraw.showAll(g.kind as never); refresh() }}
                  style={miniBtnStyle}
                  title={allOn ? '这一类全部隐藏' : '这一类全部显示'}
                >{allOn ? '全隐' : '全显'}</button>
              </div>
              {expanded && g.rows.map((r) => {
                // 用户 2026-09-19："每个图元最后添加删除按钮，点击按钮后，直接删除图元"。
                // 删除按钮**不能**放进 <label>（点它会顺带切换显隐），所以整行改成 div：
                // 左半是原来的 label（勾选框 + 名字），右端才是删除。
                return (
                  <div key={r.id} data-testid={`prim-row-${r.id}`} style={itemRowStyle} title={r.id}>
                    <label style={itemLabelStyle}>
                      <input
                        type="checkbox"
                        data-testid={`prim-item-${r.id}`}
                        checked={r.visible}
                        onChange={(e) => { MapDraw.setVisible(g.kind as never, r.id, e.target.checked); refresh() }}
                      />
                      <span
                        data-testid={`prim-name-${r.id}`}
                        style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      >
                        {r.name}
                      </span>
                      {r.name !== r.id && (
                        <span data-testid={`prim-idtail-${r.id}`} style={idTailStyle}>{r.id}</span>
                      )}
                    </label>
                    {confirmDel === r.id ? (
                      <button
                        data-testid={`prim-del-confirm-${r.id}`}
                        onClick={() => { delRow(g.kind, r.id); setConfirmDel(null) }}
                        onMouseLeave={() => setConfirmDel(null)}
                        style={delConfirmBtnStyle}
                        title={`真的删除这个图元（不可撤销）：${r.id}`}
                      >确认删除？</button>
                    ) : (
                      <button
                        data-testid={`prim-del-${r.id}`}
                        onClick={() => setConfirmDel(r.id)}
                        style={delBtnStyle}
                        title={`删除这个图元（不可撤销）：${r.id}${KEEP_ON_CLEAR.includes(g.kind) ? '（遥测驱动：下一拍可能重建）' : ''}`}
                      >删除</button>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * **一条图元在面板里显示的名字**（用户 2026-09-19："名称只显示 id 太难看了，显示为标签名称"）。
 *
 * 顺序（取第一个非空）：
 *    图元自己的字段：绑定文本落在哪个字段**按种类不同**（map-2d 的 `NATIVE_TEXT_FIELD`：
 *      label 用 `text`；area / shape / route / drone / target / scan / symbol 用 `label`；link / cluster 用 `name`）；
 *    模块的绑定文本登记表 `boundTextOf(id)`：补 track / annulus / pulse 这三种"只登记、不画字"的；
 *    业务目录 `bizNameOf(id)`：兜住 `B:ring:1` 这类由 `make` 造出来的业务物件；
 *    最后退回 `shortName(id)`（`:txt` 特例）与 id 本身，保证永远有字可显示。
 *
 * 这个名字**就是图上那个可改的文本**：用户在文本框编辑器里改了名，面板这里会跟着变。
 */
function nameOf(item: Record<string, unknown>, id: string): string {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '')
  const own = str(item.text) || str(item.label) || str(item.name)
  if (own) return own
  try {
    const bound = str(boundTextOf(id))
    if (bound) return bound
  } catch { /* 模块登记表里没有这条，继续往下兜 */ }
  return bizNameOf(id) ?? shortName(id)
}

/** 图元 id 太长，面板里显示一个能认出来的短名（id 本身放在 title 里） */
function shortName(id: string): string {
  if (id.endsWith(':txt')) return `文本 · ${id.replace(':txt', '')}`
  return id
}

/** 面板宽度（★ 2026-09-18：495 → 640，让标题 + 三个按钮一行放得下） */
const PANEL_WIDTH = 640

/**
 * 面板变宽后可能顶出右边缘（`left` 是按【图层】按钮算的）→ 收敛到窗口内，留 8px 边距。
 */
function clampLeft(left: number): number {
  if (typeof window === 'undefined') return left
  const max = Math.max(8, window.innerWidth - PANEL_WIDTH - 8)
  return Math.max(8, Math.min(left, max))
}

const panelStyle: CSSProperties = {
  // 用户 2026-09-18："宽度太小，再大 1.5 倍" → 330 × 1.5 = 495。
  // ★ 2026-09-18 再调：用户"图元管理界面变宽一些，三个按钮都需要一行显示，而不是换行显示"
  //   → 495 加宽到 **640**（标题 + 三个按钮 + 关闭刚好一行放得下）。
  //   按钮本身也加了 `nowrap`，标题可省略号收缩，所以窄屏也不会再换行。
  // 左边缘由工具条传入（对齐到【图层】按钮正下方），在 JSX 里覆盖 `left`，这个常量只管其余样式。
  position: 'absolute', top: 41, zIndex: 24,
  width: PANEL_WIDTH, maxHeight: 460,
  display: 'flex', flexDirection: 'column',
  background: 'rgba(6,26,47,.97)', border: `1px solid ${C.borderStrong}`,
  borderRadius: 8, boxShadow: '0 6px 20px rgba(0,0,0,.45)',
}
const headStyle: CSSProperties = {
  // ★ 一行放得下：标题可收缩（省略号），按钮区不许压缩、不许换行
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
  flexWrap: 'nowrap', padding: '7px 8px 4px', fontSize: 12, color: C.text,
}
/** 标题：能被压缩（否则按钮被挤到第二行） */
const headTitleStyle: CSSProperties = {
  flex: '1 1 auto', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
}
/** 标题右侧的按钮组：**不许压缩、不许换行** */
const headBtnsStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto', flexWrap: 'nowrap',
}
const closeStyle: CSSProperties = {
  background: 'transparent', border: 'none', color: C.textDim, cursor: 'pointer', fontSize: 15, lineHeight: 1,
}
const groupRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, padding: '3px 6px' }
const groupBtnStyle: CSSProperties = {
  flex: 1, minWidth: 0, textAlign: 'left', fontSize: 11.5, padding: '3px 2px',
  background: 'transparent', border: 'none', color: C.text, cursor: 'pointer', font: 'inherit',
}
const miniBtnStyle: CSSProperties = {
  fontSize: 10.5, padding: '2px 6px', borderRadius: 4, cursor: 'pointer',
  background: 'rgba(29,78,216,.35)', border: `1px solid ${C.border}`, color: C.text, font: 'inherit',
}
/** 头部那个"一键全隐/全显"按钮：比逐类的小按钮更显眼一点（它是全局操作） */
const oneKeyBtnStyle: CSSProperties = {
  fontSize: 11, padding: '2px 8px', borderRadius: 5, cursor: 'pointer', font: 'inherit',
  whiteSpace: 'nowrap', flex: '0 0 auto',
  background: 'rgba(34,211,238,.18)', border: `1px solid ${C.borderStrong}`, color: C.text,
}
/** 「清空全部」（破坏性操作，未确认态） */
const clearBtnStyle: CSSProperties = {
  fontSize: 11, padding: '2px 8px', borderRadius: 5, cursor: 'pointer', font: 'inherit',
  whiteSpace: 'nowrap', flex: '0 0 auto',
  background: 'transparent', border: '1px solid rgba(248,113,113,.55)', color: '#fca5a5',
}
/** 「确认清空？」（第二步：真删） */
const clearConfirmStyle: CSSProperties = {
  fontSize: 11, padding: '2px 8px', borderRadius: 5, cursor: 'pointer', font: 'inherit',
  whiteSpace: 'nowrap', flex: '0 0 auto',
  background: 'rgba(220,38,38,.85)', border: '1px solid rgba(248,113,113,.9)', color: '#fff',
}
const itemRowStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, padding: '2px 8px 2px 18px', fontSize: 11, color: C.text,
  cursor: 'pointer',
}

/** 行内左侧（勾选框 + 名字）：占满剩余宽度，把删除按钮顶到行尾 */
const itemLabelStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, cursor: 'pointer',
}
/** 行尾的「删除」按钮（第一步：点一下变成确认态） */
const delBtnStyle: CSSProperties = {
  fontSize: 10.5, padding: '1px 6px', borderRadius: 4, cursor: 'pointer', font: 'inherit',
  flex: '0 0 auto', whiteSpace: 'nowrap',
  background: 'transparent', border: '1px solid rgba(248,113,113,.55)', color: '#fca5a5',
}

/** 行尾的「确认删除？」（第二步：真删；红底实心，与头部「确认清空？」同一观感） */
const delConfirmBtnStyle: CSSProperties = {
  fontSize: 10.5, padding: '1px 6px', borderRadius: 4, cursor: 'pointer', font: 'inherit',
  flex: '0 0 auto', whiteSpace: 'nowrap',
  background: 'rgba(220,38,38,.85)', border: '1px solid rgba(248,113,113,.9)', color: '#fff',
}

/** 行里那个小灰字的 id（重名时用来区分：`任务区 + geo:3`；行 hover 的 title 也仍是完整 id） */
const idTailStyle: CSSProperties = {
  flex: '0 0 auto', fontSize: 10, color: C.textDim, fontVariantNumeric: 'tabular-nums',
}
