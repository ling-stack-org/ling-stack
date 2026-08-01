import ExpoModulesCore
import Foundation
import Security

public final class LingSecureDeviceKeyModule: Module {
  private let store = SecureEnclaveP256KeyStore()

  public func definition() -> ModuleDefinition {
    Name("LingSecureDeviceKey")

    AsyncFunction("randomBytes") { (length: Int) in
      guard length >= 16 && length <= 256 else {
        throw NSError(domain: "LingSecureDeviceKey", code: 1, userInfo: [NSLocalizedDescriptionKey: "invalid_secure_random_length"])
      }
      var bytes = [UInt8](repeating: 0, count: length)
      guard SecRandomCopyBytes(kSecRandomDefault, length, &bytes) == errSecSuccess else {
        throw NSError(domain: "LingSecureDeviceKey", code: 2, userInfo: [NSLocalizedDescriptionKey: "secure_random_failed"])
      }
      return Data(bytes).base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
    }

    AsyncFunction("generateOrLoad") { (keyId: String) in
      try self.store.generateOrLoad(keyId: keyId)
    }

    AsyncFunction("sign") { (keyId: String, messageBase64Url: String) in
      try self.store.sign(keyId: keyId, messageBase64Url: messageBase64Url)
    }

    AsyncFunction("verify") { (publicJwk: [String: String], messageBase64Url: String, signatureBase64Url: String) in
      try self.store.verify(
        publicJwk: publicJwk,
        messageBase64Url: messageBase64Url,
        signatureBase64Url: signatureBase64Url
      )
    }

    AsyncFunction("delete") { (keyId: String) in
      try self.store.delete(keyId: keyId)
    }
  }
}
