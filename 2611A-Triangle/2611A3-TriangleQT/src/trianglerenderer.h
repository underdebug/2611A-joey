#pragma once

// Include Vulkan first so the loader prototypes are available before Qt headers.
#include <vulkan/vulkan.h>
#include <QObject>
#include <QSize>

class QQuickView;

// Qt owns the device, swapchain, render pass and frame synchronization.
// This class owns only its pipeline and records one native Vulkan draw.
class TriangleRenderer final : public QObject
{
public:
    explicit TriangleRenderer(QQuickView *view);

private:
    void synchronize();
    void initialize();
    void render();
    void cleanup();
    VkShaderModule loadShader(const QString &path);

    QQuickView *m_view;
    QSize m_pixelSize;
    float m_angle = 0.0f;
    VkDevice m_device = VK_NULL_HANDLE;
    VkPipelineLayout m_layout = VK_NULL_HANDLE;
    VkPipeline m_pipeline = VK_NULL_HANDLE;
};
