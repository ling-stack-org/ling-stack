import { LingDaemonClient, daemonBaseUrlFromEnv } from "@ling-stack/api-client";
import type {
  ApprovalListResponse,
  ApprovalMutationResponse,
  ApprovalPolicyFormState,
  ApprovalPolicyResponse,
  Channel,
  ChannelFormState,
  ChannelListResponse,
  ChannelMutationResponse,
  CreateChannelRequest,
  CreateMediaJobRequest,
  DaemonHealthResponse,
  MediaJobFormState,
  MediaJobArtifactListResponse,
  MediaJobListResponse,
  MediaJobMutationResponse,
  ProviderCheckResult,
  ProviderFormState,
  ProviderListResponse,
  ProviderModelListResponse,
  ProviderMutationRequest,
  ProviderMutationResponse,
  ProviderSecretResponse,
  ProviderTemplateListResponse,
  ResourceLeaseListResponse,
  RunCancelResponse,
  RunArtifactListResponse,
  RunEventsResponse,
  RunFormState,
  RunListResponse,
  RunSession,
  SecretPurpose,
  SecretStatusResponse,
  StateEntityType,
  StateTransitionListResponse,
  Task,
  TaskEditFormState,
  TaskFormState,
  TaskListResponse,
  TaskMutationResponse,
  ToolName,
  UpdateChannelRequest,
  UpdateTaskRequest,
} from "./types.js";

export const daemonBaseUrl = daemonBaseUrlFromEnv(import.meta.env as Record<string, string | undefined>);

const daemonClient = new LingDaemonClient({ baseUrl: daemonBaseUrl });

export async function getDaemonHealth(): Promise<DaemonHealthResponse> {
  return daemonClient.getHealth();
}

export async function getRun(runId: string, cwd?: string): Promise<RunSession> {
  return daemonClient.getRun(runId, cwd);
}

export async function listRuns(cwd: string, limit = 50): Promise<RunListResponse> {
  return daemonClient.listRuns(cwd, limit);
}

export async function listProviders(cwd: string): Promise<ProviderListResponse> {
  return daemonClient.listProviders(cwd);
}

export async function listProviderTemplates(): Promise<ProviderTemplateListResponse> {
  return daemonClient.listProviderTemplates();
}

export async function listChannels(cwd: string): Promise<ChannelListResponse> {
  return daemonClient.listChannels(cwd);
}

export async function createChannel(cwd: string, form: ChannelFormState): Promise<ChannelMutationResponse> {
  return daemonClient.createChannel(cwd, channelFormToPayload(form));
}

export async function updateChannel(cwd: string, channelId: string, form: ChannelFormState): Promise<ChannelMutationResponse> {
  return daemonClient.updateChannel(cwd, channelId, channelFormToUpdatePayload(form));
}

export async function deleteChannel(cwd: string, channelId: string): Promise<void> {
  await daemonClient.deleteChannel(cwd, channelId);
}

export async function listTasks(cwd: string, channelId?: string): Promise<TaskListResponse> {
  return daemonClient.listTasks(cwd, { channelId });
}

export async function createTask(cwd: string, channelId: string, form: TaskFormState): Promise<TaskMutationResponse> {
  return daemonClient.createTask(cwd, {
    channelId,
    title: form.title,
    prompt: form.prompt,
  });
}

export async function updateTaskStatus(cwd: string, taskId: string, status: Task["status"]): Promise<TaskMutationResponse> {
  return daemonClient.updateTask(cwd, taskId, { status });
}

export async function updateTask(cwd: string, taskId: string, form: TaskEditFormState): Promise<TaskMutationResponse> {
  return daemonClient.updateTask(cwd, taskId, taskEditFormToPayload(form));
}

export async function deleteTask(cwd: string, taskId: string): Promise<void> {
  await daemonClient.deleteTask(cwd, taskId);
}

export async function listStateTransitions(
  cwd: string,
  options: { readonly entityType?: StateEntityType; readonly entityId?: string; readonly limit?: number } = {},
): Promise<StateTransitionListResponse> {
  return daemonClient.listStateTransitions(cwd, options);
}

export async function listResourceLeases(
  cwd: string,
  options: { readonly status?: "active" | "released" | "expired"; readonly ownerId?: string; readonly limit?: number } = {},
): Promise<ResourceLeaseListResponse> {
  return daemonClient.listResourceLeases(cwd, options);
}

export async function getSecretStatus(ref: string, purpose?: SecretPurpose): Promise<SecretStatusResponse> {
  return daemonClient.getSecretStatus(ref, purpose);
}

export async function createProvider(cwd: string, form: ProviderFormState): Promise<ProviderMutationResponse> {
  return daemonClient.createProvider(cwd, providerFormToPayload(form));
}

export async function updateProvider(cwd: string, providerId: string, form: ProviderFormState): Promise<ProviderMutationResponse> {
  return daemonClient.updateProvider(cwd, providerId, providerFormToPayload(form));
}

export async function getProviderSecret(cwd: string, providerId: string): Promise<ProviderSecretResponse> {
  return daemonClient.getProviderSecret(cwd, providerId);
}

export async function deleteProvider(cwd: string, providerId: string): Promise<void> {
  await daemonClient.deleteProvider(cwd, providerId);
}

export async function checkProvider(cwd: string, providerId: string): Promise<ProviderCheckResult> {
  return daemonClient.checkProvider(cwd, providerId);
}

export async function checkProviderDraft(cwd: string, form: ProviderFormState): Promise<ProviderCheckResult> {
  return daemonClient.checkProviderDraft(cwd, providerFormToPayload(form));
}

export async function listProviderModels(cwd: string, form: ProviderFormState): Promise<ProviderModelListResponse> {
  return daemonClient.listProviderModels(cwd, {
    kind: form.kind,
    providerId: form.providerId,
    api: form.api,
    baseUrl: form.baseUrl || undefined,
    apiKey: form.apiKey.trim() || undefined,
    apiKeyRef: form.apiKeyRef || undefined,
    authHeader: form.authHeader,
  });
}

export async function listApprovals(
  cwd: string,
  options: { readonly status?: string; readonly runId?: string; readonly mediaJobId?: string } = {},
): Promise<ApprovalListResponse> {
  return daemonClient.listApprovals(cwd, options);
}

export async function getApprovalPolicy(cwd: string): Promise<ApprovalPolicyResponse> {
  return daemonClient.getApprovalPolicy(cwd);
}

export async function updateApprovalPolicy(cwd: string, form: ApprovalPolicyFormState): Promise<ApprovalPolicyResponse> {
  return daemonClient.updateApprovalPolicy(cwd, {
    toolDecisions: form.toolDecisions,
    allowedWritePaths: splitLines(form.allowedWritePathsText),
  });
}

export async function approveApproval(cwd: string, approvalId: string, reason?: string): Promise<ApprovalMutationResponse> {
  return resolveApproval(cwd, approvalId, "approve", reason);
}

export async function denyApproval(cwd: string, approvalId: string, reason?: string): Promise<ApprovalMutationResponse> {
  return resolveApproval(cwd, approvalId, "deny", reason);
}

export async function getRunEvents(runId: string, cwd?: string): Promise<RunEventsResponse> {
  return daemonClient.getRunEvents(runId, cwd);
}

export async function listRunArtifacts(runId: string, cwd?: string): Promise<RunArtifactListResponse> {
  return daemonClient.listRunArtifacts(runId, cwd);
}

export async function listMediaJobs(cwd: string, limit = 100): Promise<MediaJobListResponse> {
  return daemonClient.listMediaJobs(cwd, limit);
}

export async function createMediaJob(cwd: string, form: MediaJobFormState): Promise<MediaJobMutationResponse> {
  return daemonClient.createMediaJob(cwd, mediaJobFormToPayload(form));
}

export async function runMediaJob(cwd: string, mediaJobId: string): Promise<MediaJobMutationResponse> {
  return daemonClient.runMediaJob(cwd, mediaJobId);
}

export async function listMediaJobArtifacts(mediaJobId: string, cwd?: string): Promise<MediaJobArtifactListResponse> {
  return daemonClient.listMediaJobArtifacts(mediaJobId, cwd);
}

export function artifactContentUrl(artifactId: string, cwd?: string): string {
  return daemonClient.artifactContentUrl(artifactId, cwd);
}

export async function cancelRun(cwd: string, runId: string): Promise<RunCancelResponse> {
  return daemonClient.cancelRun(cwd, runId);
}

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
    thinkingLevel: "medium",
  };
}

export function buildTaskRunRequest(
  workspaceCwd: string,
  task: Task,
  channel: Channel,
  providerPresetId: string,
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
    tools: (channel.allowedTools.length > 0 ? channel.allowedTools : fallbackTools).filter(isRunnerTool),
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
    thinkingLevel: readOptionalString(snapshot, "thinkingLevel") ?? "medium",
    systemPrompt: readOptionalString(snapshot, "systemPrompt"),
    appendSystemPrompt: readStringArray(snapshot, "appendSystemPrompt"),
    agentDir: readOptionalString(snapshot, "agentDir"),
  });
}

async function resolveApproval(
  cwd: string,
  approvalId: string,
  action: "approve" | "deny",
  reason?: string,
): Promise<ApprovalMutationResponse> {
  return action === "approve"
    ? daemonClient.approveApproval(cwd, approvalId, reason)
    : daemonClient.denyApproval(cwd, approvalId, reason);
}

function providerFormToPayload(form: ProviderFormState): ProviderMutationRequest {
  return {
    kind: form.kind,
    displayName: form.displayName,
    providerId: form.providerId,
    model: form.model,
    api: form.api,
    baseUrl: form.baseUrl || undefined,
    apiKeyRef: form.apiKeyRef || undefined,
    apiKey: form.apiKey.trim() || undefined,
    clearApiKey: form.clearApiKey || undefined,
    capabilities: splitCsv(form.capabilitiesText),
    input: splitCsv(form.inputText),
    enabled: form.enabled,
    authHeader: form.authHeader,
    reasoning: form.reasoning,
    contextWindow: form.contextWindow ? Number(form.contextWindow) : undefined,
    maxTokens: form.maxTokens ? Number(form.maxTokens) : undefined,
  };
}

function channelFormToPayload(form: ChannelFormState): CreateChannelRequest {
  return {
    name: form.name.trim(),
    status: form.status,
    boundPath: form.boundPath.trim() || undefined,
    defaultProviderPresetId: form.defaultProviderPresetId || undefined,
    allowedTools: form.allowedTools.filter(isRunnerTool),
    runtimePolicy: form.runtimePolicy,
  };
}

function channelFormToUpdatePayload(form: ChannelFormState): UpdateChannelRequest {
  return {
    name: form.name.trim(),
    status: form.status,
    boundPath: form.boundPath.trim() || null,
    defaultProviderPresetId: form.defaultProviderPresetId || null,
    allowedTools: form.allowedTools.filter(isRunnerTool),
    runtimePolicy: form.runtimePolicy,
  };
}

function taskEditFormToPayload(form: TaskEditFormState): UpdateTaskRequest {
  return {
    title: form.title,
    prompt: form.prompt,
    status: form.status,
  };
}

function mediaJobFormToPayload(form: MediaJobFormState): CreateMediaJobRequest {
  return {
    providerPresetId: form.providerPresetId,
    operation: form.operation,
    prompt: form.prompt,
    input: parseMediaInput(form.inputText),
  };
}

function parseMediaInput(inputText: string): Record<string, unknown> | undefined {
  const trimmed = inputText.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Media job input must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isRunnerTool(tool: ToolName): tool is "read" | "grep" | "find" | "ls" | "bash" | "edit" | "write" {
  return ["read", "grep", "find", "ls", "bash", "edit", "write"].includes(tool);
}

function readRunTask(run: RunSession): { readonly id: string; readonly title: string; readonly prompt: string; readonly channelId: string } {
  const task = readRecord(run.taskSnapshot);
  const prompt = readOptionalString(task, "prompt");
  if (!prompt) {
    throw new Error("This run cannot be rerun because its task snapshot has no prompt.");
  }

  return {
    id: readOptionalString(task, "id") ?? run.taskId,
    title: readOptionalString(task, "title") ?? run.taskId,
    prompt,
    channelId: readOptionalString(task, "channelId") ?? run.channelId ?? "workspace",
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function readOptionalString(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function readStringArray(value: Record<string, unknown>, key: string): string[] | undefined {
  const field = value[key];
  if (!Array.isArray(field)) {
    return undefined;
  }
  const items = field.filter((item): item is string => typeof item === "string" && item.length > 0);
  return items.length > 0 ? items : undefined;
}

function readToolArray(value: Record<string, unknown>, key: string): ToolName[] | undefined {
  const field = value[key];
  if (!Array.isArray(field)) {
    return undefined;
  }
  const tools = field.filter((item): item is ToolName => typeof item === "string" && isRunnerTool(item as ToolName));
  return tools.length > 0 ? tools : undefined;
}

function removeUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
