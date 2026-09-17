// mission-app · scripts/click-check.mjs
//
// **手点通路自证**：只用界面上的按钮（不调任何 verb 推流程）从步 1 走到步 11 ——
// 也就是把 README《二、手点 11 屏》那一章机器验一遍。每屏打印：左上角步骤指示、可见按钮
// （文字 + 是否灰），然后按手册点下去；被阶段门禁挡下时，按人手的做法再点【强制推进（force）】
// 并把这件事打印出来（正常路径上 force 不该出现）。
//
// 用法：node scripts/click-check.mjs [url]      url 默认 http://127.0.0.1:8099/
// 前置：宿主已起（demo.ps1 serve），且它托管的 apps/web/dist 是最新前端产物（npm run build）。
// 口径：打印实测原值（步/阶段/按钮文字/读数）；卡住就停在那一屏并说明卡在哪。
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BASE = (process.argv[2] ?? 'http://127.0.0.1:8099/').replace(/\/$/, '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const profile = mkdtempSync(path.join(tmpdir(), 'ma-click-'))
const port = 19417
const chrome = spawn(CHROME, ['--headless=new', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
  '--no-first-run', '--disable-gpu', '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' })
let ws = null, sessionId = null
const send = (m, p = {}) => new Promise((res, rej) => {
  const id = Math.floor(Math.random() * 1e9)
  const on = (ev) => { let x; try { x = JSON.parse(ev.data) } catch { return }
    if (x.id === id) { ws.removeEventListener('message', on); x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result) } }
  ws.addEventListener('message', on)
  const msg = { id, method: m, params: p }; if (sessionId) msg.sessionId = sessionId
  ws.send(JSON.stringify(msg)); setTimeout(() => rej(new Error('timeout ' + m)), 20000)
})
const js = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }))?.result?.value
const cmd = async (verb, params = {}) => (await (await fetch(`${BASE}/api/command`, { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb, params }) })).json())
const st = async () => (await (await fetch(`${BASE}/api/state`)).json())

const indicator = () => js(`(document.body.innerText.match(/步 \\d+\\/11[^\\n]*/) || [''])[0]`)
const buttons = () => js(`JSON.stringify(Array.from(document.querySelectorAll('button')).filter(b => {
  const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0
}).map(b => ({ t: (b.innerText||'').trim().replace(/\\s+/g,' ').slice(0,40), disabled: !!b.disabled, tid: b.getAttribute('data-testid')||'' })))`)
const dump = async (label) => {
  const s = await st()
  const bs = JSON.parse(await buttons())
  console.log(`\n=== ${label} ===  host: step=${s.step} ${s.stepKey} phase=${s.phase} ｜ 页面: ${await indicator()}`)
  for (const b of bs) console.log(`   ${b.disabled ? '[灰]' : '[可点]'} "${b.t}"${b.tid ? ` (${b.tid})` : ''}`)
  return bs
}
// 按**可见文字**点（人怎么点，脚本怎么点）
const clickText = async (re, { tid = '' } = {}) => {
  const ok = await js(`(() => {
    const list = Array.from(document.querySelectorAll(${tid ? `'[data-testid="${tid}"]'` : "'button'"}))
    const el = list.find(b => ${tid ? 'true' : `/${re}/.test((b.innerText||''))`} && b.getBoundingClientRect().width > 0)
    if (!el) return 'not-found'
    if (el.disabled) return 'disabled'
    el.click(); return 'clicked'
  })()`)
  console.log(`   → 点击 ${tid ? `[${tid}]` : `/${re}/`}：${ok}`)
  return ok
}
/** 点"下一步"：先点主按钮；若被阶段门禁挡下，界面会多出【强制推进（force）】，就再点它（人手也是这么干的）。 */
const advance = async (tid, target, waitStep) => {
  const r = await clickText('', { tid })
  await sleep(1500)
  const st1 = await st()
  if (st1.step < waitStep) {
    const fr = await clickText('', { tid: tid.replace('btn-advance-', 'btn-advance-force-') })
    console.log(`   （主按钮被挡下 → 点了强制推进：${fr}）`)
    await sleep(1500)
  }
  for (let i = 0; i < 30; i++) { const s = await st(); if (s.step >= waitStep) break; await sleep(500) }
  const st2 = await st()
  console.log(`   ${target}：步 ${st2.step} 阶段 ${st2.phase}`)
}
try {
  for (let i = 0; i < 40; i++) {
    try { const j = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
      ws = new WebSocket(j.webSocketDebuggerUrl); await new Promise((r, jj) => { ws.onopen = r; ws.onerror = jj }); break } catch { await sleep(300) }
  }
  await send('Target.createTarget', { url: 'about:blank' }); await sleep(400)
  const t = await send('Target.getTargets'); const page = t.targetInfos.find((x) => x.type === 'page')
  sessionId = (await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId
  await send('Runtime.enable'); await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })

  await cmd('boot.reset'); await cmd('mission.reset'); await cmd('sim.reset')
  await send('Page.navigate', { url: `${BASE}/` })
  await sleep(2500)
  await dump('① 打开页面（步 1 启动加载）')

  // 等自动进步 2
  for (let i = 0; i < 60; i++) { const s = await st(); if (s.step >= 2) break; await sleep(500) }
  await dump('② 步 2 自检校验（未自检）')
  await clickText('一键自检|重新自检')
  for (let i = 0; i < 40; i++) { const s = await st(); if ((s.selfCheck?.items ?? []).length) break; await sleep(500) }
  const s2 = await st()
  console.log('   自检项状态：', (s2.selfCheck?.items ?? []).map((i) => `${i.name}=${i.status}`).join(' '))
  const bs2 = await dump('② 步 2 自检校验（出结论后）')
  const enterBtn = bs2.find((b) => /进入任务/.test(b.t))
  console.log('   【进入任务 ≫】是否可点：', enterBtn ? (enterBtn.disabled ? '灰的（被拦）' : '可点') : '按钮不存在')
  if (enterBtn && !enterBtn.disabled) {
    await clickText('进入任务')
    for (let i = 0; i < 30; i++) { const s = await st(); if (s.step >= 3) break; await sleep(500) }
  } else {
    console.log('   !! 走不到步 3：这一屏的按钮被自检结论挡住了（手点流程会卡在这里）')
  }
  await dump('③ 步 3 任务态势')
  if ((await st()).step === 3) {
    await advance('btn-confirm-scene', '步 3 → 4', 4)
    await dump('④ 步 4 编组方案')
    await clickText('', { tid: 'btn-adopt-recommended' })
    await sleep(3000)
    await dump('⑤ 步 5 编组确认')
    await clickText('确认编组', { tid: 'btn-confirm-group' })
    await sleep(5000)
    await dump('⑤ 步 5 编组确认（下达后）')
    await advance('btn-advance-t2', '步 5 → 6', 6)
    await sleep(2500)
    await dump('⑥ 步 6 任务执行')
    // 步 6 上手动玩一下：暂停 / 恢复 / 倍速
    await clickText('', { tid: 'btn-sim-pause' }); await sleep(1200)
    const paused = (await st()).simulation
    console.log(`   点【暂停】后：running=${paused?.running} paused=${paused?.paused}`)
    await clickText('', { tid: 'btn-sim-resume' }); await sleep(1200)
    await clickText('', { tid: 'btn-speed-60' }); await sleep(1200)
    console.log('   点【60×】后：speed =', (await st()).simulation?.speed)
    await advance('btn-enter-recon', '步 6 → 7', 7)
    await sleep(2000)
    await dump('⑦ 步 7 实时侦察目标')
    // 目标卡 + 处置动作（取引擎给的动作里第一个可用的）
    await clickText('', { tid: 'target-card' })
    await sleep(1500)
    const actTid = await js(`(() => { const b = Array.from(document.querySelectorAll('[data-testid^="btn-act-"]')).find(x => !x.disabled && x.getBoundingClientRect().width > 0); return b ? b.getAttribute('data-testid') : '' })()`)
    console.log('   第一个可用处置动作按钮：', actTid || '（没有）')
    if (actTid) { await clickText('', { tid: actTid }); await sleep(2500) }
    await dump('⑦ 步 7（点过处置之后）')
    await advance('btn-advance-t5', '步 7 → 8', 8)
    await sleep(2000)
    await dump('⑧ 步 8 打击方案')
    await clickText('', { tid: 'strike-plan-card' })
    await sleep(800)
    await clickText('', { tid: 'btn-strike-adopt' })
    await sleep(2500)
    await dump('⑧ 步 8（采纳后）')
    await clickText('', { tid: 'btn-strike-next' })
    for (let i = 0; i < 40; i++) { const s = await st(); if (s.step >= 9) break; await sleep(500) }
    await sleep(2500)
    await dump('⑨ 步 9 打击确认')
    await clickText('', { tid: 'btn-strike-confirm' })
    await sleep(3000)
    await dump('⑨ 步 9（确认打击后）')
    await advance('btn-advance-t6', '步 9 → 10', 10)
    await sleep(2500)
    await dump('⑩ 步 10 协同执行')
    await clickText('', { tid: 'p6-target-card' })
    await sleep(1000)
    await clickText('', { tid: 'p6-btn-run' })
    await sleep(4000)
    await dump('⑩ 步 10（执行处置后）')
    await advance('btn-advance-t7', '步 10 → 11', 11)
    await sleep(2500)
    await dump('⑪ 步 11 任务总结')
    const final = await st()
    console.log(`\n### 手点收尾：步 ${final.step}/11（${final.stepKey}）· 阶段 ${final.phase}`)
  }
} catch (e) { console.error('ERR', e.message) } finally { try { ws?.close() } catch {}; chrome.kill() }
process.exit(0)
