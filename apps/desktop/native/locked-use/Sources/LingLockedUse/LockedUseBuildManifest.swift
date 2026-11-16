import Foundation
import CoreFoundation

/// Offline build facts are separate from installed and attended acceptance.
public enum LockedUseBuildManifest {
    public static func clientSHA256(data: Data, team: String, architecture: String) throws -> String {
        guard data.count <= 16 * 1024,
              let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(value.keys) == ["schemaVersion", "platform", "architecture", "team", "signing",
                "productCapability", "nativeAcceptance", "checks", "upstreamCommit", "artifacts"],
              let version = value["schemaVersion"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
              value["platform"] as? String == "darwin",
              ["arm64", "x64"].contains(architecture),
              value["architecture"] as? String == architecture,
              team.utf8.count == 10, team.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil, team != "0000000000",
              value["team"] as? String == team, value["signing"] as? String == "local_identity",
              value["productCapability"] as? String == "disabled_by_build",
              value["nativeAcceptance"] as? String == "not_run",
              let commit = value["upstreamCommit"] as? String,
              commit.utf8.count == 40, commit.range(of: "^[a-f0-9]{40}$", options: .regularExpression) != nil,
              let checks = value["checks"] as? [String: String],
              checks == ["policy": "passed", "authorizationPluginABI": "passed",
                "kernelTaskVerifier": "identity_passed", "xctest": "separate"],
              let artifacts = value["artifacts"] as? [String: String],
              Set(artifacts.keys) == ["LingLockBroker", "LingLockInstaller",
                "Ling Guardian.app/Contents/MacOS/LingGuardian",
                "Client.app/Contents/MacOS/LingLockedUseClient",
                "LingLockAuth.bundle/Contents/MacOS/LingLockAuth"],
              artifacts.values.allSatisfy({ $0.utf8.count == 64 && $0.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil }),
              let client = artifacts["Client.app/Contents/MacOS/LingLockedUseClient"] else {
            throw LockedUseClientApprovals.Failure.invalidRecord
        }
        return client
    }
}
