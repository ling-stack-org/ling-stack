import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  DEFAULT_WORKSPACE_ID,
  evaluateDeliberationTrigger,
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
import { AppServerDevelopmentService } from "./app-server-development.js";
import {
  ExternalAgentFederationService,
  externalAgentRpcError,
  getExternalAgentFederation,
  type ExternalAgentFederationEvent,
} from "../runtime/external-agent/federation.js";
import {
  AppServerCollaborationError,
  appendAppServerWorkItemCollaboration,
  readAppServerWorkItemCollaboration,
} from "./app-server-collaboration.js";

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
  private readonly development: AppServerDevelopmentService;
  private readonly externalAgents: ExternalAgentFederationService;
  private readonly runCloseListeners = new Set<() => void>();
  private nextSubscriptionId = 1;
  private initialized = false;
  private closed = false;
  private readonly connectionId = `conn_${randomUUID()}`;
  private readonly pendingRequests = new Set<string>();
  private readonly cancelledRequests = new Set<string>();
  private readonly externalTaskIds = new Set<string>();
  private readonly externalAgentUnsubscribe: () => void;
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
    this.development = getAppServerDevelopmentService(context);
    this.externalAgents = getExternalAgentFederation(context);
    this.externalAgentUnsubscribe = this.externalAgents.subscribe((event) => this.handleExternalAgentEvent(event));
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
        const record = readParamsRecord(request.params);
        const threadId = readOptionalStringField(record, "threadId");
        const prepared = this.prepareControlPlaneSubscription({
          ...record,
          domains: ["runs", "work_items", "work_units"],
        }, threadId ? { entityType: "thread", entityId: threadId } : undefined);
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
      case "thread/name/set":
        return this.setThreadName(params);
      case "thread/archive":
        return this.archiveThread(params, true);
      case "thread/unarchive":
        return this.archiveThread(params, false);
      case "thread/delete/preview":
        return this.previewThreadDelete(params);
      case "thread/delete":
        return this.deleteThread(params);
      case "thread/turns/list":
        return this.listThreadTurns(params);
      case "thread/items/list":
        return this.listThreadItems(params);
      case "thread/mode/get":
        return this.getThreadMode(params);
      case "thread/mode/set":
        return this.setThreadMode(params);
      case "thread/goal/get":
        return this.getThreadGoal(params);
      case "thread/goal/set":
        return this.setThreadGoal(params);
      case "thread/goal/pause":
        return this.updateThreadGoalStatus(params, "paused");
      case "thread/goal/resume":
        return this.updateThreadGoalStatus(params, "active");
      case "thread/goal/clear":
        return this.clearThreadGoal(params);
      case "thread/goal/complete":
        return this.completeThreadGoal(params);
      case "plan/read":
        return this.readPlan(params);
      case "plan/accept":
        return this.acceptPlan(params);
      case "thread/unsubscribe":
        return this.unsubscribeControlPlane(params);
      case "verify/plan":
        return await this.development.planVerification(params as never);
      case "verify/start":
        return await this.development.startVerification(params as never);
      case "verify/status":
        return this.development.getVerification(params as never);
      case "verify/cancel":
        return this.development.cancelVerification(params as never);
      case "review/start":
        return await this.development.startReview(params as never);
      case "review/status":
        return this.development.getReviewStatus(params as never);
      case "review/finding/update":
        return await this.development.updateReviewFinding(params as never);
      case "simplify/start":
        return this.development.startSimplify(params as never);
      case "doctor/run":
        return await this.development.runDoctor(params as never);
      case "instructions/init":
        return await this.development.initInstructions(params as never);
      case "turn/start":
        return this.startTurn(params);
      case "approval/respond":
        return this.respondApproval(params);
      case "input/respond":
        return this.respondInput(params);
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
      case "workItem/evidence/read":
        return this.readWorkItemEvidence(params);
      case "workItem/evidence/append":
        return this.appendWorkItemEvidence(params);
      case "workItem/collaboration/read":
        return this.readCollaboration(undefined, params);
      case "workItem/collaboration/append":
        return this.appendCollaborationFromParams(params);
      case "workItem/read":
        return this.readWorkItem(params);
      case "workItem/pause":
        return this.controlWorkItem("pause", params);
      case "workItem/resume":
        return this.controlWorkItem("resume", params);
      case "workItem/cancel":
        return this.controlWorkItem("cancel", params);
      case "workItem/deliberation/start":
        return this.appendCollaboration("deliberation", "started", params);
      case "workItem/deliberation/decide":
        return this.appendCollaboration("deliberation", "decided", params);
      case "workItem/deliberation/cancel":
        return this.appendCollaboration("deliberation", "cancelled", params);
      case "workItem/deliberation/read":
        return this.readCollaboration("deliberation", params);
      case "workItem/stage/read":
        return this.readCollaboration("stage", params);
      case "workItem/stage/brief/read":
        return this.readCollaboration("brief", params);
      case "workItem/coordination/start":
        return this.appendCollaboration("coordination", "started", params);
      case "workItem/coordination/close":
        return this.appendCollaboration("coordination", "closed", params);
      case "workItem/coordination/read":
        return this.readCollaboration("coordination", params);
      case "workItem/message/send":
        return this.appendCollaboration("message", "created", params);
      case "workItem/message/read":
      case "workItem/message/list":
        return this.readCollaboration("message", params);
      case "workItem/question/ask":
        return this.appendCollaboration("question", "created", params);
      case "workItem/question/reply":
        return this.appendCollaboration("question", "replied", params);
      case "workItem/question/read":
        return this.readCollaboration("question", params);
      case "workItem/handoff/accept":
        return this.appendCollaboration("handoff", "accepted", params);
      case "workItem/handoff/return":
        return this.appendCollaboration("handoff", "returned", params);
      case "workItem/handoff/read":
        return this.readCollaboration("handoff", params);
      case "workItem/feedback/add":
        return this.appendCollaboration("message", "updated", params);
      case "externalAgent/register":
        return this.registerExternalAgent(params);
      case "externalAgent/capabilities/read":
        return this.externalAgents.readCapabilities(readStringField(readParamsRecord(params), "registrationId"));
      case "externalAgent/task/start":
        return this.startExternalAgentTask(params);
      case "externalAgent/task/reconnect":
        return this.reconnectExternalAgentTask(params);
      case "externalAgent/task/cancel":
        return await this.cancelExternalAgentTask(params);
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

  private readWorkItemEvidence(params: unknown): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const workItemId = readStringField(record, "workItemId");
    const store = this.context.storeRegistry.getStore(cwd);
    if (!store.getWorkItem(workItemId)) throw rpcError(-32040, "workspace_binding_invalid", `Work Item was not found: ${workItemId}`);
    const afterSequence = readOptionalIntegerField(record, "afterSequence") ?? 0;
    const evidence = store.listWorkItemEvidence({ workItemId, afterSequence, limit: readOptionalIntegerField(record, "limit") });
    return { cwd, workItemId, evidence, nextAfterSequence: evidence.at(-1)?.sequence ?? afterSequence };
  }

  private appendWorkItemEvidence(params: unknown): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const workItemId = readStringField(record, "workItemId");
    const store = this.context.storeRegistry.getStore(cwd);
    const idempotencyKey = readStringField(record, "idempotencyKey");
    const actorId = readStringField(record, "actorId");
    const subjectRevision = readStringField(record, "subjectRevision");
    const kind = readStringField(record, "kind") as import("@ling-stack/core").WorkItemEvidenceKind;
    const content = readStringField(record, "content");
    const sourceRefs = Array.isArray(record.sourceRefs) ? record.sourceRefs : [];
    const result = store.appendWorkItemEvidence({
      workItemId,
      expectedWorkItemRevision: readOptionalIntegerField(record, "expectedWorkItemRevision"),
      expectedEvidenceRevision: readOptionalIntegerField(record, "expectedEvidenceRevision"),
      idempotencyKey,
      actorId,
      subjectRevision,
      kind,
      content,
      sourceRefs: sourceRefs as import("@ling-stack/core").WorkItemEvidenceSourceRef[],
      visibility: readOptionalStringField(record, "visibility") as import("@ling-stack/core").WorkItemEvidenceVisibility | undefined,
    }, new Date().toISOString());
    if (!result) throw rpcError(-32030, "stale_revision", "The Work Item or evidence revision is stale.");
    appendControlPlaneEvent(store, this.context.controlPlaneEvents, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      cwd,
      domain: "work_items",
      entityType: "work_item",
      entityId: workItemId,
      action: "work_item.evidence.updated",
      idempotencyKey,
      data: { workItemId, evidenceId: result.entry.id, sequence: result.entry.sequence, workItemRevision: result.workItemRevision },
    });
    return { cwd, workItemId, ...result };
  }

  private readCollaboration(kind: import("@ling-stack/contracts").LingAppServerCollaborationKind | undefined, params: unknown): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    try {
      const result = readAppServerWorkItemCollaboration(this.context.storeRegistry.getStore(cwd), {
        workItemId: readStringField(record, "workItemId"),
        ...(kind ? { kind } : {}),
        afterRevision: readOptionalIntegerField(record, "afterRevision"),
        limit: readOptionalIntegerField(record, "limit"),
      });
      return { cwd, ...result };
    } catch (error) {
      throw collaborationRpcError(error);
    }
  }

  private appendCollaborationFromParams(params: unknown): unknown {
    const record = readParamsRecord(params);
    const kind = readStringField(record, "kind") as import("@ling-stack/contracts").LingAppServerCollaborationKind;
    const action = readStringField(record, "action") as import("@ling-stack/contracts").LingAppServerCollaborationAction;
    return this.appendCollaboration(kind, action, params);
  }

  private appendCollaboration(
    kind: import("@ling-stack/contracts").LingAppServerCollaborationKind,
    action: import("@ling-stack/contracts").LingAppServerCollaborationAction,
    params: unknown,
  ): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const workItemId = readStringField(record, "workItemId");
    try {
      let payload = record.payload;
      if (kind === "deliberation" && record.trigger !== undefined) {
        const decision = evaluateDeliberationTrigger(record.trigger as never, (record.policy ?? {}) as never);
        if (!decision.shouldOpen) throw rpcError(-32061, "resume_blocked", decision.reason);
        payload = { ...(typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload as Record<string, unknown> : { value: payload }), triggerDecision: decision };
      }
      const result = appendAppServerWorkItemCollaboration(this.context.storeRegistry.getStore(cwd), {
        ...record,
        cwd,
        workItemId,
        kind,
        action,
        payload,
      } as never, new Date().toISOString());
      const store = this.context.storeRegistry.getStore(cwd);
      appendControlPlaneEvent(store, this.context.controlPlaneEvents, {
        workspaceId: DEFAULT_WORKSPACE_ID,
        cwd,
        domain: "work_items",
        entityType: "work_item",
        entityId: workItemId,
        action: `work_item.collaboration.${kind}.${action}`,
        idempotencyKey: readStringField(record, "idempotencyKey"),
        data: { workItemId, collaborationId: result.record.id, collaborationRevision: result.record.collaborationRevision },
      });
      if (this.appServer) {
        this.send({
          jsonrpc: "2.0",
          method: collaborationNotificationMethod(kind),
          params: { cwd, workItemId, record: result.record },
        });
      }
      return { cwd, ...result };
    } catch (error) {
      throw collaborationRpcError(error);
    }
  }

  private registerExternalAgent(params: unknown): unknown {
    try {
      const result = this.externalAgents.register(params as never);
      if (this.appServer) {
        this.send({ jsonrpc: "2.0", method: "externalAgent/registered", params: result });
      }
      return result;
    } catch (error) {
      throw externalAgentRpcError(error);
    }
  }

  private startExternalAgentTask(params: unknown): unknown {
    const record = readParamsRecord(params);
    const registrationId = readStringField(record, "registrationId");
    try {
      const submission = readParamsRecord(record.submission);
      const cwd = readRpcCwd(record, this.defaultCwd);
      const store = this.context.storeRegistry.getStore(cwd);
      const workItemId = readStringField(submission, "workItemId");
      const workItem = store.getWorkItem(workItemId);
      if (!workItem) throw rpcError(-32040, "workspace_binding_invalid", `Work Item was not found: ${workItemId}`);
      if (readStringField(submission, "workItemRevision") !== String(workItem.revision)) {
        throw rpcError(-32030, "stale_revision", "The external Agent Work Item revision is stale.");
      }
      if (workItem.control.state !== "active") {
        throw rpcError(-32061, "resume_blocked", `Work Item cannot dispatch an external Agent while control state is ${workItem.control.state}.`);
      }
      const result = this.externalAgents.startTask(params as never);
      const task = result.task;
      this.externalTaskIds.add(task.taskId);
      appendControlPlaneEvent(store, this.context.controlPlaneEvents, {
        workspaceId: DEFAULT_WORKSPACE_ID,
        cwd,
        domain: "runners",
        entityType: "external_agent_task",
        entityId: task.taskId,
        action: "external_agent.task.started",
        idempotencyKey: readStringField(readParamsRecord(record.submission), "idempotencyKey"),
        data: { registrationId, workItemId: task.workItemId, status: task.status, dispatchDepth: task.dispatchDepth },
      });
      if (this.appServer) {
        this.send({ jsonrpc: "2.0", method: "externalAgent/task/started", params: result });
      }
      return result;
    } catch (error) {
      throw externalAgentRpcError(error);
    }
  }

  private reconnectExternalAgentTask(params: unknown): unknown {
    try {
      const result = this.externalAgents.reconnectTask(params as never);
      this.externalTaskIds.add(result.task.taskId);
      if (this.appServer) this.send({ jsonrpc: "2.0", method: "externalAgent/task/reconnected", params: result });
      return result;
    } catch (error) {
      throw externalAgentRpcError(error);
    }
  }

  private async cancelExternalAgentTask(params: unknown): Promise<unknown> {
    try {
      const result = await this.externalAgents.cancelTask(params as never);
      if (this.appServer) this.send({
        jsonrpc: "2.0",
        method: result.status === "unknown" ? "externalAgent/task/unknown" : "externalAgent/task/updated",
        params: result,
      });
      return result;
    } catch (error) {
      throw externalAgentRpcError(error);
    }
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

  private setThreadName(params: unknown): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const threadId = readStringField(record, "threadId");
    const title = readStringField(record, "title");
    const store = this.context.storeRegistry.getStore(cwd);
    const thread = store.updateLingThread(threadId, { title }, new Date().toISOString());
    if (!thread) throw rpcError(-32040, "workspace_binding_invalid", `Thread was not found: ${threadId}`);
    appendControlPlaneEvent(store, this.context.controlPlaneEvents, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      cwd,
      domain: "runs",
      entityType: "thread",
      entityId: threadId,
      action: "thread.updated",
      data: { threadId, title: thread.title, revision: thread.updatedAt },
    });
    return { cwd, thread: projectPublicLingThread(thread) };
  }

  private archiveThread(params: unknown, archived: boolean): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const threadId = readStringField(record, "threadId");
    const store = this.context.storeRegistry.getStore(cwd);
    const existing = store.getLingThread(threadId);
    if (!existing) throw rpcError(-32040, "workspace_binding_invalid", `Thread was not found: ${threadId}`);
    const expectedRevision = readOptionalStringField(record, "expectedRevision");
    if (expectedRevision !== undefined && expectedRevision !== existing.updatedAt) {
      throw rpcError(-32030, "stale_revision", "The Thread revision is stale.");
    }
    const now = new Date().toISOString();
    const thread = store.updateLingThread(threadId, archived
      ? { status: "archived", archivedAt: now, archivedReason: readOptionalStringField(record, "reason") ?? "app_server" }
      : { status: "open", archivedAt: null, archivedReason: null }, now);
    if (!thread) throw rpcError(-32040, "workspace_binding_invalid", `Thread was not found: ${threadId}`);
    appendControlPlaneEvent(store, this.context.controlPlaneEvents, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      cwd,
      domain: "runs",
      entityType: "thread",
      entityId: threadId,
      action: archived ? "thread.archived" : "thread.updated",
      data: { threadId, status: thread.status, archivedAt: thread.archivedAt },
    });
    return { cwd, thread: projectPublicLingThread(thread) };
  }

  private previewThreadDelete(params: unknown): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const threadId = readStringField(record, "threadId");
    const store = this.context.storeRegistry.getStore(cwd);
    const thread = store.getLingThread(threadId);
    if (!thread) throw rpcError(-32040, "workspace_binding_invalid", `Thread was not found: ${threadId}`);
    const blockers: string[] = [];
    if (thread.kind !== "conversation") blockers.push("only conversation threads can be deleted");
    if (!thread.archivedAt && thread.status !== "archived") blockers.push("thread must be archived before delete");
    const turns = store.listLingTurns({ threadId, limit: 500 });
    const goal = store.getLingThreadGoal(threadId);
    const plans = store.listProposedPlanArtifacts({ threadId, limit: 200 });
    if (goal && ["active", "paused", "blocked", "usage_limited", "budget_limited"].includes(goal.status)) blockers.push("active goal depends on thread");
    if (plans.some((plan) => plan.status === "accepted")) blockers.push("accepted plan depends on thread");
    return {
      cwd,
      threadId,
      revision: thread.updatedAt,
      allowed: blockers.length === 0,
      blockers,
      dependencies: { turnCount: turns.length, goalId: goal?.id, planIds: plans.filter((plan) => plan.status === "accepted").map((plan) => plan.id) },
    };
  }

  private deleteThread(params: unknown): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const threadId = readStringField(record, "threadId");
    const store = this.context.storeRegistry.getStore(cwd);
    const preview = this.previewThreadDelete({ ...record, cwd, threadId }) as {
      readonly allowed: boolean;
      readonly blockers: readonly string[];
    };
    if (!preview.allowed) throw rpcError(-32061, "resume_blocked", `Thread deletion is blocked: ${preview.blockers.join("; ")}`);
    const result = store.hardDeleteLingThread(threadId, { reason: readOptionalStringField(record, "reason") }, new Date().toISOString());
    if (!result) throw rpcError(-32040, "workspace_binding_invalid", `Thread was not found: ${threadId}`);
    appendControlPlaneEvent(store, this.context.controlPlaneEvents, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      cwd,
      domain: "runs",
      entityType: "thread",
      entityId: threadId,
      action: "thread.removed",
      data: { threadId, tombstoneId: result.tombstone.id },
    });
    return { cwd, deleted: true, tombstone: result.tombstone };
  }

  private listThreadItems(params: unknown): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const threadId = readStringField(record, "threadId");
    const store = this.context.storeRegistry.getStore(cwd);
    if (!store.getLingThread(threadId)) throw rpcError(-32040, "workspace_binding_invalid", `Thread was not found: ${threadId}`);
    const page = store.listConversationItemsPage({
      threadId,
      beforeSequence: readOptionalIntegerField(record, "beforeSequence"),
      effectiveOnly: record.effectiveOnly === true,
      limit: readOptionalIntegerField(record, "limit"),
    });
    return { cwd, threadId, ...page };
  }

  private getThreadMode(params: unknown): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const threadId = readStringField(record, "threadId");
    const store = this.context.storeRegistry.getStore(cwd);
    if (!store.getLingThread(threadId)) throw rpcError(-32040, "workspace_binding_invalid", `Thread was not found: ${threadId}`);
    return { cwd, threadId, mode: store.getLingThreadConversationMode(threadId) ?? { mode: "default" } };
  }

  private setThreadMode(params: unknown): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const threadId = readStringField(record, "threadId");
    const mode = readStringField(record, "mode");
    if (mode !== "default" && mode !== "plan") throw rpcError(-32602, "invalid_params", "mode must be default or plan.");
    const store = this.context.storeRegistry.getStore(cwd);
    const updated = store.updateLingThreadConversationMode(threadId, { mode }, new Date().toISOString());
    if (!updated) throw rpcError(-32040, "workspace_binding_invalid", `Thread was not found: ${threadId}`);
    appendControlPlaneEvent(store, this.context.controlPlaneEvents, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      cwd,
      domain: "runs",
      entityType: "thread",
      entityId: threadId,
      action: "thread.mode.updated",
      data: { threadId, mode: updated.mode },
    });
    return { cwd, threadId, mode: updated };
  }

  private getThreadGoal(params: unknown): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const threadId = readStringField(record, "threadId");
    const store = this.context.storeRegistry.getStore(cwd);
    if (!store.getLingThread(threadId)) throw rpcError(-32040, "workspace_binding_invalid", `Thread was not found: ${threadId}`);
    return { cwd, threadId, goal: store.getLingThreadGoal(threadId) ?? null };
  }

  private setThreadGoal(params: unknown): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const threadId = readStringField(record, "threadId");
    const objective = readStringField(record, "objective");
    const store = this.context.storeRegistry.getStore(cwd);
    if (!store.getLingThread(threadId)) throw rpcError(-32040, "workspace_binding_invalid", `Thread was not found: ${threadId}`);
    const tokenBudget = readOptionalIntegerField(record, "tokenBudget");
    const now = new Date().toISOString();
    const existing = store.getLingThreadGoal(threadId);
    const goal = existing
      ? store.updateLingThreadGoal(existing.id, { objective, ...(tokenBudget === undefined ? {} : { tokenBudget }) }, now)
      : store.createLingThreadGoal({ threadId, objective, ...(tokenBudget === undefined ? {} : { tokenBudget }) }, now);
    if (!goal) throw rpcError(-32040, "workspace_binding_invalid", `Goal was not found for Thread: ${threadId}`);
    appendControlPlaneEvent(store, this.context.controlPlaneEvents, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      cwd,
      domain: "runs",
      entityType: "thread_goal",
      entityId: goal.id,
      action: "thread.goal.updated",
      data: { threadId, goalId: goal.id, status: goal.status },
    });
    return { cwd, threadId, goal };
  }

  private updateThreadGoalStatus(params: unknown, status: "active" | "paused"): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const threadId = readStringField(record, "threadId");
    const store = this.context.storeRegistry.getStore(cwd);
    const goal = store.getLingThreadGoal(threadId);
    if (!goal) throw rpcError(-32040, "workspace_binding_invalid", `Goal was not found for Thread: ${threadId}`);
    const updated = store.updateLingThreadGoal(goal.id, { status }, new Date().toISOString());
    if (!updated) throw rpcError(-32040, "workspace_binding_invalid", `Goal was not found: ${goal.id}`);
    appendControlPlaneEvent(store, this.context.controlPlaneEvents, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      cwd,
      domain: "runs",
      entityType: "thread_goal",
      entityId: goal.id,
      action: "thread.goal.updated",
      data: { threadId, goalId: goal.id, status: updated.status },
    });
    return { cwd, threadId, goal: updated };
  }

  private clearThreadGoal(params: unknown): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const threadId = readStringField(record, "threadId");
    const store = this.context.storeRegistry.getStore(cwd);
    const goal = store.clearLingThreadGoal(threadId, new Date().toISOString());
    if (!goal) throw rpcError(-32040, "workspace_binding_invalid", `Goal was not found for Thread: ${threadId}`);
    return { cwd, threadId, goal };
  }

  private completeThreadGoal(params: unknown): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const threadId = readStringField(record, "threadId");
    const store = this.context.storeRegistry.getStore(cwd);
    const goal = store.getLingThreadGoal(threadId);
    if (!goal) throw rpcError(-32040, "workspace_binding_invalid", `Goal was not found for Thread: ${threadId}`);
    const updated = store.updateLingThreadGoal(goal.id, {
      status: "complete",
      completedBy: readOptionalStringField(record, "completedBy") as "local-user" | "ling-agent" | undefined ?? "local-user",
      completedReason: readOptionalStringField(record, "reason") ?? "completed_by_app_server",
      completionVerificationSummary: readOptionalStringField(record, "verificationSummary"),
    }, new Date().toISOString());
    if (!updated) throw rpcError(-32040, "workspace_binding_invalid", `Goal was not found: ${goal.id}`);
    return { cwd, threadId, goal: updated };
  }

  private readPlan(params: unknown): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const store = this.context.storeRegistry.getStore(cwd);
    const planId = readOptionalStringField(record, "planId");
    const threadId = readOptionalStringField(record, "threadId");
    if (!planId && !threadId) throw rpcError(-32602, "invalid_params", "planId or threadId is required.");
    if (planId) {
      const plan = store.getProposedPlanArtifact(planId);
      if (!plan) throw rpcError(-32040, "workspace_binding_invalid", `Plan was not found: ${planId}`);
      return { cwd, plan };
    }
    return { cwd, threadId, plans: store.listProposedPlanArtifacts({ threadId, limit: readOptionalIntegerField(record, "limit") }) };
  }

  private acceptPlan(params: unknown): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const planId = readStringField(record, "planId");
    const threadId = readStringField(record, "threadId");
    const store = this.context.storeRegistry.getStore(cwd);
    const result = store.applyProposedPlanArtifactAction(planId, {
      threadId,
      action: "accept",
      expectedRevision: readOptionalIntegerField(record, "expectedRevision"),
      createdBy: readOptionalStringField(record, "createdBy") ?? "local-user",
    }, new Date().toISOString());
    appendControlPlaneEvent(store, this.context.controlPlaneEvents, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      cwd,
      domain: "runs",
      entityType: "plan",
      entityId: planId,
      action: "plan.accepted",
      data: { planId, threadId, revision: result.plan.revision },
    });
    return { cwd, ...result };
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

  private respondApproval(params: unknown): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const approvalId = readStringField(record, "approvalId");
    const decision = readStringField(record, "decision");
    if (decision !== "approve" && decision !== "deny") {
      throw rpcError(-32602, "invalid_params", "decision must be approve or deny.");
    }
    const store = this.context.storeRegistry.getStore(cwd);
    const existing = store.getApprovalRequest(approvalId);
    if (!existing) throw rpcError(-32040, "workspace_binding_invalid", `Approval request was not found: ${approvalId}`);
    const reason = readOptionalStringField(record, "reason");
    const now = new Date().toISOString();
    const input = {
      reason,
      resolvedBy: "local-user" as const,
      ...(decision === "approve" ? { decisionKind: readOptionalStringField(record, "decisionKind") as never ?? "approve_once" } : {}),
      ...(readOptionalStringField(record, "proposedRuleFingerprint") ? { proposedRuleFingerprint: readOptionalStringField(record, "proposedRuleFingerprint") } : {}),
    };
    const resolved = decision === "approve"
      ? store.approveApprovalRequest(approvalId, input, now)
      : store.denyApprovalRequest(approvalId, input, now);
    if (!resolved) throw rpcError(-32051, "request_already_resolved", `Approval request is no longer pending: ${approvalId}`);
    const continuation = decision === "approve"
      ? this.context.approvalResumeCoordinator.resumeAfterApproval({ store, approval: resolved })
      : this.context.approvalResumeCoordinator.finalizeSuspendedApprovalDenial({ store, approval: resolved });
    appendControlPlaneEvent(store, this.context.controlPlaneEvents, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      cwd,
      domain: "approvals",
      entityType: "approval",
      entityId: approvalId,
      action: "approval.resolved",
      data: { approvalId, status: resolved.status, decision, continuation },
    });
    return { cwd, approval: resolved, continuation };
  }

  private respondInput(params: unknown): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const threadId = readStringField(record, "threadId");
    const requestId = readStringField(record, "requestId");
    const answers = record.answers;
    if (!Array.isArray(answers)) throw rpcError(-32602, "invalid_params", "answers must be an array.");
    const submission = {
      requestId,
      expectedVersion: readOptionalIntegerField(record, "expectedVersion") ?? readOptionalIntegerField(record, "requestVersion"),
      expectedStatusRevision: readOptionalIntegerField(record, "expectedStatusRevision") ?? 0,
      idempotencyKey: readStringField(record, "idempotencyKey"),
      answers,
    };
    const store = this.context.storeRegistry.getStore(cwd);
    try {
      const receipt = store.submitUserInputAnswer({ threadId, submission: submission as never }, new Date().toISOString());
      this.context.userInputDeliveryWorker.wake(store);
      appendControlPlaneEvent(store, this.context.controlPlaneEvents, {
        workspaceId: DEFAULT_WORKSPACE_ID,
        cwd,
        domain: "runs",
        entityType: "user_input",
        entityId: requestId,
        action: "input.answer.accepted",
        idempotencyKey: submission.idempotencyKey,
        data: { threadId, requestId, deliveryId: receipt.deliveryId, replayed: receipt.replayed },
      });
      return { cwd, receipt };
    } catch (error) {
      throw rpcError(-32030, "stale_revision", error instanceof Error ? error.message : "The user input request is stale.");
    }
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
      afterSeq: readRpcAfterSeq(record.afterSeq ?? record.cursor),
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
          cursor: String(replay.window.nextAfterSeq),
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
    if (this.appServer) {
      const notification = appServerEventNotification(subscription.id, event);
      if (notification) this.send(notification);
    }
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

  private handleExternalAgentEvent(event: ExternalAgentFederationEvent): void {
    if (!this.appServer || !this.externalTaskIds.has(event.taskId)) return;
    const method = event.type === "task_started"
      ? "externalAgent/task/started"
      : event.type === "task_unknown"
        ? "externalAgent/task/unknown"
        : "externalAgent/task/updated";
    this.send({
      jsonrpc: "2.0",
      method,
      params: { taskId: event.taskId, cursor: event.cursor, eventType: event.type, payload: event.payload, createdAt: event.createdAt },
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
    this.externalAgentUnsubscribe();
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
  if (typeof value === "string") {
    const match = /^(?:seq:)?(\d+)$/u.exec(value);
    if (!match) throw new ControlPlaneBadRequestError("cursor must be a numeric sequence cursor");
    const parsed = Number(match[1]);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new ControlPlaneBadRequestError("cursor is outside the supported range");
    return parsed;
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

async function executeAppServerVerificationCheck(input: {
  readonly cwd: string;
  readonly check: import("@ling-stack/contracts").LingAppServerVerificationCheckPlan;
  readonly candidate: import("@ling-stack/contracts").LingAppServerCandidateReference;
  readonly signal?: AbortSignal;
}): Promise<import("@ling-stack/contracts").LingAppServerVerificationCheckStatus> {
  const command = input.check.command;
  if (!command) return "blocked";
  if (input.signal?.aborted) return "cancelled";
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (status: import("@ling-stack/contracts").LingAppServerVerificationCheckStatus): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
      resolve(status);
    };
    const child = spawn(command, { cwd: input.cwd, shell: true, stdio: "ignore", env: process.env });
    const abort = (): void => {
      child.kill("SIGTERM");
      finish("cancelled");
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish("unknown");
    }, 5 * 60 * 1000);
    input.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", () => finish("failed"));
    child.once("close", (code) => finish(code === 0 ? "passed" : "failed"));
  });
}

function collaborationRpcError(error: unknown): Error & { readonly jsonRpcCode: number; readonly code: string } {
  if (error instanceof AppServerCollaborationError) {
    const mapped = error.code === "work_item_not_found"
      ? { jsonRpcCode: -32040, code: "workspace_binding_invalid" }
      : error.code === "stale_revision"
        ? { jsonRpcCode: -32030, code: "stale_revision" }
        : error.code === "idempotency_conflict"
          ? { jsonRpcCode: -32031, code: "idempotency_conflict" }
          : { jsonRpcCode: -32602, code: "invalid_params" };
    return Object.assign(new Error(error.message), mapped);
  }
  return Object.assign(new Error(error instanceof Error ? error.message : String(error)), {
    jsonRpcCode: -32000,
    code: "collaboration_error",
  });
}

function collaborationNotificationMethod(kind: import("@ling-stack/contracts").LingAppServerCollaborationKind): string {
  switch (kind) {
    case "deliberation": return "workItem/deliberation/updated";
    case "stage": return "workItem/stage/updated";
    case "brief": return "workItem/brief/updated";
    case "coordination": return "workItem/coordination/updated";
    case "message": return "workItem/message/updated";
    case "question": return "workItem/question/updated";
    case "handoff": return "workItem/handoff/updated";
  }
}

const developmentByContext = new WeakMap<DaemonContext, AppServerDevelopmentService>();

function getAppServerDevelopmentService(context: DaemonContext): AppServerDevelopmentService {
  const existing = developmentByContext.get(context);
  if (existing) return existing;
  const created = new AppServerDevelopmentService({
    context,
    storeRegistry: context.storeRegistry,
    activeRuns: context.activeRuns,
    startCodeAssessmentRun: context.startCodeAssessmentRun,
    executeVerificationCheck: executeAppServerVerificationCheck,
  });
  developmentByContext.set(context, created);
  return created;
}

function controlPlaneNotification(subscriptionId: string, event: ControlPlaneEvent): unknown {
  return { jsonrpc: "2.0", method: "$/control_plane_event", params: { subscriptionId, event } };
}

function appServerEventNotification(subscriptionId: string, event: ControlPlaneEvent): unknown | undefined {
  const method = appServerEventMethod(event);
  if (!method) return undefined;
  return {
    jsonrpc: "2.0",
    method,
    params: {
      subscriptionId,
      cursor: String(event.seq),
      eventId: `${event.workspaceId}:${event.seq}`,
      workspaceId: event.workspaceId,
      subject: event.entityType === "thread"
        ? { kind: "thread", threadId: event.entityId }
        : event.entityType === "work_item"
          ? { kind: "workItem", workItemId: event.entityId }
          : { kind: "thread", threadId: event.data.threadId as string | undefined },
      revision: String(event.data.revision ?? event.ts),
      event,
      payload: event.data,
    },
  };
}

function appServerEventMethod(event: ControlPlaneEvent): string | undefined {
  if (event.entityType === "thread") {
    if (event.action === "thread.started") return "thread/started";
    if (event.action === "thread.archived") return "thread/archived";
    if (event.action === "thread.removed") return "thread/removed";
    if (event.action.startsWith("thread.")) return "thread/updated";
  }
  if (event.entityType === "turn") {
    if (event.action === "turn.started") return "turn/started";
    if (event.action === "turn.completed") return "turn/completed";
    if (event.action.includes("plan")) return "turn/plan/updated";
    if (event.action.includes("diff")) return "turn/diff/updated";
    if (event.action.startsWith("turn.")) return "turn/status/changed";
  }
  if (event.entityType === "work_item") {
    if (event.action === "work_item.created") return "workItem/created";
    if (event.action.includes("evidence")) return "workItem/evidence/updated";
    if (event.action.includes("control")) return "workItem/control/updated";
    if (event.action.includes("collaboration")) return "workItem/collaboration/updated";
    if (event.action.includes("delivery")) return "workItem/delivery/updated";
    if (event.action.includes("feedback")) return "workItem/feedback/received";
    if (event.action.includes("handoff")) return "workItem/handoff/updated";
    return "workItem/status/changed";
  }
  if (event.entityType === "approval" || event.entityType === "user_input") return "serverRequest/resolved";
  return undefined;
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
