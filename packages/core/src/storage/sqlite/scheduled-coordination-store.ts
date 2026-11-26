import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DEFAULT_WORKSPACE_ID, LING_AGENT_ID } from "../../workspace-types.js";
import type {
  LingAppServerCoordinationDecisionReceipt, LingAppServerCoordinationSchedule, LingAppServerCoordinationScheduleParams,
  LingAppServerScheduledCoordinationRound,
} from "@ling-stack/contracts";
import type {
  AdmitScheduledCoordinationInput, AutomationDefinition, AutomationRun, CloseScheduledCoordinationInput,
  PendingScheduledCoordinationDecision, ScheduledCoordinationAdmission, ScheduledCoordinationClose,
  ScheduledCoordinationDecisionBasis, ScheduledCoordinationDecisionConsumption, ScheduledCoordinationDecisionPolicy,
  ScheduledCoordinationDecisionRequest,
} from "../../automation-types.js";
import { automationDefinitionDigestInput } from "../../automation-event-types.js";
import { automationEventDigest } from "../../automation-event-source.js";
import type { RunStore } from "../../run-types.js";
import { stageCoordinationToolReceiptId, type WorkItemCheckpointCoordinatorSource,
  type WorkItemCheckpointToolReceipt } from "../../work-item-stage-coordination.js";
import { appendWorkItemCollaboration, readWorkItemCollaborationRecord, type AppendWorkItemCollaborationInput,
  type AppendWorkItemCollaborationResult } from "../../work-item-collaboration.js";
import type { SqliteAppServerStateStore } from "./app-server-state-store.js";
import type { SqliteAutomationStore } from "./automation-store.js";
import type { SqliteControlPlaneStore } from "./control-plane-store.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { readSqliteWithinTransaction } from "./read-snapshot.js";
import type { SqliteStoreContext } from "./store-context.js";
import type { SqliteWorkItemEvidenceStore } from "./work-item-evidence-store.js";

interface DecisionSubmission {
  readonly id: string;
  readonly request: ScheduledCoordinationDecisionRequest;
  readonly policy: ScheduledCoordinationDecisionPolicy;
  readonly source?: LingAppServerCoordinationDecisionReceipt["source"];
  readonly basis?: ScheduledCoordinationDecisionBasis;
  readonly outcome?: { readonly evaluationId: string } | { readonly reasonCode: string };
}

interface DecisionBatch {
  readonly submissions: readonly DecisionSubmission[];
  readonly nextWorkItemRevision?: number;
  readonly seal?: Pick<PendingScheduledCoordinationDecision,
    "closedRecordId" | "throughEvidenceSequence" | "closedAt" | "controlGeneration" | "scheduleRevision" | "automationDefinitionDigest">;
}

const decisionState = "coordination_decisions";
const maxDecisionsPerRound = 12;

export class SqliteScheduledCoordinationStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly state: SqliteAppServerStateStore,
    private readonly automations: SqliteAutomationStore,
    private readonly evidence: SqliteWorkItemEvidenceStore,
    private readonly events: SqliteControlPlaneStore,
    private readonly workspace: Pick<RunStore, "getWorkItem" | "getLingThread">,
  ) {}

  schedule(automationId: string): LingAppServerCoordinationSchedule | undefined {
    return this.state.get("automation_coordination", automationId)?.payload as LingAppServerCoordinationSchedule | undefined;
  }

  configure(input: LingAppServerCoordinationScheduleParams, now: string): LingAppServerCoordinationSchedule {
    return this.transaction(() => {
      const { automationId, workItemId, kind, durationMs, expectedRevision, enabled } = input;
      const automation = this.automations.getAutomationDefinition(automationId);
      const workItem = this.workspace.getWorkItem(workItemId);
      if (!automation || automation.automationMode !== "cron" || automation.trigger.type !== "schedule"
        || !workItem || workItem.workspaceId !== automation.workspaceId
        || !this.workspace.getLingThread(automation.threadId)) throw new Error("coordination_target_unavailable");
      const old = this.schedule(automationId);
      if (old?.workItemId && old.workItemId !== workItemId || expectedRevision !== (old?.revision ?? 0)) {
        throw new Error("coordination_schedule_stale");
      }
      const schedule = { automationId, workItemId, kind, durationMs, enabled, revision: expectedRevision + 1 };
      this.state.putWithinTransaction({ kind: "automation_coordination", recordId: automationId, payload: schedule, expectedRevision }, now);
      return schedule;
    });
  }

  findRound(automationRunId: string): LingAppServerScheduledCoordinationRound | undefined {
    const binding = this.state.get("coordination_automation_run", automationRunId)?.payload as { recordId: string } | undefined;
    return binding ? this.readRound(binding.recordId) : undefined;
  }

  readRound(recordId: string): LingAppServerScheduledCoordinationRound | undefined {
    return this.state.get("coordination_round", recordId)?.payload as LingAppServerScheduledCoordinationRound | undefined;
  }

  listOpenRounds(): readonly LingAppServerScheduledCoordinationRound[] {
    return this.state.list("coordination_round").map(record => record.payload as LingAppServerScheduledCoordinationRound)
      .filter(round => !round.closedRecordId);
  }

  admit(input: AdmitScheduledCoordinationInput, now: string, cwd: string): ScheduledCoordinationAdmission {
    return this.transaction(() => {
      const existing = this.automations.findAutomationRunByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        if (existing.automationId !== input.automationId || existing.triggerType !== input.triggerType
          || existing.scheduledFor !== input.scheduledFor || !["succeeded", "skipped"].includes(existing.status)) {
          throw new Error("coordination_occurrence_conflict");
        }
        return { automationRun: existing, round: this.findRound(existing.id) };
      }
      const automation = this.automations.getAutomationDefinition(input.automationId);
      const policy = this.schedule(input.automationId);
      if (!automation || !policy || automation.status !== "enabled" || automation.trigger.type !== "schedule"
        || automation.automationMode !== "cron" || automation.updatedAt !== input.expectedDefinitionRevision
        || policy.revision !== input.expectedPolicyRevision
        || input.triggerType === "schedule" && (!input.scheduledFor || input.scheduledFor !== automation.nextRunAt || input.scheduledFor > now)) {
        throw new Error("coordination_schedule_stale");
      }
      const workItem = this.workspace.getWorkItem(policy.workItemId);
      const thread = this.workspace.getLingThread(automation.threadId);
      const skipReason = !workItem || !thread || thread.archivedAt || thread.status === "archived" ? "coordination_target_unavailable"
        : !policy.enabled || workItem.control.state !== "active" || workItem.holds.some(hold => hold.blocksNewAdmission)
          || ["archived", "cancelled", "superseded"].includes(workItem.status) ? "coordination_policy_denied"
          : this.listOpenRounds().some(round => round.workItemId === workItem.id && round.kind === policy.kind && round.deadlineAt > now)
            ? "coordination_already_open" : undefined;
      const automationRun = this.recordOccurrence(automation, input, now, skipReason);
      if (skipReason || !workItem) return { automationRun };
      const deadlineAt = new Date(Date.parse(now) + policy.durationMs).toISOString();
      const appended = this.append({
        workItemId: workItem.id, expectedWorkItemRevision: workItem.revision, kind: "coordination", action: "started",
        actorId: LING_AGENT_ID, idempotencyKey: `coordination-open:${automationRun.id}`,
        payload: {
          kind: policy.kind, status: "open", subjectRevision: workItem.revision, policyRevision: policy.revision,
          deadlineAt, trigger: { kind: input.triggerType, automationId: automation.id, automationRunId: automationRun.id, scheduledFor: input.scheduledFor },
        },
      }, now, cwd);
      if (!appended) throw new Error("coordination_subject_unavailable");
      const round: LingAppServerScheduledCoordinationRound = {
        automationId: automation.id, automationRunId: automationRun.id, workItemId: workItem.id, kind: policy.kind,
        automationDefinitionDigest: automationEventDigest(automationDefinitionDigestInput(automation)),
        policyRevision: policy.revision, subjectRevision: workItem.revision, controlGeneration: workItem.control.generation,
        recordId: appended.record.id, deadlineAt, ...(input.scheduledFor ? { scheduledFor: input.scheduledFor } : {}),
      };
      this.state.putWithinTransaction({ kind: "coordination_round", recordId: round.recordId, expectedRevision: 0, payload: round }, now);
      this.state.putWithinTransaction({ kind: "coordination_automation_run", recordId: automationRun.id, expectedRevision: 0,
        payload: { recordId: round.recordId } }, now);
      return { automationRun, round, event: appended.event };
    });
  }

  close(input: CloseScheduledCoordinationInput, now: string, cwd: string): ScheduledCoordinationClose | undefined {
    return this.transaction(() => {
      const saved = this.state.get("coordination_round", input.recordId);
      const round = saved?.payload as LingAppServerScheduledCoordinationRound | undefined;
      const workItem = this.workspace.getWorkItem(input.workItemId);
      if (!saved || !round || round.workItemId !== input.workItemId || !workItem) return undefined;
      if (round.closedRecordId) {
        const record = readWorkItemCollaborationRecord(this.evidence, workItem.id, round.closedRecordId);
        return record ? { result: { status: "replayed", record, workItemRevision: workItem.revision } } : undefined;
      }
      const currentSequence = Number(this.context.database.prepare(
        "SELECT COALESCE(MAX(sequence),0) AS revision FROM work_item_evidence WHERE workspace_id=? AND work_item_id=?",
      ).get(workItem.workspaceId, workItem.id)?.revision ?? 0);
      if (input.expectedWorkItemRevision !== undefined && input.expectedWorkItemRevision !== workItem.revision
        || input.expectedCollaborationRevision !== undefined && input.expectedCollaborationRevision !== currentSequence) {
        throw new Error("coordination_round_stale");
      }
      if (input.cause === "deadline" && round.deadlineAt > now) return undefined;
      const automationDigest = this.currentAutomationDigest(round);
      const inputsCurrent = workItem.control.generation === round.controlGeneration && automationDigest !== undefined;
      const disposition = inputsCurrent ? "closed" : "stale";
      const closeReason = inputsCurrent ? input.cause : "inputs_changed";
      const brief = this.append({
        workItemId: workItem.id, kind: "brief", action: "created", actorId: input.actorId, parentRecordId: round.recordId,
        idempotencyKey: `coordination-brief:${round.recordId}`,
        payload: { kind: round.kind, status: disposition, throughEvidenceSequence: currentSequence,
          workItemStatus: workItem.status, holds: workItem.holds.map(hold => ({ id: hold.id, kind: hold.kind })) },
      }, now, cwd);
      if (!brief) throw new Error("coordination_subject_unavailable");
      const result = this.append({
        workItemId: workItem.id, kind: "coordination", action: "closed", actorId: input.actorId, parentRecordId: round.recordId,
        idempotencyKey: `coordination-close:${round.recordId}`,
        payload: { status: disposition, closeReason, deadlineAt: round.deadlineAt, throughEvidenceSequence: currentSequence,
          planRevision: workItem.planRevision ?? null,
          briefId: brief.record.id },
      }, now, cwd);
      if (!result) throw new Error("coordination_subject_unavailable");
      this.state.putWithinTransaction({ kind: "coordination_round", recordId: round.recordId, expectedRevision: saved.revision,
        payload: { ...round, closedRecordId: result.record.id } }, now);
      const stored = this.decisionBatch(round.recordId);
      if (stored) {
        const readBasis = input.readDecisionBasis;
        if (inputsCurrent && !readBasis) throw new Error("coordination_decision_basis_unavailable");
        const submissions = stored.batch.submissions.map(submission => {
          if (!inputsCurrent || !readBasis) return { ...submission, outcome: { reasonCode: "coordination_inputs_changed" } };
          if (workItem.planRevision !== submission.request.subject.planRevision) return { ...submission, outcome: { reasonCode: "accepted_plan_changed" } };
          const basis = readSqliteWithinTransaction(this.context.database,
            () => readBasis(submission.request, submission.policy.channelId, currentSequence, submission.source));
          if ("reasonCode" in basis) return { ...submission, outcome: basis };
          if (basis.policyRevision !== submission.policy.policyRevision || basis.channelId !== submission.policy.channelId) {
            return { ...submission, outcome: { reasonCode: "deliberation_policy_changed" } };
          }
          return { ...submission, basis };
        });
        const seal = inputsCurrent && automationDigest ? {
          closedRecordId: result.record.id, throughEvidenceSequence: currentSequence, closedAt: now,
          controlGeneration: round.controlGeneration, scheduleRevision: round.policyRevision, automationDefinitionDigest: automationDigest,
        } : undefined;
        this.writeDecisions(round.recordId, stored.revision, { ...stored.batch, submissions, seal,
          nextWorkItemRevision: result.workItemRevision }, now);
      }
      return { result, briefEvent: brief.event };
    });
  }

  registerDecision(request: ScheduledCoordinationDecisionRequest, expectedWorkItemRevision: number, now: string,
    readPolicy: () => ScheduledCoordinationDecisionPolicy, coordinator?: WorkItemCheckpointCoordinatorSource & { readonly assertCurrent: () => void }) {
    return this.transaction(() => {
      const round = this.readRound(request.roundId);
      if (round?.workItemId !== request.workItemId || round.kind !== "checkpoint") throw new Error("coordination_subject_unavailable");
      if (coordinator) readSqliteWithinTransaction(this.context.database, coordinator.assertCurrent);
      const stored = this.decisionBatch(round.recordId);
      const batch = stored?.batch ?? { submissions: [] };
      const source: DecisionSubmission["source"] = coordinator && {
        actorId: LING_AGENT_ID, runId: coordinator.source.runId, attemptId: coordinator.source.attemptId,
      };
      const previous = batch.submissions.find(submission => submission.request.idempotencyKey === request.idempotencyKey);
      if (previous) {
        if (!isDeepStrictEqual(previous.request, request) || !isDeepStrictEqual(previous.source, source)) {
          throw new Error("coordination_decision_idempotency_conflict");
        }
        if (coordinator) this.recordCoordinatorRegistration(coordinator, request, previous.id, now);
        return { receipt: this.projectDecision(batch, previous), replayed: true };
      }
      const item = this.workspace.getWorkItem(request.workItemId);
      if (round.closedRecordId || round.deadlineAt <= now || item?.revision !== expectedWorkItemRevision
        || item.control.generation !== round.controlGeneration || !this.currentAutomationDigest(round)) {
        throw new Error("coordination_round_stale");
      }
      if (batch.submissions.length >= maxDecisionsPerRound) throw new Error("coordination_decision_limit");
      const policy = readSqliteWithinTransaction(this.context.database, readPolicy);
      const id = `coordination_decision_${createHash("sha256").update(JSON.stringify([round.recordId, request.idempotencyKey])).digest("hex")}`;
      const submission = { id, request, policy, ...(source ? { source } : {}) };
      this.writeDecisions(round.recordId, stored?.revision ?? 0, { ...batch, submissions: [...batch.submissions, submission] }, now);
      if (coordinator) this.recordCoordinatorRegistration(coordinator, request, id, now);
      return { receipt: this.projectDecision(batch, submission), replayed: false };
    });
  }

  private recordCoordinatorRegistration(coordinator: WorkItemCheckpointCoordinatorSource,
    request: ScheduledCoordinationDecisionRequest, receiptId: string, now: string): void {
    const { source, toolCallId, threadId, requestDigest } = coordinator;
    const recordId = stageCoordinationToolReceiptId(source.runId, source.attemptId, toolCallId);
    const payload: WorkItemCheckpointToolReceipt = { source, toolCallId, threadId, requestDigest, scope: "coordinator",
      outcome: { status: "registered", roundId: request.roundId, workItemId: request.workItemId, receiptId } };
    const prior = this.state.get("work_item_stage_tool_receipt", recordId);
    if (prior) {
      if (!isDeepStrictEqual(prior.payload, payload)) throw new Error("coordination_decision_idempotency_conflict");
      return;
    }
    if (!this.state.putWithinTransaction({ kind: "work_item_stage_tool_receipt", recordId, expectedRevision: 0, payload }, now)) {
      throw new Error("coordination_tool_receipt_changed");
    }
  }

  readDecisions(workItemId: string, roundId: string): readonly LingAppServerCoordinationDecisionReceipt[] {
    if (this.readRound(roundId)?.workItemId !== workItemId) throw new Error("coordination_subject_unavailable");
    const batch = this.decisionBatch(roundId)?.batch;
    return batch?.submissions.map(submission => this.projectDecision(batch, submission)) ?? [];
  }

  listPendingDecisionRounds(limit: number): string[] {
    return this.context.database.prepare(`
      SELECT record_id FROM app_server_state WHERE workspace_id=? AND kind=?
        AND json_extract(payload_json, '$.seal') IS NOT NULL
        AND EXISTS (SELECT 1 FROM json_each(payload_json, '$.submissions') decision
          WHERE json_extract(decision.value, '$.outcome') IS NULL)
      ORDER BY updated_at, record_id LIMIT ?
    `).all(DEFAULT_WORKSPACE_ID, decisionState, limit).map(row => String(row.record_id));
  }

  pendingDecision(roundId: string): PendingScheduledCoordinationDecision | undefined {
    const batch = this.decisionBatch(roundId)?.batch;
    if (!batch?.seal || batch.nextWorkItemRevision === undefined) return undefined;
    const submission = batch.submissions.find(entry => !entry.outcome);
    if (!submission?.basis) return undefined;
    return { ...batch.seal, roundId, receiptId: submission.id, expectedWorkItemRevision: batch.nextWorkItemRevision,
      request: submission.request, basis: submission.basis, source: submission.source };
  }

  settleDecision(input: ScheduledCoordinationDecisionConsumption, outcome: NonNullable<DecisionSubmission["outcome"]>, now: string): boolean {
    return this.transaction(() => this.settleWithinTransaction(input, outcome, input.expectedWorkItemRevision, now));
  }

  appendEvaluation(input: ScheduledCoordinationDecisionConsumption, evaluation: AppendWorkItemCollaborationInput,
    now: string, cwd: string): AppendWorkItemCollaborationResult | undefined {
    return this.transaction(() => {
      const result = this.append(evaluation, now, cwd);
      if (result) this.completeEvaluationWithinTransaction(input, result.record.id, result.workItemRevision, now);
      return result;
    });
  }

  completeEvaluationWithinTransaction(input: ScheduledCoordinationDecisionConsumption, evaluationId: string,
    workItemRevision: number, now: string): void {
    if (!this.settleWithinTransaction(input, { evaluationId }, workItemRevision, now)) throw new Error("coordination_decision_consumption_changed");
  }

  private settleWithinTransaction(input: ScheduledCoordinationDecisionConsumption, outcome: NonNullable<DecisionSubmission["outcome"]>,
    workItemRevision: number, now: string): boolean {
    const stored = this.decisionBatch(input.roundId);
    const batch = stored?.batch;
    const pendingIndex = batch?.submissions.findIndex(entry => !entry.outcome) ?? -1;
    const submission = batch?.submissions[pendingIndex];
    if (!stored || !batch?.seal || !submission || submission.id !== input.receiptId
      || batch.nextWorkItemRevision !== input.expectedWorkItemRevision) return false;
    if ("evaluationId" in outcome && this.workspace.getWorkItem(submission.request.workItemId)?.revision !== workItemRevision) {
      return false;
    }
    const submissions = batch.submissions.slice();
    submissions[pendingIndex] = { ...submission, outcome };
    this.writeDecisions(input.roundId, stored.revision, { ...batch, submissions, nextWorkItemRevision: workItemRevision }, now);
    return true;
  }

  currentAutomationDigest(round: LingAppServerScheduledCoordinationRound): string | undefined {
    const policy = this.schedule(round.automationId);
    const automation = this.automations.getAutomationDefinition(round.automationId);
    if (!policy?.enabled || policy.revision !== round.policyRevision || policy.workItemId !== round.workItemId
      || automation?.status !== "enabled") return undefined;
    const home = this.workspace.getLingThread(automation.threadId);
    if (!home || home.status === "archived" || home.archivedAt) return undefined;
    const digest = automationEventDigest(automationDefinitionDigestInput(automation));
    return !round.automationDefinitionDigest || round.automationDefinitionDigest === digest ? digest : undefined;
  }

  private decisionBatch(roundId: string) {
    const record = this.state.get(decisionState, roundId);
    return record && { revision: record.revision, batch: record.payload as DecisionBatch };
  }

  private writeDecisions(roundId: string, expectedRevision: number, batch: DecisionBatch, now: string): void {
    if (!this.state.putWithinTransaction({ kind: decisionState, recordId: roundId, expectedRevision, payload: batch }, now)) {
      throw new Error("coordination_decisions_changed");
    }
  }

  private projectDecision(batch: DecisionBatch, { id, request, source, outcome }: DecisionSubmission): LingAppServerCoordinationDecisionReceipt {
    const identity = { id, decisionKey: request.decisionKey, roundId: request.roundId, ...(source ? { source } : {}) };
    if (!outcome) return { ...identity, status: batch.seal ? "pending" : "registered" };
    return "evaluationId" in outcome ? { ...identity, status: "evaluated", ...outcome } : { ...identity, status: "stale", ...outcome };
  }

  private recordOccurrence(automation: AutomationDefinition, input: AdmitScheduledCoordinationInput, now: string, skipReason?: string): AutomationRun {
    return this.automations.createAutomationRun({
      automationId: automation.id, workspaceId: automation.workspaceId, channelId: automation.channelId, threadId: automation.threadId,
      triggerType: input.triggerType, scheduledFor: input.scheduledFor, firedAt: now, completedAt: now,
      status: skipReason ? "skipped" : "succeeded", skipReason, idempotencyKey: input.idempotencyKey,
    }, now);
  }

  private append(input: Parameters<typeof appendWorkItemCollaboration>[1], now: string, cwd: string): AppendWorkItemCollaborationResult | undefined {
    return appendWorkItemCollaboration(this.collaboration(), input, now, cwd);
  }

  private collaboration(): Parameters<typeof appendWorkItemCollaboration>[0] {
    return {
      getWorkItem: id => this.workspace.getWorkItem(id),
      listWorkItemEvidence: options => this.evidence.listWorkItemEvidence(options),
      appendWorkItemEvidence: (input, now, event) => this.evidence.appendWithinTransaction(input, now, event && { ...event, store: this.events }),
    };
  }

  private transaction<T>(operation: () => T): T {
    const { database } = this.context;
    database.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      database.exec("COMMIT");
      return value;
    } catch (error) {
      rollbackOwnedSqliteTransaction(database);
      throw error;
    }
  }
}
