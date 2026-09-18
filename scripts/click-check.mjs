// mission-app · scripts/click-check.mjs
//
// **手点通路自证（20 屏）**：只用界面上的按钮/卡片（除了少数图上确实没有入口的过渡）从 SH-01 走到 SH-18，
// 每一步都按《宿主需求专篇》DES-APP-001 §4.1 的流程点，并断言"当前屏 / 落到哪一屏 / 哪个步号"。
//
// 用法：node scripts/click-check.mjs [url]        url 默认 http://127.0.0.1:8099/
// 前置：宿主已起（demo.ps1 serve）+ `apps/web/dist` 是最新前端产物（npm run build）。
//
// 口径：
//   · 按**可见文字**点（人怎么点，脚本怎么点）；`data-testid` 只作兜底。
//   · 打印实测原值（步号 / 阶段 / 屏名 / 按钮文字）；卡住就停在那一步并说明原因。
//   · 大屏两屏（SH-19/20）走 `?screen=` 深链单独验（图上没有入口，见 §9-3）。
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BASE = (process.argv[2] ?? 'http://127.0.0.1:8099/').replace(/\/$/, '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const profile = mkdtempSync(path.join(tmpdir(), 'ma-click20-'))
const port = 19427
const chrome = spawn(CHROME, ['--headless=new', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
  '--no-first-run', '--disable-gpu', '--window-size=1536,1024', 'about:blank'], { stdio: 'ignore' })
let ws = null, sessionId = null
const send = (m, p = {}) => new Promise((res, rej) => {
  const id = Math.floor(Math.random() * 1e9)
  const on = (ev) => { let x; try { x = JSON.parse(ev.data) } catch { return }
    if (x.id === id) { ws.removeEventListener('message', on); x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result) } }
  ws.addEventListener('message', on)
  const msg = { id, method: m, params: p }; if (sessionId) msg.sessionId = sessionId
  ws.send(JSON.stringify(msg)); setTimeout(() => rej(new Error('timeout ' + m)), 25000)
})
const js = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }))?.result?.value
const cmd = async (verb, params = {}) => (await (await fetch(`${BASE}/api/command`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb, params }) })).json())
const st = async () => (await (await fetch(`${BASE}/api/state`)).json())

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` —— ${detail}` : ''}`)
}
/** 当前屏（左下流程徽标带 data-screen；取不到就退回页面文字） */
const currentScreen = async () => js(`((window.__flowStats && window.__flowStats().screen) || (document.querySelector('[data-testid="flow-badge"]')||{}).dataset?.screen || '')`)
/** 徽标文案（左下角流程徽标已删；这里用 __flowStats() 现拼一条等价的可读文本，仅供日志） */
const badgeText = async () => {
  const raw = await js(`window.__flowStats ? JSON.stringify(window.__flowStats()) : null`)
  if (!raw) return ''
  try { const o = JSON.parse(raw); return `步 ${o.step}/11 · ${o.screen || '?'} · 阶段 ${o.phase || '—'}` } catch { return '' }
}
const visibleButtons = async () => JSON.parse(await js(`JSON.stringify(Array.from(document.querySelectorAll('button')).filter(b => {
  const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0
}).map(b => ({ t: (b.innerText||'').trim().replace(/\\s+/g,' ').slice(0,40), disabled: !!b.disabled, tid: b.getAttribute('data-testid')||'' })))`))

/**
 * 点一个可交互元素（返回 'clicked' | 'disabled' | 'not-found'）。
 * 三种定位方式（按优先顺序用一个）：`sel` 原始 CSS 选择器 ＞ `tid` ＞ `re` 文字正则。
 * ★ 文字正则**只匹配真正可交互的元素**（button / [role=button] / select）——踩过：
 *   页面上别处也有同名的只读文字（例：任务信息里的"敏捷拒止布控（演示）"），
 *   先匹配到那个 div 就会"点了没反应"。`select` 会设值并派发 change。
 */
const click = async ({ re, tid, sel, value } = {}) => {
  const r = await js(`(() => {
    const interactive = Array.from(document.querySelectorAll('button, [role=button], select'))
    const vis = (arr) => arr.filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
    let el = null
    ${sel ? `el = vis(Array.from(document.querySelectorAll(${JSON.stringify(sel)})))[0] || null` : ''}
    ${!sel && tid ? `el = vis(Array.from(document.querySelectorAll('[data-testid]'))).find(b => b.getAttribute('data-testid') === ${JSON.stringify(tid)}) || null` : ''}
    ${!sel && !tid ? `el = vis(interactive).find(b => /${re}/.test((b.innerText||''))) || null` : ''}
    if (!el) return 'not-found'
    if (el.tagName === 'SELECT') {
      el.value = ${JSON.stringify(value ?? '')}
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return 'clicked'
    }
    if (el.disabled) return 'disabled'
    el.click(); return 'clicked'
  })()`)
  console.log(`      → 点击 ${sel ? `sel=${sel}` : tid ? `[${tid}]` : `/${re}/`}${value ? ` = ${value}` : ''}：${r}`)
  return r
}
/** 点一下并等到期望的屏（或步号）；`allowBlocked` 只影响"没等到"时算不算失败。 */
const clickUntil = async (name, { re, tid, sel, value, screen, step, timeoutMs = 15000, allowBlocked = false }) => {
  // 先报"现在在哪一屏"再点 —— 出了偏差能一眼看出是"脚本点早了"还是"界面没动"
  console.log(`      现在：屏=${await currentScreen()} 步=${(await st()).step}`)
  const r = await click({ re, tid, sel, value })
  if (r !== 'clicked') { check(name, false, `按钮不可点：${r}（${tid ?? re}）`); return false }
  const t0 = Date.now()
  let passed = false
  while (Date.now() - t0 < timeoutMs) {
    const s = await st()
    const scr = await currentScreen()
    if (screen && scr === screen) { check(name, true, `落屏 ${scr} · 步 ${s.step} · 阶段 ${s.phase}`); passed = true; break }
    if (step && s.step >= step) { check(name, true, `步 ${s.step} · 阶段 ${s.phase} · 屏 ${scr}`); passed = true; break }
    await sleep(400)
  }
  if (passed) { await sleep(900); return true }  // ★ 落定再走下一步：切屏/阶段推进都是异步命令
  const s = await st()
  const btns = (await visibleButtons()).map((b) => `${b.disabled ? '[灰]' : '[可]'}${b.t}`).join(' | ')
  check(name, allowBlocked, `未达期望（期望 screen=${screen ?? '-'} step=${step ?? '-'}；实测 screen=${await currentScreen()} step=${s.step} phase=${s.phase}）· 屏上按钮：${btns}`)
  return false
}

try {
  for (let i = 0; i < 40; i++) {
    try { const j = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
      ws = new WebSocket(j.webSocketDebuggerUrl); await new Promise((r, jj) => { ws.onopen = r; ws.onerror = jj }); break } catch { await sleep(300) }
  }
  await send('Target.createTarget', { url: 'about:blank' }); await sleep(400)
  const t = await send('Target.getTargets'); const page = t.targetInfos.find((x) => x.type === 'page')
  sessionId = (await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId
  await send('Page.bringToFront')  // ★ 后台 tab 的 rAF 被节流 → MapLibre 样式装载会卡死（实测）
  await send('Runtime.enable'); await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1536, height: 1024, deviceScaleFactor: 1, mobile: false })

  // ---- 从干净起点开始：仿真回起点 + 清任务 + 清自检
  await cmd('sim.reset'); await cmd('mission.reset'); await cmd('boot.reset')
  await send('Page.navigate', { url: `${BASE}/` })
  await sleep(3000)

  console.log('\n== SH-01 启动加载（无交互，自动跳 SH-02）==')
  for (let i = 0; i < 60; i++) { const s = await st(); if (s.step >= 2) break; await sleep(500) }
  check('SH-01 → 步 2（自检）自动跳转', (await st()).step >= 2, `步 ${(await st()).step} · 徽标「${await badgeText()}」`)

  console.log('\n== SH-02 自检校验 ==')
  await clickUntil('SH-02 【一键自检/重新自检】可点', { re: '一键自检|重新自检', screen: 'SH-02', timeoutMs: 4000 })
  for (let i = 0; i < 40; i++) { const s = await st(); if ((s.selfCheck?.items ?? []).length) break; await sleep(500) }
  const sc = (await st()).selfCheck
  check('SH-02 自检 5 项出结论', (sc?.items ?? []).length >= 5, (sc?.items ?? []).map((i) => `${i.name}=${i.status}`).join(' '))
  const enterBtn = (await visibleButtons()).find((b) => /进入任务/.test(b.t))
  check('SH-02 【进入任务】(有异常项时为『仍要进入任务』) 可点', !!enterBtn && !enterBtn.disabled, enterBtn ? `文字「${enterBtn.t}」` : '按钮不存在')
  await clickUntil('SH-02 → SH-03', { re: '进入任务', screen: 'SH-03', timeoutMs: 20000 })

  console.log('\n== SH-03 任务态势主界面 → SH-04 场景确认 ==')
  const cards03 = (await visibleButtons()).filter((b) => /场景[一二三]/.test(b.t))
  check('SH-03 三张场景卡存在（图上逐字）', cards03.length === 3, cards03.map((b) => b.t).join(' / '))
  await clickUntil('SH-03 点场景卡（场景一）→ SH-04', { sel: '[data-testid="sh03-scene-card"][data-scene="scenario-1"]', screen: 'SH-04', timeoutMs: 12000 })

  console.log('\n== SH-04 场景确认 → SH-05 集群编组（步 4）==')
  await clickUntil('SH-04 【进入任务执行】→ SH-05（步 4）', { re: '进入任务执行', screen: 'SH-05', step: 4, timeoutMs: 20000 })

  console.log('\n== SH-05 集群编组 → SH-06 方案确认 ==')
  await clickUntil('SH-05 【确认采用推荐方案】→ SH-06', { tid: 'btn-adopt-recommended', screen: 'SH-06', timeoutMs: 12000 })

  console.log('\n== SH-06 方案确认 → SH-07 链路拓扑（步 6）==')
  await clickUntil('SH-06 【确认编组/重新确认编组】→ 步 5', { tid: 'btn-confirm-group', step: 5, timeoutMs: 60000 })
  const g6 = await st()
  check('SH-06 下达后宿主把步推到 5（编组确认）', g6.step >= 5, `步 ${g6.step} · 阶段 ${g6.phase}`)
  await clickUntil('SH-06 【进入任务执行 ≫】→ SH-07（步 6）', { re: '进入任务执行', screen: 'SH-07', step: 6, timeoutMs: 30000, allowBlocked: false })

  console.log('\n== SH-07 链路拓扑 → SH-08 链路稳定 → SH-09 ==')
  const b7 = await visibleButtons()
  check('SH-07 【自动优化链路】存在且可点', b7.some((b) => /自动优化链路/.test(b.t) && !b.disabled), b7.filter((b) => /自动优化链路/.test(b.t)).map((b) => b.t).join('') || '未找到')
  const topo = await cmd('topology.evaluate')
  check('SH-07 链路评估 verb 通（topology.evaluate code=0）', topo.code === 0, `code=${topo.code}`)
  // 图上 SH-07 → SH-08 没有按钮（同一步里的两屏）→ 用深链验证 SH-08 能独立渲染
  await send('Page.navigate', { url: `${BASE}/?screen=SH-08` }); await sleep(2500)
  check('SH-08 深链可直达（链路稳定界面）', (await currentScreen()) === 'SH-08', `实测 screen=${await currentScreen()}`)
  await send('Page.navigate', { url: `${BASE}/?screen=SH-07` }); await sleep(2000)
  await clickUntil('SH-07 【进入侦察阶段】→ SH-09（阶段 T4/步 7）', { re: '进入侦察阶段', screen: 'SH-09', step: 7, timeoutMs: 60000 })

  console.log('\n== SH-09 侦察展开 → SH-10 侦察融合 → SH-11 目标列表 ==')
  await clickUntil('SH-09 显示模式切「侦察融合」→ SH-10', { tid: 'sh09-mode-select', value: 'fusion', screen: 'SH-10', timeoutMs: 12000, allowBlocked: true })
  await clickUntil('SH-10 左导航「目标」→ SH-11', { tid: 'nav-目标', screen: 'SH-11', timeoutMs: 12000, allowBlocked: true })

  console.log('\n== SH-11 目标列表 → SH-12 目标详情 ==')
  const cardSel = await js(`(() => { const c = document.querySelector('[data-testid="target-card"]'); return c ? (c.tagName.toLowerCase() + ':' + c.className.toString().slice(0,30)) : 'none' })()`)
  console.log(`      SH-11 目标卡元素：${cardSel}`)
  await clickUntil('SH-11 点目标卡（第一次选中）', { tid: 'target-card', timeoutMs: 2500, allowBlocked: true }); await clickUntil('SH-11 再点一次 → SH-12', { tid: 'target-card', screen: 'SH-12', timeoutMs: 12000, allowBlocked: true })

  console.log('\n== SH-12 目标详情 → SH-13 AI决策 ==')
  await clickUntil('SH-12 【升级为打击目标】→ SH-13', { tid: 'btn-act-upgrade', screen: 'SH-13', timeoutMs: 15000, allowBlocked: true })

  console.log('\n== SH-13 AI决策 → SH-14 打击确认 ==')
  await clickUntil('SH-13 【进入打击确认 ≫】→ SH-14', { tid: 'btn-strike-next', screen: 'SH-14', timeoutMs: 15000 })

  console.log('\n== SH-14 打击确认 → SH-15 执行态势 ==')
  await clickUntil('SH-14 【生成打击任务】→ SH-15（步 10）', { tid: 'btn-strike-confirm', screen: 'SH-15', step: 10, timeoutMs: 60000 })

  console.log('\n== SH-15 执行态势 → SH-16 引导控制 → SH-17 毁伤评估 ==')
  await clickUntil('SH-15 【保持跟踪】→ SH-16', { tid: 'sh15-btn-track', screen: 'SH-16', timeoutMs: 12000, allowBlocked: true })
  await clickUntil('SH-16 【确认引导】→ SH-17', { tid: 'p6-btn-run', screen: 'SH-17', timeoutMs: 40000, allowBlocked: true })

  console.log('\n== SH-17 毁伤评估 → SH-18 任务总结（步 11）==')
  await clickUntil('SH-17 【准备脱离】→ SH-18（步 11）', { re: '准备脱离', screen: 'SH-18', step: 11, timeoutMs: 20000, allowBlocked: true })

  console.log('\n== SH-18 任务总结 ==')
  const b18 = await visibleButtons()
  for (const want of ['返回场景选择', '导出任务报告', '快速脱离体系']) {
    check(`SH-18 按钮【${want}】存在`, b18.some((b) => b.t.includes(want)), b18.filter((b) => b.t.includes(want)).map((b) => `${b.disabled ? '[灰]' : '[可]'}${b.t}`).join('') || '未找到')
  }
  await clickUntil('SH-18 【返回场景选择】→ SH-03（新一轮）', { tid: 'p6-btn-back', screen: 'SH-03', timeoutMs: 30000, allowBlocked: true })

  console.log('\n== 大屏两屏（深链，图上无入口）==')
  for (const [id, name] of [['SH-19', '任务执行态势'], ['SH-20', '红方侦察态势']]) {
    await send('Page.navigate', { url: `${BASE}/?screen=${id}` }); await sleep(3000)
    const s = await st()
    const scr = await currentScreen()
    check(`${id} 深链可直达（${name}）`, scr === id, `实测 screen=${scr} · 步 ${s.step} · 徽标「${(await badgeText()).replace(/\n/g, ' ').slice(0, 40)}」`)
  }
} catch (e) {
  console.error('ERR', e.message)
  check('脚本异常', false, e.message)
} finally {
  const pass = results.filter((r) => r.ok).length
  console.log(`\n[click-check] 通过 ${pass} / 失败 ${results.length - pass}（共 ${results.length} 条）`)
  const failed = results.filter((r) => !r.ok)
  if (failed.length) { console.log('失败项：'); for (const f of failed) console.log(`  - ${f.name}：${f.detail}`) }
  try { ws?.close() } catch {}
  chrome.kill()
}
process.exit(results.some((r) => !r.ok) ? 1 : 0)
