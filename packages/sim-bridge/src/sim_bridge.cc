// mission-app · packages/sim-bridge/src/sim_bridge.cc
//
// 装配 + 确定性自证。
#include "ma/sim_bridge/sim_bridge.h"

#include <sstream>

namespace ma::sim_bridge {

std::string BridgeReport::toText() const {
    std::ostringstream os;
    os << (ok ? "ok" : "failed");
    if (!message.empty()) os << "：" << message;
    for (const auto& i : issues) os << "\n  - " << i;
    return os.str();
}

namespace {

/// 把部署配置里的 (deviceId, groupKey) 摊平成一张查找表。
std::vector<std::pair<std::string, std::string>> deviceGroups(
    const ma::scenario::ScenarioData& data) {
    std::vector<std::pair<std::string, std::string>> rows;
    rows.reserve(data.aircraft.size());
    for (const auto& a : data.aircraft) {
        if (a.groupKey.empty()) continue;
        rows.emplace_back(a.deviceId, a.groupKey);
    }
    return rows;
}

GroupTable groupTableOf(const ma::scenario::ScenarioData& data) {
    GroupTable t;
    for (const auto& kv : data.groupIds()) t.add(kv.first, kv.second);
    return t;
}

}  // namespace

bool build(const sim_source::SimScenario& scenario, const ma::scenario::ScenarioData& data,
           const BridgeOptions& options, Bridge& out, BridgeReport& report) {
    report = BridgeReport{};
    out = Bridge{};

    // ---- 1) 先体检（纯函数，不动任何状态）
    const sim_source::ValidationResult vr = sim_source::SimSource::validate(scenario, options.sim);
    if (!vr.ok) {
        report.message = "中立结构校验未通过（" + std::to_string(vr.issues.size()) + " 条）";
        for (const auto& i : vr.issues) {
            report.issues.push_back(i.path + " · " + i.field + "：" + i.reason);
        }
        return false;
    }

    // ---- 2) 引擎
    out.engine = std::make_unique<sim_source::SimSource>(options.sim);
    const sim_source::ValidationResult ir = out.engine->init(scenario);
    if (!ir.ok) {
        report.message = "init 未通过";
        for (const auto& i : ir.issues) {
            report.issues.push_back(i.path + " · " + i.field + "：" + i.reason);
        }
        out.engine.reset();
        return false;
    }
    out.plan = out.engine->plan();
    if (!out.plan.ok) {
        report.message = "航路规划未通过：" + out.plan.message;
        out.engine.reset();
        return false;
    }

    // ---- 3) 出口（UDP）
    auto sinkOptions = options.sink;
    out.sink = std::make_shared<UdpWireSink>(sinkOptions);
    out.sink->setGroups(groupTableOf(data));
    out.sink->setGroupOfDevice(deviceGroups(data));
    out.engine->setSink(out.sink);

    // ---- 4) 时钟（真实时间；缺参 tick() 才读它，故 useClockWhenTickArgMissing=false 也够）
    out.clock = std::make_shared<WallClock>();
    out.engine->setClock(out.clock);

    // ---- 5) 驱动器（默认用真实时间；要用假时钟的调用方自己换）
    out.driver = std::make_unique<Driver>(*out.engine, out.clock, options.driver);
    out.scenario = scenario;  // 拷贝一份，宿主查询用
    report.ok = true;
    return true;
}

bool sameScenarioTwiceProducesIdenticalFrames(const sim_source::SimScenario& scenario,
                                             const ma::scenario::ScenarioData& data,
                                             const BridgeOptions& options, int steps,
                                             int64_t stepMs, BridgeReport& report) {
    report = BridgeReport{};

    auto runOnce = [&](std::vector<std::string>& frames, std::string& why) -> bool {
        BridgeOptions opts = options;
        opts.sink.dryRun = true;  // 双跑**不发包**：只比报文序列

        // 只校验 + init（不经 build，避免建第 3 个 UDP 套接字）。
        sim_source::SimSource engine(opts.sim);
        const sim_source::ValidationResult ir = engine.init(scenario);
        if (!ir.ok) {
            why = "init 未通过";
            return false;
        }
        auto sink = std::make_shared<UdpWireSink>(opts.sink);
        sink->setGroups(groupTableOf(data));
        sink->setGroupOfDevice(deviceGroups(data));
        engine.setSink(sink);

        // 同一个假时钟、同一串步长 —— 时间完全与挂钟无关。
        auto clock = std::make_shared<FakeClock>(1700000000000LL);
        engine.setClock(clock);
        engine.setSpeed(opts.sim.speedMultiplier);

        const int n = steps > 0 ? steps : 1;
        const std::int64_t dt = stepMs > 0 ? stepMs : 1000;
        for (int i = 0; i < n; ++i) {
            clock->advance(dt);
            engine.tick(clock->nowMs());
            const std::string frame = sink->stats().lastFrame;
            if (!frame.empty()) frames.push_back(frame);
        }
        return true;
    };

    std::vector<std::string> a;
    std::vector<std::string> b;
    std::string why;
    if (!runOnce(a, why)) {
        report.message = "第一跑失败：" + why;
        return false;
    }
    if (!runOnce(b, why)) {
        report.message = "第二跑失败：" + why;
        return false;
    }

    if (a.size() != b.size()) {
        report.message = "两跑报文条数不同：" + std::to_string(a.size()) + " vs " +
                         std::to_string(b.size());
        return false;
    }
    if (a.empty()) {
        report.message = "两跑都没有产出报文（步数/步长太小，仿真没走到发事件的那一刻）";
        return false;
    }
    for (std::size_t i = 0; i < a.size(); ++i) {
        if (a[i] != b[i]) {
            report.message = "第 " + std::to_string(i) + " 条报文不一致";
            report.issues.push_back("A: " + a[i]);
            report.issues.push_back("B: " + b[i]);
            return false;
        }
    }
    report.message = "两跑逐字节一致，共 " + std::to_string(a.size()) + " 条报文";
    report.ok = true;
    return true;
}

}  // namespace ma::sim_bridge
