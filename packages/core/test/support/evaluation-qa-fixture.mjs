import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSqliteRunStore, resolveRuntimePaths, digestRunEvaluationValue } from "../../dist/index.js";
export const now = "2026-10-10T00:00:00.000Z";
export const later = "2026-10-10T00:01:00.000Z";
export const expires = "2026-10-10T00:10:00.000Z";
export const after = "2026-10-10T00:11:00.000Z";
export function value(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; }
export function fence(pair, at = later) { return { taskId: pair.task.id, attemptId: pair.attempt.id, expectedTaskRevision: pair.task.revision, expectedAttemptRevision: pair.attempt.revision, claimOwner: pair.attempt.claimOwner, claimToken: pair.attempt.claimToken, now: at }; }
export function sha(text) { return createHash("sha256").update(text, "utf8").digest("hex"); }
export async function qaFixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-evaluation-qa-")), stores = [];
  const open = () => { const store = createSqliteRunStore(cwd); stores.push(store); return store; };
  const store = open(), database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  t.after(async () => { database.close(); for (const item of stores) { try { item.close(); } catch {} } await rm(cwd, { recursive: true, force: true }); });
  const channel = store.createChannel({ name: "Explicit QA fixture", boundPath: cwd }, now);
  const task = store.createTask({ channelId: channel.id, title: "QA source", prompt: "synthetic" }, now);
  const run = store.createRun({ id: "qa-source-run", cwd, taskId: task.id, providerName: "synthetic", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  store.markRunSucceeded(run.id, now);
  const artifact = (id, payload) => {
    const stored = store.createArtifact({ id, runId: run.id, type: "json", path: `synthetic/${id}.json`, sealedPayload: payload, createdAt: now });
    return { artifactId: id, contentSha256: stored.contentSha256 };
  };
  const pins = { suite: artifact("qa-suite", { id: "suite", version: "1" }), case: artifact("qa-case", { id: "case", version: "1" }), baseline: artifact("qa-baseline", { answer: "ok" }), candidate: artifact("qa-candidate", { answer: "ok" }) };
  const evaluation = store.enqueueRunEvaluation({ id: "qa-evaluation", runId: run.id, suiteId: "suite", suiteVersion: "1", suiteArtifactId: pins.suite.artifactId, caseId: "case", caseVersion: "1", caseArtifactId: pins.case.artifactId, baselineId: "baseline", baselineVersion: "1", baselineArtifactId: pins.baseline.artifactId, candidateArtifactId: pins.candidate.artifactId, now }).evaluation;
  value(store.claimRunEvaluation({ evaluationId: evaluation.id, expectedRevision: 0, claimOwner: "rule", claimToken: "rule-token", claimExpiresAt: expires, now }));
  value(store.startRunEvaluation({ evaluationId: evaluation.id, expectedRevision: 1, claimOwner: "rule", claimToken: "rule-token", now }));
  value(store.completeRunEvaluation({ evaluationId: evaluation.id, expectedRevision: 2, claimOwner: "rule", claimToken: "rule-token", now, grade: { graderType: "rule", graderId: "rule", graderVersion: "1", verdict: "pass" } }));
  const frozen = { graderId: "model-grader", graderVersion: "1", promptDigest: "1".repeat(64), modelId: "synthetic", modelVersion: "1", samplingDigest: "2".repeat(64), rubricDigest: "3".repeat(64) };
  pins.frozen = artifact("qa-frozen", frozen);
  const raw = artifact("qa-raw", { verdict: "pass", synthetic: true });
  const enqueue = { evaluationId: evaluation.id, evaluationKey: evaluation.idempotencyKey, frozenGraderArtifact: pins.frozen, frozenGraderDigest: digestRunEvaluationValue(frozen), repeatOrdinal: 1, now };
  const config = { schemaVersion: 1, provider: "synthetic", modelId: frozen.modelId, outputCap: "max_tokens_non_reasoning", sampling: "provider_defaults_no_overrides" };
  const configPin = artifact("qa-config", config);
  const batchInput = { configSnapshotRef: configPin.artifactId, configDigest: digestRunEvaluationValue(config), now };
  const newBatch = (chosen = store) => value(chosen.createRunEvaluationQaBatch(batchInput));
  const batch = newBatch();
  const enrollInput = (ordinal = 1, selectedBatch = batch) => ({ ...enqueue, repeatOrdinal: ordinal, batchId: selectedBatch.id, reviewRef: "host-explicit-reviewed-qa:fixture", artifactPins: pins });
  const enroll = (ordinal = 1, selectedBatch = batch, chosen = store) => value(chosen.enrollRunEvaluationQaTask(enrollInput(ordinal, selectedBatch)));
  const claim = (enrollment, chosen = store, at = later, end = expires) => {
    const revision = chosen.getRunEvaluationTask(enrollment.taskId).revision;
    return value(chosen.claimRunEvaluationTask({ taskId: enrollment.taskId, expectedTaskRevision: revision, claimOwner: "qa-worker", claimToken: `claim-${enrollment.id}-${revision}-${at}`, claimExpiresAt: end, now: at }));
  };
  const payloadUtf8 = JSON.stringify({ model: "synthetic", stream: false, max_tokens: 1024, messages: [{ role: "system", content: "Synthetic grader" }, { role: "user", content: "Synthetic QA only" }] });
  const admissionInput = (pair, selectedBatch = batch, at = later) => ({ ...fence(pair, at), batchId: selectedBatch.id, configDigest: selectedBatch.configDigest, requestDigest: "a".repeat(64), executionScopeDigest: "b".repeat(64), payloadUtf8, estimatedInputTokens: 70, outputTokenLimit: 1024 });
  const admit = (pair, selectedBatch = batch, chosen = store, at = later) => value(chosen.admitRunEvaluationQaRequest(admissionInput(pair, selectedBatch, at)));
  const result = { verdict: "pass", rawOutputArtifact: raw };
  const receipt = (request, usage = { state: "unknown" }, at = later) => ({ transport: "owned_openai_chat_completions", payloadSha256: request.payloadSha256, responseSha256: "d".repeat(64), responseStatus: 200, modelId: frozen.modelId, dispatchedAt: at, receivedAt: at, usage });
  const completeInput = (admitted, usage = { state: "unknown" }, at = later) => ({ ...fence(admitted, at), requestId: admitted.request.id, receipt: receipt(admitted.request, usage, at), result: { ...result, ...(usage.state === "measured" ? { costInputTokens: usage.inputTokens, costOutputTokens: usage.outputTokens } : {}) } });
  const complete = (admitted, chosen = store, usage = { state: "unknown" }, at = later) => value(chosen.completeRunEvaluationQaRequest(completeInput(admitted, usage, at)));
  const release = (request, chosen = store, at = later) => value(chosen.releaseRunEvaluationQaLane({ requestId: request.id, expectedRequestRevision: request.revision, now: at, release: { kind: "host_callback_drained" } }));
  const counts = () => Object.fromEntries(["run_evaluation_tasks", "run_evaluation_task_attempts", "run_evaluation_task_results", "run_evaluation_qa_batches", "run_evaluation_qa_enrollments", "run_evaluation_qa_requests", "run_evaluation_grades"].map(table => [table, database.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n]));
  return { cwd, store, database, open, run, artifact, pins, raw, evaluation, frozen, enqueue, config, configPin, batchInput, batch, newBatch, enrollInput, enroll, claim, payloadUtf8, admissionInput, admit, result, receipt, completeInput, complete, release, counts };
}
