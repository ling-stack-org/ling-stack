import type { GoalContinuationEvidenceDelta, RunIntervention, RunSession, RunStore } from "../../run-types.js";
import { defaultGoalSupervisionPolicy } from "../../goal-supervision.js";
import type { SqliteStoreContext } from "./store-context.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

interface GoalSupervisionStore {
  listEligibleSources(limit?: number): RunSession[];
  reconcileAcceptance(threadId: string, now: string): boolean;
  queue(input: { readonly goalId: string; readonly expectedUpdatedAt: string; readonly sourceRunId: string;
    readonly instruction: string; readonly noEvidenceCount: number; readonly evidenceDelta: GoalContinuationEvidenceDelta; readonly now: string }): RunIntervention | undefined;
}
const adapters = new WeakMap<RunStore, GoalSupervisionStore>();
export function createSqliteGoalSupervisionStore(store: RunStore): GoalSupervisionStore {
  const adapter = adapters.get(store);
  if (!adapter) throw new Error("goal_supervision_store_unavailable");
  return adapter;
}
export function registerSqliteGoalSupervisionStore(store: RunStore, context: SqliteStoreContext): void {
  const db = context.database;
  adapters.set(store, {
    listEligibleSources(limit = 100) {
      return db.prepare(`SELECT r.id FROM ling_thread_goals g JOIN ling_threads t ON t.id=g.thread_id
        JOIN run_sessions r ON r.id=t.last_run_id WHERE g.status='active' AND g.last_run_id=r.id
        AND t.status<>'archived' AND r.status IN ('succeeded','failed') ORDER BY g.updated_at LIMIT ?`)
        .all(Math.max(1, Math.min(100, limit))).flatMap(row => { const run = store.getRun(String(row.id)); return run ? [run] : []; });
    },
    reconcileAcceptance(threadId, now) {
      if (db.isTransaction) throw new Error("goal_supervision_transaction_owned");
      db.exec("BEGIN IMMEDIATE");
      try {
        const goal = store.getLingThreadGoal(threadId);
        const criteria = goal?.acceptanceCriteria;
        if (!goal || goal.status !== "active" || !goal.supervisionPolicy?.autoComplete || !criteria?.length || criteria.some(item => !item.evidenceId)) {
          db.exec("COMMIT"); return false;
        }
        const evidence = criteria.map(item => ({ criterionId: item.id, evidence: {
          kind: item.kind === "run_succeeded" ? "run" as const : item.kind === "workflow_succeeded" ? "workflow" as const : "artifact" as const, id: item.evidenceId!,
        } }));
        store.updateLingThreadGoal(goal.id, { status: "complete", completedBy: "ling-agent", completedReason: "Declared acceptance evidence verified",
          acceptanceEvidence: evidence, completionEvidenceRefs: evidence.map(item => item.evidence),
          completionVerificationSummary: criteria.map(item => `${item.id}: ${item.kind} ${item.evidenceId}`).join("\n"),
          continuationChainId: null, blockedReason: null, lastContinuationStopReason: null, lastContinuationStoppedAt: null }, now);
        db.exec("COMMIT"); return true;
      } catch (error) {
        rollbackOwnedSqliteTransaction(db);
        if (error instanceof Error && /^goal_(completion|acceptance)_/.test(error.message)) return false;
        throw error;
      }
    },
    queue(input) {
      if (db.isTransaction) throw new Error("goal_supervision_transaction_owned");
      db.exec("BEGIN IMMEDIATE");
      try {
        const run = store.getRun(input.sourceRunId), goal = run?.threadId ? store.getLingThreadGoal(run.threadId) : undefined;
        const thread = goal && store.getLingThread(goal.threadId), policy = goal?.supervisionPolicy ?? defaultGoalSupervisionPolicy;
        if (!goal || goal.id !== input.goalId || goal.status !== "active" || goal.updatedAt !== input.expectedUpdatedAt || !run || run.threadId !== goal.threadId
          || thread?.lastRunId !== run.id || thread.status === "archived" || thread.conversationMode?.mode === "plan"
          || !policy.autoContinue || !["succeeded", ...(policy.retryFailedRuns ? ["failed"] : [])].includes(run.status)
          || goal.continuationDepth >= policy.maxContinuations || input.noEvidenceCount >= policy.maxNoEvidenceContinuations
          || goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget
          || policy.maxTimeSeconds !== undefined && goal.timeUsedSeconds >= policy.maxTimeSeconds
          || db.prepare("SELECT 1 FROM run_sessions WHERE thread_id=? AND status IN ('queued','running','waiting_for_approval','yielded') LIMIT 1").get(thread.id)
          || db.prepare(`SELECT 1 FROM approval_requests a JOIN run_sessions r ON r.id=a.run_id WHERE r.thread_id=? AND a.status='pending' LIMIT 1`).get(thread.id)) {
          db.exec("COMMIT"); return undefined;
        }
        const key = `goal_auto_continue:${goal.id}:${run.id}`;
        const prior = store.listRunInterventions({ sourceRunId: run.id, idempotencyKey: key, limit: 1 })[0];
        if (prior?.status === "failed" && !prior.continuationRunId && prior.failureReason === "goal_supervision_authority_changed") {
          const resumed = store.updateRunInterventionStatus({ interventionId: prior.id, expectedStatuses: ["failed"], status: "queued",
            failureReason: null, completedAt: null, now: input.now });
          db.exec("COMMIT"); return resumed;
        }
        if (prior
          || store.listRunInterventions({ sourceRunId: run.id, limit: 100 }).some(item => ["queued", "cancelling_source", "starting_continuation"].includes(item.status))) {
          db.exec("COMMIT"); return undefined;
        }
        const unit = run.workUnitId ? store.getWorkUnit(run.workUnitId) : undefined;
        const intervention = store.createRunIntervention({ sourceRunId: run.id, sourceWorkUnitId: unit?.id, sourceAttemptId: unit?.activeAttemptId,
          mode: "queue_followup", instruction: input.instruction, messagePayload: { body: input.instruction, attachmentIds: [], linkPreviewIds: [] },
          requestedBy: "system", idempotencyKey: key }, input.now);
        store.updateLingThreadGoal(goal.id, { continuationChainId: goal.continuationChainId ?? `goal_chain_${goal.id}_${run.parentRunId ?? run.id}`,
          continuationDepth: goal.continuationDepth + 1, noEvidenceContinuationCount: input.noEvidenceCount,
          lastContinuationStopReason: null, lastContinuationStoppedAt: null, lastContinuationEvidenceDelta: input.evidenceDelta }, input.now);
        db.exec("COMMIT"); return intervention;
      } catch (error) { rollbackOwnedSqliteTransaction(db); throw error; }
    },
  });
}
