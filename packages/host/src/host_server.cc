// mission-app · packages/host/src/host_server.cc
#include "ma/host_server.h"

#include <filesystem>
#include <fstream>
#include <map>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

#include <drogon/DrClassMap.h>
#include <drogon/HttpAppFramework.h>
#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>
#include <drogon/WebSocketConnection.h>
#include <drogon/WebSocketController.h>
#include <drogon/utils/HttpConstraint.h>
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

}  // namespace ma —— 下面的控制器必须在全局命名空间

// ================================================================ WS 控制器
//
// Drogon 1.9 的 WS 路由只接受"控制器类名"（内部按反射构造实例），没有 lambda 重载。
// 于是这里放一个薄控制器，把三个回调转给一张**按路由名索引**的表。
// 表里存的是 shared_ptr<WsCallbacks>：路由的生命周期比任何一次函数调用都长。
namespace {

std::mutex& wsRegistryMutex() {
    static std::mutex m;
    return m;
}

std::map<std::string, std::shared_ptr<ma::WsCallbacks>>& wsRegistry() {
    static std::map<std::string, std::shared_ptr<ma::WsCallbacks>> table;
    return table;
}

std::shared_ptr<ma::WsCallbacks> lookupWsCallbacks(const std::string& name) {
    std::lock_guard<std::mutex> lk(wsRegistryMutex());
    const auto it = wsRegistry().find(name);
    return it == wsRegistry().end() ? nullptr : it->second;
}

}  // namespace

    // ---- 反射控制器必须在**全局命名空间**（Drogon 的 DrClassMap 按裸类名登记）
    //
    // AutoCreation=false → 由 registerController() 显式交出实例并调 initPathRouting()，
    // 路径在 WS_PATH_ADD 里写死（app().run() 之前完成）。
class MaWsRouteController : public drogon::WebSocketController<MaWsRouteController, true> {
public:
    // ★ AutoCreation **必须**是 true，路径登记只能发生在**静态期**：
    //   Drogon 的 HttpControllersRouter::init()（在 app().run() 里跑）会先
    //   `wsCtrlMap_.clear()`，之后再登记的路由会被清掉 —— 症状是"HTTP 路由好好的、
    //   WS 路由却怎么也进不去"（握手成功但三个回调一个都不来，静默失败）。
    //   WS_PATH_ADD 展开出的静态成员就是在 main 之前完成这件事的。
    WS_PATH_LIST_BEGIN
    WS_PATH_ADD("/ws", drogon::Get);
    WS_PATH_LIST_END

    void handleNewConnection(const drogon::HttpRequestPtr&,
                             const drogon::WebSocketConnectionPtr& conn) override {
        const auto cb = lookupWsCallbacks(className());
        if (cb && cb->onAccepted) cb->onAccepted(conn);
    }

    void handleNewMessage(const drogon::WebSocketConnectionPtr& conn, std::string&& message,
                          const drogon::WebSocketMessageType& type) override {
        if (type != drogon::WebSocketMessageType::Text &&
            type != drogon::WebSocketMessageType::Binary) {
            return;  // ping / pong / close 帧由框架自己处理
        }
        const auto cb = lookupWsCallbacks(className());
        if (cb && cb->onMessage) cb->onMessage(conn, std::move(message));
    }

    void handleConnectionClosed(const drogon::WebSocketConnectionPtr& conn) override {
        const auto cb = lookupWsCallbacks(className());
        if (cb && cb->onClosed) cb->onClosed(conn);
    }
};

// 回到 ma：下面全是宿主自己的定义。
namespace ma {

// Drogon 的反射登记发生在 DrObject<T> 的静态成员**被实例化**时；
// 取一次类名就把它实例化出来（否则 app().run() 会报 "controller class not found"）。
const std::string& wsControllerTypeName() {
    static const std::string name = MaWsRouteController::classTypeName();
    return name;
}

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

namespace {

/// 把一份回调登记进表。**键必须是控制器类名**（控制器实例用 className() 取它），
/// 不能是路由别名 —— 用别名会静默失败：握手照旧成功，三个回调一个都不来。
void registerWsCallbacks(const std::string& controllerName, const WsCallbacks& callbacks) {
    std::lock_guard<std::mutex> lk(wsRegistryMutex());
    wsRegistry()[controllerName] = std::make_shared<WsCallbacks>(callbacks);
}

}  // namespace

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

    // ---- /stats：各引擎是否就绪（就绪账本的原样导出）+ 真实链路读数
    app.registerHandler(
        "/stats",
        [this](const drogon::HttpRequestPtr&,
               std::function<void(const drogon::HttpResponsePtr&)>&& cb) {
            nlohmann::json extra = nlohmann::json::object();
            if (ws_.statsExtra) {
                try {
                    extra = ws_.statsExtra();
                } catch (const std::exception& e) {
                    LOG_WARN << "[host] /stats 附加段生成失败：" << e.what();
                }
            }
            cb(jsonResponse(reg_.statsJson(kVersion, extra)));
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

    // ---- /ws-close（POST）：把当前 WS 连接按 peer 片段强断。
    //      用途：验收与运维要**确定性地**制造一次断开（否则只能干等心跳判死，
    //      而"客户端先走、扫描恰好发现"那种断开会污染心跳判死计数）。
    //      走的是 hub 的那条路：ITransport::close() → shutdown + forceClose。
    app.registerHandler(
        "/ws-close",
        [this](const drogon::HttpRequestPtr& req,
               std::function<void(const drogon::HttpResponsePtr&)>&& cb) {
            const std::string peer = req->getParameter("peer");
            const std::size_t n = ws_.closeByPeer ? ws_.closeByPeer(peer) : 0;
            nlohmann::ordered_json out;
            out["requested"] = peer;
            out["closed"] = n;
            cb(jsonResponse(out.dump()));
        },
        {drogon::Post});

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

    // ---- WS /ws：握手 → 登记；入站 → 喂看门狗 + 交给 hub；断开 → 注销
    //
    // ★ 三条路径的**唯一**出口都是同一份回调集合，所以"登记了就必须注销"是结构上保证的，
    //   不靠调用方记得。Drogon 的 WS 控制器按"类名"反射构造，因此路由名与回调集合
    //   经一张进程内表对应起来（表在 app().run() 之前就填好了）。
    if (ws_.onAccepted) {
        // ★ 路径登记**不在这里**：它必须是**静态期**的事（见 MaWsRouteController 注释）。
        //   这里也**绝不能**再调一次 registerWebSocketController —— 它会把 wsCtrlMap_ 里
        //   那条已经绑定好控制器的条目**整个换掉**（新条目的 controller_ 要等主循环里排到
        //   队列尾才填），症状同样是"握手成功、回调不来"。这一条是踩过的坑。
        registerWsCallbacks(wsControllerTypeName(), ws_);
        LOG_INFO << "[host] WS 路由: /ws（controller=" << wsControllerTypeName() << "）";
    }

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
