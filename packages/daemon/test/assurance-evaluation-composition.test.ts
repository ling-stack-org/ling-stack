import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, resolveRuntimePaths, toRuntimeAttemptFence } from "@ling-stack/core";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { readRunAssuranceEvidence } from "../dist/features/runs/assurance-evidence.js";
import { hostAssociationSource, projectInitializedAssuranceEvaluationAssociation }
  from "../dist/features/harness/evaluations/assurance-association-composition.js";
import { handlePostRunAssuranceEvaluationAssociation }
  from "../dist/features/harness/evaluations/assurance-association-route.js";
import { assuranceAssociationFixture, associationNow } from "./support/assurance-evaluation-association-fixture.ts";

async function sqliteFixture(t: TestContext) {
  const f = assuranceAssociationFixture(), ambient = await isolatedWorkspace(t), { cwd } = ambient;
  const store = createSqliteRunStore(cwd), activeRuns = new ActiveRunRegistry();
  ambient.onCleanup(() => store.close());
  const observer = new DatabaseSync(resolveRuntimePaths(cwd).databasePath, { readOnly: true });
  ambient.onCleanup(() => observer.close());
  let factoryCalls = 0;
  const registry = new RunStoreRegistry(() => { factoryCalls++; return store; }, { recoverOnOpen: false });
  ambient.onCleanup(() => registry.closeAll());
  registry.getStore(cwd);
  for (const id of [f.identity.rootRunId, f.identity.runId]) {
    store.createRun({ id, cwd, taskId: "task-association", providerName: "fixture", providerModel: "fixture",
      taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: associationNow,
      ...(id === f.identity.runId ? { parentRunId: f.identity.rootRunId } : {}) });
  }
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run",
    ownerId: f.identity.runId, idempotencyKey: "association-unit", status: "running", createdByActor: "system", request: {}, now: associationNow });
  store.linkRunToWorkUnit(f.identity.runId, unit.id, associationNow);
  const attempt = store.createWorkUnitAttempt({ id: "attempt-association", workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: "runtime-association", runnerId: "pi", effectiveRunnerId: "pi", status: "started", now: associationNow });
  assert.equal(store.transitionWorkUnitAttemptTerminal({ ...toRuntimeAttemptFence(attempt), event: "runner_succeeded",
    attemptStatus: "succeeded", runtimeEventType: "work_unit_succeeded", actor: "runner", now: associationNow }), true);
  for (const id of [f.identity.rootRunId, f.identity.runId]) store.markRunSucceeded(id, associationNow);
  for (const artifact of f.artifacts.values()) store.createArtifact(artifact);
  const queued = store.enqueueRunEvaluation({ id: f.evaluation.id, runId: f.identity.runId, rootRunId: f.identity.rootRunId,
    suiteId: f.identity.suiteId, suiteVersion: f.identity.suiteVersion, suiteArtifactId: f.identity.suiteArtifactId,
    caseId: f.identity.caseId, caseVersion: f.identity.caseVersion, caseArtifactId: f.identity.caseArtifactId,
    baselineId: f.identity.baselineId, baselineVersion: f.identity.baselineVersion, baselineArtifactId: f.identity.baselineArtifactId,
    candidateArtifactId: f.identity.candidateArtifactId, now: associationNow });
  assert.equal(queued.evaluation.idempotencyKey, f.request.evaluationKey);
  const claim = { evaluationId: f.evaluation.id, claimOwner: "fixture", claimToken: "PRIVATE_EVALUATION_CLAIM", now: associationNow };
  assert.ok(store.claimRunEvaluation({ ...claim, expectedRevision: 0, claimExpiresAt: "2026-11-11T01:00:00.000Z" }).ok);
  assert.ok(store.startRunEvaluation({ ...claim, expectedRevision: 1 }).ok);
  const completed = store.completeRunEvaluation({ ...claim, expectedRevision: 2, grade: { id: f.grade.id,
    graderType: f.grade.graderType, graderId: f.grade.graderId, graderVersion: f.grade.graderVersion, verdict: "pass", score: 1 } });
  assert.ok(completed.ok);
  Object.assign(f.request, { source: hostAssociationSource(store.readSnapshot(() => readRunAssuranceEvidence(store, activeRuns, f.identity.runId))) });
  Object.assign(f.request.observation, { comparison: f.request.source.comparison, evidenceKind: "live_execution" });
  const input = { registry, activeRuns, cwd, request: f.request, getFrozenInput: f.ports.getFrozenInput };
  return { ...f, cwd, store, observer, registry, activeRuns, input, factoryCalls: () => factoryCalls };
}

test("initialized composition reads real Host and evaluation rows inside a query-only snapshot", async t => {
  const f = await sqliteFixture(t), database = f.observer;
  const before = database.prepare("PRAGMA data_version").get()!.data_version;
  const hostBefore = readRunAssuranceEvidence(f.store, f.activeRuns, f.identity.runId);
  let snapshots = 0;
  const readSnapshot = f.store.readSnapshot.bind(f.store);
  t.mock.method(f.store, "readSnapshot", <T>(read: () => T): T => {
    snapshots++;
    return readSnapshot(read);
  });
  const first = projectInitializedAssuranceEvaluationAssociation(f.input);
  const second = projectInitializedAssuranceEvaluationAssociation(f.input);
  assert.equal(first.status, "matched", JSON.stringify(first));
  assert.deepEqual(second, first);
  assert.equal(snapshots, 2); assert.equal(f.factoryCalls(), 1);
  assert.equal(database.prepare("PRAGMA data_version").get()!.data_version, before);
  assert.equal(first.grades[0]?.verdict, "pass");
  assert.equal(first.assessment, "not_assessed"); assert.equal(first.enforcementAuthorized, false);
  assert.equal(first.attemptBinding.status, "unavailable");
  const host = readRunAssuranceEvidence(f.store, f.activeRuns, f.identity.runId);
  for (const field of ["admission", "budget", "completion", "isolation"] as const)
    assert.deepEqual(host[field], hostBefore[field], "matching evaluation evidence preserves each Host authority dimension");
  assert.ok(!JSON.stringify(first).includes("PRIVATE_EVALUATION_CLAIM"));
  assert.ok(!JSON.stringify(first).includes(f.cwd));
});

test("HTTP association entry point composes a real Store and Host snapshot without initialization", async t => {
  const f = await sqliteFixture(t);
  const body = {
    request: f.request,
    frozenInputs: Object.fromEntries(Object.entries(f.bundle).map(([key, value]) => [key, Buffer.from(value).toString("base64")])),
  };
  const server = createServer((request, response) => {
    void handlePostRunAssuranceEvaluationAssociation(request, response, new URL(request.url ?? "/", "http://local"),
      1, f.registry, f.activeRuns, f.identity.runId);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = new URL(`http://127.0.0.1:${address.port}/runs/${encodeURIComponent(f.identity.runId)}/assurance-evaluation-association`);
  url.searchParams.set("cwd", f.cwd);
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, "matched", JSON.stringify(result));
  assert.equal(result.evaluation.id, f.evaluation.id);
  assert.equal(result.grades[0].gradeId, f.grade.id);
  assert.ok(!JSON.stringify(result).includes("PRIVATE_EVALUATION_CLAIM"));
  assert.equal(f.factoryCalls(), 1);
});

test("cold composition never creates a Store or reads frozen bytes", async t => {
  const f = assuranceAssociationFixture(), ambient = await isolatedWorkspace(t), { cwd } = ambient;
  let factories = 0, frozenReads = 0;
  const registry = new RunStoreRegistry(() => { factories++; throw new Error("must not initialize"); }, { recoverOnOpen: false });
  ambient.onCleanup(() => registry.closeAll());
  const result = projectInitializedAssuranceEvaluationAssociation({ registry, cwd, request: f.request,
    activeRuns: new ActiveRunRegistry(), getFrozenInput() { frozenReads++; return undefined; } });
  assert.equal(result.status, "unavailable");
  assert.ok(result.diagnostics.some(item => item.code === "association.workspace_uninitialized"));
  assert.equal(factories, 0); assert.equal(frozenReads, 0);
  assert.equal(existsSync(resolveRuntimePaths(cwd).databasePath), false);
});

test("composition validates requests before any registry resolution", () => {
  const f = assuranceAssociationFixture(); let reads = 0;
  Object.assign(f.request, { evaluationKey: "invalid" });
  const result = projectInitializedAssuranceEvaluationAssociation({ cwd: "/workspace/association", request: f.request,
    activeRuns: new ActiveRunRegistry(), getFrozenInput: f.ports.getFrozenInput,
    registry: { findInitializedStoreForRun() { reads++; return undefined; } } });
  assert.equal(result.status, "invalid"); assert.equal(reads, 0); assert.equal(result.observationId, null);
});

test("query-only composition refuses a callback write and restores connection state", async t => {
  const f = await sqliteFixture(t);
  const result = projectInitializedAssuranceEvaluationAssociation({ ...f.input, getFrozenInput() {
    f.store.createArtifact({ id: "unexpected-write", runId: f.identity.runId, type: "json", path: "guard.json",
      sealedPayload: { value: 1 }, createdAt: associationNow });
    return undefined;
  } });
  assert.equal(result.status, "unavailable");
  assert.ok(result.diagnostics.some(item => item.code === "association.read_failed"));
  assert.equal(f.store.getArtifact("unexpected-write"), undefined);
  assert.equal(f.store.createArtifact({ id: "after-snapshot", runId: f.identity.runId, type: "json", path: "guard.json",
    sealedPayload: { value: 1 }, createdAt: associationNow }).id, "after-snapshot");
  assert.equal(result.enforcementAuthorized, false);
});

test("composition independently rereads Host pins instead of echoing the submitted source", async t => {
  const f = await sqliteFixture(t);
  f.store.createArtifact({ id: "later-result", runId: f.identity.runId, type: "json", path: "later.json",
    sealedPayload: { later: true }, createdAt: associationNow });
  const result = projectInitializedAssuranceEvaluationAssociation(f.input);
  assert.equal(result.status, "invalid");
  assert.ok(result.diagnostics.some(item => item.code === "association.snapshot_changed"));
  assert.deepEqual(result.grades, []);
  assert.equal(result.attemptBinding.status, "unavailable");
});

test("registry and snapshot exceptions remain sanitized", () => {
  const f = assuranceAssociationFixture();
  const result = projectInitializedAssuranceEvaluationAssociation({ cwd: "/workspace/association", request: f.request,
    activeRuns: new ActiveRunRegistry(), getFrozenInput: f.ports.getFrozenInput,
    registry: { findInitializedStoreForRun() { throw new Error("PRIVATE_DB /private/user.db"); } } });
  assert.equal(result.status, "unavailable");
  assert.ok(!JSON.stringify(result).includes("PRIVATE_DB")); assert.ok(!JSON.stringify(result).includes("/private/"));
});

async function isolatedWorkspace(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "ling-assurance-association-")), cwd = join(root, "workspace");
  await mkdir(cwd);
  const previous = { LING_STACK_HOME: process.env.LING_STACK_HOME,
    LING_STACK_DEFAULT_WORKSPACE_CWD: process.env.LING_STACK_DEFAULT_WORKSPACE_CWD };
  process.env.LING_STACK_HOME = join(root, "user");
  process.env.LING_STACK_DEFAULT_WORKSPACE_CWD = cwd;
  const cleanups: (() => void | Promise<void>)[] = [];
  t.after(async () => {
    try { for (const cleanup of cleanups.reverse()) await cleanup(); }
    finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
  return { cwd, onCleanup: (cleanup: () => void | Promise<void>) => cleanups.push(cleanup) };
}
