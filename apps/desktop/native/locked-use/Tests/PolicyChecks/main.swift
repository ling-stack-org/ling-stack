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
    try checkActionTargets()
    try checkProviderLifetimes()
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
    #if arch(arm64)
    let architecture = "arm64"
    #else
    let architecture = "x64"
    #endif
    let clientHash = String(repeating: "c", count: 64)
    let artifactNames = ["LingLockBroker", "LingLockInstaller", "Ling Guardian.app/Contents/MacOS/LingGuardian",
        "Client.app/Contents/MacOS/LingLockedUseClient", "LingLockAuth.bundle/Contents/MacOS/LingLockAuth"]
    var manifest: [String: Any] = ["schemaVersion": 1, "platform": "darwin", "architecture": architecture,
        "team": "ABCDE12345", "signing": LockedUseBuildProfile.manifestSigning, "productCapability": "disabled_by_build", "nativeAcceptance": "not_run",
        "upstreamCommit": String(repeating: "a", count: 40),
        "checks": ["policy": "passed", "authorizationPluginABI": "passed", "kernelTaskVerifier": LockedUseBuildProfile.kernelTaskCheck, "xctest": "separate"],
        "artifacts": Dictionary(uniqueKeysWithValues: artifactNames.map { ($0, clientHash) })]
    func readManifest() throws -> String {
        try LockedUseBuildManifest.clientSHA256(data: JSONSerialization.data(withJSONObject: manifest), team: "ABCDE12345", architecture: architecture)
    }
    try require(readManifest() == clientHash, "Signed client manifest must preserve the helper digest")
    manifest["signing"] = LockedUseBuildProfile.developmentValidation ? "local_identity" : "development_validation"
    try denies { _ = try readManifest() }
    manifest["signing"] = LockedUseBuildProfile.manifestSigning
    manifest["schemaVersion"] = true
    try denies { _ = try readManifest() }
    manifest["schemaVersion"] = 1
    manifest["productCapability"] = "supported_restricted"
    try denies { _ = try readManifest() }
    manifest["productCapability"] = "disabled_by_build"
    manifest["team"] = "OTHER12345"
    try denies { _ = try readManifest() }
    manifest["team"] = "ABCDE12345"
    manifest["extra"] = true
    try denies { _ = try readManifest() }
    print("Locked Use policy checks passed: permit replay, observed unlock, external drain, relock, session binding, task TTL and manifest identity; no system state changed.")
} catch {
    fputs("Locked Use policy checks failed: \(error)\n", stderr)
    exit(1)
}
