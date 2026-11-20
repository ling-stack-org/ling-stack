import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_WORKSPACE_ID,
  type ControlPlaneDomain,
  type ControlPlaneEvent,
  type RunEventEnvelope,
  type RunSession,
  type WorkItem,
  type WorkItemSourceType,
  type WorkItemStatus,
} from "@ling-stack/core";
import {
  LING_APP_SERVER_IMPLEMENTED_CAPABILITIES,
  LING_APP_SERVER_METHODS,
  LING_APP_SERVER_NOTIFICATION_METHODS,
  LING_APP_SERVER_PROTOCOL_VERSION,
  LING_PRODUCT_VERSION,
  type ControlPlaneSubscribeResult,
} from "@ling-stack/contracts";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { DaemonContext } from "../context.js";
import { daemonRequestIsAuthorized } from "./request-auth.js";
import { maybeScheduleRunTerminalReport } from "../features/channels/terminal-report-coordinator.js";
import { ensureRunCancelled } from "../features/runs/cancellation.js";
import { HttpError } from "../errors.js";
import {
  CONTROL_PLANE_POLL_DEFAULT_LIMIT,
  CONTROL_PLANE_POLL_MAX_LIMIT,
  CONTROL_PLANE_SSE_FLUSH_MS,
  CONTROL_PLANE_SSE_QUEUE_HARD_LIMIT,
  CONTROL_PLANE_SSE_QUEUE_WARNING_THRESHOLD,
} from "../features/control-plane/events.js";
import { coalesceAndSortControlPlaneEvents } from "../features/control-plane/event-queue.js";
import {
  ControlPlaneBadDomainError,
  ControlPlaneBadRequestError,
  buildControlPlaneSnapshot,
  listControlPlaneEventsForResponse,
  parseControlPlaneDomains,
} from "../features/control-plane/processors.js";
import { appendControlPlaneEvent } from "../features/control-plane/events.js";
import { executeRunRequest, type RunExecutionSink } from "../features/runs/orchestrator.js";
import { parseRunRequest } from "../features/runs/schemas.js";
import { projectPublicRunSession } from "../features/runs/public-execution-snapshots.js";
import { projectPublicLingThread, projectPublicLingTurn } from "../features/runs/public-execution-snapshots.js";
import { maybeQueueGoalContinuation, maybeStartNextRunInterventionContinuation } from "../features/runs/interventions.js";
import { RpcOutboundWriter, type RpcOutboundFrame } from "./rpc-outbound.js";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  readonly jsonrpc?: string;
  readonly id?: JsonRpcId;
  readonly method?: string;
  readonly params?: unknown;
}

interface RpcSubscription {
  readonly id: string;
  readonly cwd: string;
  readonly domains: readonly ControlPlaneDomain[];
  readonly entityType?: string;
  readonly entityId?: string;
  readonly closeHub: () => void;
  readonly queue: { readonly event: ControlPlaneEvent; readonly frame: RpcOutboundFrame }[];
  readonly upstreamKey: string;
  readonly queueKey: string;
  closed: boolean;
  flushTimer?: NodeJS.Timeout;
}

export interface RpcWebSocketServerHandle {
  close(): void;
}

const APP_SERVER_RPC_PATH = "/app-server/rpc";
export function attachRpcWebSocketServer(server: Server, context: DaemonContext): RpcWebSocketServerHandle {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  let closed = false;
  const handleUpgrade: Parameters<Server["on"]>[1] = (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${context.config.host}:${context.config.port}`}`);
    if (url.pathname !== "/rpc/stream" && url.pathname !== APP_SERVER_RPC_PATH) {
      return;
    }
    if (!context.config.transports.localWebSocketRpc) {
      rejectUpgrade(socket, 404, "WebSocket RPC transport is disabled");
      return;
    }
    if (!daemonRequestIsAuthorized(context.config.authToken, request.headers.authorization)) {
      rejectUpgrade(socket, 401, "A valid bearer token is required for WebSocket RPC access.");
      return;
    }
    if (!url.searchParams.get("cwd")) {
      rejectUpgrade(socket, 400, "cwd query parameter is required");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  };
  server.on("upgrade", handleUpgrade);
  wss.on("connection", (ws, request) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${context.config.host}:${context.config.port}`}`);
    const connection = new RpcConnection(
      ws,
      url.searchParams.get("cwd") ?? context.config.defaultWorkspaceCwd,
      context,
      url.pathname === APP_SERVER_RPC_PATH,
    );
    connection.start();
  });
  const closeAll = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    server.off("upgrade", handleUpgrade);
    for (const client of wss.clients) {
      client.terminate();
    }
    wss.close();
  };
  server.once("close", closeAll);
  return { close: closeAll };
}

class RpcConnection {
  private readonly subscriptions = new Map<string, RpcSubscription>();
  private readonly outbound: RpcOutboundWriter;
  private readonly runCloseListeners = new Set<() => void>();
  private nextSubscriptionId = 1;
  private initialized = false;
  private closed = false;
  private readonly connectionId = `conn_${randomUUID()}`;
  private readonly pendingRequests = new Set<string>();
  private readonly cancelledRequests = new Set<string>();
  private readonly onMessage = (data: RawData): void => { void this.handleMessage(data); };
  private readonly onConnectionClose = (): void => this.close();
  private readonly onConnectionError = (): void => this.close();

  constructor(
    private readonly ws: WebSocket,
    private readonly defaultCwd: string,
    private readonly context: DaemonContext,
    private readonly appServer: boolean,
  ) {
    this.outbound = new RpcOutboundWriter(ws, { onClose: () => this.close() });
  }

  start(): void {
    this.ws.on("message", this.onMessage);
    this.ws.on("close", this.onConnectionClose);
    this.ws.on("error", this.onConnectionError);
  }

  private async handleMessage(data: RawData): Promise<void> {
    if (this.closed) return;
    const request = parseJsonRpcRequest(data);
    if (!request) {
      this.sendError(null, -32700, "parse_error", "Request must be a JSON-RPC object.");
      return;
    }
    const id = request.id ?? null;
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      this.sendError(id, -32600, "invalid_request", "Request must include jsonrpc=\"2.0\" and method.");
      return;
    }
    if (request.method !== "initialize" && !this.initialized) {
      this.sendError(id, -32000, "not_initialized", "Call initialize before other RPC methods.");
      return;
    }

    const requestKey = request.id === undefined ? undefined : jsonRpcIdKey(request.id);
    if (requestKey) this.pendingRequests.add(requestKey);
    try {
      if (request.method === "$/cancelRequest") {
        const target = readParamsRecord(request.params).requestId;
        if ((typeof target === "string" || typeof target === "number" || target === null) &&
          this.pendingRequests.has(jsonRpcIdKey(target))) {
          this.cancelledRequests.add(jsonRpcIdKey(target));
        }
        return;
      }
      if (request.method === "controlPlane.subscribe") {
        if (request.id === undefined) {
          throw rpcError(-32600, "subscription_response_required", "controlPlane.subscribe requires a request id.");
        }
        const prepared = this.prepareControlPlaneSubscription(request.params);
        if (this.send({ jsonrpc: "2.0", id, result: prepared.result })) prepared.activate?.();
        return;
      }
      if (request.method === "workItem/subscribe") {
        if (request.id === undefined) {
          throw rpcError(-32600, "subscription_response_required", "workItem/subscribe requires a request id.");
        }
        const record = readParamsRecord(request.params);
        const workItemId = readStringField(record, "workItemId");
        const prepared = this.prepareControlPlaneSubscription({ ...record, domains: ["work_items"] }, {
          entityType: "work_item",
          entityId: workItemId,
        });
        if (this.send({ jsonrpc: "2.0", id, result: prepared.result })) prepared.activate?.();
        return;
      }
      if (request.method === "thread/subscribe") {
        if (request.id === undefined) {
          throw rpcError(-32600, "subscription_response_required", "thread/subscribe requires a request id.");
        }
        const prepared = this.prepareControlPlaneSubscription({
          ...readParamsRecord(request.params),
          domains: ["runs", "work_items", "work_units"],
        });
        if (this.send({ jsonrpc: "2.0", id, result: prepared.result })) prepared.activate?.();
        return;
      }
      const result = await this.dispatch(request.method, request.params);
      if (request.id !== undefined && !this.cancelledRequests.has(requestKey!)) {
        this.send({ jsonrpc: "2.0", id, result });
      }
    } catch (error) {
      const normalized = normalizeRpcError(error);
      if (request.id === undefined || !this.cancelledRequests.has(requestKey!)) {
        this.sendError(id, normalized.jsonRpcCode, normalized.code, normalized.message);
      }
    } finally {
      if (requestKey) {
        this.pendingRequests.delete(requestKey);
        this.cancelledRequests.delete(requestKey);
      }
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "initialize":
        this.validateInitializeParams(params);
        this.initialized = true;
        return this.appServer ? {
          protocolVersion: LING_APP_SERVER_PROTOCOL_VERSION,
          serverInfo: { name: "ling-stack-daemon", version: LING_PRODUCT_VERSION },
          connectionId: this.connectionId,
          effectiveScopes: ["controlPlane.read", "runs.control"],
          capabilities: LING_APP_SERVER_IMPLEMENTED_CAPABILITIES,
          limits: {
            maxInboundFrameBytes: 1024 * 1024,
            maxOutboundFrameBytes: 128 * 1024,
          },
        } : {
          ok: true,
          transport: "websocket",
          cwd: this.defaultCwd,
          features: {
            transports: this.context.config.transports,
            channels: this.context.config.channels,
          },
        };
      case "server/ping":
        return { ok: true, connectionId: this.connectionId, serverTime: new Date().toISOString() };
      case "server/capabilities":
        return {
          protocolVersion: LING_APP_SERVER_PROTOCOL_VERSION,
          capabilities: LING_APP_SERVER_IMPLEMENTED_CAPABILITIES,
          methods: LING_APP_SERVER_METHODS,
          notifications: LING_APP_SERVER_NOTIFICATION_METHODS,
        };
      case "workspace/list":
        return { workspaces: [{ workspaceId: DEFAULT_WORKSPACE_ID, cwd: this.defaultCwd }] };
      case "workspace/read":
        return { workspaceId: DEFAULT_WORKSPACE_ID, cwd: readRpcCwd(readParamsRecord(params), this.defaultCwd) };
      case "provider/list":
        return this.readControlPlaneDomain(params, "providers");
      case "skill/list":
        return this.readControlPlaneDomain(params, "skills");
      case "thread/start":
        return this.startThread(params);
      case "thread/read":
        return this.readThread(params);
      case "thread/resume":
        return this.readThread(params);
      case "thread/list":
        return this.listThreads(params);
      case "thread/turns/list":
        return this.listThreadTurns(params);
      case "turn/start":
        return this.startTurn(params);
      case "turn/queue":
        return this.queueTurn(params);
      case "turn/interrupt":
        return this.interruptTurn(params);
      case "turn/steer":
        throw rpcError(-32032, "steer_unsupported", "In-turn steering is not available on this Runner connection; queue or interrupt the Turn.");
      case "turn/resume":
        return this.resumeTurn(params);
      case "daemon.health":
        return {
          ok: true,
          service: "ling-stack-daemon",
          defaultWorkspaceCwd: this.context.config.defaultWorkspaceCwd,
          features: {
            channels: this.context.config.channels,
            transports: this.context.config.transports,
          },
        };
      case "controlPlane.snapshot":
        return buildControlPlaneSnapshot(this.context, this.readControlPlaneParams(params));
      case "controlPlane.events": {
        const parsed = this.readControlPlaneEventParams(params);
        return listControlPlaneEventsForResponse(this.context, parsed);
      }
      case "controlPlane.unsubscribe":
        return this.unsubscribeControlPlane(params);
      case "runs.start":
        return this.startRun(params);
      case "runs.cancel":
        return this.cancelRun(params);
      case "workItem/list":
        return this.listWorkItems(params);
      case "workItem/create":
        return this.createWorkItem(params);
      case "workItem/accept":
        return this.acceptWorkItem(params);
      case "workItem/clarify":
        return this.clarifyWorkItem(params);
      case "workItem/read":
        return this.readWorkItem(params);
      case "workItem/pause":
        return this.controlWorkItem("pause", params);
      case "workItem/resume":
        return this.controlWorkItem("resume", params);
      case "workItem/cancel":
        return this.controlWorkItem("cancel", params);
      case "workItem/unsubscribe":
        return this.unsubscribeControlPlane(params);
      default:
        throw rpcError(-32601, "method_not_found", `Unsupported RPC method: ${method}`);
    }
  }

  private validateInitializeParams(params: unknown): void {
    if (!this.appServer || params === undefined) return;
    const record = readParamsRecord(params);
    const versions = record.protocolVersions;
    if (versions !== undefined && (!Array.isArray(versions) || !versions.every(value => typeof value === "string"))) {
      throw rpcError(-32602, "invalid_params", "protocolVersions must be an array of strings.");
    }
    if (Array.isArray(versions) && !versions.includes(LING_APP_SERVER_PROTOCOL_VERSION)) {
      throw rpcError(-32010, "protocol_version_unsupported", "The requested protocol versions are not supported.");
    }
    const requiredCapabilities = record.requiredCapabilities;
    if (requiredCapabilities !== undefined && (!Array.isArray(requiredCapabilities) ||
      !requiredCapabilities.every(value => typeof value === "string"))) {
      throw rpcError(-32602, "invalid_params", "requiredCapabilities must be an array of strings.");
    }
    const missing = Array.isArray(requiredCapabilities)
      ? requiredCapabilities.filter(value => !(LING_APP_SERVER_IMPLEMENTED_CAPABILITIES as readonly string[]).includes(value))
      : [];
    if (missing.length > 0) {
      throw rpcError(-32011, "required_capability_unavailable", `Required capabilities are unavailable: ${missing.join(", ")}`);
    }
  }

  private listWorkItems(params: unknown): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const store = this.context.storeRegistry.getStore(cwd);
    const items = store.listWorkItems({
      channelId: readOptionalStringField(record, "channelId"),
      status: readOptionalWorkItemStatus(record.status),
      sourceType: readOptionalWorkItemSourceType(record.sourceType),
      assigneeTeammateId: readOptionalStringField(record, "assigneeTeammateId"),
      limit: readOptionalIntegerField(record, "limit"),
    }, new Date().toISOString());
    return { cwd, workItems: items.map(item => projectWorkItemSnapshot(item)) };
  }

  private readControlPlaneDomain(params: unknown, domain: ControlPlaneDomain): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const snapshot = buildControlPlaneSnapshot(this.context, { cwd, domains: [domain] });
    return { cwd, workspaceId: snapshot.workspaceId, domain, snapshot: snapshot.domains[domain] };
  }

  private createWorkItem(params: unknown): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const sourceType = readOptionalWorkItemSourceType(record.sourceType) ?? "manual";
    const sourceId = readStringField(record, "sourceId");
    const title = readStringField(record, "title");
    const store = this.context.storeRegistry.getStore(cwd);
    const workItem = store.upsertWorkItem({
      id: readOptionalStringField(record, "workItemId"),
      sourceType,
      sourceId,
      title,
      description: readOptionalStringField(record, "description"),
      priority: readOptionalWorkItemPriority(record.priority),
      labels: Array.isArray(record.labels) && record.labels.every((value) => typeof value === "string") ? record.labels as string[] : undefined,
    }, new Date().toISOString());
    const idempotencyKey = readOptionalStringField(record, "idempotencyKey");
    appendControlPlaneEvent(store, this.context.controlPlaneEvents, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      cwd,
      domain: "work_items",
      entityType: "work_item",
      entityId: workItem.id,
      action: "work_item.created",
      ...(idempotencyKey ? { idempotencyKey } : {}),
      data: { workItemId: workItem.id, revision: workItem.revision, status: workItem.status },
    });
    return { cwd, workItem: projectWorkItemSnapshot(workItem) };
  }

  private acceptWorkItem(params: unknown): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const workItemId = readStringField(record, "workItemId");
    const store = this.context.storeRegistry.getStore(cwd);
    const workItem = store.getWorkItem(workItemId);
    if (!workItem) throw rpcError(-32040, "workspace_binding_invalid", `Work Item was not found: ${workItemId}`);
    const expectedRevision = readOptionalIntegerField(record, "expectedWorkItemRevision");
    if (expectedRevision !== undefined && expectedRevision !== workItem.revision) {
      throw rpcError(-32030, "stale_revision", "The Work Item revision is stale.");
    }
    appendControlPlaneEvent(store, this.context.controlPlaneEvents, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      cwd,
      domain: "work_items",
      entityType: "work_item",
      entityId: workItem.id,
      action: "work_item.accepted",
      data: { workItemId: workItem.id, revision: workItem.revision, actorId: readOptionalStringField(record, "actorId") },
    });
    return { cwd, accepted: true, workItem: projectWorkItemSnapshot(workItem) };
  }

  private clarifyWorkItem(params: unknown): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const workItemId = readStringField(record, "workItemId");
    const store = this.context.storeRegistry.getStore(cwd);
    const workItem = store.getWorkItem(workItemId);
    if (!workItem) throw rpcError(-32040, "workspace_binding_invalid", `Work Item was not found: ${workItemId}`);
    return {
      cwd,
      workItem: projectWorkItemSnapshot(workItem),
      clarification: {
        status: "required",
        question: readOptionalStringField(record, "question") ?? "Please clarify the Work Item target or acceptance criteria.",
      },
    };
  }

  private startThread(params: unknown): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const store = this.context.storeRegistry.getStore(cwd);
    const title = readOptionalStringField(record, "title") ?? "Ling App Server thread";
    const objective = readOptionalStringField(record, "objective") ?? title;
    const kind = readOptionalStringField(record, "kind") ?? "conversation";
    const thread = store.createLingThread({
      id: readOptionalStringField(record, "threadId"),
      kind: readLingThreadKind(kind),
      title,
      objective,
      status: "open",
    }, new Date().toISOString());
    appendControlPlaneEvent(store, this.context.controlPlaneEvents, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      cwd,
      domain: "runs",
      entityType: "thread",
      entityId: thread.id,
      action: "thread.started",
      data: { threadId: thread.id, status: thread.status },
    });
    return { cwd, thread: projectPublicLingThread(thread) };
  }

  private readThread(params: unknown): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const threadId = readStringField(record, "threadId");
    const store = this.context.storeRegistry.getStore(cwd);
    const thread = store.getLingThread(threadId);
    if (!thread) throw rpcError(-32040, "workspace_binding_invalid", `Thread was not found: ${threadId}`);
    return {
      cwd,
      thread: projectPublicLingThread(thread),
      goal: store.getLingThreadGoal(threadId) ?? null,
    };
  }

  private listThreads(params: unknown): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const store = this.context.storeRegistry.getStore(cwd);
    return {
      cwd,
      threads: store.listLingThreads({ limit: readOptionalIntegerField(record, "limit") }).map(projectPublicLingThread),
    };
  }

  private listThreadTurns(params: unknown): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const threadId = readStringField(record, "threadId");
    const store = this.context.storeRegistry.getStore(cwd);
    const thread = store.getLingThread(threadId);
    if (!thread) throw rpcError(-32040, "workspace_binding_invalid", `Thread was not found: ${threadId}`);
    const turns = store.listLingTurns({ threadId, limit: readOptionalIntegerField(record, "limit") });
    return {
      cwd,
      threadId,
      turns: turns.map((turn) => projectPublicLingTurn(turn, thread)),
      runLinks: turns.flatMap((turn) => store.listLingTurnRuns(turn.id)),
    };
  }

  private resumeTurn(params: unknown): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const turnId = readStringField(record, "turnId");
    const store = this.context.storeRegistry.getStore(cwd);
    const turn = store.getLingTurn(turnId);
    if (!turn) throw rpcError(-32040, "workspace_binding_invalid", `Turn was not found: ${turnId}`);
    const thread = store.getLingThread(turn.threadId);
    if (!thread) throw rpcError(-32040, "workspace_binding_invalid", `Thread was not found: ${turn.threadId}`);
    const run = turn.activeRunId ? store.getRun(turn.activeRunId) : turn.lastRunId ? store.getRun(turn.lastRunId) : undefined;
    return {
      cwd,
      thread: projectPublicLingThread(thread),
      turn: projectPublicLingTurn(turn, thread),
      run: run ? projectPublicRunSession(run, store) : null,
      runLinks: store.listLingTurnRuns(turn.id),
    };
  }

  private startTurn(params: unknown): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const threadId = readStringField(record, "threadId");
    const store = this.context.storeRegistry.getStore(cwd);
    const thread = store.getLingThread(threadId);
    if (!thread) throw rpcError(-32040, "workspace_binding_invalid", `Thread was not found: ${threadId}`);
    const instruction = readOptionalStringField(record, "userInstruction") ?? readOptionalStringField(record, "message");
    if (!instruction?.trim()) throw rpcError(-32602, "invalid_params", "userInstruction or message is required.");
    const turn = store.createLingTurn({
      id: readOptionalStringField(record, "turnId"),
      threadId,
      kind: readLingTurnKind(readOptionalStringField(record, "kind") ?? "initial_request"),
      title: readOptionalStringField(record, "title") ?? instruction.slice(0, 120),
      userInstruction: instruction,
      createdByActor: "local-user",
    }, new Date().toISOString());
    appendControlPlaneEvent(store, this.context.controlPlaneEvents, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      cwd,
      domain: "runs",
      entityType: "turn",
      entityId: turn.id,
      action: "turn.started",
      data: { threadId, turnId: turn.id, status: turn.status },
    });
    const shouldRun = record.execute === true || record.task !== undefined || record.providerPresetId !== undefined || record.provider !== undefined;
    if (!shouldRun) {
      return { cwd, thread: projectPublicLingThread(thread), turn: projectPublicLingTurn(turn, thread) };
    }
    const task = record.task ?? { id: `task_${turn.id}`, title: turn.title, prompt: instruction };
    const runRequest = { ...record, cwd, threadId, turnId: turn.id, task };
    const accepted = this.startRun(runRequest);
    return { cwd, thread: projectPublicLingThread(thread), turn: projectPublicLingTurn(turn, thread), run: accepted };
  }

  private queueTurn(params: unknown): unknown {
    const record = readParamsRecord(params);
    return this.startTurn({ ...record, kind: "queued_followup", execute: false });
  }

  private interruptTurn(params: unknown): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const turnId = readStringField(record, "turnId");
    const store = this.context.storeRegistry.getStore(cwd);
    const turn = store.getLingTurn(turnId);
    if (!turn) throw rpcError(-32040, "workspace_binding_invalid", `Turn was not found: ${turnId}`);
    if (!turn.activeRunId) {
      const thread = store.getLingThread(turn.threadId);
      return { cwd, turn: projectPublicLingTurn(turn, thread) };
    }
    return this.cancelRun({ cwd, runId: turn.activeRunId });
  }

  private readWorkItem(params: unknown): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const workItemId = readStringField(record, "workItemId");
    const workItem = this.context.storeRegistry.getStore(cwd).getWorkItem(workItemId);
    if (!workItem) {
      throw rpcError(-32040, "workspace_binding_invalid", `Work Item was not found: ${workItemId}`);
    }
    return { cwd, workItem: projectWorkItemSnapshot(workItem) };
  }

  private controlWorkItem(action: "pause" | "resume" | "cancel", params: unknown): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const workItemId = readStringField(record, "workItemId");
    const actorId = readStringField(record, "actorId");
    const idempotencyKey = readStringField(record, "idempotencyKey");
    const expectedRevision = readIntegerField(record, "expectedWorkItemRevision", "expectedRevision");
    const expectedControlGeneration = readIntegerField(record, "expectedControlGeneration", "controlGeneration");
    const store = this.context.storeRegistry.getStore(cwd);
    const existing = store.getWorkItem(workItemId);
    if (!existing) {
      throw rpcError(-32040, "workspace_binding_invalid", `Work Item was not found: ${workItemId}`);
    }
    const prior = existing.control.receipt;
    const reason = readOptionalStringField(record, "reason");
    const sameRequest = prior?.idempotencyKey === idempotencyKey && prior.action === action &&
      prior.actorId === actorId && prior.reason === reason;
    if (prior?.idempotencyKey === idempotencyKey && !sameRequest) {
      throw rpcError(-32031, "idempotency_conflict", "The idempotency key was already used for a different Work Item control request.");
    }
    if (sameRequest) {
      return { cwd, workItem: projectWorkItemSnapshot(existing) };
    }
    if (existing.revision !== expectedRevision || existing.control.generation !== expectedControlGeneration) {
      throw rpcError(-32030, "stale_revision", "The Work Item revision or control generation is stale.");
    }
    const input = {
      expectedRevision,
      expectedControlGeneration,
      actorId,
      ...(reason === undefined ? {} : { reason }),
      idempotencyKey,
    };
    const workItem = action === "pause"
      ? store.pauseWorkItem(workItemId, input, new Date().toISOString())
      : action === "resume"
        ? store.resumeWorkItem(workItemId, input, new Date().toISOString())
        : store.cancelWorkItem(workItemId, input, new Date().toISOString());
    if (!workItem) {
      throw rpcError(-32030, "stale_revision", "The Work Item changed before the control request committed.");
    }
    if (workItem.revision === existing.revision && prior?.idempotencyKey !== idempotencyKey) {
      throw rpcError(-32061, "resume_blocked", `Work Item cannot accept ${action} while control state is ${existing.control.state}.`);
    }
    const projected = projectWorkItemSnapshot(workItem);
    appendControlPlaneEvent(store, this.context.controlPlaneEvents, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      cwd,
      domain: "work_items",
      entityType: "work_item",
      entityId: workItemId,
      action: `work_item.control.${action}`,
      idempotencyKey,
      data: {
        workItemId,
        revision: projected.revision,
        controlState: projected.control.state,
        controlGeneration: projected.control.generation,
        receiptId: projected.control.receipt?.id,
      },
    });
    this.send({
      jsonrpc: "2.0",
      method: "workItem/control/updated",
      params: { cwd, workItemId, workItem: projected },
    });
    return { cwd, workItem: projected };
  }

  private readControlPlaneParams(params: unknown): { readonly cwd: string; readonly domains: readonly ControlPlaneDomain[] } {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    return {
      cwd,
      domains: parseRpcDomains(record.domains),
    };
  }

  private readControlPlaneEventParams(params: unknown): {
    readonly cwd: string;
    readonly afterSeq: number;
    readonly limit: number;
    readonly domains: readonly ControlPlaneDomain[];
  } {
    const record = readParamsRecord(params);
    return {
      ...this.readControlPlaneParams(record),
      afterSeq: readRpcAfterSeq(record.afterSeq),
      limit: readRpcLimit(record.limit),
    };
  }

  private prepareControlPlaneSubscription(params: unknown, filter?: { readonly entityType?: string; readonly entityId?: string }): {
    readonly result: ControlPlaneSubscribeResult;
    readonly activate?: () => void;
  } {
    const parsed = this.readControlPlaneEventParams({
      ...readParamsRecord(params),
      limit: CONTROL_PLANE_POLL_MAX_LIMIT,
    });
    const subscriptionId = `cp_${this.nextSubscriptionId}`;
    this.nextSubscriptionId += 1;
    let hubSubscription: ReturnType<DaemonContext["controlPlaneEvents"]["subscribeListener"]> | undefined;
    const subscription: RpcSubscription = {
      id: subscriptionId,
      cwd: parsed.cwd,
      domains: parsed.domains,
      ...filter,
      closeHub: () => hubSubscription?.close(),
      queue: [],
      upstreamKey: `${subscriptionId}:hub`,
      queueKey: `${subscriptionId}:queue`,
      closed: false,
    };
    // Register before replay can synchronously publish provisional events or close us.
    this.subscriptions.set(subscriptionId, subscription);
    try {
      hubSubscription = this.context.controlPlaneEvents.subscribeListener({
        workspaceId: DEFAULT_WORKSPACE_ID,
        cwd: parsed.cwd,
        domains: parsed.domains,
        onEvent: (event) => this.enqueueControlPlaneEvent(subscription, event),
        onPendingChange: (bytes, count) => this.outbound.reserve(subscription.upstreamKey,
          bytes + count * controlPlaneEnvelopeBytes(subscription.id), count),
        onOverflow: () => this.outbound.close(1013, "slow_client_disconnect"),
      });
      if (this.closed || subscription.closed) {
        hubSubscription.close();
        throw rpcError(-32000, "connection_closed", "The outbound connection is closed.");
      }
      const replay = listControlPlaneEventsForResponse(this.context, parsed);
      const filteredReplay = replay.events.filter((event) => subscriptionMatchesEvent(subscription, event));
      if (replay.window.disposition === "snapshot_required") {
        this.closeSubscription(subscription);
        return {
          result: {
            disposition: "snapshot_required",
            window: replay.window,
          },
        };
      }
      return {
        result: {
          disposition: "complete",
          subscriptionId,
          window: replay.window,
        },
        activate: () => hubSubscription?.activate(filteredReplay),
      };
    } catch (error) {
      this.closeSubscription(subscription);
      throw error;
    }
  }

  private unsubscribeControlPlane(params: unknown): unknown {
    const record = readParamsRecord(params);
    const subscriptionId = readStringField(record, "subscriptionId");
    const subscription = this.subscriptions.get(subscriptionId);
    if (subscription) {
      this.closeSubscription(subscription);
    }
    return { ok: true, subscriptionId };
  }

  private startRun(params: unknown): unknown {
    const runRequest = parseRunRequest(params);
    let runCloseListener: (() => void) | undefined;
    const sink = createRpcRunExecutionSink({
      onReady: (data) => this.sendRunNotification({ kind: "ready", data }),
      onEvent: (event, data) => this.sendRunNotification({ kind: "event", event, data }),
      onError: (statusCode, body) => this.sendRunNotification({ kind: "error", statusCode, body }),
      onEnd: () => {
        if (runCloseListener) this.runCloseListeners.delete(runCloseListener);
        this.sendRunNotification({ kind: "end" });
      },
      isClosed: () => this.closed || this.ws.readyState !== WebSocket.OPEN,
      onClose: (listener) => {
        // Transport detachment suppresses notifications only; it never aborts a Run.
        runCloseListener = listener;
        if (this.closed) listener();
        else this.runCloseListeners.add(listener);
      },
    });
    void executeRunRequest(
      runRequest,
      sink,
      this.context.runnerRegistry,
      this.context.storeRegistry,
      this.context.activeRuns,
      this.context.runtimeSupervisor,
      this.context.secretResolver,
      this.context.mcpBroker,
      {
        afterRunTerminal: (terminalRun) => this.maybeContinueRunInterventions(terminalRun),
        controlPlaneEvents: this.context.controlPlaneEvents,
        startupState: this.context.startupState,
        computerUsePreviews: this.context.computerUsePreviews,
        nativeRunDispatcher: this.context.nativeRunDispatcher,
      },
    );
    return { accepted: true };
  }

  private cancelRun(params: unknown): unknown {
    const record = readParamsRecord(params);
    const runId = readStringField(record, "runId");
    const cwd = readOptionalStringField(record, "cwd");
    const store = this.context.storeRegistry.findStoreForRun(runId, cwd);
    const run = store?.getRun(runId);
    if (!store || !run) {
      throw rpcError(-32004, "run_not_found", "Run was not found in the active daemon stores.");
    }
    if (run.status === "cancelled") {
      return { cancelled: true, active: false, run: projectPublicRunSession(run, store) };
    }
    if (run.status === "succeeded" || run.status === "failed") {
      throw rpcError(-32009, "run_not_cancellable", `Run ${runId} is already ${run.status}.`);
    }
    const activeRun = this.context.activeRuns.get(runId);
    let cancelled: ReturnType<typeof ensureRunCancelled>;
    try {
      cancelled = ensureRunCancelled({
        store,
        runId,
        taskId: run.taskId,
        startedAt: run.startedAt,
        reason: "user_requested",
        active: Boolean(activeRun),
        streamEnvelope: activeRun?.streamEnvelope,
      });
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 409) throw rpcError(-32009, error.code, error.message);
      throw error;
    }
    if (!cancelled.inputWait) activeRun?.abortController.abort();
    return {
      cancelled: true,
      active: !cancelled.inputWait && Boolean(activeRun),
      run: projectPublicRunSession(store.getRun(runId), store),
      event: cancelled.event,
      ...(cancelled.inputWait ? { inputWait: cancelled.inputWait } : {}),
    };
  }

  private async maybeContinueRunInterventions(terminalRun: RunSession): Promise<void> {
    const sourceRunId = terminalRun.parentRunId ?? terminalRun.id;
    const workspaceCwd = readRunWorkspaceCwd(terminalRun) ?? terminalRun.cwd;
    const store = this.context.storeRegistry.findStoreForRun(sourceRunId, workspaceCwd) ??
      this.context.storeRegistry.findStoreForRun(terminalRun.id, workspaceCwd);
    if (!store) {
      return;
    }
    maybeScheduleRunTerminalReport(store, terminalRun.id, { linkedRunId: terminalRun.id });
    const goalContinuation = maybeQueueGoalContinuation({
      terminalRun,
      store,
      activeRuns: this.context.activeRuns,
    });
    await maybeStartNextRunInterventionContinuation({
      sourceRunId: goalContinuation?.sourceRunId ?? sourceRunId,
      terminalRun,
      store,
      runnerRegistry: this.context.runnerRegistry,
      storeRegistry: this.context.storeRegistry,
      activeRuns: this.context.activeRuns,
      runtimeSupervisor: this.context.runtimeSupervisor,
      secretResolver: this.context.secretResolver,
      mcpBroker: this.context.mcpBroker,
      controlPlaneEvents: this.context.controlPlaneEvents,
      startupState: this.context.startupState,
      computerUsePreviews: this.context.computerUsePreviews,
      nativeRunDispatcher: this.context.nativeRunDispatcher,
    });
  }

  private enqueueControlPlaneEvent(subscription: RpcSubscription, event: ControlPlaneEvent): void {
    if (this.closed || subscription.closed || !subscriptionMatchesEvent(subscription, event)) {
      return;
    }
    const frame = this.outbound.prepare(controlPlaneNotification(subscription.id, event));
    if (!frame) return;
    subscription.queue.push({ event, frame });
    if (subscription.queue.length >= CONTROL_PLANE_SSE_QUEUE_WARNING_THRESHOLD) {
      const coalesced = coalesceAndSortControlPlaneEvents(subscription.queue.map(pending => pending.event));
      subscription.queue.length = 0;
      for (const merged of coalesced) {
        const mergedFrame = this.outbound.prepare(controlPlaneNotification(subscription.id, merged));
        if (!mergedFrame) return;
        subscription.queue.push({ event: merged, frame: mergedFrame });
      }
    }
    if (subscription.queue.length > CONTROL_PLANE_SSE_QUEUE_HARD_LIMIT || !this.reserveSubscriptionQueue(subscription)) {
      this.outbound.close(1013, "slow_client_disconnect");
      return;
    }
    if (subscription.flushTimer) {
      return;
    }
    subscription.flushTimer = setTimeout(() => {
      subscription.flushTimer = undefined;
      this.flushControlPlaneSubscription(subscription);
    }, CONTROL_PLANE_SSE_FLUSH_MS);
  }

  private flushControlPlaneSubscription(subscription: RpcSubscription): void {
    if (this.closed || subscription.closed) {
      return;
    }
    while (subscription.queue.length > 0 && !this.closed && !subscription.closed) {
      const pending = subscription.queue.shift()!;
      // Synchronous ownership transfer: do not count the same frame in both queues.
      if (!this.reserveSubscriptionQueue(subscription) || !this.outbound.enqueue(pending.frame, subscription.id)) return;
    }
  }

  private reserveSubscriptionQueue(subscription: RpcSubscription): boolean {
    return this.outbound.reserve(subscription.queueKey,
      subscription.queue.reduce((bytes, pending) => bytes + pending.frame.bytes, 0), subscription.queue.length);
  }

  private sendRunNotification(params: unknown): void {
    this.send({
      jsonrpc: "2.0",
      method: "$/run_event",
      params,
    });
  }

  private sendError(id: JsonRpcId, jsonRpcCode: number, code: string, message: string): void {
    this.send({
      jsonrpc: "2.0",
      id,
      error: { code: jsonRpcCode, message, data: { code } },
    });
  }

  private send(value: unknown): boolean {
    return !this.closed && this.outbound.send(value);
  }

  private close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.ws.off("message", this.onMessage);
    this.ws.off("close", this.onConnectionClose);
    this.ws.off("error", this.onConnectionError);
    for (const subscription of [...this.subscriptions.values()]) {
      this.closeSubscription(subscription);
    }
    for (const listener of this.runCloseListeners) listener();
    this.runCloseListeners.clear();
    this.outbound.close();
  }

  private closeSubscription(subscription: RpcSubscription): void {
    if (subscription.closed) return;
    subscription.closed = true;
    subscription.closeHub();
    if (subscription.flushTimer) {
      clearTimeout(subscription.flushTimer);
    }
    subscription.flushTimer = undefined;
    subscription.queue.length = 0;
    this.outbound.reserve(subscription.upstreamKey, 0, 0);
    this.outbound.reserve(subscription.queueKey, 0, 0);
    this.outbound.cancelGroup(subscription.id);
    this.subscriptions.delete(subscription.id);
  }
}

function createRpcRunExecutionSink(input: {
  readonly onReady: (data: unknown) => void;
  readonly onEvent: (event: string, data: unknown) => void;
  readonly onError: (statusCode: number, body: unknown) => void;
  readonly onEnd: () => void;
  readonly isClosed: () => boolean;
  readonly onClose: (listener: () => void) => void;
}): RunExecutionSink {
  return {
    kind: "sse",
    onClose: input.onClose,
    isClosed: input.isClosed,
    writeReady: input.onReady,
    writeEvent: input.onEvent,
    writeError: input.onError,
    end: input.onEnd,
  };
}

function rejectUpgrade(socket: Duplex, statusCode: number, message: string): void {
  socket.write([
    `HTTP/1.1 ${statusCode} ${statusCode === 401 ? "Unauthorized" : statusCode === 400 ? "Bad Request" : "Not Found"}`,
    "Connection: close",
    "Content-Type: text/plain; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(message)}`,
    "",
    message,
  ].join("\r\n"));
  socket.destroy();
}

function parseJsonRpcRequest(data: RawData): JsonRpcRequest | undefined {
  try {
    const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.concat(data as Buffer[]).toString("utf8");
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as JsonRpcRequest;
  } catch {
    return undefined;
  }
}

function projectWorkItemSnapshot(workItem: WorkItem) {
  const currentExecutionRefs = [
    workItem.taskId,
    workItem.runId,
    workItem.workflowId,
    workItem.workflowStepId,
    workItem.approvalId,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  return {
    workspaceId: workItem.workspaceId,
    workItemId: workItem.id,
    revision: String(workItem.revision),
    status: workItem.status,
    ...(workItem.planRevision ? { planRevision: workItem.planRevision } : {}),
    control: {
      state: workItem.control.state,
      generation: String(workItem.control.generation),
      ...(workItem.control.receipt ? {
        receipt: {
          id: workItem.control.receipt.id,
          action: workItem.control.receipt.action,
          generation: String(workItem.control.receipt.generation),
          requestedAt: workItem.control.receipt.requestedAt,
          actorId: workItem.control.receipt.actorId,
          ...(workItem.control.receipt.reason ? { reason: workItem.control.receipt.reason } : {}),
          outcome: workItem.control.receipt.outcome,
        },
      } : {}),
      unresolvedEffectIds: workItem.control.unresolvedEffectIds,
      ...(workItem.control.recoveryOwner ? { recoveryOwner: workItem.control.recoveryOwner } : {}),
    },
    holds: workItem.holds,
    currentExecutionRefs,
  };
}

function readOptionalIntegerField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw rpcError(-32602, "invalid_params", `${key} must be a safe integer.`);
  }
  return value;
}

function readIntegerField(record: Record<string, unknown>, primaryKey: string, fallbackKey: string): number {
  const value = record[primaryKey] ?? record[fallbackKey];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw rpcError(-32602, "invalid_params", `${primaryKey} must be a non-negative safe integer.`);
  }
  return value;
}

function readOptionalWorkItemStatus(value: unknown): WorkItemStatus | undefined {
  if (value === undefined) return undefined;
  const statuses: readonly WorkItemStatus[] = [
    "intake", "triage", "backlog", "ready", "running", "waiting", "review", "blocked", "done", "cancelled", "superseded", "archived",
  ];
  if (typeof value !== "string" || !statuses.includes(value as WorkItemStatus)) {
    throw rpcError(-32602, "invalid_params", "status is not a supported Work Item status.");
  }
  return value as WorkItemStatus;
}

function readOptionalWorkItemSourceType(value: unknown): WorkItemSourceType | undefined {
  if (value === undefined) return undefined;
  const sourceTypes: readonly WorkItemSourceType[] = [
    "channel_task", "channel_workflow_step", "external_work", "external_work_action", "approval", "run", "manual",
  ];
  if (typeof value !== "string" || !sourceTypes.includes(value as WorkItemSourceType)) {
    throw rpcError(-32602, "invalid_params", "sourceType is not a supported Work Item source type.");
  }
  return value as WorkItemSourceType;
}

function readOptionalWorkItemPriority(value: unknown): WorkItem["priority"] | undefined {
  if (value === undefined) return undefined;
  const priorities = ["low", "normal", "high", "urgent"] as const;
  if (typeof value !== "string" || !priorities.includes(value as (typeof priorities)[number])) {
    throw rpcError(-32602, "invalid_params", "priority is not a supported Work Item priority.");
  }
  return value as WorkItem["priority"];
}

function readLingThreadKind(value: string): import("@ling-stack/core").LingThreadKind {
  const kinds = ["task", "channel_discussion", "teammate_direct", "workflow_step", "external_work", "automation", "conversation"] as const;
  if (!kinds.includes(value as (typeof kinds)[number])) {
    throw rpcError(-32602, "invalid_params", "kind is not a supported Ling Thread kind.");
  }
  return value as import("@ling-stack/core").LingThreadKind;
}

function readLingTurnKind(value: string): import("@ling-stack/core").LingTurnKind {
  const kinds = ["initial_request", "manual_followup", "queued_followup", "interrupt_redirect", "workflow_step", "external_work_update", "automation_tick", "review_queue_action"] as const;
  if (!kinds.includes(value as (typeof kinds)[number])) {
    throw rpcError(-32602, "invalid_params", "kind is not a supported Ling Turn kind.");
  }
  return value as import("@ling-stack/core").LingTurnKind;
}

function jsonRpcIdKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function readParamsRecord(params: unknown): Record<string, unknown> {
  if (params === undefined) {
    return {};
  }
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw rpcError(-32602, "invalid_params", "params must be an object.");
  }
  return params as Record<string, unknown>;
}

function readRpcCwd(record: Record<string, unknown>, fallback: string): string {
  const cwd = readOptionalStringField(record, "cwd") ?? fallback;
  if (!cwd.trim()) {
    throw new ControlPlaneBadRequestError("cwd is required");
  }
  return cwd;
}

function parseRpcDomains(value: unknown): readonly ControlPlaneDomain[] {
  if (value === undefined) {
    return parseControlPlaneDomains(null);
  }
  if (typeof value === "string") {
    return parseControlPlaneDomains(value);
  }
  if (Array.isArray(value)) {
    if (!value.every((domain) => typeof domain === "string")) {
      throw new ControlPlaneBadDomainError("domains must be a comma-separated string or array of strings");
    }
    return parseControlPlaneDomains(value.join(","));
  }
  throw new ControlPlaneBadDomainError("domains must be a comma-separated string or array of strings");
}

function readRpcAfterSeq(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return 0;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ControlPlaneBadRequestError("afterSeq must be an integer greater than or equal to 0");
  }
  return value;
}

function readRpcLimit(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return CONTROL_PLANE_POLL_DEFAULT_LIMIT;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > CONTROL_PLANE_POLL_MAX_LIMIT) {
    throw new ControlPlaneBadRequestError(`limit must be an integer between 1 and ${CONTROL_PLANE_POLL_MAX_LIMIT}`);
  }
  return value;
}

function readStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw rpcError(-32602, "invalid_params", `${key} must be a non-empty string.`);
  }
  return value;
}

function readOptionalStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw rpcError(-32602, "invalid_params", `${key} must be a string.`);
  }
  return value;
}

function rpcError(jsonRpcCode: number, code: string, message: string): Error & { readonly jsonRpcCode: number; readonly code: string } {
  return Object.assign(new Error(message), { jsonRpcCode, code });
}

function normalizeRpcError(error: unknown): { readonly jsonRpcCode: number; readonly code: string; readonly message: string } {
  if (typeof error === "object" && error !== null && "jsonRpcCode" in error && "code" in error) {
    const record = error as { readonly jsonRpcCode?: unknown; readonly code?: unknown; readonly message?: unknown };
    return {
      jsonRpcCode: typeof record.jsonRpcCode === "number" ? record.jsonRpcCode : -32000,
      code: typeof record.code === "string" ? record.code : "rpc_error",
      message: typeof record.message === "string" ? record.message : "RPC error",
    };
  }
  if (error instanceof ControlPlaneBadDomainError) {
    return { jsonRpcCode: -32602, code: "bad_domain", message: error.message };
  }
  if (error instanceof ControlPlaneBadRequestError) {
    return { jsonRpcCode: -32602, code: "bad_request", message: error.message };
  }
  return {
    jsonRpcCode: -32000,
    code: "internal_error",
    message: error instanceof Error ? error.message : String(error),
  };
}

function controlPlaneNotification(subscriptionId: string, event: ControlPlaneEvent): unknown {
  return { jsonrpc: "2.0", method: "$/control_plane_event", params: { subscriptionId, event } };
}

function subscriptionMatchesEvent(subscription: RpcSubscription, event: ControlPlaneEvent): boolean {
  if (subscription.entityType && event.entityType !== subscription.entityType) return false;
  if (subscription.entityId && event.entityId !== subscription.entityId) return false;
  return true;
}

function controlPlaneEnvelopeBytes(subscriptionId: string): number {
  return Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", method: "$/control_plane_event", params: { subscriptionId } }), "utf8") + 16;
}

function readRunWorkspaceCwd(run: RunSession): string | undefined {
  const snapshot = run.requestSnapshot;
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    return undefined;
  }
  const workspaceCwd = (snapshot as { readonly workspaceCwd?: unknown }).workspaceCwd;
  return typeof workspaceCwd === "string" && workspaceCwd.trim() ? workspaceCwd : undefined;
}
