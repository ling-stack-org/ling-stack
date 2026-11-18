import Darwin
import Foundation
import LockedUseNative

public enum LockedUseSigningIdentity {
    public static let desktopSigningIdentifier = "com.lingstack.desktop"

    /// Read the running signed code through a kernel audit-token socketpair.
    /// Environment variables, claimed bundle identifiers and mutable paths
    /// cannot select the Broker's signing team.
    public static func current() throws -> LockedUsePeerIdentity {
        var descriptors: [Int32] = [-1, -1]
        guard socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0 else {
            throw LockedUseClientApprovals.Failure.unapproved
        }
        defer { Darwin.close(descriptors[0]); Darwin.close(descriptors[1]) }
        let peer = try LockedUsePeerIdentity.verified(socket: descriptors[0], requirement: "anchor apple generic")
        guard peer.processID == getpid(), peer.userID == geteuid(), peer.hardenedRuntime,
              !peer.permitsCodeInjection, let team = peer.teamIdentifier,
              team.utf8.count == 10, team.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) }) else {
            throw LockedUseClientApprovals.Failure.unapproved
        }
        return peer
    }

    public static func brokerRequirement() throws -> String {
        let peer = try current()
        return "identifier \"com.lingstack.locked-use.broker\" and anchor apple generic and certificate leaf[subject.OU] = \"\(peer.teamIdentifier!)\""
    }

    /// The Client is launched by Desktop and receives its task binding over a
    /// pipe. A same-user process can otherwise launch the signed Client itself
    /// and complete device-owner authentication with a fabricated binding.
    /// Bind the helper to the live Desktop parent before accepting any request.
    public static func verifiedDesktopParent() throws -> LockedUsePeerIdentity {
        let client = try current()
        let parentID = getppid()
        guard parentID > 1, parentID != getpid(), let team = client.teamIdentifier else {
            throw LockedUseClientApprovals.Failure.unapproved
        }
        let requirement = try desktopRequirement(teamIdentifier: team)
        let parent = try LockedUsePeerIdentity.verified(processID: parentID, requirement: requirement)
        guard parent.userID == client.userID,
              parent.auditSessionID == client.auditSessionID,
              parent.hardenedRuntime,
              !parent.permitsCodeInjection else {
            throw LockedUseClientApprovals.Failure.unapproved
        }
        return parent
    }

    public static func parentIsStillTheSameProcess(_ parent: LockedUsePeerIdentity) -> Bool {
        guard getppid() == parent.processID else { return false }
        return parent.auditToken.withUnsafeBytes {
            ling_process_identity_matches(parent.processID, $0.bindMemory(to: UInt8.self).baseAddress)
        } == 1
    }

    public static func desktopRequirement(teamIdentifier: String) throws -> String {
        guard teamIdentifier.utf8.count == 10,
              teamIdentifier.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) }) else {
            throw LockedUseClientApprovals.Failure.unapproved
        }
        return "identifier \"\(desktopSigningIdentifier)\" and anchor apple generic and certificate leaf[subject.OU] = \"\(teamIdentifier)\""
    }
}
