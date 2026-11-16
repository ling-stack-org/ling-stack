import Foundation

/// Written only by the authenticated root Broker, after the signed native
/// agent has completed its fixed AX/SCK/Keychain fixture validation. Manual
/// physical-screen, input and fault checks still require administrator review.
public struct LockedUseValidationReport: Codable, Sendable {
    public let schemaVersion: Int
    public let leaseID: UUID
    public let evidence: LockedUseComponentValidation.Evidence
    public let ownerToken: Data
    public let ownerCodeHash: Data
    public let guiAndKeychainPassed: Bool
    public var lockedAndReleased: Bool
    public var afterManualUnlockPassed: Bool

    public init(leaseID: UUID, evidence: LockedUseComponentValidation.Evidence, ownerToken: Data, ownerCodeHash: Data) {
        schemaVersion = 2; self.leaseID = leaseID; self.evidence = evidence; self.ownerToken = ownerToken; self.ownerCodeHash = ownerCodeHash
        guiAndKeychainPassed = true; lockedAndReleased = false; afterManualUnlockPassed = false
    }
    public func canPromote(current: LockedUseComponentValidation.Evidence) -> Bool {
        schemaVersion == 2 && ownerToken.count == 32 && !ownerCodeHash.isEmpty && evidence == current
            && ownerCodeHash.map({ String(format: "%02x", $0) }).joined() == current.clientHash
            && guiAndKeychainPassed && lockedAndReleased && afterManualUnlockPassed
    }
    public static func loadInstalled() throws -> Self {
        let bytes = try LockedUseSecureStore.read(components: ["Library", "Application Support", "LingStack", "LockedUse", "validation-report.json"], privateFile: true)
        return try JSONDecoder().decode(Self.self, from: bytes)
    }
}
