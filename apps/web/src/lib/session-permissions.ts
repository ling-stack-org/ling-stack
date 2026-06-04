import type { EffectiveRunPolicySnapshot, SessionPermissionMode } from "../types.js";
import type { Translate } from "../i18n.js";

export const sessionPermissionModeOptions: readonly SessionPermissionMode[] = [
  "ask_everything",
  "balanced",
  "workspace_write",
  "full_access",
  "custom",
];

export function sessionPermissionModeLabel(mode: SessionPermissionMode | undefined, t: Translate): string {
  if (mode === "ask_everything") {
    return t("Request approval");
  }
  if (mode === "workspace_write") {
    return t("Workspace write");
  }
  if (mode === "full_access") {
    return t("Full access");
  }
  if (mode === "custom") {
    return t("Custom");
  }
  return t("Auto");
}

export function sessionPermissionModeDescription(mode: SessionPermissionMode | undefined, t: Translate): string {
  if (mode === "ask_everything") {
    return t("Ask before file writes, commands, MCP tools, and external actions.");
  }
  if (mode === "workspace_write") {
    return t("Allow edits inside this channel path; ask before higher-risk actions.");
  }
  if (mode === "full_access") {
    return t("Allow broad file, network, and tool access after confirmation.");
  }
  if (mode === "custom") {
    return t("Use the workspace policy from Settings.");
  }
  return t("Allow read and low-risk actions; ask before high-risk changes.");
}

export function readSessionPermissionModeFromSnapshot(snapshot: unknown): SessionPermissionMode | undefined {
  const record = readRecord(snapshot);
  const value = typeof record?.permissionMode === "string" ? record.permissionMode : undefined;
  return isSessionPermissionMode(value) ? value : undefined;
}

export function readEffectivePolicySnapshot(snapshot: unknown): EffectiveRunPolicySnapshot | undefined {
  const record = readRecord(snapshot);
  const policy = readRecord(record?.effectivePolicySnapshot);
  const mode = typeof policy?.mode === "string" && isSessionPermissionMode(policy.mode) ? policy.mode : undefined;
  const allowedWritePaths = Array.isArray(policy?.allowedWritePaths)
    ? policy.allowedWritePaths.filter((item): item is string => typeof item === "string")
    : [];
  const riskNotes = Array.isArray(policy?.riskNotes)
    ? policy.riskNotes.filter((item): item is string => typeof item === "string")
    : [];
  const toolDecisions = readRecord(policy?.toolDecisions);
  if (!mode || !toolDecisions) {
    return undefined;
  }
  return {
    mode,
    toolDecisions: toolDecisions as EffectiveRunPolicySnapshot["toolDecisions"],
    allowedWritePaths,
    riskNotes,
  };
}

export function summarizeEffectivePolicySnapshot(snapshot: EffectiveRunPolicySnapshot | undefined, t: Translate): readonly string[] {
  if (!snapshot) {
    return [t("Using current workspace policy.")];
  }
  const askCount = Object.values(snapshot.toolDecisions).filter((decision) => decision === "ask").length;
  const denyCount = Object.values(snapshot.toolDecisions).filter((decision) => decision === "deny").length;
  return [
    t("Write scope: {paths}", { paths: snapshot.allowedWritePaths.length > 0 ? snapshot.allowedWritePaths.join(", ") : t("workspace policy") }),
    t("{count} operations ask for approval", { count: askCount }),
    t("{count} operations are blocked by policy", { count: denyCount }),
  ];
}

function isSessionPermissionMode(value: string | undefined): value is SessionPermissionMode {
  return value === "ask_everything" || value === "balanced" || value === "workspace_write" || value === "full_access" || value === "custom";
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
