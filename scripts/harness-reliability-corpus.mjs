import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, resolveRuntimePaths, toRuntimeAttemptFence } from "../packages/core/dist/index.js";

export const HARNESS_CORPUS_SPEC = Object.freeze({ schemaVersion: 1, seed: "ling-harness-t13b-20261019-v1", time: "2026-10-19T00:00:00.000Z" });

/** Synthetic QA-only on-disk database. No Provider, real user database, network or credentials. */
export async function createHarnessReliabilityCorpus({ targets = 1, evaluations = 1 } = {}) {
  if (![targets, evaluations].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 10_000)) throw new TypeError("harness_corpus_size_invalid");
  const cwd = await mkdtemp(join(tmpdir(), "ling-t13b-corpus-"));
  let store; let database;
  try {
    store = createSqliteRunStore(cwd);
    database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
    const now = HARNESS_CORPUS_SPEC.time;
    const channel = store.createChannel({ name: "T13B isolated corpus", boundPath: cwd }, now);
    const task = store.createTask({ channelId: channel.id, title: "T13B corpus", prompt: "Synthetic QA only" }, now);
    const rootUnit = store.createWorkUnit({
      workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "corpus-root",
      idempotencyKey: "corpus-root-unit", status: "succeeded", createdByActor: "system", request: {}, now,
    });
    const attempt = store.createWorkUnitAttempt({
      id: "corpus-source-attempt", workUnitId: rootUnit.id, attemptNumber: 1, runtimeInstanceId: "corpus-source-runtime",
      runnerId: "runner_pi_embedded", effectiveRunnerId: "runner_pi_embedded", status: "succeeded", now,
    });
    const root = store.createRun({ id: "corpus-root", cwd, taskId: task.id, workUnitId: rootUnit.id,
      providerName: "test", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {},
      contextViewId: "corpus-root-context", contextViewCreatedAt: now, createdAt: now });
    store.linkRunToWorkUnit(root.id, rootUnit.id, now); store.markRunSucceeded(root.id, now);
    const preparations = [];
    for (let index = 0; index < targets; index += 1) {
      const id = `corpus-target-${String(index).padStart(5, "0")}`;
      const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: id,
        idempotencyKey: `${id}:unit`, status: "queued", createdByActor: "system", request: {}, now });
      const run = store.createRun({ id, cwd, taskId: task.id, workUnitId: unit.id, parentRunId: root.id,
        providerName: "test", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {},
        contextViewId: `${id}:context`, contextViewCreatedAt: now, createdAt: now });
      store.linkRunToWorkUnit(run.id, unit.id, now);
      const artifact = store.createArtifact({ id: `${id}:context-artifact`, runId: run.id, type: "json",
        path: `harness/corpus/${id}.json`, sealedPayload: { contextViewId: `${id}:context` }, createdAt: now });
      preparations.push({ id: `${id}:continuation`, runId: run.id, workUnitId: unit.id, sourceFence: toRuntimeAttemptFence(attempt),
        expectedTargetAttemptId: null, origin: "queued_followup", strategy: "deterministic_replay", runnerId: "runner_pi_embedded",
        runnerCapabilityRevision: "corpus:1", contextViewId: `${id}:context`, contextSnapshotArtifactId: artifact.id,
        idempotencyKey: `${id}:continuation-key`, generation: 0,
        targetAttempt: { id: `${id}:attempt`, runtimeInstanceId: "corpus-target-runtime", runnerId: "runner_pi_embedded", effectiveRunnerId: "runner_pi_embedded" }, now });
    }
    const makeArtifact = (id, payload) => store.createArtifact({ id, runId: root.id, type: "json", path: `harness/corpus/${id}.json`, sealedPayload: payload, createdAt: now });
    const suite = makeArtifact("corpus-suite", { id: "t13b", version: "1", cases: ["json"] });
    const testCase = makeArtifact("corpus-case", { schemaVersion: 1, kind: "deterministic_json_rule", graderId: "t13b-rule", graderVersion: "1",
      failureSeverity: "error", assertions: [{ type: "deep_equal" }] });
    const baseline = makeArtifact("corpus-baseline", { stable: true, ordinal: -1 });
    const evaluationRows = [];
    for (let index = 0; index < evaluations; index += 1) {
      const id = `corpus-evaluation-${String(index).padStart(5, "0")}`;
      const candidate = makeArtifact(`${id}:candidate`, { stable: true, ordinal: index });
      const queued = store.enqueueRunEvaluation({ id, runId: root.id, rootRunId: root.id,
        suiteId: "t13b", suiteVersion: "1", suiteArtifactId: suite.id, caseId: "json", caseVersion: "1", caseArtifactId: testCase.id,
        baselineId: "baseline", baselineVersion: "1", baselineArtifactId: baseline.id, candidateArtifactId: candidate.id, now });
      evaluationRows.push(queued.evaluation);
    }
    const corpusDigest = createHash("sha256").update(JSON.stringify({ ...HARNESS_CORPUS_SPEC, targets, evaluations,
      runIds: preparations.map(input => input.runId), evaluationIds: evaluationRows.map(row => row.id),
      fixtureIdentity: "task/channel generated IDs excluded; canonical source/evaluation contents fixed" })).digest("hex");
    return { cwd, store, database, root, preparations, evaluationRows, corpusDigest,
      async close() { database.close(); store.close(); await rm(cwd, { recursive: true, force: true }); } };
  } catch (error) {
    try { database?.close(); } finally { try { store?.close(); } finally { await rm(cwd, { recursive: true, force: true }); } }
    throw error;
  }
}
