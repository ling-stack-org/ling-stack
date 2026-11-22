import { createHash } from "node:crypto";
import type {
  LingAppServerCollaborationKind,
  LingAppServerDeliberationDecideParams,
  LingAppServerDeliberationSettlementParams,
  LingAppServerWorkItemCollaborationAppendParams,
  LingAppServerWorkItemCollaborationAppendResult,
  LingAppServerWorkItemCollaborationReadParams,
  LingAppServerWorkItemCollaborationReadResult,
  LingAppServerWorkItemWorkflowStages,
} from "@ling-stack/contracts";
import {
  appendWorkItemCollaboration,
  fromAppServerCollaborationParams,
  listWorkItemCollaboration,
  toAppServerCollaborationRecord,
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

export function bindAppServerStageBriefs(
  store: RunStore,
  workflow: LingAppServerWorkItemWorkflowStages,
): LingAppServerWorkItemWorkflowStages {
  return { ...workflow, steps: workflow.steps.map(step => {
    if (!["succeeded", "failed", "cancelled", "skipped", "blocked"].includes(step.status)) return step;
    const [transition] = store.listStateTransitionEvents({ entityType: "workflow_step", entityId: step.stepId, limit: 1 });
    return transition?.toStatus === step.status ? {
      ...step,
      briefBasis: { transitionId: transition.id, committedAt: transition.createdAt },
    } : step;
  }) };
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
  const roundEntry = store.getWorkItemEvidence(input.roundId);
  const round = roundEntry?.workItemId === item.id && roundEntry.subjectRevision === `work-item-collaboration:${roundEntry.idempotencyKey}`
    ? listWorkItemCollaboration(store, { workItemId: item.id, kind: "deliberation", afterRevision: roundEntry.sequence - 1, limit: 1 }).records[0]
    : undefined;
  if (!round || round.action !== "started" || round.collaborationRevision !== input.expectedRoundRevision) {
    throw new AppServerCollaborationError("stale_revision", "The deliberation round or its revision is unavailable.");
  }
  if (decision?.disposition === "selected" && (!isRecord(round.payload) || !Array.isArray(round.payload.options)
    || !round.payload.options.includes(decision.option))) {
    throw new AppServerCollaborationError("invalid_params", "Select an option recorded when the round opened.");
  }

  const id = `work_item_deliberation_${createHash("sha256").update(round.id).digest("hex")}`;
  const prior = store.getWorkItemEvidence(id);
  if (prior && prior.idempotencyKey !== input.idempotencyKey) {
    throw new AppServerCollaborationError("stale_revision", "The deliberation round already has a resolution.");
  }
  if (!prior && (item.revision !== input.expectedWorkItemRevision || hasPriorResolution(store, round))) {
    throw new AppServerCollaborationError("stale_revision", "The Work Item revision changed or the deliberation round already has a resolution.");
  }
  if (!prior && decision && (item.control.state !== "active" || item.holds.some(hold => hold.blocksNewAdmission))) {
    throw new HttpError(409, "resume_blocked", "The Work Item is held. A held round can be cancelled.");
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
