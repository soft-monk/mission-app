#!/usr/bin/env node
// mission-app · scripts/ws-client.mjs
//
// 一个**零依赖**的 WS 客户端（Node 22+ 自带全局 WebSocket），只做验收要的四件事：
//   1) 连上 /ws，把收到的每条信封按 type 计数，并逐字段盯住目标事件；
//   2) 主动发一条入站帧（走 handleInbound：touch 看门狗 + hub 的 sys.error 回执）；
//   3) 报告"我收到了什么"——给 acceptance 脚本当**实测证据**用；
//   4) 按 --close-after 自己断开（让脚本验证 clientCount 减、closed 增）。
//
// 输出：一行 JSON 到 stdout（脚本直接 ConvertFrom-Json）。退出码 0/1。
//
// 用法：
//   node scripts/ws-client.mjs --url ws://127.0.0.1:8099/ws --expect telemetry.uav.pos \
//        --count 3 --timeout 20000 [--close-after 0] [--send-probe] [--tag A]
import process from 'node:process';

function parseArgs(argv) {
  const out = {
    url: 'ws://127.0.0.1:8099/ws',
    expect: 'telemetry.uav.pos',
    count: 3,
    timeout: 20000,
    closeAfterMs: 0,
    quietMs: 0,
    sendProbe: false,
    tag: '',
    fields: ['uavId', 'type', 'groupId', 'lng', 'lat'],
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--url') { out.url = v; i += 1; }
    else if (a === '--expect') { out.expect = v; i += 1; }
    else if (a === '--count') { out.count = Number(v); i += 1; }
    else if (a === '--timeout') { out.timeout = Number(v); i += 1; }
    else if (a === '--close-after') { out.closeAfterMs = Number(v); i += 1; }
    else if (a === '--quiet-ms') { out.quietMs = Number(v); i += 1; }
    else if (a === '--tag') { out.tag = v; i += 1; }
    else if (a === '--send-probe') { out.sendProbe = true; }
    else if (a === '--fields') { out.fields = String(v).split(',').filter(Boolean); i += 1; }
    else if (a === '--help' || a === '-h') {
      process.stdout.write('见文件头注释\n');
      process.exit(0);
    }
  }
  return out;
}

const args = parseArgs(process.argv);
const result = {
  tag: args.tag,
  url: args.url,
  open: false,
  expect: args.expect,
  expectCount: 0,
  total: 0,
  types: {},
  samples: [],
  firstSampleRaw: '',
  missingFields: [],
  devices: {},
  probeSent: false,
  probeReplyTypes: [],
  closedByUs: false,
  closeCode: null,
  error: '',
  startedAt: Date.now(),
  elapsedMs: 0,
};

function finish(code) {
  result.elapsedMs = Date.now() - result.startedAt;
  try {
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch {
    /* ignore */
  }
  process.exit(code);
}

let ws;
try {
  ws = new WebSocket(args.url);
} catch (e) {
  result.error = `new WebSocket 失败：${e && e.message ? e.message : e}`;
  finish(1);
}

const timer = setTimeout(() => {
  result.error = result.open
    ? `超时：${args.timeout} ms 内只收到 ${result.expectCount} 条 ${args.expect}`
    : `连接超时：${args.timeout} ms 内没握手成功`;
  try { ws.close(); } catch { /* ignore */ }
  finish(result.expectCount >= args.count ? 0 : 1);
}, args.timeout);

// 静默模式：收到够了**也不主动断开**，坐着等——用来让服务端的心跳判死把它踢掉。
const quietTimer = args.quietMs > 0
  ? setTimeout(() => {
    result.closedByUs = true;
    try { ws.close(1000, 'quiet-done'); } catch { /* ignore */ }
  }, args.quietMs)
  : null;

const closeTimer = args.closeAfterMs > 0
  ? setTimeout(() => {
    result.closedByUs = true;
    try { ws.close(1000, 'client-done'); } catch { /* ignore */ }
  }, args.closeAfterMs)
  : null;

ws.addEventListener('open', () => {
  result.open = true;
  if (args.sendProbe) {
    result.probeSent = true;
    // 一条**业务上行**：hub 是哑的 → 回 sys.error{unsupported}，但连接绝不断（协议 §9.2）
    try { ws.send(JSON.stringify({ type: 'hello.from.client', data: {}, ts: Date.now() })); }
    catch (e) { result.error = `send 失败：${e && e.message ? e.message : e}`; }
  }
});

ws.addEventListener('message', (ev) => {
  const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
  result.total += 1;
  let env;
  try {
    env = JSON.parse(raw);
  } catch {
    result.types['(non-json)'] = (result.types['(non-json)'] || 0) + 1;
    return;
  }
  const type = typeof env.type === 'string' ? env.type : '(no-type)';
  result.types[type] = (result.types[type] || 0) + 1;

  if (args.probeSent && type.startsWith('sys.')) result.probeReplyTypes.push(type);

  if (type !== args.expect) return;
  result.expectCount += 1;
  {
    // 每台设备只留一条样本摘要：验收要能一眼看出"真的有多台设备在报"
    const d = env.data && typeof env.data === 'object' ? env.data : {};
    const key = String(d.uavId || d.deviceId || '?');
    if (!result.devices[key]) {
      result.devices[key] = {
        type: d.type,
        groupId: d.groupId,
        kind: d.kind,
        lng: d.lng,
        lat: d.lat,
        alt: d.alt,
        seq: d.seq,
      };
    }
  }
  if (result.samples.length === 0) {
    result.firstSampleRaw = raw;               // 原文：验收要拿它做**逐字段**断言
    const data = env.data && typeof env.data === 'object' ? env.data : {};
    const missing = args.fields.filter((f) => !(f in data));
    result.missingFields = missing;
    result.samples.push({
      ts: env.ts,
      data,
    });
  }
  if (result.expectCount >= args.count && args.closeAfterMs === 0 && args.quietMs === 0) {
    clearTimeout(timer);
    try { ws.close(1000, 'done'); } catch { /* ignore */ }
  }
});

ws.addEventListener('error', (ev) => {
  result.error = `WS 错误：${(ev && ev.message) || '(无 message)'}`;
});

ws.addEventListener('close', (ev) => {
  if (closeTimer) clearTimeout(closeTimer);
  if (quietTimer) clearTimeout(quietTimer);
  clearTimeout(timer);
  result.closeCode = ev && typeof ev.code === 'number' ? ev.code : null;
  const ok = result.open && result.expectCount >= args.count;
  if (!ok && !result.error) {
    result.error = `只收到 ${result.expectCount} 条 ${args.expect}（需要 ${args.count}）` +
      `；全部类型：${JSON.stringify(result.types)}`;
  }
  finish(ok ? 0 : 1);
});
