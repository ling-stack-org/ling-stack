import type { McpServerFormState, McpServerMutationRequest } from "../types.js";
import { splitShellishArgs } from "./shared.js";

export function mcpServerFormToPayload(form: McpServerFormState): McpServerMutationRequest {
  return {
    id: form.serverId.trim() || undefined,
    displayName: form.displayName.trim(),
    transport: form.transportType === "stdio"
      ? {
        type: "stdio",
        command: form.command.trim(),
        args: splitShellishArgs(form.argsText),
        cwd: form.cwd.trim() || undefined,
        env: {},
        secretEnvRefs: form.envName.trim() && form.envSecretRef.trim()
          ? { [form.envName.trim()]: form.envSecretRef.trim() }
          : {},
      }
      : {
        type: "streamable-http",
        url: form.url.trim(),
        headers: {},
        secretHeaderRefs: form.headerName.trim() && form.headerSecretRef.trim()
          ? { [form.headerName.trim()]: form.headerSecretRef.trim() }
          : {},
        bearerTokenRef: form.bearerTokenRef.trim() || undefined,
      },
    enabled: form.enabled,
    required: form.required,
    startupTimeoutSec: form.startupTimeoutSec ? Number(form.startupTimeoutSec) : undefined,
    toolTimeoutSec: form.toolTimeoutSec ? Number(form.toolTimeoutSec) : undefined,
  };
}
