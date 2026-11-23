package expo.modules.lingdevicetransport

import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.net.URI
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

class LingDeviceTransportModule : Module() {
  private val sessions = ConcurrentHashMap<String, PinnedSshSession>()
  private val usbHost = lazy { UsbHostPermission(checkNotNull(appContext.reactContext)) }
  private val usbModbus = lazy { UsbModbusReader(usbHost.value) }
  private val usbAndroid = lazy { UsbAndroidPackages(usbHost.value) }

  override fun definition() = ModuleDefinition {
    Name("LingDeviceTransport")

    AsyncFunction("inspectAndroidApk") { fileUri: String ->
      val context = checkNotNull(appContext.reactContext)
      AndroidApkArchive.inspect(context.packageManager, requirePrivateApk(fileUri))
    }

    Function("reserve") {
      check(sessions.size < 4) { "ssh_target_busy" }
      val id = UUID.randomUUID().toString()
      sessions[id] = PinnedSshSession()
      id
    }

    AsyncFunction("connect") { id: String, host: String, port: Int, user: String, fingerprint: String, password: String ->
      requireSession(id).connect(host, port, user, fingerprint, password)
    }

    AsyncFunction("read") { id: String, operation: String, argument: String ->
      requireSession(id).read(operation, argument)
    }

    Function("close") { id: String -> sessions.remove(id)?.close() }

    AsyncFunction("listUsbModbusPorts") { usbModbus.value.list() }

    AsyncFunction("authorizeUsbModbusPort") Coroutine { id: String, vendorId: Int, productId: Int ->
      usbModbus.value.authorize(id, vendorId, productId)
    }

    AsyncFunction("reserveUsbModbusPort") { id: String, vendorId: Int, productId: Int ->
      usbModbus.value.reserve(id, vendorId, productId)
    }

    AsyncFunction("readUsbModbusRegisters") { id: String, baudRate: Int, parity: String, stopBits: Int, requestHex: String ->
      usbModbus.value.read(id, baudRate, parity, stopBits, requestHex)
    }

    Function("releaseUsbModbusPort") { id: String -> usbModbus.value.release(id) }

    AsyncFunction("listUsbAndroidTargets") { usbAndroid.value.list() }

    AsyncFunction("authorizeUsbAndroidTarget") Coroutine { id: String, vendorId: Int, productId: Int ->
      usbAndroid.value.authorize(id, vendorId, productId)
    }

    Function("reserveUsbAndroidTarget") { id: String, vendorId: Int, productId: Int ->
      usbAndroid.value.reserve(id, vendorId, productId)
    }

    AsyncFunction("connectUsbAndroidTarget") { id: String -> usbAndroid.value.connect(id) }

    AsyncFunction("installUsbAndroidApk") { id: String, uri: String, digest: String ->
      usbAndroid.value.install(id, requirePrivateApk(uri, sealed = true), digest)
    }

    AsyncFunction("readUsbAndroidInstalledPackage") { id: String, packageId: String ->
      usbAndroid.value.readPackage(id, packageId)
    }

    Function("releaseUsbAndroidTarget") { id: String -> usbAndroid.value.release(id) }

    OnDestroy {
      for (session in sessions.values) session.close()
      sessions.clear()
      if (usbModbus.isInitialized()) usbModbus.value.close()
      if (usbAndroid.isInitialized()) usbAndroid.value.close()
    }
  }

  private fun requireSession(id: String): PinnedSshSession = sessions[id] ?: error("ssh_session_closed")

  private fun requirePrivateApk(fileUri: String, sealed: Boolean = false): File {
    val root = File(appContext.persistentFilesDirectory, "device-artifacts").canonicalFile
    val file = File(URI.create(fileUri)).canonicalFile
    require(file.path.startsWith(root.path + File.separator) && file.isFile) { "apk_archive_path_invalid" }
    if (sealed) {
      require(file.parentFile?.name == "verified" && file.parentFile?.parentFile?.parentFile == root) { "apk_archive_path_invalid" }
    }
    return file
  }
}
