// mission-app · packages/sim-bridge/src/udp_wire_sink.cc
//
// 中立事件 → 一行既有形状的报文 → 一个 UDP 单播包。
#include "ma/sim_bridge/sim_bridge.h"

#include <cstring>
#include <mutex>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

namespace ma::sim_bridge {

namespace {

#ifdef _WIN32
constexpr std::uint64_t kInvalidSocket = static_cast<std::uint64_t>(INVALID_SOCKET);

/// WSA 只初始化一次，进程退出不清理（OS 会收）。
void ensureWsa() {
    static std::once_flag once;
    std::call_once(once, [] {
        WSADATA wsa{};
        WSAStartup(MAKEWORD(2, 2), &wsa);
    });
}
#else
constexpr std::uint64_t kInvalidSocket = static_cast<std::uint64_t>(~0ull);
void ensureWsa() {}
#endif

}  // namespace

std::vector<std::string> wireFieldOrder() {
    return {"kind",   "uavId",  "type", "groupId", "lng",  "lat",
            "alt",    "heading", "speed", "battery", "ts",  "seq"};
}

void GroupTable::add(const std::string& groupKey, const std::string& groupId) {
    if (groupKey.empty()) return;
    for (auto& row : rows_) {
        if (row.first == groupKey) {
            row.second = groupId;
            return;
        }
    }
    rows_.emplace_back(groupKey, groupId);
}

std::string GroupTable::idOf(const std::string& groupKey) const {
    if (groupKey.empty()) return {};
    for (const auto& row : rows_) {
        if (row.first == groupKey) return row.second;
    }
    return {};
}

json toWireFrame(const sim_source::SimEvent& event, const std::string& groupKey,
                 const GroupTable& groups) {
    json frame = json::object();

    // 顺序 = wireFieldOrder()。kind 原样带走（引擎注入的是 "uav.pos"）。
    frame["kind"] = event.kind;
    frame["uavId"] = event.deviceId;       // deviceId → uavId
    frame["type"] = event.deviceType;      // deviceType → type
    const std::string groupId = groups.idOf(groupKey);
    if (!groupId.empty()) frame["groupId"] = groupId;  // 查不到就不写这个键（不猜）
    frame["lng"] = event.lng;
    frame["lat"] = event.lat;
    if (event.hasAlt()) frame["alt"] = event.alt;
    if (event.hasHeading()) frame["heading"] = event.heading;
    if (event.hasSpeed()) frame["speed"] = event.speed;
    if (event.hasBattery()) frame["battery"] = event.battery;
    frame["ts"] = event.ts;
    if (event.hasSeq()) frame["seq"] = event.seq;

    // 引擎的宿主扩展位（契约 §2 之外的展示键）原样附在后面。
    if (event.extensions.is_object()) {
        for (auto it = event.extensions.begin(); it != event.extensions.end(); ++it) {
            if (!frame.contains(it.key())) frame[it.key()] = it.value();
        }
    }
    return frame;
}

json decodeWireFrame(const json& frame) {
    json out = json::object();
    if (!frame.is_object()) return out;
    for (const auto& key : wireFieldOrder()) {
        if (frame.contains(key)) out[key] = frame[key];
    }
    return out;
}

// ============================================================================
// UdpWireSink
// ============================================================================

UdpWireSink::UdpWireSink(const UdpWireSinkOptions& options)
    : options_(options), sock_(kInvalidSocket) {}

UdpWireSink::~UdpWireSink() {
    std::lock_guard<std::mutex> lk(mtx_);
#ifdef _WIN32
    if (sock_ != kInvalidSocket) closesocket(static_cast<SOCKET>(sock_));
#else
    if (sock_ != kInvalidSocket) ::close(static_cast<int>(sock_));
#endif
    sock_ = kInvalidSocket;
}

void UdpWireSink::setGroups(const GroupTable& groups) { groups_ = groups; }

void UdpWireSink::setGroupOfDevice(
    const std::vector<std::pair<std::string, std::string>>& rows) {
    groupOfDevice_ = rows;
}

bool UdpWireSink::socketOpen() const {
    std::lock_guard<std::mutex> lk(mtx_);
    return sock_ != kInvalidSocket;
}

bool UdpWireSink::ensureSocket() {
    if (options_.dryRun) return false;
    if (sock_ != kInvalidSocket) return true;
    ensureWsa();
#ifdef _WIN32
    const SOCKET s = ::socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (s == INVALID_SOCKET) {
        stats_.lastError = "socket() 失败";
        return false;
    }
    sock_ = static_cast<std::uint64_t>(s);
#else
    const int s = ::socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (s < 0) {
        stats_.lastError = "socket() 失败";
        return false;
    }
    sock_ = static_cast<std::uint64_t>(s);
#endif
    return true;
}

void UdpWireSink::onEvent(const sim_source::SimEvent& event) {
    // 目标是**另一类实体**，不走本通道。
    //
    // 判据：目标没有编组，且 deviceType 带目标前缀（scenario-data 注入的 `tgt-`）。
    // 为什么不发：目标的 kind 与平台不同（契约：目标 → `target.state`，平台 → `uav.pos`）。
    // 若把目标混进 `telemetry.uav.pos`，前端会把它当无人机画出来。目标显示属 P4。
    if (!options_.emitTargets && !options_.targetDeviceTypePrefix.empty() &&
        event.deviceType.rfind(options_.targetDeviceTypePrefix, 0) == 0) {
        std::lock_guard<std::mutex> lk(mtx_);
        ++stats_.events;
        ++stats_.targetsSkipped;
        return;
    }

    // 查归属：只有平台才有 groupKey（目标没有组）。
    std::string groupKey;
    for (const auto& row : groupOfDevice_) {
        if (row.first == event.deviceId) {
            groupKey = row.second;
            break;
        }
    }

    const json frame = toWireFrame(event, groupKey, groups_);
    const std::string text = frame.dump();

    std::lock_guard<std::mutex> lk(mtx_);
    ++stats_.events;
    stats_.lastFrame = text;

    if (text.size() > options_.maxFrameBytes) {
        ++stats_.oversize;
        stats_.lastError = "报文超过 maxFrameBytes，未发出";
        return;
    }
    ++stats_.frames;

    if (options_.dryRun) return;
    if (!ensureSocket()) return;

    sockaddr_in to{};
    to.sin_family = AF_INET;
    to.sin_port = htons(static_cast<unsigned short>(options_.port));
    if (::inet_pton(AF_INET, options_.host.c_str(), &to.sin_addr) != 1) {
        ++stats_.errors;
        stats_.lastError = "目标地址非法：" + options_.host;
        return;
    }

#ifdef _WIN32
    const int n = ::sendto(static_cast<SOCKET>(sock_), text.data(),
                           static_cast<int>(text.size()), 0,
                           reinterpret_cast<const sockaddr*>(&to), sizeof(to));
#else
    const ssize_t n = ::sendto(static_cast<int>(sock_), text.data(), text.size(), 0,
                               reinterpret_cast<const sockaddr*>(&to), sizeof(to));
#endif
    if (n < 0) {
        ++stats_.errors;
        stats_.lastError = "sendto 失败";
        return;
    }
    ++stats_.sent;
    stats_.sentBytes += static_cast<std::uint64_t>(n);
}

void UdpWireSink::onObservation(const sim_source::SimObservation& obs) {
    // 观测是**探测结果**，不是设备上报：本层不外发（要不要进接入层是宿主后续分期的事）。
    (void)obs;
    std::lock_guard<std::mutex> lk(mtx_);
    ++stats_.observations;
}

UdpWireSinkStats UdpWireSink::stats() const {
    std::lock_guard<std::mutex> lk(mtx_);
    return stats_;
}

}  // namespace ma::sim_bridge
