#include "trianglerenderer.h"

#include <QFile>
#include <QQuickItem>
#include <QQuickView>
#include <QSGRendererInterface>
#include <cstring>
#include <vector>

namespace {
void check(VkResult result, const char *operation)
{
    if (result != VK_SUCCESS)
        qFatal("%s failed (VkResult %d)", operation, int(result));
}

template<typename T>
T resource(QQuickView *view, QSGRendererInterface::Resource kind)
{
    auto *pointer = static_cast<T *>(view->rendererInterface()->getResource(view, kind));
    if (!pointer)
        qFatal("Qt did not expose required Vulkan resource %d", int(kind));
    return *pointer;
}
}

TriangleRenderer::TriangleRenderer(QQuickView *view) : QObject(view), m_view(view)
{
    // Direct connections execute on Qt's render thread. Synchronization is the
    // only phase in which we read QML properties, while the GUI thread is blocked.
    connect(view, &QQuickWindow::beforeSynchronizing, this,
            &TriangleRenderer::synchronize, Qt::DirectConnection);
    connect(view, &QQuickWindow::beforeRendering, this,
            &TriangleRenderer::initialize, Qt::DirectConnection);
    connect(view, &QQuickWindow::beforeRenderPassRecording, this,
            &TriangleRenderer::render, Qt::DirectConnection);
    connect(view, &QQuickWindow::sceneGraphInvalidated, this,
            &TriangleRenderer::cleanup, Qt::DirectConnection);
}

void TriangleRenderer::synchronize()
{
    m_pixelSize = m_view->size() * m_view->devicePixelRatio();
    if (m_view->rootObject())
        m_angle = m_view->rootObject()->property("angle").toFloat();
}

VkShaderModule TriangleRenderer::loadShader(const QString &path)
{
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly))
        qFatal("Cannot open shader %s", qPrintable(path));
    const QByteArray bytes = file.readAll();
    if (bytes.isEmpty() || bytes.size() % sizeof(uint32_t) != 0)
        qFatal("Invalid SPIR-V shader %s", qPrintable(path));
    // A word vector guarantees the alignment required by Vulkan.
    std::vector<uint32_t> words(size_t(bytes.size()) / sizeof(uint32_t));
    std::memcpy(words.data(), bytes.constData(), size_t(bytes.size()));
    VkShaderModuleCreateInfo info{};
    info.sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO;
    info.codeSize = size_t(bytes.size());
    info.pCode = words.data();
    VkShaderModule module = VK_NULL_HANDLE;
    check(vkCreateShaderModule(m_device, &info, nullptr, &module), "vkCreateShaderModule");
    return module;
}

void TriangleRenderer::initialize()
{
    if (m_pipeline)
        return;
    if (m_view->rendererInterface()->graphicsApi() != QSGRendererInterface::Vulkan)
        qFatal("This sample requires the Qt Quick Vulkan backend");

    m_device = resource<VkDevice>(m_view, QSGRendererInterface::DeviceResource);
    const VkRenderPass pass = resource<VkRenderPass>(m_view, QSGRendererInterface::RenderPassResource);
    const VkShaderModule vertex = loadShader(":/shaders/triangle.vert.spv");
    const VkShaderModule fragment = loadShader(":/shaders/triangle.frag.spv");

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
    pipeline.renderPass = pass;
    check(vkCreateGraphicsPipelines(m_device, VK_NULL_HANDLE, 1, &pipeline, nullptr,
                                   &m_pipeline), "vkCreateGraphicsPipelines");
    vkDestroyShaderModule(m_device, vertex, nullptr);
    vkDestroyShaderModule(m_device, fragment, nullptr);
    qInfo("Native Vulkan triangle pipeline ready");
}

void TriangleRenderer::render()
{
    if (!m_pipeline || m_pixelSize.isEmpty())
        return;
    m_view->beginExternalCommands();
    const VkCommandBuffer commands = resource<VkCommandBuffer>(
        m_view, QSGRendererInterface::CommandListResource);
    const float width = float(m_pixelSize.width());
    const float height = float(m_pixelSize.height());
    const VkViewport viewport{0, 0, width, height, 0, 1};
    const VkRect2D scissor{{0, 0}, {uint32_t(m_pixelSize.width()), uint32_t(m_pixelSize.height())}};
    const float constants[] = {m_angle, width / height};
    vkCmdBindPipeline(commands, VK_PIPELINE_BIND_POINT_GRAPHICS, m_pipeline);
    vkCmdSetViewport(commands, 0, 1, &viewport);
    vkCmdSetScissor(commands, 0, 1, &scissor);
    vkCmdPushConstants(commands, m_layout, VK_SHADER_STAGE_VERTEX_BIT, 0,
                       sizeof(constants), constants);
    vkCmdDraw(commands, 3, 1, 0, 0);
    m_view->endExternalCommands();
}

void TriangleRenderer::cleanup()
{
    // Qt emits invalidation while its device is still valid. Wait for any
    // submitted frames before releasing objects referenced by their commands.
    if (m_device) {
        vkDeviceWaitIdle(m_device);
        vkDestroyPipeline(m_device, m_pipeline, nullptr);
        vkDestroyPipelineLayout(m_device, m_layout, nullptr);
    }
    m_pipeline = VK_NULL_HANDLE;
    m_layout = VK_NULL_HANDLE;
    m_device = VK_NULL_HANDLE;
}
