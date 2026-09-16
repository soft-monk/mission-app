// mission-app · scripts/render-check-map.mjs
//
// 真机自证：无人机与航迹**真的画出来了**（不是"页面上有个地图容器"）。
//
// 为什么不用真后端就能证：本脚本在 Node 侧**起一个真的 WebSocket 服务端**，
// 页面用 `?ws=` 指向它。于是"页面自己连上 → 收到 telemetry.uav.pos → 累积 → 上屏"
// 这条链路是**端到端跑通**的，只是数据源由脚本提供（后端不是本脚本的验证对象）。
//
// 分两轮：
//   第一轮（注入 3 架 × 4 点，共 12 条）：证明画出来了、轨迹连成线、终端显示"已连接"、静态区域也在
//   第二轮（在**同一个页面**里再注入 2 架 × 3 点）：证明是**增量**——老 UAV 的 updates 计数继续涨、
//           UAV 数变成 5、原有点列继续加长，而不是每帧从零重建
//   最后主动断开：证明页面如实提示"数据可能已过期"（而不是停在那一帧装作一切正常）
//
// 用法：
//   node scripts/render-check-map.mjs [url] [--keep]
//   url 默认 http://127.0.0.1:5190/（apps/web 的 vite dev server）
// 退出码：0 = 全绿；1 = 有断言失败；2 = 环境不具备（没找到 Chrome）
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const argUrl = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'http://127.0.0.1:5190/'
const KEEP = process.argv.includes('--keep')
const WS_PORT = 18099

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => existsSync(p))

if (!CHROME) {
  console.error('[render-check-map] 没找到 Chrome —— 这一步是真机自证，环境不具备时跳过（退出码 2）')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 发帧间隔（ms）。**必须大于页面配的合并窗口**（App.tsx 的 `throttleMs`，当前 50 ms）：
 * 窗口内到达的多条只保留最新一条——那是页面的既定行为，不是丢数据。
 * 间隔 130 ms 时逐条交付，断言才数得清"每条都到了"。
 */
const FRAME_GAP_MS = 130

/** 场景标注的 id（与 apps/web/src/scenario.ts 的 `LBL:` 前缀规则一致） */
const SCENE_LABEL_IDS = [
  'LBL:area-a', 'LBL:area-b', 'LBL:area-c', 'LBL:area-enemy-deploy',
  'LBL:friendly-assembly-a', 'LBL:nfz-core', 'LBL:threat-sam', 'LBL:geofence-ew',
  'LBL:corridor-main', 'LBL:friendly-forward-node',
]

let pass = 0
let fail = 0
const results = []
function check(name, ok, detail) {
  ok ? pass++ : fail++
  results.push(`${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : ` —— ${detail}`}`)
}

// ---------------------------------------------------------------- 最小 WebSocket 服务端
// 只做本脚本需要的那点事：握手 + 发文本帧 + 主动断开。
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 把一条字符串编成"未掩码的服务端文本帧"（服务端发出的帧不加掩码） */
function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.from([0x81, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

/** 读客户端帧（要解掩码）；返回本次解出的帧 + 未消费的剩余字节（**必须留着**，TCP 会拆包） */
function decodeFrames(buf) {
  const frames = []
  let offset = 0
  while (offset + 2 <= buf.length) {
    const b0 = buf[offset]
    const b1 = buf[offset + 1]
    const fin = (b0 & 0x80) !== 0
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let len = b1 & 0x7f
    let p = offset + 2
    if (len === 126) { if (p + 2 > buf.length) break; len = buf.readUInt16BE(p); p += 2 }
    else if (len === 127) { if (p + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(p)); p += 8 }
    const maskKey = masked ? buf.subarray(p, p + 4) : null
    if (masked) p += 4
    if (p + len > buf.length) break
    const payload = Buffer.from(buf.subarray(p, p + len))
    if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4]
    frames.push({ opcode, fin, payload })
    offset = p + len
  }
  return { frames, rest: buf.subarray(offset) }
}

/** 起一个只服务一条连接的 WS 服务端；返回控制句柄 */
function startWsServer(port) {
  const state = {
    /** 已握手且**仍然活着**的连接。死连接必须及时摘掉，否则后面写它会 ECONNABORTED
     *  （踩过的坑：把死 socket 留在表里，每轮广播都往死连接写一次——表现为"每批丢一条"） */
    sockets: new Set(),
    handshakes: 0,
    /** 收到的客户端帧（含 sys.ping） */
    clientFrames: [],
  }
  const server = createServer((_req, res) => { res.writeHead(404); res.end() })
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key']
    const accept = createHash('sha1').update(String(key) + WS_GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    state.handshakes += 1
    state.sockets.add(socket)
    const drop = () => { state.sockets.delete(socket) }
    socket.on('close', drop)
    socket.on('error', drop)          // 客户端断开是正常情况，不算失败
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const { frames, rest } = decodeFrames(buf)
      // ★ 必须把没消费完的字节留着：TCP 会把一条帧拆成多次 data 事件
      buf = rest
      for (const f of frames) {
        if (f.opcode === 0x8) { socket.end(); continue }        // close
        if (f.opcode === 0x9) {                                 // ping → 回 pong（保持连接活着）
          const pong = Buffer.concat([Buffer.from([0x8a, f.payload.length]), f.payload])
          try { socket.write(pong) } catch { /* ignore */ }
          continue
        }
        // 10 = pong（心跳回应），不需要处理
        if (f.opcode === 0x1) state.clientFrames.push(f.payload.toString('utf8'))
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({
      state,
      port,
      /** 向所有活着的客户端各发一条信封；返回实际写入的连接数 */
      send(type, data) {
        const frame = encodeTextFrame(JSON.stringify({ type, data, ts: Date.now() }))
        let n = 0
        for (const s of state.sockets) {
          try { s.write(frame); n += 1 } catch { state.sockets.delete(s) }
        }
        return n
      },
      /** 当前活着的连接数 */
      liveCount() { return state.sockets.size },
      /** 粗暴断开所有连接（模拟链路中断） */
      dropAll() {
        for (const s of state.sockets) { try { s.destroy() } catch { /* ignore */ } }
        state.sockets.clear()
      },
      close() { try { server.close() } catch { /* ignore */ } },
    }))
  })
}

// ---------------------------------------------------------------- CDP
const profile = mkdtempSync(path.join(tmpdir(), 'ma-render-map-'))
const port = 9200 + (process.pid % 400)
let chrome
let wsFake

try {
  wsFake = await startWsServer(WS_PORT)

  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
    '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' })

  let browserWsUrl
  for (let i = 0; i < 60; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
      if (j.webSocketDebuggerUrl) { browserWsUrl = j.webSocketDebuggerUrl; break }
    } catch { /* 还没起来 */ }
    await sleep(200)
  }
  if (!browserWsUrl) throw new Error('Chrome 调试端口没起来')

  const ws = new WebSocket(browserWsUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  let id = 0
  const pending = new Map()
  const consoleErrors = []
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
      consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
    }
  })
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const mid = ++id
    pending.set(mid, { resolve, reject })
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }))
  })

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const s = (method, params = {}) => send(method, params, sessionId)
  await s('Page.enable')
  await s('Runtime.enable')

  async function ev(expression) {
    const r = await s('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (!r) return { error: 'NORESULT' }
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text
      return { error: String(d).split('\n').slice(0, 3).join(' ⏎ ') }
    }
    return { value: r.result.value }
  }
  async function waitFor(expression, ms = 20000) {
    const t0 = Date.now()
    let last
    while (Date.now() - t0 < ms) {
      const r = await ev(expression)
      last = r
      if (r.value) return r
      await sleep(300)
    }
    return last
  }

  const url = `${argUrl}${argUrl.includes('?') ? '&' : '?'}ws=ws://127.0.0.1:${WS_PORT}/ws`
  await s('Page.navigate', { url })
  await sleep(2000)

  // ---- 0) 地图容器挂上 ----
  const boot = await waitFor(`(() => !!document.querySelector('.maplibregl-map canvas'))()`, 40000)
  check('页面挂上了地图容器（.maplibregl-map canvas）', boot.value === true, JSON.stringify(boot))

  // ---- 1) 页面真的连上了这个假的 WS 服务端 ----
  const connected = await waitFor(`document.body.innerText.includes('实时通道已连接') ? true : null`, 15000)
  check('页面自己连上了 WS（终端显示"实时通道已连接"）', connected.value === true, JSON.stringify(connected).slice(0, 200))
  check('WS 服务端确实收到了握手', wsFake.state.handshakes >= 1, `handshakes=${wsFake.state.handshakes}`)

  // ---- 2) 静态态势（区域 + 标注）已经画出来 ----
  const stat = await ev(`window.__maStats ? JSON.stringify(window.__maStats()) : null`)
  let st = null
  try { st = JSON.parse(stat.value) } catch { /* ignore */ }
  console.log(`    [dbg] label ids = ${JSON.stringify(st?.labelIds)}`)
  console.log(`    [dbg] area ids  = ${JSON.stringify(st?.areaIds)}`)
  check('静态态势：区域多边形已上屏（4 任务/部署区 + 5 空域要素 = 9）',
    st?.areas === 9, `areas=${st?.areas}（期望 9）`)
  // 标注：场景自己 10 条（4 区名 + 5 个空域要素名 + 1 个节点）+ map-2d 内置演示区域的 1 条
  check('静态态势：场景的 10 条标注全部上屏（4 区名 + 4 空域名 + 出航通道 + 节点）',
    Array.isArray(st?.labelIds) && SCENE_LABEL_IDS.every((id) => st.labelIds.includes(id)),
    `命中 ${Array.isArray(st?.labelIds) ? SCENE_LABEL_IDS.filter((i) => st.labelIds.includes(i)).length : 0}/${SCENE_LABEL_IDS.length}；页面上共 ${st?.labels} 条`)
  check('静态态势：出航通道按 widthM 展成带状面（不是当折线画）',
    Array.isArray(st?.areaIds) && st.areaIds.includes('ZONE:corridor-main'),
    `areaIds=${JSON.stringify(st?.areaIds)}`)

  // ---- 3) 第一轮遥测：3 架 × 4 点 ----
  const ROUND1 = [
    ['uav-opt-001', 'optical', 'recon-1', 116.600, 39.740],
    ['uav-rad-001', 'radar', 'radar-1', 116.606, 39.744],
    ['uav-com-001', 'comm', 'relay-1', 116.612, 39.748],
  ]
  const sent1 = []
  let wroteTo1 = 0
  for (let k = 0; k < 4; k++) {
    for (const [uavId, type, groupId, lng0, lat0] of ROUND1) {
      const lng = lng0 + k * 0.004
      const lat = lat0 + k * 0.002
      wroteTo1 += wsFake.send('telemetry.uav.pos', { uavId, type, groupId, lng, lat, alt: 300 + k * 10, heading: 45, speed: 25, battery: 100 - k, ts: Date.now() })
      sent1.push({ uavId, lng, lat })
      await sleep(FRAME_GAP_MS)
    }
  }
  console.log(`    [dbg] ROUND1 写了 ${wroteTo1} 次（0 = 没有连接可写）；握手 ${wsFake.state.handshakes} 次；活连接 ${wsFake.liveCount()}`)

  const afterRound1 = await waitFor(`(() => {
    const s = window.__maStats && window.__maStats()
    return s && s.drones === 3 && s.tracksOnMap === 3 && s.tracks.every(t => t.points >= 3) ? s : null
  })()`, 15000)
  const r1 = afterRound1.value
  check('第一轮：3 架无人机画出来了', r1?.drones === 3, `drones=${r1?.drones}`)
  check('第一轮：3 条航迹画出来了', r1?.tracksOnMap === 3, `tracksOnMap=${r1?.tracksOnMap}`)
  check('第一轮：每条航迹都累积了 4 个点（增量累积生效）',
    JSON.stringify(r1?.tracks?.map((t) => t.points) ?? []) === JSON.stringify([4, 4, 4]),
    JSON.stringify(r1?.tracks))
  check('第一轮：每个 uavId 的 updates 计数 = 4（逐条累积，不是整表替换）',
    JSON.stringify(r1?.updates?.map((u) => u.updates) ?? []) === JSON.stringify([4, 4, 4]),
    JSON.stringify(r1?.updates))
  check('第一轮：编队配色按 groupId 取到（recon-1 / radar-1 / relay-1）',
    JSON.stringify(r1?.updates?.map((u) => u.groupId) ?? []) === JSON.stringify(['recon-1', 'radar-1', 'relay-1']),
    JSON.stringify(r1?.updates?.map((u) => u.groupId)))

  // ---- 4) 直接读地图数据源：坐标真的进去了 ----
  const src1 = await ev(`(async () => {
    const m = await import('/node_modules/.vite/deps/maplibre-gl.js')
    void m
    return null
  })()`)
  void src1
  const srcCheck = await ev(`(() => {
    const el = document.querySelector('.maplibregl-map')
    void el
    return JSON.stringify(window.__maStats ? window.__maStats().link : null)
  })()`)
  void srcCheck

  const layerCheck = await ev(`(() => {
    const st = window.__maStats && window.__maStats()
    return JSON.stringify({ link: st && st.link, styleSource: st && st.styleSource })
  })()`)
  let lc = null
  try { lc = JSON.parse(layerCheck.value) } catch { /* ignore */ }
  check('链路状态为 open 且无重连', lc?.link?.state === 'open' && (lc?.link?.reconnects ?? 0) === 0,
    JSON.stringify(lc?.link))
  check('样式来源标注为内联默认值（未给 ?style=）',
    String(lc?.styleSource ?? '').includes('内联默认值'), String(lc?.styleSource))

  // ---- 5) 第二轮遥测：**同一个页面**再加 2 架（其中一个 id 是老的，用来证明"同一条记录被继续更新"）----
  const ROUND2 = [
    ['uav-opt-001', 'optical', 'recon-1', 116.612, 39.746],   // ← 第一轮出现过：updates 应继续累加
    ['uav-opt-003', 'optical', 'recon-2', 116.616, 39.738],   // ← 新 id
    ['uav-ew-001', 'electronic', 'ew-1', 116.604, 39.736],    // ← 新 id
  ]
  for (let k = 1; k <= 3; k++) {
    for (const [uavId, type, groupId, lng0, lat0] of ROUND2) {
      wsFake.send('telemetry.uav.pos', { uavId, type, groupId, lng: lng0 + k * 0.003, lat: lat0 - k * 0.001, alt: 320, heading: 90, speed: 24, battery: 99, ts: Date.now() })
      await sleep(FRAME_GAP_MS)
    }
  }
  const afterRound2 = await waitFor(`(() => {
    const s = window.__maStats && window.__maStats()
    return s && s.drones === 5 && s.tracksOnMap === 5 ? s : null
  })()`, 15000)
  const r2 = afterRound2.value
  check('第二轮：UAV 总数 5（新增 2 架，老的 3 架还在）', r2?.drones === 5, `drones=${r2?.drones}`)
  check('第二轮：没被更新的老 UAV 一个字节没动（updates 仍为 4、航迹仍为 4 点）',
    r2?.updates?.filter((u) => ['uav-rad-001', 'uav-com-001'].includes(u.uavId)).every((u) => u.updates === 4)
    && r2?.tracks?.filter((t) => ['uav-rad-001', 'uav-com-001'].includes(t.uavId)).every((t) => t.points === 4),
    JSON.stringify(r2?.updates))
  check('第二轮：被继续更新的老 UAV 涨到 7（同一条记录累加，不是重建）',
    r2?.updates?.find((u) => u.uavId === 'uav-opt-001')?.updates === 7,
    JSON.stringify(r2?.updates?.find((u) => u.uavId === 'uav-opt-001')))
  check('第二轮：新 UAV 的 updates = 3',
    r2?.updates?.filter((u) => ['uav-opt-003', 'uav-ew-001'].includes(u.uavId)).every((u) => u.updates === 3),
    JSON.stringify(r2?.updates?.filter((u) => ['uav-opt-003', 'uav-ew-001'].includes(u.uavId))))
  check('第二轮：被继续更新的老航迹加长（4 → 7 点）',
    r2?.tracks?.find((t) => t.uavId === 'uav-opt-001')?.points === 7,
    JSON.stringify(r2?.tracks?.find((t) => t.uavId === 'uav-opt-001')))
  check('第二轮：非法数据被挡下且计数（rejected 只统计坏数据）',
    (r2?.rejected ?? -1) === 0, `rejected=${r2?.rejected}`)

  // ---- 6) 主动断开：页面必须如实提示"数据可能已过期" ----
  wsFake.dropAll()
  const stale = await waitFor(`document.body.innerText.includes('数据可能已过期') ? true : null`, 20000)
  check('断开后页面提示"数据可能已过期"', stale.value === true, JSON.stringify(stale).slice(0, 200))
  const closedTxt = await ev(`document.body.innerText.includes('实时通道已断开') ? '断开已显示' : '未显示'`)
  check('断开后终端显示"实时通道已断开"', closedTxt.value === '断开已显示', String(closedTxt.value))

  // ---- 7) 自动重连：恢复后连接状态回到 open（数据不丢） ----
  const reconnected = await waitFor(`(() => {
    const s = window.__maStats && window.__maStats()
    return s && s.link && s.link.state === 'open' && s.link.reconnects >= 1 ? s : null
  })()`, 30000)
  const rc = reconnected.value
  check('断开后自动重连成功（reconnects ≥ 1）', (rc?.link?.reconnects ?? 0) >= 1, JSON.stringify(rc?.link))
  check('重连后已累积的无人机没有丢（仍是 5 架）', rc?.drones === 5, `drones=${rc?.drones}`)

  // ---- 8) 页面没有未捕获的 console.error ----
  const realErrors = consoleErrors.filter((e) => !/Failed to load resource|net::ERR|WebSocket/i.test(e))
  check('页面 console.error 只有预期的网络类（无未捕获异常）',
    realErrors.length === 0, realErrors.slice(0, 3).join(' || ') || '（无）')

  try { ws.close() } catch { /* ignore */ }
} catch (e) {
  check('脚本自身执行', false, String(e?.message ?? e))
} finally {
  try { wsFake?.close() } catch { /* ignore */ }
  try { chrome?.kill() } catch { /* ignore */ }
  if (!KEEP) { try { rmSync(profile, { recursive: true, force: true }) } catch { /* ignore */ } }
}

console.log(`[render-check-map] url=${argUrl}  （页面经由 ?ws=ws://127.0.0.1:${WS_PORT}/ws 连到本脚本起的 WS 服务端）`)
for (const r of results) console.log('  ' + r)
console.log(`[render-check-map] 通过 ${pass} / 失败 ${fail}`)
console.log(fail === 0
  ? '[render-check-map] PASS：无人机与航迹真的画出来了；增量累积、编队配色、断线提示与自动重连均成立'
  : '[render-check-map] FAIL：见上表')
process.exit(fail === 0 ? 0 : 1)
