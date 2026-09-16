# mission-app · packages/scenario-data/CMakeLists.txt
#
# 本地配置 → 中立结构的翻译层。**宿主侧的一个包**，不是模块仓：
# 它原地引用各模块的公开头编译，自己不产生"模块"。
#
# 目标名：ma_scenario_data（静态库）
cmake_minimum_required(VERSION 3.20)

add_library(ma_scenario_data STATIC
  src/scenario_dataset.cc)

target_include_directories(ma_scenario_data PUBLIC
  "${CMAKE_CURRENT_SOURCE_DIR}/include")

# 只吃两样东西：nlohmann/json（经各模块的公开依赖）+ sim-source 的**唯一公开头**。
target_link_libraries(ma_scenario_data PUBLIC sim_source)

set_target_properties(ma_scenario_data PROPERTIES
  CXX_STANDARD 17
  CXX_STANDARD_REQUIRED ON
  CXX_EXTENSIONS OFF
  POSITION_INDEPENDENT_CODE ON)

if(MSVC)
  target_compile_options(ma_scenario_data PRIVATE /utf-8 /W4 /permissive-)
  target_compile_definitions(ma_scenario_data PRIVATE
    NOMINMAX WIN32_LEAN_AND_MEAN _WIN32_WINNT=0x0A00 _CRT_SECURE_NO_WARNINGS)
else()
  target_compile_options(ma_scenario_data PRIVATE -Wall -Wextra)
endif()
