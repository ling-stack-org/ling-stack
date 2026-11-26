import { isDeepStrictEqual } from "node:util";
import type {
  LingAppServerCollaborationKind,
  LingAppServerDeliberationDecideParams,
  LingAppServerDeliberationDecideResult,
  LingAppServerDeliberationAppliedDecision,
  LingAppServerDeliberationSettlementParams,
  LingAppServerStageBallotProgress,
  LingAppServerStageDeliberationStartParams,
  LingAppServerWorkItemCollaborationAppendParams,
  LingAppServerWorkItemCollaborationAppendResult,
  LingAppServerWorkItemCollaborationReadParams,
  LingAppServerWorkItemCollaborationReadResult,
} from "@ling-stack/contracts";
import {
  appendWorkItemCollaboration,
  checkpointDeliberationResolutionId,
  fromAppServerCollaborationParams,
  LING_AGENT_ID,
  listWorkItemCollaboration,
  planStageBallotKey,
  readWorkItemCollaborationRecord,
  readWorkItemDeliberationApplication,
  toAppServerCollaborationRecord,
  workItemWorkflowDecisionId,
  type WorkItemWorkflowDecisionSubject,
  WORK_ITEM_COLLABORATION_CONTENT_PREFIX,
  type WorkItemCollaborationRecord,
  type WorkItem,
} from "@ling-stack/core";
import type { AppendWorkItemEvidenceInput, ControlPlaneEvent, RunStore, WorkItemDeliberationApplication,
  WorkItemEvidenceEventOptions } from "@ling-stack/core";
import { HttpError } from "../errors.js";
import { isRecord } from "../shared/validation.js";
import { readAppServerStageBallot } from "../features/work-items/stage-ballot.js";
import { projectDeliberationWorkflowProgress, readCompletedDeliberationWorkflow } from "../features/work-items/deliberation-workflow.js";
import { assertCheckpointRoundCandidate, assertCheckpointRoundCurrent, isCheckpointDeliberationRecord } from "./app-server-deliberation.js";
import { readPlanShapingResult } from "../features/channels/plan-deliberation-shaping.js";

export class AppServerCollaborationError extends Error {
  constructor(
    readonly code: "work_item_not_found" | "stale_revision" | "idempotency_conflict" | "invalid_params",
    message: string,
  ) {
    super(message);
    this.name = "AppServerCollaborationError";
  }
}
export function readAppServerWorkItemCollaboration(
  store: RunStore,
  params: LingAppServerWorkItemCollaborationReadParams,
  includeDeliberationWorkflows = false,
): LingAppServerWorkItemCollaborationReadResult {
  const workItem = store.getWorkItem(params.workItemId);
  if (!workItem) throw new AppServerCollaborationError("work_item_not_found", `Work Item was not found: ${params.workItemId}`);
  const page = listWorkItemCollaboration(store, {
    workItemId: params.workItemId,
    kind: params.kind,
    afterRevision: params.afterRevision,
    limit: params.limit,
  });
  const ballots = params.kind === "deliberation" ? readOpenStageBallots(store, workItem, page.records) : undefined;
  const deliberationWorkflows = includeDeliberationWorkflows && params.kind === "deliberation" ? page.records.flatMap(record => {
    const execution = projectDeliberationWorkflowProgress(store, record);
    return execution ? [execution] : [];
  }) : [];
  return {
    workItemId: params.workItemId,
    records: page.records.map(toAppServerCollaborationRecord),
    nextAfterRevision: page.nextAfterRevision,
    ...(ballots?.length ? { ballots } : {}),
    ...(deliberationWorkflows.length ? { deliberationWorkflows } : {}),
  };
}

export function appendAppServerWorkItemCollaboration(
  store: RunStore,
  params: LingAppServerWorkItemCollaborationAppendParams,
  now: string,
): LingAppServerWorkItemCollaborationAppendResult & { readonly event?: ControlPlaneEvent } {
  const workItem = store.getWorkItem(params.workItemId);
  if (!workItem) throw new AppServerCollaborationError("work_item_not_found", `Work Item was not found: ${params.workItemId}`);
  const opensRound = params.action === "started" && (params.kind === "deliberation" || params.kind === "coordination");
  const acceptsHandoff = params.kind === "handoff" && params.action === "accepted";
  const result = appendWorkItemCollaboration(store, {
    ...fromAppServerCollaborationParams(params),
    ...(opensRound || acceptsHandoff ? {
      assertCurrent: () => {
        if (store.findWorkItemEvidenceByKey(workItem.id, params.idempotencyKey)) return;
        const current = store.getWorkItem(workItem.id);
        if (current && (current.control.state !== "active" || current.holds.some(hold => hold.blocksNewAdmission))) {
          throw new HttpError(409, "resume_blocked", "The Work Item is held. Resume it before starting a round or accepting a handoff.");
        }
      },
    } : {}),
  }, now, params.cwd);
  if (!result) throw new AppServerCollaborationError("stale_revision", "The Work Item revision or collaboration revision is stale.");
  return {
    status: result.status,
    record: toAppServerCollaborationRecord(result.record),
    workItemRevision: result.workItemRevision,
    ...(result.event ? { event: result.event } : {}),
  };
}

export function readAppServerWorkItemCollaborationKind(
  store: RunStore,
  workItemId: string,
  kind: LingAppServerCollaborationKind,
  afterRevision?: number,
  limit?: number,
): readonly WorkItemCollaborationRecord[] {
  const result = readAppServerWorkItemCollaboration(store, { workItemId, kind, afterRevision, limit });
  return result.records;
}

export function startAppServerStageDeliberation(
  store: RunStore, input: LingAppServerStageDeliberationStartParams, now: string, cwd: string, actorId = "local-user",
): LingAppServerWorkItemCollaborationAppendResult & { readonly event?: ControlPlaneEvent } {
  if (input.expectedWorkItemRevision < 1 || !input.idempotencyKey.trim() || input.idempotencyKey.length > 200) {
    throw new AppServerCollaborationError("invalid_params", "Supply the current Work Item revision and a bounded request key.");
  }
  const item = store.getWorkItem(input.workItemId);
  const step = store.getChannelWorkflowStep(input.workflowStepId);
  const required = step?.metadata?.requiredPlanDecision;
  if (!item || !item.workflowId || !item.planRevision || step?.workflowId !== item.workflowId || !required) {
    throw new AppServerCollaborationError("stale_revision", "The Work Item does not have this accepted decision point.");
  }
  if (required.receiptSource === "checkpoint") {
    throw new HttpError(409, "resume_blocked", "The accepted stage requires a linked deliberation receipt.");
  }
  const subject = { workItemId: item.id, planRevision: item.planRevision, workflowStepId: step.id };
  const id = workItemWorkflowDecisionId(subject, "round");
  const prior = readWorkItemCollaborationRecord(store, item.id, id);
  if (prior && prior.idempotencyKey !== input.idempotencyKey) {
    throw new AppServerCollaborationError("stale_revision", "The accepted decision point already has a round.");
  }
  if (!prior && (store.getWorkItemWorkflowAdmissionBlocker(item.workflowId) || !["queued", "blocked"].includes(step.status)
    || item.holds.some(hold => hold.blocksNewAdmission && hold.workflowStepIds?.includes(step.id)))) {
    throw new HttpError(409, "resume_blocked", "The Work Item cannot open this decision point now.");
  }
  if (!prior && required.ballot && step.metadata?.dependsOnStepIds?.some(id => {
    const dependency = store.getChannelWorkflowStep(id);
    return dependency?.status !== "succeeded" && dependency?.status !== "skipped";
  })) throw new HttpError(409, "resume_blocked", "Wait for the ballot's preceding stages.");
  const plan = store.getAppServerState("work_item_workflow", item.workflowId)?.payload as {
    binding: { planId: string };
  } | undefined;
  const ballot = required.ballot && step.metadata?.planStageId && plan
    ? { ...required.ballot, ballotKey: planStageBallotKey(plan.binding.planId, step.metadata.planStageId, required) } : undefined;
  const result = appendWorkItemCollaboration(store, {
    id, workItemId: item.id, expectedWorkItemRevision: input.expectedWorkItemRevision,
    kind: "deliberation", action: "started", actorId, idempotencyKey: input.idempotencyKey,
    payload: { decisionPoint: required.question, options: required.options, workflowDecision: subject, ...(ballot ? { ballot } : {}) },
    sourceRefs: [{ type: "workflow_step", id: step.id, revision: item.planRevision }],
  }, now, cwd);
  if (!result || result.record.id !== id) throw new AppServerCollaborationError("stale_revision", "The decision point changed before the round opened.");
  return result;
}

export function openReadyWorkItemStageDeliberations(store: RunStore, workflowId: string, now: string): readonly ControlPlaneEvent[] {
  const binding = (store.getAppServerState("work_item_workflow", workflowId)?.payload as {
    binding: import("@ling-stack/contracts").LingAppServerWorkItemWorkflowBinding;
  } | undefined)?.binding;
  if (!binding || store.getWorkItemWorkflowAdmissionBlocker(workflowId)) return [];
  const steps = store.listChannelWorkflowSteps({ workflowId, complete: true });
  const byId = new Map(steps.map(step => [step.id, step]));
  const events: ControlPlaneEvent[] = [];
  for (const step of steps) {
    if (step.status !== "queued" || step.metadata?.requiredPlanDecision?.trigger !== "when_ready"
      || step.metadata.dependsOnStepIds?.some(id => !["succeeded", "skipped"].includes(byId.get(id)?.status ?? ""))) continue;
    const workItem = store.getWorkItem(binding.workItemId);
    if (!workItem?.planRevision) break;
    if (workItem.holds.some(hold => hold.blocksNewAdmission && hold.workflowStepIds?.includes(step.id))) continue;
    const subject = { workItemId: workItem.id, planRevision: workItem.planRevision, workflowStepId: step.id };
    const idempotencyKey = workItemWorkflowDecisionId(subject, "round");
    if (store.getWorkItemEvidence(idempotencyKey)) continue;
    const result = startAppServerStageDeliberation(store, {
      workItemId: workItem.id, workflowStepId: step.id, expectedWorkItemRevision: workItem.revision, idempotencyKey,
    }, now, store.paths.cwd, LING_AGENT_ID);
    if (result.event) events.push(result.event);
  }
  return events;
}

export async function settleAppServerDeliberation(
  store: RunStore,
  input: LingAppServerDeliberationSettlementParams,
  decision: LingAppServerDeliberationDecideParams["decision"] | undefined,
  now: string,
  cwd: string,
): Promise<LingAppServerDeliberationDecideResult & { readonly event?: ControlPlaneEvent }> {
  const item = store.getWorkItem(input.workItemId);
  if (!item) throw new AppServerCollaborationError("work_item_not_found", "The Work Item is unavailable.");
  const round = readWorkItemCollaborationRecord(store, item.id, input.roundId);
  if (round?.kind !== "deliberation" || round.action !== "started" || round.collaborationRevision !== input.expectedRoundRevision) {
    throw new AppServerCollaborationError("stale_revision", "The deliberation round or its revision is unavailable.");
  }
  if (decision?.disposition === "selected" && (!isRecord(round.payload) || !Array.isArray(round.payload.options)
    || !round.payload.options.includes(decision.option))) {
    throw new AppServerCollaborationError("invalid_params", "Select an option recorded when the round opened.");
  }

  const workflowDecision = readWorkflowDecisionSubject(round);
  const privateRound = isCheckpointDeliberationRecord(round);
  const id = workflowDecision ? workItemWorkflowDecisionId(workflowDecision, "resolution")
    : checkpointDeliberationResolutionId(round.id);
  const prior = store.getWorkItemEvidence(id);
  if (prior && prior.idempotencyKey !== input.idempotencyKey) {
    throw new AppServerCollaborationError("stale_revision", "The deliberation round already has a resolution.");
  }
  if (!prior && (item.revision !== input.expectedWorkItemRevision || !workflowDecision && hasPriorResolution(store, round))) {
    throw new AppServerCollaborationError("stale_revision", "The Work Item revision changed or the deliberation round already has a resolution.");
  }
  if (!prior && decision && !privateRound && (item.control.state !== "active" || item.holds.some(hold => hold.blocksNewAdmission
    && (!hold.workflowStepIds || !workflowDecision || hold.workflowStepIds.includes(workflowDecision.workflowStepId))))) {
    throw new HttpError(409, "resume_blocked", "The Work Item is held. A held round can be cancelled.");
  }
  let ballot: Extract<ReturnType<typeof readAppServerStageBallot>, { readonly summary: unknown }> | undefined;
  if (!prior && decision && workflowDecision) {
    const step = store.getChannelWorkflowStep(workflowDecision.workflowStepId);
    if (item.planRevision !== workflowDecision.planRevision || !step?.metadata?.requiredPlanDecision || step.workflowId !== item.workflowId
      || store.getWorkItemWorkflowAdmissionBlocker(step.workflowId)
      || decision.disposition === "selected" && !step.metadata.requiredPlanDecision.options.includes(decision.option)) {
      throw new AppServerCollaborationError("stale_revision", "The accepted decision point no longer applies to this Workflow.");
    }
    if (decision.disposition === "selected" && step.metadata.requiredPlanDecision.ballot) {
      const frozen = isRecord(round.payload) && isRecord(round.payload.ballot) ? round.payload.ballot : undefined;
      const plan = store.getAppServerState("work_item_workflow", step.workflowId)?.payload as {
        binding: { planId: string };
      } | undefined;
      if (!plan) throw new AppServerCollaborationError("stale_revision", "The ballot Plan binding is unavailable.");
      const result = readAppServerStageBallot(store, step, plan.binding.planId, step.metadata.requiredPlanDecision, frozen?.ballotKey);
      if (result.status === "stale") throw new AppServerCollaborationError("stale_revision", "The ballot no longer applies to the accepted stage.");
      if (result.status === "waiting") throw new HttpError(409, "resume_blocked", "Wait for the assigned ballot stages to finish.");
      if (result.status === "quorum_unmet") throw new HttpError(409, "resume_blocked", "The verified ballots did not reach quorum.");
      if ("summary" in result) ballot = result;
    }
  }
  const action = decision ? "decided" : "cancelled";
  const requestPayload = decision ? { ...decision, reason: input.reason } : { reason: input.reason };
  const saved = prior && readWorkItemCollaborationRecord(store, item.id, prior.id);
  if (saved) {
    const { ballot: _ballot, outcome: _outcome, appliedTo, ...request } = isRecord(saved.payload) ? saved.payload : {};
    if (saved.action !== action || JSON.stringify(request) !== JSON.stringify(requestPayload)) {
      throw new AppServerCollaborationError("idempotency_conflict", "The deliberation key was used with a different decision.");
    }
    return { status: "replayed", record: { ...saved, workItemRevision: item.revision }, workItemRevision: item.revision,
      ...(appliedTo ? { appliedTo: appliedTo as LingAppServerDeliberationAppliedDecision } : {}) };
  }
  if (privateRound && decision) await assertCheckpointRoundCandidate(store, item, round, now);
  const shaping = privateRound && decision ? readPlanShapingResult(store, round) : undefined;
  if (shaping && decision?.disposition === "selected"
    && (!shaping.result || !["consensus", "open_tradeoff"].includes(shaping.result.status))) {
    throw new HttpError(409, "resume_blocked", "Resolve incomplete planning evidence before selecting an option.");
  }
  const execution = privateRound && decision?.disposition === "selected"
    ? readCompletedDeliberationWorkflow(store, item.id, round.id, round.payload) : undefined;
  let application: WorkItemDeliberationApplication | undefined;
  if (execution?.binding.decisionTarget && decision?.disposition === "selected") {
    const { decisionTarget: { stepId, stepDigest, options }, candidate, originWorkflowId, planRevision, controlGeneration } = execution.binding;
    const option = options[decision.option];
    if (!option || !candidate) throw new AppServerCollaborationError("stale_revision", "The selected option no longer belongs to the accepted dependency.");
    application = { workItemId: item.id, workflowId: originWorkflowId, planRevision, controlGeneration,
      stepId, stepDigest, candidate, roundId: round.id, resolutionId: id, option };
  }
  const appliedTo: LingAppServerDeliberationAppliedDecision | undefined = application ? {
    workflowId: application.workflowId, workflowStepId: application.stepId, planRevision: application.planRevision,
    option: application.option, candidateDigest: application.candidate.digest,
  } : undefined;
  const payload = { ...requestPayload, ...(ballot ? { ballot: ballot.summary } : {}),
    ...(execution?.outcome ? { outcome: execution.outcome } : {}), ...(appliedTo ? { appliedTo } : {}) };
  const sourceRefs = [{ type: "deliberation_round", id: round.id, revision: String(round.collaborationRevision) },
    ...(shaping?.record ? [{ type: "plan_shaping", id: shaping.record.id, revision: String(shaping.record.collaborationRevision) }] : []),
    ...(ballot?.sourceRefs ?? []), ...(execution?.sources ?? []),
    ...(application ? [{ type: "workflow_step", id: application.stepId, revision: application.planRevision }] : [])];
  const evidence: AppendWorkItemEvidenceInput = {
    id,
    workItemId: item.id,
    expectedWorkItemRevision: input.expectedWorkItemRevision,
    idempotencyKey: input.idempotencyKey,
    actorId: "local-user",
    subjectRevision: `work-item-collaboration:${input.idempotencyKey}`,
    kind: "decision_ref",
    content: `${WORK_ITEM_COLLABORATION_CONTENT_PREFIX}${JSON.stringify({
      schemaVersion: 1, kind: "deliberation", action, payload, parentRecordId: round.id,
    })}`,
    sourceRefs,
    ...(privateRound ? {
      visibility: "owner" as const,
      ...(decision ? { assertCurrent: () => {
        if (store.getWorkItemEvidence(id)?.idempotencyKey === input.idempotencyKey) return;
        const current = store.getWorkItem(item.id);
        if (!current) throw new AppServerCollaborationError("work_item_not_found", "The Work Item is unavailable.");
        assertCheckpointRoundCurrent(store, current, round, now);
        if (execution && !isDeepStrictEqual(readCompletedDeliberationWorkflow(store, item.id, round.id, round.payload), execution)) {
          throw new AppServerCollaborationError("stale_revision", "The deliberation outcome changed before the decision committed.");
        }
        if (application) {
          const previous = readWorkItemDeliberationApplication(store, application.stepId);
          if (previous?.workItemId === application.workItemId && previous.planRevision === application.planRevision
            && previous.controlGeneration === application.controlGeneration && previous.stepDigest === application.stepDigest
            && previous.candidate.digest === application.candidate.digest) {
            throw new AppServerCollaborationError("stale_revision", "The current dependency already has a decision for this candidate.");
          }
        }
      } } : {}),
    } : {}),
  };
  const event: WorkItemEvidenceEventOptions = {
    cwd,
    project: (entry, workItemRevision) => ({
      action: `work_item.deliberation.${action}`,
      data: { workItemId: item.id, roundId: round.id, collaborationId: entry.id, collaborationRevision: entry.sequence, workItemRevision },
    }),
  };
  const resolution = application ? store.applyWorkItemDeliberationDecision(evidence, application, now, event)
    : store.appendWorkItemEvidence(evidence, now, event);
  if (!resolution) throw new AppServerCollaborationError("stale_revision", "The Work Item revision changed before the deliberation resolution.");
  const { entry, workItemRevision, event: committedEvent, status } = resolution;
  return { status, workItemRevision, event: committedEvent, ...(appliedTo ? { appliedTo } : {}), record: {
    id: entry.id,
    workspaceId: entry.workspaceId,
    workItemId: item.id,
    collaborationRevision: entry.sequence,
    workItemRevision,
    kind: "deliberation",
    action,
    actorId: entry.actorId,
    payload,
    parentRecordId: round.id,
    sourceRefs,
    idempotencyKey: entry.idempotencyKey,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  } };
}

function readOpenStageBallots(
  store: RunStore, item: WorkItem, records: readonly WorkItemCollaborationRecord[],
): readonly LingAppServerStageBallotProgress[] {
  if (!item.workflowId || !item.planRevision) return [];
  const plan = store.getAppServerState("work_item_workflow", item.workflowId)?.payload as { binding: { planId: string } } | undefined;
  if (!plan) return [];
  const ballots: LingAppServerStageBallotProgress[] = [];
  for (const round of records) {
    if (round.action !== "started") continue;
    const subject = readWorkflowDecisionSubject(round);
    if (subject?.planRevision !== item.planRevision || store.getWorkItemEvidence(workItemWorkflowDecisionId(subject, "resolution"))) continue;
    const step = store.getChannelWorkflowStep(subject.workflowStepId);
    const decision = step?.metadata?.requiredPlanDecision;
    const frozen = isRecord(round.payload) && isRecord(round.payload.ballot) ? round.payload.ballot : undefined;
    if (!step || step.workflowId !== item.workflowId || !decision?.ballot) continue;
    const result = readAppServerStageBallot(store, step, plan.binding.planId, decision, frozen?.ballotKey);
    ballots.push("summary" in result ? { roundId: round.id, status: result.status, summary: result.summary }
      : { roundId: round.id, status: result.status });
  }
  return ballots;
}

function readWorkflowDecisionSubject(round: WorkItemCollaborationRecord): WorkItemWorkflowDecisionSubject | undefined {
  const subject = isRecord(round.payload) ? round.payload.workflowDecision : undefined;
  if (!isRecord(subject) || typeof subject.planRevision !== "string" || typeof subject.workflowStepId !== "string") return undefined;
  const result = { workItemId: round.workItemId, planRevision: subject.planRevision, workflowStepId: subject.workflowStepId };
  return round.id === workItemWorkflowDecisionId(result, "round") ? result : undefined;
}

function hasPriorResolution(store: RunStore, round: WorkItemCollaborationRecord): boolean {
  let afterRevision = round.collaborationRevision;
  for (;;) {
    const page = listWorkItemCollaboration(store, { workItemId: round.workItemId, kind: "deliberation", afterRevision, limit: 500 });
    if (page.records.some(record => record.parentRecordId === round.id && (record.action === "decided" || record.action === "cancelled"))) {
      return true;
    }
    if (page.nextAfterRevision === afterRevision) return false;
    afterRevision = page.nextAfterRevision;
  }
}
