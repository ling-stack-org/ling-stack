import CryptoKit
import Foundation

/// Content-free authority carried by the Desktop task grant.
public struct LockedUseTaskBinding: Codable, Equatable, Sendable {
    public let grantID: String
    public let runID: String
    public let computerUseSessionID: String
    public let desktopInstanceID: String
    public let sessionBindingDigest: String
    public let lockEpoch: Int
    public let providerGeneration: Int
    public let expiresAt: String

    public init(grantID: String, runID: String, computerUseSessionID: String, desktopInstanceID: String,
                sessionBindingDigest: String, lockEpoch: Int, providerGeneration: Int, expiresAt: String) {
        self.grantID = grantID; self.runID = runID; self.computerUseSessionID = computerUseSessionID
        self.desktopInstanceID = desktopInstanceID; self.sessionBindingDigest = sessionBindingDigest
        self.lockEpoch = lockEpoch; self.providerGeneration = providerGeneration; self.expiresAt = expiresAt
    }

    public func validate(sessionDigest: String, now: Date = Date()) throws {
        try validateStructure()
        guard sessionDigest == sessionBindingDigest,
              let remaining = remainingLifetime(now: now), remaining > 0, remaining <= 900 else {
            throw LockedUseError.stateUnavailable("Task authority invalid or expired")
        }
    }

    public func validateStructure() throws {
        guard [grantID, runID, computerUseSessionID, desktopInstanceID].allSatisfy({
            !$0.isEmpty && $0.utf8.count <= 256 && $0.trimmingCharacters(in: .whitespacesAndNewlines) == $0
        }), sessionBindingDigest.count == 64,
              sessionBindingDigest.allSatisfy({ $0.isHexDigit && !$0.isUppercase }),
              lockEpoch > 0, providerGeneration > 0,
              remainingLifetime() != nil else {
            throw LockedUseError.stateUnavailable("Task authority invalid or expired")
        }
    }

    public func remainingLifetime(now: Date = Date()) -> TimeInterval? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: expiresAt)?.timeIntervalSince(now)
    }
}

public func lockedUseSessionDigest(session: LockedUseSession, bootSessionID: String) throws -> String {
    guard let uid = session.userID, let audit = session.auditSessionID,
          uid > 0, audit > 0, session.state != .unavailable,
          UUID(uuidString: bootSessionID) != nil else {
        throw LockedUseError.stateUnavailable("Completed user session unavailable")
    }
    let bytes = Data("ling-protected-session-v1|\(uid)|\(audit)|\(bootSessionID)".utf8)
    return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
}
