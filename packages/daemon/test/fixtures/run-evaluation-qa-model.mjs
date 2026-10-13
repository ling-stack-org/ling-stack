import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSqliteRunStore, digestRunEvaluationValue, resolveRuntimePaths, DEFAULT_WORKSPACE_ID } from "@ling-stack/core";
import { processNextRunEvaluation } from "../../dist/index.js";
import { createRunEvaluationQaModelConfiguration, runEvaluationQaModelConfigurationFacts,
  runEvaluationQaModelConfigurationSnapshot, prepareRunEvaluationQaModelRequest } from "../../dist/features/harness/evaluations/qa-model-preparation.js";
import { prepareRunEvaluationTaskRequest } from "../../dist/features/harness/evaluations/task-worker-input.js";
import { createRunEvaluationQaModelHostAdapter } from "../../dist/features/harness/evaluations/qa-model-coordinator.js";
import { createRunEvaluationQaModelTransport } from "../../dist/features/harness/evaluations/qa-model-transport.js";
import { createRunEvaluationQaOwnedModelBatch, runEvaluationQaOwnedModelBatchFacts } from "../../dist/features/harness/evaluations/qa-model-owned-batch.js";

export const createdAt = "2026-10-10T00:00:00.000Z";
export const now = "2026-10-10T00:01:00.000Z";
export const expired = "2026-10-10T00:03:00.000Z";
export const output = { schemaVersion: 1, verdict: "pass", score: 0.9, severity: "info", rationale: "Reviewed QA evidence matches." };
export const completion = (override = {}) => ({ id: "chatcmpl-owned-qa", object: "chat.completion", created: 1791590400,
  model: "qa-fixture-model", system_fingerprint: "fixture", service_tier: "default",
  choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(output), refusal: null, annotations: [],
    audio: null, function_call: null, tool_calls: [], reasoning_content: null }, finish_reason: "stop", logprobs: null }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
    prompt_tokens_details: { cached_tokens: 10, audio_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 5, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 } }, ...override });

/** Owned loopback only. Captures exact bytes and closes its own connections; no real Provider is reachable. */
export async function ownedServer(t, handler = (_request, response) => response.end(JSON.stringify(completion()))) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const captured = { path: request.url, headers: request.headers, body: Buffer.concat(chunks).toString("utf8") };
    requests.push(captured);
    try { await handler(captured, response, requests.length); }
    catch { response.destroy(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests, server };
}

export async function fixture(t, baseUrl, overrides = {}, evidence = {}, providerOverrides = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-qa-model-owned-"));
  const store = createSqliteRunStore(cwd);
  const database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  let verifySource;
  t.after(async () => {
    try { verifySource?.(); }
    finally { database.close(); store.close(); await rm(cwd, { recursive: true, force: true }); }
  });
  const configurationInput = { graderId: "qa-only-model", graderVersion: "1", providerPresetId: "owned-loopback",
    configRevision: 1, providerId: "owned-loopback", modelId: "qa-fixture-model", modelVersion: "configuration-v1",
    api: "openai-completions", baseUrl, outputTokenField: "max_tokens", outputCapCapability: "max_tokens_non_reasoning",
    rubric: { id: "owned-qa", version: "1", instructions: "Compare the reviewed baseline and candidate." }, ...overrides };
  const configuration = createRunEvaluationQaModelConfiguration(configurationInput);
  const configFacts = runEvaluationQaModelConfigurationFacts(configuration);
  const channel = store.createChannel({ name: "Explicit owned QA", boundPath: cwd }, createdAt);
  const sourceTask = store.createTask({ channelId: channel.id, title: "Completed reviewed source", prompt: "fixture" }, createdAt);
  const workUnit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "task",
    ownerId: sourceTask.id, taskId: sourceTask.id, idempotencyKey: "qa-model-source-workunit", createdByActor: "system", request: {}, now: createdAt });
  const attempt = store.createWorkUnitAttempt({ workUnitId: workUnit.id, attemptNumber: 1, runtimeInstanceId: "owned-qa-source", runnerId: "pi", now: createdAt });
  const sourceFence = { workUnitId: workUnit.id, attemptId: attempt.id, runtimeInstanceId: attempt.runtimeInstanceId, fencingToken: attempt.fencingToken };
  assert.equal(store.transitionWorkUnitStatus({ workUnitId: workUnit.id, expectedStatus: "queued", event: "claim", actor: "system", activeAttemptId: attempt.id, now: createdAt }).ok, true);
  assert.equal(store.transitionWorkUnitStatus({ workUnitId: workUnit.id, expectedStatus: "claimed", event: "runner_started", actor: "runner", now: createdAt }).ok, true);
  store.updateWorkUnitAttemptStatus({ ...sourceFence, status: "started", now: createdAt });
  assert.ok(store.acquireRuntimeSemaphoreSlot({ ...sourceFence, workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "provider", resourceKey: "ordinary-source",
    ownerType: "work_unit_attempt", ownerId: attempt.id, acquiredAt: createdAt, expiresAt: "2099-01-01T00:00:00.000Z", limit: 1 }));
  const run = store.createRun({ id: "run-owned-qa-source", cwd, taskId: sourceTask.id, workUnitId: workUnit.id,
    providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt });
  store.linkRunToWorkUnit(run.id, workUnit.id, createdAt);
  store.markRunSucceeded(run.id, createdAt);
  assert.ok(store.transitionWorkUnitAttemptTerminal({ ...sourceFence, event: "runner_succeeded", attemptStatus: "succeeded",
    runtimeEventType: "work_unit_succeeded", actor: "system", now: createdAt }));
  store.releaseRuntimeSemaphoreSlotsForAttempt(sourceFence, createdAt, "source-completed");
  const artifact = (id, payload) => store.createArtifact({ id: `owned-qa-${id}`, runId: run.id, type: "json", path: `evaluation/${id}.json`, sealedPayload: payload, createdAt });
  const suite = artifact("suite", { id: "qa-suite", version: "1", reviewed: "QA-only" });
  const testCase = artifact("case", { schemaVersion: 1, kind: "deterministic_json_rule", graderId: "source-rule", graderVersion: "1",
    failureSeverity: "error", assertions: [{ type: "deep_equal" }] });
  const baseline = artifact("baseline", { qa: true, ...evidence });
  const candidate = artifact("candidate", { qa: true, ...evidence });
  const evaluation = store.enqueueRunEvaluation({ runId: run.id, suiteId: "qa-suite", suiteVersion: "1", suiteArtifactId: suite.id,
    caseId: "qa-case", caseVersion: "1", caseArtifactId: testCase.id, baselineId: "qa-baseline", baselineVersion: "1",
    baselineArtifactId: baseline.id, candidateArtifactId: candidate.id, now: createdAt }).evaluation;
  assert.equal((await processNextRunEvaluation({ store, workerId: "source-rule", now })).disposition, "completed");
  const frozen = artifact("frozen", configFacts.frozenGrader);
  const configArtifact = artifact("config", runEvaluationQaModelConfigurationSnapshot(configuration));
  const provider = { providerId: configurationInput.providerId, modelId: configurationInput.modelId, api: configurationInput.api,
    baseUrl, apiKey: "owned-loopback-fake-key", headers: { "x-owned-qa": "fixture" }, ...providerOverrides };
  let materializeProvider = () => provider;
  let assertCredentialCurrent = () => {};
  // Explicit synthetic Host closure for owned loopback tests, not an authenticated executor DTO.
  const ownedBatch = await createRunEvaluationQaOwnedModelBatch({ store, qaWorkspaceCwd: cwd, configuration,
    configSnapshotRef: configArtifact.id, materializeProvider: () => materializeProvider(),
    assertCredentialCurrent: () => assertCredentialCurrent(), now });
  const batch = runEvaluationQaOwnedModelBatchFacts(ownedBatch);
  const pin = value => ({ artifactId: value.id, contentSha256: value.contentSha256 });
  const artifactPins = { suite: pin(suite), case: pin(testCase), baseline: pin(baseline), candidate: pin(candidate), frozen: pin(frozen) };
  const enroll = ordinal => {
    const result = store.enrollRunEvaluationQaTask({ evaluationId: evaluation.id, evaluationKey: evaluation.idempotencyKey,
      frozenGraderArtifact: pin(frozen), frozenGraderDigest: configFacts.frozenGraderDigest, repeatOrdinal: ordinal,
      batchId: batch.id, reviewRef: "explicit-host-review-fixture", artifactPins, now });
    assert.equal(result.ok, true);
    return store.getRunEvaluationTask(result.value.taskId);
  };
  const task = enroll(1);
  const adapter = (extra = {}) => {
    const { materializeProvider: resolve, ...rest } = extra;
    if (resolve) materializeProvider = resolve;
    return createRunEvaluationQaModelHostAdapter({ store, ownedBatch, clock: () => now, ...rest });
  };
  const original = sourceSnapshot(store, run, workUnit, attempt, evaluation);
  let semaphoreCalls = 0;
  store.acquireRuntimeSemaphoreSlot = () => { semaphoreCalls += 1; throw new Error("ordinary quota forbidden"); };
  verifySource = () => { assert.deepEqual(sourceSnapshot(store, run, workUnit, attempt, evaluation), original); assert.equal(semaphoreCalls, 0); };
  return { cwd, store, database, run, evaluation, task, frozen, configurationInput, configuration, configFacts, configArtifact,
    batch, ownedBatch, artifactPins, provider, adapter, enroll, pin,
    setCredentialCurrent: callback => { assertCredentialCurrent = callback; },
    setMaterializeProvider: callback => { materializeProvider = callback; } };
}

export async function preparedTransport(f, extra = {}) {
  const claimed = f.store.claimRunEvaluationTask({ taskId: f.task.id, expectedTaskRevision: f.task.revision,
    claimOwner: "owned-qa-worker", claimToken: "owned-qa-token", claimExpiresAt: "2026-10-10T00:02:00.000Z", now });
  assert.equal(claimed.ok, true);
  const claim = claimed.value;
  const request = prepareRunEvaluationTaskRequest(claim, f.store.getRunEvaluation(f.evaluation.id));
  const prepared = await prepareRunEvaluationQaModelRequest({ configuration: f.configuration, claim,
    evaluation: f.store.getRunEvaluation(f.evaluation.id), artifacts: request.artifacts, readArtifact: id => f.store.getArtifact(id) });
  const transport = createRunEvaluationQaModelTransport({ prepared, provider: f.provider, store: f.store, batchId: f.batch.id, clock: () => now, ...extra });
  const fence = current => ({ taskId: current.task.id, attemptId: current.attempt.id, expectedTaskRevision: current.task.revision,
    expectedAttemptRevision: current.attempt.revision, claimOwner: current.attempt.claimOwner, claimToken: current.attempt.claimToken, now });
  return { claim, prepared, transport, fence };
}
function sourceSnapshot(store, run, workUnit, attempt, evaluation) {
  return { run: store.getRun(run.id), workUnit: store.getWorkUnit(workUnit.id), attempt: store.getWorkUnitAttempt(attempt.id),
    evaluation: store.getRunEvaluation(evaluation.id), grades: store.listRunEvaluationGrades(evaluation.id),
    semaphores: store.listRuntimeSemaphoreSlots({ workUnitId: workUnit.id }) };
}
