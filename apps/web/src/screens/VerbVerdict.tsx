// mission-app · apps/web/src/screens/VerbVerdict.tsx
//
// 「命令回执」组件（步 3–5 共用）。
//
// 为什么单独一个文件：步 3–5 每一屏都要如实说明"这条 verb 到底怎么样了"——
// 尤其是宿主**还没实现**的时候（实测 `code=1000 未知 verb：alloc.plans`）。
// 这一小块把三件事摆在一起，避免各屏各写一套：
//   · verb 名（前端到底发了什么）
//   · 宿主的原话 + code（**照抄**，不改写、不翻译成人话以外的意思）
//   · 重试按钮（宿主补上实现后不必刷新页面）
import { C } from '../theme'
import type { CommandReply } from '../api'
import { notImplemented, replyColor } from '../flow/useSituation'

/** 未实现（1000/1005）说得含蓄一点，其它失败照实说。 */
function label(code: number): string {
  if (code === 0) return '成功'
  if (code === 1000) return '宿主未实现该 verb'
  if (code === 1005) return '宿主模块未就绪'
  if (code === 1002) return '互斥冲突'
  if (code === 1003) return '前置条件不满足'
  if (code === 1004) return '未找到'
  if (code === 1006) return '版本不匹配'
  return '失败'
}

/**
 * 失败原因：**优先宿主的原话**。
 *
 * 实测两种放法都有：`error.message`（未知 verb 那种），以及 1003 那种把细节放在
 * `data` 里（`{status:"rejected", unmet:["not-adopted"], message:"编组前置未满足：…"}`）。
 * 这里按顺序找一句话，找不到就说"宿主未给原因"——**不编**。
 */
function reasonOf(reply: { error?: { message?: string }; data?: unknown } | null | undefined): string {
  const msg = reply?.error?.message
  if (typeof msg === 'string' && msg) return msg
  const d = reply?.data
  if (d && typeof d === 'object') {
    const o = d as Record<string, unknown>
    for (const k of ['message', 'reason', 'status', 'detail']) {
      const v = o[k]
      if (typeof v === 'string' && v) {
        const unmet = Array.isArray(o.unmet) ? (o.unmet as unknown[]).map(String) : []
        return `${v}${unmet.length ? `（unmet=${unmet.join(',')}）` : ''}`
      }
    }
  }
  return '（宿主未给原因）'
}

export interface VerdictRow {
  verb: string
  reply: CommandReply | null
  busy?: boolean
  onRetry?: () => void
  /** 成功时的补充说明（例如"3 个方案"），来自宿主给的数据，不是编的 */
  okNote?: string
}

/**
 * 「命令回执」默认**折叠**。
 *
 * ★ 2026-09-17 返工（用户："最基础的排版，为什么排版很奇怪"）：
 *   这一块此前是**常展开**的三行（verb 名 + code + 原因 + 重试按钮），每个地图屏的右栏
 *   都摊着它。它属于**诊断信息**，却占掉了右栏本来就不多的高度 —— 实测在 1280×720/1366×768
 *   下，它把右栏内容顶出可视区（`scripts/layout-check.mjs` 报 23 处"重试按钮在视口外"）。
 *   改成折叠后只占一行；**内容仍在 DOM 里**（验收脚本照样读得到），点开就能看每条 verb 的原话。
 *   标题右侧始终保留一个**一眼可见的汇总**：有几条失败 —— 不把问题藏起来。
 */
export function VerbVerdict({ rows, title = '命令回执', defaultOpen = false }: {
  rows: VerdictRow[]
  title?: string
  defaultOpen?: boolean
}) {
  const failed = rows.filter((r) => r.reply && r.reply.code !== 0).length
  const pending = rows.filter((r) => !r.reply || r.busy).length
  return (
    <details
      data-testid="verb-verdict"
      data-verdict-failed={String(failed)}
      open={defaultOpen}
      style={{
        border: `1px solid ${C.border}`, borderRadius: 8, background: 'rgba(10,32,58,.55)',
        fontSize: 11.5,
      }}
    >
      <summary style={{ cursor: 'pointer', padding: '5px 10px', display: 'flex', alignItems: 'center', gap: 8, listStyle: 'none', userSelect: 'none' }}>
        <span style={{ color: C.textDim }}>ⓘ {title}</span>
        <span style={{
          color: failed ? C.bad : (pending ? C.warn : C.ok),
        }}>
          {failed ? `${failed} 条失败` : pending ? `${pending} 条未回` : '全部成功'}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ color: C.unknown }}>点开看每条原话</span>
      </summary>
      <div style={{ padding: '2px 10px 8px', borderTop: `1px solid ${C.border}` }}>
        {rows.map((r) => {
          const code = r.reply?.code
          return (
            <div key={r.verb} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', flex: '0 0 auto', background: replyColor(r.reply) }} />
              <span style={{ fontSize: 11.5, color: C.text, fontFamily: 'ui-monospace, Consolas, monospace' }}>
                {r.verb}
              </span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: replyColor(r.reply), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={reasonOf(r.reply)}>
                {r.busy
                  ? '发送中…'
                  : !r.reply
                    ? '未发送'
                    : r.reply.code === 0
                      ? (r.okNote ?? label(0))
                      : `code=${code} ${label(code as number)}：${reasonOf(r.reply)}`}
              </span>
              {r.onRetry && (
                <button onClick={r.onRetry} disabled={r.busy} style={{
                  padding: '1px 8px', fontSize: 11, cursor: r.busy ? 'default' : 'pointer', borderRadius: 5,
                  background: 'rgba(10,20,36,.7)', border: `1px solid ${C.border}`, color: C.text,
                }}>重试</button>
              )}
            </div>
          )
        })}
      </div>
    </details>
  )
}

export default VerbVerdict
