// mission-app · packages/host/include/ma/config.h
//
// 宿主配置：只读 mission-app/config.json。
// 这个文件里没有任何业务判断 —— 它只回答"监听哪个端口、数据放哪、瓦片模板是什么"。
#pragma once

#include <cstdint>
#include <map>
#include <string>
#include <vector>

namespace ma {

struct HostConfig {
    // ---- 服务
    std::string host = "127.0.0.1";
    int port = 8099;
    int threads = 2;

    // ---- 数据目录（相对路径一律锚定在**配置文件旁边**，不是进程当前目录）
    std::string dataDir = "data";

    // ---- 引擎启用开关（配置层面；编译期是否存在由 MA_WITH_* 决定）
    bool enableHub = false;
    bool enableTiles = true;

    // ---- 瓦片（未托管任何瓦片包时前端回落纯色）
    std::string tilesTemplate = "/tiles/{z}/{x}/{y}.jpg";
    std::string tilesBasePath = "/tiles";
    int tilesMissingStatus = 404;
    std::string tilesPkgId;
    std::string tilesPkgVersion;
    std::string tilesRoot;  // 空 = 不托管任何包
    std::string tilesSubDir = "raster";

    // ---- 媒体素材根目录（相对路径锚在配置文件旁边；**空 = /media/** 不托管**）----
    //
    // 它只回答"字节从哪个目录来"：通道清单由宿主扫这个目录得到（子目录 = image-seq 通道，
    // 视频文件 = video 通道），字节流走 HostServer 的 /media/** 路由（支持 Range/206）。
    std::string mediaRoot;

    // ---- selfcheck 规则包（可选；文件不存在则跳过装载，如实记 note）
    std::string selfcheckPolicies;
    std::string selfcheckCapabilities;
    /**
     * 演示口径：**本场景是否声明「有卫星链路」**（`config.json` 的 `selfcheck.satcomLinkUp`）。
     *
     * 为什么要有这个开关：本工程没有真实卫星链路，而 selfcheck 的 `satcomLink` 探针只有
     * ok / failed 两态、**没有"未配置"分支**（`selfcheck/probes/mapapp/probe_pack.cc:166`），
     * 于是"没有卫星链路"被判成"卫星链路中断"，把第 2 屏的「通信链路检测」整块拉红。
     * 需求方 2026-09-18 的处置是"改配置"：把这条**声明**放进配置，缺省 `false`（＝如实报"没有"）。
     *
     * 注意：这是**能力声明（配置）**，不是测量值 —— 与 `linkUdpReceiving`（真收包）、
     * `meshLinkUp`（真客户端数）不同，后两者**永远取实测**，不受本开关影响。
     */
    bool selfcheckSatcomLinkUp = false;

    // ---- 接入点（ingest.points[]）：仿真那条 UDP 流落到这里
    struct IngestPoint {
        std::string id = "ingest-uav";
        std::string group;       // 组播地址；空 = 收单播
        int port = 45500;
        std::string iface;
        std::string parserId = "legacy.kind.v1";
        std::string deviceType = "uav";
        std::string topic;
        bool enabled = true;
    };
    struct IngestSettings {
        bool enabled = true;
        int mergeWindowMs = 100;
        std::vector<IngestPoint> points;
    };
    IngestSettings ingest;

    /// 本地上路的**落点**：仿真把报文打到 ingest.points[0] 的地址端口。
    std::string ingestHost = "127.0.0.1";

    // ---- 事件 kind（**由装配层注入引擎**；引擎自己的中立占位是 sim.pos）
    std::string simKind = "uav.pos";
    /// 过线类型（线格式里的 `type`）
    std::string simWireType = "uav";
    /// 仿真起手倍速（1 | 8 | 60）
    int simSpeed = 1;
    /// 起手是否立刻跑节拍
    bool simAutoStart = true;
    /// 本地配置目录（相对路径锚定在配置文件旁边；空 = <dataDir>/scenario-1）
    std::string scenarioDir;

    // ---- 前端产物目录（相对仓库根或绝对路径）
    std::string webDist = "apps/web/dist";

    // ---- 流程步骤表（Excel 11 步的**显示名**）
    //
    // ★ 为什么它在配置里、不在源码里：步骤名 / 界面标题是**业务词汇**。
    //   把它放在这里，客户改界面词不必重新编译宿主；宿主源码里只留"只有 key/phase 的骨架"。
    //   `key`（前端路由用）与 `phase`（`phase-engine` 的 T0–T7）是**约定键**，两边要同步改。
    struct FlowStepSetting {
        int step = 0;
        std::string key;
        std::string title;  // 界面标题；空 = 回落成 key（并如实记进 flowStepsSource）
        std::string phase;  // "" = 尚未进入任务
    };
    std::vector<FlowStepSetting> flowSteps;
    /// `flow.steps` 的读取结果（给 /stats 与启动日志：读到几条，还是回落了内置骨架）。
    std::string flowStepsSource;

    /// 流程自产物的**显示文案**（`flow.labels`：时间轴分段名、俯冲区名、缺几何占位名 …）。
    ///
    /// ★ 同 flowSteps 的理由：这些是**业务词汇**，住在配置里 → 改文案不用重新编译宿主。
    ///   键是稳定的（`timeline.t0` / `dive.start` …）；配置缺某一条时宿主**回落成键名**，
    ///   MUST NOT 在源码里补一句中文兜底。
    std::map<std::string, std::string> flowLabels;

    // ---- 元信息
    std::string configPath;  // 实际读到的配置文件绝对路径（空 = 用了内置默认值）
    std::string configDir;   // 配置文件所在目录（相对路径锚点）

    /// 把配置里的相对路径锚定到配置文件旁边。
    std::string resolvePath(const std::string& p) const;

    /// 本地上路的落点端口（= ingest.points[0].port；没有接入点 → 0）。
    int ingestPort() const { return ingest.points.empty() ? 0 : ingest.points.front().port; }
    /// 本地配置目录的绝对路径（scenarioDir 为空 → <dataDir 绝对路径>/scenario-1）。
    std::string resolveScenarioDir() const;

    /// 读配置。找不到文件 → false（调用方回落内置默认值）。
    /// 文件存在但 JSON 非法 / 端口越界 → false 且 error 给出可读原因。
    static bool loadFile(const std::string& path, HostConfig& out, std::string& error);
};

/// 找配置文件：显式路径 > 环境变量 MISSION_APP_CONFIG > 仓库根附近 > exe 附近。
/// 返回空串表示一个都没找到（此时调用方用内置默认值继续跑）。
std::string resolveConfigPath(const std::string& explicitPath, const char* argv0);

}  // namespace ma
