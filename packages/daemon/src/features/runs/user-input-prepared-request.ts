import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";
import { isDelegatedStepRequirementV1, isWorkflowParticipantProviderBindingV1 } from "@ling-stack/contracts";
import { redactSecrets, type RunSession, type RunStore, type UserInputContinuationClaim, type UserInputContinuationSeed } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { isRecord } from "../../shared/validation.js";
import { inlineProviderDescriptor } from "../conversations/normal-conversation-prepared-provider.js";
import { parseRunRequest, type RunRequest } from "./schemas.js";
import { createWorkflowOperationExecutionSnapshot } from "./workflow-operation-snapshot.js";
import { collectUserInputContinuationEvents, renderUserInputContinuationPrompt, userInputContextHash } from "./user-input-continuation-context.js";
import { readUserInputSourcePolicyIntent } from "./user-input-source-policy.js";
import { readUserInputSourceExecution } from "./user-input-source-execution.js";

export interface UserInputPreparedRequest {
  readonly ref: { readonly id: string; readonly fingerprint: string };
  readonly request: RunRequest;
  readonly createdAt: string;
}
const inheritedKeys = ["tools", "requestedSkillId", "thinkingLevel", "reasoningSummary", "systemPrompt", "appendSystemPrompt", "agentDir",
  "runtimeToolFeatures", "lingConversationTone", "responseLanguage", "skillOptimizationMode"] as const;
const executionKeys = ["tools", "thinkingLevel", "reasoningSummary", "systemPrompt", "appendSystemPrompt", "agentDir", "runtimeToolFeatures"] as const;
const internalKeys = ["providerBinding", "delegatedRequirement", "executionOperationBindings", "workflowOperationExecution",
  "directWorkspaceBinding", "directWorkspaceSnapshot"] as const;

/** Build actual three-surface input from immutable Host facts, never from caller-provided answer text. */
export function prepareUserInputContinuationRequest(store: RunStore, claim: UserInputContinuationClaim, now: string): UserInputPreparedRequest {
  const seed = store.getUserInputContinuationSeed(claim.threadId, claim.deliveryId);
  if (!seed) throw invalidSource();
  const prior = readUserInputContinuationPreparedRequest(store, claim.threadId, claim.deliveryId);
  const request = prior?.request ?? store.readSnapshot(() => buildRequest(store, seed));
  // Even a first-writer replay must prove the worker still owns the claim. No await/transaction gap over I/O.
  const saved = store.saveUserInputContinuationPreparation({ ...claim, stage: "request",
    parentRef: { id: seed.id, fingerprint: seed.fingerprint }, payload: request }, now).snapshot;
  return freeze({ ref: { id: saved.id, fingerprint: saved.fingerprint }, request: saved.payload as RunRequest,
    createdAt: saved.createdAt });
}

/** Reopen is validation of the original source, not selection from current conversation history. */
export function readUserInputContinuationPreparedRequest(store: RunStore, threadId: string, deliveryId: string): UserInputPreparedRequest | undefined {
  const snapshot = store.getUserInputContinuationPreparation(threadId, deliveryId, "request");
  if (!snapshot) return undefined;
  const seed = store.getUserInputContinuationSeed(threadId, deliveryId);
  if (!seed) throw invalidSource();
  const expected = store.readSnapshot(() => buildRequest(store, seed));
  if (!isDeepStrictEqual(snapshot.payload, expected)) throw new HttpError(409, "user_input_prepared_request_changed",
    "Prepared continuation input no longer matches its immutable source; it was not regenerated.");
  return freeze({ ref: { id: snapshot.id, fingerprint: snapshot.fingerprint }, request: snapshot.payload as RunRequest,
    createdAt: snapshot.createdAt });
}

function buildRequest(store: RunStore, seed: UserInputContinuationSeed): RunRequest {
  const source = store.getRun(seed.source.runId), s = seed.source;
  if (!source || source.threadId !== s.threadId || source.taskId !== s.taskBinding.taskId || source.cwd !== s.cwd
    || source.channelId !== s.channelId || (source.teammateId ?? "ling_agent") !== s.participantId
    || source.workflowStepId !== s.workflowStepId || !isRecord(source.requestSnapshot)) throw invalidSource();
  const snapshot = source.requestSnapshot;
  const unit = store.getWorkUnit(s.fence.workUnitId);
  if (!unit || unit.workspaceId !== s.workspaceId
    || snapshot.workspaceCwd !== undefined && (typeof snapshot.workspaceCwd !== "string" || resolve(snapshot.workspaceCwd) !== store.paths.cwd)
    || snapshot.linkedMessageId !== undefined && snapshot.linkedMessageId !== unit.linkedMessageId) throw invalidSource();
  const sourcePolicyIntent = readUserInputSourcePolicyIntent(snapshot);
  const task = isRecord(snapshot.task) ? snapshot.task : source.taskSnapshot;
  if (!isRecord(task) || task.id !== source.taskId || typeof task.title !== "string" || !task.title.trim()
    || typeof task.prompt !== "string" || !task.prompt.trim() || task.channelId !== s.channelId) throw invalidSource();
  for (const [key, value] of Object.entries({ cwd: s.cwd, threadId: s.threadId, turnId: s.turnId,
    teammateId: s.participantId, workflowStepId: s.workflowStepId })) {
    if (snapshot[key] !== undefined && snapshot[key] !== value) throw invalidSource();
  }
  const inherited = Object.fromEntries(inheritedKeys.filter(key => snapshot[key] !== undefined).map(key => [key, snapshot[key]]));
  const execution = readUserInputSourceExecution(store, source, seed);
  // Actual SDK input wins even when a raw request field was later enriched or
  // omitted by preparation. Undefined must not resurrect an old request value.
  const effective = Object.fromEntries(executionKeys.map(key => [key, execution.input[key]]));
  const providerPresetId = source.providerPresetId;
  if (snapshot.providerPresetId !== undefined && snapshot.providerPresetId !== providerPresetId) throw invalidSource();
  const rawProvider = isRecord(snapshot.provider) ? snapshot.provider : source.providerSnapshot;
  if (!providerPresetId && (!isRecord(rawProvider) || typeof rawProvider.provider !== "string" || typeof rawProvider.model !== "string")) throw invalidSource();
  if (isRecord(rawProvider) && (rawProvider.provider !== source.providerName || rawProvider.model !== source.providerModel)) throw invalidSource();
  const provider = providerPresetId ? undefined : inlineProviderDescriptor(execution.input.provider);
  const internal = inheritInternalContext(store, source, snapshot);
  const base = {
    ...inherited, ...effective, ...internal, cwd: s.cwd,
    workspaceCwd: store.paths.cwd,
    providerPresetId, provider, threadId: s.threadId, turnId: s.turnId, teammateId: s.participantId, workflowStepId: s.workflowStepId,
    runnerId: execution.runnerId,
    task: { ...execution.input.task },
    preselectedMemoryUse: execution.usedMemory,
    requestedSkillId: inherited.requestedSkillId ?? source.selectedSkillId,
  };
  // Reuse public field parsers for syntax only, before adding Host-only lineage. No old permission/approval is inherited.
  try { parseRunRequest(base); } catch { throw invalidSource(); }
  const events = collectUserInputContinuationEvents(store, seed);
  const safeBase = redactSecrets(base) as typeof base;
  const request = json({ ...safeBase, task: { ...base.task, prompt: renderUserInputContinuationPrompt(execution.input.task.prompt, seed, events) },
    sourceMessageId: s.itemId, ...(unit.linkedMessageId ? { linkedMessageId: unit.linkedMessageId } : {}),
    createdByActor: "system", parentRunId: source.id, continuationReason: "user_input_answer",
    idempotencyKey: "user_input_delivery:" + seed.deliveryId, skipMemoryRecall: true,
    contextProjection: seed.projection,
    userInputContinuationContext: { schemaVersion: 1, seedRef: { id: seed.id, fingerprint: seed.fingerprint }, sourceRunId: source.id,
      sourceInputFingerprint: userInputContextHash({ input: safeBase, sourcePolicyIntent, originalRequest: redactSecrets({ task, inherited }) }), sourcePolicyIntent,
      sourceExecutionInputFingerprint: userInputContextHash(execution),
      throughEventSequence: seed.checkpoint.quiescence.lastRunEventSeq,
      eventRefs: events.map(event => ({ id: event.id, seq: event.seq, fingerprint: userInputContextHash(event) })) },
  });
  return freeze(request) as unknown as RunRequest;
}

/** Preserve exact workflow requirements, never silently downgrade broken typed metadata. */
function inheritInternalContext(store: RunStore, source: RunSession, snapshot: Record<string, unknown>): Record<string, unknown> {
  const hasWorkflowInput = ["providerBinding", "delegatedRequirement", "executionOperationBindings", "workflowOperationExecution"]
    .some(key => snapshot[key] !== undefined);
  if (!source.workflowStepId && hasWorkflowInput) throw invalidSource();
  if (source.workflowStepId) {
    const step = store.getChannelWorkflowStep(source.workflowStepId);
    if (!step || step.toParticipantId !== (source.teammateId ?? "ling_agent") || step.channelId !== source.channelId) throw invalidSource();
    if (snapshot.providerBinding !== undefined && (!isWorkflowParticipantProviderBindingV1(snapshot.providerBinding)
      || snapshot.providerBinding.participantId !== step.toParticipantId
      || snapshot.providerBinding.providerPresetId !== source.providerPresetId
      || !isDeepStrictEqual(snapshot.providerBinding, step.metadata?.providerBinding))) throw invalidSource();
    if (snapshot.delegatedRequirement !== undefined || step.metadata?.delegatedRequirement !== undefined) {
      if (!isDelegatedStepRequirementV1(snapshot.delegatedRequirement)
        || !isDeepStrictEqual(snapshot.delegatedRequirement, step.metadata?.delegatedRequirement)) throw invalidSource();
    }
    // The current Run pointer changes on admission, but the full accepted plan/ownership must not change.
    let expected: ReturnType<typeof createWorkflowOperationExecutionSnapshot>;
    try { expected = createWorkflowOperationExecutionSnapshot(step); } catch { throw invalidSource(); }
    if (!isDeepStrictEqual(snapshot.workflowOperationExecution, expected)) throw invalidSource();
    if (expected && !isDeepStrictEqual(snapshot.executionOperationBindings,
      expected.plan.operations.filter(operation => expected.ownedOperationIds.includes(operation.id)))) throw invalidSource();
  }
  return Object.fromEntries(internalKeys.filter(key => snapshot[key] !== undefined).map(key => [key, snapshot[key]]));
}
function invalidSource(): HttpError { return new HttpError(409, "user_input_source_request_invalid", "The original continuation request is missing, malformed, or owned by another participant."); }
function json<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function freeze<T>(value: T): T { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
