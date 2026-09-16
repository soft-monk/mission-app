// mission-app · packages/host/src/engines.cc
//
// 装配 + 依赖注入 + 生命周期。**没有业务逻辑**。
#include "ma/engines.h"

#include <filesystem>
#include <fstream>
#include <sstream>
#include <vector>

#if MA_WITH_HUB
#include "realtime_hub/hub.h"
#endif
#if MA_WITH_PROBES_MAPAPP
// 探针包是规则侧产物 probes_mapapp 的公开头（它的 PUBLIC include 目录是 selfcheck/probes）。#include "mapapp/probe_pack.h"
#endif

namespace ma {

namespace fs = std::filesystem;

namespace {
std::int64_t wallClockMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}
}  // namespace

bool readTextFile(const std::string& path, std::string& out) {
    std::ifstream in(path, std::ios::binary);
    if (!in) return false;
    std::ostringstream buf;
    buf << in.rdbuf();
    out = buf.str();
    return true;
}

Engines::Engines() {
    const std::int64_t now = wallClockMs();
    fixedClock = FixedClock(now);  // 确定性时钟：证明"时钟可注入"，而不是回落各模块 SystemClock

    phaseSink = std::make_shared<PhaseSink>(&meters[0]);
    resourceSink = std::make_shared<ResourceSink>(&meters[1]);
    planSink = std::make_shared<PlanSink>(&meters[2]);
    entitySink = std::make_shared<EntitySink>(&meters[3]);
    topologySink = std::make_shared<TopologySink>(&meters[4]);
    alertSink = std::make_shared<AlertSink>(&meters[5]);
    reportSink = std::make_shared<ReportSink>(&meters[6]);
    selfCheckSink = std::make_shared<SelfCheckSink>(&meters[7]);

    phaseStore = std::make_shared<PhaseStore>();
    resourceStore = std::make_shared<ResourceStore>();
    planStore = std::make_shared<PlanStore>();
    entityStore = std::make_shared<EntityStore>();
    topologyStore = std::make_shared<TopologyStore>();
    alertStore = std::make_shared<AlertStore>();
    layoutProvider = std::make_shared<NullLayoutProvider>();

    // ---------------------------------------------------------------- 留存
#if MA_WITH_STORE
    {
        telemetry_store::StoreOptions opt;
        opt.flush.maxRecords = 1000;
        opt.flush.maxDelayMs = 200;
        opt.bufferCapacity = 65536;
        opt.enableSweeper = true;
        // 后端/时钟/策略：内存后端 + 宿主时钟（注入路径通）；生产换段文件后端即可。
        store = std::make_unique<telemetry_store::Store>(
            opt, memoryBackend, storeClock, keepForever, nullptr);
    }
#endif

    // ---------------------------------------------------------------- 引擎（顺序 = 装配顺序）
#if MA_WITH_PHASE
    {
        phase::PhaseEngineOptions opt;
        opt.store = phaseStore;
        opt.clock = std::make_shared<FixedClock>(now);
        opt.sink = phaseSink;
        phase = std::make_unique<phase::PhaseEngine>(opt);
    }
#endif

#if MA_WITH_RESOURCE
    {
        resource_alloc::ResourceEngineOptions opt;
        opt.store = resourceStore;
        opt.clock = std::make_shared<FixedClock>(now);
        opt.sink = resourceSink;
        resource = std::make_unique<resource_alloc::ResourceEngine>(opt);
    }
#endif

#if MA_WITH_SCORING
    {
        scoring::ScoringEngineOptions opt;
        opt.store = planStore;
        opt.sink = planSink;
        opt.clock = std::make_shared<FixedClock>(now);
        scoringEngine = std::make_unique<scoring::ScoringEngine>(opt);
    }
#endif

#if MA_WITH_LEDGER
    {
        entity_ledger::EntityLedgerOptions opt;
        opt.store = entityStore;
        opt.clock = std::make_shared<FixedClock>(now);
        opt.sink = entitySink;
        entityLedger = std::make_unique<entity_ledger::EntityLedger>(opt);
    }
#endif

#if MA_WITH_TOPOLOGY
    {
        topology::TopologyEngineOptions opt;
        opt.store = topologyStore;
        opt.clock = std::make_shared<FixedClock>(now);
        opt.sink = topologySink;
        opt.layout = layoutProvider;
        topologyEngine = std::make_unique<topology::TopologyEngine>(opt);
    }
#endif

#if MA_WITH_ALERT
    {
        alert_engine::AlertEngineOptions opt;
        opt.store = alertStore;
        opt.clock = std::make_shared<FixedClock>(now);
        opt.sink = alertSink;
        alertEngine = std::make_unique<alert_engine::AlertEngine>(opt);
    }
#endif

#if MA_WITH_REPORT
    {
        report_engine::GenerateOptions opt;
        opt.clock = std::make_shared<FixedClock>(now);
        opt.sink = reportSink;
        reportEngine = std::make_unique<report_engine::ReportEngine>(opt);
    }
#endif

#if MA_WITH_SELFCHECK
    {
        selfcheck::SelfCheckOptions opt;
        opt.clock = std::make_shared<FixedClock>(now);
        opt.sink = selfCheckSink;
        selfCheckEngine = std::make_unique<selfcheck::SelfCheckEngine>(opt);
    }
#endif

    // ---------------------------------------------------------------- geo-data（托管瓦片）
#if MA_WITH_GEO
    {
        geoFs = std::make_shared<geo_data::NativeHostFs>();
        geo_data::TileServiceConfig cfg;
        cfg.basePath = "/tiles";
        cfg.missingStatus = 404;
        geo_data::TileServiceCtx ctx;
        ctx.fs = geoFs.get();
        ctx.clock = &geoClock;
        auto created = geo_data::createTileService(cfg, ctx);
        tileService = created.service;
        tileNote = tileService ? "service=ready（未挂载瓦片包）"
                               : "service=null（" + geo_data::joinIssues(created.issues) + "）";
    }
#endif

    // ---------------------------------------------------------------- device-ingest（已链接，未实例化）
#if MA_WITH_INGEST
    gatewayNote = "linked-only（需要接入点配置与真实 endpoints，接入是后续分期的事）";
#endif

#if MA_WITH_HUB
    {
        // 单例对象：构造不占资源、不开线程。只为证明"链接 + API 可用"。
        realtime_hub::RealtimeHub::instance().configure(realtime_hub::HubOptions{});
    }
#endif
}

#if MA_WITH_STORE
telemetry_store::Status Engines::storeStatus() const {
    if (!store) return telemetry_store::Status{};
    return store->status();
}
#endif

void Engines::report(Registry& reg) const {
    reg.set("phase", MA_WITH_PHASE != 0 && phase != nullptr, phase != nullptr,
            phase ? "options: store+clock+sink 注入" : "模块未装配");
    reg.set("resource", MA_WITH_RESOURCE != 0 && resource != nullptr, resource != nullptr,
            resource ? "options: store+clock+sink 注入" : "模块未装配");
    reg.set("scoring", MA_WITH_SCORING != 0 && scoringEngine != nullptr, scoringEngine != nullptr,
            scoringEngine ? "options: store+sink+clock 注入" : "模块未装配");
    reg.set("ledger", MA_WITH_LEDGER != 0 && entityLedger != nullptr, entityLedger != nullptr,
            entityLedger ? "options: store+clock+sink 注入" : "模块未装配");
    reg.set("topology", MA_WITH_TOPOLOGY != 0 && topologyEngine != nullptr,
            topologyEngine != nullptr,
            topologyEngine ? "options: store+clock+sink+layout 注入" : "模块未装配");
    reg.set("alert", MA_WITH_ALERT != 0 && alertEngine != nullptr, alertEngine != nullptr,
            alertEngine ? "options: store+clock+sink 注入" : "模块未装配");
    reg.set("report", MA_WITH_REPORT != 0 && reportEngine != nullptr, reportEngine != nullptr,
            reportEngine ? "options: clock+sink 注入" : "模块未装配");
    reg.set("selfcheck", MA_WITH_SELFCHECK != 0 && selfCheckEngine != nullptr,
            selfCheckEngine != nullptr,
            selfCheckEngine ? "options: clock+sink 注入" : "模块未装配");

    // ---- 已链接但未实例化（装配骨架分期如实上报）
    reg.set("ingest", MA_WITH_INGEST != 0, false, gatewayNote.empty() ? "模块未装配" : gatewayNote);
    reg.set("store", MA_WITH_STORE != 0 && store != nullptr, store != nullptr,
            store ? std::string("backend=") + store->backendName() +
                        "；退出时 flush()"
                  : "模块未装配");
#if MA_WITH_HUB
    {
        // 顺带报一个 hub 的真实读数：证明单例真的在（不是"只链接没接上"）。
        const std::size_t clients = realtime_hub::RealtimeHub::instance().clientCount();
        reg.set("hub", true, true,
                std::string("singleton + version()=") + realtime_hub::RealtimeHub::version() +
                    " clients=" + std::to_string(clients) +
                    "；广播腿留待 P1（需要 ITransport 适配器）");
    }
#else
    reg.set("hub", false, false, "模块未装配");
#endif
    reg.set("tiles", MA_WITH_GEO != 0 && tileService != nullptr, tileService != nullptr,
            tileService ? tileNote : "模块未装配");

    // ---- sim-source / sensor-model：条件包含，落地前不存在
    reg.set("simSource", MA_WITH_SIM_SOURCE != 0, false,
            MA_WITH_SIM_SOURCE != 0 ? "已装配" : "模块尚未落地（CMake if(EXISTS) 跳过）");
    reg.set("sensorModel", MA_WITH_SENSOR_MODEL != 0, false,
            MA_WITH_SENSOR_MODEL != 0 ? "已装配" : "模块尚未落地（CMake if(EXISTS) 跳过）");
}

void Engines::flush() {
#if MA_WITH_STORE
    if (store) store->flush();  // 成功返回 = 缓冲已全部交付后端
#endif
}

void Engines::stop() {
    // 装配的逆序。模块对象析构即停（各模块自己的线程在析构里收）。
#if MA_WITH_SELFCHECK
    selfCheckEngine.reset();
#endif
#if MA_WITH_REPORT
    reportEngine.reset();
#endif
#if MA_WITH_ALERT
    alertEngine.reset();
#endif
#if MA_WITH_TOPOLOGY
    topologyEngine.reset();
#endif
#if MA_WITH_LEDGER
    entityLedger.reset();
#endif
#if MA_WITH_SCORING
    scoringEngine.reset();
#endif
#if MA_WITH_RESOURCE
    resource.reset();
#endif
#if MA_WITH_PHASE
    phase.reset();
#endif
#if MA_WITH_STORE
    store.reset();
#endif
}

}  // namespace ma
