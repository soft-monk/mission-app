// mission-app · apps/web/src/screens/SelfCheckScreen.tsx
//
// Excel 步 2 · 语音引导校验界面（参考图 `系统启动界面二.png`）。
//
// 五张自检卡片的**名称、子说明、状态文案、失败原因、处置建议**全部来自宿主的 `selfCheck.items[]`
// ——那是 selfcheck 引擎按规则包 `selfCheck` 段聚合出来的结果，前端一个字都不写死。
// 动作只有三个信号：`selfcheck.run`（一键自检）、`selfcheck.recheck`（重新检测）、`flow.enter`（进入任务）。
import { useState, type CSSProperties } from 'react'
import { C, panel, panelTitle, statusColor } from '../theme'
import { HintBar, StatusPanel } from './Chrome'
import type { FlowState, SelfCheckItem } from '../api'

/** 通过/未通过：只看宿主给的 `status`（`normal` = 通过），不做二次判断。 */
function isNormal(it: SelfCheckItem): boolean {
  return (it.status ?? '').toLowerCase() === 'normal' || (it.status ?? '').toLowerCase() === 'ok'
}

export function SelfCheckScreen({ state, onRun, onRecheck, onEnter, busy, reply }: {
  state: FlowState
  onRun: () => void
  onRecheck: () => void
  onEnter: () => void
  busy: boolean
  reply: { code: number; error?: { message?: string }; verb?: string } | null
}) {
  const sc = state.selfCheck
  const items: SelfCheckItem[] = sc?.items ?? []
  const done = !!sc && items.length > 0
  const allNormal = done && items.every(isNormal)
  const [expanded, setExpanded] = useState<string | null>(null)

  return (
    <div style={{ position: 'absolute', inset: 0, background: `radial-gradient(120% 90% at 30% 20%, #0a2547 0%, ${C.bg} 55%, #02101f 100%)` }}>
      <div style={{ position: 'absolute', top: 0, bottom: 34, left: 0, right: 0, display: 'flex', gap: 14, padding: 14 }}>
        {/* 左：标题 + Logo 动效 + 一键自检 */}
        <div style={{ ...panel, width: 250, flex: '0 0 auto', display: 'flex', flexDirection: 'column' }}>
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
              animation: busy ? 'pulse 1.4s ease-in-out infinite' : undefined,
            }}>
              <img src="/logo.png" alt="" style={{ width: 68, height: 68, objectFit: 'contain' }} />
            </div>
          </div>
          <div style={{ padding: 16 }}>
            <button onClick={done ? onRecheck : onRun} disabled={busy} style={primaryBtn(busy)}>
              {busy ? '自检中…' : done ? '重新自检' : '一键自检'}
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
                    <span style={{
                      width: 30, height: 30, borderRadius: 7, flex: '0 0 auto',
                      border: `1px solid ${C.border}`, background: 'rgba(95,176,255,.08)',
                    }} />
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
