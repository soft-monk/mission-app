// mission-app · scripts/screenshots.mjs
//
// **逐屏截图**（需求专篇 DES-APP-001 的 20 屏）：用 `?screen=SH-xx` 深链直达每一屏，
// 按 1536×1024（设计基准）截一张，落到 `docs/screens/screens/SH-xx-<屏名>.png`。
//
// 用法：node scripts/screenshots.mjs [url] [--drive]
//       加 `--drive` 时先跑一遍真实流程（`sim.reset` → `mission.reset` → `flow.runAll{speed:60}`），
//       让各屏都有**真实回执数据**再截图；不加则按宿主当前状态截（常用于只看版式）。
//
// 前置：宿主已起 + `apps/web/dist` 是最新前端产物（npm run build）。
//
// 口径：这一步只截图、不做断言（元素断言在 click-check.mjs 里）。
//      步号不满足时该屏可能显示"未就绪"——那正是当期状态，截图如实记录。
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const argv = process.argv.slice(2)
const DRIVE = argv.includes('--drive')
const BASE = (argv.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:8099/').replace(/\/$/, '')
const OUT = path.resolve('docs/screens/screens')
const W = 1536, H = 1024
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SCREENS = [
  ['SH-01', '启动加载界面'], ['SH-02', '自检校验界面'],
  ['SH-03', '任务态势主界面'], ['SH-04', '场景确认界面'],
  ['SH-05', '集群编组界面'], ['SH-06', '方案确认界面'],
  ['SH-07', '链路拓扑界面'], ['SH-08', '链路稳定界面'], ['SH-09', '侦察展开地图界面'],
  ['SH-10', '侦察数据融合界面'], ['SH-11', '目标列表界面'], ['SH-12', '目标详情界面'],
  ['SH-13', 'AI决策界面'], ['SH-14', '打击确认界面'],
  ['SH-15', '执行态势界面'], ['SH-16', '引导控制界面'], ['SH-17', '毁伤评估地图界面'],
  ['SH-18', '任务总结界面'], ['SH-19', '任务执行态势大屏'], ['SH-20', '红方侦察态势大屏'],
]

const profile = mkdtempSync(path.join(tmpdir(), 'ma-shots-'))
const port = 19423
const chrome = spawn(CHROME, ['--headless=new', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1536,1024', 'about:blank'],
  { stdio: 'ignore' })
let ws = null, sessionId = null
const send = (m, p = {}, tmo = 15000) => new Promise((res, rej) => {
  const id = Math.floor(Math.random() * 1e9)
  const on = (ev) => { let x; try { x = JSON.parse(ev.data) } catch { return }
    if (x.id === id) { ws.removeEventListener('message', on); x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result) } }
  ws.addEventListener('message', on)
  const msg = { id, method: m, params: p }; if (sessionId) msg.sessionId = sessionId
  ws.send(JSON.stringify(msg)); setTimeout(() => rej(new Error('timeout ' + m)), tmo)
})
const js = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }))?.result?.value

/**
 * 截一屏：**每屏开一个全新 page target**（同一 target 连截十几屏会把合成器拖垮，
 * 表现就是 `Page.captureScreenshot` 超时 —— 实测踩过），截完即关；失败重试一次。
 */
const shoot = async (id, name) => {
  const { writeFileSync } = await import('node:fs')
  for (let attempt = 1; attempt <= 2; attempt++) {
    let targetId = null
    try {
      const created = await send('Target.createTarget', { url: `${BASE}/?screen=${id}` })
      targetId = created.targetId
      sessionId = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId
      await send('Page.bringToFront')  // ★ 后台 tab 的 rAF 被节流 → MapLibre 样式装载会卡死（实测）
  await send('Runtime.enable'); await send('Page.enable')
      await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
      await sleep(3600)
      const fs2 = await js(`window.__flowStats ? JSON.stringify(window.__flowStats()) : null`)
      let badge = ''
      try { const o = JSON.parse(fs2 || 'null'); badge = o ? `步 ${o.step}/11 · ${o.screen || '?'} · 阶段 ${o.phase || '—'}` : '' } catch { badge = '' }
      const scr = await js(`((window.__flowStats && window.__flowStats().screen) || (document.querySelector('[data-testid="flow-badge"]')||{}).dataset?.screen || '')`)
      const r = await send('Page.captureScreenshot', { format: 'png' }, 20000)
      const file = path.join(OUT, `${id}-${name}.png`)
      writeFileSync(file, Buffer.from(r.data, 'base64'))
      sessionId = null
      await send('Target.closeTarget', { targetId }).catch(() => {})
      return { ok: true, screen: scr, badge: String(badge).replace(/\n/g, ' ').slice(0, 60), file }
    } catch (e) {
      sessionId = null
      if (targetId) await send('Target.closeTarget', { targetId }).catch(() => {})
      if (attempt === 2) return { ok: false, err: e.message }
      console.log(`      （${id} 第 ${attempt} 次失败：${e.message} —— 重试）`)
      await sleep(800)
    }
  }
  return { ok: false, err: 'unknown' }
}

try {
  mkdirSync(OUT, { recursive: true })

  // ---- 可选：先把流程真跑一遍（各屏才有真实回执数据）----
  if (DRIVE) {
    const cmd = async (verb, params = {}) => (await (await fetch(`${BASE}/api/command`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb, params }) })).json())
    const st = async () => (await (await fetch(`${BASE}/api/state`)).json())
    console.log('== --drive：先跑一遍真实流程（sim.reset → mission.reset → flow.runAll 60×）==')
    console.log('   sim.reset      →', (await cmd('sim.reset')).code)
    console.log('   mission.reset  →', (await cmd('mission.reset')).code)
    const t0 = Date.now()
    const r = await cmd('flow.runAll', { speed: 60 })
    const s = await st()
    console.log(`   flow.runAll    → code=${r.code} 用时 ${Math.round((Date.now() - t0) / 1000)}s；现在 step=${s.step} phase=${s.phase}`)
    if (r.code !== 0) console.log(`   （runAll 未全绿：${JSON.stringify(r.error ?? {}).slice(0, 160)} —— 照实继续截图）`)
  }

  for (let i = 0; i < 40; i++) {
    try { const j = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
      ws = new WebSocket(j.webSocketDebuggerUrl); await new Promise((r, jj) => { ws.onopen = r; ws.onerror = jj }); break } catch { await sleep(300) }
  }

  let ok = 0, fail = 0
  for (const [id, name] of SCREENS) {
    const r = await shoot(id, name)
    if (r.ok) {
      console.log(`  ✓ ${id} ${name}  →  ${path.relative(process.cwd(), r.file)}   [屏=${r.screen || '（无）'}] 徽标「${r.badge}」`)
      ok++
    } else {
      console.log(`  ✗ ${id} ${name}：${r.err}`)
      fail++
    }
  }
  console.log(`\n截图汇总：成功 ${ok} / 失败 ${fail} · 输出目录 ${path.relative(process.cwd(), OUT)}`)
} catch (e) {
  console.error('ERR', e.message)
} finally {
  try { ws?.close() } catch {}
  chrome.kill()
}
process.exit(0)
