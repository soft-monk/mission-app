// mission-app · packages/sim-bridge/include/ma/sim_bridge/sim_bridge.h
//
// 把"会动的东西"接到"真实链路"上的那一层。
//
// 上下游（谁都不认识谁，只认识中间这个形状）：
//
//     scenario-data ──SimScenario──▶ sim_source::SimSource ──SimEvent──▶ UdpWireSink
//                                                                          │
//                                                                          ▼ 一行 JSON / 一包 UDP
//                                                                     device-ingest
//
// ★ 三个不可协商的口径：
//   1) 线上格式 = **既有形状**（`kind` 分派 + `uavId/type/groupId/...`）。
//      device-ingest 的 `legacy.kind.v1` 把原始键原样带走、只把 kind 映成事件名；
//      消费方按 uavId / type / groupId 读。所以**字段名一个都不能改**。
//      `tsSource` / `recvAt` / `source` 是接入层语义，本层**不产**（凭空补就是臆造）。
//   2) 时间**只**由 step()/tick() 推进。IClock 只在缺参 tick() 里被读一次。
//      同一份配置 + 同一个假时钟 → 两跑逐字节一致。
//   3) 本层不发广播、不碰数据库、不认识任何模块内部实现。
#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include <ma/scenario/scenario_dataset.h>
#include <sim_source/sim_source.h>

namespace ma::sim_bridge {

/// 线上格式的一行（= 一个 UDP 载荷）。字段名与顺序**冻结**（见本文件顶部口径 1）。
///
/// 为什么用 ordered_json：键序稳定 → 两跑可逐字节比对（确定性验收）。
using json = nlohmann::ordered_json;

/// 一条报文里**由本层填**的那些键（顺序即输出顺序）：
///   kind / uavId / type / groupId / lng / lat / alt / heading / speed / battery / ts / seq
std::vector<std::string> wireFieldOrder();

/// 归属表：groupKey → groupId（由 scenario-data 给，本层只查）。
class GroupTable {
public:
    void add(const std::string& groupKey, const std::string& groupId);
    /// 查不到 → 空串（**不猜**）。
    std::string idOf(const std::string& groupKey) const;

private:
    std::vector<std::pair<std::string, std::string>> rows_;
};

/// 中立事件 → 一行线上报文。
///
/// 映射（逐字段，就这三条）：
///   deviceId   → uavId
///   deviceType → type
///   groupKey   → groupId（经 GroupTable；查不到就不写这个键）
/// 其余字段同名同义直搬；`kind` 原样带走（由引擎注入了 `uav.pos`）。
json toWireFrame(const sim_source::SimEvent& event, const std::string& groupKey,
                 const GroupTable& groups);

/// 本层的自述：把 wire 形状解码回来（排障 / 验收脚本对照用）。
/// 只认上面那批键；缺失的键不在结果里出现。
json decodeWireFrame(const json& frame);

// ============================================================================
// UdpWireSink
// ============================================================================

struct UdpWireSinkOptions {
    std::string host = "127.0.0.1";
    int port = 45500;
    /// 一条报文超过这个字节数就**不截断**而是计入 oversize（宁可看见问题，不要半条 JSON）。
    std::size_t maxFrameBytes = 8192;
    /// true = 只编码不发包（确定性双跑、离线复算用）。
    bool dryRun = false;
    /// 目标 deviceType 的前缀：带此前缀的事件 = **目标**，不是平台。
    std::string targetDeviceTypePrefix = "tgt-";
    /// 是否**把目标也发到线上**。
    ///
    /// 默认 **false**。理由：目标的 kind 与平台不同（契约里目标走 `target.state`、
    /// 平台走 `uav.pos`）。若混进 `telemetry.uav.pos`，前端会把目标当无人机画出来。
    /// 目标的显示属 P4，届时按 `target.state` 单独走一条路，**而不是**打开这个开关。
    bool emitTargets = false;
};

struct UdpWireSinkStats {
    std::uint64_t events = 0;      // onEvent 调用次数
    std::uint64_t observations = 0;  // onObservation 调用次数（本层不外发观测）
    std::uint64_t frames = 0;      // 成功编码的报文数
    std::uint64_t sent = 0;        // sendto 成功次数
    std::uint64_t errors = 0;      // sendto 失败次数
    std::uint64_t oversize = 0;    // 超过 maxFrameBytes 被丢弃的报文数
    /// 被本层挡下的**目标**事件数（见 `UdpWireSinkOptions::emitTargets`）
    std::uint64_t targetsSkipped = 0;
    std::uint64_t sentBytes = 0;
    std::string lastError;
    /// 最近一条报文的原文（排障用；dryRun 时也留）
    std::string lastFrame;
};

/// sim_source::ISimSink 的实现：**唯一**把中立事件翻译成线上格式并发出去的地方。
///
/// 契约（sim-source 明写）：onEvent MUST 立即返回 —— 不在调用路径上做网络 IO / 等锁。
/// 本实现是**同步 sendto 到一个 UDP 套接字**（无连接、无重传、无握手），
/// 这是"不做网络 IO"的最小可辩护形态；要彻底异步可在驱动线程里换成本类的队列化外壳。
class UdpWireSink final : public sim_source::ISimSink {
public:
    explicit UdpWireSink(const UdpWireSinkOptions& options);
    ~UdpWireSink() override;

    UdpWireSink(const UdpWireSink&) = delete;
    UdpWireSink& operator=(const UdpWireSink&) = delete;

    void setGroups(const GroupTable& groups);
    /// 平台 deviceId → groupKey（由装配层从部署配置灌进来）。
    void setGroupOfDevice(const std::vector<std::pair<std::string, std::string>>& rows);

    // ---- ISimSink ----
    void onEvent(const sim_source::SimEvent& event) override;
    void onObservation(const sim_source::SimObservation& obs) override;

    UdpWireSinkStats stats() const;
    const UdpWireSinkOptions& options() const { return options_; }
    /// 套接字是否真的建起来了（dryRun 时恒 false，不算错）。
    bool socketOpen() const;

private:
    bool ensureSocket();

    UdpWireSinkOptions options_;
    GroupTable groups_;
    std::vector<std::pair<std::string, std::string>> groupOfDevice_;
    mutable std::mutex mtx_;
    UdpWireSinkStats stats_;
    std::uint64_t sock_ = static_cast<std::uint64_t>(~0ull);  // INVALID_SOCKET
};

// ============================================================================
// IClock
// ============================================================================

/// 真实时间钟（epoch 毫秒）。**注入给引擎**，引擎自己永远不取挂钟。
class WallClock final : public sim_source::IClock {
public:
    std::int64_t nowMs() const override;
};

/// 假时钟：只走它自己的步进。确定性验收与离线复算用。
class FakeClock final : public sim_source::IClock {
public:
    explicit FakeClock(std::int64_t startMs) : nowMs_(startMs) {}
    std::int64_t nowMs() const override { return nowMs_; }
    void advance(std::int64_t dtMs) { nowMs_ += dtMs; }
    void set(std::int64_t ms) { nowMs_ = ms; }

private:
    std::int64_t nowMs_;
};

// ============================================================================
// Driver：节拍驱动（真实时间 / 倍速 / 暂停 / 单步）
// ============================================================================

struct DriverOptions {
    /// 驱动线程的轮询粒度（毫秒）。真实时间的推进靠它，越小越平滑。
    int tickIntervalMs = 50;
    /// 同一份数据最多跑多久（仿真毫秒）；<= 0 = 不设上限。
    int64_t maxSimMs = 0;
    /// 首次 tick 前是否先把时钟基线对齐（true = 首 tick 只记基线）。
    bool alignOnFirstTick = true;
};

/// 节拍驱动器：**唯一**调 tick()/step() 的地方。
///
/// 线程模型：start() 起**恰好一条**驱动线程；stop() 停它并 join。
/// 引擎本身单线程，所以 tick/step 只在驱动线程里调（pause/单步等控制面经锁串行化）。
class Driver {
public:
    Driver(sim_source::SimSource& engine, std::shared_ptr<sim_source::IClock> clock,
           const DriverOptions& options);
    ~Driver();

    Driver(const Driver&) = delete;
    Driver& operator=(const Driver&) = delete;

    /// 用注入时钟的当前值建立基线（不推进）。
    void primeNow();
    /// 用给定时刻建立基线（可复现路径：灌假时钟）。
    void primeAt(std::int64_t nowMs);

    void start();
    void stop();
    bool running() const;

    /// 控制面（可跨线程调用）。
    bool setSpeed(int multiplier);
    void pause();
    void resume();
    bool paused() const;
    /// 单步：与倍速无关，推 `dtMs` **仿真毫秒**。返回本次事件数。
    int stepOnce(int64_t dtMs);
    /// 立即按当前时钟推进一次（不等轮询粒度）。返回本次事件数。
    int tickOnce();

    sim_source::Metrics metrics() const;
    std::int64_t simElapsedMs() const;

private:
    void loop();

    sim_source::SimSource& engine_;
    std::shared_ptr<sim_source::IClock> clock_;
    DriverOptions options_;
    mutable std::mutex mtx_;
    std::atomic<bool> stop_{false};
    std::atomic<bool> running_{false};
    std::thread thread_;
    bool primed_ = false;
    std::int64_t lastMs_ = 0;
};

// ============================================================================
// 装配入口
// ============================================================================

struct BridgeOptions {
    /// 引擎侧注入项。**defaultKind 必须由装配层显式给出**（引擎的中立占位是 sim.pos）。
    sim_source::SimOptions sim;
    UdpWireSinkOptions sink;
    DriverOptions driver;
    /// 平台 deviceId 的**过线类型**（线格式的 `type`）；缺省 "uav"。
    std::string wireType = "uav";
};

struct BridgeReport {
    bool ok = false;
    std::string message;
    std::vector<std::string> issues;
    std::string toText() const;
};

/// 装配结果：引擎 + 出口 + 驱动器（生命周期一次性交给调用方）。
struct Bridge {
    std::unique_ptr<sim_source::SimSource> engine;
    std::shared_ptr<UdpWireSink> sink;
    std::shared_ptr<sim_source::IClock> clock;
    std::unique_ptr<Driver> driver;
    sim_source::SimScenario scenario;
    sim_source::PlanResult plan;
};

/// 装配：校验 → 规划 → 建引擎 → 注入 sink/clock → 灌归属表。**不启动驱动**。
bool build(const sim_source::SimScenario& scenario, const ma::scenario::ScenarioData& data,
           const BridgeOptions& options, Bridge& out, BridgeReport& report);

/// 确定性自证：把同一个场景跑两遍（同一个假时钟、同一串步长），
/// 逐字节比对两次产生的**报文序列**。返回 false 时 report 给出首个不一致处。
bool sameScenarioTwiceProducesIdenticalFrames(const sim_source::SimScenario& scenario,
                                             const ma::scenario::ScenarioData& data,
                                             const BridgeOptions& options, int steps,
                                             int64_t stepMs, BridgeReport& report);

}  // namespace ma::sim_bridge
