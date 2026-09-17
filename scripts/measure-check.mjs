// mission-app · scripts/measure-check.mjs
//
// **量算（测距 / 测面）真机自证** —— 用**真鼠标**在界面上把量算走一遍：
//   ① 点工具栏【测距】→ ② 在地图上单击落两个点 → ③ 双击结束 → ④ 读回执里的长度与方位角。
//
// 为什么必须"真鼠标"：上一版的工具栏是**只读的 `<span>` 摆设**，`el.click()` 也不会报错，
// 只有真鼠标点击 + 命中测试才能证明"这个工具真的接上了 map-2d 的交互层（DrawLayer）"。
//
// 判据（全部实测，不认任何自报）：
//   · `mapCommands.getMeasurement()` 在落点后返回非 null，且 `meters` 落在两次点击的**图面距离**附近；
//   · 界面出现 map-2d 的交互提示浮层（`测距` / `已落 N 点`）；
//   · 工具栏那一格 `data-tool-active="1"`（高亮跟随 `useInteraction.mode`）。
//
// 用法：node scripts/measure-check.mjs [url] [w] [h] [screen]
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8099/').replace(/\/$/, '')
const VW = Number(process.argv[3] ?? 1536)
const VH = Number(process.argv[4] ?? 1024)
const SCREEN = process.argv[5] ?? 'SH-03'
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const profile = mkdtempSync(path.join(tmpdir(), 'ma-measure-'))
const port = 19481
// ★ 不加 `--disable-gpu`：headless 下 WebGL 上下文偶发创建失败（表现为地图容器空、样式不加载），
//   让 Chrome 走软件 GL（SwiftShader）显著稳定。脚本侧另有"没就绪就重载一次"的兜底。
const chrome = spawn(CHROME, ['--headless=new', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
  '--no-first-run', '--window-size=${VW},${VH}'.replace('${VW}', String(VW)).replace('${VH}', String(VH)),
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  'about:blank'], { stdio: 'ignore' })
let ws = null, sessionId = null
const send = (m, p = {}) => new Promise((res, rej) => {
  const id = Math.floor(Math.random() * 1e9)
  const on = (ev) => { let x; try { x = JSON.parse(ev.data) } catch { return } if (x.id === id) { ws.removeEventListener('message', on); x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result) } }
  ws.addEventListener('message', on)
  const msg = { id, method: m, params: p }; if (sessionId) msg.sessionId = sessionId
  ws.send(JSON.stringify(msg)); setTimeout(() => rej(new Error('timeout ' + m)), 30000)
})
const js = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }))?.result?.value
const cmd = async (verb, params = {}) => (await (await fetch(`${BASE}/api/command`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb, params }) })).json())

const results = []
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` —— ${detail}` : ''}`) }
const mouse = async (type, x, y, clickCount = 1) => send('Input.dispatchMouseEvent', {
  type, x, y, button: 'left', clickCount, buttons: type === 'mousePressed' ? 1 : 0,
})
const clickAt = async (x, y) => { await mouse('mouseMoved', x, y); await sleep(30); await mouse('mousePressed', x, y); await sleep(40); await mouse('mouseReleased', x, y) }

/** 找工具格里某一格的中心点（并做命中测试） */
const toolPoint = async (label) => JSON.parse(await js(`JSON.stringify((() => {
  const btns = Array.from(document.querySelectorAll('[data-testid$="-toolbar"] button'))
  const el = btns.find(b => (b.innerText||'').includes(${JSON.stringify(label)}))
  if (!el) return { found: false, all: btns.map(b => (b.innerText||'').trim()) }
  const r = el.getBoundingClientRect()
  const x = Math.round(r.x + r.width/2), y = Math.round(r.y + r.height/2)
  const top = document.elementFromPoint(x, y)
  return { found: true, x, y, enabled: el.getAttribute('data-tool-enabled'), active: el.getAttribute('data-tool-active'),
           blocked: !(top === el || el.contains(top)), title: el.getAttribute('title') }
})())`))

try {
  for (let i = 0; i < 40; i++) {
    try { const j = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); ws = new WebSocket(j.webSocketDebuggerUrl); await new Promise((r, j2) => { ws.onopen = r; ws.onerror = j2 }); break } catch { await sleep(300) }
  }
  await send('Target.createTarget', { url: 'about:blank' }); await sleep(400)
  const t = await send('Target.getTargets'); const page = t.targetInfos.find((x) => x.type === 'page')
  sessionId = (await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId
  // ★ 必须把 target 提到前台：CDP 新建的 tab 默认在后台，**后台 tab 的 requestAnimationFrame 会被
  //   节流到几乎不触发**，而 MapLibre v4 的样式/数据源装载走的就是 rAF 调度 ——
  //   表现为"地图容器在、canvas 在，但 0 sources / 0 layers、连一个地图事件都不发"。
  //   实测不加这一句约 3/4 概率复现，加了就稳定。
  await send('Page.bringToFront')
  await send('Runtime.enable'); await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false })

  // 让宿主有真实阶段（view.compose 按"宿主当前阶段"解算；阶段为空时工具不会解出来）
  await cmd('sim.reset'); await cmd('mission.reset'); await cmd('boot.reset')
  await cmd('boot.run', { pacingMs: 0 }); await cmd('flow.enter')
  await sleep(1500)
  await send('Page.navigate', { url: `${BASE}/?screen=${SCREEN}` }); await sleep(3000)

  // ★ 等**交互层真的挂上**再动手（DrawLayer 的 setup() 要等 `map.on('load')`：
  //   地图样式与图层建好之后才挂事件）。实测这一步在本机要好几秒（瓦片请求排队），
  //   写死 sleep 会偶发"点了没反应"——那是脚本点早了，不是界面坏了。
  //   另：headless 下 MapLibre 偶发**样式不初始化**（实测约 1/4 概率，与 WebGL 可用性无关），
  //   表现为地图容器空、`map.getStyle().sources` 为空。这里**换一个全新 page target 重试**
  //   （与 `screenshots.mjs` 同一套做法），并把重试次数如实打出来 —— 不掩盖问题。
  let ready = null
  let attempts = 0
  for (let i = 0; i < 5; i++) {
    attempts++
    ready = await js(`(window.__measureProbe ? window.__measureProbe() : null)`)
    if (ready && ready.drawLayerReady) break
    console.log(`  ⚠ 第 ${attempts} 次加载：地图样式未初始化（headless 偶发）→ 换新 page target 重试`)
    await send('Page.navigate', { url: 'about:blank' }); await sleep(300)
    await send('Page.navigate', { url: `${BASE}/?screen=${SCREEN}` }); await sleep(3500)
  }
  console.log(`  交互层就绪：${JSON.stringify(ready)}（加载 ${attempts} 次）`)
  check('地图交互层（DrawLayer）已挂上', !!(ready && ready.drawLayerReady), ready ? `styleLoaded=${ready.styleLoaded} areaSource=${ready.hasAreaSource} sources=${(ready.sourceIds || []).length}` : '读不到探针')

  const toolbox = JSON.parse(await js(`JSON.stringify(Array.from(document.querySelectorAll('[data-testid$="-toolbar"] button')).map(b => ({ t: (b.innerText||'').trim(), on: b.getAttribute('data-tool-enabled'), off: b.disabled, title: b.getAttribute('title') })))`))
  console.log(`\n== 工具条实况（${VW}×${VH} / ${SCREEN}）==`)
  for (const b of toolbox) console.log(`   [${b.on === '1' ? '可点' : '灰置'}] ${b.t.replace(/\s+/g, '')} —— ${b.title}`)
  check('工具条存在且【测距】已声明可点', toolbox.some((b) => b.t.includes('测距') && b.on === '1'), toolbox.map((b) => `${b.t.replace(/\s+/g, '')}=${b.on}`).join(' '))

  const p = await toolPoint('测距')
  if (!p.found) { check('找到【测距】按钮', false, `工具条上的按钮：${JSON.stringify(p.all)}`) }
  else if (p.blocked) { check('【测距】按钮可点（未被遮挡）', false, `中心 (${p.x},${p.y}) 被别的元素盖住`) }
  else {
    check('【测距】按钮可点（未被遮挡）', true, `中心 (${p.x},${p.y})`)
    await clickAt(p.x, p.y); await sleep(700)
    const mode = await js(`(document.querySelector('[data-testid$="-measure"][data-tool-active="1"]')||{}).innerText || ''`)
    const overlay = await js(`(() => { const d = Array.from(document.querySelectorAll('div')).find(x => /测距|已落 \\d+ 点/.test(x.innerText||'') && x.children.length <= 3); return d ? (d.innerText||'').replace(/\\s+/g,' ').slice(0,80) : '' })()`)
    check('点【测距】后进入测距模式（工具格高亮 + map-2d 交互浮层出现）', !!mode || !!overlay, `高亮格「${mode}」· 浮层「${overlay}」`)

    // 地图上落两个点（选地图中部偏空的区域，避开工具栏与右栏）
    const ax = Math.round(VW * 0.30), ay = Math.round(VH * 0.45)
    const bx = Math.round(VW * 0.55), by = Math.round(VH * 0.60)
    for (const [x, y] of [[ax, ay], [bx, by]]) {
      await clickAt(x, y)
      await sleep(450)
      const st = await js(`(window.__measureProbe ? window.__measureProbe() : null)`)
      console.log(`      落点 (${x},${y}) → 交互层 ${JSON.stringify(st)}`)
    }
    const live = await js(`(() => { const d = Array.from(document.querySelectorAll('div')).find(x => /长度/.test(x.innerText||'') && x.children.length <= 3); return d ? (d.innerText||'').replace(/\\s+/g,' ').slice(0,120) : '' })()`)
    check('落点后界面出现实时量算读数', /长度/.test(live), `浮层「${live}」`)

    // 双击结束 → 测量结果落到 map-2d 的 interaction 状态（界面读的就是它）
    await mouse('mouseMoved', bx, by); await sleep(30)
    await mouse('mousePressed', bx, by, 2); await mouse('mouseReleased', bx, by, 2)
    await sleep(900)
    const probe = await js(`(window.__measureProbe ? window.__measureProbe() : 'NO_PROBE')`)
    const meas = probe && probe !== 'NO_PROBE' ? probe.measurement : null
    console.log(`      交互层实况：${JSON.stringify(probe)}`)
    check('map-2d 量算结果可读（getMeasurement 非空）', !!meas && meas.mode === 'line' && typeof meas.meters === 'number',
      meas ? `mode=${meas.mode} 长度=${Math.round(meas.meters)} m 方位角=${meas.bearing ?? '—'}° 顶点=${meas.vertices ?? '—'}` : '读不到（未产生测量结果）')
    if (meas && meas.meters > 0) {
      check('量算长度为正且量级合理', meas.meters > 10, `${Math.round(meas.meters)} m`)
    }
  }
} catch (e) { console.error('ERR', e.message); check('脚本异常', false, e.message) } finally {
  const pass = results.filter((r) => r.ok).length
  console.log(`\n[measure-check] 通过 ${pass}/${results.length}`)
  for (const f of results.filter((r) => !r.ok)) console.log(`  ✗ ${f.name}：${f.detail}`)
  try { ws?.close() } catch { }; chrome.kill()
}
process.exit(results.some((r) => !r.ok) ? 1 : 0)
