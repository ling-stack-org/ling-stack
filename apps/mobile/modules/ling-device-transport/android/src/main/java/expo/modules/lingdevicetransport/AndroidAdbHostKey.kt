package expo.modules.lingdevicetransport

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.math.BigInteger
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.interfaces.RSAPublicKey

internal class AndroidAdbHostKey : AdbHostAuthentication {
  private val key by lazy { loadKey() }

  override fun sign(token: ByteArray): ByteArray {
    require(token.size == 20)
    val signature = Signature.getInstance("NONEwithRSA")
    signature.initSign(key.privateKey)
    signature.update(sha1DigestInfo)
    signature.update(token)
    return signature.sign()
  }

  override fun publicKey(): ByteArray {
    val bytes = encodeAdbPublicKey(key.certificate.publicKey as RSAPublicKey)
    return (Base64.encodeToString(bytes, Base64.NO_WRAP) + " LingMobile\u0000").encodeToByteArray()
  }

  companion object {
    private const val ALIAS = "ling.device.usb.adb"
    private val sha1DigestInfo = byteArrayOf(0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a, 0x05, 0x00, 0x04, 0x14)

    @Synchronized private fun loadKey(): KeyStore.PrivateKeyEntry {
      val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
      if (!store.containsAlias(ALIAS)) {
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, "AndroidKeyStore")
        generator.initialize(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
          .setKeySize(2048)
          .setSignaturePaddings(KeyProperties.SIGNATURE_PADDING_RSA_PKCS1)
          .setDigests(KeyProperties.DIGEST_NONE, KeyProperties.DIGEST_SHA256)
          .build())
        generator.generateKeyPair()
      }
      return store.getEntry(ALIAS, null) as KeyStore.PrivateKeyEntry
    }
  }
}

internal fun encodeAdbPublicKey(publicKey: RSAPublicKey): ByteArray {
  val modulus = publicKey.modulus
  require(modulus.bitLength() == 2048 && publicKey.publicExponent.bitLength() < 32)
  val word = BigInteger.ONE.shiftLeft(32)
  val inverse = modulus.mod(word).modInverse(word).negate().mod(word)
  val square = BigInteger.ONE.shiftLeft(4096).mod(modulus)
  val buffer = ByteBuffer.allocate(524).order(ByteOrder.LITTLE_ENDIAN)
  buffer.putInt(64)
  buffer.putInt(inverse.toInt())
  buffer.put(fixedLittleEndian(modulus))
  buffer.put(fixedLittleEndian(square))
  buffer.putInt(publicKey.publicExponent.toInt())
  return buffer.array()
}

private fun fixedLittleEndian(value: BigInteger): ByteArray {
  val bytes = value.toByteArray()
  return ByteArray(256) { index -> bytes.getOrElse(bytes.lastIndex - index) { 0 } }
}
