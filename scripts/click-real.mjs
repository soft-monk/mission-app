// 临时排障：**真实鼠标**手点通路（CDP Input 域 + elementFromPoint 命中测试）。
// 与 click-check.mjs 的差别：后者用 el.click()（JS 合成事件，绕过命中测试与遮挡），
// 所以"脚本能点通、人点不通"这类问题它看不见。本脚本模拟真人的鼠标按下/抬起。
//
// 用法：node scripts/.click-real.mjs [url] [width] [height]
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8099/').replace(/\/$/, '')
const VW = Number(process.argv[3] ?? 1536)
const VH = Number(process.argv[4] ?? 1024)
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const profile = mkdtempSync(path.join(tmpdir(), 'ma-real-'))
const port = 19453
const chrome = spawn(CHROME, ['--headless=new', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
  '--no-first-run', '--disable-gpu', `--window-size=${VW},${VH}`, 'about:blank'], { stdio: 'ignore' })
let ws = null, sessionId = null
const send = (m, p = {}) => new Promise((res, rej) => {
  const id = Math.floor(Math.random() * 1e9)
  const on = (ev) => { let x; try { x = JSON.parse(ev.data) } catch { return } if (x.id === id) { ws.removeEventListener('message', on); x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result) } }
  ws.addEventListener('message', on)
  const msg = { id, method: m, params: p }; if (sessionId) msg.sessionId = sessionId
  ws.send(JSON.stringify(msg)); setTimeout(() => rej(new Error('timeout ' + m)), 25000)
})
const js = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }))?.result?.value
const st = async () => (await (await fetch(`${BASE}/api/state`)).json())
const cmd = async (verb, params = {}) => (await (await fetch(`${BASE}/api/command`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb, params }) })).json())
const screen = async () => js(`(document.querySelector('[data-testid="flow-badge"]')||{}).dataset?.screen || ''`)

/** 在页面里找到元素几何中心，并做命中测试；返回 {x,y,top,blocked,text} */
const locate = async (spec) => JSON.parse(await js(`JSON.stringify((() => {
  const vis = (arr) => arr.filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
  let el = null
  ${spec.sel ? `el = vis(Array.from(document.querySelectorAll(${JSON.stringify(spec.sel)})))[0] || null` : ''}
  ${!spec.sel && spec.tid ? `el = vis(Array.from(document.querySelectorAll('[data-testid]'))).find(b => b.getAttribute('data-testid') === ${JSON.stringify(spec.tid)}) || null` : ''}
  ${!spec.sel && !spec.tid ? `el = vis(Array.from(document.querySelectorAll('button, [role=button], select'))).find(b => new RegExp(${JSON.stringify(spec.re ?? '')}).test((b.innerText||''))) || null` : ''}
  if (!el) return { found: false }
  const r = el.getBoundingClientRect()
  const x = Math.round(Math.min(Math.max(r.x + r.width/2, 1), window.innerWidth - 2))
  const y = Math.round(Math.min(Math.max(r.y + r.height/2, 1), window.innerHeight - 2))
  const top = document.elementFromPoint(x, y)
  return { found: true, x, y, rect: [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)],
    text: (el.innerText||'').trim().replace(/\\s+/g,' ').slice(0,40),
    blocked: !(top === el || el.contains(top)),
    topTag: top ? top.tagName + '|' + (top.getAttribute('data-testid')||'') + '|' + (typeof top.className === 'string' ? top.className.slice(0,50) : '') : null }
})())`))

const realClick = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await sleep(40)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 })
  await sleep(50)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 })
}

const results = []
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` —— ${detail}` : ''}`) }

const stepThrough = async (name, spec, wantScreen, wantStep) => {
  const cur = await screen()
  const loc = await locate(spec)
  if (!loc.found) { check(name, false, `找不到元素（${spec.tid ?? spec.re ?? spec.sel}）· 当前屏 ${cur}`); return false }
  if (loc.blocked) {
    check(name, false, `❌ 被遮挡：中心 (${loc.x},${loc.y}) 最上层是 ${loc.topTag}，不是目标「${loc.text}」`)
    return false
  }
  await realClick(loc.x, loc.y)
  const t0 = Date.now()
  while (Date.now() - t0 < 20000) {
    const s = await st(); const scr = await screen()
    if ((wantScreen && scr === wantScreen) || (wantStep && s.step >= wantStep)) {
      check(name, true, `落屏 ${scr} · 步 ${s.step} · 阶段 ${s.phase}`); await sleep(800); return true
    }
    await sleep(300)
  }
  const s = await st()
  check(name, false, `点了没反应：屏 ${cur}→${await screen()} · 步 ${s.step} · 阶段 ${s.phase} · 目标「${loc.text}」位于 (${loc.x},${loc.y})`)
  return false
}

try {
  for (let i = 0; i < 40; i++) {
    try { const j = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); ws = new WebSocket(j.webSocketDebuggerUrl); await new Promise((r, j2) => { ws.onopen = r; ws.onerror = j2 }); break } catch { await sleep(300) }
  }
  await send('Target.createTarget', { url: 'about:blank' }); await sleep(400)
  const t = await send('Target.getTargets'); const page = t.targetInfos.find((x) => x.type === 'page')
  sessionId = (await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId
  await send('Page.bringToFront')  // ★ 后台 tab 的 rAF 被节流 → MapLibre 样式装载会卡死（实测）
  await send('Runtime.enable'); await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false })

  await cmd('sim.reset'); await cmd('mission.reset'); await cmd('boot.reset')
  await send('Page.navigate', { url: `${BASE}/` }); await sleep(3500)
  for (let i = 0; i < 60; i++) { const s = await st(); if (s.step >= 2) break; await sleep(500) }

  console.log(`\n== 视口 ${VW}×${VH} ==`)
  await stepThrough('SH-02 【一键自检】', { re: '一键自检|重新自检' }, 'SH-02')
  await stepThrough('SH-02 【进入任务】→ SH-03', { re: '进入任务' }, 'SH-03')
  // 用真鼠标点三张场景卡（含 ▶ 播放圈所在位置）
  await stepThrough('SH-03 场景一卡（卡面）→ SH-04', { sel: '[data-testid="sh03-scene-card"][data-scene="scenario-1"]' }, 'SH-04')
  await stepThrough('SH-04 【进入任务执行】→ SH-05', { re: '进入任务执行' }, 'SH-05', 4)
  await stepThrough('SH-05 【确认采用推荐方案】→ SH-06', { tid: 'btn-adopt-recommended' }, 'SH-06')
  await stepThrough('SH-06 【确认编组】→ 步 5', { tid: 'btn-confirm-group' }, null, 5)
  await stepThrough('SH-06 【进入任务执行】→ SH-07', { re: '进入任务执行' }, 'SH-07', 6)

  writeFileSync(path.resolve('docs/screens/.real-mouse.png'),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  console.log('shot: docs/screens/.real-mouse.png')
} catch (e) { console.error('err', e.message) } finally {
  const pass = results.filter((r) => r.ok).length
  console.log(`\n[.click-real] 通过 ${pass}/${results.length}`)
  for (const f of results.filter((r) => !r.ok)) console.log(`  ✗ ${f.name}：${f.detail}`)
  try { ws?.close() } catch {}; chrome.kill()
}
process.exit(0)
