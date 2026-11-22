import { createHash } from "node:crypto";
import type {
  LingAppServerCollaborationKind,
  LingAppServerDeliberationDecideParams,
  LingAppServerDeliberationSettlementParams,
  LingAppServerStageDeliberationStartParams,
  LingAppServerWorkItemCollaborationAppendParams,
  LingAppServerWorkItemCollaborationAppendResult,
  LingAppServerWorkItemCollaborationReadParams,
  LingAppServerWorkItemCollaborationReadResult,
} from "@ling-stack/contracts";
import {
  appendWorkItemCollaboration,
  fromAppServerCollaborationParams,
  listWorkItemCollaboration,
  readWorkItemCollaborationRecord,
  toAppServerCollaborationRecord,
  workItemWorkflowDecisionId,
  type WorkItemWorkflowDecisionSubject,
  WORK_ITEM_COLLABORATION_CONTENT_PREFIX,
  type WorkItemCollaborationRecord,
} from "@ling-stack/core";
import type { ControlPlaneEvent, RunStore } from "@ling-stack/core";
import { HttpError } from "../errors.js";
import { isRecord } from "../shared/validation.js";

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
): LingAppServerWorkItemCollaborationReadResult {
  const workItem = store.getWorkItem(params.workItemId);
  if (!workItem) throw new AppServerCollaborationError("work_item_not_found", `Work Item was not found: ${params.workItemId}`);
  const page = listWorkItemCollaboration(store, {
    workItemId: params.workItemId,
    kind: params.kind,
    afterRevision: params.afterRevision,
    limit: params.limit,
  });
  return {
    workItemId: params.workItemId,
    records: page.records.map(toAppServerCollaborationRecord),
    nextAfterRevision: page.nextAfterRevision,
  };
}

export function appendAppServerWorkItemCollaboration(
  store: RunStore,
  params: LingAppServerWorkItemCollaborationAppendParams,
  now: string,
): LingAppServerWorkItemCollaborationAppendResult & { readonly event?: ControlPlaneEvent } {
  const workItem = store.getWorkItem(params.workItemId);
  if (!workItem) throw new AppServerCollaborationError("work_item_not_found", `Work Item was not found: ${params.workItemId}`);
  const result = appendWorkItemCollaboration(store, fromAppServerCollaborationParams(params), now, params.cwd);
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
  store: RunStore, input: LingAppServerStageDeliberationStartParams, now: string, cwd: string,
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
  const subject = { workItemId: item.id, planRevision: item.planRevision, workflowStepId: step.id };
  const id = workItemWorkflowDecisionId(subject, "round");
  const prior = readWorkItemCollaborationRecord(store, item.id, id);
  if (prior && prior.idempotencyKey !== input.idempotencyKey) {
    throw new AppServerCollaborationError("stale_revision", "The accepted decision point already has a round.");
  }
  if (!prior && (store.getWorkItemWorkflowAdmissionBlocker(item.workflowId) || !["queued", "blocked"].includes(step.status))) {
    throw new HttpError(409, "resume_blocked", "The Work Item cannot open this decision point now.");
  }
  const result = appendWorkItemCollaboration(store, {
    id, workItemId: item.id, expectedWorkItemRevision: input.expectedWorkItemRevision,
    kind: "deliberation", action: "started", actorId: "local-user", idempotencyKey: input.idempotencyKey,
    payload: { decisionPoint: required.question, options: required.options, workflowDecision: subject },
    sourceRefs: [{ type: "workflow_step", id: step.id, revision: item.planRevision }],
  }, now, cwd);
  if (!result || result.record.id !== id) throw new AppServerCollaborationError("stale_revision", "The decision point changed before the round opened.");
  return result;
}

export function settleAppServerDeliberation(
  store: RunStore,
  input: LingAppServerDeliberationSettlementParams,
  decision: LingAppServerDeliberationDecideParams["decision"] | undefined,
  now: string,
  cwd: string,
): LingAppServerWorkItemCollaborationAppendResult & { readonly event?: ControlPlaneEvent } {
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
  const id = workflowDecision ? workItemWorkflowDecisionId(workflowDecision, "resolution")
    : `work_item_deliberation_${createHash("sha256").update(round.id).digest("hex")}`;
  const prior = store.getWorkItemEvidence(id);
  if (prior && prior.idempotencyKey !== input.idempotencyKey) {
    throw new AppServerCollaborationError("stale_revision", "The deliberation round already has a resolution.");
  }
  if (!prior && (item.revision !== input.expectedWorkItemRevision || !workflowDecision && hasPriorResolution(store, round))) {
    throw new AppServerCollaborationError("stale_revision", "The Work Item revision changed or the deliberation round already has a resolution.");
  }
  if (!prior && decision && (item.control.state !== "active" || item.holds.some(hold => hold.blocksNewAdmission))) {
    throw new HttpError(409, "resume_blocked", "The Work Item is held. A held round can be cancelled.");
  }
  if (!prior && decision && workflowDecision) {
    const step = store.getChannelWorkflowStep(workflowDecision.workflowStepId);
    if (item.planRevision !== workflowDecision.planRevision || !step?.metadata?.requiredPlanDecision || step.workflowId !== item.workflowId
      || store.getWorkItemWorkflowAdmissionBlocker(step.workflowId)
      || decision.disposition === "selected" && !step.metadata.requiredPlanDecision.options.includes(decision.option)) {
      throw new AppServerCollaborationError("stale_revision", "The accepted decision point no longer applies to this Workflow.");
    }
  }
  const action = decision ? "decided" : "cancelled";
  const payload = decision ? { ...decision, reason: input.reason } : { reason: input.reason };
  const sourceRefs = [{ type: "deliberation_round", id: round.id, revision: String(round.collaborationRevision) }];
  const resolution = store.appendWorkItemEvidence({
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
  }, now, {
    cwd,
    project: (entry, workItemRevision) => ({
      action: `work_item.deliberation.${action}`,
      data: { workItemId: item.id, roundId: round.id, collaborationId: entry.id, collaborationRevision: entry.sequence, workItemRevision },
    }),
  });
  if (!resolution) throw new AppServerCollaborationError("stale_revision", "The Work Item revision changed before the deliberation resolution.");
  const { entry, workItemRevision, event, status } = resolution;
  return { status, workItemRevision, event, record: {
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
