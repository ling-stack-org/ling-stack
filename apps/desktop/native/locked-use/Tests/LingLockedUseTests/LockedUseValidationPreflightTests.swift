import XCTest
@testable import LingLockedUse

final class LockedUseValidationPreflightTests: XCTestCase {
    private func diagnostics(
        session: LockedUseSession = .init(state: .unlocked, userID: 501, auditSessionID: 100),
        componentsVerified: Bool = true, clientApproved: Bool = true,
        policyIntact: Bool = true, accessibility: Bool = true, screenRecording: Bool = true,
        guardianAccessibility: Bool? = true, guardianInputMonitoring: Bool? = true
    ) -> LockedUseDiagnostics {
        .init(schemaVersion: 1, stage: "unavailable", enabled: false, available: false,
              clientApproved: clientApproved, authenticationPolicyIntact: policyIntact,
              componentsVerified: componentsVerified, session: session,
              accessibility: accessibility, screenRecording: screenRecording, inputMonitoring: false,
              installedPluginVersion: "1.0.0", bundledPluginVersion: "1.0.0",
              pluginInstalled: true, brokerInstalled: true,
              guardianAccessibility: guardianAccessibility, guardianInputMonitoring: guardianInputMonitoring,
              otherAuthorizationPlugins: [], blockers: ["Production acceptance has not completed."])
    }

    func testUnpromotedInstallationCanStartValidationWithoutClientInputMonitoring() {
        let value = diagnostics()
        XCTAssertFalse(value.enabled)
        XCTAssertFalse(value.available)
        XCTAssertFalse(value.inputMonitoring)
        XCTAssertTrue(value.attendedValidationBlockers.isEmpty)
    }

    func testGuardianPermissionsMustBeReportedByGuardian() {
        for permission in [false, nil] as [Bool?] {
            XCTAssertEqual(diagnostics(guardianAccessibility: permission).attendedValidationBlockers,
                           ["guardian_accessibility_permission_required"])
            XCTAssertEqual(diagnostics(guardianInputMonitoring: permission).attendedValidationBlockers,
                           ["guardian_input_monitoring_permission_required"])
        }
    }

    func testInstallationAndClientPermissionsAreIndependentPrerequisites() {
        XCTAssertEqual(diagnostics(componentsVerified: false).attendedValidationBlockers,
                       ["installed_components_verification_required"])
        XCTAssertEqual(diagnostics(clientApproved: false).attendedValidationBlockers,
                       ["installed_client_approval_required"])
        XCTAssertEqual(diagnostics(policyIntact: false).attendedValidationBlockers,
                       ["installed_authentication_policy_required"])
        XCTAssertEqual(diagnostics(accessibility: false, screenRecording: false).attendedValidationBlockers,
                       ["client_accessibility_permission_required", "client_screen_recording_permission_required"])
    }

    func testLockedUnavailableAndIncompleteSessionsCannotStartValidation() {
        for session in [LockedUseSession(state: .locked, userID: 501, auditSessionID: 100),
                        .init(state: .unavailable, userID: nil, auditSessionID: nil),
                        .init(state: .unlocked, userID: nil, auditSessionID: 100),
                        .init(state: .unlocked, userID: 501, auditSessionID: nil)] {
            XCTAssertEqual(diagnostics(session: session).attendedValidationBlockers,
                           ["completed_unlocked_aqua_session_required"])
        }
    }
}
