package expo.modules.lingsecuredevicekey

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import android.util.Base64
import java.security.SecureRandom

class LingSecureDeviceKeyModule : Module() {
  private val store = AndroidKeystoreP256KeyStore()

  override fun definition() = ModuleDefinition {
    Name("LingSecureDeviceKey")

    AsyncFunction("randomBytes") { length: Int ->
      require(length in 16..256) { "invalid_secure_random_length" }
      val bytes = ByteArray(length)
      SecureRandom().nextBytes(bytes)
      Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    }

    AsyncFunction("generateOrLoad") { keyId: String ->
      store.generateOrLoad(keyId)
    }

    AsyncFunction("sign") { keyId: String, messageBase64Url: String ->
      store.sign(keyId, messageBase64Url)
    }

    AsyncFunction("verify") { publicJwk: Map<String, String>, messageBase64Url: String, signatureBase64Url: String ->
      store.verify(publicJwk, messageBase64Url, signatureBase64Url)
    }

    AsyncFunction("delete") { keyId: String ->
      store.delete(keyId)
    }
  }
}
