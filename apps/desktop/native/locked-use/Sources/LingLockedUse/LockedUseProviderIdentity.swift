import Darwin
import Dispatch
import Foundation
import LockedUseNative
import LightweightCodeRequirements
import Security

/// Root-recorded identity of the single external input process in a lease.
public struct LockedUseProviderIdentity: Codable, Equatable, Sendable {
    public let processID: Int32
    public let auditToken: Data
    public let codeHash: Data
    public let userID: UInt32
    public let auditSessionID: UInt32

    public init(processID: Int32, auditToken: Data, codeHash: Data, userID: UInt32, auditSessionID: UInt32) {
        self.processID = processID; self.auditToken = auditToken; self.codeHash = codeHash
        self.userID = userID; self.auditSessionID = auditSessionID
    }

    public func validate(owner: LockedUseBrokerCoordinator.Context) throws {
        guard processID > 0, processID != owner.processID, auditToken.count == 32,
              !codeHash.isEmpty, codeHash.count <= 64,
              userID == owner.userID, auditSessionID == owner.auditSessionID else {
            throw LockedUseBrokerCoordinator.Failure.denied
        }
    }

    public static func verified(processID: Int32, owner: LockedUseBrokerCoordinator.Context, team: String) throws -> Self {
        guard team.utf8.count == 10, team.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) }) else {
            throw LockedUseBrokerCoordinator.Failure.denied
        }
        let peer = try LockedUsePeerIdentity.verified(processID: processID,
            requirement: "identifier \"com.lingstack.desktop.cua-driver\" and anchor apple generic and certificate leaf[subject.OU] = \"\(team)\" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists")
        guard peer.hardenedRuntime, !peer.permitsCodeInjection else { throw LockedUseBrokerCoordinator.Failure.denied }
        let identity = Self(processID: peer.processID, auditToken: peer.auditToken,
            codeHash: peer.codeDirectoryHash, userID: peer.userID, auditSessionID: peer.auditSessionID)
        try identity.validate(owner: owner)
        return identity
    }

    /// Unknown inspection errors retain the recovery fence.
    public var processState: Int32 {
        auditToken.withUnsafeBytes { ling_process_identity_matches(processID, $0.bindMemory(to: UInt8.self).baseAddress) }
    }

    public func revalidateLive(team: String) throws {
        guard processState == 1 else { throw LockedUseBrokerCoordinator.Failure.unavailable }
        if #available(macOS 14.4, *) {
            var token = audit_token_t()
            _ = withUnsafeMutableBytes(of: &token) { auditToken.copyBytes(to: $0) }
            guard let task = SecTaskCreateWithAuditToken(nil, token) else { throw LockedUseBrokerCoordinator.Failure.denied }
            let requirement = try ProcessCodeRequirement.allOf {
                CodeDirectoryHash(codeHash)
                SigningIdentifier("com.lingstack.desktop.cua-driver")
                ProcessCodeSigningFlags.isSuperset(of: [.isDynamicallyValid, .isSigned])
            }
            guard try SecTaskValidateForRequirement(task: task, requirement: requirement) else {
                throw LockedUseBrokerCoordinator.Failure.denied
            }
        } else {
            let owner = LockedUseBrokerCoordinator.Context(id: UUID(), role: .agent, userID: userID, auditSessionID: auditSessionID)
            guard try Self.verified(processID: processID, owner: owner, team: team) == self else {
                throw LockedUseBrokerCoordinator.Failure.denied
            }
        }
    }
}

/// The kqueue watch pins a process instance rather than a recyclable numeric PID.
public final class LockedUseProviderExitWatch: @unchecked Sendable {
    private let source: DispatchSourceRead
    public init(identity: LockedUseProviderIdentity, queue: DispatchQueue, onExit: @escaping @Sendable () -> Void) throws {
        let fd = identity.auditToken.withUnsafeBytes {
            ling_watch_process(identity.processID, $0.bindMemory(to: UInt8.self).baseAddress)
        }
        guard fd >= 0 else { throw POSIXError(.init(rawValue: errno) ?? .EIO) }
        source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        source.setEventHandler { [weak self] in
            if ling_process_exit_event(fd, identity.processID) == 1 { onExit(); self?.source.cancel() }
        }
        source.setCancelHandler { Darwin.close(fd) }
        source.resume()
    }
    deinit { source.cancel() }
}
