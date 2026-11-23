package expo.modules.lingdevicetransport

import android.os.SystemClock
import com.hoho.android.usbserial.driver.UsbSerialPort
import com.hoho.android.usbserial.driver.UsbSerialProber
import java.io.IOException
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.ceil

internal class UsbModbusReader(private val permission: UsbHostPermission) {
  private val manager = permission.manager
  private val prober = UsbSerialProber.getDefaultProber()
  private val sessions = ConcurrentHashMap<String, Session>()
  private val busyPorts = ConcurrentHashMap.newKeySet<String>()

  private data class Session(
    val portId: String,
    val serial: String?,
    val vendorId: Int,
    val productId: Int,
    val expiresAt: Long,
    val started: AtomicBoolean = AtomicBoolean(),
    val cancelled: AtomicBoolean = AtomicBoolean(),
  )

  fun list(): List<Map<String, Any>> {
    val usb = manager ?: return emptyList()
    return prober.findAllDrivers(usb).flatMap { driver ->
      val device = driver.device
      driver.ports.map { port ->
        mapOf(
          "portId" to portId(port),
          "portNumber" to port.portNumber,
          "vendorId" to device.vendorId,
          "productId" to device.productId,
          "label" to (device.productName ?: port.javaClass.simpleName).filterNot(Char::isISOControl).take(80),
          "permissionGranted" to usb.hasPermission(device),
        )
      }
    }
  }

  suspend fun authorize(portId: String, vendorId: Int, productId: Int) {
    val usb = manager ?: error("usb_target_missing")
    val device = selectPort(portId, vendorId, productId).driver.device
    permission.request(device)
    check(usb.hasPermission(selectPort(portId, vendorId, productId).driver.device)) { "usb_permission_denied" }
  }

  fun reserve(portId: String, vendorId: Int, productId: Int): Map<String, Any> {
    val usb = manager ?: error("usb_target_missing")
    val port = selectPort(portId, vendorId, productId)
    val device = port.driver.device
    check(usb.hasPermission(device)) { "usb_permission_denied" }
    val serial = device.serialNumber?.takeIf { it.isNotBlank() }
    val id = UUID.randomUUID().toString()
    val identity = serial?.let {
      val bytes = "$vendorId:$productId:${port.portNumber}:$it".encodeToByteArray()
      MessageDigest.getInstance("SHA-256").digest(bytes).toHex()
    } ?: id
    val now = SystemClock.elapsedRealtime()
    synchronized(sessions) {
      sessions.entries.removeIf { (_, value) -> value.expiresAt <= now && !value.started.get() }
      check(sessions.size < 4) { "usb_target_busy" }
      sessions[id] = Session(portId, serial, vendorId, productId, now + 30_000)
    }
    return mapOf("sessionId" to id, "identity" to identity, "stableIdentity" to (serial != null))
  }

  fun read(sessionId: String, baudRate: Int, parity: String, stopBits: Int, requestHex: String): Map<String, Any> {
    check(baudRate in setOf(1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200) && stopBits in 1..2) { "usb_invalid_request" }
    val parityMode = when (parity) {
      "none" -> UsbSerialPort.PARITY_NONE
      "even" -> UsbSerialPort.PARITY_EVEN
      "odd" -> UsbSerialPort.PARITY_ODD
      else -> error("usb_invalid_request")
    }
    val request = decodeRegisterRead(requestHex)
    val usb = manager ?: error("usb_target_missing")
    val session = sessions[sessionId] ?: error("usb_target_missing")
    check(session.started.compareAndSet(false, true)) { "usb_target_busy" }
    var acquired = false
    try {
      check(session.expiresAt > SystemClock.elapsedRealtime()) { "usb_target_changed" }
      acquired = busyPorts.add(session.portId)
      check(acquired) { "usb_target_busy" }
      check(!session.cancelled.get()) { "usb_operation_cancelled" }
      val port = selectPort(session.portId, session.vendorId, session.productId)
      val device = port.driver.device
      check(usb.hasPermission(device)) { "usb_permission_denied" }
      check(device.serialNumber?.takeIf { it.isNotBlank() } == session.serial) { "usb_target_changed" }
      val connection = usb.openDevice(device) ?: error("usb_connection_failed")
      try {
        port.open(connection)
        port.setParameters(baudRate, 8, stopBits, parityMode)
        val frameGapMs = if (baudRate > 19200) 2
          else ceil(3.5 * (9 + stopBits + if (parity == "none") 0 else 1) * 1000 / baudRate).toInt()
        val chunk = ByteArray(512)
        // Reading through a quiet interval also drains adapters without a hardware purge command.
        waitForModbusBusIdle(maxOf(20, frameGapMs), SystemClock::elapsedRealtime) { timeout ->
          check(!session.cancelled.get()) { "usb_operation_cancelled" }
          port.read(chunk, timeout)
        }
        check(!session.cancelled.get()) { "usb_operation_cancelled" }
        val sentAtMs = System.currentTimeMillis().toDouble()
        port.write(request, 1_000)
        val reply = ModbusRegisterReply()
        val deadline = SystemClock.elapsedRealtime() + 2_000
        while (!session.cancelled.get() && !reply.finished && SystemClock.elapsedRealtime() < deadline) {
          try {
            reply.append(chunk, port.read(chunk, 80))
          } catch (_: IOException) {
            break
          }
        }
        return mapOf("replyHex" to reply.bytes().toHex(), "complete" to (reply.complete && !session.cancelled.get()),
          "sentAtMs" to sentAtMs, "receivedAtMs" to System.currentTimeMillis().toDouble())
      } finally {
        if (port.isOpen) runCatching { port.close() }
        else connection.close()
      }
    } finally {
      sessions.remove(sessionId, session)
      if (acquired) busyPorts.remove(session.portId)
    }
  }

  fun release(sessionId: String) { sessions.remove(sessionId)?.cancelled?.set(true) }

  fun close() {
    for (sessionId in sessions.keys) release(sessionId)
  }

  private fun selectPort(id: String, vendorId: Int, productId: Int): UsbSerialPort {
    val usb = manager ?: error("usb_target_missing")
    val device = usb.deviceList[id.substringBeforeLast(':')] ?: error("usb_target_missing")
    check(device.vendorId == vendorId && device.productId == productId) { "usb_target_changed" }
    return prober.probeDevice(device)?.ports?.firstOrNull { portId(it) == id } ?: error("usb_target_missing")
  }

  private fun portId(port: UsbSerialPort): String = "${port.driver.device.deviceName}:${port.portNumber}"
}

internal fun waitForModbusBusIdle(quietMs: Int, elapsedRealtime: () -> Long, read: (Int) -> Int) {
  val deadline = elapsedRealtime() + 250
  while (elapsedRealtime() + quietMs <= deadline) {
    if (read(quietMs) == 0) return
  }
  error("usb_target_busy")
}

internal fun decodeRegisterRead(hex: String): ByteArray {
  require(Regex("[0-9a-f]{16}").matches(hex)) { "usb_invalid_request" }
  val bytes = ByteArray(8) { index -> hex.substring(index * 2, index * 2 + 2).toInt(16).toByte() }
  val unit = bytes[0].toInt() and 0xff
  val function = bytes[1].toInt() and 0xff
  val address = ((bytes[2].toInt() and 0xff) shl 8) or (bytes[3].toInt() and 0xff)
  val count = ((bytes[4].toInt() and 0xff) shl 8) or (bytes[5].toInt() and 0xff)
  require(unit in 1..247 && function in 3..4 && count in 1..125 && address + count <= 65536) { "usb_invalid_request" }
  var checksum = 0xffff
  for (index in 0..5) {
    checksum = checksum xor (bytes[index].toInt() and 0xff)
    repeat(8) { checksum = (checksum ushr 1) xor if ((checksum and 1) != 0) 0xa001 else 0 }
  }
  require((bytes[6].toInt() and 0xff) == (checksum and 0xff) && (bytes[7].toInt() and 0xff) == (checksum ushr 8)) {
    "usb_invalid_request"
  }
  return bytes
}

internal class ModbusRegisterReply {
  private val data = ByteArray(256)
  private var count = 0
  private var rejected = false
  private var expected: Int? = null
  val complete: Boolean get() = !rejected && count == expected
  val finished: Boolean get() = rejected || complete

  fun append(chunk: ByteArray, length: Int) {
    if (length == 0) return
    val copyLength = minOf(length, data.size - count)
    chunk.copyInto(data, count, 0, copyLength)
    count += copyLength
    if (count >= 3 && expected == null) {
      val function = data[1].toInt() and 0xff
      val size = when {
        function in 0x83..0x84 -> 5
        function in 3..4 -> (data[2].toInt() and 0xff) + 5
        else -> null
      }
      expected = size
      if (size == null || size > data.size) rejected = true
    }
    if (length > copyLength || expected?.let { count > it } == true) rejected = true
  }

  fun bytes(): ByteArray = data.copyOf(count)
}

private fun ByteArray.toHex(): String = joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
