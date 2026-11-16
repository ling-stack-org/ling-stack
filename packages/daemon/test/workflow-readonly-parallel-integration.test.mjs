import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, toRuntimeAttemptFence } from "../../core/dist/index.js";
import { stream } from "../../runner-pi/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
import { createDaemonServer } from "../dist/index.js";
import { listAllExecutionActionsForRun } from "../dist/features/runs/execution-actions.js";
import { ToolFreePiRunner } from "./support/tool-free-pi-runner.mjs";

const branches = [
  { participantId: "teammate_builtin_engineer", name: "Engineer", path: "engineer.txt", proof: "ENGINEER_HOST_READ_PROOF" },
  { participantId: "teammate_builtin_qa", name: "QA", path: "qa.txt", proof: "QA_HOST_READ_PROOF" },
];

test("actual workflow orchestration runs two Host-readonly Pi branches with separate five-slot fences and cleanup", { timeout: 45_000 }, async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "ling-workflow-readonly-parallel-")));
  const releases = branches.map(() => deferred());
  const executions = new AsyncLocalStorage();
  const observed = new Map();
  const stores = new Map();
  let daemon;
  t.after(async () => {
    for (const release of releases) release.resolve();
    try { await daemon?.stop(); }
    finally { await rm(cwd, { recursive: true, force: true }); }
  });
  for (const branch of branches) await writeFile(join(cwd, branch.path), `${branch.proof}\n`, "utf8");

  class ParallelReadonlyPiRunner extends ToolFreePiRunner {
    async runTask(options) {
      const store = stores.get(cwd);
      const run = store.getRun(options.runId);
      const branchIndex = branches.findIndex(branch => branch.participantId === run.teammateId);
      assert.ok(branchIndex >= 0, "only the two accepted workflow steps may call this scripted provider");
      assert.ok(run.workflowStepId);
      assert.equal(options.readonlyToolsProfile, "host_readonly_v1");
      assert.deepEqual(options.tools, ["read"]);
      assert.equal(typeof options.onToolBefore, "function");
      assert.equal(typeof options.onReadonlyToolCall, "function");
      assert.deepEqual(options.mcpTools, []);
      assert.deepEqual(options.hostCapabilityTools, []);
      assert.deepEqual(options.mediaGenerationTools, []);
      const execution = { runId: run.id, branchIndex, options, requests: [], gates: [], reads: [], events: [], reached: false };
      assert.equal(observed.has(run.id), false, "each step dispatches exactly one original Pi Run");
      observed.set(run.id, execution);
      return executions.run(execution, () => super.runTask({ ...options,
        onToolBefore: async request => {
          const decision = await options.onToolBefore(request);
          execution.gates.push({ request, decision });
          return decision;
        },
        onReadonlyToolCall: async request => {
          const result = await options.onReadonlyToolCall(request);
          execution.reads.push({ request, result });
          return result;
        },
        onEvent: event => { execution.events.push(event); return options.onEvent?.(event); },
      }));
    }

    registerCustomProviderIfNeeded(runtime, provider) {
      super.registerCustomProviderIfNeeded(runtime, provider);
      runtime.registerProvider(provider.provider, { api: "openai-completions", apiKey: "fixture-no-network",
        streamSimple: (model, context, options) => stream(model, context, { ...options,
          fetch: async (_url, request) => {
            const execution = executions.getStore();
            assert.ok(execution, "the real SDK transport must remain bound to its own Run");
            const branch = branches[execution.branchIndex];
            const body = JSON.parse(request.body);
            execution.requests.push(body);
            const toolNames = (body.tools ?? []).map(tool => tool.function.name);
            assert.ok(toolNames.includes("read"));
            assert.ok(!toolNames.some(name => ["bash", "write", "edit", "request_permissions", "spawn_agent"].includes(name)));
            if (execution.requests.length === 1) {
              return sse({ tool_calls: [{ index: 0, id: `readonly-${execution.branchIndex}`, type: "function",
                function: { name: "read", arguments: JSON.stringify({ path: branch.path }) } }] }, "tool_calls");
            }
            assert.equal(execution.requests.length, 2, "one real Host read precedes terminal transport");
            const result = body.messages.find(message => message.role === "tool");
            assert.ok(result, "the SDK must pass its real Host tool result to the next provider request");
            assert.match(JSON.stringify(result.content), new RegExp(branch.proof));
            assert.equal(execution.reads.length, 1);
            execution.reached = true;
            await releases[execution.branchIndex].promise;
            options.signal?.throwIfAborted();
            return sse({ content: `${branch.name} inspected the owned input.` }, "stop");
          },
        }),
      });
    }
  }

  daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
    harness: { toolBroker: { mode: "enforce" } },
    channels: { autoRoute: false, intentSelector: false, terminalReports: false, teamObserverBus: false },
  }, { runner: new ParallelReadonlyPiRunner(), storeFactory(storeCwd) {
    const store = createSqliteRunStore(storeCwd);
    stores.set(storeCwd, store);
    return store;
  } });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const api = async (path, body, method = "POST") => {
    const response = await fetch(`${base}${path}${path.includes("?") ? "&" : "?"}cwd=${encodeURIComponent(cwd)}`, {
      method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    const value = await response.json();
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  };
  const provider = (await api("/providers", { kind: "glm", displayName: "Local parallel readonly transport",
    providerId: "parallel-readonly-scripted", model: "parallel-readonly-fixture", api: "openai-completions",
    baseUrl: "https://readonly-fixture.invalid/v1", capabilities: ["chat", "tool_call"], input: ["text"],
    authHeader: false, reasoning: false, enabled: true })).provider;
  const store = stores.get(cwd);
  assert.ok(store.database, "the real daemon Store owns a SQLite connection");
  store.recordProviderCheckResult(provider.id, { ok: true, code: "ready", message: "Scripted local SDK transport",
    checkedAt: new Date().toISOString() });
  for (const branch of branches) await api(`/teammates/${branch.participantId}`,
    { providerPresetId: provider.id, allowedTools: ["read"] }, "PATCH");
  const channel = (await api("/channels", { name: "Two verified readonly branches", status: "active", boundPath: cwd,
    defaultProviderPresetId: provider.id, allowedTools: ["read"], autoReplyMode: "mentions_only",
    runtimePolicy: { maxConcurrentRuns: 2, schedulingMode: "smart", writeLockScope: "boundPath",
      allowReadOnlyParallel: true, queueOnConflict: true } })).channel;
  for (const branch of branches) await api(`/teammates/${branch.participantId}/channels`,
    { memberships: [{ channelId: channel.id }] }, "PUT");

  // Seed the accepted graph, not synthetic execution facts or capability callbacks.
  const now = new Date().toISOString();
  const workflow = store.createChannelWorkflow({ channelId: channel.id, title: "Parallel Host reads",
    objective: "Inspect two independent owned files", status: "ready", createdBy: "local-user",
    metadata: { maxParallelSteps: 2 } }, now);
  const steps = branches.map((branch, position) => store.createChannelWorkflowStep({ workflowId: workflow.id,
    title: `${branch.name} readonly inspection`, prompt: `Read ${branch.path}.`, position,
    toParticipantId: branch.participantId, toParticipantLabel: branch.name,
    metadata: { autoStart: true, dependsOnStepIds: [], providerPresetId: provider.id, requiredTools: ["read"],
      sideEffectClass: "analysis_readonly", maxParallelSiblings: 2,
      parallelPolicy: { autoParallel: true, maxParallelSiblings: 2, resourceKeys: [] } } }, now));
  const describe = () => ({ observed: [...observed.values()].map(value => ({ runId: value.runId,
    requests: value.requests.length, reads: value.reads.length, reached: value.reached })),
    steps: steps.map(step => store.getChannelWorkflowStep(step.id)),
    runs: store.listRuns({ limit: 20 }).map(run => ({ id: run.id, status: run.status, error: run.errorMessage })) });
  const started = await api(`/workflows/${workflow.id}/orchestrate`, {});
  assert.equal(started.status, "started", JSON.stringify(started));
  assert.deepEqual(started.startedSteps.map(item => item.workflowStep.id), steps.map(step => step.id));
  await until(() => observed.size === 2 && [...observed.values()].every(value => value.reached),
    "both actual Pi transports at the post-read barrier before either may finish", describe);
  assert.ok(releases.every(release => !release.settled), "neither branch was unblocked to admit the other");

  const expectedKeys = [
    ["provider", provider.id], ["runner", "pi"], ["channel_parallel", channel.id],
    ["channel_parallel", `workflow:${workflow.id}`], ["channel_parallel", `workspace:${cwd}`],
  ].map(key => JSON.stringify(key)).sort();
  const evidence = steps.map((step, index) => {
    const current = store.getChannelWorkflowStep(step.id);
    const run = store.getRun(current.runId);
    const unit = store.getWorkUnit(run.workUnitId);
    const attempt = store.getWorkUnitAttempt(unit.activeAttemptId);
    const execution = observed.get(run.id);
    const slots = store.listRuntimeSemaphoreSlots({ workUnitId: unit.id, status: "active", limit: 100 });
    assert.equal(current.status, "running");
    assert.equal(run.status, "running");
    assert.equal(unit.status, "running");
    assert.equal(attempt.status, "started");
    assert.equal(execution.branchIndex, index);
    assert.equal(unit.effectiveRunnerId, "pi");
    assert.equal(attempt.effectiveRunnerId, "pi");
    assert.equal(run.requestSnapshot.effectivePolicySnapshot.workspaceAccessMode, "read_only");
    assert.deepEqual(run.requestSnapshot.effectivePolicySnapshot.allowedWritePaths, []);
    const plan = run.requestSnapshot.workflowSafetySnapshot.plan;
    assert.deepEqual(plan, current.metadata.safetyPlan);
    assert.equal(plan.profile, "pi_host_readonly_v1");
    assert.equal(plan.runnerId, "pi");
    assert.equal(plan.safety.sideEffectClass, "analysis_readonly");
    assert.equal(plan.safety.parallelPolicy.autoParallel, true);
    assert.equal(plan.networkAccess, false);
    assert.deepEqual(plan.writeRoots, []);
    assert.equal(plan.workspaceRoot, cwd);
    assert.equal(plan.executionRoot, cwd);
    assert.deepEqual(plan.tools, ["read"]);
    const read = execution.reads[0];
    assert.deepEqual(read.request.input, { path: branches[index].path });
    assert.equal(read.request.cwd, cwd);
    assert.notEqual(read.result.isError, true);
    assert.equal(read.result.details.profile, "host_readonly_v1");
    assert.match(read.result.content[0].text, new RegExp(branches[index].proof));
    const gates = execution.gates.filter(gate => gate.request.toolCallId === read.request.toolCallId);
    assert.equal(gates.length, 2, "the real SDK admission and Host producer both invoke the actual Host gate");
    assert.ok(gates.every(gate => gate.decision.allowed === true));
    const actions = listAllExecutionActionsForRun(store, run.id);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].actionType, "read");
    assert.equal(actions[0].status, "succeeded");
    assert.equal(slots.length, 5, "each admitted Attempt must own all five capacity keys");
    assert.deepEqual(slots.map(slot => JSON.stringify([slot.resourceType, slot.resourceKey])).sort(), expectedKeys);
    const fence = toRuntimeAttemptFence(attempt);
    assert.equal(store.isCurrentRunExecutionOwner(run.id, fence), true);
    for (const slot of slots) {
      for (const [key, value] of Object.entries(fence)) assert.equal(slot[key], value, `slot ${key}`);
      assert.equal(slot.ownerType, "work_unit_attempt");
      assert.equal(slot.ownerId, attempt.id);
    }
    return { run, unit, attempt, slots, execution,
      safetySnapshot: structuredClone(run.requestSnapshot.workflowSafetySnapshot) };
  });
  assert.notEqual(evidence[0].unit.id, evidence[1].unit.id);
  assert.notEqual(evidence[0].attempt.id, evidence[1].attempt.id);
  assert.notEqual(evidence[0].execution.options.onToolBefore, evidence[1].execution.options.onToolBefore);
  assert.notEqual(evidence[0].execution.options.onReadonlyToolCall, evidence[1].execution.options.onReadonlyToolCall);
  assert.equal(new Set(evidence.flatMap(value => value.slots.map(slot => slot.id))).size, 10);
  const activeSlots = value => store.listRuntimeSemaphoreSlots({ workUnitId: value.unit.id, status: "active", limit: 100 });
  const assertReleased = value => {
    const slots = store.listRuntimeSemaphoreSlots({ workUnitId: value.unit.id, limit: 100 });
    assert.deepEqual(slots.map(slot => slot.id).sort(), value.slots.map(slot => slot.id).sort());
    assert.ok(slots.every(slot => slot.status === "released" && slot.releasedAt));
    assert.deepEqual(store.getRun(value.run.id).requestSnapshot.workflowSafetySnapshot, value.safetySnapshot);
    assert.equal(store.getWorkUnit(value.unit.id).status, "succeeded");
    assert.equal(store.getWorkUnitAttempt(value.attempt.id).status, "succeeded");
  };

  releases[0].resolve();
  await until(() => store.getChannelWorkflowStep(steps[0].id).status === "succeeded"
    && store.getRun(evidence[0].run.id).status === "succeeded" && activeSlots(evidence[0]).length === 0,
  "first branch terminal cleanup", describe);
  assertReleased(evidence[0]);
  assert.equal(store.getRun(evidence[1].run.id).status, "running");
  assert.equal(store.getChannelWorkflowStep(steps[1].id).status, "running");
  const retained = activeSlots(evidence[1]);
  assert.deepEqual(retained.map(slot => slot.id).sort(), evidence[1].slots.map(slot => slot.id).sort(),
    "first completion cannot release or replace its sibling's slots");
  for (const slot of retained) {
    for (const [key, value] of Object.entries(toRuntimeAttemptFence(evidence[1].attempt))) assert.equal(slot[key], value);
  }
  assert.equal(releases[1].settled, false);

  releases[1].resolve();
  await until(() => steps.every(step => store.getChannelWorkflowStep(step.id).status === "succeeded")
    && evidence.every(value => store.getRun(value.run.id).status === "succeeded" && activeSlots(value).length === 0),
  "both original Pi Runs terminal with all capacity released", describe);
  assertReleased(evidence[1]);
  assert.equal(store.listRuntimeSemaphoreSlots({ status: "active", limit: 100 }).length, 0);
  assert.equal(observed.size, 2, "no replacement Run or model retry may satisfy the parallel barriers");
  for (const step of steps) assert.equal(store.listRuns({ workflowStepId: step.id, limit: 20 }).length, 1);
});

function deferred() {
  let settled = false, resolve;
  const promise = new Promise(done => { resolve = () => { settled = true; done(); }; });
  return { promise, resolve, get settled() { return settled; } };
}

function sse(delta, finishReason) {
  return new Response([
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
  ].map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n",
  { headers: { "content-type": "text/event-stream" } });
}

async function until(predicate, label, describe) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for ${label}: ${JSON.stringify(describe())}`);
}
