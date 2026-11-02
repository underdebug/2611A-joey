#include "trianglerenderer.h"

#include <QGuiApplication>
#include <QQmlEngine>
#include <QQuickView>
#include <QSGRendererInterface>
#include <QSurfaceFormat>
#include <QTimer>

int main(int argc, char *argv[])
{
    QGuiApplication app(argc, argv);
    QCoreApplication::setApplicationName("Vulkan Triangle");
    QQuickWindow::setGraphicsApi(QSGRendererInterface::Vulkan);

    QQuickView view;
    auto format = view.format();
    format.setSamples(1); // Must match the native pipeline's sample count.
    view.setFormat(format);
    view.setTitle("Vulkan Triangle — Qt 6 / QML / C++");
    view.setColor(QColor("#101827"));
    view.setResizeMode(QQuickView::SizeRootObjectToView);
    view.setPersistentGraphics(false);
    view.setPersistentSceneGraph(false);
    view.resize(960, 640);
    view.setMinimumSize(QSize(480, 360));
    new TriangleRenderer(&view); // Owned by the window, including during teardown.
    QObject::connect(view.engine(), &QQmlEngine::quit, &app, &QCoreApplication::quit);
    view.setSource(QUrl("qrc:/qml/Main.qml"));
    if (view.status() == QQuickView::Error)
        return 1;
    view.show();

    // A finite run is useful when checking startup and Vulkan teardown.
    if (app.arguments().contains("--smoke-test"))
        QTimer::singleShot(2500, &app, &QCoreApplication::quit);
    return app.exec();
}
