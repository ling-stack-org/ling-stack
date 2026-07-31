import AppKit
import Foundation

private let expectedNoncePattern = try! NSRegularExpression(pattern: "^[a-f0-9]{64}$")

private func argumentValue(prefix: String) -> String? {
    CommandLine.arguments.first(where: { $0.hasPrefix(prefix) }).map {
        String($0.dropFirst(prefix.count))
    }
}

private func emit(_ value: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(value),
          let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else {
        exit(2)
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

private final class ProbeApplicationDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private var acknowledgementButton: NSButton?
    private var acknowledgementCount = 0
    private let nonce: String

    init(nonce: String) {
        self.nonce = nonce
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let frame = NSRect(x: 0, y: 0, width: 460, height: 230)
        let window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Ling Locked Control Probe"
        window.isReleasedWhenClosed = false
        window.collectionBehavior = [.managed]
        window.center()

        let content = NSView(frame: frame)

        let button = NSButton(title: "Acknowledge probe", target: self, action: #selector(acknowledgeProbe))
        button.bezelStyle = .rounded
        // The button deliberately covers the logical window center. If the AX
        // tree is hidden after lock, the attended harness may take Cua Driver's
        // process/window-scoped pixel rung at the exact screenshot center.
        button.frame = NSRect(x: 24, y: 24, width: 412, height: 182)
        button.font = .systemFont(ofSize: 20, weight: .semibold)
        button.setAccessibilityIdentifier("ling.locked-control-probe.acknowledge")
        content.addSubview(button)
        acknowledgementButton = button

        window.contentView = content
        window.setAccessibilityIdentifier("ling.locked-control-probe.window")
        window.orderFrontRegardless()
        self.window = window

        emit([
            "event": "ready",
            "nonce": nonce,
            "schemaVersion": 1,
        ])
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    @objc private func acknowledgeProbe() {
        acknowledgementCount += 1
        acknowledgementButton?.title = "Acknowledged \(acknowledgementCount)"
        emit([
            "event": "input_acknowledged",
            "nonce": nonce,
            "schemaVersion": 1,
            "sequence": acknowledgementCount,
        ])
    }
}

guard let nonce = argumentValue(prefix: "--nonce="),
      expectedNoncePattern.firstMatch(
        in: nonce,
        range: NSRange(location: 0, length: nonce.utf16.count)
      ) != nil else {
    exit(2)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
private let delegate = ProbeApplicationDelegate(nonce: nonce)
app.delegate = delegate
app.run()
