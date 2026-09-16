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
#if MA_WITH_GEO
    std::shared_ptr<geo_data::NativeHostFs> geoFs;
    std::shared_ptr<geo_data::TileService> tileService;
    std::string tileNote;
#endif
#if MA_WITH_INGEST
    std::unique_ptr<device_ingest::Gateway> gateway;
    std::string gatewayNote;
#endif

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
