import assert from "node:assert/strict";
import test from "node:test";
import { LingDaemonClient } from "../dist/index.js";

test("workflow orchestration and retry preserve explicit safety scheduling reasons", async () => {
  const calls = [];
  const response = { status: "idle", workflow: { id: "workflow-1" }, reason: "No safe scheduling slot.",
    schedulingDecision: { schedulingMode: "smart", effectiveMode: "serial", parallelLimit: 1,
      runnableStepIds: [], queuedStepIds: ["step-1"], resourceLocks: ["host:shared-index"], safetyEvidence: "partial",
      reasonCodes: ["safety_opt_in_required", "host_parallel_capability_unavailable",
        "active_step_safety_unverified", "resource_conflict"] } };
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: async (input, init) => {
    calls.push({ url: new URL(String(input)), method: init.method, body: JSON.parse(init.body) });
    return Response.json(response);
  } });
  assert.deepEqual(await client.orchestrateChannelWorkflow("/repo", "workflow / safety"), response);
  assert.deepEqual(await client.retryChannelWorkflowStep("/repo", "step / safety"), response);
  assert.deepEqual(calls.map(call => [call.method, call.url.pathname, call.url.searchParams.get("cwd"), call.body]), [
    ["POST", "/workflows/workflow%20%2F%20safety/orchestrate", "/repo", {}],
    ["POST", "/workflow-steps/step%20%2F%20safety/retry", "/repo", {}],
  ]);
});

test("isolated writing scheduling preserves its distinct reason and worktree resources", async () => {
  const startedSteps = ["left", "right"].map(id => ({ workflowStep: { id }, taskId: `task-${id}`, runId: `run-${id}` }));
  const response = { status: "started", workflow: { id: "isolated-workflow" }, ...startedSteps[0], startedSteps,
    schedulingDecision: { schedulingMode: "smart", effectiveMode: "parallel", parallelLimit: 2,
      runnableStepIds: ["left", "right"], queuedStepIds: [], resourceLocks: ["worktree:/host/left", "worktree:/host/right"],
      safetyEvidence: "complete", reasonCodes: ["isolated_files_parallel_allowed"] } };
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: async () => Response.json(response) });
  assert.deepEqual(await client.orchestrateChannelWorkflow("/repo", "isolated-workflow"), response);
});

test("isolated execution is selected explicitly without adding target application authority", async () => {
  const calls = [], response = { status: "idle", workflow: { id: "selected" } };
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: async (url, init) => {
    calls.push({ url: new URL(String(url)), method: init.method, body: JSON.parse(init.body) });
    return Response.json(response);
  } });
  assert.deepEqual(await client.orchestrateChannelWorkflow("/repo", "selected", { executionProfile: "pi_host_isolated_files_v1" }), response);
  assert.deepEqual(calls.map(call => [call.method, call.url.pathname, call.url.searchParams.get("cwd"), call.body]),
    [["POST", "/workflows/selected/orchestrate", "/repo", { executionProfile: "pi_host_isolated_files_v1" }]]);
});
