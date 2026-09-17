// mission-app · packages/host/include/ma/flow.h
//
// **流程装配层**：把 Excel 11 步的业务流程接到已装配的引擎上。
//
// ★ 纪律（本层的位置）：
//   · 引擎是机制：它不认识"启动加载""一键自检"这些词，只认识"探针/报告/进度源"；
//   · 规则包是业务：文案、分组、目标值、等级映射全在 `selfcheck/policies/mapapp/probes.json`；
//   · **本层只做两件事**：① 把宿主的**真实状态**翻译成引擎要的入参（能力快照）；
//     ② 把引擎的输出**原样**转成 HTTP/WS 负载。MUST NOT 在这里写任何业务判断
//     （不判等级、不算分数、不编百分比、不写文案）。
//
// 启动加载为什么不是假动画（G9）：
//   每一步进度都来自**真实条件**——模块探针求值（真实体检）、接入层是否真的在收包、
//   设备台账里是否真的有在线设备。宿主只决定"什么时候去问引擎"，不决定"显示几成"。
//   演示节拍（pacing）只影响**问的间隔**，不影响取值：把它设成 0 就是能跑多快跑多快。
//
// 对外面（前端只认这三个）：
//   GET  /api/state     流程状态 + 启动进度 + 自检结果（全部来自引擎负载）
//   POST /api/command   {verb, params} → {code, verb, data}
//   GET  /health        selfcheck 的 /health 负载（六字段冻结口径）
#pragma once

#include <atomic>
#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <nlohmann/json.hpp>

#include "ma/config.h"
#include "ma/engines.h"
#include "ma/registry.h"

#if MA_WITH_SELFCHECK
#include "selfcheck/selfcheck.h"
#endif
#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST && MA_WITH_SENSOR_MODEL
#include "ma/sensor_bridge.h"
#endif

namespace ma {

/// Excel 11 步（1-based）。`key` 是稳定标识（前端路由用它，不用中文标题）。
///
/// ★ 这里的字段都是 `std::string`（不是 `const char*` 常量表）：**11 步表来自
///   `config.json` 的 `flow.steps`**，源码里只留"只有 key/phase 的骨架"。
///   理由：步骤名 / 界面标题是**业务词汇** —— 客户改词不该重新编译宿主（见 config.h 同名注释）。
struct FlowStep {
    int step = 1;
    std::string key;
    std::string title;
    /// 该步对应的任务阶段（"" = 尚未进入任务）。阶段取值由 `phase-engine` 定义（T0–T7）。
    std::string phase;
};

/// 11 步表（**流程骨架 + 配置给的显示名**）。
/// 真正决定"能不能做某件事"的是各引擎的规则包；这里只是"第几步叫什么、绑哪个阶段"。
const std::vector<FlowStep>& flowSteps();
const FlowStep* flowStepOf(int step);
const FlowStep* flowStepByKey(const std::string& key);

/// 线上报文的**逐链路累加器**（步 6 的链路评估用）。
///
/// 只留宿主真的用得到的字段（不是把报文搬一遍）：谁发的、哪个编组、序号、到货时刻、字节数。
/// **按 deviceId 累加**（不是排队）：队列会在高峰期溢出，而"溢出丢帧"与"链路丢包"是
/// 两回事 —— 排队再丢会把宿主自己的缓冲溢出算成链路丢包（实测踩过：lossRate 0.49 全是假象）。
/// 累加器的内存只与设备数有关，没有上限问题。
struct WireAgg {
    std::string deviceType;  // type（机型键）
    std::string groupId;
    int64_t frames = 0;
    int64_t gaps = 0;        // 由 seq 连续性实测的断号数
    int64_t bytes = 0;
    int64_t firstMs = 0;     // 本窗口第一个报文的到货挂钟
    int64_t lastMs = 0;
    int64_t lastSeq = -1;
    int64_t simTs = 0;       // 最近一条的仿真时间戳（只作展示/排障）
};

class FlowEngine {
public:
    /// 广播一条 WS 事件：`(type, data)`。由 main 接到 hub 上（hub 自己打 ts、自己序列化信封）。
    using Broadcaster = std::function<void(const std::string& type, const nlohmann::json& data)>;
    /// 当前在线 WS 连接数（`/health` 的 wsClients 字段由宿主提供）。
    using ClientCounter = std::function<int()>;
    /// 能力快照的**真实来源**采集器：宿主各处状态 → `mapapp_probes::Capabilities` 的键值。
    using CapabilityProbe = std::function<nlohmann::json()>;

    FlowEngine(Engines& engines, Registry& reg, const HostConfig& cfg);
    ~FlowEngine();

    FlowEngine(const FlowEngine&) = delete;
    FlowEngine& operator=(const FlowEngine&) = delete;

    void setBroadcaster(Broadcaster b);
    void setClientCounter(ClientCounter c);
    /// 采集器由 main 提供（它知道接入层/瓦片/台账/存储的真实读数）；缺省时全部中性。
    void setCapabilityProbe(CapabilityProbe p);

    /// 装载 selfcheck 规则包与能力快照、注册探针包。读不到文件 → 如实记 note 并返回 false（不抛）。
    bool initSelfCheck();

    /// 重新采集能力并**重注册**探针（拔插能力后调它即可让自检反映现状）。
    void refreshCapabilities();

    /// GET /api/state
    nlohmann::json stateJson();

    /// GET /health（selfcheck 聚合；未装配 selfcheck 时回落最小合法负载）
    nlohmann::json healthJson();

    /// POST /api/command。返回 `{code, verb, data}` 或 `{code, verb, error}`（码表见 protocol §3）。
    nlohmann::json command(const std::string& verb, const nlohmann::json& params);

    /// 启动加载是否已全部就绪（= 引擎的 bootComplete）
    bool bootComplete();

    /// 装配摘要（日志与 /stats 用）
    std::string summary() const;

    // ========================================================================
    // 步 6–7（P4）新增的三条**非命令面**入口（线程与命令面不同，故单独说明）
    // ========================================================================

    /// 线上报文入口 —— **接入层线程**调用（IngestToHubSink 的一个旁路 tap）。
    ///
    /// 纪律：**只入队**。把报文喂给 topology.ingest 必须在命令线程里、在 `mtx_` 之下做 ——
    /// `topology` 全模块无锁（单线程假设），从接入层线程直接 ingest 就是数据竞争。
    /// 所以这里只把报文按"平台 → 次数/字节/序号连续性"记进一个有界队列，
    /// `topology.evaluate` 时再一次性排空（drain）后转换形状并投递。
    void onWireEvent(const std::string& type, const nlohmann::json& data, int64_t recvAtMs);

#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST && MA_WITH_SENSOR_MODEL
    /// 探测结果入口 —— **仿真驱动线程**调用（SensorBridge 的落账回调）。
    ///
    /// 这一条**不取 `mtx_`**（驱动线程持有 Driver::mtx_ 时回调进来，取命令锁会把
    /// tick 卡在业务命令后面），改用独立的 `detectMtx_` 保护"当前任务 + 已登记实体表"。
    /// 台账自身有可重入锁，写它是安全的；`dtx_` 只保护宿主自己的两样东西。
    void onDetection(const ma::sensor_bridge::Detection& d);
#endif

    /// 媒体通道清单（`/media/**` 的静态托管在 HostServer；本函数给的是**通道描述**）。
    /// `data.channels[] = {id,name,kind,url|frames,frameIntervalMs}`（形状与 §D.3 第 3 步一致）。
    /// 结果按 `refresh=true` 重算，否则用进程内缓存（前端 500 ms 轮询 /api/state 不该反复扫盘）。
    nlohmann::json mediaChannelsJson(bool refresh = false) const;

    /// 广播一次 `media.channels`（前端在步 7 挂载媒体面板时收到即可 setChannels）。
    void broadcastMediaChannels();

    /// 探测模型未装配/未启用时的如实说明（回执 notes 用）
    std::string sensorNote() const;

private:
#if MA_WITH_SELFCHECK
    /// 一次"全量自检"的结果快照（`/api/state` 与 `/health` 都读它）
    void storeReport(const selfcheck::Report& rep);
    /// 取最近一次报告（没有就跑一次；跑不动就返回空）
    const selfcheck::Report& report(bool runIfMissing);
    /// 跑一次自检（`onlyKeys` 为空 = 全部；`silent` 只影响是否发事件）
    selfcheck::Report runSelfCheck(bool bypassCache, const std::vector<std::string>& onlyKeys,
                                   bool silent);
    /// 把 Report 里的某一类项转成 JSON 数组
    static nlohmann::json itemsJson(const std::vector<selfcheck::ItemResult>& items);
#endif

    /// 流程自产物的一步显示文案：**词汇表在 config.json 的 `flow.labels`**（宿主源码里
    /// MUST NOT 留中文兜底 —— 配置缺这一条就回落成键名，界面上至少能认出是哪一段）。
    std::string labelOf(const std::string& key) const;

    /// 启动加载：逐模块把**真实就绪判定**上报给引擎的进度源。可在工作线程里跑。
    nlohmann::json bootRunOnce(int pacingMs);
    void startBoot(int pacingMs);

    /// 把流程状态（步 + 阶段）广播出去
    void broadcastFlowState();

    /// 当前阶段视图：**唯一的取法**是 phase-engine 的 `phaseContext(missionId)`（公开头 :594）；
    /// 引擎查不到时回落宿主流程层自己的记录（`fromEngine=false` 如实标出来）。要求已持 `mtx_`。
    struct PhaseView {
        std::string missionId;
        std::string phaseKey;
        int seq = 0;
        std::string scenarioKey;
        int64_t enteredAt = 0;
        bool fromEngine = false;
    };
    PhaseView phaseViewLocked() const;

    /// 复位任务与阶段（回第 1 步）。**要求已持 `mtx_`**。
    ///
    /// 为什么需要它：`flow.enter` 的阶段**以引擎台账为准**（不硬写 T0）—— 所以"重跑一遍"
    /// 不能只把 step 置 1，必须把当前任务清掉，让下一次 `flow.enter` 建**新任务**（新 missionId）。
    /// 台账与实体都按 missionId 隔离，因此新任务天然是干净的一份，旧任务数据保留（可追溯）。
    void resetMissionLocked();

    /// entity-ledger 台账的只读快照（喂给 view-composer 的 `entitySnapshot`；空台账 = 空对象）。
    /// 要求已持 `mtx_`。
    nlohmann::json ledgerSnapshotLocked() const;

    // ---- 步 6：仿真节拍控制（sim.* 的共用实现；调用方持 `mtx_`）----
    /// `sim.state` 事件负载（冻结形状 {running,speed,simElapsedMs,platforms,emitted} + 扩展读数）。
    nlohmann::json simStateJsonLocked() const;
    /// 广播 `sim.state`。
    void broadcastSimState();
    /// 流程进入步 6（任务执行）时**自动起飞**：调 Driver::primeNow + start。
    /// 返回回执片段（含"已自动起飞"的说明）；已 running → 幂等命中。
    nlohmann::json autoStartSimLocked();

    // ---- P7：一键串联（`sim.reset` / `flow.runAll`）----
    //
    // 两条贯穿这段代码的口径：
    //   ① **重置必须发生在引擎对象层**：只清计数器/只清任务不算重置（仿真本身回不到起点）。
    //      所以 `sim.reset` 走 `Engines::rebuildSimulation`（停旧驱动 → 重建引擎/出口/驱动
    //      → 重建探测适配器），宿主只负责"重建后把线接回去"（探测出口、累加器、倍速/运行态）。
    //   ② **串联不许抄近路**：`flow.runAll` 的每一步都调 `command(...)`（与前端/验收脚本**同
    //      一个入口**），MUST NOT 复制一份"更快的实现"绕开引擎。失败就停在那一步并如实报因。

    /// P7 `sim.reset`：把仿真源重建到初始状态（见 Engines::rebuildSimulation）。**要求已持 `mtx_`**；
    /// 回执 data 由它给出，`code` = 0 / 1005（失败时 data 里带现场读数，不假装重置成功）。
    nlohmann::json rebuildSimLocked(int& code);

    /// P7 `flow.runAll`：按 Excel 步序把 11 步一次跑完（每一步都走真实命令入口）。
    /// **不持 `mtx_`**（它逐个调 `command()`，由那些入口各自加锁）。
    /// 返回 `{prepare, steps[], speedDemos[], summary{ok,failedStep,totalMs,speed}, flow, notes}`。
    /// 并发保护：同一条流程上只允许一条串联（第二条回 1002 互斥冲突，见 runAll 里的 BusyGuard）。
    nlohmann::json runAll(const std::string& verb, const nlohmann::json& params);

    // ---- 步 7：探测 → 台账（探测线程写入，独立锁）----
    /// 目标身份表：实体 id → 机型键（`typeKey`，来自场景数据）。
    std::map<std::string, std::string> targetTypeKeysLocked() const;

    // ---- 步 6：链路评估（topology）----
    /// 组装拓扑（节点/边）并按场景数据投递；返回可读诊断。要求已持 `mtx_`。
    nlohmann::json ensureTopologyLocked();
    /// 把排空出来的线上报文折成 topology 的 ingest 形状（**形状转换**，不是判断）。
    nlohmann::json toTopologyEvents(const std::map<std::string, WireAgg>& agg,
                                    nlohmann::json& notes) const;

    // ---- 步 7：覆盖率 / 遍历周期（sensor-model 算，宿主只搬运）----
    /// `sensor.status` 的负载构造（也被 `targets.list` 复用为 data.coverage）。
    nlohmann::json sensorStatusLocked();

    // ---- 步 8–9（P5）：打击方案 / 引导方案 ----
    //
    // 两条贯穿这段代码的口径：
    //   ① **几何权威只有两处**：场景数据 `<scenarioDir>/strike-geometry.json`（IP 点/评估航线，
    //      按 §10.1-Q4 变体 A：规则包/引擎输出里只有 `attackStart.key` / `assessRoute.key` 两个
    //      **键引用**）与 entity-ledger 台账（已登记平台的**真实坐标**）。带不出出处的一律留空
    //      并在 `notes` 里点名，MUST NOT 造坐标（Q5：`stk-s2-*` 没有几何键，就如实标 resolved=false）。
    //   ② **时刻全部有算式**：`t0` 取 phase-engine 台账里当前阶段（T5）的 `enteredAt`；
    //      到达/打击/评估一律给 `basis{formula,inputs,source}`，由脚本独立复算（MUST NOT 编时刻）。

    /// 场景几何文件的只读快照（**进程内缓存一次**：几何在一次运行里不变）。
    /// 读不到 → `{loaded:false, note, attackStarts:[], assessRoutes:[]}`（**不抛**）。
    /// 要求已持 `mtx_`。
    const nlohmann::json& strikeGeometryLocked() const;

    /// 打击方案（`side:"strike"`）的几何标注：把候选模板的 `attackStart.key`/`assessRoute.key`
    /// 解析成场景几何的**原样条目**。没有键 / 键在几何里查不到 → `resolved=false` + `reason`
    /// （**只标注、不丢**：丢不丢由引擎的 `includeInapplicable` 决定）。要求已持 `mtx_`。
    nlohmann::json strikeGeometryOfLocked(const nlohmann::json& templateRaw) const;

    /// 从 scoring 的 `templatesPack().raw` 里取某个模板的**原样条目**（M5 的
    /// `coordination`/`coordinationLabel`/`plannedFinish`/`attackStart`/`assessRoute` 都在里面 ——
    /// 引擎没有 typed 字段，宿主也不从候选里"拼"这些字段）。取不到 → 空对象。
    /// 要求已持 `mtx_`。
    nlohmann::json templateRawOfLocked(const std::string& templateKey) const;

    /// 步 9：引导方案的组装（IP 点 + 评估航线 + 引导连线 + 时间轴四项）。
    /// 入参 `planId` 必须是**刚被采纳/确认**的那套打击方案（前置由本函数判，返 1003）。
    /// 所有几何来自 `strikeGeometryLocked()` 或台账；所有时刻都带 `basis`。要求已持 `mtx_`。
    nlohmann::json buildGuidancePlanLocked(const std::string& planId, const nlohmann::json& params,
                                           int& code);

    // ---- 步 10–11（P6）：协同执行与引导 / 任务总结报告 ----
    //
    // 三条贯穿这段代码的口径：
    //   ① **动作与状态一律由引擎裁决**：目标动作走 entity-ledger 的 `applyAction`（动作键与
    //      `requires` 取自规则包 `entityTypes.json` 的**生效内容**），状态推进走 `setDynamicState`
    //      （未声明的迁移引擎回 1003，宿主照实回执）。宿主只在**规则包声明的顺序**上补前置动作，
    //      MUST NOT 绕过引擎的 Gate（其它内建守卫与宿主闸门一概不代劳）。
    //   ② **命中判定必须由仿真读数派生**：`sim-source` 没有"命中"事件，宿主用 `SimSource::entities()`
    //      的**逐帧读数**（平台位置/高度/速度）与台账里目标的**权威位置**做三维最近接近判定，
    //      判据与输入全部进 `basis`（脚本可独立复算）。MUST NOT 写死"命中了"。
    //   ③ 拿不到的一律留空 + `notes` / `dataGaps` 点名（P3 起的纪律，继续遵守）。

    /// 步 10：按方案打击一个目标（目标动作 → 状态推进 → 仿真侧俯冲/命中派生 → 步 10）。
    /// **要求已持 `mtx_`**；返回 `data`（`code` 由引擎裁决原样带出）。
    nlohmann::json execRunLocked(const std::string& entityId, const nlohmann::json& params, int& code);

    /// 步 10：撤销一次执行（`undoAction` / `removeFromSequence` / `setDynamicState` 回退）。
    /// 能退到哪由引擎裁决 —— 退不动就**如实**回 1003 并把引擎的 `unmet[]` 原样带出。要求已持 `mtx_`。
    nlohmann::json execAbortLocked(const std::string& entityId, const nlohmann::json& params, int& code);

    /// 步 11：任务总结报告（report-engine `generate` + 时间轴 + 预警计数 + 台账汇总 + 留存层读数）。
    /// **要求已持 `mtx_`**。
    nlohmann::json buildReportLocked(const nlohmann::json& params, int& code);

    /// `phase::durations(missionId)` 的**原样**读数（`durationsRaw` = 引擎 JSON 的逐字字符串）。
    /// /api/state、`mission.timeline`、`report.generate` 三处共用它 → 三处逐字相等是构造保证。
    /// 要求已持 `mtx_`。
    nlohmann::json phaseDurationsLocked() const;

    /// report-engine 规则包路径（`<MA_WEBMAP_ROOT>/report-engine/policies/mapapp/reportFields.json`）。
    /// 读不到 → 空串（回执会如实点名，MUST NOT 用 `loadPoliciesFile` 那个恒失败的占位）。
    static std::string reportPoliciesPath();

    /// 一次 `exec.run` 的事实（`exec.abort` 与 `/api/state` 复用）。**只记引擎给过的东西**。
    struct ExecRecord {
        std::string entityId;
        std::string missionId;
        std::string planId;                     ///< 当时确认过的打击方案（IP 点几何的来源）
        std::string stateBefore;                ///< exec.run 前的台账状态（原样）
        std::string stateAfter;                 ///< exec.run 后的台账状态（原样）
        std::string hitPlatformId;              ///< 读数派生出来的命中平台（空 = 未派生到命中）
        std::vector<std::string> appliedActions;  ///< 执行成功的动作键（按序；撤销按逆序）
        bool followedSequence = false;          ///< 是否由宿主补过 `addToSequence`（`$in-sequence`）
        int64_t atMs = 0;
        bool aborted = false;
        nlohmann::json lastRun = nlohmann::json::object();   ///< exec.run 的原样回执
        nlohmann::json lastAbort = nlohmann::json::object(); ///< exec.abort 的原样回执
    };

    Engines& engines_;
    Registry& reg_;
    const HostConfig& cfg_;

    Broadcaster broadcast_;
    ClientCounter clients_;
    CapabilityProbe capabilityProbe_;

    /// 引擎不是线程安全的：命令面来自 Drogon 的多个 IO 线程，这里统一串行化。
    std::mutex mtx_;

    bool selfCheckReady_ = false;
    std::string selfCheckNote_;
    /// 11 步表的来源（`config.json flow.steps` 读到几条 / 还是回落了内置骨架）—— 给启动日志与 /stats。
    std::string flowStepsNote_;
#if MA_WITH_SELFCHECK
    std::shared_ptr<selfcheck::ISelfCheckSink> flowSink_;
    std::shared_ptr<selfcheck::IClock> flowClock_;
    selfcheck::Report lastReport_{};
    bool hasReport_ = false;
    nlohmann::json lastBoot_ = nlohmann::json::object();
#endif

    std::atomic<bool> bootRunning_{false};
    std::thread bootThread_;

    /// P7：`flow.runAll` 的并发闸门（前端连点两次"一键"就会撞上）。
    /// 两条串联交叉驱动同一条流程 → 步骤/阶段/方案指针互相踩 → 回执全是假的。所以第二条回 1002。
    std::atomic<bool> runAllBusy_{false};

    // ---- 流程状态 ----
    int step_ = 1;
    std::string phase_;   // "" = 未进入任务
    std::string missionId_;
    int64_t enteredAtMs_ = 0;
    /// **任务下达时刻**（flow.enter 建任务那一刻）—— 时间轴 t0 的锚点（§10.1-Q1 裁决）。
    /// 与 enteredAtMs_ 分开：后者是"当前阶段进入时刻"，每推进一个阶段都会变。
    int64_t missionStartMs_ = 0;
    /// 上次重采能力快照的时刻（`/api/state` 按 5 s 节流重采；见 flow.cc 的 stateJson 注释）
    int64_t lastCapabilityMs_ = 0;

    // ---- 步 3–5（P3）：编组三方案 → 确认 → 编成实体 ----
    //
    // 只存"引擎刚给过的原样结果"（推荐方案 id 与推荐百分比），用途有两个：
    //   ① `alloc.adopt` 的 deviated 标注（非推荐方案被采纳时由引擎标 deviated）；
    //   ② 幂等判断（同一方案重复采纳 → 引擎回 idempotent=true）。
    // ★ MUST NOT 在这里重算分数、补百分比：数值只有一个来源 = `ScoreResult`。
    bool hasPlanScore_ = false;
    std::string lastPlanRecommendation_;
    int lastPlanRecommendedPercent_ = 0;
    std::string adoptedPlanId_;
    std::string confirmedPlanId_;

    // ---- 步 6（P4）：仿真节拍 ----
    /// 自动起飞是否已经发生过（同一进程只自动起一次；手动 sim.start 不受它限制）
    bool simAutoStarted_ = false;

    // ---- 步 6（P4）：链路评估的线上报文累加器（**接入层线程写、命令线程排空**）----
    //
    // 口径：`onWireEvent` 只做"逐设备累加"（O(1)、无锁竞争以外的副作用），
    // `topology.evaluate` 时在 `mtx_` 之下**快照并清零**（delta 语义 = 上次评估以来的窗口）。
    std::mutex wireMtx_;
    std::map<std::string, WireAgg> wireAgg_;
    int64_t wireTotal_ = 0;      // 累计收到的帧数（含不属于任何链路的）
    int64_t wireUnmapped_ = 0;   // 收到了、但对不上任何链路的帧数（如非平台设备）
    int64_t wireWindows_ = 0;    // 已经排空过的窗口数

    /// 拓扑装配状态：`topologyReady_` = 已经 configureTopology + 灌过节点/边
    /// （**只装配一次**：`configureTopology(reset=true)` 会清掉链路样本与状态）。
    bool topologyReady_ = false;
    std::string topologyMissionId_;
    /// linkId → 该链路的对端节点（= 所属编组节点）。用于把线上报文折成 ingest 事件。
    std::map<std::string, std::string> topologyLinkTo_;
    int64_t topologyIngests_ = 0;
    int64_t topologyLinkSamples_ = 0;

    // ---- 步 7（P4）：探测 → 台账（**驱动线程**，独立锁）----
    std::mutex detectMtx_;    /// 当前任务（探测结果要按 missionId 落账；未进任务 → 无处可落，如实丢弃并计数）
    std::string detectMissionId_;
    /// 目标 id → 实体 id（宿主自己的判重表；**引擎仍是台账的唯一权威**）
    std::map<std::string, std::string> detectEntityOf_;
    int64_t detectRegistered_ = 0;   // 新建实体次数
    int64_t detectMerged_ = 0;       // 引擎判重归并（obsKey 命中）
    int64_t detectRebound_ = 0;      // 引擎新建了重复实体 → 用 mergeEntities 并回主实体
    int64_t detectFailed_ = 0;       // 引擎拒绝（code!=0）
    int64_t detectNoMission_ = 0;    // 还没进任务就收到探测结果
    int64_t detectSourceFallback_ = 0;  // 观测来源键不被规则包认识 → 回落规则包默认源
    std::string detectLastError_;
    nlohmann::json detectLast_ = nlohmann::json::object();  // 最近一条落账事实（自证要打印它）

    // ---- 步 7（P4）：媒体通道清单的进程内缓存（素材在一次运行里不会变）----
    mutable std::mutex mediaMtx_;
    mutable nlohmann::json mediaCache_ = nlohmann::json::object();
    mutable bool mediaCached_ = false;

    // ---- 步 8–9（P5）：打击方案状态 + 场景几何缓存 ----
    //
    // `strikePlanScore_` 存的是**引擎刚给过的原样结果**（推荐 id / 推荐百分比），用途与
    // `lastPlanRecommendation_` 一模一样（`strike.adopt` 的 deviated 标注 + 幂等判断）。
    // ★ MUST NOT 在这里重算分数（数值只有一个来源 = `ScoreResult`）。
    bool hasStrikeScore_ = false;
    std::string lastStrikeRecommendation_;
    int lastStrikeRecommendedPercent_ = 0;
    std::string adoptedStrikePlanId_;
    std::string confirmedStrikePlanId_;
    /// 最近一次 `strike.plans` 的**原样**负载（`/api/state` 也给一份，前端刚挂载时不必等命令）
    nlohmann::json lastStrikePlans_ = nlohmann::json::object();
    /// 最近一次 `guidance.plan` 的时间轴（步 9 屏幕上要显示，`/api/state` 复用）
    nlohmann::json lastGuidance_ = nlohmann::json::object();
    /// 步 9 的显示模式覆盖结果（`view.mode` 的引擎回执原样；未覆盖 = 空）
    nlohmann::json strikeModeOverride_ = nlohmann::json::object();

    /// 场景几何缓存（`<scenarioDir>/strike-geometry.json`；一次运行读一次）
    mutable nlohmann::json strikeGeometry_ = nlohmann::json::object();
    mutable bool strikeGeometryLoaded_ = false;

    /// 已登记平台：deviceId → entityId（`alloc.assign` 登记成功时逐台记下）。
    /// 用途只有一个：步 9 的引导连线要取**台账里那台平台**的坐标（引擎仍是台账的唯一权威），
    /// 而不是让宿主从 deployment.json 另取一份（那样"台账里的位置"永远进不了界面）。
    std::map<std::string, std::string> entityIdOfDevice_;

    // ---- 步 10–11（P6）：执行记录 + 最近一次报告回执 ----
    /// 逐实体的执行事实（键 = entityId）。`exec.abort` 靠它知道"该撤哪些动作、退回哪个状态"。
    std::map<std::string, ExecRecord> execRecords_;
    /// 仿真侧俯冲剖面的施加次数与最近一次的说明（重复 `exec.run` 不重复改场景）。
    int execDiveCount_ = 0;
    /// 最近一次 `report.generate` 的**原样**回执（`/api/state` 给前端挂载时用，不重算）。
    nlohmann::json lastReportRun_ = nlohmann::json::object();
    /// 最近一次 `phase::durations()` 的逐字字符串（`/api/state` 与 `mission.timeline` 共用）
    mutable std::string phaseDurationsRaw_;
    mutable int64_t phaseDurationsAt_ = 0;
};

}  // namespace ma
