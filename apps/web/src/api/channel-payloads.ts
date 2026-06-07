import type {
  ChannelFormState,
  CreateChannelRequest,
  TaskEditFormState,
  UpdateChannelRequest,
  UpdateTaskRequest,
} from "../types.js";
import { isRunnerTool } from "./shared.js";

export function channelFormToPayload(form: ChannelFormState): CreateChannelRequest {
  return {
    name: form.name.trim(),
    status: form.status,
    boundPath: form.boundPath.trim() || undefined,
    defaultProviderPresetId: form.defaultProviderPresetId || undefined,
    defaultTeammateId: form.defaultTeammateId || undefined,
    allowedTools: form.allowedTools.filter(isRunnerTool),
    runtimePolicy: form.runtimePolicy,
  };
}

export function channelFormToUpdatePayload(form: ChannelFormState): UpdateChannelRequest {
  return {
    name: form.name.trim(),
    status: form.status,
    boundPath: form.boundPath.trim() || null,
    defaultProviderPresetId: form.defaultProviderPresetId || null,
    defaultTeammateId: form.defaultTeammateId || null,
    allowedTools: form.allowedTools.filter(isRunnerTool),
    runtimePolicy: form.runtimePolicy,
  };
}

export function taskEditFormToPayload(form: TaskEditFormState): UpdateTaskRequest {
  return {
    title: form.title,
    prompt: form.prompt,
    status: form.status,
  };
}
