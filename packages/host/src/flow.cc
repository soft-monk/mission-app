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
    adoptedPlanId_.clear();
    confirmedPlanId_.clear();
    hasPlanScore_ = false;
    lastPlanRecommendation_.clear();
    lastPlanRecommendedPercent_ = 0;
    step_ = 1;
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
            }
        }
        if (moved) broadcastFlowState();
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
