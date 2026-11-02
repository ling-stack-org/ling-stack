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
