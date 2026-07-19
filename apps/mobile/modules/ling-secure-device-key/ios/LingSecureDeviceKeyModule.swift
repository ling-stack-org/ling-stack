import ExpoModulesCore

public final class LingSecureDeviceKeyModule: Module {
  private let store = SecureEnclaveP256KeyStore()

  public func definition() -> ModuleDefinition {
    Name("LingSecureDeviceKey")

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
