package expo.modules.lingdevicetransport

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class AdbPackageConnectionTest {
  @Test fun streamsTheApkOnceAndReadsFullPackageVersionAndDigest() {
    val bytes = byteArrayOf(7, 8, 9)
    val hash = "6".repeat(64)
    val link = adbLink(
      Packet("OKAY", 11, 1),
      Packet("WRTE", 11, 1, "ling-apk-ready\n".encodeToByteArray()),
      Packet("OKAY", 11, 1),
      Packet("WRTE", 11, 1, "Success\n\nling-apk-result:0\n".encodeToByteArray()),
      Packet("CLSE", 11, 1),
      *stream(2, "package:/data/app/org.example.android/base.apk\n"),
      *stream(3, "Packages:\n  Package [org.example.android] (6):\n    versionCode=4294967338 minSdk=24\n"),
      *stream(4, "$hash  /data/app/org.example.android/base.apk\n"),
    )
    val connection = connect(link)
    assertTrue(connection.install(ByteArrayInputStream(bytes), bytes.size.toLong(), DEADLINE))
    assertEquals(AdbInstalledPackage("4294967338", "sha256:$hash"), connection.installedPackage("org.example.android", DEADLINE))
    val sent = link.sentPackets()
    assertArrayEquals(bytes, sent.single { it.name == "WRTE" }.payload)
    assertEquals(4, sent.count { it.name == "OPEN" })
  }

  @Test fun requiresAdbHostAuthenticationAndDeviceReadyBeforeSendingBytes() {
    val noAuth = ScriptedLink(listOf(connectPacket))
    assertEquals("adb_authorization_required", assertThrows(IOException::class.java) { connect(noAuth) }.message)
    assertFalse(noAuth.sentPackets().any { it.name == "OPEN" })

    val link = adbLink(*stream(1, "Failure [INSTALL_FAILED]\n"))
    val connection = connect(link)
    assertEquals("adb_install_unconfirmed", assertThrows(IOException::class.java) {
      connection.install(ByteArrayInputStream(byteArrayOf(1)), 1, DEADLINE)
    }.message)
    assertFalse(link.sentPackets().any { it.name == "WRTE" })
  }

  @Test fun returnsScopedLogOutputOnlyWhenTheReadCompleted() {
    val log = "fixture line"
    val link = adbLink(
      *stream(1, "$log\n\nling-log-result:0\n"),
      *stream(2, "\nling-log-result:1\n"),
    )
    val connection = connect(link)
    assertThrows(IllegalArgumentException::class.java) { connection.logs("-unscoped", DEADLINE) }
    assertEquals("$log\n", connection.logs("Fixture.App", DEADLINE))
    assertEquals("adb_log_read_failed", assertThrows(IOException::class.java) { connection.logs("Fixture.App", DEADLINE) }.message)
    val commands = link.sentPackets().filter { it.name == "OPEN" }.map { it.payload.decodeToString() }
    assertEquals(2, commands.size)
    assertTrue(commands.all { it.startsWith("exec:logcat -b main -b crash -d -t 200 -v threadtime 'Fixture.App:V' '*:S'") })
  }

  private fun connect(link: ScriptedLink): AdbPackageConnection = AdbPackageConnection(link).apply {
    connect(object : AdbHostAuthentication {
      override fun sign(token: ByteArray) = token.also { assertEquals(20, it.size) }
      override fun publicKey() = error("this fixture uses a previously authorized host key")
    }, DEADLINE)
  }

  private fun adbLink(vararg packets: Packet) =
    ScriptedLink(listOf(Packet("AUTH", 1, 0, ByteArray(20)), connectPacket, *packets))

  private fun stream(id: Int, text: String) = arrayOf(
    Packet("OKAY", 100 + id, id), Packet("WRTE", 100 + id, id, text.encodeToByteArray()), Packet("CLSE", 100 + id, id),
  )

  private data class Packet(val name: String, val first: Int, val second: Int, val payload: ByteArray = ByteArray(0))

  private class ScriptedLink(incoming: List<Packet>) : AdbPackageLink {
    private val peer = ByteArrayInputStream(ByteArrayOutputStream().apply {
      for ((name, first, second, payload) in incoming) {
        val command = ByteBuffer.wrap(name.encodeToByteArray()).order(ByteOrder.LITTLE_ENDIAN).int
        val checksum = payload.sumOf { it.toInt() and 0xff }
        write(ByteBuffer.allocate(24).order(ByteOrder.LITTLE_ENDIAN).putInt(command).putInt(first).putInt(second)
          .putInt(payload.size).putInt(checksum).putInt(command xor -1).array())
        write(payload)
      }
    }.toByteArray())
    private val host = ByteArrayOutputStream()

    override fun readFully(bytes: ByteArray, deadline: Long) {
      if (peer.read(bytes) != bytes.size) throw IOException("ADB fixture reached EOF")
    }
    override fun write(bytes: ByteArray, deadline: Long) { host.write(bytes) }
    override fun close() {}

    fun sentPackets(): List<Packet> {
      val wire = ByteBuffer.wrap(host.toByteArray()).order(ByteOrder.LITTLE_ENDIAN)
      return buildList {
        while (wire.hasRemaining()) {
          val name = ByteArray(4).also(wire::get).decodeToString()
          val first = wire.int
          val second = wire.int
          val length = wire.int
          wire.int
          wire.int
          add(Packet(name, first, second, ByteArray(length).also(wire::get)))
        }
      }
    }
  }

  companion object {
    private const val DEADLINE = 100_000L
    private val connectPacket = Packet("CNXN", 0x01000000, 4096, "device::\u0000".encodeToByteArray())
  }
}
