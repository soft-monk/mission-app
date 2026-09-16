// mission-app · packages/host/include/ma/registry.h
//
// "谁装上了、谁起来了" 的唯一账本。
//
// ★ 纪律：这里只有**就绪状态**，没有任何业务判断。
//   业务规则、评分算法、告警规则一律不在宿主里 —— 宿主只回答"这个引擎对象构造成功了吗"。
#pragma once

#include <mutex>
#include <string>
#include <vector>

namespace ma {

/// 一个子系统的就绪条目。
struct EngineEntry {
    std::string key;        // 短名（就绪行里用的那个）
    bool linked = false;    // 编译期就装进来了吗（MA_WITH_* 为 1）
    bool instantiated = false;  // 运行期真的 new 出来了吗
    bool ok = false;        // 综合就绪（目前 = instantiated）
    std::string note;       // 人话备注：为什么没实例化 / 装载到了什么
};

/// 就绪账本。线程安全（HTTP 线程会读，主线程会写）。
class Registry {
public:
    void set(const std::string& key, bool linked, bool instantiated,
             const std::string& note);

    /// `[host] engines ready: phase=1 resource=1 ...`（顺序 = 加入顺序 = 装配顺序）
    std::string readyLine() const;

    /// `/stats` 的 JSON 主体。
    std::string statsJson(const std::string& version) const;

    std::vector<EngineEntry> entries() const;

    /// 未实例化的条目（供启动时打印一行"只链接未实例化"）。
    std::vector<EngineEntry> notInstantiated() const;

private:
    mutable std::mutex mtx_;
    std::vector<EngineEntry> items_;
};

}  // namespace ma
