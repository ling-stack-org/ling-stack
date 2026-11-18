import Foundation
import LingLockedUse
import XCTest

final class LockedUseTaskBindingTests: XCTestCase {
    func testDigestTracksAuditSessionAndBootButSurvivesLockTransition() throws {
        let boot = UUID().uuidString
        let locked = LockedUseSession(state: .locked, userID: 501, auditSessionID: 42)
        let unlocked = LockedUseSession(state: .unlocked, userID: 501, auditSessionID: 42)
        let other = LockedUseSession(state: .unlocked, userID: 501, auditSessionID: 43)
        let digest = try lockedUseSessionDigest(session: locked, bootSessionID: boot)
        XCTAssertEqual(digest, try lockedUseSessionDigest(session: unlocked, bootSessionID: boot))
        XCTAssertNotEqual(digest, try lockedUseSessionDigest(session: other, bootSessionID: boot))
        XCTAssertNotEqual(digest, try lockedUseSessionDigest(session: locked, bootSessionID: UUID().uuidString))
        XCTAssertThrowsError(try lockedUseSessionDigest(session: locked, bootSessionID: "invalid"))
    }
}
