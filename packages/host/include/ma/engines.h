// mission-app · packages/host/include/ma/engines.h
//
// 装配好的引擎集合 = "14 个既有模块能被装到一起、能编译、能链接、能实例化" 的**物证**。
//
// ★ 纪律：这里只有对象的构造与依赖注入，没有任何业务判断
//   （没有业务规则、没有评分算法、没有告警规则、没有 SQL）。
//
// 每个成员都由 CMake 传进来的 MA_WITH_* 宏守着：模块不在 → 成员根本不存在，
// 所以"没装某个模块"是**编译期事实**，不需要运行期兜底分支。
#pragma once

#include <chrono>
#include <cstdint>
#include <memory>
#include <string>

#include <nlohmann/json.hpp>

#include "ma/adapters.h"
#include "ma/config.h"
#include "ma/registry.h"

#if MA_WITH_PHASE
#include "phase/phase_engine.h"
#endif
#if MA_WITH_RESOURCE
#include "resource_alloc/resource_alloc.h"
#endif
#if MA_WITH_SCORING
#include "scoring/scoring.h"
#endif
#if MA_WITH_LEDGER
#include "entity_ledger/entity_ledger.h"
#endif
#if MA_WITH_TOPOLOGY
#include "topology/topology_engine.h"
#endif
#if MA_WITH_ALERT
#include "alert_engine/alert_engine.h"
#endif
#if MA_WITH_REPORT
#include "report_engine/report_engine.h"
#endif
#if MA_WITH_SELFCHECK
#include "selfcheck/selfcheck.h"
#endif
#if MA_WITH_VIEW_COMPOSER
#include "view_composer/view_composer.h"
#endif
#if MA_WITH_GEO
#include "geo_data/clock.h"
#include "geo_data/fs.h"
#include "geo_data/server/service.h"
#endif
#if MA_WITH_INGEST
#include "device_ingest/gateway.h"
#endif
#if MA_WITH_STORE
#include "telemetry_store/backends/memory_backend.h"
#include "telemetry_store/policy.h"
#include "telemetry_store/store.h"
#endif
#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST
#include "ma/scenario/scenario_dataset.h"
#include "ma/sim_bridge/sim_bridge.h"
#endif
#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST && MA_WITH_SENSOR_MODEL
#include "ma/sensor_bridge.h"
#endif
#ifndef MA_WITH_SIM_SOURCE
#define MA_WITH_SIM_SOURCE 0
#endif
#ifndef MA_WITH_INGEST
#define MA_WITH_INGEST 0
#endif

namespace ma {

/// 进程内被**实例化**的引擎集合。
struct Engines {
    Engines();

    // ---- 注入物（各模块反向接口的最小实现；见 adapters.h） ----
    FixedClock fixedClock{0};
    GeoClock geoClock;
    StoreClock storeClock;

    InvocationMeter meters[9];
    InjectionEvidence evidence;

    // 注入实现（shared_ptr：模块侧按值持有）
    std::shared_ptr<PhaseSink> phaseSink;
    std::shared_ptr<ResourceSink> resourceSink;
    std::shared_ptr<PlanSink> planSink;
    std::shared_ptr<EntitySink> entitySink;
    std::shared_ptr<TopologySink> topologySink;
    std::shared_ptr<AlertSink> alertSink;
    std::shared_ptr<ReportSink> reportSink;
    std::shared_ptr<SelfCheckSink> selfCheckSink;

    std::shared_ptr<PhaseStore> phaseStore;
    std::shared_ptr<ResourceStore> resourceStore;
    std::shared_ptr<PlanStore> planStore;
    std::shared_ptr<EntityStore> entityStore;
    std::shared_ptr<TopologyStore> topologyStore;
    std::shared_ptr<AlertStore> alertStore;
    std::shared_ptr<NullLayoutProvider> layoutProvider;

#if MA_WITH_STORE
    // 后端 / 保留策略用模块自带的实现（生产换段文件后端即可，宿主侧零改动）；
    // 时钟用宿主自己的（证明 IClock 注入路径通）。
    telemetry_store::MemoryBackend memoryBackend{0};
    telemetry_store::KeepForeverPolicy keepForever;
    std::unique_ptr<telemetry_store::Store> store;
    telemetry_store::Status storeStatus() const;
#endif
#if MA_WITH_PHASE
    std::unique_ptr<phase::PhaseEngine> phase;
#endif
#if MA_WITH_RESOURCE
    std::unique_ptr<resource_alloc::ResourceEngine> resource;
#endif
#if MA_WITH_SCORING
    std::unique_ptr<scoring::ScoringEngine> scoringEngine;
#endif
#if MA_WITH_LEDGER
    std::unique_ptr<entity_ledger::EntityLedger> entityLedger;
#endif
#if MA_WITH_TOPOLOGY
    std::unique_ptr<topology::TopologyEngine> topologyEngine;
#endif
#if MA_WITH_ALERT
    std::unique_ptr<alert_engine::AlertEngine> alertEngine;
#endif
#if MA_WITH_REPORT
    std::unique_ptr<report_engine::ReportEngine> reportEngine;
#endif
#if MA_WITH_SELFCHECK
    std::unique_ptr<selfcheck::SelfCheckEngine> selfCheckEngine;
#endif
#if MA_WITH_VIEW_COMPOSER
    /// 态势组图引擎（VWC）：规则包由 `policies_loader` 统一装载（`view-composer/policies/mapapp`），
    /// 装配期只构造（见 engines.cc 的注释：装载只有一处，MUST NOT 两处各装一遍）。
    std::unique_ptr<view_composer::ViewComposer> viewComposer;
#endif
#if MA_WITH_GEO
    std::shared_ptr<geo_data::NativeHostFs> geoFs;
    std::shared_ptr<geo_data::TileService> tileService;
    std::string tileNote;

    /// geo-data 瓦片服务：按 `config.json` 的 `tiles` 段装配（把包挂进 `cfg.packages`）。
    ///
    /// 与 `loadSimulation` 同一条纪律：**配置从外面递进来** —— Engines 自己不读文件。
    /// 由 main 在装配期调用（在 `report()` 之前，/stats 才拿得到真实包态）。
    /// 相对路径按宿主的锚点规则解析（`HostConfig::resolvePath`：锚在配置文件旁边）。
    void configureTiles(const HostConfig& cfg);
#endif
#if MA_WITH_INGEST
    std::unique_ptr<device_ingest::Gateway> gateway;
    std::string gatewayNote;
    /// 接入层是否真的 start() 了（false = 只链接、或起不来）。
    bool gatewayRunning = false;
#endif

#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST
    // ---------------------------------------------------------------- 仿真源
    //
    // 装配顺序就是数据流向：本地配置 → 中立结构 → 引擎 → 一行报文 → 接入层 → 广播。
    ma::scenario::ScenarioData scenarioData;
    ma::sim_bridge::Bridge bridge;
    std::string simNote;
    /// 配置目录（默认 <dataDir>/scenario-1）。
    std::string scenarioDir;
    /// 线格式那一端（接入点）的落点，日志与 /stats 都要报。
    std::string ingestEndpoint;

    /// 读本地配置并装配仿真源。**不启动节拍**（radar 由 main 按参数决定起不起）。
    bool loadSimulation(const std::string& dir, const std::string& kindName,
                        const std::string& wireType, const std::string& host, int port,
                        std::string& error);

    /// 仿真 + 接入的读数（/stats 里那两行）。
    nlohmann::json simStatsJson() const;
    nlohmann::json ingestStatsJson() const;
#endif

#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST && MA_WITH_SENSOR_MODEL
    // ---------------------------------------------------------------- 传感器探测模型
    //
    // 链路的形状（两侧刻意不互相 include，中间这本映射只能由宿主写）：
    //   sim-source ──SensorPose──▶ SensorBridge（sim_source::ISensorModel）
    //                              └─▶ sensor_model::SimplifiedSensorModel::sense()
    //   sim-source ◀─SimObservation─┘        （只有 visible=true 的才回得去）
    //
    // `sensorBridge` 由 `loadSimulation` 装配（它才知道场景目录与场景中心）：
    //   ① 读 `<scenarioDir>/sensors.json` → SpecTable（SensorSpec 的唯一来源）
    //   ② setSensorModel + setSensorAttachments（**在 init() 之后立即调**：引擎的
    //      setSensorAttachments 内部会 applyAttachments()，覆盖式生效）
    std::shared_ptr<ma::sensor_bridge::SensorBridge> sensorBridge;
    /// 真的挂上去的挂接清单（/stats 与 sensor.status 都要看它，不是"配了没有"）
    std::vector<sim_source::SensorAttachment> sensorAttachments;
    std::string sensorNote;

    /// 装配探测模型：读 `<dir>/sensors.json` → 建 SensorBridge → 注入引擎并挂接。
    ///
    /// 返回 false 时 `sensorNote` 给出可读原因（**不阻止仿真链路装配**：探测是第 7 步
    /// 的能力，缺了它前面的步骤照样跑 —— 但账本与 /stats 会如实写成未装配）。
    bool attachSensorModel(const std::string& dir, const sim_source::SimScenario& neutral,
                           std::string& error);
#endif

#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST
    // ---------------------------------------------------------------- P7：仿真源重建
    //
    // 为什么需要它（实测）：`mission.reset` / `boot.reset` 只清**任务与阶段**，仿真本身回不到
    // 起点 —— 平台已经飞完、已经 `arrived`、甚至已经被 `exec.run` 改过高度/速度档（俯冲剖面）。
    // 没有这条入口，"不重启进程再跑一遍"就只能跑一个**接着上一轮**的仿真（看起来重置了，
    // 其实没有）。所以重建必须发生在**引擎对象层**，而不是靠清计数器糊过去。
    //
    /// 把仿真源重建到**刚装配好的状态**（`sim.reset` 的实现）。四件事，顺序不能换：
    ///   ① **先停旧驱动**（`Driver::stop()` 会 join 驱动线程）—— 替换期间绝不允许还有一条
    ///      线程在 `tick()` 即将析构的引擎（sim-source 是单写者假设，模块无锁）；
    ///   ② 走**装配期同一条路**重新装载：`loadScenario`（重读本地配置）→ `sim_bridge::build`
    ///      （新建 SimSource + Driver + UdpWireSink）→ `attachSensorModel`（重建规格表与挂接）；
    ///   ③ **接入点与出口目标原样**（host/port 不变）→ device-ingest / hub 侧零改动；
    ///   ④ 不自动起飞、不自动设倍速（调用方按重建前的读数恢复；见 FlowEngine::rebuildSimLocked）。
    ///
    /// 失败 → false 且 `error` 给出可读原因；此时 `sim_bridge::build` 已先 `out = Bridge{}`
    /// （`bridge.engine == nullptr`），调用方 MUST 如实回 1005 + 现场读数，**不许假装重置成功**。
    bool rebuildSimulation(const std::string& kindName, const std::string& wireType,
                           const std::string& host, int port, std::string& error);
#endif  // MA_WITH_SIM_SOURCE && MA_WITH_INGEST

    /// 把就绪状态写进账本（顺序 = 装配顺序）。
    void report(Registry& reg) const;

    /// 退出序列第 1 步：先 flush（成功返回）—— 见 main.cc 的注释。
    void flush();

    /// 退出序列第 2 步：按**装配的逆序**停模块。
    void stop();
};

/// 读一个文本文件（selfcheck 规则包等）。不存在 / 读不到 → false。
bool readTextFile(const std::string& path, std::string& out);

}  // namespace ma
