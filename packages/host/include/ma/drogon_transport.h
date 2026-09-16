// mission-app · packages/host/include/ma/drogon_transport.h
//
// realtime_hub::ITransport 的 Drogon/WebSocket 实现。
//
// 它只解决一件事：**把 hub 交给它的一条信封，尽快地、不阻塞任何人地送到对端。**
//
// 四条硬口径（realtime_hub/sink.h 与 design.md 决策 D3）：
//   1) `send()` **入队后立即返回**：广播路径是串行的，谁在 send() 里等 socket，
//      全体客户端的延迟就由最慢的那个人决定。所以 send() 只做一次入队。
//   2) 每条连接的发送队列**有上限**；溢出时**丢最老帧并计数**（不无限涨、不静默）。
//   3) **恰好一条**维护线程按固定节拍 `sweepDeadConnections()`。
//   4) 另有**恰好一条**发送线程统一把各连接的队列泵到 socket —— "等 socket"只发生在
//      这一条线程上，业务线程（广播调用方）永远不会被它拖住。
//
// 为什么每连接一个 ITransport 对象：hub 是按"每条连接一个 ITransport"装配的
// （`addConnection(shared_ptr<ITransport>)`），所以 `send()` 必须知道"我这条是谁"。
// 于是每次握手建一个 ConnectionTransport（薄壳），槽位 = 它的发送队列。
//
// ★ 本文件不 include 任何模块的内部实现，只用 realtime_hub 的公开头 + Drogon。
#pragma once

#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>

#include <drogon/WebSocketConnection.h>

#include <nlohmann/json.hpp>

#include <realtime_hub/hub.h>
#include <realtime_hub/sink.h>

namespace ma {

struct DrogonTransportOptions {
    /// 每条连接的发送队列上限（条）。溢出 → 丢**最老**一帧并计数。
    std::size_t perConnectionQueueLimit = 512;
    /// 维护线程节拍：多久扫一次死连接（毫秒）。
    int maintenanceIntervalMs = 2000;
    /// 发送线程在队列空时的轮询粒度（毫秒）。
    int senderIntervalMs = 2;
    /// 是否让 Drogon 自动发 ping（对端不回 pong 时 Drogon 自己会断）。
    bool autoPing = true;
};

struct DrogonTransportStats {
    std::uint64_t acceptedConnections = 0;  // 握手成功 + 登记进 hub 的次数
    std::uint64_t closedConnections = 0;    // 断开路径上真的注销掉的次数
    std::uint64_t forcedCloses = 0;         // 被 close() 强断的次数
    std::uint64_t framesQueued = 0;
    std::uint64_t framesSent = 0;
    std::uint64_t framesDropped = 0;    // 队列溢出被丢掉的**最老**帧
    std::uint64_t sendFailures = 0;     // 对端已断 / send 抛错
    std::uint64_t inboundFrames = 0;
    std::uint64_t sweeps = 0;
    std::uint64_t sweptClosed = 0;      // 维护线程扫掉的连接数（= hub.heartbeatClosed）
    /// 扫描时"对端还连着"的条数。sweptClosed - sweptConnected = 对端先走了、
    /// 只是恰好被这一轮扫描发现的（那些**不算**心跳判死）。
    std::uint64_t sweptConnected = 0;
    std::uint64_t orphanDisconnects = 0;  // 断开时找不到登记的 id（重复断开等）
    std::size_t connections = 0;
    std::size_t queued = 0;             // 全部连接队列里的待发帧总数
    std::size_t peakQueue = 0;
};

namespace detail {
class DrogonConnectionTransport;
}

class DrogonTransport {
public:
    explicit DrogonTransport(realtime_hub::RealtimeHub& hub,
                             const DrogonTransportOptions& options);
    ~DrogonTransport();

    DrogonTransport(const DrogonTransport&) = delete;
    DrogonTransport& operator=(const DrogonTransport&) = delete;

    // ---- 生命周期（宿主调用）----
    void start();
    void stop();
    bool running() const { return running_.load(); }

    // ---- 握手 / 断开 / 入站（WS 路由调用）----
    void onAccepted(const drogon::WebSocketConnectionPtr& conn);
    void onClosed(const drogon::WebSocketConnectionPtr& conn);
    void onInbound(const drogon::WebSocketConnectionPtr& conn, std::string&& message);

    /// 验收/运维用：按 peer 片段强断（走 hub.close() → ITransport::close() 那条路）。
    std::size_t forceCloseByPeer(const std::string& peerFragment);

    DrogonTransportStats stats() const;

    // ---- 槽位（ConnectionTransport 与内部线程共用；不属业务面）----
    struct Slot {
        drogon::WebSocketConnectionPtr conn;
        std::deque<std::string> queue;
        std::string peer;
        realtime_hub::ConnectionId hubId = 0;
        std::uint64_t dropped = 0;  // 这条连接上被丢掉的**最老**帧数
        bool closing = false;
    };

private:
    friend class detail::DrogonConnectionTransport;

    /// 入队（send 的实现体）。入队后立即返回。
    void enqueue(const std::shared_ptr<Slot>& slot, const std::string& envelope);
    /// 断开一条连接（Transport 侧）。
    void shutdownSlot(const std::shared_ptr<Slot>& slot, const std::string& reason,
                      bool forced);
    std::shared_ptr<Slot> slotOf(const drogon::WebSocketConnectionPtr& conn) const;

    void senderLoop();
    void maintenanceLoop();

    realtime_hub::RealtimeHub& hub_;
    DrogonTransportOptions options_;

    mutable std::mutex mtx_;
    std::condition_variable cv_;
    std::unordered_map<drogon::WebSocketConnection*, std::shared_ptr<Slot>> slots_;
    std::size_t queued_ = 0;
    std::size_t peakQueue_ = 0;

    std::atomic<bool> running_{false};
    std::atomic<bool> stop_{false};
    std::thread sender_;
    std::thread maintainer_;

    mutable std::mutex statsMtx_;
    DrogonTransportStats stats_;
};

}  // namespace ma
