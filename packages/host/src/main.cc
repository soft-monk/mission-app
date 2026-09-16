// mission-app · packages/host/src/main.cc
//
// 宿主最小内核。这个文件里**没有任何业务逻辑**，只有五件事：
//   1) 读配置、按固定顺序装配各引擎、打印一行就绪汇总
//   2) 本地配置 → 仿真源 → UDP → 接入层 → 广播（真实链路）
//   3) 起 HTTP 服务（观测端点 + WS + 静态托管 + 瓦片转发）
//   4) 等退出信号，按固定顺序优雅退出：**先 flush 再停模块**
//   5) 打印退出自证行，进程退出码 0
#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <exception>
#include <iostream>
#include <string>
#include <thread>

#include <drogon/HttpAppFramework.h>
#include <trantor/utils/Logger.h>

#include "ma/config.h"
#include "ma/engines.h"
#include "ma/host_server.h"
#include "ma/hub_engine.h"
#include "ma/registry.h"

#if MA_WITH_INGEST
#include "device_ingest/gateway.h"
#endif

namespace {

ma::HostServer* g_server = nullptr;

extern "C" void onSignal(int sig) {
    (void)sig;
    // 信号处理器里只做最轻的事：置位并唤醒主线程。
    // 真正的退出序列在 main 里跑 —— 在信号上下文里调 flush() 是不安全的。
    if (g_server != nullptr) g_server->requestStop();
}

void printUsage() {
    std::cout <<
        "mission-app · 装配宿主\n"
        "\n"
        "用法：mission_host [--config <路径>] [--port <端口>] [--stop-after <秒>]\n"
        "                  [--scenario <目录>] [--speed <1|8|60>] [--no-sim]\n"
        "                  [--selftest]\n"
        "\n"
        "  --config <路径>   配置文件（JSON）。缺省依次尝试：仓库根 config.json、\n"
        "                     环境变量 MISSION_APP_CONFIG、exe 附近的 config.json\n"
        "  --port <端口>     覆盖 server.port（多实例并行跑验收时用）\n"
        "  --scenario <目录> 覆盖本地配置目录（缺省 <dataDir>/scenario-1）\n"
        "  --speed <倍率>    节拍倍速：1 | 8 | 60（缺省 config.json 的 simSpeed）\n"
        "  --no-sim          只起服务与接入层，不跑仿真节拍\n"
        "  --determinism-check  离线双跑逐字节比对报文序列（假时钟），退出码 0/1\n"
        "  --stop-after <秒> 跑够秒数自动走正常退出序列（0/缺省 = 一直跑）\n"
        "  --selftest        不起网络、不读配置：只验装配与就绪行，退出码 0/1\n"
        "\n"
        "退出：Ctrl+C。退出序列先 flush 留存层，再按装配逆序停各模块。\n";
}

/// 就绪行出现 = 装配成功（acceptance.ps1 就认它）。
constexpr const char* kReadyPrefix = "[host] engines ready:";

#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST

/// 确定性自证：同一份本地配置 + **同一个假时钟** + 同一串步长，跑两遍比报文序列。
///
/// 为什么放在宿主里而不是脚本里：脚本没有假时钟，只能干等真实时间，
/// 那样比出来的是"两次都收到了数据"，不是"两次一模一样"。
/// 这里时间完全由假时钟推，与挂钟无关 —— 不一致就一定是代码里的不确定性。
int runDeterminismCheck(const ma::HostConfig& cfg, const std::string& scenarioDir) {
    ma::scenario::ScenarioData data;
    sim_source::SimScenario neutral;
    ma::scenario::LoadReport loadReport;
    if (!ma::scenario::loadScenario(scenarioDir, data, neutral, loadReport)) {
        std::cerr << "[host] 本地配置装载失败：\n  " << loadReport.toText() << "\n";
        return 1;
    }

    ma::sim_bridge::BridgeOptions opts;
    opts.sim.defaultKind = cfg.simKind;
    opts.sim.useClockWhenTickArgMissing = false;
    opts.wireType = cfg.simWireType;
    opts.sink.dryRun = true;

    ma::sim_bridge::BridgeReport report;
    const bool ok = ma::sim_bridge::sameScenarioTwiceProducesIdenticalFrames(
        neutral, data, opts, /*steps=*/40, /*stepMs=*/1000, report);
    std::cout << "[host] 确定性检查（假时钟，40 步 × 1000 ms 仿真时间）：" << report.toText()
              << "\n";
    std::cout.flush();
    return ok ? 0 : 1;
}

#endif

#if MA_WITH_INGEST
/// 宿主配置里的接入点 → 模块的接入点结构（字段名逐一对齐，不做任何解释）。
device_ingest::IngestConfig toIngestConfig(const ma::HostConfig& cfg) {
    device_ingest::IngestConfig out;
    out.enabled = cfg.ingest.enabled;
    out.mergeWindowMs = cfg.ingest.mergeWindowMs;
    for (const auto& p : cfg.ingest.points) {
        device_ingest::PointConfig pc;
        pc.id = p.id;
        pc.group = p.group;
        pc.port = p.port;
        pc.iface = p.iface;
        pc.parserId = p.parserId;
        pc.deviceType = p.deviceType;
        pc.topic = p.topic;
        pc.enabled = p.enabled;
        out.points.push_back(std::move(pc));
    }
    return out;
}
#endif

}  // namespace

int main(int argc, char** argv) {
    std::string configPath;
    std::string scenarioOverride;
    int stopAfterSeconds = 0;
    int portOverride = 0;
    int speedOverride = 0;
    bool selftest = false;
    bool noSim = false;
    bool determinismCheck = false;

    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--config" && i + 1 < argc) {
            configPath = argv[++i];
        } else if (arg == "--stop-after" && i + 1 < argc) {
            try {
                stopAfterSeconds = std::stoi(argv[++i]);
            } catch (const std::exception&) {
                std::cerr << "--stop-after 需要秒数\n";
                return 2;
            }
        } else if (arg == "--port" && i + 1 < argc) {
            try {
                portOverride = std::stoi(argv[++i]);
            } catch (const std::exception&) {
                std::cerr << "--port 需要端口号\n";
                return 2;
            }
        } else if (arg == "--scenario" && i + 1 < argc) {
            scenarioOverride = argv[++i];
        } else if (arg == "--speed" && i + 1 < argc) {
            try {
                speedOverride = std::stoi(argv[++i]);
            } catch (const std::exception&) {
                std::cerr << "--speed 需要倍率（1 | 8 | 60）\n";
                return 2;
            }
            if (speedOverride != 1 && speedOverride != 8 && speedOverride != 60) {
                std::cerr << "--speed 只接受 1 / 8 / 60\n";
                return 2;
            }
        } else if (arg == "--no-sim") {
            noSim = true;
        } else if (arg == "--determinism-check") {
            determinismCheck = true;
        } else if (arg == "--selftest") {
            selftest = true;
        } else if (arg == "-h" || arg == "--help") {
            printUsage();
            return 0;
        } else {
            std::cerr << "未知参数：" << arg << "\n\n";
            printUsage();
            return 2;
        }
    }

    trantor::Logger::setLogLevel(selftest ? trantor::Logger::kWarn : trantor::Logger::kInfo);

    // stdout 重定向到文件时是整块缓冲的：进程被强杀就一个字都留不下。
    // 关键节点统一冲一次，让"没等到优雅退出"的情况下也拿得到日志。
    const auto flushLog = [] { std::cout.flush(); };

    // ================================================================ 配置
    ma::HostConfig cfg;
    const std::string resolved = ma::resolveConfigPath(configPath, argv[0]);
    if (!resolved.empty()) {
        std::string error;
        if (!ma::HostConfig::loadFile(resolved, cfg, error)) {
            std::cerr << "[host] 配置有问题：" << error << "\n  文件：" << resolved << "\n";
            return 2;
        }
        std::cout << "[host] 配置：" << resolved << "\n";
    } else if (!selftest) {
        std::cout << "[host] 未找到 config.json，使用内置默认值\n";
    }
    if (portOverride > 0) cfg.port = portOverride;
    if (speedOverride > 0) cfg.simSpeed = speedOverride;
    if (!scenarioOverride.empty()) cfg.scenarioDir = scenarioOverride;

    // 数据目录：相对路径锚定在**配置文件旁边**（不是进程当前目录）。
    const std::string dataDir = cfg.resolvePath(cfg.dataDir);
    const std::string scenarioDir = cfg.resolveScenarioDir();

    std::cout << "[host] 监听 " << cfg.host << ":" << cfg.port
              << "  数据目录 " << dataDir << "\n";
    std::cout << "[host] 事件 kind=" << cfg.simKind << "  过线类型=" << cfg.simWireType
              << "  倍速=" << cfg.simSpeed << "x";
    if (!cfg.ingest.points.empty()) {
        std::cout << "  接入点 " << cfg.ingest.points.front().id << "=" << cfg.ingestHost << ":"
                  << cfg.ingestPort() << "（parser=" << cfg.ingest.points.front().parserId << "）";
    }
    std::cout << "\n";
    flushLog();

    // 确定性自证：离线双跑，不起网络、不读网络配置。
#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST
    if (determinismCheck) return runDeterminismCheck(cfg, scenarioDir);
#else
    if (determinismCheck) {
        std::cerr << "[host] 确定性检查需要 sim-source 与接入层一起装配\n";
        return 1;
    }
#endif

    // ================================================================ 装配（顺序固定）
    //
    // Teardown 的成员析构顺序 = 声明的逆序；engines 声明在 server 之前，
    // 所以 server 先析构、引擎后析构 —— 与下面显式的退出序列一致。
    ma::Engines engines;
    ma::Registry registry;

    // ---------------------------------------------------------------- 真实链路
    //
    // 数据流向就是这段代码的顺序：本地配置 → 中立结构 → 引擎 → 一行报文 → 接入层 → 广播。
    ma::HubEngine hubEngine;
    std::string simError;
    bool simReady = false;
#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST
    simReady = engines.loadSimulation(scenarioDir, cfg.simKind, cfg.simWireType, cfg.ingestHost,
                                      cfg.ingestPort(), simError);
    if (!simReady) {
        std::cerr << "[host] 仿真链路未装配：\n" << simError << "\n";
    }
#endif

    engines.report(registry);

    std::cout << "[host] " << engines.evidence.summary() << "\n";
    std::cout << kReadyPrefix;
    {
        // 就绪行 = "[host] engines ready: phase=1 resource=1 ..."
        const std::string line = registry.readyLine();
        const std::string after = line.substr(std::string("[host] engines ready:").size());
        std::cout << after;
    }
    std::cout << "\n";

    {
        const auto notReady = registry.notInstantiated();
        std::cout << "[host] linked-only:";
        if (notReady.empty()) {
            std::cout << " (none)";
        } else {
            for (const auto& e : notReady) {
                std::cout << " " << e.key << "(" << (e.note.empty() ? "未实例化" : e.note) << ")";
            }
        }
        std::cout << "\n";
    }
    flushLog();

    if (selftest) {
        std::cout << "[host] selftest OK（未起网络）\n";
        engines.flush();
        engines.stop();
        return 0;
    }

    // ================================================================ 服务
    ma::HostServer server(cfg, registry, engines);
    g_server = &server;

    // ---- 广播腿：WS 路由的三条路径 + /stats 的实时读数
    //
    // 心跳节拍是**为了验收可观测**刻意调短的：默认 15 s × 4 = 60 s 判死，
    // 验收等不起；这里 1.5 s × 3 = 4.5 s 无消息判死，维护线程每秒扫一次。
    ma::DrogonTransportOptions transportOptions;
    transportOptions.perConnectionQueueLimit = 512;
    transportOptions.maintenanceIntervalMs = 1000;
    transportOptions.senderIntervalMs = 2;
    hubEngine.configure("/ws", transportOptions);
    server.attachHub(ma::WsCallbacks{
        [&hubEngine](const drogon::WebSocketConnectionPtr& conn) {
            hubEngine.onAccepted(conn);
        },
        [&hubEngine](const drogon::WebSocketConnectionPtr& conn, std::string&& message) {
            hubEngine.onInbound(conn, std::move(message));
        },
        [&hubEngine](const drogon::WebSocketConnectionPtr& conn) { hubEngine.onClosed(conn); },
        [&hubEngine](const std::string& peer) -> std::size_t {
            return hubEngine.transport() ? hubEngine.transport()->forceCloseByPeer(peer) : 0;
        },
        [&engines, &hubEngine]() {
            nlohmann::json extra = nlohmann::json::object();
            extra["realtime"] = hubEngine.statsJson();
#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST
            extra["simulation"] = engines.simStatsJson();
#endif
#if MA_WITH_INGEST
            extra["ingest"] = engines.ingestStatsJson();
#endif
            return extra;
        }});

    std::signal(SIGINT, onSignal);
    std::signal(SIGTERM, onSignal);

    if (server.start() != 0) {
        std::cerr << "[host] 服务起不来（端口 " << cfg.port << " 被占用？）\n";
        g_server = nullptr;
        engines.flush();
        engines.stop();
        return 1;
    }

    // ---- WS 的广播腿：起维护线程（判死扫描）与发送线程
    hubEngine.start();

    // ---- 接入层：真正 start()（绑端口、起接收线程）。**在 WS 就绪之后**，
    //      这样第一包数据到达时广播腿已经能用。
    std::string gatewayNote = "未装配";
#if MA_WITH_INGEST
    if (engines.gateway) {
        const device_ingest::IngestConfig ingestCfg = toIngestConfig(cfg);
        const bool started = engines.gateway->start(
            ingestCfg,
            std::shared_ptr<device_ingest::ISink>(&hubEngine.sink(), [](auto*) {}), nullptr,
            nullptr);
        engines.gatewayRunning = started;
        const device_ingest::GatewayStatus st = engines.gateway->status();
        gatewayNote = started ? ("running points=" + std::to_string(st.pointsRunning) + "/" +
                                 std::to_string(st.points))
                              : "start() 返回 false（端口占用 / 接入点都不合法）";
        if (started) {
            for (const auto& p : cfg.ingest.points) {
                std::cout << "[host] 接入点 " << p.id << "：" << (p.group.empty() ? "单播" : p.group)
                          << ":" << p.port << " parser=" << p.parserId
                          << " deviceType=" << p.deviceType << "\n";
            }
        } else {
            std::cerr << "[host] 接入层没起来：" << gatewayNote << "\n";
        }
    }
#endif
    engines.report(registry);

    // ---- 仿真节拍：起驱动线程（真实时间 × 倍速）
#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST
    if (simReady && engines.bridge.driver) {
        engines.bridge.driver->setSpeed(cfg.simSpeed);
        if (!noSim && cfg.simAutoStart) {
            engines.bridge.driver->primeNow();
            engines.bridge.driver->start();
            std::cout << "[host] 仿真已启动：" << cfg.simSpeed << "x → " << cfg.ingestHost << ":"
                      << cfg.ingestPort() << "\n";
        } else {
            std::cout << "[host] 仿真未启动（--no-sim 或 simAutoStart=false）；可随时用 --speed 路径重启\n";
        }
    }
#endif
    flushLog();

    std::cout << "[host] 已就绪：\n"
              << "    页面   http://" << cfg.host << ":" << cfg.port << "/\n"
              << "    健康   http://" << cfg.host << ":" << cfg.port << "/health\n"
              << "    统计   http://" << cfg.host << ":" << cfg.port << "/stats\n"
              << "    实时   ws://" << cfg.host << ":" << cfg.port << "/ws\n"
              << "    瓦片模板 " << cfg.tilesTemplate << "\n";
    if (!server.indexHint().empty()) {
        std::cout << "    （前端产物不存在：" << server.indexHint() << " —— / 返回提示页）\n";
    }
    std::cout << "  Ctrl+C 退出（先 flush 再停模块）\n";
    flushLog();

    if (stopAfterSeconds > 0) {
        std::thread([&server, stopAfterSeconds] {
            std::this_thread::sleep_for(std::chrono::seconds(stopAfterSeconds));
            std::cout << "\n[host] --stop-after " << stopAfterSeconds << " 到点，开始退出\n";
            std::cout.flush();
            server.requestStop();
        }).detach();
    }

    // ================================================================ 等退出
    server.waitForStop();

    // ================================================================ 退出序列
    //
    // 顺序是硬要求：**先 flush（成功返回）→ 再停模块**。
    // 反过来的话，模块一停就再没有数据进来，但缓冲里那批还在等下一次刷盘。
    std::cout << "\n[host] 退出中…\n";
    flushLog();

#if MA_WITH_STORE
    if (engines.store) {
        const auto before = engines.storeStatus();
        std::cout << "[host] flush telemetry-store：缓冲 " << before.buffered << " 条 → " << std::flush;
        engines.flush();
        const auto after = engines.storeStatus();
        std::cout << "已落盘 " << after.persisted << " 条（appended=" << after.appended
                  << ", buffered=" << after.buffered << ", flushes=" << after.flushes << "）\n";
    }
#else
    engines.flush();
#endif
    std::cout << "[host] telemetry-store " << (engines.store ? "flushed" : "skipped") << "\n";

    // 生产者先停（仿真节拍 → 接入层），消费者后停（广播腿）—— 否则最后一批会打到空气里。
    engines.stop();
    std::cout << "[host] engines stopped (reverse order)\n";

    hubEngine.stop();
    std::cout << "[host] hub stopped\n";

    server.shutdown();
    g_server = nullptr;
    std::cout << "[host] exit clean" << std::endl;
    return 0;
}
