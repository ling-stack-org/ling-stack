import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteRunStore } from "@ling-stack/core";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import { executeRunRequest, createDetachedRunExecutionSink } from "../dist/features/runs/orchestrator.js";
import { parseRunRequest } from "../dist/features/runs/schemas.js";
import { createMemorySourceRevisions } from "../dist/features/memory/prompt.js";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { resolveConfig } from "../dist/config.js";

async function fixture(t, surface = "normal") {
  const cwd = await mkdtemp(join(tmpdir(), "ling-source-input-"));
  const registry = new RunStoreRegistry(createSqliteRunStore);
  const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd }));
  const active = new ActiveRunRegistry(), store = registry.getStore(cwd);
  const f = { cwd, registry, supervisor, active, store, calls: [], prepared: [], errors: [], controls: {} };
  t.after(async () => { supervisor.releaseAll(); registry.closeAll(); await rm(cwd, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  f.preset = store.createProviderPreset({ kind: "openai-compatible", displayName: "Source input fixture", providerId: "source-input-fixture", model: "fixture",
    api: "openai-completions", baseUrl: "https://fixture.invalid/v1", authHeader: false, reasoning: false, capabilities: ["chat", "tool_call"], enabled: true }, now);
  store.recordProviderCheckResult(f.preset.id, { ok: true, code: "ready", message: "Synthetic ready", checkedAt: now });
  const channel = surface === "channel" ? store.createChannel({ name: "Source fixture", boundPath: cwd, defaultProviderPresetId: f.preset.id }, now) : undefined;
  const teammateId = surface === "private" ? "teammate_builtin_engineer" : "ling_agent";
  f.thread = store.createLingThread({ kind: surface === "normal" ? "conversation" : surface === "private" ? "teammate_direct" : "channel_discussion",
    channelId: channel?.id, teammateId, title: "Source input", objective: "SOURCE_TASK" }, now);
  f.request = { cwd, workspaceCwd: cwd, threadId: f.thread.id, task: { id: "source-task", title: "SOURCE_TASK", prompt: "SOURCE_TASK: preserve the existing files.", channelId: channel?.id },
    teammateId, tools: ["read"], providerPresetId: f.preset.id, agentDir: join(cwd, "agent"),
    systemPrompt: "Frozen source system.", appendSystemPrompt: ["ORIGINAL_APPEND"], createdByActor: "local-user" };
  store.updateWorkspaceSettings({ defaultReasoningSummary: "detailed" }, now);
  class FixtureRunner extends PiRunnerAdapter {
    async prepareTaskInput(options) {
      const result = await super.prepareTaskInput(options);
      f.prepared.push(result);
      await f.controls.afterPrepare?.();
      return result;
    }
    async runTask(options) {
      const actual = await super.prepareTaskInput(options);
      assert.equal(actual.fingerprint, options.preparedInput?.fingerprint, "actual dispatch must use the captured input");
      const saved = store.getRun(options.runId).requestSnapshot.runnerExecutionInput;
      assert.ok(saved, "source evidence must be durable before Runner dispatch");
      assert.deepEqual(saved.preparedInput, options.preparedInput);
      f.calls.push(options);
      await f.controls.onRun?.(options);
      return { taskId: options.task.id, events: [], messages: [{ role: "assistant", content: "Fixture completed" }] };
    }
  }
  f.adapter = new FixtureRunner();
  f.runners = createRunnerRegistry([{ id: "pi", displayName: "Fixture", status: "enabled", adapter: f.adapter }]);
  f.dispatch = () => executeRunRequest(f.request, { ...createDetachedRunExecutionSink(), writeError: (_status, body) => f.errors.push(body) },
    f.runners, registry, active, supervisor, { resolve: () => ({ configured: false }) }, {});
  return f;
}
for (const change of ["unchanged", "before-entry", "during-prepare", "missing-revision", "usage-only"]) {
  test(`preselected Pi Memory preserves source revision across ${change}`, async t => {
    const f = await fixture(t, "channel");
    const memory = f.store.createMemoryObject({ scopeType: "teammate", ownerId: f.request.teammateId,
      title: "SOURCE_TASK", body: "PRESELECTED_PRIVATE_CANARY", sensitivity: "private", reviewState: "active" }, new Date().toISOString());
    f.request = { ...f.request, skipMemoryRecall: true, preselectedMemoryUse: {
      memoryIds: [memory.id], recallQuery: "SOURCE_TASK", policyVersion: "test-private-selection",
      renderedPrompt: `Used memory:\n${memory.body}`,
      ...(change !== "missing-revision" ? { sourceRevisions: createMemorySourceRevisions([memory]) } : {}),
    } };
    const mutate = () => f.store.updateMemoryObject(memory.id, { body: "Changed after selection." }, new Date().toISOString());
    if (change === "before-entry") mutate();
    if (change === "during-prepare") f.controls.afterPrepare = mutate;
    if (change === "usage-only") f.controls.afterPrepare = () => f.store.recordUsedMemoryEvent({ memoryIds: [memory.id],
      teammateId: f.request.teammateId, intent: "task-run", recallQuery: "SOURCE_TASK", policyVersion: "another-consumer" }, new Date().toISOString());
    const runId = await f.dispatch();
    if (["before-entry", "during-prepare", "missing-revision"].includes(change)) {
      assert.equal(runId, undefined);
      assert.equal(f.calls.length, 0, "stale or unbound private text must never reach the Runner");
      assert.equal(f.store.listRuns().length, 0);
      assert.equal(f.errors.at(-1)?.error, "prepared_memory_unavailable");
      return;
    }
    assert.ok(runId, JSON.stringify(f.errors));
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].appendSystemPrompt.filter(text => text.includes(memory.body)).length, 1);
    const run = f.store.getRun(runId);
    assert.doesNotMatch(run.taskSnapshot.prompt, /PRESELECTED_PRIVATE_CANARY/u);
    assert.doesNotMatch(f.store.getLingTurnForRun(runId).userInstruction, /PRESELECTED_PRIVATE_CANARY/u);
    assert.deepEqual(run.requestSnapshot.runnerExecutionInput.usedMemory, {
      memoryIds: [memory.id], recallQuery: "SOURCE_TASK", policyVersion: "test-private-selection",
    });
    assert.equal(run.requestSnapshot.preselectedMemoryUse, undefined);
    const used = f.store.listUsedMemoryEvents({ runId });
    assert.equal(used.length, 1);
    assert.deepEqual(used[0].memoryIds, [memory.id]);
    assert.doesNotMatch(JSON.stringify(used), /PRESELECTED_PRIVATE_CANARY|sourceRevisions|renderedPrompt/u);
  });
}

for (const surface of ["normal", "private", "channel"]) {
  test(`actual ${surface} Pi dispatch persists the full non-secret source input`, async t => {
    const f = await fixture(t, surface);
    f.store.createMemoryObject({ id: "source-memory", scopeType: "workspace", ownerId: "workspace_default", title: "SOURCE_TASK", body: "FROZEN_SOURCE_MEMORY" }, new Date().toISOString());
    const runId = await f.dispatch();
    assert.ok(runId, JSON.stringify(f.errors));
    assert.equal(f.calls.length, 1); assert.equal(f.prepared.length, 1);
    const run = f.store.getRun(runId), source = run.requestSnapshot.runnerExecutionInput;
    assert.equal(source.input.cwd, f.cwd); assert.equal(source.input.task.id, f.request.task.id);
    assert.deepEqual(source.input.tools, ["read"]);
    assert.equal(f.calls[0].reasoningSummary, "detailed");
    assert.equal(run.requestSnapshot.reasoningSummary, "detailed");
    assert.equal(source.input.reasoningSummary, "detailed");
    assert.match(source.preparedInput.systemPrompt, /Frozen source system/);
    assert.match(source.preparedInput.systemPrompt, /ORIGINAL_APPEND/);
    assert.match(source.preparedInput.systemPrompt, /FROZEN_SOURCE_MEMORY/);
    const stylePrompts = f.calls[0].appendSystemPrompt.filter((prompt) => prompt.startsWith("Ling conversation response style v1:"));
    assert.equal(stylePrompts.length, 1, "every conversation surface receives the same response style exactly once");
    assert.match(source.preparedInput.systemPrompt, /Prefer natural paragraphs for short answers/);
    assert.deepEqual(source.input.appendSystemPrompt, f.calls[0].appendSystemPrompt, "style is part of the frozen SDK input");
    assert.equal(run.requestSnapshot.runnerExecutionInput.input.appendSystemPrompt.filter((prompt) => prompt.startsWith("Ling conversation response style v1:")).length, 1, "style remains traceable in the actual execution input, not a rewritten original request");
    assert.deepEqual(source.usedMemory.memoryIds, ["source-memory"]);
    assert.equal(source.input.provider.apiKey, undefined); assert.equal(source.input.provider.headers, undefined);
    for (const key of ["onEvent", "onToolBefore", "onApprovalRequired", "onPreparedInputAccepted", "signal", "sandbox", "runId", "runnerAttemptId"])
      assert.equal(source.input[key], undefined, key);
    const reopened = createSqliteRunStore(f.cwd);
    try { assert.deepEqual(reopened.getRun(runId).requestSnapshot.runnerExecutionInput, source); }
    finally { reopened.close(); }
  });
}
for (const change of ["memory", "provider", "endpoint", "shutdown"]) {
  test(`source preparation rechecks ${change} after awaiting SDK input`, async t => {
    const f = await fixture(t, "channel");
    if (change === "memory") f.store.createMemoryObject({ id: "revoked", scopeType: "workspace", ownerId: "workspace_default", title: "SOURCE_TASK", body: "REVOKED_SOURCE_MEMORY" }, new Date().toISOString());
    f.controls.afterPrepare = () => {
      if (change === "memory") f.store.updateMemoryObject("revoked", { enabled: false }, new Date().toISOString());
      if (change === "provider" || change === "endpoint") f.store.updateProviderPreset(f.preset.id, { baseUrl: "https://changed.invalid/v1" }, new Date().toISOString());
      if (change === "endpoint") f.store.recordProviderCheckResult(f.preset.id, { ok: true, code: "ready", message: "New endpoint fixture ready", checkedAt: new Date().toISOString() });
      if (change === "shutdown") f.active.suspendAll("daemon_restart");
    };
    assert.equal(await f.dispatch(), undefined);
    assert.equal(f.calls.length, 0); assert.equal(f.store.listRuns().length, 0);
    assert.equal(f.errors.at(-1)?.error, change === "memory" ? "prepared_memory_unavailable" : change === "provider" ? "provider_preflight_failed"
      : change === "endpoint" ? "prepared_provider_configuration_changed" : "runtime_shutting_down");
  });
}
test("universal source preparation uses current Host policy, not the old SDK timing", async t => {
  const f = await fixture(t, "private");
  f.controls.afterPrepare = () => f.store.updateApprovalPolicy({ toolDecisions: { read: "deny" } }, new Date().toISOString());
  let decision;
  f.controls.onRun = async options => { decision = await options.onApprovalRequired({ toolCallId: "read", toolName: "read", input: { path: "never-read.txt" },
    task: options.task, cwd: f.cwd, defaultApproval: "allow" }); };
  assert.ok(await f.dispatch(), JSON.stringify(f.errors));
  assert.equal(decision?.approved, false);
});
test("external parsing cannot supply a forged source execution snapshot", async t => {
  const f = await fixture(t);
  assert.equal(parseRunRequest({ ...f.request, runnerExecutionInput: { fabricated: true } }).runnerExecutionInput, undefined);
});
test("an unverified adapter cannot inherit fabricated source input", async t => {
  const f = await fixture(t);
  f.request.runnerExecutionInput = { fabricated: true };
  f.runners = createRunnerRegistry([{ id: "pi", displayName: "Default fixture", status: "enabled", adapter: f.adapter },
    { id: "codex", displayName: "External fixture", status: "enabled", adapter: {
    runTask: async options => ({ taskId: options.task.id, events: [], messages: [{ role: "assistant", content: "Other adapter fixture" }] }),
  } }]);
  f.request.runnerId = "codex";
  const runId = await f.dispatch();
  assert.ok(runId, JSON.stringify(f.errors));
  assert.equal(f.store.getRun(runId).requestSnapshot.runnerExecutionInput, undefined);
});
