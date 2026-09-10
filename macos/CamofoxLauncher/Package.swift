// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CamofoxLauncher",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "Camofox", targets: ["CamofoxLauncher"])],
    targets: [.executableTarget(name: "CamofoxLauncher")]
)
