// mission-app · packages/host/src/engines.cc
//
// 装配 + 依赖注入 + 生命周期。**没有业务逻辑**。
#include "ma/engines.h"

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <vector>

#if MA_WITH_HUB
#include "realtime_hub/hub.h"
#endif
#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST
#include <exception>
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
    //
    // ★ 装配**不在这里**：瓦片包要从 `config.json` 的 `tiles` 段来，而构造函数拿不到配置。
    //   所以与 loadSimulation 同一条路 —— 配置由 main 递进来，见 configureTiles()。
    //   （本构造函数只保证"模块被链接、被实例化"这件事在编译期成立。）

    // ---------------------------------------------------------------- device-ingest
    // 只**构造**门面（不开线程、不绑端口）；真正 start() 由 main 在做完 WS 装配后调。
#if MA_WITH_INGEST
    gateway = std::make_unique<device_ingest::Gateway>();
    gatewayNote = "已构造（start() 由 main 在 WS 装配完成后调）";
#endif

#if MA_WITH_HUB
    {
        // 单例对象：构造不占资源、不开线程。只为证明"链接 + API 可用"。
        realtime_hub::RealtimeHub::instance().configure(realtime_hub::HubOptions{});
    }
#endif
}

#if MA_WITH_GEO
// ---------------------------------------------------------------- geo-data 装配
//
// 一件事：把 `config.json` 的 `tiles` 段翻译成 geo-data 的 `TileServiceConfig`，
// 让模块去装载包。**包能不能装载由模块判定**：装不上（缺清单/清单坏）不阻止服务创建，
// 包态与原因由 listPackages() 如实回给宿主，宿主只负责原样写进 tileNote（/stats 可见）。
void Engines::configureTiles(const HostConfig& cfg) {
    geoFs = std::make_shared<geo_data::NativeHostFs>();  // 读盘：模块自带的原生适配器

    geo_data::TileServiceConfig tc;
    tc.basePath = cfg.tilesBasePath.empty() ? "/tiles" : cfg.tilesBasePath;
    tc.missingStatus = cfg.tilesMissingStatus;
    if (!cfg.tilesSubDir.empty()) tc.tileSubDir = cfg.tilesSubDir;

    // 包：三项（pkgId / version / root）缺一即不挂 —— 服务照常创建，如实标注为未挂载。
    // 相对 root 走宿主的锚点规则（锚在配置文件旁边），与 dataDir/scenarioDir 同一口径。
    const std::string tileRoot = cfg.resolvePath(cfg.tilesRoot);
    if (!cfg.tilesPkgId.empty() && !cfg.tilesPkgVersion.empty() && !tileRoot.empty()) {
        geo_data::PackageConfig pkg;
        pkg.pkgId = cfg.tilesPkgId;
        pkg.version = cfg.tilesPkgVersion;
        pkg.tileRoot = tileRoot;
        pkg.external = false;  // 本地离线底图：不是外部托管内容（无需强署名）
        pkg.contractVersion = geo_data::kPackageContractVersion;
        tc.packages.push_back(std::move(pkg));
    }

    geo_data::TileServiceCtx ctx;
    ctx.fs = geoFs.get();
    ctx.clock = &geoClock;  // 时钟由宿主注入（模块 MUST NOT 回落系统时钟）

    const geo_data::CreateTileServiceResult created = geo_data::createTileService(tc, ctx);
    tileService = created.service;
    if (!tileService) {
        tileNote = "service=null（" + geo_data::joinIssues(created.issues) + "）";
        return;
    }
    if (tc.packages.empty()) {
        tileNote = "service=ready（未挂载瓦片包：config.json 的 tiles.packageId/version/root 为空）";
        return;
    }

    // 包态从模块查（宿主不自己判断目录/清单）：ready / not-ready / missing / invalid + 原因。
    std::string detail;
    for (const auto& p : tileService->listPackages()) {
        if (!detail.empty()) detail += "；";
        detail += p.pkgId + "-" + p.version + " state=" + geo_data::packageStateName(p.state);
        if (p.state == geo_data::PackageState::Ready) {
            detail += " z" + std::to_string(p.minZoom) + "-" + std::to_string(p.maxZoom) +
                      " 块数=" + std::to_string(p.total);
        } else if (!p.reasons.empty()) {
            detail += "（" + p.reasons.front().detail + "）";
        }
    }
    tileNote = "service=ready（已挂载瓦片包 " + detail + "）";
}
#endif

#if MA_WITH_STORE
telemetry_store::Status Engines::storeStatus() const {
    if (!store) return telemetry_store::Status{};
    return store->status();
}
#endif

#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST

bool Engines::loadSimulation(const std::string& dir, const std::string& kindName,
                             const std::string& wireType, const std::string& host, int port,
                             std::string& error) {
    scenarioDir = dir;
    ingestEndpoint = host + ":" + std::to_string(port);

    // 1) 本地配置 → 中立结构（校验失败时 error 里是逐条可读原因）
    ma::scenario::LoadReport loadReport;
    sim_source::SimScenario neutralScenario;
    if (!ma::scenario::loadScenario(dir, scenarioData, neutralScenario, loadReport)) {
        error = "本地配置装载失败（" + dir + "）：\n  " + loadReport.toText();
        simNote = "配置装载失败";
        return false;
    }

    // 2) 装配：引擎 + 出口 + 时钟（不外发时段用 dryRun）
    ma::sim_bridge::BridgeOptions opts;
    // ★ 默认事件 kind **由装配层显式注入**（引擎自己的中立占位是 sim.pos，这里必须覆盖）。
    opts.sim.defaultKind = kindName;
    opts.sim.useClockWhenTickArgMissing = false;  // 时间只由 tick(nowMs) 推进
    opts.wireType = wireType;
    opts.sink.host = host;
    opts.sink.port = port;
    opts.sink.dryRun = (port <= 0);

    ma::sim_bridge::BridgeReport bridgeReport;
    if (!ma::sim_bridge::build(neutralScenario, scenarioData, opts, bridge, bridgeReport)) {
        error = "仿真源装配失败：" + bridgeReport.toText();
        simNote = "装配失败";
        return false;
    }

    char buf[256];
    std::snprintf(buf, sizeof(buf), "平台 %d / 实体 %d / 区域 %d / 归属 %d 组；kind=%s",
                  static_cast<int>(neutralScenario.platforms.size()),
                  static_cast<int>(neutralScenario.platforms.size() +
                                   neutralScenario.targets.size()),
                  static_cast<int>(neutralScenario.areas.size()),
                  static_cast<int>(scenarioData.groupIds().size()), kindName.c_str());
    simNote = buf;
    return true;
}

nlohmann::json Engines::simStatsJson() const {
    nlohmann::ordered_json out;
    out["configDir"] = scenarioDir;
    out["wireType"] = scenarioData.wireType;
    out["groupIdMap"] = nlohmann::ordered_json::object();
    for (const auto& kv : scenarioData.groupIds()) out["groupIdMap"][kv.first] = kv.second;
    out["counts"] = nlohmann::ordered_json{
        {"platforms", scenarioData.aircraft.size()},
        {"groups", scenarioData.groupIds().size()},
        {"targets", scenarioData.targets.size()},
        {"deployAreas", scenarioData.deployAreas.size()},
        {"taskAreas", scenarioData.taskAreas.size()},
        {"hardNoFlyZones", scenarioData.hardNoFlyZones.size()},
    };
    if (bridge.engine) {
        const sim_source::Metrics m = bridge.engine->metrics();
        const sim_source::Capabilities cap = bridge.engine->capabilities();
        out["running"] = bridge.driver != nullptr && bridge.driver->running();
        out["paused"] = bridge.driver != nullptr && bridge.driver->paused();
        out["speedMultiplier"] = cap.speedMultiplier;
        out["simElapsedMs"] = m.simElapsedMs;
        out["ticks"] = m.ticks;
        out["steps"] = m.steps;
        out["eventsEmitted"] = m.eventsEmitted;
        out["pausedMs"] = m.pausedMs;
        out["plan"] = nlohmann::ordered_json{
            {"ok", bridge.plan.ok},
            {"platforms", bridge.plan.platformIds.size()},
            {"hardZones", bridge.plan.hardZones},
            {"softZones", bridge.plan.softZones},
            {"detoured", bridge.plan.detoured},
        };
    } else {
        out["running"] = false;
    }
    if (bridge.sink) {
        const ma::sim_bridge::UdpWireSinkStats s = bridge.sink->stats();
        out["wire"] = nlohmann::ordered_json{
            {"target", ingestEndpoint},
            {"events", s.events},
            {"frames", s.frames},
            {"sent", s.sent},
            {"errors", s.errors},
            {"oversize", s.oversize},
            {"sentBytes", s.sentBytes},
        };
    }
    out["note"] = simNote;
    return out;
}

nlohmann::json Engines::ingestStatsJson() const {
    nlohmann::ordered_json out;
#if MA_WITH_INGEST
    if (!gateway) {
        out["running"] = false;
        return out;
    }
    const device_ingest::GatewayStatus st = gateway->status();
    const device_ingest::GatewayHealth gh = gateway->gatewayHealth();
    std::uint64_t pointsRunning = 0;
    std::uint64_t packets = 0;
    std::uint64_t pointEvents = 0;
    nlohmann::ordered_json points = nlohmann::ordered_json::array();
    for (const auto& m : gateway->allPointMetrics()) {
        if (m.running) ++pointsRunning;
        packets += m.packets;
        pointEvents += m.events;
        points.push_back(nlohmann::ordered_json{
            {"id", m.id},
            {"running", m.running},
            {"port", 0},
            {"packets", m.packets},
            {"bytes", m.bytes},
            {"events", m.events},
            {"parseFailed", m.parseFailed},
            {"dropped", m.dropped},
            {"lastPeer", m.lastPeer},
            {"lastRecvAt", m.lastRecvAt},
            {"lastError", m.lastError},
        });
    }
    out["running"] = st.running;
    out["points"] = st.points;
    out["pointsRunning"] = pointsRunning;
    out["packets"] = packets;
    out["events"] = st.events;
    out["pointEvents"] = pointEvents;
    out["devices"] = st.devices;
    out["online"] = st.online;
    out["dropped"] = st.dropped;
    out["parseFailed"] = st.parseFailed;
    out["queueDepth"] = gh.queueDepth;
    out["queueDropped"] = gh.queueDropped;
    out["packetsPerSec"] = gh.packetsPerSec;
    out["hubEnabled"] = st.hubEnabled;
    out["pointDetail"] = std::move(points);
    out["note"] = gatewayNote;
#endif
    return out;
}

#endif  // MA_WITH_SIM_SOURCE && MA_WITH_INGEST

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
    {
        std::string note = gatewayNote;
#if MA_WITH_INGEST
        if (gateway) {
            const device_ingest::GatewayStatus st = gateway->status();
            note = std::string("points=") + std::to_string(st.points) + " running=" +
                   (st.running ? "1" : "0") + "；" + gatewayNote;
        }
#endif
        reg.set("ingest", MA_WITH_INGEST != 0, false, note.empty() ? "模块未装配" : note);
    }
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
                    "；ITransport=DrogonTransport（/ws）");
    }
#else
    reg.set("hub", false, false, "模块未装配");
#endif
    reg.set("tiles", MA_WITH_GEO != 0 && tileService != nullptr, tileService != nullptr,
            tileService ? tileNote : "模块未装配");

    // ---- 仿真链路：装配成功才算实例化
#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST
    reg.set("simSource", true, bridge.engine != nullptr,
            bridge.engine ? (simNote + "；出口 " + ingestEndpoint) : "装配失败（见启动日志）");
    {
        std::string note = "未装配";
#if MA_WITH_SENSOR_MODEL
        note = "已装配（本份配置未挂接探测模型）";
#endif
        reg.set("sensorModel", MA_WITH_SENSOR_MODEL != 0, false, note);
    }
#else
    reg.set("simSource", MA_WITH_SIM_SOURCE != 0, false,
            MA_WITH_SIM_SOURCE != 0 ? "已装配（未接通接入层）" : "模块尚未落地（CMake if(EXISTS) 跳过）");
    reg.set("sensorModel", MA_WITH_SENSOR_MODEL != 0, false,
            MA_WITH_SENSOR_MODEL != 0 ? "已装配" : "模块尚未落地（CMake if(EXISTS) 跳过）");
#endif
}

void Engines::flush() {
#if MA_WITH_STORE
    if (store) store->flush();  // 成功返回 = 缓冲已全部交付后端
#endif
}

void Engines::stop() {
    // 装配的逆序。模块对象析构即停（各模块自己的线程在析构里收）。
    //
    // ★ P1 新增的两条（必须先于一切析构，因为它们是**生产者**）：
    //   1) 节拍驱动：先停它 —— 否则引擎析构后驱动线程还会去 tick()。
    //   2) 接入层：再停它 —— 排空队列（最后一批事件仍会走 ISink → 广播）。
#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST
    if (bridge.driver) bridge.driver->stop();
    bridge.driver.reset();
    bridge.sink.reset();   // 出口在引擎之前放掉（引擎还持有 shared_ptr，不会悬空）
    bridge.engine.reset();
#endif
#if MA_WITH_INGEST
    if (gateway) {
        gateway->stop();
        gatewayRunning = false;
    }
#endif
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
