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
  readStringArray,
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
    readonly permissionPreset?: RunFormState["permissionPreset"];
    readonly permissionMode?: RunFormState["permissionMode"];
  } = {},
): unknown {
  const fallbackTools: readonly ToolName[] = ["read", "grep", "find", "ls"];
  return {
    workspaceCwd,
    cwd: channel.boundPath || workspaceCwd,
    task: {
      id: task.id,
      title: task.title,
      prompt: task.prompt,
      channelId: task.channelId,
    },
    providerPresetId,
    tools: (options.tools && options.tools.length > 0 ? options.tools : channel.allowedTools.length > 0 ? channel.allowedTools : fallbackTools).filter(isRunnerTool),
    approvalProfile: options.approvalProfile,
    permissionPreset: options.permissionPreset,
    permissionMode: options.permissionMode,
    thinkingLevel: "medium",
  };
}

export function buildRerunRequest(run: RunSession): unknown {
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
    permissionPreset: readOptionalString(snapshot, "permissionPreset"),
    permissionMode: readOptionalString(snapshot, "permissionMode"),
    thinkingLevel: readOptionalString(snapshot, "thinkingLevel") ?? "medium",
    systemPrompt: readOptionalString(snapshot, "systemPrompt"),
    appendSystemPrompt: readStringArray(snapshot, "appendSystemPrompt"),
    agentDir: readOptionalString(snapshot, "agentDir"),
  });
}
