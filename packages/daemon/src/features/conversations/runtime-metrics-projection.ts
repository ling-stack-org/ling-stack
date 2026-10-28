import type { ConversationRuntimeMetrics } from "@ling-stack/contracts";
import type { LingThread, LingTurn, RunEventEnvelope, RunSession, RunStore } from "@ling-stack/core";

/** Project only runs that agree with the owner Thread and their linked Turn. */
export function projectConversationRuntimeMetrics(input: {
  readonly store: RunStore;
  readonly thread: LingThread;
  /** Other channel-discussion threads with the same channel owner, if channel-wide. */
  readonly channelThreads?: readonly LingThread[];
  readonly turns: readonly LingTurn[];
  readonly runs: readonly RunSession[];
  /** A bounded store enumeration reached its maximum and may omit older owners. */
  readonly enumerationMayBeTruncated?: boolean;
}): ConversationRuntimeMetrics {
  const { store, thread } = input;
  const owners = new Map((input.channelThreads ?? [thread])
    .filter((owner) => owner.workspaceId === thread.workspaceId &&
      (owner.id === thread.id || (thread.kind === "channel_discussion" &&
        owner.kind === "channel_discussion" && owner.channelId === thread.channelId)))
    .map((owner) => [owner.id, owner]));
  const turns = new Map(input.turns.filter((turn) => {
    const owner = owners.get(turn.threadId);
    return owner && turn.workspaceId === owner.workspaceId && matchesOwner(owner, turn);
  }).map((turn) => [turn.id, turn]));
  const linkedRunIds = new Set([...turns.values()].flatMap((turn) =>
    store.listLingTurnRuns(turn.id).map((link) => link.runId)));
  const runs = [...new Map(input.runs.filter((run) => {
    const owner = run.threadId ? owners.get(run.threadId) : undefined;
    return owner && linkedRunIds.has(run.id) && matchesOwner(owner, run);
  }).map((run) => [run.id, run])).values()]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));

  let rounds = 0;
  let tools = 0;
  let hasEvent = false;
  let lifecycleComplete = true;
  let partial = input.enumerationMayBeTruncated === true || linkedRunIds.size > runs.length;
  let usageCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalTokens = 0;
  let recentReply: { readonly ts: string; readonly rate: number } | undefined;
  let latestMeasured: { readonly ts: string; readonly runId: string; readonly seq: number; readonly tokens: number; readonly capacity: number | null } | undefined;
  let latestEstimated: { readonly ts: string; readonly runId: string; readonly seq: number; readonly tokens: number; readonly capacity: number | null } | undefined;
  let latestCapacity: number | null = null;
  let latestRunCreatedAt: string | undefined;
  let latestInvocation: { readonly ts: string; readonly runId: string; readonly seq: number } | undefined;

  for (const run of runs) {
    // A live preset may have changed since this run. Only its persisted snapshot is attributable.
    const capacity = positiveTokenCount(readRecord(run.providerSnapshot)?.contextWindow) ?? null;
    if (!latestRunCreatedAt || run.createdAt >= latestRunCreatedAt) {
      latestRunCreatedAt = run.createdAt;
      latestCapacity = capacity;
    }
    let startedAt: string | undefined;
    let runHadEvents = false;
    let runHadUsage = false;
    let runHadLifecycle = false;
    forEachRunEvent(store, run.id, (event) => {
      hasEvent = true;
      runHadEvents = true;
      if (event.type === "turn_start") {
        runHadLifecycle = true;
        if (newerEvent(latestInvocation, event)) latestInvocation = event;
        rounds++;
        startedAt = event.ts;
      } else if (event.type === "turn_end") {
        runHadLifecycle = true;
      } else if (event.type === "tool_start") {
        runHadLifecycle = true;
        tools++;
      } else if (event.type === "context_compaction_start") {
        if (newerEvent(latestInvocation, event)) latestInvocation = event;
      } else if (event.type === "context_compaction_end") {
        // Compaction is a separate provider invocation, not an assistant message_end.
        if (event.data.usage && validUsage(event.data.usage)) {
          const usage = event.data.usage;
          runHadUsage = true;
          usageCount++;
          inputTokens += usage.input;
          outputTokens += usage.output;
          cacheReadTokens += usage.cacheRead;
          cacheWriteTokens += usage.cacheWrite;
          totalTokens += usage.totalTokens;
        }
        if (event.data.outcome === "sdk_installed") {
          const estimate = tokenCount(event.data.estimatedTokensAfter);
          if (estimate !== undefined && newerEvent(latestEstimated, event)) {
            latestEstimated = { ts: event.ts, runId: event.runId, seq: event.seq, tokens: estimate, capacity };
          }
        }
      } else if (event.type === "message_end" && event.data.role === "assistant") {
        const usage = event.data.usage;
        if (!usage || !validUsage(usage)) {
          partial = true;
        } else {
          runHadUsage = true;
          usageCount++;
          inputTokens += usage.input;
          outputTokens += usage.output;
          cacheReadTokens += usage.cacheRead;
          cacheWriteTokens += usage.cacheWrite;
          totalTokens += usage.totalTokens;
          // Pi usage.input excludes cache-read and cache-write input classes.
          const measuredInput = usage.input + usage.cacheRead + usage.cacheWrite;
          if (newerEvent(latestMeasured, event)) latestMeasured = { ts: event.ts, runId: event.runId, seq: event.seq, tokens: measuredInput, capacity };
          const elapsedMs = startedAt ? Date.parse(event.ts) - Date.parse(startedAt) : NaN;
          if (elapsedMs > 0 && usage.output > 0 && Number.isFinite(elapsedMs)) {
            if (!recentReply || event.ts > recentReply.ts) {
              recentReply = { ts: event.ts, rate: Math.round(usage.output / (elapsedMs / 1000) * 10) / 10 };
            }
          }
        }
        startedAt = undefined;
      }
    });
    if (!runHadEvents || !runHadUsage ||
      !["succeeded", "failed", "cancelled"].includes(run.status)) partial = true;
    if (!runHadLifecycle) {
      lifecycleComplete = false;
      if (runHadEvents) partial = true;
    }
  }
  const measured = latestMeasured as { readonly ts: string; readonly runId: string; readonly seq: number; readonly tokens: number; readonly capacity: number | null } | undefined;
  const estimated = latestEstimated as { readonly ts: string; readonly runId: string; readonly seq: number; readonly tokens: number; readonly capacity: number | null } | undefined;
  // A newer invocation invalidates the previous request's context evidence;
  // subsequent tool/turn-end lifecycle events do not.
  const useMeasured = measured && (!estimated || !newerEvent(measured, estimated)) &&
    (!latestInvocation || !newerEvent(measured, latestInvocation));
  const context = useMeasured ? {
    measuredInputTokens: measured.tokens,
    capacityTokens: measured.capacity,
    estimatedTokens: null,
    basis: "measured" as const,
  } : estimated && (!latestInvocation || !newerEvent(estimated, latestInvocation)) ? {
    measuredInputTokens: null,
    capacityTokens: estimated.capacity,
    estimatedTokens: estimated.tokens,
    basis: "estimated" as const,
  } : {
    measuredInputTokens: null,
    capacityTokens: latestCapacity,
    estimatedTokens: null,
    basis: "unavailable" as const,
  };
  return {
    aiRounds: lifecycleComplete && linkedRunIds.size === runs.length ? rounds : null,
    toolSteps: lifecycleComplete && linkedRunIds.size === runs.length ? tools : null,
    inputTokens: usageCount ? inputTokens : null,
    outputTokens: usageCount ? outputTokens : null,
    cacheReadTokens: usageCount ? cacheReadTokens : null,
    cacheWriteTokens: usageCount ? cacheWriteTokens : null,
    totalTokens: usageCount ? totalTokens : null,
    recentReplyTokensPerSecond: recentReply?.rate ?? null,
    context,
    coverage: !hasEvent ? "unavailable" : partial ? "partial" : "complete",
  };
}

function newerEvent(
  prior: { readonly ts: string; readonly runId: string; readonly seq: number } | undefined,
  next: { readonly ts: string; readonly runId: string; readonly seq: number },
): boolean {
  return !prior || next.ts > prior.ts || (next.ts === prior.ts && next.runId === prior.runId && next.seq > prior.seq);
}

function forEachRunEvent(store: RunStore, runId: string, consume: (event: RunEventEnvelope) => void): void {
  let afterSeq = 0;
  for (;;) {
    const page = store.listEvents(runId, { afterSeq, limit: 1000 });
    for (const event of page) {
      if (event.runId !== runId || event.seq <= afterSeq) throw new Error(`Run event cursor did not advance: ${runId}`);
      consume(event);
      afterSeq = event.seq;
    }
    if (page.length < 1000) break;
  }
}

function matchesOwner(thread: LingThread, entity: LingTurn | RunSession): boolean {
  if (thread.kind === "conversation") return !entity.channelId && !entity.workflowStepId &&
    (!entity.teammateId || entity.teammateId === thread.teammateId || entity.teammateId === "ling_agent");
  if (thread.kind === "teammate_direct") return Boolean(thread.teammateId) &&
    entity.teammateId === thread.teammateId && !entity.channelId && !entity.workflowStepId;
  if (thread.kind === "channel_discussion") return Boolean(thread.channelId) &&
    entity.channelId === thread.channelId && !entity.workflowStepId;
  return false;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function positiveTokenCount(value: unknown): number | undefined {
  const count = tokenCount(value);
  return count && count > 0 ? count : undefined;
}

function validUsage(value: unknown): value is {
  readonly input: number; readonly output: number; readonly cacheRead: number;
  readonly cacheWrite: number; readonly totalTokens: number;
} {
  const usage = readRecord(value);
  return Boolean(usage && tokenCount(usage.input) !== undefined && tokenCount(usage.output) !== undefined &&
    tokenCount(usage.cacheRead) !== undefined && tokenCount(usage.cacheWrite) !== undefined &&
    tokenCount(usage.totalTokens) !== undefined);
}
