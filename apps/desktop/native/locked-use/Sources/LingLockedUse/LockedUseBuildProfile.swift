/// Build profiles are compiler-selected. The local development profile is
/// usable only on the enrolled developer machine; it is never release eligible.
public enum LockedUseBuildProfile {
    #if LING_LOCKED_USE_DEVELOPMENT_VALIDATION
    public static let developmentValidation = true
    #else
    public static let developmentValidation = false
    #endif

    #if LING_LOCKED_USE_LOCAL_DEVELOPMENT
    public static let localDevelopment = true
    #else
    public static let localDevelopment = false
    #endif

    public static var manifestSigning: String {
        if localDevelopment { return "local_development" }
        return developmentValidation ? "development_validation" : "local_identity"
    }

    public static var kernelTaskCheck: String {
        if localDevelopment { return "local_development_identity_passed" }
        return developmentValidation ? "development_identity_passed" : "identity_passed"
    }

    public static var usesDevelopmentValidationCategory: Bool {
        developmentValidation || localDevelopment
    }

    public static func permitsService(validation: Bool, local: Bool = false) -> Bool {
        if developmentValidation { return validation }
        if localDevelopment { return local }
        return !local
    }

    public static func permitsRequest(_ message: LockedUseIPCMessage) -> Bool {
        if developmentValidation {
            return message.taskBinding == nil
                && ![.providerAttach, .actionBegin, .actionEnd].contains(message.operation)
        }
        return true
    }
}
