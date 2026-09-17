# mission-app · 智能任务管理系统（场景一：敏捷拒止布控）

> **这份文档是给"坐在电脑前点界面的人"写的**：起一条命令，剩下的全在浏览器里点。
> 11 屏每一步都写清了 **屏上有什么 → 你点哪里 → 点完看到什么 → 想反悔怎么办**。
>
> 现状：P0–P7 全部完成，七个阶段各有真机验收脚本，一轮跑完 **261 条断言全绿**（见 §六）。
> 手点全流程已在真机跑通（本文的按钮文字与可见结果都是**实测**，不是设计稿）。

---

# 一、先跑起来（手点模式 = 一条命令 + 一个页面）

## 1.1 起服务（二选一）

**A. 后台跑（第一次用推荐）**——在 `mission-app` 目录下：

```powershell
cd D:\dsh_workpath\webMap\mission-app
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\demo.ps1 serve
```

它会打印三行，看到就成功了：

```
[demo] 已就绪：http://127.0.0.1:8099/   （排障后门 http://127.0.0.1:8099/?stage=map）
[demo] 引擎就绪：selfCheckReady=True  step=1  phase=''
[demo] 日志：D:\dsh_workpath\webMap\mission-app\scripts\.demo-host.out.log
```

（`serve` 默认会先构建；已经有产物时加 `-NoBuild` 起得更快：`... demo.ps1 serve -NoBuild`）

**B. 前台跑（想看滚动的日志）**：

```powershell
.\build\bin\Release\mission_host.exe --speed 8 --port 8099
# 退出：Ctrl+C（走正常退出序列）；日志直接打在终端里
```

**只有第一次需要先构建**（0 error 才算过）—— 一次性把 C++ 与前端产物都建出来：

```powershell
# ① C++ 宿主（需要 VS 2022 + vcpkg 依赖树；路径按你机器上的实际位置改）
cmake -S . -B build -G "Visual Studio 17 2022" -A x64 `
      -DMA_VCPKG_DIR=D:/dsh_workpath/mapApp/backend/build/vcpkg_installed/x64-windows
cmake --build build --config Release --parallel

# ② 前端产物（宿主直接托管 apps/web/dist；**dist 不入库**，所以新机器必须先建一次）
cd apps\web
npm install          # 只需一次（Node ≥ 18）
npm run build        # = tsc --noEmit && vite build（先类型检查，再打包）
cd ..\..
```

> 忘了 ② 会怎样：`http://127.0.0.1:8099/` 打得开服务但页面是空的（`/` 找不到 `dist/index.html`）。
> `scripts\acceptance.ps1` 里的 **F2/F3** 就是盯这件事的（它会自己跑 `npm run build`）。

## 1.2 打开页面

```
http://127.0.0.1:8099/
```

**怎么算起来了**（三个都该成立）：

| 看哪里 | 应该看到 |
|---|---|
| 左上角流程徽标 | `步 1/11 · 启动加载界面`（启动完成后自动变 `步 2/11 · 自检校验界面`） |
| 中间的"模块加载进度" | 五张卡（地图引擎 / 通信链路 / AI 引擎 / 集群管理 / 数据服务）百分比**真的在爬**——每个数都来自真实探针 |
| 右上角 | `网络：已连接`（实时通道通了；没连上就只有 500 ms 轮询，切屏会慢半拍） |

## 1.3 关于"自由点"的三件事

1. **页面永远显示宿主当前那一屏**（`GET /api/state` 每 500 ms 一轮 + WS 事件）。
   所以**刷新页面不会丢进度**——进度在宿主进程里，不在浏览器里（实测：跳到步 7 后刷新，仍是 `步 7/11 · 实时侦察目标显示 · 阶段 T4`）。
2. **每一步都要你确认才往前走**。除了"启动加载完成 → 自动进自检"，其余各屏之间的推进都由你点按钮。
3. **灰按钮 = 前置没满足**，不是坏了。本手册逐屏写了"什么时候是灰的"，以及怎么把它点亮。

## 1.4 停止

| 场景 | 命令 | 说明 |
|---|---|---|
| 后台跑 | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\demo.ps1 stop` | 发 `POST /shutdown`，走**正常退出序列** |
| 前台跑 | 在那个终端按 **Ctrl+C** | 同上：先 flush 留存层，再按装配逆序停模块 |
| 看状态（后台跑时） | `... scripts\demo.ps1 status` | 步/阶段/任务/仿真读数 |

**正常退出的日志长这样**（看到 `exit clean` 才算干净）：

```
[host] 退出中…
[host] flush telemetry-store：缓冲 0 条 → 已落盘 0 条
[host] engines stopped (reverse order)
[host] hub stopped
[host] exit clean
```

> 卡住了要强停：`Get-Process mission_host | Stop-Process -Force`（**留存层不会 flush**，万不得已才用）。

---

# 二、手点 11 屏：逐屏手册

每屏五段：**屏上有什么 → 你点哪里 → 点完看到什么 → 想反悔 / 重来 → 背后的命令**。
（最后一段是给要写脚本的人看的；手点的人可以跳过。）

> **界面上的字从哪来**：面板里的模块名、自检项名、区域名、目标名、方案名、集群名、指标名……**全部来自引擎与规则包**
> （宿主的 `/api/state` 与各 verb 回执）。界面左上角的屏名（如"任务态势界面"）来自 `config.json` 的 `flow.steps`。
> 换句话说：**界面上任何一个字都不是前端编的**，改词去改规则包 / `config.json`。

## 步 1 · 启动加载界面（自动）

- **屏上有什么**：中间是系统名与总进度条；下面"模块加载进度"五张卡；右栏"系统状态"；底部提示条。
- **你点哪里**：**不用点**。进页面就自动开始（发 `boot.run`），五张卡按真实条件推进（10% = 体检开始 / 50% = 完成一次体检 / 100% = 规则包判就绪）。
  进度未满时屏上有一颗【重新加载】按钮，想重播就点它（幂等，不会把已就绪的模块弄回未就绪）。
- **点完看到什么**：总进度到 100% 后提示条变成"初始化完成，正在进入系统状态自检…"，**宿主自动把流程推到步 2**。
- **想反悔 / 重来**：这一屏没有"回退"；要回到这里用 `scripts\manual.ps1 reset`（见 §三）。
- **背后的命令**：`boot.run`（幂等）；想订阅真实进度：WS 的 `selfcheck.progress`。

## 步 2 · 自检校验界面

- **屏上有什么**：左栏"系统状态自检"+ 主按钮；中栏"自检结果"五张卡（通信链路 / 定位系统 / 集群节点 / 后方指控 / 系统安全）；右栏"系统状态概览"。
- **你点哪里**：

| 按钮（逐字） | 点完会发生什么 | 什么时候是灰的 |
|---|---|---|
| **一键自检** | 跑一轮真实体检（5 项逐条出结论） | 自检进行中（文字变"自检中…"） |
| **重新自检**（同一按钮，出结论后的文字） | 再跑一轮（`selfcheck.recheck`） | 同上 |
| **详情** / **收起** | 就地展开该卡的"子项 / 原因 / 建议 / 指标" | 该项没有可展开内容时不显示 |
| **重新检测**（结果区右下） | 与【重新自检】同一件事 | 同上 |
| **进入任务 ≫** / **仍要进入任务 ≫** | 建任务并切到步 3（阶段 T0） | 自检**还没出结论**时不显示（`done` 之后才出现） |

> **⚠ 一项红也不拦**：本环境下"通信链路检测"常常是 `abnormal`（没有实装数传/卫星链路，这是**真实结论**，不是 bug）。
> 这时按钮文字会变成 **【仍要进入任务 ≫】**，**可以点**；异常项与原因照旧留在屏上，也会进总结报告。
> 实测：自检出结论后点它 → `步 3/11 · 任务态势界面 · 阶段 T0`。

- **点完看到什么**：地图台挂上（底图 + 我方部署区 + 任务区 + 空域 + 集群点位），右栏出现态势快照。
- **想反悔 / 重来**：本屏可反复【重新检测】；要回到步 1 用 `scripts\manual.ps1 reset`。
- **背后的命令**：`selfcheck.run` →（`selfcheck.recheck`）→ `flow.enter`（建任务 + 进 T0）。

## 步 3 · 任务态势界面

- **屏上有什么**：顶部压条（显示模式 / 阶段 / 任务态势 / 区域 / 目标）；左上"地图图层与工具"；右栏"AI 任务分析 / 任务信息 / 资源概况 / 命令回执"；
  底部"请确认任务场景"区域卡条 + 右端"场景确认"块。地图上：6 个区域 + 4 个空域（禁飞 / 威胁 / 电子围栏 / 出航通道）+ 集群与目标。
- **你点哪里**：

| 按钮（逐字） | 点完会发生什么 | 什么时候是灰的 |
|---|---|---|
| **确认场景，进入编组 ≫** | 阶段 T0 → **T1**，切到步 4 | 从不灰（永远可点） |
| **刷新态势快照** | 重发 `situation.snapshot` | 正在取快照时 |
| **复位视角** | 镜头回到默认中心/缩放 | 地图就绪后才存在 |
| **重试**（"命令回执"里每条一个） | 重发那一条 verb | 该 verb 正在跑时 |

- **点完看到什么**：`步 4/11 · 无人机分组与任务编组 · 阶段 T1`；按钮下方出现绿字 `mission.advance → code=0 · 步 4 · 阶段 T1`。
- **想反悔 / 重来**：本屏没有"回步 2"的按钮；想回去看用 `scripts\manual.ps1 goto 2`（只切屏，不改变引擎状态），或整体复位重来。
- **背后的命令**：`situation.snapshot`、`view.compose`、`mission.advance {to:"T1"}`。

## 步 4 · 无人机分组与任务编组

- **屏上有什么**：左栏"无人机类型列表"（4 型：总数/可用/已分配/待分配 + 能力标签）；中栏"集群编组方案生成区"**三张方案卡**；
  右栏"AI 推荐编组方案"（推荐评分 **93%**、领先次优 13%、推荐理由 4 条）+ "预期效果"（6 项指标）。
- **你点哪里**：

| 控件（逐字） | 点完会发生什么 | 什么时候是灰的 |
|---|---|---|
| **方案卡**（如"方案二｜多域协同压制方案"，带 `AI 推荐` 角标） | 选中该卡（边框高亮），右侧"预期效果"换成这套方案 | 从不灰（点卡不发命令，只改选中） |
| **确认采用推荐方案** | 带着当前选中的方案切到步 5 | 从不灰 |
| **查看方案详情** | 同上（进步 5 看集群明细） | 从不灰 |
| **自动优化** | **什么都不发生** | **永久灰**（`title`：宿主尚未提供该 verb —— 不假装有这功能） |
| **重试** | 重发对应的 `alloc.inventory` / `alloc.plans` / `view.compose` | 对应 verb 正在跑时 |

- **点完看到什么**：`步 5/11 · 编组确认界面`，中间多出一排方案 tab（推荐那张带 ★ 与评分）。
- **想反悔 / 重来**：屏幕内没有"回步 3"；用 `scripts\manual.ps1 goto 3`，或整体复位。
- **背后的命令**：`alloc.inventory`、`alloc.plans {side:"group",count:3}`、`view.compose`。

## 步 5 · 编组确认界面

- **屏上有什么**：左栏"方案资源总览 / 集群列表"；中间方案切换 tab + 集群明细卡；右栏"方案确认信息 / 编组命令回执 / 下达明细"；底部"确认编组"按钮。
- **你点哪里**：

| 按钮（逐字） | 点完会发生什么 | 什么时候是灰的 |
|---|---|---|
| **确认编组** | **依次发三条**：`alloc.adopt` → `alloc.confirm` → `alloc.assign`；三条回执都留在右栏（哪一条失败就停在哪一条，不往下发） | `alloc.plans` 回执还没回来、或正在下达时 |
| **重新确认编组**（已确认后的文字） | 再走一遍那三条（**幂等**，宿主回 `idempotent=true`，不会重复占资源） | 同上 |
| **方案 tab**（如"方案二｜多域协同压制方案 ★ · 93"） | 换方案（左/中/右三栏跟着换） | 从不灰 |
| **进入任务执行 ≫**（**下达成功后才出现**） | 阶段 T1 → **T2**，切到步 6，并**自动起飞**（仿真时间开始走） | 出现即可点 |
| **自动优化** | 什么都不发生 | **永久灰**（同步 4） |
| **重试**（每条回执一个） | 重发那一条（`alloc.assign` 那条重试 = 重跑整条链） | 该条正在跑时 |

- **点完看到什么**：顶栏"编组确认 已确认（confirmed）"、"台账实体 x/y 成功"；右栏逐条回执（`6 个集群已下达`）；
  成功且无失败实体时出现绿条"编组已下达。下一步点右下角【进入任务执行 ≫】…"，同时长出那颗按钮。
  实测点击后：`步 6/11 · 阶段 T2`，回执里带 `simAutoStart`→"已自动起飞"。
- **想反悔 / 重来**：换方案用中间的 tab；重来点【重新确认编组】。没有"回步 4"的按钮（`scripts\manual.ps1 goto 4`）。
  注意：**阶段一旦推进到 T2，仿真的时钟就开始走了**；要"从头再演一遍"请用 `scripts\manual.ps1 reset`。
- **背后的命令**：`alloc.adopt/confirm/assign {planId}`、`mission.advance {to:"T2"}`。

## 步 6 · 任务执行界面

- **屏上有什么**：顶部压条（阶段 / 仿真 / 倍速 / 链路 / 覆盖率 / 遍历周期）；左栏"任务执行控制"；
  右栏"链路评估 / 侦察覆盖 / 命令回执"；底栏读数 + 按钮。地图上无人机沿航路飞、后面拖着航迹。
- **你点哪里**：

| 按钮（逐字） | 点完会发生什么 | 什么时候是灰的 |
|---|---|---|
| **暂停** | 仿真节拍停住（链路/传感器计数**不再增长**） | 正在发命令时 |
| **恢复** | 继续跑 | 同上 |
| **启动/继续链路** | `sim.start`（正常流程进这一步时已自动起飞，这里是手动兜底） | 同上 |
| **1× / 8× / 60×** | 换倍速（当前档**高亮**，不是灰） | 同上 |
| **自动优化链路** | 重发 `topology.evaluate`，右栏链路表刷新（15 条链路，颜色来自规则包） | 评估正在跑时 |
| **进入侦察阶段 ≫** | 阶段 **T2 → T3 → T4**（按规则包的阶段图**依次**推进），切到步 7 | 从不灰 |
| **重试** | 重发对应的 verb | 对应 verb 正在跑时 |

> **实时读数**：覆盖率（实测 **1.0**）与遍历周期（实测 **2966.7 ms**）是传感器模型算出来的；链路条数是拓扑引擎算的。
> 想验证"暂停真的停了"：点【暂停】→ 看右栏 `eventsEmitted / simElapsedMs / senseCalls` 三个数**不动**。

- **点完看到什么**：`步 7/11 · 实时侦察目标显示 · 阶段 T4`。
- **想反悔 / 重来**：仿真可以反复暂停/恢复/变速，不影响流程；要重跑用 `scripts\manual.ps1 reset`。
- **背后的命令**：`topology.evaluate`、`sensor.status`、`sim.start/pause/resume/speed/state`、`mission.advance {to:"T3"}` → `{to:"T4"}`。

## 步 7 · 实时侦察目标显示

- **屏上有什么**：左栏"视频 / SAR 回传"（2 路）+ "目标来源汇总"；右栏"目标详情 + 处置动作 + 命令回执"；底部**目标卡横条**。
  地图上目标点随探测出现（起飞前 0 个 → 之后逐个冒出来，实测 5 个）。
- **你点哪里**：

| 控件（逐字） | 点完会发生什么 | 什么时候是灰的 |
|---|---|---|
| **目标卡**（`#1` + 名称 + 威胁带） | 选中并把详情拉到右栏（威胁等级 / 置信度 / 位置 / 来源 / 动态状态 / 打击优先级） | 从不灰 |
| **处置动作按钮**（引擎声明的动作，实测 5 个：`重点监视 / 持续跟踪 / 升级为打击目标 / 打击 / 复核评估`） | 对该目标下动作（`targets.act`），之后自动重取目标与详情；回执里带"动作后状态 / 威胁带 / 幂等" | 该动作被引擎判为不可用（文字后面会写出原因）、或没选中目标时 |
| **试发**（配输入框 `动作键（如 watch）`） | 按你敲的动作键发一条 `targets.act`（用来试引擎到底认哪些键） | 没选中目标 / 输入为空 |
| **进入打击准备 ≫** | 阶段 T4 → **T5**，切到步 8 | 从不灰 |
| **重试** / **重试 media.channels** | 重发对应 verb | 对应 verb 正在跑时 |

> 引擎没给出动作清单时，界面会**灰置**三个占位动作（`持续观察 / 持续跟踪 / 打击`）并写明"引擎未返回可行动作清单 → 按纪律灰置"，
> 绝不会拿占位键去发命令。

- **点完看到什么**：右栏出现"动作日志（引擎台账）"逐条记录；点【进入打击准备 ≫】后 `步 8/11 · 阶段 T5`。
- **想反悔 / 重来**：这一步的处置**可以撤销**——去步 10 用【中止处置】（`exec.abort`）。步 7 屏上本身没有撤销按钮。
- **背后的命令**：`targets.list`、`targets.detail`、`targets.act`、`media.channels`、`mission.advance {to:"T5"}`。

## 步 8 · 任务决策与打击准备

- **屏上有什么**：左栏"打击目标 / 打击窗口"；中下**三张打击方案卡**（成功率 / 协同方式 / 预计完成 / 打击方式 / 参与集群 / 几何引用与解析）；
  右栏"AI 决策摘要 / 采纳回执 / 方案与口径来源"。
- **你点哪里**：

| 控件（逐字） | 点完会发生什么 | 什么时候是灰的 |
|---|---|---|
| **目标行**（左栏列表） | 选中目标并取"打击窗口"（剩余 ms / 时长 / 开启关闭 / 最优时刻） | 从不灰 |
| **方案卡**（`1 / 2 / 3` + 方案名，带 `引擎推荐` 徽标） | 选中该方案（不发命令） | 从不灰 |
| **采纳该方案**（成功后变 **重新采纳**） | `strike.adopt` → 阶段被引擎推到 **T5**、步号写回 8；右栏出现"采纳回执"（`planState=adopted · 幂等`） | 未选中方案、或正在采纳时 |
| **进入打击确认 ≫** | 切到步 9（阶段仍是 T5） | 从不灰 |
| **重试** | 重发对应 verb | 对应 verb 正在跑时 |

- **点完看到什么**：底栏出现"已采纳"；接着 `步 9/11 · 打击方案确认`。
- **想反悔 / 重来**：采纳可以重复点（幂等）；想换方案直接点另一张卡再采纳。
- **背后的命令**：`strike.plans {count:3}`、`strike.window {entityId}`、`strike.adopt {planId}`。

## 步 9 · 打击方案确认

- **屏上有什么**：左栏"目标清单 / 引导点(IP) / 命令回执"；中下**打击窗口时间轴**（每段带算式）；右栏"资源调度 / AI 确认建议 / 确认回执明细"。
  地图上：**IP 点 1 个 + 引导连线 10 条 + 评估航线 1 条** + 红色打击目标点。
- **你点哪里**：

| 按钮（逐字） | 点完会发生什么 | 什么时候是灰的 |
|---|---|---|
| **定位到 IP 点（镜头移到宿主给的坐标）** | 只移动镜头到 IP 点（**不发命令**） | 只在拿到带经纬度的 IP 点时才出现 |
| **方案 tab** | 换方案 → 自动重取 `guidance.plan`（几何与时间轴跟着换） | 只有多于 1 套方案时才出现 |
| **确认打击**（成功后变 **重新确认打击**） | `strike.confirm`；若引擎回 `1003`（未采纳）界面会**自动补一条** `strike.adopt` 再重发确认，两条回执都留在屏上 | 没拿到方案、或正在确认时 |
| **进入协同执行 ≫**（**确认打击成功后才出现**） | 阶段 T5 → **T6**，切到步 10 | 出现即可点 |
| **调整方案** | 回步 8 | 从不灰 |
| **重试** | 重发对应 verb | 对应 verb 正在跑时 |

> **时间轴怎么读**：四段（`任务下达（t0） / 预计到达 IP 点 / 打击完成 / 评估完成`），每段都带 `basis{formula,inputs,source}` ——
> 脚本可以独立复算（实测验算误差 **0 ms**）。拿不到输入的段**留空并写明原因**（`MUST NOT` 编时刻）。
> 段名来自 `config.json` 的 `flow.labels`。

- **点完看到什么**：右栏"确认回执明细"出现 `planState=confirmed · 幂等`、"宿主推进到步 10 · 阶段 T6"；底栏"已确认"。
- **想反悔 / 重来**：确认可重复点（幂等）；想退回改方案点【调整方案】。**没有"撤销已确认打击"**（这是真实语义）。
- **背后的命令**：`guidance.plan {planId}`、`strike.confirm {planId}`、`mission.advance {to:"T6"}`。

## 步 10 · 协同执行与引导

- **屏上有什么**：左栏"回传画面 / 目标实时状态 / 协同链路"；右栏"AI 引导提示 / 处置命令 / 处置回执明细"；底部**协同执行目标卡横条**。
- **你点哪里**：

| 按钮（逐字） | 点完会发生什么 | 什么时候是灰的 |
|---|---|---|
| **目标卡**（`目标001` + 动态状态） | 选中目标（不发命令） | 从不灰（已失效的仍可点，只是半透明） |
| **执行处置** | `exec.run`：目标动作 → 状态推进（实测 `briefStop → struck → destroyed`）、仿真侧俯冲、**由读数派生命中判定**；地图上该目标**变灰** | 没选中目标、或正在执行时 |
| **中止处置** | `exec.abort`：能退就退；退不动就**如实**回 `1003` 并列出未满足的条件 | 同上 |
| **下一步：任务总结** | 只切屏到步 11（阶段不动） | 从不灰 |
| **推进阶段并进入总结 ≫** | 阶段 T6 → **T7**，切到步 11（**推荐点这个**：报告里的阶段才对得上） | 从不灰 |
| **重试** / **重试 media.channels** | 重发对应 verb | 对应 verb 正在跑时 |

- **点完看到什么**：右栏"处置回执明细"新增 `exec.run · <entityId> → code=0`、"状态 → 已打击（待评估）"、**命中判据**（公式 + 输入，可独立复算）、
  以及全部标量叶子的 `path=value`；压条"已失效"计数 +1、"状态变更 N 次" +1。
- **想反悔 / 重来**：**这是唯一能"反悔"的一屏**——【中止处置】能退到哪由引擎裁决（退不动会明确告诉你缺什么）。要整轮重演用 `scripts\manual.ps1 reset`。
- **背后的命令**：`exec.run {entityId}`、`exec.abort {entityId}`、`targets.list`、`topology.evaluate`、`mission.advance {to:"T7"}`。

## 步 11 · 任务总结界面

- **屏上有什么**：左栏"任务时间轴（逐阶段耗时）/ 预警次数 / 报告生成状态 / 报告 JSON"；右栏"目标状态（毁伤评估）/ AI 摘要 / 关键结果 / 后续处置 / 报告字段（按引擎分组）"；
  中间"任务结果"大数值卡；底部按钮条。
- **你点哪里**：

| 按钮（逐字） | 点完会发生什么 | 什么时候是灰的 |
|---|---|---|
| **导出任务报告**（绿色主按钮） | 展开报告 JSON 并复制到剪贴板；提示写明"**未下载文件**——本轮不做文件导出，避免谎报已生成 PDF/DOCX" | 从不灰 |
| **复看报告 JSON** / **收起 JSON** | 展开/收起报告原文 | 从不灰 |
| **重新生成报告** | 重发 `report.generate` | 正在生成时 |
| **返回协同执行** | 回步 10 | 从不灰 |
| **重试** | 重发 `report.generate` | 正在生成时 |

- **点完看到什么**：报告 **6 组 30 字段 + 时间轴 12 段 + 预警计数**；每个字段都带 `来源 <engine> / <path>`；
  **拿不到数据的字段显示"缺失 + 原因"，不显示 0**（例：留存层无数据 → 写明"全工程暂无 append() 调用者"）。
- **想反悔 / 重来**：点【返回协同执行】回步 10 继续处置，或【重新生成报告】刷新；整轮重演用 `scripts\manual.ps1 reset`。
- **背后的命令**：`report.generate`、`mission.timeline`、`targets.list`。

---

# 三、像产品一样自由点：跳屏 / 重来 / 容错

手点时最常用的几条命令（都只是**辅助**：跳屏不改引擎状态，复位按真实语义复位）：

```powershell
# 看现在第几步 / 哪个阶段 / 任务号
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\manual.ps1 state

# 跳到任意一屏（纯演示：只换屏，不建任务、不采纳方案）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\manual.ps1 goto 7
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\manual.ps1 goto summary   # 也认步骤 key

# 回起点重演一整轮：仿真回起点 + 清任务与阶段 + 清自检 → 回步 1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\manual.ps1 reset

# 逃生舱：发任意 verb（例如改倍速、看目标列表）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\manual.ps1 cmd sim.speed '{"speed":60}'
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\manual.ps1 log 40   # 看宿主日志最后 40 行
```

| 你会遇到的 | 说明 |
|---|---|
| **同一个按钮点两次** | 安全。幂等成功回 `code=0` + `idempotent=true`（例：重复【确认编组】不会重复占资源） |
| **按钮点不动 / 灰的** | 前置没满足。常见：自检还没出结论（步 2）、方案回执还没回来（步 5）、没选中目标（步 7/10）、正在发命令（busy）。旁边或标题里一般写着原因 |
| **点了之后停在原地，屏上出现红字** | 这是**引擎拒绝**的原话，不是界面坏了。`1003` = 前置不满足（会照抄 `unmet` 与"需要什么"），`1000` = 参数/未知 verb，`1005` = 模块或规则包没装载 |
| **阶段门禁挡下推进** | 界面显示引擎的 `unmet / skippedGates`，并给一颗【**强制推进（force，越过未满足的阶段门禁）**】——越过门禁是**操作员的决定**，回执照旧留在屏上（引擎审计记为 `force-advance / violation=true`） |
| **想回上一屏** | 只有三屏有回退按钮：步 9【调整方案】、步 10【中止处置】、步 11【返回协同执行】；其余用 `manual.ps1 goto <n>`（只切屏）或 `reset`（整轮重来） |
| **刷新浏览器** | 进度不丢（状态在宿主里）。页面永远显示宿主当前的步 |
| **想直接看地图** | `http://127.0.0.1:8099/?stage=map` ——跳过启动/自检，直接进地图台（排障用） |

**错误码表**（`protocol.md` §3）：`0` 成功 · `1000` 参数/未知 verb · `1002` 互斥冲突（例：两条 `flow.runAll` 同时跑）·
`1003` 前置不满足 · `1004` 未找到 · `1005` 内部不可用（模块/规则包未装载）· `1006` 版本不匹配。

---

# 四、备选：一键跑完（不想手点时）

```powershell
cd D:\dsh_workpath\webMap\mission-app
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\demo.ps1 serve     # ① 起宿主
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\demo.ps1 runAll    # ② 11 步一次跑完
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\demo.ps1 stop      # ③ 停
```

`runAll` 内部就是**按顺序发界面同款命令**（每一步都走 `POST /api/command` 这同一个入口），实测 8× 倍速 **14.4 秒**跑完：

```
[demo]   ✓ 步  1  boot.run               code=0       213 ms
[demo]   ✓ 步  2  selfcheck.run          code=0        33 ms
[demo]   ✓ 步  3  flow.enter             code=0         1 ms
[demo]   ✓ 步  4  alloc.plans            code=0         1 ms
[demo]   ✓ 步  5  alloc.adopt            code=0         5 ms
[demo]   ✓ 步  6  mission.advance        code=0        13 ms
[demo]   ✓ 步  7  targets.list           code=0     14016 ms   ← 真等"目标被探测发现"
[demo]   ✓ 步  8  strike.plans           code=0         3 ms
[demo]   ✓ 步  9  strike.confirm         code=0         2 ms
[demo]   ✓ 步 10  exec.run               code=0        91 ms
[demo]   ✓ 步 11  report.generate        code=0        18 ms
[demo] 汇总：ok=True failedStep=(无) 总耗时 14408 ms 倍速 8x
```

再演一遍只要再发一次 `runAll`（它自己先 `sim.reset` + `mission.reset`；**不用重启进程**）。
手工 HTTP 等价写法：

```powershell
$b = '{"verb":"flow.runAll","params":{"speed":8}}'
(Invoke-WebRequest http://127.0.0.1:8099/api/command -Method POST -Body $b -ContentType application/json -UseBasicParsing).Content
```

> **手点 vs 一键的关系**：一键不绕过任何东西——它逐步调的就是你手点时按的那些 verb。
> 所以"手点跑通了"和"`runAll` 跑通了"是同一条证据链。

---

# 五、命令 / 端点 / verb / 事件（参考）

## 5.1 命令行参数（`mission_host.exe`）

| 参数 | 作用 |
|---|---|
| `--config <路径>` | 配置文件；缺省依次尝试：仓库根 `config.json` → 环境变量 `MISSION_APP_CONFIG` → exe 附近 |
| `--port <端口>` | 覆盖 `server.port`（并行跑第二个实例时用） |
| `--scenario <目录>` | 覆盖本地配置目录（缺省 `<dataDir>/scenario-1`） |
| `--speed <1\|8\|60>` | 仿真倍速 |
| `--no-sim` | 只起服务与接入层，不跑仿真节拍 |
| `--log <文件>` | stdout/stderr 重定向到文件（后台跑用；`demo.ps1` 就用它） |
| `--stop-after <秒>` | 跑够秒数自动走正常退出序列（脚本化用） |
| `--selftest` | 不起网络、不读配置，只验装配与就绪行 |
| `--determinism-check` | 离线双跑逐字节比对报文序列（假时钟） |
| `--help` | 用法 |

## 5.2 HTTP / WS 端点

| 端点 | 方法 | 用途 |
|---|---|---|
| `/` | GET | 前端首页（`?stage=map` 直接进地图台；`?ws=<url>` 覆盖实时通道地址） |
| `/health` | GET | selfcheck 聚合负载（`status/checkedAt/modules/selfCheck/systemOverview/wsClients`） |
| `/healthz` | GET | 不碰引擎的最小探活（区分"服务没响应"与"某个处理器卡住"） |
| `/stats` | GET | 各引擎就绪 + 规则包装载情况 + 仿真/接入/广播读数 |
| `/runtime-config` | GET | 前端要的装配信息（瓦片模板等） |
| `/api/state` | GET | **流程状态**（步/阶段/任务/启动进度/自检/态势/编组/打击/报告） |
| `/api/command` | POST | **唯一的命令面**：`{"verb":"...","params":{...}}` → `{code,verb,data\|error}` |
| `/shutdown` | POST | 请求正常退出（后台跑时唯一能优雅停的路） |
| `/ws` | WS | 实时事件（信封 `{type,data,ts}`；页面每 1.2 s 发一次心跳） |
| `/tiles/{z}/{x}/{y}.jpg` | GET | 底图瓦片（z0–14，14204 块） |
| `/media/**` | GET | 视频/SAR 帧（支持 Range/206） |
| `/ws-close?peer=` | POST | 按 peer 片段强断某条 WS（验收用） |

## 5.3 常用 verb（完整 46 条，按步分组）

| 步 | verb |
|---|---|
| 1–2 | `boot.run` `boot.reset` `selfcheck.run` `selfcheck.recheck` `selfcheck.report` `selfcheck.history` `selfcheck.purity` `capabilities.refresh` |
| 3 | `flow.enter` `flow.goto` `flow.state` `situation.snapshot` `view.compose` `view.mode` `mission.advance` |
| 4–5 | `alloc.inventory` `alloc.plans` `alloc.adopt` `alloc.confirm` `alloc.assign` |
| 6 | `sim.start` `sim.pause` `sim.resume` `sim.speed` `sim.step` `sim.state` `sim.reset` `topology.evaluate` `sensor.status` `sensor.configure` |
| 7 | `targets.list` `targets.detail` `targets.act` `media.channels` |
| 8–9 | `strike.plans` `strike.window` `strike.adopt` `strike.confirm` `guidance.plan` |
| 10–11 | `exec.run` `exec.abort` `report.generate` `mission.timeline` |
| 全流程 | `flow.runAll`（`{speed,from,to}`）`mission.reset` |

## 5.4 实时事件（WS）

`selfcheck.progress` `selfcheck.ready` `selfcheck.done` `flow.state` `mission.phase` `mission.progress` `mission.status`
`plan.state` `resource.allocation.changed` `resource.ledger.changed` `entity.changed` `target.state` `entity.consistency`
`topology.changed` `alert.raised|updated|acked` `report.ready` `sim.state` `media.channels` `device.online|offline|stats`

---

# 六、验收：怎么证明它真的在跑

七个阶段各有**真机**验收脚本（真宿主 + 真前端 + Chrome CDP 1280×800，截图落 `docs/screens/`）。
**它们都要驱动同一个宿主，因此不要并发跑**；跑之前先 `demo.ps1 serve`。

```powershell
node scripts\live-check.mjs  http://127.0.0.1:8099/   # P1 地图链路（**须在宿主刚启动时**跑：仿真还在飞行段）11/11
node scripts\p2-check.mjs    http://127.0.0.1:8099/   # 步 1–2  启动加载 + 自检       24/24
node scripts\p3-check.mjs    http://127.0.0.1:8099/   # 步 3–5  态势 + 编组 + 确认    38/38
node scripts\p4-check.mjs    http://127.0.0.1:8099/   # 步 6–7  执行 + 探测 + 目标    51/51
node scripts\p5-check.mjs    http://127.0.0.1:8099/   # 步 8–9  打击方案 + 引导       47/47
node scripts\p6-check.mjs    http://127.0.0.1:8099/   # 步 10–11 执行 + 总结报告      57/57
node scripts\p7-check.mjs    http://127.0.0.1:8099/   # 一键串联 + 倍速 + 可重跑      33/33
node scripts\click-check.mjs http://127.0.0.1:8099/   # **手点通路**：只用界面按钮从步 1 点到步 11（§二 手册的机器版）
node scripts\render-check-map.mjs                     # 前端自带受控 WS 服务端，只验渲染
pwsh -File scripts\acceptance.ps1                     # 结构守卫 + 构建 + 端点（含 BOM 校验）
```

> `acceptance.ps1` 会先按 **`-DMA_BUILD_SENSOR_MODEL=OFF`** 重新 configure —— 这是**负向验收**
> （证明"缺可选模块也装得起来、跑得起来"）；它在最后一步（**C5**）把默认配置装回来，所以跑完验收不会把你的演示构建弄成"缺模块"版。
> 想跳过整个构建段：`acceptance.ps1 -SkipBuild -SkipFrontend`（复用已有产物，只跑结构守卫与端点）。

**写新脚本请照抄这几条纪律**（都踩过）：断言里**打印实测原值**而不是"应为"；
**拿不到的数据一律留空 + 点名原因**，MUST NOT 编数值、MUST NOT 显示成 0；
WS 采集器**先建连接再发 HTTP**（Node 的 WebSocket 与 fetch 共用 dispatcher）且**自己发心跳保活**（hub 4.5 s 判死）；
截图前 `Emulation.setDeviceMetricsOverride(1280x800)`。

---

# 七、故障排查（症状 → 原因 → 处置）

**1) 页面报"规则包装载失败（…）：code=1000 规则包文件读不到"**
→ 相对路径没解析（`config.json` 里的 `../selfcheck/...` 是相对**配置文件**的）。已修（`resolvePath`）；旧二进制请重构。
排查：`--log D:\log.txt` 起一次，看首行 `[host] 配置：<路径>` 是不是你期望的那份。

**2) 控制台中文全是乱码**
→ Windows 控制台默认代码页 936，而程序输出 UTF-8。宿主启动时已切 UTF-8；旧二进制请重构。终端字体也要支持中文。

**3) 页面能开，但切屏慢半拍、`/stats` 里 `clientCount` 恒为 0**
→ 前端事件腿被判死踢掉（hub 判死窗 1.5 s × 3 ≈ **4.5 s**，客户端心跳必须更密）。已在 `apps/web/src/flow/useFlow.ts` 用 `heartbeatMs: 1200` 对齐。

**4) 第二条实例起来了但收不到数据（`packets=0`、启动加载卡在 50%）**
→ 两条实例都绑了同一个 UDP 接入端口（默认 `45500`），Windows 只把报文投给**先绑定**的那个。
处置：第二条实例换端口 —— `demo.ps1 serve -Port 8100 -IngestPort 45501`。

**5) `live-check` 报"航迹没画出来"**
→ 它要求**仿真还在飞行段**（约 60 秒，8× 倍速）。宿主起来很久了就先 `scripts\manual.ps1 reset` 或重启宿主再跑。

**6) 编排脚本在 Windows PowerShell 5.1 上卡住不返回**
→ 5.1 的 `Start-Process -RedirectStandardOutput` **会等到子进程退出**。用宿主自带的 `--log <文件>`，或直接用 `scripts\demo.ps1`（已按这个坑写好）。

**7) 自己写的 `.ps1` 一跑就报语法错误、中文乱码**
→ Windows PowerShell 5.1 **按 ANSI 读没有 BOM 的脚本**。带中文的 `.ps1` 必须存成 **UTF-8 with BOM**
（本仓 `scripts\*.ps1` 都是，`acceptance.ps1` 里还有 BOM 硬校验）。

**8) 端口被占 / 上次没停干净**

```powershell
Get-NetTCPConnection -LocalPort 8099 -State Listen | Select OwningProcess
Get-Process mission_host | Stop-Process -Force     # 硬停（不 flush，万不得已）
```

---

# 八、硬约定与已知边界

## 硬约定

1. **模块源码一行不拷、一行不改**：`add_subdirectory(<模块目录> <build子目录>)` 原地引用；
   宿主只 include 各模块的**公开头**（`include/<mod>/*.h`）。确需改模块 → 在**它自己的仓**里改，并附需求与验收。
2. **宿主里没有业务逻辑**：宿主只做「装配 / 依赖注入 / 生命周期 / 转发 / 编排」；
   业务取值全在规则包（各模块仓 `policies/mapapp/*.json`），界面文案与等级映射也来自规则包。
   连**11 步的显示名**也在 `config.json` 的 `flow.steps`、流程文案在 `flow.labels` —— 宿主源码只留 `key`/`phase` 骨架。
   `acceptance.ps1` 的 **S1**（标识符层无业务词）+ **S1b**（业务词只许出现在诊断文案里）两条守卫看着这件事。
3. **前端不自己改 step**：切屏/推进一律发命令（`flow.goto` / `mission.advance`），由宿主决定落在第几步。
   阶段推进走引擎的 Gate，被挡下时界面照抄引擎原话，并给一个**显式**的 force 入口（不是默认行为）。

## 已知边界

| 事项 | 现状 | 原因 |
|---|---|---|
| AI 分析（`llm-provider`） | 未接；界面按"未提供 + 原因"显示 | 本期不需要；`llm-provider` 尚未实现 |
| `telemetry-store` 回放 | 报告里"留存层无数据"并写明原因 | 全工程暂无 `append()` 调用者（属后续波次） |
| 媒体素材 | image-seq 占位（20 帧真 JPEG） | 生成机无视频编码器，未造 mp4；video 分支与 URL 槽位已支持 |
| 场景二 | 只声明形状、无几何/坐标 | 裁决 Q5：不占位、缺就如实显示"未配置" |
| 自检"卫星链路" | 恒 `abnormal`（界面上按钮会变【仍要进入任务 ≫】） | 探针包缺"未配置"分支（模块侧，已登记 `引擎缺陷登记.md`） |
| 仿真航路 | 每台只有"部署区 → 主任务区"一段，抵达后原地保持 | 场景数据边界（裁决 A11）；`manual.ps1 reset` 可回到起点重演 |
| T3（组网规划） | 与步 6 同一屏（阶段图 T2→T3→T4 必须依次走） | 规则包 `phases.json` 的阶段图；界面按链依次推进，不另开屏 |

## 许可

Apache License 2.0，见 [LICENSE](LICENSE)。
