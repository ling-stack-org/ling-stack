import type { Channel, ChannelCreateFormState, ChannelFormState } from "../types.js";
import { defaultTools } from "./tools.js";

export const defaultChannelForm: ChannelFormState = {
  name: "Engineering",
  status: "active",
  boundPath: "",
  defaultProviderPresetId: "",
  defaultTeammateId: "",
  autoReplyMode: "mentions_only",
  responseLanguage: "workspace",
  allowedTools: defaultTools,
  runtimePolicy: {
    maxConcurrentRuns: 1,
    schedulingMode: "smart",
    writeLockScope: "boundPath",
    allowReadOnlyParallel: true,
    queueOnConflict: true,
  },
};

export const defaultChannelEditForm: ChannelFormState = {
  name: "",
  status: "active",
  boundPath: "",
  defaultProviderPresetId: "",
  defaultTeammateId: "",
  autoReplyMode: "mentions_only",
  responseLanguage: "workspace",
  allowedTools: defaultTools,
  runtimePolicy: defaultChannelForm.runtimePolicy,
};

export const defaultChannelCreateForm: ChannelCreateFormState = {
  ...defaultChannelForm,
  selectedTeammateIds: [],
  defaultResponderTeammateId: "",
};

export function effectiveChannelRuntimePolicy(channel: Pick<Channel, "runtimePolicy"> | undefined): ChannelFormState["runtimePolicy"] {
  return {
    ...defaultChannelForm.runtimePolicy,
    ...(channel?.runtimePolicy ?? {}),
  };
}

export function channelToForm(channel: Channel, fallbackCwd: string): ChannelFormState {
  return {
    name: channel.name,
    status: channel.status,
    boundPath: channel.boundPath ?? fallbackCwd,
    workspaceBinding: channel.workspaceBinding,
    defaultProviderPresetId: channel.defaultProviderPresetId ?? "",
    defaultTeammateId: channel.defaultTeammateId ?? "",
    autoReplyMode: channel.autoReplyMode ?? "mentions_only",
    responseLanguage: channel.responseLanguage ?? "workspace",
    allowedTools: channel.allowedTools.length > 0 ? channel.allowedTools : defaultTools,
    runtimePolicy: effectiveChannelRuntimePolicy(channel),
  };
}

export function channelFormPersistenceKey(form: ChannelFormState): string {
  return JSON.stringify({
    name: form.name.trim(),
    status: form.status,
    boundPath: form.boundPath.trim(),
    workspaceBinding: form.workspaceBinding
      ? {
          mode: form.workspaceBinding.mode,
          status: form.workspaceBinding.status,
          executionPath: form.workspaceBinding.executionPath ?? "",
          worktreePath: form.workspaceBinding.worktreePath ?? "",
          branchName: form.workspaceBinding.branchName ?? "",
          baseBranch: form.workspaceBinding.baseBranch ?? "",
          baseCommit: form.workspaceBinding.baseCommit ?? "",
          errorMessage: form.workspaceBinding.errorMessage ?? "",
          createdAt: form.workspaceBinding.createdAt ?? "",
          checkedAt: form.workspaceBinding.checkedAt ?? "",
          updatedAt: form.workspaceBinding.updatedAt,
        }
      : null,
    defaultProviderPresetId: form.defaultProviderPresetId,
    defaultTeammateId: form.defaultTeammateId,
    autoReplyMode: form.autoReplyMode,
    responseLanguage: form.responseLanguage,
    allowedTools: [...form.allowedTools],
    runtimePolicy: {
      maxConcurrentRuns: form.runtimePolicy.maxConcurrentRuns,
      schedulingMode: form.runtimePolicy.schedulingMode,
      writeLockScope: form.runtimePolicy.writeLockScope,
      allowReadOnlyParallel: form.runtimePolicy.allowReadOnlyParallel,
      queueOnConflict: form.runtimePolicy.queueOnConflict,
    },
  });
}
