#include "trianglerenderer.h"
#include "shaders.h"

#include <algorithm>
#include <cstring>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>

namespace {
void check(VkResult result, const char *operation)
{
    if (result != VK_SUCCESS)
        throw std::runtime_error(std::string(operation) + " failed (VkResult "
                                 + std::to_string(result) + ")");
}
}

TriangleRenderer::TriangleRenderer(Display *display, Window window)
    : m_display(display), m_window(window)
{
    try {
        initialize();
    } catch (...) {
        cleanup();
        throw;
    }
}

TriangleRenderer::~TriangleRenderer()
{
    cleanup();
}

void TriangleRenderer::initialize()
{
    VkApplicationInfo app{};
    app.sType = VK_STRUCTURE_TYPE_APPLICATION_INFO;
    app.pApplicationName = "Vulkan Triangle - X11";
    app.apiVersion = VK_API_VERSION_1_0;
    const char *extensions[] = {VK_KHR_SURFACE_EXTENSION_NAME, VK_KHR_XLIB_SURFACE_EXTENSION_NAME};
    VkInstanceCreateInfo instance{};
    instance.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO;
    instance.pApplicationInfo = &app;
    instance.enabledExtensionCount = 2;
    instance.ppEnabledExtensionNames = extensions;
    check(vkCreateInstance(&instance, nullptr, &m_instance), "vkCreateInstance");

    VkXlibSurfaceCreateInfoKHR surface{};
    surface.sType = VK_STRUCTURE_TYPE_XLIB_SURFACE_CREATE_INFO_KHR;
    surface.dpy = m_display;
    surface.window = m_window;
    check(vkCreateXlibSurfaceKHR(m_instance, &surface, nullptr, &m_surface), "vkCreateXlibSurfaceKHR");

    uint32_t count = 0;
    check(vkEnumeratePhysicalDevices(m_instance, &count, nullptr), "vkEnumeratePhysicalDevices");
    std::vector<VkPhysicalDevice> devices(count);
    check(vkEnumeratePhysicalDevices(m_instance, &count, devices.data()), "vkEnumeratePhysicalDevices");
    for (auto physicalDevice : devices) {
        uint32_t extensionCount = 0;
        check(vkEnumerateDeviceExtensionProperties(physicalDevice, nullptr, &extensionCount, nullptr),
              "vkEnumerateDeviceExtensionProperties");
        std::vector<VkExtensionProperties> available(extensionCount);
        check(vkEnumerateDeviceExtensionProperties(physicalDevice, nullptr, &extensionCount, available.data()),
              "vkEnumerateDeviceExtensionProperties");
        if (std::none_of(available.begin(), available.end(), [](const auto &extension) {
                return std::strcmp(extension.extensionName, VK_KHR_SWAPCHAIN_EXTENSION_NAME) == 0;
            }))
            continue;
        uint32_t formatCount = 0, modeCount = 0;
        check(vkGetPhysicalDeviceSurfaceFormatsKHR(physicalDevice, m_surface, &formatCount, nullptr),
              "vkGetPhysicalDeviceSurfaceFormatsKHR");
        check(vkGetPhysicalDeviceSurfacePresentModesKHR(physicalDevice, m_surface, &modeCount, nullptr),
              "vkGetPhysicalDeviceSurfacePresentModesKHR");
        if (!formatCount || !modeCount)
            continue;
        uint32_t queueCount = 0;
        vkGetPhysicalDeviceQueueFamilyProperties(physicalDevice, &queueCount, nullptr);
        std::vector<VkQueueFamilyProperties> queues(queueCount);
        vkGetPhysicalDeviceQueueFamilyProperties(physicalDevice, &queueCount, queues.data());
        for (uint32_t i = 0; i < queueCount; ++i) {
            VkBool32 present = VK_FALSE;
            check(vkGetPhysicalDeviceSurfaceSupportKHR(physicalDevice, i, m_surface, &present),
                  "vkGetPhysicalDeviceSurfaceSupportKHR");
            if (queues[i].queueCount && (queues[i].queueFlags & VK_QUEUE_GRAPHICS_BIT) && present) {
                m_physicalDevice = physicalDevice;
                m_queueFamily = i;
                break;
            }
        }
        if (m_physicalDevice)
            break;
    }
    if (!m_physicalDevice)
        throw std::runtime_error("No Vulkan device has a graphics queue that can present to this X11 window");
    VkPhysicalDeviceProperties properties{};
    vkGetPhysicalDeviceProperties(m_physicalDevice, &properties);
    std::cout << "Vulkan device: " << properties.deviceName << '\n';

    const float priority = 1.0f;
    VkDeviceQueueCreateInfo queue{};
    queue.sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO;
    queue.queueFamilyIndex = m_queueFamily;
    queue.queueCount = 1;
    queue.pQueuePriorities = &priority;
    const char *deviceExtensions[] = {VK_KHR_SWAPCHAIN_EXTENSION_NAME};
    VkDeviceCreateInfo device{};
    device.sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO;
    device.queueCreateInfoCount = 1;
    device.pQueueCreateInfos = &queue;
    device.enabledExtensionCount = 1;
    device.ppEnabledExtensionNames = deviceExtensions;
    check(vkCreateDevice(m_physicalDevice, &device, nullptr, &m_device), "vkCreateDevice");
    vkGetDeviceQueue(m_device, m_queueFamily, 0, &m_queue);

    VkCommandPoolCreateInfo pool{};
    pool.sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO;
    pool.flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT;
    pool.queueFamilyIndex = m_queueFamily;
    check(vkCreateCommandPool(m_device, &pool, nullptr, &m_commandPool), "vkCreateCommandPool");
    VkCommandBufferAllocateInfo commands{};
    commands.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO;
    commands.commandPool = m_commandPool;
    commands.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
    commands.commandBufferCount = 1;
    check(vkAllocateCommandBuffers(m_device, &commands, &m_commands), "vkAllocateCommandBuffers");
    VkSemaphoreCreateInfo semaphore{};
    semaphore.sType = VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO;
    check(vkCreateSemaphore(m_device, &semaphore, nullptr, &m_imageAvailable), "vkCreateSemaphore");
    VkFenceCreateInfo fence{};
    fence.sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO;
    fence.flags = VK_FENCE_CREATE_SIGNALED_BIT;
    check(vkCreateFence(m_device, &fence, nullptr, &m_frameFence), "vkCreateFence");
}

void TriangleRenderer::createSwapchain()
{
    check(vkDeviceWaitIdle(m_device), "vkDeviceWaitIdle");
    // The sample uses a single frame in flight and rebuilds dependent objects
    // together, including the render pass/pipeline if the surface format changes.
    destroySwapchain();
    VkSurfaceCapabilitiesKHR capabilities{};
    check(vkGetPhysicalDeviceSurfaceCapabilitiesKHR(m_physicalDevice, m_surface, &capabilities),
          "vkGetPhysicalDeviceSurfaceCapabilitiesKHR");
    XWindowAttributes attributes{};
    if (!XGetWindowAttributes(m_display, m_window, &attributes))
        throw std::runtime_error("Cannot query X11 window dimensions");
    m_extent = capabilities.currentExtent;
    if (m_extent.width == std::numeric_limits<uint32_t>::max()) {
        m_extent.width = std::clamp(uint32_t(attributes.width), capabilities.minImageExtent.width,
                                    capabilities.maxImageExtent.width);
        m_extent.height = std::clamp(uint32_t(attributes.height), capabilities.minImageExtent.height,
                                     capabilities.maxImageExtent.height);
    }
    if (!m_extent.width || !m_extent.height)
        return;
    if (!(capabilities.supportedUsageFlags & VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT))
        throw std::runtime_error("X11 surface does not support color attachments");
    uint32_t count = 0;
    check(vkGetPhysicalDeviceSurfaceFormatsKHR(m_physicalDevice, m_surface, &count, nullptr),
          "vkGetPhysicalDeviceSurfaceFormatsKHR");
    if (!count)
        throw std::runtime_error("X11 surface has no Vulkan formats");
    std::vector<VkSurfaceFormatKHR> formats(count);
    check(vkGetPhysicalDeviceSurfaceFormatsKHR(m_physicalDevice, m_surface, &count, formats.data()),
          "vkGetPhysicalDeviceSurfaceFormatsKHR");
    auto format = formats.front();
    if (format.format == VK_FORMAT_UNDEFINED)
        format.format = VK_FORMAT_B8G8R8A8_UNORM;
    for (const auto &candidate : formats) {
        if (candidate.format == VK_FORMAT_B8G8R8A8_UNORM
            && candidate.colorSpace == VK_COLOR_SPACE_SRGB_NONLINEAR_KHR) {
            format = candidate;
            break;
        }
    }
    m_format = format.format;
    uint32_t imageCount = capabilities.minImageCount + 1;
    if (capabilities.maxImageCount)
        imageCount = std::min(imageCount, capabilities.maxImageCount);
    VkSwapchainCreateInfoKHR swapchain{};
    swapchain.sType = VK_STRUCTURE_TYPE_SWAPCHAIN_CREATE_INFO_KHR;
    swapchain.surface = m_surface;
    swapchain.minImageCount = imageCount;
    swapchain.imageFormat = m_format;
    swapchain.imageColorSpace = format.colorSpace;
    swapchain.imageExtent = m_extent;
    swapchain.imageArrayLayers = 1;
    swapchain.imageUsage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT;
    swapchain.imageSharingMode = VK_SHARING_MODE_EXCLUSIVE;
    swapchain.preTransform = capabilities.currentTransform;
    for (auto alpha : {VK_COMPOSITE_ALPHA_OPAQUE_BIT_KHR, VK_COMPOSITE_ALPHA_PRE_MULTIPLIED_BIT_KHR,
                       VK_COMPOSITE_ALPHA_POST_MULTIPLIED_BIT_KHR, VK_COMPOSITE_ALPHA_INHERIT_BIT_KHR}) {
        if (capabilities.supportedCompositeAlpha & alpha) {
            swapchain.compositeAlpha = alpha;
            break;
        }
    }
    swapchain.presentMode = VK_PRESENT_MODE_FIFO_KHR;
    swapchain.clipped = VK_TRUE;
    check(vkCreateSwapchainKHR(m_device, &swapchain, nullptr, &m_swapchain), "vkCreateSwapchainKHR");
    check(vkGetSwapchainImagesKHR(m_device, m_swapchain, &count, nullptr), "vkGetSwapchainImagesKHR");
    std::vector<VkImage> images(count);
    check(vkGetSwapchainImagesKHR(m_device, m_swapchain, &count, images.data()), "vkGetSwapchainImagesKHR");
    images.resize(count);

    VkAttachmentDescription attachment{};
    attachment.format = m_format;
    attachment.samples = VK_SAMPLE_COUNT_1_BIT;
    attachment.loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR;
    attachment.storeOp = VK_ATTACHMENT_STORE_OP_STORE;
    attachment.stencilLoadOp = VK_ATTACHMENT_LOAD_OP_DONT_CARE;
    attachment.stencilStoreOp = VK_ATTACHMENT_STORE_OP_DONT_CARE;
    attachment.initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;
    attachment.finalLayout = VK_IMAGE_LAYOUT_PRESENT_SRC_KHR;
    VkAttachmentReference reference{0, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL};
    VkSubpassDescription subpass{};
    subpass.pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS;
    subpass.colorAttachmentCount = 1;
    subpass.pColorAttachments = &reference;
    VkSubpassDependency dependency{};
    dependency.srcSubpass = VK_SUBPASS_EXTERNAL;
    dependency.dstSubpass = 0;
    dependency.srcStageMask = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT;
    dependency.dstStageMask = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT;
    dependency.dstAccessMask = VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT;
    VkRenderPassCreateInfo pass{};
    pass.sType = VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO;
    pass.attachmentCount = 1;
    pass.pAttachments = &attachment;
    pass.subpassCount = 1;
    pass.pSubpasses = &subpass;
    pass.dependencyCount = 1;
    pass.pDependencies = &dependency;
    check(vkCreateRenderPass(m_device, &pass, nullptr, &m_renderPass), "vkCreateRenderPass");
    createPipeline();

    // Pre-size with null handles so cleanup also works on partial initialization.
    m_views.resize(count, VK_NULL_HANDLE);
    m_framebuffers.resize(count, VK_NULL_HANDLE);
    m_renderFinished.resize(count, VK_NULL_HANDLE);
    for (uint32_t i = 0; i < count; ++i) {
        VkImageViewCreateInfo view{};
        view.sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO;
        view.image = images[i];
        view.viewType = VK_IMAGE_VIEW_TYPE_2D;
        view.format = m_format;
        view.subresourceRange.aspectMask = VK_IMAGE_ASPECT_COLOR_BIT;
        view.subresourceRange.levelCount = view.subresourceRange.layerCount = 1;
        check(vkCreateImageView(m_device, &view, nullptr, &m_views[i]), "vkCreateImageView");
        VkFramebufferCreateInfo framebuffer{};
        framebuffer.sType = VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO;
        framebuffer.renderPass = m_renderPass;
        framebuffer.attachmentCount = 1;
        framebuffer.pAttachments = &m_views[i];
        framebuffer.width = m_extent.width;
        framebuffer.height = m_extent.height;
        framebuffer.layers = 1;
        check(vkCreateFramebuffer(m_device, &framebuffer, nullptr, &m_framebuffers[i]), "vkCreateFramebuffer");
        VkSemaphoreCreateInfo semaphore{};
        semaphore.sType = VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO;
        check(vkCreateSemaphore(m_device, &semaphore, nullptr, &m_renderFinished[i]), "vkCreateSemaphore");
    }
    m_resizePending = false;
}

VkShaderModule TriangleRenderer::loadShader(const uint32_t *words, size_t size)
{
    VkShaderModuleCreateInfo info{};
    info.sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO;
    info.codeSize = size;
    info.pCode = words;
    VkShaderModule module = VK_NULL_HANDLE;
    check(vkCreateShaderModule(m_device, &info, nullptr, &module), "vkCreateShaderModule");
    return module;
}

void TriangleRenderer::createPipeline()
{
    const VkShaderModule vertex = loadShader(shader_VERT, sizeof(shader_VERT));
    VkShaderModule fragment = VK_NULL_HANDLE;
    try {
        fragment = loadShader(shader_FRAG, sizeof(shader_FRAG));
        VkPushConstantRange constants{};
        constants.stageFlags = VK_SHADER_STAGE_VERTEX_BIT;
        constants.size = 2 * sizeof(float);
        VkPipelineLayoutCreateInfo layout{};
        layout.sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO;
        layout.pushConstantRangeCount = 1;
        layout.pPushConstantRanges = &constants;
        check(vkCreatePipelineLayout(m_device, &layout, nullptr, &m_layout), "vkCreatePipelineLayout");

        VkPipelineShaderStageCreateInfo stages[2]{};
        for (auto &stage : stages) {
            stage.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
            stage.pName = "main";
        }
        stages[0].stage = VK_SHADER_STAGE_VERTEX_BIT;
        stages[0].module = vertex;
        stages[1].stage = VK_SHADER_STAGE_FRAGMENT_BIT;
        stages[1].module = fragment;

        VkPipelineVertexInputStateCreateInfo input{};
        input.sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO;
        VkPipelineInputAssemblyStateCreateInfo assembly{};
        assembly.sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO;
        assembly.topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST;
        VkPipelineViewportStateCreateInfo viewport{};
        viewport.sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO;
        viewport.viewportCount = viewport.scissorCount = 1;
        VkPipelineRasterizationStateCreateInfo raster{};
        raster.sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO;
        raster.polygonMode = VK_POLYGON_MODE_FILL;
        raster.cullMode = VK_CULL_MODE_NONE;
        raster.frontFace = VK_FRONT_FACE_COUNTER_CLOCKWISE;
        raster.lineWidth = 1.0f;
        VkPipelineMultisampleStateCreateInfo samples{};
        samples.sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO;
        samples.rasterizationSamples = VK_SAMPLE_COUNT_1_BIT;
        VkPipelineDepthStencilStateCreateInfo depth{};
        depth.sType = VK_STRUCTURE_TYPE_PIPELINE_DEPTH_STENCIL_STATE_CREATE_INFO;
        VkPipelineColorBlendAttachmentState attachment{};
        attachment.colorWriteMask = VK_COLOR_COMPONENT_R_BIT | VK_COLOR_COMPONENT_G_BIT
                                 | VK_COLOR_COMPONENT_B_BIT | VK_COLOR_COMPONENT_A_BIT;
        VkPipelineColorBlendStateCreateInfo blend{};
        blend.sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO;
        blend.attachmentCount = 1;
        blend.pAttachments = &attachment;
        const VkDynamicState dynamicStates[] = {VK_DYNAMIC_STATE_VIEWPORT, VK_DYNAMIC_STATE_SCISSOR};
        VkPipelineDynamicStateCreateInfo dynamic{};
        dynamic.sType = VK_STRUCTURE_TYPE_PIPELINE_DYNAMIC_STATE_CREATE_INFO;
        dynamic.dynamicStateCount = 2;
        dynamic.pDynamicStates = dynamicStates;

        VkGraphicsPipelineCreateInfo pipeline{};
        pipeline.sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO;
        pipeline.stageCount = 2;
        pipeline.pStages = stages;
        pipeline.pVertexInputState = &input;
        pipeline.pInputAssemblyState = &assembly;
        pipeline.pViewportState = &viewport;
        pipeline.pRasterizationState = &raster;
        pipeline.pMultisampleState = &samples;
        pipeline.pDepthStencilState = &depth;
        pipeline.pColorBlendState = &blend;
        pipeline.pDynamicState = &dynamic;
        pipeline.layout = m_layout;
        pipeline.renderPass = m_renderPass;
        check(vkCreateGraphicsPipelines(m_device, VK_NULL_HANDLE, 1, &pipeline, nullptr,
                                       &m_pipeline), "vkCreateGraphicsPipelines");
    } catch (...) {
        vkDestroyShaderModule(m_device, vertex, nullptr);
        vkDestroyShaderModule(m_device, fragment, nullptr);
        throw;
    }
    vkDestroyShaderModule(m_device, vertex, nullptr);
    vkDestroyShaderModule(m_device, fragment, nullptr);
}

bool TriangleRenderer::render(float angle)
{
    if (m_resizePending)
        createSwapchain();
    if (!m_swapchain)
        return false;
    check(vkWaitForFences(m_device, 1, &m_frameFence, VK_TRUE, UINT64_MAX), "vkWaitForFences");
    uint32_t imageIndex = 0;
    // Finite acquire timeout keeps the X11 event loop responsive when occluded.
    const VkResult acquired = vkAcquireNextImageKHR(m_device, m_swapchain, 100000000,
                                                    m_imageAvailable, VK_NULL_HANDLE, &imageIndex);
    if (acquired == VK_ERROR_OUT_OF_DATE_KHR) {
        m_resizePending = true;
        return false;
    }
    if (acquired == VK_TIMEOUT || acquired == VK_NOT_READY)
        return false;
    if (acquired != VK_SUBOPTIMAL_KHR)
        check(acquired, "vkAcquireNextImageKHR");
    check(vkResetCommandBuffer(m_commands, 0), "vkResetCommandBuffer");
    VkCommandBufferBeginInfo begin{};
    begin.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
    begin.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
    check(vkBeginCommandBuffer(m_commands, &begin), "vkBeginCommandBuffer");
    const VkClearValue clear{{{16.0f / 255, 24.0f / 255, 39.0f / 255, 1.0f}}};
    VkRenderPassBeginInfo pass{};
    pass.sType = VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO;
    pass.renderPass = m_renderPass;
    pass.framebuffer = m_framebuffers[imageIndex];
    pass.renderArea.extent = m_extent;
    pass.clearValueCount = 1;
    pass.pClearValues = &clear;
    vkCmdBeginRenderPass(m_commands, &pass, VK_SUBPASS_CONTENTS_INLINE);
    const float width = float(m_extent.width), height = float(m_extent.height);
    const VkViewport viewport{0, 0, width, height, 0, 1};
    const VkRect2D scissor{{0, 0}, m_extent};
    const float constants[] = {angle, width / height};
    vkCmdBindPipeline(m_commands, VK_PIPELINE_BIND_POINT_GRAPHICS, m_pipeline);
    vkCmdSetViewport(m_commands, 0, 1, &viewport);
    vkCmdSetScissor(m_commands, 0, 1, &scissor);
    vkCmdPushConstants(m_commands, m_layout, VK_SHADER_STAGE_VERTEX_BIT, 0, sizeof(constants), constants);
    vkCmdDraw(m_commands, 3, 1, 0, 0);
    vkCmdEndRenderPass(m_commands);
    check(vkEndCommandBuffer(m_commands), "vkEndCommandBuffer");

    const VkPipelineStageFlags waitStage = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT;
    VkSubmitInfo submit{};
    submit.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO;
    submit.waitSemaphoreCount = 1;
    submit.pWaitSemaphores = &m_imageAvailable;
    submit.pWaitDstStageMask = &waitStage;
    submit.commandBufferCount = 1;
    submit.pCommandBuffers = &m_commands;
    submit.signalSemaphoreCount = 1;
    submit.pSignalSemaphores = &m_renderFinished[imageIndex];
    check(vkResetFences(m_device, 1, &m_frameFence), "vkResetFences");
    check(vkQueueSubmit(m_queue, 1, &submit, m_frameFence), "vkQueueSubmit");
    VkPresentInfoKHR present{};
    present.sType = VK_STRUCTURE_TYPE_PRESENT_INFO_KHR;
    present.waitSemaphoreCount = 1;
    present.pWaitSemaphores = &m_renderFinished[imageIndex];
    present.swapchainCount = 1;
    present.pSwapchains = &m_swapchain;
    present.pImageIndices = &imageIndex;
    const VkResult result = vkQueuePresentKHR(m_queue, &present);
    if (result == VK_ERROR_OUT_OF_DATE_KHR || result == VK_SUBOPTIMAL_KHR)
        m_resizePending = true;
    else
        check(result, "vkQueuePresentKHR");
    if (acquired == VK_SUBOPTIMAL_KHR)
        m_resizePending = true;
    return result == VK_SUCCESS || result == VK_SUBOPTIMAL_KHR;
}

void TriangleRenderer::destroySwapchain()
{
    for (auto framebuffer : m_framebuffers)
        vkDestroyFramebuffer(m_device, framebuffer, nullptr);
    for (auto view : m_views)
        vkDestroyImageView(m_device, view, nullptr);
    for (auto semaphore : m_renderFinished)
        vkDestroySemaphore(m_device, semaphore, nullptr);
    m_framebuffers.clear();
    m_views.clear();
    m_renderFinished.clear();
    vkDestroyPipeline(m_device, m_pipeline, nullptr);
    vkDestroyPipelineLayout(m_device, m_layout, nullptr);
    vkDestroyRenderPass(m_device, m_renderPass, nullptr);
    vkDestroySwapchainKHR(m_device, m_swapchain, nullptr);
    m_pipeline = VK_NULL_HANDLE;
    m_layout = VK_NULL_HANDLE;
    m_renderPass = VK_NULL_HANDLE;
    m_swapchain = VK_NULL_HANDLE;
}

void TriangleRenderer::cleanup()
{
    if (m_device) {
        vkDeviceWaitIdle(m_device);
        destroySwapchain();
        vkDestroyFence(m_device, m_frameFence, nullptr);
        vkDestroySemaphore(m_device, m_imageAvailable, nullptr);
        vkDestroyCommandPool(m_device, m_commandPool, nullptr);
        vkDestroyDevice(m_device, nullptr);
    }
    if (m_surface)
        vkDestroySurfaceKHR(m_instance, m_surface, nullptr);
    if (m_instance)
        vkDestroyInstance(m_instance, nullptr);
}
