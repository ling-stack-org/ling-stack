import { ExecutionEngineManagementClient } from "@ling-stack/api-client";
import type { DesktopExecutionEngineCapabilities } from "../../../../../desktop/shared/desktop-capabilities.js";
import type { EngineManagementTransport } from "./execution-engine-manager.js";

export function createEngineManagementTransport(options: {
  readonly baseUrl: string;
  readonly desktop?: { readonly daemonBaseUrl: string; readonly executionEngines?: DesktopExecutionEngineCapabilities };
}): EngineManagementTransport {
  if (options.desktop) {
    return options.desktop.executionEngines && options.desktop.daemonBaseUrl === options.baseUrl
      ? { kind: "desktop", api: options.desktop.executionEngines }
      : { kind: "unavailable", code: "engine_host_authority_unavailable" };
  }
  try {
    const client = new ExecutionEngineManagementClient({ baseUrl: options.baseUrl });
    return { kind: "web", api: client, enroll: (code) => client.enroll(code), revoke: () => client.revokeSession() };
  } catch {
    return { kind: "unavailable", code: "engine_host_must_be_local" };
  }
}
