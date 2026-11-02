#pragma once

#include <vulkan/vulkan.h>
#include <cstddef>
#include <cstdint>
#include <vector>

// Owns the Vulkan objects attached to an Xlib window. The Display and Window
// must outlive this object. All calls run on the X11 event-loop thread.
class TriangleRenderer final
{
public:
    TriangleRenderer(Display *display, Window window);
    ~TriangleRenderer();
    TriangleRenderer(const TriangleRenderer &) = delete;
    TriangleRenderer &operator=(const TriangleRenderer &) = delete;
    void resize() { m_resizePending = true; }
    bool render(float angle);

private:
    void initialize();
    void createSwapchain();
    void createPipeline();
    void destroySwapchain();
    void cleanup();
    VkShaderModule loadShader(const uint32_t *words, size_t size);

    Display *m_display;
    Window m_window;
    VkInstance m_instance = VK_NULL_HANDLE;
    VkSurfaceKHR m_surface = VK_NULL_HANDLE;
    VkPhysicalDevice m_physicalDevice = VK_NULL_HANDLE;
    VkDevice m_device = VK_NULL_HANDLE;
    uint32_t m_queueFamily = 0;
    VkQueue m_queue = VK_NULL_HANDLE;
    VkSwapchainKHR m_swapchain = VK_NULL_HANDLE;
    VkExtent2D m_extent{};
    VkFormat m_format = VK_FORMAT_UNDEFINED;
    std::vector<VkImageView> m_views;
    std::vector<VkFramebuffer> m_framebuffers;
    // Presentation waits use one semaphore per swapchain image.
    std::vector<VkSemaphore> m_renderFinished;
    VkRenderPass m_renderPass = VK_NULL_HANDLE;
    VkPipelineLayout m_layout = VK_NULL_HANDLE;
    VkPipeline m_pipeline = VK_NULL_HANDLE;
    VkCommandPool m_commandPool = VK_NULL_HANDLE;
    VkCommandBuffer m_commands = VK_NULL_HANDLE;
    VkSemaphore m_imageAvailable = VK_NULL_HANDLE;
    VkFence m_frameFence = VK_NULL_HANDLE;
    bool m_resizePending = true;
};
