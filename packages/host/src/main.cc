// mission-app · packages/host/src/main.cc
//
// 宿主最小内核。这个文件里**没有任何业务逻辑**，只有四件事：
//   1) 读配置、按固定顺序装配各引擎、打印一行就绪汇总
//   2) 起 HTTP 服务（观测端点 + 静态托管 + 瓦片转发）
//   3) 等退出信号，按固定顺序优雅退出：**先 flush 再停模块**
//   4) 打印退出自证行，进程退出码 0
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
#include "ma/registry.h"

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
        "mission-app · P0 装配骨架\n"
        "\n"
        "用法：mission_host [--config <路径>] [--port <端口>] [--stop-after <秒>]\n"
        "                  [--selftest]\n"
        "\n"
        "  --config <路径>   配置文件（JSON）。缺省依次尝试：仓库根 config.json、\n"
        "                     环境变量 MISSION_APP_CONFIG、exe 附近的 config.json\n"
        "  --port <端口>     覆盖 server.port（多实例并行跑验收时用）\n"
        "  --stop-after <秒> 跑够秒数自动走正常退出序列（0/缺省 = 一直跑）\n"
        "  --selftest        不起网络、不读配置：只验装配与就绪行，退出码 0/1\n"
        "\n"
        "退出：Ctrl+C。退出序列先 flush 留存层，再按装配逆序停各模块。\n";
}

/// 就绪行出现 = 装配成功（acceptance.ps1 就认它）。
constexpr const char* kReadyPrefix = "[host] engines ready:";

}  // namespace

int main(int argc, char** argv) {
    std::string configPath;
    int stopAfterSeconds = 0;
    int portOverride = 0;
    bool selftest = false;

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

    // 数据目录：相对路径锚定在**配置文件旁边**（不是进程当前目录）。
    const std::string dataDir = cfg.resolvePath(cfg.dataDir);

    std::cout << "[host] 监听 " << cfg.host << ":" << cfg.port
              << "  数据目录 " << dataDir << "\n";
    flushLog();

    // ================================================================ 装配（顺序固定）
    //
    // Teardown 的成员析构顺序 = 声明的逆序；engines 声明在 server 之前，
    // 所以 server 先析构、引擎后析构 —— 与下面显式的退出序列一致。
    ma::Engines engines;
    ma::Registry registry;
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

    std::signal(SIGINT, onSignal);
    std::signal(SIGTERM, onSignal);

    if (server.start() != 0) {
        std::cerr << "[host] 服务起不来（端口 " << cfg.port << " 被占用？）\n";
        g_server = nullptr;
        engines.flush();
        engines.stop();
        return 1;
    }

    std::cout << "[host] 已就绪：\n"
              << "    页面   http://" << cfg.host << ":" << cfg.port << "/\n"
              << "    健康   http://" << cfg.host << ":" << cfg.port << "/health\n"
              << "    统计   http://" << cfg.host << ":" << cfg.port << "/stats\n"
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

    engines.stop();
    std::cout << "[host] engines stopped (reverse order)\n";

    server.shutdown();
    g_server = nullptr;
    std::cout << "[host] exit clean" << std::endl;
    return 0;
}
