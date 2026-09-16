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

#include <chrono>
#include <filesystem>
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
    : engines_(engines), reg_(reg), cfg_(cfg) {}

FlowEngine::~FlowEngine() {
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
    nlohmann::json out = nlohmann::json::object();
    out["version"] = "mission-app 0.2.0";
    out["ts"] = wallClockMs();

    const FlowStep* s = flowStepOf(step_);
    out["step"] = step_;
    out["stepKey"] = s ? s->key : "";
    out["stepTitle"] = s ? s->title : "";
    out["phase"] = phase_;
    out["missionId"] = missionId_;
    out["enteredAt"] = enteredAtMs_;

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

    // 能力快照（真实读数）：前端做演示与排障都要看它
    if (capabilityProbe_) {
        try {
            out["capabilities"] = capabilityProbe_();
        } catch (const std::exception& e) {
            out["capabilities"] = {{"error", e.what()}};
        }
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

}  // namespace

nlohmann::json FlowEngine::command(const std::string& verb, const nlohmann::json& params) {
    if (verb.empty()) return badRequest(verb, "缺少 verb");

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
            if (step_ > 1) step_ = 1;
        }
        broadcastFlowState();
        if (reloadCode != 0) {
            return reply(verb, reloadCode,
                         {{"message", "规则包重装失败（引擎已保留上一次成功装载的规则）"}});
        }
#else
        {
            std::lock_guard<std::mutex> lk(mtx_);
            if (step_ > 1) step_ = 1;
        }
        broadcastFlowState();
#endif
        nlohmann::json d = nlohmann::json::object();
        d["reset"] = true;
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
        // 【进入任务】：步 3 + 阶段 T0。阶段的**语义**归 phase-engine，这里只对齐取值。
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
        return reply(verb, 0, d);
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
        {
            std::lock_guard<std::mutex> lk(mtx_);
            step_ = target;
            if (s->phase[0] != '\0') phase_ = s->phase;
        }
        broadcastFlowState();
        nlohmann::json d = nlohmann::json::object();
        d["step"] = step_;
        d["stepKey"] = s->key;
        d["phase"] = phase_;
        return reply(verb, 0, d);
    }

    if (verb == "flow.state") {
        return reply(verb, 0, stateJson());
    }

    return badRequest(verb, "未知 verb：" + verb);
}

}  // namespace ma
