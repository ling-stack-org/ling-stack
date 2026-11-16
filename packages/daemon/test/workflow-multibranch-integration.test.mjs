import assert from "node:assert/strict";
import test from "node:test";
import { inspectSealedWorkflowBranchResult, workflowGitPacketDigest } from "../dist/features/channels/workflow-branch-result.js";
import { buildWorkflowIsolationEvidence } from "../dist/features/channels/workflow-isolation-evidence.js";
import { nativeGit, now, workflowMultibranchIntegrationFixture } from "./support/workflow-multibranch-integration-fixture.mjs";

async function assertBranchEvidence(f, branch) {
  assert.equal(branch.step().status, "succeeded");
  assert.equal(branch.step().metadata.parallelPolicy.autoParallel, false);
  assert.equal(branch.step().metadata.safetyPlan.profile, "serial_v1");
  assert.equal(branch.binding().status, "ready");
  assert.equal(branch.binding().runId, branch.runId);
  assert.equal(branch.binding().planId, branch.plan.planId);
  assert.equal(branch.binding().startOwner.phase, "preparing");
  assert.equal(branch.step().metadata.startOwner.phase, "linked");
  assert.deepEqual(branch.binding().fence, branch.fence);
  const creation = f.isolation.getReceipt(branch.binding().creationReceiptId);
  assert.equal(creation.outcome, "confirmed");
  const created = f.store.getArtifact(creation.artifactId).sealedPayload;
  assert.equal(created.kind, "workflow_isolation_worktree");
  assert.deepEqual(created.receipt, branch.execution.receipt);
  assert.equal(created.scope.executionRoot, branch.executionRoot);
  const proof = f.isolation.assertTerminalCapture({ writer: branch.writer, expectedRevision: branch.binding().revision, now: now() });
  assert.equal(proof.status, "authorized", JSON.stringify(proof));
  assert.equal(proof.terminal.outcome, "succeeded");
  assert.equal(proof.terminal.completion.effectCoverage, "pi_tracked_tools_v1");
  assert.ok(f.store.getHostAttemptCompletion(branch.source));
  const result = branch.result, packet = result.packet;
  assert.equal(branch.intent().status, "confirmed");
  assert.equal(branch.intent().packetDigest, workflowGitPacketDigest(packet));
  assert.deepEqual(f.store.getArtifact(branch.intent().packetArtifactId).sealedPayload, packet);
  assert.equal(packet.context.scope.roundId, f.roundId);
  assert.equal(packet.context.scope.stepId, branch.scope.step.id);
  assert.equal(packet.context.lineage.bindingId, branch.writer.bindingId);
  assert.deepEqual(packet.context.lineage, packet.terminal.lineage);
  assert.deepEqual(packet.terminal.validations, [], "branch completion does not claim candidate or project validation");
  assert.equal(await f.ref(result.resultRef), result.commit);
  await inspectSealedWorkflowBranchResult(f.cwd, result);
  for (const [ref, kind] of [[packet.terminal.terminalArtifactRef, "workflow_isolation_terminal"],
    [packet.terminal.quiescenceArtifactRef, "workflow_isolation_quiescence"],
    [packet.terminal.toolCompletionArtifactRef, "workflow_isolation_tool_completion"]]) {
    const artifact = f.store.getArtifact(ref);
    assert.equal(artifact.runId, branch.runId);
    assert.equal(artifact.sealedPayload.kind, kind);
    assert.deepEqual(artifact.sealedPayload.writer, branch.writer);
    assert.equal(artifact.sealedPayload.proofDigest, proof.proofDigest);
  }
  const tools = f.store.getArtifact(packet.terminal.toolCompletionArtifactRef).sealedPayload;
  assert.deepEqual(tools.mutations.flatMap(mutation => mutation.artifactIds), branch.mutations.map(mutation => mutation.artifact.id));
  assert.deepEqual(packet.changedPaths.map(change => change.path), branch.mutations.map(mutation => mutation.path));
  const operations = f.store.database.prepare("SELECT operation_id,attempt_id,kind,phase FROM host_operations WHERE run_id=? ORDER BY operation_id").all(branch.runId);
  assert.deepEqual(operations.map(row => ({ ...row })), branch.mutations.map(mutation => ({ operation_id: mutation.operation.operationId,
    attempt_id: branch.fence.attemptId, kind: "file_mutation", phase: "safe" })));
  const executions = f.store.listHarnessToolExecutions(branch.runId);
  assert.deepEqual(executions.map(execution => execution.id), branch.mutations.map(mutation => mutation.execution.id));
  assert.ok(executions.every(execution => execution.state === "succeeded" && execution.attemptId === branch.fence.attemptId));
}

async function assertCandidate(f) {
  const round = f.round(), journal = f.journal();
  assert.equal(round.phase, "awaiting_approval");
  assert.equal(round.inputs.participants.length, 2);
  assert.deepEqual(round.inputs, f.inputs, "both participants and their order were frozen before either start");
  assert.equal(round.inputs.mode, "candidate_only");
  assert.equal(round.outstandingApprovalId, undefined);
  assert.equal(round.openIntentId, undefined);
  assert.equal(new Set(f.branches.map(branch => branch.writer.bindingId)).size, 2);
  assert.equal(new Set(f.branches.map(branch => branch.fence.workUnitId)).size, 2);
  assert.equal(new Set(f.branches.map(branch => branch.fence.attemptId)).size, 2);
  assert.equal(new Set(f.branches.map(branch => branch.fence.runtimeInstanceId)).size, 2);
  for (const branch of f.branches) await assertBranchEvidence(f, branch);
  const packet = f.artifacts().find(artifact => artifact.sealedPayload?.kind === "workflow_integration_candidate")?.sealedPayload;
  assert.ok(packet);
  assert.equal(packet.status, "pending_verification");
  assert.equal(packet.applied, false);
  assert.equal(workflowGitPacketDigest(packet), round.candidate.packetDigest);
  assert.equal(packet.commit, round.candidate.commit);
  assert.equal(packet.tree, round.candidate.tree);
  assert.equal(await f.ref(packet.resultRef), packet.commit);
  assert.equal(await f.git("rev-parse", `${packet.commit}^{tree}`), packet.tree);
  assert.deepEqual(packet.includedStepIds, f.inputs.mergeOrder);
  assert.deepEqual(packet.merges.map(merge => merge.workflowStepId), f.inputs.mergeOrder);
  assert.deepEqual(packet.context.branchResults.map(result => result.packet.context.scope.stepId), f.inputs.mergeOrder);
  assert.deepEqual(packet.merges.map(merge => merge.exitCode), [0, 0]);
  assert.deepEqual(round.candidate.branchResultDigests, f.branches.map(branch => branch.result.packetDigest));
  let previous = f.inputs.baseCommit;
  for (const [index, merge] of packet.merges.entries()) {
    const branch = f.branches[index];
    assert.equal(merge.theirsCommit, branch.result.commit);
    assert.equal(merge.branchResultDigest, branch.result.packetDigest);
    assert.deepEqual((await f.git("rev-list", "--parents", "-n", "1", merge.commit)).split(" "),
      [merge.commit, previous, branch.result.commit]);
    previous = merge.commit;
  }
  for (const [path, content] of [["left.txt", "left result\n"], ["right.txt", "right result\n"], ["shared.txt", "base shared.txt\n"]]) {
    assert.equal((await f.gitAt(f.cwd, ["show", `${packet.commit}:${path}`])).toString(), content);
  }
  assert.equal(journal.effects.filter(effect => effect.effectKey === "worktree:create").length, 1);
  assert.equal(journal.effects.filter(effect => effect.kind === "integrate_branch").length, 2);
  assert.equal(journal.effects.filter(effect => effect.kind === "target_apply").length, 0);
  assert.ok(journal.effects.every(effect => effect.status === "confirmed"));
  assert.equal(journal.effects.length, journal.receipts.length);
  assert.ok(journal.receipts.every(receipt => receipt.outcome === "confirmed"));
  const effect = journal.effects.find(entry => entry.effectKey === "candidate:verify");
  assert.ok(effect);
  const receipt = journal.receipts.find(entry => entry.intentId === effect.intentId);
  const verification = f.store.getArtifact(receipt.artifactId).sealedPayload.evidence;
  assert.equal(verification.kind, "workflow_candidate_verification");
  assert.equal(verification.status, "passed");
  assert.equal(verification.applied, false);
  assert.equal(verification.projectTestsRun, false);
  assert.equal(verification.executionScope.kind, "candidate_tree_static_checks");
  assert.equal(verification.executionScope.readOnly, true);
  assert.deepEqual(verification.validationRequirements, f.inputs.validationRequirements);
  assert.deepEqual(verification.changedPaths, ["left.txt", "right.txt"]);
  assert.equal(workflowGitPacketDigest(verification), round.candidate.validationDigest);
  return packet;
}

for (const order of [[0, 1], [1, 0]]) {
  test(`two real isolated results fan in by immutable mergeOrder after serial completion ${order.join(" then ")}`, nativeGit, async t => {
    const f = await workflowMultibranchIntegrationFixture(t), target = await f.targetSnapshot();
    for (const index of order) await f.finishBranch(index);
    assert.deepEqual(f.completionOrder, order.map(index => f.branches[index].scope.step.id));
    const sources = await f.sourcesSnapshot();
    const result = await f.coordinate();
    assert.equal(result.status, "awaiting_approval", JSON.stringify(result));
    const packet = await assertCandidate(f);
    assert.equal(packet.context.writer.bindingId, f.branches[0].writer.bindingId, "writer selection also follows immutable mergeOrder");
    assert.deepEqual(await f.targetSnapshot(), target);
    assert.deepEqual(await f.sourcesSnapshot(), sources, "fan-in retains both dirty source worktrees, indices, HEADs and result refs");
  });
}

test("one sealed successful participant cannot create a candidate before the other semantic terminal result", nativeGit, async t => {
  const f = await workflowMultibranchIntegrationFixture(t), target = await f.targetSnapshot();
  await f.finishBranch(0);
  assert.equal(f.branches[1].step().status, "queued");
  const assertWaiting = async () => {
    const before = await f.snapshot();
    const result = await f.coordinate();
    assert.equal(result.status, "waiting", JSON.stringify(result));
    assert.equal(result.round.phase, "preparing");
    assert.equal(result.round.candidate, undefined);
    assert.deepEqual(f.journal(), { effects: [], receipts: [] });
    await f.integrationAbsent();
    assert.deepEqual(await f.snapshot(), before, "waiting writes no round intents, receipts, artifacts, Git objects or refs");
  };
  await assertWaiting();
  const second = f.branches[1];
  await second.start();
  second.mutate();
  await assertWaiting();
  await second.complete();
  assert.equal(second.run().status, "succeeded");
  assert.equal(second.step().status, "running");
  await assertWaiting();
  await second.capture();
  assert.equal(second.intent().status, "confirmed");
  assert.equal(second.step().status, "running");
  await assertWaiting();
  await second.finalize();
  assert.equal((await f.coordinate()).status, "awaiting_approval");
  await assertCandidate(f);
  assert.deepEqual(await f.targetSnapshot(), target);
});

test("conflicting real branch results retain target and both source worktrees with durable conflict evidence", nativeGit, async t => {
  const f = await workflowMultibranchIntegrationFixture(t), target = await f.targetSnapshot();
  await f.finishBranch(0, { path: "shared.txt", content: "left conflicting result\n" });
  await f.finishBranch(1, { path: "shared.txt", content: "right conflicting result\n" });
  for (const branch of f.branches) await assertBranchEvidence(f, branch);
  const sources = await f.sourcesSnapshot();
  const result = await f.coordinate();
  assert.equal(result.status, "conflicted", JSON.stringify(result));
  assert.equal(result.code, "workflow_integration.text_conflict");
  assert.equal(f.round().phase, "conflicted");
  assert.equal(f.round().candidate, undefined);
  assert.equal(f.round().openIntentId, undefined);
  const packet = f.artifacts().find(artifact => artifact.sealedPayload?.kind === "workflow_integration_candidate")?.sealedPayload;
  assert.ok(packet);
  assert.equal(packet.status, "conflicted");
  assert.equal(packet.applied, false);
  assert.deepEqual(packet.includedStepIds, f.inputs.mergeOrder);
  assert.deepEqual(packet.merges.map(merge => merge.exitCode), [0, 1]);
  const conflict = packet.merges[1];
  assert.deepEqual(conflict.stages.map(({ path, stage }) => ({ path, stage })),
    [1, 2, 3].map(stage => ({ path: "shared.txt", stage })));
  const commits = [f.inputs.baseCommit, f.branches[0].result.commit, f.branches[1].result.commit];
  for (const [index, stage] of conflict.stages.entries()) assert.equal(stage.blob, await f.git("rev-parse", `${commits[index]}:shared.txt`));
  assert.ok(conflict.messages.some(message => message.paths.includes("shared.txt")));
  assert.match(packet.patch, /left conflicting result/);
  assert.match(packet.patch, /right conflicting result/);
  assert.equal(await f.ref(packet.resultRef), packet.commit);
  assert.equal(f.journal().effects.filter(effect => effect.kind === "integrate_branch").length, 2);
  assert.equal(f.journal().effects.filter(effect => ["target_apply", "candidate_verify"].includes(effect.kind)).length, 0);
  assert.ok(f.journal().effects.every(effect => effect.status === "confirmed"));
  assert.deepEqual(await f.targetSnapshot(), target);
  assert.deepEqual(await f.sourcesSnapshot(), sources, "conflict detection neither resets nor stages either source");
  const evidence = buildWorkflowIsolationEvidence(f.store, f.workflowId, now());
  assert.equal(evidence.rounds[0].phase, "conflicted");
  assert.equal(evidence.rounds[0].candidate, undefined);
  assert.equal(evidence.rounds[0].application.status, "not_started");
  assert.equal(evidence.gitEffects, "confirmed", "settled conflict detection does not imply delivery success");
  assert.equal(evidence.completion, "blocked");
  const before = await f.snapshot();
  f.reopenIsolation();
  assert.deepEqual(buildWorkflowIsolationEvidence(f.store, f.workflowId, now()), evidence);
  assert.deepEqual(await f.snapshot(), before, "a conflict read after reload cannot retry integration or apply");
});

test("SQLite reopen retains the first participant and later observes the same two-branch candidate without replay", nativeGit, async t => {
  const f = await workflowMultibranchIntegrationFixture(t), target = await f.targetSnapshot();
  await f.finishBranch(1);
  const first = f.branches[1].result;
  assert.equal((await f.coordinate()).status, "waiting");
  const waiting = await f.snapshot();
  f.reopenIsolation();
  assert.deepEqual(await f.branches[1].capture(), first, "reopened capture observes the original terminal lineage and sealed ref");
  assert.equal((await f.coordinate()).status, "waiting");
  assert.deepEqual(await f.snapshot(), waiting);
  await f.finishBranch(0);
  const result = await f.coordinate();
  assert.equal(result.status, "awaiting_approval", JSON.stringify(result));
  await assertCandidate(f);
  const sealed = f.branches.map(branch => branch.result);
  const before = await f.snapshot();
  assert.deepEqual(await f.coordinate(), result);
  f.reopenIsolation();
  for (const [index, branch] of f.branches.entries()) assert.deepEqual(await branch.capture(), sealed[index]);
  assert.deepEqual(await f.coordinate(), result);
  await assertCandidate(f);
  assert.deepEqual(await f.snapshot(), before, "recovery repeats no capture, integration, ref, verification or receipt effect");
  assert.deepEqual(await f.targetSnapshot(), target);
});
