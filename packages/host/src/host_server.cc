// mission-app · packages/host/src/host_server.cc
#include "ma/host_server.h"

#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include <drogon/HttpAppFramework.h>
#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>
#include <nlohmann/json.hpp>
#include <trantor/utils/Logger.h>

#if MA_WITH_GEO
#include "geo_data/server/routing.h"
#include "geo_data/server/service.h"
#include "geo_data/stream.h"
#endif

namespace ma {

namespace fs = std::filesystem;

namespace {

const char* kVersion = "mission-app 0.1.0";

drogon::HttpResponsePtr jsonResponse(const std::string& body,
                                     drogon::HttpStatusCode code = drogon::k200OK) {
    auto resp = drogon::HttpResponse::newHttpResponse();
    resp->setStatusCode(code);
    resp->setContentTypeCode(drogon::CT_APPLICATION_JSON);
    resp->setBody(body);
    return resp;
}

std::string htmlPage(const std::string& title, const std::string& body) {
    return "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
           "<title>" + title + "</title>"
           "<style>body{background:#04182f;color:#cfe3f7;font:14px/1.7 system-ui,Segoe UI,"
           "Microsoft YaHei,sans-serif;margin:0;padding:48px}"
           "code{background:#0b2a4a;padding:2px 6px;border-radius:4px}"
           "a{color:#5fb0ff}</style></head><body>" + body + "</body></html>";
}

std::string esc(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (const char c : s) {
        switch (c) {
            case '<': out += "&lt;"; break;
            case '>': out += "&gt;"; break;
            case '&': out += "&amp;"; break;
            default: out += c; break;
        }
    }
    return out;
}

std::string readFileText(const std::string& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) return {};
    std::ostringstream buf;
    buf << in.rdbuf();
    return buf.str();
}

/// 把 Drogon 解析出来的查询参数拼回 URL（geo-data 的请求是"归一后的 URL"）。
/// 做成模板：Drogon 用的是带自定义哈希器的 unordered_map，类型不完全一致。
template <typename MapT>
std::string queryString(const MapT& params) {
    std::string out;
    for (const auto& kv : params) {
        out += out.empty() ? "?" : "&";
        out += kv.first;
        out += "=";
        out += kv.second;
    }
    return out;
}

/// fs::path::is_absolute() 在 MSVC 上不总是可见；显式判断根名/根目录更稳。
bool isAbsolutePath(const fs::path& p) { return p.has_root_directory() || p.has_root_name(); }

/// webDist 解析成绝对目录（相对路径锚定在仓库根，不是进程当前目录）。
fs::path webDistDir(const std::string& webDist) {
    const fs::path p(webDist);
    return isAbsolutePath(p) ? p : fs::path(MA_REPO_ROOT) / p;
}

}  // namespace

// ================================================================ 构造 / 析构

HostServer::HostServer(const HostConfig& cfg, Registry& reg, Engines& engines)
    : cfg_(cfg), reg_(reg), engines_(engines) {}

HostServer::~HostServer() {
    shutdown();
    if (serverThread_.joinable()) serverThread_.join();
}

void HostServer::refreshIndexHint() {
    const fs::path index = webDistDir(cfg_.webDist) / "index.html";
    indexHint_ = fs::exists(index) ? std::string() : index.string();
}

// ================================================================ 路由

void HostServer::registerRoutes() {
    auto& app = drogon::app();

    // ---- /health：静态占位（真正的 selfcheck 聚合是 P2 的事）
    app.registerHandler(
        "/health",
        [](const drogon::HttpRequestPtr&,
           std::function<void(const drogon::HttpResponsePtr&)>&& cb) {
            cb(jsonResponse("{\"status\":\"ok\"}"));
        },
        {drogon::Get});

    // ---- /stats：各引擎是否就绪（就绪账本的原样导出）
    app.registerHandler(
        "/stats",
        [this](const drogon::HttpRequestPtr&,
               std::function<void(const drogon::HttpResponsePtr&)>&& cb) {
            cb(jsonResponse(reg_.statsJson(kVersion)));
        },
        {drogon::Get});

    // ---- /runtime-config：给前端的最小装配信息（瓦片模板 + 就绪表）
    app.registerHandler(
        "/runtime-config",
        [this](const drogon::HttpRequestPtr&,
               std::function<void(const drogon::HttpResponsePtr&)>&& cb) {
            nlohmann::ordered_json out;
            out["version"] = kVersion;
            out["tiles"] = nlohmann::ordered_json{{"template", cfg_.tilesTemplate}};
            out["stats"] = nlohmann::ordered_json::parse(reg_.statsJson(kVersion));
            cb(jsonResponse(out.dump()));
        },
        {drogon::Get});

#if MA_WITH_GEO
    // ---- 瓦片路由：归一请求 → geo-data 的 TileService → 写回
    //      宿主不解析坐标、不做缓存策略、不做业务判断。
    if (cfg_.enableTiles && engines_.tileService) {
        const std::string route = cfg_.tilesBasePath.empty() ? "/tiles" : cfg_.tilesBasePath;
        app.registerHandler(
            route,
            [this](const drogon::HttpRequestPtr& req,
                   std::function<void(const drogon::HttpResponsePtr&)>&& cb) {
                geo_data::TileRequest greq;
                greq.method = req->methodString();
                greq.url = req->getOriginalPath();
                greq.url += queryString(req->getParameters());
                static const char* kForward[] = {"range", "if-none-match", "accept",
                                                 "accept-encoding", "user-agent"};
                for (const char* name : kForward) {
                    if (req->getHeader(name).empty()) continue;
                    greq.headers.set(name, req->getHeader(name));
                }

                const geo_data::TileResponse gresp = engines_.tileService->handleTile(greq);

                auto resp = drogon::HttpResponse::newHttpResponse();
                resp->setStatusCode(static_cast<drogon::HttpStatusCode>(gresp.status));
                for (const auto& kv : gresp.headers.items()) {
                    resp->addHeader(kv.first, kv.second);
                }
                switch (gresp.body.kind) {
                    case geo_data::TileBody::Kind::Buffer:
                        resp->setBody(geo_data::bytesToString(gresp.body.buffer));
                        break;
                    case geo_data::TileBody::Kind::Json:
                        resp->setBody(gresp.body.jsonValue.dump());
                        break;
                    case geo_data::TileBody::Kind::Stream: {
                        std::vector<std::uint8_t> all;
                        std::vector<std::uint8_t> chunk;
                        while (gresp.body.stream && gresp.body.stream->next(chunk)) {
                            all.insert(all.end(), chunk.begin(), chunk.end());
                            chunk.clear();
                        }
                        if (gresp.body.stream) gresp.body.stream->close();
                        resp->setBody(geo_data::bytesToString(all));
                        break;
                    }
                    case geo_data::TileBody::Kind::Empty:
                    default:
                        break;
                }
                cb(resp);
            },
            {drogon::Get, drogon::Head});
    }
#endif

    refreshIndexHint();

    // ---- "/"：产物存在 → 直接读 index.html 回；不存在 → 一张可读的提示页
    //
    // 为什么自己读而不用 setDocumentRoot() 的默认首页：默认首页由 Drogon 的静态路由兜底，
    // 行为依赖版本与根路径写法；这里显式一条，只有它失败时才回落到静态托管。
    {
        const fs::path index = webDistDir(cfg_.webDist) / "index.html";
        const std::string indexPath = index.string();
        const std::string tilesTemplate = cfg_.tilesTemplate;
        app.registerHandler(
            "/",
            [indexPath, tilesTemplate](
                const drogon::HttpRequestPtr&,
                std::function<void(const drogon::HttpResponsePtr&)>&& cb) {
                const std::string text = readFileText(indexPath);
                if (!text.empty()) {
                    auto resp = drogon::HttpResponse::newHttpResponse();
                    resp->setStatusCode(drogon::k200OK);
                    resp->setContentTypeCode(drogon::CT_TEXT_HTML);
                    resp->setBody(text);
                    cb(resp);
                    return;
                }
                const std::string body = htmlPage(
                    "mission-app",
                    std::string("<h1>mission-app · P0 装配骨架</h1>"
                                "<p>前端产物还没构建，所以这里只有一张提示页。</p>"
                                "<p>期望路径：<code>") + esc(indexPath) +
                        "</code></p><p>构建方式：<code>cd apps/web &amp;&amp; npm.cmd run build</code></p>"
                        "<p>底图瓦片模板：<code>" + esc(tilesTemplate) +
                        "</code>（未托管瓦片包时地图回落纯色兜底）</p>"
                        "<p>观测端点：<a href=\"/health\">/health</a> · "
                        "<a href=\"/stats\">/stats</a> · "
                        "<a href=\"/runtime-config\">/runtime-config</a></p>");
                auto resp = drogon::HttpResponse::newHttpResponse();
                resp->setStatusCode(drogon::k200OK);
                resp->setContentTypeCode(drogon::CT_TEXT_HTML);
                resp->setBody(body);
                cb(resp);
            },
            {drogon::Get});
    }

    // ---- 静态托管：dist 下的 assets 等（index.html 由上面那条显式返回）
    {
        const fs::path dir = webDistDir(cfg_.webDist);
        if (fs::exists(dir / "index.html")) {
            app.setDocumentRoot(dir.string());
            LOG_INFO << "[host] 静态托管: " << dir.string();
        } else {
            LOG_WARN << "[host] 前端产物不存在（" << indexHint_ << "），/ 返回提示页";
        }
    }

    LOG_INFO << "[host] HTTP 路由: / /health /stats /runtime-config"
#if MA_WITH_GEO
             << (cfg_.enableTiles && engines_.tileService ? " " + cfg_.tilesBasePath : "")
#endif
        ;
}

// ================================================================ 启停

int HostServer::start() {
    registerRoutes();

    auto& app = drogon::app();
    app.setThreadNum(cfg_.threads > 0 ? cfg_.threads : 1);
    app.addListener(cfg_.host, static_cast<std::uint16_t>(cfg_.port));

    running_ = true;
    serverThread_ = std::thread([this] {
        try {
            drogon::app().run();
        } catch (const std::exception& e) {
            LOG_ERROR << "[host] 服务线程异常退出：" << e.what();
        }
        running_ = false;
    });

    // 等它真的起来（或起不来）。Drogon 的 run() 失败会返回/抛；这里给一小段窗口。
    for (int i = 0; i < 100 && running_.load(); ++i) {
        std::this_thread::sleep_for(std::chrono::milliseconds(30));
        if (i > 6) break;  // 监听失败时 run() 会很快返回并把 running_ 置 false
    }
    if (!running_.load()) return 1;
    return 0;
}

void HostServer::requestStop() {
    {
        std::lock_guard<std::mutex> lk(stopMtx_);
        stopRequested_ = true;
    }
    stopCv_.notify_all();
}

void HostServer::waitForStop() {
    std::unique_lock<std::mutex> lk(stopMtx_);
    stopCv_.wait(lk, [this] { return stopRequested_; });
}

void HostServer::shutdown() {
    if (stopping_.exchange(true)) return;  // 幂等

    if (running_.load()) {
        try {
            drogon::app().quit();
        } catch (const std::exception& e) {
            LOG_WARN << "[host] quit() 异常：" << e.what();
        }
    }
    if (serverThread_.joinable()) serverThread_.join();
    running_ = false;
}

}  // namespace ma
