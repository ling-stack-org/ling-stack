import { inspectAcpConnection } from "./acp-connection.js";

export function inspectKimiConnection(options: Omit<Parameters<typeof inspectAcpConnection>[0], "engineId">) {
  return inspectAcpConnection({ ...options, engineId: "kimi-acp" });
}
