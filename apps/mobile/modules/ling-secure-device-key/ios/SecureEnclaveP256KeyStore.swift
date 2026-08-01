import Foundation
import Security

enum LingSecureDeviceKeyError: Error, LocalizedError {
  case invalidKeyId
  case keychain(OSStatus)
  case secureEnclaveUnavailable(String)
  case privateKeyExportable
  case publicKeyUnavailable
  case invalidPublicKey
  case signingFailed(String)
  case verificationFailed(String)

  var errorDescription: String? {
    switch self {
    case .invalidKeyId: return "invalid_secure_device_key_id"
    case .keychain(let status): return "secure_device_keychain_error_\(status)"
    case .secureEnclaveUnavailable(let detail): return "secure_enclave_unavailable: \(detail)"
    case .privateKeyExportable: return "private_key_exportability_invariant_failed"
    case .publicKeyUnavailable: return "public_key_unavailable"
    case .invalidPublicKey: return "invalid_p256_public_key"
    case .signingFailed(let detail): return "secure_device_sign_failed: \(detail)"
    case .verificationFailed(let detail): return "secure_device_verify_failed: \(detail)"
    }
  }
}

struct SecureEnclaveP256KeyStore {
  private let tagPrefix = "com.lingstack.mobile.remote-device-key."
  private let algorithm = SecKeyAlgorithm.ecdsaSignatureMessageX962SHA256

  func generateOrLoad(keyId: String) throws -> [String: Any] {
    let privateKey = try loadPrivateKey(keyId: keyId) ?? generatePrivateKey(keyId: keyId)
    try assertPrivateKeyIsNotExportable(privateKey)
    return [
      "keyId": keyId,
      "publicJwk": try publicJwk(privateKey: privateKey),
      "backend": "ios_secure_enclave",
      "securityLevel": "secure_enclave",
      "hardwareBacked": true,
      "privateKeyExportable": false,
    ]
  }

  func sign(keyId: String, messageBase64Url: String) throws -> [String: Any] {
    guard let privateKey = try loadPrivateKey(keyId: keyId) else {
      throw LingSecureDeviceKeyError.keychain(errSecItemNotFound)
    }
    guard SecKeyIsAlgorithmSupported(privateKey, .sign, algorithm) else {
      throw LingSecureDeviceKeyError.signingFailed("algorithm_not_supported")
    }
    let message = try decodeBase64Url(messageBase64Url)
    var error: Unmanaged<CFError>?
    guard let signature = SecKeyCreateSignature(privateKey, algorithm, message as CFData, &error) else {
      throw LingSecureDeviceKeyError.signingFailed(error?.takeRetainedValue().localizedDescription ?? "unknown")
    }
    return [
      "signatureBase64Url": encodeBase64Url(signature as Data),
      "encoding": "x962_der",
    ]
  }

  func verify(publicJwk: [String: String], messageBase64Url: String, signatureBase64Url: String) throws -> Bool {
    let publicKey = try importPublicKey(jwk: publicJwk)
    guard SecKeyIsAlgorithmSupported(publicKey, .verify, algorithm) else {
      throw LingSecureDeviceKeyError.verificationFailed("algorithm_not_supported")
    }
    let message = try decodeBase64Url(messageBase64Url)
    let signature = try decodeBase64Url(signatureBase64Url)
    var error: Unmanaged<CFError>?
    let verified = SecKeyVerifySignature(publicKey, algorithm, message as CFData, signature as CFData, &error)
    if !verified, let error {
      _ = error.takeRetainedValue()
    }
    return verified
  }

  func delete(keyId: String) throws {
    let status = SecItemDelete(try baseQuery(keyId: keyId) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw LingSecureDeviceKeyError.keychain(status)
    }
  }

  private func validateKeyId(_ keyId: String) throws {
    guard keyId.range(of: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", options: .regularExpression) != nil else {
      throw LingSecureDeviceKeyError.invalidKeyId
    }
  }

  private func applicationTag(keyId: String) throws -> Data {
    try validateKeyId(keyId)
    return Data("\(tagPrefix)\(keyId)".utf8)
  }

  private func baseQuery(keyId: String) throws -> [String: Any] {
    return [
      kSecClass as String: kSecClassKey,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
      kSecAttrApplicationTag as String: try applicationTag(keyId: keyId),
    ]
  }

  private func loadPrivateKey(keyId: String) throws -> SecKey? {
    try validateKeyId(keyId)
    var query = try baseQuery(keyId: keyId)
    query[kSecReturnRef as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let key = item else {
      throw LingSecureDeviceKeyError.keychain(status)
    }
    return (key as! SecKey)
  }

  private func generatePrivateKey(keyId: String) throws -> SecKey {
    let accessFlags: SecAccessControlCreateFlags = [.privateKeyUsage]
    var accessError: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
      nil,
      kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      accessFlags,
      &accessError
    ) else {
      throw LingSecureDeviceKeyError.secureEnclaveUnavailable(
        accessError?.takeRetainedValue().localizedDescription ?? "access_control_failed"
      )
    }
    let attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
      kSecPrivateKeyAttrs as String: [
        kSecAttrIsPermanent as String: true,
        kSecAttrApplicationTag as String: try applicationTag(keyId: keyId),
        kSecAttrAccessControl as String: access,
      ],
    ]
    var error: Unmanaged<CFError>?
    guard let privateKey = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
      throw LingSecureDeviceKeyError.secureEnclaveUnavailable(
        error?.takeRetainedValue().localizedDescription ?? "key_generation_failed"
      )
    }
    return privateKey
  }

  private func assertPrivateKeyIsNotExportable(_ privateKey: SecKey) throws {
    var error: Unmanaged<CFError>?
    if SecKeyCopyExternalRepresentation(privateKey, &error) != nil {
      throw LingSecureDeviceKeyError.privateKeyExportable
    }
    if let error { _ = error.takeRetainedValue() }
  }

  private func publicJwk(privateKey: SecKey) throws -> [String: String] {
    guard let publicKey = SecKeyCopyPublicKey(privateKey) else {
      throw LingSecureDeviceKeyError.publicKeyUnavailable
    }
    var error: Unmanaged<CFError>?
    guard let external = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
      throw LingSecureDeviceKeyError.invalidPublicKey
    }
    if let error { _ = error.takeRetainedValue() }
    guard external.count == 65, external.first == 0x04 else {
      throw LingSecureDeviceKeyError.invalidPublicKey
    }
    return [
      "kty": "EC",
      "crv": "P-256",
      "x": encodeBase64Url(external.subdata(in: 1..<33)),
      "y": encodeBase64Url(external.subdata(in: 33..<65)),
    ]
  }

  private func importPublicKey(jwk: [String: String]) throws -> SecKey {
    guard jwk.count == 4,
          jwk["kty"] == "EC",
          jwk["crv"] == "P-256",
          let x = jwk["x"],
          let y = jwk["y"] else {
      throw LingSecureDeviceKeyError.invalidPublicKey
    }
    let xBytes = try decodeBase64Url(x)
    let yBytes = try decodeBase64Url(y)
    guard xBytes.count == 32, yBytes.count == 32 else {
      throw LingSecureDeviceKeyError.invalidPublicKey
    }
    var external = Data([0x04])
    external.append(xBytes)
    external.append(yBytes)
    let attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeyClass as String: kSecAttrKeyClassPublic,
      kSecAttrKeySizeInBits as String: 256,
    ]
    var error: Unmanaged<CFError>?
    guard let key = SecKeyCreateWithData(external as CFData, attributes as CFDictionary, &error) else {
      throw LingSecureDeviceKeyError.invalidPublicKey
    }
    if let error { _ = error.takeRetainedValue() }
    return key
  }

  private func encodeBase64Url(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  private func decodeBase64Url(_ value: String) throws -> Data {
    guard value.range(of: "^[A-Za-z0-9_-]*$", options: .regularExpression) != nil,
          value.count % 4 != 1 else {
      throw LingSecureDeviceKeyError.invalidPublicKey
    }
    let padding = String(repeating: "=", count: (4 - value.count % 4) % 4)
    let base64 = value.replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/") + padding
    guard let data = Data(base64Encoded: base64), encodeBase64Url(data) == value else {
      throw LingSecureDeviceKeyError.invalidPublicKey
    }
    return data
  }
}
