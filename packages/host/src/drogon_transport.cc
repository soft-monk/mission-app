// mission-app · packages/host/src/drogon_transport.cc
//
// 见 drogon_transport.h 的四条硬口径。实现刻意做小：
//   · send()      —— 加锁入队 + 一次 notify，**不等 socket**
//   · 发送线程    —— 唯一"等 socket"的地方，逐条连接泵队列
//   · 维护线程    —— 唯一按固定节拍 sweepDeadConnections() 的地方
#include "ma/drogon_transport.h"

#include <chrono>
#include <cstdint>
#include <utility>
#include <vector>

#include <trantor/utils/Logger.h>

namespace ma {

namespace detail {

/// 每条连接一个（hub 的装配单位就是"每条连接一个 ITransport"）。
/// 薄到只剩"我知道我是哪条槽位"。
class DrogonConnectionTransport final : public realtime_hub::ITransport {
public:
    DrogonConnectionTransport(DrogonTransport& owner, std::shared_ptr<DrogonTransport::Slot> slot)
        : owner_(owner), slot_(std::move(slot)) {}

    void send(const std::string& envelope) override { owner_.enqueue(slot_, envelope); }
    void close(const std::string& reason) override {
        owner_.shutdownSlot(slot_, reason, /*forced=*/true);
    }
    std::string peer() const override { return slot_ ? slot_->peer : std::string(); }

private:
    DrogonTransport& owner_;
    std::shared_ptr<DrogonTransport::Slot> slot_;
};

}  // namespace detail

namespace {
std::int64_t steadyMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

std::string peerOf(const drogon::WebSocketConnectionPtr& conn) {
    if (!conn) return {};
    try {
        return conn->peerAddr().toIpPort();
    } catch (...) {
        return {};
    }
}
}  // namespace

DrogonTransport::DrogonTransport(realtime_hub::RealtimeHub& hub,
                                 const DrogonTransportOptions& options)
    : hub_(hub), options_(options) {}

DrogonTransport::~DrogonTransport() { stop(); }

// ================================================================ 生命周期

void DrogonTransport::start() {
    if (running_.exchange(true)) return;
    stop_.store(false);
    sender_ = std::thread([this] { senderLoop(); });
    maintainer_ = std::thread([this] { maintenanceLoop(); });
    LOG_INFO << "[hub] transport 已启动（每连接队列上限 " << options_.perConnectionQueueLimit
             << " 条，维护节拍 " << options_.maintenanceIntervalMs << " ms，发送线程 1 条）";
}

void DrogonTransport::stop() {
    if (!running_.load()) {
        if (sender_.joinable()) sender_.join();
        if (maintainer_.joinable()) maintainer_.join();
        return;
    }
    running_.store(false);
    stop_.store(true);
    cv_.notify_all();

    std::vector<std::shared_ptr<Slot>> doomed;
    {
        std::lock_guard<std::mutex> lk(mtx_);
        for (auto& kv : slots_) doomed.push_back(kv.second);
        slots_.clear();
        queued_ = 0;
    }
    for (auto& slot : doomed) {
        {
            std::lock_guard<std::mutex> lk(mtx_);
            slot->closing = true;
            slot->queue.clear();
        }
        hub_.removeConnection(slot->hubId);
        if (slot->conn && slot->conn->connected()) {
            try {
                slot->conn->shutdown(drogon::CloseCode::kEndpointGone, "server stopping");
            } catch (...) {
            }
        }
    }
    hub_.clear();

    if (sender_.joinable()) sender_.join();
    if (maintainer_.joinable()) maintainer_.join();
    LOG_INFO << "[hub] transport 已停止";
}

// ================================================================ 握手 / 断开

void DrogonTransport::onAccepted(const drogon::WebSocketConnectionPtr& conn) {
    if (!conn) return;

    auto slot = std::make_shared<Slot>();
    slot->conn = conn;
    slot->peer = peerOf(conn);
    if (options_.autoPing) {
        try {
            conn->setPingMessage("", std::chrono::seconds(10));
        } catch (...) {
        }
    }

    {
        std::lock_guard<std::mutex> lk(mtx_);
        slots_[conn.get()] = slot;
    }

    // 登记进 hub（hub 会立刻发 sys.welcome —— 走 send() → 入队，不等 socket）。
    auto transport = std::make_shared<detail::DrogonConnectionTransport>(*this, slot);
    const realtime_hub::ConnectionId id = hub_.addConnection(transport);
    {
        std::lock_guard<std::mutex> lk(mtx_);
        slot->hubId = id;
    }
    {
        std::lock_guard<std::mutex> lk(statsMtx_);
        ++stats_.acceptedConnections;
        stats_.connections = slots_.size();
    }
    cv_.notify_all();
    LOG_INFO << "[hub] WS 接入 " << slot->peer << "（id=" << id << "）clients="
             << hub_.clientCount();
}

void DrogonTransport::onClosed(const drogon::WebSocketConnectionPtr& conn) {
    if (!conn) return;
    std::shared_ptr<Slot> slot;
    bool had = false;
    {
        std::lock_guard<std::mutex> lk(mtx_);
        const auto it = slots_.find(conn.get());
        if (it != slots_.end()) {
            slot = it->second;
            slots_.erase(it);
            had = true;
            const std::size_t n = slot->queue.size();
            queued_ = (n > queued_) ? 0 : queued_ - n;
            slot->queue.clear();
            slot->closing = true;
        }
    }
    if (slot && slot->hubId != 0) {
        hub_.removeConnection(slot->hubId);  // 重复注销是安全的
    }
    {
        std::lock_guard<std::mutex> lk(statsMtx_);
        if (had) ++stats_.closedConnections;
        else ++stats_.orphanDisconnects;
        stats_.connections = slots_.size();
    }
    LOG_INFO << "[hub] WS 断开 " << (slot ? slot->peer : std::string("(unknown)"))
             << "；clients=" << hub_.clientCount();
}

void DrogonTransport::onInbound(const drogon::WebSocketConnectionPtr& conn,
                                std::string&& message) {
    {
        std::lock_guard<std::mutex> lk(statsMtx_);
        ++stats_.inboundFrames;
    }
    std::shared_ptr<Slot> slot;
    {
        std::lock_guard<std::mutex> lk(mtx_);
        const auto it = slots_.find(conn.get());
        if (it != slots_.end()) slot = it->second;
    }
    if (!slot || slot->hubId == 0) return;
    hub_.touch(slot->hubId);                    // 收到的**任意**消息都算活着
    hub_.handleInbound(slot->hubId, message);   // hub 只处理 sys.*，业务上行一律忽略
}

std::size_t DrogonTransport::forceCloseByPeer(const std::string& peerFragment) {
    std::vector<std::shared_ptr<Slot>> hit;
    {
        std::lock_guard<std::mutex> lk(mtx_);
        for (auto& kv : slots_) {
            if (kv.second && kv.second->peer.find(peerFragment) != std::string::npos) {
                hit.push_back(kv.second);
            }
        }
    }
    for (auto& slot : hit) shutdownSlot(slot, "force-close-by-peer", /*forced=*/true);
    return hit.size();
}

// ================================================================ 入队 / 强断

void DrogonTransport::enqueue(const std::shared_ptr<Slot>& slot, const std::string& envelope) {
    if (!slot) return;
    bool overflow = false;
    {
        std::lock_guard<std::mutex> lk(mtx_);
        if (slot->closing) return;
        if (slot->queue.size() >= options_.perConnectionQueueLimit) {
            slot->queue.pop_front();  // ★ 丢**最老**帧
            ++slot->dropped;
            overflow = true;
        }
        slot->queue.push_back(envelope);
        ++queued_;
        if (queued_ > peakQueue_) peakQueue_ = queued_;
    }
    {
        std::lock_guard<std::mutex> lk(statsMtx_);
        ++stats_.framesQueued;
        if (overflow) ++stats_.framesDropped;
        stats_.queued = queued_;
        stats_.peakQueue = peakQueue_;
    }
    cv_.notify_one();
}

void DrogonTransport::shutdownSlot(const std::shared_ptr<Slot>& slot, const std::string& reason,
                                   bool forced) {
    if (!slot) return;
    {
        std::lock_guard<std::mutex> lk(statsMtx_);
        if (forced) ++stats_.forcedCloses;
    }
    LOG_INFO << "[hub] 断开 " << slot->peer << "（" << reason << "）";
    if (slot->conn) {
        try {
            slot->conn->shutdown(drogon::CloseCode::kViolation, reason);
        } catch (...) {
        }
        try {
            slot->conn->forceClose();
        } catch (...) {
        }
    }
}

std::shared_ptr<DrogonTransport::Slot> DrogonTransport::slotOf(
    const drogon::WebSocketConnectionPtr& conn) const {
    std::lock_guard<std::mutex> lk(mtx_);
    const auto it = slots_.find(conn.get());
    return it == slots_.end() ? std::shared_ptr<Slot>{} : it->second;
}

// ================================================================ 线程

void DrogonTransport::senderLoop() {
    while (!stop_.load()) {
        std::vector<std::pair<std::shared_ptr<Slot>, std::string>> outbox;
        {
            std::unique_lock<std::mutex> lk(mtx_);
            for (auto& kv : slots_) {
                std::shared_ptr<Slot>& slot = kv.second;
                if (!slot || slot->closing || slot->queue.empty()) continue;
                // 一次最多搬 64 条，避免长时间持锁。
                for (int i = 0; i < 64 && !slot->queue.empty(); ++i) {
                    outbox.emplace_back(slot, std::move(slot->queue.front()));
                    slot->queue.pop_front();
                    --queued_;
                }
            }
            if (outbox.empty()) {
                const int wait = options_.senderIntervalMs > 0 ? options_.senderIntervalMs : 2;
                cv_.wait_for(lk, std::chrono::milliseconds(wait),
                             [this] { return stop_.load(); });
                continue;
            }
            cv_.notify_all();
        }
        for (auto& item : outbox) {
            const std::shared_ptr<Slot>& slot = item.first;
            if (!slot || !slot->conn) continue;
            if (!slot->conn->connected()) {
                std::lock_guard<std::mutex> lk(statsMtx_);
                ++stats_.sendFailures;
                continue;
            }
            try {
                slot->conn->send(item.second);
                std::lock_guard<std::mutex> lk(statsMtx_);
                ++stats_.framesSent;
            } catch (const std::exception& e) {
                std::lock_guard<std::mutex> lk(statsMtx_);
                ++stats_.sendFailures;
                LOG_WARN << "[hub] send 失败（" << slot->peer << "）：" << e.what();
            }
        }
    }
}

void DrogonTransport::maintenanceLoop() {
    const int interval =
        options_.maintenanceIntervalMs > 0 ? options_.maintenanceIntervalMs : 2000;
    while (!stop_.load()) {
        for (int slept = 0; slept < interval && !stop_.load(); slept += 20) {
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }
        if (stop_.load()) break;
        // ★ 全进程**恰好这一处**按固定节拍扫死连接。
        //   先记下"扫描前对端还连着"的条数：sweptClosed - sweptConnected 才是
        //   真正被心跳判死的那部分（对端先走的那些不算，否则指标会指鹿为马）。
        std::size_t aliveBefore = 0;
        {
            std::lock_guard<std::mutex> lk(mtx_);
            for (const auto& kv : slots_) {
                if (kv.second && kv.second->conn && kv.second->conn->connected()) ++aliveBefore;
            }
        }
        const std::size_t kicked = hub_.sweepDeadConnections();
        {
            std::lock_guard<std::mutex> lk(statsMtx_);
            ++stats_.sweeps;
            stats_.sweptClosed += kicked;
            stats_.sweptConnected += (aliveBefore < kicked) ? aliveBefore : kicked;
        }
        if (kicked > 0) LOG_INFO << "[hub] 心跳判死踢掉 " << kicked << " 条连接";
    }
}

// ================================================================ 读数

DrogonTransportStats DrogonTransport::stats() const {
    DrogonTransportStats out;
    {
        std::lock_guard<std::mutex> lk(statsMtx_);
        out = stats_;
    }
    {
        std::lock_guard<std::mutex> lk(mtx_);
        out.connections = slots_.size();
        out.queued = queued_;
        out.peakQueue = peakQueue_;
    }
    // clientCount 的**权威来源是 hub**（本类只是它的 ITransport 提供方）。
    return out;
}

}  // namespace ma
