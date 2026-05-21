import type {
  ApprovalListResponse,
  ApprovalMutationResponse,
  Channel,
  ChannelFormState,
  ChannelListResponse,
  ChannelMutationResponse,
  ProviderCheckResult,
  ProviderFormState,
  ProviderListResponse,
  ProviderMutationResponse,
  ProviderTemplateListResponse,
  RunCancelResponse,
  RunEventsResponse,
  RunFormState,
  RunListResponse,
  RunSession,
  Task,
  TaskEditFormState,
  TaskFormState,
  TaskListResponse,
  TaskMutationResponse,
  ToolName,
} from "./types.js";

export const daemonBaseUrl =
  import.meta.env.VITE_LING_STACK_DAEMON_URL?.replace(/\/$/, "") ?? "http://127.0.0.1:17891";

export async function getDaemonHealth(): Promise<boolean> {
  const response = await fetch(`${daemonBaseUrl}/health`);
  if (!response.ok) {
    return false;
  }
  const body = (await response.json()) as { ok?: unknown };
  return body.ok === true;
}

export async function getRun(runId: string, cwd?: string): Promise<RunSession> {
  const response = await fetch(withCwd(`${daemonBaseUrl}/runs/${encodeURIComponent(runId)}`, cwd));
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as RunSession;
}

export async function listRuns(cwd: string, limit = 50): Promise<RunListResponse> {
  const parsed = new URL(`${daemonBaseUrl}/runs`);
  parsed.searchParams.set("cwd", cwd);
  parsed.searchParams.set("limit", String(limit));
  const response = await fetch(parsed.toString());
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as RunListResponse;
}

export async function listProviders(cwd: string): Promise<ProviderListResponse> {
  const response = await fetch(withCwd(`${daemonBaseUrl}/providers`, cwd));
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as ProviderListResponse;
}

export async function listProviderTemplates(): Promise<ProviderTemplateListResponse> {
  const response = await fetch(`${daemonBaseUrl}/provider-templates`);
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as ProviderTemplateListResponse;
}

export async function listChannels(cwd: string): Promise<ChannelListResponse> {
  const response = await fetch(withCwd(`${daemonBaseUrl}/channels`, cwd));
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as ChannelListResponse;
}

export async function createChannel(cwd: string, form: ChannelFormState): Promise<ChannelMutationResponse> {
  const response = await fetch(withCwd(`${daemonBaseUrl}/channels`, cwd), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(channelFormToPayload(form)),
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as ChannelMutationResponse;
}

export async function updateChannel(cwd: string, channelId: string, form: ChannelFormState): Promise<ChannelMutationResponse> {
  const response = await fetch(withCwd(`${daemonBaseUrl}/channels/${encodeURIComponent(channelId)}`, cwd), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(channelFormToUpdatePayload(form)),
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as ChannelMutationResponse;
}

export async function deleteChannel(cwd: string, channelId: string): Promise<void> {
  const response = await fetch(withCwd(`${daemonBaseUrl}/channels/${encodeURIComponent(channelId)}`, cwd), {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
}

export async function listTasks(cwd: string, channelId?: string): Promise<TaskListResponse> {
  const parsed = new URL(`${daemonBaseUrl}/tasks`);
  parsed.searchParams.set("cwd", cwd);
  if (channelId) {
    parsed.searchParams.set("channelId", channelId);
  }
  const response = await fetch(parsed.toString());
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as TaskListResponse;
}

export async function createTask(cwd: string, channelId: string, form: TaskFormState): Promise<TaskMutationResponse> {
  const response = await fetch(withCwd(`${daemonBaseUrl}/tasks`, cwd), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      channelId,
      title: form.title,
      prompt: form.prompt,
    }),
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as TaskMutationResponse;
}

export async function updateTaskStatus(cwd: string, taskId: string, status: Task["status"]): Promise<TaskMutationResponse> {
  const response = await fetch(withCwd(`${daemonBaseUrl}/tasks/${encodeURIComponent(taskId)}`, cwd), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as TaskMutationResponse;
}

export async function updateTask(cwd: string, taskId: string, form: TaskEditFormState): Promise<TaskMutationResponse> {
  const response = await fetch(withCwd(`${daemonBaseUrl}/tasks/${encodeURIComponent(taskId)}`, cwd), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: form.title,
      prompt: form.prompt,
      status: form.status,
    }),
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as TaskMutationResponse;
}

export async function deleteTask(cwd: string, taskId: string): Promise<void> {
  const response = await fetch(withCwd(`${daemonBaseUrl}/tasks/${encodeURIComponent(taskId)}`, cwd), {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
}

export async function createProvider(cwd: string, form: ProviderFormState): Promise<ProviderMutationResponse> {
  const response = await fetch(withCwd(`${daemonBaseUrl}/providers`, cwd), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(providerFormToPayload(form)),
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as ProviderMutationResponse;
}

export async function updateProvider(cwd: string, providerId: string, form: ProviderFormState): Promise<ProviderMutationResponse> {
  const response = await fetch(withCwd(`${daemonBaseUrl}/providers/${encodeURIComponent(providerId)}`, cwd), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(providerFormToPayload(form)),
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as ProviderMutationResponse;
}

export async function deleteProvider(cwd: string, providerId: string): Promise<void> {
  const response = await fetch(withCwd(`${daemonBaseUrl}/providers/${encodeURIComponent(providerId)}`, cwd), {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
}

export async function checkProvider(cwd: string, providerId: string): Promise<ProviderCheckResult> {
  const response = await fetch(withCwd(`${daemonBaseUrl}/providers/${encodeURIComponent(providerId)}/check`, cwd), {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as ProviderCheckResult;
}

export async function listApprovals(cwd: string, status?: string): Promise<ApprovalListResponse> {
  const parsed = new URL(`${daemonBaseUrl}/approvals`);
  parsed.searchParams.set("cwd", cwd);
  if (status) {
    parsed.searchParams.set("status", status);
  }
  const response = await fetch(parsed.toString());
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as ApprovalListResponse;
}

export async function approveApproval(cwd: string, approvalId: string, reason?: string): Promise<ApprovalMutationResponse> {
  return resolveApproval(cwd, approvalId, "approve", reason);
}

export async function denyApproval(cwd: string, approvalId: string, reason?: string): Promise<ApprovalMutationResponse> {
  return resolveApproval(cwd, approvalId, "deny", reason);
}

export async function getRunEvents(runId: string, cwd?: string): Promise<RunEventsResponse> {
  const response = await fetch(withCwd(`${daemonBaseUrl}/runs/${encodeURIComponent(runId)}/events`, cwd));
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as RunEventsResponse;
}

export async function cancelRun(cwd: string, runId: string): Promise<RunCancelResponse> {
  const response = await fetch(withCwd(`${daemonBaseUrl}/runs/${encodeURIComponent(runId)}/cancel`, cwd), {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as RunCancelResponse;
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
  const response = await fetch(withCwd(`${daemonBaseUrl}/approvals/${encodeURIComponent(approvalId)}/${action}`, cwd), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as ApprovalMutationResponse;
}

function providerFormToPayload(form: ProviderFormState): unknown {
  return {
    kind: form.kind,
    displayName: form.displayName,
    providerId: form.providerId,
    model: form.model,
    api: form.api,
    baseUrl: form.baseUrl || undefined,
    apiKeyRef: form.apiKeyRef || undefined,
    capabilities: splitCsv(form.capabilitiesText),
    input: splitCsv(form.inputText),
    enabled: form.enabled,
    authHeader: form.authHeader,
    reasoning: form.reasoning,
    contextWindow: form.contextWindow ? Number(form.contextWindow) : undefined,
    maxTokens: form.maxTokens ? Number(form.maxTokens) : undefined,
  };
}

function channelFormToPayload(form: ChannelFormState): unknown {
  return {
    name: form.name.trim(),
    boundPath: form.boundPath.trim() || undefined,
    defaultProviderPresetId: form.defaultProviderPresetId || undefined,
    allowedTools: form.allowedTools.filter(isRunnerTool),
  };
}

function channelFormToUpdatePayload(form: ChannelFormState): unknown {
  return {
    name: form.name.trim(),
    boundPath: form.boundPath.trim() || null,
    defaultProviderPresetId: form.defaultProviderPresetId || null,
    allowedTools: form.allowedTools.filter(isRunnerTool),
  };
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
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

function withCwd(url: string, cwd?: string): string {
  if (!cwd) {
    return url;
  }
  const parsed = new URL(url);
  parsed.searchParams.set("cwd", cwd);
  return parsed.toString();
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown; error?: unknown };
    if (typeof body.message === "string") {
      return body.message;
    }
    if (typeof body.error === "string") {
      return body.error;
    }
  } catch {
    return `${response.status} ${response.statusText}`;
  }
  return `${response.status} ${response.statusText}`;
}
