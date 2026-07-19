package expo.modules.lingsecuredevicekey

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class LingSecureDeviceKeyModule : Module() {
  private val store = AndroidKeystoreP256KeyStore()

  override fun definition() = ModuleDefinition {
    Name("LingSecureDeviceKey")

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
