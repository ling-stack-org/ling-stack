import Darwin
import Foundation
import LingLockedUse
import LocalAuthentication

private final class Output: @unchecked Sendable {
    private let lock = NSLock()
    func send(_ value: [String: Any]) {
        lock.lock(); defer { lock.unlock() }
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
        FileHandle.standardOutput.write(data + Data([10]))
    }
}

/// One process, local verification, grant and protected episode. EOF disconnects
/// the owner; Guardian and watchdog independently complete relock/recovery.
private final class Client {
    private let output = Output()
    private var connection: LockedUseConnection?
    private var consentDigest: String?
    private var consentDeadline: TimeInterval = 0
    private var binding: LockedUseTaskBinding?
    private var bindingDeadline: TimeInterval = 0
    private var descriptors: [Int32] = [-1, -1]

    func disconnect() { connection?.end(disconnecting: true) }
    private func digest(_ session: LockedUseSession) throws -> String {
        try lockedUseSessionDigest(session: session, bootSessionID: LockedUseComponentValidation.bootSessionID())
    }

    func handle(_ value: [String: Any]) throws -> [String: Any] {
        guard Set(value.keys).isSubset(of: ["command", "requestId", "binding"]),
              let command = value["command"] as? String else { throw LockedUseError.message("Malformed request") }
        let session = LockedUseSession.current()
        if command == "session" {
            return ["platform": "darwin", "sessionBindingDigest": try digest(session),
                "sessionActive": session.state != .unavailable, "sessionLocked": session.state == .locked]
        }
        if command == "status" {
            let status = LockedUseDiagnostics.current()
            return ["installed": status.pluginInstalled && status.brokerInstalled,
                "available": status.available, "sessionLocked": session.state == .locked,
                "productCapability": "probe_required"]
        }
        if command == "identity" {
            guard session.state == .unlocked, connection == nil, binding == nil else {
                return ["status": "unavailable"]
            }
            let before = try digest(session)
            let context = LAContext()
            let result = IdentityResult()
            let semaphore = DispatchSemaphore(value: 0)
            context.evaluatePolicy(.deviceOwnerAuthentication,
                localizedReason: "Authorize Ling to control this computer for the current task") { verified, error in
                result.resolve(verified: verified, error: error)
                semaphore.signal()
            }
            guard semaphore.wait(timeout: .now() + 115) == .success else {
                context.invalidate(); return ["status": "unavailable"]
            }
            let status = result.status
            if status == "verified", LockedUseSession.current().state == .unlocked,
               try digest(.current()) == before {
                consentDigest = before
                consentDeadline = ProcessInfo.processInfo.systemUptime + 900
                return ["status": "verified"]
            }
            consentDigest = nil
            return ["status": status == "verified" ? "failed" : status]
        }
        if command == "begin" {
            guard connection == nil, binding == nil, session.state == .locked,
                  consentDeadline > ProcessInfo.processInfo.systemUptime,
                  consentDigest == (try digest(session)), let raw = value["binding"] as? [String: Any],
                  Set(raw.keys) == ["grantID", "runID", "computerUseSessionID", "desktopInstanceID",
                    "sessionBindingDigest", "lockEpoch", "providerGeneration", "expiresAt"] else {
                throw LockedUseError.stateUnavailable("Local consent and locked task required")
            }
            let candidate = try JSONDecoder().decode(LockedUseTaskBinding.self,
                from: JSONSerialization.data(withJSONObject: raw))
            try candidate.validate(sessionDigest: digest(session))
            guard let remaining = candidate.remainingLifetime(), remaining > 0 else {
                throw LockedUseError.stateUnavailable("Task expired before acquisition")
            }
            bindingDeadline = ProcessInfo.processInfo.systemUptime + min(remaining, 300)
            consentDigest = nil; consentDeadline = 0
            guard socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0 else { throw POSIXError(.EIO) }
            let owner = LockedUseConnection(clientSocket: descriptors[0])
            owner.onRevoked = { [output] in output.send(["event": "revoked"]) }
            connection = owner; binding = candidate
            try owner.acquire(session: session)
            guard ProcessInfo.processInfo.systemUptime < bindingDeadline else {
                throw LockedUseError.stateUnavailable("Task expired during acquisition")
            }
            return ["active": true]
        }
        guard let binding, let connection, let raw = value["binding"] as? [String: Any],
              let bytes = try? JSONSerialization.data(withJSONObject: raw),
              let echoed = try? JSONDecoder().decode(LockedUseTaskBinding.self, from: bytes),
              echoed == binding else { throw LockedUseError.stateUnavailable("Task binding mismatch") }
        // Cleanup remains callable after expiry and user/session transitions.
        if command == "end" {
            connection.end()
            let deadline = ProcessInfo.processInfo.systemUptime + 4
            while ProcessInfo.processInfo.systemUptime < deadline {
                if try connection.protectionReleased() { return ["ended": true] }
                Thread.sleep(forTimeInterval: 0.1)
            }
            throw LockedUseError.stateUnavailable("Protected release not confirmed")
        }
        if command == "action-end" {
            // Completion releases the action barrier even after authority expires.
            try connection.finishExternalAction()
            guard ProcessInfo.processInfo.systemUptime < bindingDeadline else {
                throw LockedUseError.stateUnavailable("Task monotonic deadline expired")
            }
            try binding.validate(sessionDigest: digest(session))
            return ["active": true]
        }
        guard ProcessInfo.processInfo.systemUptime < bindingDeadline else {
            throw LockedUseError.stateUnavailable("Task monotonic deadline expired")
        }
        try binding.validate(sessionDigest: digest(session))
        switch command {
        case "check": try connection.checkAction()
        case "action-begin": try connection.beginExternalAction()
        default: throw LockedUseError.message("Unknown operation")
        }
        return ["active": true]
    }

    func run() {
        defer {
            disconnect()
            for fd in descriptors where fd >= 0 { Darwin.close(fd) }
        }
        var pending = Data()
        var bytes = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = Darwin.read(STDIN_FILENO, &bytes, bytes.count)
            if count < 0, errno == EINTR { continue }
            guard count > 0 else { return }
            pending.append(contentsOf: bytes.prefix(count))
            guard pending.count <= 16 * 1024 else { return }
            while let end = pending.firstIndex(of: 10) {
                let data = Data(pending[..<end]); pending.removeSubrange(...end)
                guard let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let id = value["requestId"] as? String, !id.isEmpty, id.utf8.count <= 128 else { return }
                do {
                    let result = try handle(value)
                    output.send(["requestId": id, "ok": true, "result": result])
                } catch {
                    disconnect()
                    output.send(["requestId": id, "ok": false, "reason": "locked_control_native_request_denied"])
                }
            }
        }
    }
}

private final class IdentityResult: @unchecked Sendable {
    private let lock = NSLock()
    private var value = "unavailable"
    var status: String { lock.lock(); defer { lock.unlock() }; return value }
    func resolve(verified: Bool, error: Error?) {
        lock.lock(); defer { lock.unlock() }
        if verified { value = "verified" }
        else if let error = error as? LAError, [.userCancel, .appCancel, .systemCancel].contains(error.code) { value = "cancelled" }
        else { value = "failed" }
    }
}

@main
enum ClientMain {
    static func main() {
        guard CommandLine.arguments.count == 1 else { exit(64) }
        Client().run()
    }
}
