// mission-app · packages/scenario-data/include/ma/scenario/scenario_dataset.h
//
// 本地配置 → 中立结构的**唯一翻译层**。
//
// 输入是 data/scenario-1/ 下那 5 个文件（字段名由配置作者冻结，本层 MUST NOT 改名）：
//   deployment.json   areas[] + groups[] + aircraft[]
//   task-areas.json   mission{} + center/zoom + areas[]
//   targets.json      targets[]
//   airspace.json     zones[]（含禁飞区与情报区）
//   map-style.json    显示口径（本层只做形状校验，取值原样留着给前端）
//
// 输出是两份东西：
//   1) sim_source::SimScenario —— 喂给 sim-source（它只认中立结构，不认识本仓的 JSON）
//   2) 归属表 groupKey → groupId —— 上路时要用（线格式里的 groupId 就是它）
//
// ★ 纪律：本层只做"读文件 / 查形状 / 换字段名 / 算单位"。
//   没有运动学、没有判定、不开套接字、不认识任何设备协议。
#pragma once

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include <sim_source/sim_source.h>

namespace ma::scenario {

/// 本层覆盖的 5 个配置文件名。
struct FileSet {
    std::string deployment = "deployment.json";
    std::string taskAreas = "task-areas.json";
    std::string targets = "targets.json";
    std::string airspace = "airspace.json";
    std::string mapStyle = "map-style.json";
};

/// 读盘结果。**不抛异常**：任何缺失 / 类型错都变成一条可读 issue。
struct LoadReport {
    bool ok = false;
    std::vector<std::string> issues;  // 每条形如 `deployment.json: aircraft[3].altM 必须是数字`
    std::string toText() const;
};

// ---------------------------------------------------------------- 显示口径（原样带走）
struct MapPointStyle {
    int radiusPx = 0;
    std::string color;
    std::string strokeColor;
    int strokeWidthPx = 0;
};

struct MapTrackStyle {
    int widthPx = 0;
    bool dashed = false;
    std::string color;
    double opacity = 0.0;
};

struct MapIconStyle {
    bool useIcon = false;
    std::string url;
    int sizePx = 0;
    std::string anchor;
};

/// map-style.json 的**形状**（取值不解释、不裁剪）。
struct MapStyle {
    MapIconStyle droneIcon;
    MapPointStyle dronePoint;
    std::map<std::string, MapPointStyle> dronePointByType;  // typeKey → 覆盖
    MapTrackStyle track;
    std::map<std::string, std::string> groupColors;  // groupKey → 颜色
    MapPointStyle targetPoint;
    std::string highColor;
    std::string midColor;
    std::string lowColor;
};

// ---------------------------------------------------------------- 逐文件形状

/// deployment.json · areas[] 一项。给了 position 而不是 polygon 就退化成 4 顶点方框。
struct DeployArea {
    std::string key;
    std::string name;
    std::string role;  // 配置里的原值（本层只比对，不改写）
    std::vector<std::pair<double, double>> polygon;  // [lng, lat] 顶点环
    std::optional<std::pair<double, double>> position;
};

struct GroupSpec {
    std::string key;
    std::string name;
    std::string role;
};

/// deployment.json · aircraft[] 一项。
struct AircraftSpec {
    std::string deviceId;
    std::string typeKey;   // 显示与登记用的细分键（optical / radar / …）
    std::string groupKey;  // 归属键；空 = 不成组
    std::string homeArea;  // 部署区 key
    std::string taskArea;  // 任务区 key（task-areas.json 里的某一条）
    double stationLng = 0.0;
    double stationLat = 0.0;
    double altM = 0.0;
    double speedMps = 0.0;
    double battery = 100.0;
    std::vector<std::string> payload;
    /// 站位相对部署区质心的偏移（米，东 / 北）—— 上路前由 toSimScenario 填。
    double offsetEastM = 0.0;
    double offsetNorthM = 0.0;
};

/// task-areas.json · mission{} 原样带走（本层不解释）。
struct MissionMeta {
    std::string name;
    std::string type;
    std::string region;
    std::string startAt;
    std::string timeRequirement;
};

struct TaskAreaSpec {
    std::string key;
    std::string name;
    std::string role;
    std::string color;
    std::vector<std::pair<double, double>> polygon;
};

/// airspace.json · zones[] 一项。
/// kind == "no-fly" 的进仿真（参与绕行）；其余（threat / geofence / corridor）只登记。
struct AirspaceZoneSpec {
    std::string key;
    std::string name;
    std::string kind;
    std::string hardness;  // 只有 no-fly 有意义
    std::string level;
    std::string action;
    std::string color;
    bool dashed = false;
    double widthM = 0.0;
    std::vector<std::pair<double, double>> polygon;
    std::vector<std::pair<double, double>> line;
};

/// targets.json · targets[] 一项。
struct TargetSpec {
    int no = 0;
    std::string id;          // 中性事件里的 deviceId
    std::string typeKey;
    std::string name;
    std::string motion;      // static | dynamic | popup
    std::vector<std::pair<double, double>> route;
    std::optional<std::pair<double, double>> position;
    double speedMps = 0.0;
    bool loop = false;
    int64_t startOffsetMs = 0;
    double confidence = 1.0;
    std::vector<std::string> features;
    std::string threat;
    std::string valueTag;
};

// ---------------------------------------------------------------- 整份数据
struct ScenarioData {
    std::string dir;          // 这 5 个文件所在的目录
    std::string scenarioKey;  // = 目录名（喂给 SimScenario::scenarioKey）
    std::string schemaVersion;

    MissionMeta mission;
    bool hasMission = false;

    std::pair<double, double> center{0.0, 0.0};
    bool hasCenter = false;
    int zoom = 0;
    int minZoom = 0;
    int maxZoom = 0;

    std::vector<DeployArea> deployAreas;
    std::vector<GroupSpec> groups;
    std::vector<AircraftSpec> aircraft;

    std::vector<TaskAreaSpec> taskAreas;

    std::vector<AirspaceZoneSpec> zones;          // 全部（含情报区）
    std::vector<AirspaceZoneSpec> hardNoFlyZones; // kind == "no-fly"

    std::vector<TargetSpec> targets;

    MapStyle mapStyle;

    /// groupKey → groupId（**稳定**：按 groups[] 声明顺序，从 1 起）。
    /// 不在声明里但被 aircraft 引用的组，追加在后面（同样从下一个号起）。
    std::string groupIdOf(const std::string& groupKey) const;
    /// 全部归属（含追加项）。
    const std::vector<std::pair<std::string, std::string>>& groupIds() const { return groupIds_; }

    /// 把整份数据翻成中立结构。校验不通过时 issues 非空、返回 false。
    bool toSimScenario(sim_source::SimScenario& out, LoadReport& report) const;

    /// 主任务区（= 中立结构里那个**唯一** role=task 的区域，也就是航路终点）。
    ///
    /// 为什么只能有一个：sim-source 的口径是"部署区 → 任务区"，校验要求
    /// 每个平台引用到的 taskAreaKey 必须是 role=task 的区域，而它只认一个任务区角色。
    /// 本仓的配置里有 A / B / C 三块区域（各自的 role 不同），所以这里按
    /// **"被最多平台引用"** 选一块当终点，平票取声明顺序靠前的 —— 结果可复现。
    std::string pickPrimaryTaskKey() const;

    // ---- 由 load() 填、被上面两个方法读 ----
    std::vector<std::pair<std::string, std::string>> groupIds_;
    std::string wireType;         // 线格式里的 type（默认 "uav"）
    std::string targetTypePrefix; // 目标 deviceType 前缀（默认 "tgt-"）
};

// ---------------------------------------------------------------- 入口

/// 读一个目录下的 5 个文件。任何缺失 / JSON 非法 / 形状不符 → report.ok=false + 可读 issues。
bool load(const std::string& dir, ScenarioData& out, LoadReport& report,
          const FileSet& files = FileSet{});

/// 便利入口：读盘 + 翻中立结构。任一步失败 → false（report 里是全部原因）。
bool loadScenario(const std::string& dir, ScenarioData& out, sim_source::SimScenario& scenario,
                  LoadReport& report, const FileSet& files = FileSet{});

}  // namespace ma::scenario
