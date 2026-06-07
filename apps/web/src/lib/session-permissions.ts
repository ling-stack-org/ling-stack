import type { ApprovalPolicy, ApprovalPolicyFormState, ApprovalToolDecision, EffectiveRunPolicySnapshot, PermissionPreset, SessionPermissionMode, ToolName } from "../types.js";
import type { Translate } from "../i18n.js";
import { allTools, riskyTools } from "./tools.js";

export const sessionPermissionModeOptions: readonly SessionPermissionMode[] = [
  "ask_everything",
  "balanced",
  "workspace_write",
  "full_access",
  "custom",
];

export const permissionPresetOptions: readonly PermissionPreset[] = [
  "read_only",
  "workspace_collaboration",
  "full_access",
  "custom",
];

const readOnlyTools = allTools.filter((tool) => !riskyTools.includes(tool));

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

export function permissionPresetLabel(preset: PermissionPreset | undefined, t: Translate): string {
  if (preset === "read_only") {
    return t("Read-only / planning");
  }
  if (preset === "workspace_collaboration") {
    return t("Workspace collaboration");
  }
  if (preset === "full_access") {
    return t("Full access");
  }
  return t("Custom");
}

export function permissionPresetDescription(preset: PermissionPreset | undefined, t: Translate): string {
  if (preset === "read_only") {
    return t("Plan, review, and inspect. Risky actions ask before changing the workspace.");
  }
  if (preset === "workspace_collaboration") {
    return t("Allow file edits inside the bound workspace path. Commands and external actions still ask.");
  }
  if (preset === "full_access") {
    return t("Allow broad local access for this run after explicit confirmation.");
  }
  return t("Use the advanced workspace policy from Settings.");
}

export function permissionModeForPreset(preset: PermissionPreset): SessionPermissionMode {
  if (preset === "read_only") {
    return "ask_everything";
  }
  if (preset === "workspace_collaboration") {
    return "workspace_write";
  }
  if (preset === "full_access") {
    return "full_access";
  }
  return "custom";
}

export function inferPermissionPreset(mode: SessionPermissionMode | undefined): PermissionPreset {
  if (mode === "ask_everything") {
    return "read_only";
  }
  if (mode === "workspace_write") {
    return "workspace_collaboration";
  }
  if (mode === "full_access") {
    return "full_access";
  }
  return "custom";
}

export function permissionPresetRequiresConfirmation(preset: PermissionPreset | undefined): boolean {
  return preset === "full_access";
}

export function buildLocalEffectivePolicyPreview(input: {
  readonly policy?: ApprovalPolicy;
  readonly form?: ApprovalPolicyFormState;
  readonly mode: SessionPermissionMode | undefined;
  readonly channelBoundPath?: string;
}): EffectiveRunPolicySnapshot | undefined {
  const policy = input.policy;
  const form = input.form;
  const decisions = form?.toolDecisions ?? policy?.toolDecisions;
  if (!decisions) {
    return undefined;
  }
  const mode = input.mode ?? "custom";
  const riskNotes: EffectiveRunPolicySnapshot["riskNotes"][number][] = [];
  const toolDecisions = applyPermissionModeToToolDecisions(decisions, mode, riskNotes);
  return {
    mode,
    toolDecisions,
    allowedWritePaths: allowedWritePathsForMode(splitLines(form?.allowedWritePathsText) ?? policy?.allowedWritePaths ?? ["."], mode, input.channelBoundPath),
    workspacePolicyUpdatedAt: policy?.updatedAt,
    riskNotes,
  };
}

export function formatToolDecisionGroups(snapshot: EffectiveRunPolicySnapshot | undefined, t: Translate): readonly string[] {
  if (!snapshot) {
    return [];
  }
  const groups = (["allow", "ask", "deny"] as const).map((decision) => {
    const tools = allTools.filter((tool) => snapshot.toolDecisions[tool] === decision);
    if (tools.length === 0) {
      return "";
    }
    const label = decision === "allow" ? t("Allows") : decision === "ask" ? t("Asks") : t("Denies");
    return `${label}: ${tools.join(", ")}`;
  });
  return groups.filter(Boolean);
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

export function readPermissionPresetFromSnapshot(snapshot: unknown): PermissionPreset | undefined {
  const record = readRecord(snapshot);
  const value = typeof record?.permissionPreset === "string" ? record.permissionPreset : undefined;
  return isPermissionPreset(value) ? value : undefined;
}

export function readEffectivePolicySnapshot(snapshot: unknown): EffectiveRunPolicySnapshot | undefined {
  const record = readRecord(snapshot);
  const policy = readRecord(record?.effectivePolicySnapshot);
  const mode = typeof policy?.mode === "string" && isSessionPermissionMode(policy.mode) ? policy.mode : undefined;
  const allowedWritePaths = Array.isArray(policy?.allowedWritePaths)
    ? policy.allowedWritePaths.filter((item): item is string => typeof item === "string")
    : [];
  const riskNotes = Array.isArray(policy?.riskNotes)
    ? policy.riskNotes.flatMap((item): EffectiveRunPolicySnapshot["riskNotes"][number][] => normalizeRiskNote(item))
    : [];
  const toolDecisions = readRecord(policy?.toolDecisions);
  if (!mode || !toolDecisions) {
    return undefined;
  }
  return {
    mode,
    toolDecisions: toolDecisions as EffectiveRunPolicySnapshot["toolDecisions"],
    allowedWritePaths,
    workspacePolicyUpdatedAt: typeof policy?.workspacePolicyUpdatedAt === "string" ? policy.workspacePolicyUpdatedAt : undefined,
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
    ...snapshot.riskNotes.map((note) => note.message),
  ];
}

function isSessionPermissionMode(value: string | undefined): value is SessionPermissionMode {
  return value === "ask_everything" || value === "balanced" || value === "workspace_write" || value === "full_access" || value === "custom";
}

function isPermissionPreset(value: string | undefined): value is PermissionPreset {
  return value === "read_only" || value === "workspace_collaboration" || value === "full_access" || value === "custom";
}

function applyPermissionModeToToolDecisions(
  workspaceDecisions: Readonly<Record<ToolName, ApprovalToolDecision>>,
  mode: SessionPermissionMode,
  riskNotes: EffectiveRunPolicySnapshot["riskNotes"][number][],
): EffectiveRunPolicySnapshot["toolDecisions"] {
  const next: Partial<Record<ToolName, ApprovalToolDecision>> = {};
  for (const tool of allTools) {
    next[tool] = workspaceDecisions[tool] ?? (riskyTools.includes(tool) ? "ask" : "allow");
  }

  if (mode === "custom") {
    return next as EffectiveRunPolicySnapshot["toolDecisions"];
  }

  for (const tool of readOnlyTools) {
    next[tool] = preserveDeny(workspaceDecisions[tool], "allow", tool, riskNotes);
  }

  if (mode === "ask_everything" || mode === "balanced") {
    for (const tool of riskyTools) {
      next[tool] = preserveDeny(workspaceDecisions[tool], "ask", tool, riskNotes);
    }
    return next as EffectiveRunPolicySnapshot["toolDecisions"];
  }

  if (mode === "workspace_write") {
    next.bash = preserveDeny(workspaceDecisions.bash, "ask", "bash", riskNotes);
    next.edit = preserveDeny(workspaceDecisions.edit, "allow", "edit", riskNotes);
    next.write = preserveDeny(workspaceDecisions.write, "allow", "write", riskNotes);
    return next as EffectiveRunPolicySnapshot["toolDecisions"];
  }

  for (const tool of riskyTools) {
    next[tool] = preserveDeny(workspaceDecisions[tool], "allow", tool, riskNotes);
  }
  return next as EffectiveRunPolicySnapshot["toolDecisions"];
}

function allowedWritePathsForMode(
  workspaceAllowedWritePaths: readonly string[],
  mode: SessionPermissionMode,
  channelBoundPath: string | undefined,
): readonly string[] {
  if (mode === "full_access") {
    return ["/"];
  }
  if (mode === "workspace_write") {
    return [channelBoundPath?.trim() || "."];
  }
  return workspaceAllowedWritePaths.length > 0 ? workspaceAllowedWritePaths : ["."];
}

function preserveDeny(
  workspaceDecision: ApprovalToolDecision | undefined,
  requestedDecision: ApprovalToolDecision,
  tool: ToolName,
  riskNotes: EffectiveRunPolicySnapshot["riskNotes"][number][],
): ApprovalToolDecision {
  if (workspaceDecision === "deny") {
    riskNotes.push({
      code: "session_mode_denied_by_workspace_policy",
      message: `Session permission mode requested ${tool}, but workspace policy denied it.`,
      tool,
    });
    return "deny";
  }
  return requestedDecision;
}

function splitLines(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function normalizeRiskNote(value: unknown): EffectiveRunPolicySnapshot["riskNotes"][number][] {
  if (typeof value === "string") {
    return [{ code: "legacy_risk_note", message: value }];
  }
  const record = readRecord(value);
  if (!record || typeof record.message !== "string") {
    return [];
  }
  return [{
    code: typeof record.code === "string" ? record.code : "risk_note",
    message: record.message,
    tool: typeof record.tool === "string" ? record.tool as EffectiveRunPolicySnapshot["riskNotes"][number]["tool"] : undefined,
  }];
}
