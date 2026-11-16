import Foundation
import LingLockedUse

enum CheckFailure: Error { case failed(String) }
func require(_ value: Bool, _ message: String) throws {
    guard value else { throw CheckFailure.failed(message) }
}
func denies(_ body: () throws -> Void) throws {
    do { try body() } catch { return }
    throw CheckFailure.failed("Expected denial")
}

// Deterministic policy checks: no authentication evaluation, windows or input.
let locked = LockedUseSession(state: .locked, userID: 501, auditSessionID: 42)
let unlocked = LockedUseSession(state: .unlocked, userID: 501, auditSessionID: 42)
let agent = LockedUseBrokerCoordinator.Context(id: UUID(), role: .agent, userID: 501, auditSessionID: 42)
let guardian = LockedUseBrokerCoordinator.Context(id: UUID(), role: .guardian, userID: 501, auditSessionID: 42)
let plugin = LockedUseBrokerCoordinator.Context(id: UUID(), role: .plugin, userID: 88, auditSessionID: 42)
let guards = LockedUseStateMachine.Guards(allDisplaysCovered: true, inputTapHealthy: true, watchdogHealthy: true, displayGeneration: 1)

do {
    var broker = LockedUseBrokerCoordinator(enabled: true, backendValidated: true, requiresExplicitOwnerDrain: true)
    let begin = try broker.handle(.init(operation: .begin, session: locked), context: agent, now: 1)
    guard let lease = begin.leaseID, let token = begin.token else { throw CheckFailure.failed("Lease missing") }
    _ = try broker.handle(.init(operation: .guardianHello, leaseID: lease, token: token), context: guardian, now: 1.1)
    _ = try broker.handle(.init(operation: .guardianReport, leaseID: lease, session: locked, guards: guards), context: guardian, now: 1.2)
    let claim = try broker.handle(.init(operation: .pluginClaim), context: plugin, now: 1.3)
    _ = try broker.handle(.init(operation: .pluginConsume, leaseID: lease, token: claim.token), context: plugin, now: 1.4)
    try denies { _ = try broker.handle(.init(operation: .pluginConsume, leaseID: lease, token: claim.token), context: plugin, now: 1.4) }
    try denies { _ = try broker.handle(.init(operation: .action, leaseID: lease, session: unlocked), context: agent, now: 1.5) }
    _ = try broker.handle(.init(operation: .guardianReport, leaseID: lease, session: unlocked, guards: guards, unlockWorkPending: false), context: guardian, now: 1.6)
    let active = try broker.handle(.init(operation: .action, leaseID: lease, session: unlocked), context: agent, now: 1.7)
    try require(active.result == .active, "Observed protected session must admit an action")
    _ = try broker.handle(.init(operation: .end), context: agent, now: 1.8)
    try broker.ownerProcessExited()
    let retained = try broker.handle(.init(operation: .guardianReport, leaseID: lease, session: locked, guards: guards, unlockWorkPending: false), context: guardian, now: 1.9)
    try require(retained.phase == .relocking && !retained.effects.contains("releaseGuards"), "Helper death cannot prove external provider drain")
    _ = try broker.handle(.init(operation: .quiesced, leaseID: lease), context: agent, now: 2)
    let released = try broker.handle(.init(operation: .guardianReport, leaseID: lease, session: locked, guards: guards, unlockWorkPending: false), context: guardian, now: 2.1)
    try require(released.phase == .idle && released.effects.contains("releaseGuards"), "Observed lock and explicit drain permit release")
    try denies { _ = try broker.handle(.init(operation: .action, leaseID: lease, session: unlocked), context: agent, now: 2.2) }

    let boot = UUID().uuidString
    let digest = try lockedUseSessionDigest(session: locked, bootSessionID: boot)
    try require(digest == lockedUseSessionDigest(session: unlocked, bootSessionID: boot), "Lock transitions preserve session binding")
    let now = Date()
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    var payload: [String: Any] = ["grantID": "grant", "runID": "run", "computerUseSessionID": "scope", "desktopInstanceID": "desktop",
        "sessionBindingDigest": digest, "lockEpoch": 1, "providerGeneration": 4,
        "expiresAt": formatter.string(from: now.addingTimeInterval(60))]
    func binding() throws -> LockedUseTaskBinding {
        try JSONDecoder().decode(LockedUseTaskBinding.self, from: JSONSerialization.data(withJSONObject: payload))
    }
    try binding().validate(sessionDigest: digest, now: now)
    try denies { try binding().validate(sessionDigest: String(repeating: "b", count: 64), now: now) }
    payload["expiresAt"] = formatter.string(from: now.addingTimeInterval(-1))
    try denies { try binding().validate(sessionDigest: digest, now: now) }
    payload["expiresAt"] = formatter.string(from: now.addingTimeInterval(901))
    try denies { try binding().validate(sessionDigest: digest, now: now) }
    print("Locked Use policy checks passed: permit replay, observed unlock, external drain, relock, session binding and task TTL; no system state changed.")
} catch {
    fputs("Locked Use policy checks failed: \(error)\n", stderr)
    exit(1)
}
