import AppKit
import Darwin

/// A separate signed window whose counter acknowledges background provider input.
@MainActor
final class ValidationFixture: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private let label = NSTextField(labelWithString: "Counter: 0")
    private var count = 0
    private var parentExit: DispatchSourceProcess?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 460, height: 240),
            styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Ling Locked Use Validation"
        window.backgroundColor = .white
        window.isReleasedWhenClosed = false
        label.frame = NSRect(x: 30, y: 150, width: 350, height: 32)
        label.font = .monospacedSystemFont(ofSize: 24, weight: .regular)
        label.textColor = .black
        label.setAccessibilityIdentifier("ling.validation.counter")
        window.contentView?.addSubview(label)
        let button = NSButton(title: "Increment", target: self, action: #selector(increment))
        button.frame = NSRect(x: 30, y: 60, width: 180, height: 48)
        button.setAccessibilityIdentifier("ling.validation.increment")
        window.contentView?.addSubview(button)
        window.makeKeyAndOrderFront(nil)
        self.window = window
        NSApplication.shared.activate(ignoringOtherApps: true)
        emit()
        let source = DispatchSource.makeProcessSource(identifier: getppid(), eventMask: .exit, queue: .main)
        source.setEventHandler { NSApplication.shared.terminate(nil) }
        source.resume()
        parentExit = source
        DispatchQueue.main.asyncAfter(deadline: .now() + 600) { NSApplication.shared.terminate(nil) }
    }

    @objc private func increment(_ sender: NSButton) {
        count += 1
        label.stringValue = "Counter: \(count)"
        window?.displayIfNeeded()
        emit()
    }

    private func emit() {
        guard let window else { return }
        let message: [String: Any] = ["event": "validationFixture", "counter": count,
            "processID": getpid(), "windowID": window.windowNumber]
        if let data = try? JSONSerialization.data(withJSONObject: message, options: [.sortedKeys]) {
            FileHandle.standardOutput.write(data + Data([10]))
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main
enum FixtureMain {
    @MainActor static func main() {
        guard Array(CommandLine.arguments.dropFirst()) == ["--attended-fixture"],
              geteuid() > 0, getppid() > 1, isatty(STDOUT_FILENO) == 0 else { exit(64) }
        let app = NSApplication.shared
        let delegate = ValidationFixture()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { app.run() }
    }
}
