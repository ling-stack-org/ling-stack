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
    | "Available"
    | "Checking"
    | "Setup required"
    | "Not enabled"
    | "Unavailable";
  readonly tone: StatusTone;
}

export interface TeammateMcpToolEffectPresentation {
  readonly labelKey:
    | "Confirm before use"
    | "High risk"
    | "Low risk";
  readonly tone: BadgeTone;
}

export function teammateMcpServerStatusPresentation(server: McpServer): TeammateMcpServerStatusPresentation {
  const snapshot = server.statusSnapshot;
  const authKind = snapshot?.authStatus.kind;

  if (!server.enabled || server.status.kind === "disabled" || snapshot?.status === "disabled") {
    return { id: "disabled", labelKey: "Not enabled", tone: "neutral" };
  }
  if (
    server.legacySecretMigrationRequired
    || authKind === "migration_required"
    || snapshot?.status === "migration_required"
  ) {
    return { id: "migration", labelKey: "Setup required", tone: "warning" };
  }
  if (
    authKind === "missing"
    || authKind === "access_denied"
    || authKind === "store_unavailable"
    || authKind === "invalid_ref"
    || server.secretStatuses.some((status) => !status.configured)
  ) {
    return { id: "auth-blocked", labelKey: "Setup required", tone: "warning" };
  }
  if (server.status.kind === "checking") {
    return { id: "checking", labelKey: "Checking", tone: "info" };
  }
  if (server.status.kind === "failed" || snapshot?.status === "failed") {
    return { id: "failed", labelKey: "Unavailable", tone: "danger" };
  }
  if (server.status.kind === "ready" || snapshot?.status === "ready") {
    return { id: "ready", labelKey: "Available", tone: "success" };
  }
  return { id: "needs-check", labelKey: "Setup required", tone: "neutral" };
}

export function teammateMcpToolEffectPresentation(
  sideEffectLevel: McpTool["sideEffectLevel"],
): TeammateMcpToolEffectPresentation {
  if (sideEffectLevel === "none" || sideEffectLevel === "read") {
    return { labelKey: "Low risk", tone: "neutral" };
  }
  if (sideEffectLevel === "credential" || sideEffectLevel === "deploy") {
    return { labelKey: "High risk", tone: "danger" };
  }
  return { labelKey: "Confirm before use", tone: "warning" };
}
