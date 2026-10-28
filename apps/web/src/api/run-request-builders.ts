import type {
  Channel,
  RunSession,
  SkillApprovalProfile,
  Task,
  ToolName,
} from "@ling-stack/contracts";
import type { RunFormState } from "../types.js";
import {
  isRunnerTool,
  readOptionalString,
  readRecord,
  readRunTask,
  readStringArray,
  readToolArray,
  removeUndefined,
} from "./shared.js";
import { authorizationAndAccessFromLegacyPermission } from "@ling-stack/core/session-permissions";

export function buildRunRequest(form: RunFormState): unknown {
  const permissions = canonicalPermissions(form.authorizationMode, form.workspaceAccessMode, form.permissionMode, form.permissionPreset);
  if (form.providerPresetId) {
    return {
      schemaVersion: 2,
      cwd: form.cwd,
      task: {
        id: form.taskId,
        title: form.title,
        prompt: form.prompt,
        channelId: "workspace",
      },
      providerPresetId: form.providerPresetId,
      tools: form.tools.filter(isRunnerTool),
      ...permissions,
      thinkingLevel: "medium",
    };
  }

  return {
    schemaVersion: 2,
    cwd: form.cwd,
    task: {
      id: form.taskId,
      title: form.title,
      prompt: form.prompt,
      channelId: "workspace",
    },
    provider: {
      provider: form.provider,
      model: form.model,
      baseUrl: form.baseUrl || undefined,
      apiKey: form.apiKey || undefined,
      api: form.api || undefined,
      authHeader: true,
      input: ["text"],
    },
    tools: form.tools.filter(isRunnerTool),
    ...permissions,
    thinkingLevel: "medium",
  };
}

export function buildTaskRunRequest(
  workspaceCwd: string,
  task: Task,
  channel: Channel,
  providerPresetId: string,
  options: {
    readonly tools?: readonly ToolName[];
    readonly approvalProfile?: SkillApprovalProfile;
    readonly authorizationMode?: RunFormState["authorizationMode"];
    readonly workspaceAccessMode?: RunFormState["workspaceAccessMode"];
    readonly permissionPreset?: RunFormState["permissionPreset"];
    readonly permissionMode?: RunFormState["permissionMode"];
  } = {},
): unknown {
  const fallbackTools: readonly ToolName[] = ["read", "grep", "find", "ls"];
  const permissions = canonicalPermissions(options.authorizationMode, options.workspaceAccessMode, options.permissionMode, options.permissionPreset);
  return {
    schemaVersion: 2,
    workspaceCwd,
    cwd: resolveChannelExecutionCwd(channel, workspaceCwd),
    task: {
      id: task.id,
      title: task.title,
      prompt: task.prompt,
      channelId: task.channelId,
    },
    providerPresetId,
    tools: (options.tools && options.tools.length > 0 ? options.tools : channel.allowedTools.length > 0 ? channel.allowedTools : fallbackTools).filter(isRunnerTool),
    approvalProfile: options.approvalProfile,
    ...permissions,
    thinkingLevel: "medium",
  };
}

function resolveChannelExecutionCwd(channel: Channel, workspaceCwd: string): string {
  if (channel.workspaceBinding?.mode === "managed_worktree" && channel.workspaceBinding.worktreePath) {
    return channel.workspaceBinding.worktreePath;
  }
  if (channel.workspaceBinding?.mode === "external_path" && channel.workspaceBinding.executionPath) {
    return channel.workspaceBinding.executionPath;
  }
  return channel.boundPath || workspaceCwd;
}

export function buildRerunRequest(run: RunSession): unknown {
  const snapshot = readRecord(run.requestSnapshot);
  const providerPresetId = run.providerPresetId ?? readOptionalString(snapshot, "providerPresetId");
  if (!providerPresetId) {
    throw new Error("This run cannot be rerun because it did not use a provider preset.");
  }

  const permissions = canonicalPermissions(
    readOptionalString(snapshot, "authorizationMode") as RunFormState["authorizationMode"] | undefined,
    readOptionalString(snapshot, "workspaceAccessMode") as RunFormState["workspaceAccessMode"] | undefined,
    readOptionalString(snapshot, "permissionMode") as RunFormState["permissionMode"] | undefined,
    readOptionalString(snapshot, "permissionPreset") as RunFormState["permissionPreset"] | undefined,
  );
  return removeUndefined({
    schemaVersion: 2,
    workspaceCwd: readOptionalString(snapshot, "workspaceCwd") ?? run.cwd,
    cwd: readOptionalString(snapshot, "cwd") ?? run.cwd,
    task: readRunTask(run),
    providerPresetId,
    tools: readToolArray(snapshot, "tools"),
    ...permissions,
    thinkingLevel: readOptionalString(snapshot, "thinkingLevel") ?? "medium",
    lingConversationTone: readOptionalString(snapshot, "lingConversationTone"),
    systemPrompt: readOptionalString(snapshot, "systemPrompt"),
    appendSystemPrompt: readStringArray(snapshot, "appendSystemPrompt"),
    agentDir: readOptionalString(snapshot, "agentDir"),
  });
}

function canonicalPermissions(
  authorizationMode: RunFormState["authorizationMode"] | undefined,
  workspaceAccessMode: RunFormState["workspaceAccessMode"] | undefined,
  permissionMode: RunFormState["permissionMode"] | undefined,
  permissionPreset: RunFormState["permissionPreset"] | undefined,
): { readonly authorizationMode: RunFormState["authorizationMode"]; readonly workspaceAccessMode: RunFormState["workspaceAccessMode"] } {
  const legacy = authorizationAndAccessFromLegacyPermission(permissionMode, permissionPreset);
  return {
    authorizationMode: authorizationMode ?? legacy.authorizationMode,
    workspaceAccessMode: workspaceAccessMode ?? legacy.workspaceAccessMode,
  };
}
