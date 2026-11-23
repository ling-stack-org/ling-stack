package expo.modules.lingdevicetransport

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class UsbModbusFrameTest {
  @Test
  fun validatesReadRequestBeforeOpeningSerialPort() {
    val request = byteArrayOf(1, 3, 0, 0, 0, 1, 0x84.toByte(), 0x0a)
    assertArrayEquals(request, decodeRegisterRead("010300000001840a"))
    assertThrows(IllegalArgumentException::class.java) { decodeRegisterRead("010300000001840b") }
    assertThrows(IllegalArgumentException::class.java) { decodeRegisterRead("010600000001480a") }
    assertThrows(IllegalArgumentException::class.java) { decodeRegisterRead("01030000000045ca") }
  }

  @Test
  fun framesFragmentedReadAndExceptionReplies() {
    val response = byteArrayOf(1, 3, 2, 0, 10, 0x38, 0x43)
    val reply = ModbusRegisterReply()
    reply.append(response.copyOfRange(0, 2), 2)
    assertFalse(reply.finished)
    reply.append(response.copyOfRange(2, 7), 5)
    assertTrue(reply.complete)
    assertArrayEquals(response, reply.bytes())

    val exception = ModbusRegisterReply()
    exception.append(byteArrayOf(1, 0x83.toByte(), 2, 0xc0.toByte(), 0xf1.toByte()), 5)
    assertTrue(exception.complete)
  }

  @Test
  fun preservesPartialBytesAndRejectsOverlongReplies() {
    val reply = ModbusRegisterReply()
    val header = byteArrayOf(1, 4, 2)
    reply.append(header, header.size)
    assertFalse(reply.complete)
    assertArrayEquals(header, reply.bytes())
    reply.append(ByteArray(512), 512)
    assertTrue(reply.finished)
    assertFalse(reply.complete)
    assertTrue(reply.bytes().size == 256)
  }
}
