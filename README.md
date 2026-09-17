# mission-app · 智能任务管理系统（场景一：敏捷拒止布控）

> **这份文档是给"坐在电脑前点界面的人"写的**：起一条命令（§1.0 一分钟版），剩下的全在浏览器里点。
> **20 屏**每一步都写清了 **屏上有什么 → 你点哪里 → 点完看到什么 → 想反悔怎么办**。
>
> 现状：P0–P7 全部完成，七个阶段各有真机验收脚本，一轮跑完 **261 条断言全绿**（见 §六）；
> 界面已按参考图返工两轮（2026-09-17），**20 屏真机截图**在 `docs/screens/screens/`；
> 除逐阶段脚本外另有四条**界面级**自证：手点通路 `click-check`、**真鼠标**手点通路 `click-real`、
> 排版与可点性审计 `layout-check`、量算真机 `measure-check`（都在 §六）。
> 手点全流程已在真机跑通（本文的按钮文字与可见结果都是**实测**，不是设计稿）。

---

# 一、先跑起来（手点模式 = 一条命令 + 一个页面）

## 1.0 一分钟版（复制这四段就能用）

```powershell
cd D:\dsh_workpath\webMap\mission-app

# ① 重建前端产物 —— 【可选】只在「第一次」或「刚改过 apps/web 源码」时跑（约 5 秒）
#    首次还要先建 C++ 宿主，见 §1.1-C
cd apps\web ; npm run build ; cd ..\..

# ② 起宿主（后台；-NoBuild = 跳过 C++ 构建，秒起）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\demo.ps1 serve -NoBuild

# ③ 打开页面
start http://127.0.0.1:8099/

# ④ 收工：优雅停（先 flush 留存层，再按装配逆序停模块）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\demo.ps1 stop
```

> **下面这几条是新手最容易踩的**，每条都对应一个 `demo.ps1` 的真实行为：
> · **真正的实现只有一份，在 `mission-app\scripts\demo.ps1`** —— 你在别的目录
>   （例如它的上一层 `D:\dsh_workpath\webMap`）直接敲 `-File scripts\demo.ps1`，
>   会报 `-File 形式参数的实际参数"scripts\demo.ps1"不存在`。两个解法见下面的「不在 mission-app 目录时」；
> · 所有动作（`serve` / `status` / `runAll` / `stop`）都认 **`-Port`** —— 用 `-Port 8100` 起的实例，
>   必须用 **`-Port 8100`** 去停/看状态，否则脚本找的是默认的 8099；
> · `serve` 在**已经有一个实例**时不会重复起，只打印一行 `已经有实例在 … 上跑着（先 stop）`；
> · 想**同时跑第二个实例**必须错开 UDP 接入端口：`serve -Port 8100 -IngestPort 45501`
>   （两条实例都绑 45500 的话，Windows 只把报文投给先绑定的那条，后起的那条 `packets=0`）；
> · **改了前端就必须重建 `dist`**，否则页面还是旧界面（`dist` 不入库，宿主托管的是它）。

### 不在 mission-app 目录时（两行之一，都在 `D:\dsh_workpath\webMap` 下敲）

仓库根目录放了两份**转发器**（十几行、不含任何逻辑，只把参数原样交给 `mission-app\scripts\demo.ps1`），
所以在 `webMap` 根目录下这两条都能用：

```powershell
# ① 最短
powershell -NoProfile -ExecutionPolicy Bypass -File demo.ps1 stop

# ② 与"在 mission-app 里"写法一致的那种（脚本名一样，只是路径少一层）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\demo.ps1 stop
```

两条都会先打印一行**转发提示**，再输出真正的结果（下面这条是 ① 的实测原文）：

```
[demo] （webMap\demo.ps1 转发 → D:\dsh_workpath\webMap\mission-app\scripts\demo.ps1）
[demo] 已停（正常退出序列）
```

（② 那一行的提示写的是 `webMap\scripts\demo.ps1 转发`，其余完全一样。）

> 不带参数时默认执行 `status`（比什么都不做有用）。`serve` / `status` / `runAll` / `stop`
> 与 `-Port` / `-Speed` / `-IngestPort` / `-NoBuild` **全部原样转发**。

## 1.1 起服务（后台 / 前台二选一）

### A. 后台跑（推荐；`demo.ps1` 一把梭）

在 `mission-app` 目录下：

```powershell
cd D:\dsh_workpath\webMap\mission-app
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\demo.ps1 serve -NoBuild
```

它会打印**四行**，看到就成功了（下面是实测原文）：

```
[demo] 已就绪：http://127.0.0.1:8099/   （排障后门 http://127.0.0.1:8099/?stage=map）
[demo] 引擎就绪：selfCheckReady=True  step=1  phase=''
[demo] 日志：D:\dsh_workpath\webMap\mission-app\scripts\.demo-host.out.log
[demo] 下一步：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\demo.ps1 runAll    （或直接在浏览器里点）
```

- **去掉 `-NoBuild`** 就会先跑一次 `cmake --build`（默认行为；只有改了 C++ 才需要，慢）。
- 已经有实例在跑时不会再起，只打印：`[demo] 已经有实例在 http://127.0.0.1:8099 上跑着（先 stop）`。
- 宿主自己的日志落盘在 `scripts\.demo-host.out.log`（脚本**不**用重定向起进程 ——
  Windows PowerShell 5.1 的 `Start-Process -RedirectStandardOutput` 会等到子进程退出，用它起长跑进程会卡住）。
- **`?stage=map`** 是排障后门：跳过启动/自检直接进地图台，**并且保留开发自证信息条**
  （`mission-app｜通道｜/health｜engines`）。产品屏（SH-01…SH-20）上**没有**那条信息条 —— 这是 2026-09-17 返工的结果。

### B. 前台跑（想在本终端看滚动日志）

```powershell
cd D:\dsh_workpath\webMap\mission-app
.\build\bin\Release\mission_host.exe --speed 8 --port 8099
# 退出：Ctrl+C（走正常退出序列，见 §1.4）；日志直接打在终端里
# 常用可选参数：--log <文件> 把日志同时落盘；--config <json> 换一份配置（并行实例时改 UDP 端口用）
```

### C. 什么时候必须**先构建**

| 你改了什么 | 要跑什么 | 忘了会怎样 |
|---|---|---|
| **没改**（只是手点演示） | 什么都不用跑，直接 `serve -NoBuild` | —— |
| **前端**（`apps/web/src/**`、`apps/web/index.html`） | `cd apps\web; npm run build` | 页面打得开但**还是旧界面**（宿主托管的 `dist` 没变）。**本轮界面返工后必须重建一次** |
| **C++ 宿主 / 模块引用 / `config.json`** | `demo.ps1 serve`（去掉 `-NoBuild`） | 跑的还是旧二进制 |
| **模块仓的规则包 JSON**（例：`view-composer/policies/mapapp/*.json`） | **重启宿主**（规则包是运行时读的，不必重编） | 界面按旧规则包灰置工具。实测：本轮订正 `map2dImplemented` 后重启宿主，`measure` 就从 `disabled` 变成 `enabled` |

一次性把两类产物都建出来（新机器 / 换机器）：

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

### D. `demo.ps1` 全部动作与参数

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\demo.ps1 <动作> [参数]
```

| 动作 | 干什么 | 实测输出 |
|---|---|---|
| `serve` | 后台起宿主并等它就绪（默认会先构建；`-NoBuild` 跳过） | 上面那四行 |
| `status` | 看步/阶段/任务/仿真/自检/实时连接数 | `[demo] 步 1/11（boot）· 阶段 '' · 任务` + 仿真/自检/实时连接数，共四行 |
| `runAll` | 一键把 11 步跑完（内部 `sim.reset` → `mission.reset` → `flow.runAll`，逐步打印 code 与耗时） | 每步一行，例如 `[demo]   ✓ 步  3  flow.enter             code=0         1 ms`；末尾一行 `汇总：ok=True failedStep=(无) 总耗时 … ms 倍速 8x` |
| `stop` | **优雅停**：`POST /shutdown`，等它自己退出 | 见 §1.4 |

| 参数 | 默认 | 说明 |
|---|---|---|
| `-Port <int>` | `8099` | 监听端口。**`status` / `stop` / `runAll` 也认它** —— 换了端口就要一起换 |
| `-Speed <1\|8\|60>` | `8` | 仿真倍速（`runAll` 用它跑；`serve` 用它起） |
| `-IngestPort <int>` | 不动（`config.json` 里 `ingest.points[0].port` = **45500**） | 覆盖 UDP 接入点端口；**并行第二个实例时必须错开**（例 `-IngestPort 45501`） |
| `-NoBuild` | 关 | 跳过 `cmake --build`（只有 `serve` 用得上） |

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

## 1.4 停止（怎么停才算"干净"）

> 下表里的 `scripts\demo.ps1` 是**相对 mission-app 目录**的路径。
> 如果你人在 `D:\dsh_workpath\webMap`（上一层），用 `demo.ps1` 或 `scripts\demo.ps1` 都行（转发器，见 §1.0）。

| 场景 | 命令 | 说明 |
|---|---|---|
| **后台跑**（`demo.ps1 serve` 起的） | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\demo.ps1 stop` | 发 `POST /shutdown`，走**正常退出序列**；脚本会等它真的退出再返回 |
| **换了端口**的实例 | 上面那条加 `-Port 8100` | 不加就是去停 8099 的那条（很可能压根没在跑） |
| **前台跑**（自己敲 exe 起的） | 在**那个终端**按 **Ctrl+C** | 同上：先 flush 留存层，再按装配逆序停模块 |
| **人在 `webMap` 根目录** | `powershell -NoProfile -ExecutionPolicy Bypass -File demo.ps1 stop` | 同一件事的短写法（转发器） |
| 只想看一眼状态 | `... scripts\demo.ps1 status` | 步/阶段/任务/仿真读数/自检/实时连接数 |
| 已经停了又敲一次 stop | —— | 只打印 `[demo] http://127.0.0.1:8099 上没有实例在跑`（不是错误） |

`stop` 的实测输出（两行；走转发器时会多一行转发提示）：

```
[demo] 请求优雅停（先 flush 留存层，再按装配逆序停模块）…
[demo] 已停（正常退出序列）
```

**正常退出序列**在宿主日志（`scripts\.demo-host.out.log`）尾部长这样——看到 **`exit clean`** 才算干净：

```
[host] 退出中…
[host] flush telemetry-store：缓冲 0 条 → 已落盘 0 条（appended=0, buffered=0, flushes=0）
[host] telemetry-store flushed
[host] engines stopped (reverse order)
[host] hub stopped
[host] exit clean
```

**停完之后怎么确认真的停干净了**（两条都返回空就是干净）：

```powershell
Get-NetTCPConnection -LocalPort 8099 -State Listen -ErrorAction SilentlyContinue   # 还有没有人在监听
Get-Process mission_host -ErrorAction SilentlyContinue                            # 还有没有残留进程
```

**卡住了要强停**（万不得已；**留存层不会 flush**）：

```powershell
Get-Process mission_host | Stop-Process -Force
```

> 前台跑时敲了 `demo.ps1 stop` 会怎样：`POST /shutdown` 一样能让它退出，脚本正常打印"已停"。
> 只有当它连 HTTP 都不响应时，脚本才会提示 `还没停：它可能是前台跑的，去那个终端按 Ctrl+C`。

---

# 二、手点 20 屏：逐屏手册

> **这一章已按《宿主需求专篇》DES-APP-001 重写**：界面照参考图做、流程照参考图走。
> 20 屏 = 启动 2 屏 + T0–T7 共 16 屏 + 两张**大屏**态势图；每屏对应一张参考图（`参考文档\需求图与描述\`）。
> 逐屏的完整元素清单（逐字文字、数值、勘误）见 `参考文档\宿主需求专篇.md` §3 与 `参考文档\需求图清单\A…E.md`；
> 每屏的真机截图见 `docs/screens/screens/`（20 张，1536×1024）。

## 2.0 一屏一览（点哪里 → 去哪一屏）

| 屏 | 参考图 | 屏上要点 | 你点哪里 → 去哪一屏 |
|---|---|---|---|
| **SH-01** 启动加载界面 | `系统启动界面一` | 5 张模块卡真实推进（地图引擎/通信链路/AI引擎/集群管理/数据服务）+ 右侧「系统状态」 | 不用点；加载完自动进 SH-02（进度未满时有【重新加载】） |
| **SH-02** 自检校验界面 | `系统启动界面二` | 5 项检测卡（通信链路/定位系统/集群节点/后方指控/系统安全）+ 右栏「系统状态概览」+ 麦克风球 | 【一键自检】→【重新检测】→【进入任务】/【**仍要进入任务 ≫**】（有异常项时）→ SH-03 |
| **SH-03** 任务态势主界面 | `T0-1` | 左导航 7 项；A/B/C 区域 + 敌方潜在部署区 + 3 个我方预备集群；右栏 AI任务分析/任务信息/资源概况；底部三张场景卡 | 点**场景卡**（场景一：敏捷拒止布控）→ SH-04；场景二/三按图保留但**未实现**（点了只提示） |
| **SH-04** 场景确认界面 | `T0-2` | 地图（A 友方集结区/B 监视区/C 高价值目标区）+ 通栏「AI语音助手」对话区 + 右栏 AI任务分析/任务信息 | 【AI语音解读】看解读；【进入任务执行】→ 阶段 T0→**T1**、落 SH-05；【返回场景选择】→ SH-03 |
| **SH-05** 集群编组界面 | `T1-1` | 左栏「无人机类型列表」（4 型：总/可用/能力标签/已分配·待分配）；中区**地图上叠三列方案卡**（方案二高亮 + AI推荐）；右栏推荐评分/理由/预期效果/系统状态 | 点**方案卡**选中；【查看方案详情】/【确认采用推荐方案】→ SH-06；【自动优化】**灰置**（宿主没有该 verb） |
| **SH-06** 方案确认界面 | `T1-2` | 左栏「方案资源总览」「集群列表」；中区 6 块任务区域 + 6 张集群卡（四型配比/任务属性/协同关系）+ 前沿指挥节点；右栏「方案确认信息」 | 【确认编组】（内部 adopt→confirm→assign 三步链，逐条回执留在屏上）→ 步 5；成功后出现【进入任务执行 ≫】→ 阶段 T1→**T2**、落 SH-07 |
| **SH-07** 链路拓扑界面 | `T2-1` | 6 个六边形集群 + 前沿指挥节点；**绿实线成网汇聚中央 + 橙黄虚线**；右栏「AI链路分析」（4 环 + 6 项指标） | 【自动优化链路】重算质量；【进入侦察阶段】→ 阶段 **T3→T4**、落 SH-09 |
| **SH-08** 链路稳定界面 | `T2-2` | 同拓扑；右栏「链路稳定评估」+ 带宽提升/时延降低两条曲线 + 4 指标 | 同上（本屏图上没有其它按钮） |
| **SH-09** 侦察展开地图界面 | `T3-1` | 6 个六边形集群位（集群1–6）+ 右栏「集群总体状态」（在线/信号强度/电量） | 右上「显示模式」下拉切**侦察融合** → SH-10；【更多详情 >】展开明细 |
| **SH-10** 侦察数据融合界面 | `T3-2` | **2×3 六路宫格**（集群1–6，格内是真实回传帧）+ 底部「数据源」4 小窗（光电/雷达/电子/通用）；右栏集群总体状态 | 右上「显示模式」切回侦察展开；左导航**目标** → SH-11 |
| **SH-11** 目标列表界面 | `T4-1` | 地图 + **浮动「目标详情」卡**（编号/徽标/类型/置信度/位置/海拔/目标特征/威胁评估）；底部「目标列表」5 卡（威胁色字） | 点**目标卡**（第一次选中、第二次进详情）→ SH-12；‹ › 翻页 |
| **SH-12** 目标详情界面 | `T4-2` | 右栏整栏「目标详情」+「AI分析结果」5 行 | 【升级为打击目标】（红）→ `targets.act` 成功后落 SH-13；【交由集群重点监视】【持续跟踪】留本屏；三颗按钮的**动作键来自引擎声明的动作清单**，引擎没给清单就灰置 |
| **SH-13** AI决策界面 | `T5-1` | 地图下「打击方案」3 卡（光电精确打击/多集群协同压制/电子干扰配合；成功率取引擎）+ 绿角标「推荐方案」；右栏整栏「AI语音交互」（系统说/用户说/系统回复） | 点方案卡选中；【进入打击确认 ≫】→ SH-14（图上**没有**"确认"按钮，故采纳在下一步） |
| **SH-14** 打击确认界面 | `T5-2` | 目标清单 3 行 + 「打击窗口时间轴」（T+00 信息包生成 / T+03 火力协同确认 / T+06 空中支援接入 / T+09 等待任务生成）+ 右栏资源调度/信息包与协同状态/AI确认建议 | 【生成打击任务】→ `strike.confirm` 成功 → 阶段 T5→**T6**、落 SH-15；【调整方案】→ SH-13 |
| **SH-15** 执行态势界面 | `T6-1` | 地图上红锁定框 + 目标标签；左下三标签（多源数据叠加/实时锁定/轨迹修正）；右栏 AI提示/跟踪状态/协同链路 | 【调整观察角度】重取引导；【保持跟踪】→ SH-16 |
| **SH-16** 引导控制界面 | `T6-2` | 修正轨迹（青实线）+ 原轨迹（虚线）+ 偏差标注 + 信息同步；右栏 AI轨迹修正/命中概率/同步状态 | 【确认引导】→ `exec.run` 成功 → SH-17；【重新规划】→ 重下引导 |
| **SH-17** 毁伤评估地图界面 | `T7-1` | 灰化「已失效」、黄色「残余威胁」、虚线「复核航线」、返航轨迹；右栏目标状态/集群回收/节点状态 | 【继续复核】重取台账；【准备脱离】→ SH-18 |
| **SH-18** 任务总结界面 | `T7-2` | 3 张指标卡（目标清除/覆盖区域/协同效率）+「报告生成」进度 + 3 状态标签；右栏 AI摘要/关键结果/后续处置 | 【导出任务报告】展开并复制 JSON（**不谎报 PDF 下载**）；【返回场景选择】→ 新一轮（落 SH-03）；【快速脱离体系】**灰置**（宿主没有该 verb） |
| **SH-19** 大屏 · 任务执行态势 | `第二屏.png` | 自成一壳：居中大标题 + 右上系统时间/任务状态；左栏当前任务/阶段/完成进度；右栏无人资源状态/链路状态；底部「任务执行流程」六段 | 图上**没有按钮**（只读）；用 `?screen=SH-19` 直达，左上有【← 回到流程界面】 |
| **SH-20** 大屏 · 红方侦察态势 | `第三屏.png` | 左栏「信息汇聚来源」（侦察集群 1–4 + 历史情报关联）；中栏「红方综合态势图」；右栏 AI态势研判/态势统计；底部「情报关联关系图」六节点 | 同上（只读 + 深链） |

## 2.1 全流程（按图走）

```
SH-01 启动加载 ──自动──▶ SH-02 自检校验 ──【进入任务】──▶ SH-03 任务态势主界面
   └─点场景卡（场景一）▶ SH-04 场景确认 ──【进入任务执行】(T0→T1)──▶ SH-05 集群编组
        └─【查看方案详情】/【确认采用推荐方案】▶ SH-06 方案确认 ──【确认编组】→【进入任务执行 ≫】(T1→T2)──▶ SH-07 链路拓扑
             ├─【自动优化链路】▶ SH-08 链路稳定（同一步的两屏）
             └─【进入侦察阶段】(T3→T4)▶ SH-09 侦察展开 ──显示模式▶ SH-10 侦察融合 ──左导航「目标」▶ SH-11 目标列表
                  └─点目标卡▶ SH-12 目标详情 ──【升级为打击目标】▶ SH-13 AI决策 ──【进入打击确认 ≫】▶ SH-14 打击确认
                       └─【生成打击任务】(T5→T6)▶ SH-15 执行态势 ──【保持跟踪】▶ SH-16 引导控制 ──【确认引导】▶ SH-17 毁伤评估
                            └─【准备脱离】(T6→T7)▶ SH-18 任务总结 ──【返回场景选择】▶ SH-03（新一轮）
```

**手点通路自证**：`node scripts\click-check.mjs http://127.0.0.1:8099/` —— 只用界面上的按钮把上面这条路走一遍
（32 条断言：每一步的落屏 + 阶段 T0→…→T7；实测 **32/32 通过**）。

## 2.2 跳屏与复位（想直接看某一屏时）

```powershell
# 直接把某一屏打开（`?screen=` 深链；宿主步号不匹配时屏上会挂一条如实提示）
start "http://127.0.0.1:8099/?screen=SH-09"
start "http://127.0.0.1:8099/?screen=SH-19"      # 大屏
# 或者用辅助脚本：
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\manual.ps1 goto 7
```

## 2.3 本轮的已知偏差（**图上没有、但为了演示与验收保留了**）

| 偏差 | 在哪 | 为什么 |
|---|---|---|
| 「仿真控制」条（启动/继续链路、暂停、恢复、1×/8×/60×） | SH-07 / SH-08 | 图上没有这排控件，但**步 6 就是仿真在跑**，暂停/倍速是演示与验收（`p4-check`）必须的能力 |
| 左上「显示模式」下拉做成可切屏 | SH-09 ↔ SH-10 | §4.1 的过渡①（图上只是一个胶囊；不切屏就没法用手点从"侦察展开"走到"侦察融合"） |
| 深链提示条 & 大屏【← 回到流程界面】 | 所有屏 / 大屏 | `?screen=` 直达时如实告知"宿主当前步与屏不匹配"；大屏是独立壳，需要一条回到流程的路 |
| 底图为**二维瓦片**（图上是三维地形） | 所有带地图的屏 | 本工程的底图是离线栅格瓦片；屏上已如实标注"底图为二维瓦片（图上是三维地形）" |
| 「信号强度 / 带宽 / 时延 / 覆盖范围 / 跟踪稳定度 / 命中概率 / 偏差 / 回收进度」等 | SH-07/08/15/16/17 等 | 这些字段**全工程没有数据源** → 一律显示「—」并写明"引擎未给出该字段"，**不编数**（图上数值是示意值） |
| 「自动优化」「快速脱离体系」等按钮 | SH-05/SH-06/SH-18 | 宿主没有对应 verb → **灰置 + title 写原因**，不假装能点 |
| 时间轴段名：图上 `T+00…T+09` vs 引擎 `t0/到达/打击/评估` | SH-14 | 段名照图；时刻位先显示引擎真值段（§9-9 待裁决，屏上有口径说明行） |
| 工具条上多一格「**测面**」（图上只有「测距」） | 所有带地图的屏 | 量算（M2-CTRL-10）在 map-2d 里是**测距 + 测面 + 方位角**三件；图上只画了"测距"一格。测面与测距**共用规则包的同一个 `measure` 工具**（同一份可用性），只是把模块已有的能力接出来，故多一格 |
| 工具条上多一格「**复位**」（图上没有） | 所有带地图的屏 | 原先是浮在地图右下角的独立按钮 —— 实测**每一屏都被那一屏自己的面板压住**（`layout-check` 报 42/60 屏次点不到：右下角要么是"请选择任务场景"卡区，要么是右栏/底部浮层）。地图四个角在本应用里都被面板占了，唯一恒定空着的位置就是左上工具条，所以把它并进去 |
| **不开**地图「缩放 ±」与「指北针 N」控件（图上都有） | 所有带地图的屏 | map-2d 把缩放按钮固定在**右上角**、指北针固定在它正下方（`map-2d/src/core/controls.ts` 的 `POSITION` 表与 `ui/Compass.tsx`，**宿主不可配**），而本应用每个地图屏的右上角都是右栏面板 —— 开了实测 48/60 屏次被面板遮挡。缩放用滚轮/双指/键盘 `+`/`-`（M2-CTRL-14）仍可用；指北针在本应用里也不承载信息（建图时 `dragRotate:false`，恒指正北）。**比例尺照常开启**（右下角，每屏实测可见："1 km"） |
| 开发自证信息条只在 `?stage=map` 出现 | 地图台 | `mission-app｜通道｜/health｜engines` 那条是**开发者自证**，不该出现在交付界面上；产品屏一律不渲染它（`MapStage` 的 `debug` 属性） |
| 「数据来源与诊断」「命令回执」默认**折叠** | 所有屏 | G-09 要求"每个数字都能找到出处、缺失要写明原因" —— 这些句子原先平铺在正文里，把界面撑成了"工程味"。改成折叠块后**内容仍在 DOM 里**（验收脚本照读），点开即见 |

## 2.4 界面返工第二轮（2026-09-17，按用户反馈）

用户报告四件事，逐条落点如下（自证脚本见 §六）：

| 用户反馈 | 根因（实测） | 处置 |
|---|---|---|
| **卡在第三步，点不进下一阶段** | SH-04 右栏把两枚按钮放在**可滚动**容器里用 `marginTop:auto` 顶到底；视口高度 < ~950px 时（实测 **1366×768 / 1280×720**）按钮被挤出可视区 —— `getBoundingClientRect()` 仍返回坐标、`click-check` 的 `el.click()` 也仍能触发，但**真鼠标点在那个坐标上命中的是外层容器**，于是彻底卡死 | 右栏拆成「可滚动内容 + **钉在栏底的按钮区**」；按钮任何视口高度都在栏底。新增 `scripts\click-real.mjs`（**真鼠标** + 命中测试）把这一类问题钉死：修前 1280×720 只有 3/7，修后 **7/7** |
| **排版很奇怪** | ① `MapStage` 的开发自证信息条裸露在所有地图屏顶部；② 各屏把"数值出处/缺失原因"平铺在正文；③ 底部状态条压住内容区的下边缘（`复位视角` 中心点命中的是 `bottom-status`，42/60 屏次点不到） | ① 信息条只在 `?stage=map` 渲染；② 出处与回执收进**折叠块**；③ `AppShell` 的 `CONTENT_INSET` 下边界抬到状态条之上。新增 `scripts\layout-check.mjs`（多视口 × 20 屏，按"视口外 / 被裁切 / 命中测试 / 面板交叠"四条判据审计）：**修前 51 条（2 视口）→ 修后 13 条（3 视口，其中 12 条只是"面板内滚动 37–69px"）** |
| **左侧菜单栏连图标都没了** | 参考图（`场景1\T0-1.png`）与需求专篇 §3 都写着"左侧竖向 **7 项图标导航**"，上一版只渲染了文字 | 按参考图逐项补回图标（态势=准星环 / 任务=靶环 / 目标=取景框 / 区域=六边形 / 资源=节点图 / 告警=铃 / 设置=齿轮）；底部 6 段状态条同时改成图上那样的"图标 + 标签 + 值"小卡片 |
| **量算等功能没接进来、也用不了** | map-2d 里量算/手绘/图层面板**早就实现了**（`DrawLayer`、M2-DRAW-08 / M2-CTRL-10），但：① 宿主从没渲染 `<DrawLayer/>`；② 各屏工具栏是**只读 `<span>` 摆设**；③ 规则包 `map2dImplemented` 只列了 4 个工具，把 `measure/area/create/draw` 收敛成 `disabled`（VWC-TOOL-02） | ① `MapStage` 挂上 `<DrawLayer/>` 并开启指北针/比例尺（`showControls` 此前从未调用过）；② 新增 `apps/web/src/shell/MapTools.tsx` **唯一接线点**，7 个屏的摆设工具栏全部换成它（真能点，可用性照规则包）；③ `view-composer/policies/mapapp/layerMapping.json` 的 `map2dImplemented` 按模块实际能力订正。自证：新增 `scripts\measure-check.mjs` —— 真鼠标点【测距】→ 地图落两点 → 双击结束，**实测 6.16 km / 方位角 113.7°**，7/7 通过 |


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
node scripts\click-check.mjs http://127.0.0.1:8099/   # **手点通路（20 屏）**：只用界面按钮从 SH-01 点到 SH-18
                                                      #  32 条断言（含每步落屏与阶段 T0→…→T7）—— 实测 32/32
node scripts\click-real.mjs  http://127.0.0.1:8099/ 1280 720
node scripts\click-real.mjs  http://127.0.0.1:8099/ 1366 768
node scripts\click-real.mjs  http://127.0.0.1:8099/ 1920 1080
                                                      # **真鼠标手点通路**（CDP Input + elementFromPoint 命中测试）：
                                                      #  `click-check` 用 `el.click()`（JS 合成，绕过遮挡），
                                                      #  所以"脚本点得通、人点不通"它看不见 —— 这一条专门抓那个。
                                                      #  三种视口都必须 7/7
node scripts\layout-check.mjs http://127.0.0.1:8099/  # **排版与可点性审计**：3 视口 × 20 屏，
                                                      #  按"视口外 / 被裁切 / 命中测试 / 面板交叠"四条判据列问题
                                                      #  （可加 `--viewports 1536x1024,1366x768`、`--screens SH-03,SH-04` 缩小范围）
node scripts\measure-check.mjs http://127.0.0.1:8099/ 1536 1024 SH-03
                                                      # **量算真机自证**：真鼠标点【测距】→ 地图落两点 → 双击结束，
                                                      #  读 map-2d 的 `getMeasurement()`（长度 / 方位角），7/7
node scripts\screenshots.mjs http://127.0.0.1:8099/ --drive   # **20 屏截图**（1536×1024）→ docs/screens/screens/
node scripts\render-check-map.mjs                     # 前端自带受控 WS 服务端，只验渲染
pwsh -File scripts\acceptance.ps1                     # 结构守卫 + 构建 + 端点（含 BOM 校验）
```

> `acceptance.ps1` 会先按 **`-DMA_BUILD_SENSOR_MODEL=OFF`** 重新 configure —— 这是**负向验收**
> （证明"缺可选模块也装得起来、跑得起来"）；它在最后一步（**C5**）把默认配置装回来，所以跑完验收不会把你的演示构建弄成"缺模块"版。
> 想跳过整个构建段：`acceptance.ps1 -SkipBuild -SkipFrontend`（复用已有产物，只跑结构守卫与端点）。

**写新脚本请照抄这几条纪律**（都踩过）：断言里**打印实测原值**而不是"应为"；
**拿不到的数据一律留空 + 点名原因**，MUST NOT 编数值、MUST NOT 显示成 0；
WS 采集器**先建连接再发 HTTP**（Node 的 WebSocket 与 fetch 共用 dispatcher）且**自己发心跳保活**（hub 4.5 s 判死）；
截图前 `Emulation.setDeviceMetricsOverride(1280x800)`；
**CDP 的 page target 必须先 `Page.bringToFront`** —— 后台 tab 的 `requestAnimationFrame` 会被节流到几乎不触发，
而 MapLibre v4 的样式/数据源装载走的就是 rAF 调度，表现为"地图容器在、canvas 在，但 `getStyle().sources` 为空、
连一个地图事件都不发"（实测不加这一句约 3/4 概率复现）。本仓所有 CDP 脚本都已带上这一句。

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

先按 §1.4 的"停完之后怎么确认"两条查一遍；确实是残留进程才硬停：

```powershell
Get-NetTCPConnection -LocalPort 8099 -State Listen -ErrorAction SilentlyContinue   # 谁在监听
Get-Process mission_host | Stop-Process -Force     # 硬停（不 flush 留存层，万不得已）
```

> 换个端口再起也行：`demo.ps1 serve -Port 8100 -NoBuild`（记得 `stop` / `status` 也要带 `-Port 8100`）。

**9) 敲了 `serve` 却说"已经有实例在 … 上跑着"**
→ 那是**预期行为**（不会重复起第二个）。要么先 `stop`，要么就想跑两个实例：
`serve -Port 8100 -IngestPort 45501`（**必须错开 UDP 接入端口**，否则后起的那条 `packets=0`）。

**10) 改了界面但页面没变**
→ 前端产物没重建。`cd apps\web; npm run build`，然后**刷新页面**（`dist` 不入库，宿主托管的是它）。
对照检查：`dist\assets\*.js` 的修改时间应该**晚于** `apps\web\src` 里最新的文件。

**11) 敲 `demo.ps1` 报 `-File 形式参数的实际参数"scripts\demo.ps1"不存在`**
→ 你不在 `mission-app` 目录里。`demo.ps1` 在 **`mission-app\scripts\`** 下，
   而 `scripts\demo.ps1` 是**相对当前目录**解析的 —— 在 `D:\dsh_workpath\webMap` 下当然找不到。
   两个解法（都在 `webMap` 根目录下敲，实测可用）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File demo.ps1 stop          # ① 最短（转发器）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\demo.ps1 stop  # ② 同写法，少一层路径
```

   或者老老实实切目录（`cd D:\dsh_workpath\webMap\mission-app` 之后再 `-File scripts\demo.ps1 stop`），
   或者用**绝对路径**一把梭：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\dsh_workpath\webMap\mission-app\scripts\demo.ps1 stop
```

> 同一类问题的**其他脚本**也一样：`manual.ps1` / `acceptance.ps1` 都在 `mission-app\scripts\` 下；
> §六 里那些 `node scripts\xxx.mjs` 同理，**都要先 cd 到 `mission-app`**（`node` 不会自己找）。

**12) 新写/改过带中文的 `.ps1`，一跑就语法错、输出乱码**
→ 存成了**没有 BOM 的 UTF-8**，Windows PowerShell 5.1 会按 ANSI 读它。
   实测踩过：用编辑器"另存为 UTF-8（无 BOM）"或某些工具改写文件后，原本好好的脚本立刻
   `The string is missing the terminator` + 中文乱码。**带中文的 `.ps1` 必须存成 UTF-8 with BOM**：

```powershell
# PS 5.1 的 Set-Content -Encoding UTF8 会写 BOM；写完用这三字节确认（应为 239 187 191）
$b = [System.IO.File]::ReadAllBytes('scripts\demo.ps1')[0..2]; "$($b -join ' ')"
```

---

# 八、文档（读哪一份）

| 你想知道 | 读哪份 |
|---|---|
| **界面与流程到底要做成什么样**（界面照参考图做、流程照参考图走） | `docs\需求\宿主需求专篇.md`（DES-APP-001）：20 屏逐屏"照哪张图 / 图上有什么 / 点哪个按钮去哪一屏 / 怎么验收"，含**勘误登记**与**待裁决 12 条**；逐图抠屏证据在 `docs\需求\图片清单\` |
| **新会话从哪开始**（换会话/换人接手） | `docs\参考\新会话交接.md`：10 分钟跑起来 + 文档地图 + 现状数字 + 下一步（含待拍板三条）+ 纪律与坑 + 验收命令 |
| 这套工程怎么搭起来的、为什么这么切模块 | `docs\参考\业务层宿主层实施方案.md`（PLAN-APP-001，§10 裁决 A1–A17） |
| 命令面 / 事件名 / 屏幕与文件的归属 | `docs\参考\流程接口冻结.md` |
| 每个引擎的准确签名与接入待办 | `docs\参考\引擎集成接口地图.md` |
| 换台机器怎么从头跑起来、有哪些坑 | `docs\参考\交接文档.md` + `docs\参考\README.md`（阅读顺序） |
| 每个引擎自己的需求条目 | 各模块仓 `<模块>\docs\需求\<模块>需求专篇.md` |
| 一键演示手册（P7 期间的并行自证口径） | `docs\P7-一键演示.md` |

---

# 九、硬约定与已知边界

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
