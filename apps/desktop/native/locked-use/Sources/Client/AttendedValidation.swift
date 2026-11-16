import AppKit
@preconcurrency import ApplicationServices
import Darwin
import Foundation
import LingLockedUse
import LocalAuthentication
import ScreenCaptureKit

/// Explicit installed-client acceptance using only a disposable owned fixture.
@MainActor
enum AttendedValidation {
    private static func require(_ value: Bool, _ message: String) throws {
        guard value else { throw LockedUseError.stateUnavailable(message) }
    }

    static func run() async throws {
        let initial = LockedUseSession.current()
        try require(initial.state == .unlocked && geteuid() > 0, "Start attended validation in the unlocked enrolled Aqua session")
        try require(AXIsProcessTrusted() && CGPreflightScreenCaptureAccess(), "Client Accessibility and Screen Recording permissions are required")
        let context = LAContext()
        try require(try await context.evaluatePolicy(.deviceOwnerAuthentication,
            localizedReason: "Validate Ling protected Computer Use with a disposable test window"), "Local verification was not completed")
        try require(LockedUseSession.current() == initial, "Session changed during local verification")
        let fixture = Process()
        fixture.executableURL = URL(fileURLWithPath: "/Library/Application Support/LingStack/LockedUse/Ling Guardian.app/Contents/MacOS/LingGuardian")
        fixture.arguments = ["--external-fixture"]
        fixture.standardInput = FileHandle.nullDevice; fixture.standardOutput = FileHandle.nullDevice
        fixture.standardError = FileHandle.nullDevice
        try fixture.run()
        defer { if fixture.isRunning { fixture.terminate() } }
        let root = AXUIElementCreateApplication(fixture.processIdentifier)
        AXUIElementSetMessagingTimeout(root, 0.2)
        let startupDeadline = ProcessInfo.processInfo.systemUptime + 8
        var button: AXUIElement?
        while button == nil, fixture.isRunning, ProcessInfo.processInfo.systemUptime < startupDeadline {
            button = find(root, identifier: "locked-use-validation-increment")
            if button == nil { try await Task.sleep(for: .milliseconds(100)) }
        }
        guard let button, let label = find(root, identifier: "locked-use-validation-counter") else {
            throw LockedUseError.stateUnavailable("Owned validation fixture did not publish Accessibility elements")
        }
        try require(AXUIElementPerformAction(button, kAXPressAction as CFString) == .success, "Baseline Accessibility input failed")
        try await counter(label, equals: 1)
        let keychain = try LockedUseKeychainProbe()
        defer { _ = keychain.cleanup() }
        var descriptors: [Int32] = [-1, -1]
        guard socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0 else { throw POSIXError(.EIO) }
        defer { for fd in descriptors { Darwin.close(fd) } }
        let connection = LockedUseConnection(clientSocket: descriptors[0])
        defer { connection.end(disconnecting: true) }
        do {
            print("Attended validation ready. Lock this Mac normally within 60 seconds; do not use local input while the protected fixture is running.")
            fflush(stdout)
            let lockDeadline = ProcessInfo.processInfo.systemUptime + 60
            while LockedUseSession.current().state == .unlocked, ProcessInfo.processInfo.systemUptime < lockDeadline {
                try await Task.sleep(for: .milliseconds(100))
            }
            let locked = LockedUseSession.current()
            try require(locked.state == .locked && locked.userID == initial.userID && locked.auditSessionID == initial.auditSessionID,
                "Normal lock in the original Aqua session was not observed")
            try connection.acquire(session: locked)
            try connection.checkAction()
            try keychain.verify()
            let before = try await capture(processID: fixture.processIdentifier)
            try connection.checkAction()
            try require(AXUIElementPerformAction(button, kAXPressAction as CFString) == .success, "Protected Accessibility input failed")
            try await counter(label, equals: 2)
            try connection.checkAction()
            try await targetedClick(button, processID: fixture.processIdentifier)
            try await counter(label, equals: 3)
            try connection.checkAction()
            let after = try await capture(processID: fixture.processIdentifier)
            try require(before != after, "ScreenCaptureKit did not observe the owned window's acknowledged input")
            try keychain.verify()
            try connection.recordValidation()
            connection.end()
            let releaseDeadline = ProcessInfo.processInfo.systemUptime + 8
            var released = false
            while !released, ProcessInfo.processInfo.systemUptime < releaseDeadline {
                released = try connection.protectionReleased()
                if !released { try await Task.sleep(for: .milliseconds(100)) }
            }
            try require(released && LockedUseSession.current().state == .locked, "Observed native relock and guard release are required")
            print("Protected GUI, targeted input and isolated Keychain checks passed. Unlock this Mac normally within 120 seconds to finish validation.")
            fflush(stdout)
            try await waitForManualUnlock(initial)
            try keychain.verify()
            try require(keychain.cleanup(), "Isolated validation Keychain records could not be removed")
            try connection.recordValidation(manual: true)
            print("Attended native validation passed; root evidence is in validation-report.json. Physical-display, fault and packaged-provider acceptance remain separate release checks.")
        } catch {
            connection.end()
            let releaseDeadline = ProcessInfo.processInfo.systemUptime + 8
            while ProcessInfo.processInfo.systemUptime < releaseDeadline {
                if (try? connection.protectionReleased()) == true { break }
                try? await Task.sleep(for: .milliseconds(100))
            }
            if !keychain.cleanup() {
                print("Validation stopped. Unlock this Mac normally within 120 seconds so the isolated Keychain records can be removed.")
                fflush(stdout)
                try? await waitForManualUnlock(initial)
                if !keychain.cleanup() {
                    fputs("Isolated validation Keychain cleanup remains incomplete. Final acceptance was not recorded.\n", stderr)
                }
            }
            throw error
        }
    }

    private static func waitForManualUnlock(_ initial: LockedUseSession) async throws {
        let deadline = ProcessInfo.processInfo.systemUptime + 120
        while LockedUseSession.current() != initial, ProcessInfo.processInfo.systemUptime < deadline {
            try await Task.sleep(for: .milliseconds(100))
        }
        try require(LockedUseSession.current() == initial, "Normal manual unlock in the original session was not observed")
    }

    private static func find(_ root: AXUIElement, identifier: String) -> AXUIElement? {
        var remaining = 128
        var visited: [AXUIElement] = []
        func visit(_ element: AXUIElement, depth: Int) -> AXUIElement? {
            guard remaining > 0, depth <= 10, !visited.contains(where: { CFEqual($0, element) }) else { return nil }
            remaining -= 1; visited.append(element)
            var value: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, kAXIdentifierAttribute as CFString, &value) == .success,
               value as? String == identifier { return element }
            for attribute in [kAXWindowsAttribute, kAXChildrenAttribute] {
                var children: CFTypeRef?
                if AXUIElementCopyAttributeValue(element, attribute as CFString, &children) == .success {
                    for child in children as? [AXUIElement] ?? [] {
                        if let match = visit(child, depth: depth + 1) { return match }
                    }
                }
            }
            return nil
        }
        return visit(root, depth: 0)
    }

    private static func counter(_ label: AXUIElement, equals expected: Int) async throws {
        let deadline = ProcessInfo.processInfo.systemUptime + 2
        repeat {
            var value: CFTypeRef?
            if AXUIElementCopyAttributeValue(label, kAXValueAttribute as CFString, &value) == .success,
               value as? String == "Counter: \(expected)" { return }
            try await Task.sleep(for: .milliseconds(50))
        } while ProcessInfo.processInfo.systemUptime < deadline
        throw LockedUseError.stateUnavailable("Fixture did not acknowledge the expected input count")
    }

    private static func capture(processID: Int32) async throws -> Data {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let window = content.windows.first(where: { $0.owningApplication?.processID == processID && $0.title == "Locked Use Native Validation" }) else {
            throw LockedUseError.stateUnavailable("Owned ScreenCaptureKit window unavailable")
        }
        let configuration = SCStreamConfiguration()
        configuration.width = 460; configuration.height = 250
        configuration.showsCursor = false; configuration.ignoreShadowsSingleWindow = true
        let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: configuration)
        guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            throw LockedUseError.stateUnavailable("Owned window capture unavailable")
        }
        return png
    }

    private static func targetedClick(_ button: AXUIElement, processID: Int32) async throws {
        var rawPosition: CFTypeRef?, rawSize: CFTypeRef?
        try require(AXUIElementCopyAttributeValue(button, kAXPositionAttribute as CFString, &rawPosition) == .success
            && AXUIElementCopyAttributeValue(button, kAXSizeAttribute as CFString, &rawSize) == .success,
            "Fixture input geometry unavailable")
        guard let rawPosition, let rawSize, CFGetTypeID(rawPosition) == AXValueGetTypeID(), CFGetTypeID(rawSize) == AXValueGetTypeID() else {
            throw LockedUseError.stateUnavailable("Fixture input geometry malformed")
        }
        var position = CGPoint.zero, size = CGSize.zero
        try require(AXValueGetValue(rawPosition as! AXValue, .cgPoint, &position)
            && AXValueGetValue(rawSize as! AXValue, .cgSize, &size), "Fixture input geometry invalid")
        let windows = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let window = windows.windows.first(where: { $0.owningApplication?.processID == processID && $0.title == "Locked Use Native Validation" }),
              let source = CGEventSource(stateID: .privateState) else { throw LockedUseError.stateUnavailable("Fixture input source unavailable") }
        let point = CGPoint(x: position.x + size.width / 2, y: position.y + size.height / 2)
        for type in [CGEventType.leftMouseDown, .leftMouseUp] {
            guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left) else {
                throw LockedUseError.stateUnavailable("Fixture mouse event unavailable")
            }
            for field in [UInt32(51), 91, 92] {
                if let field = CGEventField(rawValue: field) { event.setIntegerValueField(field, value: Int64(window.windowID)) }
            }
            event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(processID))
            event.setIntegerValueField(.mouseEventClickState, value: 1)
            event.postToPid(processID)
        }
    }
}
