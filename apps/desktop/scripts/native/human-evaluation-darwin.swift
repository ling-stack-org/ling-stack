import AppKit
import CoreGraphics
import CryptoKit
import Darwin
import Foundation
import LocalAuthentication
import SystemConfiguration

// A separate, payload-bound human confirmation. No Computer Use authority is borrowed.
var bytes = Data()
while bytes.count <= 32768 {
    let chunk = FileHandle.standardInput.readData(ofLength: min(4096, 32769 - bytes.count))
    if chunk.isEmpty { break }
    bytes.append(chunk)
}
guard !bytes.isEmpty, bytes.count <= 32768,
      let request = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any],
      request["protocol"] as? Int == 1, let command = request["command"] as? String,
      let before = readSession() else { exit(2) }
if command == "session" { emit(before) }
guard command == "confirm", Set(request.keys) == Set(["command", "protocol", "invocationId", "intentId", "requestId", "payloadDigest", "payloadJson"]),
      let invocation = request["invocationId"] as? String,
      let intent = request["intentId"] as? String,
      let requestId = request["requestId"] as? String,
      let digest = request["payloadDigest"] as? String,
      let payload = request["payloadJson"] as? String,
      invocation.count <= 80, intent.count <= 160, requestId.count <= 160,
      payload.utf8.count <= 24576, hash(payload) == digest,
      (try? JSONSerialization.jsonObject(with: Data(payload.utf8))) is [String: Any]
else { exit(2) }

var status = "failed"
if isLive(before) {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    app.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.messageText = "确认这项 QA 人工评估"
    alert.informativeText = "仅提交下面这一个冻结的评估。确认后仍需系统身份认证；不授权其他任务。"
    alert.addButton(withTitle: "确认并认证")
    alert.addButton(withTitle: "取消")
    let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 640, height: 360))
    scroll.hasVerticalScroller = true
    let text = NSTextView(frame: scroll.bounds)
    text.isEditable = false
    text.isSelectable = true
    text.minSize = NSSize(width: 0, height: scroll.contentSize.height)
    text.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
    text.isVerticallyResizable = true
    text.isHorizontallyResizable = false
    text.autoresizingMask = [.width]
    text.textContainer?.widthTracksTextView = true
    text.textContainer?.containerSize = NSSize(width: scroll.contentSize.width, height: CGFloat.greatestFiniteMagnitude)
    text.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
    // Show the complete object, not a model-written or truncated summary.
    let object = try! JSONSerialization.jsonObject(with: Data(payload.utf8))
    let pretty = try! JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .fragmentsAllowed])
    text.string = String(data: pretty, encoding: .utf8)!
    scroll.documentView = text
    alert.accessoryView = scroll
    if alert.runModal() == .alertFirstButtonReturn,
       let current = readSession(), same(before, current) {
        let context = LAContext()
        context.localizedCancelTitle = "取消"
        context.touchIDAuthenticationAllowableReuseDuration = 0
        var error: NSError?
        if context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) {
            var finished = false
            context.evaluatePolicy(.deviceOwnerAuthentication,
              localizedReason: "提交已显示的 QA 评估 \(intent.prefix(24))") { success, error in
                DispatchQueue.main.async {
                    if success { status = "confirmed" }
                    else if let code = (error as? LAError)?.code,
                      code == .userCancel || code == .systemCancel || code == .appCancel { status = "cancelled" }
                    else { status = "failed" }
                    finished = true
                }
            }
            let deadline = Date().addingTimeInterval(110)
            while !finished && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
            if !finished { context.invalidate(); status = "unavailable" }
        } else { status = "unavailable" }
    } else { status = "cancelled" }
}
guard let after = readSession() else { exit(2) }
if !same(before, after) { status = "failed" }
emit(["status": status, "invocationId": invocation, "intentId": intent,
      "requestId": requestId, "payloadDigest": digest, "sessionBefore": before, "sessionAfter": after])

func hash(_ text: String) -> String {
    SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
}
func readSession() -> [String: Any]? {
    var uid: uid_t = 0, gid: gid_t = 0
    guard let user = SCDynamicStoreCopyConsoleUser(nil, &uid, &gid) as String?, !user.isEmpty,
          let session = CGSessionCopyCurrentDictionary() as? [String: Any],
          let onConsole = session["kCGSSessionOnConsoleKey"] as? Bool,
          let audit = session["kCGSSessionAuditIDKey"],
          let uuid = session["CGSSessionUniqueSessionUUID"] as? String, !uuid.isEmpty else { return nil }
    return ["osSessionId": hash("ling-human-session-v1|\(uid)|\(gid)|\(audit)|\(uuid)"),
            "osUserId": hash("ling-human-user-v1|\(uid)|\(gid)"),
            "active": onConsole && user != "loginwindow" && uid == getuid(),
            "locked": session["CGSSessionScreenIsLocked"] as? Bool ?? false]
}
func isLive(_ s: [String: Any]) -> Bool { s["active"] as? Bool == true && s["locked"] as? Bool == false }
func same(_ a: [String: Any], _ b: [String: Any]) -> Bool {
    isLive(a) && isLive(b) && a["osSessionId"] as? String == b["osSessionId"] as? String
      && a["osUserId"] as? String == b["osUserId"] as? String
}
func emit(_ value: [String: Any]) -> Never {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { exit(2) }
    FileHandle.standardOutput.write(data)
    exit(0)
}
