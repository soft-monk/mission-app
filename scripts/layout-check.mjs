// mission-app · scripts/layout-check.mjs
//
// **排版与可点性自证（20 屏 × 多视口）**——回答一个 click-check 答不了的问题：
// 「人用真鼠标点得到吗？」
//
// 为什么需要它：`click-check.mjs` 用的是 `el.click()`（JS 合成事件），**绕过命中测试与遮挡**
// ——所以"脚本 32/32 通过、人却卡在某一步点不动"这种缺陷它看不见。实测缺陷：
// 1366×768 下 SH-04 右栏两枚按钮被挤出滚动容器可视区，`getBoundingClientRect()` 仍返回坐标、
// `el.click()` 仍能触发，但**真鼠标点在那个坐标上命中的是外层容器**，用户彻底卡死。
//
// 判据（每一项都是"真人点不到"的硬条件）：
//   ① 视口外：控件矩形不完全落在视口内；
//   ② 被裁切：某个 overflow 祖先的可视盒装不下控件中心点；
//   ③ 被遮挡：`elementFromPoint(中心)` 不是控件自身也不是它的后代（含 pointer-events:none 的上层）。
//
// 用法：node scripts/layout-check.mjs [url] [--viewports 1536x1024,1366x768] [--screens SH-03,SH-04]
// 前置：宿主已起（demo.ps1 serve）；本脚本用 `?screen=` 深链逐屏检查，**不改流程状态**。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8099/').replace(/\/$/, '')
const argOf = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null }
const VIEWPORTS = (argOf('--viewports') ?? '1536x1024,1366x768,1280x800').split(',').map((s) => {
  const [w, h] = s.split('x').map(Number); return { w, h }
})
const SCREENS = (argOf('--screens') ?? Array.from({ length: 20 }, (_, i) => `SH-${String(i + 1).padStart(2, '0')}`).join(','))
  .split(',').map((s) => s.trim()).filter(Boolean)

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p))
if (!CHROME) { console.error('找不到 Chrome'); process.exit(2) }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const profile = mkdtempSync(path.join(tmpdir(), 'ma-layout-'))
const port = 19461
const chrome = spawn(CHROME, ['--headless=new', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
  '--no-first-run', '--disable-gpu', '--window-size=1536,1024', 'about:blank'], { stdio: 'ignore' })
let ws = null, sessionId = null
const send = (m, p = {}) => new Promise((res, rej) => {
  const id = Math.floor(Math.random() * 1e9)
  const on = (ev) => { let x; try { x = JSON.parse(ev.data) } catch { return } if (x.id === id) { ws.removeEventListener('message', on); x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result) } }
  ws.addEventListener('message', on)
  const msg = { id, method: m, params: p }; if (sessionId) msg.sessionId = sessionId
  ws.send(JSON.stringify(msg)); setTimeout(() => rej(new Error('timeout ' + m)), 30000)
})
const js = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }))?.result?.value

/** 页面侧：逐个可交互元素做三项判据（返回问题清单） */
const AUDIT = `JSON.stringify((() => {
  const VW = window.innerWidth, VH = window.innerHeight
  const out = { vw: VW, vh: VH, total: 0, problems: [], overlapScore: 0 }
  const els = Array.from(document.querySelectorAll('button, [role=button], select, input, [data-testid^="sh03-scene-card"]'))
  const label = (el) => (el.innerText || el.getAttribute('title') || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 36)
  const idOf = (el) => el.getAttribute('data-testid') || el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : '')
  for (const el of els) {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue
    // ★ 收在**折叠块**（未打开的 <details> / <summary> 之外的内容）里的控件**本就不该可见**：
    //   它们不是"被遮挡"，而是"用户没展开"。跳过，避免把有意的折叠误报成缺陷。
    let inClosedDetails = false
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (p.tagName === 'DETAILS' && !p.open) { inClosedDetails = true; break }
    }
    if (inClosedDetails) continue
    out.total++
    const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2)
    const name = label(el) || idOf(el)
    // ① 视口外 / 部分出界
    if (r.right < 0 || r.bottom < 0 || r.left > VW || r.top > VH) {
      out.problems.push({ kind: 'offscreen', el: idOf(el), name, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], why: '整个控件在视口外' })
      continue
    }
    // ② 被 overflow 祖先挡在可视盒之外。分两种：
    //    · hidden（不可滚动）→ **真点不到**，算硬缺陷；
    //    · auto/scroll（可滚动）→ 滚一下还能点到，算"要滚动才能看到"的体验缺陷（单列一类）。
    let clipped = null
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const pcs = getComputedStyle(p)
      if (!/auto|hidden|scroll/.test(pcs.overflowY + pcs.overflowX)) continue
      const pr = p.getBoundingClientRect()
      if (cy < pr.top - 0.5 || cy > pr.bottom + 0.5 || cx < pr.left - 0.5 || cx > pr.right + 0.5) {
        clipped = { by: idOf(p), box: [Math.round(pr.x), Math.round(pr.y), Math.round(pr.width), Math.round(pr.height)],
          scrollable: /auto|scroll/.test(pcs.overflowY + pcs.overflowX),
          scrollTop: Math.round(p.scrollTop), scrollH: Math.round(p.scrollHeight), clientH: Math.round(p.clientHeight) }
        break
      }
    }
    if (clipped && !clipped.scrollable) {
      out.problems.push({ kind: 'hidden', el: idOf(el), name, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        why: '被不可滚动的裁切祖先 ' + clipped.by + ' ' + JSON.stringify(clipped.box) + ' 挡在可视区外 —— 用户看不到也点不到' })
      continue
    }
    if (clipped && cy > VH) {
      // 已经在视口下方、且还得先滚外层容器才能露出来 → 真人基本找不到
      out.problems.push({ kind: 'offscreen', el: idOf(el), name, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        why: '在视口下方（y=' + Math.round(r.y) + ' > ' + VH + '）' })
      continue
    }
    if (clipped && clipped.scrollable && clipped.scrollH > clipped.clientH + 2 && cy > clipped.box[1] + clipped.box[3]) {
      out.problems.push({ kind: 'needscroll', el: idOf(el), name, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        why: '落在可滚动面板 ' + clipped.by + ' 的可视区下方（要滚动 ' + Math.round(cy - (clipped.box[1] + clipped.box[3])) + 'px 才看得到）' })
      continue
    }
    if (clipped) { out.problems.push({ kind: 'clipped', el: idOf(el), name, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], why: '被裁切祖先 ' + clipped.by + ' 挡在可视区外' }); continue }
    // ③ 命中测试：最上层是不是它自己
    const top = document.elementFromPoint(cx, cy)
    if (!top) { out.problems.push({ kind: 'nohit', el: idOf(el), name, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], why: '中心点没有元素' }); continue }
    if (!(top === el || el.contains(top) || top.contains(el))) {
      out.problems.push({ kind: 'covered', el: idOf(el), name, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        html: (el.outerHTML || '').replace(/\\s+/g, ' ').slice(0, 140),
        why: '中心 (' + cx + ',' + cy + ') 最上层是 ' + idOf(top) + '「' + label(top).slice(0,20) + '」' })
    }
  }
  // ④ 面板互相压盖粗测：收集所有带 data-testid 的绝对定位面板，两两算交叠面积
  const panels = Array.from(document.querySelectorAll('[data-testid]')).filter((e) => {
    const cs = getComputedStyle(e); const r = e.getBoundingClientRect()
    return cs.position === 'absolute' && r.width > 120 && r.height > 60
  })
  for (let i = 0; i < panels.length; i++) for (let j = i + 1; j < panels.length; j++) {
    const a = panels[i], b = panels[j]
    if (a.contains(b) || b.contains(a)) continue
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
    const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left)
    const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top)
    if (ox > 24 && oy > 24) {
      const area = ox * oy
      if (area > 4000) out.problems.push({ kind: 'overlap', el: idOf(a) + ' × ' + idOf(b), name: '', rect: [Math.round(ox), Math.round(oy)],
        why: '两块面板交叠 ' + Math.round(ox) + '×' + Math.round(oy) + 'px（' + Math.round(area) + ' px²）' })
    }
  }
  return out
})())`

const results = []

try {
  for (let i = 0; i < 40; i++) {
    try { const j = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); ws = new WebSocket(j.webSocketDebuggerUrl); await new Promise((r, j2) => { ws.onopen = r; ws.onerror = j2 }); break } catch { await sleep(300) }
  }
  await send('Target.createTarget', { url: 'about:blank' }); await sleep(400)
  const t = await send('Target.getTargets'); const page = t.targetInfos.find((x) => x.type === 'page')
  sessionId = (await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId
  await send('Page.bringToFront')  // ★ 后台 tab 的 rAF 被节流 → MapLibre 样式装载会卡死（实测）
  await send('Runtime.enable'); await send('Page.enable')

  for (const vp of VIEWPORTS) {
    await send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: false })
    console.log(`\n########## 视口 ${vp.w}×${vp.h} ##########`)
    for (const id of SCREENS) {
      await send('Page.navigate', { url: `${BASE}/?screen=${id}` })
      await sleep(1500)
      const aud = JSON.parse(await js(AUDIT))
      // ★ 不在这里截图：同一个 page target 连截十几屏会 `Page.captureScreenshot` 超时
      //   （已知坑，见交接文档 §5.2）。要图请用 `screenshots.mjs`（一屏一个全新 target）。
      const bad = aud.problems
      results.push({ vp: `${vp.w}x${vp.h}`, screen: id, total: aud.total, bad })
      const tag = bad.length ? '✗' : '✓'
      console.log(`  ${tag} ${id}  可交互 ${aud.total} 项，问题 ${bad.length} 项`)
      for (const p of bad) console.log(`      · [${p.kind}] ${p.el}${p.name ? `「${p.name}」` : ''} —— ${p.why}`)
    }
  }
} catch (e) { console.error('ERR', e.message) } finally {
  const badTotal = results.reduce((n, r) => n + r.bad.length, 0)
  console.log(`\n[layout-check] 检查 ${results.length} 屏次（${VIEWPORTS.length} 视口 × ${SCREENS.length} 屏），问题合计 ${badTotal} 条`)
  const byKind = {}
  for (const r of results) for (const p of r.bad) byKind[p.kind] = (byKind[p.kind] ?? 0) + 1
  console.log('  分类：' + Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join('  '))
  // 报告目录可能被清过（点开头的临时目录），写之前先确保它在
  mkdirSync(path.resolve('docs/screens/.layout'), { recursive: true })
  writeFileSync(path.resolve('docs/screens/.layout/report.json'), JSON.stringify(results, null, 1))
  console.log('  报告：docs/screens/.layout/report.json')
  try { ws?.close() } catch { }; chrome.kill()
}
process.exit(0)
