package expo.modules.lingsecuredevicekey

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.util.Base64
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec

internal class AndroidKeystoreP256KeyStore {
  private val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

  fun generateOrLoad(keyId: String): Map<String, Any> {
    val alias = alias(keyId)
    if (!keyStore.containsAlias(alias)) {
      generate(alias)
    }
    val privateKey = keyStore.getKey(alias, null) as? java.security.PrivateKey
      ?: error("android_keystore_private_key_missing")
    check(privateKey.encoded == null) { "private_key_exportability_invariant_failed" }
    val publicKey = keyStore.getCertificate(alias)?.publicKey as? ECPublicKey
      ?: error("android_keystore_public_key_missing")
    val securityLevel = securityLevel(privateKey)
    return mapOf(
      "keyId" to keyId,
      "publicJwk" to publicJwk(publicKey),
      "backend" to "android_keystore",
      "securityLevel" to securityLevel,
      "hardwareBacked" to (securityLevel != "software"),
      "privateKeyExportable" to false,
    )
  }

  fun sign(keyId: String, messageBase64Url: String): Map<String, Any> {
    val privateKey = keyStore.getKey(alias(keyId), null) as? java.security.PrivateKey
      ?: error("android_keystore_private_key_missing")
    val signer = Signature.getInstance(SIGNATURE_ALGORITHM)
    signer.initSign(privateKey)
    signer.update(decodeBase64Url(messageBase64Url))
    return mapOf(
      "signatureBase64Url" to encodeBase64Url(signer.sign()),
      "encoding" to "x962_der",
    )
  }

  fun verify(publicJwk: Map<String, String>, messageBase64Url: String, signatureBase64Url: String): Boolean {
    val verifier = Signature.getInstance(SIGNATURE_ALGORITHM)
    verifier.initVerify(importPublicKey(publicJwk))
    verifier.update(decodeBase64Url(messageBase64Url))
    return verifier.verify(decodeBase64Url(signatureBase64Url))
  }

  fun delete(keyId: String) {
    keyStore.deleteEntry(alias(keyId))
  }

  private fun alias(keyId: String): String {
    require(KEY_ID_PATTERN.matches(keyId)) { "invalid_secure_device_key_id" }
    return "$ALIAS_PREFIX$keyId"
  }

  private fun generate(alias: String) {
    val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
    val specification = KeyGenParameterSpec.Builder(
      alias,
      KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
    )
      .setAlgorithmParameterSpec(ECGenParameterSpec(CURVE_NAME))
      .setDigests(KeyProperties.DIGEST_SHA256)
      .setUserAuthenticationRequired(false)
      .build()
    generator.initialize(specification)
    generator.generateKeyPair()
  }

  @Suppress("DEPRECATION")
  private fun securityLevel(privateKey: java.security.PrivateKey): String {
    val factory = KeyFactory.getInstance(privateKey.algorithm, ANDROID_KEYSTORE)
    val keyInfo = factory.getKeySpec(privateKey, KeyInfo::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      return when (keyInfo.securityLevel) {
        KeyProperties.SECURITY_LEVEL_STRONGBOX -> "strongbox"
        KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "trusted_environment"
        KeyProperties.SECURITY_LEVEL_UNKNOWN_SECURE -> "unknown_secure"
        else -> "software"
      }
    }
    return if (keyInfo.isInsideSecureHardware) "trusted_environment" else "software"
  }

  private fun publicJwk(publicKey: ECPublicKey): Map<String, String> = mapOf(
    "kty" to "EC",
    "crv" to "P-256",
    "x" to encodeBase64Url(unsignedCoordinate(publicKey.w.affineX)),
    "y" to encodeBase64Url(unsignedCoordinate(publicKey.w.affineY)),
  )

  private fun importPublicKey(jwk: Map<String, String>): ECPublicKey {
    require(jwk.keys == setOf("kty", "crv", "x", "y")) { "invalid_p256_public_key" }
    require(jwk["kty"] == "EC" && jwk["crv"] == "P-256") { "invalid_p256_public_key" }
    val x = decodeBase64Url(jwk.getValue("x"))
    val y = decodeBase64Url(jwk.getValue("y"))
    require(x.size == 32 && y.size == 32) { "invalid_p256_public_key" }
    val parameters = AlgorithmParameters.getInstance("EC").apply {
      init(ECGenParameterSpec(CURVE_NAME))
    }.getParameterSpec(ECParameterSpec::class.java)
    val specification = ECPublicKeySpec(
      ECPoint(BigInteger(1, x), BigInteger(1, y)),
      parameters,
    )
    return KeyFactory.getInstance("EC").generatePublic(specification) as ECPublicKey
  }

  private fun unsignedCoordinate(value: BigInteger): ByteArray {
    val signed = value.toByteArray()
    val unsigned = if (signed.size == 33 && signed[0] == 0.toByte()) signed.copyOfRange(1, 33) else signed
    require(unsigned.size <= 32) { "invalid_p256_coordinate" }
    return ByteArray(32).also { output ->
      unsigned.copyInto(output, destinationOffset = 32 - unsigned.size)
    }
  }

  private fun encodeBase64Url(bytes: ByteArray): String =
    Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

  private fun decodeBase64Url(value: String): ByteArray {
    require(BASE64URL_PATTERN.matches(value) && value.length % 4 != 1) { "invalid_base64url" }
    val decoded = Base64.decode(value, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    require(encodeBase64Url(decoded) == value) { "noncanonical_base64url" }
    return decoded
  }

  private companion object {
    const val ANDROID_KEYSTORE = "AndroidKeyStore"
    const val ALIAS_PREFIX = "com.lingstack.mobile.remote-device-key."
    const val CURVE_NAME = "secp256r1"
    const val SIGNATURE_ALGORITHM = "SHA256withECDSA"
    val KEY_ID_PATTERN = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
    val BASE64URL_PATTERN = Regex("^[A-Za-z0-9_-]*$")
  }
}
