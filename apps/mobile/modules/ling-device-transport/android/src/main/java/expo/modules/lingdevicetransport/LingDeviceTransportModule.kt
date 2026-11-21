package expo.modules.lingdevicetransport

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

class LingDeviceTransportModule : Module() {
  private val sessions = ConcurrentHashMap<String, PinnedSshSession>()

  override fun definition() = ModuleDefinition {
    Name("LingDeviceTransport")

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

    OnDestroy {
      for (session in sessions.values) session.close()
      sessions.clear()
    }
  }

  private fun requireSession(id: String): PinnedSshSession = sessions[id] ?: error("ssh_session_closed")
}
