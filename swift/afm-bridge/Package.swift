// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "afm-bridge",
    platforms: [
        // Foundation Models framework requires macOS 26+.
        .macOS("26.0")
    ],
    targets: [
        .executableTarget(
            name: "afm-bridge",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)