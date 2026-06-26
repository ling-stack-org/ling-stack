import {
  buildChannelTeamRiskReviewDecision,
  buildRuntimePermissionGrant,
  evaluateRuntimePermissionRequest,
  runtimePermissionToolDelta,
  summarizeRuntimePermissionScope,
  type ApprovalPolicy,
  type ApprovalRequest,
  type ApprovalRisk,
  type CreateApprovalRequestInput,
  type RunEventEnvelope,
  type RunEventType,
  type RunSession,
  type RunStore,
  type RunTool,
  type RuntimePermissionContinuationPlan,
  type RuntimePermissionRequestPayload,
  type RuntimePermissionScope,
  type RuntimePermissionScopeSnapshot,
} from "@ling-stack/core";
import type { PiRunnerPermissionRequest, PiRunnerRunOptions } from "@ling-stack/runner-pi";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import {
  appendApprovalCreatedControlPlaneEvent,
  appendApprovalExpiredControlPlaneEvent,
  appendApprovalResolvedControlPlaneEvent,
  streamOrAppendApprovalDecisionEvent,
  waitForApprovalDecision,
} from "./approvals.js";
import {
  applyRiskReviewToApprovalInput,
} from "./risk-review-approval-adapter.js";

const PERMISSION_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

export function createRunPermissionRequestHandler(options: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly approvalPolicy: ApprovalPolicy;
  readonly appendAndMaybeStream: (type: RunEventType, data: unknown) => RunEventEnvelope | undefined;
  readonly streamEnvelope: (envelope: RunEventEnvelope) => void;
  readonly signal?: AbortSignal;
  readonly extraSecrets?: readonly (string | undefined)[];
  readonly controlPlaneEvents?: ControlPlaneEventHub;
  readonly workspaceCwd?: string;
  readonly currentTools: readonly RunTool[];
  readonly runnerId: string;
  readonly supportedTools?: readonly string[];
  readonly runnerCapabilities?: readonly string[];
  readonly mcpToolRefs?: readonly string[];
}): PiRunnerRunOptions["onPermissionRequired"] {
  return async (request: PiRunnerPermissionRequest) => {
    const currentScope = createCurrentScopeSnapshot({
      tools: options.currentTools,
      allowedWritePaths: options.approvalPolicy.allowedWritePaths,
      mcpToolRefs: options.mcpToolRefs ?? [],
      runnerId: options.runnerId,
      runnerCapabilities: options.runnerCapabilities,
    });
    const payload = createPermissionRequestPayload(options.run, request, currentScope);
    const evaluation = evaluateRuntimePermissionRequest({
      payload,
      cwd: request.cwd,
      approvalPolicy: options.approvalPolicy,
      supportedTools: options.supportedTools,
      runnerCapabilities: options.runnerCapabilities,
      mcpToolRefs: options.mcpToolRefs,
    });
    const riskReview = buildChannelTeamRiskReviewDecision({
      actionType: "runtime_permission_request",
      risk: evaluation.decision === "deny" ? "high" : classifyRuntimePermissionRisk(payload),
      payload,
    });
    const approvalInput = applyRiskReviewToApprovalInput(
      toCreateApprovalRequestInput(options.run, request, payload, evaluation.decision === "deny" ? "high" : undefined),
      riskReview,
    );

    if (evaluation.decision === "deny") {
      const denied = createAutoDeniedPermissionApproval({
        ...options,
        approvalInput,
        reason: evaluation.reason,
      });
      return {
        approved: false,
        approvalId: denied.id,
        reason: denied.decisionReason ?? evaluation.reason,
      };
    }

    const createdAt = new Date().toISOString();
    const approval = options.store.createApprovalRequest({
      ...approvalInput,
      extraSecrets: options.extraSecrets,
    }, createdAt);
    appendApprovalCreatedControlPlaneEvent(
      options.store,
      options.controlPlaneEvents,
      options.workspaceCwd ?? options.run.cwd,
      approval,
      createdAt,
    );
    const waitingAt = new Date().toISOString();
    options.store.transitionRunStatus({
      runId: options.run.id,
      expectedStatus: "running",
      event: "approval_requested",
      actor: "system",
      now: waitingAt,
    });
    const requestEvent = options.appendAndMaybeStream("approval_requested", approvalRequestEventPayload(approval));

    const resolvedApproval = await waitForApprovalDecision(options.store, approval.id, options.signal);
    const resolvedAt = new Date().toISOString();
    if (resolvedApproval.status === "expired") {
      appendApprovalExpiredControlPlaneEvent(
        options.store,
        options.controlPlaneEvents,
        options.workspaceCwd ?? options.run.cwd,
        resolvedApproval,
        "pending",
        resolvedAt,
      );
    } else {
      appendApprovalResolvedControlPlaneEvent(
        options.store,
        options.controlPlaneEvents,
        options.workspaceCwd ?? options.run.cwd,
        resolvedApproval,
        "pending",
        resolvedApproval.status === "approved" ? "approved" : "denied",
        resolvedAt,
      );
    }
    transitionPermissionRequestRunBackToRunning(options.store, options.run.id, resolvedApproval, resolvedAt);
    streamOrAppendApprovalDecisionEvent({
      store: options.store,
      approval: resolvedApproval,
      afterSeq: requestEvent?.seq ?? 0,
      appendAndMaybeStream: options.appendAndMaybeStream,
      streamEnvelope: options.streamEnvelope,
    });

    if (resolvedApproval.status !== "approved") {
      return {
        approved: false,
        approvalId: resolvedApproval.id,
        reason:
          resolvedApproval.decisionReason ??
          `Ling Stack runtime permission request ${resolvedApproval.status}.`,
      };
    }

    const grant = buildRuntimePermissionGrant(resolvedApproval, resolvedAt, "continuation");
    return {
      approved: true,
      approvalId: resolvedApproval.id,
      reason:
        resolvedApproval.decisionReason ??
        "Ling Stack approved the runtime permission request. The grant is recorded for a continuation; the active tool registry was not changed.",
      ...(grant ? { grant } : {}),
    };
  };
}

function createCurrentScopeSnapshot(input: {
  readonly tools: readonly RunTool[];
  readonly allowedWritePaths: readonly string[];
  readonly mcpToolRefs: readonly string[];
  readonly runnerId: string;
  readonly runnerCapabilities?: readonly string[];
}): RuntimePermissionScopeSnapshot {
  return {
    tools: [...new Set(input.tools)],
    allowedWritePaths: input.allowedWritePaths,
    mcpToolRefs: input.mcpToolRefs,
    runnerId: input.runnerId,
    runnerCapabilities: input.runnerCapabilities,
  };
}

function createPermissionRequestPayload(
  run: RunSession,
  request: PiRunnerPermissionRequest,
  currentScope: RuntimePermissionScopeSnapshot,
): RuntimePermissionRequestPayload {
  const requestedScope = request.requestedScope as RuntimePermissionScope;
  return {
    type: "runtime_permission_request",
    requestKind: request.requestKind,
    requestedByRunId: run.id,
    requestedByToolCallId: request.toolCallId,
    reason: request.reason,
    requestedScope,
    currentScope,
    proposedContinuation: createContinuationPlan(requestedScope, currentScope),
  };
}

function createContinuationPlan(
  requestedScope: RuntimePermissionScope,
  currentScope: RuntimePermissionScopeSnapshot,
): RuntimePermissionContinuationPlan {
  if (requestedScope.kind === "core_tool") {
    const toolDelta = runtimePermissionToolDelta(currentScope, requestedScope.tools);
    return {
      mode: "queue_followup",
      toolDelta,
      reason: "Pi active sessions do not safely mutate the tool registry; queue a continuation with the approved tool scope.",
    };
  }
  if (requestedScope.kind === "write_scope") {
    return {
      mode: "queue_followup",
      writePathDelta: requestedScope.paths,
      reason: "Write-scope grants are applied to a continuation-scoped run snapshot, not workspace policy.",
    };
  }
  if (requestedScope.kind === "mcp_tool") {
    return {
      mode: "queue_followup",
      mcpToolDelta: [`${requestedScope.serverId}:${requestedScope.toolName}`],
      reason: "MCP tool grants are applied to a continuation-scoped run snapshot.",
    };
  }
  return {
    mode: "queue_followup",
    runnerCapabilityDelta: [requestedScope.capability],
    reason: "Runner capability grants are applied to a continuation-scoped run snapshot.",
  };
}

function toCreateApprovalRequestInput(
  run: RunSession,
  request: PiRunnerPermissionRequest,
  payload: RuntimePermissionRequestPayload,
  riskOverride?: ApprovalRisk,
): CreateApprovalRequestInput {
  const risk = riskOverride ?? classifyRuntimePermissionRisk(payload);
  return {
    runId: run.id,
    taskId: run.taskId,
    channelId: run.channelId,
    toolCallId: request.toolCallId,
    actionType: "runtime_permission_request",
    risk,
    title: approvalTitle(payload),
    description: approvalDescription(payload),
    payload,
    expiresAt: new Date(Date.now() + PERMISSION_REQUEST_TIMEOUT_MS).toISOString(),
  };
}

function createAutoDeniedPermissionApproval(options: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly approvalInput: CreateApprovalRequestInput;
  readonly reason: string;
  readonly extraSecrets?: readonly (string | undefined)[];
  readonly controlPlaneEvents?: ControlPlaneEventHub;
  readonly workspaceCwd?: string;
  readonly appendAndMaybeStream: (type: RunEventType, data: unknown) => RunEventEnvelope | undefined;
  readonly streamEnvelope: (envelope: RunEventEnvelope) => void;
}): ApprovalRequest {
  const createdAt = new Date().toISOString();
  const denied = options.store.createApprovalRequest({
    ...options.approvalInput,
    extraSecrets: options.extraSecrets,
  }, createdAt);
  appendApprovalCreatedControlPlaneEvent(
    options.store,
    options.controlPlaneEvents,
    options.workspaceCwd ?? options.run.cwd,
    denied,
    createdAt,
  );
  const resolved = options.store.denyApprovalRequest(
    denied.id,
    { reason: options.reason },
    new Date().toISOString(),
  );
  if (!resolved) {
    throw new Error(`Permission approval request not found after policy denial: ${denied.id}`);
  }
  appendApprovalResolvedControlPlaneEvent(
    options.store,
    options.controlPlaneEvents,
    options.workspaceCwd ?? options.run.cwd,
    resolved,
    "pending",
    "denied",
    resolved.resolvedAt ?? new Date().toISOString(),
  );
  const requestEvent = options.appendAndMaybeStream("approval_requested", approvalRequestEventPayload(resolved));
  streamOrAppendApprovalDecisionEvent({
    store: options.store,
    approval: resolved,
    afterSeq: requestEvent?.seq ?? 0,
    appendAndMaybeStream: options.appendAndMaybeStream,
    streamEnvelope: options.streamEnvelope,
  });
  return resolved;
}

function transitionPermissionRequestRunBackToRunning(
  store: RunStore,
  runId: string,
  approval: ApprovalRequest,
  now: string,
): void {
  const current = store.getRun(runId);
  if (!current || current.status !== "waiting_for_approval") {
    return;
  }
  store.transitionRunStatus({
    runId,
    expectedStatus: "waiting_for_approval",
    event: "approval_approved",
    actor: approval.status === "approved" ? "local-user" : "system",
    reason: `Runtime permission request ${approval.status}.`,
    now,
  });
}

function classifyRuntimePermissionRisk(payload: RuntimePermissionRequestPayload): ApprovalRisk {
  if (payload.requestedScope.kind === "runner_capability") {
    return "high";
  }
  if (payload.requestedScope.kind === "write_scope") {
    return "high";
  }
  if (payload.requestedScope.kind === "core_tool") {
    return payload.requestedScope.tools.some((tool) => tool === "bash" || tool === "edit" || tool === "write")
      ? "medium"
      : "low";
  }
  return payload.requestedScope.sideEffectLevel === "read" ? "low" : "medium";
}

function approvalTitle(payload: RuntimePermissionRequestPayload): string {
  return `Approve runtime permission: ${payload.requestKind}`;
}

function approvalDescription(payload: RuntimePermissionRequestPayload): string {
  return `The runner requested ${summarizeRuntimePermissionScope(payload.requestedScope)}.`;
}

function approvalRequestEventPayload(approval: ApprovalRequest): Record<string, unknown> {
  return {
    approvalId: approval.id,
    toolCallId: approval.toolCallId,
    actionType: approval.actionType,
    risk: approval.risk,
    title: approval.title,
    description: approval.description,
    payload: approval.payload,
    previewArtifactIds: [],
    expiresAt: approval.expiresAt,
  };
}
