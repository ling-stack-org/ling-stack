import { createHash } from "node:crypto";
import type {
  CommitConversationContextSummaryResult,
  ConversationContextSummarySourceFence,
  RunStore,
} from "@ling-stack/core";
import type {
  CompactionCheckpoint,
  ConversationContextSummary,
  ConversationDomainRef,
  ConversationItemV1,
} from "@ling-stack/contracts";
import { estimateTextTokens } from "../context-packs.js";
import {
  buildConversationContextProjection,
  type ConversationContextProjection,
} from "./conversation-context-projector.js";

export const CONVERSATION_SUMMARY_POLICY_VERSION = "continuity-v2-summary-v1";

export interface ConversationSummaryPolicy {
  readonly softCompletedTurnCount: number;
  readonly softInputBudgetRatio: number;
  readonly hardInputBudgetRatio: number;
  readonly targetInputBudgetRatio: number;
  readonly rawTailCompletedTurnCount: number;
  readonly generationChunkBudgetRatio: number;
}

export const DEFAULT_CONVERSATION_SUMMARY_POLICY: ConversationSummaryPolicy = {
  softCompletedTurnCount: 32,
  softInputBudgetRatio: 0.3,
  hardInputBudgetRatio: 0.7,
  targetInputBudgetRatio: 0.55,
  rawTailCompletedTurnCount: 8,
  generationChunkBudgetRatio: 0.25,
};

export interface ConversationSummaryDraft {
  readonly objective?: string;
  readonly decisions: readonly string[];
  readonly constraints: readonly string[];
  readonly openQuestions: readonly string[];
}

export interface GenerateConversationSummaryInput {
  readonly current: ConversationSummaryDraft;
  readonly items: readonly ConversationItemV1[];
  readonly sourceRefs: readonly ConversationDomainRef[];
  readonly chunkIndex: number;
  readonly chunkCount: number;
  readonly chunkTokenBudget: number;
  readonly outputTokenBudget: number;
  readonly signal?: AbortSignal;
}

export type GenerateConversationSummary = (
  input: GenerateConversationSummaryInput,
) => Promise<ConversationSummaryDraft>;

export interface ConversationSummaryPlan {
  readonly trigger: "soft" | "hard";
  readonly projection: ConversationContextProjection;
  readonly activeSummary?: ConversationContextSummary;
  readonly sourceItems: readonly ConversationItemV1[];
  readonly sourceFence: readonly ConversationContextSummarySourceFence[];
  readonly sourceRefs: readonly ConversationDomainRef[];
  readonly activeWorkRefs: readonly ConversationDomainRef[];
  readonly coveredFromSequence: number;
  readonly coveredThroughSequence: number;
  readonly inputBudgetTokens: number;
  readonly estimatedRawTokens: number;
  readonly estimatedRawTailTokens: number;
  readonly estimatedProjectionTokens: number;
  readonly targetExceededByRequiredTail: boolean;
  readonly chunkTokenBudget: number;
  readonly summaryTokenBudget: number;
}

export interface ConversationSummaryPlanningInput {
  readonly store: RunStore;
  readonly sourceItemId: string;
  readonly inputBudgetTokens: number;
  readonly policy?: ConversationSummaryPolicy;
}

export interface ConversationSummaryUnavailablePrefix {
  readonly status: "no_eligible_prefix";
  readonly trigger: "soft" | "hard";
  readonly sourceItemId: string;
  readonly threadId: string;
  readonly segmentId: string;
  readonly inputBudgetTokens: number;
  readonly estimatedProjectionTokens: number;
}

/** Maintenance assessment only; neither threshold nor projection size proves final request capacity. */
export type ConversationSummaryAssessment =
  | { readonly status: "not_needed" }
  | ConversationSummaryUnavailablePrefix
  | { readonly status: "ready"; readonly plan: ConversationSummaryPlan };

type CommittedSummary = Extract<CommitConversationContextSummaryResult, { readonly status: "committed" }>;
type DiscardedSummary = Extract<CommitConversationContextSummaryResult, { readonly status: "discarded_stale" }>;

export type CoordinateConversationSummaryResult =
  | { readonly status: "not_needed" }
  | ConversationSummaryUnavailablePrefix
  | { readonly status: "generator_unavailable"; readonly plan: ConversationSummaryPlan }
  | { readonly status: "cancelled"; readonly plan: ConversationSummaryPlan; readonly error: unknown }
  | { readonly status: "generation_failed"; readonly plan: ConversationSummaryPlan; readonly error: unknown }
  | { readonly status: "source_conflict"; readonly plan: ConversationSummaryPlan; readonly commit: DiscardedSummary }
  | { readonly status: "checkpoint_failed"; readonly plan: ConversationSummaryPlan; readonly commit: CommittedSummary; readonly error: unknown }
  | { readonly status: "completed"; readonly plan: ConversationSummaryPlan; readonly commit: CommittedSummary; readonly checkpoint: CompactionCheckpoint };

/** Plan-only maintenance query. Missing work is not a not_needed or safe-to-dispatch verdict. */
export function planConversationContextSummary(input: ConversationSummaryPlanningInput): ConversationSummaryPlan | undefined {
  const assessment = assessConversationContextSummary(input);
  return assessment.status === "ready" ? assessment.plan : undefined;
}

/** Preserve why planning cannot produce work; never drop a protected tail to fabricate a prefix. */
export function assessConversationContextSummary(input: ConversationSummaryPlanningInput): ConversationSummaryAssessment {
  const policy = input.policy ?? DEFAULT_CONVERSATION_SUMMARY_POLICY;
  assertValidPolicy(policy);
  if (!Number.isSafeInteger(input.inputBudgetTokens) || input.inputBudgetTokens < 1_024) {
    throw new RangeError(`Invalid conversation summary input budget: ${input.inputBudgetTokens}`);
  }
  const projection = buildConversationContextProjection({
    store: input.store,
    sourceItemId: input.sourceItemId,
    view: "reply",
    maxTailTextChars: 256_000,
  });
  const activeSummary = projection.summaries.find((summary) =>
    summary.scope === "segment" && summary.segmentId === projection.segment.id);
  const unsummarizedItems = input.store.listConversationItemsForSegment({
    threadId: projection.metadata.threadId,
    segmentId: projection.metadata.segmentId,
    throughSequence: projection.metadata.throughItemSequence,
    afterSequence: activeSummary?.coveredThroughSequence ?? 0,
    order: "oldest",
    limit: 500,
  }).filter(isSharedSummaryItem);
  const eligibleItems = stableCompletedPrefix(input.store, unsummarizedItems);
  const completedTurnIds = completedTurnIdsInOrder(eligibleItems);
  const estimatedRawTokens = estimateItemsTokens(eligibleItems);
  const estimatedProjectionTokens = estimateProjectionTokens(projection);
  const hard = estimatedProjectionTokens > input.inputBudgetTokens * policy.hardInputBudgetRatio;
  const soft = completedTurnIds.length >= policy.softCompletedTurnCount
    || estimatedRawTokens > input.inputBudgetTokens * policy.softInputBudgetRatio;
  if (!hard && !soft) return { status: "not_needed" };

  const rawTailTurnIds = new Set(completedTurnIds.slice(-policy.rawTailCompletedTurnCount));
  const sourceItems = eligibleItems.filter((item) => item.turnId && !rawTailTurnIds.has(item.turnId));
  if (sourceItems.length === 0) return {
    status: "no_eligible_prefix",
    trigger: hard ? "hard" : "soft",
    sourceItemId: input.sourceItemId,
    threadId: projection.metadata.threadId,
    segmentId: projection.metadata.segmentId,
    inputBudgetTokens: input.inputBudgetTokens,
    estimatedProjectionTokens,
  };
  const sourceFence = sourceItems.map((item) => buildSourceFence(input.store, item));
  const sourceRefs = uniqueDomainRefs([
    ...(activeSummary ? [{ type: "context_summary" as const, id: activeSummary.id }] : []),
    ...sourceItems.map((item) => ({ type: "conversation_item" as const, id: item.id })),
  ]);
  const activeWorkRefs = uniqueDomainRefs([
    ...(activeSummary?.activeWorkRefs ?? []),
    ...sourceItems.flatMap((item) => item.domainRefs.filter(isActiveWorkRef)),
  ]);
  const estimatedRawTailTokens = estimateItemsTokens(
    eligibleItems.filter((item) => item.turnId && rawTailTurnIds.has(item.turnId)),
  );
  const summaryTokenBudget = Math.max(
    128,
    Math.floor(input.inputBudgetTokens * policy.targetInputBudgetRatio) - estimatedRawTailTokens,
  );
  const plan: ConversationSummaryPlan = {
    trigger: hard ? "hard" : "soft",
    projection,
    ...(activeSummary ? { activeSummary } : {}),
    sourceItems,
    sourceFence,
    sourceRefs,
    activeWorkRefs,
    coveredFromSequence: activeSummary?.coveredFromSequence ?? sourceItems[0]!.sequence,
    coveredThroughSequence: sourceItems.at(-1)!.sequence,
    inputBudgetTokens: input.inputBudgetTokens,
    estimatedRawTokens,
    estimatedRawTailTokens,
    estimatedProjectionTokens,
    targetExceededByRequiredTail: estimatedRawTailTokens > input.inputBudgetTokens * policy.targetInputBudgetRatio,
    chunkTokenBudget: Math.max(1_024, Math.floor(input.inputBudgetTokens * policy.generationChunkBudgetRatio)),
    summaryTokenBudget,
  };
  return { status: "ready", plan };
}

export async function coordinateConversationContextSummary(input: {
  readonly store: RunStore;
  readonly sourceItemId: string;
  readonly inputBudgetTokens: number;
  readonly generate?: GenerateConversationSummary;
  readonly policy?: ConversationSummaryPolicy;
  readonly now?: string;
}): Promise<CoordinateConversationSummaryResult> {
  const assessment = assessConversationContextSummary(input);
  if (assessment.status !== "ready") return assessment;
  return executeConversationSummaryPlan({
    store: input.store,
    plan: assessment.plan,
    generate: input.generate,
    now: input.now,
  });
}

export async function executeConversationSummaryPlan(input: {
  readonly store: RunStore;
  readonly plan: ConversationSummaryPlan;
  readonly generate?: GenerateConversationSummary;
  readonly now?: string;
  readonly signal?: AbortSignal;
}): Promise<CoordinateConversationSummaryResult> {
  const { plan } = input;
  if (input.signal?.aborted) return { status: "cancelled", plan, error: summaryAbortReason(input.signal) };
  if (!input.generate) return { status: "generator_unavailable", plan };
  let draft = normalizeDraft(draftFromSummary(plan.activeSummary), plan.summaryTokenBudget);
  const chunks = chunkSummaryItems(plan.sourceItems, plan.chunkTokenBudget);
  try {
    for (let index = 0; index < chunks.length; index += 1) {
      throwIfSummaryAborted(input.signal);
      const chunk = chunks[index]!;
      draft = normalizeDraft(await input.generate({
        current: draft,
        items: chunk,
        sourceRefs: uniqueDomainRefs([
          ...(plan.activeSummary
            ? [{ type: "context_summary" as const, id: plan.activeSummary.id }]
            : []),
          ...chunk.map((item) => ({ type: "conversation_item" as const, id: item.id })),
        ]),
        chunkIndex: index,
        chunkCount: chunks.length,
        chunkTokenBudget: plan.chunkTokenBudget,
        outputTokenBudget: plan.summaryTokenBudget,
        signal: input.signal,
      }), plan.summaryTokenBudget);
    }
    throwIfSummaryAborted(input.signal);
  } catch (error) {
    return { status: input.signal?.aborted ? "cancelled" : "generation_failed", plan, error };
  }
  const commit = input.store.commitConversationContextSummary({
    threadId: plan.projection.metadata.threadId,
    segmentId: plan.projection.metadata.segmentId,
    scope: "segment",
    coveredFromSequence: plan.coveredFromSequence,
    coveredThroughSequence: plan.coveredThroughSequence,
    objective: draft.objective,
    decisions: draft.decisions,
    constraints: draft.constraints,
    openQuestions: draft.openQuestions,
    activeWorkRefs: plan.activeWorkRefs,
    sourceRefs: plan.sourceRefs,
    policyVersion: CONVERSATION_SUMMARY_POLICY_VERSION,
    projectionVersion: plan.projection.metadata.projectionVersion,
    visibilityFingerprint: plan.projection.metadata.visibilityFingerprint,
    expectedActiveSummaryId: plan.activeSummary?.id ?? null,
    sourceFence: plan.sourceFence,
  }, input.now ?? new Date().toISOString());
  if (commit.status !== "committed") return { status: "source_conflict", plan, commit };
  const sourceTurnIds = [...new Set(plan.sourceItems.flatMap((item) => item.turnId ? [item.turnId] : []))];
  let checkpoint: CompactionCheckpoint;
  try {
    checkpoint = input.store.createCompactionCheckpoint({
      threadId: plan.projection.metadata.threadId,
      channelId: plan.sourceItems.find((item) => item.channelId)?.channelId,
      sourceTurnId: plan.projection.metadata.turnId,
      contextViewId: plan.projection.metadata.contextViewId,
      contextViewCreatedAt: plan.projection.metadata.contextViewCreatedAt,
      coveredItemSeqFrom: plan.coveredFromSequence,
      coveredItemSeqTo: plan.coveredThroughSequence,
      coveredTurnIds: sourceTurnIds.length > 0 ? sourceTurnIds : [plan.projection.metadata.turnId],
      summaryIds: [commit.summary.id, ...(plan.activeSummary ? [plan.activeSummary.id] : [])],
      summaryContentSha256: hashSummaryContent(commit.summary),
      sourceRefs: plan.sourceRefs,
      workspaceProvenanceWatermark: input.store.getLatestWorkspaceProvenanceWatermark(),
      compactionPolicyVersion: CONVERSATION_SUMMARY_POLICY_VERSION,
      createdAt: input.now ?? new Date().toISOString(),
    });
  } catch (error) {
    // The summary commit is durable evidence, but it is not a recovery
    // authority until the checkpoint install succeeds. Keep the installed
    // checkpoint absent and make the failed boundary explicit to callers.
    return { status: "checkpoint_failed", plan, commit, error };
  }
  return { status: "completed", plan, commit, checkpoint };
}

function throwIfSummaryAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw summaryAbortReason(signal);
}

function summaryAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Conversation summary generation aborted.");
}

function hashSummaryContent(summary: ConversationContextSummary): string {
  return createHash("sha256").update(JSON.stringify({
    objective: summary.objective ?? null,
    decisions: summary.decisions,
    constraints: summary.constraints,
    openQuestions: summary.openQuestions,
    activeWorkRefs: summary.activeWorkRefs,
    sourceRefs: summary.sourceRefs,
  }), "utf8").digest("hex");
}

function stableCompletedPrefix(store: RunStore, items: readonly ConversationItemV1[]): ConversationItemV1[] {
  const stable: ConversationItemV1[] = [];
  const terminalByTurnId = new Map<string, boolean>();
  for (const item of items) {
    if (!item.turnId) break;
    let terminal = terminalByTurnId.get(item.turnId);
    if (terminal === undefined) {
      const turn = store.getLingTurn(item.turnId);
      terminal = Boolean(turn && (
        turn.status === "succeeded"
        || turn.status === "failed"
        || turn.status === "cancelled"
        || turn.status === "superseded"
      ));
      terminalByTurnId.set(item.turnId, terminal);
    }
    if (!terminal) break;
    stable.push(item);
  }
  return stable;
}

function completedTurnIdsInOrder(items: readonly ConversationItemV1[]): string[] {
  const completed = new Set<string>();
  for (const item of items) {
    if (!item.turnId || completed.has(item.turnId)) continue;
    completed.add(item.turnId);
  }
  return [...completed];
}

function buildSourceFence(store: RunStore, item: ConversationItemV1): ConversationContextSummarySourceFence {
  if (!item.turnId) throw new Error(`Conversation summary item has no owning turn: ${item.id}`);
  const assignment = store.getEffectiveTurnContextAssignment(item.turnId);
  if (!assignment) throw new Error(`Conversation summary turn has no context assignment: ${item.turnId}`);
  return {
    itemId: item.id,
    sequence: item.sequence,
    revision: item.revision,
    updatedAt: item.updatedAt,
    visibility: item.visibility,
    ...(item.visibilityOwnerId ? { visibilityOwnerId: item.visibilityOwnerId } : {}),
    turnId: item.turnId,
    assignmentId: assignment.id,
    assignmentRevision: assignment.revision,
  };
}

function chunkSummaryItems(items: readonly ConversationItemV1[], tokenBudget: number): ConversationItemV1[][] {
  const chunks: ConversationItemV1[][] = [];
  let current: ConversationItemV1[] = [];
  let used = 0;
  for (const item of items) {
    const tokens = estimateTextTokens(renderSummaryItem(item));
    if (current.length > 0 && used + tokens > tokenBudget) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += tokens;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function renderSummaryItem(item: ConversationItemV1, tokenBudget?: number): string {
  const text = itemText(item).replace(/\s+/gu, " ").trim();
  const rendered = `[${item.sequence}] ${item.actorType} ${item.kind} ${item.id}: ${text}`;
  return tokenBudget ? truncateTextToTokenBudget(rendered, tokenBudget) : rendered;
}

function itemText(item: ConversationItemV1): string {
  switch (item.kind) {
    case "user_input_request":
    case "user_input_answer":
      // U1 stores references only; U2 must hydrate content under consumer scope.
      return "[User-input reference only; not answer content, permission or execution evidence.]";
    case "user_message":
    case "assistant_message":
      return item.payload.body;
    case "tool_call":
      return item.payload.inputSummary ?? item.payload.title ?? item.payload.toolName;
    case "tool_result":
      return item.payload.outputSummary ?? item.payload.errorCode ?? item.payload.status;
    case "approval_request":
      return item.payload.summary ?? item.payload.title;
    case "approval_decision":
      return item.payload.reason ?? item.payload.decision;
    case "handoff":
      return item.payload.summary;
    case "operation_state":
      return item.payload.summary ?? item.payload.title;
    case "artifact_ref":
      return item.payload.title ?? item.payload.artifactId;
    case "terminal_report":
      return item.payload.outcomeStatus;
    case "system_event":
      return item.payload.summary;
  }
}

function estimateItemsTokens(items: readonly ConversationItemV1[]): number {
  return items.reduce((total, item) => total + estimateTextTokens(renderSummaryItem(item)), 0);
}

function estimateProjectionTokens(projection: ConversationContextProjection): number {
  return estimateItemsTokens(projection.items.filter(isSharedSummaryItem))
    + projection.summaries.reduce((total, summary) => total + estimateTextTokens(JSON.stringify({
      objective: summary.objective,
      decisions: summary.decisions,
      constraints: summary.constraints,
      openQuestions: summary.openQuestions,
      activeWorkRefs: summary.activeWorkRefs,
    })), 0);
}

function draftFromSummary(summary: ConversationContextSummary | undefined): ConversationSummaryDraft {
  return {
    ...(summary?.objective ? { objective: summary.objective } : {}),
    decisions: summary?.decisions ?? [],
    constraints: summary?.constraints ?? [],
    openQuestions: summary?.openQuestions ?? [],
  };
}

function normalizeDraft(
  draft: ConversationSummaryDraft,
  tokenBudget: number,
): ConversationSummaryDraft {
  const normalized = {
    ...(draft.objective?.trim() ? { objective: draft.objective.trim().slice(0, 2_000) } : {}),
    decisions: normalizeStrings(draft.decisions, 100),
    constraints: normalizeStrings(draft.constraints, 100),
    openQuestions: normalizeStrings(draft.openQuestions, 100),
  };
  const fieldBudget = Math.max(16, Math.floor(tokenBudget * 0.2));
  return {
    ...(normalized.objective
      ? { objective: truncateTextToTokenBudget(normalized.objective, fieldBudget) }
      : {}),
    decisions: fitStringsToTokenBudget(normalized.decisions, fieldBudget),
    constraints: fitStringsToTokenBudget(normalized.constraints, fieldBudget),
    openQuestions: fitStringsToTokenBudget(normalized.openQuestions, fieldBudget),
  };
}

function normalizeStrings(values: readonly string[], limit: number): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .slice(0, limit)
    .map((value) => value.slice(0, 2_000));
}

function fitStringsToTokenBudget(values: readonly string[], tokenBudget: number): string[] {
  const fitted: string[] = [];
  let remaining = tokenBudget;
  for (const value of values) {
    if (remaining <= 0) break;
    const fittedValue = truncateTextToTokenBudget(value, remaining);
    if (!fittedValue) break;
    fitted.push(fittedValue);
    remaining -= estimateTextTokens(fittedValue);
  }
  return fitted;
}

function truncateTextToTokenBudget(value: string, tokenBudget: number): string {
  if (tokenBudget < 1) return "";
  if (estimateTextTokens(value) <= tokenBudget) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTextTokens(value.slice(0, middle)) <= tokenBudget) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return value.slice(0, low).trimEnd();
}

function isSharedSummaryItem(item: ConversationItemV1): boolean {
  return item.status === "committed"
    && Boolean(item.turnId)
    && (item.visibility === "channel" || item.visibility === "thread_participants");
}

function isActiveWorkRef(ref: ConversationDomainRef): boolean {
  return ref.type === "run"
    || ref.type === "task"
    || ref.type === "workflow"
    || ref.type === "workflow_step"
    || ref.type === "approval"
    || ref.type === "artifact"
    || ref.type === "handoff"
    || ref.type === "operation"
    || ref.type === "external_work"
    || ref.type === "automation";
}

function uniqueDomainRefs(refs: readonly ConversationDomainRef[]): ConversationDomainRef[] {
  const byKey = new Map<string, ConversationDomainRef>();
  for (const ref of refs) byKey.set(`${ref.type}:${ref.id}`, ref);
  return [...byKey.values()];
}

function assertValidPolicy(policy: ConversationSummaryPolicy): void {
  if (!Number.isSafeInteger(policy.softCompletedTurnCount) || policy.softCompletedTurnCount < 1) {
    throw new RangeError("Conversation summary soft turn count must be a positive integer.");
  }
  if (!Number.isSafeInteger(policy.rawTailCompletedTurnCount) || policy.rawTailCompletedTurnCount < 1) {
    throw new RangeError("Conversation summary raw tail count must be a positive integer.");
  }
  for (const [name, value] of [
    ["softInputBudgetRatio", policy.softInputBudgetRatio],
    ["hardInputBudgetRatio", policy.hardInputBudgetRatio],
    ["targetInputBudgetRatio", policy.targetInputBudgetRatio],
    ["generationChunkBudgetRatio", policy.generationChunkBudgetRatio],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0 || value >= 1) {
      throw new RangeError(`Conversation summary ${name} must be between 0 and 1.`);
    }
  }
}
