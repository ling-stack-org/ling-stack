import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createSqliteWorkflowIsolationStore, workflowStepStartAuthorityBasis, workflowIsolationScopePlanDigest,
  workflowIsolationStepSafetyFingerprint, toRuntimeAttemptFence } from "../dist/index.js";
import { workflowIsolationFixture, assertIsolationNoWrites, nextCommit, nextTree, baseCommit } from "./support/workflow-isolation-fixture.mjs";

test("factory only returns the registered SQLite adapter, never a duck-typed database", async t => {
  const f = await workflowIsolationFixture(t);
  assert.equal(createSqliteWorkflowIsolationStore(f.store), f.isolation);
  assert.throws(() => createSqliteWorkflowIsolationStore({ database: f.store.database }), /store_not_sqlite/);
  assert.equal("workflowIsolation" in f.store, false);
});

test("scope precedes physical worktree and metadata pin; virtual pinned basis matches later real owner", async t => {
  const f = await workflowIsolationFixture(t, { pin: false });
  await assert.rejects(access(f.executionRoot));
  const original = f.current(f.scopeIsolation), before = workflowStepStartAuthorityBasis(f.store, original);
  assert.equal(original.metadata.isolationScopePlan, undefined);
  const expected = workflowStepStartAuthorityBasis(f.store, { ...original, metadata: { ...original.metadata,
    isolationScopePlan: { planId: f.plan.planId, planDigest: f.plan.planDigest } } });
  assert.notEqual(before, expected);
  assert.equal(f.store.database.prepare("SELECT authority_basis FROM workflow_isolation_scope_plans WHERE plan_id=?").get(f.plan.planId).authority_basis, expected);
  f.persistPin();
  assert.equal(workflowIsolationStepSafetyFingerprint(f.current(f.scopeIsolation)), f.stepFingerprint);
  f.bind();
  assert.equal(f.generation.owner.authorityBasis, expected);
  f.link();
  assert.equal(f.isolation.assertExecutionBinding({ writer: f.writer, requireReady: false, now: f.at(7) }).status, "current");
  assert.equal(f.isolation.assertExecutionBinding({ writer: f.writer, now: f.at(7) }).code, "workflow_isolation.execution_not_ready");
});

test("immutable normalized round/scope and exact binding replays survive SQLite reopen", async t => {
  const f = await workflowIsolationFixture(t); f.bind(); f.link();
  const binding = f.binding();
  f.reopenIsolation();
  assert.deepEqual(f.binding(), binding);
  assert.equal(assertIsolationNoWrites(f, () => f.isolation.createIntegrationRound({ roundId: f.roundId, inputs: f.inputs, now: f.at(8) })).status, "duplicate");
  assert.equal(assertIsolationNoWrites(f, () => f.isolation.createScopePlan({ plan: f.plan, now: f.at(8) })).status, "duplicate");
  assert.equal(assertIsolationNoWrites(f, () => f.isolation.bindExecution({ ...f.bindInput, now: f.at(8) })).status, "duplicate");
  const changed = { ...f.plan, branchRef: "refs/heads/ling/different" };
  changed.planDigest = workflowIsolationScopePlanDigest(changed);
  assert.ok(["invalid", "stale", "conflict"].includes(assertIsolationNoWrites(f,
    () => f.isolation.createScopePlan({ plan: changed, now: f.at(8) })).status));
});

for (const field of ["workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"]) {
  test(`binding and journal reject a stale exact ${field}, including duplicate commands`, async t => {
    const f = await workflowIsolationFixture(t); f.bind(); f.link();
    const stale = { ...f.prepared.fence, [field]: field === "fencingToken" ? "999" : "stale" };
    assert.equal(assertIsolationNoWrites(f, () => f.isolation.bindExecution({ ...f.bindInput, fence: stale })).status, "stale");
    const input = f.intentInput(); assert.equal(f.isolation.recordIntent(input).status, "created");
    const writer = { bindingId: f.writer.bindingId, ...stale };
    assert.equal(assertIsolationNoWrites(f, () => f.isolation.recordIntent({ ...input, writer })).status, "stale");
    assert.equal(f.isolation.assertExecutionBinding({ writer, now: f.at(8), requireReady: false }).status, "stale");
  });
}

for (const fault of ["pin", "basis", "lease", "activeAttempt", "cwd", "runTask", "unitOwner", "admissionPlan", "snapshotPin"]) {
  test(`binding requires persisted lineage, not self-reported JSON: ${fault}`, async t => {
    const f = await workflowIsolationFixture(t); f.prepare();
    if (fault === "pin") f.store.updateChannelWorkflowStep(f.plan.workflowStepId, { metadata: {
      ...f.current(f.scopeIsolation).metadata, isolationScopePlan: { planId: "forged", planDigest: f.plan.planDigest } } }, f.at(4));
    if (fault === "basis") f.store.database.prepare("UPDATE channel_workflow_steps SET prompt='changed' WHERE id=?").run(f.plan.workflowStepId);
    if (fault === "lease") f.store.database.prepare("UPDATE resource_leases SET status='released',released_at=? WHERE id=?").run(f.at(4), f.generation.owner.leaseId);
    if (fault === "activeAttempt") f.store.database.prepare("UPDATE work_units SET active_attempt_id=NULL WHERE id=?").run(f.prepared.unit.id);
    if (fault === "cwd") f.store.database.prepare("UPDATE run_sessions SET cwd=? WHERE id=?").run(f.cwd, f.prepared.run.id);
    if (fault === "runTask") f.store.database.prepare("UPDATE run_sessions SET workflow_step_id=NULL WHERE id=?").run(f.prepared.run.id);
    if (fault === "unitOwner") f.store.database.prepare("UPDATE work_units SET owner_id='foreign' WHERE id=?").run(f.prepared.unit.id);
    if (fault === "admissionPlan") {
      const reduced = structuredClone(f.scopeIsolation.plan); reduced.resourceKeys.pop();
      f.store.database.prepare("UPDATE workflow_step_admissions SET plan_json=? WHERE task_id=?").run(JSON.stringify(reduced), f.generation.task.id);
      f.store.database.prepare("DELETE FROM workflow_step_admission_entries WHERE task_id=? AND resource_key='port:17449'").run(f.generation.task.id);
    }
    if (fault === "snapshotPin") f.store.database.prepare("UPDATE run_sessions SET request_snapshot_json=? WHERE id=?")
      .run(JSON.stringify({ workflowIsolationPlan: { planId: "foreign", planDigest: f.plan.planDigest } }), f.prepared.run.id);
    const result = assertIsolationNoWrites(f, () => f.isolation.bindExecution(f.bindInput));
    assert.ok(["stale", "invalid"].includes(result.status), JSON.stringify(result));
  });
}

test("binding cannot be created after Runner start or reclaim another binding's immutable plan", async t => {
  const f = await workflowIsolationFixture(t); f.bind(); f.link();
  assert.equal(assertIsolationNoWrites(f, () => f.isolation.bindExecution({ ...f.bindInput, bindingId: "other-binding" })).code,
    "workflow_isolation.binding_identity_retained");
  f.store.database.prepare("UPDATE work_unit_attempts SET started_at=?,status='started' WHERE id=?").run(f.at(7), f.prepared.attempt.id);
  assert.equal(assertIsolationNoWrites(f, () => f.isolation.bindExecution({ ...f.bindInput, bindingId: "new-binding" })).status, "conflict");
});

test("intent/receipt/ready are revision CAS commands with persistent exact replay", async t => {
  const f = await workflowIsolationFixture(t); f.bind(); f.link();
  const input = f.intentInput(), intent = f.isolation.recordIntent(input).value;
  assert.equal(f.binding().revision, 1);
  assert.equal(assertIsolationNoWrites(f, () => f.peerIsolation.recordIntent({ ...input, now: f.at(8) })).status, "duplicate");
  assert.equal(assertIsolationNoWrites(f, () => f.isolation.recordIntent({ ...input, intentId: "second", commandId: "second", expectedRevision: 1 })).code,
    "workflow_isolation.effect_unconfirmed");
  const receiptInput = f.receiptInput(intent);
  assert.equal(assertIsolationNoWrites(f, () => f.isolation.recordReceipt({ ...receiptInput, expectedRevision: 0 })).code, "workflow_isolation.revision_changed");
  const receipt = f.isolation.recordReceipt(receiptInput);
  assert.equal(receipt.status, "created"); assert.equal(f.binding().revision, 2);
  const readyInput = { commandId: "ready-once", writer: f.writer, expectedRevision: 2, creationReceiptId: receipt.value.receiptId, now: f.at(10) };
  assert.equal(f.isolation.markExecutionReady(readyInput).status, "updated");
  assert.equal(f.binding().revision, 3);
  f.reopenIsolation();
  assert.equal(assertIsolationNoWrites(f, () => f.isolation.recordIntent(input)).status, "duplicate");
  assert.equal(assertIsolationNoWrites(f, () => f.isolation.recordReceipt(receiptInput)).status, "duplicate");
  assert.equal(assertIsolationNoWrites(f, () => f.isolation.markExecutionReady(readyInput)).status, "duplicate");
  assert.equal(f.isolation.assertExecutionBinding({ writer: f.writer, now: f.at(11) }).status, "current");
  assert.equal(assertIsolationNoWrites(f, () => f.isolation.markExecutionReady({ ...readyInput, expectedRevision: 3 })).code, "workflow_isolation.command_id_reused");
});

test("confirmed receipt requires exact expected after and an immutable artifact belonging to the real Run", async t => {
  const f = await workflowIsolationFixture(t); f.bind(); f.link(); const intent = f.intent();
  const input = f.receiptInput(intent);
  for (const changed of [{ observed: { ...intent.after, headCommit: nextCommit } }, { artifactId: "missing" }]) {
    assert.equal(assertIsolationNoWrites(f, () => f.isolation.recordReceipt({ ...input, ...changed })).status, "invalid");
  }
  const task = f.store.createTask({ channelId: f.channel.id, title: "Other", prompt: "Other" }, f.at(8));
  const run = f.store.createRun({ id: "foreign-run", cwd: f.cwd, taskId: task.id, providerName: "fixture", providerModel: "fixture",
    taskSnapshot: task, providerSnapshot: {}, requestSnapshot: {}, createdAt: f.at(8) });
  const foreign = f.store.createArtifact({ runId: run.id, type: "json", path: "foreign.json", sealedPayload: { observed: intent.after }, createdAt: f.at(8) });
  assert.equal(assertIsolationNoWrites(f, () => f.isolation.recordReceipt({ ...input, artifactId: foreign.id })).code,
    "workflow_isolation.receipt_artifact_mismatch");
  assert.equal(f.isolation.recordReceipt(input).status, "created");
  assert.equal(assertIsolationNoWrites(f, () => f.isolation.recordReceipt({ ...input, receiptId: "second-receipt", expectedRevision: 2 })).status, "stale");
});

test("unknown Git effect remains owned across TTL/reopen; only exact reconciliation clears its pending intent", async t => {
  const f = await workflowIsolationFixture(t); f.bind(); f.link(); const intent = f.intent();
  const unknown = f.receiptInput(intent, { receiptId: "unknown-receipt", outcome: "effect_unknown", observed: intent.before });
  assert.equal(f.isolation.recordReceipt(unknown).status, "created");
  assert.equal(f.binding().openIntentId, intent.intentId);
  f.reopenIsolation();
  assert.equal(f.isolation.listPendingIntents({ roundId: f.roundId })[0].status, "effect_unknown");
  assert.equal(f.isolation.listPendingIntents({ bindingId: f.writer.bindingId }).length, 1);
  assert.equal(f.store.expireRuntimeSemaphoreSlots(f.at(10_000)), 0);
  assert.equal(f.isolation.assertExecutionBinding({ writer: f.writer, now: f.at(10_000), requireReady: false }).code,
    "workflow_isolation.start_lease_changed");
  const confirmed = f.receiptInput(intent, { receiptId: "reconciled-receipt" });
  assert.equal(f.isolation.recordReceipt(confirmed).status, "created");
  assert.equal(f.binding().openIntentId, undefined);
  assert.deepEqual(f.isolation.listPendingIntents(), []);
  assert.equal(f.isolation.getReceipt("unknown-receipt").outcome, "effect_unknown");
});

test("late writes from replaced Attempt cannot mutate or replay the binding journal", async t => {
  const f = await workflowIsolationFixture(t); f.makeReady();
  const old = f.writer;
  const target = f.store.createWorkUnitAttempt({ id: "isolation-attempt-2", workUnitId: old.workUnitId, attemptNumber: 2,
    runtimeInstanceId: "isolation-runtime-2", runnerId: "pi", now: f.at(11) });
  assert.equal(assertIsolationNoWrites(f, () => f.isolation.markExecutionReady({ commandId: "isolation-ready", writer: old,
    expectedRevision: 2, creationReceiptId: f.binding().creationReceiptId, now: f.at(12) })).status, "stale");
  assert.equal(f.isolation.assertExecutionBinding({ writer: old, now: f.at(12) }).status, "stale");
  assert.equal(f.isolation.assertExecutionBinding({ writer: { bindingId: old.bindingId, ...toRuntimeAttemptFence(target) }, now: f.at(12) }).status, "stale");
});

test("round CAS retains last confirmed phase, freezes writer, and explicitly creates a new retained generation", async t => {
  const f = await workflowIsolationFixture(t); f.makeReady();
  assert.equal(f.advance("collecting").status, "updated");
  const old = f.round();
  assert.equal(assertIsolationNoWrites(f, () => f.advance("blocked", { expectedRevision: 0, reason: "Stop" })).status, "stale");
  assert.equal(f.advance("blocked", { reason: "Host cancelled before integration" }).status, "updated");
  assert.equal(f.round().lastConfirmedPhase, "collecting");
  const inputs = { ...f.inputs, integration: { executionRoot: `${f.root}/isolated-integration-2`, worktreeId: "integration-2", branchRef: "refs/heads/ling/integration-2" } };
  const input = { commandId: "next-generation", roundId: f.roundId, expectedGeneration: 1, expectedRevision: f.round().revision,
    inputs, writer: f.writer, now: f.at(15) };
  assert.equal(f.isolation.beginIntegrationRoundGeneration(input).status, "created");
  assert.equal(f.round().generation, 2); assert.equal(f.round().revision, 0);
  assert.equal(f.isolation.getIntegrationRound(f.roundId, 1).phase, "blocked");
  assert.equal(f.isolation.getIntegrationRound(f.roundId, 1).inputsDigest, old.inputsDigest);
  assert.equal(assertIsolationNoWrites(f, () => f.isolation.beginIntegrationRoundGeneration(input)).status, "duplicate");
  assert.equal(assertIsolationNoWrites(f, () => f.advance("collecting")).status, "stale");
});

test("full integration journal can reach frozen candidate but cannot pretend target apply is approved", async t => {
  const f = await workflowIsolationFixture(t); f.makeReady();
  assert.equal(f.advance("collecting").status, "updated");
  const scope = { type: "round", roundId: f.roundId, generation: 1 };
  const intentInput = (kind, before, after) => ({ intentId: `round-${kind}`, commandId: `round-${kind}`, scope,
    expectedRevision: f.round().revision, writer: f.writer, kind, before, after, now: f.at(13) });
  const before = f.gitIdentity(false, f.inputs.integration), initial = f.gitIdentity(true, f.inputs.integration);
  const create = f.isolation.recordIntent(intentInput("integration_create", before, initial)); assert.equal(create.status, "created");
  const creation = f.receipt(create.value);
  assert.equal(f.advance("integrating", { receiptIds: [creation.receiptId] }).status, "updated");
  const merged = { ...initial, headCommit: nextCommit, tree: nextTree };
  const integrate = f.isolation.recordIntent(intentInput("integrate_branch", initial, merged)); assert.equal(integrate.status, "created");
  f.receipt(integrate.value);
  assert.equal(f.advance("verifying").status, "updated");
  const verify = f.isolation.recordIntent(intentInput("candidate_verify", merged, merged)); assert.equal(verify.status, "created");
  const verified = f.receipt(verify.value);
  const candidate = { commit: nextCommit, tree: nextTree, packetDigest: "packet-digest", branchResultDigests: ["branch-result-1"], validationDigest: "validation-digest" };
  assert.equal(f.advance("awaiting_approval", { receiptIds: [verified.receiptId], candidate }).status, "updated");
  assert.equal(f.round().phase, "awaiting_approval"); assert.deepEqual(f.round().candidate, candidate);
  assert.equal(assertIsolationNoWrites(f, () => f.advance("applying", { approvalId: "model-claimed-approved" })).code, "workflow_isolation.merge_permit_not_implemented");
  const target = f.gitIdentity(true, f.inputs.target);
  assert.equal(assertIsolationNoWrites(f, () => f.isolation.recordIntent({ ...intentInput("target_apply", target, { ...target, headCommit: nextCommit }),
    kind: "target_apply" })).code, "workflow_isolation.merge_permit_not_implemented");
});

test("a pending physical effect blocks phase advance and generation replacement without dropping ownership", async t => {
  const f = await workflowIsolationFixture(t); f.makeReady(); assert.equal(f.advance("collecting").status, "updated");
  const intent = f.isolation.recordIntent({ intentId: "integration-unknown", commandId: "integration-unknown", scope: { type: "round", roundId: f.roundId, generation: 1 },
    expectedRevision: f.round().revision, writer: f.writer, kind: "integration_create", before: f.gitIdentity(false, f.inputs.integration),
    after: f.gitIdentity(true, f.inputs.integration), now: f.at(13) }).value;
  assert.equal(f.receipt(intent, { outcome: "effect_unknown", observed: intent.before }).outcome, "effect_unknown");
  assert.equal(assertIsolationNoWrites(f, () => f.advance("blocked", { reason: "Cannot erase unknown effect" })).code, "workflow_isolation.round_effects_unconfirmed");
  assert.equal(f.round().phase, "collecting"); assert.equal(f.round().openIntentId, intent.intentId);
});

for (const operation of ["intent", "receipt", "ready", "generation"]) {
  test(`${operation} rolls back journal and all CAS writes after a late SQLite fault`, async t => {
    const f = await workflowIsolationFixture(t); f.bind(); f.link();
    let action;
    if (operation === "intent") {
      const input = f.intentInput();
      f.store.database.exec("CREATE TEMP TRIGGER isolation_fault BEFORE UPDATE ON workflow_isolation_bindings BEGIN SELECT RAISE(ABORT,'isolation-fault'); END");
      action = () => f.isolation.recordIntent(input);
    } else if (operation === "receipt") {
      const intent = f.intent(), input = f.receiptInput(intent);
      f.store.database.exec("CREATE TEMP TRIGGER isolation_fault BEFORE UPDATE ON workflow_isolation_bindings BEGIN SELECT RAISE(ABORT,'isolation-fault'); END");
      action = () => f.isolation.recordReceipt(input);
    } else {
      const intent = f.intent(), receipt = f.receipt(intent);
      const ready = { commandId: "fault-ready", writer: f.writer, expectedRevision: f.binding().revision, creationReceiptId: receipt.receiptId, now: f.at(10) };
      if (operation === "ready") {
        f.store.database.exec("CREATE TEMP TRIGGER isolation_fault BEFORE INSERT ON workflow_isolation_commands BEGIN SELECT RAISE(ABORT,'isolation-fault'); END");
        action = () => f.isolation.markExecutionReady(ready);
      } else {
        assert.equal(f.isolation.markExecutionReady(ready).status, "updated"); assert.equal(f.advance("blocked", { reason: "Generation test" }).status, "updated");
        const input = { commandId: "fault-generation", roundId: f.roundId, expectedGeneration: 1, expectedRevision: f.round().revision,
          inputs: { ...f.inputs, integration: { executionRoot: `${f.root}/next-root`, worktreeId: "next-id", branchRef: "refs/heads/ling/next" } }, writer: f.writer, now: f.at(14) };
        f.store.database.exec("CREATE TEMP TRIGGER isolation_fault BEFORE INSERT ON workflow_isolation_commands BEGIN SELECT RAISE(ABORT,'isolation-fault'); END");
        action = () => f.isolation.beginIntegrationRoundGeneration(input);
      }
    }
    const before = f.snapshotIsolation(); assert.throws(action, /isolation-fault/); assert.deepEqual(f.snapshotIsolation(), before);
  });
}

test("owned transactions never adopt or rollback the caller's BEGIN", async t => {
  const f = await workflowIsolationFixture(t);
  f.store.database.exec("BEGIN IMMEDIATE");
  try {
    f.store.database.prepare("UPDATE channel_workflows SET title='caller-wip' WHERE id=?").run(f.plan.workflowId);
    assert.throws(() => f.isolation.createIntegrationRound({ roundId: "nested", inputs: f.inputs, now: f.at(1) }), /transaction/i);
    assert.equal(f.store.database.isTransaction, true);
    assert.equal(f.store.getChannelWorkflow(f.plan.workflowId).title, "caller-wip");
  } finally { f.store.database.exec("ROLLBACK"); }
});

async function isolationRace(t, f, operations) {
  const moduleUrl = import.meta.resolve("../dist/index.js");
  const source = `const {parentPort,workerData:d}=require("node:worker_threads");
    (async()=>{if(d.sourceLoaderUrl)await import(d.sourceLoaderUrl);
    const m=await import(d.moduleUrl),store=m.createSqliteRunStore(d.cwd,d.paths),isolation=m.createSqliteWorkflowIsolationStore(store);
    parentPort.once("message",()=>{try{parentPort.postMessage({type:"result",value:isolation[d.method](d.input)})}
    catch(error){parentPort.postMessage({type:"error",message:String(error)})}finally{store.close()}});
    parentPort.postMessage({type:"ready"})})().catch(error=>parentPort.postMessage({type:"error",message:String(error)}));`;
  const workers = operations.map(op => new Worker(source, { eval: true, workerData: { ...op, moduleUrl, cwd: f.cwd, paths: f.paths,
    ...(moduleUrl.endsWith(".ts") ? { sourceLoaderUrl: new URL("./support/workflow-step-admission-source-loader.mjs", import.meta.url).href } : {}) } }));
  try {
    await Promise.all(workers.map(async worker => { const [message] = await once(worker, "message", { signal: t.signal }); assert.equal(message.type, "ready", JSON.stringify(message)); }));
    const waits = workers.map(worker => once(worker, "message", { signal: t.signal })); workers.forEach(worker => worker.postMessage("go"));
    return (await Promise.all(waits)).map(([message]) => { assert.equal(message.type, "result", JSON.stringify(message)); return message.value; });
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
}

test("independent real SQLite writers CAS one intent, without partial second journal writes", async t => {
  const f = await workflowIsolationFixture(t); f.bind(); f.link();
  const input = f.intentInput();
  const results = await isolationRace(t, f, [input, { ...input, intentId: "race-intent-2", commandId: "race-command-2" }]
    .map(value => ({ method: "recordIntent", input: value })));
  assert.deepEqual(results.map(r => r.status).sort(), ["created", "stale"]);
  assert.equal(f.isolation.listPendingIntents().length, 1); assert.equal(f.binding().revision, 1);
});

test("independent real SQLite bind writers cannot claim a second owner of the same plan", async t => {
  const f = await workflowIsolationFixture(t); f.prepare();
  const results = await isolationRace(t, f, [f.bindInput, { ...f.bindInput, bindingId: "race-binding-2" }].map(input => ({ method: "bindExecution", input })));
  assert.deepEqual(results.map(r => r.status).sort(), ["conflict", "created"]);
  assert.equal(Number(f.peer.database.prepare("SELECT COUNT(*) AS count FROM workflow_isolation_bindings").get().count), 1);
});
