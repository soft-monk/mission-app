// mission-app · apps/web/src/screens/SituationScreen.tsx
//
// **SH-03 · 任务态势主界面**（参考图 `需求图与描述\场景1\T0-1.png`，需求专篇 DES-APP-001 §3 SH-03）。
//
// 版式照图（自上而下 / 自左而右）：
//   · 顶部压条：**显示模式：综合态势** / 阶段 / 区域 / 目标 + 回执状态
//   · 中区：二维瓦片底图（`MapStage`，本屏自带地图——App.tsx 的 `MapLayer` 明确跳过 SH-03）
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
import { useState, type CSSProperties } from 'react'
import { C, panel, panelTitle } from '../theme'
import type { FlowState } from '../api'
import type { UseFlow } from '../flow/useFlow'
import {
  n2s, readCompose, readInventory, readSituation, replyText, sortByType, threatColor,
  uavTypeCN, useVerbOnce, type Metric,
} from '../flow/useSituation'
import { VerbVerdict } from './VerbVerdict'
import { StageStrip } from './StageOverlay'
import { MapStage } from '../MapStage'

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
  const compose = useVerbOnce(flow, 'view.compose', { phase: state.phase || 'T0' }, true)
  // 资源概况取**资源台账**（需求专篇 SH-03 的"数据来源"第三条）。
  // `alloc.inventory` 自己会在台账不存在时初始化（宿主 ensureLedger，幂等），所以步 3 也能读。
  const inv = useVerbOnce(flow, 'alloc.inventory', {}, true)

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

  const okTools = cmp.tools.filter((t) => t.on)
  const offTools = cmp.tools.filter((t) => !t.on)

  return (
    <>
      {/* ---------------- 二维瓦片底图（SH-03 自带地图：App.tsx 的 MapLayer 跳过本屏）--------------- */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}>
        <MapStage phase={state.phase} />
      </div>

      {/* ---------------- 顶部压条（盖住地图台的自证信息条）---------------- */}
      <StageStrip
        items={[
          { k: '显示模式', v: cmp.modeName ?? cmp.modeKey ?? '—', color: C.accent },
          { k: '阶段', v: state.phase || '—' },
          { k: '任务态势', v: state.stepTitle },
          { k: '区域', v: `${sit.areas.length}` },
          { k: '目标', v: `${sit.targets.length}` },
        ]}
        right={<span style={{ color: snap.reply?.code === 0 ? C.ok : C.warn }}>
          {snap.reply === null
            ? '态势快照读取中…'
            : snap.reply.code === 0
              ? '态势快照已就绪（situation.snapshot）'
              : `态势快照：${replyText(snap.reply)}`}
        </span>}
      />

      {/* ---------------- 左上：地图浮动工具栏（画不画由 view.compose 说了算）---------------- */}
      <div style={toolbarStyle}>
        <div data-testid="compose-panel" style={{ ...panel, padding: '6px 10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div data-testid="sh03-toolbar" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
              {cmp.tools.map((t) => (
                <span
                  key={t.key}
                  data-testid="sh03-tool"
                  data-tool-on={t.on ? '1' : '0'}
                  title={t.on ? `可用（view.compose：${t.key}）` : `不可用：${t.reason ?? '宿主未给原因'}`}
                  style={{
                    fontSize: 11.5, padding: '3px 9px', borderRadius: 6, whiteSpace: 'nowrap',
                    border: `1px solid ${t.on ? C.borderStrong : C.border}`,
                    background: t.on ? 'rgba(29,78,216,.35)' : 'rgba(10,20,36,.6)',
                    color: t.on ? C.text : C.unknown,
                  }}
                >{t.name}</span>
              ))}
              {!cmp.tools.length && <Missing text="工具栏未就绪（view.compose 未给出 tools）" />}
            </div>
            {/* 图上这里是「显示模式：综合态势 ⌄」下拉。可选值只有 view.compose 给的那一个，
                所以做成**只读展示**，不编一份模式清单出来（G-06 的"其余按阶段启用"）。 */}
            <span
              data-testid="sh03-display-mode"
              title="显示模式由 view.compose 给出（本期只有「综合态势」这一档可用，其余按阶段启用）"
              style={{
                fontSize: 11.5, color: C.accent, border: `1px solid ${C.border}`, borderRadius: 6,
                padding: '3px 9px', whiteSpace: 'nowrap', flex: '0 0 auto',
              }}
            >显示模式：{cmp.modeName ?? cmp.modeKey ?? '—'} ⌄</span>
          </div>
          <div style={{ display: 'flex', gap: 14, marginTop: 5, fontSize: 11, color: C.textDim, flexWrap: 'wrap' }}>
            {cmp.visibleGroups.length > 0 && <span>可见图层 {cmp.visibleGroups.join(' / ')}</span>}
            {okTools.length > 0 && <span style={{ color: C.accentDim }}>可用 {okTools.length}</span>}
            {offTools.length > 0 && (
              <span style={{ color: C.unknown }} title={offTools.map((t) => `${t.name}：${t.reason ?? '未给原因'}`).join('；')}>
                不可用 {offTools.length}（悬停看原因）
              </span>
            )}
            {cmp.controls.length > 0 && <span>控件 {cmp.controls.map((c) => c.name).join('/')}</span>}
            {!cmp.tools.length && !cmp.visibleGroups.length && compose.reply && compose.reply.code !== 0 && (
              <span style={{ color: C.warn }}>view.compose → {replyText(compose.reply)}</span>
            )}
          </div>
        </div>
      </div>

      {/* ---------------- 右栏：AI任务分析 / 任务信息 / 资源概况 ---------------- */}
      <div style={rightColStyle}>
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
          {notice}（点这条提示关掉）
        </div>
      )}

      {/* ---------------- 底部：「请选择任务场景」+ 三张场景入口卡 ---------------- */}
      <div style={bottomStyle}>
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
const toolbarStyle: CSSProperties = {
  position: 'absolute', left: 12, right: 328, top: 34, zIndex: 20,
}
const rightColStyle: CSSProperties = {
  position: 'absolute', right: 12, top: 34, bottom: 204, zIndex: 20, width: 300,
  display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto',
}
const bottomStyle: CSSProperties = {
  position: 'absolute', left: 12, right: 12, bottom: 36, zIndex: 20, height: 158,
}
const noticeStyle: CSSProperties = {
  position: 'absolute', left: 12, bottom: 200, zIndex: 24, maxWidth: 560,
  fontSize: 12, color: C.text, background: 'rgba(120,60,10,.94)',
  border: '1px solid rgba(245,158,11,.6)', borderRadius: 8, padding: '6px 10px', cursor: 'pointer',
}
const notImplChip: CSSProperties = {
  fontSize: 10.5, color: C.warn, border: '1px solid rgba(245,158,11,.45)', borderRadius: 4, padding: '0 5px',
}

export default SituationScreen
