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
import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { C, panel, panelTitle } from '../theme'
import type { FlowState } from '../api'
import type { UseFlow } from '../flow/useFlow'
import {
  n2s, readCompose, readInventory, readSituation, replyText, sortByType, threatColor,
  uavTypeCN, useVerbOnce, type Metric,
} from '../flow/useSituation'
import { VerbVerdict } from './VerbVerdict'

import { MapToolbar, ToolModeNote, toolsOf, useMapToolState } from '../shell/MapTools'
import { BIZ_MENUS, TEXT_STYLE_OPTIONS, bizEntry } from '../biz-catalog'
// map-2d：`mapInstance` 取当前地图实例（"落点即创建"要挂 click）；`useInteraction` 取绘制模式
import { MapDraw, boundStyleOf, boundTextOf, mapCommands, setBoundStyle, setBoundText, useInteraction, type TextStyle } from 'map-2d'
// ★ 2026-09-18「计划」：计划文件的读写（空地图 + 手动打开计划）
import { applyPlan, loadPlanConfig, parsePlan, pickPlanToOpen, pickPlanToSave, savableCount, serializePlan } from '../plan-file'
// ★ 2026-09-18「规划航线」：A* 按界面上画的集结区/任务区算航线 + 航道
import { classifyAreas, planAndDrawRoute } from '../route-compute'
// ★ 2026-09-18：`DiagBox/DiagLine`（`../shell/Diag`）的 import 随"视图声明"浮层一起删掉了 ——
//   本屏不再显示任何诊断浮层；工具可用性仍然照发 `view.compose`（见下面的 `cmp`）。

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
 * 本屏工具条的**版式**（键位/顺序逐字照参考图 T0-1）。
 *
 * 图上是「选择 / 新建 / 全屏 / 区域 / 3D」；这里保留图上的 5 格，并在其后补上
 * `view.compose` 对 `overview` 模式声明为 available 的 测距·测面·标绘·图层·清屏
 * —— **量算（测距/测面）是用户本轮点名要接的能力**（map-2d 已实现 M2-CTRL-10，
 * 宿主此前从未挂 `DrawLayer`，所以一直是灰的）。补格属于"图上有工具组、模块有能力"的
 * 如实接线，已登记进 README「本轮的已知偏差」。
 * 每一格**能不能点**不看这张表，一律由规则包 `view.compose` 说了算。
 */
const SH03_TOOLS = toolsOf([
  'select', 'create', 'fullscreen', 'area', 'measure', 'measureArea', 'draw',
  // ★ 用户 2026-09-18 第 3 条：「选择场景功能，添加到上方工具栏中，点击后才显示」
  'scene',
  // ★ 用户 2026-09-18："功能界面添加，计划，子菜单为，打开计划，保存计划"（先做打开）
  'plan',
  'layers', 'clear', 'reset',
  // ★ 用户 2026-09-18 第 1 条：新建/区域/标绘 三格挂**子菜单**（见 draw-catalog.ts）。
  //   挂在数据上而不是改 toolsOf —— 菜单内容是"能画什么"，属于本屏的绘制目录。
]).map((t) => (BIZ_MENUS[t.key] ? { ...t, submenu: BIZ_MENUS[t.key] } : t))
  // ★★ 2026-09-19（需求方实测："新建和区域功能都无法使用了"）：
  //   根因**不是**功能坏了 —— 规则包在 T0 阶段没声明 `create`/`area` 可用（`view.compose` 里
  //   它们是 hidden），界面就如实灰置了；而"画计划"（画集结区/任务区）是**流程之外**的事，
  //   不该等阶段推进才让画。所以这两格在本屏**常开**（`always: true` 的语义见 `MapToolSpec`）。
  //   只覆盖本屏 —— 别的屏仍按规则包声明走，不扩大影响面。
  .map((t) => (t.key === 'create' || t.key === 'area' ? { ...t, always: true } : t))

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
   * **正在改的跟随文本**（用户第 2 条："画完给个输入框 / 点文本可改"）。
   *
   * ★ 2026-09-18 解耦合后：**文本框由模块的 `TextOverlay` 画、绑定关系存在模块里**，
   *   宿主不再自己挂 `label` 图元。这里只留"编辑"这一件事，改文本走模块的 `setBoundText`。
   */
  const [editing, setEditing] = useState<{ id: string; text: string; style: TextStyle } | null>(null)
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
      const { drawn, failed } = applyPlan(plan)
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
        const { drawn } = applyPlan(plan)
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
      + `（会自动绕开 ${threats.length} 个威胁区）`)
  }, [runRoutePlan])

  /**
   * **点地图上的文本就能改它**（用户第 2 条："点文本可改"）。
   *
   * 走 map-2d 的图元命中回调 `MapDraw.on('click')`：命中的若是"某个图元的点/面"，
   * 且那个图元**绑了文本**，就把编辑器打开改它。
   */
  useEffect(() => {
    const off = MapDraw.on('click', (e) => {
      const cur = boundTextOf(e.id)
      if (cur === null) return          // 这个图元没绑文本 → 不弹编辑器
      setEditing({ id: e.id, text: cur, style: boundStyleOf(e.id) ?? 'tag' })
    })
    return off
  }, [])

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

  /** 保存正在编辑的文本框：**文字与样式都写回模块**（绑定关系在模块里，宿主不自己存） */
  const saveEditing = () => {
    if (!editing) return
    setBoundText(editing.id, editing.text)
    setBoundStyle(editing.id, editing.style)
    setEditing(null)
  }

  return (
    <>
      {/* 底图不在这里：2026-09-18 起地图由 App 的 MapLayer 统一渲染（所有屏共用一张，清屏才做得干净） */}

      {/* ---------------- 左上：地图浮动工具栏 ----------------
           ★ 上一版这一排是**只读的 `<span>` 摆设**（点了没反应），而 map-2d 里量算/手绘/
             图层面板/清屏/全屏**早就实现了**。现在统一走 `shell/MapTools`（真能点，
             可用性由规则包 `view.compose` 说了算）。键位按参考图 T0-1：
             选择 / 新建 / 全屏 / 区域 / 3D，另按 `view.compose` 的声明补 测距·测面·标绘·图层·清屏
             （量算是用户明确点名要接的能力，见 README「本轮的已知偏差」）。 ---------------- */}
      <MapToolbar
        testid="sh03-toolbar"
        items={SH03_TOOLS}
        state={mt}
        style={{ left: 12, top: 5 }}
        onLocal={(k) => {
          if (k === 'scene') { setSceneOpen((v) => !v); return }
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
          setDrawMode('none')   // 关掉老的 mode，避免两套交互打架
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
            textStyle: 'tag',
            // 画完自动弹编辑器，让用户把文字改成想写的（用户第 2 条"画完给个输入框"）
            onDone: (id) => { if (id) setEditing({ id, text: e.label, style: 'tag' }) },
          })
        }}
        activeKeys={{ scene: sceneOpen }}
      />
      <ToolModeNote state={mt} items={SH03_TOOLS} style={{ left: 12, top: 46 }} />

      {/* ---------------- 跟随文本的编辑器（用户第 2 条 + 第 3 条） ----------------
          两个入口共用这一个框：画完自动弹（预填默认文案）、点地图上的图元也能弹出来改。
          Enter 或【确定】保存；Esc 或【取消】不写回。
          ★ 文本框的**三种样式**（角标 / 卡片 / 引线标注）在这里切换 —— 用户第 3 条要的
            "可以绑定**几种**文本框的方式"，样式列表来自 map-2d 的 `TEXT_STYLES`。 */}
      {editing && (
        <div data-testid="text-editor" style={textEditorStyle}>
          <span style={{ fontSize: 11.5, color: C.textDim }}>文字</span>
          <input
            data-testid="text-editor-input"
            autoFocus
            value={editing.text}
            onChange={(e) => setEditing({ ...editing, text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { saveEditing(); }
              if (e.key === 'Escape') setEditing(null)
            }}
            style={textInputStyle}
          />
          <span style={{ fontSize: 11.5, color: C.textDim, marginLeft: 4 }}>样式</span>
          {TEXT_STYLE_OPTIONS.map((o) => (
            <button
              key={o.key}
              data-testid={`text-style-${o.key}`}
              title={o.note}
              onClick={() => { setBoundStyle(editing.id, o.key); setEditing({ ...editing, style: o.key }) }}
              style={{
                ...editorBtnStyle,
                background: editing.style === o.key ? 'rgba(37,99,235,.75)' : 'rgba(29,78,216,.25)',
                borderColor: editing.style === o.key ? '#5fb0ff' : C.border,
              }}
            >{o.name}</button>
          ))}
          <button
            data-testid="text-editor-ok"
            onClick={saveEditing}
            style={editorBtnStyle}
          >确定</button>
          <button data-testid="text-editor-cancel" onClick={() => setEditing(null)} style={editorBtnStyle}>取消</button>
        </div>
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
              自动绕开 {threats.length} 个「威胁」区域；算出来会画<b>规划航线</b>与 <b>1000 m 宽航道</b>
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
/** 跟随文本编辑器：浮在工具条下方，和子菜单同一带 */
const textEditorStyle: CSSProperties = {
  position: 'absolute', left: 12, top: 41, zIndex: 25,
  display: 'flex', alignItems: 'center', gap: 6,
  padding: '6px 9px', borderRadius: 8,
  background: 'rgba(6,26,47,.96)', border: `1px solid ${C.borderStrong}`,
  boxShadow: '0 6px 20px rgba(0,0,0,.45)',
}
const textInputStyle: CSSProperties = {
  width: 210, fontSize: 12, padding: '4px 7px', borderRadius: 5,
  background: 'rgba(10,32,58,.9)', border: `1px solid ${C.border}`, color: C.text, outline: 'none',
}
const editorBtnStyle: CSSProperties = {
  fontSize: 11.5, padding: '3px 9px', borderRadius: 5, cursor: 'pointer', font: 'inherit',
  background: 'rgba(29,78,216,.45)', border: `1px solid ${C.border}`, color: C.text,
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
