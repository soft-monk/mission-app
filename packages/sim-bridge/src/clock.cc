// mission-app · packages/sim-bridge/src/clock.cc
#include "ma/sim_bridge/sim_bridge.h"

#include <chrono>

namespace ma::sim_bridge {

std::int64_t WallClock::nowMs() const {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}

}  // namespace ma::sim_bridge
