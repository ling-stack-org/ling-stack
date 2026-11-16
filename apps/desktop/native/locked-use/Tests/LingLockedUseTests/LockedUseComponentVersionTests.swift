import XCTest
@testable import LingLockedUse

final class LockedUseComponentVersionTests: XCTestCase {
    func testOldDevelopmentInstallationSuggestsExplicitReinstall() {
        let advice = LockedUseDiagnostics.versionAdvice(installed: "0.0.1", bundled: "1.1.0")
        XCTAssertTrue(advice?.contains("Ling Locked Use disable") == true)
        XCTAssertTrue(advice?.contains("Ling Locked Use enable") == true)
    }
    func testMatchingOrUnknownVersionsDoNotSuggestReplacingComponents() {
        XCTAssertNil(LockedUseDiagnostics.versionAdvice(installed: "1.1.0", bundled: "1.1.0"))
        XCTAssertNil(LockedUseDiagnostics.versionAdvice(installed: nil, bundled: "1.1.0"))
        XCTAssertNil(LockedUseDiagnostics.versionAdvice(installed: "0.0.1", bundled: nil))
    }
}
