import CoreGraphics
import XCTest
@testable import LingLockedUse

final class LockedUseDispatchTests: XCTestCase {
    private enum Revoked: Error { case lease }

    func testColdHandshakeBudgetDoesNotExtendActionOrGuardDeadlines() {
        XCTAssertEqual(LockedUseIPCEndpoint.agent.timeout(operation: .begin, firstReply: true), 8)
        XCTAssertEqual(LockedUseIPCEndpoint.observer.timeout(operation: .status, firstReply: true), 8)
        XCTAssertEqual(LockedUseIPCEndpoint.guardian.timeout(operation: .guardianHello, firstReply: true), 8)
        for endpoint in [LockedUseIPCEndpoint.agent, .guardian, .plugin, .admin] {
            for operation in [LockedUseIPCMessage.Operation.action, .guardianReport, .watchdogReport, .pluginConsume] {
                XCTAssertEqual(endpoint.timeout(operation: operation, firstReply: true), 2)
            }
        }
        XCTAssertEqual(LockedUseIPCEndpoint.agent.timeout(operation: .begin, firstReply: false), 2)
        XCTAssertEqual(LockedUseIPCEndpoint.plugin.timeout(operation: .pluginClaim, firstReply: true), 2)
    }

    func testLeasedCapturePolicyIsClearedOnThrow() {
        XCTAssertFalse(LockedUseActionScope.requiresScreenCaptureKit)
        XCTAssertThrowsError(try LockedUseActionScope.withValidator({}, body: {
            XCTAssertTrue(LockedUseActionScope.requiresScreenCaptureKit)
            throw Revoked.lease
        }))
        XCTAssertFalse(LockedUseActionScope.requiresScreenCaptureKit)
    }

}
