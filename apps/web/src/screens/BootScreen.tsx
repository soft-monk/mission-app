// mission-app · apps/web/src/screens/BootScreen.tsx
//
// Excel 步 1 · 启动加载界面（参考图 `系统启动界面一.png`）。
//
// 五张模块卡片的百分比**不是动画**：它们来自宿主 `boot.modules[].percent`，
// 而那个值来自 selfcheck 引擎的进度源，由**真实条件**推进（见 host 的 flow.cc 注释）：
//   10 = 该模块的体检已开始 · 50 = 已完成一次真实体检 · 100 = 规则包判定为就绪。
// 页面做两件事：进入时发一次 `boot.run`（幂等），以及把状态画出来。
//
// ★ 2026-09-17~18 按用户逐屏确认改的（**只改他点名的**）：
//   ① 模块卡片不显示第 4 行小字（`m.detail`）—— 图上只有 图标 + 名称 + 细条 + 百分比；
//   ② 启动页的**调试闸门**（`BOOT_HOLD_FOR_DEBUG`）：调试期"先不自动跳、点了才走"，
//      SH-01 验收通过后按用户要求**关掉**——按钮不再渲染、加载完自动进自检；
//      能力本身保留在这个开关上（再调试启动页时改回 `true` 即可）；
//   ③ 背景换成用户提供的图（`public/earth.jpg`）；
//   ④ 副标题固定「系统启动中，请稍候…」（不再随完成状态改成"初始化完成"）；
//   ⑤ 底部提示条固定成图上的「系统启动中，正在初始化核心模块…」并由 `HINT_BAR_H` 控制高度。
import { useEffect, useRef, type CSSProperties } from 'react'
import { C, panel, panelTitle, statusColor } from '../theme'
import { HINT_BAR_H, HintBar, ProgressBar, StatusPanel, SYS_NAME } from './Chrome'
import type { FlowState } from '../api'

/**
 * 启动页的**调试闸门**（用户 2026-09-17 提出："先不自动跳，但这个能力要有"；
 * 2026-09-18 SH-01 验收通过后："删除调试的进入下一屏幕按钮吧，我需要跑一次自动进入自检界面的流程"）。
 *
 * - `false`（**当前 = 交付形态**）：不拦。界面照宿主的步号走 —— 启动加载一完成就**自动**
 *   落到下一屏（自检 SH-02）。屏上**不会**出现那枚调试按钮。
 * - `true`（调试形态）：加载完成后停在 SH-01，由屏上的【进入下一屏（调试）】决定何时走。
 *   需要再调试启动页时把这一个开关改回 `true`，按钮会自己回来 —— 它**不是被删掉，
 *   而是只在调试形态下渲染**（这样开关拨回去也不会出现"按住了却没有放行按钮"的死路）。
 *
 * 为什么保留开关而不是把代码删干净：用户明确要求过"这个功能需要有"；而"自动跳转"本身是
 * **宿主**的行为（boot 完成即推进步号），前端要"按住"它，只能靠屏路由这一层的闸门。
 */
export const BOOT_HOLD_FOR_DEBUG = false

const MODULE_ICON: Record<string, string> = {
  map: '▤', link: '◍', ai: '⌘', cluster: '⛓', data: '▥',
}

export function BootScreen({ state, onStart, running, onEnterNext }: {
  state: FlowState
  onStart: () => void
  running: boolean
  /** 调试闸门放行（点【进入下一屏（调试）】时调用）；交付形态下不会用到 */
  onEnterNext?: () => void
}) {
  const boot = state.boot
  const modules = boot.modules ?? []
  const overall = boot.progress?.overall ?? boot.overall ?? 0
  const started = useRef(false)

  // 进入即发一次（幂等：宿主在跑/已完成时会回 accepted=false + 原因，不会重复跑）
  useEffect(() => {
    if (started.current) return
    started.current = true
    onStart()
  }, [onStart])

  /**
   * **启动被打断后的自愈**（2026-09-18 补）。
   *
   * 背景：`boot.reset` 现在会把**正在飞的那一轮启动作废**（见 `flow.h` 的 `bootGen_` 注释）——
   * 这修掉了"进度卡在 80%、永远完不成"的旧缺陷，但留下一个新状态：启动被作废后**没人再发起**，
   * 页面就停在 0%。实测踩过：启动页刚起来时外部来一发 `boot.reset`，整页**永久停在 0%**。
   *
   * 判据刻意收得很窄：**只在"总进度还是 0、一个模块都没动过、也不在跑"时才重发**。
   * 这样既能救回被作废的那一轮，又不会在"某个模块本来就绪不了"（那时进度 > 0，
   * 例如 80%）的情况下把 30 秒的启动反复重跑。最多重发 3 次，之后交给屏上的【重新加载】。
   */
  const retries = useRef(0)
  const overall0 = boot.progress?.overall ?? boot.overall ?? 0
  const untouched = overall0 === 0 && modules.every((m) => !(m.percent ?? 0))
  // `onStart` 是宿主传进来的内联箭头，**每次渲染都换身份** —— 直接进依赖数组会让 8 秒定时器
  // 被反复清掉（页面每秒都在收状态更新），重发就永远等不到。所以放进 ref，依赖只留状态量。
  const onStartRef = useRef(onStart)
  onStartRef.current = onStart
  useEffect(() => {
    if (running || boot.complete || !untouched) return
    if (retries.current >= 3) return
    const t = window.setTimeout(() => {
      retries.current += 1
      onStartRef.current()
    }, 8000)
    return () => window.clearTimeout(t)
  }, [running, boot.complete, untouched])

  return (
    <div style={{ ...rootStyle }}>
      <div style={{ position: 'absolute', top: 0, bottom: HINT_BAR_H, left: 0, right: 0, display: 'flex', gap: 14, padding: 14 }}>
        {/* 中间：Logo + 进度（小窗口下可滚动，不裁内容） */}
        <div style={{ flex: 1, minWidth: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          <img src="/logo.png" alt="" style={{ width: 84, height: 84, objectFit: 'contain', filter: 'drop-shadow(0 0 24px rgba(95,176,255,.55))' }} />
          <div style={{ fontSize: 22, letterSpacing: 4, color: '#eaf4ff', textShadow: '0 0 18px rgba(95,176,255,.5)' }}>{SYS_NAME}</div>
          {/* ④ 副标题固定（不再随 boot.complete 变文案） */}
          <div style={{ fontSize: 13, color: C.textDim }}>
            系统启动中，请稍候…
          </div>
          <div style={{ width: '56%', marginTop: 4 }}>
            <ProgressBar percent={overall} height={9} />
          </div>

          {/* 模块加载进度 */}
          <div style={{ ...panel, width: '64%', marginTop: 14 }}>
            <div style={panelTitle}>模块加载进度</div>
            <div style={{ display: 'flex', padding: '10px 8px' }}>
              {modules.map((m) => (
                <div key={m.key} style={{ flex: 1, textAlign: 'center', padding: '0 6px' }}>
                  <div style={{ fontSize: 20, color: C.accent, lineHeight: '26px' }}>
                    {MODULE_ICON[m.key] ?? '◈'}
                  </div>
                  <div style={{ fontSize: 12, color: C.text, marginTop: 4 }}>{m.name ?? m.key}</div>
                  <div style={{ marginTop: 6 }}>
                    <ProgressBar percent={m.percent} height={3} showText={false} />
                  </div>
                  {/* ① 图上到这里就结束了：只有百分比，没有第 4 行小字 */}
                  <div style={{ fontSize: 11.5, color: C.textDim, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
                    {Math.round(m.percent)}%
                  </div>
                </div>
              ))}
              {!modules.length && (
                <div style={{ padding: '0 12px', fontSize: 12, color: C.textDim }}>
                  {state.boot.note || '（宿主未给出模块进度）'}
                </div>
              )}
            </div>
          </div>

          {!running && !boot.complete && (
            <button onClick={onStart} style={retryStyle}>重新加载</button>
          )}

          {/* ② 调试闸门（**只在调试形态下渲染**）。
              交付形态 `BOOT_HOLD_FOR_DEBUG = false` → 这一段整个不出现，屏上没有那枚按钮，
              加载完成后界面照宿主步号**自动**进自检 SH-02。
              要再调试启动页，把开关改回 `true`，按钮会自己回来。 */}
          {BOOT_HOLD_FOR_DEBUG && boot.complete && (
            <button
              data-testid="boot-debug-next"
              onClick={() => onEnterNext?.()}
              title="调试用：放行启动页，进入下一屏。交付形态下这里会自动跳转，本按钮不渲染"
              style={debugNextStyle}
            >
              进入下一屏（调试）
            </button>
          )}
        </div>

        <StatusPanel items={state.systemOverview} loading={!state.selfCheckReady} />
      </div>
      {/* 底部提示条：**固定文案**（照参考图 `系统启动界面一.png` 底部那一行）。
          用户反馈："下方的『系统启动中，正在初始化核心模块』怎么没有了" —— 之前它会随
          `boot.complete` 改成"初始化完成，正在进入系统状态自检…"，所以截图里看不到图上那句。 */}
      <HintBar text="系统启动中，正在初始化核心模块…" />
    </div>
  )
}

/** ③ 底图：用户提供的图（`apps/web/public/earth.jpg`）。用 cover 铺满，压一层深色保证文字可读。 */
const rootStyle: CSSProperties = {
  position: 'absolute', inset: 0,
  backgroundImage: 'linear-gradient(rgba(2,16,31,.35), rgba(2,16,31,.62)), url(/earth.jpg)',
  backgroundSize: 'cover, cover',
  backgroundPosition: 'center, center',
  backgroundRepeat: 'no-repeat, no-repeat',
}

const debugNextStyle: CSSProperties = {
  marginTop: 12, padding: '7px 18px', fontSize: 13, cursor: 'pointer', borderRadius: 8,
  background: 'linear-gradient(180deg,#1d4ed8,#1e3a8a)', border: `1px solid ${C.borderStrong}`,
  color: '#eaf4ff', letterSpacing: 1,
}

const retryStyle: CSSProperties = {
  marginTop: 10, padding: '5px 14px', fontSize: 12, cursor: 'pointer', borderRadius: 6,
  background: 'rgba(10,20,36,.8)', border: `1px solid ${C.border}`, color: C.text,
}

/** 启动页的自证句柄（`window.__bootStats`）：验收脚本读它，不改渲染行为。 */
export function bootProbe(state: FlowState) {
  return {
    step: state.step,
    stepKey: state.stepKey,
    overall: state.boot.progress?.overall ?? null,
    complete: state.boot.complete ?? null,
    modules: (state.boot.modules ?? []).map((m) => ({ key: m.key, name: m.name, percent: m.percent, status: m.status, detail: m.detail })),
    overview: (state.systemOverview ?? []).map((o) => ({ key: o.key, text: o.text, status: o.status })),
    wsClients: state.wsClients,
    colorOf: statusColor,
  }
}
