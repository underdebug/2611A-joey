cmake_minimum_required(VERSION 3.20)
project(vulkan_triangle LANGUAGES CXX)

find_package(Vulkan REQUIRED)
find_package(glfw3 3.3 REQUIRED)
find_package(glm CONFIG REQUIRED)
find_program(GLSLANG_VALIDATOR glslangValidator REQUIRED)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(SHADER_OUTPUT_DIR "${CMAKE_CURRENT_BINARY_DIR}/shaders")
file(MAKE_DIRECTORY "${SHADER_OUTPUT_DIR}")

foreach(SHADER triangle.vert triangle.frag)
    add_custom_command(
        OUTPUT "${SHADER_OUTPUT_DIR}/${SHADER}.spv"
        COMMAND "${GLSLANG_VALIDATOR}" -V
                "${CMAKE_CURRENT_SOURCE_DIR}/shaders/${SHADER}"
                -o "${SHADER_OUTPUT_DIR}/${SHADER}.spv"
        DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/shaders/${SHADER}"
        VERBATIM
    )
    list(APPEND SHADER_BINARIES "${SHADER_OUTPUT_DIR}/${SHADER}.spv")
endforeach()

add_custom_target(vulkan_shaders DEPENDS ${SHADER_BINARIES})

add_executable(vulkan_triangle src/main.cpp)
add_dependencies(vulkan_triangle vulkan_shaders)
target_link_libraries(vulkan_triangle PRIVATE Vulkan::Vulkan glfw glm::glm)
target_compile_definitions(vulkan_triangle PRIVATE
    SHADER_DIR="${SHADER_OUTPUT_DIR}"
    GLM_FORCE_DEPTH_ZERO_TO_ONE
)

if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(vulkan_triangle PRIVATE
        -Wall -Wextra -Wpedantic -Wno-missing-field-initializers
    )
endif()
