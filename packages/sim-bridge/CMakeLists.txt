# mission-app · packages/sim-bridge/CMakeLists.txt
#
# 中立事件 → 线上格式 → 真实链路。
#
#   udp_wire_sink.cc   UdpWireSink：中立事件 → 一行报文（UDP 单播）
#   clock.cc           WallClock（IClock 实现）
#   driver.cc          Driver：真实时间节拍推进 + 暂停 / 单步 / 倍速
#   sim_bridge.cc      装配入口 + 双跑逐字节比对（确定性自证）
#
# 只吃 sim-source 的**唯一公开头**；MUST NOT include 它的内部文件。
cmake_minimum_required(VERSION 3.20)

add_library(ma_sim_bridge STATIC
  src/udp_wire_sink.cc
  src/clock.cc
  src/driver.cc
  src/sim_bridge.cc)

target_include_directories(ma_sim_bridge PUBLIC
  "${CMAKE_CURRENT_SOURCE_DIR}/include")

target_link_libraries(ma_sim_bridge PUBLIC sim_source ma_scenario_data)

# Windows 上要 ws2_32 才有 sendto（其余平台用系统 socket）。
if(WIN32)
  target_link_libraries(ma_sim_bridge PUBLIC ws2_32)
endif()

set_target_properties(ma_sim_bridge PROPERTIES
  CXX_STANDARD 17
  CXX_STANDARD_REQUIRED ON
  CXX_EXTENSIONS OFF
  POSITION_INDEPENDENT_CODE ON)

if(MSVC)
  target_compile_options(ma_sim_bridge PRIVATE /utf-8 /W4 /permissive-)
  target_compile_definitions(ma_sim_bridge PRIVATE
    NOMINMAX WIN32_LEAN_AND_MEAN _WIN32_WINNT=0x0A00 _CRT_SECURE_NO_WARNINGS)
else()
  target_compile_options(ma_sim_bridge PRIVATE -Wall -Wextra)
endif()
