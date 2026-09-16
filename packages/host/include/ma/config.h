// mission-app · packages/host/include/ma/config.h
//
// 宿主配置：只读 mission-app/config.json。
// 这个文件里没有任何业务判断 —— 它只回答"监听哪个端口、数据放哪、瓦片模板是什么"。
#pragma once

#include <cstdint>
#include <string>

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

    // ---- selfcheck 规则包（可选；文件不存在则跳过装载，如实记 note）
    std::string selfcheckPolicies;
    std::string selfcheckCapabilities;

    // ---- 前端产物目录（相对仓库根或绝对路径）
    std::string webDist = "apps/web/dist";

    // ---- 元信息
    std::string configPath;  // 实际读到的配置文件绝对路径（空 = 用了内置默认值）
    std::string configDir;   // 配置文件所在目录（相对路径锚点）

    /// 把配置里的相对路径锚定到配置文件旁边。
    std::string resolvePath(const std::string& p) const;

    /// 读配置。找不到文件 → false（调用方回落内置默认值）。
    /// 文件存在但 JSON 非法 / 端口越界 → false 且 error 给出可读原因。
    static bool loadFile(const std::string& path, HostConfig& out, std::string& error);
};

/// 找配置文件：显式路径 > 环境变量 MISSION_APP_CONFIG > 仓库根附近 > exe 附近。
/// 返回空串表示一个都没找到（此时调用方用内置默认值继续跑）。
std::string resolveConfigPath(const std::string& explicitPath, const char* argv0);

}  // namespace ma
