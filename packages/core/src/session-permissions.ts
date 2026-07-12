import {
  defaultApprovalToolDecisions,
  readOnlyRunTools,
  riskyRunTools,
  type ApprovalPolicy,
  type ApprovalToolDecision,
  type ApprovalToolDecisions,
  type RunTool,
} from "./approval-policy.js";
import type { ConversationModeKind } from "./run-types.js";
import type { SkillApprovalProfile } from "./skill-types.js";

const runTools = [...readOnlyRunTools, ...riskyRunTools] as const satisfies readonly RunTool[];

export const sessionPermissionModes = [
  "ask_everything",
  "balanced",
  "workspace_write",
  "full_access",
  "custom",
] as const;

export type SessionPermissionMode = (typeof sessionPermissionModes)[number];

export const permissionPresets = [
  "read_only",
  "workspace_collaboration",
  "full_access",
  "custom",
] as const;

export type PermissionPreset = (typeof permissionPresets)[number];

export const authorizationModes = ["ask", "smart", "always"] as const;

export type AuthorizationMode = (typeof authorizationModes)[number];

export const workspaceAccessModes = ["read_only", "workspace_write", "full_access"] as const;

export type WorkspaceAccessMode = (typeof workspaceAccessModes)[number];

export const defaultAuthorizationMode: AuthorizationMode = "smart";

export const defaultWorkspaceAccessMode: WorkspaceAccessMode = "workspace_write";

export const workModes = ["coding", "daily"] as const;

export type WorkMode = (typeof workModes)[number];

export interface PermissionPresetDefinition {
  readonly preset: PermissionPreset;
  readonly permissionMode: SessionPermissionMode;
  readonly requiresConfirmation: boolean;
}

export const permissionPresetDefinitions: readonly PermissionPresetDefinition[] = [
  { preset: "read_only", permissionMode: "ask_everything", requiresConfirmation: false },
  { preset: "workspace_collaboration", permissionMode: "workspace_write", requiresConfirmation: false },
  { preset: "full_access", permissionMode: "full_access", requiresConfirmation: true },
  { preset: "custom", permissionMode: "custom", requiresConfirmation: false },
];

export interface PermissionConfirmation {
  readonly mode: "full_access";
  readonly confirmed: true;
  readonly confirmedAt: string;
  readonly reason: string;
}

export interface EffectiveRunPolicyRiskNote {
  readonly code: string;
  readonly message: string;
  readonly tool?: RunTool;
}

export interface EffectiveRunPolicySnapshot {
  readonly mode: SessionPermissionMode;
  readonly authorizationMode?: AuthorizationMode;
  readonly workspaceAccessMode?: WorkspaceAccessMode;
  readonly conversationMode?: ConversationModeKind;
  readonly planModeMutationPolicy?: "deny_repo_tracked_mutation";
  readonly toolDecisions: ApprovalToolDecisions;
  readonly allowedWritePaths: readonly string[];
  readonly workspacePolicyUpdatedAt: string;
  readonly riskNotes: readonly EffectiveRunPolicyRiskNote[];
}

export function applyConversationModeToEffectiveRunPolicySnapshot(
  snapshot: EffectiveRunPolicySnapshot,
  conversationMode: ConversationModeKind | undefined,
): EffectiveRunPolicySnapshot {
  if (!conversationMode || conversationMode === "default") {
    return {
      ...snapshot,
      conversationMode: conversationMode ?? snapshot.conversationMode,
    };
  }
  return {
    ...snapshot,
    conversationMode,
    planModeMutationPolicy: "deny_repo_tracked_mutation",
    riskNotes: [
      ...snapshot.riskNotes,
      {
        code: "plan_mode_mutation_policy",
        message: "Plan Mode is active; repository mutation is denied until the user exits Plan Mode or accepts a plan for implementation.",
      },
    ],
  };
}

export interface ResolveSessionRunPolicyInput {
  readonly workspacePolicy: ApprovalPolicy;
  readonly authorizationMode?: AuthorizationMode;
  readonly workspaceAccessMode?: WorkspaceAccessMode;
  readonly permissionPreset?: PermissionPreset;
  readonly permissionMode?: SessionPermissionMode;
  readonly channelBoundPath?: string;
  readonly approvalProfile?: SkillApprovalProfile;
}

export interface ResolveSessionRunPolicyResult {
  readonly approvalPolicy: ApprovalPolicy;
  readonly snapshot: EffectiveRunPolicySnapshot;
}

export function isSessionPermissionMode(value: string): value is SessionPermissionMode {
  return (sessionPermissionModes as readonly string[]).includes(value);
}

export function isPermissionPreset(value: string): value is PermissionPreset {
  return (permissionPresets as readonly string[]).includes(value);
}

export function isAuthorizationMode(value: string): value is AuthorizationMode {
  return (authorizationModes as readonly string[]).includes(value);
}

export function isWorkspaceAccessMode(value: string): value is WorkspaceAccessMode {
  return (workspaceAccessModes as readonly string[]).includes(value);
}

export function permissionModeForPreset(preset: PermissionPreset): SessionPermissionMode {
  return permissionPresetDefinitions.find((definition) => definition.preset === preset)?.permissionMode ?? "custom";
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

export function permissionPresetRequiresConfirmation(preset: PermissionPreset): boolean {
  return permissionPresetDefinitions.find((definition) => definition.preset === preset)?.requiresConfirmation ?? false;
}

export function workspaceAccessModeRequiresConfirmation(mode: WorkspaceAccessMode | undefined): boolean {
  return mode === "full_access";
}

export interface AuthorizationAndAccessSelection {
  readonly authorizationMode: AuthorizationMode;
  readonly workspaceAccessMode: WorkspaceAccessMode;
}

export function authorizationAndAccessFromLegacyPermission(
  permissionMode: SessionPermissionMode | undefined,
  permissionPreset: PermissionPreset | undefined,
): AuthorizationAndAccessSelection {
  if (
    (permissionMode === "full_access" && (permissionPreset === undefined || permissionPreset === "full_access")) ||
    (permissionMode === undefined && permissionPreset === "full_access")
  ) {
    return { authorizationMode: "always", workspaceAccessMode: "full_access" };
  }
  if (
    (permissionMode === "ask_everything" && (permissionPreset === undefined || permissionPreset === "read_only")) ||
    (permissionMode === undefined && permissionPreset === "read_only")
  ) {
    return { authorizationMode: "ask", workspaceAccessMode: "read_only" };
  }
  if (
    ((permissionMode === "workspace_write" || permissionMode === "balanced") &&
      (permissionPreset === undefined || permissionPreset === "workspace_collaboration")) ||
    (permissionMode === undefined && permissionPreset === "workspace_collaboration")
  ) {
    return { authorizationMode: "smart", workspaceAccessMode: "workspace_write" };
  }
  return {
    authorizationMode: defaultAuthorizationMode,
    workspaceAccessMode: defaultWorkspaceAccessMode,
  };
}

export function legacyPermissionFromAuthorizationAndAccess(
  authorizationMode: AuthorizationMode,
  workspaceAccessMode: WorkspaceAccessMode,
): { readonly permissionMode: SessionPermissionMode; readonly permissionPreset: PermissionPreset } {
  if (authorizationMode === "ask" && workspaceAccessMode === "read_only") {
    return { permissionMode: "ask_everything", permissionPreset: "read_only" };
  }
  if (authorizationMode === "smart" && workspaceAccessMode === "workspace_write") {
    return { permissionMode: "workspace_write", permissionPreset: "workspace_collaboration" };
  }
  if (authorizationMode === "always" && workspaceAccessMode === "full_access") {
    return { permissionMode: "full_access", permissionPreset: "full_access" };
  }
  return { permissionMode: "custom", permissionPreset: "custom" };
}

export function resolveSessionRunPolicy(input: ResolveSessionRunPolicyInput): ResolveSessionRunPolicyResult {
  if (input.authorizationMode !== undefined || input.workspaceAccessMode !== undefined) {
    return resolveIndependentSessionRunPolicy(input);
  }
  const mode = input.permissionMode ?? "custom";
  const selection = authorizationAndAccessFromLegacyPermission(mode, input.permissionPreset);
  const riskNotes: EffectiveRunPolicyRiskNote[] = [];
  const toolDecisions = applyPermissionModeToToolDecisions(input.workspacePolicy.toolDecisions, mode, riskNotes);
  const profiledDecisions = applyApprovalProfileToToolDecisions(toolDecisions, input.approvalProfile, riskNotes);
  const allowedWritePaths = allowedWritePathsForMode(input.workspacePolicy.allowedWritePaths, mode, input.channelBoundPath);

  const approvalPolicy: ApprovalPolicy = {
    ...input.workspacePolicy,
    toolDecisions: profiledDecisions,
    allowedWritePaths,
  };

  return {
    approvalPolicy,
    snapshot: {
      mode,
      authorizationMode: selection.authorizationMode,
      workspaceAccessMode: selection.workspaceAccessMode,
      toolDecisions: profiledDecisions,
      allowedWritePaths,
      workspacePolicyUpdatedAt: input.workspacePolicy.updatedAt,
      riskNotes,
    },
  };
}

function resolveIndependentSessionRunPolicy(input: ResolveSessionRunPolicyInput): ResolveSessionRunPolicyResult {
  const legacySelection = authorizationAndAccessFromLegacyPermission(input.permissionMode, input.permissionPreset);
  const authorizationMode = input.authorizationMode ?? legacySelection.authorizationMode;
  const workspaceAccessMode = input.workspaceAccessMode ?? legacySelection.workspaceAccessMode;
  const legacyProjection = legacyPermissionFromAuthorizationAndAccess(authorizationMode, workspaceAccessMode);
  const riskNotes: EffectiveRunPolicyRiskNote[] = [];
  const toolDecisions = applyAuthorizationAndAccessToToolDecisions(
    input.workspacePolicy.toolDecisions,
    authorizationMode,
    workspaceAccessMode,
    riskNotes,
  );
  const profiledDecisions = applyApprovalProfileToToolDecisions(toolDecisions, input.approvalProfile, riskNotes);
  const allowedWritePaths = allowedWritePathsForWorkspaceAccess(workspaceAccessMode, input.channelBoundPath);
  const approvalPolicy: ApprovalPolicy = {
    ...input.workspacePolicy,
    toolDecisions: profiledDecisions,
    allowedWritePaths,
  };
  return {
    approvalPolicy,
    snapshot: {
      mode: legacyProjection.permissionMode,
      authorizationMode,
      workspaceAccessMode,
      toolDecisions: profiledDecisions,
      allowedWritePaths,
      workspacePolicyUpdatedAt: input.workspacePolicy.updatedAt,
      riskNotes,
    },
  };
}

function applyAuthorizationAndAccessToToolDecisions(
  workspaceDecisions: ApprovalToolDecisions,
  authorizationMode: AuthorizationMode,
  workspaceAccessMode: WorkspaceAccessMode,
  riskNotes: EffectiveRunPolicyRiskNote[],
): ApprovalToolDecisions {
  const next: Partial<Record<RunTool, ApprovalToolDecision>> = {};
  for (const tool of readOnlyRunTools) {
    next[tool] = preserveDeny(workspaceDecisions[tool], "allow", tool, riskNotes);
  }

  if (workspaceAccessMode === "read_only") {
    for (const tool of riskyRunTools) {
      next[tool] = "deny";
    }
    return next as ApprovalToolDecisions;
  }

  if (authorizationMode === "ask") {
    for (const tool of riskyRunTools) {
      next[tool] = preserveDeny(workspaceDecisions[tool], "ask", tool, riskNotes);
    }
    return next as ApprovalToolDecisions;
  }

  next.edit = preserveDeny(workspaceDecisions.edit, "allow", "edit", riskNotes);
  next.write = preserveDeny(workspaceDecisions.write, "allow", "write", riskNotes);
  const bashDecision = authorizationMode === "always" && workspaceAccessMode === "full_access" ? "allow" : "ask";
  next.bash = preserveDeny(workspaceDecisions.bash, bashDecision, "bash", riskNotes);
  if (authorizationMode === "always" && workspaceAccessMode === "workspace_write" && next.bash !== "deny") {
    riskNotes.push({
      code: "workspace_command_requires_approval",
      message: "Commands still require approval because the current Pi runner is not OS-isolated to the workspace.",
      tool: "bash",
    });
  }
  return next as ApprovalToolDecisions;
}

function applyPermissionModeToToolDecisions(
  workspaceDecisions: ApprovalToolDecisions,
  mode: SessionPermissionMode,
  riskNotes: EffectiveRunPolicyRiskNote[],
): ApprovalToolDecisions {
  const next: Partial<Record<RunTool, ApprovalToolDecision>> = {};
  for (const tool of runTools) {
    next[tool] = workspaceDecisions[tool] ?? defaultApprovalToolDecisions[tool];
  }

  if (mode === "custom") {
    return next as ApprovalToolDecisions;
  }

  for (const tool of readOnlyRunTools) {
    next[tool] = preserveDeny(workspaceDecisions[tool], "allow", tool, riskNotes);
  }

  if (mode === "ask_everything" || mode === "balanced") {
    for (const tool of riskyRunTools) {
      next[tool] = preserveDeny(workspaceDecisions[tool], "ask", tool, riskNotes);
    }
    return next as ApprovalToolDecisions;
  }

  if (mode === "workspace_write") {
    next.bash = preserveDeny(workspaceDecisions.bash, "ask", "bash", riskNotes);
    next.edit = preserveDeny(workspaceDecisions.edit, "allow", "edit", riskNotes);
    next.write = preserveDeny(workspaceDecisions.write, "allow", "write", riskNotes);
    return next as ApprovalToolDecisions;
  }

  for (const tool of riskyRunTools) {
    next[tool] = preserveDeny(workspaceDecisions[tool], "allow", tool, riskNotes);
  }
  return next as ApprovalToolDecisions;
}

function applyApprovalProfileToToolDecisions(
  decisions: ApprovalToolDecisions,
  profile: SkillApprovalProfile | undefined,
  riskNotes: EffectiveRunPolicyRiskNote[],
): ApprovalToolDecisions {
  if (!profile || profile.mode === "none") {
    return decisions;
  }

  const next: Partial<Record<RunTool, ApprovalToolDecision>> = { ...decisions };
  const requiredTools = new Set<RunTool>();
  for (const tool of profile.requiredForTools ?? []) {
    requiredTools.add(tool);
  }
  for (const action of profile.requiredForActions ?? []) {
    if (isRunTool(action)) {
      requiredTools.add(action);
    }
  }
  if (profile.mode === "strict") {
    for (const tool of riskyRunTools) {
      requiredTools.add(tool);
    }
  }

  for (const tool of requiredTools) {
    if (next[tool] === "deny") {
      riskNotes.push({
        code: "approval_profile_denied_by_workspace_policy",
        message: `AI teammate approval profile requested ${tool}, but workspace policy denied it.`,
        tool,
      });
      continue;
    }
    next[tool] = "ask";
  }
  return next as ApprovalToolDecisions;
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
  return workspaceAllowedWritePaths;
}

function allowedWritePathsForWorkspaceAccess(
  workspaceAccessMode: WorkspaceAccessMode,
  channelBoundPath: string | undefined,
): readonly string[] {
  if (workspaceAccessMode === "read_only") {
    return [];
  }
  if (workspaceAccessMode === "full_access") {
    return ["/"];
  }
  return [channelBoundPath?.trim() || "."];
}

function preserveDeny(
  workspaceDecision: ApprovalToolDecision | undefined,
  requestedDecision: ApprovalToolDecision,
  tool: RunTool,
  riskNotes: EffectiveRunPolicyRiskNote[],
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

function isRunTool(value: string): value is RunTool {
  return (runTools as readonly string[]).includes(value);
}
