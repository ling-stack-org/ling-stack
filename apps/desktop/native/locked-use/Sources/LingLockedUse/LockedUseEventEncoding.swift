import CoreGraphics
import Darwin

/// Encode the already verified target window's local point. This private SPI
/// describes a mouse event; it neither initiates nor grants authentication.
public func encodeLockedUseWindowLocation(_ event: CGEvent, point: CGPoint) throws {
    guard point.x.isFinite, point.y.isFinite else {
        throw LockedUseError.message("Invalid Locked Use window location")
    }
    typealias SetLocation = @convention(c) (OpaquePointer, Double, Double) -> Void
    guard let library = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW | RTLD_LOCAL) else {
        throw LockedUseError.stateUnavailable("Window location SPI unavailable")
    }
    defer { dlclose(library) }
    guard let symbol = dlsym(library, "CGEventSetWindowLocation") else {
        throw LockedUseError.stateUnavailable("Window location SPI unavailable")
    }
    let function = unsafeBitCast(symbol, to: SetLocation.self)
    function(OpaquePointer(Unmanaged.passUnretained(event).toOpaque()), point.x, point.y)
}
