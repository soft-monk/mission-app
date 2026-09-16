// mission-app · apps/web/src/telemetry.ts
//
// 实时通道接线：`realtime-hub` 的 client → 按 `uavId` 累积无人机与航迹。
//
// 三件事分开、各管一段（这也是它们能各自替换的原因）：
//   ① 连接        —— 用 @soft-monk/ws-client（重连/心跳/未知事件落点都是它的事）
//   ② 累积        —— 本文件：增量维护"当前位姿 + 轨迹历史"，**不重建、不整表替换**
//   ③ 上屏        —— 由 App 按固定节拍把累积结果交给 map-2d（见 flush 注释）
//
// 为什么累积要单独一层：WS 是**逐条**事件，而地图要的是"一份态势"。
//   · 每条事件都直接 setData 一遍 → 30 架 × 10 Hz = 每秒 300 次全量重建，白烧 CPU；
//   · 正确做法是"收下就存、按节拍合并上屏"——本文件存，App 按节拍提交。
import { createChannel, type Channel, type Envelope } from 'ws-client'

/** `telemetry.uav.pos` 的载荷（字段名与《外设接入契约》§4 一致，直通不改名） */
export interface UavPosPayload {
  uavId?: string
  type?: string
  groupId?: string
  lng?: number
  lat?: number
  alt?: number
  heading?: number
  speed?: number
  battery?: number
  ts?: number
  [k: string]: unknown
}

/** 一条无人机的最新位姿（本前端内部表示） */
export interface UavState {
  uavId: string
  type?: string
  groupId?: string
  lng: number
  lat: number
  alt?: number
  heading?: number
  speed?: number
  battery?: number
  /** 事件自身的时刻（服务端/设备时钟） */
  ts?: number
  /** 本前端收到的时刻（浏览器时钟）——判断"数据是不是过期"用它，不用设备时钟 */
  receivedAt: number
  /** 累计收到的该 uavId 事件条数（增量更新的证据，见自证脚本） */
  updates: number
}

/** 连接状态：直接取 ws-client 的三态 + 缺口信息 */
export interface LinkState {
  state: 'connecting' | 'open' | 'closed'
  /** 断线原因（closed 时） */
  reason?: string
  /** 断线后是否会自动重连（false = 主动关闭，终态） */
  willReconnect?: boolean
  /** 重连成功时的缺口时长（ms） */
  gapMs?: number
  /** 最后一次收到消息的时刻（浏览器时钟） */
  lastSeenAt?: number
  /** 累计重连次数（来自 channel.stats） */
  reconnects: number
}

/** 累积器自己的可调项（与"连接"无关，便于单独构造与单测） */
export interface TelemetryStoreOptions {
  /** 轨迹历史上限（每个 uavId 保留多少个点） */
  maxTrackPoints?: number
  /** 两点距离小于该值（度，曼哈顿近似）就不记——避免悬停时堆一堆重复点 */
  minTrackStepDeg?: number
}

export interface TelemetryOptions extends TelemetryStoreOptions {
  url: string
  /** 消息合并窗口（ms）：窗口内同类型只交付最新一条（交给 ws-client 的节流） */
  throttleMs?: number
  onLinkChange?: (s: LinkState) => void
  onUnknownEvent?: (type: string) => void
}

const DEFAULT_MAX_TRACK_POINTS = 180
const DEFAULT_MIN_STEP_DEG = 2e-5

/** 经纬度是否像样（不做业务校验，只挡 NaN/越界这类"画上去就是错的"数据） */
function validLngLat(lng: unknown, lat: unknown): boolean {
  return typeof lng === 'number' && typeof lat === 'number'
    && Number.isFinite(lng) && Number.isFinite(lat)
    && lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90
}

/** 取数：数字直接给，字符串尝试转换，其余 undefined（不猜语义） */
function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

/**
 * 实时态势累积器。
 *
 * **只存不画**：`ingest` 之后调用方按自己的节拍读 `uavs()` / `tracks()` 上屏。
 * 这样"数据到达频率"与"渲染频率"解耦，也便于单测（不认识地图）。
 */
export class TelemetryStore {
  private readonly uavsById = new Map<string, UavState>()
  private readonly history = new Map<string, [number, number][]>()
  private readonly opts: Required<Pick<TelemetryOptions, 'maxTrackPoints' | 'minTrackStepDeg'>>
  /** 自上次 flush 以来发生变化的 uavId（增量上屏的输入） */
  private readonly dirty = new Set<string>()
  private readonly unknownTypes = new Map<string, number>()

  constructor(opts: TelemetryStoreOptions = {}) {
    this.opts = {
      maxTrackPoints: opts.maxTrackPoints ?? DEFAULT_MAX_TRACK_POINTS,
      minTrackStepDeg: opts.minTrackStepDeg ?? DEFAULT_MIN_STEP_DEG,
    }
  }

  /**
   * 收下一条 `telemetry.uav.pos`。
   *
   * **增量语义**：只改这一个 uavId 的位姿与它的轨迹尾点，其它 uavId 一个字节都不动。
   * 返回是否被接受（缺 uavId / 坐标非法 → false，并计入 rejected）。
   */
  ingest(data: UavPosPayload, at: number = Date.now()): boolean {
    const uavId = str(data.uavId) ?? str(data.deviceId)
    if (!uavId) { this.rejected += 1; return false }
    if (!validLngLat(data.lng, data.lat)) { this.rejected += 1; return false }
    // 先落成局部常量：TS 不会跨函数把 unknown 收窄保留下来，这里显式收口一次
    const lng = data.lng as number
    const lat = data.lat as number

    const prev = this.uavsById.get(uavId)
    const next: UavState = {
      uavId,
      type: str(data.type) ?? prev?.type,
      groupId: str(data.groupId) ?? prev?.groupId,
      lng,
      lat,
      alt: num(data.alt) ?? prev?.alt,
      heading: num(data.heading) ?? prev?.heading,
      speed: num(data.speed) ?? prev?.speed,
      battery: num(data.battery) ?? prev?.battery,
      ts: num(data.ts) ?? prev?.ts,
      receivedAt: at,
      // 计数就是"增量"的直接证据：同一个 uavId 应该是 1,2,3… 而不是每次都是 1
      updates: (prev?.updates ?? 0) + 1,
    }
    this.uavsById.set(uavId, next)
    this.dirty.add(uavId)

    const trail = this.history.get(uavId) ?? []
    const last = trail[trail.length - 1]
    if (!last || Math.abs(last[0] - next.lng) + Math.abs(last[1] - next.lat) > this.opts.minTrackStepDeg) {
      trail.push([next.lng, next.lat])
      if (trail.length > this.opts.maxTrackPoints) trail.splice(0, trail.length - this.opts.maxTrackPoints)
      this.history.set(uavId, trail)
    }
    return true
  }

  /** 一条事件都不影响上屏的条数（缺 id / 坐标非法） */
  rejected = 0

  /** 当前全部无人机（每次调用返回**新数组**，元素是内部对象的浅拷贝） */
  uavs(): UavState[] {
    return [...this.uavsById.values()].map((u) => ({ ...u }))
  }

  /** 某个 uavId 的轨迹点列（副本） */
  trackOf(uavId: string): [number, number][] {
    return [...(this.history.get(uavId) ?? [])]
  }

  /** 全部轨迹（只返回 ≥2 个点的，1 个点画不出线） */
  tracks(): { uavId: string; points: [number, number][] }[] {
    const out: { uavId: string; points: [number, number][] }[] = []
    for (const [uavId, pts] of this.history) if (pts.length >= 2) out.push({ uavId, points: [...pts] })
    return out
  }

  /** 取走"自上次调用以来变化过的 uavId"（增量上屏用；取走即清空） */
  takeDirty(): string[] {
    const ids = [...this.dirty]
    this.dirty.clear()
    return ids
  }

  /** 某个 uavId 的最新位姿 */
  get(uavId: string): UavState | undefined {
    const u = this.uavsById.get(uavId)
    return u ? { ...u } : undefined
  }

  /** 最近一次收到数据的时刻（浏览器时钟）；没收到过返回 undefined */
  lastSeenAt(): number | undefined {
    let t: number | undefined
    for (const u of this.uavsById.values()) if (t === undefined || u.receivedAt > t) t = u.receivedAt
    return t
  }

  /** 未知事件类型的计数（"不认识的就记下来"，不静默丢弃） */
  unknownEventTypes(): { type: string; count: number }[] {
    return [...this.unknownTypes.entries()].map(([type, count]) => ({ type, count }))
  }

  noteUnknown(type: string): void {
    this.unknownTypes.set(type, (this.unknownTypes.get(type) ?? 0) + 1)
  }

  clear(): void {
    this.uavsById.clear()
    this.history.clear()
    this.dirty.clear()
    this.rejected = 0
  }
}

/**
 * 建通道并把 `telemetry.uav.pos` 接进 store。
 *
 * 返回一个 `dispose()`：取消订阅 + 关通道（关是**终态**，不会再重连）。
 * 订阅在 `start()` 之前挂好（`autoStart:false`），避免"连上了但还没订阅"的窗口里
 * 第一批事件走成未知事件。
 */
export function connectTelemetry(
  store: TelemetryStore,
  opts: TelemetryOptions,
): { channel: Channel; dispose: () => void } {
  const channel = createChannel({
    url: opts.url,
    autoStart: false,
    // 同一类型的高频事件在窗口内只保留最新一条 —— 累积器要的是"最新位姿"，
    // 中间那些过期帧对最终画面没有贡献（被合并的条数记在 channel.stats.dropped）
    throttle: opts.throttleMs ? { 'telemetry.uav.pos': opts.throttleMs } : undefined,
    onWarn: (message, detail) => console.warn(`[ws] ${message}`, detail ?? ''),
  })

  channel.on('telemetry.uav.pos', (data: Record<string, unknown>, env: Envelope) => {
    store.ingest(data as UavPosPayload, Date.now())
    void env
  })

  // 本页只消费 `telemetry.uav.pos`（无人机位姿）；但宿主会广播**已登记**的一整批事件
  // （P2 起：selfcheck.*/flow.*；P3 起：mission.*/plan.state/resource.*/entity.*/target.state；
  //  P4 起：sim.state/topology.changed/media.channels…）。它们不是"未知事件"——
  //  只是**不归这一层消费**（各自有专门的界面/钩子）。不登记的话会被计进 unknownEventTypes，
  //  验收里"无未知事件类型"那条就会在有任务时报红（属口径问题，不是真的收到了野事件）。
  // ★ `sys.*` 是保留命名空间：ws-client 自己内部消化（welcome/ping/pong/error），
  //   订阅它会**抛异常**（"使用方不得占用"）—— 所以这里 MUST NOT 登记它们。
  for (const type of [
    'selfcheck.progress', 'selfcheck.ready', 'selfcheck.done', 'flow.state',
    'mission.phase', 'mission.progress', 'mission.status',
    'plan.state', 'resource.allocation.changed', 'resource.ledger.changed',
    'entity.changed', 'target.state', 'entity.consistency',
    'topology.changed', 'alert.raised', 'alert.updated', 'alert.acked',
    'report.ready', 'sim.state', 'media.channels',
    'device.online', 'device.offline', 'device.stats',
  ]) {
    channel.on(type, () => { /* 由各自的界面/钩子消费，这里只登记以免被当成未知事件 */ })
  }

  // 未知事件不能静默丢：计数 + 控制台留痕（协议 §9.1）
  channel.onUnknown((env: Envelope) => {
    store.noteUnknown(env.type)
    console.warn(`[ws] 未知事件（没有订阅者）：${env.type}`)
  })

  const emit = (state: LinkState['state'], info?: { reason?: string; willReconnect?: boolean; gapMs?: number }) => {
    opts.onLinkChange?.({
      state,
      reason: info?.reason,
      willReconnect: info?.willReconnect,
      gapMs: info?.gapMs,
      lastSeenAt: store.lastSeenAt(),
      reconnects: channel.stats.reconnects,
    })
  }

  channel.onStatus((state, info) => {
    emit(state, info as { reason?: string; willReconnect?: boolean; gapMs?: number })
  })

  channel.onError((err) => {
    console.warn(`[ws] ${err.kind}：${err.message}`, err.detail ?? '')
  })

  // 建的时候那一次 connecting 是在 createChannel 内同步报出的，此刻还没有订阅者，
  // 所以这里补报一次当前状态（否则指示器会停在初始值上）
  emit(channel.state)
  channel.start()

  return {
    channel,
    dispose: () => { channel.close() },
  }
}

/** 默认的 WS 地址：与宿主 config.json 的 realtime 段一致；可用 `?ws=` 覆盖 */
export const DEFAULT_WS_URL = 'ws://127.0.0.1:8099/ws'
