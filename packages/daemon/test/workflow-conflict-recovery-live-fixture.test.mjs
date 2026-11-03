import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startWorkflowIsolationLiveFixture } from "./support/workflow-isolation-live-fixture.mjs";

test("conflict recovery uses independent Pi Host executions and retains a candidate-only successor across observation and restart",
  { skip: process.platform !== "darwin", timeout: 180_000 }, async t => {
    const fixture = await startWorkflowIsolationLiveFixture({ conflictRecovery: true, holdReturn: true });
    t.after(() => fixture.close());
    const manifest = fixture.manifest, recoveryPath = `/workflows/${manifest.workflowId}/conflict-recovery`;
    assert.equal(manifest.conflictRecovery, true);
    assert.equal(manifest.publicSelection, true);
    const api = async (path, body, expectedStatus = 200) => {
      const method = body === undefined ? "GET" : "POST";
      const response = await fetch(`${fixture.url}${path}?cwd=${encodeURIComponent(fixture.cwd)}`, {
        method, signal: AbortSignal.timeout(45_000), ...(body === undefined ? {} : {
          headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      const value = await response.json();
      assert.equal(response.status, expectedStatus, `${method} ${path}: ${JSON.stringify(value)}`);
      return value;
    };
    const status = () => fixture.command({ op: "status" });
    const scope = (state, workflowId) => workflowId === manifest.workflowId ? state : state.successor;
    const wait = async (label, predicate) => {
      const deadline = performance.now() + 45_000;
      let state;
      while (performance.now() < deadline) {
        state = await status();
        assert.deepEqual(state.errors, [], "Loopback transport must remain healthy");
        if (predicate(state)) return state;
        await delay(100);
      }
      assert.fail(`${label}: ${JSON.stringify(state)}`);
    };
    const approve = async (workflowId, count) => {
      const state = await wait("workflow-scoped Host write approvals", value => scope(value, workflowId).approvals.length === count);
      const approvals = scope(state, workflowId).approvals;
      for (const approval of approvals) {
        assert.equal(approval.actionType, "write");
        assert.ok(scope(state, workflowId).runs.some(item => item.run.id === approval.runId));
        await api(`/approvals/${approval.id}/approve`, { decisionKind: "approve_once" });
      }
      return approvals;
    };
    const start = async workflowId => {
      const result = await api(`/workflows/${workflowId}/orchestrate`, { executionProfile: "pi_host_isolated_files_v1" });
      assert.equal(result.status, "started", JSON.stringify(result));
      const prepareApprovals = await approve(workflowId, 1);
      await wait("dependency response held", state => scope(state, workflowId).executions
        .some(item => item.branch === "prepare" && item.reached && !item.returned));
      await fixture.command({ op: "release", workflowId, branch: "prepare", gate: "all" });
      const siblingApprovals = await approve(workflowId, 2);
      const state = await wait("parallel sibling responses held", state => scope(state, workflowId).executions
        .filter(item => item.reached && !item.returned).length === 2);
      await fixture.command({ op: "check", workflowId, kind: "parallel" });
      assert.deepEqual(state.target, state.initialTarget);
      assert.ok(scope(state, workflowId).gates.filter(gate => gate.branch !== "prepare")
        .every(gate => !gate.providerReleased && !gate.hostReleased), "Workflow gates retain their own Host lifetime");
      return { state, approvals: [...prepareApprovals, ...siblingApprovals] };
    };
    const drain = async workflowId => {
      await fixture.command({ op: "release", workflowId, gate: "provider" });
      const held = await wait("SDK completion behind the Host gate", state => scope(state, workflowId).executions.every(item => item.sdkSettled));
      assert.ok(scope(held, workflowId).executions.filter(item => item.branch !== "prepare").every(item => !item.returned));
      await fixture.command({ op: "release", workflowId, gate: "host" });
      return wait("physical Host drain and sealed results", state => {
        const value = scope(state, workflowId);
        return value.executions.every(item => item.returned) && value.runs.every(item => item.completion?.drainedAt
          && item.slots.length === 0 && item.terminalIntent?.status === "confirmed") && !value.draining;
      });
    };
    const runIds = value => value.runs.map(item => item.run.id).sort();
    const initial = await status();
    assert.equal(initial.selection, undefined);
    assert.equal(initial.successor, undefined);
    assert.deepEqual(initial.runs, []);
    assert.equal((await api(recoveryPath, undefined, 404)).error, "workflow_recovery.not_found");

    const original = await start(manifest.workflowId);
    const siblingWrites = original.state.executions.filter(item => item.branch !== "prepare");
    assert.deepEqual(siblingWrites.map(item => item.path), ["shared.txt", "shared.txt"]);
    assert.equal(new Set(siblingWrites.map(item => item.content)).size, 2);
    assert.equal(original.state.runs.length, 3);
    assert.equal(new Set(original.state.runs.map(item => item.run.cwd)).size, 3);
    await drain(manifest.workflowId);
    const conflicted = await wait("real Git text conflict", state => state.round.phase === "conflicted" && !state.draining);
    await fixture.command({ op: "check", kind: "conflicted" });
    const predecessorRuns = runIds(conflicted), predecessorSteps = conflicted.steps.map(step => step.id);
    const predecessorAttempts = conflicted.runs.map(item => item.attempt.id);
    const predecessorUnits = conflicted.runs.map(item => item.run.workUnitId);
    for (const item of conflicted.runs) assert.ok(item.terminalIntent.commit);
    assert.equal(conflicted.round.reason, "workflow_integration.text_conflict");
    assert.equal(conflicted.round.candidate, undefined);
    assert.deepEqual(conflicted.target, conflicted.initialTarget);

    const request = { roundId: conflicted.round.roundId, generation: conflicted.round.generation,
      expectedRevision: conflicted.round.revision, idempotencyKey: "live-conflict-repair", repairInstruction: manifest.repairInstruction };
    const response = await api(recoveryPath, request), successorId = response.workflow.id;
    assert.equal(response.phase, "ready");
    assert.equal(response.executionProfile, "pi_host_isolated_files_v1");
    assert.equal(response.mode, "candidate_only");
    assert.equal(response.requiresExplicitOrchestration, true);
    assert.notEqual(successorId, manifest.workflowId);
    assert.equal(response.recovery.successor.generation, 1);
    assert.notEqual(response.recovery.successor.roundId, conflicted.round.roundId);
    await fixture.command({ op: "check", kind: "recovery-ready" });
    const retired = await wait("predecessor terminal publication", state => state.workflow.status === "failed"
      && state.sourceTurn.status === "failed" && state.reports.length === 1 && state.reports[0].resultItemId);
    assert.equal(retired.reports[0].synthesisMode, "model");
    assert.equal(retired.successor.sourceTurn.status, "open");
    assert.ok(retired.successor.sourceMessage.payload.body.includes(request.repairInstruction));

    for (let index = 0; index < 2; index++) {
      const observed = await api(recoveryPath);
      assert.deepEqual(observed.recovery, response.recovery);
      const replay = await api(recoveryPath, request);
      assert.deepEqual(replay.recovery, response.recovery);
      const state = await status();
      assert.deepEqual(runIds(state), predecessorRuns);
      assert.deepEqual(state.round, conflicted.round);
      assert.deepEqual(state.successor.runs, []);
      assert.deepEqual(state.successor.executions, []);
      assert.deepEqual(state.successor.reports, []);
      assert.ok(state.successor.steps.every(step => step.status === "queued" && !step.taskId && !step.runId));
      assert.deepEqual(state.target, state.initialTarget);
    }
    const changed = await api(recoveryPath, { ...request, repairInstruction: "Use a different repair." }, 409);
    assert.equal(changed.error, "workflow_recovery.request_reused");
    await fixture.command({ op: "restart" });
    assert.deepEqual((await api(recoveryPath)).recovery, response.recovery);
    await fixture.command({ op: "check", kind: "recovery-ready" });

    const repair = await start(successorId);
    const successor = repair.state.successor;
    assert.equal(successor.runs.length, 3);
    assert.ok(successor.executions.every(item => item.sequence === 1 && item.workflowId === successorId));
    assert.ok(successor.executions.every(item => !predecessorRuns.includes(item.runId) && !predecessorSteps.includes(item.stepId)));
    assert.ok(successor.runs.every(item => !predecessorAttempts.includes(item.attempt.id) && !predecessorUnits.includes(item.run.workUnitId)));
    assert.ok(repair.approvals.every(approval => !original.approvals.some(item => item.id === approval.id)));
    assert.deepEqual(successor.executions.filter(item => item.branch !== "prepare").map(item => item.path).sort(), ["left.txt", "right.txt"]);
    for (const item of successor.runs) {
      assert.equal(item.run.requestSnapshot.sourceMessageId, successor.sourceMessage.id);
      assert.equal(await readFile(join(item.run.cwd, "shared.txt"), "utf8"), "initial shared.txt\n");
      assert.ok(!conflicted.runs.some(previous => previous.run.cwd === item.run.cwd));
    }
    await drain(successorId);
    const completed = await wait("successor candidate and terminal publication", state => state.successor.workflow.status === "succeeded"
      && state.successor.parent.state === "released" && state.successor.sourceTurn.status === "succeeded"
      && state.successor.reports.length === 1 && state.successor.reports[0].resultItemId && !state.successor.draining);
    await fixture.command({ op: "check", workflowId: successorId, kind: "succeeded" });
    assert.equal(completed.successor.round.phase, "awaiting_approval");
    assert.equal(completed.successor.round.inputs.mode, "candidate_only");
    assert.ok(completed.successor.round.candidate.validationDigest);
    assert.equal(completed.successor.round.outstandingApprovalId, undefined);
    assert.equal(completed.successor.round.generation, 1);
    assert.notEqual(completed.successor.reports[0].resultItemId, retired.reports[0].resultItemId);
    assert.deepEqual(completed.round, conflicted.round);
    assert.deepEqual(runIds(completed), predecessorRuns);
    assert.deepEqual(completed.reports, retired.reports);
    assert.equal(completed.sourceTurn.status, "failed");
    assert.deepEqual(completed.target, completed.initialTarget);
    const evidence = await fixture.command({ op: "evidence" });
    for (const value of [evidence, evidence.successor]) for (const item of value.runs) {
      assert.equal(item.toolExecutions.length, 1);
      assert.equal(item.toolExecutions[0].state, "succeeded");
      assert.ok(item.artifacts.some(artifact => artifact.sealedPayload?.kind === "workflow_isolation_file_mutation"));
      assert.ok(item.completion.drainedAt);
      assert.deepEqual(item.slots, []);
    }
    assert.ok(evidence.successor.executions.every(item => item.requests.length >= 2
      && item.requests.every(body => JSON.stringify(body.messages).includes(request.repairInstruction))));
    await fixture.command({ op: "restart" });
    const restarted = await status();
    assert.deepEqual(runIds(restarted), predecessorRuns);
    assert.deepEqual(runIds(restarted.successor), runIds(completed.successor));
    assert.deepEqual(restarted.recovery, response.recovery);
    assert.deepEqual(restarted.reports, completed.reports);
    assert.deepEqual(restarted.successor.reports, completed.successor.reports);
    assert.deepEqual(restarted.target, completed.initialTarget);
  });
