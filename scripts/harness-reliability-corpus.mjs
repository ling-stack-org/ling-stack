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
      id: "corpus-root:unit", workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "corpus-root",
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
      const unit = store.createWorkUnit({ id: `${id}:unit`, workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: id,
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

/** Read/plan-only synthetic graph, with equally sized selected and unrelated scopes.
 * Inserts retain production schema checks, foreign keys and lineage triggers. They
 * are not authority receipts and must never be used to dispatch a child/Provider.
 */
export async function createHarnessReliabilityQueryCorpus({ scale = 16 } = {}) {
  if (!Number.isSafeInteger(scale) || scale < 3 || scale > 2_000) throw new TypeError("harness_query_corpus_size_invalid");
  const corpus = await createHarnessReliabilityCorpus({ targets: scale, evaluations: 0 });
  try {
    const { store, database, root, cwd } = corpus;
    const now = HARNESS_CORPUS_SPEC.time, deadline = "2030-01-01T00:00:00.000Z";
    const artifact = store.createArtifact({ id: "corpus-delegation-fact", runId: root.id, type: "json",
      path: "harness/corpus/delegation-read-fact.json", sealedPayload: { syntheticReadFact: true }, createdAt: now });
    const digest = createHash("sha256").update(JSON.stringify({ syntheticReadFact: true })).digest("hex");
    database.prepare(`INSERT INTO delegation_root_budgets(root_run_id,schema_version,authority_artifact_id,authority_digest,
      deadline_at,frozen_at,created_at) VALUES(?,1,?,?,?,?,?)`).run(root.id, artifact.id, digest, deadline, now, now);
    const parentAttempt = store.getWorkUnit(root.workUnitId).activeAttemptId;
    const insertStep = database.prepare(`INSERT INTO delegation_steps(id,schema_version,root_run_id,parent_run_id,parent_attempt_id,
      parent_delegation_step_id,spawn_call_id,objective_artifact_id,required,state,depth,
      permission_snapshot_artifact_id,tool_allowlist_artifact_id,workspace_scope_artifact_id,provider_policy_artifact_id,
      idempotency_key,revision,created_at,updated_at) VALUES(?,1,?,?,?,?,?,?,1,'spawning',?,?,?,?,?,?,0,?,?)`);
    const insertReservation = database.prepare(`INSERT INTO delegation_budget_reservations(id,schema_version,root_run_id,
      delegation_step_id,parent_reservation_id,child_run_id,request_digest,deadline_at,state,idempotency_key,revision,created_at,updated_at)
      VALUES(?,1,?,?,?,?,?,?,'reserved',?,0,?,?)`);
    const bindChild = database.prepare("UPDATE delegation_steps SET child_run_id=?,state='running',revision=1 WHERE id=?");
    const insertCharge = database.prepare(`INSERT INTO delegation_budget_charges(id,schema_version,root_run_id,reservation_id,
      run_id,attempt_id,invocation_id,request_digest,state,idempotency_key,revision,created_at,updated_at)
      VALUES(?,1,?,?,?,?,?,?,'reserved',?,0,?,?)`);
    const createChild = (id, parent) => {
      const runId = `${id}:run`, reservationId = `${id}:reservation`;
      const unit = store.createWorkUnit({ id: `${id}:unit`, workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run",
        ownerType: "delegation_step", ownerId: id, idempotencyKey: `${id}:unit`, status: "queued", createdByActor: "system", request: {}, now });
      const attempt = store.createWorkUnitAttempt({ id: `${id}:attempt`, workUnitId: unit.id, attemptNumber: 1,
        runtimeInstanceId: "corpus-query-runtime", runnerId: "pi", status: "created", now });
      const run = store.createRun({ id: runId, cwd, taskId: root.taskId, workUnitId: unit.id, parentRunId: parent?.run.id ?? root.id,
        providerName: "test", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
      store.linkRunToWorkUnit(run.id, unit.id, now);
      insertStep.run(id, root.id, parent?.run.id ?? root.id, parent?.attempt.id ?? parentAttempt,
        parent?.id ?? null, `${id}:spawn`, artifact.id, parent ? 2 : 1,
        artifact.id, artifact.id, artifact.id, artifact.id, `${id}:key`, now, now);
      insertReservation.run(reservationId, root.id, id, parent?.reservationId ?? null, run.id, digest, deadline, `${id}:reservation-key`, now, now);
      bindChild.run(run.id, id);
      insertCharge.run(`${id}:charge`, root.id, reservationId, run.id, attempt.id, `${id}:invocation`, digest, `${id}:charge-key`, now, now);
      return { id, run, attempt, reservationId };
    };
    const parent = createChild("corpus-delegation-parent");
    let unrelated;
    const insertMessage = database.prepare(`INSERT INTO delegation_messages(id,schema_version,delegation_step_id,direction,kind,
      body_artifact_id,digest,idempotency_key,created_at) VALUES(?,1,?,'parent_to_child','instruction',?,?,?,?)`);
    for (let index = 0; index < scale; index += 1) {
      const ordinal = String(index).padStart(5, "0");
      createChild(`corpus-delegation-selected-${ordinal}`, parent);
      const noise = createChild(`corpus-delegation-unrelated-${ordinal}`);
      unrelated ??= noise;
      for (const [scope, stepId] of [["selected", parent.id], ["unrelated", unrelated.id]]) {
        const id = `corpus-message-${scope}-${ordinal}`;
        insertMessage.run(id, stepId, artifact.id, digest, `${id}:key`, now);
      }
      const prepared = store.prepareContinuationAndAttempt(corpus.preparations[index]);
      const deferred = store.deferRunnerContinuation({ continuationId: prepared.continuation.id,
        expectedRevision: prepared.continuation.revision, nextAttemptAt: now, now });
      if (!deferred.ok) throw new Error("harness_query_corpus_continuation_invalid");
      database.prepare("UPDATE work_units SET status='stale' WHERE id=?").run(prepared.continuation.workUnitId);
    }
    return { ...corpus, delegationParentId: parent.id,
      corpusDigest: createHash("sha256").update(JSON.stringify({ base: corpus.corpusDigest, scale,
        fixture: "delegation-read-scopes-and-startup-keysets-v1", selected: scale, unrelated: scale,
        sharedCreatedAt: now, providerCalls: 0 })).digest("hex") };
  } catch (error) { await corpus.close(); throw error; }
}
