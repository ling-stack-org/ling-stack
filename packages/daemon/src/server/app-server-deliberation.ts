import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  LING_APP_SERVER_DECISION_MATERIALITIES,
  LING_APP_SERVER_DELIBERATION_CHECKPOINTS,
  LING_APP_SERVER_DELIBERATION_DECISION_KINDS,
  type LingAppServerCoordinationDecisionParams,
  type LingAppServerCoordinationDecisionSubmitResult,
  type LingAppServerDeliberationEvaluateParams,
  type LingAppServerDeliberationEvaluateResult,
  type LingAppServerDeliberationEvaluation,
  type LingAppServerDeliberationOpenParams,
  type LingAppServerDeliberationSubject,
  type LingAppServerVerifyOperation,
  type LingAppServerVerifyPlanResult,
  type LingAppServerWorkItemCollaborationAppendResult,
} from "@ling-stack/contracts";
import {
  appendWorkItemCollaboration,
  automationDefinitionDigestInput,
  automationEventDigest,
  deliberationWorkflowStepDigest,
  readWorkItemCollaborationRecord,
  readWorkflowStageHandoff,
  type AppendWorkItemCollaborationInput,
  type ChannelWorkflowStep,
  type ControlPlaneEvent,
  type PendingScheduledCoordinationDecision,
  type ScheduledCoordinationDecisionRequest,
  type RunStore,
  type WorkItem,
  type WorkItemCollaborationRecord,
  type WorkItemConversationBinding,
  type WorkItemDeliberationTarget,
  type WorkItemDeliberationWorkflowBinding,
  type WorkItemEvidenceEntry,
} from "@ling-stack/core";
import { z } from "zod";
import type { DaemonContext } from "../context.js";
import { HttpError } from "../errors.js";
import { listEffectiveChannelAiTeammates } from "../features/channels/channel-teammate-availability.js";
import { preparePlanShaping, type PlanShapingRuntime } from "../features/channels/plan-deliberation-shaping.js";
import { materializeDeliberationWorkflow, readDeliberationWorkflowInputs } from "../features/work-items/deliberation-workflow.js";
import { isRecord } from "../shared/validation.js";
import { readCompleteHandoffCandidate } from "../features/work-items/stage-handoff-candidates.js";
import { readWorkItemWorkflowBinding } from "../features/work-items/workflow-stages.js";
import { defaultDeliberationPolicyRevision, readWorkspaceDeliberationPolicy,
  type AppServerDeliberationPolicy, type AutomaticDeliberationPolicy } from "./app-server-deliberation-config.js";
import { appServerRecoveryFor } from "./app-server-recovery.js";

const evaluationPrefix = "work_item_deliberation_evaluation_";
const roundPrefix = "work_item_deliberation_round_";
const validityMs = 15 * 60_000;
const terminalWorkItemStatuses = new Set(["done", "cancelled", "archived", "superseded"]);
const boundedId = z.string().trim().min(1).max(200).regex(/^[^\r\n\0]+$/u);
const refs = z.array(boundedId).max(12);
const mutationFields = {
  workItemId: boundedId,
  expectedWorkItemRevision: z.number().int().positive(),
  idempotencyKey: boundedId,
};

const workflowStageSubject = z.object({ kind: z.literal("workflow_stage"), workflowStepId: boundedId, planRevision: boundedId });
const decisionFields = {
  decisionKey: boundedId,
  decisionKind: z.enum(LING_APP_SERVER_DELIBERATION_DECISION_KINDS),
  materiality: z.enum(LING_APP_SERVER_DECISION_MATERIALITIES),
  question: z.string().trim().min(1).max(1200),
  participantIds: refs,
  optionRefs: refs,
  evidenceRefs: refs,
  decisionStepId: boundedId.optional(),
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  unresolved: z.enum(["intent", "fact", "handoff"]).optional(),
};

export const deliberationEvaluateInput = z.object({
  ...mutationFields, ...decisionFields,
  subject: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("draft_plan"), planId: boundedId, planRevision: z.number().int().positive() }),
    workflowStageSubject,
  ]),
  checkpoint: z.enum(LING_APP_SERVER_DELIBERATION_CHECKPOINTS),
  checkpointRef: boundedId,
  requestKind: z.literal("manual_request").optional(),
});

export const coordinationDecisionInput = z.strictObject({
  ...mutationFields, ...decisionFields, roundId: boundedId, subject: workflowStageSubject,
});

export const deliberationOpenInput = z.object({
  ...mutationFields, evaluationId: boundedId, execution: z.enum(["read_only_shaping", "read_only_workflow"]).optional(),
  ballotMode: z.literal("when_unresolved").optional(),
  shapingBudget: z.strictObject({ maxTokens: z.number().int().positive(), maxDurationMs: z.number().int().positive().max(validityMs) }).optional(),
});

interface FrozenEvaluation {
  readonly evaluation: LingAppServerDeliberationEvaluation;
  readonly decision: Omit<LingAppServerDeliberationEvaluateParams, "cwd" | "workItemId" | "expectedWorkItemRevision" | "idempotencyKey">;
  readonly basisDigest: string;
}

interface SubjectBasis {
  readonly channelId?: string;
  readonly decisionAnchor: string;
  readonly subjectRevision: string;
  readonly scopeRevision: string;
  readonly step?: ChannelWorkflowStep;
}

interface DeliberationPolicyContext {
  readonly policies: readonly AppServerDeliberationPolicy[];
  readonly hostTokenBudget?: number;
  readonly assertRecoveryReady: () => void;
}

export function deliberationPolicyContext(config: DaemonContext["config"], store: RunStore): DeliberationPolicyContext {
  const { appServerDeliberationPolicies: policies, harness } = config;
  return {
    policies,
    hostTokenBudget: harness.delegations.mode === "enforce" ? harness.delegations.rootBudget?.tokenBudget : undefined,
    assertRecoveryReady: () => appServerRecoveryFor(config, store)?.assertReady(),
  };
}

type DeliberationDisposition = Pick<LingAppServerDeliberationEvaluation, "outcome" | "reasonCode">;

export function registerCoordinationDecision(store: RunStore, input: LingAppServerCoordinationDecisionParams, now: string,
  cwd: string, policies: readonly AppServerDeliberationPolicy[]): LingAppServerCoordinationDecisionSubmitResult {
  const { cwd: _cwd, expectedWorkItemRevision, ...request } = input;
  const normalized = { ...request, participantIds: sortedUnique(request.participantIds),
    optionRefs: sortedUnique(request.optionRefs), evidenceRefs: sortedUnique(request.evidenceRefs) };
  const result = store.registerScheduledCoordinationDecision(normalized, expectedWorkItemRevision, now, () => {
    const { subject } = readScheduledDecisionInputs(store, normalized, { beforeScheduledClose: true });
    const channelId = subject.channelId!;
    return {
      channelId, policyRevision: readWorkspaceDeliberationPolicy(store, cwd, channelId, policies).effectiveRevision,
    };
  });
  return { cwd, ...result };
}

export function sealCoordinationDecision(store: RunStore, cwd: string, request: ScheduledCoordinationDecisionRequest,
  channelId: string, throughEvidenceSequence: number, policies: readonly AppServerDeliberationPolicy[]) {
  try {
    const basis = readScheduledDecisionInputs(store, request, { throughEvidenceSequence });
    if (basis.subject.channelId !== channelId) return { reasonCode: "decision_basis_changed" };
    return { digest: basis.digest, channelId,
      policyRevision: readWorkspaceDeliberationPolicy(store, cwd, channelId, policies).effectiveRevision };
  } catch (error) {
    if (!(error instanceof HttpError) || !["stale_revision", "resume_blocked"].includes(error.code)) throw error;
    return { reasonCode: "decision_basis_changed" };
  }
}

function readScheduledDecisionInputs(store: RunStore, request: ScheduledCoordinationDecisionRequest,
  checkpointScope: Parameters<typeof readDecisionBasis>[3]) {
  const { workItemId, roundId, idempotencyKey: _key, ...inputs } = request;
  return readDecisionBasis(store, requireWorkItem(store, workItemId),
    { ...inputs, checkpoint: "scheduled_checkpoint", checkpointRef: roundId }, checkpointScope);
}

export async function evaluateAppServerDeliberation(
  store: RunStore, input: LingAppServerDeliberationEvaluateParams, now: string, cwd: string,
  policyContext: DeliberationPolicyContext, scheduled?: PendingScheduledCoordinationDecision,
): Promise<LingAppServerDeliberationEvaluateResult & {
  readonly event?: ControlPlaneEvent;
  readonly admissionEvent?: ControlPlaneEvent;
}> {
  const { workItemId, expectedWorkItemRevision, idempotencyKey, cwd: _cwd, ...requested } = input;
  const item = requireWorkItem(store, workItemId);
  const decision = {
    ...requested, participantIds: sortedUnique(input.participantIds),
    optionRefs: sortedUnique(input.optionRefs), evidenceRefs: sortedUnique(input.evidenceRefs),
  };
  const assertScheduledCurrent = (revision: number) => {
    if (scheduled) assertScheduledDecisionCurrent(store, scheduled, revision, cwd, policyContext);
  };
  const completeScheduledReplay = (evaluation: LingAppServerDeliberationEvaluation) => {
    if (scheduled && !store.settleScheduledCoordinationDecision(scheduled, { evaluationId: evaluation.evaluationId }, now)) {
      throw stale("The scheduled decision changed before replay.");
    }
  };
  const readReplay = () => {
    const prior = readMutationReceipt(store, workItemId, idempotencyKey);
    if (!prior) return undefined;
    const frozen = readEvaluation(prior);
    if (!frozen || !isDeepStrictEqual(frozen.decision, decision)) throw keyConflict();
    completeScheduledReplay(frozen.evaluation);
    return { cwd, evaluation: frozen.evaluation, workItemRevision: requireWorkItem(store, workItemId).revision, replayed: true };
  };
  assertScheduledCurrent(expectedWorkItemRevision);
  const prior = readReplay();
  if (prior) return prior;
  const basis = readDecisionBasis(store, item, decision, scheduled);
  if (scheduled && scheduled.basis.digest !== basis.digest) throw new ScheduledDecisionStale("decision_basis_changed");
  const decisionId = digest([item.id, decision.decisionKey, decision.subject.kind, basis.subject.decisionAnchor,
    ...(decision.decisionStepId ? [decision.decisionStepId] : [])]);
  const decisionRevision = digest([basis.digest, decision.decisionKind, decision.materiality, decision.question, decision.unresolved]);
  if (basis.candidate) {
    await assertCandidateCurrent(basis.candidate);
    assertScheduledCurrent(expectedWorkItemRevision);
    const committed = readReplay();
    if (committed) return committed;
  }
  const settings = policyForSubject(store, cwd, basis.subject, policyContext.policies);
  const policy = settings?.effective;
  const policyRevision = settings?.effectiveRevision ?? defaultDeliberationPolicyRevision;
  const roundId = checkpointRoundId(workItemId, { decisionId, decisionRevision });
  const retainedRound = readWorkItemCollaborationRecord(store, workItemId, roundId);
  const disposition = evaluateCheckpoint(item, basis, decision);
  const policyDisposition: DeliberationDisposition = policy?.mode === "manual" && decision.requestKind !== "manual_request"
    && disposition.outcome === "suggest"
    ? { outcome: "suppress", reasonCode: "manual_policy" } : disposition;
  const automatic: AutomaticDeliberationPolicy | undefined = settings && policy?.mode === "auto_start" && !decision.requestKind
    && policyDisposition.outcome === "suggest" && basis.subject.step && policy.allowedTriggers.includes(decision.checkpoint)
    && policy.allowedDecisionKinds.includes(decision.decisionKind) && LING_APP_SERVER_DECISION_MATERIALITIES.indexOf(decision.materiality)
      >= LING_APP_SERVER_DECISION_MATERIALITIES.indexOf(policy.minDecisionMateriality)
    ? { ...policy, channelId: settings.channelId, revision: policyRevision } : undefined;
  const retainedAdmission = isRecord(retainedRound?.payload) && isRecord(retainedRound.payload.admission)
    && retainedRound.payload.admission.policyRevision === automatic?.revision;
  const autoBlocker = automatic && !retainedRound
    ? automaticDeliberationBlocker(store, item, { basis, decision, decisionId, policy: automatic, policyContext, now }) : undefined;
  const outcome: DeliberationDisposition = autoBlocker ? { outcome: "defer", reasonCode: autoBlocker }
    : automatic && (!retainedRound || retainedAdmission) ? { outcome: "start", reasonCode: "automatic_policy_match" }
      : policyDisposition;
  const evaluationId = `${evaluationPrefix}${decisionId}_${digest([decisionRevision, decision.checkpoint, decision.checkpointRef,
    ...(policyRevision !== defaultDeliberationPolicyRevision ? [policyRevision, outcome, retainedRound && outcome.outcome !== "start" ? roundId : null] : []),
    ...(decision.requestKind ? [decision.requestKind] : [])])}`;
  const existing = readEvaluation(readWorkItemCollaborationRecord(store, workItemId, evaluationId));
  if (existing) {
    completeScheduledReplay(existing.evaluation);
    return { cwd, evaluation: existing.evaluation, workItemRevision: requireWorkItem(store, workItemId).revision, replayed: true };
  }
  if (item.revision !== expectedWorkItemRevision) throw stale("The Work Item revision changed before evaluation.");
  const evaluation: LingAppServerDeliberationEvaluation = {
    evaluationId, decisionId, decisionRevision, subjectRevision: basis.subject.subjectRevision, policyRevision,
    checkpoint: decision.checkpoint, checkpointRef: decision.checkpointRef,
    optionRefs: decision.optionRefs, evidenceRefs: decision.evidenceRefs, participantIds: decision.participantIds,
    ...(decision.decisionStepId ? { decisionStepId: decision.decisionStepId } : {}),
    ...(basis.candidate ? { candidateDigest: basis.candidate.digest } : {}),
    ...(retainedRound || outcome.outcome === "start" ? { existingRoundId: roundId } : {}),
    evaluatedAt: now, expiresAt: new Date(Date.parse(now) + validityMs).toISOString(),
    ...outcome,
  };
  const predecessor = latestEvaluation(store, item.id, decisionId);
  const frozen = { evaluation, decision, basisDigest: basis.digest } satisfies FrozenEvaluation;
  const evidence: AppendWorkItemCollaborationInput = {
    id: evaluationId, workItemId, expectedWorkItemRevision, idempotencyKey,
    kind: "deliberation", action: "created", actorId: "local-user", visibility: "owner",
    payload: frozen,
    ...(predecessor ? { parentRecordId: predecessor.evaluation.evaluationId } : {}),
    sourceRefs: basis.sourceRefs,
    assertCurrent: () => {
      assertScheduledCurrent(expectedWorkItemRevision);
      const current = readDecisionBasis(store, requireWorkItem(store, workItemId), decision, scheduled);
      const policy = policyForSubject(store, cwd, current.subject, policyContext.policies);
      if (current.digest !== basis.digest || (policy?.effectiveRevision ?? defaultDeliberationPolicyRevision) !== policyRevision) {
        throw stale("The decision basis changed before the evaluation committed.");
      }
    },
  };
  if (outcome.outcome === "start" && automatic && !retainedRound) {
    policyContext.assertRecoveryReady();
    const { budget } = automatic;
    const admittedPolicy = { ...automatic, budget: { ...budget, maxTokens: Math.min(budget.maxTokens, policyContext.hostTokenBudget ?? 0) } };
    const deadlineAt = new Date(Date.parse(now) + budget.maxDurationMs).toISOString();
    const round = checkpointRound(frozen, workItemId, roundId, expectedWorkItemRevision + 1, roundId, deadlineAt, basis);
    const result = store.admitWorkItemDeliberationWorkflow({
      workItemId, expectedWorkItemRevision, roundId, evaluation: evidence, scheduledDecision: scheduled,
      assertCurrent: () => {
        assertScheduledCurrent(expectedWorkItemRevision + 1);
        const current = requireWorkItem(store, workItemId);
        const currentBasis = assertEvaluationCurrent(store, current, frozen, now, deadlineAt, { cwd, policies: policyContext.policies });
        const blocker = automaticDeliberationBlocker(store, current,
          { basis: currentBasis, decision, decisionId, policy: automatic, policyContext, now });
        if (blocker) throw new HttpError(409, "resume_blocked", blocker);
        policyContext.assertRecoveryReady();
      },
      compile: () => compileCheckpointWorkflow(store, round, frozen, basis, item.control.generation, now,
        admittedPolicy.ballotMode === "when_unresolved" ? admittedPolicy.ballotMode : undefined, admittedPolicy),
    }, now);
    if (!result) throw stale("The Work Item changed before automatic deliberation admission.");
    return { cwd, evaluation, workItemRevision: result.workItemRevision, replayed: false,
      event: result.evaluationEvent, admissionEvent: result.event };
  }
  const result = scheduled ? store.appendScheduledCoordinationEvaluation(scheduled, evidence, now, cwd)
    : appendWorkItemCollaboration(store, evidence, now, cwd);
  if (!result) throw stale("The Work Item revision changed before the evaluation committed.");
  return { cwd, evaluation, workItemRevision: result.workItemRevision, replayed: false, event: result.event };
}

export async function evaluateScheduledCoordinationDecision(store: RunStore, pending: PendingScheduledCoordinationDecision,
  cwd: string, policyContext: DeliberationPolicyContext) {
  const now = new Date().toISOString();
  const { roundId, idempotencyKey: _key, ...inputs } = pending.request;
  try {
    return await evaluateAppServerDeliberation(store, {
      ...inputs, checkpoint: "scheduled_checkpoint", checkpointRef: roundId,
      expectedWorkItemRevision: pending.expectedWorkItemRevision, idempotencyKey: `coordination-evaluation:${pending.receiptId}`,
    }, now, cwd, policyContext, pending);
  } catch (error) {
    const reasonCode = error instanceof ScheduledDecisionStale ? error.reasonCode
      : error instanceof HttpError && error.code === "stale_revision" ? "decision_basis_changed"
        : error instanceof HttpError && error.code === "idempotency_conflict" ? "evaluation_key_conflict" : undefined;
    if (!reasonCode) throw error;
    store.settleScheduledCoordinationDecision(pending, { reasonCode }, now);
  }
}

class ScheduledDecisionStale extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

function assertScheduledDecisionCurrent(store: RunStore, pending: PendingScheduledCoordinationDecision, expectedRevision: number,
  cwd: string, context: DeliberationPolicyContext): void {
  const item = store.getWorkItem(pending.request.workItemId);
  if (item?.planRevision !== pending.request.subject.planRevision) throw new ScheduledDecisionStale("accepted_plan_changed");
  if (item.control.generation !== pending.controlGeneration) throw new ScheduledDecisionStale("coordination_inputs_changed");
  if (item.revision !== expectedRevision) throw new ScheduledDecisionStale("work_item_revision_changed");
  const round = store.readScheduledCoordinationRound(pending.roundId);
  const schedule = round && store.getAutomationCoordinationSchedule(round.automationId);
  const definition = round && store.getAutomationDefinition(round.automationId);
  if (round?.closedRecordId !== pending.closedRecordId || !schedule?.enabled || schedule.revision !== pending.scheduleRevision
    || !definition || automationEventDigest(automationDefinitionDigestInput(definition)) !== pending.automationDefinitionDigest) {
    throw new ScheduledDecisionStale("coordination_inputs_changed");
  }
  if (readWorkspaceDeliberationPolicy(store, cwd, pending.basis.channelId, context.policies).effectiveRevision !== pending.basis.policyRevision) {
    throw new ScheduledDecisionStale("deliberation_policy_changed");
  }
  if (Date.now() >= Date.parse(pending.closedAt) + validityMs) throw new ScheduledDecisionStale("checkpoint_expired");
  context.assertRecoveryReady();
}

function automaticDeliberationBlocker(store: RunStore, item: WorkItem, input: {
  readonly basis: ReturnType<typeof readDecisionBasis>;
  readonly decision: FrozenEvaluation["decision"];
  readonly decisionId: string;
  readonly policy: AutomaticDeliberationPolicy;
  readonly policyContext: DeliberationPolicyContext;
  readonly now: string;
}): string | undefined {
  const { basis, decision, decisionId, policy, policyContext, now } = input;
  const origin = basis.subject.step;
  if (!origin) return "automatic_stage_unavailable";
  if (basis.optionEntries.length < policy.minimumViableOptions) return "automatic_options_incomplete";
  if (basis.participants.length < policy.minimumParticipants
    || policy.requiredRoleIds.some(role => !basis.participants.some(participant => participant.roleKey === role))) {
    return "automatic_roster_incomplete";
  }
  const lastAdmission = store.getAppServerState("work_item_deliberation_admission", decisionId);
  if (lastAdmission && Date.parse(now) - Date.parse(lastAdmission.updatedAt) < policy.cooldownMs) return "automatic_cooldown";
  if (policy.maxEvidenceAgeMs !== undefined) {
    const timestamps = [...basis.optionEntries, ...basis.evidence].map(entry => entry.updatedAt);
    for (const ref of basis.verificationRefs) {
      const record = store.getAppServerState("verify_operation", ref.id);
      timestamps.push((record?.payload as { operation?: LingAppServerVerifyOperation } | undefined)?.operation?.completedAt ?? "");
    }
    const minimum = Date.parse(now) - policy.maxEvidenceAgeMs;
    if (timestamps.some(timestamp => {
      const time = Date.parse(timestamp);
      return !(time >= minimum && time <= Date.parse(now));
    })) return "automatic_evidence_expired";
  }
  if (store.getWorkItemWorkflowAdmissionBlocker(origin.workflowId)) return "work_item_held";
  const goal = store.getWorkItemWorkflowUsage(item, now)?.goalBudget;
  if (policyContext.hostTokenBudget === undefined || goal?.blocker) return "automatic_budget_unavailable";
  const goalTokens = goal?.tokenBudget === undefined ? Infinity : goal.tokenBudget - goal.accountedTokens - (goal.reservedTokens ?? 0);
  const available = Math.min(policy.budget.maxTokens, policyContext.hostTokenBudget, goalTokens);
  try {
    const { presets } = readDeliberationWorkflowInputs(store, { origin, question: decision.question, participants: basis.participants,
      options: basis.optionEntries, evidence: basis.evidence });
    if (presets.some(({ provider }) => provider.contextWindow === undefined || provider.maxTokens === undefined
      || provider.contextWindow + provider.maxTokens > available)) return "automatic_budget_unavailable";
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return error.code === "plan_mode_workflow_blocked" ? error.code : "automatic_participant_scope_unavailable";
  }
}

export async function openAppServerEvaluatedDeliberation(
  store: RunStore, input: LingAppServerDeliberationOpenParams, now: string, cwd: string,
  shapingRuntime: PlanShapingRuntime & Pick<DeliberationPolicyContext, "policies">,
): Promise<LingAppServerWorkItemCollaborationAppendResult & { readonly event?: ControlPlaneEvent; readonly collectShaping?: (signal: AbortSignal) => Promise<void> }> {
  const { workItemId, evaluationId, expectedWorkItemRevision, idempotencyKey, execution, ballotMode, shapingBudget } = input;
  const item = requireWorkItem(store, workItemId);
  const frozen = readEvaluation(readWorkItemCollaborationRecord(store, workItemId, evaluationId));
  if (!frozen) throw stale("The deliberation evaluation is unavailable.");
  const { evaluation, decision } = frozen;
  const roundId = checkpointRoundId(workItemId, evaluation);
  const readReplay = () => {
    const prior = readMutationReceipt(store, workItemId, idempotencyKey);
    if (prior && prior.id !== roundId) throw keyConflict();
    const existing = prior ?? readWorkItemCollaborationRecord(store, workItemId, roundId);
    if (!existing) return undefined;
    const retained = isRecord(existing.payload) && isRecord(existing.payload.execution) ? existing.payload.execution : undefined;
    const retainedExecution = retained?.kind === "read_only_shaping" ? retained.kind : retained?.workflowId ? "read_only_workflow" : undefined;
    const retainedBallotMode = isRecord(existing.payload) ? existing.payload.ballotMode : undefined;
    if (retainedExecution !== execution || retainedBallotMode !== ballotMode || !isDeepStrictEqual(retained?.budget, shapingBudget)) {
      if (prior) throw keyConflict();
      throw stale("This decision revision was already admitted with a different execution mode.");
    }
    const workItemRevision = requireWorkItem(store, workItemId).revision;
    return { status: "replayed" as const, record: { ...existing, workItemRevision }, workItemRevision };
  };
  const prior = readReplay();
  if (prior) return prior;
  if (evaluation.outcome !== "suggest") throw new HttpError(409, "resume_blocked", "Only a current deliberation suggestion can open a round.");
  if (execution === "read_only_shaping" && decision.subject.kind !== "draft_plan") {
    throw new HttpError(409, "resume_blocked", "Read-only shaping is available only before a draft plan is accepted.");
  }
  if (execution === "read_only_shaping" ? !shapingBudget || ballotMode !== undefined : shapingBudget !== undefined) {
    throw new HttpError(400, "invalid_params", "Supply a shaping budget for a draft consultation without ballots.");
  }
  if ((decision.decisionStepId || ballotMode) && execution !== "read_only_workflow") {
    throw new HttpError(409, "resume_blocked", "This round requires a participant Workflow.");
  }

  const currentPolicy = { cwd, policies: shapingRuntime.policies };
  const assertCurrent = () => assertEvaluationCurrent(store, requireWorkItem(store, workItemId), frozen, now, evaluation.expiresAt, currentPolicy);
  const admission = assertEvaluationCurrent(store, item, frozen, now, evaluation.expiresAt, currentPolicy);
  const { candidate } = admission;
  if (candidate) {
    await assertCandidateCurrent(candidate);
    const committed = readReplay();
    if (committed) return committed;
  }
  const deadlineAt = new Date(Date.parse(now) + (shapingBudget?.maxDurationMs ?? validityMs)).toISOString();
  const round = checkpointRound(frozen, workItemId, roundId, expectedWorkItemRevision, idempotencyKey, deadlineAt, admission);
  if (execution === "read_only_workflow") {
    const result = store.admitWorkItemDeliberationWorkflow({
      workItemId, expectedWorkItemRevision, roundId, assertCurrent,
      compile: () => compileCheckpointWorkflow(store, round, frozen, admission, item.control.generation, now, ballotMode),
    }, now);
    const retained = result ?? readReplay();
    if (!retained) throw stale("The Work Item revision changed before the round opened.");
    return retained;
  }
  const plan = shapingBudget && decision.subject.kind === "draft_plan" ? store.getProposedPlanArtifact(decision.subject.planId) : undefined;
  const planningBinding = plan && store.getAppServerState("work_item_thread", plan.threadId)?.payload as WorkItemConversationBinding | undefined;
  const channel = admission.subject.channelId && store.getChannel(admission.subject.channelId);
  if (shapingBudget && (!plan || !channel || planningBinding?.workItemId !== workItemId)) {
    throw stale("The planning draft lacks a current Work Item and participant channel binding.");
  }
  const shaping = shapingBudget && plan && channel ? preparePlanShaping(store, shapingRuntime, {
    plan, channel, question: decision.question, participants: admission.participants, options: admission.optionEntries,
    evidence: admission.evidence, budget: shapingBudget, policyRevision: evaluation.policyRevision,
  }) : undefined;
  const result = appendWorkItemCollaboration(store, { ...round, assertCurrent,
    payload: { ...round.payload, ...(shaping ? { execution: shaping.frozen } : {}) },
  }, now, cwd);
  if (!result) throw stale("The Work Item revision changed before the round opened.");
  return { ...result, ...(shaping && result.status === "appended" ? { collectShaping: (signal: AbortSignal) => shaping.collect(result.record, deadlineAt, () => {
    assertEvaluationCurrent(store, requireWorkItem(store, workItemId), frozen, new Date().toISOString(), deadlineAt);
  }, signal) } : {}) };
}

function checkpointRoundId(workItemId: string, evaluation: Pick<LingAppServerDeliberationEvaluation, "decisionId" | "decisionRevision">) {
  return roundPrefix + digest([workItemId, evaluation.decisionId, evaluation.decisionRevision]);
}

function checkpointRound({ evaluation, decision }: FrozenEvaluation, workItemId: string, id: string,
  expectedWorkItemRevision: number, idempotencyKey: string, deadlineAt: string, basis: ReturnType<typeof readDecisionBasis>) {
  return {
    id, workItemId, expectedWorkItemRevision, idempotencyKey,
    kind: "deliberation" as const, action: "started" as const, actorId: "local-user", visibility: "owner" as const,
    parentRecordId: evaluation.evaluationId,
    payload: { decisionPoint: decision.question, options: evaluation.optionRefs, subject: decision.subject,
      decisionId: evaluation.decisionId, decisionRevision: evaluation.decisionRevision, deadlineAt,
      ...(basis.candidate ? { candidateDigest: basis.candidate.digest } : {}) },
    sourceRefs: [{ type: "deliberation_evaluation", id: evaluation.evaluationId, revision: evaluation.decisionRevision }],
  };
}

function compileCheckpointWorkflow(store: RunStore, round: ReturnType<typeof checkpointRound>, frozen: FrozenEvaluation,
  admission: ReturnType<typeof readDecisionBasis>, controlGeneration: number, now: string,
  ballotMode?: LingAppServerDeliberationOpenParams["ballotMode"], policy?: AutomaticDeliberationPolicy) {
  const { decision, evaluation } = frozen;
  const { step } = admission.subject;
  if (!step) throw new HttpError(409, "resume_blocked", "A linked deliberation Workflow requires a stage in the accepted Plan.");
  const automatic: WorkItemDeliberationWorkflowBinding["automatic"] = policy && {
    decisionId: evaluation.decisionId, policyRevision: policy.revision, maxTokens: policy.budget.maxTokens,
  };
  const compiled = materializeDeliberationWorkflow(store, {
    binding: { workItemId: round.workItemId, roundId: round.id, originWorkflowId: step.workflowId, originStepId: step.id,
      originStepRevision: step.updatedAt, planRevision: admission.subject.subjectRevision, controlGeneration,
      deadlineAt: round.payload.deadlineAt, candidate: admission.candidate, decisionTarget: admission.decisionTarget, automatic,
      ...(ballotMode ? { ballot: { options: evaluation.optionRefs, evidenceIds: [...evaluation.optionRefs, ...evaluation.evidenceRefs],
        quorum: Math.floor(admission.participants.length / 2) + 1 } } : {}) },
    origin: step, question: decision.question, participants: admission.participants,
    options: admission.optionEntries, evidence: admission.evidence, now,
  });
  const { revision, ...settings } = policy ?? {};
  return { ...compiled, round: {
    ...round, payload: { ...round.payload, execution: { workflowId: compiled.workflow.id }, ...(ballotMode ? { ballotMode } : {}),
      ...(policy ? { admission: { ...settings, policyRevision: revision, decisionActorId: "local-user" } } : {}) },
    sourceRefs: [...round.sourceRefs, { type: "workflow", id: compiled.workflow.id }],
  } };
}

export function isCheckpointDeliberationRecord(record: WorkItemCollaborationRecord): boolean {
  return record.id.startsWith(evaluationPrefix) || record.id.startsWith(roundPrefix) || record.parentRecordId?.startsWith(roundPrefix) === true;
}

function readCurrentRoundBasis(store: RunStore, item: WorkItem, round: WorkItemCollaborationRecord, now: string) {
  if (!round.id.startsWith(roundPrefix)) return;
  const frozen = round.parentRecordId && readEvaluation(readWorkItemCollaborationRecord(store, item.id, round.parentRecordId));
  const payload = round.payload as { deadlineAt: string };
  if (!frozen) throw stale("The evaluation for this round is unavailable.");
  return assertEvaluationCurrent(store, item, frozen, now, payload.deadlineAt);
}

export function assertCheckpointRoundCurrent(store: RunStore, item: WorkItem, round: WorkItemCollaborationRecord, now: string): void {
  readCurrentRoundBasis(store, item, round, now);
}

export async function assertCheckpointRoundCandidate(store: RunStore, item: WorkItem, round: WorkItemCollaborationRecord, now: string): Promise<void> {
  const candidate = readCurrentRoundBasis(store, item, round, now)?.candidate;
  if (candidate) await assertCandidateCurrent(candidate);
}

function assertEvaluationCurrent(store: RunStore, item: WorkItem, frozen: FrozenEvaluation, now: string, deadline: string,
  currentPolicy?: { readonly cwd: string; readonly policies: readonly AppServerDeliberationPolicy[] }) {
  const { decision, evaluation } = frozen;
  if (!workItemAllowsDeliberation(item, decision.subject)) {
    throw new HttpError(409, "resume_blocked", "The Work Item is held. Resume the applicable stage before continuing deliberation.");
  }
  if (deadline <= now) throw stale("The deliberation deadline expired.");
  const basis = readDecisionBasis(store, item, decision);
  const latest = latestEvaluation(store, item.id, evaluation.decisionId);
  if (latest?.evaluation.decisionRevision !== evaluation.decisionRevision || basis.digest !== frozen.basisDigest) {
    throw stale("The decision basis or applicable evaluation changed.");
  }
  if (currentPolicy) {
    const policy = policyForSubject(store, currentPolicy.cwd, basis.subject, currentPolicy.policies);
    if ((policy?.effectiveRevision ?? defaultDeliberationPolicyRevision) !== evaluation.policyRevision
      || latest.decision.requestKind === decision.requestKind && latest.evaluation.outcome !== evaluation.outcome) {
      throw stale("The deliberation policy or applicable evaluation changed.");
    }
  }
  return basis;
}

function policyForSubject(store: RunStore, cwd: string, subject: SubjectBasis, policies: readonly AppServerDeliberationPolicy[]) {
  return subject.channelId === undefined ? undefined : readWorkspaceDeliberationPolicy(store, cwd, subject.channelId, policies);
}

function readDecisionBasis(store: RunStore, item: WorkItem, decision: FrozenEvaluation["decision"],
  checkpointScope?: { readonly beforeScheduledClose?: boolean; readonly throughEvidenceSequence?: number }) {
  const subject = readSubject(store, item, decision.subject);
  const checkpoint = checkpointScope?.beforeScheduledClose ? { type: "coordination_round", id: decision.checkpointRef }
    : readCheckpoint(store, item, subject, decision);
  const channel = subject.channelId && store.getChannel(subject.channelId);
  const eligible = channel ? listEffectiveChannelAiTeammates(store, channel) : [];
  const participants = decision.participantIds.map(id => {
    const participant = eligible.find(entry => entry.id === id);
    if (!participant) throw stale("A requested participant is unavailable for this subject.");
    return participant;
  });
  const readEntry = (id: string, option: boolean) => {
    const entry = store.getWorkItemEvidence(id);
    if (entry?.workItemId !== item.id || entry.subjectRevision !== subject.subjectRevision
      || checkpointScope?.throughEvidenceSequence !== undefined && entry.sequence > checkpointScope.throughEvidenceSequence
      || option && entry.kind !== "proposal") throw stale("A decision input is unavailable for the current subject.");
    return entry;
  };
  const optionEntries = decision.optionRefs.map(id => readEntry(id, true));
  const options = optionEntries.map(entry => evidenceRef(entry, "deliberation_option"));
  const evidence = decision.evidenceRefs.map(id => readEntry(id, false));
  const evidenceRefs = evidence.map(entry => evidenceRef(entry, "work_item_evidence"));
  const candidate = decision.candidateDigest ? { digest: decision.candidateDigest, cwd: decisionCandidateCwd(store, subject) } : undefined;
  const decisionTarget = decision.decisionStepId
    ? readDecisionTarget(store, item, subject.step, decision.decisionStepId, decision.question, optionEntries, candidate) : undefined;
  const verificationRefs = candidate
    ? evidence.flatMap(entry => readDecisionVerificationRefs(store, item, candidate, entry)) : [];
  return {
    subject, options, optionEntries, evidence, candidate, verificationRefs, participants, decisionTarget,
    sourceRefs: [checkpoint, ...options, ...evidenceRefs, ...verificationRefs],
    digest: digest([defaultDeliberationPolicyRevision, item.control.generation, subject.scopeRevision,
      participants.map(participant => [participant.id, participant.updatedAt]), options, evidenceRefs, candidate, verificationRefs,
      ...(decisionTarget ? [decisionTarget] : [])]),
  };
}

function readDecisionTarget(store: RunStore, item: WorkItem, origin: ChannelWorkflowStep | undefined, stepId: string,
  question: string, options: readonly WorkItemEvidenceEntry[], candidate: unknown): WorkItemDeliberationTarget {
  const step = store.getChannelWorkflowStep(stepId);
  const dependency = step?.metadata?.requiredPlanDecision;
  if (!origin || !candidate || !step || step.workflowId !== origin.workflowId || step.workflowId !== item.workflowId
    || !["queued", "blocked"].includes(step.status) || dependency?.receiptSource !== "checkpoint" || dependency.question !== question) {
    throw stale("The accepted stage does not accept this checkpoint decision for the current candidate.");
  }
  if (item.holds.some(hold => hold.blocksNewAdmission && hold.workflowStepIds?.includes(stepId))) {
    throw new HttpError(409, "resume_blocked", "The decision dependency is held by a pending change.");
  }
  const values = options.map(option => option.optionId);
  if (values.some(value => !value || !dependency.options.includes(value)) || values.length !== new Set(values).size) {
    throw stale("Map each proposal to a distinct option in the accepted dependency.");
  }
  return { stepId, stepDigest: deliberationWorkflowStepDigest(step),
    options: Object.fromEntries(options.map(entry => [entry.id, entry.optionId!])) };
}

function evidenceRef(entry: WorkItemEvidenceEntry, type: string) {
  return { type, id: entry.id, revision: String(entry.revision) };
}

function decisionCandidateCwd(store: RunStore, subject: SubjectBasis): string {
  if (!subject.step?.runId) return store.paths.cwd;
  const run = store.getRun(subject.step.runId);
  if (run?.workflowStepId !== subject.step.id) throw stale("The stage candidate owner is unavailable.");
  return run.cwd;
}

function readDecisionVerificationRefs(store: RunStore, item: WorkItem, candidate: { digest: string; cwd: string }, entry: WorkItemEvidenceEntry) {
  return entry.sourceRefs.flatMap(ref => {
    if (ref.type !== "verification") return [];
    const stored = store.getAppServerState("verify_operation", ref.id);
    const receipt = stored?.payload as { operation: LingAppServerVerifyOperation; plan: LingAppServerVerifyPlanResult } | undefined;
    const { operation, plan } = receipt ?? {};
    if (!stored || !operation || !plan || operation.operationId !== ref.id || operation.planId !== plan.planId
      || operation.workItemId !== item.id || plan.workItemId !== item.id || plan.acceptedPlanRevision !== item.planRevision
      || operation.candidateDigest !== candidate.digest || plan.candidate.candidateDigest !== candidate.digest
      || plan.candidate.workspaceId !== candidate.cwd || !operation.completedAt
      || !operation.checks.some(check => (check.status === "passed" || check.status === "failed")
        && check.execution?.exitCode !== undefined && check.candidateDigest === candidate.digest && check.planRevision === plan.planRevision
        && plan.checks.some(planned => planned.checkId === check.checkId && planned.recipeDigest === check.recipeDigest))) return [];
    return [{ type: "verification", id: ref.id, revision: String(stored.revision), digest: candidate.digest }];
  });
}

async function assertCandidateCurrent(candidate: { digest: string; cwd: string }): Promise<void> {
  if (await readCompleteHandoffCandidate(candidate.cwd) !== candidate.digest) {
    throw stale("The captured decision candidate changed or no longer has complete coverage.");
  }
}

function readSubject(store: RunStore, item: WorkItem, subject: LingAppServerDeliberationSubject): SubjectBasis {
  if (subject.kind === "draft_plan") {
    const plan = store.getProposedPlanArtifact(subject.planId);
    const thread = plan && store.getLingThread(plan.threadId);
    const binding = plan && store.getAppServerState("work_item_thread", plan.threadId)?.payload as WorkItemConversationBinding | undefined;
    const run = item.runId && store.getRun(item.runId);
    if (!plan || plan.status !== "draft" || plan.revision !== subject.planRevision
      || !thread || thread.status === "archived"
      || binding?.workItemId !== item.id && !(run && run.threadId === thread.id && plan.sourceRunId === run.id)) {
      throw stale("The draft no longer belongs to the current Work Item planning subject.");
    }
    const subjectRevision = `${plan.id}:${plan.revision}`;
    return { channelId: thread.channelId ?? item.channelId, subjectRevision, scopeRevision: subjectRevision,
      decisionAnchor: plan.planGroupId ?? plan.id };
  }
  const step = store.getChannelWorkflowStep(subject.workflowStepId);
  const binding = step && readWorkItemWorkflowBinding(store, step.workflowId);
  const plan = binding && store.getProposedPlanArtifact(binding.planId);
  if (!step || step.workflowId !== item.workflowId || item.planRevision !== subject.planRevision
    || step.workflowId !== plan?.acceptedWorkflowId || plan.status !== "accepted" || binding?.workItemId !== item.id) {
    throw stale("The stage no longer belongs to the current accepted Work Item Plan.");
  }
  return {
    channelId: step.channelId, subjectRevision: subject.planRevision, step, decisionAnchor: step.metadata?.planStageId ?? step.id,
    scopeRevision: digest([step.workflowId, subject.planRevision, step.id, step.updatedAt]),
  };
}

function readCheckpoint(store: RunStore, item: WorkItem, subject: SubjectBasis, decision: FrozenEvaluation["decision"]) {
  const { checkpoint, checkpointRef: id } = decision;
  const { step } = subject;
  if (decision.subject.kind === "draft_plan" && checkpoint === "plan_review" && id === decision.subject.planId) {
    return { type: "draft_plan", id, revision: subject.subjectRevision };
  }
  if (step && checkpoint === "verify_review_conflict" && decision.evidenceRefs.includes(id)) {
    return { type: "work_item_evidence", id, revision: subject.subjectRevision };
  }
  if (step && (checkpoint === "blocked_stage_changed" || checkpoint === "repeated_failure")) {
    const blocker = store.getWorkItemStageProgress(item, step)?.blocker;
    if (blocker?.sourceEventId === id && (checkpoint !== "repeated_failure" || blocker.failedStarts > 1)) {
      return { type: "stage_failure", id, revision: step.updatedAt };
    }
  }
  if (step && checkpoint === "handoff_returned") {
    for (const sourceStepId of step.metadata?.requiredPlanHandoffStepIds ?? []) {
      const source = store.getChannelWorkflowStep(sourceStepId);
      const handoff = source && readWorkflowStageHandoff(store, {
        workItemId: item.id, planRevision: subject.subjectRevision, sourceStepId, sourceRevision: source.updatedAt, targetStepId: step.id,
      });
      if (handoff?.record.id === id && handoff.record.action === "returned") {
        return { type: "stage_handoff", id, revision: String(handoff.record.collaborationRevision) };
      }
    }
  }
  if (step && checkpoint === "scheduled_checkpoint") {
    const round = store.readScheduledCoordinationRound(id);
    const closed = round?.closedRecordId && readWorkItemCollaborationRecord(store, item.id, round.closedRecordId);
    if (round?.workItemId === item.id && round.kind === "checkpoint" && round.closedRecordId
      && round.controlGeneration === item.control.generation && closed && closed.kind === "coordination" && closed.action === "closed"
      && closed.parentRecordId === id && isRecord(closed.payload) && closed.payload.status === "closed"
      && (closed.payload.planRevision === undefined || closed.payload.planRevision === subject.subjectRevision)) {
      return { type: "coordination_round", id, revision: round.closedRecordId };
    }
  }
  throw stale("The checkpoint receipt is unavailable for the current subject.");
}

function evaluateCheckpoint(item: WorkItem, basis: ReturnType<typeof readDecisionBasis>, decision: FrozenEvaluation["decision"]):
  Pick<LingAppServerDeliberationEvaluation, "outcome" | "reasonCode"> {
  if (!workItemAllowsDeliberation(item, decision.subject)) return { outcome: "defer", reasonCode: "work_item_held" };
  if (decision.unresolved === "intent") return { outcome: "clarify", reasonCode: "intent_unresolved" };
  if (decision.unresolved === "handoff" || decision.checkpoint === "handoff_returned") return { outcome: "handoff_repair", reasonCode: "handoff_unresolved" };
  if (decision.unresolved === "fact" || !basis.evidence.length) return { outcome: "verify", reasonCode: "fact_unresolved" };
  if (decision.checkpoint === "verify_review_conflict" && !basis.verificationRefs.length) {
    return { outcome: "verify", reasonCode: "verification_missing_for_candidate" };
  }
  if (decision.materiality === "low" || basis.options.length < 2) return { outcome: "suppress", reasonCode: "no_material_choice" };
  if (decision.participantIds.length < 2) return { outcome: "defer", reasonCode: "participant_roster_incomplete" };
  return { outcome: "suggest", reasonCode: "material_choice_with_evidence" };
}

function workItemAllowsDeliberation(item: WorkItem, subject: LingAppServerDeliberationSubject) {
  return item.control.state === "active" && !terminalWorkItemStatuses.has(item.status) && !item.control.unresolvedEffectIds.length
    && !item.holds.some(hold => hold.blocksNewAdmission && (!hold.workflowStepIds || subject.kind === "draft_plan"
      || hold.workflowStepIds.includes(subject.workflowStepId)));
}

function latestEvaluation(store: RunStore, workItemId: string, decisionId: string) {
  const entry = store.listWorkItemEvidence({ workItemId, recordIdPrefix: `${evaluationPrefix}${decisionId}_`, newestFirst: true, limit: 1 })[0];
  return entry && readEvaluation(readWorkItemCollaborationRecord(store, workItemId, entry.id));
}

function readEvaluation(record: WorkItemCollaborationRecord | undefined): FrozenEvaluation | undefined {
  return record?.id.startsWith(evaluationPrefix) && record.kind === "deliberation" && record.action === "created"
    ? record.payload as FrozenEvaluation : undefined;
}

function readMutationReceipt(store: RunStore, workItemId: string, idempotencyKey: string) {
  const entry = store.findWorkItemEvidenceByKey(workItemId, idempotencyKey);
  if (!entry) return undefined;
  const record = readWorkItemCollaborationRecord(store, workItemId, entry.id);
  if (!record || !isCheckpointDeliberationRecord(record)) throw keyConflict();
  return record;
}

function requireWorkItem(store: RunStore, id: string): WorkItem {
  const item = store.getWorkItem(id);
  if (!item) throw new HttpError(404, "workspace_binding_invalid", "The Work Item is unavailable.");
  return item;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stale(message: string): HttpError {
  return new HttpError(409, "stale_revision", message);
}

function keyConflict(): HttpError {
  return new HttpError(409, "idempotency_conflict", "The deliberation request key was used with a different input.");
}
