import type { ConversationDomainRef, ConversationItemV1 } from "@ling-stack/contracts";
import {
  buildWorkflowCompletionExpectedReadSet,
  type WorkflowCompletionEvaluationV1,
} from "../../workflow-completion-read-set.js";
import type { AppendConversationItemInput } from "../../conversation-item-store-types.js";
import type { CreateStateTransitionEventInput, StateTransitionEvent } from "../../channel-runtime-types.js";
import type {
  AppendControlPlaneEventInput,
  ControlPlaneEvent,
  LingTurn,
  RunStore,
} from "../../run-types.js";
import type { LingTerminalReportRecord, TerminalReportOutcomeStatus } from "../../terminal-report-types.js";
import type {
  CommitTerminalReportPublicationInput,
  CommitWorkflowTerminalReportPublicationInput,
  CommitTerminalReportPublicationResult,
  TerminalReportPublicationConflictCode,
} from "../../terminal-report-publication-types.js";
import { DEFAULT_WORKSPACE_ID, type ChannelWorkflow, type ChannelWorkflowStep } from "../../workspace-types.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";
import type { NormalTerminalReportReadStore } from "../../normal-terminal-report-basis.js";
import { commitNormalTerminalReportWithinTransaction } from "./normal-terminal-report-publication.js";
import type { DelegationCompletionEvidenceV1 } from "../../delegation-completion-evidence.js";

type PublicationItem = AppendConversationItemInput<"terminal_report">;

export interface SqliteTerminalReportPublicationStorePorts {
  readonly cwd: string;
  readonly getTerminalReport: (id: string) => LingTerminalReportRecord | undefined;
  readonly commitTerminalReport: RunStore["commitTerminalReport"];
  readonly normalReadStore: NormalTerminalReportReadStore;
  readonly getChannelWorkflow: (id: string) => ChannelWorkflow | undefined;
  readonly listChannelWorkflowSteps: (workflowId: string) => readonly ChannelWorkflowStep[];
  readonly completionReadStore: Pick<RunStore,
    | "getChannelIntentDecision"
    | "getRun"
    | "listEvents"
    | "countEvents"
    | "listApprovalRequests"
    | "getArtifact"
    | "listArtifacts"
    | "getDelegationCompletionEvidence"
  >;
  readonly getLingTurn: (id: string) => LingTurn | undefined;
  readonly getConversationItem: (id: string) => ConversationItemV1 | undefined;
  readonly getConversationItemByIdempotencyKey: (threadId: string, idempotencyKey: string) => ConversationItemV1 | undefined;
  readonly appendConversationItemWithinTransaction: (input: PublicationItem, now: string) => ConversationItemV1;
  readonly findStateTransitionByIdempotency: (
    entityType: "turn",
    entityId: string,
    idempotencyKey: string,
  ) => StateTransitionEvent | undefined;
  readonly recordStateTransitionEvent: (input: CreateStateTransitionEventInput) => StateTransitionEvent;
  readonly getControlPlaneEventByIdempotency: (workspaceId: string, idempotencyKey: string) => ControlPlaneEvent | undefined;
  readonly appendControlPlaneEventWithinTransaction: (
    input: AppendControlPlaneEventInput,
    now: string,
  ) => ControlPlaneEvent;
}

export class SqliteTerminalReportPublicationStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteTerminalReportPublicationStorePorts,
  ) {}

  commitTerminalReportPublication(
    input: CommitTerminalReportPublicationInput,
  ): CommitTerminalReportPublicationResult {
    this.context.database.exec("BEGIN IMMEDIATE;");
    try {
      const result = "expectedNormalBasis" in input
        ? commitNormalTerminalReportWithinTransaction(this.context, this.ports, input)
        : this.commitWithinTransaction(input);
      if (!result.ok) {
        this.context.database.exec("ROLLBACK;");
        return result;
      }
      this.context.database.exec("COMMIT;");
      return result;
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      throw error;
    }
  }

  private commitWithinTransaction(
    input: CommitWorkflowTerminalReportPublicationInput,
  ): CommitTerminalReportPublicationResult {
    const report = this.ports.getTerminalReport(input.reportId);
    const workflow = this.ports.getChannelWorkflow(input.expectedWorkflowId);
    if (!report || !report.report || !workflow
      || report.status !== input.expectedReportStatus
      || report.evidenceFingerprint !== input.expectedEvidenceFingerprint
      || report.sourceKind !== "workflow"
      || report.sourceId !== workflow.id
      || report.report.source.kind !== "workflow"
      || report.report.source.id !== workflow.id
      || report.report.evidenceFingerprint !== report.evidenceFingerprint) {
      return conflict("report_conflict");
    }

    const sourceTurnId = workflow.metadata?.sourceTurnId;
    const sourceItemId = workflow.metadata?.sourceMessageId ?? report.sourceMessageId;
    const sourceTurn = sourceTurnId ? this.ports.getLingTurn(sourceTurnId) : undefined;
    const sourceItem = sourceItemId ? this.ports.getConversationItem(sourceItemId) : undefined;
    if (!sourceTurnId || !sourceTurn || !sourceItemId || !sourceItem
      || input.expectedSourceTurn.id !== sourceTurn.id
      || input.expectedSourceTurn.status !== sourceTurn.status
      || input.expectedSourceTurn.updatedAt !== sourceTurn.updatedAt
      || sourceItem.turnId !== sourceTurn.id
      || sourceItem.threadId !== sourceTurn.threadId
      || sourceItem.channelId !== workflow.channelId) {
      return conflict("source_turn_conflict");
    }

    const targetStatus = deriveTargetStatus(workflow, input.expectedCompletion);
    if (!targetStatus) return conflict("stale_completion_basis");
    if (!outcomeMatchesTarget(report.report.outcome.status, targetStatus)) {
      return conflict("outcome_conflict");
    }
    const steps = this.ports.listChannelWorkflowSteps(workflow.id);
    let delegations: DelegationCompletionEvidenceV1;
    if (workflow.metadata?.requiredParticipantManifest) {
      const evaluation = input.expectedCompletion;
      if (!evaluation || evaluation.expectedReadSet.workflow.id !== workflow.id) {
        return conflict("stale_completion_basis");
      }
      const actual = buildWorkflowCompletionExpectedReadSet({
        store: this.ports.completionReadStore,
        workflow,
        steps,
        derivedEvidence: evaluation.expectedReadSet.derivedEvidence,
      });
      if (actual.canonicalFingerprint !== evaluation.expectedReadSet.canonicalFingerprint
        || JSON.stringify(actual) !== JSON.stringify(evaluation.expectedReadSet)
        || workflow.metadata.completionGate?.status !== evaluation.gate.status
        || workflow.metadata.completionGate?.basisFingerprint !== evaluation.gate.basisFingerprint) {
        return conflict("stale_completion_basis");
      }
      delegations = actual.delegations;
    } else {
      delegations = this.ports.completionReadStore.getDelegationCompletionEvidence({
        rootRunIds: [...new Set(steps.flatMap(step => step.runId ? [step.runId] : []))].sort(),
      });
    }
    // A legacy workflow without a participant manifest can still own dynamic
    // work. Read its entire original subtree, not a count of projected batches.
    const expectedDelegations = input.expectedDelegationCompletion;
    const dynamic = delegations.steps.length > 0 || delegations.issues.length > 0
      || Boolean(expectedDelegations?.steps.length || expectedDelegations?.issues.length)
      || report.evidenceSnapshot.delegationCompletionFingerprint !== undefined;
    if (dynamic && (!expectedDelegations
      || delegations.fingerprint !== expectedDelegations.fingerprint
      || JSON.stringify(delegations) !== JSON.stringify(expectedDelegations)
      || report.evidenceSnapshot.delegationCompletionFingerprint !== delegations.fingerprint)) {
      return conflict("stale_completion_basis");
    }
    if (targetStatus === "succeeded" && delegations.status !== "satisfied") return conflict("stale_completion_basis");

    if (!validPublicationItem(input.publicationItem, {
      report,
      workflow,
      sourceItemId,
      sourceTurn,
    })) {
      return conflict("item_conflict");
    }
    const existingById = input.publicationItem.id
      ? this.ports.getConversationItem(input.publicationItem.id)
      : undefined;
    const existingByKey = input.publicationItem.idempotencyKey
      ? this.ports.getConversationItemByIdempotencyKey(sourceTurn.threadId, input.publicationItem.idempotencyKey)
      : undefined;
    if (existingById && existingByKey && existingById.id !== existingByKey.id) {
      return conflict("item_conflict");
    }
    const existingItem = existingById ?? existingByKey;
    if (existingItem && !samePublicationItem(existingItem, input.publicationItem)) {
      return conflict("item_conflict");
    }
    if (report.resultItemId && report.resultItemId !== input.publicationItem.id) {
      return conflict("report_conflict");
    }

    const settlementKey = settlementIdempotencyKey(workflow.id, input.publicationItem.id!, targetStatus);
    const expectedEvent = targetStatus === "succeeded"
      ? "succeed"
      : targetStatus === "blocked"
        ? sourceTurn.status === "blocked" ? "settle_blocked" : "block"
        : targetStatus === "failed" ? "fail" : "cancel";
    const existingSettlement = this.ports.findStateTransitionByIdempotency("turn", sourceTurn.id, settlementKey);
    if (existingSettlement && !compatibleSettlement(existingSettlement, sourceTurn.id, targetStatus)) {
      return conflict("source_turn_conflict");
    }

    const eventInput = publicationControlPlaneEvent(input, report, workflow, this.ports.cwd);
    const existingPublicationEvent = this.ports.getControlPlaneEventByIdempotency(
      report.workspaceId,
      input.publicationEventIdempotencyKey,
    );
    if (existingPublicationEvent && !sameControlPlaneEvent(existingPublicationEvent, eventInput)) {
      return conflict("publication_event_conflict");
    }

    const completeExistingLineage = Boolean(
      existingItem
      && report.resultItemId === existingItem.id
      && existingSettlement
      && existingPublicationEvent
      && sourceTurn.status === targetStatus,
    );
    const partialExistingLineage = Boolean(
      existingItem || report.resultItemId || existingSettlement || existingPublicationEvent,
    );
    if (partialExistingLineage && !completeExistingLineage) {
      return conflict(existingPublicationEvent ? "publication_event_conflict" : existingItem ? "item_conflict" : "source_turn_conflict");
    }
    if (completeExistingLineage) {
      return {
        ok: true,
        reportId: report.id,
        item: existingItem!,
        sourceTurnId: sourceTurn.id,
        sourceTurnStatus: sourceTurn.status,
        controlPlaneEvent: existingPublicationEvent!,
        duplicate: true,
      };
    }

    if (!turnCanSettle(sourceTurn.status, targetStatus)) {
      return conflict("source_turn_conflict");
    }
    const item = this.ports.appendConversationItemWithinTransaction(input.publicationItem, input.now);
    const marker = this.context.database.prepare(`
      UPDATE ling_terminal_reports
      SET result_item_id = ?, updated_at = ?
      WHERE id = ? AND result_item_id IS NULL
        AND status = ? AND evidence_fingerprint = ?
    `).run(
      item.id,
      input.now,
      report.id,
      input.expectedReportStatus,
      input.expectedEvidenceFingerprint,
    );
    if (Number(marker.changes) !== 1) return conflict("report_conflict");

    const settlement = settleSourceTurn(this.context, this.ports, sourceTurn, workflow, item.id, targetStatus, input.now);
    if (!sameSettlement(settlement, sourceTurn.id, targetStatus, expectedEvent)) {
      return conflict("source_turn_conflict");
    }
    const controlPlaneEvent = this.ports.appendControlPlaneEventWithinTransaction(eventInput, input.now);
    return {
      ok: true,
      reportId: report.id,
      item,
      sourceTurnId: sourceTurn.id,
      sourceTurnStatus: targetStatus,
      controlPlaneEvent,
      duplicate: false,
    };
  }
}

function conflict(code: TerminalReportPublicationConflictCode): CommitTerminalReportPublicationResult {
  return { ok: false, code };
}

function deriveTargetStatus(
  workflow: ChannelWorkflow,
  evaluation: WorkflowCompletionEvaluationV1 | undefined,
): "succeeded" | "blocked" | "failed" | "cancelled" | undefined {
  if (workflow.metadata?.requiredParticipantManifest) {
    if (evaluation?.gate.status === "verified" && workflow.status === "succeeded") return "succeeded";
    if (evaluation?.gate.status === "blocked" && workflow.status === "blocked") return "blocked";
    if (evaluation?.gate.status === "failed" && workflow.status === "failed") return "failed";
    if (evaluation?.gate.status === "cancelled" && workflow.status === "cancelled") return "cancelled";
    return undefined;
  }
  if (workflow.status === "succeeded" || workflow.status === "blocked"
    || workflow.status === "failed" || workflow.status === "cancelled") return workflow.status;
  return undefined;
}

function outcomeMatchesTarget(
  outcome: TerminalReportOutcomeStatus,
  target: "succeeded" | "blocked" | "failed" | "cancelled",
): boolean {
  // A verified workflow may finish all required work while its atomic audit
  // retains a recovered tool failure. Keep that conservative report outcome;
  // it must not strand the finished source Turn without a published result.
  // Required-participant authority is independently revalidated above.
  if (target === "succeeded") return outcome === "succeeded" || outcome === "partially_succeeded";
  if (target === "blocked") return outcome === "blocked" || outcome === "partially_succeeded";
  return outcome === target;
}

function validPublicationItem(input: PublicationItem, authority: {
  readonly report: LingTerminalReportRecord;
  readonly workflow: ChannelWorkflow;
  readonly sourceItemId: string;
  readonly sourceTurn: LingTurn;
}): boolean {
  const refs = input.domainRefs ?? [];
  return input.id === `result_terminal_report:${authority.report.id}`
    && input.idempotencyKey === `terminal-report:${authority.report.id}`
    && input.channelId === authority.workflow.channelId
    && input.threadId === authority.sourceTurn.threadId
    && input.turnId === authority.sourceTurn.id
    && input.kind === "terminal_report"
    && input.status === "committed"
    && input.actorType === "system"
    && input.actorId === undefined
    && input.visibility === "channel"
    && input.payload.reportId === authority.report.id
    && input.payload.generation === authority.report.generation
    && input.payload.sourceKind === authority.report.sourceKind
    && input.payload.sourceId === authority.report.sourceId
    && input.payload.evidenceFingerprint === authority.report.evidenceFingerprint
    && input.payload.outcomeStatus === authority.report.outcomeStatus
    && refs.every(allowedPublicationRef)
    && hasRef(refs, "terminal_report", authority.report.id)
    && hasRef(refs, "workflow", authority.workflow.id)
    && hasRef(refs, "conversation_item", authority.sourceItemId)
    && hasRef(refs, "turn", authority.sourceTurn.id);
}

function allowedPublicationRef(ref: ConversationDomainRef): boolean {
  return ref.type === "terminal_report" || ref.type === "workflow"
    || ref.type === "conversation_item" || ref.type === "turn" || ref.type === "run";
}

function hasRef(refs: readonly ConversationDomainRef[], type: ConversationDomainRef["type"], id: string): boolean {
  return refs.some((ref) => ref.type === type && ref.id === id);
}

function samePublicationItem(existing: ConversationItemV1, input: PublicationItem): boolean {
  return existing.id === input.id
    && existing.workspaceId === DEFAULT_WORKSPACE_ID
    && existing.channelId === input.channelId
    && existing.threadId === input.threadId
    && existing.turnId === input.turnId
    && existing.kind === input.kind
    && existing.status === input.status
    && existing.actorType === input.actorType
    && existing.actorId === input.actorId
    && existing.visibility === input.visibility
    && existing.idempotencyKey === input.idempotencyKey
    && existing.supersedesItemId === input.supersedesItemId
    && JSON.stringify(existing.payload) === JSON.stringify(input.payload)
    && JSON.stringify(existing.domainRefs) === JSON.stringify(input.domainRefs ?? []);
}

function settlementIdempotencyKey(
  workflowId: string,
  itemId: string,
  target: string,
): string {
  return `workflow:${workflowId}:source-turn:${itemId}:${target}`;
}

function sameSettlement(
  event: StateTransitionEvent,
  turnId: string,
  target: string,
  expectedEvent: string,
): boolean {
  return event.entityType === "turn" && event.entityId === turnId
    && event.toStatus === target && event.event === expectedEvent;
}

function compatibleSettlement(event: StateTransitionEvent, turnId: string, target: string): boolean {
  return event.entityType === "turn" && event.entityId === turnId && event.toStatus === target
    && (target === "blocked"
      ? event.event === "block" || event.event === "settle_blocked"
      : target === "succeeded"
        ? event.event === "succeed"
        : target === "failed"
          ? event.event === "fail"
          : event.event === "cancel");
}

function turnCanSettle(current: LingTurn["status"], target: "succeeded" | "blocked" | "failed" | "cancelled"): boolean {
  if (current === target) return current === "blocked";
  if (current === "open" || current === "running" || current === "waiting_for_approval") return true;
  if (current === "blocked") return target === "failed" || target === "cancelled";
  return false;
}

function settleSourceTurn(
  context: SqliteStoreContext,
  ports: SqliteTerminalReportPublicationStorePorts,
  sourceTurn: LingTurn,
  workflow: ChannelWorkflow,
  itemId: string,
  targetStatus: "succeeded" | "blocked" | "failed" | "cancelled",
  now: string,
): StateTransitionEvent {
  if (sourceTurn.status !== targetStatus) {
    const terminal = targetStatus === "succeeded" || targetStatus === "failed" || targetStatus === "cancelled";
    const update = context.database.prepare(`
      UPDATE ling_turns
      SET status = ?, active_run_id = NULL, updated_at = ?, completed_at = ?
      WHERE workspace_id = ? AND id = ? AND status = ? AND updated_at = ?
    `).run(
      targetStatus,
      now,
      terminal ? sourceTurn.completedAt ?? now : null,
      sourceTurn.workspaceId,
      sourceTurn.id,
      sourceTurn.status,
      sourceTurn.updatedAt,
    );
    if (Number(update.changes) !== 1) throw new Error(`Source Turn settlement compare-and-set failed: ${sourceTurn.id}`);
  }
  const event = targetStatus === "succeeded"
    ? "succeed"
    : targetStatus === "blocked"
      ? sourceTurn.status === "blocked" ? "settle_blocked" : "block"
      : targetStatus === "failed" ? "fail" : "cancel";
  return ports.recordStateTransitionEvent({
    workspaceId: sourceTurn.workspaceId,
    entityType: "turn",
    entityId: sourceTurn.id,
    fromStatus: sourceTurn.status,
    toStatus: targetStatus,
    event,
    actor: "system",
    reason: `workflow:${workflow.id}:published:${itemId}`,
    idempotencyKey: settlementIdempotencyKey(workflow.id, itemId, targetStatus),
    createdAt: now,
  });
}

function publicationControlPlaneEvent(
  input: CommitWorkflowTerminalReportPublicationInput,
  report: LingTerminalReportRecord,
  workflow: ChannelWorkflow,
  cwd: string,
): AppendControlPlaneEventInput {
  return {
    workspaceId: report.workspaceId,
    cwd,
    domain: "work_units",
    entityType: "terminal_report",
    entityId: report.id,
    action: "terminal_report.published",
    data: {
      channelId: workflow.channelId,
      sourceKind: "workflow",
      sourceId: workflow.id,
      resultItemId: input.publicationItem.id!,
      status: report.status,
    },
    idempotencyKey: input.publicationEventIdempotencyKey,
  };
}

function sameControlPlaneEvent(existing: ControlPlaneEvent, input: AppendControlPlaneEventInput): boolean {
  return existing.workspaceId === input.workspaceId
    && existing.cwd === input.cwd
    && existing.domain === input.domain
    && existing.entityType === input.entityType
    && existing.entityId === input.entityId
    && existing.action === input.action
    && existing.idempotencyKey === input.idempotencyKey
    && JSON.stringify(existing.data) === JSON.stringify(input.data ?? {});
}
