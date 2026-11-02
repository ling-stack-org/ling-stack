import assert from "node:assert/strict";
import test from "node:test";
import { LingDaemonClient } from "../dist/index.js";

const safety = { sideEffectClass: "analysis_readonly", parallelPolicy: { autoParallel: true,
  maxParallelSiblings: 2, resourceKeys: ["port:2", "port:1"], requiresArtifactOnly: true, cancelSiblingsOnFailure: false } };

test("workflow client preserves direct safety fields in custom/graph requests and metadata responses", async () => {
  const calls = [];
  const response = { workflow: { id: "workflow-1" }, workflowSteps: [{ id: "step-1", metadata: safety }] };
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: async (input, init) => {
    calls.push({ url: new URL(String(input)), method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return Response.json(response);
  } });
  const step = { id: "review", name: "Review", prompt: "Read evidence", ...safety };
  const custom = { customTemplate: { schemaVersion: 1, id: "custom-safety", name: "Safety", steps: [step] },
    objective: "Review evidence", createdBy: "local-user" };
  const graph = { workflowGraph: { schemaVersion: 1, id: "graph-safety", name: "Safety", entryNodeId: step.id,
    nodes: [{ ...step, kind: "step" }], edges: [],
    termination: { success: "all_required_succeeded", onFailedRequiredNode: "fail_workflow", onApprovalDenied: "block_for_user" } },
    objective: "Review evidence", createdBy: "local-user" };
  assert.deepEqual(await client.createChannelWorkflowFromTemplate("/repo", "channel / safety", custom), response);
  assert.deepEqual(await client.createChannelWorkflowFromTemplate("/repo", "channel / safety", graph), response);
  assert.deepEqual(await client.listChannelWorkflowSteps("/repo", "workflow / safety"), response);
  assert.deepEqual(calls.map((call) => [call.method, call.url.pathname]), [
    ["POST", "/channels/channel%20%2F%20safety/workflows"],
    ["POST", "/channels/channel%20%2F%20safety/workflows"],
    ["GET", "/workflows/workflow%20%2F%20safety/steps"],
  ]);
  assert.deepEqual(calls[0].body, custom);
  assert.deepEqual(calls[1].body, graph);
  assert.ok(calls.every((call) => call.url.searchParams.get("cwd") === "/repo"));
  assert.equal(Object.hasOwn(calls[0].body.customTemplate.steps[0], "executionSafety"), false);
});
