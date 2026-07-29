import { resolveSessionRunPolicy } from "@ling-stack/core/session-permissions";
import type {
  AiTeammate,
  ApprovalActionType,
  ApprovalPolicy,
  ApprovalToolDecision,
  AuthorizationMode,
  PermissionPreset,
  SessionPermissionMode,
  ToolName,
  WorkspaceAccessMode,
} from "../../types.js";
import { resolveAuthorizationMode, resolveWorkspaceAccessMode } from "../../lib/conversation-authorization.js";

const canonicalTools = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const satisfies readonly ToolName[];

const toolLabelKeys: Readonly<Record<ToolName, string>> = {
  read: "Read files",
  grep: "Search file contents",
  find: "Find files",
  ls: "List folders",
  bash: "Run commands",
  edit: "Edit files",
  write: "Write files",
};

const actionLabelKeys: Readonly<Record<ApprovalActionType, string>> = {
  read: "Read files",
  grep: "Search file contents",
  find: "Find files",
  ls: "List folders",
  write: "Write files",
  edit: "Edit files",
  bash: "Run commands",
  git_commit: "Create Git commits",
  git_push: "Push Git changes",
  external_send: "Send externally",
  deploy: "Deploy",
  media_cost: "Paid media generation",
  credential_change: "Change credentials",
  provider_change: "Change model provider",
  workflow_step: "Run workflow steps",
  mcp_tool_call: "Call MCP tools",
  runtime_permission_request: "Request runtime permissions",
};

export type TeammatePermissionTone = "neutral" | "info" | "warning" | "danger" | "success";

export interface TeammatePermissionToolViewModel {
  readonly id: ToolName;
  readonly labelKey: string;
  readonly impactLabelKey: string;
}

export interface TeammatePermissionRequirementViewModel {
  readonly id: string;
  readonly labelKey: string;
}

export interface TeammatePermissionDecisionViewModel extends TeammatePermissionToolViewModel {
  readonly decision: ApprovalToolDecision;
  readonly decisionLabelKey: string;
  readonly decisionTone: TeammatePermissionTone;
}

export interface TeammatePermissionsViewModel {
  readonly managed: boolean;
  readonly statusLabelKey: string;
  readonly statusTone: TeammatePermissionTone;
  readonly toolCount: number;
  readonly totalToolCount: number;
  readonly tools: readonly TeammatePermissionToolViewModel[];
  readonly rawToolIds: readonly ToolName[];
  readonly approval: {
    readonly labelKey: string;
    readonly summaryKey: string;
    readonly tone: TeammatePermissionTone;
  };
  readonly requiredTools: readonly TeammatePermissionRequirementViewModel[];
  readonly requiredActions: readonly TeammatePermissionRequirementViewModel[];
  readonly workspace: {
    readonly available: boolean;
    readonly authorizationLabelKey: string;
    readonly authorizationTone: TeammatePermissionTone;
    readonly accessLabelKey: string;
    readonly accessTone: TeammatePermissionTone;
    readonly toolDecisions: readonly TeammatePermissionDecisionViewModel[];
    readonly deniedToolLabelKeys: readonly string[];
    readonly decisionCounts: Readonly<Record<ApprovalToolDecision, number>>;
  };
}

export function buildTeammatePermissionsViewModel(input: {
  readonly teammate: AiTeammate;
  readonly workspaceDefaultsAvailable: boolean;
  readonly defaultAuthorizationMode?: AuthorizationMode;
  readonly defaultWorkspaceAccessMode?: WorkspaceAccessMode;
  readonly defaultPermissionMode?: SessionPermissionMode;
  readonly defaultPermissionPreset?: PermissionPreset;
  readonly workspacePolicy?: ApprovalPolicy;
}): TeammatePermissionsViewModel {
  const managed = Boolean(
    input.teammate.protectedProfile ||
    input.teammate.kind === "system_teammate" ||
    input.teammate.systemRole === "ling_agent",
  );
  const allowed = new Set(input.teammate.allowedTools);
  const tools = canonicalTools
    .filter((tool) => allowed.has(tool))
    .map((tool): TeammatePermissionToolViewModel => ({
      id: tool,
      labelKey: toolLabelKeys[tool],
      impactLabelKey: isReadOnlyTool(tool) ? "Read-only capability" : "Workspace-changing capability",
    }));
  const approval = approvalProjection(input.teammate.approvalProfile.mode, input.teammate.approvalProfile.risk);
  const authorizationMode = resolveAuthorizationMode(
    input.defaultAuthorizationMode,
    input.defaultPermissionMode,
    input.defaultPermissionPreset,
  );
  const workspaceAccessMode = resolveWorkspaceAccessMode(
    input.defaultWorkspaceAccessMode,
    input.defaultPermissionMode,
    input.defaultPermissionPreset,
  );
  const effectivePolicy = input.workspacePolicy
    ? resolveSessionRunPolicy({
        workspacePolicy: input.workspacePolicy,
        authorizationMode,
        workspaceAccessMode,
        permissionMode: input.defaultPermissionMode,
        permissionPreset: input.defaultPermissionPreset,
        approvalProfile: input.teammate.approvalProfile,
      }).snapshot
    : undefined;
  const workspaceToolDecisions = tools.flatMap((tool): TeammatePermissionDecisionViewModel[] => {
    const decision = effectivePolicy?.toolDecisions[tool.id];
    return decision ? [{
      ...tool,
      decision,
      ...decisionProjection(decision),
    }] : [];
  });
  const decisionCounts = workspaceToolDecisions.reduce<Record<ApprovalToolDecision, number>>(
    (counts, tool) => ({ ...counts, [tool.decision]: counts[tool.decision] + 1 }),
    { allow: 0, ask: 0, deny: 0 },
  );

  return {
    managed,
    statusLabelKey: managed ? "Managed by Ling Stack" : "Read-only permission summary",
    statusTone: managed ? "info" : "neutral",
    toolCount: tools.length,
    totalToolCount: canonicalTools.length,
    tools,
    rawToolIds: canonicalTools.filter((tool) => allowed.has(tool)),
    approval,
    requiredTools: (input.teammate.approvalProfile.requiredForTools ?? []).map((tool) => ({
      id: tool,
      labelKey: toolLabelKeys[tool],
    })),
    requiredActions: (input.teammate.approvalProfile.requiredForActions ?? []).map((action) => ({
      id: action,
      labelKey: actionLabelKeys[action],
    })),
    workspace: {
      available: input.workspaceDefaultsAvailable,
      authorizationLabelKey: authorizationLabelKey(authorizationMode),
      authorizationTone: authorizationMode === "smart" ? "info" : "neutral",
      accessLabelKey: workspaceAccessLabelKey(workspaceAccessMode),
      accessTone: workspaceAccessMode === "full_access" ? "warning" : workspaceAccessMode === "workspace_write" ? "info" : "neutral",
      toolDecisions: workspaceToolDecisions,
      deniedToolLabelKeys: workspaceToolDecisions.filter((tool) => tool.decision === "deny").map((tool) => tool.labelKey),
      decisionCounts,
    },
  };
}

function approvalProjection(
  mode: AiTeammate["approvalProfile"]["mode"],
  risk: AiTeammate["approvalProfile"]["risk"],
): TeammatePermissionsViewModel["approval"] {
  if (mode === "none") {
    return {
      labelKey: "No additional teammate approval",
      summaryKey: "Workspace authorization still applies.",
      tone: "neutral",
    };
  }
  const riskLabel = risk === "critical"
    ? "Critical risk threshold"
    : risk === "high"
      ? "High risk threshold"
      : risk === "medium"
        ? "Medium risk threshold"
        : risk === "low"
          ? "Low risk threshold"
          : "No additional risk threshold";
  return {
    labelKey: mode === "strict" ? "Strict approval" : "Standard approval",
    summaryKey: riskLabel,
    tone: mode === "strict" || risk === "critical" || risk === "high" ? "warning" : "info",
  };
}

function authorizationLabelKey(mode: AuthorizationMode): string {
  if (mode === "ask") return "Ask first";
  if (mode === "always") return "Always authorize";
  return "Smart authorization";
}

function workspaceAccessLabelKey(mode: WorkspaceAccessMode): string {
  if (mode === "read_only") return "Read only";
  if (mode === "full_access") return "Full access";
  return "Workspace write";
}

function decisionProjection(decision: ApprovalToolDecision): Pick<
  TeammatePermissionDecisionViewModel,
  "decisionLabelKey" | "decisionTone"
> {
  if (decision === "deny") {
    return { decisionLabelKey: "Denied by workspace", decisionTone: "warning" };
  }
  if (decision === "ask") {
    return { decisionLabelKey: "Workspace approval required", decisionTone: "info" };
  }
  return { decisionLabelKey: "Allowed by workspace", decisionTone: "neutral" };
}

function isReadOnlyTool(tool: ToolName): boolean {
  return tool === "read" || tool === "grep" || tool === "find" || tool === "ls";
}
