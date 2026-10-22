import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteRunStore, resolveStoragePaths } from "@ling-stack/core";
import { DELEGATION_TOOL_NAMES } from "@ling-stack/runner-pi";
import { resolveConfig } from "../dist/config.js";
import { createDelegatedRunDispatchAuthority } from "../dist/features/harness/delegations/delegated-run-dispatch.js";
import { createDelegationRuntimeRegistry, createDelegationWorkflowSelector } from "../dist/features/harness/delegations/runtime-registry.js";
import { createOriginalDelegationStoreComposition } from "../dist/features/harness/delegations/store-composition.js";
import { createDetachedRunExecutionSink, executeDelegatedRunRequest, executeRunRequest } from "../dist/features/runs/orchestrator.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { patchWorkspaceRuntimeSettings } from "../dist/runtime/runner-settings.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { ToolFreePiRunner } from "./support/tool-free-pi-runner.mjs";

async function fixture(t, selected, behavior = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-delegation-production-surface-"));
  const observed = { calls: [], errors: [], delegated: [], toolResults: [] };
  class FixtureRunner extends ToolFreePiRunner {
    async runTask(options) {
      observed.calls.push(options);
      const spawn = behavior.spawns?.[options.task.prompt];
      const invokeSpawn = async () => {
        if (!spawn || !options.onDelegationToolCall) return;
        const request = { toolName: "spawn_agent", toolCallId: spawn.toolCallId,
          input: { objective: spawn.objective, required: true,
            requestedBudget: { tokenBudget: spawn.tokenBudget ?? 50_000 } } };
        observed.toolResults.push(await options.onDelegationToolCall(request));
        if (spawn.replay) observed.toolResults.push(await options.onDelegationToolCall(request));
      };
      if (options.onPreparedInputAccepted && spawn) {
        const accept = options.onPreparedInputAccepted;
        options = { ...options, async onPreparedInputAccepted(receipt, signal) {
          await accept(receipt, signal);
          await invokeSpawn();
        } };
      } else {
        await invokeSpawn();
      }
      return super.runTask(options);
    }
  }
  const adapter = new FixtureRunner();
  adapter.fixtureUsage = { inputTokens: 10, outputTokens: 10 };
  const runners = createRunnerRegistry([{ id: "pi", displayName: "Delegation surface fixture", status: "enabled", adapter }]);
  const config = resolveConfig({ defaultWorkspaceCwd: cwd, harness: {
    continuations: { mode: "enforce" }, toolBroker: { mode: "enforce" },
    delegations: { mode: "enforce", rootBudget: { tokenBudget: 100_000, wallTimeBudgetMs: 120_000 } },
  } });
  const supervisor = new RuntimeSupervisor(config), active = new ActiveRunRegistry();
  const keyRef = "env:DELEGATION_PRODUCTION_SURFACE_KEY";
  const resolver = { status: ref => ({ ref, kind: "env", configured: ref === keyRef }),
    resolve: ref => ({ ref, configured: ref === keyRef, value: ref === keyRef ? "synthetic-no-network-key" : undefined,
      status: { ref, kind: "env", configured: ref === keyRef } }) };
  const composition = createOriginalDelegationStoreComposition({ supervisor, runnerRegistry: runners, secretResolver: resolver,
    delegatedDispatchAuthority: createDelegatedRunDispatchAuthority() });
  const paths = resolveStoragePaths(cwd, { homeDir: join(cwd, "fixture-home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  const store = new SqliteRunStore({ cwd, paths, delegationHostBinding: composition.binding });
  composition.bindExactStore(store);
  const stores = new RunStoreRegistry(() => store, { recoverOnOpen: false });
  assert.equal(stores.getStore(cwd), store);
  const now = new Date().toISOString();
  patchWorkspaceRuntimeSettings(store, runners, { defaultRunnerId: "pi", allowedRunnerIds: ["pi"] }, now);
  const preset = store.createProviderPreset({ kind: "openai-compatible", displayName: "Delegation surface fixture",
    providerId: "delegation-surface-fixture", model: "fixture-model", api: "openai-completions",
    baseUrl: "https://fixture.invalid/v1", apiKeyRef: keyRef, reasoning: false, contextWindow: 16_000,
    maxTokens: 1_000, capabilities: ["chat", "tool_call"], enabled: true }, now);
  store.recordProviderCheckResult(preset.id, { ok: true, code: "ready", message: "Synthetic ready", checkedAt: now });
  const channel = store.createChannel({ name: "Delegation surface", boundPath: cwd, allowedTools: ["read"] }, now);
  store.replaceTeammateChannelMemberships("teammate_builtin_engineer", [{ channelId: channel.id }], now);
  const prompt = "Inspect the selected workflow.";
  const workflow = store.createChannelWorkflow({ channelId: channel.id, title: "Selected workflow", objective: prompt,
    createdBy: "local-user", status: "ready" }, now);
  const createdStep = store.createChannelWorkflowStep({ workflowId: workflow.id, title: "Parent", prompt,
    toParticipantId: "teammate_builtin_engineer", toParticipantLabel: "Engineer" }, now);
  const lease = store.acquireResourceLease({ workspaceId: channel.workspaceId, resourceType: "workflow_step",
    resourceKey: createdStep.id, ownerType: "workflow_step", ownerId: createdStep.id, acquiredAt: now,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  assert.ok(lease);
  const begun = store.beginChannelWorkflowStepStart({ workflowStepId: createdStep.id,
    expected: store.getChannelWorkflowStep(createdStep.id), leaseId: lease.id,
    task: { channelId: channel.id, assigneeTeammateId: "teammate_builtin_engineer", title: "Parent task", prompt }, now });
  assert.equal(begun.status, "begun", JSON.stringify(begun));
  const task = begun.task, step = store.getChannelWorkflowStep(createdStep.id);
  const thread = store.createLingThread({ kind: "task", channelId: channel.id, taskId: task.id,
    title: task.title, objective: task.prompt }, now);
  const turn = store.createLingTurn({ threadId: thread.id, kind: "initial_request", taskId: task.id,
    channelId: channel.id, title: task.title, userInstruction: task.prompt, createdByActor: "local-user" }, now);
  const runtime = createDelegationRuntimeRegistry({ supervisor, activeRuns: active,
    isWorkflowSelected: createDelegationWorkflowSelector(selected ? [workflow.id] : []),
    executeDelegatedRunRequest: async input => {
      observed.delegated.push(input);
      return behavior.dispatchChildren
        ? executeDelegatedRunRequest(input, { ...createDetachedRunExecutionSink(),
            writeError: (status, body) => observed.errors.push({ status, body, delegated: true }) },
          runners, stores, active, supervisor, resolver, {})
        : input.request.parentRunId;
    } });
  runtime.registerStore(store, composition.lifecycle);
  const request = { cwd, workspaceCwd: cwd, threadId: thread.id, turnId: turn.id, workflowStepId: step.id,
    workflowStartOwner: begun.owner,
    teammateId: "teammate_builtin_engineer",
    task: { id: task.id, channelId: channel.id, title: task.title, prompt: task.prompt }, providerPresetId: preset.id,
    runnerId: "pi", tools: ["read"], authorizationMode: "smart", workspaceAccessMode: "workspace_write",
    createdByActor: "local-user" };
  const dispatch = () => executeRunRequest(request, { ...createDetachedRunExecutionSink(),
    writeError: (_status, body) => observed.errors.push(body) }, runners, stores, active, supervisor, resolver, {});
  t.after(async () => {
    runtime.stopAdmission(); runtime.abortOwned(); await runtime.settle().catch(() => undefined);
    supervisor.releaseAll(); stores.closeAll(); await rm(cwd, { recursive: true, force: true });
  });
  return { dispatch, observed, store, channel, workflow, step, runtime };
}

for (const selected of [false, true]) test(`production orchestrator ${selected ? "exposes" : "withholds"} delegation only for a Host-selected workflow`, async t => {
  const f = await fixture(t, selected);
  const runId = await f.dispatch();
  assert.ok(runId, JSON.stringify({ errors: f.observed.errors, runs: f.store.listRuns().map(run => ({ id: run.id,
    channelId: run.channelId, workflowStepId: run.workflowStepId, workUnitId: run.workUnitId })),
  units: f.store.listWorkUnits({ limit: 10 }).map(unit => ({ id: unit.id, workspaceId: unit.workspaceId, linkedRunId: unit.linkedRunId })),
  channel: { id: f.channel.id, workspaceId: f.channel.workspaceId },
  workflow: { id: f.workflow.id, channelId: f.workflow.channelId, workspaceId: f.workflow.workspaceId },
  step: { id: f.step.id, channelId: f.step.channelId, workspaceId: f.step.workspaceId } }));
  assert.deepEqual(f.observed.errors, []);
  assert.equal(f.observed.calls.length, 1);
  const options = f.observed.calls[0];
  assert.equal(options.initialToolSurface.delegation, selected);
  assert.equal(typeof options.onDelegationToolCall === "function", selected);
  const names = options.preparedInput.tools.filter(tool => DELEGATION_TOOL_NAMES.includes(tool.name)).map(tool => tool.name);
  assert.deepEqual(names, selected ? DELEGATION_TOOL_NAMES : []);
  assert.equal(f.store.getRun(runId).requestSnapshot.runnerExecutionInput.input.initialToolSurface.delegation, selected);
  assert.equal(f.observed.delegated.length, 0);
});

test("production orchestrator spawn dispatches exactly once and response-loss replay reuses the child", async t => {
  const parentPrompt = "Inspect the selected workflow.", childObjective = "Inspect the delegated child.";
  const f = await fixture(t, true, { dispatchChildren: true,
    spawns: { [parentPrompt]: { toolCallId: "production-spawn", objective: childObjective, replay: true } } });
  const pending = f.dispatch();
  const parentRunId = await Promise.race([pending, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(JSON.stringify({ errors: f.observed.errors,
      calls: f.observed.calls.map(call => ({ task: call.task, runId: call.runId, attemptId: call.runnerAttemptId })),
      delegated: f.observed.delegated.map(call => call.request.task), toolResults: f.observed.toolResults,
      runs: f.store.listRuns().map(run => ({ id: run.id, parentRunId: run.parentRunId,
        status: run.status, errorMessage: run.errorMessage, summaryPath: run.summaryPath })),
      steps: f.store.database.prepare("SELECT id,state,child_run_id,revision,failure_code FROM delegation_steps").all(),
      attempts: f.store.database.prepare("SELECT id,work_unit_id,status,ended_at FROM work_unit_attempts").all(),
    }))), 5_000);
    timer.unref();
  })]);
  assert.ok(parentRunId, JSON.stringify(f.observed.errors));
  await f.runtime.settle();
  assert.deepEqual(f.observed.errors, []);
  assert.equal(f.observed.delegated.length, 1);
  assert.equal(f.observed.delegated[0].request.parentRunId, parentRunId);
  assert.equal(f.observed.delegated[0].request.task.prompt, childObjective);
  assert.equal(f.observed.toolResults.length, 2);
  assert.equal(f.observed.toolResults[0].childRunId, f.observed.toolResults[1].childRunId);
  assert.equal(f.observed.toolResults[0].reservationId, f.observed.toolResults[1].reservationId);
  const child = f.store.getRun(f.observed.toolResults[0].childRunId);
  const unit = f.store.getWorkUnit(child.workUnitId);
  assert.equal(unit.attemptCount, 1);
  assert.equal(f.observed.calls.length, 2, "only the parent and one child Runner execution may enter");
});

test("a production delegated child may spawn one nested child with the same root and narrowed lineage", async t => {
  const parentPrompt = "Inspect the selected workflow.", childObjective = "Inspect the delegated child.";
  const grandchildObjective = "Inspect the nested delegated child.";
  const f = await fixture(t, true, { dispatchChildren: true, spawns: {
    [parentPrompt]: { toolCallId: "production-child", objective: childObjective, tokenBudget: 50_000 },
    [childObjective]: { toolCallId: "production-grandchild", objective: grandchildObjective, tokenBudget: 20_000 },
  } });
  const pending = f.dispatch();
  const parentRunId = await Promise.race([pending, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(JSON.stringify({ errors: f.observed.errors,
      calls: f.observed.calls.map(call => ({ task: call.task, runId: call.runId, attemptId: call.runnerAttemptId })),
      delegated: f.observed.delegated.map(call => call.request.task), toolResults: f.observed.toolResults,
      runs: f.store.listRuns().map(run => ({ id: run.id, parentRunId: run.parentRunId,
        status: run.status, errorMessage: run.errorMessage, summaryPath: run.summaryPath })),
      steps: f.store.database.prepare("SELECT id,root_run_id,parent_run_id,parent_delegation_step_id,state,child_run_id,revision,failure_code,depth FROM delegation_steps ORDER BY depth").all(),
      attempts: f.store.database.prepare("SELECT id,work_unit_id,status,ended_at FROM work_unit_attempts").all(),
    }))), 5_000);
    timer.unref();
  })]);
  assert.ok(parentRunId, JSON.stringify(f.observed.errors));
  await f.runtime.settle();
  assert.deepEqual(f.observed.errors, []);
  assert.equal(f.observed.delegated.length, 2);
  assert.equal(f.observed.calls.length, 3, "parent, child and grandchild each execute exactly once");
  const steps = f.store.database.prepare(`SELECT root_run_id,parent_run_id,parent_delegation_step_id,child_run_id,depth,
    permission_snapshot_artifact_id,tool_allowlist_artifact_id FROM delegation_steps ORDER BY depth`).all();
  assert.equal(steps.length, 2);
  assert.equal(steps[0].root_run_id, parentRunId);
  assert.equal(steps[0].parent_run_id, parentRunId);
  assert.equal(steps[0].depth, 1);
  assert.equal(steps[1].root_run_id, parentRunId);
  assert.equal(steps[1].parent_run_id, steps[0].child_run_id);
  assert.equal(steps[1].parent_delegation_step_id !== null, true);
  assert.equal(steps[1].depth, 2);
  assert.notEqual(steps[1].permission_snapshot_artifact_id, steps[0].permission_snapshot_artifact_id);
  assert.notEqual(steps[1].tool_allowlist_artifact_id, steps[0].tool_allowlist_artifact_id);
});
