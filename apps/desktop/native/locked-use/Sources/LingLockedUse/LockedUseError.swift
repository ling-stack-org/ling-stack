import Foundation

public enum LockedUseError: Error {
    case message(String)
    case stateUnavailable(String)
}
