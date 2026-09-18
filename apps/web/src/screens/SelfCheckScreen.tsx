// mission-app · apps/web/src/screens/SelfCheckScreen.tsx
//
// Excel 步 2 · 语音引导校验界面（参考图 `系统启动界面二.png`）。
//
// 五张自检卡片的**名称、子说明、状态文案、失败原因、处置建议**全部来自宿主的 `selfCheck.items[]`
// ——那是 selfcheck 引擎按规则包 `selfCheck` 段聚合出来的结果，前端一个字都不写死。
// 动作只有三个信号：`selfcheck.run`（一键自检）、`selfcheck.recheck`（重新检测）、`flow.enter`（进入任务）。
//
// ★ 2026-09-18 用户逐屏确认（SH-02）改的三条：
//   ① 左栏宽度 250 → 320（让「提示：自检过程预计耗时 15~30 秒」稳单行 + 留盈余）；
//   ② 自检**真的要走 15~30 秒**：不再是"点一下 13 ms 就出结果"，而是**逐项重检 + 项间节拍**
//      （见 `runPaced`）。逐项重检是**真重算**（selfcheck 引擎对单项重检会保留其余项的结论，
//      engine.cc:737-738），所以这段时间不是空等；
//   ③ 五张卡片用素材库图标（按宿主给的 `key` 认领），替掉原先的空方块。
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { C, panel, panelTitle, statusColor } from '../theme'
import { HINT_BAR_H, HintBar, StatusPanel } from './Chrome'
import type { FlowState, SelfCheckItem } from '../api'

/** 通过/未通过：只看宿主给的 `status`（`normal` = 通过），不做二次判断。 */
function isNormal(it: SelfCheckItem): boolean {
  return (it.status ?? '').toLowerCase() === 'normal' || (it.status ?? '').toLowerCase() === 'ok'
}

/**
 * 自检逐项重检的**项间节拍**（毫秒）。
 *
 * 用户 2026-09-18："重新检测，速度太快，也是需要按照 15~30 秒流程重来一次"。
 * 5 项 × 4000 ms ≈ **20 秒**，落在屏上提示的 15~30 秒区间里。
 * 每一下都是真的 `selfcheck.recheck{keys:[该项]}`（引擎会重跑该项的探针），节拍只加在"项与项之间"。
 */
const PACE_MS = 4000

/** 五张卡片的图标：素材库（`C:\Users\softmonk\Desktop\png库`），按**宿主给的 key** 认领。 */
const CHECK_ICON: Record<string, string> = {
  comm: '/check-comm.png',          // ← 通信链路检测.png
  position: '/check-position.png',  // ← 定位系统检测.png
  cluster: '/check-cluster.png',    // ← 集群节点检测.png
  command: '/check-command.png',    // ← 后方指控检测.png
  security: '/check-security.png',  // ← 系统安全检测.png
}

export function SelfCheckScreen({ state, onRun, onRecheck, onRecheckOne, onEnter, busy, reply }: {
  state: FlowState
  onRun: () => void
  onRecheck: () => void
  /** 单项重检（逐项走 15~30 秒流程时用）；不传就退回"点一下全量重检"的老行为 */
  onRecheckOne?: (key: string) => Promise<void>
  onEnter: () => void
  busy: boolean
  reply: { code: number; error?: { message?: string }; verb?: string } | null
}) {
  const sc = state.selfCheck
  const items: SelfCheckItem[] = sc?.items ?? []
  const done = !!sc && items.length > 0
  const allNormal = done && items.every(isNormal)
  const [expanded, setExpanded] = useState<string | null>(null)
  /** 逐项自检的进度（null = 没在跑；跑的时候是 1..N / N） */
  const [paceStep, setPaceStep] = useState<{ i: number; n: number } | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  /**
   * **15~30 秒的自检流程**：逐项重检，项与项之间留 `PACE_MS`。
   * 执行顺序取宿主上一份报告里的项序（前端不自己编顺序，也不编项名）。
   */
  const runPaced = async () => {
    const keys = items.map((i) => i.key).filter(Boolean)
    if (!onRecheckOne || keys.length === 0) { onRecheck(); return }  // 拿不到项清单 → 退回老行为
    try {
      for (let i = 0; i < keys.length; i++) {
        if (!alive.current) return
        setPaceStep({ i: i + 1, n: keys.length })
        await onRecheckOne(keys[i])
        if (!alive.current) return
        if (i < keys.length - 1) await new Promise((r) => setTimeout(r, PACE_MS))
      }
    } finally {
      if (alive.current) setPaceStep(null)
    }
  }
  const pacing = paceStep !== null
  const btnBusy = busy || pacing

  return (
    <div style={{ position: 'absolute', inset: 0, background: `radial-gradient(120% 90% at 30% 20%, #0a2547 0%, ${C.bg} 55%, #02101f 100%)` }}>
      <div style={{ position: 'absolute', top: 0, bottom: HINT_BAR_H, left: 0, right: 0, display: 'flex', gap: 14, padding: 14 }}>
        {/* 左：标题 + Logo 动效 + 一键自检
            ★ 2026-09-18 用户逐屏确认（SH-02 第 1 条）："左侧系统状态自检太小了，将宽度扩大，
              起码能一行显示『提示：自检过程预计耗时 15~30 秒』还有盈余最佳"。
              实测：提示那行文字在 11.5px 下实宽 181px；原宽 250 − 左右内边距 32 = 内容 218px，
              只余 37px —— 换台机器字体渲染稍宽（Windows 上 CJK 回落到雅黑）就会挤成两行。
              改 250 → 320：内容宽 288px，余量约 107px，任何常见字体设置下都稳定单行。 */}
        <div style={{ ...panel, width: 320, flex: '0 0 auto', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '16px 16px 0' }}>
            <div style={{ fontSize: 16, letterSpacing: 1 }}>系统状态自检</div>
            <div style={{ fontSize: 12, color: C.textDim, marginTop: 6, lineHeight: 1.7 }}>
              请确认系统状态，确保各模块正常运行
            </div>
          </div>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{
              width: 132, height: 132, borderRadius: '50%',
              border: `1px solid ${C.borderStrong}`,
              boxShadow: '0 0 40px rgba(95,176,255,.35) inset, 0 0 24px rgba(95,176,255,.25)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              animation: btnBusy ? 'pulse 1.4s ease-in-out infinite' : undefined,
            }}>
              <img src="/logo.png" alt="" style={{ width: 68, height: 68, objectFit: 'contain' }} />
            </div>
          </div>
          <div style={{ padding: 16 }}>
            <button
              onClick={() => { if (done) void runPaced(); else onRun() }}
              disabled={btnBusy}
              style={primaryBtn(btnBusy)}
            >
              {pacing
                ? `自检中… ${paceStep!.i}/${paceStep!.n}`
                : btnBusy ? '自检中…' : done ? '重新自检' : '一键自检'}
            </button>
          </div>
          <div style={{ padding: '0 16px 14px', fontSize: 11.5, color: C.textDim }}>
            提示：自检过程预计耗时 15~30 秒
          </div>
        </div>

        {/* 中：自检结果 */}
        <div style={{ ...panel, flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div style={panelTitle}>自检结果</div>
          <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
            {!done && (
              <div style={{ padding: 18, fontSize: 12.5, color: C.textDim }}>
                {busy ? '正在逐项检测…' : '尚未执行自检。点左侧【一键自检】开始。'}
              </div>
            )}
            {items.map((it) => {
              const ok = isNormal(it)
              const open = expanded === it.key
              return (
                <div key={it.key} style={{ ...cardStyle, borderColor: ok ? 'rgba(34,197,94,.35)' : 'rgba(239,68,68,.4)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    {/* 卡片图标：素材库按宿主给的 key 认领；认不到仍回落空方块（不硬套一个图标） */}
                    {CHECK_ICON[it.key]
                      ? <img src={CHECK_ICON[it.key]} alt=""
                          style={{ width: 30, height: 30, flex: '0 0 auto', objectFit: 'contain' }} />
                      : <span style={{
                        width: 30, height: 30, borderRadius: 7, flex: '0 0 auto',
                        border: `1px solid ${C.border}`, background: 'rgba(95,176,255,.08)',
                      }} />}
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13.5 }}>{it.name}</div>
                      {it.sub && <div style={{ fontSize: 11.5, color: C.textDim, marginTop: 2 }}>{it.sub}</div>}
                    </span>
                    <span style={{ fontSize: 13, color: statusColor(it.status) }}>
                      {ok ? '正常' : (it.reason || '异常')}
                    </span>
                    <span style={{
                      width: 20, height: 20, borderRadius: '50%', flex: '0 0 auto',
                      background: ok ? 'rgba(34,197,94,.18)' : 'rgba(239,68,68,.18)',
                      color: ok ? C.ok : C.bad, textAlign: 'center', lineHeight: '19px', fontSize: 12,
                    }}>{ok ? '✓' : '!'}</span>
                    {(it.reason || it.advice || it.subs?.length) ? (
                      <button onClick={() => setExpanded(open ? null : it.key)} style={linkBtn}>
                        {open ? '收起' : '详情'}
                      </button>
                    ) : null}
                  </div>
                  {open && (
                    <div style={{ marginTop: 8, paddingLeft: 42, fontSize: 11.5, color: C.textDim, lineHeight: 1.8 }}>
                      {it.subs?.length ? (
                        <div>子项：{it.subs.map((s) => `${s.name}=${s.status}`).join('｜')}</div>
                      ) : null}
                      {it.reason ? <div>原因：{it.reason}</div> : null}
                      {it.advice ? <div>建议：{it.advice}</div> : null}
                      {typeof it.metric === 'number' && it.metric >= 0 ? <div>指标：{it.metric}</div> : null}
                    </div>
                  )}
                </div>
              )
            })}

            {done && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 16 }}>
                <button onClick={onRecheck} disabled={busy} style={ghostBtn(busy)}>重新检测</button>
                {/* ★ 有一项红也**不拦**：自检是"如实体检"，不是"准入闸门" —— 真实环境里
                    "通信链路"这类项本来就可能是红的（没有实装数传），拦在这里会让流程根本走不下去。
                    异常项照旧原样显示（红点 + 原因 + 建议），按钮文字改成"仍要进入任务"以示区别。 */}
                <button onClick={onEnter} disabled={busy} style={enterBtn(busy)}>
                  {allNormal ? '进入任务 ≫' : '仍要进入任务 ≫'}
                </button>
              </div>
            )}
            {done && !allNormal && (
              <div style={{ marginTop: 10, fontSize: 12, color: C.warn }}>
                存在未通过项（{(state.selfCheck?.items ?? []).filter((i) => i.status !== 'normal' && i.status !== 'ok').length} 项）：
                自检结论会原样留在本屏与总结报告里；需要复检时点【重新检测】。
              </div>
            )}
            {reply && reply.code !== 0 && (
              <div style={{ marginTop: 10, fontSize: 12, color: C.bad }}>
                命令未成功（code={reply.code}）：{reply.error?.message ?? '（无原因）'}
              </div>
            )}
          </div>
        </div>

        <StatusPanel items={state.systemOverview} title="系统状态概览" loading={!state.selfCheckReady} />
      </div>
      <HintBar text={done
        ? (allNormal ? '自检通过：可以进入任务' : '存在未通过项：可先看详情与处置建议，也可以直接进入任务（自检结论会带进报告）')
        : '点【一键自检】开始逐项检测'} />
    </div>
  )
}

const cardStyle: CSSProperties = {
  display: 'block', border: `1px solid ${C.border}`, borderRadius: 8,
  background: 'rgba(10,32,58,.55)', padding: '10px 12px', marginBottom: 10,
}
const linkBtn: CSSProperties = {
  background: 'transparent', border: 'none', color: C.accent, fontSize: 11.5, cursor: 'pointer',
}
const primaryBtn = (busy: boolean): CSSProperties => ({
  width: '100%', padding: '10px 0', fontSize: 14, cursor: busy ? 'default' : 'pointer',
  borderRadius: 8, border: `1px solid ${C.borderStrong}`,
  background: busy ? 'rgba(30,58,95,.7)' : 'linear-gradient(180deg,#1d4ed8,#1e3a8a)',
  color: '#eaf4ff', letterSpacing: 2,
})
const ghostBtn = (busy: boolean): CSSProperties => ({
  padding: '9px 22px', fontSize: 13.5, cursor: busy ? 'default' : 'pointer', borderRadius: 8,
  background: 'rgba(10,20,36,.7)', border: `1px solid ${C.borderStrong}`, color: C.text,
})
const enterBtn = (disabled: boolean): CSSProperties => ({
  padding: '9px 30px', fontSize: 14, cursor: disabled ? 'default' : 'pointer', borderRadius: 8,
  background: disabled ? 'rgba(30,58,95,.6)' : 'linear-gradient(180deg,#16a34a,#15803d)',
  border: '1px solid rgba(34,197,94,.6)', color: '#eafff2', letterSpacing: 1,
})
