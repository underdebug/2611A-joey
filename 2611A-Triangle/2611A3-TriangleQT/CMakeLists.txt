cmake_minimum_required(VERSION 3.21)
project(VulkanTriangle VERSION 1.0 LANGUAGES CXX)

# Include debug symbols by default with single-configuration generators.
if(NOT CMAKE_CONFIGURATION_TYPES AND NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Debug CACHE STRING "Build type" FORCE)
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

find_package(Qt6 6.4 REQUIRED COMPONENTS Quick)
find_package(Vulkan REQUIRED)
find_program(GLSLANG_VALIDATOR NAMES glslangValidator
    HINTS "$ENV{VULKAN_SDK}/bin" "$ENV{VULKAN_SDK}/Bin" REQUIRED)
qt_standard_project_setup()

qt_add_executable(VulkanTriangle src/main.cpp src/trianglerenderer.cpp src/trianglerenderer.h)
target_link_libraries(VulkanTriangle PRIVATE Qt6::Quick Vulkan::Vulkan)

set(SPIRV_FILES)
foreach(STAGE vert frag)
    set(SOURCE "${CMAKE_CURRENT_SOURCE_DIR}/shaders/triangle.${STAGE}")
    set(OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/shaders/triangle.${STAGE}.spv")
    add_custom_command(OUTPUT "${OUTPUT}"
        COMMAND ${CMAKE_COMMAND} -E make_directory "${CMAKE_CURRENT_BINARY_DIR}/shaders"
        COMMAND "${GLSLANG_VALIDATOR}" -V "${SOURCE}" -o "${OUTPUT}"
        DEPENDS "${SOURCE}" VERBATIM)
    list(APPEND SPIRV_FILES "${OUTPUT}")
endforeach()

qt_add_resources(VulkanTriangle shaders PREFIX "/shaders"
    BASE "${CMAKE_CURRENT_BINARY_DIR}/shaders" FILES ${SPIRV_FILES})
qt_add_resources(VulkanTriangle qml PREFIX "/" FILES qml/Main.qml)
