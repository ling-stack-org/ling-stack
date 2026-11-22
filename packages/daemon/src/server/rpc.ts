import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  DEFAULT_WORKSPACE_ID,
  UserInputStoreError,
  evaluateDeliberationTrigger,
  type ControlPlaneDomain,
  type ControlPlaneEvent,
  type LingThreadGoal,
  type LingThread,
  type LingTurn,
  type RunEventEnvelope,
  type RunSession,
  type RunStore,
  type WorkItem,
  type WorkItemControlReceipt,
  type WorkItemSourceType,
  type WorkItemStatus,
} from "@ling-stack/core";
import {
  LING_APP_SERVER_IMPLEMENTED_CAPABILITIES,
  LING_APP_SERVER_METHODS,
  LING_APP_SERVER_NOTIFICATION_METHODS,
  LING_APP_SERVER_PROTOCOL_VERSION,
  LING_PRODUCT_VERSION,
  parseUserInputAnswerCommandV1,
  type ControlPlaneSubscribeResult,
  type LingAppServerContextInspectResult,
  type LingAppServerInputRespondResult,
  type LingAppServerGrant,
  type LingAppServerGitHubDeliveryResult,
  type LingAppServerJsonRpcId,
  type LingAppServerThreadEventsResult,
  type LingAppServerThreadSnapshotResult,
  type LingAppServerTurnResumeResult,
  type LingAppServerWorkItemControlResult,
  type LingAppServerWorkItemAcceptResult,
  type LingAppServerWorkItemConversationDispatch,
  type LingAppServerWorkItemReadResult,
  type LingAppServerWorkItemResult,
} from "@ling-stack/contracts";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { DaemonContext } from "../context.js";
import { daemonRequestIsAuthorized } from "./request-auth.js";
import { loadAppServerReplayIdentity, unavailableAppServerReplayWindow, type AppServerReplayScope } from "./app-server-replay.js";
import { isAllowedLocalOrigin, isDirectLoopbackRequest } from "../shared/local-workspace-access.js";
import { maybeScheduleRunTerminalReport } from "../features/channels/terminal-report-coordinator.js";
import { ensureRunCancelled } from "../features/runs/cancellation.js";
import { expireStaleApproval } from "../features/runs/approvals.js";
import { reconcileApprovalPostCommitEffects } from "../features/runs/approval-postcommit-effects.js";
import { HttpError } from "../errors.js";
import { prepareConversationSubmission } from "../features/conversations/conversation-submission.js";
import { parseConversationStreamRequest } from "../features/conversations/routes.js";
import { readConversationSubmission } from "../features/conversations/submission-receipts.js";
import { readNormalConversationPreparedRequest } from "../features/conversations/normal-conversation-prepared-request.js";
import { readRuntimeProjectInstructions } from "../features/conversations/runtime-project-instructions.js";
import {
  CONTROL_PLANE_POLL_DEFAULT_LIMIT,
  CONTROL_PLANE_POLL_MAX_LIMIT,
  CONTROL_PLANE_SSE_FLUSH_MS,
  CONTROL_PLANE_SSE_QUEUE_HARD_LIMIT,
  CONTROL_PLANE_SSE_QUEUE_WARNING_THRESHOLD,
  trimOversizedEvent,
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
import { toApprovalSummary } from "../features/control-plane/snapshots.js";
import { executeRunRequest, type RunExecutionSink } from "../features/runs/orchestrator.js";
import { parseRunRequest, type RunRequest } from "../features/runs/schemas.js";
import { bindGoalAcceptanceEvidence, buildLingThreadResumeContext, createLingThreadFork, parseCompleteLingThreadGoalBody, parsePutLingThreadGoalBody } from "../features/runs/thread-routes.js";
import { projectPublicRunSession } from "../features/runs/public-execution-snapshots.js";
import { projectPublicLingThread, projectPublicLingTurn } from "../features/runs/public-execution-snapshots.js";
import { maybeQueueGoalContinuation, maybeStartNextRunInterventionContinuation, recordUserRunIntervention, requestRunInterventionRedirect } from "../features/runs/interventions.js";
import { assertNoUnsafeRequiredPause } from "../features/runs/user-input-cancellation-guard.js";
import { submitAuthorizedUserInputAnswer } from "../features/runs/user-input-answer.js";
import { publishUserInputAnswerAcceptance } from "../features/runs/user-input-events.js";
import { RpcOutboundWriter, type RpcOutboundFrame } from "./rpc-outbound.js";
import { AppServerDevelopmentService } from "./app-server-development.js";
import { executeAppServerVerificationCheck } from "./app-server-verification-recipes.js";
import { captureCodeAssessmentSnapshot } from "../features/code-assessments/snapshot.js";
import { listManagedWorktrees, WorktreeActionError } from "../features/workspaces/worktree-management.js";
import { cleanupAppServerWorktree, createAppServerWorktree, previewAppServerWorktreeCleanup, refreshAppServerWorktree } from "./app-server-worktrees.js";
import { checkAppServerHandoff, createAppServerHandoff, handoffInstruction, readAppServerHandoff } from "./app-server-handoff.js";
import { normalConversationForkId } from "../features/conversations/normal-conversation-fork.js";
import {
  appServerGrantBearerPrefix, appServerGrantStillActive, authenticateAppServerGrant, createAppServerGrant,
  grantAllowsMethod, grantAllowsRequest, listAppServerGrants, revokeAppServerGrant,
} from "./app-server-authorization.js";
import { gitHubReadClient, gitHubWorkItemTargetKey, parseGitHubSubjectParams, readAppServerGitHubSubject } from "./app-server-github-subject.js";
import { readGitHubDelivery, reconcileGitHubDelivery } from "./app-server-github-delivery.js";
import { assertWorkItemConversationAdmission } from "../features/work-items/conversation-admission.js";
import {
  ExternalAgentFederationService,
  externalAgentRpcError,
  getExternalAgentFederation,
  type ExternalAgentFederationEvent,
} from "../runtime/external-agent/federation.js";
import { assertDispatchReady, dispatchExternalAgentTask, ExternalAgentDispatchError } from "../runtime/external-agent/task-dispatcher.js";
import { continuationSourceReady } from "../runtime/continuation-source-barrier.js";
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
  readonly filterEvent?: (event: ControlPlaneEvent) => boolean;
  readonly replayReadyMethod?: "thread/replay/ready" | "workItem/replay/ready";
  readonly replayScope?: AppServerReplayScope;
  readonly threadId?: string;
  readonly closeHub: () => void;
  readonly queue: { readonly event: ControlPlaneEvent; readonly frame: RpcOutboundFrame }[];
  readonly upstreamKey: string;
  readonly queueKey: string;
  closed: boolean;
  flushTimer?: NodeJS.Timeout;
}

export interface RpcWebSocketServerHandle {
  beginShutdown(): void;
  close(): void;
}

const APP_SERVER_RPC_PATH = "/app-server/rpc";
const APP_SERVER_MAX_REQUESTS = 64;
const APP_SERVER_MAX_SUBSCRIPTIONS = 32;
const legacyRpcMethods = new Set([
  "initialize", "daemon.health", "controlPlane.snapshot", "controlPlane.events",
  "controlPlane.subscribe", "controlPlane.unsubscribe", "runs.start", "runs.cancel",
]);
const UNIMPLEMENTED_APP_SERVER_METHODS = new Set([
  "turn/retry", "turn/steer", "thread/compact/start", "thread/revert",
  "changes/read",
  "changes/apply/preview", "changes/apply", "artifact/read",
  "model/list", "skill/read", "permissionProfile/list",
]);
const activeExternalDispatches = new WeakMap<DaemonContext, Map<string, AbortController>>();
const appServerConnectionsByContext = new WeakMap<DaemonContext, Set<RpcConnection>>();
const operatorMethods = new Set([
  "approval/respond", "input/respond", "verify/start", "verify/cancel", "review/start", "review/finding/update",
  "simplify/start", "simplify/status", "runs.start", "runs.cancel", "turn/queue", "turn/interrupt",
  "thread/delete", "thread/goal/set", "thread/goal/pause", "thread/goal/resume",
  "thread/goal/clear", "thread/goal/complete", "plan/accept",
  "worktree/create", "worktree/cleanup",
  "thread/fork", "handoff/create", "handoff/resume",
  "server/grants/create", "server/grants/list", "server/grants/revoke",
  "github/subject/read", "github/delivery/reconcile", "workItem/delivery/read", "delivery/read",
  "workItem/accept",
  "workItem/coordination/schedule/read", "workItem/coordination/schedule/set",
]);
const IMPLEMENTED_APP_SERVER_METHODS = LING_APP_SERVER_METHODS.filter(method => !UNIMPLEMENTED_APP_SERVER_METHODS.has(method));
const appServerMethods = new Set<string>([...IMPLEMENTED_APP_SERVER_METHODS, "runs.start", "runs.cancel", "turn/steer"]);
export function attachRpcWebSocketServer(
  server: Pick<Server, "on" | "off" | "once">, context: DaemonContext,
  options: { readonly permitsRemoteUpgrade?: (request: IncomingMessage) => boolean } = {},
): RpcWebSocketServerHandle {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const appServerConnections = new Set<RpcConnection>();
  const daemonConnections = appServerConnectionsByContext.get(context) ?? new Set<RpcConnection>();
  appServerConnectionsByContext.set(context, daemonConnections);
  const remote = Boolean(options.permitsRemoteUpgrade);
  let closed = false;
  let draining = false;
  const handleUpgrade: Parameters<Server["on"]>[1] = (request, socket, head) => {
    let url: URL;
    try { url = new URL(request.url ?? "/", "http://localhost"); }
    catch { rejectUpgrade(socket, 400, "Invalid WebSocket request path."); return; }
    const appServer = url.pathname === APP_SERVER_RPC_PATH;
    if (remote && !appServer) {
      rejectUpgrade(socket, 404, "The remote listener exposes only App Server RPC.");
      return;
    }
    if (url.pathname !== "/rpc/stream" && !appServer) {
      return;
    }
    if (draining && appServer) {
      rejectUpgrade(socket, 503, "App Server is draining.");
      return;
    }
    if (!remote && !context.config.transports.localWebSocketRpc) {
      rejectUpgrade(socket, 404, "WebSocket RPC transport is disabled");
      return;
    }
    const authorization = request.headers.authorization;
    const daemonAuthorized = daemonRequestIsAuthorized(context.config.authToken, authorization);
    const scopedBearer = appServer && typeof authorization === "string" && authorization.startsWith(appServerGrantBearerPrefix)
      && !(context.config.authToken && daemonAuthorized);
    if (remote && !options.permitsRemoteUpgrade?.(request)
      || appServer && !remote && (!isDirectLoopbackRequest(request) || !isAllowedLocalOrigin(request.headers.origin))) {
      rejectUpgrade(socket, 403, "The App Server listener does not permit this host or origin.");
      return;
    }
    if (remote && !scopedBearer) {
      rejectUpgrade(socket, 401, "Remote App Server access requires a scoped grant.");
      return;
    }
    if (!daemonAuthorized && !scopedBearer) {
      rejectUpgrade(socket, 401, "A valid bearer token is required for WebSocket RPC access.");
      return;
    }
    const cwd = url.searchParams.get("cwd");
    if (!cwd) {
      rejectUpgrade(socket, 400, "cwd query parameter is required");
      return;
    }
    let workspaceCwd = cwd;
    if (appServer) {
      try {
        workspaceCwd = realpathSync(cwd);
      } catch {
        rejectUpgrade(socket, 403, "The App Server workspace could not be resolved.");
        return;
      }
      if (!context.storeRegistry.isTrustedWorkspaceRoot(workspaceCwd)) {
        rejectUpgrade(socket, 403, "App Server access is limited to daemon-authorized workspaces.");
        return;
      }
    }
    let grant: LingAppServerGrant | undefined;
    if (scopedBearer) {
      try { grant = authenticateAppServerGrant(context.storeRegistry.getStore(workspaceCwd), authorization); }
      catch { /* A grant cannot authenticate while its workspace store is unavailable. */ }
      if (!grant) {
        rejectUpgrade(socket, 401, "The App Server grant is unavailable.");
        return;
      }
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const connection = new RpcConnection(ws, workspaceCwd, context, appServer, Boolean(context.config.authToken && daemonAuthorized),
        () => draining, grant, (cwd, id) => {
          for (const peer of daemonConnections) peer.invalidateGrant(cwd, id);
        });
      if (appServer) {
        appServerConnections.add(connection);
        daemonConnections.add(connection);
        ws.once("close", () => {
          appServerConnections.delete(connection);
          daemonConnections.delete(connection);
        });
      }
      connection.start();
    });
  };
  server.on("upgrade", handleUpgrade);
  const beginShutdown = (): void => {
    if (draining) return;
    draining = true;
    const drainId = randomUUID();
    const startedAt = new Date().toISOString();
    for (const connection of appServerConnections) connection.notifyDraining(drainId, startedAt);
    developmentByContext.get(context)?.abortVerifications();
    for (const controller of activeExternalDispatches.get(context)?.values() ?? []) controller.abort();
  };
  const closeAll = (): void => {
    if (closed) {
      return;
    }
    beginShutdown();
    closed = true;
    server.off("upgrade", handleUpgrade);
    for (const client of wss.clients) {
      client.terminate();
    }
    wss.close();
  };
  server.once("close", closeAll);
  return { beginShutdown, close: closeAll };
}

class RpcConnection {
  private readonly subscriptions = new Map<string, RpcSubscription>();
  private readonly outbound: RpcOutboundWriter;
  private readonly development: AppServerDevelopmentService;
  private readonly runCloseListeners = new Set<() => void>();
  private nextSubscriptionId = 1;
  private initialized = false;
  private closed = false;
  private readonly connectionId = `conn_${randomUUID()}`;
  private readonly pendingRequests = new Set<string>();
  private readonly cancelledRequests = new Set<string>();
  private readonly externalTaskIds = new Set<string>();
  private externalAgentUnsubscribe?: () => void;
  private externalAgentCwd?: string;
  private readonly onMessage = (data: RawData): void => { void this.handleMessage(data); };
  private readonly onConnectionClose = (): void => this.close();
  private readonly onConnectionError = (): void => this.close();

  constructor(
    private readonly ws: WebSocket,
    private readonly defaultCwd: string,
    private readonly context: DaemonContext,
    private readonly appServer: boolean,
    private readonly authenticated: boolean,
    private readonly draining: () => boolean,
    private readonly grant: LingAppServerGrant | undefined,
    private readonly revokeGrantConnection: (cwd: string, id: string) => void,
  ) {
    this.outbound = new RpcOutboundWriter(ws, {
      onClose: () => this.close(),
      ...(grant ? { canSend: () => this.grantIsCurrent() } : {}),
    });
    this.development = getAppServerDevelopmentService(context);
  }

  start(): void {
    this.ws.on("message", this.onMessage);
    this.ws.on("close", this.onConnectionClose);
    this.ws.on("error", this.onConnectionError);
  }

  invalidateGrant(cwd: string, grantId: string): void {
    if (this.grant?.grantId === grantId && this.defaultCwd === cwd) this.outbound.close(1008, "authorization_changed");
  }

  notifyDraining(drainId: string, startedAt: string): void {
    if (this.initialized) this.send({ jsonrpc: "2.0", method: "server/draining", params: { drainId, startedAt } });
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
    if (!this.appServer && !legacyRpcMethods.has(request.method)) {
      this.sendError(id, -32601, "method_not_found", `Unsupported RPC method: ${request.method}`);
      return;
    }

    const requestKey = request.id === undefined || request.method === "$/cancelRequest" ? undefined : jsonRpcIdKey(request.id);
    if (this.appServer && requestKey) {
      if (this.pendingRequests.has(requestKey)) {
        this.sendError(null, -32600, "invalid_request", "The request ID is already in use.");
        return;
      }
      if (this.pendingRequests.size >= APP_SERVER_MAX_REQUESTS) {
        this.sendError(id, -32001, "server_overloaded", "The connection has too many in-flight requests.");
        return;
      }
    }
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
      if (this.appServer && request.method === "initialized" && request.id === undefined) return;
      if (this.appServer && !appServerMethods.has(request.method)) {
        throw rpcError(-32601, "method_not_found", `Unsupported App Server method: ${request.method}`);
      }
      const params = this.appServer ? this.workspaceParams(request.params, operatorMethods.has(request.method)) : request.params;
      if (this.grant && (!this.grantIsCurrent()
        || !grantAllowsRequest(this.context.storeRegistry.getStore(this.defaultCwd), this.grant, request.method, readParamsRecord(params)))) {
        throw rpcError(-32021, "capability_denied", "The App Server grant does not authorize this method or subject.");
      }
      if (request.method === "controlPlane.subscribe") {
        if (this.appServer) {
          throw rpcError(-32601, "method_not_found", "Use thread/subscribe or workItem/subscribe on the App Server.");
        }
        if (request.id === undefined) {
          throw rpcError(-32600, "subscription_response_required", "controlPlane.subscribe requires a request id.");
        }
        const prepared = this.prepareControlPlaneSubscription(params);
        if (this.send({ jsonrpc: "2.0", id, result: prepared.result })) prepared.activate?.();
        return;
      }
      if (request.method === "workItem/subscribe") {
        if (request.id === undefined) {
          throw rpcError(-32600, "subscription_response_required", "workItem/subscribe requires a request id.");
        }
        const record = this.workspaceParams(params);
        const workItemId = readStringField(record, "workItemId");
        const prepared = this.prepareControlPlaneSubscription({ ...record, domains: ["work_items"] }, {
          filterEvent: (event) => event.entityType === "work_item" && event.entityId === workItemId
            || event.entityType === "verify_operation" && event.data.workItemId === workItemId,
          replayReadyMethod: "workItem/replay/ready",
          replayScope: this.replayIdentity(record.cwd).scope("workItem", workItemId),
        });
        if (this.send({ jsonrpc: "2.0", id, result: prepared.result })) prepared.activate?.();
        return;
      }
      if (request.method === "thread/subscribe") {
        if (request.id === undefined) {
          throw rpcError(-32600, "subscription_response_required", "thread/subscribe requires a request id.");
        }
        const record = this.workspaceParams(params);
        const threadId = readOptionalStringField(record, "threadId");
        const store = this.context.storeRegistry.getStore(record.cwd);
        if (threadId && !store.getLingThread(threadId)) throw rpcError(-32040, "workspace_binding_invalid", "Thread was not found.");
        const prepared = this.prepareControlPlaneSubscription({
          ...record,
          domains: ["runs", "approvals", "work_items", "work_units"],
        }, {
          ...(threadId ? { filterEvent: (event: ControlPlaneEvent) => threadEventMatches(event, threadId, store) } : {}),
          replayReadyMethod: "thread/replay/ready",
          replayScope: this.replayIdentity(record.cwd, store).scope("thread", threadId),
          threadId,
        });
        if (this.send({ jsonrpc: "2.0", id, result: prepared.result })) prepared.activate?.();
        return;
      }
      const result = await this.dispatch(request.method, params);
      if (request.id !== undefined && !this.cancelledRequests.has(requestKey!)) {
        if (this.appServer && this.canRespondToInput() && (request.method === "thread/snapshot" || request.method === "thread/resume")) {
          this.outbound.sendThreadSnapshot(id as LingAppServerJsonRpcId, result as LingAppServerThreadSnapshotResult);
        } else {
          this.send({ jsonrpc: "2.0", id, result });
        }
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
    if (this.appServer && this.draining()
      && !["initialize", "server/ping", "server/capabilities", "verify/status", "review/status", "simplify/status", "externalAgent/task/reconnect"].includes(method)) {
      throw rpcError(-32002, "server_draining", "App Server is draining.");
    }
    switch (method) {
      case "initialize": {
        this.validateInitializeParams(params);
        const cwd = this.appServer ? this.workspaceParams(params).cwd : undefined;
        const store = cwd === undefined ? undefined : this.context.storeRegistry.getInitializedStore(cwd);
        const identity = cwd !== undefined && store ? this.replayIdentity(cwd, store) : undefined;
        this.initialized = true;
        return this.appServer ? {
          protocolVersion: LING_APP_SERVER_PROTOCOL_VERSION,
          serverInfo: { name: "ling-stack-daemon", version: LING_PRODUCT_VERSION },
          connectionId: this.connectionId,
          effectiveScopes: this.grant?.scopes ?? ["controlPlane.read",
            ...(this.authenticated ? ["runs.control", "approval.decide", "input.respond", "verification.execute"] : [])],
          capabilities: this.availableCapabilities(),
          ...(identity ? { storeIncarnation: identity.storeIncarnation, authorizationEpoch: identity.authorizationEpoch } : {}),
          limits: {
            maxInboundFrameBytes: 1024 * 1024,
            maxOutboundFrameBytes: 128 * 1024,
            maxPendingRequests: APP_SERVER_MAX_REQUESTS,
            maxSubscriptions: APP_SERVER_MAX_SUBSCRIPTIONS,
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
      }
      case "server/ping":
        return { ok: true, connectionId: this.connectionId, serverTime: new Date().toISOString() };
      case "server/capabilities":
        return {
          protocolVersion: LING_APP_SERVER_PROTOCOL_VERSION,
          capabilities: this.availableCapabilities(),
          methods: IMPLEMENTED_APP_SERVER_METHODS.filter(method => this.grant
            ? grantAllowsMethod(this.grant, method) : this.authenticated || !operatorMethods.has(method)),
          notifications: LING_APP_SERVER_NOTIFICATION_METHODS,
        };
      case "server/grants/create":
      case "server/grants/list":
      case "server/grants/revoke": {
        const record = this.workspaceParams(params, true);
        const store = this.context.storeRegistry.getStore(record.cwd);
        if (method === "server/grants/create") return { cwd: record.cwd, grant: createAppServerGrant(store, record) };
        if (method === "server/grants/list") return { cwd: record.cwd, grants: listAppServerGrants(store) };
        const grant = revokeAppServerGrant(store, readStringField(record, "grantId"), readIntegerField(record, "expectedRevision", "revision"));
        this.revokeGrantConnection(record.cwd, grant.grantId);
        return { cwd: record.cwd, grant };
      }
      case "workspace/list":
        return { workspaces: [{ workspaceId: DEFAULT_WORKSPACE_ID, cwd: this.defaultCwd }] };
      case "workspace/read":
        return { workspaceId: DEFAULT_WORKSPACE_ID, cwd: readRpcCwd(readParamsRecord(params), this.defaultCwd) };
      case "worktree/list": {
        const { cwd } = this.workspaceParams(params);
        if (!this.context.storeRegistry.isTrustedWorkspaceRoot(cwd)) {
          throw rpcError(-32020, "authorization_required", "Managed worktrees require a daemon-known workspace.");
        }
        return listManagedWorktrees(this.context.storeRegistry.getStore(cwd), cwd);
      }
      case "worktree/create":
      case "worktree/refresh":
      case "worktree/cleanup/preview":
      case "worktree/cleanup": {
        const record = this.workspaceParams(params);
        const ownerKind = readStringField(record, "ownerKind");
        if (ownerKind !== "channel" && ownerKind !== "teammate") {
          throw rpcError(-32602, "invalid_params", "ownerKind must be channel or teammate.");
        }
        const target = { ownerKind, ownerId: readStringField(record, "ownerId") } as const;
        const store = this.context.storeRegistry.getStore(record.cwd);
        if (method === "worktree/create") return createAppServerWorktree(store, { ...target, baseBranch: readOptionalStringField(record, "baseBranch") });
        if (method === "worktree/refresh") return refreshAppServerWorktree(store, target);
        if (method === "worktree/cleanup/preview") return previewAppServerWorktreeCleanup(store, target);
        if (record.confirmed !== true) {
          throw rpcError(-32602, "worktree_confirmation_required", "Confirm the worktree cleanup preview.");
        }
        return cleanupAppServerWorktree(store, { ...target, expectedRevision: readStringField(record, "expectedRevision"), confirmed: true });
      }
      case "provider/list":
        return this.readControlPlaneDomain(params, "providers");
      case "skill/list":
        return this.readControlPlaneDomain(params, "skills");
      case "thread/start":
        return this.startThread(params);
      case "thread/read":
        return this.readThread(params);
      case "thread/fork":
        return this.forkThread(params);
      case "thread/resume":
        return this.readThreadSnapshot(params);
      case "thread/snapshot":
        return this.readThreadSnapshot(params);
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
      case "submission/read": {
        const { cwd, ...record } = this.workspaceParams(params);
        return readConversationSubmission(this.context.storeRegistry.getStore(cwd), {
          surface: "normal", threadId: readOptionalStringField(record, "threadId"), idempotencyKey: readStringField(record, "idempotencyKey"),
        });
      }
      case "thread/events/read": {
        const record = this.workspaceParams(params);
        const threadId = readStringField(record, "threadId");
        const store = this.context.storeRegistry.getStore(record.cwd);
        if (!store.getLingThread(threadId)) throw rpcError(-32040, "workspace_binding_invalid", "Thread was not found.");
        return this.readThreadEvents(store, threadId, record);
      }
      case "item/read": {
        const record = this.workspaceParams(params);
        const item = this.context.storeRegistry.getStore(record.cwd).getConversationItem(readStringField(record, "itemId"));
        const threadId = readStringField(record, "threadId");
        if (!item || item.threadId !== threadId) throw rpcError(-32040, "workspace_binding_invalid", "The item does not belong to this Thread.");
        return { cwd: record.cwd, item };
      }
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
        return await this.development.planVerification(this.workspaceParams(params) as never);
      case "changes/capture": {
        const { cwd } = this.workspaceParams(params);
        const snapshot = await captureCodeAssessmentSnapshot(cwd, { type: "working_tree" });
        return {
          cwd,
          candidate: { workspaceId: cwd, candidateDigest: snapshot.digest, filePaths: snapshot.files.map(file => file.path) },
          coverage: snapshot.coverage,
          headCommit: snapshot.headSha,
        };
      }
      case "verify/start":
        return await this.development.startVerification(params as never);
      case "verify/status":
        return this.development.getVerification(this.workspaceParams(params) as never);
      case "verify/cancel":
        return this.development.cancelVerification(params as never);
      case "review/start":
        return await this.development.startReview(params as never);
      case "review/status":
        return this.development.getReviewStatus(this.workspaceParams(params) as never);
      case "review/finding/update":
        return await this.development.updateReviewFinding(params as never);
      case "simplify/start":
        return await this.development.startSimplify(params as never);
      case "simplify/status":
        return this.development.getSimplifyStatus(params as never);
      case "doctor/run":
        return await this.development.runDoctor(params as never);
      case "instructions/init":
        return await this.development.initInstructions(this.workspaceParams(params, readParamsRecord(params).mode === "apply") as never);
      case "context/inspect":
        return this.inspectTurnContext(params);
      case "handoff/create": {
        const record = this.workspaceParams(params, true);
        const store = this.context.storeRegistry.getStore(record.cwd);
        const handoff = await createAppServerHandoff(this.context, store, {
          threadId: readStringField(record, "threadId"), turnId: readStringField(record, "turnId"),
          idempotencyKey: readStringField(record, "idempotencyKey"), nextInstruction: readStringField(record, "nextInstruction"),
        });
        return { cwd: record.cwd, handoff };
      }
      case "handoff/read": {
        const record = this.workspaceParams(params);
        const handoff = readAppServerHandoff(this.context.storeRegistry.getStore(record.cwd), readStringField(record, "handoffId"));
        return { cwd: record.cwd, handoff };
      }
      case "handoff/resume":
        return this.resumeHandoff(params);
      case "turn/start":
        return this.startTurn(params);
      case "approval/respond":
        return this.respondApproval(params);
      case "input/respond":
        return this.respondInput(params);
      case "turn/queue":
        return this.submitTurnIntervention(params, "queue_followup");
      case "turn/interrupt":
        return this.interruptTurn(params);
      case "turn/steer":
        throw rpcError(-32032, "steer_unsupported", "In-turn steering is not available on this Runner connection; queue or interrupt the Turn.");
      case "turn/resume":
        return await this.resumeTurn(params);
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
      case "runs.start": {
        if (!this.appServer) return this.startRun(params);
        const record = readParamsRecord(params);
        return this.startRun({ ...record, workspaceCwd: record.cwd });
      }
      case "runs.cancel":
        return this.cancelRun(params);
      case "workItem/list":
        return this.listWorkItems(params);
      case "workItem/create":
        return this.createWorkItem(params);
      case "github/subject/read": {
        const record = this.workspaceParams(params, true);
        const subjectParams = parseGitHubSubjectParams(record);
        const subject = await readAppServerGitHubSubject(gitHubReadClient(this.context, record.cwd, subjectParams.repository), subjectParams);
        return { cwd: record.cwd, subject };
      }
      case "github/delivery/reconcile": {
        const record = this.workspaceParams(params, true);
        const subject = parseGitHubSubjectParams({ repository: record.repository, kind: "pull_request", number: record.pullRequestNumber });
        const delivery = await reconcileGitHubDelivery(this.context, {
          cwd: record.cwd, repository: subject.repository, pullRequestNumber: subject.number,
          workItemId: readStringField(record, "workItemId"), threadId: readStringField(record, "threadId"),
          candidateDigest: readStringField(record, "candidateDigest"),
          expectedWorkItemRevision: readIntegerField(record, "expectedWorkItemRevision", "expectedRevision"),
        });
        return { cwd: record.cwd, delivery } satisfies LingAppServerGitHubDeliveryResult;
      }
      case "workItem/delivery/read":
      case "delivery/read": {
        const record = this.workspaceParams(params, true);
        const workItemId = readStringField(record, "workItemId");
        const deliveryId = method === "delivery/read" ? readStringField(record, "deliveryId") : undefined;
        const delivery = readGitHubDelivery(this.context.storeRegistry.getStore(record.cwd), workItemId, deliveryId);
        if (!delivery) throw rpcError(-32040, "github_delivery_binding_unavailable", "Delivery was not found for this Work Item.");
        return { cwd: record.cwd, delivery } satisfies LingAppServerGitHubDeliveryResult;
      }
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
      case "workItem/coordination/schedule/read":
      case "workItem/coordination/schedule/set":
        return this.coordinationSchedule(method, params);
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
        {
          const record = this.workspaceParams(params);
          return this.externalAgentsFor(record.cwd).readCapabilities(readStringField(record, "registrationId"));
        }
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

  private availableCapabilities(): readonly string[] {
    if (this.grant) {
      const capabilities = ["server/ping"];
      if (grantAllowsMethod(this.grant, "thread/subscribe")) capabilities.push("thread.events");
      if (grantAllowsMethod(this.grant, "turn/start")) capabilities.push("turn.control");
      if (grantAllowsMethod(this.grant, "approval/respond")) capabilities.push("approval.respond");
      if (grantAllowsMethod(this.grant, "input/respond")) capabilities.push("input.respond");
      if (grantAllowsMethod(this.grant, "workItem/read")) capabilities.push("workItem.read", "workItem.evidence");
      if (grantAllowsMethod(this.grant, "workItem/pause")) capabilities.push("workItem.control");
      return capabilities;
    }
    return LING_APP_SERVER_IMPLEMENTED_CAPABILITIES.filter(capability =>
      this.authenticated || (capability !== "turn.control" && capability !== "approval.respond"
        && capability !== "input.respond" && capability !== "development.simplify"));
  }

  private replayIdentity(cwd: string, store = this.context.storeRegistry.getStore(cwd)) {
    const key = this.grant
      ? JSON.stringify([this.context.config.authToken, this.grant.grantId, this.grant.revision])
      : this.context.config.authToken;
    return loadAppServerReplayIdentity(store, cwd, key);
  }

  private grantIsCurrent(): boolean {
    if (!this.grant) return true;
    try {
      return appServerGrantStillActive(this.context.storeRegistry.getStore(this.defaultCwd), this.grant);
    } catch {
      return false;
    }
  }

  private canRespondToInput(): boolean {
    return this.authenticated || Boolean(this.grant?.scopes.includes("respond"));
  }

  private workspaceParams(params: unknown, operator = false): Record<string, unknown> & { readonly cwd: string } {
    if (operator && (!this.appServer || !this.authenticated && !this.grant)) {
      throw rpcError(-32020, "authorization_required", "This App Server method requires the daemon operator bearer credential.");
    }
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    let canonical: string;
    try {
      canonical = realpathSync(cwd);
    } catch {
      throw rpcError(-32040, "workspace_binding_invalid", "The connection workspace could not be resolved.");
    }
    if (canonical !== this.defaultCwd) {
      throw rpcError(-32040, "workspace_binding_invalid", "The requested workspace differs from the connection workspace.");
    }
    if (operator && !this.context.storeRegistry.isTrustedWorkspaceRoot(canonical)) {
      throw rpcError(-32020, "authorization_required", "This operation requires a daemon-known workspace.");
    }
    return { ...record, cwd: canonical };
  }

  private validateInitializeParams(params: unknown): void {
    if (!this.appServer) return;
    const record = readParamsRecord(params);
    const versions = record.protocolVersions;
    if (!Array.isArray(versions) || !versions.every(value => typeof value === "string")) {
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
      ? requiredCapabilities.filter(value => !this.availableCapabilities().includes(value as never))
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

  private async createWorkItem(params: unknown): Promise<LingAppServerWorkItemResult> {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const sourceType = readOptionalWorkItemSourceType(record.sourceType) ?? "manual";
    const sourceId = readStringField(record, "sourceId");
    const title = readStringField(record, "title");
    const idempotencyKey = readOptionalStringField(record, "idempotencyKey");
    if (idempotencyKey !== undefined && (!idempotencyKey.trim() || idempotencyKey.length > 200)) {
      throw rpcError(-32602, "invalid_params", "idempotencyKey must be a non-empty string of up to 200 characters.");
    }
    const store = this.context.storeRegistry.getStore(cwd);
    let verifiedTargetKey: string | undefined;
    if (record.gitHubSubject !== undefined) {
      this.workspaceParams(params, true);
      const subjectParams = parseGitHubSubjectParams(record.gitHubSubject);
      const subject = await readAppServerGitHubSubject(gitHubReadClient(this.context, cwd, subjectParams.repository), subjectParams);
      verifiedTargetKey = gitHubWorkItemTargetKey(subject);
    }
    const input = {
      id: readOptionalStringField(record, "workItemId"),
      sourceType,
      sourceId,
      title,
      ...(this.appServer ? { initialStatus: "intake" as const } : {}),
      description: readOptionalStringField(record, "description"),
      priority: readOptionalWorkItemPriority(record.priority),
      labels: Array.isArray(record.labels) && record.labels.every((value) => typeof value === "string") ? record.labels as string[] : undefined,
      idempotencyKey,
      verifiedTargetKey,
    };
    try {
      const { workItem, event, sourceReceipt } = store.createWorkItem(input, new Date().toISOString(), cwd);
      if (event) this.context.controlPlaneEvents.publish(trimOversizedEvent(event));
      return { cwd, workItem: projectWorkItemSnapshot(workItem), ...(sourceReceipt ? { sourceReceipt } : {}) };
    } catch (error) {
      if (error instanceof Error && error.message === "work_item_creation_idempotency_conflict") {
        throw rpcError(-32031, "idempotency_conflict", "The creation key was reused with different input.");
      }
      if (error instanceof Error && error.message === "work_item_creation_source_conflict") {
        throw rpcError(-32040, "workspace_binding_invalid", "The Work Item ID does not match the supplied source.");
      }
      throw error;
    }
  }

  private async acceptWorkItem(params: unknown): Promise<LingAppServerWorkItemAcceptResult> {
    const record = this.workspaceParams(params);
    const { cwd } = record;
    const workItemId = readStringField(record, "workItemId");
    const store = this.context.storeRegistry.getStore(cwd);
    if (!store.getWorkItem(workItemId)) throw rpcError(-32040, "workspace_binding_invalid", "Work Item was not found.");
    const input = {
      expectedRevision: readIntegerField(record, "expectedWorkItemRevision", "expectedRevision"),
      actorId: readOptionalStringField(record, "actorId") ?? "local-user",
      idempotencyKey: readStringField(record, "idempotencyKey"),
      dispatch: readOptionalWorkItemConversationDispatch(record.dispatch),
    };
    let result;
    try {
      result = store.acceptWorkItem(workItemId, input, new Date().toISOString(), cwd);
    } catch (error) {
      if (error instanceof Error && error.message === "work_item_acceptance_idempotency_conflict") {
        throw rpcError(-32031, "idempotency_conflict", "The acceptance key was reused with different input.");
      }
      if (error instanceof Error && error.message === "work_item_acceptance_already_committed") {
        throw rpcError(-32030, "stale_revision", "The Work Item already has an accepted dispatch.");
      }
      if (error instanceof Error && error.message === "work_item_dispatch_thread_unavailable") {
        throw rpcError(-32040, "workspace_binding_invalid", "The selected conversation is unavailable for first dispatch.");
      }
      throw error;
    }
    if (!result) throw rpcError(-32030, "stale_revision", "The Work Item is no longer eligible for acceptance at this revision.");
    const { workItem, receipt, replayed, event } = result;
    if (event) this.context.controlPlaneEvents.publish(trimOversizedEvent(event));
    const { dispatch, ...acceptance } = receipt;
    const started = dispatch ? await this.dispatchAcceptedWorkItem(store, cwd, workItem, dispatch) : undefined;
    return {
      cwd, accepted: true, workItem: projectWorkItemSnapshot(store.getWorkItem(workItemId) ?? workItem), acceptance, replayed,
      ...(started ? { dispatch: started } : {}),
    };
  }

  private async dispatchAcceptedWorkItem(
    store: RunStore, cwd: string, workItem: WorkItem,
    intent: LingAppServerWorkItemConversationDispatch & { readonly submissionKey: string },
  ): Promise<NonNullable<LingAppServerWorkItemAcceptResult["dispatch"]>> {
    const { threadId, submissionKey, providerPresetId, message } = intent;
    const identity = { threadId, submissionKey };
    const thread = store.getLingThread(threadId);
    if (workItem.runId) return { ...identity, status: "admitted", runId: workItem.runId };
    if (!thread) return { ...identity, status: "held", blocker: "work_item_dispatch_thread_unavailable" };
    try {
      await this.startConversationTurn({ threadId, providerPresetId, idempotencyKey: submissionKey }, thread, cwd, message);
    } catch (error) {
      const blocker = normalizeRpcError(error).code;
      const runId = store.getWorkItem(workItem.id)?.runId;
      if (runId) return { ...identity, status: "admitted", runId };
      return { ...identity, status: blocker === "work_item_dispatch_held" ? "held" : "pending", blocker };
    }
    const runId = store.getWorkItem(workItem.id)?.runId;
    return runId ? { ...identity, status: "admitted", runId } : { ...identity, status: "pending" };
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

  private coordinationSchedule(method: "workItem/coordination/schedule/read" | "workItem/coordination/schedule/set", params: unknown): unknown {
    const record = this.workspaceParams(params, true);
    const automationId = readStringField(record, "automationId");
    const workItemId = readStringField(record, "workItemId");
    const store = this.context.storeRegistry.getStore(record.cwd);
    if (method === "workItem/coordination/schedule/read") {
      const schedule = store.getAutomationCoordinationSchedule(automationId);
      return { cwd: record.cwd, schedule: schedule?.workItemId === workItemId ? schedule : null };
    }
    const { enabled, kind } = record;
    const expectedRevision = readOptionalIntegerField(record, "expectedRevision");
    const durationMs = readOptionalIntegerField(record, "durationMs");
    if (typeof enabled !== "boolean" || kind !== "checkpoint" && kind !== "retrospective"
      || expectedRevision === undefined || expectedRevision < 0 || durationMs === undefined || durationMs < 1000 || durationMs > 24 * 60 * 60_000) {
      throw rpcError(-32602, "invalid_params", "Supply the schedule kind, enabled state, revision and a duration between one second and one day.");
    }
    const schedule = store.configureAutomationCoordination({ automationId, workItemId, enabled, kind, expectedRevision, durationMs },
      new Date().toISOString());
    return { cwd: record.cwd, schedule };
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
    }, new Date().toISOString(), { cwd });
    if (!result) throw rpcError(-32030, "stale_revision", "The Work Item or evidence revision is stale.");
    const { event, ...evidence } = result;
    if (event) this.context.controlPlaneEvents.publish(trimOversizedEvent(event));
    return { cwd, workItemId, ...evidence };
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
      const store = this.context.storeRegistry.getStore(cwd);
      const scope = this.replayIdentity(cwd, store).scope("workItem", workItemId);
      const parentRecordId = readOptionalStringField(record, "parentRecordId");
      if (kind === "coordination" && action === "closed" && parentRecordId && store.readScheduledCoordinationRound(parentRecordId)) {
        this.workspaceParams(params, true);
        const closed = store.closeScheduledCoordination({
          workItemId, recordId: parentRecordId, actorId: readStringField(record, "actorId"), cause: "owner_closed",
          expectedWorkItemRevision: readOptionalIntegerField(record, "expectedWorkItemRevision"),
          expectedCollaborationRevision: readOptionalIntegerField(record, "expectedCollaborationRevision"),
        }, new Date().toISOString(), cwd);
        if (!closed) throw rpcError(-32040, "coordination_subject_unavailable", "The coordination round is unavailable.");
        const { event, ...result } = closed.result;
        if (closed.briefEvent) this.context.controlPlaneEvents.publish(trimOversizedEvent(closed.briefEvent));
        if (event) this.context.controlPlaneEvents.publish(trimOversizedEvent(event));
        return { cwd, ...result };
      }
      const { event, ...result } = appendAppServerWorkItemCollaboration(store, {
        ...record,
        cwd,
        workItemId,
        kind,
        action,
        payload,
      } as never, new Date().toISOString());
      if (event) {
        this.context.controlPlaneEvents.publish(trimOversizedEvent(event));
        if (this.appServer) this.send({
          jsonrpc: "2.0", method: collaborationNotificationMethod(kind),
          params: { cwd, workItemId, record: result.record, eventId: scope.eventId(event.workspaceId, event.seq), cursor: scope.issue(event.seq) },
        });
      }
      return { cwd, ...result };
    } catch (error) {
      throw collaborationRpcError(error);
    }
  }

  private externalAgentsFor(cwd: string): ExternalAgentFederationService {
    const federation = getExternalAgentFederation(this.context, cwd);
    if (this.externalAgentCwd !== cwd) {
      this.externalAgentUnsubscribe?.();
      this.externalAgentCwd = cwd;
      this.externalAgentUnsubscribe = federation.subscribe(event => this.handleExternalAgentEvent(event));
    }
    return federation;
  }

  private registerExternalAgent(params: unknown): unknown {
    try {
      const record = this.workspaceParams(params);
      const result = this.externalAgentsFor(record.cwd).register(record as never);
      if (this.appServer) {
        this.send({ jsonrpc: "2.0", method: "externalAgent/registered", params: result });
      }
      return result;
    } catch (error) {
      throw externalAgentRpcError(error);
    }
  }

  private startExternalAgentTask(params: unknown): unknown {
    const record = this.workspaceParams(params);
    const { cwd } = record;
    const registrationId = readStringField(record, "registrationId");
    const submission = readParamsRecord(record.submission);
    const workItemId = readStringField(submission, "workItemId");
    const workItemRevision = readStringField(submission, "workItemRevision");
    const federation = this.externalAgentsFor(cwd);
    const store = this.context.storeRegistry.getStore(cwd);
    const assertAdmission = () => {
      const workItem = store.getWorkItem(workItemId);
      if (!workItem || submission.workspaceId !== workItem.workspaceId) {
        throw rpcError(-32040, "workspace_binding_invalid", "The Work Item does not belong to this workspace.");
      }
      if (workItemRevision !== String(workItem.revision)) {
        throw rpcError(-32030, "stale_revision", "The external Agent Work Item revision is stale.");
      }
      if (workItem.control.state !== "active" || workItem.holds.some(hold => hold.blocksNewAdmission)
        || ["intake", "triage", "backlog", "done", "cancelled", "archived", "superseded"].includes(workItem.status)) {
        throw rpcError(-32061, "resume_blocked", "The current Work Item does not admit external Agent dispatch.");
      }
    };
    try {
      const hostDispatch = this.appServer && this.authenticated;
      const result = federation.startTask(record as never, assertAdmission, hostDispatch);
      const task = result.task;
      this.externalTaskIds.add(task.taskId);
      if (!result.replayed) {
        appendControlPlaneEvent(store, this.context.controlPlaneEvents, {
          workspaceId: DEFAULT_WORKSPACE_ID, cwd, domain: "runners", entityType: "external_agent_task",
          entityId: task.taskId, action: "external_agent.task.started", idempotencyKey: task.submissionId,
          data: { registrationId, workItemId, status: task.status, dispatchDepth: task.dispatchDepth },
        });
        if (hostDispatch) this.dispatchExternalAgentTask(cwd, federation, registrationId, task.taskId, submission, assertAdmission);
      }
      const response = { ...result, task: federation.getTask(task.taskId)!.task };
      if (this.appServer && !result.replayed) this.send({ jsonrpc: "2.0", method: "externalAgent/task/started", params: response });
      return response;
    } catch (error) {
      if (error instanceof Error && "jsonRpcCode" in error) throw error;
      throw externalAgentRpcError(error);
    }
  }

  private dispatchExternalAgentTask(
    cwd: string,
    federation: ExternalAgentFederationService,
    registrationId: string,
    taskId: string,
    submission: Record<string, unknown>,
    assertAdmission: () => void,
  ): void {
    if (!this.context.storeRegistry.isTrustedWorkspaceRoot(cwd)) {
      federation.markUnknown(taskId, "dispatch_workspace_untrusted");
      return;
    }
    const registration = federation.getRegistration(registrationId)?.registration;
    if (!registration) {
      federation.markUnknown(taskId, "dispatch_registration_unavailable");
      return;
    }
    const runnerId = registration.adapterKind === "acp" ? "openclaw-acp" : registration.adapterKind;
    const runner = this.context.runnerRegistry.get(runnerId);
    const acceptance = typeof submission.acceptanceSnapshot === "object" && submission.acceptanceSnapshot !== null
      ? submission.acceptanceSnapshot as Record<string, unknown>
      : {};
    const provider = typeof acceptance.provider === "object" && acceptance.provider !== null
      ? acceptance.provider as Record<string, unknown> : undefined;
    if (!runner) {
      federation.markUnknown(taskId, "dispatch_runner_unavailable");
      return;
    }
    if (!provider || typeof provider.provider !== "string" || !provider.provider.trim()
      || typeof provider.model !== "string" || !provider.model.trim()) {
      federation.markUnknown(taskId, "dispatch_provider_unavailable");
      return;
    }
    const objective = readStringField(submission, "objective");
    const controller = new AbortController();
    const dispatch = {
      federation, taskId, runner, assertAdmission,
      options: {
        cwd,
        task: { id: taskId, title: objective.slice(0, 120), prompt: objective },
        provider: { provider: provider.provider, model: provider.model },
        tools: registration.toolScopes,
        signal: controller.signal,
      },
    };
    try {
      assertDispatchReady(dispatch);
    } catch (error) {
      federation.markUnknown(taskId, error instanceof ExternalAgentDispatchError ? error.code : "dispatch_preflight_failed");
      return;
    }
    let active = activeExternalDispatches.get(this.context);
    if (!active) {
      active = new Map();
      activeExternalDispatches.set(this.context, active);
    }
    active.set(taskId, controller);
    const settled = dispatchExternalAgentTask(dispatch).catch(error => {
      try {
        federation.markUnknown(taskId, error instanceof ExternalAgentDispatchError ? error.code : undefined);
      } catch { /* The retained dispatch receipt is available for recovery. */ }
    }).finally(() => active.delete(taskId));
    this.context.activeRuns.trackCompletion(settled);
  }

  private reconnectExternalAgentTask(params: unknown): unknown {
    try {
      const record = this.workspaceParams(params);
      const result = this.externalAgentsFor(record.cwd).reconnectTask(record as never);
      if (result.reason !== "authorization_changed") this.externalTaskIds.add(result.task.taskId);
      if (this.appServer) this.send({ jsonrpc: "2.0", method: "externalAgent/task/reconnected", params: result });
      return result;
    } catch (error) {
      throw externalAgentRpcError(error);
    }
  }

  private async cancelExternalAgentTask(params: unknown): Promise<unknown> {
    try {
      const record = this.workspaceParams(params);
      const taskId = readStringField(record, "taskId");
      const federation = this.externalAgentsFor(record.cwd);
      const active = activeExternalDispatches.get(this.context)?.get(taskId);
      return await federation.cancelTask(record as never, active ? async () => {
        active.abort();
        return "unknown";
      } : undefined);
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
    const kind = readLingThreadKind(readOptionalStringField(record, "kind") ?? "conversation");
    const threadId = readOptionalStringField(record, "threadId");
    const prior = threadId ? store.getLingThread(threadId) : undefined;
    if (prior) {
      if (prior.kind !== kind || prior.title !== title || prior.objective !== objective) {
        throw rpcError(-32031, "idempotency_conflict", "The Thread ID belongs to a different request.");
      }
      return { cwd, thread: projectPublicLingThread(prior), replayed: true };
    }
    const thread = store.createLingThread({
      id: threadId,
      kind,
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

  private forkThread(params: unknown): unknown {
    const record = this.workspaceParams(params, true);
    const store = this.context.storeRegistry.getStore(record.cwd);
    const sourceThread = store.getLingThread(readStringField(record, "threadId"));
    if (!sourceThread) throw rpcError(-32040, "workspace_binding_invalid", "The source Thread was not found.");
    const fork = createLingThreadFork({ store, sourceThread, body: record, now: new Date().toISOString() });
    this.publishForkedThread(store, record.cwd, fork.childThread, sourceThread.id);
    return {
      cwd: record.cwd, sourceThreadId: sourceThread.id, sourceTurnId: fork.sourceTurn?.id, sourceRunId: fork.sourceRun?.id,
      thread: projectPublicLingThread(fork.childThread), replayed: !fork.created,
    };
  }

  private async resumeHandoff(params: unknown) {
    const record = this.workspaceParams(params, true);
    const store = this.context.storeRegistry.getStore(record.cwd);
    const handoff = readAppServerHandoff(store, readStringField(record, "handoffId"));
    const providerPresetId = readStringField(record, "providerPresetId");
    if (!store.getProviderPreset(providerPresetId)) {
      throw rpcError(-32602, "invalid_params", "The Handoff requires an available provider preset.");
    }
    const idempotencyKey = `app-server-handoff:${handoff.handoffId}`;
    const childId = normalConversationForkId(handoff.sourceThreadId, idempotencyKey);
    let child = store.getLingThread(childId);
    const receipt = readConversationSubmission(store, { surface: "normal", threadId: childId, idempotencyKey });
    const acceptedTurn = receipt.status === "accepted" && receipt.turnId ? store.getLingTurn(receipt.turnId) : undefined;
    if (child && store.getNormalConversationForkSeed(child.id)?.threadId !== handoff.sourceThreadId) {
      throw rpcError(-32031, "idempotency_conflict", "The Handoff child Thread has a different origin.");
    }
    if (!acceptedTurn || !acceptedTurn.activeRunId && !acceptedTurn.lastRunId) {
      const sourceThread = await checkAppServerHandoff(this.context, store, handoff);
      child = createLingThreadFork({
        store, sourceThread, now: new Date().toISOString(),
        body: { turnId: handoff.sourceTurnId, sourceRunId: handoff.sourceRunId, idempotencyKey,
          title: `Handoff: ${sourceThread.title}`, objective: handoff.goal?.objective ?? sourceThread.objective },
      }).childThread;
    }
    if (!child) throw rpcError(-32061, "resume_blocked", "The Handoff receipt has no available child Thread.");
    this.publishForkedThread(store, record.cwd, child, handoff.sourceThreadId);
    const result = await this.startConversationTurn({ idempotencyKey, providerPresetId }, child, record.cwd, handoffInstruction(handoff));
    return { ...result, handoffId: handoff.handoffId };
  }

  private publishForkedThread(store: RunStore, cwd: string, thread: LingThread, sourceThreadId: string): void {
    const idempotencyKey = `app-server-fork:${thread.id}`;
    if (store.getControlPlaneEventByIdempotency(thread.workspaceId, idempotencyKey)) return;
    const event = store.appendControlPlaneEvent({
      workspaceId: thread.workspaceId, cwd, domain: "runs", entityType: "thread", entityId: thread.id,
      action: "thread.started", idempotencyKey, data: { threadId: thread.id, sourceThreadId, status: thread.status },
    }, new Date().toISOString());
    this.context.controlPlaneEvents.publish(trimOversizedEvent(event));
  }

  private readThreadSnapshot(params: unknown): LingAppServerThreadSnapshotResult {
    const { cwd, ...record } = this.workspaceParams(params);
    const threadId = readStringField(record, "threadId");
    const store = this.context.storeRegistry.getStore(cwd);
    const scope = this.replayIdentity(cwd, store).scope("thread", threadId);
    return store.readSnapshot(() => {
      const thread = store.getLingThread(threadId);
      if (!thread) throw rpcError(-32040, "workspace_binding_invalid", "Thread was not found.");
      const activeTurn = thread.activeRunId ? store.getLingTurnForRun(thread.activeRunId) : undefined;
      const turn = activeTurn ?? latestConversationTurn(store, threadId);
      const runId = turn?.activeRunId ?? turn?.lastRunId;
      const run = runId ? store.getRun(runId) : undefined;
      const goal = store.getLingThreadGoal(threadId);
      const pendingApprovals = run ? store.listApprovalRequests({ runId: run.id, status: "pending" }).map(toApprovalSummary) : [];
      const itemIds = turn ? store.listConversationItemsForTurn({ turnId: turn.id })
        .filter(item => item.kind === "user_input_request").map(item => item.id) : [];
      const pendingInputs = itemIds.length ? store.readUserInputTranscript({ threadId, itemIds }).flatMap(item => {
        if (item.availability !== "available" || item.kind !== "user_input_request" || item.status !== "pending") return [];
        return [this.canRespondToInput() ? item : { ...item, answerAuthority: undefined }];
      }) : [];
      return { cwd, thread: projectPublicLingThread(thread), turn: projectPublicLingTurn(turn, thread) ?? null,
        goal: goal ? { id: goal.id, objective: goal.objective, status: goal.status,
          tokenBudget: goal.tokenBudget, tokensUsed: goal.tokensUsed, timeUsedSeconds: goal.timeUsedSeconds, updatedAt: goal.updatedAt } : null,
        run: run ? { id: run.id, status: run.status, startedAt: run.startedAt, endedAt: run.endedAt } : null,
        pendingApprovals, pendingInputs,
        cursor: scope.issue(store.getLatestControlPlaneEventSeq(DEFAULT_WORKSPACE_ID)) };
    });
  }

  private inspectTurnContext(params: unknown): LingAppServerContextInspectResult {
    const { cwd, ...record } = this.workspaceParams(params);
    const threadId = readStringField(record, "threadId");
    const turnId = readStringField(record, "turnId");
    const store = this.context.storeRegistry.getStore(cwd);
    const turn = store.getLingTurn(turnId);
    if (!turn || turn.threadId !== threadId) throw rpcError(-32040, "workspace_binding_invalid", "Turn is outside the supplied Thread.");
    const request = turn.sourceItemId ? readNormalConversationPreparedRequest(store, turn.sourceItemId) : undefined;
    const projectInstructionUpdates = readRuntimeProjectInstructions(store, turnId);
    return { cwd, threadId, turnId, projectInstructions: request?.projectInstructionManifest ?? null,
      ...(projectInstructionUpdates.length ? { projectInstructionUpdates } : {}),
      context: request?.normalConversationContext?.projection ?? null };
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
    const workItemIds = store.listLingThreadWorkItemDependencies(threadId);
    if (workItemIds.length) blockers.push("current Work Item depends on thread");
    if (goal && ["active", "paused", "blocked", "usage_limited", "budget_limited"].includes(goal.status)) blockers.push("active goal depends on thread");
    if (plans.some((plan) => plan.status === "accepted")) blockers.push("accepted plan depends on thread");
    return {
      cwd,
      threadId,
      revision: thread.updatedAt,
      allowed: blockers.length === 0,
      blockers,
      dependencies: { turnCount: turns.length, goalId: goal?.id, planIds: plans.filter((plan) => plan.status === "accepted").map((plan) => plan.id), workItemIds },
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
    const result = store.hardDeleteLingThread(threadId, {
      reason: readOptionalStringField(record, "reason"),
      expectedThreadRevision: readOptionalStringField(record, "expectedRevision"),
    }, new Date().toISOString());
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
    const { replaceExisting, tokenBudget, ...input } = parsePutLingThreadGoalBody(record);
    const store = this.context.storeRegistry.getStore(cwd);
    if (!store.getLingThread(threadId)) throw rpcError(-32040, "workspace_binding_invalid", `Thread was not found: ${threadId}`);
    const now = new Date().toISOString();
    const existing = store.getLingThreadGoal(threadId);
    assertGoalRevision(existing, readOptionalStringField(record, "expectedGoalRevision"));
    if (existing && !replaceExisting) {
      throw rpcError(-32030, "goal_replace_required", "Pass replaceExisting=true to accept a replacement for the current Goal.");
    }
    const goalInput = { ...input, threadId, tokenBudget: tokenBudget ?? undefined };
    const goal = existing
      ? store.replaceLingThreadGoal(goalInput, now)
      : store.createLingThreadGoal(goalInput, now);
    this.publishThreadGoal(store, cwd, goal);
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
    this.publishThreadGoal(store, cwd, updated);
    return { cwd, threadId, goal: updated };
  }

  private clearThreadGoal(params: unknown): unknown {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const threadId = readStringField(record, "threadId");
    const store = this.context.storeRegistry.getStore(cwd);
    const goal = store.clearLingThreadGoal(threadId, new Date().toISOString());
    if (!goal) throw rpcError(-32040, "workspace_binding_invalid", `Goal was not found for Thread: ${threadId}`);
    this.publishThreadGoal(store, cwd, goal);
    return { cwd, threadId, goal };
  }

  private async completeThreadGoal(params: unknown): Promise<unknown> {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const threadId = readStringField(record, "threadId");
    const store = this.context.storeRegistry.getStore(cwd);
    const goal = store.getLingThreadGoal(threadId);
    if (!goal) throw rpcError(-32040, "workspace_binding_invalid", `Goal was not found for Thread: ${threadId}`);
    assertGoalRevision(goal, readOptionalStringField(record, "expectedGoalRevision"));
    const input = parseCompleteLingThreadGoalBody({
      ...record, actor: record.actor ?? record.completedBy,
      evidenceRefs: record.evidenceRefs ?? record.completionEvidenceRefs,
      completionVerificationSummary: record.completionVerificationSummary ?? record.verificationSummary,
    });
    const prepared = await bindGoalAcceptanceEvidence(store, goal, input, params => reconcileGitHubDelivery(this.context, params));
    const updated = store.updateLingThreadGoal(goal.id, prepared, new Date().toISOString());
    if (!updated) throw rpcError(-32040, "workspace_binding_invalid", `Goal was not found: ${goal.id}`);
    this.publishThreadGoal(store, cwd, updated);
    return { cwd, threadId, goal: updated };
  }

  private publishThreadGoal(store: import("@ling-stack/core").RunStore, cwd: string, goal: LingThreadGoal): void {
    appendControlPlaneEvent(store, this.context.controlPlaneEvents, {
      workspaceId: goal.workspaceId,
      cwd,
      domain: "runs",
      entityType: "thread_goal",
      entityId: goal.id,
      action: "thread.goal.updated",
      data: { threadId: goal.threadId, goalId: goal.id, status: goal.status, revision: goal.updatedAt },
    });
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

  private async resumeTurn(params: unknown): Promise<LingAppServerTurnResumeResult> {
    const { cwd, ...record } = this.workspaceParams(params);
    const turnId = readStringField(record, "turnId");
    const expectedThreadId = readOptionalStringField(record, "threadId");
    const expectedRevision = readOptionalStringField(record, "expectedTurnRevision");
    const expectedRunId = readOptionalStringField(record, "sourceRunId");
    const store = this.context.storeRegistry.getStore(cwd);
    const turn = store.getLingTurn(turnId);
    const thread = turn && store.getLingThread(turn.threadId);
    if (!turn || !thread || expectedThreadId !== undefined && thread.id !== expectedThreadId) {
      throw rpcError(-32040, "workspace_binding_invalid", "Turn is outside the supplied Thread.");
    }
    const sourceRunId = turn.activeRunId ?? turn.lastRunId;
    const run = sourceRunId ? store.getRun(sourceRunId) : undefined;
    if (expectedRunId !== undefined && expectedRunId !== run?.id) {
      throw rpcError(-32030, "stale_revision", "The source Turn Run has changed.");
    }
    const key = readOptionalStringField(record, "idempotencyKey");
    if (!this.appServer || run && (key === undefined || run.status !== "failed" && run.status !== "cancelled")) {
      return projectTurnResume(store, cwd, thread, turn, run, "existing");
    }
    this.workspaceParams({ cwd }, true);
    if (expectedRevision !== turn.updatedAt) {
      throw rpcError(-32030, "stale_revision", "Read the current Turn revision before requesting recovery.");
    }
    if (thread.kind !== "conversation" || thread.channelId || thread.archivedAt || thread.status === "archived") {
      throw rpcError(-32061, "resume_blocked", "The Turn belongs to a different execution owner.");
    }
    const latestTurnId = latestConversationTurn(store, thread.id)?.id;
    if (!run) {
      if (sourceRunId || store.listLingTurnRuns(turn.id).length !== 0 || turn.status !== "open"
        || latestTurnId !== turn.id || thread.activeRunId) {
        throw rpcError(-32061, "resume_blocked", "The prepared Turn no longer owns admission.");
      }
      const prepared = turn.sourceItemId && readNormalConversationPreparedRequest(store, turn.sourceItemId);
      if (!prepared || prepared.threadId !== thread.id || prepared.turnId !== turn.id || prepared.workspaceCwd !== cwd) {
        throw rpcError(-32061, "resume_blocked", "The Turn has no saved execution preparation.");
      }
      this.publishConversationTurnStarted(store, cwd, turn);
      const recovered = await this.executeConversationRun(prepared);
      return projectTurnResume(store, cwd, thread, turn, store.getRun(recovered), "recovered");
    }
    if (!key?.trim() || key.length > 200 || /[\r\n]/u.test(key)) {
      throw rpcError(-32602, "invalid_params", "An idempotency key of up to 200 characters is required to continue a stopped Turn.");
    }
    const idempotencyKey = "app-server-resume:" + createHash("sha256").update(JSON.stringify([turn.id, key])).digest("hex");
    const instruction = readOptionalStringField(record, "instruction")?.trim() || "Resume this Ling thread from durable evidence.";
    if (instruction.length > 16_384) throw rpcError(-32602, "invalid_params", "Resume instructions must be at most 16384 characters.");
    const receipt = readConversationSubmission(store, { surface: "normal", threadId: thread.id, idempotencyKey });
    if (receipt.status === "accepted") {
      const successor = receipt.turnId ? store.getLingTurn(receipt.turnId) : undefined;
      if (successor?.sourceTurnId !== turn.id || successor.userInstruction !== instruction) {
        throw rpcError(-32031, "idempotency_conflict", "The recovery key was reused with different input.");
      }
      const priorRunId = successor.activeRunId ?? successor.lastRunId;
      const priorRun = priorRunId ? store.getRun(priorRunId) : undefined;
      if (priorRun) return projectTurnResume(store, cwd, thread, successor, priorRun, "continued", turn.id);
      const prepared = successor.sourceItemId && readNormalConversationPreparedRequest(store, successor.sourceItemId);
      if (!prepared || prepared.parentRunId !== run.id || latestTurnId !== successor.id || thread.activeRunId) {
        throw rpcError(-32061, "resume_blocked", "The recovery has no current prepared request.");
      }
      this.publishConversationTurnStarted(store, cwd, successor);
      const recovered = await this.executeConversationRun(prepared);
      return projectTurnResume(store, cwd, thread, successor, store.getRun(recovered), "continued", turn.id);
    }
    if (latestTurnId !== turn.id) {
      throw rpcError(-32030, "stale_revision", "The Thread has accepted a newer Turn.");
    }
    const unit = run.workUnitId && store.getWorkUnit(run.workUnitId);
    if (!unit || unit.linkedRunId !== run.id
      || !continuationSourceReady(store, unit, this.context.activeRuns, "app-server-resume", () => undefined)) {
      throw rpcError(-32061, "resume_blocked", "The source Run has unsettled execution or effects.");
    }
    const resume = buildLingThreadResumeContext({
      store, thread, body: { turnId, sourceRunId: run.id, instruction, idempotencyKey }, mode: "execute",
    });
    const successor = resume.runRequest.turnId && store.getLingTurn(resume.runRequest.turnId);
    if (!successor) throw rpcError(-32061, "resume_blocked", "The recovery has no accepted successor Turn.");
    this.publishConversationTurnStarted(store, cwd, successor);
    const recovered = await this.executeConversationRun(resume.runRequest);
    return projectTurnResume(store, cwd, thread, successor, store.getRun(recovered), "continued", turn.id);
  }

  private async startTurn(params: unknown): Promise<unknown> {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const threadId = readStringField(record, "threadId");
    const store = this.context.storeRegistry.getStore(cwd);
    const thread = store.getLingThread(threadId);
    if (!thread) throw rpcError(-32040, "workspace_binding_invalid", `Thread was not found: ${threadId}`);
    const instruction = readOptionalStringField(record, "userInstruction") ?? readOptionalStringField(record, "message");
    const shouldRun = record.execute === true || record.task !== undefined || record.providerPresetId !== undefined
      || record.provider !== undefined || record.executionBinding !== undefined;
    if (shouldRun) {
      this.workspaceParams(params, true);
      return await this.startConversationTurn(record, thread, cwd, instruction);
    }
    if (!instruction?.trim()) throw rpcError(-32602, "invalid_params", "userInstruction or message is required.");
    const turnId = readOptionalStringField(record, "turnId");
    const kind = readLingTurnKind(readOptionalStringField(record, "kind") ?? "initial_request");
    const prior = turnId ? store.getLingTurn(turnId) : undefined;
    if (prior) {
      if (prior.threadId !== threadId || prior.kind !== kind || prior.userInstruction !== instruction) {
        throw rpcError(-32031, "idempotency_conflict", "The Turn ID belongs to a different request.");
      }
      return { cwd, thread: projectPublicLingThread(thread), turn: projectPublicLingTurn(prior, thread), replayed: true };
    }
    assertWorkItemConversationAdmission(store, threadId, undefined);
    const turn = store.createLingTurn({
      id: turnId,
      threadId,
      kind,
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
    return { cwd, thread: projectPublicLingThread(thread), turn: projectPublicLingTurn(turn, thread) };
  }

  private async startConversationTurn(record: Record<string, unknown>, thread: import("@ling-stack/core").LingThread, cwd: string,
    instruction: string | undefined) {
    if (thread.kind !== "conversation" || thread.channelId || thread.archivedAt || thread.status === "archived") {
      throw rpcError(-32040, "workspace_binding_invalid", "This Thread cannot accept a normal conversation Turn.");
    }
    if (record.provider !== undefined || record.task !== undefined) {
      throw rpcError(-32602, "invalid_params", "Select a configured execution binding or provider preset.");
    }
    const idempotencyKey = readOptionalStringField(record, "idempotencyKey") ?? readOptionalStringField(record, "turnId");
    if (!idempotencyKey?.trim() || idempotencyKey.length > 200 || /[\r\n]/u.test(idempotencyKey)) {
      throw rpcError(-32602, "invalid_params", "An idempotency key of up to 200 characters is required.");
    }
    let input: ReturnType<typeof parseConversationStreamRequest>;
    try {
      input = parseConversationStreamRequest({ ...record, message: instruction ?? "", threadId: thread.id, idempotencyKey });
    } catch (error) {
      throw rpcError(-32602, "invalid_params", error instanceof Error ? error.message : "Invalid conversation input.");
    }
    if (input.projectPath && this.workspaceParams({ cwd: input.projectPath }).cwd !== cwd) {
      throw rpcError(-32040, "workspace_binding_invalid", "The project directory differs from the connection workspace.");
    }
    const store = this.context.storeRegistry.getStore(cwd);
    const prepared = await prepareConversationSubmission({
      store, workspaceCwd: cwd, runnerRegistry: this.context.runnerRegistry,
      input, now: new Date().toISOString(), resolveThread: () => thread,
      title: readOptionalStringField(record, "title"),
      turnKind: record.kind === undefined ? undefined : readLingTurnKind(readStringField(record, "kind")),
      imageVisionSummarizer: this.context.imageVisionSummarizer,
    });
    const { turn, runRequest, replayed } = prepared;
    if (input.providerPresetId && input.providerPresetId !== runRequest.providerPresetId
      || input.executionBinding && JSON.stringify(input.executionBinding) !== JSON.stringify(runRequest.executionBinding)) {
      throw rpcError(-32031, "idempotency_conflict", "The original submission used a different execution configuration.");
    }
    if (!this.grantIsCurrent()) throw rpcError(-32020, "authorization_required", "The App Server grant expired or was revoked before dispatch.");
    this.publishConversationTurnStarted(store, cwd, turn);
    const receipt = readConversationSubmission(store, { surface: "normal", threadId: thread.id, idempotencyKey: input.idempotencyKey! });
    const runId = turn.activeRunId ?? turn.lastRunId ?? await this.executeConversationRun(runRequest);
    const currentThread = store.getLingThread(thread.id) ?? thread;
    return {
      cwd, thread: projectPublicLingThread(currentThread), turn: projectPublicLingTurn(store.getLingTurn(turn.id) ?? turn, currentThread),
      run: projectPublicRunSession(store.getRun(runId), store), receipt, replayed,
    };
  }

  private publishConversationTurnStarted(store: RunStore, cwd: string, turn: LingTurn): void {
    const idempotencyKey = `app-server-turn:${turn.id}`;
    if (store.getControlPlaneEventByIdempotency(turn.workspaceId, idempotencyKey)) return;
    appendControlPlaneEvent(store, this.context.controlPlaneEvents, {
      workspaceId: turn.workspaceId, cwd, domain: "runs", entityType: "turn", entityId: turn.id,
      action: "turn.started", idempotencyKey,
      data: { threadId: turn.threadId, turnId: turn.id, status: "queued" },
    });
  }

  private executeConversationRun(runRequest: RunRequest): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      void this.executeRun(runRequest, data => {
        if (data && typeof data === "object" && "runId" in data && typeof data.runId === "string") resolve(data.runId);
      }, (statusCode, body) => reject(new HttpError(statusCode,
        typeof body.error === "string" ? body.error : "turn_execution_blocked",
        typeof body.message === "string" ? body.message : "The accepted Turn could not start.")))
        .then(id => id ? resolve(id) : reject(rpcError(-32061, "resume_blocked", "The accepted Turn has no Run yet.")), reject);
    });
  }

  private respondApproval(params: unknown): unknown {
    const record = this.workspaceParams(params, true);
    const { cwd } = record;
    const approvalId = readStringField(record, "approvalId");
    const decision = readStringField(record, "decision");
    if (decision !== "approve" && decision !== "deny") {
      throw rpcError(-32602, "invalid_params", "decision must be approve or deny.");
    }
    if (record.decisionKind !== undefined && record.decisionKind !== "approve_once") {
      throw rpcError(-32602, "invalid_params", "App Server supports approve_once and deny decisions.");
    }
    const store = this.context.storeRegistry.getStore(cwd);
    expireStaleApproval(store, approvalId, this.context.controlPlaneEvents, cwd);
    const approval = store.getApprovalRequest(approvalId);
    const run = approval?.runId ? store.getRun(approval.runId) : undefined;
    if (!approval || !run || approval.workflowStepId || approval.mediaJobId || approval.externalWorkActionId || approval.nodeRerunIntentId) {
      throw rpcError(-32040, "workspace_binding_invalid", "The approval is not owned by a Run in this workspace.");
    }
    if (record.runId !== undefined && readStringField(record, "runId") !== run.id) {
      throw rpcError(-32040, "workspace_binding_invalid", "The approval does not belong to the supplied Run.");
    }
    const turn = store.getLingTurnForRun(run.id);
    if (record.threadId !== undefined && readStringField(record, "threadId") !== run.threadId
      || record.turnId !== undefined && readStringField(record, "turnId") !== turn?.id) {
      throw rpcError(-32040, "workspace_binding_invalid", "The approval does not belong to the supplied Thread or Turn.");
    }
    if (approval.status !== "pending") throw rpcError(-32051, "request_already_resolved", "The approval is no longer pending.");
    const now = new Date().toISOString();
    const input = {
      reason: readOptionalStringField(record, "reason"),
      resolvedBy: "local-user" as const,
      ...(decision === "approve" ? { decisionKind: "approve_once" as const } : {}),
    };
    const resolved = decision === "approve"
      ? store.approveApprovalRequest(approvalId, input, now)
      : store.denyApprovalRequest(approvalId, input, now);
    if (!resolved) throw rpcError(-32051, "request_already_resolved", "The approval is no longer pending.");
    let deferred = true;
    try {
      deferred = reconcileApprovalPostCommitEffects({
        store, approval: resolved, cwd, now, controlPlaneEvents: this.context.controlPlaneEvents,
        onOwnerResolved: () => {
          if (decision === "deny" && this.context.activeRuns.get(run.id)) return;
          const result = decision === "approve"
            ? this.context.approvalResumeCoordinator.resumeAfterApproval({ store, approval: resolved })
            : this.context.approvalResumeCoordinator.finalizeSuspendedApprovalDenial({ store, approval: resolved });
          if (result.status === "blocked" || (result.status === "not_applicable" && store.getRun(run.id)?.status === "waiting_for_approval")) {
            throw new Error("approval_run_owner_unreconciled");
          }
        },
      }).deferred;
    } catch {
      // The durable approval and its effect journal remain available for reconciliation.
    }
    return { cwd, approval: resolved, ...(deferred ? { postCommit: { status: "deferred" } } : {}) };
  }

  private respondInput(params: unknown): LingAppServerInputRespondResult {
    const { cwd, ...record } = this.workspaceParams(params, true);
    const command = parseUserInputAnswerCommandV1(record);
    if (!command.ok) throw rpcError(-32602, "invalid_params", "The answer command is invalid.");
    const store = this.context.storeRegistry.getStore(cwd);
    const receipt = submitAuthorizedUserInputAnswer(store, command.value, new Date().toISOString());
    publishUserInputAnswerAcceptance(store, this.context.controlPlaneEvents, command.value.authority.threadId, receipt);
    try {
      this.context.userInputDeliveryWorker.wake(store);
    } catch {
      // The delivery worker scans the durable outbox after an interrupted wake.
    }
    return { cwd, receipt };
  }

  private submitTurnIntervention(params: unknown, mode: "queue_followup" | "interrupt_redirect"): unknown {
    const { cwd, ...record } = this.workspaceParams(params);
    const threadId = readStringField(record, "threadId");
    const turnId = readStringField(record, "expectedTurnId");
    const expectedRevision = readStringField(record, "expectedTurnRevision");
    const instruction = (readOptionalStringField(record, "message") ?? readStringField(record, "userInstruction")).trim();
    const idempotencyKey = readStringField(record, "idempotencyKey");
    if (!instruction || instruction.length > 16_384 || !idempotencyKey.trim()
      || idempotencyKey.length > 200 || /[\r\n]/u.test(idempotencyKey)) {
      throw rpcError(-32602, "invalid_params", "Supply a message of up to 16384 characters and a non-blank idempotency key of up to 200 characters.");
    }
    const store = this.context.storeRegistry.getStore(cwd);
    const thread = store.getLingThread(threadId);
    const turn = store.getLingTurn(turnId);
    if (!thread || thread.kind !== "conversation" || thread.channelId || thread.archivedAt || thread.status === "archived" || turn?.threadId !== threadId) {
      throw rpcError(-32040, "workspace_binding_invalid", "The source Turn does not belong to an open conversation Thread.");
    }
    const runId = turn.activeRunId ?? turn.lastRunId;
    const run = runId ? store.getRun(runId) : undefined;
    const sourceRun = run?.parentRunId ? store.getRun(run.parentRunId) : run;
    if (!run || !sourceRun || sourceRun.threadId !== threadId || run.threadId !== threadId) {
      throw rpcError(-32061, "resume_blocked", "The source Turn has no Run available for follow-up.");
    }
    const retainedKey = `app-server:${turn.id}:${idempotencyKey}`;
    const prior = store.listRunInterventions({ sourceRunId: sourceRun.id, idempotencyKey: retainedKey, limit: 1 })[0];
    if (prior) {
      if (prior.mode !== mode || prior.instruction !== instruction) {
        throw rpcError(-32031, "idempotency_conflict", "The Turn input key was reused with a different message.");
      }
      return { cwd, threadId, turnId, intervention: prior, replayed: true };
    }
    if (turn.updatedAt !== expectedRevision || turn.activeRunId !== run.id || thread.activeRunId !== run.id
      || !["queued", "running", "waiting_for_approval"].includes(run.status) && !(mode === "interrupt_redirect" && run.status === "yielded")) {
      throw rpcError(-32030, "stale_revision", "The expected Turn is no longer the active revision.");
    }
    if (mode === "interrupt_redirect" && run.status !== "yielded") assertNoUnsafeRequiredPause(store, run);
    const now = new Date().toISOString();
    const created = recordUserRunIntervention(store, this.context.activeRuns, sourceRun, {
      instruction, mode, idempotencyKey: retainedKey,
    }, now);
    if (mode === "interrupt_redirect" && !created.replayed) {
      try {
        requestRunInterventionRedirect(store, this.context.activeRuns, run, created.intervention, now);
      } catch (error) {
        store.cancelRunIntervention(created.intervention.id, now, "source_cancellation_rejected");
        throw error;
      }
      this.context.taskSupervisor.poke(cwd);
    }
    return { cwd, threadId, turnId, ...created, intervention: store.getRunIntervention(created.intervention.id) ?? created.intervention };
  }

  private interruptTurn(params: unknown): unknown {
    const record = readParamsRecord(params);
    if (record.message !== undefined || record.userInstruction !== undefined) return this.submitTurnIntervention(record, "interrupt_redirect");
    const cwd = readRpcCwd(record, this.defaultCwd);
    const turnId = readOptionalStringField(record, "turnId") ?? readStringField(record, "expectedTurnId");
    const store = this.context.storeRegistry.getStore(cwd);
    const turn = store.getLingTurn(turnId);
    if (!turn) throw rpcError(-32040, "workspace_binding_invalid", `Turn was not found: ${turnId}`);
    if (record.threadId !== undefined && record.threadId !== turn.threadId) {
      throw rpcError(-32040, "workspace_binding_invalid", "The Turn does not belong to the supplied Thread.");
    }
    if (record.expectedTurnId !== undefined && record.expectedTurnId !== turn.id
      || record.expectedTurnRevision !== undefined && record.expectedTurnRevision !== turn.updatedAt) {
      throw rpcError(-32030, "stale_revision", "The expected Turn revision is stale.");
    }
    if (!turn.activeRunId) {
      const thread = store.getLingThread(turn.threadId);
      return { cwd, turn: projectPublicLingTurn(turn, thread) };
    }
    return this.cancelRun({ cwd, runId: turn.activeRunId });
  }

  private readWorkItem(params: unknown): LingAppServerWorkItemReadResult {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const workItemId = readStringField(record, "workItemId");
    const store = this.context.storeRegistry.getStore(cwd);
    const scope = this.replayIdentity(cwd, store).scope("workItem", workItemId);
    return store.readSnapshot(() => {
      const workItem = store.getWorkItem(workItemId);
      if (!workItem) {
        throw rpcError(-32040, "workspace_binding_invalid", `Work Item was not found: ${workItemId}`);
      }
      return { cwd, workItem: projectWorkItemSnapshot(workItem, this.grant?.subject.kind !== "workItem"),
        cursor: scope.issue(store.getLatestControlPlaneEventSeq(DEFAULT_WORKSPACE_ID)) };
    });
  }

  private controlWorkItem(action: "pause" | "resume" | "cancel", params: unknown): LingAppServerWorkItemControlResult {
    const record = readParamsRecord(params);
    const cwd = readRpcCwd(record, this.defaultCwd);
    const workItemId = readStringField(record, "workItemId");
    const actorId = this.grant ? `app-server-grant:${this.grant.grantId}` : readStringField(record, "actorId");
    const idempotencyKey = readStringField(record, "idempotencyKey");
    const expectedRevision = readIntegerField(record, "expectedWorkItemRevision", "expectedRevision");
    const expectedControlGeneration = readIntegerField(record, "expectedControlGeneration", "controlGeneration");
    const store = this.context.storeRegistry.getStore(cwd);
    const replayScope = this.replayIdentity(cwd, store).scope("workItem", workItemId);
    const reason = readOptionalStringField(record, "reason");
    const result = store.applyWorkItemControl(workItemId, action, {
      expectedRevision, expectedControlGeneration, actorId, reason, idempotencyKey,
    }, new Date().toISOString(), cwd);
    switch (result.status) {
      case "not_found":
        throw rpcError(-32040, "workspace_binding_invalid", `Work Item was not found: ${workItemId}`);
      case "idempotency_conflict":
        throw rpcError(-32031, "idempotency_conflict", "The idempotency key was already used for a different Work Item control request.");
      case "stale_revision":
        throw rpcError(-32030, "stale_revision", "The Work Item revision or control generation is stale.");
      case "blocked":
        throw rpcError(-32061, "resume_blocked", `Work Item cannot accept ${action} while control state is ${result.workItem.control.state}.`);
      case "applied":
      case "replayed": {
        const workItem = projectWorkItemSnapshot(result.workItem, this.grant?.subject.kind !== "workItem");
        if (result.event) {
          this.context.controlPlaneEvents.publish(trimOversizedEvent(result.event));
          this.send({ jsonrpc: "2.0", method: "workItem/control/updated", params: {
            cwd, workItemId, workItem, eventId: replayScope.eventId(result.event.workspaceId, result.event.seq),
            cursor: replayScope.issue(result.event.seq),
          } });
        }
        return { cwd, workItem, controlReceipt: projectWorkItemControlReceipt(result.receipt), replayed: result.status === "replayed" };
      }
    }
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

  private readThreadEvents(store: RunStore, threadId: string,
    record: Record<string, unknown> & { readonly cwd: string }): LingAppServerThreadEventsResult {
    const { cwd } = record;
    const scope = this.replayIdentity(cwd, store).scope("thread", threadId);
    const afterSeq = scope.read(record.cursor ?? record.afterSeq);
    const limit = readRpcLimit(record.limit ?? 25);
    const domains = ["runs", "approvals", "work_items", "work_units"] as const;
    return store.readSnapshot(() => {
      const workspaceId = DEFAULT_WORKSPACE_ID;
      if (afterSeq === undefined) return { cwd, workspaceId, events: [], window: unavailableAppServerReplayWindow(store) };
      const { latestSeq, replayFloorSeq } = store.getControlPlaneReplayState(workspaceId);
      const base = { requestedAfterSeq: afterSeq, upperBoundSeq: latestSeq, replayFloorSeq };
      if (afterSeq > latestSeq || afterSeq < replayFloorSeq) {
        return { cwd, workspaceId, events: [], window: { ...base, disposition: "snapshot_required", nextAfterSeq: latestSeq,
          reason: afterSeq > latestSeq ? "cursor_unavailable" : "retention_gap" } };
      }
      const rows = store.listControlPlaneEvents({ workspaceId, afterSeq, limit, domains });
      const events: ControlPlaneEvent[] = [];
      let nextAfterSeq = afterSeq;
      // Leave room in the RPC response for the page envelope and cursor.
      let remaining = 120 * 1024;
      for (const event of rows) {
        if (threadEventMatches(event, threadId, store)) {
          const projected = trimOversizedEvent(event);
          const bytes = Buffer.byteLength(JSON.stringify(projected)) + 1;
          if (bytes > remaining) break;
          remaining -= bytes;
          events.push(projected);
        }
        nextAfterSeq = event.seq;
      }
      if (rows.length < limit && (rows.length === 0 || rows.at(-1)!.seq === nextAfterSeq)) nextAfterSeq = latestSeq;
      return { cwd, workspaceId, events, cursor: scope.issue(nextAfterSeq), window: { ...base, disposition: "complete", nextAfterSeq } };
    });
  }

  private prepareControlPlaneSubscription(params: unknown,
    filter?: Pick<RpcSubscription, "entityType" | "entityId" | "filterEvent" | "replayReadyMethod" | "replayScope" | "threadId">): {
    readonly result: ControlPlaneSubscribeResult;
    readonly activate?: () => void;
  } {
    if (this.appServer && this.subscriptions.size >= APP_SERVER_MAX_SUBSCRIPTIONS) {
      throw rpcError(-32001, "server_overloaded", "The connection has too many subscriptions.");
    }
    const record = readParamsRecord(params);
    const scope = filter?.replayScope;
    const afterSeq = scope?.read(record.cursor ?? record.afterSeq);
    if (scope && afterSeq === undefined) {
      const store = this.context.storeRegistry.getStore(readRpcCwd(record, this.defaultCwd));
      return { result: { disposition: "snapshot_required", window: unavailableAppServerReplayWindow(store) } };
    }
    const parsed = this.readControlPlaneEventParams({
      ...record,
      ...(afterSeq === undefined ? {} : { afterSeq }),
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
    const envelopeBytes = controlPlaneEnvelopeBytes(subscriptionId, scope?.issue(Number.MAX_SAFE_INTEGER));
    // Register before replay can synchronously publish provisional events or close us.
    this.subscriptions.set(subscriptionId, subscription);
    try {
      hubSubscription = this.context.controlPlaneEvents.subscribeListener({
        workspaceId: DEFAULT_WORKSPACE_ID,
        cwd: parsed.cwd,
        domains: parsed.domains,
        onEvent: (event) => this.enqueueControlPlaneEvent(subscription, event),
        ...(this.appServer && subscription.replayReadyMethod === "thread/replay/ready" ? {
          onRunTextDelta: (delta) => {
            if (subscription.threadId && delta.subject.threadId !== subscription.threadId) return;
            this.outbound.send({ jsonrpc: "2.0", method: "item/delta", params: { ...delta, subscriptionId } }, subscriptionId);
          },
        } : {}),
        onPendingChange: (bytes, count) => this.outbound.reserve(subscription.upstreamKey,
          bytes + count * envelopeBytes, count),
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
      const cursor = scope?.issue(replay.window.nextAfterSeq) ?? String(replay.window.nextAfterSeq);
      return {
        result: {
          disposition: "complete",
          subscriptionId,
          cursor,
          window: replay.window,
        },
        activate: () => {
          hubSubscription?.activate(filteredReplay);
          if (this.appServer && !subscription.closed && subscription.replayReadyMethod) {
            this.flushControlPlaneSubscription(subscription);
            this.send({ jsonrpc: "2.0", method: subscription.replayReadyMethod,
              params: { subscriptionId, cursor, window: replay.window } });
          }
        },
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
    void this.executeRun(runRequest);
    return { accepted: true };
  }

  private executeRun(runRequest: RunRequest, onReady?: (data: unknown) => void,
    onError?: (statusCode: number, body: Record<string, unknown>) => void): Promise<string | undefined> {
    let runCloseListener: (() => void) | undefined;
    const sink = createRpcRunExecutionSink({
      onReady: (data) => { onReady?.(data); this.sendRunNotification({ kind: "ready", data }); },
      onEvent: (event, data) => this.sendRunNotification({ kind: "event", event, data }),
      onError: (statusCode, body) => { onError?.(statusCode, readParamsRecord(body)); this.sendRunNotification({ kind: "error", statusCode, body }); },
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
    return executeRunRequest(
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
        hostCapabilityBridge: this.context.hostCapabilityBridge,
        enableUserInputPause: this.appServer && runRequest.normalConversationPreparedRequestRef !== undefined,
        nativeRunDispatcher: this.context.nativeRunDispatcher,
      },
    );
  }

  private cancelRun(params: unknown): unknown {
    const record = readParamsRecord(params);
    const runId = readStringField(record, "runId");
    const cwd = readOptionalStringField(record, "cwd");
    const store = this.appServer ? this.context.storeRegistry.getStore(this.workspaceParams(record).cwd)
      : this.context.storeRegistry.findStoreForRun(runId, cwd);
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
        controlPlaneEvents: this.context.controlPlaneEvents,
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
    const cursor = subscription.replayScope?.issue(event.seq);
    const frame = this.outbound.prepare(controlPlaneNotification(subscription.id, event, cursor));
    if (!frame) return;
    if (this.appServer) {
      const serverRequest = appServerServerRequestForEvent(event, () => this.context.storeRegistry.getStore(subscription.cwd));
      if (serverRequest) this.send(serverRequest);
      const notification = appServerEventNotification(subscription, event, cursor);
      if (notification) this.send(notification);
    }
    subscription.queue.push({ event, frame });
    if (subscription.queue.length >= CONTROL_PLANE_SSE_QUEUE_WARNING_THRESHOLD) {
      const coalesced = coalesceAndSortControlPlaneEvents(subscription.queue.map(pending => pending.event));
      subscription.queue.length = 0;
      for (const merged of coalesced) {
        const mergedFrame = this.outbound.prepare(controlPlaneNotification(subscription.id, merged, subscription.replayScope?.issue(merged.seq)));
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
    this.externalAgentUnsubscribe?.();
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

function latestConversationTurn(store: RunStore, threadId: string): LingTurn | undefined {
  return store.listLingTurns({ threadId, orderBy: "createdAt", limit: 1 })[0];
}

function projectTurnResume(
  store: RunStore, cwd: string, thread: LingThread, turn: LingTurn, run: RunSession | undefined,
  disposition: LingAppServerTurnResumeResult["disposition"], resumedFromTurnId?: string,
): LingAppServerTurnResumeResult {
  const currentThread = store.getLingThread(thread.id) ?? thread;
  return {
    cwd,
    thread: projectPublicLingThread(currentThread),
    turn: projectPublicLingTurn(store.getLingTurn(turn.id) ?? turn, currentThread),
    run: projectPublicRunSession(run, store) ?? null,
    runLinks: store.listLingTurnRuns(turn.id),
    disposition,
    ...(resumedFromTurnId ? { resumedFromTurnId } : {}),
  };
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

function projectWorkItemSnapshot(workItem: WorkItem, includeExecutionRefs = true) {
  const currentExecutionRefs = includeExecutionRefs ? [
    workItem.taskId,
    workItem.runId,
    workItem.workflowId,
    workItem.workflowStepId,
    workItem.approvalId,
  ].filter((value): value is string => typeof value === "string" && value.length > 0) : [];
  return {
    workspaceId: workItem.workspaceId,
    workItemId: workItem.id,
    revision: String(workItem.revision),
    status: workItem.status,
    ...(workItem.planRevision ? { planRevision: workItem.planRevision } : {}),
    control: {
      state: workItem.control.state,
      generation: String(workItem.control.generation),
      ...(workItem.control.receipt ? { receipt: projectWorkItemControlReceipt(workItem.control.receipt) } : {}),
      unresolvedEffectIds: workItem.control.unresolvedEffectIds,
      ...(workItem.control.recoveryOwner ? { recoveryOwner: workItem.control.recoveryOwner } : {}),
    },
    holds: workItem.holds,
    currentExecutionRefs,
  };
}

function projectWorkItemControlReceipt(receipt: WorkItemControlReceipt): LingAppServerWorkItemControlResult["controlReceipt"] {
  const { id, action, generation, requestedAt, actorId, reason, outcome } = receipt;
  return { id, action, generation: String(generation), requestedAt, actorId, ...(reason ? { reason } : {}), outcome };
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

function readOptionalWorkItemConversationDispatch(value: unknown): LingAppServerWorkItemConversationDispatch | undefined {
  if (value === undefined) return undefined;
  const record = readParamsRecord(value);
  const threadId = readStringField(record, "threadId");
  const message = readStringField(record, "message");
  if (!message.trim() || message.length > 16_384) throw rpcError(-32602, "invalid_params", "dispatch.message must be 1–16384 characters.");
  const providerPresetId = readOptionalStringField(record, "providerPresetId");
  return { threadId, message, ...(providerPresetId ? { providerPresetId } : {}) };
}

function rpcError(jsonRpcCode: number, code: string, message: string): Error & { readonly jsonRpcCode: number; readonly code: string } {
  return Object.assign(new Error(message), { jsonRpcCode, code });
}

function assertGoalRevision(goal: LingThreadGoal | undefined, expected: string | undefined): void {
  if (expected !== undefined && expected !== goal?.updatedAt) {
    throw rpcError(-32030, "stale_revision", "The Thread Goal revision has changed.");
  }
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
  if (error instanceof HttpError) {
    return { jsonRpcCode: error.statusCode === 400 ? -32602 : -32061, code: error.code, message: error.message };
  }
  if (error instanceof WorktreeActionError) {
    const jsonRpcCode = error.code === "stale_revision" ? -32030
      : error.code === "workspace_binding_invalid" || error.code === "worktree_not_found" ? -32040
      : error.code === "unknown_outcome" ? -32060 : -32041;
    return { jsonRpcCode, code: error.code, message: error.message };
  }
  if (error instanceof UserInputStoreError) {
    const message = "The answer could not be accepted for the current question.";
    switch (error.code) {
      case "not_found": return { jsonRpcCode: -32040, code: "workspace_binding_invalid", message };
      case "idempotency_conflict": return { jsonRpcCode: -32031, code: "idempotency_conflict", message };
      case "stale_request":
      case "source_conflict": return { jsonRpcCode: -32030, code: "stale_revision", message };
      case "request_not_pending":
      case "request_expired": return { jsonRpcCode: -32051, code: "request_already_resolved", message };
      default: return { jsonRpcCode: -32602, code: "invalid_params", message };
    }
  }
  if (error instanceof Error && error.message === "work_item_evidence_idempotency_conflict") {
    return { jsonRpcCode: -32031, code: "idempotency_conflict", message: "The evidence key was reused with different input." };
  }
  if (error instanceof Error && error.message === "thread_delete_preview_stale") {
    return { jsonRpcCode: -32030, code: "stale_revision", message: "The Thread changed after the deletion preview." };
  }
  if (error instanceof Error && error.message === "thread_work_item_dependency") {
    return { jsonRpcCode: -32061, code: "resume_blocked", message: "The Thread has a current Work Item dependency." };
  }
  if (error instanceof Error && /^(?:coordination_schedule_stale|coordination_round_stale)$/u.test(error.message)) {
    return { jsonRpcCode: -32030, code: "stale_revision", message: "The coordination definition or Work Item revision changed." };
  }
  if (error instanceof Error && /^goal_(acceptance|completion|supervision)_/u.test(error.message)) {
    return { jsonRpcCode: -32061, code: error.message, message: error.message };
  }
  return {
    jsonRpcCode: -32000,
    code: "internal_error",
    message: error instanceof Error ? error.message : String(error),
  };
}

function collaborationRpcError(error: unknown): unknown {
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
  return error;
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

function controlPlaneNotification(subscriptionId: string, event: ControlPlaneEvent, cursor?: string): unknown {
  return { jsonrpc: "2.0", method: "$/control_plane_event", params: { subscriptionId, event, cursor } };
}

function appServerEventNotification(subscription: RpcSubscription, event: ControlPlaneEvent, cursor: string | undefined): unknown | undefined {
  const method = appServerEventMethod(event);
  if (!method) return undefined;
  const workItemId = event.entityType === "work_item" ? event.entityId
    : typeof event.data.workItemId === "string" && event.entityType === "verify_operation" ? event.data.workItemId : undefined;
  return {
    jsonrpc: "2.0",
    method,
    params: {
      subscriptionId: subscription.id,
      cursor: cursor ?? String(event.seq),
      eventId: subscription.replayScope?.eventId(event.workspaceId, event.seq) ?? `${event.workspaceId}:${event.seq}`,
      workspaceId: event.workspaceId,
      subject: event.entityType === "thread"
        ? { kind: "thread", threadId: event.entityId }
        : workItemId
          ? { kind: "workItem", workItemId, ...(typeof event.data.threadId === "string" ? { threadId: event.data.threadId } : {}) }
          : { kind: "thread", threadId: event.data.threadId as string | undefined,
              ...(typeof event.data.turnId === "string" ? { turnId: event.data.turnId } : {}) },
      revision: String(event.data.revision ?? event.data.statusRevision ?? event.ts),
      ...(typeof event.data.itemId === "string" ? { itemId: event.data.itemId } : {}),
      ...(typeof event.data.runId === "string" ? { runId: event.data.runId } : {}),
      ...(typeof event.data.turnId === "string" ? { turnId: event.data.turnId } : {}),
      event,
      payload: event.data,
    },
  };
}

function appServerServerRequestForEvent(event: ControlPlaneEvent, readStore: () => RunStore): unknown | undefined {
  if (event.action === "approval.created") {
    return {
      jsonrpc: "2.0",
      id: `approval:${event.entityId}:${event.seq}`,
      method: "approval/requestDecision",
      params: { approvalId: event.entityId, ...event.data },
    };
  }
  if (event.entityType !== "user_input_request" || event.action !== "pending") return undefined;
  const { threadId, itemId, statusRevision } = event.data;
  if (typeof threadId !== "string" || typeof itemId !== "string") return undefined;
  const [request] = readStore().readUserInputTranscript({ threadId, itemIds: [itemId] });
  if (request?.availability !== "available" || request.kind !== "user_input_request" || request.status !== "pending"
    || request.statusRevision !== statusRevision || request.requestId !== event.entityId || !request.answerAuthority) return undefined;
  const { answerAuthority: _authority, ...preview } = request;
  return {
    jsonrpc: "2.0",
    id: `input:${event.entityId}:${event.seq}`,
    method: "input/requestAnswer",
    params: { ...event.data, pendingId: event.entityId, request: preview },
  };
}

function appServerEventMethod(event: ControlPlaneEvent): string | undefined {
  if (event.entityType === "verify_operation") return "verification/updated";
  if (event.entityType === "handoff" && event.action === "handoff.created") return "handoff/created";
  if (event.entityType === "conversation_item" && event.action === "conversation_narration.published") return "item/completed";
  if (event.action === "thread.goal.updated") return "thread/goal/updated";
  if (event.entityType === "run" && typeof event.data.turnId === "string") {
    if (event.action === "run.created") return typeof event.data.interventionId === "string" ? "turn/started" : "turn/status/changed";
    if (event.action === "run.completed" || event.action === "run.cancelled") return "turn/completed";
  }
  if (event.entityType === "thread") {
    if (event.action === "thread.started") return "thread/started";
    if (event.action === "thread.archived") return "thread/archived";
    if (event.action === "thread.removed") return "thread/removed";
    if (event.action.startsWith("thread.")) return "thread/updated";
  }
  if (event.entityType === "turn") {
    if (event.action === "turn.started") return "turn/started";
    if (event.action === "turn.completed") return "turn/completed";
    if (event.action.startsWith("turn.project_instructions.")) return "turn/projectInstructions/updated";
    if (event.action.includes("plan")) return "turn/plan/updated";
    if (event.action.includes("diff")) return "turn/diff/updated";
    if (event.action.startsWith("turn.")) return "turn/status/changed";
  }
  if (event.entityType === "work_item") {
    if (event.action === "work_item.created") return "workItem/created";
    if (event.action === "work_item.thread.linked") return "workItem/thread/linked";
    if (event.action.includes("evidence")) return "workItem/evidence/updated";
    if (event.action.includes("control")) return "workItem/control/updated";
    if (event.action.includes("collaboration")) return "workItem/collaboration/updated";
    if (event.action.includes("delivery")) return "workItem/delivery/updated";
    if (event.action.includes("feedback")) return "workItem/feedback/received";
    if (event.action.includes("handoff")) return "workItem/handoff/updated";
    return "workItem/status/changed";
  }
  if (event.entityType === "user_input_request") return event.action === "pending" ? undefined : "serverRequest/resolved";
  if (event.entityType === "user_input" || (event.entityType === "approval" && event.action !== "approval.created")) {
    return "serverRequest/resolved";
  }
  return undefined;
}

function subscriptionMatchesEvent(subscription: RpcSubscription, event: ControlPlaneEvent): boolean {
  if (subscription.entityType && event.entityType !== subscription.entityType) return false;
  if (subscription.entityId && event.entityId !== subscription.entityId) return false;
  return subscription.filterEvent?.(event) ?? true;
}

function threadEventMatches(event: ControlPlaneEvent, threadId: string, store: import("@ling-stack/core").RunStore): boolean {
  if (event.entityType === "thread") return event.entityId === threadId;
  if (typeof event.data.threadId === "string") return event.data.threadId === threadId;
  const runId = event.entityType === "run" ? event.entityId
    : event.data.ownerType === "run" ? event.data.ownerId : event.data.runId;
  return typeof runId === "string" && store.getRun(runId)?.threadId === threadId;
}

function controlPlaneEnvelopeBytes(subscriptionId: string, cursor?: string): number {
  return Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", method: "$/control_plane_event", params: { subscriptionId, cursor } }), "utf8") + 16;
}

function readRunWorkspaceCwd(run: RunSession): string | undefined {
  const snapshot = run.requestSnapshot;
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    return undefined;
  }
  const workspaceCwd = (snapshot as { readonly workspaceCwd?: unknown }).workspaceCwd;
  return typeof workspaceCwd === "string" && workspaceCwd.trim() ? workspaceCwd : undefined;
}
