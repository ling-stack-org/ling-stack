import type { Channel, ChannelCreateFormState, ChannelFormState } from "../types.js";
import { defaultTools } from "./tools.js";

export const defaultChannelForm: ChannelFormState = {
  name: "Engineering",
  status: "active",
  boundPath: "",
  defaultProviderPresetId: "",
  defaultTeammateId: "",
  autoReplyMode: "mentions_only",
  allowedTools: defaultTools,
  runtimePolicy: {
    maxConcurrentRuns: 1,
    executionMode: "serial",
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
    defaultProviderPresetId: channel.defaultProviderPresetId ?? "",
    defaultTeammateId: channel.defaultTeammateId ?? "",
    autoReplyMode: channel.autoReplyMode ?? "mentions_only",
    allowedTools: channel.allowedTools.length > 0 ? channel.allowedTools : defaultTools,
    runtimePolicy: effectiveChannelRuntimePolicy(channel),
  };
}
