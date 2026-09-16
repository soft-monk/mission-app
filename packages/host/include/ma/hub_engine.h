// mission-app · packages/host/include/ma/hub_engine.h
//
// 广播腿的装配：device-ingest 的出口 → realtime-hub → DrogonTransport → 各条 WS 连接。
//
//     device-ingest（UDP 接入 + 归一）
//           │  device_ingest::ISink::onEvent / onBatch
//           ▼
//     IngestToHubSink（本文件）        ← 唯一的"信封转换"处：{type, data, ts}
//           │  RealtimeHub::broadcast(type, data)
//           ▼
//     DrogonTransport（每条连接一个有界队列）
//           │  send() 入队 → 发送线程泵到 socket
//           ▼
//     浏览器 / node 客户端
//
// ★ 纪律：这里不做任何业务判断（不筛事件、不改字段、不算优先级）。
//   "该不该发"由上游决定；"发给谁"由 hub 决定；本层只负责把两头接上。
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "ma/drogon_transport.h"

#if MA_WITH_INGEST
#include "device_ingest/gateway.h"
#include "device_ingest/sink.h"
#endif

namespace ma {

/// device_ingest::ISink 的实现：把归一事件转成 hub 的一条广播。
///
/// ⚠️ 模块明写：配了合并窗（默认 100 ms）时**只调 onBatch**，配 0 时**只调 onEvent**，
/// 两者不会同时来。所以**两个都实现**（都转到同一条广播路径），否则会漏数据。
class IngestToHubSink final
#if MA_WITH_INGEST
    : public device_ingest::ISink
#endif
{
public:
    explicit IngestToHubSink(realtime_hub::RealtimeHub& hub);

#if MA_WITH_INGEST
    // ---- 数据出口（两条都实现）----
    void onEvent(const device_ingest::IngestEvent& ev) override;
    void onBatch(const std::vector<device_ingest::IngestEvent>& evs) override;
    // ---- 顺带把设备健康转成同一批事件名（front 不用额外约定）----
    void onDeviceHealth(const device_ingest::DeviceHealthEvent& ev) override;
#endif

    std::uint64_t forwarded() const { return forwarded_; }
    std::uint64_t dropped() const { return dropped_; }  // 事件名非法被 hub 拒的次数
    std::uint64_t batches() const { return batches_; }
    std::uint64_t healthEvents() const { return healthEvents_; }

private:
    realtime_hub::RealtimeHub& hub_;
    std::uint64_t forwarded_ = 0;
    std::uint64_t dropped_ = 0;
    std::uint64_t batches_ = 0;
    std::uint64_t healthEvents_ = 0;
};

/// 广播腿的生命周期与读数。
class HubEngine {
public:
    HubEngine();
    ~HubEngine();

    HubEngine(const HubEngine&) = delete;
    HubEngine& operator=(const HubEngine&) = delete;

    /// 建 transport（不起线程）并配置 hub。`wsPath` = WS 路由（默认 /ws）。
    void configure(const std::string& wsPath, const DrogonTransportOptions& options);

    /// 起维护线程 + 发送线程（在 HTTP 服务监听之后调）。
    void start();
    /// 停：先摘掉路由回调（不再有新连接进来）→ 强断所有连接 → 停线程。
    void stop();

    /// WS 路由（HostServer 注册 /ws 时调它；内部转发到 transport）。
    void onAccepted(const drogon::WebSocketConnectionPtr& conn);
    void onInbound(const drogon::WebSocketConnectionPtr& conn, std::string&& message);
    void onClosed(const drogon::WebSocketConnectionPtr& conn);

    DrogonTransport* transport() { return transport_.get(); }
    realtime_hub::RealtimeHub& hub() { return hub_; }
    IngestToHubSink& sink() { return *sink_; }
    const std::string& wsPath() const { return wsPath_; }

    /// /stats 里那一行的读数（JSON）。
    nlohmann::json statsJson() const;

private:
    realtime_hub::RealtimeHub& hub_;
    std::unique_ptr<DrogonTransport> transport_;
    std::unique_ptr<IngestToHubSink> sink_;
    DrogonTransportOptions options_;
    std::string wsPath_ = "/ws";
    bool started_ = false;
};

}  // namespace ma
