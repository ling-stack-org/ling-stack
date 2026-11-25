import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  LING_APP_SERVER_DECISION_MATERIALITIES,
  LING_APP_SERVER_DELIBERATION_CHECKPOINTS,
  LING_APP_SERVER_DELIBERATION_DECISION_KINDS,
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
  readWorkItemCollaborationRecord,
  readWorkflowStageHandoff,
  type ChannelWorkflowStep,
  type ControlPlaneEvent,
  type RunStore,
  type WorkItem,
  type WorkItemCollaborationRecord,
  type WorkItemConversationBinding,
  type WorkItemEvidenceEntry,
} from "@ling-stack/core";
import { z } from "zod";
import { HttpError } from "../errors.js";
import { listEffectiveChannelAiTeammates } from "../features/channels/channel-teammate-availability.js";
import { readCompleteHandoffCandidate } from "../features/work-items/stage-handoff-candidates.js";
import { readWorkItemWorkflowBinding } from "../features/work-items/workflow-stages.js";

const evaluationPrefix = "work_item_deliberation_evaluation_";
const roundPrefix = "work_item_deliberation_round_";
const policyRevision = "checkpoint-suggestions:1";
const validityMs = 15 * 60_000;
const terminalWorkItemStatuses = new Set(["done", "cancelled", "archived", "superseded"]);
const boundedId = z.string().trim().min(1).max(200).regex(/^[^\r\n\0]+$/u);
const refs = z.array(boundedId).max(12);
const mutationFields = {
  workItemId: boundedId,
  expectedWorkItemRevision: z.number().int().positive(),
  idempotencyKey: boundedId,
};

export const deliberationEvaluateInput = z.object({
  ...mutationFields,
  decisionKey: boundedId,
  subject: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("draft_plan"), planId: boundedId, planRevision: z.number().int().positive() }),
    z.object({ kind: z.literal("workflow_stage"), workflowStepId: boundedId, planRevision: boundedId }),
  ]),
  checkpoint: z.enum(LING_APP_SERVER_DELIBERATION_CHECKPOINTS),
  checkpointRef: boundedId,
  decisionKind: z.enum(LING_APP_SERVER_DELIBERATION_DECISION_KINDS),
  materiality: z.enum(LING_APP_SERVER_DECISION_MATERIALITIES),
  question: z.string().trim().min(1).max(1200),
  participantIds: refs,
  optionRefs: refs,
  evidenceRefs: refs,
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  unresolved: z.enum(["intent", "fact", "handoff"]).optional(),
});

export const deliberationOpenInput = z.object({ ...mutationFields, evaluationId: boundedId });

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

export async function evaluateAppServerDeliberation(
  store: RunStore, input: LingAppServerDeliberationEvaluateParams, now: string, cwd: string,
): Promise<LingAppServerDeliberationEvaluateResult & { readonly event?: ControlPlaneEvent }> {
  const { workItemId, expectedWorkItemRevision, idempotencyKey, cwd: _cwd, ...requested } = input;
  const item = requireWorkItem(store, workItemId);
  const decision = {
    ...requested, participantIds: sortedUnique(input.participantIds),
    optionRefs: sortedUnique(input.optionRefs), evidenceRefs: sortedUnique(input.evidenceRefs),
  };
  const readReplay = () => {
    const prior = readMutationReceipt(store, workItemId, idempotencyKey);
    if (!prior) return undefined;
    const frozen = readEvaluation(prior);
    if (!frozen || !isDeepStrictEqual(frozen.decision, decision)) throw keyConflict();
    return { cwd, evaluation: frozen.evaluation, workItemRevision: requireWorkItem(store, workItemId).revision, replayed: true };
  };
  const prior = readReplay();
  if (prior) return prior;
  const basis = readDecisionBasis(store, item, decision);
  const decisionId = digest([item.id, decision.decisionKey, decision.subject.kind, basis.subject.decisionAnchor]);
  const decisionRevision = digest([basis.digest, decision.decisionKind, decision.materiality, decision.question, decision.unresolved]);
  const evaluationId = `${evaluationPrefix}${decisionId}_${digest([decisionRevision, decision.checkpoint, decision.checkpointRef])}`;
  if (basis.candidate) {
    await assertCandidateCurrent(basis.candidate);
    const committed = readReplay();
    if (committed) return committed;
  }
  const existing = readEvaluation(readWorkItemCollaborationRecord(store, workItemId, evaluationId));
  if (existing) return { cwd, evaluation: existing.evaluation, workItemRevision: requireWorkItem(store, workItemId).revision, replayed: true };
  if (item.revision !== expectedWorkItemRevision) throw stale("The Work Item revision changed before evaluation.");
  const evaluation: LingAppServerDeliberationEvaluation = {
    evaluationId, decisionId, decisionRevision, subjectRevision: basis.subject.subjectRevision, policyRevision,
    checkpoint: decision.checkpoint, checkpointRef: decision.checkpointRef,
    optionRefs: decision.optionRefs, evidenceRefs: decision.evidenceRefs, participantIds: decision.participantIds,
    ...(basis.candidate ? { candidateDigest: basis.candidate.digest } : {}),
    evaluatedAt: now, expiresAt: new Date(Date.parse(now) + validityMs).toISOString(),
    ...evaluateCheckpoint(item, basis, decision),
  };
  const predecessor = latestEvaluation(store, item.id, decisionId);
  const result = appendWorkItemCollaboration(store, {
    id: evaluationId, workItemId, expectedWorkItemRevision, idempotencyKey,
    kind: "deliberation", action: "created", actorId: "local-user", visibility: "owner",
    payload: { evaluation, decision, basisDigest: basis.digest } satisfies FrozenEvaluation,
    ...(predecessor ? { parentRecordId: predecessor.evaluation.evaluationId } : {}),
    sourceRefs: basis.sourceRefs,
    assertCurrent: () => {
      if (readDecisionBasis(store, requireWorkItem(store, workItemId), decision).digest !== basis.digest) {
        throw stale("The decision basis changed before the evaluation committed.");
      }
    },
  }, now, cwd);
  if (!result) throw stale("The Work Item revision changed before the evaluation committed.");
  return { cwd, evaluation, workItemRevision: result.workItemRevision, replayed: false, event: result.event };
}

export async function openAppServerEvaluatedDeliberation(
  store: RunStore, input: LingAppServerDeliberationOpenParams, now: string, cwd: string,
): Promise<LingAppServerWorkItemCollaborationAppendResult & { readonly event?: ControlPlaneEvent }> {
  const { workItemId, evaluationId, expectedWorkItemRevision, idempotencyKey } = input;
  const item = requireWorkItem(store, workItemId);
  const frozen = readEvaluation(readWorkItemCollaborationRecord(store, workItemId, evaluationId));
  if (!frozen) throw stale("The deliberation evaluation is unavailable.");
  const { evaluation, decision } = frozen;
  const roundId = roundPrefix + digest([workItemId, evaluation.decisionId, evaluation.decisionRevision]);
  const readReplay = () => {
    const prior = readMutationReceipt(store, workItemId, idempotencyKey);
    if (prior && prior.id !== roundId) throw keyConflict();
    const existing = prior ?? readWorkItemCollaborationRecord(store, workItemId, roundId);
    if (!existing) return undefined;
    const workItemRevision = requireWorkItem(store, workItemId).revision;
    return { status: "replayed" as const, record: { ...existing, workItemRevision }, workItemRevision };
  };
  const prior = readReplay();
  if (prior) return prior;
  if (evaluation.outcome !== "suggest") throw new HttpError(409, "resume_blocked", "Only a current deliberation suggestion can open a round.");

  const assertCurrent = () => assertEvaluationCurrent(store, requireWorkItem(store, workItemId), frozen, now, evaluation.expiresAt);
  const { candidate } = assertEvaluationCurrent(store, item, frozen, now, evaluation.expiresAt);
  if (candidate) {
    await assertCandidateCurrent(candidate);
    const committed = readReplay();
    if (committed) return committed;
  }
  const deadlineAt = new Date(Date.parse(now) + validityMs).toISOString();
  const result = appendWorkItemCollaboration(store, {
    id: roundId, workItemId, expectedWorkItemRevision, idempotencyKey,
    kind: "deliberation", action: "started", actorId: "local-user", visibility: "owner", parentRecordId: evaluationId,
    payload: { decisionPoint: decision.question, options: evaluation.optionRefs, subject: decision.subject,
      decisionId: evaluation.decisionId, decisionRevision: evaluation.decisionRevision, deadlineAt,
      ...(candidate ? { candidateDigest: candidate.digest } : {}) },
    sourceRefs: [{ type: "deliberation_evaluation", id: evaluationId, revision: evaluation.decisionRevision }],
    assertCurrent,
  }, now, cwd);
  if (!result) throw stale("The Work Item revision changed before the round opened.");
  return result;
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

function assertEvaluationCurrent(store: RunStore, item: WorkItem, frozen: FrozenEvaluation, now: string, deadline: string) {
  const { decision, evaluation } = frozen;
  if (!workItemAllowsDeliberation(item, decision.subject)) {
    throw new HttpError(409, "resume_blocked", "The Work Item is held. Resume the applicable stage before continuing deliberation.");
  }
  if (deadline <= now) throw stale("The deliberation deadline expired.");
  const basis = readDecisionBasis(store, item, decision);
  const latest = latestEvaluation(store, item.id, evaluation.decisionId);
  if (evaluation.policyRevision !== policyRevision
    || latest?.evaluation.decisionRevision !== evaluation.decisionRevision
    || latest.evaluation.outcome !== evaluation.outcome || basis.digest !== frozen.basisDigest) {
    throw stale("The decision basis or applicable evaluation changed.");
  }
  return basis;
}

function readDecisionBasis(store: RunStore, item: WorkItem, decision: FrozenEvaluation["decision"]) {
  const subject = readSubject(store, item, decision.subject);
  const checkpoint = readCheckpoint(store, item, subject, decision);
  const channel = subject.channelId && store.getChannel(subject.channelId);
  const eligible = channel ? listEffectiveChannelAiTeammates(store, channel) : [];
  const participants = decision.participantIds.map(id => {
    const participant = eligible.find(entry => entry.id === id);
    if (!participant) throw stale("A requested participant is unavailable for this subject.");
    return [participant.id, participant.updatedAt];
  });
  const readEntry = (id: string, option: boolean) => {
    const entry = store.getWorkItemEvidence(id);
    if (entry?.workItemId !== item.id || entry.subjectRevision !== subject.subjectRevision
      || option && entry.kind !== "proposal") throw stale("A decision input is unavailable for the current subject.");
    return entry;
  };
  const options = decision.optionRefs.map(id => evidenceRef(readEntry(id, true), "deliberation_option"));
  const evidence = decision.evidenceRefs.map(id => readEntry(id, false));
  const evidenceRefs = evidence.map(entry => evidenceRef(entry, "work_item_evidence"));
  const candidate = decision.candidateDigest ? { digest: decision.candidateDigest, cwd: decisionCandidateCwd(store, subject) } : undefined;
  const verificationRefs = candidate
    ? evidence.flatMap(entry => readDecisionVerificationRefs(store, item, candidate, entry)) : [];
  return {
    subject, options, evidence, candidate, verificationRefs,
    sourceRefs: [checkpoint, ...options, ...evidenceRefs, ...verificationRefs],
    digest: digest([policyRevision, item.control.generation, subject.scopeRevision, participants, options, evidenceRefs, candidate, verificationRefs]),
  };
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
    if (round?.workItemId === item.id && round.kind === "checkpoint" && round.closedRecordId
      && round.controlGeneration === item.control.generation) {
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
