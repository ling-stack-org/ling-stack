import type {
  LingAppServerDoctorRunParams,
  LingAppServerDoctorRunResult,
  LingAppServerCapability,
  LingAppServerCaptureChangesResult,
  LingAppServerCapabilitiesResult,
  LingAppServerContextInspectParams,
  LingAppServerContextInspectResult,
  LingAppServerThreadSnapshotParams,
  LingAppServerThreadSnapshotResult,
  LingAppServerThreadEventsResult,
  LingAppServerTurnResumeParams,
  LingAppServerTurnResumeResult,
  LingAppServerExternalAgentCapabilitiesParams,
  LingAppServerExternalAgentCapabilitiesResult,
  LingAppServerExternalAgentRegisterParams,
  LingAppServerExternalAgentRegisterResult,
  LingAppServerExternalAgentTaskCancelParams,
  LingAppServerExternalAgentTaskCancelResult,
  LingAppServerExternalAgentTaskReconnectParams,
  LingAppServerExternalAgentTaskReconnectResult,
  LingAppServerExternalAgentTaskStartParams,
  LingAppServerExternalAgentTaskStartResult,
  LingAppServerGrant,
  LingAppServerGrantCreateParams,
  LingAppServerHandoffCreateParams,
  LingAppServerHandoffReadParams,
  LingAppServerHandoffResumeParams,
  LingAppServerHandoffResumeResult,
  LingAppServerHandoffResult,
  LingAppServerInitializeParams,
  LingAppServerInitializeResult,
  LingAppServerInputRespondParams,
  LingAppServerInputRespondResult,
  LingAppServerJsonRpcId,
  LingAppServerNotificationMethod,
  LingAppServerInstructionsInitParams,
  LingAppServerInstructionsInitResult,
  LingAppServerReviewFindingUpdateParams,
  LingAppServerReviewFindingUpdateResult,
  LingAppServerReviewStartParams,
  LingAppServerReviewStartResult,
  LingAppServerReviewStatusParams,
  LingAppServerReviewStatusResult,
  LingAppServerSimplifyStartParams,
  LingAppServerSimplifyStartResult,
  LingAppServerSimplifyStatusParams,
  LingAppServerSimplifyStatusResult,
  LingAppServerSubscriptionParams,
  LingAppServerSubscriptionResult,
  LingAppServerVerifyCancelParams,
  LingAppServerVerifyCancelResult,
  LingAppServerVerifyOperation,
  LingAppServerVerifyPlanParams,
  LingAppServerVerifyPlanResult,
  LingAppServerVerifyStartParams,
  LingAppServerVerifyStatusParams,
  LingAppServerVerifyStatusResult,
  LingAppServerWorkItemControlParams,
  LingAppServerWorkItemControlResult,
  LingAppServerWorkItemReadResult,
  LingAppServerWorkItemSnapshot,
  LingAppServerWorkItemCollaborationAppendParams,
  LingAppServerWorkItemCollaborationAppendResult,
  LingAppServerWorkItemCollaborationReadParams,
  LingAppServerWorkItemCollaborationReadResult,
  LingAppServerWorktreeTarget,
  LingAppServerWorktreeCreateParams,
  LingAppServerWorktreeResult,
  LingAppServerWorktreeCleanupParams,
  LingAppServerWorktreeCleanupPreview,
  LingAppServerWorktreeCleanupResult,
  ManagedWorktreeListResponse,
} from "@ling-stack/contracts";

export interface LingAppServerSocket {
  readonly readyState?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener?(type: "open" | "message" | "close" | "error", listener: (event: unknown) => void): void;
  removeEventListener?(type: "open" | "message" | "close" | "error", listener: (event: unknown) => void): void;
  on?(type: "open" | "message" | "close" | "error", listener: (...args: unknown[]) => void): void;
  off?(type: "open" | "message" | "close" | "error", listener: (...args: unknown[]) => void): void;
}

export type LingAppServerSocketFactory = (url: string) => LingAppServerSocket;

export interface LingAppServerClientOptions {
  readonly url: string;
  readonly createSocket: LingAppServerSocketFactory;
  readonly clientInfo: { readonly name: string; readonly version: string };
  readonly requiredCapabilities?: readonly LingAppServerCapability[];
  readonly optionalCapabilities?: readonly LingAppServerCapability[];
  readonly workspaceScope?: readonly string[];
  readonly autoReconnect?: boolean;
  readonly reconnectDelayMs?: number;
  readonly maxReconnectDelayMs?: number;
  readonly requestTimeoutMs?: number;
}

export interface LingAppServerNotification {
  readonly jsonrpc: "2.0";
  readonly method: LingAppServerNotificationMethod | string;
  readonly params?: unknown;
}

export interface LingAppServerServerRequest extends LingAppServerNotification {
  readonly id: LingAppServerJsonRpcId;
}

interface LingAppServerResponse {
  readonly jsonrpc: "2.0";
  readonly id?: LingAppServerJsonRpcId | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: { readonly code?: string } };
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

interface TrackedSubscription {
  readonly method: "thread/subscribe" | "workItem/subscribe";
  readonly params: LingAppServerSubscriptionParams;
  subscriptionId?: string;
  cursor?: string;
  afterSeq?: number;
}

export class LingAppServerClient {
  private readonly options: LingAppServerClientOptions;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly notificationListeners = new Set<(notification: LingAppServerNotification) => void>();
  private readonly serverRequestListeners = new Set<(request: LingAppServerServerRequest) => void>();
  private socket?: LingAppServerSocket;
  private nextId = 1;
  private connectPromise?: Promise<LingAppServerInitializeResult>;
  private manuallyClosed = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempt = 0;
  private readonly subscriptions = new Map<string, TrackedSubscription>();

  constructor(options: LingAppServerClientOptions) {
    this.options = options;
  }

  connect(): Promise<LingAppServerInitializeResult> {
    this.manuallyClosed = false;
    if (this.connectPromise) return this.connectPromise;
    const promise = this.openAndInitialize();
    this.connectPromise = promise;
    promise.catch(() => {
      if (this.connectPromise === promise) this.connectPromise = undefined;
      this.scheduleReconnect();
    });
    return promise;
  }

  async ping(): Promise<{ readonly ok: boolean; readonly connectionId: string; readonly serverTime: string }> {
    await this.connect();
    return await this.request("server/ping", {});
  }

  async getCapabilities(): Promise<LingAppServerCapabilitiesResult> {
    await this.connect();
    return await this.request("server/capabilities", {});
  }

  async readThread(threadId: string): Promise<unknown> {
    await this.connect();
    return await this.request("thread/read", { threadId });
  }

  async createGrant(params: LingAppServerGrantCreateParams): Promise<{ cwd: string; grant: LingAppServerGrant }> {
    await this.connect();
    return await this.request("server/grants/create", params);
  }

  async listGrants(): Promise<{ cwd: string; grants: readonly LingAppServerGrant[] }> {
    await this.connect();
    return await this.request("server/grants/list", {});
  }

  async revokeGrant(grantId: string, expectedRevision: number): Promise<{ cwd: string; grant: LingAppServerGrant }> {
    await this.connect();
    return await this.request("server/grants/revoke", { grantId, expectedRevision });
  }

  async readThreadSnapshot(params: LingAppServerThreadSnapshotParams): Promise<LingAppServerThreadSnapshotResult> {
    await this.connect();
    return await this.request("thread/snapshot", params);
  }

  async inspectTurnContext(params: LingAppServerContextInspectParams): Promise<LingAppServerContextInspectResult> {
    await this.connect();
    return await this.request("context/inspect", params);
  }

  async createHandoff(params: LingAppServerHandoffCreateParams): Promise<LingAppServerHandoffResult> {
    await this.connect();
    return await this.request("handoff/create", params);
  }

  async readHandoff(params: LingAppServerHandoffReadParams): Promise<LingAppServerHandoffResult> {
    await this.connect();
    return await this.request("handoff/read", params);
  }

  async resumeHandoff(params: LingAppServerHandoffResumeParams): Promise<LingAppServerHandoffResumeResult> {
    await this.connect();
    return await this.request("handoff/resume", params);
  }

  async readThreadEvents(params: { readonly threadId: string; readonly cursor?: string; readonly limit?: number }): Promise<LingAppServerThreadEventsResult> {
    await this.connect();
    return await this.request("thread/events/read", params);
  }

  async listWorkItems(params: Record<string, unknown> = {}): Promise<unknown> {
    await this.connect();
    return await this.request("workItem/list", params);
  }

  async createWorkItem(params: Record<string, unknown>): Promise<unknown> {
    await this.connect();
    return await this.request("workItem/create", params);
  }

  async acceptWorkItem(params: Record<string, unknown>): Promise<unknown> {
    await this.connect();
    return await this.request("workItem/accept", params);
  }

  async startThread(params: Record<string, unknown>): Promise<unknown> {
    await this.connect();
    return await this.request("thread/start", params);
  }

  async resumeThread(params: LingAppServerThreadSnapshotParams): Promise<LingAppServerThreadSnapshotResult> {
    await this.connect();
    return await this.request("thread/resume", params);
  }

  async startTurn(params: Record<string, unknown>): Promise<unknown> {
    await this.connect();
    return await this.request("turn/start", params);
  }

  async queueTurn(params: Record<string, unknown>): Promise<unknown> {
    await this.connect();
    return await this.request("turn/queue", params);
  }

  async interruptTurn(params: Record<string, unknown>): Promise<unknown> {
    await this.connect();
    return await this.request("turn/interrupt", params);
  }

  async redirectTurn(params: Record<string, unknown>): Promise<unknown> {
    await this.connect();
    return await this.request("turn/interrupt", params);
  }

  async resumeTurn(params: LingAppServerTurnResumeParams): Promise<LingAppServerTurnResumeResult> {
    await this.connect();
    return await this.request("turn/resume", params);
  }

  async respondApproval(params: Record<string, unknown>): Promise<unknown> {
    await this.connect();
    return await this.request("approval/respond", params);
  }

  async respondInput(params: LingAppServerInputRespondParams): Promise<LingAppServerInputRespondResult> {
    await this.connect();
    return await this.request("input/respond", params);
  }

  async captureChanges(): Promise<LingAppServerCaptureChangesResult> {
    await this.connect();
    return await this.request("changes/capture", {});
  }

  async listWorktrees(): Promise<ManagedWorktreeListResponse> {
    await this.connect();
    return await this.request("worktree/list", {});
  }

  async createWorktree(params: LingAppServerWorktreeCreateParams): Promise<LingAppServerWorktreeResult> {
    await this.connect();
    return await this.request("worktree/create", params);
  }

  async refreshWorktree(params: LingAppServerWorktreeTarget): Promise<LingAppServerWorktreeResult> {
    await this.connect();
    return await this.request("worktree/refresh", params);
  }

  async previewWorktreeCleanup(params: LingAppServerWorktreeTarget): Promise<LingAppServerWorktreeCleanupPreview> {
    await this.connect();
    return await this.request("worktree/cleanup/preview", params);
  }

  async cleanupWorktree(params: LingAppServerWorktreeCleanupParams): Promise<LingAppServerWorktreeCleanupResult> {
    await this.connect();
    return await this.request("worktree/cleanup", params);
  }

  async planVerification(params: LingAppServerVerifyPlanParams): Promise<LingAppServerVerifyPlanResult> {
    await this.connect();
    return await this.request("verify/plan", params);
  }

  async startVerification(params: LingAppServerVerifyStartParams): Promise<LingAppServerVerifyOperation> {
    await this.connect();
    return await this.request("verify/start", params);
  }

  async getVerificationStatus(params: LingAppServerVerifyStatusParams): Promise<LingAppServerVerifyStatusResult> {
    await this.connect();
    return await this.request("verify/status", params);
  }

  async cancelVerification(params: LingAppServerVerifyCancelParams): Promise<LingAppServerVerifyCancelResult> {
    await this.connect();
    return await this.request("verify/cancel", params);
  }

  async startReview(params: LingAppServerReviewStartParams): Promise<LingAppServerReviewStartResult> {
    await this.connect();
    return await this.request("review/start", params);
  }

  async getReviewStatus(params: LingAppServerReviewStatusParams): Promise<LingAppServerReviewStatusResult> {
    await this.connect();
    return await this.request("review/status", params);
  }

  async updateReviewFinding(params: LingAppServerReviewFindingUpdateParams): Promise<LingAppServerReviewFindingUpdateResult> {
    await this.connect();
    return await this.request("review/finding/update", params);
  }

  async startSimplify(params: LingAppServerSimplifyStartParams): Promise<LingAppServerSimplifyStartResult> {
    await this.connect();
    return await this.request("simplify/start", params);
  }

  async getSimplifyStatus(params: LingAppServerSimplifyStatusParams): Promise<LingAppServerSimplifyStatusResult> {
    await this.connect();
    return await this.request("simplify/status", params);
  }

  async runDoctor(params: LingAppServerDoctorRunParams = {}): Promise<LingAppServerDoctorRunResult> {
    await this.connect();
    return await this.request("doctor/run", params);
  }

  async initializeInstructions(params: LingAppServerInstructionsInitParams): Promise<LingAppServerInstructionsInitResult> {
    await this.connect();
    return await this.request("instructions/init", params);
  }

  async readWorkItem(workspaceId: string, workItemId: string): Promise<LingAppServerWorkItemSnapshot> {
    const { workItem } = await this.readWorkItemSnapshot(workspaceId, workItemId);
    return workItem;
  }

  async readWorkItemSnapshot(workspaceId: string, workItemId: string): Promise<LingAppServerWorkItemReadResult> {
    await this.connect();
    return await this.request("workItem/read", { workspaceId, workItemId });
  }

  async controlWorkItem(
    action: "pause" | "resume" | "cancel",
    input: LingAppServerWorkItemControlParams,
  ): Promise<LingAppServerWorkItemSnapshot> {
    const { workItem } = await this.submitWorkItemControl(action, input);
    return workItem;
  }

  async submitWorkItemControl(
    action: "pause" | "resume" | "cancel",
    input: LingAppServerWorkItemControlParams,
  ): Promise<LingAppServerWorkItemControlResult> {
    await this.connect();
    return await this.request(`workItem/${action}`, input);
  }

  async readWorkItemCollaboration(params: LingAppServerWorkItemCollaborationReadParams): Promise<LingAppServerWorkItemCollaborationReadResult> {
    await this.connect();
    return await this.request("workItem/collaboration/read", params);
  }

  async appendWorkItemCollaboration(params: LingAppServerWorkItemCollaborationAppendParams): Promise<LingAppServerWorkItemCollaborationAppendResult> {
    await this.connect();
    return await this.request("workItem/collaboration/append", params);
  }

  async readWorkItemDeliberation(params: Omit<LingAppServerWorkItemCollaborationReadParams, "kind">): Promise<LingAppServerWorkItemCollaborationReadResult> {
    return await this.readWorkItemCollaboration({ ...params, kind: "deliberation" });
  }

  async readWorkItemCoordination(params: Omit<LingAppServerWorkItemCollaborationReadParams, "kind">): Promise<LingAppServerWorkItemCollaborationReadResult> {
    return await this.readWorkItemCollaboration({ ...params, kind: "coordination" });
  }

  async subscribe(params: LingAppServerSubscriptionParams): Promise<LingAppServerSubscriptionResult> {
    await this.connect();
    const method = params.threadId ? "thread/subscribe" : "workItem/subscribe";
    const key = subscriptionKey(method, params);
    const subscription = {
      method,
      params,
      cursor: params.cursor,
    } satisfies TrackedSubscription;
    return await this.requestSubscription(key, subscription, params);
  }

  async registerExternalAgent(params: LingAppServerExternalAgentRegisterParams): Promise<LingAppServerExternalAgentRegisterResult> {
    await this.connect();
    return await this.request("externalAgent/register", params);
  }

  async readExternalAgentCapabilities(params: LingAppServerExternalAgentCapabilitiesParams): Promise<LingAppServerExternalAgentCapabilitiesResult> {
    await this.connect();
    return await this.request("externalAgent/capabilities/read", params);
  }

  async startExternalAgentTask(params: LingAppServerExternalAgentTaskStartParams): Promise<LingAppServerExternalAgentTaskStartResult> {
    await this.connect();
    return await this.request("externalAgent/task/start", params);
  }

  async reconnectExternalAgentTask(params: LingAppServerExternalAgentTaskReconnectParams): Promise<LingAppServerExternalAgentTaskReconnectResult> {
    await this.connect();
    return await this.request("externalAgent/task/reconnect", params);
  }

  async cancelExternalAgentTask(params: LingAppServerExternalAgentTaskCancelParams): Promise<LingAppServerExternalAgentTaskCancelResult> {
    await this.connect();
    return await this.request("externalAgent/task/cancel", params);
  }

  onNotification(listener: (notification: LingAppServerNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onServerRequest(listener: (request: LingAppServerServerRequest) => void): () => void {
    this.serverRequestListeners.add(listener);
    return () => this.serverRequestListeners.delete(listener);
  }

  close(): void {
    this.manuallyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    this.connectPromise = undefined;
    socket?.close(1000, "client_closed");
    const error = new Error("Ling App Server connection closed.");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private async openAndInitialize(): Promise<LingAppServerInitializeResult> {
    const socket = this.options.createSocket(this.options.url);
    this.socket = socket;
    for (const subscription of this.subscriptions.values()) subscription.subscriptionId = undefined;
    const opened = waitForSocketOpen(socket, this.options.requestTimeoutMs ?? 30_000);
    attachSocketListener(socket, "message", (event) => {
      if (this.socket === socket) this.handleMessage(readSocketMessage(event));
    });
    attachSocketListener(socket, "close", () => this.handleClose(socket));
    attachSocketListener(socket, "error", () => this.handleClose(socket));
    try {
      await opened;
      if (this.socket !== socket) throw new Error("Ling App Server connection closed.");
      const initialized = await this.request<LingAppServerInitializeResult>("initialize", {
        protocolVersions: ["ling-app-server/1"],
        clientInfo: this.options.clientInfo,
        requiredCapabilities: this.options.requiredCapabilities,
        optionalCapabilities: this.options.optionalCapabilities,
        workspaceScope: this.options.workspaceScope,
      });
      if (initialized?.protocolVersion !== "ling-app-server/1") {
        throw Object.assign(new Error("The endpoint does not support Ling App Server protocol 1."), { code: "protocol_version_unsupported" });
      }
      socket.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
      this.reconnectAttempt = 0;
      await this.replaySubscriptions(socket);
      if (this.socket !== socket) throw new Error("Ling App Server connection closed.");
      return initialized;
    } catch (error) {
      if (this.socket === socket) socket.close(1000, "initialize_failed");
      throw error;
    }
  }

  private request<T>(method: string, params: unknown, onResult?: (result: T) => void): Promise<T> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error("Ling App Server is not connected."));
    const id = this.nextId++;
    const key = `${typeof id}:${String(id)}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(Object.assign(new Error(`Ling App Server response timed out for ${method}.`), { code: "rpc_timeout" }));
      }, this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(key, {
        resolve: (value) => {
          clearTimeout(timer);
          try {
            onResult?.(value as T);
            resolve(value as T);
          } catch (error) {
            reject(error);
          }
        },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      try {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(key);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleMessage(value: string): void {
    let parsed: LingAppServerResponse | LingAppServerNotification | LingAppServerServerRequest;
    try {
      parsed = JSON.parse(value) as LingAppServerResponse | LingAppServerNotification;
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    if ("method" in parsed) {
      if ("id" in parsed && (typeof parsed.id === "string" || typeof parsed.id === "number")) {
        for (const listener of this.serverRequestListeners) listener(parsed as LingAppServerServerRequest);
      } else {
        for (const listener of this.notificationListeners) listener(parsed);
        this.updateSubscriptionCursor(parsed);
      }
      return;
    }
    if (parsed.id !== undefined) {
      const pending = this.pending.get(`${typeof parsed.id}:${String(parsed.id)}`);
      if (!pending) return;
      this.pending.delete(`${typeof parsed.id}:${String(parsed.id)}`);
      if (parsed.error) {
        const error = new Error(parsed.error.message);
        Object.assign(error, { code: parsed.error.data?.code, numericCode: parsed.error.code });
        pending.reject(error);
      } else {
        pending.resolve(parsed.result);
      }
      return;
    }
  }

  private handleClose(socket: LingAppServerSocket): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    const error = new Error("Ling App Server connection closed.");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.connectPromise = undefined;
    this.scheduleReconnect();
  }

  private updateSubscriptionCursor(notification: LingAppServerNotification): void {
    const params = notification.params;
    if (typeof params !== "object" || params === null || Array.isArray(params)) return;
    const record = params as Record<string, unknown>;
    const subscriptionId = typeof record.subscriptionId === "string" ? record.subscriptionId : undefined;
    const event = record.event as { readonly seq?: number } | undefined;
    const window = record.window as { readonly nextAfterSeq?: number } | undefined;
    const cursor = typeof record.cursor === "string" ? record.cursor : Number.isSafeInteger(event?.seq) ? String(event!.seq) : undefined;
    if (!subscriptionId || !cursor) return;
    const seq = event?.seq ?? window?.nextAfterSeq ?? (/^\d+$/u.test(cursor) ? Number(cursor) : undefined);
    const afterSeq = Number.isSafeInteger(seq) ? seq : undefined;
    for (const [key, subscription] of this.subscriptions) {
      if (subscription.subscriptionId !== subscriptionId) continue;
      if (subscription.cursor && subscription.afterSeq !== undefined && afterSeq !== undefined && afterSeq <= subscription.afterSeq) continue;
      this.subscriptions.set(key, { ...subscription, cursor, afterSeq });
    }
  }

  private scheduleReconnect(): void {
    if (this.manuallyClosed || this.options.autoReconnect === false || this.reconnectTimer) return;
    const base = Math.max(10, this.options.reconnectDelayMs ?? 250);
    const max = Math.max(base, this.options.maxReconnectDelayMs ?? 10_000);
    const delay = Math.min(max, base * 2 ** Math.min(this.reconnectAttempt, 6));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => undefined);
    }, delay);
  }

  private async replaySubscriptions(socket: LingAppServerSocket): Promise<void> {
    const tracked = [...this.subscriptions.entries()];
    for (const [key, subscription] of tracked) {
      if (this.socket !== socket) return;
      const params = subscription.cursor ? { ...subscription.params, cursor: subscription.cursor } : subscription.params;
      try {
        const result = await this.requestSubscription(key, subscription, params);
        if (result.disposition === "snapshot_required") {
          const method = subscription.method === "thread/subscribe" ? "thread/resync/required" : "workItem/resync/required";
          const { threadId, workItemId, workspaceId } = subscription.params;
          for (const listener of this.notificationListeners) {
            listener({ jsonrpc: "2.0", method, params: { ...result, threadId, workItemId, workspaceId } });
          }
        }
      } catch {
        // A failed replay remains tracked and will be retried on the next reconnect.
      }
    }
  }

  private requestSubscription(
    key: string, subscription: TrackedSubscription, params: LingAppServerSubscriptionParams,
  ): Promise<LingAppServerSubscriptionResult> {
    return this.request<LingAppServerSubscriptionResult>(subscription.method, params, result => {
      // The acknowledgement and replay frames can arrive in one transport callback.
      if (result.disposition === "snapshot_required") {
        this.subscriptions.delete(key);
      } else {
        this.subscriptions.set(key, { ...subscription, subscriptionId: result.subscriptionId,
          afterSeq: result.window?.requestedAfterSeq ?? subscription.afterSeq });
      }
    });
  }
}

function subscriptionKey(method: TrackedSubscription["method"], params: LingAppServerSubscriptionParams): string {
  return `${method}:${params.workspaceId ?? ""}:${params.threadId ?? ""}:${params.workItemId ?? ""}`;
}

function attachSocketListener(socket: LingAppServerSocket, type: "open" | "message" | "close" | "error", listener: (event: unknown) => void): void {
  if (socket.addEventListener) {
    socket.addEventListener(type, listener);
    return;
  }
  socket.on?.(type, listener);
}

function waitForSocketOpen(socket: LingAppServerSocket, timeoutMs: number): Promise<void> {
  if (socket.readyState === 1) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (event: unknown): void => {
      cleanup();
      reject(event instanceof Error ? event : new Error("Ling App Server connection failed."));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.removeEventListener?.("open", onOpen);
      socket.removeEventListener?.("error", onError);
      socket.off?.("open", onOpen);
      socket.off?.("error", onError);
      socket.removeEventListener?.("close", onError);
      socket.off?.("close", onError);
    };
    const timer = setTimeout(() => onError(new Error("Ling App Server connection timed out.")), timeoutMs);
    attachSocketListener(socket, "open", onOpen);
    attachSocketListener(socket, "error", onError);
    attachSocketListener(socket, "close", onError);
  });
}

function readSocketMessage(event: unknown): string {
  if (typeof event === "string") return event;
  if (event instanceof Uint8Array) return new TextDecoder().decode(event);
  if (typeof event === "object" && event !== null && "data" in event) {
    return readSocketMessage((event as { readonly data?: unknown }).data);
  }
  return String(event);
}
