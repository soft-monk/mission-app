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
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include <drogon/WebSocketConnection.h>
#include <nlohmann/json.hpp>

#include "ma/config.h"
#include "ma/engines.h"
#include "ma/registry.h"

namespace ma {

/// WS 事件的宿主侧回调（由 main 接到广播腿上）。
///
/// 为什么用一组 std::function 而不是直接引用 HubEngine：
/// 路由是在 `start()` 里注册的，而广播腿的装配顺序由 main 决定 —— 这层间接让两边解耦。
struct WsCallbacks {
    std::function<void(const drogon::WebSocketConnectionPtr&)> onAccepted;
    std::function<void(const drogon::WebSocketConnectionPtr&, std::string&&)> onMessage;
    std::function<void(const drogon::WebSocketConnectionPtr&)> onClosed;
    /// 按 peer 片段强断连接（`POST /ws-close?peer=` 用；验收要确定性断开）
    std::function<std::size_t(const std::string&)> closeByPeer;
    /// `/stats` 的附加段（仿真链路 / 接入 / 广播的实时读数）
    std::function<nlohmann::json()> statsExtra;
};

class HostServer {
public:
    HostServer(const HostConfig& cfg, Registry& reg, Engines& engines);
    ~HostServer();

    HostServer(const HostServer&) = delete;
    HostServer& operator=(const HostServer&) = delete;

    /// 接上 WS 回调（必须在 start() 之前调；之后再调无效）。
    void attachHub(WsCallbacks callbacks) { ws_ = std::move(callbacks); }

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
    WsCallbacks ws_;

    std::thread serverThread_;
    std::atomic<bool> running_{false};
    std::atomic<bool> stopping_{false};

    std::mutex stopMtx_;
    std::condition_variable stopCv_;
    bool stopRequested_ = false;

    std::string indexHint_;  // "" = apps/web/dist/index.html 存在；否则给一句可读提示
};

}  // namespace ma
