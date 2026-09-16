// mission-app · packages/host/include/ma/policies_loader.h
//
// 规则包装载器：逐引擎调**它自己的**入口，把 `<webMapRoot>/<module>/policies/mapapp/` 装进去。
// 失败不抛、不阻断装配，逐条记 code 与原因（给日志与 `/stats` 用）。
#pragma once

#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "ma/engines.h"

namespace ma {

struct PolicyLoadRow {
    std::string engine;  // 短名（phase / resource / scoring / ledger/entityTypes / …）
    std::string path;    // 实际读取的路径（目录类入口给目录）
    int code = 0;        // protocol §3 码表：0 成功；1000/1006 失败
    std::string note;    // 引擎给的可读信息
};

struct PolicyLoadReport {
    std::vector<PolicyLoadRow> rows;

    bool allLoaded() const {
        for (const auto& r : rows) {
            if (r.code != 0) return false;
        }
        return !rows.empty();
    }
    int loaded() const {
        int n = 0;
        for (const auto& r : rows) {
            if (r.code == 0) ++n;
        }
        return n;
    }
    std::string summary() const;
    nlohmann::json toJson() const;
};

/// 装载全部规则包。`webMapRoot` = 各模块仓的父目录（CMake 里的 `MA_WEBMAP_ROOT`）。
PolicyLoadReport loadEnginePolicies(Engines& engines, const std::string& webMapRoot);

}  // namespace ma
