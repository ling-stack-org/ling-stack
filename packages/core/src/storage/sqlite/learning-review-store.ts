import { createHash } from "node:crypto";
import type { LearningReviewPolicyUpdateRequest, RuntimeAttemptFenceV1 } from "@ling-stack/contracts";
import { LEARNING_REVIEW_MAX_LIMITS, type LearningReviewLimits } from "@ling-stack/contracts";
import type { EnqueueLearningReviewInput, LearningReviewJob, LearningReviewPolicy, LearningReviewStore } from "../../learning-review-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import type { SqliteStoreContext } from "./store-context.js";

export class SqliteLearningReviewStore implements LearningReviewStore {
  constructor(private readonly context: SqliteStoreContext) {}
  getLearningReviewPolicy(): LearningReviewPolicy {
    const row = this.context.database.prepare("SELECT record_json FROM learning_review_policy WHERE id = 1").get();
    return row ? JSON.parse(String(row.record_json)) as LearningReviewPolicy : { revision: 0, mode: "off" };
  }
  updateLearningReviewPolicy(input: LearningReviewPolicyUpdateRequest, now: string): LearningReviewPolicy {
    return this.transaction(() => {
      const current = this.getLearningReviewPolicy();
      if (current.revision !== input.expectedRevision) throw new Error("learning_policy_conflict");
      if (!["off", "propose"].includes(input.mode) || (input.mode === "propose" && !input.providerPresetId?.trim())) {
        throw new Error("learning_policy_invalid");
      }
      const next: LearningReviewPolicy = { revision: current.revision + 1, mode: input.mode,
        providerPresetId: input.providerPresetId, updatedAt: now,
        limits: normalizeLimits({ ...current.limits, ...input.limits }) };
      this.context.database.prepare("INSERT INTO learning_review_policy VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET record_json = excluded.record_json")
        .run(JSON.stringify(next));
      for (const row of this.context.database.prepare("SELECT record_json FROM learning_review_jobs WHERE status IN ('queued', 'running') AND mode = 'automatic'").all()) {
        const job = JSON.parse(String(row.record_json)) as LearningReviewJob;
        this.save({ ...job, status: "cancelled", reason: "learning_policy_changed", updatedAt: now });
      }
      return next;
    });
  }
  enqueueLearningReview(input: EnqueueLearningReviewInput, now: string): LearningReviewJob {
    return this.transaction(() => {
      const policy = this.getLearningReviewPolicy();
      if (input.mode === "automatic" && (policy.mode !== "propose" || policy.providerPresetId !== input.providerPresetId)) {
        throw new Error("learning_automatic_disabled");
      }
      if (!input.providerPresetId || input.evidence.workspaceId !== DEFAULT_WORKSPACE_ID) throw new Error("learning_scope_invalid");
      if (input.evidence.schemaVersion !== 1 || input.evidence.items.length > 64 ||
        Buffer.byteLength(JSON.stringify(input.evidence)) > 32_768 || !/^[a-f0-9]{64}$/.test(input.evidence.digest)) throw new Error("learning_evidence_over_budget");
      const sourceKey = createHash("sha256").update(JSON.stringify([input.evidence.workspaceId,
        input.evidence.runId, input.evidence.sourceAttemptId, input.evidence.digest])).digest("hex");
      const existing = this.context.database.prepare("SELECT record_json FROM learning_review_jobs WHERE workspace_id = ? AND source_key = ?")
        .get(input.evidence.workspaceId, sourceKey);
      if (existing) return JSON.parse(String(existing.record_json)) as LearningReviewJob;
      if (input.mode === "automatic") {
        const count = this.context.database.prepare("SELECT count(*) AS n FROM learning_review_jobs WHERE workspace_id = ? AND mode = 'automatic' AND created_at >= ?")
          .get(input.evidence.workspaceId, `${now.slice(0, 10)}T00:00:00.000Z`);
        if (Number(count?.n) >= (policy.limits ?? LEARNING_REVIEW_MAX_LIMITS).dailyAutomaticJobs) throw new Error("learning_daily_quota_exceeded");
      }
      const job: LearningReviewJob = { id: `learning_review_${sourceKey.slice(0, 32)}`, workspaceId: input.evidence.workspaceId,
        sourceKey, mode: input.mode, policyRevision: policy.revision, providerPresetId: input.providerPresetId,
        limits: policy.limits ?? LEARNING_REVIEW_MAX_LIMITS,
        evidence: input.evidence, status: "queued", modelRequests: 0, inputTokensReserved: 0, outputTokensReserved: 0,
        candidateIds: [], createdAt: now, updatedAt: now };
      this.context.database.prepare("INSERT INTO learning_review_jobs VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(job.id, job.workspaceId, sourceKey, job.mode, job.status, now, JSON.stringify(job));
      return job;
    });
  }
  getLearningReviewJob(id: string): LearningReviewJob | undefined {
    const row = this.context.database.prepare("SELECT record_json FROM learning_review_jobs WHERE id = ? AND workspace_id = ?")
      .get(id, DEFAULT_WORKSPACE_ID);
    return row ? JSON.parse(String(row.record_json)) as LearningReviewJob : undefined;
  }
  listLearningReviewJobs(status?: LearningReviewJob["status"], limit = 50): LearningReviewJob[] {
    if (!Number.isFinite(limit)) throw new Error("learning_limit_invalid");
    return this.context.database.prepare(`SELECT record_json FROM learning_review_jobs WHERE workspace_id = ?${status ? " AND status = ?" : ""}
      ORDER BY created_at ${status ? "ASC" : "DESC"}, rowid ${status ? "ASC" : "DESC"} LIMIT ?`).all(DEFAULT_WORKSPACE_ID, ...(status ? [status] : []), Math.max(1, Math.min(100, Math.trunc(limit))))
      .map(row => JSON.parse(String(row.record_json)) as LearningReviewJob);
  }
  claimLearningReviewJob(id: string, fence: RuntimeAttemptFenceV1, now: string): LearningReviewJob | undefined {
    return this.transaction(() => {
      const job = this.getLearningReviewJob(id);
      if (!job || job.status !== "queued") return undefined;
      const active = this.context.database.prepare("SELECT 1 FROM learning_review_jobs WHERE workspace_id = ? AND status = 'running'").get(job.workspaceId);
      if (active) return undefined;
      this.assertFence(fence);
      this.assertPolicy(job);
      const next = { ...job, fence, status: "running" as const, updatedAt: now };
      this.save(next); return next;
    });
  }
  reserveLearningReviewModelRequest(id: string, fence: RuntimeAttemptFenceV1, inputTokens: number, now: string): LearningReviewJob {
    return this.transaction(() => {
      const job = this.current(id, fence);
      const limits = job.limits ?? LEARNING_REVIEW_MAX_LIMITS;
      if (!Number.isSafeInteger(inputTokens) || inputTokens < 1 || job.modelRequests >= limits.maxRequests ||
        job.inputTokensReserved + inputTokens > limits.inputTokens || job.outputTokensReserved + limits.perRequestOutputTokens > limits.outputTokens) throw new Error("learning_budget_exceeded");
      const next = { ...job, modelRequests: job.modelRequests + 1, inputTokensReserved: job.inputTokensReserved + inputTokens,
        outputTokensReserved: job.outputTokensReserved + limits.perRequestOutputTokens, updatedAt: now };
      this.save(next); return next;
    });
  }
  /** Called in the candidate's owning synchronous transaction; no network I/O crosses it. */
  finishLearningReviewJob(id: string, fence: RuntimeAttemptFenceV1, status: "succeeded" | "failed" | "cancelled",
    candidateIds: readonly string[], reason: string | undefined, now: string): LearningReviewJob {
    return this.transaction(() => {
      const job = this.current(id, fence);
      const next = { ...job, status, candidateIds, reason, updatedAt: now };
      this.save(next); return next;
    });
  }
  cancelLearningReviewJob(id: string, reason: string, now: string): LearningReviewJob | undefined {
    return this.transaction(() => {
      const job = this.getLearningReviewJob(id);
      if (!job || !["queued", "running"].includes(job.status)) return job;
      const next = { ...job, status: "cancelled" as const, reason, updatedAt: now };
      this.save(next); return next;
    });
  }
  private current(id: string, fence: RuntimeAttemptFenceV1): LearningReviewJob {
    const job = this.getLearningReviewJob(id);
    if (!job || job.status !== "running" || !job.fence || (["workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"] as const).some(key => job.fence![key] !== fence[key])) throw new Error("learning_claim_lost");
    this.assertFence(fence); this.assertPolicy(job); return job;
  }
  private assertPolicy(job: LearningReviewJob): void {
    if (job.mode !== "automatic") return;
    const policy = this.getLearningReviewPolicy();
    if (policy.mode !== "propose" || policy.revision !== job.policyRevision || policy.providerPresetId !== job.providerPresetId) throw new Error("learning_policy_changed");
  }
  private assertFence(fence: RuntimeAttemptFenceV1): void {
    const row = this.context.database.prepare(`SELECT 1 FROM work_units w JOIN work_unit_attempts a ON w.active_attempt_id = a.id
      WHERE w.id = ? AND a.id = ? AND a.runtime_instance_id = ? AND a.fencing_token = ?
      AND w.status = 'running' AND a.status = 'started'`)
      .get(fence.workUnitId, fence.attemptId, fence.runtimeInstanceId, fence.fencingToken);
    if (!row) throw new Error("learning_attempt_stale");
  }
  private save(job: LearningReviewJob): void {
    this.context.database.prepare("UPDATE learning_review_jobs SET status = ?, record_json = ? WHERE id = ? AND workspace_id = ?")
      .run(job.status, JSON.stringify(job), job.id, job.workspaceId);
  }
  private transaction<T>(mutate: () => T): T {
    this.context.database.exec("SAVEPOINT learning_review_write");
    try { const result = mutate(); this.context.database.exec("RELEASE learning_review_write"); return result; }
    catch (error) { this.context.database.exec("ROLLBACK TO learning_review_write; RELEASE learning_review_write"); throw error; }
  }
}

function normalizeLimits(input: Partial<LearningReviewLimits>): LearningReviewLimits {
  for (const key of Object.keys(input)) {
    if (!(key in LEARNING_REVIEW_MAX_LIMITS)) throw new Error("learning_limits_invalid");
  }
  const limits = { ...LEARNING_REVIEW_MAX_LIMITS, ...input };
  for (const key of Object.keys(LEARNING_REVIEW_MAX_LIMITS) as (keyof LearningReviewLimits)[]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > LEARNING_REVIEW_MAX_LIMITS[key]) throw new Error("learning_limits_invalid");
  }
  if (limits.perRequestOutputTokens > limits.outputTokens) throw new Error("learning_limits_invalid");
  return limits;
}
