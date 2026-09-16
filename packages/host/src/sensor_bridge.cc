// mission-app · packages/host/src/sensor_bridge.cc
//
// 形状适配器实现。三件事，按被调用的顺序：
//   ① SpecTable：读 `data/scenario-1/sensors.json` → SensorSpec（引擎没有规则包入口，
//      规格只能由宿主给），逐条 `validateSpec()` 校验（先体检再上线）。
//   ② GeoRef：lng/lat → sensor_model 的局部平面米（唯一的宿主算术）。
//   ③ SensorBridge::sense()：把 SensorPose 的每个候选折成 TargetState / PlatformPose，
//      调 `SimplifiedSensorModel::sense(...)`，**只把 visible=true 的结果**折回
//      SimObservation 并发给宿主的落账回调。
//
// ★ 本文件里没有任何"概率/可见性"判断：可见与否、概率多少全部由 sensor-model 算。
//   宿主只做单位换算、字段改名与"哪些输入场景数据没给"的如实标注。
#include "ma/sensor_bridge.h"

#include <cmath>
#include <fstream>
#include <sstream>

#include <trantor/utils/Logger.h>

namespace ma::sensor_bridge {

namespace {

using nlohmann::json;

/// JSON 取数（缺字段 → 用引擎的默认值；**不**把 0 当"给了 0"）。
double numOr(const json& j, const char* key, double dflt) {
    const auto it = j.find(key);
    if (it == j.end() || !it->is_number()) return dflt;
    return it->get<double>();
}

int64_t intOr(const json& j, const char* key, int64_t dflt) {
    const auto it = j.find(key);
    if (it == j.end() || !it->is_number_integer()) return dflt;
    return it->get<int64_t>();
}

bool boolOr(const json& j, const char* key, bool dflt) {
    const auto it = j.find(key);
    if (it == j.end() || !it->is_boolean()) return dflt;
    return it->get<bool>();
}

std::string strOr(const json& j, const char* key, const std::string& dflt) {
    const auto it = j.find(key);
    if (it == j.end() || !it->is_string()) return dflt;
    return it->get<std::string>();
}

/// 枚举的字符串口径**从引擎自己的 toString 反查**：这里只做"串 → 枚举"这一段，
/// 取值表与 `sensor_model::toString()` 一一对应（扫一遍 toString 的输出即可核对）。
sensor_model::AimFrame aimFrameOf(const std::string& s) {
    if (s == "world-absolute") return sensor_model::AimFrame::WorldAbsolute;
    if (s == "body-relative") return sensor_model::AimFrame::BodyRelative;
    return sensor_model::AimFrame::BodyRelative;  // 未声明 → 引擎默认（头 :139）
}

sensor_model::ScanPattern scanPatternOf(const std::string& s) {
    if (s == "step-stare") return sensor_model::ScanPattern::StepStare;
    if (s == "continuous-sweep") return sensor_model::ScanPattern::ContinuousSweep;
    return sensor_model::ScanPattern::ContinuousSweep;
}

sensor_model::DecayModel decayModelOf(const std::string& s) {
    if (s == "override") return sensor_model::DecayModel::Override;
    return sensor_model::DecayModel::ByClass;
}

/// 一个候选实体位姿 → sensor_model 的 TargetState。
///
/// 缺口如实标注（MUST NOT 编造）：场景数据没有"目标尺寸/对比度/类型枚举"这三项，
/// 所以 sizeM 用引擎默认 0（= 按基准面积处理）、contrast 用默认 1.0、
/// kind 用 Unknown（引擎口径：Unknown 一律按 Standard 处理）。速度由
/// speedMps + heading 折算成东/北分量（航向正北 0、顺时针为正 —— 与两仓口径一致）。
sensor_model::TargetState targetStateOf(const sim_source::EntityPose& p, const GeoRef& ref) {
    sensor_model::TargetState t;
    t.position = ref.toLocal(p.lng, p.lat, p.altM);
    const double rad = p.heading * 3.14159265358979323846 / 180.0;
    t.velocityEastMps = p.speedMps * std::sin(rad);
    t.velocityNorthMps = p.speedMps * std::cos(rad);
    t.velocityUpMps = 0.0;
    t.kind = sensor_model::TargetKind::Unknown;  // 未声明（见上）
    t.sizeM = 0.0;
    t.contrast = 1.0;
    t.targetId = p.platformId;
    return t;
}

}  // namespace

// ============================================================================
// GeoRef
// ============================================================================

sensor_model::Vec3 GeoRef::toLocal(double lng, double lat, double altM) const {
    sensor_model::Vec3 v;
    if (!valid) return v;
    constexpr double kPi = 3.14159265358979323846;
    constexpr double kEarthR = 6371000.0;
    const double rad = kPi / 180.0;
    v.x = (lng - lng0) * rad * kEarthR * std::cos(lat0 * rad);
    v.y = (lat - lat0) * rad * kEarthR;
    v.z = altM;
    return v;
}

nlohmann::json GeoRef::toJson() const {
    return nlohmann::json{{"lng0", lng0},
                          {"lat0", lat0},
                          {"valid", valid},
                          {"formula", "等距圆柱近似：x=(lng-lng0)·π/180·R·cos(lat0)，"
                                      "y=(lat-lat0)·π/180·R，R=6371000 m"}};
}

// ============================================================================
// SpecTable
// ============================================================================

bool SpecTable::loadFile(const std::string& path, std::string& error) {
    path_ = path;
    items_.clear();
    issues_.clear();

    std::ifstream in(path, std::ios::binary);
    if (!in) {
        error = "打不开传感器规格：" + path;
        return false;
    }
    std::ostringstream buf;
    buf << in.rdbuf();

    json doc;
    try {
        doc = json::parse(buf.str());
    } catch (const std::exception& e) {
        error = std::string("JSON 解析失败：") + e.what();
        return false;
    }
    const auto it = doc.find("sensors");
    if (it == doc.end() || !it->is_array() || it->empty()) {
        error = "sensors.json 缺少非空数组 sensors[]";
        return false;
    }

    for (std::size_t i = 0; i < it->size(); ++i) {
        const json& s = (*it)[i];
        if (!s.is_object()) {
            issues_.push_back("sensors[" + std::to_string(i) + "] 不是对象");
            continue;
        }
        SpecEntry e;
        e.deviceType = strOr(s, "deviceType", std::string());
        sensor_model::SensorSpec& sp = e.spec;
        // 逐字段（照抄 sensor_model.h:134-184 的 31 个字段，不增不减）
        sp.sensorId = strOr(s, "sensorId", std::string());
        sp.sensorType = strOr(s, "sensorType", std::string());
        sp.sensorClass = sensor_model::sensorClassFromString(
            strOr(s, "sensorClass", std::string()), sensor_model::SensorClass::Optical);
        sp.aimFrame = aimFrameOf(strOr(s, "aimFrame", std::string()));
        sp.maxRangeM = numOr(s, "maxRangeM", 0.0);
        sp.referenceRangeM = numOr(s, "referenceRangeM", 0.0);
        sp.beamSensitivityLoss = numOr(s, "beamSensitivityLoss", 0.5);
        sp.azimuthHalfFovDeg = numOr(s, "azimuthHalfFovDeg", 0.0);
        sp.elevationMinDeg = numOr(s, "elevationMinDeg", -90.0);
        sp.elevationMaxDeg = numOr(s, "elevationMaxDeg", 90.0);
        sp.azimuthHalfPowerHalfWidthDeg = numOr(s, "azimuthHalfPowerHalfWidthDeg", 0.0);
        sp.elevationHalfPowerHalfWidthDeg = numOr(s, "elevationHalfPowerHalfWidthDeg", 0.0);
        sp.offAxisFloor = numOr(s, "offAxisFloor", 0.0);
        sp.scanPattern = scanPatternOf(strOr(s, "scanPattern", std::string()));
        sp.scanPeriodMs = intOr(s, "scanPeriodMs", 0);
        sp.sweepSpanDeg = numOr(s, "sweepSpanDeg", -1.0);
        sp.sweepRateDegPerSec = numOr(s, "sweepRateDegPerSec", 0.0);
        sp.dwellPositions = static_cast<int32_t>(intOr(s, "dwellPositions", 1));
        sp.scanPhaseGating = boolOr(s, "scanPhaseGating", false);
        sp.scanPhaseOffsetMs = intOr(s, "scanPhaseOffsetMs", 0);
        sp.contrastCoefficient = numOr(s, "contrastCoefficient", 1.0);
        sp.detectionThreshold = numOr(s, "detectionThreshold", 0.0);
        sp.falseAlarmRate = numOr(s, "falseAlarmRate", 0.0);
        sp.noiseStdDev = numOr(s, "noiseStdDev", 0.0);
        sp.opticalIllumination = numOr(s, "opticalIllumination", 1.0);
        sp.radarCrossSectionM2 = numOr(s, "radarCrossSectionM2", 0.0);
        sp.emitterPowerW = numOr(s, "emitterPowerW", 0.0);
        sp.radarMovingTargetGate = boolOr(s, "radarMovingTargetGate", false);
        sp.sampled = boolOr(s, "sampled", false);
        sp.decayModel = decayModelOf(strOr(s, "decayModel", std::string()));
        sp.decayExponentOverride = numOr(s, "decayExponentOverride", 0.0);

        // 引擎自带的自检：**全部**问题一次返回（不短路）——有问题就记下来，spec 仍保留，
        // 让上层看见"哪条规格哪里不对"，而不是静默丢弃。
        for (const auto& problem : sensor_model::validateSpec(sp)) {
            issues_.push_back("sensors[" + std::to_string(i) + "](" + e.deviceType +
                              ")." + problem);
        }
        if (e.deviceType.empty()) {
            issues_.push_back("sensors[" + std::to_string(i) + "] 缺 deviceType（机型键），"
                              "无法与场景机型对齐");
        }
        items_.push_back(std::move(e));
    }

    if (items_.empty()) {
        error = "sensors.json 里没有可用条目";
        return false;
    }
    return true;
}

const sensor_model::SensorSpec* SpecTable::byDeviceType(const std::string& deviceType) const {
    for (const auto& e : items_) {
        if (e.deviceType == deviceType) return &e.spec;
    }
    return nullptr;
}

nlohmann::json SpecTable::toJson() const {
    nlohmann::json out = nlohmann::json::object();
    out["path"] = path_;
    out["count"] = static_cast<int>(items_.size());
    out["issues"] = issues_;
    nlohmann::json arr = nlohmann::json::array();
    for (const auto& e : items_) {
        const auto& s = e.spec;
        arr.push_back({{"deviceType", e.deviceType},
                       {"sensorId", s.sensorId},
                       {"sensorClass", sensor_model::toString(s.sensorClass)},
                       {"aimFrame", sensor_model::toString(s.aimFrame)},
                       {"scanPattern", sensor_model::toString(s.scanPattern)},
                       {"maxRangeM", s.maxRangeM},
                       {"referenceRangeM", s.referenceRangeM},
                       {"azimuthHalfFovDeg", s.azimuthHalfFovDeg},
                       {"elevationMinDeg", s.elevationMinDeg},
                       {"elevationMaxDeg", s.elevationMaxDeg},
                       {"scanPeriodMs", s.scanPeriodMs},
                       {"detectionThreshold", s.detectionThreshold},
                       {"sampled", s.sampled}});
    }
    out["items"] = std::move(arr);
    return out;
}

// ============================================================================
// SensorBridge
// ============================================================================

SensorBridge::SensorBridge(std::shared_ptr<const SpecTable> specs, GeoRef ref, Options options)
    : specs_(std::move(specs)), ref_(ref), options_(std::move(options)) {
    if (specs_) {
        std::string types;
        for (const auto& e : specs_->items()) {
            if (!types.empty()) types += ",";
            types += e.deviceType;
        }
        if (options_.deviceTypes.empty()) options_.deviceTypes = types;
    }
}

std::string SensorBridge::id() const {
    return std::string("ma::sensor_bridge[") + sensor_model::kSensorModelVersion + "]" +
           (specs_ ? specs_->path() : std::string());
}

std::string SensorBridge::deviceType() const { return options_.deviceTypes; }

void SensorBridge::setDetectionSink(DetectionFn fn) {
    std::lock_guard<std::mutex> lk(mtx_);
    sink_ = std::move(fn);
}

void SensorBridge::setTargetCatalog(const std::map<std::string, TargetInfo>& catalog) {
    auto copy = std::make_shared<std::map<std::string, TargetInfo>>(catalog);
    std::lock_guard<std::mutex> lk(mtx_);
    catalog_ = std::move(copy);
}

void SensorBridge::setEnabled(bool on) {
    std::lock_guard<std::mutex> lk(mtx_);
    options_.enabled = on;
}

bool SensorBridge::enabled() const {
    std::lock_guard<std::mutex> lk(mtx_);
    return options_.enabled;
}

void SensorBridge::setRangeScale(double scale) {
    std::lock_guard<std::mutex> lk(mtx_);
    if (scale > 0.0) options_.rangeScale = scale;
}

double SensorBridge::rangeScale() const {
    std::lock_guard<std::mutex> lk(mtx_);
    return options_.rangeScale;
}

Stats SensorBridge::stats() const {
    std::lock_guard<std::mutex> lk(mtx_);
    return stats_;
}

std::optional<sensor_model::SensorSpec> SensorBridge::effectiveSpec(
    const std::string& deviceType) const {
    if (!specs_) return std::nullopt;
    const sensor_model::SensorSpec* base = specs_->byDeviceType(deviceType);
    if (base == nullptr) return std::nullopt;
    sensor_model::SensorSpec sp = *base;
    double scale = 1.0;
    {
        std::lock_guard<std::mutex> lk(mtx_);
        scale = options_.rangeScale > 0.0 ? options_.rangeScale : 1.0;
    }
    sp.maxRangeM = sp.maxRangeM * scale;
    sp.referenceRangeM = sp.referenceRangeM * scale;
    return sp;
}

std::optional<sensor_model::Coverage> SensorBridge::coverFor(const std::string& deviceType,
                                                             const sensor_model::PlatformPose& pose,
                                                             int64_t nowMs,
                                                             bool sensorSensitivity) const {
    const auto sp = effectiveSpec(deviceType);
    if (!sp.has_value()) return std::nullopt;
    // 遮挡体：场景里的 no-fly / 情报区是**空域**多边形（有高度语义），不是不透明遮挡体；
    // 拿它当 Occluder 会凭空制造遮挡 —— 所以宿主不传（引擎按无遮挡计算），并在回执里点名。
    return model_.cover(pose, *sp, nowMs, {}, sensorSensitivity);
}

std::optional<double> SensorBridge::revisitFor(const std::string& deviceType) const {
    const auto sp = effectiveSpec(deviceType);
    if (!sp.has_value()) return std::nullopt;
    const double ms = model_.revisitPeriodMs(*sp);
    if (!(ms > 0.0)) return std::nullopt;
    return ms;
}

std::vector<sim_source::SimObservation> SensorBridge::sense(const sim_source::SensorPose& pose) {
    std::vector<sim_source::SimObservation> out;

    DetectionFn sink;
    std::shared_ptr<const std::map<std::string, TargetInfo>> catalog;
    bool enabled = true;
    double rangeScale = 1.0;
    std::string obsKind;
    std::string targetPrefix;
    {
        std::lock_guard<std::mutex> lk(mtx_);
        sink = sink_;
        catalog = catalog_;
        enabled = options_.enabled;
        rangeScale = options_.rangeScale > 0.0 ? options_.rangeScale : 1.0;
        obsKind = options_.observationKind;
        targetPrefix = options_.targetDeviceTypePrefix;
        stats_.senseCalls += 1;
        stats_.lastSenseTs = pose.ts;
    }

    if (!enabled) {
        std::lock_guard<std::mutex> lk(mtx_);
        stats_.disabledSkips += 1;
        return out;  // "拔掉传感器"：一条观测都不发（不是把概率改小）
    }

    const sensor_model::SensorSpec* base =
        specs_ ? specs_->byDeviceType(pose.deviceType) : nullptr;
    if (base == nullptr) {
        std::lock_guard<std::mutex> lk(mtx_);
        stats_.specMissing += 1;
        return out;  // 没有规格就不猜（sensors.json 是 SensorSpec 的唯一来源）
    }

    sensor_model::SensorSpec spec = *base;
    spec.maxRangeM *= rangeScale;
    spec.referenceRangeM *= rangeScale;

    sensor_model::PlatformPose self;
    self.position = ref_.toLocal(pose.self.lng, pose.self.lat, pose.self.altM);
    self.headingDeg = pose.self.heading;
    self.platformId = pose.self.platformId;
    // pitch/roll：sim-source 的中立形状里没有（EntityPose 只有 heading）——留引擎默认 0，
    // 并在 statsJson 的 notes 里点名（MUST NOT 猜一个俯仰角出来）。

    for (const auto& cand : pose.candidates) {
        {
            std::lock_guard<std::mutex> lk(mtx_);
            stats_.candidates += 1;
            stats_.byDeviceType[pose.deviceType] += 1;
        }
        const sensor_model::TargetState target = targetStateOf(cand, ref_);
        std::optional<sensor_model::Observation> obs;
        try {
            obs = model_.sense(self, target, spec, pose.ts, {});
        } catch (const std::exception& e) {
            LOG_WARN << "[sensor_bridge] sense 抛异常（已吞掉并继续）：" << e.what();
            obs = std::nullopt;
        }
        {
            std::lock_guard<std::mutex> lk(mtx_);
            stats_.evaluated += 1;
        }
        if (!obs.has_value()) continue;  // 引擎口径：nullopt = 参数非法

        if (!obs->visible) {
            std::lock_guard<std::mutex> lk(mtx_);
            stats_.notVisible += 1;
            continue;  // 不可见 → 不发观测（不编造）
        }

        // ---- 可见：折回 sim_source 的中立形状 ----
        sim_source::SimObservation so;
        so.sensorId = pose.sensorId;
        so.deviceType = pose.deviceType;
        so.kind = obsKind;
        so.targetId = cand.platformId;
        so.targetType = cand.deviceType;
        so.lng = cand.lng;
        so.lat = cand.lat;
        so.altM = cand.altM;
        so.heading = cand.heading;
        so.speedMps = cand.speedMps;
        so.confidence = obs->probability;
        so.ts = pose.ts;
        nlohmann::json ext = nlohmann::json::object();
        ext["sensorClass"] = sensor_model::toString(spec.sensorClass);
        ext["distanceM"] = obs->fov.distanceM;
        ext["azimuthDeg"] = obs->fov.azimuthDeg;
        ext["elevationDeg"] = obs->fov.elevationDeg;
        ext["probability"] = obs->probability;
        ext["factors"] = {{"range", obs->factors.rangeFactor},
                          {"aspect", obs->factors.aspectFactor},
                          {"contrast", obs->factors.contrastFactor},
                          {"raw", obs->factors.probability},
                          {"thresholdApplied", obs->factors.thresholdApplied}};
        if (obs->revisitPeriodMs.has_value()) ext["revisitPeriodMs"] = *obs->revisitPeriodMs;
        ext["isTarget"] = cand.isTarget;
        ext["spec"] = {{"sensorId", spec.sensorId},
                       {"maxRangeM", spec.maxRangeM},
                       {"rangeScale", rangeScale}};
        so.extensions = ext;
        out.push_back(so);

        // ---- 宿主落账面（目标才进台账；平台实体在编组那一步已经登记过）----
        Detection d;
        d.sensorId = pose.sensorId;
        d.platformId = pose.deviceId;
        d.sensorClass = sensor_model::toString(spec.sensorClass);
        d.targetId = cand.platformId;
        d.targetType = cand.deviceType;
        if (catalog) {
            const auto cit = catalog->find(cand.platformId);
            if (cit != catalog->end()) {
                d.targetTypeKey = cit->second.typeKey;
                d.targetName = cit->second.name;
                d.targetNo = cit->second.no;
            }
        }
        d.lng = cand.lng;
        d.lat = cand.lat;
        d.altM = cand.altM;
        d.heading = cand.heading;
        d.speedMps = cand.speedMps;
        d.confidence = obs->probability;
        d.distanceM = obs->fov.distanceM;
        d.azimuthDeg = obs->fov.azimuthDeg;
        d.elevationDeg = obs->fov.elevationDeg;
        d.ts = pose.ts;
        d.hasRevisit = obs->revisitPeriodMs.has_value();
        d.revisitPeriodMs = obs->revisitPeriodMs.value_or(0);
        d.factors = ext["factors"];
        d.note = obs->note;

        {
            std::lock_guard<std::mutex> lk(mtx_);
            stats_.visible += 1;
            stats_.detections += 1;
            if (cand.isTarget) {
                stats_.targetDetections += 1;
            } else {
                stats_.platformDetections += 1;
            }
        }

        // 目标才交出去（平台互探只计数：平台实体在步 5 编组时已入台账）。
        if (cand.isTarget && sink) {
            try {
                sink(d);
            } catch (const std::exception& e) {
                std::lock_guard<std::mutex> lk(mtx_);
                stats_.sinkErrors += 1;
                LOG_WARN << "[sensor_bridge] 落账回调抛异常（已吞掉）：" << e.what();
            }
        }
        (void)targetPrefix;
    }
    return out;
}

nlohmann::json SensorBridge::statsJson() const {
    Stats s;
    Options o;
    {
        std::lock_guard<std::mutex> lk(mtx_);
        s = stats_;
        o = options_;
    }
    nlohmann::json byType = nlohmann::json::object();
    for (const auto& kv : s.byDeviceType) byType[kv.first] = kv.second;

    nlohmann::json out = nlohmann::json::object();
    out["modelId"] = "ma::sensor_bridge";
    out["modelVersion"] = sensor_model::kSensorModelVersion;
    out["enabled"] = o.enabled;            // false = "拔掉传感器"（sense 直接返回空）
    out["rangeScale"] = o.rangeScale;      // 量程缩放（改的是模型入参）
    out["deviceTypes"] = o.deviceTypes;
    out["specSource"] = specs_ ? specs_->path() : "";
    out["specCount"] = specs_ ? static_cast<int>(specs_->items().size()) : 0;
    out["specIssues"] = specs_ ? specs_->issues() : std::vector<std::string>{};
    out["geoRef"] = ref_.toJson();
    out["senseCalls"] = s.senseCalls;
    out["candidates"] = s.candidates;
    out["evaluated"] = s.evaluated;
    out["visible"] = s.visible;
    out["detections"] = s.detections;
    out["notVisible"] = s.notVisible;
    out["specMissing"] = s.specMissing;
    out["disabledSkips"] = s.disabledSkips;
    out["targetDetections"] = s.targetDetections;
    out["platformDetections"] = s.platformDetections;
    out["sinkErrors"] = s.sinkErrors;
    out["lastSenseTs"] = s.lastSenseTs;
    out["byDeviceType"] = std::move(byType);
    out["notes"] = nlohmann::json::array(
        {"俯仰/横滚留空：sim-source 的 EntityPose 只有 heading（sensor_model 的 "
         "PlatformPose.pitchDeg/rollDeg 用引擎默认 0）",
         "遮挡体留空：场景里的 no-fly/情报区是空域多边形（有高度语义），不是不透明遮挡体——"
         "拿它当 Occluder 会凭空制造遮挡，故宿主不传",
         "目标 sizeM/contrast/kind 用 sensor_model 默认（0 / 1.0 / Unknown）："
         "sensors.json 与 targets.json 都没有这三个字段，MUST NOT 编造"});
    return out;
}

}  // namespace ma::sensor_bridge
