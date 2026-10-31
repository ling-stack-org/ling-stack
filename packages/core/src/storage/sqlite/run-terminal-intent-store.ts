import { createHash, randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import type { HostOperationSource } from "../../host-operation-journal-types.js";
import { delegationDigest, delegationFence, delegationId, delegationJson, delegationRecord, delegationTimestamp } from "../../harness/delegation-write-validation.js";
import type { CreateRunArtifactInput, RunArtifact, RunSession, RunStore } from "../../run-types.js";
import type { RunTerminalIntentRecord, RunTerminalIntentReconcileResult, RunTerminalIntentV1 } from "../../run-terminal-intent-types.js";
import type { RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import { harnessArtifactOwnerHolder, readHarnessRetainedBody, syncHarnessArtifactOwnerPins } from "./harness-artifact-recovery-pins.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { RUN_TERMINAL_INTENT_MIGRATION_VERSION } from "./run-terminal-intent-migration.js";
import { hostAttemptReadScopeForSource } from "./host-attempt-read-scope.js";
import { isCurrentRunExecutionOwner } from "./run-execution-admission.js";
import type { SqliteStoreContext } from "./store-context.js";
import { assertUserInputDurableQuiescence } from "./user-input-durable-quiescence.js";
import { assertNoRunSuspensionAdmission } from "./run-suspension-store.js";

type Ports = Pick<RunStore, "getRun" | "getWorkUnit" | "getWorkUnitAttempt" | "getHostAttemptCompletion"
  | "getDelegationCompletionEvidence" | "transitionRunExecutionStatus" | "transitionWorkUnitStatus"
  | "updateWorkUnitAttemptStatus" | "appendTerminalRuntimeAudit" | "getTask" | "transitionTaskStatus"
  | "releaseResourceLeasesForAttempt" | "releaseRuntimeSemaphoreSlotsForAttempt" | "getArtifact"
  | "getControlPlaneEventByIdempotency" | "appendEvent"> & {
  readonly createArtifactWithinTransaction: (input: CreateRunArtifactInput) => RunArtifact;
  readonly appendControlPlaneEventWithinTransaction: RunStore["appendControlPlaneEvent"];
  /** Same owning transaction: measured allocation and sealed incoming child result. */
  readonly sealDelegatedTerminalWithinTransaction: (input: {
    readonly runId: string; readonly sourceFence: RuntimeAttemptFenceV1; readonly receipt: unknown; readonly now: string;
  }) => void;
};
type Row = Record<string, SQLOutputValue>;
const terminal = (status: string): boolean => ["succeeded", "failed", "cancelled"].includes(status);
function fail(code: string): never { throw new Error(`run_terminal_intent_${code}`); }

/** Diagnostics are not IDs. Keep the sealed authority bounded even for an empty
 * Error or a huge/JSON-escaped provider failure. A shortened excerpt carries the
 * exact original text digest; it is never used as stop or effect evidence. */
function terminalErrorMessage(value: unknown): string {
  if (typeof value !== "string") fail("invalid_error_message");
  const text = value.replaceAll("\0", "\\0");
  if (!text.trim()) return "Runner failed without an error message.";
  if (Buffer.byteLength(JSON.stringify(text), "utf8") <= 8192) return text;
  let excerpt = "", bytes = 0;
  for (const character of text) {
    const next = Buffer.byteLength(JSON.stringify(character), "utf8") - 2;
    if (bytes + next > 8000) break;
    excerpt += character; bytes += next;
  }
  return `${excerpt}\n[truncated; original sha256:${createHash("sha256").update(value, "utf8").digest("hex")}]`;
}

/** A veto only: intent is never a stopped-execution or effect-coverage receipt. */
export function hasPendingRunTerminalIntent(context: SqliteStoreContext, source: HostOperationSource): boolean {
  if (!hasTable(context)) return false;
  return Boolean(context.database.prepare(`SELECT 1 FROM run_terminal_intents WHERE run_id=? AND work_unit_id=?
    AND attempt_id=? AND runtime_instance_id=? AND fencing_token=? AND state='pending'`).get(source.runId,
      source.workUnitId, source.attemptId, source.runtimeInstanceId, source.fencingToken));
}

/** Persisted admission latch survives registry/process reconstruction. Cleanup writes remain allowed. */
export function assertNoPendingRunTerminalIntent(context: SqliteStoreContext, runId: string): void {
  if (!hasTable(context)) return;
  const ancestry = context.database.prepare(`WITH RECURSIVE ancestors(id,parent_run_id,depth) AS (
    SELECT id,parent_run_id,0 FROM run_sessions WHERE id=? UNION ALL
    SELECT r.id,r.parent_run_id,a.depth+1 FROM run_sessions r JOIN ancestors a ON r.id=a.parent_run_id WHERE a.depth<128
  ) SELECT a.id,a.depth,i.id AS intent_id FROM ancestors a LEFT JOIN run_terminal_intents i ON i.run_id=a.id AND i.state='pending'`)
    .all(runId);
  if (ancestry.some(row => row.intent_id !== null || row.depth === 128)) fail("admission_closed");
}
function hasTable(context: SqliteStoreContext): boolean {
  if (context.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='run_terminal_intents'").get()) return true;
  if (context.database.prepare(`SELECT 1 FROM schema_migrations WHERE version=${RUN_TERMINAL_INTENT_MIGRATION_VERSION}`).get()) fail("schema_missing");
  return false; // Only historical migration fixtures lack this not-yet-installed authority.
}

/** Constructor-private writer. No public RunStore route, JSON boolean, or model can call it. */
export class SqliteRunTerminalIntentStore {
  constructor(private readonly context: SqliteStoreContext, private readonly ports: Ports) {}

  prepareRunTerminalIntent(input: { readonly runId: string; readonly sourceFence: RuntimeAttemptFenceV1;
    readonly desiredOutcome: "failed" | "cancelled"; readonly errorCode: string; readonly errorMessage: string; readonly now: string }): RunTerminalIntentRecord {
    const request = delegationRecord(input, ["runId", "sourceFence", "desiredOutcome", "errorCode", "errorMessage", "now"]);
    const runId = delegationId(request.runId), sourceFence = delegationFence(request.sourceFence), now = delegationTimestamp(request.now);
    if (request.desiredOutcome !== "failed" && request.desiredOutcome !== "cancelled") fail("invalid_outcome");
    const errorCode = delegationId(request.errorCode), errorMessage = terminalErrorMessage(request.errorMessage);
    return this.write(() => {
      const old = this.getRunTerminalIntent(sourceFence.attemptId);
      if (old) {
        if (old.payload.runId !== runId || delegationDigest(old.payload.sourceFence) !== delegationDigest(sourceFence)
          || old.payload.desiredOutcome !== request.desiredOutcome || old.payload.errorCode !== errorCode || old.payload.errorMessage !== errorMessage) fail("conflict");
        return old; // Response-loss replay preserves the first original request time/context.
      }
      assertNoRunSuspensionAdmission(this.context, runId);
      const run = this.ports.getRun(runId), completion = this.ports.getHostAttemptCompletion({ runId, ...sourceFence });
      if (!run || !isCurrentRunExecutionOwner(this.context, runId, sourceFence, true) || !completion
        || completion.registeredAt > now) fail("source_invalid");
      const payload: RunTerminalIntentV1 = { schemaVersion: 1, kind: "run.terminal_intent.v1", runId, sourceFence,
        desiredOutcome: request.desiredOutcome as "failed" | "cancelled", contextDigest: contextDigest(run), errorCode, errorMessage, requestedAt: now };
      const digest = delegationDigest(payload), json = delegationJson(payload);
      const artifact = this.ports.createArtifactWithinTransaction({ runId, type: "json", path: "sqlite:run-terminal-intent",
        contentType: "application/json", sealedPayload: JSON.parse(json), contentSha256: digest,
        sizeBytes: Buffer.byteLength(json, "utf8"), createdAt: now });
      if (!this.context.database.isTransaction) fail("transaction_lost");
      const id = `run_terminal_intent_${randomUUID()}`;
      this.context.database.prepare(`INSERT INTO run_terminal_intents
        (id,run_id,work_unit_id,attempt_id,runtime_instance_id,fencing_token,artifact_id,digest,state,created_at)
        VALUES (?,?,?,?,?,?,?,?,'pending',?)`).run(id, runId, sourceFence.workUnitId, sourceFence.attemptId,
          sourceFence.runtimeInstanceId, sourceFence.fencingToken, artifact.id, digest, now);
      this.pins(id, artifact.id, true, now);
      return this.getRunTerminalIntent(sourceFence.attemptId)!;
    });
  }

  getRunTerminalIntent(attemptId: string): RunTerminalIntentRecord | undefined {
    const row = this.context.database.prepare("SELECT * FROM run_terminal_intents WHERE attempt_id=?").get(delegationId(attemptId));
    return row ? this.read(row) : undefined;
  }

  listUnfinishedRunTerminalIntents(input: { readonly cutoffAt: string; readonly limit: number;
    readonly after?: { readonly createdAt: string; readonly id: string } }): {
      readonly attemptIds: readonly string[]; readonly nextCursor?: { readonly createdAt: string; readonly id: string };
    } {
    const cutoff = delegationTimestamp(input.cutoffAt);
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) fail("invalid_page");
    const after = input.after ? { createdAt: delegationTimestamp(input.after.createdAt), id: delegationId(input.after.id) } : undefined;
    const rows = this.context.database.prepare(`SELECT id,attempt_id,created_at FROM run_terminal_intents WHERE notified_at IS NULL
      AND created_at<=? ${after ? "AND (created_at,id)>(?,?)" : ""} ORDER BY created_at,id LIMIT ?`)
      .all(cutoff, ...(after ? [after.createdAt, after.id] : []), input.limit + 1);
    const page = rows.slice(0, input.limit), last = page.at(-1);
    return { attemptIds: page.map(row => String(row.attempt_id)), ...(rows.length > input.limit && last
      ? { nextCursor: { createdAt: String(last.created_at), id: String(last.id) } } : {}) };
  }

  acknowledgeRunTerminalIntent(input: { readonly attemptId: string; readonly now: string }): void {
    const attemptId = delegationId(input.attemptId), now = delegationTimestamp(input.now);
    this.write(() => {
      const intent = this.getRunTerminalIntent(attemptId);
      if (!intent || intent.state !== "committed") fail("not_committed");
      if (intent.notifiedAt) return;
      const changed = this.context.database.prepare(`UPDATE run_terminal_intents SET notified_at=?
        WHERE attempt_id=? AND state='committed' AND notified_at IS NULL AND completed_at<=?`).run(now, attemptId, now);
      if (changed.changes !== 1) fail("ack_conflict");
    });
  }

  reconcileRunTerminalIntent(input: { readonly attemptId: string; readonly now: string; readonly receipt?: unknown }): RunTerminalIntentReconcileResult {
    const attemptId = delegationId(input.attemptId), now = delegationTimestamp(input.now);
    return this.write(() => {
      const intent = this.getRunTerminalIntent(attemptId);
      if (!intent) fail("missing");
      const { payload } = intent, source = { runId: payload.runId, ...payload.sourceFence };
      const run = this.ports.getRun(payload.runId), unit = this.ports.getWorkUnit(source.workUnitId), attempt = this.ports.getWorkUnitAttempt(attemptId);
      const blocked = (code: string): RunTerminalIntentReconcileResult => ({ status: "blocked", runId: payload.runId, code: `run_terminal_intent_${code}` });
      const pending = (code: string): RunTerminalIntentReconcileResult => ({ status: "pending", runId: payload.runId, code: `run_terminal_intent_${code}` });
      if (!run || !unit || !attempt || run.workUnitId !== unit.id || unit.linkedRunId !== run.id || unit.activeAttemptId !== attempt.id
        || delegationDigest({ workUnitId: attempt.workUnitId, attemptId: attempt.id, runtimeInstanceId: attempt.runtimeInstanceId, fencingToken: attempt.fencingToken }) !== delegationDigest(payload.sourceFence)
        || contextDigest(run) !== payload.contextDigest || now < payload.requestedAt) return blocked("source_changed");
      const desired = payload.desiredOutcome;
      const allTerminal = run.status === desired && unit.status === desired && attempt.status === desired
        && Boolean(run.endedAt && unit.endedAt && attempt.endedAt)
        && [run.endedAt!, unit.endedAt!, attempt.endedAt!].every(at => at <= now);
      if (intent.state === "committed") {
        if (!allTerminal) return blocked("terminal_changed");
        return { status: "committed", runId: run.id, replayed: true, controlPlaneEvents: this.events(intent, unit.workspaceId) };
      }
      // A pending intent cannot adopt another writer's terminal statuses.
      // Only our own atomic commit and its exact event idempotency receipts
      // authorize replay and the follow-up outbox.
      if (allTerminal) return blocked("terminal_owner_unverified");
      if (!allTerminal && !isCurrentRunExecutionOwner(this.context, run.id, payload.sourceFence, true)) return blocked("source_changed");
      const completion = this.ports.getHostAttemptCompletion(source);
      if (!completion?.drainedAt) return pending("original_host_pending");
      if (!completion.effectCoverage || completion.drainedAt > now || completion.registeredAt > completion.drainedAt) return blocked("effects_unverified");
      try { assertUserInputDurableQuiescence(this.context.database, run.id, payload.sourceFence, Date.parse(now), hostAttemptReadScopeForSource(this.context.database, source)); }
      catch { return blocked("quiescence_unverified"); }
      const evidence = this.ports.getDelegationCompletionEvidence({ rootRunIds: [run.id] });
      if (evidence.issues.length || evidence.steps.some(read => read.step.state === "lost")) return blocked("descendants_unverified");
      if (evidence.steps.some(read => !terminal(read.step.state))) return pending("descendants_pending");
      if (this.context.database.prepare(`SELECT 1 FROM delegation_budget_charges WHERE run_id=?
        AND state NOT IN ('measured','cancelled_before_dispatch') LIMIT 1`).get(run.id)) return blocked("usage_unverified");
      // Every status/audit/receipt/resource transition below belongs to this one
      // BEGIN IMMEDIATE. Any failed CAS or port rolls back the whole operation.
      if (!allTerminal) {
        const runResult = this.ports.transitionRunExecutionStatus({ runId: run.id, sourceFence: payload.sourceFence,
          expectedStatus: run.status, event: desired === "failed" ? "runner_failed" : "cancel", actor: "system",
          reason: payload.errorMessage, idempotencyKey: `${intent.id}:run`, now, endedAt: now, errorMessage: desired === "failed" ? payload.errorMessage : null });
        if (!runResult.ok) fail("run_cas_failed");
        if (desired === "cancelled" && unit.status !== "cancelling") {
          const cancelling = this.ports.transitionWorkUnitStatus({ ...payload.sourceFence, expectedStatus: unit.status, event: "cancel",
            actor: "system", reason: payload.errorMessage, idempotencyKey: `${intent.id}:cancelling`, now });
          if (!cancelling.ok) fail("unit_cas_failed");
        }
        const endedUnit = this.ports.transitionWorkUnitStatus({ ...payload.sourceFence,
          expectedStatus: desired === "cancelled" ? "cancelling" : unit.status,
          event: desired === "failed" ? "runner_failed" : "runner_cancelled", actor: "system", reason: payload.errorMessage,
          idempotencyKey: `${intent.id}:unit`, now, endedAt: now, errorCode: payload.errorCode, errorMessage: payload.errorMessage });
        if (!endedUnit.ok) fail("unit_cas_failed");
        const endedAttempt = this.ports.updateWorkUnitAttemptStatus({ ...payload.sourceFence, status: desired, now, endedAt: now,
          errorCode: payload.errorCode, errorMessage: payload.errorMessage });
        if (!endedAttempt) fail("attempt_cas_failed");
        this.ports.appendTerminalRuntimeAudit({ capability: { ...payload.sourceFence, attemptStatus: desired, transitionedAt: now },
          type: desired === "failed" ? "work_unit_failed" : "work_unit_cancelled", actor: "system",
          data: { fromStatus: unit.status, toStatus: desired, errorCode: payload.errorCode, errorMessage: payload.errorMessage } });
        const task = this.ports.getTask(run.taskId);
        if (task?.currentRunId === run.id && task.status === "running") {
          const taskResult = this.ports.transitionTaskStatus({ taskId: task.id, expectedStatus: task.status,
            event: desired === "failed" ? "run_failed" : "run_cancelled", actor: "system", reason: payload.errorMessage,
            idempotencyKey: `${intent.id}:task`, currentRunId: run.id, now });
          if (!taskResult.ok) fail("task_cas_failed");
        }
        this.ports.appendEvent(run.id, desired === "failed" ? "run_error" : "run_cancelled",
          desired === "failed" ? { message: payload.errorMessage } : { reason: payload.errorMessage }, now);
      }
      if (unit.ownerType === "delegation_step") {
        this.ports.sealDelegatedTerminalWithinTransaction({ runId: run.id, sourceFence: payload.sourceFence, receipt: input.receipt, now });
      }
      for (const [entityType, entityId, previousStatus, action] of [
        ["run", run.id, run.status, desired === "failed" ? "run.completed" : "run.cancelled"],
        ["work_unit", unit.id, unit.status, "work_unit.transitioned"],
      ] as const) this.ports.appendControlPlaneEventWithinTransaction({ workspaceId: unit.workspaceId, cwd: run.cwd,
        domain: entityType === "run" ? "runs" : "work_units", entityType, entityId, action,
        idempotencyKey: `${intent.id}:${entityType}:terminal`, data: { previousStatus, status: desired, runId: run.id,
          terminalAt: allTerminal ? run.endedAt : now, errorCode: payload.errorCode } }, now);
      const changed = this.context.database.prepare(`UPDATE run_terminal_intents SET state='committed',completed_at=?
        WHERE id=? AND state='pending' AND attempt_id=? AND fencing_token=?`).run(now, intent.id, attemptId, source.fencingToken);
      if (changed.changes !== 1) fail("intent_cas_failed");
      this.pins(intent.id, intent.artifactId, false, now);
      this.ports.releaseResourceLeasesForAttempt(payload.sourceFence, now, "run-finished");
      this.ports.releaseRuntimeSemaphoreSlotsForAttempt(payload.sourceFence, now, "run-finished");
      if (!this.context.database.isTransaction) fail("transaction_lost");
      return { status: "committed", runId: run.id, replayed: false, controlPlaneEvents: this.events(intent, unit.workspaceId) };
    });
  }

  private read(row: Row): RunTerminalIntentRecord {
    const retained = readHarnessRetainedBody(this.context.database, String(row.artifact_id));
    if (retained.bytes > 65_536 || retained.contentSha256 !== row.digest) fail("sealed_intent_invalid");
    const artifact = this.ports.getArtifact(String(row.artifact_id)), raw = artifact?.sealedPayload;
    if (!artifact || artifact.runId !== row.run_id || artifact.path !== "sqlite:run-terminal-intent" || !raw
      || artifact.contentSha256 !== row.digest || delegationDigest(raw) !== row.digest) fail("sealed_intent_invalid");
    const value = delegationRecord(raw, ["schemaVersion", "kind", "runId", "sourceFence", "desiredOutcome", "contextDigest", "errorCode", "errorMessage", "requestedAt"]);
    const fence = delegationFence(value.sourceFence);
    if (value.schemaVersion !== 1 || value.kind !== "run.terminal_intent.v1" || value.runId !== row.run_id
      || fence.workUnitId !== row.work_unit_id || fence.attemptId !== row.attempt_id || fence.runtimeInstanceId !== row.runtime_instance_id
      || fence.fencingToken !== row.fencing_token || !["failed", "cancelled"].includes(String(value.desiredOutcome))
      || value.requestedAt !== row.created_at || typeof value.contextDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.contextDigest)
      || delegationTimestamp(value.requestedAt) !== row.created_at || !delegationId(value.errorCode)
      || terminalErrorMessage(value.errorMessage) !== value.errorMessage) fail("sealed_intent_invalid");
    if (!this.context.database.prepare("SELECT 1 FROM harness_artifact_pins WHERE artifact_id=? AND holder=? AND reason='audit_hold' AND released_at IS NULL")
      .get(artifact.id, harnessArtifactOwnerHolder("run_terminal_intent_audit", String(row.id)))) fail("audit_pin_missing");
    if (row.state === "pending" && !this.context.database.prepare("SELECT 1 FROM harness_artifact_pins WHERE artifact_id=? AND holder=? AND reason='recovery' AND released_at IS NULL")
      .get(artifact.id, harnessArtifactOwnerHolder("run_terminal_intent", String(row.id)))) fail("recovery_pin_missing");
    return { id: String(row.id), artifactId: artifact.id, digest: String(row.digest), state: row.state as "pending" | "committed",
      ...(row.notified_at === null ? {} : { notifiedAt: String(row.notified_at) }), payload: raw as RunTerminalIntentV1 };
  }
  private pins(id: string, artifactId: string, keep: boolean, now: string): void {
    syncHarnessArtifactOwnerPins(this.context.database, { holder: harnessArtifactOwnerHolder("run_terminal_intent", id), artifactIds: [artifactId], keep, now });
    if (keep) syncHarnessArtifactOwnerPins(this.context.database, { holder: harnessArtifactOwnerHolder("run_terminal_intent_audit", id), artifactIds: [artifactId], keep: true, reason: "audit_hold", now });
  }
  private events(intent: RunTerminalIntentRecord, workspaceId: string) {
    const run = this.ports.getRun(intent.payload.runId);
    return ["run", "work_unit"].map(type => {
      const event = this.ports.getControlPlaneEventByIdempotency(workspaceId, `${intent.id}:${type}:terminal`);
      if (!event || !run?.endedAt || event.workspaceId !== workspaceId || event.cwd !== run.cwd
        || event.entityType !== type || event.entityId !== (type === "run" ? run.id : intent.payload.sourceFence.workUnitId)
        || event.domain !== (type === "run" ? "runs" : "work_units")
        || event.action !== (type === "run" ? intent.payload.desiredOutcome === "failed" ? "run.completed" : "run.cancelled" : "work_unit.transitioned")
        || event.data.runId !== run.id || event.data.status !== intent.payload.desiredOutcome
        || event.data.terminalAt !== run.endedAt || event.data.errorCode !== intent.payload.errorCode) fail("terminal_event_missing");
      return event;
    });
  }
  private write<T>(operation: () => T): T {
    this.context.database.exec("BEGIN IMMEDIATE");
    try { const value = operation(); this.context.database.exec("COMMIT"); return value; }
    catch (error) { rollbackOwnedSqliteTransaction(this.context.database); throw error; }
  }
}
function contextDigest(run: RunSession): string {
  return delegationDigest({ id: run.id, cwd: run.cwd, taskId: run.taskId, channelId: run.channelId, teammateId: run.teammateId,
    workflowStepId: run.workflowStepId, selectedSkillId: run.selectedSkillId, providerPresetId: run.providerPresetId,
    providerName: run.providerName, providerModel: run.providerModel, taskSnapshot: run.taskSnapshot, providerSnapshot: run.providerSnapshot,
    requestSnapshot: run.requestSnapshot, threadId: run.threadId, workUnitId: run.workUnitId, parentRunId: run.parentRunId,
    interventionId: run.interventionId, continuationReason: run.continuationReason, contextViewId: run.contextViewId,
    contextViewCreatedAt: run.contextViewCreatedAt, createdAt: run.createdAt });
}
