import assert from "node:assert/strict";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { inspectSealedWorkflowBranchResult, workflowGitPacketDigest }
  from "../dist/features/channels/workflow-branch-result.js";
import { reconcileWorkflowIsolatedResults } from "../dist/features/channels/workflow-isolated-result.js";
import { orchestrateChannelWorkflow } from "../dist/features/channels/orchestrator.js";
import { interruptedResultIsolation, nativeGit, now, sha256, workflowIsolatedResultFixture }
  from "./support/workflow-isolated-result-fixture.mjs";

function requireJournal(f) {
  for (const method of ["recordTerminalResultIntent", "getTerminalResultIntent", "recordTerminalResultReceipt", "getTerminalResultReceipt"])
    assert.equal(typeof f.isolation[method], "function", `current Core must implement ${method}; do not substitute a test journal`);
}

function authority(f) {
  const result = f.isolation.assertTerminalCapture({ writer: f.writer, expectedRevision: f.binding().revision, now: now() });
  assert.equal(result.status, "authorized", JSON.stringify(result));
  return result;
}

function orchestrate(f) {
  return orchestrateChannelWorkflow({ store: f.store, cwd: f.cwd, workflowId: f.plan.workflowId,
    validateRunRequest() { assert.fail("a terminal result must not prepare a new Run"); },
    async startRun() { assert.fail("result reconciliation must never redispatch a Runner"); } });
}

async function assertUnpublished(f, action, code) {
  const heads = [await f.git("rev-parse", "HEAD"), await f.branchGit("rev-parse", "HEAD")];
  await assert.rejects(action(), { code });
  assert.equal(await f.ref(), null);
  assert.deepEqual([await f.git("rev-parse", "HEAD"), await f.branchGit("rev-parse", "HEAD")], heads);
  assert.deepEqual(await readFile(join(f.gitDir, "index")), f.originalIndex);
}

async function interruptAfterIntent(f) {
  const fault = new Error("fixture: crash after durable result intent");
  await assert.rejects(f.capture({ isolation: interruptedResultIsolation(f, "recordTerminalResultIntent", fault, { after: true }) }),
    error => error === fault);
  const intent = f.intent();
  assert.equal(intent.status, "pending");
  assert.equal(await f.ref(), null);
  return intent;
}

async function interruptAfterRef(f) {
  await assert.rejects(f.capture({ isolation: interruptedResultIsolation(f, "recordTerminalResultReceipt", new Error("fixture: journal unavailable")) }),
    { code: "workflow_result_receipt_unconfirmed" });
  const intent = f.intent();
  assert.equal(intent.status, "pending");
  assert.equal(await f.ref(), intent.commit);
  return intent;
}

test("no-change terminal capture seals real Git/SQLite evidence without manufacturing validation or target apply", nativeGit, async t => {
  const f = await workflowIsolatedResultFixture(t);
  requireJournal(f);
  const proof = authority(f), before = await f.gitSnapshot();
  assert.equal(f.binding().startOwner.phase, "preparing", "the immutable binding retains its admitted original owner");
  assert.equal(f.current(f.scopeIsolation).metadata.startOwner.phase, "linked", "the live execution has actually been linked");
  assert.equal(proof.terminal.completion.effectCoverage, "pi_no_tools_v1");
  assert.equal(f.blocker(), "workflow_isolation.result_ref_unconfirmed");
  const result = await f.capture(), { packet } = result;
  assert.equal(result.status, "sealed");
  assert.equal(result.packetDigest, workflowGitPacketDigest(packet));
  assert.equal(await f.ref(), result.commit);
  assert.notEqual(result.commit, f.plan.baseCommit);
  assert.equal(result.tree, await f.git("rev-parse", `${f.plan.baseCommit}^{tree}`));
  assert.equal(await f.git("rev-list", "--parents", "-n", "1", result.commit), `${result.commit} ${f.plan.baseCommit}`);
  assert.deepEqual(packet.context.allowedPaths, []);
  assert.deepEqual(packet.changedPaths, []);
  assert.equal(packet.patch, "");
  assert.equal(packet.patchDigest, sha256(""));
  assert.deepEqual(packet.terminal.validations, [], "no validation command was executed");
  assert.deepEqual(packet.terminal.unknownEffects, []);
  assert.equal(packet.terminal.outcome, "succeeded");
  assert.deepEqual(packet.context.lineage, packet.terminal.lineage);
  assert.equal(packet.context.lineage.bindingId, f.writer.bindingId);
  assert.deepEqual(packet.context.lineage.startOwner, f.current(f.scopeIsolation).metadata.startOwner);
  assert.equal(packet.context.lineage.startOwner.phase, "linked");
  assert.equal(f.binding().startOwner.phase, "preparing", "capture must not rewrite the immutable binding owner");
  assert.equal(packet.context.lineage.canonicalWorkspaceRoot, f.cwd);
  assert.equal(packet.context.scope.executionRoot, f.executionRoot);
  for (const id of [packet.terminal.terminalArtifactRef, packet.terminal.quiescenceArtifactRef,
    packet.terminal.toolCompletionArtifactRef, packet.terminal.outputPacketArtifactRef, ...packet.terminal.contextArtifactRefs]) {
    const artifact = f.store.getArtifact(id);
    assert.equal(artifact.runId, f.runId);
    assert.equal(artifact.contentSha256, sha256(JSON.stringify(artifact.sealedPayload)));
  }
  const context = f.store.getArtifact(packet.terminal.contextArtifactRefs[0]).sealedPayload;
  assert.equal(context.sourceArtifactId, f.contextArtifact.id);
  assert.equal(context.packet.workflowStepId, f.plan.workflowStepId);
  const step = f.current(f.scopeIsolation);
  assert.equal(step.metadata.outputArtifactId, packet.terminal.outputPacketArtifactRef);
  assert.ok(step.metadata.outputArtifactIds.includes(packet.terminal.outputPacketArtifactRef));
  assert.deepEqual(authority(f), proof, "projecting output metadata must not change terminal authority");
  const intent = f.intent();
  assert.equal(intent.status, "confirmed");
  assert.equal(intent.proofDigest, proof.proofDigest);
  assert.equal(intent.packetDigest, result.packetDigest);
  assert.deepEqual(f.store.getArtifact(intent.packetArtifactId).sealedPayload, packet);
  assert.equal(f.blocker(), undefined);
  await inspectSealedWorkflowBranchResult(f.cwd, result);
  const after = await f.gitSnapshot();
  assert.equal(after.head, before.head);
  assert.equal(after.branchHead, before.branchHead);
  assert.deepEqual(after.index, before.index);
  assert.equal(await readFile(join(f.cwd, "owned.txt"), "utf8"), "base\n");
});

test("duplicate capture and database reopen reuse exactly one result ref, packet and receipt", nativeGit, async t => {
  const f = await workflowIsolatedResultFixture(t);
  requireJournal(f);
  const result = await f.capture(), snapshot = await f.resultSnapshot();
  assert.deepEqual(await f.capture(), result);
  assert.deepEqual(await f.resultSnapshot(), snapshot);
  f.reopenIsolation();
  assert.deepEqual(await f.capture(), result);
  assert.deepEqual(await f.resultSnapshot(), snapshot, "reopen must not recapture, rewrite a ref or append artifacts");
  assert.equal(f.blocker(), undefined);
});

test("pending intent without a ref becomes blocked after reopen and is never replayed", nativeGit, async t => {
  const f = await workflowIsolatedResultFixture(t);
  requireJournal(f);
  const intent = await interruptAfterIntent(f), before = await f.gitSnapshot();
  f.reopenIsolation();
  await assert.rejects(f.capture(), { code: "workflow_isolation.result_ref_unconfirmed" });
  assert.equal(f.intent().status, "blocked");
  assert.equal(f.intent().commit, intent.commit);
  assert.deepEqual(await f.gitSnapshot(), before, "recovery observes absence; it never publishes the pending commit");
  const snapshot = await f.resultSnapshot();
  await assert.rejects(f.capture(), { code: "workflow_isolation.result_ref_unconfirmed" });
  assert.deepEqual(await f.resultSnapshot(), snapshot);
  assert.equal(f.blocker(), "workflow_isolation.result_ref_unconfirmed");
});

test("pending intent with its exact ref is observed and confirmed after reopen with no repeated Git effect", nativeGit, async t => {
  const f = await workflowIsolatedResultFixture(t);
  requireJournal(f);
  const intent = await interruptAfterRef(f), before = await f.gitSnapshot();
  f.reopenIsolation();
  const result = await f.capture();
  assert.equal(result.commit, intent.commit);
  assert.equal(result.packetDigest, intent.packetDigest);
  assert.equal(f.intent().status, "confirmed");
  assert.deepEqual(await f.gitSnapshot(), before, "observing the existing ref must not write another commit/ref/reflog entry");
  const rows = f.store.database.prepare("SELECT * FROM workflow_isolation_result_receipts WHERE intent_id=?").all(intent.intentId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "confirmed");
  assert.equal(f.blocker(), undefined);
  const snapshot = await f.resultSnapshot();
  assert.deepEqual(await f.capture(), result);
  assert.deepEqual(await f.resultSnapshot(), snapshot);
});

test("pending result ref drift records an unknown effect and cannot overwrite the observed ref", nativeGit, async t => {
  const f = await workflowIsolatedResultFixture(t);
  requireJournal(f);
  const intent = await interruptAfterRef(f);
  await f.git("update-ref", "--no-deref", f.resultRef, f.plan.baseCommit, intent.commit);
  const before = await f.gitSnapshot();
  f.reopenIsolation();
  await assert.rejects(f.capture(), { code: "workflow_isolation.result_ref_unconfirmed" });
  assert.equal(f.intent().status, "effect_unknown");
  assert.equal(await f.ref(), f.plan.baseCommit);
  assert.deepEqual(await f.gitSnapshot(), before);
  const snapshot = await f.resultSnapshot();
  await assert.rejects(f.capture(), { code: "workflow_isolation.result_ref_unconfirmed" });
  assert.deepEqual(await f.resultSnapshot(), snapshot);
});

for (const fault of ["missing", "drift"]) {
  test(`confirmed result with ${fault} ref is rejected after reopen without replay`, nativeGit, async t => {
    const f = await workflowIsolatedResultFixture(t);
    requireJournal(f);
    const result = await f.capture();
    if (fault === "missing") await f.git("update-ref", "--no-deref", "-d", f.resultRef, result.commit);
    else await f.git("update-ref", "--no-deref", f.resultRef, f.plan.baseCommit, result.commit);
    f.reopenIsolation();
    const snapshot = await f.gitSnapshot();
    await assert.rejects(f.capture(), { code: "workflow_isolation.result_ref_unconfirmed" });
    assert.deepEqual(await f.gitSnapshot(), snapshot, "a refusal may record diagnostics but must not replay any Git effect");
    assert.equal(f.intent().commit, result.commit);
    assert.equal(await f.ref(), fault === "missing" ? null : f.plan.baseCommit);
  });
}

test("orchestration of a valid confirmed result can complete without preparing or dispatching another Run", nativeGit, async t => {
  const f = await workflowIsolatedResultFixture(t);
  requireJournal(f);
  await f.capture();
  const result = await orchestrate(f);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(f.current(f.scopeIsolation).status, "succeeded");
  assert.equal(f.store.getChannelWorkflow(f.plan.workflowId).status, "succeeded");
});

for (const fault of ["missing", "drift"]) {
  test(`confirmed ref ${fault} cannot become workflow success through reconcile/orchestrate`, nativeGit, async t => {
    const f = await workflowIsolatedResultFixture(t);
    requireJournal(f);
    const result = await f.capture();
    const original = { run: f.run(), attempt: f.store.getWorkUnitAttempt(f.writer.attemptId), binding: f.binding(),
      runs: f.store.database.prepare("SELECT id FROM run_sessions ORDER BY id").all(),
      attempts: f.store.database.prepare("SELECT id FROM work_unit_attempts ORDER BY id").all() };
    if (fault === "missing") await f.git("update-ref", "--no-deref", "-d", f.resultRef, result.commit);
    else await f.git("update-ref", "--no-deref", f.resultRef, f.plan.baseCommit, result.commit);
    f.reopenIsolation();
    const before = await f.gitSnapshot();
    await assert.rejects(f.capture(), { code: "workflow_isolation.result_ref_unconfirmed" });
    await reconcileWorkflowIsolatedResults(f.store, f.plan.workflowId, now);
    assert.equal(f.current(f.scopeIsolation).status, "blocked");
    assert.equal(f.store.getChannelWorkflow(f.plan.workflowId).status, "blocked");
    assert.equal(f.current(f.scopeIsolation).blocker, "workflow_isolation.result_ref_unconfirmed");
    const tick = await orchestrate(f);
    assert.equal(tick.status, "blocked", JSON.stringify({ tick, intentStatus: f.intent().status,
      observedCommit: await f.ref(), expectedCommit: result.commit }));
    assert.equal(f.current(f.scopeIsolation).status, "blocked");
    assert.equal(f.store.getChannelWorkflow(f.plan.workflowId).status, "blocked");
    assert.deepEqual(f.run(), original.run);
    assert.deepEqual(f.store.getWorkUnitAttempt(f.writer.attemptId), original.attempt);
    assert.deepEqual(f.binding(), original.binding);
    assert.deepEqual(f.store.database.prepare("SELECT id FROM run_sessions ORDER BY id").all(), original.runs);
    assert.deepEqual(f.store.database.prepare("SELECT id FROM work_unit_attempts ORDER BY id").all(), original.attempts);
    assert.deepEqual(await f.gitSnapshot(), before, "reconciliation must not repair or republish the missing/drifted ref");
  });
}

test("a result-gate blocked step resumes after exact-ref observation without redispatch or replay", nativeGit, async t => {
  const f = await workflowIsolatedResultFixture(t);
  requireJournal(f);
  assert.equal(typeof f.isolation.resumeTerminalResultStep, "function");
  const intent = await interruptAfterRef(f), owner = f.current(f.scopeIsolation).metadata.startOwner;
  const execution = () => ({ run: f.run(), attempt: f.store.getWorkUnitAttempt(f.writer.attemptId), binding: f.binding(),
    runs: f.store.database.prepare("SELECT id FROM run_sessions ORDER BY id").all(),
    attempts: f.store.database.prepare("SELECT id FROM work_unit_attempts ORDER BY id").all() });
  const original = execution();
  await f.git("update-ref", "--no-deref", "-d", f.resultRef, intent.commit);
  f.reopenIsolation();
  await reconcileWorkflowIsolatedResults(f.store, f.plan.workflowId, now);
  const blocked = f.current(f.scopeIsolation);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blocker, "workflow_isolation.result_ref_unconfirmed");
  assert.equal(f.store.getChannelWorkflow(f.plan.workflowId).status, "blocked");
  assert.equal(f.intent().status, "blocked");
  assert.equal(await f.ref(), null, "the failed observation must not recreate the ref");
  assert.deepEqual(execution(), original);

  // Simulate external repair of the original ref; the coordinator may only observe this exact commit.
  await f.git("update-ref", "--no-deref", f.resultRef, intent.commit, "0".repeat(intent.commit.length));
  const git = await f.gitSnapshot();
  t.mock.timers.tick(1);
  f.reopenIsolation();
  await reconcileWorkflowIsolatedResults(f.store, f.plan.workflowId, now);
  const resumed = f.current(f.scopeIsolation);
  assert.equal(f.intent().status, "confirmed");
  assert.deepEqual(execution(), original);
  assert.deepEqual(await f.gitSnapshot(), git, "observe-confirm and resume must not repeat any Git effect");
  const diagnostics = f.store.listArtifacts(f.runId)
    .filter(artifact => artifact.sealedPayload?.kind === "workflow_isolation_result_capture_blocked")
    .map(artifact => artifact.sealedPayload.code);
  const priorTransition = f.store.database.prepare("SELECT event,reason,created_at FROM state_transition_events WHERE entity_type='workflow_step' AND entity_id=? ORDER BY rowid DESC LIMIT 1")
    .get(resumed.id);
  assert.equal(resumed.status, "running", JSON.stringify({ status: resumed.status, blocker: resumed.blocker,
    stepUpdatedAt: resumed.updatedAt, priorTransition, diagnostics, intentStatus: f.intent().status }));
  assert.equal(resumed.blocker, undefined);
  assert.equal(resumed.taskId, blocked.taskId);
  assert.equal(resumed.runId, blocked.runId);
  assert.deepEqual(resumed.metadata.startOwner, owner);
  assert.equal(f.store.getChannelWorkflow(f.plan.workflowId).status, "running");
  assert.equal(f.intent().commit, intent.commit);
  assert.equal(f.intent().proofDigest, intent.proofDigest);
  assert.equal(await f.ref(), intent.commit);
  assert.equal(f.blocker(), undefined);
  assert.deepEqual(f.store.database.prepare("SELECT outcome FROM workflow_isolation_result_receipts WHERE intent_id=? ORDER BY revision")
    .all(intent.intentId).map(row => row.outcome), ["blocked", "confirmed"]);
  assert.deepEqual(f.store.database.prepare("SELECT event FROM state_transition_events WHERE entity_type='workflow_step' AND entity_id=? AND reason=? ORDER BY rowid")
    .all(resumed.id, "workflow_isolation.result_ref_confirmed").map(row => row.event), ["resume", "start"]);

  const tick = await orchestrate(f);
  assert.notEqual(tick.status, "started", "recovery must not prepare or dispatch another Run");
  assert.deepEqual(execution(), original);
  assert.deepEqual(await f.gitSnapshot(), git);
});

test("a receipt committed before a lost response is recovered without duplicating its Git effect", nativeGit, async t => {
  const f = await workflowIsolatedResultFixture(t);
  requireJournal(f);
  await assert.rejects(f.capture({ isolation: interruptedResultIsolation(f, "recordTerminalResultReceipt",
    new Error("fixture: receipt response lost"), { after: true, once: true }) }), { code: "workflow_result_receipt_unconfirmed" });
  assert.equal(f.intent().status, "confirmed");
  const snapshot = await f.resultSnapshot();
  f.reopenIsolation();
  const result = await f.capture();
  assert.equal(result.commit, snapshot.intent.commit);
  assert.deepEqual(await f.gitSnapshot(), snapshot.git);
  assert.deepEqual((await f.resultSnapshot()).journal, snapshot.journal);
  assert.equal(f.blocker(), undefined);
});

for (const fault of ["retained hash", "rewritten hash"]) {
  test(`stored packet tampering with ${fault} cannot be accepted by capture or semantic success`, nativeGit, async t => {
    const f = await workflowIsolatedResultFixture(t);
    requireJournal(f);
    await f.capture();
    const intent = f.intent(), artifact = f.store.getArtifact(intent.packetArtifactId);
    const body = { ...artifact.sealedPayload, patch: "forged packet patch\n" }, content = JSON.stringify(body);
    f.store.database.prepare("UPDATE artifacts SET sealed_payload_json=?,content_sha256=? WHERE id=?")
      .run(content, fault === "retained hash" ? artifact.contentSha256 : sha256(content), artifact.id);
    f.reopenIsolation();
    const before = await f.gitSnapshot();
    await assert.rejects(f.capture(), { code: fault === "retained hash"
      ? "workflow_isolation.result_artifact_unverified" : "workflow_isolation.result_packet_changed" });
    assert.equal(f.blocker(), fault === "retained hash"
      ? "workflow_isolation.result_artifact_unverified" : "workflow_isolation.result_packet_changed");
    assert.deepEqual(await f.gitSnapshot(), before);
  });
}

test("actual authorized tracked and new text mutations produce a sealed packet while leaving Runner HEAD/index and target unchanged", nativeGit, async t => {
  const f = await workflowIsolatedResultFixture(t, { mutations: [{ content: "changed\n" }, { path: "new.txt", content: "new\n" }] });
  requireJournal(f);
  const proof = authority(f), before = await f.gitSnapshot();
  assert.equal(proof.terminal.completion.effectCoverage, "pi_tracked_tools_v1");
  const result = await f.capture();
  assert.deepEqual(result.packet.context.allowedPaths, ["new.txt", "owned.txt"]);
  assert.deepEqual(result.packet.changedPaths.map(({ path, change }) => ({ path, change })),
    [{ path: "new.txt", change: "add" }, { path: "owned.txt", change: "modify" }]);
  for (const [path, content] of [["new.txt", "new\n"], ["owned.txt", "changed\n"]]) {
    const change = result.packet.changedPaths.find(change => change.path === path);
    assert.equal(change.after.sha256, sha256(content));
    assert.equal((await f.gitAt(f.cwd, ["show", `${result.commit}:${path}`])).toString(), content);
  }
  assert.equal(result.packet.changedPaths.find(change => change.path === "owned.txt").before.sha256, sha256("base\n"));
  const tools = f.store.getArtifact(result.packet.terminal.toolCompletionArtifactRef).sealedPayload;
  assert.deepEqual(tools.mutations.flatMap(mutation => mutation.artifactIds).sort(), f.mutations.map(mutation => mutation.artifact.id).sort());
  assert.deepEqual(result.packet.terminal.validations, []);
  await inspectSealedWorkflowBranchResult(f.cwd, result);
  assert.deepEqual(authority(f), proof);
  assert.equal(f.blocker(), undefined);
  const after = await f.gitSnapshot();
  assert.equal(after.head, before.head);
  assert.equal(after.branchHead, before.branchHead);
  assert.deepEqual(after.index, before.index);
  assert.equal(await readFile(join(f.cwd, "owned.txt"), "utf8"), "base\n");
  await assert.rejects(readFile(join(f.cwd, "new.txt")), { code: "ENOENT" });
  const snapshot = await f.resultSnapshot();
  f.reopenIsolation();
  assert.deepEqual(await f.capture(), result);
  assert.deepEqual(await f.resultSnapshot(), snapshot);
});

for (const final of ["second\n", "base\n"]) {
  test(`same-file journal chain ending at ${JSON.stringify(final)} retains exact evidence`, nativeGit, async t => {
    const f = await workflowIsolatedResultFixture(t, { mutations: [{ content: "first\n" }, { content: final }] });
    requireJournal(f);
    const result = await f.capture();
    assert.deepEqual(result.packet.context.allowedPaths, ["owned.txt"]);
    assert.equal(result.packet.changedPaths.length, final === "base\n" ? 0 : 1);
    if (result.packet.changedPaths.length) {
      assert.equal(result.packet.changedPaths[0].before.sha256, sha256("base\n"));
      assert.equal(result.packet.changedPaths[0].after.sha256, sha256(final));
    } else assert.equal(result.tree, await f.git("rev-parse", `${f.plan.baseCommit}^{tree}`));
    const evidence = f.store.getArtifact(result.packet.terminal.toolCompletionArtifactRef).sealedPayload;
    assert.deepEqual(evidence.mutations[0].artifactIds, f.mutations.map(mutation => mutation.artifact.id));
  });
}

for (const [path, code] of [["owned.txt", "workflow_branch_unauthorized_path"],
  ["unexpected.txt", "workflow_branch_unauthorized_path"], ["cache.tmp", "workflow_branch_ignored_residue"]]) {
  test(`unrecorded ${path} residue is never granted by a terminal status or context artifact`, nativeGit, async t => {
    const f = await workflowIsolatedResultFixture(t);
    await writeFile(join(f.executionRoot, path), "unrecorded\n");
    await assertUnpublished(f, () => f.capture(), code);
  });
}

for (const [fault, mutate] of [
  ["hash", f => writeFile(join(f.executionRoot, "owned.txt"), "tampered after domain completion\n")],
  ["mode", f => chmod(join(f.executionRoot, "owned.txt"), 0o755)],
  ["deletion", f => rm(join(f.executionRoot, "owned.txt"))],
]) {
  test(`post-completion ${fault} drift cannot be published using a successful file-domain row`, nativeGit, async t => {
    const f = await workflowIsolatedResultFixture(t, { mutations: [{ content: "authorized\n" }] });
    await mutate(f);
    await assertUnpublished(f, () => f.capture(), "workflow_isolation.result_mutation_changed");
  });
}

test("a missing real context packet cannot be replaced by terminal rows or sealed preparation", nativeGit, async t => {
  const f = await workflowIsolatedResultFixture(t, { context: false });
  await assertUnpublished(f, () => f.capture(), "workflow_isolation.result_context_missing");
});

test("a deleted file-backed context artifact cannot certify the capture context", nativeGit, async t => {
  const f = await workflowIsolatedResultFixture(t);
  await rm(join(f.store.paths.artifactsDir, f.contextArtifact.path));
  await assertUnpublished(f, () => f.capture(), "workflow_isolation.result_context_missing");
});

for (const [name, options, code] of [
  ["unresolved original Host lifetime", { drained: false }, "workflow_isolation.terminal_host_not_drained"],
  ["missing original terminal audit", { audit: false }, "workflow_isolation.terminal_audit_unverified"],
  ["running lifecycle", { terminal: false }, "workflow_isolation.terminal_not_terminal"],
]) {
  test(`${name} cannot publish a result`, nativeGit, async t => {
    const f = await workflowIsolatedResultFixture(t, options);
    try { await assertUnpublished(f, () => f.capture(), code); }
    finally { await f.finish(); }
  });
}

for (const field of ["workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"]) {
  test(`foreign ${field} cannot borrow an otherwise complete terminal binding`, nativeGit, async t => {
    const f = await workflowIsolatedResultFixture(t);
    const writer = { ...f.writer, [field]: field === "fencingToken" ? "999" : "foreign" };
    await assertUnpublished(f, () => f.capture({ writer }), "workflow_isolation.result_binding_changed");
  });
}

for (const [name, mutate] of Object.entries({
  workflow: f => f.store.database.prepare("UPDATE channel_workflows SET status='cancelled' WHERE id=?").run(f.plan.workflowId),
  step: f => f.store.database.prepare("UPDATE channel_workflow_steps SET status='cancelled' WHERE id=?").run(f.plan.workflowStepId),
  task: f => f.store.database.prepare("UPDATE tasks SET status='cancelled' WHERE id=?").run(f.generation.task.id),
  abort: f => f.store.database.prepare("UPDATE work_unit_attempts SET abort_requested_at=? WHERE id=?").run(now(), f.writer.attemptId),
})) {
  test(`late ${name} cancellation vetoes capture despite original Host completion`, nativeGit, async t => {
    const f = await workflowIsolatedResultFixture(t);
    mutate(f);
    await assertUnpublished(f, () => f.capture(), "workflow_isolation.terminal_cancellation_unverified");
    assert.equal(f.blocker(), "workflow_isolation.terminal_cancellation_unverified");
  });
}

test("a newer current Attempt invalidates the old terminal capture before any result ref", nativeGit, async t => {
  const f = await workflowIsolatedResultFixture(t);
  f.store.createWorkUnitAttempt({ workUnitId: f.writer.workUnitId, attemptNumber: 2, runtimeInstanceId: "result-next-runtime",
    runnerId: "pi", now: now() });
  await assertUnpublished(f, () => f.capture(), "workflow_isolation.terminal_execution_changed");
});
