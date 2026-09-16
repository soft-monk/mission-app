// mission-app · packages/host/include/ma/sensor_bridge.h
//
// **形状适配器**：把 `sim_source::ISensorModel`（仿真源要的探测入口）接到
// `sensor_model::SimplifiedSensorModel`（真实探测模型）上。
//
// 为什么必须有这一层（事实，不是设计偏好）：
//   · 两个模块**刻意互不 include**（各自声明中立形状，见 protocol P1）：
//       sim_source  : SensorPose{deviceId,deviceType,rangeM,ts,self,candidates[]} → vector<SimObservation>
//       sensor_model: sense(PlatformPose, TargetState, SensorSpec, nowMs, occluders) → optional<Observation>
//     形状不同 → 只有宿主能写这本映射。
//   · `sensor-model` **没有规则包装载入口、没有默认型号参数**：SensorSpec 的 31 个字段
//     必须由调用方逐字段给出（引擎头 :131-184）。本适配器的 SpecTable 就读
//     `data/scenario-1/sensors.json`（数据已就绪，且由 `validateSpec()` 逐条校验）。
//
// ★ 纪律（与 flow.cc 同源）：
//   ① **不编观测**：每条 sim_source::SimObservation 都是 sensor_model 真的算出来的；
//      不可见（visible=false）就**不发**观测（引擎口径：不可见时 probability=0）。
//   ② 拿不到的输入**留空**并在 `notes`/JSON 里点名（目标 kind/size/contrast、遮挡体），
//      绝不为了让画面好看去补一个数。
//   ③ 坐标变换是**唯一**的宿主算术：lng/lat → 局部平面米（sensor-model 的中立形状是
//      x=东/y=北/z=高 的米制平面）。参考原点由场景数据给（scenario-data 的 center）。
#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include <sensor_model/sensor_model.h>
#include <sim_source/sim_source.h>

namespace ma::sensor_bridge {

/// lng/lat → 局部平面米（等距圆柱近似；原点 = 场景中心）。
///
/// 为什么用近似而不是投影库：`sensor_model::Vec3` 是**米制局部平面**，场景尺度只有
/// 十几公里，等距圆柱在这个尺度上的畸变远小于探测门限的敏感度；而引入投影库会给
/// 宿主加一个与业务无关的依赖。近似口径写在这里，任何数值都可手算复核。
struct GeoRef {
    double lng0 = 0.0;
    double lat0 = 0.0;
    bool valid = false;

    /// x = 东（米），y = 北（米），z = 高度（米，原样）。
    sensor_model::Vec3 toLocal(double lng, double lat, double altM) const;
    nlohmann::json toJson() const;
};

/// 机型键 → SensorSpec（`sensors.json` 的 sensors[]，逐字段照 SensorSpec）。
struct SpecEntry {
    std::string deviceType;  // = 场景里的机型键（optical/radar/electronic/comm）
    sensor_model::SensorSpec spec;
};

/// `data/scenario-1/sensors.json` 的读取结果。
///
/// 引擎侧没有"读文件"这件事（sensor-model **不读任何文件**），所以规格的来源只能是宿主：
/// 本表就是"谁给 SensorSpec"的答案。逐条跑 `sensor_model::validateSpec()`，问题全记下来。
class SpecTable {
public:
    /// 读文件 + 逐条 validateSpec。返回 false 时 `error`/`issues()` 给出可读原因。
    bool loadFile(const std::string& path, std::string& error);

    const sensor_model::SensorSpec* byDeviceType(const std::string& deviceType) const;
    const std::vector<SpecEntry>& items() const { return items_; }
    const std::vector<std::string>& issues() const { return issues_; }
    const std::string& path() const { return path_; }
    nlohmann::json toJson() const;

private:
    std::string path_;
    std::vector<SpecEntry> items_;
    std::vector<std::string> issues_;
};

/// 场景里一个**目标**的静态身份（来自 scenario-data 的中立结构，宿主只查不改）。
/// 探测只知道"实体 id"，落台账要 `typeKey`（规则包 entityTypes.json 的词汇表）——
/// 这本映射就是那一步，取值全部来自场景数据。
struct TargetInfo {
    std::string id;
    std::string typeKey;
    std::string name;
    std::string deviceType;
    int no = 0;
    bool isTarget = true;
};

/// 一次**通过门限**的观测（= 要落台账的那条事实）。
///
/// 与 `SimObservation` 的分工：SimObservation 是给仿真源的"模型自报结果"（含 extensions），
/// 本结构把其中宿主需要的字段摊平 + 带上逐因子与重访周期，便于落台账与回执追溯。
struct Detection {
    std::string sensorId;      // 做出观测的传感器
    std::string platformId;    // 观测平台（deviceId）
    std::string sensorClass;   // 传感器类别（optical/radar/electronic，取自该机型的 SensorSpec）
    std::string targetId;      // 被发现实体 id
    std::string targetType;    // 被发现实体的 deviceType
    std::string targetTypeKey; // → entity-ledger 的 typeKey（查 TargetCatalog）
    std::string targetName;
    int targetNo = 0;
    double lng = 0.0;
    double lat = 0.0;
    double altM = 0.0;
    double heading = 0.0;
    double speedMps = 0.0;
    double confidence = 0.0;   // = Observation.probability（模型算的，宿主不改）
    double distanceM = 0.0;
    double azimuthDeg = 0.0;
    double elevationDeg = 0.0;
    int64_t ts = 0;            // 仿真毫秒（= SensorPose.ts）
    bool hasRevisit = false;
    int64_t revisitPeriodMs = 0;
    nlohmann::json factors = nlohmann::json::object();  // Observation.factors 逐因子
    std::string note;
};

struct Options {
    /// 关掉 = "拔掉传感器"：`sense()` 直接返回空（**不是**把概率改小），
    /// 用于证明"拔掉传感器 → 目标不再出现"。默认开。
    bool enabled = true;
    /// 量程缩放（> 0）：乘在 spec.maxRangeM / referenceRangeM 上。
    /// 语义是**改模型的入参**（把距离拉远/拉近），不是改结论 —— 观测仍由引擎算。
    double rangeScale = 1.0;
    /// 观测种类（写进 SimObservation.kind；引擎不解释）。
    std::string observationKind = "sensor.detect";
    /// 目标 deviceType 前缀（场景侧口径，默认 tgt-）。
    std::string targetDeviceTypePrefix = "tgt-";
    /// 本模型服务的机型（回执用；引擎不解释 deviceType()）。
    std::string deviceTypes;
};

/// 计数（**全部是实测**：每一次 sense 的去向都能对上）。
struct Stats {
    int64_t senseCalls = 0;        // 引擎调了几次
    int64_t candidates = 0;        // 一共评了多少个候选实体
    int64_t evaluated = 0;         // 真的交给 sensor_model::sense 的次数
    int64_t visible = 0;           // 引擎判可见的次数
    int64_t detections = 0;        // 发出去的观测条数（= visible）
    int64_t notVisible = 0;        // 判不可见（距离/视场/遮蔽/门限）
    int64_t specMissing = 0;       // 该 deviceType 在 sensors.json 里没有规格 → 不猜
    int64_t disabledSkips = 0;     // 被"拔掉"（enabled=false）跳过的次数
    int64_t targetDetections = 0;  // 其中目标是**目标**（isTarget）的条数
    int64_t platformDetections = 0;
    int64_t sinkErrors = 0;        // 宿主回调抛异常次数（吞掉并计数）
    int64_t lastSenseTs = 0;
    std::map<std::string, int64_t> byDeviceType;  // deviceType → 评过的候选数
};

class SensorBridge final : public sim_source::ISensorModel {
public:
    using DetectionFn = std::function<void(const Detection&)>;

    SensorBridge(std::shared_ptr<const SpecTable> specs, GeoRef ref, Options options);

    // ---- sim_source::ISensorModel ----
    std::string id() const override;
    std::string deviceType() const override;
    std::vector<sim_source::SimObservation> sense(const sim_source::SensorPose& pose) override;

    /// 探测结果出口（宿主装：落 entity-ledger）。**可能在仿真驱动线程里被调用**，
    /// 因此实现 MUST 立即返回且自己保证线程安全（与模块对 Sink 的口径一致）。
    void setDetectionSink(DetectionFn fn);

    /// 目标身份表（id → typeKey/name/no）。
    void setTargetCatalog(const std::map<std::string, TargetInfo>& catalog);

    // ---- 控制（"拔掉传感器 / 把距离拉远"的开关；由 verb 驱动）----
    void setEnabled(bool on);
    bool enabled() const;
    void setRangeScale(double scale);
    double rangeScale() const;

    // ---- 只读 ----
    Stats stats() const;
    nlohmann::json statsJson() const;
    const SpecTable& specs() const { return *specs_; }
    const GeoRef& geoRef() const { return ref_; }
    const Options& options() const { return options_; }

    /// 与 `sense()` 同一套入参的**覆盖几何**（sensor.status 的覆盖率来源）。
    std::optional<sensor_model::Coverage> coverFor(const std::string& deviceType,
                                                   const sensor_model::PlatformPose& pose,
                                                   int64_t nowMs,
                                                   bool sensorSensitivity = false) const;
    /// 重访周期（毫秒）。无规格 → nullopt（**不编**）。
    std::optional<double> revisitFor(const std::string& deviceType) const;
    /// 该机型的规格快照（含被 rangeScale 缩放后的有效量程）。
    std::optional<sensor_model::SensorSpec> effectiveSpec(const std::string& deviceType) const;

    const sensor_model::SimplifiedSensorModel& model() const { return model_; }

private:
    std::shared_ptr<const SpecTable> specs_;
    GeoRef ref_;
    Options options_;
    /// `mutable`：引擎的 `cover()` 不是 const 成员（`sense()` / `revisitPeriodMs()` 是）。
    /// 本适配器对 `coverFor()` 用 const 语义（只读几何），所以这里放开这一层限定。
    mutable sensor_model::SimplifiedSensorModel model_{nullptr, 0};

    mutable std::mutex mtx_;
    DetectionFn sink_;
    /// 目标身份表按 shared_ptr 持有：`sense()` 在驱动线程里跑，拷一份 map 太贵。
    std::shared_ptr<const std::map<std::string, TargetInfo>> catalog_;
    Stats stats_;
};

}  // namespace ma::sensor_bridge
