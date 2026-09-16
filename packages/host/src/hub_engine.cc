// mission-app · packages/host/src/hub_engine.cc
#include "ma/hub_engine.h"

#include <utility>

#include <trantor/utils/Logger.h>

#include <realtime_hub/events.h>
#include <realtime_hub/hub.h>

namespace ma {

// ================================================================ 出口：接入层 → 广播

IngestToHubSink::IngestToHubSink(realtime_hub::RealtimeHub& hub) : hub_(hub) {}

#if MA_WITH_INGEST

namespace {
/// 一条归一事件 → 一次广播。`data` 原样交给 hub（字段一个不改）。
/// hub 自己会：校验事件名、打 ts、按当前在线名单投递。
bool broadcastOne(realtime_hub::RealtimeHub& hub, const device_ingest::IngestEvent& ev) {
    if (ev.type.empty()) return false;
    if (!realtime_hub::isValidEventType(ev.type)) return false;
    if (!ev.data.is_object()) return false;
    hub.broadcast(ev.type, ev.data);
    return true;
}
}  // namespace

void IngestToHubSink::onEvent(const device_ingest::IngestEvent& ev) {
    if (broadcastOne(hub_, ev)) {
        ++forwarded_;
    } else {
        ++dropped_;
    }
}

void IngestToHubSink::onBatch(const std::vector<device_ingest::IngestEvent>& evs) {
    ++batches_;
    for (const auto& ev : evs) {
        if (broadcastOne(hub_, ev)) {
            ++forwarded_;
        } else {
            ++dropped_;
        }
    }
}

void IngestToHubSink::onDeviceHealth(const device_ingest::DeviceHealthEvent& ev) {
    // 设备上线/离线/周期统计走与数据同一条广播路径（事件名见《外设接入契约》§5）。
    std::string type;
    switch (ev.kind) {
        case device_ingest::DeviceHealthEvent::Kind::Online: type = "device.online"; break;
        case device_ingest::DeviceHealthEvent::Kind::Offline: type = "device.offline"; break;
        case device_ingest::DeviceHealthEvent::Kind::Stats: type = "device.stats"; break;
        default: return;
    }
    nlohmann::json data = ev.toJson();
    if (!data.is_object()) return;
    hub_.broadcast(type, data);
    ++healthEvents_;
}

#endif  // MA_WITH_INGEST

// ================================================================ 广播腿装配

HubEngine::HubEngine() : hub_(realtime_hub::RealtimeHub::instance()) {
    sink_ = std::make_unique<IngestToHubSink>(hub_);
}

HubEngine::~HubEngine() { stop(); }

void HubEngine::configure(const std::string& wsPath, const DrogonTransportOptions& options) {
    wsPath_ = wsPath.empty() ? "/ws" : wsPath;
    options_ = options;

    realtime_hub::HubOptions hubOptions;
    hubOptions.heartbeatMs = 1500;              // 验收可观测：判死窗口 = 1.5 s × 3 = 4.5 s
    hubOptions.deadAfterMissedHeartbeats = 3;
    hubOptions.sendWelcomeOnConnect = true;
    hubOptions.replyErrorOnUnsupportedUplink = true;
    hub_.configure(hubOptions);
    hub_.setLogger([](const std::string& level, const std::string& message) {
        if (level == "error") {
            LOG_ERROR << "[hub] " << message;
        } else if (level == "warn") {
            LOG_WARN << "[hub] " << message;
        } else {
            LOG_INFO << "[hub] " << message;
        }
    });

    transport_ = std::make_unique<DrogonTransport>(hub_, options);
}

void HubEngine::start() {
    if (started_) return;
    if (transport_) transport_->start();
    started_ = true;
}

void HubEngine::stop() {
    if (!started_) {
        if (transport_) transport_->stop();
        return;
    }
    started_ = false;
    if (transport_) transport_->stop();
}

void HubEngine::onAccepted(const drogon::WebSocketConnectionPtr& conn) {
    if (transport_) transport_->onAccepted(conn);
}

void HubEngine::onInbound(const drogon::WebSocketConnectionPtr& conn, std::string&& message) {
    if (transport_) transport_->onInbound(conn, std::move(message));
}

void HubEngine::onClosed(const drogon::WebSocketConnectionPtr& conn) {
    if (transport_) transport_->onClosed(conn);
}

nlohmann::json HubEngine::statsJson() const {
    nlohmann::ordered_json out;
    out["wsPath"] = wsPath_;
    out["clientCount"] = hub_.clientCount();
    const realtime_hub::HubStats hs = hub_.stats();
    out["hub"] = nlohmann::ordered_json{
        {"broadcasts", hs.broadcasts},
        {"deliveries", hs.deliveries},
        {"rejectedTypes", hs.rejectedTypes},
        {"rejectedPayloads", hs.rejectedPayloads},
        {"transportErrors", hs.transportErrors},
        {"heartbeatClosed", hs.heartbeatClosed},
        {"inboundMessages", hs.inboundMessages},
        {"inboundErrors", hs.inboundErrors},
        {"version", realtime_hub::RealtimeHub::version()},
    };
    if (transport_) {
        const DrogonTransportStats ts = transport_->stats();
        out["transport"] = nlohmann::ordered_json{
            {"accepted", ts.acceptedConnections},
            {"closed", ts.closedConnections},
            {"forcedCloses", ts.forcedCloses},
            {"framesQueued", ts.framesQueued},
            {"framesSent", ts.framesSent},
            {"framesDropped", ts.framesDropped},
            {"sendFailures", ts.sendFailures},
            {"inboundFrames", ts.inboundFrames},
            {"sweeps", ts.sweeps},
            {"sweptClosed", ts.sweptClosed},
            {"sweptConnected", ts.sweptConnected},
            {"orphanDisconnects", ts.orphanDisconnects},
            {"connections", ts.connections},
            {"queued", ts.queued},
            {"peakQueue", ts.peakQueue},
            {"queueLimit", options_.perConnectionQueueLimit},
        };
    }
    out["sink"] = nlohmann::ordered_json{
        {"forwarded", sink_ ? sink_->forwarded() : 0},
        {"dropped", sink_ ? sink_->dropped() : 0},
        {"batches", sink_ ? sink_->batches() : 0},
        {"healthEvents", sink_ ? sink_->healthEvents() : 0},
    };
    return out;
}

}  // namespace ma
