# mission-app · 业务层与宿主层

> **把既有引擎装配成一台能按业务跑的机器**：场景一「敏捷拒止布控」从**启动自检**走到**任务总结**，全部由**本地配置文件**驱动（非直连设备）。

本仓是**应用仓**，不含可复用模块。可复用能力都在独立模块仓里，本仓只做**装配 + 适配 + 业务**。

---

## 它解决什么问题

引擎（10 个业务引擎 + 4 个既有模块）都已独立实现并验收通过，但**没有任何东西把它们按业务串起来**。
本仓就是那个"串起来"的地方：装配、生命周期、REST/WS、反向接口实现、11 步界面。

## 做 / 不做

| 做 | 不做 |
|---|---|
| 装配引擎（\`add_subdirectory\` 原地引用，**不复制源码**） | 🚫 不实现可复用模块（那些在各自仓里） |
| 适配层：引擎 → 本项目（业务改造集中在这里） | 🚫 不在本仓绕过模块缺陷（\`DISC-01\`） |
| 本地配置装载与校验（4 类数据 + 地图样式） | 🚫 不查业务表产出仿真数据（那是模块的活） |
| 宿主：生命周期、REST/WS、反向接口实现 | 🚫 不做引擎内部的事（阶段规则、评分算法…） |
| 11 步界面（场景一） | 🚫 不做场景二/三 |

## 依赖的模块（各自独立仓）

| 模块 | 用途 |
|---|---|
| \`phase-engine\` | 阶段推进与时间轴 |
| \`resource-alloc\` | 资源库存与编组 |
| \`scoring\` | 方案生成与推荐（93%） |
| \`entity-ledger\` | 目标台账、威胁评级、动作状态机 |
| \`topology\` | 链路分析与质量 |
| \`alert-engine\` | 告警与预警计数 |
| \`report-engine\` | 任务总结报告 |
| \`selfcheck\` | 启动加载与自检 |
| \`media-player\` | 视频 / SAR / 图像流 |
| \`geo-data\` | 底图瓦片 |
| \`map-2d\` | 二维地图渲染 |
| \`device-ingest\` / \`realtime-hub\` / \`telemetry-store\` | 数据入口 / 实时推送 / 留存回放 |
| **\`sim-source\`** / **\`sensor-model\`** | 仿真与感知源 / 传感器探测模型 |

## 文档

| 文档 | 位置 |
|---|---|
| **实施方案**（含 11 步映射、配置 schema、分期） | 上游 \`参考文档/业务层宿主层实施方案.md\` |
| 共享契约（冻结，最高权威） | \`phase-engine/docs/契约/protocol.md\` |
| 各模块需求专篇 | 各模块仓 \`docs/需求/\` |

---

## P0 · 装配骨架（当前阶段）

**P0 的目标只有一句**：证明既有模块能被装到一起、能编译、能链接、能实例化，并让浏览器打开一个出图的页面。
**不含任何业务功能** —— 阶段规则、评分算法、告警规则一律不在本仓。

### 目录

```
mission-app/
├── CMakeLists.txt          # 装配：add_subdirectory 原地引用 12 个模块（+ 2 个条件包含）
├── config.json             # 监听端口 / vcpkg 路径 / 模块开关 / 瓦片模板 / 数据目录
├── packages/host/          # 宿主最小内核（C++）：装配 + 生命周期 + HTTP
│   ├── include/ma/         #   config / registry / engines / adapters / host_server
│   └── src/
├── apps/web/               # Vite + React + TS 最小页面（map-2d 经别名原地引用）
└── scripts/                # acceptance.ps1（验收）+ render-check.mjs（可选：无头 Chrome 真机自证）
```

### 构建与运行

```powershell
# 1) C++ 宿主（首次数分钟：12 个模块一起编）
cmake -S . -B build -G "Visual Studio 17 2022" -A x64 `
      -DCMAKE_CONFIGURATION_TYPES=Release `
      -DMA_VCPKG_DIR="D:/dsh_workpath/mapApp/backend/build/vcpkg_installed/x64-windows"
cmake --build build --config Release --parallel

# 2) 前端
cd apps/web ; npm.cmd install ; npm.cmd run build ; cd ../..

# 3) 起服务（先 flush 再停模块；Ctrl+C 退出）
.\build\bin\Release\mission_host.exe
#    页面 http://127.0.0.1:8090/   健康 /health   统计 /stats   瓦片 /tiles/{z}/{x}/{y}.jpg

# 4) 不需要网络的自证（供 CI / 脚本用）
.\build\bin\Release\mission_host.exe --selftest
.\build\bin\Release\mission_host.exe --stop-after 2      # 跑 2 秒后走正常退出序列
```

### 验收

```powershell
pwsh -File scripts/acceptance.ps1
#   退出码 0 = 全绿。含：configure/build 0 error、main.exe 退出码 0 且 stdout 含
#   "[host] engines ready:"、npm run build、结构守卫（无业务词 / 无内部 include / 无 SQL）、
#   /health == 200、/ 与 /assets/ 可取。
#   -SkipBuild / -SkipFrontend 复用已有产物；-IncludeInProgress 一并验 sim-source / sensor-model。
```

> 若 PowerShell 的 ExecutionPolicy 拦脚本，用：
> `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/acceptance.ps1`

**可选的真机自证**（起服务后另开一个终端；需要本机有 Chrome）：

```powershell
node scripts/render-check.mjs http://127.0.0.1:8090/
#   无头 Chrome 打开页面，确认地图容器与 canvas 真的挂上了（"取得到 HTML" ≠ "渲染出来了"）
```

### P0 的两条硬约定

1. **模块源码一行不拷、一行不改**：`add_subdirectory(<模块目录> <build子目录>)` 原地引用；
   宿主只 include 各模块的**公开头**（`include/<mod>/*.h`），MUST NOT 碰模块内部文件。
2. **宿主里没有业务逻辑**：宿主只做「装配 / 依赖注入 / 生命周期 / 转发」四件事。
   `/health` 是静态占位（真正的 selfcheck 聚合在 P2），`/stats` 只回答"哪个引擎起来了"，
   瓦片请求原样交给 `geo-data` 的路由处理器。

### 已知边界（P0 有意为之）

| 事项 | 现状 | 原因 |
|---|---|---|
| `device-ingest` | 已**链接**、未实例化 | 需要接入点配置与真实 endpoints，属后续阶段 |
| `realtime-hub` | 已链接 + 单例构造（`version()` / `clientCount()` 可读） | 广播腿需要宿主实现 `ITransport`（Drogon WS 适配器），属 P1 |
| `sim-source` / `sensor-model` | `if(EXISTS ...)` 条件包含；`-DMA_BUILD_*=OFF` 可单独掐掉 | 由另一个 agent 在写；落地即自动接上，本仓不需改代码 |
| `geo-data` 瓦片 | 路由已挂、服务已建，但**未托管瓦片包** → 404 | 瓦片包路径由 `config.json` 的 `tiles.root` 指定；空 → 地图回落纯色兜底 |
| `selfcheck` 规则包 | 未装载（`config.json` 的 `selfcheck.policies` 为空） | 真聚合是 P2 的事 |

## 状态

P0（装配骨架）已完成：12 个既有模块装到一起、能编译、能链接、能实例化，页面能打开。

## 许可

Apache License 2.0，见 [LICENSE](LICENSE)。
