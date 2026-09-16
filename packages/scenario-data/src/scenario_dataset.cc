// mission-app · packages/scenario-data/src/scenario_dataset.cc
//
// 5 个本地配置 → 中立结构。只做读盘、查形状、换字段名、算单位。
#include "ma/scenario/scenario_dataset.h"

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <set>
#include <sstream>
#include <unordered_set>

namespace ma::scenario {

namespace fs = std::filesystem;
using nlohmann::json;
using sim_source::Area;
using sim_source::AreaRole;
using sim_source::FormationSlot;
using sim_source::Hardness;
using sim_source::Platform;
using sim_source::SimScenario;
using sim_source::Target;
using sim_source::TargetMotion;

namespace {

constexpr double kDegToMeter = 111320.0;  // 与 sim-source 的局部平面同量级

std::string readTextFile(const std::string& path, bool& ok) {
    std::ifstream in(path, std::ios::binary);
    if (!in) {
        ok = false;
        return {};
    }
    std::ostringstream buf;
    buf << in.rdbuf();
    ok = true;
    return buf.str();
}

/// 一个文件的读取器：所有"缺字段 / 类型不对"都记成**带文件名与路径**的可读原因。
class Reader {
public:
    Reader(std::string file, const json& root, std::vector<std::string>& issues)
        : file_(std::move(file)), root_(root), issues_(issues) {}

    bool isObject() const { return root_.is_object(); }
    bool has(const char* key) const { return root_.is_object() && root_.contains(key); }
    const json& at(const char* key) const { return root_[key]; }

    void bad(const std::string& path, const std::string& what) {
        issues_.push_back(file_ + ": " + path + " " + what);
    }

    /// 必填字符串。
    std::string reqString(const char* key, const std::string& path) {
        if (!has(key)) {
            bad(path.empty() ? key : path + "." + key, "缺失（MUST 有）");
            return {};
        }
        if (!at(key).is_string()) {
            bad(path.empty() ? key : path + "." + key, "必须是字符串");
            return {};
        }
        return at(key).get<std::string>();
    }

    std::string optString(const char* key, const std::string& dflt = {}) {
        if (!has(key) || !at(key).is_string()) return dflt;
        return at(key).get<std::string>();
    }

    double optNumber(const char* key, double dflt = 0.0) {
        if (!has(key) || !at(key).is_number()) return dflt;
        return at(key).get<double>();
    }

    int optInt(const char* key, int dflt = 0) {
        if (!has(key) || !at(key).is_number_integer()) return dflt;
        return at(key).get<int>();
    }

    bool optBool(const char* key, bool dflt = false) {
        if (!has(key) || !at(key).is_boolean()) return dflt;
        return at(key).get<bool>();
    }

    /// 必填数字（整数也算数字）。
    bool reqNumber(const json& node, const std::string& path, double& out) {
        if (!node.is_number()) {
            bad(path, "必须是数字");
            return false;
        }
        out = node.get<double>();
        return true;
    }

    /// 必填数组。
    const json* reqArray(const char* key, const std::string& path) {
        if (!has(key)) {
            bad(path.empty() ? key : path + "." + key, "缺失（MUST 有）");
            return nullptr;
        }
        if (!at(key).is_array()) {
            bad(path.empty() ? key : path + "." + key, "必须是数组");
            return nullptr;
        }
        return &at(key);
    }

    /// 点 / 顶点环：`[lng, lat]`。
    bool readPoint(const json& node, const std::string& path,
                   std::pair<double, double>& out) {
        if (!node.is_array() || node.size() != 2) {
            bad(path, "必须是 [lng, lat] 两元数组");
            return false;
        }
        double lng = 0.0;
        double lat = 0.0;
        if (!reqNumber(node[0], path + "[0]", lng)) return false;
        if (!reqNumber(node[1], path + "[1]", lat)) return false;
        if (lng < -180.0 || lng > 180.0) {
            bad(path + "[0]", "经度越界（-180..180）：" + std::to_string(lng));
            return false;
        }
        if (lat < -90.0 || lat > 90.0) {
            bad(path + "[1]", "纬度越界（-90..90）：" + std::to_string(lat));
            return false;
        }
        out = {lng, lat};
        return true;
    }

    /// 顶点环（>= 3 个顶点）。空数组视为"没给"（由调用方决定怎么兜）。
    void readRing(const json& node, const std::string& path,
                  std::vector<std::pair<double, double>>& out) {
        if (!node.is_array()) {
            bad(path, "必须是数组");
            return;
        }
        if (node.empty()) return;
        if (node.size() < 3) {
            bad(path, "顶点数不足 3（无法构成区域）");
            return;
        }
        for (std::size_t i = 0; i < node.size(); ++i) {
            std::pair<double, double> p{0.0, 0.0};
            if (!readPoint(node[i], path + "[" + std::to_string(i) + "]", p)) return;
            out.push_back(p);
        }
    }

    /// 字符串数组（非字符串项跳过并记原因）。
    std::vector<std::string> readStringArray(const json& node, const std::string& path) {
        std::vector<std::string> out;
        if (!node.is_array()) {
            bad(path, "必须是数组");
            return out;
        }
        for (std::size_t i = 0; i < node.size(); ++i) {
            if (!node[i].is_string()) {
                bad(path + "[" + std::to_string(i) + "]", "必须是字符串");
                continue;
            }
            out.push_back(node[i].get<std::string>());
        }
        return out;
    }

    /// 从数组里取第 index 项（越界 / 非对象 → 记原因 + 返回 nullptr）。
    const json* item(const json& arr, std::size_t index, const std::string& path) {
        if (!arr.is_array() || index >= arr.size()) {
            bad(path, "越界");
            return nullptr;
        }
        if (!arr[index].is_object()) {
            bad(path, "必须是对象");
            return nullptr;
        }
        return &arr[index];
    }

private:
    std::string file_;
    const json& root_;
    std::vector<std::string>& issues_;
};

/// 多边形（用于 position 退化成方框）。
std::vector<std::pair<double, double>> boxAround(double lng, double lat, double halfM) {
    const double dLng = halfM / (kDegToMeter * std::cos(lat * 3.14159265358979323846 / 180.0));
    const double dLat = halfM / kDegToMeter;
    return {{lng - dLng, lat - dLat},
            {lng + dLng, lat - dLat},
            {lng + dLng, lat + dLat},
            {lng - dLng, lat + dLat}};
}

void centroidOf(const std::vector<std::pair<double, double>>& ring, double& lng, double& lat) {
    lng = 0.0;
    lat = 0.0;
    if (ring.empty()) return;
    for (const auto& p : ring) {
        lng += p.first;
        lat += p.second;
    }
    lng /= static_cast<double>(ring.size());
    lat /= static_cast<double>(ring.size());
}

/// 部署区 → 中立 Area（role 一律 Deploy：那边只有一种"我方部署"语义）。
Area toDeployArea(const DeployArea& a) {
    Area out;
    out.key = a.key;
    out.name = a.name;
    out.role = AreaRole::Deploy;
    out.polygon = a.polygon;
    if (out.polygon.empty() && a.position.has_value()) {
        out.polygon = boxAround(a.position->first, a.position->second, 600.0);
    }
    out.hasHardness = false;
    return out;
}

/// 任务区 / 禁飞区 → 中立 Area。
///
/// 引擎要求"恰好有一个 role=Task 的区域"（航路终点），其余区域一律按 NoFly 处理。
/// 于是：**第一个**任务区的 role 记 Task，其余记 NoFly + soft（只登记、只报告，
/// 不参与绕行 —— 它们不是禁飞区，只是情报/展示区）。
Area toTaskArea(const TaskAreaSpec& a, bool primaryTask) {
    Area out;
    out.key = a.key;
    out.name = a.name;
    out.role = primaryTask ? AreaRole::Task : AreaRole::NoFly;
    out.polygon = a.polygon;
    out.hardness = Hardness::Soft;
    out.hasHardness = true;
    return out;
}

Area toNoFlyArea(const AirspaceZoneSpec& z) {
    Area out;
    out.key = z.key;
    out.name = z.name;
    out.role = AreaRole::NoFly;
    out.polygon = z.polygon;
    out.hardness = (z.hardness == "hard") ? Hardness::Hard : Hardness::Soft;
    out.hasHardness = true;
    return out;
}

std::optional<TargetMotion> motionFrom(const std::string& s) {
    if (s == "static") return TargetMotion::Static;
    if (s == "dynamic") return TargetMotion::Dynamic;
    if (s == "popup") return TargetMotion::Popup;
    return std::nullopt;
}

std::string zeroPadded(int no) {
    std::ostringstream os;
    os.width(3);
    os.fill('0');
    os << no;
    return os.str();
}

}  // namespace

std::string LoadReport::toText() const {
    if (issues.empty()) return ok ? "ok" : "not ok（无原因？）";
    std::ostringstream os;
    for (std::size_t i = 0; i < issues.size(); ++i) {
        if (i != 0) os << "\n  ";
        os << "- " << issues[i];
    }
    return os.str();
}

std::string ScenarioData::groupIdOf(const std::string& groupKey) const {
    for (const auto& kv : groupIds_) {
        if (kv.first == groupKey) return kv.second;
    }
    return {};
}

std::string ScenarioData::pickPrimaryTaskKey() const {
    if (taskAreas.empty()) return {};
    std::size_t best = 0;
    std::size_t bestCount = 0;
    for (std::size_t i = 0; i < taskAreas.size(); ++i) {
        std::size_t count = 0;
        for (const auto& a : aircraft) {
            if (a.taskArea == taskAreas[i].key) ++count;
        }
        if (count > bestCount) {  // 严格大于 → 平票取声明顺序靠前的
            bestCount = count;
            best = i;
        }
    }
    return taskAreas[best].key;
}

// ============================================================================
// 读盘
// ============================================================================

namespace {

/// deployment.json
void readDeployment(const std::string& path, ScenarioData& out, std::vector<std::string>& issues) {
    bool ok = false;
    const std::string text = readTextFile(path, ok);
    if (!ok) {
        issues.push_back("deployment.json: 打不开：" + path);
        return;
    }
    json root;
    try {
        root = json::parse(text);
    } catch (const std::exception& e) {
        issues.push_back(std::string("deployment.json: JSON 解析失败：") + e.what());
        return;
    }
    Reader r("deployment.json", root, issues);
    if (!r.isObject()) {
        issues.push_back("deployment.json: 顶层必须是对象");
        return;
    }
    out.schemaVersion = r.optString("schemaVersion");

    if (const json* areas = r.reqArray("areas", "")) {
        for (std::size_t i = 0; i < areas->size(); ++i) {
            const std::string p = "areas[" + std::to_string(i) + "]";
            const json* it = r.item(*areas, i, p);
            if (it == nullptr) continue;
            Reader ra(p, *it, issues);
            DeployArea a;
            a.key = ra.reqString("key", p);
            a.name = ra.optString("name");
            a.role = ra.optString("role");
            if (a.key.empty()) continue;
            if (ra.has("polygon")) ra.readRing(ra.at("polygon"), p + ".polygon", a.polygon);
            if (ra.has("position")) {
                std::pair<double, double> pos{0.0, 0.0};
                if (ra.readPoint(ra.at("position"), p + ".position", pos)) a.position = pos;
            }
            if (a.polygon.empty() && !a.position.has_value()) {
                ra.bad(p, "既没有有效的 polygon 也没有有效的 position");
                continue;
            }
            out.deployAreas.push_back(std::move(a));
        }
    }

    if (const json* groups = r.reqArray("groups", "")) {
        for (std::size_t i = 0; i < groups->size(); ++i) {
            const std::string p = "groups[" + std::to_string(i) + "]";
            const json* it = r.item(*groups, i, p);
            if (it == nullptr) continue;
            Reader rg(p, *it, issues);
            GroupSpec g;
            g.key = rg.reqString("key", p);
            g.name = rg.optString("name");
            g.role = rg.optString("role");
            if (g.key.empty()) continue;
            out.groups.push_back(std::move(g));
        }
    }

    if (const json* craft = r.reqArray("aircraft", "")) {
        for (std::size_t i = 0; i < craft->size(); ++i) {
            const std::string p = "aircraft[" + std::to_string(i) + "]";
            const json* it = r.item(*craft, i, p);
            if (it == nullptr) continue;
            Reader rc(p, *it, issues);
            AircraftSpec a;
            a.deviceId = rc.reqString("deviceId", p);
            a.typeKey = rc.reqString("typeKey", p);
            a.groupKey = rc.optString("groupKey");
            a.homeArea = rc.reqString("homeArea", p);
            a.taskArea = rc.optString("taskArea");
            a.altM = rc.optNumber("altM", 0.0);
            a.speedMps = rc.optNumber("speedMps", 0.0);
            a.battery = rc.optNumber("battery", 100.0);
            if (rc.has("station")) {
                std::pair<double, double> st{0.0, 0.0};
                if (rc.readPoint(rc.at("station"), p + ".station", st)) {
                    a.stationLng = st.first;
                    a.stationLat = st.second;
                }
            }
            if (rc.has("payload")) a.payload = rc.readStringArray(rc.at("payload"), p + ".payload");
            if (a.deviceId.empty()) continue;
            if (a.altM <= 0.0) rc.bad(p + ".altM", "必须 > 0（巡航高度）");
            if (a.speedMps < 0.0) rc.bad(p + ".speedMps", "必须 >= 0");
            if (a.battery < 0.0 || a.battery > 100.0) rc.bad(p + ".battery", "必须在 0..100");
            out.aircraft.push_back(std::move(a));
        }
    }
}

/// task-areas.json
void readTaskAreas(const std::string& path, ScenarioData& out, std::vector<std::string>& issues) {
    bool ok = false;
    const std::string text = readTextFile(path, ok);
    if (!ok) {
        issues.push_back("task-areas.json: 打不开：" + path);
        return;
    }
    json root;
    try {
        root = json::parse(text);
    } catch (const std::exception& e) {
        issues.push_back(std::string("task-areas.json: JSON 解析失败：") + e.what());
        return;
    }
    Reader r("task-areas.json", root, issues);
    if (!r.isObject()) {
        issues.push_back("task-areas.json: 顶层必须是对象");
        return;
    }

    if (r.has("mission")) {
        if (!r.at("mission").is_object()) {
            r.bad("mission", "必须是对象");
        } else {
            Reader rm("mission", r.at("mission"), issues);
            out.mission.name = rm.optString("name");
            out.mission.type = rm.optString("type");
            out.mission.region = rm.optString("region");
            out.mission.startAt = rm.optString("startAt");
            out.mission.timeRequirement = rm.optString("timeRequirement");
            out.hasMission = true;
        }
    }

    if (r.has("center")) {
        std::pair<double, double> c{0.0, 0.0};
        if (r.readPoint(r.at("center"), "center", c)) {
            out.center = c;
            out.hasCenter = true;
        }
    } else {
        r.bad("center", "缺失（MUST 有：局部平面的锚点）");
    }

    out.zoom = r.optInt("zoom", 0);
    out.minZoom = r.optInt("minZoom", 0);
    out.maxZoom = r.optInt("maxZoom", 0);
    if (out.minZoom > 0 && out.maxZoom > 0 && out.minZoom > out.maxZoom) {
        r.bad("minZoom/maxZoom", "minZoom 不能大于 maxZoom");
    }

    if (const json* areas = r.reqArray("areas", "")) {
        if (areas->empty()) r.bad("areas", "不能为空（至少要有一个任务区）");
        for (std::size_t i = 0; i < areas->size(); ++i) {
            const std::string p = "areas[" + std::to_string(i) + "]";
            const json* it = r.item(*areas, i, p);
            if (it == nullptr) continue;
            Reader ra(p, *it, issues);
            TaskAreaSpec a;
            a.key = ra.reqString("key", p);
            a.name = ra.optString("name");
            a.role = ra.optString("role");
            a.color = ra.optString("color");
            if (a.key.empty()) continue;
            if (!ra.has("polygon")) {
                ra.bad(p + ".polygon", "缺失（MUST 有）");
                continue;
            }
            ra.readRing(ra.at("polygon"), p + ".polygon", a.polygon);
            if (a.polygon.size() < 3) continue;
            out.taskAreas.push_back(std::move(a));
        }
    }
}

/// targets.json
void readTargets(const std::string& path, ScenarioData& out, std::vector<std::string>& issues) {
    bool ok = false;
    const std::string text = readTextFile(path, ok);
    if (!ok) {
        issues.push_back("targets.json: 打不开：" + path);
        return;
    }
    json root;
    try {
        root = json::parse(text);
    } catch (const std::exception& e) {
        issues.push_back(std::string("targets.json: JSON 解析失败：") + e.what());
        return;
    }
    Reader r("targets.json", root, issues);
    if (!r.isObject()) {
        issues.push_back("targets.json: 顶层必须是对象");
        return;
    }

    const json* items = r.reqArray("targets", "");
    if (items == nullptr) return;

    std::set<int> seenNo;
    for (std::size_t i = 0; i < items->size(); ++i) {
        const std::string p = "targets[" + std::to_string(i) + "]";
        const json* it = r.item(*items, i, p);
        if (it == nullptr) continue;
        Reader rt(p, *it, issues);
        TargetSpec t;
        t.no = rt.optInt("no", 0);
        if (t.no <= 0) {
            rt.bad(p + ".no", "必须 > 0");
            continue;
        }
        if (!seenNo.insert(t.no).second) {
            rt.bad(p + ".no", "与前面某项重复：" + std::to_string(t.no));
            continue;
        }
        t.typeKey = rt.reqString("typeKey", p);
        t.name = rt.optString("name");
        t.motion = rt.reqString("motion", p);
        if (!motionFrom(t.motion).has_value()) {
            rt.bad(p + ".motion", "取值非法（static | dynamic | popup）：" + t.motion);
            continue;
        }
        t.speedMps = rt.optNumber("speedMps", 0.0);
        t.loop = rt.optBool("loop", false);
        t.confidence = rt.optNumber("confidence", 1.0);
        if (rt.has("startOffsetMs")) {
            const json& off = rt.at("startOffsetMs");
            if (off.is_number_integer()) {
                t.startOffsetMs = off.get<int64_t>();
            } else {
                rt.bad(p + ".startOffsetMs", "必须是整数（毫秒）");
            }
        }
        if (t.startOffsetMs < 0) {
            rt.bad(p + ".startOffsetMs", "必须 >= 0");
            t.startOffsetMs = 0;
        }
        if (rt.has("route")) rt.readRing(rt.at("route"), p + ".route", t.route);
        if (rt.has("position")) {
            std::pair<double, double> pos{0.0, 0.0};
            if (rt.readPoint(rt.at("position"), p + ".position", pos)) t.position = pos;
        }
        if (rt.has("features")) {
            t.features = rt.readStringArray(rt.at("features"), p + ".features");
        }
        t.threat = rt.optString("threat");
        t.valueTag = rt.optString("valueTag");

        if (t.motion == "static" && !t.position.has_value() && t.route.empty()) {
            rt.bad(p, "static 目标必须给 position（或给 route 的起点）");
            continue;
        }
        if (t.motion == "dynamic" && t.route.size() < 2) {
            rt.bad(p + ".route", "dynamic 目标必须给 >= 2 个航点的 route");
            continue;
        }
        if (t.motion == "dynamic" && t.speedMps <= 0.0) {
            rt.bad(p + ".speedMps", "dynamic 目标必须 > 0");
            continue;
        }
        if (t.motion == "popup" && !t.position.has_value() && t.route.empty()) {
            rt.bad(p, "popup 目标必须给 position 或 route");
            continue;
        }
        t.id = "target-" + zeroPadded(t.no);
        out.targets.push_back(std::move(t));
    }
}

/// airspace.json
void readAirspace(const std::string& path, ScenarioData& out, std::vector<std::string>& issues) {
    bool ok = false;
    const std::string text = readTextFile(path, ok);
    if (!ok) {
        issues.push_back("airspace.json: 打不开：" + path);
        return;
    }
    json root;
    try {
        root = json::parse(text);
    } catch (const std::exception& e) {
        issues.push_back(std::string("airspace.json: JSON 解析失败：") + e.what());
        return;
    }
    Reader r("airspace.json", root, issues);
    if (!r.isObject()) {
        issues.push_back("airspace.json: 顶层必须是对象");
        return;
    }

    const json* zones = r.reqArray("zones", "");
    if (zones == nullptr) return;

    for (std::size_t i = 0; i < zones->size(); ++i) {
        const std::string p = "zones[" + std::to_string(i) + "]";
        const json* it = r.item(*zones, i, p);
        if (it == nullptr) continue;
        Reader rz(p, *it, issues);
        AirspaceZoneSpec z;
        z.key = rz.reqString("key", p);
        z.name = rz.optString("name");
        z.kind = rz.reqString("kind", p);
        z.hardness = rz.optString("hardness");
        z.level = rz.optString("level");
        z.action = rz.optString("action");
        z.color = rz.optString("color");
        z.dashed = rz.optBool("dashed", false);
        z.widthM = rz.optNumber("widthM", 0.0);
        if (z.key.empty()) continue;
        if (rz.has("polygon")) rz.readRing(rz.at("polygon"), p + ".polygon", z.polygon);
        if (rz.has("line")) rz.readRing(rz.at("line"), p + ".line", z.line);
        if (z.polygon.empty() && z.line.empty()) {
            rz.bad(p, "既没有 polygon 也没有 line");
            continue;
        }
        if (z.kind == "no-fly") {
            if (z.polygon.size() < 3) {
                rz.bad(p + ".polygon", "禁飞区必须有 >= 3 个顶点的 polygon");
                continue;
            }
            if (z.hardness != "hard" && z.hardness != "soft") {
                rz.bad(p + ".hardness", "取值非法（hard | soft）：" + z.hardness);
                continue;
            }
        }
        if (z.kind == "no-fly") out.hardNoFlyZones.push_back(z);
        out.zones.push_back(std::move(z));
    }
}

/// map-style.json（形状校验；取值原样留着）
void readMapStyle(const std::string& path, ScenarioData& out, std::vector<std::string>& issues) {
    bool ok = false;
    const std::string text = readTextFile(path, ok);
    if (!ok) {
        issues.push_back("map-style.json: 打不开：" + path);
        return;
    }
    json root;
    try {
        root = json::parse(text);
    } catch (const std::exception& e) {
        issues.push_back(std::string("map-style.json: JSON 解析失败：") + e.what());
        return;
    }
    Reader r("map-style.json", root, issues);
    if (!r.isObject()) {
        issues.push_back("map-style.json: 顶层必须是对象");
        return;
    }
    if (!r.has("schemaVersion")) r.bad("schemaVersion", "缺失（MUST 有）");

    MapStyle& s = out.mapStyle;

    auto readPoint = [&issues](const json& node, const std::string& p, MapPointStyle& out_) {
        if (!node.is_object()) {
            issues.push_back("map-style.json: " + p + " 必须是对象");
            return;
        }
        Reader rp(p, node, issues);
        out_.radiusPx = rp.optInt("radiusPx", 0);
        out_.color = rp.optString("color");
        out_.strokeColor = rp.optString("strokeColor");
        out_.strokeWidthPx = rp.optInt("strokeWidthPx", 0);
    };

    if (r.has("drone")) {
        if (!r.at("drone").is_object()) {
            r.bad("drone", "必须是对象");
        } else {
            Reader rd("drone", r.at("drone"), issues);
            s.droneIcon.useIcon = rd.optBool("useIcon", false);
            if (rd.has("icon")) {
                if (!rd.at("icon").is_object()) {
                    rd.bad("drone.icon", "必须是对象");
                } else {
                    Reader ri("icon", rd.at("icon"), issues);
                    s.droneIcon.url = ri.optString("url");
                    s.droneIcon.anchor = ri.optString("anchor");
                    if (ri.has("sizePx")) {
                        const json& sz = ri.at("sizePx");
                        if (sz.is_array() && sz.size() == 2 && sz[0].is_number_integer()) {
                            s.droneIcon.sizePx = sz[0].get<int>();
                        } else {
                            ri.bad("drone.icon.sizePx", "必须是 [宽, 高] 两元整数数组");
                        }
                    }
                }
            }
            if (rd.has("point")) readPoint(rd.at("point"), "drone.point", s.dronePoint);
            if (rd.has("byType")) {
                if (!rd.at("byType").is_object()) {
                    rd.bad("drone.byType", "必须是对象（typeKey → 覆盖项）");
                } else {
                    for (auto it = rd.at("byType").begin(); it != rd.at("byType").end(); ++it) {
                        if (!it.value().is_object() || !it.value().contains("point")) continue;
                        MapPointStyle ps;
                        readPoint(it.value()["point"], "drone.byType." + it.key() + ".point", ps);
                        s.dronePointByType[it.key()] = ps;
                    }
                }
            }
        }
    } else {
        r.bad("drone", "缺失（MUST 有）");
    }

    if (r.has("track")) {
        if (!r.at("track").is_object()) {
            r.bad("track", "必须是对象");
        } else {
            Reader rt("track", r.at("track"), issues);
            s.track.widthPx = rt.optInt("widthPx", 0);
            s.track.dashed = rt.optBool("dashed", false);
            s.track.color = rt.optString("color");
            s.track.opacity = rt.optNumber("opacity", 0.0);
        }
    } else {
        r.bad("track", "缺失（MUST 有）");
    }

    if (r.has("groupColors")) {
        if (!r.at("groupColors").is_object()) {
            r.bad("groupColors", "必须是对象（groupKey → 颜色）");
        } else {
            for (auto it = r.at("groupColors").begin(); it != r.at("groupColors").end(); ++it) {
                if (!it.value().is_string()) {
                    r.bad("groupColors." + it.key(), "必须是字符串");
                    continue;
                }
                s.groupColors[it.key()] = it.value().get<std::string>();
            }
        }
    } else {
        r.bad("groupColors", "缺失（MUST 有）");
    }

    if (r.has("target")) {
        if (!r.at("target").is_object()) {
            r.bad("target", "必须是对象");
        } else {
            Reader rt("target", r.at("target"), issues);
            s.targetPoint.radiusPx = rt.optInt("radiusPx", 0);
            s.highColor = rt.optString("highColor");
            s.midColor = rt.optString("midColor");
            s.lowColor = rt.optString("lowColor");
        }
    } else {
        r.bad("target", "缺失（MUST 有）");
    }
}

}  // namespace

bool load(const std::string& dir, ScenarioData& out, LoadReport& report, const FileSet& files) {
    report = LoadReport{};
    out = ScenarioData{};

    std::error_code ec;
    if (!fs::exists(dir, ec) || !fs::is_directory(dir, ec)) {
        report.issues.push_back("目录不存在或不是目录：" + dir);
        report.ok = false;
        return false;
    }

    out.dir = fs::absolute(fs::path(dir), ec).string();
    out.scenarioKey = fs::path(out.dir).filename().string();
    out.wireType = "uav";
    out.targetTypePrefix = "tgt-";

    std::vector<std::string> issues;
    const fs::path base(out.dir);
    readDeployment((base / files.deployment).string(), out, issues);
    readTaskAreas((base / files.taskAreas).string(), out, issues);
    readTargets((base / files.targets).string(), out, issues);
    readAirspace((base / files.airspace).string(), out, issues);
    readMapStyle((base / files.mapStyle).string(), out, issues);

    // 归属表：声明顺序 + 1；被引用但没声明的组按首次出现顺序追加。
    std::unordered_set<std::string> declared;
    int next = 1;
    for (const auto& g : out.groups) {
        if (g.key.empty() || !declared.insert(g.key).second) continue;
        out.groupIds_.push_back({g.key, "g" + std::to_string(next++)});
    }
    for (const auto& a : out.aircraft) {
        if (a.groupKey.empty()) continue;
        if (!declared.insert(a.groupKey).second) continue;
        issues.push_back("deployment.json: aircraft " + a.deviceId + " 引用了未声明的 groupKey：'" +
                         a.groupKey + "'（已按出现顺序补号）");
        out.groupIds_.push_back({a.groupKey, "g" + std::to_string(next++)});
    }

    // 交叉引用：aircraft.homeArea / taskArea 必须能找到。
    std::unordered_set<std::string> deployKeys;
    for (const auto& a : out.deployAreas) deployKeys.insert(a.key);
    std::unordered_set<std::string> taskKeys;
    for (const auto& a : out.taskAreas) taskKeys.insert(a.key);

    if (out.aircraft.empty()) issues.push_back("deployment.json: aircraft 为空（没有能动的东西）");
    for (const auto& a : out.aircraft) {
        if (!deployKeys.count(a.homeArea)) {
            issues.push_back("deployment.json: aircraft " + a.deviceId + ".homeArea 指向不存在的部署区：'" +
                             a.homeArea + "'");
        }
        if (!a.taskArea.empty() && !taskKeys.count(a.taskArea)) {
            issues.push_back("deployment.json: aircraft " + a.deviceId + ".taskArea 指向不存在的任务区：'" +
                             a.taskArea + "'");
        }
    }

    // 归属自检：颜色表里出现的组键都该被声明过（只提醒，不拦）。
    for (const auto& kv : out.mapStyle.groupColors) {
        if (!declared.count(kv.first)) {
            issues.push_back("map-style.json: groupColors 里的 '" + kv.first +
                             "' 在 deployment.json 的 groups 里没有对应项");
        }
    }

    // 站位偏移：station 相对 homeArea 质心（东 / 北，米）。
    for (auto& a : out.aircraft) {
        const DeployArea* home = nullptr;
        for (const auto& d : out.deployAreas) {
            if (d.key == a.homeArea) {
                home = &d;
                break;
            }
        }
        if (home == nullptr) continue;
        std::vector<std::pair<double, double>> ring = home->polygon;
        if (ring.empty() && home->position.has_value()) {
            ring = boxAround(home->position->first, home->position->second, 600.0);
        }
        double cLng = 0.0;
        double cLat = 0.0;
        centroidOf(ring, cLng, cLat);
        if (ring.empty()) {
            cLng = home->position->first;
            cLat = home->position->second;
        }
        const double cosLat = std::cos(cLat * 3.14159265358979323846 / 180.0);
        a.offsetEastM = (a.stationLng - cLng) * kDegToMeter * cosLat;
        a.offsetNorthM = (a.stationLat - cLat) * kDegToMeter;
    }

    report.issues = issues;
    report.ok = issues.empty();
    return report.ok;
}

bool loadScenario(const std::string& dir, ScenarioData& out, SimScenario& scenario,
                  LoadReport& report, const FileSet& files) {
    if (!load(dir, out, report, files)) return false;
    LoadReport toSim;
    if (!out.toSimScenario(scenario, toSim)) {
        report.issues.insert(report.issues.end(), toSim.issues.begin(), toSim.issues.end());
        report.ok = false;
        return false;
    }
    return true;
}

// ============================================================================
// 中立结构映射
// ============================================================================

bool ScenarioData::toSimScenario(SimScenario& out, LoadReport& report) const {
    out = SimScenario{};
    report = LoadReport{};
    std::vector<std::string> issues;

    out.scenarioKey = scenarioKey;

    // ---- 区域：部署区（role=deploy）+ **一个**主任务区（role=task）+ 其余登记项
    for (const auto& d : deployAreas) out.areas.push_back(toDeployArea(d));

    const std::string primaryTaskKey = pickPrimaryTaskKey();
    int taskRoleTaken = 0;
    for (const auto& t : taskAreas) {
        const bool primary = (!primaryTaskKey.empty() && t.key == primaryTaskKey);
        if (primary) ++taskRoleTaken;
        out.areas.push_back(toTaskArea(t, primary));
    }
    if (taskRoleTaken == 0) {
        issues.push_back("task-areas.json: 一个任务区都没标成主任务区（航路没有终点）");
    }

    for (const auto& z : zones) {
        if (z.kind != "no-fly") continue;  // 情报区不进仿真（只登记）
        out.areas.push_back(toNoFlyArea(z));
    }

    // ---- 编组
    for (const auto& g : groups) {
        sim_source::Group sg;
        sg.key = g.key;
        sg.name = g.name;
        sg.role = g.role;
        out.groups.push_back(std::move(sg));
    }

    // ---- 平台（= aircraft[]）
    //
    // 出发点：引擎只认"部署区质心 + 位形偏移"，所以 homeAreaKey 统一取部署区，
    // 每个平台站位与质心之差进 startOffset；taskAreaKey 是各自的终点区
    // —— 但引擎只允许**一个** role=task 的区域，所以终点统一取主任务区。
    for (const auto& a : aircraft) {
        Platform p;
        p.deviceId = a.deviceId;
        p.deviceType = a.typeKey;  // 线格式的 `type` = **机型**（optical/radar/electronic/comm）
                                   // —— 前端与 map-2d 的 UavType 就是这四个值，用来按机型配色。
                                   // 不能用全局 wireType（那会让所有机型都变成同一个值）。
        p.kind = "uav.pos";       // 本场景的平台事件名（与 SimOptions::defaultKind 一致）
        p.groupKey = a.groupKey;
        p.homeAreaKey = deployAreas.empty() ? std::string() : deployAreas.front().key;
        p.taskAreaKey = primaryTaskKey;
        p.altM = a.altM;
        p.speedMps = a.speedMps;
        p.battery = a.battery;
        p.startOffset.rightM = a.offsetEastM;
        p.startOffset.fwdM = a.offsetNorthM;
        out.platforms.push_back(std::move(p));
    }

    // ---- 目标（= targets[]）
    //
    // 两点单位换算（引擎的口径，不是配置的口径）：
    //   · 引擎要"至少 2 个航路点"才算走航线 —— 只给了 position 的情形在这里退化成
    //     "一个点重复两次"（= 原地不动，位置仍然是配置给的那个）；
    //   · 会动的目标必须有正速度 —— 没给就取引擎的默认巡航速度
    //     （`SimOptions::defaultSpeedMps`，装配层注入）。
    const double fallbackTargetSpeedMps = 20.0;
    for (const auto& t : targets) {
        Target tg;
        tg.no = t.no;
        tg.id = t.id;
        tg.typeKey = t.typeKey;
        tg.deviceType = targetTypePrefix + t.typeKey;
        tg.kind = "uav.pos";
        tg.name = t.name;
        tg.motion = motionFrom(t.motion).value_or(TargetMotion::Static);
        tg.route = t.route;
        if (t.position.has_value()) {
            tg.hasPosition = true;
            tg.position = *t.position;
        } else if (!t.route.empty()) {
            tg.hasPosition = true;
            tg.position = t.route.front();
        }
        const bool moving = (tg.motion == TargetMotion::Dynamic || tg.motion == TargetMotion::Popup);
        if (tg.route.empty()) {
            // 只给点的目标：用两个相同点表达"原地"（引擎要求 >= 2 个航点）。
            if (tg.hasPosition) tg.route = {tg.position, tg.position};
        } else if (tg.route.size() == 1) {
            tg.route.push_back(tg.route.front());
        }
        if (moving) {
            tg.speedMps = (t.speedMps > 0.0) ? t.speedMps : fallbackTargetSpeedMps;
        } else {
            tg.speedMps = t.speedMps;
        }
        tg.loop = t.loop;
        tg.startOffsetMs = t.startOffsetMs;
        tg.confidence = t.confidence;
        // 注：`sim_source::Target` **没有**宿主扩展位（只有 SimEvent 有），
        // 所以 threat / valueTag / features 这类展示用取值留在 ScenarioData.targets 里，
        // 不进中立结构 —— 引擎不认识它们，也不该认识。
        out.targets.push_back(std::move(tg));
    }

    report.issues = issues;
    report.ok = true;  // issues 只是提醒；硬问题在 load() 就拦下了
    return true;
}

}  // namespace ma::scenario
