// mission-app · packages/sim-bridge/src/driver.cc
//
// 节拍驱动：真实时间 → tick()，控制面 → step()。**唯一**调引擎时间入口的地方。
#include "ma/sim_bridge/sim_bridge.h"

#include <chrono>

namespace ma::sim_bridge {

namespace {
std::int64_t steadyMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}
}  // namespace

Driver::Driver(sim_source::SimSource& engine, std::shared_ptr<sim_source::IClock> clock,
               const DriverOptions& options)
    : engine_(engine), clock_(std::move(clock)), options_(options) {}

Driver::~Driver() { stop(); }

void Driver::primeAt(std::int64_t nowMs) {
    std::lock_guard<std::mutex> lk(mtx_);
    lastMs_ = nowMs;
    primed_ = true;
}

void Driver::primeNow() {
    primeAt(clock_ ? clock_->nowMs() : 0);
}

void Driver::start() {
    if (running_.exchange(true)) return;
    stop_.store(false);
    thread_ = std::thread([this] { loop(); });
}

void Driver::stop() {
    stop_.store(true);
    if (thread_.joinable()) thread_.join();
    running_.store(false);
}

bool Driver::running() const { return running_.load(); }

bool Driver::setSpeed(int multiplier) {
    std::lock_guard<std::mutex> lk(mtx_);
    return engine_.setSpeed(multiplier);  // 非法值由引擎拒绝（只认 1 / 8 / 60）
}

void Driver::pause() {
    std::lock_guard<std::mutex> lk(mtx_);
    engine_.pause();
}

void Driver::resume() {
    std::lock_guard<std::mutex> lk(mtx_);
    engine_.resume();
    // 恢复后重新对基线：暂停期间的真实时间**不计入**（引擎也已经丢掉它了）。
    lastMs_ = clock_ ? clock_->nowMs() : 0;
}

bool Driver::paused() const {
    std::lock_guard<std::mutex> lk(mtx_);
    return engine_.paused();
}

int Driver::stepOnce(int64_t dtMs) {
    std::lock_guard<std::mutex> lk(mtx_);
    return engine_.step(dtMs);
}

int Driver::tickOnce() {
    std::lock_guard<std::mutex> lk(mtx_);
    const std::int64_t now = clock_ ? clock_->nowMs() : 0;
    if (!primed_) {
        lastMs_ = now;
        primed_ = true;
        return 0;
    }
    lastMs_ = now;
    return engine_.tick(now);
}

sim_source::Metrics Driver::metrics() const {
    std::lock_guard<std::mutex> lk(mtx_);
    return engine_.metrics();
}

std::int64_t Driver::simElapsedMs() const {
    std::lock_guard<std::mutex> lk(mtx_);
    return engine_.simElapsedMs();
}

void Driver::loop() {
    while (!stop_.load()) {
        {
            std::lock_guard<std::mutex> lk(mtx_);
            const std::int64_t now = clock_ ? clock_->nowMs() : 0;
            if (!primed_) {
                // 首 tick 只记基线，不推进（引擎自己的口径也是这样）。
                lastMs_ = now;
                primed_ = true;
            } else if (!engine_.paused()) {
                lastMs_ = now;
                engine_.tick(now);
            } else {
                // 暂停中：把基线跟着挂钟走，恢复时才不会"跳一下"。
                lastMs_ = now;
            }
            if (options_.maxSimMs > 0 && engine_.simElapsedMs() >= options_.maxSimMs) {
                stop_.store(true);
            }
        }
        const int interval = options_.tickIntervalMs > 0 ? options_.tickIntervalMs : 50;
        const std::int64_t deadline = steadyMs() + interval;
        while (!stop_.load() && steadyMs() < deadline) {
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
        }
    }
}

}  // namespace ma::sim_bridge
