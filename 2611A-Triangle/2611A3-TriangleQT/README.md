# Qt/QML Vulkan Triangle

A C++17 / Qt 6 application drawing a rotating RGB triangle with native Vulkan.
QML draws the title and pause/resume control. Press Space to pause or Escape to quit.

## Requirements

- CMake 3.21+, Ninja, and a C++17 compiler
- Qt 6.4+ development files for Qt Quick and the QtQuick QML runtime module
- Vulkan headers, loader, a Vulkan-capable driver, and `glslangValidator`
- A graphical desktop session (X11 or Wayland on Linux)

On Debian/Ubuntu, the usual development packages are `build-essential cmake
ninja-build qt6-base-dev qt6-declarative-dev qml6-module-qtquick
qml6-module-qtqml-workerscript libvulkan-dev glslang-tools mesa-vulkan-drivers`.
Use your hardware vendor's Vulkan driver where appropriate.

## Build and run

From this directory:

```sh
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Debug
cmake --build build --parallel
./build/VulkanTriangle
```

All generated files, compiled SPIR-V shaders,
and the executable go into `build/`. QML and shaders are embedded in the executable.
CMake defaults to `Debug` (including debug symbols) for single-configuration
generators such as Ninja. Pass `-DCMAKE_BUILD_TYPE=Release` for a release build.
For a Qt installation outside the system paths, pass `-DCMAKE_PREFIX_PATH=/path/to/Qt`.

Open this folder in VS Code. Ctrl+Shift+B configures and builds; F5 starts
the Linux GDB debugger using `.vscode/launch.json`. Install the C/C++ and
CMake Tools extensions manually if needed.

## Rendering flow

- `src/main.cpp` selects Qt Quick's Vulkan backend and creates the QML view.
- `src/trianglerenderer.cpp` obtains Qt's device and render pass, creates a Vulkan
  graphics pipeline, and records `vkCmdDraw` with three vertices.
- `shaders/triangle.vert` generates positions and colors using `gl_VertexIndex`;
  push constants carry the QML rotation angle and window aspect ratio.
- `shaders/triangle.frag` interpolates the vertex colors.
- `qml/Main.qml` animates the angle and provides the overlay controls.

Qt owns the Vulkan instance, device, swapchain, frame synchronization, and render
pass. Custom commands run on the render thread between `beginExternalCommands()`
and `endExternalCommands()`. QML state is copied while the GUI thread is blocked
for scene synchronization. Pipeline resources are released on scene invalidation.
The sample uses one sample per pixel; keep that setting consistent with the pipeline.

This integration follows the public Qt Quick rendering hooks documented in
[Vulkan Under QML](https://doc.qt.io/qt-6/qtquick-scenegraph-vulkanunderqml-example.html).

For startup diagnostics, run `QSG_INFO=1 ./build/VulkanTriangle --smoke-test`.
It exits after 2.5 seconds. A working Vulkan driver and desktop display are required;
the offscreen/software Qt platform does not exercise this native Vulkan renderer.

The build and X11 smoke test passed on this machine with Qt 6.4.2 and Intel Vulkan.
The local Wayland session reported a connection error after pipeline creation. If
you encounter that error, use X11/XWayland:

```sh
QT_QPA_PLATFORM=xcb ./build/VulkanTriangle
```

The VS Code launch configuration selects `xcb` for this environment. Remove that
environment entry to use your desktop's default platform.
