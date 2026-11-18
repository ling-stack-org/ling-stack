import Foundation
import LingLockedUse

func checkProviderLifetimes() throws {
    let boot = UUID().uuidString
    let owner = LockedUseBrokerCoordinator.Context(id: UUID(), role: .agent, userID: 501, auditSessionID: 42,
        auditToken: Data(repeating: 1, count: 32), processID: 101, codeHash: Data(repeating: 1, count: 20))
    let guardian = LockedUseBrokerCoordinator.Context(id: UUID(), role: .guardian, userID: 501, auditSessionID: 42,
        auditToken: Data(repeating: 2, count: 32), processID: 102, codeHash: Data(repeating: 2, count: 20))
    let plugin = LockedUseBrokerCoordinator.Context(id: UUID(), role: .plugin, userID: 0, auditSessionID: 42)
    let locked = LockedUseSession(state: .locked, userID: 501, auditSessionID: 42)
    let unlocked = LockedUseSession(state: .unlocked, userID: 501, auditSessionID: 42)
    let guards = LockedUseStateMachine.Guards(allDisplaysCovered: true, inputTapHealthy: true, watchdogHealthy: true, displayGeneration: 1)
    let digest = try lockedUseSessionDigest(session: locked, bootSessionID: boot)
    let provider = LockedUseProviderIdentity(processID: 103, auditToken: Data(repeating: 3, count: 32),
        codeHash: Data(repeating: 3, count: 20), userID: 501, auditSessionID: 42)
    let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let binding = LockedUseTaskBinding(grantID: "grant", runID: "run", computerUseSessionID: "scope", desktopInstanceID: "desktop",
        sessionBindingDigest: digest, lockEpoch: 1, providerGeneration: 4, expiresAt: formatter.string(from: Date().addingTimeInterval(60)))
    func active() throws -> (LockedUseBrokerCoordinator, UUID) {
        var broker = LockedUseBrokerCoordinator(enabled: true, backendValidated: true,
            requiresExplicitOwnerDrain: true, requiresTaskBinding: true, bootSessionID: boot)
        try denies { _ = try broker.handle(.init(operation: .begin, session: locked), context: owner, now: 1) }
        let begin = try broker.handle(.init(operation: .begin, session: locked, taskBinding: binding), context: owner, now: 1)
        let lease = begin.leaseID!
        _ = try broker.handle(.init(operation: .guardianHello, leaseID: lease, token: begin.token), context: guardian, now: 1.1)
        _ = try broker.handle(.init(operation: .guardianReport, leaseID: lease, session: locked, guards: guards), context: guardian, now: 1.2)
        let claim = try broker.handle(.init(operation: .pluginClaim), context: plugin, now: 1.3)
        _ = try broker.handle(.init(operation: .pluginConsume, leaseID: lease, token: claim.token), context: plugin, now: 1.4)
        _ = try broker.handle(.init(operation: .guardianReport, leaseID: lease, session: unlocked, guards: guards, unlockWorkPending: false), context: guardian, now: 1.5)
        return (broker, lease)
    }
    var (broker, lease) = try active()
    let actionTarget = LockedUseActionTarget(toolName: "click", processID: 104)
    let action = LockedUseIPCMessage(operation: .actionBegin, leaseID: lease, session: unlocked, taskBinding: binding, actionTarget: actionTarget)
    try denies { _ = try broker.handle(action, context: owner, now: 1.6) }
    let check = try broker.handle(.init(operation: .check, leaseID: lease, session: unlocked, taskBinding: binding), context: owner, now: 1.6)
    try require(check.result == .active, "Readiness does not require or grant external input authority")
    try denies { _ = try broker.handle(.init(operation: .providerAttach, leaseID: lease, taskBinding: binding, providerProcessID: provider.processID), context: owner, now: 1.6) }
    _ = try broker.handle(.init(operation: .providerAttach, leaseID: lease, taskBinding: binding, providerProcessID: provider.processID), context: owner, now: 1.6, verifiedProvider: provider)
    try denies { _ = try broker.handle(.init(operation: .providerAttach, leaseID: lease, taskBinding: binding, providerProcessID: provider.processID), context: owner, now: 1.6, verifiedProvider: provider) }
    _ = try broker.handle(action, context: owner, now: 1.7)
    try denies { _ = try broker.handle(action, context: owner, now: 1.7) }
    let changedTarget = LockedUseActionTarget(toolName: "click", processID: 105)
    try denies {
        _ = try broker.handle(.init(operation: .actionEnd, leaseID: lease, session: unlocked,
            taskBinding: binding, actionTarget: changedTarget), context: owner, now: 1.7)
    }
    _ = try broker.handle(.init(operation: .actionEnd, leaseID: lease, session: unlocked,
        taskBinding: binding, actionTarget: actionTarget), context: owner, now: 1.7)
    _ = try broker.handle(action, context: owner, now: 1.7)
    let journal = try broker.recoveryRecord(clientToken: owner.auditToken)!.validated()
    var restored = LockedUseBrokerCoordinator(enabled: true, backendValidated: true, requiresExplicitOwnerDrain: true,
        requiresTaskBinding: true, recovery: journal, bootSessionID: boot)
    try require(restored.recordedProvider == provider && restored.phase == .relocking, "Restart restores an exact revocation fence")
    try denies { _ = try restored.handle(action, context: owner, now: 1.8) }
    try broker.ownerProcessExited()
    _ = try broker.handle(.init(operation: .quiesced, leaseID: lease), context: owner, now: 1.8)
    let retained = try broker.handle(.init(operation: .guardianReport, leaseID: lease, session: locked, guards: guards, unlockWorkPending: false), context: guardian, now: 1.9)
    try require(retained.phase == .relocking && !retained.effects.contains("releaseGuards"), "Live provider retains shields despite owner death or a drain claim")
    let wrong = LockedUseProviderIdentity(processID: provider.processID, auditToken: Data(repeating: 4, count: 32),
        codeHash: provider.codeHash, userID: 501, auditSessionID: 42)
    try denies { try broker.providerProcessExited(wrong) }
    try broker.providerProcessExited(provider)
    let released = try broker.handle(.init(operation: .guardianReport, leaseID: lease, session: locked, guards: guards, unlockWorkPending: false), context: guardian, now: 2)
    try require(released.phase == .idle && released.effects.contains("releaseGuards"), "Exact provider death and observed relock release guards")
    _ = try restored.handle(.init(operation: .guardianReport, leaseID: lease, session: locked, guards: guards, unlockWorkPending: true), context: guardian, now: 2)
    try restored.providerProcessExited(provider)
    try require(restored.phase == .relocking, "Provider death never drains queued unlock work")
    let recovered = try restored.handle(.init(operation: .guardianReport, leaseID: lease, session: locked, guards: guards, unlockWorkPending: false), context: guardian, now: 2.1)
    try require(recovered.phase == .awaitingManualUnlock, "Restored exact provider exit permits bounded recovery")
    var (unregistered, unregisteredLease) = try active()
    try unregistered.ownerProcessExited()
    try denies { _ = try unregistered.handle(.init(operation: .providerAttach, leaseID: unregisteredLease, taskBinding: binding, providerProcessID: provider.processID), context: owner, now: 1.6, verifiedProvider: provider) }
    let noChild = try unregistered.handle(.init(operation: .guardianReport, leaseID: unregisteredLease, session: locked, guards: guards, unlockWorkPending: false), context: guardian, now: 1.7)
    try require(noChild.phase == .idle, "Owner death before registration cannot leave an admitted input process")
    var legacy = try JSONSerialization.jsonObject(with: JSONEncoder().encode(journal)) as! [String: Any]
    legacy["schemaVersion"] = 1
    legacy.removeValue(forKey: "taskBinding"); legacy.removeValue(forKey: "provider"); legacy.removeValue(forKey: "providerExited")
    let oldRecord = try JSONDecoder().decode(LockedUseRecoveryRecord.self, from: JSONSerialization.data(withJSONObject: legacy)).validated()
    var oldBroker = LockedUseBrokerCoordinator(enabled: true, backendValidated: true, requiresExplicitOwnerDrain: true, recovery: oldRecord, bootSessionID: boot)
    _ = try oldBroker.handle(.init(operation: .guardianReport, leaseID: lease, session: locked, guards: guards, unlockWorkPending: false), context: guardian, now: 2)
    try oldBroker.ownerProcessExited()
    try require(oldBroker.phase == .relocking, "Missing legacy lifetime metadata is unknown, never proof of exit")
    print("Locked Use provider checks passed: registration, action barrier, exact exit, owner death, late attach, durable recovery and legacy fence.")
}
