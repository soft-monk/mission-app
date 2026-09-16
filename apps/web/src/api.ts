// mission-app · apps/web/src/api.ts
//
// 与宿主的**唯一**两个接口（前端不认识任何引擎）：
//   GET  /api/state     流程状态 + 启动进度 + 自检结果（宿主已把引擎负载转好）
//   POST /api/command   {verb, params} → {code, verb, data|error}
//
// ★ 纪律：本文件不做任何业务判断。它不知道"什么算就绪""几成算通过"——
//   这些取值全部来自宿主的负载（其源头是 selfcheck 引擎 + 规则包）。
//   前端只负责：显示、把用户动作翻译成一个 verb。
export interface BootModuleCard {
  key: string
  percent: number
  name?: string
  level?: string
  status?: string
  detail?: string
  metric?: number
}

export interface SelfCheckSub {
  probe: string
  name: string
  status: string
  detail?: string
  level?: string
}

export interface SelfCheckItem {
  key: string
  name: string
  sub?: string
  kind?: string
  level?: string
  status: string
  detail?: string
  text?: string
  reason?: string
  advice?: string
  metric?: number
  subs?: SelfCheckSub[]
}

export interface OverviewItem {
  key: string
  name: string
  level?: string
  status: string
  text: string
}

export interface BootState {
  progress?: { items: { key: string; percent: number }[]; overall: number }
  complete?: boolean
  overall?: number
  modules?: BootModuleCard[]
  note?: string
}

export interface SelfCheckState {
  status: string
  checkedAt: number
  checkedAtText?: string
  elapsedMs?: number
  partial?: boolean
  cached?: boolean
  items: SelfCheckItem[]
  failures?: { key: string; kind: string; reason: string }[]
}

export interface FlowState {
  version: string
  ts: number
  step: number
  stepKey: string
  stepTitle: string
  phase: string
  missionId?: string
  enteredAt?: number
  boot: BootState
  selfCheckReady: boolean
  selfCheckNote?: string
  selfCheck?: SelfCheckState
  systemOverview?: OverviewItem[]
  statusBar?: SelfCheckItem[]
  wsClients: number
  capabilities?: Record<string, unknown>
}

export interface CommandReply<T = unknown> {
  code: number
  verb: string
  data?: T
  error?: { message?: string }
}

/** 当前流程状态。读不到时抛错（调用方决定显示什么）。 */
export async function fetchState(signal?: AbortSignal): Promise<FlowState> {
  const r = await fetch('/api/state', { signal, cache: 'no-store' })
  if (!r.ok) throw new Error(`/api/state ${r.status}`)
  return (await r.json()) as FlowState
}

/** 发一条命令。HTTP 层错误也按同一个形状返回，调用方只看 `code`。 */
export async function command<T = unknown>(
  verb: string,
  params: Record<string, unknown> = {},
): Promise<CommandReply<T>> {
  const r = await fetch('/api/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ verb, params }),
  })
  const text = await r.text()
  try {
    return JSON.parse(text) as CommandReply<T>
  } catch {
    return { code: 1005, verb, error: { message: `响应不是 JSON：${text.slice(0, 120)}` } }
  }
}

/** `/health` 的六字段负载（自检界面的"系统状态概览"与运维排障都读它）。 */
export async function fetchHealth(): Promise<Record<string, unknown>> {
  const r = await fetch('/health', { cache: 'no-store' })
  if (!r.ok) throw new Error(`/health ${r.status}`)
  return (await r.json()) as Record<string, unknown>
}
