# mission-app - P0 装配骨架（assembly skeleton）
#
# 本文件只做一件事：把 webMap/ 下**已经存在的**模块原地装到一起。
#   - 模块源码一行不拷、一行不改（MUST NOT copy module sources）
#   - 全部路径相对 CMAKE_CURRENT_SOURCE_DIR 锚定，整个 webMap/ 可整体搬迁
#   - 本文件里没有任何业务逻辑：只有"设开关 -> add_subdirectory -> 链目标"
#
# 尚未写好的模块（sim-source / sensor-model）用 if(EXISTS ...) 条件包含：
# 它们一落地，重新 configure 就会自动接上，本文件不需要改。
cmake_minimum_required(VERSION 3.20)

project(mission_app
  VERSION 0.1.0
  DESCRIPTION "P0 装配骨架：证明既有模块能被装到一起、能编译、能链接、能实例化"
  LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# vcpkg 的 x64-windows 三元组由 MSVC 以**动态 CRT**（/MD）构建，本工程必须一致，
# 否则会出现"同一个 std::string 在两份堆上分配"这类难查的崩溃。
if(MSVC)
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreadedDLL" CACHE STRING "" FORCE)
endif()

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "构建类型" FORCE)
endif()

# ================================================================ 模块位置
#
# 模块与本仓**必须同级**（都在 webMap/ 下）。
set(ASM_WEBMAP_DIR "${CMAKE_CURRENT_SOURCE_DIR}/.." CACHE PATH "webMap 根目录（各模块的父目录）")

set(MA_PHASE_DIR     "${ASM_WEBMAP_DIR}/phase-engine"    CACHE PATH "phase-engine 源码目录")
set(MA_RESOURCE_DIR  "${ASM_WEBMAP_DIR}/resource-alloc"  CACHE PATH "resource-alloc 源码目录")
set(MA_SCORING_DIR   "${ASM_WEBMAP_DIR}/scoring"         CACHE PATH "scoring 源码目录")
set(MA_LEDGER_DIR    "${ASM_WEBMAP_DIR}/entity-ledger"   CACHE PATH "entity-ledger 源码目录")
set(MA_TOPOLOGY_DIR  "${ASM_WEBMAP_DIR}/topology"        CACHE PATH "topology 源码目录")
set(MA_ALERT_DIR     "${ASM_WEBMAP_DIR}/alert-engine"    CACHE PATH "alert-engine 源码目录")
set(MA_REPORT_DIR    "${ASM_WEBMAP_DIR}/report-engine"   CACHE PATH "report-engine 源码目录")
set(MA_SELFCHECK_DIR "${ASM_WEBMAP_DIR}/selfcheck"       CACHE PATH "selfcheck 源码目录")
set(MA_GEO_DIR       "${ASM_WEBMAP_DIR}/geo-data"        CACHE PATH "geo-data 源码目录")
set(MA_INGEST_DIR    "${ASM_WEBMAP_DIR}/device-ingest"   CACHE PATH "device-ingest 源码目录")
set(MA_STORE_DIR     "${ASM_WEBMAP_DIR}/telemetry-store" CACHE PATH "telemetry-store 源码目录")
set(MA_HUB_DIR       "${ASM_WEBMAP_DIR}/realtime-hub"    CACHE PATH "realtime-hub 源码目录（server/ 子目录才是 CMake 工程）")
set(MA_SIMSRC_DIR    "${ASM_WEBMAP_DIR}/sim-source"      CACHE PATH "sim-source 源码目录（另一个 agent 在写）")
set(MA_SENSORMODEL_DIR "${ASM_WEBMAP_DIR}/sensor-model"  CACHE PATH "sensor-model 源码目录（另一个 agent 在写）")
set(MA_MAP2D_DIR     "${ASM_WEBMAP_DIR}/map-2d"          CACHE PATH "map-2d 源码目录（npm 包，Vite 别名引用，不是 CMake 目标）")
set(MA_MEDIAPLAYER_DIR "${ASM_WEBMAP_DIR}/media-player"  CACHE PATH "media-player 源码目录（npm 包，不是 CMake 目标）")

foreach(_mod IN ITEMS
    "${MA_PHASE_DIR}/include/phase/phase_engine.h"
    "${MA_RESOURCE_DIR}/include/resource_alloc/resource_alloc.h"
    "${MA_SCORING_DIR}/include/scoring/scoring.h"
    "${MA_LEDGER_DIR}/include/entity_ledger/entity_ledger.h"
    "${MA_TOPOLOGY_DIR}/include/topology/topology_engine.h"
    "${MA_ALERT_DIR}/include/alert_engine/alert_engine.h"
    "${MA_REPORT_DIR}/include/report_engine/report_engine.h"
    "${MA_SELFCHECK_DIR}/include/selfcheck/selfcheck.h"
    "${MA_GEO_DIR}/include/geo_data/server/service.h"
    "${MA_INGEST_DIR}/include/device_ingest/gateway.h"
    "${MA_STORE_DIR}/include/telemetry_store/store.h"
    "${MA_HUB_DIR}/server/include/realtime_hub/hub.h")
  if(NOT EXISTS "${_mod}")
    message(FATAL_ERROR
      "[mission-app] 找不到模块头文件：${_mod}\n"
      "  本仓必须与各模块**同级**（都在 webMap/ 下）。\n"
      "  当前推断的 webMap 根目录：${ASM_WEBMAP_DIR}\n"
      "  若目录结构不同，请用 -DASM_WEBMAP_DIR=<路径> 指定。")
  endif()
endforeach()

# ================================================================ 依赖：Drogon（HTTP/静态托管）
#
# 本机可用的 Drogon 在 vcpkg 树里（已构建好 drogon/trantor/openssl/jsoncpp/nlohmann_json...）。
# 写法照抄 assembly-host/CMakeLists.txt:61-70。
if(NOT DEFINED MA_VCPKG_DIR)
  set(MA_VCPKG_DIR
      "D:/dsh_workpath/mapApp/backend/build/vcpkg_installed/x64-windows"
      CACHE PATH "vcpkg 安装树（含 DrogonConfig.cmake 与 drogon.dll）")
endif()
list(APPEND CMAKE_PREFIX_PATH "${MA_VCPKG_DIR}")

# ================================================================ 模块开关（MA_ 前缀，避免与模块选项撞名）
option(MA_BUILD_PHASE     "装配 phase-engine"     ON)
option(MA_BUILD_RESOURCE  "装配 resource-alloc"   ON)
option(MA_BUILD_SCORING   "装配 scoring"          ON)
option(MA_BUILD_LEDGER    "装配 entity-ledger"    ON)
option(MA_BUILD_TOPOLOGY  "装配 topology"         ON)
option(MA_BUILD_ALERT     "装配 alert-engine"     ON)
option(MA_BUILD_REPORT    "装配 report-engine"    ON)
option(MA_BUILD_SELFCHECK "装配 selfcheck"        ON)
option(MA_BUILD_GEO       "装配 geo-data"         ON)
option(MA_BUILD_INGEST    "装配 device-ingest"    ON)
option(MA_BUILD_STORE     "装配 telemetry-store"  ON)
option(MA_BUILD_HUB       "装配 realtime-hub"     ON)
# 两个"另一个 agent 正在写"的模块：落地即自动接上，但允许单独掐掉。
# 用途：它们写到一半（编译不过）时，本仓的 P0 验收仍然能证明"其余模块装得起来"。
option(MA_BUILD_SIM_SOURCE   "条件包含 sim-source（模块一落地就接上）"   ON)
option(MA_BUILD_SENSOR_MODEL "条件包含 sensor-model（模块一落地就接上）" ON)
option(MA_WARNINGS_AS_ERRORS "把编译告警当错误"    OFF)

# 模块自带的测试/示例/工具一律不编（本仓只验装配；编了会拖慢并制造重名目标）。
set(_MA_OFF OFF)

# ================================================================ 依赖 1：phase-engine
# 每个模块都在自己目录里 set(CMAKE_BUILD_TYPE ... FORCE)，本工程统一按 Release 配置
# （-DCMAKE_CONFIGURATION_TYPES=Release 由 scripts/acceptance.ps1 传入），两边一致。
if(MA_BUILD_PHASE)
  set(PHASE_ENGINE_BUILD_TESTS    ${_MA_OFF} CACHE BOOL "" FORCE)
  set(PHASE_ENGINE_BUILD_EXAMPLES ${_MA_OFF} CACHE BOOL "" FORCE)
  add_subdirectory("${MA_PHASE_DIR}" "${CMAKE_BINARY_DIR}/modules/phase-engine")
  set(MA_HAVE_PHASE ON)
else()
  set(MA_HAVE_PHASE OFF)
endif()

# ================================================================ 依赖 2：resource-alloc
if(MA_BUILD_RESOURCE)
  set(RESOURCE_ALLOC_BUILD_TESTS    ${_MA_OFF} CACHE BOOL "" FORCE)
  set(RESOURCE_ALLOC_BUILD_EXAMPLES ${_MA_OFF} CACHE BOOL "" FORCE)
  add_subdirectory("${MA_RESOURCE_DIR}" "${CMAKE_BINARY_DIR}/modules/resource-alloc")
  set(MA_HAVE_RESOURCE ON)
else()
  set(MA_HAVE_RESOURCE OFF)
endif()

# ================================================================ 依赖 3：scoring
if(MA_BUILD_SCORING)
  set(SCORING_BUILD_TESTS    ${_MA_OFF} CACHE BOOL "" FORCE)
  set(SCORING_BUILD_EXAMPLES ${_MA_OFF} CACHE BOOL "" FORCE)
  add_subdirectory("${MA_SCORING_DIR}" "${CMAKE_BINARY_DIR}/modules/scoring")
  set(MA_HAVE_SCORING ON)
else()
  set(MA_HAVE_SCORING OFF)
endif()

# ================================================================ 依赖 4：entity-ledger
if(MA_BUILD_LEDGER)
  set(ENTITY_LEDGER_BUILD_TESTS    ${_MA_OFF} CACHE BOOL "" FORCE)
  set(ENTITY_LEDGER_BUILD_EXAMPLES ${_MA_OFF} CACHE BOOL "" FORCE)
  add_subdirectory("${MA_LEDGER_DIR}" "${CMAKE_BINARY_DIR}/modules/entity-ledger")
  set(MA_HAVE_LEDGER ON)
else()
  set(MA_HAVE_LEDGER OFF)
endif()

# ================================================================ 依赖 5：topology
if(MA_BUILD_TOPOLOGY)
  set(TOPOLOGY_BUILD_TESTS    ${_MA_OFF} CACHE BOOL "" FORCE)
  set(TOPOLOGY_BUILD_EXAMPLES ${_MA_OFF} CACHE BOOL "" FORCE)
  add_subdirectory("${MA_TOPOLOGY_DIR}" "${CMAKE_BINARY_DIR}/modules/topology")
  set(MA_HAVE_TOPOLOGY ON)
else()
  set(MA_HAVE_TOPOLOGY OFF)
endif()

# ================================================================ 依赖 6：alert-engine
if(MA_BUILD_ALERT)
  set(ALERT_ENGINE_BUILD_TESTS    ${_MA_OFF} CACHE BOOL "" FORCE)
  set(ALERT_ENGINE_BUILD_EXAMPLES ${_MA_OFF} CACHE BOOL "" FORCE)
  add_subdirectory("${MA_ALERT_DIR}" "${CMAKE_BINARY_DIR}/modules/alert-engine")
  set(MA_HAVE_ALERT ON)
else()
  set(MA_HAVE_ALERT OFF)
endif()

# ================================================================ 依赖 7：report-engine
if(MA_BUILD_REPORT)
  set(REPORT_ENGINE_BUILD_TESTS    ${_MA_OFF} CACHE BOOL "" FORCE)
  set(REPORT_ENGINE_BUILD_EXAMPLES ${_MA_OFF} CACHE BOOL "" FORCE)
  add_subdirectory("${MA_REPORT_DIR}" "${CMAKE_BINARY_DIR}/modules/report-engine")
  set(MA_HAVE_REPORT ON)
else()
  set(MA_HAVE_REPORT OFF)
endif()

# ================================================================ 依赖 8：selfcheck（引擎库 + probes_mapapp 探针包）
if(MA_BUILD_SELFCHECK)
  set(SELFCHECK_BUILD_TESTS     ${_MA_OFF} CACHE BOOL "" FORCE)
  set(SELFCHECK_BUILD_EXAMPLES  ${_MA_OFF} CACHE BOOL "" FORCE)
  set(SELFCHECK_BUILD_PROBEPACK ON     CACHE BOOL "" FORCE)  # probes_mapapp 要链进来
  add_subdirectory("${MA_SELFCHECK_DIR}" "${CMAKE_BINARY_DIR}/modules/selfcheck")
  set(MA_HAVE_SELFCHECK ON)
  if(TARGET probes_mapapp)
    set(MA_HAVE_PROBES_MAPAPP ON)
  else()
    set(MA_HAVE_PROBES_MAPAPP OFF)
  endif()
else()
  set(MA_HAVE_SELFCHECK OFF)
  set(MA_HAVE_PROBES_MAPAPP OFF)
endif()

# ================================================================ 依赖 9：geo-data（goa_data::tool / geo_data::server）
if(MA_BUILD_GEO)
  set(GEO_DATA_BUILD_TOOL     ON      CACHE BOOL "" FORCE)  # geo_data::tool 是公开目标，保留
  set(GEO_DATA_BUILD_SERVER   ON      CACHE BOOL "" FORCE)  # geo_data::server 瓦片路由
  set(GEO_DATA_BUILD_EXAMPLES ${_MA_OFF} CACHE BOOL "" FORCE)
  set(GEO_DATA_BUILD_TESTS    ${_MA_OFF} CACHE BOOL "" FORCE)
  add_subdirectory("${MA_GEO_DIR}" "${CMAKE_BINARY_DIR}/modules/geo-data")
  set(MA_HAVE_GEO ON)
else()
  set(MA_HAVE_GEO OFF)
endif()

# ================================================================ 依赖 10：device-ingest
# WITH_HUB=OFF：hub 层不编译（广播中枢的归属由 realtime-hub 单独决定，见 assembly-host 的
# 两套广播中枢归属方案）。这里只取"接入 + 队列 + 回调"。
if(MA_BUILD_INGEST)
  set(DEVICE_INGEST_WITH_HUB       OFF     CACHE BOOL "" FORCE)
  set(DEVICE_INGEST_BUILD_TOOLS    ${_MA_OFF} CACHE BOOL "" FORCE)
  set(DEVICE_INGEST_BUILD_EXAMPLES ${_MA_OFF} CACHE BOOL "" FORCE)
  set(DEVICE_INGEST_BUILD_TESTS    ${_MA_OFF} CACHE BOOL "" FORCE)
  add_subdirectory("${MA_INGEST_DIR}" "${CMAKE_BINARY_DIR}/modules/device-ingest")
  set(MA_HAVE_INGEST ON)
else()
  set(MA_HAVE_INGEST OFF)
endif()

# ================================================================ 依赖 11：telemetry-store
if(MA_BUILD_STORE)
  set(TELEMETRY_STORE_BUILD_TESTS    ${_MA_OFF} CACHE BOOL "" FORCE)
  set(TELEMETRY_STORE_BUILD_EXAMPLES ${_MA_OFF} CACHE BOOL "" FORCE)
  set(TELEMETRY_STORE_BUILD_TOOLS    ${_MA_OFF} CACHE BOOL "" FORCE)
  add_subdirectory("${MA_STORE_DIR}" "${CMAKE_BINARY_DIR}/modules/telemetry-store")
  set(MA_HAVE_STORE ON)
else()
  set(MA_HAVE_STORE OFF)
endif()

# ================================================================ 依赖 12：realtime-hub
# server/ 下才是 CMake 工程（顶层 CMakeLists.txt 只是外壳）。
# 本工程自己调 enable_testing()，早于任何可能调用它的子目录。
enable_testing()
if(MA_BUILD_HUB)
  set(REALTIME_HUB_BUILD_EXAMPLES ${_MA_OFF} CACHE BOOL "" FORCE)
  set(REALTIME_HUB_BUILD_TESTS    ${_MA_OFF} CACHE BOOL "" FORCE)
  add_subdirectory("${MA_HUB_DIR}" "${CMAKE_BINARY_DIR}/modules/realtime-hub")
  set(MA_HAVE_HUB ON)
else()
  set(MA_HAVE_HUB OFF)
endif()

# ================================================================ 条件包含：sim-source / sensor-model
#
# 这两个仓由另一个 agent 在写。用 if(EXISTS ...) 条件包含：
# 它们一落地（出现 CMakeLists.txt），重新 configure 就自动接上，本文件不用改。
#
# 它们自带的 examples/tests 一律不编（与上面 12 个模块同一条纪律：本仓只验装配）。
# 变量在 add_subdirectory **之前**设成 CACHE BOOL FORCE，才会盖住模块自己的 option()。
foreach(_pair IN ITEMS "sim-source|sim_source|${MA_SIMSRC_DIR}|${MA_BUILD_SIM_SOURCE}"
                       "sensor-model|sensor_model|${MA_SENSORMODEL_DIR}|${MA_BUILD_SENSOR_MODEL}")
  string(REPLACE "|" ";" _parts "${_pair}")
  list(GET _parts 0 _name)
  list(GET _parts 1 _target)
  list(GET _parts 2 _dir)
  list(GET _parts 3 _wanted)
  string(TOUPPER "${_target}" _upper)
  if(NOT _wanted)
    message(STATUS "[mission-app] 跳过 ${_name}：开关 MA_BUILD_${_upper} 关闭")
    set(MA_HAVE_${_upper} OFF)
  elseif(EXISTS "${_dir}/CMakeLists.txt")
    message(STATUS "[mission-app] 条件包含 ${_name}：发现 ${_dir}/CMakeLists.txt，接入装配")
    set(${_upper}_BUILD_TESTS    ${_MA_OFF} CACHE BOOL "" FORCE)
    set(${_upper}_BUILD_EXAMPLES ${_MA_OFF} CACHE BOOL "" FORCE)
    add_subdirectory("${_dir}" "${CMAKE_BINARY_DIR}/modules/${_name}")
    set(MA_HAVE_${_upper} ON)
  else()
    message(STATUS "[mission-app] 跳过 ${_name}：${_dir}/CMakeLists.txt 还不存在（等模块落地后重新 configure 即自动接上）")
    set(MA_HAVE_${_upper} OFF)
  endif()
endforeach()

# ================================================================ 依赖：Drogon
if(NOT TARGET Drogon::Drogon)
  find_package(Drogon CONFIG REQUIRED)
endif()
message(STATUS "[mission-app] Drogon: ${Drogon_DIR}")

# ================================================================ 宿主可执行
add_executable(mission_host
  packages/host/src/main.cc
  packages/host/src/config.cc
  packages/host/src/registry.cc
  packages/host/src/adapters.cc
  packages/host/src/engines.cc
  packages/host/src/host_server.cc)

target_include_directories(mission_host PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/packages/host/include")

target_link_libraries(mission_host PRIVATE Drogon::Drogon)

# 哪些模块真的装进来了 —— 编成宏给宿主用，宿主据此决定实例化谁。
# 这样"模块不在"是**编译期事实**，宿主里不需要写任何运行期兜底分支。
foreach(_flag IN ITEMS PHASE RESOURCE SCORING LEDGER TOPOLOGY ALERT REPORT SELFCHECK GEO
                       INGEST STORE HUB PROBES_MAPAPP SIM_SOURCE SENSOR_MODEL)
  if(MA_HAVE_${_flag})
    target_compile_definitions(mission_host PRIVATE "MA_WITH_${_flag}=1")
  else()
    target_compile_definitions(mission_host PRIVATE "MA_WITH_${_flag}=0")
  endif()
endforeach()

if(MA_HAVE_PHASE)
  target_link_libraries(mission_host PRIVATE phase_engine::phase_engine)
endif()
if(MA_HAVE_RESOURCE)
  target_link_libraries(mission_host PRIVATE resource_alloc::resource_alloc)
endif()
if(MA_HAVE_SCORING)
  target_link_libraries(mission_host PRIVATE scoring::scoring)
endif()
if(MA_HAVE_LEDGER)
  target_link_libraries(mission_host PRIVATE entity_ledger::entity_ledger)
endif()
if(MA_HAVE_TOPOLOGY)
  target_link_libraries(mission_host PRIVATE topology::topology)
endif()
if(MA_HAVE_ALERT)
  target_link_libraries(mission_host PRIVATE alert_engine::alert_engine)
endif()
if(MA_HAVE_REPORT)
  target_link_libraries(mission_host PRIVATE report_engine::report_engine)
endif()
if(MA_HAVE_SELFCHECK)
  target_link_libraries(mission_host PRIVATE selfcheck::selfcheck)
endif()
# 探针包是**规则侧**的目标（selfcheck 自己产出）；它在不在直接看 TARGET，不绕变量。
if(TARGET probes_mapapp)
  target_link_libraries(mission_host PRIVATE probes_mapapp)
  target_compile_definitions(mission_host PRIVATE MA_WITH_PROBES_MAPAPP=1)
else()
  target_compile_definitions(mission_host PRIVATE MA_WITH_PROBES_MAPAPP=0)
endif()
if(MA_HAVE_GEO)
  target_link_libraries(mission_host PRIVATE geo_data::server geo_data::tool)
endif()
if(MA_HAVE_INGEST)
  target_link_libraries(mission_host PRIVATE device_ingest::device_ingest)
endif()
if(MA_HAVE_STORE)
  target_link_libraries(mission_host PRIVATE telemetry_store::telemetry_store)
endif()
if(MA_HAVE_HUB)
  target_link_libraries(mission_host PRIVATE realtime_hub::realtime_hub)
endif()
if(MA_HAVE_SIM_SOURCE AND TARGET sim_source)
  target_link_libraries(mission_host PRIVATE sim_source)
endif()
if(MA_HAVE_SENSOR_MODEL AND TARGET sensor_model)
  target_link_libraries(mission_host PRIVATE sensor_model)
endif()

# 本仓源码（packages/host、CMakeLists.txt）里的路径常量：宿主用它找 web/dist 与 config.json。
target_compile_definitions(mission_host PRIVATE
  "MA_REPO_ROOT=\"${CMAKE_CURRENT_SOURCE_DIR}\""
  "MA_WEBMAP_ROOT=\"${ASM_WEBMAP_DIR}\"")

if(MSVC)
  target_compile_options(mission_host PRIVATE /utf-8 /W4 /permissive-)
  target_compile_definitions(mission_host PRIVATE
    NOMINMAX WIN32_LEAN_AND_MEAN _WIN32_WINNT=0x0A00 _CRT_SECURE_NO_WARNINGS)
  if(MA_WARNINGS_AS_ERRORS)
    target_compile_options(mission_host PRIVATE /WX)
  endif()
else()
  target_compile_options(mission_host PRIVATE -Wall -Wextra)
endif()

set_target_properties(mission_host PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")

# ---------------------------------------------------------------- 把 vcpkg 的 DLL 拷到 exe 旁边
# vcpkg 的 x64-windows 三元组是动态链接：不拷 DLL 的话 exe 一启动就报缺 drogon.dll。
if(WIN32)
  set(_ma_dll_dir "${MA_VCPKG_DIR}/bin")
  if(EXISTS "${_ma_dll_dir}")
    file(GLOB _ma_dlls "${_ma_dll_dir}/*.dll")
    add_custom_command(TARGET mission_host POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E copy_if_different ${_ma_dlls}
              "$<TARGET_FILE_DIR:mission_host>"
      COMMENT "[mission-app] 拷贝运行期 DLL 到输出目录")
  else()
    message(WARNING
      "[mission-app] 未找到 ${_ma_dll_dir}，运行时可能缺 drogon.dll 等动态库；"
      "请把 vcpkg 的 bin/ 加入 PATH。")
  endif()
endif()

# ================================================================ 汇总
message(STATUS "[mission-app] ${PROJECT_NAME} ${PROJECT_VERSION} . C++${CMAKE_CXX_STANDARD}")
message(STATUS "[mission-app]   webMap : ${ASM_WEBMAP_DIR}")
foreach(_pair IN ITEMS
    "phase-engine|MA_HAVE_PHASE"
    "resource-alloc|MA_HAVE_RESOURCE"
    "scoring|MA_HAVE_SCORING"
    "entity-ledger|MA_HAVE_LEDGER"
    "topology|MA_HAVE_TOPOLOGY"
    "alert-engine|MA_HAVE_ALERT"
    "report-engine|MA_HAVE_REPORT"
    "selfcheck|MA_HAVE_SELFCHECK"
    "geo-data|MA_HAVE_GEO"
    "device-ingest|MA_HAVE_INGEST"
    "telemetry-store|MA_HAVE_STORE"
    "realtime-hub|MA_HAVE_HUB")
  string(REPLACE "|" ";" _p "${_pair}")
  list(GET _p 0 _n)
  list(GET _p 1 _v)
  if(${_v})
    message(STATUS "[mission-app]   ${_n} : 已装配")
  else()
    message(STATUS "[mission-app]   ${_n} : 未装配（开关关闭）")
  endif()
endforeach()
if(MA_HAVE_SIMSRC)
  message(STATUS "[mission-app]   sim-source : 已装配（条件包含）")
else()
  message(STATUS "[mission-app]   sim-source : 未装配（模块尚未落地）")
endif()
if(MA_HAVE_SENSOR_MODEL)
  message(STATUS "[mission-app]   sensor-model : 已装配（条件包含）")
else()
  message(STATUS "[mission-app]   sensor-model : 未装配（模块尚未落地）")
endif()
message(STATUS "[mission-app]   map-2d / media-player : npm 包，由 apps/web 经 Vite 别名原地引用")
message(STATUS "[mission-app]   构建类型 : ${CMAKE_BUILD_TYPE}")
