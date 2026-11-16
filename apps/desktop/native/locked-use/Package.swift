// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "LingLockedUse",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "LingLockedUse", targets: ["LingLockedUse"]),
        .executable(name: "LingLockBroker", targets: ["Broker"]),
        .executable(name: "LingGuardian", targets: ["Guardian"]),
        .executable(name: "LingLockInstaller", targets: ["Installer"]),
        .executable(name: "LingLockedUseClient", targets: ["Client"]),
        .executable(name: "LingLockedUsePolicyChecks", targets: ["PolicyChecks"]),
    ],
    targets: [
        .target(name: "LockedUseNative", linkerSettings: [.linkedLibrary("bsm")]),
        .target(name: "LingLockedUse", dependencies: ["LockedUseNative"]),
        .executableTarget(name: "Broker", dependencies: ["LingLockedUse", "LockedUseNative"]),
        .executableTarget(name: "Guardian", dependencies: ["LingLockedUse"]),
        .executableTarget(name: "Installer", dependencies: ["LingLockedUse", "LockedUseNative"]),
        .executableTarget(name: "Client", dependencies: ["LingLockedUse"]),
        .executableTarget(name: "PolicyChecks", dependencies: ["LingLockedUse"], path: "Tests/PolicyChecks"),
        .testTarget(name: "LingLockedUseTests", dependencies: ["LingLockedUse", "LockedUseNative"]),
        .testTarget(name: "GuardianInputTests", dependencies: ["Guardian"]),
    ]
)
