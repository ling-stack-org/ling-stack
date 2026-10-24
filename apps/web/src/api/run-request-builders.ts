import type {
  Channel,
  RunFormState,
  RunSession,
  SkillApprovalProfile,
  Task,
  ToolName,
} from "../types.js";
import {
  isRunnerTool,
  readOptionalString,
  readRecord,
  readRunTask,
  readToolArray,
  removeUndefined,
} from "./shared.js";

export function buildRunRequest(form: RunFormState): unknown {
  if (form.providerPresetId) {
    return {
      cwd: form.cwd,
      task: {
        id: form.taskId,
        title: form.title,
        prompt: form.prompt,
        channelId: "workspace",
      },
      providerPresetId: form.providerPresetId,
      tools: form.tools.filter(isRunnerTool),
      authorizationMode: form.authorizationMode,
      workspaceAccessMode: form.workspaceAccessMode,
      permissionPreset: form.permissionPreset,
      permissionMode: form.permissionMode,
      thinkingLevel: "medium",
    };
  }

  return {
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
    authorizationMode: form.authorizationMode,
    workspaceAccessMode: form.workspaceAccessMode,
    permissionPreset: form.permissionPreset,
    permissionMode: form.permissionMode,
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
  return {
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
    authorizationMode: options.authorizationMode,
    workspaceAccessMode: options.workspaceAccessMode,
    permissionPreset: options.permissionPreset,
    permissionMode: options.permissionMode,
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

function isWorkflowRun(run: RunSession): boolean {
  return Boolean(run.workflowStepId || readOptionalString(readRecord(run.requestSnapshot), "workflowStepId"));
}

/** Workflow retries belong to the Host step controller, never a reconstructed task. */
export function canRerunSnapshot(run: RunSession | undefined): boolean {
  if (!run || isWorkflowRun(run)) return false;
  return Boolean((run.providerPresetId ?? readOptionalString(readRecord(run.requestSnapshot), "providerPresetId"))
    && readOptionalString(readRecord(run.taskSnapshot), "prompt"));
}

export function buildRerunRequest(run: RunSession): unknown {
  if (isWorkflowRun(run)) {
    throw new Error("Retry this workflow step through its channel workflow controls, not its public snapshot.");
  }
  const snapshot = readRecord(run.requestSnapshot);
  const providerPresetId = run.providerPresetId ?? readOptionalString(snapshot, "providerPresetId");
  if (!providerPresetId) {
    throw new Error("This run cannot be rerun because it did not use a provider preset.");
  }

  return removeUndefined({
    workspaceCwd: readOptionalString(snapshot, "workspaceCwd") ?? run.cwd,
    cwd: readOptionalString(snapshot, "cwd") ?? run.cwd,
    task: readRunTask(run),
    providerPresetId,
    tools: readToolArray(snapshot, "tools"),
    authorizationMode: readOptionalString(snapshot, "authorizationMode"),
    workspaceAccessMode: readOptionalString(snapshot, "workspaceAccessMode"),
    permissionPreset: readOptionalString(snapshot, "permissionPreset"),
    permissionMode: readOptionalString(snapshot, "permissionMode"),
    thinkingLevel: readOptionalString(snapshot, "thinkingLevel") ?? "medium",
    lingConversationTone: readOptionalString(snapshot, "lingConversationTone"),
    // Private system hydration is Host-owned and is not replayed from cached public DTOs.
    agentDir: readOptionalString(snapshot, "agentDir"),
  });
}
