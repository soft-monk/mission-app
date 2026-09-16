// mission-app · packages/host/src/flow.cc
//
// 流程装配层实现。三条口径反复出现在注释里，先写在文件头：
//   ① **不编数字**：进度、状态、文案全部来自引擎（其取值来自规则包）。本文件里没有任何
//      中文文案常量（除了流程步骤标题），没有"写死 68%"这回事。
//   ② **不问两次同样的问题**：模块就绪判定按"真实条件"轮询（接入层真的在收包、台账里真的
//      有在线设备），轮询只是为了等**条件成立**，不是为了凑时间。
//   ③ **引擎不是线程安全的**：命令面来自 Drogon 的多个 IO 线程 → 本层用一把锁串行化；
//      启动加载在工作线程里跑，锁的粒度是"每一次问引擎"，不是整段启动。
#include "ma/flow.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdint>
#include <filesystem>
#include <set>
#include <sstream>
#include <thread>

#include <trantor/utils/Logger.h>

#if MA_WITH_SELFCHECK && MA_WITH_PROBES_MAPAPP
#include "mapapp/probe_pack.h"
#endif

namespace ma {

namespace {

int64_t wallClockMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}

using nlohmann::json;

/// 11 步表（与《业务层宿主层实施方案》§2 一一对应）
const std::vector<FlowStep>& kSteps() {
    static const std::vector<FlowStep> k = {
        {1, "boot", "启动加载界面", ""},
        {2, "selfcheck", "自检校验界面", ""},
        {3, "situation", "任务态势界面", "T0"},
        {4, "grouping", "无人机分组与任务编组", "T1"},
        {5, "groupConfirm", "编组确认界面", "T1"},
        {6, "execute", "任务执行界面", "T2"},
        {7, "targets", "实时侦察目标显示", "T4"},
        {8, "strike", "任务决策与打击准备", "T5"},
        {9, "strikeConfirm", "打击方案确认", "T5"},
        {10, "guidance", "协同执行与引导", "T6"},
        {11, "summary", "任务总结界面", "T7"},
    };
    return k;
}

/// 把 JSON 里的整数字段读出来（缺/类型不对 → 默认值）。宿主只做类型收敛，不做语义判断。
int intOr(const json& j, const char* key, int dflt) {
    const auto it = j.find(key);
    if (it == j.end() || !it->is_number_integer()) return dflt;
    return it->get<int>();
}

// ============================================================================
// 步 8–9（P5）共用工具：**只做形状翻译与算式展开**
// ============================================================================
//
// ★ 这两条函数的措辞就是本段的纪律：
//   · `timeText`：时刻的**展示形态**（+08:00）。不改数值、不做时区业务判断。
//   · `distanceM`：两点大圆距离（米）。它只服务"到达段"的算式 —— **不是**地图投影、
//     **不是**航路规划（`geo-data` 才是几何引擎；这里只是把"平台→IP 点"的直线距离算出来，
//     让时间轴上每一分钟都能被脚本复算）。半径取 WGS84 平均半径（与 `sensor-model` 同口径）。
constexpr double kEarthRadiusM = 6371008.8;

double rad(double deg) { return deg * 3.14159265358979323846 / 180.0; }

double distanceM(double lng1, double lat1, double lng2, double lat2) {
    const double dLat = rad(lat2 - lat1);
    const double dLng = rad(lng2 - lng1);
    const double a = std::sin(dLat / 2) * std::sin(dLat / 2) +
                     std::cos(rad(lat1)) * std::cos(rad(lat2)) * std::sin(dLng / 2) *
                         std::sin(dLng / 2);
    const double c = 2 * std::atan2(std::sqrt(a), std::sqrt(1 - a));
    return kEarthRadiusM * c;
}

/// 一串航点的折线总长（米）。相邻点逐个大圆距离求和 —— 与 `distanceM` 同一口径。
double polylineLengthM(const std::vector<std::pair<double, double>>& pts) {
    double sum = 0.0;
    for (std::size_t i = 1; i < pts.size(); ++i) {
        sum += distanceM(pts[i - 1].first, pts[i - 1].second, pts[i].first, pts[i].second);
    }
    return sum;
}

/// epoch ms → "YYYY-MM-DD HH:MM:SS+08:00"（**只做展示**：数值本身仍是 ms）。
///
/// 为什么是 +08:00 固定偏移而不是本地时区：场景数据 `task-areas.json` 的 `startAt`
/// 是 `"2026-09-16 15:14"`（北京时），t0 与它必须能被人眼直接对上（时区换算不是宿主该做的事，
/// 换个时区跑这条时间轴就会对不上数据源）。
std::string timeText(int64_t ms) {
    if (ms == 0) return {};
    const int64_t kOffset = 8 * 3600;  // +08:00
    int64_t sec = ms / 1000 + kOffset;
    int64_t days = sec / 86400;
    int64_t rem = sec % 86400;
    if (rem < 0) {
        rem += 86400;
        --days;
    }
    // civil_from_days（Howard Hinnant 的算法；只用到 1970..2400 这一段）
    int64_t z = days + 719468;
    const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
    const int64_t doe = z - era * 146097;
    const int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    const int64_t y = yoe + era * 400;
    const int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const int64_t mp = (5 * doy + 2) / 153;
    const int64_t d = doy - (153 * mp + 2) / 5 + 1;
    const int64_t m = mp < 10 ? mp + 3 : mp - 9;
    const int64_t yy = m <= 2 ? y + 1 : y;
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%04lld-%02lld-%02lldT%02lld:%02lld:%02lld+08:00",
                  static_cast<long long>(yy), static_cast<long long>(m),
                  static_cast<long long>(d), static_cast<long long>(rem / 3600),
                  static_cast<long long>((rem % 3600) / 60), static_cast<long long>(rem % 60));
    return std::string(buf);
}

/// `"YYYY-MM-DD HH:MM"`（场景数据的写法）→ epoch ms（+08:00 口径）。解析不了 → 0（不猜）。
int64_t parseSceneTimeMs(const std::string& text) {
    int Y = 0, M = 0, D = 0, h = 0, mi = 0;
    if (std::sscanf(text.c_str(), "%d-%d-%d %d:%d", &Y, &M, &D, &h, &mi) != 5) return 0;
    if (Y < 1970 || M < 1 || M > 12 || D < 1 || D > 31) return 0;
    // days_from_civil（同上算法的逆）
    const int64_t y = Y - (M <= 2 ? 1 : 0);
    const int64_t era = (y >= 0 ? y : y - 399) / 400;
    const int64_t yoe = y - era * 400;
    const int64_t doy = (153 * (M + (M > 2 ? -3 : 9)) + 2) / 5 + D - 1;
    const int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    const int64_t days = era * 146097 + doe - 719468;
    return ((days * 24 + h) * 60 + mi) * 60000 - 8 * 3600 * 1000;  // 减掉 +08:00 偏移
}

/// 一个带算式的时刻段。`formula` 是人可读的算式、`inputs` 是**算式里的每一个输入**
/// （值 + 出处），这样脚本可以独立复算并与 `atMs` 比对（不一致就红）。
nlohmann::json basisJson(const std::string& formula, const nlohmann::json& inputs,
                         const std::string& source) {
    nlohmann::json b = nlohmann::json::object();
    b["formula"] = formula;
    b["inputs"] = inputs;
    b["source"] = source;
    return b;
}

}  // namespace

const std::vector<FlowStep>& flowSteps() { return kSteps(); }

const FlowStep* flowStepOf(int step) {
    for (const auto& s : kSteps()) {
        if (s.step == step) return &s;
    }
    return nullptr;
}

const FlowStep* flowStepByKey(const std::string& key) {
    for (const auto& s : kSteps()) {
        if (key == s.key) return &s;
    }
    return nullptr;
}

// ============================================================================
// 反向接口实现：自检出口 → WS 广播（引擎只发事件，不广播；广播是宿主的事）
// ============================================================================
#if MA_WITH_SELFCHECK

namespace {

/// 把引擎的三个出口事件原样广播成已登记事件名（protocol §4.4）。
class FlowSelfCheckSink final : public selfcheck::ISelfCheckSink {
public:
    explicit FlowSelfCheckSink(std::function<void(const std::string&, const json&)> b)
        : broadcast_(std::move(b)) {}

    void onProgress(const selfcheck::ProgressEvent& e) override {
        if (broadcast_) broadcast_("selfcheck.progress", e.toJson());
    }
    void onReady(const selfcheck::ReadyEvent& e) override {
        if (broadcast_) broadcast_("selfcheck.ready", e.toJson());
    }
    void onDone(const selfcheck::SelfCheckDoneEvent& e) override {
        if (broadcast_) broadcast_("selfcheck.done", e.toJson());
    }

private:
    std::function<void(const std::string&, const json&)> broadcast_;
};

/// 引擎时钟：真实挂钟（P5：epoch 毫秒）。抽出来是为了让 `/health` 的 checkedAt 可被验收。
class FlowClock final : public selfcheck::IClock {
public:
    int64_t nowMs() const override { return wallClockMs(); }
};

}  // namespace

#endif  // MA_WITH_SELFCHECK

// ============================================================================
// 构造 / 依赖
// ============================================================================

FlowEngine::FlowEngine(Engines& engines, Registry& reg, const HostConfig& cfg)
    : engines_(engines), reg_(reg), cfg_(cfg) {
#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST && MA_WITH_SENSOR_MODEL
    // 探测结果的落账出口：**在这里接线**（装配顺序上 sensorBridge 早于本对象）。
    // 回调来自仿真驱动线程 —— 见 onDetection 的线程说明（只碰 detectMtx_）。
    if (engines_.sensorBridge) {
        engines_.sensorBridge->setDetectionSink(
            [this](const ma::sensor_bridge::Detection& d) { onDetection(d); });
        LOG_INFO << "[flow] 探测模型已接线：" << engines_.sensorNote;
    } else {
        LOG_WARN << "[flow] 探测模型未装配：" << engines_.sensorNote;
    }
#endif
}

FlowEngine::~FlowEngine() {
#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST && MA_WITH_SENSOR_MODEL
    // 先摘回调（driver 已在 engines.stop() 里停掉；这里只是不给"悬空的 this"留机会）
    if (engines_.sensorBridge) engines_.sensorBridge->setDetectionSink(nullptr);
#endif
    if (bootThread_.joinable()) bootThread_.join();
}

void FlowEngine::setBroadcaster(Broadcaster b) { broadcast_ = std::move(b); }
void FlowEngine::setClientCounter(ClientCounter c) { clients_ = std::move(c); }
void FlowEngine::setCapabilityProbe(CapabilityProbe p) { capabilityProbe_ = std::move(p); }

std::string FlowEngine::summary() const {
    std::ostringstream os;
    os << "step=" << step_ << (phase_.empty() ? "（未进入任务）" : " phase=" + phase_);
    os << " selfcheck=" << (selfCheckReady_ ? "已装载" : "未装载");
    if (!selfCheckNote_.empty()) os << "（" << selfCheckNote_ << "）";
    return os.str();
}

// ============================================================================
// selfcheck 装载与探针注册
// ============================================================================

bool FlowEngine::initSelfCheck() {
#if MA_WITH_SELFCHECK
    if (!engines_.selfCheckEngine) {
        selfCheckNote_ = "selfcheck 未装配（编译期 MA_WITH_SELFCHECK=0）";
        return false;
    }
    auto* engine = engines_.selfCheckEngine.get();

    {
        std::lock_guard<std::mutex> lk(mtx_);
        flowClock_ = std::make_shared<FlowClock>();
        engine->setClock(flowClock_);
        // 广播腿：三个出口事件直接转 WS（sink 立即返回，不阻塞引擎）
        flowSink_ = std::make_shared<FlowSelfCheckSink>(
            [this](const std::string& type, const json& data) {
                if (broadcast_) broadcast_(type, data);
            });
        engine->setSink(flowSink_);
        if (clients_) engine->setWsClientsSource(clients_);
    }

    // ---- 规则包（kind:"probes"）：文案、分组、等级映射、进度源全在里面
    if (!cfg_.selfcheckPolicies.empty()) {
        const std::string path = cfg_.selfcheckPolicies;
        const selfcheck::LoadResult lr = engine->loadPoliciesFile(path);
        if (lr.code != 0) {
            selfCheckNote_ = "规则包装载失败（" + path + "）：code=" + std::to_string(lr.code);
            for (const auto& i : lr.issues) {
                selfCheckNote_ += " " + i.path + "." + i.field + ":" + i.reason;
            }
            return false;
        }
    } else {
        selfCheckNote_ = "未配置 selfcheck.policies（自检与启动进度不可用）";
        return false;
    }

    refreshCapabilities();
    selfCheckReady_ = true;
    return true;
#else
    selfCheckNote_ = "selfcheck 未装配（编译期 MA_WITH_SELFCHECK=0）";
    return false;
#endif
}

void FlowEngine::refreshCapabilities() {
#if MA_WITH_SELFCHECK && MA_WITH_PROBES_MAPAPP
    if (!engines_.selfCheckEngine) return;
    // 能力快照由宿主采集（真实读数：瓦片/接入/台账/存储）；采集器缺省 = 全中性。
    nlohmann::json caps = nlohmann::json::object();
    if (capabilityProbe_) {
        try {
            caps = capabilityProbe_();
        } catch (const std::exception& e) {
            LOG_WARN << "[flow] 能力快照采集失败：" << e.what();
        }
    }
    mapapp_probes::Capabilities c;
    if (!cfg_.selfcheckCapabilities.empty()) {
        std::string err;
        if (mapapp_probes::Capabilities::load(cfg_.selfcheckCapabilities, c, &err)) {
            // 文件是缺省值，宿主的真实读数覆盖它（真实状态优先于兜底文件）
            for (auto it = caps.begin(); it != caps.end(); ++it) c.set(it.key(), it.value());
        } else {
            LOG_WARN << "[flow] 能力快照文件读不到（" << cfg_.selfcheckCapabilities
                     << "）：" << err << " —— 只用宿主实测值";
            for (auto it = caps.begin(); it != caps.end(); ++it) c.set(it.key(), it.value());
        }
    } else {
        for (auto it = caps.begin(); it != caps.end(); ++it) c.set(it.key(), it.value());
    }
    std::lock_guard<std::mutex> lk(mtx_);
    const int n = mapapp_probes::registerAll(*engines_.selfCheckEngine, c);
    LOG_INFO << "[flow] 探针已注册 " << n << " 条（规则侧探针包 probes_mapapp）";
#else
    // 没链上探针包：如实记一行，不让它挡住启动
    LOG_WARN << "[flow] 探针包未链接（MA_WITH_PROBES_MAPAPP=0）：自检项会报"未注册"";
#endif
}

#if MA_WITH_SELFCHECK

void FlowEngine::storeReport(const selfcheck::Report& rep) {
    lastReport_ = rep;
    hasReport_ = true;
}

const selfcheck::Report& FlowEngine::report(bool runIfMissing) {
    if (!hasReport_ && runIfMissing && engines_.selfCheckEngine) {
        std::lock_guard<std::mutex> lk(mtx_);
        storeReport(engines_.selfCheckEngine->run(selfcheck::RunOptions{}));
    }
    return lastReport_;
}

selfcheck::Report FlowEngine::runSelfCheck(bool bypassCache,
                                           const std::vector<std::string>& onlyKeys,
                                           bool silent) {
    selfcheck::RunOptions o;
    o.bypassCache = bypassCache;
    o.silent = silent;
    if (!onlyKeys.empty()) o.onlyKeys = onlyKeys;
    std::lock_guard<std::mutex> lk(mtx_);
    return engines_.selfCheckEngine->run(o);
}

nlohmann::json FlowEngine::itemsJson(const std::vector<selfcheck::ItemResult>& items) {
    nlohmann::json out = nlohmann::json::array();
    for (const auto& it : items) out.push_back(it.toJson());
    return out;
}

#endif  // MA_WITH_SELFCHECK

// ============================================================================
// 启动加载（真实就绪判定 → 引擎进度源）
// ============================================================================
//
// 进度阶梯（**每一级都由真实事件触发**，不是计时器）：
//   10  = 该模块的体检已开始（本轮启动序列走到它了）
//   50  = 已完成至少一次真实体检（结论好坏都算"体检过"）
//   100 = 规则包判定该模块就绪（`status == "ok"`，取值口径由规则包 levels 段给出）
// 未到 100 的会按 `waitMs` 轮询等待——"接入层还没收到第一个包""台账里还没有在线设备"
// 在启动阶段是**正常的瞬时状态**，等的就是它自己变好。
nlohmann::json FlowEngine::bootRunOnce(int pacingMs) {
    nlohmann::json out = nlohmann::json::object();
#if MA_WITH_SELFCHECK
    if (!selfCheckReady_) {
        out["ok"] = false;
        out["note"] = selfCheckNote_.empty() ? "selfcheck 未就绪" : selfCheckNote_;
        return out;
    }
    auto* engine = engines_.selfCheckEngine.get();

    // 模块清单**从引擎的进度源读**（它由规则包 `progress.sources` 建立，见 selfcheck 的
    // loadPolicies 实现）——宿主只认引擎公开面，**不解析规则包原文**。
    //
    // 踩过的坑：`effectivePolicies()` 返回的是**生效规则摘要**（PoliciesInfo::toJson：
    // 命名空间/版本/摘要/探针引用/超时…），**不含 `modules` 段**；拿它当规则包原文找
    // `modules` 会永远找不到，表现为"启动加载一点动静都没有"（早期版本就是这么错的）。
    std::vector<selfcheck::ProgressSourceDef> sources;
    {
        std::lock_guard<std::mutex> lk(mtx_);
        sources = engine->progressSources();
    }
    LOG_INFO << "[flow] 启动加载：进度源 " << sources.size() << " 个（来自规则包 progress.sources）";
    if (sources.empty()) {
        out["ok"] = false;
        out["note"] = "引擎没有进度源（规则包 progress.sources 缺失或未装载）";
        return out;
    }

    const int waitMs = 12000;      // 单模块等待上限（真实条件不成立就如实停在 50）
    const int pollMs = 300;

    for (const auto& src : sources) {
        const std::string key = src.key;
        if (key.empty()) continue;

        // ① 开始体检
        {
            std::lock_guard<std::mutex> lk(mtx_);
            const bool took = engine->setProgress(key, 10, true);
            (void)took;  // 返回值只用于排障，正式路径不关心（无法写 = 规则包没这个进度源）
        }

        // ② 体检 + 等真实条件成立
        //
        // 每一轮都重新采一次能力快照并重注册探针：启动阶段"接入层还没收到第一个包""台账里
        // 还没有在线设备"是**正常的瞬时状态**，等的就是它自己变好 —— 所以必须拿最新读数问。
        bool ok = false;
        int waited = 0;
        int metric = -1;
        std::string status, detail;
        while (true) {
            refreshCapabilities();
            const selfcheck::Report rep = runSelfCheck(true, {key}, true);
            storeReport(rep);
            for (const auto& item : rep.modules) {
                if (item.key != key) continue;
                status = item.status;
                detail = item.detail;
                metric = item.metric;
            }
            ok = (status == "ok");
            if (ok || waited >= waitMs) break;
            std::this_thread::sleep_for(std::chrono::milliseconds(pollMs));
            waited += pollMs;
        }

        {
            std::lock_guard<std::mutex> lk(mtx_);
            engine->setProgress(key, 50);              // 真实：已体检过
            if (ok) engine->setProgress(key, 100);     // 真实：规则包判定就绪
            LOG_INFO << "[flow] 启动加载：" << key << " 就绪=" << (ok ? 1 : 0)
                     << " status=" << status << " 等待 " << waited << "ms 总进度="
                     << engine->progressPayload().value("overall", 0);
        }

        if (pacingMs > 0) std::this_thread::sleep_for(std::chrono::milliseconds(pacingMs));

        nlohmann::json row = nlohmann::json::object();
        row["key"] = key;
        row["name"] = src.name.empty() ? key : src.name;
        row["ok"] = ok;
        row["status"] = status;
        row["detail"] = detail;
        row["metric"] = metric;
        row["waitedMs"] = waited;
        out["modules"].push_back(row);
    }

    {
        std::lock_guard<std::mutex> lk(mtx_);
        out["overall"] = engine->overallProgress();
        out["complete"] = engine->bootComplete();
        out["progress"] = engine->progressPayload();
    }
    out["ok"] = true;
    return out;
#else
    out["ok"] = false;
    out["note"] = selfCheckNote_;
    return out;
#endif
}

void FlowEngine::startBoot(int pacingMs) {
    if (bootRunning_.exchange(true)) return;
    if (bootThread_.joinable()) bootThread_.join();
    bootThread_ = std::thread([this, pacingMs] {
        // ★ 工作线程里的异常**必须**自己收住：跨线程逃逸会直接 std::terminate，
        //   而"启动没动静"最难查的就是这种静默死亡。收住之后如实记一行。
        try {
            const nlohmann::json r = bootRunOnce(pacingMs);
            {
                std::lock_guard<std::mutex> lk(mtx_);
                lastBoot_ = r;
            }
            const bool complete = r.value("complete", false);
            LOG_INFO << "[flow] 启动加载完成：overall=" << r.value("overall", 0)
                     << (complete ? "（全部就绪）" : "（有模块未就绪，见 /api/state）");
            if (complete) {
                // 加载完成 → 自动进入第 2 步（自检校验界面）。这是流程骨架，不是业务判断：
                // Excel 步 1→2 的关系就是"加载完成后自动弹出自检界面"。
                {
                    std::lock_guard<std::mutex> lk(mtx_);
                    if (step_ < 2) step_ = 2;
                }
                broadcastFlowState();
            }
        } catch (const std::exception& e) {
            LOG_ERROR << "[flow] 启动加载线程异常：" << e.what();
        } catch (...) {
            LOG_ERROR << "[flow] 启动加载线程未知异常";
        }
        bootRunning_.store(false);
    });
}

// ============================================================================
// 状态 / 健康 / 命令面
// ============================================================================

void FlowEngine::broadcastFlowState() {
    if (!broadcast_) return;
    nlohmann::json data = nlohmann::json::object();
    const FlowStep* s = flowStepOf(step_);
    data["step"] = step_;
    data["stepKey"] = s ? s->key : "";
    data["stepTitle"] = s ? s->title : "";
    data["phase"] = phase_;
    data["missionId"] = missionId_;
    data["enteredAt"] = enteredAtMs_;
    data["ts"] = wallClockMs();
    broadcast_("flow.state", data);
}

nlohmann::json FlowEngine::stateJson() {
    // 能力快照要**跟着现实走**：探针注册时按值捕获快照，只在启动加载时重采的话，
    // 底部状态条会永远停在"启动那一刻"的读数（例如 数据链路 一直显示"中断"，
    // 哪怕包早就在收了）。这里按 5 s 节流重采一次 —— 前端 500 ms 轮询也不会打爆它。
    {
        const int64_t now = wallClockMs();
        bool refresh = false;
        {
            std::lock_guard<std::mutex> lk(mtx_);
            if (now - lastCapabilityMs_ >= 5000) {
                lastCapabilityMs_ = now;
                refresh = true;
            }
        }
        if (refresh) refreshCapabilities();
    }

    nlohmann::json out = nlohmann::json::object();
    out["version"] = "mission-app 0.2.0";
    out["ts"] = wallClockMs();

    const FlowStep* s = flowStepOf(step_);
    out["step"] = step_;
    out["stepKey"] = s ? s->key : "";
    out["stepTitle"] = s ? s->title : "";
    // 阶段与"当前阶段进入时刻"一律**现读引擎台账**（`phaseContext`）：这两个字段是"实时状态"，
    // 不能只报宿主缓存的旧值 —— 缓存会在"复位后重建任务/引擎返回 0"等路径上变陈旧，
    // 症状是前端显示上一个任务的阶段与时刻（踩过：t0 比 enteredAt 还晚）。
    {
        std::lock_guard<std::mutex> lk(mtx_);
        const PhaseView pv = phaseViewLocked();
        out["phase"] = pv.phaseKey.empty() ? phase_ : pv.phaseKey;
        // ★ 引擎没给 enteredAt 时**如实报 null**，不要拿宿主缓存顶替 —— 缓存可能来自上一个任务，
        //   症状是"当前阶段进入时刻早于任务下达时刻"（自相矛盾的时间，排障时最误导人）。
        out["enteredAt"] = pv.enteredAt != 0 ? nlohmann::json(pv.enteredAt) : nlohmann::json(nullptr);
        out["enteredAtKnown"] = pv.enteredAt != 0;
        out["phaseFromEngine"] = pv.fromEngine;
        out["missionStartMs"] = missionStartMs_;   // 时间轴 t0 的锚点（任务下达时刻）
    }
    out["missionId"] = missionId_;

    // ---- 启动加载（进度源 + 最近一次模块体检结论）----
    nlohmann::json boot = nlohmann::json::object();
#if MA_WITH_SELFCHECK
    if (selfCheckReady_) {
        std::lock_guard<std::mutex> lk(mtx_);
        // 引擎的 JSON 是 `ordered_json`（键序稳定）；转成宿主用的 `json` 再外发。
        const nlohmann::json pg = engines_.selfCheckEngine->progressPayload();
        boot["progress"] = pg;
        boot["complete"] = engines_.selfCheckEngine->bootComplete();
        boot["overall"] = engines_.selfCheckEngine->overallProgress();

        // 模块卡片的显示名/状态/说明取自**最近一次报告**（规则包给的文案）
        nlohmann::json cards = nlohmann::json::array();
        nlohmann::json items = nlohmann::json::array();
        if (pg.is_object() && pg.contains("items") && pg["items"].is_array()) items = pg["items"];
        for (const auto& it : items) {
            nlohmann::json card = nlohmann::json::object();
            const std::string key = it.value("key", std::string());
            card["key"] = key;
            card["percent"] = it.value("percent", 0);
            for (const auto& item : lastReport_.modules) {
                if (item.key != key) continue;
                card["name"] = item.name;
                card["level"] = selfcheck::toString(item.level);
                card["status"] = item.status;
                card["detail"] = item.detail;
                card["metric"] = item.metric;
            }
            cards.push_back(card);
        }
        boot["modules"] = cards;
    }
    if (!lastBoot_.is_null() && lastBoot_.is_object() && lastBoot_.contains("modules")) {
        boot["lastRun"] = lastBoot_;
    }
    boot["note"] = selfCheckNote_;
#else
    boot["note"] = selfCheckNote_;
#endif
    out["boot"] = boot;

    // ---- 自检 / 概览 / 状态条：**原样**转发引擎负载 ----
#if MA_WITH_SELFCHECK
    if (selfCheckReady_) {
        const selfcheck::Report& rep = report(true);
        nlohmann::json sc = nlohmann::json::object();
        sc["status"] = rep.status;
        sc["checkedAt"] = rep.checkedAtMs;
        sc["checkedAtText"] = rep.checkedAtText;
        sc["elapsedMs"] = rep.elapsedMs;
        sc["partial"] = rep.partial;
        sc["cached"] = rep.cached;
        sc["items"] = itemsJson(rep.selfCheck);
        sc["failures"] = nlohmann::json::array();
        for (const auto& f : rep.failures) sc["failures"].push_back(f.toJson());
        out["selfCheck"] = sc;
        out["systemOverview"] = itemsJson(rep.overview);
        out["statusBar"] = itemsJson(rep.statusBar);
        out["selfCheckReady"] = true;
    } else {
        out["selfCheckReady"] = false;
        out["selfCheckNote"] = selfCheckNote_;
    }
#else
    out["selfCheckReady"] = false;
#endif

    out["wsClients"] = clients_ ? clients_() : 0;

    // ---- 步 6–7（P4）：仿真读数 + 媒体通道 + 探测可用性（前端三处都要）----
    //
    // 事件面（`sim.state` / `media.channels`）是给"变化时推送"的；/api/state 放一份当前值，
    // 这样前端刚挂载时不必等下一次事件。
#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST
    {
        std::lock_guard<std::mutex> lk(mtx_);
        out["simulation"] = simStateJsonLocked();
    }
#endif
    out["media"] = mediaChannelsJson();
    {
        nlohmann::json sen = nlohmann::json::object();
        sen["available"] = false;
        sen["note"] = sensorNote();
#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST && MA_WITH_SENSOR_MODEL
        if (engines_.sensorBridge) {
            sen["available"] = true;
            sen["enabled"] = engines_.sensorBridge->enabled();
            sen["rangeScale"] = engines_.sensorBridge->rangeScale();
            sen["attachments"] = static_cast<int>(engines_.sensorAttachments.size());
            sen["note"] = engines_.sensorNote;
        }
#endif
        out["sensor"] = std::move(sen);
    }

    // 能力快照（真实读数）：前端做演示与排障都要看它
    if (capabilityProbe_) {
        try {
            out["capabilities"] = capabilityProbe_();
        } catch (const std::exception& e) {
            out["capabilities"] = {{"error", e.what()}};
        }
    }

    // ---- 步 8–9（P5）：打击方案 / 引导方案（**引擎与场景的原样读数**）----
    //
    // 三样东西放这里（都只是"最近一次命令的结果"，不重算）：
    //   · strikes   = 最近一次 `strike.plans` 的原样负载（含 M5 字段与几何标注）
    //   · adoption  = 采纳/确认状态（宿主侧指针；引擎里的三态用 scoring 的 `plans()` 查）
    //   · guidance  = 最近一次 `guidance.plan` 的原样负载（IP 点 + 引导连线 + 时间轴）
    // 前端刚挂载时不必等命令就能画出步 8/9 的屏幕。
    {
        std::lock_guard<std::mutex> lk(mtx_);
        nlohmann::json strike = nlohmann::json::object();
        strike["plans"] = lastStrikePlans_;
        strike["plansAvailable"] = !lastStrikePlans_.empty();
        strike["adoptedPlanId"] = adoptedStrikePlanId_;
        strike["confirmedPlanId"] = confirmedStrikePlanId_;
        strike["recommendedId"] = lastStrikeRecommendation_;
        strike["recommendedPercent"] = lastStrikeRecommendedPercent_;
        strike["hasRecommendation"] = hasStrikeScore_;
        strike["modeOverride"] = strikeModeOverride_;
        strike["guidance"] = lastGuidance_;
        strike["guidanceAvailable"] = !lastGuidance_.empty();
        out["strike"] = std::move(strike);
        // 已登记平台（引导连线的起点来源）：deviceId → entityId
        nlohmann::json reg = nlohmann::json::object();
        for (const auto& kv : entityIdOfDevice_) reg[kv.first] = kv.second;
        out["platformEntities"] = reg;

        // ---- 步 10–11（P6）：执行记录 + 最近一次报告（**原样回执**，前端挂载即可画）----
        nlohmann::json execs = nlohmann::json::array();
        for (const auto& kv : execRecords_) {
            const ExecRecord& r = kv.second;
            execs.push_back({{"entityId", r.entityId},
                             {"missionId", r.missionId},
                             {"planId", r.planId},
                             {"stateBefore", r.stateBefore},
                             {"stateAfter", r.stateAfter},
                             {"hitPlatformId", r.hitPlatformId},
                             {"appliedActions", r.appliedActions},
                             {"atMs", r.atMs},
                             {"aborted", r.aborted}});
        }
        out["exec"] = {{"records", execs},
                       {"count", static_cast<int>(execRecords_.size())},
                       {"diveApplied", execDiveCount_},
                       {"note", "执行记录来自 exec.run 的引擎裁决（动作/状态/读数派生命中）；"
                                "完整回执在 exec.run / exec.abort 的 data 里"}};
        out["report"] = {{"available", !lastReportRun_.empty()},
                         {"last", lastReportRun_}};
        // 时间轴：与 `mission.timeline`、`report.generate` **同一份字节**（三处逐字相等是构造保证）
        out["timeline"] = phaseDurationsLocked();
    }
    return out;
}

nlohmann::json FlowEngine::healthJson() {
#if MA_WITH_SELFCHECK
    if (selfCheckReady_ && engines_.selfCheckEngine) {
        std::lock_guard<std::mutex> lk(mtx_);
        nlohmann::json out = engines_.selfCheckEngine->healthPayload();
        return out;
    }
#endif
    // 未装配：仍返回**形状合法**的负载（六个字段都在），status 如实写 unknown
    nlohmann::json out = nlohmann::json::object();
    out["status"] = "unknown";
    out["checkedAt"] = wallClockMs();
    out["modules"] = nlohmann::json::array();
    out["selfCheck"] = nlohmann::json::array();
    out["systemOverview"] = nlohmann::json::array();
    out["wsClients"] = clients_ ? clients_() : 0;
    return out;
}

bool FlowEngine::bootComplete() {
#if MA_WITH_SELFCHECK
    if (!selfCheckReady_ || !engines_.selfCheckEngine) return false;
    std::lock_guard<std::mutex> lk(mtx_);
    return engines_.selfCheckEngine->bootComplete();
#else
    return false;
#endif
}

namespace {

/// 统一回执。`code=0` = 成功；其余码见 protocol §3。
nlohmann::json reply(const std::string& verb, int code, nlohmann::json data) {
    nlohmann::json out = nlohmann::json::object();
    out["code"] = code;
    out["verb"] = verb;
    if (code == 0) {
        out["data"] = std::move(data);
    } else {
        out["error"] = std::move(data);
    }
    return out;
}

nlohmann::json badRequest(const std::string& verb, const std::string& message) {
    return reply(verb, 1000, {{"message", message}});
}

// ============================================================================
// 步 3–5（P3）共用工具：**只做形状翻译**（宿主层唯一被允许做的事）
//
// 三条口径（与文件头三条一一对应）：
//   ① 数值一律来自引擎（台账 `statsJson` / 评分 `ScoreResult` / 场景配置 / 阶段引擎负载），
//      宿主不算分、不补百分比、不填假数；缺输入 → 按缺项回执并在 `notes` 里如实标注。
//   ② 引擎之间**刻意不互相 include**（protocol P1），所以跨引擎的入参映射只能由宿主写：
//      `phase` / `resource_alloc` / `scoring` 各有一份自己的 `PhaseContext`（同形五字段），
//      view-composer 同理 —— 本层就是那本映射。
//   ③ 所有引擎调用都在 `FlowEngine::mtx_` 里（**调用方持锁**，见各工具函数的注释）。
// ============================================================================

/// 阶段 key → Excel 步骤号。只做映射：**能不能进由 phase-engine 的 Gate 裁决**，宿主不判。
int stepForPhase(const std::string& phaseKey) {
    if (phaseKey == "T0") return 3;
    if (phaseKey == "T1") return 4;
    if (phaseKey == "T2" || phaseKey == "T3") return 6;
    if (phaseKey == "T4") return 7;
    if (phaseKey == "T5") return 8;
    if (phaseKey == "T6") return 10;
    if (phaseKey == "T7") return 11;
    return 0;  // 未声明 → 保持当前步（不猜）
}

/// 场景键 = 场景目录名（`ScenarioData::scenarioKey` 的口径，见 scenario_dataset.h:172）。
std::string scenarioKeyOf(const Engines& e) {
#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST
    if (!e.scenarioData.scenarioKey.empty()) return e.scenarioData.scenarioKey;
#else
    (void)e;
#endif
    return {};
}

/// 场景里的一台我方平台（**逐字段来自 deployment.json**，宿主不加工数值）。
///
/// 结构体本身不带场景类型，所以**无条件声明**：`scenario-data` 没装配时它只是个空容器，
/// "没有平台"这件事由调用方如实标注，而不是靠编译期把整段代码抹掉。
struct PlatformRow {
    std::string deviceId;
    std::string model;      // deployment.json 的 typeKey（= resource-alloc 的型号 key）
    std::string groupKey;
    std::string groupName;
    std::string homeArea;
    std::string taskArea;
    double lng = 0;
    double lat = 0;
    double alt = 0;
    double speed = 0;
    double battery = 0;
    std::vector<std::string> payload;
};

#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST

/// 场景编制里"编组 key → 显示名"的清单（= deployment.json groups[]）。
std::vector<std::pair<std::string, std::string>> scenarioGroupsOf(const Engines& e) {
    std::vector<std::pair<std::string, std::string>> out;
    for (const auto& g : e.scenarioData.groups) out.emplace_back(g.key, g.name);
    return out;
}

/// 场景编制的平台清单 + 编组显示名（调用方持锁；这里只读装配期装载好的配置）。
std::vector<PlatformRow> platformsOf(const Engines& e) {
    std::vector<PlatformRow> rows;
    const auto& sd = e.scenarioData;
    for (const auto& a : sd.aircraft) {
        PlatformRow r;
        r.deviceId = a.deviceId;
        r.model = a.typeKey;
        r.groupKey = a.groupKey;
        for (const auto& g : sd.groups) {
            if (g.key == a.groupKey) r.groupName = g.name;
        }
        r.homeArea = a.homeArea;
        r.taskArea = a.taskArea;
        r.lng = a.stationLng;
        r.lat = a.stationLat;
        r.alt = a.altM;
        r.speed = a.speedMps;
        r.battery = a.battery;
        r.payload = a.payload;
        rows.push_back(std::move(r));
    }
    return rows;
}

#endif  // MA_WITH_SIM_SOURCE && MA_WITH_INGEST

#if MA_WITH_VIEW_COMPOSER

/// 五字段同形映射：宿主手里的"当前阶段" → `view_composer::PhaseContext`。
/// 只映射，不解释：`phaseKey` / `seq` / `scenarioKey` / `enteredAt` / `missionId` 一一对应。
view_composer::PhaseContext toViewPhaseContext(const std::string& phaseKey, int seq,
                                               const std::string& scenarioKey, int64_t enteredAt,
                                               const std::string& missionId) {
    view_composer::PhaseContext out;
    out.phaseKey = phaseKey;
    out.seq = seq;
    out.scenarioKey = scenarioKey;
    out.enteredAt = enteredAt;
    out.missionId = missionId;
    return out;
}

#endif  // MA_WITH_VIEW_COMPOSER

#if MA_WITH_SCORING

/// 同上：`scoring::PhaseContext` 也是本仓的本地镜像（scoring.h:71-77）。
scoring::PhaseContext toScoringPhaseContext(const std::string& phaseKey, int seq,
                                            const std::string& scenarioKey, int64_t enteredAt,
                                            const std::string& missionId) {
    scoring::PhaseContext out;
    out.phaseKey = phaseKey;
    out.seq = seq;
    out.scenarioKey = scenarioKey;
    out.enteredAt = enteredAt;
    out.missionId = missionId;
    return out;
}

#endif  // MA_WITH_SCORING

#if MA_WITH_RESOURCE

/// 同上：`resource_alloc::PhaseContext` 也是本仓的本地镜像（resource_alloc.h:66-72）。
resource_alloc::PhaseContext toResourcePhaseContext(const std::string& phaseKey, int seq,
                                                    const std::string& scenarioKey,
                                                    int64_t enteredAt, const std::string& missionId) {
    resource_alloc::PhaseContext out;
    out.phaseKey = phaseKey;
    out.seq = seq;
    out.scenarioKey = scenarioKey;
    out.enteredAt = enteredAt;
    out.missionId = missionId;
    return out;
}

/// 台账初始化（**幂等**口径由宿主守住）。
///
/// ⚠️ 引擎的 `initializeLedger(targetId, scenarioKey)`（resource_alloc.h:645）是"**重建**型号行"：
/// 它把 `allocated` 清零、`clusters` 清空（src/policies_ops.cc:266-288）。所以"幂等初始化"
/// 的正确做法是 **先查台账在不在**（`statsJson` 目标不存在 → `nullopt`），不在才初始化 ——
/// 每次请求都调一遍会把已经生效的编组抹掉。
struct LedgerInit {
    int code = 0;
    std::string message;
    bool created = false;
};

LedgerInit ensureLedger(Engines& e, const std::string& targetId, const std::string& scenarioKey) {
    LedgerInit out;
    if (!e.resource) {
        out.code = 1005;
        out.message = "resource-alloc 未装配";
        return out;
    }
    if (targetId.empty()) {
        out.code = 1003;
        out.message = "targetId 为空（台账按任务隔离：先 flow.enter）";
        return out;
    }
    if (e.resource->statsJson(targetId).has_value()) {
        out.message = "台账已存在（未重建：initializeLedger 会清零已分配量）";
        return out;
    }
    const resource_alloc::PoliciesResult r = e.resource->initializeLedger(targetId, scenarioKey);
    out.code = r.code;
    out.message = r.message;
    out.created = (r.code == 0);
    if (r.code != 0) {
        for (const auto& i : r.issues) out.message += " " + i.path + "." + i.field + ":" + i.reason;
    }
    return out;
}

#endif  // MA_WITH_RESOURCE

#if MA_WITH_RESOURCE && MA_WITH_SCORING

/// 集群用量（`scoring::ClusterUsage`，scoring.h:271-277）的**真填**：
///   ① 台账里已经有集群（编组执行过）→ 取 resource-alloc 的统计视图 `statsJson().clusters[]`
///      （`total` = 该集群已分配器材件数、`clusterId` = 集群 key）；
///   ② 台账里还没有集群（首次编组前）→ 取**场景编制**（`ScenarioData.groups[]` × 各集群平台数）。
/// 两条都是真实数据（一条来自引擎、一条来自场景配置），谁被用了写进 `notes`。
std::vector<scoring::ClusterUsage> clusterUsageOf(Engines& e, const std::string& targetId,
                                                   const std::string& phaseKey,
                                                   nlohmann::json& notes) {
    std::vector<scoring::ClusterUsage> out;
#if MA_WITH_RESOURCE
    if (e.resource) {
        const auto stats = e.resource->statsJson(targetId);
        if (stats.has_value()) {
            const auto it = stats->find("clusters");
            if (it != stats->end() && it->is_array() && !it->empty()) {
                for (const auto& c : *it) {
                    scoring::ClusterUsage u;
                    u.clusterId = c.value("clusterId", std::string());
                    u.phaseKey = phaseKey;
                    u.total = static_cast<int>(c.value("allocatedTotal", static_cast<int64_t>(0)));
                    u.available = true;
                    u.present = true;
                    out.push_back(std::move(u));
                }
                notes.push_back("resources.clusters 来源：resource-alloc 台账 statsJson().clusters[]（"
                                "total = 该集群已分配件数），共 " + std::to_string(out.size()) + " 个集群");
                return out;
            }
        }
    }
#endif
#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST
    {
        const auto rows = platformsOf(e);
        const auto& sd = e.scenarioData;
        for (const auto& g : sd.groups) {
            scoring::ClusterUsage u;
            u.clusterId = g.key;  // 集群 key（CTR-PL-08：MUST NOT 用显示名当 key）
            u.phaseKey = phaseKey;
            int n = 0;
            for (const auto& r : rows) {
                if (r.groupKey == g.key) ++n;
            }
            u.total = n;
            u.available = true;
            u.present = true;
            out.push_back(std::move(u));
        }
        if (!out.empty()) {
            notes.push_back("resources.clusters 来源：场景编制（deployment.json groups[] × 各集群平台数），"
                            "共 " + std::to_string(out.size()) + " 个集群（台账尚未编组）");
            return out;
        }
    }
#endif
    notes.push_back("resources.clusters 为空：台账无集群且场景编制不可用（scenario-data 未装配）");
    return out;
}

/// 评分输入快照（`scoring::ScoringSnapshot`，scoring.h:319-328）的真填。
/// 每个字段要么来自引擎/场景的真实读数，要么**留空并在 `notes` 里点名**（MUST NOT 编造）。
scoring::ScoringSnapshot buildSnapshot(Engines& e, const std::string& targetId,
                                       const scoring::PhaseContext& phase,
                                       const std::string& scenarioKey, nlohmann::json& notes) {
    scoring::ScoringSnapshot snap;
    snap.missionId = targetId;
    snap.phase = phase;

    // ---- resources：真填（集群用量 + 利用率）
    scoring::ResourceSnapshot res;
    res.phase = phase;
    res.clusters = clusterUsageOf(e, targetId, phase.phaseKey, notes);
    res.present = !res.clusters.empty();
    snap.resources = res;

    // ---- resourceUtilization：台账的真实读数（`StatsView.utilization`，口径由引擎规则包定）
    bool hasUtil = false;
    double util = 0.0;
#if MA_WITH_RESOURCE
    if (e.resource) {
        const auto stats = e.resource->statsJson(targetId);
        if (stats.has_value()) {
            util = stats->value("utilization", 0.0);
            hasUtil = true;
        }
    }
#endif
    snap.resourceUtilization = util;
    snap.hasResourceUtilization = hasUtil;
    notes.push_back(hasUtil ? ("resourceUtilization = 台账实测 " + std::to_string(util) +
                               "（statsJson().utilization）")
                            : "resourceUtilization 留空：台账未初始化");

    // ---- targets：来自 entity-ledger 的只读台账；空台账 = **present=false**（不假造目标）
    bool hasTargets = false;
#if MA_WITH_LEDGER
    if (e.entityLedger) {
        const auto rows = e.entityLedger->listEntities(entity_ledger::EntityQuery{targetId});
        if (!rows.empty()) {
            scoring::TargetList tl;
            tl.phase = phase;
            tl.present = true;
            for (const auto& r : rows) {
                tl.targetIds.push_back(r.id);
                tl.confidences.push_back(static_cast<int>(r.confidence * 100.0 + 0.5));
            }
            tl.modelCount = static_cast<int>(rows.size());
            snap.targets = tl;
            hasTargets = true;
        }
    }
#endif
    if (!hasTargets) {
        notes.push_back("targets 留空（present=false）：entity-ledger 台账当前没有实体 —— "
                        "相关指标按规则包中性值/baseline 处理并标 missingMarker，评分不失败");
    } else {
        notes.push_back("targets 来源：entity-ledger 台账快照 " +
                        std::to_string(snap.targets->targetIds.size()) + " 条（真实台账，不是宿主造的清单）");
    }

    // ---- topology：**刻意不填**（链路评估腿未接；引擎按规则包 neutralOnMissing 处理）
    notes.push_back("topology 留空（present=false）：宿主尚未把 topology 的链路评估喂进来 —— "
                    "linkStability 等项走规则包 baseline + missingMarker=link-eval-missing");

    // ---- extra：宿主附加（引擎原样进审计三件套，不解释）
    nlohmann::json extra = nlohmann::json::object();
    extra["scenarioKey"] = scenarioKey;
    extra["phaseKey"] = phase.phaseKey;
    extra["targetId"] = targetId;
    extra["source"] = "ma::FlowEngine（宿主装配层：resource-alloc 台账 + 场景编制 + entity-ledger 快照）";
    snap.extra = extra;
    return snap;
}

#endif  // MA_WITH_RESOURCE && MA_WITH_SCORING

}  // namespace

// ============================================================================
// 当前阶段 / 台账快照（其它引擎要的"当前阶段"只能经这里取）
// ============================================================================

void FlowEngine::resetMissionLocked() {
    // 只清**宿主侧的当前任务指针**与流程状态；引擎里的旧任务/旧台账/旧实体**一律保留**
    // （按 missionId 隔离，删了反而丢掉可追溯性）。下一次 flow.enter 会建新任务。
    missionId_.clear();
    phase_.clear();
    enteredAtMs_ = 0;
    missionStartMs_ = 0;   // 任务下达时刻（t0 的锚点）随任务一起清
    adoptedPlanId_.clear();
    confirmedPlanId_.clear();
    hasPlanScore_ = false;
    lastPlanRecommendation_.clear();
    lastPlanRecommendedPercent_ = 0;
    step_ = 1;
    // 步 6–7（P4）：探测落账的当前任务也要跟着清（否则探测结果会落到旧任务名下）；
    // 拓扑装配标记同样复位（新任务 = 新拓扑；不 reset 会沿用上一轮的链路状态）。
    {
        std::lock_guard<std::mutex> dl(detectMtx_);
        detectMissionId_.clear();
        detectEntityOf_.clear();
    }
    topologyReady_ = false;
    topologyMissionId_.clear();
    topologyLinkTo_.clear();
    simAutoStarted_ = false;
    // 步 8–9（P5）：打击侧状态与"已登记平台"映射跟着任务走（台账按 missionId 隔离，
    // 旧任务里的 entityId 在新任务里查不到 —— 留着只会让引导连线指到别的任务）。
    hasStrikeScore_ = false;
    lastStrikeRecommendation_.clear();
    lastStrikeRecommendedPercent_ = 0;
    adoptedStrikePlanId_.clear();
    confirmedStrikePlanId_.clear();
    lastStrikePlans_ = nlohmann::json::object();
    lastGuidance_ = nlohmann::json::object();
    strikeModeOverride_ = nlohmann::json::object();
    entityIdOfDevice_.clear();
}

FlowEngine::PhaseView FlowEngine::phaseViewLocked() const {    PhaseView v;
    v.missionId = missionId_;
    v.phaseKey = phase_;
    v.enteredAt = enteredAtMs_;
    v.scenarioKey = scenarioKeyOf(engines_);
#if MA_WITH_PHASE
    // 权威来源：phase-engine 的 `phaseContext(missionId)`（公开头 :594，其它引擎取"当前阶段"的唯一来源）
    if (engines_.phase && !missionId_.empty()) {
        const std::optional<phase::PhaseContext> ctx = engines_.phase->phaseContext(missionId_);
        if (ctx.has_value()) {
            v.missionId = ctx->missionId.empty() ? missionId_ : ctx->missionId;
            v.phaseKey = ctx->phaseKey;
            v.seq = ctx->seq;
            if (!ctx->scenarioKey.empty()) v.scenarioKey = ctx->scenarioKey;
            v.enteredAt = ctx->enteredAt;
            v.fromEngine = true;
        }
    }
    // seq 缺席（引擎里还没这个任务）时从定义查一次；查不到就保持 0（不猜）
    if (!v.fromEngine && !v.phaseKey.empty() && engines_.phase) {
        const std::optional<phase::PhaseDef> def = engines_.phase->phaseDef(v.phaseKey);
        if (def.has_value()) v.seq = def->seq;
    }
#endif
    return v;
}

nlohmann::json FlowEngine::ledgerSnapshotLocked() const {
#if MA_WITH_LEDGER
    // 只读快照：引擎自己对 `IEntityStore::save` 收到的形状（entity_ledger.h:1342）。
    // 空台账 → 空对象：view-composer 收到空快照 = **放弃 id 校验**（不算失败，VWC-NFR-02）。
    if (engines_.entityLedger && !missionId_.empty()) {
        const entity_ledger::json snap = engines_.entityLedger->ledgerSnapshot(missionId_);
        return nlohmann::json::parse(snap.dump());
    }
#endif
    return nlohmann::json::object();
}

// ============================================================================
// 步 6–7（P4）：仿真节拍 / 探测落账 / 链路评估 / 覆盖率
// ============================================================================
//
// 三条贯穿这段代码的口径：
//   ① **读数全部来自引擎**：running/paused/speed/simElapsedMs 来自 `Driver` 与 `Metrics`；
//      覆盖率/遍历周期来自 `sensor_model::cover/revisitPeriodMs`；链路状态来自 topology 的
//      `linkQualities()` + 规则包 linkThresholds.json 的 states/hysteresis（原样回执）。
//   ② **线程纪律**：仿真驱动在它自己的线程里跑（Driver），探测回调在**驱动线程**里进来，
//      线上报文在**接入层线程**里进来。前者只碰 `detectMtx_`，后者只入队；
//      所有引擎调用仍然只在命令线程、`mtx_` 之下发生。
//   ③ **不编数**：任何拿不到的输入留空并在 `notes` 里点名（本层从 P3 起就守这条）。

#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST

nlohmann::json FlowEngine::simStateJsonLocked() const {
    // 冻结形状（流程接口冻结 §1）：{running, speed, simElapsedMs, platforms, emitted}
    // 取值逐项来自引擎：Driver::running/paused + SimSource::metrics()/capabilities()。
    nlohmann::json d = nlohmann::json::object();
    d["running"] = false;
    d["paused"] = false;
    d["speed"] = 1;
    d["simElapsedMs"] = 0;
    d["platforms"] = 0;
    d["emitted"] = 0;
    if (!engines_.bridge.engine) {
        d["note"] = "仿真源未装配（sim-source / 接入层未编译进来）";
        return d;
    }
    const sim_source::Metrics m = engines_.bridge.engine->metrics();
    const sim_source::Capabilities cap = engines_.bridge.engine->capabilities();
    d["running"] = engines_.bridge.driver != nullptr && engines_.bridge.driver->running();
    d["paused"] = cap.paused;
    d["speed"] = cap.speedMultiplier;
    d["simElapsedMs"] = m.simElapsedMs;
    d["platforms"] = cap.platforms;
    d["emitted"] = m.eventsEmitted;
    // 排障/自证用的扩展读数（前端只用上面那五个键；多出来的键不改语义）
    d["ticks"] = m.ticks;
    d["steps"] = m.steps;
    d["observations"] = m.observationsEmitted;
    d["sensorCalls"] = m.sensorCalls;
    d["sensorErrors"] = m.sensorErrors;
    d["pausedMs"] = m.pausedMs;
    d["popupSpawned"] = m.popupSpawned;
    d["arrivals"] = m.arrivals;
    d["scenarioKey"] = cap.scenarioKey;
    d["source"] = "sim_source::Metrics + Capabilities（宿主只搬运）";
    return d;
}

void FlowEngine::broadcastSimState() {
    if (!broadcast_) return;
    broadcast_("sim.state", simStateJsonLocked());
}

nlohmann::json FlowEngine::autoStartSimLocked() {
    nlohmann::json d = nlohmann::json::object();
    d["autoStart"] = true;
    d["requested"] = true;
    if (!engines_.bridge.engine || !engines_.bridge.driver) {
        d["started"] = false;
        d["reason"] = "仿真源未装配（sim-source / 接入层未编译进来）";
        return d;
    }
    if (engines_.bridge.driver->running() && !engines_.bridge.driver->paused()) {
        d["started"] = false;
        d["idempotent"] = true;
        d["reason"] = "仿真节拍已在运行（自动起飞幂等命中）";
        d["state"] = simStateJsonLocked();
        return d;
    }
    // "起飞" = 让仿真时间开始走：没起线程就起线程；起了但引擎处于暂停 → 恢复
    // （否则会出现"start 调用成功、时间却一动不动"的假成功）。
    std::string action;
    if (!engines_.bridge.driver->running()) {
        engines_.bridge.driver->primeNow();   // 先对齐时钟基线（首 tick 只记基线）
        engines_.bridge.driver->start();
        d["started"] = true;
        action = "start";
    }
    if (engines_.bridge.driver->paused()) {
        engines_.bridge.driver->resume();
        d["resumed"] = true;
        action = action.empty() ? "resume" : (action + "+resume");
    }
    simAutoStarted_ = true;
    d["started"] = true;
    d["action"] = action;
    d["note"] = "已自动起飞：流程进入步 6（任务执行）→ 宿主调 Driver 让仿真时间开始走";
    d["state"] = simStateJsonLocked();
    return d;
}

// ============================================================================
// P7：`sim.reset` —— 把**仿真源**重建到初始状态（不重启进程也能重跑一遍）
// ============================================================================
//
// 与 `mission.reset` / `boot.reset` 的分工（这是 P7 的关键前置，也是实测踩出来的）：
//   · 那两个 verb 只清**任务与阶段**（missionId/phase/已采纳方案/启动进度）；
//   · 仿真本身**回不到起点**——平台已经飞完、已经 `arrived`、已经被 `exec.run` 换过高度/速度档。
//     只清计数器的"重置"是假的：第二遍跑出来的是一个接着上一轮的场面。
// 所以真正的重置只能重建引擎对象：`Engines::rebuildSimulation()`（停旧驱动 → 与装配期同一条路
// 重新装载 → 重建探测适配器）。宿主这一层只做**重建之后必须补的三件接线**：
//   ① 探测出口：新 `SensorBridge` 的 `DetectionFn` 捕获的是本对象（装配期那次在构造函数里挂过，
//      重建后 MUST 重新挂，否则探测结果再也不会落台账 —— 症状是第二遍没有目标）；
//   ② 线上报文累加器与拓扑装配标记（新引擎 = 新样本，旧的 seq 断号会把 lossRate 算成假象）；
//   ③ 倍速与"跑/暂停"的运行态（按**重建前的实测读数**恢复：演示的链路不能因为重置而断掉，
//      否则 device-ingest 的 3 s 失联判定把设备全判离线，启动加载的第 1 步就再也过不去）。
nlohmann::json FlowEngine::rebuildSimLocked(int& code) {
    nlohmann::json d = nlohmann::json::object();
    nlohmann::json notes = nlohmann::json::array();

    // ---- ⓪ 重建前的现场读数（回执里要给"重置前 vs 重置后"的对照）----
    int speedBefore = cfg_.simSpeed;
    int64_t elapsedBefore = 0;
    int64_t emittedBefore = 0;
    int64_t ticksBefore = 0;
    bool wasRunning = false;
    bool wasPaused = false;
    if (engines_.bridge.engine) {
        const sim_source::Metrics m = engines_.bridge.engine->metrics();
        elapsedBefore = m.simElapsedMs;
        emittedBefore = m.eventsEmitted;
        ticksBefore = m.ticks;
        speedBefore = engines_.bridge.engine->capabilities().speedMultiplier;
    }
    if (engines_.bridge.driver) {
        wasRunning = engines_.bridge.driver->running();
        wasPaused = engines_.bridge.driver->paused();
    }
    d["before"] = {{"simElapsedMs", elapsedBefore},
                   {"speed", speedBefore},
                   {"running", wasRunning},
                   {"paused", wasPaused},
                   {"emitted", emittedBefore},
                   {"ticks", ticksBefore}};

    // ---- ① 重建（停旧驱动 → 与装配期同一条路重新装载）----
    std::string err;
    const bool ok = engines_.rebuildSimulation(cfg_.simKind, cfg_.simWireType, cfg_.ingestHost,
                                               cfg_.ingestPort(), err);
    if (!ok) {
        code = 1005;
        d["reset"] = false;
        d["message"] = "仿真源重建失败：" + err;
        // 如实给出**失败后的现场**（引擎可能是 nullptr）：不写"看起来重置了"的半真话。
        d["state"] = simStateJsonLocked();
        notes.push_back("重建失败 → 没有做任何恢复动作（倍速/运行态），现场读数见 data.state；"
                        "接入点与 hub 未动（重建只影响进程内的仿真对象）");
        d["notes"] = notes;
        LOG_ERROR << "[flow] sim.reset 失败：" << err;
        return d;
    }

    // ---- ② 探测出口重新接线（新 SensorBridge → 本对象）----
#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST && MA_WITH_SENSOR_MODEL
    if (engines_.sensorBridge) {
        engines_.sensorBridge->setDetectionSink(
            [this](const ma::sensor_bridge::Detection& det) { onDetection(det); });
        notes.push_back("探测出口已重挂：新 SensorBridge（" +
                        std::to_string(engines_.sensorAttachments.size()) + " 条挂接）→ FlowEngine::onDetection");
    } else {
        notes.push_back("探测适配器未装配（" + engines_.sensorNote + "）→ 第 7 步的目标只能靠既有台账");
    }
#endif

    // ---- ③ 宿主侧仿真读数复位（新引擎 = 新样本；拓扑装配标记一并复位）----
    {
        std::lock_guard<std::mutex> wl(wireMtx_);
        wireAgg_.clear();
        wireTotal_ = 0;
        wireUnmapped_ = 0;
        wireWindows_ = 0;
    }
    topologyReady_ = false;
    topologyMissionId_.clear();
    topologyLinkTo_.clear();
    topologyIngests_ = 0;
    topologyLinkSamples_ = 0;
    {
        // 探测判重表按 "missionId/targetId" 存，新任务天然不命中；这里顺手清掉旧键，
        // 免得它无限长（计数器是**进程累计的诊断读数**，不清零，如实保留）。
        std::lock_guard<std::mutex> dl(detectMtx_);
        detectEntityOf_.clear();
    }

    // ---- ④ 倍速与运行态恢复（按重建前的实测读数）----
    auto& drv = *engines_.bridge.driver;
    int speed = speedBefore > 0 ? speedBefore : cfg_.simSpeed;
    bool speedOk = drv.setSpeed(speed);
    if (!speedOk) {
        // 引擎只认 1/8/60；重建前那个值若不在取值域（理论上不会），落到 1 并如实记下来。
        speed = 1;
        speedOk = drv.setSpeed(speed);
        notes.push_back("重建前的倍速不在引擎取值域 → 已回落到 1x（引擎 setSpeed 只接受 1/8/60）");
    }
    drv.primeNow();  // 先对齐时钟基线（首 tick 不推进：新引擎的 simElapsedMs 从这里重新计时）

    // ★ `simElapsedMs: 0` 是**实测读数**：读在 `primeNow()` 之后、`start()` 之前 ——
    //   新引擎尚未 tick，所以它精确为 0（不是写死的常量）。
    const int64_t elapsedAfter = engines_.bridge.engine->metrics().simElapsedMs;
    const int64_t emittedAfter = engines_.bridge.engine->metrics().eventsEmitted;
    const int platforms = engines_.bridge.engine->capabilities().platforms;

    bool resumed = false;
    if (wasRunning) {
        drv.start();
        resumed = true;
        if (wasPaused) drv.pause();   // 重建前是暂停 → 重建后仍然暂停（状态原样，不替用户做决定）
    }

    d["reset"] = true;
    d["simElapsedMs"] = elapsedAfter;      // 重建那一刻的读数（= 0）
    d["platforms"] = platforms;
    d["speed"] = engines_.bridge.engine->capabilities().speedMultiplier;  // 重建后的**真实**倍速
    d["attachments"] = static_cast<int>(engines_.sensorAttachments.size());
    d["emitted"] = emittedAfter;
    d["resumed"] = resumed;
    d["paused"] = drv.paused();
    d["speedAccepted"] = speedOk;
    d["after"] = simStateJsonLocked();
    d["source"] =
        "Engines::rebuildSimulation（停旧驱动 → loadScenario 重读本地配置 → sim_bridge::build "
        "新建 SimSource/UdpWireSink/Driver → attachSensorModel 重建规格与挂接）；"
        "接入点与 hub 未动（target=" + engines_.ingestEndpoint + "）";
    notes.push_back("接入点/接入层/hub **一概未动**：只有进程内的仿真对象被换掉（同一 host:port）");
    notes.push_back("平台与实体回到装配期坐标：SimSource::init(场景) 重建 → 俯冲剖面（exec.run 对"
                    "高度/速度档的改写）与 arrived 状态都不再存在");
    if (!wasRunning) {
        notes.push_back("重建前仿真未在跑 → 重建后**保持不跑**（只 primeNow；起飞由步 6 的 "
                        "mission.advance/sim.start 触发）");
    } else {
        notes.push_back("重建前仿真在跑 → 重建后按同一倍速复跑（不这样做的话 device-ingest 的 "
                        "3 s 失联判定会把设备全判离线，启动加载的第 1 步过不去）");
    }
    d["notes"] = notes;
    LOG_INFO << "[flow] sim.reset：重建完成 platforms=" << platforms << " speed=" << speed
             << " attachments=" << engines_.sensorAttachments.size()
             << "（重建前 elapsed=" << elapsedBefore << "ms speed=" << speedBefore
             << " running=" << (wasRunning ? 1 : 0) << "）";
    return d;
}

#endif  // MA_WITH_SIM_SOURCE && MA_WITH_INGEST

// ---------------------------------------------------------------- 线上报文入队

void FlowEngine::onWireEvent(const std::string& type, const nlohmann::json& data, int64_t recvAtMs) {
    (void)type;  // 事件名不参与形状判定：认的是"这行报文里有没有 uavId"（线格式的事实）
    if (!data.is_object()) return;
    const auto it = data.find("uavId");
    if (it == data.end() || !it->is_string()) return;
    const std::string deviceId = it->get<std::string>();
    if (deviceId.empty()) return;

    int64_t seq = -1;
    {
        const auto s = data.find("seq");
        if (s != data.end() && s->is_number_integer()) seq = s->get<int64_t>();
    }
    int64_t simTs = 0;
    {
        const auto s = data.find("ts");
        if (s != data.end() && s->is_number_integer()) simTs = s->get<int64_t>();
    }
    const std::size_t bytes = data.dump().size();

    // **逐链路累加**（不做队列：队列溢出会把宿主自己的丢帧算成链路丢包，实测踩过）。
    std::lock_guard<std::mutex> lk(wireMtx_);
    ++wireTotal_;
    WireAgg& a = wireAgg_[deviceId];
    if (a.frames == 0) {
        a.deviceType = data.value("type", std::string());
        a.groupId = data.value("groupId", std::string());
        a.firstMs = recvAtMs;
    }
    a.frames += 1;
    a.bytes += static_cast<int64_t>(bytes);
    if (recvAtMs > a.lastMs) a.lastMs = recvAtMs;
    if (seq >= 0) {
        if (a.lastSeq >= 0 && seq > a.lastSeq + 1) a.gaps += (seq - a.lastSeq - 1);
        if (seq > a.lastSeq) a.lastSeq = seq;
    }
    a.simTs = simTs;
}

#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST && MA_WITH_SENSOR_MODEL

// ---------------------------------------------------------------- 探测 → 台账

std::map<std::string, std::string> FlowEngine::targetTypeKeysLocked() const {
    std::map<std::string, std::string> out;
#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST
    // 场景数据是**唯一**的 id → typeKey 来源（typeKey 必须是规则包 entityTypes.json 的词汇）
    for (const auto& t : engines_.scenarioData.targets) out[t.id] = t.typeKey;
#endif
    return out;
}

void FlowEngine::onDetection(const ma::sensor_bridge::Detection& d) {
    // ★ 本函数在**仿真驱动线程**里跑（Driver 持有自己的锁时回调进来）：
    //   只碰 detectMtx_ 与 entity-ledger（后者自带可重入锁），MUST NOT 取 mtx_。
#if MA_WITH_LEDGER
    if (d.targetId.empty()) return;
    std::string mission;
    {
        std::lock_guard<std::mutex> lk(detectMtx_);
        mission = detectMissionId_;
    }
    if (mission.empty()) {
        std::lock_guard<std::mutex> lk(detectMtx_);
        ++detectNoMission_;
        return;
    }
    if (d.targetTypeKey.empty()) {
        // 场景数据没给这个实体的 typeKey → 规则包的词汇表对不上，引擎会以 1000 拒。
        // 宿主 MUST NOT 自造 typeKey（那是规则包的事）→ 如实计数并把原话记下来。
        std::lock_guard<std::mutex> lk(detectMtx_);
        ++detectFailed_;
        detectLastError_ = "探测到的实体 id=" + d.targetId +
                           " 在场景 targets 里找不到 typeKey（宿主不自造类型键）";
        return;
    }
    if (!engines_.entityLedger) return;

    const std::string key = mission + "/" + d.targetId;
    std::string known;
    {
        std::lock_guard<std::mutex> lk(detectMtx_);
        const auto it = detectEntityOf_.find(key);
        if (it != detectEntityOf_.end()) known = it->second;
    }

    auto build = [&](const std::string& sourceKey) {
        entity_ledger::RegisterInput ri;
        ri.missionId = mission;
        ri.typeKey = d.targetTypeKey;
        ri.lng = d.lng;
        ri.lat = d.lat;
        ri.alt = d.altM;
        ri.confidence = d.confidence;   // = 模型算的概率（宿主不改这个数）
        ri.obsKey = d.targetId;         // 去重主键 = 被探测实体的 id（多传感器 → 归并）
        ri.operatorId = "host:sensor.detect";
        // ★ 实测踩过的坑（P6）：entity-ledger 的 `registerEntity` 在**观测没带状态**时把实体状态写成
        //   规则默认态（`defaultDynamicState` = briefStop，`engine.cc:517-518/553`）→ 每来一条探测，
        //   "已打击 / 已摧毁"就被打回默认（症状：步 10 刚变灰，几秒后又变回，且 destroyed 迁移被拒）。
        //   观测**不该**改变任务状态，所以既有实体在登记时把**台账当前的 dynamicState 原样带回**
        //   （值来自引擎，宿主不猜、不改；首次探测仍由引擎给默认态）。
        if (!known.empty() && engines_.entityLedger) {
            const std::optional<entity_ledger::EntityRecord> cur =
                engines_.entityLedger->getEntity(known);
            if (cur.has_value() && !cur->dynamicState.empty()) ri.dynamicState = cur->dynamicState;
        }
        if (!sourceKey.empty()) {
            entity_ledger::SourceObs so;
            so.source = sourceKey;      // 观测来源 = 传感器类别（规则包 confidence.sources 的键）
            so.obsKey = d.targetId;
            so.confidence = d.confidence;
            so.at = d.ts;
            ri.sources.push_back(so);
        }
        nlohmann::json attrs = {{"sensorId", d.sensorId},
                                {"sensorClass", d.sensorClass},
                                {"detectedBy", d.platformId},
                                {"probability", d.confidence},
                                {"distanceM", d.distanceM},
                                {"azimuthDeg", d.azimuthDeg},
                                {"elevationDeg", d.elevationDeg},
                                {"detectTs", d.ts},
                                {"detectKind", "sensor.detect"},
                                {"targetName", d.targetName},
                                {"targetNo", d.targetNo}};
        if (d.hasRevisit) attrs["revisitPeriodMs"] = d.revisitPeriodMs;
        attrs["factors"] = d.factors;
        ri.attributes = attrs;
        return ri;
    };

    entity_ledger::RegisterResult rr =
        engines_.entityLedger->registerEntity(build(d.sensorClass));
    if (rr.code == 1000 && std::string(rr.message).find("observation source") != std::string::npos) {
        // 观测来源键必须出现在规则包 confidence.sources 里；不认识就回落规则包默认源
        // （引擎的 defaultSource）并把这次回落记下来 —— 宿主不自己判"该算哪个源"。
        {
            std::lock_guard<std::mutex> lk(detectMtx_);
            ++detectSourceFallback_;
        }
        rr = engines_.entityLedger->registerEntity(build(std::string()));
    }
    if (rr.code != 0) {
        std::lock_guard<std::mutex> lk(detectMtx_);
        ++detectFailed_;
        detectLastError_ = "registerEntity code=" + std::to_string(rr.code) + "：" + rr.message;
        return;
    }

    std::string entityId = rr.data.id;
    bool rebound = false;
    if (rr.created && !known.empty() && known != entityId) {
        // 引擎的保守去重要求**全部去重键**命中（obsKey + typeKey + space≤300 m）。目标移动
        // 超过空间半径时它会新建实体并标 candidates —— 用引擎自己的 mergeEntities 并回主实体
        // （宿主不直接改台账）。
        const entity_ledger::RegisterResult mr =
            engines_.entityLedger->mergeEntities(known, {entityId}, "host:sensor.detect");
        if (mr.code == 0) {
            rebound = true;
            entityId = known;
        } else {
            std::lock_guard<std::mutex> lk(detectMtx_);
            detectLastError_ = "mergeEntities code=" + std::to_string(mr.code) + "：" + mr.message;
        }
    }

    nlohmann::json row = nlohmann::json::object();
    row["missionId"] = mission;
    row["targetId"] = d.targetId;
    row["entityId"] = entityId;
    row["no"] = rr.data.no;
    row["typeKey"] = d.targetTypeKey;
    row["status"] = rr.status;          // created / merged
    row["created"] = rr.created;
    row["merged"] = rr.merged;
    row["rebound"] = rebound;
    row["confidence"] = d.confidence;
    row["sensorId"] = d.sensorId;
    row["platformId"] = d.platformId;
    row["sensorClass"] = d.sensorClass;
    row["distanceM"] = d.distanceM;
    row["probability"] = d.confidence;
    row["ts"] = d.ts;
    {
        std::lock_guard<std::mutex> lk(detectMtx_);
        if (rebound) {
            ++detectRebound_;
        } else if (rr.created) {
            ++detectRegistered_;
        } else {
            ++detectMerged_;
        }
        detectEntityOf_[key] = entityId;
        detectLast_ = row;
    }
#else
    (void)d;
#endif  // MA_WITH_LEDGER
}

#endif  // MA_WITH_SIM_SOURCE && MA_WITH_INGEST && MA_WITH_SENSOR_MODEL

// ---------------------------------------------------------------- 媒体通道
//
// §D.3 第 3 步：把 `{channels:[{id,name,kind,url|frames,frameIntervalMs}]}` 交给前端。
// 通道**从磁盘扫出来**（不是写死的清单）：`<mediaRoot>/<子目录>/` 里的图片序列 =
// 一条 `image-seq` 通道（frames 是 URL 数组）；`<mediaRoot>` 下的视频文件 = `video` 通道。
// 空目录/不存在的文件 → 该通道 available=false 并把原因写进 note（不假装有素材）。
nlohmann::json FlowEngine::mediaChannelsJson(bool refresh) const {
    if (!refresh) {
        std::lock_guard<std::mutex> lk(mediaMtx_);
        if (mediaCached_) return mediaCache_;
    }
    nlohmann::json out = nlohmann::json::object();
    nlohmann::json channels = nlohmann::json::array();
    nlohmann::json notes = nlohmann::json::array();
    namespace fs = std::filesystem;

    const std::string root = cfg_.mediaRoot.empty() ? std::string() : cfg_.resolvePath(cfg_.mediaRoot);
    out["root"] = root;
    const bool hosted = !root.empty() && fs::is_directory(root);
    out["hosted"] = hosted;
    out["basePath"] = "/media";
    if (root.empty()) {
        notes.push_back("config.json 的 mediaRoot 为空 → /media/** 不托管、通道清单为空");
        out["channels"] = std::move(channels);
        out["notes"] = std::move(notes);
        return out;
    }
    if (!hosted) {
        notes.push_back("mediaRoot 不是目录（不存在？）：" + root + " → 通道清单为空");
        out["channels"] = std::move(channels);
        out["notes"] = std::move(notes);
        return out;
    }

    const auto isImage = [](const std::string& ext) {
        return ext == ".jpg" || ext == ".jpeg" || ext == ".png";
    };
    const auto isVideo = [](const std::string& ext) {
        return ext == ".mp4" || ext == ".webm" || ext == ".m4v";
    };

    std::error_code ec;
    std::vector<fs::path> dirs;
    std::vector<fs::path> files;
    for (const auto& e : fs::directory_iterator(root, ec)) {
        if (e.is_directory()) {
            dirs.push_back(e.path());
        } else if (e.is_regular_file() && isVideo(e.path().extension().string())) {
            files.push_back(e.path());
        }
    }
    std::sort(dirs.begin(), dirs.end());
    std::sort(files.begin(), files.end());

    for (const auto& dir : dirs) {
        std::vector<std::string> frames;
        for (const auto& e : fs::directory_iterator(dir, ec)) {
            if (!e.is_regular_file()) continue;
            if (!isImage(e.path().extension().string())) continue;
            const std::string rel = (dir.filename() / e.path().filename()).generic_string();
            frames.push_back("/media/" + rel);
        }
        std::sort(frames.begin(), frames.end());
        nlohmann::json ch = nlohmann::json::object();
        ch["id"] = dir.filename().generic_string();
        ch["name"] = dir.filename().generic_string();
        ch["kind"] = "image-seq";
        ch["frames"] = frames;
        ch["frameCount"] = static_cast<int>(frames.size());
        ch["frameIntervalMs"] = 200;  // media-player 的 defaultFrameIntervalMs（常量，不是编的读数）
        ch["url"] = nullptr;
        ch["available"] = !frames.empty();
        if (frames.empty()) {
            ch["unavailableReason"] = "目录里没有 .jpg/.png 帧";
        }
        ch["sourceLabel"] = "本地占位素材（" + dir.filename().generic_string() + "/*.jpg）";
        channels.push_back(std::move(ch));
    }
    for (const auto& f : files) {
        nlohmann::json ch = nlohmann::json::object();
        ch["id"] = f.stem().generic_string();
        ch["name"] = f.stem().generic_string();
        ch["kind"] = "video";
        ch["url"] = "/media/" + f.filename().generic_string();
        ch["frames"] = nullptr;
        ch["frameCount"] = 0;
        ch["frameIntervalMs"] = 0;
        ch["available"] = true;
        ch["sourceLabel"] = "本地占位素材（" + f.filename().generic_string() + "）";
        channels.push_back(std::move(ch));
    }

    if (channels.empty()) {
        notes.push_back("mediaRoot 下没有可用的通道（既没有图片序列子目录，也没有视频文件）：" + root);
    } else {
        notes.push_back("通道清单由宿主扫盘得到（image-seq = 子目录内的帧序列；video = 视频文件），"
                        "frameIntervalMs 用 media-player 的 defaultFrameIntervalMs=200");
    }
    notes.push_back("字节流走 /media/**（支持 Range/206/Content-Range/416；不存在 → 404）；"
                    "媒体引擎是 npm 包，宿主不引入 C++ 侧依赖");
    out["channels"] = std::move(channels);
    out["notes"] = std::move(notes);
    {
        std::lock_guard<std::mutex> lk(mediaMtx_);
        mediaCache_ = out;
        mediaCached_ = true;
    }
    return out;
}

void FlowEngine::broadcastMediaChannels() {
    if (!broadcast_) return;
    broadcast_("media.channels", mediaChannelsJson());
}

std::string FlowEngine::sensorNote() const {
#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST && MA_WITH_SENSOR_MODEL
    if (engines_.sensorBridge) return engines_.sensorNote;
    return engines_.sensorNote.empty() ? std::string("探测模型未装配") : engines_.sensorNote;
#else
    return "探测模型未装配（编译期 MA_WITH_SENSOR_MODEL=0）";
#endif
}

// ---------------------------------------------------------------- 链路评估（topology）

#if MA_WITH_TOPOLOGY && MA_WITH_SIM_SOURCE && MA_WITH_INGEST

nlohmann::json FlowEngine::ensureTopologyLocked() {
    nlohmann::json out = nlohmann::json::object();
    out["configured"] = false;
    out["reused"] = false;
    out["nodes"] = 0;
    out["edges"] = 0;
    if (!engines_.topologyEngine) {
        out["code"] = 1005;
        out["message"] = "topology 未装配（编译期 MA_WITH_TOPOLOGY=0）";
        return out;
    }
    // 已经装配过（同一次任务）→ **不重建**：`configureTopology(reset=true)` 会清掉链路样本
    // 与状态机（状态是带迟滞的，重建等于把观测历史抹掉）。
    if (topologyReady_ && topologyMissionId_ == missionId_) {
        const topology::ValidationReport vr = engines_.topologyEngine->validate();
        const topology::TopologyView tv = engines_.topologyEngine->topologyView();
        out["configured"] = true;
        out["reused"] = true;
        out["topologyId"] = tv.topologyId;
        out["structureKey"] = tv.structureKey;
        out["nodes"] = static_cast<int>(tv.nodes.size());
        out["edges"] = static_cast<int>(tv.edges.size());
        out["validate"] = nlohmann::json::parse(vr.toJson().dump());
        out["linkTo"] = topologyLinkTo_;
        return out;
    }

    // ---- 结构键：**从规则包里挑**（不写死）——优先声明为 mesh 的那个 ----
    std::string structureKey;
    {
        const auto pol = engines_.topologyEngine->policy();
        if (pol.has_value()) {
            for (const auto& st : pol->structures) {
                if (st.mode == topology::StructureMode::Mesh) {
                    structureKey = st.key;
                    break;
                }
            }
            if (structureKey.empty() && !pol->structures.empty()) {
                structureKey = pol->structures.front().key;
            }
        }
    }
    if (structureKey.empty()) structureKey = "mesh";

    const topology::MutationResult cfg =
        engines_.topologyEngine->configureTopology("mission-map", structureKey, true);
    out["configure"] = nlohmann::json::parse(cfg.toJson().dump());
    if (cfg.code != 0) {
        out["code"] = cfg.code;
        out["message"] = cfg.message;
        return out;
    }

    // ---- 节点/边：**全部按场景数据**（deployment.json 的 aircraft[] 与 groups[]）----
    //
    // 节点类型键取自规则包 linkThresholds.json 的 items（cloud/edge/forward/cluster）：
    //   编组 → cluster（规则包自己声明 graphic=cluster、tier=2）
    //   平台 → edge（tier=1 的边缘节点）
    // 这本"场景概念 → 规则词汇"的映射是宿主的事（两个仓互不认识），映射规则写在这里可复核；
    // 引擎的 `validate()` 结论原样回执（有没有问题由引擎说）。
    nlohmann::json notes = nlohmann::json::array();
    std::vector<topology::NodeSpec> nodes;
    std::vector<topology::EdgeSpec> edges;
    topologyLinkTo_.clear();
    nlohmann::json edgeRows = nlohmann::json::array();

    const auto& sd = engines_.scenarioData;
    auto platformRows = platformsOf(engines_);

    // 编组节点：坐标 = 组内平台站位的均值（场景数据算出来的，不是画上去的）
    for (const auto& g : sd.groups) {
        double sx = 0, sy = 0;
        int n = 0;
        for (const auto& p : platformRows) {
            if (p.groupKey != g.key) continue;
            sx += p.lng;
            sy += p.lat;
            ++n;
        }
        topology::NodeSpec node;
        node.id = "grp:" + g.key;
        node.typeKey = "cluster";
        node.name = g.name;
        node.clusterId = g.key;
        node.hasPosition = (n > 0);
        if (n > 0) {
            node.lng = sx / n;
            node.lat = sy / n;
        }
        nodes.push_back(node);
    }
    // 平台节点 + 平台→编组 的边（链路 id = 平台 deviceId：线上报文里的 uavId 直接就是它）
    for (const auto& p : platformRows) {
        topology::NodeSpec node;
        node.id = p.deviceId;
        node.typeKey = "edge";
        node.name = p.deviceId + "（" + p.model + "）";
        node.clusterId = p.groupKey;
        node.lng = p.lng;
        node.lat = p.lat;
        node.hasPosition = true;
        nodes.push_back(node);

        if (p.groupKey.empty()) continue;
        topology::EdgeSpec e;
        e.id = p.deviceId;
        e.from = p.deviceId;
        e.to = "grp:" + p.groupKey;
        edges.push_back(e);
        topologyLinkTo_[e.id] = e.to;
        edgeRows.push_back({{"id", e.id},
                            {"from", e.from},
                            {"to", e.to},
                            {"kind", "platform-group"},
                            {"deviceType", p.model}});
    }
    // 中继关系：comm 机型（deviceTypes.json 自述"中继/组网"）→ 其它编组节点。
    // 只做场景/规则包**已经声明**的关系，不猜拓扑形状。
    for (const auto& p : platformRows) {
        if (p.model != "comm") continue;
        for (const auto& g : sd.groups) {
            if (g.key == p.groupKey) continue;
            topology::EdgeSpec e;
            e.id = "relay:" + p.deviceId + "->" + g.key;
            e.from = p.deviceId;
            e.to = "grp:" + g.key;
            edges.push_back(e);
            edgeRows.push_back({{"id", e.id},
                                {"from", e.from},
                                {"to", e.to},
                                {"kind", "relay"},
                                {"deviceType", p.model}});
        }
    }

    const topology::MutationResult nr = engines_.topologyEngine->addNodes(nodes);
    const topology::MutationResult er = engines_.topologyEngine->addEdges(edges);
    out["addNodes"] = nlohmann::json::parse(nr.toJson().dump());
    out["addEdges"] = nlohmann::json::parse(er.toJson().dump());
    const topology::ValidationReport vr = engines_.topologyEngine->validate();
    out["validate"] = nlohmann::json::parse(vr.toJson().dump());

    notes.push_back("节点/边来自场景数据：groups[] → cluster 节点（坐标 = 组内站位均值）；"
                    "aircraft[] → edge 节点 + 「平台→所属编组」边（链路 id = deviceId，"
                    "与线上报文的 uavId 同一口径）；comm 机型（deviceTypes.json 自述中继/组网）"
                    "→ 其它编组的 relay 边");
    notes.push_back("节点类型键取自规则包 linkThresholds.json 的 items（cluster/edge）；"
                    "场景概念 → 规则词汇的映射写在宿主，引擎的 validate() 结论原样回执");
    if (!vr.issues.empty()) {
        notes.push_back("validate() 报了 " + std::to_string(vr.issues.size()) + " 条问题（见 validate）");
    }

    topologyReady_ = (nr.code == 0 && er.code == 0);
    topologyMissionId_ = missionId_;
    out["configured"] = topologyReady_;
    out["structureKey"] = structureKey;
    out["topologyId"] = "mission-map";
    out["nodes"] = static_cast<int>(nodes.size());
    out["edges"] = static_cast<int>(edges.size());
    out["edgeDetail"] = std::move(edgeRows);
    out["linkTo"] = topologyLinkTo_;
    out["notes"] = std::move(notes);
    return out;
}

nlohmann::json FlowEngine::toTopologyEvents(const std::map<std::string, WireAgg>& agg,
                                            nlohmann::json& notes) const {
    // 线上报文 → topology 的 ingest 形状（`{linkId, ts, 指标…}`）。**只做形状转换**：
    //
    //   指标：只投**真的量得到、且口径对得上**的那一项
    //     · lossRate = 断号数 ÷ (断号数 + 实收帧数) —— 由报文自带的 seq 连续性实测
    //   （为什么不投 bandwidthMbps：实测吞吐是"本应用此刻发了多少"，不是链路的**标称带宽**；
    //    把 ~0.01 Mbps 的遥测速率塞进量程 0–200 Mbps 的"带宽"指标，只会让规则包把一条
    //    零丢包的链路判成红 —— 口径不符，所以留空并在 notes 里点名。数字仍然实测、仍可查，
    //    只是不进评分：见回执 metricDetail 的 bytes/spanMs/throughputMbps。）
    //   时间：ts = **到货挂钟**（topology 的窗口/迟滞都以它为准；报文里的 ts 是仿真时间，
    //         60 倍速下与挂钟不同基准，拿它当 ts 会把样本立刻挤出窗口）。
    nlohmann::json events = nlohmann::json::array();
    nlohmann::json detail = nlohmann::json::array();
    int64_t unmapped = 0;
    for (const auto& kv : agg) {
        const WireAgg& a = kv.second;
        if (topologyLinkTo_.find(kv.first) == topologyLinkTo_.end()) {
            ++unmapped;  // 不是本拓扑里的链路（例如非平台设备）→ 不投
            continue;
        }
        const int64_t total = a.frames + a.gaps;
        const double lossRate = total > 0 ? static_cast<double>(a.gaps) / static_cast<double>(total)
                                          : 0.0;
        const int64_t spanMs = std::max<int64_t>(a.lastMs - a.firstMs, 1);
        const double throughputMbps =
            static_cast<double>(a.bytes) * 8.0 / (static_cast<double>(spanMs) / 1000.0) / 1e6;

        nlohmann::json ev = nlohmann::json::object();
        ev["linkId"] = kv.first;
        ev["ts"] = a.lastMs;
        ev["from"] = kv.first;
        ev["to"] = topologyLinkTo_.at(kv.first);
        ev["lossRate"] = lossRate;
        events.push_back(ev);

        detail.push_back({{"linkId", kv.first},
                          {"frames", a.frames},
                          {"gaps", a.gaps},
                          {"bytes", a.bytes},
                          {"spanMs", spanMs},
                          {"lossRate", lossRate},
                          {"throughputMbps", throughputMbps},
                          {"ingested", nlohmann::json::array({"lossRate"})},
                          {"notIngested", nlohmann::json::array({"bandwidthMbps"})},
                          {"deviceType", a.deviceType},
                          {"groupId", a.groupId},
                          {"lastSimTs", a.simTs}});
    }

    notes.push_back("ingest 只投**实测且口径对得上**的 lossRate（报文 seq 断号 ÷ 总数）；"
                    "吞吐（bytes/spanMs）作为事实留在 metricDetail 里，但**不投** bandwidthMbps "
                    "—— 实测吞吐不是标称带宽，投进去会让规则包把零丢包的链路判红");
    notes.push_back("lossRate 的口径要求接入层**不合并**报文（config.json 的 "
                    "ingest.mergeWindowMs=0）：合并窗会把同一设备的多条报文并成一条，"
                    "seq 断号率随之变成【接入层合并率】（实测 0.47）而不是链路丢包 —— "
                    "本宿主不做这种张冠李戴");
    notes.push_back("留空未投的指标：signal（本工程没有射频测量源；规则包 valueMap 的 "
                    "strong/medium/weak 没有对应读数）、latencyMs（接入层不记录到货时延；"
                    "报文 ts 是仿真时间，60 倍速下与挂钟不可比）、bandwidthMbps（见上）、"
                    "coverageKm2（链路级覆盖无实测源；传感器覆盖在 sensor.status 里，"
                    "MUST NOT 挪来当链路指标）、nodeLoad/cacheAvailable/cacheTotal（无来源）。"
                    "引擎对缺字段的口径是 preserved（保持原值），不是补 0");
    if (unmapped > 0) {
        notes.push_back("有 " + std::to_string(unmapped) +
                        " 个设备不属于本拓扑的任何链路（未投递）：线格式里的 deviceId 必须在"
                        "「平台→编组」边集合里");
    }
    return nlohmann::json{{"events", events}, {"detail", detail}};
}

#else  // 未装配 topology / 场景数据 / 接入层：两个 helper 仍要存在（verb 分派引用它们）

nlohmann::json FlowEngine::ensureTopologyLocked() {
    return nlohmann::json{{"configured", false},
                          {"code", 1005},
                          {"message", "topology 或场景数据未装配（编译期开关关闭）"}};
}

nlohmann::json FlowEngine::toTopologyEvents(const std::vector<WireFrame>& frames,
                                            nlohmann::json& notes) const {
    (void)frames;
    notes.push_back("拓扑/场景数据未装配：线上报文不投递");
    return nlohmann::json{{"events", nlohmann::json::array()},
                          {"detail", nlohmann::json::array()}};
}

#endif  // MA_WITH_TOPOLOGY && MA_WITH_SIM_SOURCE && MA_WITH_INGEST

// ---------------------------------------------------------------- 覆盖率 / 遍历周期

nlohmann::json FlowEngine::sensorStatusLocked() {
    // 覆盖率的每一平方米、遍历周期的每一毫秒都来自 `sensor_model`：
    //   `cover(PlatformPose, SensorSpec, nowMs, occluders, sensorSensitivity)`
    //   `revisitPeriodMs(SensorSpec)`
    // 宿主只做三件事：① 取平台的**实时位姿**（sim-source 的 EntityStatus）；
    //                 ② lng/lat → 局部平面米（GeoRef）；③ 汇总（口径写在 notes 里）。
    nlohmann::json out = nlohmann::json::object();
    nlohmann::json notes = nlohmann::json::array();
    nlohmann::json rows = nlohmann::json::array();
    out["available"] = false;
#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST && MA_WITH_SENSOR_MODEL
    if (!engines_.sensorBridge) {
        out["message"] = sensorNote();
        notes.push_back("探测模型未装配：" + sensorNote());
        out["sensors"] = std::move(rows);
        out["notes"] = std::move(notes);
        return out;
    }
    auto& bridge = *engines_.sensorBridge;
    const ma::sensor_bridge::GeoRef& ref = bridge.geoRef();
    const auto& sd = engines_.scenarioData;
    const int64_t simNow =
        engines_.bridge.driver ? engines_.bridge.driver->metrics().simElapsedMs : 0;

    double sumAreaM2 = 0.0;
    double sumSensitiveM2 = 0.0;
    int withSpec = 0;
    double revMin = 0, revMax = 0, revSum = 0;
    int revN = 0;
    nlohmann::json byType = nlohmann::json::object();

    for (const auto& a : sd.aircraft) {
        const auto spec = bridge.effectiveSpec(a.typeKey);
        nlohmann::json row = nlohmann::json::object();
        row["platformId"] = a.deviceId;
        row["deviceType"] = a.typeKey;
        row["groupKey"] = a.groupKey;
        if (!spec.has_value()) {
            row["available"] = false;
            row["reason"] = "sensors.json 里没有该机型键的 SensorSpec → 不猜（覆盖率留空）";
            rows.push_back(std::move(row));
            continue;
        }
        ++withSpec;
        row["sensorId"] = spec->sensorId;
        row["sensorClass"] = sensor_model::toString(spec->sensorClass);
        row["aimFrame"] = sensor_model::toString(spec->aimFrame);
        row["scanPattern"] = sensor_model::toString(spec->scanPattern);
        row["maxRangeM"] = spec->maxRangeM;
        row["scanPeriodMs"] = spec->scanPeriodMs;

        // 实时位姿：引擎里的实体状态（没跑起来 → 回落场景站位并标注）
        double lng = a.stationLng, lat = a.stationLat, alt = a.altM, heading = 0.0;
        bool live = false;
        sim_source::EntityStatus es;
        if (engines_.bridge.engine && engines_.bridge.engine->entity(a.deviceId, es)) {
            lng = es.lng;
            lat = es.lat;
            alt = es.altM;
            heading = es.heading;
            live = true;
        }
        row["poseSource"] = live ? "sim_source::EntityStatus（实时）" : "deployment.json 站位（仿真未初始化）";
        row["lng"] = lng;
        row["lat"] = lat;
        row["altM"] = alt;
        row["headingDeg"] = heading;

        sensor_model::PlatformPose pose;
        pose.position = ref.toLocal(lng, lat, alt);
        pose.headingDeg = heading;
        pose.platformId = a.deviceId;

        const auto cov = bridge.coverFor(a.typeKey, pose, simNow, /*sensorSensitivity=*/false);
        const auto covSens = bridge.coverFor(a.typeKey, pose, simNow, /*sensorSensitivity=*/true);
        if (cov.has_value()) {
            row["coverageAreaM2"] = cov->areaM2;
            row["coverageAreaKm2"] = cov->areaM2 / 1e6;
            row["coveragePolygonPoints"] = static_cast<int>(cov->polygon.size());
            row["sectorRadiusM"] = cov->sectorRadiusM;
            row["sectorSpanDeg"] = cov->sectorSpanDeg;
            row["sectorStartAzimuthDeg"] = cov->sectorStartAzimuthDeg;
            row["truncatedByOccluders"] = cov->truncatedByOccluders;
            sumAreaM2 += cov->areaM2;
        } else {
            row["coverageAreaM2"] = nullptr;
            row["reason"] = "cover() 返回 nullopt（参数非法：空 sensorId / maxRangeM<=0）";
        }
        if (covSens.has_value()) {
            row["sensitiveAreaM2"] = covSens->areaM2;
            sumSensitiveM2 += covSens->areaM2;
        }
        const auto rev = bridge.revisitFor(a.typeKey);
        if (rev.has_value()) {
            row["revisitPeriodMs"] = *rev;
            if (revN == 0) {
                revMin = revMax = *rev;
            } else {
                revMin = std::min(revMin, *rev);
                revMax = std::max(revMax, *rev);
            }
            revSum += *rev;
            ++revN;
        } else {
            row["revisitPeriodMs"] = nullptr;
        }
        row["available"] = true;
        rows.push_back(std::move(row));

        nlohmann::json& t = byType[a.typeKey];
        if (!t.is_object()) {
            t = nlohmann::json::object();
            t["deviceType"] = a.typeKey;
            t["platforms"] = 0;
            t["coverageAreaM2"] = 0.0;
            t["revisitPeriodMs"] = nullptr;
        }
        t["platforms"] = t["platforms"].get<int>() + 1;
        t["coverageAreaM2"] = t["coverageAreaM2"].get<double>() +
                              (cov.has_value() ? cov->areaM2 : 0.0);
        if (rev.has_value()) t["revisitPeriodMs"] = *rev;
    }

    // 覆盖率：**任务区被覆盖的比例**（有界 [0,1]），口径与来源都写死在这里：
    //   任务区多边形 → GeoRef 局部平面 → 在包围盒上按固定步长打格点；
    //   格点是否在任务区内 = sensor_model::pointInPolygon；
    //   格点是否被覆盖     = 落在**任一**传感器 cover() 多边形内（sensor_model::cover 的输出）。
    // 为什么不用 Σ覆盖面积÷任务区面积：各传感器量程 3–20 km 远大于 9 km² 的任务区，
    // 直接相加会得到 283 这种"上界"（且重复计重叠），对"任务区覆盖率"没有意义 ——
    // 上界仍然照报（coveredAreaUpperBound），但覆盖率用**交集**口径。
    double taskAreaM2 = 0.0;
    std::string taskAreaKey = sd.pickPrimaryTaskKey();
    std::vector<sensor_model::Vec3> taskRing;
    for (const auto& ta : sd.taskAreas) {
        if (ta.key != taskAreaKey) continue;
        for (const auto& p : ta.polygon) taskRing.push_back(ref.toLocal(p.first, p.second, 0.0));
        taskAreaM2 = sensor_model::polygonAreaM2(taskRing);
    }
    nlohmann::json grid = nlohmann::json::object();
    int insideTask = 0;
    int coveredPoints = 0;
    double gridStepM = 0.0;
    if (taskRing.size() >= 3) {
        double minX = taskRing[0].x, maxX = taskRing[0].x, minY = taskRing[0].y, maxY = taskRing[0].y;
        for (const auto& p : taskRing) {
            minX = std::min(minX, p.x);
            maxX = std::max(maxX, p.x);
            minY = std::min(minY, p.y);
            maxY = std::max(maxY, p.y);
        }
        // 步长：目标 ≤ 40000 个格点（够细且不拖慢命令），最小 20 m
        constexpr int kMaxSamples = 40000;
        const double spanX = std::max(maxX - minX, 1.0);
        const double spanY = std::max(maxY - minY, 1.0);
        gridStepM = std::max(20.0, std::sqrt(spanX * spanY / kMaxSamples));
        // 覆盖多边形（局部平面）——用 cover() 的原样输出
        std::vector<std::vector<sensor_model::Vec3>> covers;
        for (const auto& row : rows) {
            if (!row.value("available", false)) continue;
            const std::string dt = row.value("deviceType", std::string());
            sensor_model::PlatformPose pose;
            pose.position = ref.toLocal(row.value("lng", 0.0), row.value("lat", 0.0),
                                        row.value("altM", 0.0));
            pose.headingDeg = row.value("headingDeg", 0.0);
            pose.platformId = row.value("platformId", std::string());
            const auto cov = bridge.coverFor(dt, pose, simNow, false);
            if (cov.has_value() && cov->polygon.size() >= 3) covers.push_back(cov->polygon);
        }
        for (double x = minX; x <= maxX; x += gridStepM) {
            for (double y = minY; y <= maxY; y += gridStepM) {
                sensor_model::Vec3 p;
                p.x = x;
                p.y = y;
                p.z = 0.0;
                if (!sensor_model::pointInPolygon(p, taskRing)) continue;
                ++insideTask;
                for (const auto& poly : covers) {
                    if (sensor_model::pointInPolygon(p, poly)) {
                        ++coveredPoints;
                        break;
                    }
                }
            }
        }
        grid["stepM"] = gridStepM;
        grid["samplesInTaskArea"] = insideTask;
        grid["samplesCovered"] = coveredPoints;
        grid["taskAreaPolygonPoints"] = static_cast<int>(taskRing.size());
    }

    out["available"] = true;
    out["specSource"] = bridge.specs().path();
    out["specTable"] = bridge.specs().toJson();
    out["enabled"] = bridge.enabled();
    out["rangeScale"] = bridge.rangeScale();
    out["attachmentCount"] = static_cast<int>(engines_.sensorAttachments.size());
    out["platformsWithSpec"] = withSpec;
    out["platforms"] = static_cast<int>(sd.aircraft.size());
    out["coveredAreaM2"] = sumAreaM2;
    out["coveredAreaKm2"] = sumAreaM2 / 1e6;
    out["sensitiveAreaKm2"] = sumSensitiveM2 / 1e6;
    out["taskAreaKey"] = taskAreaKey;
    out["taskAreaM2"] = taskAreaM2;
    out["taskAreaKm2"] = taskAreaM2 / 1e6;
    out["coveredAreaUpperBoundKm2"] = sumAreaM2 / 1e6;   // Σ各传感器覆盖面积（未去重叠）
    out["coverageUpperBoundRatio"] = taskAreaM2 > 0 ? (sumAreaM2 / taskAreaM2) : 0.0;
    out["coverageGrid"] = grid;
    out["coverageRatio"] =
        insideTask > 0 ? static_cast<double>(coveredPoints) / static_cast<double>(insideTask) : 0.0;
    out["revisitPeriodMs"] = {{"min", revN > 0 ? revMin : 0.0},
                              {"max", revN > 0 ? revMax : 0.0},
                              {"mean", revN > 0 ? revSum / revN : 0.0},
                              {"count", revN}};
    out["byType"] = std::move(byType);
    out["simNowMs"] = simNow;
    out["sensors"] = std::move(rows);
    out["bridgeStats"] = bridge.statsJson();

    notes.push_back("覆盖面积 = sensor_model::cover(位姿, 规格, nowMs, occluders={}, "
                    "sensorSensitivity=false).areaM2（几何包络），逐传感器求和；"
                    "sensitiveAreaKm2 是同一次调用传 sensorSensitivity=true（按 detectionThreshold "
                    "截断）的结果");
    notes.push_back("coverageRatio = **任务区被覆盖的比例**：在任务区包围盒上按 "
                    "coverageGrid.stepM 打格点，格点落在任务区多边形内（sensor_model::pointInPolygon）"
                    "且落在任一传感器 cover() 多边形内即算覆盖 → coveredSamples ÷ samplesInTaskArea"
                    "（有界 [0,1]，含重叠只算一次）");
    notes.push_back("coveredAreaUpperBoundKm2 / coverageUpperBoundRatio = Σ覆盖面积 ÷ 任务区面积"
                    "（**未去重叠**、且含全向大范围传感器，可远大于 1）—— 只作上界参照，"
                    "不是覆盖率；任务区面积用 sensor_model::polygonAreaM2 算");
    notes.push_back("遍历周期 = sensor_model::revisitPeriodMs(有效规格)，逐型号取值；"
                    "min/max/mean 是挂接平台上的汇总");
    notes.push_back("遮挡体留空（occluders={}）：场景的 no-fly/情报区是空域多边形，"
                    "不是不透明遮挡体");
    out["notes"] = std::move(notes);
#else
    out["message"] = sensorNote();
    notes.push_back(sensorNote());
    out["sensors"] = std::move(rows);
    out["notes"] = std::move(notes);
#endif
    return out;
}

// ============================================================================
// 步 8–9（P5）：打击方案几何标注 / 引导方案（IP 点 + 引导连线 + 时间轴）
// ============================================================================
//
// 【几何权威】只有两处，别的都不算：
//   ① 场景数据 `<scenarioDir>/strike-geometry.json`：IP 点（`attackStarts[]`，含 lng/lat/altM）
//      与评估航线（`assessRoutes[].waypoints[]`，`[lng,lat]`）。规则包/引擎输出里**只有键**
//      （`attackStart.key` / `assessRoute.key`）—— 这正是 §10.1-Q4 的变体 A：**MUST NOT 双写几何**。
//   ② entity-ledger 台账：**已登记平台**的真实坐标（`getEntity(entityId)` 的 lng/lat/alt）。
//      `alloc.assign` 登记成功时宿主把 deviceId→entityId 记下来（`entityIdOfDevice_`），
//      引导连线就用这一份 —— 而不是从 deployment.json 再取第二份坐标（台账才是唯一权威）。
// 带不出出处的字段一律**留空 + notes 点名**；Q5 的 `stk-s2-*`（场景二）没有几何键 →
// `geometry.resolved=false`，宿主 MUST NOT 造坐标、也 MUST NOT 静默丢弃（丢不丢由引擎的
// `includeInapplicable` 决定）。

const nlohmann::json& FlowEngine::strikeGeometryLocked() const {
    if (strikeGeometryLoaded_) return strikeGeometry_;
    strikeGeometryLoaded_ = true;
    strikeGeometry_ = nlohmann::json::object();
    nlohmann::json notes = nlohmann::json::array();

    // 路径来源：`HostConfig::resolveScenarioDir()`（= `<dataDir>/scenario-1`，与 scenario-data
    // 装载的是同一个目录）。**不从源码里写坐标**：几何的唯一来源是这个文件。
    const std::filesystem::path p =
        std::filesystem::path(cfg_.resolveScenarioDir()) / "strike-geometry.json";
    std::string text;
    if (!readTextFile(p.string(), text)) {
        strikeGeometry_["loaded"] = false;
        strikeGeometry_["path"] = p.string();
        strikeGeometry_["note"] = "几何文件读不到（IP 点/评估航线的坐标权威缺失）";
        strikeGeometry_["attackStarts"] = nlohmann::json::array();
        strikeGeometry_["assessRoutes"] = nlohmann::json::array();
        strikeGeometry_["notes"] = notes;
        return strikeGeometry_;
    }
    try {
        nlohmann::json doc = nlohmann::json::parse(text);
        strikeGeometry_["loaded"] = true;
        strikeGeometry_["path"] = p.string();
        strikeGeometry_["schemaVersion"] = doc.value("schemaVersion", std::string());
        strikeGeometry_["note"] = doc.value("note", std::string());  // 文件自己的说明（原样）
        strikeGeometry_["attackStarts"] =
            doc.contains("attackStarts") && doc["attackStarts"].is_array() ? doc["attackStarts"]
                                                                          : nlohmann::json::array();
        strikeGeometry_["assessRoutes"] =
            doc.contains("assessRoutes") && doc["assessRoutes"].is_array() ? doc["assessRoutes"]
                                                                          : nlohmann::json::array();
    } catch (const std::exception& e) {
        strikeGeometry_["loaded"] = false;
        strikeGeometry_["path"] = p.string();
        strikeGeometry_["note"] = std::string("几何文件 JSON 解析失败：") + e.what();
        strikeGeometry_["attackStarts"] = nlohmann::json::array();
        strikeGeometry_["assessRoutes"] = nlohmann::json::array();
    }
    strikeGeometry_["notes"] = notes;
    return strikeGeometry_;
}

nlohmann::json FlowEngine::templateRawOfLocked(const std::string& templateKey) const {
#if MA_WITH_SCORING
    if (engines_.scoringEngine && !templateKey.empty()) {
        // 【引擎】scoring::ScoringEngine::templatesPack()（scoring.h:813）→ `TemplatesPack::raw`
        //   （scoring.h:235）。M5 的四个字段（coordination/coordinationLabel/plannedFinish/
        //   attackStart/assessRoute）**没有 typed 字段**、不进 `Candidate`（score.cc:453-468），
        //   引擎只在 raw 里原样保留整包（policies.cc:404）—— 所以这是读到它们的**唯一**入口，
        //   宿主 MUST NOT 自己拼业务文案。
        const scoring::TemplatesPack pack = engines_.scoringEngine->templatesPack();
        const auto it = pack.raw.find("items");
        if (it != pack.raw.end() && it->is_array()) {
            for (const auto& row : *it) {
                if (!row.is_object()) continue;
                if (row.value("key", std::string()) == templateKey) return row;
            }
        }
    }
#else
    (void)templateKey;
#endif
    return nlohmann::json::object();
}

nlohmann::json FlowEngine::strikeGeometryOfLocked(const nlohmann::json& templateRaw) const {
    const nlohmann::json& geo = strikeGeometryLocked();
    nlohmann::json out = nlohmann::json::object();

    // ---- IP 点（攻击起点）----
    const std::string ipKey = templateRaw.contains("attackStart") && templateRaw["attackStart"].is_object()
                                  ? templateRaw["attackStart"].value("key", std::string())
                                  : std::string();
    const std::string routeKey =
        templateRaw.contains("assessRoute") && templateRaw["assessRoute"].is_object()
            ? templateRaw["assessRoute"].value("key", std::string())
            : std::string();

    if (ipKey.empty() && routeKey.empty()) {
        // Q5：场景二的三条模板**不写几何键**（不在数据里占位）。这里如实标注，不补、不编。
        out["resolved"] = false;
        out["reason"] = "模板未声明 attackStart.key / assessRoute.key（该场景的几何未配置）";
        out["attackStart"] = nullptr;
        out["assessRoute"] = nullptr;
        return out;
    }

    nlohmann::json ip = nullptr;
    if (!ipKey.empty() && geo.contains("attackStarts") && geo["attackStarts"].is_array()) {
        for (const auto& row : geo["attackStarts"]) {
            if (row.is_object() && row.value("key", std::string()) == ipKey) {
                ip = row;  // **原样条目**（含 lng/lat/altM）
                break;
            }
        }
    }
    nlohmann::json route = nullptr;
    if (!routeKey.empty() && geo.contains("assessRoutes") && geo["assessRoutes"].is_array()) {
        for (const auto& row : geo["assessRoutes"]) {
            if (row.is_object() && row.value("key", std::string()) == routeKey) {
                route = row;
                break;
            }
        }
    }

    // 评估航线航点归一成 `{lng,lat}` + 原样 `[lng,lat]` 两种形态（场景文件里是二元数组）
    nlohmann::json wp = nlohmann::json::array();
    nlohmann::json wpRaw = nlohmann::json::array();
    if (route.is_object() && route.contains("waypoints") && route["waypoints"].is_array()) {
        for (const auto& p : route["waypoints"]) {
            if (!p.is_array() || p.size() < 2) continue;
            wp.push_back({{"lng", p[0]}, {"lat", p[1]}});
            wpRaw.push_back(p);
        }
    }

    nlohmann::json reasons = nlohmann::json::array();
    if (ipKey.empty()) {
        reasons.push_back("模板未声明 attackStart.key");
    } else if (ip.is_null()) {
        reasons.push_back("几何文件里没有 attackStart.key=" + ipKey +
                          "（几何权威在场景数据；规则包只有键引用）");
    }
    if (routeKey.empty()) {
        reasons.push_back("模板未声明 assessRoute.key");
    } else if (route.is_null()) {
        reasons.push_back("几何文件里没有 assessRoute.key=" + routeKey);
    }

    out["resolved"] = reasons.empty();
    out["key"] = ipKey;
    out["routeKey"] = routeKey;
    if (ip.is_object()) {
        out["attackStart"] = ip;
        out["attackStart"]["source"] = "scenario-data/strike-geometry.json attackStarts[]（键引用：" +
                                       ipKey + "）";
    } else {
        out["attackStart"] = nullptr;
    }
    if (route.is_object()) {
        out["assessRoute"] = {{"key", route.value("key", std::string())},
                              {"name", route.value("name", std::string())},
                              {"waypoints", wp},
                              {"waypointsRaw", wpRaw},
                              {"source", "scenario-data/strike-geometry.json assessRoutes[]（键引用：" +
                                             routeKey + "）"}};
    } else {
        out["assessRoute"] = nullptr;
    }
    out["reasons"] = reasons;
    return out;
}

nlohmann::json FlowEngine::buildGuidancePlanLocked(const std::string& planId,
                                                   const nlohmann::json& params, int& code) {
    code = 0;
    (void)params;  // 目前无入参（时刻与几何都有固定出处）；保留形参以便后续加过滤条件
    nlohmann::json d = nlohmann::json::object();
    nlohmann::json notes = nlohmann::json::array();
    d["planId"] = planId;
    d["missionId"] = missionId_;
    d["scene"] = scenarioKeyOf(engines_);

    // ---- 前置：方案必须已被采纳/确认（与 alloc.* 同一套语义）----
    if (adoptedStrikePlanId_ != planId && confirmedStrikePlanId_ != planId) {
        code = 1003;
        d["message"] = "打击方案前置未满足：先 strike.adopt → strike.confirm";
        d["adopted"] = adoptedStrikePlanId_;
        d["confirmed"] = confirmedStrikePlanId_;
        return d;
    }

    const nlohmann::json tpl = templateRawOfLocked(planId);
    if (tpl.empty()) {
        code = 1005;
        d["message"] = "scoring 的 templatesPack().raw 里没有模板：" + planId +
                       "（规则包未装载？）";
        return d;
    }
    // M5 字段**原样**带出（宿主不拼文案）
    d["template"] = tpl;

    const nlohmann::json geo = strikeGeometryOfLocked(tpl);
    d["geometry"] = geo;
    const nlohmann::json& geoDoc = strikeGeometryLocked();
    d["geometrySource"] = {{"path", geoDoc.value("path", std::string())},
                           {"loaded", geoDoc.value("loaded", false)},
                           {"attackStarts", geoDoc.contains("attackStarts") ? geoDoc["attackStarts"].size() : 0},
                           {"assessRoutes", geoDoc.contains("assessRoutes") ? geoDoc["assessRoutes"].size() : 0}};
    if (!geo.value("resolved", false)) {
        for (const auto& r : geo.value("reasons", nlohmann::json::array())) {
            notes.push_back(r.get<std::string>());
        }
        notes.push_back("该方案的几何未配置 → IP 点/评估航线/引导连线留空（MUST NOT 造坐标）；"
                        "时间轴里凡需要几何的段一并留空并写明原因");
    }

    // ---- ① IP 点 ----
    nlohmann::json ipOut = nullptr;
    double ipLng = 0.0, ipLat = 0.0, ipAlt = 0.0;
    bool hasIp = false;
    if (geo.contains("attackStart") && geo["attackStart"].is_object()) {
        const nlohmann::json& ip = geo["attackStart"];
        ipLng = ip.value("lng", 0.0);
        ipLat = ip.value("lat", 0.0);
        ipAlt = ip.value("altM", 0.0);
        hasIp = true;
        ipOut = ip;  // 原样（key/name/lng/lat/altM/source）
    }
    d["ipPoint"] = ipOut;

    // ---- ② 评估航线 ----
    d["assessRoute"] = (geo.contains("assessRoute") && geo["assessRoute"].is_object())
                           ? geo["assessRoute"]
                           : nlohmann::json(nullptr);
    nlohmann::json routeSummary = nlohmann::json::object();
    std::vector<std::pair<double, double>> routePts;
    if (geo.contains("assessRoute") && geo["assessRoute"].is_object() &&
        geo["assessRoute"].contains("waypoints")) {
        for (const auto& p : geo["assessRoute"]["waypoints"]) {
            routePts.emplace_back(p.value("lng", 0.0), p.value("lat", 0.0));
        }
    }
    const double routeLenM = polylineLengthM(routePts);
    routeSummary["waypointCount"] = static_cast<int>(routePts.size());
    routeSummary["lengthM"] = routeLenM;
    routeSummary["lengthBasis"] =
        "相邻航点大圆距离之和（WGS84 平均半径 6371008.8 m）；来源 = strike-geometry.json "
        "assessRoutes[].waypoints[]";
    d["assessRouteSummary"] = routeSummary;

    // ---- ③ 引导连线（起点 = 台账里已登记平台的**真实坐标**；走哪条集群由 clusters[] 决定）----
    //
    // 集群匹配口径与 `alloc.assign` **逐字相同**：方案 `clusters[]` 里的字符串 ↔ 场景编组
    // 显示名（deployment.json groups[].name）精确匹配。A15：键引用对不上就是**数据缺陷**，
    // 宿主 MUST NOT 用位置序/自造映射表兜底 —— 对不上就如实标 resolved=false 并点名。
    nlohmann::json lines = nlohmann::json::array();
    nlohmann::json groups = nlohmann::json::array();
    nlohmann::json knownGroups = nlohmann::json::array();
    // 一台"台账可用"的平台：场景行（型号/速度）+ **台账坐标**（到达段与连线段的唯一几何来源）
    struct LeadPlatform {
        const PlatformRow* row = nullptr;
        std::string entityId;
        double lng = 0.0;
        double lat = 0.0;
        double altM = 0.0;
    };
    // 到达段/评估段要用的"台账可用平台"（见下面的 LeadPlatform）
    std::vector<LeadPlatform> candidates;
    double speedSum = 0.0;
    int speedCount = 0;
#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST
    const std::vector<std::pair<std::string, std::string>> sceneGroups = scenarioGroupsOf(engines_);
    const std::vector<PlatformRow> allPlatforms = platformsOf(engines_);
#else
    const std::vector<std::pair<std::string, std::string>> sceneGroups;
    const std::vector<PlatformRow> allPlatforms;
#endif
    for (const auto& g : sceneGroups) knownGroups.push_back(g.second);

    const std::vector<std::string> planClusters =
        tpl.contains("clusters") && tpl["clusters"].is_array()
            ? tpl["clusters"].get<std::vector<std::string>>()
            : std::vector<std::string>{};
    int clusterResolved = 0;
    int membersTotal = 0;
    // `/api/state` 用的平台实体映射（装配期不存在；这里只读）
    nlohmann::json regMap = nlohmann::json::object();
    for (const auto& kv : entityIdOfDevice_) regMap[kv.first] = kv.second;

#if MA_WITH_LEDGER
    std::vector<entity_ledger::EntityRecord> ledgerRows;
    if (engines_.entityLedger && !missionId_.empty()) {
        ledgerRows = engines_.entityLedger->listEntities(entity_ledger::EntityQuery{missionId_});
    }
#endif
    // 一个集群的解析（同名匹配 → 逐台进台账取坐标 → 连线段）。
    // 抽成 lambda 是因为下面要**换一份集群清单再试一次**（见 dataDefect 那段）。
    auto resolveClusters = [&](const std::vector<std::string>& clusterNames, const char* clusterSource) {
        nlohmann::json outGroups = nlohmann::json::array();
        nlohmann::json outLines = nlohmann::json::array();
        int resolved = 0;
        int members = 0;
        double sum = 0.0;
        int cnt = 0;
        std::vector<LeadPlatform> leads;
        for (const auto& pc : clusterNames) {
            nlohmann::json g = nlohmann::json::object();
            g["planCluster"] = pc;
            g["clusterSource"] = clusterSource;
            std::string groupKey;
            for (const auto& sg : sceneGroups) {
                if (sg.second == pc) {
                    groupKey = sg.first;
                    break;
                }
            }
            if (groupKey.empty()) {
                g["resolved"] = false;
                g["reason"] =
                    "方案声明的集群名在场景编组（deployment.json groups[].name）里没有同名项 → "
                    "不编入任何平台，也不猜位置（A15：键引用不一致是数据缺陷，宿主不自造映射）";
                g["members"] = nlohmann::json::array();
                g["leader"] = nullptr;
                outGroups.push_back(g);
                continue;
            }
            g["resolved"] = true;
            g["groupKey"] = groupKey;
            nlohmann::json mem = nlohmann::json::array();
            for (const auto& p : allPlatforms) {
                if (p.groupKey != groupKey) continue;
                ++members;
                nlohmann::json m = nlohmann::json::object();
                m["deviceId"] = p.deviceId;
                m["model"] = p.model;
                m["station"] = {{"lng", p.lng}, {"lat", p.lat}, {"altM", p.alt}};
                m["speedMps"] = p.speed;
                // 台账里的那一台（引擎是台账的唯一权威）：有就用台账坐标，没有就留空 + 点名
                bool hasLedger = false;
#if MA_WITH_LEDGER
                const auto eit = entityIdOfDevice_.find(p.deviceId);
                const std::string wantId = eit == entityIdOfDevice_.end() ? std::string() : eit->second;
                const entity_ledger::EntityRecord* rec = nullptr;
                for (const auto& r : ledgerRows) {
                    if (!wantId.empty() && r.id == wantId) {
                        rec = &r;
                        break;
                    }
                }
                if (rec != nullptr) {
                    m["entityId"] = rec->id;
                    m["no"] = rec->no;
                    m["typeKey"] = rec->typeKey;
                    m["dynamicState"] = rec->dynamicState;
                    m["position"] = {{"lng", rec->lng}, {"lat", rec->lat}, {"altM", rec->alt}};
                    m["positionSource"] = "entity-ledger 台账（listEntities 的 lng/lat/alt；"
                                          "登记于 alloc.assign）";
                    hasLedger = true;
                    sum += p.speed;
                    ++cnt;
                }
#endif
                if (!hasLedger) {
                    m["entityId"] = nullptr;
                    m["position"] = nullptr;
                    m["positionSource"] = nullptr;
                    m["reason"] =
                        "台账里没有这台平台的已登记实体（未 alloc.assign 或登记被引擎拒）→ 连线起点留空";
                }
                // 引导连线：该平台 → IP 点（直线大圆，长度附在段上供脚本复算）
                if (hasIp && hasLedger) {
                    const double len = distanceM(m["position"]["lng"].get<double>(),
                                                 m["position"]["lat"].get<double>(), ipLng, ipLat);
                    outLines.push_back(
                        {{"groupId", groupKey},
                         {"from", {{"kind", "platform"},
                                   {"entityId", m["entityId"]},
                                   {"deviceId", p.deviceId},
                                   {"lng", m["position"]["lng"]},
                                   {"lat", m["position"]["lat"]},
                                   {"altM", m["position"]["altM"]},
                                   {"source", "entity-ledger 台账（alloc.assign 登记）"}}},
                         {"to", {{"kind", "ip-point"},
                                 {"key", geo["attackStart"].value("key", std::string())},
                                 {"name", geo["attackStart"].value("name", std::string())},
                                 {"lng", ipLng},
                                 {"lat", ipLat},
                                 {"altM", ipAlt}}},
                         {"lengthM", len},
                         {"lengthBasis", "平台→IP 点大圆距离（WGS84 平均半径 6371008.8 m）"}});
                }
                mem.push_back(std::move(m));
            }
            ++resolved;
            // 参与时间轴推算的平台：**第一台台账可用的**（到达段就用它；逐台算式见 lines[]）
            for (const auto& p : allPlatforms) {
                if (p.groupKey != groupKey) continue;
                const auto eit = entityIdOfDevice_.find(p.deviceId);
                if (eit == entityIdOfDevice_.end()) continue;
                bool inLedger = false;
                for (const auto& r : ledgerRows) {
                    if (r.id == eit->second) {
                        inLedger = true;
                        break;
                    }
                }
                if (inLedger) {
                    // ★ 到达段的 d 必须与引导连线**同一份坐标**（台账那份），否则两处会漂移：
                    //   到达算式里的 d_m 由脚本按 lines[].from 的大圆复算，两处必须是同一个来源。
                    for (const auto& r : ledgerRows) {
                        if (r.id == eit->second) {
                            leads.push_back({&p, r.id, r.lng, r.lat, r.alt});
                            break;
                        }
                    }
                    break;
                }
            }
            g["members"] = std::move(mem);
            g["leader"] = nullptr;
            outGroups.push_back(g);
        }
        return std::make_tuple(outGroups, outLines, resolved, members, sum, cnt, leads);
    };

    auto [groupsA, linesA, resolvedA, membersA, sumA, cntA, leadsA] =
        resolveClusters(planClusters, "plan");
    groups = std::move(groupsA);
    lines = std::move(linesA);
    clusterResolved = resolvedA;
    membersTotal = membersA;
    speedSum = sumA;
    speedCount = cntA;
    candidates = leadsA;
    std::string clusterSource = "plan";

    // ---- 数据缺陷时的**如实回退**（不是"猜位置"）----
    //
    // 场景一的打击模板 clusters[] 写的是"集群 1..6"（资源侧的口语名），而 deployment.json 的
    // 编组显示名是"前出侦察集群/侧翼侦察集群/…" —— **两套词汇对不上**（A15：数据缺陷，宿主
    // MUST NOT 自造映射表）。这时如果本次任务里**已经确认过一套编组方案**（`adoptedPlanId_`，
    // 它的 clusters[] 就是场景编组显示名 → `alloc.assign` 已按它登记了平台实体），就用那一套
    // 去取台账坐标，并在回执里**逐字写明**：`clusterSource=confirmed-group-plan` +
    // `dataDefect`（谁对不上、期望什么）。几何仍然只有一个出处 —— 台账，绝不编坐标。
    if (clusterResolved == 0 && !planClusters.empty() && !adoptedPlanId_.empty()) {
        const nlohmann::json gTpl = templateRawOfLocked(adoptedPlanId_);
        const std::vector<std::string> gClusters =
            gTpl.contains("clusters") && gTpl["clusters"].is_array()
                ? gTpl["clusters"].get<std::vector<std::string>>()
                : std::vector<std::string>{};
        if (!gClusters.empty()) {
            auto [groupsB, linesB, resolvedB, membersB, sumB, cntB, leadsB] =
                resolveClusters(gClusters, "confirmed-group-plan");
            if (resolvedB > 0) {
                groups = std::move(groupsB);
                lines = std::move(linesB);
                clusterResolved = resolvedB;
                membersTotal = membersB;
                speedSum = sumB;
                speedCount = cntB;
                candidates = leadsB;
                clusterSource = "confirmed-group-plan";
                d["dataDefect"] = {
                    {"field", "planTemplates.json items[<strike>].clusters[]"},
                    {"declared", planClusters},
                    {"expected", knownGroups},
                    {"detail", "打击模板的集群名与场景编组显示名（deployment.json groups[].name）"
                               "没有同名项 —— 键引用不一致（A15：属数据缺陷，宿主 MUST NOT 自造"
                               "映射表或按位置序兜底）"},
                    {"usedInstead", {{"clusterSource", "confirmed-group-plan"},
                                     {"planId", adoptedPlanId_},
                                     {"clusters", gClusters},
                                     {"why", "该编组方案已被采纳且 alloc.assign 已按它把平台登记"
                                             "进台账 → 连线起点仍是**台账里的真实坐标**"}}}};
                notes.push_back("打击模板的 clusters[] 与场景编组显示名对不上 → 引导连线改用**已确认的"
                                "编组方案**（" + adoptedPlanId_ + "）的集群与台账坐标；"
                                "见 dataDefect（数据缺陷如实上报，未编造任何位置）");
            }
        }
    }
    d["guidance"] = {{"groups", groups},
                     {"lines", lines},
                     {"clusterSource", clusterSource},
                     {"clustersDeclared", static_cast<int>(planClusters.size())},
                     {"clustersMatched", clusterResolved},
                     {"membersTotal", membersTotal},
                     {"linesTotal", static_cast<int>(lines.size())},
                     {"matchRule", "方案 clusters[] ↔ 场景编组显示名（deployment.json groups[].name）"
                                   "精确匹配 —— 与 alloc.assign 同一口径；连线起点坐标一律取自 "
                                   "entity-ledger 台账（alloc.assign 登记的实体）"}};
    d["knownScenarioGroups"] = knownGroups;
    d["platformEntities"] = regMap;
    if (clusterResolved < static_cast<int>(planClusters.size()) && clusterSource == "plan") {
        notes.push_back("有 " + std::to_string(static_cast<int>(planClusters.size()) - clusterResolved) +
                        " 条方案集群在场景编组里没有同名项 → 引导连线留空（规则包/数据键引用不一致，"
                        "属数据缺陷；宿主 MUST NOT 用位置序兜底，见实施方案 A15）");
    }
    if (lines.empty() && hasIp) {
        notes.push_back("引导连线为空：IP 点有几何，但参与该方案的平台在台账里没有可用的登记坐标"
                        "（先跑 alloc.plans→adopt→confirm→assign 把平台登记进台账）");
    }

    // ---- ④ 时间轴四项（t0 / 到达 / 打击 / 评估）----
    //
    // `t0` = **phase-engine 台账里当前阶段（本步是 T5）的 `enteredAt`** —— 任务进入该阶段的时刻。
    // 引擎没给（未装配/查不到）→ 留空并在 notes 点名，MUST NOT 用挂钟顶上。
    const PhaseView pv = phaseViewLocked();
    // t0 = **任务下达时刻**（§10.1-Q1 裁决：「预计完成时间」是相对 t0 的分钟，锚点 = 任务下达）。
    //
    // 口径：任务下达 = `flow.enter` 建任务那一刻（宿主在 createMission 成功时记下 missionStartMs_），
    // **不是**当前阶段的 enteredAt —— 用后者的话，每推进一个阶段"打击时刻"就往后滑一次，
    // 而"预计完成时间 48 分钟"是方案自身的属性，不该随操作漂移。
    // 取不到下达时刻（例如老任务/复位后未重进任务）时回落当前阶段的 enteredAt，并在 `basis` 里写明回落。
    const bool t0FromMission = missionStartMs_ > 0;
    const int64_t t0 = t0FromMission ? missionStartMs_ : pv.enteredAt;
    const double t0Min = static_cast<double>(t0) / 60000.0;

    const nlohmann::json planned = tpl.contains("plannedFinish") && tpl["plannedFinish"].is_object()
                                       ? tpl["plannedFinish"]
                                       : nlohmann::json::object();
    const std::string pfBasis = planned.value("basis", std::string());
    const int pfMinutes = planned.value("minutes", 0);
    const bool hasPlanMinutes = (pfBasis == "from-t0" && pfMinutes > 0);

    // 速度：台账里参与该方案的平台的实测速度均值（deployment.json aircraft[].speedMps）。
    const double avgSpeed = speedCount > 0 ? speedSum / speedCount : 0.0;

    // 到达：平台 → IP 点（取**第一个已解析集群里台账可用的那台**；坐标与连线段同一个来源）
    const LeadPlatform* lead = candidates.empty() ? nullptr : &candidates.front();
    double leadDistM = 0.0;
    bool hasArrival = false;
    int64_t arrivalMs = 0;
    double arrivalMinReal = 0.0;
    if (hasIp && lead != nullptr && lead->row != nullptr && lead->row->speed > 0.0) {
        leadDistM = distanceM(lead->lng, lead->lat, ipLng, ipLat);
        const double sec = leadDistM / lead->row->speed;
        arrivalMinReal = sec / 60.0;
        if (t0 > 0) {
            arrivalMs = t0 + static_cast<int64_t>(std::llround(sec * 1000.0));
            hasArrival = true;
        }
    }

    // 打击：规则包的 `plannedFinish{from-t0,minutes}`（Q1 裁决：相对 t0 的分钟）
    int64_t strikeMs = 0;
    if (t0 > 0 && hasPlanMinutes) strikeMs = t0 + static_cast<int64_t>(pfMinutes) * 60000;

    // 评估：打击完成时刻 + 评估航线实飞时长（航线总长 ÷ 速度）—— 「评估」不是拍出来的时刻
    double assessDurMin = 0.0;
    int64_t assessMs = 0;
    if (strikeMs > 0 && routeLenM > 0.0 && avgSpeed > 0.0) {
        const double sec = routeLenM / avgSpeed;
        assessDurMin = sec / 60.0;
        assessMs = strikeMs + static_cast<int64_t>(std::llround(sec * 1000.0));
    }

    nlohmann::json items = nlohmann::json::array();
    // t0
    {
        nlohmann::json b = basisJson(
            t0FromMission
                ? "t0 = 任务下达时刻（flow.enter 建任务那一刻，宿主记的 missionStartMs_，epoch ms）"
                : "t0 = phase-engine 台账里当前阶段的 enteredAt（回落：宿主没有任务下达时刻）",
            {{"missionId", missionId_},
             {"phaseKey", pv.phaseKey},
             {"enteredAt", t0},
             {"missionStartMs", missionStartMs_},
             {"fromMissionStart", t0FromMission},
             {"fromEngine", pv.fromEngine}},
            "phase::PhaseEngine::phaseContext(missionId).enteredAt（公开头 phase_engine.h:594）");
        nlohmann::json item = {{"key", "t0"},
                               {"name", "任务下达（t0）"},
                               {"atMs", t0 > 0 ? nlohmann::json(t0) : nlohmann::json(nullptr)},
                               {"atText", timeText(t0)},
                               {"basis", b}};
        if (t0 == 0) {
            item["note"] = "引擎没给 enteredAt → 留空（不用挂钟顶替）";
            notes.push_back("t0 留空：phase-engine 未返回 enteredAt");
        }
        items.push_back(std::move(item));
    }
    // 到达
    {
        nlohmann::json item = {{"key", "arrival"}, {"name", "预计到达 IP 点"}};
        if (hasArrival) {
            nlohmann::json b = basisJson(
                "到达 = t0 + (d / v) × 1000 ms；d = 平台→IP 点大圆距离（m），v = 平台实测速度（m/s）",
                {{"d_m", leadDistM},
                 {"v_mps", lead->row->speed},
                 {"platform", lead->row->deviceId},
                 {"entityId", lead->entityId},
                 {"fromLng", lead->lng},
                 {"fromLat", lead->lat},
                 {"ipKey", geo["attackStart"].value("key", std::string())},
                 {"ipLng", ipLng},
                 {"ipLat", ipLat},
                 {"t0", t0}},
                "平台位置 = entity-ledger 台账（alloc.assign 登记；与 guidance.lines[].from 同一份"
                "坐标）；速度 = 场景 deployment.json aircraft[].speedMps");
            item["atMs"] = arrivalMs;
            item["atText"] = timeText(arrivalMs);
            item["offsetMinutes"] = arrivalMinReal;
            item["t0PlusMinutes"] = t0Min + arrivalMinReal;
            item["basis"] = b;
        } else {
            item["atMs"] = nullptr;
            item["atText"] = "";
            item["basis"] = basisJson(
                "到达 = t0 + (d / v) × 1000 ms（本段无输入）",
                {{"t0", t0}, {"d_m", nullptr}, {"v_mps", nullptr}},
                "留空原因：需要 IP 点几何（strike-geometry.json）+ 台账里已登记平台的位置与速度");
            item["note"] = "留空：没有可用的 IP 点几何或台账平台坐标/速度（MUST NOT 编时刻）";
            notes.push_back("到达时刻留空：缺 IP 点几何或台账平台坐标/速度");
        }
        items.push_back(std::move(item));
    }
    // 打击
    {
        nlohmann::json item = {{"key", "strike"}, {"name", "打击完成（规则包预计完成时间）"}};
        if (strikeMs > 0) {
            nlohmann::json item2 = {{"key", "strike"},
                                    {"name", "打击完成（规则包预计完成时间）"},
                                    {"atMs", strikeMs},
                                    {"atText", timeText(strikeMs)},
                                    {"basis", basisJson(
                                         "打击 = t0 + plannedFinish.minutes × 60000 ms"
                                         "（Q1 裁决：相对 t0 的分钟）",
                                         {{"plannedFinish.basis", pfBasis},
                                          {"plannedFinish.minutes", pfMinutes},
                                          {"t0", t0}},
                                         "规则包 scoring/policies/mapapp/planTemplates.json → "
                                         "TemplatesPack.raw.items[<key>].plannedFinish"
                                         "（引擎不解析、经 raw 供宿主读取）")}};
            if (hasArrival) {
                item2["planned"] = true;
                item2["computed"] = false;
                item2["deltaVsArrivalMinutes"] =
                    (static_cast<double>(strikeMs - arrivalMs) / 60000.0);
            }
            if (hasArrival && strikeMs < arrivalMs) {
                item2["conflict"] =
                    {{"reason", "规则包的预计完成时间**早于**按实测算出的到达时刻"},
                     {"arrivalAtMs", arrivalMs},
                     {"strikeAtMs", strikeMs}};
                notes.push_back("时间轴冲突：plannedFinish.minutes 推算的打击时刻早于实测到达时刻 —— "
                                "两边都原样给出（宿主不替规则包改数）");
            }
            item = std::move(item2);
        } else {
            item["atMs"] = nullptr;
            item["atText"] = "";
            item["basis"] = basisJson("打击 = t0 + plannedFinish.minutes × 60000 ms（本段无输入）",
                                     {{"t0", t0},
                                      {"plannedFinish.basis", pfBasis},
                                      {"plannedFinish.minutes", pfMinutes}},
                                     "留空原因：模板的 plannedFinish 不是 {basis:\"from-t0\", minutes>0} "
                                     "或不含该字段");
            item["note"] = "留空：模板未声明可用的 plannedFinish";
            notes.push_back("打击时刻留空：模板未声明 plan 侧的 plannedFinish{from-t0,minutes}");
        }
        items.push_back(std::move(item));
    }
    // 评估
    {
        nlohmann::json item = {{"key", "assess"}, {"name", "评估完成（评估航线飞完）"}};
        if (assessMs > 0) {
            item["atMs"] = assessMs;
            item["atText"] = timeText(assessMs);
            item["offsetMinutes"] = assessDurMin;
            item["basis"] =
                basisJson("评估 = 打击 + (L / v) × 1000 ms；L = 评估航线折线总长（m），"
                          "v = 参与该方案平台的实测速度均值（m/s）",
                          {{"L_m", routeLenM},
                           {"v_mps", avgSpeed},
                           {"speedSamples", speedCount},
                           {"waypointCount", static_cast<int>(routePts.size())},
                           {"strikeAtMs", strikeMs}},
                          "航线几何 = strike-geometry.json assessRoutes[].waypoints[]；"
                          "速度 = 场景 deployment.json aircraft[].speedMps");
        } else {
            item["atMs"] = nullptr;
            item["atText"] = "";
            item["basis"] = basisJson("评估 = 打击 + (L / v) × 1000 ms（本段无输入）",
                                     {{"strikeAtMs", strikeMs},
                                      {"L_m", routeLenM},
                                      {"v_mps", avgSpeed}},
                                     "留空原因：缺评估航线几何、打击时刻或台账平台速度");
            item["note"] = "留空：评估航线/打击时刻/速度三者有缺（MUST NOT 编时刻）";
            notes.push_back("评估时刻留空：缺评估航线几何或平台速度");
        }
        items.push_back(std::move(item));
    }

    d["timeline"] = {{"anchor", {{"kind", t0FromMission ? "mission-start" : "phase-enteredAt"},
                                 {"phaseKey", pv.phaseKey},
                                 {"enteredAt", t0},
                                 {"atText", timeText(t0)},
                                 {"fromMissionStart", t0FromMission},
                                 {"source", t0FromMission
                                                ? "宿主：flow.enter 建任务的时刻（任务下达）"
                                                : "phase::PhaseContext.enteredAt（phase-engine 台账，回落）"}}},
                     {"items", items}};
    d["assessFlight"] = {{"lengthM", routeLenM},
                         {"speedMps", avgSpeed},
                         {"speedSamples", speedCount},
                         {"durationMinutes", assessDurMin}};
    d["notes"] = std::move(notes);
    d["source"] = "宿主：几何 ← scenario-data/strike-geometry.json + entity-ledger 台账；"
                  "字段 ← scoring TemplatesPack.raw（原样）；时刻 ← 每段 basis 里的算式";
    return d;
}

// ============================================================================
// 步 10–11（P6）共用工具：**只做形状翻译与算式展开**（与 P3–P5 同一纪律）
// ============================================================================

namespace {

/// 标准重力加速度（m/s²）。**物理常数**（不是业务取值）—— 俯冲终端速度的算式里只有它、
/// 巡航速度（场景声明 / 读数）与高度差（读数）三个输入，脚本可逐项复算。
constexpr double kStdGravityMps2 = 9.80665;

/// 每度纬度对应的米数（= R·π/180，R = WGS84 平均半径）。只用于"以某点为中心画一个方框"。
double metersPerDegLat() { return kEarthRadiusM * 3.14159265358979323846 / 180.0; }

/// 以 (lng,lat) 为中心、半边长 halfM 的正方形环（西南 → 东南 → 东北 → 西北）。
///
/// ★ 为什么是"方框"而不是"就是那个点"：`sim_source` 的 `validateScenario` 用 `validRing`
///   拒**面积为零**的多边形，所以必须给一个合法环；但航路端点取的是**区质心**，而对称方框的
///   质心 = 中心点本身 → 端点逐字等于数据点（IP 点 / 台账目标位置），与半边长无关。
///   半边长取规则包 `entityTypes.json` 的 `dedup.spaceRadiusM`（引擎自己的"同一位置"空间半径，
///   键引用；宿主 MUST NOT 自造半径）—— 出处由调用方写进回执。
std::vector<std::pair<double, double>> squareAround(double lng, double lat, double halfM) {
    const double dLat = halfM / metersPerDegLat();
    const double cosLat = std::cos(rad(lat));
    const double dLng = (std::fabs(cosLat) < 1e-9) ? dLat : (halfM / (metersPerDegLat() * cosLat));
    std::vector<std::pair<double, double>> out;
    out.emplace_back(lng - dLng, lat - dLat);
    out.emplace_back(lng + dLng, lat - dLat);
    out.emplace_back(lng + dLng, lat + dLat);
    out.emplace_back(lng - dLng, lat + dLat);
    return out;
}

/// 局部等距圆柱投影：以 (refLng,refLat) 为原点，东/北/上三轴（米）。
/// 只服务"读数派生"的最近接近判定（与本文件 `distanceM` 同一条纪律：**不是地图投影**）。
struct LocalXyz {
    double e = 0.0;  // 东（米）
    double n = 0.0;  // 北（米）
    double u = 0.0;  // 上（米）= 海拔
};

LocalXyz toLocalXyz(double lng, double lat, double altM, double refLng, double refLat) {
    LocalXyz v;
    v.e = rad(lng - refLng) * kEarthRadiusM * std::cos(rad(refLat));
    v.n = rad(lat - refLat) * kEarthRadiusM;
    v.u = altM;
    return v;
}

double len3(const LocalXyz& v) { return std::sqrt(v.e * v.e + v.n * v.n + v.u * v.u); }

LocalXyz sub3(const LocalXyz& a, const LocalXyz& b) {
    return LocalXyz{a.e - b.e, a.n - b.n, a.u - b.u};
}

/// 点到线段 [a,b] 的三维最近距离（米）；`tOut` = 最近点的线段参数（0..1，可据它插值时刻）。
double segPointDistanceM(const LocalXyz& a, const LocalXyz& b, const LocalXyz& p, double& tOut) {
    const double dx = b.e - a.e, dy = b.n - a.n, dz = b.u - a.u;
    const double den = dx * dx + dy * dy + dz * dz;
    double t = 0.0;
    if (den > 1e-12) {
        t = ((p.e - a.e) * dx + (p.n - a.n) * dy + (p.u - a.u) * dz) / den;
        if (t < 0.0) t = 0.0;
        if (t > 1.0) t = 1.0;
    }
    tOut = t;
    const LocalXyz q{a.e + dx * t, a.n + dy * t, a.u + dz * t};
    return len3(LocalXyz{p.e - q.e, p.n - q.n, p.u - q.u});
}

/// FNV-1a 64 → 16 位小写十六进制（与各引擎 digest 同算法）。这里只用来给"逐字相等"留证据。
std::string fnv1a64Hex(const std::string& text) {
    std::uint64_t h = 1469598103934665603ull;
    for (unsigned char ch : text) {
        h ^= static_cast<std::uint64_t>(ch);
        h *= 1099511628211ull;
    }
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%016llx", static_cast<unsigned long long>(h));
    return std::string(buf);
}

/// 从 entity-ledger 的 `effectivePolicies()` 导出里取一个段。
///
/// ★ 实测（踩过）：引擎导出的形状与**规则包文件**不同 —— 文件里 `actions` / `dynamicStates` /
///   `dedup` 是顶层键，而 `effectivePolicies()` 把它们挂在 `entityTypes` 下
///   （`policies.cc:369/379/449`）。所以这里两处都找，并把用的是哪一处记进回执（`policiesShape`）。
///   取不到 → 空 JSON（调用方必须按"缺声明"如实处理，MUST NOT 猜一个默认值）。
nlohmann::json ledgerPolicySection(const nlohmann::json& eff, const std::string& key,
                                   std::string& shape) {
    if (eff.is_object() && eff.contains(key)) {
        shape = "effectivePolicies()." + key + "（顶层）";
        return eff[key];
    }
    if (eff.is_object() && eff.contains("entityTypes") && eff["entityTypes"].is_object() &&
        eff["entityTypes"].contains(key)) {
        shape = "effectivePolicies().entityTypes." + key + "（引擎导出把规则包顶层段挂在这里）";
        return eff["entityTypes"][key];
    }
    shape = "未找到段：" + key;
    return nlohmann::json();
}

#if MA_WITH_REPORT
/// report-engine 的 `ITemplateSource` 实现：**宿主从规则包目录读模板**（引擎自身绝不读文件）。
/// 只在 `report.generate` 里临时注入；取不到 → `load` 返 false，引擎按口径回落内置模板并写警告。
class RuleFileTemplateSource final : public report_engine::ITemplateSource {
public:
    void set(const std::string& name, std::string text) { entries_[name] = std::move(text); }
    bool load(const std::string& name, std::string& out) const override {
        const auto it = entries_.find(name);
        if (it == entries_.end()) return false;
        out = it->second;
        return true;
    }
    std::size_t count() const { return entries_.size(); }

private:
    std::map<std::string, std::string> entries_;
};

/// 报告生成用的挂钟（引擎口径：一次生成**恰好读一次** `nowMs()`）。
class ReportWallClock final : public report_engine::IClock {
public:
    int64_t nowMs() const override { return wallClockMs(); }
};
#endif  // MA_WITH_REPORT

}  // namespace

#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST

// ============================================================================
// 步 10 ③：仿真侧俯冲剖面 + **由读数派生**的命中判定
// ============================================================================
//
// `sim-source` **没有"命中"事件**（它的出口只有位置类事件与观测），也**没有**改单台高度/速度
// 的入口（平台高度是常量，运动学只有水平航路）。所以这一步只有一条能站住的路：
//   · 用 `SimSource::init(SimScenario)`（**唯一**能改平台高度/速度的引擎入口，且失败时原子保留
//     旧局面）把参与俯冲的那一组平台重挂到"IP 点 → 目标位置"这条航路上，高度 = **台账目标高度**、
//     速度 = 由巡航速度与下降高度按能量关系推出的终端速度；
//   · 停驱动线程后用 `Driver::stepOnce(dt)` 逐帧推进，每帧读 `SimSource::entities()`；
//   · 命中 = **相邻两帧读数构成的轨迹段**与台账目标位置的三维最近接近距离 ≤ R，
//     R = 规则包 `entityTypes.json` 的 `dedup.spaceRadiusM`（引擎自己的"同一位置"半径，键引用）。
//     MUST NOT 写死"命中了"：判据与每一个输入都进 `basis`，脚本按同一算式独立复算。
//
// ★ 纪律：本函数只读引擎读数、只写引擎入参；不产生任何"看运气"的常量。

struct DiveOutcome {
    bool applied = false;   ///< 剖面是否真的施加并跑完（引擎拒了 init 就是 false）
    bool hit = false;       ///< 是否由读数派生出命中
    std::string hitPlatform;///< 命中的平台 deviceId（空 = 未派生到）
    nlohmann::json payload = nlohmann::json::object();
};

/// 施加俯冲剖面并派生命中。
///
/// 入参出处：`ipPoint` 来自 `strike-geometry.json`（`attackStart`，经规则包的键引用），为空则
/// 回落"领队平台的当前读数位置"（回执里如实标注回落到哪）；`tgtLng/tgtLat/tgtAlt` 来自
/// entity-ledger 台账（目标位置的权威）；`areaHalfM` 来自规则包（构成合法多边形的半边长）。
DiveOutcome runDiveLocked(Engines& engines, const std::string& entityId, double tgtLng, double tgtLat,
                          double tgtAltM, const std::string& targetSource,
                          const nlohmann::json& ipPoint, const std::string& ipSourceIn,
                          const std::vector<std::string>& preferredDevices, const nlohmann::json& params,
                          double areaHalfM, const std::string& areaHalfMSource) {
    DiveOutcome out;
    nlohmann::json d = nlohmann::json::object();
    nlohmann::json notes = nlohmann::json::array();
    d["entityId"] = entityId;

    if (!engines.bridge.engine || !engines.bridge.driver) {
        d["applied"] = false;
        d["reason"] = "仿真源未装配（sim-source / 接入层未编译进来）→ 拿不到俯冲/命中的读数";
        notes.push_back("俯冲与命中都没做：没有仿真读数就没有判据输入（MUST NOT 凭空写'命中'）");
        d["notes"] = notes;
        out.payload = d;
        return out;
    }
    sim_source::SimSource& sim = *engines.bridge.engine;
    ma::sim_bridge::Driver& drv = *engines.bridge.driver;

    // ---- ① 俯冲前的现场读数（位置/高度/速度全部从引擎读，不取配置文件）----
    const std::vector<sim_source::EntityStatus> before = sim.entities();
    auto findEnt = [](const std::vector<sim_source::EntityStatus>& rows, const std::string& id,
                      sim_source::EntityStatus& outE) {
        for (const auto& e : rows) {
            if (e.id == id) {
                outE = e;
                return true;
            }
        }
        return false;
    };

    // 候选平台：① 引导方案涉及的平台（调用方给的）→ ② 读数里的全部平台（兜底并如实标注）
    std::vector<std::string> cand = preferredDevices;
    const bool candFromPlan = !cand.empty();
    if (cand.empty()) {
        for (const auto& e : before) {
            if (!e.isTarget) cand.push_back(e.id);
        }
    }
    const LocalXyz tgtPt = toLocalXyz(tgtLng, tgtLat, tgtAltM, tgtLng, tgtLat);  // 参考点 = 目标

    // 领队 = **当前读数里离目标最近**的一台（读数派生；不是配置顺序、不是写死的编号）
    std::string lead;
    sim_source::EntityStatus leadSt;
    double leadRange = 0.0;
    for (const auto& id : cand) {
        sim_source::EntityStatus st;
        if (!findEnt(before, id, st)) continue;
        const double dd = len3(sub3(toLocalXyz(st.lng, st.lat, st.altM, tgtLng, tgtLat), tgtPt));
        if (lead.empty() || dd < leadRange) {
            lead = id;
            leadSt = st;
            leadRange = dd;
        }
    }
    if (lead.empty()) {
        d["applied"] = false;
        d["reason"] = "候选平台在仿真读数（SimSource::entities()）里一台都对不上 → 没有俯冲主体";
        d["candidates"] = cand;
        d["candidateSource"] = candFromPlan ? "引导方案（guidance.lines[].from.entityId → deviceId）"
                                            : "仿真读数里的全部平台";
        d["notes"] = notes;
        out.payload = d;
        return out;
    }

    // ---- ② 俯冲剖面：巡航档 → 终端档（三个输入都有出处）----
    //
    // ★ 巡航速度优先取**读数**；但平台已经 `arrived` 时读数是 0（引擎口径：到位即停），
    //   这时回落到**场景声明的速度**（装配期那一份，引擎自己也是这么回落的）—— 两个来源都记进 basis。
    // 巡航档（俯冲剖面的起点）：**优先取装配期场景的声明值**，再与当场读数并列给出。
    //
    // ★ 为什么不是"只取读数"（实测踩过）：同一进程里第二次 `exec.run` 时，平台还飞着上一次的
    //   终端档（读数高度已经是 0 / 速度是上次推出来的值）→ 拿读数当巡航档会得到 Δh=0 的"空剖面"
    //   （第 2 次起就没有高度落差，看起来像没做俯冲）。装配期场景声明值是稳定的，读数另给作对照。
    const sim_source::SimScenario pristine = engines.bridge.scenario;  // 装配期那一份（未被动过）
    double cruiseAltM = leadSt.altM;        // 读数（对照）
    double cruiseSpeedMps = leadSt.speedMps;
    std::string cruiseSpeedSource = "SimSource::entities() 读数（speedMps）";
    std::string cruiseAltSource = "SimSource::entities() 读数（altM）";
    for (const auto& p : pristine.platforms) {
        if (p.deviceId != lead) continue;
        if (std::isfinite(p.altM)) {
            cruiseAltM = p.altM;
            cruiseAltSource = "装配期场景声明的 Platform::altM（deployment.json 的 aircraft[].altM；"
                              "装配期那一份场景，未被动过）";
        }
        if (p.speedMps > 0.0) {
            cruiseSpeedMps = p.speedMps;
            cruiseSpeedSource = "装配期场景声明的 Platform::speedMps（deployment.json 的 "
                                "aircraft[].speedMps；装配期那一份场景，未被动过）";
        }
    }
    const double diveAltM = tgtAltM;  // 终点高度 = 台账目标高度（权威）
    const double dropM = cruiseAltM - diveAltM;
    const double diveSpeedMps =
        (dropM > 0.0) ? std::sqrt(cruiseSpeedMps * cruiseSpeedMps + 2.0 * kStdGravityMps2 * dropM)
                      : cruiseSpeedMps;
    const double legLenM = distanceM(leadSt.lng, leadSt.lat, tgtLng, tgtLat);

    // 俯冲起点（IP 点）：优先用已确认方案的几何；没有就回落领队的当前读数位置（如实标注）
    double ipLng = leadSt.lng, ipLat = leadSt.lat, ipAltM = cruiseAltM;
    std::string ipSource = ipSourceIn;
    nlohmann::json ipOut = ipPoint;
    if (ipPoint.is_object() && ipPoint.contains("lng") && ipPoint.contains("lat")) {
        ipLng = ipPoint.value("lng", leadSt.lng);
        ipLat = ipPoint.value("lat", leadSt.lat);
        ipAltM = ipPoint.value("altM", cruiseAltM);
    } else {
        ipOut = nlohmann::json{{"key", nullptr},
                               {"name", "（无已确认方案的 IP 点几何）"},
                               {"lng", leadSt.lng},
                               {"lat", leadSt.lat},
                               {"altM", cruiseAltM}};
        ipSource = "回落：领队平台 " + lead + " 的**当前读数位置**（SimSource::entities()）—— "
                   "没有可用的 IP 点几何（未 strike.adopt/confirm 或场景几何缺该键）";
    }
    const double legFromIpM = distanceM(ipLng, ipLat, tgtLng, tgtLat);

    // ---- ③ 重挂场景（唯一入口；`init` 失败时引擎自己保留旧局面，原子）----
    //
    // ★ 基线用**装配期那一份场景**（`Engines::bridge.scenario`，从未被改过）而不是当前场景：
    //   俯冲会改场景（平台高度/速度/进出区），拿当前场景当基线的话第二次 exec.run 就是"在
    //   上一次的俯冲结果上再俯冲"（高度档已经没有落差）。锚点（其余平台）每次都用**当前读数**
    //   重算，所以与基线无关。
    sim_source::SimScenario scen = pristine;
    auto upsertArea = [&scen](const sim_source::Area& a) {
        for (auto it = scen.areas.begin(); it != scen.areas.end(); ++it) {
            if (it->key == a.key) {
                scen.areas.erase(it);
                break;
            }
        }
        scen.areas.push_back(a);
    };
    const std::string ipAreaKey = "dive-ip-" + entityId;
    const std::string tgAreaKey = "dive-target-" + entityId;
    sim_source::Area ipArea;
    ipArea.key = ipAreaKey;
    ipArea.name = "俯冲起点区（IP 点）";
    ipArea.role = sim_source::AreaRole::Deploy;
    ipArea.polygon = squareAround(ipLng, ipLat, areaHalfM);
    upsertArea(ipArea);
    sim_source::Area tgArea;
    tgArea.key = tgAreaKey;
    tgArea.name = "俯冲终点区（台账目标位置）";
    tgArea.role = sim_source::AreaRole::Task;
    tgArea.polygon = squareAround(tgtLng, tgtLat, areaHalfM);
    upsertArea(tgArea);

    nlohmann::json edits = nlohmann::json::array();
    // 参与俯冲的整组：编队基航路按 `members.front()` 的进出区规划 —— 只改一台的话，
    // 基航路未必是俯冲线（引擎的规划口径决定的，见 sim-source plan.cc）。同组一起改才自洽。
    std::vector<std::string> diveDevices;
    for (const auto& e : before) {
        if (e.isTarget) continue;
        if (e.id == lead || e.groupKey == leadSt.groupKey) diveDevices.push_back(e.id);
    }
    if (diveDevices.empty()) diveDevices.push_back(lead);
    for (auto& p : scen.platforms) {
        const bool dive =
            std::find(diveDevices.begin(), diveDevices.end(), p.deviceId) != diveDevices.end();
        if (dive) {
            edits.push_back({{"deviceId", p.deviceId},
                             {"kind", "dive"},
                             {"homeAreaKey", {{"from", p.homeAreaKey}, {"to", ipAreaKey}}},
                             {"taskAreaKey", {{"from", p.taskAreaKey}, {"to", tgAreaKey}}},
                             {"startOffsetM",
                              {{"from", {p.startOffset.rightM, p.startOffset.fwdM}}, {"to", {0.0, 0.0}}}},
                             {"altM", {{"from", p.altM}, {"to", diveAltM}}},
                             {"speedMps", {{"from", p.speedMps}, {"to", diveSpeedMps}}}});
            p.homeAreaKey = ipAreaKey;
            p.taskAreaKey = tgAreaKey;
            p.startOffset = sim_source::FormationSlot{};
            p.altM = diveAltM;
            p.speedMps = diveSpeedMps;
            continue;
        }
        // 其余平台：把出发点**锚在它的当前读数位置**（不锚的话 `init` 会把整队拉回集结区 ——
        // 实体是从各自航路起点重新生成的，这是引擎语义，宿主保不住"世界状态"；如实锚定并记账）
        sim_source::EntityStatus st;
        if (!findEnt(before, p.deviceId, st)) {
            notes.push_back("平台 " + p.deviceId + " 在读数里找不到 → 出发点保持场景原值"
                            "（init 后它会回到原航路起点）");
            continue;
        }
        sim_source::Area a;
        a.key = "resume-anchor-" + p.deviceId;
        a.name = "续飞锚点（当前读数位置）";
        a.role = sim_source::AreaRole::Deploy;
        a.polygon = squareAround(st.lng, st.lat, areaHalfM);
        upsertArea(a);
        edits.push_back({{"deviceId", p.deviceId},
                         {"kind", "resume"},
                         {"homeAreaKey", {{"from", p.homeAreaKey}, {"to", a.key}}},
                         {"startOffsetM", {{"from", {p.startOffset.rightM, p.startOffset.fwdM}},
                                           {"to", {0.0, 0.0}}}},
                         {"anchor", {{"lng", st.lng}, {"lat", st.lat}, {"altM", st.altM}}},
                         {"anchorSource", "SimSource::entities() 读数（不是配置文件里的站位）"}});
        p.homeAreaKey = a.key;
        p.startOffset = sim_source::FormationSlot{};
    }

    const sim_source::ValidationResult vr = sim.init(scen);
    if (!vr.ok) {
        nlohmann::json issues = nlohmann::json::array();
        for (const auto& i : vr.issues) {
            issues.push_back({{"path", i.path}, {"field", i.field}, {"reason", i.reason}});
        }
        d["applied"] = false;
        d["reason"] = "SimSource::init(俯冲场景) 被引擎拒（引擎已保留原局面，本轮没有改仿真）";
        d["issues"] = issues;
        d["scenarioEdits"] = edits;
        notes.push_back("俯冲剖面未施加：引擎的 validateScenario 拒绝 → 回执给出逐条 issues");
        d["notes"] = notes;
        out.payload = d;
        return out;
    }

    // ---- ④ 逐帧采样（停驱动线程 → 解除暂停 → stepOnce(dt) 推**仿真**毫秒）----
    const bool wasRunning = drv.running();
    const bool wasPaused = drv.paused();
    if (wasRunning) drv.stop();
    if (wasPaused) drv.resume();
    const int64_t dtMs = std::max<int64_t>(50, static_cast<int64_t>(intOr(params, "dtMs", 1000)));
    int maxSteps = intOr(params, "maxSteps", 0);
    if (maxSteps <= 0) {
        const double etaS = (legFromIpM > 0.0 && diveSpeedMps > 0.0) ? legFromIpM / diveSpeedMps : 0.0;
        maxSteps = static_cast<int>(std::ceil(etaS * 1000.0 / static_cast<double>(dtMs) * 1.5)) + 6;
        if (maxSteps < 8) maxSteps = 8;
        if (maxSteps > 240) maxSteps = 240;
    }

    const sim_source::Metrics mBefore = sim.metrics();
    nlohmann::json samples = nlohmann::json::array();
    std::map<std::string, sim_source::EntityStatus> prevSt;
    std::map<std::string, LocalXyz> prevLoc;  // 上一帧读数所在的局部坐标（命中段起点，供复算）
    std::map<std::string, int64_t> prevTs;
    int steps = 0;
    bool hitFound = false;
    int crossings = 0;      // 满足判据的轨迹段数（可能不止一段）
    double hitBestM = 0.0;  // 命中段的最近接近距离（取最小）
    nlohmann::json hit = nlohmann::json::object();
    for (int i = 0; i < maxSteps; ++i) {
        drv.stepOnce(dtMs);
        ++steps;
        const std::vector<sim_source::EntityStatus> now = sim.entities();
        const int64_t nowTs = sim.simElapsedMs();
        int arrived = 0;
        for (const auto& id : diveDevices) {
            sim_source::EntityStatus st;
            if (!findEnt(now, id, st)) continue;
            const LocalXyz cur = toLocalXyz(st.lng, st.lat, st.altM, tgtLng, tgtLat);
            const double rangeM = len3(sub3(cur, tgtPt));
            samples.push_back({{"i", i},
                               {"platformId", id},
                               {"simElapsedMs", nowTs},
                               {"simNowMs", sim.simNowMs()},
                               {"lng", st.lng},
                               {"lat", st.lat},
                               {"altM", st.altM},
                               {"speedMps", st.speedMps},
                               {"motionState", std::string(sim_source::toString(st.state))},
                               {"arrivedFlag", st.state == sim_source::MotionState::Arrived},
                               {"rangeToTargetM", rangeM}});
            if (st.state == sim_source::MotionState::Arrived) ++arrived;
            const auto pit = prevLoc.find(id);
            if (pit != prevLoc.end()) {
                double t = 0.0;
                const double segLen = len3(sub3(cur, pit->second));
                const double dd = segPointDistanceM(pit->second, cur, tgtPt, t);
                if (segLen > 1e-6 && dd <= areaHalfM) {
                    // ★ 判据满足的段可能不止一段 → 取**最近接近**的那一段当命中段
                    //   （命中时刻 = 最近点时刻；"打中最接近的那一下"比"第一次进圈"更站得住）
                    ++crossings;
                    if (!hitFound || dd < hitBestM) {
                        hitFound = true;
                        hitBestM = dd;
                        const int64_t ts0 = prevTs[id];
                        const sim_source::EntityStatus& s0 = prevSt[id];
                        const double atMs =
                            static_cast<double>(ts0) + t * static_cast<double>(nowTs - ts0);
                        const int64_t epoch0 = sim.simNowMs() - nowTs;
                        hit = nlohmann::json::object();
                        hit["detected"] = true;
                        hit["platformId"] = id;
                        hit["groupKey"] = st.groupKey;
                        hit["segment"] = {
                            {"from",
                             {{"i", i - 1},
                              {"simElapsedMs", ts0},
                              {"lng", s0.lng},
                              {"lat", s0.lat},
                              {"altM", s0.altM},
                              {"speedMps", s0.speedMps},
                              {"localENU",
                               {{"e", pit->second.e}, {"n", pit->second.n}, {"u", pit->second.u}}}}},
                            {"to",
                             {{"i", i},
                              {"simElapsedMs", nowTs},
                              {"lng", st.lng},
                              {"lat", st.lat},
                              {"altM", st.altM},
                              {"speedMps", st.speedMps},
                              {"localENU", {{"e", cur.e}, {"n", cur.n}, {"u", cur.u}}}}}};
                        hit["minDistanceM"] = dd;
                        hit["segmentLengthM"] = segLen;
                        hit["tOnSegment"] = t;
                        hit["atSimElapsedMs"] = static_cast<int64_t>(std::llround(atMs));
                        hit["atMs"] = epoch0 + static_cast<int64_t>(std::llround(atMs));
                        hit["simEpoch0Ms"] = epoch0;
                        hit["altAtHitM"] = pit->second.u + (cur.u - pit->second.u) * t;
                        hit["basis"] = {
                            {"formula",
                             "命中 = ∃相邻两帧读数 (P_i,P_i+1)：线段 [P_i,P_i+1] 到台账目标位置 T 的三维"
                             "最近接近距离 d ≤ R；命中段 = 全部满足段的**最近接近**那一段；"
                             "命中时刻 = t_i + t*·(t_i+1 − t_i)（t* = 最近点的线段参数）"},
                            {"inputs",
                             {{"P_i_enu_m",
                               {{"e", pit->second.e}, {"n", pit->second.n}, {"u", pit->second.u}}},
                              {"P_i1_enu_m", {{"e", cur.e}, {"n", cur.n}, {"u", cur.u}}},
                              {"T_enu_m", {{"e", tgtPt.e}, {"n", tgtPt.n}, {"u", tgtPt.u}}},
                              {"d_m", dd},
                              {"R_m", areaHalfM},
                              {"tStar", t},
                              {"t_i", ts0},
                              {"t_i1", nowTs}}},
                            {"source",
                             "读数 = SimSource::entities()（每 stepOnce 一帧：平台 lng/lat/altM/speedMps）；"
                             "目标位置 = entity-ledger 台账（getEntity 的 lng/lat/alt）；R = 规则包 "
                             "entityTypes.json 的 dedup.spaceRadiusM"},
                            {"projection",
                             "局部等距圆柱投影（e=Δlng·R⊕·cos(lat₀)，n=Δlat·R⊕，u=alt；"
                             "参考点 = 目标台账位置）"}};
                    }
                }
            }
            prevLoc[id] = cur;
            prevSt[id] = st;
            prevTs[id] = nowTs;
        }
        if (hitFound && arrived >= static_cast<int>(diveDevices.size())) break;
    }
    const sim_source::Metrics mAfter = sim.metrics();

    // 采样结束：把驱动恢复到采样前的状态（跑着的继续跑，暂停的仍然暂停）
    if (wasPaused) drv.pause();
    if (wasRunning) {
        drv.primeNow();
        drv.start();
    }

    // ---- ⑤ 回执 ----
    nlohmann::json profile = nlohmann::json::object();
    profile["cruiseAltM"] = cruiseAltM;
    profile["diveAltM"] = diveAltM;
    profile["cruiseSpeedMps"] = cruiseSpeedMps;
    profile["diveSpeedMps"] = diveSpeedMps;
    profile["dropM"] = dropM;
    profile["liveReadingAtStart"] = {{"altM", leadSt.altM},
                                     {"speedMps", leadSt.speedMps},
                                     {"source", "SimSource::entities() 读数（施加剖面**之前**的"
                                                "当场读数，作对照；第二次 exec.run 时它可能已经是"
                                                "上一次的终端档）"}};
    profile["basis"] =
        {{"formula", "终端俯冲速度 v = √(v₀² + 2·g·Δh)；Δh = 巡航高度（装配期场景声明）− 目标台账高度"},
         {"inputs", {{"v0_mps", cruiseSpeedMps}, {"g_mps2", kStdGravityMps2}, {"dh_m", dropM}}},
         {"v0Source", cruiseSpeedSource},
         {"altSource", cruiseAltSource},
         {"source", "巡航档 = 装配期场景声明（deployment.json，经 scenario-data → SimScenario）；"
                    "目标高度 = entity-ledger 台账；g = 标准重力加速度（物理常数）"},
         {"note", "sim-source 的平台高度是**常量**（引擎没有垂直运动学），所以俯冲只能以两个"
                  "**高度档**表达：巡航档 → 终端档；速度档同理。MUST NOT 声称有连续下降率"}};
    nlohmann::json scenOut = nlohmann::json::object();
    scenOut["ipPoint"] = ipOut;
    scenOut["ipSource"] = ipSource;
    scenOut["target"] = {{"lng", tgtLng}, {"lat", tgtLat}, {"altM", tgtAltM}, {"source", targetSource}};
    scenOut["leadPlatformId"] = lead;
    scenOut["leadRangeAtStartM"] = leadRange;
    scenOut["candidateSource"] = candFromPlan ? "引导方案（guidance.lines[].from.entityId → deviceId）"
                                              : "仿真读数里的全部平台";
    scenOut["diveDevices"] = diveDevices;
    scenOut["legFromIpM"] = legFromIpM;
    scenOut["legLengthM"] = legLenM;
    scenOut["legBasis"] = "大圆距离（WGS84 平均半径 6371008.8 m）：IP 点 → 台账目标位置";
    scenOut["areaHalfM"] = areaHalfM;
    scenOut["areaHalfMSource"] = areaHalfMSource;
    scenOut["baseline"] = "装配期场景（Engines::bridge.scenario，未被改过）+ 本次俯冲编辑";
    scenOut["edits"] = edits;
    scenOut["simClockAfterInit"] = {{"simElapsedMs", sim.simElapsedMs()},
                                    {"simNowMs", sim.simNowMs()},
                                    {"note", "`SimSource::init` 会把仿真时钟归零（epoch0=0 / "
                                             "simElapsedMs=0，引擎口径）→ 俯冲段的时刻是**仿真相对毫秒**；"
                                             "命中回执里给了 simEpoch0Ms，驱动线程恢复后的首个 tick 会"
                                             "重新建立绝对 epoch"}};
    scenOut["note"] = "为得到俯冲/命中的**可观测读数**，宿主用 SimSource::init 重载了一份同场景"
                      "（只改参与俯冲那一组的进出区与高度/速度档，其余平台锚在当前读数位置）——"
                      "这是引擎唯一能改高度/速度的入口；重载**不改变**任务台账与阶段状态。";
    d["applied"] = true;
    d["profile"] = profile;
    d["scenario"] = scenOut;
    d["sampling"] = {{"dtMs", dtMs},
                     {"steps", steps},
                     {"maxSteps", maxSteps},
                     {"samplesTotal", static_cast<int>(samples.size())},
                     {"source", "Stop driver → Driver::stepOnce(dtMs)（仿真毫秒）→ 每帧 SimSource::entities()"},
                     {"driverWasRunning", wasRunning},
                     {"driverWasPaused", wasPaused}};
    d["samples"] = samples;
    d["emittedDelta"] = mAfter.eventsEmitted - mBefore.eventsEmitted;
    d["hitCriterion"] =
        {{"formula", "相邻两帧读数构成的轨迹段与台账目标位置的三维最近接近距离 d ≤ R"},
         {"picked", "全部满足判据的轨迹段里取**最近接近**的那一段（命中时刻 = 最近点时刻）"},
         {"crossings", crossings},
         {"R_m", areaHalfM},
         {"R_source", areaHalfMSource},
         {"projection", "局部等距圆柱投影（参考点 = 目标台账位置）"},
         {"whoWhenHow", "谁命中 = 命中段的 platformId（读数里的 deviceId）；何时 = 段内最近点按时间线性插值；"
                        "依据 = 读数（SimSource::entities()）与台账目标位置"}};
    d["hit"] = hitFound ? hit : nlohmann::json(nullptr);
    if (!hitFound) {
        notes.push_back("本轮**没有**从读数里派生出命中：" + std::to_string(steps) +
                        " 帧内没有任何轨迹段与台账目标位置的三维最近接近距离 ≤ R（R=" +
                        std::to_string(areaHalfM) + " m）→ 因此不写终态（MUST NOT 无证据写终态）");
    }
    d["notes"] = notes;
    out.applied = true;
    out.hit = hitFound;
    out.hitPlatform = hitFound ? hit.value("platformId", std::string()) : std::string();
    out.payload = d;
    return out;
}

#endif  // MA_WITH_SIM_SOURCE && MA_WITH_INGEST

// ============================================================================
// 步 10（P6）：exec.run / exec.abort
// ============================================================================

nlohmann::json FlowEngine::execRunLocked(const std::string& entityId, const nlohmann::json& params,
                                         int& code) {
    code = 0;
    nlohmann::json d = nlohmann::json::object();
    nlohmann::json notes = nlohmann::json::array();
    nlohmann::json dataGaps = nlohmann::json::array();
    const std::string operatorId = params.value("operatorId", std::string("host"));
    const std::string reason = params.value("reason", std::string("host:exec.run"));
    const std::string actionKey = params.value("actionKey", std::string("strike"));
    d["entityId"] = entityId;
    d["missionId"] = missionId_;
    d["requestedAction"] = actionKey;
    d["operatorId"] = operatorId;
    d["step"] = step_;
    d["phase"] = phase_;

    ExecRecord rec;
    rec.entityId = entityId;
    rec.missionId = missionId_;
    rec.planId = confirmedStrikePlanId_.empty() ? adoptedStrikePlanId_ : confirmedStrikePlanId_;
    rec.atMs = wallClockMs();
    double areaHalfM = 0.0;
    std::string areaHalfMSource;

    // 记录落库（**保留回退基线**）：`exec.abort` 要靠"第一次真做过事"那份基线（exec.run 前的状态 +
    // 执行成功的动作）。重复调用（幂等命中、被引擎拒、目标已 destroyed 后再打一次）MUST NOT 把它抹掉 ——
    // 否则 abort 会误判成"状态没变过"而静默成功（实测踩过：另一个脚本对同一目标再打一次，把基线冲掉了）。
    auto saveRecord = [this, &entityId](const ExecRecord& incoming) {
        auto it = execRecords_.find(entityId);
        if (it != execRecords_.end() && !it->second.appliedActions.empty()) {
            ExecRecord merged = it->second;
            merged.stateAfter = incoming.stateAfter.empty() ? merged.stateAfter : incoming.stateAfter;
            if (!incoming.hitPlatformId.empty()) merged.hitPlatformId = incoming.hitPlatformId;
            if (!incoming.lastRun.empty()) merged.lastRun = incoming.lastRun;
            merged.atMs = incoming.atMs;
            execRecords_[entityId] = merged;
            return;
        }
        execRecords_[entityId] = incoming;
    };

#if MA_WITH_LEDGER
    if (!engines_.entityLedger) {
        code = 1005;
        d["message"] = "entity-ledger 未装配（编译期 MA_WITH_LEDGER=0）";
        return d;
    }
    const std::optional<entity_ledger::EntityRecord> rec0 =
        engines_.entityLedger->getEntity(entityId);
    if (!rec0.has_value()) {
        code = 1004;
        d["message"] = "台账里没有这个实体：" + entityId;
        return d;
    }
    rec.stateBefore = rec0->dynamicState;
    rec.stateAfter = rec0->dynamicState;
    d["stateBefore"] = rec0->dynamicState;
    d["entity"] = nlohmann::json::parse(entity_ledger::toJson(*rec0).dump());

    // ---- 动作面：清单与 requires 全部来自**规则包的生效内容**（不猜、不自造）----
    const entity_ledger::DefinitionInfo di = engines_.entityLedger->definitionInfo();
    nlohmann::json declaredActions = nlohmann::json::array();
    for (const auto& k : di.actionKeys) declaredActions.push_back(k);
    d["declaredActions"] = declaredActions;
    const nlohmann::json eff =
        nlohmann::json::parse(engines_.entityLedger->effectivePolicies().dump());
    std::string actionsShape;
    std::string statesShape;
    std::string dedupShape;
    const nlohmann::json actsSection = ledgerPolicySection(eff, "actions", actionsShape);
    const nlohmann::json statesSection = ledgerPolicySection(eff, "dynamicStates", statesShape);
    const nlohmann::json dedupSection = ledgerPolicySection(eff, "dedup", dedupShape);
    d["policiesShape"] = {{"actions", actionsShape},
                          {"dynamicStates", statesShape},
                          {"dedup", dedupShape}};
    nlohmann::json declaredAction = nlohmann::json::object();
    for (const auto& a : (actsSection.is_array() ? actsSection : nlohmann::json::array())) {
        if (a.value("key", std::string()) == actionKey) declaredAction = a;
    }
    const bool declared =
        std::find(di.actionKeys.begin(), di.actionKeys.end(), actionKey) != di.actionKeys.end();
    if (!declared) {
        code = 1004;
        d["message"] = "规则包的 actions[] 未声明该动作：" + actionKey;
        return d;
    }
    d["declaredAction"] = declaredAction;  // 原样（requires/setsFlags/once/exclusive/undoWithinMs…）
    const std::vector<std::string> requires =
        declaredAction.value("requires", std::vector<std::string>{});
    d["declaredRequires"] = requires;

    // 状态键：同样以规则包声明为准（缺声明 → 1000，MUST NOT 硬顶）
    nlohmann::json declaredStates = nlohmann::json::array();
    for (const auto& s : statesSection.value("items", nlohmann::json::array())) {
        declaredStates.push_back(s.value("key", std::string()));
    }
    d["declaredStates"] = declaredStates;
    const std::string struckState = params.value("struckState", std::string("struck"));
    const std::string finalState = params.value("finalState", std::string("destroyed"));
    auto declaredState = [&declaredStates](const std::string& k) {
        for (const auto& x : declaredStates) {
            if (x.get<std::string>() == k) return true;
        }
        return false;
    };
    if (!declaredState(struckState) || !declaredState(finalState)) {
        code = 1000;
        d["message"] = "规则包 dynamicStates.items[] 未声明该状态（struck=" + struckState +
                       " final=" + finalState + "）→ 宿主 MUST NOT 硬顶状态键";
        d["notes"] = notes;
        return d;
    }
    // 俯冲终点区的半边长：规则包 `dedup.spaceRadiusM`（引擎自己的"同一位置"空间半径，键引用）
    areaHalfM = dedupSection.value("spaceRadiusM", 0.0);
    areaHalfMSource = "规则包 entityTypes.json 的 dedup.spaceRadiusM（引擎声明的'同一位置'空间半径；"
                      "MUST NOT 自造半径）";
    if (!(areaHalfM > 0.0)) {
        code = 1005;
        d["message"] = "规则包未声明 dedup.spaceRadiusM → 俯冲区多边形的半边长没有出处"
                       "（引擎拒零面积环，宿主 MUST NOT 编一个半径）";
        d["notes"] = notes;
        return d;
    }

    // ---- ① 目标动作：先按**规则包声明的顺序**补前置，再打主动作（引擎的 Gate 一个都不绕）----
    nlohmann::json prerequisites = nlohmann::json::array();
    nlohmann::json actions = nlohmann::json::array();
    nlohmann::json applied = nlohmann::json::array();
    auto applyOne = [&](const std::string& key) -> int {
        entity_ledger::ActionRequest req;
        req.entityId = entityId;
        req.actionKey = key;
        req.reason = reason;
        req.operatorId = operatorId;
        if (params.contains("params") && params["params"].is_object()) req.params = params["params"];
        const entity_ledger::ActionResult ar = engines_.entityLedger->applyAction(req);
        nlohmann::json row = nlohmann::json::parse(ar.toJson().dump());
        row["actionKey"] = key;
        row["engineEntry"] = "entity_ledger::EntityLedger::applyAction(ActionRequest)";
        actions.push_back(row);
        if (ar.code == 0) {
            bool dup = false;
            for (const auto& x : applied) {
                if (x.get<std::string>() == key) dup = true;
            }
            if (!dup) applied.push_back(key);
        }
        return ar.code;
    };
    for (const auto& g : requires) {
        if (g.rfind("$action:", 0) == 0) {
            const std::string need = g.substr(8);
            const int rc = applyOne(need);
            prerequisites.push_back({{"gate", g},
                                     {"satisfiedBy", "entity-ledger::applyAction(" + need + ")"},
                                     {"code", rc}});
            if (rc != 0) {
                code = rc;
                d["message"] = "前置动作被引擎拒（原样回执；宿主未绕过 Gate）";
                d["prerequisites"] = prerequisites;
                d["actions"] = actions;
                d["notes"] = notes;
                saveRecord(rec);
                return d;
            }
            continue;
        }
        if (g == "$in-sequence") {
            entity_ledger::SequenceInput si;
            si.missionId = missionId_;
            si.entityId = entityId;
            si.operatorId = operatorId;
            si.reason = reason;
            const entity_ledger::SequenceResult sr = engines_.entityLedger->addToSequence(si);
            nlohmann::json row = nlohmann::json::parse(sr.toJson().dump());
            row["gate"] = g;
            row["satisfiedBy"] = "entity-ledger::addToSequence（$in-sequence 的唯一满足方式）";
            prerequisites.push_back(row);
            if (sr.code != 0) {
                code = sr.code;
                d["message"] = "addToSequence 被引擎拒（原样回执；未绕过 Gate）";
                d["prerequisites"] = prerequisites;
                d["actions"] = actions;
                d["notes"] = notes;
                saveRecord(rec);
                return d;
            }
            rec.followedSequence = true;
            continue;
        }
        // 其它内建守卫（$confidence-min / $flag / $state / $not-action / $reversible / $transition）
        // 与宿主闸门：**一律不代劳** —— 未满足就由引擎在主动作那一步如实回 1003 + unmet[]。
        prerequisites.push_back(
            {{"gate", g},
             {"satisfiedBy", nullptr},
             {"note", "宿主不代劳（MUST NOT 绕过引擎 Gate）：未满足时由引擎回 1003 + unmet[]"}});
    }
    const int mainCode = applyOne(actionKey);
    d["prerequisites"] = prerequisites;
    d["actions"] = actions;
    d["registeredGates"] = 0;
    d["gateNote"] = "本规则包的 actions[].requires 全是 `$` 内建守卫（宿主闸门 0 个）→ "
                    "registerActionGate 未调用；宿主 MUST NOT 自造闸门或动作";
    rec.appliedActions.clear();
    for (const auto& x : applied) rec.appliedActions.push_back(x.get<std::string>());
    if (mainCode != 0) {
        code = mainCode;
        d["message"] = "目标动作被引擎拒（回执原样；**未**做状态推进与俯冲）";
        d["notes"] = notes;
        d["step"] = step_;
        rec.lastRun = d;
        saveRecord(rec);
        return d;
    }

    // ---- ② 状态推进（struck）：每次迁移都由引擎裁决（未声明 → 1003 原样回执）----
    nlohmann::json transitions = nlohmann::json::array();
    auto setState = [&](const std::string& to) -> int {
        const entity_ledger::ActionResult ar =
            engines_.entityLedger->setDynamicState(entityId, to, reason, operatorId);
        nlohmann::json row = nlohmann::json::parse(ar.toJson().dump());
        row["to"] = to;
        row["engineEntry"] = "entity_ledger::EntityLedger::setDynamicState";
        transitions.push_back(row);
        return ar.code;
    };
    const int struckCode = setState(struckState);
    if (struckCode != 0) {
        code = struckCode;
        d["stateTransitions"] = transitions;
        d["message"] = "状态推进被引擎拒（未声明的迁移 → 1003；宿主原样回执，未绕过）";
        d["notes"] = notes;
        d["step"] = step_;
        rec.lastRun = d;
        saveRecord(rec);
        return d;
    }
    rec.stateAfter = struckState;
    notes.push_back("状态推进 ①：" + rec.stateBefore + " → " + struckState +
                    "（setDynamicState，引擎裁决；事件 target.state 由装配期 Sink 广播）");

    // ---- ③ 仿真侧俯冲 + 由读数派生的命中 ----
    std::vector<std::string> preferred;
    for (const auto& l : lastGuidance_.value("guidance", nlohmann::json::object())
                             .value("lines", nlohmann::json::array())) {
        const std::string eid =
            l.value("from", nlohmann::json::object()).value("entityId", std::string());
        for (const auto& kv : entityIdOfDevice_) {
            if (kv.second == eid && !kv.first.empty()) preferred.push_back(kv.first);
        }
    }
    nlohmann::json ipPoint = nlohmann::json::object();
    std::string ipSource;
    if (!rec.planId.empty()) {
        const nlohmann::json tpl = templateRawOfLocked(rec.planId);
        const nlohmann::json geo = strikeGeometryOfLocked(tpl);
        if (geo.value("resolved", false) && geo.contains("attackStart") &&
            geo["attackStart"].is_object()) {
            ipPoint = geo["attackStart"];
            ipSource = "strike-geometry.json 的 attackStarts[]（经 scoring TemplatesPack.raw 的 "
                       "attackStart.key 键引用；方案 " + rec.planId + "）";
        }
    } else {
        notes.push_back("没有已确认的打击方案 → IP 点回落到**领队平台的当前读数位置**"
                        "（MUST NOT 编一个 IP 坐标）");
    }
#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST
    DiveOutcome dv =
        runDiveLocked(engines_, entityId, rec0->lng, rec0->lat, rec0->alt,
                      "entity-ledger 台账 getEntity(entityId) 的 lng/lat/alt（目标位置的权威）",
                      ipPoint, ipSource, preferred, params, areaHalfM, areaHalfMSource);
    d["dive"] = dv.payload;
    rec.hitPlatformId = dv.hitPlatform;
    if (dv.applied) ++execDiveCount_;
    if (!dv.applied) {
        code = 1005;
        d["stateTransitions"] = transitions;
        d["stateAfter"] = struckState;
        d["message"] = "仿真侧俯冲未施加（原因见 data.dive.reason）→ 没有读数就没有命中判据，"
                       "因此**不写** " + finalState + "（MUST NOT 无证据写终态）";
        dataGaps.push_back({{"key", "hit"},
                            {"engine", "sim-source 读数 + entity-ledger 台账"},
                            {"reason", dv.payload.value("reason", std::string("俯冲未施加"))}});
        d["dataGaps"] = dataGaps;
        d["notes"] = notes;
        d["step"] = step_;
        rec.lastRun = d;
        saveRecord(rec);
        return d;
    }
    // ---- ④ 命中 → 终态（**读数派生出命中才写终态**）----
    if (dv.hit) {
        const int finCode = setState(finalState);
        d["stateTransitions"] = transitions;
        if (finCode != 0) {
            code = finCode;
            d["message"] = "终态推进被引擎拒（" + struckState + " → " + finalState +
                           "；宿主原样回执，未绕过）";
            d["stateAfter"] = struckState;
            d["dataGaps"] = dataGaps;
            d["notes"] = notes;
            d["step"] = step_;
            rec.lastRun = d;
            saveRecord(rec);
            return d;
        }
        rec.stateAfter = finalState;
        notes.push_back("状态推进 ②：" + struckState + " → " + finalState +
                        "（依据 = data.dive.hit 的读数派生命中；事件 target.state 由 Sink 广播）");
    } else {
        d["stateTransitions"] = transitions;
        dataGaps.push_back({{"key", "hit"},
                            {"engine", "sim-source 读数 + entity-ledger 台账"},
                            {"reason", "逐帧读数里没有派生到命中（见 data.dive.notes 与 samples）"}});
        notes.push_back("命中未派生 → **不写** " + finalState +
                        "（终态必须有读数证据）；receipt 给出全部逐帧读数供复核");
    }
#else
    (void)ipPoint;
    (void)ipSource;
    (void)preferred;
    dataGaps.push_back({{"key", "hit"},
                        {"engine", "sim-source"},
                        {"reason", "编译期未装配 sim-source / 接入层（MA_WITH_SIM_SOURCE=0 或 "
                                   "MA_WITH_INGEST=0）→ 没有仿真读数，无法派生命中"}});
    notes.push_back("仿真侧未装配 → 只做了动作与状态推进，未写终态（MUST NOT 无证据写终态）");
#endif
    d["dataGaps"] = dataGaps;

    // ---- ⑤ 步 10：阶段 T6 + 步号 10 ----
    //
    // P5 实测：`strike.confirm` **不自动**推进到步 10。所以这一步由 exec.run 收口 ——
    // 与 `mission.advance{to:"T6"}` 同一语义（`stepForPhase("T6") = 10`），回执里给出 `step`。
    nlohmann::json advance = nlohmann::json::object();
    bool flowChanged = false;
#if MA_WITH_PHASE
    if (engines_.phase && !missionId_.empty()) {
        const int stepBefore = step_;
        const std::string phaseBefore = phase_;
        phase::AdvanceRequest ar;
        ar.missionId = missionId_;
        ar.to = "T6";
        ar.reason = "host:exec.run";
        ar.operatorId = operatorId;
        phase::TransitionResult tr = engines_.phase->advance(ar);
        nlohmann::json first = tr.dataJson();
        bool forced = false;
        if (tr.code != 0) {
            ar.force = true;
            ar.reason = "host:exec.run:force";
            tr = engines_.phase->advance(ar);
            forced = true;
        }
        advance["phase"] = "T6";
        advance["forced"] = forced;
        advance["code"] = tr.code;
        advance["firstAttempt"] = first;
        advance["result"] = tr.dataJson();
        advance["stepSemantics"] =
            "strike.confirm 不自动推进（P5 实测）→ exec.run 负责把流程落到 T6/步 10；"
            "mission.advance{to:\"T6\"} 同一语义（stepForPhase(\"T6\")=10）";
        if (tr.code == 0) {
            const PhaseView v2 = phaseViewLocked();
            phase_ = v2.phaseKey.empty() ? std::string("T6") : v2.phaseKey;
            enteredAtMs_ = v2.enteredAt != 0 ? v2.enteredAt : enteredAtMs_;
            step_ = 10;
            advance["step"] = step_;
            advance["stepKey"] = flowStepOf(step_) ? flowStepOf(step_)->key : "";
            advance["enteredAt"] = enteredAtMs_;
            advance["phaseKey"] = phase_;
            flowChanged = (stepBefore != step_) || (phaseBefore != phase_);
        } else {
            advance["note"] = "phase-engine 拒绝（含 force）→ 流程停在原阶段，步号不前进；回执原样给出";
        }
    } else
#endif
    {
        advance["note"] = "phase-engine 未装配 → 只按 verb 语义把宿主步号落到 10";
        step_ = 10;
        flowChanged = true;
    }
    d["advance"] = advance;

    d["stateTransitions"] = transitions;
    d["stateAfter"] = rec.stateAfter;
    d["hitPlatformId"] = rec.hitPlatformId;
    d["step"] = step_;
    d["stepKey"] = flowStepOf(step_) ? flowStepOf(step_)->key : "";
    d["phase"] = phase_;
    d["flowStateChanged"] = flowChanged;
    d["source"] = "动作/状态 ← entity-ledger（applyAction / addToSequence / setDynamicState 的裁决原样）；"
                  "俯冲与命中 ← sim-source 逐帧读数派生（判据与输入在 data.dive.hit.basis）；"
                  "步号 ← 宿主（T6 → 步 10）";
    d["notes"] = notes;
    rec.lastRun = d;
    saveRecord(rec);
    return d;
#else
    (void)areaHalfM;
    (void)areaHalfMSource;
    code = 1005;
    d["message"] = "entity-ledger 未装配（编译期 MA_WITH_LEDGER=0）→ 无法做目标动作与状态推进";
    d["notes"] = notes;
    return d;
#endif
}

nlohmann::json FlowEngine::execAbortLocked(const std::string& entityId, const nlohmann::json& params,
                                           int& code) {
    code = 0;
    nlohmann::json d = nlohmann::json::object();
    nlohmann::json notes = nlohmann::json::array();
    const std::string operatorId = params.value("operatorId", std::string("host"));
    const std::string reason = params.value("reason", std::string("host:exec.abort"));
    d["entityId"] = entityId;
    d["missionId"] = missionId_;
    d["step"] = step_;
    d["phase"] = phase_;

#if MA_WITH_LEDGER
    if (!engines_.entityLedger) {
        code = 1005;
        d["message"] = "entity-ledger 未装配（编译期 MA_WITH_LEDGER=0）";
        return d;
    }
    const auto it = execRecords_.find(entityId);
    if (it == execRecords_.end() || it->second.appliedActions.empty()) {
        // 没有执行记录 → 没有可撤销的动作。**不猜**：如实说明并把台账当前状态带出。
        const std::optional<entity_ledger::EntityRecord> cur =
            engines_.entityLedger->getEntity(entityId);
        d["idempotent"] = true;
        d["stateBefore"] = cur.has_value() ? cur->dynamicState : std::string();
        d["stateAfter"] = d["stateBefore"];
        d["undone"] = nlohmann::json::array();
        d["refused"] = nlohmann::json::array();
        d["reversible"] = true;
        d["note"] = cur.has_value()
                        ? "本进程内没有这个实体的 exec.run 记录 → 没有可撤销的动作（幂等成功）"
                        : "台账里没有这个实体，且没有 exec.run 记录";
        d["notes"] = notes;
        return d;
    }
    ExecRecord& rec = it->second;
    const std::optional<entity_ledger::EntityRecord> cur = engines_.entityLedger->getEntity(entityId);
    if (!cur.has_value()) {
        code = 1004;
        d["message"] = "台账里没有这个实体：" + entityId;
        return d;
    }
    d["stateBefore"] = cur->dynamicState;
    d["executedAtMs"] = rec.atMs;
    d["appliedActions"] = rec.appliedActions;
    d["hitPlatformId"] = rec.hitPlatformId;

    // ---- ① 逐动作撤销（**逆序**；`undoAction` 一条条由引擎裁决）----
    nlohmann::json undos = nlohmann::json::array();
    nlohmann::json refused = nlohmann::json::array();
    for (auto rit = rec.appliedActions.rbegin(); rit != rec.appliedActions.rend(); ++rit) {
        entity_ledger::ActionRequest req;
        req.entityId = entityId;
        req.actionKey = *rit;
        req.reason = reason;
        req.operatorId = operatorId;
        const entity_ledger::ActionResult ar = engines_.entityLedger->undoAction(req);
        nlohmann::json row = nlohmann::json::parse(ar.toJson().dump());
        row["actionKey"] = *rit;
        row["engineEntry"] = "entity_ledger::EntityLedger::undoAction(ActionRequest)";
        undos.push_back(row);
        if (ar.code != 0) {
            nlohmann::json r = nlohmann::json::array();
            for (const auto& u : ar.unmet) {
                r.push_back({{"gate", u.gate}, {"reason", u.reason}, {"detail", u.detail}});
            }
            refused.push_back(
                {{"actionKey", *rit}, {"code", ar.code}, {"message", ar.message}, {"unmet", r}});
        }
    }
    d["undos"] = undos;

    // ---- ② 序列回退（宿主补过的 `$in-sequence` 由宿主收回去；引擎裁决，幂等）----
    nlohmann::json seqOut = nullptr;
    if (rec.followedSequence) {
        entity_ledger::SequenceInput si;
        si.missionId = missionId_;
        si.entityId = entityId;
        si.operatorId = operatorId;
        si.reason = reason;
        const entity_ledger::SequenceResult sr = engines_.entityLedger->removeFromSequence(si);
        seqOut = nlohmann::json::parse(sr.toJson().dump());
        seqOut["engineEntry"] = "entity_ledger::EntityLedger::removeFromSequence";
    }
    d["sequence"] = seqOut;

    // ---- ③ 状态回退：退到 exec.run 之前那个状态（**能不能退由引擎裁决**）----
    nlohmann::json stateRollback = nlohmann::json::object();
    bool stateBack = false;
    if (rec.stateBefore.empty() || rec.stateBefore == cur->dynamicState) {
        stateRollback["requested"] = nullptr;
        stateRollback["from"] = cur->dynamicState;
        stateRollback["code"] = 0;
        stateRollback["note"] = "状态没有变过（或没有记录到原状态）→ 无需回退";
        stateBack = true;
    } else {
        const entity_ledger::ActionResult ar =
            engines_.entityLedger->setDynamicState(entityId, rec.stateBefore, reason, operatorId);
        stateRollback = nlohmann::json::parse(ar.toJson().dump());
        stateRollback["requested"] = rec.stateBefore;
        stateRollback["from"] = cur->dynamicState;
        stateRollback["engineEntry"] = "entity_ledger::EntityLedger::setDynamicState";
        if (ar.code == 0) {
            stateBack = true;
        } else {
            nlohmann::json r = nlohmann::json::array();
            for (const auto& u : ar.unmet) {
                r.push_back({{"gate", u.gate}, {"reason", u.reason}, {"detail", u.detail}});
            }
            stateRollback["unmet"] = r;
            refused.push_back({{"actionKey", "set-state"},
                               {"code", ar.code},
                               {"message", ar.message},
                               {"unmet", r}});
        }
    }
    d["stateRollback"] = stateRollback;
    d["refused"] = refused;
    const std::optional<entity_ledger::EntityRecord> after =
        engines_.entityLedger->getEntity(entityId);
    d["stateAfter"] = after.has_value() ? after->dynamicState : std::string();
    d["reversible"] = stateBack;
    notes.push_back("仿真侧**不可回退**：sim-source 没有回滚入口，已经飞过的俯冲航迹留在读数历史里 —— "
                    "宿主 MUST NOT 声称仿真回退了");
    notes.push_back("能退到哪由引擎裁决：动作撤销看 `reversible` / `undoWithinMs`，状态回退看规则包 "
                    "`dynamicStates.transitions`（未声明的迁移 → 1003 + unmet[]）");
    rec.aborted = true;
    rec.stateAfter = d.value("stateAfter", rec.stateAfter);
    d["step"] = step_;
    d["phase"] = phase_;
    d["notes"] = notes;
    rec.lastAbort = d;
    if (!stateBack) {
        // 退不动 → **如实回 1003**（细节在 error.unmet，与 alloc./strike. 同一套语义）
        code = 1003;
        d["message"] = "回退被引擎拒（状态迁移未声明 / 动作不可逆）→ 原样回执，未绕过规则";
        nlohmann::json unmet = nlohmann::json::array();
        for (const auto& r : refused) {
            for (const auto& u : r.value("unmet", nlohmann::json::array())) unmet.push_back(u);
        }
        d["unmet"] = unmet;
        return d;
    }
    return d;
#else
    code = 1005;
    d["message"] = "entity-ledger 未装配（编译期 MA_WITH_LEDGER=0）";
    return d;
#endif
}

// ============================================================================
// 步 11（P6）：任务总结报告 —— report-engine::generate + 时间轴 + 预警 + 台账 + 留存层
// ============================================================================

std::string FlowEngine::reportPoliciesPath() {
#ifdef MA_WEBMAP_ROOT
    return (std::filesystem::path(MA_WEBMAP_ROOT) / "report-engine" / "policies" / "mapapp" /
            "reportFields.json")
        .string();
#else
    return {};
#endif
}

nlohmann::json FlowEngine::phaseDurationsLocked() const {
    nlohmann::json out = nlohmann::json::object();
    out["missionId"] = missionId_;
    out["durations"] = nullptr;
    out["durationsRaw"] = "";
    out["durationsDigest"] = "";
    out["available"] = false;
#if MA_WITH_PHASE
    if (!engines_.phase) {
        out["note"] = "phase-engine 未装配（编译期 MA_WITH_PHASE=0）";
        return out;
    }
    if (missionId_.empty()) {
        out["note"] = "尚未进入任务（无 missionId）→ 时间轴留空";
        return out;
    }
    const phase::DurationReport dur = engines_.phase->durations(missionId_);
    // ★ 逐字：直接 dump 引擎自己的 toJson(DurationReport)（不重算、不补字段、不改键序）
    const std::string raw = phase::toJson(dur).dump();
    phaseDurationsRaw_ = raw;
    phaseDurationsAt_ = wallClockMs();
    out["available"] = true;
    out["durationsRaw"] = raw;                      // 引擎 JSON 的逐字字符串（逐字相等的证据）
    out["durations"] = nlohmann::json::parse(raw);  // 同一份字节的解析结果（供前端直接读）
    out["durationsDigest"] = fnv1a64Hex(raw);
    out["capturedAt"] = phaseDurationsAt_;
    out["entry"] = "phase::PhaseEngine::durations(missionId)（公开头 phase_engine.h:598）"
                   " → phase::toJson(DurationReport) 原样 dump";
    out["anchors"] = {{"startedAt", dur.startedAt},
                      {"endedAt", dur.endedAt},
                      {"endedAtSet", dur.endedAtSet},
                      {"totalMs", dur.totalMs}};
    out["clockNote"] = "phase-engine 的时钟是装配期注入的 FixedClock（装配时刻）→ 同一进程内"
                       "durations() 可复现（逐字相等因此是可判定的）";
#else
    out["note"] = "phase-engine 未装配（编译期 MA_WITH_PHASE=0）";
#endif
    return out;
}

nlohmann::json FlowEngine::buildReportLocked(const nlohmann::json& params, int& code) {
    code = 0;
    nlohmann::json d = nlohmann::json::object();
    nlohmann::json notes = nlohmann::json::array();
    nlohmann::json dataGaps = nlohmann::json::array();
    d["missionId"] = missionId_;
    d["step"] = step_;
    d["phase"] = phase_;

#if MA_WITH_REPORT
    if (!engines_.reportEngine) {
        code = 1005;
        d["message"] = "report-engine 未装配（编译期 MA_WITH_REPORT=0）";
        return d;
    }
    if (missionId_.empty()) {
        code = 1003;
        d["message"] = "尚未进入任务：先 flow.enter（报告按任务生成，任务号来自 phase-engine）";
        return d;
    }

    // ---- ① 规则包：宿主读 JSON → `loadPolicies(json)` ----
    //
    // ★ 为什么不用 `loadPoliciesFile`：report-engine 明写它是**故意恒失败的占位**
    //   （"engine does not read files"，RPT-NFR-02）→ 用它会得到一个永远 1005 的假失败。
    const std::string policiesPath = reportPoliciesPath();
    nlohmann::json policiesOut = nlohmann::json::object();
    policiesOut["path"] = policiesPath;
    policiesOut["entry"] = "report_engine::ReportEngine::loadPolicies(json)（宿主读文件；"
                           "loadPoliciesFile 是引擎里故意恒失败的占位，MUST NOT 用它）";
    std::string ptext;
    if (policiesPath.empty() || !readTextFile(policiesPath, ptext)) {
        code = 1005;
        d["policies"] = policiesOut;
        d["message"] = "报告规则包读不到：" + policiesPath;
        return d;
    }
    nlohmann::json pkg;
    try {
        pkg = nlohmann::json::parse(ptext);
    } catch (const std::exception& e) {
        code = 1000;
        d["policies"] = policiesOut;
        d["message"] = std::string("报告规则包 JSON 解析失败：") + e.what();
        return d;
    }
    const report_engine::LoadResult lr = engines_.reportEngine->loadPolicies(pkg);
    policiesOut["code"] = lr.code;
    policiesOut["message"] = lr.message;
    policiesOut["ok"] = lr.code == 0;
    policiesOut["namespace"] = lr.policies.policiesNamespace;
    policiesOut["schemaVersion"] = lr.policies.schemaVersion;
    policiesOut["kind"] = lr.policies.kind;
    policiesOut["digest"] = lr.policies.digest;
    policiesOut["fieldCount"] = static_cast<int>(lr.policies.fields.size());
    policiesOut["groupCount"] = static_cast<int>(lr.policies.groups.size());
    policiesOut["timeBasisKeys"] = nlohmann::json::array();
    for (const auto& tb : lr.policies.timeBases) policiesOut["timeBasisKeys"].push_back(tb.key);
    policiesOut["warnings"] = lr.policies.warnings;
    nlohmann::json lIssues = nlohmann::json::array();
    for (const auto& i : lr.issues) {
        lIssues.push_back({{"path", i.path}, {"field", i.field}, {"reason", i.reason}});
    }
    policiesOut["issues"] = lIssues;
    policiesOut["loaded"] = engines_.reportEngine->policiesLoaded();
    d["policies"] = policiesOut;
    if (lr.code != 0) {
        code = lr.code;
        d["message"] = "报告规则包装载失败（引擎保留上一次成功装载的规则）";
        d["notes"] = notes;
        return d;
    }

    // ---- ② 模板：注入了 ITemplateSource 就用**规则包模板**；取不到就让引擎回落内置模板 ----
    auto tplSrc = std::make_shared<RuleFileTemplateSource>();
    const std::string tplPath =
        (std::filesystem::path(policiesPath).parent_path() / "reportTemplate.html").string();
    std::string tplText;
    const bool tplLoaded = readTextFile(tplPath, tplText);
    if (tplLoaded) {
        tplSrc->set("report", tplText);            // 引擎默认模板名 = "report"
        tplSrc->set("reportTemplate", tplText);    // 文件名同名键（两种叫法都能取到）
    }
    nlohmann::json tplOut = {{"templateName", "report"},
                             {"file", tplPath},
                             {"loaded", tplLoaded},
                             {"bytes", tplLoaded ? static_cast<int>(tplText.size()) : 0},
                             {"entry", "report_engine::ITemplateSource（宿主实现 RuleFileTemplateSource）"}};
    tplOut["source"] = tplLoaded ? "host:规则包模板文件（注入 ITemplateSource）"
                                 : "engine:内置模板（回落；宿主读不到模板文件）";
    if (!tplLoaded) {
        dataGaps.push_back({{"key", "template"},
                            {"engine", "report-engine"},
                            {"reason", "规则包模板文件读不到（" + tplPath +
                                       "）→ 引擎按口径回落内置 HTML 模板，并把回落写进 warnings"}});
    }

    // ---- ③ 时间轴：`phase::durations()` **原样**（逐字；不自己算一遍）----
    const nlohmann::json tlBefore = phaseDurationsLocked();
    const std::string durationsRaw = tlBefore.value("durationsRaw", std::string());
    const nlohmann::json durationsJson =
        tlBefore.contains("durations") && tlBefore["durations"].is_object() ? tlBefore["durations"]
                                                                           : nlohmann::json::object();
    const int64_t startedAt = tlBefore.value("anchors", nlohmann::json::object())
                                  .value("startedAt", static_cast<int64_t>(0));
    const int64_t generatedAtMs = wallClockMs();
    if (!tlBefore.value("available", false)) {
        dataGaps.push_back({{"key", "timeline"},
                            {"engine", "phase-engine"},
                            {"reason", tlBefore.value("note", std::string("durations 不可用"))}});
    }
    // `durations().totalMs = 0` 的**如实说明**（踩过的坑，不替引擎改数）：
    // 宿主给 phase-engine 注入的是 `FixedClock`（装配时刻的冻结值），引擎算"现在 − 任务下达"时
    // 那个"现在"就是冻结值 → 差被钳到 0。报告的"任务用时"用的是规则包的 `timeBases` 口径
    // （created → generated，锚点 = 任务台账 startedAt 与生成时刻的真实挂钟），所以那个数仍是真数。
    nlohmann::json totalMsZero = nullptr;
    {
        const int64_t durTotal = tlBefore.value("anchors", nlohmann::json::object())
                                     .value("totalMs", static_cast<int64_t>(0));
        const int64_t engineClockMs = engines_.fixedClock.nowMs();
        if (durTotal == 0 && startedAt > 0) {
            totalMsZero =
                {{"engineClockMs", engineClockMs},
                 {"engineClockSource", "宿主注入 phase-engine 的 FixedClock（装配时刻的冻结值；"
                                       "注入它是为了确定性，见 ma/adapters.h）"},
                 {"missionStartedAt", startedAt},
                 {"relation", startedAt == engineClockMs
                                  ? "任务下达时刻 == 注入时钟的冻结值（两者同源：phase-engine 建任务时读的"
                                    "就是这个注入时钟）→ end - startedAt = 0"
                                  : (startedAt > engineClockMs ? "任务下达晚于注入时钟 → end - startedAt < 0"
                                                               : "任务下达早于注入时钟")},
                 {"reason", "durations().totalMs = 0：引擎的\"现在\"就是注入时钟的冻结值（装配时刻），"
                            "它不晚于任务下达 → `end - startedAt` 被引擎钳到 0。宿主**原样带出**这个数，"
                            "MUST NOT 替引擎改；报告的\"任务用时\"走规则包的 timeBases 口径"
                            "（created → generated，锚点 = 任务台账的 startedAt 与生成时刻的真实挂钟），"
                            "所以 durationSec 仍是真数"}};
            dataGaps.push_back({{"key", "timeline.totalMs"},
                                {"engine", "phase-engine"},
                                {"reason", totalMsZero["reason"]}});
        }
    }

    // ---- ④ 快照（root 形状见 report_engine.h:313-325）----
    nlohmann::json root = nlohmann::json::object();
    root["meta"] = {{"snapshotId", "snap-" + missionId_ + "-" + std::to_string(generatedAtMs)},
                    {"generatedAt", generatedAtMs},
                    {"source", "宿主 report.generate（只读快照；引擎不读库、不落盘）"}};
    nlohmann::json mission = nlohmann::json::object();
    mission["missionId"] = missionId_;
    mission["phase"] = phase_;
#if MA_WITH_PHASE
    if (engines_.phase) {
        const std::optional<phase::MissionRecord> mr = engines_.phase->getMission(missionId_);
        if (mr.has_value()) {
            const nlohmann::json mj = nlohmann::json::parse(phase::toJson(*mr).dump());
            mission["status"] = mj.value("status", std::string());
            mission["startedAt"] = mj.value("startedAt", static_cast<int64_t>(0));
        }
    }
#endif
#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST
    // 任务名/区域：场景数据（task-areas.json 的 mission{}）原样 —— 不在源码里写文案
    if (!engines_.scenarioData.mission.name.empty()) {
        mission["taskName"] = engines_.scenarioData.mission.name;
    }
    if (!engines_.scenarioData.mission.region.empty()) {
        mission["taskRegion"] = engines_.scenarioData.mission.region;
    }
    if (!engines_.scenarioData.mission.timeRequirement.empty()) {
        mission["timeRequirement"] = engines_.scenarioData.mission.timeRequirement;
    }
#endif
    root["mission"] = mission;

    // metrics 块：每个值都标出处（`snapshot` 字段会被引擎带进字段溯源）
    nlohmann::json metricsBlocks = nlohmann::json::object();
    auto putBlock = [&metricsBlocks](const std::string& block, const std::string& snapshot,
                                     nlohmann::json values) {
        metricsBlocks[block] = {{"snapshot", snapshot}, {"values", std::move(values)}};
    };
    nlohmann::json metricSources = nlohmann::json::array();
    auto noteSource = [&metricSources](const std::string& block, const std::string& field,
                                       const std::string& engine, const std::string& detail) {
        metricSources.push_back(
            {{"block", block}, {"field", field}, {"engine", engine}, {"detail", detail}});
    };

#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST && MA_WITH_SENSOR_MODEL
    {
        const nlohmann::json sen = sensorStatusLocked();
        if (sen.contains("coverageRatio") && sen["coverageRatio"].is_number()) {
            putBlock("coverage", "sensor-model:cover（宿主 sensor.status 的同一份读数）",
                     {{"rate", sen["coverageRatio"]}});
            noteSource("coverage", "rate", "sensor-model",
                       "coverageRatio = 任务区被覆盖的比例（sensor_model::cover；与 sensor.status 同一份读数）");
        } else {
            dataGaps.push_back({{"key", "coverage.rate"},
                                {"engine", "sensor-model"},
                                {"reason", "sensor.status 当前没有 coverageRatio（探测模型未挂接/未启用）"}});
        }
    }
#else
    dataGaps.push_back({{"key", "coverage.rate"},
                        {"engine", "sensor-model"},
                        {"reason", "编译期未装配 sensor-model / sim-source → 覆盖率无读数"}});
#endif

    // ---- ⑤ 台账汇总（目标 / 平台；全部来自 entity-ledger）+ 预警 + 留存层 ----
    nlohmann::json ledgerOut = nlohmann::json::object();
    nlohmann::json targetRows = nlohmann::json::array();
    nlohmann::json platformRows = nlohmann::json::array();
    nlohmann::json gradeRules = nlohmann::json::array();
    nlohmann::json unmappedRows = nlohmann::json::array();
#if MA_WITH_LEDGER
    if (engines_.entityLedger) {
        entity_ledger::EntityQuery q;
        q.missionId = missionId_;
        q.includeRetired = true;
        q.limit = 500;
        const std::vector<entity_ledger::EntityRecord> rows = engines_.entityLedger->listEntities(q);
        const std::map<std::string, std::string> targetTypes = targetTypeKeysLocked();
        entity_ledger::ActionLogQuery aq;
        aq.missionId = missionId_;
        std::set<std::string> handledIds;
        for (const auto& e : engines_.entityLedger->actionLog(aq)) {
            if (e.status == "ok") handledIds.insert(e.entityId);
        }
        // 处置档词表与权重：**从生效规则里读**（不许在源码里写中文档位）
        std::map<std::string, std::string> fieldLabel;  // 字段 key → countWhere 的相等取值
        std::map<std::string, double> gradeWeight;      // 档位标签 → weightedSum 系数
        for (const auto& f : lr.policies.fields) {
            for (const auto& s : f.sources) {
                if (s.compute.op == report_engine::ComputeOp::CountWhere &&
                    s.compute.equals.is_string()) {
                    fieldLabel[f.key] = s.compute.equals.get<std::string>();
                }
            }
        }
        for (const auto& f : lr.policies.fields) {
            for (const auto& s : f.sources) {
                for (const auto& in : s.compute.inputs) {
                    if (in.field.empty()) continue;
                    const auto lit = fieldLabel.find(in.field);
                    if (lit != fieldLabel.end()) gradeWeight[lit->second] = in.coefficient;
                }
            }
        }
        std::string intactGrade;
        for (const auto& kv : gradeWeight) {
            if (kv.second == 0.0 && intactGrade.empty()) intactGrade = kv.first;
        }
        std::string statesShape2;
        const nlohmann::json stateItems =
            ledgerPolicySection(
                nlohmann::json::parse(engines_.entityLedger->effectivePolicies().dump()),
                "dynamicStates", statesShape2)
                .value("items", nlohmann::json::array());
        ledgerOut["policiesShape"] = statesShape2;
        auto stateNameOf = [&stateItems](const std::string& key) -> std::string {
            for (const auto& s : stateItems) {
                if (s.value("key", std::string()) == key) return s.value("name", std::string());
            }
            return {};
        };
        int targetsFound = 0;
        int platformsFound = 0;
        for (const auto& r : rows) {
            bool isTarget = false;
            for (const auto& kv : targetTypes) {
                if (kv.second == r.typeKey) isTarget = true;
            }
            const std::string sname = stateNameOf(r.dynamicState);
            nlohmann::json row = {{"id", r.id},
                                  {"no", r.no},
                                  {"type", r.typeKey},
                                  {"typeName", r.typeName},
                                  {"state", r.dynamicState},
                                  {"stateName", sname},
                                  {"handled", handledIds.count(r.id) > 0},
                                  {"threatBand", r.threatBand},
                                  {"threatScore", r.threatScore},
                                  {"confidence", r.confidence},
                                  {"status", r.status},
                                  {"lng", r.lng},
                                  {"lat", r.lat},
                                  {"altM", r.alt}};
            // 处置档（不写死中文）：① 状态名以规则包档位标签**前缀命中** → 用那个标签；
            // ② 没有打击记录且不是 struck/destroyed → 权重为 0 的那一档（= 规则包自己的"无损"档）
            std::string grade;
            for (const auto& kv : gradeWeight) {
                if (!sname.empty() && sname.rfind(kv.first, 0) == 0) grade = kv.first;
            }
            if (grade.empty() && !handledIds.count(r.id) && r.dynamicState != "struck" &&
                r.dynamicState != "destroyed" && !intactGrade.empty()) {
                grade = intactGrade;
            }
            if (!grade.empty()) {
                row["result"] = grade;
            } else {
                unmappedRows.push_back({{"id", r.id},
                                        {"state", r.dynamicState},
                                        {"stateName", sname},
                                        {"reason", "规则包 reportFields.json 的处置档词表里没有与该状态"
                                                   "对应的档位（两包之间没有声明映射）→ 本行不填 result，"
                                                   "MUST NOT 自造档位文案"}});
            }
            if (isTarget) {
                ++targetsFound;
                targetRows.push_back(row);
            } else {
                ++platformsFound;
                platformRows.push_back(row);
            }
        }
        nlohmann::json gr = {{"rule", "状态显示名以档位标签为前缀 → 取该档位（两处取值都来自规则包，宿主不写中文）"},
                             {"labels", nlohmann::json::object()},
                             {"weights", nlohmann::json::object()}};
        for (const auto& kv : gradeWeight) gr["weights"][kv.first] = kv.second;
        for (const auto& kv : fieldLabel) gr["labels"][kv.first] = kv.second;
        gradeRules.push_back(gr);
        gradeRules.push_back(
            {{"rule", "没有成功动作记录且状态不是 struck/destroyed → 权重为 0 的那一档（规则包声明的无损档）"},
             {"intactGrade", intactGrade}});
        ledgerOut["targets"] = targetRows;
        ledgerOut["platforms"] = platformRows;
        ledgerOut["targetsFound"] = targetsFound;
        ledgerOut["platformsFound"] = platformsFound;
        ledgerOut["handledTotal"] = static_cast<int>(handledIds.size());
        ledgerOut["gradeRules"] = gradeRules;
        ledgerOut["unmapped"] = unmappedRows;
        ledgerOut["entry"] = "entity_ledger::EntityLedger::listEntities / actionLog / effectivePolicies";
        if (targetsFound > 0) {
            putBlock("targets", "entity-ledger:listEntities（missionId 过滤）",
                     {{"found", targetsFound}});
            noteSource("targets", "found", "entity-ledger",
                       "台账里 typeKey 命中场景 targets[] 的实体条数（目标随探测出现）");
        } else {
            dataGaps.push_back({{"key", "targets.found"},
                                {"engine", "entity-ledger"},
                                {"reason", "本任务台账里还没有被探测登记的目标（目标随探测出现）"}});
        }
        if (!unmappedRows.empty()) {
            dataGaps.push_back({{"key", "targetResults[].result"},
                                {"engine", "entity-ledger + report-engine"},
                                {"reason", std::to_string(unmappedRows.size()) +
                                               " 行的状态在两包词表之间没有声明的处置档 → 该行的 result 留空"
                                               "（见 ledger.unmapped；MUST NOT 自造档位文案）"}});
        }
    } else {
        dataGaps.push_back({{"key", "ledger"},
                            {"engine", "entity-ledger"},
                            {"reason", "entity-ledger 未装配"}});
    }
#else
    dataGaps.push_back({{"key", "ledger"},
                        {"engine", "entity-ledger"},
                        {"reason", "编译期未装配 entity-ledger（MA_WITH_LEDGER=0）"}});
#endif

    // 预警计数：alert-engine 的 `counts()`（口径由 basis 声明）+ `listAlerts()`
    nlohmann::json alertsOut = nlohmann::json::object();
#if MA_WITH_ALERT
    if (engines_.alertEngine) {
        const alert_engine::AlertCounts ac = engines_.alertEngine->counts();
        nlohmann::json countsJson = nlohmann::json::parse(ac.toJson().dump());
        alert_engine::AlertQuery aq;
        aq.missionIn = {missionId_};
        aq.limit = 100;
        const alert_engine::AlertQueryResult lst = engines_.alertEngine->listAlerts(aq);
        nlohmann::json items = nlohmann::json::array();
        for (const auto& a : lst.items) items.push_back(nlohmann::json::parse(a.toJson().dump()));
        alertsOut = {{"counts", countsJson},
                     {"basis", ac.basis},
                     {"list", {{"total", lst.total},
                               {"returned", lst.returned},
                               {"truncated", lst.truncated},
                               {"omitted", lst.omitted},
                               {"items", items}}},
                     {"entry", "alert_engine::AlertEngine::counts() / listAlerts(AlertQuery)"}};
        // 规则包状态：计数为 0 时**必须**能说清是"没规则"还是"没有观测入口"（MUST NOT 让 0 裸着）
        const alert_engine::AlertRulesInfo ari = engines_.alertEngine->rulesInfo();
        alertsOut["rules"] = {{"loaded", ari.loaded},
                              {"ruleCount", ari.ruleCount},
                              {"levelCount", ari.levelCount},
                              {"disabledCount", ari.disabledCount},
                              {"ruleIds", ari.ruleIds},
                              {"digest", ari.digest}};
        if (ac.alertCount == 0 && ac.rawRaises == 0) {
            alertsOut["note"] =
                ari.loaded
                    ? ("预警计数为 0 的原因：规则包已装载（" + std::to_string(ari.ruleCount) +
                       " 条规则），但**全工程目前没有任何把链路/探测读数折成 alert-engine "
                       "`observe()` 的调用者**（宿主未接这条腿，与 telemetry-store 的 append 腿同因）"
                       "→ counts() 如实为 0；MUST NOT 编预警次数")
                    : "预警计数为 0 的原因：alert-engine 规则包未装载";
            dataGaps.push_back({{"key", "alerts.count"},
                                {"engine", "alert-engine"},
                                {"reason", alertsOut["note"]}});
        }
        // 报告字段 `alertCount` 取**去重后条数**（规则包 alertCountBasis 的口径 = counts().basis）
        putBlock("alerts", "alert-engine:counts(" + ac.basis + ")", {{"count", ac.alertCount}});
        putBlock("alertsDigest", "alert-engine:counts(" + ac.basis + ")",
                 {{"openCount", ac.openActive},
                  {"rawRaises", ac.rawRaises},
                  {"alertsRaised", ac.alertsRaised},
                  {"merged", ac.merged},
                  {"recoveries", ac.recoveries},
                  {"suppressed", ac.suppressed}});
        noteSource("alerts", "count", "alert-engine",
                   "counts().alertCount（去重后条数，口径 basis=" + ac.basis + "）；未确认/未关闭的条数在 "
                   "alertsDigest.openCount");
    } else {
        dataGaps.push_back({{"key", "alerts"},
                            {"engine", "alert-engine"},
                            {"reason", "alert-engine 未装配"}});
    }
#else
    dataGaps.push_back({{"key", "alerts"},
                        {"engine", "alert-engine"},
                        {"reason", "编译期未装配 alert-engine（MA_WITH_ALERT=0）"}});
#endif

    // 链路稳定性类评估项：topology 的 `evaluate()` 结果（评估项 key = 报告字段名，同名键引用）
#if MA_WITH_TOPOLOGY
    if (engines_.topologyEngine) {
        const PhaseView pv = phaseViewLocked();
        topology::PhaseContext tpc;
        tpc.phaseKey = pv.phaseKey;
        tpc.seq = pv.seq;
        tpc.scenarioKey = pv.scenarioKey;
        tpc.enteredAt = pv.enteredAt;
        tpc.missionId = pv.missionId;
        const topology::EvaluationResult er = engines_.topologyEngine->evaluate(tpc);
        nlohmann::json evOut = nlohmann::json::object();
        for (const auto& item : er.items) evOut[item.key] = item.value;
        // 报告字段 `link.stability` → 评估项 `stability`（**同名键引用**，宿主不另起口径）
        for (const auto& f : lr.policies.fields) {
            for (const auto& s : f.sources) {
                if (s.block != "link" || s.blockField.empty()) continue;
                const auto itv = evOut.find(s.blockField);
                if (itv == evOut.end()) continue;
                putBlock("link", "topology:evaluate（评估项 " + s.blockField + "）",
                         {{s.blockField, *itv}});
                noteSource("link", s.blockField, "topology",
                           "topology evaluate().items[key=" + s.blockField +
                               "].value（键名 = 报告字段的 field，同名键引用）");
            }
        }
        if (!evOut.empty()) d["topologyEvaluation"] = evOut;  // 排障用（不算报告字段）
        if (!metricsBlocks.contains("link")) {
            dataGaps.push_back({{"key", "link.stability"},
                                {"engine", "topology"},
                                {"reason", "topology 的评估项里没有报告字段要的 key（未装载规则/无样本）"}});
        }
    } else {
        dataGaps.push_back({{"key", "link.stability"},
                            {"engine", "topology"},
                            {"reason", "topology 未装配"}});
    }
#else
    dataGaps.push_back({{"key", "link.stability"},
                        {"engine", "topology"},
                        {"reason", "编译期未装配 topology（MA_WITH_TOPOLOGY=0）"}});
#endif

    // 资源消耗：resource-alloc 的 `statsJson(missionId)`（逐型号 allocated）
#if MA_WITH_RESOURCE
    if (engines_.resource) {
        const std::optional<resource_alloc::json> stats = engines_.resource->statsJson(missionId_);
        if (stats.has_value()) {
            const nlohmann::json sv = nlohmann::json::parse(stats->dump());
            nlohmann::json resValues = nlohmann::json::object();
            for (const auto& item : sv.value("items", nlohmann::json::array())) {
                const std::string type = item.value("type", std::string());
                if (type.empty()) continue;
                // 报告块的 field 名（optical/radar/electronic/comm）= 统计行的型号键（同名键引用）
                resValues[type] = item.value("allocated", static_cast<int64_t>(0));
            }
            if (!resValues.empty()) {
                putBlock("resources", "resource-alloc:statsJson(missionId)", resValues);
                noteSource("resources", "optical/radar/electronic/comm", "resource-alloc",
                           "statsJson().items[].allocated（逐型号已分配架数；键名 = 报告块 field）");
            }
            d["resourceStats"] = sv;  // 原样（排障与前端库存面板）
        } else {
            dataGaps.push_back({{"key", "resources"},
                                {"engine", "resource-alloc"},
                                {"reason", "本任务还没有资源台账（statsJson 返 nullopt：未 initializeLedger）"}});
        }
        dataGaps.push_back({{"key", "resources.survivalRate"},
                            {"engine", "resource-alloc"},
                            {"reason", "resource-alloc 的统计口径里没有 survivalRate（只有 allocated/pending/"
                                       "onlineRate/readyRate/utilization）→ 留空，MUST NOT 编一个存活率"}});
    } else {
        dataGaps.push_back({{"key", "resources"},
                            {"engine", "resource-alloc"},
                            {"reason", "resource-alloc 未装配"}});
    }
#else
    dataGaps.push_back({{"key", "resources"},
                        {"engine", "resource-alloc"},
                        {"reason", "编译期未装配 resource-alloc（MA_WITH_RESOURCE=0）"}});
#endif

    // 效能评估：规则包声明了 scoring 的 effect 块，但 scoring 没有这些输出 → 如实留空并点名
    for (const auto& f : lr.policies.fields) {
        for (const auto& s : f.sources) {
            if (s.block == "effect" && !s.blockField.empty()) {
                dataGaps.push_back({{"key", "effect." + s.blockField},
                                    {"engine", s.engine},
                                    {"reason", "scoring / entity-ledger 都没有输出 effect." + s.blockField +
                                               "（引擎 capabilities 里无此口径）→ 留空，MUST NOT 编效能指标"}});
            }
            if (s.block == "cluster" && !s.blockField.empty()) {
                dataGaps.push_back({{"key", "cluster." + s.blockField},
                                    {"engine", s.engine},
                                    {"reason", "scoring 的 ScoreResult 里没有 " + s.blockField +
                                               "（方案评分只有六项 metrics）→ 留空"}});
            }
        }
    }

    // 用时类字段：`phaseMs` 口径靠"阶段 key"承载在规则包的 `snapshot` 字段上 —— 该 key 若不在
    // phase-engine 的 durations.byPhase/perPhase 里，就是**两包键引用不一致**（A15 同类数据缺陷），
    // 如实点名，MUST NOT 编一个时长。
    {
        std::set<std::string> knownPhases;
        for (const auto& e : durationsJson.value("byPhase", nlohmann::json::array())) {
            knownPhases.insert(e.value("phase", std::string()));
        }
        for (const auto& e : durationsJson.value("perPhase", nlohmann::json::array())) {
            knownPhases.insert(e.value("phase", std::string()));
        }
        for (const auto& f : lr.policies.fields) {
            for (const auto& s : f.sources) {
                if (s.blockField != "phaseMs" || s.snapshot.empty()) continue;
                if (knownPhases.count(s.snapshot) > 0) continue;
                dataGaps.push_back(
                    {{"key", f.key},
                     {"engine", "phase-engine + report-engine"},
                     {"reason", "报告字段 `" + f.key + "` 的用时口径声明了阶段 key \"" + s.snapshot +
                                    "\"，而 phase-engine 的 phases.json 里没有这个阶段"
                                    "（两包键引用不一致，与 A15 同类）→ 该字段留空，MUST NOT 编一个时长"}});
            }
        }
    }

    // 留存层（回放/统计）：telemetry-store 的 query / gaps / status —— **如实报空**
    nlohmann::json retention = nlohmann::json::object();
#if MA_WITH_STORE
    if (engines_.store) {
        telemetry_store::Query q;
        q.limit = 100;
        const telemetry_store::QueryResult qr = engines_.store->query(q);
        const std::vector<telemetry_store::Gap> gaps =
            engines_.store->gaps(0, wallClockMs(), 0, std::vector<std::string>{});
        const telemetry_store::Status stt = engines_.store->status();
        nlohmann::json gArr = nlohmann::json::array();
        for (const auto& g : gaps) {
            gArr.push_back({{"deviceId", g.deviceId},
                            {"fromTs", g.fromTs},
                            {"toTs", g.toTs},
                            {"durationMs", g.durationMs},
                            {"seqBefore", g.seqBefore},
                            {"seqAfter", g.seqAfter}});
        }
        retention = {{"rows", static_cast<int>(qr.rows.size())},
                     {"query", nlohmann::json::parse(qr.toJson().dump())},
                     {"gaps", gArr},
                     {"status", nlohmann::json::parse(stt.toJson().dump())},
                     {"entry", "telemetry_store::Store::query(Query) / gaps(from,to) / status()"},
                     {"appendCallers", 0}};
        if (qr.rows.empty()) {
            retention["note"] =
                "留存层无数据：**全工程目前没有任何 `append()` 调用者**（引擎集成接口地图 §D.4-3："
                "ingest→store 的写入腿尚未实现）→ 库是空的；因此本报告的**回放/统计段留空**，"
                "宿主 MUST NOT 编统计（status.appended / persisted 是 0 就是这个原因）";
            dataGaps.push_back({{"key", "retention.replay"},
                                {"engine", "telemetry-store"},
                                {"reason", retention["note"]}});
        } else {
            retention["note"] = "留存层有数据（rows=" + std::to_string(qr.rows.size()) + "）";
        }
    } else {
        retention = {{"rows", 0}, {"note", "telemetry-store 未实例化（编译期 MA_WITH_STORE=0）"}};
        dataGaps.push_back({{"key", "retention.replay"},
                            {"engine", "telemetry-store"},
                            {"reason", "telemetry-store 未实例化（编译期 MA_WITH_STORE=0）"}});
    }
#else
    retention = {{"rows", 0}, {"note", "telemetry-store 未装配（编译期 MA_WITH_STORE=0）"}};
    dataGaps.push_back({{"key", "retention.replay"},
                        {"engine", "telemetry-store"},
                        {"reason", "telemetry-store 未装配（编译期 MA_WITH_STORE=0）→ 回放/统计留空"}});
#endif

    root["metrics"] = metricsBlocks;
    root["targets"] = targetRows;
    // 报告字段 `targetResults` 就在 root 上（`arrayPath: "targetResults"`）—— 逐目标处置明细
    root["targetResults"] = targetRows;
    root["missionTimeline"] = {{"missionId", missionId_},
                               {"durations", durationsJson},
                               {"startedAt", startedAt},
                               {"generatedAt", generatedAtMs}};
    root["extra"] = {
        {"retention", retention},
        {"alerts", alertsOut},
        {"ledger", {{"targetsFound", ledgerOut.value("targetsFound", 0)},
                    {"platformsFound", ledgerOut.value("platformsFound", 0)},
                    {"handledTotal", ledgerOut.value("handledTotal", 0)},
                    {"unmapped", unmappedRows}}},
        {"metricSources", metricSources},
        {"dataGaps", dataGaps},
        {"notes", nlohmann::json::array(
                      {"留存层（回放/统计）目前没有写入腿 → 库为空；本报告的对应段留空并给出原因",
                       "台账/时间轴/预警三类数值全部来自引擎；拿不到的段落在 dataGaps 里逐条点名"})}};

    report_engine::ReportSnapshot snap;
    snap.root = root;
    snap.snapshotId = root["meta"].value("snapshotId", std::string());
    snap.hasGeneratedAt = true;
    snap.generatedAt = generatedAtMs;
    snap.missionId = missionId_;
    snap.timeline.missionId = missionId_;
    snap.timeline.hasCreatedAt = (startedAt > 0);
    snap.timeline.createdAt = startedAt;
    snap.timeline.hasGeneratedAt = true;
    snap.timeline.generatedAt = generatedAtMs;
    snap.timeline.durations = durationsJson;  // ← **逐字**（就是 phase::durations() 的那份字节）
    snap.timeline.extra = {{"durationsRawDigest", tlBefore.value("durationsDigest", std::string())},
                           {"source", "phase-engine durations()"}};

    report_engine::GenerateOptions opts;
    opts.clock = std::make_shared<ReportWallClock>();  // 一次生成只读一次 nowMs()
    if (tplLoaded) opts.templates = tplSrc;            // 注入了就用规则包模板；没有就回落内置
    opts.render.templateName = "report";
    opts.render.includeTrace = true;
    opts.timeBasis = params.value("timeBasis", std::string());  // 空 = 规则包 defaultTimeBasis
    opts.pathPrefix = (std::filesystem::path(cfg_.resolvePath(cfg_.dataDir)) / "reports").string();
    opts.numbering.present = false;
    const report_engine::GenerateResult res = engines_.reportEngine->generate(snap, opts);

    // ★ 口径（实测踩过）：report-engine 的 `ReportDocument/ArchiveMeta/GenerateResult::toJson()`
    //   **成员函数只有声明、没有定义**（`src/engine.cc` 里只有同名**自由函数**）→ 必须用自由函数，
    //   否则链接期报 LNK2019（与 `loadPoliciesFile` 那个恒失败的占位是同一类坑）。
    nlohmann::json reportOut = nlohmann::json::parse(report_engine::toJson(res).dump());
    reportOut["ok"] = res.ok();
    reportOut["renderFormat"] = res.render.format;
    reportOut["renderOk"] = res.render.ok;
    reportOut["renderReason"] = res.render.reason;
    reportOut["html"] = res.render.content;  // 供"导出"与自证脚本用（引擎不落盘）
    reportOut["archivePath"] = res.archive.fileName.empty()
                                   ? std::string()
                                   : (opts.pathPrefix + "/" + res.archive.fileName);
    d["report"] = reportOut;
    d["document"] = nlohmann::json::parse(report_engine::toJson(res.document).dump());
    d["archive"] = nlohmann::json::parse(report_engine::toJson(res.archive).dump());
    d["numbering"] = {{"dayKey", res.numbering.dayKey},
                      {"seq", res.numbering.seq},
                      {"present", res.numbering.present}};
    d["missingFields"] = res.missing;
    d["warnings"] = res.warnings;
    d["timeline"] = tlBefore;
    d["timeline"]["capturedBefore"] = "advance(T7)——报告里的时间轴是**生成那一刻**的读数";
    if (!totalMsZero.is_null()) d["timeline"]["totalMsZeroReason"] = totalMsZero;
    d["timeline"]["snapshotInputEqual"] =
        (!durationsRaw.empty() &&
         nlohmann::json::parse(durationsRaw) ==
             nlohmann::json::parse(snap.timeline.durations.dump()));
    d["snapshotRoot"] = root;  // 喂给引擎的**只读快照原样**（脚本据此核对"无数据 + 原因"进了报告输入）
    d["alerts"] = alertsOut;
    d["ledger"] = ledgerOut;
    d["retention"] = retention;
    d["metricSources"] = metricSources;
    d["dataGaps"] = dataGaps;
    if (!res.ok()) {
        code = res.code;
        d["message"] = "report-engine generate 拒绝：" + res.message;
        d["notes"] = notes;
        return d;
    }
    // 模板回落（引擎写进 warnings）如实带出
    for (const auto& w : res.warnings) {
        if (w.find("fell back to engine built-in") != std::string::npos) {
            tplOut["fallback"] = true;
            tplOut["fallbackWarning"] = w;
        }
    }
    d["template"] = tplOut;

    // ---- ⑥ 步 11：阶段 T7 + 步号 11 ----
    nlohmann::json advance = nlohmann::json::object();
    bool flowChanged = false;
#if MA_WITH_PHASE
    if (engines_.phase && !missionId_.empty()) {
        const int stepBefore = step_;
        const std::string phaseBefore = phase_;
        phase::AdvanceRequest ar;
        ar.missionId = missionId_;
        ar.to = "T7";
        ar.reason = "host:report.generate";
        ar.operatorId = params.value("operatorId", std::string("host"));
        phase::TransitionResult tr = engines_.phase->advance(ar);
        nlohmann::json first = tr.dataJson();
        bool forced = false;
        if (tr.code != 0) {
            ar.force = true;
            ar.reason = "host:report.generate:force";
            tr = engines_.phase->advance(ar);
            forced = true;
        }
        advance["phase"] = "T7";
        advance["forced"] = forced;
        advance["code"] = tr.code;
        advance["firstAttempt"] = first;
        advance["result"] = tr.dataJson();
        if (tr.code == 0) {
            const PhaseView v2 = phaseViewLocked();
            phase_ = v2.phaseKey.empty() ? std::string("T7") : v2.phaseKey;
            enteredAtMs_ = v2.enteredAt != 0 ? v2.enteredAt : enteredAtMs_;
            step_ = 11;
            advance["step"] = step_;
            advance["stepKey"] = flowStepOf(step_) ? flowStepOf(step_)->key : "";
            advance["phaseKey"] = phase_;
            flowChanged = (stepBefore != step_) || (phaseBefore != phase_);
        } else {
            advance["note"] = "phase-engine 拒绝（含 force）→ 步号不前进（报告照样产出，回执原样给出）";
        }
    } else
#endif
    {
        advance["note"] = "phase-engine 未装配 → 只按 verb 语义把宿主步号落到 11";
        step_ = 11;
        flowChanged = true;
    }
    d["advance"] = advance;
    d["step"] = step_;
    d["stepKey"] = flowStepOf(step_) ? flowStepOf(step_)->key : "";
    d["phase"] = phase_;
    d["flowStateChanged"] = flowChanged;
    d["source"] = "规则包 ← 宿主读 reportFields.json → loadPolicies(json)；时间轴 ← phase::durations()（逐字）；"
                  "预警 ← alert-engine counts()/listAlerts()；台账 ← entity-ledger listEntities/actionLog；"
                  "留存层 ← telemetry-store query/gaps/status（当前为空，原因见 retention.note）";
    notes.push_back("报告由引擎生成（宿主只给只读快照）：generate() 不落盘、不落库、不广播；"
                    "`report.ready` 事件走装配期注入的 IReportSink → realtime-hub");
    d["notes"] = notes;
    lastReportRun_ = d;
    return d;
#else
    (void)params;
    code = 1005;
    d["message"] = "report-engine 未装配（编译期 MA_WITH_REPORT=0）";
    return d;
#endif
}

// ============================================================================
// P7：一键串联（`flow.runAll`）—— 按 Excel 步序把 11 步一次跑完
// ============================================================================
//
// ★ 三条口径（这段代码的全部理由）：
//   ① **不抄近路**：每一步都调 `command(verb, params)` —— 与前端点按钮、与 p2–p6 自证脚本
//      **同一个入口、同一段引擎调用代码**。本函数里 MUST NOT 出现任何引擎调用：那会变成
//      "另一条更快的路"，而两条路早晚会不一致（P3–P6 的实测形状修正全都写在那些分支里）。
//   ② **失败即停**：任一步 `code != 0` → 记下 `failedStep` 立刻停（后面的步骤**不跑**），
//      回执里给那一步真的发过的每条命令（含引擎原话 message/unmet）。MUST NOT 跳过、
//      MUST NOT 重试到成功、MUST NOT 把失败写成成功（"看起来跑完了"是最坏的交付）。
//   ③ **读数全部留痕**：每步记 `{step,verb,code,ms,key}`，另记该步每条命令的 code/ms/关键读数；
//      倍速演示的每次 `sim.state` 读数原样进 `speedDemos`（脚本据此判"倍速确实变过"）。
//
// 入参：`{from?:1..11, to?:1..11, speed?:1|8|60, pacingMs?:number, reset?:bool, planId?:string,
//        bootWaitMs?, targetsWaitMs?}`
//   · `speed` 在第 6 步经 `sim.speed` 生效，并在同一步演示一次变速（默认 8 → 60 → 1；
//     三次都记 `sim.state` 读数，串完回到请求的倍速）；
//   · `reset`（默认 true）= 先 `sim.reset` + `mission.reset` + `boot.reset` 造一个**真起点**
//     —— 这就是"不重启进程也能重跑一遍"的那一步，也是第二遍仍然全绿的前提；
//   · `planId`：`from>4`（本轮没有跑第 4 步）时给第 5/9 步用的方案 id。
nlohmann::json FlowEngine::runAll(const std::string& verb, const nlohmann::json& params) {
    const int from = intOr(params, "from", 1);
    const int to = intOr(params, "to", 11);
    const int speed = intOr(params, "speed", 8);
    const int pacingMs = intOr(params, "pacingMs", 0);
    const bool doReset = params.value("reset", true);
    const int bootWaitMs = intOr(params, "bootWaitMs", 90000);
    const int targetsWaitMs = intOr(params, "targetsWaitMs", 90000);
    const std::string planIdParam = params.value("planId", std::string());

    if (from < 1 || from > 11) {
        return badRequest(verb, "from 越界（1..11）：" + std::to_string(from));
    }
    if (to < from || to > 11) {
        return badRequest(verb, "to 越界（>= from 且 <= 11）：" + std::to_string(to));
    }
    if (speed != 1 && speed != 8 && speed != 60) {
        return badRequest(verb, "speed 只接受 1 / 8 / 60（引擎 SimSource::setSpeed 的取值域）");
    }

    const int64_t t0 = wallClockMs();
    nlohmann::json prepare = nlohmann::json::object();
    nlohmann::json steps = nlohmann::json::array();
    nlohmann::json speedDemos = nlohmann::json::array();
    nlohmann::json warnings = nlohmann::json::array();
    nlohmann::json notes = nlohmann::json::array();
    int failedStep = 0;
    int failedCode = 0;
    std::string failedVerb;
    std::string failedReason;
    std::string groupPlanId;   // 第 4 步 alloc.plans 给过的推荐 id（引擎原样值）
    std::string strikePlanId;  // 第 8 步 strike.plans 给过的推荐 id
    std::string firstTargetId; // 第 7 步台账里第一个目标实体 id

    // ---- 内部工具：调一次**真实命令**并留痕 -------------------------------------------
    //
    // `raw` 不记录（轮询用：等目标出现可能问几十次，全记进回执就把回执撑成日志了）。
    auto raw = [&](const std::string& v, const nlohmann::json& p, nlohmann::json& out) -> int {
        try {
            out = command(v, p);
        } catch (const std::exception& e) {
            out = {{"code", 1005},
                   {"verb", v},
                   {"error", {{"message", std::string("命令入口抛异常：") + e.what()}}}};
        }
        return out.value("code", 0);
    };

    // 一次调用的**摘要**：只挑"这一步到底做成了什么"的可读读数，不搬整份 data
    // （`alloc.plans` 一份就几十 KB）。取值一律来自那次调用的原样回执，宿主不加工。
    auto digest = [](const nlohmann::json& r) -> nlohmann::json {
        nlohmann::json o = nlohmann::json::object();
        const nlohmann::json d = r.value("data", nlohmann::json::object());
        if (d.is_object()) {
            static const char* kScalar[] = {
                "missionId", "step", "stepKey", "phase", "status", "accepted", "idempotent",
                "action", "registered", "entityAttempts", "targetCount", "count", "recommendedId",
                "recommendedPercent", "planId", "entityId", "stateAfter", "hitPlatformId",
                "reportNo", "linksTotal", "overall", "reset", "simElapsedMs", "speed", "platforms",
                "attachments", "resumed", "paused", "driverStopped", "events", "dtMs",
                "bootComplete", "waitedMs", "coverageRatio", "durationsDigest"};
            for (const char* k : kScalar) {
                const auto it = d.find(k);
                if (it != d.end() && !it->is_object() && !it->is_array()) o[k] = *it;
            }
            for (const char* k : {"items", "targets", "areas", "zones", "steps", "channels",
                                  "links", "dataGaps", "failures"}) {
                const auto it = d.find(k);
                if (it != d.end() && it->is_array()) o[std::string(k) + "Count"] = it->size();
            }
            if (d.contains("state") && d["state"].is_object()) {
                for (const char* k : {"running", "paused", "speed", "simElapsedMs", "platforms",
                                      "emitted"}) {
                    if (d["state"].contains(k)) o[std::string("state.") + k] = d["state"][k];
                }
            }
            if (d.contains("report") && d["report"].is_object()) {
                const nlohmann::json ar = d["report"].value("archive", nlohmann::json::object());
                if (ar.is_object() && ar.contains("reportNo")) o["reportNo"] = ar["reportNo"];
            }
            if (d.contains("ipPoint") && d["ipPoint"].is_object()) {
                o["ipPointKey"] = d["ipPoint"].value("key", nlohmann::json(nullptr));
            }
            if (d.contains("dive") && d["dive"].is_object()) {
                o["diveApplied"] = d["dive"].value("applied", false);
                o["hit"] = d["dive"].contains("hit") && d["dive"]["hit"].is_object();
            }
        }
        if (r.contains("error")) {
            const nlohmann::json e = r["error"];
            nlohmann::json er = nlohmann::json::object();
            if (e.is_object()) {
                for (const char* k : {"message", "reason", "planId", "adopted", "confirmed",
                                      "targetId"}) {
                    const auto it = e.find(k);
                    if (it != e.end() && !it->is_object() && !it->is_array()) er[k] = *it;
                }
                if (e.contains("unmet") && e["unmet"].is_array()) er["unmet"] = e["unmet"];
                // 引擎的双层信封（P4 实测）：`error.data.unmet`
                if (e.contains("data") && e["data"].is_object()) {
                    const nlohmann::json e2 = e["data"];
                    if (e2.contains("unmet") && e2["unmet"].is_array()) er["unmet"] = e2["unmet"];
                    if (e2.contains("message")) er["engineMessage"] = e2["message"];
                }
            } else {
                er["message"] = e;
            }
            o["error"] = er;
        }
        return o;
    };

    // 记录型调用（进 `calls[]`）
    auto run = [&](nlohmann::json& calls, const std::string& v, const nlohmann::json& p,
                   nlohmann::json& out) -> int {
        const int64_t c0 = wallClockMs();
        const int code = raw(v, p, out);
        const int64_t c1 = wallClockMs();
        nlohmann::json row = {{"verb", v}, {"code", code}, {"ms", c1 - c0}, {"params", p}};
        const nlohmann::json dg = digest(out);
        if (!dg.empty()) row["readings"] = dg;
        calls.push_back(row);
        return code;
    };

    // 失败原因：优先引擎/宿主的 message，其次 unmet，最后给一句可读兜底（不编原因）。
    auto reasonOf = [](const nlohmann::json& r, const nlohmann::json& detail) -> std::string {
        const nlohmann::json e = r.value("error", nlohmann::json::object());
        if (e.is_object()) {
            const std::string m = e.value("message", std::string());
            if (!m.empty()) return m;
            if (e.contains("data") && e["data"].is_object()) {
                const std::string m2 = e["data"].value("message", std::string());
                if (!m2.empty()) return m2;
            }
            if (e.contains("unmet") && e["unmet"].is_array()) {
                return "前置未满足 unmet=" + e["unmet"].dump();
            }
        }
        const std::string dm = detail.value("message", std::string());
        if (!dm.empty()) return dm;
        return "code=" + std::to_string(r.value("code", 0)) + "（引擎/宿主未给 message，回执原样）";
    };

    // 数组字段长度（取不到 → 0，别把 null 当数组）
    auto arrSize = [](const nlohmann::json& d, const char* k) -> int {
        if (!d.is_object()) return 0;
        const auto it = d.find(k);
        if (it == d.end() || !it->is_array()) return 0;
        return static_cast<int>(it->size());
    };

    // 取候选方案 id：`recommendedId` 优先，回落 `items[0].candidate.id`（两个都取不到 → 空）
    auto planIdOf = [&](const nlohmann::json& d) -> std::string {
        std::string id = d.value("recommendedId", std::string());
        if (!id.empty()) return id;
        if (d.contains("items") && d["items"].is_array() && !d["items"].empty()) {
            const nlohmann::json c = d["items"][0].value("candidate", nlohmann::json::object());
            id = c.value("id", std::string());
        }
        return id;
    };

    try {
        // ---- ⓪ 准备：造一个**真起点**（不重启进程也能重跑一遍）----------------------------
        if (doReset) {
            for (const char* v : {"sim.reset", "mission.reset", "boot.reset"}) {
                const int64_t c0 = wallClockMs();
                nlohmann::json r;
                const int code = raw(v, nlohmann::json::object(), r);
                prepare[v] = {{"code", code},
                              {"ms", wallClockMs() - c0},
                              {"readings", digest(r)}};
                if (code != 0) {
                    // 起点不可信 → 一个步骤都不跑（跑出来的是"接着上一轮"的假串联）
                    nlohmann::json out = {{"ok", false},
                                          {"prepare", prepare},
                                          {"steps", steps},
                                          {"speedDemos", speedDemos},
                                          {"summary", {{"ok", false},
                                                       {"failedStep", nullptr},
                                                       {"prepareFailed", v},
                                                       {"totalMs", wallClockMs() - t0},
                                                       {"speed", speed}}},
                                          {"notes", notes}};
                    notes.push_back(std::string("准备阶段 `") + v + "` 失败 → 没有跑任何步骤"
                                    "（否则跑出来的是接着上一轮的假串联）");
                    out["notes"] = notes;
                    LOG_ERROR << "[flow] flow.runAll 准备失败：" << v << " code=" << code;
                    return reply(verb, code, out);
                }
            }
            notes.push_back("准备阶段：sim.reset（重建仿真源到初始状态）+ mission.reset + boot.reset "
                            "→ 步 1 / 无任务 / 仿真计数从 0 重新计时");
        } else {
            notes.push_back("准备阶段：**跳过**（reset=false）→ 起点由调用方自己保证"
                            "（前置不满足时下面的步骤会如实停在失败的那一步）");
        }

        // ---- 11 步（一步一条 `steps[]` 记录；每步内部可以发多条命令）-----------------------
        for (int step = from; step <= to; ++step) {
            const FlowStep* fs = flowStepOf(step);
            nlohmann::json cur = nlohmann::json::object();
            cur["step"] = step;
            cur["key"] = fs ? fs->key : "";
            nlohmann::json calls = nlohmann::json::array();
            nlohmann::json detail = nlohmann::json::object();
            const int64_t s0 = wallClockMs();
            std::string primary;
            int code = 0;
            nlohmann::json r = nlohmann::json::object();

            // ---------------------------------------------------------------- 步 1 启动加载
            if (step == 1) {
                primary = "boot.run";
                code = run(calls, "boot.run", {{"pacingMs", pacingMs}}, r);
                if (code == 0) {
                    // `boot.run` 只**受理**：进度由宿主工作线程按**真实条件**推进（不是 sleep）。
                    // 所以这里等的是引擎的 `bootComplete`（模块就绪判定的真实结果）。
                    int64_t waited = 0;
                    while (!bootComplete() && waited < bootWaitMs) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(200));
                        waited += 200;
                    }
                    const bool complete = bootComplete();
                    detail["bootComplete"] = complete;
                    detail["waitedMs"] = waited;
                    detail["accepted"] = r.value("data", nlohmann::json::object())
                                             .value("accepted", false);
                    if (!complete) {
                        code = 1005;
                        detail["message"] =
                            "启动加载未在 " + std::to_string(bootWaitMs) +
                            " ms 内完成（引擎 bootComplete=false）→ 真实条件未成立，"
                            "逐模块结论见 /api/state 的 boot.modules";
                    }
                }
            }

            // ---------------------------------------------------------------- 步 2 自检校验
            if (step == 2) {
                primary = "selfcheck.run";
                code = run(calls, "selfcheck.run", {{"bypassCache", true}}, r);
                const nlohmann::json d2 = r.value("data", nlohmann::json::object());
                detail["status"] = d2.value("status", std::string());
                detail["checkedAt"] = d2.value("checkedAt", 0);
                detail["elapsedMs"] = d2.value("elapsedMs", 0);
                detail["selfCheckItems"] = arrSize(d2, "selfCheck");
                detail["failures"] = arrSize(d2, "failures");
                if (code == 0 && detail["status"].is_string() &&
                    detail["status"].get<std::string>() != "ok") {
                    // 自检结论是**引擎给的数据**，不是这一步的成败（这一步做的是"跑自检"）。
                    // 但结论不是 ok 就必须显式留痕，别让回执看起来一切正常。
                    warnings.push_back("步 2 自检结论 status=" + detail["status"].dump() +
                                       "（引擎原样；见 /api/state 的 selfCheck.items）");
                }
            }

            // ---------------------------------------------------------------- 步 3 任务态势
            if (step == 3) {
                primary = "flow.enter";
                code = run(calls, "flow.enter", nlohmann::json::object(), r);
                const nlohmann::json d3 = r.value("data", nlohmann::json::object());
                detail["missionId"] = d3.value("missionId", std::string());
                detail["phase"] = d3.value("phase", std::string());
                detail["enteredAt"] = d3.value("enteredAt", 0);
                if (code == 0) {
                    nlohmann::json r2;
                    const int c2 = run(calls, "situation.snapshot", nlohmann::json::object(), r2);
                    const nlohmann::json d3b = r2.value("data", nlohmann::json::object());
                    detail["areas"] = arrSize(d3b, "areas");
                    detail["zones"] = arrSize(d3b, "zones");
                    detail["platforms"] = arrSize(d3b, "platforms");
                    detail["targets"] = arrSize(d3b, "targets");
                    if (c2 != 0) {
                        code = c2;
                        detail["message"] = "situation.snapshot 失败：" + reasonOf(r2, detail);
                    }
                }
            }

            // ---------------------------------------------------------------- 步 4 编组方案
            if (step == 4) {
                primary = "alloc.plans";
                code = run(calls, "alloc.plans", {{"side", "group"}, {"count", 3}}, r);
                const nlohmann::json d4 = r.value("data", nlohmann::json::object());
                groupPlanId = planIdOf(d4);
                detail["planId"] = groupPlanId;
                detail["items"] = arrSize(d4, "items");
                if (code == 0 && groupPlanId.empty()) {
                    code = 1004;
                    detail["message"] = "alloc.plans 没给出可用 planId（recommendedId 与 "
                                        "items[0].candidate.id 都取不到）→ 第 5 步无从采纳"
                                        "（宿主不编方案 id）";
                }
            }

            // ---------------------------------------------------------------- 步 5 编组确认
            // 命令序（冻结 §2）：alloc.plans → **alloc.adopt（硬前置）** → alloc.confirm → alloc.assign。
            // 顺序照抄前端契约，MUST NOT 换序 —— 换序会让引擎回 1003（那样"全过程无 code!=0"就没了）。
            if (step == 5) {
                primary = "alloc.adopt";
                const std::string planId = groupPlanId.empty() ? planIdParam : groupPlanId;
                detail["planId"] = planId;
                code = run(calls, "alloc.adopt", {{"planId", planId}, {"side", "group"}}, r);
                if (code == 0) {
                    code = run(calls, "alloc.confirm", {{"planId", planId}, {"side", "group"}}, r);
                }
                if (code == 0) {
                    code = run(calls, "alloc.assign", {{"planId", planId}, {"side", "group"}}, r);
                    const nlohmann::json d5 = r.value("data", nlohmann::json::object());
                    detail["registered"] = d5.value("registered", 0);
                    detail["entityAttempts"] = d5.value("entityAttempts", 0);
                }
            }

            // ---------------------------------------------------------------- 步 6 任务执行
            if (step == 6) {
                primary = "mission.advance";
                code = run(calls, "mission.advance", {{"to", "T2"}}, r);
                bool forced = false;
                if (code != 0) {
                    // 阶段 Gate 拦下时 force 重试一次（与 p3–p6 同口径：force 的两次回执都留痕）
                    forced = true;
                    code = run(calls, "mission.advance", {{"to", "T2"}, {"force", true}}, r);
                }
                detail["advanceToT2"] = code;
                detail["forced"] = forced;
                if (code == 0) {
                    // ---- 倍速：`speed` 生效 + 至少一次变速演示（三次读数两两不同）----
                    std::vector<int> seq;
                    seq.push_back(speed);
                    for (int cand : {60, 1, 8}) {
                        if (seq.size() >= 3) break;
                        bool dup = false;
                        for (int x : seq) {
                            if (x == cand) dup = true;
                        }
                        if (!dup) seq.push_back(cand);
                    }
                    for (std::size_t i = 0; i < seq.size() && code == 0; ++i) {
                        const int sp = seq[i];
                        nlohmann::json rs;
                        const int cs = run(calls, "sim.speed", {{"speed", sp}}, rs);
                        nlohmann::json rst;
                        const int cst = run(calls, "sim.state", nlohmann::json::object(), rst);
                        const nlohmann::json stt =
                            rst.value("data", nlohmann::json::object())
                                .value("state", nlohmann::json::object());
                        nlohmann::json row = {{"requested", sp},
                                              {"code", cs},
                                              {"stateCode", cst},
                                              {"observed", stt.value("speed", -1)},
                                              {"match", stt.value("speed", -1) == sp && cs == 0 &&
                                                            cst == 0},
                                              {"state", stt}};
                        speedDemos.push_back(row);
                        if (cs != 0) {
                            code = cs;
                            detail["message"] = "sim.speed 被引擎拒：" + reasonOf(rs, detail);
                        } else if (cst != 0) {
                            code = cst;
                            detail["message"] = "sim.state 取读数失败：" + reasonOf(rst, detail);
                        } else if (stt.value("speed", -1) != sp) {
                            // 请求了但引擎读数不是它 → 假倍速，如实失败（MUST NOT 记成成功）
                            code = 1005;
                            detail["message"] = "sim.speed 请求 " + std::to_string(sp) +
                                                " 但 sim.state 读数=" +
                                                std::to_string(stt.value("speed", -1)) +
                                                "（引擎未接受）→ 倍速演示不算数";
                        }
                    }
                    // 演示结束回到请求倍速：后面几步（目标出现/打击）按它跑
                    if (code == 0 && !seq.empty() && seq.back() != speed) {
                        nlohmann::json rb;
                        code = run(calls, "sim.speed", {{"speed", speed}}, rb);
                    }
                    detail["speedDemos"] = static_cast<int>(speedDemos.size());
                }
                if (code == 0) {
                    code = run(calls, "topology.evaluate", nlohmann::json::object(), r);
                    detail["links"] = arrSize(r.value("data", nlohmann::json::object()), "links");
                }
                if (code == 0) {
                    code = run(calls, "sensor.status", nlohmann::json::object(), r);
                    const nlohmann::json d6 = r.value("data", nlohmann::json::object());
                    detail["coverageRatio"] = d6.value("coverageRatio", 0.0);
                    detail["revisitMeanMs"] =
                        d6.value("revisitPeriodMs", nlohmann::json::object())
                            .value("mean", nlohmann::json(nullptr));
                }
            }

            // ---------------------------------------------------------------- 步 7 目标显示
            if (step == 7) {
                primary = "targets.list";
                int64_t waited = 0;
                int attempts = 0;
                int targetCount = 0;
                const int64_t p0 = wallClockMs();
                while (true) {
                    ++attempts;
                    const int c = raw("targets.list", nlohmann::json::object(), r);
                    if (c != 0) {
                        code = c;
                        break;
                    }
                    targetCount = arrSize(r.value("data", nlohmann::json::object()), "targets");
                    if (targetCount > 0 || waited >= targetsWaitMs) break;
                    std::this_thread::sleep_for(std::chrono::milliseconds(500));
                    waited += 500;
                }
                // 轮询只留**一条**记录（问了几十次全记进来会把回执撑成日志）
                nlohmann::json poll = {{"verb", "targets.list"},
                                       {"code", code},
                                       {"ms", wallClockMs() - p0},
                                       {"polls", attempts},
                                       {"waitedMs", waited},
                                       {"readings", {{"targetCount", targetCount}}}};
                calls.push_back(poll);
                detail["targets"] = targetCount;
                detail["polls"] = attempts;
                detail["waitedMs"] = waited;
                if (code == 0 && targetCount == 0) {
                    code = 1004;
                    detail["message"] =
                        "等 " + std::to_string(targetsWaitMs) + " ms 仍没有目标被探测登记（目标随"
                        "**真实探测**出现）→ 先看 sensor.status 的挂接/覆盖与 sim.state 的 "
                        "running/emitted，再看 /api/state 的 targets.detection";
                }
                if (code == 0) {
                    firstTargetId = r["data"]["targets"][0].value("id", std::string());
                    detail["firstTargetId"] = firstTargetId;
                    nlohmann::json rd;
                    const int cd = run(calls, "targets.detail", {{"entityId", firstTargetId}}, rd);
                    if (cd == 0) {
                        detail["declaredActions"] = rd.value("data", nlohmann::json::object())
                                                        .value("declaredActions",
                                                               nlohmann::json::array());
                    } else {
                        code = cd;
                        detail["message"] = "targets.detail 失败：" + reasonOf(rd, detail);
                    }
                }
                if (code == 0) {
                    // 步 7 要挂媒体面板 → 把通道清单广播一次（前端订阅 media.channels）
                    nlohmann::json rm;
                    const int cm = run(calls, "media.channels", {{"broadcast", true}}, rm);
                    detail["mediaChannels"] =
                        arrSize(rm.value("data", nlohmann::json::object()), "channels");
                    if (cm != 0) {
                        code = cm;
                        detail["message"] = "media.channels 失败：" + reasonOf(rm, detail);
                    }
                }
            }

            // ---------------------------------------------------------------- 步 8 打击决策
            if (step == 8) {
                primary = "strike.plans";
                code = run(calls, "strike.plans", {{"count", 3}}, r);
                const nlohmann::json d8 = r.value("data", nlohmann::json::object());
                strikePlanId = planIdOf(d8);
                detail["planId"] = strikePlanId;
                detail["items"] = arrSize(d8, "items");
                if (code == 0 && strikePlanId.empty()) {
                    code = 1004;
                    detail["message"] = "strike.plans 没给出可用 planId → 第 9 步无从确认";
                }
                if (code == 0) {
                    // 步 8 = 采纳（P5 实测：`strike.adopt` 落步 8、`strike.confirm` 落步 9）
                    code = run(calls, "strike.adopt", {{"planId", strikePlanId}}, r);
                    detail["adopted"] = (code == 0);
                }
            }

            // ---------------------------------------------------------------- 步 9 打击确认
            if (step == 9) {
                primary = "strike.confirm";
                const std::string planId = strikePlanId.empty() ? planIdParam : strikePlanId;
                detail["planId"] = planId;
                code = run(calls, "strike.confirm", {{"planId", planId}}, r);
                bool adoptFallback = false;
                if (code == 1003) {
                    // P5 实测口径：步 9 的正确序是"**先 confirm**；回 1003 才补 adopt 并重试一次"。
                    // （反过来在步 9 直接 adopt 会把流程切回步 8。）
                    adoptFallback = true;
                    code = run(calls, "strike.adopt", {{"planId", planId}}, r);
                    if (code == 0) {
                        code = run(calls, "strike.confirm", {{"planId", planId}}, r);
                    }
                }
                detail["adoptFallback"] = adoptFallback;
                if (code == 0) {
                    code = run(calls, "guidance.plan", {{"planId", planId}}, r);
                    const nlohmann::json d9 = r.value("data", nlohmann::json::object());
                    detail["ipPointKey"] =
                        d9.value("ipPoint", nlohmann::json::object()).value("key", std::string());
                    detail["guidanceLines"] =
                        arrSize(d9.value("guidance", nlohmann::json::object()), "lines");
                }
            }

            // ---------------------------------------------------------------- 步 10 协同执行
            if (step == 10) {
                primary = "exec.run";
                if (firstTargetId.empty()) {
                    code = 1003;
                    detail["message"] = "没有已登记的**目标实体**（第 7 步没跑到或没目标）→ "
                                        "exec.run 没有 entityId（前置不满足，宿主不编一个）";
                } else {
                    code = run(calls, "exec.run", {{"entityId", firstTargetId}}, r);
                    const nlohmann::json d10 = r.value("data", nlohmann::json::object());
                    detail["entityId"] = firstTargetId;
                    detail["stateAfter"] = d10.value("stateAfter", std::string());
                    detail["hitPlatformId"] = d10.value("hitPlatformId", std::string());
                    detail["hit"] = d10.contains("dive") && d10["dive"].is_object() &&
                                    d10["dive"].contains("hit") && d10["dive"]["hit"].is_object();
                }
            }

            // ---------------------------------------------------------------- 步 11 任务总结
            if (step == 11) {
                primary = "report.generate";
                code = run(calls, "report.generate", nlohmann::json::object(), r);
                const nlohmann::json d11 = r.value("data", nlohmann::json::object());
                detail["reportNo"] = d11.value("report", nlohmann::json::object())
                                         .value("archive", nlohmann::json::object())
                                         .value("reportNo", std::string());
                detail["step"] = d11.value("step", 0);
                detail["phase"] = d11.value("phase", std::string());
                detail["dataGaps"] = arrSize(d11, "dataGaps");
            }

            cur["verb"] = primary;
            cur["code"] = code;
            cur["ms"] = wallClockMs() - s0;
            cur["calls"] = calls;
            if (!detail.empty()) cur["detail"] = detail;
            if (code != 0) {
                nlohmann::json last = calls.empty() ? nlohmann::json::object() : calls.back();
                cur["error"] = {{"message", reasonOf(r, detail)},
                                {"verb", last.value("verb", primary)},
                                {"readings", last.value("readings", nlohmann::json::object())}};
            }
            steps.push_back(cur);

            if (code != 0) {
                failedStep = step;
                failedCode = code;
                failedVerb = primary;
                failedReason = reasonOf(r, detail);
                notes.push_back("第 " + std::to_string(step) + " 步（" + primary +
                                "）失败 code=" + std::to_string(code) + " → **停在这一步**，"
                                "后面的步骤没有跑（MUST NOT 跳过或重试到成功）");
                break;
            }
        }
    } catch (const std::exception& e) {
        // 串联里任何未预期的异常都要变成**可读失败**，不许把半截回执丢掉
        failedStep = failedStep == 0 ? -1 : failedStep;
        failedCode = 1005;
        failedReason = std::string("flow.runAll 内部异常：") + e.what();
        LOG_ERROR << "[flow] flow.runAll 异常：" << e.what();
    }

    const int64_t totalMs = wallClockMs() - t0;
    nlohmann::json st = stateJson();   // 收口读数（步/阶段/仿真）
    nlohmann::json flowNow = nlohmann::json::object();
    flowNow["step"] = st.value("step", 0);
    flowNow["stepKey"] = st.value("stepKey", std::string());
    flowNow["phase"] = st.value("phase", std::string());
    flowNow["missionId"] = st.value("missionId", std::string());
    flowNow["simulation"] = st.value("simulation", nlohmann::json::object());
    if (st.contains("strike")) flowNow["strike"] = st["strike"];
    if (st.contains("exec")) flowNow["exec"] = st["exec"];
    if (st.contains("report")) flowNow["report"] = st["report"];

    const bool ok = (failedStep == 0);
    nlohmann::json summary = nlohmann::json::object();
    summary["ok"] = ok;
    summary["failedStep"] = ok ? nlohmann::json(nullptr) : nlohmann::json(failedStep);
    summary["failedVerb"] = ok ? nlohmann::json(nullptr) : nlohmann::json(failedVerb);
    summary["failedReason"] = ok ? nlohmann::json(nullptr) : nlohmann::json(failedReason);
    summary["totalMs"] = totalMs;
    summary["speed"] = speed;
    summary["from"] = from;
    summary["to"] = to;
    summary["stepsRun"] = static_cast<int>(steps.size());
    summary["reset"] = doReset;

    nlohmann::json out = nlohmann::json::object();
    out["ok"] = ok;
    out["prepare"] = prepare;
    out["steps"] = steps;
    out["speedDemos"] = speedDemos;
    out["summary"] = summary;
    out["flow"] = flowNow;
    out["warnings"] = warnings;
    notes.push_back("每一步都走 `POST /api/command` 的**同一个入口**（command(verb,params)）："
                    "与前端点按钮、与 p2–p6 自证脚本完全同一条路，MUST NOT 抄近路；"
                    "`calls[]` 是该步真的发过的每条命令（含轮询次数与引擎原话）");
    notes.push_back("回执里的 `ms` 是**实测**墙钟（含「等真实条件」的时间，例如等目标被探测登记）；"
                    "`code` 是引擎/宿主的原样裁决");
    out["notes"] = notes;
    out["source"] = "宿主流程层：11 步命令编排（不产出任何业务数值）；"
                    "倍速 ← sim.speed（引擎 setSpeed 只认 1/8/60）；"
                    "重置 ← sim.reset（重建仿真源）+ mission.reset + boot.reset";
    LOG_INFO << "[flow] flow.runAll " << (ok ? "完成" : "失败") << "：steps=" << steps.size()
             << "/" << (to - from + 1) << " failedStep=" << failedStep << " code=" << failedCode
             << " totalMs=" << totalMs << " speed=" << speed;
    return reply(verb, ok ? 0 : failedCode, out);
}

nlohmann::json FlowEngine::command(const std::string& verb, const nlohmann::json& params) {    if (verb.empty()) return badRequest(verb, "缺少 verb");

    // ---------------------------------------------------------------- 启动加载
    if (verb == "boot.run") {
        const int pacing = intOr(params, "pacingMs", 250);
        const int waitMs = intOr(params, "waitMs", 12000);
        (void)waitMs;
        if (bootComplete()) {
            nlohmann::json d = nlohmann::json::object();
            d["accepted"] = false;
            d["idempotent"] = true;
            d["reason"] = "启动加载已完成";
            return reply(verb, 0, d);
        }
        if (bootRunning_.load()) {
            nlohmann::json d = nlohmann::json::object();
            d["accepted"] = false;
            d["running"] = true;
            d["reason"] = "启动加载已在运行";
            return reply(verb, 0, d);
        }
        startBoot(pacing);
        nlohmann::json d = nlohmann::json::object();
        d["accepted"] = true;
        d["pacingMs"] = pacing;
        d["note"] = "事件走 WS：selfcheck.progress → selfcheck.ready";
        return reply(verb, 0, d);
    }

    if (verb == "boot.reset") {
#if MA_WITH_SELFCHECK
        if (!selfCheckReady_) return reply(verb, 1005, {{"message", selfCheckNote_}});
        int reloadCode = 0;
        {
            std::lock_guard<std::mutex> lk(mtx_);
            // 复位 = 回到"刚装配好"的状态：**重装规则包**（引擎语义：重装会清掉上一次的
            // 报告 / 历史 / 求值缓存），再复位进度源。这样第 2 步界面如实回到"尚未执行自检"，
            // 而不是残留上一轮的结论。
            if (!cfg_.selfcheckPolicies.empty()) {
                const selfcheck::LoadResult lr =
                    engines_.selfCheckEngine->loadPoliciesFile(cfg_.selfcheckPolicies);
                reloadCode = lr.code;
            }
            engines_.selfCheckEngine->resetProgress();
            hasReport_ = false;
            lastReport_ = selfcheck::Report{};
            lastBoot_ = nlohmann::json::object();
            resetMissionLocked();   // 见下方：复位任务与阶段（否则再进任务会沿用旧阶段）
        }
        broadcastFlowState();
        if (reloadCode != 0) {
            return reply(verb, reloadCode,
                         {{"message", "规则包重装失败（引擎已保留上一次成功装载的规则）"}});
        }
#else
        {
            std::lock_guard<std::mutex> lk(mtx_);
            resetMissionLocked();
        }
        broadcastFlowState();
#endif
        nlohmann::json d = nlohmann::json::object();
        d["reset"] = true;
        d["note"] = "已复位到第 1 步：任务与阶段清空（下次 flow.enter 会建**新任务**）、"
                    "自检报告清空、启动进度归零";
        return reply(verb, 0, d);
    }

    // ---------------------------------------------------------------- 全流程复位（P7 一键重跑用）
    if (verb == "mission.reset") {
        // 与 `boot.reset` 的区别：这里**只动任务状态**，不碰自检/启动进度（用于"再来一遍任务"）。
        // 语义：清空当前任务与阶段 + 已采纳/已确认方案 → 回第 1 步。
        // 台账/实体按 missionId 隔离，所以新任务天然是干净的一份（MUST NOT 去删旧任务的数据）。
        {
            std::lock_guard<std::mutex> lk(mtx_);
            resetMissionLocked();
        }
        broadcastFlowState();
        nlohmann::json d = nlohmann::json::object();
        d["reset"] = true;
        d["step"] = step_;
        d["note"] = "任务与阶段已清空（台账/实体按 missionId 隔离，旧任务数据保留）";
        return reply(verb, 0, d);
    }

    // ---------------------------------------------------------------- 自检
    if (verb == "selfcheck.run") {
#if MA_WITH_SELFCHECK
        if (!selfCheckReady_) return reply(verb, 1005, {{"message", selfCheckNote_}});
        const bool bypass = params.value("bypassCache", true);
        const selfcheck::Report rep = runSelfCheck(bypass, {}, false);
        storeReport(rep);
        return reply(verb, 0, rep.toJson());
#else
        return reply(verb, 1005, {{"message", "selfcheck 未装配"}});
#endif
    }

    if (verb == "selfcheck.recheck") {
#if MA_WITH_SELFCHECK
        if (!selfCheckReady_) return reply(verb, 1005, {{"message", selfCheckNote_}});
        const auto keys = params.value("keys", std::vector<std::string>{});
        if (keys.empty()) {
            const selfcheck::Report rep = runSelfCheck(true, {}, false);
            storeReport(rep);
            return reply(verb, 0, rep.toJson());
        }
        selfcheck::Report last{};
        std::vector<std::string> done;
        for (const auto& k : keys) {
            last = runSelfCheck(true, {k}, false);
            storeReport(last);
            done.push_back(k);
        }
        nlohmann::json d = last.toJson();
        d["rechecked"] = done;
        return reply(verb, 0, d);
#else
        return reply(verb, 1005, {{"message", "selfcheck 未装配"}});
#endif
    }

    if (verb == "selfcheck.report") {
#if MA_WITH_SELFCHECK
        if (!selfCheckReady_) return reply(verb, 1005, {{"message", selfCheckNote_}});
        std::lock_guard<std::mutex> lk(mtx_);
        return reply(verb, 0, engines_.selfCheckEngine->reportJson());
#else
        return reply(verb, 1005, {{"message", "selfcheck 未装配"}});
#endif
    }

    if (verb == "selfcheck.history") {
#if MA_WITH_SELFCHECK
        if (!selfCheckReady_) return reply(verb, 1005, {{"message", selfCheckNote_}});
        std::lock_guard<std::mutex> lk(mtx_);
        nlohmann::json d = nlohmann::json::object();
        d["history"] = engines_.selfCheckEngine->historyJson();
        d["count"] = static_cast<int>(engines_.selfCheckEngine->historyCount());
        return reply(verb, 0, d);
#else
        return reply(verb, 1005, {{"message", "selfcheck 未装配"}});
#endif
    }

    if (verb == "selfcheck.purity") {
#if MA_WITH_SELFCHECK
        if (!selfCheckReady_) return reply(verb, 1005, {{"message", selfCheckNote_}});
        std::lock_guard<std::mutex> lk(mtx_);
        return reply(verb, 0, engines_.selfCheckEngine->checkPurity({}, 2).toJson());
#else
        return reply(verb, 1005, {{"message", "selfcheck 未装配"}});
#endif
    }

    if (verb == "capabilities.refresh") {
        refreshCapabilities();
        nlohmann::json d = nlohmann::json::object();
        d["refreshed"] = true;
        return reply(verb, 0, d);
    }

    // ---------------------------------------------------------------- 流程推进
    if (verb == "flow.enter") {
        // 【引擎】phase::PhaseEngine::createMission(const CreateMissionInput&)（公开头 phase_engine.h:568）
        //        + phase::PhaseEngine::advance(const AdvanceRequest&)（公开头 :577，显式进 T0）
        //
        // 入参怎么构造：`name` / `scenarioKey` 取自 scenario-data 的**真实场景数据**
        // （`scenarioData.mission.name`、`scenarioData.scenarioKey` = 场景目录名，见
        // scenario_dataset.h:172）；两者任缺时回落"配置里那个场景目录的目录名"——它就是这个
        // 约定的取值来源，不是我编的字符串。引擎要求两者非空，否则 1000。
        //
        // 幂等：已有任务 → **不重复 createMission**（每次都会造新 missionId），只回执现状。
#if MA_WITH_PHASE
        if (!engines_.phase) {
            return reply(verb, 1005, {{"message", "phase-engine 未装配（编译期 MA_WITH_PHASE=0）"}});
        }
        nlohmann::json d = nlohmann::json::object();
        int code = 0;
        bool changed = false;
        {
            std::lock_guard<std::mutex> lk(mtx_);
            std::string scene = params.value("scenarioKey", std::string());
            if (scene.empty()) scene = scenarioKeyOf(engines_);
            if (scene.empty()) {
                const std::filesystem::path p(cfg_.resolveScenarioDir());
                scene = p.filename().string();
            }
            std::string name = params.value("name", std::string());
#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST
            if (name.empty()) name = engines_.scenarioData.mission.name;
#endif
            if (name.empty()) name = scene;

            if (!missionId_.empty()) {
                // 已经有任务：**幂等**（引擎不重复 createMission），阶段一律以引擎台账为准 ——
                // 这里 MUST NOT 硬写 "T0"：引擎可能早就走到 T1/T2 了，谎报阶段会让前端切错屏。
                const PhaseView v = phaseViewLocked();
                if (!v.phaseKey.empty()) phase_ = v.phaseKey;
                const int s = stepForPhase(phase_);
                if (s > 0) step_ = s;  // 落屏到"当前阶段对应的那一步"
                if (v.enteredAt != 0) enteredAtMs_ = v.enteredAt;
                changed = true;
                d["step"] = step_;
                d["phase"] = phase_;
                d["missionId"] = missionId_;
                d["scenarioKey"] = v.scenarioKey;
                d["enteredAt"] = enteredAtMs_;
                d["idempotent"] = true;
                d["note"] = "任务已存在（flow.enter 幂等：不重复建任务）；阶段以引擎台账为准，推进用 mission.advance";
            } else if (name.empty() || scene.empty()) {
                code = 1003;
                d["message"] = "建任务缺少 name/scenarioKey（scenario-data 未装配？用 --scenario 指定场景目录）";
            } else {
                phase::CreateMissionInput in;
                in.name = name;
                in.scenarioKey = scene;
                in.type = params.value("type", std::string());
                in.area = params.value("area", std::string());
                in.operatorId = params.value("operatorId", std::string("host"));
                const phase::CreateResult cr = engines_.phase->createMission(in);
                if (cr.code != 0) {
                    code = cr.code;
                    d["message"] = cr.message;
                } else {
                    missionId_ = cr.data.id;
                    // **任务下达时刻**（时间轴 t0 的锚点）：建任务成功这一刻。
                    // 与 enteredAtMs_（当前阶段进入时刻）分开存 —— 后者每推进一个阶段都会变。
                    missionStartMs_ = wallClockMs();
                    // 步 7（P4）：探测结果的落账任务 = 引擎刚给的 missionId（同一个来源，
                    // 宿主不自己拼 id）。线程：见 onDetection。
                    {
                        std::lock_guard<std::mutex> dl(detectMtx_);
                        detectMissionId_ = missionId_;
                    }
                    // ② 进 T0：显式调 advance（create 已落在唯一起始阶段 T0 → 引擎回
                    //    AlreadyThere + idempotent=true，零副作用；这里要的是**回执**，
                    //    不是"再进一次"）。
                    phase::AdvanceRequest ar;
                    ar.missionId = missionId_;
                    ar.to = "T0";
                    ar.reason = "host:flow.enter";
                    ar.operatorId = in.operatorId;
                    const phase::TransitionResult tr = engines_.phase->advance(ar);
                    const PhaseView v = phaseViewLocked();
                    phase_ = v.phaseKey.empty() ? std::string("T0") : v.phaseKey;
                    step_ = 3;
                    enteredAtMs_ = v.enteredAt != 0 ? v.enteredAt : wallClockMs();
                    changed = true;
                    code = tr.code;
                    d["step"] = step_;
                    d["phase"] = phase_;
                    d["missionId"] = missionId_;
                    d["missionName"] = name;
                    d["scenarioKey"] = scene;
                    d["enteredAt"] = enteredAtMs_;
                    d["create"] = cr.toJson();        // 引擎负载原样
                    d["transition"] = tr.dataJson();  // 引擎负载原样（含 skippedGates/unmet）
                    if (tr.idempotent) d["idempotent"] = true;
                }
            }
        }
        if (changed) broadcastFlowState();
        return reply(verb, code, d);
#else
        // 没装配 phase-engine：只把宿主流程状态推到"第 3 步 + T0"，并如实标注（不假装引擎给过）。
        {
            std::lock_guard<std::mutex> lk(mtx_);
            step_ = 3;
            phase_ = "T0";
            enteredAtMs_ = wallClockMs();
            if (missionId_.empty()) missionId_ = "mission-" + std::to_string(enteredAtMs_);
        }
        broadcastFlowState();
        nlohmann::json d = nlohmann::json::object();
        d["step"] = step_;
        d["phase"] = phase_;
        d["missionId"] = missionId_;
        d["note"] = "phase-engine 未装配：阶段由宿主流程层代理（无引擎回执）";
        return reply(verb, 0, d);
#endif
    }

    // ---------------------------------------------------------------- 步 3：任务态势
    if (verb == "mission.advance") {
        // 【引擎】phase::PhaseEngine::advance(const AdvanceRequest&)（公开头 phase_engine.h:577）
        //   入参：missionId（宿主台账里的当前任务）、to（T0..T7，取值由规则包 phases.json 定义）、
        //         force、reason/operatorId。判据（Gate）与拒绝语义全在引擎里 —— 宿主只转发。
        //   回执：`TransitionResult::dataJson()` 原样（内含 status/unmet/skippedGates/state）。
        const std::string to = params.value("to", std::string());
        if (to.empty()) return badRequest(verb, "缺少 to（T0..T7）");
#if MA_WITH_PHASE
        if (!engines_.phase) {
            return reply(verb, 1005, {{"message", "phase-engine 未装配（编译期 MA_WITH_PHASE=0）"}});
        }
        nlohmann::json d = nlohmann::json::object();
        int code = 0;
        bool moved = false;
        bool simAuto = false;
        {
            std::lock_guard<std::mutex> lk(mtx_);
            if (missionId_.empty()) {
                return reply(verb, 1003,
                             {{"message", "尚未进入任务：先 flow.enter（它会 createMission + 进 T0）"}});
            }
            phase::AdvanceRequest req;
            req.missionId = missionId_;
            req.to = to;
            req.expectFrom = params.value("expectFrom", std::string());
            req.reason = params.value("reason", std::string("host:mission.advance"));
            req.operatorId = params.value("operatorId", std::string("host"));
            req.force = params.value("force", false);
            req.definitionVersion = params.value("definitionVersion", std::string());
            const phase::TransitionResult tr = engines_.phase->advance(req);
            code = tr.code;
            d = tr.dataJson();
            if (tr.idempotent) d["idempotent"] = true;
            if (tr.code == 0) {
                const PhaseView v = phaseViewLocked();
                phase_ = v.phaseKey.empty() ? to : v.phaseKey;
                enteredAtMs_ = v.enteredAt != 0 ? v.enteredAt : enteredAtMs_;
                const int s = stepForPhase(phase_);
                if (s > 0) step_ = s;
                moved = true;
                // 宿主侧的流程读数也一并回执（前端切屏要它；引擎负载里没有这两个键）
                d["step"] = step_;
                d["stepKey"] = flowStepOf(step_) ? flowStepOf(step_)->key : "";
                d["phase"] = phase_;
                d["missionId"] = missionId_;
#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST
                // 演示叙事：**"起飞"发生在步 6（任务执行）**，不是开机。
                // 流程进入步 6（phase T2/T3）→ 宿主自动调 sim.start（幂等：已跑就命中）。
                if (s == 6) {
                    d["simAutoStart"] = autoStartSimLocked();
                    d["simNote"] = "已自动起飞：进入步 6（任务执行）时宿主调 Driver::primeNow + start；"
                                   "手动控制仍走 sim.start/sim.pause/sim.resume/sim.speed/sim.step";
                    simAuto = true;
                }
#endif
            }
        }
        if (moved) broadcastFlowState();
        if (simAuto) broadcastSimState();
        return reply(verb, code, d);
#else
        return reply(verb, 1005, {{"message", "phase-engine 未装配（编译期 MA_WITH_PHASE=0）"}});
#endif
    }

    // ---------------------------------------------------------------- 步 3：静态态势
    if (verb == "situation.snapshot") {
        // 【数据源】scenario-data 的本地配置（`ScenarioData`，scenario_dataset.h:170-218）：
        //   areas    ← task-areas.json 的 areas[] + deployment.json 的 areas[]（标 areaKind 区分）
        //   zones    ← airspace.json 的 zones[]（kind=no-fly/threat/geofence/corridor；通道就是 corridor）
        //   platforms/groups/targets ← deployment.json 与 targets.json
        // 【systemOverview】← selfcheck 最近一次报告的 `overview` 项（与 /api/state 同一份口径）
        nlohmann::json d = nlohmann::json::object();
        nlohmann::json areas = nlohmann::json::array();
        nlohmann::json zones = nlohmann::json::array();
        nlohmann::json platforms = nlohmann::json::array();
        nlohmann::json groups = nlohmann::json::array();
        nlohmann::json targets = nlohmann::json::array();
        nlohmann::json notes = nlohmann::json::array();
        {
            std::lock_guard<std::mutex> lk(mtx_);
#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST
            const auto& sd = engines_.scenarioData;
            d["scenarioKey"] = sd.scenarioKey;
            d["scenarioDir"] = sd.dir;
            d["schemaVersion"] = sd.schemaVersion;
            d["wireType"] = sd.wireType;
            if (sd.hasMission) {
                d["mission"] = {{"name", sd.mission.name},
                                {"type", sd.mission.type},
                                {"region", sd.mission.region},
                                {"startAt", sd.mission.startAt},
                                {"timeRequirement", sd.mission.timeRequirement}};
            }
            if (sd.hasCenter) d["center"] = {sd.center.first, sd.center.second};
            d["zoom"] = sd.zoom;
            d["minZoom"] = sd.minZoom;
            d["maxZoom"] = sd.maxZoom;

            auto ring = [](const std::vector<std::pair<double, double>>& poly) {
                nlohmann::json arr = nlohmann::json::array();
                for (const auto& p : poly) arr.push_back({p.first, p.second});
                return arr;
            };
            for (const auto& a : sd.taskAreas) {
                areas.push_back({{"key", a.key},
                                 {"name", a.name},
                                 {"role", a.role},
                                 {"color", a.color},
                                 {"areaKind", "task"},
                                 {"polygon", ring(a.polygon)}});
            }
            for (const auto& a : sd.deployAreas) {
                nlohmann::json row = {{"key", a.key},
                                      {"name", a.name},
                                      {"role", a.role},
                                      {"areaKind", "deploy"},
                                      {"polygon", ring(a.polygon)}};
                if (a.position.has_value()) row["position"] = {a.position->first, a.position->second};
                areas.push_back(std::move(row));
            }
            for (const auto& z : sd.zones) {
                zones.push_back({{"key", z.key},
                                 {"name", z.name},
                                 {"kind", z.kind},
                                 {"hardness", z.hardness},
                                 {"level", z.level},
                                 {"action", z.action},
                                 {"color", z.color},
                                 {"dashed", z.dashed},
                                 {"widthM", z.widthM},
                                 {"polygon", ring(z.polygon)},
                                 {"line", ring(z.line)}});
            }
            for (const auto& g : sd.groups) {
                int n = 0;
                for (const auto& a : sd.aircraft) {
                    if (a.groupKey == g.key) ++n;
                }
                groups.push_back({{"key", g.key},
                                  {"name", g.name},
                                  {"role", g.role},
                                  {"groupId", sd.groupIdOf(g.key)},
                                  {"platformCount", n}});
            }
            for (const auto& a : sd.aircraft) {
                std::string groupName;
                for (const auto& g : sd.groups) {
                    if (g.key == a.groupKey) groupName = g.name;
                }
                platforms.push_back({{"deviceId", a.deviceId},
                                     {"typeKey", a.typeKey},
                                     {"groupKey", a.groupKey},
                                     {"groupName", groupName},
                                     {"homeArea", a.homeArea},
                                     {"taskArea", a.taskArea},
                                     {"lng", a.stationLng},
                                     {"lat", a.stationLat},
                                     {"altM", a.altM},
                                     {"speedMps", a.speedMps},
                                     {"battery", a.battery},
                                     {"payload", a.payload}});
            }
            for (const auto& t : sd.targets) {
                nlohmann::json row = {{"no", t.no},
                                      {"id", t.id},
                                      {"typeKey", t.typeKey},
                                      {"name", t.name},
                                      {"motion", t.motion},
                                      {"route", ring(t.route)},
                                      {"speedMps", t.speedMps},
                                      {"loop", t.loop},
                                      {"startOffsetMs", t.startOffsetMs},
                                      {"confidence", t.confidence},
                                      {"features", t.features},
                                      {"threat", t.threat},
                                      {"valueTag", t.valueTag}};
                if (t.position.has_value()) row["position"] = {t.position->first, t.position->second};
                targets.push_back(std::move(row));
            }
            notes.push_back("areas/zones/platforms/groups/targets 全部来自 scenario-data 的本地配置"
                            "（task-areas / airspace / deployment / targets），宿主不做任何数值加工");
#else
            notes.push_back("场景数据未装配（sim-source/接入层未编译进来）：区域/空域/平台清单为空");
#endif
        }
        d["areas"] = std::move(areas);
        d["zones"] = std::move(zones);
        d["platforms"] = std::move(platforms);
        d["groups"] = std::move(groups);
        d["targets"] = std::move(targets);

        // systemOverview：复用 selfcheck 的最近一次报告（`report()` 自己取锁 → 不在这把锁里调）
        nlohmann::json overview = nlohmann::json::array();
#if MA_WITH_SELFCHECK
        if (selfCheckReady_) {
            const selfcheck::Report& rep = report(true);
            overview = itemsJson(rep.overview);
            d["overviewSource"] = "selfcheck::Report.overview（最近一次自检；规则包 overview 段）";
        } else {
            notes.push_back("systemOverview 为空：" + selfCheckNote_);
        }
#else
        notes.push_back("systemOverview 为空：selfcheck 未装配");
#endif
        d["overview"] = std::move(overview);
        d["notes"] = std::move(notes);
        return reply(verb, 0, d);
    }

    // ---------------------------------------------------------------- 步 3：态势组图
    if (verb == "view.compose") {
        // 【引擎】view_composer::ViewComposer::composeJson(const PhaseContext&, userHiddenGroups,
        //   userHiddenTools, userHiddenControls, entitySnapshot)（公开头 view_composer.h:730-734）
        //   入参构造：① 阶段五字段 ← phase-engine 的 `phaseContext()` → **同形五字段**映射
        //              （两仓刻意不互相 include，映射必须由宿主写，见 D.1 第 4 条）；
        //            ② entitySnapshot ← entity-ledger 的只读 `ledgerSnapshot(missionId)`（空 = 引擎放弃校验）；
        //            ③ modeKey → 先 `setModeOverride`（未知 key → 引擎 1004，原样回执）。
        //   回执：引擎的 JSON **原样**（`view_composer::json` = ordered_json，键序稳定可逐字节比对）。
#if MA_WITH_VIEW_COMPOSER
        if (!engines_.viewComposer) {
            return reply(verb, 1005, {{"message", "view-composer 未装配（编译期 MA_WITH_VIEW_COMPOSER=0）"}});
        }
        const std::vector<std::string> hiddenGroups =
            params.value("hiddenGroups", std::vector<std::string>{});
        const std::vector<std::string> hiddenTools =
            params.value("hiddenTools", std::vector<std::string>{});
        const std::string modeKey = params.value("modeKey", std::string());
        std::lock_guard<std::mutex> lk(mtx_);
        const PhaseView v = phaseViewLocked();
        const view_composer::PhaseContext vc =
            toViewPhaseContext(v.phaseKey, v.seq, v.scenarioKey, v.enteredAt, v.missionId);
        if (!modeKey.empty()) {
            const view_composer::ModeResolution mr = engines_.viewComposer->setModeOverride(vc, modeKey);
            if (!mr.ok) {
                return reply(verb, 1004, {{"message", mr.reason}, {"modeKey", modeKey}});
            }
        }
        const view_composer::json vcSnap = view_composer::json::parse(ledgerSnapshotLocked().dump());
        const view_composer::json composed =
            engines_.viewComposer->composeJson(vc, hiddenGroups, hiddenTools, {}, vcSnap);
        return reply(verb, 0, nlohmann::json::parse(composed.dump()));
#else
        return reply(verb, 1005, {{"message", "view-composer 未装配（编译期 MA_WITH_VIEW_COMPOSER=0）"}});
#endif
    }

    if (verb == "view.mode") {
        // 【引擎】view_composer::ViewComposer::setModeOverride / clearModeOverride
        //   （公开头 view_composer.h:656 / :658）—— 手动覆盖显示模式（三态可查：modeState）。
        //   `{modeKey}` 指定 / `{clear:true}` 解除；未声明组合回落"未指定"而不报错。
#if MA_WITH_VIEW_COMPOSER
        if (!engines_.viewComposer) {
            return reply(verb, 1005, {{"message", "view-composer 未装配（编译期 MA_WITH_VIEW_COMPOSER=0）"}});
        }
        const std::string modeKey = params.value("modeKey", std::string());
        const bool clear = params.value("clear", false);
        std::lock_guard<std::mutex> lk(mtx_);
        const PhaseView v = phaseViewLocked();
        const view_composer::PhaseContext vc =
            toViewPhaseContext(v.phaseKey, v.seq, v.scenarioKey, v.enteredAt, v.missionId);
        const view_composer::ModeResolution mr =
            clear ? engines_.viewComposer->clearModeOverride(vc)
                  : engines_.viewComposer->setModeOverride(vc, modeKey);
        nlohmann::json d = nlohmann::json::parse(view_composer::toJson(mr).dump());
        if (!mr.ok) return reply(verb, 1004, d);
        return reply(verb, 0, d);
#else
        return reply(verb, 1005, {{"message", "view-composer 未装配（编译期 MA_WITH_VIEW_COMPOSER=0）"}});
#endif
    }

    // ---------------------------------------------------------------- 步 4：库存台账
    if (verb == "alloc.inventory") {
        // 【引擎】resource_alloc::ResourceEngine::initializeLedger(targetId, scenarioKey)
        //   （公开头 resource_alloc.h:645；基线取值来自规则包 deviceTypes.json 的 baselines 段）
        //        + ResourceEngine::statsJson(targetId)（公开头 :671，目标不存在 → nullopt）
        //   幂等由宿主守住：台账已存在就**不重建**（引擎的 initializeLedger 会清零已分配量）。
#if MA_WITH_RESOURCE
        if (!engines_.resource) {
            return reply(verb, 1005, {{"message", "resource-alloc 未装配（编译期 MA_WITH_RESOURCE=0）"}});
        }
        std::lock_guard<std::mutex> lk(mtx_);
        const std::string targetId =
            params.value("targetId", missionId_.empty() ? std::string() : missionId_);
        if (targetId.empty()) {
            return reply(verb, 1003, {{"message", "尚未进入任务：先 flow.enter（台账按任务隔离）"}});
        }
        const std::string scene = scenarioKeyOf(engines_);
        const LedgerInit init = ensureLedger(engines_, targetId, scene);
        if (init.code != 0) {
            return reply(verb, init.code, {{"message", init.message}, {"targetId", targetId}});
        }
        const std::optional<resource_alloc::json> stats = engines_.resource->statsJson(targetId);
        if (!stats.has_value()) {
            return reply(verb, 1004, {{"message", "台账不存在：" + targetId}});
        }
        nlohmann::json d = nlohmann::json::parse(stats->dump());
        d["idempotent"] = !init.created;
        d["ledgerInit"] = {{"targetId", targetId},
                           {"scenarioKey", scene},
                           {"created", init.created},
                           {"code", init.code},
                           {"message", init.message}};
        return reply(verb, 0, d);
#else
        return reply(verb, 1005, {{"message", "resource-alloc 未装配（编译期 MA_WITH_RESOURCE=0）"}});
#endif
    }

    // ---------------------------------------------------------------- 步 4：编组三方案
    if (verb == "alloc.plans") {
        // 【引擎】scoring::ScoringEngine::generateCandidates(const CandidateRequest&)（scoring.h:822）
        //        + scoring::ScoringEngine::score(const CandidateRequest&)（scoring.h:824）
        //   入参：side（默认 "group"）、scene = 场景键、snapshot = **真填**的 ScoringSnapshot
        //        （集群用量 ← 台账 statsJson().clusters[] 或场景编制；利用率 ← 台账实测；
        //          链路评估/目标清单拿不到 → 留空并在 notes 里点名，MUST NOT 编造）
        //   回执：候选与评分**原样**（Candidate::toJson / CandidateScore::toJson），
        //        外加推荐 id / 推荐百分比 / 理由 / 领先值 —— 全部来自 ScoreResult。
#if MA_WITH_SCORING && MA_WITH_RESOURCE
        if (!engines_.scoringEngine) {
            return reply(verb, 1005, {{"message", "scoring 未装配（编译期 MA_WITH_SCORING=0）"}});
        }
        const std::string side = params.value("side", std::string("group"));
        const int want = intOr(params, "count", 3);
        std::lock_guard<std::mutex> lk(mtx_);
        if (missionId_.empty()) {
            return reply(verb, 1003, {{"message", "尚未进入任务：先 flow.enter（台账/评分按任务隔离）"}});
        }
        const std::string targetId = missionId_;
        std::string scene = params.value("scene", std::string());
        if (scene.empty()) scene = scenarioKeyOf(engines_);
        const LedgerInit init = ensureLedger(engines_, targetId, scene);
        if (init.code != 0) {
            return reply(verb, init.code, {{"message", init.message}, {"targetId", targetId}});
        }
        nlohmann::json notes = nlohmann::json::array();
        notes.push_back(std::string("台账：") + (init.created ? "本次初始化（" : "已存在，未重建（") +
                        init.message + "）");

        const PhaseView v = phaseViewLocked();
        const scoring::PhaseContext pc =
            toScoringPhaseContext(v.phaseKey, v.seq, scene, v.enteredAt, targetId);
        scoring::CandidateRequest req;
        req.missionId = targetId;
        req.phase = pc;
        req.side = side;
        req.scene = scene;
        req.includeInapplicable = true;  // SCD-CAND-02：不适用 MUST 标注而非静默丢弃
        req.dedupe = true;               // SCD-CAND-04：内容等价的候选合并并标注
        req.snapshot = buildSnapshot(engines_, targetId, pc, scene, notes);

        const std::vector<scoring::Candidate> cands = engines_.scoringEngine->generateCandidates(req);
        const scoring::ScoreResult sr = engines_.scoringEngine->score(req);
        if (sr.code != 0) {
            return reply(verb, sr.code,
                         {{"message", sr.message}, {"notes", notes}, {"scene", scene}, {"side", side}});
        }

        nlohmann::json items = nlohmann::json::array();
        int taken = 0;
        for (const auto& cs : sr.candidates) {
            if (taken >= want) break;
            items.push_back({{"candidate", nlohmann::json::parse(cs.candidate.toJson().dump())},
                             {"score", nlohmann::json::parse(cs.toJson().dump())}});
            ++taken;
        }
        nlohmann::json candidatesRaw = nlohmann::json::array();
        for (const auto& c : cands) candidatesRaw.push_back(nlohmann::json::parse(c.toJson().dump()));
        nlohmann::json reasons = nlohmann::json::array();
        for (const auto& rs : sr.reasons) reasons.push_back(nlohmann::json::parse(rs.toJson().dump()));
        nlohmann::json missing = nlohmann::json::array();
        for (const auto& m : sr.missingInputs) missing.push_back(m);

        // 本次真填进去的快照摘要（可复核"哪些字段是空的、空在哪"）
        nlohmann::json snapJson = nlohmann::json::object();
        {
            nlohmann::json rj = nlohmann::json::object();
            rj["present"] = req.snapshot.resources.has_value() && req.snapshot.resources->present;
            nlohmann::json cl = nlohmann::json::array();
            if (req.snapshot.resources.has_value()) {
                for (const auto& c : req.snapshot.resources->clusters) {
                    cl.push_back({{"clusterId", c.clusterId},
                                  {"phaseKey", c.phaseKey},
                                  {"total", c.total},
                                  {"available", c.available},
                                  {"present", c.present}});
                }
            }
            rj["clusters"] = cl;
            snapJson["resources"] = rj;
            snapJson["topology"] = {{"present", false}, {"note", "未填（链路评估腿未接）"}};
            snapJson["targets"] = {{"present", req.snapshot.targets.has_value()},
                                   {"note", req.snapshot.targets.has_value()
                                                ? "来自 entity-ledger 台账快照"
                                                : "未填（台账为空）"}};
            snapJson["resourceUtilization"] = req.snapshot.resourceUtilization;
            snapJson["hasResourceUtilization"] = req.snapshot.hasResourceUtilization;
            snapJson["missionId"] = req.snapshot.missionId;
            snapJson["phase"] = {{"phaseKey", pc.phaseKey}, {"seq", pc.seq}, {"scenarioKey", pc.scenarioKey}};
        }

        nlohmann::json d = nlohmann::json::object();
        d["side"] = side;
        d["scene"] = sr.scene.empty() ? scene : sr.scene;
        d["missionId"] = targetId;
        d["count"] = taken;
        d["requestedCount"] = want;
        d["items"] = std::move(items);              // 候选 + 评分（原样）
        d["candidates"] = std::move(candidatesRaw);  // generateCandidates 的原样输出
        d["recommendedId"] = sr.recommendedId;
        d["hasRecommended"] = sr.hasRecommended;
        d["recommendedPercent"] = sr.recommendedPercent;
        d["nextId"] = sr.nextId;
        d["nextPercent"] = sr.nextPercent;
        d["leadOverNext"] = sr.leadOverNext;
        d["leadOverNextPercent"] = sr.leadOverNextPercent;
        d["reasons"] = std::move(reasons);
        d["missingInputs"] = std::move(missing);
        d["snapshot"] = std::move(snapJson);
        d["metricsDigest"] = sr.metricsDigest;
        d["templatesDigest"] = sr.templatesDigest;
        d["auditDigest"] = sr.auditDigest;
        d["notes"] = std::move(notes);
        if (sr.hasRecommended) {
            hasPlanScore_ = true;
            lastPlanRecommendation_ = sr.recommendedId;
            lastPlanRecommendedPercent_ = sr.recommendedPercent;
        }
        return reply(verb, 0, d);
#else
        return reply(verb, 1005, {{"message", "scoring/resource-alloc 未装配（编译期开关关闭）"}});
#endif
    }

    // ---------------------------------------------------------------- 步 5：采纳 / 确认
    if (verb == "alloc.adopt" || verb == "alloc.confirm") {
        // 【引擎】scoring::ScoringEngine::adopt(const AdoptRequest&)（scoring.h:834）
        //        / scoring::ScoringEngine::confirm(const ConfirmRequest&)（scoring.h:836）
        //   前置策略在规则包 `confirmPrecondition`（未采纳直接确认 → 1003）；
        //   同侧互斥、幂等（code=0 + idempotent）、非推荐方案的 deviated 标注全由引擎裁决。
        //   回执：`DecideResult::dataJson()` 原样（`event` 字段就是 `plan.state` 的负载，
        //         广播由 adapters.cc 的 PlanSink 做，宿主不重复广播）。
#if MA_WITH_SCORING
        if (!engines_.scoringEngine) {
            return reply(verb, 1005, {{"message", "scoring 未装配（编译期 MA_WITH_SCORING=0）"}});
        }
        const std::string planId = params.value("planId", std::string());
        if (planId.empty()) return badRequest(verb, "缺少 planId");
        const std::string side = params.value("side", std::string("group"));
        nlohmann::json d = nlohmann::json::object();
        int code = 0;
        bool stepChanged = false;
        {
            std::lock_guard<std::mutex> lk(mtx_);
            if (missionId_.empty()) {
                return reply(verb, 1003, {{"message", "尚未进入任务：先 flow.enter"}});
            }
            const std::string scene = scenarioKeyOf(engines_);
            const PhaseView v = phaseViewLocked();
            const scoring::PhaseContext pc =
                toScoringPhaseContext(v.phaseKey, v.seq, scene, v.enteredAt, missionId_);
            if (verb == "alloc.adopt") {
                scoring::AdoptRequest req;
                req.missionId = missionId_;
                req.phase = pc;
                req.planId = planId;
                req.side = side;
                req.operatorId = params.value("operatorId", std::string("host"));
                req.reason = params.value("reason", std::string("host:alloc.adopt"));
                req.hasRecommendedContext = hasPlanScore_;
                req.recommendedId = lastPlanRecommendation_;
                req.recommendedPercent = lastPlanRecommendedPercent_;
                req.planPercent = (planId == lastPlanRecommendation_) ? lastPlanRecommendedPercent_ : 0;
#if MA_WITH_RESOURCE
                {
                    nlohmann::json notes = nlohmann::json::array();
                    req.snapshot = buildSnapshot(engines_, missionId_, pc, scene, notes);
                }
#endif
                const scoring::DecideResult res = engines_.scoringEngine->adopt(req);
                code = res.code;
                d = nlohmann::json::parse(res.dataJson().dump());
                if (res.idempotent) d["idempotent"] = true;
                if (res.code == 0) {
                    adoptedPlanId_ = planId;
                    if (step_ < 4) {
                        step_ = 4;  // 步 4 = 编组方案（采纳发生在这一步的卡片上）
                        stepChanged = true;
                    }
                }
            } else {
                scoring::ConfirmRequest req;
                req.missionId = missionId_;
                req.phase = pc;
                req.planId = planId;
                req.side = side;
                req.operatorId = params.value("operatorId", std::string("host"));
                req.reason = params.value("reason", std::string("host:alloc.confirm"));
                const scoring::DecideResult res = engines_.scoringEngine->confirm(req);
                code = res.code;
                d = nlohmann::json::parse(res.dataJson().dump());
                if (res.idempotent) d["idempotent"] = true;
                if (res.code == 0) {
                    confirmedPlanId_ = planId;
                    if (step_ < 5) {
                        step_ = 5;  // 步 5 = 编组确认
                        stepChanged = true;
                    }
                }
            }
        }
        if (stepChanged) broadcastFlowState();
        return reply(verb, code, d);
#else
        return reply(verb, 1005, {{"message", "scoring 未装配（编译期 MA_WITH_SCORING=0）"}});
#endif
    }

    // ---------------------------------------------------------------- 步 5：执行编组（编成实体）
    if (verb == "alloc.assign") {
        // 【引擎】① resource_alloc::ResourceEngine::assignAllocation(const AssignRequest&)
        //           （公开头 resource_alloc.h:657；原子：全成功或全不生效）
        //        ② entity_ledger::EntityLedger::registerEntity(const RegisterInput&)
        //           （公开头 entity_ledger.h:1233；编成实体）
        //   入参怎么构造：
        //     · 方案内容（集群清单）← scoring::generateCandidates(onlyTemplateKeys={planId})（scoring.h:822）
        //     · clusterId = **场景编组 key**（deployment.json groups[].key；CTR-PL-08 禁止拿显示名当 key）
        //     · allocation = 逐型号量：该集群下**真实平台**按型号计数（平台来自 deployment.json）
        //     · reason = planId（透传进 resource.allocation.changed，便于审计）
        //     · 实体入参：typeKey = 平台型号 key、obsKey = deviceId、坐标 = 场景站位、confidence=1.0
        //       （场景配置即权威来源，不是估计值）；其余进 attributes。
#if MA_WITH_RESOURCE && MA_WITH_SCORING
        const std::string planId = params.value("planId", std::string());
        if (planId.empty()) return badRequest(verb, "缺少 planId");
        std::lock_guard<std::mutex> lk(mtx_);
        if (missionId_.empty()) {
            return reply(verb, 1003, {{"message", "尚未进入任务：先 flow.enter"}});
        }
        if (adoptedPlanId_ != planId && confirmedPlanId_ != planId) {
            return reply(verb, 1003,
                         {{"message", "编组前置未满足：先 alloc.adopt → alloc.confirm"},
                          {"planId", planId},
                          {"adopted", adoptedPlanId_},
                          {"confirmed", confirmedPlanId_}});
        }
        const std::string targetId = missionId_;
        const std::string scene = scenarioKeyOf(engines_);
        const LedgerInit init = ensureLedger(engines_, targetId, scene);
        if (init.code != 0) {
            return reply(verb, init.code, {{"message", init.message}, {"targetId", targetId}});
        }
        nlohmann::json notes = nlohmann::json::array();
        notes.push_back(std::string("台账：") + (init.created ? "本次初始化" : "已存在，未重建"));

        const PhaseView v = phaseViewLocked();
        const scoring::PhaseContext pc =
            toScoringPhaseContext(v.phaseKey, v.seq, scene, v.enteredAt, targetId);
        scoring::CandidateRequest req;
        req.missionId = targetId;
        req.phase = pc;
        req.side = params.value("side", std::string("group"));
        req.scene = scene;
        req.onlyTemplateKeys = {planId};
        req.includeInapplicable = true;
        req.dedupe = false;  // 只取一个模板，不做等价合并
        {
            nlohmann::json tmp = nlohmann::json::array();
            req.snapshot = buildSnapshot(engines_, targetId, pc, scene, tmp);
        }
        const std::vector<scoring::Candidate> cands = engines_.scoringEngine->generateCandidates(req);
        const scoring::Candidate* plan = nullptr;
        for (const auto& c : cands) {
            if (c.key == planId || c.id == planId) plan = &c;
        }
        if (plan == nullptr) {
            nlohmann::json ks = nlohmann::json::array();
            for (const auto& c : cands) ks.push_back(c.key);
            return reply(verb, 1004, {{"message", "未找到方案模板：" + planId}, {"knownTemplates", ks}});
        }

        nlohmann::json allocations = nlohmann::json::array();
        nlohmann::json entities = nlohmann::json::array();
        nlohmann::json clusterMap = nlohmann::json::array();
        int allocatedClusters = 0;
        int registered = 0;
        bool allIdempotent = true;
        int entityAttempts = 0;
#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST
        const std::vector<std::pair<std::string, std::string>> scenarioGroups = scenarioGroupsOf(engines_);
        const std::vector<PlatformRow> allPlatforms = platformsOf(engines_);
#else
        const std::vector<std::pair<std::string, std::string>> scenarioGroups;
        const std::vector<PlatformRow> allPlatforms;
#endif
        for (const auto& planCluster : plan->clusters) {
            // 计划里的集群名 ↔ 场景编组显示名（deployment.json groups[].name，精确匹配）
            std::string groupKey;
            for (const auto& g : scenarioGroups) {
                if (g.second == planCluster) {
                    groupKey = g.first;
                    break;
                }
            }
            if (groupKey.empty()) {
                clusterMap.push_back({{"planCluster", planCluster},
                                      {"matched", false},
                                      {"reason", "场景编组里没有同名集群 → 不编入任何平台"}});
                continue;
            }
            std::vector<PlatformRow> members;
            for (const auto& r : allPlatforms) {
                if (r.groupKey == groupKey) members.push_back(r);
            }
            resource_alloc::AssignRequest ar;
            ar.targetId = targetId;
            ar.phase = toResourcePhaseContext(pc.phaseKey, pc.seq, pc.scenarioKey, pc.enteredAt, targetId);
            ar.clusterId = groupKey;
            ar.reason = planId;
            // 型号顺序 = 引擎声明顺序（models()），同一份编组每次提交同一向量
            for (const auto& m : engines_.resource->models()) {
                int64_t n = 0;
                for (const auto& p : members) {
                    if (p.model == m.key) ++n;
                }
                if (n > 0) ar.allocation.push_back(resource_alloc::BaselineItem{m.key, n});
            }
            const resource_alloc::AllocationResult ar2 = engines_.resource->assignAllocation(ar);
            allocations.push_back({{"clusterId", groupKey},
                                   {"planCluster", planCluster},
                                   {"allocation", [&ar] {
                                        nlohmann::json a = nlohmann::json::array();
                                        for (const auto& b : ar.allocation) {
                                            a.push_back({{"model", b.model}, {"count", b.total}});
                                        }
                                        return a;
                                    }()},
                                   {"code", ar2.code},
                                   {"message", ar2.message},
                                   {"idempotent", ar2.idempotent},
                                   {"applied", ar2.applied},
                                   {"allocatedTotal", ar2.allocatedTotal},
                                   {"items", nlohmann::json::parse(ar2.items.dump())}});
            if (ar2.code != 0) {
                allIdempotent = false;
                notes.push_back("集群 " + groupKey + " 分配被拒（code=" + std::to_string(ar2.code) +
                                "）：" + ar2.message);
                continue;
            }
            ++allocatedClusters;
            if (!ar2.idempotent) allIdempotent = false;
            clusterMap.push_back({{"planCluster", planCluster},
                                  {"matched", true},
                                  {"groupKey", groupKey},
                                  {"platforms", static_cast<int>(members.size())}});
#if MA_WITH_LEDGER
            // 编成实体：**分配成功的集群**下的每一台真实平台登记一次
            for (const auto& p : members) {
                entity_ledger::RegisterInput ri;
                ri.missionId = targetId;
                ri.typeKey = p.model;  // 平台型号 key（resource-alloc deviceTypes.json 的 items[].key）
                ri.lng = p.lng;
                ri.lat = p.lat;
                ri.alt = p.alt;
                ri.confidence = 1.0;   // 场景配置即权威来源（不是估计值）
                ri.obsKey = p.deviceId;  // 去重主键（规则 dedup.keys 含 obsKey）
                ri.operatorId = "host:alloc.assign";
                nlohmann::json attrs = {{"model", p.model},
                                        {"groupKey", p.groupKey},
                                        {"planCluster", planCluster},
                                        {"planId", planId},
                                        {"homeArea", p.homeArea},
                                        {"taskArea", p.taskArea},
                                        {"speedMps", p.speed},
                                        {"battery", p.battery}};
                attrs["payload"] = p.payload;
                ri.attributes = attrs;
                ++entityAttempts;
                nlohmann::json row = {{"deviceId", p.deviceId},
                                      {"model", p.model},
                                      {"clusterId", p.groupKey},
                                      {"typeKey", p.model}};
                if (engines_.entityLedger) {
                    const entity_ledger::RegisterResult rr = engines_.entityLedger->registerEntity(ri);
                    row["code"] = rr.code;
                    row["message"] = rr.message;
                    row["status"] = rr.status;
                    row["ok"] = (rr.code == 0);
                    if (rr.code == 0) {
                        row["entityId"] = rr.data.id;
                        row["no"] = rr.data.no;
                        // 步 9（P5）：记下"这台平台在台账里的实体 id" —— 引导连线的起点要取
                        // **台账里那台**的坐标（引擎是台账的唯一权威），不另取一份场景坐标。
                        entityIdOfDevice_[p.deviceId] = rr.data.id;
                        row["dynamicState"] = rr.data.dynamicState;
                        ++registered;
                    }
                } else {
                    row["code"] = 1005;
                    row["message"] = "entity-ledger 未装配";
                    row["ok"] = false;
                }
                entities.push_back(std::move(row));
            }
#endif
        }

        nlohmann::json d = nlohmann::json::object();
        d["planId"] = planId;
        d["missionId"] = targetId;
        d["clusterCount"] = static_cast<int>(plan->clusters.size());
        d["allocatedClusters"] = allocatedClusters;
        d["allocation"] = std::move(allocations);
        d["clusterMapping"] = std::move(clusterMap);
        d["entities"] = std::move(entities);
        d["registered"] = registered;
        d["entityAttempts"] = entityAttempts;
        d["idempotent"] = (allocatedClusters > 0 && allIdempotent);
        if (entityAttempts > 0 && registered == 0) {
            // **如实上报**：编组分配成功了，但实体登记被引擎逐个拒绝 —— 把引擎的原话与它认的
            // 类型清单一起交出去（这是规则包/数据侧的缺口，不是宿主能自己"绕"过去的事）。
            nlohmann::json known = nlohmann::json::array();
#if MA_WITH_LEDGER
            if (engines_.entityLedger) {
                for (const auto& k : engines_.entityLedger->entityTypeKeys()) known.push_back(k);
            }
#endif
            d["blocked"] = {{"stage", "entity-ledger.registerEntity"},
                            {"reason", "引擎拒绝了全部登记：平台型号 key 必须出现在 entityTypes.json 的 "
                                       "items 里（未知类型 → 1000）"},
                            {"knownEntityTypes", known},
                            {"needs", "entity-ledger/policies/mapapp/entityTypes.json 声明对应平台类型"
                                      "（属模块仓规则包；host 侧 MUST NOT 自造型号 key 绕过）"}};
            notes.push_back("实体登记 0/" + std::to_string(entityAttempts) +
                            " 成功：见 blocked（规则包缺口，宿主未自造型号 key）");
        }
        if (allocatedClusters == 0) {
            notes.push_back(allocations.empty()
                                ? "方案声明的集群与场景编组无同名项（逐条理由见 clusterMapping）"
                                : "全部集群的分配都被引擎拒绝（见 allocation[].code/message）");
        }
        d["notes"] = std::move(notes);
        return reply(verb, allocatedClusters > 0 ? 0 : 1003, d);
#else
        return reply(verb, 1005, {{"message", "resource-alloc/scoring 未装配（编译期开关关闭）"}});
#endif
    }

    // ================================================================ 步 8：打击三方案（P5）
    //
    // 与 `alloc.plans` **同一套**（同一个 `generateCandidates` + `score`，只把 `side` 换成
    // "strike"）；差别只有一处：打击侧要带出 M5 的四个新字段，并在方案上**如实标注几何是否可用**。
    if (verb == "strike.plans") {
        // 【引擎】scoring::ScoringEngine::generateCandidates(const CandidateRequest&)（scoring.h:822）
        //        + scoring::ScoringEngine::score(const CandidateRequest&)（scoring.h:824）
        //        + scoring::ScoringEngine::templatesPack()（:813）→ `TemplatesPack::raw` 取 M5 字段
        //   入参：count（默认 3）、scene（默认 = 当前场景）、snapshot **真填**（与 alloc.plans 同一份）
        //   回执：候选与评分**原样** + `recommendedId/recommendedPercent`（全部来自 ScoreResult）+ 几何标注
#if MA_WITH_SCORING && MA_WITH_RESOURCE
        if (!engines_.scoringEngine) {
            return reply(verb, 1005, {{"message", "scoring 未装配（编译期 MA_WITH_SCORING=0）"}});
        }
        const int want = intOr(params, "count", 3);
        std::lock_guard<std::mutex> lk(mtx_);
        if (missionId_.empty()) {
            return reply(verb, 1003, {{"message", "尚未进入任务：先 flow.enter（台账/评分按任务隔离）"}});
        }
        const std::string targetId = missionId_;
        std::string scene = params.value("scene", std::string());
        if (scene.empty()) scene = scenarioKeyOf(engines_);
        const LedgerInit init = ensureLedger(engines_, targetId, scene);
        if (init.code != 0) {
            return reply(verb, init.code, {{"message", init.message}, {"targetId", targetId}});
        }
        nlohmann::json notes = nlohmann::json::array();
        notes.push_back(std::string("台账：") + (init.created ? "本次初始化（" : "已存在，未重建（") +
                        init.message + "）");

        const PhaseView v = phaseViewLocked();
        const scoring::PhaseContext pc =
            toScoringPhaseContext(v.phaseKey, v.seq, scene, v.enteredAt, targetId);
        scoring::CandidateRequest req;
        req.missionId = targetId;
        req.phase = pc;
        req.side = "strike";              // ★ 与 alloc.plans 的唯一差别
        req.scene = scene;
        req.includeInapplicable = true;   // SCD-CAND-02：不适用 MUST 标注而非静默丢弃
        req.dedupe = true;                // SCD-CAND-04
        req.snapshot = buildSnapshot(engines_, targetId, pc, scene, notes);

        const std::vector<scoring::Candidate> cands = engines_.scoringEngine->generateCandidates(req);
        const scoring::ScoreResult sr = engines_.scoringEngine->score(req);
        if (sr.code != 0) {
            return reply(verb, sr.code,
                         {{"message", sr.message}, {"notes", notes}, {"scene", scene}, {"side", "strike"}});
        }

        nlohmann::json items = nlohmann::json::array();
        int taken = 0;
        int resolvedGeometry = 0;
        int unresolvedGeometry = 0;
        for (const auto& cs : sr.candidates) {
            if (taken >= want) break;
            const nlohmann::json candidateRaw = nlohmann::json::parse(cs.candidate.toJson().dump());
            const std::string tkey = candidateRaw.value("key", cs.candidate.key);
            const nlohmann::json tpl = templateRawOfLocked(tkey);   // M5 字段的原样来源
            const nlohmann::json geo = strikeGeometryOfLocked(tpl);
            if (!tpl.is_object() || tpl.empty()) {
                notes.push_back("模板 " + tkey + " 在 TemplatesPack.raw 里查不到 → M5 字段与几何标注留空");
            }
            if (geo.value("resolved", false)) {
                ++resolvedGeometry;
            } else {
                ++unresolvedGeometry;
            }
            items.push_back({{"candidate", candidateRaw},
                             {"score", nlohmann::json::parse(cs.toJson().dump())},
                             // M5：**模板原样**（coordination/coordinationLabel/plannedFinish/
                             // attackStart/assessRoute 都在里面；宿主不拼业务文案）
                             {"template", tpl},
                             {"coordination", tpl.contains("coordination")
                                                  ? tpl["coordination"]
                                                  : nlohmann::json(nullptr)},
                             {"coordinationLabel", tpl.contains("coordinationLabel")
                                                       ? tpl["coordinationLabel"]
                                                       : nlohmann::json(nullptr)},
                             {"plannedFinish", tpl.contains("plannedFinish")
                                                   ? tpl["plannedFinish"]
                                                   : nlohmann::json(nullptr)},
                             {"attackStart", tpl.contains("attackStart") ? tpl["attackStart"]
                                                                         : nlohmann::json(nullptr)},
                             {"assessRoute", tpl.contains("assessRoute") ? tpl["assessRoute"]
                                                                         : nlohmann::json(nullptr)},
                             {"geometry", geo}});
            ++taken;
        }
        nlohmann::json candidatesRaw = nlohmann::json::array();
        for (const auto& c : cands) candidatesRaw.push_back(nlohmann::json::parse(c.toJson().dump()));
        nlohmann::json reasons = nlohmann::json::array();
        for (const auto& rs : sr.reasons) reasons.push_back(nlohmann::json::parse(rs.toJson().dump()));
        nlohmann::json missing = nlohmann::json::array();
        for (const auto& m : sr.missingInputs) missing.push_back(m);

        const nlohmann::json& geoDoc = strikeGeometryLocked();
        nlohmann::json d = nlohmann::json::object();
        d["side"] = "strike";
        d["scene"] = sr.scene.empty() ? scene : sr.scene;
        d["missionId"] = targetId;
        d["count"] = taken;
        d["requestedCount"] = want;
        d["items"] = items;
        d["candidates"] = std::move(candidatesRaw);
        d["recommendedId"] = sr.recommendedId;
        d["hasRecommended"] = sr.hasRecommended;
        d["recommendedPercent"] = sr.recommendedPercent;
        d["nextId"] = sr.nextId;
        d["nextPercent"] = sr.nextPercent;
        d["leadOverNext"] = sr.leadOverNext;
        d["leadOverNextPercent"] = sr.leadOverNextPercent;
        d["reasons"] = std::move(reasons);
        d["missingInputs"] = std::move(missing);
        d["metricsDigest"] = sr.metricsDigest;
        d["templatesDigest"] = sr.templatesDigest;
        d["auditDigest"] = sr.auditDigest;
        d["geometrySource"] = {{"path", geoDoc.value("path", std::string())},
                               {"loaded", geoDoc.value("loaded", false)},
                               {"attackStarts",
                                geoDoc.contains("attackStarts") ? geoDoc["attackStarts"].size() : 0},
                               {"assessRoutes",
                                geoDoc.contains("assessRoutes") ? geoDoc["assessRoutes"].size() : 0},
                               {"authority", "scenario-data（§10.1-Q4 变体 A：规则包只有键引用）"}};
        d["geometryResolved"] = resolvedGeometry;
        d["geometryUnresolved"] = unresolvedGeometry;
        notes.push_back("几何标注：resolved=" + std::to_string(resolvedGeometry) + " / unresolved=" +
                        std::to_string(unresolvedGeometry) +
                        "（**只标注、不丢**：不适用项由引擎的 includeInapplicable 决定是否保留）");
        notes.push_back("Q5 口径：本演示只跑场景一 → 场景二模板（stk-s2-*）不声明几何键，"
                        "其 geometry.resolved=false 且给出 reason（MUST NOT 造坐标）");
        d["notes"] = std::move(notes);
        if (taken > 0 && sr.hasRecommended) {
            hasStrikeScore_ = true;
            lastStrikeRecommendation_ = sr.recommendedId;
            lastStrikeRecommendedPercent_ = sr.recommendedPercent;
        }
        lastStrikePlans_ = d;  // /api/state 也带一份（前端刚挂载时不必等命令）
        return reply(verb, 0, d);
#else
        return reply(verb, 1005, {{"message", "scoring/resource-alloc 未装配（编译期开关关闭）"}});
#endif
    }

    // ---------------------------------------------------------------- 步 8：打击窗口（实体级）
    if (verb == "strike.window") {
        // 【引擎】entity_ledger::EntityLedger::strikeWindow(entityId, StrikeWindowQuery)
        //   （公开头 entity_ledger.h:1276）—— 由**轨迹与规则**推算的结构化时间区间
        //   （ELG-RATE-06：MUST NOT 是硬编码字符串）。规则 `strikeWindow.*` 在
        //   entity-ledger/policies/mapapp/threatFactors.json 里。
        //   宿主只转发（含 nowMs/horizonOverrideMs 两个可选入参），回执 = `StrikeWindowResult::toJson()` 原样。
#if MA_WITH_LEDGER
        if (!engines_.entityLedger) {
            return reply(verb, 1005, {{"message", "entity-ledger 未装配（编译期 MA_WITH_LEDGER=0）"}});
        }
        std::lock_guard<std::mutex> lk(mtx_);
        if (missionId_.empty()) {
            return reply(verb, 1003, {{"message", "尚未进入任务：先 flow.enter"}});
        }
        std::string entityId = params.value("entityId", std::string());
        std::string pickedBy = "param";
        if (entityId.empty()) {
            // 未指定 → 取台账里**威胁分最高**的一条（平手按 no 小者）。这是**排序**不是造数据；
            // 用的是引擎已经算好的 threatScore（`listEntities` 的只读视图）。
            const std::vector<entity_ledger::EntityRecord> rows =
                engines_.entityLedger->listEntities(entity_ledger::EntityQuery{missionId_});
            const entity_ledger::EntityRecord* best = nullptr;
            for (const auto& r : rows) {
                if (r.retired) continue;
                if (best == nullptr || r.threatScore > best->threatScore ||
                    (r.threatScore == best->threatScore && r.no < best->no)) {
                    best = &r;
                }
            }
            if (best == nullptr) {
                return reply(verb, 1004,
                             {{"message", "台账里没有实体：先让目标被探测登记（步 7）"},
                              {"missionId", missionId_},
                              {"hint", "strike.window{entityId} 也可显式指定；未指定时取威胁分最高者"}});
            }
            entityId = best->id;
            pickedBy = "highest-threat";
        }
        entity_ledger::StrikeWindowQuery q;
        q.nowMs = static_cast<int64_t>(params.value("nowMs", static_cast<double>(0)));
        q.horizonOverrideMs = intOr(params, "horizonOverrideMs", 0);
        const entity_ledger::StrikeWindowResult res = engines_.entityLedger->strikeWindow(entityId, q);
        nlohmann::json d = nlohmann::json::parse(res.toJson().dump());
        d["entityId"] = entityId;
        d["pickedBy"] = pickedBy;
        if (res.code == 0 && !res.data.entityId.empty()) d["entityId"] = res.data.entityId;
        return reply(verb, res.code, d);
#else
        return reply(verb, 1005, {{"message", "entity-ledger 未装配（编译期 MA_WITH_LEDGER=0）"}});
#endif
    }

    // ---------------------------------------------------------------- 步 9：打击方案采纳 / 确认
    //
    // 与 `alloc.adopt`/`alloc.confirm` **同一套引擎语义**（同一个 `adopt`/`confirm`：
    // 同侧互斥、幂等 code=0 + idempotent、非推荐方案标 deviated、`confirm` 的前置策略
    // 由规则包 `confirmPrecondition` 裁决 —— 未采纳直接确认 → 1003，细节在 **data.unmet**）。
    // 差别：`side` 固定 "strike"，且成功时把**流程**推到步 8/9 并把**阶段**推到 T5。
    if (verb == "strike.adopt" || verb == "strike.confirm") {
        // 【引擎】scoring::ScoringEngine::adopt(const AdoptRequest&)（scoring.h:834）
        //        / scoring::ScoringEngine::confirm(const ConfirmRequest&)（scoring.h:836）
        //        + phase::PhaseEngine::advance(const AdvanceRequest&)（phase_engine.h:577）到 T5
#if MA_WITH_SCORING
        if (!engines_.scoringEngine) {
            return reply(verb, 1005, {{"message", "scoring 未装配（编译期 MA_WITH_SCORING=0）"}});
        }
        const std::string planId = params.value("planId", std::string());
        if (planId.empty()) return badRequest(verb, "缺少 planId");
        // `side`：默认 strike；若显式给了别的侧，就以模板自己声明的 side 为准（不猜、也不硬顶）
        std::string side = params.value("side", std::string("strike"));
        {
            const nlohmann::json tpl = templateRawOfLocked(planId);
            if (tpl.is_object() && tpl.contains("side")) side = tpl.value("side", side);
        }
        nlohmann::json d = nlohmann::json::object();
        int code = 0;
        bool stepChanged = false;
        bool phaseMoved = false;
        {
            std::lock_guard<std::mutex> lk(mtx_);
            if (missionId_.empty()) {
                return reply(verb, 1003, {{"message", "尚未进入任务：先 flow.enter"}});
            }
            const std::string scene = scenarioKeyOf(engines_);
            const PhaseView v = phaseViewLocked();
            const scoring::PhaseContext pc =
                toScoringPhaseContext(v.phaseKey, v.seq, scene, v.enteredAt, missionId_);
            if (verb == "strike.adopt") {
                scoring::AdoptRequest req;
                req.missionId = missionId_;
                req.phase = pc;
                req.planId = planId;
                req.side = side;
                req.operatorId = params.value("operatorId", std::string("host"));
                req.reason = params.value("reason", std::string("host:strike.adopt"));
                req.hasRecommendedContext = hasStrikeScore_;
                req.recommendedId = lastStrikeRecommendation_;
                req.recommendedPercent = lastStrikeRecommendedPercent_;
                req.planPercent =
                    (planId == lastStrikeRecommendation_) ? lastStrikeRecommendedPercent_ : 0;
#if MA_WITH_RESOURCE
                {
                    nlohmann::json tmp = nlohmann::json::array();
                    req.snapshot = buildSnapshot(engines_, missionId_, pc, scene, tmp);
                }
#endif
                const scoring::DecideResult res = engines_.scoringEngine->adopt(req);
                code = res.code;
                d = nlohmann::json::parse(res.dataJson().dump());
                if (res.idempotent) d["idempotent"] = true;
                if (res.code == 0) {
                    adoptedStrikePlanId_ = planId;
                    if (step_ < 8) {
                        step_ = 8;  // 步 8 = 打击方案（采纳发生在这一步的卡片上）
                        stepChanged = true;
                    }
                }
            } else {
                scoring::ConfirmRequest req;
                req.missionId = missionId_;
                req.phase = pc;
                req.planId = planId;
                req.side = side;
                req.operatorId = params.value("operatorId", std::string("host"));
                req.reason = params.value("reason", std::string("host:strike.confirm"));
                const scoring::DecideResult res = engines_.scoringEngine->confirm(req);
                code = res.code;
                d = nlohmann::json::parse(res.dataJson().dump());
                if (res.idempotent) d["idempotent"] = true;
                if (res.code == 0) {
                    confirmedStrikePlanId_ = planId;
                    if (step_ < 9) {
                        step_ = 9;  // 步 9 = 打击确认（IP 点 + 引导连线 + 时间轴）
                        stepChanged = true;
                    }
                }
            }
        }
        // ---- 阶段推进到 T5（与步 8/9 对齐）----
        //
        // 两步走：先**正常** advance（判据由 phase-engine 的 Gate 裁决）；被拦（如 T4 的
        // `target-identified`）时再 `force=true` 重试一次。**为什么允许 force**：本演示的
        // 步 8 可以从界面上直接进入（P5 自证脚本就跑这条最短路径），不 force 的话流程会卡在
        // T0 —— 而"阶段推进"这件事本身是**流程步进**，不是引擎的判决结果；force 的两次回执
        // 都原样回执，谁被跳过（`skippedGates`/`unmet`）一目了然，MUST NOT 静默。
        if (code == 0) {
            nlohmann::json advance = nlohmann::json::object();
            std::lock_guard<std::mutex> lk(mtx_);
            const int stepBefore = step_;
            if (engines_.phase && !missionId_.empty()) {
                phase::AdvanceRequest ar;
                ar.missionId = missionId_;
                ar.to = "T5";
                ar.reason = std::string("host:") + verb;
                ar.operatorId = params.value("operatorId", std::string("host"));
                phase::TransitionResult tr = engines_.phase->advance(ar);
                nlohmann::json first = tr.dataJson();
                bool forced = false;
                if (tr.code != 0) {
                    ar.force = true;
                    ar.reason = std::string("host:") + verb + ":force";
                    tr = engines_.phase->advance(ar);
                    forced = true;
                }
                advance["phase"] = "T5";
                advance["forced"] = forced;
                advance["code"] = tr.code;
                advance["firstAttempt"] = first;
                advance["result"] = tr.dataJson();
                if (tr.code == 0) {
                    const PhaseView v2 = phaseViewLocked();
                    phase_ = v2.phaseKey.empty() ? std::string("T5") : v2.phaseKey;
                    enteredAtMs_ = v2.enteredAt != 0 ? v2.enteredAt : enteredAtMs_;
                    // ★ 步号**由动词决定，不是由阶段反推**：`stepForPhase("T5")` = 步 8，
                    //   但 `strike.confirm` 落在**步 9**（打击确认屏，同一阶段 T5 的第二屏）——
                    //   这里显式写回，否则 confirm 会被 advance 的 phase→step 映射"打回"步 8。
                    step_ = (verb == "strike.confirm") ? 9 : 8;
                    if (step_ != stepBefore) stepChanged = true;
                    phaseMoved = true;
                    advance["step"] = step_;
                    advance["stepKey"] = flowStepOf(step_) ? flowStepOf(step_)->key : "";
                    advance["enteredAt"] = enteredAtMs_;
                    advance["phaseKey"] = phase_;
                } else {
                    advance["note"] = "phase-engine 拒绝（含 force）→ 流程停在原阶段，回执原样给出";
                }
            } else {
                advance["note"] = "phase-engine 未装配 → 只推进宿主流程步";
            }
            d["advance"] = advance;
            // ---- 步 9 的显示模式：可选覆盖一次（**键名由调用方给，宿主不猜**）----
            //
            // 【引擎】view_composer::ViewComposer::setModeOverride（公开头 view_composer.h:656）。
            // 规则包 `view-composer/policies/mapapp/viewModes.json` 的 `requiredModes[]` 里声明了
            // 步 9 用它（`strike-confirm`）；但**可用键的权威在规则包**，宿主 MUST NOT 把键写死
            // 在源码里（否则规则包改名就静默失效）—— 所以 `modeKey` 由调用方给，缺省 = 不覆盖
            // （返回的 `modeOverride` 就是引擎对"未指定模式"的判决，原样）。
#if MA_WITH_VIEW_COMPOSER
            if (verb == "strike.confirm" && engines_.viewComposer) {
                const std::string mk = params.value("modeKey", std::string());
                if (!mk.empty()) {
                    const PhaseView v2 = phaseViewLocked();
                    const view_composer::PhaseContext vc = toViewPhaseContext(
                        v2.phaseKey, v2.seq, v2.scenarioKey, v2.enteredAt, missionId_);
                    const view_composer::ModeResolution mr =
                        engines_.viewComposer->setModeOverride(vc, mk);
                    strikeModeOverride_ = nlohmann::json::parse(view_composer::toJson(mr).dump());
                    d["modeOverride"] = strikeModeOverride_;
                    if (!mr.ok) {
                        d["modeOverrideNote"] =
                            "引擎拒绝该 modeKey（键名必须在规则包 viewModes.json 里声明）——"
                            "原样回执，宿主不改流程结果";
                    }
                }
            }
#endif
        }
        if (stepChanged || phaseMoved) broadcastFlowState();
        return reply(verb, code, d);
#else
        return reply(verb, 1005, {{"message", "scoring 未装配（编译期 MA_WITH_SCORING=0）"}});
#endif
    }

    // ---------------------------------------------------------------- 步 9：引导方案（IP 点 + 引导连线 + 时间轴）
    if (verb == "guidance.plan") {
        // 【数据源】① 几何 = 场景数据 `<scenarioDir>/strike-geometry.json`（IP 点 / 评估航线，
        //              §10.1-Q4 变体 A：规则包只有 `attackStart.key` / `assessRoute.key` 键引用）
        //           ② 引导连线的起点 = entity-ledger 台账里**已登记平台**的坐标
        //           ③ M5 字段（coordination/plannedFinish/attackStart/assessRoute） = scoring
        //              的 `TemplatesPack.raw`（引擎不解析，逐字原样）
        //           ④ 时刻 = phase-engine 台账的 `enteredAt`（t0）+ 每段自己的算式（basis）
        //   前置：该方案必须已被 `strike.adopt`（→`strike.confirm`）—— 与 alloc.* 同一套语义。
        const std::string planId = params.value("planId", std::string());
        if (planId.empty()) return badRequest(verb, "缺少 planId");
        nlohmann::json d = nlohmann::json::object();
        int code = 0;
        {
            std::lock_guard<std::mutex> lk(mtx_);
            if (missionId_.empty()) {
                return reply(verb, 1003, {{"message", "尚未进入任务：先 flow.enter"}});
            }
            d = buildGuidancePlanLocked(planId, params, code);
        }
        if (code == 0) lastGuidance_ = d;  // /api/state 复用（步 9 屏幕的"当前引导方案"）
        return reply(verb, code, d);
    }

    // ================================================================ 步 6：仿真节拍
    //
    // 冻结命令面（流程接口冻结 §2 步 6）：sim.start / sim.pause / sim.resume / sim.speed /
    // sim.step；事件 `sim.state`（形状见 §1）。
    //
    // 【引擎】唯一的时间入口是 `ma::sim_bridge::Driver`（它内部调 SimSource::tick/step）：
    //   start()    → 起驱动线程（真实时间 × 倍速）
    //   pause()/resume() → 引擎口径：暂停期间的真实时间被丢弃（不会"跳一下"）
    //   setSpeed(1|8|60) → 非法值由引擎拒绝（返回 false）
    //   stepOnce(dtMs)   → 推 dtMs **仿真毫秒**（与倍速无关）
    // 宿主只转发 + 把 Driver/metrics 的读数折成 sim.state 负载。
    if (verb == "sim.start" || verb == "sim.pause" || verb == "sim.resume" ||
        verb == "sim.speed" || verb == "sim.step" || verb == "sim.state") {
#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST
        if (!engines_.bridge.engine || !engines_.bridge.driver) {
            return reply(verb, 1005,
                         {{"message", "仿真源未装配（sim-source / 接入层未编译进来）"},
                          {"note", engines_.simNote}});
        }
        nlohmann::json d = nlohmann::json::object();
        int code = 0;
        bool changed = false;
        {
            std::lock_guard<std::mutex> lk(mtx_);
            auto& driver = *engines_.bridge.driver;
            if (verb == "sim.start") {
                if (driver.running() && !driver.paused()) {
                    d["idempotent"] = true;
                    d["reason"] = "仿真节拍已在运行且未暂停";
                    d["action"] = "noop";
                } else {
                    // "start" 的口径 = 让仿真时间开始走（起线程；已暂停则恢复）——
                    // 否则会出现"start 成功但时间不动"的假成功（暂停只是引擎层面的）。
                    std::string action;
                    if (!driver.running()) {
                        driver.primeNow();  // 先对齐基线（首 tick 只记基线，不推进）
                        driver.start();
                        action = "start";
                    }
                    if (driver.paused()) {
                        driver.resume();
                        action = action.empty() ? "resume" : (action + "+resume");
                    }
                    changed = true;
                    d["action"] = action;
                    d["note"] = "已起飞：仿真时间开始推进（真实时间 × 倍速）";
                }
            } else if (verb == "sim.pause") {
                if (driver.paused()) {
                    d["idempotent"] = true;
                } else {
                    driver.pause();
                    changed = true;
                }
                d["note"] = "暂停：引擎丢弃暂停期间的真实时间（SimSource::pause 口径）";
            } else if (verb == "sim.resume") {
                // "resume" = 让时间继续自己走：线程没起就起（单步之后就是这样），引擎暂停就解除。
                // 只调 Driver::resume() 是不够的 —— 单步会把驱动线程停掉，那样"恢复了"但时间不动。
                std::string action;
                if (!driver.running()) {
                    driver.primeNow();
                    driver.start();
                    action = "start";
                }
                if (driver.paused()) {
                    driver.resume();
                    action = action.empty() ? "resume" : (action + "+resume");
                }
                if (action.empty()) {
                    d["idempotent"] = true;
                } else {
                    changed = true;
                }
                d["action"] = action.empty() ? "noop" : action;
            } else if (verb == "sim.speed") {
                const int want = intOr(params, "speed", 0);
                if (want == 0) return badRequest(verb, "缺少 speed（1 | 8 | 60）");
                const bool ok = driver.setSpeed(want);
                d["requested"] = want;
                d["accepted"] = ok;
                if (!ok) {
                    code = 1000;
                    nlohmann::json allowed = nlohmann::json::array();
                    for (int s : sim_source::allowedSpeedMultipliers()) allowed.push_back(s);
                    d["message"] = "引擎拒绝该倍速（SimSource::setSpeed 只接受 1 / 8 / 60）";
                    d["allowed"] = allowed;
                } else {
                    changed = true;
                }
            } else if (verb == "sim.step") {
                const int dt = intOr(params, "dtMs", 1000);
                if (dt <= 0) return badRequest(verb, "dtMs 必须 > 0（单位：仿真毫秒）");
                // 单步 = **让时间只走这一下**。三步都要做（引擎口径决定的，不是偏好）：
                //   ① 停驱动线程（否则真实时间的 tick 会继续推）
                //   ② 解除暂停（`SimSource::step()` 在 paused 时返回 0 —— 引擎明写）
                //   ③ `step(dtMs)` 推 dtMs 仿真毫秒（与倍速无关）
                // 之后用 `sim.resume` / `sim.start` 让时间继续自己走。
                const bool stoppedDriver = driver.running();
                if (stoppedDriver) driver.stop();
                const bool wasPaused = driver.paused();
                if (wasPaused) driver.resume();
                const int events = driver.stepOnce(dt);
                d["dtMs"] = dt;
                d["events"] = events;
                d["driverStopped"] = stoppedDriver;
                d["unpaused"] = wasPaused;
                d["note"] = "单步：停驱动线程 + 解除暂停后调 step(dtMs)（引擎的 step 在 paused 时"
                            "返回 0）；接着用 sim.resume / sim.start 继续";
                changed = true;
            }
            d["state"] = simStateJsonLocked();
        }
        if (changed) broadcastSimState();
        return reply(verb, code, d);
#else
        return reply(verb, 1005,
                     {{"message", "仿真源未装配（编译期 MA_WITH_SIM_SOURCE / MA_WITH_INGEST=0）"}});
#endif
    }

    // ---------------------------------------------------------------- P7：仿真源重建
    if (verb == "sim.reset") {
        // 与 `mission.reset` / `boot.reset` 的分工见 FlowEngine::rebuildSimLocked 的注释：
        // 那两个只清**任务与阶段**，仿真本身回不到起点（平台已飞完/已俯冲）—— 所以"重跑一遍"
        // 必须先把仿真源重建到刚装配好的状态。接入层与 hub 一概未动。
#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST
        if (!engines_.bridge.engine || !engines_.bridge.driver) {
            return reply(verb, 1005,
                         {{"message", "仿真源未装配（sim-source / 接入层未编译进来）"},
                          {"note", engines_.simNote}});
        }
        nlohmann::json d = nlohmann::json::object();
        int code = 0;
        {
            std::lock_guard<std::mutex> lk(mtx_);
            d = rebuildSimLocked(code);
        }
        // 重建后读数全变了（elapsed/emitted/platforms 都回起点）→ 广播一份给前端
        // （步号与阶段**没有**变，所以不发 flow.state）。
        if (code == 0) broadcastSimState();
        return reply(verb, code, d);
#else
        return reply(verb, 1005,
                     {{"message", "仿真源未装配（编译期 MA_WITH_SIM_SOURCE / MA_WITH_INGEST=0）"}});
#endif
    }

    // ================================================================ 步 6–7：探测读数 / 开关
    if (verb == "sensor.status") {
        std::lock_guard<std::mutex> lk(mtx_);
        return reply(verb, 0, sensorStatusLocked());
    }

    if (verb == "sensor.configure") {
        // "拔掉传感器 / 把距离拉远"的**演示开关**（自证要能证明"拔掉它 → 目标不再出现"）。
        // 语义是改**模型入参**：enabled=false → sense() 直接返回空（一条观测都不发）；
        // rangeScale 乘在 SensorSpec 的 maxRangeM/referenceRangeM 上 → 观测仍由引擎算。
        // MUST NOT 用"把概率改小"之类的办法伪造不可见。
#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST && MA_WITH_SENSOR_MODEL
        if (!engines_.sensorBridge) {
            return reply(verb, 1005, {{"message", sensorNote()}});
        }
        std::lock_guard<std::mutex> lk(mtx_);
        nlohmann::json d = nlohmann::json::object();
        if (params.contains("enabled")) {
            const bool on = params.value("enabled", true);
            engines_.sensorBridge->setEnabled(on);
            d["enabled"] = on;
        }
        if (params.contains("rangeScale")) {
            const double sc = params.value("rangeScale", 1.0);
            if (!(sc > 0.0)) return badRequest(verb, "rangeScale 必须 > 0");
            engines_.sensorBridge->setRangeScale(sc);
            d["rangeScale"] = sc;
        }
        d["note"] = "改的是传感器模型的入参（enabled / 量程缩放）：观测与可见性仍由 "
                    "sensor_model::sense 判定，宿主不产生观测";
        d["stats"] = engines_.sensorBridge->statsJson();
        return reply(verb, 0, d);
#else
        return reply(verb, 1005, {{"message", sensorNote()}});
#endif
    }

    // ================================================================ 步 6：链路评估
    if (verb == "topology.evaluate") {
        // 【引擎】topology::TopologyEngine 的五个入口（公开头 :759-788, :809, :817）：
        //   ① configureTopology(topologyId, structureKey, reset=true)  —— 结构键**从规则包里挑**
        //   ② addNodes/addEdges                                        —— 节点/边**按场景数据**
        //   ③ ingest(逐条)/ingestBatch                                 —— 线上报文（形状转换在宿主）
        //   ④ evaluate(PhaseContext) + linkQualities()                 —— 评分与绿/黄/红（带迟滞）
        //   ⑤ primitives()                                             —— 图元（含坐标）
        // 回执里另附 `policy`（states/hysteresis/metrics）——**状态的判据原样来自规则包**
        // linkThresholds.json，宿主不解释阈值。
#if MA_WITH_TOPOLOGY && MA_WITH_SIM_SOURCE && MA_WITH_INGEST
        if (!engines_.topologyEngine) {
            return reply(verb, 1005, {{"message", "topology 未装配（编译期 MA_WITH_TOPOLOGY=0）"}});
        }
        nlohmann::json notes = nlohmann::json::array();
        nlohmann::json d = nlohmann::json::object();
        int code = 0;
        {
            std::lock_guard<std::mutex> lk(mtx_);
            const nlohmann::json topo = ensureTopologyLocked();
            d["topology"] = topo;
            d["missionId"] = missionId_;
            if (!topo.value("configured", false)) {
                code = topo.value("code", 1005);
                d["notes"] = notes;
                return reply(verb, code, d);
            }

            // ---- 排空线上报文（接入层线程只累加；这里在 `mtx_` 之下快照并清零）----
            std::map<std::string, WireAgg> agg;
            int64_t frames = 0;
            {
                std::lock_guard<std::mutex> wl(wireMtx_);
                agg.swap(wireAgg_);   // delta 语义：本次评估的窗口 = 上次评估以来的报文
                for (const auto& kv : agg) frames += kv.second.frames;
                ++wireWindows_;
            }
            const nlohmann::json conv = toTopologyEvents(agg, notes);
            const nlohmann::json& evs = conv["events"];

            std::vector<topology::json> batch;
            for (const auto& e : evs) {
                batch.push_back(topology::json::parse(e.dump()));
            }
            nlohmann::json ingest = nlohmann::json::object();
            ingest["frames"] = frames;
            ingest["links"] = static_cast<int>(batch.size());
            ingest["window"] = wireWindows_;
            ingest["wireTotals"] = {{"accepted", wireTotal_}, {"windows", wireWindows_}};
            if (!batch.empty()) {
                const topology::MutationResult ir = engines_.topologyEngine->ingestBatch(batch);
                ingest["result"] = nlohmann::json::parse(ir.toJson().dump());
                if (ir.code != 0) {
                    code = ir.code;
                    notes.push_back("ingestBatch 未全成功：" + ir.message);
                }
                topologyIngests_ += static_cast<int64_t>(batch.size());
                topologyLinkSamples_ += frames;
            } else {
                ingest["result"] = nullptr;
                notes.push_back("本次没有可投递的线上报文（窗口内没收到帧）：引擎按缺样本处理，"
                                "MUST NOT 由宿主补数");
            }
            d["ingest"] = std::move(ingest);
            d["metricDetail"] = conv["detail"];

            // ---- 评估 + 逐链路状态 + 图元 ----
            const PhaseView v = phaseViewLocked();
            topology::PhaseContext pc;
            pc.phaseKey = v.phaseKey;
            pc.seq = v.seq;
            pc.scenarioKey = v.scenarioKey;
            pc.enteredAt = v.enteredAt;
            pc.missionId = v.missionId;
            const topology::EvaluationResult er = engines_.topologyEngine->evaluate(pc);
            d["evaluation"] = nlohmann::json::parse(er.toJson().dump());

            nlohmann::json links = nlohmann::json::array();
            int withState = 0;
            int withScore = 0;
            for (const auto& lq : engines_.topologyEngine->linkQualities()) {
                nlohmann::json row = nlohmann::json::parse(lq.toJson().dump());
                // toJson 只写"已知"的字段：没有状态 → 没有 state 键；没有评分 → 没有 score 键。
                // 这里把两个布尔量显式补上，便于前端与验收脚本判读（值来自引擎的 hasState/hasScore）。
                row["hasState"] = lq.hasState;
                row["hasScore"] = lq.hasScore;
                if (lq.hasState) ++withState;
                if (lq.hasScore) ++withScore;
                links.push_back(std::move(row));
            }
            d["links"] = std::move(links);
            d["linkCount"] = static_cast<int>(engines_.topologyEngine->linkQualities().size());
            d["linksWithState"] = withState;
            d["linksWithScore"] = withScore;
            d["primitives"] = nlohmann::json::parse(
                engines_.topologyEngine->primitives().dump());

            // ---- 判据出处：规则包的 states/hysteresis/metrics（原样回执）----
            const auto pol = engines_.topologyEngine->policy();
            if (pol.has_value()) {
                nlohmann::json states = nlohmann::json::array();
                for (const auto& s : pol->states) {
                    states.push_back({{"key", s.key},
                                      {"state", topology::toString(s.state)},
                                      {"min", s.min}});
                }
                nlohmann::json metrics = nlohmann::json::array();
                for (const auto& m : pol->metrics) {
                    metrics.push_back({{"key", m.key},
                                       {"ledgerKey", m.ledgerKey},
                                       {"unit", m.unit},
                                       {"direction", m.direction == topology::MetricDirection::Higher
                                                         ? "higher"
                                                         : "lower"},
                                       {"min", m.min},
                                       {"max", m.max},
                                       {"weight", m.weight},
                                       {"inScore", m.inScore()}});
                }
                d["policy"] = {{"states", states},
                               {"hysteresis",
                                {{"riseMargin", pol->hysteresis.riseMargin},
                                 {"fallMargin", pol->hysteresis.fallMargin},
                                 {"confirmCount", pol->hysteresis.confirmCount},
                                 {"minDwellMs", pol->hysteresis.minDwellMs}}},
                               {"window", {{"windowMs", pol->window.windowMs},
                                           {"maxSamples", pol->window.maxSamples}}},
                               {"metrics", metrics},
                               {"source", "topology::TopologyEngine::policy()"
                                          "（= linkThresholds.json 的生效值）"}};
            } else {
                notes.push_back("规则包未装载：policy() 为空（states/hysteresis 拿不到）");
            }
            d["notes"] = std::move(notes);
        }
        return reply(verb, code, d);
#else
        return reply(verb, 1005,
                     {{"message", "topology 未装配或场景数据不可用（编译期开关关闭）"}});
#endif
    }

    // ================================================================ 步 7：目标列表 / 详情 / 处置
    if (verb == "targets.list") {
        // 【引擎】entity_ledger::EntityLedger::listEntities(EntityQuery)（公开头 :1236）
        // 清单 = **台账里真的有的实体**：目标随探测出现（sensor-model 判定可见 → 宿主落账），
        // 所以这里数的不是 targets.json 的全量，而是"到目前为止被探测到的"。
#if MA_WITH_LEDGER
        if (!engines_.entityLedger) {
            return reply(verb, 1005, {{"message", "entity-ledger 未装配（编译期 MA_WITH_LEDGER=0）"}});
        }
        std::lock_guard<std::mutex> lk(mtx_);
        if (missionId_.empty()) {
            return reply(verb, 1003, {{"message", "尚未进入任务：先 flow.enter"}});
        }
        entity_ledger::EntityQuery q;
        q.missionId = missionId_;
        q.includeRetired = params.value("includeRetired", false);
        q.limit = intOr(params, "limit", 200);
        q.offset = intOr(params, "offset", 0);
        const std::vector<entity_ledger::EntityRecord> rows =
            engines_.entityLedger->listEntities(q);

        nlohmann::json items = nlohmann::json::array();
        for (const auto& r : rows) {
            items.push_back(nlohmann::json::parse(entity_ledger::toJson(r).dump()));
        }
        // 只把**目标**（= 探测出来的敌方实体）与平台分开报：判据是场景数据里的 targets[]
        const std::map<std::string, std::string> targetKeys = targetTypeKeysLocked();
        nlohmann::json targets = nlohmann::json::array();
        nlohmann::json others = nlohmann::json::array();
        for (const auto& r : rows) {
            bool isTarget = false;
            for (const auto& kv : targetKeys) {
                if (kv.second == r.typeKey) {
                    isTarget = true;
                    break;
                }
            }
            if (isTarget) {
                targets.push_back(nlohmann::json::parse(entity_ledger::toJson(r).dump()));
            } else {
                others.push_back(nlohmann::json::parse(entity_ledger::toJson(r).dump()));
            }
        }

        nlohmann::json d = nlohmann::json::object();
        d["missionId"] = missionId_;
        d["count"] = static_cast<int>(items.size());
        d["targetCount"] = static_cast<int>(targets.size());
        d["items"] = std::move(items);
        d["targets"] = std::move(targets);
        d["platformEntities"] = std::move(others);
        d["coverage"] = sensorStatusLocked();   // 覆盖率/遍历周期（sensor-model 算的）
        nlohmann::json notes = nlohmann::json::array();
        notes.push_back("清单 = entity-ledger 台账里**已被探测登记**的实体（missionId=" +
                        missionId_ + "），不是 targets.json 的全量 —— 目标随探测出现");
        notes.push_back("分类口径：typeKey 命中场景 targets[] 的 = 目标；其余（编组登记的平台实体）"
                        "单列 platformEntities");
        {
            std::lock_guard<std::mutex> dl(detectMtx_);
            d["detection"] = {{"registered", detectRegistered_},
                              {"merged", detectMerged_},
                              {"rebound", detectRebound_},
                              {"failed", detectFailed_},
                              {"noMission", detectNoMission_},
                              {"sourceFallback", detectSourceFallback_},
                              {"lastError", detectLastError_},
                              {"last", detectLast_}};
        }
        d["detectionNotes"] = nlohmann::json::array(
            {"registered = 首次探测 → registerEntity 新建实体；merged = 引擎按 obsKey 归并到"
             "既有实体（多传感器）；rebound = 目标移动超出空间去重半径时引擎新建了实体，"
             "宿主用 mergeEntities 并回主实体；noMission = 还没进任务时的探测结果（无处落账）",
             "落账 ID 口径：obsKey = 被探测实体的场景 id（同一目标多传感器归并）；"
             "confidence = sensor_model 算的概率（宿主不改）；typeKey = 场景 targets[].typeKey"
             "（必须是规则包 entityTypes.json 的词汇）"});
        d["notes"] = std::move(notes);
        return reply(verb, 0, d);
#else
        return reply(verb, 1005, {{"message", "entity-ledger 未装配（编译期 MA_WITH_LEDGER=0）"}});
#endif
    }

    if (verb == "targets.detail") {
        // 【引擎】entity_ledger::EntityLedger::getEntity(entityId)（:1234）
        //        + assessEntity(entityId)（:1272，威胁评级**纯函数**，逐因子可读）
        //        + actionLog(ActionLogQuery)（:1311，处置留痕）
        // 威胁等级/分值的唯一来源是规则包 threatFactors.json（引擎按 items 权重与 bands 分档）。
#if MA_WITH_LEDGER
        if (!engines_.entityLedger) {
            return reply(verb, 1005, {{"message", "entity-ledger 未装配"}});
        }
        const std::string entityId = params.value("entityId", std::string());
        if (entityId.empty()) return badRequest(verb, "缺少 entityId");
        std::lock_guard<std::mutex> lk(mtx_);
        const std::optional<entity_ledger::EntityRecord> rec =
            engines_.entityLedger->getEntity(entityId);
        if (!rec.has_value()) {
            return reply(verb, 1004, {{"message", "台账里没有这个实体：" + entityId}});
        }
        nlohmann::json d = nlohmann::json::object();
        d["entity"] = nlohmann::json::parse(entity_ledger::toJson(*rec).dump());
        const entity_ledger::ThreatAssessment ta = engines_.entityLedger->assessEntity(entityId);
        d["assessment"] = nlohmann::json::parse(ta.toJson().dump());
        const entity_ledger::DefinitionInfo di = engines_.entityLedger->definitionInfo();
        d["definition"] = {{"policiesNamespace", di.policiesNamespace},
                           {"schemaVersion", di.schemaVersion},
                           {"definitionVersion", di.definitionVersion},
                           {"digest", di.digest},
                           {"actionCount", di.actionCount},
                           {"factorCount", di.factorCount},
                           {"bandKeys", di.bandKeys}};
        // 处置动作清单：**规则包声明的动作**（宿主不自造业务动作）
        d["declaredActions"] = di.actionKeys;
        entity_ledger::ActionLogQuery aq;
        aq.missionId = rec->missionId;
        aq.entityId = entityId;
        nlohmann::json log = nlohmann::json::array();
        for (const auto& e : engines_.entityLedger->actionLog(aq)) {
            log.push_back(nlohmann::json::parse(entity_ledger::toJson(e).dump()));
        }
        d["actionLog"] = std::move(log);
        entity_ledger::TrackStats ts = engines_.entityLedger->trackStats(entityId);
        d["trackStats"] = nlohmann::json::parse(entity_ledger::toJson(ts).dump());
        nlohmann::json notes = nlohmann::json::array();
        notes.push_back("威胁分值/等级来自规则包 threatFactors.json：score 0–100、band = "
                        "bands[].key（high/mid/low）、status = bands[].state（红/黄/灰）；"
                        "factors[] 是逐因子得分与权重（可手算核对）");
        notes.push_back("动作清单来自规则包 entityTypes.json 的 actions[]：" +
                        std::to_string(di.actionCount) + " 个（宿主不自造动作）");
        if (ta.rejected) {
            notes.push_back("assessEntity 被引擎标 rejected（必填因子输入缺失）：" + ta.rejectReason);
        }
        d["notes"] = std::move(notes);
        return reply(verb, 0, d);
#else
        return reply(verb, 1005, {{"message", "entity-ledger 未装配"}});
#endif
    }

    if (verb == "targets.act") {
        // 【引擎】entity_ledger::EntityLedger::applyAction(ActionRequest)（公开头 :1308）
        //   闸门：规则包 `actions[].requires` 里的 `$` 前缀项是**引擎内建守卫**
        //   （$action:upgrade / $in-sequence / $confidence-min:0.x）；非 `$` 前缀的是**宿主闸门**，
        //   本规则包**一个都没声明** → 宿主不注册、也不自造（registerActionGate 一个都不调，
        //   回执里如实写 registeredGates=0 与 declaredRequires 原样）。
        //   规则包没声明的动作 → 引擎拒（宿主原样透传它的 code/message）。
        //   幂等/互斥语义（once/exclusive/undoWithinMs）全部由引擎裁决。
#if MA_WITH_LEDGER
        if (!engines_.entityLedger) {
            return reply(verb, 1005, {{"message", "entity-ledger 未装配"}});
        }
        const std::string entityId = params.value("entityId", std::string());
        const std::string action = params.value("action", std::string());
        if (entityId.empty()) return badRequest(verb, "缺少 entityId");
        if (action.empty()) return badRequest(verb, "缺少 action（取值见规则包 actions[]）");
        entity_ledger::ActionRequest req;
        req.entityId = entityId;
        req.actionKey = action;
        req.reason = params.value("reason", std::string("host:targets.act"));
        req.operatorId = params.value("operatorId", std::string("host"));
        if (params.contains("params") && params["params"].is_object()) req.params = params["params"];
        nlohmann::json d = nlohmann::json::object();
        int code = 0;
        {
            std::lock_guard<std::mutex> lk(mtx_);
            const entity_ledger::ActionResult ar = engines_.entityLedger->applyAction(req);
            code = ar.code;
            d = nlohmann::json::parse(ar.toJson().dump());
            const entity_ledger::DefinitionInfo di = engines_.entityLedger->definitionInfo();
            d["declaredActions"] = di.actionKeys;
            d["registeredGates"] = 0;
            d["gateNote"] = "本规则包的 actions[].requires 全是 `$` 内建守卫（宿主闸门 0 个）→ "
                            "registerActionGate 未调用；宿主 MUST NOT 自造闸门或动作";
        }
        return reply(verb, code, d);
#else
        return reply(verb, 1005, {{"message", "entity-ledger 未装配"}});
#endif
    }

    // ================================================================ 步 10：协同执行与引导
    if (verb == "exec.run") {
        // 【引擎】entity-ledger `applyAction` / `addToSequence` / `setDynamicState`（裁决原样回执）
        //        + sim-bridge（`Driver` / `SimSource`）的俯冲剖面与**逐帧读数**
        //   三件事：
        //     ① 目标动作 —— 动作键与 `requires` 取自规则包 `entityTypes.json` 的生效内容；
        //        前置按规则包声明的顺序补齐（`$action:<key>` → applyAction、`$in-sequence` → addToSequence），
        //        其余内建守卫与宿主闸门**一律不代劳** → 未满足就由引擎回 1003 + unmet[]；
        //     ② 状态推进 —— `setDynamicState(struck → destroyed)`，每次都由引擎裁决；
        //     ③ 仿真侧俯冲 + **由读数派生**的命中 —— 判据与输入在 `data.dive.hit.basis`（可独立复算）。
        //   收口：落 T6 / 步 10（P5 实测 strike.confirm 不会自动推进到步 10）。
        const std::string entityId = params.value("entityId", std::string());
        if (entityId.empty()) return badRequest(verb, "缺少 entityId");
        nlohmann::json d = nlohmann::json::object();
        int code = 0;
        bool flowChanged = false;
        {
            std::lock_guard<std::mutex> lk(mtx_);
            if (missionId_.empty()) {
                return reply(verb, 1003, {{"message", "尚未进入任务：先 flow.enter"}});
            }
            d = execRunLocked(entityId, params, code);
            flowChanged = d.value("flowStateChanged", false);
        }
        if (flowChanged) broadcastFlowState();
        return reply(verb, code, d);
    }

    if (verb == "exec.abort") {
        // 【引擎】entity-ledger `undoAction`（逐动作、逆序）→ `removeFromSequence` → `setDynamicState` 回退
        //   能退到哪**由引擎裁决**：退不动就如实回 1003（细节在 `error.unmet`，与 alloc./strike. 同语义）。
        //   仿真侧**不可回退**（sim-source 没有回滚入口）—— 回执里写明，MUST NOT 声称仿真回退了。
        const std::string entityId = params.value("entityId", std::string());
        if (entityId.empty()) return badRequest(verb, "缺少 entityId");
        nlohmann::json d = nlohmann::json::object();
        int code = 0;
        {
            std::lock_guard<std::mutex> lk(mtx_);
            d = execAbortLocked(entityId, params, code);
        }
        return reply(verb, code, d);
    }

    // ================================================================ 步 11：任务总结报告
    if (verb == "report.generate") {
        // 【引擎】report_engine::ReportEngine::loadPolicies(json) + generate(ReportSnapshot, GenerateOptions)
        //   · 规则包：**宿主读** `report-engine/policies/mapapp/reportFields.json` 再 `loadPolicies(json)`
        //     （`loadPoliciesFile` 是引擎里故意恒失败的占位 → MUST NOT 用它）；
        //   · 时间轴：`phase::durations()` **逐字**（回执给 `durationsRaw` + digest）；
        //   · 预警：alert-engine `counts()` / `listAlerts()`；
        //   · 留存层：telemetry-store `query`/`gaps`/`status` —— 全工程没有 append 调用者 → 库为空，
        //     如实写"留存层无数据 + 原因"，MUST NOT 编统计；
        //   · 模板：注入了 ITemplateSource 就用规则包模板，否则引擎回落内置模板（两种都写明）。
        nlohmann::json d = nlohmann::json::object();
        int code = 0;
        bool flowChanged = false;
        {
            std::lock_guard<std::mutex> lk(mtx_);
            if (missionId_.empty()) {
                return reply(verb, 1003, {{"message", "尚未进入任务：先 flow.enter"}});
            }
            d = buildReportLocked(params, code);
            flowChanged = d.value("flowStateChanged", false);
        }
        if (flowChanged) broadcastFlowState();
        return reply(verb, code, d);
    }

    // ---------------------------------------------------------------- 时间轴（P6 自证：逐字取 durations）
    if (verb == "mission.timeline") {
        // 【引擎】phase::PhaseEngine::durations(missionId) + timeline(missionId)（只读视图，无副作用）
        std::lock_guard<std::mutex> lk(mtx_);
        nlohmann::json d = phaseDurationsLocked();
        nlohmann::json entries = nlohmann::json::array();
#if MA_WITH_PHASE
        if (engines_.phase && !missionId_.empty()) {
            for (const auto& e : engines_.phase->timeline(missionId_)) {
                entries.push_back(nlohmann::json::parse(phase::toJson(e).dump()));
            }
        }
#endif
        d["timeline"] = entries;
        d["step"] = step_;
        d["stepKey"] = flowStepOf(step_) ? flowStepOf(step_)->key : "";
        d["phase"] = phase_;
        d["entry"] = "phase::PhaseEngine::durations / timeline（宿主只搬运）";
        return reply(verb, 0, d);
    }

    // ================================================================ 步 7：媒体通道
    if (verb == "media.channels") {
        nlohmann::json d = mediaChannelsJson(params.value("refresh", false));
        if (params.value("broadcast", false)) {
            if (broadcast_) broadcast_("media.channels", d);
        }
        return reply(verb, 0, d);
    }

    // ================================================================ P7：一键串联
    if (verb == "flow.runAll") {
        // 按 Excel 步序把 11 步一次跑完：每一步都调 `command(...)`（同一个入口）。
        // 注意：这里**不持 mtx_** —— runAll 内部逐个调命令入口，由那些入口各自加锁。
        return runAll(verb, params);
    }

    if (verb == "flow.goto") {
        // 演示/串联用：按步骤号或步骤 key 跳转（不改变任何引擎状态）
        int target = intOr(params, "step", 0);
        if (target == 0) {
            const std::string key = params.value("key", std::string());
            const FlowStep* s = flowStepByKey(key);
            if (!s) return badRequest(verb, "既没有合法 step 也没有合法 key：" + key);
            target = s->step;
        }
        const FlowStep* s = flowStepOf(target);
        if (!s) return badRequest(verb, "step 越界（1..11）：" + std::to_string(target));
        nlohmann::json autoStart = nullptr;
        bool toMedia = false;
        {
            std::lock_guard<std::mutex> lk(mtx_);
            step_ = target;
            if (s->phase[0] != '\0') phase_ = s->phase;
#if MA_WITH_SIM_SOURCE && MA_WITH_INGEST
            // 与 mission.advance 同一条口径：跳到步 6 = 进入任务执行 = 自动起飞
            if (target == 6) autoStart = autoStartSimLocked();
#endif
            toMedia = (target == 7);  // 步 7 才挂媒体面板 → 到这一步广播一次通道清单
        }
        broadcastFlowState();
        if (autoStart.is_object()) broadcastSimState();
        if (toMedia) broadcastMediaChannels();
        nlohmann::json d = nlohmann::json::object();
        d["step"] = step_;
        d["stepKey"] = s->key;
        d["phase"] = phase_;
        if (autoStart.is_object()) {
            d["simAutoStart"] = autoStart;
            d["simNote"] = "已自动起飞（flow.goto 到步 6）";
        }
        return reply(verb, 0, d);
    }

    if (verb == "flow.state") {
        return reply(verb, 0, stateJson());
    }

    return badRequest(verb, "未知 verb：" + verb);
}

}  // namespace ma
