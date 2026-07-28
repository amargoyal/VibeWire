// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "VibeWireHost",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "VibeWireHost",
            path: "Sources/VibeWireHost",
            swiftSettings: [
                .unsafeFlags(["-parse-as-library"])
            ],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("VideoToolbox"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("Network"),
                .linkedFramework("IOKit"),
            ]
        )
    ]
)
