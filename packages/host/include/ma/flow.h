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
struct FlowStep {
    int step = 1;
    const char* key = "";
    const char* title = "";
    /// 该步对应的任务阶段（"" = 尚未进入任务）。阶段取值由 `phase-engine` 定义（T0–T7）。
    const char* phase = "";
};

/// 11 步表。**这是流程骨架，不是业务内容**：标题只用于界面回执与日志；
/// 真正决定"能不能做某件事"的是各引擎的规则包。
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
#if MA_WITH_SELFCHECK
    std::shared_ptr<selfcheck::ISelfCheckSink> flowSink_;
    std::shared_ptr<selfcheck::IClock> flowClock_;
    selfcheck::Report lastReport_{};
    bool hasReport_ = false;
    nlohmann::json lastBoot_ = nlohmann::json::object();
#endif

    std::atomic<bool> bootRunning_{false};
    std::thread bootThread_;

    // ---- 流程状态 ----
    int step_ = 1;
    std::string phase_;   // "" = 未进入任务
    std::string missionId_;
    int64_t enteredAtMs_ = 0;
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
};

}  // namespace ma
