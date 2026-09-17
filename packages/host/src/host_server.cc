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

    // ---- /health：selfcheck 的聚合负载（六个字段冻结口径：status / checkedAt / modules /
    //      selfCheck / systemOverview / wsClients）。**不在这里算** —— 全部来自 selfcheck 引擎，
    //      宿主只搬运。未接 flow（如 --selftest 或模块没装）时回落最小合法负载。
    app.registerHandler(
        "/health",
        [this](const drogon::HttpRequestPtr&,
               std::function<void(const drogon::HttpResponsePtr&)>&& cb) {
            if (ws_.health) {
                try {
                    cb(jsonResponse(ws_.health().dump()));
                    return;
                } catch (const std::exception& e) {
                    LOG_WARN << "[host] /health 生成失败：" << e.what();
                }
            }
            cb(jsonResponse("{\"status\":\"unknown\",\"checkedAt\":0,\"modules\":[],"
                            "\"selfCheck\":[],\"systemOverview\":[],\"wsClients\":0}"));
        },
        {drogon::Get});

    // ---- /healthz：排障用最小路由（不碰任何引擎；用来区分"服务器不响应"与"某个处理器卡住"）
    app.registerHandler(
        "/healthz",
        [](const drogon::HttpRequestPtr&,
           std::function<void(const drogon::HttpResponsePtr&)>&& cb) {
            LOG_INFO << "[host][diag] /healthz 命中";
            cb(jsonResponse("{\"ok\":true}"));
        },
        {drogon::Get});

    // ---- /healthz：排障用最小路由（不碰任何引擎；用来区分"服务器不响应"与"某个处理器卡住"）
    app.registerHandler(
        "/healthz",
        [](const drogon::HttpRequestPtr&,
           std::function<void(const drogon::HttpResponsePtr&)>&& cb) {
            LOG_INFO << "[host][diag] /healthz 命中";
            cb(jsonResponse("{\"ok\":true}"));
        },
        {drogon::Get});

    // ---- /api/state：流程状态 + 启动进度 + 自检结果（前端每次轮询读它）
    app.registerHandler(
        "/api/state",
        [this](const drogon::HttpRequestPtr&,
               std::function<void(const drogon::HttpResponsePtr&)>&& cb) {
            if (!ws_.state) {
                cb(jsonResponse("{\"code\":1005,\"error\":{\"message\":\"流程层未装配\"}}",
                                drogon::k503ServiceUnavailable));
                return;
            }
            cb(jsonResponse(ws_.state().dump()));
        },
        {drogon::Get});

    // ---- /api/command：唯一的命令面（POST JSON `{verb, params}`）
    //
    // 回执统一 `{code, verb, data|error}`：`code=0` 成功；码表见 protocol §3
    // （1000 非法请求 / 1004 未找到 / 1005 内部不可用 / 1006 版本不匹配）。
    app.registerHandler(
        "/api/command",
        [this](const drogon::HttpRequestPtr& req,
               std::function<void(const drogon::HttpResponsePtr&)>&& cb) {
            if (!ws_.command) {
                cb(jsonResponse("{\"code\":1005,\"verb\":\"\",\"error\":{\"message\":\"流程层未装配\"}}",
                                drogon::k503ServiceUnavailable));
                return;
            }
            std::string verb;
            nlohmann::json params = nlohmann::json::object();
            try {
                const auto body = req->getBody();
                if (!body.empty()) {
                    const auto j = nlohmann::json::parse(std::string(body));
                    if (!j.is_object()) {
                        cb(jsonResponse(
                            "{\"code\":1000,\"verb\":\"\",\"error\":{\"message\":\"请求体必须是 JSON 对象\"}}"));
                        return;
                    }
                    verb = j.value("verb", std::string());
                    if (j.contains("params") && j["params"].is_object()) params = j["params"];
                }
            } catch (const std::exception& e) {
                nlohmann::json out;
                out["code"] = 1000;
                out["verb"] = "";
                out["error"] = {{"message", std::string("JSON 解析失败：") + e.what()}};
                cb(jsonResponse(out.dump()));
                return;
            }
            if (verb.empty()) verb = req->getParameter("verb");
            try {
                cb(jsonResponse(ws_.command(verb, params).dump()));
            } catch (const std::exception& e) {
                nlohmann::json out;
                out["code"] = 1005;
                out["verb"] = verb;
                out["error"] = {{"message", std::string("命令执行异常：") + e.what()}};
                cb(jsonResponse(out.dump(), drogon::k500InternalServerError));
            }
        },
        {drogon::Post});

    // ---- /shutdown（POST）：请求走**正常退出序列**（先 flush 留存层，再逆序停模块）。
    //      前台跑用 Ctrl+C 就够；后台跑（脚本化演示/验收）只有这条路能"优雅停"。
    //      宿主只监听 127.0.0.1（config.json），不对公网开放。
    app.registerHandler(
        "/shutdown",
        [this](const drogon::HttpRequestPtr&,
               std::function<void(const drogon::HttpResponsePtr&)>&& cb) {
            nlohmann::json out;
            out["code"] = 0;
            out["message"] = "已请求退出：先 flush 留存层，再按装配逆序停模块";
            cb(jsonResponse(out.dump(), drogon::k202Accepted));
            if (ws_.shutdown) {
                // 回执先发出去再触发退出（否则调用方收到的是"连接被关"而不是这个 202）
                std::thread([this] {
                    std::this_thread::sleep_for(std::chrono::milliseconds(200));
                    if (ws_.shutdown) ws_.shutdown();
                }).detach();
            }
        },
        {drogon::Post});

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

    // ---- /runtime-config：给前端的最小装配信息（瓦片模板 + 就绪表 + 流程词汇表）
    app.registerHandler(
        "/runtime-config",
        [this](const drogon::HttpRequestPtr&,
               std::function<void(const drogon::HttpResponsePtr&)>&& cb) {
            nlohmann::ordered_json out;
            out["version"] = kVersion;
            out["tiles"] = nlohmann::ordered_json{{"template", cfg_.tilesTemplate}};
            // 11 步的显示名 + 流程词汇表（含界面文案与语音台词）——**词汇表是配置，前端不写死**。
            // 前端拿它渲染"步 N/11 · 屏名"与语音条；配置里缺的键，前端如实显示"未配置"。
            {
                nlohmann::ordered_json steps = nlohmann::ordered_json::array();
                for (const auto& s : cfg_.flowSteps) {
                    steps.push_back(nlohmann::ordered_json{
                        {"step", s.step}, {"key", s.key}, {"title", s.title}, {"phase", s.phase}});
                }
                out["steps"] = std::move(steps);
                nlohmann::ordered_json labels = nlohmann::ordered_json::object();
                for (const auto& kv : cfg_.flowLabels) labels[kv.first] = kv.second;
                out["labels"] = std::move(labels);
            }
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
    //      宿主不解析坐标、不做缓存策略、不做业务判断。    //
    // ★ 路由必须按**正则**注册整棵子树：drogon 的 `registerHandler(path, …)` 对不含
    //   占位符的路径是**精确匹配**（HttpControllersRouter 的 simpleCtrlMap_），只注册
    //   `route` 本身的后果是任何 `/tiles/...` 子路径都落到 drogon 自带的 HTML 404，
    //   请求根本到不了 geo-data。瓦片路径按模块契约 §3.5 是
    //   `<basePath>/<pkgId>-<version>/<subDir>/z/x/y.ext`，所以这里放行 `route` 及其
    //   全部子路径，路径形态由模块裁决（宿主不在这里认坐标）。
    if (cfg_.enableTiles && engines_.tileService) {
        const std::string route = cfg_.tilesBasePath.empty() ? "/tiles" : cfg_.tilesBasePath;
        // 模块的挂载前缀用 geo-data 自己的纯函数算（宿主不自己拼版本化路径）。
        const std::string mountPrefix =
            (cfg_.tilesPkgId.empty() || cfg_.tilesPkgVersion.empty())
                ? std::string()
                : geo_data::urlPrefixFor(route, cfg_.tilesPkgId, cfg_.tilesPkgVersion) + "/" +
                      (cfg_.tilesSubDir.empty() ? "raster" : cfg_.tilesSubDir) + "/";
        app.registerHandlerViaRegex(
            route + "(?:/.*)?",  // 非捕获组：不给 handler 造出多余的路由参数
            [this, route, mountPrefix](const drogon::HttpRequestPtr& req,
                                       std::function<void(const drogon::HttpResponsePtr&)>&& cb) {
                geo_data::TileRequest greq;
                greq.method = req->methodString();
                greq.url = req->getOriginalPath();

                // ★ 扁平模板兼容：`config.json` 的 `tiles.template` 历史上是
                //   `/tiles/{z}/{x}/{y}.jpg`（前端按它取图），而模块的包路径按 GEO-RTM-02
                //   必含版本段。这里**只把路径补上挂载前缀**（`/tiles/z/x/y.jpg` →
                //   `/tiles/<pkgId>-<version>/<subDir>/z/x/y.jpg`），命中/缺失/越界仍全部
                //   由模块裁决 —— 不是静态路由，正文一个字节都不由宿主产生。
                if (!mountPrefix.empty() &&
                    greq.url.compare(0, mountPrefix.size(), mountPrefix) != 0 &&
                    greq.url.compare(0, route.size() + 1, route + "/") == 0) {
                    greq.url = mountPrefix + greq.url.substr(route.size() + 1);
                }

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
                // ★ content-type 走 setContentTypeString（**替换**），不能只 addHeader：
                //   drogon 的 newHttpResponse() 自带 `content-type: text/html`，追加一个
                //   `image/jpeg` 会写出两个互相矛盾的 content-type（实测响应里两条都在），
                //   瓦片就有被客户端按 text/html 处理的风险。其余头原样回写。
                for (const auto& kv : gresp.headers.items()) {
                    if (kv.first == "content-type") {
                        resp->setContentTypeString(kv.second);
                        continue;
                    }
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

    // ---- /media/**：媒体字节流（F1 明确允许的**唯一** per-feature HTTP 路由）----
    //
    // 为什么不能复用瓦片那条路由（事实）：
    //   · 那条路由属于 geo-data，只认瓦片包的版本化路径，**不认任意文件**；
    //   · 它对 `Stream` 形态的正文是"抽干进内存再 setBody"（`while(next(chunk)) all.insert(...)`）
    //     —— 大文件等于把整个文件读进内存，也没有 Range/206 语义。
    // 所以这里自己实现：**只读请求到的那一段字节**（seekg + read），完整支持
    //   · 200 + Content-Length + Accept-Ranges: bytes
    //   · Range: bytes=a-b / bytes=a- / bytes=-n → 206 + Content-Range
    //   · 越界/不可满足 → 416 + Content-Range: bytes */size
    //   · 不存在 / 目录 / 越权路径（..）→ **404**（不是 200 + 一张 HTML 提示页）
    //   · HEAD 只回头不回体
    // 路径安全：先拒绝含 ".." 的段，再把解析后的绝对路径与 mediaRoot 的规范路径比前缀。
    {
        const std::string root = cfg_.mediaRoot.empty() ? std::string()
                                                        : cfg_.resolvePath(cfg_.mediaRoot);
        app.registerHandlerViaRegex(
            "/media(?:/.*)?",
            [root](const drogon::HttpRequestPtr& req,
                   std::function<void(const drogon::HttpResponsePtr&)>&& cb) {
                auto notFound = [&cb](const std::string& why) {
                    nlohmann::json body;
                    body["code"] = 1004;
                    body["error"] = {{"message", why}};
                    auto resp = drogon::HttpResponse::newHttpResponse();
                    resp->setStatusCode(drogon::k404NotFound);
                    resp->setContentTypeCode(drogon::CT_APPLICATION_JSON);
                    resp->setBody(body.dump());
                    cb(resp);
                };
                auto rangeErr = [&cb](std::uintmax_t size) {
                    nlohmann::json body;
                    body["code"] = 1000;
                    body["error"] = {{"message", "Range 不可满足"}};
                    auto resp = drogon::HttpResponse::newHttpResponse();
                    resp->setStatusCode(drogon::k416RequestedRangeNotSatisfiable);
                    resp->setContentTypeCode(drogon::CT_APPLICATION_JSON);
                    resp->addHeader("Content-Range", "bytes */" + std::to_string(size));
                    resp->addHeader("Accept-Ranges", "bytes");
                    resp->setBody(body.dump());
                    cb(resp);
                };

                if (root.empty()) {
                    notFound("未托管媒体：config.json 的 mediaRoot 为空");
                    return;
                }
                std::string path = req->getPath();
                if (path.empty()) path = req->getOriginalPath();
                const std::string prefix = "/media/";
                std::string rel = path == "/media" ? std::string()
                                                   : (path.rfind(prefix, 0) == 0
                                                          ? path.substr(prefix.size())
                                                          : std::string());
                if (rel.empty()) {
                    notFound("缺文件名：/media/<子目录>/<文件>");
                    return;
                }
                // 反斜杠统一成 '/' 之后逐段拒绝 `..`（Windows 上两种分隔符都要挡）
                for (char& c : rel) {
                    if (c == '\\') c = '/';
                }
                for (std::size_t i = 0; i < rel.size();) {
                    const std::size_t j = rel.find('/', i);
                    const std::string seg = rel.substr(i, j == std::string::npos ? j : j - i);
                    if (seg == ".." || seg.empty()) {
                        notFound("非法路径段：" + seg);
                        return;
                    }
                    if (j == std::string::npos) break;
                    i = j + 1;
                }

                std::error_code ec;
                const fs::path rootPath = fs::weakly_canonical(fs::path(root), ec);
                const fs::path full = fs::weakly_canonical(rootPath / fs::path(rel), ec);
                const std::string fullStr = full.generic_string();
                const std::string rootStr = rootPath.generic_string();
                if (fullStr.rfind(rootStr, 0) != 0) {
                    notFound("越权路径（不在 mediaRoot 下）");
                    return;
                }
                if (!fs::exists(full, ec) || !fs::is_regular_file(full, ec)) {
                    notFound("文件不存在：" + rel);
                    return;
                }
                const std::uintmax_t size = fs::file_size(full, ec);
                if (ec) {
                    notFound("读不到文件大小：" + rel);
                    return;
                }

                const auto ext = full.extension().string();
                std::string ctype = "application/octet-stream";
                if (ext == ".jpg" || ext == ".jpeg") ctype = "image/jpeg";
                else if (ext == ".png") ctype = "image/png";
                else if (ext == ".mp4") ctype = "video/mp4";
                else if (ext == ".webm") ctype = "video/webm";
                else if (ext == ".m4v") ctype = "video/x-m4v";
                else if (ext == ".json") ctype = "application/json";
                else if (ext == ".txt") ctype = "text/plain; charset=utf-8";

                // ---- Range 解析（单段；多段按 RFC 允许忽略 → 回 200 全量）----
                std::uintmax_t begin = 0;
                std::uintmax_t end = size == 0 ? 0 : size - 1;
                bool partial = false;
                const std::string range = req->getHeader("range");
                if (!range.empty() && size > 0) {
                    std::string spec = range;
                    if (spec.rfind("bytes=", 0) == 0) spec = spec.substr(6);
                    if (spec.find(',') != std::string::npos) {
                        // 多段 Range：本实现明确不支持 → 忽略 Range，回 200 全量（如实可观测）
                    } else {
                        const std::size_t dash = spec.find('-');
                        if (dash == std::string::npos) {
                            rangeErr(size);
                            return;
                        }
                        const std::string a = spec.substr(0, dash);
                        const std::string b = spec.substr(dash + 1);
                        try {
                            if (a.empty() && !b.empty()) {  // bytes=-n：最后 n 字节
                                const std::uintmax_t n = std::stoull(b);
                                if (n == 0) {
                                    rangeErr(size);
                                    return;
                                }
                                begin = n >= size ? 0 : size - n;
                                end = size - 1;
                                partial = true;
                            } else if (!a.empty()) {
                                begin = std::stoull(a);
                                if (begin >= size) {
                                    rangeErr(size);
                                    return;
                                }
                                if (!b.empty()) {
                                    end = std::stoull(b);
                                    if (end >= size) end = size - 1;
                                } else {
                                    end = size - 1;
                                }
                                if (end < begin) {
                                    rangeErr(size);
                                    return;
                                }
                                partial = true;
                            }
                        } catch (const std::exception&) {
                            rangeErr(size);
                            return;
                        }
                    }
                }

                const std::uintmax_t want = size == 0 ? 0 : (end - begin + 1);
                std::string body;
                if (size > 0 && want > 0) {
                    std::ifstream in(full, std::ios::binary);
                    if (!in) {
                        notFound("打不开文件：" + rel);
                        return;
                    }
                    body.resize(static_cast<std::size_t>(want));
                    in.seekg(static_cast<std::streamoff>(begin));
                    in.read(&body[0], static_cast<std::streamsize>(want));
                    body.resize(static_cast<std::size_t>(in.gcount()));
                }

                const bool head = req->method() == drogon::Head;
                auto resp = drogon::HttpResponse::newHttpResponse();
                resp->setStatusCode(partial ? drogon::k206PartialContent : drogon::k200OK);
                resp->setContentTypeString(ctype);  // 替换（不是 addHeader）—— 避免双 content-type
                resp->addHeader("Accept-Ranges", "bytes");
                resp->addHeader("Cache-Control", "no-store");
                if (partial) {
                    resp->addHeader("Content-Range",
                                    "bytes " + std::to_string(begin) + "-" +
                                        std::to_string(end) + "/" + std::to_string(size));
                }
                // ★ content-length **不自己加**（GET/206）：正文长度就是 Content-Length，
                //   drogon 会按 body 写一个；自己再加一个会写出两条同名头（实测 undici 直接报
                //   `ResponseContentLengthMismatchError`）。HEAD 没有正文，必须自己给长度，
                //   否则客户端会以为资源是 0 字节。
                if (head) {
                    resp->addHeader("Content-Length", std::to_string(want));
                } else {
                    resp->setBody(body);
                }
                LOG_INFO << "[host][media] " << (head ? "HEAD " : "GET ") << rel << " → "
                         << (partial ? 206 : 200) << " bytes=" << begin << "-" << end << "/" << size;
                cb(resp);
            },
            {drogon::Get, drogon::Head});
        LOG_INFO << "[host] 媒体路由: /media/**（root="
                 << (root.empty() ? std::string("(未配置：一律 404)") : root) << "）";
    }

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

    LOG_INFO << "[host] HTTP 路由: / /health /healthz /stats /runtime-config /api/state /api/command /shutdown"
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
