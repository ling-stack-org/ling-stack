import { nativeTaskIntakeRevision, nativeWorkIntakeReceiptId, nativeWorkIntakeRetryReceiptId } from "../../native-work-intake-identity.js";
import type { NativeWorkIntakeReceipt, NativeWorkIntakeSourceKind } from "@ling-stack/contracts";
import type { NativeWorkIntakeInput, NativeWorkIntakeRecord, NativeWorkIntakeResult } from "../../native-work-intake-types.js";
import type { AutomationRun, CreateAutomationRunInput } from "../../automation-types.js";
import { DEFAULT_WORKSPACE_ID, type CreateTaskInput, type Task } from "../../workspace-types.js";
import type { SqliteAppServerStateStore } from "./app-server-state-store.js";
import type { SqliteControlPlaneStore } from "./control-plane-store.js";
import type { SqliteWorkItemStore } from "./work-item-store.js";
import type { SqliteAutomationStore } from "./automation-store.js";
import type { SqliteTaskStore } from "./task-store.js";
import type { SqliteStoreContext } from "./store-context.js";
import { parseJson, readString, rollbackOwnedSqliteTransaction } from "./helpers.js";

type Evaluation = Pick<NativeWorkIntakeReceipt, "outcome" | "reasonCode">;

export class SqliteNativeWorkIntakeStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly state: SqliteAppServerStateStore,
    private readonly items: SqliteWorkItemStore,
    private readonly events: SqliteControlPlaneStore,
    private readonly tasks: SqliteTaskStore,
    private readonly automations: SqliteAutomationStore,
  ) {}

  createTask(input: CreateTaskInput, intake: Omit<NativeWorkIntakeInput, "sourceEventId" | "sourceRevision">,
    now: string, cwd: string): NativeWorkIntakeResult<Task> {
    return this.commit(now, cwd, () => {
      const existing = input.id ? this.tasks.getTask(input.id) : undefined;
      const retained = input.id ? this.state.get("native_intake_receipt", nativeWorkIntakeReceiptId("channel_task", input.id))
        ?.payload as NativeWorkIntakeRecord | undefined : undefined;
      if (retained && !existing) throw new Error("native_intake_occurrence_conflict");
      const task = existing ?? this.tasks.createTask(input, now);
      const sourceRevision = nativeTaskIntakeRevision({ ...task, ...input, attachmentIds: input.attachmentIds ?? [] });
      if (existing && retained?.receipt.sourceRevision !== sourceRevision) throw new Error("native_intake_occurrence_conflict");
      return { execution: task, title: task.title, input: {
        ...intake, sourceEventId: task.id, sourceRevision,
        blocker: intake.blocker ?? (task.status !== "todo" ? "task_not_todo" : undefined),
      } };
    });
  }

  createAutomationRun(input: CreateAutomationRunInput, intake: NativeWorkIntakeInput, title: string,
    now: string, cwd: string): NativeWorkIntakeResult<AutomationRun> {
    return this.commit(now, cwd, () => {
      const execution = this.automations.findAutomationRunByIdempotencyKey(input.idempotencyKey)
        ?? this.automations.createAutomationRun(input, now);
      if (execution.automationId !== input.automationId) throw new Error("native_intake_occurrence_conflict");
      return { execution, title, input: intake };
    }, (execution, receipt) => {
      if (receipt.outcome === "manual" || receipt.outcome === "deduplicated") return execution;
      return this.automations.updateAutomationRun(execution.id, {
        status: "skipped", skipReason: `intake_${receipt.reasonCode}`, completedAt: now,
      }, now)!;
    });
  }

  retry(request: import("@ling-stack/contracts").RetryNativeWorkIntakeRequest,
    intake: NativeWorkIntakeInput, now: string, cwd: string): NativeWorkIntakeResult<Task | AutomationRun> {
    return this.commit(now, cwd, () => {
      const record = this.state.get("native_intake_receipt", request.receiptId)?.payload as NativeWorkIntakeRecord | undefined;
      if (!record) throw new Error("native_intake_retry_conflict");
      const { executionId, sourceKind } = record.receipt;
      const task = sourceKind === "channel_task" ? this.tasks.getTask(executionId) : undefined;
      const automationRun = sourceKind === "automation_run" ? this.automations.getAutomationRun(executionId) : undefined;
      const execution = task ?? automationRun;
      const automation = automationRun ? this.automations.getAutomationDefinition(automationRun.automationId) : undefined;
      if (!execution || task && nativeTaskIntakeRevision(task) !== record.receipt.sourceRevision) {
        throw new Error("native_intake_retry_conflict");
      }
      return { execution, title: task?.title ?? automation?.title ?? "Automation occurrence", input: {
        ...intake, monitorSnapshot: record.monitorSnapshot, eventDispatchId: record.eventDispatchId,
      } };
    }, undefined, request);
  }

  private commit<T extends Task | AutomationRun>(
    now: string,
    cwd: string,
    create: () => { readonly execution: T; readonly title: string; readonly input: NativeWorkIntakeInput },
    settle?: (execution: T, receipt: NativeWorkIntakeReceipt) => T,
    retry?: { readonly receiptId: string; readonly idempotencyKey: string },
  ): NativeWorkIntakeResult<T> {
    const { database } = this.context;
    database.exec("BEGIN IMMEDIATE");
    try {
      const { execution, title, input } = create();
      const { policy, sourceEventId, sourceRevision, monitorSnapshot, eventDispatchId } = input;
      const { workspaceId } = execution;
      const receiptId = retry ? nativeWorkIntakeRetryReceiptId(policy.sourceKind, sourceEventId, retry.receiptId, retry.idempotencyKey)
        : nativeWorkIntakeReceiptId(policy.sourceKind, sourceEventId);
      const retained = this.state.get("native_intake_receipt", receiptId, workspaceId)?.payload as NativeWorkIntakeRecord | undefined;
      if (retained) {
        if (retained.receipt.executionId !== execution.id || retained.receipt.sourceScope !== policy.sourceScope) {
          throw new Error("native_intake_occurrence_conflict");
        }
        database.exec("COMMIT");
        return { execution, receipt: retained.receipt };
      }
      const prior = retry ? this.state.get("native_intake_receipt", retry.receiptId, workspaceId) : undefined;
      if (retry) {
        const previous = prior?.payload as NativeWorkIntakeRecord | undefined;
        const receipt = previous?.receipt;
        if (!prior || !previous || previous.retryReceiptId || receipt?.executionId !== execution.id
          || receipt.sourceRevision !== sourceRevision || receipt.sourceScope !== policy.sourceScope
          || !(receipt.outcome === "paused" || receipt.outcome === "suppressed" || receipt.dispatch?.status === "held")) {
          throw new Error("native_intake_retry_conflict");
        }
        this.state.putWithinTransaction({ kind: "native_intake_receipt", recordId: prior.recordId, workspaceId,
          expectedRevision: prior.revision, payload: { ...previous, retryReceiptId: receiptId } satisfies NativeWorkIntakeRecord }, now);
      }
      const runId = "currentRunId" in execution ? execution.currentRunId : "runId" in execution ? execution.runId : undefined;
      const decision = this.evaluate(input, now, workspaceId, Boolean(runId));
      const attached = decision.outcome === "accepted" || decision.outcome === "suggested" || decision.outcome === "deduplicated"
        ? this.items.createWithinTransaction({
          sourceType: policy.sourceKind, sourceId: execution.id, title: title.slice(0, 500), priority: policy.priority,
          linkExistingExecution: true,
        }, now, this.state, { store: this.events, cwd }) : undefined;
      const receipt: NativeWorkIntakeReceipt = {
        ...decision, receiptId, workspaceId, policyId: policy.policyId, policyRevision: policy.policyRevision,
        sourceKind: policy.sourceKind, sourceScope: policy.sourceScope, sourceEventId, sourceRevision,
        executionId: execution.id, evaluatedAt: now, workItemId: attached?.workItem.id,
        ...(retry ? { previousReceiptId: retry.receiptId } : {}),
        ...(decision.outcome === "accepted" ? { dispatch: { status: "pending" } } : {}),
      };
      const result = settle?.(execution, receipt) ?? execution;
      this.state.putWithinTransaction({ kind: "native_intake_receipt", recordId: receiptId, workspaceId,
        expectedRevision: 0, payload: { receipt, monitorSnapshot, eventDispatchId } satisfies NativeWorkIntakeRecord }, now);
      database.exec("COMMIT");
      return { execution: result, receipt, event: attached?.event };
    } catch (error) {
      rollbackOwnedSqliteTransaction(database);
      throw error;
    }
  }

  private evaluate(input: NativeWorkIntakeInput, now: string, workspaceId: string, alreadyStarted: boolean): Evaluation {
    const { policy } = input;
    if (!policy.enabled) return { outcome: "paused", reasonCode: "policy_disabled" };
    if (policy.mode === "manual") return { outcome: "manual", reasonCode: "manual_intake" };
    if (alreadyStarted) return { outcome: "deduplicated", reasonCode: "existing_execution" };
    if (input.blocker) return { outcome: "suppressed", reasonCode: input.blocker };
    if (policy.mode === "suggest") return { outcome: "suggested", reasonCode: "suggested_for_acceptance" };
    if (policy.quiet) return { outcome: "suppressed", reasonCode: "quiet_hours" };
    const budget = policy.budget;
    if (!budget) throw new Error("native_intake_budget_required");
    const windowStart = new Date(Date.parse(now) - budget.windowMs).toISOString();
    const counts = this.context.database.prepare(`
      SELECT COUNT(CASE WHEN state.created_at >= ? THEN 1 END) AS starts,
        COUNT(CASE WHEN run.status IN ('queued', 'running', 'waiting_for_approval', 'yielded')
          OR (json_extract(state.payload_json, '$.receipt.dispatch.status') = 'pending'
            AND (task.status = 'todo' OR automation.status IN ('queued', 'skipped'))) THEN 1 END) AS concurrent
      FROM app_server_state state
      LEFT JOIN tasks task ON json_extract(state.payload_json, '$.receipt.sourceKind') = 'channel_task'
        AND task.id = json_extract(state.payload_json, '$.receipt.executionId')
      LEFT JOIN automation_runs automation ON json_extract(state.payload_json, '$.receipt.sourceKind') = 'automation_run'
        AND automation.id = json_extract(state.payload_json, '$.receipt.executionId')
      LEFT JOIN run_sessions run ON run.id = COALESCE(task.current_run_id, automation.run_id)
      WHERE state.workspace_id = ? AND state.kind = 'native_intake_receipt'
        AND json_extract(state.payload_json, '$.receipt.policyId') = ?
        AND json_extract(state.payload_json, '$.receipt.outcome') = 'accepted'
    `).get(windowStart, workspaceId, policy.policyId);
    if (Number(counts?.starts) >= budget.maxStartsPerWindow) return { outcome: "suppressed", reasonCode: "start_budget_exhausted" };
    if (Number(counts?.concurrent) >= budget.maxConcurrent) return { outcome: "suppressed", reasonCode: "concurrency_limit" };
    return { outcome: "accepted", reasonCode: "automatic_intake_reserved" };
  }

  list(sourceKind: NativeWorkIntakeSourceKind, sourceScope: string | undefined, limit: number, pendingBefore?: string): NativeWorkIntakeReceipt[] {
    const { database } = this.context;
    return database.prepare(`
      SELECT payload_json FROM app_server_state
      WHERE workspace_id = ? AND kind = 'native_intake_receipt'
        AND json_extract(payload_json, '$.receipt.sourceKind') = ?
        AND (? IS NULL OR json_extract(payload_json, '$.receipt.sourceScope') = ?)
        AND (? IS NULL OR (json_extract(payload_json, '$.receipt.dispatch.status') = 'pending' AND updated_at <= ?))
      ORDER BY ${pendingBefore ? "updated_at ASC" : "created_at DESC"}, record_id ASC LIMIT ?
    `).all(DEFAULT_WORKSPACE_ID, sourceKind, sourceScope ?? null, sourceScope ?? null, pendingBefore ?? null, pendingBefore ?? null, limit)
      .map(row => (parseJson(readString(row, "payload_json")) as NativeWorkIntakeRecord).receipt);
  }
}
