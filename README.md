# mission-app · 业务层与宿主层

> **把既有引擎装配成一台能按业务跑的机器**：场景一「敏捷拒止布控」从**启动自检**走到**任务总结**，
> 全部由**本地配置文件**驱动（非直连设备）。
>
> **现状：P0–P7 全部完成** —— Excel 11 步流程端到端可跑，七个阶段各有真机验收脚本，一轮跑完 **259 条断言全绿**。

本仓是**应用仓**，不含可复用模块。可复用能力都在独立模块仓里，本仓只做**装配 + 适配 + 业务编排**。

---

## 三十秒跑起来

```powershell
# 0) 前置：同级目录下要有各模块仓（见下"依赖的模块"），Drogon 从 vcpkg 取
cd D:\dsh_workpath\webMap\mission-app

# 1) 构建宿主（首次会 configure；需要 VS2022 + CMake≥3.20）
cmake -S . -B build -G "Visual Studio 17 2022" -A x64
cmake --build build --config Release --parallel

# 2) 构建前端（产物由宿主托管：apps/web/dist）
cd apps/web ; npm.cmd install ; npm.cmd run build ; cd ../..

# 3) 起服务（Ctrl+C 退出；退出序列**先 flush 留存层再停模块**）
.\build\bin\Release\mission_host.exe --speed 8 --port 8099
#    页面   http://127.0.0.1:8099/         ← 打开就是"启动加载"屏
#    健康   /health   统计 /stats   实时 ws://127.0.0.1:8099/ws
#    底图   /tiles/{z}/{x}/{y}.jpg        媒体 /media/**
#    排障后门：http://127.0.0.1:8099/?stage=map 直接进地图台（跳过启动/自检两屏）

# 4) 一键把 11 步跑完（28 条命令，逐步回执）
#    POST /api/command {"verb":"flow.runAll","params":{"speed":8}}
#    重跑前：POST /api/command {"verb":"sim.reset"}    ← 把仿真源重建回起点，**不重启进程**
```

**端口**：本应用用 **8099**（`config.json` 的 `server.port`）。同机并行跑第二个实例时，
**必须同时错开 UDP 接入端口**（`ingest.points[].port`，默认 45500）—— 都绑 45500 时 Windows 只把报文
投给先绑定的那个，后起的那条会收不到包。

### 一键演示手册

`docs/P7-一键演示.md`：起服务 / 一键跑 / 变速（1×/8×/60×）/ **失败定位表** / 逐步 verb 表。

---

## 验收：怎么证明它真的在跑

每一步都有**真机**验收脚本（真宿主 + 真前端 + Chrome CDP 1280×800，截图落在 `docs/screens/`）。
**它们都要驱动同一个宿主，因此不要并发跑。**

```powershell
node scripts\live-check.mjs  http://127.0.0.1:5190/   # P1 地图链路（**须在宿主刚启动时**跑：仿真还在飞行段）
node scripts\p2-check.mjs    http://127.0.0.1:8099/   # 步 1–2  启动加载 + 自检       22/22
node scripts\p3-check.mjs    http://127.0.0.1:8099/   # 步 3–5  态势 + 编组 + 确认    38/38
node scripts\p4-check.mjs    http://127.0.0.1:8099/   # 步 6–7  执行 + 探测 + 目标    51/51
node scripts\p5-check.mjs    http://127.0.0.1:8099/   # 步 8–9  打击方案 + 引导       47/47
node scripts\p6-check.mjs    http://127.0.0.1:8099/   # 步 10–11 执行 + 总结报告      57/57
node scripts\p7-check.mjs    http://127.0.0.1:8099/   # 一键串联 + 倍速 + 可重跑      33/33
node scripts\render-check-map.mjs                     # 前端自带受控 WS 服务端，只验渲染
pwsh -File scripts\acceptance.ps1                     # 结构守卫 + 构建 + 端点（UTF-8 BOM 写在文件字节里）
```

**这些脚本的纪律**（新写脚本请照抄）：断言里**打印实测原值**而不是"应为"；
**拿不到的数据一律留空 + 点名原因**，MUST NOT 编数值、MUST NOT 显示成 0；
WS 采集器**先建连接再发 HTTP**（Node 的 WebSocket 与 fetch 共用 dispatcher）且**自己发 `sys.ping` 保活**。

---

## 它解决什么问题

引擎（10 个业务引擎 + 4 个既有模块 + 2 个新模块）都已独立实现并验收通过，
但**没有任何东西把它们按业务串起来**。本仓就是那个"串起来"的地方：装配、生命周期、REST/WS、
反向接口实现、Excel 11 步界面。

## 做 / 不做

| 做 | 不做 |
|---|---|
| 装配引擎（`add_subdirectory` 原地引用，**不复制源码**） | 🚫 不实现可复用模块（那些在各自仓里） |
| 适配层：引擎 → 本项目（业务改造集中在这里） | 🚫 不在本仓绕过模块缺陷（`DISC-01`） |
| 本地配置装载与校验（4 类数据 + 地图样式 + 传感器规格） | 🚫 不在宿主里造业务取值（那属规则包） |
| 宿主：生命周期、REST/WS、反向接口实现、流程编排（`flow.cc`） | 🚫 不做引擎内部的事（阶段规则、评分算法…） |
| 11 步界面（场景一） | 🚫 不做场景二/三（场景二只声明形状，缺数据就如实显示"未配置"） |

## 依赖的模块（各自独立仓，同级目录）

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
├── data/scenario-1/        # ★ 本地配置（唯一数据源）：deployment / task-areas / targets /
│                           #   airspace / map-style / sensors / strike-geometry / media/
├── packages/
│   ├── host/               # 宿主：main / config / registry / engines / adapters /
│   │                       #   flow（流程与命令面）/ policies_loader / hub_engine / drogon_transport
│   ├── scenario-data/      # 本地配置 → 中立结构（含跨文件校验）
│   └── sim-bridge/         # sim-source 的装配桥（UDP 出口 + 节拍驱动 + 确定性双跑）
├── apps/web/               # 前端（React + Vite；11 步流程路由 + 各屏 + 地图台）
├── scripts/                # 验收脚本（P1–P7）+ 工具脚本
├── docs/参考/              # ★ 交接快照：设计/裁决/契约/缺陷登记/需求专篇（26 份 md）
├── docs/screens/           # 真机截图 + 截图索引
└── docs/P7-一键演示.md      # 一键演示手册
```

## 文档

| 文档 | 位置 | 为什么读 |
|---|---|---|
| **交接入口** | `docs/参考/README.md` | 26 份工作文档快照的阅读顺序 + 三处裁决日志在哪 |
| **交接文档** | `docs/参考/交接文档.md` | 环境准备、已知坑、P0–P7 现状、怎么自己验一遍 |
| **施工契约** | `docs/参考/流程接口冻结.md` | 事件名、命令面、屏幕清单、各阶段实测形状与命令序、已踩过的坑 |
| 实施方案（裁决表） | `docs/参考/业务层宿主层实施方案.md` | §10（A1–A15）/ §10.1（Q1–Q10） |
| 引擎接口地图 | `docs/参考/引擎集成接口地图.md` | 16 个模块的准确签名（带 `文件:行号`） |
| 共享契约（最高权威） | `../phase-engine/docs/契约/protocol.md` | 错误码、事件名、规则包 schema |
| 缺陷登记 / 变更请求单 | `docs/参考/引擎缺陷登记.md`、`*变更请求单.md` | 模块侧缺陷与待办 |

## 两条硬约定

1. **模块源码一行不拷、一行不改**：`add_subdirectory(<模块目录> <build子目录>)` 原地引用；
   宿主只 include 各模块的**公开头**（`include/<mod>/*.h`），MUST NOT 碰模块内部文件。
   确需改模块 → 在**它自己的仓**里改，并附需求与验收。
2. **宿主里没有业务逻辑**：宿主只做「装配 / 依赖注入 / 生命周期 / 转发 / 编排」；
   业务取值全在规则包（各模块仓 `policies/mapapp/*.json`），界面文案与等级映射也来自规则包。

## 已知边界

| 事项 | 现状 | 原因 |
|---|---|---|
| AI 分析（`llm-provider`） | 未接；界面按"未提供 + 原因"显示 | 本期不需要；`llm-provider` 尚未实现 |
| `telemetry-store` 回放 | 报告里"留存层无数据"并写明原因 | 全工程暂无 `append()` 调用者（属后续波次） |
| 媒体素材 | image-seq 占位（20 帧真 JPEG） | 生成机无视频编码器，未造 mp4；video 分支与 URL 槽位已支持 |
| 场景二 | 只声明形状、无几何/坐标 | 裁决 Q5：不占位、缺就如实显示"未配置" |
| 自检"卫星链路" | 恒 `abnormal` | 探针包缺"未配置"分支（模块侧，已登记 `引擎缺陷登记.md`） |
| 并行验收 | 第二条实例须错开 UDP `ingest` 端口；验收脚本不要并发 | Windows 只把 UDP 报文投给先绑定的 socket |

## 许可

Apache License 2.0，见 [LICENSE](LICENSE)。
