// mission-app · packages/host/src/adapters.cc
//
// 各模块反向接口的最小实现 —— 一律空转，只把"被调用过"这个事实记下来。
#include "ma/adapters.h"

#include <chrono>

namespace ma {

namespace {
std::int64_t wallClockMs() {
    return static_cast<std::int64_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch())
            .count());
}
}  // namespace

std::string InjectionEvidence::summary() const {
    return "phase=" + std::to_string(phase) + " resource=" + std::to_string(resource) +
           " scoring=" + std::to_string(scoring) + " entity=" + std::to_string(entity) +
           " topology=" + std::to_string(topology) + " alert=" + std::to_string(alert) +
           " report=" + std::to_string(report) + " selfcheck=" + std::to_string(selfcheck);
}

// ================================================================ 时钟

std::int64_t GeoClock::nowMs() const { return wallClockMs(); }
std::int64_t StoreClock::nowMs() const { return wallClockMs(); }

// ================================================================ 事件出口接线

EventBroadcaster& EventBroadcaster::instance() {
    static EventBroadcaster b;
    return b;
}

void EventBroadcaster::set(Fn fn) {
    std::lock_guard<std::mutex> lk(mtx_);
    fn_ = std::move(fn);
}

bool EventBroadcaster::wired() const {
    std::lock_guard<std::mutex> lk(mtx_);
    return static_cast<bool>(fn_);
}

void EventBroadcaster::emit(const std::string& type, const nlohmann::json& data) const {
    Fn fn;
    {
        std::lock_guard<std::mutex> lk(mtx_);
        fn = fn_;
    }
    if (!fn) return;  // 未接线 = 静默（装配顺序允许"先造引擎、后接广播腿"）
    try {
        fn(type, data);
    } catch (const std::exception&) {
        // 广播失败 MUST NOT 反向影响引擎（模块口径：Sink 里不抛）
    }
}

// ================================================================ Sink
//
// 每个回调做两件事：① 记一次"被调用过"（注入证据）；② 把**引擎给的负载原样**转成一条广播。
// 事件名与 protocol.md §4 已登记名一致；payload 用模块自己的 `toJson()`，宿主不改字段。

void PhaseSink::onPhaseChanged(const phase::PhaseChangeEvent& e) {
    m_->bump();
    EventBroadcaster::instance().emit("mission.phase", e.toJson());
}
void PhaseSink::onProgress(const phase::ProgressEvent& e) {
    m_->bump();
    EventBroadcaster::instance().emit("mission.progress", e.toJson());
}
void PhaseSink::onStatusChanged(const phase::MissionStatusEvent& e) {
    m_->bump();
    EventBroadcaster::instance().emit("mission.status", e.toJson());
}

void ResourceSink::onAllocationChanged(const resource_alloc::AllocationChangeEvent& e) {
    m_->bump();
    EventBroadcaster::instance().emit("resource.allocation.changed", e.toJson());
}
void ResourceSink::onTelemetryMerged(const resource_alloc::TelemetryMergedEvent& e) {
    m_->bump();
    EventBroadcaster::instance().emit("resource.ledger.changed", e.toJson());
}

void PlanSink::onPlanStateChanged(const scoring::json& event) {
    m_->bump();
    EventBroadcaster::instance().emit("plan.state", event);
}

void EntitySink::onEntityChanged(const entity_ledger::EntityChangeEvent& e) {
    m_->bump();
    EventBroadcaster::instance().emit("entity.changed", e.toJson());
}
void EntitySink::onTargetState(const entity_ledger::TargetStateEvent& e) {
    m_->bump();
    EventBroadcaster::instance().emit("target.state", e.toJson());
}
void EntitySink::onConsistency(const entity_ledger::ConsistencyEvent& e) {
    m_->bump();
    EventBroadcaster::instance().emit("entity.consistency", e.toJson());
}

void TopologySink::onTopologyChanged(const topology::TopologyChangedEvent& e) {
    m_->bump();
    EventBroadcaster::instance().emit("topology.changed", e.toJson());
}
void TopologySink::onStateChanged(const topology::StateChange&) { m_->bump(); }

void AlertSink::onAlertRaised(const alert_engine::AlertDelivery& d) {
    m_->bump();
    EventBroadcaster::instance().emit("alert.raised", alert_engine::toJson(d));
}
void AlertSink::onAlertUpdated(const alert_engine::AlertDelivery& d) {
    m_->bump();
    EventBroadcaster::instance().emit("alert.updated", alert_engine::toJson(d));
}
void AlertSink::onAlertAcked(const alert_engine::AlertDelivery& d) {
    m_->bump();
    EventBroadcaster::instance().emit("alert.acked", alert_engine::toJson(d));
}

void ReportSink::onReportReady(const report_engine::ReportReadyPayload& payload) {
    m_->bump();
    EventBroadcaster::instance().emit("report.ready", report_engine::toJson(payload));
}

// selfcheck 的三个出口由 flow.cc 的 FlowSelfCheckSink 负责广播（它同时要更新流程状态）；
// 这里的实现保留给"没接流程层"的场景（例如 --selftest），只记调用。
void SelfCheckSink::onProgress(const selfcheck::ProgressEvent&) { m_->bump(); }
void SelfCheckSink::onReady(const selfcheck::ReadyEvent&) { m_->bump(); }
void SelfCheckSink::onDone(const selfcheck::SelfCheckDoneEvent&) { m_->bump(); }

// ================================================================ Store（进程内内存）

bool PhaseStore::save(const phase::MissionRecord& rec) {
    std::lock_guard<std::mutex> lk(mtx_);
    rows_[rec.id] = rec;
    return true;
}
bool PhaseStore::load(const std::string& missionId, phase::MissionRecord& out) {
    std::lock_guard<std::mutex> lk(mtx_);
    const auto it = rows_.find(missionId);
    if (it == rows_.end()) return false;  // 不存在 MUST NOT 用空记录当命中
    out = it->second;
    return true;
}
bool PhaseStore::remove(const std::string& missionId) {
    std::lock_guard<std::mutex> lk(mtx_);
    rows_.erase(missionId);
    return true;
}

bool ResourceStore::save(const std::string& targetId, const resource_alloc::json& snapshot) {
    std::lock_guard<std::mutex> lk(mtx_);
    rows_[targetId] = snapshot;
    return true;
}
bool ResourceStore::load(const std::string& targetId, resource_alloc::json& out) {
    std::lock_guard<std::mutex> lk(mtx_);
    const auto it = rows_.find(targetId);
    if (it == rows_.end()) return false;
    out = it->second;
    return true;
}
bool ResourceStore::remove(const std::string& targetId) {
    std::lock_guard<std::mutex> lk(mtx_);
    rows_.erase(targetId);
    return true;
}

bool PlanStore::save(const scoring::PlanState& st) {
    std::lock_guard<std::mutex> lk(mtx_);
    rows_[st.missionId + "/" + st.planId] = st;
    return true;
}
bool PlanStore::load(const std::string& missionId, const std::string& planId,
                     scoring::PlanState& out) {
    std::lock_guard<std::mutex> lk(mtx_);
    const auto it = rows_.find(missionId + "/" + planId);
    if (it == rows_.end()) return false;
    out = it->second;
    return true;
}

bool EntityStore::save(const std::string& missionId, const entity_ledger::json& ledger) {
    std::lock_guard<std::mutex> lk(mtx_);
    rows_[missionId] = ledger;
    return true;
}
bool EntityStore::load(const std::string& missionId, entity_ledger::json& out) {
    std::lock_guard<std::mutex> lk(mtx_);
    const auto it = rows_.find(missionId);
    if (it == rows_.end()) return false;
    out = it->second;
    return true;
}
bool EntityStore::remove(const std::string& missionId) {
    std::lock_guard<std::mutex> lk(mtx_);
    rows_.erase(missionId);
    return true;
}

bool TopologyStore::save(const std::string& topologyId, const topology::json& snapshot) {
    std::lock_guard<std::mutex> lk(mtx_);
    rows_[topologyId] = snapshot;
    return true;
}
bool TopologyStore::load(const std::string& topologyId, topology::json& out) {
    std::lock_guard<std::mutex> lk(mtx_);
    const auto it = rows_.find(topologyId);
    if (it == rows_.end()) return false;
    out = it->second;
    return true;
}
bool TopologyStore::remove(const std::string& topologyId) {
    std::lock_guard<std::mutex> lk(mtx_);
    rows_.erase(topologyId);
    return true;
}

bool AlertStore::save(const alert_engine::AlertRecord& rec) {
    std::lock_guard<std::mutex> lk(mtx_);
    rows_[rec.alertId] = rec;
    return true;
}
bool AlertStore::load(const std::string& alertId, alert_engine::AlertRecord& out) {
    std::lock_guard<std::mutex> lk(mtx_);
    const auto it = rows_.find(alertId);
    if (it == rows_.end()) return false;
    out = it->second;
    return true;
}
bool AlertStore::remove(const std::string& alertId) {
    std::lock_guard<std::mutex> lk(mtx_);
    rows_.erase(alertId);
    return true;
}

// ================================================================ Layout（空实现）

bool NullLayoutProvider::resolve(const topology::LayoutRequest& req, topology::LayoutPoint& out) {
    (void)req;
    (void)out;
    return false;  // 解析不到 → 节点自带坐标即可（引擎侧有明确降级语义）
}

}  // namespace ma
