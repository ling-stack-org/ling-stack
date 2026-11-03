import assert from "node:assert/strict";
import test from "node:test";
import {
  createRunEvaluationQaPilotReview,
  runEvaluationQaModelPilot,
} from "../dist/features/harness/evaluations/qa-model-pilot-runner.js";
import { completion, fixture, now, ownedServer } from "./fixtures/run-evaluation-qa-model.mjs";

const cases = (f, ordinals) => ordinals.map(repeatOrdinal => ({
  evaluationId: f.evaluation.id,
  evaluationKey: f.evaluation.idempotencyKey,
  repeatOrdinal,
  artifactPins: f.artifactPins,
}));

function reviewedPilot(f, selectedCases, override = {}) {
  const review = createRunEvaluationQaPilotReview({
    canonicalWorkspaceCwd: f.cwd,
    configSnapshotRef: f.configArtifact.id,
    configuration: f.configuration,
    reviewedByRef: "local-user-explicit:h09-pilot-inputs",
    reviewedAt: now,
    cases: selectedCases,
  });
  const artifact = f.store.createArtifact({
    id: `h09-pilot-review-${selectedCases.length}-${override.suffix ?? "default"}`,
    runId: f.run.id,
    type: "json",
    path: `evaluation/qa/review-${selectedCases.length}-${override.suffix ?? "default"}.json`,
    sealedPayload: override.payload ?? review,
    createdAt: now,
  });
  return { review, reviewArtifact: f.pin(artifact) };
}

function options(f, server, selectedCases, reviewed) {
  return {
    store: f.store,
    qaWorkspaceCwd: f.cwd,
    configuration: f.configuration,
    configSnapshotRef: f.configArtifact.id,
    reviewArtifact: reviewed.reviewArtifact,
    review: reviewed.review,
    cases: selectedCases,
    materializeProvider: () => ({ ...f.provider, baseUrl: server.baseUrl }),
    assertCredentialCurrent: () => {},
    workerId: "h09-pilot-test",
    clock: () => now,
  };
}

test("trusted pilot binds reviewed bytes, executes one task once and returns the drained allowlisted receipt", async t => {
  const server = await ownedServer(t);
  const f = await fixture(t, server.baseUrl);
  const selectedCases = cases(f, [2]);
  const reviewed = reviewedPilot(f, selectedCases);
  const result = await runEvaluationQaModelPilot(options(f, server, selectedCases, reviewed));
  assert.equal(result.status, "completed");
  assert.equal(result.executions.length, 1);
  assert.equal(server.requests.length, 1);
  const execution = result.executions[0];
  assert.equal(execution.disposition, "completed");
  assert.equal(execution.request.state, "completed");
  assert.equal(execution.request.releaseKind, "host_callback_drained");
  assert.deepEqual(execution.request.usage, { state: "measured", inputTokens: 100, outputTokens: 20 });
  assert.equal(execution.result.authority, "unverified");
  assert.equal("payloadUtf8" in execution.request, false);
  assert.equal(result.reviewRef, `artifact:${reviewed.reviewArtifact.artifactId}#sha256:${reviewed.reviewArtifact.contentSha256}`);
});

test("unknown Provider usage stops the batch after its first charged call without retrying queued cases", async t => {
  const response = completion();
  delete response.usage;
  const server = await ownedServer(t, (_request, reply) => reply.end(JSON.stringify(response)));
  const f = await fixture(t, server.baseUrl);
  const selectedCases = cases(f, [2, 3]);
  const reviewed = reviewedPilot(f, selectedCases, { suffix: "usage-unknown" });
  const result = await runEvaluationQaModelPilot(options(f, server, selectedCases, reviewed));
  assert.equal(result.status, "stopped");
  assert.equal(result.stopReason, "usage_unknown");
  assert.equal(result.executions.length, 1);
  assert.equal(server.requests.length, 1);
  assert.deepEqual(result.executions[0].request.usage, { state: "unknown" });
  assert.equal(f.database.prepare(`SELECT count(*) AS n FROM run_evaluation_tasks t
    JOIN run_evaluation_qa_enrollments e ON e.task_id=t.id WHERE e.batch_id=? AND t.state='queued'`).get(result.batch.id).n, 1);
});

test("review byte mismatch fails before batch creation, enrollment, credential materialization or transport", async t => {
  const server = await ownedServer(t);
  const f = await fixture(t, server.baseUrl);
  const selectedCases = cases(f, [2]);
  const valid = createRunEvaluationQaPilotReview({ canonicalWorkspaceCwd: f.cwd,
    configSnapshotRef: f.configArtifact.id, configuration: f.configuration,
    reviewedByRef: "local-user-explicit:h09-pilot-inputs", reviewedAt: now, cases: selectedCases });
  const reviewed = reviewedPilot(f, selectedCases, { suffix: "wrong-bytes", payload: { ...valid, reviewedByRef: "different-review" } });
  const before = f.database.prepare("SELECT count(*) AS batches FROM run_evaluation_qa_batches").get();
  let materializations = 0;
  await assert.rejects(runEvaluationQaModelPilot({ ...options(f, server, selectedCases, reviewed),
    materializeProvider: () => { materializations += 1; return f.provider; } }), /evaluation_qa_review_invalid/u);
  assert.equal(materializations, 0);
  assert.deepEqual(f.database.prepare("SELECT count(*) AS batches FROM run_evaluation_qa_batches").get(), before);
  assert.equal(server.requests.length, 0);
});
