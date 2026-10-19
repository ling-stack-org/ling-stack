import type {
  GoalContinuationEvidenceDelta,
  GoalContinuationStopReason,
  GoalEvidenceRef,
  GoalUsageSource,
  LingTurn,
  LingTurnKind,
  LingTurnRunRole,
  LingThread,
  LingThreadGoal,
  LingThreadGoalStatus,
  RunEventEnvelope,
  RunEventType,
  RunSession,
  RunStatus,
  RunStore,
} from "@ling-stack/core";
import type { RunRequest } from "./schemas.js";
import { publishNormalNarrationAfterRun } from "../conversations/normal-narration-publication.js";
import { approvalEventReflectsRunState } from "./approval-event-state.js";
import { isNativeApprovalEvent } from "./native-approval-events.js";

export function ensureLingThreadForRun(store: RunStore, runRequest: RunRequest, now: string): LingThread {
  if (runRequest.threadId) {
    const requestedThread = store.getLingThread(runRequest.threadId);
    if (!requestedThread) {
      throw new Error(`Ling thread not found: ${runRequest.threadId}`);
    }
    if (requestedThread.status === "archived") {
      throw new Error(`Ling thread is archived: ${runRequest.threadId}`);
    }
    return requestedThread;
  }

  const parentThread = findParentLingThread(store, runRequest.parentRunId);
  if (parentThread && parentThread.status !== "archived") {
    return parentThread;
  }

  if (runRequest.workflowStepId) {
    const workflowStep = store.getChannelWorkflowStep(runRequest.workflowStepId);
    const existing = store.findLingThreadByOwner({
      kind: "workflow_step",
      workflowStepId: runRequest.workflowStepId,
      channelId: workflowStep?.channelId ?? runRequest.task.channelId,
    });
    if (existing && existing.status !== "archived") {
      return existing;
    }

    return store.createLingThread(
      {
        kind: "workflow_step",
        channelId: workflowStep?.channelId ?? runRequest.task.channelId,
        taskId: runRequest.task.id,
        teammateId: runRequest.teammateId,
        workflowId: workflowStep?.workflowId,
        workflowStepId: runRequest.workflowStepId,
        title: workflowStep?.title ?? runRequest.task.title,
        objective: workflowStep?.prompt ?? runRequest.task.prompt,
        status: "open",
      },
      now,
    );
  }

  const existing = store.findLingThreadByOwner({
    kind: "task",
    taskId: runRequest.task.id,
    channelId: runRequest.task.channelId,
  });
  if (existing && existing.status !== "archived") {
    return existing;
  }

  return store.createLingThread(
    {
      kind: "task",
      channelId: runRequest.task.channelId,
      taskId: runRequest.task.id,
      title: runRequest.task.title,
      objective: runRequest.task.prompt,
      status: "open",
    },
    now,
  );
}

export function ensureLingTurnForRun(store: RunStore, thread: LingThread, runRequest: RunRequest, now: string): LingTurn {
  if (runRequest.turnId) {
    const turn = store.getLingTurn(runRequest.turnId);
    if (!turn) {
      throw new Error(`Ling turn not found: ${runRequest.turnId}`);
    }
    if (turn.threadId !== thread.id) {
      throw new Error(`Ling turn does not belong to thread: ${runRequest.turnId}`);
    }
    const role = inferLingTurnRunRole(runRequest);
    if ((turn.status === "cancelled" || turn.status === "superseded") && role !== "retry" && role !== "resume") {
      throw new Error(`Ling turn cannot be reused: ${runRequest.turnId}`);
    }
    return turn;
  }

  const sourceTurn = runRequest.parentRunId ? store.getLingTurnForRun(runRequest.parentRunId) : undefined;
  return store.createLingTurn(
    {
      threadId: thread.id,
      kind: inferLingTurnKind(thread, runRequest),
      title: runRequest.task.title,
      userInstruction: runRequest.task.prompt,
      channelId: thread.channelId ?? runRequest.task.channelId,
      taskId: thread.taskId ?? runRequest.task.id,
      teammateId: thread.teammateId ?? runRequest.teammateId,
      workflowStepId: thread.workflowStepId ?? runRequest.workflowStepId,
      externalWorkId: thread.externalWorkId,
      sourceTurnId: sourceTurn?.id,
      interventionId: runRequest.interventionId,
      sourceItemId: runRequest.sourceMessageId,
      createdByActor: runRequest.createdByActor ?? inferLingTurnActor(thread),
    },
    now,
  );
}

export function inferLingTurnRunRole(runRequest: RunRequest): LingTurnRunRole {
  if (runRequest.continuationReason === "manual_resume" || runRequest.continuationReason === "queue_followup" || runRequest.continuationReason === "interrupt_redirect") {
    return "resume";
  }
  if (runRequest.parentRunId) {
    return "retry";
  }
  return "primary";
}

export function markLingThreadRunActive(
  store: RunStore,
  threadId: string | undefined,
  runId: string,
  now: string,
): LingThread | undefined {
  if (!threadId) {
    return undefined;
  }
  return store.updateLingThread(
    threadId,
    {
      status: "running",
      activeRunId: runId,
      lastRunId: runId,
    },
    now,
  );
}

export function syncLingThreadForRunEvent(
  store: RunStore,
  capturedRun: RunSession,
  type: RunEventType,
  envelope: RunEventEnvelope,
): void {
  const run = store.getRun(capturedRun.id);
  if (!run?.threadId || envelope.runId !== run.id) {
    return;
  }
  if (isNativeApprovalEvent(store, envelope)) return;
  if (type !== "run_cancelled" && !approvalEventReflectsRunState(store, envelope)) return;

  if (type === "approval_requested") {
    store.updateLingThread(
      run.threadId,
      {
        status: "waiting_for_approval",
        activeRunId: run.id,
        lastRunId: run.id,
      },
      envelope.ts,
    );
    return;
  }

  if (type === "approval_approved") {
    store.updateLingThread(
      run.threadId,
      {
        status: "running",
        activeRunId: run.id,
        lastRunId: run.id,
      },
      envelope.ts,
    );
    return;
  }

  if (type === "approval_denied" || type === "approval_expired" || type === "run_cancelled") {
    updateLingThreadForTerminalRunStatus(store, run, type === "run_cancelled" ? "cancelled" : "failed", envelope.ts);
  }
}

export function syncLingThreadForTerminalRun(store: RunStore, runId: string, now: string): LingThread | undefined {
  const run = store.getRun(runId);
  if (!run || !isTerminalRunStatus(run.status)) {
    return undefined;
  }
  return updateLingThreadForTerminalRunStatus(store, run, run.status, now);
}

export function updateLingThreadForTerminalRunStatus(
  store: RunStore,
  run: RunSession,
  status: Extract<RunStatus, "succeeded" | "failed" | "cancelled">,
  now: string,
): LingThread | undefined {
  if (!run.threadId) {
    return undefined;
  }
  const thread = store.getLingThread(run.threadId);
  if (!thread) {
    return undefined;
  }
  const updatedThread = store.updateLingThread(
    run.threadId,
    {
      status,
      activeRunId: thread.activeRunId === run.id ? null : thread.activeRunId,
      lastRunId: run.id,
    },
    now,
  );
  syncLingThreadGoalForTerminalRun(store, run, now);
  publishNormalNarrationAfterRun(store, run.id, now);
  return updatedThread;
}

function syncLingThreadGoalForTerminalRun(store: RunStore, run: RunSession, now: string): LingThreadGoal | undefined {
  if (!run.threadId) {
    return undefined;
  }
  const goal = store.getLingThreadGoal(run.threadId);
  if (!goal) {
    return undefined;
  }
  const hasRunEvidence = goal.completionEvidenceRefs.some((ref) => ref.kind === "run" && ref.id === run.id);
  const additionalTimeSeconds = hasRunEvidence ? 0 : elapsedRunSeconds(run, now);
  const usage = hasRunEvidence ? { tokens: 0, source: goal.usageSource } : readRunTokenUsage(store, run);
  const additionalTokens = usage.tokens;
  const nextTokensUsed = goal.tokensUsed + additionalTokens;
  const runEvidenceRefs = goalEvidenceRefsForRun(store, run);
  const nextEvidenceRefs = appendGoalEvidenceRefs(goal.completionEvidenceRefs, runEvidenceRefs);
  const blocker = run.status === "failed" && !isProviderUsageLimitedRun(run) ? goalBlockerForRun(run) : undefined;
  const nextSameBlockerCount = blocker
    ? goal.lastBlockerFingerprint === blocker.fingerprint ? goal.sameBlockerCount + 1 : 1
    : goal.sameBlockerCount;
  const nextStatus = nextGoalStatusForRunAccounting(goal, run, nextTokensUsed, nextSameBlockerCount, blocker);
  const resetContinuationChain = run.continuationReason !== "queue_followup";
  const continuationStopReason = goalContinuationStopReasonForTerminalRun(goal, run, nextStatus, nextSameBlockerCount, blocker);
  const continuationEvidenceDelta = goalContinuationEvidenceDelta(store, goal, run, nextEvidenceRefs, nextStatus);
  return store.updateLingThreadGoal(
    goal.id,
    {
      status: nextStatus,
      tokensUsed: nextTokensUsed,
      timeUsedSeconds: goal.timeUsedSeconds + additionalTimeSeconds,
      lastRunId: run.id,
      blockedReason: nextGoalBlockedReason(goal, nextStatus, blocker),
      completionEvidenceRefs: nextEvidenceRefs,
      usageSource: mergeGoalUsageSource(goal.usageSource, usage.source),
      continuationChainId: resetContinuationChain ? null : goal.continuationChainId,
      continuationDepth: resetContinuationChain ? 0 : goal.continuationDepth,
      noEvidenceContinuationCount: resetContinuationChain ? 0 : goal.noEvidenceContinuationCount,
      lastBlockerFingerprint: blocker?.fingerprint ?? goal.lastBlockerFingerprint,
      sameBlockerCount: blocker ? nextSameBlockerCount : goal.sameBlockerCount,
      lastContinuationStopReason: continuationStopReason ?? (resetContinuationChain ? null : goal.lastContinuationStopReason),
      lastContinuationStoppedAt: continuationStopReason ? now : resetContinuationChain ? null : goal.lastContinuationStoppedAt,
      lastContinuationEvidenceDelta: continuationStopReason ? continuationEvidenceDelta : resetContinuationChain ? null : goal.lastContinuationEvidenceDelta,
    },
    now,
  );
}

function nextGoalStatusForRunAccounting(
  goal: LingThreadGoal,
  run: RunSession,
  tokensUsed: number,
  sameBlockerCount: number,
  blocker: GoalBlocker | undefined,
): LingThreadGoalStatus {
  if (goal.status === "paused" || goal.status === "complete" || goal.status === "cleared" || goal.status === "replaced") {
    return goal.status;
  }
  if (goal.status === "usage_limited") {
    return "usage_limited";
  }
  if (run.status === "failed" && isProviderUsageLimitedRun(run)) {
    return "usage_limited";
  }
  if (goal.tokenBudget !== undefined && tokensUsed >= goal.tokenBudget) {
    return "budget_limited";
  }
  if (blocker && sameBlockerCount >= 3) {
    return "blocked";
  }
  return goal.status;
}

function nextGoalBlockedReason(goal: LingThreadGoal, nextStatus: LingThreadGoalStatus, blocker?: GoalBlocker): string | undefined {
  if (nextStatus === "usage_limited" && goal.status !== "usage_limited") {
    return "Provider quota or rate limit reached.";
  }
  if (nextStatus === "budget_limited" && goal.status !== "budget_limited") {
    return "Token budget reached.";
  }
  if (nextStatus === "blocked" && blocker) {
    return blocker.reason;
  }
  return goal.blockedReason;
}

function goalContinuationStopReasonForTerminalRun(
  goal: LingThreadGoal,
  run: RunSession,
  nextStatus: LingThreadGoalStatus,
  sameBlockerCount: number,
  blocker: GoalBlocker | undefined,
): GoalContinuationStopReason | undefined {
  if (nextStatus === "usage_limited" && goal.status !== "usage_limited") {
    return "usage_limited";
  }
  if (nextStatus === "budget_limited" && goal.status !== "budget_limited") {
    return "budget_limited";
  }
  if (blocker && sameBlockerCount >= 3) {
    return "same_blocker_threshold";
  }
  return undefined;
}

function goalContinuationEvidenceDelta(
  store: RunStore,
  goal: LingThreadGoal,
  run: RunSession,
  nextEvidenceRefs: readonly GoalEvidenceRef[],
  nextStatus: LingThreadGoalStatus,
): GoalContinuationEvidenceDelta {
  return {
    newEvidenceRefs: nextEvidenceRefs.length - goal.completionEvidenceRefs.length,
    changedFiles: 0,
    acceptedPlans: 0,
    artifacts: store.listArtifacts(run.id).length,
    statusChanged: nextStatus !== goal.status,
  };
}

interface GoalBlocker {
  readonly fingerprint: string;
  readonly reason: string;
}

function goalBlockerForRun(run: RunSession): GoalBlocker {
  const reason = run.errorMessage?.trim() || "Run failed while working toward the goal.";
  return {
    fingerprint: reason.toLowerCase().replace(/\s+/g, " ").slice(0, 256),
    reason,
  };
}

function isProviderUsageLimitedRun(run: RunSession): boolean {
  const normalized = [
    run.errorMessage,
    readProviderErrorCode(run.requestSnapshot),
    readProviderErrorCode(run.providerSnapshot),
  ].filter((value): value is string => Boolean(value)).join(" ").toLowerCase();
  return Boolean(normalized) && [
    "rate_limited",
    "rate limited",
    "rate limit",
    "quota_exceeded",
    "quota exceeded",
    "insufficient_quota",
    "too many requests",
    "http 429",
    "status 429",
  ].some((needle) => normalized.includes(needle));
}

function readProviderErrorCode(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return readOptionalString(value.errorCode) ?? readOptionalString(value.code);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function elapsedRunSeconds(run: RunSession, fallbackEndedAt: string): number {
  const start = Date.parse(run.startedAt ?? run.createdAt);
  const end = Date.parse(run.endedAt ?? fallbackEndedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return 0;
  }
  return Math.ceil((end - start) / 1000);
}

function readRunTokenUsage(store: RunStore, run: RunSession): { readonly tokens: number; readonly source: GoalUsageSource } {
  const events = store.listEvents(run.id, { limit: 1000 });
  const providerTokenTotals = events
    .map((event) => readEventTokenUsage(event.data))
    .filter((value): value is number => value !== undefined);
  if (providerTokenTotals.length > 0) {
    return {
      tokens: Math.max(0, ...providerTokenTotals),
      source: "provider",
    };
  }
  return {
    tokens: estimateRunTokenUsage(run, events),
    source: "estimated",
  };
}

function readEventTokenUsage(value: unknown): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return readTokenTotal(value.usage) ??
    readTokenTotal(value.tokenUsage) ??
    readTokenTotal(value.token_usage) ??
    readTokenTotal(value.responseUsage) ??
    readTokenTotal(value.response_usage);
}

function readTokenTotal(value: unknown): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const direct = readPositiveInteger(value.totalTokens) ??
    readPositiveInteger(value.total_tokens) ??
    readPositiveInteger(value.total);
  if (direct !== undefined) {
    return direct;
  }
  const input = readPositiveInteger(value.inputTokens) ??
    readPositiveInteger(value.input_tokens) ??
    readPositiveInteger(value.promptTokens) ??
    readPositiveInteger(value.prompt_tokens);
  const output = readPositiveInteger(value.outputTokens) ??
    readPositiveInteger(value.output_tokens) ??
    readPositiveInteger(value.completionTokens) ??
    readPositiveInteger(value.completion_tokens);
  return input !== undefined || output !== undefined ? (input ?? 0) + (output ?? 0) : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function estimateRunTokenUsage(run: RunSession, events: readonly RunEventEnvelope[]): number {
  const text = [
    collectEstimateText(run.taskSnapshot),
    collectEstimateText(run.requestSnapshot),
    ...events.map((event) => collectEstimateText(event.data)),
  ].filter(Boolean).join("\n");
  if (!text) {
    return 1;
  }
  return Math.max(1, Math.ceil(text.length / 4));
}

function collectEstimateText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(collectEstimateText).filter(Boolean).join("\n");
  }
  if (!isRecord(value)) {
    return "";
  }
  return Object.entries(value)
    .filter(([key]) => !key.toLowerCase().includes("secret") && !key.toLowerCase().includes("token"))
    .map(([, entry]) => collectEstimateText(entry))
    .filter(Boolean)
    .join("\n");
}

function mergeGoalUsageSource(existing: GoalUsageSource | undefined, next: GoalUsageSource | undefined): GoalUsageSource | undefined {
  if (!next) {
    return existing;
  }
  if (!existing || existing === next) {
    return next;
  }
  return "mixed";
}

function goalEvidenceRefsForRun(store: RunStore, run: RunSession): readonly GoalEvidenceRef[] {
  const refs: GoalEvidenceRef[] = [{ kind: "run", id: run.id }];
  const turn = store.getLingTurnForRun(run.id);
  if (turn) {
    refs.push({ kind: "turn", id: turn.id });
  }
  return refs;
}

function appendGoalEvidenceRefs(existing: readonly GoalEvidenceRef[], next: readonly GoalEvidenceRef[]): readonly GoalEvidenceRef[] {
  const seen = new Set(existing.map((ref) => `${ref.kind}:${ref.id}`));
  const merged = [...existing];
  for (const ref of next) {
    const key = `${ref.kind}:${ref.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(ref);
    }
  }
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findParentLingThread(store: RunStore, parentRunId: string | undefined): LingThread | undefined {
  if (!parentRunId) {
    return undefined;
  }
  const parentRun = store.getRun(parentRunId);
  if (!parentRun?.threadId) {
    return undefined;
  }
  return store.getLingThread(parentRun.threadId);
}

function inferLingTurnKind(thread: LingThread, runRequest: RunRequest): LingTurnKind {
  if (runRequest.continuationReason === "queue_followup") {
    return "queued_followup";
  }
  if (runRequest.continuationReason === "interrupt_redirect") {
    return "interrupt_redirect";
  }
  if (runRequest.continuationReason === "manual_resume" || runRequest.parentRunId) {
    return "manual_followup";
  }
  if (thread.kind === "workflow_step" || runRequest.workflowStepId) {
    return "workflow_step";
  }
  if (thread.kind === "external_work") {
    return "external_work_update";
  }
  if (thread.kind === "automation") {
    return "automation_tick";
  }
  return "initial_request";
}

function inferLingTurnActor(thread: LingThread): LingTurn["createdByActor"] {
  if (thread.kind === "automation") {
    return "automation";
  }
  if (thread.kind === "teammate_direct") {
    return "teammate";
  }
  return "local-user";
}

function isTerminalRunStatus(status: RunStatus): status is Extract<RunStatus, "succeeded" | "failed" | "cancelled"> {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}
