import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  runInterventionModes,
  type GoalContinuationEvidenceDelta,
  type GoalContinuationStopReason,
  type LingThreadGoal,
  type RunEventType,
  type RunIntervention,
  type RunInterventionAttachmentPayload,
  type RunInterventionLinkPreviewPayload,
  type RunInterventionMaterializationStatus,
  type RunInterventionMessagePayload,
  type RunInterventionMode,
  type RunInterventionWorkspaceFilePayload,
  type RunSession,
  type RunStatus,
  type RunStore,
  type SecretResolver,
} from "@ling-stack/core";
import type { McpBroker } from "../../context.js";
import { RunControlService } from "../../run-control.js";
import type { ActiveRunRegistry } from "../../runtime/active-runs.js";
import type { RunnerRegistry } from "../../runtime/runners.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import type { RuntimeSupervisor } from "../../runtime/supervisor.js";
import type { StartupStateRegistry } from "../../startup/state.js";
import { readJsonBody, readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { isRecord, readOptionalString, readOptionalStringArray, readString } from "../../shared/validation.js";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import type { ComputerUseProjectionRegistry } from "../computer-use/registry.js";
import { createChannelReplyContinuationProjection } from "../channels/channel-reply-continuation.js";
import {
  createDetachedRunExecutionSink,
  executeRunRequest,
} from "./orchestrator.js";
import { buildRunInterventionContinuationRequest } from "./run-intervention-continuation-request.js";

const runControlService = new RunControlService();

export async function handleRunInterventions(
  request: IncomingMessage,
  response: ServerResponse,
  config: { readonly maxBodyBytes: number },
  url: URL,
  runnerRegistry: RunnerRegistry,
  storeRegistry: RunStoreRegistry,
  activeRuns: ActiveRunRegistry,
  runtimeSupervisor: RuntimeSupervisor,
  secretResolver: SecretResolver,
  mcpBroker: McpBroker,
  computerUsePreviews: ComputerUseProjectionRegistry,
  controlPlaneEvents: ControlPlaneEventHub,
  startupState: StartupStateRegistry | undefined,
  sourceRunId: string,
): Promise<void> {
  const store = storeRegistry.findStoreForRun(sourceRunId, url.searchParams.get("cwd") ?? undefined);
  const sourceRun = store?.getRun(sourceRunId);
  if (!store || !sourceRun) {
    writeJson(response, 404, {
      error: "run_not_found",
      message: "Run was not found in the active daemon stores. Pass ?cwd=/path/to/project after a daemon restart.",
    });
    return;
  }

  if (request.method === "GET") {
    writeJson(response, 200, {
      cwd: store.paths.cwd,
      interventions: store.listRunInterventions({ sourceRunId, limit: readOptionalIntegerQuery(url, "limit", 1) }),
    });
    return;
  }

  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for run interventions` });
    return;
  }

  let input: {
    readonly mode: RunInterventionMode;
    readonly instruction: string;
    readonly messagePayload?: RunInterventionMessagePayload;
    readonly idempotencyKey: string;
  };
  try {
    input = parseRunInterventionCreateRequest(await readJsonBody(request, config.maxBodyBytes));
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
    return;
  }

  if (input.mode === "interrupt_redirect" && isTerminalRunStatus(sourceRun.status)) {
    writeJson(response, 409, { error: "run_not_cancellable", message: `Run ${sourceRun.id} is already ${sourceRun.status}.`, run: sourceRun });
    return;
  }

  const now = new Date().toISOString();
  const sourceWorkUnit = sourceRun.workUnitId ? store.getWorkUnit(sourceRun.workUnitId) : undefined;
  const intervention = store.createRunIntervention(
    {
      sourceRunId,
      sourceWorkUnitId: sourceRun.workUnitId,
      sourceAttemptId: sourceWorkUnit?.activeAttemptId ?? (sourceRun.workUnitId ? store.listWorkUnitAttempts(sourceRun.workUnitId).at(-1)?.id : undefined),
      mode: input.mode,
      instruction: input.instruction,
      messagePayload: input.messagePayload,
      requestedBy: "local-user",
      idempotencyKey: input.idempotencyKey,
    },
    now,
  );
  streamRunEventIfPossible(store, activeRuns, sourceRunId, "run_intervention_created", {
    interventionId: intervention.id,
    mode: intervention.mode,
    status: intervention.status,
  });

  if (input.mode === "queue_followup") {
    streamRunEventIfPossible(store, activeRuns, sourceRunId, "run_followup_queued", {
      interventionId: intervention.id,
      instruction: intervention.instruction,
    });
    if (isTerminalRunStatus(sourceRun.status)) {
      await maybeStartNextRunInterventionContinuation({
        sourceRunId,
        store,
        runnerRegistry,
        storeRegistry,
        activeRuns,
        runtimeSupervisor,
        secretResolver,
        mcpBroker,
        computerUsePreviews,
        controlPlaneEvents,
        startupState,
      });
    }
    writeJson(response, 201, { cwd: store.paths.cwd, intervention: store.getRunIntervention(intervention.id) ?? intervention });
    return;
  }

  const updated = store.updateRunInterventionStatus({
    interventionId: intervention.id,
    status: "cancelling_source",
    now,
  }) ?? intervention;
  streamRunEventIfPossible(store, activeRuns, sourceRunId, "run_interrupt_requested", {
    interventionId: updated.id,
    instruction: updated.instruction,
  });

  const cancellation = runControlService.cancelRunForRedirect({
    store,
    run: sourceRun,
    activeRun: activeRuns.get(sourceRunId),
  });

  writeJson(response, 201, {
    cwd: store.paths.cwd,
    intervention: store.getRunIntervention(intervention.id) ?? updated,
    run: store.getRun(sourceRunId),
    event: cancellation.event,
  });
}

export function handleRunInterventionItem(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  route: { readonly kind: "detail" | "cancel"; readonly interventionId: string },
): void {
  const resolved = getCwdStoreOrWriteError(response, url, storeRegistry);
  if (!resolved) {
    return;
  }
  const intervention = resolved.store.getRunIntervention(route.interventionId);
  if (!intervention) {
    writeJson(response, 404, { error: "run_intervention_not_found", message: `Run intervention not found: ${route.interventionId}` });
    return;
  }
  if (route.kind === "detail") {
    if (request.method !== "GET") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for run intervention detail` });
      return;
    }
    writeJson(response, 200, { cwd: resolved.cwd, intervention });
    return;
  }
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for run intervention cancel` });
    return;
  }
  const cancelled = resolved.store.cancelRunIntervention(route.interventionId, new Date().toISOString(), "cancelled_by_user");
  writeJson(response, 200, { cwd: resolved.cwd, intervention: cancelled ?? intervention });
}

export function handleRunInterventionPromote(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  runnerRegistry: RunnerRegistry,
  activeRuns: ActiveRunRegistry,
  runtimeSupervisor: RuntimeSupervisor,
  secretResolver: SecretResolver,
  mcpBroker: McpBroker,
  computerUsePreviews: ComputerUseProjectionRegistry,
  controlPlaneEvents: ControlPlaneEventHub,
  startupState: StartupStateRegistry | undefined,
  interventionId: string,
): void {
  const resolved = getCwdStoreOrWriteError(response, url, storeRegistry);
  if (!resolved) {
    return;
  }
  const intervention = resolved.store.getRunIntervention(interventionId);
  if (!intervention) {
    writeJson(response, 404, { error: "run_intervention_not_found", message: `Run intervention not found: ${interventionId}` });
    return;
  }
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for run intervention promote` });
    return;
  }
  if (intervention.status !== "queued") {
    writeJson(response, 409, {
      error: "run_intervention_not_queued",
      message: "只有排队中的引导可以立即执行。",
      intervention,
    });
    return;
  }

  const sourceRun = resolved.store.getRun(intervention.sourceRunId);
  if (!sourceRun) {
    writeJson(response, 404, { error: "run_not_found", message: `Source run not found: ${intervention.sourceRunId}`, intervention });
    return;
  }

  const currentRun = findCurrentRunForIntervention(resolved.store, sourceRun);
  if (!currentRun || isTerminalRunStatus(currentRun.status)) {
    void maybeStartNextRunInterventionContinuation({
      sourceRunId: intervention.sourceRunId,
      store: resolved.store,
      runnerRegistry,
      storeRegistry,
      activeRuns,
      runtimeSupervisor,
      secretResolver,
      mcpBroker,
      computerUsePreviews,
      controlPlaneEvents,
      startupState,
    }).catch(() => {});
    writeJson(response, 202, {
      cwd: resolved.cwd,
      intervention: resolved.store.getRunIntervention(intervention.id) ?? intervention,
      run: resolved.store.getRun(sourceRun.id) ?? sourceRun,
      message: "当前运行已结束，这条引导会按排队顺序继续执行。",
    });
    return;
  }

  const now = new Date().toISOString();
  const promoted = resolved.store.updateRunInterventionStatus({
    interventionId: intervention.id,
    status: "cancelling_source",
    now,
  }) ?? intervention;
  streamRunEventIfPossible(resolved.store, activeRuns, intervention.sourceRunId, "run_interrupt_requested", {
    interventionId: promoted.id,
    instruction: promoted.instruction,
  });

  const cancellation = runControlService.cancelRunForRedirect({
    store: resolved.store,
    run: currentRun,
    activeRun: activeRuns.get(currentRun.id),
  });
  void maybeStartNextRunInterventionContinuation({
    sourceRunId: intervention.sourceRunId,
    store: resolved.store,
    runnerRegistry,
    storeRegistry,
    activeRuns,
    runtimeSupervisor,
    secretResolver,
    mcpBroker,
    computerUsePreviews,
    controlPlaneEvents,
    startupState,
  }).catch(() => {});

  writeJson(response, 200, {
    cwd: resolved.cwd,
    intervention: resolved.store.getRunIntervention(intervention.id) ?? promoted,
    run: resolved.store.getRun(currentRun.id),
    event: cancellation.event,
  });
}

export async function maybeStartNextRunInterventionContinuation(input: {
  readonly sourceRunId: string;
  readonly terminalRun?: RunSession;
  readonly store: RunStore;
  readonly runnerRegistry: RunnerRegistry;
  readonly storeRegistry: RunStoreRegistry;
  readonly activeRuns: ActiveRunRegistry;
  readonly runtimeSupervisor: RuntimeSupervisor;
  readonly secretResolver: SecretResolver;
  readonly mcpBroker: McpBroker;
  readonly computerUsePreviews: ComputerUseProjectionRegistry;
  readonly controlPlaneEvents: ControlPlaneEventHub;
  readonly startupState?: StartupStateRegistry;
}): Promise<void> {
  if (input.terminalRun?.interventionId) {
    completeTerminalRunIntervention(input.store, input.terminalRun);
  }
  const sourceRun = input.store.getRun(input.sourceRunId);
  if (!sourceRun || !isTerminalRunStatus(sourceRun.status)) {
    return;
  }
  const next = input.store
    .listRunInterventions({ sourceRunId: input.sourceRunId, limit: 100 })
    .find((intervention) => intervention.status === "cancelling_source" || intervention.status === "queued");
  if (!next) {
    return;
  }
  const now = new Date().toISOString();
  const starting = input.store.updateRunInterventionStatus({
    interventionId: next.id,
    status: "starting_continuation",
    startedAt: now,
    now,
  });
  if (!starting) {
    return;
  }
  streamRunEventIfPossible(input.store, input.activeRuns, input.sourceRunId, "run_continuation_starting", {
    interventionId: starting.id,
    mode: starting.mode,
  });
  let continuationRunId: string | undefined;
  let channelProjection: ReturnType<typeof createChannelReplyContinuationProjection> = undefined;
  try {
    channelProjection = createChannelReplyContinuationProjection({
      store: input.store,
      sourceRun,
      intervention: starting,
    });
    const continuationRequest = buildRunInterventionContinuationRequest(input.store, sourceRun, starting, {
      sourceMessageId: channelProjection?.sourceMessageId,
      linkedMessageId: channelProjection?.replyMessageId,
    });
    continuationRunId = await executeRunRequest(
      continuationRequest,
      channelProjection?.sink ?? createDetachedRunExecutionSink(),
      input.runnerRegistry,
      input.storeRegistry,
      input.activeRuns,
      input.runtimeSupervisor,
      input.secretResolver,
      input.mcpBroker,
      {
        controlPlaneEvents: input.controlPlaneEvents,
        startupState: input.startupState,
        computerUsePreviews: input.computerUsePreviews,
        onRunReady: (runId) => {
          const run = input.store.getRun(runId);
          input.store.updateRunInterventionStatus({
            interventionId: starting.id,
            status: "started",
            continuationRunId: runId,
            continuationWorkUnitId: run?.workUnitId ?? null,
            now: new Date().toISOString(),
          });
          streamRunEventIfPossible(input.store, input.activeRuns, input.sourceRunId, "run_continuation_started", {
            interventionId: starting.id,
            continuationRunId: runId,
            continuationWorkUnitId: run?.workUnitId,
          });
        },
        afterRunTerminal: async (terminalRun) => {
          const sourceRunId = terminalRun.parentRunId ?? terminalRun.id;
          const goalContinuation = maybeQueueGoalContinuation({
            terminalRun,
            store: input.store,
            activeRuns: input.activeRuns,
          });
          await maybeStartNextRunInterventionContinuation({
            ...input,
            sourceRunId: goalContinuation?.sourceRunId ?? sourceRunId,
            terminalRun,
          });
        },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    channelProjection?.finalize(undefined, message);
    input.store.updateRunInterventionStatus({
      interventionId: starting.id,
      status: "failed",
      completedAt: new Date().toISOString(),
      failureReason: message,
      now: new Date().toISOString(),
    });
    streamRunEventIfPossible(input.store, input.activeRuns, input.sourceRunId, "run_intervention_failed", {
      interventionId: starting.id,
      message,
    });
    return;
  }
  if (!continuationRunId) {
    channelProjection?.finalize(undefined, "Continuation run failed to start.");
    input.store.updateRunInterventionStatus({
      interventionId: starting.id,
      status: "failed",
      completedAt: new Date().toISOString(),
      failureReason: "Continuation run failed to start.",
      now: new Date().toISOString(),
    });
    streamRunEventIfPossible(input.store, input.activeRuns, input.sourceRunId, "run_intervention_failed", {
      interventionId: starting.id,
      message: "Continuation run failed to start.",
    });
  }
}

function completeTerminalRunIntervention(store: RunStore, terminalRun: RunSession): void {
  if (!terminalRun.interventionId) {
    return;
  }
  const intervention = store.getRunIntervention(terminalRun.interventionId);
  if (!intervention || intervention.completedAt) {
    return;
  }
  const sourceRun = store.getRun(intervention.sourceRunId);
  let projectionFailure: string | undefined;
  if (sourceRun) {
    try {
      createChannelReplyContinuationProjection({ store, sourceRun, intervention })?.finalize(terminalRun);
    } catch (error) {
      projectionFailure = error instanceof Error ? error.message : String(error);
    }
  }
  const now = terminalRun.endedAt ?? new Date().toISOString();
  store.updateRunInterventionStatus({
    interventionId: intervention.id,
    status: projectionFailure || terminalRun.status === "failed"
      ? "failed"
      : terminalRun.status === "cancelled"
        ? "cancelled"
        : "started",
    continuationRunId: terminalRun.id,
    continuationWorkUnitId: terminalRun.workUnitId ?? null,
    completedAt: now,
    failureReason: projectionFailure ?? terminalRun.errorMessage ?? null,
    now,
  });
}

export function maybeQueueGoalContinuation(input: {
  readonly terminalRun: RunSession;
  readonly store: RunStore;
  readonly activeRuns: ActiveRunRegistry;
}): RunIntervention | undefined {
  const run = input.terminalRun;
  const isAutomaticContinuationRun = run.continuationReason === "queue_followup";
  if (run.status !== "succeeded" || !run.threadId) {
    return undefined;
  }
  if ((run.parentRunId || run.continuationReason) && !isAutomaticContinuationRun) {
    return undefined;
  }
  const thread = input.store.getLingThread(run.threadId);
  if (!thread || thread.status === "archived") {
    return undefined;
  }
  const goal = input.store.getLingThreadGoal(thread.id);
  const evidenceDelta = goal ? goalContinuationEvidenceDelta(input.store, goal, run) : emptyGoalContinuationEvidenceDelta();
  if (thread.lastRunId !== run.id) {
    if (goal) {
      recordGoalContinuationStop(input.store, goal, "latest_run_not_terminal", evidenceDelta);
    }
    return undefined;
  }
  const mode = input.store.getLingThreadConversationMode(thread.id);
  const rootRunId = run.parentRunId ?? run.id;
  const currentRunHasEvidence = hasMeaningfulGoalProgressEvidence(input.store, run.id);
  const nextNoEvidenceContinuationCount = isAutomaticContinuationRun && !currentRunHasEvidence
    ? (goal?.noEvidenceContinuationCount ?? 0) + 1
    : 0;
  const guard = evaluateGoalContinuationGuard({
    goal,
    modeKind: mode?.mode,
    hasPendingApproval: input.store.listApprovalRequests({ runId: run.id, status: "pending", limit: 1 }).length > 0,
    hasActiveRun: Boolean(thread.activeRunId && thread.activeRunId !== run.id && input.activeRuns.get(thread.activeRunId)),
    hasPendingIntervention: hasPendingRunIntervention(input.store, run.id),
    nextNoEvidenceContinuationCount,
  });
  if (guard.decision === "stopped") {
    if (goal) {
      recordGoalContinuationStop(
        input.store,
        goal,
        guard.stopReason,
        evidenceDelta,
        guard.noEvidenceContinuationCount,
      );
    }
    return undefined;
  }
  if (!goal) {
    return undefined;
  }
  const activeGoal = goal;

  const now = new Date().toISOString();
  const sourceWorkUnit = run.workUnitId ? input.store.getWorkUnit(run.workUnitId) : undefined;
  const instruction = renderGoalContinuationInstruction(activeGoal.objective);
  const chainId = activeGoal.continuationChainId ?? `goal_chain_${activeGoal.id}_${rootRunId}`;
  const nextDepth = activeGoal.continuationDepth + 1;
  input.store.updateLingThreadGoal(
    activeGoal.id,
    {
      continuationChainId: chainId,
      continuationDepth: nextDepth,
      noEvidenceContinuationCount: nextNoEvidenceContinuationCount,
      lastContinuationStopReason: null,
      lastContinuationStoppedAt: null,
      lastContinuationEvidenceDelta: evidenceDelta,
    },
    now,
  );
  const intervention = input.store.createRunIntervention(
    {
      sourceRunId: run.id,
      sourceWorkUnitId: run.workUnitId,
      sourceAttemptId: sourceWorkUnit?.activeAttemptId ?? (run.workUnitId ? input.store.listWorkUnitAttempts(run.workUnitId).at(-1)?.id : undefined),
      mode: "queue_followup",
      instruction,
      messagePayload: {
        body: instruction,
        attachmentIds: [],
        linkPreviewIds: [],
      },
      requestedBy: "system",
      idempotencyKey: `goal_auto_continue:${activeGoal.id}:${run.id}:${nextDepth}`,
    },
    now,
  );
  streamRunEventIfPossible(input.store, input.activeRuns, run.id, "run_intervention_created", {
    interventionId: intervention.id,
    mode: intervention.mode,
    status: intervention.status,
    reason: "goal_auto_continue",
    goalId: activeGoal.id,
    continuationChainId: chainId,
    continuationDepth: nextDepth,
  });
  streamRunEventIfPossible(input.store, input.activeRuns, run.id, "run_followup_queued", {
    interventionId: intervention.id,
    instruction: intervention.instruction,
    reason: "goal_auto_continue",
    goalId: activeGoal.id,
    continuationChainId: chainId,
    continuationDepth: nextDepth,
  });
  return intervention;
}

const MAX_GOAL_CONTINUATION_DEPTH = 3;
const MAX_GOAL_NO_EVIDENCE_CONTINUATIONS = 2;

type GoalContinuationGuardDecision =
  | { readonly decision: "started" }
  | {
      readonly decision: "stopped";
      readonly stopReason: GoalContinuationStopReason;
      readonly noEvidenceContinuationCount?: number;
    };

function evaluateGoalContinuationGuard(input: {
  readonly goal: LingThreadGoal | undefined;
  readonly modeKind: string | undefined;
  readonly hasPendingApproval: boolean;
  readonly hasActiveRun: boolean;
  readonly hasPendingIntervention: boolean;
  readonly nextNoEvidenceContinuationCount: number;
}): GoalContinuationGuardDecision {
  const { goal } = input;
  if (!goal) {
    return { decision: "stopped", stopReason: "goal_not_active" };
  }
  if (input.modeKind === "plan") {
    return { decision: "stopped", stopReason: "plan_mode_active" };
  }
  if (goal.status === "usage_limited") {
    return { decision: "stopped", stopReason: "usage_limited" };
  }
  if (goal.status === "budget_limited" || (goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget)) {
    return { decision: "stopped", stopReason: "budget_limited" };
  }
  if (goal.status !== "active") {
    return { decision: "stopped", stopReason: "goal_not_active" };
  }
  if (input.hasPendingApproval) {
    return { decision: "stopped", stopReason: "pending_approval" };
  }
  if (input.hasActiveRun || input.hasPendingIntervention) {
    return { decision: "stopped", stopReason: "active_run_exists" };
  }
  if (goal.continuationDepth >= MAX_GOAL_CONTINUATION_DEPTH) {
    return { decision: "stopped", stopReason: "max_depth" };
  }
  if (input.nextNoEvidenceContinuationCount >= MAX_GOAL_NO_EVIDENCE_CONTINUATIONS) {
    return {
      decision: "stopped",
      stopReason: "no_evidence_threshold",
      noEvidenceContinuationCount: input.nextNoEvidenceContinuationCount,
    };
  }
  return { decision: "started" };
}

function recordGoalContinuationStop(
  store: RunStore,
  goal: LingThreadGoal,
  stopReason: GoalContinuationStopReason,
  evidenceDelta: GoalContinuationEvidenceDelta,
  noEvidenceContinuationCount = goal.noEvidenceContinuationCount,
): void {
  const now = new Date().toISOString();
  store.updateLingThreadGoal(
    goal.id,
    {
      noEvidenceContinuationCount,
      lastContinuationStopReason: stopReason,
      lastContinuationStoppedAt: now,
      lastContinuationEvidenceDelta: evidenceDelta,
    },
    now,
  );
}

function goalContinuationEvidenceDelta(store: RunStore, goal: LingThreadGoal, run: RunSession): GoalContinuationEvidenceDelta {
  const existingRefs = new Set(goal.completionEvidenceRefs.map(goalEvidenceRefKey));
  const newEvidenceRefs = goalEvidenceRefsForContinuationRun(store, run).filter((ref) => !existingRefs.has(goalEvidenceRefKey(ref))).length;
  return {
    newEvidenceRefs,
    changedFiles: 0,
    acceptedPlans: 0,
    artifacts: store.listArtifacts(run.id).length,
    statusChanged: false,
  };
}

function emptyGoalContinuationEvidenceDelta(): GoalContinuationEvidenceDelta {
  return {
    newEvidenceRefs: 0,
    changedFiles: 0,
    acceptedPlans: 0,
    artifacts: 0,
    statusChanged: false,
  };
}

function goalEvidenceRefsForContinuationRun(store: RunStore, run: RunSession): readonly { readonly kind: "run" | "artifact"; readonly id: string }[] {
  const refs: { readonly kind: "run" | "artifact"; readonly id: string }[] = [{ kind: "run", id: run.id }];
  for (const artifact of store.listArtifacts(run.id)) {
    refs.push({ kind: "artifact", id: artifact.id });
  }
  return refs;
}

function goalEvidenceRefKey(ref: { readonly kind: string; readonly id: string }): string {
  return `${ref.kind}:${ref.id}`;
}

function hasPendingRunIntervention(store: RunStore, sourceRunId: string): boolean {
  return ["queued", "cancelling_source", "starting_continuation"].
    some((status) => store.listRunInterventions({ sourceRunId, status: status as RunIntervention["status"], limit: 1 }).length > 0);
}

function hasMeaningfulGoalProgressEvidence(store: RunStore, runId: string): boolean {
  if (store.listArtifacts(runId).length > 0) {
    return true;
  }
  return store.listApprovalRequests({ runId, limit: 1 }).length > 0;
}

function renderGoalContinuationInstruction(objective: string): string {
  return [
    `Continue working toward active goal: ${objective.trim()}`,
    "",
    "Stop and report visibly if the goal appears complete, blocked, needs user input, or requires additional approval.",
  ].join("\n");
}

function parseRunInterventionCreateRequest(value: unknown): {
  readonly mode: RunInterventionMode;
  readonly instruction: string;
  readonly messagePayload?: RunInterventionMessagePayload;
  readonly idempotencyKey: string;
} {
  if (!isRecord(value)) {
    throw new Error("Run intervention request must be a JSON object");
  }
  const mode = readRunInterventionMode(value, "mode");
  const instruction = readString(value, "instruction").trim();
  if (!instruction) {
    throw new Error("instruction is required");
  }
  const messagePayload = parseRunInterventionMessagePayload(value.messagePayload);
  const idempotencyKey = readOptionalString(value, "idempotencyKey") ?? `run_intervention:${randomUUID()}`;
  return { mode, instruction, messagePayload, idempotencyKey };
}

function parseRunInterventionMessagePayload(value: unknown): RunInterventionMessagePayload | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("messagePayload must be an object");
  }
  const body = typeof value.body === "string" ? value.body.trim() : "";
  const sourceMessageId = readOptionalString(value, "sourceMessageId");
  const targetTeammateId = readOptionalString(value, "targetTeammateId");
  const attachmentIds = readOptionalStringArray(value, "attachmentIds") ?? [];
  const linkPreviewIds = readOptionalStringArray(value, "linkPreviewIds") ?? [];
  const attachments = readOptionalRunInterventionAttachmentPayloads(value, "attachments");
  const linkPreviews = readOptionalRunInterventionLinkPreviewPayloads(value, "linkPreviews");
  const fileRefs = readOptionalRunInterventionWorkspaceFilePayloads(value, "fileRefs");
  if (!body && attachmentIds.length === 0 && linkPreviewIds.length === 0 && !attachments?.length && !linkPreviews?.length && !fileRefs?.length) {
    throw new Error("messagePayload must include body, attachments, link previews, or file refs");
  }
  return {
    ...(sourceMessageId ? { sourceMessageId } : {}),
    ...(targetTeammateId ? { targetTeammateId } : {}),
    body,
    attachmentIds,
    linkPreviewIds,
    ...(attachments?.length ? { attachments } : {}),
    ...(linkPreviews?.length ? { linkPreviews } : {}),
    ...(fileRefs?.length ? { fileRefs } : {}),
  };
}

function readOptionalRunInterventionAttachmentPayloads(
  record: Record<string, unknown>,
  key: string,
): readonly RunInterventionAttachmentPayload[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((item) => {
    if (!isRecord(item)) {
      throw new Error(`${key} must contain objects`);
    }
    const id = readString(item, "id");
    const previewStatus = readOptionalString(item, "previewStatus");
    const previewText = readOptionalString(item, "previewText");
    const reason = readOptionalString(item, "reason");
    return {
      id,
      fileName: readOptionalString(item, "fileName") ?? id,
      kind: readRunInterventionAttachmentKind(item.kind),
      contentType: readOptionalString(item, "contentType") ?? "application/octet-stream",
      sizeBytes: readOptionalNonNegativeNumber(item, "sizeBytes"),
      materializationStatus: readRunInterventionMaterializationStatus(item.materializationStatus),
      ...(previewStatus ? { previewStatus } : {}),
      ...(previewText ? { previewText } : {}),
      ...(reason ? { reason } : {}),
    };
  });
}

function readOptionalRunInterventionLinkPreviewPayloads(
  record: Record<string, unknown>,
  key: string,
): readonly RunInterventionLinkPreviewPayload[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((item) => {
    if (!isRecord(item)) {
      throw new Error(`${key} must contain objects`);
    }
    const id = readString(item, "id");
    const url = readOptionalString(item, "url") ?? id;
    const normalizedUrl = readOptionalString(item, "normalizedUrl") ?? url;
    const title = readOptionalString(item, "title");
    const description = readOptionalString(item, "description");
    const siteName = readOptionalString(item, "siteName");
    const previewText = readOptionalString(item, "previewText");
    const reason = readOptionalString(item, "reason");
    return {
      id,
      url,
      normalizedUrl,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(siteName ? { siteName } : {}),
      status: readRunInterventionLinkPreviewStatus(item.status),
      materializationStatus: readRunInterventionMaterializationStatus(item.materializationStatus),
      ...(previewText ? { previewText } : {}),
      ...(reason ? { reason } : {}),
    };
  });
}

function readOptionalRunInterventionWorkspaceFilePayloads(
  record: Record<string, unknown>,
  key: string,
): readonly RunInterventionWorkspaceFilePayload[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((item) => {
    if (!isRecord(item)) {
      throw new Error(`${key} must contain objects`);
    }
    const label = readOptionalString(item, "label");
    const previewText = readOptionalString(item, "previewText");
    const blockedReason = readOptionalString(item, "blockedReason");
    return {
      path: readString(item, "path"),
      ...(label ? { label } : {}),
      rootRelation: readRunInterventionWorkspaceFileRootRelation(item.rootRelation),
      kind: readRunInterventionWorkspaceFileKind(item.kind),
      materializationStatus: readRunInterventionMaterializationStatus(item.materializationStatus),
      ...(previewText ? { previewText } : {}),
      ...(blockedReason ? { blockedReason } : {}),
    };
  });
}

function readOptionalNonNegativeNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function readRunInterventionMaterializationStatus(value: unknown): RunInterventionMaterializationStatus {
  if (value === "available" || value === "metadata_only" || value === "not_loaded" || value === "unsupported" || value === "blocked") {
    return value;
  }
  return "metadata_only";
}

function readRunInterventionAttachmentKind(value: unknown): RunInterventionAttachmentPayload["kind"] {
  return value === "image" || value === "pdf" || value === "office" || value === "text" || value === "other" ? value : "other";
}

function readRunInterventionLinkPreviewStatus(value: unknown): RunInterventionLinkPreviewPayload["status"] {
  return value === "ready" || value === "blocked" || value === "failed" || value === "missing" || value === "channel_mismatch" ? value : "missing";
}

function readRunInterventionWorkspaceFileRootRelation(value: unknown): RunInterventionWorkspaceFilePayload["rootRelation"] {
  return value === "inside_workspace" || value === "outside_workspace" || value === "unknown" ? value : "unknown";
}

function readRunInterventionWorkspaceFileKind(value: unknown): RunInterventionWorkspaceFilePayload["kind"] {
  return value === "file" || value === "directory" || value === "glob" || value === "unknown" ? value : "unknown";
}

function streamRunEventIfPossible(
  store: RunStore,
  activeRuns: ActiveRunRegistry,
  runId: string,
  type: RunEventType,
  data: unknown,
): void {
  try {
    const envelope = store.appendEvent(runId, type, data);
    activeRuns.get(runId)?.streamEnvelope(envelope);
  } catch {
    // Intervention events are operational hints; the intervention row is authoritative.
  }
}

function findCurrentRunForIntervention(store: RunStore, sourceRun: RunSession): RunSession | undefined {
  const candidates = [
    sourceRun,
    ...store.listRuns({ limit: 200 }).filter((run) => run.parentRunId === sourceRun.id),
  ].filter((run) => !isTerminalRunStatus(run.status));
  return candidates.sort((left, right) => readRunSortTime(right).localeCompare(readRunSortTime(left)))[0];
}

function readRunSortTime(run: RunSession): string {
  return run.startedAt ?? run.createdAt;
}

function readRunInterventionMode(record: Record<string, unknown>, key: string): RunInterventionMode {
  const value = readString(record, key);
  if (!runInterventionModes.includes(value as RunInterventionMode)) {
    throw new Error(`${key} must be one of: ${runInterventionModes.join(", ")}`);
  }
  return value as RunInterventionMode;
}

function getCwdStoreOrWriteError(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
): { readonly cwd: string; readonly store: RunStore } | undefined {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return undefined;
  }
  return { cwd, store: storeRegistry.getStore(cwd) };
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}
