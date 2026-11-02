import QtQuick

Item {
    id: root
    property real angle: 0
    property bool spinning: true

    // An Item leaves the window clear color and native Vulkan underlay visible.
    NumberAnimation on angle {
        from: 0
        to: Math.PI * 2
        duration: 10000
        loops: Animation.Infinite
        paused: !root.spinning
    }

    Column {
        anchors.top: parent.top
        anchors.left: parent.left
        anchors.margins: 28
        spacing: 8
        Text {
            text: "Vulkan Triangle"
            color: "#f1f5f9"
            font.pixelSize: 28
            font.bold: true
        }
        Text {
            text: "C++ Vulkan pipeline · Qt 6 · QML"
            color: "#94a3b8"
            font.pixelSize: 15
        }
    }

    Rectangle {
        anchors.bottom: parent.bottom
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.bottomMargin: 28
        width: 170
        height: 44
        radius: 10
        color: mouse.containsMouse ? "#334155" : "#1e293b"
        border.color: "#475569"
        Text {
            anchors.centerIn: parent
            text: root.spinning ? "Pause rotation" : "Resume rotation"
            color: "#f1f5f9"
            font.pixelSize: 15
        }
        MouseArea {
            id: mouse
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: root.spinning = !root.spinning
        }
    }

    focus: true
    Keys.onSpacePressed: root.spinning = !root.spinning
    Keys.onEscapePressed: Qt.quit()
}
