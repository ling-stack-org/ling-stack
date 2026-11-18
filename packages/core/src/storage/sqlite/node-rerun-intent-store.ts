import { createHash, randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import {
  createNodeRerunHostAdmissionPlanV1, nodeRerunHostAdmissionPlanFingerprintV1,
  parseNodeRerunIntent, parseNodeRerunIntentSubmission,
  type NodeRerunPreparedIntentV1,
} from "@ling-stack/contracts";
import type { PrepareNodeRerunIntentInput, PrepareNodeRerunIntentResult } from "../../node-rerun-store-types.js";
import type { RunStore } from "../../run-types.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { readSqliteWithinTransaction } from "./read-snapshot.js";
import type { SqliteStoreContext } from "./store-context.js";

type Row = Record<string, SQLOutputValue>;
type Ports = Pick<RunStore, "getRun" | "getChannelWorkflowStep" | "getChannelWorkflow">;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Durable preparation and idempotency only. No approval or execution is created here. */
export class SqliteNodeRerunIntentStore {
  constructor(private readonly context: SqliteStoreContext, private readonly ports: Ports) {}

  getNodeRerunIntent(id: string): NodeRerunPreparedIntentV1 | undefined {
    const row = this.context.database.prepare("SELECT * FROM node_rerun_intents WHERE id=?").get(id);
    return row ? this.map(row) : undefined;
  }

  prepareNodeRerunIntent(input: PrepareNodeRerunIntentInput): PrepareNodeRerunIntentResult {
    const request = parseNodeRerunIntentSubmission(input.request);
    if (!Number.isFinite(Date.parse(input.now)) || new Date(input.now).toISOString() !== input.now) {
      throw new TypeError("node_rerun_intents.invalid_timestamp");
    }
    const requestJson = JSON.stringify(request);
    const requestSha256 = sha256(requestJson);
    const db = this.context.database;
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.prepareWithinTransaction(input, request, requestJson, requestSha256);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      rollbackOwnedSqliteTransaction(db);
      throw error;
    }
  }

  private prepareWithinTransaction(input: PrepareNodeRerunIntentInput,
    request: ReturnType<typeof parseNodeRerunIntentSubmission>, requestJson: string, requestSha256: string): PrepareNodeRerunIntentResult {
    const { intent } = request;
    const db = this.context.database;
    const run = this.ports.getRun(intent.source.runId);
    const step = run?.workflowStepId ? this.ports.getChannelWorkflowStep(run.workflowStepId) : undefined;
    const workflow = step && this.ports.getChannelWorkflow(step.workflowId);
    if (!run || !step || !workflow || step.runId !== run.id || step.taskId !== run.taskId
      || step.channelId !== run.channelId || workflow.channelId !== step.channelId || workflow.workspaceId !== step.workspaceId) {
      return { status: "blocked", code: "node_rerun_source_unavailable" };
    }
    const existing = db.prepare(`SELECT * FROM node_rerun_intents
      WHERE workspace_id=? AND (intent_id=? OR idempotency_key=?)`)
      .all(step.workspaceId, intent.intentId, intent.idempotencyKey);
    if (existing.length) {
      if (existing.length !== 1 || existing[0]!.request_sha256 !== requestSha256 || existing[0]!.request_json !== requestJson) {
        return { status: "conflict", code: "node_rerun_identity_conflict" };
      }
      return { status: "duplicate", record: this.map(existing[0]!) };
    }
    // The read window forbids writes and Promise callbacks while holding this writer's source snapshot.
    const observation = readSqliteWithinTransaction(db, () => input.revalidate(parseNodeRerunIntent(intent)));
    if (!observation.observed || observation.admission.decision !== "eligible_for_host_admission") {
      return { status: "blocked", code: "node_rerun_admission_blocked" };
    }
    const plan = createNodeRerunHostAdmissionPlanV1({ intent, ...observation, observed: observation.observed });
    if (plan.planFingerprint !== request.planFingerprint) return { status: "blocked", code: "node_rerun_plan_stale" };
    const id = `node_rerun_${randomUUID()}`;
    db.prepare(`INSERT INTO node_rerun_intents
      (id,workspace_id,intent_id,idempotency_key,source_run_id,source_attempt_id,source_node_id,source_snapshot_digest,
        request_sha256,request_json,policy_fingerprint,status,prepared_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'prepared',?)`).run(id, step.workspaceId, intent.intentId, intent.idempotencyKey,
        intent.source.runId, intent.source.attemptId, intent.source.nodeId, intent.source.sourceSnapshotDigest,
        requestSha256, requestJson, plan.currentPolicyFingerprint, input.now);
    const record = this.getNodeRerunIntent(id);
    if (!record) throw new Error("node_rerun_intents.commit_receipt_missing");
    return { status: "created", record };
  }

  private map(row: Row): NodeRerunPreparedIntentV1 {
    const request = parseNodeRerunIntentSubmission(JSON.parse(String(row.request_json)) as unknown);
    const { intent } = request;
    const policyFingerprint = String(row.policy_fingerprint);
    if (row.status !== "prepared" || !/^[0-9a-f]{64}$/u.test(policyFingerprint)
      || row.request_sha256 !== sha256(JSON.stringify(request)) || row.intent_id !== intent.intentId
      || row.idempotency_key !== intent.idempotencyKey || row.source_run_id !== intent.source.runId
      || row.source_attempt_id !== intent.source.attemptId || row.source_node_id !== intent.source.nodeId
      || row.source_snapshot_digest !== intent.source.sourceSnapshotDigest
      || request.planFingerprint !== nodeRerunHostAdmissionPlanFingerprintV1({ intent, source: intent.source,
        sourcePolicyFingerprint: policyFingerprint, currentPolicyFingerprint: policyFingerprint })) {
      throw new Error("node_rerun_intents.record_corrupt");
    }
    return { ...request, schemaVersion: 1, kind: "node_rerun_prepared_intent", id: String(row.id),
      workspaceId: String(row.workspace_id), status: "prepared", policyFingerprint,
      preparedAt: String(row.prepared_at), executionAuthorized: false };
  }
}
