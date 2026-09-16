// mission-app · packages/host/src/registry.cc
#include "ma/registry.h"

#include <nlohmann/json.hpp>

namespace ma {

void Registry::set(const std::string& key, bool linked, bool instantiated,
                   const std::string& note) {
    std::lock_guard<std::mutex> lk(mtx_);
    for (auto& e : items_) {
        if (e.key == key) {
            e.linked = linked;
            e.instantiated = instantiated;
            e.ok = instantiated;
            e.note = note;
            return;
        }
    }
    EngineEntry e;
    e.key = key;
    e.linked = linked;
    e.instantiated = instantiated;
    e.ok = instantiated;
    e.note = note;
    items_.push_back(std::move(e));
}

std::string Registry::readyLine() const {
    std::lock_guard<std::mutex> lk(mtx_);
    std::string line = "[host] engines ready:";
    for (const auto& e : items_) {
        line += " " + e.key + "=" + (e.instantiated ? "1" : "0");
    }
    return line;
}

std::string Registry::statsJson(const std::string& version,
                                const nlohmann::json& extra) const {
    std::lock_guard<std::mutex> lk(mtx_);
    nlohmann::ordered_json out;
    out["version"] = version;
    out["engines"] = nlohmann::ordered_json::object();
    for (const auto& e : items_) {
        nlohmann::ordered_json row;
        row["linked"] = e.linked;
        row["instantiated"] = e.instantiated;
        row["ok"] = e.ok;
        if (!e.note.empty()) row["note"] = e.note;
        out["engines"][e.key] = std::move(row);
    }
    // 附加段：本账本不认识它们的内容，只负责原样带上（键不覆盖 engines）。
    if (extra.is_object()) {
        for (auto it = extra.begin(); it != extra.end(); ++it) {
            if (it.key() == "engines" || it.key() == "version") continue;
            out[it.key()] = it.value();
        }
    }
    return out.dump();
}

std::vector<EngineEntry> Registry::entries() const {
    std::lock_guard<std::mutex> lk(mtx_);
    return items_;
}

std::vector<EngineEntry> Registry::notInstantiated() const {
    std::lock_guard<std::mutex> lk(mtx_);
    std::vector<EngineEntry> out;
    for (const auto& e : items_) {
        if (!e.instantiated) out.push_back(e);
    }
    return out;
}

}  // namespace ma
