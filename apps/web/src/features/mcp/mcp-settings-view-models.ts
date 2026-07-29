import type { McpServer, McpServerFormState, McpTool } from "../../types.js";

export type McpSettingsStatusTone = "neutral" | "success" | "warning" | "danger" | "info";
export type McpServerPrimaryAction = "check" | "edit" | "sync";

export interface McpServerStatusPresentation {
  readonly id:
    | "auth-blocked"
    | "checking"
    | "disabled"
    | "failed"
    | "migration"
    | "needs-check"
    | "ready";
  readonly labelKey: string;
  readonly tone: McpSettingsStatusTone;
}

export interface McpDetailItem {
  readonly labelKey: string;
  readonly value: string;
}

export interface McpServerFormErrors {
  readonly argsText?: string;
  readonly command?: string;
  readonly displayName?: string;
  readonly envName?: string;
  readonly envSecretRef?: string;
  readonly form?: string;
  readonly headerName?: string;
  readonly headerSecretRef?: string;
  readonly startupTimeoutSec?: string;
  readonly toolTimeoutSec?: string;
  readonly url?: string;
}

export const defaultMcpServerForm: McpServerFormState = {
  displayName: "",
  serverId: "",
  transportType: "streamable-http",
  command: "",
  argsText: "",
  cwd: "",
  url: "",
  headerName: "",
  headerSecretRef: "",
  bearerTokenRef: "",
  envName: "",
  envSecretRef: "",
  startupTimeoutSec: "30",
  toolTimeoutSec: "60",
  enabled: true,
  required: false,
};

export function groupMcpToolsByServer(tools: readonly McpTool[]): ReadonlyMap<string, readonly McpTool[]> {
  const grouped = new Map<string, McpTool[]>();
  for (const tool of tools) {
    const current = grouped.get(tool.serverId);
    if (current) current.push(tool);
    else grouped.set(tool.serverId, [tool]);
  }
  return grouped;
}

export function mcpServerStatusPresentation(server: McpServer): McpServerStatusPresentation {
  const snapshot = server.statusSnapshot;
  const authKind = snapshot?.authStatus.kind;

  if (!server.enabled || server.status.kind === "disabled" || snapshot?.status === "disabled") {
    return { id: "disabled", labelKey: "Disabled", tone: "neutral" };
  }
  if (
    server.legacySecretMigrationRequired
    || authKind === "migration_required"
    || snapshot?.status === "migration_required"
  ) {
    return { id: "migration", labelKey: "Credential migration required", tone: "warning" };
  }
  if (
    authKind === "missing"
    || authKind === "access_denied"
    || authKind === "store_unavailable"
    || authKind === "invalid_ref"
    || server.secretStatuses.some((status) => !status.configured)
  ) {
    return { id: "auth-blocked", labelKey: "Credential needs attention", tone: "warning" };
  }
  if (server.status.kind === "checking") {
    return { id: "checking", labelKey: "Checking", tone: "info" };
  }
  if (server.status.kind === "failed" || snapshot?.status === "failed") {
    return { id: "failed", labelKey: "Unavailable", tone: "danger" };
  }
  if (snapshot?.status === "ready" || server.status.kind === "ready") {
    return { id: "ready", labelKey: "Ready", tone: "success" };
  }
  return { id: "needs-check", labelKey: "Check needed", tone: "neutral" };
}

export function mcpServerPrimaryAction(server: McpServer): McpServerPrimaryAction {
  const status = mcpServerStatusPresentation(server);
  if (status.id === "disabled" || status.id === "migration" || status.id === "auth-blocked") return "edit";
  if (status.id === "ready") return "sync";
  return "check";
}

export function mcpTransportLabelKey(server: McpServer): string {
  return server.transport.type === "stdio" ? "Local process" : "Remote HTTP";
}

export function mcpServerDetailItems(server: McpServer): readonly McpDetailItem[] {
  const snapshot = server.statusSnapshot;
  const transportDetails: McpDetailItem[] = server.transport.type === "stdio"
    ? [
      { labelKey: "Command", value: server.transport.command },
      { labelKey: "Arguments", value: server.transport.args.join(" ") || "-" },
      { labelKey: "Working directory", value: server.transport.cwd ?? "-" },
      { labelKey: "Environment secret references", value: formatRecord(server.transport.secretEnvRefs) },
    ]
    : [
      { labelKey: "Server URL", value: server.transport.url },
      { labelKey: "Header secret references", value: formatRecord(server.transport.secretHeaderRefs) },
      { labelKey: "Bearer token reference", value: server.transport.bearerTokenRef ?? "-" },
    ];

  return [
    { labelKey: "Server id", value: server.id },
    { labelKey: "Transport", value: server.transport.type },
    ...transportDetails,
    { labelKey: "Startup timeout", value: formatSeconds(server.startupTimeoutSec) },
    { labelKey: "Tool timeout", value: formatSeconds(server.toolTimeoutSec) },
    { labelKey: "Critical dependency", value: server.required ? "Yes" : "No" },
    { labelKey: "Last checked", value: snapshot?.checkedAt ?? server.status.checkedAt ?? "-" },
    { labelKey: "Check expires", value: snapshot?.expiresAt ?? "-" },
    { labelKey: "Latency", value: snapshot?.latencyMs === undefined ? "-" : `${snapshot.latencyMs} ms` },
    { labelKey: "Protocol version", value: snapshot?.protocolVersion ?? "-" },
    { labelKey: "Runtime error code", value: snapshot?.errorCode ?? "-" },
    { labelKey: "Runtime detail", value: snapshot?.message ?? server.status.message ?? "-" },
  ];
}

export function mcpToolDetailItems(tool: McpTool): readonly McpDetailItem[] {
  return [
    { labelKey: "Raw tool name", value: tool.rawName },
    { labelKey: "Callable name", value: `${tool.callableNamespace}.${tool.callableName}` },
    { labelKey: "Side effect", value: tool.sideEffectLevel },
    { labelKey: "Default approval", value: tool.defaultApproval },
    { labelKey: "Enabled", value: tool.enabled ? "Yes" : "No" },
    { labelKey: "First discovered", value: tool.firstSeenAt },
    { labelKey: "Last discovered", value: tool.lastSeenAt },
  ];
}

export function mcpToolEffectLabelKey(sideEffectLevel: McpTool["sideEffectLevel"]): string {
  if (sideEffectLevel === "none") return "No side effects";
  if (sideEffectLevel === "read") return "Read";
  if (sideEffectLevel === "write") return "Write";
  if (sideEffectLevel === "write-network") return "Write network";
  if (sideEffectLevel === "external") return "External action";
  if (sideEffectLevel === "credential") return "Credential";
  if (sideEffectLevel === "deploy") return "Deploy";
  return sideEffectLevel;
}

export function mcpServerToForm(server: McpServer): McpServerFormState {
  if (server.transport.type === "stdio") {
    const envName = Object.keys(server.transport.secretEnvRefs ?? {})[0]
      ?? server.transport.secretEnvNames?.[0]
      ?? "";
    return {
      ...defaultMcpServerForm,
      displayName: server.displayName,
      serverId: server.id,
      transportType: "stdio",
      command: server.transport.command,
      argsText: server.transport.args.join(" "),
      cwd: server.transport.cwd ?? "",
      envName,
      envSecretRef: envName ? (server.transport.secretEnvRefs?.[envName] ?? "") : "",
      enabled: server.enabled,
      required: server.required,
      startupTimeoutSec: server.startupTimeoutSec ? String(server.startupTimeoutSec) : "",
      toolTimeoutSec: server.toolTimeoutSec ? String(server.toolTimeoutSec) : "",
    };
  }

  const headerName = Object.keys(server.transport.secretHeaderRefs ?? {})[0]
    ?? server.transport.secretHeaderNames?.[0]
    ?? "";
  return {
    ...defaultMcpServerForm,
    displayName: server.displayName,
    serverId: server.id,
    transportType: "streamable-http",
    url: server.transport.url,
    headerName,
    headerSecretRef: headerName ? (server.transport.secretHeaderRefs?.[headerName] ?? "") : "",
    bearerTokenRef: server.transport.bearerTokenRef ?? "",
    enabled: server.enabled,
    required: server.required,
    startupTimeoutSec: server.startupTimeoutSec ? String(server.startupTimeoutSec) : "",
    toolTimeoutSec: server.toolTimeoutSec ? String(server.toolTimeoutSec) : "",
  };
}

export function mcpFormHasAuthentication(form: McpServerFormState): boolean {
  return form.transportType === "stdio"
    ? Boolean(form.envName.trim() || form.envSecretRef.trim())
    : Boolean(form.headerName.trim() || form.headerSecretRef.trim() || form.bearerTokenRef.trim());
}

export function validateMcpServerForm(form: McpServerFormState): McpServerFormErrors {
  const errors: Record<string, string> = {};
  if (!form.displayName.trim()) errors.displayName = "Enter a server name.";

  if (form.transportType === "stdio") {
    if (!form.command.trim()) errors.command = "Enter a command for stdio MCP.";
    if (form.envName.trim() && !form.envSecretRef.trim()) errors.envSecretRef = "Enter an env secret ref.";
    if (!form.envName.trim() && form.envSecretRef.trim()) errors.envName = "Enter an env secret name.";
  } else {
    if (!form.url.trim()) {
      errors.url = "Enter an HTTP MCP server URL.";
    } else if (!isHttpUrl(form.url)) {
      errors.url = "Enter a valid HTTP or HTTPS URL.";
    }
    if (form.headerName.trim() && !form.headerSecretRef.trim()) {
      errors.headerSecretRef = "Enter a header secret ref.";
    }
    if (!form.headerName.trim() && form.headerSecretRef.trim()) {
      errors.headerName = "Enter a header name.";
    }
  }

  if (!isOptionalPositiveNumber(form.startupTimeoutSec)) {
    errors.startupTimeoutSec = "Enter a positive timeout.";
  }
  if (!isOptionalPositiveNumber(form.toolTimeoutSec)) {
    errors.toolTimeoutSec = "Enter a positive timeout.";
  }
  if (Object.keys(errors).length > 0) errors.form = "Review the highlighted fields.";
  return errors;
}

export function hasMcpServerFormErrors(errors: McpServerFormErrors): boolean {
  return Object.keys(errors).length > 0;
}

export function changeMcpFormTransport(
  form: McpServerFormState,
  transportType: McpServerFormState["transportType"],
): McpServerFormState {
  if (form.transportType === transportType) return form;
  return transportType === "stdio"
    ? {
      ...form,
      transportType,
      url: "",
      headerName: "",
      headerSecretRef: "",
      bearerTokenRef: "",
    }
    : {
      ...form,
      transportType,
      command: "",
      argsText: "",
      cwd: "",
      envName: "",
      envSecretRef: "",
    };
}

function formatRecord(record: Readonly<Record<string, string>> | undefined): string {
  const entries = Object.entries(record ?? {});
  return entries.length === 0 ? "-" : entries.map(([name, value]) => `${name}: ${value}`).join(", ");
}

function formatSeconds(value: number | undefined): string {
  return value === undefined ? "-" : `${value} s`;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isOptionalPositiveNumber(value: string): boolean {
  if (!value.trim()) return true;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}
