import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startWorkflowIsolationLiveFixture } from "./support/workflow-isolation-live-fixture.mjs";

const LIVE_WAIT_TIMEOUT_MS = 120_000;

test("public candidate-only completion publishes once after original Host operations and cleanup settle",
  { skip: process.platform !== "darwin", timeout: 300_000 }, async t => {
    const fixture = await startWorkflowIsolationLiveFixture({ publicSelection: true, holdReturn: true });
    t.after(() => fixture.close());
    const manifest = fixture.manifest;
    const post = async (path, body) => {
      const response = await fetch(`${manifest.daemonUrl}${path}?cwd=${encodeURIComponent(manifest.workspaceCwd)}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const value = await response.json();
      assert.equal(response.ok, true, JSON.stringify(value));
      return value;
    };
    const status = () => fixture.command({ op: "status" });
    const wait = async (label, predicate) => {
      const deadline = performance.now() + LIVE_WAIT_TIMEOUT_MS;
      let state;
      while (performance.now() < deadline) {
        state = await status();
        if (predicate(state)) return state;
        await delay(100);
      }
      assert.fail(`${label}: ${JSON.stringify({ workflow: state.workflow.status, parent: state.parent?.state,
        reports: state.reports, errors: state.errors })}`);
    };
    const approve = async count => {
      const state = await wait("original write approvals", value => value.approvals.length === count);
      for (const approval of state.approvals) {
        assert.equal(approval.actionType, "write");
        await post(`/approvals/${approval.id}/approve`, { decisionKind: "approve_once" });
      }
    };
    await post(`/workflows/${manifest.workflowId}/orchestrate`, { executionProfile: "pi_host_isolated_files_v1" });
    await approve(1);
    await wait("dependency Host response held", state => state.executions.some(item => item.branch === "prepare" && item.reached));
    await fixture.command({ op: "release", gate: "all", branch: "prepare" });
    await approve(2);
    const parallel = await wait("both original sibling responses held",
      state => state.executions.filter(item => item.reached && !item.returned).length === 2);
    const originalRuns = parallel.runs.map(item => item.run.id).sort();
    assert.equal(originalRuns.length, 3);
    assert.deepEqual(parallel.target, parallel.initialTarget);
    await fixture.command({ op: "release", gate: "provider" });
    await wait("original SDK responses settled", state => state.executions.every(item => item.sdkSettled));
    await fixture.command({ op: "release", gate: "host" });
    const completed = await wait("candidate, physical drain and canonical terminal publication",
      state => state.workflow.status === "succeeded" && state.parent.state === "released"
        && state.reports.length === 1 && state.reports[0].resultItemId);
    assert.equal(completed.sourceTurn.status, "succeeded");
    assert.equal(completed.round.inputs.mode, "candidate_only");
    assert.equal(completed.round.phase, "awaiting_approval");
    assert.ok(completed.round.candidate?.commit);
    assert.deepEqual(completed.approvals, []);
    assert.ok(completed.runs.every(item => item.completion?.drainedAt && !item.slots.length));
    assert.deepEqual(completed.target, completed.initialTarget);
    assert.deepEqual(completed.errors, []);
    await post(`/workflows/${manifest.workflowId}/orchestrate`, {});
    await fixture.command({ op: "restart" });
    const restarted = await status();
    assert.equal(restarted.reports.length, 1, "repeated completion and restart reuse the publication");
    assert.equal(restarted.reports[0].resultItemId, completed.reports[0].resultItemId);
    assert.deepEqual(restarted.runs.map(item => item.run.id).sort(), originalRuns);
    assert.deepEqual(restarted.target, completed.initialTarget);
    assert.equal(restarted.parent.state, "released");
  });
