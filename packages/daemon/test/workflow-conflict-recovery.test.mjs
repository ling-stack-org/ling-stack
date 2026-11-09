import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteWorkflowConflictRecoveryStore, createSqliteWorkflowIntegrationCoordinatorStore } from "@ling-stack/core";
import { recoverWorkflowConflict, readWorkflowConflictRecovery } from "../dist/features/channels/workflow-conflict-recovery.js";
import { runWorkflowIsolationOperation, waitForWorkflowIsolationIdle } from "../dist/features/channels/workflow-isolation-lifecycle.js";
import { coordinateWorkflowIntegration } from "../dist/features/channels/workflow-integration-coordinator.js";
import { finalizeOrchestratedWorkflowStepRun } from "../dist/features/channels/orchestrator.js";
import { workflowIsolationSelectionReady } from "../../core/dist/storage/sqlite/workflow-isolation-selection.js";
import { workflowConflictRecoveryFixture, recoveryHost, now } from "./support/workflow-conflict-recovery-fixture.mjs";
import { openWorkflowRecoveryDaemon, untilRecovery } from "./support/workflow-conflict-recovery-daemon-fixture.mjs";

const requestFor = original => ({ roundId: original.round.roundId, generation: original.round.generation,
  expectedRevision: original.round.revision, idempotencyKey: "explicit-repair-1", repairInstruction: "Preserve left in shared.txt; move right to right.txt." });
const counts = store => Object.fromEntries(["channel_workflows", "channel_workflow_steps", "tasks", "run_sessions", "approval_requests",
  "ling_turns", "conversation_items", "workflow_conflict_recoveries"].map(table => [table, store.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));
const state = f => Object.fromEntries(["channel_workflows", "channel_workflow_steps", "workflow_parallel_parent_fences", "workflow_integration_rounds",
  "workflow_integration_generations", "workflow_isolation_selections", "workflow_conflict_recoveries", "ling_threads", "ling_turns", "conversation_items",
  "state_transition_events"].map(table => [table, f.store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
const recover = (f, original, request = requestFor(original)) => recoverWorkflowConflict({ store: f.store,
  workflowId: original.workflow.id, request, runnerRegistry: f.runners, host: f.host });
async function retained(f, original) {
  const coordinator = createSqliteWorkflowIntegrationCoordinatorStore(f.store), scope = { roundId: original.id, generation: 1 };
  return { round: f.isolation().getIntegrationRound(original.id), effects: coordinator.listEffects(scope), receipts: coordinator.listReceipts(scope),
    plans: original.plans.map(p => f.isolation().getScopePlan(p.planId)), target: await f.target(),
    artifacts: original.items.flatMap(item => f.store.listArtifacts(item.run.id)),
    sources: await Promise.all(original.items.map(async item => ({ content: await readFile(join(item.plan.executionRoot, "shared.txt"), "utf8"),
      result: await f.git("rev-parse", item.result.resultRef), branch: await f.git("rev-parse", item.plan.branchRef) }))),
    integration: await f.gitAt(original.round.inputs.integration.executionRoot, "status", "--porcelain=v1") };
}

test("real conflict creates one explicit linked generation1 successor with a fresh canonical repair source and no execution", recoveryHost, async t => {
  const f = await workflowConflictRecoveryFixture(t), original = await f.conflict();
  // The existing parallel generation restriction is retained; recovery cannot relabel this round as generation2.
  const gate = f.isolation().beginIntegrationRoundGeneration({ roundId: original.id, expectedGeneration: 1,
    expectedRevision: original.round.revision, writer: original.items[0].writer, commandId: "forbidden-old-generation",
    inputs: original.round.inputs, now: now() });
  assert.notEqual(gate.status, "created");
  assert.equal(f.isolation().getIntegrationRound(original.id).generation, 1);
  const before = await retained(f, original), beforeCounts = counts(f.store), response = await recover(f, original);
  const { recovery, workflow, workflowSteps } = response;
  assert.equal(response.phase, "ready"); assert.equal(response.mode, "candidate_only"); assert.equal(response.requiresExplicitOrchestration, true);
  assert.equal(recovery.sequence, 1); assert.equal(recovery.predecessor.workflowId, original.workflow.id);
  assert.equal(recovery.predecessor.roundId, original.id); assert.equal(recovery.predecessor.generation, 1);
  assert.equal(recovery.successor.workflowId, workflow.id); assert.notEqual(recovery.successor.roundId, original.id);
  assert.equal(recovery.successor.generation, 1); assert.equal(f.isolation().getIntegrationRound(recovery.successor.roundId).generation, 1);
  assert.equal(f.store.getChannelWorkflow(original.workflow.id).status, "failed"); assert.equal(workflow.status, "ready");
  assert.ok(workflow.objective.includes(requestFor(original).repairInstruction));
  assert.notEqual(workflow.metadata.sourceTurnId, original.workflow.metadata.sourceTurnId);
  assert.notEqual(workflow.metadata.sourceMessageId, original.workflow.metadata.sourceMessageId);
  const turn = f.store.database.prepare("SELECT * FROM ling_turns WHERE id=?").get(workflow.metadata.sourceTurnId);
  const item = f.store.getConversationItem(workflow.metadata.sourceMessageId);
  assert.equal(turn.source_item_id, item.id); assert.equal(item.actorType, "local_user"); assert.equal(item.turnId, turn.id);
  assert.equal(item.payload.body, workflow.objective); assert.ok(item.domainRefs.some(ref => ref.type === "workflow" && ref.id === workflow.id));
  assert.ok(workflowSteps.every(step => step.status === "queued" && !step.taskId && !step.runId && !step.metadata.preStepApprovalId && step.metadata.autoStart === true));
  const afterCounts = counts(f.store);
  for (const table of ["tasks", "run_sessions", "approval_requests"]) assert.equal(afterCounts[table], beforeCounts[table]);
  assert.equal(afterCounts.ling_turns, beforeCounts.ling_turns + 1);
  assert.equal(afterCounts.conversation_items, beforeCounts.conversation_items + 1);
  assert.deepEqual(await retained(f, original), before);
  const stable = state(f);
  assert.deepEqual(await recover(f, original), response);
  assert.deepEqual(state(f), stable, "duplicate does not append another source, retire twice or create another workflow");
  await assert.rejects(recover(f, original, { ...requestFor(original), idempotencyKey: "different-request" }), { code: "workflow_recovery.request_reused" });
  await assert.rejects(recover(f, original, { ...requestFor(original), repairInstruction: "different repair" }), { code: "workflow_recovery.request_reused" });
  assert.deepEqual(state(f), stable);
  // Reopening is observation only; the exact POST may safely finish a retained planning handoff.
  f.reopen();
  assert.deepEqual(readWorkflowConflictRecovery(f.store, original.workflow.id), response);
  assert.deepEqual(await recover(f, original), response);
  assert.deepEqual(state(f), stable);
  assert.equal(createSqliteWorkflowConflictRecoveryStore(f.store).getBySuccessor(workflow.id).recoveryId, recovery.recoveryId);
  assert.throws(() => f.store.database.prepare("UPDATE workflow_conflict_recoveries SET idempotency_key='other'").run(), /lineage_immutable/u);
  assert.throws(() => f.store.database.prepare("DELETE FROM workflow_conflict_recoveries").run(), /lineage_retained/u);
  assert.deepEqual(await retained(f, original), before);

  // An explicit caller now advances the fresh steps. No old branch outcome or validation is reused.
  const successor = f.describe(workflow.id), first = await f.start(successor, 0);
  await first.write("repaired left\n"); await f.finish(first);
  const second = await f.start(successor, 1);
  await second.write("repaired right\n", "right.txt"); await f.finish(second);
  const verified = await coordinateWorkflowIntegration({ store: f.store, roundId: successor.id, now });
  assert.equal(verified.status, "awaiting_approval", JSON.stringify(verified));
  assert.ok(verified.round.candidate?.validationDigest); assert.equal(verified.round.outstandingApprovalId, undefined);
  assert.equal(verified.round.inputs.mode, "candidate_only");
  assert.deepEqual(await f.target(), before.target, "new verified candidate never authorizes target application");
  assert.deepEqual(await retained(f, original), before, "old conflict scene remains retained after fresh validation");
});

test("stale exact scope, pending Host operation and compiler failure reject without partial source/lineage/parent release", recoveryHost, async t => {
  const f = await workflowConflictRecoveryFixture(t), original = await f.conflict(), before = state(f);
  for (const change of [{ roundId: "foreign-round" }, { generation: 2 }, { expectedRevision: original.round.revision + 1 }]) {
    await assert.rejects(recover(f, original, { ...requestFor(original), ...change }), { code: "workflow_recovery.predecessor_changed" });
    assert.deepEqual(state(f), before);
  }
  let release;
  const pending = runWorkflowIsolationOperation(f.store, original.workflow.id, "recovery-test:real-pending",
    () => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  await assert.rejects(recover(f, original), { code: "workflow_recovery.host_draining" });
  assert.deepEqual(state(f), before); release(); await pending;
  const record = f.store.recordStateTransitionEvent.bind(f.store), method = t.mock.method(f.store, "recordStateTransitionEvent", input => {
    if (input.event === "conflict_recovery_retired") throw new Error("retirement-test-failure");
    return record(input);
  });
  try { await assert.rejects(recover(f, original), /retirement-test-failure/u); } finally { method.mock.restore(); }
  assert.deepEqual(state(f), before, "fresh canonical source and successor roll back together with retirement and lineage");
  assert.equal(f.store.database.isTransaction, false);
  assert.equal((await recover(f, original)).phase, "ready");
});

test("reopened mutable predecessor and old approvals/callbacks cannot regain start, integration or successor ownership", recoveryHost, async t => {
  const f = await workflowConflictRecoveryFixture(t), original = await f.conflict(), response = await recover(f, original);
  const successor = f.describe(response.workflow.id), current = await f.start(successor, 0), write = await current.write("new successor\n");
  const snapshot = () => ({ round: f.isolation().getIntegrationRound(successor.id), workflow: f.store.getChannelWorkflow(successor.workflow.id),
    step: f.store.getChannelWorkflowStep(current.scope.step.id), binding: f.isolation().getExecutionBinding(current.writer.bindingId),
    parent: f.store.database.prepare("SELECT * FROM workflow_parallel_parent_fences WHERE round_id=?").get(successor.id),
    approvals: f.store.listApprovalRequests({ runId: current.run.id }), leases: f.store.listResourceLeases({ attemptId: current.fence.attemptId }),
    slots: f.store.listRuntimeSemaphoreSlots({ workUnitId: current.fence.workUnitId, limit: 100 }) });
  const stable = snapshot(), old = original.items[0];
  assert.equal(f.store.updateChannelWorkflow(original.workflow.id, { status: "running" }, now()).status, "running");
  assert.equal(workflowIsolationSelectionReady(f.store.database, original.workflow.id), false);
  const authority = createSqliteWorkflowIntegrationCoordinatorStore(f.store).assertAuthority({ roundId: original.id, generation: 1, now: now() });
  assert.equal(authority.status, "stale"); assert.match(authority.code, /workflow_retired_by_recovery/u);
  await assert.rejects(async () => old.handler(old.approval.request), { code: "attempt_execution_stale_owner" });
  assert.equal(f.store.getApprovalRequest(old.approval.approvalId).status, "approved");
  assert.throws(() => f.store.approveApprovalRequest(old.approval.approvalId,
    { resolvedBy: "local-user", decisionKind: "approve_once" }, now()), /not pending/u);
  assert.equal(finalizeOrchestratedWorkflowStepRun(f.store, old.scope.step.id, old.task.id, f.store.getRun(old.run.id), now()).id, old.scope.step.id);
  assert.deepEqual(snapshot(), stable);
  assert.equal(await readFile(join(current.plan.executionRoot, "shared.txt"), "utf8"), "new successor\n");
  assert.notEqual(write.approvalId, old.approval.approvalId);
  await f.finish(current);
});

test("planning failure retains an exact retry handoff; explicit HTTP orchestrate dispatches fresh original Pi Runs and repair source", recoveryHost, async t => {
  const f = await workflowConflictRecoveryFixture(t), original = await f.conflict();
  const daemon = await openWorkflowRecoveryDaemon(t, f), path = `/workflows/${original.workflow.id}/conflict-recovery`;
  await waitForWorkflowIsolationIdle(f.store, original.workflow.id);
  const before = await retained(f, original), beforeCounts = counts(f.store);
  const list = f.store.listChannelWorkflowSteps.bind(f.store);
  const failure = t.mock.method(f.store, "listChannelWorkflowSteps", options => {
    if (options.workflowId !== original.workflow.id && f.isolation().getSelection(options.workflowId)?.phase === "planning") {
      throw new Error("recovery-planning-handoff-fixture");
    }
    return list(options);
  });
  let failed;
  try { failed = await daemon.api(path, requestFor(original)); } finally { failure.mock.restore(); }
  assert.equal(failed.status, 409, JSON.stringify(failed));
  assert.equal(failed.body.error, "workflow_recovery.successor_planning");
  assert.match(failed.body.message, /recovery-planning-handoff-fixture/);
  const lineage = createSqliteWorkflowConflictRecoveryStore(f.store).getByPredecessor(original.workflow.id);
  assert.ok(lineage);
  const successorId = lineage.successor.workflowId, selection = f.isolation().getSelection(successorId);
  assert.equal(selection.phase, "planning"); assert.equal(selection.roundId, lineage.successor.roundId);
  assert.equal(f.isolation().getIntegrationRound(selection.roundId), undefined);
  assert.equal(f.store.getChannelWorkflow(original.workflow.id).status, "failed");
  assert.equal(f.store.database.prepare("SELECT state FROM workflow_parallel_parent_fences WHERE round_id=?").get(original.id).state, "released");
  const repoFence = new DatabaseSync(join(original.round.inputs.repositoryIdentity.commonDir, "ling-workflow-repository-fence.sqlite"), { readOnly: true });
  try { assert.equal(repoFence.prepare("SELECT state FROM repository_fence WHERE singleton=1").get().state, "released"); }
  finally { repoFence.close(); }
  for (const table of ["tasks", "run_sessions", "approval_requests"]) assert.equal(counts(f.store)[table], beforeCounts[table]);
  assert.equal(daemon.executions.size, 0);
  const pending = await daemon.api(path);
  assert.equal(pending.status, 200, JSON.stringify(pending)); assert.equal(pending.body.phase, "planning");
  const repair = pending.body.workflow, stable = state(f);
  const blocked = await daemon.api(`/workflows/${successorId}/orchestrate`, {});
  assert.equal(blocked.status, 409, JSON.stringify(blocked)); assert.equal(blocked.body.error, "workflow_isolation_planning");
  const blockedStep = await daemon.api(`/workflow-steps/${pending.body.workflowSteps[0].id}/start`, { mode: "create_and_run_task" });
  assert.equal(blockedStep.status, 409, JSON.stringify(blockedStep));
  assert.equal(blockedStep.body.error, "workflow_isolation_planning");
  f.reopen("peer");
  assert.deepEqual(readWorkflowConflictRecovery(f.peer, original.workflow.id), pending.body);
  assert.deepEqual(state(f), stable, "reopen/read and ordinary start cannot complete planning or create execution facts");
  const changed = await daemon.api(path, { ...requestFor(original), repairInstruction: "changed repair" });
  assert.equal(changed.status, 409); assert.equal(changed.body.error, "workflow_recovery.request_reused");
  const retried = await daemon.api(path, requestFor(original));
  assert.equal(retried.status, 200, JSON.stringify(retried)); assert.equal(retried.body.phase, "ready");
  assert.deepEqual(retried.body.recovery, lineage);
  assert.equal(retried.body.workflow.metadata.sourceMessageId, repair.metadata.sourceMessageId);
  assert.equal(retried.body.workflow.metadata.sourceTurnId, repair.metadata.sourceTurnId);
  assert.equal(counts(f.store).workflow_conflict_recoveries, beforeCounts.workflow_conflict_recoveries + 1);
  assert.equal(counts(f.store).ling_turns, beforeCounts.ling_turns + 1);
  assert.equal(counts(f.store).conversation_items, beforeCounts.conversation_items + 1);
  for (const table of ["tasks", "run_sessions", "approval_requests"]) assert.equal(counts(f.store)[table], beforeCounts[table]);
  assert.equal(daemon.executions.size, 0, "Even a successful exact recovery POST is Create-only");
  assert.deepEqual(await retained(f, original), before);

  const steps = retried.body.workflowSteps, source = f.store.getConversationItem(repair.metadata.sourceMessageId);
  assert.equal(source.actorType, "local_user"); assert.equal(source.turnId, repair.metadata.sourceTurnId);
  assert.ok(source.payload.body.includes(requestFor(original).repairInstruction));
  assert.ok(steps.every(step => step.metadata.autoStart === true));
  daemon.allowAdvance(successorId);
  const describe = () => ({ steps: list({ workflowId: successorId, complete: true }),
    runs: f.store.listRuns({ limit: 10 }), approvals: f.store.listApprovalRequests({ status: "pending", limit: 20 }) });
  const started = await daemon.api(`/workflows/${successorId}/orchestrate`, {});
  assert.equal(started.status, 200, JSON.stringify(started)); assert.equal(started.body.status, "started", JSON.stringify(started));
  assert.deepEqual(started.body.startedSteps.map(value => value.workflowStep.id), [steps[0].id]);
  for (const step of steps) {
    await untilRecovery(() => {
      const runId = daemon.executions.get(step.id)?.runId;
      return Boolean(runId && f.store.listApprovalRequests({ runId, status: "pending", limit: 20 }).some(approval => approval.actionType === "write"));
    },
      "the fresh Run's real Host write approval", describe);
    const execution = daemon.executions.get(step.id), run = f.store.getRun(execution.runId);
    assert.equal(run.workflowStepId, step.id); assert.equal(run.requestSnapshot.sourceMessageId, source.id);
    assert.equal(run.requestSnapshot.contextPack.agentContext.sourceItemId, source.id);
    const child = f.store.getLingTurnForRun(run.id);
    assert.ok(child, "The fresh workflow Run must be linked to a canonical child turn");
    assert.notEqual(child.id, source.turnId, "The fresh workflow step owns a child input turn");
    const childInput = f.store.getConversationItem(child.sourceItemId);
    assert.equal(childInput.turnId, child.id);
    assert.ok(childInput.domainRefs.some(ref => ref.type === "conversation_item" && ref.id === source.id), JSON.stringify(childInput));
    const approval = f.store.listApprovalRequests({ runId: run.id, status: "pending", limit: 20 })[0];
    assert.ok(approval); assert.equal(approval.actionType, "write");
    assert.equal((await daemon.api(`/approvals/${approval.id}/approve`, { decisionKind: "approve_once" })).status, 200);
    await untilRecovery(() => f.store.getRun(run.id).status === "succeeded" && f.store.getChannelWorkflowStep(step.id).status === "succeeded",
      "the original explicitly scheduled Pi Run and verified workflow step", describe);
    assert.equal(f.store.listRuns({ workflowStepId: step.id, limit: 20 }).length, 1);
    assert.equal(execution.requests.length, 2); assert.equal(execution.results.length, 1);
    assert.deepEqual(await f.target(), before.target);
  }
  assert.equal(daemon.executions.size, steps.length);
  const roundId = lineage.successor.roundId;
  const verified = await coordinateWorkflowIntegration({ store: f.store, roundId, now });
  assert.equal(verified.status, "awaiting_approval", JSON.stringify(verified));
  assert.equal(verified.round.generation, 1); assert.equal(verified.round.inputs.mode, "candidate_only");
  assert.ok(verified.round.candidate.validationDigest); assert.equal(verified.round.outstandingApprovalId, undefined);
  assert.deepEqual(await f.target(), before.target);
  assert.deepEqual(await retained(f, original), before);
});

const retirementCases = [
  { name: "successful recovery publishes the old source exactly once without restart" },
  { name: "successor planning failure still publishes the old source exactly once without restart", planningFailure: true },
  { name: "identical HTTP recovery retries publish the old source exactly once without restart", duplicate: true },
];

for (const scenario of retirementCases) {
  test(`conflict retirement TerminalReport: ${scenario.name}`, recoveryHost, async t => {
    const f = await workflowConflictRecoveryFixture(t);
    const daemon = await openWorkflowRecoveryDaemon(t, f, { terminalReports: true });
    const publicationAttempts = [];
    const commitPublication = f.store.commitTerminalReportPublication.bind(f.store);
    t.mock.method(f.store, "commitTerminalReportPublication", input => {
      const result = commitPublication(input);
      publicationAttempts.push({ reportId: input.reportId, result });
      return result;
    });
    // Create the conflict only after the daemon's independent health report is published.
    // No restart, startup sweep or explicit report processor may settle this predecessor.
    const original = await f.conflict(), path = `/workflows/${original.workflow.id}/conflict-recovery`;
    await waitForWorkflowIsolationIdle(f.store, original.workflow.id);
    const sourceTurnId = original.workflow.metadata.sourceTurnId, sourceMessageId = original.workflow.metadata.sourceMessageId;
    assert.equal(f.store.getChannelWorkflow(original.workflow.id).status, "running");
    assert.ok(["open", "running"].includes(f.store.getLingTurn(sourceTurnId).status));
    assert.deepEqual(retirementReports(f.store, original.workflow.id), [], "The target must not already have a report from startup");
    assert.ok(original.items.every(item => f.store.getHostAttemptCompletion(item.source)?.drainedAt));
    assert.deepEqual(f.store.listApprovalRequests({ status: "pending", limit: 100 }), []);
    const beforeCounts = counts(f.store), attempts = f.store.database.prepare("SELECT * FROM work_unit_attempts ORDER BY rowid").all();
    const approvals = f.store.listApprovalRequests({ limit: 100 });
    const list = f.store.listChannelWorkflowSteps.bind(f.store);
    const failure = scenario.planningFailure ? t.mock.method(f.store, "listChannelWorkflowSteps", options => {
      if (options.workflowId !== original.workflow.id && f.isolation().getSelection(options.workflowId)?.phase === "planning") {
        throw new Error("recovery-planning-handoff-fixture");
      }
      return list(options);
    }) : undefined;
    let response;
    try { response = await daemon.api(path, requestFor(original)); } finally { failure?.mock.restore(); }
    assert.equal(response.status, scenario.planningFailure ? 409 : 200, JSON.stringify(response));
    if (scenario.planningFailure) {
      assert.equal(response.body.error, "workflow_recovery.successor_planning");
      assert.match(response.body.message, /recovery-planning-handoff-fixture/u);
    } else assert.equal(response.body.phase, "ready");

    const lineage = createSqliteWorkflowConflictRecoveryStore(f.store).getByPredecessor(original.workflow.id);
    assert.ok(lineage, "HTTP recovery must durably create lineage before the missing-report assertion");
    assert.equal(f.store.getChannelWorkflow(original.workflow.id).status, "failed");
    assert.equal(f.store.database.prepare("SELECT state FROM workflow_parallel_parent_fences WHERE round_id=?").get(original.id).state, "released");
    const successor = f.store.getChannelWorkflow(lineage.successor.workflowId), fresh = recoverySource(f.store, successor);
    assert.notEqual(successor.metadata.sourceTurnId, sourceTurnId);
    assert.notEqual(successor.metadata.sourceMessageId, sourceMessageId);
    assert.equal(fresh.turn.status, "open");
    assert.equal(fresh.turn.activeRunId, undefined);
    assert.equal(fresh.turn.completedAt, undefined);
    assert.equal(fresh.item.turnId, fresh.turn.id);
    assert.equal(fresh.item.actorType, "local_user");
    assert.ok(fresh.item.domainRefs.some(ref => ref.type === "workflow" && ref.id === successor.id));
    assert.equal(f.isolation().getSelection(successor.id).phase, scenario.planningFailure ? "planning" : "ready");
    if (scenario.planningFailure) assert.equal(f.isolation().getIntegrationRound(lineage.successor.roundId), undefined);
    const assertIsolated = () => {
      daemon.assertReportFixture();
      assert.deepEqual(recoverySource(f.store, successor), fresh, "Old report publication must not settle or relink the fresh source");
      assert.deepEqual(retirementReports(f.store, successor.id), [], "A Create-only successor must not receive the predecessor report");
      const steps = list({ workflowId: successor.id, complete: true });
      assert.ok(steps.every(step => step.status === "queued" && !step.taskId && !step.runId && !step.metadata.preStepApprovalId));
      for (const table of ["tasks", "run_sessions", "approval_requests"]) assert.equal(counts(f.store)[table], beforeCounts[table]);
      assert.deepEqual(f.store.database.prepare("SELECT * FROM work_unit_attempts ORDER BY rowid").all(), attempts);
      assert.deepEqual(f.store.listApprovalRequests({ limit: 100 }), approvals);
      assert.equal(daemon.executions.size, 0, "Recovery and report synthesis must not dispatch a workflow Run");
      assert.equal(counts(f.store).workflow_conflict_recoveries, beforeCounts.workflow_conflict_recoveries + 1);
      assert.equal(counts(f.store).ling_turns, beforeCounts.ling_turns + 1);
    };
    assertIsolated();
    if (scenario.duplicate) {
      for (let index = 0; index < 2; index++) {
        const replay = await daemon.api(path, requestFor(original));
        assert.equal(replay.status, 200, JSON.stringify(replay));
        assert.deepEqual(replay.body.recovery, lineage);
        assertIsolated();
      }
    }

    const describe = () => ({ predecessorStatus: f.store.getChannelWorkflow(original.workflow.id).status,
      predecessorSource: f.store.getLingTurn(sourceTurnId), reports: retirementReports(f.store, original.workflow.id),
      successorSource: f.store.getLingTurn(successor.metadata.sourceTurnId), fixtureHealthWorkflowId: daemon.reportProbe.id,
      fixtureHealthReportPublished: Boolean(retirementReports(f.store, daemon.reportProbe.id)[0]?.resultItemId),
      reportRequests: daemon.reportRequests, publicationAttempts });
    await untilRecovery(() => Boolean(retirementReports(f.store, original.workflow.id)[0]?.resultItemId),
      "missing predecessor TerminalReport after durable conflict retirement (fixture health report already published; no restart)", describe);
    assertIsolated();
    const published = await assertRetirementPublication(f, daemon, original, sourceTurnId, sourceMessageId);

    // Replay after publication too; a failed planning handoff is finished only by this exact POST.
    const replay = await daemon.api(path, requestFor(original));
    assert.equal(replay.status, 200, JSON.stringify(replay));
    assert.equal(replay.body.phase, "ready");
    assert.deepEqual(replay.body.recovery, lineage);
    assertIsolated();
    assert.deepEqual(await assertRetirementPublication(f, daemon, original, sourceTurnId, sourceMessageId), published,
      "An exact HTTP retry must reuse the first report, canonical result item, source settlement and publication event");
  });
}

function retirementReports(store, workflowId) {
  return store.listTerminalReports({ sourceKind: "workflow", sourceId: workflowId, limit: 100 });
}

function recoverySource(store, workflow) {
  return { turn: store.getLingTurn(workflow.metadata.sourceTurnId), item: store.getConversationItem(workflow.metadata.sourceMessageId) };
}

async function assertRetirementPublication(f, daemon, original, sourceTurnId, sourceMessageId) {
  const reports = retirementReports(f.store, original.workflow.id);
  assert.equal(reports.length, 1, "Retirement must produce one report generation, not one per exact request");
  const report = reports[0], item = f.store.getConversationItem(report.resultItemId), turn = f.store.getLingTurn(sourceTurnId);
  assert.ok(report.report, "A stored draft is not a published TerminalReport");
  assert.equal(report.report.outcome.status, "partially_succeeded");
  assert.ok(report.evidenceSnapshot.steps.every(step => step.status === "succeeded"));
  assert.equal(report.report.source.id, original.workflow.id);
  assert.equal(report.report.sourceMessageId, sourceMessageId);
  assert.equal(item.kind, "terminal_report");
  assert.equal(item.status, "committed");
  assert.equal(item.turnId, sourceTurnId);
  assert.equal(item.payload.reportId, report.id);
  assert.ok(item.domainRefs.some(ref => ref.type === "workflow" && ref.id === original.workflow.id));
  assert.ok(item.domainRefs.some(ref => ref.type === "conversation_item" && ref.id === sourceMessageId));
  assert.ok(item.domainRefs.some(ref => ref.type === "turn" && ref.id === sourceTurnId));
  assert.equal(item.threadId, turn.threadId);
  assert.equal(turn.status, "failed");
  assert.equal(turn.activeRunId, undefined);
  assert.ok(turn.completedAt);
  const resultItems = f.store.listConversationItemsForTurn({ turnId: sourceTurnId }).filter(value => value.kind === "terminal_report");
  assert.deepEqual(resultItems.map(value => value.id), [item.id]);
  const settlements = f.store.listStateTransitionEvents({ entityType: "turn", entityId: sourceTurnId })
    .filter(event => event.reason?.includes(`published:${item.id}`));
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].toStatus, "failed");
  const events = f.store.listControlPlaneEvents({ workspaceId: f.channel.workspaceId, entityType: "terminal_report",
    entityId: report.id, action: "terminal_report.published", limit: 100 });
  assert.equal(events.length, 1);
  const detail = await daemon.api(`/terminal-reports/${report.id}`);
  assert.equal(detail.status, 200, JSON.stringify(detail));
  assert.equal(detail.body.report.id, report.id);
  const collection = await daemon.api(`/channels/${f.channel.id}/terminal-reports`);
  assert.equal(collection.status, 200, JSON.stringify(collection));
  assert.deepEqual(collection.body.reports.filter(value => value.source.kind === "workflow" && value.source.id === original.workflow.id)
    .map(value => value.id), [report.id]);
  return { report, item, turn, settlements, events };
}
