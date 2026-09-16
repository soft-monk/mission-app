// mission-app · packages/host/src/config.cc
#include "ma/config.h"

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>

#include <nlohmann/json.hpp>

namespace ma {

namespace fs = std::filesystem;

namespace {

/// 取字符串字段；类型不符就报错（不静默忽略 —— 配置写错了要当场可见）。
bool getString(const nlohmann::json& j, const char* key, std::string& out, std::string& error) {
    if (!j.contains(key)) return true;
    if (!j[key].is_string()) {
        error = std::string("字段 ") + key + " 必须是字符串";
        return false;
    }
    out = j[key].get<std::string>();
    return true;
}

bool getBool(const nlohmann::json& j, const char* key, bool& out, std::string& error) {
    if (!j.contains(key)) return true;
    if (!j[key].is_boolean()) {
        error = std::string("字段 ") + key + " 必须是布尔值";
        return false;
    }
    out = j[key].get<bool>();
    return true;
}

bool getInt(const nlohmann::json& j, const char* key, int& out, std::string& error) {
    if (!j.contains(key)) return true;
    if (!j[key].is_number_integer()) {
        error = std::string("字段 ") + key + " 必须是整数";
        return false;
    }
    out = j[key].get<int>();
    return true;
}

/// 读一个（可选的）子对象。
const nlohmann::json& sub(const nlohmann::json& j, const char* key, nlohmann::json& scratch) {
    if (j.contains(key) && j[key].is_object()) return j[key];
    scratch = nlohmann::json::object();
    return scratch;
}

}  // namespace

std::string HostConfig::resolvePath(const std::string& p) const {
    if (p.empty()) return p;
    const fs::path path(p);
    if (path.is_absolute()) return path.string();
    // ★ 相对路径锚定在**配置文件旁边**，不是进程当前目录。
    //   （assembly-host 踩过这个坑：从 build/bin/Release 启动时数据写进了那里。）
    const fs::path base = configDir.empty() ? fs::current_path() : fs::path(configDir);
    return (base / path).lexically_normal().string();
}

bool HostConfig::loadFile(const std::string& path, HostConfig& out, std::string& error) {
    std::ifstream in(path, std::ios::binary);
    if (!in) {
        error = "打不开配置文件：" + path;
        return false;
    }
    std::ostringstream buf;
    buf << in.rdbuf();

    nlohmann::json j;
    try {
        j = nlohmann::json::parse(buf.str());
    } catch (const std::exception& e) {
        error = std::string("JSON 解析失败：") + e.what();
        return false;
    }
    if (!j.is_object()) {
        error = "配置文件顶层必须是一个 JSON 对象";
        return false;
    }

    out.configPath = fs::absolute(fs::path(path)).string();
    out.configDir = fs::path(out.configPath).parent_path().string();

    nlohmann::json scratch;
    const auto& srv = sub(j, "server", scratch);
    if (!getString(srv, "host", out.host, error)) return false;
    if (!getInt(srv, "port", out.port, error)) return false;
    if (!getInt(srv, "threads", out.threads, error)) return false;

    if (!getString(j, "dataDir", out.dataDir, error)) return false;
    if (!getString(j, "webDist", out.webDist, error)) return false;

    const auto& mods = sub(j, "modules", scratch);
    if (!getBool(mods, "hub", out.enableHub, error)) return false;
    if (!getBool(mods, "tiles", out.enableTiles, error)) return false;

    const auto& tiles = sub(j, "tiles", scratch);
    if (!getString(tiles, "template", out.tilesTemplate, error)) return false;
    if (!getString(tiles, "basePath", out.tilesBasePath, error)) return false;
    if (!getInt(tiles, "missingStatus", out.tilesMissingStatus, error)) return false;
    if (!getString(tiles, "packageId", out.tilesPkgId, error)) return false;
    if (!getString(tiles, "version", out.tilesPkgVersion, error)) return false;
    if (!getString(tiles, "root", out.tilesRoot, error)) return false;
    if (!getString(tiles, "subDir", out.tilesSubDir, error)) return false;

    const auto& sc = sub(j, "selfcheck", scratch);
    if (!getString(sc, "policies", out.selfcheckPolicies, error)) return false;
    if (!getString(sc, "capabilities", out.selfcheckCapabilities, error)) return false;

    if (out.port <= 0 || out.port > 65535) {
        error = "server.port 超出范围（1..65535）：" + std::to_string(out.port);
        return false;
    }
    if (out.threads <= 0) out.threads = 1;
    return true;
}

std::string resolveConfigPath(const std::string& explicitPath, const char* argv0) {
    if (!explicitPath.empty()) return explicitPath;

    if (const char* env = std::getenv("MISSION_APP_CONFIG")) {
        if (env[0] != '\0' && fs::exists(env)) return env;
    }

    std::error_code ec;
    const fs::path candidates[] = {
        fs::path(MA_REPO_ROOT) / "config.json",
        fs::path("mission.config.json"),
        fs::path(MA_REPO_ROOT) / ".." / "config.json",
    };
    for (const auto& c : candidates) {
        if (fs::exists(c, ec)) return c.string();
    }

    if (argv0 != nullptr) {
        const fs::path exeDir = fs::absolute(fs::path(argv0), ec).parent_path();
        const fs::path nearExe[] = {
            exeDir / "config.json",
            exeDir / ".." / "config.json",
            exeDir / ".." / ".." / "config.json",
            exeDir / ".." / ".." / ".." / "config.json",
        };
        for (const auto& c : nearExe) {
            if (fs::exists(c, ec)) return c.string();
        }
    }
    return {};
}

}  // namespace ma
