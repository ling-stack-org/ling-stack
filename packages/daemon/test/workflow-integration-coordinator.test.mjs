import assert from "node:assert/strict";
import test from "node:test";
import { inspectSealedWorkflowBranchResult, workflowGitPacketDigest }
  from "../dist/features/channels/workflow-branch-result.js";
import { WORKFLOW_CANDIDATE_VALIDATORS } from "../dist/features/channels/workflow-candidate-validation.js";
import { coordinateWorkflowIntegration, reconcileWorkflowIntegrations }
  from "../dist/features/channels/workflow-integration-coordinator.js";
import { reconcileWorkflowIsolatedResults } from "../dist/features/channels/workflow-isolated-result.js";
import { configureWorkflowIsolationLifecycle, workflowIsolationIsDraining, waitForWorkflowIsolationIdle }
  from "../dist/features/channels/workflow-isolation-lifecycle.js";
import { createSqliteWorkflowIntegrationCoordinatorStore } from "@ling-stack/core";
import { workflowIsolationFixture } from "../../core/test/support/workflow-isolation-fixture.mjs";
import { workflowIsolatedResultFixture } from "./support/workflow-isolated-result-fixture.mjs";
import { nativeGit, now, workflowIntegrationCoordinatorFixture }
  from "./support/workflow-integration-coordinator-fixture.mjs";

test("ordinary workflows without isolation pins do not require a SQLite integration store", async () => {
  for (const steps of [[], [{ id: "ordinary-step", status: "running" }]]) {
    const store = { listChannelWorkflowSteps: () => steps };
    configureWorkflowIsolationLifecycle(store, { isShuttingDown: () => true,
      trackCompletion() { assert.fail("ordinary workflows have no isolated operation to track"); } });
    assert.deepEqual(await reconcileWorkflowIntegrations(store, "ordinary-workflow"), []);
    await reconcileWorkflowIsolatedResults(store, "ordinary-workflow");
    assert.equal(workflowIsolationIsDraining(store, "ordinary-workflow"), false);
  }
  await assert.rejects(reconcileWorkflowIntegrations({ listChannelWorkflowSteps: () => [{
    metadata: { isolationScopePlan: { planId: "pinned", planDigest: "digest" } },
  }] }, "pinned-workflow"), /workflow_integration.store_not_sqlite/);
});

test("isolated result recovery skips semantic-terminal steps but still observes unfinished steps", async () => {
  const terminal = ["succeeded", "failed", "cancelled", "skipped"], observed = [];
  const store = {
    listChannelWorkflowSteps: () => [...terminal, "running", "blocked", "waiting_for_approval"].map(status => ({
      id: status, status, runId: `run-${status}`, metadata: { isolationScopePlan: { planId: "plan", planDigest: "digest" } },
    })),
    getRun(runId) { observed.push(runId); return undefined; },
  };
  await reconcileWorkflowIsolatedResults(store, "workflow");
  assert.deepEqual(observed, ["run-running", "run-blocked", "run-waiting_for_approval"]);
});

async function verifiedCandidate(f) {
  const round = f.round(), journal = await f.journal();
  assert.equal(round.phase, "awaiting_approval");
  assert.ok(round.candidate);
  assert.equal(round.openIntentId, undefined);
  assert.ok(journal.effects.length > 0);
  assert.ok(journal.effects.every(effect => effect.status === "confirmed"));
  assert.equal(journal.receipts.length, journal.effects.length);
  assert.ok(journal.receipts.every(receipt => receipt.outcome === "confirmed"));
  assert.equal(journal.effects.filter(effect => effect.kind === "target_apply").length, 0);
  const artifacts = f.store.listArtifacts(f.runId);
  const packet = artifacts.find(artifact => artifact.sealedPayload?.kind === "workflow_integration_candidate")?.sealedPayload;
  assert.ok(packet, "the candidate packet must be retained by the production coordinator");
  assert.equal(packet.status, "pending_verification", "the raw merge packet is not itself a verification claim");
  assert.equal(packet.applied, false);
  assert.equal(packet.commit, round.candidate.commit);
  assert.equal(packet.tree, round.candidate.tree);
  assert.equal(workflowGitPacketDigest(packet), round.candidate.packetDigest);
  assert.deepEqual(packet.includedStepIds, f.round().inputs.mergeOrder);
  assert.deepEqual(packet.merges.map(merge => merge.workflowStepId), f.round().inputs.mergeOrder);
  assert.equal(await f.ref(packet.resultRef), packet.commit);
  assert.equal(await f.git("rev-parse", `${packet.commit}^{tree}`), packet.tree);
  const effect = journal.effects.find(entry => entry.effectKey === "candidate:verify");
  assert.ok(effect, "verification has its own durable Host intent");
  const receipt = journal.receipts.find(entry => entry.intentId === effect.intentId);
  const evidence = f.store.getArtifact(receipt.artifactId).sealedPayload;
  assert.equal(evidence.kind, "workflow_integration_coordinator_receipt");
  assert.equal(evidence.outcome, "confirmed");
  const verification = evidence.evidence;
  assert.equal(verification.kind, "workflow_candidate_verification");
  assert.equal(verification.status, "passed");
  assert.equal(verification.applied, false);
  assert.equal(verification.projectTestsRun, false);
  assert.equal(workflowGitPacketDigest(verification), round.candidate.validationDigest);
  assert.deepEqual(verification.validationRequirements, round.inputs.validationRequirements);
  assert.deepEqual(verification.results.map(({ id, fingerprint }) => ({ id, fingerprint })), round.inputs.validationRequirements);
  assert.ok(verification.results.every(result => result.status === "passed" && result.exitCode === 0));
  assert.equal(verification.executionScope.readOnly, true);
  assert.equal(verification.executionScope.kind, "candidate_tree_static_checks");
  assert.equal(verification.executionScope.candidateCommit, packet.commit);
  assert.equal(verification.executionScope.candidateTree, packet.tree);
  assert.deepEqual(round.candidate.branchResultDigests, [f.result.packetDigest]);
  return { packet, verification, journal };
}

test("coordinator fixture freezes fixed Host validator pins before real Git/SQLite preparation", nativeGit, async t => {
  const f = await workflowIntegrationCoordinatorFixture(t, { stage: "running" });
  assert.deepEqual(f.round().inputs.validationRequirements,
    WORKFLOW_CANDIDATE_VALIDATORS.map(({ id, fingerprint }) => ({ id, fingerprint })));
  assert.equal(f.round().inputs.mode, "candidate_only");
  assert.equal(f.binding().status, "ready");
  assert.equal(f.binding().startOwner.phase, "preparing");
  assert.equal(f.step().metadata.startOwner.phase, "linked");
  assert.equal(f.run().status, "running");
  assert.equal(f.step().status, "running");
  assert.equal(f.intent(), undefined);
  assert.equal(await f.ref(), null);
  assert.equal(await f.ref(f.integrationScope.branchRef), null);
  const before = await f.gitSnapshot();
  await f.complete();
  const proof = f.isolation.assertTerminalCapture({ writer: f.writer, expectedRevision: f.binding().revision, now: now() });
  assert.equal(proof.status, "authorized", JSON.stringify(proof));
  assert.equal(proof.terminal.completion.effectCoverage, "pi_no_tools_v1");
  assert.deepEqual(await f.gitSnapshot(), before, "Host terminal completion itself performs no Git effects");
});

test("coordinator fixture seals and reopens real terminal evidence without claiming semantic success or changing target", nativeGit, async t => {
  const f = await workflowIntegrationCoordinatorFixture(t, { stage: "terminal" });
  const target = await f.targetSnapshot(), original = f.executionSnapshot();
  assert.equal(f.step().status, "running", "a successful Run is not yet semantic step success");
  const result = await f.capture();
  assert.equal(result.status, "sealed");
  assert.equal(f.intent().status, "confirmed");
  assert.equal(f.intent().packetDigest, workflowGitPacketDigest(result.packet));
  assert.equal(await f.ref(), result.commit);
  assert.equal(result.tree, await f.git("rev-parse", `${f.plan.baseCommit}^{tree}`));
  assert.deepEqual(result.packet.changedPaths, []);
  assert.deepEqual(result.packet.terminal.validations, [], "branch capture does not claim candidate or project validation");
  assert.deepEqual(f.store.getArtifact(f.intent().packetArtifactId).sealedPayload, result.packet);
  await inspectSealedWorkflowBranchResult(f.cwd, result);
  assert.equal(f.step().status, "running", "sealed result evidence alone cannot claim semantic step success");
  assert.deepEqual(f.executionSnapshot(), original, "capture retains the original Run, Attempt and binding");
  assert.deepEqual(await f.targetSnapshot(), target);
  const snapshot = await f.integrationSnapshot();
  f.reopenIsolation();
  assert.deepEqual(await f.capture(), result);
  assert.deepEqual(await f.integrationSnapshot(), snapshot, "reopening never recaptures a sealed branch result");
});

test("capture and integration wrappers singleflight each physical operation and track its workflow lifetime", nativeGit, async t => {
  const f = await workflowIntegrationCoordinatorFixture(t, { stage: "terminal" }), completions = [];
  configureWorkflowIsolationLifecycle(f.store, { isShuttingDown: () => false,
    trackCompletion: completion => completions.push(completion) });
  const target = await f.targetSnapshot();
  const captures = Array.from({ length: 8 }, () => f.capture());
  assert.equal(workflowIsolationIsDraining(f.store, f.workflowId), true);
  assert.equal(completions.length, 1, "capture:<bindingId> has one tracked callback");
  const captured = await Promise.all(captures);
  await waitForWorkflowIsolationIdle(f.store, f.workflowId);
  assert.ok(captured.every(result => result === captured[0]));
  assert.equal(f.intent().status, "confirmed");
  assert.equal(workflowIsolationIsDraining(f.store, f.workflowId), false);
  assert.equal((await f.finalize())?.status, "succeeded");
  const integrations = Array.from({ length: 8 }, () => coordinateWorkflowIntegration({ store: f.store, roundId: f.roundId, now }));
  assert.equal(workflowIsolationIsDraining(f.store, f.workflowId), true);
  assert.equal(completions.length, 2, "integration:<roundId> has one tracked callback");
  const coordinated = await Promise.all(integrations);
  await waitForWorkflowIsolationIdle(f.store, f.workflowId);
  assert.ok(coordinated.every(result => result === coordinated[0]));
  assert.equal(coordinated[0].status, "awaiting_approval", JSON.stringify(coordinated[0]));
  assert.equal(workflowIsolationIsDraining(f.store, f.workflowId), false);
  const { journal } = await verifiedCandidate(f);
  assert.equal(journal.effects.filter(effect => effect.effectKey === "candidate:verify").length, 1);
  assert.deepEqual(await f.targetSnapshot(), target);
});

test("lifecycle shutdown admission rejects capture and integration before any Git or evidence effects", nativeGit, async t => {
  const f = await workflowIntegrationCoordinatorFixture(t, { stage: "terminal" }), completions = [];
  let shutdown = true;
  configureWorkflowIsolationLifecycle(f.store, { isShuttingDown: () => shutdown,
    trackCompletion: completion => completions.push(completion) });
  const beforeCapture = await f.integrationSnapshot();
  await assert.rejects(f.capture(), /workflow_isolation.runtime_shutting_down/);
  assert.deepEqual(await f.integrationSnapshot(), beforeCapture);
  assert.equal(completions.length, 0);
  shutdown = false;
  await f.capture();
  assert.equal((await f.finalize())?.status, "succeeded");
  shutdown = true;
  const beforeIntegration = await f.integrationSnapshot();
  await assert.rejects(f.coordinate(), /workflow_isolation.runtime_shutting_down/);
  assert.deepEqual(await f.integrationSnapshot(), beforeIntegration);
  assert.equal(completions.length, 1, "shutdown does not register rejected operations");
  assert.equal(workflowIsolationIsDraining(f.store, f.workflowId), false);
});

test("pinned reconciliation enumerates persisted workflow rounds even when a plan pin no longer resolves", nativeGit, async t => {
  const f = await workflowIntegrationCoordinatorFixture(t), step = f.step();
  f.store.updateChannelWorkflowStep(step.id, { metadata: { ...step.metadata,
    isolationScopePlan: { planId: "missing-plan", planDigest: step.metadata.isolationScopePlan.planDigest } } }, now());
  const before = await f.integrationSnapshot();
  const results = await reconcileWorkflowIntegrations(f.store, f.workflowId, now);
  assert.equal(results.length, 1, "a stale pin cannot hide the persisted integration round");
  assert.equal(results[0].round.roundId, f.roundId);
  assert.equal(results[0].status, "blocked", JSON.stringify(results));
  assert.deepEqual(await f.integrationSnapshot(), before);
  assert.deepEqual(await f.journal(), { effects: [], receipts: [] });
});

test("branch finalization cannot complete early and orchestration requires a verified integration candidate", nativeGit, async t => {
  const f = await workflowIntegrationCoordinatorFixture(t);
  assert.equal(f.step().status, "succeeded");
  assert.equal(f.run().status, "succeeded");
  assert.equal(f.intent().status, "confirmed");
  assert.equal(f.round().candidate, undefined);
  assert.notEqual(f.workflow().status, "succeeded");
  const original = f.executionSnapshot();
  const tick = await f.orchestrate();
  assert.equal(tick.status, "completed", JSON.stringify(tick));
  assert.equal(f.workflow().status, "succeeded");
  await verifiedCandidate(f);
  assert.deepEqual(f.executionSnapshot(), original);
});

test("coordination waits for semantic terminal success, not just Run completion or a sealed branch", nativeGit, async t => {
  const f = await workflowIntegrationCoordinatorFixture(t, { stage: "running" });
  const assertWaiting = async () => {
    const snapshot = await f.integrationSnapshot();
    const result = await f.coordinate();
    assert.equal(result.status, "waiting", JSON.stringify(result));
    assert.equal(result.round.phase, "preparing");
    assert.equal(result.round.candidate, undefined);
    assert.deepEqual(await f.journal(), { effects: [], receipts: [] });
    assert.deepEqual(await f.integrationSnapshot(), snapshot, "waiting performs no integration Git or SQLite effects");
  };
  await assertWaiting();
  await f.complete();
  assert.equal(f.run().status, "succeeded");
  assert.equal(f.step().status, "running");
  await assertWaiting();
  await f.capture();
  assert.equal(f.intent().status, "confirmed");
  assert.equal(f.step().status, "running");
  await assertWaiting();
  assert.equal((await f.finalize())?.status, "succeeded");
  const result = await f.coordinate();
  assert.equal(result.status, "awaiting_approval", JSON.stringify(result));
  await verifiedCandidate(f);
});

test("real Git merge-tree and fixed Host validation retain a candidate-only round without target apply", nativeGit, async t => {
  const f = await workflowIntegrationCoordinatorFixture(t);
  const target = await f.targetSnapshot(), original = f.executionSnapshot();
  const result = await f.coordinate();
  assert.equal(result.status, "awaiting_approval", JSON.stringify(result));
  assert.deepEqual(result.round, f.round());
  const { packet, verification, journal } = await verifiedCandidate(f);
  assert.notEqual(packet.commit, f.result.commit);
  assert.equal(packet.tree, f.result.tree, "a no-change branch still produces a real, separately verified candidate commit");
  assert.deepEqual(packet.merges.map(merge => merge.exitCode), [0]);
  const merge = packet.merges[0];
  assert.deepEqual((await f.git("rev-list", "--parents", "-n", "1", merge.commit)).split(" "),
    [merge.commit, f.plan.baseCommit, f.result.commit]);
  assert.equal(merge.theirsCommit, f.result.commit);
  assert.equal(merge.branchResultDigest, f.result.packetDigest);
  assert.deepEqual(verification.changedPaths, []);
  assert.equal(journal.effects.filter(effect => effect.effectKey === "worktree:create").length, 1);
  assert.equal(journal.effects.filter(effect => effect.kind === "integrate_branch").length, 1);
  assert.equal(journal.effects.filter(effect => effect.kind === "candidate_verify").length, 1);
  assert.equal(f.round().outstandingApprovalId, undefined, "candidate-only coordination never fabricates apply approval");
  assert.deepEqual(await f.targetSnapshot(), target);
  assert.deepEqual(f.executionSnapshot(), original);
});

test("awaiting-approval repeat and SQLite reopen observe the same candidate without repeating effects", nativeGit, async t => {
  const f = await workflowIntegrationCoordinatorFixture(t);
  const result = await f.coordinate();
  assert.equal(result.status, "awaiting_approval", JSON.stringify(result));
  await verifiedCandidate(f);
  const before = await f.integrationSnapshot(), journal = await f.journal();
  await reconcileWorkflowIsolatedResults(f.store, f.workflowId, now);
  assert.deepEqual(await f.integrationSnapshot(), before, "terminal steps are not recaptured while candidate-only approval is pending");
  assert.deepEqual(await f.coordinate(), result);
  assert.deepEqual(await f.integrationSnapshot(), before);
  assert.deepEqual(await f.journal(), journal);
  f.reopenIsolation();
  assert.deepEqual(await f.coordinate(), result);
  assert.deepEqual(await f.integrationSnapshot(), before, "reopen cannot rerun merge-tree, rewrite refs, or append journal/evidence");
  assert.deepEqual(await f.journal(), journal);
});

test("a cached failed verification advances verifying to failed after a crash without rerunning validation", nativeGit, async t => {
  const seed = await workflowIsolationFixture(t, { create: false, pin: false });
  const createRound = seed.isolation.createIntegrationRound;
  // Freeze real validator pins before fixture preparation; do not rewrite a durable round or fabricate a receipt.
  const pin = t.mock.method(Object.getPrototypeOf(seed.isolation), "createIntegrationRound", function(input) {
    return createRound.call(this, { ...input, inputs: { ...input.inputs,
      validationRequirements: WORKFLOW_CANDIDATE_VALIDATORS.map(({ id, fingerprint }) => ({ id, fingerprint })) } });
  });
  let f;
  try { f = await workflowIsolatedResultFixture(t, { mutations: [{ content: "trailing whitespace \n" }] }); }
  finally { pin.mock.restore(); }
  await f.capture();
  const { finalizeOrchestratedWorkflowStepRun } = await import("../dist/features/channels/orchestrator.js");
  assert.equal(finalizeOrchestratedWorkflowStepRun(f.store, f.plan.workflowStepId, f.generation.task.id, f.run(), now())?.status,
    "succeeded");
  let port = createSqliteWorkflowIntegrationCoordinatorStore(f.store), interrupted = 0;
  const advance = port.advanceRound;
  const fault = t.mock.method(port, "advanceRound", function(input) {
    if (input.to === "failed") {
      interrupted++;
      throw new Error("fixture: crash after failed verification receipt, before failed phase");
    }
    return advance.call(this, input);
  });
  const coordinate = () => coordinateWorkflowIntegration({ store: f.store, roundId: f.roundId, now });
  const first = await coordinate();
  assert.equal(first.status, "blocked", JSON.stringify(first));
  assert.equal(interrupted, 1);
  assert.equal(f.round().phase, "verifying");
  assert.equal(f.round().openIntentId, undefined);
  const scope = { roundId: f.roundId, generation: f.round().generation };
  const journal = () => ({ effects: port.listEffects(scope), receipts: port.listReceipts(scope) });
  const beforeJournal = journal(), effect = beforeJournal.effects.find(effect => effect.effectKey === "candidate:verify");
  assert.equal(effect.status, "confirmed");
  const receipt = beforeJournal.receipts.find(receipt => receipt.intentId === effect.intentId);
  const verification = f.store.getArtifact(receipt.artifactId).sealedPayload.evidence;
  assert.equal(verification.status, "failed");
  assert.equal(verification.projectTestsRun, false);
  assert.equal(verification.results.find(result => result.id === "git-diff-check").status, "failed");
  const beforeGit = await f.gitSnapshot(), beforeArtifacts = f.store.listArtifacts(f.runId), revision = f.round().revision;
  fault.mock.restore();
  f.reopenIsolation();
  port = createSqliteWorkflowIntegrationCoordinatorStore(f.store);
  const noNewIntent = t.mock.method(port, "recordIntent", () => assert.fail("recovery cannot rerun candidate creation or validation"));
  const resumed = await coordinate();
  assert.equal(resumed.status, "failed", JSON.stringify(resumed));
  assert.equal(resumed.code, "workflow_integration.validation_failed");
  assert.equal(resumed.round.phase, "failed");
  assert.equal(resumed.round.reason, "workflow_integration.validation_failed");
  assert.equal(resumed.round.revision, revision + 1, "recovery advances the phase exactly once with the retained failed receipt");
  assert.equal(resumed.round.candidate, undefined);
  assert.deepEqual(await coordinate(), resumed);
  noNewIntent.mock.restore();
  f.reopenIsolation();
  port = createSqliteWorkflowIntegrationCoordinatorStore(f.store);
  assert.deepEqual(await coordinate(), resumed);
  assert.deepEqual(journal(), beforeJournal);
  assert.deepEqual(f.store.listArtifacts(f.runId), beforeArtifacts);
  assert.deepEqual(await f.gitSnapshot(), beforeGit);
});

test("an unconfirmed validation receipt blocks completion and reopen never repeats candidate effects", nativeGit, async t => {
  const f = await workflowIntegrationCoordinatorFixture(t), createArtifact = f.store.createArtifact;
  let interrupted = 0;
  // Inject only a failed evidence write; all authority, intents and other receipts remain real Core operations.
  const fault = t.mock.method(f.store, "createArtifact", function(input, ...rest) {
    if (input.sealedPayload?.kind === "workflow_integration_coordinator_receipt"
      && input.sealedPayload.evidence?.kind === "workflow_candidate_verification") {
      interrupted++;
      throw new Error("fixture: verification receipt persistence unavailable");
    }
    return createArtifact.call(this, input, ...rest);
  });
  const first = await f.coordinate();
  assert.equal(interrupted, 1, "the failure is after real candidate creation and fixed Host validation");
  assert.equal(first.status, "blocked", JSON.stringify(first));
  assert.equal(f.round().phase, "verifying");
  assert.equal(f.round().candidate, undefined);
  assert.notEqual(f.workflow().status, "succeeded");
  const journal = await f.journal(), verification = journal.effects.find(effect => effect.effectKey === "candidate:verify");
  assert.equal(verification?.status, "pending");
  assert.ok(!journal.receipts.some(receipt => receipt.intentId === verification.intentId));
  const packet = f.store.listArtifacts(f.runId).find(artifact => artifact.sealedPayload?.kind === "workflow_integration_candidate")?.sealedPayload;
  assert.ok(packet);
  assert.equal(await f.ref(packet.resultRef), packet.commit, "a published candidate ref is not verified authority");
  const original = f.executionSnapshot(), before = await f.gitSnapshot();
  const artifacts = f.store.listArtifacts(f.runId);
  await reconcileWorkflowIsolatedResults(f.store, f.workflowId, now);
  assert.deepEqual(f.store.listArtifacts(f.runId), artifacts, "an integration-owned pending effect is not a branch result capture failure");
  fault.mock.restore();
  f.reopenIsolation();
  const resumed = await f.coordinate();
  assert.equal(resumed.status, "blocked", JSON.stringify(resumed));
  assert.equal(resumed.code, "workflow_integration.verification_requires_reconciliation");
  assert.equal(f.round().candidate, undefined);
  assert.deepEqual(await f.gitSnapshot(), before);
  assert.deepEqual(await f.journal(), journal);
  const tick = await f.orchestrate();
  assert.equal(tick.status, "blocked", JSON.stringify(tick));
  assert.notEqual(f.workflow().status, "succeeded");
  assert.deepEqual(await f.gitSnapshot(), before);
  assert.deepEqual(await f.journal(), journal);
  assert.deepEqual(f.executionSnapshot(), original);
});

for (const coordinated of [false, true]) {
  test(`workflow cancellation ${coordinated ? "after candidate verification" : "before integration"} revokes coordinator effects`, nativeGit, async t => {
    const f = await workflowIntegrationCoordinatorFixture(t);
    if (coordinated) {
      const result = await f.coordinate();
      assert.equal(result.status, "awaiting_approval", JSON.stringify(result));
    }
    const transition = f.store.transitionChannelWorkflowStatus({ workflowId: f.workflowId, expectedStatus: f.workflow().status,
      event: "cancel", actor: "user", now: now(), reason: "coordinator fixture cancellation" });
    assert.equal(transition.ok, true, JSON.stringify(transition));
    f.reopenIsolation();
    const before = await f.gitSnapshot(), journal = await f.journal(), original = f.executionSnapshot();
    const result = await f.coordinate();
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.ok(result.code);
    assert.equal(f.workflow().status, "cancelled");
    assert.deepEqual(await f.gitSnapshot(), before);
    assert.deepEqual(await f.journal(), journal);
    assert.deepEqual(f.executionSnapshot(), original);
    if (!coordinated) assert.equal(await f.ref(f.integrationScope.branchRef), null);
  });
}

for (const fault of ["missing", "drift"]) {
  test(`a confirmed branch result with ${fault} ref blocks integration without repairing or replaying`, nativeGit, async t => {
    const f = await workflowIntegrationCoordinatorFixture(t);
    if (fault === "missing") await f.git("update-ref", "--no-deref", "-d", f.resultRef, f.result.commit);
    else await f.git("update-ref", "--no-deref", f.resultRef, f.plan.baseCommit, f.result.commit);
    f.reopenIsolation();
    const before = await f.gitSnapshot(), journal = await f.journal(), original = f.executionSnapshot();
    const result = await f.coordinate();
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.equal(result.code, "workflow_branch_sealed_ref_changed");
    assert.equal(await f.ref(), fault === "missing" ? null : f.plan.baseCommit);
    assert.equal(await f.ref(f.integrationScope.branchRef), null);
    assert.equal(f.round().candidate, undefined);
    assert.deepEqual(await f.gitSnapshot(), before);
    assert.deepEqual(await f.journal(), journal);
    assert.deepEqual(f.executionSnapshot(), original);
    const tick = await f.orchestrate();
    assert.notEqual(tick.status, "completed", JSON.stringify(tick));
    assert.notEqual(f.workflow().status, "succeeded");
    assert.deepEqual(await f.gitSnapshot(), before);
    assert.deepEqual(f.executionSnapshot(), original);
  });

  test(`a verified candidate with ${fault} ref is blocked on reopen and cannot complete the workflow`, nativeGit, async t => {
    const f = await workflowIntegrationCoordinatorFixture(t);
    const coordinated = await f.coordinate();
    assert.equal(coordinated.status, "awaiting_approval", JSON.stringify(coordinated));
    const { packet } = await verifiedCandidate(f);
    if (fault === "missing") await f.git("update-ref", "--no-deref", "-d", packet.resultRef, packet.commit);
    else await f.git("update-ref", "--no-deref", packet.resultRef, f.plan.baseCommit, packet.commit);
    f.reopenIsolation();
    const before = await f.gitSnapshot(), journal = await f.journal(), original = f.executionSnapshot();
    const result = await f.coordinate();
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.equal(result.code, "workflow_integration.ref_unconfirmed");
    assert.equal(await f.ref(packet.resultRef), fault === "missing" ? null : f.plan.baseCommit);
    assert.deepEqual(await f.gitSnapshot(), before);
    assert.deepEqual(await f.journal(), journal);
    const tick = await f.orchestrate();
    assert.equal(tick.status, "blocked", JSON.stringify(tick));
    assert.notEqual(f.workflow().status, "succeeded");
    assert.deepEqual(await f.gitSnapshot(), before, "the completion path cannot repair or reapply a drifted candidate");
    assert.deepEqual(await f.journal(), journal);
    assert.deepEqual(f.executionSnapshot(), original);
  });
}
