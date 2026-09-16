// mission-app · packages/host/include/ma/adapters.h
//
// 宿主补的那一层：把各模块的**反向接口**（I*Sink / I*Store / IClock / I*Provider）
// 各实现一个最小版本，证明注入路径是通的。
//
// ★ 纪律：这些实现一律**空转**（立即返回、无副作用、无业务规则）。
//   它们存在的意义是"把接口接上"，不是"做事"。
//
// 只 include 各模块的**公开头**（include/<mod>/*.h），MUST NOT include 模块内部文件。
#pragma once

#include <atomic>
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

// ---- 公开头（每个模块只有一个） ----
#include "alert_engine/alert_engine.h"
#include "entity_ledger/entity_ledger.h"
#include "geo_data/clock.h"
#include "geo_data/fs.h"
#include "phase/phase_engine.h"
#include "report_engine/report_engine.h"
#include "resource_alloc/resource_alloc.h"
#include "scoring/scoring.h"
#include "selfcheck/selfcheck.h"
#include "telemetry_store/clock.h"
#include "telemetry_store/store.h"
#include "topology/topology_engine.h"

namespace ma {

/// 注入路径的**证据**：每次进 Sink 就 +1（内容一概不看、不存、不转发）。
class InvocationMeter {
public:
    void bump() { ++count_; }
    std::uint64_t count() const { return count_; }

private:
    std::atomic<std::uint64_t> count_{0};
};

/// 注入路径证据的总账（启动汇总里打印一行，证明"接上了"而不是"编译过了"）。
struct InjectionEvidence {
    std::uint64_t phase = 0;
    std::uint64_t resource = 0;
    std::uint64_t scoring = 0;
    std::uint64_t entity = 0;
    std::uint64_t topology = 0;
    std::uint64_t alert = 0;
    std::uint64_t report = 0;
    std::uint64_t selfcheck = 0;
    std::uint64_t store = 0;

    std::string summary() const;
};

// ============================================================================
// IClock：每个模块一份（各模块的 IClock 是**各自命名空间里的不同类型**）。
// 实现：固定值时钟（确定性）—— 证明"时钟可注入"，而不是回落各模块的 SystemClock。
// ============================================================================
class FixedClock final : public phase::IClock,
                         public resource_alloc::IClock,
                         public scoring::IClock,
                         public entity_ledger::IClock,
                         public topology::IClock,
                         public alert_engine::IClock,
                         public report_engine::IClock,
                         public selfcheck::IClock {
public:
    explicit FixedClock(std::int64_t fixedMs) : fixedMs_(fixedMs) {}

    std::int64_t nowMs() const override { return fixedMs_; }
    std::int64_t fixedMs() const { return fixedMs_; }

private:
    std::int64_t fixedMs_;
};

/// geo-data 的钟是另一个命名空间里的另一份接口。
class GeoClock final : public geo_data::IClock {
public:
    std::int64_t nowMs() const override;
};

/// telemetry-store 的钟（epoch 毫秒）。
class StoreClock final : public telemetry_store::IClock {
public:
    std::int64_t nowMs() const override;
};

// ============================================================================
// I*Sink：全部空转，只计数。
// ============================================================================
class PhaseSink final : public phase::IPhaseSink {
public:
    explicit PhaseSink(InvocationMeter* m) : m_(m) {}
    void onPhaseChanged(const phase::PhaseChangeEvent&) override;
    void onProgress(const phase::ProgressEvent&) override;
    void onStatusChanged(const phase::MissionStatusEvent&) override;

private:
    InvocationMeter* m_;
};

class ResourceSink final : public resource_alloc::IResourceSink {
public:
    explicit ResourceSink(InvocationMeter* m) : m_(m) {}
    void onAllocationChanged(const resource_alloc::AllocationChangeEvent&) override;
    void onTelemetryMerged(const resource_alloc::TelemetryMergedEvent&) override;

private:
    InvocationMeter* m_;
};

class PlanSink final : public scoring::IPlanSink {
public:
    explicit PlanSink(InvocationMeter* m) : m_(m) {}
    void onPlanStateChanged(const scoring::json&) override;

private:
    InvocationMeter* m_;
};

class EntitySink final : public entity_ledger::IEntitySink {
public:
    explicit EntitySink(InvocationMeter* m) : m_(m) {}
    void onEntityChanged(const entity_ledger::EntityChangeEvent&) override;
    void onTargetState(const entity_ledger::TargetStateEvent&) override;
    void onConsistency(const entity_ledger::ConsistencyEvent&) override;

private:
    InvocationMeter* m_;
};

class TopologySink final : public topology::ITopologySink {
public:
    explicit TopologySink(InvocationMeter* m) : m_(m) {}
    void onTopologyChanged(const topology::TopologyChangedEvent&) override;
    void onStateChanged(const topology::StateChange&) override;

private:
    InvocationMeter* m_;
};

class AlertSink final : public alert_engine::IAlertSink {
public:
    explicit AlertSink(InvocationMeter* m) : m_(m) {}
    void onAlertRaised(const alert_engine::AlertDelivery&) override;
    void onAlertUpdated(const alert_engine::AlertDelivery&) override;
    void onAlertAcked(const alert_engine::AlertDelivery&) override;

private:
    InvocationMeter* m_;
};

class ReportSink final : public report_engine::IReportSink {
public:
    explicit ReportSink(InvocationMeter* m) : m_(m) {}
    void onReportReady(const report_engine::ReportReadyPayload&) override;

private:
    InvocationMeter* m_;
};

class SelfCheckSink final : public selfcheck::ISelfCheckSink {
public:
    explicit SelfCheckSink(InvocationMeter* m) : m_(m) {}
    void onProgress(const selfcheck::ProgressEvent&) override;
    void onReady(const selfcheck::ReadyEvent&) override;
    void onDone(const selfcheck::SelfCheckDoneEvent&) override;

private:
    InvocationMeter* m_;
};

// ============================================================================
// I*Store：进程内内存实现（save 恒 true / load 未命中 false / remove 幂等）。
// 刻意用内存而不是文件：P0 只证明"注入路径通"，落盘是后续分期的事。
// ============================================================================
class PhaseStore final : public phase::IPhaseStore {
public:
    bool save(const phase::MissionRecord& rec) override;
    bool load(const std::string& missionId, phase::MissionRecord& out) override;
    bool remove(const std::string& missionId) override;

private:
    std::mutex mtx_;
    std::map<std::string, phase::MissionRecord> rows_;
};

class ResourceStore final : public resource_alloc::IResourceStore {
public:
    bool save(const std::string& targetId, const resource_alloc::json& snapshot) override;
    bool load(const std::string& targetId, resource_alloc::json& out) override;
    bool remove(const std::string& targetId) override;

private:
    std::mutex mtx_;
    std::map<std::string, resource_alloc::json> rows_;
};

class PlanStore final : public scoring::IPlanStore {
public:
    bool save(const scoring::PlanState& st) override;
    bool load(const std::string& missionId, const std::string& planId,
              scoring::PlanState& out) override;

private:
    std::mutex mtx_;
    std::map<std::string, scoring::PlanState> rows_;
};

class EntityStore final : public entity_ledger::IEntityStore {
public:
    bool save(const std::string& missionId, const entity_ledger::json& ledger) override;
    bool load(const std::string& missionId, entity_ledger::json& out) override;
    bool remove(const std::string& missionId) override;

private:
    std::mutex mtx_;
    std::map<std::string, entity_ledger::json> rows_;
};

class TopologyStore final : public topology::ITopologyStore {
public:
    bool save(const std::string& topologyId, const topology::json& snapshot) override;
    bool load(const std::string& topologyId, topology::json& out) override;
    bool remove(const std::string& topologyId) override;

private:
    std::mutex mtx_;
    std::map<std::string, topology::json> rows_;
};

class AlertStore final : public alert_engine::IAlertStore {
public:
    bool save(const alert_engine::AlertRecord& rec) override;
    bool load(const std::string& alertId, alert_engine::AlertRecord& out) override;
    bool remove(const std::string& alertId) override;

private:
    std::mutex mtx_;
    std::map<std::string, alert_engine::AlertRecord> rows_;
};

// ============================================================================
// ILayoutProvider（topology 的坐标来源）：空实现 → 一律解析不到，节点自带坐标即可。
// ============================================================================
class NullLayoutProvider final : public topology::ILayoutProvider {
public:
    bool resolve(const topology::LayoutRequest& req, topology::LayoutPoint& out) override;
};

}  // namespace ma
