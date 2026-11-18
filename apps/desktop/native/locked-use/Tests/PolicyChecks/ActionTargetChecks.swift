import Foundation
import LingLockedUse

func checkActionTargets() throws {
    let owner = LockedUseBrokerCoordinator.Context(id: UUID(), role: .agent, userID: 501, auditSessionID: 42)
    let target = LockedUseActionTarget(toolName: "click", processID: 104, windowID: 1)
    try target.validate()
    try LockedUseActionTarget(toolName: "get_accessibility_tree").validate()
    try target.validateIdentity(userID: 501, auditSessionID: 42, signingIdentifier: "com.example.editor",
        owner: owner, excludedPIDs: [102, 103])
    for invalid in [LockedUseActionTarget(toolName: "click"), .init(toolName: "get_window_state", processID: 104),
        .init(toolName: "click", processID: 1), .init(toolName: "click", processID: 104, windowID: 0),
        .init(toolName: "list_apps", processID: 104), .init(toolName: "get_desktop_state"),
        .init(toolName: "move_cursor", processID: 104), .init(toolName: "drag", processID: 104),
        .init(toolName: "future_tool", processID: 104)] {
        try denies { try invalid.validate() }
    }
    for identifier in ["", "com.apple.loginwindow", "com.apple.SecurityAgent", "com.apple.authorizationhost",
        "com.apple.ScreenSaver.Engine", "com.apple.loginui", "com.lingstack.desktop", "com.lingstack.locked-use.guardian.dev"] {
        try denies {
            try target.validateIdentity(userID: 501, auditSessionID: 42, signingIdentifier: identifier,
                owner: owner, excludedPIDs: [])
        }
    }
    for (uid, session, excluded) in [(UInt32(502), UInt32(42), Set<Int32>()),
        (501, 43, Set<Int32>()), (501, 42, Set<Int32>([104]))] {
        try denies {
            try target.validateIdentity(userID: uid, auditSessionID: session, signingIdentifier: "com.example.editor",
                owner: owner, excludedPIDs: excluded)
        }
    }
    print("Locked Use target checks passed: explicit targets, secure identities, owner session and excluded processes.")
}
