import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { canRequestWorkflowIsolation } from "../src/lib/workflow-isolated-action.ts";

function eligible() {
  const workflow = { id: "workflow-1", channelId: "channel-1", status: "ready",
    metadata: { workflowGraphFingerprint: `wfg1_${"a".repeat(64)}`, maxParallelSteps: 2 } };
  const steps = [1, 2].map(index => ({ id: `step-${index}`, workflowId: workflow.id, status: "queued",
    metadata: { sideEffectClass: "workspace_write", requestedRunnerId: "pi", maxParallelSiblings: 2,
      parallelPolicy: { autoParallel: true, maxParallelSiblings: 2, resourceKeys: [] } } }));
  return { workflow, steps };
}

test("isolated execution affordance requires a fresh complete writing inventory", () => {
  const { workflow, steps } = eligible();
  assert.equal(canRequestWorkflowIsolation(workflow, steps), true);
  for (const status of ["draft", "running", "blocked", "waiting_for_approval", "succeeded", "failed", "cancelled"])
    assert.equal(canRequestWorkflowIsolation({ ...workflow, status }, steps), false, status);
  assert.equal(canRequestWorkflowIsolation({ ...workflow, metadata: {} }, steps), false);
  assert.equal(canRequestWorkflowIsolation({ ...workflow, metadata: { ...workflow.metadata, maxParallelSteps: 1 } }, steps), false);
  assert.equal(canRequestWorkflowIsolation(workflow, steps.slice(0, 1)), false);
  assert.equal(canRequestWorkflowIsolation(workflow, Array.from({ length: 129 }, (_, index) => ({ ...steps[0], id: `step-${index}` }))), false);
  for (const patch of [{ status: "running" }, { workflowId: "foreign" }, { taskId: "task-1" }, { runId: "run-1" },
    { metadata: undefined }, { metadata: { ...steps[0].metadata, sideEffectClass: "analysis_readonly" } },
    { metadata: { ...steps[0].metadata, sideEffectClass: "external_mutation" } },
    { metadata: { ...steps[0].metadata, sideEffectClass: "release" } },
    { metadata: { ...steps[0].metadata, requestedRunnerId: "codex" } },
    { metadata: { ...steps[0].metadata, preStepApprovalId: "approval-1" } },
    { metadata: { ...steps[0].metadata, postStepApprovalId: "approval-1" } },
    { metadata: { ...steps[0].metadata, autoStart: false } },
    { metadata: { ...steps[0].metadata, maxParallelSiblings: 1 } },
    { metadata: { ...steps[0].metadata, parallelPolicy: { autoParallel: false, maxParallelSiblings: 2 } } },
    { metadata: { ...steps[0].metadata, parallelPolicy: { autoParallel: true, maxParallelSiblings: 1 } } }])
    assert.equal(canRequestWorkflowIsolation(workflow, [{ ...steps[0], ...patch }, steps[1]]), false, JSON.stringify(patch));
});

const source = readFileSync(new URL("../src/app/use-channel-workflow-controller.ts", import.meta.url), "utf8");
const start = source.indexOf("  async function orchestrateWorkflowById("), end = source.indexOf("\n  async function startAutoplanWorkflow", start);
assert.ok(start >= 0 && end > start);
const controllerCode = stripTypeScriptTypes(`(${source.slice(start, end).trim()})`, { mode: "transform" });

test("ordinary advancement never opts into isolation; explicit selection forwards only its fixed profile", async () => {
  const { workflow } = eligible();
  const calls = [], errors = [], events = [];
  const run = vm.runInNewContext(controllerCode, { Error, input: {
    form: { cwd: " /owned-workspace " }, selectedChannelId: workflow.channelId,
    setOrchestratingWorkflowId() {}, clearWorkflowError() {},
    async orchestrateChannelWorkflow(...args) { calls.push(args); return { status: "started", workflow }; },
    setChannelWorkflows(update) { assert.equal(update([])[0], workflow); },
    emitDomainEvent: async event => { events.push(event); },
    reportWorkflowError: (...args) => { errors.push(args); },
  } });
  await run(workflow.id, workflow.channelId);
  const request = { executionProfile: "pi_host_isolated_files_v1" };
  await run(workflow.id, workflow.channelId, request);
  assert.deepEqual(calls, [["/owned-workspace", workflow.id, undefined], ["/owned-workspace", workflow.id, request]]);
  assert.equal(events.length, 2);
  assert.deepEqual(errors, []);
});
