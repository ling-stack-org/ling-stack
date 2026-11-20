import type {
  LingAppServerDoctorRunParams,
  LingAppServerDoctorRunResult,
  LingAppServerCapability,
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
  LingAppServerInitializeParams,
  LingAppServerInitializeResult,
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
  LingAppServerWorkItemSnapshot,
  LingAppServerWorkItemCollaborationAppendParams,
  LingAppServerWorkItemCollaborationAppendResult,
  LingAppServerWorkItemCollaborationReadParams,
  LingAppServerWorkItemCollaborationReadResult,
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
}

export interface LingAppServerNotification {
  readonly jsonrpc: "2.0";
  readonly method: LingAppServerNotificationMethod | string;
  readonly params?: unknown;
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

export class LingAppServerClient {
  private readonly options: LingAppServerClientOptions;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly notificationListeners = new Set<(notification: LingAppServerNotification) => void>();
  private socket?: LingAppServerSocket;
  private nextId = 1;
  private connectPromise?: Promise<LingAppServerInitializeResult>;

  constructor(options: LingAppServerClientOptions) {
    this.options = options;
  }

  connect(): Promise<LingAppServerInitializeResult> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.openAndInitialize();
    return this.connectPromise;
  }

  async ping(): Promise<{ readonly ok: boolean; readonly connectionId: string; readonly serverTime: string }> {
    await this.connect();
    return await this.request("server/ping", {});
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

  async runDoctor(params: LingAppServerDoctorRunParams = {}): Promise<LingAppServerDoctorRunResult> {
    await this.connect();
    return await this.request("doctor/run", params);
  }

  async initializeInstructions(params: LingAppServerInstructionsInitParams): Promise<LingAppServerInstructionsInitResult> {
    await this.connect();
    return await this.request("instructions/init", params);
  }

  async readWorkItem(workspaceId: string, workItemId: string): Promise<LingAppServerWorkItemSnapshot> {
    await this.connect();
    return await this.request("workItem/read", { workspaceId, workItemId });
  }

  async controlWorkItem(
    action: "pause" | "resume" | "cancel",
    input: {
      readonly workspaceId: string;
      readonly workItemId: string;
      readonly expectedWorkItemRevision: number;
      readonly expectedControlGeneration: number;
      readonly idempotencyKey: string;
      readonly actorId: string;
      readonly reason?: string;
    },
  ): Promise<LingAppServerWorkItemSnapshot> {
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
    return await this.request("workItem/subscribe", params);
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

  close(): void {
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
    const opened = waitForSocketOpen(socket);
    attachSocketListener(socket, "message", (event) => this.handleMessage(readSocketMessage(event)));
    attachSocketListener(socket, "close", () => this.handleClose());
    attachSocketListener(socket, "error", () => this.handleClose());
    await opened;
    return await this.request("initialize", {
      protocolVersions: ["ling-app-server/1"],
      clientInfo: this.options.clientInfo,
      requiredCapabilities: this.options.requiredCapabilities,
      optionalCapabilities: this.options.optionalCapabilities,
      workspaceScope: this.options.workspaceScope,
    });
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error("Ling App Server is not connected."));
    const id = this.nextId++;
    const key = `${typeof id}:${String(id)}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(key, { resolve: (value) => resolve(value as T), reject });
      try {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (error) {
        this.pending.delete(key);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleMessage(value: string): void {
    let parsed: LingAppServerResponse | LingAppServerNotification;
    try {
      parsed = JSON.parse(value) as LingAppServerResponse | LingAppServerNotification;
    } catch {
      return;
    }
    if ("id" in parsed && parsed.id !== undefined) {
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
    if ("method" in parsed) {
      for (const listener of this.notificationListeners) listener(parsed as LingAppServerNotification);
    }
  }

  private handleClose(): void {
    if (!this.socket) return;
    this.socket = undefined;
    const error = new Error("Ling App Server connection closed.");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function attachSocketListener(socket: LingAppServerSocket, type: "open" | "message" | "close" | "error", listener: (event: unknown) => void): void {
  if (socket.addEventListener) {
    socket.addEventListener(type, listener);
    return;
  }
  socket.on?.(type, listener);
}

function waitForSocketOpen(socket: LingAppServerSocket): Promise<void> {
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
      socket.removeEventListener?.("open", onOpen);
      socket.removeEventListener?.("error", onError);
      socket.off?.("open", onOpen);
      socket.off?.("error", onError);
    };
    attachSocketListener(socket, "open", onOpen);
    attachSocketListener(socket, "error", onError);
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
