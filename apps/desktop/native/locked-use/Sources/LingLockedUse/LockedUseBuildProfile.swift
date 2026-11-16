/// The development profile runs the attended native fixture and cannot become
/// a production service. Only the build compiler selects this profile.
public enum LockedUseBuildProfile {
    #if LING_LOCKED_USE_DEVELOPMENT_VALIDATION
    public static let developmentValidation = true
    #else
    public static let developmentValidation = false
    #endif

    public static var manifestSigning: String { developmentValidation ? "development_validation" : "local_identity" }
    public static var kernelTaskCheck: String { developmentValidation ? "development_identity_passed" : "identity_passed" }
    public static func permitsService(validation: Bool) -> Bool { !developmentValidation || validation }

    public static func permitsRequest(_ message: LockedUseIPCMessage) -> Bool {
        !developmentValidation || message.taskBinding == nil
            && ![.providerAttach, .actionBegin, .actionEnd].contains(message.operation)
    }
}
