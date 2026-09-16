// mission-app · packages/host/src/policies_loader.cc
//
// **规则包装载器**：把各模块仓 `policies/mapapp/` 下的规则包，用**各模块自己的入口**装进引擎。
//
// 为什么必须有这一层（而不是"各引擎自带默认路径"）：
//   ① 全工程**没有一个仓叫 `setPolicies`** —— 入口名各仓不同（`loadDefinition` /
//      `loadPolicies` / `loadPoliciesFromDirectory` / `policiesFromDir` / `loadPolicyFile` /
//      `loadRulesFromDirectory`），只有宿主知道该调哪个；
//   ② 引擎里**没有默认路径**（`policies/mapapp/...` 只是 examples 的编译期宏），
//      路径必须由宿主显式给出 —— 这里用 CMake 传进来的 `MA_WEBMAP_ROOT` 拼；
//   ③ 未装载规则时，凡"需规则"的入口一律返 1005 —— 症状是"界面点了没反应"，
//      所以装载失败**必须如实上报**（日志 + `/stats` 的 policies 段），MUST NOT 静默。
//
// ★ 纪律：本层只做"读文件 → 调入口 → 记结果"。它不解释规则内容、不做业务判断。
#include "ma/policies_loader.h"

#include <filesystem>
#include <sstream>

#include <trantor/utils/Logger.h>

namespace ma {

namespace fs = std::filesystem;

namespace {

/// 读一个 JSON 文件（读不到/非法 → 空 + 原因）。规则包一律按 UTF-8 文本读。
bool readJson(const std::string& path, nlohmann::json& out, std::string& err) {
    std::string text;
    if (!readTextFile(path, text)) {
        err = "文件读不到";
        return false;
    }
    try {
        out = nlohmann::json::parse(text);
    } catch (const std::exception& e) {
        err = std::string("JSON 解析失败：") + e.what();
        return false;
    }
    return true;
}

}  // namespace

nlohmann::json PolicyLoadReport::toJson() const {
    nlohmann::json arr = nlohmann::json::array();
    for (const auto& r : rows) {
        arr.push_back(nlohmann::json{{"engine", r.engine},
                                     {"path", r.path},
                                     {"code", r.code},
                                     {"ok", r.code == 0},
                                     {"note", r.note}});
    }
    nlohmann::json out = nlohmann::json::object();
    out["loaded"] = loaded();
    out["total"] = static_cast<int>(rows.size());
    out["rows"] = arr;
    return out;
}

std::string PolicyLoadReport::summary() const {
    int ok = 0;
    std::ostringstream bad;
    for (const auto& r : rows) {
        if (r.code == 0) {
            ++ok;
        } else {
            if (bad.tellp() > 0) bad << "；";
            bad << r.engine << "(code=" << r.code << " " << r.note << ")";
        }
    }
    std::ostringstream os;
    os << ok << "/" << rows.size() << " 装载成功";
    if (bad.tellp() > 0) os << "；失败：" << bad.str();
    return os.str();
}

PolicyLoadReport loadEnginePolicies(Engines& engines, const std::string& webMapRoot) {
    PolicyLoadReport rep;
    const fs::path root(webMapRoot);

    auto dir = [&root](const char* module) {
        return (root / module / "policies" / "mapapp").string();
    };
    auto file = [&root](const char* module, const char* name) {
        return (root / module / "policies" / "mapapp" / name).string();
    };
    auto push = [&rep](const std::string& engine, const std::string& path, int code,
                       const std::string& note) {
        rep.rows.push_back(PolicyLoadRow{engine, path, code, note});
        if (code == 0) {
            LOG_INFO << "[policies] " << engine << " ← " << path;
        } else {
            LOG_WARN << "[policies] " << engine << " 装载失败 code=" << code << "：" << path
                     << "（" << note << "）";
        }
    };

    // ---- phase-engine：kind="phases"
#if MA_WITH_PHASE
    if (engines.phase) {
        const std::string p = file("phase-engine", "phases.json");
        const auto r = engines.phase->loadDefinitionFile(p);
        push("phase", p, r.code, r.message);
    }
#endif

    // ---- resource-alloc：目录（deviceTypes.json + resourceRules.json）
#if MA_WITH_RESOURCE
    if (engines.resource) {
        const std::string d = dir("resource-alloc");
        const auto r = engines.resource->loadPoliciesFromDirectory(d);
        push("resource", d, r.code, r.message);
    }
#endif

    // ---- scoring：目录（scoringMetrics.json + planTemplates.json）
#if MA_WITH_SCORING
    if (engines.scoringEngine) {
        const std::string d = dir("scoring");
        const auto r = engines.scoringEngine->policiesFromDir(d);
        push("scoring", d, r.code, r.message);
    }
#endif

    // ---- entity-ledger：**两个包、两次调用**（entityTypes + threatFactors）
#if MA_WITH_LEDGER
    if (engines.entityLedger) {
        const std::string p1 = file("entity-ledger", "entityTypes.json");
        const auto r1 = engines.entityLedger->loadPoliciesFile(p1);
        push("ledger/entityTypes", p1, r1.code, r1.message);
        const std::string p2 = file("entity-ledger", "threatFactors.json");
        const auto r2 = engines.entityLedger->loadPoliciesFile(p2);
        push("ledger/threatFactors", p2, r2.code, r2.message);
    }
#endif

    // ---- topology：单文件 linkThresholds.json（入口名是单数 loadPolicyFile）
#if MA_WITH_TOPOLOGY
    if (engines.topologyEngine) {
        const std::string p = file("topology", "linkThresholds.json");
        const auto r = engines.topologyEngine->loadPolicyFile(p);
        push("topology", p, r.code, r.message);
    }
#endif

    // ---- alert-engine：目录（固定读 <dir>/alertRules.json）
#if MA_WITH_ALERT
    if (engines.alertEngine) {
        const std::string d = dir("alert-engine");
        const auto r = engines.alertEngine->loadRulesFromDirectory(d);
        push("alert", d, r.code, r.message);
    }
#endif

    // ---- report-engine：kind="reportFields"（宿主自己读文件，再交给引擎）
    //
    // 注意：report-engine 的 `loadPoliciesFile` 是**故意恒失败的占位**（其源码里写明），
    // 所以这里必须"宿主读 JSON → loadPolicies(json)"这条路。
#if MA_WITH_REPORT
    if (engines.reportEngine) {
        const std::string p = file("report-engine", "reportFields.json");
        nlohmann::json pkg;
        std::string err;
        if (readJson(p, pkg, err)) {
            const auto r = engines.reportEngine->loadPolicies(pkg);
            push("report", p, r.code, r.message);
        } else {
            push("report", p, 1000, err);
        }
    }
#endif

    // ---- view-composer：目录（viewModes.json + layerMapping.json）
    //
    // 注意字段名与本仓其它引擎**不一样**：`view_composer::PoliciesResult` 是
    // `{ok, code(ErrorCode 枚举), reason, issues[], warnings[], info, loadedFileCount}` ——
    // 没有 `message`，可读原因在 `reason` 里（头 view_composer.h:471-479）。
#if MA_WITH_VIEW_COMPOSER
    if (engines.viewComposer) {
        const std::string d = dir("view-composer");
        const auto r = engines.viewComposer->loadPoliciesDir(d);
        std::string note = r.reason.empty() ? std::string("ok") : r.reason;
        if (!r.ok) {
            for (const auto& i : r.issues) {
                note += " " + i.path + "." + i.field + ":" + i.reason;
            }
        }
        push("viewComposer", d, static_cast<int>(r.code), note);
    }
#endif

    return rep;
}

}  // namespace ma
