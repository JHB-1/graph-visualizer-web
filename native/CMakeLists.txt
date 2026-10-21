cmake_minimum_required(VERSION 3.24)
project(GraphVisualizerWeb LANGUAGES CXX)

if(NOT EMSCRIPTEN)
	message(FATAL_ERROR "This target requires the Emscripten toolchain")
endif()

set(GV_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(GV_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(GV_BUILD_TCP OFF CACHE BOOL "" FORCE)
set(GV_BUILD_THEME_IO OFF CACHE BOOL "" FORCE)
add_subdirectory("${GV_CORE_DIR}" core)
add_executable(gv_wasm ../.build/bridge.cpp)
target_include_directories(gv_wasm PRIVATE "${GV_CORE_DIR}/hosts/agent-plugin/native" "${GV_JSON_INCLUDE}")
target_link_libraries(gv_wasm PRIVATE gv::core)
target_compile_features(gv_wasm PRIVATE cxx_std_20)
target_compile_options(gv_wasm PRIVATE -fexceptions -g0)
target_compile_options(graph_core PRIVATE -fexceptions -g0)
target_link_options(gv_wasm PRIVATE
	-fexceptions -g0
	"-sMODULARIZE=1" "-sEXPORT_ES6=1" "-sENVIRONMENT=web,worker"
	"-sALLOW_MEMORY_GROWTH=1" "-sMAXIMUM_MEMORY=536870912" "-sFILESYSTEM=0"
	"-sEXPORTED_FUNCTIONS=['_gv_request']" "-sEXPORTED_RUNTIME_METHODS=['ccall']"
)
set_target_properties(gv_wasm PROPERTIES
	OUTPUT_NAME gv-core SUFFIX .mjs
	RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/../public/wasm"
)
