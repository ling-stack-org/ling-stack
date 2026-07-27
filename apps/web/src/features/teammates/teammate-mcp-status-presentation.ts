import type { BadgeTone, StatusTone } from "../../shared/ui/index.js";
import type { McpServer, McpTool } from "../../types.js";

export interface TeammateMcpServerStatusPresentation {
  readonly id:
    | "auth-blocked"
    | "checking"
    | "disabled"
    | "failed"
    | "migration"
    | "needs-check"
    | "ready";
  readonly labelKey:
    | "Check needed"
    | "Checking"
    | "Credential migration required"
    | "Credential needs attention"
    | "Disabled"
    | "Ready"
    | "Unavailable";
  readonly tone: StatusTone;
}

export interface TeammateMcpToolEffectPresentation {
  readonly labelKey:
    | "Credential"
    | "Deploy"
    | "External action"
    | "No side effects"
    | "Read"
    | "Write"
    | "Write network";
  readonly tone: BadgeTone;
}

export function teammateMcpServerStatusPresentation(server: McpServer): TeammateMcpServerStatusPresentation {
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
  if (server.status.kind === "ready" || snapshot?.status === "ready") {
    return { id: "ready", labelKey: "Ready", tone: "success" };
  }
  return { id: "needs-check", labelKey: "Check needed", tone: "neutral" };
}

export function teammateMcpToolEffectPresentation(
  sideEffectLevel: McpTool["sideEffectLevel"],
): TeammateMcpToolEffectPresentation {
  if (sideEffectLevel === "none") return { labelKey: "No side effects", tone: "neutral" };
  if (sideEffectLevel === "read") return { labelKey: "Read", tone: "neutral" };
  if (sideEffectLevel === "write") return { labelKey: "Write", tone: "warning" };
  if (sideEffectLevel === "write-network") return { labelKey: "Write network", tone: "warning" };
  if (sideEffectLevel === "external") return { labelKey: "External action", tone: "warning" };
  if (sideEffectLevel === "credential") return { labelKey: "Credential", tone: "danger" };
  return { labelKey: "Deploy", tone: "danger" };
}
