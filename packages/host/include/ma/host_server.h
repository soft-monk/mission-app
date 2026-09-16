// mission-app · packages/host/include/ma/host_server.h
//
// HTTP 服务端（Drogon）：观测端点 + 静态托管 + 瓦片转发。
//
// ★ 纪律：这里**没有任何业务判断**。
//   /health 返回静态占位（真正的 selfcheck 聚合是 P2 的事）；
//   /stats 只回答"各引擎起来了没有"；
//   瓦片请求原样交给 geo-data 的路由处理器，宿主不解析坐标、不做缓存策略。
#pragma once

#include <atomic>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include "ma/config.h"
#include "ma/engines.h"
#include "ma/registry.h"

namespace ma {

class HostServer {
public:
    HostServer(const HostConfig& cfg, Registry& reg, Engines& engines);
    ~HostServer();

    HostServer(const HostServer&) = delete;
    HostServer& operator=(const HostServer&) = delete;

    /// 注册路由 + 监听端口。返回 0 表示成功，非 0 表示起不来。
    int start();

    /// 阻塞直到 requestStop()（信号 / --stop-after）。
    void waitForStop();
    void requestStop();

    /// 停服务（幂等）。在引擎析构之前调用。
    void shutdown();

    bool running() const { return running_.load(); }
    int port() const { return cfg_.port; }
    const std::string& indexHint() const { return indexHint_; }

private:
    void registerRoutes();
    void refreshIndexHint();

    HostConfig cfg_;
    Registry& reg_;
    Engines& engines_;

    std::thread serverThread_;
    std::atomic<bool> running_{false};
    std::atomic<bool> stopping_{false};

    std::mutex stopMtx_;
    std::condition_variable stopCv_;
    bool stopRequested_ = false;

    std::string indexHint_;  // "" = apps/web/dist/index.html 存在；否则给一句可读提示
};

}  // namespace ma
