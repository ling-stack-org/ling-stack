import Foundation
import XCTest
@testable import LingLockedUse

final class LockedUseBuildProfileTests: XCTestCase {
    func testServiceModeFollowsTheCompiledProfile() {
        #if LING_LOCKED_USE_LOCAL_DEVELOPMENT
        XCTAssertFalse(LockedUseBuildProfile.permitsService(validation: true))
        XCTAssertFalse(LockedUseBuildProfile.permitsService(validation: false))
        XCTAssertTrue(LockedUseBuildProfile.permitsService(validation: false, local: true))
        #elseif LING_LOCKED_USE_DEVELOPMENT_VALIDATION
        XCTAssertTrue(LockedUseBuildProfile.permitsService(validation: true))
        XCTAssertFalse(LockedUseBuildProfile.permitsService(validation: false))
        #else
        XCTAssertTrue(LockedUseBuildProfile.permitsService(validation: true))
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
        for (signing, kernel) in [("local_identity", "identity_passed"),
                                  ("development_validation", "development_identity_passed"),
                                  ("local_development", "local_development_identity_passed")] {
            let manifest: [String: Any] = ["schemaVersion": 1, "platform": "darwin", "architecture": architecture,
                "team": "ABCDE12345", "signing": signing, "productCapability": "disabled_by_build", "nativeAcceptance": "not_run",
                "upstreamCommit": String(repeating: "a", count: 40),
                "checks": ["policy": "passed", "authorizationPluginABI": "passed", "kernelTaskVerifier": kernel, "xctest": "separate"],
                "artifacts": Dictionary(uniqueKeysWithValues: artifacts.map { ($0, digest) })]
            let data = try JSONSerialization.data(withJSONObject: manifest)
            let matches = (signing == "development_validation" && LockedUseBuildProfile.developmentValidation)
                || (signing == "local_development" && LockedUseBuildProfile.localDevelopment)
                || (signing == "local_identity" && !LockedUseBuildProfile.developmentValidation && !LockedUseBuildProfile.localDevelopment)
            if matches {
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
