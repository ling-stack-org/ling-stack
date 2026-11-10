import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID } from "../../core/dist/index.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { handleGetRunAssuranceEvidence } from "../dist/features/runs/assurance-evidence.js";
import { parseLiveExecutionEvidenceResponse } from "../../../scripts/framework-assurance/execution-evidence.mjs";

const now = "2026-11-10T08:00:00.000Z";

test("live assurance endpoint reads initialized Host facts without exposing bodies or initializing a cold Store", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-assurance-evidence-api-"));
  const store = createSqliteRunStore(cwd);
  let factoryCalls = 0;
  const registry = new RunStoreRegistry(() => {
    factoryCalls++;
    return store;
  }, { recoverOnOpen: false });
  registry.getStore(cwd);
  const activeRuns = new ActiveRunRegistry();
  const unit = store.createWorkUnit({
    workspaceId: DEFAULT_WORKSPACE_ID,
    kind: "task_run",
    ownerType: "run",
    ownerId: "run-assurance-live",
    idempotencyKey: "assurance-live-unit",
    status: "running",
    createdByActor: "system",
    request: {},
    now,
  });
  const attempt = store.createWorkUnitAttempt({
    id: "attempt-assurance-live",
    workUnitId: unit.id,
    attemptNumber: 1,
    runtimeInstanceId: "runtime-assurance-live",
    runnerId: "pi",
    effectiveRunnerId: "pi",
    status: "started",
    now,
  });
  const run = store.createRun({
    id: "run-assurance-live",
    cwd,
    taskId: "task-assurance-live",
    workUnitId: unit.id,
    providerName: "fixture",
    providerModel: "fixture-model",
    taskSnapshot: {},
    providerSnapshot: {},
    requestSnapshot: { thinkingLevel: "low" },
    createdAt: now,
  });
  store.linkRunToWorkUnit(run.id, unit.id, now);
  const currentAttempt = store.createWorkUnitAttempt({
    id: "attempt-assurance-current",
    workUnitId: unit.id,
    attemptNumber: 2,
    runtimeInstanceId: "runtime-assurance-current",
    runnerId: "pi",
    effectiveRunnerId: "pi",
    status: "started",
    now,
  });
  store.createArtifact({
    id: "artifact-assurance-live",
    runId: run.id,
    type: "json",
    path: "assurance/result.json",
    sealedPayload: { secret: "PRIVATE_ARTIFACT_BODY" },
    createdAt: now,
  });

  const server = createServer((request, response) => {
    handleGetRunAssuranceEvidence(response, new URL(request.url, "http://local"), registry, activeRuns, run.id);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    registry.closeAll();
    await rm(cwd, { recursive: true, force: true });
  });

  const address = server.address();
  const url = new URL(`http://127.0.0.1:${address.port}/runs/${encodeURIComponent(run.id)}/assurance-evidence`);
  url.searchParams.set("cwd", cwd);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const body = await response.json();
  const parsed = parseLiveExecutionEvidenceResponse(body);
  assert.equal(body.kind, "live_execution_evidence");
  assert.equal(parsed.lifecycle.currentAttemptId, currentAttempt.id);
  assert.equal(body.execution.runId, run.id);
  assert.equal(body.execution.workUnitId, unit.id);
  assert.equal(body.execution.attemptId, currentAttempt.id);
  assert.equal(body.execution.claimStatus, "held");
  assert.equal(body.execution.effectStatus, "none");
  assert.equal(body.comparison.model, "fixture-model");
  assert.equal(body.comparison.reasoning, "low");
  assert.equal(body.artifacts.length, 1);
  assert.equal(body.artifacts[0].contentSha256, createHash("sha256").update(JSON.stringify({ secret: "PRIVATE_ARTIFACT_BODY" }), "utf8").digest("hex"));
  assert.equal(body.lifecycle.attemptCount, 2);
  assert.equal(body.lifecycle.oldAttemptCount, 1);
  assert.equal(body.lifecycle.currentAttemptId, currentAttempt.id);
  assert.equal(body.lifecycle.attempts.find(item => item.attemptId === attempt.id).isCurrent, false);
  assert.equal(body.lifecycle.attempts.find(item => item.attemptId === attempt.id).status, "lost");
  assert.equal(body.completion.status, "not_applicable");
  assert.equal(body.budget.status, "not_applicable");
  assert.equal(body.isolation.status, "not_applicable");
  assert.equal(body.admission.status, "not_applicable");
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE_ARTIFACT_BODY|claimToken|sealedPayload/);

  assert.equal(store.transitionWorkUnitStatus({
    workUnitId: unit.id,
    expectedStatus: "running",
    event: "cancel",
    actor: "system",
    attemptId: currentAttempt.id,
    runtimeInstanceId: currentAttempt.runtimeInstanceId,
    fencingToken: currentAttempt.fencingToken,
    now,
  }).ok, true);
  const cancellingResponse = await fetch(url);
  assert.equal(cancellingResponse.status, 200);
  const cancelling = await cancellingResponse.json();
  assert.equal(cancelling.execution.workUnitStatus, "cancelling");
  assert.equal(cancelling.execution.attemptStatus, "started");
  assert.equal(cancelling.lifecycle.status, "cancelling");
  assert.equal(cancelling.lifecycle.stop.reusable, false);
  assert.equal(cancelling.lifecycle.attempts.find(item => item.isCurrent).localExecution, "unverified");
  assert.equal(cancelling.lifecycle.attempts.find(item => item.isCurrent).effects, "unverified");
  parseLiveExecutionEvidenceResponse(cancelling);

  const coldCalls = factoryCalls;
  const cold = new URL(url);
  cold.searchParams.set("cwd", join(cwd, "cold"));
  assert.equal((await fetch(cold)).status, 503);
  assert.equal(factoryCalls, coldCalls);
});
