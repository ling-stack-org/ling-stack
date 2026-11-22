import { LING_AGENT_ID } from "../../workspace-types.js";
import type {
  LingAppServerCoordinationSchedule, LingAppServerCoordinationScheduleParams, LingAppServerScheduledCoordinationRound,
} from "@ling-stack/contracts";
import type {
  AdmitScheduledCoordinationInput, AutomationDefinition, AutomationRun, CloseScheduledCoordinationInput,
  ScheduledCoordinationAdmission, ScheduledCoordinationClose,
} from "../../automation-types.js";
import type { RunStore } from "../../run-types.js";
import { appendWorkItemCollaboration, findWorkItemCollaborationById, type AppendWorkItemCollaborationResult } from "../../work-item-collaboration.js";
import type { SqliteAppServerStateStore } from "./app-server-state-store.js";
import type { SqliteAutomationStore } from "./automation-store.js";
import type { SqliteControlPlaneStore } from "./control-plane-store.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";
import type { SqliteWorkItemEvidenceStore } from "./work-item-evidence-store.js";

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
        const record = findWorkItemCollaborationById(this.collaboration(), workItem.id, round.closedRecordId);
        return record ? { result: { status: "replayed", record, workItemRevision: workItem.revision } } : undefined;
      }
      const currentSequence = this.context.database.prepare("SELECT COALESCE(MAX(sequence),0) AS revision FROM work_item_evidence WHERE work_item_id=?")
        .get(workItem.id)?.revision;
      if (input.expectedWorkItemRevision !== undefined && input.expectedWorkItemRevision !== workItem.revision
        || input.expectedCollaborationRevision !== undefined && input.expectedCollaborationRevision !== currentSequence) {
        throw new Error("coordination_round_stale");
      }
      if (input.cause === "deadline" && round.deadlineAt > now) return undefined;
      const policy = this.schedule(round.automationId);
      const inputsCurrent = workItem.control.generation === round.controlGeneration && policy?.enabled && policy.revision === round.policyRevision;
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
          briefId: brief.record.id },
      }, now, cwd);
      if (!result) throw new Error("coordination_subject_unavailable");
      this.state.putWithinTransaction({ kind: "coordination_round", recordId: round.recordId, expectedRevision: saved.revision,
        payload: { ...round, closedRecordId: result.record.id } }, now);
      return { result, briefEvent: brief.event };
    });
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
