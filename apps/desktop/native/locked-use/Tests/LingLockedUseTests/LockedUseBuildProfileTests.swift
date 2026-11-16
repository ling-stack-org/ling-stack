import Foundation
import XCTest
@testable import LingLockedUse

final class LockedUseBuildProfileTests: XCTestCase {
    func testServiceModeFollowsTheCompiledProfile() {
        XCTAssertTrue(LockedUseBuildProfile.permitsService(validation: true))
        #if LING_LOCKED_USE_DEVELOPMENT_VALIDATION
        XCTAssertFalse(LockedUseBuildProfile.permitsService(validation: false))
        #else
        XCTAssertTrue(LockedUseBuildProfile.permitsService(validation: false))
        #endif
    }

    func testManifestCannotCrossTheDevelopmentAndProductionBoundary() throws {
        #if arch(arm64)
        let architecture = "arm64"
        #else
        let architecture = "x64"
        #endif
        let digest = String(repeating: "a", count: 64)
        let artifacts = ["LingLockBroker", "LingLockInstaller", "Ling Guardian.app/Contents/MacOS/LingGuardian",
            "Client.app/Contents/MacOS/LingLockedUseClient", "LingLockAuth.bundle/Contents/MacOS/LingLockAuth"]
        for (signing, kernel) in [("local_identity", "identity_passed"), ("development_validation", "development_identity_passed")] {
            let manifest: [String: Any] = ["schemaVersion": 1, "platform": "darwin", "architecture": architecture,
                "team": "ABCDE12345", "signing": signing, "productCapability": "disabled_by_build", "nativeAcceptance": "not_run",
                "upstreamCommit": String(repeating: "a", count: 40),
                "checks": ["policy": "passed", "authorizationPluginABI": "passed", "kernelTaskVerifier": kernel, "xctest": "separate"],
                "artifacts": Dictionary(uniqueKeysWithValues: artifacts.map { ($0, digest) })]
            let data = try JSONSerialization.data(withJSONObject: manifest)
            if (signing == "development_validation") == LockedUseBuildProfile.developmentValidation {
                XCTAssertEqual(try LockedUseBuildManifest.clientSHA256(data: data, team: "ABCDE12345", architecture: architecture), digest)
            } else {
                XCTAssertThrowsError(try LockedUseBuildManifest.clientSHA256(data: data, team: "ABCDE12345", architecture: architecture))
            }
        }
    }

    func testDevelopmentBrokerRejectsExternalProviderActions() {
        for operation in [LockedUseIPCMessage.Operation.providerAttach, .actionBegin, .actionEnd] {
            XCTAssertEqual(LockedUseBuildProfile.permitsRequest(.init(operation: operation)),
                !LockedUseBuildProfile.developmentValidation)
        }
        XCTAssertTrue(LockedUseBuildProfile.permitsRequest(.init(operation: .status)))
        let binding = LockedUseTaskBinding(grantID: "grant", runID: "run", computerUseSessionID: "scope",
            desktopInstanceID: "desktop", sessionBindingDigest: String(repeating: "a", count: 64),
            lockEpoch: 1, providerGeneration: 2, expiresAt: "2026-01-01T00:00:00Z")
        XCTAssertEqual(LockedUseBuildProfile.permitsRequest(.init(operation: .begin, taskBinding: binding)),
            !LockedUseBuildProfile.developmentValidation)
    }
}
