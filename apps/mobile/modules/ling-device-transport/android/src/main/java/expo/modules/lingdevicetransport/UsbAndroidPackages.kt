package expo.modules.lingdevicetransport

import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.os.SystemClock
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

internal class UsbAndroidPackages(private val permission: UsbHostPermission) {
  private val manager = permission.manager
  private val sessions = mutableMapOf<String, Session>()

  private data class Port(val device: UsbDevice, val usbInterface: UsbInterface, val read: UsbEndpoint, val write: UsbEndpoint) {
    val id: String get() = device.deviceName + ":" + usbInterface.id
  }

  private class Session(val port: Port, val serial: String?) {
    val closed = AtomicBoolean()
    val busy = AtomicBoolean()
    var connection: AdbPackageConnection? = null
    var identity: AdbAndroidIdentity? = null
  }

  fun list(): List<Map<String, Any>> {
    val usb = manager ?: return emptyList()
    return usb.deviceList.values.flatMap(::ports).map { port ->
      mapOf(
        "portId" to port.id,
        "vendorId" to port.device.vendorId,
        "productId" to port.device.productId,
        "label" to (port.device.productName ?: "Android USB").filterNot(Char::isISOControl).take(80),
        "permissionGranted" to usb.hasPermission(port.device),
      )
    }
  }

  suspend fun authorize(portId: String, vendorId: Int, productId: Int) {
    permission.request(select(portId, vendorId, productId).device)
  }

  fun reserve(portId: String, vendorId: Int, productId: Int): String {
    val usb = manager ?: error("usb_target_missing")
    val port = select(portId, vendorId, productId)
    check(usb.hasPermission(port.device)) { "usb_permission_denied" }
    val serial = port.device.serialNumber
    synchronized(sessions) {
      check(sessions.size < 4 && sessions.values.none { it.port.id == portId }) { "usb_target_busy" }
      val sessionId = UUID.randomUUID().toString()
      sessions[sessionId] = Session(port, serial)
      return sessionId
    }
  }

  fun connect(sessionId: String): Map<String, String> = useSession(sessionId) { session ->
    val usb = manager ?: error("usb_target_missing")
    val reserved = session.port
    val live = select(reserved.id, reserved.device.vendorId, reserved.device.productId)
    check(usb.hasPermission(live.device)) { "usb_permission_denied" }
    check(live.device.deviceId == reserved.device.deviceId && live.device.serialNumber == session.serial) { "usb_target_changed" }
    check(session.connection == null) { "usb_target_busy" }
    val connection = usb.openDevice(live.device) ?: error("usb_connection_failed")
    val protocol = try {
      check(connection.claimInterface(live.usbInterface, false)) { "usb_target_busy" }
      AdbPackageConnection(UsbAdbPackageLink(connection, live.usbInterface, live.read, live.write, session.closed))
    } catch (error: Throwable) {
      connection.close()
      throw error
    }
    synchronized(session) {
      if (session.closed.get()) {
        protocol.close()
        error("usb_target_missing")
      }
      session.connection = protocol
    }
    val deadline = SystemClock.elapsedRealtime() + 45_000
    protocol.connect(AndroidAdbHostKey(), deadline)
    val identity = protocol.identity(deadline)
    session.identity = identity
    mapOf(
      "hardwareDigest" to digestText(listOf(live.device.vendorId, live.device.productId, session.serial.orEmpty(), identity.serial).joinToString("\u0000")),
      "firmwareDigest" to digestText(identity.fingerprint),
      "model" to identity.model,
      "androidVersion" to identity.androidVersion,
    )
  }

  fun install(sessionId: String, apk: File, digest: String): Boolean = useSession(sessionId) { session ->
    require(digest.matches(Regex("sha256:[a-f0-9]{64}"))) { "adb_invalid_apk" }
    val deadline = SystemClock.elapsedRealtime() + 120_000
    FileInputStream(apk).use { source ->
      val size = source.channel.size()
      require(size in 1..AdbPackageConnection.MAX_APK_BYTES) { "adb_invalid_apk" }
      val hash = MessageDigest.getInstance("SHA-256")
      val bytes = ByteArray(64 * 1024)
      var readBytes = 0L
      while (readBytes < size) {
        check(!session.closed.get()) { "usb_target_missing" }
        val count = source.read(bytes, 0, minOf(bytes.size.toLong(), size - readBytes).toInt())
        require(count > 0) { "adb_invalid_apk" }
        hash.update(bytes, 0, count)
        readBytes += count
      }
      require("sha256:" + hash.digest().toHexString() == digest && source.channel.size() == size) { "adb_invalid_apk" }
      source.channel.position(0)
      boundConnection(session, deadline).install(source, size, deadline)
    }
  }

  fun readPackage(sessionId: String, packageId: String): Map<String, Any> = useSession(sessionId) { session ->
    val deadline = SystemClock.elapsedRealtime() + 20_000
    val installed = boundConnection(session, deadline).installedPackage(packageId, deadline)
    buildMap {
      put("present", installed != null)
      installed?.versionCode?.let { put("versionCode", it) }
      installed?.digest?.let { put("digest", it) }
    }
  }

  fun release(sessionId: String) {
    val session = synchronized(sessions) { sessions[sessionId] } ?: return
    if (!session.closed.compareAndSet(false, true)) return
    try {
      synchronized(session) { session.connection?.close() }
    } finally {
      synchronized(sessions) { sessions.remove(sessionId) }
    }
  }

  fun close() {
    val ids = synchronized(sessions) { sessions.keys.toList() }
    for (id in ids) release(id)
  }

  private fun boundConnection(session: Session, deadline: Long): AdbPackageConnection {
    val connection = checkNotNull(session.connection) { "usb_target_missing" }
    val expected = checkNotNull(session.identity) { "adb_authorization_required" }
    val port = session.port
    val live = select(port.id, port.device.vendorId, port.device.productId)
    check(live.device.deviceId == port.device.deviceId && connection.identity(deadline) == expected) { "usb_target_changed" }
    return connection
  }

  private fun <Result> useSession(id: String, operation: (Session) -> Result): Result {
    val session = synchronized(sessions) { sessions[id] } ?: error("usb_target_missing")
    check(!session.closed.get() && session.busy.compareAndSet(false, true)) { "usb_target_busy" }
    try {
      return operation(session)
    } finally {
      session.busy.set(false)
    }
  }

  private fun select(id: String, vendorId: Int, productId: Int): Port {
    val device = manager?.deviceList?.get(id.substringBeforeLast(':')) ?: error("usb_target_missing")
    check(device.vendorId == vendorId && device.productId == productId) { "usb_target_changed" }
    return ports(device).firstOrNull { it.id == id } ?: error("usb_target_missing")
  }

  private fun ports(device: UsbDevice): List<Port> = (0 until device.interfaceCount).mapNotNull { i ->
    val intf = device.getInterface(i)
    if (intf.interfaceClass != UsbConstants.USB_CLASS_VENDOR_SPEC || intf.interfaceSubclass != 0x42 || intf.interfaceProtocol != 1) {
      return@mapNotNull null
    }
    val endpoints = (0 until intf.endpointCount).map(intf::getEndpoint)
      .filter { it.type == UsbConstants.USB_ENDPOINT_XFER_BULK }
    val read = endpoints.singleOrNull { it.direction == UsbConstants.USB_DIR_IN } ?: return@mapNotNull null
    val write = endpoints.singleOrNull { it.direction == UsbConstants.USB_DIR_OUT } ?: return@mapNotNull null
    Port(device, intf, read, write)
  }

  private fun digestText(text: String) = MessageDigest.getInstance("SHA-256").digest(text.encodeToByteArray()).toHexString()
}

private class UsbAdbPackageLink(
  private val connection: UsbDeviceConnection,
  private val intf: UsbInterface,
  private val input: UsbEndpoint,
  private val output: UsbEndpoint,
  private val cancelled: AtomicBoolean,
) : AdbPackageLink {
  override fun readFully(bytes: ByteArray, deadline: Long) {
    var offset = 0
    while (offset < bytes.size) {
      val read = connection.bulkTransfer(input, bytes, offset, bytes.size - offset, timeout(deadline, 750))
      if (read > 0) offset += read
    }
  }

  override fun write(bytes: ByteArray, deadline: Long) {
    var offset = 0
    while (offset < bytes.size) {
      val sent = connection.bulkTransfer(output, bytes, offset, bytes.size - offset, timeout(deadline, 5_000))
      if (sent <= 0) throw IOException("usb_connection_failed")
      offset += sent
    }
    // A full-size USB packet needs a zero-length packet to finish the bulk transfer.
    if (bytes.size % output.maxPacketSize == 0) {
      val sent = connection.bulkTransfer(output, EMPTY_PACKET, 0, timeout(deadline, 5_000))
      if (sent != 0) throw IOException("usb_connection_failed")
    }
  }

  override fun close() {
    try { connection.releaseInterface(intf) } finally { connection.close() }
  }

  private fun timeout(deadline: Long, upperBound: Int): Int {
    if (cancelled.get()) throw IOException("usb_target_missing")
    val left = deadline - SystemClock.elapsedRealtime()
    if (left <= 0) throw IOException("adb_timeout")
    return minOf(left, upperBound.toLong()).toInt()
  }

  companion object {
    private val EMPTY_PACKET = ByteArray(0)
  }
}
