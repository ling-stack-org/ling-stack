import CoreGraphics
import CryptoKit
import Darwin
import Foundation
import LocalAuthentication
import SystemConfiguration

// Development/native-boundary helper. It emits content-free JSON only. The
// attestation command deliberately stays negative until the attended locked
// capture/input probe can prove the complete platform tuple.

let request = readRequest()
guard let command = request["command"] as? String,
      request["platform"] as? String == "darwin" else {
    exitWithError()
}

switch command {
case "identity":
    let reason = request["localizedReason"] as? String ?? "Authorize Ling computer control"
    writeJSON(["status": verifyLocalIdentity(reason: reason)])
case "session":
    guard let session = readSession() else { exitWithError() }
    writeJSON(session.json)
case "attest":
    guard let session = readSession(),
          let expectedDigest = request["expectedSessionBindingDigest"] as? String,
          let lockEpoch = request["lockEpoch"] as? NSNumber,
          let providerGeneration = request["providerGeneration"] as? NSNumber else {
        exitWithError()
    }
    // A console/session digest is not proof that capture and input reach the
    // same user desktop while loginwindow is excluded. Keep every executable
    // proof false until an attended disposable-target probe supplies it.
    writeJSON([
        "platform": "darwin",
        "sessionBindingDigest": session.digest,
        "lockEpoch": lockEpoch.intValue,
        "providerGeneration": providerGeneration.intValue,
        "sameUserSession": session.digest == expectedDigest,
        "userDesktopTargeted": false,
        "captureReady": false,
        "inputReady": false,
        "secureSurfaceExcluded": false,
    ])
default:
    exitWithError()
}

private struct SessionSnapshot {
    let digest: String
    let active: Bool
    let locked: Bool

    var json: [String: Any] {
        [
            "platform": "darwin",
            "sessionBindingDigest": digest,
            "sessionActive": active,
            "sessionLocked": locked,
        ]
    }
}

private func readRequest() -> [String: Any] {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard data.count > 0, data.count <= 16 * 1024,
          let value = try? JSONSerialization.jsonObject(with: data),
          let request = value as? [String: Any] else {
        exitWithError()
    }
    return request
}

private func readSession() -> SessionSnapshot? {
    var uid: uid_t = 0
    var gid: gid_t = 0
    guard let consoleUser = SCDynamicStoreCopyConsoleUser(nil, &uid, &gid) as String?,
          !consoleUser.isEmpty else {
        return nil
    }
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any],
          let onConsole = session["kCGSSessionOnConsoleKey"] as? Bool,
          let auditSessionIdentifier = session["kCGSSessionAuditIDKey"],
          let sessionUUID = session["CGSSessionUniqueSessionUUID"] as? String,
          !sessionUUID.isEmpty else {
        return nil
    }
    // On macOS the lock key is present with true while locked and omitted while
    // unlocked. Missing session identity remains fail-closed above; a missing
    // lock flag on a valid active Aqua session therefore means unlocked.
    let locked = session["CGSSessionScreenIsLocked"] as? Bool ?? false
    let active = onConsole && consoleUser != "loginwindow"
    let material = "ling-locked-control-session-v1|\(uid)|\(gid)|\(consoleUser)|\(auditSessionIdentifier)|\(sessionUUID)"
    let digest = SHA256.hash(data: Data(material.utf8)).map { String(format: "%02x", $0) }.joined()
    return SessionSnapshot(digest: digest, active: active, locked: locked)
}

private func verifyLocalIdentity(reason: String) -> String {
    guard let session = readSession(), session.active, !session.locked else {
        return "failed"
    }
    let context = LAContext()
    context.localizedCancelTitle = "Cancel"
    var evaluationError: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &evaluationError) else {
        return "unavailable"
    }
    let semaphore = DispatchSemaphore(value: 0)
    var result = "failed"
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, error in
        if success {
            result = "verified"
        } else if let code = (error as? LAError)?.code,
                  code == .userCancel || code == .systemCancel || code == .appCancel {
            result = "cancelled"
        } else if let code = (error as? LAError)?.code,
                  code == .biometryNotAvailable || code == .passcodeNotSet || code == .notInteractive {
            result = "unavailable"
        }
        semaphore.signal()
    }
    if semaphore.wait(timeout: .now() + 120) == .timedOut {
        context.invalidate()
        return "unavailable"
    }
    return result
}

private func writeJSON(_ value: [String: Any]) -> Never {
    guard JSONSerialization.isValidJSONObject(value),
          let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else {
        exitWithError()
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(0)
}

private func exitWithError() -> Never {
    exit(2)
}
