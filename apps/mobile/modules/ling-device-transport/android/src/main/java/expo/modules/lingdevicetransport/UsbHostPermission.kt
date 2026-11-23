package expo.modules.lingdevicetransport

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

internal class UsbHostPermission(private val context: Context) {
  val manager: UsbManager? = context.getSystemService(UsbManager::class.java)
  private val requesting = AtomicBoolean()

  suspend fun request(device: UsbDevice) {
    val usb = manager ?: error("usb_target_missing")
    if (usb.hasPermission(device)) return
    check(requesting.compareAndSet(false, true)) { "usb_target_busy" }
    try {
      val reply = CompletableDeferred<Unit>()
      val action = context.packageName + ".USB_DEVICE_PERMISSION." + UUID.randomUUID()
      val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
          if (intent.action == action) reply.complete(Unit)
        }
      }
      val callback = PendingIntent.getBroadcast(
        context, 0, Intent(action).setPackage(context.packageName), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_ONE_SHOT,
      )
      val answered = try {
        ContextCompat.registerReceiver(context, receiver, IntentFilter(action), ContextCompat.RECEIVER_NOT_EXPORTED)
        try {
          usb.requestPermission(device, callback)
          withTimeoutOrNull(45_000) { reply.await() }
        } finally {
          context.unregisterReceiver(receiver)
        }
      } finally {
        callback.cancel()
      }
      check(answered != null && usb.hasPermission(device)) { "usb_permission_denied" }
    } finally {
      requesting.set(false)
    }
  }
}
