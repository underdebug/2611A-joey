#include "trianglerenderer.h"

#include <X11/XKBlib.h>
#include <X11/Xatom.h>
#include <X11/Xutil.h>
#include <X11/keysym.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <iostream>
#include <memory>
#include <poll.h>
#include <stdexcept>
#include <string>
#include <unistd.h>

namespace {
constexpr int headerHeight = 64;
constexpr int footerHeight = 72;
constexpr int buttonWidth = 170;
constexpr int buttonHeight = 36;

// Xlib draws the chrome; Vulkan presents into a separate child window so the
// two APIs never paint over the same drawable.
class X11Window final
{
public:
    explicit X11Window(Display *connection) : display(connection)
    {
        const int screen = DefaultScreen(display);
        background = color("#101827", BlackPixel(display, screen));
        foreground = color("#f1f5f9", WhitePixel(display, screen));
        muted = color("#94a3b8", foreground);
        buttonColor = color("#1e293b", background);
        window = XCreateSimpleWindow(display, RootWindow(display, screen), 0, 0,
                                     width, height, 0, background, background);
        XStoreName(display, window, "Vulkan Triangle - X11 / C++");
        XClassHint classHint{};
        char resourceName[] = "vulkan-triangle";
        char resourceClass[] = "VulkanTriangle";
        classHint.res_name = resourceName;
        classHint.res_class = resourceClass;
        XSetClassHint(display, window, &classHint);
        const unsigned long processId = static_cast<unsigned long>(getpid());
        XChangeProperty(display, window, XInternAtom(display, "_NET_WM_PID", False),
                        XA_CARDINAL, 32, PropModeReplace,
                        reinterpret_cast<const unsigned char *>(&processId), 1);
        char host[256]{};
        if (gethostname(host, sizeof(host) - 1) == 0) {
            XTextProperty machine{};
            char *hostName = host;
            if (XStringListToTextProperty(&hostName, 1, &machine)) {
                XSetWMClientMachine(display, window, &machine);
                XFree(machine.value);
            }
        }
        XSizeHints hints{};
        hints.flags = PMinSize;
        hints.min_width = 480;
        hints.min_height = 360;
        XSetWMNormalHints(display, window, &hints);
        deleteWindow = XInternAtom(display, "WM_DELETE_WINDOW", False);
        protocols = XInternAtom(display, "WM_PROTOCOLS", False);
        XSetWMProtocols(display, window, &deleteWindow, 1);
        XSelectInput(display, window, ExposureMask | StructureNotifyMask | KeyPressMask
                                     | KeyReleaseMask | ButtonPressMask | FocusChangeMask);
        canvas = XCreateSimpleWindow(display, window, 0, headerHeight, width,
                                     height - headerHeight - footerHeight, 0, background, background);
        XSelectInput(display, canvas, StructureNotifyMask | ButtonPressMask);
        gc = XCreateGC(display, window, 0, nullptr);
        font = XLoadQueryFont(display, "9x15");
        if (!font)
            font = XLoadQueryFont(display, "fixed");
        if (font)
            XSetFont(display, gc, font->fid);
        Bool detectable = False;
        XkbSetDetectableAutoRepeat(display, True, &detectable);
        XMapWindow(display, canvas);
        XMapWindow(display, window);
        XSync(display, False);
    }

    ~X11Window()
    {
        XFreeGC(display, gc);
        if (font)
            XFreeFont(display, font);
        XDestroyWindow(display, window); // Also destroys the canvas.
    }
    X11Window(const X11Window &) = delete;
    X11Window &operator=(const X11Window &) = delete;

    void draw(bool spinning)
    {
        XClearWindow(display, window);
        XSetForeground(display, gc, foreground);
        text(24, 26, "Vulkan Triangle");
        XSetForeground(display, gc, muted);
        text(24, 49, "C++ / Vulkan / X11 - Space: pause, Esc: quit");
        const int x = (width - buttonWidth) / 2;
        const int y = height - footerHeight + 16;
        XSetForeground(display, gc, buttonColor);
        XFillRectangle(display, window, gc, x, y, buttonWidth, buttonHeight);
        XSetForeground(display, gc, muted);
        XDrawRectangle(display, window, gc, x, y, buttonWidth, buttonHeight);
        XSetForeground(display, gc, foreground);
        const char *label = spinning ? "Pause rotation" : "Resume rotation";
        const int length = int(std::strlen(label));
        const int labelWidth = font ? XTextWidth(font, label, length) : length * 6;
        text(x + (buttonWidth - labelWidth) / 2, y + 23, label);
        XFlush(display);
    }

    bool onButton(int x, int y) const
    {
        const int left = (width - buttonWidth) / 2;
        const int top = height - footerHeight + 16;
        return x >= left && x < left + buttonWidth && y >= top && y < top + buttonHeight;
    }

    Display *display;
    Window window = 0, canvas = 0;
    Atom deleteWindow = 0, protocols = 0;
    int width = 960, height = 640;

private:
    unsigned long color(const char *name, unsigned long fallback)
    {
        XColor exact{}, allocated{};
        return XAllocNamedColor(display, DefaultColormap(display, DefaultScreen(display)),
                                name, &allocated, &exact) ? allocated.pixel : fallback;
    }
    void text(int x, int y, const char *value)
    {
        XDrawString(display, window, gc, x, y, value, int(std::strlen(value)));
    }
    GC gc = nullptr;
    XFontStruct *font = nullptr;
    unsigned long background, foreground, muted, buttonColor;
};
}

int main(int argc, char *argv[])
{
    bool smokeTest = false;
    for (int i = 1; i < argc; ++i) {
        const std::string argument = argv[i];
        if (argument == "--smoke-test")
            smokeTest = true;
        else if (argument == "--help") {
            std::cout << "Usage: VulkanTriangle [--smoke-test]\n"
                         "Space or the button pauses/resumes rotation; Escape quits.\n";
            return 0;
        } else {
            std::cerr << "Unknown option: " << argument << '\n';
            return 1;
        }
    }
    try {
        std::unique_ptr<Display, decltype(&XCloseDisplay)> display(XOpenDisplay(nullptr), &XCloseDisplay);
        if (!display)
            throw std::runtime_error("Cannot open X11 display; run in an X11/XWayland session with DISPLAY set");
        X11Window window(display.get());
        // Declared after the window: Vulkan must be destroyed before its X11 surface.
        TriangleRenderer renderer(display.get(), window.canvas);
        bool running = true, spinning = true, mapped = false, spaceDown = false;
        float angle = 0.0f;
        unsigned long frames = 0;
        using Clock = std::chrono::steady_clock;
        const auto start = Clock::now();
        auto previous = start;
        const auto toggle = [&] {
            spinning = !spinning;
            window.draw(spinning);
        };
        while (running) {
            const auto frameStart = Clock::now();
            const float elapsed = std::chrono::duration<float>(frameStart - previous).count();
            previous = frameStart;
            if (spinning && mapped)
                angle = std::fmod(angle + elapsed * 0.6283185307f, 6.283185307f);
            while (XPending(display.get())) {
                XEvent event{};
                XNextEvent(display.get(), &event);
                switch (event.type) {
                case ClientMessage:
                    if (event.xclient.window == window.window && event.xclient.message_type == window.protocols
                        && event.xclient.format == 32 && Atom(event.xclient.data.l[0]) == window.deleteWindow)
                        running = false;
                    break;
                case MapNotify:
                    if (event.xmap.window == window.window) {
                        mapped = true;
                        renderer.resize();
                    }
                    break;
                case UnmapNotify:
                    if (event.xunmap.window == window.window)
                        mapped = false;
                    break;
                case ConfigureNotify:
                    if (event.xconfigure.window == window.window
                        && (window.width != event.xconfigure.width || window.height != event.xconfigure.height)) {
                        window.width = event.xconfigure.width;
                        window.height = event.xconfigure.height;
                        XMoveResizeWindow(display.get(), window.canvas, 0, headerHeight,
                                          std::max(1, window.width),
                                          std::max(1, window.height - headerHeight - footerHeight));
                        XSync(display.get(), False);
                        renderer.resize();
                        window.draw(spinning);
                    }
                    break;
                case Expose:
                    if (event.xexpose.window == window.window && event.xexpose.count == 0)
                        window.draw(spinning);
                    break;
                case KeyPress: {
                    const KeySym key = XLookupKeysym(&event.xkey, 0);
                    if (key == XK_Escape)
                        running = false;
                    else if (key == XK_space && !spaceDown) {
                        spaceDown = true;
                        toggle();
                    }
                    break;
                }
                case KeyRelease:
                    // Legacy X servers represent autorepeat as release/press pairs.
                    if (XPending(display.get())) {
                        XEvent next{};
                        XPeekEvent(display.get(), &next);
                        if (next.type == KeyPress && next.xkey.time == event.xkey.time
                            && next.xkey.keycode == event.xkey.keycode)
                            break;
                    }
                    if (XLookupKeysym(&event.xkey, 0) == XK_space)
                        spaceDown = false;
                    break;
                case FocusOut:
                    spaceDown = false;
                    break;
                case ButtonPress:
                    if (event.xbutton.button == Button1) {
                        XSetInputFocus(display.get(), window.window, RevertToParent, event.xbutton.time);
                        if (event.xbutton.window == window.window
                            && window.onButton(event.xbutton.x, event.xbutton.y))
                            toggle();
                    }
                    break;
                }
            }
            if (!running || (smokeTest && frameStart - start >= std::chrono::milliseconds(2500)))
                break;
            if (mapped && renderer.render(angle))
                ++frames;
            const auto used = std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - frameStart).count();
            const int timeout = mapped ? int(std::max<int64_t>(0, 16 - used)) : 50;
            if (!XPending(display.get())) {
                pollfd connection{ConnectionNumber(display.get()), POLLIN, 0};
                poll(&connection, 1, timeout);
            }
        }
        if (smokeTest) {
            if (!frames)
                throw std::runtime_error("Smoke test did not present any Vulkan frames");
            std::cout << "X11 smoke test passed: " << frames << " frames presented\n";
        }
    } catch (const std::exception &error) {
        std::cerr << "VulkanTriangle: " << error.what() << '\n';
        return 1;
    }
    return 0;
}
