cmake_minimum_required(VERSION 3.21)

# Script mode embeds shaders during the build using this same file.
if(TRIANGLE_EMBED_SHADERS)
    # Convert little-endian SPIR-V bytes into aligned C++ uint32_t arrays.
    set(HEADER "#pragma once\n#include <cstdint>\n\n")
    foreach(STAGE VERT FRAG)
        file(READ "${${STAGE}}" SHADER_HEX HEX)
        string(LENGTH "${SHADER_HEX}" HEX_LENGTH)
        math(EXPR REMAINDER "${HEX_LENGTH} % 8")
        if(HEX_LENGTH LESS 8 OR NOT REMAINDER EQUAL 0)
            message(FATAL_ERROR "Invalid SPIR-V word length: ${${STAGE}}")
        endif()
        string(SUBSTRING "${SHADER_HEX}" 0 8 MAGIC)
        if(NOT MAGIC STREQUAL "03022307")
            message(FATAL_ERROR "Expected little-endian SPIR-V: ${${STAGE}}")
        endif()
        string(REGEX REPLACE
            "([0-9a-f][0-9a-f])([0-9a-f][0-9a-f])([0-9a-f][0-9a-f])([0-9a-f][0-9a-f])"
            "    0x\\4\\3\\2\\1u,\n" WORDS "${SHADER_HEX}")
        string(APPEND HEADER "inline constexpr std::uint32_t shader_${STAGE}[] = {\n${WORDS}};\n\n")
    endforeach()
    get_filename_component(OUTPUT_DIRECTORY "${OUTPUT}" DIRECTORY)
    file(MAKE_DIRECTORY "${OUTPUT_DIRECTORY}")
    file(WRITE "${OUTPUT}" "${HEADER}")
    return()
endif()

project(VulkanTriangle VERSION 1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

find_package(X11 REQUIRED)
find_package(Vulkan REQUIRED)
find_program(GLSLANG_VALIDATOR NAMES glslangValidator
    HINTS "$ENV{VULKAN_SDK}/bin" "$ENV{VULKAN_SDK}/Bin" REQUIRED)
add_executable(VulkanTriangle src/main.cpp src/trianglerenderer.cpp src/trianglerenderer.h)
target_compile_definitions(VulkanTriangle PRIVATE VK_USE_PLATFORM_XLIB_KHR)
target_link_libraries(VulkanTriangle PRIVATE X11::X11 Vulkan::Vulkan)
target_include_directories(VulkanTriangle PRIVATE "${CMAKE_CURRENT_BINARY_DIR}/generated")
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(VulkanTriangle PRIVATE -Wall -Wextra -Wpedantic)
endif()

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

set(SHADER_HEADER "${CMAKE_CURRENT_BINARY_DIR}/generated/shaders.h")
add_custom_command(OUTPUT "${SHADER_HEADER}"
    COMMAND ${CMAKE_COMMAND}
        -DTRIANGLE_EMBED_SHADERS=ON
        "-DVERT=${CMAKE_CURRENT_BINARY_DIR}/shaders/triangle.vert.spv"
        "-DFRAG=${CMAKE_CURRENT_BINARY_DIR}/shaders/triangle.frag.spv"
        "-DOUTPUT=${SHADER_HEADER}"
        -P "${CMAKE_CURRENT_SOURCE_DIR}/CMakeLists.txt"
    DEPENDS ${SPIRV_FILES} "${CMAKE_CURRENT_SOURCE_DIR}/CMakeLists.txt" VERBATIM)
target_sources(VulkanTriangle PRIVATE "${SHADER_HEADER}")

option(VULKAN_TRIANGLE_X11_TESTS "Enable the smoke test that opens an X11 window" OFF)
if(VULKAN_TRIANGLE_X11_TESTS)
    enable_testing()
    add_test(NAME x11-smoke COMMAND VulkanTriangle --smoke-test)
    set_tests_properties(x11-smoke PROPERTIES RUN_SERIAL TRUE TIMEOUT 45)
endif()
