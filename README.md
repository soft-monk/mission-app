# mission-app · 业务层与宿主层

> **把既有引擎装配成一台能按业务跑的机器**：场景一「敏捷拒止布控」从**启动自检**走到**任务总结**，
> 全部由**本地配置文件**驱动（非直连设备）。
>
> **现状：P0–P7 全部完成** —— Excel 11 步端到端可跑，七个阶段各有真机验收脚本，一轮跑完 **259 条断言全绿**。

本仓是**应用仓**，不含可复用模块；可复用能力都在独立模块仓里，本仓只做**装配 + 适配 + 业务编排**。

---

# 一、快速开始（从零到看见页面）

```powershell
# 0) 前置
#    · Windows + VS2022（C++ 工作负载）、CMake ≥ 3.20、Node ≥ 18
#    · 同级目录下要有各模块仓（见 §六），Drogon 从 vcpkg 取
cd D:\dsh_workpath\webMap\mission-app

# 1) 构建宿主（首次会 configure，约 1–3 分钟）
cmake -S . -B build -G "Visual Studio 17 2022" -A x64
cmake --build build --config Release --parallel

# 2) 构建前端（产物由宿主托管，落 apps/web/dist）
cd apps/web ; npm.cmd install ; npm.cmd run build ; cd ../..

# 3) 起服务（前台；Ctrl+C 退出）
.\build\bin\Release\mission_host.exe --speed 8 --port 8099

# 4) 浏览器打开
start http://127.0.0.1:8099/          # 打开就是「启动加载」屏
```

**起没起来看这三行**（顺序出现就成功了）：

```
[host] 规则包：9/9 装载成功
[host] engines ready: phase=1 resource=1 scoring=1 ledger=1 topology=1 alert=1 report=1 selfcheck=1 viewComposer=1 ingest=1 store=1 hub=1 tiles=1 simSource=1 sensorModel=1
[host] 已就绪：
    页面   http://127.0.0.1:8099/
```

---

# 二、启动 / 停止 / 状态：命令逐条

## 2.1 启动

| 场景 | 命令 | 说明 |
|---|---|---|
| **前台跑（推荐看日志）** | `.\build\bin\Release\mission_host.exe --speed 8 --port 8099` | Ctrl+C 退出；日志直接打在终端 |
| **后台跑（脚本化/演示）** | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\demo.ps1 serve` | 3 秒内返回；日志落 `scripts\.demo-host.out.log` |
| **后台跑 + 日志给宿主自己写** | `.\build\bin\Release\mission_host.exe --speed 8 --port 8099 --log D:\logs\host.log` | `--log` 把 stdout/stderr 重定向到文件（Windows 上做后台化最省事） |
| 只起服务不跑仿真 | `... --no-sim` | 只装配 + 起 HTTP/WS，不发遥测 |
| 跑够 N 秒自动退 | `... --stop-after 30` | 走**正常退出序列**（喂给 CI 用） |
| 不起网络只验装配 | `... --selftest` | 退出码 0/1 |
| 并行第二个实例 | `... --port 8100 --config scripts\.demo-config-8100.json` | **必须同时错开 UDP 接入端口**，见 §七.4 |

**倍速**：`--speed 1 | 8 | 60`（演示推荐 8×；60× 用于快速过流程）。运行中也能改：
`POST /api/command {"verb":"sim.speed","params":{"speed":60}}`。

## 2.2 停止

| 场景 | 做法 |
|---|---|
| **前台跑** | 在终端按 **Ctrl+C** —— 走正常退出序列（**先 flush 留存层，再按装配逆序停模块**） |
| **后台跑** | `POST http://127.0.0.1:8099/shutdown`（或 `scripts\demo.ps1 stop`）—— 同样走正常退出序列 |
| 卡住了要强停 | `Get-Process mission_host \| Stop-Process -Force`（**留存层不会 flush**，只在万不得已时用） |

**正常退出的日志长这样**（看到 `exit clean` 才算干净）：

```
[host] 退出中…
[host] flush telemetry-store：缓冲 0 条 → 已落盘 0 条
[host] telemetry-store flushed
[host] engines stopped (reverse order)
[host] hub stopped
[host] exit clean
```

## 2.3 看状态

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\demo.ps1 status
# [demo] 步 11/11（summary）· 阶段 'T7' · 任务 m-14
# [demo] 仿真：running=True paused=False speed=8x simElapsedMs=7248
# [demo] 自检：ok（5 项，10 ms）
# [demo] 实时连接数：1
```

等价的手工命令：

```powershell
(Invoke-WebRequest http://127.0.0.1:8099/api/state -UseBasicParsing).Content | ConvertFrom-Json | Select step,phase,missionId
(Invoke-WebRequest http://127.0.0.1:8099/stats    -UseBasicParsing).Content   # 各引擎就绪 + 实时读数
(Invoke-WebRequest http://127.0.0.1:8099/health   -UseBasicParsing).Content   # selfcheck 六字段聚合
```

---

# 三、演示全流程（Excel 11 步）

## 3.1 方式 A：一键跑完（三条命令）

```powershell
cd D:\dsh_workpath\webMap\mission-app

# ① 起宿主（后台，8 倍速；日志落 scripts\.demo-host.out.log）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\demo.ps1 serve

# ② 打开页面（可选，但演示时建议开着 —— 页面会跟着流程自己切屏）
start http://127.0.0.1:8099/

# ③ 一键把 11 步跑完（内部就是按顺序发真实命令，逐步回执）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\demo.ps1 runAll
```

**③ 的实测输出**（8× 倍速，14.4 秒跑完）：

```
[demo] sim.reset（把仿真源重建回起点，不重启进程）…
[demo]   code=0  simElapsedMs 47648 → 0  平台 10 台
[demo] mission.reset（清任务与阶段）…
[demo] flow.runAll（倍速 8x，11 步一次跑完）…
[demo]   ✓ 步  1  boot.run               code=0       207 ms
[demo]   ✓ 步  2  selfcheck.run          code=0         6 ms
[demo]   ✓ 步  3  flow.enter             code=0         1 ms
[demo]   ✓ 步  4  alloc.plans            code=0         3 ms
[demo]   ✓ 步  5  alloc.adopt            code=0         6 ms
[demo]   ✓ 步  6  mission.advance        code=0        21 ms
[demo]   ✓ 步  7  targets.list           code=0     14016 ms   ← 等"目标被探测发现"，真等
[demo]   ✓ 步  8  strike.plans           code=0         5 ms
[demo]   ✓ 步  9  strike.confirm         code=0         2 ms
[demo]   ✓ 步 10  exec.run               code=0        97 ms
[demo]   ✓ 步 11  report.generate        code=0        24 ms
[demo] 汇总：ok=True failedStep=(无) 总耗时 14394 ms 倍速 8x
[demo] 现在：步 11/11 · 阶段 'T7'
```

**要再演一遍**：再发一次 `runAll` 即可（它自己会先 `sim.reset` + `mission.reset`；`sim.reset` 把仿真源重建回起点，
**不用重启进程**）。

**结束演示**：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\demo.ps1 stop
```

> 想直接打 HTTP 也行（等价）：
> ```powershell
> $b = '{"verb":"flow.runAll","params":{"speed":8}}'
> (Invoke-WebRequest http://127.0.0.1:8099/api/command -Method POST -Body $b -ContentType application/json -UseBasicParsing).Content
> ```

## 3.2 方式 B：手点 11 步（推荐用于讲解）

页面打开后**不需要任何命令行**，按下面点即可；每一步都写清"点什么 → 应该看到什么 → 背后发的是哪条命令"。

| 步 | 屏 | 你点什么 | 应该看到 | 背后发的命令 |
|---|---|---|---|---|
| **1** | 启动加载 | （进入页面即自动开始；要重播就点【重新加载】） | 5 张模块卡进度真实推进（地图引擎/通信链路/AI引擎/集群管理/数据服务），总进度到 100% | `boot.run` |
| **2** | 自检校验 | 点【一键自检】→ 看完 5 项 → 点【进入任务 ≫】 | 5 项逐条出**真结论**（通信链路/定位系统/集群节点/后方指控/系统安全）；有一项红也不拦（可点【重新检测】） | `selfcheck.run` → `flow.enter` |
| **3** | 任务态势 | 看右栏"AI 任务分析 / 目标威胁等级 / 任务信息"，点【确认场景，进入编组 ≫】 | 地图上 6 个区域 + 4 个空域（禁飞/威胁/电子围栏/出航通道）+ 集群与目标 | `situation.snapshot`、`view.compose` |
| **4** | 编组方案 | 看三张方案卡，点【确认采用推荐方案】（也可先【查看方案详情】选别的） | 三套方案 + **推荐 93%**（引擎算的）+ 推荐理由 + 预期效果 6 项 + 库存"10/132" | `alloc.plans` → `alloc.adopt` |
| **5** | 编组确认 | 点【确认编组】 | 6/6 集群分配成功 + **10/10 台平台编成实体**（逐条回执） | `alloc.confirm` → `alloc.assign` |
| **6** | 任务执行 | 用【暂停】【恢复】和倍速按钮（1×/8×/60×）；看完链路与覆盖率后点【进入侦察阶段】 | 链路 15 条（颜色来自规则包）+ **覆盖率 1.0 / 遍历周期 2966.7 ms**（传感器模型算的） | `sim.*`、`topology.evaluate`、`sensor.status` |
| **7** | 实时侦察目标 | 点目标卡看详情；点目标列表里的**处置**按钮；右侧视频/SAR 面板 | 目标**随探测出现**（起飞前 0 → 之后 5）；详情有威胁等级/置信度/来源；视频面板能播（2 路） | `targets.list`、`targets.detail`、`targets.act` |
| **8** | 打击方案 | 看三张打击方案卡（协同方式/预计完成分钟/成功率），点【确认采用推荐方案】 | 三套：`同时/48 min/90`、`序贯/75 min/78`、`序贯/96 min/75`，推荐 90% | `strike.plans` → `strike.adopt` |
| **9** | 打击确认 | 看【定位到 IP 点】、时间轴四段（每段有算式），点【确认打击方案】 | 地图上 **IP 点 1 个 + 引导连线 10 条 + 评估航线 1 条**；时间轴 t0/到达/打击/评估（每段带 `basis`） | `guidance.plan` → `strike.confirm` |
| **10** | 协同执行 | 点目标的【执行处置】 | 目标状态 `briefStop → struck → destroyed`；地图上该目标**变灰**；回执里有命中判据 | `exec.run` |
| **11** | 任务总结 | 看报告卡与时间轴；点【导出任务报告】 | 报告 6 组 30 字段 + 时间轴 12 段 + 预警计数；**无数据的字段显示原因**（不显示 0） | `report.generate` |

> **讲解提示**：界面左上角一直有 `步 N/11 · 屏名 · 阶段`，底部有全局状态条（系统/无人机/数据链路/定位/AI/安全）。
> 任何"未提供"的字段都会写明原因与来源 —— 这是本工程的纪律（**MUST NOT 编数值**）。

---

# 四、命令参考

## 4.1 命令行参数

| 参数 | 作用 |
|---|---|
| `--config <路径>` | 配置文件；缺省依次尝试：仓库根 `config.json` → 环境变量 `MISSION_APP_CONFIG` → exe 附近 |
| `--port <端口>` | 覆盖 `server.port`（并行跑第二个实例时用） |
| `--scenario <目录>` | 覆盖本地配置目录（缺省 `<dataDir>/scenario-1`） |
| `--speed <1\|8\|60>` | 仿真倍速 |
| `--no-sim` | 只起服务与接入层，不跑仿真节拍 |
| `--log <文件>` | stdout/stderr 重定向到文件（后台跑用） |
| `--stop-after <秒>` | 跑够秒数自动走正常退出序列 |
| `--selftest` | 不起网络、不读配置，只验装配与就绪行 |
| `--determinism-check` | 离线双跑逐字节比对报文序列（假时钟） |
| `--help` | 用法 |

## 4.2 HTTP / WS 端点

| 端点 | 方法 | 用途 |
|---|---|---|
| `/` | GET | 前端首页（**`?stage=map` = 直接进地图台**，跳过启动/自检两屏） |
| `/health` | GET | selfcheck 聚合负载（`status/checkedAt/modules/selfCheck/systemOverview/wsClients`） |
| `/healthz` | GET | 不碰引擎的最小探活（排障：区分"服务没响应"与"某个处理器卡住"） |
| `/stats` | GET | 各引擎就绪 + 规则包装载情况 + 仿真/接入/广播读数 |
| `/runtime-config` | GET | 前端要的装配信息（瓦片模板等） |
| `/api/state` | GET | **流程状态**（步/阶段/任务/启动进度/自检/态势/编组/打击/报告） |
| `/api/command` | POST | **唯一的命令面**：`{"verb": "...", "params": {...}}` → `{code, verb, data|error}` |
| `/shutdown` | POST | 请求正常退出（后台跑时唯一能优雅停的路） |
| `/ws` | WS | 实时事件（信封 `{type, data, ts}`；客户端要按 ~1.2 s 发 `sys.ping` 保活） |
| `/tiles/{z}/{x}/{y}.jpg` | GET | 底图瓦片（z0–14，14204 块） |
| `/media/**` | GET | 视频/SAR 帧（支持 Range/206） |
| `/ws-close?peer=` | POST | 按 peer 片段强断某条 WS（验收用） |

`code` 码表（`protocol.md` §3）：`0` 成功 · `1000` 参数/未知 verb · `1002` 互斥冲突 · `1003` 前置不满足 ·
`1004` 未找到 · `1005` 内部不可用（模块/规则未装载）· `1006` 版本不匹配。
**幂等成功**一律 `code=0` + `data.idempotent=true`。

## 4.3 常用 verb（完整 46 条，按步分组）

| 步 | verb |
|---|---|
| 1–2 | `boot.run` `boot.reset` `selfcheck.run` `selfcheck.recheck` `selfcheck.report` `selfcheck.history` `selfcheck.purity` `capabilities.refresh` |
| 3 | `flow.enter` `flow.goto` `flow.state` `situation.snapshot` `view.compose` `view.mode` `mission.advance` |
| 4–5 | `alloc.inventory` `alloc.plans` `alloc.adopt` `alloc.confirm` `alloc.assign` |
| 6 | `sim.start` `sim.pause` `sim.resume` `sim.speed` `sim.step` `sim.state` `sim.reset` `topology.evaluate` `sensor.status` `sensor.configure` |
| 7 | `targets.list` `targets.detail` `targets.act` `media.channels` |
| 8–9 | `strike.plans` `strike.window` `strike.adopt` `strike.confirm` `guidance.plan` |
| 10–11 | `exec.run` `exec.abort` `report.generate` `mission.timeline` |
| 全流程 | `flow.runAll`（`{speed, from, to}`）`mission.reset` |

**常用例子**：

```powershell
function Cmd($v, $p = @{}) {
  $b = @{ verb = $v; params = $p } | ConvertTo-Json -Depth 6 -Compress
  (Invoke-WebRequest http://127.0.0.1:8099/api/command -Method POST -Body $b -ContentType application/json -UseBasicParsing).Content
}
Cmd 'sim.speed'   @{ speed = 60 }        # 变速
Cmd 'sim.pause'                          # 暂停（数据链路停推进）
Cmd 'sim.resume'                         # 恢复
Cmd 'targets.list'                       # 看当前被探测到的目标
Cmd 'guidance.plan' @{ planId = 'stk-s1-b' }   # 要 IP 点/引导连线/时间轴
Cmd 'report.generate'                    # 生成总结报告
Cmd 'sim.reset'                          # 仿真回起点（重跑一遍的前提）
Cmd 'flow.runAll' @{ speed = 8 }         # 11 步一键跑完
```

## 4.4 实时事件（WS）

`selfcheck.progress` `selfcheck.ready` `selfcheck.done` `flow.state` `mission.phase` `mission.progress`
`mission.status` `plan.state` `resource.allocation.changed` `resource.ledger.changed` `entity.changed`
`target.state` `entity.consistency` `topology.changed` `alert.raised|updated|acked` `report.ready`
`sim.state` `media.channels` `device.online|offline|stats`

---

# 五、验收：怎么证明它真的在跑

七个阶段各有**真机**验收脚本（真宿主 + 真前端 + Chrome CDP 1280×800，截图落 `docs/screens/`）。
**它们都要驱动同一个宿主，因此不要并发跑**；跑之前先 `demo.ps1 serve`。

```powershell
node scripts\live-check.mjs  http://127.0.0.1:5190/   # P1 地图链路（**须在宿主刚启动时**跑：仿真还在飞行段）11/11
node scripts\p2-check.mjs    http://127.0.0.1:8099/   # 步 1–2  启动加载 + 自检       22/22
node scripts\p3-check.mjs    http://127.0.0.1:8099/   # 步 3–5  态势 + 编组 + 确认    38/38
node scripts\p4-check.mjs    http://127.0.0.1:8099/   # 步 6–7  执行 + 探测 + 目标    51/51
node scripts\p5-check.mjs    http://127.0.0.1:8099/   # 步 8–9  打击方案 + 引导       47/47
node scripts\p6-check.mjs    http://127.0.0.1:8099/   # 步 10–11 执行 + 总结报告      57/57
node scripts\p7-check.mjs    http://127.0.0.1:8099/   # 一键串联 + 倍速 + 可重跑      33/33
node scripts\render-check-map.mjs                     # 前端自带受控 WS 服务端，只验渲染
pwsh -File scripts\acceptance.ps1                     # 结构守卫 + 构建 + 端点（含 BOM 校验）
```

> `acceptance.ps1` 会先按 **`-DMA_BUILD_SENSOR_MODEL=OFF`** 重新 configure —— 这是**负向验收**
> （证明"缺可选模块也装得起来、跑得起来"）。它在最后一步（**C5**）把默认配置（`sim-source` /
> `sensor-model` 装回）再构建回来，所以跑完验收不会把你的演示构建弄成"缺模块"版。
> 想跳过整个构建段：`acceptance.ps1 -SkipBuild -SkipFrontend`（复用已有产物，只跑结构守卫与端点）。

**写新脚本请照抄这几条纪律**（都踩过）：断言里**打印实测原值**而不是"应为"；
**拿不到的数据一律留空 + 点名原因**，MUST NOT 编数值、MUST NOT 显示成 0；
WS 采集器**先建连接再发 HTTP**（Node 的 WebSocket 与 fetch 共用 dispatcher）且**自己发 `sys.ping` 保活**；
截图前 `Emulation.setDeviceMetricsOverride(1280x800)`。

---

# 六、依赖的模块（各自独立仓，同级目录）

| 模块 | 用途 |
|---|---|
| `phase-engine` | 阶段推进与时间轴 |
| `resource-alloc` | 资源库存与编组 |
| `scoring` | 方案生成与推荐（编组 93%） |
| `entity-ledger` | 目标台账、威胁评级、动作状态机 |
| `topology` | 链路分析与质量 |
| `alert-engine` | 告警与预警计数 |
| `report-engine` | 任务总结报告 |
| `selfcheck` | 启动加载与自检（含规则侧探针包 `probes_mapapp`） |
| `view-composer` | 显示模式与图层映射 |
| `media-player` | 视频 / SAR / 图像流（**npm 包，不是 C++ 模块**） |
| `geo-data` | 底图瓦片 |
| `map-2d` | 二维地图渲染（Vite 别名**原地引用源码**） |
| `device-ingest` / `realtime-hub` / `telemetry-store` | 数据入口 / 实时推送 / 留存回放 |
| `sim-source` / `sensor-model` | 仿真与感知源 / 传感器探测模型 |

## 目录

```
mission-app/
├── CMakeLists.txt          # 装配：add_subdirectory 原地引用各模块（模块不在则条件关闭）
├── config.json             # 端口 / 数据目录 / 接入点 / 仿真 / 瓦片 / 媒体 / selfcheck 规则包路径
│                           #   + flow.steps：**11 步的显示名**（业务词汇表，改它不用重新编译）
├── data/scenario-1/        # ★ 本地配置（唯一数据源）：deployment / task-areas / targets /
│                           #   airspace / map-style / sensors / strike-geometry / media/
├── packages/
│   ├── host/               # 宿主：main / config / registry / engines / adapters /
│   │                       #   flow（流程与命令面）/ policies_loader / hub_engine / drogon_transport
│   ├── scenario-data/      # 本地配置 → 中立结构（含跨文件校验）
│   └── sim-bridge/         # sim-source 的装配桥（UDP 出口 + 节拍驱动 + 确定性双跑）
├── apps/web/               # 前端（React + Vite；11 步流程路由 + 各屏 + 地图台）
├── scripts/                # demo.ps1（演示）+ 验收脚本（P1–P7）+ 工具脚本
├── docs/参考/              # ★ 交接快照：设计/裁决/契约/缺陷登记/需求专篇（26 份 md）
├── docs/screens/           # 真机截图 + 截图索引
└── docs/P7-一键演示.md      # 一键演示手册（含失败定位表）
```

## 文档

| 文档 | 位置 | 为什么读 |
|---|---|---|
| **交接入口** | `docs/参考/README.md` | 26 份文档的阅读顺序 + 三处裁决日志在哪 |
| **交接文档** | `docs/参考/交接文档.md` | 环境准备、已知坑、P0–P7 现状、怎么自己验一遍 |
| **施工契约** | `docs/参考/流程接口冻结.md` | 事件名、命令面、屏幕清单、各阶段实测形状、已踩过的坑 |
| 实施方案（裁决表） | `docs/参考/业务层宿主层实施方案.md` | §10（A1–A15）/ §10.1（Q1–Q10） |
| 引擎接口地图 | `docs/参考/引擎集成接口地图.md` | 16 个模块的准确签名（带 `文件:行号`） |
| 共享契约（最高权威） | `../phase-engine/docs/契约/protocol.md` | 错误码、事件名、规则包 schema |
| 缺陷登记 / 变更请求单 | `docs/参考/引擎缺陷登记.md`、`*变更请求单.md` | 模块侧缺陷与待办 |

---

# 七、故障排查（按"症状 → 原因 → 处置"）

**1) 页面报"规则包装载失败（…）：code=1000 规则包文件读不到"**
→ 相对路径没解析（`config.json` 里的 `../selfcheck/...` 是相对**配置文件**的）。
已在 v0.9 修掉（`resolvePath`）；若你用的是旧二进制，重新构建即可。
排查：`--log D:\log.txt` 起一次，看首行 `[host] 配置：<路径>` 是不是你期望的那份。

**2) 控制台中文全是乱码**
→ Windows 控制台默认代码页 936(GBK)，而程序输出的是 UTF-8。宿主已在启动时切到 UTF-8（v0.9）；
若是旧二进制请重构。终端字体也需支持中文（Windows Terminal 默认可以）。

**3) 页面能开，但切屏慢半拍、`/stats` 里 `clientCount` 恒为 0**
→ 前端事件腿被判死踢掉（宿主 hub 的判死窗是 1.5 s × 3 ≈ **4.5 s**，客户端心跳必须更密）。
已在 `apps/web/src/flow/useFlow.ts` 用 `heartbeatMs: 1200` 对齐；**改判死窗时两个数要一起改**。

**4) 第二条实例起来了但收不到数据（`packets=0`、启动加载卡在 50%）**
→ 两条实例都绑了同一个 UDP 接入端口（默认 `45500`）。Windows 只把报文投给**先绑定**的那个 socket。
处置：第二条实例换端口（`config.json` 的 `ingest.points[0].port`，或 `demo.ps1 serve -Port 8100 -IngestPort 45501`）。

**5) `live-check` 报"航迹没画出来"**
→ 它要求**仿真还在飞行段**（约 60 秒，8× 倍速）。宿主起来很久了就先 `sim.reset` 或重启宿主再跑。

**6) 编排脚本在 Windows PowerShell 5.1 上卡住不返回**
→ 5.1 的 `Start-Process -RedirectStandardOutput` **会等到子进程退出**。用宿主自带的 `--log <文件>`，
或者直接用 `scripts\demo.ps1`（已按这个坑写好）。

**7) 自己写的 `.ps1` 一跑就报语法错误、中文乱码**
→ Windows PowerShell 5.1 **按 ANSI 读没有 BOM 的脚本**。带中文的 `.ps1` 必须存成 **UTF-8 with BOM**
（本仓的 `scripts\*.ps1` 都是这样，`acceptance.ps1` 里还有 BOM 硬校验）。

**8) 端口被占 / 上次没停干净**

```powershell
Get-NetTCPConnection -LocalPort 8099 -State Listen | Select OwningProcess
Get-Process mission_host | Stop-Process -Force     # 硬停（不 flush，万不得已）
```

---

# 八、两条硬约定与已知边界

## 硬约定

1. **模块源码一行不拷、一行不改**：`add_subdirectory(<模块目录> <build子目录>)` 原地引用；
   宿主只 include 各模块的**公开头**（`include/<mod>/*.h`），MUST NOT 碰模块内部文件。
   确需改模块 → 在**它自己的仓**里改，并附需求与验收。
2. **宿主里没有业务逻辑**：宿主只做「装配 / 依赖注入 / 生命周期 / 转发 / 编排」；
   业务取值全在规则包（各模块仓 `policies/mapapp/*.json`），界面文案与等级映射也来自规则包。
   连**11 步的显示名**也在 `config.json` 的 `flow.steps` 里 —— 宿主源码只留 `key`/`phase` 骨架。
   `acceptance.ps1` 的 **S1**（标识符层无业务词）+ **S1b**（业务词只许出现在诊断文案里）两条守卫看着这件事。

## 已知边界

| 事项 | 现状 | 原因 |
|---|---|---|
| AI 分析（`llm-provider`） | 未接；界面按"未提供 + 原因"显示 | 本期不需要；`llm-provider` 尚未实现 |
| `telemetry-store` 回放 | 报告里"留存层无数据"并写明原因 | 全工程暂无 `append()` 调用者（属后续波次） |
| 媒体素材 | image-seq 占位（20 帧真 JPEG） | 生成机无视频编码器，未造 mp4；video 分支与 URL 槽位已支持 |
| 场景二 | 只声明形状、无几何/坐标 | 裁决 Q5：不占位、缺就如实显示"未配置" |
| 自检"卫星链路" | 恒 `abnormal` | 探针包缺"未配置"分支（模块侧，已登记 `引擎缺陷登记.md`） |
| 仿真航路 | 每台只有"部署区 → 主任务区"一段，抵达后原地保持 | 场景数据边界（裁决 A11）；`sim.reset` 可回到起点重演 |

## 许可

Apache License 2.0，见 [LICENSE](LICENSE)。
