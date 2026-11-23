package expo.modules.lingdevicetransport

import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.IOException
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

internal interface AdbPackageLink : Closeable {
  fun readFully(bytes: ByteArray, deadline: Long)
  fun write(bytes: ByteArray, deadline: Long)
}

internal interface AdbHostAuthentication {
  fun sign(token: ByteArray): ByteArray
  fun publicKey(): ByteArray
}

internal data class AdbAndroidIdentity(val serial: String, val model: String, val androidVersion: String, val fingerprint: String)

internal data class AdbInstalledPackage(val versionCode: String?, val digest: String?)

/** One USB ADB transport for Android identity, APK deployment and installed-state reads. */
internal class AdbPackageConnection(private val link: AdbPackageLink) : Closeable {
  private var nextStreamId = 0
  private var payloadLimit = MAX_PAYLOAD
  private var authenticated = false

  fun connect(authentication: AdbHostAuthentication, deadline: Long) {
    send(CONNECT, VERSION, MAX_PAYLOAD, "host::\u0000".encodeToByteArray(), deadline)
    var signed = false
    var offeredKey = false
    while (true) {
      val packet = receive(deadline)
      when (packet.command) {
        CONNECT -> {
          protocol(packet.arg0 >= VERSION && packet.arg1 > 0 && packet.payload.decodeToString().startsWith("device:"))
          if (!signed) throw IOException("adb_authorization_required")
          payloadLimit = minOf(packet.arg1, MAX_PAYLOAD)
          authenticated = true
          return
        }
        AUTH -> {
          protocol(packet.arg0 == 1 && packet.arg1 == 0 && packet.payload.size == 20)
          when {
            !signed -> {
              send(AUTH, 2, 0, authentication.sign(packet.payload), deadline)
              signed = true
            }
            !offeredKey -> {
              send(AUTH, 3, 0, authentication.publicKey(), deadline)
              offeredKey = true
            }
            else -> throw IOException("adb_authorization_required")
          }
        }
        else -> throw IOException("adb_protocol_error")
      }
    }
  }

  fun identity(deadline: Long): AdbAndroidIdentity {
    val output = run("getprop ro.serialno; getprop ro.product.model; getprop ro.build.version.release; getprop ro.build.fingerprint", deadline)
    val lines = output.trimEnd('\r', '\n').split('\n').map { it.trimEnd('\r') }
    if (lines.size != 4 || !lines[0].matches(Regex("[A-Za-z0-9][A-Za-z0-9_.-]{0,127}"))
      || !lines[2].matches(Regex("[0-9][A-Za-z0-9.-]{0,31}"))
      || lines[3].isBlank() || lines.any { it.length > 512 || it.any(Char::isISOControl) }) {
      throw IOException("adb_target_identity_unavailable")
    }
    return AdbAndroidIdentity(lines[0], lines[1], lines[2], lines[3])
  }

  fun install(apk: InputStream, size: Long, deadline: Long): Boolean {
    require(size in 1..MAX_APK_BYTES) { "adb_invalid_apk" }
    val ready = "ling-apk-ready\n".encodeToByteArray()
    val command = "printf 'ling-apk-ready\\n'; pm install -r -S " + size +
      " -- - 2>&1; result=\$?; printf '\\nling-apk-result:%s\\n' \"\$result\""
    val stream = open(command, deadline)
    while (!stream.closed && stream.output.size() < ready.size) stream.read(deadline)
    if (!stream.output.toByteArray().contentEquals(ready) || stream.closed) throw IOException("adb_install_unconfirmed")
    val chunk = ByteArray(payloadLimit)
    var remaining = size
    while (remaining > 0) {
      val count = apk.read(chunk, 0, minOf(chunk.size.toLong(), remaining).toInt())
      if (count <= 0) throw IOException("adb_install_unconfirmed")
      stream.write(chunk.copyOf(count), deadline)
      remaining -= count
    }
    while (!stream.closed) stream.read(deadline)
    val lines = stream.output.toString(Charsets.UTF_8.name()).removePrefix("ling-apk-ready\n").trim().lines()
    val receipt = lines.lastOrNull()
    if (receipt == "ling-apk-result:0" && lines.any { it == "Success" }) return true
    if (receipt?.matches(Regex("ling-apk-result:[1-9][0-9]*")) == true && lines.any { it.startsWith("Failure [") }) return false
    throw IOException("adb_install_unconfirmed")
  }

  fun installedPackage(packageId: String, deadline: Long): AdbInstalledPackage? {
    require(packageId.length <= 255 && packageId.matches(Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+"))) { "adb_invalid_apk" }
    val paths = run("pm path " + packageId, deadline).lineSequence().filter { it.startsWith("package:") }.toList()
    if (paths.isEmpty()) return null
    val inventory = run("dumpsys package " + packageId, deadline)
    val packageHeading = "Package [" + packageId + "] ("
    val lines = inventory.lines()
    val start = lines.indexOfFirst { it.trimStart().startsWith(packageHeading) }
    val version = if (start < 0) null else lines.asSequence().drop(start + 1)
      .takeWhile { !it.trimStart().startsWith("Package [") && (it.isBlank() || it.first().isWhitespace()) }
      .mapNotNull { VERSION_CODE.find(it.trimStart())?.groupValues?.get(1) }.firstOrNull()
    val digest = if (paths.size == 1) {
      val path = paths[0].removePrefix("package:")
      if (path.length <= 1024 && path.matches(Regex("/[A-Za-z0-9_./=+~-]+"))) {
        run("sha256sum '" + path + "'", deadline).trim().substringBefore(' ').takeIf { it.matches(Regex("[a-f0-9]{64}")) }
          ?.let { "sha256:" + it }
      } else null
    } else null
    return AdbInstalledPackage(version, digest)
  }

  override fun close() = link.close()

  private fun run(command: String, deadline: Long): String {
    val stream = open(command, deadline)
    while (!stream.closed) stream.read(deadline)
    return stream.output.toString(Charsets.UTF_8.name())
  }

  private fun open(command: String, deadline: Long): AdbStream {
    check(authenticated) { "adb_authorization_required" }
    val id = ++nextStreamId
    send(OPEN, id, 0, ("exec:" + command + "\u0000").encodeToByteArray(), deadline)
    val reply = receive(deadline)
    protocol(reply.command == OKAY && reply.arg0 != 0 && reply.arg1 == id && reply.payload.isEmpty())
    return AdbStream(id, reply.arg0)
  }

  private inner class AdbStream(private val localId: Int, private val remoteId: Int) {
    val output = ByteArrayOutputStream()
    var closed = false
      private set

    fun write(bytes: ByteArray, deadline: Long) {
      if (closed) throw IOException("adb_install_unconfirmed")
      send(WRITE, localId, remoteId, bytes, deadline)
      while (!closed) {
        if (read(deadline) == OKAY) return
      }
      throw IOException("adb_install_unconfirmed")
    }

    fun read(deadline: Long): Int {
      val packet = receive(deadline)
      protocol(packet.arg0 == remoteId && packet.arg1 == localId)
      when (packet.command) {
        WRITE -> {
          protocol(output.size() + packet.payload.size <= MAX_OUTPUT)
          output.write(packet.payload)
          send(OKAY, localId, remoteId, EMPTY, deadline)
        }
        CLOSE -> {
          protocol(packet.payload.isEmpty())
          closed = true
          send(CLOSE, localId, remoteId, EMPTY, deadline)
        }
        OKAY -> protocol(packet.payload.isEmpty())
        else -> throw IOException("adb_protocol_error")
      }
      return packet.command
    }
  }

  private fun send(command: Int, arg0: Int, arg1: Int, payload: ByteArray, deadline: Long) {
    protocol(payload.size <= payloadLimit)
    val header = ByteBuffer.allocate(24).order(ByteOrder.LITTLE_ENDIAN).putInt(command)
      .putInt(arg0).putInt(arg1).putInt(payload.size).putInt(checksum(payload)).putInt(command xor -1).array()
    link.write(header, deadline)
    if (payload.isNotEmpty()) link.write(payload, deadline)
  }

  private fun receive(deadline: Long): Packet {
    val bytes = ByteArray(24)
    link.readFully(bytes, deadline)
    val header = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
    val command = header.int
    val arg0 = header.int
    val arg1 = header.int
    val length = header.int
    val checksum = header.int
    protocol(header.int == (command xor -1) && length in 0..MAX_PAYLOAD)
    val payload = ByteArray(length)
    if (length > 0) link.readFully(payload, deadline)
    protocol(checksum(payload) == checksum)
    return Packet(command, arg0, arg1, payload)
  }

  private data class Packet(val command: Int, val arg0: Int, val arg1: Int, val payload: ByteArray)

  companion object {
    private const val VERSION = 0x01000000
    private const val MAX_PAYLOAD = 4096
    private const val MAX_OUTPUT = 64 * 1024
    internal const val MAX_APK_BYTES = 256L * 1024L * 1024L
    private const val CONNECT = 0x4e584e43
    private const val AUTH = 0x48545541
    private const val OPEN = 0x4e45504f
    private const val OKAY = 0x59414b4f
    private const val WRITE = 0x45545257
    private const val CLOSE = 0x45534c43
    private val EMPTY = ByteArray(0)
    private val VERSION_CODE = Regex("^versionCode=([0-9]{1,19})(?:\\s|$)")

    private fun checksum(bytes: ByteArray) = bytes.sumOf { it.toInt() and 0xff }

    private fun protocol(valid: Boolean) {
      if (!valid) throw IOException("adb_protocol_error")
    }
  }
}
