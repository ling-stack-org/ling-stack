import Carbon
import CoreGraphics
import Foundation
import LockedUseNative

/// Content-free target for a protected call. Desktop-wide capture and foreground
/// input are excluded; the provider must route input to a verified user process.
public struct LockedUseActionTarget: Codable, Equatable, Sendable {
    public let toolName: String
    public let processID: Int32?
    public let windowID: UInt32?
    private static let metadata = Set(["check_permissions", "health_report", "get_screen_size",
        "get_cursor_position", "get_accessibility_tree", "list_apps", "start_session", "end_session"])
    private static let targeted = Set(["bring_to_front", "click", "double_click",
        "get_window_state", "hotkey", "list_windows", "page", "press_key", "right_click",
        "scroll", "set_value", "type_text"])

    public init(toolName: String, processID: Int32? = nil, windowID: UInt32? = nil) {
        self.toolName = toolName; self.processID = processID; self.windowID = windowID
    }
    public func validate() throws {
        if Self.metadata.contains(toolName) {
            guard processID == nil && windowID == nil else { throw LockedUseBrokerCoordinator.Failure.denied }
        } else {
            guard Self.targeted.contains(toolName), let processID, processID > 1,
                  windowID == nil || windowID! > 0,
                  toolName != "get_window_state" || windowID != nil else { throw LockedUseBrokerCoordinator.Failure.denied }
        }
    }

    public func verified(owner: LockedUseBrokerCoordinator.Context, excludedPIDs: Set<Int32>) throws -> LockedUseVerifiedActionTarget {
        try validate()
        guard !IsSecureEventInputEnabled() else { throw LockedUseBrokerCoordinator.Failure.denied }
        guard let processID else { return .init(target: self, peer: nil, owner: owner, excludedPIDs: excludedPIDs) }
        let peer = try LockedUsePeerIdentity.verified(processID: processID, requirement: "anchor apple generic")
        try validateIdentity(userID: peer.userID, auditSessionID: peer.auditSessionID,
            signingIdentifier: peer.signingIdentifier, owner: owner, excludedPIDs: excludedPIDs)
        try verifyWindow()
        return .init(target: self, peer: peer, owner: owner, excludedPIDs: excludedPIDs)
    }

    public func validateIdentity(userID: UInt32, auditSessionID: UInt32, signingIdentifier: String,
                                 owner: LockedUseBrokerCoordinator.Context, excludedPIDs: Set<Int32>) throws {
        let identifier = signingIdentifier.lowercased()
        guard let processID, !excludedPIDs.contains(processID),
              userID == owner.userID, auditSessionID == owner.auditSessionID,
              !identifier.isEmpty,
              identifier != "com.lingstack.desktop",
              !identifier.hasPrefix("com.lingstack.locked-use."),
              !identifier.contains("loginwindow"), !identifier.contains("securityagent"),
              !identifier.contains("authorizationhost"), !identifier.contains("screensaver"),
              identifier != "com.apple.loginui" else { throw LockedUseBrokerCoordinator.Failure.denied }
    }

    fileprivate func verifyWindow() throws {
        guard let windowID, let processID else { return }
        guard let windows = CGWindowListCopyWindowInfo(.optionIncludingWindow, windowID) as? [[String: Any]],
              windows.count == 1, let owner = windows[0][kCGWindowOwnerPID as String] as? Int32,
              owner == processID, windows[0][kCGWindowLayer as String] as? Int == 0 else {
            throw LockedUseBrokerCoordinator.Failure.denied
        }
    }
}

public struct LockedUseVerifiedActionTarget: Sendable {
    public let target: LockedUseActionTarget
    fileprivate let peer: LockedUsePeerIdentity?
    fileprivate let owner: LockedUseBrokerCoordinator.Context
    fileprivate let excludedPIDs: Set<Int32>
    public func revalidate() throws {
        guard !IsSecureEventInputEnabled() else { throw LockedUseBrokerCoordinator.Failure.denied }
        if let processID = target.processID, let peer {
            let matches = peer.auditToken.withUnsafeBytes {
                ling_process_identity_matches(processID, $0.bindMemory(to: UInt8.self).baseAddress)
            }
            guard matches == 1 else { throw LockedUseBrokerCoordinator.Failure.denied }
            let current = try target.verified(owner: owner, excludedPIDs: excludedPIDs)
            guard current.peer?.auditToken == peer.auditToken,
                  current.peer?.codeDirectoryHash == peer.codeDirectoryHash,
                  current.peer?.signingIdentifier == peer.signingIdentifier else { throw LockedUseBrokerCoordinator.Failure.denied }
        }
    }
}
