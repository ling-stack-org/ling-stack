import type {
  ApprovalListResponse,
  ApprovalMutationResponse,
  ApprovalPolicyResponse,
  ChannelAttachmentListResponse,
  ChannelAttachmentMutationResponse,
  ChannelLinkPreviewListResponse,
  ChannelLinkPreviewMutationResponse,
  ChannelListResponse,
  ChannelMessageListResponse,
  ChannelMessageMutationResponse,
  ChannelMutationResponse,
  CreateChannelAttachmentRequest,
  CreateChannelLinkPreviewRequest,
  CreateChannelMessageRequest,
  CreateChannelRequest,
  CreateMediaJobRequest,
  CreateTaskRequest,
  DaemonHealthResponse,
  ListApprovalsRequest,
  ListResourceLeasesRequest,
  ListStateTransitionsRequest,
  ListTasksRequest,
  MediaJobArtifactListResponse,
  MediaJobListResponse,
  MediaJobMutationResponse,
  ProviderCheckResult,
  ProviderListResponse,
  ProviderMutationRequest,
  ProviderMutationResponse,
  ProviderTemplateListResponse,
  ResourceLeaseListResponse,
  RunArtifactListResponse,
  RunCancelResponse,
  RunEventsResponse,
  RunListResponse,
  RunSession,
  SecretPurpose,
  SecretStatusResponse,
  StateTransitionListResponse,
  TaskListResponse,
  TaskMutationResponse,
  UpdateApprovalPolicyRequest,
  UpdateChannelRequest,
  UpdateTaskRequest,
} from "@ling-stack/contracts";
import { LingDaemonError } from "./errors.js";

export interface LingDaemonClientOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export function daemonBaseUrlFromEnv(env: Record<string, string | undefined> = {}): string {
  return env.VITE_LING_STACK_DAEMON_URL?.replace(/\/$/, "") ?? "http://127.0.0.1:17891";
}

export class LingDaemonClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: LingDaemonClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? daemonBaseUrlFromEnv()).replace(/\/$/, "");
    const configuredFetch = options.fetch;
    if (configuredFetch) {
      this.fetchImpl = (input, init) => configuredFetch(input, init);
      return;
    }
    if (!globalThis.fetch) {
      throw new Error("A fetch implementation is required.");
    }
    this.fetchImpl = globalThis.fetch.bind(globalThis);
  }

  async getHealth(): Promise<DaemonHealthResponse> {
    const response = await this.fetchImpl(this.url("/health"));
    if (!response.ok) {
      return { ok: false };
    }
    const body = (await response.json()) as {
      ok?: unknown;
      service?: unknown;
      defaultWorkspaceCwd?: unknown;
    };
    return {
      ok: body.ok === true,
      service: typeof body.service === "string" ? body.service : undefined,
      defaultWorkspaceCwd: typeof body.defaultWorkspaceCwd === "string" ? body.defaultWorkspaceCwd : undefined,
    };
  }

  async listRuns(cwd: string, limit = 50): Promise<RunListResponse> {
    return this.get("/runs", { cwd, limit });
  }

  async getRun(runId: string, cwd?: string): Promise<RunSession> {
    return this.get(`/runs/${encodeURIComponent(runId)}`, { cwd });
  }

  async getRunEvents(runId: string, cwd?: string): Promise<RunEventsResponse> {
    return this.get(`/runs/${encodeURIComponent(runId)}/events`, { cwd });
  }

  async listRunArtifacts(runId: string, cwd?: string): Promise<RunArtifactListResponse> {
    return this.get(`/runs/${encodeURIComponent(runId)}/artifacts`, { cwd });
  }

  async cancelRun(cwd: string, runId: string): Promise<RunCancelResponse> {
    return this.post(`/runs/${encodeURIComponent(runId)}/cancel`, { cwd });
  }

  async listChannels(cwd: string): Promise<ChannelListResponse> {
    return this.get("/channels", { cwd });
  }

  async createChannel(cwd: string, input: CreateChannelRequest): Promise<ChannelMutationResponse> {
    return this.post("/channels", { cwd }, input);
  }

  async updateChannel(cwd: string, channelId: string, input: UpdateChannelRequest): Promise<ChannelMutationResponse> {
    return this.patch(`/channels/${encodeURIComponent(channelId)}`, { cwd }, input);
  }

  async deleteChannel(cwd: string, channelId: string): Promise<void> {
    await this.request("DELETE", `/channels/${encodeURIComponent(channelId)}`, { cwd });
  }

  async listChannelMessages(cwd: string, channelId: string, limit = 100): Promise<ChannelMessageListResponse> {
    return this.get(`/channels/${encodeURIComponent(channelId)}/messages`, { cwd, limit });
  }

  async createChannelMessage(
    cwd: string,
    channelId: string,
    input: CreateChannelMessageRequest,
  ): Promise<ChannelMessageMutationResponse> {
    return this.post(`/channels/${encodeURIComponent(channelId)}/messages`, { cwd }, input);
  }

  async listChannelAttachments(cwd: string, channelId: string, limit = 100): Promise<ChannelAttachmentListResponse> {
    return this.get(`/channels/${encodeURIComponent(channelId)}/attachments`, { cwd, limit });
  }

  async createChannelAttachment(
    cwd: string,
    channelId: string,
    input: CreateChannelAttachmentRequest,
  ): Promise<ChannelAttachmentMutationResponse> {
    return this.post(`/channels/${encodeURIComponent(channelId)}/attachments`, { cwd }, input);
  }

  async deleteChannelAttachment(cwd: string, attachmentId: string): Promise<void> {
    await this.request("DELETE", `/attachments/${encodeURIComponent(attachmentId)}`, { cwd });
  }

  attachmentContentUrl(attachmentId: string, cwd?: string): string {
    return this.url(`/attachments/${encodeURIComponent(attachmentId)}/content`, { cwd });
  }

  async listChannelLinkPreviews(cwd: string, channelId: string, limit = 100): Promise<ChannelLinkPreviewListResponse> {
    return this.get(`/channels/${encodeURIComponent(channelId)}/link-previews`, { cwd, limit });
  }

  async createChannelLinkPreview(
    cwd: string,
    channelId: string,
    input: CreateChannelLinkPreviewRequest,
  ): Promise<ChannelLinkPreviewMutationResponse> {
    return this.post(`/channels/${encodeURIComponent(channelId)}/link-previews`, { cwd }, input);
  }

  async refreshChannelLinkPreview(cwd: string, linkPreviewId: string): Promise<ChannelLinkPreviewMutationResponse> {
    return this.post(`/link-previews/${encodeURIComponent(linkPreviewId)}/refresh`, { cwd });
  }

  async listTasks(cwd: string, options: ListTasksRequest = {}): Promise<TaskListResponse> {
    return this.get("/tasks", { cwd, channelId: options.channelId, status: options.status, limit: options.limit });
  }

  async createTask(cwd: string, input: CreateTaskRequest): Promise<TaskMutationResponse> {
    return this.post("/tasks", { cwd }, input);
  }

  async updateTask(cwd: string, taskId: string, input: UpdateTaskRequest): Promise<TaskMutationResponse> {
    return this.patch(`/tasks/${encodeURIComponent(taskId)}`, { cwd }, input);
  }

  async deleteTask(cwd: string, taskId: string): Promise<void> {
    await this.request("DELETE", `/tasks/${encodeURIComponent(taskId)}`, { cwd });
  }

  async listProviders(cwd: string): Promise<ProviderListResponse> {
    return this.get("/providers", { cwd });
  }

  async listProviderTemplates(): Promise<ProviderTemplateListResponse> {
    return this.get("/provider-templates");
  }

  async createProvider(cwd: string, input: ProviderMutationRequest): Promise<ProviderMutationResponse> {
    return this.post("/providers", { cwd }, input);
  }

  async updateProvider(cwd: string, providerId: string, input: ProviderMutationRequest): Promise<ProviderMutationResponse> {
    return this.patch(`/providers/${encodeURIComponent(providerId)}`, { cwd }, input);
  }

  async deleteProvider(cwd: string, providerId: string): Promise<void> {
    await this.request("DELETE", `/providers/${encodeURIComponent(providerId)}`, { cwd });
  }

  async checkProvider(cwd: string, providerId: string): Promise<ProviderCheckResult> {
    return this.post(`/providers/${encodeURIComponent(providerId)}/check`, { cwd });
  }

  async listApprovals(cwd: string, options: ListApprovalsRequest = {}): Promise<ApprovalListResponse> {
    return this.get("/approvals", {
      cwd,
      status: options.status,
      runId: options.runId,
      mediaJobId: options.mediaJobId,
      limit: options.limit,
    });
  }

  async approveApproval(cwd: string, approvalId: string, reason?: string): Promise<ApprovalMutationResponse> {
    return this.post(`/approvals/${encodeURIComponent(approvalId)}/approve`, { cwd }, { reason });
  }

  async denyApproval(cwd: string, approvalId: string, reason?: string): Promise<ApprovalMutationResponse> {
    return this.post(`/approvals/${encodeURIComponent(approvalId)}/deny`, { cwd }, { reason });
  }

  async getApprovalPolicy(cwd: string): Promise<ApprovalPolicyResponse> {
    return this.get("/approval-policy", { cwd });
  }

  async updateApprovalPolicy(cwd: string, input: UpdateApprovalPolicyRequest): Promise<ApprovalPolicyResponse> {
    return this.patch("/approval-policy", { cwd }, input);
  }

  async listMediaJobs(cwd: string, limit = 100): Promise<MediaJobListResponse> {
    return this.get("/media-jobs", { cwd, limit });
  }

  async createMediaJob(cwd: string, input: CreateMediaJobRequest): Promise<MediaJobMutationResponse> {
    return this.post("/media-jobs", { cwd }, input);
  }

  async runMediaJob(cwd: string, mediaJobId: string): Promise<MediaJobMutationResponse> {
    return this.post(`/media-jobs/${encodeURIComponent(mediaJobId)}/run`, { cwd });
  }

  async listMediaJobArtifacts(mediaJobId: string, cwd?: string): Promise<MediaJobArtifactListResponse> {
    return this.get(`/media-jobs/${encodeURIComponent(mediaJobId)}/artifacts`, { cwd });
  }

  async listStateTransitions(cwd: string, options: ListStateTransitionsRequest = {}): Promise<StateTransitionListResponse> {
    return this.get("/state-transitions", {
      cwd,
      entityType: options.entityType,
      entityId: options.entityId,
      limit: options.limit,
    });
  }

  async listResourceLeases(cwd: string, options: ListResourceLeasesRequest = {}): Promise<ResourceLeaseListResponse> {
    return this.get("/runtime/leases", {
      cwd,
      status: options.status,
      ownerId: options.ownerId,
      limit: options.limit,
    });
  }

  async getSecretStatus(ref: string, purpose?: SecretPurpose): Promise<SecretStatusResponse> {
    return this.get("/secrets/status", { ref, purpose });
  }

  artifactContentUrl(artifactId: string, cwd?: string): string {
    return this.url(`/artifacts/${encodeURIComponent(artifactId)}/content`, { cwd });
  }

  private get<T>(path: string, query: Query = {}): Promise<T> {
    return this.request("GET", path, query);
  }

  private post<T>(path: string, query: Query = {}, body?: unknown): Promise<T> {
    return this.request("POST", path, query, body);
  }

  private patch<T>(path: string, query: Query = {}, body?: unknown): Promise<T> {
    return this.request("PATCH", path, query, body);
  }

  private async request<T>(method: string, path: string, query: Query = {}, body?: unknown): Promise<T> {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const response = await this.fetchImpl(this.url(path, query), init);
    if (!response.ok) {
      throw new LingDaemonError(await readErrorMessage(response), response.status, response.statusText);
    }
    if (method === "DELETE") {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  private url(path: string, query: Query = {}): string {
    const parsed = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") {
        parsed.searchParams.set(key, String(value));
      }
    }
    return parsed.toString();
  }
}

type Query = Record<string, string | number | boolean | undefined>;

async function readErrorMessage(response: Response): Promise<string> {
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as { message?: unknown; error?: unknown };
    if (typeof body.message === "string") {
      message = body.message;
    } else if (typeof body.error === "string") {
      message = body.error;
    }
  } catch {
    return friendlyErrorMessage(message);
  }
  return friendlyErrorMessage(message);
}

function friendlyErrorMessage(message: string): string {
  if ((message.includes("EACCES") || message.includes("ENOENT")) && message.includes(".ling-stack")) {
    return `Workspace path does not exist or is not writable. Use the absolute path to your local checkout. ${message}`;
  }
  return message;
}
