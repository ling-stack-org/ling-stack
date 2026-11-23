import { lingDeviceTransport } from "../../modules/ling-device-transport";
import type { OpenLinuxSshConnection } from "../device/linux-ssh";

const module = lingDeviceTransport;

export const openNativeLinuxSsh: OpenLinuxSshConnection | undefined = module
  ? async (target, fingerprintHex, password, signal) => {
    if (signal?.aborted) throw new Error("ssh_session_closed");
    const sessionId = module.reserve();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      signal?.removeEventListener("abort", close);
      module.close(sessionId);
    };
    signal?.addEventListener("abort", close, { once: true });
    try {
      if (signal?.aborted) throw new Error("ssh_session_closed");
      await module.connect(sessionId, target.host, target.port, target.username, fingerprintHex, password);
      if (closed) throw new Error("ssh_session_closed");
      return {
        async read(operation, argument = "") {
          if (closed) throw new Error("ssh_session_closed");
          return await module.read(sessionId, operation, argument);
        },
        close,
      };
    } catch (error) {
      close();
      throw error;
    }
  }
  : undefined;
