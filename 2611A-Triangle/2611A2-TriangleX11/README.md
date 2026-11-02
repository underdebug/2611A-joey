# X11 / Vulkan Triangle

A C++17 application drawing a rotating RGB triangle with Vulkan in a native X11
window. Xlib creates the window, draws the title and pause/resume button, and
handles keyboard, mouse, resize, and window-manager events. No Qt or QML is required.

## Requirements

- CMake 3.21+, Ninja, and a C++17 compiler
- Xlib development files
- Vulkan headers, loader, a Vulkan-capable driver, and `glslangValidator`
- An X11 server (or XWayland) accessible through `DISPLAY`

On Debian/Ubuntu:

```sh
sudo apt install build-essential cmake ninja-build libx11-dev libvulkan-dev glslang-tools mesa-vulkan-drivers
```

Use your hardware vendor's Vulkan driver where appropriate.

## Build and run

```sh
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Debug
cmake --build build --parallel
./build/VulkanTriangle
```

Click **Pause rotation** or press **Space** to pause/resume. Press **Escape** or
use the window manager's close button to quit. Resizing preserves the triangle's
proportions. Rendering stops while the window is unmapped/minimized.

All generated files and the executable go into `build/`. Compiled SPIR-V shaders
are embedded in the executable, so it can run from any working directory.

Open this folder in VS Code. Ctrl+Shift+B configures and builds; F5 builds and starts
the Linux GDB debugger using `.vscode/launch.json`. Install the recommended C++ and
CMake Tools extensions when prompted. The debugger inherits your `DISPLAY`.

## Rendering flow

- `src/main.cpp` uses Xlib to create a top-level window and a child Vulkan canvas.
  Xlib paints the header and button outside the canvas. Its event loop handles
  input, animates the angle, and forwards size changes to the renderer.
- `src/trianglerenderer.cpp` creates the Vulkan instance, `VK_KHR_xlib_surface`
  surface, device, swapchain, render pass, pipeline, and frame synchronization.
  It chooses a device with a graphics queue that also supports X11 presentation.
- A single frame in flight uses a submission fence and an image-acquired semaphore.
  Each swapchain image has its own presentation semaphore, following the
  [Khronos semaphore reuse guidance](https://docs.vulkan.org/guide/latest/swapchain_semaphore_reuse.html).
- Resize and out-of-date/suboptimal swapchains trigger recreation of the swapchain
  and its dependent objects after waiting for the device to idle.
- `shaders/triangle.vert` generates three vertices using `gl_VertexIndex`; push
  constants supply rotation and aspect ratio. `shaders/triangle.frag` interpolates
  their colors. `CMakeLists.txt` embeds the compiled shaders as C++ words.
- Vulkan resources are released before destroying the X11 window and connection.

## Checks

```sh
./build/VulkanTriangle --smoke-test
```

The smoke test runs for about 2.5 seconds after Vulkan initialization and reports
how many frames were presented. It fails if no frames were presented. A working
Vulkan driver and accessible X11 display are required; it is not a headless test.

To enable the X11 smoke test in CTest:

```sh
cmake -S . -B build -DVULKAN_TRIANGLE_X11_TESTS=ON
cmake --build build --parallel
ctest --test-dir build --output-on-failure
```

With the Khronos validation layer installed, enable Vulkan API diagnostics using
`VK_INSTANCE_LAYERS=VK_LAYER_KHRONOS_validation`. To select a specific driver during
checks, set `VK_ICD_FILENAMES` to that driver's ICD JSON file.
